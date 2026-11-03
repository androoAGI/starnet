/* node test/release-train-macos-trust.test.js
   Locks the public release train's macOS trust boundary. Manual/test builds may remain
   unsigned, but a tagged shipping train must fail closed unless all Developer ID and
   notarization credentials exist, and it must require Gatekeeper's notarized verdict. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const yml = fs.readFileSync(path.join(root, '.github', 'workflows', 'release-train.yml'), 'utf8');
const submitScript = fs.readFileSync(path.join(root, 'scripts', 'notarize-macos-submit.sh'), 'utf8');
const finalizeScript = fs.readFileSync(path.join(root, 'scripts', 'notarize-macos-finalize.sh'), 'utf8');
const installedScript = fs.readFileSync(path.join(root, 'scripts', 'verify-macos-intel-installed.sh'), 'utf8');
const hydrateScript = fs.readFileSync(path.join(root, 'scripts', 'hydrate-sharp-macos-x64.sh'), 'utf8');
const nativeScript = fs.readFileSync(path.join(root, 'scripts', 'sign-macos-native-deps.sh'), 'utf8');
// read tolerantly: a missing proof is a named failure below, never a crash that hides the other assertions
const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const dmgScriptPath = path.join(root, 'scripts', 'verify-macos-dmg.sh');
const dmgScript = readIf(dmgScriptPath);
A.ok(dmgScript.length > 0, 'the DMG own-signature proof exists (scripts/verify-macos-dmg.sh)');

A.ok(/os: macos-15-intel[\s\S]{0,120}target: darwin-x64/.test(yml),
  'public Intel release runs on an actual x86_64 hosted runner');
A.ok(/Verify v0\.8\.5 station recovery on Intel macOS[\s\S]{0,220}uname -m[\s\S]{0,120}upgrade-085-090\.test\.js/.test(yml),
  'public Intel release proves the released workspace upgrade on x86_64 hardware');

const requiredStep = yml.match(
  /- name: Require complete Apple signing credentials([\s\S]*?)(?=\n      - name:)/
);
A.ok(requiredStep, 'release train has a pre-build Apple credential gate');
const gate = requiredStep[1];

for (const secret of [
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_SIGNING_IDENTITY',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID'
]) {
  A.ok(gate.includes(`secrets.${secret}`), `credential gate receives ${secret}`);
}
A.ok(gate.includes(
  'for v in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID'
), 'credential gate checks the complete Apple secret set');
A.ok(/if: runner\.os == 'macOS'/.test(gate), 'credential gate only runs on macOS legs');
A.ok(/exit 1/.test(gate), 'missing Apple credentials fail the release train');
A.ok(/Developer ID Application:/.test(gate), 'signing identity must be Developer ID Application');

const hydrateStep = yml.match(
  /- name: Hydrate Intel Sharp runtime for macOS target([\s\S]*?)(?=\n      - name: Stage bundled Node sidecar runtime)/
);
A.ok(hydrateStep, 'release train hydrates the Intel Sharp runtime on the Intel macOS runner');
const hydrate = hydrateStep[1];
A.ok(/matrix\.target == 'darwin-x64'/.test(hydrate), 'Sharp hydration only runs for the Intel target');
A.ok(/bash scripts\/hydrate-sharp-macos-x64\.sh/.test(hydrate), 'workflow delegates Sharp hydration to one named script');
A.ok(/package-lock\.json'[\s\S]*sharp-darwin-x64/.test(hydrateScript) && /sharp-libvips-darwin-x64/.test(hydrateScript),
  'Intel Sharp package versions are read from the immutable source lockfile');
A.ok(/npm pack "\$spec@\$version"/.test(hydrateScript) && /tar -xzf/.test(hydrateScript),
  'cross-build hydration extracts target packages without host-platform install checks or lifecycle scripts');
A.ok(/openssl dgst -sha512/.test(hydrateScript) && /if \[ "\$actual" != "\$expected" \]/.test(hydrateScript),
  'downloaded target packages must match their package-lock SHA-512 integrity');
A.ok(/git diff --exit-code -- package\.json package-lock\.json/.test(hydrateScript),
  'cross-build hydration proves package manifests remain unchanged');

const nativeStep = yml.match(
  /- name: Prepare and sign bundled macOS native dependencies([\s\S]*?)(?=\n      - name: Build desktop bundles)/
);
A.ok(nativeStep, 'release train has a pre-bundle native dependency signing step');
const native = nativeStep[1];
A.ok(/if: runner\.os == 'macOS'/.test(native), 'native signing only runs on macOS legs');
A.ok(/bash scripts\/sign-macos-native-deps\.sh/.test(native), 'workflow delegates nested native signing to one named script');
A.ok(/APPLE_CERTIFICATE:\?/.test(nativeScript) && /APPLE_SIGNING_IDENTITY:\?/.test(nativeScript) && /TARGET:\?/.test(nativeScript),
  'native signing script fails closed when required inputs are missing');
A.ok(/security import/.test(nativeScript) && /security set-key-partition-list/.test(nativeScript),
  'native signing imports the Developer ID certificate into an unlocked CI keychain');
A.ok(/sharp-darwin-arm64/.test(nativeScript) && /sharp-darwin-x64/.test(nativeScript),
  'each macOS leg prunes Sharp to its matching architecture');
A.ok(/file -b "\$native" \| grep -q 'Mach-O'/.test(nativeScript),
  'native signing discovers every Mach-O file instead of relying on filename extensions');
A.ok(/codesign --force --options runtime --timestamp --sign "\$APPLE_SIGNING_IDENTITY" "\$native"/.test(nativeScript),
  'every staged Mach-O dependency receives Developer ID signing with a secure timestamp');

const buildStep = yml.match(
  /- name: Build desktop bundles \(signed updater artifacts required\)([\s\S]*?)(?=\n      # P1\.5)/
);
A.ok(buildStep, 'release train has a desktop build step');
for (const credential of ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']) {
  A.ok(!buildStep[1].includes(`secrets.${credential}`),
    `Tauri build does not receive ${credential} and cannot block on built-in notarization`);
}

const trustStep = yml.match(
  /- name: Verify macOS Developer ID signing before notarization([\s\S]*?)(?=\n      # Tauri names)/
);
A.ok(trustStep, 'release train has a pre-notarization macOS trust proof');
const trust = trustStep[1];
A.ok(/Authority=Developer ID Application/.test(trust), 'trust proof rejects ad-hoc signatures');
A.ok(/flags=\.\*runtime/.test(trust), 'trust proof requires hardened runtime');
A.ok(/allow-jit/.test(trust), 'trust proof checks the bundled Node JIT entitlement');
A.ok(/find "\$app\/Contents\/Resources\/node_modules" -type f -print0/.test(trust),
  'trust proof scans the complete bundled native dependency tree');
A.ok(/nested native dependency is not Developer ID signed/.test(trust),
  'trust proof rejects unsigned or ad-hoc nested native dependencies');
A.ok(/nested native dependency has no secure timestamp/.test(trust),
  'trust proof rejects nested native dependencies without secure timestamps');
A.ok(/app_team=\$\(sed -n 's\/\^TeamIdentifier=\/\/p' "\$T\/cs\.txt"[\s\S]{0,80}bash scripts\/verify-macos-dmg\.sh signed "\$dmg" "\$app_team"/.test(trust),
  'trust proof verifies the DMG\'s own signature, from the app\'s team, before Apple submission');
A.ok(/notarization-input-\$\{\{ matrix\.target \}\}/.test(yml),
  'exact submitted DMG and submission id are preserved as a retryable artifact');
A.ok(/notarize-macos:[\s\S]*?needs: build[\s\S]*?timeout-minutes: 350/.test(yml),
  'notarization finalization is an independent bounded job');
A.ok(/intel-macos-installed-acceptance:[\s\S]*?needs: \[build, notarize-macos\][\s\S]*?runs-on: macos-15-intel/.test(yml),
  'shipping train runs installed-app acceptance on actual Intel hardware');
A.ok(/STARNET_REQUIRE_NOTARIZED: "true"[\s\S]*?verify-macos-intel-installed\.sh/.test(yml),
  'shipping Intel acceptance requires the notarized Developer ID verdict');
A.ok(/assemble:[\s\S]*?needs: \[build, notarize-macos, intel-macos-installed-acceptance\]/.test(yml),
  'release assembly waits for notarized Mac artifacts and installed Intel acceptance');

A.ok(/notarytool submit/.test(submitScript) && !/notarytool submit[\s\S]*?--wait/.test(submitScript),
  'submission is asynchronous and never consumes a runner waiting on Apple');
A.ok(/\.id/.test(submitScript), 'submission id is required and persisted');
A.ok(/notarytool info/.test(finalizeScript), 'finalizer resumes the saved Apple submission');
A.ok(/temporary failure polling Apple/.test(finalizeScript), 'transient polling failures are retried');
A.ok(/exit 75/.test(finalizeScript), 'an Apple queue timeout fails retryably before GitHub cancels the runner');
A.ok(/stapler staple/.test(finalizeScript) && /stapler validate/.test(finalizeScript),
  'accepted DMG is stapled and validated');
A.ok(/source=Notarized Developer ID/.test(finalizeScript),
  'finalizer asks Gatekeeper for the notarized verdict');
A.ok(/source=Notarized Developer ID[\s\S]*?exit 1/.test(finalizeScript),
  'a non-notarized Gatekeeper source is a hard failure');
A.ok(!/no Apple cert[\s\S]*?exit 0/.test(finalizeScript),
  'shipping trust proof has no unsigned-success escape hatch');
A.ok(/exit 75[\s\S]*?verify-macos-dmg\.sh" notarized "\$dmg" "\$APPLE_TEAM_ID"[\s\S]*?hdiutil attach/.test(finalizeScript),
  'finalizer proves the stapled DMG\'s own signature and verdict before mounting it');
A.ok(/hdiutil detach "\$mount_point"[\s\S]*?shasum -a 256 "\$dmg"[\s\S]*?!= "\$dmg_sha"[\s\S]*?exit 1/.test(finalizeScript),
  'finalizer refuses to hand on DMG bytes that changed after their signature was verified');

A.ok(/codesign --verify --strict --verbose=2 "\$dmg"/.test(dmgScript), 'DMG proof runs a strict codesign verify');
A.ok(/\^Authority=Developer ID Application/.test(dmgScript) && /TeamIdentifier/.test(dmgScript),
  'DMG proof requires the release team\'s Developer ID authority');
A.ok(/xcrun stapler validate "\$dmg"/.test(dmgScript), 'DMG proof validates the stapled ticket');
A.ok(/spctl -a -t open --context context:primary-signature -vv "\$dmg"/.test(dmgScript)
  && /source=Notarized Developer ID/.test(dmgScript),
  'DMG proof asks Gatekeeper for the notarized disk-image verdict');

// Run the real DMG proof against stub macOS tools: every failure mode must exit non-zero.
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const git = ['ProgramFiles', 'ProgramW6432', 'LOCALAPPDATA']
    .map((v) => process.env[v] && path.join(process.env[v], v === 'LOCALAPPDATA' ? 'Programs/Git' : 'Git', 'bin', 'bash.exe'))
    .find((p) => p && fs.existsSync(p));
  return git || null; // never C:\Windows\System32\bash.exe (WSL): it cannot see these Windows paths
}
const os = require('os');
const { spawnSync } = require('child_process');
const bash = findBash();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-proof-test-'));
const posix = (p) => p.replace(/\\/g, '/');
const stubs = {
  codesign: `case "$1" in
  --verify) [ "\${STUB_VERIFY:-ok}" = ok ] && { echo "$4: valid on disk"; exit 0; }
            echo "$4: invalid signature (code or signature have been modified)"; exit 1 ;;
  -dvvv) printf 'Executable=%s\\nAuthority=%s\\nTeamIdentifier=%s\\nTimestamp=Oct 26, 2026\\n' "$2" \\
           "\${STUB_AUTHORITY:-Developer ID Application: Test (TEAM123456)}" "\${STUB_TEAM:-TEAM123456}" >&2 ;;
esac`,
  xcrun: `[ "\${STUB_STAPLED:-ok}" = ok ] && { echo "The validate action worked!"; exit 0; }
echo "$3 does not have a ticket stapled to it."; exit 65`,
  spctl: `printf '%s: %s\\nsource=%s\\n' "$7" "\${STUB_SPCTL_VERDICT:-accepted}" "\${STUB_SPCTL_SOURCE:-Notarized Developer ID}"
exit "\${STUB_SPCTL_EXIT:-0}"`,
  shasum: `echo "0000000000000000000000000000000000000000000000000000000000000000  $3"`
};
for (const [name, body] of Object.entries(stubs)) {
  fs.writeFileSync(path.join(tmp, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}
const dmg = path.join(tmp, 'StarNet_0.0.0_aarch64.dmg');
fs.writeFileSync(dmg, 'fixture image bytes');
const prove = (mode, env, team = 'TEAM123456') => spawnSync(bash, [posix(dmgScriptPath), mode, posix(dmg), team], {
  encoding: 'utf8',
  env: { ...process.env, ...env, RUNNER_TEMP: posix(tmp), PATH: tmp + path.delimiter + process.env.PATH }
});
const out = (r) => (r.error ? r.error.message : `exit ${r.status}: ${`${r.stdout || ''}${r.stderr || ''}`.trim().slice(-700)}`);
// Whether this box has a usable POSIX bash is decided by a trivial probe, never by the script under test: a broken
// proof must fail here, not read as "no bash" and skip.
const bashProbe = bash && spawnSync(bash, ['-c', 'echo ok'], { encoding: 'utf8' });
const bashUsable = !!(bashProbe && !bashProbe.error && bashProbe.status === 0 && bashProbe.stdout.trim() === 'ok');
if (!bashUsable) {
  console.log(`SKIP: no usable POSIX bash for the stubbed DMG proof${bashProbe ? ` (${out(bashProbe)})` : ''}; static assertions still run.`);
} else {
  const probe = prove('notarized', {});
  A.ok(probe.status === 0 && /DMG notarized proof passed/.test(probe.stdout) && /team TEAM123456/.test(probe.stdout),
    'a valid stapled Developer ID DMG passes the notarized proof: ' + out(probe));
  A.eq(prove('signed', { STUB_STAPLED: 'missing', STUB_SPCTL_EXIT: '3' }).status, 0,
    'the pre-submission proof needs only the signature (no ticket exists yet)');
  for (const [label, env, team] of [
    ['a modified DMG signature', { STUB_VERIFY: 'modified' }],
    ['an ad-hoc DMG signature', { STUB_AUTHORITY: 'adhoc' }],
    ['another team\'s DMG signature', { STUB_TEAM: 'OTHER00000' }],
    ['a DMG with no stapled ticket', { STUB_STAPLED: 'missing' }],
    ['a Gatekeeper rejection', { STUB_SPCTL_VERDICT: 'rejected', STUB_SPCTL_EXIT: '3' }],
    ['an accepted but un-notarized source', { STUB_SPCTL_SOURCE: 'Developer ID' }],
    ['a non-zero spctl exit', { STUB_SPCTL_EXIT: '1' }]
  ]) {
    const r = prove('notarized', env, team);
    A.ok(r.status === 1 && /::error::/.test(r.stdout), `${label} fails the notarized DMG proof`);
  }
  A.eq(prove('signed', {}, ' TEAM123456\n').status, 0, 'whitespace around the expected team id is ignored');
  A.eq(prove('released', {}).status, 1, 'an unknown proof mode fails closed');
}
fs.rmSync(tmp, { recursive: true, force: true });
A.ok(/spctl -a -t exec -vv "\$installed"/.test(installedScript)
  && /source=Notarized Developer ID/.test(installedScript),
  'installed verifier rechecks Gatekeeper on the app copied out of the DMG');
A.ok(/tail -n "\+\$\(\(before_lines \+ 1\)\)"/.test(installedScript)
  && /listening=true/.test(installedScript)
  && /curl -fsS "http:\/\/127\.0\.0\.1:\$candidate_port\/api\/health"/.test(installedScript),
  'installed verifier proves the Finder-launched bundled sidecar is listening');
A.ok(/\.migration-receipt\.json/.test(installedScript) && /receipt\.get\("validated"\) is True/.test(installedScript),
  'installed verifier requires the activated v0.9.0 migration receipt');

// ---- Installed integrity on the notarized Intel install (85f602c4 / E62, gh#136) ----
// scripts/verify-macos-installed-integrity.sh judges each launch's page-boot line, then the executable's own headless
// verify over its embedded install manifest, then a zeroed module in a copy of the app. Here: how the acceptance wires it.
const integrityPath = path.join(root, 'scripts', 'verify-macos-installed-integrity.sh');
const integrityScript = readIf(integrityPath);
const MODULE = 'sidecar/tools/builtin/shell.js';
A.ok(integrityScript.length > 0, 'the installed-integrity proof exists (scripts/verify-macos-installed-integrity.sh)');

A.ok(/exe="\$installed\/Contents\/MacOS\/skynet-desktop"/.test(installedScript)
  && /startup_log="\$app_data\/startup\.log"/.test(installedScript),
  'the executable and startup.log the integrity claims use are the acceptance\'s own variables');
A.ok(/launch_start=\$\(\(before_lines\)\)/.test(installedScript) && /first_launch_start=\$launch_start/.test(installedScript),
  'each Finder launch records where its own startup.log lines begin');
A.eq((installedScript.match(/\nlaunch_with_finder\nbash "\$integrity" page-boot "\$startup_log" "\$launch_start" 90\n/g) || []).length, 2,
  'each Finder launch waits for and judges its own page-boot line before the checks that follow it');
const lastQuit = installedScript.lastIndexOf('\nquit_cleanly\n');
const wholeBoot = installedScript.indexOf('bash "$integrity" page-boot "$startup_log" "$first_launch_start" 0 | tee "$integrity_dir/page-boot.txt"');
const installClaims = installedScript.indexOf('bash "$integrity" install "$installed" "$exe" "$integrity_dir"');
const receiptWriter = installedScript.indexOf('python3 - "$receipt" "$dmg" "$installed" "$launch_port" "$source_hash_before" "$require_notarized" "$integrity_dir"');
A.ok(lastQuit > 0 && wholeBoot > lastQuit && installClaims > wholeBoot && receiptWriter > installClaims,
  'after the last quit: every page-boot line of both launches is judged, then the install claims run, then the receipt is written');
A.ok(/integrity_receipt\("install-verify\.json"\)/.test(installedScript) && /integrity_receipt\("zeroed-verify\.json"\)/.test(installedScript)
  && installedScript.includes(`module = "${MODULE}"`) && /named != \[module\]/.test(installedScript),
  'the receipt writer re-reads the machine receipts both verifies wrote and requires exactly the zeroed module');
A.ok(/"installVerify": \{"state": verify\["state"\]/.test(installedScript) && /"pageBoot": \{"passed": True, "lines": page_boot\}/.test(installedScript)
  && /"zeroedModule": \{"path": module, "inACopyOfTheApp": True/.test(installedScript),
  'the acceptance receipt carries the three installed-integrity results');

// The proof itself runs for real, executable stubbed, in test/installed-integrity-proofs.test.js.

A.report('release-train-macos-trust.test');
