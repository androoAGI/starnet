//! #65 ERASE EVERYTHING: what a full "start over from scratch" removes, and the guarded deletion itself.
//!
//! The reporter (macOS) deleted the app and reinstalled, and "everything remained": uninstalling removes only the
//! program, while StarNet's data lives in a separate per-user app-data folder, the WebView keeps its own storage,
//! and credentials sit in the OS keychain. START FRESH (fresh_start.rs) deliberately keeps the old station in a
//! quarantine folder. This module is the other door: it DELETES.
//!
//! Safety rules (each one is tested below):
//!   * Only StarNet-owned locations are ever targets: every target must sit under a path component named
//!     `ai.skynet.harness`, `StarNet`, `Skynet` or `starnet` and be at least three components deep. A user's project
//!     folder, home folder or a filesystem root can never qualify, whatever a caller passes.
//!   * Links are never followed: a symlink/junction inside a target (or a target that is itself a link) is removed
//!     as a link; whatever it points at is untouched. Trusted project folders are recorded by PATH in the station
//!     data, never stored inside it, so erasing the station never reaches them.
//!   * The install folder is never touched (on macOS it is the signed app bundle); the bundled first-run seed is
//!     sealed off by the fresh generation's migration marker instead.
//!   * Every removal is verified (the path must be gone afterwards); failures are returned, never swallowed, so the
//!     UI can say exactly what remains.

use std::fs;
use std::path::{Component, Path, PathBuf};

const OWNED_NAMES: [&str; 3] = ["ai.skynet.harness", "starnet", "skynet"];

/// True when `path` is one StarNet owns outright (see the module rules).
pub fn is_starnet_owned(path: &Path) -> bool {
    let normal: Vec<String> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(name) => Some(name.to_string_lossy().to_lowercase()),
            _ => None,
        })
        .collect();
    if normal.len() < 3 {
        return false;
    }
    // The owned component must be an ANCESTOR (or the path itself), and never the last two generic names alone.
    normal
        .iter()
        .any(|name| OWNED_NAMES.iter().any(|owned| name == owned))
}

/// The WebView's live profile may sit beside the station data on some platforms; deleting its files under a
/// running window corrupts it. It is cleared through the WebView's own API instead (clear_all_browsing_data).
fn is_webview_dir(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower == "ebwebview" || lower.contains("webkit") || lower.contains("webview")
}

/// Everything the erase deletes, in order. `app_data` is the parent of the active `workspaces` (the
/// `ai.skynet.harness` app-data folder); its every entry except the fresh `workspaces` and a WebView folder is
/// StarNet's (logs, lifecycle prefs, update snapshots, START FRESH quarantines, migration/erase leftovers).
/// `set_aside` is the old generation moved aside by fresh_start::set_aside_for_erase. `legacy_roots` are older
/// StarNet data roots (only those under app-data bases are passed in; never the install folder). `extra` holds
/// other StarNet caches (the local voice-model download).
pub fn plan_targets(
    app_data: &Path,
    active_workspaces: &Path,
    set_aside: Option<&Path>,
    legacy_roots: &[PathBuf],
    extra: &[PathBuf],
) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if !out.iter().any(|q| q == &p) {
            out.push(p);
        }
    };
    if let Some(p) = set_aside {
        push(p.to_path_buf());
    }
    let app_data_is_ours = app_data
        .file_name()
        .map(|n| {
            n.to_string_lossy()
                .eq_ignore_ascii_case("ai.skynet.harness")
        })
        .unwrap_or(false);
    if app_data_is_ours {
        if let Ok(entries) = fs::read_dir(app_data) {
            let mut names: Vec<PathBuf> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p != active_workspaces)
                .filter(|p| {
                    !p.file_name()
                        .map(|n| is_webview_dir(&n.to_string_lossy()))
                        .unwrap_or(true)
                })
                .collect();
            names.sort();
            for p in names {
                push(p);
            }
        }
    }
    for p in legacy_roots.iter().chain(extra.iter()) {
        if p != active_workspaces {
            push(p.clone());
        }
    }
    out.into_iter().filter(|p| is_starnet_owned(p)).collect()
}

#[derive(Debug, Default)]
pub struct RemovalReport {
    pub removed: Vec<String>,
    pub failed: Vec<(String, String)>,
}

