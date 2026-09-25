/* node test/prepare-node.test.js — the desktop Node-bundling target resolver (P2.3).
   Pure: proves the win-x64 path is BYTE-IDENTICAL to the legacy hardcoded values (so the shipped Windows build
   is unchanged), and that mac/linux targets resolve to the correct tarball URL + extract member + triple +
   output name. No network: only resolveTarget/defaultTarget/pickSha are exercised (importing the .mjs does NOT
   download — the fetch only runs when the script is executed directly). */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

(async () => {
  const m = await import('../scripts/prepare-node.mjs');

  A.eq(m.NODE_VERSION, 'v22.23.2', 'desktop bundles the current security-patched Node 22 LTS runtime');

  // ---- win-x64: identical to the original hardcoded script (the Windows ship path must not move) ----
  const w = m.resolveTarget('win-x64', 'v22.12.0');
  A.eq(w.triple, 'x86_64-pc-windows-msvc', 'win triple unchanged');
  A.eq(w.distUrl, 'https://nodejs.org/dist/v22.12.0/win-x64/node.exe', 'win dist url unchanged');
  A.eq(w.shasumEntry, 'win-x64/node.exe', 'win shasum entry unchanged');
  A.eq(w.outName, 'node-x86_64-pc-windows-msvc.exe', 'win output filename unchanged');
  A.eq(w.member, null, 'win is a bare binary — no archive extraction');

  // ---- linux-x64: tarball + bin/node extraction ----
  const l = m.resolveTarget('linux-x64', 'v22.12.0');
  A.eq(l.triple, 'x86_64-unknown-linux-gnu', 'linux triple');
  A.eq(l.distUrl, 'https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.gz', 'linux tarball url');
  A.eq(l.shasumEntry, 'node-v22.12.0-linux-x64.tar.gz', 'linux shasum entry is the tarball');
  A.eq(l.member, 'node-v22.12.0-linux-x64/bin/node', 'linux extracts bin/node from the tarball');
  A.eq(l.outName, 'starnet-node-x86_64-unknown-linux-gnu', 'Linux runtime cannot overwrite /usr/bin/node');

  // ---- darwin (both arches) ----
  const da = m.resolveTarget('darwin-arm64', 'v22.12.0');
  A.eq(da.triple, 'aarch64-apple-darwin', 'darwin arm64 triple');
  A.eq(da.member, 'node-v22.12.0-darwin-arm64/bin/node', 'darwin arm64 member');
  const dx = m.resolveTarget('darwin-x64', 'v22.12.0');
  A.eq(dx.triple, 'x86_64-apple-darwin', 'darwin x64 triple');
  A.eq(dx.distUrl, 'https://nodejs.org/dist/v22.12.0/node-v22.12.0-darwin-x64.tar.gz', 'darwin x64 url');

  // ---- version threads through every URL/member ----
  const v20 = m.resolveTarget('linux-x64', 'v20.0.0');
  A.ok(v20.distUrl.indexOf('/v20.0.0/') > 0 && v20.member.indexOf('v20.0.0') >= 0, 'version substitutes into url + member');

  // ---- host auto-detect (the no-arg default; keeps "bundle for THIS machine") ----
  A.eq(m.defaultTarget('win32', 'x64'), 'win-x64', 'win32 -> win-x64 (default unchanged on Windows)');
  A.eq(m.defaultTarget('darwin', 'arm64'), 'darwin-arm64', 'darwin/arm64 -> darwin-arm64');
  A.eq(m.defaultTarget('darwin', 'x64'), 'darwin-x64', 'darwin/x64 -> darwin-x64');
  A.eq(m.defaultTarget('linux', 'x64'), 'linux-x64', 'linux -> linux-x64');
  A.eq(m.defaultTarget('linux', 'arm64'), 'linux-arm64', 'Linux ARM64 selects its native runtime');
  A.throws(() => m.defaultTarget('linux', 'arm'), 'unsupported Linux architecture must not silently bundle x64');
  const la = m.resolveTarget('linux-arm64', 'v22.12.0');
  A.eq(la.triple, 'aarch64-unknown-linux-gnu', 'Linux ARM64 triple');
  A.eq(la.distUrl, 'https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-arm64.tar.gz', 'Linux ARM64 archive');
  A.eq(la.member, 'node-v22.12.0-linux-arm64/bin/node', 'Linux ARM64 archive member');
  A.eq(la.outName, 'starnet-node-aarch64-unknown-linux-gnu', 'Linux ARM64 namespaced runtime');
  A.throws(() => m.defaultTarget('aix', 'ppc'), 'an unsupported host platform throws');

  // ---- unknown target is a clear error, not a silent wrong download ----
  A.throws(() => m.resolveTarget('plan9-pdp11'), 'unknown target throws');

  // ---- pickSha extracts the right hash for the entry, and reports a missing one ----
  const sums = 'deadbeef'.repeat(8) + '  win-x64/node.exe\n' + 'a'.repeat(64) + '  node-v22.12.0-linux-x64.tar.gz\n';
  A.eq(m.pickSha(sums, 'win-x64/node.exe'), 'deadbeef'.repeat(8), 'pickSha finds the win entry');
  A.eq(m.pickSha(sums, 'node-v22.12.0-linux-x64.tar.gz'), 'a'.repeat(64), 'pickSha finds the linux entry');
  A.throws(() => m.pickSha(sums, 'node-v22.12.0-darwin-arm64.tar.gz'), 'pickSha throws on a missing entry');

  // ---- a changed runtime pin must invalidate an already-present cached binary ----
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-node-cache-'));
  try {
    const cached = path.join(cacheDir, 'node.exe');
    fs.writeFileSync(cached, 'binary');
    const exactSha = createHash('sha256').update('binary').digest('hex');
    A.eq(m.cachedRuntimeMatches(cached, 'v22.23.2', exactSha), false, 'an unstamped cached runtime is never trusted');
    fs.writeFileSync(cached + '.version', 'v22.12.0\n');
    A.eq(m.cachedRuntimeMatches(cached, 'v22.23.2', exactSha), false, 'an old cached runtime is invalidated after a pin bump');
    fs.writeFileSync(cached + '.version', 'v22.23.2\n');
    A.eq(m.cachedRuntimeMatches(cached, 'v22.23.2', exactSha), true, 'the exact stamped runtime remains reusable');
    A.eq(m.cachedRuntimeMatches(cached, 'v22.23.2', '0'.repeat(64)), false, 'a forged stamp cannot make bytes that differ from the official checksum reusable');
    fs.writeFileSync(cached, 'tampered');
    A.eq(m.cachedRuntimeMatches(cached, 'v22.23.2', exactSha), false, 'post-download cache corruption is detected without executing untrusted bytes');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }

  // ---- packaging hygiene: ignored sidecar runtime state must never be bundled into the installer ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-node-hygiene-'));
  try {
    fs.mkdirSync(path.join(tmp, 'sidecar'), { recursive: true });
    A.notThrows(() => m.assertNoBundledRuntimeState(tmp), 'empty sidecar is packageable');
    fs.mkdirSync(path.join(tmp, 'sidecar', 'workspaces'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'sidecar', 'workspaces', 'agent.save.json'), '{}');
    A.throws(() => m.assertNoBundledRuntimeState(tmp), 'sidecar/workspaces blocks desktop packaging');
    fs.rmSync(path.join(tmp, 'sidecar', 'workspaces'), { recursive: true, force: true });
    fs.mkdirSync(path.join(tmp, 'sidecar', 'workspaces.preground-bak'), { recursive: true });
    A.throws(() => m.assertNoBundledRuntimeState(tmp), 'sidecar/workspaces.* backups block desktop packaging');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  A.report('prepare-node.test');
})().catch(e => { console.error(e); process.exit(1); });
