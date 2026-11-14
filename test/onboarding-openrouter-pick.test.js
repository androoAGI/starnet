'use strict';
/* node test/onboarding-openrouter-pick.test.js — OPENROUTER'S PRESELECTED MODEL FOLLOWS THE CATALOG (cost audit W3.11, 2026-11-14).

   A provider's first curated pick (frontend/app/app.js MODEL_PICKS) is the model a new Commander's empty field is filled
   with. OpenRouter's stayed anthropic/claude-opus-4.8 ($5 / $25 per million tokens) after OpenRouter listed
   anthropic/claude-opus-5.5: the same "deepest" tier, the current generation, $4 / $20. The lowest-risk part of W3.11, and
   the only part taken: that one pick moves to Opus 5.5 ONLY when the live catalog the page just loaded lists it.

   A. THE RULE (app.js modelPicksFor, compiled out of the page source): OpenRouter + a live catalog that lists the exact id
      -> the first pick is Opus 5.5, still tagged deepest, the other picks untouched; a catalog without it, an empty one,
      no catalog, or the offline seed (rows marked fallback) -> the curated list itself; every other provider -> its
      curated list itself, whatever its catalog lists.
   B. EVERY PROVIDER'S FIRST PICK IS LOCKED (a default never moves by accident), and no pick anywhere changed tier.
   C. THE PAGE (the real loadModels / buildModelPicks / syncModelPicks, compiled out of app.js and run on a fake
      document): the empty field is filled with Opus 5.5 when the catalog lists it and with Opus 4.8 when it does not or is
      offline; the chip row is drawn from the same picks, so the chip marked "deepest" is the model that was filled in; a
      model already in the field is never replaced; StarNet credit, OpenAI, Anthropic, Gemini and the Claude CLI get the
      model they got before, even when their catalog lists Opus 5.5.
   D. one rule, two readers; the website mirror is the same bytes.
   RED on the base (agent/cand-0152 57c741da7): there is no modelPicksFor, and a catalog that lists Opus 5.5 still
   fills the field with Opus 4.8. */
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const { decomment } = require('./helpers/decomment.js');
const { functionSourceIn } = require('./helpers/source.js');
const registry = require('../frontend/app/provider-registry.js');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'frontend/app/app.js'), 'utf8');
const WAS = 'anthropic/claude-opus-4.8';
const NOW = 'anthropic/claude-opus-5.5';

const block = (re, what) => { const m = app.match(re); A.ok(!!m, 'app.js declares ' + what); return m ? m[0] : ''; };
const picksSrc = block(/const MODEL_PICKS = Object\.freeze\(\{[\s\S]*?\n  \}\);/, 'MODEL_PICKS');
const fallbackSrc = block(/const FALLBACK_MODELS = Object\.freeze\(\{[\s\S]*?\n  \}\);/, 'FALLBACK_MODELS');
const wasSrc = (app.match(/const OPENROUTER_DEEPEST_WAS = [^;\n]*;/) || [''])[0];
const nowSrc = (app.match(/const OPENROUTER_DEEPEST_NOW = Object\.freeze\(\{[^}\n]*\}\);/) || [''])[0];
const ruleSrc = functionSourceIn(app, 'modelPicksFor');
A.ok(!!wasSrc && !!nowSrc && ruleSrc.length > 100 && ruleSrc.length < 900, 'app.js declares the rule (modelPicksFor) and the two ids it knows');

