//! update-verify-gate: the release train's proof that the shell's own update signer check (GHSA-2hpj-9wm7-rvg5 #10)
//! ADMITS the release it just built and signed, and REFUSES a wrong signer. It compiles src-tauri/src/update_verify.rs
//! unchanged, so this is the exact code an installed StarNet runs before it swaps itself.
//!
//!   update-verify-gate macos <StarNet.app.tar.gz> <signed StarNet.app> [expected-team]
//!       The signed .app stands in for the running copy: its own signature names the pin (as the installed shell
//!       reads its own bundle), the archive is unpacked exactly as the updater plugin unpacks it, and
//!       `codesign --verify --deep --strict -R =<requirement>` must accept it. expected-team (codesign -dv's
//!       TeamIdentifier, read by the workflow) must be the pin. Control: the same requirement for another team must
//!       be refused by codesign, or the requirement is not being enforced.
//!   update-verify-gate windows <setup.exe> [another publisher's signed .exe ...]
//!       Get-AuthenticodeSignature through the same function the shell calls must admit the signed installer.
//!       Controls: a Microsoft binary (powershell.exe, catalog-signed) and every other binary named
//!       (the workflow passes the runner's Node, embedded-signed by the OpenJS Foundation) must be refused.
//!
//! Exit 0 and a summary when every check holds; otherwise a `::error::` line (a GitHub annotation) and exit 1.

#[path = "../../src/update_verify.rs"]
mod update_verify;

use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let verdict = match args.as_slice() {
        ["macos", archive, app] => macos(Path::new(archive), Path::new(app), None),
        ["macos", archive, app, team] => macos(Path::new(archive), Path::new(app), Some(team)),
        ["windows", installer, foreign @ ..] => windows(Path::new(installer), foreign),
        _ => Err("usage: update-verify-gate macos <StarNet.app.tar.gz> <signed StarNet.app> [expected-team] | windows <setup.exe> [foreign-signed.exe ...]".to_string()),
    };
    match verdict {
        Ok(lines) => {
            for line in lines {
                println!("{line}");
            }
            ExitCode::SUCCESS
        }
        Err(why) => {
            println!("::error::the shell's own update signer check (src-tauri/src/update_verify.rs) failed the release: {why}");
            ExitCode::FAILURE
        }
    }
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("cannot read {} ({e})", path.display()))
}

fn macos(archive: &Path, app: &Path, expected_team: Option<&str>) -> Result<Vec<String>, String> {
    let bytes = read(archive)?;
    let pin = update_verify::verify_macos_update_against(&bytes, app)
        .map_err(|why| format!("{} was REFUSED: {why}", archive.display()))?;
    if let Some(team) = expected_team {
        if team != pin.team {
            return Err(format!(
                "the check pinned team {} but the signed app's TeamIdentifier is {team}",
                pin.team
            ));
        }
    }
    let mut out = vec![format!(
        "admitted: {} (identifier {}, Developer ID team {})",
        archive.display(),
        pin.identifier,
        pin.team
    )];
    // control: the requirement is enforced, not ignored (a malformed -R argument would fail the admit above instead)
    let other = update_verify::MacIdentity {
        identifier: pin.identifier.clone(),
        team: if pin.team == "ZZZZZZZZZZ" {
            "YYYYYYYYYY".into()
        } else {
            "ZZZZZZZZZZ".into()
        },
    };
    match update_verify::codesign_against(app, &other) {
        Ok(()) => {
            return Err(format!(
            "control failed: codesign admitted {} for team {}, so the requirement is not enforced",
            app.display(),
            other.team
        ))
        }
        Err(why) if why.contains("is not signed by StarNet's Developer ID team") => out.push(
            format!("control refused as it must (team {}): {why}", other.team),
        ),
        Err(why) => return Err(format!("control could not run: {why}")),
    }
    Ok(out)
}

fn windows(installer: &Path, foreign: &[&str]) -> Result<Vec<String>, String> {
    let bytes = read(installer)?;
    update_verify::verify_windows_update(&bytes)
        .map_err(|why| format!("{} was REFUSED: {why}", installer.display()))?;
    let mut out = vec![format!(
        "admitted: {} (Authenticode Valid, publisher {})",
        installer.display(),
        update_verify::WINDOWS_PUBLISHER_CN
    )];
    // controls: validly signed binaries from other publishers are refused
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
    let mut controls = vec![Path::new(&root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")];
    controls.extend(foreign.iter().map(|p| Path::new(p).to_path_buf()));
    for control in controls {
        match update_verify::verify_windows_update(&read(&control)?) {
            Ok(()) => {
                return Err(format!(
                    "control failed: {} was admitted, so the publisher pin is not enforced",
                    control.display()
                ))
            }
            // any verdict refusal (another publisher, a catalog signature, unsigned) is the control holding; only a
            // check that could not run at all fails the gate here
            Err(why) if why.contains("refused the update") => out.push(format!(
                "control refused as it must ({}): {why}",
                control.display()
            )),
            Err(why) => {
                return Err(format!(
                    "control could not run on {}: {why}",
                    control.display()
                ))
            }
        }
    }
    Ok(out)
}
