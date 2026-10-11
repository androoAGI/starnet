/* node test/unbilled-guard-wiring.test.js — SOURCE LOCKS for the subscription usage limit (2026-10-11).
   The pure pieces (cost.js weights, loop seatbelt, ledger.tokensForDay, budget.checkTokens, budgetcaps token keys) have
   their own tests; a pure helper nobody calls fixes nothing, so this pins that the HOST really wires them:
   the run adapter's token clause, the post-run aux gate, every standalone pass's gate, every aux booking
   (`usd || wtok`), the finalizer's weightedTokens, the loop limits, and the routes. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

const idx = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
const body = header => { const b = A.fnBody(idx, header); A.ok(b.length > 0 && b.length < idx.length, 'found ' + header); return b; };

// ---- consts + persistence ----
A.ok(/CAPS\.maxUnbilledTokens = num\(ENV\('MAX_UNBILLED_TOKENS'\), 0\);/.test(idx) && !/maxUnbilledTokens = num\(ENV\('MAX_UNBILLED_TOKENS'\), CAPS\.maxUnpricedTokens\)/.test(idx), 'the per-run ceiling is OPT-IN (env default 0), decoupled from the unpriced one; SKYNET_/STARNET_MAX_UNBILLED_TOKENS sets it');
A.ok(/const BUDGET_TOKEN_CAPS = \{ perDayTokens: Math\.floor\(num\(ENV\('BUDGET_PER_DAY_TOKENS'\), 0\)\), perRunTokens: Math\.floor\(CAPS\.maxUnbilledTokens\) \};/.test(idx), 'both limits ship OFF; env sets deploy defaults, a saved value wins');
A.ok(/function unbilledRunCap\(\) \{ const v = effectiveTokenCaps\.perRunTokens;/.test(idx), 'the per-run ceiling is read LIVE from the saved-or-env caps');
A.ok(/path\.join\(WORKSPACES, 'budget-tokens\.json'\)/.test(idx) && /const budgetTokenStore = makeDomainStore\(/.test(idx), 'the token limit persists in its own protected domain store');
A.ok(/normalize: value => budgetCaps\.cleanTokenOverrides\(value \|\| \{\}\)/.test(idx), '...normalized by its own cleaner (the $ store keeps its 4 keys)');
A.ok(/budget\.setTokenCaps\(\{ day: effectiveTokenCaps\.perDayTokens \}\)/.test(idx) && /tokenOverrides = budgetTokenStore\.load\(\)\.value;\s*applyTokenCaps\(\);/.test(idx), 'applied to the governor at boot');
A.ok(/function unbilledLane\(pid\) \{ const p = getProviderProfile\(pid\); return !!\(p && p\.adapter === 'claude-cli'\) && cliLaneUnbilled !== false; \}/.test(idx), 'the subscription lane = claude-cli unless the last proof was an API-key sign-in');
A.ok(/let cliLaneUnbilled = null;/.test(idx) && /if \(Number\(weighted\) > 0\) cliLaneUnbilled = true;\s*else if \(Number\(usd\) > 0\) cliLaneUnbilled = false;/.test(idx), 'cliLaneUnbilled learns from bookings: weighted tokens -> subscription, $ -> API key');
A.ok(/noteCliLane\(activeProviderId, \(result && result\.usd\) \|\| 0, \(result && result\.unbilledTokens\) \|\| 0\);/.test(idx) && (idx.match(/noteCliLane\(providerId, usd, wtok\);/g) || []).length === 2 && /noteCliLane\(o\.providerId, result\.usd \|\| 0, result\.unbilledTokens \|\| 0\)/.test(idx), '...after the run finalizer, quest refresh, stationOneShot and the skill review');
A.ok(/if \(providerId === 'claude-cli' && st\.loggedIn\) \{\s*if \(st\.subscription\) cliLaneUnbilled = true;\s*else if \(\/api\.\?key\|console\/i\.test/.test(idx), '...and from a claude auth status that names the sign-in');

// ---- the run seam ----
A.ok(/const runBudget = \{ check: \(spentThisRun, live\) => providerUnmetered \? null : \(budget\.check\(runId, agentId, spentThisRun, Date\.now\(\), emit, runReceiptMeta\)\s*\|\| \(\(unbilledLane\(activeProviderId\) \|\| \(live && live\.unbilledTokens > 0\)\) \? budget\.checkTokens\(runId, agentId, \(live && live\.unbilledTokens\) \|\| 0, Date\.now\(\)\) : null\)\) \};/.test(idx),
  'runBudget keeps the $ check and adds the token clause on the ACTIVE provider (fallbacks followed), and always for a run already showing unbilled tokens');
A.ok(/maxUnbilledTokens: \(providerUnmetered \|\| usingCodex \|\| usingDeviceOAuth\) \? Infinity : unbilledRunCap\(\)/.test(idx), 'the run passes the LIVE per-run ceiling (exempt providers Infinity)');
A.ok(/maxUnbilledTokens: \(fbUnmetered \|\| providerUsesCodex\(fbProviderId\) \|\| providerUsesDeviceOAuth\(fbProviderId\)\) \? Infinity : unbilledRunCap\(\) \}\);/.test(idx), 'provider fallback entries carry their own ceiling');
A.ok(/ledger\.record\(\{ runId, agentId, turns: finalTurns, usd: finalUsd, tokens: finalTokens, model: finalModel, unmetered: runUnmetered && mediaUsd === 0, weightedTokens: \(result && result\.unbilledTokens\) \|\| 0 \}\)/.test(idx), 'the finalizer books the run\'s weighted tokens');
{
  const gate = idx.indexOf("if (!_capReached && !providerUnmetered && unbilledLane(activeProviderId)) { try { _capReached = !!budget.checkTokens(null, agentId, 0, Date.now()); } catch (e) { failNote('aux.budget.tokens', e); } }");
  const dollar = idx.indexOf("if (!_capReached && !providerUnmetered) { try { _capReached = !!budget.check(null, agentId, 0, Date.now(), null); } catch (e) { failNote('aux.budget', e); } }");
  A.ok(dollar > 0 && gate > dollar && gate - dollar < 400, 'the post-run aux gate adds the token clause on a NEW line right after the $ one');
  A.ok(gate < idx.indexOf('if (_capReached) _auxCandidates.length = 0;', gate), '...before the candidates are cleared');
}
A.ok(/runBackgroundSkillReview\(\{[^}]*unmetered: providerUnmetered, providerId: activeProviderId \}\)/.test(idx) && /verdictReview\.stash\(runId, \{[^}]*providerId: activeProviderId \}\)/.test(idx), 'the skill review learns its lane (direct and verdict-held)');

// ---- standalone gates ----
{
  const review = body('async function runBackgroundSkillReview(o)');
  const $gate = review.indexOf("budget.check(null, String(agentId || 'agent'), 0, Date.now(), null)");
  const tGate = review.indexOf("budget.checkTokens(null, String(agentId || 'agent'), 0, Date.now())");
  A.ok($gate > 0 && tGate > $gate && tGate < review.indexOf('new AbortController()'), 'skill review: a token gate beside the pinned $ gate, before any provider work');
  A.ok(/limits: \{ maxIters: 6, maxCostUsd: SKILL_REVIEW_MAX_COST_USD, grace: false, maxUnbilledTokens: unmetered \? Infinity : unbilledRunCap\(\) \}/.test(review), 'skill review loop carries the per-run ceiling');
  A.ok(/if \(result && \(result\.usd \|\| result\.unbilledTokens\)\) \{\s*try \{ ledger\.record\(\{[^}]*weightedTokens: result\.unbilledTokens \|\| 0, unmetered \}\)/.test(review), 'skill review books its weighted tokens (unmetered stays last — sidecar.http.test.js #4 pins it)');
  const curator = body('async function runSkillCurator(o)');
  A.ok(/maxUnbilledTokens: unmetered \? Infinity : unbilledRunCap\(\)/.test(curator) && /if \(result && \(result\.usd \|\| result\.unbilledTokens\)\)/.test(curator) && /weightedTokens: result\.unbilledTokens \|\| 0/.test(curator), 'curator: ceiling + booking');
  const night = body('function nightshiftPrecheck()');
  const n$ = night.indexOf('budget.check(null, NIGHTSHIFT_AGENT, 0, Date.now(), null)'), nT = night.indexOf('budget.checkTokens(null, NIGHTSHIFT_AGENT, 0, Date.now())');
  A.ok(n$ > 0 && nT > n$ && /unbilledLane\(cronProviderFor\(\{ agentId: NIGHTSHIFT_AGENT \}\)\)/.test(night), 'nightshift: a token gate after the $ gate, on its own provider lane');
  const quest = body('async function runQuestRefreshCycle(why)');
  const q$ = quest.indexOf("budget.check(null, 'station', 0, Date.now(), null)"), qT = quest.indexOf("budget.checkTokens(null, 'station', 0, Date.now())");
  A.ok(q$ > 0 && qT > q$ && qT < quest.indexOf('provider.stream('), 'quest refresh: a token gate after the $ gate, before the model call');
  const one = body('async function stationOneShot(prompt, tag, failLead)');
  const o$ = one.indexOf("budget.check(null, 'agent', 0, Date.now(), null)"), oT = one.indexOf("budget.checkTokens(null, 'agent', 0, Date.now())");
  A.ok(o$ > 0 && oT > o$ && oT < one.indexOf('provider.stream(') && /if \(unbilledLane\(providerId\)\) \{/.test(one), 'stationOneShot: a token gate once cfg resolves, before the model call');
  A.ok(/wtok = c\.unbilled \? \(c\.weightedTokens \|\| 0\) : 0;/.test(one) && /if \(usd \|\| wtok\) \{ try \{ ledger\.record\(\{.*?weightedTokens: wtok \}\); \} catch \(e\) \{ failNote\(tag \+ '\.ledger', e\); \} \}/.test(one), 'stationOneShot books weighted tokens (the pinned failNote catch kept)');
}

// ---- every aux booking tallies wtok and books on `usd || wtok` ----
for (const h of ['async function runReflection(o)', 'async function runFailureReview(o)', 'async function runStudy(o)', 'async function runThreadMine(o)', 'async function runScoutCycle(o)', 'async function runQuestRefreshCycle(why)']) {
  const b = body(h);
  A.ok(/let usd = 0, tokens = 0, wtok = 0;/.test(b), h + ': declares the weighted tally');
  A.ok(/wtok \+= c\.unbilled \? \(c\.weightedTokens \|\| 0\) : 0;/.test(b), h + ': tallies unbilled weighted tokens beside usd');
  A.ok(/if \(usd \|\| wtok\) \{ try \{ ledger\.record\(\{.*?weightedTokens: wtok \}\)/.test(b), h + ': books on usd || wtok');
  A.ok(!/if \(usd\) \{ try \{ ledger\.record/.test(b), h + ': no $-only booking left');
}

// ---- routes ----
{
  const capsRoute = body('async function handleBudgetCaps(req, res)');
  A.ok(/const hasTok = isObj && budgetCaps\.TOKEN_KEYS\.some\(k => k in body\);/.test(capsRoute) && /const hasUsd = isObj && BUDGET_CAP_KEYS\.some\(k => k in body\);/.test(capsRoute), 'caps route splits the body by key set');
  const vt = capsRoute.indexOf('validateTokenPatch('), vu = capsRoute.indexOf('validateOverridesPatch('), applyU = capsRoute.indexOf('budgetOverrides = v.overrides'), applyT = capsRoute.indexOf('tokenOverrides = tv.overrides');
  A.ok(vt > 0 && vu > vt && applyU > vu && applyT > applyU, 'both halves validate BEFORE either applies');
  A.ok(/if \(hasUsd \|\| !hasTok\) \{/.test(capsRoute), 'an empty body still reaches the $ validator ("no cap fields" 400)');
  const pool = body('function budgetTokenPoolStatus(governor, now)');
  for (const k of ['perDayTokens', 'saved', 'envDefault', 'usedToday', 'cap', 'tripped', 'resumable', 'weights: UNBILLED_WEIGHTS', "estimate: true", "window: 'rolling-24h'", 'perRunTokens: unbilledRunCap()', 'envDefaults: { perDayTokens', 'lane: !!(claudeCliPresent()']) A.ok(pool.indexOf(k) >= 0, 'status tokenPool carries ' + k);
  A.ok(/tokenPool: budgetTokenPoolStatus\(governor, now\)/.test(body('function handleBudgetStatus(req, res)')), 'GET /api/budget/status carries tokenPool');
  const resume = body('async function handleBudgetResume(req, res)');
  A.ok(/if \(scope === 'dayTokens'\) \{[\s\S]*budget\.resumeTokens\(\)/.test(resume), 'POST /api/budget/resume accepts dayTokens');
}

// ---- the loop + adapter seams ----
{
  const loop = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'loop.js'), 'utf8');
  A.ok(/const b = budget\.check\(spentUsd, \{ unbilledTokens \}\);/.test(loop), 'the loop hands the adapter its live weighted tally');
  A.ok(/if \(typeof fb\.maxUnbilledTokens === 'number' && fb\.maxUnbilledTokens > 0\) maxUnbilledTokens = fb\.maxUnbilledTokens;/.test(loop), 'a fallback swap takes its own ceiling');
  A.ok(/unpricedTokens < maxUnpricedTokens && unbilledTokens < maxUnbilledTokens && \(turns < maxIters \|\| graceEnabled\)/.test(loop), 'the steer extension respects the ceiling');
  const sum = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'compaction-summarizer.js'), 'utf8');
  A.ok(/if \(unbilled\) \{ r\.unbilled = true; r\.weightedTokens = weighted; \}/.test(sum), 'the summarizer reports its weighted subscription tokens');
}

// ---- messaging channels name a token stop as a usage limit, never a $ spend cap ----
{
  const { endNote } = require('../sidecar/channels/hub.js');
  const day = endNote('budget', { budgetScope: 'day', budgetUnit: 'tokens', budgetTokens: 15500, budgetCapTokens: 15000 });
  A.ok(/daily subscription usage limit \(~15,500 weighted tokens, an estimate\)/.test(day) && /RESUME/.test(day) && !/\$|spend cap/.test(day), 'a channel day token stop: ' + day);
  const run = endNote('budget', { budgetScope: 'run', budgetUnit: 'tokens', budgetTokens: 21000, budgetCapTokens: 20000 });
  A.ok(/20,000 weighted-token ceiling for subscription use \(an estimate\)/.test(run) && /continue/.test(run), 'a channel run token stop: ' + run);
  const hub = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'channels', 'hub.js'), 'utf8');
  A.ok(/state\.budgetUnit = p\.budgetUnit === 'tokens' \? 'tokens' : null;/.test(hub), 'the hub latches budgetUnit off agent.run.end');
}

A.report('unbilled-guard-wiring');
