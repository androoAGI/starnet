//! THE UPDATE'S OWN SIGNER, CHECKED BEFORE IT RUNS (GHSA-2hpj-9wm7-rvg5 #10, 2026-11-08).
//!
//! tauri-plugin-updater checks one thing: a minisign signature from the updater key. Whoever holds that key (or its
//! passphrase) could ship any bytes as "the next StarNet", and the plugin would swap them in (macOS) or run them
//! (Windows). The release train already signs every build with the platform's own code signing, so the shell now
//! asks the platform whether the new build carries THAT signer before the plugin installs it:
//!
//!   - macOS: the downloaded .app.tar.gz is unpacked into a private scratch folder, exactly as the plugin will unpack
//!     it, and `codesign --verify --deep --strict` must accept the bundle against a designated requirement pinned to
//!     a Developer ID Application certificate of StarNet's Apple team and StarNet's bundle identifier. The team is
//!     the one the release train signed THIS copy with (read from the running bundle's own signature; the Team ID is
//!     a CI secret, not in the repo), or STARNET_MAC_TEAM_ID when the build sets it. A copy with no team (an ad-hoc
//!     or unsigned build) has nothing to check against and is refused. The archive itself must be a plain bundle:
//!     one top folder, no `..`, no hard links or device files, no write through a link, no duplicate path.
//!   - Windows: the installer bytes are written to a private scratch file and Get-AuthenticodeSignature must say
//!     Valid, embedded, with exactly one CN equal to WINDOWS_PUBLISHER_CN: the publisher the release train asserts
//!     on every installer it ships (release-train.yml, Assert-Authenticode 'CN=Andrew Sims(?:,|$)').
//!   - Linux (AppImage): no platform signer exists; minisign stays the only check.
//!
//! The plugin then installs the SAME in-memory bytes (Update::install), so what was checked is what runs. Every
//! refusal says "signature" so the Update Center words it as a refused download (frontend/app/updates.js), and
//! nothing has been installed or moved when it is returned.
//!
//! Everything that decides is a small pure function, tested below (`rustc --edition 2021 --test` on a scratch crate
//! with tar + flate2, or `cargo test`). What only a real Mac or a real signed installer can prove is named in the
//! commit: the codesign run against a shipped .app.tar.gz, and Get-AuthenticodeSignature on a shipped installer.

// Outside tests each platform calls only its own half (macOS the archive + codesign, Windows Authenticode, Linux
// neither); the tests below call every item on every platform, so a test build still reports real dead code.
#![cfg_attr(not(test), allow(dead_code))]

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The Windows publisher every shipped installer is asserted to carry (release-train.yml Assert-Authenticode).
pub const WINDOWS_PUBLISHER_CN: &str = "Andrew Sims";
/// A macOS Team ID baked in at build time, when the release build sets it; otherwise the running copy's own team.
const MAC_TEAM_PIN: Option<&str> = option_env!("STARNET_MAC_TEAM_ID");
/// Upper bounds on what the scratch unpack may write (a shipped StarNet.app is well under both).
pub const MAX_ARCHIVE_ENTRIES: usize = 250_000;
pub const MAX_UNPACKED_BYTES: u64 = 4 * 1024 * 1024 * 1024;

const CODESIGN: &str = "/usr/bin/codesign";
const CODESIGN_SHOW_LIMIT: Duration = Duration::from_secs(60);
const CODESIGN_VERIFY_LIMIT: Duration = Duration::from_secs(600);
const AUTHENTICODE_LIMIT: Duration = Duration::from_secs(120);

/// The copy has no Apple team to pin the update to. Worded without "signature"/"download" so the Update Center shows
/// it as written (updates.js), and it starts like update_staging.rs's own refusals.
pub const MAC_NO_TEAM: &str = "StarNet can't update itself: this copy has no Developer ID team to check the new version against. Nothing was installed; get the new version from the StarNet website.";

// ------------------------------------------------------------------------------------------------ the entry point

/// Check the downloaded update before the plugin installs it. Ok(()) means: install these exact bytes.
#[cfg(target_os = "macos")]
pub fn verify_update_bytes(bytes: &[u8]) -> Result<(), String> {
    verify_macos_update(bytes)
}
#[cfg(windows)]
pub fn verify_update_bytes(bytes: &[u8]) -> Result<(), String> {
    verify_windows_update(bytes)
}
#[cfg(not(any(target_os = "macos", windows)))]
pub fn verify_update_bytes(_bytes: &[u8]) -> Result<(), String> {
    Ok(())
}

// ------------------------------------------------------------------------------------------------ macOS: the pin

/// The running copy's signing identity, as `codesign -d --verbose=2` prints it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MacIdentity {
    pub identifier: String,
    pub team: String,
}

