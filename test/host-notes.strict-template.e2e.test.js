/* node test/host-notes.strict-template.e2e.test.js — A STRICT CHAT TEMPLATE ACCEPTS THE HOST NOTES (lean-prompt review 2026-10-12).

   SCOPE (review 2026-10-12): this proves the host NOTES (<run_context>, <recalled-memory>, <conversation_summary>) no
   longer trip a strict template. It drives no tool turns and no loop nudges. The whole run — tool turns and the loop's
   own mid-run host messages, which provider.js projectRoles now carries user-side (2026-10-27) — is proved by
   test/host-notes.strict-template.whole-run.e2e.test.js.

   The lean-prompt lane put the per-run <run_context> note on EVERY message as a system message right before the newest
   user turn. On a generic Chat Completions endpoint (provider 'custom' and its local/lmstudio/vllm/llama.cpp aliases,
   hosted openai-compatible profiles, OpenRouter non-Claude) a strict chat template refuses any system message that is
   not at index 0 (#102: "System message must be at the beginning") and role-order validators refuse a system message
   after an assistant or tool turn — so every run failed, not only long ones. This drives the REAL request assembly of a
   hermetic sidecar (non-internal COMMS runs on provider 'custom') against a mock that answers 400 exactly like such a
   template, and asserts: message 1, message 2 (with history) and a long chat whose window dropped its first turns
   (the earlier-conversation note) all succeed; each request has ONE system message, at index 0, byte-identical across
   the conversation; and the host notes ride as the fenced leading text of the newest user message. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const MARK = 'STRICT_TEMPLATE_PROBE';
const RULE = 'From now on, never use tables in anything you write for me - bullet lists only.';
const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (p && p.text) || '').join('') : '');
const lastUserIdx = msgs => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') return i; return -1; };

// the template rule, verbatim from the failure class: one system message, at the beginning; none after assistant/tool
function templateError(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'system') continue;
    if (i > 0) return 'System message must be at the beginning (system at index ' + i + (messages[i - 1] && /^(assistant|tool)$/.test(messages[i - 1].role) ? ', after ' + messages[i - 1].role : '') + ')';
  }
  return '';
}

function startUpstream() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; req.setEncoding('utf8'); for await (const c of req) raw += c;
    if (!raw) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [] })); }
    const body = JSON.parse(raw);
    const msgs = body.messages || [];
    const main = msgs.some(m => m.role === 'system' && text(m.content).indexOf(MARK) >= 0);
    const refusal = templateError(msgs);
    if (main) seen.push({ body, refusal });
    if (refusal) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: refusal, type: 'invalid_request_error' } }));
    }
    const ask = text((msgs[lastUserIdx(msgs)] || {}).content);
    const reply = 'Handled ' + ((/(Request \d+)/.exec(ask) || [])[1] || 'it') + '.';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\n');
    res.write('data: [DONE]\n\n'); res.end();
  });
  return new Promise(r => server.listen(0, HOST, () => r({ server, seen, base: 'http://' + HOST + ':' + server.address().port + '/v1' })));
}

function hermeticEnv() {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  return Object.assign(env, { SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0',
    SKYNET_THREAD_MINE: '0', SKYNET_REFLECT: '0', STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_BUILD_DESCRIBE: 'v0.13.4-strict-template' });
}

async function send(fixture, up, stream, history, ask) {
  const from = up.seen.length;
  const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    provider: 'custom', baseUrl: up.base, key: 'fixture-key', model: 'fixture-model', agentId: 'agent', isTask: true, streamId: stream,
    system: MARK + ': you are the lead.', messages: history.concat([{ role: 'user', content: ask }]) }) });
  A.eq(r.status, 200, 'run accepted: ' + ask.slice(0, 30));
  const events = (await r.text()).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const end = events.filter(e => e.name === 'agent.run.end').pop();
  const reply = events.filter(e => e.name === 'agent.token').map(e => e.payload.delta).join('');
  return { end: end && end.payload, reply, calls: up.seen.slice(from) };
}

function checkCall(call, label) {
  const msgs = call.body.messages;
  A.eq(call.refusal, '', label + ': the strict template accepts the request');
  A.eq(msgs.filter(m => m.role === 'system').length, 1, label + ': exactly ONE system message');
  A.eq(msgs[0].role, 'system', label + ': at index 0');
  const li = lastUserIdx(msgs);
  A.eq(li, msgs.length - 1, label + ': the request ends on the user turn');
  const newest = text(msgs[li].content);
  A.ok(/^<(run_context|conversation_summary)>/.test(newest), label + ': a host note opens the newest user turn');
  A.ok(/<run_context>[\s\S]*Run id: \S+[\s\S]*<\/run_context>/.test(newest), label + ': the run context rides the newest user turn, fenced');
  for (let i = 1; i < msgs.length; i++) if (msgs[i].role === msgs[i - 1].role && msgs[i].role !== 'tool') { A.ok(false, label + ': alternation broken at ' + i + ' (' + msgs[i].role + ')'); break; }
  return newest;
}

(async () => {
  const up = await startUpstream();
  const fixture = SidecarFixture.create({ prefix: 'starnet-strict-template-', timeoutMs: 30000, env: hermeticEnv() });
  try {
    await fixture.start();
    // ---- messages 1 and 2 of one conversation ----
    const S = 'strict-convo';
    const r1 = await send(fixture, up, S, [], 'Request 1: tell me a joke');
    A.eq(r1.end && r1.end.reason, 'done', 'message 1 completes on a strict template');
    const h2 = [{ role: 'user', content: 'Request 1: tell me a joke' }, { role: 'assistant', content: r1.reply }];
    const r2 = await send(fixture, up, S, h2, 'Request 2: tell me another joke');
    A.eq(r2.end && r2.end.reason, 'done', 'message 2 completes on a strict template');
    A.ok(r1.calls.length >= 1 && r2.calls.length >= 1, 'both messages reached the model');
    const n1 = checkCall(r1.calls[0], 'message 1'), n2 = checkCall(r2.calls[0], 'message 2');
    A.eq(JSON.stringify(r2.calls[0].body.messages[0]), JSON.stringify(r1.calls[0].body.messages[0]), 'system[0] is byte-identical across the two messages');
    A.ok(/Request 1: tell me a joke$/.test(n1) && /Request 2: tell me another joke$/.test(n2), 'the Commander\'s words close their own turn, unchanged');
    A.eq(text(r2.calls[0].body.messages[1].content), 'Request 1: tell me a joke', 'history replays right after the system prompt, without any note');

    // ---- a long chat whose window dropped its first turns: the earlier-conversation note ----
    const L = 'strict-long-chat';
    const history = [];
    const asks = [RULE].concat([2, 3, 4, 5, 6].map(k => 'Request ' + k + ': draft section ' + k + ' of the report.'));
    for (const ask of asks) {
      const out = await send(fixture, up, L, history.slice(), ask);
      A.eq(out.end && out.end.reason, 'done', 'long chat turn completes: ' + ask.slice(0, 20));
      history.push({ role: 'user', content: ask }, { role: 'assistant', content: out.reply });
    }
    const windowed = history.slice(-4);
    A.ok(!JSON.stringify(windowed).includes(RULE), 'fixture: the window no longer holds the turn-1 instruction');
    const late = await send(fixture, up, L, windowed, 'Request 7: write the summary section.');
    A.eq(late.end && late.end.reason, 'done', 'the windowed message completes on a strict template');
    const nl = checkCall(late.calls[0], 'windowed long chat');
    A.ok(nl.indexOf('<conversation_summary>') === 0, 'the earlier-conversation note opens the newest user turn');
    A.ok(nl.indexOf(RULE) > 0 && nl.indexOf(RULE) < nl.indexOf('</conversation_summary>'), 'the dropped turn-1 instruction rides it verbatim');
    A.eq(JSON.stringify(late.calls[0].body.messages[0]), JSON.stringify(r1.calls[0].body.messages[0]), 'the system prompt is still the same bytes');
    A.eq(up.seen.filter(c => c.refusal).length, 0, 'the strict template refused no request at all (' + up.seen.length + ' main requests)');
  } finally {
    await fixture.dispose();
    await new Promise(r => up.server.close(r));
  }
  A.report('host-notes.strict-template.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
