/* sidecar/run-table.js — THE RUN TABLE: one registry of every live run (run-table lane, wave 3).

   WHY. The station keeps its live runs in four host maps (index.js runs, runsMeta, hostLiveRuns, runStopHandles), the channel
   hubs' per-chat inflight records and the subagent manager's view, and every reader hand-lists the ones it knows: the reconnect
   snapshot, the phone, STOP and steer by id, E-STOP, the process-fault containment and the update drain. A run that sits only in
   a registry a reader forgot is invisible to that reader: a /v1 run held at the provider is in no snapshot source (proven at
   0b8441064), and the phone's list misses hub, /v1 and background-worker runs by construction.

   S1 makes the table a SHADOW. index.js runOnce admits every run at its entry, BEFORE the conversation queue (a run waiting
   behind its conversation is live work too), and releases it in a finally around the whole call, so no exit (an end, a throw in
   the queue or in the run, a queued abort) leaves an entry behind. The overseer's review, the one run that drives the run core
   without runOnce, is admitted at its own site. Nothing reads the table yet but GET /api/diagnostics, which names every run a
   legacy registry holds that the table does not (missing): the superset proof that licenses moving the readers onto it.

   S2 makes each entry its run's ONE TERMINAL EMITTER. A run's start and end were hand-written at nineteen sites, and a run whose
   host threw after its start ended nowhere: no end on its caller's stream or on the station floor (proven at 0b8441064 on /v1 and
   Run Now), and its history row booked a known $0 over a call its stream had already priced.

   S3 makes the table the REGISTRY ITS READERS READ, and each entry its run's STOP. The reconnect snapshot, the phone's status and
   stop, STOP and steer by id, E-STOP, the process-fault quiesce and the update drain read the table; the stop controller runOnce
   made for a run after its conversation queue (index.js runStopHandles) is now the entry's, from admission, so a turn still
   waiting in that queue is stoppable by its id too.

   PURE: no host imports, no ambient clock (the host injects `now`), no ids minted from
   randomness.

   makeRunTable({ now, note }) -> table
     admit(meta, owner?) -> run  owner may supply { stop, signal } for pre-core host work; its callback stays with this lease.
                              meta as metaOf() builds it. Idempotent per runId and refcounted: admitting a runId that is already
                              live JOINS its entry (the first admit's facts stand; a later admit only fills what was left blank,
                              and a flag either admit knows is kept), and every admit owes exactly one run.release(). A meta with
                              no runId is ANONYMOUS: it counts in size() (the update drain's number) and live() never lists it.
       run.entry              the shared entry: { runId, agentId, source, startedAt, streamId, internal, outputOnly, surface,
                              trigger, lineId, dockId, delegated, state, refs } and its terminal facts { started, ended, usd,
                              tokens, called } with guard/finish/settle below
       run.running()          the run has left its conversation queue: state 'queued' -> 'running' (idempotent)
       run.join(signal) -> signal'  (S3) this admission's run signal joined with its ENTRY'S STOP, an AbortController the entry
                              holds while a joined admission lives (index.js runOnce joins at admission, ahead of the queue): a stop
                              by the run's id is the same abort its owner's own would be. The signal comes back unchanged for a
                              delegated worker (its manager owns its stop and its steering), an id-less run (nothing can name it), a
                              second join of one admission, and without AbortSignal.any (the guard runOnceTracked had). The stop's
                              runSignal is the first joined signal: the counting rule below reads it. The stop goes with the last
                              joined admission, so a later run under the same id gets a fresh one, as runOnceTracked's did.
       run.release()          this admission is over; the entry goes with its last admission. Once per admit: a second call is
                              noted (runtable.release-twice) and changes nothing, so a stray double release can never drop the
                              entry another admission still holds.
     get(runId) / has(runId)  by the caller's run id (an anonymous entry has none)
     size()                   every live entry, anonymous ones included
     groupBusy(agentId)        an unreleased admission explicitly marked blocksGroup:true belongs to this agent. This is
                              per-admission lifetime, not a sticky entry flag: an unrelated join never keeps it alive.
     live()                   the rows a live view may list: every entry admitted with a caller run id, except an output-only
                              repair (the /v1 caller's own repair of its run, a second call under that call). internal (the
                              desk's self-talk) and delegated (a worker whose stop its manager owns) ride as flags for the
                              reader to apply, exactly as the snapshot rows carry internal today.
     missing(ids)             the given run ids the table does not hold, deduplicated in first-seen order (falsy ids skipped)
   STOPS (S3):
     stopOwners(cause)       invokes only admission-owned host callbacks, counting each owned entry once even if already
                              aborted or its callback throws: the legacy host-map stop-attempt count. Does not touch joined-only
                              core stops. The final stopAll phase may call an owner again, as the old map kill plus table stop
                              did; owner callbacks must remain idempotent. No sticky stop state is introduced.
     stoppable(runId)         a STOP or a direction by this id reaches the run: its entry holds a stop
     stop(runId, cause)       aborts that run's stop -> true when it held one (POST /api/cancel's `stopped`). An abort that throws
                              is noted (runtable.stop.<cause>).
     stopAll(cause)           aborts every entry's stop and returns how many of those runs no other kill had reached yet: the
                              fresh-abort counting rule (a stop's runSignal is its run's joined signal, so a run its
                              owner's abort already reached reads aborted there and is not counted twice). E-STOP ('estop'), the
                              process-fault quiesce ('fault') and INSTALL ANYWAY ('update') call it after their owner kills. An
                              abort that throws is noted (runtable.stop.<cause>), not counted, and never stops the rest.
   THE TERMINAL EMITTER (S2), on every entry:
     entry.guard(chain) -> emit   heads the run's emitter chain (index.js runOnceCore: guard -> outcome sink -> floor tee ->
                              observer tee -> caller sink). For the entry's own run id: the first agent.run.start passes and a
                              repeat is dropped and noted (runtable.duplicate-start); every agent.run.end goes through finish();
                              agent.cost usd and tokens are summed as the run's OBSERVED floor; and a sign the model was called (a
                              booked cost, a usage estimate, streamed text, a tool call the model asked for, a wait on the
                              provider) sets `called`. Another run's events (a delegated worker forwarded on this stream) pass
                              untouched. The first chain bound is the one the belt ends the run through.
     entry.finish(end, via)   emits the run's one end through `via` (else the bound chain); a second is dropped and noted
                              (runtable.duplicate-end)
     entry.settle(err, caller) THE BELT, run when the run's caller is handed its result (index.js runOnce's finally). A run that
                              started and never ended gets one error (the run's own words as 'sidecar failure: …', failureCode
                              no_terminal_outcome) and one end (reason error, usd the observed floor) through its bound chain, so
                              the floor and a watching terminal see it and the outcome sink stamps it. A run that never started
                              gets the balanced receipt on caller.emit only (the floor never lights a run that never ran); with no
                              caller sink, nothing. An ended or anonymous run gets nothing. Never throws. -> true when it ended
                              the run.
   refuseRun(emit, ids, r)    the balanced receipt the up-front refusals hand-wrote, byte for byte: start { agentId, runId,
                              trigger, model, ...ids.extra }, then r.token as one agent.token, then (with r.message) the error
                              { agentId, runId, transient, ...r.errorExtra, message, failureCode? }, then the end { agentId, runId,
                              the receipt's own stop word (default 'error'), turns: 0, usd: 0 }, which the run's outcome sink stamps
                              downstream. The script-only receipt ends 'done' with its token; a run cancelled while queued ends
                              'cancelled' with no error.
   thrownReceipt(emit, ids, err, started, usd)  the belt's receipt: [start if !started,] error { agentId, runId, message
                              'sidecar failure: …', transient: false, failureCode: no_terminal_outcome }, end { reason 'error',
                              turns 0, usd }. Also a host route's own throw before the run began (index.js handleRun).
   metaOf(o, known) -> meta   the admission facts of a runOnce option bag. source = o.runSource (a caller that knows it), else
                              known.source (the shadow phase hands the legacy runsMeta row, so an entry keeps the label that
                              registry gives the run today), else derived: a background worker 'subagent', a foreground worker
                              'delegated', a line or bay run 'host', a routine, night-shift or loop trigger its own, an
                              interactive directive 'interactive', a run a surface names by its taskSource that surface (a channel
                              hub's run its channel, every Telegram bot's 'telegram', as the snapshot named hub runs; /v1 'api'),
                              anything else 'event'. delegated = a parent run or its own steer (the subagent manager owns that
                              stop), the test runOnceTracked used for stop handles. */