/// A Team ID is ten upper-case letters or digits.
pub fn valid_team_id(team: &str) -> bool {
    team.len() == 10
        && team
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

/// A bundle identifier StarNet can put inside a quoted requirement string: reverse-DNS characters only.
pub fn valid_bundle_identifier(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 255
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        && !id.starts_with('.')
        && !id.ends_with('.')
}

/// `Identifier=` and `TeamIdentifier=` from codesign's display output (it prints to stderr; pass both streams).
/// None when either is missing or unusable ("TeamIdentifier=not set" on an ad-hoc signature).
pub fn parse_codesign_display(output: &str) -> Option<MacIdentity> {
    let field = |key: &str| {
        output
            .lines()
            .find_map(|line| line.trim_end_matches('\r').strip_prefix(key).map(str::trim))
            .map(str::to_string)
    };
    let identifier = field("Identifier=")?;
    let team = field("TeamIdentifier=")?;
    if valid_bundle_identifier(&identifier) && valid_team_id(&team) {
        Some(MacIdentity { identifier, team })
    } else {
        None
    }
}

/// Which identity the update must carry: the running copy's, cross-checked against a team baked in at build time.
pub fn choose_mac_pin(
    compiled_team: Option<&str>,
    running: Option<&MacIdentity>,
) -> Result<MacIdentity, String> {
    let running = running.ok_or_else(|| MAC_NO_TEAM.to_string())?;
    if let Some(team) = compiled_team.map(str::trim).filter(|t| !t.is_empty()) {
        if !valid_team_id(team) {
            return Err(format!("the code signature check could not run: the team this StarNet was built for ({team}) is not a Team ID. Nothing was installed."));
        }
        if team != running.team {
            return Err(format!(
                "the code signature check refused the update: this StarNet is signed by team {} but was built for team {team}. Nothing was installed.",
                running.team
            ));
        }
    }
    Ok(running.clone())
}

/// The designated requirement for a Developer ID Application build of `identifier` by `team`: Apple's anchor, the
/// Developer ID intermediate (1.2.840.113635.100.6.2.6), a Developer ID Application leaf (1.2.840.113635.100.6.1.13)
/// and the team as the leaf's OU. Refuses anything that could break out of the quoted strings.
pub fn designated_requirement(identifier: &str, team: &str) -> Result<String, String> {
    if !valid_bundle_identifier(identifier) || !valid_team_id(team) {
        return Err("the code signature check could not run: the running StarNet's identity is unreadable. Nothing was installed.".to_string());
    }
    Ok(format!(
        "anchor apple generic and identifier \"{identifier}\" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"{team}\""
    ))
}

/// /Applications/StarNet.app for /Applications/StarNet.app/Contents/MacOS/StarNet (the plugin's extract_path).
pub fn bundle_of_executable(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    if macos.file_name()? != OsStr::new("MacOS") {
        return None;
    }
    let contents = macos.parent()?;
    if contents.file_name()? != OsStr::new("Contents") {
        return None;
    }
    let app = contents.parent()?;
    if app.extension()? != OsStr::new("app") {
        return None;
    }
    Some(app.to_path_buf())
}

pub fn codesign_display_args(bundle: &Path) -> Vec<OsString> {
    vec![
        "-d".into(),
        "--verbose=2".into(),
        bundle.as_os_str().to_os_string(),
    ]
}

/// `-R` takes the requirement as its own argument; the leading '=' marks it as requirement text, not a file path.
pub fn codesign_verify_args(bundle: &Path, requirement: &str) -> Vec<OsString> {
    vec![
        "--verify".into(),
        "--deep".into(),
        "--strict".into(),
        "--verbose=2".into(),
        "-R".into(),
        format!("={requirement}").into(),
        bundle.as_os_str().to_os_string(),
    ]
}

// ------------------------------------------------------------------------------------------------ macOS: the archive

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Dir,
    File,
    Symlink,
    HardLink,
    Other,
}

/// The rules every entry of the update archive must pass before anything is written for it. The plugin unpacks each
/// entry at `<its temp dir>/<path minus its first component>` with tar's Entry::unpack (not unpack_in: no path checks
/// of its own), so this plan is the only thing between the archive and the disk on the scratch unpack, and what it
/// admits is exactly what the plugin will write.
#[derive(Default)]
pub struct ArchivePlan {
    root: Option<OsString>,
    seen: HashSet<String>,
    links: HashSet<String>,
    entries: usize,
    bytes: u64,
}

/// Case-folded path key: macOS volumes are case-insensitive by default, so "Contents/Lnk" and "contents/lnk" are one.
fn fold(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

/// A link's target must stay inside the bundle when read from the link's own folder: relative, and never above the top.
pub fn link_stays_inside(link: &Path, target: &Path) -> bool {
    if target.as_os_str().is_empty() {
        return false;
    }
    let mut depth: usize = link.parent().map(|p| p.components().count()).unwrap_or(0);
    for part in target.components() {
        match part {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir => {
                if depth == 0 {
                    return false;
                }
                depth -= 1;
            }
            Component::RootDir | Component::Prefix(_) => return false,
        }
    }
    true
}

impl ArchivePlan {
    /// Admit one entry: Ok(its path inside the bundle) or Err(why the whole update is refused).
    pub fn admit(
        &mut self,
        raw: &Path,
        kind: EntryKind,
        link: Option<&Path>,
        size: u64,
    ) -> Result<PathBuf, String> {
        let shown = raw.display();
        self.entries += 1;
        if self.entries > MAX_ARCHIVE_ENTRIES {
            return Err(format!("it has more than {MAX_ARCHIVE_ENTRIES} entries"));
        }
        self.bytes = self.bytes.saturating_add(size);
        if self.bytes > MAX_UNPACKED_BYTES {
            return Err("it unpacks to more than 4 GB".to_string());
        }
        let mut parts = raw.components();
        let top = match parts.next() {
            Some(Component::Normal(name)) if name.to_string_lossy().ends_with(".app") => {
                name.to_os_string()
            }
            _ => return Err(format!("{shown} is not inside one .app folder")),
        };
        match &self.root {
            None => self.root = Some(top),
            Some(root) if *root == top => {}
            Some(_) => return Err(format!("{shown} is in a second top folder")),
        }
        let mut rel = PathBuf::new();
        for part in parts {
            match part {
                Component::Normal(name) => rel.push(name),
                _ => return Err(format!("{shown} leaves its folder")),
            }
        }
        match kind {
            EntryKind::HardLink => return Err(format!("{shown} is a hard link")),
            EntryKind::Other => return Err(format!("{shown} is not a file, folder or link")),
            _ => {}
        }
        if rel.as_os_str().is_empty() && kind != EntryKind::Dir {
            return Err(format!("{shown} replaces the app folder itself"));
        }
        // nothing may be written through a link the archive made (case-folded, as the volume will resolve it)
        let mut prefix = PathBuf::new();
        if let Some(parent) = rel.parent() {
            for part in parent.components() {
                prefix.push(part);
                if self.links.contains(&fold(&prefix)) {
                    return Err(format!("{shown} is written through a link"));
                }
            }
        }
        if !self.seen.insert(fold(&rel)) {
            return Err(format!("{shown} appears twice"));
        }
        if kind == EntryKind::Symlink {
            let target = link.ok_or_else(|| format!("{shown} is a link with no target"))?;
            if !link_stays_inside(&rel, target) {
                return Err(format!("{shown} links outside the app"));
            }
            self.links.insert(fold(&rel));
        }
        Ok(rel)
    }

    pub fn finish(&self) -> Result<(), String> {
        if self.root.is_none() {
            return Err("it is empty".to_string());
        }
        Ok(())
    }
}

/// The disk agrees with the plan: no folder between `root` and `rel` is a link (a link made by an earlier entry under
/// a different spelling the volume treats as the same name).
pub fn no_link_between(root: &Path, rel: &Path) -> Result<(), String> {
    let mut at = root.to_path_buf();
    if let Some(parent) = rel.parent() {
        for part in parent.components() {
            at.push(part);
            match std::fs::symlink_metadata(&at) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(format!("{} is written through a link", rel.display()))
                }
                _ => {}
            }
        }
    }
    Ok(())
}

