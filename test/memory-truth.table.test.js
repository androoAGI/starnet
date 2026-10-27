/* node test/memory-truth.table.test.js — memory-truth-1027: ONE similarity, ONE subject key, and a contradicted memory
   retired deterministically and reversibly by every writer.

   The 10-26 audit found six hand-copied Jaccard functions and no notion of a belief's SUBJECT: a same-polarity
   correction ("prefers light mode" after "prefers dark mode") was refused as a near-duplicate by reflection, saved
   beside the old belief by notebook.write, and added as a second active record by trusted capture (f97e73fb class);
   and two different facts that share a shape ("the staging db is in frankfurt" / "the production db is in frankfurt")
   were challenged or dropped as restatements. This table drives the same beliefs through every writer:
     1. one similarity: no memory writer keeps its own Jaccard copy (mint-ledger and priorwork pass their own stoplist)
     2. the subject key itself (MemTruth.claimOf / relate): dupe · supersede · distinct · unknown */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { sidecarSourceFiles } = require('./helpers/source');
const MemTruth = require('../frontend/app/memtruth.js');

/* ---------- 1. ONE similarity function ---------- */
{
  const JACCARD = /inter\s*\/\s*\(\s*A\.size\s*\+\s*B\.size\s*-\s*inter\s*\)/;   // the hand-copied formula
  const files = sidecarSourceFiles();
  const writers = ['sidecar/memcore.js', 'sidecar/reflect.js', 'sidecar/tools/builtin/notebook.js', 'sidecar/failreview.js', 'sidecar/mint-ledger.js', 'sidecar/priorwork.js'];
  for (const rel of writers) {
    const f = files.find(x => x.rel === rel);
    A.ok(!!f, rel + ' exists');
    if (!f) continue;
    A.ok(!JACCARD.test(f.text), rel + ' keeps no Jaccard copy of its own');
    A.ok(/memtruth\.js'\)/.test(f.text), rel + ' imports the shared memtruth module');
  }
  const study = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'study.js'), 'utf8');
  A.ok(!JACCARD.test(study) && /require\('\.\/memtruth\.js'\)/.test(study) && /root\.MemTruth/.test(study), 'study.js (browser + sidecar) reads the same module, via the UMD root in the browser');
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  const mt = html.indexOf('<script src="app/memtruth.js">'), st = html.indexOf('<script src="app/study.js">');
  A.ok(mt > 0 && st > mt, 'index.html loads memtruth.js before study.js');
  const memtruthText = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'memtruth.js'), 'utf8');
  A.ok(JACCARD.test(memtruthText), 'the formula lives once, in memtruth.js');

  // the shared function is the old one, byte for byte in behaviour, and takes a caller's own stoplist
  A.eq(MemTruth.similarity('the user prefers npm start', 'prefers npm start over serve'), 0.5, 'Jaccard over 3+ char tokens, stopwords dropped');
  A.eq(MemTruth.similarity('', 'anything'), 0, 'an empty side is never similar');
  A.eq(require('../sidecar/memcore.js').tokenJaccard('alpha beta gamma', 'alpha beta delta'), 0.5, 'memcore.tokenJaccard delegates');
  const ML = require('../sidecar/mint-ledger.js');
  A.ok(ML.isDup('ULTRON daily operating loop', 'Ultron operating loop'), 'mint-ledger keeps its own stoplist (daily) as a parameter');
  A.ok(!ML.isDup('Morning news digest', 'Evening build check'), 'mint-ledger: unrelated names stay apart');
  const PW = require('../sidecar/priorwork.js');
  A.eq(PW.similarity('Improved parkour prototypes v2', 'parkour prototype'), 1, 'priorwork keeps its own stoplist and stemmer');
}

