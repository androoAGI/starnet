/* node test/provider.toolschema.keys.test.js — tool property names every wire accepts, and the model's arguments
   mapped back to the DECLARED names before the loop validates and dispatches (Hermes audit Step 2, 2026-09-22).

   Audit finding (29bb21d80): a property key like "account id" (MCP connectors ship them) survived every adapter —
   toolschema.normalize()/forGemini() kept it, and the Chat Completions / Codex routes sent raw schemas. Anthropic
   (and Bedrock/Vertex fronting it) rejects keys outside ^[a-zA-Z0-9_.-]{1,64}$, and ONE bad key 400s the whole
   request on every turn. Pinned here: the advertised schema carries grammar-safe aliases on all five wires; the
   args that come back are restored to the declared keys inside the adapter (so the registry validates the names
   the tool declared); a well-formed tool's advertised schema and arg stream are byte-identical to before.
   Injected fetch only — no network. */
'use strict';
const A = require('./_assert.js');
const toolschema = require('../sidecar/providers/toolschema.js');
const { makeAnthropicProvider } = require('../sidecar/providers/anthropic.js');
const { makeGeminiProvider } = require('../sidecar/providers/gemini.js');
const { makeCodexProvider } = require('../sidecar/providers/codex.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');
const { makeOpenRouterProvider } = require('../sidecar/providers/openrouter.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { runAgentLoop } = require('../sidecar/loop.js');

const KEY_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const CRM_PARAMS = {
  type: 'object',
  properties: {
    'account id': { type: 'string', description: 'the account' },
    account_id: { type: 'integer', description: 'legacy numeric id' },
    nested: { type: 'object', properties: { 'first name': { type: 'string' } }, required: ['first name'] },
    list: { type: 'array', items: { type: 'object', properties: { 'row #': { type: 'number' } } } }
  },
  required: ['account id']
};
const WEB_PARAMS = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
const TOOLS = [
  { type: 'function', function: { name: 'crm_lookup', description: 'CRM', parameters: CRM_PARAMS } },
  { type: 'function', function: { name: 'web_search', description: 'd', parameters: WEB_PARAMS } }
];
const TOOLS_SNAPSHOT = JSON.stringify(TOOLS);
// what the model sends back, in the aliases it was shown
const WIRE_ARGS = { account_id_2: 'A-1', account_id: 7, nested: { first_name: 'Ann' }, list: [{ row__: 1 }, { row__: 2 }] };
const DECLARED_ARGS = { 'account id': 'A-1', account_id: 7, nested: { 'first name': 'Ann' }, list: [{ 'row #': 1 }, { 'row #': 2 }] };
const WIRE_TEXT = JSON.stringify(WIRE_ARGS);
const CUT = 17;   // the crm args arrive in two fragments, split mid-key
const line = o => 'data: ' + JSON.stringify(o);
const sse = lines => new Response(lines.join('\n') + '\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

function badKeys(schema, out) {
  out = out || [];
  if (Array.isArray(schema)) { for (const s of schema) badKeys(s, out); return out; }
  if (!schema || typeof schema !== 'object') return out;
  if (schema.properties && typeof schema.properties === 'object') for (const k of Object.keys(schema.properties)) if (!KEY_RE.test(k)) out.push(k);
  for (const k of Object.keys(schema)) if (schema[k] && typeof schema[k] === 'object') badKeys(schema[k], out);
  return out;
}

const chatSSE = () => sse([
  line({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'crm_lookup', arguments: WIRE_TEXT.slice(0, CUT) } }] } }] }),
  line({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: WIRE_TEXT.slice(CUT) } }] } }] }),
  line({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'web_search', arguments: '{"q":' } }] } }] }),
  line({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"x"}' } }] } }] }),
  line({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  'data: [DONE]'
]);
const WIRES = {
  'openai-compatible': {
    make: fetch => makeOpenAICompatibleProvider({ key: 'k', baseUrl: 'https://compat.test/v1', fetch }),
    reply: chatSSE,
    advertised: body => body.tools.map(t => t.function.parameters),
    webExpected: WEB_PARAMS
  },
  openrouter: {
    make: fetch => makeOpenRouterProvider({ key: 'k', fetch }),
    reply: chatSSE,
    advertised: body => body.tools.map(t => t.function.parameters),
    webExpected: WEB_PARAMS
  },
  anthropic: {
    make: fetch => makeAnthropicProvider({ key: 'k', fetch }),
    reply: () => sse([
      line({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'crm_lookup', input: {} } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: WIRE_TEXT.slice(0, CUT) } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: WIRE_TEXT.slice(CUT) } }),
      line({ type: 'content_block_stop', index: 0 }),
      line({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'web_search', input: {} } }),
      line({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":' } }),
      line({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"x"}' } }),
      line({ type: 'content_block_stop', index: 1 }),
      line({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
      line({ type: 'message_stop' })
    ]),
    advertised: body => body.tools.map(t => t.input_schema),
    webExpected: toolschema.normalize(WEB_PARAMS)
  },
  gemini: {
    make: fetch => makeGeminiProvider({ key: 'k', fetch }),
    reply: () => sse([
      line({ candidates: [{ content: { parts: [{ functionCall: { name: 'crm_lookup', args: WIRE_ARGS } }, { functionCall: { name: 'web_search', args: { q: 'x' } } }] }, finishReason: 'STOP' }] })
    ]),
    advertised: body => body.tools[0].functionDeclarations.map(d => d.parameters),
    webExpected: toolschema.forGemini(WEB_PARAMS)
  },
  codex: {
    make: fetch => makeCodexProvider({ token: 't', fetch }),
    reply: () => sse([
      line({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'crm_lookup', arguments: '' } }),
      line({ type: 'response.function_call_arguments.delta', output_index: 0, delta: WIRE_TEXT.slice(0, CUT) }),
      line({ type: 'response.function_call_arguments.delta', output_index: 0, delta: WIRE_TEXT.slice(CUT) }),
      line({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call' } }),
      line({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'c2', name: 'web_search', arguments: '' } }),
      line({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"q":' }),
      line({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '"x"}' }),
      line({ type: 'response.output_item.done', output_index: 1, item: { type: 'function_call' } }),
      line({ type: 'response.completed', response: {} })
    ]),
    advertised: body => body.tools.map(t => t.parameters),
    webExpected: WEB_PARAMS
  }
};

async function drive(wire, tools) {
  let body = null;
  const p = wire.make(async (url, init) => {
    if (!init || !init.body) return new Response('{"data":[],"models":[]}', { status: 200 });
    body = JSON.parse(init.body);
    return wire.reply();
  });
  const evs = [];
  for await (const e of p.stream({ model: 'test-model', messages: [{ role: 'user', content: 'look up A-1' }], tools })) evs.push(e);
  return { body, evs };
}
const argsOf = (evs, index) => evs.filter(e => e.type === 'tool_args' && e.index === index).map(e => e.chunk);

(async () => {
  // ---- 1. the rename itself: deterministic, collision-safe, `required` follows, identity when nothing is bad ----
  {
    const s = toolschema.sanitizeKeys(CRM_PARAMS);
    A.eq(Object.keys(s.properties), ['account_id_2', 'account_id', 'nested', 'list'], '"account id" becomes account_id_2 — it must not collide with the declared account_id');
    A.eq(s.required, ['account_id_2'], 'required follows the rename');
    A.eq(s.properties.nested, { type: 'object', properties: { first_name: { type: 'string' } }, required: ['first_name'] }, 'nested object keys + required are renamed');
    A.eq(Object.keys(s.properties.list.items.properties), ['row__'], 'array item keys are renamed');
    A.eq(s.properties.account_id, CRM_PARAMS.properties.account_id, 'a valid sibling keeps its schema');
    A.eq(badKeys(s), [], 'no key outside the grammar survives');
    A.ok(toolschema.sanitizeKeys(WEB_PARAMS) === WEB_PARAMS, 'a key-safe schema returns by IDENTITY');
    A.eq(toolschema.sanitizeKeys({ type: 'object', properties: { ['k'.repeat(70)]: { type: 'string' }, '': { type: 'string' } } }).properties,
      { ['k'.repeat(64)]: { type: 'string' }, param: { type: 'string' } }, 'an over-long key is clipped to 64; an empty key gets a name');
    A.eq(toolschema.restoreArgumentKeys(CRM_PARAMS, WIRE_ARGS), DECLARED_ARGS, 'restoreArgumentKeys maps every alias back (nested + array items)');
    const both = { account_id_2: 'alias', 'account id': 'declared' };
    A.eq(toolschema.restoreArgumentKeys(CRM_PARAMS, both), both, 'an alias beside its own declared name is never clobbered');
    const plain = { q: 'x' };
    A.ok(toolschema.restoreArgumentKeys(WEB_PARAMS, plain) === plain, 'args of a key-safe tool return by identity');
    A.eq(JSON.stringify(TOOLS), TOOLS_SNAPSHOT, 'the registry tool defs are never mutated');
  }

  // ---- 2. every wire: aliases advertised, declared keys restored, the well-formed tool byte-identical ----
  for (const name of Object.keys(WIRES)) {
    const wire = WIRES[name];
    const { body, evs } = await drive(wire, TOOLS);
    const adv = wire.advertised(body);
    A.eq(badKeys(adv), [], name + ': no advertised property key is outside ^[a-zA-Z0-9_.-]{1,64}$');
    A.ok(JSON.stringify(adv[0]).indexOf('account_id_2') >= 0, name + ': "account id" is advertised as account_id_2');
    A.eq(adv[1], wire.webExpected, name + ': the well-formed tool is advertised exactly as before');
    const starts = evs.filter(e => e.type === 'tool_start');
    const crm = starts.find(e => e.name === 'crm_lookup');
    const web = starts.find(e => e.name === 'web_search');
    A.eq(JSON.parse(argsOf(evs, crm.index).join('')), DECLARED_ARGS, name + ': the model\'s args reach the loop under the DECLARED keys ("account id", "first name", "row #")');
    const webChunks = argsOf(evs, web.index);
    A.eq(webChunks.join(''), '{"q":"x"}', name + ': the well-formed tool\'s args are untouched');
    A.eq(webChunks.length, name === 'gemini' ? 1 : 2, name + ': …and still stream fragment by fragment (no buffering for a key-safe tool)');
    A.eq(evs.filter(e => e.type === 'done').length, 1, name + ': exactly one terminal event');
    const crmArgsAt = evs.findIndex(e => e.type === 'tool_args' && e.index === crm.index);
    A.ok(crmArgsAt >= 0 && crmArgsAt < evs.findIndex(e => e.type === 'done'), name + ': the restored args arrive BEFORE done');
    // a catalog of only well-formed tools: the advertised tools are exactly what they were
    const clean = await drive(wire, [TOOLS[1]]);
    A.eq(wire.advertised(clean.body), [wire.webExpected], name + ': a key-safe catalog is advertised unchanged');
  }
  // Chat Completions routes send the tool list verbatim: a key-safe catalog is the SAME bytes as the input list
  {
    const { body } = await drive(WIRES['openai-compatible'], [TOOLS[1]]);
    A.eq(JSON.stringify(body.tools), JSON.stringify([TOOLS[1]]), 'openai-compatible: well-formed tools are byte-identical on the wire');
    const or = await drive(WIRES.openrouter, [TOOLS[1]]);
    A.eq(JSON.stringify(or.body.tools), JSON.stringify([TOOLS[1]]), 'openrouter: well-formed tools are byte-identical on the wire');
  }
  A.eq(JSON.stringify(TOOLS), TOOLS_SNAPSHOT, 'no adapter mutated the shared tool defs');

  // ---- 3. through the REAL loop + registry: validation and dispatch see the declared names ----
  {
    const bus = A.makeBus();
    const emit = makeEmitter(bus, () => {});
    A.collectBus(bus, events.names());
    const ran = [];
    const reg = makeRegistry();
    // additionalProperties:false + required: the aliases alone would FAIL validation and the tool would never run
    reg.register({ impact: 'none', name: 'crm_lookup', description: 'CRM', schema: Object.assign({}, CRM_PARAMS, { additionalProperties: false }),
      run: async (a) => { ran.push(a); return 'found ' + a['account id']; } });
    const sent = [];
    let turn = 0;
    const p = makeOpenAICompatibleProvider({ key: 'k', baseUrl: 'https://compat.test/v1', fetch: async (url, init) => {
      if (!init || !init.body) return new Response('{"data":[]}', { status: 200 });
      sent.push(JSON.parse(init.body));
      if (turn++ === 0) {
        return sse([
          line({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'crm_lookup', arguments: WIRE_TEXT } }] } }] }),
          line({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
          'data: [DONE]'
        ]);
      }
      return sse([line({ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] }), 'data: [DONE]']);
    } });
    const messages = [{ role: 'user', content: 'look up A-1' }];
    const res = await runAgentLoop({
      messages, provider: p, emit, cost: makeCostEngine({ priceOf: () => ({ in: 1, out: 2 }) }), model: 'm', agentId: 'a', runId: 'r',
      tools: reg.wireFormat(), limits: { maxIters: 4, grace: false, verifyOnStop: false },
      dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' }
    });
    A.ok(JSON.stringify(sent[0].tools).indexOf('"account id"') < 0, 'loop: the model was shown only the grammar-safe alias');
    A.eq(ran, [DECLARED_ARGS], 'loop: the tool validated and ran ONCE with its declared keys');
    const rec = messages.find(m => m.role === 'assistant' && m.tool_calls);
    A.eq(JSON.parse(rec.tool_calls[0].function.arguments), DECLARED_ARGS, 'loop: the recorded call carries the declared keys too');
    A.eq(res.reason, 'done', 'loop: the run completes');
  }

  A.report('provider.toolschema.keys.test');
})().catch(e => { console.log('FAIL: provider.toolschema.keys.test threw -- ' + (e && e.stack || e)); process.exit(1); });
