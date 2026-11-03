/* sidecar/recipe-drift.js — GOLDEN-RUN DRIFT for recipe-launched runs (2026-08-22).

   THE GAP. A business recipe that worked on Monday can silently stop working on Thursday — a provider swaps a
   model, a prompt is tweaked, a connector changes shape — and nothing compares run 12 against runs 1–11. The
   durable run rows already carry everything needed (recipeId, reason, completionEvidence checks, toolTrace, model,
   usd, turns), so drift is COMPUTED from history, never a second ledger.

   THE RULE. For one recipe, the BASELINE is the newest N (≤5) GOOD runs before the latest — reason 'done' and no
   failed check. The latest run is compared against it and every difference that matters is a NAMED signal:
     check_regressed   a check id that passed in EVERY baseline run now fails
     verdict_regressed the baseline always finished (done / completed_verified); the latest did not
     tool_dropped      a tool every baseline run used is absent from the latest
     tool_new          the latest used a tool no baseline run ever used
     model_changed     the latest ran on a model no baseline run used
     cost_spike        latest usd > COST_SPIKE× the baseline median (and above a floor, so pennies never page)
   status: 'insufficient' (fewer than MIN_BASELINE good prior runs — nothing to compare against, and we say so),
           'steady' (no signals), 'drift' (≥1 signal). The streak is the last STREAK_N outcomes, newest first.

   Pure: rows in, verdict out. No clock, no fs, no rng — headless-testable. The host serves it per recipe and the
   dossier/card render it; the bell fires on 'drift' (a failure class — the one thing the bell is reserved for). */
'use strict';
const RunOutcome = require('../frontend/app/runoutcome.js');   // TYPED OUTCOMES: a GOOD run is one whose recorded outcome SUCCEEDED

const MIN_BASELINE = 2;
const BASELINE_N = 5;
const STREAK_N = 5;
const COST_SPIKE = 2.5;
const COST_FLOOR_USD = 0.05;

function str(v) { return String(v == null ? '' : v); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function median(xs) {
  const a = xs.slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function checksOf(row) {
  const ce = row && row.completionEvidence;
  return (ce && Array.isArray(ce.checks)) ? ce.checks.filter(c => c && c.id) : [];
}
function verdictOf(row) {
  const ce = row && row.completionEvidence;
  return str(ce && ce.completionVerdict) || 'not_assessed';
}
function toolsOf(row) {
  const set = new Set();
  for (const t of (Array.isArray(row && row.toolTrace) ? row.toolTrace : [])) if (t && t.name) set.add(str(t.name));
  return set;
}
// a run is GOOD when it finished and no contracted check failed. A run with no contract is good when it finished.
function isGood(row) {
  if (!row || !RunOutcome.ofRow(row).ok) return false;   // (typed-outcomes) a provider-cut 'done' did not finish
  if (checksOf(row).some(c => c.status === 'failed')) return false;
  const v = verdictOf(row);
  return v === 'not_assessed' || v === 'completed_verified' || v === 'verification_required';
}
/* A STOP IS ITS OWN OUTCOME (review r7, the family law): a run someone stopped finished nothing and failed nothing, so it is no evidence of
   drift either way — it never raises verdict_regressed (the "⚠ recipe drift" bell 1.5 s after the Commander pressed Stop), never joins
   the baseline, and its streak mark is 'stop', never 'fail'. Drift is read from the latest run that was not stopped. */
function stoppedRow(row) { return !!row && RunOutcome.ofRow(row).outcome === 'stopped'; }
function outcomeMark(row) { return isGood(row) ? 'pass' : stoppedRow(row) ? 'stop' : 'fail'; }

/* rows: durable run rows for ONE recipe, newest first. Returns the drift verdict. */
function assessDrift(rows) {
  const all = (Array.isArray(rows) ? rows : []).filter(r => r && r.runId);
  const list = all.filter(r => !stoppedRow(r));
  const out = { status: 'insufficient', latestRunId: '', latestAt: 0, baselineRuns: 0, signals: [], streak: all.slice(0, STREAK_N).map(outcomeMark) };
  if (!list.length) return out;
  const latest = list[0];
  out.latestRunId = str(latest.runId); out.latestAt = num(latest.ts);
  const baseline = list.slice(1).filter(isGood).slice(0, BASELINE_N);
  out.baselineRuns = baseline.length;
  if (baseline.length < MIN_BASELINE) return out;

  const signals = [];
  // a check id must have PASSED in every baseline run to count as regressed when it fails now
  const passCount = new Map();
  for (const row of baseline) for (const c of checksOf(row)) if (c.status === 'passed') passCount.set(c.id, (passCount.get(c.id) || 0) + 1);
  for (const c of checksOf(latest)) {
    if (c.status === 'failed' && passCount.get(c.id) === baseline.length) {
      signals.push({ code: 'check_regressed', check: c.id, detail: 'check ' + c.id + ' failed (' + str(c.code) + ') after passing in ' + baseline.length + '/' + baseline.length + ' prior runs' });
    }
  }
  if (!isGood(latest)) {
    const why = !RunOutcome.ofRow(latest).ok ? 'ended ' + (str(latest.reason) !== 'done' ? str(latest.reason) : RunOutcome.line(RunOutcome.ofRow(latest))) : 'verdict ' + verdictOf(latest);
    signals.push({ code: 'verdict_regressed', detail: 'latest run ' + why + '; the prior ' + baseline.length + ' finished clean' });
  }
  // tool shape
  const latestTools = toolsOf(latest);
  const inEvery = new Map(), inAny = new Set();
  baseline.forEach(row => { for (const t of toolsOf(row)) { inAny.add(t); inEvery.set(t, (inEvery.get(t) || 0) + 1); } });
  for (const [t, n] of inEvery) if (n === baseline.length && !latestTools.has(t)) signals.push({ code: 'tool_dropped', tool: t, detail: 'every prior run used ' + t + '; the latest did not' });
  for (const t of latestTools) if (!inAny.has(t)) signals.push({ code: 'tool_new', tool: t, detail: 'the latest used ' + t + ', which no prior run used' });
  // model
  const models = new Set(baseline.map(r => str(r.model)).filter(Boolean));
  if (models.size && str(latest.model) && !models.has(str(latest.model))) signals.push({ code: 'model_changed', model: str(latest.model), detail: 'ran on ' + str(latest.model) + ' (prior: ' + Array.from(models).join(', ') + ')' });
  // cost
  const med = median(baseline.map(r => num(r.usd)));
  const usd = num(latest.usd);
  if (med > 0 && usd > med * COST_SPIKE && usd > COST_FLOOR_USD) signals.push({ code: 'cost_spike', usd, median: med, detail: 'cost $' + usd.toFixed(3) + ' vs a $' + med.toFixed(3) + ' median (' + (usd / med).toFixed(1) + '×)' });

  out.signals = signals;
  out.status = signals.length ? 'drift' : 'steady';
  return out;
}

/* group any run rows (newest first) by recipeId and assess each; rows without a recipeId are ignored. */
function assessAll(rows) {
  const byRecipe = new Map();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const id = str(r && r.recipeId);
    if (!id) continue;
    if (!byRecipe.has(id)) byRecipe.set(id, []);
    byRecipe.get(id).push(r);
  }
  const out = {};
  for (const [id, list] of byRecipe) out[id] = assessDrift(list);
  return out;
}

module.exports = { assessDrift, assessAll, isGood, _internals: { MIN_BASELINE, BASELINE_N, STREAK_N, COST_SPIKE, COST_FLOOR_USD, median } };
