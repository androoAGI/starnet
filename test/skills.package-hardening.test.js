/* node test/skills.package-hardening.test.js — sweep/skills 2026-10-20: what hydrate() reads and what the guard scans.

   Real store + real package mirror on a temp dir + real guard/gate/tools; every assertion is on what skill.view hands
   the model (or what install/rollback answer), never on the store alone.
     A. a support folder that is itself a link (a Windows junction, or a directory symlink elsewhere) is not walked
     B. a hardlinked support file is not read
     C. a package on disk over the store's own limits (65 support files) is not this skill's package: the stored record
        is delivered, not the disk copy
     D. the description of an installed package is scanned like its body (a guard rule that only the description trips)
     E. a support file stored base64-encoded is scanned as its decoded text, so editing the body of an installed
        package keeps a support-file finding (the skill stays withheld)
     F. rolling back an installed skill respects `pinned`; only an explicit force overrides it */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const { makeSkillStore } = require('../sidecar/skillstore.js');
const { makePackageStore } = require('../sidecar/skills/package.js');
const { makeSkillExchange } = require('../sidecar/skills/exchange.js');
const packageFormat = require('../sidecar/skills/package-format.js');
const guard = require('../sidecar/skills/guard.js');
const { makeSkillGate, digestOf } = require('../sidecar/skills/gate.js');
const { makeSkillTools } = require('../sidecar/tools/builtin/skills.js');

const MARKER = 'SN_FIXTURE_SECRET_123';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-pkg-hardening-'));
const root = path.join(tmp, 'pk');
const outside = path.join(tmp, 'outside-the-package-root');
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, 'fixture.md'), 'credential-shaped fixture text ' + MARKER + '\n');

function rig(opts) {
  const pk = makePackageStore({ fs, pathMod: path, root, now: () => 1 });
  const lines = [];
  const store = makeSkillStore(Object.assign({ io: { readAll: () => lines.slice(), append: e => lines.push(e) }, clock: { now: () => 9000 },
    guard, digest: digestOf, packageStore: pk }, opts || {}));
  const gate = makeSkillGate({ guard, approvals: { get: () => null } });
  const tools = makeSkillTools({ store, gate });
  return { pk, store, gate, view: (agentId, name) => tools.viewTool.run({ name }, { agentId }) };
}
function linkDir(target, at) {
  if (process.platform === 'win32') cp.execSync('cmd /c mklink /J "' + at + '" "' + target + '"', { stdio: 'pipe' });
  else fs.symlinkSync(target, at, 'dir');
}
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const envelope = (files, meta) => packageFormat.toEnvelope(packageFormat.canonicalize(files), meta || {});

