'use strict';
// free-path-ollama.test.js — the zero-key path is a real, honest choice (GitHub issue #6).
//
// A user who unlinked their StarNet account (hero provider still `starnet`) was shown "no STARNET key — ADD IN
// SETTINGS": a key that does not exist, for a provider they no longer wanted, with no way to pick another brain
// or the free local one. This locks:
//   1. KeyCTA names the REAL gap (unlinked vs no key) and offers three doors: fix it · switch provider · run
//      free locally (Ollama).
//   2. The Ollama door is TRUTHFUL: it only switches the brain after a FRESH sidecar probe says Ollama answers;
//      an offline Ollama routes to the settings entry and never selects a dead endpoint.
//   3. Genesis makes the free path visible (tag on the OLLAMA chip + an honest block), and the docs say how.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

/* ---------------- functional: KeyCTA gap detection + the Ollama door ---------------- */
// keycta.js is a browser IIFE that only touches globals lazily — stub the seams it reads.
const calls = { openTerm: [], setProv: [], probes: 0, notify: [] };
let probeResult = { reachable: false };
let starnetConfigured = false;
let stored = Object.create(null);
let prov = 'starnet';
global.SK = { providers: { registry: require('../sidecar/providers/registry.js') } };
global.document = { getElementById: () => null, querySelector: () => null };
global.App = { currentAgent: () => ({ name: 'NOVA', onboarded: true }) };
global.Harness = {
  getProv: () => prov,
  setProv: p => { calls.setProv.push(p); prov = p; },
  configured: p => (p === 'starnet' ? starnetConfigured : true),
  hasStoredCredential: p => !!stored[p],
  probeProvider: () => { calls.probes++; return Promise.resolve(probeResult); }
};
global.StationUI = { openTerm: (k, s) => calls.openTerm.push([k, s]), notify: (m, k) => calls.notify.push([m, k]), rerender: () => {} };
global.ModelDock = { reconcile: () => Promise.resolve(), reflect: () => {} };

const KeyCTA = require('../frontend/app/keycta.js');

// 1. an UNLINKED starnet station is a LINK gap, never a "key" gap
prov = 'starnet'; starnetConfigured = false;
eq(KeyCTA.gapOf() && KeyCTA.gapOf().kind, 'unlinked', 'starnet + not linked → gap kind is unlinked (there is no STARNET key to add)');
starnetConfigured = true;
eq(KeyCTA.gapOf(), null, 'starnet + linked → no gap');
// 2. a keyed provider without a stored credential is a key gap
prov = 'gemini'; stored = Object.create(null);
eq(KeyCTA.gapOf() && KeyCTA.gapOf().kind, 'nokey', 'gemini with nothing stored → nokey gap');
eq(KeyCTA.gapOf().provider, 'gemini', 'the gap names the provider it is about');
stored.gemini = true;
eq(KeyCTA.gapOf(), null, 'gemini with a stored key → no gap');
// 3. keyless-by-design providers never trip it
for (const p of ['ollama', 'custom', 'codex', 'grok', 'kimi']) { prov = p; eq(KeyCTA.gapOf(), null, p + ' never trips the CTA'); }
// 4. a hero that hasn't landed yet is silent
prov = 'starnet'; starnetConfigured = false;
global.App.currentAgent = () => ({ name: 'NOVA', onboarded: false });
eq(KeyCTA.gapOf(), null, 'no gap before the awakening lands');
global.App.currentAgent = () => ({ name: 'NOVA', onboarded: true });

