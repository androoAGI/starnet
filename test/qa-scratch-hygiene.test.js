'use strict';
/* node test/qa-scratch-hygiene.test.js — QA scripts never leave scratch (Chrome profiles, seeded workspaces) in evidence.

   THE HOLE THIS CLOSES (guardian triage, 2026-10-28): scripts/qa/session-reliability.mjs made a Chrome
   profile-<Date.now()> and a mkdtemp workspace-* inside .dogfood/session-reliability on every run and never removed
   either; chat-cutoff-investigate and check-small-screen did the same with their profiles. ~148k files piled up and
   scripts/lint-evidence-secrets.mjs, which walks all of .dogfood, ran past its 120s gate bound.

   Laws:
     S1 scripts/lib/scratch.mjs makes its directories under os.tmpdir() (never in the repo) and dispose() removes every
        one it made, contents included;
     S2 no script under scripts/ builds a per-run Chrome profile as '<dir>/profile-' + Date.now(), or mkdtemps inside
        its out/OUT evidence dir — scratch goes through createScratch();
     S3 a script that calls createScratch() disposes it in a finally block. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
let checks = 0;

function scriptFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) scriptFiles(abs, out);
    else if (/\.(?:mjs|cjs|js)$/.test(e.name)) out.push(abs);
  }
  return out;
}

(async () => {
  // S1
  const { createScratch } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'scratch.mjs')).href);
  const dflt = createScratch('hygiene-probe');
  assert.equal(path.resolve(dflt.root), path.resolve(os.tmpdir()), 'scratch defaults to os.tmpdir()'); checks++;
  assert.ok(!path.resolve(dflt.root).startsWith(ROOT + path.sep), 'scratch root is outside the repo'); checks++;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-scratch-hygiene-'));
  try {
    const scratch = createScratch('session-reliability', { root });
    const profile = scratch.dir('profile'), workspace = scratch.dir('workspace');
    assert.notEqual(profile, workspace); checks++;
    for (const d of [profile, workspace]) {
      assert.equal(path.dirname(d), root, 'made under its root'); checks++;
      fs.mkdirSync(path.join(d, 'Default', 'Cache'), { recursive: true });
      fs.writeFileSync(path.join(d, 'Default', 'Cache', 'f_000001'), 'x');
    }
    assert.deepEqual(scratch.dirs.sort(), [profile, workspace].sort()); checks++;
    const left = await scratch.dispose();
    assert.deepEqual(left, [], 'nothing left behind'); checks++;
    assert.ok(!fs.existsSync(profile) && !fs.existsSync(workspace), 'dispose removes every dir it made'); checks++;
    assert.deepEqual(fs.readdirSync(root), [], 'and nothing else is left in the root'); checks++;
    assert.deepEqual(await scratch.dispose(), [], 'a second dispose is a no-op'); checks++;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // S2 + S3
  const offenders = [], undisposed = [];
  for (const file of scriptFiles(path.join(ROOT, 'scripts'))) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (rel === 'scripts/lib/scratch.mjs') continue;
    const src = fs.readFileSync(file, 'utf8');
    if (/profile-'\s*\+\s*Date\.now\(\)/.test(src)) offenders.push(rel + ': per-run Chrome profile named profile-<Date.now()>');
    if (/mkdtempSync\(\s*(?:resolve|join)\(\s*(?:out|OUT)\b/.test(src)) offenders.push(rel + ': mkdtemp inside the evidence dir');
    if (/\bcreateScratch\(/.test(src)) {
      const fin = src.lastIndexOf('finally');
      if (fin < 0 || !/\.dispose\(\)/.test(src.slice(fin))) undisposed.push(rel);
    }
  }
  assert.deepEqual(offenders, [], 'scratch goes through scripts/lib/scratch.mjs createScratch()'); checks++;
  assert.deepEqual(undisposed, [], 'every createScratch() is disposed in a finally'); checks++;

  console.log(`qa-scratch-hygiene.test: OK (${checks} checks)`);
})().catch(e => { console.error(e); process.exit(1); });
