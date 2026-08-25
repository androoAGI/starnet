// StarNet — native desktop shell (Tauri v2).
//
// Wraps the existing browser app: spawns the zero-dependency Node sidecar on a
// private loopback port, waits for it to listen, then opens that URL in a native
// WebView2 window. The sidecar's lifetime is bound to this process.
//
// Secrets (roadmap 2.1): BYOK API keys live in the OS keychain (never in
// localStorage). The Rust side stores/reads them via the `keyring` crate. Keys are
// injected into the sidecar's env at spawn AND can be updated live by POSTing provider
// config to the sidecar's token-guarded /api/key endpoint — so changing a key never
// restarts the sidecar (which would kill the page the user is on).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod credentials;
mod fresh_start;
mod lifecycle_preferences;

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    ipc::Channel, AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_updater::{Update, UpdaterExt};

use credentials::{
    channel_keychain_entry, credits_keychain_entry, delete_credential_honest, is_known_channel,
    keychain_entry, keychain_entry_for, keychain_pool_entry_for,
    migrate_channel_tokens_from_plaintext, migrate_credits_token_from_plaintext,
    normalize_provider, read_channel_token, read_credits_token, read_key, read_key_for,
    read_key_pool_for, read_telegram_bot_tokens, restore_credential, rollback_error,
    KEYCHAIN_PROVIDERS, SIDECAR_CHANNEL_TOKEN_ENVS, SIDECAR_PROVIDER_KEY_ENVS,
};
use lifecycle_preferences::{
    load as load_lifecycle_preferences, save_verified as save_lifecycle_preferences,
    LifecyclePreferences,
};

/// Shared runtime state: the fixed sidecar port, the per-launch IPC token (shared
/// only with the sidecar), the project root, and the live child.
struct AppState {
    port: u16,
    ipc_token: String,
    api_token: String,
    root: PathBuf,
    workspaces: PathBuf,
    startup_log: Option<PathBuf>,
    sidecar: Mutex<Option<Child>>,
    keep_awake: Mutex<KeepAwakeState>,
    lifecycle_preferences_path: PathBuf,
    lifecycle_preferences: Mutex<LifecyclePreferences>,
    close_exit_pending: AtomicBool,
    // Pauses the crash guardian while an explicit restart/reset owns the child lifecycle.
    recovery_in_progress: AtomicBool,
    // Flipped true the instant the app starts exiting, so the guardian thread stops
    // respawning the sidecar during an intentional quit.
    shutting_down: AtomicBool,
}

/// Serializes user-driven recovery commands and keeps the guardian paused until every return path
/// (including errors) has finished. Tauri commands may run concurrently, so a plain load/store can
/// let Restart and Start Fresh kill/spawn/move the same station at the same time.
struct RecoveryOperation<'a> {
    flag: &'a AtomicBool,
}

impl Drop for RecoveryOperation<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

fn begin_recovery(state: &AppState) -> Result<RecoveryOperation<'_>, String> {
    state
        .recovery_in_progress
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "another station recovery is already running".to_string())?;
    Ok(RecoveryOperation {
        flag: &state.recovery_in_progress,
    })
}

#[cfg(unix)]
fn terminate_sidecar_child(child: &mut Child) {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }

    const SIGTERM: i32 = 15;
    let _ = unsafe { kill(child.id() as i32, SIGTERM) };
    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(unix))]
fn terminate_sidecar_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

impl AppState {
    /// Kill the child sidecar on intentional shutdown. HONESTY NOTE: this only covers the
    /// graceful paths — the ExitRequested run-event and `Drop for AppState`. A hard kill of
    /// the shell (`taskkill /F`, crash, task-manager End Task, power loss) runs NEITHER, and
    /// there is no in-process hook that can — which is exactly how orphan sidecars happen.
    /// The reliable other half is `reap_orphan_sidecars`, which runs at the NEXT boot before
    /// spawning and terminates any process still running from our own bundled node runtime.
    fn kill_sidecar(&self) {
        if let Ok(mut guard) = self.sidecar.lock() {
            if let Some(mut child) = guard.take() {
                terminate_sidecar_child(&mut child);
            }
        }
    }
}

struct PendingUpdate(Mutex<Option<Update>>);

/// Lane 4D: the parsed result of a GET /api/lifecycle/armed poll — the sidecar's truthful account of whether
/// any background work (armed routines, connected channels, an armed night-shift) requires the process to keep
/// running after the window closes. `reasons` are short human strings the tray shows verbatim.
struct LifecycleArmed {
    armed: bool,
    reasons: Vec<String>,
}

/// Handles to the mutable tray menu items so the background poll thread can keep the tray honest (the status
/// line + tooltip must reflect REAL armed state, never a stale or optimistic claim).
struct TrayHandles {
    status: tauri::menu::MenuItem<tauri::Wry>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutostartStatus {
    desktop: bool,
    enabled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct KeepAwakeStatus {
    desktop: bool,
    supported: bool,
    enabled: bool,
    message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderKeyStatus {
    provider: String,
    configured: bool,
    alternate_count: usize,
}

#[cfg(windows)]
struct KeepAwakeHandle {
    handle: windows_sys::Win32::Foundation::HANDLE,
    _reason: Vec<u16>,
}

#[cfg(windows)]
unsafe impl Send for KeepAwakeHandle {}

#[cfg(windows)]
impl KeepAwakeHandle {
    fn create() -> Result<Self, String> {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Power::{
            PowerCreateRequest, PowerRequestSystemRequired, PowerSetRequest,
        };
        use windows_sys::Win32::System::Threading::{
            POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
        };

        let mut reason: Vec<u16> =
            "StarNet scheduled tasks are allowed to run while the app is open"
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
        let context = REASON_CONTEXT {
            Version: 0,
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            Reason: REASON_CONTEXT_0 {
                SimpleReasonString: reason.as_mut_ptr(),
            },
        };
        let handle = unsafe { PowerCreateRequest(&context) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            let code = unsafe { GetLastError() };
            return Err(format!(
                "PowerCreateRequest failed with Windows error {code}"
            ));
        }
        if unsafe { PowerSetRequest(handle, PowerRequestSystemRequired) } == 0 {
            let code = unsafe { GetLastError() };
            unsafe {
                CloseHandle(handle);
            }
            return Err(format!("PowerSetRequest failed with Windows error {code}"));
        }
        Ok(Self {
            handle,
            _reason: reason,
        })
    }
}

#[cfg(windows)]
impl Drop for KeepAwakeHandle {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Power::{PowerClearRequest, PowerRequestSystemRequired};

        unsafe {
            let _ = PowerClearRequest(self.handle, PowerRequestSystemRequired);
            let _ = CloseHandle(self.handle);
        }
    }
}

#[cfg(windows)]
struct KeepAwakeState {
    request: Option<KeepAwakeHandle>,
}

#[cfg(windows)]
impl KeepAwakeState {
    fn new() -> Self {
        Self { request: None }
    }

    fn status(&self) -> KeepAwakeStatus {
        KeepAwakeStatus {
            desktop: true,
            supported: true,
            enabled: self.request.is_some(),
            message: None,
        }
    }

    fn set_enabled(&mut self, enabled: bool) -> Result<KeepAwakeStatus, String> {
        if enabled && self.request.is_none() {
            self.request = Some(KeepAwakeHandle::create()?);
        } else if !enabled {
            self.request = None;
        }
        Ok(self.status())
    }
}

#[cfg(not(windows))]
struct KeepAwakeState;

#[cfg(not(windows))]
impl KeepAwakeState {
    fn new() -> Self {
        Self
    }

    fn status(&self) -> KeepAwakeStatus {
        KeepAwakeStatus {
            desktop: true,
            supported: false,
            enabled: false,
            message: Some(
                "Keep Computer Awake is currently supported on Windows desktop builds.".to_string(),
            ),
        }
    }

    fn set_enabled(&mut self, _enabled: bool) -> Result<KeepAwakeStatus, String> {
        Ok(self.status())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatus {
    desktop: bool,
    current_version: String,
    target: Option<String>,
    pending: Option<UpdateMetadata>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheck {
    available: bool,
    checked_at: u64,
    update: Option<UpdateMetadata>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateMetadata {
    version: String,
    current_version: String,
    date: Option<String>,
    body: Option<String>,
    target: String,
    critical: bool,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
enum UpdateInstallEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
    Installing,
}

fn update_metadata(update: &Update) -> UpdateMetadata {
    UpdateMetadata {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        date: update.date.map(|d| d.to_string()),
        body: update.body.clone(),
        target: update.target.clone(),
        critical: update
            .raw_json
            .get("critical")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Drop for AppState {
    fn drop(&mut self) {
        self.kill_sidecar();
    }
}

fn startup_log_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| {
        let _ = std::fs::create_dir_all(&dir);
        dir.join("startup.log")
    })
}

fn lifecycle_preferences_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| {
            workspace_path(app)
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("."))
        })
        .join("lifecycle.json")
}

fn workspace_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|dir| strip_verbatim(&dir).join("workspaces"))
        .unwrap_or_else(|_| {
            let base = std::env::var_os("LOCALAPPDATA")
                .or_else(|| std::env::var_os("APPDATA"))
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            base.join("ai.skynet.harness").join("workspaces")
        })
}

fn same_path(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

fn push_unique_path(out: &mut Vec<PathBuf>, path: PathBuf) {
    if out.iter().any(|p| same_path(p, &path)) {
        return;
    }
    out.push(path);
}

fn legacy_workspace_paths(root: &Path, current: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut appdata_bases = ["LOCALAPPDATA", "APPDATA", "XDG_DATA_HOME"]
        .into_iter()
        .filter_map(|name| std::env::var_os(name).map(PathBuf::from))
        .collect::<Vec<_>>();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        // Tauri's live macOS root is ~/Library/Application Support/<bundle-id>, while old/manual Node
        // sidecars used ~/.local/share/{StarNet,Skynet}. Both are migration sources; the current root is
        // filtered below. Linux receives the same POSIX fallback that sidecar/workspace-safety.js protects.
        if cfg!(target_os = "macos") {
            appdata_bases.push(home.join("Library").join("Application Support"));
        }
        appdata_bases.push(home.join(".local").join("share"));
    }
    for base in appdata_bases {
        push_unique_path(&mut out, base.join("StarNet").join("workspaces"));
        push_unique_path(&mut out, base.join("Skynet").join("workspaces"));
        push_unique_path(&mut out, base.join("ai.skynet.harness").join("workspaces"));
    }
    push_unique_path(
        &mut out,
        strip_verbatim(root).join("sidecar").join("workspaces"),
    );
    push_unique_path(&mut out, strip_verbatim(root).join("workspaces"));
    out.into_iter()
        .filter(|path| !same_path(path, current))
        .collect()
}

fn copy_missing_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_file() {
        if !dst.exists() {
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let _ = std::fs::copy(src, dst)?;
        }
        return Ok(());
    }
    if !meta.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        copy_missing_dir(&entry.path(), &dst.join(entry.file_name()))?;
    }
    Ok(())
}

/// Name of the one-shot done-marker dropped in the live workspace root after the FIRST
/// successful legacy migration. Its presence is the sole signal to never migrate again.
const MIGRATION_MARKER: &str = ".migrated";
const MIGRATION_PENDING_MARKER: &str = ".migration-pending";
const MIGRATION_STAGE_SUFFIX: &str = ".migration-stage";
const MIGRATION_ROLLBACK_SUFFIX: &str = ".migration-rollback";
const MIGRATION_RECEIPT: &str = ".migration-receipt.json";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationFileReceipt {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationReceipt {
    version: u8,
    validated: bool,
    source_roots: Vec<String>,
    files: Vec<MigrationFileReceipt>,
}

fn migration_sibling(current: &Path, suffix: &str) -> PathBuf {
    let name = current
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("workspaces");
    current.with_file_name(format!("{name}{suffix}"))
}

fn unique_migration_sibling(current: &Path, suffix: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    migration_sibling(current, &format!("{suffix}-{}-{stamp}", std::process::id()))
}

fn is_migration_internal(path: &Path) -> bool {
    path.components().count() == 1
        && matches!(
            path.file_name().and_then(|value| value.to_str()),
            Some(MIGRATION_MARKER | MIGRATION_PENDING_MARKER | MIGRATION_RECEIPT)
        )
}

fn hash_file(path: &Path) -> std::io::Result<(u64, String)> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        bytes += read as u64;
        hasher.update(&buffer[..read]);
    }
    Ok((bytes, format!("{:x}", hasher.finalize())))
}

/// A legacy root becomes an automatic station source only when its canonical save is readable and proves the
/// StarNet save contract. This is intentionally stronger than "some JSON object": migration may carry other
/// durable stores, but it must never choose between two different stations by directory enumeration order.
fn valid_station_save_hash(root: &Path) -> Option<String> {
    for name in ["agent.save.json", "agent.save.json.bak"] {
        let file = root.join(name);
        let Ok(bytes) = std::fs::read(&file) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        let doc = value.get("doc").unwrap_or(&value);
        if doc.get("schema").and_then(|v| v.as_str()) != Some("starnet.save")
            || !doc.get("agent").map(|v| v.is_object()).unwrap_or(false)
        {
            continue;
        }
        return hash_file(&file).ok().map(|(_, digest)| digest);
    }
    None
}

fn collect_expected_files(
    root: &Path,
    relative: &Path,
    files: &mut BTreeMap<String, MigrationFileReceipt>,
) -> std::io::Result<()> {
    let path = root.join(relative);
    let metadata = std::fs::symlink_metadata(&path)?;
    if metadata.file_type().is_symlink() || is_migration_internal(relative) {
        return Ok(());
    }
    if metadata.is_file() {
        let key = relative.to_string_lossy().replace('\\', "/");
        if !files.contains_key(&key) {
            let (bytes, sha256) = hash_file(&path)?;
            files.insert(
                key.clone(),
                MigrationFileReceipt {
                    path: key,
                    bytes,
                    sha256,
                },
            );
        }
        return Ok(());
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path)? {
            let entry = entry?;
            collect_expected_files(root, &relative.join(entry.file_name()), files)?;
        }
    }
    Ok(())
}

fn migration_inventory(root: &Path) -> std::io::Result<Vec<MigrationFileReceipt>> {
    let mut files = BTreeMap::new();
    if root.is_dir() {
        collect_expected_files(root, Path::new(""), &mut files)?;
    }
    Ok(files.into_values().collect())
}

fn expected_migration_inventory(sources: &[PathBuf]) -> std::io::Result<Vec<MigrationFileReceipt>> {
    let mut files = BTreeMap::new();
    for source in sources {
        if source.is_dir() {
            collect_expected_files(source, Path::new(""), &mut files)?;
        }
    }
    Ok(files.into_values().collect())
}

fn validate_migration_semantics(
    stage: &Path,
    files: &[MigrationFileReceipt],
) -> std::io::Result<()> {
    for file in files {
        let name = Path::new(&file.path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if name == "agent.roster.json" || name.ends_with(".save.json") {
            let value: serde_json::Value =
                serde_json::from_slice(&std::fs::read(stage.join(&file.path))?)
                    .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
            if !value.is_object() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("{} must contain a JSON object", file.path),
                ));
            }
        }
    }
    Ok(())
}

fn validate_staged_generation(stage: &Path, receipt: &MigrationReceipt) -> std::io::Result<()> {
    if receipt.version != 1 || !receipt.validated {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "migration receipt is not validated version 1",
        ));
    }
    let actual = migration_inventory(stage)?;
    if actual != receipt.files {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "staged workspace inventory does not match its receipt",
        ));
    }
    validate_migration_semantics(stage, &actual)
}

fn activate_staged_generation(current: &Path, stage: &Path) -> std::io::Result<PathBuf> {
    let rollback = unique_migration_sibling(current, MIGRATION_ROLLBACK_SUFFIX);
    let had_current = current.exists();
    if had_current {
        std::fs::rename(current, &rollback)?;
    }
    if let Err(error) = std::fs::rename(stage, current) {
        if had_current {
            let _ = std::fs::rename(&rollback, current);
        }
        return Err(error);
    }
    Ok(rollback)
}

/// True when the live workspace root already holds real data (anything other than our own
/// marker file). A pre-existing populated root means an earlier install/migration already ran,
/// so we must NOT copy from legacy roots — doing so resurrects files the user deleted.
fn workspace_has_content(current: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(current) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name();
        name != std::ffi::OsStr::new(MIGRATION_MARKER)
            && name != std::ffi::OsStr::new(MIGRATION_PENDING_MARKER)
            && name != std::ffi::OsStr::new(MIGRATION_RECEIPT)
    })
}

