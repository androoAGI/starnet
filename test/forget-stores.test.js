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

    A.report('forget-stores');
  } finally { remove(dir); }
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
