/* node test/diagnostics-build.test.js — P1.5 build provenance render seam (frontend/app/diagnostics.js).

   The desktop binary is stamped with its git commit (build.rs) and exposes it via the starnet_build_info Tauri
   command; diagnostics.js turns that into ONE honest line "build <version> @ <commit>[ DIRTY]". This locks:
     · formatBuild() shapes the line correctly (incl. the DIRTY suffix) and returns '' for missing/empty input.
     · buildLine() FAILS SOFT to '' in a plain browser (no window.__TAURI__) — truthful telemetry: never invent a
       commit for a session that wasn't built from any binary — and resolves the line when a Tauri core is present.
   Pure/DOM-free: we stub window.__TAURI__.core.invoke; no real shell needed. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const Diag = require('../frontend/app/diagnostics.js');
const { formatBuild } = Diag._internals;

// The native seam must stamp and expose both fields; fake BuildInfo objects alone cannot prove
// that the running command actually carries them.
{
  const buildRs = fs.readFileSync(require.resolve('../src-tauri/build.rs'), 'utf8');
  const mainRs = fs.readFileSync(require.resolve('../src-tauri/src/main.rs'), 'utf8');
  A.ok(/STARNET_BUILD_TREE/.test(buildRs) && /HEAD\^\{tree\}/.test(buildRs), 'build.rs stamps the exact Git source tree');
  A.ok(/STARNET_BUILD_PROVENANCE_KIND/.test(buildRs), 'build.rs stamps the base provenance kind');
  A.ok(/source_tree:[\s\S]*provenance_kind:/.test(mainRs) && /STARNET_BUILD_TREE/.test(mainRs), 'starnet_build_info exposes sourceTree + provenanceKind');
}

// ---- formatBuild: the pure shaper ----
{
  A.eq(formatBuild({ version: '0.2.2', commit: 'c160d90', dirty: false }), 'build 0.2.2 @ c160d90', 'clean build line');
  A.eq(formatBuild({ version: '0.2.2', commit: 'c160d90', sourceTree: 'b'.repeat(40), provenanceKind: 'reproducible-source', dirty: false }),
    'build 0.2.2 @ c160d90 [reproducible-source tree bbbbbbbbbbbb]', 'source build line names its class and exact-tree prefix');
  A.eq(formatBuild({ version: '0.2.2', commit: 'c160d90', sourceTree: 'b'.repeat(40), provenanceKind: 'custom', dirty: false }),
    'build 0.2.2 @ c160d90 [custom tree bbbbbbbbbbbb]', 'explicit custom build remains visibly custom');
  A.eq(formatBuild({ version: '0.2.2', commit: 'c160d90', sourceTree: 'b'.repeat(40), provenanceKind: 'official', dirty: false }),
    'build 0.2.2 @ c160d90 [custom tree bbbbbbbbbbbb]', 'BuildInfo cannot self-assert official');
  A.eq(formatBuild({ version: '0.2.2', commit: 'c160d90', dirty: true }), 'build 0.2.2 @ c160d90 DIRTY', 'dirty build appends DIRTY');
  A.eq(formatBuild({ version: '0.2.2', commit: 'unknown', dirty: false }), 'build 0.2.2 @ unknown', 'git-missing commit renders "unknown"');
  A.eq(formatBuild(null), '', 'null info => ""');
  A.eq(formatBuild({}), '', 'empty info => ""');
  A.eq(formatBuild({ version: '', commit: '' }), '', 'blank version+commit => ""');
  // a version-only or commit-only object still yields a line (partial but honest), never throws.
  A.eq(formatBuild({ version: '0.2.2', commit: '' }), 'build 0.2.2 @ unknown', 'version-only falls back commit to "unknown"');
}

// ---- formatInstall: the install verdict (BuildInfo.installIntegrity, src-tauri/src/install_manifest.rs to_info) ----
// 85f602c4 / E62: a zeroed or quarantined module that nothing named. The copied report now says whether the install
// verified; a shell that predates the field prints NO line, never a guess and never "verified".
const { formatInstall } = Diag._internals;
const SHELL_ZEROED = 'sidecar/tools/builtin/shell.js is empty (0 of 101,179 bytes)';
{
  const build = { version: '0.14.2', commit: 'c160d90' };
  const at = installIntegrity => Object.assign({}, build, { installIntegrity });
  A.eq(formatInstall(at({ state: 'verified', files: 2351 })), 'verified 2,351 files', 'a verified install');
  A.eq(formatInstall(at({ state: 'checking', files: 2351 })), 'checking 2,351 files', 'hashing still running');
  A.eq(formatInstall(at({ state: 'not-checked', reason: 'dev build' })), 'not checked (dev build)', 'a dev build claims nothing');
  A.eq(formatInstall(at({ state: 'damaged', files: 2351, damaged: 1, hashed: false, named: [SHELL_ZEROED] })), 'DAMAGED - ' + SHELL_ZEROED, 'the damaged file is named');
  A.eq(formatInstall(at({ state: 'damaged', files: 2351, damaged: 7, hashed: true, named: [SHELL_ZEROED, 'shared/events.js is missing'] })),
    'DAMAGED - ' + SHELL_ZEROED + ' (+6 more, named in startup.log)', 'more damage is counted, the first file named');
  A.eq(formatInstall(at({ state: 'damaged', named: ['a\nforged: line\u0007'] })), 'DAMAGED - a forged: line', 'control characters cannot forge report lines');
  A.eq(formatInstall(build), '', 'an older shell without the field: no install line');
  for (const junk of [null, undefined, 'verified', 42, {}, { state: 'official' }]) {
    A.eq(formatInstall(at(junk)), '', 'a malformed field is no line, never "verified": ' + JSON.stringify(junk));
  }
  A.eq(formatInstall(null), '', 'no BuildInfo, no line');
  A.eq(formatBuild(at({ state: 'damaged', named: [SHELL_ZEROED] })), 'build 0.14.2 @ c160d90', 'the build line itself is unchanged');
  A.eq(Diag.withInstall('REPORT', 'verified 3 files'), 'REPORT\ninstall:       verified 3 files', 'one install line is appended');
  A.eq(Diag.withInstall('REPORT', ''), 'REPORT', 'no verdict, no line');
  A.eq(Diag.withInstall('', 'verified 3 files'), '', 'an empty report stays empty (the caller\'s "could not read" path)');
  A.eq(Diag.withInstall('x\ninstall:       verified 3 files', 'checking 3 files'), 'x\ninstall:       verified 3 files', 'never a second install line');
}

// ---- buildLine: browser fail-soft (no Tauri) ----
(async () => {
  const hadWindow = typeof global.window !== 'undefined';
  const savedWindow = global.window;
  try {
    // (1) NO Tauri shell → '' (browser mode, nothing to prove)
    global.window = {};
    A.eq(await Diag.buildLine(), '', 'browser mode (no __TAURI__) => "" (fails soft, no fake commit)');

    // (2) Tauri core present, command resolves → the formatted line
    global.window = { __TAURI__: { core: { invoke: (cmd) => {
      A.eq(cmd, 'starnet_build_info', 'buildLine invokes starnet_build_info');
      return Promise.resolve({ version: '0.2.2', commit: 'abc1234', sourceTree: 'b'.repeat(40), provenanceKind: 'dirty-dev', dirty: true });
    } } } };
    A.eq(await Diag.buildLine(), 'build 0.2.2 @ abc1234 [dirty-dev tree bbbbbbbbbbbb] DIRTY', 'Tauri path resolves the honest build line');

    // (3) old shell WITHOUT the command (invoke rejects) → '' (never surface an error/fake line)
    global.window = { __TAURI__: { core: { invoke: () => Promise.reject(new Error('unknown command')) } } };
    A.eq(await Diag.buildLine(), '', 'a shell without starnet_build_info => "" (graceful)');

    // (4) THE COPIED REPORT carries the install line, in both of its paths. Driven through copy() with fakes only at
    // the edges: the shell's invoke, the sidecar's /api/diagnostics and the clipboard.
    const damaged = { version: '0.14.2', commit: 'c160d90', installIntegrity: { state: 'damaged', files: 2351, damaged: 1, hashed: false, named: [SHELL_ZEROED] } };
    let shell = damaged;
    global.window = { __TAURI__: { core: { invoke: (cmd) => cmd === 'starnet_build_info' ? Promise.resolve(shell) : Promise.reject(new Error('unknown command')) } } };
    let sidecarText = '';
    const savedFetch = global.fetch;
    const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const copied = [];
    global.fetch = (url) => Promise.resolve({ ok: !!sidecarText, json: () => Promise.resolve({ text: sidecarText }) });
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: (t) => { copied.push(t); return Promise.resolve(); } } }, configurable: true, writable: true });
    try {
      const copy = () => new Promise(resolve => Diag.copy({ notify: false, onDone: (ok, text) => resolve(text) }));
      // the engine answered: its report gains the shell's install line
      sidecarText = 'STARNET DIAGNOSTICS\nAgents:        3';
      const alive = await copy();
      A.ok(alive.startsWith(sidecarText) && alive.includes('\ninstall:       DAMAGED - ' + SHELL_ZEROED + '\n'), 'the sidecar report carries the install line: ' + JSON.stringify(alive));
      A.eq(copied[copied.length - 1], alive, 'that is the text on the clipboard');
      // the engine is down: the page-side report puts it right under the build line
      sidecarText = '';
      const dead = await copy();
      A.ok(/\nbuild:         build 0\.14\.2 @ c160d90\ninstall:       DAMAGED - sidecar\/tools\/builtin\/shell\.js is empty \(0 of 101,179 bytes\)\n/.test(dead), 'the fallback report names the file under its build line: ' + JSON.stringify(dead));
      A.eq(dead.split('\ninstall:').length, 2, 'exactly one install line');
      // an older shell (no field): no install line in either path, never a guess
      shell = { version: '0.14.1', commit: 'abc1234' };
      A.ok(!/\ninstall:/.test(await copy()), 'an older shell adds no install line (dead engine)');
      sidecarText = 'STARNET DIAGNOSTICS';
      A.ok(!/\ninstall:/.test(await copy()), 'an older shell adds no install line (live engine)');
      // a verified install says so
      shell = Object.assign({}, damaged, { installIntegrity: { state: 'verified', files: 2351 } });
      A.ok(/\ninstall:       verified 2,351 files(\n|$)/.test(await copy()), 'a verified install says so');
    } finally {
      global.fetch = savedFetch;
      if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator); else delete globalThis.navigator;
    }
  } finally {
    if (hadWindow) global.window = savedWindow; else { try { delete global.window; } catch (_) { global.window = undefined; } }
  }
  A.report('diagnostics-build.test');
})().catch(e => { console.error(e); process.exit(1); });
