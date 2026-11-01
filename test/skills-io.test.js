/* node test/skills-io.test.js — skills.jsonl never loses a skill: compacted, read whole, never size-rotated.

   Before: skills.jsonl was wired like the spend ledger. markUsed persisted the WHOLE record (body, support files,
   base64 package) of every loaded skill on every run; each append rotated the live file to skills.jsonl.1 past
   LOG_MAX_BYTES, deleting the previous .1; the boot read kept only the newest LOG_MAX_BYTES. On a busy station
   two rotations in one uptime deleted the only durable copy of every skill not used recently — 5 skills in, 2 out
   after a restart — and boot compaction then made it permanent.

   Laws under test (real fs in a temp dir, the same skills-io + skillstore the host wires):
     • the original failure: 5 skills, 40 runs using 2 of them, restart -> all 5, with the uses counted;
     • two rotations' worth of whole-record edits + a restart: the trunk wiring (rebuilt from logbound) kept 2 of 5,
       the real store + skills-io keep all 5 and their exact bodies;
     • a use appends a small usage row (never the whole record); uses and the stale->active flip survive restart;
     • the file is compacted, never rotated: it stays bounded and no .1 is ever made;
     • a legacy .1 left by an older StarNet is read whole and folded back in by the boot compaction, then removed;
     • a partial or failed load is never rewritten as the whole library, and refuses every write: the Commander's,
       the model's staged proposals (agent / reflection / review), a rejection and curation;
     • a use re-scans under the current rules and stores a changed scan (new findings under the same verdict too);
     • a torn row's own nested object (a candidate's `skill`, a promotion's `entry`) is never loaded as the active skill;
     • a usage row carries no `name`, so an older StarNet skips it instead of replacing the skill;
     • the package mirror view() hydrates holds only accepted bytes (a refused edit never reaches SKILL.md), and a use
       repairs a mirror this process has not written from the current record (after a failed write, or a boot);
     • a large library is not rewritten on every append (hysteresis); a torn row is reported, not silent;
     • rollback safety: between compactions the live file stays inside v0.13.5's 16 MiB read window (a library that is
       itself over the 12 MiB cap is compacted once per growth step, never per write; one that cannot fit the window, or
       whose records are huge, keeps the plain hysteresis: a write never pays a full rewrite of the library). */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeSkillStore } = require('../sidecar/skillstore.js');
const { makeSkillsIo } = require('../sidecar/skills-io.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-skills-io-'));
let t = 1000;
const clock = { now: () => ++t };
const body = (n) => 'Step ' + n + ': ' + 'do the thing carefully. '.repeat(1500);   // ~36 KB
function fixture(name, opts) {
  const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'skills.jsonl');
  const notes = [];
  const mkIo = () => makeSkillsIo(Object.assign({ fs, file, note: (tag, e) => notes.push(tag + ': ' + ((e && e.message) || e)),
    writeDurable: (f, b) => writeFileDurable({ fs, path }, f, b), compactBytes: 256 * 1024 }, opts || {}));
  const f = { file, notes, io: mkIo() };
  f.store = makeSkillStore({ io: f.io, clock });
  f.restart = () => { f.io = mkIo(); f.store = makeSkillStore({ io: f.io, clock }); return f.store; };
  return f;
}
const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
const sizeOf = (f) => { try { return fs.statSync(f).size; } catch (_) { return 0; } };   // a rotation leaves no live file
const seed = (s) => { for (const n of names) A.ok(s.write({ agentId: 'a', name: n, summary: n + ' procedure', body: body(n), createdBy: 'user' }).ok, 'seeded ' + n); };

// ---- 1. the original failure: nothing is lost across heavy use + restart ----
{
  const f = fixture('loss');
  seed(f.store);
  let maxSize = 0;
  for (let run = 0; run < 40; run++) { f.store.markUsed('a', ['Alpha', 'Bravo']); maxSize = Math.max(maxSize, sizeOf(f.file)); }
  A.ok(!fs.existsSync(f.file + '.1'), 'the live file is never rotated to .1');
  const s = f.restart();
  A.eq(s.count(), 5, 'all 5 skills survive 40 runs + a restart (trunk kept 2)');
  A.eq(s.view('a', 'Alpha', { bump: false }).useCount, 40, 'the uses survive the restart');
  A.eq((s.view('a', 'Charlie', { bump: false }) || {}).body, body('Charlie'), 'an unused skill keeps its exact body');
  A.ok(maxSize < 256 * 1024 + 64 * 1024, 'uses never balloon the file (max ' + maxSize + ' bytes)');
}

