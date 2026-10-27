'use strict';
/* test/helpers/strict-upstream.js — ONE STRICT SIMULATOR PER PROVIDER WIRE (provider-conformance-suite, 2026-10-27).

   WHY THIS EXISTS. The gates proved provider behaviour against ~180 PERMISSIVE mocks: a fake upstream that answered
   anything it was sent. Every request shape a real server refuses — a system message after index 0 (#102, a Jinja 500
   from Ollama), a tool result whose call is not in the transcript (E52, OpenRouter), StarNet bookkeeping keys on a
   message (E10, Mistral 422 extra_forbidden), a request ending on an assistant turn (Opus 4.6+ refuses prefill), a
   thinking block replayed against a different prefix (E17, gh#73) — passed every gate and reached users. These
   simulators REFUSE what the real servers refuse, in each wire's own error shape, and answer what they accept in each
   wire's own stream format, so a test drives the REAL adapter (and the real loop) end to end against them.

   WIRES
     chat         Chat Completions as a strict chat template sees it (custom, LM Studio, vLLM, llama.cpp, hosted
                  openai-compatible, OpenRouter non-Claude, Ollama's /v1): ONE system message at index 0, roles
                  alternating user/assistant with tool results between a call batch and the next turn, ends on a
                  user or tool turn, only Chat Completions message keys.
     chat-claude  a Claude model behind a Chat Completions router (OpenRouter / managed): the router hoists the
                  leading system block and merges consecutive user turns (Anthropic's own rule), so those two are
                  allowed; everything else as `chat`.
     ollama       Ollama's native /api/chat (the openai-compatible adapter's nativeOllama wire): the `chat` rules over
                  native messages (string content, `images`, tool_name on results, object arguments).
     anthropic    the Messages API: top-level system, messages alternate user/assistant from a user turn and end on a
                  user turn, tool_result blocks lead the very next user turn and answer that assistant turn's tool_use
                  ids (grammar ^[a-zA-Z0-9_-]{1,64}$), no empty text block, and a replayed THINKING block must carry the
                  bytes and the signature it was issued with, and still sit on the same prefix (the signature binds
                  system + tools + every earlier message; block_binding drop_block makes the server drop it instead).
     gemini       generateContent: systemInstruction apart, contents alternate user/model from a user turn and end on
                  a user turn, a model turn's N functionCall parts are answered by the next user turn leading with N
                  functionResponse parts, and a replayed functionCall carries the thoughtSignature it was issued.
     codex        the Responses API (ChatGPT Codex): instructions apart, no system role in input, the first item a user
                  message, every function_call answered by exactly one function_call_output after it and before the next
                  message, ends on a user message or a function_call_output.
     claude-cli   the Claude Code CLI child: ONE stream-json user message on stdin whose text blocks are the transcript
                  entries (<user>, <assistant>, <tool_result>, <system_note>); it opens on <user>, every <invoke> an
                  assistant entry makes is answered by a <tool_result> in the next entry, and it never ends on an
                  <assistant> entry.

   THE PROMPT CACHE, MEASURED. Each request is cut into canonical pieces (tools, system, then each message — each
   content BLOCK on the block-cached wires), cache markers stripped. A request's cached share is the common prefix of
   pieces with the run's previous request, reported back as the wire's cached-token usage (chars / 4). A test asserts
   that turn N+1 kept every piece of turn N (or all but its last, which a block-merging wire may extend).

   API
     validate(wire, body, state) -> string[]                    violations (empty = the server accepts it)
     makeStrictUpstream(wire, { reply, refusalStatus, model })  -> { fetch, spawn, fs, requests, refusals, reset() }
       reply(n, view) -> { text?, calls?: [{ name, args }] }    the scripted answer to the n-th accepted request of the
                                                                 current run (1-based); view = { lastRole, toolResults }
       requests[i] = { body, violations, pieces, common, prevPieces }
     startStrictHttp(wires, opts)                               the same simulators behind a real HTTP server (the
                                                                 sidecar e2e): /v1/chat/completions (chat), /api/chat,
                                                                 /api/show, /api/ps (ollama), /v1/models
   Pure test code: no network, no sidecar. */

const crypto = require('crypto');
const http = require('http');

const textOf = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : ((p && typeof p.text === 'string') ? p.text : ''))).join('') : (c == null ? '' : String(c)));
const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 24);
const stripCache = v => JSON.parse(JSON.stringify(v == null ? null : v, (k, x) => (k === 'cache_control' ? undefined : x)));

// ---------------------------------------------------------------------------------------------- validators
const CHAT_KEYS = new Set(['role', 'content', 'name', 'tool_calls', 'tool_call_id', 'reasoning_content']);
const OLLAMA_KEYS = new Set(['role', 'content', 'images', 'tool_calls', 'tool_name', 'tool_call_id', 'thinking']);

/* The chat-template contract over a list of { role, content, tool_calls, tool_call_id } messages. `claude` relaxes the
   two rules a Claude router applies itself (a leading block of system messages, consecutive user turns). */
