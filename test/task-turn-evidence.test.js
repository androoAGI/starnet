/* node test/task-turn-evidence.test.js — a briefed task turn copies the run history and the transcript ONCE, and the
   station epoch is not re-parsed out of the save on every read.

   The bug (perf review 10-19, index.js task-turn evidence): one briefed task turn ran standingWorkNotice (the brief proof:
   transcriptStore.all() + runStore.all(), then runs: runStore.all() again, plus a whole-save parse for the epoch) and
   commanderEvidenceContext -> nightshiftContextPack (clean owner chats: transcript + runs, brief proof: transcript +
   runs). That is 4 run-history copies, 3 transcript copies and a save parse per turn: 22 / 40 / 115 ms at 1k / 5k / 10k
   runs.

   Drives the REAL host functions sliced out of sidecar/index.js (evidenceRows, stationEpoch, nightshiftRecentRuns,
   nightshiftContextPack, commanderEvidenceInputs, commanderEvidenceContext, standingWorkNotice) with counting stores:
     (1) the turn's sequence copies each store once and produces the SAME notice + context as separate copies did;
     (2) a context pack built without a caller snapshot still shares one copy between its two proofs;
     (3) stationEpoch parses the save once while its stamp holds, re-reads when it moves, never keeps an unstamped read;
     (4) the runOnceCore task-turn site hands ONE snapshot to both;
     (5) the REAL flow over the REAL savestore: the desk persists (POST /api/save, debounced) between every two task
         turns, which moves the stamp every time — so the stamp memo alone re-parsed the save on every turn. The save
         handler seeds the memo from the doc it just stored (seedSaveMemos): 0 parses per turn, a new generation is read
         at once, a refused save seeds nothing, an outside edit is still read. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { makeSaveStore } = require('../sidecar/savestore.js');
const { fnBody } = require('./_fnbody.js');
const TrustedLearning = require('../sidecar/trusted-learning.js');
const W = require('../sidecar/workflow-takeover.js');
const CP = require('../sidecar/contextpack.js');
const CC = require('../sidecar/commander-context.js');

const src = readSidecarSource();
const names = ['function evidenceRows(ev)', 'function stationEpoch()', 'function nightshiftRecentRuns()', 'function nightshiftContextPack(evidence)',
  'function commanderEvidenceInputs(evidence)', 'function commanderEvidenceContext(existingSystem, extra, evidence)', 'function standingWorkNotice(brief, agentId, o, evidence)'];
const bodies = names.map(n => fnBody(src, n));
bodies.forEach((b, i) => A.ok(b.startsWith(names[i]) && b.length < 12000, 'sliced exactly ' + names[i]));

const DAY = 86400000, now = 1800000000000, PROJECT = '/fixture/project-a', TEXT = 'Prepare the weekly sales report';
function fixture() {
  const briefs = [0, 1, 2].map(i => ({ id: 'owned-b' + i, runId: 'finished-r' + i, originalRunId: 'original-r' + i,
    agentId: 'agent', streamId: 'owner-stream-' + i, source: 'interactive', status: 'done',
    originalDirective: TEXT, completedAt: now - (4 - i) * DAY }));
  const runs = briefs.map(b => ({ runId: b.runId, agentId: b.agentId, streamId: b.streamId, reason: 'done', toolsOk: 1, projectRoot: PROJECT, internal: false, title: 'run ' + b.runId, ts: b.completedAt }))
    .concat(briefs.map(b => ({ runId: b.originalRunId, agentId: b.agentId, streamId: b.streamId, reason: 'done', toolsOk: 0, projectRoot: PROJECT, internal: false, ownerDirective: true, title: TEXT, ts: b.completedAt - 1000 })));
  const rows = briefs.map((b, i) => ({ agentId: b.agentId, streamId: b.streamId, role: 'user', content: TEXT, ts: b.completedAt - 1000, sourceRunId: 'original-r' + i, taintKnown: true, taint: '' }));
  return { briefs, runs, rows };
}
function host(saveImpl) {
  const h = fixture();
  const c = { runsAll: 0, transcriptAll: 0, saveReads: 0 };
  const save = saveImpl || { stamp: () => 's1', doc: { agent: { createdAt: 5 } } };
  const sandbox = {
    WorkflowTakeover: W, TrustedLearning, CommanderContext: CC, redact: s => s, console,
    Date: class extends Date { static now() { return now; } },
    personalizationStore: { read: () => ({ enabled: true }) },
    saveStore: {
      load: () => { c.saveReads++; return save.doc; },
      stamp: () => save.stamp(),
      loadStamped: () => { c.saveReads++; return { doc: save.doc, stamp: save.stamp() }; }
    },
    taskBriefStore: { list: opts => h.briefs.slice(0, (opts && opts.limit) || 500) },
    transcriptStore: { all: () => { c.transcriptAll++; return h.rows.map(r => Object.assign({}, r)); } },
    runStore: { all: () => { c.runsAll++; return h.runs.map(r => Object.assign({}, r)); }, list: () => h.runs.slice() },
    cronJobs: [], growthRatings: { list: () => [] },
    workflowTakeoverStore: { read: () => ({ v: 1, decisions: [] }), decide: () => Promise.resolve(true) },
    commanderGoals: { get: () => null }, autonomyLedger: { list: () => [] }, nightshiftBeliefMap: () => ({}),
    Recommendation: { preferenceTallies: () => ({}) }, nightshiftPreferenceWeights: () => ({}),
    stationTrackRecordLines: () => [], threadsStore: { openThreads: () => [] }, contextpack: CP,
    Interests: { summary: () => [] }, interestsState: {}, scoutState: { context: {} },
    recommendationLedger: { summary: () => null }, commanderDossier: { get: () => ({}) }
  };
  const api = vm.runInNewContext("let _stationEpochMemo = { stamp: '', epoch: 1 };\n" + bodies.join('\n') +
    '\n({ evidenceRows, stationEpoch, nightshiftContextPack, commanderEvidenceContext, standingWorkNotice })', sandbox);
  return { api, c, h, save };
}
const brief = { id: 'current-brief', source: 'interactive', status: 'ready', agentId: 'agent', streamId: 'current-stream', originalDirective: TEXT };

// ---- (1) the task turn ----
{
  const { api, c } = host();
  const turnEvidence = {};
  const notice = api.standingWorkNotice(brief, 'agent', { projectRoot: PROJECT }, turnEvidence);
  const inputs = { brief, standingWork: notice };
  const ctx = api.commanderEvidenceContext('', inputs, turnEvidence);
  A.eq(c.runsAll, 1, 'one run-history copy per task turn (was 4)');
  A.eq(c.transcriptAll, 1, 'one transcript copy per task turn (was 3)');
  A.ok(notice && notice.count === 4, 'the repeat-work notice is still found from the shared snapshot');
  A.ok(/The Commander has now asked/.test(ctx), 'and it reaches the composed context');
  // the same turn with SEPARATE copies (no shared snapshot) yields the identical notice + context
  const sep = host();
  const n2 = sep.api.standingWorkNotice(brief, 'agent', { projectRoot: PROJECT });
  const ctx2 = sep.api.commanderEvidenceContext('', { brief, standingWork: n2 });
  A.eq(JSON.stringify(n2), JSON.stringify(notice), 'the shared snapshot produces the same notice as separate copies');
  A.eq(ctx2, ctx, 'and the same composed context');
}

// ---- (2) a pack without a caller snapshot ----
{
  const { api, c } = host();
  api.nightshiftContextPack();
  A.eq(c.runsAll, 1, 'a stand-alone context pack copies the run history once for both proofs (was 2)');
  A.eq(c.transcriptAll, 1, 'and the transcript once (was 2)');
}

// ---- (3) stationEpoch ----
{
  let stamp = 's1';
  const save = { stamp: () => stamp, doc: { agent: { createdAt: 4242 } } };
  const { api, c } = host(save);
  A.eq(api.stationEpoch(), 4242, 'the epoch is the save agent.createdAt');
  A.eq(api.stationEpoch(), 4242, 'and again');
  A.eq(c.saveReads, 1, 'the save is parsed once while its stamp holds');
  stamp = 's2'; save.doc = { agent: { createdAt: 9001 } };
  A.eq(api.stationEpoch(), 9001, 'a moved stamp (a save, a new station) re-reads at once');
  A.eq(c.saveReads, 2, 'with exactly one more parse');
  stamp = ''; save.doc = { agent: { createdAt: 7 } };
  api.stationEpoch(); api.stationEpoch();
  A.eq(c.saveReads, 4, 'an unstamped read (absent/locked/.bak-recovered save) is never kept');
  stamp = 's3'; save.doc = null;
  A.eq(api.stationEpoch(), 1, 'no save -> epoch 1, exactly as before');
}

// ---- (4) the runOnceCore wiring ----
{
  const site = src.slice(src.indexOf('const turnEvidence = {};'), src.indexOf('const turnEvidence = {};') + 600);
  A.ok(/standingWorkNotice\(taskBrief, agentId, o, turnEvidence\)/.test(site), 'the task turn hands its snapshot to the repeat-work notice');
  A.ok(/commanderEvidenceContext\(system \|\| '', taskContextInputs, turnEvidence\)/.test(site), 'and the same snapshot to the context pack');
  const notice = fnBody(src, 'function standingWorkNotice(brief, agentId, o, evidence)');
  A.ok(!/runStore\.all\(\)|transcriptStore\.all\(\)|saveStore\.load\(/.test(notice), 'the notice reads no store copy or save parse of its own');
}

// ---- (5) the REAL flow: the desk persists (POST /api/save) between every two task turns ----
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-epoch-flow-'));
  try {
    const saveFile = path.join(root, 'agent.save.json');
    let parses = 0;
    const cfs = new Proxy(fs, { get(t, p) {
      if (p === 'readFileSync') return function (f) { if (String(f) === saveFile) parses++; return t.readFileSync.apply(t, arguments); };
      const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
    } });
    let T = 1000;
    const saveStore = makeSaveStore({ fs: cfs, pathMod: path, root, clock: { now: () => ++T } });
    const sliced = ['function stationEpoch()', 'function crewLooksOf(save)', 'function remoteCrewLooks()', 'function seedSaveMemos(agentId, doc)', 'async function handleSaveWrite(req, res)']
      .map(n => { const b = fnBody(src, n); A.ok(b.startsWith(n) && b.length < 6000, 'sliced exactly ' + n); return b; });
    const notes = [];
    const api = vm.runInNewContext("let _stationEpochMemo = { stamp: '', epoch: 1 };\nlet _remoteLooksMemo = { stamp: '', looks: null };\n" + sliced.join('\n') +
      '\n({ stationEpoch, handleSaveWrite })', { saveStore, workspaceDegraded: false, growthRatings: { latestTs: () => 0 },
      readBody: async (req) => req.body, failNote: (tag) => notes.push(tag), observeDeletedSessions: () => [] });   // the deleted-session ledger feed (qa/bugs/3e926b6a)
    const big = Array.from({ length: 300 }, (_, i) => ({ id: 'ws' + i, history: [{ role: 'user', content: 'x'.repeat(2000) }] }));
    let rev = 0, upd = 0;
    // the desk's debounced persist, through the real POST /api/save handler
    const persist = async (createdAt, revision) => {
      const doc = { schema: 'starnet.save', agent: { id: 'agent', createdAt: createdAt }, agents: [], workstreams: big, updatedAt: ++upd, _saveRevision: revision == null ? rev : revision };
      let code = 0, text = '';
      await api.handleSaveWrite({ body: JSON.stringify(doc) }, { writeHead: (c) => { code = c; }, end: (b) => { text = b; } });
      const out = JSON.parse(text);
      if (out.ok) rev = out.revision;
      return { code, out };
    };
    A.eq((await persist(4242)).out.ok, true, 'the first desk save lands');
    let turnParses = 0;
    const epochs = [];
    for (let turn = 0; turn < 6; turn++) {
      const p0 = parses; epochs.push(api.stationEpoch()); turnParses += parses - p0;
      A.eq((await persist(4242)).out.ok, true, 'the desk persists the finished reply before the next turn (' + turn + ')');
    }
    A.eq(epochs, [4242, 4242, 4242, 4242, 4242, 4242], 'every turn reads the saved station generation');
    A.eq(turnParses, 0, '6 task turns with a desk save between each parse the save 0 times (the stamp-only memo parsed it every turn)');
    A.eq((await persist(9001)).out.ok, true, 'a save of a new station generation lands');
    const p1 = parses;
    A.eq(api.stationEpoch(), 9001, 'and the very next turn reads it');
    A.eq(parses - p1, 0, 'from the doc the save already held');
    const refused = await persist(7, rev + 5);
    A.ok(refused.out.ok === false, 'a stale-revision save is refused');
    A.eq(api.stationEpoch(), 9001, 'and seeds nothing: the epoch stays the stored one');
    const wrapped = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
    wrapped.doc.agent.createdAt = 31337;
    fs.writeFileSync(saveFile + '.ext', JSON.stringify(wrapped)); fs.renameSync(saveFile + '.ext', saveFile);
    const p2 = parses;
    A.eq(api.stationEpoch(), 31337, 'an outside replace of the save is read on the next turn');
    A.eq(parses - p2, 1, 'with exactly one parse');
    A.eq(notes, [], 'no seed failure was noted');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('task-turn-evidence.test');
})().catch(e => { console.error(e); process.exit(1); });