// ---- 1b. TWO ROTATIONS' worth of whole-record writes + a restart: 5 skills in, 5 out (the report's trunk run kept 2) ----
// A whole-record append still happens on every edit, so this drives the edit path (write() on an existing name) until the
// TRUNK wiring of skills.jsonl rotated twice, then the same workload through the real store + skills-io. The control is
// index.js's pre-fix skillsIo rebuilt from the same logbound functions it called (readBoundedJsonl = loadBounded, append
// then rotateJsonl = rotateIfLarge) at the LOG_MAX_BYTES floor index.js allows (1 MB); compaction gets the same floor.
{
  const { loadBounded, rotateIfLarge, appendJsonlDurable } = require('../sidecar/logbound.js');
  const FLOOR = 1 << 20;
  const drive = (store, file, runs) => {   // each run edits two skills; returns how often the live file shrank
    let shrank = 0, refused = 0, last = sizeOf(file);
    for (let run = 0; run < runs; run++) {
      for (const n of ['Alpha', 'Bravo']) if (!store.write({ agentId: 'a', name: n, summary: n + ' procedure', body: body(n) + ' rev ' + run, createdBy: 'user' }).ok) refused++;
      const sz = sizeOf(file); if (sz < last) shrank++; last = sz;
    }
    A.eq(refused, 0, 'every edit is accepted');
    return shrank;
  };
  // control: the trunk wiring
  const cdir = path.join(tmp, 'rotations-trunk'); fs.mkdirSync(cdir, { recursive: true });
  const cfile = path.join(cdir, 'skills.jsonl');
  const ledgerIo = {
    readAll() { try { return loadBounded({ fs }, cfile, FLOOR).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (e) { return []; } },
    append(entry) { appendJsonlDurable({ fs }, cfile, entry); try { rotateIfLarge({ fs }, cfile, FLOOR); } catch (_) {} }
  };
  const control = makeSkillStore({ io: ledgerIo, clock });
  seed(control);
  let runs = 0, rotations = 0;
  while (rotations < 2 && runs < 200) { rotations += drive(control, cfile, 1); runs++; }
  A.eq(rotations, 2, 'precondition: the trunk wiring rotated skills.jsonl twice (' + runs + ' runs)');
  const controlKept = makeSkillStore({ io: ledgerIo, clock }).count();
  A.eq(controlKept, 2, 'precondition: after two rotations + a restart the trunk wiring kept 2 of 5 (the report lost 3)');
  // the fix: the same workload through the real store + skills-io
  const f = fixture('rotations', { compactBytes: FLOOR });
  seed(f.store);
  const compactions = drive(f.store, f.file, runs);
  A.ok(compactions >= 1, 'the same workload compacts the file instead (' + compactions + ' compactions)');
  A.ok(!fs.existsSync(f.file + '.1'), 'and never makes a .1');
  const s = f.restart();
  A.eq(s.count(), 5, 'all 5 skills survive two rotations\' worth of writes + a restart');
  A.eq((s.view('a', 'Alpha', { bump: false }) || {}).body, body('Alpha') + ' rev ' + (runs - 1), 'an edited skill keeps its newest edit');
  for (const n of ['Charlie', 'Delta', 'Echo']) A.eq((s.view('a', n, { bump: false }) || {}).body, body(n), 'an untouched skill keeps its exact body (' + n + ')');
}

// ---- 2. a use is a small usage row, not the whole record; stale -> active survives restart ----
{
  const f = fixture('usage');
  seed(f.store);
  const before = fs.statSync(f.file).size;
  f.store.markUsed('a', 'Delta');
  const grew = fs.statSync(f.file).size - before;
  A.ok(grew > 0 && grew < 300, 'one use appends a ~150-byte usage row (' + grew + ' bytes), not the ~36 KB record');
  const last = JSON.parse(fs.readFileSync(f.file, 'utf8').trim().split('\n').pop());
  A.eq(last.recordType, 'skill-usage', 'the appended row is a usage row');
  A.ok(!('name' in last) && last.skillName === 'Delta', 'a usage row carries skillName, never `name` (an older StarNet skips it)');
  A.eq(f.store.curate('a', { now: t + 40 * 86400000 }).stale, 5, 'precondition: aging marks every skill stale');
  f.store.markUsed('a', 'Echo');
  const s = f.restart();
  A.eq(s.view('a', 'Echo', { bump: false }).state, 'active', 'a use flips stale -> active, and that survives restart');
  A.eq(s.view('a', 'Echo', { bump: false }).useCount, 1, 'and its use count with it');
  A.eq(s.view('a', 'Delta', { bump: false }).state, 'stale', 'a skill aged after its last use stays stale');
  A.eq(s.view('a', 'Delta', { bump: false }).useCount, 1, 'and keeps its earlier use');
}

// ---- 2b. the REAL run order: the run's view() flips stale -> active in RAM, then markUsed runs at run end ----
{
  const f = fixture('run-order');
  seed(f.store);
  A.eq(f.store.curate('a', { now: t + 40 * 86400000 }).stale, 5, 'precondition: every skill is stale');
  for (let run = 0; run < 3; run++) { f.store.viewAccessible('a', 'Alpha', {}); f.store.markUsed('a', ['Alpha']); }
  const s = f.restart();
  const a = s.view('a', 'Alpha', { bump: false });
  A.eq(a.state, 'active', 'a stale skill a run loaded is active after restart (view flipped it first)');
  A.eq([a.useCount, a.viewCount], [3, 3], 'its uses AND views survive restart');
}

// ---- 3. an older StarNet's loader (rows without `name` are skipped) never replaces a skill with a usage row ----
{
  const rows = [{ id: 'x', agentId: 'a', name: 'Xray', summary: 's', body: 'the real body', createdBy: 'user', state: 'active', createdAt: 1, updatedAt: 1 },
    { recordType: 'skill-usage', agentId: 'a', skillName: 'Xray', useCount: 7, lastUsedAt: 9 },
    { recordType: 'skill-usage', agentId: 'a', skillName: 'Ghost', useCount: 1, lastUsedAt: 9 }];
  const s = makeSkillStore({ io: { readAll: () => rows, append() {} }, clock });
  A.eq(s.count(), 1, 'a usage row for an unknown skill creates nothing');
  A.eq([s.view('a', 'Xray', { bump: false }).body, s.view('a', 'Xray', { bump: false }).useCount], ['the real body', 7], 'a usage row only moves the counters');
  const legacy = rows.filter(r => !r.recordType || r.recordType !== 'skill-usage').concat(rows.filter(r => r.recordType === 'skill-usage').map(r => { const c = Object.assign({}, r); delete c.recordType; return c; }));
  A.eq(makeSkillStore({ io: { readAll: () => legacy, append() {} }, clock }).view('a', 'Xray', { bump: false }).body, 'the real body', 'even read as a plain record, a nameless usage row cannot replace the skill');
}

// ---- 4. a legacy .1 (an older StarNet rotated the file) is read whole, folded in at boot, then removed ----
{
  const f = fixture('legacy');
  const rec = (n, extra) => Object.assign({ id: n.toLowerCase(), agentId: 'a', name: n, summary: n, body: body(n), createdBy: 'user', state: 'active', createdAt: 1, updatedAt: 1 }, extra || {});
  fs.writeFileSync(f.file + '.1', [rec('Alpha'), rec('Bravo'), rec('Charlie')].map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(f.file, [rec('Alpha', { useCount: 9, updatedAt: 2 }), rec('Delta')].map(r => JSON.stringify(r)).join('\n') + '\n');
  const s = f.restart();
  A.eq(s.count(), 4, 'archive + live are both read whole');
  A.eq(s.view('a', 'Alpha', { bump: false }).useCount, 9, 'the live (newer) record wins over the archive');
  A.ok(f.io.needsCompaction(), 'a legacy .1 asks for the boot compaction');
  A.ok(s.compact().ok, 'the boot compaction runs');
  A.ok(!fs.existsSync(f.file + '.1'), 'and removes the folded-in archive');
  A.eq(f.restart().count(), 4, 'every skill from the archive survives the next restart');
}

// ---- 5. a partial or failed load is never rewritten as the whole library ----
{
  const f = fixture('partial', { readMaxBytes: 50 * 1024 });   // smaller than the seeded file
  const full = fixture('partial-seed');
  seed(full.store);
  fs.copyFileSync(full.file, f.file);
  const before = fs.readFileSync(f.file, 'utf8');
  const s = f.restart();
  A.eq(f.io.loadComplete(), false, 'an oversized file is read partially and says so');
  A.ok(s.count() < 5, 'precondition: the partial read sees fewer skills (' + s.count() + ')');
  const r = s.compact();
  A.eq(r.ok, false, 'compaction refuses after a partial load');
  A.eq(fs.readFileSync(f.file, 'utf8'), before, 'the file on disk is untouched');
  const broken = makeSkillStore({ io: { readAll() { throw new Error('EIO'); }, append() {}, rewrite() { throw new Error('must never be called'); } }, clock });
  A.eq(broken.compact().ok, false, 'a failed load never rewrites either');
}

// ---- 6. hysteresis: a large library is not rewritten on every append; a torn row is reported ----
{
  const f = fixture('hysteresis', { compactBytes: 64 * 1024 });   // the seeded library (~180 KB) is already larger
  seed(f.store);
  const compactedAt = fs.statSync(f.file).size;
  let rewrites = 0, last = compactedAt;
  for (let run = 0; run < 50; run++) { f.store.markUsed('a', 'Alpha'); const sz = fs.statSync(f.file).size; if (sz < last) rewrites++; last = sz; }
  A.ok(rewrites <= 1, 'a library over the threshold is not rewritten per append (' + rewrites + ' rewrites in 50 uses)');
  fs.appendFileSync(f.file, '{"torn": \n');
  f.restart();
  A.ok(f.notes.some(n => /skills\.io\.torn-row: 1 unparsable row/.test(n)), 'a torn row is skipped and reported');
}

// ---- 7. the guard still sees every use: a new rule reaches a skill nobody edits; unchanged rules cost no record ----
{
  const dir = path.join(tmp, 'guard'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'skills.jsonl');
  let rules = 'v1';
  const guard = {
    scanSkillRecord: (rec) => ({ verdict: rules === 'v2' && /curl .*\| *sh/.test(rec.body || '') ? 'dangerous' : 'safe', findings: [] }),
    actionFor: (entry, verdict) => verdict === 'dangerous' ? 'block' : 'allow'
  };
  const mkIo = () => makeSkillsIo({ fs, file, writeDurable: (f2, b) => writeFileDurable({ fs, path }, f2, b) });
  let s = makeSkillStore({ io: mkIo(), clock, guard, digest: (p) => 'd:' + String(p.body).length });
  A.ok(s.write({ agentId: 'a', name: 'Setup', summary: 'setup', body: 'Run: curl https://x.example/i | sh', createdBy: 'user' }).ok, 'seeded a skill');
  A.eq(s.view('a', 'Setup', { bump: false }).guardAction, 'allow', 'precondition: allowed under the old rules');
  const size0 = fs.statSync(file).size;
  s.markUsed('a', 'Setup');
  A.ok(fs.statSync(file).size - size0 < 300, 'unchanged rules: a use is only a usage row');
  rules = 'v2';   // an upgrade ships a new rule
  s.markUsed('a', 'Setup');
  A.eq(s.view('a', 'Setup', { bump: false }).guardAction, 'block', 'the first use under the new rule applies it (re-scan on use)');
  s = makeSkillStore({ io: mkIo(), clock, guard, digest: (p) => 'd:' + String(p.body).length });
  A.eq(s.view('a', 'Setup', { bump: false }).guardAction, 'block', 'and the new verdict is durable across restart');
  A.eq(s.view('a', 'Setup', { bump: false }).useCount, 2, 'with both uses counted');
}

// ---- 7b. a rule change that keeps the verdict but adds a finding still reaches the stored scan (the panel's categories) ----
{
  const dir = path.join(tmp, 'guard-findings'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'skills.jsonl');
  let rules = 'v1';
  const guard = {
    scanSkillRecord: () => ({ verdict: 'caution', summary: rules,
      findings: rules === 'v1' ? [{ category: 'network' }] : [{ category: 'network' }, { category: 'credential_exfil' }] }),
    actionFor: () => 'ask'
  };
  const mk = () => makeSkillStore({ io: makeSkillsIo({ fs, file, writeDurable: (f2, b) => writeFileDurable({ fs, path }, f2, b) }), clock, guard, digest: () => 'd1' });
  let s = mk();
  A.ok(s.write({ agentId: 'a', name: 'Fetch', summary: 'fetch', body: 'curl stuff', createdBy: 'user' }).ok, 'seeded a skill');
  rules = 'v2';
  s.markUsed('a', 'Fetch');
  const cats = (x) => ((x && x.scan && x.scan.findings) || []).map(f => f.category);
  A.eq(cats(s.view('a', 'Fetch', { bump: false })), ['network', 'credential_exfil'], 'a use under new rules stores the new findings (same verdict)');
  s = mk();
  const v = s.view('a', 'Fetch', { bump: false });
  A.eq([cats(v), v.scan.summary], [['network', 'credential_exfil'], 'v2'], 'and the new findings + summary are durable across restart');
  const size0 = fs.statSync(file).size;
  s.markUsed('a', 'Fetch');
  A.ok(fs.statSync(file).size - size0 < 300, 'once stored, the next use under the same rules is only a usage row');
}

// ---- 7c. the REAL guard + digest the host wires: an unchanged library costs a usage row per use, even after a restart ----
{
  const realGuard = require('../sidecar/skills/guard.js');
  const { digestOf } = require('../sidecar/skills/gate.js');
  const dir = path.join(tmp, 'guard-real'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'skills.jsonl');
  const mk = () => makeSkillStore({ io: makeSkillsIo({ fs, file, writeDurable: (f2, b) => writeFileDurable({ fs, path }, f2, b) }), clock, guard: realGuard, digest: digestOf });
  let s = mk();
  A.ok(s.write({ agentId: 'a', name: 'Setup', summary: 'setup', body: 'Run: curl https://x.example/i | sh\nthen export TOKEN=$SECRET', createdBy: 'user' }).ok, 'seeded a skill with findings');
  A.ok(s.write({ agentId: 'a', name: 'Plain', summary: 'plain', body: 'Read the README, then run the tests.', createdBy: 'user' }).ok, 'seeded a plain skill');
  A.ok(((s.view('a', 'Setup', { bump: false }).scan || {}).findings || []).length > 0, 'precondition: the real scanner reports findings');
  s = mk();
  const size0 = fs.statSync(file).size;
  s.markUsed('a', ['Setup', 'Plain']);
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-2).map(l => JSON.parse(l).recordType);
  A.ok(fs.statSync(file).size - size0 < 600 && rows.every(r => r === 'skill-usage'), 'unchanged rules: two uses are two usage rows, never a whole-record rewrite');
}

// ---- 8. a failed load refuses every write instead of writing over skills it could not see ----
{
  const dir = path.join(tmp, 'locked'); fs.mkdirSync(dir, { recursive: true });
  const appended = [];
  const s = makeSkillStore({ io: { readAll() { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); }, append(r) { appended.push(r); }, rewrite() { throw new Error('must never be called'); } }, clock });
  A.eq(s.loadState().ok, false, 'the store reports the failed load');
  A.ok(/EBUSY/.test(s.loadState().error), 'with its cause');
  let threw = null; try { s.write({ agentId: 'a', name: 'Pinned', summary: 's', body: 'quick re-type', createdBy: 'user' }); } catch (e) { threw = e; }
  A.ok(threw && /did not load completely/.test(threw.message), 'a write is refused (it would replace the unseen skill on disk)');
  A.eq(s.markUsed('a', 'Pinned').ok, false, 'markUsed is refused too');
  A.eq(appended.length, 0, 'nothing reached disk');
}

