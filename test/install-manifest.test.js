/* node test/install-manifest.test.js — a damaged install names its file before the engine starts, and the build, the
   app and the gates are wired so it can.

   Customer reports 85f602c4 / E01 (Windows 0.13.2, a zero-byte shell.js) and E62 (Windows 11, an antivirus quarantined
   shell.js): the engine died with "TypeError: makeShellTool is not a function at sidecar/index.js", the shell quoted that
   tail, and nothing named the file or the way out. The behaviour is proven by the Rust class tests in
   src-tauri/src/install_manifest.rs (every code file of a fixture install, laid out through the real tauri.conf.json
   map, damaged in turn and named; an absent or partial manifest never verified), which cargo test runs in src-tauri and
   test/native-install-manifest runs in the fast gate without the app. This file pins what those tests cannot see from
   inside the module:
     W1 ONE MAP: the build-side guard and the manifest take their trees from tauri.conf.json bundle.resources, every
        resource is classified, and the two agree on what a code file is;
     W2 build.rs always writes OUT_DIR/install-manifest.json through the module, and main.rs embeds exactly that file;
     W3 setup runs the bounded presence pass after the orphan reap and before the first spawn, the content pass starts
        after the first spawn returns, and the verdict reaches the failure text on both platforms, the guardian's halt
        reason and BuildInfo;
     W4 --starnet-verify-install is handled right after the breakaway, before Tauri starts;
     W5 the rules crate compiles the module by path at src-tauri's pins, and fast-gate runs it and requires the class
        tests. (W6, the release train refusing an exe without a complete manifest, is in release-train-provenance.) */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ordered = (src, marks, msg) => {
  const at = marks.map(m => src.indexOf(m));
  A.ok(at.every(i => i >= 0) && at.every((i, n) => n === 0 || at[n - 1] < i), msg + ' ' + JSON.stringify(marks.map((m, n) => [m, at[n]])));
};

