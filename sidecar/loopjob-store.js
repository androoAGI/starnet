/* sidecar/loopjob-store.js — the PURE lifecycle reducer for the LOOP store (standing objectives, S1).

   Second half of the determinism split (see loopjob.js header): loopjob.js owns the GATE math, this file
   owns the record LIFECYCLE. Both are pure — every function is a transform over (loops, args) with
   `now` / `id` / `runId` INJECTED, never read from the wall clock or rng. No Date.now / Math.random /
   new Date() / setTimeout / fs, so it passes test/lint-determinism.js exactly like cron-store.js.

   The ambient half — JSON load/persist (atomic temp+rename via the durable-store idiom), id minting
   (crypto.randomUUID), the real now-source, the runOnce fire, git — lives ONLY in sidecar/index.js and
   loopjob-driver.js.

   Surface (every op returns a NEW loops array; the input is never mutated):
     makeLoop(spec, { id, now })                     -> LoopJob
     createLoop(loops, spec, { id, now })            -> loops'
     updateLoop(loops, id, patch, { now })           -> loops'
     pauseLoop(loops, id, reason, { now })           -> loops'
     resumeLoop(loops, id, { now })                  -> loops'      // also lifts dormant/stopped
     stopLoop(loops, id, reason, { now })            -> loops'
     removeLoop(loops, id)                           -> loops'
     getLoop(loops, id)                              -> LoopJob | null
     claimFire(loops, id, { now })                   -> loops'      // advance-before-run analog
     renewHeartbeat(loops, id, { now })              -> loops'
     startIteration(loops, id, { runId, now })       -> loops'      // append a running iteration
     settleIteration(loops, id, result, { now })     -> loops'      // record the outcome, advance state
     recordVerdict(loops, id, n, verdict, ctx)       -> loops'      // approve / reject (+ cascade)
     loadEnvelope(raw)                               -> { version, loops }
     toEnvelope(loops)                               -> { version, loops }
     isValidId(id)                                   -> boolean

   A LoopJob:
     { id, name, objective, agentId, model, provider,
       gate:'review'|'auto',                 // review = stack candidates for approval; auto = apply its own work
       queueCap, maxIterations, dryStopAfter,
       workdir, branch,                      // git loop: the blessed root + the loop's own branch (null = no-git)
       checkCmd, checkTimeoutMs, checkPaths,  // S2: the HUMAN-authored, host-run check (never model-editable)
       exitOn:'check-green'|'empty-digests'|'never',   // what ENDS this loop
       redStopAfter, redStreak,              // ceiling on consecutive red checks
       enabled, state:'idle'|'running'|'waiting'|'paused'|'dormant'|'stopped'|'done',
       stopReason,                           // ALWAYS set when quiet for a non-obvious reason (truthful telemetry)
       iterationCount, dryStreak, failStreak,
       iterations: Iteration[],              // the durable ledger — the whole point of the subsystem
       budget: { perDayUsd, perIterationUsd, spentTodayUsd, day },
       createdAt, updatedAt, lastRunAt, lastRunId,
       fireClaim, heartbeatAt,               // in-flight liveness (cron-store G4.5 / NS-0 idiom)
       meta }

   An Iteration:
     { n, runId, startedAt, endedAt,
       outcome:'running'|'candidate'|'noop'|'red'|'failed'|'unfinished'|'cancelled',   (unfinished: unfinishedAs = the run's outcome, review r8)
       title, summary, commit, files:[{path,bytes}], usd, error,
       check: { passed, summary, note, tampered, tamperedPaths, trusted, gitProven } | null,
       verdict:'approved'|'rejected'|'discarded'|null, verdictNote, verdictAt }

   THE CHECK CHANGES THE STATE MACHINE (S2). A red check is NOT an error and NOT a review item: the run
   succeeded, the work simply is not ready, so the iteration lands 'red' and its failure output is fed into the
   next iteration's prompt (loopjob.digest). Only a check the loop can PROVE was not rewritten counts as green
   — see loopjob-check.js. Two consequences worth stating plainly:
     · exitOn:'check-green' completes the loop ('done') on a TRUSTED green only. An unprovable or tampered
       green stops for review and must never declare the objective met.
     · gate:'auto' ("full access to merge") does NOT auto-approve an iteration whose check mustReview. Full
       access is a convenience for honest work, never an override on evidence of tampering.

   THE STACKING LAW. In gate:'review' the loop keeps working while candidates queue up, so iteration N+1 is
   built on a tree containing un-approved N. That makes the queue strictly FIFO and makes rejection
   CASCADE: rejecting #3 marks #4 and #5 'discarded' because they were built on top of it. recordVerdict
   does this in one atomic reduction and returns the cascade in the record, so the UI can (and must) warn
   before the click. The alternative — pretending #4 survives a rejected #3 — would have the app assert a
   tree state git cannot produce, which is exactly the lie this product forbids. */