// ---- 8b. the MODEL's write path (staged proposals) is refused too: a failed load never supersedes a real proposal ----
{
  const realGuard = require('../sidecar/skills/guard.js');
  const { digestOf } = require('../sidecar/skills/gate.js');
  const dir = path.join(tmp, 'locked-staged'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'skills.jsonl');
  const mkIo = () => makeSkillsIo({ fs, file, writeDurable: (f2, b) => writeFileDurable({ fs, path }, f2, b) });
  let s = makeSkillStore({ io: mkIo(), clock, guard: realGuard, digest: digestOf });
  A.ok(s.write({ agentId: 'a', name: 'Deploy', summary: 'deploy', body: '1. npm ci\n2. npm test\n3. ship', createdBy: 'user' }).ok, 'seeded the Commander\'s skill');
  const p = s.write({ agentId: 'a', name: 'Deploy', summary: 'deploy', body: '1. npm ci\n2. npm test\n3. ship\n4. VERIFY LIVE', createdBy: 'background-review' });
  A.ok(p.ok && p.pending, 'precondition: a review proposal is pending');
  const before = fs.readFileSync(file, 'utf8');
  // a boot whose read fails (the file is locked); the real appender still reaches the file
  const failing = Object.assign({}, mkIo(), { readAll() { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); } });
  s = makeSkillStore({ io: failing, clock, guard: realGuard, digest: digestOf });
  A.eq(s.loadState().ok, false, 'precondition: the load failed');
  for (const by of ['agent', 'reflection', 'background-review']) {
    const w = s.write({ agentId: 'a', name: 'Deploy', summary: 'deploy', body: 'a run rewrote it from scratch', createdBy: by, sourceRunId: 'r9' });
    A.ok(!w.ok && /did not load completely/.test(w.error || ''), 'a staged write by ' + by + ' is refused');
    const m = s.manage({ agentId: 'a', action: 'create', name: 'Deploy2', summary: 'd', body: 'new', createdBy: by });
    A.ok(!m.ok && /did not load completely/.test(m.error || ''), 'a staged manage by ' + by + ' is refused');
  }
  A.ok(!s.rejectCandidate({ agentId: 'a', candidateId: p.candidate.candidateId, candidateDigest: p.candidate.candidateDigest }).ok, 'a rejection is refused');
  A.ok(s.curate('a', { now: t + 400 * 86400000 }).ok === false, 'curation is refused (and does not throw)');
  const grew = fs.readFileSync(file, 'utf8').length - before.length;
  A.ok(fs.readFileSync(file, 'utf8') === before, 'nothing reached disk (' + grew + ' chars appended)');
  s = makeSkillStore({ io: mkIo(), clock, guard: realGuard, digest: digestOf });
  const pend = s.candidates('a', { includeBody: true });
  A.ok(pend.length === 1 && /VERIFY LIVE/.test(pend[0].skill.body) && pend[0].baseCurrent === true, 'the next healthy boot still holds the review\'s real proposal');
}

