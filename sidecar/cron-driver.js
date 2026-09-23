/* sidecar/cron-driver.js — the autonomous scheduler TICK DRIVER (CRON Commit 4b), determinism-split clean.

   The orchestration half of the scheduler: it owns the per-tick decision flow (reclaim stale leases → plan
   via the pure cron-math → persist the advanced next-fires BEFORE launching → fire each due job through the
   injected run host → record the outcome) and the in-flight LEASE map. Every ambient dependency is INJECTED —
   there is NO Date.now / Math.random / new Date() / setInterval / setTimeout / fs / crypto in this file, so it
   passes lint-determinism.js and is headless-testable with a fake clock + a fake runOnce (exactly like
   loop.js / permissions.js / cron-store.js). The ambient half — the real setInterval timer, Date.now,
   crypto.randomUUID, the cron.jobs.json load/persist, the boot-resume reconcile — lives ONLY in
   sidecar/index.js (the lint-exempt composition root). See docs/CRON_INTEGRATION_PLAN.md §3.1, §3.3, §4b.

   The whole subsystem is OPT-IN: index.js arms the timer only when SKYNET_CRON_ENABLED is set, so when it is
   off no driver is ever constructed, nothing fires, and the browser path is byte-identical.

   makeCronDriver(deps) -> { applyTick(nowMs) -> {fired,skipped,planned}, leases:Map }
     deps.getJobs()        -> CronJob[]          // read the live store (index.js's cronJobs mirror)
     deps.setJobs(jobs)    -> void               // replace + PERSIST the store (index.js: cronJobs=…; saveCronJobs())
     deps.runOnce(opts)    -> Promise<result>    // the SAME run host the browser uses (index.js runOnce)
     deps.emit(name,pl)    -> void               // a validated+redacted cron emitter (-> console + the SSE HUD)
     deps.newId()          -> string             // a fresh runId (crypto.randomUUID in index.js)
     deps.newAbort()       -> AbortController     // () => new AbortController()
     deps.now()            -> int ms             // wall clock for run-COMPLETION timestamps (a run settles long
                                                 //   after applyTick's nowMs is stale) — Date.now in index.js
     deps.getKey(provider, job)
                           -> string             // LIVE provider credential material when one is key-backed
     deps.providerForJob(job, ident)
                           -> string             // selected runtime provider ('openrouter' or 'codex')
     deps.hasCredential(provider, key, job)
                           -> bool               // OAuth providers can be runnable without a BYOK key
     deps.defaultModel     -> string             // boot-frozen SKYNET_DEFAULT_MODEL fallback when job.model is null
     deps.identityForAgent -> (agentId, job) -> { system?, model? } | null
                                                 // optional selected-agent identity (browser roster / persisted mirror)
     deps.agentExists      -> (agentId) -> bool  // OPTIONAL deleted-agent guard: false = the job's agent no longer
                                                 //   exists (durable roster miss), so the job is REMOVED instead of
                                                 //   fired — an orphaned routine must never keep spending/minting
                                                 //   sessions under a deleted agent. Absent -> pre-guard behavior.
     deps.persona          -> string | ()=>string // the autonomous system prompt (carries the [SILENT] hint);
                                                 //   a getter is re-read each fire so it can fold in the live
                                                 //   Commander dossier (Phase C). Both forms stay determinism-clean.
     deps.maxRunMs         -> int                // self-healing lease ceiling: a run older than this is reclaimed
     deps.stageBriefFor   -> (agentId) -> string|null
                                                 // OPTIONAL: the standing job brief of the dock this agent
                                                 //   crews (index.js injects router.stageBrief). Appended to
                                                 //   the entry run's system context under the hub's exact
                                                 //   section header. PROMPT TEXT ONLY — never grants/tools.
     deps.placeWorkitem(agentId, prompt, runId)
                           -> void               // OPTIONAL: ride the routine's instruction onto the CONVEYOR as a
                                                 //   box bound for its agent (the SAME workitem.placed plumbing a
                                                 //   Telegram message uses) so a scheduled fire is VISIBLE on the
                                                 //   floor — a crate arrives and the agent goes to work. Injected
                                                 //   (the ambient id-mint + emit live in index.js), so this file
                                                 //   stays determinism-clean. No-op when not provided. */
