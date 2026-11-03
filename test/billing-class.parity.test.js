/* node test/billing-class.parity.test.js — ONE BILLING CLASS PER CALL ATTEMPT (spend-governor S1).

   Every billing decision a run makes used to be its own inline reading of a provider profile (ten
   getProviderProfile(...).unmetered reads, three copies of the managed rule, the Codex/device-OAuth exemption, the aux
   ceiling's adapter rule, the loop's usage.subscription). They drifted: a ChatGPT, Grok or Kimi call says nothing about a
   subscription, so the per-run sign-in seatbelt never counted one (a Codex run under a 100,000-token seatbelt ran 8 calls,
   320,000 tokens, to max_iters). sidecar/billing-class.js holds the one table; the call sites and the loop ask it.

   SOURCE: no inline profile.unmetered read or managed rule remains outside billing-class.js (test/helpers/source.js), and
   runOnceCore hands the loop the run's classifier and books its rows from what the attempts were.
   LOOP: driven with the production classifier, every sign-in attempt counts toward the seatbelt — on the route it ran on,
   across a provider fallback — and a metered one never does. With no classifier the legacy rule holds.
   GOLDEN: test/fixtures/billing-class.golden.json holds what base sidecar/index.js decided, evaluated from its own source
   text at 0b8441064, for every registry profile and option (credits configured or not, a CREDITS_URL deployment, a caller
   cap, a line ceiling, PER RUN). This test evaluates the CALL SITES that replaced those expressions, sliced from the
   sidecar as it is now, against the real registry, and allows only the deliberate changes listed in DELIBERATE.
   LEDGER: a row that names its payer is unmetered exactly when the payer is a plan or a local model.
   GOVERNOR (S2): makeGovernor admits every paid call path by POLICY: a dollar payer meets the cross-run caps, a plan or a local
   model never does, an image always does, a background pass meets the 24-hour token ceiling on a route that may sign in unless
   the Commander triggered it, and a check that throws (the budget, the payer lookup, the token gate) refuses with its exit. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const { readSidecarSource } = require('./helpers/source.js');
const registry = require('../sidecar/providers/registry.js');
const budgetCaps = require('../sidecar/budgetcaps.js');
const { mediaRunFlags } = require('../sidecar/spend.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { makeLedger } = require('../sidecar/ledger.js');

const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'billing-class.golden.json'), 'utf8'));
let BillingClass = null, loadError = '';
try { BillingClass = require('../sidecar/billing-class.js'); } catch (e) { loadError = (e && e.message) || String(e); }
const src = readSidecarSource();

/* THE DELIBERATE CHANGES (spend-governor S1; Andrew decisions 1 and 5). Everything else equals the base golden.
   - the sign-in seatbelt counts every ChatGPT, Grok and Kimi attempt, whatever its usage says;
   - a Claude Code run on a subscription login is a subscription run: its rows are unmetered (INSIGHTS and RUNS say
     "subscription", never $0.00), and a cut call on it is no dollar floor. With paid images its row stays metered. */
const SIGN_IN_PLANS = ['codex', 'grok', 'kimi'];
const DELIBERATE = {
  seatbeltCounts: (id) => SIGN_IN_PLANS.includes(id) ? { plain: true, costZero: true, signIn: true, priced: true } : null,
  runRow: (id) => id === 'claude-cli' ? { 'signIn media=0': { unmetered: true, usageMissingIfCut: false }, 'signIn media=0.04': { unmetered: false, usageMissingIfCut: false } } : null
};

// ---- slicing the sidecar's own call sites ----
function at(needle) {
  const i = src.indexOf(needle);
  if (i < 0) throw new Error('call site not found: ' + needle.slice(0, 90));
  if (src.indexOf(needle, i + 1) >= 0) throw new Error('call site not unique: ' + needle.slice(0, 90));
  return i;
}
function line(needle) { const i = at(needle); return src.slice(src.lastIndexOf('\n', i) + 1, src.indexOf('\n', i)); }
function through(start, end) { const i = at(start); const j = src.indexOf(end, i); if (j < 0) throw new Error('end not found: ' + end); return src.slice(i, j + end.length); }
const enc = v => (v === undefined ? 'undefined' : (typeof v === 'number' && !isFinite(v)) ? String(v) : v);