/// One-time import of data from legacy workspace roots into the live one. THIS RUNS ONCE, EVER.
///
/// Bug it fixes (audit 0.1): running unconditionally every boot means `copy_missing_dir` re-copies
/// any file present in a stale legacy root (e.g. %LOCALAPPDATA%\StarNet\workspaces) but absent in
/// the live root — so agents/prospects/sessions the user DELETED silently reappear on the next
/// launch. Guard rails, checked before any copy:
///   1. If the `.migrated` marker exists in the live root, skip entirely (the definitive signal).
///   2. Belt-and-suspenders: if the live root already has real content, skip and drop the marker
///      so a first-run-with-marker-missing but already-populated install never migrates either.
/// Copies land in a sibling generation first. A hash inventory, semantic state validation, and a
/// durable receipt must all agree before directory renames activate it; the prior generation is
/// retained as rollback evidence.
fn migrate_workspace_data(
    current: &Path,
    legacy_roots: &[PathBuf],
    startup_log: &Option<PathBuf>,
) -> Vec<PathBuf> {
    let mut migrated = Vec::new();
    if let Some(parent) = current.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let marker = current.join(MIGRATION_MARKER);
    let pending = current.join(MIGRATION_PENDING_MARKER);
    let stage = migration_sibling(current, MIGRATION_STAGE_SUFFIX);

    // (1) Already migrated once — never touch legacy roots again.
    if marker.exists() {
        let _ = std::fs::remove_file(&pending);
        return migrated;
    }
    // A populated live root predating migration receipts remains authoritative. Never let a
    // stale sibling generation replace it; only an explicit pending marker permits recovery.
    if !pending.exists() && workspace_has_content(current) {
        let _ = std::fs::write(&marker, b"1");
        return migrated;
    }
    let staged_receipt = std::fs::read(stage.join(MIGRATION_RECEIPT))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<MigrationReceipt>(&bytes).ok());
    if let Some(receipt) = staged_receipt {
        if validate_staged_generation(&stage, &receipt).is_ok() {
            match activate_staged_generation(current, &stage) {
                Ok(rollback) => {
                    log_startup(
                        startup_log,
                        format!(
                            "workspace-migration: activated verified staged generation; rollback={}",
                            rollback.display()
                        ),
                    );
                    return receipt
                        .source_roots
                        .into_iter()
                        .map(PathBuf::from)
                        .collect();
                }
                Err(error) => {
                    log_startup(
                        startup_log,
                        format!(
                            "workspace-migration: RETRY required; staged activation failed: {error}"
                        ),
                    );
                    return migrated;
                }
            }
        }
    }
    // Invalid or incomplete stages are preserved for forensics before a clean retry.
    if stage.exists() {
        let quarantine = unique_migration_sibling(current, ".migration-invalid");
        if let Err(error) = std::fs::rename(&stage, &quarantine) {
            log_startup(
                startup_log,
                format!(
                    "workspace-migration: RETRY required; could not quarantine invalid stage: {error}"
                ),
            );
            return migrated;
        }
    }

    // One valid legacy station is safe to self-heal. Two different valid saves are a product decision, not a
    // filesystem merge: leave both byte-untouched and let Recovery Mode's candidate picker choose explicitly.
    let valid_legacy = legacy_roots
        .iter()
        .filter(|root| root.is_dir())
        .filter_map(|root| valid_station_save_hash(root).map(|digest| (root.clone(), digest)))
        .collect::<Vec<_>>();
    let distinct_saves = valid_legacy
        .iter()
        .map(|(_, digest)| digest.clone())
        .collect::<std::collections::BTreeSet<_>>();
    if distinct_saves.len() > 1 {
        log_startup(
            startup_log,
            format!(
                "workspace-migration: CONFLICT — {} different valid legacy stations found; awaiting explicit Recovery Mode selection",
                distinct_saves.len()
            ),
        );
        return migrated;
    }
    if let Err(error) = std::fs::create_dir_all(&stage)
        .and_then(|_| std::fs::write(stage.join(MIGRATION_PENDING_MARKER), b"1"))
    {
        log_startup(
            startup_log,
            format!("workspace-migration: RETRY required; could not create stage: {error}"),
        );
        return migrated;
    }

    let mut sources = Vec::new();
    if current.is_dir() {
        sources.push(current.to_path_buf());
    }
    if let Some((selected, _)) = valid_legacy.first() {
        // If duplicate roots carry the same save, choose one complete generation deterministically rather than
        // merging unrelated sibling files. The selected root itself remains unchanged as the recovery source.
        sources.push(selected.clone());
    } else {
        sources.extend(legacy_roots.iter().filter(|root| root.is_dir()).cloned());
    }
    let expected = match expected_migration_inventory(&sources) {
        Ok(files) => files,
        Err(error) => {
            let source_roots = sources
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            log_startup(
                startup_log,
                format!(
                    "workspace-migration: RETRY required; source inventory failed for {source_roots}: {error}"
                ),
            );
            return migrated;
        }
    };

    let mut copy_failed = false;
    for source in &sources {
        match copy_missing_dir(source, &stage) {
            Ok(()) => {
                if !same_path(source, current) {
                    migrated.push(source.clone());
                }
            }
            Err(error) => {
                copy_failed = true;
                log_startup(
                    startup_log,
                    format!(
                        "workspace-migration: RETRY required; copy from {} failed: {error}",
                        source.display()
                    ),
                );
            }
        }
    }
    if copy_failed {
        migrated.clear();
        return migrated;
    }

    let _ = std::fs::remove_file(stage.join(MIGRATION_PENDING_MARKER));
    let _ = std::fs::remove_file(stage.join(MIGRATION_MARKER));
    let actual = match migration_inventory(&stage) {
        Ok(files) => files,
        Err(error) => {
            log_startup(
                startup_log,
                format!("workspace-migration: RETRY required; staged inventory failed: {error}"),
            );
            migrated.clear();
            return migrated;
        }
    };
    if actual != expected {
        log_startup(
            startup_log,
            "workspace-migration: RETRY required; staged inventory differs from source inventory",
        );
        migrated.clear();
        return migrated;
    }
    if let Err(error) = validate_migration_semantics(&stage, &actual) {
        log_startup(
            startup_log,
            format!("workspace-migration: RETRY required; semantic validation failed: {error}"),
        );
        migrated.clear();
        return migrated;
    }

    let receipt = MigrationReceipt {
        version: 1,
        validated: true,
        source_roots: migrated
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        files: actual,
    };
    let receipt_bytes = match serde_json::to_vec_pretty(&receipt) {
        Ok(bytes) => bytes,
        Err(error) => {
            log_startup(
                startup_log,
                format!(
                    "workspace-migration: RETRY required; receipt serialization failed: {error}"
                ),
            );
            migrated.clear();
            return migrated;
        }
    };
    if let Err(error) = std::fs::write(stage.join(MIGRATION_RECEIPT), receipt_bytes)
        .and_then(|_| std::fs::write(stage.join(MIGRATION_MARKER), b"1"))
    {
        log_startup(
            startup_log,
            format!(
                "workspace-migration: RETRY required; could not seal staged generation: {error}"
            ),
        );
        migrated.clear();
        return migrated;
    }
    if let Err(error) = validate_staged_generation(&stage, &receipt) {
        log_startup(
            startup_log,
            format!(
                "workspace-migration: RETRY required; sealed generation validation failed: {error}"
            ),
        );
        migrated.clear();
        return migrated;
    }
    match activate_staged_generation(current, &stage) {
        Ok(rollback) => log_startup(
            startup_log,
            format!(
                "workspace-migration: activated verified generation; rollback={}",
                rollback.display()
            ),
        ),
        Err(error) => {
            log_startup(
                startup_log,
                format!("workspace-migration: RETRY required; activation failed: {error}"),
            );
            migrated.clear();
        }
    }
    migrated
}

#[cfg(test)]
mod workspace_migration_tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "starnet-workspace-migration-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ))
    }

    #[cfg(windows)]
    #[test]
    fn failed_copy_leaves_migration_retryable() {
        use std::os::windows::fs::OpenOptionsExt;

        let base = temp_dir("locked-source");
        let legacy = base.join("legacy");
        let current = base.join("current");
        let startup_log = base.join("startup.log");
        std::fs::create_dir_all(legacy.join("sessions")).unwrap();
        let source = legacy.join("sessions").join("history.jsonl");
        std::fs::write(&source, b"important session").unwrap();

        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&source)
            .unwrap();
        let migrated = migrate_workspace_data(
            &current,
            std::slice::from_ref(&legacy),
            &Some(startup_log.clone()),
        );
        assert!(
            migrated.is_empty(),
            "a failed legacy root is not reported as migrated"
        );
        assert!(
            !current.join(MIGRATION_MARKER).exists(),
            "a failed copy must not stamp the one-shot marker"
        );
        assert!(
            !current.exists(),
            "a failed copy must not expose a partial live workspace"
        );
        assert!(
            migration_sibling(&current, MIGRATION_STAGE_SUFFIX)
                .join(MIGRATION_PENDING_MARKER)
                .exists(),
            "the failed sibling generation remains retryable"
        );
        let failure_log = std::fs::read_to_string(&startup_log).unwrap();
        assert!(failure_log.contains("RETRY required"));
        assert!(failure_log.contains(&legacy.display().to_string()));

        drop(lock);
        let retried = migrate_workspace_data(&current, std::slice::from_ref(&legacy), &None);
        assert_eq!(
            retried,
            vec![legacy.clone()],
            "the next boot retries the legacy root"
        );
        assert_eq!(
            std::fs::read(current.join("sessions").join("history.jsonl")).unwrap(),
            b"important session"
        );
        assert!(current.join(MIGRATION_MARKER).exists());
        assert!(!current.join(MIGRATION_PENDING_MARKER).exists());
        assert!(current.join(MIGRATION_RECEIPT).exists());

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn verified_generation_preserves_prior_live_tree_as_rollback() {
        let base = temp_dir("rollback");
        let legacy = base.join("legacy");
        let current = base.join("current");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::create_dir_all(&current).unwrap();
        std::fs::write(current.join(MIGRATION_PENDING_MARKER), b"1").unwrap();
        std::fs::write(current.join("agent.save.json"), br#"{"version":1}"#).unwrap();
        std::fs::write(legacy.join("agent.roster.json"), br#"{"agents":[]}"#).unwrap();

        let migrated = migrate_workspace_data(&current, std::slice::from_ref(&legacy), &None);
        assert_eq!(migrated, vec![legacy.clone()]);
        assert!(current.join(MIGRATION_MARKER).exists());
        assert!(current.join(MIGRATION_RECEIPT).exists());
        assert!(current.join("agent.save.json").exists());
        assert!(current.join("agent.roster.json").exists());

        let rollback = std::fs::read_dir(&base)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| name.starts_with("current.migration-rollback-"))
                    .unwrap_or(false)
            })
            .expect("activation retains the prior live generation");
        assert!(rollback.join("agent.save.json").exists());
        assert!(rollback.join(MIGRATION_PENDING_MARKER).exists());

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn invalid_semantic_state_never_activates() {
        let base = temp_dir("invalid-json");
        let legacy = base.join("legacy");
        let current = base.join("current");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("agent.save.json"), b"{not-json").unwrap();

        let migrated = migrate_workspace_data(&current, std::slice::from_ref(&legacy), &None);
        assert!(migrated.is_empty());
        assert!(!current.exists(), "invalid state is never made live");
        assert!(
            migration_sibling(&current, MIGRATION_STAGE_SUFFIX).exists(),
            "invalid stage is retained for recovery and forensics"
        );

        let _ = std::fs::remove_dir_all(base);
    }

    fn station_save(name: &str, updated_at: u64) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "doc": {
                "schema": "starnet.save",
                "version": 5,
                "updatedAt": updated_at,
                "agent": { "id": "agent", "name": name }
            }
        }))
        .unwrap()
    }

    #[test]
    fn distinct_valid_legacy_stations_wait_for_explicit_selection() {
        let base = temp_dir("station-conflict");
        let first = base.join("first");
        let second = base.join("second");
        let current = base.join("current");
        let startup_log = base.join("startup.log");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        std::fs::write(first.join("agent.save.json"), station_save("NOVA", 1)).unwrap();
        std::fs::write(second.join("agent.save.json"), station_save("ORION", 2)).unwrap();

        let migrated = migrate_workspace_data(
            &current,
            &[first.clone(), second.clone()],
            &Some(startup_log.clone()),
        );
        assert!(migrated.is_empty());
        assert!(
            !current.exists(),
            "conflicting stations never create an active generation"
        );
        assert!(first.join("agent.save.json").exists());
        assert!(second.join("agent.save.json").exists());
        assert!(std::fs::read_to_string(startup_log)
            .unwrap()
            .contains("awaiting explicit Recovery Mode selection"));

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn one_valid_legacy_station_is_selected_without_merging_noise() {
        let base = temp_dir("single-station");
        let station = base.join("station");
        let unrelated = base.join("unrelated");
        let current = base.join("current");
        std::fs::create_dir_all(&station).unwrap();
        std::fs::create_dir_all(&unrelated).unwrap();
        std::fs::write(station.join("agent.save.json"), station_save("NOVA", 1)).unwrap();
        std::fs::write(unrelated.join("unrelated.cache"), b"not station state").unwrap();

        let migrated = migrate_workspace_data(&current, &[station.clone(), unrelated], &None);
        assert_eq!(migrated, vec![station]);
        assert!(current.join("agent.save.json").exists());
        assert!(!current.join("unrelated.cache").exists());

        let _ = std::fs::remove_dir_all(base);
    }
}

fn log_startup(path: &Option<PathBuf>, message: impl AsRef<str>) {
    let Some(path) = path else {
        return;
    };
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        use std::io::Write;
        let _ = writeln!(file, "{}", message.as_ref());
    }
}

// ---- WebView2 stale-cache purge on packaged-build change ---------------------------------
//
// The desktop webview loads the frontend COMPILED INTO the exe (tauri.localhost). WebView2
// caches those assets (Cache / `Code Cache/js`) and never revalidates. After an exe swap, V8
// can run OLD bytecode against NEW data — the 2026-07-06 incident (agents vanished from the
// world sim, COMMS fell back to the overseer). A version-only marker is insufficient: release
// candidates are routinely rebuilt and reinstalled under the same semver, which left the old
// voice controller running after the fixed 0.8.0 installer was installed. Key the marker to the
// exact executable bytes and purge on every packaged-build change while PRESERVING user state
// (Local Storage holds the world save under `starnet.save`).

/// Pure decision: given the previously-recorded marker (if any) and the running build identity,
/// should we purge the stale webview caches? Purge on first run (no marker) or on any change.
/// Kept side-effect-free so it can be unit-tested without touching the filesystem.
fn should_purge_webview_cache(last_marker: Option<&str>, current_build: &str) -> bool {
    match last_marker {
        Some(prev) => prev.trim() != current_build.trim(),
        None => true,
    }
}

/// Stable marker payload for the exact packaged executable. The runtime SHA is the authority:
/// unlike semver or the Git tree it changes for a same-version rebuild and covers generated bundle
/// inputs. If hashing the executable fails, fall back to the strongest compile-time source identity.
fn webview_build_identity(current_version: &str) -> String {
    let (executable_sha, executable_size) = runtime_executable_identity();
    let artifact = if !executable_sha.is_empty() && executable_size > 0 {
        format!("exe:{executable_sha}:{executable_size}")
    } else {
        format!(
            "source:{}:{}:{}",
            env!("STARNET_BUILD_SHA"),
            env!("STARNET_BUILD_TREE"),
            env!("STARNET_BUILD_DESCRIBE")
        )
    };
    format!("{}|{}", current_version.trim(), artifact)
}

/// Marker file recording the exact build that last ran. The legacy filename is retained so
/// existing version-only markers differ and force the required one-time migration purge.
fn last_run_version_marker(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| {
        let _ = std::fs::create_dir_all(&dir);
        dir.join("last-run-version")
    })
}

/// Resolve the EBWebView user-data directory the webview will actually use. Honors the
/// WEBVIEW2_USER_DATA_FOLDER override; otherwise the Tauri/WebView2 default of
/// `%LOCALAPPDATA%\<identifier>\EBWebView`.
#[cfg(windows)]
fn webview2_user_data_dir(identifier: &str) -> Option<PathBuf> {
    if let Some(override_dir) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") {
        let p = PathBuf::from(override_dir);
        if !p.as_os_str().is_empty() {
            return Some(p);
        }
    }
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|base| base.join(identifier).join("EBWebView"))
}

/// Compiled/GPU cache subdirs under `EBWebView\Default` that are safe to delete on version
/// change. Deliberately EXCLUDES Local Storage / Session Storage / IndexedDB / Cookies —
/// those hold the user's world save and must be byte-preserved.
#[cfg(windows)]
const WEBVIEW2_STALE_CACHE_DIRS: [&str; 5] = [
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
];

/// Delete the stale compiled/GPU caches under `<user_data>\Default`. Fails soft: a locked
/// or missing dir is logged and skipped, never fatal to boot. Returns the dirs actually
/// removed (for logging/telemetry).
#[cfg(windows)]
fn purge_webview2_caches(user_data_dir: &Path, startup_log: &Option<PathBuf>) -> Vec<String> {
    let default_dir = user_data_dir.join("Default");
    let mut removed = Vec::new();
    for name in WEBVIEW2_STALE_CACHE_DIRS {
        let target = default_dir.join(name);
        if !target.exists() {
            continue;
        }
        match std::fs::remove_dir_all(&target) {
            Ok(()) => {
                removed.push(name.to_string());
                log_startup(
                    startup_log,
                    format!("webview-cache-purge: removed {}", target.display()),
                );
            }
            Err(e) => {
                // App likely running / files locked — never crash boot, just record it.
                log_startup(
                    startup_log,
                    format!(
                        "webview-cache-purge: SKIP {} (soft-fail: {e})",
                        target.display()
                    ),
                );
            }
        }
    }
    removed
}

