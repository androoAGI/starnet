/* node test/run-wire.unit.test.js — the ONE {provider, model} decision (sidecar/run-wire.js, run-wire-resolver lane).

   Proves the pair precedence (explicit > agent pin > station default > host fallbacks > env > honest refusal), that
   half a pair resolves deterministically (a bare model borrows the provider of the next level down; a provider with no
   model is not a pin and is reported in `ignored`; a crew row's stale provider stamp lends nothing), that the Overseer's
   own pin is the station default, THE ONE REASONING-EFFORT RULE (the run's own > the agent's own > the station's when
   following > the provider default), and the stored pair normaliser (pairSavedWire) the routine migration runs: it
   clears a provider that names no model, and never drops, invents or stamps anything else. */
'use strict';
const A = require('./_assert.js');
const W = require('../sidecar/run-wire.js');
const { resolveRunWire, pairSavedWire } = W;

const hero = { model: 'gpt-5.5', provider: 'codex', reasoningEffort: 'high' };
const env = { provider: 'openrouter', model: 'env/model' };
const pick = w => [w.ok, w.provider, w.model, w.source, w.providerSource, w.followsStation];

// ---- 1. precedence ----
A.eq(pick(resolveRunWire({ agentId: 'scout', explicit: { provider: 'openrouter', model: 'x/y' }, agent: { model: 'a/b', provider: 'anthropic' }, hero, env })),
  [true, 'openrouter', 'x/y', 'explicit', 'explicit', false], 'an explicit pair beats everything');
A.eq(pick(resolveRunWire({ agentId: 'scout', agent: { model: 'a/b', provider: 'anthropic' }, hero, env })),
  [true, 'anthropic', 'a/b', 'agent', 'agent', false], "an agent's own pin beats the station default");
A.eq(pick(resolveRunWire({ agentId: 'scout', agent: { model: '', provider: '' }, hero, env })),
  [true, 'codex', 'gpt-5.5', 'station', 'station', true], 'an unpinned agent follows the station default (the Overseer)');
A.eq(resolveRunWire({ agentId: 'scout', agent: {}, hero, env }).reasoningEffort, 'high', "...and the Overseer's effort rides with its model");
A.eq(pick(resolveRunWire({ agentId: 'tg_123', agent: null, hero, env })),
  [true, 'codex', 'gpt-5.5', 'station', 'station', true], 'an id that is not on the roster is unpinned: the station default');
A.eq(pick(resolveRunWire({ agentId: 'scout', agent: {}, hero: null, fallbacks: [{ source: 'connect', provider: 'openrouter', model: 'conn/m' }], env })),
  [true, 'openrouter', 'conn/m', 'connect', 'connect', false], 'a host fallback sits below the station default and above env');
A.eq(pick(resolveRunWire({ agentId: 'scout', agent: {}, hero, fallbacks: [{ source: 'connect', provider: 'openrouter', model: 'conn/m' }], env })),
  [true, 'codex', 'gpt-5.5', 'station', 'station', true], '...so a live station default beats a connect-time snapshot');
A.eq(pick(resolveRunWire({ agentId: 'scout', agent: {}, hero: {}, env })),
  [true, 'openrouter', 'env/model', 'env', 'env', false], 'no pin and no station default: the environment rule');
{
  const none = resolveRunWire({ agentId: 'scout', agent: {}, hero: { provider: 'codex' }, env: { provider: 'openrouter', model: '' } });
  A.eq([none.ok, none.model, none.source, none.provider], [false, '', 'none', 'codex'], 'no model anywhere: an honest refusal that still names the provider');
  A.ok(/no model is configured/.test(none.error) && /scout/.test(none.error), 'the refusal says what is missing: ' + none.error);
}

