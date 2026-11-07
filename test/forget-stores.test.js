/* node test/forget-stores.test.js - EVERY STORE THE REGISTRY PURGES, ON ITS REAL MODULE (turn identity commit 12, qa/bugs/3e926b6a, 31042fab, 6e750350).

   sidecar/forget-wiring.js registers one entry per durable store that holds words derived from a session. This file runs each entry's forget
   over the real store module (a temp dir, the real durable files) with a scope a real ledger produced, and proves the class-level rule for each:

     - what quotes or was filed under a deleted session is gone, and the same records written for another session are untouched;
     - the pass is idempotent (a second run removes nothing), so a crash between the purge and its stamp costs nothing;
     - a record written AFTER the delete from a re-opened session is not the deleted session's;
     - the store's write-time gate (registry.admit) refuses a write sourced from a deleted session;
     - what the store must KEEP (a declined decision, a dismissed shape) is kept.

   The census (forget-registry.census.test.js) proves every durable store has an entry or an exemption; this proves the entries work. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SessionTombstones = require('../sidecar/session-tombstones.js');
const ForgetRegistry = require('../sidecar/forget-registry.js');
const { wireForgetRegistry } = require('../sidecar/forget-wiring.js');
const Scout = require('../sidecar/scout.js');
const { makeRecommendationLedger } = require('../sidecar/recommendation-ledger.js');
const { makeDurableJsonStore } = require('../sidecar/durable-store.js');
const { makeVerdictReview } = require('../sidecar/verdictreview.js');
const { makeTaskBriefStore } = require('../sidecar/taskbrief-store.js');
const { makeDeliverableStore } = require('../sidecar/deliverable-store.js');
const { makeWorkshopStore } = require('../sidecar/workshop-store.js');
const { makeQuestStore } = require('../sidecar/quest-store.js');
const QuestRefresh = require('../sidecar/questrefresh.js');
const { makeOverseer } = require('../sidecar/overseer.js');
const { makeSubagentManager } = require('../sidecar/subagents.js');
const makeAttachments = require('../sidecar/attachments.js');
const { makeGroupSessions } = require('../sidecar/group-sessions.js');
const Store = require('../sidecar/transcriptstore.js');
const History = require('../sidecar/transcript-history.js');
const { sidecarTopLevelFunction } = require('./helpers/source.js');
const { quotesForgotten: journalQuotesForgotten } = require('../sidecar/run-journal.js');

const temp = name => fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-forget-' + name + '-'));
const remove = dir => fs.rmSync(dir, { recursive: true, force: true });
const noise = (tag, e) => { throw new Error(tag + ': ' + (e && e.message)); };

(async () => {
  const dir = temp('stores');
  try {
    // ---- a real ledger with one real (non-adopted) delete, and the registry over it ----
    let clock = 1000;
    const ledger = SessionTombstones.makeSessionTombstones({ fs, path, file: path.join(dir, 'session-tombstones.json'), now: () => clock });
    ledger.observe([], []);
    clock = 5000;
    ledger.observe(['sGone']);
    const runs = [
      { runId: 'r_gone', streamId: 'sGone', ts: 4000 },
      { runId: 'r_reader', streamId: 'sKeep', ts: 4500, quotes: ['sGone'], quotesAt: [4400] },
      { runId: 'r_keep', streamId: 'sKeep', ts: 4500 }
    ];
    const scope = SessionTombstones.deletedScope(ledger.unpurged(), runs);
    const registry = ForgetRegistry.make({ deletedAt: id => ledger.deletedAt(id), freshDeletedAt: id => ledger.freshAt(id), latestDeleteAt: () => ledger.latestAt(),
      runForgotten: runId => scope.runIds.has(runId), note: noise });
    const deps = { now: () => clock, notebookStore: () => null, threadsStore: () => null, memoryAgentIds: () => [], personalization: () => ({ markForgotten: async () => {} }) };
    const hold = {};   // each section adds the dep its entry reads
    // the station save the attachment proof reads: by default a new station (no save, no kept copy of one), which holds no page-only copy
    const newStation = () => ({ loadState: () => ({ status: 'absent' }), hasRecoveryCopy: () => false });
    hold.saveStore = newStation;
    wireForgetRegistry(registry, new Proxy(deps, { get: (target, key) => (key in target ? target[key] : hold[key]) }));
    registry.seal();
    const forget = async name => registry.entry(name).forget(scope);
    A.ok(scope.runIds.has('r_gone') && scope.runIds.has('r_reader') && !scope.runIds.has('r_keep'), 'the scope holds the deleted session\'s run and the run that read it');

    // ---------------- scout: staged drafts and attempt notes ----------------
    {
      const quoting = { quotes: ['sGone'], quotesAt: [4400] };
      const elsewhere = { quotes: ['sKeep'], quotesAt: [4400] };
      let st = Scout.fresh(1);
      st = Scout.stage(st, Object.assign({ id: 'd_gone', kind: 'recipe', draft: { name: 'Quokka Radar' }, why: 'you keep asking about quokka habitat', fingerprint: 'a' }, quoting), { now: 4450 });
      st = Scout.stage(st, Object.assign({ id: 'd_keep', kind: 'prospect', draft: { name: 'Platypus Planner' }, why: 'platypus plans', fingerprint: 'b' }, elsewhere), { now: 4460 });
      st = Scout.stage(st, { id: 'd_legacy', kind: 'recipe', draft: { name: 'Old Draft' }, why: 'staged before sources existed', fingerprint: 'c' }, { now: 4000 });
      st = Scout.stage(st, { id: 'd_after', kind: 'recipe', draft: { name: 'New Draft' }, why: 'staged after the delete', fingerprint: 'd' }, { now: 6000 });
      st = Scout.note(st, Object.assign({ kind: 'recipe', outcome: 'staged', reason: 'you keep asking about quokka habitat', title: 'Quokka Radar' }, quoting), { now: 4450 });
      st = Scout.note(st, Object.assign({ kind: 'recipe', outcome: 'staged', reason: 'platypus plans', title: 'Platypus Planner' }, elsewhere), { now: 4460 });
      st = Scout.note(st, { kind: 'cycle', outcome: 'skipped', reason: 'cadence' }, { now: 4470 });
      const back = Scout.normalize(JSON.parse(JSON.stringify(st)), 1);
      A.eq(back.staged.find(i => i.id === 'd_gone').quotes, ['sGone'], 'a staged draft keeps the stamp of the sessions it quoted through a restart');
      let state = back;
      hold.scout = { get: () => state, set: s => { state = s; }, persist: () => {} };
      const removed = await forget('scout');
      A.eq(removed, 3, 'the draft that quoted the deleted session, its attempt note and the unstamped (pre-source) draft go');
      A.eq(state.staged.map(i => i.id).sort(), ['d_after', 'd_keep'], 'the draft quoting another session and the draft staged after the delete stay');
      A.eq(state.ledger.map(e => e.title || e.reason).sort(), ['Platypus Planner', 'cadence'], 'only the note that quoted the deleted session left the attempt ledger');
      A.eq(await forget('scout'), 0, 'idempotent');
      const dismissed = Scout.dismiss(Scout.stage(Scout.fresh(1), { id: 'x', kind: 'recipe', draft: { name: 'N' }, why: 'w', fingerprint: 'fp one two', quotes: ['sGone'], quotesAt: [4400] }, { now: 4450 }), 'x', { now: 4460 });
      const afterDismiss = Scout.drop(dismissed, i => !!i.quotes);
      A.ok(afterDismiss.state.denylist.length === 1 && afterDismiss.state.staged.length === 0, 'a dismissed shape\'s fingerprint stays on the denylist: a draft the Commander waved off does not come back');
    }

    // ---------------- recommendations: the cross-surface ledger ----------------
    {
      const rdir = temp('recs');
      try {
        const led = makeRecommendationLedger({ fs, path, workspaces: rdir, learningEnabled: () => true });
        const base = (id, extra) => Object.assign({ id, surface: 'scout', kind: 'recipe', title: 'Title ' + id, target: id, evidence: [{ id: 'ctx', type: 'context', quote: 'quote of ' + id }], readiness: { ready: true, reasons: [] } }, extra);
        await led.record(base('e_gone', { quotes: ['sGone'], quotesAt: [4400] }), 4450);
        await led.record(base('e_declined', { quotes: ['sGone'], quotesAt: [4400] }), 4451);
        await led.verdict('e_declined', 'declined', 'not_relevant', 4452);
        await led.record(base('e_keep', { quotes: ['sKeep'], quotesAt: [4400] }), 4453);
        await led.record(base('e_plain'), 4454);
        A.eq((await led.list({})).length, 4, 'four recommendations are on file');
        hold.recommendations = () => led;
        const removed = await forget('recommendations');
        A.eq(removed, 2, 'the two entries that quoted the deleted session are handled');
        const left = led.list({}).sort((a, b) => (a.id < b.id ? -1 : 1));
        A.eq(left.map(e => e.id), ['e_declined', 'e_keep', 'e_plain'], 'the ordinary entry went whole; the declined one stays; others untouched');
        const kept = left.find(e => e.id === 'e_declined');
        A.eq([kept.state, kept.evidence, kept.quotes], ['declined', [], undefined], 'a declined entry keeps its decision (the reject list) and loses its evidence quotes');
        A.eq(await forget('recommendations'), 0, 'idempotent');
        A.eq(left.find(e => e.id === 'e_keep').evidence.length, 1, 'an entry that quoted another session keeps its evidence');
      } finally { remove(rdir); }
    }

    // ---------------- verdict packets: parked packets and held reviews ----------------
    {
      const timers = [];
      const persisted = [];
      const fired = [];
      const vr = makeVerdictReview({ now: () => 4600, graceMs: 90000, cap: 40, onChange: rows => { persisted.push(rows.map(r => r.runId)); return true; },
        setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; }, clearTimeout: t => { if (t) t.cleared = true; } });
      const packet = (streamId, rowId, word) => ({ agentId: 'agent', messages: [{ role: 'user', content: 'tell me about ' + word }, { role: 'assistant', content: 'here is ' + word }], reason: 'done', streamId, directive: { rowId, text: 'tell me about ' + word } });
      vr.stash('r_gone', packet('sGone', 11, 'quokkas'));
      vr.stash('r_reader', packet('sKeep', 21, 'quokkas, read through a tool'));
      vr.stash('r_keep', packet('sKeep', 22, 'platypuses'));
      vr.stash('r_held', packet('sGone', 12, 'wombats'));
      A.ok(vr.arm('r_held', 'miss', job => { fired.push(job.runId); return true; }), 'a rating arms a held review of a run in the session before it is deleted');
      A.ok(vr.holding('r_held') && timers.length === 1 && !timers[0].cleared, '...with its grace timer running');
      hold.verdictReview = () => vr;
      const removed = await forget('verdict-packets');
      A.eq(removed, 3, 'the packet of the deleted session\'s run, the packet of the run that READ it, and the held review are gone');
      A.ok(!vr.has('r_gone') && !vr.has('r_reader') && vr.has('r_keep'), 'the other session\'s packet stays');
      A.ok(!vr.holding('r_held') && timers[0].cleared, 'the held review is CANCELLED: its timer is cleared, nothing fires');
      A.eq(vr.snapshot().map(r => r.runId), ['r_keep'], 'the persisted rows hold only the surviving packet');
      A.eq(persisted[persisted.length - 1], ['r_keep'], '...and the change was acknowledged to the host\'s writer');
      A.eq(fired, [], 'no review ran');
      A.eq(await forget('verdict-packets'), 0, 'idempotent');
      // the write-time gate: the same packet written late, by a run still in the deleted session or one that read it, is refused
      A.ok(!registry.admit({ streamId: 'sGone', runId: 'r_late', at: 4000 }), 'a packet for a run filed in the deleted session before its delete is refused');
      A.ok(registry.admit({ streamId: 'sGone', runId: 'r_after', at: 6000 }), '...one filed in the re-opened session after it is not');
      A.ok(!registry.admit({ streamId: 'sKeep', runId: 'r_x', at: 6000, quotes: ['sGone'], quotesAt: [4400] }), '...and a packet for a run whose latch holds the deleted session is refused');
      A.ok(!registry.admit({ streamId: 'sKeep', runId: 'r_reader', at: 6000 }), '...as is one for a run the registry already knows quoted it');
    }

    // ---------------- task briefs ----------------
    {
      const bdir = temp('briefs');
      try {
        const store = makeTaskBriefStore({ fs, path, workspaces: bdir, forgotten: b => registry.forgotten({ streamIds: [b.streamId], runIds: [b.originalRunId, b.runId], rowIds: [b.directiveRowId], at: b.createdAt }) });
        // one conversation asked the same question twice per session: two sessions answered it the same way, so it is an observed pattern
        const finish = async (id, streamId, runId, ts, directive, answer) => {
          await store.prepare({ id, key: 'k_' + id, streamId, agentId: 'agent', runId, text: directive }, ts);
          await store.noteDirective(id, 30 + Number(id.slice(-1)), runId);
          await store.ask(id, { text: 'Which format do you want for the report?', options: ['Markdown', 'PDF'] }, ts + 1, { source: 'marker' });
          await store.answerInTurn(id, answer, ts + 2);
          await store.complete(id, runId, ts + 3, []);
        };
        await finish('tb_g1', 'sGone', 'r_gone', 4000, 'write the quokka report', 'Markdown');
        await finish('tb_k1', 'sKeep', 'r_keep', 4010, 'write the platypus report', 'Markdown');
        await finish('tb_k2', 'sKeep', 'r_keep2', 4020, 'write the wombat report', 'Markdown');
        await finish('tb_r1', 'sKeep', 'r_reader', 4500, 'write the reader report', 'Markdown');
        A.eq(store.list({}).length, 4, 'four briefs are on file');
        hold.taskBriefs = () => store;
        // the read-time belt: while the purge is pending, patterns() already leaves the deleted session's answer out
        A.eq(store.patterns(5).map(p => p.count), [2], 'before the purge the belt already hides the answer given in the deleted session and the one the reader run gave (2 of 4 still count)');
        const removed = await forget('task-briefs');
        A.eq(removed, 2, 'the brief opened in the deleted session and the brief of the run that read it are gone');
        A.eq(store.list({}).map(b => b.id).sort(), ['tb_k1', 'tb_k2'], 'the other session\'s briefs stay');
        A.eq(store.patterns(5).map(p => [p.count, p.answer]), [[2, 'Markdown']], 'the pattern the live session earned is still offered');
        A.ok(!JSON.stringify(store.list({})).includes('quokka'), 'no brief holds the deleted session\'s words');
        const bak = path.join(bdir, 'task-briefs.json.bak');
        A.ok(!fs.existsSync(bak) || !fs.readFileSync(bak, 'utf8').includes('quokka'), 'the store\'s .bak (last-known-good) holds the purged copy too: a recovery cannot bring the session back');
        A.eq(await forget('task-briefs'), 0, 'idempotent');
      } finally { remove(bdir); }
    }

    // ---------------- skill goldens and study proposals ----------------
    {
      const golden = (runId, skillId, word) => ({ id: 'g_' + runId, skillId, agentId: 'agent', runId, directive: 'about ' + word, reference: { text: word + ' notes', words: 2, chars: 12, keywords: [word] }, mintedAt: 4100 });
      let goldens = { 'agent\u0000skillA': [golden('r_gone', 'skillA', 'quokka'), golden('r_keep', 'skillA', 'platypus')], 'agent\u0000skillB': [golden('r_reader', 'skillB', 'readerword')], 'agent\u0000skillC': [golden('r_keep2', 'skillC', 'wombat')] };
      const goldenSaves = [];
      hold.goldens = { get: () => goldens, persist: next => { goldens = next; goldenSaves.push(JSON.stringify(next)); } };
      A.eq(await forget('skill-goldens'), 2, 'the golden of the deleted session\'s run and the golden of the run that read it are gone');
      A.eq(Object.keys(goldens).sort(), ['agent\u0000skillA', 'agent\u0000skillC'], 'a skill whose only golden went keeps no key');
      A.eq(goldens['agent\u0000skillA'].map(g => g.runId), ['r_keep'], 'the other run\'s golden stays');
      A.ok(goldenSaves.length === 2 && !goldenSaves.some(s => s.includes('quokka')), 'written twice (the .bak is the purged copy too) and neither holds the deleted words');
      A.eq(await forget('skill-goldens'), 0, 'idempotent');
      A.ok(!registry.admit({ runId: 'r_gone', streamId: 'sGone', at: 6000 }) && registry.admit({ runId: 'r_after', streamId: 'sKeep', at: 6000 }), 'a golden for a forgotten run is refused by the gate, another run\'s is not');

      const proposal = (id, sourceRunId, text) => ({ id, dim: 'goals', kind: 'add', text, evidence: '', evidenceRef: { runId: sourceRunId, kind: 'directive' }, source: 'study', sourceRunId });
      const byRun = new Map([
        ['r_gone', { agentId: 'agent', runId: 'r_gone', createdAt: 4100, proposals: [proposal('p1', 'r_gone', 'keeps quokkas')] }],
        ['r_reader', { agentId: 'agent', runId: 'r_reader', createdAt: 4600, proposals: [proposal('p2', 'r_reader', 'reads quokka notes')] }],
        ['r_keep', { agentId: 'agent2', runId: 'r_keep', createdAt: 4100, proposals: [proposal('p3', 'r_keep', 'likes platypuses'), proposal('p4', 'r_gone', 'cites the deleted run')] }]
      ]);
      const latest = new Map([['agent', 'r_reader'], ['agent2', 'r_keep']]);
      let persists = 0;
      hold.study = { byRun: () => byRun, latest: () => latest, persist: () => { persists++; } };
      A.eq(await forget('study-proposals'), 3, 'two whole entries and the one proposal that cited the deleted run are gone');
      A.eq(Array.from(byRun.keys()), ['r_keep'], 'the other run\'s entry stays');
      A.eq(byRun.get('r_keep').proposals.map(p => p.id), ['p3'], '...without the proposal that cited the deleted session\'s run');
      A.eq(Array.from(latest.entries()), [['agent2', 'r_keep']], 'the pointer to a removed entry goes with it');
      A.eq(persists, 2, 'persisted twice');
      A.eq(await forget('study-proposals'), 0, 'idempotent');
    }

    // ---------------- deliverables library ----------------
    {
      const ddir = temp('deliverables');
      try {
        let gateOn = false;   // the rows are filed BEFORE the delete: the gate is only asked afterwards
        const make = () => makeDeliverableStore({ fs, path, workspaces: ddir, admit: row => !gateOn || registry.admit({ runId: row.runId, at: 6000 }) });
        let store = make();
        const row = (id, runId, word) => ({ id, agentId: 'agent', runId, title: word + ' report', source: 'workshop', status: 'kept', kind: 'files', summary: 'all about ' + word, files: [{ path: word + '.md', bytes: 10 }] });
        await store.record(row('d_gone', 'r_gone', 'quokka'), 4100);
        await store.record(row('d_reader', 'r_reader', 'readerword'), 4600);
        await store.record(row('d_keep', 'r_keep', 'platypus'), 4100);
        await store.record(row('d_gone2', 'r_gone', 'quokkaTwo'), 4101);
        const preview = store.previewCleanup({ statuses: ['kept'] });
        await store.applyCleanup(preview, 'undo-1', 4200);   // every kept row moves into an undo batch: copies the purge must reach too
        A.eq(store.list().length, 0, 'the cleanup moved the rows into an undo batch');
        await store.undoCleanup('undo-1', 4300);
        await store.record(row('d_gone3', 'r_gone', 'quokkaThree'), 4400);
        const hot = store.previewCleanup({ statuses: ['kept'] });
        await store.applyCleanup(hot, 'undo-2', 4450);   // d_* again sit in an undo batch while the delete lands
        hold.deliverables = () => store;
        const removed = await forget('deliverables');
        A.eq(removed, 4, 'three rows of the deleted session\'s run and the reader run\'s row go (counted once each, library or undo batch)');
        const journal = path.join(ddir, 'deliverables.library.jsonl');
        const disk = [path.join(ddir, 'deliverables.library.json'), path.join(ddir, 'deliverables.library.json.bak'), journal].filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f, 'utf8')).join('\n');
        A.ok(!/quokka|readerword/.test(disk), 'no snapshot, .bak or journal line holds a forgotten row\'s words');
        store = make();   // a restart replays the snapshot and journal
        await store.undoCleanup('undo-2', 4500);
        A.eq(store.list().map(r => r.id), ['d_keep'], 'after a restart and an undo only the other session\'s row comes back: the undo batch held no copy of the forgotten ones');
        A.eq(await forget('deliverables'), 0, 'idempotent');
        gateOn = true;
        A.eq(await store.record(row('d_late', 'r_gone', 'late'), 4600), null, 'a lifecycle row for a forgotten run is refused by the gate (null, nothing written)');
        A.ok((await store.record(row('d_new', 'r_after', 'fresh'), 4600)).id === 'd_new', '...and a live run\'s row is written');
      } finally { remove(ddir); }
    }

    // ---------------- the night shift: desk drafts, the act ledger, the away workshop's queue ----------------
    {
      const quoting = { quotes: ['sGone'], quotesAt: [4400] }, elsewhere = { quotes: ['sKeep'], quotesAt: [4400] };
      let drafts = [
        Object.assign({ title: 'Quokka plan', at: 4450, body: 'quokka plan body' }, quoting),
        Object.assign({ title: 'Platypus plan', at: 4450, body: 'platypus plan body' }, elsewhere),
        { title: 'Old draft', at: 4000, body: 'written before sources existed' },
        { title: 'Newer draft', at: 6000, body: 'written after the delete, unstamped' },
        Object.assign({ title: 'Built thing', at: 4455, body: 'built', runId: 'r_gone' }, elsewhere)
      ];
      const saves = [];
      hold.nightDrafts = { get: () => drafts, set: list => { drafts = list; }, persist: () => saves.push(drafts.length) };
      A.eq(await forget('night-drafts'), 3, 'the draft that quoted the deleted session, the one built by a run of it, and the unstamped (pre-source) one go');
      A.eq(drafts.map(x => x.title), ['Platypus plan', 'Newer draft'], 'a draft quoting another session and one written after the delete stay');
      A.eq(saves.length, 2, 'persisted twice (the .bak is the purged copy too)');
      A.eq(await forget('night-drafts'), 0, 'idempotent');
      A.ok(!registry.admit(Object.assign({ title: 'late', at: 6500 }, quoting)) && registry.admit(Object.assign({ title: 'ok', at: 6500 }, elsewhere)), 'the gate refuses a draft whose stamp names the deleted session, not another\'s');

      const acts = { r_gone: { archetype: 'a', at: 4100, threadId: null }, r_reader: { archetype: 'b', at: 4600, threadId: 't1' }, r_keep: { archetype: 'c', at: 4100, threadId: null } };
      let actSaves = 0;
      hold.nightActs = { get: () => acts, persist: () => { actSaves++; } };
      A.eq(await forget('night-acts'), 2, 'the acts of the deleted session\'s run and of the run that read it go');
      A.eq(Object.keys(acts), ['r_keep'], 'the other run\'s act stays');
      A.eq(actSaves, 2, 'persisted twice');

      const wdir = temp('workshop');
      try {
        const ws = makeWorkshopStore({ fs, path, workspaces: wdir });
        await ws.queue('agent', Object.assign({ id: 'ns-act-1', title: 'Quokka build', detail: 'spec about quokkas', source: 'nightshift' }, quoting), 4450);
        await ws.queue('agent', Object.assign({ id: 'ns-act-2', title: 'Platypus build', detail: 'spec about platypus', source: 'nightshift' }, elsewhere), 4451);
        await ws.queue('agent', { id: 'ns-act-3', title: 'Old nightshift job', detail: 'queued before sources existed', source: 'nightshift' }, 4000);
        await ws.queue('agent', { id: 'user-1', title: 'My own job', detail: 'the Commander queued this', source: 'queued' }, 4000);
        await ws.queue('agent', Object.assign({ id: 'ns-act-4', title: 'Built job', detail: 'built', source: 'nightshift' }, quoting), 4452);
        await ws.markBuilt('agent', 'ns-act-4', 'r_gone', 4460);
        await ws.queue('agent2', { id: 'ns-act-5', title: 'Another agent legacy job', detail: 'x', source: 'nightshift' }, 4000);
        hold.workshop = () => ws;
        hold.workshopAgentIds = () => ['agent', 'agent2'];
        A.eq(await forget('workshop-backlog'), 4, 'the quoting job, the unstamped night job and the job built by a run of the deleted session go, on every agent');
        A.eq(ws.backlogOf('agent').map(b => b.id).sort(), ['ns-act-2', 'user-1'], 'the other session\'s job and the Commander\'s own queued job stay');
        const disk = fs.readdirSync(wdir).filter(f => /workshop/.test(f)).map(f => fs.readFileSync(path.join(wdir, f), 'utf8')).join('\n');
        A.ok(!/quokka/i.test(disk), 'no workshop file or .bak holds the deleted session\'s job');
        A.eq(await forget('workshop-backlog'), 0, 'idempotent');
      } finally { remove(wdir); }
    }

    // ---------------- quests and the north star ----------------
    {
      const qdir = temp('quests');
      try {
        const store = makeQuestStore({ fs, path, workspaces: qdir });
        const contract = { type: 'attest', key: 'confirm' };
        const mint = (title, extra) => store.mint(Object.assign({ title, desc: 'about ' + title, kind: 'generated', contract, groundedIn: 'you asked about ' + title }, extra || {}), 4100);
        await mint('Quokka habitat survey', { quotes: ['sGone'], quotesAt: [4400] });
        await mint('Platypus launch plan', { quotes: ['sKeep'], quotesAt: [4400] });
        await mint('Old generated quest');   // generated and open, minted before sources existed
        await store.mint({ title: 'My own quest', desc: 'the Commander made this', kind: 'user', contract, createdBy: 'user' }, 4100);
        hold.quests = () => store;
        A.eq(await forget('quests'), 2, 'the quest that quotes the deleted session and the unstamped generated open quest go');
        A.eq(store.list().map(q => q.title).sort(), ['My own quest', 'Platypus launch plan'], 'the other session\'s quest and the Commander\'s own quest stay');
        const disk = fs.readdirSync(qdir).map(f => fs.readFileSync(path.join(qdir, f), 'utf8')).join('\n');
        A.ok(!/quokka/i.test(disk), 'no quest file or .bak holds the deleted session\'s quest');
        A.eq(await forget('quests'), 0, 'idempotent');
      } finally { remove(qdir); }

      const stamp = (quotes, at) => ({ quotes, quotesAt: [at] });
      let state = QuestRefresh.fresh();
      state = QuestRefresh.setNorthStar(state, { text: 'Own the outbound stack', groundedIn: 'the Commander\'s active goal arc', source: 'goal' }, { now: 4000 });
      state = QuestRefresh.proposeNorthStar(state, Object.assign({ text: 'Study quokka habitats', groundedIn: 'inferred from recent activity', source: 'model' }, stamp(['sGone'], 4400)), { now: 4450 });
      state = QuestRefresh.stageQuests(state, [Object.assign({ title: 'Survey quokkas', desc: 'd', reward: 'r', contract: { type: 'attest', key: 'confirm' }, steps: [], groundedIn: 'g' }, stamp(['sGone'], 4400)),
        { title: 'Unstamped staged quest', desc: 'd', reward: 'r', contract: { type: 'attest', key: 'confirm' }, steps: [], groundedIn: 'g' }]);
      state = QuestRefresh.note(state, Object.assign({ outcome: 'staged', reason: 'quokka quests wait', title: 'Survey quokkas' }, stamp(['sGone'], 4400)), { now: 4450 });
      state = QuestRefresh.note(state, Object.assign({ outcome: 'minted', reason: 'platypus quest', title: 'Platypus' }, stamp(['sKeep'], 4400)), { now: 4451 });
      state = QuestRefresh.note(state, { outcome: 'skipped', reason: 'cadence' }, { now: 4452 });
      state = QuestRefresh.normalize(JSON.parse(JSON.stringify(state)));
      A.eq(state.proposedNorthStar.quotes, ['sGone'], 'a proposed star keeps the stamp of the sessions it was inferred from through a restart');
      let saves = 0;
      hold.northStar = { get: () => state, set: s => { state = s; }, persist: () => { saves++; } };
      A.eq(await forget('north-star'), 4, 'the proposed star, both staged quests (one stamped, one pre-source) and the note that quoted the session go');
      A.eq([state.northStar && state.northStar.text, state.proposedNorthStar, state.pendingQuests.length], ['Own the outbound stack', null, 0], 'the Commander\'s own goal-arc star stays; nothing inferred from the deleted session is pending');
      A.eq(state.ledger.map(e => e.reason).sort(), ['cadence', 'platypus quest'], 'notes that quoted another session or nothing stay');
      A.eq(saves, 2, 'persisted twice');
      A.eq(await forget('north-star'), 0, 'idempotent');
      // an ADOPTED inferred star that quotes the session goes too (the Commander confirmed it, but its words are the session\'s)
      let adopted = QuestRefresh.confirmNorthStar(QuestRefresh.proposeNorthStar(QuestRefresh.fresh(), Object.assign({ text: 'Study quokka habitats', groundedIn: 'g', source: 'model' }, stamp(['sGone'], 4400)), { now: 4450 }), { now: 4460 });
      A.eq(adopted.northStar.quotes, ['sGone'], 'confirming a proposal carries its stamp to the adopted star');
      hold.northStar = { get: () => adopted, set: s => { adopted = s; }, persist: () => {} };
      A.eq([await forget('north-star'), adopted.northStar], [1, null], 'an adopted inferred star that quotes the deleted session is dropped');
    }

    // ---------------- the away briefing's state ----------------
    {
      const bdir = temp('briefing');
      try {
        const store = makeDurableJsonStore({ fs, path, fileFor: () => path.join(bdir, '_away.briefing.json') });
        const seed = last => store.set('briefing', { through: 4000, last });
        hold.awayBriefing = () => store;
        seed({ at: 4450, since: 4000, items: [{ kind: 'routine', name: 'quokka watcher', runId: 'r_gone', excerpt: 'counted quokkas' }], counts: { routines: 1 }, quotes: ['sGone'], quotesAt: [4450] });
        A.eq(await forget('away-briefing'), 1, 'a briefing that summarised the deleted session\'s runs is dropped');
        A.eq(store.get('briefing'), { through: 4000, last: null }, '...but the briefed-through time stays: the station does not brief the same runs again');
        A.ok(!/quokka/.test(fs.readdirSync(bdir).map(f => fs.readFileSync(path.join(bdir, f), 'utf8')).join('\n')), 'neither the file nor its .bak holds the briefing');
        seed({ at: 4450, since: 4000, items: [{ kind: 'routine', name: 'platypus watcher' }], counts: {}, quotes: ['sKeep'], quotesAt: [4450] });
        A.eq(await forget('away-briefing'), 0, 'a briefing that summarised another session stays');
        seed({ at: 4000, since: 3000, items: [{ kind: 'routine', name: 'old' }], counts: {} });
        A.eq(await forget('away-briefing'), 1, 'a briefing with no stamp predates sources and goes');
        seed({ at: 6000, since: 5000, items: [], counts: {} });
        A.eq(await forget('away-briefing'), 0, 'one delivered after the delete stays');
      } finally { remove(bdir); }
    }

    // ---------------- overseer threads and reports ----------------
    {
      const odir = temp('overseer');
      try {
        const save = { deletedIds: [], workstreams: [{ id: 'sGone', title: 'Gone chat', agentId: 'agent', history: [] }, { id: 'sKeep', title: 'Keep chat', agentId: 'agent', history: [] }] };
        let n = 0;
        const ov = makeOverseer({ fs, path, writeDurable: require('../sidecar/durable-write.js').writeFileDurable, file: path.join(odir, 'overseer.json'), now: () => 4000, newId: () => 'ws_w' + (++n),
          sessions: () => save, hasAgent: () => true, isRunActive: () => false, forgotten: (id, ts) => ledger.forgotten(id, ts) });
        // two delegated threads: one filed from the session that will be deleted, one from the session that stays
        ov.create({ title: 'Quokka worker', parentStreamId: 'sGone', requestId: 'r_lead_gone:1:1', worker: true });
        ov.create({ title: 'Platypus worker', parentStreamId: 'sKeep', requestId: 'r_lead_keep:1:1', worker: true });
        hold.overseer = () => ov;
        A.eq(ov.snapshot().threads.filter(w => w.worker).length, 2, 'two delegated threads are on file');
        A.eq(await forget('overseer'), 1, 'the thread filed from the deleted session is gone');
        const snap = JSON.stringify(ov.snapshot());
        A.ok(!snap.includes('Quokka worker') && snap.includes('Platypus worker'), 'its title is gone from the snapshot, the other thread stays');
        A.ok(!/Quokka worker/.test(fs.readdirSync(odir).map(f => fs.readFileSync(path.join(odir, f), 'utf8')).join('\n')), 'no overseer file or .bak holds it');
        A.eq(await forget('overseer'), 0, 'idempotent');
        // the sidecar ledger, not the page's 500-id list, decides what reads back as deleted: a thread whose own id the ledger says was deleted stays hidden
        n = 99;
        const reborn = makeOverseer({ fs, path, writeDurable: require('../sidecar/durable-write.js').writeFileDurable, file: path.join(odir, 'overseer2.json'), now: () => 4000, newId: () => 'sGone',
          sessions: () => ({ deletedIds: [], workstreams: [{ id: 'sKeep', title: 'Keep chat', agentId: 'agent', history: [] }] }), hasAgent: () => true, isRunActive: () => false, forgotten: (id, ts) => ledger.forgotten(id, ts) });
        reborn.create({ title: 'Filed under a deleted id', parentStreamId: 'sKeep', requestId: 'r_x:1:1', worker: true });
        A.eq(reborn.threads().some(w => w.id === 'sGone'), false, 'a thread the ledger says was deleted never reads back as live, whatever the page\'s list holds');
      } finally { remove(odir); }
    }

    // ---------------- subagent records ----------------
    {
      const sdir = temp('subagents');
      try {
        const sm = makeSubagentManager({ fs, pathMod: path, file: path.join(sdir, 'subagents.json'), clock: { now: () => 4200 }, emit: () => {}, newId: (() => { let n = 0; return () => 'id' + (++n); })() });
        const records = sm._internals.records();
        const rec = (id, status, parentStreamId, runId, word) => ({ id, leadId: 'agent', agentId: 'agent', runId, status, prompt: 'research ' + word, context: 'context about ' + word, result: word + ' result', events: [{ name: 'agent.token', payload: { delta: word } }], parentStreamId, streamId: 'w_' + id, parentRunId: 'lead_' + id, startedAt: 4100, updatedAt: 4100 });
        records.push(rec('s_done', 'done', 'sGone', 'wr1', 'quokka'), rec('s_run', 'running', 'sGone', 'wr2', 'quokkarunning'), rec('s_keep', 'done', 'sKeep', 'wr3', 'platypus'), rec('s_reader', 'done', 'sKeep', 'r_reader', 'readerword'));
        hold.subagents = () => sm;
        A.eq(await forget('subagents'), 3, 'the settled record of the deleted session, the one still running and the reader run\'s record are all handled');
        const left = sm._internals.records();
        A.eq(left.map(r => r.id).sort(), ['s_keep', 's_run'], 'the settled ones are removed whole; the running one keeps its place');
        const running = left.find(r => r.id === 's_run');
        A.eq([running.prompt, running.context, running.result, running.events, running.status], ['', '', '', [], 'running'], '...without any of its words');
        A.ok(!/quokka|readerword/.test(fs.readFileSync(path.join(sdir, 'subagents.json'), 'utf8')), 'the registry file holds none of the deleted words');
        A.eq(await forget('subagents'), 0, 'idempotent');
      } finally { remove(sdir); }
    }

    // ---------------- attachment files ----------------
    {
      const adir = temp('attach');
      try {
        const fsp = fs.promises;
        const att = makeAttachments({ fsp, path, crypto: require('node:crypto'), workspaces: adir, resolveInside: async (agentId, rel) => ({ base: path.join(adir, agentId), abs: path.join(adir, agentId, rel) }) });
        const png = 'data:image/png;base64,' + Buffer.from('quokka-image-bytes').toString('base64');
        const text = name => 'data:text/plain;base64,' + Buffer.from('notes about ' + name).toString('base64');
        const onlyGone = await att.saveAttachment('agent', 'quokka.png', png);
        const shared = await att.saveAttachment('agent', 'shared.txt', text('shared'));
        const onlyKeep = await att.saveAttachment('agent', 'platypus.txt', text('platypus'));
        const exists = ref => fs.existsSync(path.join(adir, 'agent', ref.path));
        A.ok([onlyGone, shared, onlyKeep].every(r => r && r.path && exists(r)), 'three attachment files are on disk');
        const io = History.makeMemoryTranscriptIo();
        const store = Store.makeTranscriptStore({ io, clock: { now: () => 4000 }, deletedAt: id => ledger.deletedAt(id), latestDeleteAt: () => ledger.latestAt() });
        const say = (streamId, words, atts) => store.appendStrict({ sourceRunId: 'run_' + streamId, streamId, agentId: 'agent', role: 'user', content: words, ts: 4000, taint: null, directive: true, kind: 'turn', attachments: atts });
        say('sGone', 'look at these quokka files', [onlyGone, shared]);
        say('sKeep', 'the shared file again, re-sent', [shared]);
        say('sKeep', 'and the platypus file', [onlyKeep]);
        hold.transcriptStore = () => store;
        hold.attachments = () => att;
        A.eq(await forget('attachment-files'), 1, 'the file only the deleted session\'s message named is removed');
        A.ok(!exists(onlyGone) && exists(shared) && exists(onlyKeep), 'a file a live session also names (a re-send) stays, and so does another session\'s file');
        A.eq(await forget('attachment-files'), 0, 'idempotent');
        A.ok(!fs.existsSync(path.join(adir, 'agent', '.attachments')) || !fs.readdirSync(path.join(adir, 'agent', '.attachments')).some(f => f === path.basename(onlyGone.path)), 'the agent\'s file tools can no longer list the deleted session\'s attachment');
      } finally { remove(adir); }
    }

    // ---------------- attachment files, the attachment-rows shape (contract A16) ----------------
    /* attachment-rows adds rows of kind 'attachment' beside the directive's attachments[]: r.attachment = { id, name, mime, path }. A file can
       be named ONLY through such a row, so the entry counts both forms in both loops: the live set (a branch or a re-send naming the file only
       through an attachment row KEEPS it) and the doomed set (a deleted session naming it only through an attachment row LOSES it). */
    {
      const adir = temp('attach-rows');
      try {
        const fsp = fs.promises;
        const att = makeAttachments({ fsp, path, crypto: require('node:crypto'), workspaces: adir, resolveInside: async (agentId, rel) => ({ base: path.join(adir, agentId), abs: path.join(adir, agentId, rel) }) });
        const text = name => 'data:text/plain;base64,' + Buffer.from('notes about ' + name).toString('base64');
        const turnFile = await att.saveAttachment('agent', 'turn.txt', text('turn'));          // named by a directive AND an attachment row of the deleted session
        const rowOnly = await att.saveAttachment('agent', 'rowonly.txt', text('rowonly'));      // named by the deleted session ONLY through an attachment row
        const branched = await att.saveAttachment('agent', 'branched.txt', text('branched'));   // deleted session: directive; live branch: ONLY an attachment row
        const keepOwn = await att.saveAttachment('agent', 'keepown.txt', text('keepown'));      // another session's own attachment row
        const exists = ref => fs.existsSync(path.join(adir, 'agent', ref.path));
        const io = History.makeMemoryTranscriptIo();
        const store = Store.makeTranscriptStore({ io, clock: { now: () => 4000 }, deletedAt: id => ledger.deletedAt(id), latestDeleteAt: () => ledger.latestAt() });
        const base = streamId => ({ sourceRunId: 'run_' + streamId, streamId, agentId: 'agent', ts: 4000, taint: null });
        const ref = f => ({ id: path.basename(f.path, '.txt'), name: path.basename(f.path), mime: 'text/plain', path: f.path });
        const directive = (streamId, words, files) => store.appendStrict(Object.assign(base(streamId), { role: 'user', content: words, directive: true, kind: 'turn', attachments: files }));
        const rowFor = (streamId, f) => store.appendStrict(Object.assign(base(streamId), { role: 'system', content: '[attached: ' + path.basename(f.path) + ']', kind: 'attachment', taint: 'user attachment', attachment: ref(f) }));
        directive('sGone', 'look at this file', [turnFile]); rowFor('sGone', turnFile);   // an AR-shaped turn: the directive and its attachment row
        rowFor('sGone', rowOnly);
        directive('sGone', 'and this one', [branched]);
        rowFor('sKeep', branched);                 // a live branch that has ONLY the attachment row
        rowFor('sKeep', keepOwn);
        hold.transcriptStore = () => store;
        hold.attachments = () => att;
        A.ok([turnFile, rowOnly, branched, keepOwn].every(exists), 'four attachment files are on disk');
        const rows = store.view('proof', 'sGone', { complete: true });
        A.ok(rows.some(r => r.kind === 'attachment' && r.attachment && r.attachment.path === rowOnly.path), 'the proof view of the deleted session holds the attachment row of the file only that row names');
        A.eq(await forget('attachment-files'), 2, 'the AR-shaped turn\'s file and the file only an attachment row named are removed');
        A.ok(!exists(turnFile) && !exists(rowOnly), 'the privacy half: a deleted session\'s file goes whether its directive or only its attachment row named it');
        A.ok(exists(branched) && exists(keepOwn), 'the safety half: a file a live branch names ONLY through an attachment row stays, and so does another session\'s own');
        A.eq(await forget('attachment-files'), 0, 'idempotent');
      } finally { remove(adir); }
    }

    // ---------------- attachment files, a message sent mid-run (auto-steer) ----------------
    /* A steer row names its files only inside its held wire (steeringWire = SteeringMessage.encode({ text, attachments, id })): no attachments[]
       and no attachment row. The entry reads that wire in both loops: a deleted session's steered file goes, a live session's steer keeps its own. */
    {
      const adir = temp('attach-steer');
      try {
        const fsp = fs.promises;
        const SteeringMessage = require('../frontend/app/steering-message.js');
        const att = makeAttachments({ fsp, path, crypto: require('node:crypto'), workspaces: adir, resolveInside: async (agentId, rel) => ({ base: path.join(adir, agentId), abs: path.join(adir, agentId, rel) }) });
        const text = name => 'data:text/plain;base64,' + Buffer.from('notes about ' + name).toString('base64');
        const steered = await att.saveAttachment('agent', 'steered.txt', text('steered'));     // sent mid-run in the deleted session
        const kept = await att.saveAttachment('agent', 'steerkeep.txt', text('steerkeep'));   // sent mid-run in a live session
        const exists = ref => fs.existsSync(path.join(adir, 'agent', ref.path));
        const io = History.makeMemoryTranscriptIo();
        const store = Store.makeTranscriptStore({ io, clock: { now: () => 4000 }, deletedAt: id => ledger.deletedAt(id), latestDeleteAt: () => ledger.latestAt() });
        const TurnKinds = require('../frontend/app/turnkinds.js');
        // the row the loop's folded message becomes (auto-steer.test.js files it the same way): role system, kind steer, the wire held
        const steer = (streamId, f, id) => {
          const m = { role: 'user', content: 'look at this', steeringWire: SteeringMessage.encode({ text: 'look at this', id, attachments: [{ id: path.basename(f.path), name: path.basename(f.path), path: f.path, mediaType: 'text/plain', kind: 'file' }] }) };
          TurnKinds.tag(m, 'steer', { noteId: id });
          store.appendNewStrict(streamId, 'agent', [m], { sourceRunId: 'run_' + streamId, turnId: 't_0123456789abcdefghijk', kindOf: x => TurnKinds.messageKind(x, 'turn') });
        };
        steer('sGone', steered, 'n_gone'); steer('sKeep', kept, 'n_keep');
        hold.transcriptStore = () => store;
        hold.attachments = () => att;
        A.ok(store.view('proof', 'sGone', { complete: true }).some(r => typeof r.steeringWire === 'string'), 'the proof view of the deleted session holds the steer row with its wire');
        A.eq(await forget('attachment-files'), 1, 'the file only the deleted session\'s steer named is removed');
        A.ok(!exists(steered) && exists(kept), 'a deleted session\'s mid-run file goes; a live session\'s own stays');
        A.eq(await forget('attachment-files'), 0, 'idempotent');
      } finally { remove(adir); }
    }

    // ---------------- attachment files a live chat still names outside the RAM mirror, or only in the page's save ----------------
    /* The in-use proof reads every durable row (store.eachRow), not only the newest rows the RAM mirror holds, and the sessions of the page's
       own save: a /branch copy's turns live only there in this release (shadow mode never writes them to the transcript). A file either one
       names stays; the deleted session's own file goes. When the proof cannot be made, nothing is removed and the pass fails (retried at boot). */
    {
      const adir = temp('attach-live');
      try {
        const fsp = fs.promises;
        const att = makeAttachments({ fsp, path, crypto: require('node:crypto'), workspaces: adir, resolveInside: async (agentId, rel) => ({ base: path.join(adir, agentId), abs: path.join(adir, agentId, rel) }) });
        const upload = name => att.saveAttachment('agent', name, 'data:text/plain;base64,' + Buffer.from('notes about ' + name).toString('base64'));
        const old = await upload('old.txt'), branched = await upload('branched.txt'), own = await upload('own.txt');
        const exists = ref => fs.existsSync(path.join(adir, 'agent', ref.path));
        const io = History.makeMemoryTranscriptIo();
        const store = Store.makeTranscriptStore({ io, clock: { now: () => 4000 }, ramMax: 4, ramPerStream: 3, deletedAt: id => ledger.deletedAt(id), latestDeleteAt: () => ledger.latestAt() });
        let n = 0;
        const say = (streamId, words, files, ts) => store.appendStrict({ sourceRunId: 'run_live_' + (++n), streamId, agentId: 'agent', role: 'user', content: words, ts, taint: null, directive: true, kind: 'turn', attachments: files });
        say('sKeep', 'the old file, said long ago', [old], 3000);
        for (let i = 0; i < 6; i++) say('sKeep', 'later words ' + i, [], 3100 + i);   // the old row leaves the RAM mirror
        say('sGone', 'the file the branch copied', [branched], 3800);
        say('sGone', 'the old file again, and my own', [old, own], 3950);
        const names = (rows, f) => rows.some(r => r.streamId === 'sKeep' && (r.attachments || []).some(a => a.path === f.path));
        A.ok(!names(store.all(), old), 'the live chat\'s row naming the old file is outside the RAM mirror');
        const durable = [];
        store.eachRow(r => durable.push(r));
        A.ok(names(durable, old) && durable.length === 9, 'the row is durable, and eachRow hands over every durable row');
        // the page's save: sBranch is a /branch copy of sGone's first turn (the page's alone); sGone itself is still listed in a stale save
        const doc = { workstreams: [
          { id: 'sBranch', agentId: 'agent', history: [{ role: 'user', content: 'the file the branch copied', ts: 3800, attachments: [branched] }] },
          { id: 'sGone', agentId: 'agent', history: [{ role: 'user', content: 'the old file again, and my own', ts: 3950, attachments: [old, own] }] }
        ] };
        hold.transcriptStore = () => store;
        hold.attachments = () => att;
        hold.saveStore = () => ({ loadState: agentId => (agentId === 'agent' ? { status: 'ok', doc } : { status: 'absent' }) });
        A.eq(await forget('attachment-files'), 1, 'only the deleted session\'s own file is removed');
        A.ok(exists(old), 'a file a live chat named long ago (outside the RAM mirror) stays');
        A.ok(exists(branched), 'a file a /branch copy names only in the page\'s save stays');
        A.ok(!exists(own), 'the deleted session\'s own file goes, though a stale save still lists the deleted session');
        A.eq(await forget('attachment-files'), 0, 'idempotent');
        // the proof cannot be made: nothing is removed and the pass fails, so the delete is retried at the next boot
        const late = await upload('late.txt');
        say('sGone', 'one more file', [late], 4100);
        hold.saveStore = () => ({ loadState: () => ({ status: 'corrupt' }) });
        let failed = null;
        try { await forget('attachment-files'); } catch (e) { failed = e; }
        A.ok(failed && /station save could not be read/.test(failed.message) && exists(late), 'an unreadable save keeps the file and fails the pass, never a guess');
        hold.saveStore = () => ({ loadState: () => ({ status: 'ok', doc }) });
        const blindIo = Object.assign({}, io);
        delete blindIo.eachRow;   // an io with no whole-history reader
        hold.transcriptStore = () => Store.makeTranscriptStore({ io: blindIo, clock: { now: () => 4000 }, deletedAt: id => ledger.deletedAt(id), latestDeleteAt: () => ledger.latestAt() });
        failed = null;
        try { await forget('attachment-files'); } catch (e) { failed = e; }
        A.ok(failed && failed.code === 'TRANSCRIPT_UNVOUCHED' && exists(late), 'a transcript that cannot hand over every row keeps the file and fails the pass');
        hold.transcriptStore = () => store;
        A.eq(await forget('attachment-files'), 1, 'once the proof can be made, the retried pass removes the file');
        A.ok(!exists(late) && exists(old) && exists(branched), 'and only that file');
        // a file the transcript cannot rule out (a damaged line may name it, or a segment is gone for good) is kept, and the pass settles
        // instead of failing at every boot: a closed segment never changes, so a refusal would come back at every pass
        const torn = await upload('torn.txt'), mine = await upload('mine.txt');
        say('sGone', 'two more files', [torn, mine], 4200);
        const kept = [];
        hold.noteAttachmentsKept = (count, why) => kept.push([count, why]);
        const doubtIo = Object.assign({}, io, { eachRow: (visit, claims) => { io.eachRow(visit, claims); return { doubted: (claims || []).filter(c => c === torn.path), unread: [] }; } });
        hold.transcriptStore = () => Store.makeTranscriptStore({ io: doubtIo, clock: { now: () => 4000 }, deletedAt: id => ledger.deletedAt(id), latestDeleteAt: () => ledger.latestAt() });
        A.eq(await forget('attachment-files'), 1, 'the pass settles and removes what nothing may name');
        A.ok(exists(torn) && !exists(mine) && exists(old) && exists(branched), 'it keeps the file a damaged line may name, and the shared ones');
        A.eq(kept, [[1, 'a damaged transcript line may name them']], 'the station log says how many it kept and why');
        hold.transcriptStore = () => store;
        hold.noteAttachmentsKept = undefined;
        // a pass whose deleted sessions named no file reads nothing more, so a blind store cannot fail it
        const quiet = History.makeMemoryTranscriptIo();
        const quietStore = Store.makeTranscriptStore({ io: quiet, clock: { now: () => 4000 }, deletedAt: id => ledger.deletedAt(id), latestDeleteAt: () => ledger.latestAt() });
        quietStore.appendStrict({ sourceRunId: 'run_quiet', streamId: 'sGone', agentId: 'agent', role: 'user', content: 'no files here', ts: 4000, taint: null, directive: true, kind: 'turn' });
        delete quiet.eachRow;
        hold.transcriptStore = () => quietStore;
        hold.saveStore = () => ({ loadState: () => ({ status: 'corrupt' }) });
        A.eq(await forget('attachment-files'), 0, 'a deleted session that named no file needs no whole-history read and no save');
        hold.saveStore = newStation;
        // the proof itself (also the page's own delete, POST /api/attachments with paths): a packed run's residue names files, and `except`
        // leaves out a session whose delete has not reached the ledger yet
        const { namedElsewhere } = require('../sidecar/forget-wiring.js');
        const packedDoc = { workstreams: [
          { id: 'sPacked', history: [{ $ref: '1,1', res: { 1: { attachments: [{ path: '.attachments/packed.txt' }] } } }, { role: 'user', content: 'x', attachments: [{ path: '.attachments/inline.txt' }] }] },
          { id: 'sLeaving', history: [{ role: 'user', content: 'y', attachments: [{ path: '.attachments/leaving.txt' }] }] }
        ] };
        const emptyStore = Store.makeTranscriptStore({ io: History.makeMemoryTranscriptIo(), clock: { now: () => 4000 }, deletedAt: id => ledger.deletedAt(id), latestDeleteAt: () => ledger.latestAt() });
        const named = namedElsewhere({ store: emptyStore, saveStore: { loadState: () => ({ status: 'ok', doc: packedDoc }) },
          paths: ['.attachments/packed.txt', '.attachments/inline.txt', '.attachments/leaving.txt', '.attachments/none.txt'], except: ['sLeaving'] });
        A.eq(Array.from(named).sort(), ['.attachments/inline.txt', '.attachments/packed.txt'], 'a packed run\'s residue and an inline message name their files; an excepted session and nothing name none');
        // the save's own answers: 'recovered' (the station's authoritative copy) is read like 'ok'; 'absent' is a new station only while no
        // copy of a save sits beside it (a quarantined save the page has not written over yet may hold a /branch copy); no save store proves nothing
        const ask = saveStore => namedElsewhere({ store: emptyStore, saveStore, paths: ['.attachments/packed.txt', '.attachments/none.txt'] });
        const code = fn => { try { fn(); return 'none'; } catch (e) { return e && e.code; } };
        A.eq(Array.from(ask({ loadState: () => ({ status: 'recovered', doc: packedDoc }), hasRecoveryCopy: () => true })), ['.attachments/packed.txt'], 'a recovered save is read like a clean one');
        A.eq(code(() => ask({ loadState: () => ({ status: 'absent' }), hasRecoveryCopy: () => true })), 'FORGET_UNPROVEN', 'an absent save beside a kept copy proves nothing until the page writes again');
        A.eq(code(() => ask({ loadState: () => ({ status: 'absent' }) })), 'FORGET_UNPROVEN', 'a store that cannot say whether a copy is kept proves nothing either');
        A.eq(ask({ loadState: () => ({ status: 'absent' }), hasRecoveryCopy: () => false }).size, 0, 'a new station, with no save and no copy, holds no page-only copy');
        A.eq(code(() => ask(null)), 'FORGET_UNPROVEN', 'no save store at all proves nothing');
        // a claim the transcript walk doubts counts as named, the caller hears which and why, and the other claims are still proved
        const heard = [];
        const doubtingIo = Object.assign(History.makeMemoryTranscriptIo(), { eachRow: (visit, claims) => ({ doubted: (claims || []).filter(c => c === '.attachments/torn.txt'), unread: [] }) });
        const doubtingStore = Store.makeTranscriptStore({ io: doubtingIo, clock: { now: () => 4000 }, deletedAt: id => ledger.deletedAt(id), latestDeleteAt: () => ledger.latestAt() });
        const doubtedNames = namedElsewhere({ store: doubtingStore, saveStore: newStation(), paths: ['.attachments/torn.txt', '.attachments/free.txt'], onDoubt: (paths, why) => heard.push([paths, why]) });
        A.eq(Array.from(doubtedNames), ['.attachments/torn.txt'], 'a doubted claim is named; the others are not');
        A.eq(heard, [[['.attachments/torn.txt'], 'a damaged transcript line may name them']], 'and the caller hears which and why');
      } finally { remove(adir); }
    }

    // ---------------- attachment files: a damaged history cannot stop the pass ----------------
    // A damaged line or a lost segment among a deleted session's rows refuses the whole read of them at every pass (a closed segment never
    // changes). RED before: the entry threw before it removed anything, the ledger never settled, and every later delete waited behind it.
    {
      const adir = temp('attach-damaged');
      try {
        const att = makeAttachments({ fsp: fs.promises, path, crypto: require('node:crypto'), workspaces: adir, resolveInside: async (agentId, rel) => ({ base: path.join(adir, agentId), abs: path.join(adir, agentId, rel) }) });
        const upload = name => att.saveAttachment('agent', name, 'data:text/plain;base64,' + Buffer.from('notes about ' + name).toString('base64'));
        const exists = ref => fs.existsSync(path.join(adir, 'agent', ref.path));
        const root = path.join(adir, 'history');
        const ioAt = () => History.makeSegmentedTranscriptIo({ fs, path, root, segmentBytes: 2000, recentPerStream: 1200, onWarning: () => {} });
        const storeOn = io => Store.makeTranscriptStore({ io, clock: { now: () => 4000 }, ramMax: 4, ramPerStream: 3, deletedAt: id => ledger.deletedAt(id), latestDeleteAt: () => ledger.latestAt() });
        let io = ioAt(), store = storeOn(io), n = 0, filler = 0;
        const say = (streamId, words, files, ts) => store.appendStrict({ sourceRunId: 'run_torn_' + (++n), streamId, agentId: 'agent', role: 'user', content: words, ts, taint: null, directive: true, kind: 'turn', attachments: files });
        const reboot = () => { if (io.close) io.close(); io = ioAt(); store = storeOn(io); hold.transcriptStore = () => store; };
        const segment = no => path.join(root, 'segment-' + String(no).padStart(6, '0') + '.jsonl');
        const later = () => { for (let i = 0; i < 40; i++) { filler++; say('sBusy' + (filler % 6), 'filler ' + filler + ' ' + 'x'.repeat(120), [], 3000 + filler); } };   // across chats: one chat alone stops at its own RAM cap, and the old row stays in RAM
        const tear = text => { if (io.close) io.close(); fs.appendFileSync(segment(io.status().activeSegment), text); reboot(); };
        const kept = [], unread = [];
        hold.transcriptStore = () => store;
        hold.attachments = () => att;
        hold.saveStore = newStation;
        hold.noteAttachmentsKept = (count, why) => kept.push([count, why]);
        hold.noteUploadsUnread = count => unread.push(count);
        const own = await upload('own.txt');
        say('sGone', 'my file', [own], 3000);
        tear('{"streamId":"sNoise","role":"assistant","content":"half a ro');   // the fragment a killed append leaves
        later();
        reboot();
        let refused = null;
        try { store.view('proof', 'sGone', { complete: true }); } catch (e) { refused = e; }
        A.eq(refused && refused.code, 'TRANSCRIPT_UNVOUCHED', 'premise: the damaged line refuses the whole read of the deleted session\'s rows');
        A.eq(await forget('attachment-files'), 1, 'the pass settles and removes the file of the row that still parses');
        A.ok(!exists(own), 'the deleted session\'s own file goes');
        A.eq(unread, [1], 'and the log hears that a session may hold rows that can no longer be read');
        A.eq(kept, [], 'a damaged line that names no asked file keeps nothing');
        A.eq(await forget('attachment-files'), 0, 'idempotent');
        // a damaged line that names a file keeps that file and only that one
        const torn = await upload('torn.txt'), free = await upload('free.txt');
        say('sGone', 'two more files', [torn, free], 4000);
        tear('{"streamId":"sKeep","attachments":[{"path":"' + torn.path + '"');
        later();
        reboot();
        kept.length = 0;
        A.eq(await forget('attachment-files'), 1, 'the pass settles and removes what nothing may name');
        A.ok(exists(torn) && !exists(free), 'it keeps the file a damaged line may name, and only that one');
        A.eq(kept, [[1, 'a damaged transcript line may name them']], 'the log says how many it kept and why');
        // a segment gone for good among the deleted session's rows: nothing can be proved unused, and the pass still settles
        const lost = await upload('lost.txt'), survivor = await upload('survivor.txt');
        const lostNo = io.status().activeSegment;
        say('sGone', 'in the segment that will be lost', [lost], 4200);
        while (io.status().activeSegment === lostNo) later();
        say('sGone', 'in a segment that survives', [survivor], 4300);
        later();
        if (io.close) io.close();
        fs.rmSync(segment(lostNo));
        reboot();
        kept.length = 0;
        A.eq(await forget('attachment-files'), 0, 'a lost segment doubts every asked file, so nothing goes');
        A.ok(exists(lost) && exists(survivor), 'both files stay');
        A.ok(kept.length === 1 && /transcript segment \d+ is gone/.test(kept[0][1]), 'and the log says why: ' + JSON.stringify(kept));
        // a history that cannot be walked now still fails the pass, so it retries; any other error is not swallowed
        const unvouched = () => { throw Object.assign(new Error('segment 1 cannot be read now: EBUSY'), { code: 'TRANSCRIPT_UNVOUCHED' }); };
        hold.transcriptStore = () => ({ view: unvouched, eachRow: unvouched });
        let failed = null;
        try { await forget('attachment-files'); } catch (e) { failed = e; }
        A.eq(failed && failed.code, 'TRANSCRIPT_UNVOUCHED', 'a walk refused for now fails the pass, so nothing is lost to a busy segment');
        hold.transcriptStore = () => ({ view: () => { throw new Error('not a history refusal'); } });
        failed = null;
        try { await forget('attachment-files'); } catch (e) { failed = e; }
        A.eq(failed && failed.message, 'not a history refusal', 'any other error from the read is not read as a damaged history');
        // a file that cannot be removed (another program holds it open) is counted, and the pass settles
        const mem = Store.makeTranscriptStore({ io: History.makeMemoryTranscriptIo(), clock: { now: () => 4000 }, deletedAt: id => ledger.deletedAt(id), latestDeleteAt: () => ledger.latestAt() });
        mem.appendStrict({ sourceRunId: 'run_held', streamId: 'sGone', agentId: 'agent', role: 'user', content: 'a held file', ts: 4000, taint: null, directive: true, kind: 'turn', attachments: [{ path: '.attachments/held.txt' }] });
        hold.transcriptStore = () => mem;
        hold.attachments = () => ({ hasAttachment: async () => true, removeAttachment: async () => ({ ok: false, error: 'remove failed' }) });
        kept.length = 0;
        A.eq(await forget('attachment-files'), 0, 'a file that cannot be removed is not counted as removed');
        A.eq(kept, [[1, 'they could not be removed, another program may have them open']], 'the log says how many stayed and why');
        hold.noteAttachmentsKept = undefined;
        hold.noteUploadsUnread = undefined;
      } finally { remove(adir); }
    }

    // ---------------- attachment files: the restore points that hold them (contract A17 iii) ----------------
    {
      const adir = temp('attach-checkpoints');
      try {
        const fsp = fs.promises;
        const att = makeAttachments({ fsp, path, crypto: require('node:crypto'), workspaces: adir, resolveInside: async (agentId, rel) => ({ base: path.join(adir, agentId), abs: path.join(adir, agentId, rel) }) });
        const f = await att.saveAttachment('agent', 'plan.txt', 'data:text/plain;base64,' + Buffer.from('notes about plan').toString('base64'));
        const g = await att.saveAttachment('agent', 'other.txt', 'data:text/plain;base64,' + Buffer.from('notes about other').toString('base64'));
        const io = History.makeMemoryTranscriptIo();
        const store = Store.makeTranscriptStore({ io, clock: { now: () => 4000 }, deletedAt: id => ledger.deletedAt(id), latestDeleteAt: () => ledger.latestAt() });
        store.appendStrict({ sourceRunId: 'run_sGone', streamId: 'sGone', agentId: 'agent', ts: 4000, taint: null, role: 'user', content: 'plan', directive: true, kind: 'turn', attachments: [f] });
        store.appendStrict({ sourceRunId: 'run_sKeep', streamId: 'sKeep', agentId: 'agent', ts: 4000, taint: null, role: 'user', content: 'other', directive: true, kind: 'turn', attachments: [g] });
        hold.transcriptStore = () => store;
        hold.attachments = () => att;
        const calls = [], noted = [];
        hold.checkpoints = () => ({ forgetAttachments: async (agentId, paths) => { calls.push([agentId, paths.slice().sort()]); return { held: true, reinit: agentId === 'agent' }; } });
        hold.noteCheckpointReset = ids => noted.push(ids.slice());
        A.eq(await forget('attachment-files'), 1, 'the deleted session\'s file is removed');
        A.eq(calls, [['agent', [f.path]]], 'the agent\'s restore points are asked about exactly the paths the delete doomed (not another session\'s file)');
        A.eq(noted, [['agent']], 'and the receipt names the agent whose older rollback points were reset');
        A.eq(await forget('attachment-files'), 0, 'idempotent: nothing left to remove');
        A.eq(calls.length, 2, 'a second pass asks again (the file may have gone in a pass that failed before its restore points were checked); the store itself is idempotent');
        hold.checkpoints = () => ({ forgetAttachments: async () => { throw new Error('the shadow history could not be searched'); } });
        const g2 = await att.saveAttachment('agent', 'again.txt', 'data:text/plain;base64,' + Buffer.from('again').toString('base64'));
        store.appendStrict({ sourceRunId: 'run_sGone2', streamId: 'sGone', agentId: 'agent', ts: 4100, taint: null, role: 'user', content: 'again', directive: true, kind: 'turn', attachments: [g2] });
        let failed = null;
        try { await forget('attachment-files'); } catch (e) { failed = e; }
        A.ok(failed && /could not be searched/.test(failed.message), 'a restore-point history that cannot be searched fails the pass (the delete is retried at the next boot), never a silent skip');
        hold.checkpoints = undefined; hold.noteCheckpointReset = undefined;
      } finally { remove(adir); }
    }

    // ---------------- conversation summaries (CB .summaries, contract A14 i) ----------------
    {
      const SummaryLedger = require('../sidecar/summary-ledger.js');
      const sdir = temp('summaries');
      try {
        const note = text => '<conversation_summary>\n' + text + '\n</conversation_summary>';
        const rowsOf = (streamId, n) => Array.from({ length: n }, (_, k) => ({ rowId: 100 + k * 3, streamId, role: k % 2 === 0 ? 'user' : 'assistant', content: (k % 2 === 0 ? 'ask ' : 'answer ') + k, ts: 1000 + k }));
        // the ledger as the host builds it: its own deletedAt reads the session ledger, and its dir is the dot-prefixed one
        const sum = SummaryLedger.makeSummaryLedger({ fs, path, dir: path.join(sdir, SummaryLedger.DIR_NAME), now: () => 4000, redact: t => t, deletedAt: id => ledger.deletedAt(id), deletedSince: at => ledger.list().some(e => e.at >= at) });
        const put = (streamId, over) => sum.put(Object.assign({ streamId, agentId: 'agent' }, SummaryLedger.claimOf(rowsOf(streamId, 6), 6), { noteBody: note('S1 of ' + streamId), modelKey: 'm', windowTokens: 32000,
          ownerVoice: true, taint: null, quoted: false, quotes: [], quotesAt: [], runId: 'run_' + streamId, runStartedAt: 3000 }, over || {}));
        const own = await put('sOwnGone', {}), reader = await put('sKeep', { quotes: ['sGone'], quotesAt: [3500] }), bystander = await put('sOther', {});
        // the deleted chat's own summary was written before its delete was learned: a ledger that does not know of the delete keeps it
        const pre = SummaryLedger.makeSummaryLedger({ fs, path, dir: path.join(sdir, SummaryLedger.DIR_NAME), now: () => 4000, redact: t => t, deletedAt: () => 0 });
        const gone = await pre.put(Object.assign({ streamId: 'sGone', agentId: 'agent' }, SummaryLedger.claimOf(rowsOf('sGone', 6), 6), { noteBody: note('S1 of sGone'), modelKey: 'm', windowTokens: 32000,
          ownerVoice: true, taint: null, quoted: false, quotes: [], quotesAt: [], runId: 'run_sGone', runStartedAt: 3000 }));
        A.ok(own.ok && reader.ok && bystander.ok && gone.ok, 'four summaries are kept: a plain one, one whose rows read the deleted session, a bystander and the deleted chat itself');
        const late = await put('sGone', { runStartedAt: 3000 });
        A.ok(!late.ok && late.reason === 'tombstoned', 'the ledger refuses a put for a chat deleted at or after the run began (the ledger keeps its own gate)');
        hold.summaryLedger = () => sum;
        const files = () => fs.readdirSync(path.join(sdir, SummaryLedger.DIR_NAME)).sort();
        A.ok(files().includes('sKeep.json') && files().includes('sGone.json'), 'before the purge both the reader\'s and the deleted chat\'s summary files are on disk');
        const out = await forget('conversation-summary');
        A.eq(out.removed, 2, 'the purge counts the deleted chat record and the one that read it');
        A.ok(!files().includes('sKeep.json') && !files().includes('sGone.json'), 'the summary that quoted the deleted session is gone (quote-forget) and so is the deleted chat\'s file');
        A.ok(files().includes('sOwnGone.json') && files().includes('sOther.json'), 'summaries of other chats are untouched');
        A.eq((await forget('conversation-summary')).removed, 0, 'idempotent');
        // the write gate: the registry entry's sourceOf is what index.js asks admit() before a put
        const entry = registry.entry('conversation-summary');
        const src = r => entry.sourceOf(Object.assign({ streamId: 'sKeep', runId: 'run_new', fromRowId: 100, toRowId: 115, quotes: [], quotesAt: [], runStartedAt: 3000 }, r || {}));
        A.ok(registry.admit(src({ runStartedAt: 6000 })), 'admit lets a summary of a live chat through');
        A.ok(!registry.admit(src({ quotes: ['sGone'], quotesAt: [3500] })), 'admit refuses a summary whose covered rows read the deleted session');
        A.ok(!registry.admit(src({ streamId: 'sGone', runStartedAt: 3000 })), 'admit refuses a summary of the deleted chat written by a run that began before the delete');
        A.ok(!registry.admit(src({ runId: 'r_gone' })), 'admit refuses a summary written by a run of the deleted session');
      } finally { remove(sdir); }
    }

    // ---------------- group sessions ----------------
    {
      const gdir = temp('groups');
      let groups = null;
      try {
        let seq = 4000;
        // group ids are minted by the host: the first group is the one the Commander deletes (its id is its workstream's)
        const ids = ['sGone', 'gm1', 'sKeep', 'gm2', 'gm3', 'gm4', 'gm5', 'gm6', 'gm7', 'gm8', 'gm9'];
        groups = makeGroupSessions({ fs, path, root: gdir, now: () => ++seq, id: () => ids.shift() || ('x' + (++seq)), log: () => {},
          roster: () => [{ id: 'agent', name: 'Lead' }, { id: 'research', name: 'Researcher' }],
          execute: async o => { o.emit('agent.run.start', { runId: o.runId }); return { reason: 'done', messages: [{ role: 'assistant', content: 'done' }] }; },
          readFile: async () => ({ name: 'r.md', content: 'aGVsbG8=', bytes: 5, hash: 'h' }), decodeFile: f => ({ text: 'hello', hash: f.hash }), uploadFile: (name, content) => ({ name, content, hash: 'h' }) });
        await groups.ready;
        const gone = await groups.create({ members: ['agent', 'research'], title: 'Quokka group' });
        await groups.send(gone.id, { key: 'k1', text: '@Researcher tell me about quokka habitats' }); await groups.idle(gone.id);
        const keep = await groups.create({ members: ['agent', 'research'], title: 'Platypus group' });
        await groups.send(keep.id, { key: 'k2', text: '@Researcher tell me about platypus nests' }); await groups.idle(keep.id);
        A.eq(gone.id, 'sGone', 'the group the Commander deletes is filed under its workstream id');
        hold.groupSessions = () => groups;
        const file = path.join(gdir, 'group-sessions.json');
        A.ok(/quokka habitats/.test(fs.readFileSync(file, 'utf8')), 'before the purge the group file holds the deleted session\'s message');
        A.eq(await forget('group-sessions'), 1, 'the group filed under the deleted session is deleted');
        const disk = [file, file + '.bak'].filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f, 'utf8')).join('\n');
        A.ok(!/quokka/i.test(disk), 'neither group-sessions.json nor its .bak holds its words');
        const left = (await groups.list()).groups.map(g => g.id);
        A.eq(left, [keep.id], 'only the other session\'s group is listed');
        A.ok(/platypus nests/.test(JSON.stringify(await groups.get(keep.id))), 'and its messages are intact');
        A.eq(await forget('group-sessions'), 0, 'idempotent');
      } finally { if (groups) groups.close(); remove(gdir); }
    }

    // ---------------- the run journal: a run that began in a deleted session is never continued ----------------
    {
      const recoveryForgotten = new Function('journalQuotesForgotten', 'sessionTombstones', sidecarTopLevelFunction('runRecoveryForgotten') + '\nreturn runRecoveryForgotten;')(journalQuotesForgotten, ledger);
      A.ok(recoveryForgotten({ meta: { streamId: 'sGone', startedAt: 4100 }, quotes: [], firstTs: 4100 }), 'an interrupted run that began in the deleted session is forgotten: not offered, prepared or continued');
      A.ok(!recoveryForgotten({ meta: { streamId: 'sGone', startedAt: 6000 }, quotes: [], firstTs: 6000 }), '...one that began after the delete (a re-opened session) is not');
      A.ok(!recoveryForgotten({ meta: { streamId: 'sKeep', startedAt: 4100 }, quotes: [], firstTs: 4100 }), '...nor one in another session');
      A.ok(recoveryForgotten({ meta: { streamId: 'sKeep', startedAt: 4100 }, quotes: [{ id: 'sGone', at: 4400 }], firstTs: 4100 }), '...and the quote rule (commit 11) still applies to a run that read the deleted session');
      A.ok(!recoveryForgotten({ meta: {}, quotes: [], firstTs: 0 }) && !recoveryForgotten(null), 'a record with no stream is not forgotten by this rule');
    }

    A.report('forget-stores');
  } finally { remove(dir); }
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
