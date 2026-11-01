use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::process_identity::{self, OwnerClaim};

const OWNER_FILE: &str = ".starnet-workspace-owner.json";
const MIGRATION_MARKER: &str = ".migrated";
const FRESH_MARKER: &str = ".fresh-start.json";
const CREDITS_LINK: &str = ".secrets/credits.json";
const MAX_CREDITS_LINK_BYTES: u64 = 64 * 1024;

#[derive(Debug)]
pub struct FreshWorkspace {
    pub quarantine: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FreshMarker<'a> {
    version: u8,
    // #65: true when the previous generation was set aside to be ERASED (not kept in a quarantine).
    erased: bool,
    at: String,
    acknowledged_roots: Vec<String>,
    quarantine: Option<&'a str>,
    moved: Vec<String>,
}

fn unique_child(parent: &Path, prefix: &str, now_ms: u64) -> PathBuf {
    for suffix in 0..1000u16 {
        let candidate = parent.join(format!("{prefix}-{now_ms}-{}-{suffix}", std::process::id()));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{prefix}-{now_ms}-{}-overflow", std::process::id()))
}

fn write_durable(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("could not create {}: {error}", path.display()))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("could not write {}: {error}", path.display()))
}

fn preserve_credits_link(workspaces: &Path, stage: &Path) -> Result<(), String> {
    let source = workspaces.join(CREDITS_LINK);
    let Ok(metadata) = fs::symlink_metadata(&source) else {
        return Ok(());
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("linked-credit record is not a regular file; reset refused".to_string());
    }
    if metadata.len() > MAX_CREDITS_LINK_BYTES {
        return Err("linked-credit record is unexpectedly large; reset refused".to_string());
    }
    let bytes = fs::read(&source)
        .map_err(|error| format!("could not read linked-credit record: {error}"))?;
    // Validate before carrying the record into the clean generation. The sidecar applies the
    // account-id/token consistency checks; this boundary only refuses corrupt arbitrary bytes.
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| {
        "linked-credit record is unreadable; reset refused so it is not lost".to_string()
    })?;
    if !value.is_object() {
        return Err("linked-credit record is invalid; reset refused so it is not lost".to_string());
    }
    write_durable(&stage.join(CREDITS_LINK), &bytes)
}

/// The station's workspace-owner claim, when it is one this shell can judge (version 1, a real PID).
fn valid_owner_claim(workspaces: &Path) -> Option<OwnerClaim> {
    process_identity::parse_owner_claim(&fs::read(workspaces.join(OWNER_FILE)).ok()?)
}

// A recorded PID is only an ownership claim while the process that STAMPED it still holds that PID. Crash/reboot
// leaves the owner file behind, and treating the number alone as proof recreates the unreachable loop — including
// the same-boot case where Windows has handed the PID to an unrelated program (process_identity.rs). Unknown or
// permission-denied probes fail closed (held); only a gone PID or a provably different process releases the claim.
fn claim_still_held(claim: &OwnerClaim) -> bool {
    process_identity::claim_is_held(claim).0
}

/// Replace the active workspace with a clean, migration-sealed generation while moving the
/// previous generation to a sibling quarantine. Nothing in the OS keychain is read or changed.
/// The caller must stop its sidecar first and pass that exact child PID; a different live owner is
/// refused so an explicit reset can never create two writers for one station. A provably dead PID
/// is stale crash residue and must not strand the recovery escape.
pub fn quarantine_and_prepare(
    workspaces: &Path,
    acknowledged_roots: &[PathBuf],
    stopped_child_pid: Option<u32>,
    now_ms: u64,
) -> Result<FreshWorkspace, String> {
    quarantine_and_prepare_with(
        workspaces,
        acknowledged_roots,
        stopped_child_pid,
        now_ms,
        &claim_still_held,
    )
}

