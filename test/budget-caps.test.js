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
  A.ok(/spentToday:\s*known \? ledger\.usdForDay\(now\) : null/.test(idx), 'status exposes spentToday from the real ledger read path');
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

// ---- the SHIPPED defaults (2026-09-17): a fresh install is no longer ungoverned on the day pool ----------------
// A customer's loop burned ~$98 overnight with every cap at 0. perDay now ships as a soft rail; everything else
// stays off. The rail must be (a) a real cap the governor blocks on, (b) overridable to 0 from the UI, and
// (c) beaten by an explicit env value — the same precedence every other cap already has.
{
  const shipped = bc.shippedDefaults();
  A.eq(shipped, { perRun: 0, perAgent: 0, perDay: 25, global: 0 }, 'perDay ships at $25; the other three stay off');
  A.eq(bc.DEFAULT_PER_DAY_USD, 25, 'the constant the sidecar wires is the same number');
  A.ok(bc.shippedDefaults() !== bc.shippedDefaults(), 'each call is a fresh copy (a caller cannot mutate the shipped table)');
  A.eq(bc.resolveCaps(shipped, {}), shipped, 'with nothing saved, the shipped defaults ARE the effective caps');
  A.eq(bc.resolveCaps(shipped, { perDay: 0 }).perDay, 0, 'a saved 0 dials the shipped rail OFF (the Commander\'s explicit choice wins)');
  A.eq(bc.resolveCaps(shipped, { perDay: 100 }).perDay, 100, 'a saved value raises it');
  A.eq(bc.resolveCaps(Object.assign({}, shipped, { perDay: 40 }), {}).perDay, 40, 'an env value (SKYNET_BUDGET_PER_DAY) replaces the shipped default');
  // the governor actually blocks on it — this is the number that stops the overnight burn
  const B = require('../sidecar/budget.js');
  const ev = B.evaluate({ day: shipped.perDay }, { day: 25.5 });
  A.eq(ev.blocked, 'day', 'the day pool blocks once spend reaches the shipped cap');
  A.eq(B.evaluate({ day: shipped.perDay }, { day: 24 }).blocked, null, 'and not before');
  A.eq(B.evaluate({ day: shipped.perDay }, { day: 21 }).warn, ['day'], 'with the 80% warn band ahead of it');
  // the SETTINGS → BUDGET copy still tells the truth: a value that is not saved reads as the environment default
  const station = require('fs').readFileSync(require('path').join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
  A.ok(/environment default/.test(station), 'the panel badges an unsaved cap as the default, so $25 never reads as something the user set');
}

// ---- issue #53: a StarNet-credit run never reserves the whole wallet by default ------------------------------
// Before: no per-run cap in force -> admission reserved the ENTIRE balance, which is also the loop's per-run
// ceiling, so one prompt could spend a fresh $10 top-up. Now: min(managed default, balance); a positive cap the
// user (or a delegating caller) chose is honoured verbatim. The live proof is test/managed-run-cap.e2e.test.js.
{
  const D = bc.DEFAULT_MANAGED_PER_RUN_USD;
  A.eq(D, 2, 'the managed per-run default is $2 (a fifth of the $10 minimum top-up)');
  A.ok(D < bc.DEFAULT_PER_DAY_USD, 'it sits well under the $25/day rail, so the day rail stays the backstop');
  A.eq(bc.managedRunCapUsd(0, 10, D), 2, 'no cap chosen + $10 wallet -> reserve $2, not $10');
  A.eq(bc.managedRunCapUsd(Infinity, 10, D), 2, 'an "ungoverned" (Infinity) run cap is treated as no cap chosen');
  A.eq(bc.managedRunCapUsd(0, 1.2, D), 1.2, 'a wallet under the default is clamped, never refused for a cap nobody chose');
  A.eq(bc.managedRunCapUsd(5, 10, D), 5, 'a user\'s higher per-run cap wins');
  A.eq(bc.managedRunCapUsd(0.5, 10, D), 0.5, 'a user\'s lower per-run cap wins');
  // a cap is a CEILING: a $100 cap on a $79 wallet used to be refused as "out of credit" (customer report 2026-10-06)
  A.eq(bc.managedRunCapUsd(50, 10, D), 10, 'a cap above the balance reserves the balance, never a refusal');
  A.eq(bc.managedRunCapUsd(5, 0, D), 0, 'a cap on an empty wallet -> 0 (the host fails closed: out of credit)');
  A.eq(bc.managedRunCapUsd(5, null, D), 0, 'a cap on an unknown wallet -> 0 (fail closed: credits unavailable)');
  A.eq(bc.managedRunCapUsd(0, 0, D), 0, 'an empty wallet -> 0 (the host fails closed: out of credit)');
  A.eq(bc.managedRunCapUsd(0, NaN, D), 0, 'an unknown wallet -> 0 (fail closed: credits unavailable)');
  A.eq(bc.managedRunCapUsd(0, null, D), 0, 'a null (never reported) wallet -> 0, the same as unknown');
  A.eq(bc.managedRunCapUsd(0, 10, 0), 10, 'an operator default of 0 restores the old wallet-is-the-ceiling behaviour');
  // the host really uses it (a pure helper nobody calls fixes nothing — injected-deps-hide-wiring-bugs)
  const idx = require('fs').readFileSync(require('path').join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  A.ok(/runCapUsd = budgetCaps\.managedRunCapUsd\(\(runCapUsd > 0 && isFinite\(runCapUsd\)\) \? runCapUsd : 0, avail, MANAGED_PER_RUN_DEFAULT\)/.test(idx), 'managed admission reserves through managedRunCapUsd, a chosen cap included');
  // Number(null) is 0: a failed refresh (null balance) must never be read as a reported $0 wallet
  A.ok(/const avail = \(snap && typeof snap\.balanceUsd === 'number' && isFinite\(snap\.balanceUsd\)\) \? snap\.balanceUsd : NaN;/.test(idx), 'admission reads only a REPORTED balance; null stays unknown');
  A.ok(!/runCapUsd = \(isFinite\(avail\) && avail > 0\) \? avail : 0/.test(idx), 'the reserve-the-whole-wallet line is gone');
  A.ok(/MANAGED_PER_RUN_DEFAULT = num\(ENV\('BUDGET_MANAGED_PER_RUN'\), budgetCaps\.DEFAULT_MANAGED_PER_RUN_USD\)/.test(idx), 'the default is env-tunable (SKYNET_BUDGET_MANAGED_PER_RUN)');
  // truthful UI: "0 = no cap" must not be the whole story on StarNet credits, and a run stop never says "remove"
  const station = require('fs').readFileSync(require('path').join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
  A.ok(/id="bg-managed-hint"/.test(station) && /st\.managedRunDefaultUsd/.test(station), 'the Budget panel paints the managed default from /api/budget/status');
  const chat = require('fs').readFileSync(require('path').join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
  A.ok(/scope === 'run' \? ' — raise it' : ' — raise or remove it'/.test(chat), 'a per-run budget stop says "raise it", never a "remove" that would do nothing on credits');
}

A.report('budget-caps');
