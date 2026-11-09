/* node test/openrouter-effort-heal.test.js — an OpenRouter reasoning-effort REFUSAL heals instead of failing the call.

   Why: OpenRouter's /models never states which reasoning levels a model takes, so the adapter guesses the whole ladder
   (none..max) for every reasoning model. Many refuse a rung on it — measured live 10-14 with the real key:
     • gpt-5-mini, gemini-2.5-pro, deepseek-r1, claude-sonnet-5.5, claude-opus-5.5, gemini-3.8-flash, grok-4.7 and
       glm-5.3-flash answer effort 'none' with HTTP 400 "Reasoning is mandatory for this endpoint and cannot be disabled."
       Each took 'minimal'.
     • o4-mini answers 'none' and 'minimal' with HTTP 400 "Provider returned error"; the provider's own sentence sits in
       error.metadata.raw: "Unsupported value: 'none' is not supported with the 'o4-mini-2025-04-16' model. Supported
       values are: 'low', 'medium', and 'high'." It took 'low'.
   The station's self-talk and post-run learning passes ask for the LOWEST rung (AuxGovernor.pickAuxEffort), so without
   this heal they all failed on those models: the WAKE preflight, session titles, ideas, goal plans, reflection, study.

   Laws under test (the real adapter, a fake fetch):
     • a 'mandatory' refusal of 'none' resends ONCE at the next rung the model keeps and the call completes;
     • a provider refusal that names the supported values learns exactly that list and resends at the nearest rung;
     • what was learned outlives the provider instance (a run builds a fresh one), so the next call goes straight to an
       accepted rung, and reasoningEfforts() — what pickAuxEffort reads — stops offering the refused rung;
     • the record of a healed call (effortAsSent, what every run record and ledger row names) is the rung the resend
       carried, never the refused one;
     • a model that takes 'none' is untouched, and a Commander's own effort is untouched;
     • an unrelated 400 is not retried (one request, the honest error);
     • the learned list is per endpoint (another base URL still guesses). */
'use strict';
const A = require('./_assert.js');
const { makeOpenRouterProvider } = require('../sidecar/providers/openrouter.js');
const G = require('../sidecar/auxgovernor.js');

const OK_SSE = ['data: ' + JSON.stringify({ choices: [{ delta: { content: 'OK' } }] }),
  'data: ' + JSON.stringify({ choices: [{ finish_reason: 'stop', delta: {} }] }), 'data: [DONE]', ''].join('\n');