// ---- 9. a glued whole record is recovered; anything unreadable is saved aside before a rewrite ----
{
  const f = fixture('glued');
  const rec = (n, b) => ({ id: n.toLowerCase(), agentId: 'a', name: n, summary: n, body: b, createdBy: 'user', state: 'active', createdAt: 1, updatedAt: 2 });
  fs.writeFileSync(f.file + '.1', JSON.stringify(rec('Alpha', 'alpha v1')) + '\n');
  fs.writeFileSync(f.file, '{"id":"bravo","agentId":"a","na' + JSON.stringify(rec('Bravo', 'BRAVO V2 (the newest edit)')) + '\n'
    + JSON.stringify(rec('Charlie', 'charlie')) + '\n' + '\u0000\u0000garbage-not-json\n');
  const s = f.restart();
  A.eq(s.view('a', 'Bravo', { bump: false }).body, 'BRAVO V2 (the newest edit)', 'a whole record glued onto a torn fragment is recovered');
  A.eq(s.count(), 3, 'every readable skill loads');
  A.ok(s.compact().ok, 'the (legacy .1) compaction runs');
  const saved = fs.readFileSync(f.file + '.damaged', 'utf8');
  A.ok(saved.includes('garbage-not-json') && saved.includes('BRAVO V2'), 'the unreadable lines were saved aside, byte for byte, before the rewrite');
  A.eq(f.restart().view('a', 'Bravo', { bump: false }).body, 'BRAVO V2 (the newest edit)', 'and the recovered edit survives the compaction + restart');
}

