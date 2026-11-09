/* node test/effort-as-sent.test.js — every HTTP adapter's effortAsSent names exactly the effort its own request puts on the wire.

   Why: a run record and a ledger row name "the effort the call ran on" (index.js effortAsRun). They used to name the dial the
   station was set to, which is not what goes out: Codex sends minimal as low and max as xhigh, Opus 5.5 always thinks (none
   goes out as low), and an OpenRouter model that takes no reasoning field is sent none at all (W1.5/W1.12 review 11-09).
   effortAsRun now asks the adapter, so each adapter's effortAsSent must read the same decision its request builder makes.

   Laws under test (the real adapters through the real factory, a fake fetch that captures each request body):
     • for every dial the adapter is built with, and every per-request effort (none of its own included), the effort
       effortAsSent(model, perRequest, req) names after the call IS the effort the captured body carries: Codex
       reasoning.effort, OpenRouter reasoning.effort, Anthropic output_config.effort / the budget of manual thinking / OFF,
       Gemini thinkingLevel / thinkingBudget, the chat wire's reasoning_effort, native Ollama's think:false;
     • an adapter that made no call yet predicts the same effort (one decision, shared with the request builder);
     • a request that carries no effort names none (null): the record leaves the field out rather than guess;
     • on the two wires whose request depends on what the endpoint said (OpenRouter, the chat wire), the record is read off
       the request that actually left: a level the endpoint refused and the adapter resent is named as resent, and a first
       call made before the catalog warmed is named as it went, not as the warm catalog would have it. */
'use strict';
const A = require('./_assert.js');
const factory = require('../sidecar/providers/factory.js');

