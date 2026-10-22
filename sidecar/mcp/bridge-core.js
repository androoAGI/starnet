/* sidecar/mcp/bridge-core.js — the PURE core of the Agent OS MCP messaging-bridge server.

   This is a thin OBSERVE/MESSAGE shim over a RUNNING Agent OS sidecar — an independent implementation
   that is wire-compatible with the reference harness's MCP bridge surface. It exposes the same 11-tool
   compat surface so any MCP client (Claude Code, Cursor, …) can watch and message a Agent OS station. It does
   NOT run agent turns — that is a separate OpenAI-compat surface.

   HARD INVARIANT (one sidecar owner per workspace): this core NEVER reads or writes store files.
   Every tool proxies over loopback HTTP to the running sidecar via the injected `callSidecar`.
   The real HTTP/stdio/SSE edge lives in serve.js (the composition root); this file is pure logic
   so it is unit-testable with a fake `callSidecar` and carries no ambient clock/rng/IO — it uses
   only setTimeout for the events_wait long-poll (allowed by the determinism lint; never Date.now).

   Exports:
     LATEST_PROTOCOL, SERVER_INFO, INSTRUCTIONS, TOOLS  — the static MCP surface
     makeEventQueue({ cap?, setTimer?, clearTimer? })   — the SSE-fed cursor queue (poll + long-poll)
     makeBridge({ callSidecar, queue, baseLabel? })     — { handleRpc(msg)->Promise<resp|null>, callTool(name,args) }

   callSidecar contract (injected):
     callSidecar(method, path, body?) -> Promise<{ ok, status, json, text, error }>
       ok=false  => the sidecar could not be reached at all (connection refused / DNS / timeout)
       ok=true   => HTTP round-trip completed; `status` is the code, `json` the parsed body (or null),
                    `text` the raw body when it was not JSON. */
'use strict';

const LATEST_PROTOCOL = '2025-06-18';                 // our newest known MCP revision (client's echoed version wins)
const SERVER_INFO = { name: 'starnet-harness', version: '0.5.2' };
const JSONRPC = '2.0';
const QUEUE_CAP = 1000;                               // the reference harness parity: the in-memory event ring is bounded
const PROTO_RE = /^\d{4}-\d{2}-\d{2}$/;               // a well-formed MCP protocol revision string

const INSTRUCTIONS =
  'Agent OS station messaging bridge. These tools OBSERVE and MESSAGE a running Agent OS station over ' +
  'its local loopback API — they do not run agent turns. conversations_list / conversation_get / ' +
  'messages_read read the station\'s run history and per-stream transcripts; channels_list shows the ' +
  'connected messaging channels; events_poll / events_wait deliver live station telemetry (runs, ' +
  'deliveries, permission prompts) with monotonic cursors; permissions_list_open / permissions_respond ' +
  'surface and answer live consent prompts. messages_send drives the station over its local DEV channel ' +
  '(target "dev:<chat>", only when Agent OS runs with DEV mode enabled); real platform channels ' +
  '(telegram/discord/…) are not injectable over the API and return a structured not-supported result. ' +
  'If the sidecar is not running every tool returns a structured error telling you to start Agent OS.';

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------

function clampInt(value, def, min, max) {
  let n = Number(value);
  if (!isFinite(n)) n = def;
  n = Math.trunc(n);
  if (n < min) n = min;
  if (n > max) n = max;
  return n;
}
function str(v) { return v == null ? '' : String(v); }
const AGENT_RE = /^[A-Za-z0-9_-]{1,40}$/;             // the sidecar's transcript/runs agent-id gate

