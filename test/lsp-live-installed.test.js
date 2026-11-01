/* A live proof against an already-installed language server (clangd, else rust-analyzer), on test/http.list.
   It is a machine receipt, so it has three honest outcomes:
   - PASS: a real installed server confirmed a planted diagnostic through StarNet's LSP manager;
   - SKIP: no supported server is on PATH, or the one on PATH cannot run on this machine at all — its own
     `--version` fails too (a rustup proxy with no rust-analyzer component, a toolchain this step's environment
     cannot reach, a broken install). That says nothing about StarNet;
   - FAIL: the server runs on its own here, but the manager could not start it or confirm the diagnostic.
   rust-analyzer executes the project (lsp-manager.js starts it only for a watched run); the project here is this
   test's own throwaway crate in a fresh temp dir, so the test starts it the way a watched run does
   (allowProjectExecution). Without that it was reported unavailable on every box with rust-analyzer but no clangd. */
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { makeLspManager, DEFAULT_SERVERS } = require('../sidecar/lsp-manager.js');

// Does the located server run at all, outside StarNet? (spawn error, non-zero exit or a hang = it does not.)
function runsOnItsOwn(command) {
  try {
    const r = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    return { ok: !r.error && r.status === 0, detail: r.error ? r.error.message : 'exit ' + r.status + ' ' + String(r.stderr || r.stdout || '').trim().slice(0, 200) };
  } catch (e) { return { ok: false, detail: (e && e.message) || String(e) }; }
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-lsp-live-'));
  const manager = makeLspManager({ spawn, fs, fsp, pathMod: path, env: process.env,
    limits: { requestTimeoutMs: 15000, diagnosticTimeoutMs: 15000, idleMs: 30000 } });
  try {
    const clang = DEFAULT_SERVERS.find(s => s.id === 'clangd');
    const rust = DEFAULT_SERVERS.find(s => s.id === 'rust-analyzer');
    let descriptor = null, located = '', rel = '', before = '', after = '';
    if ((located = manager._internals.locateExecutable(clang))) {
      descriptor = clang; rel = 'main.cpp';
      before = 'int main() { int x = 1; return x; }\n';
      after = 'int main() { int x = "not an int"; return x; }\n';
    } else if ((located = manager._internals.locateExecutable(rust))) {
      descriptor = rust; rel = 'src/main.rs';
      fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname="lsp_live"\nversion="0.1.0"\nedition="2021"\n');
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      before = 'fn main() { let x: i32 = 1; println!("{}", x); }\n';
      after = 'fn main() { let x: i32 = "not an int"; println!("{}", x); }\n';
    } else {
      console.log('lsp-live-installed.test: SKIP (no supported language server installed on PATH)');
      return;
    }
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, before, 'utf8');
    const ticket = await manager.beginEdit({ files: [{ abs, base: root, rel, text: before }], allowProjectExecution: descriptor.executesProject === true });
    if (!ticket.items.length) {
      const own = runsOnItsOwn(located);
      if (!own.ok) {
        console.log('lsp-live-installed.test: SKIP (' + descriptor.id + ' is on PATH at ' + located + ' but does not run on this machine: '
          + own.detail + ')');
        return;
      }
      throw new Error(descriptor.id + ' runs on its own (' + own.detail + ') but the LSP manager could not start it: ' + JSON.stringify(ticket.unavailable));
    }
    fs.writeFileSync(abs, after, 'utf8');
    const delta = await manager.finishEdit(ticket);
    if (delta.status !== 'available' || delta.addedCount < 1) {
      throw new Error(descriptor.id + ' did not confirm the planted diagnostic: ' + JSON.stringify(delta));
    }
    console.log('lsp-live-installed.test: PASS server=' + descriptor.id + ' added=' + delta.addedCount
      + ' first=' + delta.added[0].file + ':' + delta.added[0].line + ' ' + delta.added[0].message);
  } finally {
    await manager.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(e => { console.log('FAIL: lsp-live-installed.test threw — ' + (e && e.stack || e)); process.exit(1); });