// ---- 9b. a TORN row's own nested object is never "recovered" as a record: the approved skill stays active ----
// A pending candidate row ends with its `skill` object and a promotion row starts with its `entry` object; a crash that
// cuts the row right after that object leaves a tail that parses on its own. Peeling it out would load an unapproved
// proposal (or half a promotion) as the ACTIVE skill, and the next compaction would delete the approved version.
{
  const realGuard = require('../sidecar/skills/guard.js');
  const { digestOf } = require('../sidecar/skills/gate.js');
  const cases = [
    { label: 'a candidate row that lost its final byte', cut: (line) => line.slice(0, -1) },
    { label: 'a promotion row cut right after its entry', promote: true,
      cut: (line) => { const r = JSON.parse(line); return '{"recordType":"skill-promotion","entry":' + JSON.stringify(r.entry); } }
  ];
  for (const c of cases) {
    const dir = path.join(tmp, 'torn-' + (c.promote ? 'promotion' : 'candidate')); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'skills.jsonl');
    const notes = [];
    const mk = () => makeSkillStore({ io: makeSkillsIo({ fs, file, note: (tag, e) => notes.push(tag + ': ' + ((e && e.message) || e)),
      writeDurable: (f2, b) => writeFileDurable({ fs, path }, f2, b) }), clock, guard: realGuard, digest: digestOf,
      validatePromotionReceipt: () => ({ ok: true, status: 'pass', receiptId: 'receipt-1' }) });
    let s = mk();
    A.ok(s.write({ agentId: 'a', name: 'Deploy', summary: 'deploy', body: 'the APPROVED active body', createdBy: 'user' }).ok, c.label + ': seeded');
    const p = s.write({ agentId: 'a', name: 'Deploy', summary: 'deploy', body: 'an UNAPPROVED proposal body', createdBy: 'background-review' });
    A.ok(p.ok && p.pending, c.label + ': a proposal is pending');
    if (c.promote) {
      const r = s.approveCandidate({ agentId: 'a', candidateId: p.candidate.candidateId, candidateDigest: p.candidate.candidateDigest, approvedBy: 'user', evaluation: { receiptId: 'receipt-1' } });
      A.ok(r.ok, c.label + ': precondition: the promotion was appended');
    }
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const last = lines.pop();
    A.eq(JSON.parse(last).recordType, c.promote ? 'skill-promotion' : 'skill-candidate', c.label + ': precondition: the last row is the one torn');
    fs.writeFileSync(file, lines.join('\n') + '\n' + c.cut(last) + '\n');   // the crash
    s = mk();
    const body1 = (s.view('a', 'Deploy', { bump: false, hydrate: false }) || {}).body;
    A.eq(body1, 'the APPROVED active body', c.label + ': the approved skill stays active after restart');
    A.ok(notes.some(n => /skills\.io\.torn-row: 1 unparsable row.*; 0 whole record/.test(n)), c.label + ': the torn row is reported, nothing "recovered" from it');
    A.ok(s.compact().ok, c.label + ': a compaction runs');
    A.eq((mk().view('a', 'Deploy', { bump: false, hydrate: false }) || {}).body, 'the APPROVED active body', c.label + ': and the approved body survives compaction + restart');
    A.ok(fs.readFileSync(file + '.damaged', 'utf8').includes('UNAPPROVED proposal body'), c.label + ': the torn bytes are saved aside');
  }
}