function chatShapeViolations(messages, opts) {
  const o = opts || {};
  const out = [];
  if (!Array.isArray(messages) || !messages.length) return ['messages must be a non-empty array'];
  const keys = o.keys || CHAT_KEYS;
  let lead = 0;
  while (lead < messages.length && messages[lead] && messages[lead].role === 'system') lead++;
  if (!o.claude && lead > 1) out.push('System message must be at the beginning (a second system message at index 1)');
  let prev = null, open = null;   // open: the ids of the last assistant call batch not yet answered
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object') { out.push('messages.' + i + ': not an object'); continue; }
    for (const k of Object.keys(m)) if (!keys.has(k)) out.push('messages.' + i + '.' + m.role + '.' + k + ': Extra inputs are not permitted');
    const role = m.role;
    if (['system', 'user', 'assistant', 'tool'].indexOf(role) < 0) { out.push('messages.' + i + ': unknown role ' + role); continue; }
    if (role === 'system') {
      if (i >= lead) out.push('System message must be at the beginning (system at index ' + i + (prev ? ', after ' + prev.role : '') + ')');
      continue;
    }
    if (role === 'tool') {
      const id = String(m.tool_call_id || '');
      if (!open || !open.has(id)) out.push('messages.' + i + ': tool result ' + (id || '(no id)') + ' answers no call of the turn before it');
      else open.delete(id);
      prev = m;
      continue;
    }
    if (open && open.size) out.push('messages.' + i + ': tool call(s) ' + Array.from(open).join(',') + ' have no result before this ' + role + ' turn');
    open = null;
    if (!prev) { if (role !== 'user') out.push('Conversation roles must alternate: the first turn after the system message must be user, got ' + role); }
    else if (role === 'user' && prev.role === 'user' && !o.claude) out.push('Conversation roles must alternate user/assistant (two user turns at ' + (i - 1) + ',' + i + ')');
    else if (role === 'assistant' && prev.role === 'assistant') out.push('Conversation roles must alternate user/assistant (two assistant turns at ' + (i - 1) + ',' + i + ')');
    if (role === 'assistant') {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (!calls.length && !textOf(m.content).trim()) out.push('messages.' + i + ': Assistant message must have either content or tool_calls');
      if (calls.length) {
        open = new Set();
        for (const tc of calls) {
          const id = String((tc && tc.id) || '');
          if (o.requireCallIds !== false && !id) out.push('messages.' + i + ': a tool call without an id');
          if (id) { if (open.has(id)) out.push('messages.' + i + ': duplicate call id ' + id); open.add(id); }
        }
      }
    }
    prev = m;
  }
  if (open && open.size) out.push('tool call(s) ' + Array.from(open).join(',') + ' have no result');
  const last = messages[messages.length - 1];
  if (last && last.role !== 'user' && last.role !== 'tool') out.push('Expected last role User or Tool, got ' + last.role + (last.role === 'assistant' ? ' (assistant message prefill is not supported)' : ''));
  return out;
}

function chatViolations(body, opts) {
  if (!body || typeof body !== 'object') return ['body is not JSON'];
  return chatShapeViolations(body.messages, opts);
}

// Ollama native: tool results name their call by tool_name; ids are optional on the native wire
function ollamaViolations(body) {
  if (!body || typeof body !== 'object') return ['body is not JSON'];
  const msgs = (body.messages || []).map(m => {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) return m;
    return Object.assign({}, m, { tool_calls: m.tool_calls.map((tc, k) => Object.assign({ id: tc.id || ('native_' + k) }, tc)) });
  });
  // pair native results by position when the native message carries no id (Ollama templates key results by name)
  let batch = [];
  const paired = msgs.map(m => {
    if (m && m.role === 'assistant') { batch = (m.tool_calls || []).map(tc => tc.id); return m; }
    if (m && m.role === 'tool' && !m.tool_call_id) return Object.assign({}, m, { tool_call_id: batch.shift() });
    return m;
  });
  const out = chatShapeViolations(paired, { keys: OLLAMA_KEYS });
  for (let i = 0; i < (body.messages || []).length; i++) {
    const m = body.messages[i];
    if (m && typeof m.content !== 'string') out.push('messages.' + i + ': native content must be a string');
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) if (!tc.function || typeof tc.function.arguments !== 'object') out.push('messages.' + i + ': native tool arguments must be an object');
  }
  return out;
}

