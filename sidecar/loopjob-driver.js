/* sidecar/loopjob-driver.js — the LOOP tick DRIVER (standing objectives, S1), determinism-split clean.

   The orchestration half of the loop subsystem: it owns the per-tick decision flow (roll each loop's daily
   budget bucket → ask the pure gate whether an iteration may fire → CLAIM + persist BEFORE launching →
   fire through the injected run host → harvest → settle + persist → ledger the decision) and the in-flight
   LEASE map. Every ambient dependency is INJECTED — there is NO Date.now / Math.random / new Date() /
   setInterval / setTimeout / fs / crypto here, so it passes test/lint-determinism.js and is headless-testable
   with a fake clock + a fake runOnce, exactly like cron-driver.js and nightshift-driver.js. The ambient half
   — the real setInterval, Date.now, crypto.randomUUID, the loops.json load/persist, the boot reconcile —
   lives ONLY in sidecar/index.js (the lint-exempt composition root).

   makeLoopDriver(deps) -> { applyTick(nowMs) -> {fired,skipped,deferred,planned}, leases:Map, abortAllLeases() }

     deps.getLoops()        -> LoopJob[]           // read the live store (index.js mirror)
     deps.setLoops(loops)   -> bool                // replace + PERSIST; FALSE means the write did not reach
                                                   //   disk, and the driver then fires NOTHING this tick
     deps.runOnce(opts)     -> Promise<result>     // the SAME run host the browser uses (index.js runOnce)
     deps.newId()           -> string              // a fresh runId (crypto.randomUUID in index.js)
     deps.newAbort()        -> AbortController
     deps.now()             -> int ms              // wall clock for COMPLETION timestamps (a run settles long
                                                   //   after applyTick's nowMs is stale)
     deps.isHalted()        -> bool                // the durable station E-STOP
     deps.concurrencyFree(agentId) -> bool         // the agent's run mutex
     deps.agentExists(agentId)     -> bool         // a loop whose agent was deleted must STOP, never fire
     deps.precheck({loop})  -> {ok,reason}|bool    // OPTIONAL purely-local readiness (credential, workdir still
                                                   //   blessed). A stand-down no model call could have avoided
                                                   //   must not cost money — nightshift's NS-2 cold-leash fix.
     deps.identityForAgent(agentId, loop) -> {system?, model?} | null
     deps.providerForLoop(loop, ident)    -> string
     deps.getKey(provider, loop)          -> string
     deps.hasCredential(provider, key, loop) -> bool
     deps.defaultModel      -> string
     deps.persona           -> string | ()=>string // the autonomous system prompt (re-read per fire if a getter)
     deps.harvest(loop, runResult, iterN) -> {title,summary,commit,files,usd,text} | Promise<...>
                                                   // OPTIONAL. Where S3 hangs the git work (commit the
                                                   //   iteration onto the loop branch) and where a non-git loop
                                                   //   reads its workshop manifest. Default = derive a title
                                                   //   from the run text and record nothing it cannot prove.
     deps.ledger(entry)     -> void                // autonomy-ledger append; source:'loop' is already allowed
     deps.tee(name, payload, {loopId,runId,iteration}) -> void
                                                   // OPTIONAL per-run event forwarder, so an unattended
                                                   //   iteration is observable live. The host applies its own
                                                   //   egress redaction (runTeeView), exactly as cron does.
     deps.heartbeatMs       -> int                 // throttle for the durable liveness write (30s)
     deps.maxParallel       -> int                 // loops that may have an iteration in flight at once (4)
     deps.maxRunMs          -> int                 // zombie-claim ceiling handed to the pure gate as staleMs

   NO loop.* BUS EVENTS, DELIBERATELY. shared/events.js is the FROZEN, OWNED contract; it carries no loop.*
   family and this lane does not get to invent one (additive changes go through the owner). So the driver emits
   nothing of its own: the LOOPS window polls GET /api/loops exactly as the ROUTINES window polls /api/cron, the
   durable audit trail rides the autonomy ledger (which already allows source:'loop'), and per-iteration
   visibility rides `tee` — which forwards the run's EXISTING agent.* contract events. test/lint-emits.js
   enforces this: an emit of an unregistered event name fails the gate, which is how the first draft's
   loop.fire/loop.result/loop.tick were caught.

   WHY ADVANCE-BEFORE-RUN MATTERS HERE. A loop has no wall-clock "next fire" to advance, so the crash-safety
   primitive is the durable fire-claim (loopjob-store.claimFire): stamp it, PERSIST it, and only then launch.
   If the persist fails we launch nothing — firing over an unpersisted claim is how a crash-restart
   double-spends. This is the same transactional-dispatch receipt cron-driver.js proved out. */
