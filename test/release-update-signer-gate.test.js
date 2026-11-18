/* node test/release-update-signer-gate.test.js — GHSA-2hpj #10 release gate invariants.

   An installed StarNet refuses any update its own signer check (src-tauri/src/update_verify.rs) does not admit. If that
   check were wrong for the real signed artifacts (the tar-crate unpack of a shipped .app.tar.gz failing
   `codesign --deep --strict`, a malformed `-R =` requirement, a publisher CN that drifted), every installed copy would
   refuse the next update. The release train therefore runs the SAME code (update-verify-gate compiles update_verify.rs
   unchanged) on the artifacts it just built and signed, and fails before anything is uploaded or published.

   This locks, without running CI (pure text/structure, no YAML parser, as release-train-provenance.test.js):
     · both gate steps exist in the build job, on the right runner, pointing at the right artifacts;
     · each runs after its platform's signing proof and before every upload/submission of that platform's bytes
       (and every publishing job needs the build job);
     · the macOS team comes from the signed .app itself, no secret enters the step, and a failure fails the job;
     · the gate is cheap (a tiny crate into the job's existing target dir, --locked, no release/tauri build);
     · the gate crate compiles the shell's file and its lock pins the app's tar/flate2 (the plugin's unpacker). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const yml = read('.github/workflows/release-train.yml');

// ---- the build job and its steps, in order ----
const hdr = yml.match(/^  build:$/m);
A.ok(hdr, 'release-train.yml has a `build` job');
const afterBuild = yml.slice(hdr.index + hdr[0].length);
const buildJob = afterBuild.slice(0, afterBuild.search(/^  [a-z0-9_-]+:$/m));
const steps = buildJob.split(/\n(?=      - )/).filter(s => /^      - /.test(s)).map(text => ({
  text,
  name: ((text.match(/^      - name: (.+)$/m) || [])[1] || '').trim(),
  os: ((text.match(/^        if: runner\.os == '(\w+)'/m) || [])[1] || 'any'),
  uploads: /uses: actions\/upload-artifact@/.test(text),
  run: (text.split(/^        run: \|\n/m)[1] || '')
}));
const at = name => steps.findIndex(s => s.name === name);
const MAC_GATE = 'Gate the updater archive through the shell\'s own update signer check';
const WIN_GATE = 'Gate the signed installer through the shell\'s own update signer check';
const mac = steps[at(MAC_GATE)], win = steps[at(WIN_GATE)];
A.ok(!!mac && mac.os === 'macOS', 'the macOS gate step exists and runs on the macOS legs');
A.ok(!!win && win.os === 'Windows', 'the Windows gate step exists and runs on the Windows leg');

// ---- order: after signing + its proof, before anything leaves the runner ----
const order = (a, b, why) => A.ok(at(a) >= 0 && at(b) >= 0 && at(a) < at(b), why + ' (' + a + ' < ' + b + ')');
order('Build desktop bundles (signed updater artifacts required)', MAC_GATE, 'the macOS gate runs on the built + signed bytes');
order('Verify macOS Developer ID signing before notarization', MAC_GATE, 'after the Developer ID proof of the same .app');
order(MAC_GATE, 'Rename mac updater bundle per-arch (basename collision guard)', 'on the archive as the bundler wrote it');
order(MAC_GATE, 'Submit macOS DMG for asynchronous notarization', 'before Apple sees the bytes');
order('Verify Windows Authenticode signing + timestamp', WIN_GATE, 'the Windows gate runs after the Authenticode proof');
order(WIN_GATE, 'Prove published Windows upgrades survive a broken old uninstaller', 'before the upgrade proof');
const macIdx = at(MAC_GATE), winIdx = at(WIN_GATE);
const lateUploads = steps.map((s, i) => ({ s, i })).filter(({ s }) => s.uploads);
A.ok(lateUploads.length >= 3, 'the build job\'s uploads were found: ' + lateUploads.map(u => u.s.name).join(' | '));
for (const { s, i } of lateUploads) {
  if (s.os === 'macOS' || s.os === 'any') A.ok(i > macIdx, 'macOS bytes upload only after the gate: ' + s.name);
  if (s.os === 'Windows' || s.os === 'any') A.ok(i > winIdx, 'Windows bytes upload only after the gate: ' + s.name);
}
const needsOf = job => ((yml.match(new RegExp('^  ' + job + ':\\n    needs: (.+)$', 'm')) || [])[1] || '');
A.ok(/\bbuild\b/.test(needsOf('notarize-macos')) && /\bbuild\b/.test(needsOf('assemble')) && /\bassemble\b/.test(needsOf('stage-draft')),
  'notarization, the manifest and the draft release all wait for the build job (a failed gate publishes nothing)');

// ---- macOS: the right artifacts, the team from the signed .app, no secrets, fail closed ----
A.ok(/set -euo pipefail/.test(mac.run), 'macOS gate: any failure fails the step');
A.ok(/find src-tauri\/target -type d -name '\*\.app' -path '\*\/release\/bundle\/macos\/\*'/.test(mac.run), 'macOS gate: the signed .app this leg built');
A.ok(/find src-tauri\/target -type f -name '\*\.app\.tar\.gz' -path '\*\/release\/bundle\/macos\/\*'/.test(mac.run) && /\[ "\$count" -eq 1 \]/.test(mac.run),
  'macOS gate: exactly one updater archive, the one the feed will serve');
A.ok(/team=\$\(codesign -dv "\$app" 2>&1 \| sed -n 's\/\^TeamIdentifier=\/\/p' \| head -1\)/.test(mac.run) && /""\|"not set"\)/.test(mac.run),
  'macOS gate: the expected team is the signed .app\'s own TeamIdentifier, and a missing one fails');
A.ok(!/secrets\./.test(mac.text) && !/APPLE_/.test(mac.text), 'macOS gate: no Apple secret enters the step');
A.ok(/src-tauri\/target\/debug\/update-verify-gate macos "\$archives" "\$app" "\$team"/.test(mac.run), 'macOS gate: runs the shell\'s check on that archive, pinned by that .app');

// ---- Windows: the right installer, fail closed ----
A.ok(/\$ErrorActionPreference = 'Stop'/.test(win.run), 'Windows gate: errors stop the step');
A.ok(/-Filter "\*_\$\(\$version\)_\*-setup\.exe"/.test(win.run) && /'\[\\\\\/\]release\[\\\\\/\]bundle\[\\\\\/\]nsis\[\\\\\/\]'/.test(win.run) && /\$installers\.Count -ne 1/.test(win.run),
  'Windows gate: exactly one signed NSIS installer of this version');
A.ok(/& 'src-tauri\/target\/debug\/update-verify-gate\.exe' windows \$installers\[0\]\.FullName \$foreign/.test(win.run), 'Windows gate: runs the shell\'s check on that installer, with a foreign-signed control');
A.eq((win.run.match(/if \(\$LASTEXITCODE -ne 0\) \{/g) || []).length, 2, 'Windows gate: a failed build or a refusal throws');
// The step runs in PowerShell 7 and the gate inherits its module path on purpose: v0.15.2's check handed that path on to
// its Windows PowerShell child, which then could not load Get-AuthenticodeSignature, and a valid installer read
// "unreadable" (the first v0.15.2 train). The CHECK gives its child Windows PowerShell's own module folder; the gate
// step must not hide a check that stops doing so, and desktop-build rehearses both gates before a tag exists.
A.ok(/^        shell: pwsh$/m.test(win.text) && !/PSModulePath/.test(win.run.replace(/^\s*#.*$/gm, '')),
  'Windows gate: runs in PowerShell 7 and leaves the inherited module path alone (the hostile case stays proven)');
const shellRs = read('src-tauri/src/update_verify.rs');
A.ok(/cmd\.env\("PSModulePath", powershell_modules_path\(\)\);/.test(shellRs) && /fn powershell_modules_path\(\) -> PathBuf \{\s*powershell_path\(\)\.with_file_name\("Modules"\)/.test(shellRs),
  'the shell\'s check gives Windows PowerShell its own module folder, never the caller\'s');
A.ok(/run_bounded\(authenticode_command\(&file\), AUTHENTICODE_LIMIT\)/.test(shellRs), 'verify_windows_update runs that command');
A.ok(/fn the_check_does_not_inherit_the_callers_module_path\(\)/.test(shellRs), 'a Rust test runs the real check and its poisoned-path control');

// ---- desktop-build rehearses both gates on the release branch, before any tag ----
const db = read('.github/workflows/desktop-build.yml');
const dbSteps = db.split(/\n(?=      - )/).filter(s => /^      - /.test(s)).map(text => ({
  text, name: ((text.match(/^      - name: (.+)$/m) || [])[1] || '').trim(),
  os: ((text.match(/^        if: runner\.os == '(\w+)'/m) || [])[1] || 'any'), run: (text.split(/^        run: \|\n/m)[1] || '')
}));
const dbAt = name => dbSteps.findIndex(s => s.name === name);
const rWin = dbSteps[dbAt('Rehearse the update signer gate on the signed installer')];
const rMac = dbSteps[dbAt('Rehearse the update signer gate on the updater archive')];
A.ok(!!rWin && rWin.os === 'Windows' && /^        shell: pwsh$/m.test(rWin.text), 'desktop-build rehearses the Windows gate, in PowerShell 7 as the train runs it');
A.ok(!!rMac && rMac.os === 'macOS' && /^        shell: bash$/m.test(rMac.text), 'desktop-build rehearses the macOS gate');
A.ok(dbAt('Build desktop bundles') < dbAt(rWin.name) && dbAt(rWin.name) < dbAt('Upload distributable artifacts')
  && dbAt('Build desktop bundles') < dbAt(rMac.name) && dbAt(rMac.name) < dbAt('Submit macOS DMG for asynchronous notarization'),
  'both rehearsals run on the built + signed bytes, before they leave the runner');
A.ok(/& 'src-tauri\/target\/debug\/update-verify-gate\.exe' windows \$installers\[0\]\.FullName \$foreign/.test(rWin.run)
  && !/PSModulePath/.test(rWin.run.replace(/^\s*#.*$/gm, '')) && /\$installers\.Count -ne 1/.test(rWin.run),
  'Windows rehearsal: the same call on the one installer, with the inherited module path left alone');
A.ok(/\.Status -eq 'NotSigned'\) \{\n\s*Write-Output "::notice::[^\n]*\n\s*exit 0/.test(rWin.run), 'Windows rehearsal: only an unsigned internal build skips, and says so');
A.ok(/src-tauri\/target\/debug\/update-verify-gate macos "\$archives" "\$app" "\$team"/.test(rMac.run) && /set -euo pipefail/.test(rMac.run)
  && /\[ "\$count" -eq 1 \]/.test(rMac.run), 'macOS rehearsal: the same call on the one archive, fail closed');
for (const s of [rWin, rMac]) {
  A.ok(!/secrets\./.test(s.text) && !/APPLE_|AZURE_/.test(s.text), 'rehearsal: no secret enters the step (' + s.name + ')');
  A.ok(/cargo build --locked --manifest-path src-tauri\/update-verify-gate\/Cargo\.toml --target-dir src-tauri\/target/.test(s.run), 'rehearsal: the tiny locked crate (' + s.name + ')');
}
A.ok(!/secrets\./.test(win.text), 'Windows gate: no secret enters the step');

// ---- cheap: a tiny crate, locked, into the job's existing target dir ----
for (const [label, s] of [['macOS', mac], ['Windows', win]]) {
  A.ok(/cargo build --locked --manifest-path src-tauri\/update-verify-gate\/Cargo\.toml --target-dir src-tauri\/target/.test(s.run), label + ' gate: builds the gate crate --locked into src-tauri/target');
  A.ok(!/--release|tauri -- build|tauri build/.test(s.run), label + ' gate: no release or app rebuild');
}

// ---- the gate crate is the shell's code, with the plugin's unpacker ----
const toml = read('src-tauri/update-verify-gate/Cargo.toml');
const gate = read('src-tauri/update-verify-gate/src/main.rs');
const verify = read('src-tauri/src/update_verify.rs');
A.ok(/^\[workspace\]$/m.test(toml) && /^publish = false$/m.test(toml), 'its own workspace root, never published');
const deps = (toml.split(/^\[dependencies\]$/m)[1] || '').split(/^\[/m)[0].split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.split(/\s*=/)[0]);
A.eq(deps.sort(), ['flate2', 'tar'], 'only tar + flate2');
A.ok(/#\[path = "\.\.\/\.\.\/src\/update_verify\.rs"\]\nmod update_verify;/.test(gate), 'compiles src-tauri/src/update_verify.rs itself');
A.ok(/update_verify::verify_macos_update_against\(&bytes, app\)/.test(gate) && /update_verify::codesign_against\(app, &other\)/.test(gate), 'macOS: the shell\'s whole path, then the other-team control');
A.ok(/if team != pin\.team/.test(gate), 'macOS: the pin must be the expected team');
A.ok(/update_verify::verify_windows_update\(&bytes\)/.test(gate) && /"control failed: \{\} was admitted/.test(gate), 'Windows: the shell\'s function, then controls that must be refused');
A.ok(/ExitCode::FAILURE/.test(gate) && /::error::/.test(gate), 'a refusal is a GitHub error and a failing exit');
A.ok(/fn verify_macos_update\(bytes: &\[u8\]\)[\s\S]*?verify_macos_update_against\(bytes, &running\)/.test(verify), 'the installed shell runs the same verify_macos_update_against the gate runs');
const lockPkgs = s => new Map([...s.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g)].map(m => [m[1], m[2]]));
const appLock = lockPkgs(read('src-tauri/Cargo.lock')), gateLock = lockPkgs(read('src-tauri/update-verify-gate/Cargo.lock'));
A.eq([gateLock.get('tar'), gateLock.get('flate2')], [appLock.get('tar'), appLock.get('flate2')], 'the gate unpacks with the app\'s (the plugin\'s) tar and flate2 versions');
const drift = [...gateLock].filter(([n, v]) => n !== 'update-verify-gate' && appLock.get(n) !== v).map(([n, v]) => n + '@' + v);
A.eq(drift, [], 'every crate in the gate lock is at the app lock\'s version');
A.ok(/^\/target$/m.test(read('src-tauri/update-verify-gate/.gitignore')), 'a local build of the gate never dirties the shipped tree');

A.report('release-update-signer-gate.test');
