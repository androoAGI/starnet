/* sidecar/openai-compat.js — an OpenAI-compatible HTTP surface (/v1/*) so EXTERNAL local clients and other
   harnesses can start REAL StarNet agent runs over HTTP. This is the seam where "another harness talks to
   StarNet" actually runs agent work. An independent implementation, wire-compatible with the reference
   harness's API server surface, built on StarNet's one-process / runOnce / U.bus architecture.

   ── WHY THIS IS A SEPARATE AUTH SEAM (read before changing) ────────────────────────────────────────────────
   The rest of the sidecar's /api/* routes are fenced by the per-LAUNCH token that index.js injects into the
   served page (see apiauth.js). That token is for the STATION'S OWN browser UI. /v1/* is different: it is for
   external local clients (an OpenAI SDK, another harness, a CLI) that NEVER see the page and cannot read that
   token. So /v1 carries its OWN bearer key (env STARNET_API_KEY / STARNET_V1_KEY, or a persisted server config)
   compared timing-safe, exactly like the reference harness's API_SERVER_KEY.

   HARD REFUSAL TO RUN WITHOUT A STRONG KEY: /v1 dispatches terminal-capable agent work — a guessable key is
   remote code execution. So with NO key configured (or one shorter than 16 chars) EVERY /v1/* request answers
   403 with a JSON body explaining how to enable it. There is no "loopback is safe" exemption (a co-resident
   process on the same box is exactly the threat). The sidecar-wide Host loopback pin (apiauth.isAllowedHost)
   is ALSO applied here (index.js's isApi gate only covers /api/*, so /v1 must enforce it itself).

   ── REAL HTTP STATUS CODES (deliberate) ────────────────────────────────────────────────────────────────────
   Unlike StarNet's media endpoints' 200-always contract, /v1 returns real HTTP codes (401/403/429/400/404/502)
   because OpenAI-client compatibility IS the contract here — an OpenAI SDK inspects res.status.

   ── RUNS RIDE THE EXISTING AUTONOMOUS SEAM ─────────────────────────────────────────────────────────────────
   Every run goes through the SAME runOnce entrypoint the channels hub uses (channels/hub.js), with
   surface:'autonomous' (a headless HTTP caller has no browser to answer a permission.prompt, so an ungranted
   mutation default-denies and the run continues — never stalls) and broadcast:true (so the station floor lights
   up for an externally-triggered run — the product feature: a user SEES that an outside harness talked to their
   station). Cost/billing reconciliation flows untouched through runOnce. Usage tokens in the OpenAI `usage`
   object are summed from the run's REAL agent.cost token counters — never synthesized (truthful telemetry).

   This module is factored PURE/injected (like apiauth.js) so it is unit/e2e-testable without booting index.js:
   index.js cannot be required by a test, so all decision logic and run-wiring live here behind injected deps,
   and index.js keeps only a thin route-dispatch line. */
'use strict';
const nodeCrypto = require('node:crypto');
const resultContract = require('./result-contract');

const DEFAULT_MAX_CONCURRENT = 0;   // unlimited by default; env STARNET_V1_MAX_CONCURRENT opts into a ceiling
const MIN_KEY_LEN = 16;              // below this, refuse to enable (guessable key on a terminal-capable surface = RCE)
const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DEFAULT_MODEL_ID = 'starnet-agent';   // the stable advertised model id
const RUN_TTL_MS = 60 * 60 * 1000;   // terminal /v1/runs records are swept an hour after they finish
const MAX_BODY = 10 * 1024 * 1024;   // 10MB — long agent conversations with tool calls

// ---- pure helpers (no ambient clock/rng; all injected) ---------------------------------------------------

// OpenAI-style error envelope. Every field is always present (even null) so an OpenAI SDK never trips on a
// missing key — mirrors the reference harness _openai_error.
function openAiError(message, opts) {
  const o = opts || {};
  return { error: { message: String(message == null ? '' : message), type: o.type || 'invalid_request_error', param: o.param == null ? null : o.param, code: o.code == null ? null : o.code } };
}

// Is the configured key strong enough to ENABLE /v1 at all? Empty/whitespace or <16 chars => disabled.
function keyUsable(key) { const k = String(key == null ? '' : key).trim(); return k.length >= MIN_KEY_LEN; }

// Extract the bearer token from the Authorization header ("Bearer <key>"). '' when absent/malformed.
function bearerToken(req) {
  const h = String(((req && req.headers) || {})['authorization'] || '');
  if (h.slice(0, 7).toLowerCase() === 'bearer ') return h.slice(7).trim();
  return '';
}

// constant-time compare (never throws; false on length mismatch/empty). Reused from apiauth via injection, but
// kept here too so the pure helpers are self-contained for unit tests.
function constTimeEq(a, b) {
  a = String(a == null ? '' : a); b = String(b == null ? '' : b);
  if (!a || !b || a.length !== b.length) return false;
  try { return nodeCrypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch (_) { return false; }
}

// the path portion of a url, query stripped.
function pathOf(url) { const u = String(url || ''); const i = u.indexOf('?'); return i < 0 ? u : u.slice(0, i); }

// sanitize any string to the notebook/fs-jail agentId grammar.
function sanitizeAid(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40); }

// Flatten OpenAI chat message content (string, or array of typed parts) into a plain string. Mirrors the reference harness
// _normalize_chat_content: pulls text/input_text/output_text parts, skips images/other. Bounded for safety.
function normalizeContent(content, depth) {
  depth = depth || 0;
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    if (depth > 6) return '';
    const parts = [];
    for (const item of content.slice(0, 1000)) {
      if (typeof item === 'string') { if (item) parts.push(item); continue; }
      if (item && typeof item === 'object') {
        const t = String(item.type || '').trim().toLowerCase();
        if (t === 'text' || t === 'input_text' || t === 'output_text') { if (item.text != null) parts.push(String(item.text)); }
      }
    }
    return parts.join('\n');
  }
  try { return String(content); } catch (_) { return ''; }
}