'use strict';
(function (root, factory) {
  const api = factory(
    typeof require === 'function' ? require('./loopjob.js') : (root.SK && root.SK.loopjob),
    typeof require === 'function' ? require('./loopjob-store.js') : (root.SK && root.SK.loopjobStore)
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).loopjobDriver = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (LJ, store) {
  'use strict';

  const DEFAULT_MAX_PARALLEL = 0;          // unlimited; positive values opt into a ceiling
  const DEFAULT_MAX_RUN_MS = 900000;      // 15 min — the zombie-claim ceiling, extended by live heartbeats
  const DEFAULT_HEARTBEAT_MS = 30000;     // durable liveness write interval while an iteration streams
  const TITLE_WORDS = 12;

  function noop() {}
  function isFn(v) { return typeof v === 'function'; }

  /* defaultHarvest — what we can honestly say about an iteration knowing ONLY the run result. The title is the
     model's own first line, trimmed; there is no commit and no file list because this layer performed no git
     and inspected no disk. S3 injects a real harvest that commits onto the loop branch and returns the sha.
     Claiming a commit we did not make would be exactly the lie the product forbids. */
  function defaultHarvest(loop, res) {
    const text = String((res && res.text) || '');
    const first = text.split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
    const title = first.replace(/^[#>*\-\s]+/, '').split(/\s+/).slice(0, TITLE_WORDS).join(' ');
    return {
      text: text,
      title: title || null,
      summary: text.slice(0, 1200) || null,
      commit: null,
      files: [],
      usd: (res && typeof res.usd === 'number' && isFinite(res.usd)) ? res.usd : 0
    };
  }

  function makeLoopDriver(deps) {
    deps = deps || {};
    const getLoops = deps.getLoops || (() => []);
    const setLoops = deps.setLoops || (() => true);
    const runOnce = deps.runOnce;
    const newId = deps.newId || (() => 'loop-run');
    const newAbort = deps.newAbort || (() => ({ abort() {}, signal: null }));
    const now = deps.now || (() => 0);
    const isHalted = deps.isHalted || (() => false);
    const concurrencyFree = deps.concurrencyFree || (() => true);
    const agentExists = deps.agentExists;
    const ledger = deps.ledger || noop;
    const harvest = isFn(deps.harvest) ? deps.harvest : defaultHarvest;
    const maxParallel = deps.maxParallel != null ? deps.maxParallel : DEFAULT_MAX_PARALLEL;
    const maxRunMs = deps.maxRunMs != null ? deps.maxRunMs : DEFAULT_MAX_RUN_MS;
    // how often a live iteration persists its liveness heartbeat. Throttled so the token path never writes.
    const heartbeatMs = deps.heartbeatMs != null ? deps.heartbeatMs : DEFAULT_HEARTBEAT_MS;
    const tee = isFn(deps.tee) ? deps.tee : null;
    /* THE HOST-RUN CHECK (S2). Two hooks, both optional — a loop with no check behaves exactly as before.
         snapshot(loop) -> Promise<any>   taken BEFORE the iteration runs, so the check can attribute changed
                                          files to THIS iteration rather than to everything uncommitted.
         check(loop, { iterN, before }) -> Promise<Verdict>
       The verdict rides into settleIteration as result.check, where a red lands 'red' (feeds forward) and only
       a TRUSTED green may complete the objective. Deliberately NOT the model's business: the check command
       never enters the prompt and no tool can reach it. */
    const snapshot = isFn(deps.snapshot) ? deps.snapshot : null;
    const check = isFn(deps.check) ? deps.check : null;
    /* projectLine(loop) -> string. THE FOLDER THE LOOP WORKS IN, told to the agent.

       A dogfood run against a real repo failed three passes in a row with "the workspace is empty — no
       src/cart.js": the loop knew its workdir, the path grant allowed it, and the agent was never told the
       path existed. Relative paths resolve inside the agent's own jail, so a project-shaped loop that does
       not inject this is asking the agent to edit files it cannot find. The interactive path has always sent
       this (handleRun -> projectScopeLine); the loop driver simply never did. */
    const projectLine = isFn(deps.projectLine) ? deps.projectLine : null;
    /* context(loop) -> Promise<{ text, reachable, why }>. The PROJECT SNAPSHOT, and the proof the folder is
       readable at all. `reachable:false` ends the pass BEFORE the model call: a pass that cannot see the
       project can only produce a blind answer, and a blind "0 findings" would otherwise be counted as
       CONVERGENCE — the loop declaring "nothing left to do" about a project it never opened. A real dogfood
       run did exactly that. */
    const context = isFn(deps.context) ? deps.context : null;
    /* onStopped(loop, prevState) — fired the moment a loop stops being able to continue ON ITS OWN and starts
       needing the Commander: the review queue filled, it converged, it met its objective, or it parked itself.
       This is the honest trigger for a notification — not "a candidate appeared", which happens while the loop
       is still working and would be pure noise. Edge-triggered on the state TRANSITION, so a poll or a restart
       can never re-announce the same stop. */
    const onStopped = isFn(deps.onStopped) ? deps.onStopped : null;
    /* trackRun / untrackRun — register a live iteration in the host's run registry, exactly as the cron,
       night-shift, workshop and interactive paths do. This is what makes an agent STAY LIT at its desk:
       GET /api/state/snapshot is built from that registry, and the world's reconnect reconcile clears any
       agent absent from it — so without this, reloading the app mid-iteration darkens an agent that is
       genuinely still working. It also lets /api/cancel target a single loop pass. */
    const trackRun = isFn(deps.trackRun) ? deps.trackRun : null;
    const untrackRun = isFn(deps.untrackRun) ? deps.untrackRun : null;

    // loopId -> { runId, abort, startedAt }. In-memory only; the DURABLE half is the fire-claim on the record,
    // which is what survives a restart. Both are consulted by the gate.
    const leases = new Map();
    let bootReconciled = false;

    function personaOf() {
      const p = deps.persona;
      return isFn(p) ? String(p() || '') : String(p || '');
    }

    function note(kind, loop, extra) {
      try {
        ledger(Object.assign({
          source: 'loop', kind: kind, jobId: loop && loop.id, agentId: loop && loop.agentId
        }, extra || {}));
      } catch (_) { /* telemetry must never break a run */ }
    }

    /* buildMessages — the iteration prompt: the standing objective, then the LEDGER DIGEST. The digest is what
       makes this a loop rather than a retry storm; see loopjob.digest. */
    function buildMessages(loop, snapshotText) {
      const digest = LJ.digest(loop, {});
      const parts = [loop.objective];
      // the snapshot goes BEFORE the ledger: what the project looks like RIGHT NOW outranks what happened in
      // earlier passes, and it is the thing that stops the agent guessing at paths inside its own jail.
      if (snapshotText) parts.push(snapshotText);
      if (digest) parts.push(digest);
      return [{ role: 'user', content: parts.join('\n\n') }];
    }

    /* settle — record an iteration's outcome durably. Wrapped so that EVERY exit path from a fired run
       (success, throw, abort) lands here exactly once; an unsettled iteration would hold its claim until the
       zombie ceiling and stall the loop for maxRunMs. */
    function settle(loopId, runId, result) {
      const lease = leases.get(loopId);
      // A cancelled pass may finish its check/harvest after RESUME has fired a
      // replacement. Only the current generation can persist or release ownership.
      if (!lease || lease.runId !== runId) return false;
      const pending = lease && lease.runId === runId ? lease.settlement : null;
      const at = pending ? pending.at : now();
      const prev = store.getLoop(getLoops(), loopId);
      const prevState = prev && prev.state;
      const next = store.settleIteration(getLoops(), loopId, Object.assign({ runId: runId }, result), { now: at });
      let persisted = false;
      try { persisted = setLoops(next) !== false; } catch (_) { persisted = false; }
      if (!persisted) {
        // The iteration already ran. Keep its lease as a settlement receipt and retry only the durable write;
        // dropping ownership here lets the old fire claim age into a zombie and execute completed work twice.
        if (lease && lease.runId === runId && !lease.settlement) {
          lease.settlement = { at: at, result: Object.assign({}, result) };
        }
        note('defer', prev, { runId: runId, reason: 'settlement-persist-failed', binding: 'persist' });
        return false;
      }
      leases.delete(loopId);
      if (untrackRun && !(lease && lease.untracked)) { try { untrackRun(runId); } catch (_) {} }   // the desk goes quiet only when the pass really ends
      const loop = store.getLoop(next, loopId);
      const it = loop && (loop.iterations || []).slice().reverse().find(x => String(x.runId) === String(runId));
      note(result.status === 'ok' ? 'act' : 'decline', loop, {
        runId: runId,
        reason: it ? it.outcome : (result.status === 'ok' ? 'ok' : 'error'),
        binding: loop ? loop.state : null,
        detail: { iteration: it ? it.n : 0, usd: (it && it.usd) || 0, converged: !!(it && it.outcome === 'noop') }
      });
      /* NEEDS-YOU EDGE. A loop that fills its review queue, converges, meets its objective or parks itself has
         stopped being able to continue on its own. Fire ONCE on that transition — a level-triggered check would
         re-announce on every poll, and announcing each candidate would be noise while the loop is still working.
         The host decides what to do with it (a channel ping is opt-in and default OFF).
      */
      try {
        const NEEDS_YOU = { waiting: 1, done: 1, dormant: 1, paused: 1 };
        const after = store.getLoop(next, loopId);
        if (onStopped && after && NEEDS_YOU[after.state] && after.state !== prevState) onStopped(after, prevState || null);
      } catch (_) { /* a notification must never break a settlement */ }
      return next;
    }

    /* reconcileBoot — a fresh driver cannot own a RUNNING row loaded from disk: it has no matching in-memory
       lease or AbortController. That row is proof of an interrupted prior process, not proof that work is still
       alive. Reconcile once, before the first gate pass, and persist the recovery pause before allowing any new
       launch. The existing RESUME action is the only authority that re-arms it. */
    function reconcileBoot(nowMs) {
      if (bootReconciled) return;
      bootReconciled = true;
      for (const loop of getLoops()) {
        if (!loop || leases.has(loop.id)) continue;
        const hasRunning = (loop.iterations || []).some(it => it && it.outcome === 'running');
        if (!hasRunning) continue;
        const reason = 'interrupted by sidecar restart — review recovery evidence, then resume explicitly';
        const next = store.recoverInterruptedIteration(getLoops(), loop.id, reason, { now: nowMs });
        if (setLoops(next)) {
          const recovered = store.getLoop(next, loop.id) || loop;
          note('decline', recovered, {
            runId: loop.lastRunId || '', reason: 'restart-interrupted', binding: 'recovery',
            detail: { iteration: loop.iterationCount || 0 }
          });
        } else {
          // A failed recovery write must not fall through to the stale-claim re-fire path in this process.
          // Keep a synthetic lease as a fail-closed block; a later explicit restart/recovery can try again.
          leases.set(loop.id, { runId: String(loop.lastRunId || ''), abort: null, startedAt: nowMs, recoveryBlocked: true });
          note('defer', loop, { reason: 'recovery-persist-failed', binding: 'persist' });
        }
      }
    }

    /* fireLoop — launch ONE iteration. Returns true if a run was actually launched.

       Order is load-bearing: claim → PERSIST → start-iteration → PERSIST → launch. A failed persist at either
       step aborts before any spend (see the header's advance-before-run note). */
    function fireLoop(loop, nowMs) {
      const ident = deps.identityForAgent ? (deps.identityForAgent(loop.agentId, loop) || {}) : {};
      const provider = deps.providerForLoop ? deps.providerForLoop(loop, ident) : (loop.provider || null);
      const key = deps.getKey ? deps.getKey(provider, loop) : null;
      const hasCred = deps.hasCredential ? deps.hasCredential(provider, key, loop) : true;
      if (!hasCred) {
        note('skip', loop, { reason: 'no-credential', binding: 'precheck' });
        return false;
      }

      const runId = String(newId());

      // 1. durable claim, persisted BEFORE anything is launched.
      if (!setLoops(store.claimFire(getLoops(), loop.id, { now: nowMs }))) {
        note('defer', loop, { reason: 'claim-persist-failed', binding: 'persist' });
        return false;
      }
      // 2. take the iteration slot (iterationCount advances at START so a crash still burns it).
      if (!setLoops(store.startIteration(getLoops(), loop.id, { runId: runId, now: nowMs }))) {
        note('defer', loop, { reason: 'start-persist-failed', binding: 'persist' });
        return false;
      }

      const fresh = store.getLoop(getLoops(), loop.id) || loop;
      const iterN = fresh.iterationCount;
      const ac = newAbort();
      leases.set(loop.id, { runId: runId, abort: ac, startedAt: nowMs, beatAt: nowMs });
      if (trackRun) { try { trackRun(runId, fresh.agentId, ac); } catch (_) {} }
      // take the pre-iteration snapshot NOW (before any work), so the check can tell what THIS iteration
      // changed rather than inheriting every uncommitted edit from earlier iterations. A snapshot failure is
      // not fatal — it degrades the verdict to "cannot prove", which loopcheck already treats as unsafe.
      const beforeP = snapshot ? Promise.resolve().then(() => snapshot(fresh)).catch(() => null) : Promise.resolve(null);

      /* the per-run EMIT SINK, mirroring cron-driver's. It does three load-bearing jobs:

         1. LIVENESS. Every progress event proves the iteration is genuinely alive, so it renews the durable
            heartbeat (throttled — the token path must not persist on every delta). Without this a real
            long-running iteration outlives maxRunMs, gets declared a ZOMBIE, and is re-fired while still
            running. Nothing else calls store.renewHeartbeat, so the whole heartbeat mechanism hangs off here.
         2. OUTCOME CAPTURE. runOnce RESOLVES on a failed run and reports the failure through events, so a
            driver that trusted only the promise would settle a broken iteration as a review candidate and ask
            the Commander to approve work that never happened.
         3. VISIBILITY. Forwards to the injected tee so an unattended iteration is observable live, in exactly
            the redacted shape the host already applies to other autonomous runs. */
      // `buf` accumulates the streamed reply. runOnce does NOT return the assistant text (it resolves with
      // {reason, messages, usd, turns, …}), so the token stream is where the iteration's own account of its
      // work comes from — the same way cron-driver captures it. This is what the convergence reader and the
      // candidate title are read from, so without it every candidate is titleless and NOTHING-TO-DO is never seen.
      const state = { buf: '', errMsg: null, reason: null, cancelled: false };
      const sink = function (name, payload) {
        const p = payload || {};
        const lease = leases.get(loop.id);
        if (lease) {
          lease.beatAt = now();
          if (lease.beatAt - (lease.persistedBeatAt || 0) > heartbeatMs) {
            lease.persistedBeatAt = lease.beatAt;
            try { setLoops(store.renewHeartbeat(getLoops(), loop.id, { now: lease.beatAt })); } catch (_) {}
          }
        }
        if (name === 'agent.token') { state.buf += (p.delta || ''); return; }   // accumulated here; never teed out
        if (name === 'agent.tool_call') state.buf = '';
        if (name === 'agent.run.error') state.errMsg = p.message || 'run error';
        else if (name === 'capdenied') state.errMsg = state.errMsg || ('no ' + (p.need || 'capability') + ' — ' + (p.reason || ''));
        else if (name === 'agent.run.end') {
          state.reason = p.reason;
          if (p.reason === 'cancelled') state.cancelled = true;
        }
        if (tee) { try { tee(name, p, { loopId: loop.id, runId: runId, iteration: iterN }); } catch (_) {} }
      };

      note('fire', fresh, { runId: runId, reason: 'iteration-' + iterN, binding: 'verdict', detail: { iteration: iterN } });

      /* RESOLVE THE PROJECT CONTEXT BEFORE SPENDING. The slot and the durable claim are already taken (so a
         crash here still burns the iteration rather than replaying it), but the model call has not happened.
         An unreachable project ends the pass right here: a blind pass can only produce a blind answer, and a
         blind "0 findings" would be counted as convergence. */
      // No context dep (or a loop with no folder) launches SYNCHRONOUSLY, exactly as before — the async hop
      // exists only where there is something real to resolve first, so the common path keeps its old timing.
      if (!context) return launch('');

      const ctxP = Promise.resolve().then(() => context(fresh))
        .catch(e => ({ reachable: false, why: 'project scan failed: ' + ((e && e.message) || e) }));

      ctxP.then((ctx) => {
        ctx = ctx || { text: '', reachable: true };
        if (ctx.reachable === false) {
          return settle(loop.id, runId, {
            status: 'error',
            error: 'could not read the project folder — ' + (ctx.why || 'nothing was readable there') +
              '. The pass was stopped before spending anything.'
          });
        }
        return launch(ctx.text || '');
      }).catch((e) => {
        // SETTLE, never just drop the in-memory lease: by now claimFire + startIteration are PERSISTED and
        // trackRun has lit the agent. Deleting only the lease left the durable fireClaim reading in-flight
        // for the full staleMs on every tick, the iteration row 'running' forever, and the orphaned
        // runsMeta entry keeping the agent posed at its desk — then reconcileBoot paused the loop for an
        // "interrupted" iteration that never launched. settle() clears all three (and untracks the run).
        note('decline', fresh, { runId: runId, reason: 'context-threw', binding: 'internal', detail: { err: String((e && e.message) || e).slice(0, 200) } });
        try { settle(loop.id, runId, { status: 'error', error: 'iteration failed before launch: ' + ((e && e.message) || e) }); }
        catch (_) { try { leases.delete(loop.id); } catch (__) {} }
      });
      return true;

      function launch(snapshotText) {
      const currentLease = leases.get(loop.id);
      if (!currentLease || currentLease.runId !== runId || (ac.signal && ac.signal.aborted)) return false;
      const opts = {
        key: key,
        model: fresh.model || ident.model || deps.defaultModel,
        provider: provider,
        // the persona, plus the project-folder anchor when this loop works in a real folder
        system: (ident.system || personaOf()) + (projectLine ? String(projectLine(fresh) || '') : ''),
        messages: buildMessages(fresh, snapshotText),
        agentId: fresh.agentId,
        isTask: true,
        signal: ac.signal,
        runId: runId,
        streamId: 'loop-' + fresh.id,          // one durable stream per LOOP, so its iterations share a thread
        surface: 'autonomous',
        trigger: 'loop',
        station: deps.stationFor ? deps.stationFor(fresh.agentId) : undefined,
        // a per-iteration USD ceiling, when the Commander set one. 0 = ungoverned (budgetcaps.js semantics).
        maxCostUsd: (fresh.budget && fresh.budget.perIterationUsd) || undefined,
        emit: sink
      };

      let p;
      try { p = runOnce(opts); } catch (e) {
        settle(loop.id, runId, { status: 'error', error: (e && e.message) || 'run host threw' });
        return false;
      }

      // NOTE the harvest is invoked INSIDE a then-callback (not eagerly), so a harvest that throws
      // SYNCHRONOUSLY rejects this link rather than escaping the chain — an escaped throw here would be an
      // unhandled rejection that takes down a 24/7 process. The trailing .catch is the last-resort net: a
      // driver whose bookkeeping throws must degrade to a stranded lease, never to a dead sidecar.
      Promise.resolve(p)
        .then(
          (res) => {
            // E-STOP settles cancellation at the host boundary immediately. A provider/tool that ignores the
            // AbortSignal may still resolve later; generation-fence that stale completion before check/harvest.
            const live = leases.get(loop.id);
            if (!live || live.runId !== runId || (ac.signal && ac.signal.aborted)) return null;
            // runOnce RESOLVES on a failed run — the failure arrives through the sink (state.errMsg) or as an
            // end reason. Trusting the promise alone would park a broken iteration as a review candidate and
            // ask the Commander to approve work that never happened.
            if (state.cancelled) return settle(loop.id, runId, { status: 'error', cancelled: true, error: 'cancelled' });
            if (state.errMsg) return settle(loop.id, runId, { status: 'error', error: state.errMsg });
            const terminalReason = String(state.reason || (res && res.reason) || '');
            if (terminalReason !== 'done') {
              return settle(loop.id, runId, {
                status: 'error', cancelled: terminalReason === 'cancelled',
                error: 'run ended without completion: ' + (terminalReason || 'missing terminal outcome')
              });
            }
            // hand the harvest the run result WITH the streamed text folded in (runOnce doesn't carry it).
            const withText = Object.assign({}, res || {}, { text: (res && res.text) || state.buf });
            // RUN THE CHECK between the work and the settlement. A check that THROWS is not a pass and not a
            // silent skip — it becomes an explicit un-trusted verdict, because "we could not verify" must never
            // read as "verified fine".
            const checkP = check
              ? beforeP.then(before => check(fresh, { iterN: iterN, before: before }))
                .catch(e => ({ ran: true, passed: false, trusted: false, mustReview: true, tampered: false, tamperedPaths: [], gitProven: false, summary: '', note: 'the check could not be run — ' + ((e && e.message) || e) }))
              : Promise.resolve(null);
            // the harvest needs the SAME pre-iteration snapshot the check got: its commit pathspec is
            // after-minus-before, so without it a pass would stage files that were already dirty when the
            // loop started — the Commander's own work, swept into a commit a later rejection reverts.
            return checkP.then(verdict => beforeP.then(before =>
              Promise.resolve().then(() => {
                const live = leases.get(loop.id);
                if (!live || live.runId !== runId || (ac.signal && ac.signal.aborted)) return null;
                return harvest(fresh, withText, iterN, { before: before, check: verdict });
              }).then(
              (h) => settle(loop.id, runId, Object.assign(
                { status: 'ok', check: verdict },
                h || {},
                // the review card needs to show WHAT CHANGED. A harvest that proved its own file list wins;
                // otherwise fall back to what the check observed this pass.
                (h && h.files && h.files.length) ? {} : { files: (verdict && verdict.changedFiles) || [] },
                // the per-pass diff, captured by the host at settle time — what the review card actually shows
                { diff: (verdict && verdict.diff) || null }
              )),
              // a harvest failure (e.g. git refused the commit) is a REAL iteration failure, not a silent
              // success: the work did not land, so the loop must not park a candidate the Commander cannot act on.
              (e) => settle(loop.id, runId, { status: 'error', error: 'harvest: ' + ((e && e.message) || 'failed') })
            )));
          },
          (e) => {
            const live = leases.get(loop.id);
            if (!live || live.runId !== runId) return null;
            return settle(loop.id, runId, {
              status: 'error',
              cancelled: !!(e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')))),
              error: (e && e.message) || 'run failed'
            });
          }
        )
        .catch((e) => {
          const live = leases.get(loop.id);
          if (!live || live.runId !== runId) return;
          try { leases.delete(loop.id); } catch (_) {}
          note('decline', fresh, { runId: runId, reason: 'settle-threw', binding: 'internal', detail: { err: String((e && e.message) || e).slice(0, 200) } });
        });
      return true;
      }
    }

    /* applyTick — one pass over every loop. */
    function applyTick(nowMs) {
      reconcileBoot(nowMs);
      const halted = isHalted();
      let fired = 0, skipped = 0, deferred = 0, planned = 0;

      // Retry completed-but-not-yet-durable iteration receipts before considering any new fire. A pending
      // settlement is not a live process and must never be reclaimed/re-executed as a stale run.
      const settledThisTick = new Set();
      for (const entry of Array.from(leases.entries())) {
        const loopId = entry[0], lease = entry[1];
        if (!lease || !lease.settlement) continue;
        settle(loopId, lease.runId, lease.settlement.result);
        if (!leases.has(loopId)) settledThisTick.add(loopId);
      }

      // roll every loop's daily budget bucket first, persisting once if any changed. Done before the gate so a
      // loop that was budget-bound yesterday is genuinely free today rather than free-on-the-tick-after.
      const rolledAll = getLoops().map(l => LJ.rollBudgetDay(l, { now: nowMs }));
      if (rolledAll.some((l, i) => l !== getLoops()[i])) setLoops(rolledAll);

      for (const loop of getLoops()) {
        if (!loop) continue;
        if (settledThisTick.has(loop.id)) { skipped++; continue; }

        // a loop whose agent was deleted must STOP — never fire under a ghost, never silently keep spending.
        if (agentExists && loop.enabled !== false && !agentExists(loop.agentId)) {
          setLoops(store.stopLoop(getLoops(), loop.id, 'the agent "' + loop.agentId + '" no longer exists', { now: nowMs }));
          note('skip', loop, { reason: 'agent-missing', binding: 'precheck' });
          skipped++;
          continue;
        }

        const inFlight = leases.has(loop.id);
        const d = LJ.decide(loop, {
          halted: halted,
          agentBusy: !concurrencyFree(loop.agentId),
          inFlight: inFlight,
          precheck: deps.precheck ? deps.precheck({ loop: loop }) : undefined
        }, { now: nowMs, staleMs: maxRunMs });

        if (!d.fire) {
          // only the states that are genuinely a per-tick DECISION are worth a ledger row; a paused/stopped/
          // dormant loop would otherwise write a row every 60s forever and drown the real decisions.
          if (d.binding === 'concurrency' || d.binding === 'precheck' || d.binding === 'budget') {
            note('skip', loop, { reason: d.binding, binding: d.binding, detail: { note: d.detail || '' } });
          }
          skipped++;
          continue;
        }

        planned++;
        if (maxParallel > 0 && leases.size >= maxParallel) {
          // over the fan-out cap: HELD, not dropped. Nothing is advanced, so it is still eligible next tick.
          note('defer', loop, { reason: 'at-capacity', binding: 'concurrency-cap' });
          deferred++;
          continue;
        }
        if (fireLoop(loop, nowMs)) fired++; else skipped++;
      }

      return { fired: fired, skipped: skipped, deferred: deferred, planned: planned };
    }

    /* abortAllLeases — the E-STOP hook. Aborts every in-flight iteration; each one's rejection path settles it
       as 'cancelled', which costs neither the fail streak nor the dry streak. Returns how many were aborted.
       Must never throw: an E-STOP that fails halfway is worse than no E-STOP. */
    function abortLease(loopId, reason) {
      const lease = leases.get(loopId);
      if (!lease || lease.recoveryBlocked || lease.settlement) return false;
      try { if (lease.abort && isFn(lease.abort.abort)) lease.abort.abort(); } catch (_) {}
      try {
        settle(loopId, lease.runId, {
          status: 'error', cancelled: true, error: String(reason || 'cancelled by the Commander')
        });
      } catch (_) {}
      return true;
    }

    function abortAllLeases() {
      let n = 0;
      // abortLease/settle mutates the lease map, so iterate a stable snapshot. The host owns cancellation: once
      // E-STOP is accepted the loop is durably terminal even if a provider or tool ignores AbortSignal.
      for (const [loopId] of Array.from(leases.entries())) if (abortLease(loopId, 'cancelled by E-STOP')) n++;
      return n;
    }

    return {
      applyTick: applyTick,
      abortLease: abortLease,
      abortAllLeases: abortAllLeases,
      leases: leases,
      _internals: { fireLoop: fireLoop, settle: settle, reconcileBoot: reconcileBoot, buildMessages: buildMessages, defaultHarvest: defaultHarvest }
    };
  }

  return { makeLoopDriver: makeLoopDriver, DEFAULT_MAX_PARALLEL: DEFAULT_MAX_PARALLEL, DEFAULT_MAX_RUN_MS: DEFAULT_MAX_RUN_MS };
});