const DIALS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const PER_REQUEST = [undefined].concat(DIALS);   // undefined: the request carries no effort of its own (a main run)
const TOOLS = [{ type: 'function', function: { name: 'fs_read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
const TASK = { tools: TOOLS, isTask: true };
const STOP = () => new Response(JSON.stringify({ error: { message: 'fixture: request captured' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
const json = v => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });

// one fake endpoint per adapter: catalog routes answer `catalog(url)`; the model call is captured and stopped
function endpoint(catalog, refuse) {
  const bodies = [];
  const fetch = async (url, init) => {
    const u = String(url);
    if (/\/api\/show$/.test(u)) return json({ model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 }, capabilities: ['completion', 'tools', 'thinking'] });
    if (/\/api\/ps$/.test(u)) return json({ models: [] });
    if (/\/api\/chat$/.test(u)) {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop' }) + '\n', { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
    }
    if (init && typeof init.body === 'string' && /chat\/completions|\/responses|\/messages|generatecontent/i.test(u)) {
      const b = JSON.parse(init.body);
      bodies.push(b);
      return (refuse && refuse(b)) || STOP();
    }
    return json(catalog ? catalog(u) : {});
  };
  return { fetch, bodies };
}
async function send(p, req) {
  try { for await (const ev of p.stream(Object.assign({ messages: [{ role: 'user', content: 'hi' }] }, req))) void ev; } catch (_) { /* the fixture stops every call */ }
}
async function build(o, dial, ep) {
  ep = ep || endpoint(o.catalog);
  const p = factory.selectProvider(Object.assign({ provider: o.provider, fetch: ep.fetch, key: 'k', token: 'acc', reasoningEffort: dial }, o.opts || {}));
  if (o.warm !== false && typeof p.listModels === 'function') { try { await p.listModels(); } catch (_) { /* a list is optional here */ } }
  // an adapter that cannot say what its request carried fails here, by name, instead of throwing the whole file
  if (typeof p.effortAsSent !== 'function') { A.ok(false, o.provider + ': the adapter says what effort its request carried (effortAsSent)'); p.effortAsSent = () => '(unsaid)'; }
  return { p, ep };
}

// what each captured body says the request asked for (null = no effort on the wire)
const ANTHROPIC_BUDGET = { minimal: 1024, low: 4000, medium: 8000, high: 16000, xhigh: 32000, max: 32000 };
const GEMINI_BUDGET = { none: 0, minimal: 512, low: 2048, medium: 8192, high: 16384, xhigh: 24576, max: 24576 };
const WIRE = {
  codex: b => (b.reasoning && b.reasoning.effort) || null,
  openrouter: b => (b.reasoning && b.reasoning.effort) || null,
  chat: b => b.reasoning_effort || null,
  ollama: b => (b.think === false ? 'none' : null),   // native think:true names no level
  // Anthropic: adaptive = its effort; manual = the budget (checked against the named level below); OFF = none
  anthropic: (b, model) => !b.thinking ? (/claude/i.test(model) ? 'none' : null)
    : b.thinking.type === 'adaptive' ? b.output_config.effort : b.thinking.type === 'enabled' ? { budget: b.thinking.budget_tokens, cap: b.max_tokens } : 'none',
  gemini: b => {
    const c = b.generationConfig && b.generationConfig.thinkingConfig;
    if (!c) return null;
    if (c.thinkingLevel) return String(c.thinkingLevel).toLowerCase();
    return c.thinkingBudget === 0 ? 'none' : { budget: c.thinkingBudget };
  }
};
// a manual-thinking budget on the wire is the named level's budget (Anthropic caps it at 3/4 of max_tokens)
function sameEffort(named, wire, kind) {
  if (wire && typeof wire === 'object') {
    if (kind === 'anthropic') return ANTHROPIC_BUDGET[named] != null && Math.min(ANTHROPIC_BUDGET[named], Math.floor(wire.cap * 0.75)) === wire.budget;
    return GEMINI_BUDGET[named] === wire.budget;
  }
  return named === wire;
}

async function matrix(label, o) {
  let checked = 0;
  for (const dial of DIALS) {
    for (const per of PER_REQUEST) {
      for (const shape of (o.shapes || [TASK])) {
        const { p, ep } = await build(o, dial);
        const req = Object.assign({ model: o.model }, shape, per ? { reasoningEffort: per } : {});
        await send(p, req);
        const body = ep.bodies[ep.bodies.length - 1];
        const at = label + ' dial ' + dial + ', per-request ' + (per || '(none)') + (shape.tools ? '' : ', background');
        if (!body) { A.ok(false, at + ': no request captured'); continue; }
        const wire = WIRE[o.wire](body, o.model);
        const named = p.effortAsSent(o.model, per, req);
        A.ok(sameEffort(named, wire, o.wire), at + ': the record names ' + JSON.stringify(named) + ', the wire carried ' + JSON.stringify(wire));
        if (o.predict !== false) {
          const ahead = (await build(o, dial)).p.effortAsSent(o.model, per, req);
          A.ok(sameEffort(ahead, wire, o.wire), at + ': before any call the adapter predicts ' + JSON.stringify(ahead) + ', the wire carried ' + JSON.stringify(wire));
        }
        checked++;
      }
    }
  }
  return checked;
}

(async () => {
  let n = 0;
  // ---- Codex: every request carries reasoning.effort, in the Responses API's words ----
  n += await matrix('codex gpt-5.5', { provider: 'codex', model: 'gpt-5.5', wire: 'codex' });
  {
    const { p } = await build({ provider: 'codex' }, 'minimal');
    A.eq(p.effortAsSent('gpt-5.5'), 'low', 'codex: a minimal dial goes out as low, and says so');
    A.eq(p.effortAsSent('gpt-5.5', 'max'), 'xhigh', 'codex: a max request goes out as xhigh');
    A.eq(p.effortAsSent('gpt-5.5', 'none'), 'none', 'codex: none goes out as none');
  }

  // ---- OpenRouter: a reasoning model's clamped rung; a model that takes no reasoning field is sent none ----
  const orCatalog = u => (/\/models/.test(u) ? { data: [
    { id: 'openai/gpt-5-mini', context_length: 400000, supported_parameters: ['tools', 'reasoning'] },
    { id: 'meta-llama/llama-3.3-70b-instruct', context_length: 131072, supported_parameters: ['tools'] }
  ] } : {});
  n += await matrix('openrouter gpt-5-mini', { provider: 'openrouter', model: 'openai/gpt-5-mini', wire: 'openrouter', catalog: orCatalog });
  n += await matrix('openrouter llama (no reasoning)', { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct', wire: 'openrouter', catalog: orCatalog });
  {
    const { p } = await build({ provider: 'openrouter', catalog: orCatalog }, 'medium');
    A.eq(p.effortAsSent('meta-llama/llama-3.3-70b-instruct'), null, 'openrouter: a medium dial on a model with no reasoning field names no effort');
  }
  {
    // a refused rung is resent at the nearest one kept, and the record names the resend (openrouter-effort-heal holds the heal)
    const MANDATORY = { error: { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.', code: 400 } };
    const ep = endpoint(orCatalog, b => (b.reasoning && b.reasoning.effort === 'none') ? new Response(JSON.stringify(MANDATORY), { status: 400, headers: { 'Content-Type': 'application/json' } }) : null);
    const { p } = await build({ provider: 'openrouter', catalog: orCatalog, opts: { baseUrl: 'https://heal.openrouter.test/api/v1' } }, 'medium', ep);
    await send(p, { model: 'openai/gpt-5-mini', tools: TOOLS, isTask: true, reasoningEffort: 'none' });
    A.eq(ep.bodies.map(b => b.reasoning && b.reasoning.effort), ['none', 'minimal'], 'openrouter heal fixture: none refused, resent at minimal');
    A.eq(p.effortAsSent('openai/gpt-5-mini', 'none'), 'minimal', 'openrouter: the record names the minimal the resend carried, never the refused none');
  }

  // ---- Anthropic: adaptive effort, Opus 5.5's floor, Sonnet 5.5's between_tools, legacy budgets, a non-Claude model ----
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-3-7-sonnet-latest', 'kimi-k2-turbo'])
    n += await matrix('anthropic ' + model, { provider: 'anthropic', model, wire: 'anthropic', catalog: () => ({ data: [] }) });
  {
    const { p } = await build({ provider: 'anthropic', catalog: () => ({ data: [] }) }, 'none');
    A.eq(p.effortAsSent('claude-opus-5-5'), 'low', 'anthropic: Opus 5.5 always thinks, so a none dial goes out as low, and says so');
    A.eq(p.effortAsSent('claude-opus-5-5', 'minimal'), 'low', 'anthropic: a minimal request on Opus 5.5 goes out as low');
    A.eq(p.effortAsSent('kimi-k2-turbo'), null, 'anthropic: a non-Claude model is sent no thinking: no effort named');
  }

  // ---- Gemini: modern thinkingLevel (OFF is the floor), 2.5 budgets ----
  for (const model of ['gemini-3-pro-preview', 'gemini-3-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'])
    n += await matrix('gemini ' + model, { provider: 'gemini', model, wire: 'gemini', catalog: () => ({ models: [] }) });

  // ---- the chat wire: declared levels (openai), a documented OFF (deepseek), a profile that documents the param (xai) ----
  n += await matrix('openai gpt-5.5', { provider: 'openai', model: 'gpt-5.5', wire: 'chat', catalog: () => ({ data: [{ id: 'gpt-5.5' }] }) });
  n += await matrix('openai gpt-5-mini', { provider: 'openai', model: 'gpt-5-mini', wire: 'chat', catalog: () => ({ data: [{ id: 'gpt-5-mini' }] }) });
  n += await matrix('openai gpt-4.1', { provider: 'openai', model: 'gpt-4.1', wire: 'chat', catalog: () => ({ data: [{ id: 'gpt-4.1' }] }) });
  const dsCatalog = () => ({ data: [{ id: 'deepseek-v4', effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } }] });
  n += await matrix('deepseek', { provider: 'deepseek', model: 'deepseek-v4', wire: 'chat', catalog: dsCatalog });
  n += await matrix('xai', { provider: 'xai', model: 'grok-4.7', wire: 'chat', catalog: () => ({ data: [{ id: 'grok-4.7' }] }) });
  {
    // OpenAI named the levels the model takes: the request is resent at one of them (or without the param when none of
    // them is OFF), and the record names the resend, never the refused level
    const refusing = level => b => b.reasoning_effort === level ? new Response(JSON.stringify({ error: { message: "Unsupported value: 'reasoning_effort' does not support '" + level
      + "' with this model. Supported values are: 'low', 'medium', and 'high'.", type: 'invalid_request_error', param: 'reasoning_effort', code: 'unsupported_value' } }), { status: 400, headers: { 'Content-Type': 'application/json' } }) : null;
    const mini = endpoint(() => ({ data: [{ id: 'gpt-5-mini' }] }), refusing('minimal'));
    const healMini = (await build({ provider: 'openai', opts: { baseUrl: 'https://heal-mini.openai.test/v1' } }, 'minimal', mini)).p;
    await send(healMini, Object.assign({ model: 'gpt-5-mini' }, TASK));
    A.eq(mini.bodies.map(b => b.reasoning_effort), ['minimal', 'low'], 'openai heal fixture: minimal refused, resent at low');
    A.eq(healMini.effortAsSent('gpt-5-mini', undefined, TASK), 'low', 'openai: the record names the low the resend carried, never the refused minimal');
    const off = endpoint(() => ({ data: [{ id: 'gpt-5.2' }] }), refusing('none'));
    const healOff = (await build({ provider: 'openai', opts: { baseUrl: 'https://heal-off.openai.test/v1' } }, 'none', off)).p;
    await send(healOff, Object.assign({ model: 'gpt-5.2' }, TASK));
    A.eq(off.bodies.map(b => b.reasoning_effort || null), ['none', null], 'openai heal fixture: none refused, resent without the param (the model default)');
    A.eq(healOff.effortAsSent('gpt-5.2', undefined, TASK), null, 'openai: so the record names no effort, never the refused none');
  }
  {
    // the first call on an endpoint whose catalog had not loaded yet went out without the declared OFF; it says so
    const { p, ep } = await build({ provider: 'deepseek', catalog: dsCatalog, warm: false, opts: { baseUrl: 'https://cold.deepseek.test' } }, 'none');
    await send(p, Object.assign({ model: 'deepseek-v4' }, TASK));
    const wire = WIRE.chat(ep.bodies[0] || {});
    A.eq(p.effortAsSent('deepseek-v4', undefined, TASK), wire, 'deepseek: a call made before the catalog warmed is recorded as it went (' + JSON.stringify(wire) + ')');
  }

  // ---- native Ollama: think:false for OFF and for a background call that chose no effort; think:true names no level.
  //      Whether a model thinks is learned from /api/show on its first request, so only the record of a call made is held ----
  n += await matrix('ollama qwen3', { provider: 'ollama', model: 'qwen3:8b', wire: 'ollama', catalog: () => ({ data: [] }),
    shapes: [TASK, { isTask: false }, {}], predict: false });

  A.ok(n > 900, 'the matrix ran (' + n + ' request/record pairs)');
  A.report('effort-as-sent.test');
})().catch(e => { console.log('FAIL: effort-as-sent.test threw - ' + (e && e.stack || e)); process.exit(1); });