const ANTHROPIC_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const ANTHROPIC_BLOCK_KEYS = {
  text: ['type', 'text', 'cache_control', 'citations'], tool_use: ['type', 'id', 'name', 'input', 'cache_control'],
  tool_result: ['type', 'tool_use_id', 'content', 'is_error', 'cache_control'], thinking: ['type', 'thinking', 'signature'],
  redacted_thinking: ['type', 'data'], image: ['type', 'source', 'cache_control'], document: ['type', 'source', 'cache_control', 'title']
};
// the prefix a thinking signature binds: system, the tool set, every message before that assistant turn
function anthropicPrefix(body, uptoIndex) {
  return hash(JSON.stringify(stripCache({ system: body.system || null, tools: (body.tools || []).map(t => t.name), messages: (body.messages || []).slice(0, uptoIndex) })));
}
function anthropicViolations(body, state) {
  const st = state || {};
  const out = [];
  if (!body || typeof body !== 'object') return ['body is not JSON'];
  const msgs = body.messages;
  if (!Array.isArray(msgs) || !msgs.length) return ['messages: at least one message is required'];
  const drop = !!(body.thinking && body.thinking.block_binding && body.thinking.block_binding.prefix_mismatch_behavior === 'drop_block');
  const seen = new Set();
  for (let k = 0; k < msgs.length; k++) {
    const m = msgs[k];
    for (const key of Object.keys(m || {})) if (key !== 'role' && key !== 'content') out.push('messages.' + k + '.' + key + ': Extra inputs are not permitted');
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) { out.push('messages.' + k + ': Unexpected role "' + (m && m.role) + '"'); continue; }
    if (k === 0 && m.role !== 'user') out.push('messages: first message must use the "user" role');
    if (k > 0 && msgs[k - 1] && msgs[k - 1].role === m.role) out.push('messages: roles must alternate between "user" and "assistant" (index ' + k + ')');
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content == null ? '' : m.content) }];
    if (!blocks.length) out.push('messages.' + k + ': content must be non-empty');
    blocks.forEach((b, j) => {
      const allowed = ANTHROPIC_BLOCK_KEYS[b && b.type];
      if (!allowed) { out.push('messages.' + k + '.content.' + j + ': unknown block type ' + (b && b.type)); return; }
      for (const key of Object.keys(b)) if (allowed.indexOf(key) < 0) out.push('messages.' + k + '.content.' + j + '.' + key + ': Extra inputs are not permitted');
      if (b.type === 'text' && !String(b.text || '').trim()) out.push('messages.' + k + '.content.' + j + ': text content blocks must be non-empty');
    });
    if (m.role === 'user') {
      const results = blocks.filter(b => b.type === 'tool_result');
      let leadN = 0; for (const b of blocks) { if (b.type === 'tool_result') leadN++; else break; }
      if (leadN !== results.length) out.push('messages.' + k + ': tool_result blocks must come first in the user turn');
      const prev = msgs[k - 1];
      const uses = prev && prev.role === 'assistant' && Array.isArray(prev.content) ? prev.content.filter(b => b.type === 'tool_use').map(b => b.id) : [];
      for (const r of results) if (uses.indexOf(r.tool_use_id) < 0) out.push('messages.' + k + ': unexpected `tool_use_id` found in `tool_result` blocks: ' + r.tool_use_id + '. Each `tool_result` block must have a corresponding `tool_use` block in the previous message.');
    }
    if (m.role === 'assistant') {
      const uses = blocks.filter(b => b.type === 'tool_use');
      for (const u of uses) {
        if (!ANTHROPIC_ID.test(String(u.id))) out.push('messages.' + k + ': tool_use id outside ^[a-zA-Z0-9_-]{1,64}$: ' + u.id);
        if (seen.has(u.id)) out.push('messages.' + k + ': tool_use ids must be unique: ' + u.id);
        seen.add(u.id);
      }
      if (uses.length) {
        const next = msgs[k + 1];
        const answered = next && next.role === 'user' && Array.isArray(next.content) ? next.content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id) : [];
        for (const u of uses) if (answered.indexOf(u.id) < 0) out.push('messages.' + k + ': `tool_use` ids were found without `tool_result` blocks immediately after: ' + u.id);
      }
      // THINKING REPLAY (E17 / gh#73): the bytes and signature it was issued with, on the prefix it was issued on
      blocks.forEach((b, j) => {
        if (b.type !== 'thinking') return;
        const issued = st.thinking && st.thinking.get(b.signature);
        if (!issued) { out.push('messages.' + k + '.content.' + j + ': Invalid `signature` in `thinking` block'); return; }
        if (issued.thinking !== b.thinking) out.push('messages.' + k + '.content.' + j + ': thinking block was modified');
        if (st.bindsThinking && issued.prefix !== anthropicPrefix(body, k)) {
          if (drop) { st.dropped = (st.dropped || 0) + 1; return; }
          out.push('messages.' + k + '.content.' + j + ': thinking block is bound to a different conversation prefix');
        }
      });
    }
  }
  const last = msgs[msgs.length - 1];
  if (last && last.role !== 'user') out.push('This model does not support assistant message prefill. The conversation must end with a user message.');
  if (body.system != null && typeof body.system !== 'string' && !Array.isArray(body.system)) out.push('system: must be a string or text blocks');
  return out;
}

