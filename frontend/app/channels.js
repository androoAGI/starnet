/* AGENT OS — channels.js : per-workstream COMMS run-state (THE GATE).

   The single defect that made genuine multi-agent impossible was that chat.js kept ONE
   global run-state (one `busy`, one `currentRunId`, one in-flight stream) and wiped the DOM
   on every stream switch. This module lifts that state OUT of chat.js into a per-WORKSTREAM
   channel, so:
     - two workstreams can have a run in flight AT THE SAME TIME (each its own `busy`/`runId`);
     - switching the displayed stream no longer destroys the one you left — chat.js re-renders
       the in-flight text / tool lines / pending approval from a channel SNAPSHOT instead of
       wiping it.

   It owns ONLY transient run-state. History stays in Workstreams (workstreams.js) — never
   duplicated here. A channel is keyed by workstreamId (NOT agentId: many workstreams can share
   one agentId, workstreams.js make() defaults agentId:'agent').

   Pure + DOM-free + dependency-free, UMD like workstreams.js, so it is unit-testable headless
   (test/channels.test.js). chat.js is the DOM VIEW over this model.

   composeTargetId is tracked here, decoupled from camera/selection (war-room D2): the thing that
   moves your eyes (a camera jump to the agent that needs you) must never silently re-aim the
   COMMS input. The compose target is the workstream a typed message is sent to. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Channels = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const map = new Map();          // workstreamId -> channel (transient; never persisted)
  let composeTargetId = null;     // which workstream the COMMS input posts to

  function blank(wsId) {
    return {
      wsId: wsId,
      busy: false,
      runId: null,                // the in-flight run id (for Harness.cancel / consent routing)
      acc: '',                    // accumulated in-flight assistant text (survives a switch)
      tools: [],                  // LEGACY in-flight tool lines: [{ text, isErr }] (kept for callers/tests)
      toolEvents: [],             // STRUCTURED in-flight tool events so a switch re-renders the SAME premium chips
                                  // the live run drew (not a dim text downgrade): [{ t:'call', callId, name, argsSummary }
                                  // | { t:'result', callId, name, summary, isError, ms }]
      pending: null,              // live consent awaiting a human: { promptId, tool, argsSummary, runId }
      startedAt: 0,               // wall-clock ms this run began (the COMMS elapsed timer reads it; survives a switch).
                                  // Stamped at send, RE-STAMPED by setRunId when the sidecar confirms the run — so the
                                  // visible elapsed is real RUN time, not connect/queue latency counted as work.
      pausedMs: 0,                // accumulated wall-clock spent PAUSED awaiting human approval (excluded from elapsed)
      pausedAt: 0,                // if >0, the instant the current approval pause began (still paused now)
      status: 'online'            // 'online' | 'connecting…' | 'thinking…' | 'working…' | 'awaiting your approval…'
    };
  }

  // get-or-create the channel for a workstream.
  function get(wsId) {
    if (wsId == null) return null;
    let c = map.get(wsId);
    if (!c) { c = blank(wsId); map.set(wsId, c); }
    return c;
  }
  function peek(wsId) { return (wsId == null) ? null : (map.get(wsId) || null); }   // no auto-create
  function has(wsId) { return map.has(wsId); }

  // ---------- run lifecycle ----------
  // a run is starting on this workstream — clear any stale transient state, mark busy. ts (wall-clock ms,
  // injected by the caller so this module stays clock-free + headless-testable) stamps the run's start so
  // the COMMS elapsed timer reads a real "how long has this turn been running" off the channel.
  function begin(wsId, ts) {
    const c = get(wsId);
    c.busy = true; c.runId = null; c.acc = ''; c.tools = []; c.toolEvents = []; keepBackgroundAsks(c);
    c.startedAt = ts || 0;
    c.pausedMs = 0; c.pausedAt = 0;
    // TRUTHFUL TELEMETRY: at send time the sidecar has confirmed NOTHING — the request may still be
    // connecting/queued (or the sidecar may be down). The channel says so; setRunId (the sidecar's
    // agent.run.start) is what upgrades it to a real 'thinking…'. Callers that begin() off an event
    // that IS server truth (e.g. a cron fire) should setStatus('thinking…') themselves right after.
    c.status = 'connecting…';
    return c;
  }
  // the run finished (or errored/aborted) — drop transient state; the turn now lives in Workstreams.history.
  function end(wsId) {
    const c = peek(wsId); if (!c) return;
    c.busy = false; c.runId = null; c.acc = ''; c.tools = []; c.toolEvents = []; keepBackgroundAsks(c);
    c.startedAt = 0;
    c.pausedMs = 0; c.pausedAt = 0;
    c.status = c.pending ? 'awaiting your approval…' : 'online';
  }
  /* A BACKGROUND WORKER'S ASK OUTLIVES THE RUN (2026-10-13). A run's start/end/stop clears that run's own asks, but an ask
     filed with background:true belongs to a worker the conversation handed off in the background (team.dispatch
     background:true): it is still waiting on the sidecar after the reply that started it ended, so it stays filed until
     its own answer or expiry arrives (clearPending with its promptId). It never pauses the conversation's own run clock. */
  function keepBackgroundAsks(c) {
    c.pendings = (Array.isArray(c.pendings) ? c.pendings : []).filter(x => x && x.background === true);
    c.pending = c.pendings.length ? c.pendings[c.pendings.length - 1] : null;
  }
  // the sidecar confirmed the run (agent.run.start arrived). ts (optional, caller-injected wall-clock)
  // RE-STAMPS startedAt so the elapsed timer measures the confirmed run, not send-click → first-byte
  // latency; 'connecting…' upgrades to 'thinking…' (a later status like 'working…' is never downgraded).
  function setRunId(wsId, runId, ts) {
    const c = get(wsId); c.runId = runId;
    if (ts) c.startedAt = ts;
    if (c.status === 'connecting…') c.status = 'thinking…';
    return runId;
  }
  function setStatus(wsId, s) { const c = get(wsId); c.status = s; return s; }
  function appendToken(wsId, d) { const c = get(wsId); c.acc += (d == null ? '' : d); return c.acc; }
  function setAcc(wsId, text) { const c = get(wsId); c.acc = (text == null ? '' : String(text)); return c.acc; }
  function addTool(wsId, text, isErr) {
    const c = get(wsId);
    c.tools.push({ text: String(text == null ? '' : text), isErr: !!isErr });
    c.status = 'working…';
    return c.tools.length;
  }
  // STRUCTURED tool events — so a stream re-rendered after a switch draws the SAME chip UI a live run does
  // (toolChip/resolveChip), instead of the dim toolLine downgrade. call+result fold by callId on replay.
  function addToolCall(wsId, ev) {
    const c = get(wsId); ev = ev || {};
    c.toolEvents.push({ t: 'call', callId: (ev.callId == null ? null : ev.callId), name: String(ev.name || 'tool'), argsSummary: String(ev.argsSummary == null ? '' : ev.argsSummary) });
    c.status = 'working…';
    return c.toolEvents.length;
  }
  function addToolResult(wsId, ev) {
    const c = get(wsId); ev = ev || {};
    c.toolEvents.push({ t: 'result', callId: (ev.callId == null ? null : ev.callId), name: String(ev.name || 'tool'), summary: String(ev.summary == null ? '' : ev.summary), isError: !!ev.isError, ms: (typeof ev.ms === 'number' ? ev.ms : 0) });
    return c.toolEvents.length;
  }
  // ts (optional, caller-injected wall-clock) opens/closes an approval PAUSE window: while a run sits
  // waiting on the human, the clock is stopped — elapsedOf() excludes paused spans, so "RUN COMPLETE · 2:14"
  // is machine time, never the Commander's think-time counted as agent work.
  // SEVERAL ASKS AT ONCE (2026-10-11): parallel delegated workers can each wait on the Commander inside one conversation.
  // `pendings` keeps every open ask by promptId; `pending` stays the newest (every single-ask reader keeps working).
  // Answering one (clearPending with its promptId) leaves the others open; the pause window closes when none remain.
  function setPending(wsId, p, ts) {
    const c = get(wsId);
    if (!Array.isArray(c.pendings)) c.pendings = [];
    if (!p) { c.pendings = []; c.pending = null; return null; }
    c.pendings = c.pendings.filter(x => !(x && p.promptId && x.promptId === p.promptId)).concat([p]);
    c.pending = p;
    // a background worker's ask: the conversation's own run (if any) is not the one paused on it
    if (p.background === true) { if (!c.busy) c.status = 'awaiting your approval…'; return c.pending; }
    c.status = 'awaiting your approval…'; if (ts && !c.pausedAt) c.pausedAt = ts;
    return c.pending;
  }
  // the newest ask the conversation's OWN run is paused on (a background worker's ask never pauses it)
  function runAsk(c) { const own = (c && Array.isArray(c.pendings) ? c.pendings : []).filter(x => x && x.background !== true); return own.length ? own[own.length - 1] : null; }
  function clearPending(wsId, ts, promptId) {
    const c = peek(wsId); if (!c) return;
    // a bulk clear (a stopped run) takes that run's own asks only — a background worker's ask outlives it
    c.pendings = promptId ? (c.pendings || []).filter(x => !(x && x.promptId === promptId)) : (c.pendings || []).filter(x => x && x.background === true);
    c.pending = c.pendings.length ? c.pendings[c.pendings.length - 1] : null;
    if (runAsk(c)) return;
    if (c.pausedAt) { c.pausedMs += Math.max(0, (ts || c.pausedAt) - c.pausedAt); c.pausedAt = 0; }
    c.status = c.busy ? 'working…' : (c.pending ? 'awaiting your approval…' : 'online');
  }

  // ---------- queries ----------
  function isBusy(wsId) { const c = peek(wsId); return !!(c && c.busy); }
  function runIdOf(wsId) { const c = peek(wsId); return c ? c.runId : null; }
  function startedAtOf(wsId) { const c = peek(wsId); return c ? c.startedAt : 0; }
  // the run's honest elapsed ms at `now` (caller-injected clock): wall-clock since the (re-stamped)
  // start MINUS time spent paused on approvals (closed spans + the still-open one). 0 when not running.
  function elapsedOf(wsId, now) {
    const c = peek(wsId); if (!c || !c.startedAt) return 0;
    const pausedOpen = c.pausedAt ? Math.max(0, now - c.pausedAt) : 0;
    return Math.max(0, now - c.startedAt - c.pausedMs - pausedOpen);
  }
  function statusOf(wsId) { const c = peek(wsId); return c ? c.status : 'online'; }
  function pendingOf(wsId) { const c = peek(wsId); return c ? c.pending : null; }
  // what the conversation's own live run is paused on (null while it is working, even if a background worker is waiting)
  function runPendingOf(wsId) { return runAsk(peek(wsId)); }
  function pendingAllOf(wsId) { const c = peek(wsId); return c && Array.isArray(c.pendings) ? c.pendings.slice() : (c && c.pending ? [c.pending] : []); }
  // every open ask on the station, oldest conversation first (the NEEDS YOU list reads this)
  function allPending() { const out = []; for (const c of map.values()) for (const p of pendingAllOf(c.wsId)) out.push({ wsId: c.wsId, p }); return out; }
  function anyBusy() { for (const c of map.values()) if (c.busy) return true; return false; }
  function busyCount() { let n = 0; for (const c of map.values()) if (c.busy) n++; return n; }
  function busyIds() { const out = []; for (const c of map.values()) if (c.busy) out.push(c.wsId); return out; }
  function pendingIds() { const out = []; for (const c of map.values()) if (c.pending) out.push(c.wsId); return out; }

  // a deep-ish copy for chat.js to re-render a stream on switch — callers must not mutate live state.
  function snapshot(wsId) {
    const c = peek(wsId); if (!c) return null;
    return {
      wsId: c.wsId, busy: c.busy, runId: c.runId, acc: c.acc,
      tools: c.tools.map(t => ({ text: t.text, isErr: t.isErr })),
      toolEvents: (c.toolEvents || []).map(e => Object.assign({}, e)),
      pending: c.pending ? Object.assign({}, c.pending) : null,
      pendings: (c.pendings || []).map(p => Object.assign({}, p)),
      startedAt: c.startedAt,
      pausedMs: c.pausedMs, pausedAt: c.pausedAt,
      status: c.status
    };
  }

  // ---------- compose target (decoupled from camera/selection — war-room D2) ----------
  function setComposeTarget(wsId) { composeTargetId = (wsId == null ? null : wsId); return composeTargetId; }
  function composeTarget() { return composeTargetId; }

  // ---------- teardown ----------
  function drop(wsId) { map.delete(wsId); if (composeTargetId === wsId) composeTargetId = null; }
  function reset() { map.clear(); composeTargetId = null; }

  return {
    get: get, peek: peek, has: has,
    begin: begin, end: end, setRunId: setRunId, setStatus: setStatus,
    appendToken: appendToken, setAcc: setAcc, addTool: addTool, addToolCall: addToolCall, addToolResult: addToolResult, setPending: setPending, clearPending: clearPending,
    isBusy: isBusy, runIdOf: runIdOf, startedAtOf: startedAtOf, elapsedOf: elapsedOf, statusOf: statusOf, pendingOf: pendingOf, runPendingOf: runPendingOf, pendingAllOf: pendingAllOf, allPending: allPending,
    anyBusy: anyBusy, busyCount: busyCount, busyIds: busyIds, pendingIds: pendingIds, snapshot: snapshot,
    setComposeTarget: setComposeTarget, composeTarget: composeTarget,
    drop: drop, reset: reset
  };
});
