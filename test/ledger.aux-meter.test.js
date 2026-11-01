/* node test/ledger.aux-meter.test.js — housekeeping spend reaches the ledger, $0 subscription calls included
   (efficiency audit 2026-10-26). Every post-run pass (reflection, failure review, study, thread mining, the scout cycle,
   quest refresh, recall embeddings, the skill reviewer/curator, the station one-shots) booked its row only `if (usd)`,
   so on a ChatGPT/Claude plan none of those calls ever reached the spend log. Asserts the ONE meter they now share
   (ledger.js makeAuxMeter) and the family invariant over sidecar/index.js: no aux booking is gated on dollars, every aux
   row is tagged, and the run counters count runs, not aux rows. Source pins only for index.js: requiring it boots a sidecar. */
'use strict';
const { readSidecarIndex } = require('./helpers/source');
const A = require('./_assert.js');
const { makeLedger, makeAuxMeter } = require('../sidecar/ledger.js');

function fakeIo() { const rows = []; return { rows, readAll() { return rows.slice(); }, append(e) { rows.push(e); } }; }
const clock = { now: () => 5_000_000 };
// a cost engine shaped like cost.js reconcile: priced models bill $1/M in + $2/M out, 'free-model' has no price
const cost = {
  reconcile(usage, model) {
    const tokensIn = Number(usage && usage.prompt_tokens) || 0, tokensOut = Number(usage && usage.completion_tokens) || 0;
    const cached = Number(usage && usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
    const priced = model !== 'free-model';
    return { usd: priced ? (tokensIn * 1 + tokensOut * 2) / 1e6 : 0, tokensIn, tokensOut, cachedTokens: cached, unpriced: !priced && (tokensIn + tokensOut > 0) };
  }
};
// a provider whose stream yields the scripted events, then optionally throws (a timeout / abort mid-answer)
function provider(events, throwAfter) {
  return { async *stream() { for (const ev of events) yield ev; if (throwAfter) throw new Error('aborted'); } };
}
const usage = (i, o, cached) => ({ type: 'usage', usage: { prompt_tokens: i, completion_tokens: o, prompt_tokens_details: { cached_tokens: cached || 0 } } });

(async () => {
  // ---- a $0 subscription call books a row: tokens kept, usd 0, unmetered, tagged aux ----
  {
    const io = fakeIo(), L = makeLedger({ io, clock });
    const m = makeAuxMeter({ ledger: L, kind: 'reflection' });
    // a subscription route reports usage but no dollars: the cost engine prices it at $0 (provider-reported 0)
    const subCost = { reconcile: (u, model) => Object.assign(cost.reconcile(u, model), { usd: 0 }) };
    const text = await m.stream(provider([{ type: 'text', delta: 'NO' }, { type: 'text', delta: 'NE' }, usage(9000, 40, 8000)]), { model: 'gpt-6.1-sol' }, subCost);
    A.eq(text, 'NONE', 'the meter returns the streamed text unchanged');
    const row = m.book({ runId: 'run-1', agentId: 'agent', model: 'gpt-6.1-sol', unmetered: true });
    A.ok(row && io.rows.length === 1, 'a $0 subscription call reaches the ledger (it used to vanish under `if (usd)`)');
    A.eq([row.usd, row.tokens, row.cachedTokens, row.unmetered, row.aux, row.turns], [0, 9040, 8000, true, 'reflection', 0], 'the row keeps the real tokens, cache share, $0, and names the pass');
    A.ok(!row.usageMissing && !row.unpriced, 'an unmetered row never claims a dollar floor');
    A.eq(m.book({ runId: 'run-1', agentId: 'agent', model: 'gpt-6.1-sol', unmetered: true }), null, 'a second book() adds no copy');
    A.eq(io.rows.length, 1, '…and writes nothing');
  }

  // ---- no call ran = no row (a paused or early-return pass books nothing) ----
  {
    const io = fakeIo(), L = makeLedger({ io, clock });
    const m = makeAuxMeter({ ledger: L, kind: 'study' });
    A.eq(m.book({ runId: 'r', agentId: 'a', model: 'm' }), null, 'a pass that never called the model books no row');
    A.eq(io.rows.length, 0, '…and the ledger stays empty');
  }

  // ---- several calls in one pass are ONE row, summed ----
  {
    const io = fakeIo(), L = makeLedger({ io, clock });
    const m = makeAuxMeter({ ledger: L, kind: 'scout' });
    await m.stream(provider([usage(1000, 100)]), { model: 'paid' }, cost);
    await m.stream(provider([usage(2000, 200)]), { model: 'paid' }, cost);
    A.eq(m.calls(), 2, 'both calls are counted');
    const row = m.book({ runId: 'r2', agentId: 'a', model: 'paid', unmetered: false });
    A.eq([io.rows.length, row.tokens, Math.round(row.usd * 1e6)], [1, 3300, 3600], 'one row per pass, tokens and dollars summed');
    A.eq(L.totalUsd(), row.usd, 'a metered aux row still counts toward the spend totals');
  }

  // ---- a stream that throws is still metered: usage that arrived is booked; none arriving is a floor (metered only) ----
  {
    const io = fakeIo(), L = makeLedger({ io, clock });
    const m = makeAuxMeter({ ledger: L, kind: 'failure-review' });
    let threw = false;
    try { await m.stream(provider([usage(500, 50)], true), { model: 'paid' }, cost); } catch (_) { threw = true; }
    A.ok(threw, 'the stream error still reaches the pass (the meter never swallows it)');
    const row = m.book({ runId: 'r3', agentId: 'a', model: 'paid' });
    A.eq([row.tokens, row.usageMissing === true], [550, false], 'usage that arrived before the abort is booked, and is not a floor');

    const m2 = makeAuxMeter({ ledger: L, kind: 'failure-review' });
    try { await m2.stream(provider([{ type: 'text', delta: 'half' }], true), { model: 'paid' }, cost); } catch (_) {}
    const cut = m2.book({ runId: 'r4', agentId: 'a', model: 'paid', unmetered: false });
    A.ok(cut && cut.usageMissing === true && cut.usd === 0, 'a metered call cut off before its usage books usd 0 marked usageMissing — a floor, never a proven $0');

    const m3 = makeAuxMeter({ ledger: L, kind: 'failure-review' });
    try { await m3.stream(provider([], true), { model: 'paid' }, cost); } catch (_) {}
    const sub = m3.book({ runId: 'r5', agentId: 'a', model: 'paid', unmetered: true });
    A.ok(sub && !sub.usageMissing, 'on a subscription route the same cut books the call without a dollar-floor flag');
  }

  // ---- an unpriced model on a metered route stays unpriced ----
  {
    const L = makeLedger({ io: fakeIo(), clock });
    const m = makeAuxMeter({ ledger: L, kind: 'quest-refresh' });
    await m.stream(provider([usage(800, 80)]), { model: 'free-model' }, cost);
    const row = m.book({ runId: 'q', agentId: 'station', model: 'free-model', unmetered: false });
    A.ok(row.unpriced === true && row.usd === 0 && row.tokens === 880, 'tokens with no price book as unpriced (usd is a floor), not as a free call');
  }

  // ---- embeddings use add(): the same booking without a stream ----
  {
    const io = fakeIo(), L = makeLedger({ io, clock });
    const m = makeAuxMeter({ ledger: L, kind: 'embed' });
    m.add({ prompt_tokens: 64, completion_tokens: 0 }, cost, 'embed-model');
    m.add({ prompt_tokens: 12, completion_tokens: 0 }, cost, 'embed-model');
    const row = m.book({ runId: 'run-9', agentId: 'a', model: 'embed-model' });
    A.eq([row.tokens, row.aux], [76, 'embed'], 'two embed calls book one aux row');
  }

  // ---- run counters count runs: aux rows are spend beside a run, never a run ----
  {
    const L = makeLedger({ io: fakeIo(), clock });
    L.record({ runId: 'run-1', agentId: 'a', turns: 4, usd: 0, tokens: 20000, unmetered: true });
    makeAuxMeter({ ledger: L, kind: 'reflection' }).book({ runId: 'run-1', agentId: 'a' });   // no call: no row
    const m = makeAuxMeter({ ledger: L, kind: 'reflection' });
    m.add({ prompt_tokens: 3000, completion_tokens: 20 }, cost, 'm'); m.book({ runId: 'run-1', agentId: 'a', model: 'm', unmetered: true });
    const s = makeAuxMeter({ ledger: L, kind: 'study' });
    s.add({ prompt_tokens: 2000, completion_tokens: 30 }, cost, 'm'); s.book({ runId: 'run-1', agentId: 'a', model: 'm', unmetered: true });
    A.eq([L.count(), L.runCount()], [3, 1], 'one run + two housekeeping rows: count() is rows, runCount() is runs');
    A.eq(L.all().reduce((t, r) => t + r.tokens, 0), 25050, 'the housekeeping tokens are in the log');
    A.eq(L.totalUsd(), 0, 'subscription rows add no metered dollars');
  }

  // ---- the family invariant over the composition root ----
  {
    // index.js alone, on purpose (through the source helper: test/source-helper.test.js H5): the whole sidecar would
    // also scan the process ledgers (procledger, shellbg, lsp, mcp, browser), whose ledger.record( is not a spend row
    const src = readSidecarIndex();
    const body = name => { const at = src.indexOf('async function ' + name + '('); return at < 0 ? '' : src.slice(at, src.indexOf('\n}\n', at)); };
    const passes = [['runReflection', 'reflection'], ['runFailureReview', 'failure-review'], ['runStudy', 'study'], ['runThreadMine', 'threadmine'],
      ['runScoutCycle', 'scout'], ['runQuestRefreshCycle', 'quest-refresh'], ['hybridVectors', 'embed']];
    for (const [fn, kind] of passes) {
      const b = body(fn);
      A.ok(b.length > 0, fn + ' exists');
      A.ok(b.includes("auxSpend('" + kind + "')") && /spend\.book\(\{/.test(b), fn + ' meters through the shared aux meter and books it');
      A.ok(!/provider\.stream\(/.test(b) && !/cost\.reconcile\(/.test(b), fn + ' never streams or reconciles around the meter (one place counts the call)');
    }
    // no ledger.record anywhere in index.js is gated on dollars, except a cloud prop charge (a bill, not a model call)
    const calls = [];
    for (let i = src.indexOf('ledger.record('); i >= 0; i = src.indexOf('ledger.record(', i + 1)) {
      const lineStart = src.lastIndexOf('\n', i) + 1, prevStart = src.lastIndexOf('\n', lineStart - 2) + 1;
      calls.push({ line: src.slice(lineStart, src.indexOf('\n', i)), guard: src.slice(prevStart, i) });
    }
    A.ok(calls.length >= 5, 'ledger.record call sites found: ' + calls.length);
    for (const c of calls) {
      if (/'userprop-'/.test(c.line)) continue;
      A.ok(!/if \((usd|result && result\.usd)\)/.test(c.guard), 'no spend row is skipped for being $0: ' + c.line.trim().slice(0, 90));
    }
    // every row that is not the run finalizer's (or a prop charge) is tagged aux
    for (const c of calls) {
      if (/'userprop-'/.test(c.line) || /turns: finalTurns/.test(c.line)) continue;
      A.ok(/aux: '/.test(c.line), 'a housekeeping ledger row is tagged aux: ' + c.line.trim().slice(0, 90));
    }
    A.ok(/runs: known \? ledger\.runCount\(\) : null/.test(src) && /runs: ledger\.runCount\(\) \} : null/.test(src) && /runs: ledger\.runCount\(\),/.test(src),
      'SPENDING LIMITS and the budget snapshot count runs, not aux rows');
    A.ok(!/runs: (known \? )?ledger\.count\(\)/.test(src), 'no run counter reads raw row count');
  }

  A.report('ledger.aux-meter.test');
})().catch(e => { console.log('FAIL: ' + ((e && e.stack) || e)); process.exit(1); });