// ---- 1. SOURCE: one place decides who pays ----
{
  const offenders = [];
  let file = '';
  src.split('\n').forEach(l => {
    const m = /^\/\* ---- (sidecar\/[^ ]+) ---- \*\/$/.exec(l);
    if (m) { file = m[1]; return; }
    if (file === 'sidecar/billing-class.js' || /^\s*(\/\/|\*|\/\*)/.test(l)) return;
    const code = l.replace(/\/\/.*$/, '');
    const profileRead = (/getProviderProfile\(/.test(code) && /\bunmetered\b/.test(code)) || /\b(profile|Profile|prof)\??\.unmetered\b/.test(code) || /\?\.unmetered\b/.test(code);
    const projection = file === 'sidecar/providers/registry.js' && /^\s*unmetered: !!profile\.unmetered,$/.test(l);   // toPublicProfile: the registry's own field, published
    const managedRule = /=== 'starnet' \|\| !!CREDITS_URL/.test(code) || /credits\.configured\(\) && !\w*[Uu]nmetered/.test(code);
    if ((profileRead && !projection) || managedRule) offenders.push((file || 'sidecar/index.js') + ': ' + l.trim().slice(0, 110));
  });
  A.eq(offenders, [], 'no inline profile.unmetered read or managed rule outside sidecar/billing-class.js');
  A.ok(/^const billing = BillingClass\.makeBilling\(\{ profileOf: getProviderProfile, creditsConfigured: \(\) => credits\.configured\(\), creditsUrl: CREDITS_URL \}\);$/m.test(src),
    'index.js binds the one billing object to the registry, the credits link and the CREDITS_URL deployment');
  const core = src.indexOf('async function runOnceCore(o) {'), next = src.indexOf('\nasync function ', core + 10);
  for (const call of ['billing.runBillingFor({ providerId, callerCapUsd: o.maxCostUsd, ceilingUsd: o.ceilingUsd, perRunUsd: effectiveCaps.perRun })',
    'billing.spendPoolCapFor({ runCapUsd, policy: runBilling.policy, perRunUsd: effectiveCaps.perRun })',
    'billing.fallbackBillingFor({ providerId: fbProviderId, runManaged: managedRun, runCapUsd, callerCapUsd: o.maxCostUsd, perRunUsd: effectiveCaps.perRun, unpricedTokens: CAPS.maxUnpricedTokens })',
    '      billingClassOf: runBilling.classify,',
    "          if (typeof next.billingClassOf === 'function') runRoutes.push(next.billingClassOf);",
    '    const rowClass = billing.runRowClass({ routes: runRoutes, attempts: result && result.billingClasses });',
    'model: finalModel, billingClass: rowBillingClass, unmetered: mediaFlags.unmetered,']) {
    const i = src.indexOf(call);
    A.ok(i > core && i < next, 'runOnceCore: ' + call.trim().slice(0, 70));
  }
}

// ---- 2. LOOP: every sign-in attempt counts toward the seatbelt, by the route it ran on ----
const live = BillingClass ? BillingClass.makeBilling({ profileOf: registry.getProviderProfile }) : null;
// the classifier runOnceCore hands the loop (runBillingFor(...).classify); without the module, a stand-in so the loop's own behaviour is what is tested
const classifierOf = id => live ? live.runBillingFor({ providerId: id }).classify
  : (u => (u && u.subscription === true) || SIGN_IN_PLANS.includes(id) ? 'subscription' : 'metered');
const TOOL = [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }];
const CODEX_USAGE = { prompt_tokens: 30000, completion_tokens: 10000, total_tokens: 40000, prompt_tokens_details: { cached_tokens: 0 }, cost: 0 };
function toolProvider(usage, opts) {
  opts = opts || {};
  let n = 0;
  return {
    calls: () => n, priceOf: () => null, contextLimit: () => 0, supportsTools: () => true,
    stream: async function* () {
      n++;
      yield { type: 'tool_start', index: 0, id: 'c' + n, name: 'noop' }; yield { type: 'tool_args', index: 0, chunk: '{}' };
      yield { type: 'usage', usage: JSON.parse(JSON.stringify(usage)) };
      if (opts.failFirst && n === 1) throw new Error('Our servers are currently overloaded. Please try again later.');
      yield { type: 'done', finishReason: 'tool_calls' };
    }
  };
}
function drive(provider, extra, limits) {
  const ends = [];
  return runAgentLoop(Object.assign({
    messages: [{ role: 'user', content: 'go' }], isTask: true, model: 'm', runId: 'seatbelt', agentId: 'seatbelt', tools: TOOL, provider,
    emit: (n, p) => { if (n === 'agent.run.end') ends.push(p); }, cost: makeCostEngine({ priceOf: () => null }),
    dispatch: async () => ({ ok: true, content: 'ok' }), sleep: async () => {},
    limits: Object.assign({ maxIters: 8, grace: false, maxCostUsd: Infinity, maxUnpricedTokens: Infinity, maxSubscriptionTokens: 100000 }, limits || {})
  }, extra || {})).then(r => ({ r, end: ends[ends.length - 1] || {} }));
}
const loopPart = (async () => {
  for (const id of SIGN_IN_PLANS) {
    const p = toolProvider(CODEX_USAGE);
    const { r, end } = await drive(p, { billingClassOf: classifierOf(id) });
    A.eq([r.reason, p.calls(), end.subscriptionCapTokens, r.subscriptionTokens], ['budget', 3, 100000, 120000],
      id + ': a sign-in attempt that reports no subscription flag counts — the run stops at the 100,000-token seatbelt after 3 calls (was max_iters after 8)');
    A.eq(r.billingClasses, ['subscription'], id + ': the run reports what its attempts were');
    A.ok(/SIGN-IN TOKEN CEILING/.test(r.budgetNote || '') && /STARNET_MAX_SUBSCRIPTION_TOKENS/.test(r.budgetNote || ''), id + ': the loop\'s own stop note names the knob: ' + r.budgetNote);
  }
  {
    const p = toolProvider(Object.assign({}, CODEX_USAGE, { cost: 0, subscription: true }));
    const { r } = await drive(p, { billingClassOf: classifierOf('claude-cli') });
    A.eq([r.reason, p.calls(), r.billingClasses], ['budget', 3, ['subscription']], 'claude-cli: a subscription login counts, as before');
    const k = toolProvider(Object.assign({}, CODEX_USAGE, { cost: 0.01 }));
    const key = await drive(k, { billingClassOf: classifierOf('claude-cli') });
    A.eq([key.r.reason, k.calls(), key.r.billingClasses], ['max_iters', 8, ['metered']], 'claude-cli: an API-key login is metered and never meets the seatbelt');
  }
  for (const id of ['openrouter', 'anthropic', 'custom', 'ollama']) {
    const p = toolProvider(Object.assign({}, CODEX_USAGE, { cost: 0.001 }));
    const { r } = await drive(p, { billingClassOf: classifierOf(id) });
    A.eq([r.reason, p.calls()], ['max_iters', 8], id + ': a ' + (id === 'ollama' ? 'local' : 'metered') + ' attempt never meets the sign-in seatbelt');
  }
  // across a provider fallback: an attempt counts by the route it RAN on, and the fallback's classifier applies from its first attempt
  {
    const primary = toolProvider(Object.assign({}, CODEX_USAGE, { cost: 0.001 }), { failFirst: true });
    const plan = toolProvider(CODEX_USAGE);
    const { r } = await drive(primary, { billingClassOf: classifierOf('openrouter'), fallbacks: [{ provider: plan, providerId: 'codex', model: 'gpt-5.5', billingClassOf: classifierOf('codex') }] }, { maxSubscriptionTokens: 60000 });
    A.eq([r.reason, primary.calls(), plan.calls(), r.billingClasses], ['budget', 1, 2, ['metered', 'subscription']],
      'a key run that falls back onto a ChatGPT plan: its own failed attempt never counts, the plan\'s two calls reach the 60,000 seatbelt');
    const plan2 = toolProvider(CODEX_USAGE, { failFirst: true });
    const key2 = toolProvider(Object.assign({}, CODEX_USAGE, { cost: 0.001 }));
    const back = await drive(plan2, { billingClassOf: classifierOf('codex'), fallbacks: [{ provider: key2, providerId: 'openrouter', model: 'o/m', billingClassOf: classifierOf('openrouter') }] }, { maxSubscriptionTokens: 60000 });
    A.eq([back.r.reason, back.r.billingClasses], ['max_iters', ['subscription', 'metered']], 'a plan run that falls back onto a key: the plan\'s failed attempt is a sign-in attempt, the key\'s are metered');
  }
  // no classifier (every other caller): the legacy rule, and the result is unchanged
  {
    const p = toolProvider(CODEX_USAGE);
    const { r } = await drive(p);
    A.eq([r.reason, p.calls(), 'billingClasses' in r], ['max_iters', 8, false], 'with no classifier only usage.subscription counts, and the result carries no billingClasses');
  }
})();