// ---- 2. the Overseer's own pin IS the station default ----
A.eq(pick(resolveRunWire({ agentId: 'agent', agent: hero, hero, env })), [true, 'codex', 'gpt-5.5', 'agent', 'agent', false], "the Overseer runs its own pin (source 'agent', not following)");
A.eq(pick(resolveRunWire({ agentId: '', hero, env })), [true, 'codex', 'gpt-5.5', 'agent', 'agent', false], "an empty agent id is the Overseer");
{
  const bare = resolveRunWire({ agentId: 'agent', hero: { provider: 'codex' }, env });
  A.eq(pick(bare), [true, 'openrouter', 'env/model', 'env', 'env', false],
    'an Overseer with a provider but no model runs the env PAIR (its own provider), never the env model on another provider');
  A.eq(bare.ignored.map(x => x.provider), ['codex'], '...and the provider it passed over is reported');
}

// ---- 3. half a pair, deterministically ----
{
  const m = resolveRunWire({ agentId: 'scout', agent: { model: 'bare/model', provider: '' }, hero, env });
  A.eq(pick(m), [true, 'codex', 'bare/model', 'agent', 'station', false], "a bare model pin borrows the station's provider (the page's focusWire rule)");
  const r = resolveRunWire({ agentId: 'scout', explicit: { source: 'routine', model: 'routine/model' }, agent: { model: 'a/b', provider: 'anthropic' }, hero, env });
  A.eq(pick(r), [true, 'anthropic', 'routine/model', 'routine', 'agent', false], "a routine's bare model borrows its agent's provider");
  const p = resolveRunWire({ agentId: 'scout', explicit: { source: 'routine', provider: 'openrouter' }, agent: {}, hero, env });
  A.eq(pick(p), [true, 'codex', 'gpt-5.5', 'station', 'station', true], 'a provider with no model is not a pin: the run follows its agent');
  A.eq(p.ignored, [{ source: 'routine', provider: 'openrouter', reason: 'a provider without a model is not a pin' }], '...and the passed-over provider is reported, never silently dropped');
  const same = resolveRunWire({ agentId: 'scout', explicit: { source: 'routine', provider: 'codex' }, agent: {}, hero, env });
  A.eq(same.ignored, [], 'a provider-only level that agrees with the run is not noise');
  const stale = resolveRunWire({ agentId: 'scout', agent: { model: '', provider: 'openrouter' }, hero, env });
  A.eq(pick(stale), [true, 'codex', 'gpt-5.5', 'station', 'station', true], "an unpinned row with a stale stamped provider still follows the station (issue #24)");
  const env2 = resolveRunWire({ agentId: 'scout', agent: { model: 'bare/model' }, hero: {}, env });
  A.eq([env2.provider, env2.providerSource], ['openrouter', 'env'], 'with no station provider, a bare model borrows the env provider');
  // a CREW row's provider with no model (an older page's stamp) lends nothing to a bare model above it: a routine's, a
  // loop's, an /api/run body's or a CLI --model run on the station's provider, never on the stamp's
  const lend = resolveRunWire({ agentId: 'scout', explicit: { source: 'routine', model: 'routine/model' }, agent: { model: '', provider: 'openrouter' }, hero, env });
  A.eq(pick(lend), [true, 'codex', 'routine/model', 'routine', 'station', false], "a stale stamped crew row does not lend its provider to a bare model");
  A.eq(lend.ignored, [{ source: 'agent', provider: 'openrouter', reason: 'a provider without a model is not a pin' }], '...and the stamp it passed over is reported');
  const lendPinned = resolveRunWire({ agentId: 'scout', explicit: { model: 'x/y' }, agent: { model: 'a/b', provider: 'anthropic' }, hero, env });
  A.eq([lendPinned.provider, lendPinned.providerSource], ['anthropic', 'agent'], "a crew row that pins a WHOLE pair still lends its provider");
  const lendHero = resolveRunWire({ agentId: 'agent', explicit: { model: 'x/y' }, hero: { model: '', provider: 'codex' }, env });
  A.eq([lendHero.provider, lendHero.providerSource], ['codex', 'agent'], "the Overseer's provider alone is the station's provider: it lends");
  const lendStation = resolveRunWire({ agentId: 'scout', explicit: { model: 'x/y' }, agent: { provider: 'openrouter' }, hero: { provider: 'codex' }, env });
  A.eq([lendStation.provider, lendStation.providerSource], ['codex', 'station'], "...and so does it for a crew member's bare model");
}