pub fn entry_kind(header: &tar::Header, raw_path_bytes: &[u8]) -> EntryKind {
    let kind = header.entry_type();
    if kind.is_dir() {
        EntryKind::Dir
    } else if kind.is_hard_link() {
        EntryKind::HardLink
    } else if kind.is_symlink() {
        EntryKind::Symlink
    } else if kind.is_file() {
        // tar unpacks an old-style header whose name ends in '/' as a folder: never let a "file" be one
        if raw_path_bytes.ends_with(b"/") {
            EntryKind::Other
        } else {
            EntryKind::File
        }
    } else {
        EntryKind::Other
    }
}

/// Unpack the update archive into `app` (a new folder) entry by entry, as tauri-plugin-updater 2.10.1's macOS
/// install_inner does (path minus its first component, Entry::unpack with the archive defaults), after the plan and
/// the disk both admit each entry.
pub fn unpack_app_archive(bytes: &[u8], app: &Path) -> Result<(), String> {
    let bad = |why: String| {
        format!("the code signature check refused the update: its archive is malformed ({why}). Nothing was installed.")
    };
    // a read or write error (a damaged gzip, a full disk) is not proof of a hostile archive: say what happened
    let io = |e: std::io::Error| {
        format!(
            "the code signature check could not unpack the update ({e}). Nothing was installed."
        )
    };
    std::fs::create_dir(app).map_err(io)?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(std::io::Cursor::new(bytes)));
    let mut plan = ArchivePlan::default();
    for entry in archive.entries().map_err(io)? {
        let mut entry = entry.map_err(io)?;
        let raw = entry.path().map_err(io)?.into_owned();
        let kind = entry_kind(entry.header(), &entry.path_bytes());
        let target = if kind == EntryKind::Symlink {
            entry.link_name().map_err(io)?.map(|t| t.into_owned())
        } else {
            None
        };
        let rel = plan
            .admit(&raw, kind, target.as_deref(), entry.size())
            .map_err(bad)?;
        no_link_between(app, &rel).map_err(bad)?;
        let out = app.join(&rel);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(io)?;
        }
        entry.unpack(&out).map_err(io)?;
    }
    plan.finish().map_err(bad)
}