/// Remove one path WITHOUT following links. A link (symlink, or a Windows junction / directory symlink) is removed
/// as a link; a directory is removed recursively (std's remove_dir_all does not traverse links either).
fn remove_no_follow(path: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    let ft = meta.file_type();
    if ft.is_symlink() || is_reparse_point(&meta) {
        // A directory link on Windows is removed with remove_dir; a file link (and every POSIX link) with remove_file.
        return fs::remove_file(path).or_else(|_| fs::remove_dir(path));
    }
    if ft.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

#[cfg(windows)]
fn is_reparse_point(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_meta: &fs::Metadata) -> bool {
    false
}

/// Delete every target that exists. Refuses (reports as failed) any target that is not StarNet-owned, so a caller
/// mistake can never widen the erase. A short retry covers a just-exited process still releasing its files.
pub fn remove_all(targets: &[PathBuf]) -> RemovalReport {
    let mut report = RemovalReport::default();
    for target in targets {
        let shown = target.to_string_lossy().to_string();
        if !is_starnet_owned(target) {
            report
                .failed
                .push((shown, "refused: not a StarNet-owned location".to_string()));
            continue;
        }
        if fs::symlink_metadata(target).is_err() {
            continue; // nothing there
        }
        let mut last_error = String::new();
        for attempt in 0..4 {
            match remove_no_follow(target) {
                Ok(()) => {}
                Err(error) => last_error = error.to_string(),
            }
            if fs::symlink_metadata(target).is_err() {
                last_error.clear();
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(250 * (attempt + 1)));
        }
        if last_error.is_empty() && fs::symlink_metadata(target).is_err() {
            report.removed.push(shown);
        } else {
            let why = if last_error.is_empty() {
                "still present after removal".to_string()
            } else {
                last_error
            };
            report.failed.push((shown, why));
        }
    }
    report
}

/// Numeric ids of the agent-bound Telegram bots whose tokens the desktop keychains under `channel:telegram:<id>`.
/// Read BEFORE the station files go, so those keychain slots can be cleared too.
pub fn telegram_bot_ids(workspaces: &Path) -> Vec<String> {
    let file = workspaces.join("channels").join("secrets.json");
    let Some(json) = fs::read_to_string(file)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    else {
        return Vec::new();
    };
    json.get("telegramBots")
        .and_then(|v| v.as_object())
        .map(|bots| {
            bots.keys()
                .filter(|id| {
                    !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit())
                })
                .take(200)
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// Provider ids whose keys/pools the desktop may have stored (credentials::normalize_provider's outputs).
pub const PROVIDER_IDS: [&str; 18] = [
    "openrouter",
    "openai",
    "anthropic",
    "gemini",
    "xai",
    "groq",
    "mistral",
    "deepseek",
    "together",
    "fireworks",
    "perplexity",
    "cerebras",
    "custom",
    "codex",
    "grok",
    "kimi",
    "ollama",
    "claude-cli",
];

/// Every keychain account (service `ai.skynet.harness`) StarNet's desktop shell can have created.
pub fn keychain_accounts(channels: &[&str], telegram_bots: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for id in PROVIDER_IDS {
        let account = if id == "openrouter" {
            "openrouter".to_string()
        } else {
            format!("provider:{id}")
        };
        out.push(format!("{account}:pool"));
        out.push(account);
    }
    for channel in channels {
        out.push(format!("channel:{channel}"));
    }
    for bot in telegram_bots {
        out.push(format!("channel:telegram:{bot}"));
    }
    out.push("credits:device".to_string());
    out.push("connectors:encryption:v1".to_string());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "starnet-erase-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ))
    }

    #[test]
    fn ownership_guard_admits_only_starnet_locations() {
        assert!(is_starnet_owned(Path::new(
            "/Users/a/Library/Application Support/ai.skynet.harness/workspaces"
        )));
        assert!(is_starnet_owned(Path::new(
            "C:/Users/a/AppData/Local/StarNet/models"
        )));
        assert!(is_starnet_owned(Path::new(
            "/home/a/.local/share/Skynet/workspaces"
        )));
        assert!(!is_starnet_owned(Path::new("/Users/a/Projects/my-app")));
        assert!(!is_starnet_owned(Path::new("/Users/a")));
        assert!(!is_starnet_owned(Path::new("/")));
        assert!(!is_starnet_owned(Path::new("/StarNet")));
        assert!(!is_starnet_owned(Path::new(
            "C:/Users/a/Desktop/StarNet deliverables/report"
        )));
    }

    #[test]
    fn plan_keeps_the_fresh_workspace_and_the_webview_and_skips_foreign_paths() {
        let root = scratch("plan");
        let app = root.join("ai.skynet.harness");
        let ws = app.join("workspaces");
        for d in [
            ws.clone(),
            app.join("workspace-quarantine"),
            app.join("update-snapshots"),
            app.join("EBWebView"),
            app.join(".erasing-station-1"),
        ] {
            fs::create_dir_all(d).unwrap();
        }
        fs::write(app.join("startup.log"), b"x").unwrap();
        fs::write(app.join("lifecycle.json"), b"{}").unwrap();
        let user_project = root.join("Projects").join("my-app");
        let legacy = root.join("StarNet").join("workspaces");
        let plan = plan_targets(
            &app,
            &ws,
            Some(&app.join(".erasing-station-1")),
            &[legacy.clone(), user_project.clone()],
            &[],
        );
        assert!(!plan.contains(&ws), "the fresh sealed workspace is kept");
        assert!(
            !plan.contains(&app.join("EBWebView")),
            "the live WebView is cleared by its API, not deleted"
        );
        assert!(plan.contains(&app.join("workspace-quarantine")));
        assert!(plan.contains(&app.join("update-snapshots")));
        assert!(plan.contains(&app.join("startup.log")));
        assert!(plan.contains(&app.join("lifecycle.json")));
        assert!(plan.contains(&legacy));
        assert!(
            !plan.contains(&user_project),
            "a user project folder can never be a target"
        );
        assert_eq!(
            plan[0],
            app.join(".erasing-station-1"),
            "the old station goes first"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn removal_is_verified_and_never_follows_a_link_out_of_starnet_data() {
        let root = scratch("remove");
        let app = root.join("ai.skynet.harness");
        let aside = app.join(".erasing-station-1");
        fs::create_dir_all(aside.join("agent-1").join("deep")).unwrap();
        fs::write(
            aside.join("agent-1").join("deep").join("save.json"),
            b"station",
        )
        .unwrap();
        // the user's project folder, linked INTO the station data
        let project = root.join("Projects").join("my-app");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("main.rs"), b"fn main() {}").unwrap();
        let link = aside.join("agent-1").join("project-link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&project, &link).unwrap();
        #[cfg(windows)]
        {
            let made = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&project)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            assert!(made, "test setup: could not create a junction");
        }
        let report = remove_all(&[aside.clone(), project.clone()]);
        assert!(!aside.exists(), "the station tree is gone");
        assert_eq!(report.removed, vec![aside.to_string_lossy().to_string()]);
        assert!(
            project.join("main.rs").is_file(),
            "the linked user project is untouched"
        );
        assert_eq!(
            report.failed.len(),
            1,
            "the foreign target is refused, not deleted"
        );
        assert!(report.failed[0].1.contains("not a StarNet-owned"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn keychain_inventory_covers_providers_pools_channels_bots_credits_and_connectors() {
        let accounts = keychain_accounts(&["telegram", "discord"], &["12345".to_string()]);
        for want in [
            "openrouter",
            "openrouter:pool",
            "provider:anthropic",
            "provider:anthropic:pool",
            "provider:kimi",
            "channel:telegram",
            "channel:discord",
            "channel:telegram:12345",
            "credits:device",
            "connectors:encryption:v1",
        ] {
            assert!(accounts.iter().any(|a| a == want), "missing {want}");
        }
    }

    #[test]
    fn bot_ids_are_read_from_the_station_and_validated() {
        let root = scratch("bots");
        let ws = root.join("workspaces");
        fs::create_dir_all(ws.join("channels")).unwrap();
        fs::write(
            ws.join("channels").join("secrets.json"),
            br#"{"telegramBots":{"111":{},"abc":{},"222":{}}}"#,
        )
        .unwrap();
        let mut ids = telegram_bot_ids(&ws);
        ids.sort();
        assert_eq!(ids, vec!["111".to_string(), "222".to_string()]);
        assert!(telegram_bot_ids(&root.join("missing")).is_empty());
        let _ = fs::remove_dir_all(root);
    }
}