/* The page's own code, on a fake document. catalogs: provider -> the list Harness.listModels answers ([] = offline). */
function page(catalogs, o) {
  const els = {
    'in-model': { value: (o && o.field) || '', placeholder: 'loading models…' },
    'model-count': { textContent: '' }, 'model-hint': { textContent: '' },
    'model-picks': { children: [], set innerHTML(_) { this.children = []; }, appendChild(c) { this.children.push(c); } }
  };
  const node = () => ({ dataset: {}, children: [], _cls: new Set(), type: '', className: '', title: '', textContent: '',
    appendChild(c) { this.children.push(c); },
    classList: null });
  const env = {
    el: id => els[id] || null,
    Harness: { listModels: async p => (catalogs[p] || []).slice() },
    normalizeProviderId: p => registry.normalizeProviderId(p || 'openrouter', ''),
    isOAuthProviderId: p => { const prof = registry.getProviderProfile(p); return !!(prof && prof.authType === 'oauth_device_code'); },
    refusedPageLine: () => '', renderModelPop: () => {}, SFX: { click() {} }, window: {},
    document: {
      createElement: () => { const n = node(); n.classList = { toggle: (c, on) => { if (on) n._cls.add(c); else n._cls.delete(c); }, contains: c => n._cls.has(c) }; return n; },
      createTextNode: t => ({ text: String(t) })
    }
  };
  const src = [
    'const { el, Harness, normalizeProviderId, isOAuthProviderId, refusedPageLine, renderModelPop, SFX, window, document } = env;',
    'let pickedProvider = env.picked; let genesisModels = []; let genesisOffline = false;',
    'const updateHint = () => syncModelPicks();',   // the page's updateHint ends by syncing the chip highlight
    fallbackSrc, picksSrc, wasSrc, nowSrc, ruleSrc,
    functionSourceIn(app, 'defaultModelFor'), functionSourceIn(app, 'loadModels'), functionSourceIn(app, 'buildModelPicks'), functionSourceIn(app, 'syncModelPicks'),
    'return { loadModels, buildModelPicks, pick(p) { pickedProvider = p; }, state: () => ({ genesisModels, genesisOffline }),'
      + ' MODEL_PICKS, FALLBACK_MODELS, rule: typeof modelPicksFor === "function" ? modelPicksFor : null };'
  ].join('\n');
  env.picked = (o && o.provider) || 'openrouter';
  const api = new Function('env', src)(env);   // eslint-disable-line no-new-func
  const chips = () => els['model-picks'].children.map(b => ({
    id: b.dataset.id, label: b.children.map(c => c.text != null ? c.text : c.textContent).join(''), sel: b._cls.has('sel'), title: b.title }));
  return { api, els, chips };
}
const row = (id, extra) => Object.assign({ id, name: id }, extra || {});
const LIVE_WITH = [row('anthropic/claude-opus-4.8'), row(NOW), row('anthropic/claude-sonnet-4.6'), row('openai/gpt-5'), row('google/gemini-2.5-pro')];
const LIVE_WITHOUT = LIVE_WITH.filter(m => m.id !== NOW);
const STATIC_OR = [WAS, 'anthropic/claude-sonnet-4.6', 'openai/gpt-5', 'google/gemini-2.5-pro'];

let base = null;
try { base = page({}); } catch (e) { A.ok(false, 'the page code compiles on the fake document: ' + e.message); }
const rule = base && base.api.rule;
A.ok(typeof rule === 'function', 'app.js declares modelPicksFor');
const PICKS = base ? base.api.MODEL_PICKS : {};

/* ---- A. THE RULE -------------------------------------------------------------------------------------------------------- */
if (rule) {
  const got = rule('openrouter', LIVE_WITH);
  A.eq(got.map(m => m.id), [NOW].concat(STATIC_OR.slice(1)), 'A: OpenRouter + a live catalog that lists Opus 5.5: the first pick is Opus 5.5, the rest unchanged');
  A.eq(got[0], { label: 'Opus 5.5', id: NOW, tag: 'deepest' }, 'A: the same tier: still the pick tagged "deepest"');
  A.ok(got.slice(1).every((m, i) => m === PICKS.openrouter[i + 1]), 'A: the other picks are the curated rows themselves');
  A.eq(PICKS.openrouter.map(m => m.id), STATIC_OR, 'A: the curated list is not edited by the rule');
  for (const [what, catalog] of [['a catalog that does not list it', LIVE_WITHOUT], ['an empty catalog', []], ['no catalog', undefined], ['null', null], ['not a list', { id: NOW }],
    ['the offline seed (fallback rows)', [row(NOW, { fallback: true }), row(WAS, { fallback: true })]],
    ['only a longer id (a batch or dated variant)', [row(NOW + ':batch'), row(NOW + '-20260922'), row('x/' + NOW)]],
    ['a row with no id', [{ name: NOW }, null, undefined]]]) {
    A.ok(rule('openrouter', catalog) === PICKS.openrouter, 'A: OpenRouter + ' + what + ': the curated list itself (Opus 4.8 first)');
  }
  for (const p of Object.keys(PICKS).filter(k => k !== 'openrouter')) {
    A.ok(rule(p, LIVE_WITH) === PICKS[p], 'A: ' + p + ': its curated list itself, even when its catalog lists Opus 5.5');
  }
  A.eq([rule('custom', LIVE_WITH), rule('ollama', LIVE_WITH), rule('claude-cli', LIVE_WITH), rule('codex', LIVE_WITH), rule('', LIVE_WITH)], [[], [], [], [], []],
    'A: a provider with no curated picks has none (custom, Ollama, the Claude CLI, Codex)');
}

