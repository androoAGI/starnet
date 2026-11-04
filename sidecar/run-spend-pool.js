/* sidecar/run-spend-pool.js — ONE PER RUN CAP FOR A RUN AND EVERY WORKER IT STARTS (bug d3a76db3).

   SETTINGS › SPENDING LIMITS promises PER RUN is a "Hard ceiling for a single agent run". A run that delegates
   (team.spawn / team.dispatch / team.resume, foreground or background) used to start each worker with its OWN
   full PER RUN ceiling, and nothing charged worker spend against the run that started it: a $0.05 cap ran $0.24.
   The run host now gives every run a pool; a worker run JOINS the pool of the run that started it (handed over by
   orchestration.js from the host-minted tool ctx, never from tool arguments), so the lead and its whole crew draw
   from one cap and are stopped by it.

   The loop's own per-run check (loop.js: spent >= maxCostUsd, before every paid call) is the per-run guarantee for
   ONE run: it stops at the first call boundary after the cap, so it passes the cap by less than the call it sent
   last. A run AND its workers call in PARALLEL, so the pool keeps that same guarantee for the whole family by
   RESERVING every call in flight and settling it on what it really booked (review of a1234b154: counting a call in
   flight at what the calls booked SO FAR cost let a heavier call that came later pass the cap by more than a call):
     • spent — what every member has booked (its loop's own tally at each check, plus each reconciled cost the
       member books in between);
     • RESERVED — each call in flight at the most it can cost, as its loop priced it before sending (admit's third
       argument, loop.js nextCallUsd: the prompt at the model's catalog input price plus the most output the call can
       bill — the model's output ceiling, or every token a REPORTED window leaves room for, whichever is lower — at
       its catalog output price), never less than the costliest call any member has booked so far;
     • a call that has no such price (a model nothing prices, or one with neither a reported window nor an output
       ceiling: its price reads $0) is counted as a CALL, never as $0: while one is in flight no other member's call
       goes out. Calls that all book $0 can never take the pool around its cap.
   A member's call goes out while the family's booked spend is under the cap, and either nothing else is in flight
   or the reservations of the calls in flight leave room under the cap (a call is never counted against itself —
   the single-run bound). Otherwise the call is HELD: admit returns { hold }, the member is not in flight, and its
   loop waits until a call in flight settles, then asks again. A STOP is only ever a cap the family really reached
   (booked spend >= cap), never a guess about calls still in flight.

   THE BOUND: when each reservation covers its call, the family passes the cap by less than the cost of the call
   admitted last. That call went out while booked + the reservations of the calls in flight with it < cap, and no
   call went out while it was in flight (a later one would be the last), so the final spend < cap + its own cost.
   A call with no price goes out only beside priced calls that leave room, and nothing goes out while it is in flight.
   What a reservation cannot cover: a provider billing a call above the catalog's token prices (counted once it
   books: no later reservation is less than it), a prompt-cache write premium and a prompt the provider counts above
   the loop's ruler (loop.js nextCallUsd), and spend booked outside a model call (a tool's own paid pass), which is
   counted when it is booked. Compaction attempts reserve their own request before each summary call.
   The price of the bound is TIME: near the cap, with a model whose calls
   it must reserve high, or with a model it cannot price, workers take turns instead of calling at once. That wait is
   not work: team.spawn's timeout, a team.dispatch worker's slice and the liveness sweep's stall clock of every worker
   the subagent manager runs pause while a call is held (watchHolds below, orchestration.js poolHoldClock and
   watchedPool, subagents.js holdStall), so a family is never timed out, nor stopped as stalled, by its holds alone.

   A pool with one member decides nothing (admit always proceeds): a run that never delegates is governed by its
   loop's own check exactly as before. An ungoverned cap (0 / Infinity / missing) never blocks.

   PURE: no clock, no IO, no emit. The host feeds it from the run's budget check, its agent.cost / agent.tool_call
   events and its run-end settle (sidecar/index.js). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).runSpendPool = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const usd = v => (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0;

  function makeRunSpendPool(opts) {
    const o = opts || {};
    const cap = (typeof o.capUsd === 'number' && isFinite(o.capUsd) && o.capUsd > 0) ? o.capUsd : Infinity;
    // runId -> { spent, inFlight, callFrom, boundUsd, calls }. boundUsd = the most the call in flight can cost, as its
    // loop priced it before sending (0 = it has no price: it is counted as a call). calls = every call the member sent.
    const members = new Map();
    let largest = 0;   // the costliest call any member has booked: no reservation is ever less
    let calls = 0;     // every call the family sent, whatever it booked ($0 calls count: calls, not only dollars)

    function member(runId) {
      const k = String(runId == null ? '' : runId);
      let m = members.get(k);
      if (!m) { m = { spent: 0, inFlight: false, callFrom: 0, boundUsd: 0, calls: 0 }; members.set(k, m); }
      return m;
    }
    /* the member's call in flight is over. sent = the call is known to have gone out: it booked a cost (agent.cost —
       the loop books every call it makes, $0 included) or answered with a tool call. A new boundary, a run end or a
       withdrawal also ends it, but proves nothing went out (the loop checks once per turn AND once per attempt, and a
       failed attempt bills nothing), so only a booking or a tool call is counted, and only it is evidence of a cost. */
    function closeCall(m, sent) {
      if (!m.inFlight) return;
      m.inFlight = false;
      if (sent) {
        m.calls++; calls++;
        const c = m.spent - m.callFrom;   // the model call + what the member booked before its call was over
        if (c > largest) largest = c;
      }
      settled();
    }
    function spent() { let t = 0; for (const m of members.values()) t += m.spent; return t; }

    // a HOLD waits for the next call in flight to settle (booked, idle, withdrawn or run end): it frees its reservation
    let wake = null;
    function settled() { if (wake) { const w = wake; wake = null; w.resolve(); } }
    function nextSettle() {
      if (!wake) { let resolve; const p = new Promise(r => { resolve = r; }); wake = { p, resolve }; }
      return wake.p;
    }

    // a run takes part in this pool (idempotent)
    function join(runId) { member(runId); return api; }

    /* The run's budget check, before each paid call: spentUsd is the member's own running tally (authoritative for
       itself); callUsd is the most the call it is about to send can cost, as its loop prices it before sending (a
       number, or a function the pool calls only when it decides — a family of two or more under a real cap; missing
       or $0 = no price: the call is counted as a call). Returns null to proceed (the call is now IN FLIGHT, reserved
       at that price), a stop — the shape loop.js stopForSpend already turns into end('budget', { budgetScope,
       budgetCapUsd }) — or a hold:
         { scope:'run', usd, cap }   the family's booked spend reached the cap;
         { hold: Promise }           the calls in flight leave no room for this one: the member is NOT in flight, and
           asks again once the promise resolves (the next call in flight settled). Every hold waits on a call that IS
           in flight, so it always ends. */
    function admit(runId, spentUsd, callUsd) {
      const k = String(runId == null ? '' : runId);
      const m = member(k);
      if (usd(spentUsd) > m.spent) m.spent = usd(spentUsd);
      closeCall(m, false);   // reaching a new boundary means the previous call has settled
      const open = (bound) => { m.inFlight = true; m.callFrom = m.spent; m.boundUsd = bound; return null; };
      if (cap === Infinity || members.size < 2) return open(0);   // a lone run is never decided here: no price asked
      const total = spent();
      if (total >= cap) return { scope: 'run', usd: total, cap };
      let others = 0, unpriced = 0, reserved = 0;
      for (const [id, w] of members) {
        if (id === k || !w.inFlight) continue;
        others++;
        if (w.boundUsd > 0) reserved += Math.max(w.boundUsd, largest); else unpriced++;
      }
      if (others > 0 && (unpriced > 0 || total + reserved >= cap)) return { hold: nextSettle() };
      return open(usd(typeof callUsd === 'function' ? callUsd() : callUsd));
    }
    // a reconciled cost the member booked (its model call, a tool's own paid pass): counted now, and it settles the call
    function booked(runId, amount) {
      const m = member(runId);
      m.spent += usd(amount);
      closeCall(m, true);
    }
    // the member's call ended without a booked cost (it moved on to tools)
    function idle(runId) { closeCall(member(runId), true); }
    // the member's call never went out: another guard (a day/global pool) refused it after the pool admitted it
    function withdraw(runId) { closeCall(member(runId), false); }
    // the member's run ended: its final spend (never lowers what it already booked)
    function settle(runId, finalUsd) {
      const m = member(runId);
      if (usd(finalUsd) > m.spent) m.spent = usd(finalUsd);
      closeCall(m, false);
    }
    /* IMAGES WHOSE COST NOBODY KNOWS (#164): they book $0, so no dollar figure here ever moves for them. The family counts them
       instead. running: generations started and not over. unknown: those that came back with no price. A generation that
       failed or was cancelled, or that came back priced, leaves no count. spend.js makeMediaSpendCheck holds the rule. */
    let mediaRunning = 0, mediaUnknown = 0, mediaWake = null;
    function mediaCount() { return { running: mediaRunning, unknown: mediaUnknown }; }
    function mediaBegin() { mediaRunning++; }
    function mediaEnd(unknownCharges) {
      mediaRunning = Math.max(0, mediaRunning - 1);
      mediaUnknown += Math.max(0, Math.floor(Number(unknownCharges) || 0));
      if (mediaWake) { const w = mediaWake; mediaWake = null; w.resolve(); }
    }
    function nextMediaEnd() {
      if (!mediaWake) { let resolve; const p = new Promise(r => { resolve = r; }); mediaWake = { p, resolve }; }
      return mediaWake.p;
    }
    function status() {
      let inFlight = 0, reservedUsd = 0, unpricedInFlight = 0;
      for (const m of members.values()) {
        if (!m.inFlight) continue;
        inFlight++;
        if (m.boundUsd > 0) reservedUsd += Math.max(m.boundUsd, largest); else unpricedInFlight++;
      }
      return { capUsd: cap, spentUsd: spent(), members: members.size, inFlight, reservedUsd, unpricedInFlight, calls, largestCallUsd: largest };
    }

    const api = { join, admit, booked, idle, withdraw, settle, status, mediaCount, mediaBegin, mediaEnd, nextMediaEnd, capUsd: cap };
    return api;
  }

  // a pool the HOST minted (orchestration hands it to runOnce); anything else — a JSON body field — is not one
  function isRunSpendPool(p) {
    return !!(p && typeof p === 'object' && typeof p.admit === 'function' && typeof p.join === 'function'
      && typeof p.booked === 'function' && typeof p.idle === 'function' && typeof p.withdraw === 'function'
      && typeof p.settle === 'function');
  }

  /* A HELD CALL IS NOT WORK (review of 32fc352e4). The pool trades TIME for its bound, and a wait for room must not run
     down the clocks that bound a worker's work (team.spawn's tool timeout, a team.dispatch worker's slice), or a family
     that finishes in parallel on its own time is timed out by the holds alone. watchHolds hands ONE member's run a view
     of the pool that calls hooks.hold() when the pool holds that member's call and hooks.release() once the hold is
     over — the call in flight it waited on settled, the member reached its next boundary, or its run settled; end()
     releases a hold still open when the caller is done with the member. Everything else is the pool itself. */
  function watchHolds(pool, hooks) {
    if (!isRunSpendPool(pool) || !hooks) return pool;
    let held = false;
    const end = () => {
      if (!held) return;
      held = false;
      if (typeof hooks.release === 'function') hooks.release();
    };
    return Object.assign({}, pool, {
      admit(runId, spentUsd, callUsd) {
        end();
        const r = pool.admit(runId, spentUsd, callUsd);
        if (r && r.hold) {
          held = true;
          if (typeof hooks.hold === 'function') hooks.hold();
          Promise.resolve(r.hold).then(end, end);
        }
        return r;
      },
      settle(runId, finalUsd) { end(); return pool.settle(runId, finalUsd); },
      end
    });
  }

  return { makeRunSpendPool, isRunSpendPool, watchHolds };
});
