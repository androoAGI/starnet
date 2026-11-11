/* node test/credits-route-1108.test.js — THE STARNET CREDITS ROUTE, APP SIDE (2026-11-08 sweep).

   The cloud relay now answers four things in its own typed words; the app reads each the way it means, through the real
   openai-compatible adapter (the route StarNet Credits take), the real classifier, the real loop and both copy ladders:
     1. LOW CREDIT (402 `insufficient_credits`, "can only afford N max_tokens", the relay's OWN balance refusal): the same
        request is asked again ONCE at 90% of N (lifted alone from bfc635062); a wallet that can afford under 1024 keeps its
        honest 402; an upstream 402's words without the relay's code are never healed (the relay answers those as 503 now);
     2. SUPPLY OUT (503 `supply_unavailable`): an overload on StarNet's side, retried with backoff, never the Commander's
        billing, worded "StarNet's model supply is temporarily out; your credits are untouched" (a 402 stays their balance);
     3. CALL TIME LIMIT (a final SSE error event, code `call_timeout`): the run ends there, keeping what was written, and the
        whole call is never sent again (that would bill the same work twice);
     4. (the image refusal, 404 or the relay's 400 `image_input_unsupported`, is pinned in vision-input.test.js 4a). */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { classifyApiError } = require('../sidecar/providers/errorClass.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');
const NodeFriendly = require('../frontend/app/friendlyerror.js');

const BASE = 'https://managed.example.test/v1';
const line = obj => 'data: ' + JSON.stringify(obj);
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sse = text => new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
async function collect(p, req) { const out = []; for await (const e of p.stream(req)) out.push(e); return out; }
async function drain(p, req) { try { await collect(p, req); return null; } catch (e) { return e; } }
// a fake relay: /models answers an empty catalog, each POST is answered by chat(body, n)
function relay(chat) {
  const bodies = [];
  const fetch = async (url, init) => {
    if (!init || !init.body) return json(200, { data: [] });
    const body = JSON.parse(init.body);
    bodies.push(body);
    return chat(body, bodies.length);
  };
  return { fetch, bodies };
}
const OWN_402 = n => json(402, { error: { type: 'billing', code: 'insufficient_credits', message: 'insufficient StarNet credits: this call holds up to $0.4505 while it runs and the balance available is $0.3724 (requires more credits, or fewer max_tokens) — can only afford ' + n + ' max_tokens' } });
const SUPPLY_MSG = "StarNet's model supply is temporarily out; your credits are untouched";