function geminiViolations(body, state) {
  const st = state || {};
  const out = [];
  if (!body || typeof body !== 'object') return ['body is not JSON'];
  const c = body.contents;
  if (!Array.isArray(c) || !c.length) return ['contents: at least one turn is required'];
  for (let k = 0; k < c.length; k++) {
    const t = c[k];
    if (!t || (t.role !== 'user' && t.role !== 'model')) { out.push('contents.' + k + ': Please use a valid role: user, model (got ' + (t && t.role) + ')'); continue; }
    if (k === 0 && t.role !== 'user') out.push('contents: the first turn must be a user turn');
    if (k > 0 && c[k - 1] && c[k - 1].role === t.role) out.push('Please ensure that multiturn requests alternate between user and model (index ' + k + ')');
    const parts = Array.isArray(t.parts) ? t.parts : [];
    if (!parts.length) out.push('contents.' + k + ': parts must not be empty');
    const calls = parts.filter(p => p.functionCall);
    if (t.role === 'model' && calls.length) {
      const next = c[k + 1];
      const lead = [];
      if (next && next.role === 'user') for (const p of next.parts || []) { if (p.functionResponse) lead.push(p.functionResponse.name); else break; }
      const want = calls.map(p => p.functionCall.name).sort();
      if (JSON.stringify(lead.slice().sort()) !== JSON.stringify(want)) out.push('contents.' + k + ': Please ensure that the number of function response parts is equal to the number of function call parts of the function call turn');
      for (const p of calls) {
        const sig = st.signatures && st.signatures.get(p.functionCall.name + ':' + JSON.stringify(p.functionCall.args || {}));
        if (sig && p.thoughtSignature !== sig) out.push('contents.' + k + ': Function call is missing a thought_signature in functionCall parts');
      }
    }
    if (parts.some(p => p.functionResponse)) {
      const prev = c[k - 1];
      if (!prev || prev.role !== 'model' || !(prev.parts || []).some(p => p.functionCall)) out.push('contents.' + k + ': a function response turn must come immediately after a function call turn');
    }
  }
  const last = c[c.length - 1];
  if (last && last.role !== 'user') out.push('contents: the request must end on a user turn');
  return out;
}

function codexViolations(body) {
  const out = [];
  if (!body || typeof body !== 'object') return ['body is not JSON'];
  if (typeof body.instructions !== 'string' || !body.instructions) out.push('instructions: required');
  const input = body.input;
  if (!Array.isArray(input) || !input.length) return out.concat(['input: at least one item is required']);
  const open = new Map();   // call_id -> index
  const answered = new Set();
  let firstMsg = true;
  for (let i = 0; i < input.length; i++) {
    const it = input[i];
    if (it && it.type === 'function_call') {
      if (!it.call_id) out.push('input.' + i + ': function_call without call_id');
      if (open.has(it.call_id) || answered.has(it.call_id)) out.push('input.' + i + ': duplicate call_id ' + it.call_id);
      open.set(it.call_id, i);
      continue;
    }
    if (it && it.type === 'function_call_output') {
      if (!open.has(it.call_id)) out.push('No tool call found for function call output with call_id ' + it.call_id + '.');
      else { open.delete(it.call_id); answered.add(it.call_id); }
      continue;
    }
    if (!it || (it.role !== 'user' && it.role !== 'assistant' && it.role !== 'developer')) { out.push('input.' + i + ': unexpected item ' + JSON.stringify(it && (it.role || it.type))); continue; }
    if (open.size) out.push('input.' + i + ': No tool output found for function call ' + Array.from(open.keys()).join(','));
    open.clear();
    if (firstMsg && it.role !== 'user') out.push('input: the first message must be a user message');
    firstMsg = false;
    if (!Array.isArray(it.content) || !it.content.length) out.push('input.' + i + ': content must be a non-empty list');
  }
  if (open.size) out.push('No tool output found for function call ' + Array.from(open.keys()).join(','));
  const last = input[input.length - 1];
  if (last && !(last.type === 'function_call_output' || last.role === 'user')) out.push('input: the request must end on a user message or a function_call_output');
  return out;
}