/// Top-level orchestration: compare the exact running build to the stored marker; on first run
/// or any build change, purge the stale webview caches (Windows/WebView2 today; other platforms
/// hook in later), then record the new marker. Platform-neutral marker logic so a future
/// mac/linux (WebKit) purge can reuse the same decision path.
fn purge_stale_webview_cache_on_build_change(
    app: &tauri::AppHandle,
    identifier: &str,
    current_version: &str,
    startup_log: &Option<PathBuf>,
) {
    let current_build = webview_build_identity(current_version);
    let marker_path = last_run_version_marker(app);
    let last = marker_path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok());
    let last_trimmed = last.as_ref().map(|s| s.trim());

    if !should_purge_webview_cache(last_trimmed, &current_build) {
        return;
    }

    log_startup(
        startup_log,
        format!(
            "webview-cache-purge: packaged-build change {:?} -> {} — purging stale caches (preserving Local Storage/IndexedDB/cookies)",
            last_trimmed, current_build
        ),
    );

    #[cfg(windows)]
    {
        match webview2_user_data_dir(identifier) {
            Some(user_data_dir) => {
                let removed = purge_webview2_caches(&user_data_dir, startup_log);
                log_startup(
                    startup_log,
                    format!(
                        "webview-cache-purge: done ({} of {} cache dir(s) removed) under {}",
                        removed.len(),
                        WEBVIEW2_STALE_CACHE_DIRS.len(),
                        user_data_dir.join("Default").display()
                    ),
                );
            }
            None => log_startup(
                startup_log,
                "webview-cache-purge: could not resolve EBWebView user-data dir — skipped",
            ),
        }
    }
    #[cfg(not(windows))]
    {
        // WebKit (macOS/Linux) caches live elsewhere; no purge wired yet. Marker still
        // advances so the decision path is exercised cross-platform.
        let _ = identifier;
        log_startup(
            startup_log,
            "webview-cache-purge: non-Windows platform — no cache purge wired yet",
        );
    }

    // Record the new marker LAST, so a crash mid-purge re-triggers a purge next boot rather
    // than leaving stale caches behind a satisfied marker.
    if let Some(path) = marker_path {
        if let Err(e) = std::fs::write(&path, &current_build) {
            log_startup(
                startup_log,
                format!(
                    "webview-cache-purge: failed to write marker {} ({e})",
                    path.display()
                ),
            );
        }
    }
}

// ---- sidecar ----

/// Reserve an unused loopback port, then release it so the sidecar can bind it.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|addr| addr.port())
        .expect("could not reserve a local port for the sidecar")
}

/// Node.js can't use a Windows `\\?\` verbatim path as its main module or cwd, so
/// normalize it back to a plain `C:\...` path.
fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p.to_path_buf(),
    }
}

/// Directory holding `sidecar/index.js` (+ `frontend/`, `shared/`). Dev = live
/// worktree one level up; release = bundled resource dir.
fn project_root(app: &tauri::AppHandle) -> PathBuf {
    let candidates = if cfg!(debug_assertions) {
        vec![PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))]
    } else {
        let mut paths = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                paths.push(dir.to_path_buf());
            }
        }
        if let Ok(resource_dir) = app.path().resource_dir() {
            paths.push(resource_dir);
        }
        paths.push(PathBuf::from("."));
        paths
    };
    candidates
        .into_iter()
        .map(|p| strip_verbatim(&p))
        .find(|p| p.join("sidecar").join("index.js").exists())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Block (briefly) until the sidecar is accepting connections, or give up.
fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

/// Resolve the Node runtime. Packaged builds ship one via Tauri externalBin;
/// dev builds fall back to the system PATH.
fn node_binary(root: &Path) -> PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let root_candidate = root.join(name);
    if root_candidate.exists() {
        return root_candidate;
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(name);
            if candidate.exists() {
                return candidate;
            }
        }
    }
    PathBuf::from("node")
}

// ---- boot-time orphan-sidecar reap -------------------------------------------------------
//
// ESCAPE (2026-07-08): killing the shell hard (`taskkill /F`, crash, task-manager End Task)
// never runs `Drop for AppState` / the ExitRequested handler, so the spawned node.exe sidecar
// survives as an orphan. Multiple live sidecars sharing one WORKSPACES dir break the hard
// one-sidecar-per-WORKSPACES invariant (durable-store safety is in-process only), and Codex
// OAuth refresh-token rotation means two sidecars sharing one token file consume each other's
// tokens ("refresh token already consumed by another client"). Three stale sidecars were found
// alive on a real machine. There is no reliable in-process hook on a hard kill — so the
// RELIABLE half of the fix is here: every boot, BEFORE spawning our own sidecar, terminate any
// process still running from the shell's OWN bundled node runtime.

/// Pure predicate: is `node` a path we may reap by? Only the shell's own bundled runtime
/// qualifies — an absolute path (packaged builds resolve `<install dir>\node.exe`). The dev
/// fallback `node_binary()` returns (`PathBuf::from("node")`, resolved via PATH) is relative,
/// and reaping by it would pattern-match EVERY node.exe on the system (dev servers, other
/// apps). Kept side-effect-free so it is unit-testable.
fn is_reapable_node_path(node: &Path) -> bool {
    node.is_absolute() && node.file_name().is_some()
}

/// Terminate every running process whose executable image is EXACTLY `node` — the same path
/// this shell spawns its sidecar from (never a generic "node.exe" name match). Returns how
/// many were reaped. Fail-open by design: any enumeration/open/query/terminate error skips
/// that process and never blocks startup.
#[cfg(windows)]
fn reap_orphan_sidecars(node: &Path, startup_log: &Option<PathBuf>) -> usize {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE, MAX_PATH};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };

    if !is_reapable_node_path(node) {
        log_startup(
            startup_log,
            format!(
                "sidecar-reap: skipped — node path {:?} is not an absolute bundled runtime (dev PATH fallback)",
                node
            ),
        );
        return 0;
    }
    // File-name prefilter (cheap, from the snapshot) before the full-image-path check.
    let node_file_name = node
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        log_startup(
            startup_log,
            "sidecar-reap: snapshot failed — skipped (fail-open)",
        );
        return 0;
    }

    let mut reaped = 0usize;
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while ok {
        let exe_name = {
            let len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase()
        };
        if exe_name == node_file_name && entry.th32ProcessID != std::process::id() {
            let pid = entry.th32ProcessID;
            let handle = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
                    0,
                    pid,
                )
            };
            if !handle.is_null() {
                // Full image path — the ONLY thing that authorizes a kill. A node.exe running
                // from anywhere else (system PATH, another app's bundle) is never touched.
                let mut buf = [0u16; MAX_PATH as usize + 1];
                let mut size = buf.len() as u32;
                let got =
                    unsafe { QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut size) };
                if got != 0 {
                    let full = PathBuf::from(String::from_utf16_lossy(&buf[..size as usize]));
                    if same_path(&full, node) {
                        if unsafe { TerminateProcess(handle, 1) } != 0 {
                            reaped += 1;
                            log_startup(
                                startup_log,
                                format!(
                                    "sidecar-reap: terminated orphan sidecar pid={pid} ({})",
                                    full.display()
                                ),
                            );
                        } else {
                            log_startup(
                                startup_log,
                                format!("sidecar-reap: TerminateProcess failed for pid={pid} — skipped (fail-open)"),
                            );
                        }
                    }
                }
                unsafe {
                    CloseHandle(handle);
                }
            }
        }
        ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe {
        CloseHandle(snapshot);
    }
    log_startup(
        startup_log,
        format!(
            "sidecar-reap: done — {reaped} orphan sidecar(s) reaped for {}",
            node.display()
        ),
    );
    reaped
}

#[cfg(target_os = "macos")]
fn mac_process_image_path(pid: i32) -> Option<PathBuf> {
    use std::ffi::{c_void, OsString};
    use std::os::unix::ffi::OsStringExt;

    #[link(name = "proc")]
    unsafe extern "C" {
        fn proc_pidpath(pid: i32, buffer: *mut c_void, buffersize: u32) -> i32;
    }

    const PROC_PIDPATHINFO_MAXSIZE: usize = 4096;
    let mut buffer = vec![0u8; PROC_PIDPATHINFO_MAXSIZE];
    let written = unsafe {
        proc_pidpath(
            pid,
            buffer.as_mut_ptr().cast::<c_void>(),
            buffer.len() as u32,
        )
    };
    if written <= 0 {
        return None;
    }
    let len = buffer
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(written as usize);
    Some(PathBuf::from(OsString::from_vec(buffer[..len].to_vec())))
}

/// macOS backstop for a desktop process that exits without running its managed-state Drop hook.
/// Enumerate every PID, authorize termination only when libproc reports the exact bundled Node
/// image path, ask it to shut down gracefully, then force only that same verified image if needed.
#[cfg(target_os = "macos")]
fn reap_orphan_sidecars(node: &Path, startup_log: &Option<PathBuf>) -> usize {
    use std::ffi::c_void;

    #[link(name = "proc")]
    unsafe extern "C" {
        fn proc_listallpids(buffer: *mut c_void, buffersize: i32) -> i32;
    }
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }

    if !is_reapable_node_path(node) {
        log_startup(
            startup_log,
            format!(
                "sidecar-reap: skipped — node path {:?} is not an absolute bundled runtime (dev PATH fallback)",
                node
            ),
        );
        return 0;
    }

    let estimated = unsafe { proc_listallpids(std::ptr::null_mut(), 0) };
    if estimated <= 0 {
        log_startup(
            startup_log,
            "sidecar-reap: macOS PID enumeration failed — skipped",
        );
        return 0;
    }
    let mut pids = vec![0i32; estimated as usize + 64];
    let capacity = (pids.len() * std::mem::size_of::<i32>()) as i32;
    let count = unsafe { proc_listallpids(pids.as_mut_ptr().cast::<c_void>(), capacity) };
    if count <= 0 {
        log_startup(
            startup_log,
            "sidecar-reap: macOS PID enumeration failed — skipped",
        );
        return 0;
    }
    pids.truncate((count as usize).min(pids.len()));

    let mut reaped = 0usize;
    for pid in pids {
        if pid <= 0 || pid == std::process::id() as i32 {
            continue;
        }
        if !mac_process_image_path(pid).is_some_and(|path| same_path(&path, node)) {
            continue;
        }

        const SIGTERM: i32 = 15;
        const SIGKILL: i32 = 9;
        let _ = unsafe { kill(pid, SIGTERM) };
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            if !mac_process_image_path(pid).is_some_and(|path| same_path(&path, node)) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if mac_process_image_path(pid).is_some_and(|path| same_path(&path, node)) {
            let _ = unsafe { kill(pid, SIGKILL) };
        }
        if !mac_process_image_path(pid).is_some_and(|path| same_path(&path, node)) {
            reaped += 1;
            log_startup(
                startup_log,
                format!(
                    "sidecar-reap: terminated orphan sidecar pid={pid} ({})",
                    node.display()
                ),
            );
        }
    }
    log_startup(
        startup_log,
        format!(
            "sidecar-reap: done — {reaped} orphan sidecar(s) reaped for {}",
            node.display()
        ),
    );
    reaped
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn reap_orphan_sidecars(node: &Path, startup_log: &Option<PathBuf>) -> usize {
    let _ = node;
    log_startup(
        startup_log,
        "sidecar-reap: this platform has no exact-image reaper wired",
    );
    0
}

/// The sidecar accepts both the canonical STARNET_* names and legacy SKYNET_* aliases. Replace both
/// spellings for every shell-owned value so an inherited stale variable cannot split the WebView from
/// its sidecar or override a per-launch credential.
fn set_sidecar_branded_env<V: AsRef<OsStr>>(cmd: &mut Command, legacy_name: &str, value: V) {
    let value = value.as_ref();
    cmd.env(legacy_name, value);
    if let Some(suffix) = legacy_name.strip_prefix("SKYNET_") {
        cmd.env(format!("STARNET_{suffix}"), value);
    } else if let Some(suffix) = legacy_name.strip_prefix("STARNET_") {
        cmd.env(format!("SKYNET_{suffix}"), value);
    }
}

fn sidecar_command(state: &AppState, entry: &Path, node: &Path) -> Command {
    let mut cmd = Command::new(node);
    cmd.arg(entry)
        // The sidecar can load the native Windows desktop driver, but that alone grants nothing:
        // only a locally paired Telegram owner receives the per-run remote-owner lease. Ordinary
        // agent runs remain synthetic/headless by policy in the sidecar.
        .env("STARNET_DESKTOP_SHELL", "1")
        .env("STARNET_COMPUTER_DRIVER", "1")
        // Do NOT pin STARNET_BROWSER_HEADLESS on the whole sidecar. runOnce gives ordinary
        // model-driven browsing forceHeadless + syntheticInputOnly directly, while the watched
        // browser.login tool is a separately consented, human-driven headed exception. A process-
        // wide env pin disables that exception before its consent flow can run and leaves users
        // with the unsafe/hostile "start Chrome with a debugging port" workaround.
        .env("STARNET_USER_CONTROL_MODE", "preserve")
        .env("STARNET_MCP_STDIO", "0")
        // The packaged build's true version — computeVersionSurface() reads this first, so
        // /api/diagnostics reports the real build instead of "unknown" (the bundled sidecar
        // has no src-tauri/tauri.conf.json to fall back to). CARGO_PKG_VERSION is the
        // compile-time Cargo.toml version, kept in lockstep with tauri.conf.json by release-bump.
        .env("STARNET_APP_VERSION", env!("CARGO_PKG_VERSION"))
        // The exact source this desktop was compiled from (build.rs → `git describe --always --dirty --tags`,
        // e.g. "v0.4.1" clean or "v0.4.1-32-g8b5aae04-dirty"). Exported so the bundled sidecar can surface the
        // real build provenance at /api/version — a packaged app has no .git to derive it from at runtime.
        .env("STARNET_BUILD_DESCRIBE", env!("STARNET_BUILD_DESCRIBE"))
        // Full immutable source identity for installed-smoke/release receipts. Keep this separate from the
        // short human-facing commit exposed by starnet_build_info.
        .env("STARNET_BUILD_SHA", env!("STARNET_BUILD_SHA"))
        .env("STARNET_BUILD_TREE", env!("STARNET_BUILD_TREE"))
        .env(
            "STARNET_BUILD_PROVENANCE_KIND",
            env!("STARNET_BUILD_PROVENANCE_KIND"),
        )
        .env("STARNET_BUILD_DIRTY", env!("STARNET_BUILD_DIRTY"))
        .current_dir(&state.root);
    set_sidecar_branded_env(&mut cmd, "SKYNET_PORT", state.port.to_string());
    set_sidecar_branded_env(&mut cmd, "SKYNET_IPC_TOKEN", &state.ipc_token);
    set_sidecar_branded_env(&mut cmd, "SKYNET_API_TOKEN", &state.api_token);
    set_sidecar_branded_env(&mut cmd, "SKYNET_WORKSPACES", state.workspaces.as_os_str());
    if let Some(key) = read_key() {
        set_sidecar_branded_env(&mut cmd, "SKYNET_OPENROUTER_KEY", key);
    }
    for (provider, env_name) in SIDECAR_PROVIDER_KEY_ENVS {
        if let Some(key) = read_key_for(provider) {
            set_sidecar_branded_env(&mut cmd, env_name, key);
        }
    }
    for provider in KEYCHAIN_PROVIDERS {
        let pool = read_key_pool_for(provider);
        if !pool.is_empty() {
            let env_name = format!(
                "SKYNET_KEY_POOL_{}",
                provider.to_ascii_uppercase().replace('-', "_")
            );
            set_sidecar_branded_env(&mut cmd, &env_name, pool.join(","));
        }
    }
    // Channel bot tokens (Telegram/Discord) inject the same way — keychain -> env -> sidecar runtime layer.
    for (channel, env_name) in SIDECAR_CHANNEL_TOKEN_ENVS {
        if let Some(token) = read_channel_token(channel) {
            set_sidecar_branded_env(&mut cmd, env_name, token);
        }
    }
    let telegram_bot_tokens = read_telegram_bot_tokens(&state.workspaces);
    if !telegram_bot_tokens.is_empty() {
        if let Ok(encoded) = serde_json::to_string(&telegram_bot_tokens) {
            set_sidecar_branded_env(&mut cmd, "SKYNET_TELEGRAM_BOT_TOKENS", encoded);
        }
    }
    // StarNet Cloud device token, same path. Because EVERY sidecar spawn goes through this builder,
    // a sidecar restarted after adoption still comes up linked even though the token is no longer
    // in credits.json — the file keeps the non-secret fields and this supplies the secret.
    if let Some(token) = read_credits_token() {
        cmd.env("STARNET_CREDITS_TOKEN", token);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Spawn the sidecar ONCE, injecting the keychain key (if any) as SKYNET_OPENROUTER_KEY
/// and the per-launch IPC token. Returns true once it's listening.
fn spawn_sidecar(state: &AppState) -> bool {
    let entry = state.root.join("sidecar").join("index.js");
    let node = node_binary(&state.root);
    log_startup(
        &state.startup_log,
        format!(
            "spawn_sidecar root={} entry={} entry_exists={} node={} node_exists={}",
            state.root.display(),
            entry.display(),
            entry.exists(),
            node.display(),
            node.exists()
        ),
    );

    let mut last_error = None;
    for attempt in 0..=20 {
        match sidecar_command(state, &entry, &node).spawn() {
            Ok(child) => {
                let pid = child.id();
                if let Ok(mut guard) = state.sidecar.lock() {
                    *guard = Some(child);
                }
                let listening = wait_for_port(state.port, Duration::from_secs(25));
                log_startup(
                    &state.startup_log,
                    format!(
                        "spawn_sidecar pid={pid} port={} listening={listening}",
                        state.port
                    ),
                );
                return listening;
            }
            Err(e) if cfg!(windows) && e.raw_os_error() == Some(32) && attempt < 20 => {
                last_error = Some(e.to_string());
                std::thread::sleep(Duration::from_millis(500));
            }
            Err(e) => {
                log_startup(&state.startup_log, format!("spawn_sidecar failed: {e}"));
                eprintln!("[starnet] failed to spawn node sidecar: {e}");
                return false;
            }
        }
    }
    log_startup(
        &state.startup_log,
        format!(
            "spawn_sidecar failed after retrying locked node.exe: {}",
            last_error.unwrap_or_else(|| "unknown error".to_string())
        ),
    );
    false
}

/// Startup-failure dialog (audit 0.2). When the FIRST `spawn_sidecar` fails — e.g. a first-run
/// user whose bundled node was blocked by antivirus/Application-Control — the window would
/// otherwise open dead with every /api fetch failing, no explanation, no way back. This surfaces
/// a native error box that names the startup.log path (the diagnostic) and offers Retry.
///
/// Returns `true` if the user chose Retry (caller should re-attempt the spawn), `false` on
/// Cancel/close. On non-Windows there is no dialog dependency wired, so we log and return `false`
/// (honest degradation — the AV-block scenario this fixes is Windows-specific).
#[cfg(windows)]
fn show_startup_failure_dialog(startup_log: &Option<PathBuf>) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDRETRY, MB_ICONERROR, MB_RETRYCANCEL, MB_SETFOREGROUND, MB_SYSTEMMODAL,
    };
    let log_line = match startup_log {
        Some(p) => format!("Details were written to:\n{}", p.display()),
        None => "No startup log path was available.".to_string(),
    };
    let body = format!(
        "StarNet could not start its local engine.\n\n\
         This usually means the bundled Node runtime was blocked by antivirus or a Windows \
         Application Control policy, or the port could not be opened.\n\n\
         {log_line}\n\n\
         Click Retry to try starting the engine again, or Cancel to close StarNet."
    );
    let to_wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let text = to_wide(&body);
    let caption = to_wide("StarNet — startup failed");
    // SYSTEMMODAL + SETFOREGROUND so the box is seen even though the main window isn't up yet.
    let result = unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_RETRYCANCEL | MB_ICONERROR | MB_SETFOREGROUND | MB_SYSTEMMODAL,
        )
    };
    result == IDRETRY
}