'use strict';

const STATES = Object.freeze({ QUEUED: 'queued', RUNNING: 'running' });
const TRIGGER_SOURCES = Object.freeze({ schedule: 'cron', manual: 'cron', nightshift: 'nightshift', loop: 'loop' });
const TEXT_FIELDS = ['agentId', 'source', 'streamId', 'surface', 'trigger', 'lineId', 'dockId'];
const FLAG_FIELDS = ['internal', 'outputOnly', 'delegated'];
const NO_TERMINAL = 'no_terminal_outcome';   // RunOutcome.NO_TERMINAL (frontend/app/runoutcome.js): nothing proved how the run ended
// the loop emits these for a run only once a provider call is out
const CALL_EVENTS = new Set(['agent.cost', 'cost.estimate', 'agent.token', 'agent.tool_call', 'agent.waiting']);

function text(v) { return v == null ? '' : String(v); }
function idOf(p) { return (p && typeof p === 'object') ? text(p.runId) : ''; }
function amount(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }

function derivedSource(r) {
  if (r.parentRunId) return typeof r.steer === 'function' ? 'subagent' : 'delegated';
  if (r.lineId || r.dockId) return 'host';
  const trigger = text(r.trigger);
  if (Object.prototype.hasOwnProperty.call(TRIGGER_SOURCES, trigger)) return TRIGGER_SOURCES[trigger];
  if (trigger === 'directive' && r.surface === 'interactive') return 'interactive';
  const surface = text(r.taskSource).split(':')[0];   // 'telegram:<bot>' is a Telegram bot's hub: 'telegram'
  if (surface) return surface;
  return 'event';
}
// joins a run's signal with its entry's stop; null where the runtime has no AbortSignal.any (no stop by id there, as before)
const anySignal = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') ? list => AbortSignal.any(list) : null;

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

