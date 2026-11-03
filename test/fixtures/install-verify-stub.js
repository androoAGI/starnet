/* A stand-in for `skynet-desktop --starnet-verify-install --out FILE` (src-tauri/src/install_manifest.rs
   verify_install_main), the one edge the installed-acceptance tests fake: test/release-train-macos-trust.test.js runs
   scripts/verify-macos-installed-integrity.sh against it, test/installer-upgrade-resilience.test.js the Windows
   published-upgrade proof's Assert-InstalledIntegrity.

   A wrapper at the executable's path starts it with STUB_EXE set to that path. Like the exe it takes its install root
   from there (root_candidates: the exe's folder, then ../Resources, then ../lib/StarNet, the first holding a sidecar
   folder), checks the files a fixture manifest lists (STUB_MANIFEST: [{path, size}]) for missing / not a file / empty /
   wrong size, and answers in the exe's own stdout lines, receipt fields and exit codes (0 verified, 3 damaged,
   4 not checked), which test/release-train-macos-trust.test.js pins against the Rust source.

   Fault modes (STUB_MODE): blind (never names damage), other (names the wrong file), not-checked, no-receipt (an exe
   built before the install manifest: no output, no receipt, exit 0), elsewhere (reports another root).
   STUB_FILES: the file count it claims (default 2391). */
'use strict';
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
if (argv.length !== 3 || argv[0] !== '--starnet-verify-install' || argv[1] !== '--out') {
  console.error('usage: --starnet-verify-install --out FILE (all the installed proofs pass)');
  process.exit(2);
}
const out = argv[2];
const mode = process.env.STUB_MODE || '';
const files = Number(process.env.STUB_FILES || 2391);
if (mode === 'no-receipt') process.exit(0);

const exeDir = path.dirname(path.resolve(process.env.STUB_EXE || '.'));
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const root = [exeDir, path.join(exeDir, '..', 'Resources'), path.join(exeDir, '..', 'lib', 'StarNet')]
  .map((p) => path.resolve(p))
  .find((p) => isDir(path.join(p, 'sidecar')));
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const describe = (f) => ({
  missing: `${f.path} is missing`,
  'not-a-file': `${f.path} is not a file`,
  empty: `${f.path} is empty (0 of ${grouped(f.expected)} bytes)`,
  'wrong-size': `${f.path} is the wrong size (${grouped(f.actual)} of ${grouped(f.expected)} bytes)`
})[f.damage];

let state, summary, findings = [];
if (mode === 'not-checked' || !root) {
  state = 'not-checked';
  summary = `not checked (${root ? 'dev build' : 'no install folder with a sidecar folder next to the executable'})`;
} else {
  const listed = JSON.parse(fs.readFileSync(process.env.STUB_MANIFEST, 'utf8'));
  for (const entry of listed) {
    let st = null;
    try { st = fs.statSync(path.join(root, ...entry.path.split('/'))); } catch { /* missing */ }
    if (!st) findings.push({ path: entry.path, damage: 'missing', expected: null, actual: null });
    else if (!st.isFile()) findings.push({ path: entry.path, damage: 'not-a-file', expected: null, actual: null });
    else if (st.size === 0 && entry.size > 0) findings.push({ path: entry.path, damage: 'empty', expected: entry.size, actual: 0 });
    else if (st.size !== entry.size) findings.push({ path: entry.path, damage: 'wrong-size', expected: entry.size, actual: st.size });
  }
  if (mode === 'blind') findings = [];
  if (mode === 'other' && findings.length) {
    const wrong = listed.find((e) => !findings.some((f) => f.path === e.path));
    findings = [{ path: wrong.path, damage: 'wrong-size', expected: wrong.size, actual: wrong.size + 1 }];
  }
  for (const f of findings) f.text = describe(f);
  state = findings.length ? 'damaged' : 'verified';
  summary = findings.length
    ? `DAMAGED - ${findings.length} of ${grouped(files)} files: ${findings[0].text}`
    : `verified ${grouped(files)} files`;
}
const exitCode = { verified: 0, damaged: 3, 'not-checked': 4 }[state];

console.log(`install: ${summary}`);
for (const f of findings) console.log(`  ${f.text}`);
const receipt = state === 'not-checked'
  ? { state, reason: summary.slice('not checked ('.length, -1) }
  : { state, files, ...(state === 'damaged' ? { damaged: findings.length, hashed: true, named: findings.slice(0, 5).map((f) => f.text) } : {}) };
Object.assign(receipt, {
  schema: 'starnet.install-verify/1',
  exitCode,
  root: mode === 'elsewhere' ? path.join(path.dirname(root || exeDir), 'another-install') : (root || ''),
  findings
});
fs.writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n');
process.exit(exitCode);