#[cfg(not(windows))]
fn show_startup_failure_dialog(startup_log: &Option<PathBuf>) -> bool {
    log_startup(
        startup_log,
        "startup failed: sidecar did not come up and no native dialog is wired on this platform",
    );
    eprintln!("[starnet] startup failed: sidecar did not come up (see startup.log)");
    false
}

/// Spawn the sidecar and, if it fails to come up, loop showing the startup-failure dialog so the
/// user can Retry (audit 0.2). Bounded so a persistently-blocked node can't spin a dialog forever:
/// after the retries are exhausted we return `false` and let the guardian keep trying in the
/// background. Returns `true` once the sidecar is listening.
fn spawn_sidecar_with_retry(state: &AppState) -> bool {
    // A handful of user-driven retries at startup; the long-lived guardian covers the rest.
    for _ in 0..5 {
        if spawn_sidecar(state) {
            return true;
        }
        if !show_startup_failure_dialog(&state.startup_log) {
            // User chose Cancel — stop prompting; the guardian may still recover it silently.
            return false;
        }
        log_startup(
            &state.startup_log,
            "startup: user chose Retry — respawning sidecar",
        );
    }
    log_startup(
        &state.startup_log,
        "startup: retries exhausted; leaving recovery to the guardian",
    );
    false
}

// ---- watchdog: respawn a crashed sidecar so the open window keeps working ----
//
// If the sidecar node process exits unexpectedly (crash, OOM), the open page silently loses its
// backend and every /api/* fetch starts failing. One long-lived guardian thread polls the child
// every ~3s and, on an unexpected exit, respawns it on the same loopback port so the page can
// reconnect. `shutting_down` gates the respawn: it is flipped true at intentional quit BEFORE
// `kill_sidecar` runs, so killing the child during exit never races into a respawn.
//
// NOTE: system sleep is held off separately via the keep_awake command path (PowerCreateRequest);
// the watchdog does not touch power state.
fn spawn_guardian(app: AppHandle) {
    std::thread::spawn(move || {
        // Tracks consecutive failed respawns while the sidecar is absent so we back off instead of
        // hammering a permanently-blocked node (audit 0.2: recover even from the None state, but
        // bounded). Reset to 0 whenever the sidecar is confirmed alive.
        let mut consecutive_failures: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_secs(3));
            let Some(state) = app.try_state::<AppState>() else {
                continue;
            };
            let st: &AppState = state.inner();
            if st.shutting_down.load(Ordering::SeqCst) {
                break;
            }
            if st.recovery_in_progress.load(Ordering::SeqCst) {
                continue;
            }

            // Decide under the lock, respawn after releasing it — spawn_sidecar takes the same lock
            // itself, so respawning while holding it would deadlock. `needs_respawn` covers TWO cases:
            //   (a) a child exists but has exited unexpectedly (crash/OOM), and
            //   (b) NO child exists at all — the initial spawn never succeeded (e.g. AV-blocked node).
            // Case (b) is the audit-0.2 fix: previously the guardian only ever healed (a), so a
            // first-run spawn failure left the app permanently dead with no background recovery.
            let mut needs_respawn = false;
            let mut from_none = false;
            if let Ok(mut guard) = st.sidecar.lock() {
                match guard.as_mut() {
                    Some(child) => {
                        if let Ok(Some(_status)) = child.try_wait() {
                            needs_respawn = true; // (a) crashed
                        } else {
                            consecutive_failures = 0; // alive and running
                        }
                    }
                    None => {
                        needs_respawn = true; // (b) never came up
                        from_none = true;
                    }
                }
            }
            if needs_respawn {
                // Re-check the flag: an intentional quit may have landed between the poll and now.
                if st.shutting_down.load(Ordering::SeqCst) {
                    break;
                }
                // Back off the never-came-up case: after a few quick tries, poll far less often so a
                // genuinely blocked node doesn't burn a core. A crash-respawn (Some, exited) always
                // gets an immediate attempt — that path had a working node moments ago.
                if from_none && consecutive_failures >= 5 {
                    // Slow path: ~30s between attempts once we've clearly failed to launch repeatedly.
                    if consecutive_failures % 10 != 0 {
                        consecutive_failures = consecutive_failures.saturating_add(1);
                        continue;
                    }
                }
                log_startup(
                    &st.startup_log,
                    if from_none {
                        "watchdog: sidecar never came up — attempting respawn"
                    } else {
                        "watchdog: sidecar exited unexpectedly — respawning"
                    },
                );
                if spawn_sidecar(st) {
                    consecutive_failures = 0;
                } else {
                    consecutive_failures = consecutive_failures.saturating_add(1);
                }
            }
        }
    });
}

/// Push the live provider config to the already-running sidecar (no restart). The JSON body is
/// authenticated by the per-launch IPC token. Blocks until the sidecar acks, so the config is live
/// before the caller proceeds to a run.
fn push_provider_config(
    state: &AppState,
    provider: &str,
    key: Option<&str>,
    base_url: Option<&str>,
) -> Result<(), String> {
    let mut payload = serde_json::Map::new();
    payload.insert(
        "provider".to_string(),
        serde_json::Value::String(normalize_provider(provider).to_string()),
    );
    if let Some(key) = key {
        payload.insert(
            "key".to_string(),
            serde_json::Value::String(key.trim().to_string()),
        );
    }
    if let Some(base_url) = base_url {
        payload.insert(
            "baseUrl".to_string(),
            serde_json::Value::String(base_url.trim().to_string()),
        );
    }
    let body = serde_json::Value::Object(payload).to_string();
    post_sidecar_json(state, "/api/key", &body, "provider configuration")
}

fn push_key(state: &AppState, key: &str) -> Result<(), String> {
    push_provider_config(state, "openrouter", Some(key), None)
}

fn push_provider_key_pool(state: &AppState, provider: &str, keys: &[String]) -> Result<(), String> {
    let body = serde_json::json!({
        "provider": normalize_provider(provider),
        "keyPool": keys,
    })
    .to_string();
    post_sidecar_json(state, "/api/key", &body, "provider key pool")
}

fn parse_sidecar_status(response: &[u8]) -> Result<u16, String> {
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "incomplete HTTP acknowledgement".to_string())?;
    let head = std::str::from_utf8(&response[..header_end])
        .map_err(|_| "non-UTF-8 HTTP acknowledgement".to_string())?;
    let line = head
        .lines()
        .next()
        .ok_or_else(|| "empty HTTP acknowledgement".to_string())?;
    let mut parts = line.split_whitespace();
    let version = parts.next().unwrap_or("");
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return Err(format!("invalid HTTP acknowledgement: {line}"));
    }
    parts
        .next()
        .ok_or_else(|| format!("missing HTTP status: {line}"))?
        .parse::<u16>()
        .map_err(|_| format!("invalid HTTP status: {line}"))
}

/// Send one authenticated JSON mutation and wait for a complete, bounded HTTP response head. TCP reads are not
/// message-framed: a successful status line may arrive in several packets, so one small read cannot prove an ack.
fn post_sidecar_json(
    state: &AppState,
    path: &str,
    body: &str,
    operation: &str,
) -> Result<(), String> {
    use std::io::Write;
    const MAX_RESPONSE_HEAD: usize = 8192;
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Skynet-Token: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        state.ipc_token,
        body.as_bytes().len()
    );
    let mut s = TcpStream::connect(("127.0.0.1", state.port))
        .map_err(|e| format!("sidecar {operation} connect failed: {e}"))?;
    s.set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| format!("sidecar {operation} read-timeout setup failed: {e}"))?;
    s.set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| format!("sidecar {operation} write-timeout setup failed: {e}"))?;
    s.write_all(head.as_bytes())
        .map_err(|e| format!("sidecar {operation} header failed: {e}"))?;
    s.write_all(body.as_bytes())
        .map_err(|e| format!("sidecar {operation} body failed: {e}"))?;
    s.flush()
        .map_err(|e| format!("sidecar {operation} flush failed: {e}"))?;

    let mut response = Vec::with_capacity(512);
    let mut chunk = [0u8; 512];
    while !response.windows(4).any(|window| window == b"\r\n\r\n") {
        let n = s
            .read(&mut chunk)
            .map_err(|e| format!("sidecar {operation} acknowledgement failed: {e}"))?;
        if n == 0 {
            break;
        }
        if response.len() + n > MAX_RESPONSE_HEAD {
            return Err(format!(
                "sidecar {operation} acknowledgement exceeded {MAX_RESPONSE_HEAD} bytes"
            ));
        }
        response.extend_from_slice(&chunk[..n]);
    }
    let status = parse_sidecar_status(&response)
        .map_err(|e| format!("sidecar {operation} acknowledgement invalid: {e}"))?;
    if status == 200 {
        Ok(())
    } else {
        Err(format!("sidecar rejected {operation}: HTTP {status}"))
    }
}

#[cfg(test)]
mod sidecar_ack_tests {
    use super::*;

    #[test]
    fn parses_complete_http_status_after_arbitrary_headers() {
        assert_eq!(
            parse_sidecar_status(b"HTTP/1.1 200 OK\r\nX-Long: value\r\n\r\n").unwrap(),
            200
        );
        assert_eq!(
            parse_sidecar_status(b"HTTP/1.0 409 Conflict\r\n\r\n").unwrap(),
            409
        );
    }

    #[test]
    fn rejects_partial_or_malformed_acknowledgements() {
        assert!(parse_sidecar_status(b"HTTP/1.1 200 OK\r\nX-Part: yes\r\n").is_err());
        assert!(parse_sidecar_status(b"NOTHTTP 200 OK\r\n\r\n").is_err());
        assert!(parse_sidecar_status(b"HTTP/1.1 nope\r\n\r\n").is_err());
    }
}

/// Push a channel bot token to the already-running sidecar (no restart), authenticated by the per-launch IPC
/// token — mirrors push_provider_config. An empty token clears it on the sidecar.
fn push_channel_token(state: &AppState, channel: &str, token: &str) {
    use std::io::{Read, Write};
    let mut payload = serde_json::Map::new();
    payload.insert(
        "channel".to_string(),
        serde_json::Value::String(channel.to_string()),
    );
    payload.insert(
        "token".to_string(),
        serde_json::Value::String(token.trim().to_string()),
    );
    let body = serde_json::Value::Object(payload).to_string();
    let head = format!(
        "POST /api/channels/token HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Skynet-Token: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        state.ipc_token,
        body.as_bytes().len()
    );
    if let Ok(mut s) = TcpStream::connect(("127.0.0.1", state.port)) {
        let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = s.write_all(head.as_bytes());
        let _ = s.write_all(body.as_bytes());
        let _ = s.flush();
        let mut buf = [0u8; 64];
        let _ = s.read(&mut buf); // wait for the 200 ack before returning
    }
}

// ---- Lane 4D: supervised background lifecycle (tray + close-to-tray + bounded drain) ----
//
// The tray owns the ONE sidecar's visibility contract: closing the window keeps the station running ONLY when
// the sidecar proves armed work exists (GET /api/lifecycle/armed), and that state is explicit in the tray. If
// nothing is armed, window-close = full quit (drain + kill + app.exit) — no hidden daemon. Every decision reads
// LIVE sidecar truth; a poll failure degrades to "not armed" (a dead sidecar can't be doing background work, so
// a full quit is the safe + honest choice).

/// The classified outcome of one lifecycle poll. The DISTINCTION matters for the close decision (M2):
/// a refused TCP connect proves no sidecar is listening — nothing armed can exist, quitting is safe. But a
/// connect that SUCCEEDS and then times out / returns garbage means the sidecar is ALIVE but slow or unwell —
/// killing it on that evidence could destroy armed background work, so those cases must fail OPEN (keep the
/// process; the tray keeps polling until the status recovers).
enum LifecycleProbe {
    /// TCP connect failed — no sidecar is listening on the port. Safe to fully quit.
    NotRunning,
    /// Connect succeeded but the poll didn't produce a valid 200 snapshot (read timeout, non-200, malformed
    /// body). The sidecar is alive; its armed state is UNKNOWN — never treat this as "not armed".
    Ambiguous,
    /// A valid 200 snapshot — the sidecar's own truthful account.
    Armed(LifecycleArmed),
}

/// Decode an HTTP/1.1 chunk-framed body (`<hex-size>\r\n<bytes>\r\n … 0\r\n\r\n`) into its payload.
/// None = the framing is malformed or the read stopped mid-chunk (a timeout's partial body must
/// never parse as a complete snapshot). Byte-wise so a multi-byte character can never panic a slice.
fn decode_chunked_body(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::new();
    let mut pos = 0usize;
    loop {
        let line_end = bytes[pos..].windows(2).position(|w| w == b"\r\n")? + pos;
        let size_str = std::str::from_utf8(&bytes[pos..line_end]).ok()?;
        let size = usize::from_str_radix(size_str.trim().split(';').next()?.trim(), 16).ok()?;
        if size == 0 {
            return Some(String::from_utf8_lossy(&out).into_owned());
        }
        let start = line_end + 2;
        let end = start.checked_add(size)?;
        if end > bytes.len() {
            return None;
        }
        out.extend_from_slice(&bytes[start..end]);
        pos = if bytes[end..].starts_with(b"\r\n") { end + 2 } else { end };
    }
}

/// Pure parser for the raw HTTP response text of GET /api/lifecycle/armed. None = not a valid 200 snapshot
/// (callers classify that as Ambiguous). Kept side-effect-free so it is unit-testable (M3).
fn parse_lifecycle_response(text: &str) -> Option<LifecycleArmed> {
    // Status line must be 200; the body is the JSON after the header/body blank line.
    let status_line = text.lines().next().unwrap_or("");
    if !status_line.contains(" 200 ") {
        return None;
    }
    let (head, raw_body) = text.split_once("\r\n\r\n")?;
    // Node's http server answers an HTTP/1.1 request with `Transfer-Encoding: chunked` unless the
    // handler sets an explicit Content-Length. Feeding the chunk framing straight to the JSON
    // parser rejected EVERY live snapshot as Ambiguous — so window-close always failed open into
    // the tray and left an unopenable background process (the 0.10.x zombie). Dechunk first.
    let body = if head.lines().any(|l| {
        let lower = l.to_ascii_lowercase();
        lower.starts_with("transfer-encoding:") && lower.contains("chunked")
    }) {
        decode_chunked_body(raw_body)?
    } else {
        raw_body.to_string()
    };
    let json: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
    // `armed` must be PRESENT and boolean — a 200 without it is not our snapshot (never default to false
    // here: the caller would translate that into "safe to kill").
    let armed = json.get("armed").and_then(|v| v.as_bool())?;
    let reasons = json
        .get("reasons")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Some(LifecycleArmed { armed, reasons })
}

/// Blocking poll of GET /api/lifecycle/armed, classified per LifecycleProbe. Uses the per-launch API token as
/// the X-StarNet-Token header (the same gate the frontend fetches use); no Origin header (absent Origin is
/// allowed for loopback callers).
fn probe_lifecycle_armed(port: u16, api_token: &str, timeout: Duration) -> LifecycleProbe {
    use std::io::{Read, Write};
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return LifecycleProbe::NotRunning;
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let head = format!(
        "GET /api/lifecycle/armed HTTP/1.1\r\nHost: 127.0.0.1\r\nX-StarNet-Token: {api_token}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(head.as_bytes()).is_err() || stream.flush().is_err() {
        return LifecycleProbe::Ambiguous; // connected, then failed — alive but unwell
    }
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw); // a timeout mid-read still yields what arrived; parse decides
    let text = String::from_utf8_lossy(&raw);
    match parse_lifecycle_response(&text) {
        Some(l) => LifecycleProbe::Armed(l),
        None => LifecycleProbe::Ambiguous,
    }
}

/// Back-compat convenience for surfaces that only need the snapshot when one is available (the frontend
/// status command). The close decision must NOT use this — it needs the full classification above.
fn query_lifecycle_armed(port: u16, api_token: &str, timeout: Duration) -> Option<LifecycleArmed> {
    match probe_lifecycle_armed(port, api_token, timeout) {
        LifecycleProbe::Armed(l) => Some(l),
        _ => None,
    }
}