// ---- 3. GOLDEN: every decision, through the call sites as they are now ----
const goldenPart = loopPart.then(async () => {
  if (!BillingClass) { A.ok(false, 'sidecar/billing-class.js loads: ' + loadError); return; }
  const getProviderProfile = registry.getProviderProfile;
  const normalizeProviderId = registry.normalizeProviderId;
  const normalizeProvider = id => normalizeProviderId(id, 'openrouter');
  const bind = new Function('BillingClass', 'getProviderProfile', 'credits', 'CREDITS_URL',
    line('const billing = BillingClass.makeBilling({ profileOf: getProviderProfile,') + '\nreturn billing;');
  const billingFor = (configured, url) => bind(BillingClass, getProviderProfile, { configured: () => configured }, url);
  const plain = billingFor(false, '');

  const unmeteredOf = new Function('billing', 'providerId', line('  let providerUnmetered = !billing.policyOf(providerId).ledgerMetered;') + '\nreturn providerUnmetered;');
  const runCapOf = new Function('billing', 'providerId', 'o', 'effectiveCaps',
    through('  const runBilling = billing.runBillingFor(', '  let runCapUsd = runBilling.runCapUsd;') + '\nreturn { runBilling, runCapUsd, runRoutes };');
  const managedOf = new Function('runBilling', line('  const managedRun = runBilling.managed;') + '\nreturn managedRun;');
  const poolOf = new Function('billing', 'runCapUsd', 'runBilling', 'effectiveCaps', line('  const spendPoolCapUsd = billing.spendPoolCapFor(') + '\nreturn spendPoolCapUsd;');
  const limitsOf = new Function('runBilling', 'CAPS', 'return {' + through('        maxUnpricedTokens: runBilling.policy.unpricedTokenCeiling', 'maxSubscriptionTokens: CAPS.maxSubscriptionTokens') + '};');
  const fbAdmit = through('    const fbBilling = billing.fallbackBillingFor(', '    if (!fbBilling) continue;');
  const fbPush = line('    providerFallbacks.push(Object.assign({ provider: fbProvider, providerId: fbProviderId, model: fbModel,');
  const fallbackOf = new Function('billing', 'fbProviderId', 'managedRun', 'runCapUsd', 'o', 'effectiveCaps', 'CAPS', 'fbProvider', 'fbModel', 'fbKey', 'makeCostEngine',
    'const providerFallbacks = [];\n' + fbAdmit.replace(/continue;$/, 'return null;') + '\n' + fbPush + '\nreturn providerFallbacks[0];');
  // the governor the host binds (index.js: budget, auxTokenGate, billing.classOf), over a budget that counts its checks
  const governed = (b, gate) => { const budget = { n: 0, check() { this.n++; return null; } }; return { budget, governor: BillingClass.makeGovernor({ budget, auxTokenGate: gate || (() => ({ blocked: false })), classOfProvider: id => b.classOf(id) }) }; };
  const runBudgetOf = new Function('governor', 'activeProviderId', 'agentId', 'runId', 'emit', 'runReceiptMeta', 'spendPool',
    through("  const runBudget = { check: (spentThisRun, nextCallUsd) => governor.admit('run',", '}) };') + '\nreturn runBudget;');
  const crossOf = id => { const g = governed(plain); runBudgetOf(g.governor, id, 'a', 'r', null, () => ({}), { admit: () => null, withdraw() {} }).check(0, 0); return g.budget.n === 1; };
  const bookOf = new Function('name', 'providerUnmetered', 'spendPool', 'runId', 'payload', line("      if (name === 'agent.cost' && !providerUnmetered) spendPool.booked(runId, Number(payload.usd) || 0);") + '\nreturn spendPool.n;');
  const auxStopOf = new Function('result', '_auxCandidates', 'governor', 'activeProviderId', 'agentId', line("  const _auxStop = (result && result.reason === 'budget')") + '\nreturn _auxStop;');
  const auxOf = id => { const g = governed(plain); auxStopOf({ reason: 'done' }, ['reflection'], g.governor, id, 'a'); return g.budget.n === 1; };
  const fbFlipOf = new Function('next', 'providerUnmetered', 'runUnmetered', 'runRoutes', through("          if (typeof next.unmetered === 'boolean') providerUnmetered = next.unmetered;", 'runRoutes.push(next.billingClassOf);') + '\nreturn runUnmetered;');
  const finalizerOf = new Function('billing', 'BillingClass', 'runRoutes', 'result', 'finalUsd', 'mediaUsd', 'mediaUnpriced', 'mediaRunFlags', 'runEntry',
    line('    const thrownCalled = !result && !!runEntry && runEntry.called;') + '\n' +
    line('    const loopUsd = (result && result.usd) || (thrownCalled ? runEntry.usd : 0);') + '\n' +
    through('    const rowClass = billing.runRowClass({ routes: runRoutes,', 'const rowBillingClass = billing.bookedClass(rowClass, mediaFlags.unmetered);') + '\nreturn { unmetered: mediaFlags.unmetered, usageMissing, billingClass: rowBillingClass };');
  const auxRouteOf = new Function('normalizeProviderId', 'billing', through('function auxRoute(id) {', 'function auxCeilingRoute(id) { return billing.auxCeilingRoute(auxRoute(id)); }') + '\nreturn auxCeilingRoute;')(normalizeProviderId, plain);
  const exprOf = (needle, re, variable) => { const m = line(needle).match(re); if (!m) throw new Error('expression not found: ' + needle.slice(0, 60)); return new Function('billing', variable, 'return (' + m[0] + ');').bind(null, plain); };
  const POLICY_READ = /!billing\.policyOf\(\w+\)\.\w+/;
  const rehydrateOf = exprOf('    unmetered: !billing.policyOf(providerId).ledgerMetered\n  });', POLICY_READ, 'providerId');
  const questAdmitOf = new Function('governor', 'providerId', 'why', line("    const blocked = governor.admit('quest-refresh', { providerId, agentId: 'station',") + '\nreturn blocked;');
  const questCheckOf = id => { const g = governed(plain); questAdmitOf(g.governor, id, 'manual'); return g.budget.n === 1; };
  const questBookOf = exprOf("    try { spend.book({ runId: 'questrefresh-' + Date.now(), agentId: 'station', model: model || '', unmetered: ", POLICY_READ, 'providerId');
  const oneshotRowOf = new Function('billing', 'BillingClass', 'providerId', 'usage', line('    const billingClass = billing.auxRowClass(providerId, usage.subscription === true), unmetered = ') + '\nreturn { billingClass, unmetered };').bind(null, plain, BillingClass);
  const oneshotOf = id => oneshotRowOf(id, GOLDEN.grid.usage.plain).unmetered;
  const voiceTierOf = exprOf('  const tierCeiling = promptTierCeiling(tProvider, setting.model, ', POLICY_READ, 'tProvider');
  const modelsTierOf = exprOf('    const tierExempt = !billing.policyOf(id).promptTier;', POLICY_READ, 'id');
  const runTierOf = new Function('promptTierCeiling', 'activeProviderId', 'model', 'providerUnmetered', line('  const runWindowCeiling = () => promptTierCeiling(activeProviderId, model, providerUnmetered);') + '\nreturn runWindowCeiling();');
  const evalOf = new Function('billing', 'normalizeProvider', 'cfg', 'effectiveCaps', 'MANAGED_PER_RUN_DEFAULT', 'budgetCaps',
    through('    const providerId = normalizeProvider(cfg.provider);\n    const evalBilling = billing.evaluationBillingFor(', '    const { unmetered, managed } = evalBilling;') + '\nreturn { unmetered, managed, perRunCap: evalBilling.perRunCapUsd };');
  A.ok(/SkillEvaluationRunner\.evaluationLimits\(\{ cases: evalSuite \? evalSuite\.cases\.length : 0, runCapUsd: evalBilling\.perRunCapUsd \}\)/.test(src), 'the evaluation sizes its limits from that cap');

  // one booked attempt with this usage, driven as runOnceCore drives the loop (its classifier), then the finalizer's rows
  async function attemptRun(classify, usage) {
    const p = toolProvider(Object.assign({}, usage));
    const { r } = await drive(p, { billingClassOf: classify }, { maxIters: 2, maxSubscriptionTokens: 1 });
    return { counted: r.reason === 'budget' && r.subscriptionCapTokens === 1, billingClasses: r.billingClasses };
  }

  const G = GOLDEN.grid;
  const CALLER = G.callerCapUsd.map(k => [k, k === '-' ? undefined : Number(k)]);
  const LINE = G.ceilingUsd.map(k => [k, k === '-' ? undefined : Number(k)]);
  const PERRUN = G.perRunUsd.map(k => [k, Number(k)]);
  const CREDITS = G.credits.map(k => [k, k !== '0', k === '1url' ? 'https://credits.example.test' : '']);
  const diffs = [], changed = [];
  const same = (where, got, want, deliberate) => {
    if (deliberate !== undefined) {
      if (JSON.stringify(got) !== JSON.stringify(deliberate)) diffs.push(where + ': got ' + JSON.stringify(got) + ', the deliberate change says ' + JSON.stringify(deliberate));
      else if (JSON.stringify(deliberate) !== JSON.stringify(want)) changed.push(where);
      return;
    }
    if (JSON.stringify(got) !== JSON.stringify(want)) diffs.push(where + ': got ' + JSON.stringify(got) + ', base ' + JSON.stringify(want));
  };

  A.eq(Object.keys(GOLDEN.providers).sort(), registry._profiles.map(p => p.id).sort(), 'the golden covers every provider profile in the registry');
  for (const id of Object.keys(GOLDEN.providers)) {
    const want = GOLDEN.providers[id], got = { runCapUsd: {}, managedRun: {}, spendPoolCapUsd: {}, limits: {}, evaluation: {}, seatbeltCounts: {}, runRow: {} };
    const unmetered = unmeteredOf(plain, id);
    got.unmetered = unmetered;
    for (const [ck, cv] of CALLER) for (const [lk, lv] of LINE) for (const [pk, pv] of PERRUN) {
      const r = runCapOf(plain, id, { maxCostUsd: cv, ceilingUsd: lv }, { perRun: pv });
      const key = 'cap=' + ck + ' line=' + lk + ' perRun=' + pk;
      got.runCapUsd[key] = enc(r.runCapUsd);
      got.spendPoolCapUsd[key] = enc(poolOf(plain, r.runCapUsd, r.runBilling, { perRun: pv }));
    }
    for (const [k, configured, url] of CREDITS) got.managedRun['credits=' + k] = managedOf(runCapOf(billingFor(configured, url), id, {}, { perRun: 0 }).runBilling);
    for (const t of G.unpricedTokens) {
      const l = limitsOf(runCapOf(plain, id, {}, { perRun: 0 }).runBilling, { maxUnpricedTokens: t, maxSubscriptionTokens: 2000000 });
      got.limits['unpriced=' + t] = { maxUnpricedTokens: enc(l.maxUnpricedTokens), maxSubscriptionTokens: enc(l.maxSubscriptionTokens) };
    }
    got.crossRunCheck = crossOf(id);
    { const sp = { n: 0, booked() { this.n++; } }; got.poolBooking = bookOf('agent.cost', unmetered, sp, 'r', { usd: 1 }) === 1; }
    got.auxDollarCheck = auxOf(id);
    { let seen = null; got.runWindowTierExempt = runTierOf((p, m, u) => { seen = u; return 0; }, id, 'm', unmetered) === 0 && seen; }
    got.auxCeilingRoute = auxRouteOf(id);
    got.rehydrateUnmetered = rehydrateOf(id);
    got.questRefreshChecks = questCheckOf(id);
    got.questRefreshBookUnmetered = questBookOf(id);
    got.oneshotBookUnmetered = oneshotOf(id);
    got.voiceTierExempt = voiceTierOf(id);
    got.modelsTierExempt = modelsTierOf(id);
    for (const [k, configured, url] of CREDITS) for (const [pk, pv] of PERRUN.slice(0, 2)) for (const md of G.managedDefaultUsd) {
      const e = evalOf(billingFor(configured, url), normalizeProvider, { provider: id }, { perRun: pv }, md, budgetCaps);
      got.evaluation['credits=' + k + ' perRun=' + pk + ' managedDefault=' + md] = { unmetered: e.unmetered, managed: e.managed, perRunCap: enc(e.perRunCap) };
    }
    const routes = runCapOf(plain, id, {}, { perRun: 0 }).runRoutes;
    for (const [uk, u] of Object.entries(G.usage)) {
      const a = await attemptRun(routes[0], u);
      got.seatbeltCounts[uk] = a.counted;
      for (const media of [0, 0.04]) {
        const row = finalizerOf(plain, BillingClass, routes, { reason: 'cancelled', streamCut: true, billingClasses: a.billingClasses }, media, media, 0, mediaRunFlags);
        got.runRow[uk + ' media=' + media] = { unmetered: row.unmetered, usageMissingIfCut: row.usageMissing };
        // the row names its payer, and unmetered is true exactly for a plan or a local model
        const payer = (id === 'claude-cli' && uk === 'signIn') ? 'subscription' : plain.classOf(id);
        const expect = (media > 0 && !BillingClass.POLICY[payer].ledgerMetered) ? 'metered' : payer;
        A.eq([row.billingClass, row.unmetered], [expect, !BillingClass.POLICY[expect].ledgerMetered], id + ' ' + uk + ' media=' + media + ': the row\'s billingClass and its unmetered flag agree');
      }
    }
    const deliberate = { seatbeltCounts: DELIBERATE.seatbeltCounts(id), runRow: DELIBERATE.runRow(id) };
    for (const k of Object.keys(want)) {
      if (want[k] && typeof want[k] === 'object') for (const kk of Object.keys(want[k])) same(id + '.' + k + '[' + kk + ']', got[k][kk], want[k][kk], deliberate[k] ? deliberate[k][kk] : undefined);
      else same(id + '.' + k, got[k], want[k]);
    }
  }
  for (const pair of Object.keys(GOLDEN.fallbacks)) {
    const [p, fb] = pair.split('>');
    const want = GOLDEN.fallbacks[pair];
    const run = runCapOf(plain, p, {}, { perRun: 0 });
    const entry = fallbackOf(plain, fb, false, Infinity, {}, { perRun: 0 }, { maxUnpricedTokens: 2000000 }, { priceOf: () => null }, 'm', '', () => ({}));
    const pu = unmeteredOf(plain, p);
    same(pair + '.runUnmeteredAfter', fbFlipOf(entry, pu, pu, run.runRoutes), want.runUnmeteredAfter);
    // the row of a run that moved routes: what both routes were, never a per-call route's sign-in (no change from base)
    const both = finalizerOf(plain, BillingClass, run.runRoutes, { billingClasses: [run.runRoutes[0](GOLDEN.grid.usage.signIn), entry.billingClassOf(GOLDEN.grid.usage.plain)] }, 0, 0, 0, mediaRunFlags);
    same(pair + '.rowUnmeteredAfter', both.unmetered, want.runUnmeteredAfter);
    A.eq([typeof entry.billingClassOf, entry.billingClassOf.cls], ['function', plain.classOf(fb)], pair + ': the fallback entry carries its route\'s classifier');
    for (const [k, configured, url] of CREDITS) for (const [ck, cv] of CALLER) for (const [pk, pv] of PERRUN.slice(0, 2)) {
      const b = billingFor(configured, url);
      const r = runCapOf(b, p, { maxCostUsd: cv }, { perRun: pv });
      const e = fallbackOf(b, fb, managedOf(r.runBilling), r.runCapUsd, { maxCostUsd: cv }, { perRun: pv }, { maxUnpricedTokens: 2000000 }, { priceOf: () => null }, 'm', '', () => ({}));
      const key = 'credits=' + k + ' cap=' + ck + ' perRun=' + pk;
      same(pair + '.entry[' + key + ']', e ? [e.unmetered, enc(e.maxCostUsd), enc(e.maxUnpricedTokens)] : null, want.entry[key]);
      if (e) A.ok(e.provider && e.providerId === fb && e.model === 'm' && e.credKey === null && !!e.cost, pair + ' ' + key + ': the entry keeps its provider, model, key and cost engine');
    }
  }
  A.eq(diffs, [], 'every billing decision equals the base golden or its listed deliberate change');
  A.eq(changed.length, 3 * 3 + 2, 'exactly the listed rows changed: ' + changed.join(', '));
});

