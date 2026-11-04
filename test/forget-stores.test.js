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

    A.report('forget-stores');
  } finally { remove(dir); }
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