/// POST /api/halt (the E-STOP) to the running sidecar, bounded by `timeout`. Aborts every in-flight run,
/// releases the cron lock, and reaps backend-owned background processes — so no unattended spend outlives the
/// action. Best-effort: a dead sidecar or timeout is a no-op (nothing to halt). API-token guarded like the UI.
fn post_sidecar_halt(state: &AppState, timeout: Duration) {
    use std::io::{Read, Write};
    let body = "{}";
    let head = format!(
        "POST /api/halt HTTP/1.1\r\nHost: 127.0.0.1\r\nX-StarNet-Token: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        state.api_token,
        body.len()
    );
    if let Ok(mut s) = TcpStream::connect(("127.0.0.1", state.port)) {
        let _ = s.set_read_timeout(Some(timeout));
        let _ = s.set_write_timeout(Some(timeout));
        let _ = s.write_all(head.as_bytes());
        let _ = s.write_all(body.as_bytes());
        let _ = s.flush();
        let mut buf = [0u8; 64];
        let _ = s.read(&mut buf);
    }
}

/// Bounded drain, then kill: flip `shutting_down` so the guardian never respawns, ask the sidecar to halt all
/// in-flight work (bounded), then terminate the child. The halt gives unattended runs a clean stop before the
/// process dies; the kill guarantees no orphan sidecar outlives an explicit Quit.
fn drain_and_kill_sidecar(state: &AppState) {
    state.shutting_down.store(true, Ordering::SeqCst);
    post_sidecar_halt(state, Duration::from_secs(3));
    state.kill_sidecar();
}

/// Finish a close decision whose outcome is "keep the supervised process alive in the tray".
/// Two invariants make tray residency honest:
///   1. `close_exit_pending` is cleared — the decision is made, so the one-shot veto must not
///      linger and swallow a later, unrelated exit request.
///   2. The `main` webview window must still exist: every reveal path (tray Open, a second
///      launch's single-instance signal) addresses `get_webview_window("main")`. If the window
///      was destroyed, "residency" would be an unrevealable background process the user can only
///      end from Task Manager — so full-quit instead. The tray must never claim an Open it
///      cannot perform.
fn stay_resident_or_quit(app: &AppHandle, st: &AppState, why: &str) {
    st.close_exit_pending.store(false, Ordering::SeqCst);
    if app.get_webview_window("main").is_some() {
        log_startup(
            &st.startup_log,
            format!("close-request: staying resident ({why})"),
        );
        return;
    }
    log_startup(
        &st.startup_log,
        format!("close-request: {why}, but the main window is gone — unrevealable residency; quitting fully"),
    );
    drain_and_kill_sidecar(st);
    app.exit(0);
}

/// Reveal + focus the main window (from a hidden/close-to-tray state or a minimized one).
fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn lifecycle_preferences_snapshot(state: &AppState) -> LifecyclePreferences {
    match state.lifecycle_preferences.lock() {
        Ok(value) => value.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

fn update_lifecycle_preferences(
    state: &AppState,
    update: impl FnOnce(&mut LifecyclePreferences),
) -> Result<LifecyclePreferences, String> {
    let mut current = state
        .lifecycle_preferences
        .lock()
        .map_err(|_| "lifecycle preferences are temporarily unavailable".to_string())?;
    let mut next = current.clone();
    update(&mut next);
    save_lifecycle_preferences(&state.lifecycle_preferences_path, &next)?;
    *current = next.clone();
    Ok(next)
}

/// Tray menu dispatch. Open reveals the window; Pause Automation fires the E-STOP so background work stops even
/// with the window closed; Quit drains + kills the sidecar and exits the app (no daemon left behind).
/// Pause/Quit run their bounded network work on a worker thread — tray menu events arrive on the main loop and
/// a multi-second drain there would freeze the app (review m1).
fn on_tray_menu(app: &AppHandle, id: &str) {
    match id {
        "lifecycle_open" => show_main_window(app),
        "lifecycle_pause" => {
            let app2 = app.clone();
            std::thread::spawn(move || {
                if let Some(state) = app2.try_state::<AppState>() {
                    post_sidecar_halt(state.inner(), Duration::from_secs(3));
                }
            });
        }
        "lifecycle_quit" => {
            let app2 = app.clone();
            std::thread::spawn(move || {
                if let Some(state) = app2.try_state::<AppState>() {
                    drain_and_kill_sidecar(state.inner());
                }
                app2.exit(0);
            });
        }
        _ => {}
    }
}

/// Background thread keeping the tray tooltip + status line HONEST: every few seconds it re-polls the sidecar's
/// armed truth and re-renders the tray. When idle it says so ("closing quits"); when armed it lists the real
/// reasons. Stops when the app is shutting down. A poll failure renders the idle/unknown state, never a stale
/// "still working" claim.
fn spawn_tray_updater(app: AppHandle) {
    std::thread::spawn(move || loop {
        // Poll FIRST, sleep after (review m2): the menu is built with a non-committal "checking…" line, and an
        // immediate first poll replaces it with real state before a user can plausibly open the tray — the tray
        // must never assert a stale claim.
        if let Some(state) = app.try_state::<AppState>() {
            if state.shutting_down.load(Ordering::SeqCst) {
                break;
            }
            let close_to_tray = lifecycle_preferences_snapshot(state.inner()).close_to_tray;
            let probe =
                probe_lifecycle_armed(state.port, &state.api_token, Duration::from_millis(1500));
            let (tooltip, status_text) = match probe {
                LifecycleProbe::Armed(l) if l.armed => {
                    let summary = if l.reasons.is_empty() {
                        "running in the background".to_string()
                    } else {
                        l.reasons.join(", ")
                    };
                    (
                        format!("StarNet — {summary}"),
                        format!("Background: {summary}"),
                    )
                }
                LifecycleProbe::Armed(_) if close_to_tray => (
                    "StarNet — idle in tray".to_string(),
                    "Background: idle — close keeps StarNet running".to_string(),
                ),
                LifecycleProbe::NotRunning if close_to_tray => (
                    "StarNet — engine offline (kept in tray)".to_string(),
                    "Background: engine offline — close keeps StarNet running".to_string(),
                ),
                LifecycleProbe::Armed(_) | LifecycleProbe::NotRunning => (
                    // Nothing armed (or no engine at all): closing quits — the same rule the close path applies.
                    "StarNet — idle (closing quits)".to_string(),
                    "Background: idle — closing quits".to_string(),
                ),
                LifecycleProbe::Ambiguous => (
                    // Alive but the poll failed — honest "unknown", mirroring the close path's fail-open.
                    "StarNet — status unavailable (close keeps it running)".to_string(),
                    "Background: status unavailable — close keeps it running".to_string(),
                ),
            };
            if let Some(tray) = app.tray_by_id("starnet-tray") {
                let _ = tray.set_tooltip(Some(tooltip.as_str()));
            }
            if let Some(handles) = app.try_state::<TrayHandles>() {
                let _ = handles.status.set_text(status_text.as_str());
            }
        }
        std::thread::sleep(Duration::from_secs(4));
    });
}

// ---- Tauri commands (called from the frontend Harness seam) ----

/// Store (or, for an empty value, clear) the BYOK key in the OS keychain, then push it
/// to the running sidecar — no restart, so the current page is never disrupted.
#[tauri::command]
fn harness_store_key(key: String, state: State<AppState>) -> Result<(), String> {
    let entry = keychain_entry().map_err(|e| e.to_string())?;
    let previous = entry.get_password().ok().filter(|v| !v.trim().is_empty());
    let trimmed = key.trim();
    if trimmed.is_empty() {
        delete_credential_honest(&entry)?;
    } else {
        entry.set_password(trimmed).map_err(|e| e.to_string())?;
    }
    if let Err(e) = push_key(&state, trimmed) {
        let mut failures = Vec::new();
        if let Err(restore) = restore_credential(&entry, previous.as_deref()) {
            failures.push(format!("keychain restore failed: {restore}"));
        }
        if let Err(restore) = push_key(&state, previous.as_deref().unwrap_or("")) {
            failures.push(format!("sidecar restore failed: {restore}"));
        }
        return Err(rollback_error(e, failures));
    }
    Ok(())
}

/// Store/clear the key for one provider and optionally update its runtime base URL.
/// The key never returns to the WebView; only configured booleans do.
#[tauri::command]
fn harness_store_provider_key(
    provider: String,
    key: Option<String>,
    base_url: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    let provider_id = normalize_provider(&provider);
    let key_trimmed = key.as_ref().map(|k| k.trim().to_string());
    let mut rollback: Option<(keyring::Entry, Option<String>)> = None;
    if let Some(ref key_value) = key_trimmed {
        // codex + the device-OAuth providers (grok/kimi) authenticate by OAuth token (sidecar-owned), not a
        // keychain API key; ollama is keyless. None of them get a keychain entry.
        if provider_id != "codex"
            && provider_id != "ollama"
            && provider_id != "grok"
            && provider_id != "kimi"
        {
            let entry = keychain_entry_for(provider_id).map_err(|e| e.to_string())?;
            let previous = entry.get_password().ok().filter(|v| !v.trim().is_empty());
            if key_value.is_empty() {
                delete_credential_honest(&entry)?;
            } else {
                entry.set_password(key_value).map_err(|e| e.to_string())?;
            }
            rollback = Some((entry, previous));
        }
    }
    let base_trimmed = base_url.as_ref().map(|u| u.trim().to_string());
    if let Err(e) = push_provider_config(
        &state,
        provider_id,
        key_trimmed.as_deref(),
        base_trimmed.as_deref(),
    ) {
        if let Some((entry, previous)) = rollback {
            let mut failures = Vec::new();
            if let Err(restore) = restore_credential(&entry, previous.as_deref()) {
                failures.push(format!("keychain restore failed: {restore}"));
            }
            if let Err(restore) = push_provider_config(
                &state,
                provider_id,
                Some(previous.as_deref().unwrap_or("")),
                None,
            ) {
                failures.push(format!("sidecar restore failed: {restore}"));
            }
            return Err(rollback_error(e, failures));
        }
        return Err(e);
    }
    Ok(())
}

/// Replace the complete alternate-key pool for exactly one provider. The old keychain value and live sidecar
/// pool restoration is attempted if the live update cannot be acknowledged; any incomplete rollback is reported.
#[tauri::command]
fn harness_store_provider_key_pool(
    provider: String,
    keys: Vec<String>,
    state: State<AppState>,
) -> Result<usize, String> {
    let provider_id = normalize_provider(&provider);
    if !KEYCHAIN_PROVIDERS.contains(&provider_id) {
        return Err("this provider does not support alternate API keys".to_string());
    }
    let mut cleaned: Vec<String> = Vec::new();
    for key in keys {
        let trimmed = key.trim().to_string();
        if !trimmed.is_empty() && !cleaned.contains(&trimmed) {
            cleaned.push(trimmed);
        }
        if cleaned.len() == 8 {
            break;
        }
    }
    let entry = keychain_pool_entry_for(provider_id).map_err(|e| e.to_string())?;
    let previous_raw = entry.get_password().ok();
    let previous = read_key_pool_for(provider_id);
    if cleaned.is_empty() {
        delete_credential_honest(&entry)?;
    } else {
        let encoded = serde_json::to_string(&cleaned).map_err(|e| e.to_string())?;
        entry.set_password(&encoded).map_err(|e| e.to_string())?;
    }
    if let Err(e) = push_provider_key_pool(&state, provider_id, &cleaned) {
        let mut failures = Vec::new();
        if let Err(restore) = restore_credential(&entry, previous_raw.as_deref()) {
            failures.push(format!("keychain restore failed: {restore}"));
        }
        if let Err(restore) = push_provider_key_pool(&state, provider_id, &previous) {
            failures.push(format!("sidecar restore failed: {restore}"));
        }
        return Err(rollback_error(e, failures));
    }
    Ok(cleaned.len())
}

/// Whether a BYOK key is configured — never returns the value itself.
#[tauri::command]
fn harness_has_key() -> bool {
    read_key().is_some()
}

#[tauri::command]
fn harness_has_provider_key(provider: String) -> bool {
    read_key_for(normalize_provider(&provider)).is_some()
}

#[tauri::command]
fn harness_provider_key_status() -> Vec<ProviderKeyStatus> {
    KEYCHAIN_PROVIDERS
        .iter()
        .map(|provider| ProviderKeyStatus {
            provider: provider.to_string(),
            configured: read_key_for(provider).is_some(),
            alternate_count: read_key_pool_for(provider).len(),
        })
        .collect()
}

/// Remove the BYOK key from the keychain and clear it on the running sidecar.
#[tauri::command]
fn harness_clear_key(state: State<AppState>) -> Result<(), String> {
    if let Ok(entry) = keychain_entry() {
        let _ = entry.delete_credential();
    }
    push_key(&state, "")?;
    Ok(())
}

/// Adopt a freshly linked station's device token into the OS keychain and strip it from
/// `.secrets/credits.json`. Called by the UI right after a successful link.
///
/// **The token never enters the WebView.** The UI only says "a link just happened"; Rust reads the
/// file, moves the secret, and rewrites the file. That preserves the property the sidecar already
/// guarantees — the device token never leaves the backend — which storing it from JavaScript would
/// have thrown away.
///
/// Returns whether the keychain now holds a token, so the caller can report the truth rather than
/// assume success (a locked keychain leaves the token on disk, by design).
#[tauri::command]
fn harness_adopt_credits_token(state: State<AppState>) -> bool {
    migrate_credits_token_from_plaintext(&state.workspaces)
}

/// Whether a device token is in the keychain. Never returns the token itself.
#[tauri::command]
fn harness_has_credits_token() -> bool {
    read_credits_token().is_some()
}

/// Forget the device token (UNLINK). Deletion failures surface as Err so the UI can never claim
/// "unlinked" while a money-spending credential is still in the keychain — truthful telemetry
/// applies to destruction too. Safe under the secret-durability law: relinking mints a new token.
#[tauri::command]
fn harness_clear_credits_token() -> Result<(), String> {
    let entry = credits_keychain_entry().map_err(|e| e.to_string())?;
    delete_credential_honest(&entry)
}

/// Store (or, for an empty value, clear) a channel bot token in the OS keychain, then push it to the running
/// sidecar — no restart, so the current page is never disrupted. The token never returns to the WebView.
#[tauri::command]
fn harness_store_channel_token(
    channel: String,
    token: String,
    state: State<AppState>,
) -> Result<(), String> {
    let channel = channel.trim().to_ascii_lowercase();
    let trimmed = token.trim();
    if !is_known_channel(&channel) {
        // Clearing (empty token) a channel this shell never keychains is vacuously done — nothing was ever
        // stored under its namespace, so FORGET must not report a phantom keychain failure for it. STORING
        // a token for an unknown channel stays an error (defends the keychain account namespace).
        if trimmed.is_empty() {
            return Ok(());
        }
        return Err(format!("unknown channel: {channel}"));
    }
    let entry = channel_keychain_entry(&channel).map_err(|e| e.to_string())?;
    if trimmed.is_empty() {
        // FORGET path: a swallowed deletion failure here let the UI claim "purged" while the token
        // survived in the OS keychain. A real failure now surfaces to the caller (NoEntry is fine).
        delete_credential_honest(&entry)?;
    } else {
        entry.set_password(trimmed).map_err(|e| e.to_string())?;
    }
    push_channel_token(&state, &channel, trimmed);
    Ok(())
}

/// Whether a channel bot token is configured in the keychain — never returns the value itself.
#[tauri::command]
fn harness_has_channel_token(channel: String) -> bool {
    let channel = channel.trim().to_ascii_lowercase();
    is_known_channel(&channel) && read_channel_token(&channel).is_some()
}

fn path_is_within(path: &Path, root: &Path) -> bool {
    let path = strip_verbatim(path);
    let root = strip_verbatim(root);
    #[cfg(windows)]
    {
        let path = path.to_string_lossy().to_lowercase();
        let root = root.to_string_lossy().to_lowercase();
        path == root || path.starts_with(&(root + "\\"))
    }
    #[cfg(not(windows))]
    {
        path == root || path.starts_with(&root)
    }
}

fn artifact_path_hits_hard_floor(path: &Path) -> bool {
    path.components().any(|component| {
        let value = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        value == ".git" || value == ".env" || value.starts_with(".env.")
    })
}

fn artifact_roots(workspaces: &Path) -> Vec<PathBuf> {
    let mut roots = vec![workspaces.to_path_buf()];
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    if let Some(home) = home {
        roots.push(home);
    }

    // The workspace and home roots cover agent-owned files plus user-chosen local output
    // folders. Standing path:<root> grants extend that set to trusted projects or drives.
    // Read the same secret-free allowlist the sidecar owns so those deliverables can still
    // be opened from COMMS. A missing/torn file contributes no extra roots: fail closed.
    let allow_file = workspaces.join("permissions.allow.json");
    if let Ok(raw) = std::fs::read_to_string(allow_file) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(rows) = value.get("allow").and_then(|row| row.as_array()) {
                for row in rows.iter().filter_map(|row| row.as_str()) {
                    if let Some(root) = row.strip_prefix("path:") {
                        if !root.trim().is_empty() {
                            roots.push(PathBuf::from(root));
                        }
                    }
                }
            }
        }
    }
    roots
}

