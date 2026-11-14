'use strict';
/* node test/dock-effort-wording.test.js — THE DOCK'S EFFORT TOOLTIP SAYS WHAT IS TRUE (cost audit W3.13, 2026-11-14).

   The model dock's tooltip glosses the current reasoning level (frontend/app/modeldock.js EFFORT_MEANING). Two things
   were wrong with it:
     - nothing said that xhigh and max use noticeably more of the Commander's usage;
     - "the default" was written into medium's gloss, so on Codex (default: low) the tooltip called the wrong level
       the default.
   Wording only, inside the existing tooltip. This file holds it to the facts it states:
     A. THE DEFAULT MARKER is the provider's default and nothing else: for every provider the registry lists, exactly one
        level carries it, the registry's defaultReasoningEffort (low on Codex, none on Kimi and Ollama, medium elsewhere),
        which is also what the page falls back to (harness.js defaultReasoningEffortForProvider, compiled out of the
        source) and what the Codex adapter sends when nothing is chosen (codex.js DEFAULT_REASONING_EFFORT);
     B. THE USAGE NOTE rides xhigh and max, no other level, and only on a route whose runs are given the dial (never on
        the Claude CLI: registry effortDialReachesRuns);
     C. NO BORROWED NUMBERS: no gloss carries a digit, a multiplier or a percent;
     D. the tooltip hands the gloss the dock's provider, and the level's own words are unchanged;
     E. the website mirror of the dock is the same bytes.
   RED on the base (agent/cand-0152 57c741da7): there the gloss is one string per level (medium's is "balanced reasoning —
   the default" on every provider, Codex included; xhigh and max say nothing about usage) and the dock exports no gloss
   that takes a provider, so every provider row fails. */
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const { functionSourceIn } = require('./helpers/source.js');
const registry = require('../frontend/app/provider-registry.js');
const Dock = require('../frontend/app/modeldock.js');

const ROOT = path.join(__dirname, '..');
const LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_NOTE = ' — the default';
const USAGE_NOTE = ' — uses noticeably more of your usage';
// each level's own words, as they were before this change (medium without the marker that was baked into it)
const OWN = {
  none: 'no extra reasoning — fastest, cheapest',
  minimal: 'a touch of reasoning',
  low: 'light reasoning — quick answers',
  medium: 'balanced reasoning',
  high: 'deep reasoning — slower, more careful',
  xhigh: 'very deep reasoning',
  max: 'maximum reasoning — slowest, most thorough'
};
const meaning = Dock._internals && Dock._internals.effortMeaning;
A.ok(typeof meaning === 'function', 'the dock exports its tooltip gloss (ModelDock._internals.effortMeaning)');
const gloss = (level, provider) => { try { return String(meaning(level, provider)); } catch (e) { return 'threw: ' + e.message; } };
const providers = registry.providerIds({ includeInactive: true });
A.ok(providers.length >= 15 && providers.indexOf('codex') >= 0 && providers.indexOf('claude-cli') >= 0, 'the registry lists the providers (' + providers.length + ')');

/* ---- A. THE DEFAULT MARKER ------------------------------------------------------------------------------------------- */
{
  // the three places that decide a provider's default agree, so the marker has one meaning
  const harness = fs.readFileSync(path.join(ROOT, 'frontend/app/harness.js'), 'utf8');
  const pageSrc = functionSourceIn(harness, 'defaultReasoningEffortForProvider');
  A.ok(pageSrc.length > 50 && pageSrc.length < 600, 'the page\'s own default rule is sliced out of harness.js (' + pageSrc.length + ' chars)');
  let pageDefault = null;
  try { pageDefault = new Function('normalizeProviderId', pageSrc + '\nreturn defaultReasoningEffortForProvider;')(p => registry.normalizeProviderId(p || 'openrouter', '')); }   // eslint-disable-line no-new-func
  catch (e) { A.ok(false, 'the page\'s default rule compiles: ' + e.message); }
  const codex = require('../sidecar/providers/codex.js');
  A.eq(codex.DEFAULT_REASONING_EFFORT, 'low', 'the Codex adapter runs at low when nothing is chosen');
  const special = { codex: 'low', kimi: 'none', ollama: 'none' };
  for (const p of providers) {
    const want = special[p] || 'medium';
    A.eq(registry.defaultReasoningEffortForProvider(p), want, p + ': the registry default is ' + want);
    if (pageDefault) A.eq(pageDefault(p), want, p + ': the page falls back to the same level (harness.js)');
    const marked = LEVELS.filter(l => gloss(l, p).indexOf('the default') >= 0);
    A.eq(marked, [want], p + ': exactly one level is marked the default, the provider\'s own (' + want + ')');
    A.ok(gloss(want, p).endsWith(DEFAULT_NOTE), p + ': the marker closes that level\'s gloss: ' + JSON.stringify(gloss(want, p)));
  }
  A.eq(gloss('medium', 'codex'), 'balanced reasoning', 'Codex: medium is no longer called the default');
  A.eq(gloss('low', 'codex'), 'light reasoning — quick answers — the default', 'Codex: low is');
  A.eq(gloss('medium', 'openrouter'), 'balanced reasoning — the default', 'OpenRouter: medium reads as it did');
  A.eq(gloss('none', 'ollama'), 'no extra reasoning — fastest, cheapest — the default', 'Ollama: off is the default');
  // an alias resolves like its provider; an unknown route reads as the station's default wire
  A.eq(gloss('low', 'openai-codex'), gloss('low', 'codex'), 'an alias reads like its provider');
  A.eq(LEVELS.map(l => gloss(l, 'no-such-provider')), LEVELS.map(l => gloss(l, 'openrouter')), 'an unknown provider reads like the default wire');
  A.eq(LEVELS.map(l => gloss(l)), LEVELS.map(l => gloss(l, 'openrouter')), 'no provider handed over (no page): the default wire');
}