// ---- 4. LEDGER: a row that names its payer ----
const ledgerPart = goldenPart.then(() => {
  const rows = [];
  const L = makeLedger({ io: { readAll: () => [], append: r => rows.push(r) }, clock: { now: () => 1000 } });
  const sub = L.record({ runId: 'a', agentId: 'x', usd: 0, tokens: 10, model: 'm', billingClass: 'subscription' });
  const met = L.record({ runId: 'b', agentId: 'x', usd: 2, tokens: 10, model: 'm', billingClass: 'metered', unmetered: true });
  const legacy = L.record({ runId: 'c', agentId: 'x', usd: 3, tokens: 10, model: 'm', unmetered: true });
  const odd = L.record({ runId: 'd', agentId: 'x', usd: 4, tokens: 10, model: 'm', billingClass: 'free' });
  A.eq([sub.billingClass, sub.unmetered], ['subscription', true], 'a subscription row is unmetered');
  A.eq([met.billingClass, met.unmetered], ['metered', false], 'a row is never both: its payer decides the flag');
  A.eq(['billingClass' in legacy, legacy.unmetered, 'billingClass' in odd, odd.unmetered], [false, true, false, false], 'a row with no (or an unknown) payer keeps the legacy flag and names none');
  A.eq(L.totalUsd(), 6, 'the metered folds count the metered rows and the legacy rule');
  A.eq(rows.map(r => JSON.stringify(r)), [sub, met, legacy, odd].map(r => JSON.stringify(r)), 'what is appended is what is recorded');
});

