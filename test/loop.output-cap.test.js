/* node test/loop.output-cap.test.js — F1 of the 2026-09-22 Hermes audit: an OUTPUT-cap refusal is not an overflow.

   "max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-…" matched the
   overflow pattern `maximum.*tokens`: the loop folded history for nothing, retried with the SAME max_tokens, got
   the same refusal, and the run died. Now it classifies output_cap (allowedMaxTokens 64000) and the loop retries
   the SAME turn once with the output budget lowered to 64000 — no fold — and later turns keep the lowered budget.
   Real native Anthropic adapter over a stubbed fetch (no network, no sidecar). */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeContext } = require('../sidecar/context.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeAnthropicProvider } = require('../sidecar/providers/anthropic.js');

const NL = String.fromCharCode(10);
const line = obj => 'data: ' + JSON.stringify(obj);
const sse = frames => new Response(frames.map(line).concat(['']).join(NL), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const textTurn = text => sse([
  { type: 'message_start', message: { usage: { input_tokens: 40, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' }
]);
const toolTurn = (id, name, json) => sse([
  { type: 'message_start', message: { usage: { input_tokens: 40, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } },
  { type: 'message_stop' }
]);
const refusal = message => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }),
  { status: 400, headers: { 'Content-Type': 'application/json' } });
const CAP_MSG = 'max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-sonnet-4-5-20250929';

function upstream(script) {
  const posts = [];
  const fetch = async (url, init) => {
    if (!/\/messages$/.test(String(url))) return new Response('{"data":[]}', { status: 200 });
    posts.push(JSON.parse(init.body));
    return script(posts.length, posts[posts.length - 1]);
  };
  return { fetch, posts };
}
function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  return { seq, emit: makeEmitter(bus, () => {}) };
}
const priceOf = () => ({ in: 3, out: 15 });
const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });
// the composition root's own override (anthropic.js resolveMaxTokens: opts.maxTokens) is the realistic way a
// Commander ends up asking for more than the model allows (e.g. SKYNET_ANTHROPIC_MAX_TOKENS=128000)
const anthropic = fetch => makeAnthropicProvider({ fetch, key: 'fixture-only', baseUrl: 'https://anthropic.fixture.invalid/v1', maxTokens: 128000 });

(async () => {
  // (A) cap refusal -> no fold, the retried request carries max_tokens <= 64000, the run ends done; a later turn
  //     of the same run keeps the lowered budget (the model would refuse 128000 again).
  {
    let toolRuns = 0, summarized = 0;
    const registry = makeRegistry();
    registry.register({ impact: 'none', name: 'fixture_read', schema: { type: 'object', properties: { path: { type: 'string' } } },
      run: async () => { toolRuns++; return 'file contents'; } });
    const up = upstream((n, body) => {
      if (Number(body.max_tokens) > 64000) return refusal(CAP_MSG);   // the model's real ceiling, enforced every turn
      return n === 2 ? toolTurn('toolu_1', 'fixture_read', '{"path":"a.md"}') : textTurn('written within the cap');
    });
    const { seq, emit } = setup();
    const recov = [];
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'x'.repeat(3000) }, { role: 'assistant', content: 'y'.repeat(3000) }, { role: 'user', content: 'write the long report' }],
      provider: anthropic(up.fetch), emit, cost: makeCostEngine({ priceOf }), model: 'claude-sonnet-4-5', agentId: 'a', runId: 'r',
      tools: [], dispatch: (c, ctx) => registry.dispatch(c, ctx), capCtx: openCtx(),
      context: makeContext({ contextLimit: 200000, compactAt: 0.65, keepTail: 1 }),
      summarize: async () => { summarized++; return 'SUMMARY'; },
      approxTokens: 1500, contextLimit: 200000, sleep: async () => {}, random: () => 0.5, onRecovery: row => recov.push(row)
    });
    A.eq(res.reason, 'done', 'the output-cap refusal was recovered and the run finished');
    A.eq(up.posts.map(b => b.max_tokens), [128000, 64000, 64000], 'refused at 128000, retried at the named 64000, and the NEXT turn kept 64000');
    A.ok(up.posts.slice(1).every(b => b.max_tokens <= 64000), 'every request after the refusal carries max_tokens <= 64000');
    A.eq(seq.filter(e => e.name === 'agent.compact').length, 0, 'NO fold — the prompt was never the problem');
    A.eq(summarized, 0, 'the summarizer was never paid for');
    A.eq(toolRuns, 1, 'the tool ran once');
    A.eq(seq.filter(e => e.name === 'agent.run.error').length, 0, 'no run.error');
    A.eq(recov.map(r => [r.action, r.reason]), [['lower_output', 'output_cap']], 'one lower_output recovery, recorded with its reason');
    A.ok(up.posts.length > 1 && JSON.stringify(up.posts[1].messages) === JSON.stringify(up.posts[0].messages), 'the retry is the SAME turn — identical messages, only the output budget changed');
  }

  // (B) bounded: a second cap refusal in the same turn is terminal (never a loop), and still no fold.
  {
    const up = upstream((n) => n === 1 ? refusal(CAP_MSG) : refusal('max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-x'));
    const { seq, emit } = setup();
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'go' }], provider: anthropic(up.fetch), emit, cost: makeCostEngine({ priceOf }), model: 'claude-sonnet-4-5',
      agentId: 'a', runId: 'r', context: makeContext({ contextLimit: 200000 }), summarize: async () => 'SUMMARY', sleep: async () => {}, random: () => 0.5
    });
    A.eq([res.reason, res.failureCode], ['error', 'output_cap'], 'a second refusal ends the run as output_cap');
    A.eq(up.posts.length, 2, 'exactly one lowered retry, then stop');
    A.eq(seq.filter(e => e.name === 'agent.compact').length, 0, 'still no fold');
    A.eq(seq.find(e => e.name === 'agent.run.error').payload.transient, false, 'the terminal cap refusal is not marked transient');
  }

  A.report('loop.output-cap.test');
})();