const MANDATORY = { error: { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.', code: 400, metadata: { provider_name: null } } };
const providerRaw = v => JSON.stringify({ error: { message: "Unsupported value: '" + v + "' is not supported with the 'o4-mini-2025-04-16' model. Supported values are: 'low', 'medium', and 'high'.",
  type: 'invalid_request_error', param: 'reasoning.effort', code: 'unsupported_value' } }, null, 2);
const UNSUPPORTED = v => ({ error: { message: 'Provider returned error', code: 400, metadata: { raw: providerRaw(v), provider_name: 'OpenAI', is_byok: false, provider_error_code: 'unsupported_value' } } });
const UNRELATED = { error: { message: 'messages: at least one message is required', code: 400 } };

const calls = [];
async function fakeFetch(url, opts) {
  if (url.indexOf('/models') >= 0) {
    return new Response(JSON.stringify({ data: ['openai/gpt-5-mini', 'openai/o4-mini', 'anthropic/claude-haiku-4.5', 'openai/broken']
      .map(id => ({ id, supported_parameters: ['tools', 'reasoning'] })) }), { status: 200 });
  }
  const body = JSON.parse(opts.body);
  calls.push({ url, model: body.model, effort: body.reasoning ? body.reasoning.effort : null });
  const e = body.reasoning && body.reasoning.effort;
  let refusal = null;
  if (body.model === 'openai/gpt-5-mini' && e === 'none') refusal = MANDATORY;
  if (body.model === 'openai/o4-mini' && (e === 'none' || e === 'minimal')) refusal = UNSUPPORTED(e);
  if (body.model === 'openai/broken') refusal = UNRELATED;
  if (refusal) return new Response(JSON.stringify(refusal), { status: 400, headers: { 'Content-Type': 'application/json' } });
  return new Response(OK_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
async function run(p, req) {
  const out = { text: '', threw: null };
  try { for await (const ev of p.stream(Object.assign({ messages: [{ role: 'user', content: 'Reply with exactly: OK' }] }, req))) if (ev.type === 'text') out.text += ev.delta; }
  catch (e) { out.threw = e; }
  return out;
}
const fresh = (o) => makeOpenRouterProvider(Object.assign({ fetch: fakeFetch, key: 'k' }, o || {}));

(async () => {
  await fresh().listModels();   // warm the shared catalog: every model here is reasoning-capable, so the guessed ladder applies

  // ---- the guess this test exists for: every reasoning model is offered 'none' (no declaration on OpenRouter) ----
  A.eq(G.pickAuxEffort(fresh().reasoningEfforts('openai/gpt-5-mini')), 'none', 'unlearned, the aux pick on gpt-5-mini is the guessed none');

  // ---- 'Reasoning is mandatory' -> resend once at the next rung, and learn it ----
  {
    calls.length = 0;
    A.eq(fresh().effortAsSent('openai/gpt-5-mini', 'none'), 'none', 'unlearned, a call asking none would carry none');
    const healed = fresh();
    const r = await run(healed, { model: 'openai/gpt-5-mini', reasoningEffort: 'none' });
    A.ok(!r.threw, 'a mandatory-reasoning refusal does not fail the call (' + (r.threw && r.threw.message) + ')');
    A.eq(r.text, 'OK', 'the call completes with the reply');
    A.eq(calls.map(c => c.effort), ['none', 'minimal'], 'one refused none, then one resend at minimal');
    A.eq(healed.effortAsSent('openai/gpt-5-mini', 'none'), 'minimal', 'its record names the minimal the resend carried, never the refused none');
    A.eq(fresh().effortAsSent('openai/gpt-5-mini', 'none'), 'minimal', 'and the next call asking none is predicted at minimal (what was learned)');
    const learned = fresh().reasoningEfforts('openai/gpt-5-mini');
    A.ok(learned.indexOf('none') < 0 && learned.indexOf('minimal') >= 0, 'a fresh instance no longer offers none (' + JSON.stringify(learned) + ')');
    A.eq(G.pickAuxEffort(learned), 'minimal', 'so the aux pick becomes minimal');
    calls.length = 0;
    const again = await run(fresh(), { model: 'openai/gpt-5-mini', reasoningEffort: 'none' });
    A.eq(again.text, 'OK', 'the next run on the model completes');
    A.eq(calls.map(c => c.effort), ['minimal'], 'and goes straight to minimal (no second refusal)');
  }

  // ---- a provider refusal naming the supported values -> learn that exact list ----
  {
    calls.length = 0;
    const healed = fresh();
    const r = await run(healed, { model: 'openai/o4-mini', reasoningEffort: 'none' });
    A.ok(!r.threw, 'a provider unsupported-value refusal does not fail the call (' + (r.threw && r.threw.message) + ')');
    A.eq(r.text, 'OK', 'the o4-mini call completes');
    A.eq(calls.map(c => c.effort), ['none', 'low'], 'the named list is learned in one step: none refused, resent at low (never minimal)');
    A.eq(healed.effortAsSent('openai/o4-mini', 'none'), 'low', 'its record names the low the resend carried');
    A.eq(fresh().reasoningEfforts('openai/o4-mini'), ['low', 'medium', 'high'], 'reasoningEfforts is exactly what the provider named');
    A.eq(G.pickAuxEffort(fresh().reasoningEfforts('openai/o4-mini')), 'low', 'the aux pick becomes low');
  }

  // ---- a model that takes none, and the Commander's own effort, are untouched ----
  {
    calls.length = 0;
    const r = await run(fresh(), { model: 'anthropic/claude-haiku-4.5', reasoningEffort: 'none' });
    A.eq(r.text, 'OK', 'haiku at none completes');
    A.eq(calls.map(c => c.effort), ['none'], 'haiku is sent none once (nothing to heal)');
    A.eq(G.pickAuxEffort(fresh().reasoningEfforts('anthropic/claude-haiku-4.5')), 'none', 'and keeps none as its aux pick');
    calls.length = 0;
    const commander = fresh({ reasoningEffort: 'medium' });
    await run(commander, { model: 'openai/gpt-5-mini' });
    A.eq(calls.map(c => c.effort), ['medium'], 'a Commander run at medium is sent medium');
    A.eq(commander.effortAsSent('openai/gpt-5-mini'), 'medium', 'and its record names medium');
  }

  // ---- an unrelated 400 is not retried ----
  {
    calls.length = 0;
    const r = await run(fresh(), { model: 'openai/broken', reasoningEffort: 'none' });
    A.ok(r.threw && /400/.test(r.threw.message), 'an unrelated 400 still fails honestly');
    A.eq(calls.length, 1, 'and is sent exactly once');
    A.ok(fresh().reasoningEfforts('openai/broken').indexOf('none') >= 0, 'and teaches nothing about efforts');
  }

  // ---- learned per endpoint ----
  A.ok(fresh({ baseUrl: 'http://127.0.0.1:9/api/v1' }).reasoningEfforts('openai/gpt-5-mini').indexOf('none') >= 0,
    'another base URL still guesses (what one endpoint refused says nothing about another)');

  A.report('openrouter-effort-heal.test');
})().catch(e => { console.log('FAIL: openrouter-effort-heal.test threw - ' + (e && e.stack || e)); process.exit(1); });