// ---- 5. GOVERNOR (spend-governor S2): one admission per paid call, routed by POLICY, with one error rule ----
const governorPart = ledgerPart.then(async () => {
  if (!BillingClass || typeof BillingClass.makeGovernor !== 'function') { A.ok(false, 'billing-class.js exports makeGovernor'); return; }
  const billing = BillingClass.makeBilling({ profileOf: registry.getProviderProfile });
  const CAP = { scope: 'day', usd: 5, cap: 1 };
  function rig(o) {
    o = o || {};
    const seen = { checks: [], errors: [] };
    const budget = { check: (...a) => { seen.checks.push(a); if (o.throwCheck) throw new Error('ledger down'); return o.verdict === undefined ? CAP : o.verdict; } };
    const auxTokenGate = id => { if (o.throwGate) throw new Error('gate down'); return { blocked: !!o.tokensReached && billing.auxCeilingRoute(id), used: 250000, ceiling: 200000 }; };
    const classOfProvider = id => { if (o.throwClass) throw new Error('registry down'); return billing.classOf(id); };
    return { seen, governor: BillingClass.makeGovernor({ budget, auxTokenGate, classOfProvider, onError: (kind, e) => seen.errors.push([kind, e.message]) }) };
  }
  const BACKGROUND = ['aux', 'quest-refresh', 'skill-curator', 'skill-review'];
  A.eq(Object.keys(BillingClass.KINDS).sort(), ['aux', 'media', 'nightshift', 'oneshot', 'quest-refresh', 'run', 'skill-curator', 'skill-evaluation', 'skill-review'], 'every paid call path is a named kind');
  A.eq(Object.keys(BillingClass.KINDS).filter(k => BillingClass.KINDS[k].background).sort(), BACKGROUND, 'the background kinds are the paths whose rows the 24-hour token ceiling counts');
  for (const kind of Object.keys(BillingClass.KINDS)) {
    for (const id of ['openrouter', 'starnet', 'codex', 'grok', 'kimi', 'ollama', 'claude-cli', 'custom']) {
      const cls = billing.classOf(id), dollars = kind === 'media' || BillingClass.POLICY[cls].dollarCaps, where = kind + ' on ' + id + ' (' + cls + ')';
      // a reached day cap refuses a dollar payer; a plan or a local model spends no dollars, so it is never asked
      const capped = rig();
      const r = capped.governor.admit(kind, { providerId: id, agentId: 'a' });
      A.eq(capped.seen.checks.length, dollars ? 1 : 0, where + ': ' + (dollars ? 'the cross-run caps are asked' : 'no dollar cap is asked'));
      if (dollars) A.eq([r.gate, r.scope, r.cap, r.kind, r.cls, /day spending cap is reached \(\$5\.00 of \$1\.00\)/.test(r.why), /RESUME/.test(r.exit)], ['dollars', 'day', 1, kind, kind === 'media' ? 'metered' : cls, true, true], where + ': the cap\'s own verdict, what it is and its exit');
      else A.eq(r, null, where + ': admitted under a reached dollar cap');
      // the 24-hour token ceiling: a background kind on a route that may sign in meets it, unless the Commander triggered the call
      const t = rig({ verdict: null, tokensReached: true }).governor.admit(kind, { providerId: id, agentId: 'a' });
      const meets = BACKGROUND.includes(kind) && billing.auxCeilingRoute(id);
      A.eq(t ? t.gate : null, meets ? 'tokens' : null, where + ': ' + (meets ? 'the token ceiling stops it' : 'the token ceiling never applies'));
      if (meets) A.ok(/background token ceiling is reached on this route \(250,000 of 200,000 tokens\)/.test(t.why) && /BACKGROUND TOKEN CEILING/.test(t.exit), where + ': the token stop names its figure and its knob');
      A.eq(rig({ verdict: null, tokensReached: true }).governor.admit(kind, { providerId: id, agentId: 'a', trigger: 'commander' }), null, where + ': a call the Commander triggered runs past the token ceiling');
      // ONE ERROR RULE: a check that throws refuses as unknown spend, never "not blocked", and names its exit
      const thrown = rig({ throwCheck: true });
      const x = thrown.governor.admit(kind, { providerId: id, agentId: 'a' });
      if (dollars) {
        A.eq([x.gate, x.unknown, x.code, x.cause, x.error], ['check', true, 'spend_history_unavailable', 'check', 'ledger down'], where + ': a throwing budget refuses');
        A.ok(/spending check failed \(ledger down\)/.test(x.why) && /restart StarNet/.test(x.exit) && /SPENDING LIMITS/.test(x.exit), where + ': with its exit: ' + x.exit);
        A.eq(thrown.seen.errors, [[kind, 'ledger down']], where + ': the error is noted under its kind');
      } else A.eq(x, null, where + ': never asks the budget, so its throw cannot reach it');
    }
  }
  // the other inputs that can throw: the payer lookup and the token gate. Each refuses; none reads as admitted
  for (const [what, o, kind] of [['the payer lookup', { throwClass: true }, 'oneshot'], ['the token gate', { throwGate: true, verdict: null }, 'aux']]) {
    const r = rig(o).governor.admit(kind, { providerId: 'codex', agentId: 'a' });
    A.eq(r && [r.gate, r.unknown, r.cause, /restart StarNet/.test(r.exit)], ['check', true, 'check', true], what + ' throwing refuses ' + kind + ' with its exit');
  }
  A.eq(rig({ verdict: null }).governor.admit('nonsense', { providerId: 'openrouter' }).gate, 'check', 'a path with no name is refused, never admitted');
  // a run's own check: its family's pool answers first; a call the pools then stop gives its reservation back
  {
    const order = [];
    const pool = v => ({ admit: () => { order.push('pool'); return v; }, withdraw: () => order.push('withdraw') });
    const hold = { hold: Promise.resolve() };
    const g = rig();
    A.eq(g.governor.admit('run', { providerId: 'openrouter', agentId: 'a', runId: 'r', pool: pool(hold) }), hold, 'run: the pool\'s hold is the answer, unchanged');
    A.eq([order.splice(0), g.seen.checks.length], [['pool'], 0], 'run: a held call never asks the pools');
    const stopped = g.governor.admit('run', { providerId: 'openrouter', agentId: 'a', runId: 'r', spentUsd: 0.5, emit: 'EMIT', receiptMeta: 'META', pool: pool(null) });
    A.eq([order.splice(0), stopped.gate, g.seen.checks[0]], [['pool', 'withdraw'], 'dollars', ['r', 'a', 0.5, undefined, 'EMIT', 'META']], 'run: the pools get the run, its spend, its bus and its receipt; their stop withdraws the reservation');
    A.eq([rig({ throwCheck: true }).governor.admit('run', { providerId: 'openrouter', agentId: 'a', runId: 'r', pool: pool(null) }).gate, order.splice(0)], ['check', ['pool', 'withdraw']], 'run: a throwing check after the reservation withdraws it and refuses');
    A.eq([rig().governor.admit('run', { providerId: 'codex', agentId: 'a', runId: 'r', pool: pool(null) }), order.splice(0)], [null, []], 'run: a plan run never meets the pools and never reserves in them');
  }
  // Claude Code may sign in: a background pass on it meets the token ceiling (first: it clears on its own) and its dollar caps
  A.eq([rig({ tokensReached: true }).governor.admit('aux', { providerId: 'claude-cli', agentId: 'a' }).gate, rig().governor.admit('aux', { providerId: 'claude-cli', agentId: 'a' }).gate], ['tokens', 'dollars'], 'claude-cli: both gates bind a background pass');
  // EVERY BOOKED ROW NAMES ITS PAYER: a housekeeping or one-shot row is its route's payer, a sign-in when its call reported one
  A.eq(['openrouter', 'codex', 'ollama', 'claude-cli'].map(id => billing.auxRowClass(id, false)), ['metered', 'subscription', 'local', 'metered'], 'auxRowClass: the route\'s payer');
  A.eq(billing.auxRowClass('claude-cli', true), 'subscription', 'auxRowClass: a Claude Code call that reported a sign-in is a subscription row');
  const oneshotRow = new Function('billing', 'BillingClass', 'providerId', 'usage', line('    const billingClass = billing.auxRowClass(providerId, usage.subscription === true), unmetered = ') + '\nreturn { billingClass, unmetered };');
  A.eq(oneshotRow(billing, BillingClass, 'claude-cli', GOLDEN.grid.usage.signIn), { billingClass: 'subscription', unmetered: true }, 'the one-shot row of a Claude Code sign-in is a subscription row (as its run row is)');
  {
    const { makeAuxMeter } = require('../sidecar/ledger.js');
    const rows = [];
    const L = makeLedger({ io: { readAll: () => [], append: r => rows.push(r) }, clock: { now: () => 1000 } });
    const cost = makeCostEngine({ priceOf: () => null });
    for (const [id, usage, want] of [['codex', GOLDEN.grid.usage.costZero, ['subscription', true]], ['openrouter', GOLDEN.grid.usage.priced, ['metered', false]], ['claude-cli', GOLDEN.grid.usage.signIn, ['subscription', true]], ['claude-cli', GOLDEN.grid.usage.priced, ['metered', false]]]) {
      const m = makeAuxMeter({ ledger: L, kind: 'reflection', provider: id, rowClass: signedIn => billing.auxRowClass(id, signedIn) });
      m.add(usage, cost, 'm');
      const row = m.book({ runId: 'r-' + id, agentId: 'a', model: 'm', unmetered: id === 'codex' });
      A.eq([row.billingClass, row.unmetered], want, 'an aux meter row on ' + id + ' names its payer and its flag follows it');
    }
    const legacy = makeAuxMeter({ ledger: L, kind: 'embed' });
    legacy.add(GOLDEN.grid.usage.plain, cost, 'm');
    const lr = legacy.book({ runId: 'e', agentId: 'a', model: 'm', unmetered: true });
    A.eq(['billingClass' in lr, lr.unmetered], [false, true], 'a meter with no route keeps the flag it was handed');
  }
});

governorPart.then(() => A.report('billing-class.parity.test')).catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