// claude-cli: stdin is ONE stream-json user message; each text block is a transcript entry
const ENTRY_RE = /^<(user|assistant|tool_result|system_note)\b[^>]*>\n[\s\S]*\n<\/\1>$/;
function claudeCliViolations(stdinText, systemText) {
  const out = [];
  const lines = String(stdinText || '').split('\n').filter(l => l.trim());
  if (lines.length !== 1) return ['stdin must carry exactly one stream-json message, got ' + lines.length];
  let msg;
  try { msg = JSON.parse(lines[0]); } catch (_) { return ['stdin is not JSON']; }
  if (!msg || msg.type !== 'user' || !msg.message || msg.message.role !== 'user') return ['stdin message must be a user message'];
  const blocks = Array.isArray(msg.message.content) ? msg.message.content : [];
  if (!blocks.length) return ['the user message has no blocks'];
  // the system prompt NAMES the entry tags (its transcript note); it must never CARRY an entry
  if (/(?:^|\n)<(user|assistant|tool_result|system_note)\b[^>]*>\n[\s\S]*?\n<\/\1>/.test(String(systemText || ''))) out.push('the system prompt carries transcript entries');
  const entries = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || b.type !== 'text') { if (b && b.type === 'image') continue; out.push('block ' + i + ': not a text block'); continue; }
    const t = String(b.text || '');
    // consecutive tool results share one block
    const kinds = [];
    const re = /<(user|assistant|tool_result|system_note)\b[^>]*>\n[\s\S]*?\n<\/\1>/g;
    let m, rest = t;
    while ((m = re.exec(t))) kinds.push({ kind: m[1], text: m[0] });
    rest = t.replace(re, '').trim();
    if (!kinds.length || rest) out.push('block ' + i + ': not a transcript entry');
    if (kinds.length > 1 && kinds.some(k => k.kind !== 'tool_result')) out.push('block ' + i + ': only tool results may share a block');
    entries.push({ kind: kinds.length ? kinds[0].kind : '?', parts: kinds, text: t });
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.kind === 'assistant') {
      const calls = (e.text.match(/<invoke name="/g) || []).length;
      if (calls) {
        const next = entries[i + 1];
        const results = next && next.kind === 'tool_result' ? next.parts.length : 0;
        if (results !== calls) out.push('entry ' + i + ': ' + calls + ' call(s) answered by ' + results + ' tool result(s)');
      }
    }
    // a live transcript tag inside an entry body would forge structure
    const body = e.parts.map(p => p.text.replace(/^<[^>]+>\n/, '').replace(/\n<\/[a-z_]+>$/, '')).join('');
    if (/<(user|assistant|system_note)>/.test(body)) out.push('entry ' + i + ': a live transcript tag inside an entry body');
  }
  // (no first/last-entry rule: the API sees one user message whatever the transcript inside it opens or ends on)
  return out;
}

function validate(wire, body, state) {
  switch (wire) {
    case 'chat': return chatViolations(body);
    case 'chat-claude': return chatViolations(body, { claude: true });
    case 'ollama': return ollamaViolations(body);
    case 'anthropic': return anthropicViolations(body, state);
    case 'gemini': return geminiViolations(body, state);
    case 'codex': return codexViolations(body);
    default: throw new Error('unknown wire ' + wire);
  }
}

// ---------------------------------------------------------------------------------------------- cache pieces
const flatText = c => (Array.isArray(c) && c.length && c.every(p => p && p.type === 'text' && Object.keys(p).length === 2)) ? c.map(p => p.text).join('') : c;
function piecesOf(wire, body) {
  const b = stripCache(body) || {};
  if (Array.isArray(b.messages) && wire !== 'anthropic') b.messages = b.messages.map(m => (m && Array.isArray(m.content)) ? Object.assign({}, m, { content: flatText(m.content) }) : m);
  const out = [];
  const tools = b.tools ? JSON.stringify(b.tools) : '';
  if (wire === 'anthropic') {
    out.push('tools:' + tools, 'system:' + JSON.stringify(b.system || null));
    for (const m of b.messages || []) for (const blk of (Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }])) out.push(m.role + ':' + JSON.stringify(blk));
    return out;
  }
  if (wire === 'gemini') {
    out.push('tools:' + tools, 'system:' + JSON.stringify(b.systemInstruction || null));
    for (const t of b.contents || []) for (const p of t.parts || []) out.push(t.role + ':' + JSON.stringify(p));
    return out;
  }
  if (wire === 'codex') {
    out.push('tools:' + tools, 'system:' + JSON.stringify(b.instructions || ''));
    for (const it of b.input || []) out.push(JSON.stringify(it));
    return out;
  }
  out.push('tools:' + tools);
  for (const m of b.messages || []) out.push(JSON.stringify(m));
  return out;
}
function commonPrefix(a, b) { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; }
const chars = (pieces, n) => pieces.slice(0, n).reduce((s, p) => s + p.length, 0);