// ---------------------------------------------------------------------------
// the tool surface (ref-byte-compatible names + signatures)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'conversations_list',
    description: 'List the station\'s recent runs (conversations) across agents. Returns each run\'s session_key (needed for messages_read), the agent, a display title, model, outcome, and last-activity time.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'Filter by platform (only "starnet" matches runs today).' },
        limit: { type: 'integer', description: 'Max conversations to return (default 50).' },
        search: { type: 'string', description: 'Filter conversations whose title/agent/key contains this text.' }
      }
    }
  },
  {
    name: 'conversation_get',
    description: 'Get details about one run (conversation) by its session_key (the runId from conversations_list).',
    inputSchema: { type: 'object', required: ['session_key'], properties: { session_key: { type: 'string' } } }
  },
  {
    name: 'messages_read',
    description: 'Read the transcript turns for a run (conversation), chronological. Each turn has role, content (truncated to 2000 chars), and timestamp.',
    inputSchema: {
      type: 'object', required: ['session_key'],
      properties: {
        session_key: { type: 'string', description: 'The runId from conversations_list.' },
        limit: { type: 'integer', description: 'Max turns to return (default 50, most recent).' }
      }
    }
  },
  {
    name: 'attachments_fetch',
    description: 'List non-text attachments for a message. Agent OS transcripts are text-only, so this reports zero attachments truthfully.',
    inputSchema: { type: 'object', required: ['session_key', 'message_id'], properties: { session_key: { type: 'string' }, message_id: { type: 'string' } } }
  },
  {
    name: 'events_poll',
    description: 'Poll for new station events since a cursor (runs, deliveries, permission prompts). Returns events plus a next_cursor to pass back. Events are fed from the station\'s live SSE stream.',
    inputSchema: {
      type: 'object',
      properties: {
        after_cursor: { type: 'integer', description: 'Return events after this cursor (0 for all buffered).' },
        session_key: { type: 'string', description: 'Optional filter to one run/session.' },
        limit: { type: 'integer', description: 'Max events to return (default 20).' }
      }
    }
  },
  {
    name: 'events_wait',
    description: 'Long-poll: block until the next matching station event arrives or the timeout expires. Use for near-real-time delivery without busy-polling.',
    inputSchema: {
      type: 'object',
      properties: {
        after_cursor: { type: 'integer', description: 'Wait for events after this cursor.' },
        session_key: { type: 'string', description: 'Optional filter to one run/session.' },
        timeout_ms: { type: 'integer', description: 'Max wait in ms (default 30000, capped at 300000).' }
      }
    }
  },
  {
    name: 'messages_send',
    description: 'Deliver a message INTO the station over its local DEV channel (target "dev:<chat>"), as if from the operator; the station\'s agent processes it and its replies are returned. Requires Agent OS running with DEV mode. Real platform channels (telegram/discord/…) are not injectable over the API and return a structured not-supported result.',
    inputSchema: { type: 'object', required: ['target', 'message'], properties: { target: { type: 'string', description: 'Target in "platform:chat_id" form, e.g. "dev:devchat".' }, message: { type: 'string' } } }
  },
  {
    name: 'channels_list',
    description: 'List the station\'s messaging channels and their connection status. Connected channels can receive the station\'s agent replies; use messages_send target "dev:<chat>" to drive the station locally.',
    inputSchema: { type: 'object', properties: { platform: { type: 'string', description: 'Filter by platform id (telegram/discord/slack/matrix/signal).' } } }
  },
  {
    name: 'permissions_list_open',
    description: 'List the station\'s OPEN consent prompts awaiting a human decision (each carries an id, the run, agent, and — when observed on the live stream — the tool/scope/argsSummary).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'permissions_respond',
    description: 'Answer an open consent prompt. decision is one of allow-once, allow-always, or deny.',
    inputSchema: { type: 'object', required: ['id', 'decision'], properties: { id: { type: 'string', description: 'The id from permissions_list_open.' }, decision: { type: 'string', enum: ['allow-once', 'allow-always', 'deny'] } } }
  }
];
// NB: this is the exact 10-tool the reference harness bridge surface — 4 read (conversations_list, conversation_get,
// messages_read, attachments_fetch) + 2 event (events_poll, events_wait) + 1 send (messages_send) +
// channels_list + 2 permission (permissions_list_open, permissions_respond). (the reference harness's own docstring counts
// it as OpenClaw's 9 + channels_list = 10.) Count + names asserted by test/mcp-serve.test.js.