(async () => {
  // 5. the Ollama door with Ollama OFFLINE: never switches, routes to SETTINGS ▸ PROVIDERS with the honest reason
  prov = 'starnet'; probeResult = { reachable: false };
  const off = await KeyCTA.useOllama();
  eq(off, false, 'offline ollama → the door reports false');
  eq(calls.setProv.length, 0, 'offline ollama → provider NOT switched (never select a dead endpoint)');
  ok(calls.openTerm.some(([k, s]) => k === 'settings' && s === 'providers'), 'offline ollama → opens SETTINGS ▸ PROVIDERS (the setup entry)');
  ok(calls.notify.some(([m, k]) => k === 'bad' && /ollama/i.test(m) && /ollama\.com/.test(m)), 'offline ollama → says so, with the install pointer');
  eq(prov, 'starnet', 'the active provider is untouched');

  // 6. the Ollama door with Ollama REACHABLE (sidecar-proven): switches the brain, and the gap closes
  probeResult = { reachable: true };
  const before = calls.probes;
  const on = await KeyCTA.useOllama();
  eq(on, true, 'reachable ollama → the door reports true');
  ok(calls.probes > before, 'the switch rides a FRESH probe, never a cached verdict');
  eq(calls.setProv[calls.setProv.length - 1], 'ollama', 'reachable ollama → Harness.setProv("ollama")');
  eq(KeyCTA.gapOf(), null, 'after the switch there is no gap — the banner has nothing to assert');

  /* ---------------- source guards: the three doors, genesis visibility, docs ---------------- */
  const keycta = read('frontend/app/keycta.js');
  ok(/class="key-cta-act"/.test(keycta) && /class="key-cta-alt"/.test(keycta) && /class="key-cta-free"/.test(keycta), 'the banner carries three doors: fix · switch provider · free local');
  ok(/USE A DIFFERENT PROVIDER/.test(keycta), 'the switch door is labelled as a provider choice');
  ok(/RUN FREE LOCALLY \(OLLAMA\)/.test(keycta) && /SET UP OLLAMA/.test(keycta), 'the free door has a proven label and an honest unproven label');
  ok(/ollamaReady \? '◇ RUN FREE LOCALLY/.test(keycta), 'the "run free" label is gated on the sidecar probe verdict (truthful telemetry)');
  ok(/Harness\.probeProvider\('ollama'\)/.test(keycta), 'the verdict comes from the sidecar probe route, not a local guess');
  ok(/LINK STARNET/.test(keycta), 'an unlinked starnet station is offered a LINK, not a key');
  ok(/openTerm\('settings', 'providers'\)/.test(keycta), 'every door lands on the PROVIDERS section of settings');

  const index = read('frontend/index.html');
  ok(/data-prov="ollama"[^>]*>OLLAMA <span class="prov-tag">FREE · LOCAL<\/span>/.test(index), 'the genesis OLLAMA chip wears the FREE · LOCAL tag');
  ok(/id="ollama-block" class="hidden"/.test(index), 'the genesis ollama block exists and ships hidden (shown only while picked)');
  ok(/id="ollama-status"/.test(index), 'the ollama block carries a live status line');
  ok(/ollama\.com/.test(index) && /ollama pull/.test(index), 'the ollama block points at the install + pull steps');
  ok(/local models are smaller than the cloud ones/.test(index), 'the ollama block carries the honest quality caveat');
  // existing chips untouched (no reorder / no removal)
  for (const p of ['starnet', 'grok', 'kimi', 'openrouter', 'openai', 'anthropic', 'gemini', 'custom']) ok(new RegExp('data-prov="' + p + '"').test(index), 'chip ' + p + ' still present');

  const app = read('frontend/app/app.js');
  ok(/const isOllama = pickedProvider === 'ollama';/.test(app) && /el\('ollama-block'\)[\s\S]{0,80}toggle\('hidden', !isOllama\)/.test(app), 'selectProviderUI shows the ollama block only while OLLAMA is picked');
  ok(/ollama detected on this machine/.test(app) && /ollama not detected yet/.test(app), 'loadModels paints the ollama status from the live catalog');
  ok(/if \(p === 'ollama' && pickedProvider === 'ollama'\)/.test(app), 'the ollama status is written only for the ollama catalog of the current pick');
  // The seed slug ('llama3.1') is not an installed model unless that exact tag was pulled: with a live local catalog
  // the default is an installed model, preferring one Ollama says can call tools (live-proven 2026-09-30: a machine
  // with llama3.1:8b + qwen3:8b prefilled 'llama3.1' before this).
  ok(/if \(p === 'ollama' && list\.length && !list\.some\(m => m && m\.id === defId\)\)/.test(app)
    && /list\.find\(m => m && m\.supportsTools !== false\) \|\| list\[0\]/.test(app), 'an Ollama default is an installed, tool-capable model from the live catalog');

  for (const f of ['README.md', 'INSTALL.md']) {
    const doc = read(f);
    ok(/## Run free with a local model/.test(doc), f + ' has the "Run free with a local model" section');
    ok(/ollama\.com/.test(doc) && /SETTINGS → PROVIDERS/.test(doc), f + ' names the install pointer and the setting');
    ok(/smaller than/.test(doc) && /slower/.test(doc), f + ' carries the honest local-quality caveat');
  }

  console.log('free-path-ollama: ' + n + ' assertions ok');
})().catch(e => { console.error(e); process.exit(1); });
