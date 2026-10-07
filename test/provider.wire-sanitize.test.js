/* node test/provider.wire-sanitize.test.js — ONE pre-send transcript normalization for every adapter
   (providers/provider.js prepareWireMessages; Hermes audit Step 2, 2026-09-22).

   Audit probes this pins (29bb21d80): (1) after a run ended 'error' at the tool boundary, the unpaired call rode
   mid-history into the NATIVE Anthropic body as a tool_use with no tool_result, and into the Gemini body as a
   functionCall followed by user text — only the two Chat Completions adapters repaired pairs; (2) Kimi-style call
   ids (`functions.read_file:0`) reached Anthropic unchanged after a fallback, though its grammar is
   ^[a-zA-Z0-9_-]+$ (<= 64). Also: a legacy batch that reused one id, and a real result stranded after an
   intervening message, must pair — never be relabelled "[interrupted — ... Reissue it]" (a repeat invitation for a
   write that already happened). The caller's messages are never mutated.

   Wire-level only: an injected fetch records the request bodies; no network, no sidecar. Live provider acceptance
   of these bodies is NOT exercised here. */
'use strict';
const A = require('./_assert.js');
const provider = require('../sidecar/providers/provider.js');
const { makeAnthropicProvider } = require('../sidecar/providers/anthropic.js');
const { makeGeminiProvider } = require('../sidecar/providers/gemini.js');
const { makeCodexProvider } = require('../sidecar/providers/codex.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');

const ANTHROPIC_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const sse = lines => new Response(lines.join('\n') + '\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args || {}) } });

async function anthropicBody(messages) {
  let body = null;
  const p = makeAnthropicProvider({ key: 'k', fetch: async (url, init) => {
    if (!init || !init.body) return new Response('{"data":[]}', { status: 200 });
    body = JSON.parse(init.body);
    return sse(['data: ' + JSON.stringify({ type: 'message_stop' })]);
  } });
  for await (const _ of p.stream({ model: 'claude-test', messages })) { /* drain */ }
  return body;
}
async function geminiBody(messages) {
  let body = null;
  const p = makeGeminiProvider({ key: 'k', fetch: async (url, init) => {
    if (!init || !init.body) return new Response('{"models":[]}', { status: 200 });
    body = JSON.parse(init.body);
    return sse(['data: ' + JSON.stringify({ candidates: [{ finishReason: 'STOP' }] })]);
  } });
  for await (const _ of p.stream({ model: 'gemini-test', messages })) { /* drain */ }
  return body;
}
async function codexBody(messages) {
  let body = null;
  const p = makeCodexProvider({ token: 't', fetch: async (url, init) => {
    body = JSON.parse(init.body);
    return sse(['data: ' + JSON.stringify({ type: 'response.completed', response: {} })]);
  } });
  for await (const _ of p.stream({ model: 'gpt-5.5', messages })) { /* drain */ }
  return body;
}
async function chatBody(messages) {
  let body = null;
  const p = makeOpenAICompatibleProvider({ key: 'k', baseUrl: 'https://compat.test/v1', fetch: async (url, init) => {
    if (!init || !init.body) return new Response('{"data":[]}', { status: 200 });
    body = JSON.parse(init.body);
    return sse(['data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]']);
  } });
  for await (const _ of p.stream({ model: 'm', messages })) { /* drain */ }
  return body;
}

/* Anthropic's pairing law: every assistant tool_use is answered by a tool_result in the IMMEDIATELY following user
   turn, results lead that turn's content, every result answers the preceding turn, ids match the grammar and are
   unique across the request. Returns the list of violations (empty = a body the wire accepts on these rules). */
function anthropicViolations(body) {
  const msgs = body.messages;
  const out = [];
  const seen = new Set();
  for (let k = 0; k < msgs.length; k++) {
    const m = msgs[k];
    const uses = m.role === 'assistant' ? m.content.filter(b => b.type === 'tool_use').map(b => b.id) : [];
    for (const id of uses) {
      if (!ANTHROPIC_ID.test(id)) out.push('tool_use id outside the grammar: ' + id);
      if (seen.has(id)) out.push('tool_use id reused in one request: ' + id);
      seen.add(id);
    }
    if (m.role === 'user') {
      const results = m.content.filter(b => b.type === 'tool_result');
      const lead = [];
      for (const b of m.content) { if (b.type === 'tool_result') lead.push(b); else break; }
      if (lead.length !== results.length) out.push('turn ' + k + ': a tool_result follows text');
      const prev = msgs[k - 1];
      const prevUses = prev && prev.role === 'assistant' ? prev.content.filter(b => b.type === 'tool_use').map(b => b.id) : [];
      for (const r of results) if (prevUses.indexOf(r.tool_use_id) < 0) out.push('turn ' + k + ': tool_result ' + r.tool_use_id + ' answers no tool_use in the previous turn');
    }
    if (uses.length) {
      const next = msgs[k + 1];
      const answered = next && next.role === 'user' ? next.content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id) : [];
      for (const id of uses) if (answered.indexOf(id) < 0) out.push('turn ' + k + ': tool_use ' + id + ' has no tool_result in the next turn');
    }
  }
  return out;
}
/* Gemini's: a model turn with N functionCall parts is followed by a user turn that LEADS with N functionResponse
   parts naming the same functions; every functionResponse follows such a model turn. */
