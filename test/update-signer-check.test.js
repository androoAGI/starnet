/* GHSA-2hpj-9wm7-rvg5 #10: the update's own platform signer is checked before the updater installs it.
   The decisions live in src-tauri/src/update_verify.rs and are unit-tested there (cargo test / a scratch crate; Rust is
   not built by this suite). This file locks what those tests cannot see:
     - the install command goes through VerifiedUpdate: download (minisign) -> verify_update_bytes off the runtime ->
       install of the SAME bytes, and nothing else installs an update;
     - the Windows publisher pin is the one the release train asserts on every installer it ships;
     - the macOS requirement pins a Developer ID Application leaf, the team as its OU, and runs Apple's own codesign;
     - the shell unpacks with the very tar/flate2 the plugin links (one Cargo.lock entry each);
     - every refusal reads in the Update Center as a refused download, and the no-team one as written. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const main = read('src-tauri/src/main.rs');
const verify = read('src-tauri/src/update_verify.rs');
const train = read('.github/workflows/release-train.yml');
const toml = read('src-tauri/Cargo.toml');
const lock = read('src-tauri/Cargo.lock');
const updates = read('frontend/app/updates.js');

// ---- 1. the install command's one path ----
A.ok(/\nmod update_verify;\n/.test(main), 'main.rs declares the module');
const cmdStart = main.indexOf('async fn starnet_update_install(');
const cmd = main.slice(cmdStart, main.indexOf('\n}\n', cmdStart));
A.ok(cmdStart > 0 && /let install_result = VerifiedUpdate\(&update\)\s*\n\s*\.download_and_install\(/.test(cmd), 'the install command downloads and installs through VerifiedUpdate');
A.eq((main.match(/\.download_and_install\(/g) || []).length, 1, 'no other call installs an update unchecked (the plugin\'s own download_and_install is never called)');
A.eq((main.match(/\.install\(&bytes\)/g) || []).length, 1, 'the one plugin install call');
const implStart = main.indexOf('impl VerifiedUpdate');
const impl = main.slice(implStart, main.indexOf('\n}\n', implStart));
const at = s => impl.indexOf(s);
A.ok(implStart > 0 && at('.download(on_chunk, on_download_finish)') > 0, 'VerifiedUpdate downloads with the plugin (minisign checked there)');
A.ok(at('.download(') < at('tauri::async_runtime::spawn_blocking(') && at('spawn_blocking(') < at('update_verify::verify_update_bytes(&bytes).map(|()| bytes)') && at('verify_update_bytes') < at('self.0.install(&bytes)'),
  'then the platform signer check, off the async runtime, then the install of those same bytes');
A.ok(/\)\?\?;\n\s*self\.0\.install\(&bytes\)/.test(impl), 'a refusal or a failed check returns before install');

// ---- 2. Windows: the release train's publisher, exactly ----
const pins = [...train.matchAll(/Assert-Authenticode -Label '([^']+)'[^\n]*-PublisherPattern 'CN=([^'(]+)\(\?:,\|\$\)'/g)].filter(m => /StarNet|NSIS/.test(m[1])).map(m => m[2]);
const cn = (verify.match(/pub const WINDOWS_PUBLISHER_CN: &str = "([^"]+)";/) || [])[1];
A.ok(pins.length >= 3 && pins.every(p => p === cn), 'WINDOWS_PUBLISHER_CN (' + cn + ') is the CN release-train.yml asserts on every StarNet binary: ' + JSON.stringify(pins));
A.ok(/report\.status != "Valid"/.test(verify) && /names\.len\(\) != 1 \|\| names\[0\] != WINDOWS_PUBLISHER_CN/.test(verify), 'Valid, and exactly one CN equal to the pin');
A.ok(/join\("System32"\)\s*\.join\("WindowsPowerShell"\)\s*\.join\("v1\.0"\)\s*\.join\("powershell\.exe"\)/.test(verify), 'PowerShell by its absolute path, never PATH');
A.ok(!/EncodedCommand|ExecutionPolicy/.test(verify), 'no encoded command, no execution-policy override');
A.ok(/CREATE_NO_WINDOW: u32 = 0x0800_0000/.test(verify), 'no console window flashes');

// ---- 3. macOS: Apple's codesign, a Developer ID requirement pinned to the team ----
A.ok(/const CODESIGN: &str = "\/usr\/bin\/codesign";/.test(verify), 'codesign by its absolute path');
for (const part of ['anchor apple generic', 'identifier \\"{identifier}\\"', 'certificate 1[field.1.2.840.113635.100.6.2.6] exists', 'certificate leaf[field.1.2.840.113635.100.6.1.13] exists', 'certificate leaf[subject.OU] = \\"{team}\\"']) {
  A.ok(verify.indexOf(part) > 0, 'the designated requirement has: ' + part);
}
A.ok(/"--verify"\.into\(\),\s*"--deep"\.into\(\),\s*"--strict"\.into\(\),/.test(verify) && /"-R"\.into\(\),\s*format!\("=\{requirement\}"\)\.into\(\),/.test(verify), 'codesign --verify --deep --strict -R =<requirement>');
A.ok(/let requirement = designated_requirement\(&pin\.identifier, &pin\.team\)\?;[\s\S]*unpack_app_archive\(bytes, &app\)\?;[\s\S]*codesign_verify_args\(&app, &requirement\)/.test(verify), 'the pin is chosen, the archive unpacked, then codesign verifies it');

// ---- 4. the same unpacker as the plugin ----
A.ok(/\ntar = "0\.4"\n/.test(toml) && /\nflate2 = "1"\n/.test(toml), 'Cargo.toml: tar 0.4 + flate2 1');
const desk = (lock.match(/name = "skynet-desktop"\nversion = "[^"]+"\ndependencies = \[\n([\s\S]*?)\]/) || [])[1] || '';
A.ok(/ "flate2",\n/.test(desk) && / "tar",\n/.test(desk), 'Cargo.lock: the shell depends on them');
A.eq([(lock.match(/\nname = "tar"\n/g) || []).length, (lock.match(/\nname = "flate2"\n/g) || []).length], [1, 1], 'one tar and one flate2 in the lock: the shell unpacks exactly as the plugin does');
const plugin = (lock.match(/name = "tauri-plugin-updater"\nversion = "([^"]+)"/) || [])[1];
A.eq(plugin, '2.10.1', 'the plugin version whose macOS unpack update_verify.rs mirrors (re-read install_inner on a bump)');

// ---- 5. the Update Center's words for every refusal ----
const fnStart = updates.indexOf('function cleanError(e)');
const fnEnd = updates.indexOf('\n  }\n', updates.indexOf('function installFailureText(e)')) + 4;
const installFailureText = new Function(updates.slice(fnStart, fnEnd) + '\nreturn installFailureText;')();
const refusals = [...verify.matchAll(/"(the code signature check (?:[^"\\]|\\.)*)"/g)].map(m => m[1].replace(/\\"/g, '"').replace(/\{[^}]*\}/g, 'X'));
A.ok(refusals.length >= 8, 'the refusals were found: ' + refusals.length);
for (const r of refusals) {
  A.ok(/^Update refused: the download did not match the signed StarNet release\./.test(installFailureText(new Error(r))), 'reads as a refused download: ' + r.slice(0, 80));
  A.ok(/Nothing was installed\./.test(r), '...and says nothing was installed: ' + r.slice(0, 80));
}
const noTeam = (verify.match(/pub const MAC_NO_TEAM: &str =\s*"([^"]+)";/) || [])[1];
A.ok(!!noTeam && installFailureText(new Error(noTeam)) === noTeam, 'the no-team refusal is shown as written (no "signature", no "download")');

// ---- 6. the Rust unit tests exist for each decision ----
for (const name of ['the_plan_refuses_what_could_land_outside_or_diverge', 'a_hostile_archive_writes_nothing_outside', 'unpacks_a_bundle_where_the_plugin_will',
  'the_requirement_pins_developer_id_team_and_identifier', 'the_pin_is_the_running_team_cross_checked_with_the_build', 'judges_the_installer_signer',
  'common_names_read_like_dotnet_prints_them', 'each_platform_refuses_what_it_cannot_check', 'the_real_authenticode_check']) {
  A.ok(new RegExp('fn ' + name + '\\(').test(verify), 'Rust test: ' + name);
}

A.report('update-signer-check.test');
