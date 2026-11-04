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
     deps.wireForJob(job)  -> { model, provider, reasoningEffort, followsStation, source }
                                                 // OPTIONAL: the host's ONE {provider, model} resolution for this
                                                 //   routine (index.js cronWireFor -> sidecar/run-wire.js). When
                                                 //   injected it decides the pair and effort, and providerForJob /
                                                 //   identityForAgent's model / defaultModel are not consulted for them.
     deps.hasCredential(provider, key, job)
                           -> bool               // OAuth providers can be runnable without a BYOK key
     deps.credentialError(provider, job)
                           -> string             // the station's ONE no-credential sentence (index.js engineCredentialError)
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
     deps.deliveryNoteFor  -> (job) -> string    // OPTIONAL: appended to the entry run's system when its reply goes
                                                 //   to a chat (how to ATTACH files). PROMPT TEXT ONLY.
     deps.deliveryStarted(jobId, runId) -> bool  // OPTIONAL: something of this run's result has gone out (its chat lane
                                                 //   sends the rest, channels/delivery-ledger.js): it is busy for the
                                                 //   supersede, and a pause holds only results not started yet
     deps.deliveryWithdrawn(jobId, runId) -> void // OPTIONAL: this run's result was superseded or re-counted before anything
                                                 //   of it went: what the host queued for it goes (a re-counted result is
                                                 //   asked again in its turn, with its new count)
     deps.deliveryRecorded(jobId, runId, out) -> void  // OPTIONAL: this run's markDelivery (out) is on disk; what the host
                                                 //   kept for the re-ask of the targets it names may go (index.js
                                                 //   routine-delivery.js deliveryRecorded)
     deps.placeWorkitem(agentId, prompt, runId, dockId, { byFire })
                           -> void               // OPTIONAL: ride the routine's instruction onto the CONVEYOR as a
                                                 //   box bound for its agent (the SAME workitem.placed plumbing a
                                                 //   Telegram message uses) so a scheduled fire is VISIBLE on the
                                                 //   floor — a crate arrives and the agent goes to work. Injected
                                                 //   (the ambient id-mint + emit live in index.js), so this file
                                                 //   stays determinism-clean. No-op when not provided.
     deps.settleWorkitem(runId, reason)
                           -> void               // OPTIONAL: settle that crate once the FIRE has settled (finishFire, its
                                                 //   work line included): reason 'done' (delivered to the OUTBOX) only for a
                                                 //   fire whose outcome is succeeded AND whose line delivered the whole job
                                                 //   (fireOutcome .delivered), else the outcome (a held line, a cut reply, a
                                                 //   raised error) or 'line_stopped' (a line that stopped short or joined
                                                 //   partial) — each drains the slot. When provided, the crate is
                                                 //   placed with { byFire: true } so the host leaves it to the fire
                                                 //   (never settles it at the entry run's end). No-op when not provided. */
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
  // plain words for an unclean end ("the model sent back an empty reply…"), the machine reason kept in brackets
  const incompleteRunMessage = (typeof require === 'function') ? require('./stop-reason.js').incompleteRunMessage : (r) => 'run ended without completion: ' + (r || 'missing terminal outcome');
  // TYPED OUTCOMES: how a fire ended, read through the ONE resolver every surface shares (frontend/app/runoutcome.js)
  const RunOutcome = (typeof require === 'function') ? require('../frontend/app/runoutcome.js') : ((typeof globalThis !== 'undefined' && globalThis.RunOutcome) || null);
  // WHO a routine run is (routine id + name, recipe, fire-time idempotency scope) — one definition for this tick and Run Now
  const routineRunIdentity = (typeof require === 'function') ? require('./routine-identity.js').routineRunIdentity
    : function (job, at) { return { cronJobId: job.id, cronJobName: job.name || '', idempotencyScope: 'cron:' + job.id + ':' + String(at == null ? '' : at), recipeId: (job.meta && job.meta.recipeId) || undefined }; };
  const { note: failNote } = (typeof require === 'function') ? require('./failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };
  // what a finished work line leaves on the fire: its answer + stop note, its spend, its stop facts (routing/line-fire.js)
  const foldLineIntoFire = (typeof require === 'function') ? require('./routing/line-fire.js').foldLineIntoFire
    : function (state, line) { if (line && String(line.text || '').trim()) state.buf = line.text; if (line && typeof line.usd === 'number' && isFinite(line.usd)) state.usd += line.usd; return state; };
  const lineFacts = (typeof require === 'function') ? require('./routing/line-fire.js').lineFacts : line => line;
  // the fire's CRATE rides to the OUTBOX only when its work line delivered the whole job (routing/line-fire.js lineDelivered)
  const lineDelivered = (typeof require === 'function') ? require('./routing/line-fire.js').lineDelivered
    : function (line) { return !line || typeof line !== 'object' || (!line.stopped && !line.partial); };

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
  // #89: the ONE no-credential sentence builder (pure); index.js injects the registry-aware form as deps.credentialError
  const engineCredential = (typeof require === 'function') ? require('./engine-credential.js') : (root.SK && root.SK.engineCredential);
  // one run's reply, joined the way every reply sink joins it (a steering echo reads '↪ <note>', never the raw marker). Pure.
  const replyAssembler = (typeof require === 'function') ? require('./reply-assembler.js') : (root.SK && root.SK.replyAssembler);

  function makeCronDriver(deps) {
    const d = deps || {};
    const getJobs = d.getJobs, setJobs = d.setJobs, runOnce = d.runOnce;
    const emit = typeof d.emit === 'function' ? d.emit : function () {};
    // a place to say something went wrong without changing behaviour (injectable so tests stay quiet)
    const warn = typeof d.warn === 'function' ? d.warn : function (m) { try { console.warn(m); } catch (_) {} };
    const newId = d.newId, newAbort = d.newAbort, now = d.now;
    const getKey = typeof d.getKey === 'function' ? d.getKey : function () { return ''; };
    const providerForJob = typeof d.providerForJob === 'function' ? d.providerForJob : function () { return 'openrouter'; };
    const wireForJob = typeof d.wireForJob === 'function' ? d.wireForJob : null;
    const hasCredential = typeof d.hasCredential === 'function' ? d.hasCredential : function (_provider, key) { return !!key; };
    // #89: the blocked-config reason is the SAME sentence Run Now and the quest refresh say (index.js injects the
    // registry-aware form); a host that injects nothing gets the same builder with only the provider id
    const credentialError = typeof d.credentialError === 'function' ? d.credentialError
      : function (provider) { return engineCredential.credentialError({ id: provider, what: 'this scheduled routine' }); };
    const defaultModel = d.defaultModel || '';
    const identityForAgent = typeof d.identityForAgent === 'function' ? d.identityForAgent : function () { return null; };
    const agentExists = typeof d.agentExists === 'function' ? d.agentExists : null;
    // persona may be a STRING (the autonomous system prompt) or a GETTER that returns it fresh each fire
    // (Phase C: index.js passes a getter so each run folds in the live Commander dossier). Both stay
    // determinism-clean — a getter is just an injected dep, exactly like getKey/getJobs.
    const personaOf = typeof d.persona === 'function' ? d.persona : function () { return d.persona || ''; };
    const placeWorkitem = typeof d.placeWorkitem === 'function' ? d.placeWorkitem : function () {};
    const settleWorkitem = typeof d.settleWorkitem === 'function' ? d.settleWorkitem : null;
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
    // CHAT DELIVERY NOTE (2026-10-18): deliveryNoteFor(job) -> the paragraph that tells a chat-bound routine how to
    // attach a file to the reply the station delivers (index.js cronDeliveryNote), '' for a routine that stays on the
    // station. PROMPT TEXT ONLY; absent or '' -> the exact pre-note system string.
    const deliveryNoteFor = typeof d.deliveryNoteFor === 'function' ? d.deliveryNoteFor : null;
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
    // WALL-CLOCK CEILING (routine reliability, 2026-10-01): the heartbeat lease above never reclaims a run that
    // keeps emitting — the right call for a long honest run, and the wrong one for a run stuck in a chatty loop
    // (it renews its heartbeat forever, holds the job's one-run lock, and every later occurrence is skipped).
    // maxWallMs is the outer bound: a routine run older than this is stopped and recorded as a TERMINAL failure
    // for this occurrence (not transient — retrying a runaway re-runs the runaway), which also advances the
    // consecutive-failure ceiling. Injected int; 0 = off.
    const maxWallMs = (function () { const n = parseInt(d.maxWallMs, 10); return (Number.isFinite(n) && n > 0) ? n : 0; })();
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
    /* A RESULT WHOSE DELIVERY HAS STARTED (channel-delivery-ledger S4). The host's delivery ledger drives a result to the
       end, part by part, whatever this driver does next, once a part of it landed. So such a result is BUSY for the
       supersede (it is on the wire: dropping its receipt would send it anyway, and a count a newer one took from it could
       never be said), and a PAUSE holds only results not started yet (a started one finishes; its outcome is still
       recorded). A result the host queued but has not started is not busy: a chat that refuses from the first part still
       gets one current result, not a burst, and deliveryWithdrawn takes back what the collapse dropped or re-counted.
       Absent: the in-memory maps alone, as before. */
    const deliveryStarted = typeof d.deliveryStarted === 'function' ? d.deliveryStarted : null;
    const deliveryWithdrawn = typeof d.deliveryWithdrawn === 'function' ? d.deliveryWithdrawn : null;
    const deliveryRecorded = typeof d.deliveryRecorded === 'function' ? d.deliveryRecorded : null;
    function started(jobId, runId) {
      if (!deliveryStarted) return false;
      try { return deliveryStarted(jobId, runId) === true; } catch (e) { failNote('cron.delivery.started', e); return false; }
    }
    const preflightConfig = typeof d.preflightConfig === 'function' ? d.preflightConfig : null;
    const hashText = typeof d.hashText === 'function' ? d.hashText : function (s) { return String(s == null ? '' : s); };
    const blockedRetryMs = (function () { const n = parseInt(d.blockedRetryMs, 10); return Number.isFinite(n) && n > 0 ? n : 60000; })();
    // Fault-injection seam: false models a process stop after the final receipt is durable, before delivery.
    const afterFinalizationCommitted = typeof d.afterFinalizationCommitted === 'function' ? d.afterFinalizationCommitted : null;
    if (typeof getJobs !== 'function' || typeof setJobs !== 'function') throw new Error('cron-driver: getJobs/setJobs are required');
    if (typeof runOnce !== 'function') throw new Error('cron-driver: runOnce is required');
    if (typeof newId !== 'function' || typeof newAbort !== 'function' || typeof now !== 'function') throw new Error('cron-driver: newId/newAbort/now are required');

    const leases = new Map();   // jobId -> { runId, startedAt, heartbeatAt, ac, isOnce, durableAt } — one-run-per-job in-flight lock
    /* runIds whose OWNED settlement already committed + emitted cron.result (bounded, oldest evicted). A reclaim
       (stale-lease sweep, a contained fireJob throw) settles the run ON ITS OWNER'S BEHALF; the aborted host's late
       finishFire then arrives UNOWNED for the same runId and used to emit a SECOND cron.result{(stale-lease)} —
       one run, two outcomes on the bus. One runId reports once. */
    const settledRunIds = new Set();
    const SETTLED_RUN_IDS_MAX = 256;
    function noteSettled(runId) {
      if (runId == null) return;
      settledRunIds.add(String(runId));
      while (settledRunIds.size > SETTLED_RUN_IDS_MAX) settledRunIds.delete(settledRunIds.values().next().value);
    }
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

    const deliveries = new Map(); // job/run -> one in-flight send across boot, ticks and completion
    const deliveryReceipts = new Map(); // send finished but its acknowledgement has not reached disk
    let publicationReleaseCursor = 0; // fairness only; every attempt still reads the current durable receipt
    async function releasePublication(job, f) {
      if (!deliveryRecorded) return false;
      const out = { ok: true, deliveredTargets: f.deliveredTargets || [], givenUpTargets: f.givenUpTargets || [], historyPublications: f.historyPublications };
      try {
        if (await deliveryRecorded(job.id, f.runId, out) !== true) return false;
        return setJobs(cronStore.markPublicationReleased(getJobs(), job.id, { runId: f.runId, historyPublications: f.historyPublications })) !== false;
      } catch (e) { failNote('cron.delivery.publication-release', e); return false; }
    }
    /* collapseBacklog — the routine's older idle results for a destination are superseded by its newest one
       (cron-store supersedeDeliveries: one current result per chat, never a burst of stale ones). `own` is the run
       id the caller is about to send — it is in `deliveries` already but is not "busy" for this decision, unless the
       host's delivery has started it (then it is on the wire like any started result). What the host queued for a result
       this drops or re-counts goes first: its words are stale, and if the write below fails the next ask queues them
       again, nothing having been sent. Returns false only when the supersede could not reach disk (the caller retries on
       a later pass, sending nothing). */
    function collapseBacklog(jobId, own) {
      const jobs = getJobs();
      const before = cronStore.pendingDeliveries(cronStore.getJob(jobs, jobId));
      const busy = before.map(p => String(p.runId))
        .filter(r => (r !== String(own) && (deliveries.has(jobId + '/' + r) || deliveryReceipts.has(jobId + '/' + r))) || started(jobId, r));
      const next = cronStore.supersedeDeliveries(jobs, jobId, { now: now(), busy: busy });
      if (next === jobs) return true;
      if (deliveryWithdrawn) {
        const after = new Map(cronStore.pendingDeliveries(cronStore.getJob(next, jobId)).map(p => [String(p.runId), Number(p.superseded) || 0]));
        for (const p of before) {
          if (after.get(String(p.runId)) === (Number(p.superseded) || 0)) continue;
          try { deliveryWithdrawn(jobId, String(p.runId)); } catch (e) { failNote('cron.delivery.withdrawn', e); }
        }
      }
      return setJobs(next) !== false;
    }
    async function deliverFinalization(job, receipt) {
      const f = receipt || (job && job.finalization);
      if (!job || !f || f.state !== 'pending') return false;
      const key = job.id + '/' + f.runId;
      if (deliveries.has(key)) return false;
      if (!deliveryReceipts.has(key) && Date.parse(f.nextAttemptAt) > now()) return false;
      deliveries.set(key, true);
      try {
        let current = cronStore.getJob(getJobs(), job.id);
        if (!cronStore.pendingDeliveries(current).some(p => p.runId === f.runId)) {
          deliveryReceipts.delete(key); return false;
        }
        let out = deliveryReceipts.get(key);
        if (!out) {
          // paused by the Commander: kept until resumed — but a RUN NOW pressed on the paused routine goes out (its receipt,
          // review 7.1), and so does one whose delivery already started (it finishes; its outcome is recorded); nothing
          // collapses while the routine is paused
          const held = cronStore.deliveriesHeld(current);
          if (cronStore.deliveriesHeld(current, cronStore.pendingDeliveries(current).find(p => p.runId === f.runId)) && !started(job.id, f.runId)) return false;
          // Nothing awaits before this point, so a pass that picked several receipts of one routine settles the
          // collapse here, synchronously, before any of them sends.
          if (!held && !collapseBacklog(job.id, f.runId)) return false;
          current = cronStore.getJob(getJobs(), job.id);
          const live = cronStore.pendingDeliveries(current).find(p => p.runId === f.runId);
          if (!live) return false;                                 // superseded by a newer result for the same chat
          // The committed routing/context snapshot wins over subsequent edits to the routine.
          const deliveryJob = Object.assign({}, job, f.deliveryContext || {}, { deliver: f.deliver, origin: f.origin });
          // givenUpTargets: the targets an earlier ask found refused for good (the host never sends to those again)
          try { out = deliverResult ? await deliverResult(deliveryJob, { runId: f.runId, outcome: f.outcome, runOutcome: f.runOutcome || null, text: f.result || '', error: f.error || null, deliveredTargets: live.deliveredTargets || f.deliveredTargets || [], givenUpTargets: live.givenUpTargets || f.givenUpTargets || [],
            ...(Object.prototype.hasOwnProperty.call(live, 'historyPublications') ? { historyPublications: live.historyPublications } : {}), superseded: Number(live.superseded) || 0 }) : { ok: true }; }
          catch (e) { out = { ok: false, error: (e && e.message) || String(e) }; }
          out = { ok: !out || out.ok !== false, error: out && out.error, deliveredTargets: out && out.deliveredTargets, givenUpTargets: out && out.givenUpTargets,
            ...(out && Object.prototype.hasOwnProperty.call(out, 'historyPublications') ? { historyPublications: out.historyPublications } : {}) };
          deliveryReceipts.set(key, out);
        }
        if (setJobs(cronStore.markDelivery(getJobs(), job.id, Object.assign({ runId: f.runId }, out), { now: now() })) === false) return false;
        deliveryReceipts.delete(key);
        // the outcome is on disk: what the host's delivery kept so a re-ask would send nothing may go now
        const saved = cronStore.getJob(getJobs(), job.id);
        const publication = cronStore.publicationReleases(saved).find(p => p.runId === f.runId);
        if (publication) await releasePublication(saved, publication);
        else if (deliveryRecorded) { try { await deliveryRecorded(job.id, f.runId, out); } catch (e) { failNote('cron.delivery.recorded', e); } }
        return out.ok;
      } finally { deliveries.delete(key); }
    }

    async function recoverFinalizations() {
      let count = 0;
      // Completed publication receipts are maintenance, not a new send. They survive
      // later results and retry even while the routine is paused, at the existing four-item bound.
      const releases = getJobs().slice().flatMap(job => cronStore.publicationReleases(job).map(f => ({ job, f })));
      const start = releases.length ? publicationReleaseCursor % releases.length : 0;
      let visited = 0;
      for (; visited < Math.min(4, releases.length); visited++) {
        const { job, f } = releases[(start + visited) % releases.length];
        const key = job.id + '/' + f.runId;
        if (deliveries.has(key)) continue;
        deliveries.set(key, true);
        try { await releasePublication(job, f); } finally { deliveries.delete(key); }
      }
      publicationReleaseCursor = releases.length ? (start + visited) % releases.length : 0;
      // Bound each pass; an unreachable destination must not flood transports on every tick.
      const work = [];
      for (const listed of getJobs().slice()) {
        if (!listed) continue;
        // a paused routine's results wait for its resume — all but a RUN NOW pressed on it while paused (deliveriesHeld per
        // receipt, review 7.1) and one whose delivery already started (it finishes)
        const held = cronStore.deliveriesHeld(listed);
        if (!cronStore.pendingDeliveries(listed).some(f => !cronStore.deliveriesHeld(listed, f) || started(listed.id, f.runId))) continue;
        // Collapse first, so the per-pass bound is spent on results that will actually be sent.
        if (!held && cronStore.pendingDeliveries(listed).length > 1 && !collapseBacklog(listed.id, null)) continue;
        const job = cronStore.getJob(getJobs(), listed.id) || listed;
        for (const f of cronStore.pendingDeliveries(job)) {
          if (cronStore.deliveriesHeld(job, f) && !started(job.id, f.runId)) continue;
          if (work.length + deliveries.size >= 4) break;
          const key = job.id + '/' + f.runId;
          if (deliveries.has(key) || (!deliveryReceipts.has(key) && Date.parse(f.nextAttemptAt) > now())) continue;
          work.push([job, f]);
        }
      }
      await Promise.all(work.map(async ([job, f]) => { if (await deliverFinalization(job, f)) count++; }));
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
      // A reclaimed/finished run awaiting disk recovery has already chosen its outcome.
      // A late resolution from the aborted host must not replace that receipt.
      if (pending) { state = pending.state; threw = pending.threw; }
      const at = pending ? pending.at : now();
      const reply = (state.buf || '').trim();
      // ONE settlement rule for the scheduled fire and Run Now (fireOutcome): only a succeeded run is ok — a provider-cut
      // reply, a question nobody can answer and a missing end all fail, each in plain words
      let settled = fireOutcome(state, threw);
      // A STOP IS ITS OWN OUTCOME (review r7, the family law): a fire someone stopped (Stop, pausing it mid-run, deleting it, E-STOP, or a
      // STOP on its work line) is neither ok nor a failure — its record says 'stopped' (markRun: no failure streak, no auto-pause), and
      // cron.result says 'stopped' with the fire's own outcome code beside it (runOutcome), never 'failed'
      // THE FIRE SETTLES ITS CRATE (typed-outcomes): the entry run's end is not the fire's outcome — a reviewer may still hold its
      // line. Delivered ('done') only for a fire that SUCCEEDED and whose line delivered the whole job (fireOutcome .crate); a held or
      // stopped line, a cut reply or an error the run raised drains the slot. Idempotent on the host's side (a crate settles once).
      if (settleWorkitem) {
        const jobFacts = { output: state.buf, error: state.errMsg || (threw && (threw.message || String(threw))) };
        if (state.lineStop && state.lineStop.code === 'day_limit') Object.assign(jobFacts, { stop: state.lineStop, admissionStop: state.lineStop, stopped: settled.outcome === 'stopped' });
        // The host's acceptance hold is job authority, like a review hold; the successful provider row stays intact.
        if (state.lineStop && state.lineStop.code === 'blocked') jobFacts.stop = state.lineStop;
        try {
          const jobResult = settleWorkitem(runId, settled.crate, jobFacts);
          if (jobResult && jobResult.jobId) {
            // The host has durably accepted this result. Keep it in the existing retry receipt: the host item
            // is gone after success, and a later routine-write retry must neither lose nor replace its cause.
            state.lineResult = { jobId: jobResult.jobId, outcome: jobResult.outcome, stop: jobResult.stop, error: jobResult.error };
            if (jobResult.outcome === 'stopped' && state.completionHold && state.line && state.line.blocked === state.completionHold.why) {
              // A late owned STOP/fault supersedes this acceptance hold. Keep unrelated review/partial facts.
              state.line = Object.assign({}, state.line);
              delete state.line.blocked;
            }
            if (jobResult.stop) state.line = Object.assign({}, state.line, lineFacts({ stopped: jobResult.error, stop: jobResult.stop, halted: jobResult.outcome === 'stopped' }));
          }
          settled = fireOutcome(state, threw);
        }
        catch (e) {
          // A line job could not durably finish. Reuse the driver's existing settlement retry, without publishing a
          // successful routine result, releasing ownership, or executing the paid work again.
          failNote('cron.settleWorkitem', e);
          if (currentLease && currentLease.runId === runId && !currentLease.settlement) currentLease.settlement = { at, state: Object.assign({}, state), threw: threw || null };
          return false;
        }
      }
      const errMsg = settled.errMsg, ok = !errMsg;
      const stopped = !ok && settled.outcome === 'stopped';
      // THE REASON THE FIRE HANDS ON (review 5.1): its run's end word, 'done' only for a fire that SUCCEEDED (RunOutcome.reasonOf over
      // the fire's outcome): a cut reply is 'cut_short', an error the run raised 'error', a line a reviewer held 'blocked'. ONE value for
      // the routine's record (lastReason: routine.list) and cron.result (the HUD's "✕ routine failed — …", the routine's COMMS session),
      // which both read "failed — done" for a cut fire.
      const fireReason = RunOutcome ? RunOutcome.reasonOf({ reason: state.reason || (ok ? 'done' : 'error'), outcome: settled.outcome }) : (state.reason || (ok ? 'done' : 'error'));
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
            runId: runId, status: ok ? 'ok' : (stopped ? 'stopped' : 'error'),
            reason: fireReason,
            outcome: settled.outcome || undefined, failureCode: settled.failureCode || undefined,   // the run's outcome code (additive)
            error: errMsg || undefined, transient: transient, output: ok ? reply : undefined, usd: state.usd || 0,
            line: state.line || null,   // the work line's stop facts (stopped / unapproved / partial), null on a clean or no line
            pausedAtStart: lease.pausedAtStart === true,   // a RUN NOW pressed on a routine already paused (handleCronRun's lease): its result is not held
            monitorHash: ok ? state.monitorHash : undefined
          }, { now: at, defaultTz: defaultTz, maxConsecutiveFailures: maxConsecutiveFailures });
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
      // job-level outcome: a FAILED run always reports (never silent); SILENT only on a clean, exactly-"[SILENT]" reply; a STOP is 'stopped'.
      const outcome = !ok ? (stopped ? 'stopped' : 'failed') : (reply === SILENT_MARKER ? 'silent' : 'ok');
      let baseReason = fireReason;
      let pausedAfter = 0;
      // AUTO-PAUSE telemetry: when THIS settlement tripped the consecutive-failure ceiling the job is now
      // disabled — say so on the governed reason string (kept for older readers) and as its own field (pausedAfter, review r7: a reader
      // that resolved the suffixed reason read it as no run reason at all).
      if (owned && committed) {
        const settledJob = cronStore.getJob(getJobs(), jobId);
        if (settledJob && settledJob.enabled === false && settledJob.disabledReason === 'consecutive-failures' && (settledJob.disabledAt === iso(at))) {
          pausedAfter = Number(settledJob.consecutiveFailures) || 0;
          baseReason = baseReason + ' (paused: consecutive-failures x' + settledJob.consecutiveFailures + ')';
        }
      }
      // an UNOWNED settle whose runId already reported (its reclaim settled it) stays silent: one run, one cron.result
      const alreadyReported = !owned && runId != null && settledRunIds.has(String(runId));
      // (review r7, additive) the fire's OWN outcome code rides beside the coarse word: a reader never re-derives stopped / cut_short / blocked
      // from the free-text reason, whose ' (paused: …)' / ' (stale-lease)' suffix put it outside the reason vocabulary
      const resultPayload = { jobId: jobId, runId: runId, outcome: outcome, reason: owned ? baseReason : (baseReason + ' (stale-lease)') };
      if (RunOutcome && RunOutcome.isOutcome(settled.outcome)) resultPayload.runOutcome = settled.outcome;
      if (settled.failureCode) resultPayload.failureCode = String(settled.failureCode);
      if (pausedAfter > 0) resultPayload.pausedAfter = pausedAfter;
      if ((!owned || committed) && !alreadyReported) try { emit('cron.result', resultPayload); } catch (_) {}
      if (owned && committed) noteSettled(runId);
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
        try { setJobs(cronStore.markRun(getJobs(), job.id, { runId: blockedRunId, status: 'error', reason: 'context-error', error: msg, transient: false }, { now: nowMs, defaultTz: defaultTz })); } catch (e) { failNote('cron.markRun', e); }
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
            }, { now: nowMs, defaultTz: defaultTz }));
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
      // the routine's pair is ONE resolution when the host injects it (run-wire.js): the model and the provider can never
      // come from two different levels (a routine's own model on its agent's provider by accident, a stale stamp, …)
      const wired = wireForJob ? (wireForJob(job) || {}) : null;
      const model = wired ? String(wired.model || '').trim()
        : ((job.model && String(job.model).trim()) || (ident.model && String(ident.model).trim()) || defaultModel);
      const provider = (wired ? wired.provider : providerForJob(job, ident)) || 'openrouter';
      const key = getKey(provider, job);
      let configIssue = null;
      // a routine saved on a provider this station does not know is refused by the resolution (run-wire.js): say which
      if (!job.noAgent && !model) configIssue = { code: 'missing-model', reason: (wired && wired.unknownProvider && wired.error) ? String(wired.error) : 'no model is configured; choose a model for this routine or its assigned agent' };
      else if (!job.noAgent && !hasCredential(provider, key, job)) configIssue = { code: 'missing-credential', reason: String(credentialError(provider, job)) };
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
      try { placeWorkitem(job.agentId, assembledPrompt, runId, job.dockId || undefined, { byFire: !!settleWorkitem, runsLine: job.runsLine === true, entry: 'schedule', signal: ac.signal, stopHandle: () => ac.abort() }); }
      catch (e) {
        failNote('cron.placeWorkitem', e);
        if (job.runsLine === true) {
          finishFire(job.id, runId, { buf: '', reason: 'error', errMsg: 'the line job could not be recorded: ' + ((e && e.message) || e), usd: 0 }, null);
          return false;
        }
      }

      // in-process emit sink: assemble the reply from agent.token deltas (reply-assembler.js, the SAME one the hub uses —
      // there is no agent.message event), capture the end reason / error / transient flag off the RAW payload
      // (internal outcome bookkeeping stays whole), then FORWARD each event to the HUD through the SHARED tee
      // redaction so an unattended run is observable live in the SAME redacted shape a routed channel run ships
      // (tool_call name-only, tool_result outcome-only, metadata events whole; token deltas dropped to stay quiet,
      // and any event runTeeView maps to null — e.g. the noisy inner streams — is dropped rather than leaked raw).
      const state = { buf: '', errMsg: null, reason: null, transient: false, usd: 0, monitorHash: sourceHash, toolsRan: 0 };
      const assembler = replyAssembler.makeReplyAssembler();
      const sink = function (name, payload) {
        const p = payload || {};
        // NS-0 HEARTBEAT: every run-progress event proves this run is still alive → renew the in-RAM lease
        // heartbeat, and (throttled) persist a durable heartbeat on a one-shot job so a fresh liveness signal
        // survives a restart and suppresses the fireClaim zombie re-fire. Throttle keeps the hot token path
        // from persisting on every delta: only persist once the durable heartbeat is older than heartbeatMs.
        renewLease(job.id, runId);
        const fed = assembler.feed(name, p);
        if (fed) { state.buf = assembler.text(); state.toolsRan = assembler.toolsRan; }   // a tool call: prior prose was narration; only the terminal segment is deliverable
        if (fed === 'token') return;   // token stream never leaves the driver
        // THE LEAD'S OWN RUN settles the fire (typed-outcomes, the /v1 rule): team.dispatch / team.spawn forward a worker's
        // agent.run.error / .end onto this stream under the WORKER's runId (orchestration.js FORWARD). A worker that failed is the
        // lead's tool result, never the routine's outcome; its spend still counts (usd below).
        const lead = !p.runId || String(p.runId) === String(runId);
        if (name === 'agent.run.error') { if (lead) { state.errMsg = p.message || 'run error'; state.transient = !!p.transient; state.failureCode = p.failureCode || state.failureCode || ''; } }
        else if (name === 'capdenied') state.errMsg = state.errMsg || ('no ' + (p.need || 'capability') + ' — ' + (p.reason || ''));
        else if (name === 'agent.run.end') {
          if (lead) state.reason = p.reason;
          if (lead) state.end = p;   // the end as the station stamped it (outcome, finishReason, failureCode): fireOutcome reads it
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
      // (multi-bay) a routine that FIRES AT one of several bays is briefed with THAT bay's brief (job.dockId)
      if (stageBriefFor) { try { dockBrief = job.dockId ? stageBriefFor(job.agentId, job.dockId) : stageBriefFor(job.agentId); } catch (_) { dockBrief = null; } }
      let deliveryNote = '';
      if (deliveryNoteFor) { try { deliveryNote = String(deliveryNoteFor(job) || ''); } catch (e) { failNote('cron.deliveryNote', e); deliveryNote = ''; } }
      const system = ((ident.system && String(ident.system)) || personaOf(job.agentId, job))
        + (dockBrief ? '\n\nYOUR STANDING BRIEF FOR THIS STATION:\n' + String(dockBrief).slice(0, 2000) : '')
        + deliveryNote;

      const messages = [{ role: 'user', content: assembledPrompt }];
      // launch the run SYNCHRONOUSLY (so the fire is ordered with the lease/cron.fire), but route both a
      // synchronous throw and an async rejection through the SAME terminal path so the lease always releases.
      let p;
      try {
        p = runOnce({
          key: key, model: model, system: system, messages: messages,
          // the persona carries only its standing half (dossier + goal); the host puts the station's observed evidence
          // in this run's own context note, so the system prompt (and the provider's cached prefix) is the same every fire
          stationEvidence: true,
          agentId: job.agentId, isTask: true, emit: sink, signal: ac.signal,
          // streamId 'cron-'+runId makes this run's transcript durable under a per-RUN named stream (runId is a
          // fresh newId() already in scope — determinism-clean). Without it the reply is buffered into `state.buf`
          // and only an outcome enum escapes, so the actual work is invisible: it persists under the 'global'
          // stream no UI renders. A PER-RUN id (not per-job) keeps the run's message seed empty (index.js only
          // reconstructs a stream when messages<=1), so cron behavior is byte-identical — the frontend
          // autosessions module reads GET /api/transcript?stream=cron-<runId> to surface the output as a session.
          runId: runId, streamId: 'cron-' + runId, surface: 'autonomous', trigger: 'schedule', provider: provider,
          // the injected resolution carries THE ONE effort rule (run-wire.js): the agent's own effort, else the
          // Overseer's when it follows the station default, else undefined (the provider default). Legacy host (no
          // wireForJob): an unpinned agent's routine runs on the Overseer's effort, else the run's own roster effort.
          reasoningEffort: wired ? (wired.reasoningEffort || undefined)
            : ((!(job.model && String(job.model).trim()) && ident.followsStation) ? ident.reasoningEffort : undefined),
          // WHERE the pair came from (routine / agent / station / env), recorded on the run row (wireSource)
          wireSource: wired ? (wired.source || undefined) : undefined,
          // Host-minted recovery identity. The active-run journal can now tie an interrupted headless run back
          // to the routine that launched it without trusting model text or guessing from the stream id. Same helper as
          // Run Now (routine-identity.js): cronJobId/cronJobName, the recipe's provenance (recipeId), and the IDEMPOTENCY
          // SCOPE — the same tick retried/resumed must not re-send a connector write, the NEXT tick may (job + fire time).
          ...routineRunIdentity(job, scheduledFor),
          // SOP recipes: a routine minted from a recipe with acceptance rows carries the typed postconditions
          // contract in its meta bag; the host evaluates it at run end exactly as for an interactive launch.
          postconditions: (job.meta && job.meta.postconditions != null) ? job.meta.postconditions : undefined,
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
          dockId: job.dockId || undefined,   // (multi-bay) the bay it fires at decides which line — and so which project — the entry stage runs in
          workdir: job.workdir || null,
          enabledToolsets: Array.isArray(job.enabledToolsets) ? job.enabledToolsets.slice() : null,
          initialTaint: !!(job.contextFrom && job.contextFrom.length),
          // per-bay capability isolation (B5): a bay-docked agent's routine runs with ITS room's objects,
          // never the default office — same contract as a routed channel message. undefined -> office.
          station: (resolveStation ? (job.dockId ? resolveStation(job.agentId, job.dockId) : resolveStation(job.agentId)) : null) || undefined
        });
      } catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(
        function (ran) {
          state.lineStop = ran && ran.lineStop || null;
          holdForCompletion(state, job.meta && job.meta.postconditions);
          // The line advances ONLY on a COMPLETED entry run. finishFire treats any terminal reason other
          // than 'done' as failure, yet this gate let a truncated run (max_turns/budget/missing terminal —
          // none of which set errMsg) buy every downstream hop on partial stage-one material, then recorded
          // the routine as failed anyway. The reason check closes that split verdict.
          // (typed-outcomes: and a provider-cut 'done' is not a finished stage either — only a SUCCEEDED run hands on: fireOutcome)
          // The line is SEEDED with the run's returned TERMINAL text (line-runner.js), never the reply streamed into state.buf: that
          // can carry the host's private-files note or a steer echo, and neither is stage one's work.
          const handed = (ran && typeof ran.text === 'string') ? ran.text : String(state.buf || '');
          if (!advanceChain || state.errMsg || state.reason !== 'done' || fireOutcome(state, null).errMsg || !handed.trim()) { finishFire(job.id, runId, state, null); return; }
          // hops ride the ROUTINE'S OWN stream so its session reads as one multi-stage job, and each hop renews
          // the lease — a line that outran the heartbeat would be declared a zombie and re-fired mid-work.
          Promise.resolve(advanceChain({
            // the ASSEMBLED prompt (contextFrom output + directive): hops no longer replay the stream, so a downstream stage
            // sees the routine's upstream context only if the handoff's "original request" carries it (token-burn audit 2026-10-17)
            agentId: job.agentId, dockId: job.dockId || undefined, text: handed, originalText: assembledPrompt, ask: String(job.prompt || ''),
            jobId: job.id,   // the routine this fire belongs to (a work line that parks at a reviewer's gate names it: index.js advanceChain)
            signal: ac.signal, runId: runId, streamId: 'cron-' + runId, key: key, model: model, provider: provider,
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
            // the LINE's answer, its stop note when it stopped short, its spend and its stop facts — as the channel hub folds it
            function (line) { foldLineIntoFire(state, line, handed); finishFire(job.id, runId, state, null); },
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
      Promise.resolve(recoverFinalizations()).catch(e => warn('[cron] delivery recovery failed: ' + ((e && e.message) || e)));

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
        if (maxWallMs > 0 && lease.startedAt != null && nowMs - lease.startedAt > maxWallMs) {
          try { lease.ac.abort(); } catch (e) { failNote('cron.wallclock.abort', e); }
          finishFire(jobId, lease.runId, {
            reason: 'wall-clock-exceeded',
            errMsg: 'run stopped: still running after ' + Math.round(maxWallMs / 60000) + ' min (the routine time limit)', transient: false
          }, null);
          skips++;
          continue;
        }
        const beatAge = nowMs - (lease.heartbeatAt != null ? lease.heartbeatAt : lease.startedAt);
        if (beatAge > heartbeatStaleMs) {
          try { lease.ac.abort(); } catch (_) {}
          /* A RECLAIM IS A REAL OUTCOME (bug-sweep 2026-08-28): the aborted run's late finishFire is UNOWNED
             (generation fence) and never writes markRun — so before this, a reclaimed ONE-SHOT kept its
             persisted fireClaim + null lastRunAt and re-executed the work every ~maxRunMs FOREVER (real spend
             per cycle), and a reliably-hanging recurring routine never advanced consecutiveFailures toward
             the auto-disable ceiling built for exactly that case. Record the reclaim as a TRANSIENT failure:
             markRun clears the claim/heartbeat, re-arms via the bounded backoff, and the retry ceiling turns
             a permanent hang into a terminal, visible failure. THIS settle is the run's one cron.result: the
             aborted run's late finishFire arrives unowned for the same runId and is silenced (settledRunIds). */
          finishFire(jobId, lease.runId, {
            reason: 'stale-lock-reclaimed',
            errMsg: 'run reclaimed: no progress for ' + Math.round(heartbeatStaleMs / 1000) + 's', transient: true
          }, null);
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
        // undelivered results, superseded ones included: one collapsed receipt can stand for a hundred
        if (cronStore.undeliveredCount(job) >= cronStore.MAX_PENDING_DELIVERIES) {
          deferred.push(job.id); deferredSet.add(job.id);
          try { emit('cron.skipped', { jobId: job.id, reason: 'at-capacity' }); } catch (e) { failNote('cron.delivery.defer', e); }
          skips++; continue;
        }
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
          if (orphan) { try { orphan.ac.abort(); } catch (_) {} }
          else leases.set(job.id, { runId: failRunId, startedAt: nowMs, heartbeatAt: nowMs, ac: newAbort() });
          finishFire(job.id, failRunId, {
            reason: 'fire-error', errMsg: 'fire failed: ' + ((e && e.message) || e), transient: true
          }, null);
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

    return { applyTick: applyTick, leases: leases, abortAllLeases: abortAllLeases, recoverFinalizations: recoverFinalizations, deliverFinalization: deliverFinalization, settleRun: finishFire,
      _internals: { fireJob: fireJob, finishFire: finishFire, deliverFinalization: deliverFinalization } };
  }

  /* A routine script that THROWS (shell.exec's TIMEOUT / CANCELLED error) carries its whole captured output — up
     to 64KB — in the message, which then rides the run record and the routine's error line. Clip it the same way the
     non-zero-exit path clips its output (last SCRIPT_ERROR_TAIL chars), keeping the explanatory head intact. */
  const SCRIPT_ERROR_TAIL = 4000;
  function clipScriptError(message, max) {
    const msg = String(message == null ? '' : message);
    max = Number(max) > 0 ? Math.floor(Number(max)) : SCRIPT_ERROR_TAIL;
    const MARK = 'Output captured before the kill:\n';
    const at = msg.indexOf(MARK);
    const head = at >= 0 ? msg.slice(0, at + MARK.length) : '';
    const body = at >= 0 ? msg.slice(at + MARK.length) : msg;
    const headClip = head.length > 1000 ? head.slice(0, 999) + '…' : head;
    return headClip + (body.length > max ? '…' + body.slice(-max) : body);
  }

  /* fireOutcome(state, threw) -> { errMsg, outcome, failureCode } — how a routine's run ended, from what its sink saw (the
     stamped agent.run.end in state.end, the error's message and code), read through RunOutcome. errMsg is null ONLY for a
     succeeded run: a provider-cut reply ('done' + finishReason), a Task Brief question nobody is there to answer and a
     stream with no end each settle as a failure with their plain sentence — the routine is never stamped green for work
     it did not finish, and the result is never delivered or pinged as done. Shared by the scheduled fire (finishFire) and
     Run Now (sidecar/index.js handleCronRun), so the two settle the same run the same way.
     .crate (review 4.3) is the reason the fire's conveyor CRATE settles with: 'done' (delivered to the OUTBOX) only for a fire that
     SUCCEEDED and whose work line delivered the whole job (routing/line-fire.js lineDelivered) — a line that stopped short (a hop
     failed) or whose joiner sent on without every branch keeps the fire's record as it was, but its crate drains as 'line_stopped',
     the rule the channel hub, chain.js's line-output receipt and the trigger / SEND TO runners hold. Otherwise the fire's outcome. */
  // A caller-required contract is separate from provider execution. Only the lead's host-stamped terminal
  // evidence can release that requirement; provider words and delegated workers' ends never populate state.end.
  // Keep the hold on the fire so strict LineJob settlement and routine-write retries share the same decision.
  function holdForCompletion(state, contract) {
    if (!state || contract == null || (state.end && state.end.completionVerdict === 'completed_verified')) return false;
    const ownError = state.errMsg ? { failureCode: state.failureCode || '' } : null;
    const succeeded = RunOutcome.ofEnd(state.end || null, ownError).ok;
    if (!succeeded) return false;   // an existing STOP, fault, cap or incomplete execution keeps its own cause
    const why = "Verification required: the routine's completion checks were not proven; nothing was handed on.";
    const stop = { code: 'blocked', why };
    state.completionHold = stop;
    state.lineStop = stop;
    state.line = Object.assign({}, state.line, lineFacts({ stopped: why, blocked: why, stop }));
    return true;
  }

  function fireOutcome(state, threw) {
    const st = state || {};
    const terminalReason = String(st.reason || '').trim();
    const end = (st.end && typeof st.end === 'object') ? st.end : (terminalReason ? { reason: terminalReason, finishReason: st.finishReason || undefined } : null);
    const failed = (st.errMsg || threw) ? { failureCode: st.failureCode || '' } : null;
    // a work line a reviewer BLOCKED (st.line, folded by routing/line-fire.js) held the work: the fire is 'blocked', not ok
    // A committed stopped LineJob is the final host decision, including a STOP/fault after the entry capped.
    // Other line outcomes retain the established distinction between the entry run and the whole line.
    const stoppedJob = st.lineResult && st.lineResult.outcome === 'stopped';
    const ended = RunOutcome ? (stoppedJob ? RunOutcome.ofEnd({ reason: 'cancelled' }, null) : RunOutcome.ofLine(RunOutcome.ofEnd(end, failed), st.line)) : { outcome: stoppedJob ? 'stopped' : terminalReason === 'done' ? 'succeeded' : 'failed', failureCode: '' };
    const finishReason = end && end.finishReason;
    const errMsg = (stoppedJob ? st.lineResult.error : st.errMsg)
      || (threw ? ('run failed: ' + ((threw && threw.message) || threw)) : null)
      || (ended.outcome === 'blocked' ? String(st.line.blocked) : null)   // the gate's own sentence: which reviewer held it, and that nothing was sent on
      // a line SOMEONE STOPPED (review r7: st.line.halted, routing/chain.js) — the fire is 'stopped', said as a stop and where it landed
      || (ended.outcome === 'stopped' && st.line && st.line.halted ? 'the work line was stopped before it finished' + (st.line.stopped && String(st.line.stopped) !== 'stopped' ? ' (' + String(st.line.stopped) + ')' : '') : null)
      || (ended.outcome === 'succeeded' ? null : incompleteRunMessage(terminalReason, { toolsRan: st.toolsRan || 0, finishReason: finishReason }));   // tools that ran mean an 'empty' end is not "nothing was done"
    const crate = (!errMsg && ended.outcome === 'succeeded') ? (lineDelivered(st.line) ? 'done' : 'line_stopped') : (ended.outcome || 'error');
    return { errMsg: errMsg, outcome: ended.outcome, failureCode: ended.failureCode, crate: crate };
  }

  return { makeCronDriver: makeCronDriver, fireOutcome: fireOutcome, holdForCompletion: holdForCompletion, SILENT_MARKER: SILENT_MARKER, clipScriptError: clipScriptError, SCRIPT_ERROR_TAIL: SCRIPT_ERROR_TAIL };
});