(async () => {
  // ---- 1. low credit: the relay's own balance refusal heals once; nothing else does ---------------------------------------------
  {
    const r = relay((body, n) => n === 1 ? OWN_402(25756) : sse(line({ choices: [{ delta: { content: 'healed' } }] }) + '\n\ndata: [DONE]\n\n'));
    const evs = await collect(makeOpenAICompatibleProvider({ fetch: r.fetch, key: 'fixture-only', baseUrl: BASE }), { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    A.eq(r.bodies.length, 2, 'the relay\'s own 402 that names what it can afford is asked again, once');
    A.eq(r.bodies[1].max_tokens, Math.floor(25756 * 0.9), '…at 90% of that');
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'healed', '…and the reply comes');
  }
  {
    const r = relay(() => OWN_402(300));
    const err = await drain(makeOpenAICompatibleProvider({ fetch: r.fetch, key: 'fixture-only', baseUrl: BASE }), { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    A.ok(r.bodies.length === 1 && err && /402/.test(err.message), 'a wallet that can afford almost nothing is not asked again; its honest 402 stands');
    A.eq(classifyApiError(err).reason, 'billing', '…and it is the Commander\'s balance');
  }
  {
    // OpenRouter's own words, relayed by an older cloud with no relay code: not the relay's balance refusal, never healed here
    const r = relay(() => json(402, { error: { code: 402, message: 'This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 51917.' } }));
    const err = await drain(makeOpenAICompatibleProvider({ fetch: r.fetch, key: 'fixture-only', baseUrl: BASE }), { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    A.ok(r.bodies.length === 1 && !!err, 'an upstream 402\'s "can only afford" words without the relay\'s code are not healed (' + r.bodies.length + ' calls)');
  }

  // ---- 2. supply out: an overload on StarNet's side, retried, never billing, in its own words ------------------------------------
  {
    const r = relay(() => json(503, { error: { code: 'supply_unavailable', message: SUPPLY_MSG } }));
    const err = await drain(makeOpenAICompatibleProvider({ fetch: r.fetch, key: 'fixture-only', baseUrl: BASE }), { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    A.ok(r.bodies.length >= 2, 'a supply refusal is retried with backoff (' + r.bodies.length + ' calls before the loop takes over)');
    A.ok(!!err && err.transient === true, 'and stays transient for the loop\'s own ladder');
    const cls = classifyApiError(err);
    A.eq([cls.reason, cls.retryable, cls.shouldRotateCredential], ['overloaded', true, false], 'classified as an overload, never billing');
    A.eq(classifyApiError(Object.assign(new Error('StarNet http 402 - ' + SUPPLY_MSG), { status: 402, body: { error: { code: 'supply_unavailable', message: SUPPLY_MSG } } })).reason, 'overloaded',
      'whatever status carries it, the relay\'s supply code is never the Commander\'s billing');
    for (const [label, args] of [['words', [err.message]], ['coded', [err.message, null, { code: cls.reason }]], ['error', [err]]]) {
      const v = NodeFriendly.friendlyError(...args);
      A.ok(v.userMessage.indexOf(SUPPLY_MSG) === 0 && v.kind !== 'billing' && v.retryable === true, 'the Commander reads StarNet\'s supply is out, credits untouched (' + label + '): ' + v.userMessage);
    }
    const own = NodeFriendly.friendlyError('StarNet http 402 - [code insufficient_credits] insufficient StarNet credits — can only afford 300 max_tokens');
    // #182: the Commander's own StarNet balance, said as StarNet credit (perhaps held by open calls), never a provider's billing
    A.eq([own.kind, own.action], ['managed_credit_short', 'store'], 'a 402 still means the Commander\'s own balance');
    A.ok(own.kind !== 'billing' && !/supply/i.test(own.userMessage), 'and is neither a provider account nor StarNet\'s supply: ' + own.userMessage);
  }

  // ---- 3. the per-call time limit: the run ends, keeps what was written, and is never resent -------------------------------------
  {
    const r = relay(() => sse(line({ id: 'gen-1', choices: [{ delta: { content: 'Here is the first half of the report' } }] }) + '\n\n'
      + line({ error: { code: 'call_timeout', message: 'This call reached the 30-minute limit StarNet allows for one call.' } }) + '\n\n'));
    const provider = makeOpenAICompatibleProvider({ fetch: r.fetch, key: 'fixture-only', baseUrl: BASE });
    const bus = A.makeBus(), seq = A.collectBus(bus, events.names()), emit = makeEmitter(bus, () => {});
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'write the report' }], provider, emit, cost: makeCostEngine({ priceOf: () => ({ in: 1, out: 2 }) }),
      model: 'm', agentId: 'a', runId: 'r', tools: [], limits: { maxIters: 3, grace: false }, signal: new AbortController().signal,
      dispatch: async () => 'x', capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' },
      clock: { now: () => Date.now() }, waitTicker: () => () => {}
    });
    A.eq([res.reason, res.failureCode], ['error', 'call_timeout'], 'the run ends on the call\'s time limit');
    A.eq(r.bodies.length, 1, 'the whole call is never sent again (it would bill the same work twice)');
    const error = (seq.find(e => e.name === 'agent.run.error') || {}).payload || {};
    A.ok(error.transient === false && /time limit for one call/.test(error.message) && /billed/.test(error.message), 'the run says what happened: ' + error.message);
    A.ok(String(res.text || '').indexOf('Here is the first half of the report') === 0, 'what the model wrote is kept: ' + JSON.stringify(String(res.text || '').slice(0, 80)));
    const v = NodeFriendly.friendlyError(error.message, null, { code: 'call_timeout' });
    A.ok(v.kind === 'call_timeout' && v.retryable === false && /time limit for one call/.test(v.userMessage) && /not sent again/.test(v.userMessage), 'the Commander reads it plainly: ' + v.userMessage);
    A.eq(NodeFriendly.friendlyError('provider stream error: call_timeout').kind, 'call_timeout', 'the relay\'s bare code reads the same');
  }
  A.report('credits-route-1108');
})().catch(error => { A.ok(false, error.stack); A.report('credits-route-1108'); });
