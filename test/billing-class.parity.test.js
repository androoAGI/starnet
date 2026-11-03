/* node test/billing-class.parity.test.js — ONE BILLING CLASS (spend-governor S1).

   Every billing decision a run makes used to be its own inline reading of a provider profile (ten
   getProviderProfile(...).unmetered reads, three copies of the managed rule, the Codex/device-OAuth exemption, the aux
   ceiling's adapter rule). sidecar/billing-class.js holds the one table; the call sites ask it.

   GOLDEN: test/fixtures/billing-class.golden.json holds what base sidecar/index.js decided, evaluated from its own source
   text at 0b8441064, for every registry profile and option (credits configured or not, a CREDITS_URL deployment, a caller
   cap, a line ceiling, PER RUN). This test evaluates the CALL SITES that replaced those expressions, sliced from the
   sidecar as it is now, against the real registry, and wants the same answer everywhere.

   SOURCE: no inline profile.unmetered read or managed rule remains outside billing-class.js (test/helpers/source.js). */
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

const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'billing-class.golden.json'), 'utf8'));
let BillingClass = null, loadError = '';
try { BillingClass = require('../sidecar/billing-class.js'); } catch (e) { loadError = (e && e.message) || String(e); }
const src = readSidecarSource();

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
  src.split('\n').forEach((l, i) => {
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
  for (const call of ['billing.runBillingFor({ providerId, callerCapUsd: o.maxCostUsd, ceilingUsd: o.ceilingUsd, perRunUsd: effectiveCaps.perRun })',
    'billing.spendPoolCapFor({ runCapUsd, policy: runBilling.policy, perRunUsd: effectiveCaps.perRun })',
    'billing.fallbackBillingFor({ providerId: fbProviderId, runManaged: managedRun, runCapUsd, callerCapUsd: o.maxCostUsd, perRunUsd: effectiveCaps.perRun, unpricedTokens: CAPS.maxUnpricedTokens })']) {
    const i = src.indexOf(call), core = src.indexOf('async function runOnceCore(o) {'), next = src.indexOf('\nasync function ', core + 10);
    A.ok(i > core && i < next, 'runOnceCore asks billing-class.js: ' + call.slice(0, 60));
  }
}

// ---- 2. GOLDEN: every decision, through the call sites as they are now ----
if (!BillingClass) A.ok(false, 'sidecar/billing-class.js loads: ' + loadError);
else {
  const getProviderProfile = registry.getProviderProfile;
  const normalizeProviderId = registry.normalizeProviderId;
  const normalizeProvider = id => normalizeProviderId(id, 'openrouter');
  const bind = new Function('BillingClass', 'getProviderProfile', 'credits', 'CREDITS_URL',
    line('const billing = BillingClass.makeBilling({ profileOf: getProviderProfile,') + '\nreturn billing;');
  const billingFor = (configured, url) => bind(BillingClass, getProviderProfile, { configured: () => configured }, url);
  const plain = billingFor(false, '');

  const unmeteredOf = new Function('billing', 'providerId', line('  let providerUnmetered = !billing.policyOf(providerId).ledgerMetered;') + '\nreturn providerUnmetered;');
  const runCapOf = new Function('billing', 'providerId', 'o', 'effectiveCaps',
    through('  const runBilling = billing.runBillingFor(', '  let runCapUsd = runBilling.runCapUsd;') + '\nreturn { runBilling, runCapUsd };');
  const managedOf = new Function('runBilling', line('  const managedRun = runBilling.managed;') + '\nreturn managedRun;');
  const poolOf = new Function('billing', 'runCapUsd', 'runBilling', 'effectiveCaps', line('  const spendPoolCapUsd = billing.spendPoolCapFor(') + '\nreturn spendPoolCapUsd;');
  const limitsOf = new Function('runBilling', 'CAPS', 'return {' + through('        maxUnpricedTokens: runBilling.policy.unpricedTokenCeiling', 'maxSubscriptionTokens: CAPS.maxSubscriptionTokens') + '};');
  const fbAdmit = through('    const fbBilling = billing.fallbackBillingFor(', '    if (!fbBilling) continue;');
  const fbPush = line('    providerFallbacks.push(Object.assign({ provider: fbProvider, providerId: fbProviderId, model: fbModel,');
  const fallbackOf = new Function('billing', 'fbProviderId', 'managedRun', 'runCapUsd', 'o', 'effectiveCaps', 'CAPS', 'fbProvider', 'fbModel', 'fbKey', 'makeCostEngine',
    'const providerFallbacks = [];\n' + fbAdmit.replace(/continue;$/, 'return null;') + '\n' + fbPush + '\nreturn providerFallbacks[0];');
  const crossOf = new Function('providerUnmetered', (() => { const i = at('  const runBudget = { check: (spentThisRun, nextCallUsd) => {'); const a = src.indexOf('\n', i) + 1; return src.slice(a, src.indexOf('\n', a)); })() + "\nreturn 'checked';");
  const bookOf = new Function('name', 'providerUnmetered', 'spendPool', 'runId', 'payload', line("      if (name === 'agent.cost' && !providerUnmetered) spendPool.booked(runId, Number(payload.usd) || 0);") + '\nreturn spendPool.n;');
  const auxOf = new Function('_capReached', 'providerUnmetered', 'budget', 'agentId', 'failNote', line('  if (!_capReached && !providerUnmetered) { try { _capReached = !!budget.check(null, agentId, 0, Date.now(), null); }') + '\nreturn budget.n;');
  const fbFlipOf = new Function('next', 'providerUnmetered', 'runUnmetered', through("          if (typeof next.unmetered === 'boolean') providerUnmetered = next.unmetered;", 'runUnmetered = runUnmetered && providerUnmetered;') + '\nreturn runUnmetered;');
  const mediaOf = new Function('mediaRunFlags', 'runUnmetered', 'mediaUsd', 'mediaUnpriced', 'runUnpriced', line('    const mediaFlags = mediaRunFlags({ runUnmetered, mediaUsd, mediaUnpriced, runUnpriced });') + '\nreturn mediaFlags;');
  const missingOf = new Function('runUnmetered', 'result', line("    const usageMissing = !runUnmetered && !!result && result.reason === 'cancelled' && result.streamCut === true;") + '\nreturn usageMissing;');
  const auxRouteOf = new Function('normalizeProviderId', 'billing', through('function auxRoute(id) {', 'function auxCeilingRoute(id) { return billing.auxCeilingRoute(auxRoute(id)); }') + '\nreturn auxCeilingRoute;')(normalizeProviderId, plain);
  const exprOf = (needle, re, variable) => { const m = line(needle).match(re); if (!m) throw new Error('expression not found: ' + needle.slice(0, 60)); return new Function('billing', variable, 'return (' + m[0] + ');').bind(null, plain); };
  const POLICY_READ = /!billing\.policyOf\(\w+\)\.\w+/;
  const rehydrateOf = exprOf('    unmetered: !billing.policyOf(providerId).ledgerMetered\n  });', POLICY_READ, 'providerId');
  const questCheckOf = new Function('billing', 'providerId', line('    if (billing.policyOf(providerId).dollarCaps) {') + ' return true; }\nreturn false;').bind(null, plain);
  const questBookOf = exprOf("    try { spend.book({ runId: 'questrefresh-' + Date.now(), agentId: 'station', model: model || '', unmetered: ", POLICY_READ, 'providerId');
  const oneshotOf = exprOf('    const unmetered = !billing.policyOf(providerId).ledgerMetered;\n    try { ledger.record({ runId: tag', POLICY_READ, 'providerId');
  const voiceTierOf = exprOf('  const tierCeiling = promptTierCeiling(tProvider, setting.model, ', POLICY_READ, 'tProvider');
  const modelsTierOf = exprOf('    const tierExempt = !billing.policyOf(id).promptTier;', POLICY_READ, 'id');
  const runTierOf = new Function('promptTierCeiling', 'activeProviderId', 'model', 'providerUnmetered', line('  const runWindowCeiling = () => promptTierCeiling(activeProviderId, model, providerUnmetered);') + '\nreturn runWindowCeiling();');
  const evalOf = new Function('billing', 'normalizeProvider', 'cfg', 'effectiveCaps', 'MANAGED_PER_RUN_DEFAULT', 'budgetCaps',
    through('    const providerId = normalizeProvider(cfg.provider);\n    const evalBilling = billing.evaluationBillingFor(', '    const { unmetered, managed } = evalBilling;') + '\nreturn { unmetered, managed, perRunCap: evalBilling.perRunCapUsd };');
  A.ok(/SkillEvaluationRunner\.evaluationLimits\(\{ cases: evalSuite \? evalSuite\.cases\.length : 0, runCapUsd: evalBilling\.perRunCapUsd \}\)/.test(src), 'the evaluation sizes its limits from that cap');

  async function seatbeltCounts(usage, loopOpts) {
    const r = await runAgentLoop(Object.assign({
      messages: [{ role: 'user', content: 'go' }], isTask: true, model: 'm', runId: 'g', agentId: 'g',
      tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }],
      provider: { priceOf: () => null, contextLimit: () => 0, stream: async function* () {
        yield { type: 'tool_start', index: 0, id: 'c1', name: 'noop' }; yield { type: 'tool_args', index: 0, chunk: '{}' };
        yield { type: 'usage', usage: JSON.parse(JSON.stringify(usage)) }; yield { type: 'done', finishReason: 'tool_calls' };
      } },
      emit: () => {}, cost: makeCostEngine({ priceOf: () => null }), dispatch: async () => ({ ok: true, content: 'ok' }),
      limits: { maxIters: 2, grace: false, maxCostUsd: Infinity, maxUnpricedTokens: Infinity, maxSubscriptionTokens: 1 }
    }, loopOpts || {}));
    return r.reason === 'budget' && r.subscriptionCapTokens === 1;
  }

  const G = GOLDEN.grid;
  const CALLER = G.callerCapUsd.map(k => [k, k === '-' ? undefined : Number(k)]);
  const LINE = G.ceilingUsd.map(k => [k, k === '-' ? undefined : Number(k)]);
  const PERRUN = G.perRunUsd.map(k => [k, Number(k)]);
  const CREDITS = G.credits.map(k => [k, k !== '0', k === '1url' ? 'https://credits.example.test' : '']);
  const diffs = [];
  const same = (where, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) diffs.push(where + ': got ' + JSON.stringify(got) + ', base ' + JSON.stringify(want)); };

  (async () => {
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
      got.crossRunCheck = crossOf(unmetered) === 'checked';
      { const sp = { n: 0, booked() { this.n++; } }; got.poolBooking = bookOf('agent.cost', unmetered, sp, 'r', { usd: 1 }) === 1; }
      { const b = { n: 0, check() { this.n++; return null; } }; got.auxDollarCheck = auxOf(false, unmetered, b, 'a', () => {}) === 1; }
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
      for (const [uk, u] of Object.entries(G.usage)) {
        got.seatbeltCounts[uk] = await seatbeltCounts(u);
        for (const media of [0, 0.04]) {
          const flags = mediaOf(mediaRunFlags, unmetered, media, 0, false);
          got.runRow[uk + ' media=' + media] = { unmetered: flags.unmetered, usageMissingIfCut: missingOf(unmetered, { reason: 'cancelled', streamCut: true }) };
        }
      }
      for (const k of Object.keys(want)) {
        if (want[k] && typeof want[k] === 'object') for (const kk of Object.keys(want[k])) same(id + '.' + k + '[' + kk + ']', got[k][kk], want[k][kk]);
        else same(id + '.' + k, got[k], want[k]);
      }
    }
    for (const pair of Object.keys(GOLDEN.fallbacks)) {
      const [p, fb] = pair.split('>');
      const want = GOLDEN.fallbacks[pair];
      const pu = unmeteredOf(plain, p);
      same(pair + '.runUnmeteredAfter', fbFlipOf({ unmetered: fallbackOf(plain, fb, false, Infinity, {}, { perRun: 0 }, { maxUnpricedTokens: 2000000 }, { priceOf: () => null }, 'm', '', () => ({})).unmetered }, pu, pu), want.runUnmeteredAfter);
      for (const [k, configured, url] of CREDITS) for (const [ck, cv] of CALLER) for (const [pk, pv] of PERRUN.slice(0, 2)) {
        const b = billingFor(configured, url);
        const run = runCapOf(b, p, { maxCostUsd: cv }, { perRun: pv });
        const e = fallbackOf(b, fb, managedOf(run.runBilling), run.runCapUsd, { maxCostUsd: cv }, { perRun: pv }, { maxUnpricedTokens: 2000000 }, { priceOf: () => null }, 'm', '', () => ({}));
        const key = 'credits=' + k + ' cap=' + ck + ' perRun=' + pk;
        same(pair + '.entry[' + key + ']', e ? [e.unmetered, enc(e.maxCostUsd), enc(e.maxUnpricedTokens)] : null, want.entry[key]);
        if (e) A.ok(e.provider && e.providerId === fb && e.model === 'm' && e.credKey === null && !!e.cost, pair + ' ' + key + ': the entry keeps its provider, model, key and cost engine');
      }
    }
    A.eq(diffs, [], 'every billing decision equals the base golden');
    A.report('billing-class.parity.test');
  })().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
}
if (!BillingClass) A.report('billing-class.parity.test');
