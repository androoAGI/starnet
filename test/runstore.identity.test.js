/* node test/runstore.identity.test.js — runStore.noteIdentity (turn identity, commit 3; ratchet A2-REB-11).

   A run names its turn (turnId) and its directive row (directiveRowId) on the run record through ONE in-memory note that
   record() consumes. The note holds an allowlist only (turnId, directiveRowId, windowRowIds, quotesSaturatedAt and the
   quotes + quotesAt pair) and never overwrites a field the row already holds, so on the typed-outcomes base a note can
   never change a row's outcome, reason or wire source. Malformed values are dropped and counted (failopen tag
   runstore.noteIdentity). The note map is bounded: past 500 notes the oldest is evicted, counted. Pure + deterministic. */
'use strict';
const A = require('./_assert.js');
const failopen = require('../sidecar/failopen.js');
const { makeRunStore } = require('../sidecar/runstore.js');

function memIo() {
  const lines = [];
  return { lines, readAll() { return lines.slice(); }, append(e) { lines.push(e); } };
}
const clock = { now: () => 5000 };
const T = 't0123456789abcdefghijklmn';
// a CUT row: the run said done, but the provider cut the reply (RunOutcome: cut_short)
const CUT = { runId: 'run-cut', agentId: 'agent', provider: 'openrouter', wireSource: 'agent', reason: 'done', finishReason: 'length', turns: 2, tokens: 40, usd: 0.01, title: 'draft the memo', streamId: 's1', startedAt: 4000, endedAt: 4900, durationMs: 900 };
const dropped = () => failopen.counts()['runstore.noteIdentity'] || 0;

// 1. a note admits exactly turnId: the row deep-equals the same row recorded without a note, plus turnId
{
  const plain = makeRunStore({ io: memIo(), clock }).record(Object.assign({}, CUT));
  A.eq(plain.outcome, 'cut_short', 'control: the cut row records its own outcome, cut_short');
  const s = makeRunStore({ io: memIo(), clock });
  const before = dropped();
  A.eq(s.noteIdentity('run-cut', { turnId: T, outcome: 'succeeded', wireSource: 'x', reason: 'done', foo: 1 }), true, 'the note is taken (it holds a turnId)');
  A.eq(dropped() - before, 1, 'the four fields outside the allowlist are dropped and counted once (runstore.noteIdentity)');
  const noted = s.record(Object.assign({}, CUT));
  A.eq(noted, Object.assign({}, plain, { turnId: T }), 'the noted row deep-equals the plain row plus exactly turnId');
  A.eq(noted.outcome, 'cut_short', 'a note never changes the outcome (succeeded was not admitted)');
  A.eq(noted.wireSource, 'agent', 'a note never changes the wire source');
  A.eq(s.record(Object.assign({}, CUT)).turnId, undefined, 'the note is consumed by the first record(): a second row of that run carries nothing');
}

// 2. directiveRowId and the quotes pair: valid values ride, malformed ones are dropped and counted
{
  const s = makeRunStore({ io: memIo(), clock });
  let before = dropped();
  s.noteIdentity('run-a', { turnId: T, directiveRowId: 41 });
  const a = s.record({ runId: 'run-a', agentId: 'agent', reason: 'done' });
  A.eq([a.turnId, a.directiveRowId], [T, 41], 'a valid turnId and directiveRowId ride the record');
  A.eq(dropped() - before, 0, 'nothing dropped for valid fields');

  before = dropped();
  s.noteIdentity('run-b', { turnId: T, directiveRowId: '41' });
  const b = s.record({ runId: 'run-b', agentId: 'agent', reason: 'done' });
  A.eq([b.turnId, 'directiveRowId' in b], [T, false], 'a string directiveRowId is dropped');
  A.eq(dropped() - before, 1, 'the malformed directiveRowId is counted');

  for (const bad of [0, -3, 1.5, Number.MAX_SAFE_INTEGER + 2, null]) {
    before = dropped();
    s.noteIdentity('run-c', { turnId: T, directiveRowId: bad });
    const c = s.record({ runId: 'run-c', agentId: 'agent', reason: 'done' });
    A.ok(!('directiveRowId' in c), 'directiveRowId ' + String(bad) + ' is dropped');
    A.eq(dropped() - before, 1, 'directiveRowId ' + String(bad) + ' is counted');
  }

  before = dropped();
  s.noteIdentity('run-q', { turnId: T, quotes: 'not-a-digest', quotesAt: 7 });
  const q = s.record({ runId: 'run-q', agentId: 'agent', reason: 'done' });
  A.ok(!('quotes' in q) && !('quotesAt' in q), 'a malformed quotes stamp is dropped as a pair');
  A.eq(dropped() - before, 1, 'the malformed quotes stamp is counted');

  before = dropped();
  A.eq(s.noteIdentity('run-z', { turnId: 'bad id!', directiveRowId: 'x' }), false, 'a note with nothing admissible is not kept');
  A.eq(dropped() - before, 1, 'its two malformed fields are counted once');
  A.eq(s.record({ runId: 'run-z', agentId: 'agent', reason: 'done' }).turnId, undefined, 'and the record carries nothing');
}