fn resolve_artifact_path(
    workspaces: &Path,
    agent_id: Option<&str>,
    raw_path: &str,
) -> Result<PathBuf, String> {
    let raw = raw_path.trim();
    if raw.is_empty() || raw.contains('\0') {
        return Err("artifact path is empty or invalid".to_string());
    }
    if raw.starts_with("\\\\") || raw.starts_with("//") {
        return Err("network artifact paths are not supported".to_string());
    }

    let supplied = PathBuf::from(raw);
    let supplied_is_absolute = supplied.is_absolute();
    let relative_root;
    let candidate = if supplied_is_absolute {
        relative_root = None;
        supplied
    } else {
        let agent = agent_id.unwrap_or("agent");
        if !agent
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
            || agent.is_empty()
            || agent.len() > 40
        {
            return Err("invalid artifact owner".to_string());
        }
        let root = workspaces.join(agent);
        relative_root = Some(root.clone());
        root.join(supplied)
    };
    if artifact_path_hits_hard_floor(&candidate) {
        return Err("protected station paths cannot be opened".to_string());
    }

    let canonical = std::fs::canonicalize(&candidate)
        .map(|path| strip_verbatim(&path))
        .map_err(|_| "the saved artifact no longer exists".to_string())?;
    if artifact_path_hits_hard_floor(&canonical) {
        return Err("protected station paths cannot be opened".to_string());
    }

    let mut allowed = false;
    if let Some(root) = relative_root {
        if let Ok(root) = std::fs::canonicalize(root).map(|path| strip_verbatim(&path)) {
            allowed = path_is_within(&canonical, &root);
        }
    } else {
        for root in artifact_roots(workspaces) {
            if let Ok(root) = std::fs::canonicalize(root).map(|path| strip_verbatim(&path)) {
                if path_is_within(&canonical, &root) {
                    allowed = true;
                    break;
                }
            }
        }
    }
    if !allowed {
        return Err("artifact is outside the station workspace and trusted folders".to_string());
    }
    Ok(canonical)
}

fn safe_native_artifact_extension(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "md" | "markdown"
            | "txt"
            | "rst"
            | "pdf"
            | "csv"
            | "tsv"
            | "json"
            | "yaml"
            | "yml"
            | "doc"
            | "docx"
            | "xls"
            | "xlsx"
            | "ppt"
            | "pptx"
            | "odt"
            | "ods"
            | "odp"
            | "rtf"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
            | "svg"
            | "mp3"
            | "m4a"
            | "ogg"
            | "wav"
            | "flac"
            | "opus"
            | "mp4"
            | "webm"
            | "mov"
            | "mkv"
            | "avi"
    )
}

/// Marker the frontend keys off to tell "the user said no at the native prompt" apart from
/// a real failure (a declined open must NOT trigger the browser-preview fallback).
const HOST_GESTURE_DECLINED: &str = "declined at the host confirmation";

/// Host-boundary human gesture (docs/MISTAKES.md law: "a token, renderer IPC call, or tool
/// annotation is not a human gesture"). Every renderer-callable OS-launch command must obtain
/// an exact, one-shot, NON-CACHEABLE confirmation from a blocking native dialog that names
/// the canonical resolved path and the action, minted by the host at the moment of the call.
/// Nothing is remembered between calls — the next launch asks again. This is an ADDITIONAL
/// gate on top of the path jail and the non-executable extension allowlist, never a
/// replacement for them.
///
/// Must be called off the main thread (Tauri v2 dialogs dispatch to the main thread and
/// block the caller) — both callers are `async` commands, which run on the async runtime.
fn confirm_host_launch(app: &tauri::AppHandle, title: &str, body: &str, verb: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    app.dialog()
        .message(body)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            verb.to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show()
}