(async () => {
  const guard = await import(require('node:url').pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'bundle-source-integrity.mjs')).href);
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  const moduleRs = read('src-tauri/src/install_manifest.rs');
  const buildRs = read('src-tauri/build.rs');
  const mainRs = read('src-tauri/src/main.rs');
  const cargoToml = read('src-tauri/Cargo.toml');

  // ---- W1: one map, one code-file set ----
  const trees = guard.bundledTrees(ROOT);
  const classified = trees.repo.length + trees.thirdParty.length;
  A.eq(classified, Object.keys(conf.bundle.resources).length, 'every bundled resource is classified by the guard (repo or third-party)');
  for (const tree of ['sidecar', 'shared', 'bin', 'frontend']) A.ok(trees.repo.some(t => t.tree === tree), 'the guard checks the bundled repo tree ' + tree + '/');
  A.ok(trees.thirdParty.some(t => t.tree === 'src-tauri/voice-deps/node_modules'), 'the staged voice deps are the named third-party tree');
  A.ok(/install_manifest::resource_map\(&conf\)/.test(buildRs) && /base\.join\("tauri\.conf\.json"\)/.test(buildRs),
    'build.rs takes the manifest trees from the same tauri.conf.json map');
  const rustExts = (moduleRs.match(/pub const CODE_EXTENSIONS: &\[&str\] = &\[([^\]]*)\]/) || [, ''])[1].match(/"([a-z]+)"/g) || [];
  const exts = rustExts.map(e => e.replace(/"/g, ''));
  A.ok(exts.length >= 6, 'install_manifest.rs lists its code extensions: ' + JSON.stringify(exts));
  for (const ext of ['js', 'cjs', 'mjs', 'json', 'html', 'htm', 'css', 'ts', 'jsx', 'md', 'map', 'png', 'node', 'wasm', 'svg', 'txt', 'onnx', 'exe']) {
    for (const name of ['x.' + ext, 'X.' + ext.toUpperCase()]) {
      A.eq(guard.CODE.test(name), exts.includes(ext), 'the guard and the manifest agree whether ' + name + ' is code');
    }
  }

  // ---- W2: build.rs always writes the manifest; main.rs embeds exactly it ----
  A.ok(/#\[path = "src\/install_manifest\.rs"\]\s*mod install_manifest;/.test(buildRs), 'build.rs compiles the app\'s own module by path');
  A.ok(/install_manifest::generate\(&base, &resources\)/.test(buildRs) && /join\("install-manifest\.json"\)/.test(buildRs) && /fs::write\(&out, install_manifest::to_json\(&manifest\)\)/.test(buildRs),
    'build.rs writes OUT_DIR/install-manifest.json from the generated manifest');
  A.ok(/Err\(why\) => install_manifest::Manifest \{ complete: false/.test(buildRs), 'an unreadable map still writes a manifest, an incomplete one');
  ordered(buildRs, ['fn main() {', 'write_install_manifest();', 'tauri_build::build();'], 'build.rs writes the manifest on every run, before tauri-build');
  A.ok(/\[build-dependencies\][\s\S]*?\nserde_json = "1"[\s\S]*?\nsha2 = "0\.10"/.test(cargoToml), 'Cargo.toml builds the manifest with the crates the app already locks');
  A.ok(/static INSTALL_MANIFEST: &str = include_str!\(concat!\(env!\("OUT_DIR"\), "\/install-manifest\.json"\)\);/.test(mainRs),
    'main.rs embeds the generated manifest, so the exe\'s own signature signs it');

  // ---- W3: the startup wiring, small and in order ----
  ordered(mainRs, [
    'reap_orphan_sidecars(&node_binary(&state.root), &keep, &state.startup_log);',
    'install_manifest::startup_presence(&state.install, INSTALL_MANIFEST, cfg!(debug_assertions))',
    'if !spawn_sidecar_with_retry(app.handle(), &state) {'
  ], 'setup runs the presence pass after the orphan reap and before the first spawn, release builds only');
  A.ok(/startup_presence\(&state\.install, INSTALL_MANIFEST, cfg!\(debug_assertions\)\) \{\s*log_startup\(&state\.startup_log, line\);/.test(mainRs), 'every presence line goes to startup.log');
  const retry = A.fnBody(mainRs, 'fn spawn_sidecar_with_retry(');
  A.ok(retry.length > 0 && retry.length < 4000, 'spawn_sidecar_with_retry found (' + retry.length + ' chars)');
  ordered(retry, ['let listening = spawn_sidecar(state);', 'if std::mem::take(&mut first) {', 'install_manifest::start_content_pass(&state.install', 'if listening {'],
    'the content pass starts once, after the first spawn returns and before a failure dialog');
  const failureCalls = mainRs.match(/startup_failure_details\(\s*&state\.startup_log,\s*state\.sidecar_log\.path\(\),\s*&boot_failure_tail\(state\),\s*&state\.install\.verdict_for_failure\(install_manifest::FAILURE_WAIT\),?\s*\)/g) || [];
  A.eq(failureCalls.length, 2, 'both platforms\' startup-failure text carries the install verdict');
  A.ok(/match install\.dialog_lead\(\) \{\s*Some\(lead\) => format!\("\{lead\}\\n\\n\{cause\}\\n\\n\{logs\}"\)/.test(mainRs), 'the install lead comes before the engine\'s own lines');
  A.ok(/install_manifest::with_install_lead\(&st\.install\.verdict\(\), format!\(\s*"crash-loop:/.test(mainRs), 'the guardian\'s halt reason leads with a damaged install');
  A.ok(/#\[serde\(rename = "installIntegrity"\)\]\s*install_integrity: serde_json::Value,/.test(mainRs) && /install_integrity: app\s*\.try_state::<AppState>\(\)/.test(mainRs),
    'BuildInfo.installIntegrity carries the live verdict (the copied diagnostics\' install line)');
  A.ok(/install: Arc::new\(install_manifest::Integrity::new\(\)\),/.test(mainRs), 'AppState owns one shared verdict');

  // ---- W4: the headless verify runs before Tauri ----
  const main = mainRs.slice(mainRs.indexOf('\nfn main() {'));
  ordered(main, ['process_job::breakaway_main()', 'install_manifest::verify_install_main(std::env::args_os(), INSTALL_MANIFEST)', 'tauri::generate_context!()'],
    'main() handles --starnet-verify-install right after the breakaway, before Tauri or the single-instance check');
  A.ok(/pub const VERIFY_FLAG: &str = "--starnet-verify-install";/.test(moduleRs) && /EXIT_DAMAGED: i32 = 3;/.test(moduleRs) && /EXIT_NOT_CHECKED: i32 = 4;/.test(moduleRs),
    'the headless verify exits 0 verified, 3 damaged, 4 not checked');

  // ---- W5: the rules crate and the fast gate ----
  const lib = read('test/native-install-manifest/src/lib.rs');
  A.ok(/#\[path = "\.\.\/\.\.\/\.\.\/src-tauri\/src\/install_manifest\.rs"\]\s*pub mod install_manifest;/.test(lib), 'the rules crate compiles the app\'s module by path, unchanged');
  const lockVersions = text => {
    const out = new Map();
    for (const m of text.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g)) out.set(m[1] + '@' + m[2], true);
    return out;
  };
  const appLock = lockVersions(read('src-tauri/Cargo.lock').replace(/\r\n/g, '\n'));
  const rulesLock = lockVersions(read('test/native-install-manifest/Cargo.lock').replace(/\r\n/g, '\n'));
  A.ok(rulesLock.size > 10, 'the rules crate is locked (' + rulesLock.size + ' packages)');
  for (const pkg of rulesLock.keys()) {
    if (pkg.startsWith('starnet-install-manifest-rules@')) continue;
    A.ok(appLock.has(pkg), 'the rules crate builds ' + pkg + ', a version src-tauri/Cargo.lock pins');
  }
  const rulesToml = read('test/native-install-manifest/Cargo.toml');
  for (const dep of ['serde_json', 'sha2']) {
    const pin = (rulesToml.match(new RegExp('\\n' + dep + ' = "=([^"]+)"')) || [])[1];
    A.ok(pin && appLock.has(dep + '@' + pin), 'the rules crate pins ' + dep + ' to the app\'s locked version: ' + pin);
  }
  const fastGate = read('.github/workflows/fast-gate.yml');
  A.ok(/cargo test --locked --manifest-path test\/native-install-manifest\/Cargo\.toml/.test(fastGate), 'fast-gate runs the install-manifest rules crate');
  A.ok(/for t in every_entry_damaged_in_turn_is_named absent_or_partial_manifest_is_not_checked; do\s*\n\s*grep -Eq "test install_manifest::tests::\$t \\\.\\\.\\\. ok"/.test(fastGate),
    'fast-gate requires the class tests by name, so a renamed test cannot pass as zero tests');
  for (const name of ['every_entry_damaged_in_turn_is_named', 'code_files_only_from_the_resource_map', 'extra_files_ignored',
    'absent_or_partial_manifest_is_not_checked', 'entries_never_escape_the_root', 'unreadable_is_named_not_fatal', 'dialog_lead_names_file_and_exits']) {
    A.ok(new RegExp('#\\[test\\]\\s*fn ' + name + '\\(\\)').test(moduleRs), 'install_manifest.rs keeps the class test ' + name);
  }
  A.ok(/#\[test\]\s*fn a_damaged_install_leads_the_failure_text\(\)/.test(mainRs) && /makeShellTool is not a function/.test(mainRs),
    'main.rs proves the failure text leads with the file over the real engine tail');

  A.report('install-manifest');
})().catch(e => { console.error(e); process.exit(1); });
