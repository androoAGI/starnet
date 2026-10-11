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

// ---- the SETTINGS › SPENDING LIMITS row (frontend/app/stationui.js) ----
const tick = () => new Promise(r => setImmediate(r));
(async () => {
  const station = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
  const slice = station.slice(station.indexOf('  const BG_KEYS ='), station.indexOf('  // MODELS panel'));
  A.ok(slice.length > 0 && slice.length < station.length, 'the BG_KEYS VM slice resolves');
  for (const id of ['budget-tokens', 'budget-tokens-used', 'bgt-perDayTokens', 'bgt-perRunTokens', 'bgt-save', 'bgt-resume', 'budget-token-msg']) {
    A.ok(station.indexOf('id="' + id + '"') > 0, 'the token row has #' + id);
    A.ok(slice.indexOf(id) < 0, '#' + id + ' lives OUTSIDE the BG_KEYS slice budget-authority-ui.test.js runs');
  }
  A.ok(/const BG_KEYS = \['perRun', 'perAgent', 'perDay', 'global'\];/.test(station), 'BG_KEYS is still exactly the four $ keys');
  A.ok(!/id="bg-perDayTokens"/.test(station) && !/bgt-cap[^"]*bg-cap|bg-cap[^"]*bgt-cap/.test(station), 'the token input carries neither the bg- id prefix nor the bg-cap class');
  A.ok(station.indexOf('function wireTokenPool(host)') > 0 && station.indexOf('function wireTokenPool(host)') < station.indexOf('  // BUDGET panel'), 'wireTokenPool is defined before the BUDGET panel (outside the slice)');
  A.ok(/wireBudget\(host\);\s*wireTokenPool\(host\);/.test(station), 'and called beside wireBudget');
  A.ok(/Usage limits <span class="dim">— Claude Code subscription \(weighted tokens, estimate\)<\/span>/.test(station), 'the heading names the subscription and says estimate');
  A.ok(/book \$0, so the USD limits above never see them/.test(station) && /not Anthropic’s own usage meter/.test(station) && /Blank or 0 = off<\/b> — both limits start off/.test(station), 'the explainer: why, the estimate caveat, blank/0 = off, opt-in');
  A.ok(/subscription runs stop \(one already working stops at its next turn\)/.test(station) && !/new subscription runs stop/.test(station), 'the explainer says an in-flight run stops at its next turn');
  A.ok(/across subscription runs and background passes/.test(station) && !/every subscription run and background pass/.test(station), 'no claim about EVERY background pass');
  A.ok(/Per-run limit \(weighted tokens\)/.test(station) && /placeholder="blank = off"/.test(station), 'the per-run field is labelled, and blank reads as off');
  A.ok(/uncached input ×1, cache write ×2, cache read ×0\.1, output ×5/.test(station), 'the explainer states the formula');

  // behaviour, in a VM (the panel's own idiom — budget-authority-ui.test.js)
  const vm = require('vm');
  const code = A.fnBody(station, 'function wireTokenPool(host)');
  A.ok(code.length > 0 && code.length < station.length, 'wireTokenPool body resolves');
  const harness = (statusReply) => {
    const nodes = new Map();
    const node = id => { if (!nodes.has(id)) nodes.set(id, { id, hidden: true, value: '', disabled: false, textContent: '', className: '', attrs: {}, classList: { on: {}, toggle(k, v) { this.on[k] = !!v; } }, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, fn) { this[k] = fn; }, focus() {} }); return nodes.get(id); };
    const posts = [];
    const ctx = { host: { querySelector: node }, sfx() {},
      Harness: { api: { get: async () => (typeof statusReply === 'function' ? statusReply() : statusReply), post: async (u, b) => { posts.push([u, b]); return { ok: true, j: typeof statusReply === 'function' ? statusReply() : statusReply }; } } } };
    vm.runInNewContext(code + ';wireTokenPool(host)', ctx);
    return { node, posts };
  };
  {
    const h = harness({ caps: {} });   // an older sidecar: no tokenPool
    await tick();
    A.eq(h.node('#budget-tokens').hidden, true, 'no tokenPool (older sidecar) -> the section stays hidden');
    const noLane = harness({ tokenPool: { perDayTokens: 0, perRunTokens: 0, cap: 0, usedToday: 0, tripped: false, lane: false } });
    await tick();
    A.eq(noLane.node('#budget-tokens').hidden, true, 'lane:false (no Claude Code on this station) -> hidden');
  }
  {
    let st = { tokenPool: { perDayTokens: 0, cap: 0, usedToday: 10500, tripped: false, estimate: true } };
    const h = harness(() => st);
    await tick();
    A.eq(h.node('#budget-tokens').hidden, false, 'a tokenPool shows the section');
    A.ok(/≈ 10,500 weighted tokens in the last 24 h \(estimate\)/.test(h.node('#budget-tokens-used').textContent), 'the use reads as an estimate: ' + h.node('#budget-tokens-used').textContent);
    A.eq(h.node('#bgt-resume').hidden, true, 'RESUME hidden unless tripped');
    h.node('#bgt-save').click(); await tick();
    A.eq(h.posts.length, 0, 'an untouched (blank = off) field posts nothing');
    h.node('#bgt-perDayTokens').value = '1.5'; h.node('#bgt-save').click(); await tick();
    A.eq(h.posts.length, 0, 'a fractional value is refused before posting');
    st = { tokenPool: { perDayTokens: 15000, cap: 15000, usedToday: 21000, tripped: true, estimate: true } };
    h.node('#bgt-perDayTokens').value = '15000'; h.node('#bgt-save').click(); await tick();
    A.eq(h.posts[0], ['/api/budget/caps', { perDayTokens: 15000 }], 'SAVE posts { perDayTokens }');
    A.eq([h.node('#bgt-resume').hidden, h.node('#budget-tokens-used').classList.on.tripped], [false, true], 'a tripped pool shows RESUME and marks the readout');
    h.node('#bgt-resume').click(); await tick();
    A.eq(h.posts[1], ['/api/budget/resume', { scope: 'dayTokens' }], 'RESUME posts scope dayTokens');
    A.eq([h.node('#bgt-perDayTokens').value, h.node('#bgt-perRunTokens').value], ['15000', ''], 'an off per-run limit paints BLANK, never 0');
    A.ok(/per-run limit off/.test(h.node('#budget-tokens-used').textContent), 'and the readout says it is off');
    st = { tokenPool: { perDayTokens: 15000, perRunTokens: 40000, cap: 15000, usedToday: 21000, tripped: true, lane: true } };
    h.node('#bgt-perRunTokens').value = '40000'; h.node('#bgt-save').click(); await tick();
    A.eq(h.posts[2], ['/api/budget/caps', { perRunTokens: 40000 }], 'SAVE posts only the changed per-run limit');
    A.ok(/per-run limit 40,000/.test(h.node('#budget-tokens-used').textContent), 'the saved per-run limit is read back');
    h.node('#bgt-perRunTokens').value = ''; h.node('#bgt-save').click(); await tick();
    A.eq(h.posts[3], ['/api/budget/caps', { perRunTokens: 0 }], 'blanking it posts 0 = off');
  }
  {
    const h = harness({ tokenPool: { perDayTokens: 15000, cap: 15000, usedToday: null, tripped: false } });
    await tick();
    A.ok(/unavailable/.test(h.node('#budget-tokens-used').textContent) && !/≈ 0/.test(h.node('#budget-tokens-used').textContent), 'unknown use reads "unavailable", never a guessed 0');
  }

  // ---- COMMS names the token stop (frontend/app/chat.js) and the stream carries its fields (harness.js) ----
  const chat = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
  const stopLine = new Function(A.fnBody(chat, 'function budgetStopLine(') + '\nreturn budgetStopLine;')();
  A.eq(stopLine('day', null, false, { unit: 'tokens', tokens: 15500, cap: 15000 }), 'hit the daily subscription usage limit (~15,500 weighted tokens, an estimate) — raise it, turn it off, or RESUME in SETTINGS › SPENDING LIMITS', 'a day token stop');
  A.eq(stopLine('run', null, false, { unit: 'tokens', tokens: 21000, cap: 20000 }), 'this run used its 20,000 weighted-token ceiling for subscription use (an estimate) — say "continue" to keep going, or raise the per-run limit in SETTINGS › SPENDING LIMITS', 'a run token stop');
  // the stop's door: a usage stop gets a usage-limit door; the $ door, its label and call literal are unchanged
  A.ok(/\{ if \(endReason === 'budget' && budgetUnit === 'tokens'\) offerBudgetDoor\(false, true\); else if \(endReason === 'budget'\) offerBudgetDoor\(budgetCapIsBalance\); else offerTryAgain\(\); \}/.test(chat), 'a token stop opens the usage-limit door');
  {
    let row = null;
    const offer = new Function('choices', 'retryLast', 'StationUI', 'Friendly', A.fnBody(chat, 'function offerBudgetDoor(') + '\nreturn offerBudgetDoor;')(
      (items) => { row = items; }, () => {}, { openTerm() {} }, { actionButton: () => ({ label: 'TOP UP', run() {} }) });
    offer(false, true); A.eq(row[0].label, '◷ OPEN USAGE LIMITS', 'usage door label (no $)');
    offer(false); A.eq(row[0].label, '$ OPEN SPENDING LIMITS', '$ door label unchanged');
    offer(true, true); A.eq(row[0].label, '◷ OPEN USAGE LIMITS', 'a usage stop never offers the top-up door');
  }
  A.ok(/^hit the \$25 daily spend cap — raise or remove it/.test(stopLine('day', 25, false)), 'the $ stop lines are unchanged');
  A.ok(/budgetUnit === 'tokens' \? budgetStopLine\(budgetScope, null, false, \{ unit: 'tokens', tokens: budgetTokens, cap: budgetCapTokens \}\) : budgetStopLine\(budgetScope, budgetCapUsd, budgetCapIsBalance\)/.test(chat), 'the caller routes a token stop to the token line');
  A.ok(/budgetUnit === 'tokens' \? 'hit a usage limit' : 'hit a spending limit'/.test(chat), 'the background notice says "usage limit" for a token stop');
  const harnessSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'harness.js'), 'utf8');
  A.ok(/budgetUnit = payload\.budgetUnit === 'tokens' \? 'tokens' : null;/.test(harnessSrc) && (harnessSrc.match(/budgetUnit, budgetTokens, budgetCapTokens, budgetScope, budgetCapUsd, budgetCapIsBalance \};/g) || []).length === 2, 'Harness.chat latches and returns the token stop fields');

  A.report('unbilled-guard-wiring');
})().catch(e => { console.log('FAIL: unbilled-guard-wiring threw - ' + (e && e.stack || e)); process.exit(1); });