/// Open a proven, non-executable deliverable with the user's OS file association. The
/// renderer supplies the artifact identity, not an unrestricted command: this re-resolves
/// relative paths beneath the owning agent workspace, canonicalizes symlinks, and accepts
/// absolute paths only beneath the user's home or a standing trusted-project root.
/// The spawn itself is gated behind a blocking native host dialog naming the exact resolved
/// path — renderer clicks are not host gestures, and the answer is never cached.
/// `async` so the blocking dialog runs on the async runtime, not the main thread.
#[tauri::command]
async fn starnet_open_artifact(
    path: String,
    agent_id: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let artifact = resolve_artifact_path(&state.workspaces, agent_id.as_deref(), &path)?;
    if !artifact.is_file() {
        return Err("that artifact is not a file".to_string());
    }
    if !safe_native_artifact_extension(&artifact) {
        return Err("that file type stays in the station preview for safety".to_string());
    }
    let body = format!(
        "Open this file with its system default app?\n\n{}",
        artifact.display()
    );
    if !confirm_host_launch(&app, "StarNet — open file", &body, "Open") {
        return Err(format!("open {HOST_GESTURE_DECLINED}"));
    }

    #[cfg(windows)]
    Command::new("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(&artifact)
        .spawn()
        .map_err(|e| format!("Failed to open artifact: {e}"))?;

    #[cfg(target_os = "macos")]
    Command::new("open")
        .arg(&artifact)
        .spawn()
        .map_err(|e| format!("Failed to open artifact: {e}"))?;

    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open")
        .arg(&artifact)
        .spawn()
        .map_err(|e| format!("Failed to open artifact: {e}"))?;

    Ok(())
}

/// Reveal a proven deliverable in Explorer/Finder (or open its containing directory on
/// Linux). Directories are opened directly so the existing Workshop "open folder" action
/// uses the same constrained command. Same host-gesture gate as `starnet_open_artifact`:
/// a blocking native dialog names the exact resolved path before anything spawns.
#[tauri::command]
async fn starnet_reveal_path(
    path: String,
    agent_id: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let artifact = resolve_artifact_path(&state.workspaces, agent_id.as_deref(), &path)?;
    let is_dir = artifact.is_dir();
    let body = format!(
        "{} in the system file manager?\n\n{}",
        if is_dir {
            "Open this folder"
        } else {
            "Reveal this file"
        },
        artifact.display()
    );
    if !confirm_host_launch(&app, "StarNet — reveal in folder", &body, "Reveal") {
        return Err(format!("reveal {HOST_GESTURE_DECLINED}"));
    }

    #[cfg(windows)]
    {
        let mut command = Command::new("explorer.exe");
        if is_dir {
            command.arg(&artifact);
        } else {
            command.arg(format!("/select,{}", artifact.display()));
        }
        command
            .spawn()
            .map_err(|e| format!("Failed to reveal artifact: {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if !is_dir {
            command.arg("-R");
        }
        command
            .arg(&artifact)
            .spawn()
            .map_err(|e| format!("Failed to reveal artifact: {e}"))?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open")
        .arg(if is_dir {
            artifact.clone()
        } else {
            artifact
                .parent()
                .map(Path::to_path_buf)
                .ok_or_else(|| "artifact has no containing folder".to_string())?
        })
        .spawn()
        .map_err(|e| format!("Failed to reveal artifact: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod artifact_open_tests {
    use super::{resolve_artifact_path, safe_native_artifact_extension, strip_verbatim};
    use std::path::Path;

    fn temp_root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "starnet-artifact-open-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ))
    }

    #[test]
    fn resolves_only_existing_files_inside_the_owning_agent_workspace() {
        let root = temp_root();
        let workspaces = root.join("workspaces");
        let owned = workspaces.join("nova").join("reports").join("handoff.md");
        let escaped = workspaces.join("outside.md");
        std::fs::create_dir_all(owned.parent().unwrap()).unwrap();
        std::fs::write(&owned, b"handoff").unwrap();
        std::fs::write(&escaped, b"outside").unwrap();

        let resolved = resolve_artifact_path(&workspaces, Some("nova"), "reports/handoff.md")
            .expect("owned deliverable resolves");
        assert_eq!(
            resolved,
            strip_verbatim(&std::fs::canonicalize(&owned).unwrap())
        );
        assert!(resolve_artifact_path(&workspaces, Some("nova"), "../outside.md").is_err());
        assert!(
            resolve_artifact_path(&workspaces, Some("../../bad"), "reports/handoff.md").is_err()
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_protected_and_executable_artifacts() {
        let root = temp_root();
        let workspaces = root.join("workspaces");
        let protected = workspaces.join("nova").join(".env");
        std::fs::create_dir_all(protected.parent().unwrap()).unwrap();
        std::fs::write(&protected, b"secret").unwrap();

        assert!(resolve_artifact_path(&workspaces, Some("nova"), ".env").is_err());
        assert!(safe_native_artifact_extension(Path::new("handoff.md")));
        assert!(!safe_native_artifact_extension(Path::new("installer.exe")));
        assert!(!safe_native_artifact_extension(Path::new("script.ps1")));

        let _ = std::fs::remove_dir_all(root);
    }
}

/// Open an OAuth/device-auth URL in the user's default system browser.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("Only http(s) URLs can be opened externally".to_string());
    }

    #[cfg(windows)]
    {
        Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", trimmed])
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }

    Ok(())
}

/// Windows/tao: set_fullscreen(true) on a MAXIMIZED window keeps the maximized
/// work-area geometry (screen minus taskbar) — a dead strip stays along the bottom
/// and the layout mis-sizes. Remember the maximize across the fullscreen span so
/// exit restores it.
static FS_RESTORE_MAXIMIZE: AtomicBool = AtomicBool::new(false);

/// Toggle the main StarNet desktop window between windowed and fullscreen mode.
#[tauri::command]
fn starnet_toggle_fullscreen(app: AppHandle) -> Result<bool, String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window unavailable".to_string())?;
    let next = !win.is_fullscreen().map_err(|e| e.to_string())?;
    if next {
        let was_max = win.is_maximized().unwrap_or(false);
        FS_RESTORE_MAXIMIZE.store(was_max, Ordering::Relaxed);
        if was_max {
            let _ = win.unmaximize();
        }
    }
    win.set_fullscreen(next).map_err(|e| e.to_string())?;
    if !next && FS_RESTORE_MAXIMIZE.swap(false, Ordering::Relaxed) {
        let _ = win.maximize();
    }
    Ok(next)
}

/// Prevent idle system sleep while StarNet is open. This does not force the
/// display to stay on; it only keeps scheduled tasks from being paused by OS sleep.
#[tauri::command]
fn starnet_set_keep_awake(
    enabled: bool,
    state: State<AppState>,
) -> Result<KeepAwakeStatus, String> {
    state
        .keep_awake
        .lock()
        .map_err(|_| "keep-awake state is unavailable".to_string())?
        .set_enabled(enabled)
}

/// Read the current native keep-awake state without changing the OS assertion.
#[tauri::command]
fn starnet_keep_awake_status(state: State<AppState>) -> Result<KeepAwakeStatus, String> {
    Ok(state
        .keep_awake
        .lock()
        .map_err(|_| "keep-awake state is unavailable".to_string())?
        .status())
}

/// Desktop updater status without hitting the network. The frontend uses this to
/// render the Update Center immediately and decide whether native updates exist.
#[tauri::command]
fn starnet_update_status(
    app: AppHandle,
    pending_update: State<PendingUpdate>,
) -> Result<UpdateStatus, String> {
    let pending = pending_update
        .0
        .lock()
        .map_err(|_| "update state is unavailable".to_string())?
        .as_ref()
        .map(update_metadata);
    Ok(UpdateStatus {
        desktop: true,
        current_version: app.package_info().version.to_string(),
        target: tauri_plugin_updater::target(),
        pending,
    })
}

/// Check the signed release manifest and cache the verified update object if a
/// newer build exists. No install happens until the user asks for it.
#[tauri::command]
async fn starnet_update_check(
    app: AppHandle,
    pending_update: State<'_, PendingUpdate>,
) -> Result<UpdateCheck, String> {
    // WINDOWS UPDATE-HANG FIX (canary-proven 2026-07-14): the NSIS installer the updater
    // launches must overwrite the bundled node.exe — but our sidecar is STILL RUNNING from
    // that same node runtime, so it holds a write lock and NSIS freezes on an "error opening
    // file for writing" dialog forever. The plugin exits via std::process::exit(0), which
    // does NOT fire Tauri's ExitRequested handler where kill_sidecar() normally runs — so
    // without this hook the sidecar is never reaped before the installer touches node.exe.
    // on_before_exit runs immediately before that process exit: stop the guardian respawn and
    // kill the child so node.exe is unlocked when NSIS arrives. The Update object built here
    // carries this hook into the install path (the plugin clones it onto the pending update).
    let app_for_exit = app.clone();
    let update = app
        .updater_builder()
        .on_before_exit(move || {
            if let Some(state) = app_for_exit.try_state::<AppState>() {
                state.shutting_down.store(true, Ordering::SeqCst);
                state.kill_sidecar();
            }
        })
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let metadata = update.as_ref().map(update_metadata);
    *pending_update
        .0
        .lock()
        .map_err(|_| "update state is unavailable".to_string())? = update;
    Ok(UpdateCheck {
        available: metadata.is_some(),
        checked_at: now_ms(),
        update: metadata,
    })
}

/// Download, verify, and install the pending update. On Windows the updater exits
/// the app as the installer starts; on other desktop platforms we restart after a
/// successful install so the user lands on the new version.
#[tauri::command]
async fn starnet_update_install(
    app: AppHandle,
    pending_update: State<'_, PendingUpdate>,
    on_event: Channel<UpdateInstallEvent>,
) -> Result<(), String> {
    let update = {
        let mut guard = pending_update
            .0
            .lock()
            .map_err(|_| "update state is unavailable".to_string())?;
        guard
            .take()
            .ok_or_else(|| "there is no pending update".to_string())?
    };

    let mut started = false;
    let install_result = update
        .download_and_install(
            |chunk_length, content_length| {
                if !started {
                    let _ = on_event.send(UpdateInstallEvent::Started { content_length });
                    started = true;
                }
                let _ = on_event.send(UpdateInstallEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(UpdateInstallEvent::Finished);
            },
        )
        .await;

    if let Err(e) = install_result {
        if let Ok(mut guard) = pending_update.0.lock() {
            *guard = Some(update);
        }
        return Err(e.to_string());
    }

    let _ = on_event.send(UpdateInstallEvent::Installing);
    app.restart()
}

/// P1.5 build provenance: the app version + the git commit/dirty state this binary was compiled from (stamped by
/// build.rs). The frontend diagnostics panel renders "build <version> @ <commit>[ DIRTY]" so a user (or the release
/// train) can prove exactly which source produced an installed exe. Commit is "unknown" when git was unavailable
/// at build time (never a hard failure).
#[derive(serde::Serialize)]
struct BuildInfo {
    version: String,
    commit: String,
    sha: String,
    #[serde(rename = "sourceTree")]
    source_tree: String,
    #[serde(rename = "provenanceKind")]
    provenance_kind: String,
    describe: String,
    dirty: bool,
    #[serde(rename = "executableSha256")]
    executable_sha256: String,
    #[serde(rename = "executableSize")]
    executable_size: u64,
}

/// Hash an executable without loading it wholesale into memory. The identity is intentionally
/// content-only: installed-smoke can bind the operator-supplied artifact to the bytes that are
/// actually running without exposing the user's install path to the WebView/evidence bundle.
fn executable_identity(path: &Path) -> Option<(String, u64)> {
    let mut file = std::fs::File::open(path).ok()?;
    let expected_size = file.metadata().ok()?.len();
    if expected_size == 0 {
        return None;
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut bytes_read = 0_u64;
    loop {
        let count = file.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        bytes_read = bytes_read.checked_add(count as u64)?;
    }
    if bytes_read != expected_size {
        return None;
    }
    Some((format!("{:x}", hasher.finalize()), bytes_read))
}

fn runtime_executable_identity() -> (String, u64) {
    static IDENTITY: OnceLock<(String, u64)> = OnceLock::new();
    IDENTITY
        .get_or_init(|| {
            std::env::current_exe()
                .ok()
                .and_then(|path| executable_identity(&path))
                .unwrap_or_else(|| (String::new(), 0))
        })
        .clone()
}

#[cfg(test)]
mod executable_identity_tests {
    use super::executable_identity;

    fn temp_file(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "starnet-executable-identity-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ))
    }

    #[test]
    fn hashes_exact_file_bytes_and_size() {
        let file = temp_file("nonempty.bin");
        std::fs::write(&file, b"abc").unwrap();

        let identity = executable_identity(&file).expect("non-empty file has an identity");
        assert_eq!(
            identity,
            (
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".to_string(),
                3
            )
        );

        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn refuses_empty_or_missing_files() {
        let empty = temp_file("empty.bin");
        std::fs::write(&empty, []).unwrap();
        assert_eq!(executable_identity(&empty), None);
        let _ = std::fs::remove_file(&empty);
        assert_eq!(executable_identity(&empty), None);
    }
}

#[tauri::command]
fn starnet_build_info(app: AppHandle) -> BuildInfo {
    let (executable_sha256, executable_size) = runtime_executable_identity();
    BuildInfo {
        version: app.package_info().version.to_string(),
        commit: env!("STARNET_BUILD_COMMIT").to_string(),
        sha: env!("STARNET_BUILD_SHA").to_string(),
        source_tree: env!("STARNET_BUILD_TREE").to_string(),
        provenance_kind: env!("STARNET_BUILD_PROVENANCE_KIND").to_string(),
        describe: env!("STARNET_BUILD_DESCRIBE").to_string(),
        dirty: env!("STARNET_BUILD_DIRTY") == "1",
        executable_sha256,
        executable_size,
    }
}

/// Lane 4D: is launch-at-login currently registered? OPT-IN, default OFF — this only reports the real OS state
/// (Windows Run key / macOS LaunchAgent / Linux autostart .desktop) so the Settings toggle never lies.
#[tauri::command]
fn starnet_autostart_status(app: AppHandle) -> Result<AutostartStatus, String> {
    use tauri_plugin_autostart::ManagerExt;
    let enabled = app.autolaunch().is_enabled().map_err(|e| e.to_string())?;
    Ok(AutostartStatus {
        desktop: true,
        enabled,
    })
}

/// Enable/disable launch-at-login and report the resulting REAL state (read back, not assumed). The single-
/// instance plugin guarantees a login launch focuses the running app rather than starting a 2nd sidecar.
#[tauri::command]
fn starnet_set_autostart(app: AppHandle, enabled: bool) -> Result<AutostartStatus, String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())?;
    } else {
        manager.disable().map_err(|e| e.to_string())?;
    }
    let now = manager.is_enabled().map_err(|e| e.to_string())?;
    Ok(AutostartStatus {
        desktop: true,
        enabled: now,
    })
}

/// Lane 4D: the live armed-work summary for the frontend's background-lifecycle surface. Proxies the sidecar's
/// own truth through the supervisor so the UI's "what keeps running when you close the window" copy is gated on
/// the SAME state the tray's close decision uses — never a divergent claim.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LifecycleView {
    supervised: bool,
    armed: bool,
    reasons: Vec<String>,
    start_minimized: bool,
    close_to_tray: bool,
}

/// User-driven restart of the local station service from the STATION DATA UNREACHABLE screen.
/// The guardian only heals a child that has EXITED; a sidecar that is alive but not answering (hung
/// event loop, wedged listener) or one that exits before listening every time it is spawned (a workspace
/// claim refusal) leaves the page polling a dead port forever. This kills whatever child exists, spawns a
/// fresh one on the same port, and reports truthfully whether it came up listening. Never touches user data.
#[tauri::command]
fn starnet_restart_sidecar(state: State<AppState>) -> Result<bool, String> {
    let st: &AppState = state.inner();
    if st.shutting_down.load(Ordering::SeqCst) {
        return Err("StarNet is shutting down".to_string());
    }
    let _recovery = begin_recovery(st)?;
    log_startup(
        &st.startup_log,
        "restart: user requested a station service restart",
    );
    // Take the child out under the lock, terminate it after releasing (spawn_sidecar re-takes the lock).
    let prior = st.sidecar.lock().ok().and_then(|mut g| g.take());
    if let Some(mut child) = prior {
        terminate_sidecar_child(&mut child);
        let _ = child.wait();
    }
    let listening = spawn_sidecar(st);
    log_startup(
        &st.startup_log,
        format!("restart: respawned sidecar listening={listening}"),
    );
    Ok(listening)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FreshStartView {
    ok: bool,
    listening: bool,
    quarantine: Option<String>,
    browser_data_cleared: bool,
}

/// Last-resort recovery for a station service that cannot answer HTTP at all. The sidecar-backed
/// START FRESH route cannot help in that state, so the desktop shell stops its own child, moves the
/// entire workspace generation to a reversible quarantine, seals a clean generation against legacy
/// re-migration, and respawns with the same OS-keychain credentials. Purchased credits therefore
/// remain account-bound and are re-injected into the clean sidecar; this command never clears them.
#[tauri::command]
fn starnet_start_fresh(
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> Result<FreshStartView, String> {
    let st: &AppState = state.inner();
    if st.shutting_down.load(Ordering::SeqCst) {
        return Err("StarNet is shutting down".to_string());
    }
    let _recovery = begin_recovery(st)?;
    log_startup(
        &st.startup_log,
        "fresh-start: explicit unreachable-screen reset requested",
    );

    let prior = st.sidecar.lock().ok().and_then(|mut guard| guard.take());
    let stopped_pid = prior.as_ref().map(Child::id);
    if let Some(mut child) = prior {
        terminate_sidecar_child(&mut child);
        let _ = child.wait();
    }

    let mut acknowledged = legacy_workspace_paths(&st.root, &st.workspaces);
    if let Some(parent) = st.workspaces.parent() {
        push_unique_path(&mut acknowledged, parent.join("update-snapshots"));
    }
    let prepared =
        fresh_start::quarantine_and_prepare(&st.workspaces, &acknowledged, stopped_pid, now_ms());
    let prepared = match prepared {
        Ok(value) => value,
        Err(error) => {
            let listening = spawn_sidecar(st);
            log_startup(
                &st.startup_log,
                format!("fresh-start: refused ({error}); original station respawn listening={listening}"),
            );
            return Err(error);
        }
    };

    // The reset deliberately preserves only the protected StarNet credit-account link record.
    // Adopt a transient plaintext token into the OS keychain before the new sidecar starts, matching boot.
    migrate_credits_token_from_plaintext(&st.workspaces);
    // The packaged origin belongs only to StarNet. Clearing it natively removes localStorage,
    // IndexedDB, cookies, service workers and caches on both WebView2 and WKWebView. JS repeats the
    // namespaced localStorage clear as a fallback, and will refuse to reload if neither layer proves it.
    let browser_data_cleared = match window.clear_all_browsing_data() {
        Ok(()) => true,
        Err(error) => {
            log_startup(
                &st.startup_log,
                format!("fresh-start: native browser-data clear failed; renderer fallback required ({error})"),
            );
            false
        }
    };
    let listening = spawn_sidecar(st);
    let quarantine = prepared
        .quarantine
        .as_ref()
        .map(|path| path.to_string_lossy().to_string());
    log_startup(
        &st.startup_log,
        format!(
            "fresh-start: clean workspace activated quarantine={:?} listening={listening}",
            quarantine
        ),
    );
    Ok(FreshStartView {
        ok: true,
        listening,
        quarantine,
        browser_data_cleared,
    })
}

#[tauri::command]
fn starnet_lifecycle_status(state: State<AppState>) -> LifecycleView {
    let preferences = lifecycle_preferences_snapshot(state.inner());
    match query_lifecycle_armed(state.port, &state.api_token, Duration::from_millis(1500)) {
        Some(l) => LifecycleView {
            supervised: true,
            armed: l.armed,
            reasons: l.reasons,
            start_minimized: preferences.start_minimized,
            close_to_tray: preferences.close_to_tray,
        },
        None => LifecycleView {
            supervised: true,
            armed: false,
            reasons: Vec::new(),
            start_minimized: preferences.start_minimized,
            close_to_tray: preferences.close_to_tray,
        },
    }
}

#[tauri::command]
fn starnet_set_start_minimized(
    state: State<AppState>,
    enabled: bool,
) -> Result<LifecyclePreferences, String> {
    update_lifecycle_preferences(state.inner(), |value| value.start_minimized = enabled)
}

#[tauri::command]
fn starnet_set_close_to_tray(
    state: State<AppState>,
    enabled: bool,
) -> Result<LifecyclePreferences, String> {
    update_lifecycle_preferences(state.inner(), |value| value.close_to_tray = enabled)
}

fn main() {
    tauri::Builder::default()
        // A second launch should focus the running window, not spin up a 2nd sidecar. Registered FIRST per
        // Tauri guidance (n1): single-instance must run before other plugins so a second process bails early.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show(); // the window may be hidden in the tray — a relaunch should reveal it
                let _ = win.unminimize();
                let _ = win.set_focus();
            } else {
                // No `main` window means this resident instance can never be revealed again (every
                // reveal path addresses that window). Get out of the way — drain on a worker thread
                // (network on the event loop is forbidden) and exit, so the user's next launch
                // boots a fresh instance instead of signalling a zombie forever.
                let app2 = app.clone();
                std::thread::spawn(move || {
                    if let Some(state) = app2.try_state::<AppState>() {
                        log_startup(
                            &state.startup_log,
                            "second-launch: main window missing — exiting unrevealable resident instance",
                        );
                        drain_and_kill_sidecar(state.inner());
                    }
                    app2.exit(0);
                });
            }
        }))
        // Lane 4D: launch-at-login (opt-in, default OFF). macOS uses a LaunchAgent; Windows a Run key; Linux an
        // autostart .desktop. Registered here so the ManagerExt API is available; the toggle lives in Settings.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // Host-gesture gate: native confirm dialogs for the OS-launch commands. Rust-side only —
        // the webview gets no dialog capability; the prompt is minted and answered at the host.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            harness_store_key,
            harness_store_provider_key,
            harness_store_provider_key_pool,
            harness_has_key,
            harness_has_provider_key,
            harness_provider_key_status,
            harness_clear_key,
            harness_store_channel_token,
            harness_has_channel_token,
            harness_adopt_credits_token,
            harness_has_credits_token,
            harness_clear_credits_token,
            starnet_open_artifact,
            starnet_reveal_path,
            open_external_url,
            starnet_toggle_fullscreen,
            starnet_set_keep_awake,
            starnet_keep_awake_status,
            starnet_update_status,
            starnet_update_check,
            starnet_update_install,
            starnet_build_info,
            starnet_autostart_status,
            starnet_set_autostart,
            starnet_lifecycle_status,
            starnet_restart_sidecar,
            starnet_start_fresh,
            starnet_set_start_minimized,
            starnet_set_close_to_tray
        ])
        .setup(|app| {
            let root = project_root(app.handle());
            let port = free_port();
            let ipc_token = uuid::Uuid::new_v4().to_string();
            // per-launch API token: shared with the sidecar via env (it reads SKYNET_API_TOKEN) AND injected
            // into the bundled webview below, so the desktop UI never has to fetch the token over an open route.
            let api_token = uuid::Uuid::new_v4().to_string();
            let startup_log = startup_log_path(app.handle());
            let workspaces = workspace_path(app.handle());
            let lifecycle_preferences_path = lifecycle_preferences_path(app.handle());
            let lifecycle_preferences = load_lifecycle_preferences(&lifecycle_preferences_path);
            let start_minimized = lifecycle_preferences.start_minimized;
            let migrated_workspaces = migrate_workspace_data(
                &workspaces,
                &legacy_workspace_paths(&root, &workspaces),
                &startup_log,
            );
            log_startup(
                &startup_log,
                format!(
                    "startup exe={:?} resource_dir={:?} root={} workspaces={} migrated_from={:?} port={} start_minimized={} close_to_tray={}",
                    std::env::current_exe(),
                    app.path().resource_dir(),
                    root.display(),
                    workspaces.display(),
                    migrated_workspaces,
                    port,
                    lifecycle_preferences.start_minimized,
                    lifecycle_preferences.close_to_tray
                ),
            );
            // One-time: lift any plaintext channel bot tokens into the keychain and strip them from the file,
            // BEFORE spawning the sidecar so the injected SKYNET_<ID>_TOKEN env reflects the migrated tokens.
            migrate_channel_tokens_from_plaintext(&workspaces);
            // Same one-time sweep for the cloud device token — this is what upgrades an already
            // linked station from a plaintext token to a keychain one, with no user action.
            migrate_credits_token_from_plaintext(&workspaces);
            let state = AppState {
                port,
                ipc_token,
                api_token: api_token.clone(),
                root,
                workspaces,
                startup_log,
                sidecar: Mutex::new(None),
                keep_awake: Mutex::new(KeepAwakeState::new()),
                lifecycle_preferences_path,
                lifecycle_preferences: Mutex::new(lifecycle_preferences),
                close_exit_pending: AtomicBool::new(false),
                recovery_in_progress: AtomicBool::new(false),
                shutting_down: AtomicBool::new(false),
            };
            // Before spawning OUR sidecar: terminate any orphan sidecars left behind by a
            // hard-killed previous shell (Drop/ExitRequested never ran there). Multiple live
            // sidecars on one WORKSPACES dir violate the one-sidecar invariant and burn each
            // other's rotating Codex OAuth refresh tokens. Scoped strictly to processes whose
            // image path IS our bundled node runtime; fail-open, never blocks startup.
            reap_orphan_sidecars(&node_binary(&state.root), &state.startup_log);
            // Try to bring the sidecar up; on failure show a native Retry dialog naming startup.log
            // (audit 0.2). Even if this ultimately returns false, the guardian below keeps trying so
            // the app can still recover in the background rather than sitting permanently dead.
            let _ = spawn_sidecar_with_retry(&state);
            app.manage(state);
            app.manage(PendingUpdate(Mutex::new(None)));

            // Respawn the sidecar if it crashes while the window is open (see spawn_guardian).
            spawn_guardian(app.handle().clone());

            // ---- Lane 4D: tray supervisor ----
            // The tray is the visible owner of the background-lifecycle contract. Open reveals the window; the
            // status line reflects REAL armed work (kept honest by spawn_tray_updater); Pause Automation fires
            // the E-STOP (reaches background work even with the window closed); Quit drains + kills the sidecar
            // and exits. Built here so it exists before the window, so a close-to-tray has somewhere to live.
            {
                let open_item = MenuItem::with_id(app, "lifecycle_open", "Open StarNet", true, None::<&str>)?;
                let status_item = MenuItem::with_id(
                    app,
                    "lifecycle_status",
                    // Non-committal until the FIRST real poll lands (spawn_tray_updater polls immediately) —
                    // the tray must never assert an armed/idle claim it hasn't read from the sidecar (m2).
                    "Background: checking…",
                    false, // a non-clickable live status line, not an action
                    None::<&str>,
                )?;
                let pause_item = MenuItem::with_id(app, "lifecycle_pause", "Pause Automation (E-STOP)", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "lifecycle_quit", "Quit StarNet", true, None::<&str>)?;
                let sep = PredefinedMenuItem::separator(app)?;
                let menu = Menu::with_items(app, &[&open_item, &status_item, &sep, &pause_item, &quit_item])?;
                let mut tray_builder = TrayIconBuilder::with_id("starnet-tray")
                    .tooltip("StarNet")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| on_tray_menu(app, event.id.as_ref()))
                    .on_tray_icon_event(|tray, event| {
                        // A left click on the tray icon reveals the window (the expected "bring it back" gesture).
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_window(tray.app_handle());
                        }
                    });
                if let Some(icon) = app.default_window_icon().cloned() {
                    tray_builder = tray_builder.icon(icon);
                }
                tray_builder.build(app)?;
                app.manage(TrayHandles { status: status_item });
                // Keep the tray tooltip/status honest against live sidecar truth.
                spawn_tray_updater(app.handle().clone());
            }

            // The frontend is served LOCALLY (bundled via frontendDist), NOT from the sidecar's
            // http origin — Tauri denies IPC (the keychain commands) to remote origins. This shim
            // rewrites the frontend's root-relative /api/* fetches to the sidecar's port.
            let init = format!(
                "window.__STARNET_API__='http://127.0.0.1:{port}';window.__STARNET_API_TOKEN__='{api_token}';var _sf=window.fetch;window.fetch=function(u,o){{if(typeof u==='string'&&u.indexOf('/api/')===0)u=window.__STARNET_API__+u;return _sf(u,o)}};"
            );
            // Windows runs WITHOUT native decorations (see the window builder below): this flag
            // tells the frontend (app/titlebar.js) to render its own themed titlebar with
            // MIN/MAX/CLOSE riding the Commander's phosphor theme. macOS/browser never set it.
            #[cfg(windows)]
            let init = format!("{init}window.__STARNET_CUSTOM_CHROME__=1;");

            // Purge stale WebView2 compiled/GPU caches when the packaged build changed, BEFORE the
            // webview window is created — otherwise V8 can run old bytecode against new data
            // (see docs/UPDATE_STATE_SAFETY_AUDIT_2026-07-06.md P0.1). Fails soft; never blocks boot.
            {
                let handle = app.handle();
                let identifier = handle.config().identifier.clone();
                let current_version = handle.package_info().version.to_string();
                let log = startup_log_path(handle);
                purge_stale_webview_cache_on_build_change(
                    handle,
                    &identifier,
                    &current_version,
                    &log,
                );
            }

            let main_window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("StarNet")
                .inner_size(1280.0, 832.0)
                .min_inner_size(960.0, 600.0)
                .initialization_script(&init)
                .center()
                .visible(false)
                // Reveal only after the document paints — avoids a white flash.
                .on_page_load(move |window, _payload| {
                    if !start_minimized {
                        let _ = window.show();
                    }
                });
            // Windows: drop the stock titlebar/border — the frontend draws its own themed
            // chrome (titlebar.js, gated on __STARNET_CUSTOM_CHROME__ above). shadow(true)
            // keeps the DWM drop shadow, and Tauri's undecorated-resize handling keeps the
            // edge-drag resize grips working. macOS keeps native decorations until a mac
            // pass is designed (unverified there — do not blind-apply).
            #[cfg(windows)]
            let main_window = {
                let main_window = main_window.decorations(false).shadow(true);
                match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
                    Ok(args) if !args.trim().is_empty() => {
                        // Tauri supplies its own WebView2 environment options, so the ambient
                        // variable is not inherited automatically. Forward an explicit caller
                        // override here; installed QA uses this to open a loopback CDP port.
                        // Normal production launches do not set it and therefore expose no
                        // debugger. Never log the argument value because callers may add paths.
                        log_startup(
                            &startup_log_path(app.handle()),
                            "webview-browser-args: explicit environment override forwarded",
                        );
                        main_window.additional_browser_args(&args)
                    }
                    _ => main_window,
                }
            };
            let main_window = main_window.build()?;

            // ---- Lane 4D: close-to-tray, explicitly selected or gated on REAL armed work ----
            // On a close request: ALWAYS intercept + hide immediately (instant feedback, and the poll must not
            // block the UI thread — review m1), then decide on a worker thread from the classified probe (M2):
            //   Armed{armed:true}  -> keep the ONE sidecar running, window lives in the tray (explicit there).
            //   Armed{armed:false} -> nothing armed: drain + kill + exit — full quit, NO background process.
            //   NotRunning         -> connect refused: no sidecar is listening, so no armed work can exist —
            //                         full quit is safe (this is the ONLY failure that may quit).
            //   Ambiguous (x2)     -> the sidecar ACCEPTED the connection but the poll failed (slow/garbled):
            //                         it is ALIVE and may hold armed work — killing it on that evidence could
            //                         destroy the work, so after one retry we FAIL OPEN: stay hidden in the
            //                         tray and let the updater keep polling until the status recovers.
            // This is the whole product promise: no hidden daemon, and no claim the harness can't prove.
            {
                let app_handle = app.handle().clone();
                main_window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        if let Some(state) = app_handle.try_state::<AppState>() {
                            state.close_exit_pending.store(true, Ordering::SeqCst);
                        }
                        api.prevent_close();
                        if let Some(win) = app_handle.get_webview_window("main") {
                            let _ = win.hide();
                        }
                        let app2 = app_handle.clone();
                        std::thread::spawn(move || {
                            let Some(state) = app2.try_state::<AppState>() else {
                                log_startup(&None, "close-request: managed app state unavailable; exiting");
                                app2.exit(0);
                                return;
                            };
                            let st = state.inner();
                            let close_to_tray = lifecycle_preferences_snapshot(st).close_to_tray;
                            log_startup(
                                &st.startup_log,
                                format!("close-request: close_to_tray={close_to_tray}"),
                            );
                            if close_to_tray {
                                // Explicit authority to keep the supervised process alive even when no scheduled
                                // work is armed. Tray Quit remains the only full-stop action in this mode.
                                stay_resident_or_quit(&app2, st, "close-to-tray preference");
                                return;
                            }
                            let mut probe = probe_lifecycle_armed(
                                st.port,
                                &st.api_token,
                                Duration::from_millis(1500),
                            );
                            if matches!(probe, LifecycleProbe::Ambiguous) {
                                // One retry before deciding — a single slow poll must not park the app in the
                                // tray forever when the sidecar is actually healthy and idle.
                                probe = probe_lifecycle_armed(
                                    st.port,
                                    &st.api_token,
                                    Duration::from_millis(1500),
                                );
                            }
                            match probe {
                                LifecycleProbe::Armed(l) if l.armed => {
                                    stay_resident_or_quit(&app2, st, "armed background work");
                                }
                                LifecycleProbe::Ambiguous => {
                                    // Alive but unwell — fail OPEN (killing could destroy armed work).
                                    stay_resident_or_quit(&app2, st, "armed state ambiguous");
                                }
                                _ => {
                                    // Armed{armed:false} or NotRunning: window-close is a full quit.
                                    drain_and_kill_sidecar(st);
                                    app2.exit(0);
                                }
                            }
                        });
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the StarNet desktop shell")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                // Window close and event-loop exit are separate decisions in Tauri. Hold only the exit paired
                // with our main window's CloseRequested event while its worker decides from the explicit
                // preference / armed-work proof. A second-instance process has no pending close, while the
                // worker's full-quit branch (and Tray Quit / updater) calls app.exit(0) with Some(0).
                let close_exit_pending = code.is_none()
                    && app
                        .try_state::<AppState>()
                        .map(|state| state.close_exit_pending.swap(false, Ordering::SeqCst))
                        .unwrap_or(false);
                if close_exit_pending {
                    api.prevent_exit();
                    return;
                }
                if let Some(state) = app.try_state::<AppState>() {
                    // Stop the guardian from respawning before we kill the child.
                    state.shutting_down.store(true, Ordering::SeqCst);
                    state.kill_sidecar();
                }
            }
        });
}