function geminiViolations(body) {
  const c = body.contents;
  const out = [];
  for (let k = 0; k < c.length; k++) {
    const calls = (c[k].parts || []).filter(p => p.functionCall).map(p => p.functionCall.name);
    const responses = (c[k].parts || []).filter(p => p.functionResponse).map(p => p.functionResponse.name);
    if (c[k].role === 'model' && calls.length) {
      const next = c[k + 1];
      const lead = [];
      if (next && next.role === 'user') for (const p of next.parts) { if (p.functionResponse) lead.push(p.functionResponse.name); else break; }
      if (JSON.stringify(lead.slice().sort()) !== JSON.stringify(calls.slice().sort())) out.push('turn ' + k + ': functionCall ' + JSON.stringify(calls) + ' answered by ' + JSON.stringify(lead));
    }
    if (responses.length) {
      const prev = c[k - 1];
      const prevCalls = prev && prev.role === 'model' ? (prev.parts || []).filter(p => p.functionCall).length : 0;
      if (prevCalls < responses.length) out.push('turn ' + k + ': functionResponse without a preceding functionCall turn');
    }
  }
  return out;
}
const text = v => JSON.stringify(v);

(async () => {
  // ---- 1. THE AUDIT PROBE: a run ended 'error' at the tool boundary; two runs later the call is mid-history ----
  {
    const history = [
      { role: 'system', content: 'You are a station agent.' },
      { role: 'user', content: 'task one: read the config' },
      { role: 'assistant', content: '', tool_calls: [call('call_X', 'fs_read', { path: 'config.json' })] },
      // (the run ended 'error' here — no result was ever persisted)
      { role: 'user', content: 'task two' },
      { role: 'assistant', content: 'done two' },
      { role: 'user', content: 'task three' }
    ];
    const snapshot = text(history);
    const anth = await anthropicBody(history);
    A.eq(anthropicViolations(anth), [], 'Anthropic body: the mid-history tool_use is answered in the very next turn');
    const stub = anth.messages[2].content[0];
    A.eq([stub.type, stub.tool_use_id], ['tool_result', 'call_X'], 'Anthropic: the answer is a tool_result for call_X leading the next user turn');
    A.ok(/no recorded result/.test(stub.content), 'Anthropic: the stub says truthfully that no result was recorded');
    A.eq(anth.messages[2].content[1].text, 'task two', 'Anthropic: the following user text keeps its place after the stub');

    const gem = await geminiBody(history);
    A.eq(geminiViolations(gem), [], 'Gemini body: the mid-history functionCall is answered by a functionResponse before any user text');
    A.eq(Object.keys(gem.contents[2].parts[0]), ['functionResponse'], 'Gemini: the user turn after the call LEADS with its functionResponse');
    A.eq(gem.contents[2].parts[0].functionResponse.name, 'fs_read', 'Gemini: the stub names the function it answers');

    const codex = await codexBody(history);
    const ci = codex.input.findIndex(it => it.type === 'function_call' && it.call_id === 'call_X');
    A.eq(codex.input[ci + 1] && codex.input[ci + 1].type, 'function_call_output', 'Codex (Responses) wire still pairs the call in place');
    A.eq(text(history), snapshot, 'the caller\'s transcript is not mutated by any adapter');
  }

  // ---- 2. KIMI IDS AFTER A FALLBACK (and Gemini's per-turn call_0) reach Anthropic in its grammar ----
  {
    const longId = 'tool.' + 'x'.repeat(80) + ':9';
    const history = [
      { role: 'user', content: 'read everything' },
      { role: 'assistant', content: '', tool_calls: [call('functions.read_file:0', 'read_file', { path: 'a' }), call('functions.read_file:1', 'read_file', { path: 'b' })] },
      { role: 'tool', tool_call_id: 'functions.read_file:0', content: 'A' },
      { role: 'tool', tool_call_id: 'functions.read_file:1', content: 'B' },
      // a VALID id equal to what the first Kimi id sanitizes to — it must keep its bytes, the rewrite must dodge it
      { role: 'assistant', content: '', tool_calls: [call('functions_read_file_0', 'read_file', { path: 'c' })] },
      { role: 'tool', tool_call_id: 'functions_read_file_0', content: 'C' },
      // Gemini mints call_0 every turn
      { role: 'assistant', content: '', tool_calls: [call('call_0', 'read_file', { path: 'd' })] },
      { role: 'tool', tool_call_id: 'call_0', content: 'D' },
      { role: 'assistant', content: '', tool_calls: [call('call_0', 'read_file', { path: 'e' })] },
      { role: 'tool', tool_call_id: 'call_0', content: 'E' },
      { role: 'assistant', content: '', tool_calls: [call(longId, 'read_file', { path: 'f' })] },
      { role: 'tool', tool_call_id: longId, content: 'F' },
      { role: 'user', content: 'now summarize' }
    ];
    const snapshot = text(history);
    const anth = await anthropicBody(history);
    A.eq(anthropicViolations(anth), [], 'every id is in the grammar, unique across the request, and paired');
    const uses = [];
    for (const m of anth.messages) for (const b of m.content) if (b.type === 'tool_use') uses.push(b);
    A.eq(uses.map(u => u.id).slice(0, 3), ['functions_read_file_0_2', 'functions_read_file_1', 'functions_read_file_0'],
      'Kimi ids are rewritten deterministically; the already-valid id keeps its bytes and the rewrite takes a suffix instead');
    A.eq(uses[3].id, 'call_0', 'the first call_0 keeps its bytes');
    A.eq(uses[4].id, 'call_0_2', 'a call_0 reused by a later turn gets a unique id');
    A.ok(uses[5].id.length <= 64 && ANTHROPIC_ID.test(uses[5].id), 'an over-long foreign id is clipped into the grammar');
    // each result still answers ITS call: map the call's path to the result's content
    const byId = new Map(uses.map(u => [u.id, u.input.path]));
    const pairs = [];
    for (const m of anth.messages) for (const b of m.content) if (b.type === 'tool_result') pairs.push(byId.get(b.tool_use_id) + '=' + b.content);
    A.eq(pairs, ['a=A', 'b=B', 'c=C', 'd=D', 'e=E', 'f=F'], 'call and result are rewritten with the SAME mapping — every result still answers its own call');
    A.eq(text(await anthropicBody(history)), text(anth), 'the mapping is deterministic (same transcript, same body)');
    A.eq(text(history), snapshot, 'the caller\'s transcript is not mutated');
  }

  // ---- 3. A legacy batch that REUSED one id: both calls have real results; neither is called "interrupted" ----
  {
    const history = [
      { role: 'user', content: 'write both' },
      { role: 'assistant', content: '', tool_calls: [call('dup', 'fs_write', { path: 'a.txt' }), call('dup', 'fs_write', { path: 'b.txt' })] },
      { role: 'tool', tool_call_id: 'dup', content: 'wrote a.txt' },
      { role: 'tool', tool_call_id: 'dup', content: 'wrote b.txt' },
      { role: 'user', content: 'next' }
    ];
    const chat = provider.prepareWireMessages(history, 'chat');
    A.eq(chat[1].tool_calls.map(tc => tc.id), ['dup', 'call_local_1'], 'the reused id is minted unique (as before)');
    A.eq(chat.slice(2, 4).map(m => [m.tool_call_id, m.content]), [['dup', 'wrote a.txt'], ['call_local_1', 'wrote b.txt']],
      'the second REAL result pairs with the minted id instead of being downgraded');
    A.ok(!/interrupted|recovered tool result/.test(text(chat)), 'no real result is relabelled "interrupted — reissue it" or "recovered"');
    const anth = await anthropicBody(history);
    A.eq(anthropicViolations(anth), [], 'the Anthropic body pairs both');
    A.ok(!/interrupted/.test(text(anth)), 'the Anthropic body invites no repeat of a write that happened');
  }

  // ---- 4. A real result stranded AFTER an intervening message is hoisted beside its call ----
  {
    const history = [
      { role: 'user', content: 'look it up' },
      { role: 'assistant', content: '', tool_calls: [call('late', 'fs_read', { path: 'x' })] },
      { role: 'system', content: '<steering_note>also check y</steering_note>' },
      { role: 'tool', tool_call_id: 'late', content: 'contents of x' },
      { role: 'user', content: 'go on' }
    ];
    const snapshot = text(history);
    const chat = provider.prepareWireMessages(history, 'chat');
    A.eq(chat.map(m => m.role), ['user', 'assistant', 'tool', 'system', 'user'], 'the stranded result moves up beside its call; the note follows it');
    A.eq(chat[2], history[3], 'the hoisted result is the real one, unchanged');
    A.ok(!/interrupted|recovered tool result/.test(text(chat)), 'no stub and no downgrade for a call that has a real result');
    A.eq(anthropicViolations(await anthropicBody(history)), [], 'the Anthropic body pairs it');
    A.eq(geminiViolations(await geminiBody(history)), [], 'the Gemini body pairs it');
    // the lookahead never crosses the next assistant turn: a later result with the same id belongs to a later call
    const crossed = provider.prepareWireMessages([
      { role: 'assistant', content: '', tool_calls: [call('call_0', 'fs_read', {})] },
      { role: 'user', content: 'stop' },
      { role: 'assistant', content: '', tool_calls: [call('call_0', 'fs_read', {})] },
      { role: 'tool', tool_call_id: 'call_0', content: 'second call result' }
    ], 'chat');
    A.eq(crossed.map(m => m.role), ['assistant', 'tool', 'user', 'assistant', 'tool'], 'a result past the next assistant turn is not hoisted');
    A.ok(/no recorded result/.test(crossed[1].content), 'the first call (truly unanswered) gets the stub');
    A.eq(crossed[4].content, 'second call result', 'the later result stays with its own (later) call');
    A.eq(text(history), snapshot, 'the caller\'s transcript is not mutated');
  }

  // ---- 5. Well-formed transcripts are untouched: identity, so every wire's bytes are unchanged ----
  {
    const healthy = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: '', tool_calls: [call('toolu_01A', 'web', { q: 1 }), call('call_2', 'web', { q: 2 })] },
      { role: 'tool', tool_call_id: 'call_2', content: 'two' },
      { role: 'tool', tool_call_id: 'toolu_01A', content: 'one' },
      { role: 'assistant', content: 'done' }
    ];
    for (const target of ['chat', 'codex', 'gemini', 'anthropic']) {
      A.ok(provider.prepareWireMessages(healthy, target) === healthy, target + ': a well-formed transcript returns by identity');
    }
    const chat = await chatBody(healthy);
    A.eq(chat.messages, healthy, 'the Chat Completions body carries the healthy transcript byte-for-byte');
    A.ok(provider.prepareWireMessages(undefined, 'chat') === undefined, 'a missing transcript passes through as it came');
  }

  // ---- 6. StarNet bookkeeping keys never reach a Chat Completions body (user report 2026-10-05: Mistral 422
  //      extra_forbidden on messages[1].user.streamId / agentId / ts — every run, even a new chat's first message) ----
  {
    const comms = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'hello', ts: 1, streamId: 'ws-1', agentId: 'agent', attachments: [] },
      { role: 'assistant', content: '', ts: 2, sourceRunId: 'r1', reasoning: [{ type: 'reasoning_content', text: 'x' }], tool_calls: [call('call_1', 'web', { q: 1 })] },
      { role: 'tool', tool_call_id: 'call_1', content: 'one', ts: 3 },
      { role: 'assistant', content: '⚠ failed', error: true, stopped: true, agentId: 'a2', ts: 4 },
      { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }], ts: 5, streamId: 'ws-1' }
    ];
    const snapshot = text(comms);
    const body = await chatBody(comms);
    const allowed = provider.CHAT_WIRE_KEYS;
    const leaked = [];
    body.messages.forEach((m, i) => { for (const k of Object.keys(m)) if (!allowed.has(k)) leaked.push(i + '.' + k); });
    A.eq(leaked, [], 'no non-wire key rides a Chat Completions message');
    A.eq(body.messages.map(m => m.role), ['system', 'user', 'assistant', 'tool', 'assistant', 'user'], 'every turn still rides, in order');
    A.eq(body.messages[2].tool_calls, comms[2].tool_calls, 'tool_calls ride verbatim');
    A.eq(body.messages[3].tool_call_id, 'call_1', 'a tool result keeps its call id');
    A.eq(body.messages[5].content, comms[5].content, 'content parts ride verbatim');
    A.eq(text(comms), snapshot, "the caller's transcript is not mutated");
    const clean = [{ role: 'user', content: 'u' }];
    A.ok(provider.chatWireMessages(clean) === clean, 'a clean transcript returns by identity');
  }

  A.report('provider.wire-sanitize.test');
})().catch(e => { console.log('FAIL: provider.wire-sanitize.test threw -- ' + (e && e.stack || e)); process.exit(1); });