// ---------------------------------------------------------------------------------------------- reply encoders
const NL = '\n';
const sseBody = events => events.map(e => 'data: ' + JSON.stringify(e)).join(NL + NL) + NL + NL;
function encodeChat(reply, usage) {
  const ev = [];
  if (reply.text) ev.push({ choices: [{ index: 0, delta: { role: 'assistant', content: reply.text } }] });
  (reply.calls || []).forEach((c, i) => ev.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }] } }] }));
  ev.push({ choices: [{ index: 0, delta: {}, finish_reason: (reply.calls || []).length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: usage.prompt, completion_tokens: 5, total_tokens: usage.prompt + 5, prompt_tokens_details: { cached_tokens: usage.cached } } });
  return { status: 200, type: 'text/event-stream', body: sseBody(ev) + 'data: [DONE]' + NL + NL };
}
function encodeOllama(reply, usage) {
  const message = { role: 'assistant', content: reply.text || '' };
  if ((reply.calls || []).length) message.tool_calls = reply.calls.map(c => ({ function: { name: c.name, arguments: c.args || {} } }));
  return { status: 200, type: 'application/x-ndjson', body: JSON.stringify({ model: 'm', message, done: true, done_reason: 'stop', prompt_eval_count: usage.prompt, eval_count: 5 }) + NL };
}
function encodeAnthropic(reply, usage, thinking) {
  const ev = [{ type: 'message_start', message: { id: 'msg_sim', role: 'assistant', usage: { input_tokens: usage.prompt - usage.cached, cache_read_input_tokens: usage.cached, cache_creation_input_tokens: 0, output_tokens: 0 } } }];
  let idx = 0;
  if (thinking) {
    ev.push({ type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '' } });
    ev.push({ type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: thinking.thinking } });
    ev.push({ type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: thinking.signature } });
    ev.push({ type: 'content_block_stop', index: idx++ });
  }
  if (reply.text) {
    ev.push({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
    ev.push({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: reply.text } });
    ev.push({ type: 'content_block_stop', index: idx++ });
  }
  for (const c of reply.calls || []) {
    ev.push({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } });
    ev.push({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.args || {}) } });
    ev.push({ type: 'content_block_stop', index: idx++ });
  }
  ev.push({ type: 'message_delta', delta: { stop_reason: (reply.calls || []).length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } });
  ev.push({ type: 'message_stop' });
  return { status: 200, type: 'text/event-stream', body: sseBody(ev) };
}
function encodeGemini(reply, usage, signatures) {
  const parts = [];
  if (reply.text) parts.push({ text: reply.text });
  for (const c of reply.calls || []) {
    const p = { functionCall: { name: c.name, args: c.args || {} } };
    const sig = 'gsig_' + hash(c.name + JSON.stringify(c.args || {}) + c.id);
    p.thoughtSignature = sig;
    if (signatures) signatures.set(c.name + ':' + JSON.stringify(c.args || {}), sig);
    parts.push(p);
  }
  return { status: 200, type: 'text/event-stream', body: sseBody([{ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: usage.prompt, candidatesTokenCount: 5, totalTokenCount: usage.prompt + 5, cachedContentTokenCount: usage.cached } }]) };
}
function encodeCodex(reply, usage) {
  const ev = [];
  if (reply.text) ev.push({ type: 'response.output_text.delta', delta: reply.text });
  (reply.calls || []).forEach((c, i) => {
    const oi = i + 1;
    const item = { type: 'function_call', call_id: c.id, name: c.name, arguments: '' };
    ev.push({ type: 'response.output_item.added', output_index: oi, item });
    ev.push({ type: 'response.function_call_arguments.delta', output_index: oi, delta: JSON.stringify(c.args || {}) });
    ev.push({ type: 'response.output_item.done', output_index: oi, item: Object.assign({}, item, { arguments: JSON.stringify(c.args || {}) }) });
  });
  ev.push({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: usage.prompt, input_tokens_details: { cached_tokens: usage.cached }, output_tokens: 5, total_tokens: usage.prompt + 5 } } });
  return { status: 200, type: 'text/event-stream', body: sseBody(ev) };
}
function claudeCliLines(reply, usage) {
  let text = reply.text || '';
  if ((reply.calls || []).length) {
    text += (text ? '\n' : '') + '<function_calls>\n' + reply.calls.map(c => '<invoke name="' + c.name + '">\n'
      + Object.keys(c.args || {}).map(k => '<parameter name="' + k + '">' + c.args[k] + '</parameter>\n').join('') + '</invoke>').join('\n') + '\n</function_calls>';
  }
  const lines = [{ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] }];
  if (text) lines.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  lines.push({ type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn', total_cost_usd: 0,
    usage: { input_tokens: usage.prompt - usage.cached, cache_read_input_tokens: usage.cached, cache_creation_input_tokens: 0, output_tokens: 5 } });
  return lines;
}

function refusal(wire, status, message) {
  const s = status || 400;
  if (wire === 'anthropic') return { status: s, type: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }) };
  if (wire === 'gemini') return { status: s, type: 'application/json', body: JSON.stringify({ error: { code: s, message, status: 'INVALID_ARGUMENT' } }) };
  if (wire === 'ollama') return { status: s, type: 'application/json', body: JSON.stringify({ error: message }) };
  return { status: s, type: 'application/json', body: JSON.stringify({ error: { message, type: 'invalid_request_error', code: s } }) };
}

// ---------------------------------------------------------------------------------------------- the simulator
function viewOf(wire, body) {
  // the last turn's role and how many tool results the request ends on, in neutral terms (the script's input)
  let lastRole = '', toolResults = 0;
  if (wire === 'anthropic') {
    const last = (body.messages || []).slice(-1)[0] || {};
    lastRole = last.role; toolResults = Array.isArray(last.content) ? last.content.filter(b => b.type === 'tool_result').length : 0;
  } else if (wire === 'gemini') {
    const last = (body.contents || []).slice(-1)[0] || {};
    lastRole = last.role; toolResults = (last.parts || []).filter(p => p.functionResponse).length;
  } else if (wire === 'codex') {
    const items = body.input || [];
    lastRole = (items[items.length - 1] || {}).role || (items[items.length - 1] || {}).type;
    for (let i = items.length - 1; i >= 0 && items[i].type === 'function_call_output'; i--) toolResults++;
  } else {
    const msgs = body.messages || [];
    lastRole = (msgs[msgs.length - 1] || {}).role;
    for (let i = msgs.length - 1; i >= 0 && msgs[i].role === 'tool'; i--) toolResults++;
  }
  return { lastRole, toolResults };
}