// ---------------------------------------------------------------------------
// the SSE-fed event queue: monotonic cursors, bounded ring, long-poll waiters
// ---------------------------------------------------------------------------

function makeEventQueue(deps) {
  deps = deps || {};
  const cap = deps.cap || QUEUE_CAP;
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;

  const ring = [];                 // [{ cursor, type, session_key, data }]
  let cursor = 0;
  const waiters = new Set();        // { pred, resolve }
  const promptDetails = new Map();  // promptId -> { tool, scope, argsSummary, agentId } observed on the stream

  function matches(e, sessionKey) { return e.cursor > 0 && (!sessionKey || e.session_key === sessionKey); }

  // push ONE normalized station event ({ name, payload } off the SSE wire). Returns the assigned cursor,
  // or 0 for a frame we deliberately ignore (keepalives / nameless frames).
  function push(name, payload) {
    const type = str(name);
    if (!type) return 0;            // SSE keepalive is a nameless `{}` frame — never a product event
    const p = (payload && typeof payload === 'object') ? payload : {};
    // remember consent-prompt descriptors so permissions_list_open can enrich the id-only snapshot rows.
    if (type === 'permission.prompt' && p.promptId != null) {
      promptDetails.set(str(p.promptId), { tool: str(p.tool), scope: str(p.scope), argsSummary: str(p.argsSummary), agentId: str(p.agentId) });
    }
    cursor += 1;
    const sessionKey = str(p.runId || p.streamId || p.agentId || '');
    const evt = { cursor: cursor, type: type, session_key: sessionKey, data: p };
    ring.push(evt);
    while (ring.length > cap) ring.shift();
    // wake any long-poll waiters whose predicate this event now satisfies.
    for (const w of Array.from(waiters)) {
      try { if (w.pred(evt)) { waiters.delete(w); clearTimer(w.timer); w.resolve(); } }
      catch (_) { waiters.delete(w); clearTimer(w.timer); w.resolve(); }
    }
    return cursor;
  }

  function poll(afterCursor, sessionKey, limit) {
    const after = clampInt(afterCursor, 0, 0, Number.MAX_SAFE_INTEGER);
    const lim = clampInt(limit, 20, 1, 200);
    const out = [];
    for (const e of ring) {
      if (e.cursor > after && (!sessionKey || e.session_key === sessionKey)) { out.push(e); if (out.length >= lim) break; }
    }
    const next = out.length ? out[out.length - 1].cursor : after;
    return { events: out.map(e => ({ cursor: e.cursor, type: e.type, session_key: e.session_key, data: e.data })), next_cursor: next };
  }

  // long-poll: resolve as soon as a matching event exists, or after timeoutMs. Never uses wall-clock time.
  function wait(afterCursor, sessionKey, timeoutMs) {
    const after = clampInt(afterCursor, 0, 0, Number.MAX_SAFE_INTEGER);
    const ms = clampInt(timeoutMs, 30000, 0, 300000);
    const immediate = poll(after, sessionKey, 1);
    if (immediate.events.length) return Promise.resolve(immediate);
    return new Promise(resolve => {
      const w = { pred: e => (e.cursor > after && (!sessionKey || e.session_key === sessionKey)) };
      w.resolve = () => resolve(poll(after, sessionKey, 1));
      w.timer = setTimer(() => { waiters.delete(w); resolve({ events: [], next_cursor: after, timeout: true }); }, ms);
      if (w.timer && typeof w.timer.unref === 'function') w.timer.unref();
      waiters.add(w);
    });
  }

  return {
    push, poll, wait,
    promptDetail: id => promptDetails.get(str(id)) || null,
    size: () => ring.length,
    currentCursor: () => cursor
  };
}

// ---------------------------------------------------------------------------
// tool implementations — pure functions of (args, ctx). ctx = { callSidecar, queue, baseLabel }
// ---------------------------------------------------------------------------