// ---- 4. provider normalisation is the host's ----
{
  const norm = p => ({ 'openai-codex': 'codex', codex: 'codex', openrouter: 'openrouter' })[String(p).toLowerCase()] || '';
  const w = resolveRunWire({ agentId: 'scout', agent: { model: 'm', provider: 'OpenAI-Codex' }, hero, env, normalizeProvider: norm });
  A.eq([w.provider, w.model], ['codex', 'm'], 'aliases resolve through the host normaliser');
  const unknown = resolveRunWire({ agentId: 'scout', agent: { model: 'm', provider: 'not-a-provider' }, hero, env, normalizeProvider: norm });
  A.eq([unknown.provider, unknown.providerSource], ['codex', 'station'], 'an unknown provider id on a roster row is no provider: the next level lends one');
  A.eq(unknown.ignored, [{ source: 'agent', provider: 'not-a-provider', reason: 'unknown provider' }], '...and the id it did not know is reported, never silent');
  // an EXPLICIT model on a provider the host does not know (a typo'd STARNET_V1_PROVIDER, a routine saved on a dropped
  // provider, a caller's run option) is refused: borrowing would send it, and another provider's credential, elsewhere
  for (const source of ['env', 'routine', 'explicit']) {
    const typo = resolveRunWire({ agentId: 'api-x', explicit: { source, provider: 'olama', model: 'llama3' }, agent: null, hero, env, normalizeProvider: norm });
    A.eq([typo.ok, typo.provider, typo.model, typo.source], [false, '', '', 'none'], "an explicit '" + source + "' model on an unknown provider is refused, never re-homed on the station's");
    A.ok(/"olama"/.test(typo.error || '') && /not a provider this station knows/.test(typo.error || ''), '...and the refusal names the id: ' + typo.error);
    A.eq(typo.ignored, [{ source, provider: 'olama', reason: 'unknown provider' }], '...and reports it');
  }
  const bareTypo = resolveRunWire({ agentId: 'scout', explicit: { source: 'routine', provider: 'olama' }, agent: {}, hero, env, normalizeProvider: norm });
  A.eq(pick(bareTypo), [true, 'codex', 'gpt-5.5', 'station', 'station', true], 'an unknown provider with no model names no pin: the run follows its agent');
  A.eq(bareTypo.ignored, [{ source: 'routine', provider: 'olama', reason: 'unknown provider' }], '...and the id it passed over is reported');
  const known = resolveRunWire({ agentId: 'api-x', explicit: { source: 'env', provider: 'OpenAI-Codex', model: 'm' }, agent: null, hero, env, normalizeProvider: norm });
  A.eq([known.ok, known.provider, known.ignored], [true, 'codex', []], 'a known alias at the explicit level runs as usual');
}

// ---- 5. deterministic: same inputs, same wire ----
{
  const input = { agentId: 'scout', explicit: { source: 'routine', model: 'r/m' }, agent: { model: '', provider: 'openrouter' }, hero, env };
  A.eq(resolveRunWire(input), resolveRunWire(JSON.parse(JSON.stringify(input))), 'the same inputs give the same wire');
}