/// One line of codesign's verdict for the person (its last words, which name the failure).
pub fn verdict_excerpt(output: &str) -> String {
    let joined = output.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = joined.chars().collect();
    if chars.len() <= 300 {
        joined
    } else {
        format!("…{}", chars[chars.len() - 300..].iter().collect::<String>())
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn verify_macos_update(bytes: &[u8]) -> Result<(), String> {
    let running = std::env::current_exe()
        .ok()
        .and_then(|exe| bundle_of_executable(&exe))
        .ok_or_else(|| MAC_NO_TEAM.to_string())?;
    let shown = run_bounded(
        command(CODESIGN, codesign_display_args(&running)),
        CODESIGN_SHOW_LIMIT,
    )?;
    let identity = parse_codesign_display(&shown.output);
    let pin = choose_mac_pin(MAC_TEAM_PIN, identity.as_ref())?;
    let requirement = designated_requirement(&pin.identifier, &pin.team)?;
    let scratch = Scratch::new()?;
    let app = scratch.path().join("StarNet.app");
    unpack_app_archive(bytes, &app)?;
    let verdict = run_bounded(
        command(CODESIGN, codesign_verify_args(&app, &requirement)),
        CODESIGN_VERIFY_LIMIT,
    )?;
    if !verdict.ok {
        return Err(format!(
            "the code signature check refused the update: the new StarNet.app is not signed by StarNet's Developer ID team ({}). Nothing was installed. codesign: {}",
            pin.team,
            verdict_excerpt(&verdict.output)
        ));
    }
    Ok(())
}

// ------------------------------------------------------------------------------------------------ Windows

/// The installer kind from its first bytes: an .exe (NSIS, "MZ") or an .msi (OLE compound file). Anything else, a zip
/// included (createUpdaterArtifacts is true, so StarNet ships the signed setup .exe itself), is refused.
pub fn windows_installer_extension(bytes: &[u8]) -> Option<&'static str> {
    const OLE: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    if bytes.len() >= 2 && bytes[..2] == *b"MZ" {
        Some("exe")
    } else if bytes.len() >= 8 && bytes[..8] == OLE {
        Some("msi")
    } else {
        None
    }
}

/// Get-AuthenticodeSignature on the path in STARNET_UPDATE_NEW, as three `key=value` lines. Single-quoted strings
/// only and no type literals, so it passes through the command line unchanged and runs in Constrained Language Mode.
pub const AUTHENTICODE_SCRIPT: &str = "$ErrorActionPreference = 'Stop'; $s = Get-AuthenticodeSignature -LiteralPath $env:STARNET_UPDATE_NEW; $c = $s.SignerCertificate; $subject = ''; if ($null -ne $c) { $subject = ($c.Subject -replace '[\\r\\n]', ' ') }; Write-Output ('status=' + $s.Status); Write-Output ('type=' + $s.SignatureType); Write-Output ('subject=' + $subject)";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AuthenticodeReport {
    pub status: String,
    pub signature_type: String,
    pub subject: String,
}

pub fn parse_authenticode_report(output: &str) -> AuthenticodeReport {
    let mut report = AuthenticodeReport::default();
    for line in output.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(v) = line.strip_prefix("status=") {
            report.status = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("type=") {
            report.signature_type = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("subject=") {
            report.subject = v.trim().to_string();
        }
    }
    report
}

/// Every CN in an X.500 name as .NET prints it ("CN=Andrew Sims, O=Andrew Sims, C=US"; a value with a separator
/// in it is double-quoted, "" inside quotes is a quote). '+' (a multi-valued RDN) separates attributes too.
pub fn common_names(subject: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut chars = subject.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' if quoted && chars.peek() == Some(&'"') => {
                chars.next();
                current.push('"');
            }
            '"' => quoted = !quoted,
            ',' | ';' | '+' if !quoted => parts.push(std::mem::take(&mut current)),
            _ => current.push(ch),
        }
    }
    parts.push(current);
    parts
        .iter()
        .filter_map(|part| part.split_once('='))
        .filter(|(key, _)| key.trim().eq_ignore_ascii_case("CN"))
        .map(|(_, value)| value.trim().to_string())
        .collect()
}

/// The release's publisher, or why not: Valid, embedded (not a catalog's), and exactly one CN equal to the pin.
pub fn judge_authenticode(report: &AuthenticodeReport) -> Result<(), String> {
    if report.status != "Valid" {
        let status = if report.status.is_empty() {
            "unreadable"
        } else {
            report.status.as_str()
        };
        return Err(format!(
            "the code signature check refused the update: the installer's Authenticode signature is {status}, not a valid signature from {WINDOWS_PUBLISHER_CN}. Nothing was installed."
        ));
    }
    if !report.signature_type.is_empty() && report.signature_type != "Authenticode" {
        return Err(format!(
            "the code signature check refused the update: the installer carries no signature of its own ({}). Nothing was installed.",
            report.signature_type
        ));
    }
    let names = common_names(&report.subject);
    if names.len() != 1 || names[0] != WINDOWS_PUBLISHER_CN {
        return Err(format!(
            "the code signature check refused the update: the installer is signed by \"{}\", not StarNet's publisher {WINDOWS_PUBLISHER_CN}. Nothing was installed.",
            report.subject
        ));
    }
    Ok(())
}

#[cfg_attr(not(windows), allow(dead_code))]
fn powershell_path() -> PathBuf {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from("C:\\Windows"));
    PathBuf::from(root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

#[cfg_attr(not(windows), allow(dead_code))]
fn verify_windows_update(bytes: &[u8]) -> Result<(), String> {
    let ext = windows_installer_extension(bytes).ok_or_else(|| {
        "the code signature check refused the update: the download is not a Windows installer (.exe or .msi) StarNet can check. Nothing was installed.".to_string()
    })?;
    let scratch = Scratch::new()?;
    let file = scratch.path().join(format!("StarNet-update.{ext}"));
    std::fs::write(&file, bytes)
        .map_err(|e| format!("the code signature check could not run: the installer could not be saved for checking ({e}). Nothing was installed."))?;
    let mut cmd = command(
        powershell_path(),
        [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            AUTHENTICODE_SCRIPT,
        ]
        .iter()
        .map(OsString::from)
        .collect(),
    );
    cmd.env("STARNET_UPDATE_NEW", &file);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let ran = run_bounded(cmd, AUTHENTICODE_LIMIT)?;
    judge_authenticode(&parse_authenticode_report(&ran.output))
}

// ------------------------------------------------------------------------------------------------ shared plumbing

/// A private folder under the temp dir, removed (never following links) when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self, String> {
        let base = std::env::temp_dir();
        for attempt in 0..16u32 {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = base.join(format!(
                "starnet-update-verify-{}-{nanos}-{attempt}",
                std::process::id()
            ));
            match std::fs::create_dir(&dir) {
                Ok(()) => return Ok(Scratch(dir)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => {
                    return Err(format!("the code signature check could not run: no scratch folder ({e}). Nothing was installed."))
                }
            }
        }
        Err(
            "the code signature check could not run: no scratch folder. Nothing was installed."
                .to_string(),
        )
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Ran {
    ok: bool,
    output: String,
}

fn command(program: impl AsRef<OsStr>, args: Vec<OsString>) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args);
    cmd
}