function refuseRun(emit, ids, r) {
  // the receipt's own stop word (a refusal's 'error', the line budget's 'budget', a script-only 'done', a queued 'cancelled')
  const { token, message, transient = false, errorExtra, failureCode, reason = 'error' } = r || {};
  const id = { agentId: ids.agentId, runId: ids.runId };
  emit('agent.run.start', Object.assign({}, id, { trigger: ids.trigger, model: ids.model }, ids.extra));
  if (token != null) emit('agent.token', Object.assign({}, id, { delta: token }));
  if (message != null) emit('agent.run.error', Object.assign({}, id, { transient }, errorExtra, { message }, failureCode ? { failureCode } : null));
  emit('agent.run.end', Object.assign({}, id, { reason, turns: 0, usd: 0 }));
}

function thrownReceipt(emit, ids, err, started, usd) {
  const id = { agentId: ids.agentId, runId: ids.runId };
  if (!started) emit('agent.run.start', Object.assign({}, id, { trigger: text(ids.trigger) || 'directive', model: text(ids.model) }));
  const said = err ? text((err && err.message) || err) : 'the run stopped without reporting how it ended';
  emit('agent.run.error', Object.assign({}, id, { message: 'sidecar failure: ' + said, transient: false, failureCode: NO_TERMINAL }));
  emit('agent.run.end', Object.assign({}, id, { reason: 'error', turns: 0, usd: amount(usd) }));
}

