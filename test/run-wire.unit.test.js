/* node test/run-wire.unit.test.js — the ONE {provider, model} decision (sidecar/run-wire.js, run-wire-resolver lane).

   Proves the pair precedence (explicit > agent pin > station default > host fallbacks > env > honest refusal), that
   half a pair resolves deterministically (a bare model borrows the provider of the next level down; a provider with no
   model is not a pin and is reported in `ignored`), that the Overseer's own pin is the station default, and the stored
   pair normaliser (pairSavedWire) the routine migration runs: it never drops a saved model and never invents one. */
'use strict';
const A = require('./_assert.js');
const W = require('../sidecar/run-wire.js');
const { resolveRunWire, pairSavedWire, describeRunWire } = W;

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
}

// ---- 4. provider normalisation is the host's ----
{
  const norm = p => ({ 'openai-codex': 'codex', codex: 'codex', openrouter: 'openrouter' })[String(p).toLowerCase()] || '';
  const w = resolveRunWire({ agentId: 'scout', agent: { model: 'm', provider: 'OpenAI-Codex' }, hero, env, normalizeProvider: norm });
  A.eq([w.provider, w.model], ['codex', 'm'], 'aliases resolve through the host normaliser');
  const unknown = resolveRunWire({ agentId: 'scout', agent: { model: 'm', provider: 'not-a-provider' }, hero, env, normalizeProvider: norm });
  A.eq([unknown.provider, unknown.providerSource], ['codex', 'station'], 'an unknown provider id is no provider: the next level lends one');
}

// ---- 5. deterministic: same inputs, same wire ----
{
  const input = { agentId: 'scout', explicit: { source: 'routine', model: 'r/m' }, agent: { model: '', provider: 'openrouter' }, hero, env };
  A.eq(resolveRunWire(input), resolveRunWire(JSON.parse(JSON.stringify(input))), 'the same inputs give the same wire');
}

// ---- 6. the stored-pair normaliser (routine migration) ----
{
  const inherited = resolveRunWire({ agentId: 'scout', agent: {}, hero, env });
  A.eq(pairSavedWire({ provider: 'openrouter', model: 'x/y' }, inherited), { provider: 'openrouter', model: 'x/y', changed: false, reason: '' }, 'a whole pair is left as it is');
  A.eq(pairSavedWire({ provider: null, model: null }, inherited), { provider: null, model: null, changed: false, reason: '' }, 'no pair at all is left as it is (it follows its agent)');
  const m = pairSavedWire({ provider: null, model: 'r/model' }, inherited);
  A.eq([m.provider, m.model, m.changed], ['codex', 'r/model', true], 'a bare saved model is paired with the provider it ran on; the model is kept');
  A.ok(/the station default/.test(m.reason), 'the note says where the provider came from: ' + m.reason);
  const p = pairSavedWire({ provider: 'openrouter', model: '' }, inherited);
  A.eq([p.provider, p.model, p.changed], [null, null, true], 'a saved provider with no model is cleared: it never pinned anything');
  A.ok(/openrouter/.test(p.reason), 'the note names the cleared provider (the caller keeps it on the record): ' + p.reason);
  A.eq(pairSavedWire({ model: 'r/model' }, { ok: false, provider: '' }), { provider: null, model: 'r/model', changed: false, reason: '' },
    'nothing to pair a bare model with yet: left for the run-time rule, never guessed');
  // the migrated record resolves to the SAME tuple it ran before migration
  const before = resolveRunWire({ agentId: 'scout', explicit: { source: 'routine', model: 'r/model' }, agent: {}, hero, env });
  const after = resolveRunWire({ agentId: 'scout', explicit: { source: 'routine', provider: m.provider, model: m.model }, agent: {}, hero, env });
  A.eq([after.provider, after.model], [before.provider, before.model], 'pairing a bare model keeps the tuple the routine already ran');
}

// ---- 7. the readout sentence ----
A.eq(describeRunWire(resolveRunWire({ agentId: 'scout', agent: {}, hero, env })), 'codex / gpt-5.5 (the station default (the Overseer))', 'the readout names the pair and its source');
A.ok(/provider from the station default/.test(describeRunWire(resolveRunWire({ agentId: 'scout', agent: { model: 'bare/m' }, hero, env }))), 'a borrowed provider is named');
A.eq(describeRunWire({ ok: false, provider: 'codex' }), 'no model configured (codex)', 'a refusal reads as one');

A.report('run-wire: one {provider, model} decision');
