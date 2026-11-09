'use strict';
/* test/helpers/cache-ttl-bodies.js — the exact request bodies every Claude cache stamper sends for a fixed set of requests.
   Prints them between two markers on stdout:  @@BODIES@@{ "<route>/<case>": "<the body string the adapter handed fetch>" }@@END@@

   Run it as a CHILD process, one per value of SKYNET_ANTHROPIC_CACHE_TTL (test/cache-ttl.invariant.test.js does). A fresh
   process hands every adapter the switch from its first line, whether that adapter reads it once at load or per call, so
   a tree from before the TTL resolver and a tree after it are measured on the same footing.

   Routes (each built by the REAL factory, the way a run builds it; fetch is a recorder, so nothing leaves the machine):
     anthropic       the native Messages adapter, claude-sonnet-5-5
     openrouter      Claude through OpenRouter, anthropic/claude-sonnet-5.5
     managed         the credits route (openai-compatible adapter + openrouter.applyCacheControl), anthropic/claude-sonnet-5.5
     openrouter-gpt  a non-Claude model through OpenRouter: never stamped, in any mode
   Cases: the shapes a loop actually sends — the newest message with its host notes (<run_context>, recall, <crew_call>),
   later iterations of that run, a conversation's first message, a split and an unsplit system prompt, no system prompt,
   no note at all, a history that stopped at tool results, a leading recall message, and a never-reread extraction. */
const path = require('node:path');
const ROOT = path.join(__dirname, '..', '..');
const P = require(path.join(ROOT, 'sidecar', 'providers', 'provider.js'));
const factory = require(path.join(ROOT, 'sidecar', 'providers', 'factory.js'));

