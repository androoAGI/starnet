//! The shell's process-ownership rules, by path (see Cargo.toml). Nothing here is new code: each module is the app's own
//! file, unchanged; `now_ms` is the one item of main.rs a module's tests use.
#![allow(dead_code)]
#[path = "../../../src-tauri/src/process_identity.rs"]
pub mod process_identity;
#[path = "../../../src-tauri/src/process_job.rs"]
pub mod process_job;
#[path = "../../../src-tauri/src/sidecar_startup.rs"]
pub mod sidecar_startup;
#[path = "../../../src-tauri/src/sidecar_reap.rs"]
pub mod sidecar_reap;
#[path = "../../../src-tauri/src/fresh_start.rs"]
pub mod fresh_start;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
