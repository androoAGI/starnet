/* node test/run-spend-pool.test.js — bug d3a76db3: one PER RUN cap for a run and every worker it starts.

   A $0.05 PER RUN cap ran $0.24 because each team.spawn worker started with its own full ceiling and nothing charged
   worker spend to the run that started it. Three things are locked here (the live proof through the real sidecar is
   test/run-cap-bounds-spawn.e2e.test.js):
     1. sidecar/run-spend-pool.js keeps the loop's single-run bound for the whole family: a lone run is never decided
        by it; every call in flight is RESERVED at the most it can cost (never less than the costliest call booked so
        far) and settles on what it booked; a call with no price is counted as a call, so nothing goes out beside it;
        a call that does not fit WAITS (a hold); a stop is only a cap the family really reached. Over every
        interleaving of a cheap and a 10x heavier clone, the family passes the cap by less than the call admitted last.
     2. orchestration.js hands the HOST-minted ctx.spendPool to every run it starts — dispatch (foreground and
        background), spawn, the structured-result repair, and resume — and never invents one.
     3. Through the real loop.js + orchestration.js + registry + pool, wired as index.js wires them: the loop prices
        each call at its prompt plus the most output it can bill — the model's output ceiling, or the room a REPORTED
        window leaves (never the context manager's cold 131072 guess), whichever is lower — and families of
        heterogeneous clones stay within the cap plus one call at every cap, while clones that fit still run in
        parallel; a family whose calls take turns is never timed out by the waits alone (team.spawn's timeout and each
        team.dispatch worker's slice pause while a call is held), nor stopped as stalled by the host's liveness sweep
        (subagents.js checkStalls: a held worker's stall clock stops too). The liveness families run the manager on its
        own clock, which moves in the 20ms steps a call takes, and sweep after every step, where index.js sweeps every
        30s: a loaded box cannot move that clock, and one real loop stall in each of those families shows it. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeRunSpendPool, isRunSpendPool } = require('../sidecar/run-spend-pool.js');
const { makeOrchestrationTools } = require('../sidecar/tools/builtin/orchestration.js');
const { makeSubagentManager } = require('../sidecar/subagents.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeContext } = require('../sidecar/context.js');
const { stallNow, waitFor } = require('./helpers/loop-stall.js');

const near = (a, b) => Math.abs(a - b) < 1e-9;
const counter = () => { let n = 0; return () => 'child_' + (++n); };
const tick = () => new Promise(resolve => setImmediate(resolve));
const money = v => '$' + (Math.round(v * 10000) / 10000);

(async () => {

// ---- 1a. a run that never delegates is never decided by its pool (its loop's own check governs, as before) ----
{
  const pool = makeRunSpendPool({ capUsd: 0.05 }).join('lead');
  A.eq(pool.admit('lead', 0), null, 'lone run: first call proceeds');
  pool.booked('lead', 0.04);
  A.eq(pool.admit('lead', 0.04), null, 'lone run: a second call under the cap proceeds');
  pool.booked('lead', 0.04);
  A.eq(pool.admit('lead', 0.08), null, 'lone run: even past the cap the pool stays out of it (loop.js stops it on its own maxCostUsd)');
  A.ok(near(pool.status().spentUsd, 0.08), 'lone run: the pool still tallies what the run booked');
}

// ---- 1b. an ungoverned cap (0 / Infinity / missing) never blocks a family ----
for (const capUsd of [0, Infinity, undefined, NaN, -1]) {
  const pool = makeRunSpendPool({ capUsd }).join('lead');
  pool.booked('lead', 5);
  pool.join('w1');
  A.eq(pool.admit('w1', 0), null, 'ungoverned cap ' + String(capUsd) + ': a worker is never stopped');
  A.eq(pool.admit('lead', 5), null, 'ungoverned cap ' + String(capUsd) + ': nor held behind a call in flight');
  A.eq(pool.capUsd, Infinity, 'ungoverned cap ' + String(capUsd) + ' reads as Infinity');
}

// ---- 1c. the repro: $0.05 cap, the lead spent $0.04, four workers start together on a model nothing prices ----
{
  const pool = makeRunSpendPool({ capUsd: 0.05 }).join('lead');
  A.eq(pool.admit('lead', 0), null, 'the lead\'s first call proceeds');
  pool.booked('lead', 0.04);   // its reconciled cost lands BEFORE its team.spawn runs (loop.js books, then dispatches)
  pool.idle('lead');           // agent.tool_call: the lead is running tools now, not calling the model
  for (const w of ['w1', 'w2', 'w3', 'w4']) pool.join(w);
  A.eq(pool.admit('w1', 0), null, 'the first worker\'s call goes out: $0.04 booked, nothing else in flight');
  const w2 = pool.admit('w2', 0);
  A.ok(w2 && w2.hold && typeof w2.hold.then === 'function' && !w2.scope, 'a second worker is HELD, not admitted: w1\'s call has no price, so it is counted as a call and nothing goes out beside it: ' + JSON.stringify(w2));
  A.eq(pool.status().inFlight, 1, 'a held worker is not in flight');
  A.eq(pool.status().unpricedInFlight, 1, 'the one call in flight is counted as an unpriced call');
  A.ok(pool.admit('w3', 0).hold && pool.admit('w4', 0).hold, 'the other two are held too');
  let woke = false;
  w2.hold.then(() => { woke = true; });
  await tick();
  A.eq(woke, false, 'the hold lasts while w1\'s call is in flight');
  pool.booked('w1', 0.04);
  await tick();
  A.eq(woke, true, 'w1\'s booked call ends the hold');
  const again = pool.admit('w2', 0);
  A.ok(again && again.scope === 'run' && again.cap === 0.05 && near(again.usd, 0.08), 'asked again, w2 stops with scope run at the LEAD\'s $0.05 cap on what w1 really cost: ' + JSON.stringify(again));
  A.ok(again && again.projected !== true, 'the family really reached the cap: a hit, never a projection');
  A.ok(pool.admit('w3', 0) && pool.admit('w4', 0), 'the other two stop too');
  pool.settle('w1', 0.04);
  for (const w of ['w2', 'w3', 'w4']) pool.settle(w, 0);
  const lead = pool.admit('lead', 0.04);
  A.ok(lead && lead.scope === 'run' && near(lead.usd, 0.08) && lead.cap === 0.05, 'the lead stops at its next call boundary: the family spent $0.08 of $0.05');
  A.ok(near(pool.status().spentUsd, 0.08), 'the family spent $0.08 — the cap plus one call, not $0.24');
  A.eq(pool.status().inFlight, 0, 'nothing is left in flight');
  A.eq(pool.status().calls, 2, 'two calls went out: the lead\'s and w1\'s');
}

// ---- 1d. room under the cap: priced calls whose reservations fit all go out together ----
{
  const pool = makeRunSpendPool({ capUsd: 1 }).join('lead');
  for (const w of ['a', 'b', 'c', 'd']) pool.join(w);
  for (const w of ['a', 'b', 'c', 'd']) A.eq(pool.admit(w, 0, 0.10), null, 'worker ' + w + '\'s call (at most $0.10) goes out: the calls in flight beside it leave room under $1');
  A.eq(pool.status().inFlight, 4, 'all four calls are in flight at once');
  A.ok(near(pool.status().reservedUsd, 0.40), 'each is reserved at the most it can cost: $0.40 in all');
  for (const w of ['a', 'b', 'c', 'd']) pool.booked(w, 0.04);
  A.ok(near(pool.status().reservedUsd, 0), 'a booked call settles on what it really cost: nothing is reserved any more');
  for (const w of ['a', 'b', 'c', 'd']) A.eq(pool.admit(w, 0.04, 0.10), null, 'a $1 cap has room for every second call ($0.16 booked + three $0.10 reservations)');
  A.ok(near(pool.status().largestCallUsd, 0.04), 'the largest call booked is the $0.04 one');
}
{
  // the same four with NO price: counted as calls, they go out one at a time — never refused, never all at once
  const pool = makeRunSpendPool({ capUsd: 1 }).join('lead');
  for (const w of ['a', 'b', 'c', 'd']) pool.join(w);
  A.eq(pool.admit('a', 0), null, 'unpriced: a goes out');
  for (const w of ['b', 'c', 'd']) { const h = pool.admit(w, 0); A.ok(h && h.hold && !h.scope, 'unpriced: ' + w + ' waits beside a call with no price (never stopped): ' + JSON.stringify(h)); }
  pool.booked('a', 0.04);
  A.eq(pool.admit('b', 0), null, 'unpriced: b goes once a\'s call settled');
}

// ---- 1e. a member's own tally is authoritative; settle never lowers what was booked ----
{
  const pool = makeRunSpendPool({ capUsd: 0.10 }).join('lead').join('w');
  pool.admit('lead', 0, 0.01);
  pool.booked('lead', 0.03);
  pool.admit('lead', 0.05, 0.01);   // the loop also folded a $0.02 summarizer pass the pool had no event for
  A.ok(near(pool.status().spentUsd, 0.05), 'the loop\'s own running tally raises the member to $0.05');
  pool.idle('lead');          // tools now — the call is over; the $0.03 call is the largest one so far
  A.ok(near(pool.status().largestCallUsd, 0.03), 'the largest call booked is the $0.03 one');
  A.eq(pool.admit('w', 0, 0.01), null, 'nothing in flight: the worker proceeds');
  A.eq(pool.admit('lead', 0.05, 0.01), null, 'lead: $0.05 booked + the worker\'s call reserved at the $0.03 largest call (more than its $0.01 price) fits under $0.10');
  pool.settle('lead', 0.01);
  A.ok(near(pool.status().spentUsd, 0.05), 'a lower final figure never un-books spend');
  pool.settle('w', 0.06);
  A.ok(near(pool.status().spentUsd, 0.11), 'the worker\'s final spend is counted');
  A.ok(pool.admit('lead', 0.05) && pool.admit('w', 0.06), 'and once the family reached $0.10 every member stops');
}

// ---- 1f. NO RESERVATION IS LESS THAN THE COSTLIEST CALL BOOKED (a provider billing above the catalog's prices) ----
{
  const pool = makeRunSpendPool({ capUsd: 0.25 }).join('lead');
  pool.admit('lead', 0); pool.booked('lead', 0.02); pool.idle('lead');
  for (const w of ['big', 'small']) pool.join(w);
  pool.admit('big', 0, 0.01); pool.booked('big', 0.12);   // priced at $0.01, the call really booked $0.12
  A.eq(pool.admit('big', 0.12, 0.01), null, 'big makes its second call');
  A.ok(near(pool.status().reservedUsd, 0.12), 'big\'s call in flight is reserved at the $0.12 it was seen to cost, not its $0.01 price');
  const small = pool.admit('small', 0, 0.01);
  A.ok(small && small.hold && !small.scope, 'small WAITS: $0.14 booked + big\'s $0.12 reservation leaves no room under $0.25, and nothing is stopped on a reservation: ' + JSON.stringify(small));
  pool.booked('big', 0.12);
  const again = pool.admit('small', 0, 0.01);
  A.ok(again && again.scope === 'run' && near(again.usd, 0.26) && again.projected !== true, 'once big booked, the family is at $0.26 of $0.25: small stops on a hit: ' + JSON.stringify(again));
}

// ---- 1g. A WORKER WHOSE CALLS ALL BOOK $0 IS STILL COUNTED (calls, not only dollars) ----
{
  // a $0 lead (a free or unpriced model) and a worker whose calls book $0: neither leaves a price to reserve by, so a
  // paid sibling's call can never ride beside them as if they cost nothing
  const pool = makeRunSpendPool({ capUsd: 0.05 }).join('lead');
  pool.admit('lead', 0); pool.booked('lead', 0); pool.idle('lead');
  for (const w of ['zero', 'paid1', 'paid2']) pool.join(w);
  A.eq(pool.admit('zero', 0), null, '$0 worker: its call goes out');
  const p1 = pool.admit('paid1', 0);
  A.ok(p1 && p1.hold, '$0 worker: a paid sibling waits for its call — counted as a call, not as $0: ' + JSON.stringify(p1));
  pool.booked('zero', 0);
  A.eq(pool.status().calls, 2, '$0 worker: its $0 call is counted, as is the $0 lead turn');
  A.eq(pool.admit('paid1', 0), null, 'paid1 goes once the $0 call settled');
  A.ok(pool.admit('zero', 0).hold, 'and the $0 worker\'s next call waits for paid1\'s');
  pool.booked('paid1', 0.04);
  A.eq(pool.admit('paid2', 0), null, 'paid2 goes ($0.04 booked, nothing in flight)');
  pool.booked('paid2', 0.04);
  for (const w of ['zero', 'paid1', 'paid2']) { const s = pool.admit(w, w === 'zero' ? 0 : 0.04); A.ok(s && s.scope === 'run' && near(s.usd, 0.08), w + ' stops on the $0.08 the family really reached'); }
  A.ok(near(pool.status().spentUsd, 0.08), '$0 lead + $0 worker: the family spent $0.08 — the cap plus one call');
  A.eq(pool.status().calls, 4, 'four calls went out, two of them $0');
}
{
  // a family that only ever books $0 runs to the end: counted calls take turns, nothing is stopped
  const pool = makeRunSpendPool({ capUsd: 0.05 }).join('lead');
  pool.admit('lead', 0); pool.booked('lead', 0); pool.idle('lead');
  for (const w of ['z1', 'z2']) pool.join(w);
  let peak = 0, stops = 0;
  const left = { z1: 3, z2: 3 };
  while (left.z1 || left.z2) {
    for (const w of ['z1', 'z2']) {
      if (!left[w]) continue;
      const r = pool.admit(w, 0);
      if (r && r.scope) stops++;
      if (r) continue;
      peak = Math.max(peak, pool.status().inFlight);
      pool.booked(w, 0); left[w]--;
    }
  }
  A.eq(stops, 0, 'all-$0 family: no call is ever stopped');
  A.eq(peak, 1, 'all-$0 family: one counted call in flight at a time');
  A.eq(pool.status().calls, 7, 'all-$0 family: every $0 call is counted (the lead\'s + six)');
}

// ---- 1h. a call refused after admission (a day/global pool; index.js withdraws it) never went out ----
{
  const pool = makeRunSpendPool({ capUsd: 0.05 }).join('lead');
  pool.admit('lead', 0); pool.booked('lead', 0.04); pool.idle('lead');
  for (const w of ['w1', 'w2']) pool.join(w);
  pool.admit('w1', 0); pool.withdraw('w1');
  A.eq(pool.status().calls, 1, 'withdrawn: a call that never went out is not counted');
  A.eq(pool.status().inFlight, 0, 'withdrawn: and frees the pool at once');
  A.eq(pool.admit('w2', 0), null, 'withdrawn: w2 goes (nothing in flight)');
}

// ---- 1i. HETEROGENEOUS CLONES (review of a1234b154): the costliest-so-far estimate was replaced the moment a cheap
// clone booked, so 10x heavier clones in flight were counted at the cheap clone's cost and passed the cap by far more
// than a call. The deterministic repro, then every interleaving.
{
  // cap $0.30, the lead $0.01, a $0.02 clone books first, three $0.20 clones follow; every call priced at most $0.24
  const pool = makeRunSpendPool({ capUsd: 0.30 }).join('lead');
  pool.admit('lead', 0); pool.booked('lead', 0.01); pool.idle('lead');
  for (const w of ['c1', 'h2', 'h3', 'h4']) pool.join(w);
  A.eq(pool.admit('c1', 0, 0.24), null, 'hetero: the cheap clone goes');
  pool.booked('c1', 0.02);
  A.eq(pool.admit('h2', 0, 0.24), null, 'hetero: h2 goes (nothing in flight)');
  A.eq(pool.admit('h3', 0, 0.24), null, 'hetero: h3 goes ($0.03 booked + h2 reserved at $0.24, NOT at the cheap clone\'s $0.02)');
  A.ok(pool.admit('h4', 0, 0.24).hold, 'hetero: h4 waits: two $0.24 reservations leave no room');
  pool.booked('h2', 0.20);
  A.ok(pool.admit('h4', 0, 0.24).hold, 'hetero: h4 still waits ($0.23 booked + h3\'s $0.24)');
  pool.booked('h3', 0.20);
  const h4 = pool.admit('h4', 0, 0.24);
  A.ok(h4 && h4.scope === 'run' && near(h4.usd, 0.43), 'hetero: h4 stops on the $0.43 the family really reached: ' + JSON.stringify(h4));
  A.ok(pool.status().spentUsd - 0.30 < 0.20, 'hetero: $0.43 passes the $0.30 cap by $0.13, less than the $0.20 call admitted last (the fallback this replaces: $0.63)');
}
// Every interleaving of the members' admits, holds, bookings and run ends (a DFS that replays each schedule on a fresh
// pool). Each member is a run of calls with known costs, priced at `bound` (the most a call can cost; 0 = no price).
function explore(cap, leadUsd, workers) {
  const res = { leaves: 0, problems: [], maxOver: -Infinity, peak: 0 };
  function replay(choices) {
    const pool = makeRunSpendPool({ capUsd: cap }).join('lead');
    pool.admit('lead', 0); pool.booked('lead', leadUsd); pool.idle('lead');
    const st = workers.map(w => ({ w, next: 0, phase: 'boundary', spent: 0, heldAt: -1 }));
    for (const s of st) pool.join(s.w.id);
    let settles = 0, lastCost = 0, step = 0, sent = 1;
    const trace = [];
    for (;;) {
      const en = [];
      st.forEach((s, j) => { if (s.phase === 'boundary' || s.phase === 'inflight' || (s.phase === 'held' && settles > s.heldAt)) en.push(j); });
      if (!en.length) return { leaf: true, pool, st, lastCost, sent, trace };
      if (step >= choices.length) return { leaf: false, options: en.length };
      const s = st[en[choices[step++]]];
      if (s.phase === 'inflight') {
        const c = s.w.costs[s.next++];
        pool.booked(s.w.id, c); s.spent += c; settles++; sent++;
        trace.push(s.w.id + ' books ' + c);
        if (s.next >= s.w.costs.length) { pool.settle(s.w.id, s.spent); s.phase = 'done'; } else s.phase = 'boundary';
        continue;
      }
      if (s.spent >= cap) { pool.settle(s.w.id, s.spent); s.phase = 'done'; trace.push(s.w.id + ' own cap'); continue; }   // loop.js's own check
      const r = pool.admit(s.w.id, s.spent, s.w.bound);
      if (r === null) {
        s.phase = 'inflight'; lastCost = s.w.costs[s.next];
        res.peak = Math.max(res.peak, pool.status().inFlight);
        trace.push(s.w.id + ' sends');
      } else if (r.hold) { s.phase = 'held'; s.heldAt = settles; trace.push(s.w.id + ' holds'); }
      else {
        if (!(r.usd >= cap) || r.projected === true) res.problems.push('a stop below the cap: ' + JSON.stringify(r) + ' after ' + trace.join(', '));
        pool.settle(s.w.id, s.spent); s.phase = 'done'; trace.push(s.w.id + ' stops');
      }
    }
  }
  const work = leadUsd + workers.reduce((t, w) => t + w.costs.reduce((a, b) => a + b, 0), 0);
  (function dfs(prefix) {
    const r = replay(prefix);
    if (!r.leaf) { for (let k = 0; k < r.options; k++) dfs(prefix.concat(k)); return; }
    res.leaves++;
    const total = r.pool.status().spentUsd;
    res.maxOver = Math.max(res.maxOver, total - cap);
    const where = ' [' + r.trace.join(', ') + ']';
    if (r.st.some(s => s.phase !== 'done')) res.problems.push('a member never finished (deadlock)' + where);
    if (!(total - cap < r.lastCost + 1e-9)) res.problems.push(money(total) + ' passes the ' + money(cap) + ' cap by more than the ' + money(r.lastCost) + ' call admitted last' + where);
    if (work < cap && r.st.some(s => s.next < s.w.costs.length)) res.problems.push('the work fits (' + money(work) + ') but a member was stopped' + where);
    if (r.pool.status().calls !== r.sent) res.problems.push('calls counted ' + r.pool.status().calls + ', sent ' + r.sent + where);
    if (r.pool.status().inFlight !== 0) res.problems.push('a call left in flight' + where);
  })([]);
  return res;
}
const CAPS = [0.03, 0.05, 0.10, 0.21, 0.25, 0.30, 0.45, 0.50, 0.70, 1.00];
const heteroConfigs = [
  ['priced cheap + heavy', 0.01, [{ id: 'cheap', costs: [0.02, 0.02], bound: 0.24 }, { id: 'heavy', costs: [0.20, 0.20], bound: 0.24 }]],
  ['priced cheap + two heavy', 0.01, [{ id: 'cheap', costs: [0.02, 0.02], bound: 0.24 }, { id: 'h1', costs: [0.20], bound: 0.24 }, { id: 'h2', costs: [0.20], bound: 0.24 }]],
  ['unpriced cheap + heavy (counted as calls)', 0.01, [{ id: 'cheap', costs: [0.02, 0.02], bound: 0 }, { id: 'heavy', costs: [0.20, 0.20], bound: 0 }]],
  ['priced cheap + unpriced heavy (two models)', 0.01, [{ id: 'cheap', costs: [0.02, 0.02], bound: 0.24 }, { id: 'heavy', costs: [0.20, 0.20], bound: 0 }]],
  ['$0 lead, a $0 worker + a paid one', 0, [{ id: 'zero', costs: [0, 0, 0], bound: 0 }, { id: 'paid', costs: [0.04, 0.04], bound: 0 }]],
];
for (const [label, leadUsd, workers] of heteroConfigs) {
  let leaves = 0, problems = [], maxOver = -Infinity, peak = 0;
  for (const cap of CAPS) {
    const r = explore(cap, leadUsd, workers);
    leaves += r.leaves; problems = problems.concat(r.problems.slice(0, 2).map(p => 'cap ' + money(cap) + ': ' + p));
    maxOver = Math.max(maxOver, r.maxOver); peak = Math.max(peak, r.peak);
  }
  A.ok(leaves > 50, 'every interleaving, ' + label + ': explored ' + leaves + ' schedules');
  A.eq(problems.slice(0, 3), [], 'every interleaving, ' + label + ': never past the cap by more than the call admitted last, no deadlock, no stop below the cap, nothing stopped when the work fits, every call counted');
  const heaviest = Math.max(...workers.map(w => Math.max(...w.costs)));
  A.ok(maxOver < heaviest + 1e-9, 'every interleaving, ' + label + ': the worst overshoot ' + money(maxOver) + ' is less than one ' + money(heaviest) + ' call');
  if (workers.every(w => w.bound > 0)) A.ok(peak >= 2, 'every interleaving, ' + label + ': priced calls with room still go out together (peak ' + peak + ' in flight)');
  else A.ok(peak >= 1, 'every interleaving, ' + label + ': calls went out');
}

// ---- 1j. only a pool the host minted is one ----
A.ok(isRunSpendPool(makeRunSpendPool({ capUsd: 1 })), 'a minted pool is recognized');
A.ok(!isRunSpendPool({ admit: 'x', join: 'y', booked: 1, idle: 2, withdraw: 4, settle: 3 }), 'a JSON-shaped object (a request body) is not a pool');
A.ok(!isRunSpendPool(null) && !isRunSpendPool(undefined) && !isRunSpendPool('pool'), 'nothing else is a pool');

// ---- 2. orchestration hands the lead's pool to every run it starts ----
const fakeRunOnce = (impl) => {
  const calls = [];
  const fn = async (o) => { calls.push(o); return impl ? impl(o) : { reason: 'done', messages: [{ role: 'assistant', content: 'ok' }], usd: 0.01 }; };
  fn.calls = calls;
  return fn;
};
const roster = new Map([['researcher', { system: 'R' }], ['analyst', { system: 'A' }]]);
// a worker is handed the lead's pool seen through its holds (run-spend-pool.js watchHolds): the same pool — every
// booking and decision is the lead pool's own — whose holds pause the tool's clocks (a foreground worker) and the
// liveness sweep's stall clock (every worker the subagent manager runs)
const drawsFrom = (view, pool) => isRunSpendPool(view) && view !== pool && ['join', 'booked', 'idle', 'withdraw', 'status'].every(k => view[k] === pool[k])
  && typeof view.end === 'function';
{
  const pool = makeRunSpendPool({ capUsd: 1 }).join('lead_run');
  const ro = fakeRunOnce();
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter() });
  await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'find X' }, { agentId: 'analyst', prompt: 'analyze Y' }] },
    { agentId: 'agent', runId: 'lead_run', emit: () => {}, spendPool: pool });
  A.eq(ro.calls.length, 2, 'dispatch: two workers ran');
  A.ok(ro.calls.every(c => drawsFrom(c.spendPool, pool)), 'dispatch: every worker run draws from the lead run\'s own pool (watched for holds)');
}
{
  const ro = fakeRunOnce();
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter() });
  await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'find X' }] }, { agentId: 'agent', emit: () => {} });
  A.ok(!('spendPool' in ro.calls[0]), 'dispatch: a ctx with no pool adds no spendPool option (the run host mints its own)');
  const ro2 = fakeRunOnce();
  const t2 = makeOrchestrationTools({ runOnce: ro2, roster: () => roster, key: 'k', model: 'm', newId: counter() });
  await t2.dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'find X' }] }, { agentId: 'agent', emit: () => {}, spendPool: { admit: 1 } });
  A.ok(!('spendPool' in ro2.calls[0]), 'dispatch: a ctx value that is not a pool is never passed on');
}
{
  // a schema-failing first answer takes the bounded repair run, which draws from the same pool
  const pool = makeRunSpendPool({ capUsd: 1 }).join('lead_run');
  const ro = fakeRunOnce(o => ({ reason: 'done', messages: [{ role: 'assistant', content: o.outputOnly ? '{"ok":true}' : 'not json' }], usd: 0.01 }));
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter() });
  await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'report', resultSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } }] },
    { agentId: 'agent', runId: 'lead_run', emit: () => {}, spendPool: pool });
  const repair = ro.calls.find(c => c.outputOnly === true);
  A.ok(repair, 'dispatch: the structured-result repair ran');
  A.ok(repair && drawsFrom(repair.spendPool, pool), 'dispatch: the repair run draws from the lead run\'s pool too');
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-run-spend-pool-'));
try {
  {
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'bg.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    const pool = makeRunSpendPool({ capUsd: 1 }).join('lead_run');
    const ro = fakeRunOnce();
    const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(), subagents });
    await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'watch the feed' }], background: true }, { agentId: 'agent', runId: 'lead_run', emit: () => {}, spendPool: pool });
    for (let i = 0; i < 5 && !ro.calls.length; i++) await tick();
    A.ok(ro.calls.length === 1 && drawsFrom(ro.calls[0].spendPool, pool), 'background dispatch: a worker that outlives the lead\'s turn still draws from its run\'s pool (watched for holds: its stall clock)');
  }
  {
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'spawn.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    const pool = makeRunSpendPool({ capUsd: 1 }).join('lead_run');
    const ro = fakeRunOnce();
    const { spawnTool } = makeOrchestrationTools({ runOnce: ro, roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'S', newId: counter(), subagents });
    await spawnTool.run({ tasks: [{ prompt: 'part 1' }, { prompt: 'part 2' }, { prompt: 'part 3' }] }, { agentId: 'agent', runId: 'lead_run', emit: () => {}, spendPool: pool });
    A.eq(ro.calls.length, 3, 'spawn: three clones ran');
    A.ok(ro.calls.every(c => drawsFrom(c.spendPool, pool)), 'spawn: every clone draws from the lead run\'s pool (the d3a76db3 path), watched for holds');
  }
  {
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'resume.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    const first = subagents.start({ leadId: 'agent', agentId: 'researcher', prompt: 'retry', runId: 'run_a' }, async () => new Promise(() => {}));
    await tick();
    subagents.interrupt(first.id, 'agent');
    const reloaded = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'resume.json'), clock: { now: () => 1001 }, emit: () => {}, newId: counter() });
    const pool = makeRunSpendPool({ capUsd: 1 }).join('resuming_run');
    const ro = fakeRunOnce();
    const { resumeTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(), subagents: reloaded });
    await resumeTool.run({ id: first.id }, { agentId: 'agent', runId: 'resuming_run', emit: () => {}, spendPool: pool });
    for (let i = 0; i < 5 && !ro.calls.length; i++) await tick();
    A.ok(ro.calls.length === 1 && drawsFrom(ro.calls[0].spendPool, pool), 'resume: a resumed worker draws from the RESUMING run\'s pool (watched for holds: its stall clock)');
  }
  {
    // the whole seam with the real pool: a fake run host that joins the pool and checks it before its one call
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'sim.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    const pool = makeRunSpendPool({ capUsd: 0.05 }).join('lead_run');
    pool.admit('lead_run', 0); pool.booked('lead_run', 0.04); pool.idle('lead_run');
    let paidCalls = 0;
    const ro = fakeRunOnce(async (o) => {
      o.spendPool.join(o.runId);
      let stop = o.spendPool.admit(o.runId, 0);
      while (stop && stop.hold) { await stop.hold; stop = o.spendPool.admit(o.runId, 0); }   // as loop.js forSpend
      if (stop) { o.spendPool.settle(o.runId, 0); return { reason: 'budget', messages: [], usd: 0 }; }
      await tick();   // the call is in flight while its siblings reach their own boundary
      paidCalls++; o.spendPool.booked(o.runId, 0.04); o.spendPool.settle(o.runId, 0.04);
      return { reason: 'done', messages: [{ role: 'assistant', content: 'part done' }], usd: 0.04 };
    });
    const { spawnTool } = makeOrchestrationTools({ runOnce: ro, roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'S', newId: counter(), subagents });
    const out = await spawnTool.run({ tasks: [1, 2, 3, 4].map(i => ({ prompt: 'part ' + i })) }, { agentId: 'agent', runId: 'lead_run', emit: () => {}, spendPool: pool });
    const rows = JSON.parse(out.content);
    A.eq(paidCalls, 1, 'four clones started with $0.01 left: one paid call went out, not four');
    A.eq(rows.filter(r => r.reason === 'budget').length, 3, 'the other three come back to the lead as stopped by the spending cap');
    A.ok(pool.admit('lead_run', 0.04) !== null, 'and the lead itself is stopped at its next call boundary');
    A.ok(near(pool.status().spentUsd, 0.08), 'family spend $0.08 for a $0.05 cap (cap + one call), not $0.24');
  }

  // ---- 3. THE REAL LOOP: a lead run's team.spawn family through loop.js + orchestration.js + the pool ----
  // The run host is wired exactly as sidecar/index.js runOnceCore wires it (that module boots a sidecar, so it is
  // never required here): mint-or-join the pool, the context manager sized to the model's catalog window, the loop's
  // budget check asks pool.admit with the loop's own pre-call price, agent.cost books, the first agent.tool_call ends
  // the call, the run end settles. Every event goes through the real validating emitter.
  const turnText = (text, usd) => [{ type: 'text', delta: text }, { type: 'usage', usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48, cost: usd } }, { type: 'done', finishReason: 'stop' }];
  // a turn billed by its tokens alone (no provider-reported cost): the catalog prices it
  const turnTokens = (text, promptTokens, completionTokens) => [{ type: 'text', delta: text }, { type: 'usage', usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } }, { type: 'done', finishReason: 'stop' }];
  const turnSpawn = (n, usd, background) => [{ type: 'tool_start', index: 0, id: 'spawn_1', name: 'team_spawn' },
    { type: 'tool_args', index: 0, chunk: JSON.stringify(Object.assign({ tasks: Array.from({ length: n }, (_, i) => ({ prompt: 'part ' + (i + 1), label: 'part ' + (i + 1) })) }, background ? { background: true } : {})) },
    { type: 'usage', usage: { prompt_tokens: 4000, completion_tokens: 400, total_tokens: 4400, cost: usd } }, { type: 'done', finishReason: 'tool_calls' }];
  // a catalog price for the priced families ($10 / $30 per million, a 200k window, no output ceiling named): the most
  // a clone's call can cost is its prompt plus ~200k output tokens, ~$6 — more than any cap here, so these families'
  // calls take turns
  const PRICED = [{ id: 'replay/model', context_length: 200000, max_completion_tokens: null, pricing: { prompt: '0.00001', completion: '0.00003' }, supportsTools: true }];
  // the same prices on an 8k window: a call costs at most ~$0.24, so calls that fit under the cap go out together
  const PRICED_8K = [{ id: 'replay/model', context_length: 8000, max_completion_tokens: null, pricing: { prompt: '0.00001', completion: '0.00003' }, supportsTools: true }];
  // review of 32fc352e4 — THE COLD WINDOW: priced ($5 / $30 per million) but its catalog reports NO window and no output
  // ceiling, as the OpenAI API's /models does (gpt-5.x: a 400k window, up to 128k output). index.js sizes the context
  // manager to its cold 131072 guess, which 32fc352e4 priced calls from.
  const COLD = [{ id: 'replay/model', context_length: 0, max_completion_tokens: null, pricing: { prompt: '0.000005', completion: '0.00003' }, supportsTools: true }];
  // the same model when an output ceiling is known (128k) but still no window: a call bills its prompt + at most that
  const COLD_CEILING = [{ id: 'replay/model', context_length: 0, max_completion_tokens: 128000, pricing: { prompt: '0.000005', completion: '0.00003' }, supportsTools: true }];
  // review of 32fc352e4 — THE MANAGED DEFAULT: a 200k-window $3 / $15 model with a 64k output ceiling (Sonnet-class) on
  // the StarNet relay's default PER RUN $2. Reserved by its window (~$3 a call) every clone's call took its turn
  const SONNET = [{ id: 'replay/model', context_length: 200000, max_completion_tokens: 64000, pricing: { prompt: '0.000003', completion: '0.000015' }, supportsTools: true }];
  // a catalog that prices nothing (its row names no pricing): the call is billed only by usage.cost, so every pre-call
  // price is $0 — the "no price at all" path (counted as calls)
  const FREE = [{ id: 'replay/model', context_length: 200000, max_completion_tokens: 4096, supportsTools: true }];
  // a model its catalog prices at a KNOWN $0 (an OpenRouter :free row: $0 / $0): priced at about $0, never "no price"
  const KNOWN_FREE = [{ id: 'replay/model', context_length: 200000, max_completion_tokens: 4096, pricing: { prompt: '0', completion: '0' }, supportsTools: true }];
  const partOf = o => { const m = /part (\d+)/.exec(JSON.stringify(o.messages || [])); return m ? Number(m[1]) : 0; };
  // the roster a team.dispatch family delegates to (one agent per part)
  const crew = new Map([['w1', { system: 'W' }], ['w2', { system: 'W' }], ['w3', { system: 'W' }], ['w4', { system: 'W' }]]);
  const turnDispatch = (n, usd, background) => [{ type: 'tool_start', index: 0, id: 'dispatch_1', name: 'team_dispatch' },
    { type: 'tool_args', index: 0, chunk: JSON.stringify(Object.assign({ parallel: true, workers: Array.from({ length: n }, (_, i) => ({ agentId: 'w' + (i + 1), prompt: 'part ' + (i + 1) })) }, background ? { background: true } : {})) },
    { type: 'usage', usage: { prompt_tokens: 4000, completion_tokens: 400, total_tokens: 4400, cost: usd } }, { type: 'done', finishReason: 'tool_calls' }];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function family(label, capUsd, leadUsd, workerUsd, opt) {
    // timeoutMs: the orchestration budget (deps.dispatchTimeoutMs) — the tool is then registered with its own timeout
    // and the real clock, as index.js does; workerDelayMs: how long each worker's call stays in flight showing nothing;
    // workerStreamMs: how long each worker's call streams, a token every 20ms, before its answer (both real time, except
    // in a liveness family); stallMs: a LIVENESS FAMILY — the subagent manager runs with this liveness threshold on its
    // own clock, which moves in the 20ms steps the workers' calls take, and the host's sweep (checkStalls) runs after
    // every step, where index.js runs it every 30s (VIRTUAL TIME below); loopStallMs: one real event-loop stall of this
    // length in a liveness family; background: the lead starts its workers with background:true and the family waits
    // for them to settle
    const { models, selfSystem, synthUsd, workerTurns, workerDelay, workerDelayMs, workerStreamMs, tasks, tool, timeoutMs, stallMs, loopStallMs, background } = opt || {};
    const viaDispatch = tool === 'dispatch';
    const ends = [], invalid = [];
    const newId = counter();
    let modelCalls = 0;
    /* VIRTUAL TIME, the liveness families (pending register R8; test/helpers/loop-stall.js names the evidence). Their
       threshold ran on the real clock, swept every 15ms, and on a loaded box a late sweep read the event loop's own delay
       as a worker's silence and stopped the worker as stalled. Now the manager's clock (deps.clock, which index.js fills
       with Date.now) reads vnow, and vnow moves only in step(): the 20ms steps a worker's call takes, workerDelayMs of
       silence or workerStreamMs of one token a step. The sweep runs after every step, from a clean stack (setImmediate),
       so it sees every value the clock takes, and no event-loop delay can move the clock: the verdict is the same under
       any load. loopStallMs shows that on every run, with one real stall after the first call's third token (or a silent
       call's third step) while the other calls are held. */
    const virtual = !!stallMs;
    let vnow = 1000, liveStreams = 0, loopStalledMs = null;
    const staled = [];
    const step = ms => new Promise(resolve => setImmediate(() => {
      vnow += ms;
      for (const w of subagents.checkStalls()) staled.push(w.agentId);
      resolve();
    }));
    const stallOnce = () => { if (loopStallMs > 0 && loopStalledMs === null) loopStalledMs = stallNow(loopStallMs); };
    async function hostRun(o) {
      const pool = isRunSpendPool(o.spendPool) ? o.spendPool : makeRunSpendPool({ capUsd });
      pool.join(o.runId);
      const bus = A.makeBus();
      const seq = A.collectBus(bus, events.names());
      const valid = makeEmitter(bus, e => invalid.push(e));
      const emit = (name, payload) => {
        if (payload && payload.runId === o.runId) {
          if (name === 'agent.cost') pool.booked(o.runId, Number(payload.usd) || 0);
          else if (name === 'agent.tool_call') pool.idle(o.runId);
        }
        const r = valid(name, payload);
        // as index.js: every event of the run reaches the caller's emit too (a subagent's h.emit: its event tail and the
        // liveness clock checkStalls reads)
        if (typeof o.emit === 'function') o.emit(name, payload);
        return r;
      };
      const replay = makeReplayProvider({ turns: o.turns, models });
      // a liveness family's call (VIRTUAL TIME above): its silence and its tokens move the manager's clock, 20ms a step
      async function* steppedStream(req) {
        modelCalls++; liveStreams++;
        try {
          for (let i = 0; i < (o.delay || 0); i++) await tick();
          for (let q = 0; q < (o.delayMs || 0) / 20; q++) { await step(20); if (q === 2) stallOnce(); }
          for (let k = 0; k < (o.streamMs || 0) / 20; k++) { await step(20); yield { type: 'text', delta: '.' }; if (k === 2) stallOnce(); }
          yield* replay.stream(req);
        } finally { liveStreams--; }
      }
      // a clone that answers later (its delay in ticks before the stream starts): the cheap clone books first
      const provider = Object.assign({}, replay, { stream: virtual ? steppedStream : async function* (req) {
        modelCalls++;
        for (let i = 0; i < (o.delay || 0); i++) await tick();
        if (o.delayMs) await sleep(o.delayMs);
        for (const until = Date.now() + (o.streamMs || 0); Date.now() < until;) { yield { type: 'text', delta: '.' }; await sleep(20); }
        yield* replay.stream(req);
      } });
      // as index.js: the run's system prompt leads its messages, the context manager is the loop's ruler sized to the
      // model's catalog window (or the cold 131072 guess when the catalog reports none: COLD_CATALOG_CONTEXT_TOKENS), the
      // loop is told the window the provider REPORTS (provider.contextLimit, 0 = none), and the budget check hands the
      // loop's pre-call price (its second argument) to the pool
      const msgs = (o.system ? [{ role: 'system', content: o.system }] : []).concat(o.messages || [{ role: 'user', content: 'go' }]);
      const ctxMgr = makeContext({ contextLimit: replay.contextLimit('replay/model') || 131072 });
      const res = await runAgentLoop({ messages: msgs, provider, emit, cost: makeCostEngine({ priceOf: replay.priceOf }),
        model: 'replay/model', agentId: o.agentId, runId: o.runId, limits: { maxCostUsd: capUsd, maxIters: 6, grace: false }, signal: o.signal,
        budget: { check: (spent, nextCallUsd) => pool.admit(o.runId, spent, nextCallUsd) },
        context: ctxMgr, approxTokens: ctxMgr.estimateMessages(msgs), contextLimit: replay.contextLimit('replay/model'),
        tools: o.tools || [], dispatch: o.dispatch, capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: o.agentId, room: 'office' } });
      pool.settle(o.runId, res.usd);
      const end = seq.find(e => e.name === 'agent.run.end');
      ends.push({ agentId: o.agentId, part: o.part, end: end && end.payload });
      return res;
    }
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, label + '.json'), clock: { now: virtual ? () => vnow : () => 1000 }, emit: () => {}, newId,
      ...(stallMs ? { stallMs, inToolStallMs: stallMs } : {}) });
    const runOnce = (o) => {
      const part = partOf(o);
      return hostRun({ runId: o.runId, agentId: o.agentId || 'sub', spendPool: o.spendPool, system: o.system, messages: o.messages, part, emit: o.emit, signal: o.signal,
        delay: workerDelay ? workerDelay(part) : 0, delayMs: workerDelayMs || 0, streamMs: workerStreamMs || 0, turns: workerTurns ? workerTurns(part) : [turnText('part done', workerUsd)] });
    };
    const timed = typeof timeoutMs === 'number' && timeoutMs > 0;
    const { spawnTool, dispatchTool } = makeOrchestrationTools({ runOnce, roster: () => (viaDispatch ? crew : new Map()), key: 'k', model: 'replay/model', selfSystem: selfSystem || 'S', newId, subagents,
      ...(timed ? { dispatchTimeoutMs: timeoutMs, now: () => Date.now() } : {}) });
    const teamTool = viaDispatch ? dispatchTool : spawnTool;
    const wireName = viaDispatch ? 'team_dispatch' : 'team_spawn';
    const leadPool = makeRunSpendPool({ capUsd });   // index.js mints the lead's pool and puts it on its tool ctx
    let peak = 0, maxHeldMs = 0;
    const realAdmit = leadPool.admit;
    leadPool.admit = (...a) => {
      const r = realAdmit(...a);
      if (r === null) peak = Math.max(peak, leadPool.status().inFlight);
      // a liveness family also times each worker's hold on the manager's clock, from the hold to the settle that ends it
      // (the lead is no subagent: nothing sweeps it, so its own holds are skipped)
      else if (virtual && r.hold && a[0] !== 'lead') {
        const from = vnow, held = () => { maxHeldMs = Math.max(maxHeldMs, vnow - from); };
        Promise.resolve(r.hold).then(held, held);
      }
      return r;
    };
    // as index.js: the run's registry has the real clock, and the tool runs on the registry's own ctx (its signal, its
    // holdTimeout) plus the host-minted pool
    const reg = makeRegistry(timed ? { clock: { now: () => Date.now() } } : undefined);
    reg.register({ impact: 'none', name: wireName, schema: teamTool.schema, ...(timed ? { timeoutMs: teamTool.timeoutMs } : {}),
      run: async (args, rctx) => (await teamTool.run(args, { agentId: 'agent', runId: 'lead', emit: () => {}, spendPool: leadPool,
        signal: rctx && rctx.signal, holdTimeout: rctx && rctx.holdTimeout })).content });
    let toolResult = null;
    const leadTurn = (viaDispatch ? turnDispatch : turnSpawn)(tasks || 4, leadUsd, background === true);
    await hostRun({ runId: 'lead', agentId: 'agent', spendPool: leadPool, turns: [leadTurn, turnText('combined brief', synthUsd === undefined ? leadUsd : synthUsd)],
      tools: [{ type: 'function', function: { name: wireName, parameters: teamTool.schema } }],
      dispatch: async (c, ctx) => { const r = await reg.dispatch(c, ctx); toolResult = r; return r; } });
    // background workers outlive the lead's turn: wait until each has settled, on loop turns (bounded by a count, never a
    // deadline; every background family is a liveness family, whose clock moves only in such turns)
    const settled = () => ends.filter(e => e.agentId !== 'agent').length;
    if (background) A.ok(await waitFor(() => settled() >= (tasks || 4), { turns: 20000, everyMs: 0 }), label + ': every background worker settled: ' + settled() + ' of ' + (tasks || 4));
    // a worker the sweep stopped mid-call runs on until its call yields again: no call outlives its family
    if (virtual) A.ok(await waitFor(() => liveStreams === 0, { turns: 20000, everyMs: 0 }), label + ': every call the family started has ended (' + liveStreams + ' still streaming)');
    const lead = ends.find(e => e.agentId === 'agent');
    const workers = ends.filter(e => e.agentId !== 'agent').sort((a, b) => a.part - b.part);
    const st = typeof leadPool.status === 'function' ? leadPool.status() : {};
    return { lead: lead && lead.end, workers: workers.map(w => w.end), invalid, spentUsd: st.spentUsd, calls: st.calls, modelCalls, peak, toolResult,
      staled, records: subagents.list(), loopStalledMs, maxHeldMs };
  }
  const { endNote: channelNote } = require('../sidecar/channels/hub.js');
  const commsLine = new Function(A.fnBody(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8'), 'function budgetStopLine(') + '\nreturn budgetStopLine;')();
  const hitStops = (f, cap) => f.workers.filter(w => w && w.reason === 'budget').every(w => w.budgetScope === 'run' && w.budgetCapUsd === cap && w.usd === 0 && w.budgetProjected === undefined);
  {
    // MIXED COSTS: the lead's spawning turn $0.18, its clones $0.02 each, PER RUN $0.50 — the job fits, so it all runs
    const f = await family('mixed', 0.50, 0.18, 0.02, { models: FREE });
    A.eq(f.invalid, [], 'mixed: every event the family emitted passed the event contract');
    A.eq(f.workers.length, 4, 'mixed: four clones ran');
    A.eq(f.workers.map(w => w && w.reason), ['done', 'done', 'done', 'done'], 'mixed: all four clones finished — none stopped on the lead\'s $0.18 turn');
    A.eq(f.lead && f.lead.reason, 'done', 'mixed: the lead took its synthesis turn and finished');
    A.ok(near(f.spentUsd, 0.44), 'mixed: the family spent $0.44 ($0.18 + 4 x $0.02 + $0.18) inside its $0.50 cap: $' + f.spentUsd);
    A.eq(f.peak, 1, 'mixed: a model nothing prices: its clones\' calls took turns (counted as calls)');
  }
  {
    // THE REPRO (d3a76db3): every call $0.04, PER RUN $0.05, a model nothing prices (as the e2e) — one clone's call
    // goes, the others wait for its real cost and stop on the cap it reached
    const f = await family('repro', 0.05, 0.04, 0.04, { models: FREE });
    A.eq(f.invalid, [], 'repro: every event passed the event contract');
    const stopped = f.workers.filter(w => w && w.reason === 'budget');
    A.eq([f.workers.filter(w => w && w.reason === 'done').length, stopped.length], [1, 3], 'repro: one clone ran, three stopped');
    A.ok(hitStops(f, 0.05), 'repro: each stopped clone names the lead\'s $0.05 cap the family really reached ($0.08), at $0 — a hit, no projected flag: ' + JSON.stringify(stopped));
    A.ok(f.lead && f.lead.reason === 'budget' && f.lead.budgetScope === 'run' && f.lead.budgetCapUsd === 0.05 && f.lead.budgetProjected === undefined,
      'repro: the lead stops at the $0.05 cap the family really reached — a hit, no projected flag: ' + JSON.stringify(f.lead));
    A.ok(near(f.spentUsd, 0.08), 'repro: the family spent $0.08 for a $0.05 cap (the cap plus one call), not $0.24');
    // a real hit says hit on every surface
    const l = f.lead;
    A.ok(/^hit the \$0\.05 per-run spend cap — raise it in /.test(commsLine(l.budgetScope, l.budgetCapUsd, l.budgetCapIsBalance === true, null, null, l.budgetProjected === true)), 'COMMS: the lead\'s real hit says hit');
    A.ok(/\(hit the \$0\.05 per-run spend cap/.test(channelNote('budget', l)), 'channels: the lead\'s real hit says hit');
  }
  // PRICED FAMILIES on a 200k window: the most a clone's call can cost is ~$6, more than these caps, so each call goes
  // out on its own and the family stops on the cap it really reached — never on a projection.
  // A clone's prompt here is the lead's own identity (selfSystem, ~3,000 tokens = ~$0.03 of input at $10/M).
  const identity = n => 'You are the station lead. '.repeat(Math.ceil(n / 25)).slice(0, n);
  {
    // THE CHEAP-LEAD CASE: PER RUN $0.05, the lead's spawning turn $0.01, four $0.04 clones. d42189a18 spent $0.17,
    // a1234b154 $0.09 (two clones stopped on a projection)
    const f = await family('cheapLead', 0.05, 0.01, 0.04, { models: PRICED, selfSystem: identity(12000) });
    A.eq(f.invalid, [], 'cheap lead: every event passed the event contract');
    const stopped = f.workers.filter(w => w && w.reason === 'budget');
    A.eq([f.workers.filter(w => w && w.reason === 'done').length, stopped.length], [1, 3], 'cheap lead: one clone ran, three stopped — not all four at once');
    A.ok(hitStops(f, 0.05), 'cheap lead: each stopped clone stopped on the $0.05 cap the family really reached, at $0: ' + JSON.stringify(stopped));
    A.ok(f.lead && f.lead.reason === 'budget' && f.lead.budgetCapUsd === 0.05 && f.lead.budgetProjected === undefined, 'cheap lead: the lead stops at its next boundary on a real hit: ' + JSON.stringify(f.lead));
    A.ok(near(f.spentUsd, 0.05), 'cheap lead: the family spent $0.05 — exactly the cap: $' + f.spentUsd);
  }
  {
    // EXPENSIVE CLONES: PER RUN $0.50, the lead $0.05, four $0.20 clones (~$0.16 of input each). d42189a18 spent $0.85.
    const f = await family('bigClones', 0.50, 0.05, 0.20, { models: PRICED, selfSystem: identity(64000) });
    A.eq(f.invalid, [], 'big clones: every event passed the event contract');
    A.eq(f.workers.map(w => w && w.reason).sort(), ['budget', 'done', 'done', 'done'], 'big clones: three clones ran, the fourth stopped on the cap');
    A.ok(hitStops(f, 0.50), 'big clones: the stop is the cap the family reached');
    A.ok(near(f.spentUsd, 0.65), 'big clones: the family spent $0.65 — over the $0.50 cap by $0.15, less than the $0.20 call admitted last — not $0.85: $' + f.spentUsd);
  }
  {
    // cheap clones stay cheap when priced: lead $0.18, four $0.02 clones (~$0.015 of input each), PER RUN $0.50
    const f = await family('mixedPriced', 0.50, 0.18, 0.02, { models: PRICED, selfSystem: identity(6000) });
    A.eq(f.invalid, [], 'mixed priced: every event passed the event contract');
    A.eq(f.workers.map(w => w && w.reason), ['done', 'done', 'done', 'done'], 'mixed priced: all four clones finished — a reservation only ever delays a call');
    A.eq(f.lead && f.lead.reason, 'done', 'mixed priced: the lead took its synthesis turn and finished');
    A.ok(near(f.spentUsd, 0.44), 'mixed priced: the family spent $0.44 inside its $0.50 cap: $' + f.spentUsd);
  }
  {
    // NEAR THE CAP (review of d42d1bc7e): the lead's spawning turn $0.60 leaves $0.40 under PER RUN $1; four $0.02
    // clones and a $0.10 synthesis turn need $0.78 and fit, so all of them run
    const f = await family('nearCapPriced', 1, 0.60, 0.02, { models: PRICED, selfSystem: identity(6000), synthUsd: 0.10 });
    A.eq(f.invalid, [], 'near cap priced: every event passed the event contract');
    A.eq(f.workers.map(w => w && w.reason), ['done', 'done', 'done', 'done'], 'near cap priced: all four clones finished: ' + JSON.stringify(f.workers));
    A.eq(f.lead && f.lead.reason, 'done', 'near cap priced: the lead took its synthesis turn and finished');
    A.ok(near(f.spentUsd, 0.78), 'near cap priced: the family spent $0.78 ($0.60 + 4 x $0.02 + $0.10) inside its $1 cap: $' + f.spentUsd);
  }
  // OUTPUT-HEAVY CLONES (review of 9d4fc52b5): clones billed mostly for output. Each call is reserved at its prompt
  // plus every output token its window leaves room for, so output can no longer slip past an input-only price.
  {
    // PER RUN $0.05, the lead $0.03, four clones billed $0.06 each with ~$0.005 of input. 9d4fc52b5: $0.27.
    const f = await family('outputHeavyNearCap', 0.05, 0.03, 0.06, { models: PRICED, selfSystem: identity(2000) });
    A.eq(f.invalid, [], 'output-heavy near cap: every event passed the event contract');
    A.eq(f.workers.map(w => w && w.reason).sort(), ['budget', 'budget', 'budget', 'done'], 'output-heavy near cap: one clone ran, the other three stopped: ' + JSON.stringify(f.workers));
    A.ok(hitStops(f, 0.05), 'output-heavy near cap: each stop is the cap the family really reached ($0.09 booked), at $0: ' + JSON.stringify(f.workers));
    A.ok(f.lead && f.lead.reason === 'budget' && f.lead.budgetCapUsd === 0.05, 'output-heavy near cap: the lead stops at its next boundary: ' + JSON.stringify(f.lead));
    A.ok(near(f.spentUsd, 0.09), 'output-heavy near cap: the family spent $0.09 — over the cap by $0.04, less than the $0.06 call admitted last — not $0.27: $' + f.spentUsd);
  }
  {
    // PER RUN $1, the lead $0.80, four clones with ~6,000-token prompts billed $0.30 each, as reasoning output bills.
    // 9d4fc52b5: $2.00.
    const f = await family('reasoningNearCap', 1, 0.80, 0.30, { models: PRICED, selfSystem: identity(24000) });
    A.eq(f.invalid, [], 'reasoning near cap: every event passed the event contract');
    A.eq(f.workers.map(w => w && w.reason).sort(), ['budget', 'budget', 'budget', 'done'], 'reasoning near cap: one clone ran, three stopped on its real $0.30 cost: ' + JSON.stringify(f.workers));
    A.ok(hitStops(f, 1), 'reasoning near cap: each stopped clone names the lead\'s $1 cap and spent $0');
    A.ok(near(f.spentUsd, 1.10), 'reasoning near cap: the family spent $1.10 — over the $1 cap by $0.10, less than the $0.30 call admitted last — not $2.00: $' + f.spentUsd);
  }
  {
    // far from the cap: the lead $0.30 leaves $0.70 under PER RUN $1; the same $0.30 clones. 9d4fc52b5 (and d42d1bc7e)
    // let all four fire: $1.50. Each call goes out on its own; the third goes with $0.10 left and books $0.30.
    const f = await family('reasoningFar', 1, 0.30, 0.30, { models: PRICED, selfSystem: identity(24000) });
    A.eq(f.invalid, [], 'reasoning far: every event passed the event contract');
    const stopped = f.workers.filter(w => w && w.reason === 'budget');
    A.eq([f.workers.filter(w => w && w.reason === 'done').length, stopped.length], [3, 1], 'reasoning far: three clones ran, the fourth stopped: ' + JSON.stringify(f.workers));
    A.ok(hitStops(f, 1), 'reasoning far: the stop is the $1 cap the family really reached, at $0: ' + JSON.stringify(stopped));
    A.ok(near(f.spentUsd, 1.20), 'reasoning far: the family spent $1.20 — OVER the $1 cap by $0.20, less than the $0.30 call admitted last (it went out with $0.10 left): $' + f.spentUsd);
  }
  {
    // the repro on the replay DEFAULT catalog (every token $1/M in, $2/M out, an 8k window: a clone's call is priced at
    // most ~$0.016, but the lead's turn booked $0.04, and no reservation is less than the costliest call booked)
    const f = await family('reproDefaultCatalog', 0.05, 0.04, 0.04, {});
    A.eq(f.invalid, [], 'repro, default catalog: every event passed the event contract');
    A.eq(f.workers.map(w => w && w.reason).sort(), ['budget', 'budget', 'budget', 'done'], 'repro, default catalog: one clone ran, three stopped: ' + JSON.stringify(f.workers));
    A.ok(hitStops(f, 0.05), 'repro, default catalog: each stopped clone names the lead\'s $0.05 cap and spent $0');
    A.ok(near(f.spentUsd, 0.08), 'repro, default catalog: the family spent $0.08 — the cap plus one call — not $0.20: $' + f.spentUsd);
  }
  // HETEROGENEOUS CLONES (review of a1234b154): a $0.02 clone and a 10x heavier $0.20 one, billed by their tokens on an
  // 8k window at $10/$30 per million (a clone's call costs at most ~$0.24). The heavy clones answer later, so the cheap
  // ones book first — on a1234b154 that replaced the lead-turn fallback with the cheap clone's cost, and the heavy
  // calls in flight were counted at $0.02. At every cap the family passes it by less than one call.
  const cheapTurn = () => [turnTokens('part done', 200, 600)];      // $0.002 + $0.018 = $0.020
  const heavyTurn = () => [turnTokens('long part done', 200, 6600)]; // $0.002 + $0.198 = $0.200
  const heteroCaps = [0.05, 0.10, 0.20, 0.30, 0.50, 1.00];
  for (const [shape, tasks, turnsOf] of [
    ['one cheap + one heavy', 2, p => (p === 1 ? cheapTurn() : heavyTurn())],
    ['two cheap + two heavy', 4, p => (p % 2 === 1 ? cheapTurn() : heavyTurn())],
  ]) {
    for (const models of [PRICED_8K, FREE]) {
      const priced = models === PRICED_8K;
      for (const cap of heteroCaps) {
        const label = 'hetero ' + shape + (priced ? ', priced' : ', unpriced') + ', cap ' + money(cap);
        const f = await family('hetero' + tasks + (priced ? 'p' : 'u') + cap, cap, 0.01, 0, { models, tasks, synthUsd: 0.01,
          workerTurns: p => (priced ? turnsOf(p) : turnsOf(p).map(t => t.map(ev => ev.type === 'usage' ? { type: 'usage', usage: Object.assign({}, ev.usage, { cost: ev.usage.completion_tokens > 1000 ? 0.20 : 0.02 }) } : ev))),
          workerDelay: p => (p % 2 === 0 ? 6 : 0) });
        const need = 0.01 + (tasks / 2) * 0.22 + 0.01;
        A.eq(f.invalid, [], label + ': every event passed the event contract');
        A.ok(f.spentUsd - cap < 0.20 - 1e-9, label + ': the family spent ' + money(f.spentUsd) + ' — never past the cap by one $0.20 call: ' + JSON.stringify(f.workers.map(w => w && [w.reason, w.usd])));
        A.ok(f.workers.filter(w => w && w.reason === 'budget').every(w => w.budgetScope === 'run' && w.budgetCapUsd === cap && w.budgetProjected === undefined), label + ': every stop is the cap the family really reached');
        if (need < cap) {
          A.ok(f.workers.every(w => w && w.reason === 'done') && f.lead && f.lead.reason === 'done' && near(f.spentUsd, need), label + ': the work fits (' + money(need) + '), so every clone and the lead finish: ' + JSON.stringify([f.lead && f.lead.reason, f.workers.map(w => w && w.reason), f.spentUsd]));
        }
        A.eq(f.calls, f.modelCalls, label + ': every call that went out is counted (' + f.modelCalls + ')');
        if (!priced) A.eq(f.peak, 1, label + ': with no price, one call in flight at a time');
        if (priced && cap === 1.00) A.eq(f.peak, tasks, label + ': with room for every reservation, all ' + tasks + ' clones call at once');
      }
    }
  }
  // REVIEW OF 32fc352e4 — THE COLD WINDOW: priced at $5/$30 per million with no window and no output ceiling reported
  // (COLD), the context manager at index.js's cold 131072 guess, PER RUN $5, four output-heavy clones (a ~60k-token
  // prompt, 100k output tokens: $0.30 + $3.00 = $3.30 a call). 32fc352e4 reserved each call at ~$2.43 from the guess
  // and let three go out together: $9.92 for a $5 cap — $4.92 over, more than the $3.30 call admitted last.
  const outputHeavy = () => [turnTokens('long part done', 60000, 100000)];
  {
    const f = await family('coldWindow', 5, 0.05, 0, { models: COLD, selfSystem: identity(240000), workerTurns: outputHeavy, synthUsd: 0.01 });
    A.eq(f.invalid, [], 'cold window: every event passed the event contract');
    A.ok(f.spentUsd - 5 < 3.30 - 1e-9, 'cold window: the family spent ' + money(f.spentUsd) + ' — past the $5 cap by less than the $3.30 call admitted last: ' + JSON.stringify(f.workers.map(w => w && [w.reason, w.usd])));
    A.eq(f.peak, 1, 'cold window: a call nothing bounds has no price, so the clones\' calls took turns (counted as calls)');
    A.eq(f.workers.map(w => w && w.reason).sort(), ['budget', 'budget', 'done', 'done'], 'cold window: two clones ran (the second with $1.65 left), two stopped on the cap the family reached');
    A.ok(f.workers.filter(w => w && w.reason === 'budget').every(w => w.budgetScope === 'run' && w.budgetCapUsd === 5 && w.usd === 0 && w.budgetProjected === undefined), 'cold window: each stop is the $5 cap the family really reached');
    A.eq(f.calls, f.modelCalls, 'cold window: every call that went out is counted (' + f.modelCalls + ')');
  }
  {
    // the same clones once the model's 128k output ceiling is known (no window still): each call is reserved at its
    // prompt + 128k output ($4.14), so two go out together and the family still passes the cap by less than one call
    const f = await family('coldCeiling', 5, 0.05, 0, { models: COLD_CEILING, selfSystem: identity(240000), workerTurns: outputHeavy, workerDelay: () => 6, synthUsd: 0.01 });
    A.eq(f.invalid, [], 'cold window, 128k ceiling: every event passed the event contract');
    A.ok(f.spentUsd - 5 < 3.30 - 1e-9, 'cold window, 128k ceiling: the family spent ' + money(f.spentUsd) + ' — past the $5 cap by less than one $3.30 call');
    A.eq(f.peak, 2, 'cold window, 128k ceiling: two $4.14 reservations fit under the cap at once, a third does not');
  }
  // REVIEW OF 32fc352e4 — THE MANAGED DEFAULT: PER RUN $2 (budgetcaps DEFAULT_MANAGED_PER_RUN_USD) on a 200k-window
  // $3/$15 model with a 64k output ceiling, four clones whose calls cost $0.03 (3,000 prompt + 1,400 output tokens).
  // 32fc352e4 reserved each call by its window (~$2.96, over the cap) and ran them one at a time.
  const smallTurn = () => [turnTokens('part done', 3000, 1400)];   // $0.009 + $0.021 = $0.030
  {
    const f = await family('managedSonnet', 2, 0.01, 0, { models: SONNET, workerTurns: smallTurn, workerDelay: () => 6, synthUsd: 0.01 });
    A.eq(f.invalid, [], 'managed $2: every event passed the event contract');
    A.eq(f.workers.map(w => w && w.reason), ['done', 'done', 'done', 'done'], 'managed $2: all four clones finished');
    A.eq(f.lead && f.lead.reason, 'done', 'managed $2: the lead took its synthesis turn and finished');
    A.ok(near(f.spentUsd, 0.14), 'managed $2: the family spent $0.14 ($0.01 + 4 x $0.03 + $0.01): $' + f.spentUsd);
    A.eq(f.peak, 3, 'managed $2: each call is reserved at ~$0.97 (its 64k output ceiling), so three go out at once under $2 — not one at a time');
  }
  // REVIEW OF 32fc352e4 — A HELD FAMILY IS NOT TIMED OUT BY ITS HOLDS. A model nothing prices (every call counted as a
  // call: one in flight at a time), three clones whose calls each take 150ms, a 300ms team.spawn / team.dispatch
  // budget: together the calls need 450ms, but each clone's own work is 150ms. 32fc352e4 ran the wait down the tool's
  // registry timeout (team.spawn: every clone aborted, "timed out") and each dispatch worker's slice.
  {
    const f = await family('heldSpawn', 1, 0.01, 0.01, { models: FREE, tasks: 3, workerDelayMs: 150, timeoutMs: 300, synthUsd: 0.01 });
    A.eq(f.invalid, [], 'held spawn: every event passed the event contract');
    A.ok(f.toolResult && f.toolResult.ok === true && !/timed out/.test(String(f.toolResult.content)), 'held spawn: the 300ms team.spawn timeout did not fire on 450ms of calls taken in turns: ' + JSON.stringify(f.toolResult && [f.toolResult.ok, f.toolResult.summary, String(f.toolResult.content).slice(0, 160)]));
    A.eq(f.workers.map(w => w && w.reason), ['done', 'done', 'done'], 'held spawn: every clone finished');
    A.eq(f.peak, 1, 'held spawn: the clones\' calls took turns');
    A.eq(f.lead && f.lead.reason, 'done', 'held spawn: the lead read every clone\'s result and finished');
  }
  {
    const f = await family('heldDispatch', 1, 0.01, 0.01, { models: FREE, tool: 'dispatch', tasks: 3, workerDelayMs: 150, timeoutMs: 300, synthUsd: 0.01 });
    A.eq(f.invalid, [], 'held dispatch: every event passed the event contract');
    const rows = (() => { try { return JSON.parse(f.toolResult.content); } catch (_) { return []; } })();
    A.eq(rows.map(r => r && r.reason), ['done', 'done', 'done'], 'held dispatch: no worker ran out of its 300ms slice while it waited for a call in flight: ' + JSON.stringify(rows.map(r => r && [r.agentId, r.reason])));
    A.eq(f.peak, 1, 'held dispatch: the workers\' calls took turns');
  }
  {
    // the clocks still bound the WORK: one clone whose own call takes 450ms is stopped by the 300ms timeout
    const f = await family('slowSpawn', 1, 0.01, 0.01, { models: FREE, tasks: 1, workerDelayMs: 450, timeoutMs: 300, synthUsd: 0.01 });
    A.ok(f.toolResult && /timed out/.test(String(f.toolResult.content)), 'slow spawn: a clone whose own work outlasts the budget still times out: ' + JSON.stringify(f.toolResult && String(f.toolResult.content).slice(0, 120)));
    await sleep(300);   // the aborted clone's replay call settles before the next family
  }
  // REVIEW OF 8f4267c08 — A HELD CALL IS NOT A STALL. A worker whose call the pool holds emits nothing while it waits, and
  // the host's liveness sweep (subagents.js checkStalls: no progress for 450s, swept every 30s by index.js) covers every
  // team.spawn clone and every background team.dispatch worker. 8f4267c08 paused team.spawn's timeout and the dispatch
  // slices during holds, but not that sweep: a clone held longer than the threshold was stopped as stalled, its work
  // "INCOMPLETE and not accepted", in a family well under its cap. Scaled: a 150ms threshold on the manager's own clock,
  // which moves in the 20ms steps a call takes and is swept after every step (VIRTUAL TIME in family()), a model nothing
  // prices (one call in flight at a time), three workers whose calls each stream a token every 20ms for 240ms — each
  // worker is busy for its whole call, and each call after the first is held 240ms at a time, past the threshold. One
  // real 300ms loop stall lands after the first call's third token, while the others are held: on the real clock that
  // got the streaming worker stopped as stalled; on the manager's clock it moves nothing.
  for (const [shape, extra] of [['spawn', {}], ['background spawn', { background: true }], ['background dispatch', { tool: 'dispatch', background: true }]]) {
    const f = await family('heldStall' + shape.replace(/ /g, ''), 1, 0.01, 0.01, Object.assign({ models: FREE, tasks: 3, workerStreamMs: 240, stallMs: 150, loopStallMs: 300, synthUsd: 0.01 }, extra));
    A.eq(f.invalid, [], 'held ' + shape + ', liveness sweep: every event passed the event contract');
    A.eq(f.staled, [], 'held ' + shape + ', liveness sweep: no worker was stopped as stalled while its call waited for room');
    A.eq(f.records.map(r => r.status), ['done', 'done', 'done'], 'held ' + shape + ', liveness sweep: the record of every worker is done: ' + JSON.stringify(f.records.map(r => [r.agentId, r.status, r.reason])));
    A.eq(f.workers.map(w => w && w.reason), ['done', 'done', 'done'], 'held ' + shape + ', liveness sweep: the run of every worker finished');
    A.eq(f.peak, 1, 'held ' + shape + ', liveness sweep: the calls took turns (each later one was held past the threshold)');
    A.eq(f.lead && f.lead.reason, 'done', 'held ' + shape + ', liveness sweep: the lead finished');
    A.ok(f.loopStalledMs >= 240, 'held ' + shape + ', liveness sweep: a real loop stall landed after the first call\'s third token: ' + f.loopStalledMs + 'ms');
    A.ok(f.maxHeldMs > 150, 'held ' + shape + ', liveness sweep: a worker\'s call was held past the 150ms threshold on the manager\'s clock: ' + f.maxHeldMs + 'ms');
  }
  {
    // the sweep still catches a worker that is really silent: one clone whose own call shows nothing for 300ms on the
    // manager's clock is stopped at the first 20ms step at or past the threshold, under the same loop stall
    const f = await family('silentStall', 1, 0.01, 0.01, { models: FREE, tasks: 1, workerDelayMs: 300, stallMs: 150, loopStallMs: 300, synthUsd: 0.01 });
    A.eq(f.staled.length, 1, 'silent clone: the liveness sweep still stops a worker whose own call is silent past the threshold: ' + JSON.stringify(f.staled));
    A.eq(f.records.map(r => r.status), ['stale'], 'silent clone: its record is stale, not done');
    A.ok(f.toolResult && /made no progress/.test(String(f.toolResult.content)), 'silent clone: the lead is told the worker was stopped for no progress: ' + JSON.stringify(f.toolResult && String(f.toolResult.content).slice(0, 160)));
    A.eq((f.records[0] || {}).stalledAfterMs, 160, 'silent clone: stopped at the first 20 ms step at or past the 150 ms threshold');
    A.ok(f.loopStalledMs >= 240, 'silent clone: a real loop stall landed while its call was silent: ' + f.loopStalledMs + 'ms');
  }
  // A $0 LEAD AND A $0 WORKER (calls, not only dollars): nothing booked a cent to reserve by, and a1234b154 let every
  // paid clone fire on that $0 — the lead's $0 turn was "no measure" and a $0 call in flight counted as nothing.
  {
    // a free-model lead ($0 turns) and four clones billed $0.04 each by usage.cost, PER RUN $0.05. a1234b154: $0.16.
    const f = await family('zeroLead', 0.05, null, 0.04, { models: FREE });
    A.eq(f.invalid, [], '$0 lead: every event passed the event contract');
    A.eq(f.workers.map(w => w && w.reason).sort(), ['budget', 'budget', 'done', 'done'], '$0 lead: two clones ran (the second with $0.01 left), two stopped: ' + JSON.stringify(f.workers));
    A.ok(hitStops(f, 0.05), '$0 lead: each stop is the cap the family really reached');
    A.ok(near(f.spentUsd, 0.08), '$0 lead: the family spent $0.08 — over the cap by $0.03, less than the $0.04 call admitted last — not $0.16: $' + f.spentUsd);
    A.eq(f.calls, f.modelCalls, '$0 lead: the $0 lead turn is counted as a call like every other (' + f.modelCalls + ')');
  }
  {
    // the first clone's calls book $0 (no cost reported, a model nothing prices), the other three bill $0.04
    const f = await family('zeroWorker', 0.05, null, 0.04, { models: FREE,
      workerTurns: p => [p === 1 ? turnTokens('part done', 40, 8) : turnText('part done', 0.04)] });
    A.eq(f.invalid, [], '$0 worker: every event passed the event contract');
    A.eq(f.workers.map(w => w && w.reason), ['done', 'done', 'done', 'budget'], '$0 worker: the $0 clone and two paid ones ran, one at a time; the fourth stopped: ' + JSON.stringify(f.workers));
    A.ok(near(f.spentUsd, 0.08), '$0 worker: the family spent $0.08, not $0.12: $' + f.spentUsd);
    A.eq(f.calls, f.modelCalls, '$0 worker: its $0 call is counted (' + f.modelCalls + ' calls)');
    A.eq(f.peak, 1, '$0 worker: its call in flight held its paid siblings');
  }
  // A HELD CALL IN THE REAL LOOP: it waits, asks again, and a STOP ends the wait at once (never outlasts a cancel)
  async function heldRun(abortAfterHold) {
    const bus = A.makeBus();
    const seq = A.collectBus(bus, events.names());
    const invalid = [];
    const emit = makeEmitter(bus, e => invalid.push(e));
    const provider = makeReplayProvider({ turns: [turnText('answer', 0.01)], models: FREE });
    const ac = new AbortController();
    let release = null, asks = 0;
    const res = runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'w', runId: 'held', limits: { maxCostUsd: 1, maxIters: 3, grace: false }, signal: ac.signal,
      budget: { check: () => (++asks === 1 ? { hold: new Promise(r => { release = r; }) } : null) },
      capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'w', room: 'office' } });
    for (let i = 0; i < 5; i++) await tick();
    if (abortAfterHold) ac.abort(); else release();
    const out = await res;
    const end = seq.find(e => e.name === 'agent.run.end');
    return { out, end: end && end.payload, asks, costs: seq.filter(e => e.name === 'agent.cost').length, invalid, release };
  }
  {
    const r = await heldRun(false);
    A.eq(r.invalid, [], 'held: every event passed the event contract');
    A.ok(r.asks >= 2, 'held: the loop asked again once the hold ended (asks: ' + r.asks + ')');
    A.ok(r.end && r.end.reason === 'done' && r.costs === 1, 'held: then the call went out and the run finished: ' + JSON.stringify(r.end));
  }
  {
    const r = await heldRun(true);
    A.eq(r.invalid, [], 'held + STOP: every event passed the event contract');
    A.ok(r.end && r.end.reason === 'cancelled' && r.costs === 0, 'held + STOP: the run ends cancelled while still held, and no call went out: ' + JSON.stringify(r.end));
    A.eq(r.asks, 1, 'held + STOP: the pool is never asked again (a cancelled run is never put in flight)');
    r.release();
  }
  // THE LOOP'S PRICE OF A CALL, wired as index.js wires it (the loop told the window the provider REPORTS, the context
  // manager sized to it or to the cold 131072 guess): its prompt at the input price plus the most output it can bill —
  // the output ceiling, or the room a reported window leaves, whichever is lower — at the output price
  async function priceOfFirstCall(models, extra) {
    const provider = Object.assign(makeReplayProvider({ turns: [turnText('answer', 0.01)], models }), (extra && extra.provider) || {});
    const ctxMgr = makeContext({ contextLimit: provider.contextLimit('replay/model') || 131072 });
    const msgs = [{ role: 'user', content: 'go' }];
    let priced = null;
    await runAgentLoop({ messages: msgs, provider, emit: () => {}, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', agentId: 'w', runId: 'price', limits: { maxCostUsd: 1, maxIters: 3, grace: false },
      budget: { check: (spent, nextCallUsd) => { if (priced === null) priced = nextCallUsd(); return null; } },
      context: ctxMgr, approxTokens: ctxMgr.estimateMessages(msgs), contextLimit: provider.contextLimit('replay/model'),
      capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'w', room: 'office' } });
    return { priced, p: Math.max(ctxMgr.estimateMessages(msgs), 1) };
  }
  {
    const { priced, p } = await priceOfFirstCall(PRICED_8K);
    const expect = p * 0.00001 + (8000 - p) * 0.00003;
    A.ok(priced !== null && Math.abs(priced - expect) < 0.001 && priced > 0.23, 'the loop prices a call at its prompt + every output token its 8k window leaves room for: $' + priced + ' (~' + money(expect) + ')');
  }
  {
    // an output ceiling below the window's room bounds the output (the adapter sends it as max_tokens)
    const { priced, p } = await priceOfFirstCall([Object.assign({}, PRICED_8K[0], { max_completion_tokens: 4096 })]);
    const expect = p * 0.00001 + 4096 * 0.00003;
    A.ok(priced !== null && Math.abs(priced - expect) < 0.001, 'a 4,096-token output ceiling on the 8k window: the prompt + 4,096 output tokens: $' + priced + ' (~' + money(expect) + ')');
  }
  {
    // review of 32fc352e4: a window nobody reported is never priced from the context manager's 131072 guess
    const { priced } = await priceOfFirstCall(COLD);
    A.eq(priced, 0, 'no window reported and no output ceiling: no price (counted as a call), never the cold 131072 guess');
    const ceiling = await priceOfFirstCall(COLD_CEILING);
    const expect = ceiling.p * 0.000005 + 128000 * 0.00003;
    A.ok(ceiling.priced !== null && Math.abs(ceiling.priced - expect) < 0.001 && ceiling.priced > 3.84, 'no window reported but a 128k output ceiling: the prompt + 128k output tokens: $' + ceiling.priced + ' (~' + money(expect) + ')');
  }
  {
    // the SONNET row: a 200k window, a 64k output ceiling: ~$0.96 a call, not the window's ~$3
    const { priced, p } = await priceOfFirstCall(SONNET);
    const expect = p * 0.000003 + 64000 * 0.000015;
    A.ok(priced !== null && Math.abs(priced - expect) < 0.001 && priced < 1, 'a 200k window with a 64k output ceiling at $3/$15: $' + priced + ' (~' + money(expect) + '), not ~$3');
  }
  {
    // a FALLBACK to a model whose window is unknown: the price never leans on the window of the model it left
    const prices = { priceOf: () => ({ in: 10, out: 30 }) };
    const primary = { priceOf: prices.priceOf, contextLimit: () => 200000, stream: async function* () { throw new Error('Our servers are currently overloaded. Please try again later.'); yield; } };
    const cold = { priceOf: prices.priceOf, contextLimit: () => 0, stream: async function* () {
      yield { type: 'text', delta: 'served' }; yield { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }; yield { type: 'done', finishReason: 'stop' };
    } };
    const ctxMgr = makeContext({ contextLimit: 200000 });
    const seen = [];
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider: primary, emit: () => {}, cost: makeCostEngine({ priceOf: prices.priceOf }),
      model: 'big', agentId: 'w', runId: 'fb', limits: { maxCostUsd: 1, maxIters: 3, grace: false }, context: ctxMgr, contextLimit: 200000,
      summarize: async () => '', fallbacks: [{ provider: cold, model: 'unknown' }], sleep: async () => {},
      budget: { check: (spent, nextCallUsd) => { seen.push(nextCallUsd()); return null; } },
      capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'w', room: 'office' } });
    A.eq(res.reason, 'done', 'fallback pricing: the cold fallback served the turn');
    A.ok(seen.length >= 2 && seen[0] > 5 && seen[seen.length - 1] === 0, 'fallback pricing: the primary\'s call was priced by its 200k window, the fallback\'s call has no price (its window is unknown; the context manager kept 200k): ' + JSON.stringify(seen));
  }
  {
    const free = makeReplayProvider({ turns: [turnText('answer', 0.01)], models: FREE });
    let freePrice = null;
    await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider: free, emit: () => {}, cost: makeCostEngine({ priceOf: free.priceOf }),
      model: 'replay/model', agentId: 'w', runId: 'free', limits: { maxCostUsd: 1, maxIters: 3, grace: false },
      budget: { check: (spent, nextCallUsd) => { if (freePrice === null) freePrice = nextCallUsd(); return null; } },
      context: makeContext({ contextLimit: 200000 }), capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'w', room: 'office' } });
    A.eq(freePrice, 0, 'a model nothing prices reads $0: no price (the pool counts the call as a call)');
  }
  // A MODEL ITS CATALOG PRICES AT A KNOWN $0 (an OpenRouter :free row) IS PRICED, NOT UNPRICED (lane context-cost-1023).
  // Counted as a call, it held every other member's call under any finite pool cap (a saved PER RUN, a line hop
  // ceiling, a StarNet-managed run's reserve): a free team ran one call at a time with nothing on screen saying why.
  {
    const { priced } = await priceOfFirstCall(KNOWN_FREE);
    A.ok(priced > 0 && priced < 1e-6, 'a known-$0 model reads a token price above $0 (reserved as a call about $0), not "no price": ' + priced);
    const cold = await priceOfFirstCall([Object.assign({}, KNOWN_FREE[0], { context_length: 0, max_completion_tokens: null })]);
    A.ok(cold.priced > 0 && cold.priced < 1e-6, 'a known-$0 model with no window and no output ceiling is still priced about $0: ' + cold.priced);
  }
  for (const tool of ['spawn', 'dispatch']) {
    const f = await family('knownFree' + tool, 0.05, 0, 0, { models: KNOWN_FREE, tool, tasks: 2, workerDelay: () => 6, synthUsd: 0 });
    A.eq(f.invalid, [], 'known $0 ' + tool + ': every event passed the event contract');
    A.eq(f.workers.map(w => w && w.reason), ['done', 'done'], 'known $0 ' + tool + ': both members finished');
    A.eq(f.peak, 2, 'known $0 ' + tool + ': under a $0.05 cap the calls of both members are in flight together, not one at a time');
    A.eq(f.calls, f.modelCalls, 'known $0 ' + tool + ': every call is still counted (' + f.modelCalls + ')');
  }

} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
}

A.report('run-spend-pool.test');
})().catch(e => { console.log('FAIL: run-spend-pool.test threw - ' + (e && e.stack || e)); process.exit(1); });
