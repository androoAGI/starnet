/* node test/forget-registry.test.js - THE FORGET REGISTRY'S OWN RULES (turn identity commits 11 and 12; qa/bugs/3e926b6a, 31042fab).

   sidecar/forget-registry.js is pure: no store, no fs, no clock. What it owns, and what this proves with a fake ledger:

     1. viewRun(record, { deletedAt, latestDeleteAt }) is a FILTER: the SAME object when a run is visible (a cut_short run, a run
        carrying a failureCode and a clarifying outcome come back untouched, so typed outcomes and titles reach every reader as
        filed), null when it is forgotten by any of the three rules (its session was deleted at or after it was filed; it quotes a
        session deleted at or after the read began; it is saturated and a non-adopted delete is stamped at or after its saturation).
     2. register / exempt / seal: a store needs a name, a sourceOf and a forget; a name is used once; an exemption needs a reason; a
        purge pass before the wiring is sealed is deferred (so no delete is ever marked purged by a registry with no stores).
     3. forgetAll runs every store even when one fails, then throws, so the caller marks nothing purged and retries.
     4. admit(src) is the write-time gate: a derived write whose source session was deleted, whose source row is unprovable or
        forgotten, whose writing run quoted a deleted session or is itself forgotten is refused; a session re-opened after its
        delete (its row proves newer) is heard again. forgotten(src) is the read-time belt and never counts an adopted stamp.
     5. The scope the stores purge by (session-tombstones deletedScope): the runs a deleted session held AND the runs that quote it
        or are saturated, and inScope's time rule (a record written after the delete is not the deleted session's).
     6. The ledger side of the catch-up: freshAt skips adopted stamps, and repurge(version) re-opens every non-adopted purged stamp
        once per registry version and never an adopted one. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ForgetRegistry = require('../sidecar/forget-registry.js');
const SessionTombstones = require('../sidecar/session-tombstones.js');

const deepFreeze = x => { if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); for (const v of Object.values(x)) deepFreeze(v); } return x; };

(async () => {
  // a ledger fake: S deleted at 50, A was deleted before the ledger's first read (adopted) at 5
  const stamps = { S: 50, A: 5 };
  let latest = 50;
  const ctx = { deletedAt: id => stamps[id] || 0, latestDeleteAt: () => latest };

  // ---------------- 1. viewRun is a filter that never copies ----------------
  {
    const cut = deepFreeze({ runId: 'r1', streamId: 'T', ts: 70, outcome: 'cut_short', reason: 'done', title: 'a cut run' });
    const failed = deepFreeze({ runId: 'r2', streamId: 'T', ts: 70, outcome: 'failed', failureCode: 'provider_timeout', clarifying: { question: 'which?' }, title: 'a failed run' });
    A.ok(ForgetRegistry.viewRun(cut, ctx) === cut, 'a visible cut_short run comes back as the SAME object');
    A.ok(ForgetRegistry.viewRun(failed, ctx) === failed, 'a visible failed run (failureCode, clarifying) comes back as the SAME object');
    A.eq(ForgetRegistry.viewRun(deepFreeze({ runId: 'r3', streamId: 'S', ts: 40 }), ctx), null, 'a run filed in a deleted session at or before its delete is forgotten (tombstone rule)');
    A.ok(ForgetRegistry.viewRun(deepFreeze({ runId: 'r3b', streamId: 'S', ts: 60 }), ctx) !== null, '...a run filed in the same session AFTER the delete (a re-open) is not');
    A.eq(ForgetRegistry.viewRun(deepFreeze({ runId: 'r4', streamId: 'T', ts: 70, quotes: ['S'], quotesAt: [30] }), ctx), null, 'a run that quotes a session deleted after the read began is forgotten (quote rule), whatever its own ts says');
    A.ok(ForgetRegistry.viewRun(deepFreeze({ runId: 'r4b', streamId: 'T', ts: 70, quotes: ['S'], quotesAt: [60] }), ctx) !== null, '...a quote read AFTER the delete is not (the rule is keyed to the read)');
    A.eq(ForgetRegistry.viewRun(deepFreeze({ runId: 'r5', streamId: 'T', ts: 70, quotes: ['*'], quotesAt: [20] }), ctx), null, 'a saturated run is forgotten once a non-adopted delete is stamped at or after its saturation');
    A.eq(ForgetRegistry.viewRun(deepFreeze({ runId: 'r5b', streamId: 'T', ts: 70, quotesSaturatedAt: 20 }), ctx), null, '...the record field quotesSaturatedAt is the same rule');
    latest = 10;
    A.ok(ForgetRegistry.viewRun(deepFreeze({ runId: 'r6', streamId: 'T', ts: 70, quotes: ['*'], quotesAt: [20] }), ctx) !== null, 'a delete stamped BEFORE the saturation does not forget a saturated run');
    latest = 50;
    A.eq(ForgetRegistry.viewRun(null, ctx), null, 'a missing record is returned as it came (null)');
    A.eq(ForgetRegistry.viewRun(undefined, ctx), undefined, '...and undefined stays undefined');
    A.ok(ForgetRegistry.viewRun(cut, {}) === cut, 'with no ledger a record is visible (nothing is forgotten without a stamp)');
  }

  // ---------------- 2. register / exempt / seal ----------------
  {
    const reg = ForgetRegistry.make({});
    A.throws(() => reg.register({ name: '', forget() {}, sourceOf() {} }), 'a store needs a name');
    A.throws(() => reg.register({ name: 'x1', sourceOf() {} }), 'a store needs a forget function');
    A.throws(() => reg.register({ name: 'x2', forget() {} }), 'a store needs a sourceOf (the source it records)');
    reg.register({ name: 'alpha', sourceOf: r => ({ runIds: [r.runId] }), forget: () => 0 });
    A.throws(() => reg.register({ name: 'alpha', sourceOf() {}, forget() {} }), 'a name is registered once');
    A.throws(() => reg.exempt('alpha', 'registered above, so it cannot also be exempt'), 'a registered store cannot also be exempt');
    A.throws(() => reg.exempt('beta', 'short'), 'an exemption needs a real reason');
    reg.exempt('beta', 'the Commander created it and keeps it (Q4)');
    A.eq(reg.names(), ['alpha'], 'names() lists the registered stores');
    A.eq(Object.keys(reg.exemptions()), ['beta'], 'exemptions() lists the exempt ones with their reasons');
    A.eq(reg.ready(), false, 'a registry is not ready before it is sealed');
    const before = await reg.forgetAll({ streams: new Map(), runIds: new Set(), rowIds: new Set() });
    A.ok(before.deferred === true && before.ran.length === 0, 'a purge pass before the wiring is sealed is DEFERRED, so no delete is marked purged by an empty registry');
    reg.seal();
    A.ok(reg.ready(), 'sealed');
    A.throws(() => reg.register({ name: 'late', sourceOf() {}, forget() {} }), 'nothing registers after the seal');
  }

  // ---------------- 3. forgetAll runs everything, then fails loudly ----------------
  {
    const notes = [];
    const reg = ForgetRegistry.make({ note: (tag, e) => notes.push(tag + ':' + (e && e.message)) });
    const ran = [];
    const scope = { streams: new Map([['S', 50]]), runIds: new Set(['r1']), rowIds: new Set() };
    reg.register({ name: 'one', sourceOf: () => ({}), forget: s => { ran.push('one'); return { removed: 2, extra: true }; } });
    reg.register({ name: 'two', sourceOf: () => ({}), forget: async () => { ran.push('two'); throw new Error('disk full'); } });
    reg.register({ name: 'three', sourceOf: () => ({}), forget: s => { ran.push('three:' + s.runIds.has('r1')); return 3; } });
    reg.seal();
    let thrown = null; try { await reg.forgetAll(scope); } catch (e) { thrown = e; }
    A.eq(ran, ['one', 'two', 'three:true'], 'every store ran even though the second failed, each with the scope');
    A.ok(thrown && /two/.test(thrown.message) && thrown.failed.length === 1, 'the pass then throws and names the store that failed, so the caller records nothing as purged');
    A.eq(thrown.result.removed, { one: 2, three: 3 }, '...and carries what the others removed');
    A.ok(notes.some(n => /^forget\.two:disk full/.test(n)), '...and the failure is noted, not silent');
    const ok = ForgetRegistry.make({});
    ok.register({ name: 'only', sourceOf: () => ({}), forget: () => ({ removed: 4 }) });
    ok.seal();
    const done = await ok.forgetAll(scope);
    A.eq([done.removed, done.deferred, done.failed.length], [{ only: 4 }, false, 0], 'a clean pass reports what each store removed');
  }

  // ---------------- 4. admit (write time) and forgotten (read time) ----------------
  {
    const adopted = { A: 5 };                       // A's stamp came from the first read
    const fresh = id => (adopted[id] ? 0 : (stamps[id] || 0));
    const live = new Set(['rqd']);                  // a run that is itself forgotten
    const rows = new Map([['S:11', true], ['S:12', false], ['T:21', false], ['T:22', true], ['T:23', null]]);   // the store's per-row verdict
    const reg = ForgetRegistry.make({
      deletedAt: id => stamps[id] || 0, freshDeletedAt: fresh, latestDeleteAt: () => latest,
      rowVerdict: (streamId, rowId) => (rows.has(streamId + ':' + rowId) ? rows.get(streamId + ':' + rowId) : null),
      runForgotten: runId => live.has(runId)
    });
    A.ok(reg.admit({ streamId: 'T', runId: 'r9', rowId: 21 }), 'a source row of a live session is admitted');
    A.ok(!reg.admit({ streamId: 'S', runId: 'r9', rowId: 11 }), 'a source row of a deleted session is refused');
    A.ok(reg.admit({ streamId: 'S', rowId: 12 }), 'a row of a re-opened session that the store does not forget (written after the delete) is admitted');
    A.ok(!reg.admit({ streamId: 'T', rowId: 22 }), 'a quote-forgotten row of a live session is refused (the store says so)');
    A.ok(!reg.admit({ streamId: 'T', rowId: 23 }), 'a row the store cannot read is unprovable and refused (fail closed)');
    A.ok(!reg.admit({ streamId: 'S', at: 40 }), 'with no row proof a source written at or before the delete is refused');
    A.ok(reg.admit({ streamId: 'S', at: 60 }), '...one written after it (a re-open) is admitted');
    A.ok(!reg.admit({ streamId: 'S' }), '...and a source with no time at all is refused (conservative)');
    A.ok(!reg.admit({ runId: 'rqd' }), 'a source run that is itself forgotten is refused');
    A.ok(!reg.admit({ streamId: 'T', rowId: 21, quotes: ['S'], quotesAt: [30] }), 'a writing run whose latch holds a session deleted after the read began is refused');
    A.ok(reg.admit({ streamId: 'T', rowId: 21, quotes: ['S'], quotesAt: [60] }), '...a read begun after the delete is not');
    A.ok(!reg.admit({ streamId: 'T', rowId: 21, quotes: ['*'], quotesAt: [20] }), 'a saturated writer is refused once a delete is stamped at or after its saturation');
    A.ok(!reg.admit({ streamId: 'T', rowId: 21, quotesSaturatedAt: 20 }), '...by the record field too');
    A.ok(reg.admit({}), 'a source that names nothing deleted is admitted');
    const stats = reg.stats();
    A.ok(stats.admitted >= 5 && stats.refused.stream >= 2 && stats.refused.unprovable >= 1 && stats.refused.quotes >= 3 && stats.refused.run === 1, 'admitted and refused writes are counted by reason: ' + JSON.stringify(stats));
    // the read-time belt: adopted stamps never count (I7 limit d)
    A.ok(reg.forgotten({ streamId: 'S', at: 40 }), 'the belt forgets a record of a session the Commander deleted');
    A.ok(!reg.forgotten({ streamId: 'S', at: 60 }), '...and hears a re-open');
    A.ok(!reg.forgotten({ streamId: 'A', at: 1 }), 'the belt never drops a record of a session deleted before the first read (adopted: its memory is kept)');
    A.ok(!reg.forgotten({ streamId: 'T', quotes: ['A'], quotesAt: [0] }), '...nor a quote of one');
    A.ok(reg.forgotten({ runId: 'rqd' }), 'the belt forgets a record sourced from a forgotten run');
    const throwing = ForgetRegistry.make({ deletedAt: () => { throw new Error('ledger gone'); }, note: () => {} });
    A.ok(!throwing.admit({ streamId: 'S', at: 1 }), 'a ledger that throws refuses the write (fail closed)');
    A.ok(throwing.forgotten({ streamId: 'S', at: 1 }), '...and the belt forgets (fail closed)');
    const ledgerless = ForgetRegistry.make({});
    A.ok(ledgerless.admit({ streamId: 'S', at: 1 }), 'with no ledger wired nothing is deleted, so a write is admitted (the host always wires one)');
  }

  // ---------------- 5. scope: stream-bound AND quote-bound runs ----------------
  {
    const runs = [
      { runId: 'inS', streamId: 'S', ts: 40 },                                         // held by the deleted session
      { runId: 'afterS', streamId: 'S', ts: 60 },                                       // filed after the delete (a re-open): not its
      { runId: 'readsS', streamId: 'T', ts: 70, quotes: ['S'], quotesAt: [30] },        // read S before the delete
      { runId: 'readsSLate', streamId: 'T', ts: 70, quotes: ['S'], quotesAt: [55] },    // read S after the delete: not forgotten
      { runId: 'sat', streamId: 'T', ts: 70, quotes: ['*'], quotesAt: [20] },           // saturated before the delete
      { runId: 'satRec', streamId: 'T', ts: 70, quotesSaturatedAt: 45 },
      { runId: 'satLate', streamId: 'T', ts: 70, quotes: ['*'], quotesAt: [80] },       // saturated after it
      { runId: 'plain', streamId: 'T', ts: 70 }
    ];
    const scope = SessionTombstones.deletedScope([{ id: 'S', at: 50 }], runs);
    A.eq(Array.from(scope.runIds).sort(), ['inS', 'readsS', 'sat', 'satRec'], 'the scope holds the runs the session held AND the runs that quote it or are saturated');
    A.ok(scope.streams instanceof Map && scope.streams.get('S') === 50 && scope.at === scope.streams && scope.rowIds instanceof Set, 'scope = { streams, runIds, rowIds } (at stays for the older readers)');
    A.eq(Array.from(SessionTombstones.deletedScope([], runs).runIds), [], 'no delete, no scope');
    A.ok(ForgetRegistry.inScope({ streamIds: ['S'], at: 40 }, scope), 'a record written in the deleted session before the delete is in scope');
    A.ok(!ForgetRegistry.inScope({ streamIds: ['S'], at: 60 }, scope), '...one written after it is not');
    A.ok(ForgetRegistry.inScope({ runIds: ['readsS'] }, scope) && !ForgetRegistry.inScope({ runId: 'plain' }, scope), 'a record sourced from a scoped run is in scope, from another run is not');
    // a quote stamp is in scope by the one quote rule
    A.ok(ForgetRegistry.inScope({ quotes: ['S'], quotesAt: [30] }, scope), 'a record that quotes a session deleted after the read began is in scope');
    A.ok(!ForgetRegistry.inScope({ quotes: ['S'], quotesAt: [55] }, scope), '...one whose read began after the delete is not');
    A.ok(ForgetRegistry.inScope({ quotes: ['*'], quotesAt: [20] }, scope) && !ForgetRegistry.inScope({ quotes: ['*'], quotesAt: [80] }, scope), 'a saturated stamp is in scope once a delete is stamped at or after it');
    A.eq(ForgetRegistry.stampOf({ quotes: ['S', 'S', 3, 'T'], quotesAt: [9, 4, 1, 'x'] }), { quotes: ['S', 'T'], quotesAt: [4, 0] }, 'stampOf reads a stored stamp back in its canonical form (earliest read per stream, bad entries dropped)');
    A.eq(ForgetRegistry.stampOf({}), {}, '...and an empty record quotes nothing');
    A.eq(ForgetRegistry.stampOf({ quotes: Array.from({ length: 40 }, (_, i) => 's' + i), quotesAt: [5] }), { quotes: ['*'], quotesAt: [0] }, '...more than the room saturates');
    scope.rowIds.add(77);
    A.ok(ForgetRegistry.inScope({ rowId: 77 }, scope) && !ForgetRegistry.inScope({ rowId: 78 }, scope), 'a named row is in scope');
    A.ok(!ForgetRegistry.inScope({}, scope) && !ForgetRegistry.inScope(null, scope) && !ForgetRegistry.inScope({ runId: 'inS' }, null), 'an empty source or scope is in no scope');
    // the older stream-only callers still get what they got: forgetSessionMemory with no scope computes its own
    const legacy = SessionTombstones._internals.deletedScope([{ id: 'S', at: 50 }], [{ runId: 'inS', streamId: 'S', ts: 40 }]);
    A.ok(legacy.at.get('S') === 50 && legacy.runIds.has('inS'), 'deletedScope keeps its older shape');
  }

  // ---------------- 6. the ledger: freshAt and the purgedV catch-up ----------------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-forget-registry-'));
    try {
      let clock = 1000;
      const file = path.join(dir, 'session-tombstones.json');
      let t = SessionTombstones.makeSessionTombstones({ fs, path, file, now: () => clock });
      t.observe(['first'], ['first', 'also']);                     // the first read: adopted, born purged
      A.eq([t.freshAt('first'), t.deletedAt('first')], [0, 1000], 'an adopted stamp answers deletedAt but not freshAt');
      clock = 2000; t.observe(['first', 'second']);                // a real delete
      clock = 3000; t.observe(['first', 'second', 'third']);
      A.eq([t.freshAt('second'), t.freshAt('third'), t.freshAt('never')], [2000, 3000, 0], 'a Commander delete answers freshAt');
      t.markPurged(t.unpurged());
      A.eq(t.unpurged(), [], 'both deletes are purged');
      A.eq(t.purgedV(), 0, 'a ledger written before the registry has no purgedV');
      A.eq(t.repurge(1), 2, 'registry version 1 re-opens the two non-adopted purged stamps, once');
      A.eq(t.unpurged().map(e => e.id), ['second', 'third'], '...and never the adopted one');
      A.eq(t.repurge(1), 0, 'the same version is not run again');
      t.markPurged(t.unpurged());
      const reload = SessionTombstones.makeSessionTombstones({ fs, path, file, now: () => clock });
      A.eq([reload.purgedV(), reload.unpurged().length], [1, 0], 'the version survives a restart and the re-run pass stays done');
      A.eq(reload.repurge(2), 2, 'a later registry version re-runs them again');
      A.eq(reload.repurge(1), 0, '...and an older one never lowers the version');
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      A.eq(stored.value.purgedV, 2, 'purgedV is written beside the stamps');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  A.report('forget-registry');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
