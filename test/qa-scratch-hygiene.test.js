'use strict';
/* node test/qa-scratch-hygiene.test.js — QA scripts never leave scratch (Chrome profiles, seeded workspaces) in evidence.

   THE HOLE THIS CLOSES (guardian triage, 2026-10-28): scripts/qa/session-reliability.mjs made a Chrome
   profile-<Date.now()> and a mkdtemp workspace-* inside .dogfood/session-reliability on every run and never removed
   either; chat-cutoff-investigate and check-small-screen did the same with their profiles. ~148k files piled up and
   scripts/lint-evidence-secrets.mjs, which walks all of .dogfood, ran past its 120s gate bound.

   Laws:
     S1 scripts/lib/scratch.mjs makes its directories under os.tmpdir() (never in the repo) and dispose() removes every
        one it made, contents included;
     S2 no script under scripts/ builds a per-run Chrome profile named profile-<Date.now()> (concatenated or as a
        template literal), hands launchChrome a per-run profileDir (Date.now()/STAMP) that is not under tmpdir(), or
        mkdtemps anywhere but tmpdir() — scratch goes through createScratch(). MKDTEMP_ROOT_ALLOW names the few
        scripts whose non-tmpdir mkdtemp roots are their own and removed when they are done;
     S3 every `const <id> = createScratch(` is disposed by THAT id in a finally of its own
        (`finally { await <id>.dispose(); }`), so no earlier teardown step that throws can skip it.
   The rules run on synthetic offenders first, so a pattern that silently stopped matching fails here too. */
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

// Non-tmpdir mkdtemp roots that are the script's own and removed when it is done (each one checked by hand).
const MKDTEMP_ROOT_ALLOW = new Map([
  ['scripts/eval/campaign-runner.mjs', 'per-attempt root in its outputDir, rmSync unless --keep-workspaces'],
  ['scripts/eval/installed-performance.mjs', 'per-attempt root in its outputDir, rmSync in finally'],
  ['scripts/eval/installed-provider-soak.mjs', 'per-attempt root in its outputDir, rmSync in finally'],
  ['scripts/rec-quality-live.mjs', '.dev-workspaces-recquality-* scratch, rmSync at the end'],
  ['scripts/rec-spine-live.mjs', '.dev-workspaces-recspine-* scratch, rmSync at the end']
]);
const FROM_TMPDIR = /^\s*(?:path\.)?(?:join|resolve)\(\s*(?:os\.)?tmpdir\(\)/;
const PROFILE_STAMP = /profile-(?:['"`]\s*\+\s*Date\.now\(\)|\$\{\s*Date\.now\(\)\s*\})/;

// The expression starting at i, up to the first `,` `}` `)` or newline at bracket depth 0 (so join(a, b) stays whole).
function valueAt(src, i) {
  let depth = 0, j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
    else if ((c === ',' || c === '\n') && depth === 0) break;
  }
  return src.slice(i, j);
}

// S2: what a script's source does wrong, as a list of reasons (empty = clean).
function scratchOffences(rel, src) {
  const why = [];
  if (PROFILE_STAMP.test(src)) why.push('per-run Chrome profile named profile-<Date.now()>');
  for (const m of src.matchAll(/profileDir:/g)) {
    const val = valueAt(src, m.index + m[0].length);
    if (/Date\.now\(\)|\bSTAMP\b/.test(val) && !/tmpdir\(\)/.test(val)) why.push('per-run profileDir outside tmpdir(): ' + val.trim());
  }
  if (!MKDTEMP_ROOT_ALLOW.has(rel)) {
    for (const m of src.matchAll(/mkdtempSync\(/g)) {
      const arg = src.slice(m.index + m[0].length, m.index + m[0].length + 120);
      if (!FROM_TMPDIR.test(arg)) why.push('mkdtemp outside tmpdir(): mkdtempSync(' + arg.split('\n')[0].slice(0, 60));
    }
  }
  return why;
}

// S3: the createScratch() ids this source never disposes in a finally of their own.
function undisposedScratch(src) {
  const ids = [...src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createScratch\(/g)].map(m => m[1]);
  if (/\bcreateScratch\(/.test(src) && !ids.length) return ['<createScratch() not bound to a name>'];
  const esc = id => id.replace(/\$/g, '\\$');
  return ids.filter(id => !new RegExp('finally\\s*\\{\\s*await\\s+' + esc(id) + '\\.dispose\\(\\)\\s*;?\\s*\\}').test(src));
}

(async () => {
  // The rules themselves: each known leak shape is caught, each clean shape passes.
  const bad = {
    concat: "launchChrome({ profileDir: out + '/profile-' + Date.now() });",
    template: 'launchChrome({ profileDir: `${outDir}/profile-${Date.now()}` });',
    stamped: 'launchChrome({ cdpPort, profileDir: join(outDir, "chrome-" + Date.now()) });',
    mkdtempOut: "const ws = mkdtempSync(resolve(out, 'workspace-'));",
    mkdtempOther: "const ws = mkdtempSync(join(evidenceRoot, 'ws-'));"
  };
  for (const [k, src] of Object.entries(bad)) { assert.ok(scratchOffences('scripts/qa/x.mjs', src).length > 0, 'S2 catches ' + k); checks++; }
  const good = [
    "const p = mkdtempSync(join(tmpdir(), 'starnet-x-'));",
    "const p = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-x-'));",
    "launchChrome({ profileDir: join(tmpdir(), 'p-' + process.pid + '-' + Date.now()) });",
    "launchChrome({ profileDir: scratch.dir('profile') });"
  ];
  for (const src of good) { assert.deepEqual(scratchOffences('scripts/qa/x.mjs', src), [], 'S2 passes ' + src); checks++; }
  const s3bad = "const scratch = createScratch('x');\ntry {} finally { await stop(); if (installed) await installed.dispose(); await scratch.dispose(); }";
  assert.deepEqual(undisposedScratch(s3bad), ['scratch'], 'S3: dispose after other teardown in the same finally is not enough'); checks++;
  const s3other = "const scratch = createScratch('x');\ntry {} finally { try { await stop(); } finally { await installed.dispose(); } }";
  assert.deepEqual(undisposedScratch(s3other), ['scratch'], "S3: another object's dispose() does not count"); checks++;
  const s3good = "const scratch = createScratch('x');\ntry {} finally { try { await stop(); } finally { await scratch.dispose(); } }";
  assert.deepEqual(undisposedScratch(s3good), [], 'S3: a finally of its own passes'); checks++;

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

  // S2 + S3 over every script
  const offenders = [], undisposed = [];
  for (const file of scriptFiles(path.join(ROOT, 'scripts'))) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (rel === 'scripts/lib/scratch.mjs') continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const why of scratchOffences(rel, src)) offenders.push(rel + ': ' + why);
    for (const id of undisposedScratch(src)) undisposed.push(rel + ': ' + id);
  }
  for (const rel of MKDTEMP_ROOT_ALLOW.keys()) { assert.ok(fs.existsSync(path.join(ROOT, rel)), 'allowlisted script still exists: ' + rel); checks++; }
  assert.deepEqual(offenders, [], 'scratch goes through scripts/lib/scratch.mjs createScratch()'); checks++;
  assert.deepEqual(undisposed, [], 'every createScratch() is disposed in a finally of its own'); checks++;

  console.log(`qa-scratch-hygiene.test: OK (${checks} checks)`);
})().catch(e => { console.error(e); process.exit(1); });