// ---- 6. the stored-pair normaliser (routine migration) ----
{
  A.eq(pairSavedWire({ provider: 'openrouter', model: 'x/y' }), { provider: 'openrouter', model: 'x/y', changed: false, reason: '' }, 'a whole pair is left as it is');
  A.eq(pairSavedWire({ provider: null, model: null }), { provider: null, model: null, changed: false, reason: '' }, 'no pair at all is left as it is (it follows its agent)');
  A.eq(pairSavedWire({ provider: null, model: 'r/model' }), { provider: null, model: 'r/model', changed: false, reason: '' },
    'a bare saved model is left as it is: no provider is stamped on it, the run-time rule borrows one');
  const p = pairSavedWire({ provider: 'openrouter', model: '' });
  A.eq([p.provider, p.model, p.changed], [null, null, true], 'a saved provider with no model is cleared: it never pinned anything');
  A.ok(/openrouter/.test(p.reason), 'the note names the cleared provider (the caller keeps it on the record): ' + p.reason);
  // a bare saved model FOLLOWS a station provider switch, as it did before the lane
  const ranOn = h => { const w = resolveRunWire({ agentId: 'scout', explicit: { source: 'routine', provider: '', model: 'r/model' }, agent: {}, hero: h, env }); return [w.provider, w.model]; };
  A.eq(ranOn({ model: 'gpt-5.5', provider: 'codex' }), ['codex', 'r/model'], 'the bare routine model runs on the station provider');
  A.eq(ranOn({ model: 'gpt-5.5', provider: 'starnet' }), ['starnet', 'r/model'], '...and on the new one after the station switches provider');
}

// ---- 7. THE ONE REASONING-EFFORT RULE ----
{
  const eff = (input) => resolveRunWire(Object.assign({ env }, input)).reasoningEffort;
  A.eq(eff({ agentId: 'scout', explicit: { reasoningEffort: 'xhigh' }, agent: { model: 'a/b', provider: 'anthropic', reasoningEffort: 'low' }, hero }), 'xhigh', "1. the run's own per-run effort wins");
  A.eq(eff({ agentId: 'scout', explicit: { provider: 'codex', model: 'gpt-5.5', reasoningEffort: 'minimal' }, agent: {}, hero }), 'minimal', '...even over the station default for a follower');
  A.eq(eff({ agentId: 'scout', agent: { model: 'a/b', provider: 'anthropic', reasoningEffort: 'low' }, hero }), 'low', "2. a pinned agent runs its pin's effort");
  A.eq(eff({ agentId: 'scout', agent: { model: '', reasoningEffort: 'low' }, hero }), 'low', "2. an unpinned agent's own class effort beats the station's");
  A.eq(eff({ agentId: 'scout', agent: {}, hero }), 'high', "3. a follower with no effort of its own runs the Overseer's");
  A.eq(eff({ agentId: 'tg_1', agent: null, hero }), 'high', '...and so does an unrostered id');
  A.eq(eff({ agentId: 'scout', agent: { model: 'a/b', provider: 'anthropic' }, hero }), undefined, "a PINNED agent with no effort never borrows the Overseer's: the provider default");
  A.eq(eff({ agentId: 'scout', agent: { model: 'bare/m' }, hero }), undefined, '...nor does a bare-model pin that only borrows its provider');
  A.eq(eff({ agentId: 'scout', explicit: { source: 'routine', model: 'r/m' }, agent: {}, hero }), undefined, "a routine's own model is not following the station: the provider default");
  A.eq(eff({ agentId: 'scout', explicit: { source: 'routine', model: 'r/m' }, agent: { reasoningEffort: 'low' }, hero }), 'low', "...and its agent's own effort rides it");
  A.eq(eff({ agentId: 'scout', explicit: { source: 'station', provider: 'codex', model: 'gpt-5.5' }, agent: {}, hero }), 'high', "a caller labelled 'station' with no effort keeps the Overseer's");
  A.eq(eff({ agentId: 'agent', hero }), 'high', "the Overseer runs its own effort");
  A.eq(eff({ agentId: 'scout', agent: {}, hero: null, fallbacks: [{ source: 'connect', provider: 'openrouter', model: 'conn/m', reasoningEffort: 'low' }] }), 'low', "4. a roster-less station's connect-time choice keeps its effort");
  A.eq(eff({ agentId: 'scout', agent: {}, hero, fallbacks: [{ source: 'connect', provider: 'openrouter', model: 'conn/m', reasoningEffort: 'low' }] }), 'high', '...but a fallback that did not choose the pair lends no effort');
  A.eq(eff({ agentId: 'scout', agent: {}, hero: {} }), undefined, '5. nothing names one: the provider default');
}

A.report('run-wire: one {provider, model} decision');