/* ---- B. THE USAGE NOTE ------------------------------------------------------------------------------------------------- */
{
  for (const p of providers) {
    const reaches = registry.effortDialReachesRuns(p);
    const noted = LEVELS.filter(l => gloss(l, p).indexOf('usage') >= 0);
    A.eq(noted, reaches ? ['xhigh', 'max'] : [], p + ': ' + (reaches ? 'xhigh and max, and no other level, say they use more' : 'the dial never reaches a run here, so no level claims to use more'));
    for (const l of noted) A.ok(gloss(l, p).indexOf(OWN[l] + USAGE_NOTE) === 0, p + ' ' + l + ': the level\'s own words, then the usage note: ' + JSON.stringify(gloss(l, p)));
  }
  A.eq(providers.filter(p => !registry.effortDialReachesRuns(p)), ['claude-cli'], 'the one route whose runs are never given the dial is the Claude CLI');
  A.eq(gloss('xhigh', 'openrouter'), 'very deep reasoning — uses noticeably more of your usage', 'xhigh, where the dial reaches');
  A.eq(gloss('max', 'codex'), 'maximum reasoning — slowest, most thorough — uses noticeably more of your usage', 'max, where the dial reaches');
  A.eq([gloss('xhigh', 'claude-cli'), gloss('max', 'claude-cli')], [OWN.xhigh, OWN.max], 'Claude CLI: no usage claim (its runs get no effort)');
}

/* ---- C + D. NO BORROWED NUMBERS; THE LEVEL'S OWN WORDS; THE TOOLTIP'S CALL ------------------------------------------ */
{
  for (const p of providers) for (const l of LEVELS) {
    const g = gloss(l, p);
    A.ok(!/\d|%|×|\bx\b|times|twice|double/i.test(g), p + ' ' + l + ': no number, multiplier or percent: ' + JSON.stringify(g));
    A.ok(g.indexOf(OWN[l]) === 0, p + ' ' + l + ': opens with the level\'s own words');
    const rest = g.slice(OWN[l].length);
    A.ok(['', DEFAULT_NOTE, USAGE_NOTE, USAGE_NOTE + DEFAULT_NOTE].indexOf(rest) >= 0, p + ' ' + l + ': adds only the usage note and the default marker: ' + JSON.stringify(rest));
  }
  A.eq(gloss('nonsense', 'openrouter'), gloss('medium', 'openrouter'), 'an unknown level reads as medium, as before');
  A.eq(gloss('XHIGH', 'openrouter'), gloss('xhigh', 'openrouter'), 'a level is read the way the dock normalizes it');
  const dock = fs.readFileSync(path.join(ROOT, 'frontend/app/modeldock.js'), 'utf8');
  const tip = functionSourceIn(dock, 'updateTip');
  A.ok(/const p = provider\(\);/.test(tip) && /: effortMeaning\(effort, p\)\) \+ '<\/div>'/.test(tip), 'the tooltip hands the gloss the dock\'s own provider');
  A.ok(/'no dial — the model uses its own reasoning default' : effortMeaning\(effort, p\)/.test(tip), 'a model with no dial still reads "no dial" (no gloss, no usage claim)');
  A.eq((tip.match(/<div class="mdt-/g) || []).length, 6, 'the tooltip has the same six rows (no new element)');
  A.eq((dock.match(/effortMeaning\(/g) || []).length, 2, 'the gloss is declared once and used once');
  A.ok(!/medium: 'balanced reasoning — the default'/.test(dock), 'medium\'s own words no longer carry the marker');
}

/* ---- E. THE WEBSITE MIRROR ------------------------------------------------------------------------------------------- */
{
  const a = fs.readFileSync(path.join(ROOT, 'frontend/app/modeldock.js'));
  const b = (() => { try { return fs.readFileSync(path.join(ROOT, 'website/app/app/modeldock.js')); } catch (_) { return null; } })();
  A.ok(!!b && a.equals(b), 'website/app/app/modeldock.js is byte-identical to frontend/app/modeldock.js');
}

A.report('dock-effort-wording.test');