function makeRunTable(opts) {
  const o = opts || {};
  const now = typeof o.now === 'function' ? o.now : () => 0;
  const note = typeof o.note === 'function' ? o.note : () => {};
  const entries = new Set();        // every live entry, anonymous ones included (size() counts these)
  const byRunId = new Map();        // caller runId -> entry

  function terminal(entry) {
    entry.started = false; entry.ended = false;   // this run's one start and one end have passed
    entry.usd = 0; entry.tokens = 0;              // its OBSERVED floor: what its agent.cost events booked
    entry.called = false;                         // its stream showed a provider call going out
    let chain = null;                             // the first chain guard() bound: the one the belt ends the run through
    const who = () => 'run ' + (entry.runId || '(anonymous)');
    entry.finish = function (payload, via) {
      if (entry.ended) { note('runtable.duplicate-end', new Error(who() + ' tried to end twice; the second end was dropped')); return undefined; }
      entry.ended = true;
      const out = via || chain;
      return typeof out === 'function' ? out('agent.run.end', payload) : undefined;
    };
    entry.guard = function (next) {
      if (typeof next !== 'function') return next;
      if (!chain) chain = next;
      return function guarded(name, payload) {
        if (idOf(payload) !== entry.runId) return next(name, payload);   // another run's event (a forwarded worker's) passes untouched
        if (name === 'agent.run.start') {
          if (entry.started) { note('runtable.duplicate-start', new Error(who() + ' tried to start twice; the second start was dropped')); return undefined; }
          entry.started = true;
        } else if (name === 'agent.run.end') return entry.finish(payload, next);
        else if (CALL_EVENTS.has(name)) {
          entry.called = true;
          if (name === 'agent.cost') { entry.usd += amount(payload.usd); entry.tokens += amount(payload.tokensIn) + amount(payload.tokensOut); }
        }
        return next(name, payload);
      };
    };
    entry.settle = function (err, caller) {
      if (entry.ended || !entry.runId) return false;
      const ids = { agentId: entry.agentId, runId: entry.runId, trigger: caller && caller.trigger, model: caller && caller.model };
      const sink = entry.started ? chain : (caller && typeof caller.emit === 'function' ? caller.emit : null);
      if (typeof sink !== 'function') { entry.ended = true; return false; }
      // the receipt's own end goes through finish(), so it is still the run's one end
      const once = (name, payload) => (name === 'agent.run.end' ? entry.finish(payload, sink) : sink(name, payload));
      try { thrownReceipt(once, ids, err, entry.started, entry.usd); }
      catch (e) { note('runtable.settle', e); }
      entry.started = true; entry.ended = true;
      return true;
    };
  }

  // An early host admission may own a stop before runOnce joins its signal. The registration belongs to
  // this exact lease, so an old completion can never unregister a later admission with the same run id.
  function admit(meta, owner) {
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
        lineId: text(m.lineId), dockId: text(m.dockId), delegated: !!m.delegated, state: STATES.QUEUED, refs: 1,
        stopper: null, joins: 0, owners: new Set(), groupRefs: 0 };   // joined core stop plus admission-owned host stops
      terminal(entry);
      entries.add(entry);
      if (runId) byRunId.set(runId, entry);
    }
    if (m.state === STATES.RUNNING) entry.state = STATES.RUNNING;
    // Preserve the old host metadata admission set. API/hub/delegated runs do not implicitly block a group turn;
    // only the former metadata owner opts in, and only its own release relinquishes that admission's fact.
    // Close/abort keeps it through the owner's finally: physical unwind is still work, even though old close
    // handlers deleted metadata immediately. This corrects that timing without broadening the admission set.
    const blocksGroup = m.blocksGroup === true;
    if (blocksGroup) entry.groupRefs++;
    const registration = owner && typeof owner.stop === 'function' ? { stop: owner.stop, signal: owner.signal || null } : null;
    if (registration) entry.owners.add(registration);
    let released = false, joined = false;
    return {
      entry: entry,
      running() { if (!released) entry.state = STATES.RUNNING; },
      join(signal) {
        if (released || joined || !entry.runId || m.delegated || !anySignal) return signal;
        if (!entry.stopper) entry.stopper = new AbortController();
        const out = signal ? anySignal([signal, entry.stopper.signal]) : entry.stopper.signal;
        if (!entry.stopper.runSignal) entry.stopper.runSignal = out;   // what stopAll's fresh-abort counting rule reads
        joined = true;
        entry.joins++;
        return out;
      },
      release() {
        if (released) { note('runtable.release-twice', new Error('run ' + (entry.runId || '(anonymous)') + ' was released twice')); return; }
        released = true;
        if (blocksGroup) entry.groupRefs--;
        if (registration) entry.owners.delete(registration);
        if (joined && --entry.joins <= 0) { entry.joins = 0; entry.stopper = null; }   // the stop goes with the last run it reached
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
  function groupBusy(agentId) {
    const id = text(agentId);
    for (const e of entries) if (e.agentId === id && e.groupRefs > 0) return true;
    return false;
  }

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

  // ---- STOPS (S3/S5) ----
  function owned(runId) { const e = get(runId); return !!(e && e.owners.size); }
  function ownerLive(runId) {
    const e = get(runId);
    return !!(e && Array.from(e.owners).some(o => !(o.signal && o.signal.aborted)));
  }
  function stoppable(runId) { const e = get(runId); return !!(e && (e.stopper || e.owners.size)); }
  function stopOwners(cause) {
    let attempted = 0;
    const tag = 'runtable.stop.' + (text(cause) || 'owners');
    for (const e of Array.from(entries)) {
      const owners = Array.from(e.owners);
      if (!owners.length) continue;
      attempted++;
      for (const owner of owners) {
        try { owner.stop(); }
        catch (err) { note(tag, err); }
      }
    }
    return attempted;
  }
  function stopEntry(e, cause) {
    let fresh = false;
    for (const owner of Array.from(e.owners)) {
      const live = !(owner.signal && owner.signal.aborted);
      try { owner.stop(); if (live) fresh = true; }
      catch (err) { note('runtable.stop.' + cause, err); }
    }
    if (e.stopper) {
      const signal = e.stopper.runSignal || e.stopper.signal;
      const live = !(signal && signal.aborted);
      try { e.stopper.abort(); if (live) fresh = true; }
      catch (err) { note('runtable.stop.' + cause, err); }
    }
    return fresh;
  }
  function stop(runId, cause) {
    const e = get(runId);
    if (!e || (!e.stopper && !e.owners.size)) return false;
    stopEntry(e, text(cause) || 'id');
    return true;
  }
  function stopAll(cause) {
    let fresh = 0;
    for (const e of Array.from(entries)) {
      // Count a run once even when its host callback and joined core controller both receive the stop.
      // An already-aborted run or a stop that entirely throws adds no fresh count.
      if (stopEntry(e, text(cause) || 'all')) fresh++;
    }
    return fresh;
  }

  return { admit, get, has, size, groupBusy, live, missing, owned, ownerLive, stoppable, stopOwners, stop, stopAll };
}

module.exports = { makeRunTable, metaOf, refuseRun, thrownReceipt, STATES, NO_TERMINAL };
