/* sidecar/cron-store.js — the PURE lifecycle reducer for the scheduled-routines store (CRON Commit 2).

   This is the second half of the determinism split (see cron.js header + docs/CRON_INTEGRATION_PLAN.md
   §3.2): cron.js owns the schedule MATH, this file owns the job-RECORD lifecycle. Both are pure — every
   function is a transform over (jobs, args) with `now`/`id`/`runId` INJECTED as parameters, never read
   from the wall clock or rng. There is NO Date.now / Math.random / new Date() / setTimeout / fs here, so
   it passes lint-determinism.js and is headless-testable exactly like cron.js / loop.js / permissions.js.

   The ambient half — JSON file load/persist (atomic temp+rename, fail-closed), id minting
   (crypto.randomUUID), the real now-source — lives ONLY in sidecar/index.js, which copies the allowlist
   persistence idiom (index.js:76-88) and feeds these reducers an injected `now`/`id`.

   Surface (every op returns a NEW jobs array; the input is never mutated):
     makeJob(spec, { id, now })                  -> CronJob          // normalize a new record
     createJob(jobs, spec, { id, now })          -> jobs'           // append (throws on dup/invalid id)
     updateJob(jobs, id, patch, { now })         -> jobs'           // patch editable fields (id is immutable)
     pauseJob(jobs, id)                          -> jobs'           // disable (state:'paused')
     resumeJob(jobs, id, { now })                -> jobs'           // enable + re-anchor nextRunAt at now
     claimOnceFire(jobs, id, { now })            -> jobs'           // G4.5: stamp a one-shot fire-claim (advance-before-run analog)
     renewOnceHeartbeat(jobs, id, { now })       -> jobs'           // NS-0: bump a one-shot's liveness heartbeat while in flight
     markRun(jobs, id, result, { now, ... })     -> jobs'           // record an outcome (+ transient backoff; clears the fire-claim)
     removeJob(jobs, id)                         -> jobs'           // delete
     getJob(jobs, id)                            -> CronJob | null
     loadEnvelope(rawObjOrString)               -> { version, jobs } // tolerant, fail-closed
     toEnvelope(jobs)                           -> { version, jobs } // for persistence
     isValidId(id)                              -> boolean

   A CronJob (see cron.js for schedule shapes):
     { id, name, prompt, schedule, scheduleDisplay, agentId, model, provider, deliver, enabled,
       state:'scheduled'|'paused'|'completed'|'error', repeat:{times,completed},
       createdAt, nextRunAt, lastRunAt, lastRunId, lastStatus, lastError, lastReason, retryCount,
       fireClaim, lastFireAttemptAt, heartbeatAt,                      // G4.5 claim + NS-0 in-flight liveness heartbeat
       skills, script, workdir, contextFrom,                          // record-the-field, defer-the-consumer
       meta }                                                         // ADDITIVE provenance bag (e.g. {recipeId}); null when absent

   G4.5 — ONE-SHOT FIRE-CLAIM (at-most-once-within-window). A recurring job is protected from a
   crash-restart double-fire by advance-before-run (planTick persists the ADVANCED nextRunAt before the
   run launches), but a one-shot has no "next" fire to advance. Instead the host stamps a FIRE-CLAIM
   (claimOnceFire: fireClaim = the fire-instant ms, lastFireAttemptAt = its ISO) and persists it BEFORE
   launching the run; cron.planTick then treats a one-shot carrying a FRESH claim (claim age < maxRunMs
   and no settlement) as NOT due, so a crash-restart INSIDE the run window does not re-fire it. A ZOMBIE
   claim past the maxRunMs ceiling (a crashed holder) IS reclaimed and re-fires. CRITICALLY, markRun
   CLEARS fireClaim on EVERY settlement — success, terminal failure, AND transient failure — so the
   not-due guard only suppresses re-fire while the run is ACTUALLY in flight: a transient failure clears
   the claim and re-arms via the normal backoff path (NOT suppressed by a stale claim); a terminal
   settlement clears the claim and the (now-set) lastRunAt makes the one-shot permanently ineligible. */
