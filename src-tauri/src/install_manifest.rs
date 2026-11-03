//! A damaged install names its file before the engine starts.
//!
//! Customer reports 85f602c4 / E01 (Windows 0.13.2) and E62 (Windows 11) had one shape: a single file of the install
//! was empty or gone (a zero-byte shell.js; an antivirus quarantine of the same file), the engine died with an error
//! that never named it (a zeroed shell.js reads "TypeError: makeShellTool is not a function at sidecar/index.js"), and
//! nothing told the person to restore the file or reinstall.
//!
//! BUILD. build.rs compiles this file by #[path] and writes OUT_DIR/install-manifest.json: the path, size and sha256 of
//! every CODE file in every bundle.resources tree of tauri.conf.json (the one map, never a hand list). It runs inside
//! `cargo build`, inside `tauri build`, after every staging, pruning and signing step, over the bytes the bundler copies
//! next. main.rs embeds the file, so the exe's own signature (Authenticode; Developer ID + notarization) is the
//! manifest's signature: there is no second key. Binaries are never listed (the Mac release re-signs every Mach-O after
//! staging). A tree that is absent (dev, cargo check) makes the manifest incomplete, and an incomplete manifest is
//! never read as verified.
//!
//! RUNTIME (release builds). Before the first spawn a PRESENCE pass stats every entry (missing, not a file, empty, the
//! wrong size), bounded by PRESENCE_BUDGET; after the first spawn returns a CONTENT pass hashes every entry on a
//! background thread. Both fail open: the spawn always proceeds, and the verdict only names files, in messages that
//! already exist (startup.log, the startup-failure text, the guardian's halt reason, BuildInfo.installIntegrity, which
//! is the copied diagnostics' install line). `--starnet-verify-install` runs the whole verdict headless for CI and
//! support.
//!
//! std + serde_json + sha2 only, and nothing from main.rs: test/native-install-manifest compiles this file by path so
//! its tests run in the fast gate.

use std::ffi::OsString;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

/// The schema marker. The release train greps the built exe for it next to `"complete":true` (release-train.yml).
pub const SCHEMA: &str = "starnet.install-manifest/1";
/// What a code file is: the set scripts/lib/bundle-source-integrity.mjs uses (test/install-manifest.test.js holds the
/// two equal). No binary is ever listed.
pub const CODE_EXTENSIONS: &[&str] = &["js", "cjs", "mjs", "json", "html", "htm", "css"];
/// How long the stat-only presence pass may hold up the first spawn. The spawn proceeds either way.
pub const PRESENCE_BUDGET: Duration = Duration::from_millis(1500);
/// How long the startup-failure text waits for a running content pass (the engine is down by then, so the hash
/// competes with nothing). Skipped when the presence pass already named a file.
pub const FAILURE_WAIT: Duration = Duration::from_secs(3);
/// How many damaged files startup.log names before it says how many more there are.
pub const NAMED_IN_LOG: usize = 20;
/// tauri.conf.json productName: on Linux the bundle's resources sit in <exe dir>/../lib/<productName>.
pub const PRODUCT_NAME: &str = "StarNet";
pub const VERIFY_FLAG: &str = "--starnet-verify-install";
pub const EXIT_VERIFIED: i32 = 0;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_DAMAGED: i32 = 3;
pub const EXIT_NOT_CHECKED: i32 = 4;

/// One shipped code file: its path under the install root ('/'-separated), size and sha256 (lowercase hex).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Manifest {
    /// Every resource tree was present and every code file in it was read. Only a complete manifest verifies anything.
    pub complete: bool,
    /// Why it is incomplete (the absent or unreadable trees and files), named by their tauri or installed path.
    pub gaps: Vec<String>,
    pub entries: Vec<Entry>,
}

// ---- build side: the resource map and the generated list ----

/// tauri.conf.json bundle.resources as (source, installed path) pairs. Only the map form names where each tree lands;
/// any other shape is an error, and the manifest is then incomplete rather than guessed.
pub fn resource_map(tauri_conf: &str) -> Result<Vec<(String, String)>, String> {
    let conf: serde_json::Value =
        serde_json::from_str(tauri_conf).map_err(|e| format!("tauri.conf.json: {e}"))?;
    let map = conf
        .pointer("/bundle/resources")
        .and_then(|r| r.as_object())
        .ok_or("tauri.conf.json bundle.resources is not a map of source to installed path")?;
    let mut pairs = Vec::with_capacity(map.len());
    for (source, target) in map {
        let target = target
            .as_str()
            .ok_or_else(|| format!("bundle.resources[{source}] is not a path"))?;
        let target = target.replace('\\', "/");
        let target = target.trim_start_matches("./").trim_end_matches('/');
        pairs.push((source.clone(), target.to_string()));
    }
    Ok(pairs)
}

pub fn is_code_file(name: &str) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(_, ext)| CODE_EXTENSIONS.iter().any(|c| c.eq_ignore_ascii_case(ext)))
}

/// A manifest path is relative, '/'-separated and stays inside the install root: no '..', '.' or empty segment, no
/// root, no drive or stream (':'), no backslash.
pub fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains(':')
        && path.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

/// `root` joined with a manifest path one segment at a time, so a verbatim (\\?\) Windows root works too.
pub fn installed_path(root: &Path, rel: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for seg in rel.split('/') {
        path.push(seg);
    }
    path
}

/// (size, sha256) of a file's bytes, streamed.
pub fn sha256_file(path: &Path) -> io::Result<(u64, String)> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut size = 0_u64;
    loop {
        let count = match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => count,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        hasher.update(&buffer[..count]);
        size += count as u64;
    }
    Ok((size, format!("{:x}", hasher.finalize())))
}

