/* node test/fallback-chain.test.js — P0-3 SETTINGS → Models: the ordered fallback model chain gets a UI +
   server-side persistence + live apply, ON TOP of the existing env-var config (additive). Four layers:
   1) PURE resolve/validate (sidecar/fallbackchain.js): env→saved precedence, saved-empty = "no fallback" (an
      explicit choice that beats a non-empty env default), CLEAR semantics, warn-don't-refuse catalog validation.
   2) PERSISTENCE round-trip: a chain survives a save→reload through the same {version,models} envelope the host
      writes, and a corrupt persisted blob silently falls back to env (never injects junk).
   3) SOURCE GUARD (host): the /api/fallback/chain endpoint exists, persists via the resilient store, and the
      run host's fallback resolution actually consumes the persisted chain (request > saved > env precedence).
   4) SOURCE GUARD (frontend): the SETTINGS → MODELS panel exists, is wired, and states the REAL trigger classes. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const fc = require('../sidecar/fallbackchain.js');

// ---------- 1. PURE resolve precedence ----------
{
  // never saved (null) -> env default verbatim (comma list, trimmed, de-duplicated)
  A.eq(fc.resolveChain('a/x, b/y,,a/x', null), ['a/x', 'b/y'], 'no saved chain -> parsed env default (trim+dedup)');
  A.eq(fc.resolveChain('', null), [], 'no env, never saved -> empty (fallback off)');
  A.eq(fc.resolveChain(null, null), [], 'null env is safe');

  // a saved chain wins outright over env
  A.eq(fc.resolveChain('a/x,b/y', ['c/z']), ['c/z'], 'a saved chain replaces the env default (never merged)');

  // saved-EMPTY is a REAL choice ("no fallback") and beats a non-empty env default — how the UI turns it OFF
  A.eq(fc.resolveChain('a/x,b/y', []), [], 'saved [] = explicit OFF overrides a non-empty env default');

  // env may arrive pre-split as an array too
  A.eq(fc.resolveChain(['a/x', 'a/x', ' '], null), ['a/x'], 'array env input is cleaned the same way');
}

// ---------- 1c. task admission promotes a configured tool-capable route instead of refusing ----------
{
  const support = id => ({ 'plain/chat': false, 'tools/known': true, 'catalog/cold': null, 'also/plain': false })[id];
  let r = fc.promoteToolCapable('plain/chat', ['also/plain', 'tools/known', 'catalog/cold'], support);
  A.eq(r.model, 'tools/known', 'first definitively tool-capable fallback is promoted');
  A.eq(r.fallbacks, ['also/plain', 'catalog/cold'], 'promoted model is removed and remaining order is preserved');
  A.eq(r.promoted, true, 'promotion is explicit for truthful telemetry');
  A.eq(r.fromModel, 'plain/chat', 'receipt retains the selected incapable model');
  r = fc.promoteToolCapable('plain/chat', ['also/plain', 'catalog/cold'], support);
  A.eq(r.model, 'catalog/cold', 'unknown catalog support is eligible instead of being false-refused');
  r = fc.promoteToolCapable('tools/known', ['plain/chat'], support);
  A.eq(r.promoted, false, 'a capable primary remains selected');
  r = fc.promoteToolCapable('plain/chat', ['also/plain'], support);
  A.eq(r.promoted, false, 'all definitively incapable routes preserve the honest admission refusal');
}

// ---------- 1b. cleanChain drops junk (a corrupt persisted blob can't inject entries) ----------
{
  A.eq(fc.cleanChain(['a/x', 42, null, {}, ' b/y ', 'a/x', '']), ['a/x', 'b/y'], 'only trimmed non-empty strings survive; first dup wins');
  A.eq(fc.cleanChain(null), [], 'null -> []');
  A.eq(fc.cleanChain('a/x'), [], 'a bare string (not an array) -> [] (shape is strict)');
  const long = Array.from({ length: 20 }, (_, i) => 'm/' + i);
  A.eq(fc.cleanChain(long).length, fc.MAX_ENTRIES, 'chain is bounded to MAX_ENTRIES');
  A.eq(fc.cleanChain(['x'.repeat(500)])[0].length, fc.MAX_SLUG_LEN, 'an absurd slug is truncated, not kept whole');
}

// ---------- 2. validateChainPatch: strict parse, clear, warn-don't-refuse ----------
{
  // SET an ordered chain
  let r = fc.validateChainPatch({ models: [' b/y ', 'a/x', 'b/y'] });
  A.eq(r.ok, true, 'a valid patch is accepted');
  A.eq(r.present, true, 'set patch is marked present (a saved choice)');
  A.eq(r.chain, ['b/y', 'a/x'], 'order preserved, trimmed, de-duplicated');

  // CLEAR back to env: models:null, clear:true, or an empty body all clear
  for (const body of [{ models: null }, { clear: true }, {}]) {
    r = fc.validateChainPatch(body);
    A.eq(r.ok && !r.present, true, 'clear patch accepted (present:false) for ' + JSON.stringify(body));
  }

  // saved-empty OFF is a SET, not a clear
  r = fc.validateChainPatch({ models: [] });
  A.eq(r.ok && r.present === true && r.chain.length === 0, true, 'models:[] = explicit OFF (present:true, empty chain)');

  // invalid shapes are rejected loudly (client bug, not a stale slug)
  A.eq(fc.validateChainPatch(null).ok, false, 'null body rejected');
  A.eq(fc.validateChainPatch(['a/x']).ok, false, 'array body rejected');
  A.eq(fc.validateChainPatch({ models: 'a/x' }).ok, false, 'string models rejected (must be an array)');
  A.eq(fc.validateChainPatch({ models: [42] }).ok, false, 'non-string entry rejected');
  A.eq(fc.validateChainPatch({ models: Array.from({ length: fc.MAX_ENTRIES + 1 }, (_, i) => 'm/' + i) }).ok, false, 'over MAX_ENTRIES rejected');

  // catalog validation WARNS but never refuses (catalogs go stale; a brand-new model must be settable)
  r = fc.validateChainPatch({ models: ['known/model', 'brand/new'] }, { catalog: new Set(['known/model']) });
  A.eq(r.ok, true, 'unknown ids are still accepted');
  A.eq(r.warnings, ['brand/new'], 'unknown ids are surfaced as warnings');
  r = fc.validateChainPatch({ models: ['a/x'] }, { catalog: null });
  A.eq(r.ok === true && r.warnings.length === 0, true, 'a cold/absent catalog skips validation entirely (no false warnings)');
}

// ---------- 3. PERSISTENCE round-trip through the host's {version,models} envelope ----------
{
  const tmp = path.join(require('os').tmpdir(), 'starnet-fallback-test-' + process.pid + '.json');
  try {
    // host writes: saveResilient(FALLBACK_FILE, { version: 1, models: fallbackSaved })
    const saved = fc.validateChainPatch({ models: ['c/z', 'd/w'] }).chain;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, models: saved }), 'utf8');

    // host reads: loadResilient(...).models -> cleanChain -> resolveChain
    const raw = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    const reload = Array.isArray(raw && raw.models) ? fc.cleanChain(raw.models) : null;
    A.eq(reload, ['c/z', 'd/w'], 'chain survives a save→reload round-trip in order');
    A.eq(fc.resolveChain('a/x,b/y', reload), ['c/z', 'd/w'], 'reloaded chain wins over the env default');

    // a corrupt models blob -> null (not-saved) -> pure env (fail-open, no junk injected)
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, models: 'oops' }), 'utf8');
    const raw2 = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    const reload2 = Array.isArray(raw2 && raw2.models) ? fc.cleanChain(raw2.models) : null;
    A.eq(reload2, null, 'a corrupt persisted blob reads as never-saved');
    A.eq(fc.resolveChain('a/x,b/y', reload2), ['a/x', 'b/y'], 'corrupt persisted chain falls back to the env default');
  } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

// ---------- 4. SOURCE GUARD: endpoint + live consumption wired in the host ----------
{
  const idx = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  A.ok(/\/api\/fallback\/chain/.test(idx) && /handleFallbackChain/.test(idx) && /handleFallbackStatus/.test(idx), 'GET+POST /api/fallback/chain routes + handlers present');
  A.ok(/require\('\.\/fallbackchain\.js'\)/.test(idx), 'host uses the pure fallbackchain helper (single source of logic)');
  A.ok(/const fallbackStore = makeDomainStore/.test(idx) && /fallbackStore\.load\(\)\.value/.test(idx) && /fallbackStore\.save\(fallbackSaved\)/.test(idx), 'chain persists via the normalized domain store (durable + .bak + read-back proof)');
  // the RUN HOST actually consumes the persisted chain: request list > saved-or-env (live, per-run read — no restart)
  A.ok(/Array\.isArray\(o\.fallbackModels\) \? o\.fallbackModels : effectiveFallbackChain\(\)/.test(idx), 'runOnce resolves: explicit per-run list, else the persisted-or-env chain');
  A.ok(/fallbackChain\.promoteToolCapable\(model, fallbackModels/.test(idx), 'task admission consumes the configured chain before refusing a tool-less primary');
  A.ok(/initialFallback/.test(idx), 'preflight promotion is passed to the loop for truthful telemetry');
  A.ok(/fallbackChain\.resolveChain\(ENV_FALLBACK, fallbackSaved\)/.test(idx), 'effective chain = pure resolve(env, saved)');
  A.ok(/parseEnvChain\(ENV\('FALLBACK_MODELS'\)/.test(idx), 'env SKYNET/STARNET_FALLBACK_MODELS remains the default baseline');
  // honest validation posture: catalog lookups warn, never refuse
  A.ok(/warmModelCatalogSet/.test(idx) && /warnings/.test(idx), 'catalog validation is wired as warnings (never a refusal)');
}

// ---------- 5. SOURCE GUARD: the frontend MODELS panel ----------
{
  const station = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'css', 'app.css'), 'utf8');
  A.ok(/>Backup models </.test(station), 'MODELS section header present in SETTINGS');
  A.ok(/function wireFallbackChain/.test(station) && /wireFallbackChain\(body\)/.test(station), 'wireFallbackChain builder present and called');
  A.ok(/id="fbc-list"/.test(station) && /id="fbc-add"/.test(station), 'ordered list + add-from-catalog picker present');
  A.ok(/data-act="up"/.test(station) && /data-act="dn"/.test(station) && /data-act="rm"/.test(station), 'reorder up/down + remove controls present');
  A.ok(/id="fbc-save"/.test(station) && /id="fbc-reset"/.test(station), 'SAVE + RESET controls present');
  A.ok(/\/api\/fallback\/chain/.test(station), 'the panel reads + posts the chain endpoint');
  A.ok(/\/api\/models\/openrouter/.test(station), 'the add-picker is fed from the real model catalog');
  // inline help must describe the REAL trigger behavior (errorClass shouldFallback/shouldRotateCredential classes)
  A.ok(/fails mid-run/.test(station) && /availability/.test(station) && /rate limits/.test(station), 'inline help names the real error classes that trigger fallback');
  A.ok(/environment default \(not yet saved here\)/.test(station), 'saved-vs-env source is annotated honestly');
  A.ok(/\.fbc-row/.test(css) && /select\.fbc-sel/.test(css), 'MODELS panel styles present (row + picker, phosphor vars)');
}

A.report('fallback-chain');