/* ---------- 2. the subject key ---------- */
{
  const key = t => MemTruth.subjectKey(t);
  A.eq(key('User prefers dark mode'), key('The user prefers a light theme'), 'dark/light: one subject (the theme)');
  A.eq(key('User prefers tabs for indentation'), key('From now on, always use spaces instead of tabs for indentation.'), 'tabs/spaces: a note and an order share the subject');
  A.eq(key('User prefers tabs'), key('User now prefers spaces'), 'bare tabs/spaces: one subject');
  A.ok(key('The staging database is in Frankfurt') !== key('The production database is in Frankfurt'), 'staging/production: two subjects');
  A.eq(key('The staging DB lives in the Virginia region'), key('The staging database is in Frankfurt'), 'an abbreviation is the same subject');
  for (const t of ['User prefers Python', 'The user is a designer', 'User likes it when replies are short', 'Project uses React for the frontend',
    'staging deploys from the release branch', 'Is the user on Windows?', 'User prefers tabs. They hate spaces.']) {
    A.eq(key(t), null, 'no confident subject, no key: ' + t);
  }
  const rel = (a, b) => MemTruth.relate(a, b);
  const TABLE = [
    ['User prefers dark mode', 'The user prefers a light theme', 'supersede'],
    ['User prefers tabs for indentation', 'User prefers spaces over tabs for indentation', 'supersede'],
    ['User prefers tabs for indentation', 'Always use spaces for indentation.', 'supersede'],
    ['User prefers tabs', 'User hates tabs', 'supersede'],
    ['User prefers rounded purple cards for Acme website design', 'User does not prefer rounded purple cards for Acme website design', 'supersede'],
    ['The staging database is in Frankfurt', 'The staging DB lives in the Virginia region', 'supersede'],
    ['The default branch is main', 'The default branch is develop', 'supersede'],
    ['User prefers concise replies', 'User prefers detailed replies', 'supersede'],
    ['The staging database is in Frankfurt', 'The production database is in Frankfurt', 'distinct'],
    ['the staging database lives in the frankfurt region', 'the production database lives in the frankfurt region', 'distinct'],
    ['User prefers dark mode', 'User prefers tabs', 'distinct'],
    ['User prefers concise replies', 'User prefers short concise replies', 'dupe'],
    ['The staging database is in Frankfurt', 'the staging database lives in the frankfurt region', 'dupe'],
    ['Always use spaces for indentation.', 'User prefers spaces for indentation', 'dupe'],
    // free-text topics never decide 'distinct': one belief worded twice stays on the similarity path
    ['the Commander prefers npm start over npm run serve', 'Commander prefers to run npm start rather than npm run serve', 'unknown'],
    ['User prefers Python', 'User prefers Go', 'unknown'],
    ['User drafts posts in Notion', 'User now drafts posts in Obsidian', 'unknown']
  ];
  for (const [a, b, want] of TABLE) {
    A.eq(rel(a, b), want, want + ': «' + a + '» vs «' + b + '»');
    A.eq(rel(b, a), want, '…and the verdict is symmetric');
  }
}

