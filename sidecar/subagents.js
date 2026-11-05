/* sidecar/subagents.js - durable background subagent registry.

   team.dispatch(background:true) starts worker runs that outlive the tool call.
   This manager owns their observable state: status, event tail, result, abort
   controller, stale-on-restart marking, and resume. It deliberately emits only
   existing frozen events (task + agent.* forwarded by the runner), so it does
   not need shared/events.js changes.
*/
'use strict';
(function (root, factory) {
  let dw = null;
  try { dw = typeof require === 'function' ? require('./durable-write.js') : (root.SK && root.SK.durableWrite); } catch (_) {}
  const api = factory(dw && dw.writeFileDurable);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).subagents = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (writeFileDurableInjected) {
  'use strict';

  // durable single-file replace (fsync-before-rename); degrades to writeFileSync+rename for a test fs w/o fsync.
  const writeFileDurable = typeof writeFileDurableInjected === 'function' ? writeFileDurableInjected
    : function (deps, file, data) { const f = deps.fs; const tmp = file + '.' + (typeof process !== 'undefined' ? process.pid : 'p') + '.tmp'; f.writeFileSync(tmp, data); f.renameSync(tmp, file); };

  // failopen.note — the tagged SYNC swallow: a fail-open catch must never be invisible.
  const { note: failNote } = (typeof require === 'function') ? require('./failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };
  // TYPED OUTCOMES: a runner result that names no status is 'done' only when its run SUCCEEDED (frontend/app/runoutcome.js)
  const RunOutcome = (typeof require === 'function') ? require('../frontend/app/runoutcome.js') : (typeof globalThis !== 'undefined' ? globalThis.RunOutcome : null);

  const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
  // Sets, not object literals: `({a:1})['constructor']` is truthy, so an object-literal allowlist
  // silently admits every Object.prototype key — and these keys come off persisted/model-supplied data.
  const TERMINAL = new Set(['done', 'error', 'refused', 'interrupted', 'stale']);
  const WATCH_EVENTS = new Set(['agent.run.start', 'agent.run.end', 'agent.run.error', 'agent.cost', 'checkpoint.created', 'verify.result', 'shell.exec']);
  /* LIVENESS (Step 2 F3, Hermes audit 2026-09-22). A background worker has no wall clock by design (outliving the
     tool call is the point, and iteration/$ caps default off — a locked decision), so a HUNG worker used to stay
     `running` forever: no result, no failure, nothing for the lead or the overseer hand-back to act on. The fix is
     a no-PROGRESS check, never a duration cap (Hermes parity: heavy work must never be killed for taking long):
     any of these events from the worker's own runs proves it is alive — streamed tokens, a tool call or result,
     a cost booking, a compaction, a fallback. Quiet for STALL_MS (450s) between tool calls, or IN_TOOL_STALL_MS
     (1200s) while a tool call is still in flight (a long build/test is legitimately silent), and the host's
     sweep (checkStalls) aborts it and marks it `stale` with an honest reason and a finalization receipt. */
  /* A worker WAITING ON ITS MODEL is alive too (2026-09-23): provider.retry (a ladder rung announced before its
     backoff) and agent.waiting (the loop's heartbeat while a model call shows nothing yet — a slow first byte, a
     silent reasoning stream, a retry backoff) count as progress, so a deep-reasoning worker is no longer staled at
     450s for thinking. The model call itself stays bounded by the provider idle watchdog and the ladder; and a
     heartbeat whose wait has already outlasted the in-tool window (a stream trickling keep-alive bytes with no
     content) stops counting, so a wedged call can still be caught (see noteProgress). */
  const PROGRESS_EVENTS = new Set(['agent.run.start', 'agent.token', 'agent.tool_call', 'agent.tool_result', 'agent.cost',
    'cost.estimate', 'agent.compact', 'provider.fallback', 'tool.args.repaired', 'iteration.refunded', 'checkpoint.created',
    'verify.result', 'shell.exec', 'provider.retry', 'agent.waiting']);
  const DEFAULT_STALL_MS = 450000;
  const DEFAULT_IN_TOOL_STALL_MS = 1200000;
  // An abort REASON the worker's runner can read back (signal.reason.code) to report WHY it stopped.
  function stopReason(code, message) { const e = new Error(message); e.name = 'AbortError'; e.code = code; return e; }

  function safeId(id, label) {
    id = String(id || '');
    if (!ID_RE.test(id)) throw new Error('bad ' + (label || 'id'));
    return id;
  }
  function clip(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '...' : s;
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function makeSubagentManager(deps) {
    deps = deps || {};
    const fs = deps.fs, P = deps.pathMod, file = deps.file;
    const now = (deps.clock && typeof deps.clock.now === 'function') ? deps.clock.now : function () { return 0; };
    const emit = typeof deps.emit === 'function' ? deps.emit : function () {};
    // OPTIONAL hook spine (sidecar/hooks.js) — fires subagent_stop when a delegated worker settles. Absent =
    // byte-identical to before, which is every test and every caller that does not wire it.
    const hooks = (deps.hooks && typeof deps.hooks.invoke === 'function') ? deps.hooks : null;
    // Test-only crash seam: false means the process stopped after the receipt was durable and before publish.
    const afterFinalizationCommitted = typeof deps.afterFinalizationCommitted === 'function' ? deps.afterFinalizationCommitted : null;
    const keep = deps.keep || 200;
    // Liveness thresholds (see PROGRESS_EVENTS). 0 disables the sweep; the host passes its env knobs.
    const knobMs = (v, d) => { const n = Number(v); return (v != null && Number.isFinite(n) && n >= 0) ? Math.floor(n) : d; };
    const stallMs = knobMs(deps.stallMs, DEFAULT_STALL_MS);
    const inToolStallMs = Math.max(stallMs, knobMs(deps.inToolStallMs, DEFAULT_IN_TOOL_STALL_MS));
    let seq = 0;
    const newId = typeof deps.newId === 'function' ? deps.newId : function () { return 'sub_' + (++seq); };
    if (!fs || !P || !file) throw new Error('subagents.js requires { fs, pathMod, file }');

    let records = [];
    const controllers = new Map();

    function load() {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        records = raw && Array.isArray(raw.records) ? raw.records.filter(r => r && r.id) : [];
      } catch (_) { records = []; }
      let changed = false;
      records = records.map(r => {
        if (r.status === 'running' || r.status === 'queued') {
          changed = true;
          return Object.assign({}, r, { status: 'stale', reason: 'sidecar restarted before this worker finished', canResume: true, updatedAt: now() });
        }
        return r;
      });
      if (changed) save();
    }
    function save(strict) {
      try {
        const dir = P.dirname(file);
        fs.mkdirSync(dir, { recursive: true });
        const body = { version: 1, records: records.slice(-keep) };
        // durable (fsync-before-rename) so a hard kill can't leave the registry zero-length; a persistence
        // failure is now surfaced (loud warn) instead of silently swallowed — the registry drives resume/stale
        // marking, so a write we can't complete is worth knowing about.
        writeFileDurable({ fs: fs, path: P }, file, JSON.stringify(body));
        return true;
      } catch (e) {
        if (strict) throw e;
        try { console.warn('[subagents] registry save failed:', (e && e.message) || e); } catch (_) {}
        return false;
      }
    }
    /* forget(match) -> number: the forget registry's purge. A worker record keeps its lead's brief (prompt, context), its result and an event
       tail: words of the session it was delegated from. A settled record `match(record)` names is removed whole; one still running or queued
       keeps its place (its run, status and controller are live bookkeeping) and loses only those words. */
    function forget(match) {
      let n = 0;
      const next = [];
      for (const r of records) {
        if (!r || !match(r)) { next.push(r); continue; }
        if (!TERMINAL.has(r.status)) {
          const words = r.prompt || r.context || r.result || r.reason || r.structuredResult != null || (Array.isArray(r.events) && r.events.length);
          if (!words) { next.push(r); continue; }   // already scrubbed: a second pass takes nothing
          next.push(Object.assign({}, r, { prompt: '', context: '', result: '', structuredResult: null, events: [], reason: '' }));
        }
        n++;
      }
      if (!n) return 0;
      records = next;
      save(true);
      return n;
    }
    function findIndex(id) { return records.findIndex(r => r && r.id === id); }
    function get(id) {
      const i = findIndex(String(id || ''));
      return i >= 0 ? clone(records[i]) : null;
    }
    function view(r) {
      if (!r) return null;
      return {
        id: r.id, leadId: r.leadId, agentId: r.agentId, runId: r.runId, status: r.status, destination: r.destination || '',
        prompt: r.prompt, context: r.context || '', result: r.result || '', reason: r.reason || '', usd: r.usd || 0,
        parentRunId: r.parentRunId || '', cancelledBy: r.cancelledBy || '', noReportRun: r.noReportRun || '', stalledAfterMs: r.stalledAfterMs || 0,
        projectRoot: r.projectRoot || '', workdir: r.workdir || '',
        parentStreamId: r.parentStreamId || '', streamId: r.streamId || '',
        generation: Math.max(1, Math.floor(Number(r.generation) || 1)),
        resultSchema: r.resultSchema || null, structuredResult: r.structuredResult == null ? null : r.structuredResult,
        builder: r.builder === true, bounded: r.bounded === true, onlyHost: r.onlyHost || '',
        validation: r.validation || null, repairRunId: r.repairRunId || '',
        // the worker run's host-proven untrusted-content taint ('' = clean). team.subagents relays it with the
        // result text so the polling lead latches it too (sec-taint 09-25)
        taintedBy: r.taintedBy || '',
        // the restrictions it started under (sticky; team.resume ORs them into the resuming run's authority)
        originLimits: r.originLimits || null,
        artifacts: Array.isArray(r.artifacts) ? r.artifacts.slice(-40) : [],
        steerHistory: Array.isArray(r.steerHistory) ? r.steerHistory.slice(-40) : [],
        attempts: r.attempts || 0, startedAt: r.startedAt || 0, updatedAt: r.updatedAt || 0,
        completedAt: r.completedAt || 0, canInterrupt: !!controllers.get(r.id), canResume: !!r.canResume,
        working: r.status === 'running' && !!controllers.get(r.id) && r.confirmedAt > 0,
        events: Array.isArray(r.events) ? r.events.slice(-50) : []
      };
    }
    function list(filter) {
      filter = filter || {};
      return records.filter(r => {
        if (filter.leadId && r.leadId !== filter.leadId) return false;
        if (filter.agentId && r.agentId !== filter.agentId) return false;
        if (filter.status && r.status !== filter.status) return false;
        return true;
      }).map(view);
    }
    function patch(id, fields, strict) {
      const i = findIndex(id);
      if (i < 0) return null;
      const before = records[i];
      records[i] = Object.assign({}, records[i], fields || {}, { updatedAt: now() });
      try { save(!!strict); } catch (e) { records[i] = before; throw e; }
      return records[i];
    }
    function appendEvent(id, name, payload) {
      if (!WATCH_EVENTS.has(name)) return;
      const i = findIndex(id);
      if (i < 0) return;
      const r = records[i];
      const at = now();
      const ev = { ts: at, name: name, payload: payload || {} };
      const events = (Array.isArray(r.events) ? r.events : []).concat([ev]).slice(-80);
      // A durable background record says `running` as soon as it is queued, before runOnce has
      // crossed the provider/concurrency gates. Only the frozen run.start earns a WORKING claim.
      // Keep that confirmation outside the bounded event tail: a long worker can legitimately
      // produce more than 80 watched events before a reconnect asks which runs are still live.
      let confirmedAt = r.confirmedAt || 0;
      const eventRunId = payload && payload.runId ? String(payload.runId) : '';
      if (eventRunId && eventRunId === r.runId) {
        if (name === 'agent.run.start') confirmedAt = at;
        else if (name === 'agent.run.end') confirmedAt = 0;
      }
      records[i] = Object.assign({}, r, { events: events, confirmedAt: confirmedAt, updatedAt: at });
      save();
    }

    // Authoritative reconnect view for background workers. A controller proves this process still
    // owns the work; confirmedAt proves runOnce emitted agent.run.start; status excludes interrupted,
    // failed, completed, and restart-staled records. The frontend snapshot consumes this exact view
    // instead of guessing from a durable `running` label or losing the worker after an SSE reconnect.
    function activeRuns() {
      const out = [];
      for (const r of records) {
        if (!r || r.status !== 'running' || !controllers.get(r.id) || !(r.confirmedAt > 0)) continue;
        out.push({ runId: r.runId, agentId: r.agentId, startedAt: r.confirmedAt, source: 'subagent',
          subagentId: r.id, generation: Math.max(1, Math.floor(Number(r.generation) || 1)) });
      }
      return clone(out);
    }
    /* A SETTLED worker's bus status is its OUTCOME's (review 8.2: RunOutcome.ofWorker reads the ledger record back), never the bare ledger
       status. The ledger files every unsuccessful end that is no stop under 'error', and the bus said 'failed' for a stop (interrupt,
       cancelChildren), a question, a limit and a cut reply alike — the page's sound director plays the failure sting for 'failed'. The v7
       task status is a coarse lifecycle: a success, a failure, a stop and a question each their own, every other end that did not finish
       'unfinished', its outcome (and a failure's code) riding beside it. */
    const TASK_STATUS = { succeeded: 'done', failed: 'failed', stopped: 'stopped', asked: 'asked' };
    function publishTask(r, status) {
      const oc = status ? null : RunOutcome.ofWorker(r);
      if (!status && !oc) return;   // a record still running has no end to publish
      const ev = { id: r.id, agentId: r.agentId, status: status || TASK_STATUS[oc.outcome] || 'unfinished', kind: 'subagent', title: clip(r.prompt, 80) };
      if (oc) { ev.outcome = oc.outcome; if (oc.failureCode) ev.failureCode = oc.failureCode; }
      try { emit('task', ev); } catch (_) {}
    }
    function destinationOf(r) { return String((r && r.destination) || ('lead:' + String((r && r.leadId) || 'agent'))); }
    /* HOOKS — subagent_stop, fired from the one settle receipt (both settle paths and the liveness sweep publish through it, and a
       pending receipt is replayed at restart), because "a delegated worker finished" is true whether it succeeded or died: a hook that
       only hears about successes cannot page you. child_status / child_reason are the ledger's own fields; child_outcome /
       child_failure_code (additive, review 8.2) are the worker's one outcome (RunOutcome.ofWorker), so a hook that pages on child_status
       'error' has the word that tells a question or a limit from a failure. */
    function publishFinalization(r) {
      if (!r || !r.finalization || r.finalization.state !== 'pending') return false;
      publishTask(r);
      if (hooks && typeof hooks.invoke === 'function') {
        const oc = RunOutcome.ofWorker(r) || { outcome: '', failureCode: '' };
        try { hooks.invoke('subagent_stop', { session_id: r.runId || '', extra: {
          finalization_id: r.finalization.id, destination: r.finalization.destination,
          child_session_id: r.runId || '', subagent_id: r.id || '', child_agent_id: r.agentId || '',
          child_status: r.status, child_reason: r.reason || '', child_outcome: oc.outcome, child_failure_code: oc.failureCode || '', prompt: String(r.prompt || '').slice(0, 500),
          child_summary: String(r.result || '').slice(0, 2000), usd: r.usd || 0, parent_agent_id: r.leadId || ''
        } }); } catch (_) {}
      }
      patch(r.id, { finalization: Object.assign({}, r.finalization, { state: 'delivered', deliveredAt: now() }) }, true);
      return true;
    }
    function reconcileFinalizations() {
      let count = 0;
      for (const r of records.slice()) if (r && r.finalization && r.finalization.state === 'pending') {
        try { if (publishFinalization(r)) count++; } catch (_) { /* pending remains retryable */ }
      }
      return count;
    }
    function mergeOriginLimits(a, b) {
      a = a || {}; b = b || {};
      return { withholdHostPower: !!(a.withholdHostPower || b.withholdHostPower), untrustedEntry: !!(a.untrustedEntry || b.untrustedEntry),
        withholdTaste: !!(a.withholdTaste || b.withholdTaste), taintedBy: String(a.taintedBy || b.taintedBy || '').slice(0, 200) };
    }
    function upsertStart(meta) {
      const id = meta.id ? safeId(meta.id, 'subagent id') : safeId(newId(), 'subagent id');
      const t = now();
      const oldIndex = findIndex(id);
      const old = oldIndex >= 0 ? records[oldIndex] : null;
      const generation = Math.max(1, Math.floor(Number((old && old.generation) || 0)) + 1);
      const rec = {
        id: id,
        leadId: safeId(meta.leadId || 'agent', 'leadId'),
        agentId: safeId(meta.agentId || 'agent', 'agentId'),
        runId: safeId(meta.runId || newId(), 'runId'),
        prompt: String(meta.prompt || ''),
        // the lead's handoff block (G6): kept on the durable record so resume rebuilds the same opening
        // message a fresh dispatch composed — absent on pre-context records, which read back as ''.
        context: String(meta.context != null ? meta.context : ((old && old.context) || '')).slice(0, 8000),
        projectRoot: String(meta.projectRoot != null ? meta.projectRoot : ((old && old.projectRoot) || '')).slice(0, 4096),
        workdir: String(meta.workdir != null ? meta.workdir : ((old && old.workdir) || '')).slice(0, 4096),
        parentStreamId: String(meta.parentStreamId != null ? meta.parentStreamId : ((old && old.parentStreamId) || '')),
        streamId: String(meta.streamId != null ? meta.streamId : ((old && old.streamId) || '')),
        // The run that started THIS generation (a lead's team.dispatch/team.spawn, or the run that called
        // team.resume). A cancelled parent run cascades to it (cancelChildren); '' = no parent run to follow.
        parentRunId: String(meta.parentRunId || '').slice(0, 120),
        // the restrictions the worker STARTED under (host-minted, from the starting run's authority): sticky across
        // generations and only ever widened toward MORE restriction, so a later team.resume from an unrestricted lead
        // can never run a phone/non-owner/payload-started worker's prompt with Full Access (sweep 2026-10-02)
        originLimits: mergeOriginLimits(old && old.originLimits, meta.originLimits),
        cancelledBy: '',
        stalledAfterMs: 0,
        status: 'running',
        reason: '',
        result: old && old.result ? old.result : '',
        taintedBy: old && old.result && old.taintedBy ? old.taintedBy : '',   // the kept result keeps its provenance
        usd: 0,
        events: old && Array.isArray(old.events) ? old.events.slice(-80) : [],
        attempts: (meta.attempts || 0) + 1,
        startedAt: (old && old.startedAt) || meta.startedAt || t,
        updatedAt: t,
        completedAt: 0,
        canResume: false,
        generation: generation,
        confirmedAt: 0,
        destination: String(meta.destination || (old && old.destination) || ('lead:' + safeId(meta.leadId || 'agent', 'leadId'))),
        resultSchema: meta.resultSchema != null ? clone(meta.resultSchema) : ((old && old.resultSchema) || null),
        // the LENT BUILDER (team.dispatch builder:true): sticky, so team.resume restarts it with the same kit
        builder: meta.builder != null ? meta.builder === true : !!(old && old.builder === true),
        // the lead's bounded:true (orchestration.js boundOf): sticky the same way, so team.resume re-applies the lead's
        // bound from the record and never re-reads it from the prompt's wording (starnet-releases#5)
        bounded: meta.bounded != null ? meta.bounded === true : !!(old && old.bounded === true),
        // ...and its onlyHost (orchestration.js hostScopeOf, already normalized): the host scope team.resume re-applies
        onlyHost: String(meta.onlyHost != null ? meta.onlyHost : ((old && old.onlyHost) || '')).slice(0, 253),
        structuredResult: old && old.structuredResult != null ? clone(old.structuredResult) : null,
        validation: old && old.validation ? clone(old.validation) : null,
        repairRunId: '',
        artifacts: old && Array.isArray(old.artifacts) ? old.artifacts.slice(-40) : [],
        steerHistory: old && Array.isArray(old.steerHistory) ? old.steerHistory.slice(-40) : [],
        finalization: null
      };
      const i = oldIndex;
      if (i >= 0) records[i] = Object.assign({}, records[i], rec);
      else records.push(rec);
      save();
      publishTask(rec, 'running');
      return rec;
    }

    function start(meta, runner) {
      if (typeof runner !== 'function') throw new Error('subagent runner required');
      const rec = upsertStart(meta || {});
      const ac = new AbortController();
      // lastProgressAt/openTools are in-memory liveness state for THIS generation only (checkStalls): a restart
      // already stales every running record in load(), so nothing here needs to be durable.
      controllers.set(rec.id, { ac: ac, generation: rec.generation, lastProgressAt: now(), openTools: new Set(), holds: 0, heldSince: 0 });
      const runEmit = function (name, payload) {
        noteProgress(rec.id, rec.generation, name, payload);
        appendEvent(rec.id, name, payload);
        try { emit(name, payload); } catch (_) {}
      };
      /* A CALL HELD BY THE RUN'S SPEND POOL IS NOT A STALL (bug d3a76db3, review of 8f4267c08). The PER RUN pool
         (run-spend-pool.js) makes a worker's call WAIT while the calls in flight leave no room under the shared cap, and
         a held worker emits nothing: the sweep below stopped clones and background workers as "stalled" while a fellow's
         long call ran, in a family well under its cap. The runner reports each hold (orchestration.js, through the
         pool's watchHolds): while one is open the stall clock is stopped, and on release it resumes where it stopped —
         a held stretch is neither progress nor silence. Every hold waits on a call that IS in flight, which its own run's
         liveness and the provider's idle watchdog bound, so a hold always ends. */
      const ownControl = function () { const c = controllers.get(rec.id); return c && c.generation === rec.generation ? c : null; };
      const holdStall = function () {
        const c = ownControl();
        if (c && c.holds++ === 0) c.heldSince = now();
      };
      const releaseStall = function () {
        const c = ownControl();
        if (!c || c.holds === 0 || --c.holds > 0) return;
        const t = now();
        c.lastProgressAt = Math.min(t, (Number(c.lastProgressAt) || 0) + Math.max(0, t - c.heldSince));
      };
      // (the subagent_stop hook fires from publishFinalization, the one settle receipt both paths below commit: review 8.2 removed an
      // uncalled second copy of its payload here, which carried no outcome)
      Promise.resolve().then(function () {
        return runner({ id: rec.id, runId: rec.runId, signal: ac.signal, emit: runEmit, record: view(rec),
          generation: rec.generation, steer: function () { return drainSteer(rec.id, rec.generation); },
          holdStall: holdStall, releaseStall: releaseStall });
      }).then(function (result) {
        const owned = controllers.get(rec.id);
        if (owned && owned.generation === rec.generation) controllers.delete(rec.id);
        const cur = get(rec.id);
        // An interrupted generation can settle after its replacement has already started. It must never delete
        // the replacement's controller or overwrite that newer generation's durable state.
        if (cur && cur.generation !== rec.generation) return;
        if (cur && cur.status === 'interrupted') return;
        // The liveness sweep already settled this generation as stale (with its own receipt); the aborted run's
        // late 'cancelled' result must not rewrite that verdict into a success or a generic failure.
        if (cur && cur.status === 'stale' && cur.stalledAfterMs > 0) return;
        // a result with no status and no proven ending is an error, never 'done' (the gh#57 rule the crew's own rows keep)
        const status = !result ? 'refused' : (result.status || (RunOutcome.resolve({ reason: result.reason, finishReason: result.finishReason }).ok ? 'done' : 'error'));
        const fields = {
          status: status,
          reason: (result && result.reason) || (status === 'refused' ? 'refused' : status === 'done' ? 'done' : 'error'),
          result: (result && result.result) || '',
          usd: (result && result.usd) || 0,
          structuredResult: result && result.structuredResult != null ? clone(result.structuredResult) : null,
          validation: result && result.validation ? clone(result.validation) : null,
          repairRunId: (result && result.repairRunId) || '',
          taintedBy: result && typeof result.taintedBy === 'string' ? result.taintedBy.slice(0, 200) : '',
          artifacts: result && Array.isArray(result.artifacts) ? result.artifacts.slice(-40) : ((cur && cur.artifacts) || []),
          completedAt: now(),
          canResume: status !== 'done'
        };
        fields.finalization = { id: rec.runId + ':final', state: 'pending', destination: destinationOf(rec),
          result: fields.result, usd: fields.usd, committedAt: now() };
        const done = patch(rec.id, fields, true);
        if (afterFinalizationCommitted && afterFinalizationCommitted(clone(done)) === false) return;
        try { publishFinalization(done || rec); } catch (_) { /* the pending receipt is replayed at restart */ }
      }, function (e) {
        const owned = controllers.get(rec.id);
        if (owned && owned.generation === rec.generation) controllers.delete(rec.id);
        const cur = get(rec.id);
        if (cur && cur.generation !== rec.generation) return;
        if (cur && cur.status === 'interrupted') return;
        if (cur && cur.status === 'stale' && cur.stalledAfterMs > 0) return;
        const msg = 'worker run failed: ' + ((e && e.message) || e);
        const fields = { status: 'error', reason: 'error', result: msg, usd: 0, completedAt: now(), canResume: true,
          finalization: { id: rec.runId + ':final', state: 'pending', destination: destinationOf(rec), result: msg, usd: 0, committedAt: now() } };
        const done = patch(rec.id, fields, true);
        if (afterFinalizationCommitted && afterFinalizationCommitted(clone(done)) === false) return;
        try { publishFinalization(done || rec); } catch (_) { /* the pending receipt is replayed at restart */ }
      });
      return view(rec);
    }

    /* A steer is accepted only for the exact live generation the caller inspected. Persisting the pending row
       before returning closes the restart gap; draining marks it applied before the loop receives the text, so a
       later generation can never inherit an old follow-up. `leadId` is optional exactly like interrupt's: a
       lead-tool caller passes its own id (ownership enforced), the authenticated local HTTP route passes none
       (the Commander outranks ownership). `origin` keeps the history truthful about WHO steered — 'commander'
       rows are also prefixed at drain time so the worker knows the instruction's source. */
    function steer(id, leadId, generation, text, origin) {
      id = safeId(id, 'subagent id');
      const rec = get(id);
      if (!rec) return { ok: false, error: 'no such subagent' };
      if (leadId && rec.leadId !== String(leadId)) return { ok: false, error: 'subagent belongs to another lead' };
      const expected = Math.floor(Number(generation) || 0);
      if (expected !== rec.generation) return { ok: false, error: 'subagent generation changed', currentGeneration: rec.generation };
      const control = controllers.get(id);
      if (!control || control.generation !== rec.generation || rec.status !== 'running') return { ok: false, error: 'subagent generation is not running', currentGeneration: rec.generation };
      const note = String(text == null ? '' : text).trim().slice(0, 4000);
      if (!note) return { ok: false, error: 'steering text is required' };
      const at = now();
      const row = { generation: rec.generation, text: note, queuedAt: at, status: 'pending', origin: origin === 'commander' ? 'commander' : 'lead' };
      const history = (Array.isArray(rec.steerHistory) ? rec.steerHistory : []).concat([row]).slice(-40);
      patch(id, { steerHistory: history }, true);
      return { ok: true, id: id, generation: rec.generation, queuedAt: at };
    }

    function drainSteer(id, generation) {
      const i = findIndex(id);
      if (i < 0) return [];
      const rec = records[i];
      if (!rec || rec.status !== 'running' || rec.generation !== generation) return [];
      const history = Array.isArray(rec.steerHistory) ? rec.steerHistory.slice() : [];
      const notes = [];
      const at = now();
      let changed = false;
      for (let n = 0; n < history.length; n++) {
        const row = history[n];
        if (!row || row.generation !== generation || row.status !== 'pending') continue;
        // A Commander-origin note names its source so the worker weighs it as the Commander's word, not the lead's.
        notes.push((row.origin === 'commander' ? '[from the Commander] ' : '') + String(row.text || ''));
        history[n] = Object.assign({}, row, { status: 'applied', appliedAt: at });
        changed = true;
      }
      if (!changed) return [];
      const before = records[i];
      records[i] = Object.assign({}, rec, { steerHistory: history.slice(-40), updatedAt: at });
      try { save(true); } catch (_) { records[i] = before; return []; }
      return notes;
    }

    function interrupt(id, leadId) {
      id = safeId(id, 'subagent id');
      const rec = get(id);
      if (!rec) return { ok: false, error: 'no such subagent' };
      if (leadId && rec.leadId !== String(leadId)) return { ok: false, error: 'subagent belongs to another lead' };
      const control = controllers.get(id);
      if (control && control.ac) { try { control.ac.abort(); } catch (_) {} controllers.delete(id); }
      if (TERMINAL.has(rec.status) && rec.status !== 'running') return { ok: true, alreadyDone: true, record: rec };
      const next = patch(id, { status: 'interrupted', reason: 'interrupted', completedAt: now(), canResume: true });
      publishTask(next || rec);   // a stop: its outcome (stopped) and status, never 'failed' (review 8.2)
      return { ok: true, record: view(next || rec) };
    }

    function interruptAll(leadId) {
      let n = 0;
      for (const r of records.slice()) {
        if (leadId && r.leadId !== String(leadId)) continue;
        if (r.status === 'running' || controllers.get(r.id)) {
          const out = interrupt(r.id, r.leadId);
          if (out && out.ok) n++;
        }
      }
      return n;
    }

    // Liveness bookkeeping for one generation's events (see PROGRESS_EVENTS). A late event from a superseded
    // generation never refreshes the replacement's clock.
    function noteProgress(id, generation, name, payload) {
      const control = controllers.get(id);
      if (!control || control.generation !== generation || !PROGRESS_EVENTS.has(name)) return;
      // one model call silent for longer than the longest legitimate tool silence is wedged, not slow
      if (name === 'agent.waiting' && payload && Number(payload.sinceMs) > inToolStallMs) return;
      control.lastProgressAt = now();
      const callId = payload && payload.callId != null ? String(payload.callId) : '';
      if (name === 'agent.tool_call' && callId) control.openTools.add(callId);
      else if (name === 'agent.tool_result' && callId) control.openTools.delete(callId);
    }

    /* STOP REACHES BACKGROUND WORKERS (Step 2 F2, Hermes audit 2026-09-22). Each worker owns its own
       AbortController, deliberately NOT chained to its lead's signal: a background worker exists to OUTLIVE the
       tool call and the lead's normal end. But a lead run that was CANCELLED (Stop in COMMS, /stop in a channel,
       a superseding message, a disconnect, a reclaimed hung cron beat — any abort of the run's signal) used to
       leave every worker it had started running on, spending, with nobody left to read the result (audit probe
       D3: lead cancelled, worker still `running`). The host (index.js cascadeCancelToWorkers) calls this when a run's signal
       aborts WHILE the run is live; a run that ends normally detaches first and never cascades.
       There is no "detach" option on team.dispatch/team.spawn, and none is invented here: a worker follows the
       run that started its current generation (parentRunId). A Commander-driven resume has no parent run and so
       is never cascaded; interrupt/E-STOP still reach every worker as before.
       Honest state: `interrupted` + cancelledBy 'parent' + a reason naming the parent run, canResume true (the
       Commander can restart it), and the descendants of each cancelled worker are cancelled the same way. */
    function cancelChildren(parentRunId, why, depth) {
      const pid = String(parentRunId || '');
      const d = Math.max(0, Math.floor(Number(depth) || 0));
      if (!pid || d > 8) return 0;
      const because = String(why || ('its parent run ' + pid + ' was cancelled')).slice(0, 200);
      let n = 0;
      for (const r of records.slice()) {
        if (!r || r.parentRunId !== pid) continue;
        const control = controllers.get(r.id);
        if (r.status !== 'running' && !control) continue;
        // non-strict patch: a failed save is logged by save() and the in-memory verdict still stands (a restart
        // would stale a `running` row anyway — never resurrect it as live).
        const next = patch(r.id, { status: 'interrupted', reason: 'cancelled: ' + because, cancelledBy: 'parent', completedAt: now(), canResume: true });
        if (control && control.ac) {
          controllers.delete(r.id);
          try { control.ac.abort(stopReason('parent_cancelled', 'cancelled: ' + because)); } catch (e) { failNote('subagents.cancelChildren.abort', e); }
        }
        publishTask(next || r);   // its lead's Stop: stopped, never 'failed' (review 8.2)
        n++;
        n += cancelChildren(r.runId, 'its parent worker ' + r.id + ' was cancelled', d + 1);
      }
      return n;
    }

    /* The liveness sweep (see PROGRESS_EVENTS). The host calls it on a timer; tests call it after advancing the
       injected clock. Marks the record stale FIRST (durable, with a finalization receipt so the lead's
       team.subagents, the task feed, the subagent_stop hook and the overseer hand-back all see it), then aborts
       the run and cascades to anything the stalled worker started. Returns the stalled records' views. */
    function checkStalls() {
      if (!(stallMs > 0)) return [];
      const t = now();
      const out = [];
      for (const entry of Array.from(controllers.entries())) {
        const id = entry[0], control = entry[1];
        const i = findIndex(id);
        const r = i >= 0 ? records[i] : null;
        if (!r || r.status !== 'running' || r.generation !== control.generation) continue;
        if (control.holds > 0) continue;   // its call is waiting for room in the run's spend pool (holdStall above)
        const inTool = !!(control.openTools && control.openTools.size);
        const limit = inTool ? inToolStallMs : stallMs;
        const quiet = Math.max(0, t - (Number(control.lastProgressAt) || 0));
        if (quiet < limit) continue;
        const secs = Math.round(quiet / 1000);
        const reason = 'stalled: no progress for ' + secs + 's' + (inTool ? ' while a tool call was still running' : '')
          + ' — the liveness check stopped this worker (threshold ' + Math.round(limit / 1000) + 's)';
        const result = '[STOPPED — this background worker produced no tokens, tool activity or cost for ' + secs + 's'
          + (inTool ? ' while one of its tool calls was still running' : '')
          + ', so the host stopped it. Its work is INCOMPLETE and was not accepted. Inspect its event tail; resume it with team.resume if the work is still needed, or report the stall — do not present it as done.]';
        const fields = { status: 'stale', reason: reason, result: result, stalledAfterMs: quiet, completedAt: t, canResume: true,
          finalization: { id: r.runId + ':final', state: 'pending', destination: destinationOf(r), result: result, usd: r.usd || 0, committedAt: t } };
        let done = null;
        try { done = patch(id, fields, true); }
        catch (e) { failNote('subagents.checkStalls.patch', e); continue; }   // not durable yet: leave it running, the next sweep retries
        controllers.delete(id);
        try { control.ac.abort(stopReason('worker_stalled', reason)); } catch (e) { failNote('subagents.checkStalls.abort', e); }
        try { publishFinalization(done); } catch (e) { failNote('subagents.checkStalls.publish', e); }   // the pending receipt is replayed at restart
        cancelChildren(r.runId, 'its parent worker ' + id + ' stalled');
        out.push(view(records[findIndex(id)] || done));
      }
      return out;
    }

    function resume(id, runner, meta) {
      id = safeId(id, 'subagent id');
      const rec = get(id);
      if (!rec) return { ok: false, error: 'no such subagent' };
      if (controllers.get(id)) return { ok: false, error: 'subagent is already running' };
      if (rec.status === 'done') return { ok: false, error: 'subagent already completed' };
      // The new generation follows the run that resumed it (meta.parentRunId), never the run that started the old one.
      const parentRunId = meta && meta.parentRunId ? String(meta.parentRunId) : '';
      const started = start(Object.assign({}, rec, { id: rec.id, runId: newId(), attempts: rec.attempts || 0, startedAt: rec.startedAt || now(), parentRunId: parentRunId }), runner);
      return { ok: true, record: started };
    }

    load();
    reconcileFinalizations();
    return { list: list, get: get, forget: forget, activeRuns: activeRuns, start: start, steer: steer, interrupt: interrupt, interruptAll: interruptAll, resume: resume,
      reconcileFinalizations: reconcileFinalizations, cancelChildren: cancelChildren, checkStalls: checkStalls,
      stallPolicy: function () { return { stallMs: stallMs, inToolStallMs: inToolStallMs }; },
      _internals: { records: function () { return records; }, controllers: controllers, load: load, save: save, appendEvent: appendEvent, publishFinalization: publishFinalization, drainSteer: drainSteer } };
  }

  return { makeSubagentManager: makeSubagentManager };
});
