/* sidecar/observer.js — the station's LIVE FEED for a watching client (the `starnet` terminal dashboard).

   Why it exists: a run the page starts (POST /api/run) writes its events only down its own NDJSON response, and the
   SSE bus (/api/channels/events) carries only server-initiated runs, name-only. So nothing outside the page that
   started a run could watch it: a terminal saw a busy agent in /api/state/snapshot but never what it was doing. This
   feed tees EVERY non-internal run's events (any surface: COMMS, routines, lines, channels, workers, groups) plus the
   approvals they ask, to whoever is subscribed at GET /api/observe.

   Trust: the feed is behind the same x-starnet-token gate as every /api route, and a token holder can already read
   every conversation (/api/transcript) and start runs. It still ships a bounded VIEW, not the raw payload: tool
   arguments and results are clipped to a line, and every view passes the injected redact() (key-shaped secrets
   scrubbed) before it leaves. A separate hub from the page's SSE bus on purpose: the page never subscribes here, so
   nothing it already receives is ever counted twice.

   Cost when nobody watches: the tee checks hub.size() first and does nothing else. Pure policy + duck-typed hub, so
   test/observer.test.js drives it without a socket. */
'use strict';

const { makeSseHub } = require('./channels/sse.js');

const CLIP = Object.freeze({ argsSummary: 400, askSummary: 6000, summary: 240, prompt: 400, message: 300, delta: 4000 });

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, Math.max(0, n - 1)) + '…' : t;
}
function str(v) { return String(v == null ? '' : v); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// The text of the last user turn in a run's messages (string content or an array of {type:'text', text} parts).
function lastUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map(p => (p && typeof p.text === 'string') ? p.text : '').filter(Boolean).join(' ');
    return '';
  }
  return '';
}

/* The view a watcher receives for one run event, or null for "never sent". `ctx` is what the host knows about the
   run that the payload may not carry: { runId, agentId, streamId, surface, trigger, lineId, dockId, prompt }. */
function observerView(name, payload, ctx) {
  const p = payload || {}, c = ctx || {};
  const base = { runId: str(p.runId || c.runId), agentId: str(p.agentId || c.agentId) };
  switch (name) {
    case 'agent.run.start': {
      const v = Object.assign(base, {
        model: str(p.model), trigger: str(p.trigger || c.trigger), surface: str(c.surface),
        streamId: str(p.streamId || c.streamId), lineId: str(c.lineId), dockId: str(p.dockId || c.dockId),
        // the trusted project the run works in ('' = the agent's own workspace): a terminal opens the files it writes there
        projectRoot: str(c.projectRoot)
      });
      // a delegated worker's run: the lead run (and agent) that sent it — the terminal's FLOOR draws the handoff
      if (c.parentRunId) { v.parentRunId = str(c.parentRunId); v.delegatedBy = str(c.delegatedBy); }
      const prompt = typeof c.prompt === 'function' ? c.prompt() : c.prompt;
      if (prompt) v.prompt = clip(prompt, CLIP.prompt);
      return v;
    }
    case 'agent.token':
      if (typeof p.delta !== 'string' || !p.delta) return null;
      return Object.assign(base, { delta: clip(p.delta, CLIP.delta) });
    case 'agent.tool_call':
      return Object.assign(base, { callId: str(p.callId), name: str(p.name), argsSummary: clip(p.argsSummary, CLIP.argsSummary) });
    case 'agent.tool_result':
      return Object.assign(base, { callId: str(p.callId), ok: !!p.ok, isError: !!p.isError, ms: num(p.ms), summary: clip(p.summary, CLIP.summary) });
    case 'agent.cost':
      return Object.assign(base, { usd: num(p.usd), tokensIn: num(p.tokensIn), tokensOut: num(p.tokensOut), model: str(p.model) });
    case 'agent.run.end': {
      const v = Object.assign(base, { reason: str(p.reason), turns: num(p.turns), usd: num(p.usd) });
      if (p.finishReason) v.finishReason = str(p.finishReason);
      return v;
    }
    case 'agent.run.error':
      return Object.assign(base, { message: clip(p.message, CLIP.message) });
    case 'permission.prompt': {
      const tool = str(p.tool);
      const v = Object.assign(base, {
        streamId: str(p.streamId || c.streamId), promptId: str(p.promptId), tool, scope: str(p.scope),
        // a question (brief.ask) carries its whole card as JSON: clipping it mid-string would make it unreadable
        argsSummary: clip(p.argsSummary, tool === 'brief.ask' ? CLIP.askSummary : CLIP.argsSummary)
      });
      if (p.workerAgentId) v.workerAgentId = str(p.workerAgentId);
      if (p.background === true) v.background = true;
      return v;
    }
    case 'permission.response': {
      const v = Object.assign(base, { promptId: str(p.promptId), decision: str(p.decision) });
      if (p.via) v.via = str(p.via);
      if (p.expired === true) v.expired = true;
      if (p.stopped === true) v.stopped = true;
      return v;
    }
    default: return null;
  }
}

/* makeObserver({ redact, epoch }) → { hub, publish, tee, size }.
   publish(name, payload, ctx): send one view to every watcher (no-op when nobody watches; never throws).
   tee(emit, ctx): wrap a run's emit so each event ALSO reaches watchers; the wrapped emit runs first, always. */
function makeObserver(opts) {
  const o = opts || {};
  const scrub = typeof o.redact === 'function' ? o.redact : (x => x);
  // a small replay ring: a watcher that blinks reconnects with its cursor; anything older is a snapshot re-read
  const hub = o.hub || makeSseHub({ epoch: o.epoch || 'observe', maxEvents: 512, maxBytes: 512 * 1024 });
  function publish(name, payload, ctx) {
    if (!hub.size()) return 0;
    try {
      const view = observerView(name, payload, ctx);
      return view ? hub.broadcast(name, scrub(view)) : 0;
    } catch (_) { return 0; }
  }
  function tee(emit, ctx) {
    return (name, payload) => {
      try { emit(name, payload); }
      finally { if (hub.size()) publish(name, payload, ctx); }
    };
  }
  return { hub, publish, tee, size: () => hub.size() };
}

/* GET /api/observe — the SSE handler (auth is the central /api gate). Mirrors handleChannelEvents: replay from
   Last-Event-ID / ?cursor=, a ready frame, a DATA keepalive every 25s, eviction on disconnect. */
function serveObserver(hub, req, res, opts) {
  const keepaliveMs = (opts && opts.keepaliveMs) || 25000;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  try { res.write('retry: 3000\n\n'); } catch (_) { return; }   // the watcher is already gone: nothing to register
  hub.add(res);
  let cursor = req.headers && req.headers['last-event-id'];
  if (!cursor) { try { cursor = new URL(req.url, 'http://localhost').searchParams.get('cursor'); } catch (_) { cursor = ''; } }
  if (!hub.resume(res, cursor)) return;
  const ka = setInterval(() => { if (!hub.keepalive(res)) done(); }, keepaliveMs);
  if (ka.unref) ka.unref();
  function done() { clearInterval(ka); hub.remove(res); }
  req.on('close', done); req.on('aborted', done); res.on('error', done); res.on('close', done);
}

module.exports = { makeObserver, observerView, serveObserver, lastUserText, CLIP };
