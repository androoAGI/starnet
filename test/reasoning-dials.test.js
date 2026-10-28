/* node test/reasoning-dials.test.js — OpenAI-API and DeepSeek reasoning dials are true, end to end.

   OpenAI's /v1/models publishes no capability data, so the openai profile documents per-model levels
   (registry `reasoningModels`, transcribed from OpenAI's guide + feature matrix) and the adapter LEARNS a model's
   real list from OpenAI's own "Supported values are: …" refusal. DeepSeek's /models declares levels
   (effort.supported_levels) and its API documents reasoning_effort 'none' as thinking OFF. DeepSeek thinking mode
   also demands every turn's reasoning_content back on the next request when tools are present, or it 400s — the
   adapter captures it into the turn's opaque reasoning block and replays it.
   Drives the REAL chain: factory adapter -> publicModel (lifted from sidecar/index.js) -> model dock -> the wire. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const factory = require('../sidecar/providers/factory.js');
const { makeOpenAICompatibleProvider, _internals: oc } = require('../sidecar/providers/openai-compatible.js');
const Dock = require('../frontend/app/modeldock.js');

const backend = readSidecarSource();
const pmStart = backend.indexOf('function publicModel(m)');
const publicModel = vm.runInNewContext('(' + backend.slice(pmStart, backend.indexOf('\n}\n', pmStart) + 2) + ')');
const I = Dock._internals;

const OPENAI_CATALOG = { object: 'list', data: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4-mini', 'gpt-5.1', 'gpt-5', 'o3', 'o1-mini', 'gpt-4.1']
  .map(id => ({ id, object: 'model', created: 1780000000, owned_by: 'openai' })) };
const DEEPSEEK_CATALOG = { object: 'list', data: [
  { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek', name: 'DeepSeek-V4.1-Flash', context_window: 1048576, max_output_tokens: 393216,
    effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } },
  { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek', effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } },
  { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' }
] };
const TOOLS = [{ type: 'function', function: { name: 'fs_read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
const SSE = chunks => new Response(chunks.map(c => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n', { status: 200 });

function endpoint(catalog, onPost) {
  const posts = [];
  const fetch = async (url, init) => {
    if (init && init.method === 'POST') {
      const body = JSON.parse(init.body);
      posts.push(body);
      const r = onPost ? onPost(body, posts.length) : null;
      return r || SSE([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
    }
    return new Response(JSON.stringify(catalog), { status: 200 });
  };
  return { fetch, posts };
}
async function collect(p, req) { const out = []; for await (const e of p.stream(req)) out.push(e); return out; }
const byId = list => Object.fromEntries(list.map(m => [m.id, m]));

module.exports = (async () => {
  // ---- 1. OpenAI: the profile documents each model's levels (its catalog says nothing) ----
  {
    const ep = endpoint(OPENAI_CATALOG);
    const p = factory.selectProvider({ provider: 'openai', fetch: ep.fetch, key: 'fixture-key', baseUrl: 'https://openai-1.test/v1' });
    const m = byId(await p.listModels());
    A.eq(m['gpt-5.5'].reasoningEfforts, ['none', 'low', 'medium', 'high', 'xhigh'], 'gpt-5.5: none..xhigh (max is Responses-only)');
    A.eq(m['gpt-5.5'].defaultReasoningLevel, 'medium', 'gpt-5.5 declares its documented default');
    A.eq(m['gpt-5'].reasoningEfforts, ['minimal', 'low', 'medium', 'high'], 'the original gpt-5 keeps minimal and has no OFF');
    A.eq(m['gpt-5.1'].defaultReasoningLevel, 'none', 'gpt-5.1 defaults to none');
    A.eq(m['o3'].reasoningEfforts, ['low', 'medium', 'high'], 'o3: low/medium/high');
    A.eq(m['gpt-6-astra'].reasoningEfforts, ['low', 'medium', 'high', 'xhigh'], 'gpt-6: no OFF claimed (OpenAI: astra 400s none)');
    A.eq(m['gpt-5.6-sol'].reasoningEfforts, ['none'], 'gpt-5.6 on Chat Completions with tools: reasoning off only');
    A.ok(/can't combine/.test(m['gpt-5.6-sol'].reasoningNote || ''), 'gpt-5.6 carries the reason as a note');
    A.eq(m['gpt-4.1'].supportsReasoning, false, 'gpt-4.1 is known not to reason');
    A.eq(m['o1-mini'].reasoningEfforts, [], 'o1-mini: no dial');
    A.eq(m['gpt-5.5-pro'].reasoningEffortsDeclared, false, 'a Responses-only id no rule covers stays unknown');

    // the dock shows exactly that
    const item = id => I.asModel(publicModel(m[id]), 'openai');
    A.eq(I.effortOptionsFor(item('gpt-5.5')), ['none', 'low', 'medium', 'high', 'xhigh'], 'dock: gpt-5.5 dial');
    A.eq(I.reasoningPresetsFor(item('gpt-5.5')).map(x => x.effort), ['low', 'medium', 'high', 'xhigh'], 'dock: MAX reaches xhigh');
    A.eq(I.effortShown('none', item('gpt-5.5')).label, 'OFF', 'dock: gpt-5.5 OFF is real');
    A.eq(I.clampEffortForModel('none', item('gpt-5')), 'medium', 'dock: gpt-5 has no OFF — lands on its default');
    A.eq(I.effortShown('none', item('gpt-5.6-sol')).label, 'OFF', 'dock: gpt-5.6 says OFF (StarNet sends none), not AUTO');
    A.eq(I.effortShown('none', item('gpt-4.1')).label, 'OFF', 'dock: gpt-4.1 says OFF (it does not reason)');
    A.eq(I.effortShown('none', item('gpt-5.5-pro')).label, 'AUTO', 'dock: an unknown model is AUTO');
    A.ok(/can't combine/.test(publicModel(m['gpt-5.6-sol']).reasoningNote), 'the note reaches the listing');

    // the wire, from a FRESH run instance
    const cases = [['gpt-5.5', 'xhigh', 'xhigh'], ['gpt-5.5', 'max', 'xhigh'], ['gpt-5.5', 'none', 'none'], ['gpt-5', 'none', undefined],
      ['gpt-5', 'xhigh', 'high'], ['o3', 'minimal', 'low'], ['gpt-4.1', 'high', undefined], ['o1-mini', 'high', undefined]];
    for (const [model, effort, want] of cases) {
      ep.posts.length = 0;
      await collect(factory.selectProvider({ provider: 'openai', fetch: ep.fetch, key: 'fixture-key', baseUrl: 'https://openai-1.test/v1' }), { model, messages: [{ role: 'user', content: 'hi' }], reasoningEffort: effort });
      A.eq(ep.posts[0].reasoning_effort, want, 'wire ' + model + ' @ ' + effort + ' -> ' + want);
    }
    // gpt-5.6 with tools must get an EXPLICIT none (omitting it means its default, medium, which 400s)
    ep.posts.length = 0;
    await collect(factory.selectProvider({ provider: 'openai', fetch: ep.fetch, key: 'fixture-key', baseUrl: 'https://openai-1.test/v1' }), { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, reasoningEffort: 'high' });
    A.eq(ep.posts[0].reasoning_effort, 'none', 'gpt-5.6 + tools: reasoning_effort none is sent explicitly');
  }

  // ---- 2. OpenAI: the endpoint's own refusal teaches the real list ----
  {
    const refuse = { error: { message: "Unsupported value: 'reasoning_effort' does not support 'xhigh' with this model. Supported values are: 'low', 'medium', and 'high'.", type: 'invalid_request_error', param: 'reasoning_effort', code: 'unsupported_value' } };
    const ep = endpoint(OPENAI_CATALOG, body => (body.reasoning_effort === 'xhigh' ? new Response(JSON.stringify(refuse), { status: 400 }) : null));
    const base = 'https://openai-2.test/v1';
    const p = factory.selectProvider({ provider: 'openai', fetch: ep.fetch, key: 'fixture-key', baseUrl: base });
    await collect(p, { model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'xhigh' });
    A.eq(ep.posts.map(b => b.reasoning_effort), ['xhigh', 'high'], 'refused xhigh -> resent at the nearest level the endpoint named');
    A.eq(byId(await p.listModels())['gpt-5.4-mini'].reasoningEfforts, ['low', 'medium', 'high'], 'the learned list replaces the table in the listing');
    ep.posts.length = 0;
    await collect(factory.selectProvider({ provider: 'openai', fetch: ep.fetch, key: 'fixture-key', baseUrl: base }), { model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'again' }], reasoningEffort: 'xhigh' });
    A.eq(ep.posts.map(b => b.reasoning_effort), ['high'], 'a later run sends the learned level first time (no second refusal)');
    A.eq(oc.supportedEffortsFrom(refuse.error.message), ['low', 'medium', 'high'], 'the refusal parser reads the quoted list');

    // the gpt-5.6 tools refusal arrives even with NO effort sent — heal to an explicit none
    const toolsRefusal = { error: { message: "Function tools with reasoning_effort are not supported for gpt-5.7-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'." } };
    const ep2 = endpoint({ data: [] }, body => (body.tools && body.reasoning_effort !== 'none' ? new Response(JSON.stringify(toolsRefusal), { status: 400 }) : null));
    const raw = makeOpenAICompatibleProvider({ fetch: ep2.fetch, key: 'k', baseUrl: 'https://openai-3.test/v1' });
    await collect(raw, { model: 'gpt-5.7-sol', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });
    A.eq(ep2.posts.map(b => b.reasoning_effort), [undefined, 'none'], 'an unlisted model refusing tools+reasoning is resent with none');
  }

  // ---- 3. DeepSeek: the catalog declares levels, 'none' turns thinking off ----
  {
    const ep = endpoint(DEEPSEEK_CATALOG);
    const p = factory.selectProvider({ provider: 'deepseek', fetch: ep.fetch, key: 'fixture-key', baseUrl: 'https://deepseek-1.test' });
    const m = byId(await p.listModels());
    A.eq(m['deepseek-flash'].reasoningEfforts, ['none', 'low', 'high', 'max'], 'deepseek-flash: catalog levels + documented OFF');
    A.eq(m['deepseek-flash'].defaultReasoningLevel, 'high', 'deepseek-flash default high');
    A.eq(m['deepseek-flash'].context_length, 1048576, 'context_window is read');
    A.eq(m['deepseek-chat'].reasoningEffortsDeclared, false, 'the legacy non-thinking alias declares nothing');
    const item = I.asModel(publicModel(m['deepseek-flash']), 'deepseek');
    A.eq(I.effortOptionsFor(item), ['none', 'low', 'high', 'max'], 'dock: deepseek dial');
    A.eq(I.effortShown('none', item).label, 'OFF', 'dock: OFF is real (thinking disabled)');
    A.eq(I.clampEffortForModel('medium', item), 'high', 'dock: an unlisted medium lands on the default');
    const cases = [['medium', 'high'], ['xhigh', 'high'], ['minimal', 'low'], ['max', 'max'], ['none', 'none']];
    for (const [effort, want] of cases) {
      ep.posts.length = 0;
      await collect(factory.selectProvider({ provider: 'deepseek', fetch: ep.fetch, key: 'fixture-key', baseUrl: 'https://deepseek-1.test' }), { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: effort });
      A.eq(ep.posts[0].reasoning_effort, want, 'deepseek wire @ ' + effort + ' -> ' + want + ' (DeepSeek maps the same way)');
    }
  }

  // ---- 4. DeepSeek thinking + tools: reasoning_content rides back, or the API 400s ----
  {
    const passedBack = body => body.messages.filter(x => x.role === 'assistant').every(x => typeof x.reasoning_content === 'string');
    const ep = endpoint(DEEPSEEK_CATALOG, (body, n) => {
      if (body.tools && body.reasoning_effort !== 'none' && !passedBack(body)) {
        return new Response(JSON.stringify({ error: { message: 'The reasoning_content in the thinking mode must be passed back to the API.', type: 'invalid_request_error' } }), { status: 400 });
      }
      if (n === 1) return SSE([
        { choices: [{ delta: { reasoning_content: 'I should read ' } }] },
        { choices: [{ delta: { reasoning_content: 'the file first.' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'fs_read', arguments: '{"path":"a.txt"}' } }] }, finish_reason: 'tool_calls' }] }
      ]);
      return null;
    });
    const base = 'https://deepseek-2.test';
    await factory.selectProvider({ provider: 'deepseek', fetch: ep.fetch, key: 'fixture-key', baseUrl: base }).listModels();
    const run = factory.selectProvider({ provider: 'deepseek', fetch: ep.fetch, key: 'fixture-key', baseUrl: base });
    const history = [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer (kept by the page, no reasoning)' }, { role: 'user', content: 'read a.txt' }];
    const ev1 = await collect(run, { model: 'deepseek-flash', messages: history, tools: TOOLS, reasoningEffort: 'high' });
    // a blockless { type:'reasoning' } says reasoning began streaming (a Stop's spend truth); the block is parked once
    const block = ev1.find(e => e.type === 'reasoning' && e.block);
    A.eq(block && block.block, { type: 'reasoning_content', text: 'I should read the file first.' }, 'the turn\'s reasoning_content is parked as ONE reasoning block');
    A.eq(ev1.filter(e => e.type === 'reasoning' && e.block).length, 1, 'exactly one parked block');
    A.ok(ev1.findIndex(e => e.type === 'reasoning' && e.block) < ev1.findIndex(e => e.type === 'done'), 'the block precedes the terminal event');
    A.ok(passedBack(ep.posts[0]), 'first request: the page-kept history turn got reasoning_content "" (no 400)');
    A.eq(ep.posts[0].messages[1].reasoning_content, '', 'an uncaptured turn is handed back as ""');
    // the loop parks the block on the turn (loop.js assistantTurn) and runs the tool; the next request must hand it back
    const turn = { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'fs_read', arguments: '{"path":"a.txt"}' } }], reasoning: [block.block] };
    const next = history.concat([turn, { role: 'tool', tool_call_id: 'call_1', content: 'hello' }]);
    const before = JSON.stringify(next);
    await collect(run, { model: 'deepseek-flash', messages: next, tools: TOOLS, reasoningEffort: 'high' });
    const sent = ep.posts[1].messages.find(x => x.tool_calls);
    A.eq(sent.reasoning_content, 'I should read the file first.', 'the captured reasoning rides back on its own turn');
    A.eq(sent.reasoning, undefined, 'StarNet\'s parking field never reaches the wire');
    A.eq(JSON.stringify(next), before, 'the durable transcript is never mutated');
    // thinking OFF: plain schema, nothing owed
    ep.posts.length = 0;
    await collect(run, { model: 'deepseek-flash', messages: next, tools: TOOLS, reasoningEffort: 'none' });
    A.ok(ep.posts[0].messages.every(x => x.reasoning_content === undefined && x.reasoning === undefined), 'thinking off: no reasoning fields on the wire');
    // a model this process never saw think (legacy alias, after a restart): the 400 itself teaches it
    ep.posts.length = 0;
    const cold = factory.selectProvider({ provider: 'deepseek', fetch: ep.fetch, key: 'fixture-key', baseUrl: 'https://deepseek-3.test' });
    await collect(cold, { model: 'deepseek-reasoner', messages: history, tools: TOOLS });
    A.eq(ep.posts.length, 2, 'the "must be passed back" 400 is healed by one resend');
    A.ok(passedBack(ep.posts[1]), 'the resend hands every assistant turn its reasoning_content');
    // no other provider ever sees the field
    const other = endpoint(OPENAI_CATALOG);
    await collect(factory.selectProvider({ provider: 'openai', fetch: other.fetch, key: 'k', baseUrl: 'https://openai-4.test/v1' }), { model: 'gpt-5.5', messages: history, tools: TOOLS });
    A.ok(other.posts[0].messages.every(x => x.reasoning_content === undefined), 'openai requests carry no reasoning_content');
  }

  A.report('reasoning-dials.test');
})();