'use strict';
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('./loopjob.js') : (root.SK && root.SK.loopjob));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).loopjobStore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (LJ) {
  'use strict';

  const ENVELOPE_VERSION = 1;
  const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;      // one safe path component (matches the index.js agentId guard)
  const ITER_CAP = 200;                        // ledger retention; un-reviewed iterations are NEVER dropped
  const FAIL_STREAK_MAX = 3;                   // consecutive hard failures before the loop parks itself
  // consecutive RED checks before the loop parks. Distinct from failStreak: a red check is the loop working as
  // designed (the agent has not fixed it YET), so it must not be treated as an error — but without a ceiling a
  // loop that can NEVER go green grinds until the budget dies. This is that ceiling.
  const RED_STREAK_MAX = 10;
  const EXIT_MODES = ['check-green', 'empty-digests', 'never'];
  const TEXT_CAP = 4000, TITLE_CAP = 140, SUM_CAP = 1200, NOTE_CAP = 800, FILE_CAP = 50;
  /* A REVIEW DIFF IS HELD ONLY WHILE IT IS REVIEWABLE. The whole point is to let the Commander SEE the change
     before ruling on it, so it is stored on the iteration — but a diff per pass across a 200-entry ledger would
     bloat loops.json without limit. recordVerdict drops it the moment a verdict lands, so at most `queueCap`
     diffs are ever resident (≤12), and a ruled iteration keeps its title/summary/files as the durable record. */
  const DIFF_CAP = 12000;

  const iso = LJ._internals.iso;
  const dayOf = LJ._internals.dayOf;

  // fields a Commander may edit. id / timestamps / run-state / ledger are NOT patchable here.
  const EDITABLE = ['name', 'objective', 'agentId', 'model', 'provider', 'gate',
    'queueCap', 'maxIterations', 'dryStopAfter', 'stallStopAfter', 'workdir', 'branch', 'baseCommit',
    'checkCmd', 'checkTimeoutMs', 'checkPaths', 'exitOn', 'redStopAfter'];

  function isValidId(id) { return typeof id === 'string' && ID_RE.test(id); }
  function getLoop(loops, id) { return (loops || []).find(l => l && l.id === id) || null; }
  function mapLoop(loops, id, fn) { return (loops || []).map(l => (l && l.id === id ? fn(l) : l)); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function str(v, cap) { const s = v == null ? '' : String(v); return cap && s.length > cap ? s.slice(0, cap) : s; }
  function normGate(v) { return v === 'auto' ? 'auto' : 'review'; }
  // an unknown/corrupt exit mode falls back to 'never' — the loop keeps asking rather than silently declaring
  // itself finished on a value nobody wrote.
  function normExit(v) { return EXIT_MODES.indexOf(v) >= 0 ? v : 'never'; }
  function posNumOr(v, dflt) { const n = Number(v); return isFinite(n) && n >= 0 ? n : dflt; }

  function normFiles(files) {
    if (!Array.isArray(files)) return [];
    return files.slice(0, FILE_CAP).map(f => {
      if (typeof f === 'string') return { path: str(f, 400), bytes: null };
      return { path: str(f && f.path, 400), bytes: isNum(f && f.bytes) ? f.bytes : null };
    }).filter(f => f.path);
  }

  function normMeta(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const out = {};
    for (const k of Object.keys(meta)) { const v = meta[k]; if (v != null && typeof v !== 'function') out[k] = v; }
    return Object.keys(out).length ? out : null;
  }

  /* makeLoop — normalize a creation spec into a full LoopJob. A loop is born 'idle' and ENABLED: the whole
     product promise is "say what to keep doing and it goes", so there is no arm-it-later ceremony (no
     gating — a standing product law). It fires on the driver's very next tick. */
  function makeLoop(spec, ctx) {
    spec = spec || {}; ctx = ctx || {};
    const rawId = spec.id != null ? spec.id : ctx.id;
    const id = String(rawId);
    if (rawId == null || !isValidId(id)) throw new Error('loopjob-store: invalid loop id (must match ' + ID_RE + ')');
    const now = ctx.now || 0;
    const enabled = spec.enabled !== false;
    const maxIters = spec.maxIterations == null ? null : Math.max(1, parseInt(spec.maxIterations, 10) || 1);

    return {
      id: id,
      name: str(spec.name, TITLE_CAP),
      objective: str(spec.objective, TEXT_CAP),
      agentId: str(spec.agentId || 'agent', 40),
      model: spec.model != null ? str(spec.model, 200) : null,
      provider: spec.provider != null ? str(spec.provider, 60) : null,
      // REVIEW is the default and it is the safe one: nothing the loop makes is applied without a click.
      // 'auto' is the Commander's explicit "you have full access to merge" choice, per-loop, never global.
      gate: normGate(spec.gate),
      queueCap: LJ.queueCapOf({ queueCap: spec.queueCap }),
      maxIterations: maxIters,
      dryStopAfter: LJ.dryStopOf({ dryStopAfter: spec.dryStopAfter }),
      // the STALL BREAKER ceiling: passes in a row that changed nothing before the loop parks (loopjob.stallSignal).
      stallStopAfter: LJ.stallStopOf({ stallStopAfter: spec.stallStopAfter }),
      // workdir = the blessed project root this loop works in (git loop). null => the loop produces
      // workshop deliverables instead of commits, and `branch` stays null. The HOST validates blessedness;
      // this reducer only records what it was told (never trusts it as a path).
      workdir: spec.workdir != null ? str(spec.workdir, 600) : null,
      branch: spec.branch != null ? str(spec.branch, 200) : null,
      /* baseCommit — where HEAD was when the loop's branch was cut (S3). It is the TRUST BASELINE, and it
         exists because the harvest broke the original one: the tamper guard asked "are the check files in a
         state git has not recorded", and once the loop COMMITS each pass, git has recorded them. Anything
         this loop has changed since baseCommit — committed by its own harvest or still dirty — counts. */
      baseCommit: spec.baseCommit != null ? str(spec.baseCommit, 80) : null,
      /* ---- THE HOST-RUN CHECK (S2) — what turns "am I done?" from an opinion into an exit code ----
         checkCmd is authored by the HUMAN at loop-creation time and is never editable by the model: it is not
         in the iteration prompt, not a tool argument, and the agent has no route to change it. The agent's job
         is to make the check pass; it has no say in what the check IS. That separation is the entire reason a
         machine-checked exit condition can be trusted at all — see loopjob-check.js for the other half (proving
         the agent did not simply rewrite the tests). */
      checkCmd: spec.checkCmd != null ? str(spec.checkCmd, 600) : null,
      checkTimeoutMs: Math.max(1000, Math.min(600000, parseInt(spec.checkTimeoutMs, 10) || 120000)),
      checkPaths: Array.isArray(spec.checkPaths) ? spec.checkPaths.slice(0, 20).map(p => str(p, 200)).filter(Boolean) : [],
      // what ENDS this loop: a trusted green check, N empty digests, or nothing (runs until you stop it).
      exitOn: normExit(spec.exitOn),
      redStopAfter: Math.max(1, Math.min(50, parseInt(spec.redStopAfter, 10) || RED_STREAK_MAX)),
      redStreak: 0,
      enabled: enabled,
      state: enabled ? 'idle' : 'paused',
      stopReason: null,
      iterationCount: 0,
      dryStreak: 0,
      failStreak: 0,
      unfinishedStreak: 0,
      noDigestStreak: 0,
      stallStreak: 0,
      iterations: [],
      budget: {
        // 0 = ungoverned, matching budgetcaps.js semantics (never "block everything").
        perDayUsd: posNumOr(spec.perDayUsd != null ? spec.perDayUsd : (spec.budget && spec.budget.perDayUsd), 0),
        perIterationUsd: posNumOr(spec.perIterationUsd != null ? spec.perIterationUsd : (spec.budget && spec.budget.perIterationUsd), 0),
        spentTodayUsd: 0,
        day: dayOf(now)
      },
      createdAt: iso(now),
      updatedAt: iso(now),
      lastRunAt: null,
      lastRunId: null,
      fireClaim: null,
      heartbeatAt: null,
      meta: normMeta(spec.meta)
    };
  }

  function createLoop(loops, spec, ctx) {
    loops = loops || [];
    const loop = makeLoop(spec, ctx);
    if (loops.some(l => l && l.id === loop.id)) throw new Error('loopjob-store: duplicate loop id ' + loop.id);
    return loops.concat([loop]);
  }

  /* updateLoop — patch EDITABLE fields. `id` is immutable (a patch.id is ignored, never copied). Budget is
     patched through its own nested keys so a partial patch can never blank the day bucket. */
  function updateLoop(loops, id, patch, ctx) {
    ctx = ctx || {}; patch = patch || {};
    const now = ctx.now || 0;
    return mapLoop(loops, id, (loop) => {
      const next = Object.assign({}, loop);
      for (const k of EDITABLE) if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
      if (Object.prototype.hasOwnProperty.call(patch, 'gate')) next.gate = normGate(patch.gate);
      if (Object.prototype.hasOwnProperty.call(patch, 'exitOn')) next.exitOn = normExit(patch.exitOn);
      if (Object.prototype.hasOwnProperty.call(patch, 'checkCmd')) next.checkCmd = patch.checkCmd == null ? null : str(patch.checkCmd, 600);
      if (Object.prototype.hasOwnProperty.call(patch, 'checkPaths')) next.checkPaths = Array.isArray(patch.checkPaths) ? patch.checkPaths.slice(0, 20).map(x => str(x, 200)).filter(Boolean) : [];
      if (Object.prototype.hasOwnProperty.call(patch, 'queueCap')) next.queueCap = LJ.queueCapOf({ queueCap: patch.queueCap });
      if (Object.prototype.hasOwnProperty.call(patch, 'dryStopAfter')) next.dryStopAfter = LJ.dryStopOf({ dryStopAfter: patch.dryStopAfter });
      if (Object.prototype.hasOwnProperty.call(patch, 'stallStopAfter')) next.stallStopAfter = LJ.stallStopOf({ stallStopAfter: patch.stallStopAfter });
      if (Object.prototype.hasOwnProperty.call(patch, 'maxIterations')) {
        next.maxIterations = patch.maxIterations == null ? null : Math.max(1, parseInt(patch.maxIterations, 10) || 1);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'name')) next.name = str(patch.name, TITLE_CAP);
      if (Object.prototype.hasOwnProperty.call(patch, 'objective')) next.objective = str(patch.objective, TEXT_CAP);
      if (patch.budget && typeof patch.budget === 'object') {
        next.budget = Object.assign({}, loop.budget);
        if (patch.budget.perDayUsd !== undefined) next.budget.perDayUsd = posNumOr(patch.budget.perDayUsd, 0);
        if (patch.budget.perIterationUsd !== undefined) next.budget.perIterationUsd = posNumOr(patch.budget.perIterationUsd, 0);
      }
      next.updatedAt = iso(now);
      return next;
    });
  }

  function pauseLoop(loops, id, reason, ctx) {
    const now = (ctx && ctx.now) || 0;
    return mapLoop(loops, id, (loop) => Object.assign({}, loop, {
      enabled: false, state: 'paused', stopReason: reason != null ? str(reason, NOTE_CAP) : null, updatedAt: iso(now)
    }));
  }

  /* resumeLoop — re-arm a loop from ANY quiet state. Resuming clears the dry streak and the fail streak:
     the Commander looked at it and said keep going, which is new information the convergence counter must
     not override. It does NOT clear the iteration ledger — the loop keeps its memory. */
  function resumeLoop(loops, id, ctx) {
    const now = (ctx && ctx.now) || 0;
    return mapLoop(loops, id, (loop) => Object.assign({}, loop, {
      enabled: true, state: 'idle', stopReason: null, dryStreak: 0, failStreak: 0, unfinishedStreak: 0, redStreak: 0, noDigestStreak: 0, stallStreak: 0, updatedAt: iso(now)
    }));
  }

  function stopLoop(loops, id, reason, ctx) {
    const now = (ctx && ctx.now) || 0;
    return mapLoop(loops, id, (loop) => Object.assign({}, loop, {
      enabled: false, state: 'stopped', stopReason: reason != null ? str(reason, NOTE_CAP) : 'stopped by the Commander',
      fireClaim: null, heartbeatAt: null, updatedAt: iso(now)
    }));
  }

  function removeLoop(loops, id) { return (loops || []).filter(l => !(l && l.id === id)); }

  /* claimFire — stamp the durable in-flight claim BEFORE the run launches (cron-store G4.5 idiom). The host
     persists this and only then fires, so a crash-restart inside the run window sees the claim and does not
     double-fire. Cleared on every settlement; a claim older than the driver's staleMs is reclaimed as a
     zombie by loopjob.decide so a dead holder can never wedge the loop forever. */
  function claimFire(loops, id, ctx) {
    const now = (ctx && ctx.now) || 0;
    return mapLoop(loops, id, (loop) => Object.assign({}, loop, { fireClaim: now, updatedAt: iso(now) }));
  }

  /* renewHeartbeat — NS-0 idiom: proof the in-flight iteration is genuinely still emitting progress, so a
     long-but-live run is not declared a zombie and re-fired. No-op unless a claim is held. */
  function renewHeartbeat(loops, id, ctx) {
    const now = (ctx && ctx.now) || 0;
    return mapLoop(loops, id, (loop) => (loop.fireClaim == null ? loop : Object.assign({}, loop, { heartbeatAt: now })));
  }

  /* pruneIterations — cap the ledger, NEVER dropping anything the Commander still has to rule on. Only
     verdict-settled / noop / failed rows are eligible for eviction, oldest first. A pending candidate is
     unreviewed WORK; silently evicting it would strand a real artifact. */
  function pruneIterations(its) {
    if (its.length <= ITER_CAP) return its;
    const keepAlways = new Set();
    for (const it of its) if (it.outcome === 'candidate' && !it.verdict) keepAlways.add(it.n);
    const out = [];
    let dropBudget = its.length - ITER_CAP;
    for (const it of its) {
      if (dropBudget > 0 && !keepAlways.has(it.n)) { dropBudget--; continue; }
      out.push(it);
    }
    return out;
  }

  /* startIteration — append a RUNNING iteration and take the number. iterationCount is incremented here (at
     start, not at settle) so a crash mid-iteration still burns the slot: the alternative lets a crash-loop
     re-use n forever and blow past maxIterations invisibly. */
  function startIteration(loops, id, ctx) {
    ctx = ctx || {};
    const now = ctx.now || 0;
    return mapLoop(loops, id, (loop) => {
      const n = (loop.iterationCount || 0) + 1;
      const it = {
        n: n,
        runId: ctx.runId != null ? str(ctx.runId, 80) : null,
        startedAt: iso(now), endedAt: null,
        outcome: 'running',
        title: null, summary: null, commit: null, files: [], usd: 0, error: null,
        verdict: null, verdictNote: null, verdictAt: null
      };
      return Object.assign({}, loop, {
        iterationCount: n,
        state: 'running',
        stopReason: null,
        lastRunId: it.runId,
        iterations: pruneIterations((loop.iterations || []).concat([it])),
        updatedAt: iso(now)
      });
    });
  }

  /* settleIteration — record how the newest running iteration ended and decide the loop's next state.

     result = { runId, status:'ok'|'error', text, title, summary, commit, files, usd, error, cancelled }

     Outcome resolution:
       cancelled          -> 'cancelled'  (E-STOP / Commander stop mid-iteration; costs no streak either way)
       result.unfinished  -> 'unfinished' (review r8: the pass's run did not FINISH — it asked, was cut short, hit a limit, sent back nothing or
                                           was refused; unfinishedAs keeps which. Never a failed pass: unfinishedStreak++)
       status !== 'ok'    -> 'failed'     (failStreak++)
       NOTHING-TO-DO      -> 'noop'       (dryStreak++; dryStopAfter in a row parks the loop 'dormant')
       otherwise          -> 'candidate'  (dryStreak reset; enters the review queue, or auto-approves)

     THE TROUBLE PAUSE (review 8.1). failStreak and unfinishedStreak count the failed and the unfinished passes of ONE unbroken run of
     passes that did not succeed: a failed pass and an unfinished pass do not reset each other (a loop that alternates a crash and a spend
     cap is burning money just the same, and it parked at FAIL_STREAK_MAX before r8 split the two), and every pass that DID succeed — a
     candidate, a noop, a red check, the objective met — resets both. FAIL_STREAK_MAX of them in a row parks the loop 'paused', and the
     reason says what the run held: "N iterations failed in a row", "N passes in a row did not finish", or both counts. A cancelled pass
     (a stop) is neither and leaves both as they were.

     A gate:'auto' loop stamps its own verdict 'approved' at settle time — it applied its own work, so there
     is nothing to queue. That verdict is a RECORD of what happened, not a fake review: the digest still
     feeds it forward as "already done", which is exactly true. */
  function settleIteration(loops, id, result, ctx) {
    result = result || {}; ctx = ctx || {};
    const now = ctx.now || 0;
    const failMax = isNum(ctx.failStreakMax) ? ctx.failStreakMax : FAIL_STREAK_MAX;

    return mapLoop(loops, id, (loop) => {
      const its = (loop.iterations || []).slice();
      // settle the newest RUNNING iteration (matched by runId when the caller supplies one — a late
      // settlement from a superseded run must never overwrite its replacement's record; the same
      // generation-fence intent as cron-driver's finishFire).
      let idx = -1;
      for (let i = its.length - 1; i >= 0; i--) {
        if (its[i].outcome !== 'running') continue;
        if (result.runId != null && its[i].runId != null && String(its[i].runId) !== String(result.runId)) continue;
        idx = i; break;
      }
      if (idx < 0) return loop;      // nothing in flight to settle (already settled, or fenced out)

      const cancelled = result.cancelled === true;
      const ok = result.status === 'ok' && !cancelled;
      const chk = (result.check && result.check.ran) ? result.check : null;
      let outcome;
      if (cancelled) outcome = 'cancelled';
      else if (!ok && result.unfinished) outcome = 'unfinished';
      else if (!ok) outcome = 'failed';
      // A RED CHECK IS NOT A REVIEW ITEM. The run succeeded, the work just is not ready — so it feeds forward
      // into the next iteration (carrying the failure output) instead of asking the Commander to approve
      // something the project's own tests reject. This is the difference between a feedback loop and a retry.
      else if (chk && !chk.passed) outcome = 'red';
      else outcome = LJ.nextOutcomeFor(result.text);

      const usd = posNumOr(result.usd, 0);
      const settled = Object.assign({}, its[idx], {
        endedAt: iso(now),
        outcome: outcome,
        unfinishedAs: outcome === 'unfinished' ? str(result.unfinished, 40) : null,
        title: str(result.title, TITLE_CAP) || null,
        summary: str(result.summary, SUM_CAP) || null,
        commit: result.commit != null ? str(result.commit, 80) : null,
        files: normFiles(result.files),
        usd: usd,
        error: ok ? null : (result.error != null ? str(result.error, NOTE_CAP) : (cancelled ? 'cancelled' : 'error')),
        // the parsed report for this pass. Stored rather than re-derived, because `summary` is truncated and
        // the DIGEST line lives at the END of the reply — re-parsing it later would read a cut-off string.
        digest: (ok && !cancelled) ? LJ.readDigest(result.text) : null,
        diff: result.diff != null ? str(result.diff, DIFF_CAP) : null,
        check: chk ? {
          passed: !!chk.passed, summary: str(chk.summary, SUM_CAP), note: str(chk.note, NOTE_CAP),
          tampered: !!chk.tampered, tamperedPaths: (chk.tamperedPaths || []).slice(0, FILE_CAP).map(p => str(p, 400)),
          trusted: !!chk.trusted, gitProven: !!chk.gitProven
        } : null
      });
      /* gate:'auto' applies its own work — stamp the verdict now so it never sits in a queue nobody reads.
         THE ONE EXCEPTION, and it is the whole point of the tamper guard: a check that `mustReview` NEVER
         auto-approves, even on a full-access loop. If an iteration edited the tests and then went green, the
         "you have full access to merge" setting must not be the thing that lets it merge unseen — that is
         precisely the case a human has to look at. Full access is a convenience, not an override on evidence. */
      if (outcome === 'candidate' && loop.gate === 'auto' && !(chk && chk.mustReview)) {
        settled.verdict = 'approved';
        settled.verdictNote = 'auto-applied (this loop has full access to merge)';
        settled.verdictAt = iso(now);
        settled.diff = null;   // self-approved: there is no review to hold a diff for
      }
      /* THE STALL BREAKER reads the settled row against the loop's history (before this row is folded in) and
         stamps the verdict ON THE ROW, so the panel can label "#7 changed nothing" from the record itself. */
      const stall = LJ.stallSignal(loop, settled);
      if (stall) settled.stall = stall;
      its[idx] = settled;

      const rolled = LJ.rollBudgetDay(loop, { now: now });
      const budget = Object.assign({}, rolled.budget, {
        spentTodayUsd: ((rolled.budget && rolled.budget.spentTodayUsd) || 0) + usd
      });

      const next = Object.assign({}, loop, {
        iterations: pruneIterations(its),
        budget: budget,
        lastRunAt: iso(now),
        lastRunId: settled.runId || loop.lastRunId,
        fireClaim: null, heartbeatAt: null,
        updatedAt: iso(now)
      });

      // ---- streaks + the next state -------------------------------------------------------------------
      /* THE EXIT CONDITION. A loop set to exitOn:'check-green' is DONE when the project's own check passes and
         the loop can prove the check was not rewritten to get there. `trusted` (not merely `passed`) is the
         bar — an unprovable or tampered green stops for review but must never declare the objective complete.
         'done' is deliberately its own state: "achieved what you asked" and "found nothing left to do" are
         different outcomes and the panel has to be able to say which one happened. */
      if (chk && loop.exitOn === 'check-green' && chk.trusted) {
        next.redStreak = 0; next.dryStreak = 0; next.failStreak = 0; next.unfinishedStreak = 0;
        next.state = 'done';
        next.enabled = false;
        next.stopReason = 'objective met — ' + (chk.summary || 'the check passes');
        return next;
      }

      if (outcome === 'red') {
        next.redStreak = (loop.redStreak || 0) + 1;
        next.failStreak = 0; next.unfinishedStreak = 0; next.dryStreak = 0;
        const redMax = Math.max(1, parseInt(loop.redStopAfter, 10) || RED_STREAK_MAX);
        if (next.redStreak >= redMax) {
          next.state = 'paused';
          next.enabled = false;
          next.stopReason = 'the check has been red for ' + next.redStreak + ' iterations — ' + (settled.check ? settled.check.summary : 'no progress');
          return next;
        }
        // still red but under the ceiling: stay live so the next iteration gets the failure output.
        next.state = 'idle'; next.stopReason = null;
        return next;
      }
      if (chk && chk.passed) next.redStreak = 0;   // a green resets the red streak even when it is not trusted

      if (outcome === 'noop') {
        next.dryStreak = (loop.dryStreak || 0) + 1;
        next.failStreak = 0; next.unfinishedStreak = 0;
        if (next.dryStreak >= LJ.dryStopOf(loop)) {
          next.state = 'dormant';
          next.enabled = false;
          next.stopReason = 'nothing left to do — ' + next.dryStreak + ' passes in a row found no work';
          return next;
        }
      } else if (outcome === 'unfinished' || outcome === 'failed') {
        // THE TROUBLE PAUSE (see the header): one unbroken run of passes that did not succeed, its failed and unfinished passes counted apart
        if (outcome === 'failed') next.failStreak = (loop.failStreak || 0) + 1;
        else next.unfinishedStreak = (loop.unfinishedStreak || 0) + 1;
        const failedN = next.failStreak || 0, unfinishedN = next.unfinishedStreak || 0, troubleN = failedN + unfinishedN;
        if (troubleN >= failMax) {
          const last = settled.error || settled.unfinishedAs || 'no reason recorded';
          next.state = 'paused';
          next.enabled = false;
          next.stopReason = !unfinishedN ? failedN + ' iterations failed in a row: ' + last
            : !failedN ? unfinishedN + ' passes in a row did not finish: ' + last
            : troubleN + ' passes in a row did not succeed (' + failedN + ' failed, ' + unfinishedN + ' did not finish), the last: ' + last;
          return next;
        }
      } else if (outcome === 'candidate') {
        next.dryStreak = 0;
        next.failStreak = 0; next.unfinishedStreak = 0;
        /* A candidate that changed nothing is not progress, and three of them in a row is the runaway this
           counter exists for. 'paused' (not 'dormant'): the loop did NOT concede — it kept claiming work — so
           the honest label is "parked for the Commander to look at", and RESUME clears the streak like every
           other quiet state. The reason names the count so the panel needs no guesswork. */
        if (stall) {
          next.stallStreak = (loop.stallStreak || 0) + 1;
          const stallMax = LJ.stallStopOf(loop);
          if (next.stallStreak >= stallMax) {
            next.state = 'paused';
            next.enabled = false;
            next.stopReason = next.stallStreak + ' passes in a row changed nothing — no file touched, nothing committed. Parked before it spends more; resume once you know why.';
            return next;
          }
        } else {
          next.stallStreak = 0;
        }
      }

      /* REPORTING COMPLIANCE. A loop whose exit condition is "N empty digests" can only ever finish if the
         model keeps filing them. Track the streak of passes that filed nothing readable so the panel can say
         so out loud — otherwise a non-reporting loop looks perfectly healthy while being unable to stop. */
      if ((loop.exitOn || 'never') === 'empty-digests' && outcome !== 'cancelled' && outcome !== 'failed' && outcome !== 'unfinished') {
        next.noDigestStreak = (settled.digest && settled.digest.filed) ? 0 : ((loop.noDigestStreak || 0) + 1);
      }

      // still live: 'waiting' when the review queue is now full (the honest reason it goes quiet), else idle.
      const pend = LJ.pendingReviews(next).length;
      if (next.gate !== 'auto' && pend >= LJ.queueCapOf(next)) {
        next.state = 'waiting';
        next.stopReason = pend + ' waiting on your review';
      } else {
        next.state = 'idle';
        next.stopReason = null;
      }
      return next;
    });
  }

  /* recoverInterruptedIteration — reconcile a RUNNING row that survived its host process.

     A durable fire claim proves only that the pass started; it cannot prove whether a tool effect immediately
     before the crash happened. Automatically re-firing that pass can therefore duplicate a committed effect,
     while leaving the row `running` asserts liveness no process can prove. Record the abandoned pass as
     cancelled and park the loop for the existing explicit RESUME action. Cancellation is neutral (no failure
     or convergence streak), and the full ledger stays available for recovery review. */
  function recoverInterruptedIteration(loops, id, reason, ctx) {
    ctx = ctx || {};
    const loop = getLoop(loops, id);
    if (!loop) return loops || [];
    const running = (loop.iterations || []).slice().reverse().find(it => it && it.outcome === 'running');
    if (!running) {
      // A claim with no persisted iteration can only be the claim->start crash window. No work was launched
      // before startIteration persisted, so clearing this orphan claim is safe and idempotent.
      return mapLoop(loops, id, cur => Object.assign({}, cur, {
        fireClaim: null, heartbeatAt: null,
        state: cur.state === 'running' ? 'paused' : cur.state,
        enabled: cur.state === 'running' ? false : cur.enabled,
        stopReason: cur.state === 'running' ? str(reason, NOTE_CAP) : cur.stopReason,
        updatedAt: iso(ctx.now || 0)
      }));
    }
    const settled = settleIteration(loops, id, {
      runId: running.runId,
      status: 'error',
      cancelled: true,
      error: reason || 'interrupted by sidecar restart'
    }, ctx);
    return mapLoop(settled, id, cur => Object.assign({}, cur, {
      enabled: false,
      state: 'paused',
      stopReason: str(reason || 'interrupted by sidecar restart — review recovery evidence, then resume explicitly', NOTE_CAP),
      fireClaim: null,
      heartbeatAt: null,
      updatedAt: iso(ctx.now || 0)
    }));
  }

  /* recordVerdict — the review gate. verdict is 'approved' or 'rejected'.

     APPROVED: this iteration's work is accepted. (The HOST performs the actual git merge / file promotion
     BEFORE calling this — the store records what happened, it never claims an apply it did not witness.)

     REJECTED: this iteration is rejected AND every un-approved candidate stacked above it is marked
     'discarded', because they were built on top of it (THE STACKING LAW in the header). `note` is the
     Commander's reason and is the single most valuable field in the whole subsystem — loopjob.digest leads
     the next iteration's prompt with it. A rejection with no note still works, it just teaches nothing.

     Rejecting also clears the dry streak: the loop demonstrably still has work to do (it just did it wrong),
     so it must not be allowed to converge to DORMANT off the back of a rejected pass. */
  function recordVerdict(loops, id, n, verdict, ctx) {
    ctx = ctx || {};
    const now = ctx.now || 0;
    const num = parseInt(n, 10);
    const v = verdict === 'approved' ? 'approved' : 'rejected';
    const note = ctx.note != null ? str(ctx.note, NOTE_CAP) : null;

    return mapLoop(loops, id, (loop) => {
      const target = (loop.iterations || []).find(it => it && it.n === num);
      if (!target || target.outcome !== 'candidate' || target.verdict) return loop;   // nothing to rule on
      // FIFO approvals (the STACKING LAW): #num was built on every unreviewed candidate below it, so keeping it while
      // one of those can still be rejected would let it survive a rejection the cascade can no longer reach.
      if (v === 'approved' && LJ.pendingReviews(loop).some(it => it.n < num)) return loop;

      const its = (loop.iterations || []).map(it => {
        if (it.n === num) {
          // the diff was for DECIDING; once decided it is dead weight in a durable file (see DIFF_CAP).
          return Object.assign({}, it, { verdict: v, verdictNote: note, verdictAt: iso(now), diff: null });
        }
        // cascade: only on rejection, only un-approved candidates ABOVE the rejected one.
        if (v === 'rejected' && it.n > num && it.outcome === 'candidate' && !it.verdict) {
          return Object.assign({}, it, {
            verdict: 'discarded',
            verdictNote: 'discarded — built on top of rejected #' + num,
            verdictAt: iso(now),
            diff: null
          });
        }
        return it;
      });

      const next = Object.assign({}, loop, { iterations: its, updatedAt: iso(now) });
      if (v === 'rejected') next.dryStreak = 0;

      // a verdict frees queue space — if the loop was parked on a full queue, that reason is now gone. This
      // is what makes the loop advance on the VERDICT rather than the clock.
      if (next.state === 'waiting') {
        const pend = LJ.pendingReviews(next).length;
        if (next.gate === 'auto' || pend < LJ.queueCapOf(next)) { next.state = 'idle'; next.stopReason = null; }
        else next.stopReason = pend + ' waiting on your review';
      }
      return next;
    });
  }

  /* loadEnvelope — normalize whatever came off disk into { version, loops }. Tolerates a JSON string, a
     parsed object, null, or garbage; fail-closed to an empty store. Drops malformed records rather than
     trusting them, and normalizes the fields a live driver reads so an old/hand-edited file cannot make the
     gate math NaN its way into firing. */
  function loadEnvelope(raw) {
    let obj = raw;
    if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch (e) { obj = null; } }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.loops)) return { version: ENVELOPE_VERSION, loops: [] };
    const loops = obj.loops
      .filter(l => l && typeof l === 'object' && isValidId(l.id))
      .map(l => Object.assign({}, l, {
        gate: normGate(l.gate),
        // a corrupt/hand-edited exitOn can never load as 'check-green' — the store fails toward asking, never
        // toward a loop that declares itself finished on a value nobody wrote.
        exitOn: normExit(l.exitOn),
        redStreak: isNum(l.redStreak) ? l.redStreak : 0,
        noDigestStreak: isNum(l.noDigestStreak) ? l.noDigestStreak : 0,
        redStopAfter: isNum(l.redStopAfter) ? l.redStopAfter : RED_STREAK_MAX,
        checkCmd: l.checkCmd != null ? str(l.checkCmd, 600) : null,
        checkPaths: Array.isArray(l.checkPaths) ? l.checkPaths.map(x => str(x, 200)).filter(Boolean) : [],
        iterations: Array.isArray(l.iterations) ? l.iterations.filter(it => it && isNum(it.n)) : [],
        iterationCount: isNum(l.iterationCount) ? l.iterationCount : 0,
        dryStreak: isNum(l.dryStreak) ? l.dryStreak : 0,
        failStreak: isNum(l.failStreak) ? l.failStreak : 0,
        unfinishedStreak: isNum(l.unfinishedStreak) ? l.unfinishedStreak : 0,
        // a pre-breaker record (no stallStreak / stallStopAfter) loads with the shipped ceiling and a clean streak
        stallStreak: isNum(l.stallStreak) ? l.stallStreak : 0,
        stallStopAfter: LJ.stallStopOf({ stallStopAfter: l.stallStopAfter }),
        budget: l.budget && typeof l.budget === 'object' ? {
          perDayUsd: posNumOr(l.budget.perDayUsd, 0),
          perIterationUsd: posNumOr(l.budget.perIterationUsd, 0),
          spentTodayUsd: posNumOr(l.budget.spentTodayUsd, 0),
          day: isNum(l.budget.day) ? l.budget.day : 0
        } : { perDayUsd: 0, perIterationUsd: 0, spentTodayUsd: 0, day: 0 }
      }));
    return { version: ENVELOPE_VERSION, loops: loops };
  }

  function toEnvelope(loops) { return { version: ENVELOPE_VERSION, loops: (loops || []).slice() }; }

  return {
    makeLoop: makeLoop,
    createLoop: createLoop,
    updateLoop: updateLoop,
    pauseLoop: pauseLoop,
    resumeLoop: resumeLoop,
    stopLoop: stopLoop,
    removeLoop: removeLoop,
    getLoop: getLoop,
    claimFire: claimFire,
    renewHeartbeat: renewHeartbeat,
    startIteration: startIteration,
    settleIteration: settleIteration,
    recoverInterruptedIteration: recoverInterruptedIteration,
    recordVerdict: recordVerdict,
    loadEnvelope: loadEnvelope,
    toEnvelope: toEnvelope,
    isValidId: isValidId,
    ENVELOPE_VERSION: ENVELOPE_VERSION,
    ITER_CAP: ITER_CAP,
    FAIL_STREAK_MAX: FAIL_STREAK_MAX,
    RED_STREAK_MAX: RED_STREAK_MAX,
    EXIT_MODES: EXIT_MODES
  };
});