function sidecarDown(ctx, r) {
  return {
    ok: false,
    sidecarReachable: false,
    error: 'Cannot reach the Agent OS sidecar at ' + (ctx.baseLabel || 'the loopback port') + ' — is Agent OS running? Start it with `npm start`.',
    detail: (r && r.error) ? str(r.error) : ''
  };
}
function badStatus(what, r) { return { ok: false, error: what + ' returned HTTP ' + (r ? r.status : '?'), detail: (r && (r.text || (r.json && r.json.error))) || '' }; }

function runToConversation(run) {
  run = run || {};
  return {
    session_key: str(run.runId),
    session_id: str(run.runId),
    platform: 'starnet',
    agent: str(run.agentId),
    display_name: str(run.title || run.agentId || run.runId),
    stream_id: str(run.streamId),
    model: str(run.model),
    reason: str(run.reason),
    turns: Number(run.turns) || 0,
    usd: Number(run.usd) || 0,
    updated_at: Number(run.ts) || 0
  };
}

async function fetchRun(ctx, sessionKey) {
  // serveRuns supports ?agent=*&runId=<id>, returning the matching run (or none).
  const r = await ctx.callSidecar('GET', '/api/runs?agent=*&runId=' + encodeURIComponent(sessionKey) + '&limit=1000');
  if (!r.ok) return { down: r };
  if (r.status !== 200) return { bad: r };
  const runs = (r.json && Array.isArray(r.json.runs)) ? r.json.runs : [];
  return { run: runs.find(x => x && str(x.runId) === str(sessionKey)) || null };
}

