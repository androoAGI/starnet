/* sidecar/loopjob.js — the PURE decision half of the LOOP subsystem (standing objectives, S1).

   A LOOP is the fourth "keep going" mechanism in the station, and the only one that advances on a
   VERDICT instead of a clock:

     Routines (cron.js)      WHEN  — wall-clock cadence; an overrun occurrence is dropped, never chained.
     Night Shift (nightshift.js) IDLE — fixed ~45min beats while the Commander is away; it picks its own focus.
     Goal loop (frontend/app/goalloop.js) — judge-gated re-fire, but browser-only, one workstream, dies with the tab.
     LOOP (this file)        UNTIL — the Commander's standing objective, iterated server-side, each iteration
                                     parked for review, the next one triggered by the Commander's verdict.

   This is the schedule-math analog of cron.js: PURE. Every function is a transform over (loop, inputs)
   with `now` INJECTED. There is NO Date.now / Math.random / new Date() / setTimeout / fs here, so it passes
   test/lint-determinism.js and is headless-testable exactly like cron.js / nightshift.js / loop.js.
   The record LIFECYCLE lives in loopjob-store.js; the tick orchestration in loopjob-driver.js; the ambient
   half (real clock, id minting, persistence, the runOnce fire) ONLY in sidecar/index.js.

   NAMING: `loop` in this repo already means runAgentLoop (sidecar/loop.js) and `loops/` at the repo root is
   the QA crew's directive folder. The product noun is LOOP; every module/record here is `loopjob*` / LoopJob
   so neither collides. The user never sees the word "loopjob".

   Surface:
     decide(loop, inp, ctx)        -> { fire, binding, pendingCount, detail }   // THE gate — may an iteration fire now?
     pendingReviews(loop)          -> Iteration[]        // candidates awaiting a verdict, oldest first
     stackedAbove(loop, n)         -> Iteration[]        // un-approved candidates built ON TOP of iteration n
     rollBudgetDay(loop, ctx)      -> loop               // reset the daily spend bucket on a new UTC day
     budgetLeft(loop, ctx)         -> number | null      // remaining daily USD headroom (null = ungoverned)
     nextOutcomeFor(text)          -> 'noop' | 'candidate'  // did the model declare convergence?
     digest(loop, ctx)             -> string             // the LEDGER BLOCK injected into the next iteration
     summarize(loop, ctx)          -> {...}              // a UI-shaped status projection (truthful-telemetry safe)

   THE CONVERGENCE LAW. A 24/7 loop that cannot admit it is finished is a money fire: "find bug fixes"
   re-finds the same bug every pass until the budget dies. Two mechanisms, both here:
     (a) `digest` hands every iteration the compacted history — what was already done, what the Commander
         APPROVED, and above all WHY anything was REJECTED. A loop with no memory is not a loop, it is a
         retry storm.
     (b) `nextOutcomeFor` reads the model's own NOTHING-TO-DO declaration; loopjob-store counts the streak
         and parks the loop DORMANT at dryStopAfter. Dormant is a truthful terminal state that costs $0 —
         never a silent idle, and never a manufactured task invented to look busy. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).loopjob = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- knobs (all overridable per-loop; these are the shipped defaults) -------------------------------
  const QUEUE_CAP_DEFAULT = 3;    // un-reviewed candidates the loop may stack before it parks itself
  const QUEUE_CAP_MIN = 1;        // 1 = strictly blocking (review each one before the next starts)
  const QUEUE_CAP_MAX = 12;
  const DRY_STOP_DEFAULT = 3;     // consecutive NOTHING-TO-DO passes before the loop goes DORMANT
  const DRY_STOP_MAX = 20;
  /* THE STALL BREAKER (2026-09-17). Convergence above trusts the model to CONCEDE. A customer's agent never did:
     98 overnight passes, each one re-confirming that the previous pass's files existed, each one filed as a
     'candidate' ("verified — everything is in place"), each one auto-approved, ~$98 gone and no work done.
     dryStreak never moved because the model never said NOTHING-TO-DO; the queue never filled because gate:'auto'
     approves its own passes. So this counter reads the LEDGER, not the model's mood: a candidate that changed
     no file, landed no commit and filed no findings is a STALLED pass, and a loop that stalls stallStopAfter
     times in a row is parked 'paused' with the reason spelled out. It costs $0 to be parked and one click to
     resume — the Commander decides, after seeing why, whether the loop had a point. */
  const STALL_STOP_DEFAULT = 3;   // consecutive passes that changed nothing before the loop parks itself
  const STALL_STOP_MAX = 20;
  const ECHO_MIN_TOKENS = 6;      // below this a summary is too short to compare by overlap; exact match only
  const ECHO_THRESHOLD = 0.8;     // word-set overlap at/above which two summaries are "the same pass again"

  /* ---- HOW A LOOP KNOWS IT IS FINISHED ---------------------------------------------------------------
     Two accepted signals, because asking a model to CONCEDE ("say NOTHING-TO-DO") is asking for the one
     thing models are worst at — they are trained to be helpful and will invent work rather than admit there
     is none. Asking for a REPORT is something they do reliably:

       DIGEST: 0 findings — nothing new          <- the primary signal (this repo's own loops/README rule 4)
       NOTHING-TO-DO                             <- kept as an explicit override, and for loops that
                                                    never asked for a digest

     A digest carries a COUNT, so zero-findings is a fact we read rather than a mood we infer. Deliberately
     rigid: the count must be a bare number right after the marker, so a sentence like "the digest showed no
     findings" can never be mistaken for a filed report. */
  const NOTHING_MARK = /NOTHING-TO-DO/i;
  const DIGEST_RE = /(?:^|\n)\s*DIGEST\s*:\s*(\d+)\s+finding/i;
  const DIGEST_ANY = /(?:^|\n)\s*DIGEST\s*:/i;

  const GATES = ['halted', 'done', 'disabled', 'stopped', 'dormant', 'paused', 'max-iterations',
    'budget', 'in-flight', 'queue-full', 'concurrency', 'precheck'];

  function iso(ms) { return new Date(ms).toISOString(); }
  function dayOf(ms) { return Math.floor(ms / 86400000); }             // UTC day bucket, same idiom as nightshift.js
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clampInt(v, lo, hi, dflt) {
    const n = parseInt(v, 10);
    if (!isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
  }

  function queueCapOf(loop) { return clampInt(loop && loop.queueCap, QUEUE_CAP_MIN, QUEUE_CAP_MAX, QUEUE_CAP_DEFAULT); }
  function dryStopOf(loop) { return clampInt(loop && loop.dryStopAfter, 1, DRY_STOP_MAX, DRY_STOP_DEFAULT); }
  function stallStopOf(loop) { return clampInt(loop && loop.stallStopAfter, 1, STALL_STOP_MAX, STALL_STOP_DEFAULT); }

  /* similarity — word-set overlap (Jaccard) of two summaries after case/punctuation folding. Pure, bounded, and
     deliberately crude: it exists to catch "Verified that all files exist. Everything is in place." said 98 ways,
     not to grade prose. Two short strings (< ECHO_MIN_TOKENS words) compare by exact folded equality only, because
     overlap on three words is a coin toss. Returns 0..1. */
  function tokens(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter(Boolean);
  }
  function similarity(a, b) {
    const ta = tokens(a), tb = tokens(b);
    if (!ta.length || !tb.length) return 0;
    if (ta.length < ECHO_MIN_TOKENS || tb.length < ECHO_MIN_TOKENS) return ta.join(' ') === tb.join(' ') ? 1 : 0;
    const sa = new Set(ta), sb = new Set(tb);
    let both = 0;
    for (const w of sa) if (sb.has(w)) both++;
    const union = sa.size + sb.size - both;
    return union ? both / union : 0;
  }

  /* stallSignal — did this settled CANDIDATE actually do anything? Reads only what the ledger can prove.

       loop     — the loop record BEFORE this iteration is folded in (its iterations are the history)
       settled  — the iteration row as it will be stored: { outcome, files, commit, digest, summary, title }

     Returns null (a real pass), 'no-change' or 'echo':
       'no-change' — a git-backed loop (workdir set) whose pass touched no file, landed no commit and filed no
                     findings. For a git loop the diff IS the work; a pass with an empty diff and no report is
                     a pass that only looked.
       'echo'      — any loop whose pass touched nothing AND whose summary is the previous candidate's summary
                     again (similarity ≥ ECHO_THRESHOLD). A loop with no workdir legitimately produces text, so
                     text alone is never a stall there — but the SAME text twice is not a second deliverable.
     A filed DIGEST with a positive count is always real work (the model reported findings, and a research loop
     has nothing else to show). A noop/failed/red/cancelled outcome is never a stall — those have their own
     counters — so callers gate on outcome === 'candidate' first. */
  function stallSignal(loop, settled) {
    if (!settled || settled.outcome !== 'candidate') return null;
    const files = Array.isArray(settled.files) ? settled.files.length : 0;
    if (files > 0 || settled.commit) return null;
    const d = settled.digest;
    if (d && d.filed && isNum(d.count) && d.count > 0) return null;
    if (loop && loop.workdir) return 'no-change';
    const prev = ((loop && loop.iterations) || []).slice().reverse()
      .find(it => it && it.outcome === 'candidate' && it.n !== settled.n);
    if (!prev) return null;
    const a = settled.summary || settled.title || '', b = prev.summary || prev.title || '';
    return similarity(a, b) >= ECHO_THRESHOLD ? 'echo' : null;
  }

  /* pendingReviews — the iterations sitting in the review queue: outcome 'candidate' (real work landed)
     with no verdict yet. Oldest first; the queue is FIFO by design because iteration N+1 is built ON TOP
     of N's un-approved work (see stackedAbove). Iterations that produced nothing ('noop') or died
     ('failed') are NOT review items — there is nothing to approve. */
  function pendingReviews(loop) {
    const its = (loop && loop.iterations) || [];
    return its.filter(it => it && it.outcome === 'candidate' && !it.verdict);
  }

  /* stackedAbove — every un-approved candidate with a HIGHER iteration number than n. This is the honest
     cost of a stacking review queue: iteration 5 was built on a tree that contains un-approved 3 and 4, so
     rejecting 3 invalidates 4 and 5 too. The UI MUST show this count before the Commander clicks REJECT —
     a review gate that silently discards work the user could still see is a truthful-telemetry violation. */
  function stackedAbove(loop, n) {
    const num = parseInt(n, 10);
    if (!isFinite(num)) return [];
    return pendingReviews(loop).filter(it => it.n > num);
  }

  /* rollBudgetDay — reset the loop's daily spend bucket when the UTC day advances. Returns the SAME object
     when nothing changed so callers can cheaply skip a persist. Mirrors nightshift.rollDay. */
  function rollBudgetDay(loop, ctx) {
    const now = (ctx && ctx.now) || 0;
    const b = loop && loop.budget;
    if (!b) return loop;
    const day = dayOf(now);
    if (b.day === day) return loop;
    return Object.assign({}, loop, { budget: Object.assign({}, b, { day: day, spentTodayUsd: 0 }) });
  }

  /* budgetLeft — remaining USD headroom for TODAY. null means ungoverned (no cap), matching the station's
     budgetcaps.js convention where 0/absent = "no cap" rather than "block everything". Never negative. */
  function budgetLeft(loop, ctx) {
    const now = (ctx && ctx.now) || 0;
    const rolled = rollBudgetDay(loop, { now: now });
    const b = rolled && rolled.budget;
    if (!b || !isNum(b.perDayUsd) || b.perDayUsd <= 0) return null;
    return Math.max(0, b.perDayUsd - (isNum(b.spentTodayUsd) ? b.spentTodayUsd : 0));
  }

  /* decide — THE gate. May this loop fire its next iteration right now?

     Returns { fire, binding, pendingCount, detail }. `binding` names the FIRST blocking reason (see GATES
     for the priority order) so the UI can state exactly why a loop is quiet — "queue-full: 3 waiting on you"
     reads very differently from "budget: $5.00/day spent". A loop that is quiet for an unnameable reason is
     a bug, so binding is never null when fire is false.

     Ambient facts arrive on `inp`, never read here:
       inp.halted        bool   — the durable station E-STOP (POST /api/halt), same flag night shift honors
       inp.agentBusy     bool   — the agent's run mutex is occupied by someone else
       inp.precheck      { ok, reason } | bool | undefined
                                — a PURELY-LOCAL readiness gate (credential present, agent exists, workdir
                                  still blessed). Copied from nightshift-driver's NS-2 cold-leash fix: a
                                  stand-down no model call could have avoided must not cost money or a slot.
       inp.inFlight      bool   — the driver's in-memory lease says an iteration of THIS loop is running

     NOTE the queue-full gate applies to gate:'review' only. A gate:'auto' loop applies its own work, so it
     never accumulates a review queue and never parks on one. */
  function decide(loop, inp, ctx) {
    inp = inp || {}; ctx = ctx || {};
    const now = ctx.now || 0;
    const pend = pendingReviews(loop);
    const out = (binding, detail) => ({ fire: !binding, binding: binding || null, pendingCount: pend.length, detail: detail || null });

    if (!loop) return out('disabled', 'no such loop');
    if (inp.halted) return out('halted', 'station E-STOP engaged');
    // the SPECIFIC quiet states are checked before the generic `enabled` flag, because stop/dormant/pause all
    // clear `enabled` and "disabled" would tell the Commander nothing about WHY. A loop that converged reads
    // very differently from one the Commander stopped, and the UI must be able to say which.
    if (loop.state === 'done') return out('done', loop.stopReason || 'objective met');
    if (loop.state === 'stopped') return out('stopped', loop.stopReason || null);
    if (loop.state === 'dormant') return out('dormant', loop.stopReason || 'nothing left to do');
    if (loop.state === 'paused') return out('paused', loop.stopReason || null);
    if (loop.enabled === false) return out('disabled', null);

    const maxIters = isNum(loop.maxIterations) ? loop.maxIterations : (loop.maxIterations == null ? null : parseInt(loop.maxIterations, 10));
    if (maxIters != null && isFinite(maxIters) && maxIters > 0 && (loop.iterationCount || 0) >= maxIters) {
      return out('max-iterations', (loop.iterationCount || 0) + '/' + maxIters + ' done');
    }

    const left = budgetLeft(loop, { now: now });
    if (left != null && left <= 0) return out('budget', 'daily cap $' + loop.budget.perDayUsd + ' reached');

    // in-flight: the driver's live lease OR a durable fire-claim whose heartbeat is still fresh. The durable
    // half is what survives a restart — without it a crash mid-iteration would double-fire on boot.
    if (inp.inFlight) return out('in-flight', 'iteration ' + ((loop.iterationCount || 0) + 1) + ' running');
    if (loop.fireClaim != null) {
      const staleMs = isNum(ctx.staleMs) ? ctx.staleMs : 900000;   // 15min default; driver injects maxRunMs
      const beat = isNum(loop.heartbeatAt) ? loop.heartbeatAt : loop.fireClaim;
      if (now - beat < staleMs) return out('in-flight', 'claim held');
      // a stale claim is a ZOMBIE (the holder died); fall through so the loop re-arms rather than wedging.
    }

    if (loop.gate !== 'auto' && pend.length >= queueCapOf(loop)) {
      return out('queue-full', pend.length + ' waiting on your review');
    }

    if (inp.agentBusy) return out('concurrency', 'agent busy');

    const pre = inp.precheck;
    if (pre === false) return out('precheck', null);
    if (pre && typeof pre === 'object' && pre.ok === false) {
      const held = out('precheck', pre.reason || null);
      // a hold that names its facts (W3.1: the window reading, its source and its reset) carries them to the stand-down's row
      if (pre.why && typeof pre.why === 'object' && !Array.isArray(pre.why)) held.why = pre.why;
      return held;
    }

    return out(null, null);
  }

  /* readDigest — parse the iteration's filed report. Returns { filed, count } where `filed` means the model
     actually emitted a DIGEST line in the required shape. A malformed DIGEST (marker present, no count) is
     `filed:false` — a report we cannot read is not a report, and treating it as zero would let a sloppy pass
     silently push the loop toward dormancy. */
  function readDigest(text) {
    const s = String(text == null ? '' : text);
    const m = s.match(DIGEST_RE);
    if (m) return { filed: true, count: parseInt(m[1], 10) };
    return { filed: false, count: null, malformed: DIGEST_ANY.test(s) };
  }

  /* nextOutcomeFor — classify an iteration's final text.

     'noop' (a pass that found nothing, feeding the convergence counter) requires an EXPLICIT signal: either a
     filed digest reporting zero findings, or the NOTHING-TO-DO override. Convergence is never inferred from a
     short reply or an empty diff, because "the agent said little" and "there is nothing left to do" are
     different facts and only one of them is provable from the transcript. */
  function nextOutcomeFor(text) {
    const s = String(text == null ? '' : text);
    if (NOTHING_MARK.test(s)) return 'noop';
    const d = readDigest(s);
    if (d.filed && d.count === 0) return 'noop';
    return 'candidate';
  }

  /* digest — the LEDGER BLOCK handed to the next iteration. This is the single highest-leverage function in
     the subsystem: without it a "sweep for bugs" loop re-finds bug #1 every pass forever.

     Ordering is deliberate — REJECTIONS FIRST, because a rejection is the Commander teaching the loop a
     boundary and it must not be buried under history. Everything here is drawn from the durable iteration
     ledger; nothing is inferred, so every line is provable. */
  function digest(loop, ctx) {
    ctx = ctx || {};
    const maxItems = clampInt(ctx.maxItems, 1, 60, 12);
    const allIts = ((loop && loop.iterations) || []).filter(Boolean);
    const interrupted = allIts.filter(it => it.outcome === 'cancelled').slice(-maxItems);
    const its = allIts.filter(it => it.outcome !== 'cancelled');
    if (!its.length && !interrupted.length) return '';

    const lines = [];
    const rejected = its.filter(it => it.verdict === 'rejected' && it.verdictNote).slice(-maxItems);
    const approved = its.filter(it => it.verdict === 'approved').slice(-maxItems);
    const pend = pendingReviews(loop).slice(-maxItems);
    const noops = its.filter(it => it.outcome === 'noop').length;

    lines.push('<loop_ledger iteration="' + ((loop.iterationCount || 0) + 1) + '">');
    lines.push('You are continuing a standing loop, not starting fresh. History below is FACT — do not repeat it.');

    /* A cancelled pass is not completed work, but filtering it out entirely loses the one fact the replacement
       pass needs most: a tool may have committed an effect immediately before cancellation/restart. The journal
       keeps the detailed provider-valid checkpoint for human recovery; this bounded loop-level fence prevents
       a fresh model turn from blindly repeating an action whose outcome it cannot prove. */
    if (interrupted.length) {
      lines.push('', 'INTERRUPTED PASSES — completion and side effects are not proven:');
      for (const it of interrupted) lines.push('  #' + it.n + ' was cancelled before completion. Inspect and verify current state before repeating any action from that pass.');
    }

    if (rejected.length) {
      lines.push('', 'THE COMMANDER REJECTED THESE — these are boundaries, respect them:');
      for (const it of rejected) lines.push('  #' + it.n + ' ' + (it.title || 'untitled') + ' — REASON: ' + it.verdictNote);
    }
    if (approved.length) {
      lines.push('', 'ALREADY DONE AND APPROVED (do not redo):');
      for (const it of approved) lines.push('  #' + it.n + ' ' + (it.title || 'untitled'));
    }
    if (pend.length) {
      lines.push('', 'AWAITING REVIEW — your work builds ON TOP of these, so treat them as already applied:');
      for (const it of pend) lines.push('  #' + it.n + ' ' + (it.title || 'untitled'));
    }
    if (noops) lines.push('', 'Passes that found nothing to do so far: ' + noops);

    /* THE STALL NUDGE. If the last pass claimed work but the ledger shows none, say so before the model spends
       another dollar re-reading the same files. Stated as fact (no file changed, nothing committed) — and paired
       with the honest exit so "do the work" and "admit there is none" are both on the table. Re-verifying is
       named explicitly because that is the exact loop a customer's agent fell into for 98 passes. */
    const lastStall = its.slice().reverse().find(it => it.stall);
    const stallStreak = (loop.stallStreak || 0);
    if (stallStreak > 0 && lastStall) {
      lines.push('', 'YOUR LAST ' + (stallStreak === 1 ? 'PASS' : stallStreak + ' PASSES') + ' CHANGED NOTHING (iteration #' + lastStall.n + '): ' +
        (lastStall.stall === 'echo' ? 'the report repeated the pass before it;' : 'it reported work, but') +
        ' no file changed and nothing was committed.');
      lines.push('Checking that files exist is not work. Either make a real change this pass, or if the objective');
      lines.push('is genuinely met, say so with the exit below. After ' + stallStopOf(loop) + ' such passes in a row this loop parks itself.');
    }

    /* THE FEEDBACK LOOP. If the last iteration's work failed the project's own check, that failure output is
       the single most useful thing the next iteration can be told — it is the difference between "try again"
       (a retry storm) and "here is exactly what you broke" (progress). It leads the actionable section because
       a red check outranks every other consideration: nothing else matters until it is green. */
    const lastRed = its.slice().reverse().find(it => it.outcome === 'red' && it.check);
    if (lastRed) {
      const red = lastRed.check;
      lines.push('', 'YOUR LAST CHANGE FAILED THE PROJECT\'S OWN CHECK (iteration #' + lastRed.n + '):');
      lines.push('  ' + (red.summary || 'the check failed'));
      lines.push('Fix THAT before anything else. The check is run by the station, not by you — you cannot see');
      lines.push('or change the command, and editing the tests, their config, or the scripts that define them');
      lines.push('does NOT count as passing: it is detected, it stops the loop, and it wastes the Commander\'s time.');
    }
    // a tampering flag is stated back plainly — a model that drifted there once must be told it was caught.
    const tampered = its.slice().reverse().find(it => it.check && it.check.tampered);
    if (tampered) {
      lines.push('', 'NOTE: iteration #' + tampered.n + ' modified the check itself (' +
        (tampered.check.tamperedPaths || []).slice(0, 3).join(', ') + '). That was flagged for human review.');
      lines.push('Do not modify tests, test config, or build/script definitions to make the check pass.');
    }

    /* THE CLOSING INSTRUCTION MUST MATCH WHAT THIS LOOP ACTUALLY MEASURES. Emitting a blanket
       "say NOTHING-TO-DO" here while the template asked for a DIGEST line gave the model two contradictory
       protocols and left soft loops unable to converge at all. So the ask is derived from `exitOn`. */
    const exitOn = loop.exitOn || 'never';
    if (exitOn === 'check-green') {
      // the machine decides this one — asking the model to self-declare completion would invite it to claim
      // a finish the check has not granted.
      lines.push('', 'You do not declare this task finished — the check does. Keep making real progress toward');
      lines.push('a genuinely passing check; the station runs it after every pass and tells you the result.');
    } else if (exitOn === 'empty-digests') {
      lines.push('', 'End this pass with one line in exactly this form:');
      lines.push('  DIGEST: <n> findings — <one sentence on what you did, or "nothing new">');
      lines.push('File it even when n is 0. An honest "DIGEST: 0 findings" is how this loop learns it is');
      lines.push('finished — it is a correct and valued answer. Never invent work to avoid reporting zero.');
      // a loop that expects reports and is not getting them can never converge; say so to the model directly.
      const last = its[its.length - 1];
      const lastFiled = !last || !last.digest || last.digest.filed !== false;
      if (!lastFiled && its.length) lines.push('NOTE: your previous pass did not include a readable DIGEST line. Without it this loop cannot finish.');
    } else {
      lines.push('', 'If there is genuinely nothing meaningful left to do for this objective, reply with the exact');
      lines.push('token NOTHING-TO-DO and stop. Do NOT invent busywork to appear productive — an honest');
      lines.push('NOTHING-TO-DO is the correct and valued answer, and the loop will park itself.');
    }
    lines.push('</loop_ledger>');
    return lines.join('\n');
  }

  /* summarize — the projection the LOOPS window and /api/loops render from. Every field maps to a durable
     record field or a pure derivation of one; nothing here may assert a state the store cannot prove. */
  function summarize(loop, ctx) {
    ctx = ctx || {};
    const now = ctx.now || 0;
    const d = decide(loop, ctx.inp || {}, { now: now, staleMs: ctx.staleMs });
    const pend = pendingReviews(loop);
    const its = (loop && loop.iterations) || [];
    return {
      id: loop.id,
      name: loop.name,
      objective: loop.objective,
      agentId: loop.agentId,
      gate: loop.gate,
      state: loop.state,
      stopReason: loop.stopReason || null,
      enabled: loop.enabled !== false,
      iterationCount: loop.iterationCount || 0,
      maxIterations: loop.maxIterations != null ? loop.maxIterations : null,
      queueCap: queueCapOf(loop),
      pendingCount: pend.length,
      // `diff` rides ONLY on pending rows — it exists to be read before a verdict, and the store drops it after.
      pending: pend.map(it => ({
        n: it.n, title: it.title, summary: it.summary, commit: it.commit, files: it.files,
        endedAt: it.endedAt, usd: it.usd, diff: it.diff || null
      })),
      approvedCount: its.filter(it => it.verdict === 'approved').length,
      rejectedCount: its.filter(it => it.verdict === 'rejected').length,
      noopCount: its.filter(it => it.outcome === 'noop').length,
      dryStreak: loop.dryStreak || 0,
      failStreak: loop.failStreak || 0,
      // THE STALL BREAKER's counter + ceiling: passes in a row that claimed work the ledger cannot see.
      stallStreak: loop.stallStreak || 0,
      stallStopAfter: stallStopOf(loop),
      // REPORTING COMPLIANCE. A loop whose exit condition is "N empty digests" cannot ever finish if the model
      // stops filing them. The panel must be able to say that out loud rather than showing a loop that looks
      // healthy and will in fact run until the budget stops it.
      noDigestStreak: loop.noDigestStreak || 0,
      expectsDigest: (loop.exitOn || 'never') === 'empty-digests',
      dryStopAfter: dryStopOf(loop),
      // the last few iterations regardless of outcome. Without this the panel can show a loop that has run 12
      // times with nothing to review and no way to say WHY — a failing loop would look identical to an idle
      // one. `error` is the real settled error string, never a generic "something went wrong".
      recent: its.slice(-5).map(it => ({
        n: it.n, outcome: it.outcome, title: it.title, error: it.error,
        // verdictNote is the Commander's own reason. It rides the projection so the panel can show WHY
        // something was rejected — otherwise the history reads as unexplained deletions.
        verdict: it.verdict, verdictNote: it.verdictNote || null,
        // the commit this iteration landed (S3). It rides the DECIDED rows too, not just the pending ones:
        // once a pass is approved it leaves `pending`, and without this its work would become invisible —
        // the Commander could no longer see where the code they approved actually went.
        commit: it.commit || null,
        // 'no-change' | 'echo' when this candidate changed nothing (stallSignal) — the panel labels it honestly.
        stall: it.stall || null,
        endedAt: it.endedAt, usd: it.usd, check: it.check || null
      })),
      // the check surface the panel renders its stepper from. `checkCmd` is shown so the Commander can see
      // exactly what is being run at their project root — it is their command, and it must never be a mystery.
      checkCmd: loop.checkCmd || null,
      exitOn: loop.exitOn || 'never',
      redStreak: loop.redStreak || 0,
      redStopAfter: loop.redStopAfter || 10,
      lastCheck: (() => { const c = its.slice().reverse().find(it => it.check); return c ? Object.assign({ n: c.n }, c.check) : null; })(),
      lastError: (() => { const f = its.slice().reverse().find(it => it.outcome === 'failed'); return f ? f.error : null; })(),
      budget: loop.budget ? {
        perDayUsd: loop.budget.perDayUsd || 0,
        perIterationUsd: loop.budget.perIterationUsd || 0,
        spentTodayUsd: (rollBudgetDay(loop, { now: now }).budget || {}).spentTodayUsd || 0,
        leftTodayUsd: budgetLeft(loop, { now: now })
      } : null,
      workdir: loop.workdir || null,
      branch: loop.branch || null,
      // PROVENANCE. `meta.templateId` is what lets the panel name the shape ("◈ Research Loop") and draw that
      // shape's own cycle in the stepper instead of a generic WORK/CHECK/REVIEW. Omitting it made every
      // template-born loop render as "custom" — the record knew, the projection just never said.
      meta: loop.meta || null,
      lastRunAt: loop.lastRunAt || null,
      lastRunId: loop.lastRunId || null,
      createdAt: loop.createdAt,
      // the honest "why is nothing happening" line — never a spinner over an unknown state.
      binding: d.binding,
      bindingDetail: d.detail,
      wouldFire: d.fire
    };
  }

  return {
    decide: decide,
    pendingReviews: pendingReviews,
    stackedAbove: stackedAbove,
    rollBudgetDay: rollBudgetDay,
    budgetLeft: budgetLeft,
    nextOutcomeFor: nextOutcomeFor,
    readDigest: readDigest,
    digest: digest,
    summarize: summarize,
    queueCapOf: queueCapOf,
    dryStopOf: dryStopOf,
    stallStopOf: stallStopOf,
    stallSignal: stallSignal,
    similarity: similarity,
    GATES: GATES,
    STALL_STOP_DEFAULT: STALL_STOP_DEFAULT,
    ECHO_THRESHOLD: ECHO_THRESHOLD,
    QUEUE_CAP_DEFAULT: QUEUE_CAP_DEFAULT,
    QUEUE_CAP_MIN: QUEUE_CAP_MIN,
    QUEUE_CAP_MAX: QUEUE_CAP_MAX,
    DRY_STOP_DEFAULT: DRY_STOP_DEFAULT,
    _internals: { iso: iso, dayOf: dayOf, clampInt: clampInt, NOTHING_MARK: NOTHING_MARK, DIGEST_RE: DIGEST_RE }
  };
});