/// Every code file of every resource tree under `base` (the src-tauri folder tauri.conf.json is relative to), listed
/// at its installed path. Walks the way tauri's bundler does: hidden files included, a linked folder skipped, a linked
/// file listed with its target's bytes.
pub fn generate(base: &Path, resources: &[(String, String)]) -> Manifest {
    let mut entries = Vec::new();
    let mut gaps = Vec::new();
    for (source, target) in resources {
        if !target.is_empty() && !safe_relative(target) {
            gaps.push(format!("{source}: its installed path {target:?} leaves the install root"));
            continue;
        }
        let from = base.join(source);
        match fs::metadata(&from) {
            Ok(meta) if meta.is_dir() => walk(&from, "", target, &mut entries, &mut gaps),
            Ok(meta) if meta.is_file() => {
                let name = from.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let installed = if target.is_empty() { name } else { target.clone() };
                if is_code_file(&installed) {
                    add_file(&from, installed, &mut entries, &mut gaps);
                }
            }
            _ => gaps.push(format!("{source}: absent")),
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    // two resources installing one path: tauri copies them in no fixed order, so neither entry can be trusted
    for pair in entries.windows(2) {
        if pair[0].path == pair[1].path {
            gaps.push(format!("{}: installed by two resources", pair[0].path));
        }
    }
    entries.dedup_by(|a, b| a.path == b.path);
    Manifest { complete: gaps.is_empty(), gaps, entries }
}

fn join_rel(base: &str, name: &str) -> String {
    if base.is_empty() {
        name.to_string()
    } else {
        format!("{base}/{name}")
    }
}

fn walk(dir: &Path, rel: &str, target: &str, entries: &mut Vec<Entry>, gaps: &mut Vec<String>) {
    let here = join_rel(target, rel);
    let items = match fs::read_dir(dir) {
        Ok(items) => items,
        Err(e) => return gaps.push(format!("{here}: {e}")),
    };
    for item in items {
        let item = match item {
            Ok(item) => item,
            Err(e) => {
                gaps.push(format!("{here}: {e}"));
                continue;
            }
        };
        let path = item.path();
        let Ok(kind) = item.file_type() else {
            gaps.push(format!("{here}: an entry whose type could not be read"));
            continue;
        };
        // tauri walks without following links: a linked folder is skipped, a linked file ships its target's bytes
        let (is_dir, is_file) = if kind.is_symlink() {
            (false, fs::metadata(&path).map(|m| m.is_file()).unwrap_or(false))
        } else {
            (kind.is_dir(), kind.is_file())
        };
        let file_name = item.file_name();
        let Some(name) = file_name.to_str() else {
            if is_dir || is_code_file(&file_name.to_string_lossy()) {
                gaps.push(format!("{here}: a name that is not UTF-8"));
            }
            continue;
        };
        let child = join_rel(rel, name);
        if is_dir {
            walk(&path, &child, target, entries, gaps);
        } else if is_file && is_code_file(name) {
            add_file(&path, join_rel(target, &child), entries, gaps);
        }
    }
}

fn add_file(path: &Path, installed: String, entries: &mut Vec<Entry>, gaps: &mut Vec<String>) {
    if !safe_relative(&installed) {
        return gaps.push(format!("{installed}: not a plain relative path"));
    }
    match sha256_file(path) {
        Ok((size, sha256)) => entries.push(Entry { path: installed, size, sha256 }),
        Err(e) => gaps.push(format!("{installed}: {e}")),
    }
}

/// The manifest as written to OUT_DIR, one entry per line. The header is fixed text so the release train can find
/// `"schema":"starnet.install-manifest/1","complete":true` in the built exe.
pub fn to_json(manifest: &Manifest) -> String {
    let quote = |s: &str| serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string());
    let gaps: Vec<String> = manifest.gaps.iter().map(|g| quote(g)).collect();
    let mut out = format!(
        "{{\"schema\":{},\"complete\":{},\"gaps\":[{}],\"entries\":[",
        quote(SCHEMA),
        manifest.complete,
        gaps.join(",")
    );
    for (i, e) in manifest.entries.iter().enumerate() {
        out.push_str(if i == 0 { "\n" } else { ",\n" });
        out.push_str(&format!(
            "{{\"path\":{},\"size\":{},\"sha256\":{}}}",
            quote(&e.path),
            e.size,
            quote(&e.sha256)
        ));
    }
    out.push_str("\n]}\n");
    out
}

pub fn parse(json: &str) -> Result<Manifest, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("the install manifest is unreadable ({e})"))?;
    if value.get("schema").and_then(|s| s.as_str()) != Some(SCHEMA) {
        return Err(format!("the install manifest is not {SCHEMA}"));
    }
    let complete = value.get("complete").and_then(|c| c.as_bool()) == Some(true);
    let gaps = value
        .get("gaps")
        .and_then(|g| g.as_array())
        .map(|g| g.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let rows = value
        .get("entries")
        .and_then(|e| e.as_array())
        .ok_or("the install manifest has no entries list")?;
    let mut entries = Vec::with_capacity(rows.len());
    for row in rows {
        let path = row
            .get("path")
            .and_then(|p| p.as_str())
            .ok_or("an install manifest entry has no path")?;
        if !safe_relative(path) {
            return Err(format!("the install manifest names a path outside the install: {path:?}"));
        }
        let size = row
            .get("size")
            .and_then(|s| s.as_u64())
            .ok_or_else(|| format!("{path}: no size in the install manifest"))?;
        let sha256 = row
            .get("sha256")
            .and_then(|h| h.as_str())
            .filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| format!("{path}: no sha256 in the install manifest"))?;
        entries.push(Entry { path: path.to_string(), size, sha256: sha256.to_ascii_lowercase() });
    }
    Ok(Manifest { complete, gaps, entries })
}

/// The embedded manifest, if it can verify anything: parsed, complete, and listing at least one file.
pub fn checkable(embedded: &str) -> Result<Manifest, String> {
    let manifest = parse(embedded)?;
    if !manifest.complete {
        let first = manifest.gaps.first().map(String::as_str).unwrap_or("no reason recorded");
        return Err(format!("this build's install manifest is incomplete: {first}"));
    }
    if manifest.entries.is_empty() {
        return Err("this build's install manifest lists no files".to_string());
    }
    Ok(manifest)
}

// ---- runtime side: what is wrong with one file, and the passes over all of them ----

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Damage {
    Missing,
    NotAFile,
    Empty { expected: u64 },
    WrongSize { expected: u64, actual: u64 },
    /// the right size, different bytes: a changed file or an update that did not finish
    ContentDiffers,
    /// it exists but could not be read (locked, no permission); the reason is the OS's
    Unreadable(String),
}

impl Damage {
    pub fn kind(&self) -> &'static str {
        match self {
            Damage::Missing => "missing",
            Damage::NotAFile => "not-a-file",
            Damage::Empty { .. } => "empty",
            Damage::WrongSize { .. } => "wrong-size",
            Damage::ContentDiffers => "content-differs",
            Damage::Unreadable(_) => "unreadable",
        }
    }

    /// What a security program does to a file it takes (E62): removes it, empties it, or locks it away.
    fn quarantine_shaped(&self) -> bool {
        matches!(self, Damage::Missing | Damage::NotAFile | Damage::Empty { .. } | Damage::Unreadable(_))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    pub path: String,
    pub damage: Damage,
}

impl Finding {
    pub fn describe(&self) -> String {
        let path = &self.path;
        match &self.damage {
            Damage::Missing => format!("{path} is missing"),
            Damage::NotAFile => format!("{path} is not a file"),
            Damage::Empty { expected } => format!("{path} is empty (0 of {} bytes)", grouped(*expected)),
            Damage::WrongSize { expected, actual } => {
                format!("{path} is the wrong size ({} of {} bytes)", grouped(*actual), grouped(*expected))
            }
            Damage::ContentDiffers => {
                format!("{path} does not match this version (same size, different content)")
            }
            Damage::Unreadable(why) => format!("{path} could not be read ({why})"),
        }
    }
}