// 3. never over a field the row already holds; notes for one run merge
{
  const s = makeRunStore({ io: memIo(), clock });
  s.noteIdentity('run-m', { turnId: T });
  s.noteIdentity('run-m', { directiveRowId: 9 });
  const m = s.record({ runId: 'run-m', agentId: 'agent', reason: 'done' });
  A.eq([m.turnId, m.directiveRowId], [T, 9], 'two notes for one run merge');
  const plainKeys = Object.keys(makeRunStore({ io: memIo(), clock }).record({ runId: 'run-k', agentId: 'agent', reason: 'error' }));
  A.ok(!plainKeys.includes('turnId') && !plainKeys.includes('directiveRowId'), 'control: a plain row holds no identity field');
}

// 4. bounded: past 500 notes the oldest is evicted and counted; the newest survive
{
  const s = makeRunStore({ io: memIo(), clock });
  const before = dropped();
  for (let i = 0; i < 502; i++) s.noteIdentity('run-' + i, { turnId: T });
  A.eq(dropped() - before, 2, 'two evictions past 500, each counted');
  A.eq(s.record({ runId: 'run-0', agentId: 'agent', reason: 'done' }).turnId, undefined, 'the oldest note was evicted');
  A.eq(s.record({ runId: 'run-501', agentId: 'agent', reason: 'done' }).turnId, T, 'the newest note survives');
}

// 5. a settled spend keeps the run's turn identity: settleSpend builds its superseding row from the served row, and record()
//    keeps the identity that row carries (checked exactly as noteIdentity checks it), so the chain's served row still names
//    the run's turn and directive row after the Commander settles it
{
  const io = memIo();
  const s = makeRunStore({ io, clock });
  s.noteIdentity('run-int', { turnId: T, directiveRowId: 17 });
  const first = s.record({ runId: 'run-int', agentId: 'agent', reason: 'interrupted', spendUnknown: true, title: 'draft the memo', streamId: 's1' });
  A.eq([first.turnId, first.directiveRowId, first.spendUnknown], [T, 17, true], 'control: the interrupted row carries its identity and an unknown spend');
  const before = dropped();
  const settled = s.settleSpend('run-int', 0.25, 'entered');
  A.ok(settled && settled.spendSettled === 'entered', 'fixture: the spend settles (one superseding row)');
  A.eq([settled && settled.turnId, settled && settled.directiveRowId], [T, 17], 'the superseding row keeps the run\'s turnId and directiveRowId');
  const served = s.latest('run-int');
  A.eq([served.turnId, served.directiveRowId, served.spendSettled, served.usd], [T, 17, 'entered', 0.25], 'the served row (the chain\'s latest) names the turn and the settled figure');
  A.eq(dropped() - before, 0, 'nothing dropped: the identity the row carried was valid');
  const reloaded = makeRunStore({ io: { readAll: () => io.lines.slice(), append() {} }, clock }).latest('run-int');
  A.eq([reloaded.turnId, reloaded.directiveRowId, reloaded.spendSettled], [T, 17, 'entered'], 'after a restart the settled row still names its turn (the persisted row carries it)');
}

// 6. a row GIVEN identity fields is checked exactly as noteIdentity checks them: valid ones ride, malformed ones are dropped and
//    counted; a note never overwrites a field the row was given; a row given none is byte-identical
{
  const s = makeRunStore({ io: memIo(), clock });
  const W = { first: 3, last: 9, count: 4, sha256: 'a'.repeat(64) };
  let before = dropped();
  const ok = s.record({ runId: 'run-g', agentId: 'agent', reason: 'done', turnId: T, directiveRowId: 5, windowRowIds: W, quotes: ['s2'], quotesAt: [40], quotesSaturatedAt: 0 });
  A.eq([ok.turnId, ok.directiveRowId, ok.windowRowIds, ok.quotes, ok.quotesAt, ok.quotesSaturatedAt], [T, 5, W, ['s2'], [40], 0], 'every valid given identity field rides the row');
  A.eq(dropped() - before, 0, 'nothing dropped for valid given fields');

  before = dropped();
  const bad = s.record({ runId: 'run-h', agentId: 'agent', reason: 'done', turnId: 'bad id!', directiveRowId: '5', windowRowIds: { first: 1 }, quotes: ['s2'], quotesAt: [-1], quotesSaturatedAt: -2 });
  A.ok(!['turnId', 'directiveRowId', 'windowRowIds', 'quotes', 'quotesAt', 'quotesSaturatedAt'].some(k => k in bad), 'every malformed given identity field is dropped');
  A.eq(dropped() - before, 1, 'the malformed given fields are counted once (runstore.noteIdentity)');

  const T2 = 't9876543210zyxwvutsrqponm';
  s.noteIdentity('run-w', { turnId: T2, directiveRowId: 8 });
  const won = s.record({ runId: 'run-w', agentId: 'agent', reason: 'done', turnId: T });
  A.eq([won.turnId, won.directiveRowId], [T, 8], 'a note never overwrites a field the row was given; it fills the rest');

  const plain = makeRunStore({ io: memIo(), clock }).record(Object.assign({}, CUT));
  const given = makeRunStore({ io: memIo(), clock }).record(Object.assign({}, CUT, { turnId: undefined }));
  A.eq(given, plain, 'a row given no identity (an undefined field counts as absent) is byte-identical');
}

A.report('runstore.identity');