function makeStrictUpstream(wire, opts) {
  const o = opts || {};
  const requests = [], refusals = [];
  const state = { thinking: new Map(), signatures: new Map(), dropped: 0, bindsThinking: !!o.bindsThinking };
  let run = { n: 0, prev: null };
  let callSeq = 0;
  const reply = typeof o.reply === 'function' ? o.reply : (() => ({ text: 'OK' }));
  function answer(body, extra) {
    const violations = extra && extra.violations ? extra.violations : validate(wire, body, state);
    const pieces = piecesOf(wire, body);
    const prevPieces = run.prev;
    const common = prevPieces ? commonPrefix(prevPieces, pieces) : 0;
    const rec = { body, violations, pieces, prevPieces, common, n: run.n + 1 };
    requests.push(rec);
    if (violations.length) {
      refusals.push(rec);
      return refusal(wire, o.refusalStatus, (o.refusalPrefix || '') + violations[0]);
    }
    run.n++;
    run.prev = pieces;
    const usage = { prompt: Math.max(1, Math.ceil(chars(pieces, pieces.length) / 4)), cached: Math.floor(chars(pieces, common) / 4) };
    rec.usage = usage;
    const r = Object.assign({}, reply(run.n, viewOf(wire, body), rec));
    r.calls = (r.calls || []).map(c => Object.assign({ id: (wire === 'anthropic' ? 'toolu_sim_' : 'call_sim_') + (++callSeq) }, c));
    rec.reply = r;
    if (wire === 'chat' || wire === 'chat-claude') return encodeChat(r, usage);
    if (wire === 'ollama') return encodeOllama(r, usage);
    if (wire === 'anthropic') {
      const on = body.thinking && body.thinking.type && body.thinking.type !== 'disabled';
      let thinking = null;
      if (on) {
        thinking = { thinking: 'sim reasoning for turn ' + run.n, signature: 'sig_' + hash('t' + run.n + ':' + callSeq + ':' + requests.length), prefix: anthropicPrefix(body, (body.messages || []).length) };
        state.thinking.set(thinking.signature, thinking);
      }
      return encodeAnthropic(r, usage, thinking);
    }
    if (wire === 'gemini') return encodeGemini(r, usage, state.signatures);
    if (wire === 'codex') return encodeCodex(r, usage);
    throw new Error('no encoder for ' + wire);
  }
  const toResponse = a => new Response(a.body, { status: a.status, headers: { 'Content-Type': a.type } });
  async function fetch(url, init) {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (wire === 'ollama') {
      if (/\/api\/show$/.test(u)) return new Response(JSON.stringify({ model_info: { 'qwen3.context_length': 65536 }, capabilities: ['completion', 'tools'] }));
      if (/\/api\/ps$/.test(u)) return new Response('{"models":[]}');
      if (/\/api\/version$/.test(u)) return new Response('{"version":"0.12.0"}');
    }
    if (method !== 'POST') return new Response(wire === 'gemini' ? '{"models":[]}' : '{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    let body = null;
    try { body = JSON.parse(String(init.body)); } catch (_) { return toResponse(refusal(wire, 400, 'body is not JSON')); }
    if (wire === 'ollama' && !/\/api\/chat$/.test(u)) return toResponse(refusal(wire, 404, 'the simulator speaks the native /api/chat wire only'));
    return toResponse(answer(body));
  }
  // claude-cli: a fake child process that reads the stream-json stdin and answers in stream-json
  const written = new Map();
  const fakeFs = { statSync() { return { isFile: () => true }; }, writeFileSync(p, text) { written.set(String(p), String(text)); }, unlinkSync() {} };
  function spawn(file, args) {
    const { EventEmitter } = require('events');
    const child = new EventEmitter();
    const stream = () => { const s = new EventEmitter(); s.setEncoding = () => {}; return s; };
    child.stdout = stream(); child.stderr = stream(); child.pid = 5151; child.exitCode = null;
    const exit = code => { if (child.exitCode != null) return; child.exitCode = code; child.emit('exit', code); child.emit('close', code); };
    child.kill = () => exit(null);
    let stdin = '';
    child.stdin = { on() {}, write(t) { stdin += t || ''; return true; }, end(t) { stdin += t || ''; setImmediate(go); } };
    function go() {
      if (args.indexOf('auth') >= 0) { child.stdout.emit('data', JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) + '\n'); return exit(0); }
      const sysAt = args.indexOf('--system-prompt-file');
      const system = sysAt >= 0 ? (written.get(String(args[sysAt + 1])) || '') : '';
      const violations = claudeCliViolations(stdin, system);
      const lines = String(stdin).split('\n').filter(l => l.trim());
      let blocks = [];
      try { blocks = JSON.parse(lines[0]).message.content || []; } catch (_) {}
      const pieces = ['system:' + system].concat(blocks.map(b => JSON.stringify(b)));
      const prevPieces = run.prev;
      const common = prevPieces ? commonPrefix(prevPieces, pieces) : 0;
      const rec = { body: { stdin, system }, violations, pieces, prevPieces, common, n: run.n + 1 };
      requests.push(rec);
      if (violations.length) { refusals.push(rec); child.stderr.emit('data', 'API Error: 400 ' + violations[0]); return exit(1); }
      run.n++; run.prev = pieces;
      const usage = { prompt: Math.max(1, Math.ceil(chars(pieces, pieces.length) / 4)), cached: Math.floor(chars(pieces, common) / 4) };
      rec.usage = usage;
      const lastEntry = blocks.length ? String(blocks[blocks.length - 1].text || '') : '';
      const view = { lastRole: /^<tool_result/.test(lastEntry) ? 'tool' : (/^<system_note/.test(lastEntry) ? 'system' : 'user'), toolResults: (lastEntry.match(/<tool_result /g) || []).length };
      const r = Object.assign({}, reply(run.n, view, rec));
      rec.reply = r;
      for (const l of claudeCliLines(r, usage)) child.stdout.emit('data', JSON.stringify(l) + '\n');
      exit(0);
    }
    if (args.indexOf('auth') >= 0) setImmediate(go);
    return child;
  }
  function reset() { run = { n: 0, prev: null }; }
  return { wire, fetch, spawn, fs: fakeFs, requests, refusals, state, reset, answer };
}