'use strict';
(function (root, factory) {
  const api = factory(
    typeof require === 'function' ? require('./cron.js') : (root.SK && root.SK.cron),
    typeof require === 'function' ? require('./cron-store.js') : (root.SK && root.SK.cronStore)
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).cronDriver = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (cron, cronStore) {
  'use strict';
  // failopen.note — the tagged SYNC swallow (per-tag count + throttled warn): a fail-open catch must never be invisible.
  const { note: failNote } = (typeof require === 'function') ? require('./failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };

  const SILENT_MARKER = '[SILENT]';
  const iso = cron._internals.iso;   // ms(arg) -> ISO; deterministic (the lint bans only the zero-arg new Date)
  // B4 redacted-egress: the SAME structural redaction the channel tee applies, so both autonomous lanes
  // (routed messages + scheduled cron) ship one shape to the floor — tool_call name-only, tool_result
  // outcome-only, metadata events whole, everything else dropped. Pure (no time/rng) so this stays
  // determinism-clean; require is resolved at load in the sidecar (the only host that runs the driver).
  const runTeeView = (typeof require === 'function')
    ? require('./channels/sse.js').runTeeView
    : ((root.SK && root.SK.channels && root.SK.channels.sse && root.SK.channels.sse.runTeeView) || function (n, p) { return p; });
  // INJECTION TRIPWIRE (2026-07-25) — pure, no ambient deps, so requiring it keeps this file determinism-clean.
  const cronGuard = (typeof require === 'function')
    ? require('./cron-guard.js')
    : ((root.SK && root.SK.cronGuard) || { scanAssembled: function () { return { ok: true }; } });

  function makeCronDriver(deps) {
    const d = deps || {};
    const getJobs = d.getJobs, setJobs = d.setJobs, runOnce = d.runOnce;
    const emit = typeof d.emit === 'function' ? d.emit : function () {};
    // a place to say something went wrong without changing behaviour (injectable so tests stay quiet)
    const warn = typeof d.warn === 'function' ? d.warn : function (m) { try { console.warn(m); } catch (_) {} };
    const newId = d.newId, newAbort = d.newAbort, now = d.now;
    const getKey = typeof d.getKey === 'function' ? d.getKey : function () { return ''; };
    const providerForJob = typeof d.providerForJob === 'function' ? d.providerForJob : function () { return 'openrouter'; };
    const hasCredential = typeof d.hasCredential === 'function' ? d.hasCredential : function (_provider, key) { return !!key; };
    const defaultModel = d.defaultModel || '';
    const identityForAgent = typeof d.identityForAgent === 'function' ? d.identityForAgent : function () { return null; };
    const agentExists = typeof d.agentExists === 'function' ? d.agentExists : null;
    // persona may be a STRING (the autonomous system prompt) or a GETTER that returns it fresh each fire
    // (Phase C: index.js passes a getter so each run folds in the live Commander dossier). Both stay
    // determinism-clean — a getter is just an injected dep, exactly like getKey/getJobs.
    const personaOf = typeof d.persona === 'function' ? d.persona : function () { return d.persona || ''; };
    const placeWorkitem = typeof d.placeWorkitem === 'function' ? d.placeWorkitem : function () {};
    // B5 parity (2026-07-06 audit): a routine's run gets the SAME per-bay capability station a routed channel
    // message gets — resolveStation(agentId) -> the bay room's objects, else null -> the host's default office.
    // Optional + injected so this module stays determinism-clean; absent -> pre-fix behavior.
    const resolveStation = typeof d.resolveStation === 'function' ? d.resolveStation : null;
    // THE DOCK'S STANDING BRIEF (inbox-trigger, 2026-08-05): stageBriefFor(agentId) -> the standing job brief
    // of the dock this agent crews (index.js injects router.stageBrief — the SAME seam hub entry runs and
    // chain handoffs read), or null. A scheduled fire was the ONE entry-run path that never briefed its dock:
    // the same agent ran with its brief from a routed message and without it from a routine. PROMPT TEXT ONLY —
    // a brief never changes who runs, what tools they hold, or what grants apply. Optional + injected so this
    // file stays determinism-clean; absent -> pre-brief behavior, byte-identical.
    const stageBriefFor = typeof d.stageBriefFor === 'function' ? d.stageBriefFor : null;
    const maxRunMs = d.maxRunMs || (8 * 60 * 1000);
    // NS-0 LEASE HEARTBEAT knobs (all injected, determinism-clean; host threads env). The lease sweep no
    // longer reclaims on a fixed wall-clock age — it reclaims only when a run's HEARTBEAT is stale (the run
    // stopped proving liveness, i.e. it crashed / the emit stream died). A genuinely-live long run keeps
    // renewing its heartbeat on every progress event, so it fires EXACTLY ONCE regardless of duration.
    //   heartbeatStaleMs — how long WITHOUT a heartbeat before a lease is a zombie (default maxRunMs*mult).
    //   stalenessMult    — the multiplier applied to maxRunMs when heartbeatStaleMs is not given (default 1, so a
    //                      run that emits NOTHING reclaims at the SAME maxRunMs ceiling as before this change —
    //                      backward-compatible; a run that DOES heartbeat renews continuously and never reclaims).
    //   durableHeartbeatMs — min interval between DURABLE (persisted) one-shot heartbeat writes (throttle so
    //                        the hot token path doesn't fsync on every delta); default heartbeatStaleMs/4.
    const stalenessMult = (function () { const n = parseFloat(d.stalenessMult); return (Number.isFinite(n) && n > 0) ? n : 1; })();
    const heartbeatStaleMs = (function () { const n = parseInt(d.heartbeatStaleMs, 10); return (Number.isFinite(n) && n > 0) ? n : Math.round(maxRunMs * stalenessMult); })();
    const durableHeartbeatMs = (function () { const n = parseInt(d.durableHeartbeatMs, 10); return (Number.isFinite(n) && n > 0) ? n : Math.max(1, Math.round(heartbeatStaleMs / 4)); })();
    // G4.4 global concurrency cap: at most `maxParallel` cron runs may be IN-FLIGHT at once. When a tick's due
    // set would push the live-lease count over this, the EXTRA due jobs are DEFERRED to the next tick WITHOUT
    // advancing their nextRunAt (they stay due), so a burst of simultaneously-due routines never floods the run
    // host / blows the spend budget all at once — they drain `maxParallel` at a time over successive ticks. An
    // INJECTED int (host threads SKYNET_CRON_MAX_PARALLEL), so this file stays determinism-clean. Default OFF.
    const maxParallel = (function () {
      const n = parseInt(d.maxParallel, 10);
      return (Number.isFinite(n) && n >= 0) ? n : 0;
    })();
    // injected host tz (G4.1): a tz-LESS cron schedule is planned on this LOCAL wall-clock; a schedule's
    // own tz always wins. A string dep — the pure cron-math owns the Intl formatting, so this stays clean.
    const defaultTz = d.defaultTz != null ? d.defaultTz : null;
    // CONSECUTIVE-FAILURE AUTO-DISABLE ceiling (host-injected from SKYNET_CRON_MAX_CONSECUTIVE_FAILURES; 0 = off).
    const maxConsecutiveFailures = (function () {
      const n = parseInt(d.maxConsecutiveFailures, 10);
      return Number.isFinite(n) && n >= 0 ? n : cronStore.DEFAULT_MAX_CONSECUTIVE_FAILURES;
    })();
    /* THE WORK LINE, for scheduled work. A routine fires at ONE dock; if the Commander drew stages past that
       dock, those stages are the routine — "every morning research it, then write it up" is the shape people
       actually want from a floor. Optional: absent, a fire is a single run exactly as before. Called AFTER the
       job's own run settles but BEFORE finishFire, so the routine's recorded outcome and its session transcript
       carry the LINE's answer, not stage one's raw material. */
    const advanceChain = typeof d.advanceChain === 'function' ? d.advanceChain : null;
    const contextFor = typeof d.contextFor === 'function' ? d.contextFor : function () { return ''; };
    const deliverResult = typeof d.deliverResult === 'function' ? d.deliverResult : null;
    const preflightConfig = typeof d.preflightConfig === 'function' ? d.preflightConfig : null;
    const hashText = typeof d.hashText === 'function' ? d.hashText : function (s) { return String(s == null ? '' : s); };
    const blockedRetryMs = (function () { const n = parseInt(d.blockedRetryMs, 10); return Number.isFinite(n) && n > 0 ? n : 60000; })();
    // Fault-injection seam: false models a process stop after the final receipt is durable, before delivery.
    const afterFinalizationCommitted = typeof d.afterFinalizationCommitted === 'function' ? d.afterFinalizationCommitted : null;
    if (typeof getJobs !== 'function' || typeof setJobs !== 'function') throw new Error('cron-driver: getJobs/setJobs are required');
    if (typeof runOnce !== 'function') throw new Error('cron-driver: runOnce is required');
    if (typeof newId !== 'function' || typeof newAbort !== 'function' || typeof now !== 'function') throw new Error('cron-driver: newId/newAbort/now are required');

    const leases = new Map();   // jobId -> { runId, startedAt, heartbeatAt, ac, isOnce, durableAt } — one-run-per-job in-flight lock
    // G4.3 in-process reentrancy guard: a tick re-entered at the SAME instant (e.g. the boot resume
    // reconcile racing the first timer tick, or a fire's run host synchronously re-entering applyTick)
    // must be a NO-OP — the outer pass has not yet persisted its advance, so a re-entrant pass would
    // see the same jobs still due and double-fire. The cross-process file lock (cron-lock.js) handles
    // the two-sidecars case; this flag closes the single-process re-entrancy hole the lock cannot see.
    let tickInFlight = false;
    // NS-0 SKIP-TELEMETRY DEDUPE: a DISABLED-but-due job (paused with a past nextRunAt) would otherwise emit
    // cron.skipped{disabled} EVERY tick — spam that violates the no-op invariant. Emit it AT MOST ONCE per
    // (jobId, nextRunAt) window: once the job's due instant changes (re-enabled+re-armed, edited) or the job
    // goes away, the key changes / is pruned and a fresh disabled window can report again. Keyed jobId->dueKey.
    const disabledNotified = new Map();

    async function deliverFinalization(job) {
      const f = job && job.finalization;
      if (!f || f.state !== 'pending') return false;
      if (!deliverResult) {
        setJobs(cronStore.markDelivery(getJobs(), job.id, { ok: true, runId: f.runId }, { now: now() }));
        return true;
      }
      // Use the destination snapshot committed with the result, not an edited job's newer routing fields.
      const deliveryJob = Object.assign({}, job, { deliver: f.deliver, origin: f.origin });
      let out;
      try { out = await deliverResult(deliveryJob, { runId: f.runId, outcome: f.outcome, text: f.result || '', error: f.error || null }); }
      catch (e) { out = { ok: false, error: (e && e.message) || String(e) }; }
      const live = cronStore.getJob(getJobs(), job.id);
      const deliveryOk = !out || out.ok !== false;
      if (live && live.finalization && live.finalization.state === 'pending' && live.finalization.runId === f.runId) {
        setJobs(cronStore.markDelivery(getJobs(), job.id, { ok: deliveryOk, error: out && out.error, runId: f.runId }, { now: now() }));
      }
      return deliveryOk;
    }

    async function recoverFinalizations() {
      let count = 0;
      for (const job of getJobs().slice()) if (job && job.finalization && job.finalization.state === 'pending') {
        if (await deliverFinalization(job)) count++;
      }
      return count;
    }

    /* renewLease — NS-0: a run proved it is alive (a progress event arrived), so bump its lease heartbeat to
       `now`. For a ONE-SHOT run, ALSO refresh the DURABLE per-job heartbeat (so a fresh liveness signal
       survives a restart and suppresses the persisted fireClaim re-fire) — but THROTTLED to at most one write
       per durableHeartbeatMs so the hot token stream never fsyncs on every delta. Guarded (only the CURRENT
       lease for this run renews; a stale/replaced lease is ignored) and never throws into the run's emit path. */
    function renewLease(jobId, runId) {
      const lease = leases.get(jobId);
      if (!lease || lease.runId !== runId) return;             // a sweep may have reclaimed+replaced this lease
      const at = now();
      lease.heartbeatAt = at;
      if (!lease.isOnce) return;                               // recurring jobs need no durable heartbeat (advance-before-run covers restart)
      // throttle the durable write: only persist once the last durable stamp is older than durableHeartbeatMs.
      if (lease.durableAt != null && (at - lease.durableAt) < durableHeartbeatMs) return;
      try {
        // A false receipt means the heartbeat never reached disk. Do not advance the throttle in that case:
        // the next progress event must retry instead of leaving restart recovery with a stale liveness stamp.
        if (setJobs(cronStore.renewOnceHeartbeat(getJobs(), jobId, { now: at })) !== false) lease.durableAt = at;
      } catch (e) { failNote('cron.heartbeat.persist', e); }
    }

    /* finishFire — record a fired run's outcome once it settles: markRun (the reducer owns the transient-backoff
       / one-shot-finalize math) → persist → cron.result → release the lease (only if it is still ours). */
    function finishFire(jobId, runId, state, threw) {
      const currentLease = leases.get(jobId);
      const pending = currentLease && currentLease.runId === runId ? currentLease.settlement : null;
      const at = pending ? pending.at : now();
      const reply = (state.buf || '').trim();
      const terminalReason = String(state.reason || '');
      const errMsg = state.errMsg
        || (threw ? ('run failed: ' + ((threw && threw.message) || threw)) : null)
        || (terminalReason === 'done' ? null : ('run ended without completion: ' + (terminalReason || 'missing terminal outcome')));
      const ok = !errMsg;
      const transient = !!(state.transient || (threw && threw.transient));
      // GENERATION FENCE (2026-07-15 reliability audit): only the run that STILL OWNS the job's lease may
      // settle its record. A run whose lease was reclaimed (the sweep declared it a zombie — and possibly
      // already launched a replacement) must NOT write markRun: its late settlement would overwrite the
      // replacement's fresher state (nextRunAt / retryCount / lastRunId — the "stale completion clobbers
      // the replacement" bug). The stale run still emits an honest cron.result (reason suffixed
      // 'stale-lease') so its outcome is observable, but the STORE belongs to the current lease holder.
      const lease = currentLease;
      const owned = !!(lease && lease.runId === runId);
      let committed = false;
      if (owned) {
        try {
          const next = cronStore.markRun(getJobs(), jobId, {
            runId: runId, status: ok ? 'ok' : 'error',
            reason: state.reason || (ok ? 'done' : 'error'),
            error: errMsg || undefined, transient: transient, output: ok ? reply : undefined, usd: state.usd || 0,
            monitorHash: ok ? state.monitorHash : undefined
          }, { now: at, maxConsecutiveFailures: maxConsecutiveFailures });
          committed = setJobs(next) !== false;
        } catch (_) { committed = false; }
        if (!committed) {
          // The run is over, but its outcome is not durable yet. Keep ownership and retry the SETTLEMENT on the
          // next tick; releasing the lease here lets a one-shot's still-persisted fireClaim age into a zombie and
          // execute the already-completed work again. Do not emit cron.result until its backing record exists.
          if (!lease.settlement) lease.settlement = { at: at, state: Object.assign({}, state), threw: threw || null };
          if (!lease.persistNotified) {
            lease.persistNotified = true;
            warn('[cron] settlement persist failed for ' + jobId + ' (' + runId + '); retaining lease and retrying');
          }
          return false;
        }
      }
      // job-level outcome: a FAILED run always reports (never silent); SILENT only on a clean, exactly-"[SILENT]" reply.
      const outcome = !ok ? 'failed' : (reply === SILENT_MARKER ? 'silent' : 'ok');
      let baseReason = state.reason || (errMsg ? 'error' : 'done');
      // AUTO-PAUSE telemetry: when THIS settlement tripped the consecutive-failure ceiling the job is now
      // disabled — say so on the governed reason string (the payload shape is unchanged; reason is free text).
      if (owned && committed) {
        const settled = cronStore.getJob(getJobs(), jobId);
        if (settled && settled.enabled === false && settled.disabledReason === 'consecutive-failures' && (settled.disabledAt === iso(at))) {
          baseReason = baseReason + ' (paused: consecutive-failures x' + settled.consecutiveFailures + ')';
        }
      }
      if (!owned || committed) try { emit('cron.result', { jobId: jobId, runId: runId, outcome: outcome, reason: owned ? baseReason : (baseReason + ' (stale-lease)') }); } catch (_) {}
      const continueAfterCommit = !(owned && committed && afterFinalizationCommitted && afterFinalizationCommitted(cronStore.getJob(getJobs(), jobId)) === false);
      if (owned && committed && continueAfterCommit) {
        const liveJob = cronStore.getJob(getJobs(), jobId) || { id: jobId };
        Promise.resolve(deliverFinalization(liveJob))
          .catch(function (e) { warn('[cron] result delivery failed for ' + jobId + ': ' + ((e && e.message) || e)); });
      }
      if (owned) leases.delete(jobId);   // a stale-lock sweep may have reclaimed+replaced it — never delete a successor's lease
    }

    /* fireJob — launch one due job through the run host. Returns true iff a run was actually launched (false on a
       no-capability skip). The run settles asynchronously; its lease is released in finishFire on EVERY terminal
       path (resolve or reject), so a throwing/zombie run never permanently wedges the job. */
    function fireJob(job, scheduledFor, nowMs) {
      // DELETED-AGENT GUARD (2026-07-16): a job whose agent no longer exists must not fire — before this,
      // an orphaned routine kept running forever after DELETE AGENT (real spend, ghost rail sessions and
      // floor crates under the dead agentId). The host's agentExists reads the durable roster (fail-open
      // on an empty roster, hero always passes), so a miss means the agent was genuinely deleted: REMOVE
      // the job durably instead of firing. Skip reason reuses the governed 'no-capability' enum value
      // (the cron.skipped enum is owned/closed; a gone agent has no capability to run as).
      if (agentExists && !agentExists(job.agentId)) {
        try { setJobs(cronStore.removeJob(getJobs(), job.id)); } catch (e) { failNote('cron.removeJob', e); }
        try { emit('cron.skipped', { jobId: job.id, reason: 'no-capability' }); } catch (_) {}
        return false;
      }
      /* INJECTION TRIPWIRE at FIRE time. Runs BEFORE the capability/credential gate so a payload never reaches
         the model or spends a cent. A block is recorded as a real FAILED result (markRun + cron.result) rather
         than a silent skip: the Commander must be able to see WHY a routine stopped producing, and the reason
         lands in job.lastError, which the ROUTINES row already renders. cron.result's `reason` is a free string
         in the owned event contract, so this needs no schema change. */
      let assembledPrompt = String(job.prompt || '');
      let upstreamContext = '';
      try {
        upstreamContext = String(contextFor(job, getJobs()) || '');
        if (upstreamContext) assembledPrompt = upstreamContext + '\n\n## ROUTINE DIRECTIVE\n' + assembledPrompt;
      } catch (e) {
        const blockedRunId = newId();
        const msg = 'context pipeline unavailable: ' + ((e && e.message) || e);
        try { setJobs(cronStore.markRun(getJobs(), job.id, { runId: blockedRunId, status: 'error', reason: 'context-error', error: msg, transient: false }, { now: nowMs })); } catch (e) { failNote('cron.markRun', e); }
        try { emit('cron.result', { jobId: job.id, runId: blockedRunId, outcome: 'failed', reason: 'context-error' }); } catch (_) {}
        return false;
      }
      {
        const scan = cronGuard.scanAssembled(assembledPrompt, {
          hasSkills: !!(job.skills && job.skills.length),
          hasInjectedData: !!(job.contextFrom && job.contextFrom.length)
        });
        if (!scan.ok) {
          const blockedRunId = newId();
          try {
            setJobs(cronStore.markRun(getJobs(), job.id, {
              runId: blockedRunId, status: 'error', reason: 'blocked', error: scan.error, transient: false
            }, { now: nowMs }));
          } catch (e) { failNote('cron.markRun', e); }
          try { emit('cron.result', { jobId: job.id, runId: blockedRunId, outcome: 'failed', reason: 'blocked: ' + scan.patternId }); } catch (_) {}
          return false;
        }
        // USE THE SANITIZED TEXT (bug-sweep 2026-08-28): scanAssembled's whole design is that invisible
        // unicode is STRIPPED rather than blocked — but every caller discarded `cleaned` and handed the model
        // the raw string, so a tag-block payload the scanner could no longer see still reached the model. The
        // sanitization was inert until this line.
        if (typeof scan.cleaned === 'string' && scan.cleaned) assembledPrompt = scan.cleaned;
      }
      const ident = identityForAgent(job.agentId, job) || {};
      const model = (job.model && String(job.model).trim()) || (ident.model && String(ident.model).trim()) || defaultModel;
      const provider = providerForJob(job, ident) || 'openrouter';
      const key = getKey(provider, job);
      let configIssue = null;
      if (!job.noAgent && !model) configIssue = { code: 'missing-model', reason: 'no model is configured; choose a model for this routine or its assigned agent' };
      else if (!job.noAgent && !hasCredential(provider, key, job)) configIssue = { code: 'missing-credential', reason: 'provider "' + provider + '" has no usable credential; connect it or choose a configured provider' };
      if (!configIssue && preflightConfig) {
        try {
          const checked = preflightConfig(job, { provider: provider, model: model, key: key, identity: ident });
          if (checked && checked.ok === false) configIssue = { code: String(checked.code || 'invalid-delivery'), reason: String(checked.reason || checked.error || 'routine delivery is not configured') };
        } catch (e) { configIssue = { code: 'config-check-error', reason: 'configuration could not be verified: ' + ((e && e.message) || e) }; }
      }
      if (configIssue) {
        const live = cronStore.getJob(getJobs(), job.id) || job;
        const fingerprint = String(hashText([configIssue.code, provider, model || '', String(job.deliver || 'local'), configIssue.reason].join('\n'))).slice(0, 200);
        const alreadyAlerted = !!(live.blockedConfig && live.blockedConfig.fingerprint === fingerprint && live.blockedConfig.alertedAt);
        let persisted = false;
        try {
          persisted = setJobs(cronStore.markBlockedConfig(getJobs(), job.id, {
            fingerprint: fingerprint, reason: configIssue.reason, alerted: !alreadyAlerted, retryAt: nowMs + blockedRetryMs
          }, { now: nowMs })) !== false;
        } catch (_) { persisted = false; }
        // One durable alert per unchanged fingerprint. No provider call and no delivery attempt occur on this path.
        if (persisted && !alreadyAlerted) try {
          emit('cron.result', { jobId: job.id, runId: newId(), outcome: 'failed', reason: 'blocked_config: ' + configIssue.reason });
        } catch (_) {}
        return false;
      }

      // Configuration recovered: clear the durable block before any spend. A failed receipt keeps the run closed.
      {
        const live = cronStore.getJob(getJobs(), job.id);
        if (live && (live.blockedConfig || live.state === 'blocked_config')) {
          let cleared = false;
          try { cleared = setJobs(cronStore.clearBlockedConfig(getJobs(), job.id)) !== false; } catch (_) { cleared = false; }
          if (!cleared) return false;
        }
      }

      let sourceHash = null;
      // A monitor can suppress only source bytes the host can observe before a model call. contextFrom is that
      // durable source; a prompt that tells the model to fetch a URL cannot be hashed without spending, so it is
      // deliberately not guessed/suppressed here.
      if (job.monitorMode === true && upstreamContext.trim()) {
        sourceHash = String(hashText(upstreamContext)).slice(0, 200);
        const live = cronStore.getJob(getJobs(), job.id) || job;
        if (live.monitorHash && live.monitorHash === sourceHash) {
          try { setJobs(cronStore.markMonitorCheck(getJobs(), job.id, {
            hash: sourceHash, commit: false, unchanged: true, retryAt: nowMs + blockedRetryMs
          }, { now: nowMs })); } catch (e) { failNote('cron.markMonitorCheck', e); }
          return false;
        }
      }

      const runId = newId();
      const ac = newAbort();
      // NS-0: heartbeatAt starts at the fire instant and is RENEWED on every run-progress event (see sink).
      // The lease sweep reclaims on a STALE heartbeat, not a fixed wall-clock age, so a genuinely-live long
      // run is never declared a zombie. isOnce marks whether to also persist a DURABLE heartbeat on the job
      // record (so a fresh heartbeat survives a restart and suppresses the one-shot fireClaim re-fire).
      const isOnce = !!(job.schedule && job.schedule.kind === 'once');
      leases.set(job.id, { runId: runId, startedAt: nowMs, heartbeatAt: nowMs, ac: ac, isOnce: isOnce });
      try { emit('cron.fire', { jobId: job.id, runId: runId, scheduledFor: scheduledFor }); } catch (_) {}
      // ride the routine's instruction onto the CONVEYOR as a box bound for this agent — only NOW (past the
      // capability gate, lease taken), so a crate appears on the floor iff a run is genuinely firing.
      try { placeWorkitem(job.agentId, assembledPrompt, runId); } catch (e) { failNote('cron.placeWorkitem', e); }

      // in-process emit sink: assemble the reply from agent.token deltas (the SAME contract harness.js/hub.js use —
      // there is no agent.message event), capture the end reason / error / transient flag off the RAW payload
      // (internal outcome bookkeeping stays whole), then FORWARD each event to the HUD through the SHARED tee
      // redaction so an unattended run is observable live in the SAME redacted shape a routed channel run ships
      // (tool_call name-only, tool_result outcome-only, metadata events whole; token deltas dropped to stay quiet,
      // and any event runTeeView maps to null — e.g. the noisy inner streams — is dropped rather than leaked raw).
      const state = { buf: '', errMsg: null, reason: null, transient: false, usd: 0, monitorHash: sourceHash };
      const sink = function (name, payload) {
        const p = payload || {};
        // NS-0 HEARTBEAT: every run-progress event proves this run is still alive → renew the in-RAM lease
        // heartbeat, and (throttled) persist a durable heartbeat on a one-shot job so a fresh liveness signal
        // survives a restart and suppresses the fireClaim zombie re-fire. Throttle keeps the hot token path
        // from persisting on every delta: only persist once the durable heartbeat is older than heartbeatMs.
        renewLease(job.id, runId);
        if (name === 'agent.token') { state.buf += (p.delta || ''); return; }   // token stream never leaves the driver
        if (name === 'agent.tool_call') state.buf = '';   // prior prose was narration; only the terminal segment is deliverable
        if (name === 'agent.run.error') { state.errMsg = p.message || 'run error'; state.transient = !!p.transient; }
        else if (name === 'capdenied') state.errMsg = state.errMsg || ('no ' + (p.need || 'capability') + ' — ' + (p.reason || ''));
        else if (name === 'agent.run.end') {
          state.reason = p.reason;
          // A duplicated terminal event must not erase an already-observed non-zero cost. Providers and
          // test/recovery hosts can both close a stream; cost is cumulative and therefore monotonic.
          if (typeof p.usd === 'number' && isFinite(p.usd)) state.usd = Math.max(state.usd, p.usd);
        }
        // forward only what the shared egress policy permits, in its redacted shape (B4). null -> not teed.
        const view = runTeeView(name, p);
        if (view) { try { emit(name, view); } catch (_) {} }
      };

      // the dock's standing brief rides the run's SYSTEM context — the SAME section header the hub's entry
      // runs use (hub.js), so a routine's agent is briefed exactly like a routed message's agent. Null-safe:
      // no seam / no floor / no brief composes the exact pre-brief system string.
      let dockBrief = null;
      if (stageBriefFor) { try { dockBrief = stageBriefFor(job.agentId); } catch (_) { dockBrief = null; } }
      const system = ((ident.system && String(ident.system)) || personaOf(job.agentId, job))
        + (dockBrief ? '\n\nYOUR STANDING BRIEF FOR THIS STATION:\n' + String(dockBrief).slice(0, 2000) : '');

      const messages = [{ role: 'user', content: assembledPrompt }];
      // launch the run SYNCHRONOUSLY (so the fire is ordered with the lease/cron.fire), but route both a
      // synchronous throw and an async rejection through the SAME terminal path so the lease always releases.
      let p;
      try {
        p = runOnce({
          key: key, model: model, system: system, messages: messages,
          agentId: job.agentId, isTask: true, emit: sink, signal: ac.signal,
          // streamId 'cron-'+runId makes this run's transcript durable under a per-RUN named stream (runId is a
          // fresh newId() already in scope — determinism-clean). Without it the reply is buffered into `state.buf`
          // and only an outcome enum escapes, so the actual work is invisible: it persists under the 'global'
          // stream no UI renders. A PER-RUN id (not per-job) keeps the run's message seed empty (index.js only
          // reconstructs a stream when messages<=1), so cron behavior is byte-identical — the frontend
          // autosessions module reads GET /api/transcript?stream=cron-<runId> to surface the output as a session.
          runId: runId, streamId: 'cron-' + runId, surface: 'autonomous', trigger: 'schedule', provider: provider,
          // Host-minted recovery identity. The active-run journal can now tie an interrupted headless run back
          // to the routine that launched it without trusting model text or guessing from the stream id.
          cronJobId: job.id, cronJobName: job.name || '',
          // SOP recipes: a routine minted from a recipe with acceptance rows carries the typed postconditions
          // contract in its meta bag; the host evaluates it at run end exactly as for an interactive launch.
          postconditions: (job.meta && job.meta.postconditions != null) ? job.meta.postconditions : undefined,
          // IDEMPOTENCY SCOPE: the same scheduled tick retried/resumed must not re-send a connector write, but the
          // NEXT tick of the same routine legitimately may — so the scope is job + scheduled fire time.
          idempotencyScope: 'cron:' + job.id + ':' + String(scheduledFor == null ? '' : scheduledFor),
          // a scheduled run does real work; what it learns is durable memory, not scratch. Bounded downstream by
          // the aux budget + per-agent reflection cooldown, and stamped origin:'schedule' (see index.js /api/run).
          reflect: true,
          // UNATTENDED CAPABILITY GRANT (2026-07-25): the terminal/verify approval the Commander recorded on THIS
          // routine, read straight off the durable job record. Empty on every routine that was not granted, so an
          // ungranted fire is byte-identical to the pre-grant behavior. Never sourced from the prompt.
          unattendedGrants: Array.isArray(job.unattendedGrants) ? job.unattendedGrants.slice() : [],
          preloadSkills: Array.isArray(job.skills) ? job.skills.slice() : [],
          requiredPreloads: true,
          cronScript: job.script || null,
          scriptTimeoutMs: job.scriptTimeoutMs,
          noAgent: job.noAgent === true,
          runsLine: job.runsLine === true,
          workdir: job.workdir || null,
          enabledToolsets: Array.isArray(job.enabledToolsets) ? job.enabledToolsets.slice() : null,
          initialTaint: !!(job.contextFrom && job.contextFrom.length),
          // provenance spine (R3 meta bag → durable run row): a routine minted from a recipe carries its recipeId,
          // so scheduled recipe runs are attributable exactly like hand-launched ones. undefined for plain routines.
          recipeId: (job.meta && job.meta.recipeId) || undefined,
          // per-bay capability isolation (B5): a bay-docked agent's routine runs with ITS room's objects,
          // never the default office — same contract as a routed channel message. undefined -> office.
          station: (resolveStation ? resolveStation(job.agentId) : null) || undefined
        });
      } catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(
        function () {
          // The line advances ONLY on a COMPLETED entry run. finishFire treats any terminal reason other
          // than 'done' as failure, yet this gate let a truncated run (max_turns/budget/missing terminal —
          // none of which set errMsg) buy every downstream hop on partial stage-one material, then recorded
          // the routine as failed anyway. The reason check closes that split verdict.
          if (!advanceChain || state.errMsg || state.reason !== 'done' || !String(state.buf || '').trim()) { finishFire(job.id, runId, state, null); return; }
          // hops ride the ROUTINE'S OWN stream so its session reads as one multi-stage job, and each hop renews
          // the lease — a line that outran the heartbeat would be declared a zombie and re-fired mid-work.
          Promise.resolve(advanceChain({
            agentId: job.agentId, text: state.buf, originalText: String(job.prompt || ''),
            signal: ac.signal, streamId: 'cron-' + runId, key: key, model: model, provider: provider,
            // the entry run's reconciled spend: the chain's $ ceiling covers the WHOLE line, stage one
            // included (2026-08-10 audit — the entry run rode outside its own line's cap on every path).
            entryUsd: state.usd,
            /* ONLY A ROUTINE THAT BELONGS TO A LINE RUNS THE LINE (Andrew's ruling, 2026-08-07). Read straight
               off the durable job record — true only for a routine created from a line's own INBOX trigger
               zone. The seam (index.js) turns it into the lineId the chain gate needs; false/absent means the
               seam passes none and every dock downstream is terminal, so a routine that predates the workflow
               keeps buying exactly ONE run. Never inferred from the dock: that is what made a months-old
               routine start spending three runs the moment its agent was crewed onto a line. */
            runsLine: job.runsLine === true,
            // skills/workdir/toolsets are the ROUTINE's configuration, deliberately kept on downstream hops for
            // now so multi-stage routines keep working (flagged 2026-08-04: applying a foreign agent's workdir/
            // toolsets to a hop is a misdirection risk — revisit under the narrower-fallback law).
            preloadSkills: Array.isArray(job.skills) ? job.skills.slice() : [], requiredPreloads: true, workdir: job.workdir || null,
            enabledToolsets: Array.isArray(job.enabledToolsets) ? job.enabledToolsets.slice() : null,
            initialTaint: !!(job.contextFrom && job.contextFrom.length),
            /* GRANTS NEVER FLOW DOWN A LINE (2026-08-04). The unattended terminal/verify grant the Commander
               recorded is an approval of ONE agent — this routine's own dock, which already ran above with
               job.unattendedGrants. A belt drawn to another dock must not silently extend that approval to a
               different agent (capability may never silently widen; the fallback direction is NARROWER). A
               downstream hop that needed a grant fails honestly under the existing chain law: last good
               output + stop note. */
            unattendedGrants: [],
            onHop: function () { renewLease(job.id, runId); }
          })).then(
            function (line) { if (line && String(line.text || '').trim()) state.buf = line.text; if (line && typeof line.usd === 'number' && isFinite(line.usd)) state.usd += line.usd; finishFire(job.id, runId, state, null); },
            // A CHAIN FAILURE NEVER CHANGES THE ROUTINE'S OUTCOME: stage one really did run and really did
            // produce work. Same law the channel path holds — the line is never a gate on the answer.
            // It is still SAID OUT LOUD: a silently swallowed chain error is indistinguishable from a floor
            // with no downstream stage, and that is exactly how this shipped broken once already.
            function (e) { warn('[cron] work line failed after ' + job.agentId + ': ' + ((e && e.message) || e)); finishFire(job.id, runId, state, null); }
          );
        },
        function (e) { finishFire(job.id, runId, state, e || new Error('run rejected')); }
      );
      return true;
    }

    /* applyTick — ONE scheduler pass over the live store at wall-clock `nowMs`. Synchronous: it launches the due
       runs (their completions settle later via finishFire) and returns a small summary. The host wraps the call
       in try/catch, but the body also guards each emit so a single bad payload never aborts the pass. */
    function applyTick(nowMs) {
      nowMs = nowMs || now();
      // G4.3: re-entrant tick at the same instant is a no-op (see tickInFlight above). The guard wraps
      // the WHOLE pass — set on entry, cleared in a finally so a thrown plan/emit never wedges the flag.
      if (tickInFlight) return { fired: 0, skipped: 0, planned: 0, deferred: [], reentered: true };
      tickInFlight = true;
      try {
        return applyTickInner(nowMs);
      } finally {
        tickInFlight = false;
      }
    }

    function applyTickInner(nowMs) {
      let skips = 0, fires = 0;

      // Retry completed-but-not-yet-durable outcomes before planning new work. These leases are settlement
      // receipts, not live processes: they must never enter the stale-run reclaim path and re-execute the job.
      for (const entry of Array.from(leases.entries())) {
        const jobId = entry[0], lease = entry[1];
        if (!lease || !lease.settlement) continue;
        const settlement = lease.settlement;
        finishFire(jobId, lease.runId, settlement.state, settlement.threw);
      }

      // 1. SELF-HEALING LEASE (NS-0 heartbeat-based): reclaim a run ONLY when its HEARTBEAT is stale — i.e. it
      //    stopped proving liveness (crashed / the emit stream died), not merely because it is taking a long
      //    time. A genuinely-live long run keeps renewing lease.heartbeatAt on every progress event, so it is
      //    NEVER reclaimed and fires exactly once regardless of duration (the duplicate-fire fix). A run that
      //    emits NOTHING still holds startedAt as its initial heartbeat, so a hung run with no output is
      //    reclaimed after heartbeatStaleMs (>= the old maxRunMs by default) rather than the old fixed ceiling.
      for (const entry of leases) {
        const jobId = entry[0], lease = entry[1];
        if (lease.settlement) continue;
        const beatAge = nowMs - (lease.heartbeatAt != null ? lease.heartbeatAt : lease.startedAt);
        if (beatAge > heartbeatStaleMs) {
          try { lease.ac.abort(); } catch (_) {}
          leases.delete(jobId);
          /* A RECLAIM IS A REAL OUTCOME (bug-sweep 2026-08-28): the aborted run's late finishFire is UNOWNED
             (generation fence) and never writes markRun — so before this, a reclaimed ONE-SHOT kept its
             persisted fireClaim + null lastRunAt and re-executed the work every ~maxRunMs FOREVER (real spend
             per cycle), and a reliably-hanging recurring routine never advanced consecutiveFailures toward
             the auto-disable ceiling built for exactly that case. Record the reclaim as a TRANSIENT failure:
             markRun clears the claim/heartbeat, re-arms via the bounded backoff, and the retry ceiling turns
             a permanent hang into a terminal, visible failure. The unowned settle still emits its honest
             cron.result{(stale-lease)} when the aborted run winds down — no double event here. */
          try {
            setJobs(cronStore.markRun(getJobs(), jobId, {
              runId: lease.runId, status: 'error', reason: 'stale-lock-reclaimed',
              error: 'run reclaimed: no progress for ' + Math.round(heartbeatStaleMs / 1000) + 's', transient: true
            }, { now: nowMs, defaultTz: defaultTz, maxConsecutiveFailures: maxConsecutiveFailures }));
          } catch (e) { failNote('cron.markRun', e); }
          try { emit('cron.skipped', { jobId: jobId, reason: 'stale-lock-reclaimed' }); } catch (_) {}
          skips++;
        }
      }

      // 1b. NS-0 DISABLED-DUE TELEMETRY: planTick silently ignores disabled jobs (no fire, no skip entry), so a
      //     PAUSED routine whose scheduled time has arrived left NO trace — the autonomy decision "did not act
      //     because paused" was invisible. Emit cron.skipped{disabled} for a disabled job whose nextRunAt is in
      //     the PAST (it WOULD have been due), AT MOST ONCE per due window (deduped by jobId+nextRunAt) so a
      //     permanently-paused job doesn't spam every tick. The window key changes if the job is re-armed/edited.
      {
        const seen = new Set();
        for (const job of (getJobs() || [])) {
          if (!job || !job.id) continue;
          seen.add(job.id);
          if (job.enabled === false && job.nextRunAt) {
            const dueMs = Date.parse(job.nextRunAt);
            if (!isNaN(dueMs) && dueMs <= nowMs) {
              const key = String(dueMs);
              if (disabledNotified.get(job.id) !== key) {
                disabledNotified.set(job.id, key);
                try { emit('cron.skipped', { jobId: job.id, reason: 'disabled' }); } catch (_) {}
                skips++;
              }
              continue;
            }
          }
          disabledNotified.delete(job.id);                 // no longer disabled-and-due -> reset its window
        }
        // prune dedupe entries for jobs that vanished (removed) so the map can't grow unbounded over a long run.
        for (const id of Array.from(disabledNotified.keys())) if (!seen.has(id)) disabledNotified.delete(id);
      }

      // 1c. MALFORMED-SCHEDULE VISIBILITY: planTick silently ignores a job whose schedule can never fire, so a
      //     routine with a corrupt/unknown schedule kind looked merely "idle" forever. Mark it ONCE (the durable
      //     lastError sentinel is the dedup key — markUnfireable returns the same array when already marked)
      //     and emit ONE cron.result{failed, schedule-unfireable} on the marking transition only.
      {
        const before = getJobs();
        for (const job of before.slice()) {
          if (!job || job.enabled === false || cron.isFireable(job.schedule)) continue;
          if (job.lastError === cronStore.UNFIREABLE_ERROR) continue;
          let marked = false;
          try { const next = cronStore.markUnfireable(getJobs(), job.id, { now: nowMs }); marked = next !== getJobs() && setJobs(next) !== false; }
          catch (e) { failNote('cron.markUnfireable', e); }
          if (marked) try { emit('cron.result', { jobId: job.id, runId: newId(), outcome: 'failed', reason: cronStore.UNFIREABLE_ERROR }); } catch (e) { failNote('cron.unfireable.emit', e); }
        }
      }

      // 2. the PURE plan: which jobs fire / are fast-forward-skipped, and the advanced next-fires to persist.
      //    defaultTz makes a tz-less schedule plan on the host's local wall-clock (G4.1). maxRunMs is the
      //    one-shot fire-claim ceiling (G4.5): planTick suppresses a one-shot with a FRESH claim (in flight)
      //    and reclaims a ZOMBIE claim past this age — the SAME ceiling the lease sweep above uses.
      const plan = cron.planTick(getJobs(), nowMs, { defaultTz: defaultTz, maxRunMs: maxRunMs, heartbeatStaleMs: heartbeatStaleMs });
      // Under a cap, oldest due work gets the next slot. Store order lets a recurring job
      // become due again and repeatedly overtake deferred jobs at the end of the array.
      // scheduledFor survives restart; stable ties preserve the existing order.
      if (maxParallel > 0) plan.fire.sort((a, b) => a.scheduledFor - b.scheduledFor);

      // 2b. GLOBAL CONCURRENCY CAP (G4.4): partition plan.fire into the jobs we'll ATTEMPT this tick and the
      //     ones DEFERRED past the cap. A job already holding a lease is neither attempted nor deferred — it
      //     advances + reports already-running below exactly as before (drop the occurrence, never re-queue).
      //     Slots = maxParallel - currently-in-flight; reserve one per attempt in plan order. A deferred job is
      //     NOT advanced (step 3 skips it), so its nextRunAt stays put and it remains DUE next tick — it drains
      //     when a slot frees. NS-0: the at-capacity deferral is now EMITTED as cron.skipped{at-capacity} (the
      //     reason value was added to the governed enum in shared/events.js) AND surfaced on the return value +
      //     the cron.tick.deferred count, so a night of quietly-deferred routines is finally observable.
      // Only LIVE runs occupy a slot: a settlement receipt is a FINISHED run awaiting a durable write, not
      // in-flight spend — counting it starved every routine behind a stuck persist (maxParallel=1 froze the
      // whole station on one read-only-disk settlement).
      let liveLeases = 0;
      for (const l of leases.values()) if (!l.settlement) liveLeases++;
      let slotsLeft = maxParallel > 0 ? maxParallel - liveLeases : Infinity;
      const deferred = [];
      const deferredSet = new Set();
      for (const f of plan.fire) {
        const job = cronStore.getJob(getJobs(), f.jobId);
        if (!job) continue;
        if (leases.has(job.id)) continue;                  // already-running: not attempted, not deferred (advances)
        if (slotsLeft > 0) { slotsLeft--; }                // reserve a concurrency slot for this attempt
        else {                                             // over the cap -> defer (stays due, not advanced)
          deferred.push(job.id); deferredSet.add(job.id);
          try { emit('cron.skipped', { jobId: job.id, reason: 'at-capacity' }); } catch (_) {}
          skips++;
        }
      }

      // 3. ADVANCE-BEFORE-RUN: persist the advanced nextRunAt for every planned RECURRING job EXCEPT a
      //    deferred one, BEFORE launching, so a crash mid-run never double-fires on restart. A fire later
      //    skipped by its lease still keeps this advance (drop the occurrence, never re-queue it); a DEFERRED
      //    job keeps its OLD nextRunAt so it stays due and fires on a later tick when a concurrency slot frees.
      //
      //    G4.5 ONE-SHOT FIRE-CLAIM: a one-shot has no advanced nextRunAt to persist (it doesn't recur), so its
      //    crash-restart protection is a fire-CLAIM stamped here and persisted in the SAME write, BEFORE launch.
      //    cron.planTick then suppresses a one-shot carrying a fresh claim (in flight) and reclaims a zombie one
      //    past maxRunMs. A deferred or already-leased one-shot is NOT claimed this tick (it isn't firing yet).
      {
        const advanceById = Object.create(null);
        for (const nx of plan.next) { if (!deferredSet.has(nx.jobId)) advanceById[nx.jobId] = nx.nextAt; }
        // which one-shots will actually fire this tick (in plan.fire, not deferred, not already leased)?
        const claimOnce = new Set();
        for (const f of plan.fire) {
          if (deferredSet.has(f.jobId) || leases.has(f.jobId)) continue;
          const job = cronStore.getJob(getJobs(), f.jobId);
          if (job && job.schedule && job.schedule.kind === 'once') claimOnce.add(f.jobId);
        }
        // NOTE: a one-shot that turns out NO-CAPABILITY in step 5 (fireJob returns false → no run launched)
        // still carries this claim. That is intentional and safe: it converts per-tick re-attempts into a
        // bounded ~maxRunMs backoff, after which the zombie reclaim retries — a non-firing one-shot either way.
        if (Object.keys(advanceById).length || claimOnce.size) {
          let jobs = getJobs();
          for (const id in advanceById) {
            jobs = jobs.map(function (j) { return (j && j.id === id) ? Object.assign({}, j, { nextRunAt: iso(advanceById[id]) }) : j; });
          }
          // stamp + persist the one-shot fire-claim through the store reducer (keeps the claim shape in one place).
          for (const id of claimOnce) { jobs = cronStore.claimOnceFire(jobs, id, { now: nowMs }); }
          // TRANSACTIONAL DISPATCH (2026-07-15 reliability audit): a launch is CONDITIONAL on a verified
          // durable advance/claim. setJobs returns false when the persist did NOT reach disk (the host also
          // rolls its mirror back to the disk state so the jobs stay DUE); a void/true return means persisted
          // (back-compat: test hosts with a plain assigning setJobs keep working). On a failed receipt we
          // fire NOTHING this tick — every planned fire is deferred and retried next tick, because launching
          // over an unpersisted advance is exactly the crash-restart double-fire window this write closes.
          const receipt = setJobs(jobs);
          if (receipt === false) {
            for (const f of plan.fire) {
              if (deferredSet.has(f.jobId)) continue;
              deferredSet.add(f.jobId); deferred.push(f.jobId);
            }
            try { emit('cron.tick', { fired: 0, skipped: skips, planned: plan.fire.length, deferred: deferred.length }); } catch (_) {}
            return { fired: 0, skipped: skips, planned: plan.fire.length, deferred: deferred, unpersisted: true };
          }
        }
      }

      // 4. stale recurring runs that were fast-forwarded (no backlog burst) -> a structured skip per job.
      for (const sk of plan.skipped) { try { emit('cron.skipped', { jobId: sk.jobId, reason: sk.reason }); } catch (_) {} skips++; }

      // 5. fire each due job — lease-guarded (one in-flight per job), CAP-guarded, and capability-guarded.
      for (const f of plan.fire) {
        const job = cronStore.getJob(getJobs(), f.jobId);
        if (!job) continue;
        if (leases.has(job.id)) { try { emit('cron.skipped', { jobId: job.id, reason: 'already-running' }); } catch (_) {} skips++; continue; }
        if (deferredSet.has(job.id)) continue;             // over the cap: held back (counted in `deferred`), skip already emitted in step 2b
        try {
          if (fireJob(job, f.scheduledFor, nowMs)) fires++; else skips++;   // false = no-capability (already emitted)
        } catch (e) {
          /* ONE JOB'S THROW MUST NOT ABORT THE TICK (bug-sweep 2026-08-28): step 3 already persisted EVERY
             planned job's advance, so a throw here (an unguarded injected dep — identity/persona/provider —
             hitting a corrupt record) silently ATE the remaining jobs' occurrences; a deterministic throw
             starved them forever while the panel showed them merrily advancing. Contain it to THIS job:
             release the lease this fire may have taken (its settlement path was never attached, so it would
             sit orphaned until the sweep), record an honest TRANSIENT failure (bounded backoff + retry,
             terminal after maxRetries → counts toward auto-disable), and keep firing the rest. */
          failNote('cron.fireJob', e);
          const orphan = leases.get(job.id);
          const failRunId = orphan ? orphan.runId : newId();
          if (orphan) { try { orphan.ac.abort(); } catch (_) {} leases.delete(job.id); }
          try {
            setJobs(cronStore.markRun(getJobs(), job.id, {
              runId: failRunId, status: 'error', reason: 'fire-error',
              error: 'fire failed: ' + ((e && e.message) || e), transient: true
            }, { now: nowMs, defaultTz: defaultTz, maxConsecutiveFailures: maxConsecutiveFailures }));
          } catch (e2) { failNote('cron.markRun', e2); }
          try { emit('cron.result', { jobId: job.id, runId: failRunId, outcome: 'failed', reason: 'fire-error' }); } catch (_) {}
          skips++;
        }
      }

      // 6. the war-room pulse — emitted ONLY when something happened, so an idle/empty-store tick stays silent
      //    (the no-op invariant: an empty schedule incurs no event, no console line, no cost). A tick that only
      //    DEFERRED or only reported a DISABLED-due job still pulses (skips covers those). NS-0: the additive
      //    `deferred` count now rides the pulse (added to the cron.tick schema) so the deferral is observable.
      if (fires || skips || plan.fire.length) {
        try { emit('cron.tick', { fired: fires, skipped: skips, planned: plan.fire.length, deferred: deferred.length }); } catch (_) {}
      }
      return { fired: fires, skipped: skips, planned: plan.fire.length, deferred: deferred };
    }

    /* abortAllLeases — the E-STOP hook: abort every in-flight cron run's AbortController so a HALT stops
       unattended cron spend too. Each aborted run settles through finishFire, which releases its own lease,
       so we do not delete leases here (double-delete-safe either way). Never throws. Returns the count. */
    function abortAllLeases() {
      let n = 0;
      for (const lease of leases.values()) {
        try { if (lease && lease.ac && typeof lease.ac.abort === 'function') { lease.ac.abort(); n++; } }
        catch (_) { /* an E-STOP must not throw */ }
      }
      return n;
    }

    return { applyTick: applyTick, leases: leases, abortAllLeases: abortAllLeases, recoverFinalizations: recoverFinalizations,
      _internals: { fireJob: fireJob, finishFire: finishFire, deliverFinalization: deliverFinalization } };
  }

  return { makeCronDriver: makeCronDriver, SILENT_MARKER: SILENT_MARKER };
});