const SYS_PREFIX = 'You are the station overseer. Follow the standing orders and keep the Commander informed.';
const SYS = SYS_PREFIX + '\n\n[CONVERSATION] The Commander thread with the overseer.';
const TOOLS = [
  { type: 'function', function: { name: 'fs_read', description: 'Read a file in the workspace.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the web.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } }
];
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const sys = content => ({ role: 'system', content });
const HISTORY = [
  { role: 'user', content: 'Read the notes file.' },
  { role: 'assistant', content: 'Reading it now.', tool_calls: [call('call_1', 'fs_read', { path: 'notes.md' })] },
  { role: 'tool', tool_call_id: 'call_1', content: '# Notes\n- the launch window opens at dawn' },
  { role: 'assistant', content: 'The launch window opens at dawn.' },
  { role: 'user', content: 'And the weather?' },
  { role: 'assistant', content: 'Clear skies are forecast.' }
];
const NOTE = sys(P.runContextNote('[RUNTIME] Run id: run-3\n[TASK BRIEF] Answer the newest message.'));
const RECALL = sys('<recalled-memory>\n- the Commander prefers short answers\n</recalled-memory>');
const ASK = { role: 'user', content: 'Summarize the plan in one line.' };
const CREW = sys(P.crewCallFence('[CREW CALL] no crew needed'));
const TURN = [NOTE, RECALL, ASK, CREW];
const ITERATIONS = [
  { role: 'assistant', content: '', tool_calls: [call('call_2', 'web_search', { query: 'dawn launch weather' }), call('call_3', 'fs_read', { path: 'plan.md' })] },
  { role: 'tool', tool_call_id: 'call_2', content: 'Clear, light wind.' },
  { role: 'tool', tool_call_id: 'call_3', content: 'Plan: launch at dawn.' },
  { role: 'assistant', content: 'Checking one more source.', tool_calls: [call('call_4', 'web_search', { query: 'dawn launch wind' })] },
  { role: 'tool', tool_call_id: 'call_4', content: 'Wind under 10 knots.' }
];

const CASES = {
  'split-tools-turn': m => ({ model: m, cacheSystemPrefix: SYS_PREFIX, tools: TOOLS, messages: [sys(SYS)].concat(HISTORY, TURN) }),
  'split-tools-iteration': m => ({ model: m, cacheSystemPrefix: SYS_PREFIX, tools: TOOLS, messages: [sys(SYS)].concat(HISTORY, TURN, ITERATIONS) }),
  'split-tools-first': m => ({ model: m, cacheSystemPrefix: SYS_PREFIX, tools: TOOLS, messages: [sys(SYS), NOTE, ASK, CREW] }),
  'unsplit-tools-turn': m => ({ model: m, tools: TOOLS, messages: [sys(SYS)].concat(HISTORY, TURN) }),
  'unsplit-tools-iteration': m => ({ model: m, tools: TOOLS, messages: [sys(SYS)].concat(HISTORY, TURN, ITERATIONS) }),
  'split-notools-turn': m => ({ model: m, cacheSystemPrefix: SYS_PREFIX, messages: [sys(SYS)].concat(HISTORY, TURN) }),
  'nosystem-tools-turn': m => ({ model: m, tools: TOOLS, messages: HISTORY.concat(TURN) }),
  'no-note': m => ({ model: m, cacheSystemPrefix: SYS_PREFIX, tools: TOOLS, messages: [sys(SYS)].concat(HISTORY, [ASK]) }),
  'stopped-at-tools': m => ({ model: m, cacheSystemPrefix: SYS_PREFIX, tools: TOOLS, messages: [sys(SYS)].concat(HISTORY.slice(0, 3), TURN) }),
  'leading-recall': m => ({ model: m, cacheSystemPrefix: SYS_PREFIX, tools: TOOLS, messages: [sys(SYS), sys('Relevant memory remains mandatory.'), ASK] }),
  'never-reread': m => ({ model: m, neverReread: true, messages: [sys('Extract the launch date.'), { role: 'user', content: 'Launch is at dawn on the 9th.' }] })
};
const ROUTES = {
  anthropic: { provider: 'anthropic', model: 'claude-sonnet-5-5', opts: {} },
  openrouter: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', opts: {} },
  managed: { provider: 'starnet', model: 'anthropic/claude-sonnet-5.5', opts: { baseUrl: 'http://127.0.0.1:9/v1' } },
  'openrouter-gpt': { provider: 'openrouter', model: 'openai/gpt-5.5', opts: {}, cases: ['split-tools-turn', 'unsplit-tools-iteration', 'never-reread'] }
};

const ANTHROPIC_SSE = [
  { type: 'message_start', message: { id: 'msg_fixture', usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' }
].map(e => 'data: ' + JSON.stringify(e)).join('\n\n') + '\n\n';
const CHAT_SSE = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\ndata: [DONE]\n\n';

function recorder() {
  const posts = [];
  const f = async (url, init) => {
    const method = String((init && init.method) || 'GET').toUpperCase();
    if (method !== 'POST') return new Response(JSON.stringify({ data: [], models: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    posts.push({ url: String(url), body: String(init && init.body) });
    return new Response(/\/messages$/.test(String(url)) ? ANTHROPIC_SSE : CHAT_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  f.posts = posts;
  return f;
}

async function bodyOf(route, req) {
  const r = ROUTES[route];
  const f = recorder();
  const p = factory.selectProvider(Object.assign({ provider: r.provider, key: 'k', fetch: f }, r.opts));
  let error = null;
  try { for await (const _ of p.stream(Object.assign({ preStreamRetries: 0 }, req))) { /* drain */ } } catch (e) { error = e; }
  const post = f.posts.find(x => /\/(messages|chat\/completions)$/.test(x.url));
  if (!post) throw new Error(route + ': no request went out' + (error ? ' (' + error.message + ')' : ''));
  return post.body;
}

async function main() {
  const bodies = {};
  for (const route of Object.keys(ROUTES)) {
    for (const name of (ROUTES[route].cases || Object.keys(CASES))) bodies[route + '/' + name] = await bodyOf(route, CASES[name](ROUTES[route].model));
  }
  return bodies;
}

module.exports = { CASES, ROUTES };

if (require.main === module) {
  main().then(bodies => {
    process.stdout.write('@@BODIES@@' + JSON.stringify(bodies) + '@@END@@\n', () => process.exit(0));
  }, e => {
    process.stderr.write('cache-ttl-bodies: ' + ((e && e.stack) || e) + '\n', () => process.exit(1));
  });
}