#[cfg(test)]
mod sidecar_reap_tests {
    use super::*;

    #[test]
    fn desktop_owned_env_replaces_poisoned_brand_aliases() {
        fn explicit_env(command: &Command, name: &str) -> Option<String> {
            command
                .get_envs()
                .find(|(key, _)| *key == OsStr::new(name))
                .and_then(|(_, value)| value)
                .map(|value| value.to_string_lossy().into_owned())
        }

        let mut command = Command::new("node");
        command.env("STARNET_PORT", "poisoned-parent-value");
        set_sidecar_branded_env(&mut command, "SKYNET_PORT", "60874");
        assert_eq!(
            explicit_env(&command, "SKYNET_PORT").as_deref(),
            Some("60874")
        );
        assert_eq!(
            explicit_env(&command, "STARNET_PORT").as_deref(),
            Some("60874")
        );

        command.env("SKYNET_API_TOKEN", "stale-legacy-value");
        set_sidecar_branded_env(&mut command, "STARNET_API_TOKEN", "fresh-launch-token");
        assert_eq!(
            explicit_env(&command, "SKYNET_API_TOKEN").as_deref(),
            Some("fresh-launch-token")
        );
        assert_eq!(
            explicit_env(&command, "STARNET_API_TOKEN").as_deref(),
            Some("fresh-launch-token")
        );
    }

    #[test]
    fn dev_path_fallback_is_never_reapable() {
        // node_binary()'s dev fallback is a bare relative "node" resolved via PATH. Reaping by
        // it would match EVERY node.exe on the machine — must be refused.
        assert!(!is_reapable_node_path(Path::new("node")));
        assert!(!is_reapable_node_path(Path::new("node.exe")));
        assert!(!is_reapable_node_path(Path::new("bin/node.exe")));
    }

    #[cfg(windows)]
    #[test]
    fn bundled_absolute_path_is_reapable() {
        assert!(is_reapable_node_path(Path::new(
            r"C:\Program Files\StarNet\node.exe"
        )));
    }

    #[cfg(not(windows))]
    #[test]
    fn bundled_absolute_path_is_reapable() {
        assert!(is_reapable_node_path(Path::new("/opt/starnet/node")));
    }

    /// Ambient end-to-end proof (spawns and terminates REAL processes) — excluded from the
    /// default test run; execute explicitly with `cargo test -- --ignored`. Copies node.exe to
    /// a unique temp "bundled" path, starts one process from it (the orphan) and one from the
    /// system node (the bystander), then asserts the reap kills exactly the former.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn reap_terminates_only_processes_from_the_exact_path() {
        let node_on_path = std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|d| d.join("node.exe"))
                .find(|p| p.exists())
        });
        let Some(src) = node_on_path else {
            eprintln!("node.exe not on PATH — nothing to prove here, skipping");
            return;
        };
        let dir = std::env::temp_dir().join(format!(
            "starnet-reap-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let bundled = dir.join("node.exe");
        std::fs::copy(&src, &bundled).unwrap();

        let idle = ["-e", "setInterval(function(){}, 1000)"];
        let mut orphan = Command::new(&bundled).args(idle).spawn().unwrap();
        let mut bystander = Command::new(&src).args(idle).spawn().unwrap();
        std::thread::sleep(Duration::from_millis(400));

        let reaped = reap_orphan_sidecars(&bundled, &None);
        assert!(
            reaped >= 1,
            "expected at least the planted orphan to be reaped"
        );

        std::thread::sleep(Duration::from_millis(400));
        assert!(
            matches!(orphan.try_wait(), Ok(Some(_))),
            "process running from the bundled path must be terminated"
        );
        assert!(
            matches!(bystander.try_wait(), Ok(None)),
            "node from a DIFFERENT path must never be touched"
        );

        let _ = orphan.wait();
        let _ = bystander.kill();
        let _ = bystander.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn image_path_match_is_case_insensitive_but_exact() {
        // QueryFullProcessImageNameW may report different casing than our resolved path;
        // same_path must still match — while a DIFFERENT node install must not.
        assert!(same_path(
            Path::new(r"C:\PROGRAM FILES\StarNet\NODE.EXE"),
            Path::new(r"C:\Program Files\StarNet\node.exe"),
        ));
        assert!(!same_path(
            Path::new(r"C:\Program Files\nodejs\node.exe"),
            Path::new(r"C:\Program Files\StarNet\node.exe"),
        ));
    }
}

#[cfg(test)]
mod lifecycle_probe_tests {
    use super::*;

    // ---- parse_lifecycle_response: the pure decision the close path/tray rely on (M3) ----

    #[test]
    fn parses_valid_200_snapshot_with_reasons() {
        let raw = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"armed\":true,\"reasons\":[\"1 routine armed\",\"Telegram connected\"]}";
        let l = parse_lifecycle_response(raw).expect("valid 200 snapshot parses");
        assert!(l.armed);
        assert_eq!(l.reasons, vec!["1 routine armed", "Telegram connected"]);
    }

    #[test]
    fn parses_valid_200_not_armed() {
        let raw = "HTTP/1.1 200 OK\r\n\r\n{\"armed\":false,\"reasons\":[]}";
        let l = parse_lifecycle_response(raw).expect("valid idle snapshot parses");
        assert!(!l.armed);
        assert!(l.reasons.is_empty());
    }

    #[test]
    fn parses_nodes_chunked_200_snapshot() {
        // EXACTLY what node's http server emits for the armed endpoint when no Content-Length is
        // set (HTTP/1.1 → Transfer-Encoding: chunked). This framing being unparseable is the root
        // cause of the 0.10.x close-leaves-an-unopenable-background-process bug: every close
        // probe read as Ambiguous, so the shell always failed open into the tray.
        let raw = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nDate: Thu, 20 Aug 2026 21:17:18 GMT\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n1c\r\n{\"armed\":false,\"reasons\":[]}\r\n0\r\n\r\n";
        let l = parse_lifecycle_response(raw).expect("node's chunked idle snapshot parses");
        assert!(!l.armed);
        assert!(l.reasons.is_empty());
    }

    #[test]
    fn parses_chunked_snapshot_split_across_chunks() {
        let raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\ne\r\n{\"armed\":true,\r\nd\r\n\"reasons\":[]}\r\n0\r\n\r\n";
        let l = parse_lifecycle_response(raw).expect("multi-chunk snapshot parses");
        assert!(l.armed);
    }

    #[test]
    fn rejects_truncated_chunked_body() {
        // A read timeout can yield a partial chunk — that must classify Ambiguous (None), never
        // parse as a complete snapshot.
        let raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1c\r\n{\"armed\":false,\"rea";
        assert!(parse_lifecycle_response(raw).is_none());
        // ...and a body that never reaches the 0-terminator is equally incomplete.
        let raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1c\r\n{\"armed\":false,\"reasons\":[]}\r\n";
        assert!(parse_lifecycle_response(raw).is_none());
    }

    #[test]
    fn rejects_non_200_status() {
        // A 403 (token mismatch) or 500 must NOT read as a snapshot — the caller classifies it Ambiguous
        // (alive but unwell), never "not armed".
        assert!(
            parse_lifecycle_response("HTTP/1.1 403 Forbidden\r\n\r\nforbidden token").is_none()
        );
        assert!(parse_lifecycle_response(
            "HTTP/1.1 500 Internal Server Error\r\n\r\n{\"error\":\"x\"}"
        )
        .is_none());
    }

    #[test]
    fn rejects_missing_or_garbage_body() {
        assert!(
            parse_lifecycle_response("HTTP/1.1 200 OK\r\n\r\n").is_none(),
            "empty body"
        );
        assert!(
            parse_lifecycle_response("HTTP/1.1 200 OK\r\n\r\nnot-json").is_none(),
            "garbage body"
        );
        assert!(
            parse_lifecycle_response("HTTP/1.1 200 OK").is_none(),
            "no header/body separator"
        );
        assert!(
            parse_lifecycle_response("").is_none(),
            "empty response (read timeout yielded nothing)"
        );
    }

    #[test]
    fn rejects_200_without_armed_field() {
        // `armed` must be present and boolean — defaulting a missing field to false would let a half-written
        // response authorize a kill.
        assert!(parse_lifecycle_response("HTTP/1.1 200 OK\r\n\r\n{\"reasons\":[]}").is_none());
        assert!(parse_lifecycle_response("HTTP/1.1 200 OK\r\n\r\n{\"armed\":\"yes\"}").is_none());
    }

    #[test]
    fn tolerates_missing_reasons() {
        let l = parse_lifecycle_response("HTTP/1.1 200 OK\r\n\r\n{\"armed\":true}")
            .expect("armed without reasons parses");
        assert!(l.armed);
        assert!(l.reasons.is_empty());
    }

    // ---- refused-vs-timeout classification (the M2 distinction) ----

    #[test]
    fn refused_connect_classifies_not_running() {
        // Reserve a port, then close the listener so nothing is listening — connect must be refused.
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        assert!(matches!(
            probe_lifecycle_armed(port, "t", Duration::from_millis(300)),
            LifecycleProbe::NotRunning
        ));
    }

    #[test]
    fn silent_listener_classifies_ambiguous_not_not_running() {
        // A listener that ACCEPTS but never responds = alive-but-slow sidecar. This must be Ambiguous
        // (fail open), never NotRunning — killing on this evidence could destroy armed work.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            // Hold the accepted socket open (no response) until the client times out.
            if let Ok((sock, _)) = listener.accept() {
                std::thread::sleep(Duration::from_millis(900));
                drop(sock);
            }
        });
        let got = probe_lifecycle_armed(port, "t", Duration::from_millis(300));
        assert!(matches!(got, LifecycleProbe::Ambiguous));
        let _ = handle.join();
    }

    #[test]
    fn live_responder_classifies_armed() {
        use std::io::{Read as _, Write as _};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            if let Ok((mut sock, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf); // consume the request head
                let body = "{\"armed\":true,\"reasons\":[\"Night shift armed\"]}";
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = sock.write_all(resp.as_bytes());
            }
        });
        match probe_lifecycle_armed(port, "t", Duration::from_millis(1000)) {
            LifecycleProbe::Armed(l) => {
                assert!(l.armed);
                assert_eq!(l.reasons, vec!["Night shift armed"]);
            }
            _ => panic!("a live 200 responder must classify Armed"),
        }
        let _ = handle.join();
    }
}

#[cfg(test)]
mod webview_cache_purge_tests {
    use super::*;

    #[test]
    fn purges_on_first_run_when_marker_missing() {
        assert!(should_purge_webview_cache(None, "0.2.4"));
    }

    #[test]
    fn purges_when_packaged_build_changed() {
        assert!(should_purge_webview_cache(
            Some("0.8.0|exe:old:12"),
            "0.8.0|exe:new:12"
        ));
    }

    #[test]
    fn same_version_legacy_marker_forces_migration_purge() {
        assert!(should_purge_webview_cache(
            Some("0.8.0"),
            "0.8.0|exe:new:12"
        ));
    }

    #[test]
    fn no_purge_when_exact_packaged_build_is_unchanged() {
        assert!(!should_purge_webview_cache(
            Some("0.8.0|exe:same:12"),
            "0.8.0|exe:same:12"
        ));
    }

    #[test]
    fn tolerates_whitespace_in_marker() {
        // Markers are written via fs::write and read back with read_to_string; a trailing
        // newline or stray whitespace must NOT be read as a build change (would purge every
        // boot). trim() on both sides guards that.
        assert!(!should_purge_webview_cache(
            Some("0.8.0|exe:same:12\n"),
            "0.8.0|exe:same:12"
        ));
        assert!(!should_purge_webview_cache(
            Some("  0.8.0|exe:same:12  "),
            "0.8.0|exe:same:12"
        ));
    }

    #[cfg(windows)]
    #[test]
    fn honors_env_override_for_user_data_dir() {
        // Serialize env mutation within this test; other tests don't touch these vars.
        let key = "WEBVIEW2_USER_DATA_FOLDER";
        let prev = std::env::var_os(key);
        std::env::set_var(key, r"C:\some\custom\webview");
        let got = webview2_user_data_dir("ai.skynet.harness");
        match prev {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
        assert_eq!(got, Some(PathBuf::from(r"C:\some\custom\webview")));
    }

    #[cfg(windows)]
    #[test]
    fn purge_deletes_caches_but_preserves_user_state() {
        use std::io::Write;

        // Build a fake EBWebView\Default tree in a unique temp dir.
        let base = std::env::temp_dir().join(format!(
            "starnet-wvpurge-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let default_dir = base.join("Default");
        std::fs::create_dir_all(&default_dir).unwrap();

        // Caches that MUST be deleted.
        for name in WEBVIEW2_STALE_CACHE_DIRS {
            let d = default_dir.join(name);
            std::fs::create_dir_all(&d).unwrap();
            let mut f = std::fs::File::create(d.join("stale.bin")).unwrap();
            f.write_all(b"old-bytecode").unwrap();
        }

        // User state that MUST be preserved (world save lives in Local Storage).
        for name in ["Local Storage", "Session Storage", "IndexedDB"] {
            let d = default_dir.join(name);
            std::fs::create_dir_all(&d).unwrap();
            let mut f = std::fs::File::create(d.join("keep.bin")).unwrap();
            f.write_all(b"starnet.save").unwrap();
        }
        let cookies = default_dir.join("Cookies");
        std::fs::write(&cookies, b"cookie-jar").unwrap();

        let removed = purge_webview2_caches(&base, &None);

        // Every cache dir gone.
        for name in WEBVIEW2_STALE_CACHE_DIRS {
            assert!(
                !default_dir.join(name).exists(),
                "cache dir {name} should have been removed"
            );
        }
        assert_eq!(removed.len(), WEBVIEW2_STALE_CACHE_DIRS.len());

        // Every user-state dir/file preserved.
        for name in ["Local Storage", "Session Storage", "IndexedDB"] {
            assert!(
                default_dir.join(name).join("keep.bin").exists(),
                "user state {name} must be preserved"
            );
        }
        assert!(cookies.exists(), "Cookies must be preserved");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn purge_is_soft_when_default_dir_absent() {
        // Missing user-data dir must not panic and must remove nothing.
        let base = std::env::temp_dir().join(format!(
            "starnet-wvpurge-absent-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let removed = purge_webview2_caches(&base, &None);
        assert!(removed.is_empty());
    }
}