const IMPLS = {
  async conversations_list(args, ctx) {
    const limit = clampInt(args.limit, 50, 1, 200);
    const platform = str(args.platform).toLowerCase();
    const search = str(args.search).toLowerCase();
    if (platform && platform !== 'starnet') return { count: 0, conversations: [] };   // only station runs today
    const r = await ctx.callSidecar('GET', '/api/runs?agent=*&limit=' + Math.min(500, limit * 4));
    if (!r.ok) return sidecarDown(ctx, r);
    if (r.status !== 200) return badStatus('/api/runs', r);
    let conv = ((r.json && r.json.runs) || []).map(runToConversation);
    if (search) conv = conv.filter(c => (c.display_name + ' ' + c.agent + ' ' + c.session_key).toLowerCase().indexOf(search) >= 0);
    conv.sort((a, b) => b.updated_at - a.updated_at);
    conv = conv.slice(0, limit);
    return { count: conv.length, conversations: conv };
  },

  async conversation_get(args, ctx) {
    const key = str(args.session_key);
    if (!key) return { error: 'session_key is required' };
    const got = await fetchRun(ctx, key);
    if (got.down) return sidecarDown(ctx, got.down);
    if (got.bad) return badStatus('/api/runs', got.bad);
    if (!got.run) return { error: 'Conversation not found: ' + key };
    return runToConversation(got.run);
  },

  async messages_read(args, ctx) {
    const key = str(args.session_key);
    if (!key) return { error: 'session_key is required' };
    const limit = clampInt(args.limit, 50, 1, 200);
    const got = await fetchRun(ctx, key);
    if (got.down) return sidecarDown(ctx, got.down);
    if (got.bad) return badStatus('/api/runs', got.bad);
    if (!got.run) return { error: 'Conversation not found: ' + key };
    const agent = AGENT_RE.test(str(got.run.agentId)) ? str(got.run.agentId) : 'agent';
    const stream = str(got.run.streamId) || 'global';
    const tr = await ctx.callSidecar('GET', '/api/transcript?agent=' + encodeURIComponent(agent) + '&stream=' + encodeURIComponent(stream) + '&limit=' + limit);
    if (!tr.ok) return sidecarDown(ctx, tr);
    if (tr.status !== 200) return badStatus('/api/transcript', tr);
    const turns = (tr.json && Array.isArray(tr.json.turns)) ? tr.json.turns : [];
    const messages = turns.slice(-limit).map((t, i) => ({
      id: str(t.id != null ? t.id : i),
      role: str(t.role),
      content: str(t.content).slice(0, 2000),
      timestamp: t.ts != null ? t.ts : ''
    }));
    return { session_key: key, stream: stream, count: messages.length, total_in_stream: turns.length, messages: messages };
  },

  async attachments_fetch(args, ctx) {
    // Truthful telemetry: Agent OS's durable transcript is text-only and exposes no per-message attachment store
    // over the API. Rather than fabricate, report zero with an explanation. (ctx unused; kept for signature parity.)
    void ctx;
    return {
      message_id: str(args.message_id),
      count: 0,
      attachments: [],
      note: 'Agent OS stores conversation transcripts as text; no per-message attachment store is exposed over the API.'
    };
  },

  async events_poll(args, ctx) {
    return ctx.queue.poll(args.after_cursor, str(args.session_key) || null, args.limit);
  },

  async events_wait(args, ctx) {
    const res = await ctx.queue.wait(args.after_cursor, str(args.session_key) || null, args.timeout_ms);
    return res;
  },

  async messages_send(args, ctx) {
    const target = str(args.target).trim();
    const message = str(args.message);
    if (!target || !message) return { ok: false, supported: false, error: 'Both target and message are required.' };
    const ci = target.indexOf(':');
    const platform = (ci >= 0 ? target.slice(0, ci) : target).toLowerCase();
    const chatId = ci >= 0 ? target.slice(ci + 1) : '';
    if (platform !== 'dev') {
      return {
        ok: false, supported: false, target: target,
        error: 'Agent OS exposes no outbound-send route for platform channel "' + platform + '". Channel replies are produced only as agent turns inside runs. Use messages_send target "dev:<chat>" to drive the station over its local DEV channel (requires Agent OS running with DEV mode).'
      };
    }
    const r = await ctx.callSidecar('POST', '/api/dev/inbound', { text: message, chatId: chatId || 'devchat' });
    if (!r.ok) return sidecarDown(ctx, r);
    if (r.status === 404) return { ok: false, supported: false, target: target, error: 'The DEV channel is only available when Agent OS runs with DEV mode enabled (launch with SKYNET_DEV=1). No message was delivered.' };
    if (r.status !== 200) return badStatus('/api/dev/inbound', r);
    const j = r.json || {};
    return { ok: true, target: target, delivered: true, agentId: j.agentId || null, isTask: !!j.isTask, replies: Array.isArray(j.replies) ? j.replies : [] };
  },

  async channels_list(args, ctx) {
    const platform = str(args.platform).toLowerCase();
    const r = await ctx.callSidecar('GET', '/api/channels/status');
    if (!r.ok) return sidecarDown(ctx, r);
    if (r.status !== 200) return badStatus('/api/channels/status', r);
    const statusMap = (r.json && typeof r.json === 'object') ? r.json : {};
    const channels = [];
    for (const id of Object.keys(statusMap)) {
      if (platform && id.toLowerCase() !== platform) continue;
      const s = statusMap[id] || {};
      channels.push({
        target: str(id), platform: str(id),
        name: str(s.agentName || id),
        connected: !!s.connected, configured: !!s.configured, state: str(s.state)
      });
    }
    return { count: channels.length, channels: channels };
  },

  async permissions_list_open(args, ctx) {
    void args;
    const r = await ctx.callSidecar('GET', '/api/state/snapshot');
    if (!r.ok) return sidecarDown(ctx, r);
    if (r.status !== 200) return badStatus('/api/state/snapshot', r);
    const prompts = (r.json && Array.isArray(r.json.prompts)) ? r.json.prompts : [];
    const approvals = prompts.map(p => {
      const d = ctx.queue.promptDetail(p.promptId) || {};
      return {
        id: str(p.runId) + '|' + str(p.promptId),
        runId: str(p.runId), promptId: str(p.promptId),
        agentId: str(p.agentId || d.agentId),
        tool: str(d.tool), scope: str(d.scope), argsSummary: str(d.argsSummary)
      };
    });
    return { count: approvals.length, approvals: approvals };
  },

  async permissions_respond(args, ctx) {
    const id = str(args.id);
    const decision = str(args.decision);
    if (decision !== 'allow-once' && decision !== 'allow-always' && decision !== 'deny') {
      return { error: 'Invalid decision: ' + decision + '. Must be allow-once, allow-always, or deny.' };
    }
    const bar = id.indexOf('|');
    if (bar < 0) return { error: 'Invalid approval id (expected "runId|promptId"): ' + id };
    const runId = id.slice(0, bar);
    const promptId = id.slice(bar + 1);
    if (!runId || !promptId) return { error: 'Invalid approval id (expected "runId|promptId"): ' + id };
    const mapped = decision === 'allow-once' ? 'once' : decision === 'allow-always' ? 'always' : 'deny';
    const r = await ctx.callSidecar('POST', '/api/consent', { runId: runId, promptId: promptId, decision: mapped });
    if (!r.ok) return sidecarDown(ctx, r);
    if (r.status !== 200) return badStatus('/api/consent', r);
    return { resolved: true, id: id, decision: decision, mapped: mapped };
  }
};