'use strict';
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('./cron.js') : (root.SK && root.SK.cron));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).cronStore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (cron) {
  'use strict';

  const ENVELOPE_VERSION = 1;
  const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;   // terminal failures in a row before a recurring job auto-pauses
  const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;      // a single safe path component (matches index.js agentId guard)
  const iso = cron._internals.iso;            // ms(arg) -> ISO; deterministic (no zero-arg new Date)
  // a fire's work-line stop facts, bounded (routing/line-fire.js lineFacts — the one shape the routine paths record)
  const lineFactsOf = (typeof require === 'function') ? require('./routing/line-fire.js').lineFacts : function () { return null; };

  // fields a user may edit via updateJob. `id`, timestamps, run-state and counters are NOT editable here.
  const EDITABLE = ['name', 'prompt', 'agentId', 'model', 'provider', 'deliver', 'skills', 'script', 'scriptTimeoutMs', 'workdir', 'contextFrom', 'monitorMode', 'misfire', 'unattendedGrants', 'noAgent', 'enabledToolsets', 'attachToSession', 'origin', 'runsLine', 'dockId'];

  /* UNATTENDED CAPABILITY GRANT (2026-07-25) — the capability families the Commander explicitly approved for
     THIS routine to use with nobody watching. Default EMPTY: a routine grants nothing extra unless the user
     ticked it, so every pre-existing job loads with no new power. 'workbench' = terminal (shell.exec) +
     verify.run. 'connectors' = the Commander's connected MCP servers (capability 'mcp:<connectorId>'); a
     connector the Commander switched OFF still contributes no tools, so this can never re-enable one.
     'studio' = image_generate: the routine may make images with nobody there to approve each one.

     This list is STORAGE, not authority. sidecar/inputpolicy.js owns the authoritative whitelist
     (GRANTABLE_UNATTENDED) and re-filters it at the gate on every run, so a hand-edited or migrated
     cron.jobs.json can never widen a run past what the host models — the two filters are deliberately
     independent (defense in depth), which is also why this module needs no cross-require of the policy. */
  const GRANTABLE = ['workbench', 'connectors', 'studio'];
  function normGrants(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const g of v) {
      const name = String(g == null ? '' : g).trim();
      if (name && GRANTABLE.indexOf(name) >= 0 && out.indexOf(name) < 0) out.push(name);
    }
    return out;
  }

  // MISFIRE POLICY (2026-07-15 reliability audit): what planTick does with a recurring fire noticed past its
  // grace window — 'fire_once' (run the missed occurrence exactly once) or 'skip' (fast-forward, drop it).
  // null = derive the default from the schedule (cron/slow-interval -> fire_once, fast interval -> skip;
  // see cron.misfirePolicy). Normalized here so a bogus patch value can never persist an unknown policy.
  function normMisfire(v) { return (v === 'skip' || v === 'fire_once') ? v : null; }
  function normList(v, max, re) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const raw of v) { const s = String(raw == null ? '' : raw).trim(); if (s && (!re || re.test(s)) && out.indexOf(s) < 0) out.push(s.slice(0, 120)); if (out.length >= max) break; }
    return out;
  }

  function isValidId(id) { return typeof id === 'string' && ID_RE.test(id); }

  function getJob(jobs, id) { return (jobs || []).find(j => j && j.id === id) || null; }

  // return a NEW jobs array with the matching job replaced by fn(job); other jobs untouched, input not mutated.
  function mapJob(jobs, id, fn) {
    return (jobs || []).map(j => (j && j.id === id ? fn(j) : j));
  }

  /* the next-fire ISO for an enabled, fireable schedule re-anchored at `now`, else null.

     `defaultTz` is NOT optional decoration. cron.js resolves a tz-less schedule against
     tzFor(schedule, defaultTz), which falls back to 'UTC' when nothing is injected — and this helper is
     what stamps nextRunAt in makeJob, updateJob's re-anchor, resumeJob and markRun's error re-arm. The
     DRIVER plans with the real host zone (CRON_HOST_TZ, from Intl), and planTick's dueAtOf PREFERS the
     persisted nextRunAt, so a UTC-anchored stamp became the real FIRST fire instant: on America/New_York,
     "every morning" (0 9 * * *) was promised for today 09:00 by the preview and persisted as tomorrow
     05:00 local. It fired ~20 hours late at 5am, and only settled onto the correct local 09:00 from the
     SECOND fire onward. Every tz-less creation path hit it — the marketplace MAKE ROUTINE, routine.create
     without `timezone`, the /routine slash action — plus every un-pause and every terminal-error re-arm. */
  function armAt(schedule, lastRunIso, now, defaultTz) {
    const ms = cron.nextFireAt(schedule, lastRunIso, now, defaultTz ? { defaultTz: defaultTz } : undefined);
    // finite-only: a corrupt schedule (NaN minutes/runAt) must arm to null (visible as unfireable), never
    // reach iso(NaN) — new Date(NaN).toISOString() THROWS, and from markRun's re-arm that throw left the
    // settlement uncommitted and the lease retried forever.
    return (ms != null && isFinite(ms)) ? iso(ms) : null;
  }

  /* makeJob — normalize a creation spec into a full CronJob record. `id` comes from spec.id or ctx.id
     (minted by the host); `now` anchors createdAt + the initial nextRunAt. Throws on an invalid id so a
     bad path component never reaches an output dir. */
  function makeJob(spec, ctx) {
    spec = spec || {}; ctx = ctx || {};
    const rawId = spec.id != null ? spec.id : ctx.id;
    const id = String(rawId);
    if (rawId == null || !isValidId(id)) throw new Error('cron-store: invalid job id (must match ' + ID_RE + ')');
    const now = ctx.now || 0;
    const schedule = spec.schedule || null;
    const enabled = spec.enabled !== false;                          // default true
    const isOnce = !!(schedule && schedule.kind === 'once');
    const fireable = !!(schedule && (schedule.kind === 'once' || schedule.kind === 'interval' || schedule.kind === 'cron'));

    // repeat: a one-shot is exactly once; recurring schedules are forever (null) unless a finite times is given.
    let times = null;
    if (isOnce) times = 1;
    else if (spec.repeat && spec.repeat.times != null) times = Math.max(1, parseInt(spec.repeat.times, 10) || 1);

    return {
      id: id,
      name: String(spec.name || ''),
      prompt: String(spec.prompt || ''),
      schedule: schedule,
      scheduleDisplay: schedule && schedule.display ? schedule.display : '',
      agentId: String(spec.agentId || 'agent'),
      model: spec.model != null ? String(spec.model) : null,        // null -> host's boot-frozen default
      provider: spec.provider != null ? String(spec.provider) : null, // null -> selected agent/global provider
      deliver: String(spec.deliver || 'local'),
      origin: normOrigin(spec.origin),
      enabled: enabled,
      state: enabled ? 'scheduled' : 'paused',
      repeat: { times: times, completed: 0 },
      createdAt: iso(now),
      nextRunAt: (enabled && fireable) ? armAt(schedule, null, now, ctx.defaultTz) : null,
      lastRunAt: null, lastRunId: null, lastStatus: null, lastError: null, lastReason: null,
      // Bounded final output is the durable data plane for contextFrom. It is runtime data, never editable.
      lastOutput: null,
      lastLine: null,   // the last fire's work-line stop facts { stopped?, unapproved?, partial? } (markRun)
      retryCount: 0,
      // misfire policy for a recurring job (see normMisfire above). null -> schedule-derived default.
      misfire: normMisfire(spec.misfire),
      // DELIVERY OUTCOME (2026-07-15 audit): the last channel-notification attempt for this job's runs —
      // separate from the run's own success so a routine that WORKED but whose ping DIED is visible
      // (previously the send rejection was swallowed and the failure left no trace anywhere). Additive:
      // old jobs load these as undefined and every consumer tolerates absence.
      lastDeliveryAt: null, lastDeliveryOk: null, lastDeliveryError: null,
      // Durable terminal receipt. `pending` is replayed on boot with the same run id, result, cost and destination.
      finalization: null, lastUsd: 0,
      // G4.5 one-shot fire-claim: stamped at fire time (claimOnceFire), cleared on settlement (markRun).
      // null on a fresh job; only ever non-null while a one-shot run is in flight (or a zombie past maxRunMs).
      fireClaim: null, lastFireAttemptAt: null,
      // NS-0 LEASE HEARTBEAT (2026-07-07): a LIVENESS timestamp renewed while a one-shot run is genuinely in
      // flight (the driver bumps it on every run-progress event via renewOnceHeartbeat, persisted). planTick
      // suppresses re-fire of a one-shot whose heartbeat is FRESH (age < staleMs) REGARDLESS of wall-clock claim
      // age — so a real research run that outlives maxRunMs is NOT declared a zombie and re-fired. A STALE
      // heartbeat (a crashed/dead-process holder — heartbeats stop) falls through to the fireClaim zombie reclaim.
      // null on a fresh job; cleared alongside fireClaim on EVERY settlement. Additive — old jobs load as null.
      heartbeatAt: null,
      // ---- record-the-field, defer-the-consumer (no v1 runtime consumer; stored so a later commit wires it) ----
      // UNATTENDED CAPABILITY GRANT (see normGrants): [] on every existing job, so this is purely additive.
      unattendedGrants: normGrants(spec.unattendedGrants),
      skills: normList(spec.skills, 8, /^[A-Za-z0-9_. -]{1,120}$/),
      script: spec.script != null ? String(spec.script) : null,
      scriptTimeoutMs: spec.scriptTimeoutMs != null ? Math.min(120000, Math.max(1000, parseInt(spec.scriptTimeoutMs, 10) || 30000)) : 30000,
      workdir: spec.workdir != null ? String(spec.workdir) : null,
      contextFrom: spec.contextFrom == null ? null : normList(spec.contextFrom, 8, ID_RE),
      // G7 monitor state: the user-controlled mode is editable; hashes/check timestamps are runtime receipts.
      // The hash advances only after a successful run, so a failed changed source remains retryable.
      monitorMode: spec.monitorMode === true,
      monitorHash: null,
      monitorLastCheckedAt: null,
      // G7 fail-closed configuration state. One fingerprint receives one durable alert until configuration changes.
      blockedConfig: null,
      // G7 job-local scratchpad. It is never model-addressable by job id; the host mints the current cronJobId.
      notepad: '',
      notepadUpdatedAt: null,
      noAgent: spec.noAgent === true,
      /* ONLY A ROUTINE THAT BELONGS TO A LINE RUNS THE LINE (Andrew's ruling, 2026-08-07). A routine fires AT
         a dock; if the floor draws stages past that dock, running them buys a provider call per stage. Deciding
         that from the dock alone made every PRE-EXISTING routine buy a whole work line the instant its agent was
         crewed onto one — money the Commander never asked for, and a delivered answer that was the LAST stage's
         instead of the routine's. So the intent is DURABLE and OPT-IN: true only for a routine created from a
         line's own INBOX trigger zone (which posts runsLine:true to /api/cron). Absent/false — every routine
         that predates this, every routine made in AUTOMATION, by the routine.* tools, by a recipe or a slash
         command — is TERMINAL: one run, its own answer, nothing downstream spends.
         Deliberately a FLAG, not a stored lineId: which line a dock belongs to is the compiled plan's single
         answer (router.lineOfAgent), and a second copy on disk would be a second derivation that drifts the
         first time the Commander edits the floor. The flag records the INTENT; the line is looked up live. */
      runsLine: spec.runsLine === true,
      /* FIRES AT A BAY (multi-bay agents, 2026-09-22): which of the agent's bays this routine fires at, when the
         Commander picked one (the workflow panel's FIRES AT chips). OPTIONAL and additive — present only when a
         safe id was given, so every existing job record is byte-identical. The fire resolves it against the
         live plan (router.dockOf): a dock the floor no longer has falls back to the agent's ENTRY dock. */
      ...(ID_RE.test(String(spec.dockId == null ? '' : spec.dockId)) ? { dockId: String(spec.dockId) } : {}),
      enabledToolsets: spec.enabledToolsets == null ? null : normList(spec.enabledToolsets, 16, /^[A-Za-z0-9:_-]{1,80}$/),
      attachToSession: spec.attachToSession === true,
      // ADDITIVE provenance (Recipe Marketplace R3): a sibling `meta` bag for caller-supplied provenance, e.g.
      // { recipeId } stamped by MAKE ROUTINE so the ROUTINES console + the recipe dossier can show the link. Old
      // jobs with no `meta` load as null and every consumer tolerates its absence — this NEVER breaks an existing
      // job. Normalized to a plain shallow object (or null); the driver/schedule math never reads it.
      meta: normMeta(spec.meta)
    };
  }
  function normOrigin(origin) {
    if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return null;
    const target = origin.target != null ? String(origin.target).slice(0, 200) : '';
    const channel = origin.channel != null ? String(origin.channel).slice(0, 80) : '';
    const chatId = origin.chatId != null ? String(origin.chatId).slice(0, 200) : '';
    const threadId = origin.threadId != null ? String(origin.threadId).slice(0, 200) : '';
    const sessionId = origin.sessionId != null ? String(origin.sessionId).slice(0, 200) : '';
    const streamId = origin.streamId != null ? String(origin.streamId).slice(0, 200) : '';
    const sessionTitle = origin.sessionTitle != null ? String(origin.sessionTitle).slice(0, 200) : '';
    return (target || (channel && chatId) || sessionId || streamId) ? { target: target || null, channel: channel || null, chatId: chatId || null, threadId: threadId || null, sessionId: sessionId || null, streamId: streamId || null, sessionTitle: sessionTitle || null } : null;
  }
  // normalize a caller-supplied meta bag: keep it only if it is a plain object, shallow-cloned; else null. This is
  // pure provenance (no runtime behavior keys), so we don't validate its shape beyond "plain object" — a recipeId
  // that isn't a string just won't resolve in the UI (a no-op), never a crash.
  function normMeta(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const out = {};
    for (const k of Object.keys(meta)) { const v = meta[k]; if (v != null && typeof v !== 'function') out[k] = v; }
    return Object.keys(out).length ? out : null;
  }

  function createJob(jobs, spec, ctx) {
    jobs = jobs || [];
    const job = makeJob(spec, ctx);
    if (jobs.some(j => j && j.id === job.id)) throw new Error('cron-store: duplicate job id ' + job.id);
    return jobs.concat([job]);
  }

  /* updateJob — patch the EDITABLE fields (and repeat.times). `id` is immutable: a patch.id is ignored,
     never copied. Changing the schedule re-anchors nextRunAt at `now` (unless the job is paused). */
  function updateJob(jobs, id, patch, ctx) {
    ctx = ctx || {}; patch = patch || {};
    const now = ctx.now || 0;
    return mapJob(jobs, id, (job) => {
      const next = Object.assign({}, job);
      for (const k of EDITABLE) if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
      if (Object.prototype.hasOwnProperty.call(patch, 'misfire')) next.misfire = normMisfire(patch.misfire);
      // dockId: a safe id or nothing (a cleared/garbage value removes the key — the job fires at the entry dock)
      if (Object.prototype.hasOwnProperty.call(patch, 'dockId')) { if (ID_RE.test(String(patch.dockId == null ? '' : patch.dockId))) next.dockId = String(patch.dockId); else delete next.dockId; }
      // re-normalize through the whitelist: the EDITABLE loop above copies the RAW patch value, so without this
      // a patch could persist an ungrantable capability name (same trap misfire guards against).
      if (Object.prototype.hasOwnProperty.call(patch, 'unattendedGrants')) next.unattendedGrants = normGrants(patch.unattendedGrants);
      if (Object.prototype.hasOwnProperty.call(patch, 'origin')) next.origin = normOrigin(patch.origin);
      if (Object.prototype.hasOwnProperty.call(patch, 'noAgent')) next.noAgent = patch.noAgent === true;
      // re-normalize through the same === true rule as creation: a patch may never persist a truthy-ish value
      // that later reads as "this routine may buy a whole line" (see the runsLine note in makeJob).
      if (Object.prototype.hasOwnProperty.call(patch, 'runsLine')) next.runsLine = patch.runsLine === true;
      if (Object.prototype.hasOwnProperty.call(patch, 'attachToSession')) next.attachToSession = patch.attachToSession === true;
      if (Object.prototype.hasOwnProperty.call(patch, 'scriptTimeoutMs')) next.scriptTimeoutMs = Math.min(120000, Math.max(1000, parseInt(patch.scriptTimeoutMs, 10) || 30000));
      if (Object.prototype.hasOwnProperty.call(patch, 'enabledToolsets')) next.enabledToolsets = Array.isArray(patch.enabledToolsets) ? patch.enabledToolsets.slice() : null;
      if (Object.prototype.hasOwnProperty.call(patch, 'skills')) next.skills = normList(patch.skills, 8, /^[A-Za-z0-9_. -]{1,120}$/);
      if (Object.prototype.hasOwnProperty.call(patch, 'contextFrom')) next.contextFrom = patch.contextFrom == null ? null : normList(patch.contextFrom, 8, ID_RE);
      if (Object.prototype.hasOwnProperty.call(patch, 'monitorMode')) {
        next.monitorMode = patch.monitorMode === true;
        if (!next.monitorMode) { next.monitorHash = null; next.monitorLastCheckedAt = null; }
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'enabledToolsets')) next.enabledToolsets = patch.enabledToolsets == null ? null : normList(patch.enabledToolsets, 16, /^[A-Za-z0-9:_-]{1,80}$/);
      if (patch.repeat && patch.repeat.times !== undefined) {
        const t = patch.repeat.times;
        next.repeat = Object.assign({}, job.repeat, { times: t == null ? null : Math.max(1, parseInt(t, 10) || 1) });
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'schedule')) {
        next.schedule = patch.schedule || null;
        next.scheduleDisplay = next.schedule && next.schedule.display ? next.schedule.display : '';
        // A NEW once-schedule on a SETTLED one-shot is a fresh commitment: clear the settled markers so the
        // new time genuinely arms. Without this, planTick's lastRunAt bar silently made every reschedule of
        // a completed one-shot a dead promise ("next in 3d" about a fire that could never happen). A plain
        // re-enable WITHOUT a new schedule stays refused (resumeJob's settled-one-shot guard).
        if (next.schedule && next.schedule.kind === 'once' && next.lastRunAt) {
          next.lastRunAt = null; next.fireClaim = null; next.heartbeatAt = null;
          if (!next.enabled && next.state === 'completed') next.state = 'paused';   // re-armable again, honestly labeled
        }
        if (next.enabled) next.nextRunAt = armAt(next.schedule, null, now, ctx && ctx.defaultTz);   // re-anchor at now
        next.retryAnchorAt = null;   // the OLD schedule's retry anchor must never phase-lock the new cadence
      }
      if (['agentId', 'model', 'provider', 'deliver', 'origin'].some(k => Object.prototype.hasOwnProperty.call(patch, k))) {
        next.blockedConfig = null;
        if (next.state === 'blocked_config') next.state = next.enabled ? 'scheduled' : 'paused';
      }
      return next;
    });
  }

  function pauseJob(jobs, id) {
    return mapJob(jobs, id, (job) => Object.assign({}, job, { enabled: false, state: 'paused', disabledReason: 'paused', disabledAt: null }));
  }

  function resumeJob(jobs, id, ctx) {
    const now = (ctx && ctx.now) || 0;
    return mapJob(jobs, id, (job) => {
      // A SETTLED ONE-SHOT is never re-armable (same guard as triggerJob): planTick permanently rejects a
      // once-job with lastRunAt set, so stamping it enabled+scheduled here promised "next run at <past>"
      // about a fire that can never happen — the exact claim the harness may never make.
      if (job.schedule && job.schedule.kind === 'once' && job.lastRunAt) return job;
      return Object.assign({}, job, {
        enabled: true, state: 'scheduled', nextRunAt: armAt(job.schedule, null, now, ctx && ctx.defaultTz),
        // a deliberate re-enable forgives the failure streak: the counter restarts from zero and the
        // auto-disable reason is cleared (otherwise one more failure would re-pause it instantly).
        // The pre-pause retry anchor goes with it — a resumed job advances from ITS re-anchored
        // nextRunAt, never the grid of the failure it was paused during.
        consecutiveFailures: 0, disabledReason: null, disabledAt: null, retryAnchorAt: null, retryCount: 0
      });
    });
  }

  /* triggerJob — make a job DUE on the very next scheduler tick, without running it inline.

     This is NOT resumeJob. resumeJob RE-ANCHORS: it recomputes the next fire of the job's own schedule from
     `now`, which for a cron routine is the next matching WALL-CLOCK time — so "resume at 10:00 a `0 9 * * *`
     job" yields 09:00 TOMORROW and the job does not fire now at all. Using it as a trigger would report
     "queued to fire within a tick" about something a day away, which is precisely the kind of claim the
     harness may never make. A trigger instead writes nextRunAt = NOW, which planTick's dueAtOf reads back as
     already-due (it prefers the persisted nextRunAt over a fresh computation), so the job fires on the next
     tick through the ordinary unattended path and then advances normally from markRun. Same shape as the
     reference harness's trigger_job (cron/jobs.py), which also just stamps next_run_at = now.

     A paused job is un-paused, exactly as resume does — asking to fire a paused routine and having nothing
     happen is a silent no-op, and the caller is told (state comes back 'scheduled'). A one-shot that has
     ALREADY settled (lastRunAt set) is deliberately left alone: planTick treats a settled one-shot as
     permanently ineligible, so stamping it due would promise a fire that can never happen. */
  function triggerJob(jobs, id, ctx) {
    const now = (ctx && ctx.now) || 0;
    return mapJob(jobs, id, (job) => {
      if (job.schedule && job.schedule.kind === 'once' && job.lastRunAt) return job;   // settled one-shot: never re-armable
      // a manual trigger owns the next fire completely — a stale retry anchor advancing from an old grid
      // after the triggered run settles would phase-shift the schedule the Commander just touched.
      return Object.assign({}, job, { enabled: true, state: 'scheduled', nextRunAt: iso(now), retryAnchorAt: null });
    });
  }

  function removeJob(jobs, id) { return (jobs || []).filter(j => !(j && j.id === id)); }

  /* claimOnceFire — G4.5: stamp a one-shot's FIRE-CLAIM at fire time (the advance-before-run analog for a
     non-recurring job). The host calls this for each due one-shot it is about to launch and PERSISTS the
     result BEFORE launching, so a crash-restart inside the run window sees the claim and does not re-fire
     (planTick suppresses a fresh-claimed one-shot; a zombie claim past maxRunMs is reclaimed). `now` is the
     fire instant ms (injected). No-op shape on a non-once job (still records the attempt timestamp). The
     claim is cleared by markRun on settlement, so it only ever marks an in-flight run. */
  function claimOnceFire(jobs, id, ctx) {
    const now = (ctx && ctx.now) || 0;
    // NS-0: do NOT stamp heartbeatAt here — the heartbeat is proof a run is ACTUALLY EMITTING progress, which a
    // just-claimed (or no-capability, never-launched) one-shot has not yet done. Leaving heartbeatAt null means
    // planTick falls through to the pure maxRunMs fireClaim reclaim (unchanged backoff for a non-firing one-shot);
    // once the run emits its first progress event, renewOnceHeartbeat sets a fresh heartbeat that extends liveness.
    return mapJob(jobs, id, (job) => Object.assign({}, job, { fireClaim: now, lastFireAttemptAt: iso(now) }));
  }

  /* renewOnceHeartbeat — NS-0: bump a one-shot's durable liveness timestamp to `now` (the driver calls this on
     each run-progress event so an in-flight run keeps proving it is alive). No-op-safe on a non-once/absent job.
     Only meaningful while a fireClaim is live; markRun clears BOTH on settlement so a stale heartbeat never
     wedges the job. Pure: `now` is injected. Kept minimal (heartbeat only) so a hot renewal path is cheap. */
  function renewOnceHeartbeat(jobs, id, ctx) {
    const now = (ctx && ctx.now) || 0;
    return mapJob(jobs, id, (job) => (job.fireClaim == null ? job : Object.assign({}, job, { heartbeatAt: now })));
  }

  /* markDelivery — DELIVERY OUTCOME (2026-07-15 audit): record the result of a channel-notification send
     for this job, separate from the run outcome (a routine can succeed while its ping fails — that failure
     must be durable and visible, never swallowed). result = { ok:bool, error?:string, channel?:string }.
     Pure: `now` is injected. No-op-safe on an absent job (mapJob leaves the array unchanged). */
  // A later occurrence must never overwrite an undelivered result. Bound retained
  // work through backpressure, not by discarding the oldest notification.
  const MAX_PENDING_DELIVERIES = 100;
  function pendingDeliveries(job) {
    return (Array.isArray(job && job.deliveryBacklog) ? job.deliveryBacklog : [])
      .concat(job && job.finalization ? [job.finalization] : [])
      .filter(f => f && f.state === 'pending');
  }

  function markDelivery(jobs, id, result, ctx) {
    result = result || {}; ctx = ctx || {};
    const now = ctx.now || 0;
    const ok = result.ok === true;
    return mapJob(jobs, id, (job) => {
      const error = ok ? null : String(result.error != null ? result.error : 'delivery failed') +
        (result.channel ? ' [' + String(result.channel) + ']' : '');
      const next = Object.assign({}, job, { lastDeliveryAt: iso(now), lastDeliveryOk: ok, lastDeliveryError: error });
      // Legacy notifier outcomes lack a run id; they may update the status line,
      // but cannot acknowledge unrelated durable result receipts.
      const matches = f => f && result.runId && String(result.runId) === String(f.runId);
      const update = f => {
        const attempts = (f.attempts || 0) + 1;
        return Object.assign({}, f, {
          state: ok ? 'delivered' : 'pending', attempts: attempts,
          deliveredAt: ok ? iso(now) : null, lastError: error,
          deliveredTargets: Array.isArray(result.deliveredTargets) ? result.deliveredTargets.slice(0, 16) : (f.deliveredTargets || []),
          nextAttemptAt: ok ? null : iso(now + Math.min(900000, 60000 * Math.pow(2, Math.min(attempts - 1, 4))))
        });
      };
      if (matches(job.finalization)) next.finalization = update(job.finalization);
      if (Array.isArray(job.deliveryBacklog)) next.deliveryBacklog = job.deliveryBacklog
        .map(f => matches(f) ? update(f) : f).filter(f => f.state === 'pending');
      return next;
    });
  }

  /* ONE CURRENT RESULT PER CHAT (upgrade review 2026-10-23). 0.13.x sent a routine's reply as one message, so every
     digest past Telegram's 4096 / Discord's 2000 characters stayed `pending` for good (retried, never expired) and
     each later fire queued another behind it. 0.14 splits long replies, so all of those became deliverable at once:
     the first boot sent weeks of old digests in a burst. A chat gets the routine's NEWEST result per destination;
     the older idle ones are closed as 'superseded' (never resent) and the newest carries the count, so the delivery
     says how many earlier results did not come. Returns the SAME array when nothing changes. Pure: `now` is injected.
     Who replaces whom (review 2026-10-23):
       * a [SILENT] result sends nothing, so it never replaces a result and is never counted as one — it is left to
         be acknowledged on its own (a monitor's quiet fire must not swallow the alert still waiting before it);
       * a failure notice never replaces a real result: per destination the keepers are the newest result AND, when
         it is newer still, the newest failure notice; every other receipt goes to the nearest NEWER keeper;
       * `busy` = run ids whose send is in flight or whose acknowledgement is not yet on disk. A busy receipt is
         never superseded (it may already have landed), and never takes over others either: its text is already on
         the wire, so a count it gained could never be said. Receipts whose keeper is busy wait for a later pass. */
  function deliveryDestination(f) {
    const o = (f && f.origin) || {};
    return [String((f && f.deliver) || 'local'), o.target || '', o.channel || '', o.chatId || '', o.threadId || '', o.sessionId || '', o.streamId || ''].join('\u0001');
  }
  function supersedeDeliveries(jobs, id, ctx) {
    ctx = ctx || {};
    const job = getJob(jobs, id);
    const pending = pendingDeliveries(job).filter(f => f.outcome !== 'silent');
    if (pending.length < 2) return jobs;
    const busy = (Array.isArray(ctx.busy) ? ctx.busy : []).map(String);
    const isBusy = f => busy.indexOf(String(f.runId)) >= 0;
    const byDest = new Map();   // destination -> its receipts, oldest first (pendingDeliveries is oldest-first)
    for (const f of pending) {
      const d = deliveryDestination(f);
      if (!byDest.has(d)) byDest.set(d, []);
      byDest.get(d).push(f);
    }
    const drop = new Map();     // superseded receipt -> the receipt that replaces it
    for (const list of byDest.values()) {
      let result = -1, failure = -1;
      list.forEach((f, i) => { if (f.outcome === 'failed') failure = i; else result = i; });
      const keepers = [result, failure > result ? failure : -1].filter(i => i >= 0).sort((a, b) => a - b);
      list.forEach((f, i) => {
        if (keepers.indexOf(i) >= 0 || isBusy(f)) return;
        const k = keepers.find(x => x > i);
        if (k != null && !isBusy(list[k])) drop.set(f, list[k]);
      });
    }
    if (!drop.size) return jobs;
    const gained = new Map();   // a superseded receipt hands on the count it was already carrying
    for (const [f, keep] of drop) gained.set(keep, (gained.get(keep) || 0) + 1 + (Number(f.superseded) || 0));
    const at = iso(ctx.now || 0);
    const mark = f => {
      if (drop.has(f)) return Object.assign({}, f, { state: 'superseded', supersededAt: at, supersededBy: String(drop.get(f).runId || ''), nextAttemptAt: null });
      if (gained.has(f)) return Object.assign({}, f, { superseded: (Number(f.superseded) || 0) + gained.get(f) });
      return f;
    };
    return mapJob(jobs, id, (j) => {
      const next = Object.assign({}, j);
      if (j.finalization) next.finalization = mark(j.finalization);
      if (Array.isArray(j.deliveryBacklog)) next.deliveryBacklog = j.deliveryBacklog.map(mark).filter(f => f && f.state === 'pending');
      return next;
    });
  }
  /* A routine the Commander PAUSED keeps its undelivered results until it is resumed — pausing it must not be the
     moment its old results start arriving. A completed one-shot, an exhausted repeat and an auto-paused routine are
     not 'paused' (their last result is the notice the Commander needs) and deliver as before. */
  function deliveriesHeld(job) { return !!(job && job.enabled === false && job.state === 'paused'); }
  /* undeliveredCount(job) -> the routine's results that have not reached their destination: every pending receipt plus
     the earlier ones it superseded. This, not the receipt count, is what MAX_PENDING_DELIVERIES bounds — a chat that
     refuses every message (bot blocked, chat deleted) keeps ONE receipt after the collapse, and counting receipts alone
     let such a routine fire (and spend) forever. Once a result lands, its count is spent and the routine runs again. */
  function undeliveredCount(job) {
    return pendingDeliveries(job).reduce((n, f) => n + 1 + Math.max(0, Number(f.superseded) || 0), 0);
  }

  function markBlockedConfig(jobs, id, info, ctx) {
    info = info || {}; ctx = ctx || {};
    const now = ctx.now || 0;
    return mapJob(jobs, id, (job) => {
      const fingerprint = String(info.fingerprint || '').slice(0, 200);
      const same = !!(job.blockedConfig && job.blockedConfig.fingerprint === fingerprint);
      const blocked = {
        fingerprint: fingerprint,
        reason: String(info.reason || 'routine configuration is incomplete').slice(0, 1000),
        since: same ? job.blockedConfig.since : iso(now),
        alertedAt: info.alerted ? (same && job.blockedConfig.alertedAt ? job.blockedConfig.alertedAt : iso(now))
          : (same ? job.blockedConfig.alertedAt || null : null)
      };
      const next = Object.assign({}, job, {
        state: 'blocked_config', blockedConfig: blocked, fireClaim: null, heartbeatAt: null,
        lastError: blocked.reason, lastReason: 'blocked_config', lastStatus: 'error'
      });
      // A blocked one-shot otherwise remains due every scheduler tick. Recheck at a bounded time without
      // finalizing its only occurrence; a configuration edit clears the block and can re-anchor/trigger it.
      if (job.schedule && job.schedule.kind === 'once' && info.retryAt != null) next.nextRunAt = iso(info.retryAt);
      return next;
    });
  }

  function clearBlockedConfig(jobs, id) {
    return mapJob(jobs, id, (job) => {
      if (!job.blockedConfig && job.state !== 'blocked_config') return job;
      return Object.assign({}, job, { blockedConfig: null, state: job.enabled ? 'scheduled' : 'paused', lastError: null });
    });
  }

  function markMonitorCheck(jobs, id, info, ctx) {
    info = info || {}; ctx = ctx || {};
    return mapJob(jobs, id, (job) => {
      const next = Object.assign({}, job, {
        monitorLastCheckedAt: iso(ctx.now || 0),
        monitorHash: info.commit === true ? String(info.hash || '').slice(0, 200) : (job.monitorHash || null)
      });
      if (info.unchanged === true) {
        next.fireClaim = null; next.heartbeatAt = null;
        if (job.schedule && job.schedule.kind === 'once' && info.retryAt != null) next.nextRunAt = iso(info.retryAt);
      }
      return next;
    });
  }

  /* markUnfireable — a job whose schedule can never fire (malformed/unknown kind). Idempotent: the mark is
     applied ONCE (the lastError sentinel is the durable dedup key) so a tick never re-writes it. Returns the
     same array reference when nothing changed, so the host can tell "marked now" from "already marked". */
  const UNFIREABLE_ERROR = 'schedule-unfireable';
  function markUnfireable(jobs, id, ctx) {
    ctx = ctx || {};
    const cur = getJob(jobs, id);
    if (!cur || cur.lastError === UNFIREABLE_ERROR) return jobs;
    return mapJob(jobs, id, (job) => Object.assign({}, job, {
      lastStatus: 'error', lastError: UNFIREABLE_ERROR, state: 'error', lastErrorAt: iso(ctx.now || 0)
    }));
  }

  /* markInterrupted — a RECURRING routine's run whose process died between fire and settlement (advance-before-run
     already moved nextRunAt; markRun never ran). Honest abandonment: the record names THAT run instead of still
     reporting the previous occurrence's ok. Nothing is re-armed, finalized or counted toward auto-pause — the run may
     have acted, and its review/continuation lives in run recovery. A one-shot keeps its own fire-claim reclaim (G4.5);
     a record that already settled this run or a LATER occurrence is left exactly as it is (idempotent per boot). */
  function markInterrupted(jobs, id, info) {
    info = info || {};
    const runId = String(info.runId || ''), startedAt = Number(info.startedAt) || 0;
    return mapJob(jobs, id, (job) => {
      if (!runId || !startedAt || job.lastRunId === runId || !(job.schedule && (job.schedule.kind === 'interval' || job.schedule.kind === 'cron'))) return job;
      const last = job.lastRunAt ? Date.parse(job.lastRunAt) : NaN;
      if (isFinite(last) && last >= startedAt) return job;
      return Object.assign({}, job, { lastRunId: runId, lastRunAt: iso(startedAt), lastStatus: 'error', lastReason: 'interrupted',
        lastError: String(info.error || 'interrupted: StarNet stopped before this run finished'), state: job.enabled === false ? job.state : 'error' });
    });
  }

  function setNotepad(jobs, id, text, ctx) {
    ctx = ctx || {};
    return mapJob(jobs, id, (job) => Object.assign({}, job, {
      notepad: String(text == null ? '' : text).slice(0, 8000),
      notepadUpdatedAt: iso(ctx.now || 0)
    }));
  }

  /* markRun — record the outcome of a fired run. `result = { runId, status:'ok'|'error', reason, error, transient }`.
     ctx = { now, maxRetries=3, backoffMs=90000 }.

       - transient error with retries left -> back off (nextRunAt = now + backoffMs), retryCount++, stay
         eligible (lastRunAt UNTOUCHED so it re-fires; repeat.completed NOT incremented). Bounded retry, no storm.
       - otherwise (success / permanent error / retries exhausted) -> finalize the occurrence: stamp
         lastRunAt, reset retryCount, increment repeat.completed, then:
           * one-shot OR finite repeat exhausted -> enabled:false, state:'completed' (ok) / 'error' (failed).
           * recurring continues -> on success leave nextRunAt as planTick already advanced it (advance-
             before-run); on a terminal error re-arm one period out and flag state:'error' but stay ENABLED
             (never silently disable a recurring job). */
  function markRun(jobs, id, result, ctx) {
    result = result || {}; ctx = ctx || {};
    const now = ctx.now || 0;
    const maxRetries = ctx.maxRetries != null ? ctx.maxRetries : 3;
    const backoffMs = ctx.backoffMs != null ? ctx.backoffMs : 90000;
    const maxConsecutive = ctx.maxConsecutiveFailures != null ? ctx.maxConsecutiveFailures : DEFAULT_MAX_CONSECUTIVE_FAILURES;
    return mapJob(jobs, id, (job) => {
      const ok = result.status === 'ok';
      const isOnce = !!(job.schedule && job.schedule.kind === 'once');
      const next = Object.assign({}, job);
      next.lastRunId = result.runId != null ? String(result.runId) : job.lastRunId;
      next.lastReason = result.reason != null ? String(result.reason) : null;
      next.lastStatus = ok ? 'ok' : 'error';
      next.lastError = ok ? null : (result.error != null ? String(result.error) : 'error');
      if (ok && result.output != null) next.lastOutput = String(result.output).slice(0, 32000);
      // the WORK LINE's stop facts for this fire (routing/line-fire.js lineFacts): null = no line, or a clean one
      next.lastLine = lineFactsOf(result.line);
      if (ok && result.monitorHash != null) {
        next.monitorHash = String(result.monitorHash).slice(0, 200);
        next.monitorLastCheckedAt = iso(now);
      }
      // G4.5: ANY settlement (success, terminal failure, OR transient failure) means the run is no longer
      // in flight, so CLEAR the one-shot fire-claim. The not-due guard must only suppress re-fire WHILE
      // actually running — a transient settlement clears the claim so the backoff path below can re-arm
      // the one-shot without being suppressed by a stale claim. (lastFireAttemptAt is left as the audit trail.)
      next.fireClaim = null;
      // NS-0: clear the liveness heartbeat on the SAME settlement — the run is no longer in flight, so a
      // stale heartbeat must never suppress a legitimately-re-arming (transient-backoff) one-shot.
      next.heartbeatAt = null;

      // transient failure with retries left: back off, stay eligible, do NOT finalize the occurrence.
      if (!ok && result.transient && (job.retryCount || 0) < maxRetries) {
        next.retryCount = (job.retryCount || 0) + 1;
        // Preserve the ANCHORED occurrence before rewinding to the backoff instant: planTick advances an
        // interval from its due instant, and anchoring on `now+backoff` phase-shifted the schedule
        // permanently (+backoff per transient). The first transient of this occurrence stamps the anchor
        // (nextRunAt still holds the advance-before-run value); later retries keep the original.
        next.retryAnchorAt = job.retryAnchorAt || job.nextRunAt || null;
        // RAMPED BACKOFF (2026-10-01): 1×, 3×, 9× the base (90s → 4.5m → 13.5m by default). A fixed 90s burned
        // all three retries inside ~5 minutes — shorter than most provider blips and network drops it exists for.
        next.nextRunAt = iso(now + backoffMs * Math.pow(3, Math.min(job.retryCount || 0, 3)));
        next.state = 'error';                  // visible as failing-and-retrying, but still scheduled to fire
        return next;
      }

      // terminal: finalize this occurrence.
      const pending = pendingDeliveries(job).filter(f => f.runId !== String(next.lastRunId || ''));
      if (pending.length >= MAX_PENDING_DELIVERIES) throw new Error('routine delivery backlog is full; reconnect the destination');
      next.deliveryBacklog = pending;
      next.lastUsd = Number.isFinite(Number(result.usd)) ? Number(result.usd) : 0;
      next.finalization = {
        id: String(next.lastRunId || job.id) + ':final', runId: String(next.lastRunId || ''), state: 'pending',
        outcome: ok ? (String(result.output || '').trim() === '[SILENT]' ? 'silent' : 'ok') : 'failed',
        result: ok ? String(result.output || '').slice(0, 32000) : '', error: ok ? null : next.lastError,
        usd: next.lastUsd, deliver: String(job.deliver || 'local'), origin: job.origin || null,
        deliveryContext: { name: job.name, prompt: job.prompt, agentId: job.agentId, noAgent: job.noAgent, attachToSession: job.attachToSession },
        destination: String(job.deliver || 'local'), committedAt: iso(now), attempts: 0
      };
      next.retryCount = 0;
      next.retryAnchorAt = null;   // the occurrence is settled — the retry re-anchor must not outlive it
      // CONSECUTIVE-FAILURE COUNTER (durable): terminal failures in a row; any ok/silent settlement resets it.
      next.consecutiveFailures = ok ? 0 : ((Number(job.consecutiveFailures) || 0) + 1);
      next.lastRunAt = iso(now);
      next.repeat = Object.assign({}, job.repeat, { completed: ((job.repeat && job.repeat.completed) || 0) + 1 });
      const exhausted = next.repeat.times != null && next.repeat.completed >= next.repeat.times;

      if (isOnce || exhausted) {
        next.enabled = false;
        next.nextRunAt = null;
        next.state = ok ? 'completed' : 'error';
        return next;
      }
      // recurring continues
      if (ok) {
        next.state = 'scheduled';              // nextRunAt left as planTick advanced it (advance-before-run)
      } else if (maxConsecutive > 0 && next.consecutiveFailures >= maxConsecutive) {
        // AUTO-DISABLE: N terminal failures in a row means the routine is broken, not unlucky — re-arming it
        // forever would spend forever. Pause it durably with a governed reason; the finalization (which rides
        // the normal delivery path) tells the Commander, and resumeJob clears the streak on re-enable.
        next.enabled = false;
        next.nextRunAt = null;
        next.state = 'error';
        next.disabledReason = 'consecutive-failures';
        next.disabledAt = iso(now);
        next.finalization.error = String(next.finalization.error || 'The run failed.')
          + '\n\nRoutine paused after ' + next.consecutiveFailures + ' consecutive failures. Fix it, then re-enable it from ROUTINES.';
      } else {
        next.nextRunAt = armAt(job.schedule, next.lastRunAt, now, ctx && ctx.defaultTz) || job.nextRunAt;  // re-arm defensively
        next.state = 'error';                  // visible, but enabled stays true
      }
      return next;
    });
  }

  /* loadEnvelope — normalize whatever came off disk into a valid { version, jobs } envelope. Tolerates a
     JSON string, a parsed object, null, or garbage; fail-closed to an empty store. Drops malformed job
     records (missing/invalid id) rather than trusting them. */
  function loadEnvelope(raw) {
    let obj = raw;
    if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch (e) { obj = null; } }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.jobs)) return { version: ENVELOPE_VERSION, jobs: [] };
    const jobs = obj.jobs.filter(j => j && typeof j === 'object' && isValidId(j.id));
    return { version: ENVELOPE_VERSION, jobs: jobs };
  }

  /* GRANTS BIND TO THE APPROVED INSTRUCTION (2026-09-23 security audit). Returns the unattended grants an AGENT
     edit must drop: rewriting a granted routine's prompt would otherwise inherit the Commander's standing
     workbench/connectors power for an instruction the Commander never saw. Pure; the Commander's own edit path
     (POST /api/cron/update) does not call this. */
  function grantsRevokedByAgentEdit(current, patch) {
    if (!current || !patch || !Object.prototype.hasOwnProperty.call(patch, 'prompt')) return [];
    if (String(patch.prompt == null ? '' : patch.prompt) === String(current.prompt == null ? '' : current.prompt)) return [];
    return normGrants(current.unattendedGrants);
  }

  function toEnvelope(jobs) { return { version: ENVELOPE_VERSION, jobs: (jobs || []).slice() }; }

  return {
    makeJob: makeJob,
    createJob: createJob,
    updateJob: updateJob,
    grantsRevokedByAgentEdit: grantsRevokedByAgentEdit,
    pauseJob: pauseJob,
    resumeJob: resumeJob,
    triggerJob: triggerJob,
    claimOnceFire: claimOnceFire,
    renewOnceHeartbeat: renewOnceHeartbeat,
    markRun: markRun,
    markDelivery: markDelivery,
    pendingDeliveries: pendingDeliveries,
    supersedeDeliveries: supersedeDeliveries,
    deliveriesHeld: deliveriesHeld,
    undeliveredCount: undeliveredCount,
    MAX_PENDING_DELIVERIES: MAX_PENDING_DELIVERIES,
    markBlockedConfig: markBlockedConfig,
    clearBlockedConfig: clearBlockedConfig,
    markMonitorCheck: markMonitorCheck,
    setNotepad: setNotepad,
    markUnfireable: markUnfireable,
    markInterrupted: markInterrupted,
    UNFIREABLE_ERROR: UNFIREABLE_ERROR,
    DEFAULT_MAX_CONSECUTIVE_FAILURES: DEFAULT_MAX_CONSECUTIVE_FAILURES,
    removeJob: removeJob,
    getJob: getJob,
    loadEnvelope: loadEnvelope,
    toEnvelope: toEnvelope,
    isValidId: isValidId,
    ENVELOPE_VERSION: ENVELOPE_VERSION
  };
});
