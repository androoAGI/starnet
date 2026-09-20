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

  const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
  // Sets, not object literals: `({a:1})['constructor']` is truthy, so an object-literal allowlist
  // silently admits every Object.prototype key — and these keys come off persisted/model-supplied data.
  const TERMINAL = new Set(['done', 'error', 'refused', 'interrupted', 'stale']);
  const WATCH_EVENTS = new Set(['agent.run.start', 'agent.run.end', 'agent.run.error', 'agent.cost', 'checkpoint.created', 'verify.result', 'shell.exec']);

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
        projectRoot: r.projectRoot || '', workdir: r.workdir || '',
        parentStreamId: r.parentStreamId || '', streamId: r.streamId || '',
        generation: Math.max(1, Math.floor(Number(r.generation) || 1)),
        resultSchema: r.resultSchema || null, structuredResult: r.structuredResult == null ? null : r.structuredResult,
        validation: r.validation || null, repairRunId: r.repairRunId || '',
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
    function publishTask(r, status) {
      try { emit('task', { id: r.id, agentId: r.agentId, status: status, kind: 'subagent', title: clip(r.prompt, 80) }); } catch (_) {}
    }
    function destinationOf(r) { return String((r && r.destination) || ('lead:' + String((r && r.leadId) || 'agent'))); }
    function publishFinalization(r) {
      if (!r || !r.finalization || r.finalization.state !== 'pending') return false;
      publishTask(r, r.status === 'done' ? 'done' : 'failed');
      if (hooks && typeof hooks.invoke === 'function') {
        try { hooks.invoke('subagent_stop', { session_id: r.runId || '', extra: {
          finalization_id: r.finalization.id, destination: r.finalization.destination,
          child_session_id: r.runId || '', subagent_id: r.id || '', child_agent_id: r.agentId || '',
          child_status: r.status, child_reason: r.reason || '', prompt: String(r.prompt || '').slice(0, 500),
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
        status: 'running',
        reason: '',
        result: old && old.result ? old.result : '',
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
      controllers.set(rec.id, { ac: ac, generation: rec.generation });
      const runEmit = function (name, payload) {
        appendEvent(rec.id, name, payload);
        try { emit(name, payload); } catch (_) {}
      };
      /* HOOKS — subagent_stop. Fired on BOTH settle paths below, because "a delegated worker finished" is
         true whether it succeeded or died, and a hook that only hears about successes is a hook that cannot
         page you. Fire-and-forget: a worker's result is already recorded and published by the time this runs,
         so a slow or broken hook can delay nothing and lose nothing. */
      const fireSubagentStop = function (r, status, reason, result, usd) {
        if (!hooks || typeof hooks.invoke !== 'function') return;
        try {
          hooks.invoke('subagent_stop', {
            session_id: (r && r.runId) || '',
            extra: {
              // Every key here is a REAL field on the record (see the rec shape above) — a payload full of
              // undefined would make a hook's own logging useless in exactly the situation it was written for.
              child_session_id: (r && r.runId) || '', subagent_id: (r && r.id) || '',
              child_agent_id: (r && r.agentId) || '', child_status: status, child_reason: reason,
              prompt: String((r && r.prompt) || '').slice(0, 500),
              child_summary: String(result || '').slice(0, 2000), usd: usd || 0,
              parent_agent_id: (r && r.leadId) || ''
            }
          });
        } catch (_) {}
      };
      Promise.resolve().then(function () {
        return runner({ id: rec.id, runId: rec.runId, signal: ac.signal, emit: runEmit, record: view(rec),
          generation: rec.generation, steer: function () { return drainSteer(rec.id, rec.generation); } });
      }).then(function (result) {
        const owned = controllers.get(rec.id);
        if (owned && owned.generation === rec.generation) controllers.delete(rec.id);
        const cur = get(rec.id);
        // An interrupted generation can settle after its replacement has already started. It must never delete
        // the replacement's controller or overwrite that newer generation's durable state.
        if (cur && cur.generation !== rec.generation) return;
        if (cur && cur.status === 'interrupted') return;
        const status = !result ? 'refused' : (result.status || (result.reason === 'done' ? 'done' : 'done'));
        const fields = {
          status: status,
          reason: (result && result.reason) || (status === 'refused' ? 'refused' : 'done'),
          result: (result && result.result) || '',
          usd: (result && result.usd) || 0,
          structuredResult: result && result.structuredResult != null ? clone(result.structuredResult) : null,
          validation: result && result.validation ? clone(result.validation) : null,
          repairRunId: (result && result.repairRunId) || '',
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
      publishTask(next || rec, 'failed');
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

    function resume(id, runner) {
      id = safeId(id, 'subagent id');
      const rec = get(id);
      if (!rec) return { ok: false, error: 'no such subagent' };
      if (controllers.get(id)) return { ok: false, error: 'subagent is already running' };
      if (rec.status === 'done') return { ok: false, error: 'subagent already completed' };
      const started = start(Object.assign({}, rec, { id: rec.id, runId: newId(), attempts: rec.attempts || 0, startedAt: rec.startedAt || now() }), runner);
      return { ok: true, record: started };
    }

    load();
    reconcileFinalizations();
    return { list: list, get: get, activeRuns: activeRuns, start: start, steer: steer, interrupt: interrupt, interruptAll: interruptAll, resume: resume,
      reconcileFinalizations: reconcileFinalizations,
      _internals: { records: function () { return records; }, controllers: controllers, load: load, save: save, appendEvent: appendEvent, publishFinalization: publishFinalization, drainSteer: drainSteer } };
  }

  return { makeSubagentManager: makeSubagentManager };
});
