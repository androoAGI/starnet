//! ONE station lifecycle contract across the desktop shell's native door and the sidecar's record module.
//!
//! The shell's START FRESH and ERASE (src-tauri/src/fresh_start.rs) write no station record. They write only the legacy
//! `.fresh-start.json` marker, and the sidecar's one record module (sidecar/station-record.js) derives the record from it
//! on the next boot. For a START FRESH that includes the erase authority and acknowledged roots of the generation the
//! marker's `quarantine` names, read only inside <parent>/workspace-quarantine. Both halves read
//! test/fixtures/station-record-cases.json. This test drives the shell's own public API (quarantine_and_prepare,
//! set_aside_for_erase) and requires every marker it writes to be field-identical to the fixture's canonical shapes, the
//! clean generation to hold exactly SEAL, the marker and CARRY_ON_FRESH, and an ERASE followed by a START FRESH to leave the
//! erase marker exactly where derive reads it. Every carry row holds both doors to one rule: a valid link is carried, and an
//! invalid one stays with the set-aside generation, the clean one starts unlinked, the door says so and the reset is never
//! refused over it (test/start-fresh-generation.test.js is the sidecar door's half). test/station-record.test.js derives every
//! fixture case from those same shapes. The fast gate's rust-policy job requires each test here by name
//! (.github/workflows/fast-gate.yml).

use serde_json::Value;
use starnet_process_ownership_rules::fresh_start::{quarantine_and_prepare, set_aside_for_erase};
use std::fs;
use std::path::{Path, PathBuf};

const FIXTURE: &str = include_str!("../../fixtures/station-record-cases.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("the shared lifecycle fixture is JSON")
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "starnet-station-contract-{name}-{}-{}",
        std::process::id(),
        starnet_process_ownership_rules::now_ms()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .expect("a list")
        .iter()
        .map(|x| x.as_str().expect("text").to_string())
        .collect()
}

fn paths(v: &Value) -> Vec<PathBuf> {
    strings(v).into_iter().map(PathBuf::from).collect()
}

fn text_of(v: &Value) -> &str {
    v.as_str().expect("text")
}