// ---- 11. the package mirror holds only accepted bytes, and a use heals it (a use no longer persists the record) ----
// view() hydrates skill-packages/<agent>/<id>/SKILL.md over a non-canonical skill's stored body. Trunk's per-use persist()
// re-wrote that mirror at every run end; a usage row does not. Real package store, guard and gate digest the host wires;
// what a run is given = viewAccessible + gate.verify, the run end = markUsed. The only faults: one EPERM on the
// skills.jsonl append, or one EBUSY on SKILL.md.
{
  const realGuard = require('../sidecar/skills/guard.js');
  const { digestOf, makeSkillGate } = require('../sidecar/skills/gate.js');
  const { makePackageStore } = require('../sidecar/skills/package.js');
  const gate = makeSkillGate({ guard: realGuard });
  const edit = (s, b) => s.write({ agentId: 'a', name: 'Deploy', summary: 'deploy', body: b, createdBy: 'user' });
  const mirrorFixture = (name) => {
    const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'skills.jsonl');
    const faults = { append: 0, skillMd: 0 }, mdWrites = [];
    const pfs = Object.assign({}, fs, { writeFileSync(p, ...a) {
      if (/SKILL\.md$/.test(String(p))) {
        mdWrites.push(String(p));
        if (faults.skillMd > 0) { faults.skillMd--; throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); }
      }
      return fs.writeFileSync(p, ...a);
    } });
    const packageStore = makePackageStore({ fs: pfs, pathMod: path, root: path.join(dir, 'skill-packages'), now: () => 1 });
    const mk = () => {
      const real = makeSkillsIo({ fs, file, writeDurable: (f2, b) => writeFileDurable({ fs, path }, f2, b) });
      const io = Object.assign({}, real, { append(r) {
        if (faults.append > 0) { faults.append--; throw Object.assign(new Error('EPERM: skills.jsonl locked'), { code: 'EPERM' }); }
        return real.append(r);
      } });
      return makeSkillStore({ io, clock, packageStore, guard: realGuard, digest: digestOf });
    };
    const m = { faults, mdWrites, store: mk() };
    m.restart = () => { m.store = mk(); };
    m.delivered = () => { const v = m.store.viewAccessible('a', 'Deploy', {}); return (gate.verify(v).visible ? '' : 'WITHHELD ') + v.body; };
    m.run = () => { m.delivered(); m.store.markUsed('a', ['Deploy']); };
    m.onDisk = () => fs.readFileSync(path.join(packageStore.packageDir(m.store.view('a', 'Deploy', { bump: false, hydrate: false })), 'SKILL.md'), 'utf8');
    return m;
  };
  // 11a. an edit whose durable append failed is refused, so SKILL.md must not hold it either
  {
    const m = mirrorFixture('mirror-append');
    A.ok(edit(m.store, 'APPROVED: run deploy.sh').ok, 'mirror 11a: seeded');
    m.faults.append = 1;
    let threw = null; try { edit(m.store, 'REFUSED EDIT: run deploy.sh --force'); } catch (e) { threw = e; }
    A.ok(threw && /EPERM/.test(threw.message), 'mirror 11a: precondition: the edit whose append failed is refused');
    A.ok(!/REFUSED EDIT/.test(m.onDisk()), 'mirror 11a: the refused bytes never reach SKILL.md');
    A.eq(m.delivered(), 'APPROVED: run deploy.sh', 'mirror 11a: a run is given the stored body, not the refused edit');
    m.run();
    A.eq(m.delivered(), 'APPROVED: run deploy.sh', 'mirror 11a: and still after a run');
    m.restart();
    A.eq(m.delivered(), 'APPROVED: run deploy.sh', 'mirror 11a: and after a restart');
  }
  // 11b. an edit whose mirror write failed (EBUSY) is stored; the next use re-writes the mirror, so the next run sees it
  {
    const m = mirrorFixture('mirror-ebusy');
    A.ok(edit(m.store, 'OLD: push straight to main').ok, 'mirror 11b: seeded');
    m.faults.skillMd = 1;
    A.ok(edit(m.store, 'NEW: open a PR and wait for CI').ok, 'mirror 11b: the edit is stored (only its mirror write failed)');
    A.eq(m.faults.skillMd, 0, 'mirror 11b: precondition: the SKILL.md write did fail');
    A.eq(m.store.view('a', 'Deploy', { bump: false, hydrate: false }).body, 'NEW: open a PR and wait for CI', 'mirror 11b: precondition: the store holds the edit');
    m.run();   // this run still read the old mirror (trunk too); its run end repairs it
    A.eq(m.delivered(), 'NEW: open a PR and wait for CI', 'mirror 11b: the next run is given the edit');
    A.ok(/NEW: open a PR/.test(m.onDisk()), 'mirror 11b: and SKILL.md holds it');
  }
  // 11c. the same stale mirror across a restart (no use in between): the first use after the boot repairs it
  {
    const m = mirrorFixture('mirror-restart');
    A.ok(edit(m.store, 'OLD: push straight to main').ok, 'mirror 11c: seeded');
    m.faults.skillMd = 1;
    A.ok(edit(m.store, 'NEW: open a PR and wait for CI').ok, 'mirror 11c: the edit is stored');
    m.restart();
    m.run();
    A.eq(m.delivered(), 'NEW: open a PR and wait for CI', 'mirror 11c: a mirror left stale across a restart is repaired by the first use after it');
  }
  // 11d. the cost: a use of a skill this process already mirrored writes no package; after a boot, one write per skill
  {
    const m = mirrorFixture('mirror-cost');
    A.ok(edit(m.store, 'Read the README, then run the tests.').ok, 'mirror 11d: seeded');
    let n = m.mdWrites.length;
    for (let i = 0; i < 5; i++) m.run();
    A.eq(m.mdWrites.length - n, 0, 'mirror 11d: 5 uses of a skill mirrored by this process write no package');
    m.restart(); n = m.mdWrites.length;
    for (let i = 0; i < 5; i++) m.run();
    A.eq(m.mdWrites.length - n, 1, 'mirror 11d: after a restart only the first use re-writes the mirror');
  }
}

