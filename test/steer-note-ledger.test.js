/* node test/steer-note-ledger.test.js — the station knows which SEND NOW notes a run READ (0.13.5 live walk, 2026-10-14).

   Found on the 0.13.5 candidate: a note sent with SEND NOW while the lead was inside a ~35 s foreground hand-off was
   accepted (steer 200); a page reload then cancelled that run, and the note was gone — not in the message box, not in
   the history. The page kept its sent-now list in memory only, and the station could not say afterwards which notes
   the run had folded in: the durable transcript skips the loop's <steering_note> system messages, and the steer buffer
   forgot the run at teardown.

   The truth source this locks (sidecar/steer-buffer.js + runstore `steerNotes`):
     · a note posted WITH a page-made noteId is tracked per run: pending → applied (the loop drained + folded it, the
       same moment it streams its '[steering]' echo) or unapplied (the loop closed, or the host dropped, the buffer
       with it still pending — the run never read it);
     · the ledger outlives the run's teardown (bounded), and the run's durable record carries it, so a page that lost
       its memory can ask GET /api/run/steer?runId= after the run is gone — and after a station restart;
     · a retried POST of the same noteId is never buffered (or folded) twice;
     · a note without an id (/steer, channel steers, background-exit wakes) keeps the exact old shape and behavior. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const SB = require('../sidecar/steer-buffer.js');
const { makeRunStore } = require('../sidecar/runstore.js');

const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });
function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  return { seq, emit: makeEmitter(bus, () => {}) };
}

(async () => {
  // ── 1. the buffer's ledger, by hand ──
  {
    const b = SB.makeSteerBuffers({ maxPending: 8, maxNoteChars: 2000 });
    A.eq(typeof b.status, 'function', 'the buffer answers which notes a run read (status)');
    A.eq(typeof b.ledgerOf, 'function', 'and hands the run record its ledger (ledgerOf)');
    const p1 = b.post('r1', 'use the blue folder', true, 'sn1');
    A.eq([p1.status, p1.body], [200, { ok: true, pending: 1, noteId: 'sn1' }], 'a note with an id is accepted and named back');
    const p2 = b.post('r1', 'from /steer', true);
    A.eq(p2.body, { ok: true, pending: 2 }, 'a note without an id keeps the exact old success shape');
    const dup = b.post('r1', 'use the blue folder', true, 'sn1');
    A.eq([dup.status, dup.body.ok, b.pending('r1')], [200, true, 2], 'a retried POST of the same note is never buffered twice');
    A.eq(b.post('r1', 'bad id', true, '../etc').body, { ok: true, pending: 3 }, 'an id outside [A-Za-z0-9_-]{1,64} is ignored (untracked note, old shape)');
    A.eq(b.status('r1'), { ended: false, notes: { sn1: 'pending' } }, 'while it waits in the buffer the note is pending');
    A.eq(b.drain('r1'), ['use the blue folder', 'from /steer', 'bad id'], 'the loop still drains plain note texts');
    A.eq(b.status('r1').notes.sn1, 'applied', 'drained = folded into the run = read');
    b.post('r1', 'make it short', true, 'sn2');
    A.eq(b.close('r1'), ['make it short'], 'close still hands the loop its never-applied texts');
    A.eq(b.status('r1'), { ended: true, notes: { sn1: 'applied', sn2: 'unapplied' } }, 'a note still pending when the loop closed was never read');
    const late = b.post('r1', 'too late', true, 'sn3');
    A.eq(late.status, 409, 'after close the run refuses (unchanged)');
    A.eq('sn3' in b.status('r1').notes, false, 'and a refused note is not in the ledger (the station never took it)');
    b.drop('r1');
    A.eq(b.status('r1'), { ended: true, notes: { sn1: 'applied', sn2: 'unapplied' } }, 'the ledger outlives the host teardown (drop)');
    A.eq(b.ledgerOf('r1'), [{ id: 'sn1', applied: true }, { id: 'sn2', applied: false }], 'ledgerOf is what the run record keeps');
    A.eq(b.status('nope'), null, 'a run the buffer never tracked answers null (unknown, never "unread")');
    A.eq(b.ledgerOf('nope'), [], 'and gives the record nothing');
    // drop of a run whose loop never closed: its pending note was never read
    b.post('r2', 'orphan', true, 'sn4');
    A.eq(b.drop('r2'), ['orphan'], 'drop still returns leftovers for the host log');
    A.eq(b.status('r2'), { ended: true, notes: { sn4: 'unapplied' } }, 'a note dropped at teardown was never read');
    // bounded: the oldest tracked run goes first
    const s = SB.makeSteerBuffers({ maxLedger: 2 });
    s.post('a', 'x', true, 'n1'); s.post('b', 'x', true, 'n2'); s.post('c', 'x', true, 'n3');
    A.eq([s.status('a'), !!s.status('b'), !!s.status('c')], [null, true, true], 'the ledger keeps at most maxLedger runs');
  }

  // ── 2. the REAL loop decides read vs unread ──
  {
    // a note posted while a tool runs is folded before the next model call → applied
    const { seq, emit } = setup();
    const b = SB.makeSteerBuffers({});
    const reg = makeRegistry();
    reg.register({ name: 'slow_handoff', schema: { type: 'object', properties: {} }, run: async () => { b.post('r3', 'use the blue folder', true, 'snA'); return 'handed off'; } });
    const provider = makeReplayProvider({ turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: 'slow_handoff' }, { type: 'tool_args', index: 0, chunk: '{}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'done' }, { type: 'done', finishReason: 'stop' }]
    ] });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r3', tools: [], limits: { maxIters: 4, grace: false },
      dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx(), steer: () => b.drain('r3'), steerClose: () => b.close('r3') });
    A.eq(res.reason, 'done', 'the steered run completes');
    A.ok(seq.some(e => e.name === 'agent.token' && e.payload.delta === '\n[steering] use the blue folder\n'), 'its echo streamed');
    A.eq(b.status('r3'), { ended: true, notes: { snA: 'applied' } }, 'and the ledger says the run read it');
  }
  {
    // the page reloads mid hand-off: the run is cancelled before its next step → the note was never read
    const { emit } = setup();
    const b = SB.makeSteerBuffers({});
    const ac = new AbortController();
    const reg = makeRegistry();
    reg.register({ name: 'slow_handoff', schema: { type: 'object', properties: {} }, run: async () => { b.post('r4', 'use the blue folder', true, 'snB'); ac.abort(); return 'handed off'; } });
    const provider = makeReplayProvider({ turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: 'slow_handoff' }, { type: 'tool_args', index: 0, chunk: '{}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'never' }, { type: 'done', finishReason: 'stop' }]
    ] });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'a', runId: 'r4', tools: [], limits: { maxIters: 4, grace: false }, signal: ac.signal,
      dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx(), steer: () => b.drain('r4'), steerClose: () => b.close('r4') });
    A.eq(res.reason, 'cancelled', 'the reload cancelled the run');
    A.eq(b.status('r4'), { ended: true, notes: { snB: 'unapplied' } }, 'the ledger says the run never read the note');
  }

  // ── 3. GET /api/run/steer's answer: this process's memory, else the run's durable record, else "no record" ──
  {
    A.eq(typeof SB.steerNoteStatus, 'function', 'the route answer is a pure function');
    A.eq(SB.steerNoteStatus('r1', { live: false, memory: { ended: true, notes: { sn1: 'applied' } }, record: null }),
      { runId: 'r1', live: false, ended: true, source: 'memory', notes: { sn1: 'applied' } }, 'memory answers first');
    A.eq(SB.steerNoteStatus('r1', { live: true, memory: { ended: false, notes: { sn1: 'pending' } }, record: null }).ended, false, 'a run still reading is not ended');
    A.eq(SB.steerNoteStatus('r1', { live: false, memory: null, record: { runId: 'r1', steerNotes: [{ id: 'sn1', applied: true }, { id: 'sn2', applied: false }] } }),
      { runId: 'r1', live: false, ended: true, source: 'record', notes: { sn1: 'applied', sn2: 'unapplied' } }, 'after a restart the run record answers');
    A.eq(SB.steerNoteStatus('r1', { live: false, memory: null, record: { runId: 'r1' } }),
      { runId: 'r1', live: false, ended: true, source: 'record', notes: {} }, 'a recorded run with no ledger took none of the page\'s notes');
    // LIVE (this lane): a station killed mid-run is recorded on its next boot by the recovery path ('interrupted', no ledger).
    // That row cannot say which notes the run read — it is "no record", never "the station never took it".
    A.eq(SB.steerNoteStatus('r1', { live: false, memory: null, record: { runId: 'r1', reason: 'interrupted', recoveryStatus: 'recovering' } }),
      { runId: 'r1', live: false, ended: true, source: 'none', notes: {} }, 'an interrupted run recorded without a ledger answers "no record"');
    A.eq(SB.steerNoteStatus('r1', { live: false, memory: null, record: { runId: 'r1', reason: 'interrupted', steerNotes: [{ id: 'sn1', applied: true }] } }).source, 'record',
      'an interrupted row that carries a ledger still answers from it');
    A.eq(SB.steerNoteStatus('r1', { live: false, memory: null, record: null }),
      { runId: 'r1', live: false, ended: false, source: 'none', notes: {} }, 'no memory and no record: the station says it has none (never a guess)');
  }

  // ── 4. the run record keeps the ledger, bounded at the persistence boundary ──
  {
    const rows = [];
    const st = makeRunStore({ io: { readAll: () => [], append: r => rows.push(r) }, clock: { now: () => 7 } });
    st.record({ runId: 'r5', agentId: 'agent', reason: 'cancelled', steerNotes: [{ id: 'sn1', applied: true }, { id: 'bad id!', applied: true }, { id: 'sn2', applied: 'yes' }, null] });
    A.eq(st.latest('r5').steerNotes, [{ id: 'sn1', applied: true }, { id: 'sn2', applied: false }], 'the record keeps clean ids and a strict applied flag');
    st.record({ runId: 'r6', agentId: 'agent', reason: 'done', steerNotes: Array.from({ length: 80 }, (_, i) => ({ id: 'n' + i, applied: true })) });
    A.eq(st.latest('r6').steerNotes.length, 32, 'bounded to 32 notes per run');
    st.record({ runId: 'r7', agentId: 'agent', reason: 'done' });
    A.eq('steerNotes' in st.latest('r7'), false, 'a run with no tracked notes keeps its exact old row shape');
    st.record({ runId: 'r8', agentId: 'agent', reason: 'done', steerNotes: [] });
    A.eq('steerNotes' in st.latest('r8'), false, 'an empty ledger adds nothing either');
  }

  // ── 5. the host wiring (index.js is never required: it boots a real sidecar) ──
  {
    const fs = require('fs'), path = require('path');
    const idx = readSidecarSource();
    A.ok(/steerBufs\.post\(runId, text, [^\n]*, body\.noteId\)/.test(idx), 'POST /api/run/steer hands the buffer the page\'s noteId');
    A.ok(/\{ m: 'GET', qsplit: '\/api\/run\/steer', h: handleRunSteerStatus \}/.test(idx), 'GET /api/run/steer is routed');
    const h = A.fnBody(idx, 'function handleRunSteerStatus(req, res)');
    A.ok(h.length > 50 && /steerNoteStatus\(/.test(h) && /steerBufs\.status\(runId\)/.test(h) && /runStore\.latest\(runId\)/.test(h), 'it answers from the buffer, then the run record');
    A.ok(/runs\.has\(runId\) \|\| runStopHandles\.has\(runId\)/.test(h), 'live is the same in-flight test the POST uses');
    A.ok(/steerNotes: steerBufs\.ledgerOf\(runId\)/.test(idx), 'the run record carries the ledger');
  }

  A.report('steer-note-ledger.test');
})().catch(e => { console.error(e); process.exit(1); });
