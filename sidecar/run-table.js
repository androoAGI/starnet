/* sidecar/run-table.js — THE RUN TABLE: one registry of every live run (run-table lane, wave 3).

   WHY. The station keeps its live runs in four host maps (index.js runs, runsMeta, hostLiveRuns, runStopHandles), the channel
   hubs' per-chat inflight records and the subagent manager's view, and every reader hand-lists the ones it knows: the reconnect
   snapshot, the phone, STOP and steer by id, E-STOP, the process-fault containment and the update drain. A run that sits only in
   a registry a reader forgot is invisible to that reader: a /v1 run held at the provider is in no snapshot source (proven at
   0b8441064), and the phone's list misses hub, /v1 and background-worker runs by construction.

   S1 (THIS STEP) makes the table a SHADOW. index.js runOnce admits every run at its entry, BEFORE the conversation queue (a run
   waiting behind its conversation is live work too), and releases it in a finally around the whole call, so no exit (an end, a
   throw in the queue or in the run, a queued abort) leaves an entry behind. The overseer's review, the one run that drives the
   run core without runOnce, is admitted at its own site. Nothing reads the table yet but GET /api/diagnostics, which names every
   run a legacy registry holds that the table does not (missing): the superset proof that licenses moving the readers onto it.
   Later steps give the entry its stop, its one terminal emitter and its readers.

   PURE: no host imports, no ambient clock (the host injects `now`), no ids minted from randomness.

   makeRunTable({ now, note }) -> table
     admit(meta) -> run       meta as metaOf() builds it. Idempotent per runId and refcounted: admitting a runId that is already
                              live JOINS its entry (the first admit's facts stand; a later admit only fills what was left blank,
                              and a flag either admit knows is kept), and every admit owes exactly one run.release(). A meta with
                              no runId is ANONYMOUS: it counts in size() (the update drain's number) and live() never lists it.
       run.entry              the shared entry: { runId, agentId, source, startedAt, streamId, internal, outputOnly, surface,
                              trigger, lineId, dockId, delegated, state, refs }
       run.running()          the run has left its conversation queue: state 'queued' -> 'running' (idempotent)
       run.release()          this admission is over; the entry goes with its last admission. Once per admit: a second call is
                              noted (runtable.release-twice) and changes nothing, so a stray double release can never drop the
                              entry another admission still holds.
     get(runId) / has(runId)  by the caller's run id (an anonymous entry has none)
     size()                   every live entry, anonymous ones included
     live()                   the rows a live view may list: every entry admitted with a caller run id, except an output-only
                              repair (the /v1 caller's own repair of its run, a second call under that call). internal (the
                              desk's self-talk) and delegated (a worker whose stop its manager owns) ride as flags for the
                              reader to apply, exactly as the snapshot rows carry internal today.
     missing(ids)             the given run ids the table does not hold, deduplicated in first-seen order (falsy ids skipped)
   metaOf(o, known) -> meta   the admission facts of a runOnce option bag. source = o.runSource (a caller that knows it), else
                              known.source (the shadow phase hands the legacy runsMeta row, so an entry keeps the label that
                              registry gives the run today), else derived: a background worker 'subagent', a foreground worker
                              'delegated', a line or bay run 'host', a routine, night-shift or loop trigger its own, an
                              interactive directive 'interactive', anything else 'event'. delegated = a parent run or its own
                              steer (the subagent manager owns that stop), the same test runOnceTracked uses for stop handles. */
'use strict';

const STATES = Object.freeze({ QUEUED: 'queued', RUNNING: 'running' });
const TRIGGER_SOURCES = Object.freeze({ schedule: 'cron', manual: 'cron', nightshift: 'nightshift', loop: 'loop' });
const TEXT_FIELDS = ['agentId', 'source', 'streamId', 'surface', 'trigger', 'lineId', 'dockId'];
const FLAG_FIELDS = ['internal', 'outputOnly', 'delegated'];

function text(v) { return v == null ? '' : String(v); }