/// 89158 -> "89,158"
pub fn grouped(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn is_missing(e: &io::Error) -> bool {
    // ENOTDIR (20 on Linux and macOS): a folder on the way is now a file, so the file itself is gone
    e.kind() == io::ErrorKind::NotFound || (cfg!(unix) && e.raw_os_error() == Some(20))
}

/// Stat only: is the entry there, a file, and the size it shipped at?
pub fn presence(root: &Path, entry: &Entry) -> Option<Damage> {
    match fs::metadata(installed_path(root, &entry.path)) {
        Err(e) if is_missing(&e) => Some(Damage::Missing),
        Err(e) => Some(Damage::Unreadable(e.to_string())),
        Ok(meta) if !meta.is_file() => Some(Damage::NotAFile),
        Ok(meta) if meta.len() == entry.size => None,
        Ok(meta) if meta.len() == 0 => Some(Damage::Empty { expected: entry.size }),
        Ok(meta) => Some(Damage::WrongSize { expected: entry.size, actual: meta.len() }),
    }
}

/// Presence, then the bytes. `read` is sha256_file except in tests, which fake the one edge they cannot make real.
pub fn content(root: &Path, entry: &Entry, read: &dyn Fn(&Path) -> io::Result<(u64, String)>) -> Option<Damage> {
    if let Some(damage) = presence(root, entry) {
        return Some(damage);
    }
    match read(&installed_path(root, &entry.path)) {
        Err(e) if is_missing(&e) => Some(Damage::Missing),
        Err(e) => Some(Damage::Unreadable(e.to_string())),
        Ok((0, _)) if entry.size > 0 => Some(Damage::Empty { expected: entry.size }),
        Ok((size, _)) if size != entry.size => Some(Damage::WrongSize { expected: entry.size, actual: size }),
        Ok((_, sha256)) if !sha256.eq_ignore_ascii_case(&entry.sha256) => Some(Damage::ContentDiffers),
        Ok(_) => None,
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Pass {
    pub findings: Vec<Finding>,
    /// entries looked at; fewer than listed when a deadline cut the pass short
    pub checked: usize,
}

pub fn presence_pass(root: &Path, entries: &[Entry], deadline: Option<Instant>) -> Pass {
    let mut pass = Pass::default();
    for entry in entries {
        if deadline.is_some_and(|d| Instant::now() >= d) {
            break;
        }
        if let Some(damage) = presence(root, entry) {
            pass.findings.push(Finding { path: entry.path.clone(), damage });
        }
        pass.checked += 1;
    }
    pass
}

pub fn content_pass(root: &Path, entries: &[Entry], read: &dyn Fn(&Path) -> io::Result<(u64, String)>) -> Pass {
    let mut pass = Pass::default();
    for entry in entries {
        if let Some(damage) = content(root, entry, read) {
            pass.findings.push(Finding { path: entry.path.clone(), damage });
        }
        pass.checked += 1;
    }
    pass
}

// ---- the verdict, and the lines each existing message carries ----

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// No claim: a dev build, an incomplete or unreadable manifest, no install root, or not run yet.
    NotChecked(String),
    /// Every listed file is present at its shipped size (or the presence pass hit its bound); hashing is under way.
    Checking { files: usize },
    Verified { files: usize },
    /// `hashed`: the content pass ran (false = named by the presence pass alone so far).
    Damaged { files: usize, findings: Vec<Finding>, hashed: bool },
}

impl Verdict {
    pub fn after_presence(files: usize, pass: Pass) -> Verdict {
        if pass.findings.is_empty() {
            Verdict::Checking { files }
        } else {
            Verdict::Damaged { files, findings: pass.findings, hashed: false }
        }
    }

    pub fn after_content(files: usize, pass: Pass) -> Verdict {
        if pass.findings.is_empty() {
            Verdict::Verified { files }
        } else {
            Verdict::Damaged { files, findings: pass.findings, hashed: true }
        }
    }

    pub fn is_damaged(&self) -> bool {
        matches!(self, Verdict::Damaged { .. })
    }

    pub fn findings(&self) -> &[Finding] {
        match self {
            Verdict::Damaged { findings, .. } => findings,
            _ => &[],
        }
    }

    pub fn exit_code(&self) -> i32 {
        match self {
            Verdict::Verified { .. } => EXIT_VERIFIED,
            Verdict::Damaged { .. } => EXIT_DAMAGED,
            Verdict::NotChecked(_) | Verdict::Checking { .. } => EXIT_NOT_CHECKED,
        }
    }

    /// The short status: the copied diagnostics' install line and the headless verify's first line.
    pub fn summary(&self) -> String {
        match self {
            Verdict::NotChecked(why) => format!("not checked ({why})"),
            Verdict::Checking { files } => format!("checking {} files", grouped(*files as u64)),
            Verdict::Verified { files } => format!("verified {} files", grouped(*files as u64)),
            Verdict::Damaged { files, findings, .. } => format!(
                "DAMAGED - {} of {} files: {}",
                findings.len(),
                grouped(*files as u64),
                findings.first().map(Finding::describe).unwrap_or_default()
            ),
        }
    }

    /// startup.log: one summary line, then up to NAMED_IN_LOG named files and the exits.
    pub fn log_lines(&self, stage: &str, took: Duration) -> Vec<String> {
        let ms = took.as_millis();
        match self {
            Verdict::NotChecked(why) => vec![format!("install-integrity: not checked ({why})")],
            Verdict::Checking { files } => vec![format!(
                "install-integrity: {} listed files present at their shipped sizes ({stage}, {ms} ms); hashing them after the engine starts",
                grouped(*files as u64)
            )],
            Verdict::Verified { files } => {
                vec![format!("install-integrity: verified {} files ({stage}, {ms} ms)", grouped(*files as u64))]
            }
            Verdict::Damaged { files, findings, .. } => {
                let mut lines = vec![format!(
                    "install-integrity: DAMAGED - {} of {} listed files ({stage}, {ms} ms):",
                    findings.len(),
                    grouped(*files as u64)
                )];
                for finding in findings.iter().take(NAMED_IN_LOG) {
                    lines.push(format!("install-integrity:   {}", finding.describe()));
                }
                if findings.len() > NAMED_IN_LOG {
                    lines.push(format!("install-integrity:   ... and {} more", findings.len() - NAMED_IN_LOG));
                }
                lines.push(format!("install-integrity: {}", exits(findings)));
                lines
            }
        }
    }

    /// The startup-failure text (both platforms) leads with this, before the engine's own last lines.
    pub fn dialog_lead(&self) -> Option<String> {
        let findings = self.findings();
        let first = findings.first()?;
        let mut lead = format!("StarNet's installation is damaged: {}.", first.describe());
        match findings.len() {
            1 => {}
            2 => lead.push_str(" 1 more file is damaged too; startup.log names it."),
            n => lead.push_str(&format!(" {} more files are damaged too; startup.log names them.", n - 1)),
        }
        lead.push_str("\n\n");
        lead.push_str(&exits(findings));
        Some(lead)
    }

    /// One line for the guardian's halt reason (the STATION DATA UNREACHABLE screen).
    pub fn halt_lead(&self) -> Option<String> {
        let findings = self.findings();
        let first = findings.first()?;
        let more = match findings.len() {
            1 => String::new(),
            n => format!(" (+{} more, named in startup.log)", n - 1),
        };
        Some(format!(
            "StarNet's installation is damaged: {}{more}. Restore it from your security program's quarantine or reinstall StarNet from starnetos.com; your station, agents and keys are kept.",
            first.describe()
        ))
    }

    /// BuildInfo.installIntegrity: the copied diagnostics print it as their `install:` line.
    pub fn to_info(&self) -> serde_json::Value {
        match self {
            Verdict::NotChecked(why) => serde_json::json!({ "state": "not-checked", "reason": why }),
            Verdict::Checking { files } => serde_json::json!({ "state": "checking", "files": files }),
            Verdict::Verified { files } => serde_json::json!({ "state": "verified", "files": files }),
            Verdict::Damaged { files, findings, hashed } => serde_json::json!({
                "state": "damaged",
                "files": files,
                "damaged": findings.len(),
                "hashed": hashed,
                "named": findings.iter().take(5).map(Finding::describe).collect::<Vec<_>>(),
            }),
        }
    }
}

fn exits(findings: &[Finding]) -> String {
    let (it, them) = if findings.len() == 1 { ("it", "it") } else { ("these files", "them") };
    if findings.iter().any(|f| f.damage.quarantine_shaped()) {
        format!(
            "A security program may have quarantined or emptied {it}: restore {them} from that program's quarantine, or reinstall StarNet from starnetos.com. Your station, agents and keys are kept."
        )
    } else {
        "An update may not have finished: reinstall StarNet from starnetos.com. Your station, agents and keys are kept."
            .to_string()
    }
}

/// The guardian's halt reason, led by the install verdict when it names a damaged file.
pub fn with_install_lead(verdict: &Verdict, reason: String) -> String {
    match verdict.halt_lead() {
        Some(lead) => format!("{lead} {reason}"),
        None => reason,
    }
}

// ---- the app's shared verdict: written by setup and the content pass, read by every message ----

pub struct Integrity {
    state: Mutex<IntegrityState>,
    settled: Condvar,
}

struct IntegrityState {
    verdict: Verdict,
    /// what the content pass hashes once the first spawn has returned
    pending: Option<(Manifest, PathBuf)>,
    hashing: bool,
}

impl Default for Integrity {
    fn default() -> Self {
        Self::new()
    }
}

impl Integrity {
    pub fn new() -> Self {
        Integrity {
            state: Mutex::new(IntegrityState {
                verdict: Verdict::NotChecked("the check has not run yet".to_string()),
                pending: None,
                hashing: false,
            }),
            settled: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, IntegrityState> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn verdict(&self) -> Verdict {
        self.lock().verdict.clone()
    }

    /// The verdict, after waiting up to `timeout` for a content pass that is running. Returns at once otherwise.
    pub fn wait_settled(&self, timeout: Duration) -> Verdict {
        let deadline = Instant::now() + timeout;
        let mut state = self.lock();
        while state.hashing {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            state = match self.settled.wait_timeout(state, deadline - now) {
                Ok((state, _)) => state,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
        state.verdict.clone()
    }

    /// For the startup-failure text: a file the presence pass named is enough; otherwise give the content pass a moment.
    pub fn verdict_for_failure(&self, wait: Duration) -> Verdict {
        let verdict = self.verdict();
        if verdict.is_damaged() {
            verdict
        } else {
            self.wait_settled(wait)
        }
    }

    fn settle(&self, verdict: Verdict) {
        let mut state = self.lock();
        state.verdict = verdict;
        state.hashing = false;
        drop(state);
        self.settled.notify_all();
    }
}

/// Before the first spawn (setup, release builds): find the install root next to this executable and stat every
/// listed file, within PRESENCE_BUDGET. Returns the startup.log lines. Never fails and never blocks past the budget.
pub fn startup_presence(integrity: &Integrity, embedded: &str, dev_build: bool) -> Vec<String> {
    let root = std::env::current_exe().ok().and_then(|exe| install_root(&root_candidates(&exe)));
    presence_at(integrity, embedded, root, dev_build, PRESENCE_BUDGET)
}

pub fn presence_at(
    integrity: &Integrity,
    embedded: &str,
    root: Option<PathBuf>,
    dev_build: bool,
    budget: Duration,
) -> Vec<String> {
    let started = Instant::now();
    let manifest = if dev_build { Err("dev build".to_string()) } else { checkable(embedded) };
    let (manifest, root) = match (manifest, root) {
        (Ok(manifest), Some(root)) => (manifest, root),
        (Err(why), _) => return not_checked(integrity, why),
        (Ok(_), None) => {
            return not_checked(integrity, "no recognizable bundled resources next to the executable".to_string())
        }
    };
    let files = manifest.entries.len();
    let pass = presence_pass(&root, &manifest.entries, Some(started + budget));
    let checked = pass.checked;
    let verdict = Verdict::after_presence(files, pass);
    let mut lines = verdict.log_lines("presence check before the engine starts", started.elapsed());
    if checked < files {
        lines.push(format!(
            "install-integrity: the presence check stopped at its {} ms bound after {checked} of {files} files; the content check covers the rest",
            budget.as_millis()
        ));
    }
    let mut state = integrity.lock();
    state.verdict = verdict;
    state.pending = Some((manifest, root));
    lines
}

fn not_checked(integrity: &Integrity, why: String) -> Vec<String> {
    let verdict = Verdict::NotChecked(why);
    let lines = verdict.log_lines("", Duration::ZERO);
    integrity.settle(verdict);
    lines
}

/// After the first spawn returns: hash every listed file on a background thread, then settle the verdict and hand the
/// startup.log lines to `log`. Does nothing when the presence pass left nothing to check (dev build, no manifest).
pub fn start_content_pass(integrity: &Arc<Integrity>, log: impl Fn(String) + Send + 'static) {
    let job = {
        let mut state = integrity.lock();
        let job = state.pending.take();
        state.hashing = job.is_some();
        job
    };
    let Some((manifest, root)) = job else {
        return;
    };
    let shared = Arc::clone(integrity);
    let spawned = std::thread::Builder::new()
        .name("install-integrity".to_string())
        .spawn(move || {
            let started = Instant::now();
            let pass = content_pass(&root, &manifest.entries, &sha256_file);
            let verdict = Verdict::after_content(manifest.entries.len(), pass);
            let lines = verdict.log_lines("content check", started.elapsed());
            shared.settle(verdict);
            for line in lines {
                log(line);
            }
        });
    if let Err(e) = spawned {
        // the presence verdict stands; an unhashed install is never called verified
        let verdict = match integrity.verdict() {
            Verdict::Checking { .. } => Verdict::NotChecked(format!("the content check could not start: {e}")),
            other => other,
        };
        integrity.settle(verdict);
    }
}

/// Where an installed bundle keeps its resources, next to its executable: Windows beside the exe, macOS in
/// Contents/Resources, Linux in lib/<productName>.
pub fn root_candidates(exe: &Path) -> Vec<PathBuf> {
    let Some(dir) = exe.parent() else {
        return Vec::new();
    };
    vec![
        dir.to_path_buf(),
        dir.join("..").join("Resources"),
        dir.join("..").join("lib").join(PRODUCT_NAME),
    ]
}

/// Prefer the sidecar folder, then the candidate with the most surviving bundled resource roots. The sidecar tree
/// itself can be missing or replaced by a file: requiring that very tree would hide its damage. The anchors come
/// from the same bundle map used to generate the manifest, not a second resource list. An executable alone still
/// supplies no install evidence and remains not checked.
pub fn install_root(candidates: &[PathBuf]) -> Option<PathBuf> {
    if let Some(root) = candidates.iter().find(|c| c.join("sidecar").is_dir()) {
        return Some(root.clone());
    }
    let resources = resource_map(include_str!("../tauri.conf.json")).ok()?;
    let mut best = None;
    let mut best_count = 0;
    for candidate in candidates {
        let count = resources.iter().filter(|(_, target)| safe_relative(target)
            && fs::symlink_metadata(installed_path(candidate, target)).is_ok()).count();
        if count > best_count {
            best = Some(candidate.clone());
            best_count = count;
        }
    }
    best
}

/// The whole verdict at once (no time bound): what the headless verify reports.
pub fn verify_install(embedded: &str, root: Option<&Path>) -> Verdict {
    let manifest = match checkable(embedded) {
        Ok(manifest) => manifest,
        Err(why) => return Verdict::NotChecked(why),
    };
    let Some(root) = root else {
        return Verdict::NotChecked("no recognizable bundled resources next to the executable".to_string());
    };
    Verdict::after_content(manifest.entries.len(), content_pass(root, &manifest.entries, &sha256_file))
}

/// The receipt `--out` writes: the verdict, the root it checked and every named file.
pub fn receipt(verdict: &Verdict, root: Option<&Path>) -> String {
    let mut value = verdict.to_info();
    if let Some(obj) = value.as_object_mut() {
        obj.insert("schema".to_string(), serde_json::json!("starnet.install-verify/1"));
        obj.insert("exitCode".to_string(), serde_json::json!(verdict.exit_code()));
        obj.insert(
            "root".to_string(),
            serde_json::json!(root.map(|r| r.display().to_string()).unwrap_or_default()),
        );
        let findings: Vec<serde_json::Value> = verdict
            .findings()
            .iter()
            .map(|f| {
                let (expected, actual) = match f.damage {
                    Damage::Empty { expected } => (Some(expected), Some(0)),
                    Damage::WrongSize { expected, actual } => (Some(expected), Some(actual)),
                    _ => (None, None),
                };
                serde_json::json!({
                    "path": f.path, "damage": f.damage.kind(), "expected": expected, "actual": actual,
                    "text": f.describe(),
                })
            })
            .collect();
        obj.insert("findings".to_string(), serde_json::Value::Array(findings));
    }
    serde_json::to_string_pretty(&value).unwrap_or_default() + "\n"
}

/// `--starnet-verify-install [--root DIR] [--out FILE]`, handled before Tauri starts (main.rs). None unless the FIRST
/// argument is the flag. Exits 0 verified, 3 damaged, 4 not checked (2 for a usage error).
pub fn verify_install_main(argv: impl IntoIterator<Item = OsString>, embedded: &str) -> Option<i32> {
    let mut args = argv.into_iter().skip(1);
    if args.next()?.to_str()? != VERIFY_FLAG {
        return None;
    }
    let usage = || eprintln!("usage: {VERIFY_FLAG} [--root DIR] [--out FILE]");
    let (mut root, mut out): (Option<PathBuf>, Option<PathBuf>) = (None, None);
    while let Some(arg) = args.next() {
        let slot = match arg.to_str() {
            Some("--root") => &mut root,
            Some("--out") => &mut out,
            _ => {
                usage();
                return Some(EXIT_USAGE);
            }
        };
        match args.next() {
            Some(value) => *slot = Some(PathBuf::from(value)),
            None => {
                usage();
                return Some(EXIT_USAGE);
            }
        }
    }
    let root = root.or_else(|| std::env::current_exe().ok().and_then(|exe| install_root(&root_candidates(&exe))));
    let verdict = verify_install(embedded, root.as_deref());
    println!("install: {}", verdict.summary());
    for finding in verdict.findings() {
        println!("  {}", finding.describe());
    }
    if let Some(out) = out {
        if let Err(e) = fs::write(&out, receipt(&verdict, root.as_deref())) {
            eprintln!("{VERIFY_FLAG}: could not write {}: {e}", out.display());
        }
    }
    Some(verdict.exit_code())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real map: every fixture below is laid out and installed through it.
    const TAURI_CONF: &str = include_str!("../tauri.conf.json");

    fn scratch(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("starnet-install-manifest-{}-{nanos}-{name}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn copy_tree(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for item in fs::read_dir(from).unwrap() {
            let item = item.unwrap();
            let target = to.join(item.file_name());
            if item.file_type().unwrap().is_dir() {
                copy_tree(&item.path(), &target);
            } else {
                fs::copy(item.path(), target).unwrap();
            }
        }
    }

    /// A checkout laid out like the real one (src-tauri beside sidecar/, shared/, bin/; the staged frontend-dist and
    /// voice-deps inside src-tauri), plus the install tauri would make of it through the real resource map.
    struct Fixture {
        dir: PathBuf,
        base: PathBuf,
        install: PathBuf,
        map: Vec<(String, String)>,
    }

    impl Fixture {
        fn new(name: &str) -> Fixture {
            let dir = scratch(name);
            let base = dir.join("repo").join("src-tauri");
            fs::create_dir_all(&base).unwrap();
            let src = |rel: &str| installed_path(&base, rel);
            put(&src("../sidecar/index.js"), b"const { makeShellTool } = require('./tools/builtin/shell.js');\n");
            put(&src("../sidecar/tools/builtin/shell.js"), &b"module.exports = { makeShellTool() { return {}; } };\n".repeat(40));
            put(&src("../sidecar/skills/catalog.json"), b"{\"skills\":[]}\n");
            put(&src("../sidecar/README.md"), b"not code\n");
            put(&src("../shared/events.js"), b"module.exports = { EVENTS: [] };\n");
            put(&src("../bin/starnet.js"), b"#!/usr/bin/env node\nrequire('./lib/cli-core.js');\n");
            put(&src("../bin/lib/cli-core.js"), b"module.exports = function main() {};\n");
            put(&src("../bin/starnet.cmd"), b"@node \"%~dp0starnet.js\" %*\r\n");
            put(&src("frontend-dist/index.html"), b"<!doctype html><script src=\"app/app.js\"></script>\n");
            put(&src("frontend-dist/app/app.js"), b"window.App = {};\n");
            put(&src("frontend-dist/css/station.css"), b"body { margin: 0 }\n");
            put(&src("frontend-dist/assets/ship.png"), &[0x89, b'P', b'N', b'G', 0, 1, 2, 3]);
            put(&src("voice-deps/node_modules/pkg/package.json"), b"{\"name\":\"pkg\",\"main\":\"index.mjs\"}\n");
            put(&src("voice-deps/node_modules/pkg/index.mjs"), b"export default 1;\n");
            put(&src("voice-deps/node_modules/pkg/LEGACY.CJS"), b"module.exports = 1;\n");
            put(&src("voice-deps/node_modules/pkg/empty.js"), b""); // packages ship empty files on purpose
            put(&src("voice-deps/node_modules/pkg/addon.node"), &[0x7f, b'E', b'L', b'F']);
            put(&src("voice-deps/node_modules/.cache/hit.json"), b"{}\n"); // hidden files ship too
            // code that is NOT a bundle resource: never listed
            put(&dir.join("repo").join("docs").join("notes.js"), b"// docs\n");
            put(&base.join("frontend-embed").join("index.html"), b"<!doctype html>\n");
            put(&base.join("src").join("main.rs"), b"fn main() {}\n");
            let map = resource_map(TAURI_CONF).unwrap();
            let install = dir.join("install");
            for (source, target) in &map {
                copy_tree(&base.join(source), &installed_path(&install, target));
            }
            Fixture { dir, base, install, map }
        }

        fn manifest(&self) -> Manifest {
            generate(&self.base, &self.map)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn named(pass: &Pass) -> Vec<(String, Damage)> {
        pass.findings.iter().map(|f| (f.path.clone(), f.damage.clone())).collect()
    }

    #[test]
    fn every_entry_damaged_in_turn_is_named() {
        let fx = Fixture::new("damage");
        let manifest = fx.manifest();
        assert!(manifest.complete, "{:?}", manifest.gaps);
        let files = manifest.entries.len();
        let embedded = to_json(&manifest);
        assert_eq!(verify_install(&embedded, Some(&fx.install)), Verdict::Verified { files });
        let mut cases = 0;
        for entry in &manifest.entries {
            let file = installed_path(&fx.install, &entry.path);
            let original = fs::read(&file).unwrap();
            for how in ["zero", "delete", "truncate", "same-size edit", "folder"] {
                let expected = match how {
                    "zero" if !original.is_empty() => {
                        fs::write(&file, b"").unwrap();
                        Damage::Empty { expected: entry.size }
                    }
                    "delete" => {
                        fs::remove_file(&file).unwrap();
                        Damage::Missing
                    }
                    "truncate" if original.len() >= 2 => {
                        fs::write(&file, &original[..original.len() / 2]).unwrap();
                        Damage::WrongSize { expected: entry.size, actual: (original.len() / 2) as u64 }
                    }
                    "same-size edit" if !original.is_empty() => {
                        let mut bytes = original.clone();
                        bytes[0] ^= 0x20;
                        fs::write(&file, &bytes).unwrap();
                        Damage::ContentDiffers
                    }
                    "folder" => {
                        fs::remove_file(&file).unwrap();
                        fs::create_dir(&file).unwrap();
                        Damage::NotAFile
                    }
                    _ => continue,
                };
                cases += 1;
                let want = vec![(entry.path.clone(), expected.clone())];
                // before the spawn: stat only, so only a same-size edit waits for the content pass
                let presence = presence_pass(&fx.install, &manifest.entries, None);
                if expected == Damage::ContentDiffers {
                    assert!(presence.findings.is_empty(), "{how} {}: {:?}", entry.path, presence.findings);
                } else {
                    assert_eq!(named(&presence), want, "presence, {how} {}", entry.path);
                }
                let verdict = verify_install(&embedded, Some(&fx.install));
                assert_eq!(verdict.exit_code(), EXIT_DAMAGED, "{how} {}", entry.path);
                let findings: Vec<(String, Damage)> =
                    verdict.findings().iter().map(|f| (f.path.clone(), f.damage.clone())).collect();
                assert_eq!(findings, want, "content, {how} {}", entry.path);
                let lead = verdict.dialog_lead().unwrap();
                assert!(lead.contains(&format!("damaged: {}", entry.path)), "{lead}");
                assert!(verdict.log_lines("test", Duration::ZERO).iter().any(|l| l.contains(&entry.path)));
                if file.is_dir() {
                    fs::remove_dir(&file).unwrap();
                }
                fs::write(&file, &original).unwrap();
            }
        }
        // every tree of the map was damaged somewhere, and the install is whole again
        for (_, target) in &fx.map {
            assert!(manifest.entries.iter().any(|e| e.path.starts_with(&format!("{target}/"))), "{target}");
        }
        assert!(cases >= manifest.entries.len() * 4, "{cases} cases");
        assert_eq!(verify_install(&embedded, Some(&fx.install)), Verdict::Verified { files });
    }

    #[test]
    fn code_files_only_from_the_resource_map() {
        let fx = Fixture::new("code-only");
        // the real tauri.conf.json map is what the fixture installs through
        assert!(fx.map.contains(&("../sidecar".to_string(), "sidecar".to_string())), "{:?}", fx.map);
        assert!(fx.map.iter().all(|(_, target)| safe_relative(target)), "{:?}", fx.map);
        let manifest = fx.manifest();
        let paths: Vec<&str> = manifest.entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "bin/lib/cli-core.js",
                "bin/starnet.js",
                "frontend/app/app.js",
                "frontend/css/station.css",
                "frontend/index.html",
                "node_modules/.cache/hit.json",
                "node_modules/pkg/LEGACY.CJS",
                "node_modules/pkg/empty.js",
                "node_modules/pkg/index.mjs",
                "node_modules/pkg/package.json",
                "shared/events.js",
                "sidecar/index.js",
                "sidecar/skills/catalog.json",
                "sidecar/tools/builtin/shell.js",
            ]
        );
        for entry in &manifest.entries {
            let (size, sha256) = sha256_file(&installed_path(&fx.install, &entry.path)).unwrap();
            assert_eq!((entry.size, entry.sha256.as_str()), (size, sha256.as_str()), "{}", entry.path);
        }
        let json = to_json(&manifest);
        assert!(json.starts_with("{\"schema\":\"starnet.install-manifest/1\",\"complete\":true,"), "{json}");
        assert_eq!(parse(&json).unwrap(), manifest);
        // the Linux install root follows the product name
        let conf: serde_json::Value = serde_json::from_str(TAURI_CONF).unwrap();
        assert_eq!(conf["productName"].as_str(), Some(PRODUCT_NAME));
    }

    #[test]
    fn extra_files_ignored() {
        let fx = Fixture::new("extras");
        let manifest = fx.manifest();
        put(&fx.install.join("sidecar").join("tools").join("new-tool.js"), b"module.exports = {};\n");
        put(&fx.install.join("node_modules").join(".cache").join("model.json"), b"{\"weights\":1}\n");
        put(&fx.install.join("frontend").join("app").join("stray.css"), b"");
        put(&fx.install.join("workspaces").join("agent.save.json"), b"{}\n");
        let verdict = verify_install(&to_json(&manifest), Some(&fx.install));
        assert_eq!(verdict, Verdict::Verified { files: manifest.entries.len() });
    }

    #[test]
    fn absent_or_partial_manifest_is_not_checked() {
        let fx = Fixture::new("partial");
        let whole = fx.manifest();
        // a tree that is absent at build time (dev, cargo check): incomplete, and never verified
        fs::remove_dir_all(fx.base.join("voice-deps")).unwrap();
        let partial = fx.manifest();
        assert!(!partial.complete);
        assert!(partial.gaps.iter().any(|g| g.contains("voice-deps/node_modules")), "{:?}", partial.gaps);
        let partial_json = to_json(&partial);
        assert!(partial_json.contains("\"complete\":false"));
        for embedded in [
            partial_json.as_str(),
            "",
            "{}",
            "not json",
            "{\"schema\":\"starnet.install-manifest/0\",\"complete\":true,\"gaps\":[],\"entries\":[]}",
            "{\"schema\":\"starnet.install-manifest/1\",\"complete\":true,\"gaps\":[],\"entries\":[]}",
        ] {
            let verdict = verify_install(embedded, Some(&fx.install));
            assert!(matches!(verdict, Verdict::NotChecked(_)), "{embedded:?} -> {verdict:?}");
            assert_eq!(verdict.exit_code(), EXIT_NOT_CHECKED);
            assert_eq!(verdict.dialog_lead(), None);
            let integrity = Arc::new(Integrity::new());
            presence_at(&integrity, embedded, Some(fx.install.clone()), false, PRESENCE_BUDGET);
            start_content_pass(&integrity, |_| {});
            assert!(matches!(integrity.wait_settled(Duration::from_secs(5)), Verdict::NotChecked(_)));
        }
        // a dev build never claims anything, even over a whole install and a complete manifest
        let integrity = Integrity::new();
        let lines = presence_at(&integrity, &to_json(&whole), Some(fx.install.clone()), true, PRESENCE_BUDGET);
        assert_eq!(integrity.verdict(), Verdict::NotChecked("dev build".to_string()));
        assert_eq!(lines, vec!["install-integrity: not checked (dev build)".to_string()]);
        assert_eq!(integrity.verdict().to_info()["state"], "not-checked");
        // no install root found: not checked, never damaged
        assert!(matches!(verify_install(&to_json(&whole), None), Verdict::NotChecked(_)));
    }

    #[test]
    fn entries_never_escape_the_root() {
        let fx = Fixture::new("escape");
        let outside = fx.dir.join("outside.js");
        put(&outside, b"secret\n");
        let (size, sha256) = sha256_file(&outside).unwrap();
        for path in [
            "../outside.js",
            "sidecar/../../outside.js",
            "/etc/hosts",
            "C:/Windows/win.ini",
            "sidecar\\..\\..\\outside.js",
            "./sidecar/index.js",
            "sidecar//index.js",
            "sidecar/index.js:stream",
            "",
        ] {
            assert!(!safe_relative(path), "{path:?}");
            let embedded = to_json(&Manifest {
                complete: true,
                gaps: vec![],
                entries: vec![Entry { path: path.to_string(), size, sha256: sha256.clone() }],
            });
            let verdict = verify_install(&embedded, Some(&fx.install));
            assert!(matches!(&verdict, Verdict::NotChecked(why) if why.contains("outside the install")), "{path:?}: {verdict:?}");
        }
        // a map row that would install outside the root is a gap, never an entry
        let manifest = generate(&fx.base, &[("../sidecar".to_string(), "../escape".to_string())]);
        assert!(!manifest.complete && manifest.entries.is_empty(), "{manifest:?}");
        assert!(fx.manifest().entries.iter().all(|e| safe_relative(&e.path)));
    }

    #[test]
    fn unreadable_is_named_not_fatal() {
        let fx = Fixture::new("unreadable");
        let manifest = fx.manifest();
        let locked = "sidecar/tools/builtin/shell.js";
        fs::write(installed_path(&fx.install, "shared/events.js"), b"").unwrap();
        // the read edge refuses one file (an antivirus lock, a permission): the pass names it with the OS's reason
        // and goes on to name the next damaged file
        let read = |path: &Path| -> io::Result<(u64, String)> {
            if path.ends_with(Path::new("sidecar").join("tools").join("builtin").join("shell.js")) {
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "locked by another program"))
            } else {
                sha256_file(path)
            }
        };
        let pass = content_pass(&fx.install, &manifest.entries, &read);
        assert_eq!(pass.checked, manifest.entries.len());
        assert_eq!(
            named(&pass),
            vec![
                ("shared/events.js".to_string(), Damage::Empty { expected: manifest.entries.iter().find(|e| e.path == "shared/events.js").unwrap().size }),
                (locked.to_string(), Damage::Unreadable("locked by another program".to_string())),
            ]
        );
        let verdict = Verdict::after_content(manifest.entries.len(), pass);
        assert!(verdict.log_lines("test", Duration::ZERO).iter().any(|l| l.contains("could not be read (locked by another program)")));
        // and for real: the OS refuses the read (Windows: another handle holds the file unshared; Unix: no permission)
        let shared_events = fs::read(installed_path(&fx.base, "../shared/events.js")).unwrap();
        fs::write(installed_path(&fx.install, "shared/events.js"), shared_events).unwrap();
        let embedded = to_json(&manifest);
        let file = installed_path(&fx.install, locked);
        let named_unreadable = |verdict: &Verdict| {
            let findings = verdict.findings();
            assert_eq!(findings.len(), 1, "{verdict:?}");
            assert_eq!(findings[0].path, locked);
            assert!(matches!(findings[0].damage, Damage::Unreadable(_)), "{verdict:?}");
        };
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let held = fs::OpenOptions::new().read(true).share_mode(0).open(&file).unwrap();
            let real = verify_install(&embedded, Some(&fx.install));
            drop(held);
            named_unreadable(&real);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
            let root_reads_anyway = fs::File::open(&file).is_ok();
            let real = verify_install(&embedded, Some(&fx.install));
            fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
            if !root_reads_anyway {
                named_unreadable(&real);
            }
        }
        let _ = &named_unreadable;
        assert_eq!(verify_install(&embedded, Some(&fx.install)), Verdict::Verified { files: manifest.entries.len() });
    }

    #[test]
    fn dialog_lead_names_file_and_exits() {
        let shell = |damage: Damage| Finding { path: "sidecar/tools/builtin/shell.js".to_string(), damage };
        let emptied = Verdict::Damaged { files: 2351, findings: vec![shell(Damage::Empty { expected: 89158 })], hashed: false };
        let lead = emptied.dialog_lead().unwrap();
        assert!(lead.starts_with("StarNet's installation is damaged: sidecar/tools/builtin/shell.js is empty (0 of 89,158 bytes)."), "{lead}");
        assert!(lead.contains("A security program may have quarantined or emptied it: restore it from that program's quarantine, or reinstall StarNet from starnetos.com."), "{lead}");
        assert!(lead.contains("Your station, agents and keys are kept."), "{lead}");
        // a half-applied update is named as one, with the reinstall exit
        let stale = Verdict::Damaged {
            files: 2351,
            findings: vec![shell(Damage::WrongSize { expected: 89158, actual: 88001 }), Finding { path: "shared/events.js".to_string(), damage: Damage::ContentDiffers }],
            hashed: true,
        };
        let lead = stale.dialog_lead().unwrap();
        assert!(lead.contains("is the wrong size (88,001 of 89,158 bytes). 1 more file is damaged too; startup.log names it."), "{lead}");
        assert!(lead.contains("An update may not have finished: reinstall StarNet from starnetos.com.") && !lead.contains("quarantine"), "{lead}");
        // the guardian's halt reason leads with the file; a healthy or unchecked install changes nothing
        let halted = with_install_lead(&emptied, "crash-loop: the station service exited 6 times.".to_string());
        assert!(halted.starts_with("StarNet's installation is damaged: sidecar/tools/builtin/shell.js is empty") && halted.ends_with("crash-loop: the station service exited 6 times."), "{halted}");
        for quiet in [Verdict::Verified { files: 3 }, Verdict::Checking { files: 3 }, Verdict::NotChecked("dev build".to_string())] {
            assert_eq!(quiet.dialog_lead(), None);
            assert_eq!(with_install_lead(&quiet, "reason".to_string()), "reason");
        }
        // startup.log names at most NAMED_IN_LOG files and says how many more
        let many = Verdict::Damaged {
            files: 100,
            findings: (0..25).map(|i| Finding { path: format!("sidecar/m{i}.js"), damage: Damage::Missing }).collect(),
            hashed: true,
        };
        let lines = many.log_lines("content check", Duration::ZERO);
        assert_eq!(lines.iter().filter(|l| l.contains(" is missing")).count(), NAMED_IN_LOG);
        assert!(lines.iter().any(|l| l.ends_with("... and 5 more")), "{lines:?}");
        assert_eq!(many.to_info()["named"].as_array().unwrap().len(), 5);
        assert_eq!(many.summary(), "DAMAGED - 25 of 100 files: sidecar/m0.js is missing");
    }

    #[test]
    fn startup_passes_settle_and_never_block_the_spawn() {
        let fx = Fixture::new("startup");
        let manifest = fx.manifest();
        let embedded = to_json(&manifest);
        let files = manifest.entries.len();
        // whole: present before the spawn, verified once hashed
        let integrity = Arc::new(Integrity::new());
        let lines = presence_at(&integrity, &embedded, Some(fx.install.clone()), false, PRESENCE_BUDGET);
        assert_eq!(integrity.verdict(), Verdict::Checking { files });
        assert!(lines[0].contains("present at their shipped sizes"), "{lines:?}");
        let logged = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&logged);
        start_content_pass(&integrity, move |line| sink.lock().unwrap().push(line));
        assert_eq!(integrity.wait_settled(Duration::from_secs(10)), Verdict::Verified { files });
        // the content pass logs after it settles; give its thread the moment it needs
        for _ in 0..100 {
            if !logged.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(logged.lock().unwrap().iter().any(|l| l.starts_with("install-integrity: verified")));
        start_content_pass(&integrity, |_| panic!("the content pass runs once"));
        // a zeroed module is named before the spawn, and the failure text does not wait for the hash
        fs::write(installed_path(&fx.install, "sidecar/tools/builtin/shell.js"), b"").unwrap();
        let integrity = Arc::new(Integrity::new());
        let lines = presence_at(&integrity, &embedded, Some(fx.install.clone()), false, PRESENCE_BUDGET);
        assert!(lines.iter().any(|l| l.contains("sidecar/tools/builtin/shell.js is empty")), "{lines:?}");
        assert!(integrity.verdict_for_failure(Duration::from_secs(60)).is_damaged());
        // a spent bound stops the stat pass and leaves the rest to the content pass: the spawn is never held
        let integrity = Arc::new(Integrity::new());
        let lines = presence_at(&integrity, &embedded, Some(fx.install.clone()), false, Duration::ZERO);
        assert!(lines.iter().any(|l| l.contains("stopped at its 0 ms bound after 0 of")), "{lines:?}");
        assert_eq!(integrity.verdict(), Verdict::Checking { files });
        start_content_pass(&integrity, |_| {});
        assert!(integrity.wait_settled(Duration::from_secs(10)).is_damaged());
    }

    #[test]
    fn missing_sidecar_tree_keeps_the_install_diagnosable() {
        for layout in ["windows", "macos", "linux"] {
            for replace_with_file in [false, true] {
                let fx = Fixture::new("missing-tree");
                let manifest = fx.manifest();
                let embedded = to_json(&manifest);
                let package = fx.dir.join("package");
                let (root, exe) = match layout {
                    "macos" => (package.join("Contents/Resources"), package.join("Contents/MacOS/StarNet")),
                    "linux" => (package.join("lib").join(PRODUCT_NAME), package.join("bin/starnet")),
                    _ => (package.clone(), package.join("skynet-desktop.exe")),
                };
                copy_tree(&fx.install, &root);
                put(&exe, b"fixture executable");
                fs::remove_dir_all(root.join("sidecar")).unwrap();
                if replace_with_file { put(&root.join("sidecar"), b"broken folder"); }
                let candidates = root_candidates(&exe);
                let found = install_root(&candidates);
                assert!(found.is_some(), "{layout}: other bundled resources still identify the damaged install");
                let found = found.unwrap();
                assert_eq!(fs::canonicalize(&found).unwrap(), fs::canonicalize(&root).unwrap());
                let verdict = verify_install(&embedded, Some(&found));
                assert!(verdict.is_damaged(), "{layout}: {verdict:?}");
                let expected = manifest.entries.iter().filter(|e| e.path.starts_with("sidecar/")).count();
                assert_eq!(verdict.findings().len(), expected);
                assert!(verdict.findings().iter().all(|f| f.path.starts_with("sidecar/")));
                let integrity = Integrity::new();
                presence_at(&integrity, &embedded, Some(found), false, PRESENCE_BUDGET);
                assert!(integrity.verdict().is_damaged(), "startup must name the missing tree before spawn");
            }
        }
        let lone = scratch("lone-executable");
        put(&lone.join("skynet-desktop.exe"), b"fixture executable");
        assert_eq!(install_root(&root_candidates(&lone.join("skynet-desktop.exe"))), None,
            "an executable alone remains not checked, never a claimed install");
        fs::remove_dir_all(lone).unwrap();
    }

    #[test]
    fn headless_verify_exits_by_verdict() {
        let fx = Fixture::new("headless");
        let embedded = to_json(&fx.manifest());
        let out = fx.dir.join("receipt.json");
        let run = |extra: &[&str]| {
            let mut argv: Vec<OsString> = vec!["skynet-desktop".into(), VERIFY_FLAG.into()];
            argv.extend(extra.iter().map(OsString::from));
            verify_install_main(argv, &embedded)
        };
        let root = fx.install.to_string_lossy().into_owned();
        let out_path = out.to_string_lossy().into_owned();
        assert_eq!(run(&["--root", &root, "--out", &out_path]), Some(EXIT_VERIFIED));
        let receipt: serde_json::Value = serde_json::from_str(&fs::read_to_string(&out).unwrap()).unwrap();
        assert_eq!(receipt["state"], "verified");
        assert_eq!(receipt["exitCode"], 0);
        fs::write(installed_path(&fx.install, "sidecar/tools/builtin/shell.js"), b"").unwrap();
        assert_eq!(run(&["--root", &root, "--out", &out_path]), Some(EXIT_DAMAGED));
        let receipt: serde_json::Value = serde_json::from_str(&fs::read_to_string(&out).unwrap()).unwrap();
        assert_eq!(receipt["findings"][0]["path"], "sidecar/tools/builtin/shell.js");
        assert_eq!(receipt["findings"][0]["damage"], "empty");
        assert_eq!(run(&["--root"]), Some(EXIT_USAGE));
        assert_eq!(run(&["--bogus"]), Some(EXIT_USAGE));
        assert_eq!(verify_install_main(vec![OsString::from("skynet-desktop")], &embedded), None);
        assert_eq!(verify_install_main(vec![OsString::from("skynet-desktop"), OsString::from("--background")], &embedded), None);
        // install roots: the folder holding sidecar/, beside the exe (Windows) or in Contents/Resources (macOS)
        let mac = fx.dir.join("StarNet.app").join("Contents");
        fs::create_dir_all(mac.join("MacOS")).unwrap();
        fs::create_dir_all(mac.join("Resources").join("sidecar")).unwrap();
        let found = install_root(&root_candidates(&mac.join("MacOS").join("StarNet"))).unwrap();
        assert!(found.join("sidecar").is_dir() && found.ends_with("Resources"), "{found:?}");
        assert_eq!(install_root(&root_candidates(&fx.install.join("skynet-desktop.exe"))), Some(fx.install.clone()));
    }
}
