//! The shell's install-manifest rules, by path (see Cargo.toml). Nothing here is new code: the module is the app's own
//! file, unchanged (build.rs compiles the same file to write the manifest).
#![allow(dead_code)]
#[path = "../../../src-tauri/src/install_manifest.rs"]
pub mod install_manifest;