function derivedSource(r) {
  if (r.parentRunId) return typeof r.steer === 'function' ? 'subagent' : 'delegated';
  if (r.lineId || r.dockId) return 'host';
  const trigger = text(r.trigger);
  if (Object.prototype.hasOwnProperty.call(TRIGGER_SOURCES, trigger)) return TRIGGER_SOURCES[trigger];
  if (trigger === 'directive' && r.surface === 'interactive') return 'interactive';
  return 'event';
}

function metaOf(o, known) {
  const r = (o && typeof o === 'object') ? o : {};
  const k = (known && typeof known === 'object') ? known : {};
  return {
    runId: text(r.runId),
    agentId: text(r.agentId) || 'agent',
    source: text(r.runSource) || text(k.source) || derivedSource(r),
    startedAt: Number.isFinite(k.startedAt) ? k.startedAt : null,
    streamId: text(r.streamId),
    internal: !!r.internal,
    outputOnly: !!r.outputOnly,
    surface: text(r.surface),
    trigger: text(r.trigger),
    lineId: text(r.lineId),
    dockId: text(r.dockId),
    delegated: !!(r.parentRunId || typeof r.steer === 'function')
  };
}

function makeRunTable(opts) {
  const o = opts || {};
  const now = typeof o.now === 'function' ? o.now : () => 0;
  const note = typeof o.note === 'function' ? o.note : () => {};
  const entries = new Set();        // every live entry, anonymous ones included (size() counts these)
  const byRunId = new Map();        // caller runId -> entry

  function admit(meta) {
    const m = (meta && typeof meta === 'object') ? meta : {};
    const runId = text(m.runId);
    let entry = runId ? byRunId.get(runId) : null;
    if (entry) {
      for (const f of TEXT_FIELDS) if (!entry[f] && m[f]) entry[f] = text(m[f]);
      for (const f of FLAG_FIELDS) if (m[f]) entry[f] = true;
      entry.refs++;
    } else {
      entry = { runId: runId, agentId: text(m.agentId) || 'agent', source: text(m.source) || 'event',
        startedAt: Number.isFinite(m.startedAt) ? m.startedAt : now(), streamId: text(m.streamId),
        internal: !!m.internal, outputOnly: !!m.outputOnly, surface: text(m.surface), trigger: text(m.trigger),
        lineId: text(m.lineId), dockId: text(m.dockId), delegated: !!m.delegated, state: STATES.QUEUED, refs: 1 };
      entries.add(entry);
      if (runId) byRunId.set(runId, entry);
    }
    if (m.state === STATES.RUNNING) entry.state = STATES.RUNNING;
    let released = false;
    return {
      entry: entry,
      running() { if (!released) entry.state = STATES.RUNNING; },
      release() {
        if (released) { note('runtable.release-twice', new Error('run ' + (entry.runId || '(anonymous)') + ' was released twice')); return; }
        released = true;
        entry.refs--;
        if (entry.refs > 0) return;
        entries.delete(entry);
        if (entry.runId && byRunId.get(entry.runId) === entry) byRunId.delete(entry.runId);
      }
    };
  }

  function get(runId) { return byRunId.get(text(runId)) || null; }
  function has(runId) { return byRunId.has(text(runId)); }
  function size() { return entries.size; }

  function live() {
    const rows = [];
    for (const e of byRunId.values()) {
      if (e.outputOnly) continue;
      const row = { runId: e.runId, agentId: e.agentId, source: e.source, startedAt: e.startedAt, state: e.state };
      if (e.streamId) row.streamId = e.streamId;
      if (e.internal) row.internal = true;
      if (e.delegated) row.delegated = true;
      rows.push(row);
    }
    return rows;
  }

  function missing(ids) {
    const out = [];
    const seen = new Set();
    for (const raw of (ids && typeof ids[Symbol.iterator] === 'function') ? ids : []) {
      const id = text(raw);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (!byRunId.has(id)) out.push(id);
    }
    return out;
  }

  return { admit, get, has, size, live, missing };
}

module.exports = { makeRunTable, metaOf, STATES };