/// Run a check with its output captured (both pipes drained on threads, so a chatty child never stalls) and a time
/// limit. On the limit, only OUR child is killed, through its own handle.
fn run_bounded(mut cmd: Command, limit: Duration) -> Result<Ran, String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| {
        format!("the code signature check could not run ({e}). Nothing was installed.")
    })?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        })
    };
    let out = drain(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let err = drain(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(
                    "the code signature check timed out. Nothing was installed.".to_string()
                );
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "the code signature check could not finish ({e}). Nothing was installed."
                ));
            }
        }
    };
    let mut output = String::from_utf8_lossy(&out.join().unwrap_or_default()).into_owned();
    output.push('\n');
    output.push_str(&String::from_utf8_lossy(&err.join().unwrap_or_default()));
    Ok(Ran {
        ok: status.success(),
        output,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const TEAM: &str = "AB12CD34EF";

    #[test]
    fn team_ids_and_identifiers() {
        assert!(valid_team_id(TEAM));
        for bad in [
            "",
            "ab12cd34ef",
            "AB12CD34E",
            "AB12CD34EFG",
            "AB12CD34E\"",
            "not set",
        ] {
            assert!(!valid_team_id(bad), "{bad}");
        }
        assert!(valid_bundle_identifier("ai.skynet.harness"));
        for bad in ["", ".ai", "ai.", "ai\"x", "ai x", "ai\\x", "ai\nx"] {
            assert!(!valid_bundle_identifier(bad), "{bad:?}");
        }
    }

    #[test]
    fn parses_codesign_display_from_either_stream() {
        let shown = "Executable=/Applications/StarNet.app/Contents/MacOS/StarNet\nIdentifier=ai.skynet.harness\r\nFormat=app bundle with Mach-O thin (arm64)\nAuthority=Developer ID Application: Andrew Sims (AB12CD34EF)\nTeamIdentifier=AB12CD34EF\n";
        assert_eq!(
            parse_codesign_display(shown),
            Some(MacIdentity {
                identifier: "ai.skynet.harness".into(),
                team: TEAM.into()
            })
        );
        // an ad-hoc copy has no team: nothing to pin to
        assert_eq!(
            parse_codesign_display(
                "Identifier=ai.skynet.harness\nSignature=adhoc\nTeamIdentifier=not set\n"
            ),
            None
        );
        assert_eq!(
            parse_codesign_display("code object is not signed at all\n"),
            None
        );
        assert_eq!(
            parse_codesign_display("Identifier=ai.sky\"net\nTeamIdentifier=AB12CD34EF\n"),
            None
        );
    }

    #[test]
    fn the_pin_is_the_running_team_cross_checked_with_the_build() {
        let me = MacIdentity {
            identifier: "ai.skynet.harness".into(),
            team: TEAM.into(),
        };
        assert_eq!(choose_mac_pin(None, Some(&me)), Ok(me.clone()));
        assert_eq!(choose_mac_pin(Some(""), Some(&me)), Ok(me.clone()));
        assert_eq!(choose_mac_pin(Some(TEAM), Some(&me)), Ok(me.clone()));
        assert!(choose_mac_pin(Some("ZZ12CD34EF"), Some(&me))
            .unwrap_err()
            .contains("built for team ZZ12CD34EF"));
        assert!(choose_mac_pin(Some("nope"), Some(&me)).is_err());
        let none = choose_mac_pin(Some(TEAM), None).unwrap_err();
        assert_eq!(none, MAC_NO_TEAM);
        // the Update Center shows this one as written: no word it would re-file as a refused or failed download
        assert!(!none.contains("signature") && !none.contains("download"));
    }

    #[test]
    fn the_requirement_pins_developer_id_team_and_identifier() {
        let dr = designated_requirement("ai.skynet.harness", TEAM).unwrap();
        assert_eq!(dr, "anchor apple generic and identifier \"ai.skynet.harness\" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"AB12CD34EF\"");
        assert!(designated_requirement("ai.x\" or anchor apple", TEAM).is_err());
        assert!(designated_requirement("ai.skynet.harness", "AB12\" or 1").is_err());
        let args = codesign_verify_args(Path::new("/tmp/x/StarNet.app"), &dr);
        let args: Vec<String> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            &args[..5],
            ["--verify", "--deep", "--strict", "--verbose=2", "-R"]
        );
        assert_eq!(args[5], format!("={dr}"));
        assert_eq!(args[6], "/tmp/x/StarNet.app");
        let shown: Vec<String> = codesign_display_args(Path::new("/A/StarNet.app"))
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(shown, ["-d", "--verbose=2", "/A/StarNet.app"]);
    }

    #[test]
    fn finds_the_bundle_of_the_running_executable() {
        assert_eq!(
            bundle_of_executable(Path::new(
                "/Applications/StarNet.app/Contents/MacOS/StarNet"
            )),
            Some(PathBuf::from("/Applications/StarNet.app"))
        );
        assert_eq!(
            bundle_of_executable(Path::new("/usr/local/bin/starnet")),
            None
        );
        assert_eq!(
            bundle_of_executable(Path::new("/Applications/StarNet/Contents/MacOS/StarNet")),
            None
        );
    }

    #[test]
    fn the_plan_admits_a_plain_bundle() {
        let mut plan = ArchivePlan::default();
        assert_eq!(
            plan.admit(Path::new("StarNet.app"), EntryKind::Dir, None, 0),
            Ok(PathBuf::new())
        );
        assert_eq!(
            plan.admit(Path::new("StarNet.app/Contents"), EntryKind::Dir, None, 0),
            Ok(PathBuf::from("Contents"))
        );
        assert_eq!(
            plan.admit(
                Path::new("StarNet.app/Contents/MacOS/StarNet"),
                EntryKind::File,
                None,
                10
            ),
            Ok(PathBuf::from("Contents/MacOS/StarNet"))
        );
        // an inside link (node_modules/.bin style) is fine, and so is a file beside it
        assert!(plan
            .admit(
                Path::new("StarNet.app/Contents/Resources/bin/x"),
                EntryKind::Symlink,
                Some(Path::new("../lib/x.js")),
                0
            )
            .is_ok());
        assert!(plan
            .admit(
                Path::new("StarNet.app/Contents/Resources/bin/y"),
                EntryKind::File,
                None,
                1
            )
            .is_ok());
        assert_eq!(plan.finish(), Ok(()));
        assert!(
            ArchivePlan::default().finish().is_err(),
            "an empty archive is refused"
        );
    }

    #[test]
    fn the_plan_refuses_what_could_land_outside_or_diverge() {
        let refuse = |entries: &[(&str, EntryKind, Option<&str>)]| -> String {
            let mut plan = ArchivePlan::default();
            for (path, kind, link) in entries {
                if let Err(why) = plan.admit(Path::new(path), *kind, link.map(Path::new), 0) {
                    return why;
                }
            }
            panic!("admitted {entries:?}");
        };
        use EntryKind::*;
        assert!(refuse(&[("StarNet.app/../../x", File, None)]).contains("leaves its folder"));
        assert!(refuse(&[("StarNet.app/Contents/../../../x", File, None)])
            .contains("leaves its folder"));
        assert!(refuse(&[("/StarNet.app/x", File, None)]).contains("one .app folder"));
        assert!(refuse(&[("./StarNet.app/x", File, None)]).contains("one .app folder"));
        assert!(refuse(&[("payload/x", File, None)]).contains("one .app folder"));
        assert!(refuse(&[("A.app/x", File, None), ("B.app/y", File, None)])
            .contains("second top folder"));
        assert!(refuse(&[("StarNet.app/x", HardLink, Some("/etc/passwd"))]).contains("hard link"));
        assert!(refuse(&[("StarNet.app/dev", Other, None)]).contains("not a file"));
        assert!(refuse(&[("StarNet.app", Symlink, Some("/"))]).contains("app folder itself"));
        assert!(refuse(&[("StarNet.app", File, None)]).contains("app folder itself"));
        assert!(
            refuse(&[("StarNet.app/a", File, None), ("StarNet.app/a", File, None)])
                .contains("twice")
        );
        assert!(refuse(&[
            ("StarNet.app/Contents/A", File, None),
            ("StarNet.app/contents/a", File, None)
        ])
        .contains("twice"));
        assert!(refuse(&[(
            "StarNet.app/l",
            Symlink,
            Some("/Users/x/Library/LaunchAgents")
        )])
        .contains("outside"));
        assert!(
            refuse(&[("StarNet.app/Contents/l", Symlink, Some("../../x"))]).contains("outside")
        );
        assert!(refuse(&[("StarNet.app/l", Symlink, None)]).contains("no target"));
        assert!(refuse(&[("StarNet.app/l", Symlink, Some(""))]).contains("outside"));
        // writing through a link the archive made, under any spelling the volume folds together
        assert!(refuse(&[
            ("StarNet.app/Contents/l", Symlink, Some("MacOS")),
            ("StarNet.app/Contents/l/evil", File, None)
        ])
        .contains("through a link"));
        assert!(refuse(&[
            ("StarNet.app/Contents/Lnk", Symlink, Some("MacOS")),
            ("StarNet.app/contents/lnk/x/evil", File, None)
        ])
        .contains("through a link"));
        // and the bounds
        let mut plan = ArchivePlan::default();
        assert!(plan
            .admit(
                Path::new("StarNet.app/big"),
                File,
                None,
                MAX_UNPACKED_BYTES + 1
            )
            .unwrap_err()
            .contains("4 GB"));
    }

    #[test]
    fn links_are_read_from_their_own_folder() {
        assert!(link_stays_inside(
            Path::new("Contents/Resources/bin/x"),
            Path::new("../lib/x.js")
        ));
        assert!(link_stays_inside(
            Path::new("Contents/Frameworks/F.framework/Current"),
            Path::new("Versions/A")
        ));
        assert!(link_stays_inside(Path::new("Contents/a"), Path::new("./b")));
        assert!(
            link_stays_inside(Path::new("Contents/a"), Path::new("..")),
            "the app folder itself is inside"
        );
        assert!(!link_stays_inside(
            Path::new("Contents/a"),
            Path::new("../..")
        ));
        assert!(!link_stays_inside(Path::new("a"), Path::new("..")));
        assert!(!link_stays_inside(
            Path::new("Contents/a"),
            Path::new("/etc")
        ));
    }

    fn scratch_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "update-verify-test-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir(&dir).unwrap();
        dir
    }

    fn header(kind: tar::EntryType, size: u64) -> tar::Header {
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(kind);
        h.set_size(size);
        h.set_mode(if kind == tar::EntryType::Directory {
            0o755
        } else {
            0o644
        });
        h
    }

    /// A gzipped tar the way tauri-bundler writes one (GNU headers, long names), plus whatever raw entries a test adds.
    fn archive(entries: &[(&str, tar::EntryType, &[u8], Option<&str>)]) -> Vec<u8> {
        let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut builder = tar::Builder::new(gz);
        for (path, kind, data, link) in entries {
            let mut h = header(*kind, data.len() as u64);
            if let Some(target) = link {
                builder.append_link(&mut h, path, target).unwrap();
            } else if path.contains("..") || path.starts_with('/') {
                // tar::Builder refuses these names itself; write the raw bytes as a hostile archive would
                let name = h.as_old_mut().name.as_mut();
                name[..path.len()].copy_from_slice(path.as_bytes());
                h.set_cksum();
                builder.append(&h, *data).unwrap();
            } else {
                builder.append_data(&mut h, path, *data).unwrap();
            }
        }
        let gz = builder.into_inner().unwrap();
        gz.finish().unwrap()
    }

    #[test]
    fn unpacks_a_bundle_where_the_plugin_will() {
        let dir = scratch_dir("ok");
        let long = format!(
            "StarNet.app/Contents/Resources/node_modules/{}/index.js",
            "deep".repeat(40)
        );
        let bytes = archive(&[
            ("StarNet.app", tar::EntryType::Directory, b"", None),
            (
                "StarNet.app/Contents/MacOS/StarNet",
                tar::EntryType::Regular,
                b"\xcf\xfa\xed\xfe",
                None,
            ),
            (
                "StarNet.app/Contents/Info.plist",
                tar::EntryType::Regular,
                b"<plist/>",
                None,
            ),
            (
                long.as_str(),
                tar::EntryType::Regular,
                b"module.exports = 1",
                None,
            ),
        ]);
        let app = dir.join("StarNet.app");
        unpack_app_archive(&bytes, &app).unwrap();
        assert_eq!(
            std::fs::read(app.join("Contents/Info.plist")).unwrap(),
            b"<plist/>"
        );
        assert_eq!(
            std::fs::read(app.join("Contents/MacOS/StarNet")).unwrap(),
            b"\xcf\xfa\xed\xfe"
        );
        assert!(
            app.join(&long["StarNet.app/".len()..]).is_file(),
            "a GNU long name lands at its full path"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_hostile_archive_writes_nothing_outside() {
        let dir = scratch_dir("hostile");
        for (i, bytes) in [
            archive(&[(
                "StarNet.app/../../escaped.txt",
                tar::EntryType::Regular,
                b"x",
                None,
            )]),
            archive(&[(
                "StarNet.app/x",
                tar::EntryType::Link,
                b"",
                Some("/etc/hosts"),
            )]),
            archive(&[("payload.txt", tar::EntryType::Regular, b"x", None)]),
            archive(&[
                ("StarNet.app/a", tar::EntryType::Regular, b"1", None),
                ("StarNet.app/a", tar::EntryType::Regular, b"2", None),
            ]),
            b"not a gzip at all".to_vec(),
        ]
        .iter()
        .enumerate()
        {
            let app = dir.join(format!("case{i}")).join("StarNet.app");
            std::fs::create_dir_all(app.parent().unwrap()).unwrap();
            let why = unpack_app_archive(bytes, &app).unwrap_err();
            assert!(
                why.contains("signature") && why.contains("Nothing was installed"),
                "{why}"
            );
        }
        assert!(
            !dir.join("escaped.txt").exists() && !dir.join("case0").join("escaped.txt").exists()
        );
        assert!(!std::env::temp_dir().join("escaped.txt").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_disk_check_catches_a_link_the_plan_cannot_spell() {
        let dir = scratch_dir("link");
        std::fs::create_dir(dir.join("app")).unwrap();
        std::os::unix::fs::symlink("/tmp", dir.join("app").join("Lnk")).unwrap();
        assert!(no_link_between(&dir.join("app"), Path::new("Lnk/evil")).is_err());
        assert!(no_link_between(&dir.join("app"), Path::new("other/evil")).is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_disk_check_passes_plain_folders() {
        let dir = scratch_dir("plain");
        std::fs::create_dir_all(dir.join("a/b")).unwrap();
        assert_eq!(no_link_between(&dir, Path::new("a/b/c")), Ok(()));
        assert_eq!(no_link_between(&dir, Path::new("top")), Ok(()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn installer_kinds_by_their_first_bytes() {
        assert_eq!(windows_installer_extension(b"MZ\x90\x00"), Some("exe"));
        assert_eq!(
            windows_installer_extension(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0]),
            Some("msi")
        );
        assert_eq!(
            windows_installer_extension(b"PK\x03\x04"),
            None,
            "a zip is not what StarNet ships"
        );
        assert_eq!(windows_installer_extension(b"M"), None);
        assert_eq!(windows_installer_extension(b""), None);
    }

    #[test]
    fn common_names_read_like_dotnet_prints_them() {
        assert_eq!(
            common_names("CN=Andrew Sims, O=Andrew Sims, L=Austin, S=Texas, C=US"),
            ["Andrew Sims"]
        );
        assert_eq!(
            common_names("O=\"Sims, Inc.\", CN=Andrew Sims"),
            ["Andrew Sims"]
        );
        assert_eq!(
            common_names("CN=\"Andrew Sims, Jr.\""),
            ["Andrew Sims, Jr."]
        );
        assert_eq!(common_names("CN=\"Say \"\"hi\"\"\""), ["Say \"hi\""]);
        assert_eq!(
            common_names("CN=Andrew Sims + CN=Mallory"),
            ["Andrew Sims", "Mallory"]
        );
        assert!(
            common_names("O=CN=Andrew Sims").is_empty(),
            "a CN inside another attribute's value is not a CN"
        );
        assert!(common_names("").is_empty());
    }

    #[test]
    fn judges_the_installer_signer() {
        let ok = AuthenticodeReport {
            status: "Valid".into(),
            signature_type: "Authenticode".into(),
            subject: "CN=Andrew Sims, O=Andrew Sims, L=Austin, S=Texas, C=US".into(),
        };
        assert_eq!(judge_authenticode(&ok), Ok(()));
        assert_eq!(
            judge_authenticode(&AuthenticodeReport {
                signature_type: String::new(),
                ..ok.clone()
            }),
            Ok(()),
            "an older PowerShell prints no type"
        );
        for (bad, says) in [
            (
                AuthenticodeReport {
                    status: "NotSigned".into(),
                    ..ok.clone()
                },
                "is NotSigned",
            ),
            (
                AuthenticodeReport {
                    status: "HashMismatch".into(),
                    ..ok.clone()
                },
                "is HashMismatch",
            ),
            (
                AuthenticodeReport {
                    status: String::new(),
                    ..ok.clone()
                },
                "is unreadable",
            ),
            (
                AuthenticodeReport {
                    signature_type: "Catalog".into(),
                    ..ok.clone()
                },
                "no signature of its own",
            ),
            (
                AuthenticodeReport {
                    subject: "CN=Andrew Simsx, O=x".into(),
                    ..ok.clone()
                },
                "not StarNet's publisher",
            ),
            (
                AuthenticodeReport {
                    subject: "CN=Mallory, O=CN=Andrew Sims".into(),
                    ..ok.clone()
                },
                "not StarNet's publisher",
            ),
            (
                AuthenticodeReport {
                    subject: "CN=Andrew Sims + CN=Mallory".into(),
                    ..ok.clone()
                },
                "not StarNet's publisher",
            ),
            (
                AuthenticodeReport {
                    subject: String::new(),
                    ..ok.clone()
                },
                "not StarNet's publisher",
            ),
        ] {
            let why = judge_authenticode(&bad).unwrap_err();
            assert!(
                why.contains(says)
                    && why.contains("signature")
                    && why.contains("Nothing was installed"),
                "{why}"
            );
        }
    }

    #[test]
    fn parses_the_powershell_report() {
        let r = parse_authenticode_report(
            "status=Valid\r\ntype=Authenticode\r\nsubject=CN=Andrew Sims, C=US\r\n",
        );
        assert_eq!(
            r,
            AuthenticodeReport {
                status: "Valid".into(),
                signature_type: "Authenticode".into(),
                subject: "CN=Andrew Sims, C=US".into()
            }
        );
        assert_eq!(
            parse_authenticode_report("Get-AuthenticodeSignature : Cannot find path\n"),
            AuthenticodeReport::default()
        );
        // the script itself: single quotes only, so the command line carries it unchanged
        assert!(
            !AUTHENTICODE_SCRIPT.contains('"')
                && AUTHENTICODE_SCRIPT.contains("$env:STARNET_UPDATE_NEW")
        );
    }

    #[test]
    fn verdict_excerpts_stay_short_and_on_one_line() {
        assert_eq!(verdict_excerpt("a\n  b\tc\n"), "a b c");
        let long = "x ".repeat(400);
        let e = verdict_excerpt(&long);
        assert!(e.starts_with('…') && e.chars().count() == 301);
    }

    #[test]
    fn a_bounded_run_captures_output_and_stops_at_its_limit() {
        #[cfg(windows)]
        let (quick, slow) = (
            command(
                "cmd",
                ["/C", "echo hi"].iter().map(OsString::from).collect(),
            ),
            command(
                "cmd",
                ["/C", "ping -n 30 127.0.0.1 >NUL"]
                    .iter()
                    .map(OsString::from)
                    .collect(),
            ),
        );
        #[cfg(not(windows))]
        let (quick, slow) = (
            command(
                "sh",
                ["-c", "echo hi; echo err >&2"]
                    .iter()
                    .map(OsString::from)
                    .collect(),
            ),
            command(
                "sh",
                ["-c", "sleep 30"].iter().map(OsString::from).collect(),
            ),
        );
        let ran = run_bounded(quick, Duration::from_secs(30)).unwrap();
        assert!(ran.ok && ran.output.contains("hi"));
        let started = Instant::now();
        let timed = run_bounded(slow, Duration::from_millis(500));
        assert!(timed.is_err() && started.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn each_platform_refuses_what_it_cannot_check() {
        // a test binary is not inside an .app: the macOS check has no team to pin to, and says so before anything else
        assert_eq!(verify_macos_update(b"junk"), Err(MAC_NO_TEAM.to_string()));
        // a zip (or anything but an .exe/.msi) is refused before PowerShell is asked
        let why = verify_windows_update(b"PK\x03\x04junk").unwrap_err();
        assert!(
            why.contains("not a Windows installer") && why.contains("signature"),
            "{why}"
        );
        let verdict = verify_update_bytes(b"junk");
        #[cfg(target_os = "macos")]
        assert_eq!(verdict, Err(MAC_NO_TEAM.to_string()));
        #[cfg(windows)]
        assert!(verdict.unwrap_err().contains("not a Windows installer"));
        #[cfg(not(any(target_os = "macos", windows)))]
        assert_eq!(verdict, Ok(()), "Linux: minisign stays the only check");
    }

    #[test]
    fn a_scratch_folder_is_private_and_removed() {
        let path = {
            let s = Scratch::new().unwrap();
            let mut f = std::fs::File::create(s.path().join("x")).unwrap();
            f.write_all(b"x").unwrap();
            s.path().to_path_buf()
        };
        assert!(!path.exists());
    }

    /// The real Windows check against signed files on this machine (no-op elsewhere): Microsoft's own signer is
    /// refused, and a StarNet installer named in STARNET_TEST_INSTALLER (optional) is admitted.
    #[cfg(windows)]
    #[test]
    fn the_real_authenticode_check() {
        let ps = std::fs::read(powershell_path()).unwrap();
        let why = verify_windows_update(&ps).unwrap_err();
        assert!(
            why.contains("not StarNet's publisher") || why.contains("no signature of its own"),
            "{why}"
        );
        if let Some(installer) = std::env::var_os("STARNET_TEST_INSTALLER") {
            let bytes = std::fs::read(installer).unwrap();
            assert_eq!(verify_windows_update(&bytes), Ok(()));
        }
    }
}
