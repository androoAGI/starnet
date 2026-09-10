/* node test/budget-caps.test.js — P0-2 SETTINGS → Budget: the four USD caps get a UI + server-side
   persistence + live apply, ON TOP of the existing env-var config (additive). Three layers:
   1) PURE resolve/validate (sidecar/budgetcaps.js): env→override precedence, 0 = "no cap", RESET semantics,
      strict validation (>=0, ceiling, clear-on-blank).
   2) PERSISTENCE round-trip: an override survives a save→reload through the same {version,caps} envelope the host
      writes, and a corrupt/negative persisted value silently falls back to env (never grants headroom).
   3) SOURCE GUARD: the frontend Budget panel + the /api/budget/caps endpoint + status fields actually exist. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const bc = require('../sidecar/budgetcaps.js');

const ENV = { perRun: 3, perAgent: 5, perDay: 40, global: 100 };   // a fully-governed caps baseline (resolveCaps is pure — shipped defaults since 2026-07-23 are perRun $10, pools 0/ungoverned)

// ---------- 1. PURE resolve precedence ----------
{
  // no overrides -> pure env defaults
  A.eq(bc.resolveCaps(ENV, {}), { perRun: 3, perAgent: 5, perDay: 40, global: 100 }, 'no overrides -> env defaults verbatim');
  A.eq(bc.resolveCaps(ENV, null), { perRun: 3, perAgent: 5, perDay: 40, global: 100 }, 'null overrides is safe -> env defaults');

  // a saved override wins for its key ONLY; unset keys still follow env
  A.eq(bc.resolveCaps(ENV, { perDay: 25 }), { perRun: 3, perAgent: 5, perDay: 25, global: 100 }, 'a saved perDay wins; the rest stay env');

  // 0 is a REAL saved choice ("no cap") and beats a non-zero env default — the whole point of the UI
  A.eq(bc.resolveCaps(ENV, { global: 0 }).global, 0, 'saved 0 = no-cap overrides the non-zero env default');

  // multiple overrides
  A.eq(bc.resolveCaps(ENV, { perRun: 10, perDay: 0, global: 250 }), { perRun: 10, perAgent: 5, perDay: 0, global: 250 }, 'mixed overrides resolve per key');

  // env default missing/negative -> 0 (never negative, never NaN)
  A.eq(bc.resolveCaps({ perRun: -5 }, {}).perRun, 0, 'a negative env default resolves to 0');
  A.eq(bc.resolveCaps({}, {}), { perRun: 0, perAgent: 0, perDay: 0, global: 0 }, 'no env, no override -> all 0 (ungoverned)');
}

// ---------- 1b. cleanOverrides drops junk (corrupt persisted values can't grant headroom) ----------
{
  A.eq(bc.cleanOverrides({ perRun: 2, perDay: -1, perAgent: 'x', global: NaN, junk: 9 }), { perRun: 2 }, 'only finite >=0 known keys survive');
  A.eq(bc.cleanOverrides(null), {}, 'null -> {}');
  A.eq(bc.cleanOverrides({ perDay: 0 }), { perDay: 0 }, '0 is a valid, kept override (explicit no-cap)');
}

// ---------- 2. validateOverridesPatch: strict parse + merge + RESET ----------
{
  // set a couple, merged onto an existing base
  let r = bc.validateOverridesPatch({ perDay: '30', global: 200 }, { perRun: 3 });
  A.eq(r.ok, true, 'a valid patch is accepted');
  A.eq(r.overrides, { perRun: 3, perDay: 30, global: 200 }, 'string numbers coerce; base is merged, not replaced');

  // blank / null CLEARS a key back to env default (RESET)
  r = bc.validateOverridesPatch({ perRun: null, perDay: '' }, { perRun: 3, perDay: 40, global: 200 });
  A.eq(r.ok, true, 'clear patch accepted');
  A.eq(r.overrides, { global: 200 }, 'null/blank keys are removed from the override set (fall back to env)');

  // negative / non-numeric / over-ceiling are rejected (400), no partial apply
  A.eq(bc.validateOverridesPatch({ perDay: -1 }, {}).ok, false, 'negative rejected');
  A.eq(bc.validateOverridesPatch({ perDay: 'abc' }, {}).ok, false, 'non-numeric rejected');
  A.eq(bc.validateOverridesPatch({ perDay: 1e9 }, {}).ok, false, 'over the $10M ceiling rejected');
  A.ok(bc.validateOverridesPatch({ perDay: bc.CAP_MAX }, {}).ok, 'exactly at the ceiling is allowed');

  // 0 = no cap is accepted (not treated as "clear")
  r = bc.validateOverridesPatch({ global: 0 }, {});
  A.eq(r.ok, true, '0 accepted'); A.eq(r.overrides.global, 0, '0 persists as an explicit no-cap');

  // an empty / non-object patch is a 400, never a silent no-op
  A.eq(bc.validateOverridesPatch({}, {}).ok, false, 'empty patch rejected (no fields)');
  A.eq(bc.validateOverridesPatch(null, {}).ok, false, 'null body rejected');
  A.eq(bc.validateOverridesPatch(['perDay'], {}).ok, false, 'array body rejected');
  // unknown keys are ignored, not errors — but a patch with ONLY unknown keys touches nothing
  A.eq(bc.validateOverridesPatch({ bogus: 5 }, {}).ok, false, 'a patch of only-unknown keys touches nothing -> rejected');

  // micro-dollar clamp
  A.eq(bc.validateOverridesPatch({ perRun: 1.23456789 }, {}).overrides.perRun, 1.234568, 'value is clamped to micro-dollar precision');
}

// ---------- 3. PERSISTENCE round-trip through the host's {version,caps} envelope ----------
{
  const tmp = path.join(require('os').tmpdir(), 'starnet-budget-test-' + process.pid + '.json');
  try {
    // host writes: saveResilient(BUDGET_FILE, { version: 1, caps: budgetOverrides })
    const saved = bc.validateOverridesPatch({ perRun: 2.5, global: 0 }, {}).overrides;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, caps: saved }), 'utf8');

    // host reads: loadResilient(...).caps -> cleanOverrides -> resolveCaps
    const raw = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    const reload = bc.cleanOverrides(raw && raw.caps);
    A.eq(reload, { perRun: 2.5, global: 0 }, 'override survives a save→reload round-trip');
    const eff = bc.resolveCaps(ENV, reload);
    A.eq(eff, { perRun: 2.5, perAgent: 5, perDay: 40, global: 0 }, 'reloaded override + env resolves to the expected effective caps');

    // a corrupt caps blob -> empty overrides -> pure env (fail-open, no unintended headroom)
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, caps: { perDay: -99, global: 'wipe' } }), 'utf8');
    const raw2 = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    A.eq(bc.resolveCaps(ENV, bc.cleanOverrides(raw2.caps)), { perRun: 3, perAgent: 5, perDay: 40, global: 100 }, 'corrupt persisted caps fall back to env defaults, never negative');
  } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

// ---------- 4. SOURCE GUARD: endpoint + status fields wired in the host ----------
{
  const idx = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  A.ok(/\/api\/budget\/caps/.test(idx) && /handleBudgetCaps/.test(idx), 'POST /api/budget/caps route + handler present');
  A.ok(/require\('\.\/budgetcaps\.js'\)/.test(idx), 'host uses the pure budgetcaps helper (single source of logic)');
  A.ok(/const budgetStore = makeDomainStore/.test(idx) && /budgetStore\.load\(\)\.value/.test(idx) && /budgetStore\.save\(budgetOverrides\)/.test(idx), 'caps persist via the normalized domain store (durable + .bak + read-back proof)');
  A.ok(/applyBudgetCaps/.test(idx) && /budget\.setCaps/.test(idx), 'saved caps apply LIVE to the governor (no restart)');
  A.ok(/spentToday:\s*ledger\.usdForDay/.test(idx), 'status exposes spentToday from the real ledger read path');
  A.ok(/lifetime:\s*ledger\.totalUsd/.test(idx), 'status exposes lifetime from the real ledger read path');
  // additive: the pre-existing flat perRun field is kept for back-compat
  A.ok(/perRun:\s*effectiveCaps\.perRun,\s*\/\/ back-compat/.test(idx), 'legacy flat perRun status field preserved');
  // the loop's per-run hard ceiling now reads the effective (persisted-or-env) cap, not the frozen env const
  A.ok(/effectiveCaps\.perRun > 0 && isFinite\(effectiveCaps\.perRun\)/.test(idx), 'the loop reads the EFFECTIVE perRun (persisted-or-env)');
}

// ---------- 5. SOURCE GUARD: the frontend Budget panel ----------
{
  const station = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'css', 'app.css'), 'utf8');
  A.ok(/>Spending limits </.test(station), 'BUDGET section header present in SETTINGS');
  A.ok(/function wireBudget/.test(station) && /wireBudget\(body\)/.test(station), 'wireBudget builder present and called');
  A.ok(/id="bg-perRun"/.test(station) && /id="bg-perAgent"/.test(station) && /id="bg-perDay"/.test(station) && /id="bg-global"/.test(station), 'all four cap inputs present');
  A.ok(/id="bg-save"/.test(station) && /id="bg-reset"/.test(station), 'SAVE + RESET controls present');
  A.ok(/\/api\/budget\/caps/.test(station), 'the panel posts to the caps endpoint');
  A.ok(/\/api\/budget\/status/.test(station), 'the panel reads live status');
  A.ok(/id="budget-spend"/.test(station) && /SPENT TODAY/.test(station) && /LIFETIME/.test(station), 'spend readout (today + lifetime) present');
  A.ok(/blank or 0 = no cap/i.test(station) && /leave blank or 0 for no cap/i.test(station), 'the "blank/0 = no cap" semantics are surfaced to the user');
  A.ok(/class="mc-hint"/.test(station), 'one-line inline help under each cap field (reuses the connector-form idiom)');
  A.ok(/#budget-form .set-row/.test(css) && /input\[type=number\]\.key-input/.test(css), 'budget panel styles present (number-input phosphor + row layout)');
}

A.report('budget-caps');