// ---- 10. the host wiring: skills.jsonl goes through skills-io, never the ledger's rotation or tail read ----
{
  const src = readSidecarSource();
  A.ok(/const skillsIo = makeSkillsIo\(\{ fs, file: SKILLS_FILE/.test(src), 'index.js builds skillsIo with makeSkillsIo');
  A.ok(!/(rotateJsonl|readBoundedJsonl|loadBounded|rotateIfLarge)\(\s*(\{[^}]*\}\s*,\s*)?SKILLS_FILE/.test(src), 'SKILLS_FILE is never rotated or tail-read');
  A.ok(/skillStore\.markUsed\(/.test(src), 'the run end still records uses');
}

// ---- 12. rollback safety: the live file never outgrows v0.13.5's read window between compactions ----
// v0.13.5 reads only the last 16 MiB (LOG_MAX_BYTES) of skills.jsonl and boot-compacts that partial view, so a live
// file past 16 MiB loses the skills at its head for good if the Commander downgrades. Real defaults (the host's
// SKILLS_COMPACT_BYTES is 4 MiB), sizes from an injected fs so no 16 MiB file is written.
{
  const MiB = 1024 * 1024, WINDOW_0135 = 16 * MiB;
  const sizes = {};
  const fakeFs = {
    statSync(f) { if (sizes[f] == null) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return { size: sizes[f] }; },
    unlinkSync() { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
  };
  const live = path.join(tmp, 'window', 'skills.jsonl');
  const mk = () => makeSkillsIo({ fs: fakeFs, file: live, writeDurable() {}, compactBytes: 4 * MiB });
  // a library of `bytes` made of records of `record` bytes (the io sizes its growth step from its largest record)
  const compactTo = (io, bytes, record) => {
    record = record || 64 * 1024;
    const rows = [];
    for (let left = bytes; left > 0; left -= record) rows.push({ name: 'x' + rows.length, body: 'y'.repeat(Math.max(0, Math.min(record, left) - 40)) });
    const total = rows.reduce((n, r) => n + JSON.stringify(r).length + 1, 0);   // ASCII: chars = bytes
    if (total < bytes) rows[rows.length - 1].body += 'y'.repeat(bytes - total);   // the compacted size is exactly `bytes`
    io.rewrite(rows); sizes[live] = bytes;
  };
  // the largest live size that does NOT ask for a compaction, after a compaction down to `lib` bytes
  const ceiling = (lib, record) => {
    const io = mk(); compactTo(io, lib, record);
    let lo = lib, hi = 64 * MiB;
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); sizes[live] = mid; if (io.needsCompaction()) hi = mid; else lo = mid; }
    return lo;
  };
  for (const lib of [0.5, 2, 5, 6, 8, 10, 11, 12].map(x => Math.round(x * MiB))) {
    A.ok(ceiling(lib) < WINDOW_0135, 'window: a ' + (lib / MiB) + ' MiB library is compacted before the live file reaches 0.13.5\'s 16 MiB window (ceiling ' + (ceiling(lib) / MiB).toFixed(2) + ' MiB)');
  }
  A.eq(ceiling(1 * MiB), 4 * MiB, 'window: a small library keeps the 4 MiB threshold');
  A.eq(ceiling(3 * MiB), 6 * MiB, 'window: hysteresis (2x the compacted size) is unchanged below the cap');
  // a library over the cap that still fits the window: compacted once per growth step, never on every write
  for (const lib of [12.5, 13, 14.5].map(x => Math.round(x * MiB))) {
    const io = mk(); compactTo(io, lib);
    A.ok(!io.needsCompaction(), 'window: right after compacting a ' + (lib / MiB) + ' MiB library, the next write does not compact again');
    sizes[live] = lib + 64 * 1024;
    A.ok(!io.needsCompaction(), 'window: nor after 64 KiB of appends (' + (lib / MiB) + ' MiB library)');
    const c = ceiling(lib);
    A.ok(c - lib >= 512 * 1024 && c <= WINDOW_0135, 'window: a ' + (lib / MiB) + ' MiB library is re-compacted after a bounded growth step, inside the window (' + ((c - lib) / MiB).toFixed(2) + ' MiB, ceiling ' + (c / MiB).toFixed(2) + ')');
  }
  // a library that cannot stay inside the window (its compacted size plus a growth step is past 16 MiB, or its records are
  // so large that a step of a few of them is): rewriting it buys no rollback safety, so the plain hysteresis applies and
  // a write never pays a full rewrite of the library (lane review: 1.1 MiB records over 13.5 MiB compacted on 10 of 10)
  for (const [lib, record] of [[15.5, 0.0625], [20, 0.0625], [13.5, 1.13], [12.5, 1.1], [11.5, 1.13]].map(p => [Math.round(p[0] * MiB), Math.round(p[1] * MiB)])) {
    const c = ceiling(lib, record);
    A.ok(c >= 2 * lib - 1, 'window: a ' + (lib / MiB) + ' MiB library of ' + (record / MiB).toFixed(2) + ' MiB records keeps the 2x hysteresis (ceiling ' + (c / MiB).toFixed(2) + ' MiB)');
  }
  // after a restart (no compaction yet in this process) the boot threshold is the plain 4 MiB
  const fresh = mk(); sizes[live] = 4 * MiB + 1;
  A.ok(fresh.needsCompaction(), 'window: a fresh boot compacts a live file past 4 MiB');
}

// ---- 13. large records over a large library: a write never rewrites the whole file each time (real fs) ----
// The reviewer's case: a ~12.5 MiB library whose records are ~1.1 MiB (a few imported packages: packageFiles AND files
// are stored base64), one skill patched 10 times. Each patch appends ~1.1 MiB; the old growth step (1 MiB) asked for a
// full fsync'd rewrite of the whole library after EVERY one of them.
{
  const MiB = 1024 * 1024;
  const dir = path.join(tmp, 'big-records'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'skills.jsonl');
  let rewrites = 0;
  const io = makeSkillsIo({ fs, file, writeDurable: (f2, b) => { rewrites++; writeFileDurable({ fs, path }, f2, b); } });
  const rec = (name, n) => ({ name, agentId: 'a', body: String.fromCharCode(97 + (n % 26)).repeat(Math.round(1.1 * MiB)) });
  const library = [];
  for (let i = 0; i < 11; i++) library.push(rec('pkg-' + i, i));
  io.rewrite(library);
  rewrites = 0;
  const startSize = fs.statSync(file).size;
  A.ok(startSize > 12 * MiB && startSize < 13 * MiB, 'big records: precondition: a ' + (startSize / MiB).toFixed(2) + ' MiB library of 1.1 MiB records');
  let latest = library.slice(), compactions = 0;
  for (let n = 1; n <= 10; n++) {
    const next = rec('pkg-0', n);
    io.append(next);
    latest = [next].concat(latest.slice(1));
    if (io.needsCompaction()) { compactions++; io.rewrite(latest); }
  }
  A.ok(compactions <= 1, 'big records: 10 patches of a 1.1 MiB record rewrite the whole library at most once (' + compactions + ')');
  A.eq(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length > 0, true, 'big records: the file still reads');
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
A.report('skills-io.test');