(async () => {
  // ---- A. a support folder that is itself a link ----
  {
    const r = rig({ stageReviews: false });
    const made = r.store.write({ agentId: 'a', name: 'Linked Folder', body: '1. read the notes', createdBy: 'user' });
    linkDir(outside, path.join(root, 'a', made.skill.id, 'references'));
    const v = r.store.view('a', 'Linked Folder', { bump: false });
    A.ok(!(v.files || []).some(f => /fixture\.md$/.test(f.path)), 'A: a file behind a linked support folder is not hydrated as a support file');
    const out = r.view('a', 'Linked Folder');
    A.eq(out.summary, 'loaded Linked Folder', 'A: the skill itself still loads');
    A.ok(out.content.indexOf(MARKER) < 0, 'A: the file outside the package root never reaches the model');
  }
  // ---- B. a hardlinked support file ----
  {
    const r = rig({ stageReviews: false });
    const made = r.store.write({ agentId: 'a', name: 'Hardlinked File', body: '1. read the notes', createdBy: 'user' });
    const refs = path.join(root, 'a', made.skill.id, 'references');
    fs.mkdirSync(refs, { recursive: true });
    fs.writeFileSync(path.join(refs, 'own.md'), 'own note');
    fs.linkSync(path.join(outside, 'fixture.md'), path.join(refs, 'notes.md'));
    const out = r.view('a', 'Hardlinked File');
    A.ok(out.content.indexOf(MARKER) < 0, 'B: a hardlinked file is not read into the skill');
    A.ok(out.content.indexOf('own note') >= 0, 'B: an ordinary support file beside it still is');
  }
  // ---- C. a package on disk over the store's own limits ----
  {
    const r = rig({ stageReviews: false });
    const made = r.store.write({ agentId: 'a', name: 'Many Files', body: '1. stored step', createdBy: 'user' });
    const dir = path.join(root, 'a', made.skill.id);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').replace('1. stored step', '1. DISK-ONLY-STEP'));
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
    for (let i = 0; i < 65; i++) fs.writeFileSync(path.join(dir, 'references', 'n' + i + '.md'), 'note ' + i);
    const v = r.store.view('a', 'Many Files', { bump: false });
    A.eq((v.files || []).length, 0, 'C: 65 support files on disk are not hydrated (the store holds at most 64)');
    A.ok(v.body.indexOf('DISK-ONLY-STEP') < 0 && v.body.indexOf('stored step') >= 0, 'C: the stored record is delivered instead of the over-limit disk copy');
    fs.rmSync(path.join(dir, 'references', 'n64.md'));
    const v64 = r.store.view('a', 'Many Files', { bump: false });
    A.eq((v64.files || []).length, 64, 'C: at the limit (64 files) the disk package still hydrates');
  }
  // ---- D. the description is scanned like the body ----
  {
    const r = rig();
    const ex = makeSkillExchange({ skillStore: r.store, packageStore: r.pk, guard, hash, now: () => 5000 });
    const md = '---\nname: notes-helper\ndescription: "Notes helper, docs at https://example.invalid/notes"\n---\n1. open the notes\n2. sum them';
    const pv = await ex.inspectEnvelope({ envelope: envelope([{ path: 'SKILL.md', content: md }]) });
    A.eq(pv.guardAction, 'ask', 'D: a finding only the description trips holds a community package for review');
    A.ok(pv.scan.findings.some(f => f.patternId === 'network_url'), 'D: the finding is reported');
    ex.install({ agentId: 'a', inspectionId: pv.inspectionId });
    const out = r.view('a', 'notes-helper');
    A.eq(out.summary, 'withheld', 'D: the installed skill is withheld until the Commander approves it');
  }
  // ---- E. a base64-stored support file keeps its finding after the body is edited ----
  {
    const r = rig();
    const ex = makeSkillExchange({ skillStore: r.store, packageStore: r.pk, guard, hash, now: () => 5000 });
    const pv = await ex.inspectEnvelope({ envelope: envelope([
      { path: 'SKILL.md', content: '---\nname: pdf-tools\ndescription: Work with PDFs.\n---\n1. open the pdf\n2. read references/links.md first' },
      { path: 'references/links.md', content: 'Setup notes live at https://example.invalid/setup\n' }
    ], { sourceUrl: 'https://skills.example/pdf/SKILL.md' }) });
    A.eq(pv.guardAction, 'ask', 'E: precondition: the support file holds the package for review');
    const inst = ex.install({ agentId: 'a', inspectionId: pv.inspectionId });
    A.eq(r.view('a', 'pdf-tools').summary, 'withheld', 'E: precondition: installed withheld');
    const p = r.store.manage({ agentId: 'a', action: 'patch', target: inst.skill.id, find: 'open the pdf', replace: 'open the PDF', createdBy: 'user' });
    A.ok(p.ok, 'E: the Commander edits the body');
    const after = r.store.view('a', inst.skill.id, { bump: false, hydrate: false });
    A.ok(after.packageDiverged, 'E: precondition: the install now differs from its source');
    A.eq(after.guardAction, 'ask', 'E: the support-file finding survives the edit (scanned decoded, not as base64)');
    A.eq(r.view('a', 'pdf-tools').summary, 'withheld', 'E: so the support file is still not delivered unapproved');
  }
  // Imported support files retain their bytes after editing the installed skill.
  {
    const r = rig();
    const ex = makeSkillExchange({ skillStore: r.store, packageStore: r.pk, guard, hash, now: () => 5000 });
    const text = 'Read these notes: café, 中文.\n';
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
    const pv = await ex.inspectEnvelope({ envelope: envelope([
      { path: 'SKILL.md', content: '---\nname: encoded-notes\ndescription: Notes.\n---\n1. read the notes' },
      { path: 'references/notes.md', content: text },
      { path: 'assets/sample.bin', content: binary.toString('base64'), encoding: 'base64' }
    ]) });
    const inst = ex.install({ agentId: 'a', inspectionId: pv.inspectionId });
    const before = r.view('a', 'encoded-notes');
    A.eq(before.summary, 'loaded encoded-notes', 'an imported benign skill loads');
    A.ok(before.content.includes(text), 'skill.view decodes imported UTF-8 support text');
    A.ok(before.content.includes('assets/sample.bin [base64]'), 'binary support content is labeled');
    A.ok(before.content.includes(binary.toString('base64')), 'binary content remains lossless');
    A.ok(r.store.manage({ agentId: 'a', action: 'patch', target: inst.skill.id, find: 'read the notes', replace: 'read all notes', createdBy: 'user' }).ok, 'editing the body succeeds');
    const dir = r.pk.packageDir(inst.skill);
    A.eq(fs.readFileSync(path.join(dir, 'references/notes.md'), 'utf8'), text, 'editing preserves UTF-8 bytes on disk');
    A.ok(fs.readFileSync(path.join(dir, 'assets/sample.bin')).equals(binary), 'editing preserves binary bytes on disk');
    const after = r.view('a', 'encoded-notes');
    A.ok(after.content.includes(text), 'hydration after editing still delivers decoded text');
    A.ok(after.content.includes(binary.toString('base64')), 'hydration after editing still delivers lossless binary content');
  }
  // ---- F. rollback respects pinned ----
  {
    const r = rig();
    const ex = makeSkillExchange({ skillStore: r.store, packageStore: r.pk, guard, hash, now: () => 5000 });
    const meta = { sourceUrl: 'https://skills.example/notes/SKILL.md' };
    const doc = (step) => envelope([{ path: 'SKILL.md', content: '---\nname: notes-tool\ndescription: Notes.\n---\n1. ' + step }], meta);
    const p1 = await ex.inspectEnvelope({ envelope: doc('VERSION-ONE') });
    const i1 = ex.install({ agentId: 'a', inspectionId: p1.inspectionId });
    const p2 = await ex.inspectEnvelope({ envelope: doc('VERSION-TWO') });
    A.eq(ex.install({ agentId: 'a', inspectionId: p2.inspectionId }).action, 'update', 'F: precondition: v2 updates v1 (v1 snapshotted)');
    A.ok(r.store.manage({ agentId: 'a', action: 'pin', target: i1.skill.id, createdBy: 'user' }).ok, 'F: the Commander pins it');
    let refused = '';
    try { ex.rollback({ agentId: 'a', id: i1.skill.id, digest: p1.packageDigest }); } catch (e) { refused = e.message; }
    A.ok(/pinned/.test(refused), 'F: a rollback of a pinned skill is refused: ' + refused);
    A.ok(r.store.view('a', i1.skill.id, { bump: false, hydrate: false }).body.indexOf('VERSION-TWO') >= 0, 'F: the pinned content is unchanged');
    const forced = ex.rollback({ agentId: 'a', id: i1.skill.id, digest: p1.packageDigest, force: true });
    A.ok(forced.ok && r.store.view('a', i1.skill.id, { bump: false, hydrate: false }).body.indexOf('VERSION-ONE') >= 0, 'F: an explicit force rolls it back');
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  A.report('skills.package-hardening');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
