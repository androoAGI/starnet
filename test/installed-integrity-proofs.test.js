/* node test/installed-integrity-proofs.test.js
   The installed proofs on both platforms (85f602c4 / E62, gh#136) run for real, with the executable as their only
   fake: scripts/verify-macos-installed-integrity.sh (the Intel installed acceptance) in bash, and the Windows
   published-upgrade proof's own Assert-InstalledIntegrity (scripts/ci/windows-published-upgrade-proof.ps1) in Windows
   PowerShell. Each is green only for a verified install whose zeroed module is named (and, on the Mac, a page that
   booted whole), and red for every way it could pass without proving that. The fake,
   test/fixtures/install-verify-stub.js, speaks the language pinned below to the Rust that prints it. How the two proofs
   are wired into the acceptances: test/release-train-macos-trust.test.js and test/installer-upgrade-resilience.test.js. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
// read tolerantly: a missing proof is a named failure below, never a crash that hides the other assertions
const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const integrityPath = path.join(root, 'scripts', 'verify-macos-installed-integrity.sh');
const integrityScript = readIf(integrityPath);
const proofPs1 = readIf(path.join(root, 'scripts', 'ci', 'windows-published-upgrade-proof.ps1'));
const manifestRs = readIf(path.join(root, 'src-tauri', 'src', 'install_manifest.rs'));
const bootReportRs = readIf(path.join(root, 'src-tauri', 'src', 'boot_report.rs'));
const stubJs = path.join(__dirname, 'fixtures', 'install-verify-stub.js');
const MODULE = 'sidecar/tools/builtin/shell.js';
const HEALTHY_BOOT = 'page-boot: passed · 270 of 270 station scripts ran · 0 not run';
const posix = (p) => p.replace(/\\/g, '/');
const out = (r) => (r.error ? r.error.message : `exit ${r.status}: ${`${r.stdout || ''}${r.stderr || ''}`.trim().slice(-700)}`);

A.ok(integrityScript.length > 0, 'the Mac installed-integrity proof exists (scripts/verify-macos-installed-integrity.sh)');
A.ok(proofPs1.includes('function Assert-InstalledIntegrity'), 'the Windows published-upgrade proof carries Assert-InstalledIntegrity');

// one floor and one module for both platforms: the same resource trees ship on each
const macFloor = (integrityScript.match(/^MIN_MANIFEST_FILES=(\d+)$/m) || [])[1];
const winFloor = (proofPs1.match(/\[int\]\$MinFiles = (\d+)/) || [])[1];
A.ok(macFloor && macFloor === winFloor, `the Mac and Windows installed proofs hold one manifest floor (${macFloor} / ${winFloor})`);
A.ok(integrityScript.includes(`\nMODULE=${MODULE}\n`) && proofPs1.includes(`[string]$Module = '${MODULE}'`),
  'both installed proofs zero the same module (85f602c4 / E62)');

// the stub speaks the executable's language: each piece it mirrors, pinned to the Rust that prints it
for (const [what, needle] of [
  ['the headless verify prints its verdict as "install: <summary>"', 'println!("install: {}", verdict.summary());'],
  ['and each named file under it, indented two spaces', 'println!("  {}", finding.describe());'],
  ['a verified install reads "verified N files"', 'format!("verified {} files", grouped(*files as u64))'],
  ['a damaged one "DAMAGED - n of N files: <first named>"', '"DAMAGED - {} of {} files: {}"'],
  ['an empty file is "<path> is empty (0 of N bytes)"', 'format!("{path} is empty (0 of {} bytes)", grouped(*expected))'],
  ['verified exits 0', 'pub const EXIT_VERIFIED: i32 = 0;'],
  ['damaged exits 3', 'pub const EXIT_DAMAGED: i32 = 3;'],
  ['not checked exits 4', 'pub const EXIT_NOT_CHECKED: i32 = 4;'],
  ['--out writes the starnet.install-verify/1 receipt', 'serde_json::json!("starnet.install-verify/1")'],
  ['the receipt names each finding by path, damage kind and text', '"path": f.path, "damage": f.damage.kind(), "expected": expected, "actual": actual,'],
  ['the install root is the exe folder, then ../Resources, then ../lib/<product>', 'dir.join("..").join("Resources")'],
  ['a sidecar folder is preferred when it survives', 'candidates.iter().find(|c| c.join("sidecar").is_dir())'],
  ['other bundle roots keep a missing sidecar tree diagnosable', 'resource_map(include_str!("../tauri.conf.json")).ok()?']
]) A.ok(manifestRs.includes(needle), `install_manifest.rs: ${what} (the stub mirrors it)`);
A.ok(bootReportRs.includes(`"${HEALTHY_BOOT}"`) && bootReportRs.includes('let mut line = format!("page-boot: {}", verdict(r));'),
  'boot_report.rs still writes the healthy page-boot line the Mac acceptance requires');

// ---- the Mac proof, in bash ----
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const git = ['ProgramFiles', 'ProgramW6432', 'LOCALAPPDATA']
    .map((v) => process.env[v] && path.join(process.env[v], v === 'LOCALAPPDATA' ? 'Programs/Git' : 'Git', 'bin', 'bash.exe'))
    .find((p) => p && fs.existsSync(p));
  return git || null; // never C:\Windows\System32\bash.exe (WSL): it cannot see these Windows paths
}
const bash = findBash();
// decided by a trivial probe, never by the proof under test: a broken proof fails here, it never reads as "no bash"
const bashProbe = bash && spawnSync(bash, ['-c', 'echo ok'], { encoding: 'utf8' });
const bashUsable = !!(bashProbe && !bashProbe.error && bashProbe.status === 0 && bashProbe.stdout.trim() === 'ok');
if (!bashUsable) {
  console.log(`SKIP: no usable POSIX bash for the Mac installed-integrity proof${bashProbe ? ` (${out(bashProbe)})` : ''}; static assertions still run.`);
} else {
  const itmp = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-integrity-test-'));
  try {
    const bin = path.join(itmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'ditto'), '#!/usr/bin/env bash\nexec cp -R "$1" "$2"\n', { mode: 0o755 });
    const app = path.join(itmp, 'Applications', 'StarNet.app');
    const exe = path.join(app, 'Contents', 'MacOS', 'skynet-desktop');
    const resources = path.join(app, 'Contents', 'Resources');
    const listed = {
      'sidecar/index.js': "const { makeShellTool } = require('./tools/builtin/shell.js');\n",
      [MODULE]: "module.exports = { makeShellTool() { return 'shell'; } };\n",
      'frontend/app/bootguard.js': 'window.BootGuard = {};\n',
      'node_modules/voice/index.js': 'module.exports = 1;\n'
    };
    for (const [rel, body] of Object.entries(listed)) {
      const file = path.join(resources, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '#!/usr/bin/env bash\nexport STUB_EXE="$0"\nexec "$STUB_NODE" "$STUB_JS" "$@"\n', { mode: 0o755 });
    const manifestPath = path.join(itmp, 'stub-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(Object.entries(listed).map(([p, body]) => ({ path: p, size: Buffer.byteLength(body) }))));
    const work = path.join(itmp, 'work');
    const integrity = (args, env = {}) => spawnSync(bash, [posix(integrityPath), ...args], {
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        STUB_NODE: posix(process.execPath),
        STUB_JS: posix(stubJs),
        STUB_MANIFEST: manifestPath,
        ...env,
        PATH: bin + path.delimiter + process.env.PATH
      }
    });
    const claims = (env) => integrity(['install', posix(app), posix(exe), posix(work)], env);
    const moduleFile = path.join(resources, ...MODULE.split('/'));
    const moduleBytes = fs.readFileSync(moduleFile);
    const untouched = () => fs.readFileSync(moduleFile).equals(moduleBytes);

    const green = claims({});
    A.ok(green.status === 0 && /::notice::installed app: verified 2,391 files/.test(green.stdout)
      && green.stdout.includes(`::notice::a copy of the app with an empty ${MODULE}: its headless verify exits 3 naming it (${MODULE} is empty (0 of `),
      'a verified install whose zeroed copy names the module passes, saying both: ' + out(green));
    A.ok(untouched(), 'the installed module is untouched: only the copy was zeroed');
    A.ok(!fs.existsSync(path.join(work, 'zeroed-copy')), 'the zeroed copy of the app is removed');
    const zeroedReceipt = fs.existsSync(path.join(work, 'zeroed-verify.json')) ? JSON.parse(fs.readFileSync(path.join(work, 'zeroed-verify.json'), 'utf8')) : {};
    A.ok(zeroedReceipt.state === 'damaged' && (zeroedReceipt.findings || []).length === 1 && zeroedReceipt.findings[0].path === MODULE
      && path.resolve(String(zeroedReceipt.root)).startsWith(path.resolve(work, 'zeroed-copy')),
      'the copy\'s own executable checked the copy\'s own resources, and its receipt is kept: ' + JSON.stringify(zeroedReceipt));
    A.ok(fs.existsSync(path.join(work, 'install-verify.json'))
      && JSON.parse(fs.readFileSync(path.join(work, 'install-verify.json'), 'utf8')).state === 'verified',
      'the installed app\'s verify receipt is kept for the acceptance receipt');

    for (const [label, env, why] of [
      ['an install its executable does not check', { STUB_MODE: 'not-checked' }, /exited 4 and reads 'install: not checked/],
      ['a manifest of too few files', { STUB_FILES: '12' }, /verified only 12 files/],
      ['an executable built before the install manifest', { STUB_MODE: 'no-receipt' }, /wrote no install-verify receipt/],
      ['a verify blind to the zeroed module', { STUB_MODE: 'blind' }, /headless verify exited 0 \('install: verified 2,391 files'\), not 3 \(damaged\)/],
      ['a verify that names another file', { STUB_MODE: 'other' }, /not that one file empty/]
    ]) {
      const r = claims(env);
      A.ok(r.status === 1 && /::error::/.test(r.stdout) && why.test(r.stdout), `${label} fails the Mac installed proof: ` + out(r));
      A.ok(untouched(), `${label}: the installed module stays untouched`);
    }
    const index = path.join(resources, 'sidecar', 'index.js');
    fs.writeFileSync(index, '');
    const damaged = claims({});
    fs.writeFileSync(index, listed['sidecar/index.js']);
    A.ok(damaged.status === 1 && /exited 3 and reads 'install: DAMAGED - 1 of 2,391 files: sidecar\/index\.js is empty \(0 of /.test(damaged.stdout),
      'an installed app with a damaged file fails the first claim: ' + out(damaged));
    const outside = integrity(['install', posix(app), posix(path.join(itmp, 'elsewhere', 'skynet-desktop')), posix(work)]);
    A.ok(outside.status === 1 && /is not inside/.test(outside.stdout), 'an executable outside the installed app is refused: ' + out(outside));

    const log = path.join(itmp, 'startup.log');
    const writeLog = (lines) => fs.writeFileSync(log, lines.join('\n') + '\n');
    const pageBoot = (from, wait = 0) => integrity(['page-boot', posix(log), String(from), String(wait)]);
    writeLog(['spawn_sidecar pid=1 port=1 listening=true',
      'page-boot: DEGRADED · 269 of 270 station scripts ran · 1 not run: app/workflowline.js (SyntaxError at line 797)',
      'spawn_sidecar pid=2 port=2 listening=true', HEALTHY_BOOT]);
    let r = pageBoot('       2');
    A.ok(r.status === 0 && r.stdout.trim() === HEALTHY_BOOT,
      'a launch whose page booted whole passes, from a wc -l style start, and an earlier launch\'s degraded boot is not its verdict: ' + out(r));
    r = pageBoot(0);
    A.ok(r.status === 1 && /did not boot whole \(startup\.log line 2\): page-boot: DEGRADED · 269 of 270/.test(r.stdout),
      'a page that did not run a station script (gh#136) fails its launch, naming the line: ' + out(r));
    for (const [label, line] of [
      ['a failed boot', 'page-boot: FAILED · 268 of 270 station scripts ran · 2 not run: app/recipes.js (failed to load) · missing: World'],
      ['a dropped boot report', 'page-boot: the page sent a boot report that was dropped (a count is missing or not a whole number)'],
      ['a page that counted no station script', 'page-boot: DEGRADED · no station script was counted · 0 not run'],
      ['a passed line whose counts disagree', 'page-boot: passed · 269 of 270 station scripts ran · 0 not run'],
      ['an engine below the floor', `${HEALTHY_BOOT} · the web engine is below the floor`]
    ]) {
      writeLog(['spawn_sidecar pid=3 port=3 listening=true', HEALTHY_BOOT, line]);
      r = pageBoot(1);
      A.ok(r.status === 1 && r.stdout.includes(`::error::the installed station page did not boot whole (startup.log line 3): ${line}`),
        `${label} after a healthy page load fails the launch: ` + out(r));
    }
    writeLog(['spawn_sidecar pid=4 port=4 listening=true']);
    r = pageBoot(0);
    A.ok(r.status === 1 && /no page-boot line reached .* within 0s after its line 0/.test(r.stdout), 'a launch whose page never reported fails: ' + out(r));
    r = pageBoot('x');
    A.ok(r.status === 1 && /<from-line> is not a whole number/.test(r.stdout), 'a malformed start line is refused: ' + out(r));
    // the line is still being written (no newline yet) when the wait starts: it is judged once it is whole
    fs.writeFileSync(log, `spawn_sidecar pid=5 port=5 listening=true\n${HEALTHY_BOOT}`);
    r = spawnSync(bash, ['-c', '( sleep 1; printf "\\n" >> "$1" ) >/dev/null 2>&1 & bash "$2" page-boot "$1" 1 10', 'page-boot-wait', posix(log), posix(integrityPath)],
      { encoding: 'utf8', timeout: 60000 });
    A.ok(r.status === 0 && r.stdout.trim() === HEALTHY_BOOT, 'a page-boot line still being written is read once whole, within the wait: ' + out(r));
  } finally {
    fs.rmSync(itmp, { recursive: true, force: true });
  }
}

// ---- the Windows proof, in Windows PowerShell: its own function, taken from the harness by its AST ----
if (process.platform === 'win32') {
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'test', 'fixtures', 'windows-installed-integrity.ps1'),
    '-Node', process.execPath, '-Stub', stubJs
  ], { encoding: 'utf8', timeout: 120000 });
  A.ok(r.status === 0 && /^PASS: /m.test(String(r.stdout)),
    'the Windows installed proof passes only a verified install whose zeroed module is named, and every shortcut fails: '
    + String(r.stderr || r.stdout || (r.error && r.error.message)));
}

A.report('installed-integrity-proofs.test');