// Split an OpenAI `messages` array into { system, history, lastUser }. System messages are \n-joined into an
// ephemeral system prompt; the LAST user message is the input; every user/assistant message before it is history.
// Returns { ok:false } when there is no user message to act on (caller answers 400). Mirrors the reference harness's parsing.
function splitMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return { ok: false, reason: 'messages' };
  const systems = [];
  const convo = [];   // {role, content} for user/assistant/tool turns, in order
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || '').toLowerCase();
    const content = normalizeContent(m.content);
    if (role === 'system' || role === 'developer') { if (content) systems.push(content); continue; }
    if (role === 'user' || role === 'assistant') convo.push({ role, content });
  }
  // find the last user turn — that is the directive; everything before it is history context.
  let lastUserIdx = -1;
  for (let i = convo.length - 1; i >= 0; i--) { if (convo[i].role === 'user') { lastUserIdx = i; break; } }
  if (lastUserIdx < 0) return { ok: false, reason: 'no_user' };
  const lastUser = convo[lastUserIdx].content;
  if (!String(lastUser || '').trim()) return { ok: false, reason: 'no_user' };
  const history = convo.slice(0, lastUserIdx);
  return { ok: true, system: systems.join('\n'), history, lastUser, convo };
}

// coerce a bool-ish payload value (some frontends serialize `stream` as the STRING "false", which is truthy).
function coerceBool(v, def) {
  if (typeof v === 'boolean') return v;
  if (v == null) return !!def;
  if (typeof v === 'string') { const s = v.trim().toLowerCase(); if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true; if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false; return !!def; }
  if (typeof v === 'number') return !!v;
  return !!def;
}

// Only a proven terminal event may assert completion. Earlier recoverable errors do not
// override a later successful end; a missing end is interrupted, never implicit success.
function runOutcome(reason, hadText, error) {
  const status = reason === 'done' ? 'completed'
    : reason === 'error' ? 'failed'
    : reason === 'cancelled' ? 'cancelled'
    : reason === 'max_iters' || reason === 'budget' ? 'limited'
    : reason === 'clarifying' ? 'awaiting_input'
    : reason === 'refusal' ? 'refused' : 'interrupted';
  return { status, reason: reason || 'missing_terminal', completed: status === 'completed',
    partial: !!hadText && status !== 'completed', failed: status === 'failed',
    error: ['failed', 'interrupted'].includes(status) ? (error || 'Agent run ended without a successful terminal event') : null };
}
function finishReasonFor(reason) {
  const status = runOutcome(reason, false).status;
  if (status === 'limited') return 'length';
  if (['completed', 'awaiting_input', 'refused'].includes(status)) return 'stop';
  return 'error';
}
function runTerminalEvent(reason) { return 'run.' + runOutcome(reason, false).status; }

// build the sync chat.completion object (real usage numbers from the summed counters).
function chatCompletionObject(o) {
  return {
    id: o.id, object: 'chat.completion', created: o.created, model: o.model,
    choices: [{ index: 0, message: { role: 'assistant', content: o.content }, finish_reason: o.finishReason }],
    usage: { prompt_tokens: o.usage.prompt_tokens, completion_tokens: o.usage.completion_tokens, total_tokens: o.usage.total_tokens }
  };
}

// build one streaming chat.completion.chunk.
function chatChunk(o) {
  const c = { id: o.id, object: 'chat.completion.chunk', created: o.created, model: o.model, choices: [{ index: 0, delta: o.delta || {}, finish_reason: o.finishReason == null ? null : o.finishReason }] };
  if (o.usage) c.usage = o.usage;
  return c;
}

// derive a stable session id from the conversation seed (used when no explicit session header is supplied, so a
// multi-turn OpenAI client that resends full history threads onto one agent/transcript). Mirrors the reference harness.
function deriveSessionId(system, firstUser) {
  const seed = String(system || '') + '\n' + String(firstUser || '');
  return 'api-' + nodeCrypto.createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16);
}

// ── the factory ────────────────────────────────────────────────────────────────────────────────────────────
/* deps:
     runOnce(o)                     REQUIRED — the run entrypoint (index.js's runOnce)
     apiKey()             -> string REQUIRED — the configured /v1 bearer key (env/persisted); '' when unset
     resolveProviderKey(provider)   REQUIRED — providerRuntimeKey(provider,'')  (BYOK key from runtime layer/env)
     resolveBaseUrl(provider)       -> string (providerRuntimeBaseUrl(provider,''))
     roster()             -> [{agentId,name,model,provider}]  (for /v1/models + agent selection)
     store                          the channel transcript store (loadHistory/appendTurn) — for app visibility
     isAllowedHost(host)  -> bool   apiauth.isAllowedHost (the loopback pin)
     defaultModel         -> string the run model when the client selects the generic 'starnet-agent' ('' => runOnce default)
     maxConcurrent        -> number the cap (env override resolved by index.js); 0 disables
     version              -> string reported by /health + /v1 model created stamp is `now`
     newId()              -> string uuid
     now()                -> number Date.now
     readBody(req, max)   -> Promise<string>
     redact(s)            -> string
     logBoot(line)                  one-line boot log (enabled/disabled) */