/* ---- B. EVERY PROVIDER'S FIRST PICK, LOCKED -------------------------------------------------------------------------- */
{
  const first = {}; for (const p of Object.keys(PICKS)) first[p] = PICKS[p][0] && [PICKS[p][0].id, PICKS[p][0].tag];
  A.eq(first, {
    starnet: ['openai/gpt-5.5', ''], openrouter: [WAS, 'deepest'], openai: ['gpt-5.5', 'deepest'], anthropic: ['claude-sonnet-5-5', 'balanced'],
    gemini: ['gemini-2.5-pro', 'deepest'], xai: ['grok-4.3', ''], groq: ['openai/gpt-oss-120b', 'fast'], mistral: ['mistral-large-latest', ''],
    deepseek: ['deepseek-chat', ''], together: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', ''], fireworks: ['accounts/fireworks/models/deepseek-v3p1', ''],
    perplexity: ['sonar-pro', 'search'], cerebras: ['llama-4-scout-17b-16e-instruct', 'fast']
  }, 'B: every provider\'s curated first pick is the one it was (OpenRouter\'s moves only through the rule)');
  const F = base ? base.api.FALLBACK_MODELS : {};
  A.eq([F['claude-cli'] && F['claude-cli'][0], F.starnet && F.starnet[0], F.openai && F.openai[0], F.anthropic && F.anthropic[0]],
    ['claude-sonnet-5-5', 'openai/gpt-5.5', 'gpt-5.5', 'claude-sonnet-5-5'], 'B: the Claude CLI, StarNet credit, OpenAI and Anthropic fallbacks are the ones they were');
  const dock = fs.readFileSync(path.join(ROOT, 'frontend/app/modeldock.js'), 'utf8');
  A.ok(/const CODEX_MODELS = \['gpt-5\.5', /.test(dock), 'B: the Codex lineup still opens with gpt-5.5');
  // the claim in the comment: the newer model lists lower, at the vendor's own rates as the station's price table holds them
  const prices = require('../sidecar/providers/prices.js');
  const was = prices.priceOf('anthropic', 'claude-opus-4-8'), now = prices.priceOf('anthropic', 'claude-opus-5-5');
  A.ok(!!was && !!now && now.in < was.in && now.out < was.out, 'B: Opus 5.5 lists lower than Opus 4.8 (' + JSON.stringify(now && [now.in, now.out]) + ' vs ' + JSON.stringify(was && [was.in, was.out]) + ' per million)');
}

/* ---- C. THE PAGE -------------------------------------------------------------------------------------------------------- */
(async () => {
  const load = async (catalogs, o) => { const pg = page(catalogs, o); pg.api.buildModelPicks(); await pg.api.loadModels(pg.api_provider || (o && o.provider) || 'openrouter'); return pg; };
  {
    const pg = await load({ openrouter: LIVE_WITH });
    A.eq(pg.els['in-model'].value, NOW, 'C: OpenRouter, the catalog lists Opus 5.5: the empty field is filled with Opus 5.5');
    A.eq(pg.els['in-model'].placeholder, 'search models — e.g. ' + NOW, 'C: ...and the placeholder names it');
    A.eq(pg.chips().map(c => c.id), [NOW].concat(STATIC_OR.slice(1)), 'C: ...the chip row is drawn from the same picks');
    A.eq(pg.chips()[0], { id: NOW, label: 'Opus 5.5 · deepest', sel: true, title: NOW }, 'C: ...the chip marked "deepest" is the model that was filled in, and it is the selected one');
    A.eq(pg.chips().filter(c => c.sel).length, 1, 'C: ...one chip selected');
    A.eq(pg.api.state().genesisOffline, false, 'C: ...a live catalog');
  }
  {
    const pg = await load({ openrouter: LIVE_WITHOUT });
    A.eq(pg.els['in-model'].value, WAS, 'C: OpenRouter, the catalog does not list Opus 5.5: Opus 4.8, as today');
    A.eq(pg.chips().map(c => c.id), STATIC_OR, 'C: ...the chip row is the curated picks');
    A.eq(pg.chips()[0], { id: WAS, label: 'Opus 4.8 · deepest', sel: true, title: WAS }, 'C: ...Opus 4.8 is the deepest chip, selected');
  }
  {
    const pg = await load({ openrouter: [] });
    A.eq(pg.els['in-model'].value, WAS, 'C: OpenRouter, the catalog offline: Opus 4.8, as today');
    A.eq(pg.api.state().genesisOffline, true, 'C: ...and the list is the offline seed');
    A.eq(pg.chips().map(c => c.id), STATIC_OR, 'C: ...the chip row is the curated picks');
    A.ok(pg.api.state().genesisModels.every(m => m.fallback === true && m.id !== NOW), 'C: ...whose seed never names Opus 5.5');
  }
  {
    const pg = await load({ openrouter: LIVE_WITH }, { field: 'openai/gpt-5' });
    A.eq(pg.els['in-model'].value, 'openai/gpt-5', 'C: a model already in the field is never replaced');
    A.eq(pg.chips().filter(c => c.sel).map(c => c.id), ['openai/gpt-5'], 'C: ...and its own chip stays the selected one');
  }
  {
    // the catalog comes and goes: the row and the fill follow it both ways
    const pg = page({ openrouter: LIVE_WITH });
    pg.api.buildModelPicks();
    A.eq(pg.chips().map(c => c.id), STATIC_OR, 'C: before the catalog arrives the row is the curated picks');
    await pg.api.loadModels('openrouter');
    A.eq((pg.chips()[0] || {}).id, NOW, 'C: the catalog arrives: the deepest chip is Opus 5.5');
    // ...and a load that finds the catalog unreachable draws the curated row (no first draw here: loadModels draws it)
    const offline = page({ openrouter: [] });
    await offline.api.loadModels('openrouter');
    A.eq([offline.els['in-model'].value, (offline.chips()[0] || {}).id], [WAS, WAS], 'C: a station whose catalog is unreachable gets Opus 4.8 in the field and on the chip');
  }
  for (const [p, want] of [['starnet', 'openai/gpt-5.5'], ['openai', 'gpt-5.5'], ['anthropic', 'claude-sonnet-5-5'], ['gemini', 'gemini-2.5-pro'], ['claude-cli', 'claude-sonnet-5-5']]) {
    const catalogs = {}; catalogs[p] = LIVE_WITH.concat([row('claude-opus-5-5'), row('openai/gpt-5.5'), row('gpt-5.5'), row('claude-sonnet-5-5'), row('gemini-2.5-pro')]);
    const pg = await load(catalogs, { provider: p });
    A.eq(pg.els['in-model'].value, want, 'C: ' + p + ': the field is filled with ' + want + ', as before (its catalog lists Opus 5.5 too)');
    A.ok(pg.chips().every(c => c.id !== NOW), 'C: ' + p + ': no Opus 5.5 chip appears');
  }

  /* ---- D. ONE RULE, TWO READERS; THE MIRROR ----------------------------------------------------------------------------- */
  const code = decomment(app);
  A.eq((code.match(/MODEL_PICKS\[/g) || []).length, 1, 'D: the curated picks are read in one place, the rule');
  A.eq((code.match(/modelPicksFor\(/g) || []).length, 3, 'D: the rule is declared once and read twice');
  const loadSrc = functionSourceIn(app, 'loadModels'), chipsSrc = functionSourceIn(app, 'buildModelPicks');
  A.ok(/const picks = modelPicksFor\(p, list\);/.test(loadSrc) && /if \(!inp\.value\) inp\.value = defId;/.test(loadSrc), 'D: the prefill reads the rule with the catalog it just loaded, and fills only an empty field');
  A.ok(/buildModelPicks\(list\);/.test(loadSrc), 'D: ...and redraws the chip row from that catalog');
  A.ok(/modelPicksFor\(pickedProvider, catalog\)\.forEach\(/.test(chipsSrc), 'D: the chip row reads the same rule');
  A.ok(!/roster|agent\.model|Harness\.setModel|localStorage/.test(ruleSrc), 'D: the rule reads no saved model and writes nothing');
  const a = fs.readFileSync(path.join(ROOT, 'frontend/app/app.js'));
  const b = (() => { try { return fs.readFileSync(path.join(ROOT, 'website/app/app/app.js')); } catch (_) { return null; } })();
  A.ok(!!b && a.equals(b), 'D: website/app/app/app.js is byte-identical to frontend/app/app.js');
  A.report('onboarding-openrouter-pick.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