/// #65 ERASE EVERYTHING: the same atomic swap as START FRESH (stage a sealed clean generation, move the old one
/// aside, activate), except nothing is carried over (not even the credit-account link record) and the old
/// generation goes to a sibling `.erasing-*` directory that the caller then deletes. If the move fails (a file in
/// use), NOTHING has changed and the caller reports "nothing was erased". The returned `quarantine` is the
/// set-aside path to delete.
pub fn set_aside_for_erase(
    workspaces: &Path,
    acknowledged_roots: &[PathBuf],
    stopped_child_pid: Option<u32>,
    now_ms: u64,
) -> Result<FreshWorkspace, String> {
    prepare_with_mode(
        workspaces,
        acknowledged_roots,
        stopped_child_pid,
        now_ms,
        &claim_still_held,
        true,
    )
}

fn quarantine_and_prepare_with(
    workspaces: &Path,
    acknowledged_roots: &[PathBuf],
    stopped_child_pid: Option<u32>,
    now_ms: u64,
    owner_holds: &dyn Fn(&OwnerClaim) -> bool,
) -> Result<FreshWorkspace, String> {
    prepare_with_mode(
        workspaces,
        acknowledged_roots,
        stopped_child_pid,
        now_ms,
        owner_holds,
        false,
    )
}