/* ---------- 3. notebook.write: one active record per subject, the old text in its history ---------- */
const NB = require('../sidecar/tools/builtin/notebook.js');
const { makeNotebookTools, supersedeRecords, restoreSuperseded } = NB;
function notebook(seed) {
  const data = { 'notebook:agent': seed ? JSON.parse(JSON.stringify(seed)) : undefined };
  let now = Date.UTC(2026, 9, 27, 12);
  const receipts = [];
  const t = makeNotebookTools({ store: { get: k => data[k], set: (k, v) => { data[k] = v; } }, clock: { now: () => (now += 1000) }, onSaved: (aid, runId, item) => receipts.push(item) });
  const write = (args, ctx) => t.writeTool.run(args, Object.assign({ agentId: 'agent', runId: 'r_' + (receipts.length + 1) }, ctx || {}));
  const notes = () => data['notebook:agent'] || [];
  const active = () => notes().map(n => n.body);
  return { write, notes, active, receipts };
}
const NOTE_TABLE = [
  { name: 'dark/light', first: 'User prefers dark mode', second: 'The user prefers a light theme', one: true },
  { name: 'tabs/spaces', first: 'User prefers tabs for indentation', second: 'User prefers spaces over tabs for indentation', one: true },
  { name: 'staging db moved', first: 'The staging database is in Frankfurt', second: 'The staging DB lives in the Virginia region', one: true },
  { name: 'staging/production db', first: 'The staging database is in Frankfurt', second: 'The production database is in Frankfurt', one: false },
  { name: 'theme vs indentation', first: 'User prefers dark mode', second: 'User prefers tabs', one: false }
];
(async () => {
  for (const row of NOTE_TABLE) {
    const nb = notebook();
    await nb.write({ title: row.name, body: row.first });
    const r = await nb.write({ title: row.name, body: row.second });
    if (row.one) {
      A.eq(nb.active(), [row.second], row.name + ': exactly ONE active record, holding the newer claim');
      const rec = nb.notes()[0];
      A.ok(rec.id === 'note_1' && rec.history.length === 1 && rec.history[0].body === row.first, row.name + ': the old text is in its history');
      A.ok(rec.history[0].supersession && rec.history[0].supersession.by === 'subject' && rec.history[0].snapshot && rec.history[0].snapshot.id === 'note_1', row.name + ': with a supersession receipt and the provenance it had');
      A.ok(/same subject/.test(r.content) && r.content.indexOf(row.first) >= 0 && /distinct:true/.test(r.content), row.name + ': the tool result names what it retired and how to restore it');
      const receipt = nb.receipts[nb.receipts.length - 1];
      A.ok(receipt.revised === true && receipt.superseded[0].id === 'note_1' && receipt.superseded[0].previous === row.first, row.name + ': the COMMS receipt reads as an update (no forget button) and names the retired text');
    } else {
      A.eq(nb.active(), [row.first, row.second], row.name + ': two DIFFERENT facts stay two active records');
      A.ok(/^Saved note/.test(r.content) && !/already remember|Similar notes/.test(r.content), row.name + ': saved outright, no challenge, no "may replace" tail');
    }
  }
  // flip back: the archived text may win again, still one active record
  {
    const nb = notebook();
    await nb.write({ title: 'Indent', body: 'User prefers tabs for indentation' });
    await nb.write({ title: 'Indent', body: 'User prefers spaces for indentation' });
    await nb.write({ title: 'Indent', body: 'User prefers tabs for indentation' });
    A.eq(nb.active(), ['User prefers tabs for indentation'], 'flip back: the earlier claim wins again (an archived text no longer blocks it)');
    A.eq(nb.notes()[0].history.map(h => h.body), ['User prefers tabs for indentation', 'User prefers spaces for indentation'], 'and both earlier texts stay in history');
  }
  // legacy duplicates: two records already on one subject collapse into one
  {
    const nb = notebook([
      { id: 'note_1', kind: 'note', scope: 'global', title: 'Theme', body: 'User prefers dark mode', createdAt: 1, pinned: true },
      { id: 'note_2', kind: 'note', scope: 'global', title: 'Theme', body: 'User likes the dark theme', createdAt: 2 }
    ]);
    await nb.write({ title: 'Theme', body: 'User prefers light mode' });
    A.eq(nb.active(), ['User prefers light mode'], 'two legacy same-subject records collapse into ONE active record');
    const rec = nb.notes()[0];
    A.ok(rec.id === 'note_2' && rec.pinned === true, 'the newest survives under its own id, and a folded copy\'s pin is not dropped');
    A.eq(rec.history.map(h => h.body).sort(), ['User likes the dark theme', 'User prefers dark mode'], 'every retired text is in its history');
  }
  // the Commander's own words: the superseding record carries their authority
  {
    const nb = notebook();
    await nb.write({ title: 'Theme', body: 'User prefers dark mode' });
    await nb.write({ title: 'Theme', body: 'User prefers light mode' }, { commanderWords: 'Actually I prefer light mode now.' });
    const rec = nb.notes()[0];
    A.ok(rec.confirmation === 'user-stated' && rec.statedBy && /light mode/.test(rec.statedBy.quote), 'a supersession in the Commander\'s proven words is recorded as theirs');
    const nb2 = notebook();
    await nb2.write({ title: 'Theme', body: 'User prefers dark mode' });
    await nb2.write({ title: 'Theme', body: 'User prefers light mode' });
    A.eq(nb2.notes()[0].confirmation, 'inferred', 'an unproven one stays the agent\'s inference ([corrected, unconfirmed] in recall)');
  }
  // never on a tainted run, never on distinct:true, never across a project boundary
  {
    const nb = notebook();
    await nb.write({ title: 'Theme', body: 'User prefers dark mode' });
    await nb.write({ title: 'Theme', body: 'User prefers light mode' }, { connectorAuthority: { taintedBy: () => 'web page https://x.example' } });
    A.ok(nb.active().indexOf('User prefers dark mode') >= 0 && !(nb.notes()[0].history || []).length, 'a tainted run never retires the Commander\'s memory (it gets the challenge path)');
    const nb2 = notebook();
    await nb2.write({ title: 'Theme', body: 'User prefers dark mode' });
    await nb2.write({ title: 'Theme', body: 'User prefers light mode', distinct: true });
    A.eq(nb2.active(), ['User prefers dark mode', 'User prefers light mode'], 'distinct:true: the model judged it separate, both stay');
    const nb3 = notebook([{ id: 'note_1', kind: 'note', scope: 'stream', streamId: 's1', projectRoot: 'C:/Work/A', title: 'Theme', body: 'User prefers dark mode', createdAt: 1 }]);
    await nb3.write({ title: 'Theme', body: 'User prefers light mode' }, { streamId: 's2', projectRoot: 'C:/Work/B' });
    A.eq(nb3.active(), ['User prefers dark mode', 'User prefers light mode'], 'a record in another project is never retired from this one');
  }
  // UNDO: re-saving a retired text with distinct:true restores it as its own record, with the provenance it had
  {
    const nb = notebook([{ id: 'note_1', kind: 'note', scope: 'global', title: 'DB', body: 'The staging database is in Frankfurt', createdAt: 5, confirmation: 'user-confirmed', origin: 'commander' }]);
    await nb.write({ title: 'DB', body: 'The staging DB lives in the Virginia region' });
    A.eq(nb.active(), ['The staging DB lives in the Virginia region'], '(the move retired the Frankfurt fact)');
    const r = await nb.write({ title: 'DB', body: 'The staging database is in Frankfurt', distinct: true });
    A.eq(nb.active(), ['The staging DB lives in the Virginia region', 'The staging database is in Frankfurt'], 'undo: the retired fact is active again, beside the newer one');
    const back = nb.notes()[1];
    A.ok(back.confirmation === 'user-confirmed' && back.createdAt === 5 && back.restoredFrom && back.restoredFrom.id === 'note_1', 'restored with the provenance it had (your confirmation, its original date), and where it came from');
    A.ok(nb.notes()[0].history[0].restoredAs === back.id, 'the history entry it came from says it was restored');
    A.ok(/Restored as its own active note/.test(r.content), 'the tool result says so');
    const again = await nb.write({ title: 'DB', body: 'The staging database is in Frankfurt', distinct: true });
    A.ok(/already remember/.test(again.content) || nb.active().filter(b => b === 'The staging database is in Frankfurt').length === 1, 'a second restore never duplicates it');
  }
  /* ---------- 4. trusted capture and the Keep verdict: the host's own writer (sidecar/index.js, executed) ---------- */
  {
    const vm = require('vm');
    const { readSidecarSource } = require('./helpers/source');
    const L = require('../sidecar/trusted-learning.js'), context = require('../sidecar/context.js'), reflectMod = require('../sidecar/reflect.js'), memcore = require('../sidecar/memcore.js');
    const NB = require('../sidecar/tools/builtin/notebook.js');
    const src = readSidecarSource();
    const start = src.indexOf('async function captureTrustedLearning('), end = src.indexOf('async function appendDeclined(', start);
    A.ok(start > 0 && end > start, 'extract the actual capture + writer from the sidecar');
    const station = seed => {
      const stores = { 'notebook:nova': seed ? JSON.parse(JSON.stringify(seed)) : undefined }, receipts = [], status = {};
      let clock = Date.parse('2026-10-27T12:00:00Z');
      const sandbox = { TrustedLearning: L, highStakes: reflectMod.highStakes, redact: context.redact, recordFromProposal: reflectMod.recordFromProposal,
        reviseRecord: NB.reviseRecord, supersedeRecords: NB.supersedeRecords, supersessionTargets: NB.supersessionTargets, memcore,
        personalizationStore: { read: () => ({ enabled: true }) }, memoryConfig: { reflectEnabled: true }, buildDeclinedIndex: () => ({ has: () => false }),
        notebookStore: { update: async (key, fn) => { const next = fn(stores[key]); if (next !== undefined) stores[key] = next; } },
        recordRunReceipt: (a, r, item) => receipts.push(item), stashProposals: () => {}, queuePending: async () => {},
        chanEmit: () => {}, hookSpine: { invoke() {} }, QuestSweeps: { learnedFactKeys: () => [] }, questStore: { openForAgent: () => [] },
        skillEvaluationIo: { get: k => status[k], set: (k, v) => { status[k] = v; } }, failNote: (w, e) => { throw e; }, swallow: () => () => {},
        skillStore: {}, skillNameFromReflection: s => s, console: { log() {}, warn() {} }, Date: class extends Date { static now() { return (clock += 1000); } } };
      const api = vm.runInNewContext(src.slice(start, end) + '\n({ captureTrustedLearning, writeMemoryRecord })', sandbox);
      const say = (content, runId) => api.captureTrustedLearning({ agentId: 'nova', runId, projectRoot: '', input: { source: 'interactive-owner', content },
        learningEvidence: L.evidence({ runId, trustedInput: { source: 'interactive-owner', content } }) });
      const notes = () => stores['notebook:nova'] || [];
      return { api, say, notes, active: () => context.activeMemoryRecords(notes()).map(r => r.content != null ? r.content : r.body), receipts };
    };
    const SAID = [
      { name: 'dark/light', first: 'From now on, always use dark mode.', second: 'From now on, always use light mode.', one: true },
      { name: 'tabs/spaces', first: 'Always use tabs for indentation.', second: 'From now on, use spaces instead of tabs for indentation.', one: true },
      { name: 'staging/production db', first: 'Always use the Frankfurt region for the staging database.', second: 'Always use the Frankfurt region for the production database.', one: false }
    ];
    for (const row of SAID) {
      const st = station();
      await st.say(row.first, 'c1'); await st.say(row.second, 'c2');
      if (row.one) {
        A.eq(st.active(), [row.second], 'trusted capture, ' + row.name + ': exactly ONE active record, holding the newer statement');
        const rec = st.notes()[0];
        A.ok(rec.history.length === 1 && rec.history[0].body === row.first && rec.history[0].supersession, 'trusted capture, ' + row.name + ': the old statement is in its history with a receipt');
        A.ok(rec.confirmation === 'user-stated' && rec.statedBy.runId === 'c2', 'trusted capture, ' + row.name + ': the survivor is the Commander\'s words, stated now');
        A.ok(st.receipts.some(p => p.revised === true && p.superseded && p.superseded[0].previous === row.first), 'trusted capture, ' + row.name + ': its COMMS receipt reads as an update naming the retired text');
      } else {
        A.eq(st.active(), [row.first, row.second], 'trusted capture, ' + row.name + ': two different facts stay two active records');
      }
    }
    // across writers: the Commander's statement retires the agent's own note on the same subject
    {
      const st = station([{ id: 'note_1', kind: 'note', scope: 'global', title: 'Theme', body: 'User prefers dark mode', createdAt: 1, origin: 'commander', confirmation: 'inferred' }]);
      await st.say('From now on, always use light mode.', 'c3');
      A.eq(st.active(), ['From now on, always use light mode.'], 'trusted capture retires a notebook.write note on the same subject');
      A.eq(st.notes()[0].history[0].body, 'User prefers dark mode', '…which stays in history');
    }
    // the Keep verdict on a reviewed proposal retires the belief it contradicts; a model's silent save never does
    {
      const seed = [{ id: 'note_1', kind: 'profile', scope: 'global', title: 'Preference', content: 'User prefers dark mode', body: 'User prefers dark mode', createdAt: 1 }];
      const kept = station(seed);
      const w = await kept.api.writeMemoryRecord('nova', { kind: 'profile', content: 'User prefers light mode', scope: 'global' }, { runId: 'k1', source: 'turn-in', userConfirmed: true, trustDelta: 2 });
      A.ok(w.ok && w.superseded && w.superseded[0].id === 'note_1', 'a Keep supersedes: ' + JSON.stringify(w));
      A.eq(kept.active(), ['User prefers light mode'], 'Keep: ONE active record');
      A.eq(kept.notes()[0].confirmation, 'user-confirmed', 'Keep: the survivor carries the Commander\'s approval');
      const silent = station(seed);
      await silent.api.writeMemoryRecord('nova', { kind: 'profile', content: 'User prefers light mode', scope: 'global' }, { runId: 's1', source: 'reflection' });
      A.eq(silent.notes()[0].content, 'User prefers dark mode', 'a model\'s silent save retires nothing (reflection sends a same-subject claim to review instead)');
    }
  }

  /* ---------- 5. reflect(): a same-subject claim becomes a reviewed REPLACEMENT; a different fact is proposed ---------- */
  {
    const { reflect } = require('../sidecar/reflect.js');
    const run = { runId: 'rf', messages: [{ role: 'user', content: 'x'.repeat(50) }, { role: 'assistant', content: 'y'.repeat(200) }] };
    const say = async (existing, line) => (await reflect(run, { existing, propose: async () => line })).proposals;
    const dark = [{ id: 'note_1', kind: 'profile', title: 'Preference', content: 'User prefers dark mode', body: 'User prefers dark mode', scope: 'global', createdAt: 1 }];
    let p = await say(dark, 'PREFERENCE: The user prefers a light theme');
    A.ok(p.length === 1 && p[0].replaceId === 'note_1' && p[0].previousBody === 'User prefers dark mode', 'reflect, dark/light: the new claim is a REPLACEMENT of note_1 for review (it was a second active belief): ' + JSON.stringify(p));
    const tabs = [{ id: 'note_4', kind: 'profile', content: 'User prefers tabs for indentation', body: 'User prefers tabs for indentation', scope: 'global', createdAt: 1 }];
    p = await say(tabs, 'PREFERENCE: User prefers spaces for indentation');
    A.ok(p.length === 1 && p[0].replaceId === 'note_4', 'reflect, tabs/spaces: a same-polarity correction is a replacement, never dropped as a near-duplicate');
    const staging = [{ id: 'note_2', kind: 'fact', content: 'the staging database lives in the frankfurt region', body: 'the staging database lives in the frankfurt region', scope: 'global', createdAt: 1 }];
    p = await say(staging, 'FACT: the production database lives in the frankfurt region');
    A.ok(p.length === 1 && !p[0].replaceId && /production/.test(p[0].content), 'reflect, staging/production: the different fact is PROPOSED (it was dropped as a near-duplicate)');
    p = await say(staging, 'FACT: The staging DB is in Frankfurt');
    A.eq(p.length, 0, 'reflect: the same claim in other words is a restatement, dropped');
    p = await say([{ content: 'User prefers dark mode' }], 'PREFERENCE: The user prefers the dark theme');
    A.eq(p.length, 0, 'reflect: a declined belief worded again stays declined');
    // the reviewed replacement, Kept, leaves one active record with the old text in its history
    const st2 = [{ id: 'note_1', kind: 'profile', title: 'Preference', content: 'User prefers dark mode', body: 'User prefers dark mode', scope: 'global', createdAt: 1 }];
    const prop = (await say(st2, 'PREFERENCE: The user prefers a light theme'))[0];
    const rec = NB.reviseRecord(st2[0], { previousBody: prop.previousBody, body: prop.content, runId: 'keep', userConfirmed: true }, 5);
    A.ok(rec.content === 'The user prefers a light theme' && rec.history[0].body === 'User prefers dark mode', 'reflect → Keep: one active record, the old text in its history');
  }

  // the pure helpers the host's own writer reuses
  {
    const list = [{ id: 'note_1', body: 'User prefers dark mode', createdAt: 1 }, { id: 'note_2', body: 'User prefers tabs', createdAt: 2 }];
    const out = supersedeRecords(list, [list[0]], { body: 'User prefers light mode', runId: 'r9', key: 'user|pref|alt:theme', source: 'test' }, 99);
    A.ok(out.list.length === 2 && out.record.body === 'User prefers light mode' && out.record.history[0].supersession.runId === 'r9', 'supersedeRecords: pure, one survivor, receipt on the history entry');
    A.eq(restoreSuperseded(out.list, 'User prefers tabs', 100, 'note_3'), null, 'restoreSuperseded never resurrects text that was not retired by a supersession');
  }
  A.report('memory-truth.table');
})().catch(e => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