function makeOpenAiCompat(deps) {
  const d = deps || {};
  if (typeof d.runOnce !== 'function') throw new Error('makeOpenAiCompat: runOnce is required');
  const runOnce = d.runOnce;
  const apiKeyFn = typeof d.apiKey === 'function' ? d.apiKey : () => '';
  const rosterFn = typeof d.roster === 'function' ? d.roster : () => [];
  const resolveProviderKey = typeof d.resolveProviderKey === 'function' ? d.resolveProviderKey : () => '';
  const resolveBaseUrl = typeof d.resolveBaseUrl === 'function' ? d.resolveBaseUrl : () => '';
  const store = d.store || null;
  const isAllowedHost = typeof d.isAllowedHost === 'function' ? d.isAllowedHost : () => true;
  const eq = typeof d.constTimeEq === 'function' ? d.constTimeEq : constTimeEq;
  const defaultModel = () => String((typeof d.defaultModel === 'function' ? d.defaultModel() : d.defaultModel) || '').trim();
  const maxConcurrent = () => { const n = typeof d.maxConcurrent === 'function' ? d.maxConcurrent() : d.maxConcurrent; const v = Number(n); return (Number.isFinite(v) && v >= 0) ? Math.floor(v) : DEFAULT_MAX_CONCURRENT; };
  const version = () => String((typeof d.version === 'function' ? d.version() : d.version) || 'dev');
  const newId = typeof d.newId === 'function' ? d.newId : () => nodeCrypto.randomUUID();
  if (typeof d.now !== 'function') throw new Error('makeOpenAiCompat: now() is required (injected clock — no ambient time in backend logic)');
  const now = d.now;
  const readBody = typeof d.readBody === 'function' ? d.readBody : null;
  const redact = typeof d.redact === 'function' ? d.redact : (s) => s;

  // shared in-flight counter across chat/completions (sync+stream) AND /v1/runs. 429 when it would exceed the cap.
  let inFlight = 0;
  // /v1/runs lifecycle store: runId -> { status, created, updated, sessionId, model, output, usage, error,
  //   events:[], subs:Set, closed, abort, finishedAt }. Bounded by a lazy TTL sweep on each new run.
  const runs = new Map();

  function enabled() { return keyUsable(apiKeyFn()); }

  // ---- small res writers -------------------------------------------------------------------------------------
  function json(res, code, obj, headers) {
    const h = Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, headers || {});
    try { res.writeHead(code, h); res.end(JSON.stringify(obj)); } catch (_) { try { res.end(); } catch (__) {} }
  }
  function sseHead(res) {
    try { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); } catch (_) {}
  }
  function sseData(res, obj) { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (_) {} }
  function sseComment(res, txt) { try { res.write(': ' + txt + '\n\n'); } catch (_) {} }

  // ---- run wiring: the ONE place that calls runOnce (the autonomous seam) ------------------------------------
  // Resolve which roster agent (if any) the request's `model` field selects, per the LOCKED design: the generic
  // 'starnet-agent' (or an unknown value) => the default agent; a value matching a roster agentId or name => that
  // specialist (so `model` can pick an agent, mapping onto runOnce's agentId).
  function resolveTarget(modelField) {
    const q = String(modelField == null ? '' : modelField).trim();
    if (!q || q.toLowerCase() === DEFAULT_MODEL_ID) return { matched: false, agentId: '', model: '', provider: '' };
    let roster = [];
    try { roster = rosterFn() || []; } catch (_) { roster = []; }
    for (const a of roster) {
      if (String(a.agentId) === q || String(a.name || '').toLowerCase() === q.toLowerCase()) {
        return { matched: true, agentId: String(a.agentId), model: String(a.model || ''), provider: String(a.provider || '') };
      }
    }
    return { matched: false, agentId: '', model: '', provider: '' };
  }

  // Decide the agentId a request runs as:
  //   • explicit session id header  -> a STABLE per-session agent (threads transcript + memory across turns)
  //   • a selected roster agent     -> that specialist's agentId (stateful; serialized by the same-agent mutex)
  //   • otherwise (stateless)       -> an EPHEMERAL per-request agent, so concurrent external calls never collide
  //     on one agent's workspace mutex.
  function deriveAgentId(sessionId, target) {
    if (sessionId) return sanitizeAid('api-' + sessionId).slice(0, 40) || 'api-0';
    if (target.matched && AID_RE.test(target.agentId)) return target.agentId;
    return sanitizeAid('api-' + String(newId()).replace(/-/g, '')).slice(0, 40) || 'api-0';
  }

  // start a run through runOnce with an injected sink. Returns a promise that resolves when the run settles.
  // `onEvent(name,payload)` (optional) sees every raw run event (for the /v1/runs lifecycle SSE). `onDelta(text)`
  // (optional) sees each real token delta (for chat-completions streaming). `acc` accumulates the assembled
  // reply + summed REAL token counters + terminal reason for the response envelope.
  function startRun(o) {
    const acc = { buf: '', tokensIn: 0, tokensOut: 0, reason: null, errMsg: null, transient: false, runId: o.runId };
    const sink = (name, payload) => {
      const p = payload || {};
      if (name === 'agent.run.start') acc.runId = p.runId || acc.runId;
      else if (name === 'agent.token') { const dlt = p.delta || ''; if (dlt) { acc.buf += dlt; if (o.onDelta) { try { o.onDelta(dlt); } catch (_) {} } } }
      else if (name === 'agent.tool_call') acc.buf = '';
      else if (name === 'agent.cost') { acc.tokensIn += (p.tokensIn || 0); acc.tokensOut += (p.tokensOut || 0); }
      else if (name === 'agent.run.error') { acc.errMsg = p.message || 'run error'; acc.transient = !!p.transient; }
      else if (name === 'capdenied') { acc.errMsg = acc.errMsg || ('no ' + (p.need || 'capability') + ' — ' + (p.reason || '')); }
      else if (name === 'agent.run.end') { acc.reason = p.reason; }
      if (o.onEvent) { try { o.onEvent(name, p); } catch (_) {} }
    };
    const provider = String(o.provider || 'openrouter').trim().toLowerCase() || 'openrouter';
    let key = ''; let baseUrl = '';
    try { key = resolveProviderKey(provider) || ''; } catch (_) { key = ''; }
    try { baseUrl = resolveBaseUrl(provider) || ''; } catch (_) { baseUrl = ''; }
    const p = Promise.resolve().then(() => runOnce({
      key, model: o.model || '', provider, baseUrl,
      system: o.system || '', messages: o.messages || [], agentId: o.agentId,
      emit: sink, signal: o.signal, runId: o.runId,
      trigger: 'event', surface: 'autonomous',   // headless external caller: default-deny ungranted mutation, never stall
      broadcast: true,                            // light the station floor — a user SEES the external harness's run
      taskKey: 'v1:' + o.agentId, taskSource: 'api',
      // an externally-driven run is still this agent doing real work — it learns from it like any other, with each
      // record stamped origin:'api' so the Commander can tell it apart from their own conversation.
      reflect: !o.outputOnly, outputOnly: !!o.outputOnly, maxIters: o.outputOnly ? 1 : undefined
    }));
    return Promise.resolve(p).then(() => acc, (e) => { acc.reason = 'error'; acc.errMsg = acc.errMsg || ('run failed: ' + ((e && e.message) || e)); return acc; });
  }

  // persist the user + assistant turns to the channel transcript store, so an externally-driven run is visible in
  // the app just like a channel-inbound run (product feature). Best-effort — never blocks/breaks the response.
  function persistTurns(agentId, userText, assistantText) {
    if (!store || typeof store.appendTurn !== 'function') return;
    try { store.appendTurn(agentId, 'user', String(userText == null ? '' : userText)); } catch (_) {}
    if (assistantText) { try { store.appendTurn(agentId, 'assistant', String(assistantText)); } catch (_) {} }
  }

  // ---- auth + host gate (applied to every /v1/* request) -----------------------------------------------------
  // returns a truthy response-already-written flag when the request is rejected.
  function gate(req, res) {
    // Host loopback pin (index.js's isApi gate covers only /api/*, so enforce it here for /v1).
    if (!isAllowedHost(((req && req.headers) || {}).host)) { res.writeHead(403); res.end('forbidden host'); return true; }
    const key = apiKeyFn();
    if (!keyUsable(key)) {
      json(res, 403, openAiError(
        'The StarNet /v1 API is disabled. It dispatches terminal-capable agent work, so it refuses to run without a strong bearer key. Set STARNET_API_KEY to a secret of at least ' + MIN_KEY_LEN + ' characters (e.g. `openssl rand -hex 32`) and restart the station to enable /v1.',
        { type: 'invalid_request_error', code: 'api_disabled' }), { 'WWW-Authenticate': 'Bearer' });
      return true;
    }
    if (!eq(bearerToken(req), String(key).trim())) {
      json(res, 401, openAiError('Invalid API key', { code: 'invalid_api_key' }), { 'WWW-Authenticate': 'Bearer' });
      return true;
    }
    return false;
  }

  // the session id header, honored only under auth (which is always true past gate()). Rejects control chars.
  function sessionIdOf(req) {
    const h = (req && req.headers) || {};
    const raw = String(h['x-starnet-session-id'] || h['x-skynet-session-id'] || h['x-hermes-session-id'] || '').trim();
    if (!raw) return '';
    if (/[\r\n\x00]/.test(raw) || raw.length > 256) return '';
    return raw;
  }

  // ---- GET /v1/models ---------------------------------------------------------------------------------------
  function handleModels(req, res) {
    const created = Math.floor(now() / 1000);
    const data = [{ id: DEFAULT_MODEL_ID, object: 'model', created, owned_by: 'starnet', root: DEFAULT_MODEL_ID, parent: null }];
    let roster = [];
    try { roster = rosterFn() || []; } catch (_) { roster = []; }
    for (const a of roster) {
      const id = String(a.name || a.agentId || '').trim();
      if (!id || id.toLowerCase() === DEFAULT_MODEL_ID) continue;
      data.push({ id, object: 'model', created, owned_by: 'starnet', root: String(a.model || id), parent: DEFAULT_MODEL_ID });
    }
    json(res, 200, { object: 'list', data });
  }

  // ---- GET /v1/capabilities ---------------------------------------------------------------------------------
  function handleCapabilities(req, res) {
    json(res, 200, {
      object: 'starnet.capabilities',
      version: version(),
      endpoints: {
        chat_completions: '/v1/chat/completions',
        models: '/v1/models',
        runs: '/v1/runs',
        run_status: '/v1/runs/{run_id}',
        run_events: '/v1/runs/{run_id}/events',
        run_stop: '/v1/runs/{run_id}/stop',
        health: '/health'
      },
      streaming: true,
      session_continuity_header: 'X-StarNet-Session-Id',
      surface: 'autonomous',
      max_concurrent_runs: maxConcurrent(),
      // deliberate follow-ups NOT in this slice (see docs/OPENAI_COMPAT.md):
      unsupported: ['responses_api', 'model_routes', 'cors', 'approvals']
    });
  }

  // ---- POST /v1/chat/completions ----------------------------------------------------------------------------
  async function handleChatCompletions(req, res, suppliedBody, reservedId) {
    if (maxConcurrent() > 0 && inFlight >= maxConcurrent()) {
      return json(res, 429, openAiError('Too many concurrent runs (max ' + maxConcurrent() + ')', { type: 'rate_limit_error', code: 'rate_limit_exceeded' }), { 'Retry-After': '1' });
    }
    let body;
    try { body = suppliedBody || JSON.parse(await readBody(req, MAX_BODY) || '{}'); } catch (_) { return json(res, 400, openAiError('Invalid JSON in request body')); }
    if (!body || typeof body !== 'object') return json(res, 400, openAiError('Invalid JSON in request body'));
    const parsed = splitMessages(body.messages);
    if (!parsed.ok) return json(res, 400, openAiError(parsed.reason === 'messages' ? "Missing or invalid 'messages' field" : 'No user message found in messages'));

    const contract = resultContract.responseContract(body.response_format);
    if (!contract.ok) return json(res,400,openAiError(contract.error,{param:'response_format'}));
    const stream = coerceBool(body.stream, false);
    if (stream && contract.schema) return json(res,400,openAiError('Structured streaming is not supported; use stream:false for host-validated JSON',{param:'stream'}));
    const modelField = String(body.model || DEFAULT_MODEL_ID);
    const target = resolveTarget(modelField);
    const sessionId = sessionIdOf(req) || deriveSessionId(parsed.system, parsed.history.length ? (parsed.history[0].content) : parsed.lastUser);
    const agentId = deriveAgentId(sessionId, target);
    const runModel = target.matched ? (target.model || defaultModel()) : defaultModel();
    const provider = target.provider || 'openrouter';
    // conversation for runOnce = prior turns (history) + the new user directive last (system passed separately).
    const messages = parsed.history.map(m => ({ role: m.role, content: m.content })).concat([{ role: 'user', content: parsed.lastUser }]);
    let system = parsed.system || 'You are the Commander\'s StarNet agent, reached over an OpenAI-compatible API. Use your REAL tools when given a task and report what you actually did.';

    if (contract.schema) system += '\nReturn ONLY strict JSON matching this schema: ' + JSON.stringify(contract.schema);
    const id = reservedId || 'chatcmpl-' + String(newId()).replace(/-/g, '').slice(0, 24);
    const created = Math.floor(now() / 1000);
    const ac = new AbortController();

    if (stream) {
      sseHead(res);
      // role chunk first (OpenAI convention)
      sseData(res, chatChunk({ id, model: modelField, created, delta: { role: 'assistant' } }));
      // a vanished client (reload/crash) must interrupt the run — abort on socket close before we finish.
      let finished = false;
      res.on('close', () => { if (!finished) { try { ac.abort(); } catch (_) {} } });
      inFlight++;
      let acc;
      try {
        acc = await startRun({ runId: id, agentId, model: runModel, provider, system, messages, signal: ac.signal, onDelta: (dlt) => sseData(res, chatChunk({ id, model: modelField, created, delta: { content: dlt } })) });
      } finally { inFlight--; }
      finished = true;
      const finishReason = finishReasonFor(acc.reason);
      const usage = { prompt_tokens: acc.tokensIn, completion_tokens: acc.tokensOut, total_tokens: acc.tokensIn + acc.tokensOut };
      const finishChunk = chatChunk({ id, model: modelField, created, delta: {}, finishReason, usage });
      finishChunk.starnet = runOutcome(acc.reason, !!acc.buf, acc.errMsg && redact(acc.errMsg));
      if (finishReason === 'error') finishChunk.error = { message: redact(acc.errMsg || 'agent run did not produce a response'), type: 'agent_error' };
      sseData(res, finishChunk);
      try { res.write('data: [DONE]\n\n'); } catch (_) {}
      try { res.end(); } catch (_) {}
      persistTurns(agentId, parsed.lastUser, acc.buf);
      return;
    }

    // sync JSON
    inFlight++;
    let acc;
    try { acc = await startRun({ runId: id, agentId, model: runModel, provider, system, messages, signal: ac.signal }); }
    finally { inFlight--; }
    if (contract.schema && acc.reason === 'done') {
      const checked = resultContract.inspect(contract.schema,acc.buf);
      if (!checked.ok) {
        inFlight++;
        let repair;
        try { repair = await startRun({runId:id+'-repair',agentId,model:runModel,provider,system,
          messages:[{role:'assistant',content:acc.buf}, {role:'user',content:'Repair only the preceding result; do not repeat the original task. Return strict JSON. Errors: '+checked.errors.join('; ')}],signal:ac.signal,outputOnly:true}); } finally { inFlight--; }
        acc.tokensIn += repair.tokensIn; acc.tokensOut += repair.tokensOut;
        const repaired = resultContract.inspect(contract.schema,repair.buf);
        if (repair.reason === 'done' && repaired.ok) { acc.buf=repair.buf; acc.reason='done'; acc.errMsg=null; }
        else { acc.reason='error'; acc.errMsg='Structured output validation failed after one output-only repair: '+(repaired.errors.join('; ') || repair.errMsg || repair.reason); }
      }
    }
    persistTurns(agentId, parsed.lastUser, acc.buf);
    if (!acc.buf && ['failed', 'interrupted'].includes(runOutcome(acc.reason, false).status)) {
      // no text produced AND an error — hard fail with an OpenAI-style server_error (like the reference harness agent_incomplete).
      return json(res, 502, openAiError(redact(acc.errMsg || 'Agent run ended without a successful terminal event'), { type: 'server_error', code: 'agent_incomplete' }));
    }
    const finishReason = finishReasonFor(acc.reason, !!acc.buf);
    const usage = { prompt_tokens: acc.tokensIn, completion_tokens: acc.tokensOut, total_tokens: acc.tokensIn + acc.tokensOut };
    const response = chatCompletionObject({ id, model: modelField, created, content: acc.buf, finishReason, usage });
    response.starnet = runOutcome(acc.reason, !!acc.buf, acc.errMsg && redact(acc.errMsg));
    if (finishReason === 'error') response.error = { message: response.starnet.error || response.starnet.status, type: 'agent_error' };
    return json(res, 200, response, { 'X-StarNet-Session-Id': sessionId });
  }

  // Keyed streams share progress; their terminal frame waits for durable persistence.
  // Disconnecting one waiter cannot abort the shared run.
  async function handleReservedChat(req, res) {
    const key = req.headers['idempotency-key'];
    if (key == null) return handleChatCompletions(req, res);
    if (typeof key !== 'string' || !key.trim() || key.length > 256 || /[\x00-\x1f\x7f]/.test(key))
      return json(res, 400, openAiError('Idempotency-Key must contain 1–256 printable characters'));
    if (!d.requestReservations) return json(res, 503, openAiError('Durable request reservations are unavailable'));
    let body;
    try { body = JSON.parse(await readBody(req, MAX_BODY) || '{}'); }
    catch (_) { return json(res, 400, openAiError('Invalid JSON in request body')); }
    if (!body || typeof body !== 'object' || !splitMessages(body.messages).ok)
      return json(res, 400, openAiError('Missing or invalid messages'));
    const scope = nodeCrypto.createHash('sha256').update(bearerToken(req)).digest('hex') + ':' + sessionIdOf(req) + ':/v1/chat/completions';
    let sent=0;
    const onProgress=item=>{
      if(!eq(bearerToken(req),String(apiKeyFn()).trim())) {res.destroy();return;}
      if(!res.headersSent)res.writeHead(200,item.headers);
      res.write(item.chunk); sent+=item.chunk.length;
    };
    try {
      const result = await d.requestReservations.run({scope, key, onProgress, body:{request:body,target:resolveTarget(body.model),defaultModel:defaultModel()}, runId:'chatcmpl-' + String(newId()).replace(/-/g, '').slice(0,24)}, async (runId,emitProgress) => {
        const chunks=[];
        const capture={status:200, headers:{}, on(){}, writeHead(status,headers){this.status=status;this.headers=headers;},
          write(value){
            const chunk=String(value); chunks.push(chunk);
            // Only nonterminal chat deltas are provisional. Commit final usage/status
            // and DONE together after saving the exact complete response.
            if(chunk.startsWith('data: {')) {const frame=JSON.parse(chunk.slice(6));if(frame.choices && frame.choices[0].finish_reason==null)emitProgress({headers:this.headers,chunk});}
            return true;
          }, end(value){if(value)chunks.push(String(value));}};
        await handleChatCompletions(req,capture,body,runId);
        return {status:capture.status,headers:capture.headers,body:chunks.join('')};
      });
      // Credentials can rotate while the shared run is executing.
      if(res.headersSent) {
        if(!eq(bearerToken(req),String(apiKeyFn()).trim())) {res.destroy();return;}
        res.end(result.body.slice(sent));
      } else {if(gate(req,res))return;res.writeHead(result.status,result.headers);res.end(result.body);}
    } catch(e) {
      const conflict=['idempotency_conflict','request_interrupted'].includes(e.code);
      const failure=openAiError(redact(e.message),{code:e.code || 'reservation_failed'});
      if(res.headersSent) {sseData(res,failure);res.end('data: [DONE]\n\n');return;}
      return json(res,conflict?409:503,failure);
    }
  }

  // ---- /v1/runs lifecycle store helpers ---------------------------------------------------------------------
  function sweepRuns() {
    const cutoff = now() - RUN_TTL_MS;
    for (const [rid, r] of runs) { if (r.closed && r.finishedAt && r.finishedAt < cutoff && (!r.subs || r.subs.size === 0)) runs.delete(rid); }
  }
  function pushRunEvent(rid, ev) {
    const r = runs.get(rid); if (!r) return;
    r.events.push(ev); r.updated = now();
    if (ev && ev.event) r.status = statusForEvent(ev.event, r.status);
    for (const w of r.subs) { try { w(ev); } catch (_) {} }
  }
  function statusForEvent(event, cur) {
    if (event === 'run.completed') return 'completed';
    if (event === 'run.failed') return 'failed';
    if (event === 'run.cancelled') return 'cancelled';
    if (['run.interrupted', 'run.limited', 'run.awaiting_input', 'run.refused'].includes(event)) return event.slice(4);
    if (event === 'run.started') return 'running';
    return cur;
  }
  // map a raw runOnce event to a typed /v1/runs lifecycle event (only ones we can PROVE from backend state).
  function mapRunEvent(name, p, rid, ts) {
    if (name === 'agent.run.start') return { event: 'run.started', run_id: rid, timestamp: ts };
    if (name === 'agent.tool_call') return { event: 'tool.started', run_id: rid, timestamp: ts, tool: p.name || 'unknown', call_id: p.callId || '' };
    if (name === 'agent.tool_result') return { event: 'tool.completed', run_id: rid, timestamp: ts, tool: p.name || '', call_id: p.callId || '', duration_ms: p.ms || 0, error: !!p.isError };
    if (name === 'agent.token') { const dlt = p.delta || ''; return dlt ? { event: 'message.delta', run_id: rid, timestamp: ts, delta: dlt } : null; }
    return null;   // run.end is turned into a terminal event by the run flow (it needs output/usage)
  }

  // ---- POST /v1/runs ----------------------------------------------------------------------------------------
  async function handleRunsCreate(req, res) {
    if (maxConcurrent() > 0 && inFlight >= maxConcurrent()) {
      return json(res, 429, openAiError('Too many concurrent runs (max ' + maxConcurrent() + ')', { type: 'rate_limit_error', code: 'rate_limit_exceeded' }), { 'Retry-After': '1' });
    }
    let body;
    try { body = JSON.parse(await readBody(req, MAX_BODY) || '{}'); } catch (_) { return json(res, 400, openAiError('Invalid JSON in request body')); }
    // accept OpenAI Responses-ish `input` (string or array) OR chat `messages`.
    let system = '', history = [], lastUser = '';
    if (Array.isArray(body.messages) && body.messages.length) {
      const parsed = splitMessages(body.messages);
      if (!parsed.ok) return json(res, 400, openAiError('No user message found in messages'));
      system = parsed.system; history = parsed.history; lastUser = parsed.lastUser;
    } else {
      const input = body.input;
      if (typeof input === 'string') lastUser = input;
      else if (Array.isArray(input) && input.length) { const last = input[input.length - 1]; lastUser = typeof last === 'string' ? last : normalizeContent((last && last.content) != null ? last.content : last); }
      if (!String(lastUser || '').trim()) return json(res, 400, openAiError("Missing 'input' field", { code: 'missing_input' }));
      if (typeof body.instructions === 'string') system = body.instructions;
    }

    const runId = 'run_' + String(newId()).replace(/-/g, '');
    const modelField = String(body.model || DEFAULT_MODEL_ID);
    const target = resolveTarget(modelField);
    const sessionId = sessionIdOf(req) || runId;
    const agentId = deriveAgentId(sessionId === runId ? '' : sessionId, target) || sanitizeAid(runId);
    const runModel = target.matched ? (target.model || defaultModel()) : defaultModel();
    const provider = target.provider || 'openrouter';
    const messages = history.map(m => ({ role: m.role, content: m.content })).concat([{ role: 'user', content: lastUser }]);
    const sys = system || 'You are the Commander\'s StarNet agent, reached over an OpenAI-compatible API. Use your REAL tools when given a task and report what you actually did.';

    const ac = new AbortController();
    sweepRuns();
    const rec = { status: 'queued', created: now(), updated: now(), sessionId, model: modelField, output: null, usage: null, error: null, events: [], subs: new Set(), closed: false, abort: ac, finishedAt: 0 };
    runs.set(runId, rec);

    // async task: drive the run; feed lifecycle events; record terminal status. Does NOT block the 202.
    // run.started is emitted by mapRunEvent when runOnce fires agent.run.start (single source — no duplicate).
    inFlight++;
    rec.status = 'running';
    startRun({
      runId, agentId, model: runModel, provider, system: sys, messages, signal: ac.signal,
      onEvent: (name, p) => { const ev = mapRunEvent(name, p, runId, now()); if (ev) pushRunEvent(runId, ev); }
    }).then((acc) => {
      const usage = { prompt_tokens: acc.tokensIn, completion_tokens: acc.tokensOut, total_tokens: acc.tokensIn + acc.tokensOut };
      const evName = runTerminalEvent(acc.reason);
      const outcome = runOutcome(acc.reason, !!acc.buf, acc.errMsg && redact(acc.errMsg));
      const term = { event: evName, run_id: runId, timestamp: now(), output: acc.buf, usage, starnet: outcome };
      rec.output = acc.buf; rec.usage = usage; rec.outcome = outcome;
      if (outcome.error) { term.error = outcome.error; rec.error = outcome.error; }
      pushRunEvent(runId, term);
      persistTurns(agentId, lastUser, acc.buf);
    }).catch((e) => {
      pushRunEvent(runId, { event: 'run.failed', run_id: runId, timestamp: now(), error: redact((e && e.message) || String(e)) });
      rec.error = redact((e && e.message) || String(e));
    }).then(() => {
      inFlight--;
      rec.closed = true; rec.finishedAt = now();
      // wake any live SSE subscribers so they close.
      for (const w of rec.subs) { try { w(null); } catch (_) {} }
    });

    return json(res, 202, { run_id: runId, status: 'started' });
  }

  // ---- GET /v1/runs/{id} ------------------------------------------------------------------------------------
  function handleRunStatus(req, res, runId) {
    const r = runs.get(runId);
    if (!r) return json(res, 404, openAiError('Run not found: ' + runId, { code: 'run_not_found' }));
    json(res, 200, { object: 'starnet.run', run_id: runId, status: r.status, created_at: r.created, updated_at: r.updated, session_id: r.sessionId, model: r.model, output: r.output, usage: r.usage, error: r.error, starnet: r.outcome || null });
  }

  // ---- GET /v1/runs/{id}/events (SSE) -----------------------------------------------------------------------
  function handleRunEvents(req, res, runId) {
    const r = runs.get(runId);
    if (!r) return json(res, 404, openAiError('Run not found: ' + runId, { code: 'run_not_found' }));
    sseHead(res);
    const ka = setInterval(() => sseComment(res, 'keepalive'), 30000);
    // the run flow pushes a null sentinel to every subscriber when it finishes; a live event is written as-is.
    const writer = (ev) => {
      if (ev == null) { clearInterval(ka); sseComment(res, 'stream closed'); try { res.end(); } catch (_) {} r.subs.delete(writer); return; }
      sseData(res, ev);
    };
    // replay every buffered event, then subscribe for live ones. Snapshot the length so an event pushed during
    // replay is delivered by the live writer, not skipped. Subscribe BEFORE the closed-check so a run that ends
    // in this window still delivers its null sentinel to us (never a hung stream).
    const already = r.events.length;
    for (let i = 0; i < already; i++) sseData(res, r.events[i]);
    r.subs.add(writer);
    for (let i = already; i < r.events.length; i++) sseData(res, r.events[i]);   // catch events pushed during replay
    res.on('close', () => { clearInterval(ka); r.subs.delete(writer); });
    if (r.closed) writer(null);   // already finished — flush the close now rather than hang
  }

  // ---- POST /v1/runs/{id}/stop ------------------------------------------------------------------------------
  function handleRunStop(req, res, runId) {
    const r = runs.get(runId);
    if (!r) return json(res, 404, openAiError('Run not found: ' + runId, { code: 'run_not_found' }));
    if (r.abort && !r.closed) { try { r.abort.abort(); } catch (_) {} r.status = 'stopping'; }
    json(res, 200, { run_id: runId, status: r.closed ? r.status : 'stopping' });
  }

  // ---- GET /health (no auth — liveness probe) ---------------------------------------------------------------
  function handleHealth(req, res) { json(res, 200, { status: 'ok', platform: 'starnet-agent', version: version() }); }

  // ── the single entrypoint index.js dispatches to ──────────────────────────────────────────────────────────
  // returns true if this module OWNED the request (wrote a response); false if the path isn't ours (index.js
  // falls through to its static handler). All /v1/* pass through gate() first (host pin + bearer auth).
  function handle(req, res) {
    const p = pathOf(req.url);
    const method = req.method;
    if (p === '/health' && method === 'GET') {
      // Unauthenticated by design (a liveness probe answers before auth) — but it still owes the loopback
      // Host pin. Without it /health sat ABOVE the one defence against DNS rebinding, so a rebound page could
      // read the station's version. index.js's isApi gate covers only /api/*, so this route must pin itself.
      if (!isAllowedHost(((req && req.headers) || {}).host)) { res.writeHead(403); res.end('forbidden host'); return true; }
      handleHealth(req, res); return true;
    }
    if (p !== '/v1' && p.indexOf('/v1/') !== 0) return false;   // not ours

    // Host pin + bearer auth on every /v1/* request.
    if (gate(req, res)) return true;

    if (p === '/v1/models' && method === 'GET') { handleModels(req, res); return true; }
    if (p === '/v1/capabilities' && method === 'GET') { handleCapabilities(req, res); return true; }
    if (p === '/v1/chat/completions' && method === 'POST') { return runGuard(handleReservedChat(req, res), res), true; }
    if (p === '/v1/runs' && method === 'POST') { return runGuard(handleRunsCreate(req, res), res), true; }
    let m;
    /* decodeURIComponent THROWS on a malformed escape ("%ZZ"), and handle() is called SYNCHRONOUSLY as the
       first statement of the server's request callback — above index.js's central
       Promise.resolve(dispatchRoute).catch(routeFailure) guard. So one bad run id became an
       uncaughtException (which surfaceProcessError only logs) and the client waited on a socket that was
       never answered. A path segment we cannot decode is simply not a run id we have: 404 it. */
    const runIdOf = (raw) => { try { return decodeURIComponent(raw); } catch (_) { return null; } };
    const notFound = () => { json(res, 404, openAiError('Run not found', { code: 'not_found' })); return true; };
    if ((m = p.match(/^\/v1\/runs\/([^/]+)\/events$/)) && method === 'GET') { const id = runIdOf(m[1]); return id === null ? notFound() : (handleRunEvents(req, res, id), true); }
    if ((m = p.match(/^\/v1\/runs\/([^/]+)\/stop$/)) && method === 'POST') { const id = runIdOf(m[1]); return id === null ? notFound() : (handleRunStop(req, res, id), true); }
    if ((m = p.match(/^\/v1\/runs\/([^/]+)$/)) && method === 'GET') { const id = runIdOf(m[1]); return id === null ? notFound() : (handleRunStatus(req, res, id), true); }

    json(res, 404, openAiError('Unknown endpoint: ' + method + ' ' + p, { code: 'not_found' }));
    return true;
  }

  // guard an async handler so a late throw (post-headers or pre-headers) never hangs the socket.
  function runGuard(maybePromise, res) {
    Promise.resolve(maybePromise).catch((e) => {
      try {
        if (!res.headersSent) json(res, 500, openAiError(redact('sidecar failure: ' + ((e && e.message) || e)), { type: 'server_error' }));
        else { try { sseData(res, openAiError(redact('sidecar failure: ' + ((e && e.message) || e)), { type: 'server_error' })); res.end('data: [DONE]\n\n'); } catch (_) { try { res.destroy(); } catch (__) {} } }
      } catch (_) { try { res.destroy(); } catch (__) {} }
    });
  }

  // one boot line describing whether /v1 is live (called by index.js after construction).
  function announce() {
    const line = enabled()
      ? '  · /v1 OpenAI-compatible API ENABLED (bearer auth; ' + (maxConcurrent() > 0 ? 'max ' + maxConcurrent() + ' concurrent' : 'unlimited concurrency') + ')'
      : '  · /v1 OpenAI-compatible API disabled — set STARNET_API_KEY (>=' + MIN_KEY_LEN + ' chars) to enable external harness access';
    try { if (typeof d.logBoot === 'function') d.logBoot(line); else console.log(line); } catch (_) {}
  }

  return {
    handle, enabled, announce,
    _internals: { runs, gate, resolveTarget, deriveAgentId, startRun, handleModels, handleChatCompletions, handleRunsCreate }
  };
}

module.exports = {
  makeOpenAiCompat,
  // pure helpers exported for unit tests
  openAiError, keyUsable, bearerToken, constTimeEq, normalizeContent, splitMessages, coerceBool,
  runOutcome, finishReasonFor, runTerminalEvent, chatCompletionObject, chatChunk, deriveSessionId, sanitizeAid, pathOf,
  DEFAULT_MODEL_ID, MIN_KEY_LEN, DEFAULT_MAX_CONCURRENT
};
