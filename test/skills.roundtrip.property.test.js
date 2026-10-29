/* node test/skills.roundtrip.property.test.js — a skill file is the same BYTES on every path it travels (gh#145,
   bug a36d1b00, skills-canonical-bytes lane 2026-10-28).

   One property, checked for seeded random packages on every write and read path a skill file has:
     install (URL inspect -> install), import (an exported envelope -> inspectEnvelope -> install), patch and edit
     (an installed package diverges), write_file (text with code a log redactor mangles, and binary via base64),
     remove_file, export (sealed and diverged), update (re-install over a diverged copy), rollback (an offline
     generation), reload (a fresh store over the same log and package dir), an authored skill, and the Skill Market.
   For each it asserts:
     I1 disk    the package mirror holds every support file's exact bytes, and no file the skill no longer holds
     I2 view    store.view hands back the exact bytes of every file (whatever encoding it carries them in)
     I3 model   the exact bytes are kept at the store, and delivered scrubbed: skill.view with no scrub shows a text file
                as its exact text, and through the host wiring (the field-first scrubSkills, then the registry's
                scrubStored) production delivers that exact text through the stored-text scrub, which may rewrite a
                line of code (the CODE fixture's 'raise' line is one); a binary file is named with its size; no base64 blob
     I4 stamp   the digest of what the view shows is the stamp persist() wrote, so an approval of what the Commander
                read is the approval the prompt index and skill.list honour: approve-then-list shows withheld:false
     I5 export  an exported envelope carries the exact bytes
   Plus two upgrade sections: a v0.14 save (base64 support files, a base64-text mirror left by bug a36d1b00, approvals
   keyed to the old digest) keeps its approvals and is shown as text, and the a36d1b00 repro as filed. And: a digest
   reads bytes (a binary file never digests like a text file holding its base64; a v0.14 binary-only save keeps its
   approval), a patch rewrites only the lines it patches, and the boot re-stamp skips only records that cannot move.

   Real store + real package mirror on a temp dir + real guard/gate/tools/exchange/redactor. Only APIs that existed
   before the lane are driven (the two upgrade helpers are used when present), so this file runs on the pre-fix tree. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { makeSkillStore } = require('../sidecar/skillstore.js');
const { makePackageStore } = require('../sidecar/skills/package.js');
const { makeSkillExchange } = require('../sidecar/skills/exchange.js');
const packageFormat = require('../sidecar/skills/package-format.js');
const guard = require('../sidecar/skills/guard.js');
const gateMod = require('../sidecar/skills/gate.js');
const { makeSkillGate, digestOf } = gateMod;
const { makeSkillTools } = require('../sidecar/tools/builtin/skills.js');
const { redact } = require('../sidecar/context.js');
const PS = require('../sidecar/prompt-scrub.js');
const runtime = require('../sidecar/skills/runtime.js');
const { makeRegistry, attachResultScrub } = require('../sidecar/tools/registry.js');
// skill.view as production delivers it: the host's field-first scrub (index.js scrubSkillsForPrompt; absent before the
// lane, where only the registry scrubbed) and the registry with the host's scrubStored attached
const hostScrubSkills = (list) => PS.withHeld(() => list.map(s => typeof runtime.scrubSkillText === 'function' ? runtime.scrubSkillText(s, PS.scrubStored) : s));
async function hostView(store, gate, agentId, name) {
  const reg = makeRegistry();
  makeSkillTools({ store, gate, scrubSkills: hostScrubSkills }).register(reg);
  attachResultScrub(PS.scrubStored);
  try { return String((await reg.dispatch({ id: 'v', name: 'skill.view', args: { name } }, { agentId })).content); } finally { attachResultScrub(null); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-roundtrip-'));
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---- seeded generator (mulberry32): the same cases every run, a different mix per seed ----
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const WORDS = ['measure', 'twice', 'cut', 'once', 'Ünïcödé', 'naïve', 'café', '日本語', 'Привет', 'emoji 🛠️', 'tab\tseparated', 'x = 1;', 'return y', '  indented', 'trailing   ', '(paren)', '"quoted"', "it's", '#heading', '- item', '1. step'];
function textOf(r, lines) {
  const eol = r() < 0.4 ? '\r\n' : '\n';
  const out = [];
  for (let i = 0; i < lines; i++) {
    const n = 1 + Math.floor(r() * 6); const ws = [];
    for (let j = 0; j < n; j++) ws.push(WORDS[Math.floor(r() * WORDS.length)]);
    out.push(ws.join(' '));
  }
  let t = out.join(r() < 0.2 ? '\n' : eol);   // sometimes MIXED line endings
  if (r() < 0.5) t += eol;                     // with or without a final newline
  if (r() < 0.25) t = '﻿' + t;            // sometimes a byte-order mark
  return t;
}
function binaryOf(r, n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(r() * 256);
  b[0] = 0x89; b[1] = 0x00; b[2] = 0xff; b[3] = 0xfe;   // NUL and invalid UTF-8 up front: never text
  return b;
}
// code the full log redactor rewrites (its credential-assignment rule): must survive byte for byte at the store
const CODE = 'def check(password):\n    if not password:\n        raise ValueError("password required")\n    return password == password\n';
// ...and the stored-text scrub rewrites a line of it where it leaves, so the host-wiring I3 records a real difference
A.ok(PS.scrubStored(CODE) !== CODE, 'I3: precondition, production delivers the CODE fixture with a line rewritten by the stored-text scrub (the host-wiring I3 is not vacuous)');
function caseFiles(seed) {
  const r = rng(seed);
  const files = [];
  const nText = 1 + Math.floor(r() * 3);
  for (let i = 0; i < nText; i++) files.push({ path: 'references/notes-' + seed + '-' + i + '.md', bytes: Buffer.from(textOf(r, 2 + Math.floor(r() * 5)), 'utf8') });
  files.push({ path: 'scripts/check-' + seed + '.py', bytes: Buffer.from(CODE, 'utf8') });
  if (r() < 0.8) files.push({ path: 'assets/blob-' + seed + '.bin', bytes: binaryOf(r, 16 + Math.floor(r() * 64)) });
  if (r() < 0.5) files.push({ path: 'templates/empty-' + seed + '.txt', bytes: Buffer.alloc(0) });
  return files;
}
function skillMd(name, desc, body) { return '---\nname: ' + name + '\ndescription: "' + desc + '"\n---\n' + body; }

// ---- the frozen v0.14 digest (skills/gate.js digestOf at ae68ff1c4): FNV-1a over the STORED strings ----
function digestV014(skill) {
  const files = Array.isArray(skill && skill.files) ? skill.files.slice() : [];
  files.sort((a, b) => String(a && a.path).localeCompare(String(b && b.path)));
  let text = String((skill && skill.body) || '') + '\x00' + String((skill && skill.setup) || '');
  for (const f of files) text += '\x00' + String(f && f.path) + '\x00' + String((f && f.content) || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i) & 0xff; h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    const hi = text.charCodeAt(i) >>> 8; if (hi) { h ^= hi; h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  }
  return ('00000000' + h.toString(16)).slice(-8) + '-' + text.length;
}

// ---- rig ----
let rigN = 0;
function rig(lines, root) {
  root = root || path.join(tmp, 'pk' + (++rigN));
  lines = lines || [];
  const pk = makePackageStore({ fs, pathMod: path, root, now: () => 1 });
  const store = makeSkillStore({ io: { readAll: () => lines.slice(), append: e => lines.push(JSON.parse(JSON.stringify(e))) }, clock: { now: () => 9000 },
    guard, digest: digestOf, packageStore: pk, redact, stageReviews: false });
  let pkgs = {};
  // The byte path is what this file pins, so its exchange scrubs with the identity: the exchange defaults to (and the host
  // passes) prompt-scrub scrubStored, which an export's text passes on its way off the station (scan-census E pins that).
  const ex = makeSkillExchange({ skillStore: store, packageStore: pk, guard, hash, now: () => 5000, scrubText: (t) => t,
    fetchPackage: async (url) => { const p = pkgs[url]; if (!p) throw new Error('no such fixture ' + url); return { url, files: p.map(f => ({ path: f.path, bytes: Buffer.from(f.bytes) })) }; } });
  return { root, lines, pk, store, ex, serve(url, files) { pkgs[url] = files; } };
}
const bytesOfEntry = (f) => f.encoding === 'base64' ? Buffer.from(String(f.content || ''), 'base64') : Buffer.from(String(f.content || ''), 'utf8');
function isText(b) { const t = b.toString('utf8'); return Buffer.from(t, 'utf8').equals(b) && t.indexOf('\u0000') < 0; }
function diskFiles(dir) {
  const out = new Map();
  for (const sd of ['references', 'templates', 'scripts', 'assets']) {
    const base = path.join(dir, sd); if (!fs.existsSync(base)) continue;
    const stack = [base];
    while (stack.length) { const cur = stack.pop(); for (const e of fs.readdirSync(cur, { withFileTypes: true })) { const full = path.join(cur, e.name); if (e.isDirectory()) stack.push(full); else out.set(path.relative(dir, full).replace(/\\/g, '/'), fs.readFileSync(full)); } }
  }
  return out;
}

/* check(where, r, agentId, id, want): `want` is the support-file set [{path, bytes}] the skill must hold now. */
async function check(where, r, agentId, id, want, opts) {
  opts = opts || {};
  const supportWant = want.filter(f => /^(references|templates|scripts|assets)\//.test(f.path));
  const v = r.store.view(agentId, id, { includeArchived: true, bump: false });
  A.ok(!!v, where + ': the skill exists');
  if (!v) return null;
  // I1 disk
  const dir = r.pk.packageDir(v);
  const disk = diskFiles(dir);
  for (const f of supportWant) {
    const got = disk.get(f.path);
    A.ok(!!got && got.equals(f.bytes), where + ' I1: ' + f.path + ' is its exact bytes on disk' + (got && !got.equals(f.bytes) ? ' (disk holds ' + JSON.stringify(got.toString('utf8').slice(0, 60)) + ')' : (got ? '' : ' (missing)')));
  }
  const extra = Array.from(disk.keys()).filter(p => !supportWant.some(f => f.path === p));
  A.eq(extra, [], where + ' I1: no file the skill does not hold is left in its package dir');
  // I2 view
  const vf = new Map((v.files || []).map(f => [f.path, f]));
  A.eq(Array.from(vf.keys()).sort(), want.map(f => f.path).sort(), where + ' I2: the view holds exactly the skill\'s files');
  for (const f of want) {
    const got = vf.get(f.path);
    A.ok(!!got && bytesOfEntry(got).equals(f.bytes), where + ' I2: the view carries ' + f.path + '\'s exact bytes');
  }
  // I3 model: the byte path (no scrub: scrubSkills is the identity), then what production delivers (the host wiring)
  const approvedGate = () => makeSkillGate({ guard, approvals: { get: () => ({ digest: digestOf(v), stamp: v.contentDigest, action: 'allow' }) } });
  const tools = makeSkillTools({ store: r.store, gate: approvedGate(), scrubSkills: (l) => l });
  const out = (await tools.viewTool.run({ name: v.name }, { agentId })).content;
  const delivered = await hostView(r.store, approvedGate(), agentId, v.name);
  if (opts.visible !== false) {
    for (const f of want) {
      if (!f.bytes.length) { A.ok(out.indexOf('- ' + f.path) >= 0 && delivered.indexOf('- ' + f.path) >= 0, where + ' I3: an empty file is named'); continue; }
      if (isText(f.bytes)) {
        const exact = f.bytes.toString('utf8');
        A.ok(out.indexOf('- ' + f.path + '\n' + exact) >= 0, where + ' I3: the store keeps ' + f.path + '\'s exact bytes, and skill.view with no scrub shows them as its exact text');
        A.ok(delivered.indexOf('- ' + f.path + '\n' + PS.scrubStored(exact)) >= 0, where + ' I3: production delivers ' + f.path + ' scrubbed: its exact text through the stored-text scrub (scrubSkills, then the registry\'s scrubStored)');
      } else {
        const named = '- ' + f.path + ' (binary file, ' + f.bytes.length + ' bytes, not shown as text)';
        A.ok(out.indexOf(named) >= 0 && delivered.indexOf(named) >= 0, where + ' I3: the model is told ' + f.path + ' is a binary file of ' + f.bytes.length + ' bytes');
      }
      const b64 = f.bytes.toString('base64');
      if (b64.length >= 12) A.ok(out.indexOf(b64) < 0 && delivered.indexOf(b64) < 0, where + ' I3: no base64 blob of ' + f.path + ' reaches the model');
    }
  }
  // I4 stamp: what the Commander reads digests to the stamp, so approve-then-list agrees with the delivery seam
  A.eq(digestOf(v), v.contentDigest, where + ' I4: the digest of the view is the stamp the index and skill.list compare');
  if (opts.approve) {
    const entry = { digest: digestOf(v), stamp: v.contentDigest, action: 'allow' };   // handleAgentSkillAllow's entry
    const g = makeSkillGate({ guard, approvals: { get: () => entry } });
    const row = r.store.list(agentId, { includeArchived: true }).find(s => s.id === v.id);
    A.eq(makeSkillGate({ guard, approvals: { get: () => null } }).annotate([row])[0].withheld, true, where + ' I4: the skill is withheld before the approval (the fixture really asks)');
    A.eq(g.annotate([row])[0].withheld, false, where + ' I4: approve-then-list shows withheld:false');
    A.eq(g.annotate([v], { verify: true })[0].withheld, false, where + ' I4: approve-then-view shows withheld:false');
  }
  return v;
}
function exported(r, agentId, id) {
  const e = r.ex.exportPackage({ agentId, id });
  return packageFormat.fromEnvelope(e.envelope);
}
function checkExport(where, pkg, want) {
  for (const f of want) {
    const got = pkg.files.find(x => x.path === f.path);
    A.ok(!!got && Buffer.from(got.content, 'base64').equals(f.bytes), where + ' I5: the export carries ' + f.path + '\'s exact bytes');
  }
}

(async () => {
  const SEEDS = [1, 2, 3, 4, 5, 6];
  for (const seed of SEEDS) try {
    const r = rig();
    const url = 'https://example.invalid/skills/rt-' + seed + '/SKILL.md';
    const files = caseFiles(seed);
    // the reference links a URL, so the community package ASKS (the approval path is exercised, not skipped)
    files.push({ path: 'references/source-' + seed + '.md', bytes: Buffer.from('Docs: https://example.invalid/docs\n', 'utf8') });
    if (seed % 2) files.push({ path: 'LICENSE', bytes: Buffer.from('MIT License\n\nCopyright (c) the author\n', 'utf8') });
    const body = '1. Measure twice.\r\n2. Cut once — café.\n3. Keep the password = hunter2-example line exact.';
    r.serve(url, [{ path: 'SKILL.md', bytes: Buffer.from(skillMd('rt-' + seed, 'Round trip ' + seed, body)) }].concat(files));
    const tag = 'seed ' + seed + ' ';

    // ---- install (URL inspect -> install): sealed ----
    const pv = await r.ex.inspect({ url });
    A.eq(pv.guardAction, 'ask', tag + 'install: the fixture package asks (a URL in a reference)');
    const inst = r.ex.install({ agentId: 'a', inspectionId: pv.inspectionId });
    const id = inst.skill.id;
    await check(tag + 'install', r, 'a', id, files, { approve: true });
    checkExport(tag + 'install', exported(r, 'a', id), files);

    // ---- import (exported envelope -> inspectEnvelope -> install) into another agent ----
    const env = r.ex.exportPackage({ agentId: 'a', id }).envelope;
    const ipv = await r.ex.inspectEnvelope({ envelope: env });
    r.ex.install({ agentId: 'b', inspectionId: ipv.inspectionId });
    await check(tag + 'import', r, 'b', id, files, { approve: true });

    // ---- patch: the Commander edits the installed body, so the package diverges (bug a36d1b00) ----
    const pr = r.store.manage({ agentId: 'a', target: id, action: 'patch', find: 'Measure twice.', replace: 'Measure three times.', createdBy: 'user' });
    A.ok(pr.ok && pr.skill.packageDiverged, tag + 'patch: the package diverged');
    await check(tag + 'patch', r, 'a', id, files, { approve: true });
    checkExport(tag + 'patch (diverged export)', exported(r, 'a', id), files);

    // ---- write_file: code (the log redactor rewrites it) as text, and binary bytes as base64 ----
    const code = Buffer.from(CODE.replace('check', 'verify'), 'utf8');
    const bin = binaryOf(rng(seed + 100), 40);
    A.ok(r.store.manage({ agentId: 'a', target: id, action: 'write_file', path: 'scripts/verify.py', content: code.toString('utf8'), createdBy: 'user' }).ok, tag + 'write_file text ok');
    A.ok(r.store.manage({ agentId: 'a', target: id, action: 'write_file', path: 'assets/added.bin', encoding: 'base64', content: bin.toString('base64'), createdBy: 'user' }).ok, tag + 'write_file binary ok');
    const textViaB64 = Buffer.from('written as base64, read as text — ✓\n', 'utf8');
    A.ok(r.store.manage({ agentId: 'a', target: id, action: 'write_file', path: 'references/b64.md', encoding: 'base64', content: textViaB64.toString('base64'), createdBy: 'user' }).ok, tag + 'write_file text-as-base64 ok');
    let now = files.concat([{ path: 'scripts/verify.py', bytes: code }, { path: 'assets/added.bin', bytes: bin }, { path: 'references/b64.md', bytes: textViaB64 }]);
    await check(tag + 'write_file', r, 'a', id, now, { approve: true });

    // ---- remove_file: the file leaves the store AND the package dir ----
    const gone = files[0].path;
    A.ok(r.store.manage({ agentId: 'a', target: id, action: 'remove_file', path: gone, createdBy: 'user' }).ok, tag + 'remove_file ok');
    now = now.filter(f => f.path !== gone);
    await check(tag + 'remove_file', r, 'a', id, now, { approve: true });
    checkExport(tag + 'remove_file (diverged export)', exported(r, 'a', id), now);

    // ---- export the diverged skill and import it as a third agent's ----
    const denv = r.ex.exportPackage({ agentId: 'a', id }).envelope;
    const dpv = await r.ex.inspectEnvelope({ envelope: denv });
    r.ex.install({ agentId: 'c', inspectionId: dpv.inspectionId });
    await check(tag + 'diverged export -> import', r, 'c', id, now, { approve: true });   // every file, a root LICENSE included

    // ---- reload: a fresh store over the same log and package dir ----
    const r2 = rig(r.lines, r.root);
    r2.serve = r.serve;
    await check(tag + 'reload', r2, 'a', id, now, { approve: true });

    // ---- update: re-install a newer upstream over the diverged copy (the package is sealed again) ----
    const files2 = caseFiles(seed + 50).concat([{ path: 'references/source-' + seed + '.md', bytes: Buffer.from('Docs v2: https://example.invalid/docs\n', 'utf8') }]);
    r.serve(url, [{ path: 'SKILL.md', bytes: Buffer.from(skillMd('rt-' + seed, 'Round trip ' + seed + ' v2', '1. The second version.\n2. Two steps.')) }].concat(files2));
    const upv = await r.ex.inspect({ url });
    const up = r.ex.install({ agentId: 'a', inspectionId: upv.inspectionId });
    A.eq(up.action, 'update', tag + 'update: the re-install updates the same skill');
    await check(tag + 'update', r, 'a', id, files2, { approve: true });

    // ---- rollback: the snapshot taken before the update brings the diverged-era generation's bytes back ----
    const gens = r.ex.generations({ agentId: 'a', id });
    const first = gens.generations.find(g => g.digest === inst.skill.packageDigest);
    A.ok(!!first, tag + 'rollback: the first install is an offline generation');
    if (first) {
      r.ex.rollback({ agentId: 'a', id, digest: first.digest, force: true });
      await check(tag + 'rollback', r, 'a', id, files, { approve: true });
    }
  } catch (e) { A.ok(false, 'seed ' + seed + ': a path threw: ' + ((e && e.message) || e)); }

  // ---- an authored skill: a body with trailing whitespace, code, binary; dangerous so it asks (user tier) ----
  {
    const r = rig();
    const made = r.store.manage({ agentId: 'a', action: 'create', name: 'Cleanup Steps', summary: 'clean the build dir',
      body: '1. Clear it with rm -rf $HOME/build-cache\n2. Rebuild.\n\n', createdBy: 'user' });
    A.ok(made.ok, 'authored: created');
    const code = Buffer.from(CODE, 'utf8'), bin = binaryOf(rng(77), 33);
    r.store.manage({ agentId: 'a', target: made.skill.id, action: 'write_file', path: 'scripts/check.py', content: code.toString('utf8'), createdBy: 'user' });
    r.store.manage({ agentId: 'a', target: made.skill.id, action: 'write_file', path: 'assets/data.bin', encoding: 'base64', content: bin.toString('base64'), createdBy: 'user' });
    const v = await check('authored', r, 'a', made.skill.id, [{ path: 'assets/data.bin', bytes: bin }, { path: 'scripts/check.py', bytes: code }], { approve: true });
    A.eq(v && v.body, '1. Clear it with rm -rf $HOME/build-cache\n2. Rebuild.\n\n', 'authored: the view is the stored body, whitespace and all');
    checkExport('authored', exported(r, 'a', made.skill.id), [{ path: 'assets/data.bin', bytes: bin }, { path: 'scripts/check.py', bytes: code }]);
  }

  // ---- the a36d1b00 repro, as filed: install a text reference, patch the body as the Commander, read the disk ----
  {
    const r = rig();
    const url = 'https://example.invalid/skills/setup/SKILL.md';
    const setupText = 'Before anything else, paste this command into the build shell:\n  make setup\n';
    r.serve(url, [{ path: 'SKILL.md', bytes: Buffer.from(skillMd('setup-helper', 'Sets things up', '1. Read references/setup.md\n2. Run it.')) },
      { path: 'references/setup.md', bytes: Buffer.from(setupText, 'utf8') }]);
    const pv = await r.ex.inspect({ url });
    const inst = r.ex.install({ agentId: 'a', inspectionId: pv.inspectionId });
    r.store.manage({ agentId: 'a', target: inst.skill.id, action: 'patch', find: 'Run it.', replace: 'Run it once.', createdBy: 'user' });
    const dir = r.pk.packageDir(r.store.view('a', inst.skill.id, { bump: false }));
    const onDisk = fs.readFileSync(path.join(dir, 'references', 'setup.md'), 'utf8');
    A.eq(onDisk, setupText, 'a36d1b00: references/setup.md on disk is its text after the package diverged, never a line of base64');
    const loaded = require('../sidecar/skills/runtime.js').composeLoaded([r.store.view('a', inst.skill.id, { bump: false })]);
    A.ok(loaded.indexOf(setupText) >= 0 && loaded.indexOf(Buffer.from(setupText).toString('base64')) < 0, 'a36d1b00: the preloaded skill shows the file as text');
  }

  // ---- upgrade: a v0.14 save keeps its approvals, and its base64-text mirror is read as the text it encodes ----
  {
    const root = path.join(tmp, 'v014');
    const text = 'Use the ruler before the saw. https://example.invalid/ruler\n', bin = binaryOf(rng(9), 24);
    const rec = { id: 'old-pkg', agentId: 'a', name: 'Old Package', summary: 'an install from v0.14', body: '1. Measure.\n2. Cut.',
      createdBy: 'community', writtenBy: 'user', sourceUrl: 'https://example.invalid/old/SKILL.md', sourceDigest: 'd'.repeat(64),
      packageDigest: 'e'.repeat(64), packageDiverged: true, state: 'active', updatedAt: 100, createdAt: 100,
      files: [{ path: 'references/ruler.md', encoding: 'base64', content: Buffer.from(text).toString('base64'), updatedAt: 0 },
        { path: 'assets/ruler.bin', encoding: 'base64', content: bin.toString('base64'), updatedAt: 0 }] };
    rec.scan = guard.scanSkillRecord(Object.assign({}, rec, { files: [{ path: 'references/ruler.md', content: text }] }), { source: 'community' });
    rec.guardAction = guard.actionFor(rec, rec.scan.verdict);
    rec.contentDigest = digestV014(rec);
    // the mirror v0.14 wrote for a diverged package: SKILL.md rendered, every support file AS ITS BASE64 TEXT (a36d1b00)
    const pk0 = makePackageStore({ fs, pathMod: path, root, now: () => 1 });
    const dir = pk0.packageDir(rec);
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true }); fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), pk0.renderSkillMd(rec), 'utf8');
    for (const f of rec.files) fs.writeFileSync(path.join(dir, f.path), f.content, 'utf8');
    const approvals = { ['a\x00old-pkg']: { digest: rec.contentDigest, stamp: rec.contentDigest, action: 'allow', at: 1, name: rec.name } };
    const r = rig([JSON.parse(JSON.stringify(rec))], root);
    A.eq(rec.guardAction, 'ask', 'v0.14: the fixture record asks (it needs its approval)');
    const restamps = typeof r.store.digestRestamps === 'function' ? r.store.digestRestamps() : [];
    const moved = typeof gateMod.restampApprovals === 'function' ? (gateMod.restampApprovals(approvals, restamps) || approvals) : approvals;
    const g = makeSkillGate({ guard, approvals: { get: (aid, sid, d) => moved[aid + '\x00' + sid + '\x00' + d] || moved[aid + '\x00' + sid] || null } });
    const row = r.store.list('a').find(s => s.id === 'old-pkg');
    A.eq(g.annotate([row])[0].withheld, false, 'v0.14: the Commander\'s approval still holds in the prompt index and skill.list');
    const v = r.store.view('a', 'old-pkg', { bump: false });
    A.eq(g.annotate([v], { verify: true })[0].withheld, false, 'v0.14: ...and at the delivery seam (the mirror is not read as tampered)');
    const out = (await makeSkillTools({ store: r.store, gate: g }).viewTool.run({ name: 'Old Package' }, { agentId: 'a' })).content;
    A.ok(out.indexOf('- references/ruler.md\n' + text) >= 0, 'v0.14: the base64-text mirror (a36d1b00) reaches the model as the text it encodes');
    A.ok(out.indexOf(Buffer.from(text).toString('base64')) < 0, 'v0.14: no base64 blob reaches the model');
    A.ok(out.indexOf('- assets/ruler.bin (binary file, ' + bin.length + ' bytes, not shown as text)') >= 0, 'v0.14: the binary asset is named');
    // the next write of the record heals the mirror to real bytes
    r.store.manage({ agentId: 'a', target: 'old-pkg', action: 'restore', createdBy: 'user' });
    A.eq(fs.readFileSync(path.join(dir, 'references', 'ruler.md'), 'utf8'), text, 'v0.14: the next write puts the real text on disk');
    A.ok(fs.readFileSync(path.join(dir, 'assets', 'ruler.bin')).equals(bin), 'v0.14: ...and the real binary bytes');
  }

  // ---- digests read BYTES: a binary file never digests like a text file holding its base64 ----
  {
    const bin = binaryOf(rng(31), 40);
    const rec = (files) => ({ body: '1. x', setup: '', files });
    A.ok(digestOf(rec([{ path: 'assets/a.bin', encoding: 'base64', content: bin.toString('base64') }])) !== digestOf(rec([{ path: 'assets/a.bin', encoding: 'utf8', content: bin.toString('base64') }])),
      'digest: a binary file and a text file holding its base64 are different bytes, so different digests');
    for (const seed of [1, 2, 3]) {
      const t = Buffer.from(textOf(rng(seed + 100), 4), 'utf8');
      const asText = rec([{ path: 'references/t.md', encoding: 'utf8', content: t.toString('utf8') }]);
      A.eq(digestOf(asText), digestOf(rec([{ path: 'references/t.md', encoding: 'base64', content: t.toString('base64') }])), 'digest: seed ' + seed + ' the same text stored base64 or as text is one digest');
      A.eq(digestOf(asText), digestV014(asText), 'digest: seed ' + seed + ' a text file stored as text digests as in v0.14 (an authored skill\'s approval stays put)');
    }
    // a v0.14 save whose only support file is binary keeps its approval across the digest change (the boot re-stamp)
    const root = path.join(tmp, 'v014-bin');
    const r0 = { id: 'old-bin', agentId: 'a', name: 'Old Binary', summary: 'a binary asset', body: '1. rm -rf $HOME/old-bin-cache\n2. done', createdBy: 'user', writtenBy: 'user',
      state: 'active', updatedAt: 100, createdAt: 100, files: [{ path: 'assets/logo.bin', encoding: 'base64', content: bin.toString('base64'), updatedAt: 0 }] };
    r0.scan = guard.scanSkillRecord(r0, { source: 'user' });
    r0.guardAction = guard.actionFor(r0, r0.scan.verdict);
    r0.contentDigest = digestV014(r0);
    const approvals = { ['a\x00old-bin']: { digest: r0.contentDigest, stamp: r0.contentDigest, action: 'allow', at: 1, name: r0.name } };
    const r = rig([JSON.parse(JSON.stringify(r0))], root);
    A.eq(r0.guardAction, 'ask', 'v0.14 binary: the fixture record asks (it needs its approval)');
    const moved = typeof gateMod.restampApprovals === 'function' && typeof r.store.digestRestamps === 'function' ? (gateMod.restampApprovals(approvals, r.store.digestRestamps()) || approvals) : approvals;
    const g = makeSkillGate({ guard, approvals: { get: (aid, sid, d) => moved[aid + '\x00' + sid + '\x00' + d] || moved[aid + '\x00' + sid] || null } });
    A.eq(g.annotate([r.store.list('a').find(s => s.id === 'old-bin')])[0].withheld, false, 'v0.14 binary: the approval still holds in the prompt index and skill.list');
    A.eq(g.annotate([r.store.view('a', 'old-bin', { bump: false })], { verify: true })[0].withheld, false, 'v0.14 binary: ...and at the delivery seam');
  }

  // ---- a patch rewrites only what it patches (the first patch of an install used to redact the whole record) ----
  {
    const r = rig();
    const GHP = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const url = 'https://example.invalid/skills/patch-one/SKILL.md';
    r.serve(url, [{ path: 'SKILL.md', bytes: Buffer.from(skillMd('patch-one', 'Uses token ' + GHP, '1. Set GH token ' + GHP + '\n2. password = "hunter2hunter2"\n3. keep this line')) },
      { path: 'references/src.md', bytes: Buffer.from('see https://example.invalid/docs\n') }]);
    const inst = r.ex.install({ agentId: 'a', inspectionId: (await r.ex.inspect({ url })).inspectionId });
    const before = r.store.view('a', inst.skill.id, { bump: false, hydrate: false });
    A.ok(before.body.indexOf(GHP) >= 0 && before.summary.indexOf(GHP) >= 0, 'patch: precondition, the install is stored verbatim');
    A.ok(r.store.manage({ agentId: 'a', target: inst.skill.id, action: 'patch', find: 'keep this line', replace: 'keep this line too', createdBy: 'user' }).ok, 'patch: ok');
    const after = r.store.view('a', inst.skill.id, { bump: false, hydrate: false });
    A.eq(after.body, before.body.replace('keep this line', 'keep this line too'), 'patch: the body changes only where it was patched');
    A.eq([after.summary, after.description, after.setup], [before.summary, before.description, before.setup], 'patch: every other stored field is carried as it was');
    A.ok(r.store.manage({ agentId: 'a', target: inst.skill.id, action: 'patch', find: 'keep this line too', replace: 'export GH=' + GHP, createdBy: 'agent', sourceRunId: 'run-1' }).ok, 'patch: a model patch is written');
    const red = r.store.view('a', inst.skill.id, { bump: false, hydrate: false });
    A.ok(red.body.indexOf('export GH=' + GHP) < 0 && red.body.indexOf('1. Set GH token ' + GHP) >= 0, 'patch: the patched-in text is redacted at write, the lines around it are not');
  }

  // ---- the boot re-stamp digests only records whose digest can move ----
  {
    const lines = [
      { id: 'plain', agentId: 'a', name: 'Plain', body: '1. a', createdBy: 'user', state: 'active', updatedAt: 1, createdAt: 1, files: [{ path: 'references/a.md', encoding: 'utf8', content: 'café 🛠️\r\nline' }] },
      { id: 'no-files', agentId: 'a', name: 'No Files', body: '1. b', createdBy: 'user', state: 'active', updatedAt: 1, createdAt: 1, files: [] },
      { id: 'b64', agentId: 'a', name: 'B64', body: '1. c', createdBy: 'user', state: 'active', updatedAt: 1, createdAt: 1, files: [{ path: 'references/b.md', encoding: 'base64', content: Buffer.from('text').toString('base64') }] },
      { id: 'trailing', agentId: 'a', name: 'Trailing', body: '1. d\n', createdBy: 'user', state: 'active', updatedAt: 1, createdAt: 1, files: [] },
      { id: 'surrogate', agentId: 'a', name: 'Surrogate', body: '1. e', createdBy: 'user', state: 'active', updatedAt: 1, createdAt: 1, files: [{ path: 'references/s.md', encoding: 'utf8', content: 'lone \uD800 half' }] }
    ];
    for (const l of lines) l.contentDigest = digestV014(Object.assign({}, l, { setup: '' }));
    const io = () => ({ readAll: () => lines.map(l => JSON.parse(JSON.stringify(l))), append() {} });
    const fast = makeSkillStore({ io: io(), clock: { now: () => 1 }, guard, digest: digestOf });
    const slow = makeSkillStore({ io: io(), clock: { now: () => 1 }, guard, digest: digestOf, legacyDigest: (s) => gateMod.legacyDigestOf(s) });   // a wrapped pair: nothing is skipped
    const counts = fast._internals.settleCounts ? fast._internals.settleCounts() : null;
    A.eq(counts, { digested: 3, skipped: 2 }, 'boot: only the records whose digest can move are digested (base64, a trimmed body, a lone surrogate)');
    const restampsOf = (st) => typeof st.digestRestamps === 'function' ? st.digestRestamps() : [];
    A.eq(JSON.stringify(restampsOf(fast)), JSON.stringify(restampsOf(slow)), 'boot: skipping changes no re-stamp');
    A.eq(fast.list('a').map(s => s.id + ':' + s.contentDigest).sort(), slow.list('a').map(s => s.id + ':' + s.contentDigest).sort(), 'boot: ...and no stamp');
  }

  // ---- the Skill Market (a market pull): a file is checked, written and read back as BYTES ----
  {
    const { makeSkillMarket } = require('../sidecar/skills/market.js');
    const marketFormat = require('../sidecar/skills/market-format.js');
    const signing = require('../sidecar/skills/market-signing.js');
    const KEY = signing.generateKeyPair();
    const INDEX = 'https://market.example/.well-known/starnet-skills.json';
    const md = Buffer.from('---\nname: byte-check\ndescription: "Checks bytes."\nlicense: MIT\nmetadata:\n  title: "Byte Check"\n---\n1. Check the bytes.\r\n2. Keep CRLF.\r\n', 'utf8');
    const notes = Buffer.from('﻿Notes with a BOM, CRLF\r\nand Ünïcödé.\r\n', 'utf8');
    // one catalog entry; `served` maps a path to the bytes the server answers with (and the signed manifest lists)
    async function marketRun(label, served) {
      const built = marketFormat.buildEntry({ slug: 'byte-check', version: '1.0.0', shelf: 'originals', license: 'MIT', authors: ['StarNet'],
        files: Object.keys(served).map(p => ({ path: p, content: p === 'SKILL.md' ? served[p].toString('utf8') : 'placeholder' })) });
      const pkg = packageFormat.canonicalize(Object.keys(served).map(p => ({ path: p, bytes: served[p] })));
      built.entry.digest = pkg.digest; built.entry.bytes = pkg.bytes;
      built.entry.files = pkg.files.map(f => ({ path: f.path, sha256: f.sha256, bytes: f.bytes }));
      const doc = marketFormat.catalogDocument([built.entry], { serial: 1, revoked: [] });
      const files = new Map();
      for (const p of Object.keys(served)) files.set(marketFormat.fileUrl(INDEX, built.entry, p), served[p]);
      const keys = [{ id: 'test-market', publicKey: KEY.publicKey }];
      const put = (url, value) => { const t = JSON.stringify(value, null, 2) + '\n'; files.set(url, Buffer.from(t)); files.set(signing.sigUrl(url), Buffer.from(signing.sign(Buffer.from(t), KEY.privateKeyPem, keys))); };
      put(INDEX, doc);
      put('https://market.example/.well-known/starnet-skills-revoked.json', marketFormat.revocationDocument({ serial: 1, revoked: [] }));
      const store = new Map();
      const root = path.join(tmp, 'market-' + label);
      const m = makeSkillMarket({ fs, path, root, guard, now: () => 1000, trustedKeys: keys, catalogUrl: () => INDEX,
        // a fetcher answers like skills/exchange-fetch.js: the bytes, and their UTF-8 reading
        fetchDocument: async (url) => { if (!files.has(url)) throw new Error('404 ' + url); const b = files.get(url); return { url, bytes: Buffer.from(b), text: b.toString('utf8') }; },
        loadJson: (f) => (store.has(f) ? JSON.parse(store.get(f)) : undefined), saveJson: (f, v) => store.set(f, JSON.stringify(v)) });
      try { await m.install({ slug: 'byte-check' }); return { root, m }; } catch (e) { return { error: (e && e.message) || String(e) }; }
    }
    const good = await marketRun('exact', { 'SKILL.md': md, 'references/notes.md': notes });
    A.ok(!good.error, 'market: the signed package installs' + (good.error ? ' (' + good.error + ')' : ''));
    if (!good.error) {
      A.ok(fs.readFileSync(path.join(good.root, 'byte-check', 'SKILL.md')).equals(md), 'market I1: SKILL.md is its exact signed bytes on disk (CRLF kept)');
      A.ok(fs.readFileSync(path.join(good.root, 'byte-check', 'references', 'notes.md')).equals(notes), 'market I1: the reference is its exact signed bytes on disk (BOM and CRLF kept)');
      const rec = good.m.recipes().find(x => x.slug === 'byte-check');
      A.ok(!!rec && rec.body.indexOf('Ünïcödé') >= 0, 'market I2: the installed recipe reads back from its verified bytes');
    }
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);   // "café\n" in Latin-1: bytes the catalog signed, but not UTF-8 text
    const bad = await marketRun('latin1', { 'SKILL.md': md, 'references/notes.md': latin1 });
    A.ok(!!bad.error && /is not text/.test(bad.error), 'market: a file whose bytes match the signed catalog but are not UTF-8 is refused by the text-only rule, by name (got: ' + bad.error + ')');
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.log('note: the temp dir was left behind (' + ((e && e.message) || e) + ')'); }
  A.report('skills.roundtrip.property.test');
})().catch(e => { console.log('FAIL: crashed: ' + ((e && e.stack) || e)); process.exit(1); });