fn prepare_with_mode(
    workspaces: &Path,
    acknowledged_roots: &[PathBuf],
    stopped_child_pid: Option<u32>,
    now_ms: u64,
    owner_holds: &dyn Fn(&OwnerClaim) -> bool,
    erase: bool,
) -> Result<FreshWorkspace, String> {
    let parent = workspaces
        .parent()
        .ok_or_else(|| "workspace has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "could not open workspace parent {}: {error}",
            parent.display()
        )
    })?;

    if let Some(claim) = valid_owner_claim(workspaces) {
        if Some(claim.pid) != stopped_child_pid && owner_holds(&claim) {
            return Err(format!(
                "another StarNet process still owns this station (PID {}); quit it before starting fresh",
                claim.pid
            ));
        }
    }

    // An erase sets the old generation aside BESIDE the workspace (same volume, so the move is a rename) under a
    // name that can never be mistaken for a recoverable quarantine.
    let quarantine_root = if erase {
        parent.to_path_buf()
    } else {
        parent.join("workspace-quarantine")
    };
    let quarantine = workspaces.exists().then(|| {
        unique_child(
            &quarantine_root,
            if erase { ".erasing-station" } else { "station" },
            now_ms,
        )
    });
    let stage = unique_child(parent, ".workspaces-fresh-stage", now_ms);
    fs::create_dir_all(&stage).map_err(|error| {
        format!(
            "could not stage a fresh station at {}: {error}",
            stage.display()
        )
    })?;

    let quarantine_text = quarantine
        .as_ref()
        .map(|path| path.to_string_lossy().to_string());
    let marker = FreshMarker {
        version: 1,
        erased: erase,
        at: now_ms.to_string(),
        acknowledged_roots: acknowledged_roots
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect(),
        quarantine: if erase {
            None
        } else {
            quarantine_text.as_deref()
        },
        moved: Vec::new(),
    };
    let marker_bytes = serde_json::to_vec_pretty(&marker)
        .map_err(|error| format!("could not encode fresh-station receipt: {error}"))?;
    if let Err(error) = write_durable(&stage.join(MIGRATION_MARKER), b"1")
        .and_then(|_| write_durable(&stage.join(FRESH_MARKER), &marker_bytes))
        .and_then(|_| {
            if erase {
                Ok(())
            } else {
                preserve_credits_link(workspaces, &stage)
            }
        })
    {
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }

    let mut moved_old = false;
    if let Some(destination) = quarantine.as_ref() {
        fs::create_dir_all(&quarantine_root).map_err(|error| {
            let _ = fs::remove_dir_all(&stage);
            format!(
                "could not create quarantine {}: {error}",
                quarantine_root.display()
            )
        })?;
        fs::rename(workspaces, destination).map_err(|error| {
            let _ = fs::remove_dir_all(&stage);
            format!(
                "could not preserve the current station in {}: {error}",
                destination.display()
            )
        })?;
        moved_old = true;
    }

    if let Err(error) = fs::rename(&stage, workspaces) {
        let mut message = format!("could not activate the fresh station: {error}");
        if moved_old {
            if let Some(old) = quarantine.as_ref() {
                if let Err(rollback) = fs::rename(old, workspaces) {
                    message.push_str(&format!(
                        "; rollback also failed ({rollback}); preserved station remains at {}",
                        old.display()
                    ));
                }
            }
        }
        let _ = fs::remove_dir_all(&stage);
        return Err(message);
    }

    Ok(FreshWorkspace { quarantine })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "starnet-{name}-{}-{}",
            std::process::id(),
            crate::now_ms()
        ))
    }

    #[test]
    fn quarantines_station_seals_migration_and_leaves_sibling_credentials_alone() {
        let root = scratch("fresh-workspace");
        let workspaces = root.join("workspaces");
        let legacy = root.join("legacy").join("workspaces");
        fs::create_dir_all(&workspaces).unwrap();
        fs::create_dir_all(&legacy).unwrap();
        fs::write(workspaces.join("agent.save.json"), b"station").unwrap();
        fs::create_dir_all(workspaces.join(".secrets")).unwrap();
        let linked = br#"{"url":"https://credits.example","accountId":"acct-7","linkedAt":7}"#;
        fs::write(workspaces.join(CREDITS_LINK), linked).unwrap();
        fs::write(root.join("keychain-proof.txt"), b"account-credit-token").unwrap();
        fs::write(
            workspaces.join(OWNER_FILE),
            format!(r#"{{"version":1,"pid":{},"nonce":"owned"}}"#, 4242),
        )
        .unwrap();

        let result = quarantine_and_prepare(&workspaces, &[legacy.clone()], Some(4242), 12345)
            .expect("fresh station should activate");
        let quarantine = result.quarantine.expect("old station is quarantined");
        assert_eq!(
            fs::read(quarantine.join("agent.save.json")).unwrap(),
            b"station"
        );
        assert!(workspaces.join(MIGRATION_MARKER).is_file());
        assert_eq!(fs::read(workspaces.join(CREDITS_LINK)).unwrap(), linked);
        let marker: serde_json::Value =
            serde_json::from_slice(&fs::read(workspaces.join(FRESH_MARKER)).unwrap()).unwrap();
        assert_eq!(marker["version"], 1);
        assert_eq!(
            marker["acknowledgedRoots"][0],
            legacy.to_string_lossy().as_ref()
        );
        assert_eq!(
            fs::read(root.join("keychain-proof.txt")).unwrap(),
            b"account-credit-token"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn erase_mode_carries_nothing_over_and_sets_the_old_station_aside_for_deletion() {
        let root = scratch("erase-workspace");
        let workspaces = root.join("workspaces");
        fs::create_dir_all(workspaces.join(".secrets")).unwrap();
        fs::write(workspaces.join("agent.save.json"), b"station").unwrap();
        let linked = br#"{"url":"https://credits.example","accountId":"acct-7","linkedAt":7}"#;
        fs::write(workspaces.join(CREDITS_LINK), linked).unwrap();

        let result = prepare_with_mode(&workspaces, &[], None, 777, &|_: &OwnerClaim| false, true)
            .expect("erase set-aside should activate a clean station");
        let aside = result.quarantine.expect("the old station was set aside");
        assert_eq!(aside.parent().unwrap(), root.as_path());
        assert!(aside
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".erasing-station-"));
        assert!(!root.join("workspace-quarantine").exists());
        assert_eq!(fs::read(aside.join("agent.save.json")).unwrap(), b"station");
        // nothing was carried over: no save, and NOT the credit-account link either
        assert!(!workspaces.join("agent.save.json").exists());
        assert!(!workspaces.join(CREDITS_LINK).exists());
        assert!(workspaces.join(MIGRATION_MARKER).is_file());
        let marker: serde_json::Value =
            serde_json::from_slice(&fs::read(workspaces.join(FRESH_MARKER)).unwrap()).unwrap();
        assert_eq!(marker["erased"], true);
        assert!(marker["quarantine"].is_null());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_to_move_a_station_owned_by_a_different_process() {
        let root = scratch("fresh-owner");
        let workspaces = root.join("workspaces");
        fs::create_dir_all(&workspaces).unwrap();
        fs::write(
            workspaces.join(OWNER_FILE),
            br#"{"version":1,"pid":9001,"nonce":"other"}"#,
        )
        .unwrap();
        let error =
            quarantine_and_prepare_with(&workspaces, &[], Some(9002), 12345, &|c: &OwnerClaim| c.pid == 9001)
                .unwrap_err();
        assert!(error.contains("another StarNet process"));
        assert!(workspaces.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reclaims_a_stale_owner_after_the_recorded_process_is_gone() {
        let root = scratch("fresh-stale-owner");
        let workspaces = root.join("workspaces");
        fs::create_dir_all(&workspaces).unwrap();
        fs::write(workspaces.join("agent.save.json"), b"old station").unwrap();
        fs::write(
            workspaces.join(OWNER_FILE),
            br#"{"version":1,"pid":9001,"nonce":"crashed"}"#,
        )
        .unwrap();

        let result = quarantine_and_prepare_with(&workspaces, &[], None, 12345, &|_: &OwnerClaim| false)
            .expect("a dead PID must not strand recovery");
        let quarantine = result.quarantine.expect("old station is preserved");
        assert_eq!(
            fs::read(quarantine.join("agent.save.json")).unwrap(),
            b"old station"
        );
        assert!(workspaces.join(FRESH_MARKER).is_file());
        let _ = fs::remove_dir_all(root);
    }

    /// The 2026-10-15 shape, on the production path: the claim names a PID that is alive (this very test process) but
    /// was stamped an hour before that process was created — a recycled PID. START FRESH must not be refused for it;
    /// a claim this process could have written (stamped now) still is.
    #[test]
    fn a_recycled_owner_pid_does_not_strand_recovery() {
        let me = std::process::id();
        let process_identity::Probe::Live(process_identity::Seen::Read { started_at, executable, start_ticks, .. }) =
            process_identity::probe(me)
        else {
            eprintln!("this platform cannot read a process identity — nothing to prove here");
            return;
        };
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let claim = |stamped_at: u64, ticks: &str| {
            serde_json::json!({
                "version": 1, "pid": me, "nonce": "recycled", "startedAt": stamped_at,
                "executable": executable, "startTicks": ticks
            })
            .to_string()
        };
        // Linux judges by start ticks: another value is another process
        let (old_stamp, other_ticks) = if start_ticks.is_empty() {
            (started_at.saturating_sub(3_600_000), String::new())
        } else {
            (1, format!("{}1", start_ticks))
        };

        let root = scratch("fresh-recycled-owner");
        let workspaces = root.join("workspaces");
        fs::create_dir_all(&workspaces).unwrap();
        fs::write(workspaces.join("agent.save.json"), b"old station").unwrap();
        fs::write(workspaces.join(OWNER_FILE), claim(old_stamp, &other_ticks)).unwrap();
        let result = quarantine_and_prepare(&workspaces, &[], None, 12345)
            .expect("a live PID that now belongs to another process must not strand recovery");
        assert!(result.quarantine.is_some(), "the old station is preserved");
        let _ = fs::remove_dir_all(&root);

        let root = scratch("fresh-live-owner");
        let workspaces = root.join("workspaces");
        fs::create_dir_all(&workspaces).unwrap();
        fs::write(workspaces.join(OWNER_FILE), claim(now_ms, &start_ticks)).unwrap();
        let error = quarantine_and_prepare(&workspaces, &[], None, 12345).unwrap_err();
        assert!(error.contains("another StarNet process"), "{error}");
        assert!(workspaces.join(OWNER_FILE).exists(), "nothing moved");
        let _ = fs::remove_dir_all(root);
    }
}