// ---------------------------------------------------------------------------------------------- over HTTP
/* The same simulators behind a real server, for a sidecar e2e. `wires` maps a path family to a wire: { chat: true,
   ollama: true }. Each run is told apart by `runKey(body)` (default: one stream for the whole server), so the cache
   measure compares a request with the previous one of the same run. `jinja500: true` answers a violation the way
   Ollama's /v1 does (#102): HTTP 500 with the template's exception text. */
function startStrictHttp(opts) {
  const o = opts || {};
  const sims = new Map();   // runKey|wire -> simulator
  const all = [];
  const simFor = (wire, key) => {
    const k = wire + '|' + key;
    if (!sims.has(k)) sims.set(k, makeStrictUpstream(wire, { reply: (n, view, rec) => o.reply(n, view, rec, key, wire), refusalStatus: o.jinja500 ? 500 : 400, refusalPrefix: o.jinja500 ? 'Jinja Exception: ' : '' }));
    return sims.get(k);
  };
  const server = http.createServer(async (req, res) => {
    let raw = ''; req.setEncoding('utf8'); for await (const c of req) raw += c;
    const url = req.url || '';
    const send = (status, type, body) => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
    if (/\/api\/show$/.test(url)) return send(200, 'application/json', JSON.stringify({ model_info: { 'qwen3.context_length': 65536 }, capabilities: ['completion', 'tools'] }));
    if (/\/api\/ps$/.test(url)) return send(200, 'application/json', '{"models":[]}');
    if (/\/api\/version$/.test(url)) return send(200, 'application/json', '{"version":"0.12.0"}');
    if (/\/api\/tags$/.test(url)) return send(200, 'application/json', JSON.stringify({ models: [{ name: o.model || 'strict-model', model: o.model || 'strict-model' }] }));
    if (req.method !== 'POST') return send(200, 'application/json', JSON.stringify({ data: [{ id: o.model || 'strict-model', context_length: 65536 }] }));
    let body = null;
    try { body = JSON.parse(raw); } catch (_) { return send(400, 'application/json', '{"error":{"message":"body is not JSON"}}'); }
    const wire = /\/api\/chat$/.test(url) ? 'ollama' : 'chat';
    const key = typeof o.runKey === 'function' ? o.runKey(body, wire) : 'all';
    if (key == null) {   // not a request this test scripts (an auxiliary call): a plain, accepted answer
      const a = wire === 'ollama' ? encodeOllama({ text: 'OK' }, { prompt: 1, cached: 0 }) : encodeChat({ text: 'OK' }, { prompt: 1, cached: 0 });
      return send(a.status, a.type, a.body);
    }
    const sim = simFor(wire, key);
    const a = sim.answer(body);
    all.push({ wire, key, rec: sim.requests[sim.requests.length - 1] });
    send(a.status, a.type, a.body);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({
    server, all, sims, port: server.address().port, base: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise(c => server.close(c))
  })));
}

module.exports = { validate, chatShapeViolations, chatViolations, ollamaViolations, anthropicViolations, geminiViolations, codexViolations,
  claudeCliViolations, piecesOf, commonPrefix, makeStrictUpstream, startStrictHttp, textOf };