// ---------------------------------------------------------------------------
// the JSON-RPC bridge — dispatches one inbound message to a response (or null for notifications)
// ---------------------------------------------------------------------------

function makeBridge(deps) {
  deps = deps || {};
  const callSidecar = deps.callSidecar;
  if (typeof callSidecar !== 'function') throw new Error('makeBridge: callSidecar is required');
  const queue = deps.queue || makeEventQueue({});
  const ctx = { callSidecar: callSidecar, queue: queue, baseLabel: deps.baseLabel || '' };
  let negotiated = LATEST_PROTOCOL;

  async function callTool(name, args) {
    const impl = IMPLS[name];
    if (!impl) return { __unknownTool: true, error: 'unknown tool: ' + name };
    try { return await impl(args || {}, ctx); }
    catch (e) { return { ok: false, error: 'tool "' + name + '" failed: ' + ((e && e.message) || e) }; }
  }

  function ok(id, result) { return { jsonrpc: JSONRPC, id: id, result: result }; }
  function fail(id, code, message) { return { jsonrpc: JSONRPC, id: id, error: { code: code, message: message } }; }

  async function handleRpc(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== JSONRPC) {
      // tolerate a missing jsonrpc tag but never crash; a truly malformed frame with an id gets an error.
      if (msg && msg.id != null && msg.method) { /* fall through to method dispatch */ }
      else if (msg && msg.id != null) return fail(msg.id, -32600, 'invalid request');
      else return null;
    }
    const method = str(msg.method);
    const isNotification = msg.id == null;

    if (method === 'initialize') {
      const want = str(msg.params && msg.params.protocolVersion);
      negotiated = PROTO_RE.test(want) ? want : LATEST_PROTOCOL;
      return ok(msg.id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS
      });
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
    if (method === 'ping') return isNotification ? null : ok(msg.id, {});
    if (method === 'tools/list') return ok(msg.id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = str(msg.params && msg.params.name);
      const args = (msg.params && msg.params.arguments) || {};
      const result = await callTool(name, args);
      const isError = !!(result && (result.__unknownTool || result.sidecarReachable === false));
      if (result && result.__unknownTool) delete result.__unknownTool;
      return ok(msg.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: isError });
    }
    if (isNotification) return null;                          // unknown notification — ignore
    return fail(msg.id, -32601, 'method not found: ' + method);
  }

  return { handleRpc, callTool, get protocolVersion() { return negotiated; } };
}

module.exports = { LATEST_PROTOCOL, SERVER_INFO, INSTRUCTIONS, TOOLS, makeEventQueue, makeBridge, _internals: { clampInt, runToConversation } };