/// Every file under `dir`, as forward-slash paths relative to it, sorted.
fn files_under(dir: &Path) -> Vec<String> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                walk(base, &path, out);
            } else {
                out.push(path.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort();
    out
}

/// What a clean generation holds: SEAL, the marker and `carried`, nothing else.
fn clean_generation(fx: &Value, carried: &[String]) -> Vec<String> {
    let mut want = strings(&fx["seal"]);
    want.push(text_of(&fx["freshMarker"]).to_string());
    want.extend(carried.iter().cloned());
    want.sort();
    want
}

/// The marker a door wrote, against the fixture's canonical shape: exactly its keys, in its order, with its values
/// ($QUARANTINE is the set-aside generation the call returned).
fn assert_marker(fx: &Value, written: &Path, canonical: &Value, quarantine: Option<&Path>, what: &str) {
    let text = fs::read_to_string(written).unwrap_or_else(|e| panic!("{what}: the door wrote its marker ({e})"));
    let got: Value = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{what}: the marker is JSON ({e}): {text}"));
    let keys = strings(&fx["nativeMarkers"]["keys"]);
    assert_eq!(got.as_object().map(|o| o.len()), Some(keys.len()), "{what}: exactly the fixture's keys: {text}");
    let mut last = 0usize;
    for key in &keys {
        let at = text
            .find(&format!("\"{key}\":"))
            .unwrap_or_else(|| panic!("{what}: the marker has {key}: {text}"));
        assert!(at >= last, "{what}: {key} sits in the fixture's order: {text}");
        last = at;
    }
    let mut want = canonical.clone();
    if want["quarantine"] == Value::String("$QUARANTINE".into()) {
        let q = quarantine.unwrap_or_else(|| panic!("{what}: a START FRESH sets a generation aside"));
        want["quarantine"] = Value::String(q.to_string_lossy().to_string());
    }
    assert_eq!(got, want, "{what}: the marker the native door wrote is the fixture's canonical shape");
}

/// A carry row's bytes: its text, padded with spaces before the closing brace to `padTo` bytes when the row asks.
fn row_bytes(row: &Value) -> Vec<u8> {
    let text = text_of(&row["text"]).to_string();
    match row["padTo"].as_u64() {
        None => text.into_bytes(),
        Some(n) => {
            let n = n as usize;
            assert!(text.ends_with('}') && text.len() < n, "a padded row is a JSON object shorter than its size");
            let mut s = text[..text.len() - 1].to_string();
            while s.len() < n - 1 {
                s.push(' ');
            }
            s.push('}');
            s.into_bytes()
        }
    }
}

#[cfg(unix)]
fn make_symlink(target: &Path, link: &Path) -> bool {
    std::os::unix::fs::symlink(target, link).is_ok()
}

#[cfg(windows)]
fn make_symlink(target: &Path, link: &Path) -> bool {
    std::os::windows::fs::symlink_file(target, link).is_ok()
}

#[test]
fn native_erase_marker_matches_the_fixture() {
    let fx = fixture();
    let native = &fx["nativeMarkers"];
    let carry = strings(&fx["carryOnFresh"]["files"]);
    let root = scratch("erase");
    let workspaces = root.join("workspaces");
    fs::create_dir_all(workspaces.join(".secrets")).unwrap();
    fs::write(workspaces.join("agent.save.json"), b"station").unwrap();
    fs::write(workspaces.join(&carry[0]), br#"{"accountId":"acct-7"}"#).unwrap();

    let result = set_aside_for_erase(&workspaces, &paths(&native["acknowledgedRoots"]), None, native["nowMs"].as_u64().unwrap())
        .expect("ERASE activates a clean generation");
    let aside = result.quarantine.expect("ERASE set the old generation aside");
    assert!(
        aside.file_name().unwrap().to_string_lossy().starts_with(".erasing-station-"),
        "an ERASE set-aside is never a recoverable quarantine: {}",
        aside.display()
    );
    assert_marker(&fx, &workspaces.join(text_of(&fx["freshMarker"])), &native["erase"], None, "ERASE");
    assert_eq!(
        files_under(&workspaces),
        clean_generation(&fx, &[]),
        "ERASE carries nothing: the clean generation holds SEAL and the marker"
    );
    assert_eq!(fs::read(aside.join("agent.save.json")).unwrap(), b"station");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn native_start_fresh_marker_matches_the_fixture() {
    let fx = fixture();
    let native = &fx["nativeMarkers"];
    let carry = strings(&fx["carryOnFresh"]["files"]);
    let root = scratch("start-fresh");
    let workspaces = root.join("workspaces");
    fs::create_dir_all(workspaces.join(".secrets")).unwrap();
    fs::write(workspaces.join("agent.save.json"), b"station").unwrap();
    // a workspace-held sign-in: START FRESH sets it aside with the station, it never rides into the clean generation
    fs::write(workspaces.join(".secrets/provider-keys.json"), br#"{"openrouter":"held"}"#).unwrap();
    let link = br#"{"url":"https://credits.example","accountId":"acct-7","linkedAt":7}"#;
    fs::write(workspaces.join(&carry[0]), link).unwrap();

    let result = quarantine_and_prepare(&workspaces, &paths(&native["acknowledgedRoots"]), None, native["nowMs"].as_u64().unwrap())
        .expect("START FRESH activates a clean generation");
    let quarantine = result.quarantine.expect("START FRESH set the old generation aside");
    assert_eq!(
        quarantine.parent().unwrap(),
        root.join(text_of(&fx["quarantineDir"])).as_path(),
        "START FRESH sets the old generation aside inside <parent>/workspace-quarantine, the only place derive reads one"
    );
    assert!(quarantine.file_name().unwrap().to_string_lossy().starts_with("station-"));
    assert_marker(&fx, &workspaces.join(text_of(&fx["freshMarker"])), &native["startFresh"], Some(&quarantine), "START FRESH");
    assert_eq!(
        files_under(&workspaces),
        clean_generation(&fx, &carry),
        "START FRESH carries exactly CARRY_ON_FRESH into the clean generation"
    );
    assert_eq!(fs::read(workspaces.join(&carry[0])).unwrap(), link, "the account link is carried byte for byte");
    assert_eq!(fs::read(quarantine.join("agent.save.json")).unwrap(), b"station");
    assert!(quarantine.join(".secrets/provider-keys.json").is_file(), "the old generation keeps what was not carried");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn an_erase_then_a_native_start_fresh_leaves_the_erase_where_derive_reads_it() {
    let fx = fixture();
    let chain = &fx["nativeMarkers"]["chain"];
    let marker = text_of(&fx["freshMarker"]);
    let root = scratch("chain");
    let workspaces = root.join("workspaces");
    fs::create_dir_all(&workspaces).unwrap();
    fs::write(workspaces.join("agent.save.json"), b"station").unwrap();

    let erase_at = chain["erase"]["nowMs"].as_u64().unwrap();
    let fresh_at = chain["startFresh"]["nowMs"].as_u64().unwrap();
    set_aside_for_erase(&workspaces, &paths(&chain["erase"]["acknowledgedRoots"]), None, erase_at).expect("ERASE");
    let fresh = quarantine_and_prepare(&workspaces, &paths(&chain["startFresh"]["acknowledgedRoots"]), None, fresh_at)
        .expect("START FRESH of the erased generation");
    let aside = fresh.quarantine.expect("the erased generation was set aside");
    assert_eq!(aside.parent().unwrap(), root.join(text_of(&fx["quarantineDir"])).as_path());

    // The live marker says erased:false. The erase survives only in the generation it names, which is why derive()
    // carries the erase authority and the acknowledged roots from there.
    let mut live = fx["nativeMarkers"]["startFresh"].clone();
    live["at"] = Value::String(fresh_at.to_string());
    live["acknowledgedRoots"] = chain["startFresh"]["acknowledgedRoots"].clone();
    assert_marker(&fx, &workspaces.join(marker), &live, Some(&aside), "START FRESH after ERASE");

    // the set-aside generation is the ERASE's clean generation: SEAL and the ERASE marker, which derive reads when the
    // generation has no record of its own (the new build never booted between the two resets)
    assert_eq!(files_under(&aside), clean_generation(&fx, &[]));
    let mut erased = fx["nativeMarkers"]["erase"].clone();
    erased["at"] = Value::String(erase_at.to_string());
    erased["acknowledgedRoots"] = chain["erase"]["acknowledgedRoots"].clone();
    assert_marker(&fx, &aside.join(marker), &erased, None, "the ERASE marker inside the set-aside generation");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_native_door_honours_every_carry_row() {
    let fx = fixture();
    let carry = &fx["carryOnFresh"];
    let files = strings(&carry["files"]);
    let link = files[0].clone();
    let rows = carry["rows"].as_array().expect("carry rows");
    assert!(rows.len() >= 6, "the fixture carries the carry-rule rows");
    for (i, row) in rows.iter().enumerate() {
        let name = text_of(&row["name"]);
        let verdict = text_of(&row["verdict"]);
        let root = scratch(&format!("carry-{i}"));
        let workspaces = root.join("workspaces");
        fs::create_dir_all(workspaces.join(".secrets")).unwrap();
        fs::write(workspaces.join("agent.save.json"), b"station").unwrap();
        let target = workspaces.join(&link);
        let bytes: Option<Vec<u8>> = match text_of(&row["kind"]) {
            "file" => {
                let b = row_bytes(row);
                fs::write(&target, &b).unwrap();
                Some(b)
            }
            "dir" => {
                fs::create_dir_all(&target).unwrap();
                None
            }
            "symlink" => {
                let real = root.join("credits-elsewhere.json");
                fs::write(&real, br#"{"accountId":"acct-7"}"#).unwrap();
                if !make_symlink(&real, &target) {
                    eprintln!("{name}: this host cannot create a symlink without privileges; row skipped here (CI runs it)");
                    let _ = fs::remove_dir_all(&root);
                    continue;
                }
                None
            }
            "absent" => None,
            other => panic!("{name}: unknown kind {other}"),
        };

        let result = quarantine_and_prepare(&workspaces, &[], None, 1_793_400_000_000);
        match verdict {
            "carry" => {
                let done = result.unwrap_or_else(|e| panic!("{name}: START FRESH carries a valid link ({e})"));
                assert!(!done.credits_left_aside, "{name}: nothing to report");
                let aside = done.quarantine.expect("set aside");
                assert_eq!(files_under(&workspaces), clean_generation(&fx, &files), "{name}");
                let b = bytes.expect("a file row");
                assert_eq!(fs::read(&target).unwrap(), b, "{name}: carried byte for byte");
                assert_eq!(fs::read(aside.join(&link)).unwrap(), b, "{name}: and still in the set-aside generation");
            }
            "none" => {
                let done = result.unwrap_or_else(|e| panic!("{name}: START FRESH runs without a link ({e})"));
                assert!(!done.credits_left_aside, "{name}: nothing to report");
                assert_eq!(files_under(&workspaces), clean_generation(&fx, &[]), "{name}: the clean generation starts unlinked");
            }
            "leave-aside" => {
                let done = result.unwrap_or_else(|e| panic!("{name}: the reset is never refused over an invalid link ({e})"));
                assert!(done.credits_left_aside, "{name}: the door says the link stayed behind");
                let kept = done.quarantine.expect("set aside").join(&link);
                assert!(fs::symlink_metadata(&kept).is_ok(), "{name}: the link is never lost");
                if let Some(b) = &bytes {
                    assert_eq!(&fs::read(&kept).unwrap(), b, "{name}: byte for byte");
                }
                assert_eq!(files_under(&workspaces), clean_generation(&fx, &[]), "{name}: the clean generation starts unlinked");
            }
            other => panic!("{name}: unknown verdict {other}"),
        }
        let _ = fs::remove_dir_all(&root);
    }
}
