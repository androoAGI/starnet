//! ONE rule for where the voice-model download lives, across the sidecar and the desktop shell.
//!
//! The sidecar resolves the cache (sidecar/local-voice.js voiceCacheRoots) and the shell deletes it on ERASE EVERYTHING
//! (src-tauri/src/erase_all.rs voice_model_cache_roots). main.rs used to hand-copy the sidecar's rule, so a moved cache
//! would have left ERASE deleting a folder nothing uses while the real weights stayed on disk. Both halves now read
//! test/fixtures/voice-cache-roots.json (test/local-voice-cache-root.test.js is the sidecar's half). The roots must be the
//! fixture's, new root first, and ERASE must plan and remove both, whichever folder an older build left the weights in. The
//! fast gate's rust-policy job requires each test here by name (.github/workflows/fast-gate.yml).

use serde_json::Value;
use starnet_process_ownership_rules::erase_all::{
    is_starnet_owned, plan_targets, remove_all, voice_model_cache_roots,
};
use starnet_process_ownership_rules::now_ms;
use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;

const FIXTURE: &str = include_str!("../../fixtures/voice-cache-roots.json");

fn cases() -> Vec<Value> {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("the shared roots fixture is JSON");
    fixture["cases"]
        .as_array()
        .expect("a list of cases")
        .clone()
}

fn name(case: &Value) -> &str {
    case["name"].as_str().expect("a case name")
}

fn roots_of(case: &Value) -> Vec<PathBuf> {
    let env = case["env"].as_object().expect("a case environment");
    voice_model_cache_roots(case["rust"].as_str().expect("a platform"), |var| {
        env.get(var)
            .map(|value| OsString::from(value.as_str().expect("an environment value")))
    })
}

#[test]
fn the_voice_cache_roots_match_the_fixture() {
    let cases = cases();
    assert!(cases.len() >= 6, "the fixture covers every platform");
    for case in &cases {
        let mut want = vec![PathBuf::from(case["root"].as_str().expect("a root"))];
        if let Some(legacy) = case["legacy"].as_str() {
            want.push(PathBuf::from(legacy));
        }
        assert_eq!(roots_of(case), want, "{}", name(case));
    }
}

#[test]
fn every_voice_cache_root_is_starnet_owned() {
    for case in cases() {
        for root in roots_of(&case) {
            assert!(
                is_starnet_owned(&root),
                "{}: ERASE would refuse {}",
                name(&case),
                root.display()
            );
        }
    }
}

#[test]
fn a_profile_with_no_home_gives_erase_no_voice_target() {
    for platform in ["windows", "macos", "linux"] {
        assert!(
            voice_model_cache_roots(platform, |_| None).is_empty(),
            "{platform}: no root is ever guessed"
        );
    }
}

#[test]
fn erase_removes_both_voice_cache_roots_and_keeps_the_fresh_workspace() {
    let base = std::env::temp_dir().join(format!(
        "starnet-voice-roots-{}-{}",
        std::process::id(),
        now_ms()
    ));
    let local = base.join("AppData").join("Local");
    let app_data = base
        .join("AppData")
        .join("Roaming")
        .join("ai.skynet.harness");
    let workspaces = app_data.join("workspaces");
    fs::create_dir_all(&workspaces).unwrap();

    let extra = voice_model_cache_roots("windows", |var| {
        (var == "LOCALAPPDATA").then(|| OsString::from(&local))
    });
    assert_eq!(extra.len(), 2, "the new root and the legacy root");
    for root in &extra {
        fs::create_dir_all(root.join("transformers")).unwrap();
        fs::write(root.join("transformers").join("model.onnx"), b"weights").unwrap();
    }
    // the install folder around the legacy root holds the program, which an erase never touches
    let program = local.join("StarNet").join("skynet-desktop.exe");
    fs::write(&program, b"program").unwrap();

    let plan = plan_targets(&app_data, &workspaces, None, &[], &extra);
    for root in &extra {
        assert!(plan.contains(root), "planned: {}", root.display());
    }
    let report = remove_all(&plan);
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    for root in &extra {
        assert!(!root.exists(), "removed: {}", root.display());
    }
    assert!(workspaces.is_dir(), "the fresh workspace is kept");
    assert!(program.is_file(), "the program is untouched");
    let _ = fs::remove_dir_all(base);
}
