/* The station's limit inventory. Pure metadata/readback: this module never admits or stops a call.
   Runtime editors, their validator, boot reader and station.control use the same definitions.
   Spending policy stays in billing-class.js; effective values come from the enforcing owners. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./budgetcaps.js'), require('./billing-class.js'), require('./spend.js'), require('./auxgovernor.js'), require('./domain-task.js'), require('./ledger.js'));
  else { (root.SK = root.SK || {}).limitsRegistry = factory(root.SK.budgetcaps, root.SK.billingClass, root.SK.spend, root.SK.auxgovernor, root.SK.domainTask, root.SK.ledger); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (budgetCaps, billing, spend, aux, domain, ledger) {
  'use strict';
  const ALL = billing.CLASSES;
  const policyPayers = field => ALL.filter(c => billing.POLICY[c][field]);
  const APP = 'SETTINGS > APP & BACKUP > Runtime limits';
  const BUDGET = 'SETTINGS > SPENDING LIMITS';
  const ENV = 'environment variable; restart the app';
  function row(key, group, def, extra) {
    const value = Object.assign({ key, group, env: null, def, min: 0, max: null, step: 1, unit: 'count', label: key,
      hint: '', applies: 'restart', editable: false, payers: ALL, where: ENV, module: 'sidecar/index.js', zero: 'off' }, extra);
    return Object.freeze(Object.assign(value, { payers: Object.freeze(value.payers.slice()) }));
  }
  const ROWS = Object.freeze([
    row('maxIters', 'runtime', 0, { env: 'MAX_ITERS', max: 200, label: 'MAX ITERATIONS', hint: 'The most tool steps one run may take. 0 = no limit (default).', editable: true, where: APP }),
    row('maxConcurrentAgents', 'runtime', 0, { env: 'MAX_CONCURRENT_AGENTS', max: 32, label: 'MAX CONCURRENT AGENTS', hint: 'The most agents working at the same time. 0 = no limit (default).', editable: true, where: APP }),
    row('consentTimeoutMs', 'runtime', 120000, { env: 'CONSENT_TIMEOUT_MS', min: 5000, max: 600000, step: 1000, unit: 'ms', label: 'CONSENT TIMEOUT', hint: 'How long an unanswered approval card waits before declining. A visible card has an extended deadline.', editable: true, where: APP, zero: null }),
    row('cronTickMs', 'runtime', 60000, { env: 'CRON_TICK_MS', min: 5000, max: 600000, step: 1000, unit: 'ms', label: 'ROUTINE TICK', hint: 'How often the scheduler checks for due routines.', editable: true, where: APP, zero: null }),
    row('maxSubscriptionTokens', 'runtime', 2000000, { env: 'MAX_SUBSCRIPTION_TOKENS', max: 100000000, step: 100000, unit: 'tokens/run', label: 'SIGN-IN TOKEN CEILING', hint: 'Tokens one run may use on a sign-in plan: ChatGPT, Grok, Kimi or a Claude subscription. Cache re-reads count 1/10. 0 = no ceiling.', applies: 'next-run', editable: true, where: APP, payers: policyPayers('signInTokenCeiling') }),
    row('maxUnpricedTokens', 'runtime', 2000000, { env: 'MAX_UNPRICED_TOKENS', max: 100000000, step: 100000, unit: 'tokens/run', label: 'UNPRICED MODEL TOKEN CEILING', hint: 'Tokens one run may use on a model StarNet cannot price. 0 = no ceiling.', applies: 'next-run', editable: true, where: APP, payers: policyPayers('unpricedTokenCeiling') }),
    ...budgetCaps.KEYS.map(key => row(key, 'spending', budgetCaps.shippedDefaults()[key], { env: { perRun: 'BUDGET_PER_RUN', perAgent: 'BUDGET_PER_AGENT', perDay: 'BUDGET_PER_DAY', global: 'BUDGET_GLOBAL' }[key], max: budgetCaps.CAP_MAX, step: 0.01, unit: 'USD',
      label: { perRun: 'PER RUN', perAgent: 'PER AGENT', perDay: 'PER DAY', global: 'ALL TIME' }[key],
      hint: key === 'perDay' ? 'The shipped $25 day rail is soft; RESUME grants another cap of headroom. Images with a known price also count.' : '0 = no cap. Calls that spend no dollars do not use this pool.',
      applies: key === 'perRun' ? 'next-run' : 'live', editable: true, where: BUDGET, payers: key === 'perRun' ? policyPayers('dollarCaps') : ALL.filter(c => billing.POLICY[c].dollarCaps || billing.POLICY[c].mediaDollarsCrossRun), module: 'sidecar/budgetcaps.js' })),
    row('maxToolBytes', 'readback', 120000, { env: 'MAX_TOOL_BYTES', unit: 'bytes/run', label: 'TOOL OUTPUT FLOOR', hint: 'Scales with the model window unless pinned by the environment. A saved override is not supported.', zero: null }),
    row('maxRepeat', 'readback', 3, { label: 'REPEATED TOOL CALLS', hint: 'Loop progress guard; not a spending allowance.', where: 'built-in loop guard', zero: null }),
    row('toolTimeoutMs', 'readback', 30000, { unit: 'ms', label: 'DEFAULT TOOL TIMEOUT', hint: 'Individual tools may carry their own timeout.', where: 'built-in tool policy', zero: null }),
    row('managedPerRun', 'readback', budgetCaps.DEFAULT_MANAGED_PER_RUN_USD, { env: 'BUDGET_MANAGED_PER_RUN', unit: 'USD/run', label: 'MANAGED RUN DEFAULT', hint: 'Used only without a positive PER RUN cap; bounded by the reported wallet. 0 uses the wallet.', payers: policyPayers('managedAdmission'), zero: 'wallet', module: 'sidecar/budgetcaps.js' }),
    row('unknownImageRun', 'readback', spend.MEDIA_UNKNOWN_COST_MAX, { env: 'IMAGE_UNKNOWN_COST_MAX', unit: 'images/run family', label: 'UNPRICED IMAGES PER RUN', hint: 'Counts images whose provider charge is unknown. 0 uses the built-in default.', applies: 'next-run', payers: policyPayers('imageUnknownCaps'), zero: 'default', module: 'sidecar/spend.js' }),
    row('unknownImageDay', 'readback', spend.MEDIA_UNKNOWN_COST_DAY_MAX, { env: 'IMAGE_UNKNOWN_COST_DAY_MAX', unit: 'images/24h', label: 'UNPRICED IMAGES PER DAY', hint: 'Station-wide rolling count; unreadable image history refuses another unknown-cost image. 0 uses the default.', payers: policyPayers('imageUnknownCaps'), zero: 'default', module: 'sidecar/spend.js' }),
    row('auxBudget', 'readback', aux.DEFAULT_BUDGET, { env: 'AUX_BUDGET', unit: 'passes/run end', label: 'BACKGROUND PASSES', hint: 'Joint pass ceiling after one run. 0 = no pass ceiling.', applies: 'live', module: 'sidecar/auxgovernor.js' }),
    row('auxTokenCeiling', 'readback', aux.DEFAULT_TOKEN_CEILING, { max: aux.MAX_TOKEN_CEILING, unit: 'weighted tokens/24h/route', label: 'BACKGROUND SIGN-IN TOKENS', hint: 'Automatic background passes only. Concurrent passes can overshoot; unknown usage is not a measured zero.', applies: 'live', payers: policyPayers('auxTokenCeiling'), where: 'SETTINGS > MEMORY > Background work', module: 'sidecar/auxgovernor.js' }),
    row('workerUsd', 'readback', 0, { env: 'BUDGET_PER_WORKER', unit: 'USD/worker', label: 'DELEGATED WORKER SPEND', hint: '0 = no extra worker cap; the run family cap still applies.', payers: policyPayers('dollarCaps') }),
    row('workerIters', 'readback', 0, { env: 'WORKER_MAX_ITERS', unit: 'turns/worker', label: 'DELEGATED WORKER TURNS', hint: '0 inherits the station policy.', zero: 'inherit' }),
    row('workerStallMs', 'readback', 450000, { env: 'WORKER_STALL_MS', unit: 'ms without progress', label: 'WORKER SILENCE', hint: 'Stops a silent worker; a worker making progress can keep running. 0 disables.' }),
    row('workerStallInToolMs', 'readback', 1200000, { env: 'WORKER_STALL_IN_TOOL_MS', unit: 'ms without progress in tool', label: 'WORKER TOOL SILENCE', hint: 'Cannot be shorter than WORKER SILENCE. Inactive when WORKER SILENCE is 0.' }),
    row('domainWorkerIters', 'readback', domain.WORKER_MAX_ITERS, { unit: 'turns', label: 'SCOPED DOMAIN WORKER TURNS', hint: 'Applies only to a lead-scoped domain worker.', where: 'lead-scoped worker policy', module: 'sidecar/domain-task.js', zero: null }),
    row('domainWorkerTools', 'readback', domain.WORKER_MAX_TOOLS, { unit: 'tools', label: 'SCOPED DOMAIN WORKER TOOLS', hint: 'Applies only to a lead-scoped domain worker.', where: 'lead-scoped worker policy', module: 'sidecar/domain-task.js', zero: null }),
    row('domainWorkerMs', 'readback', domain.WORKER_MAX_MS, { unit: 'ms', label: 'SCOPED DOMAIN WORKER TIME', hint: 'Applies only to a lead-scoped domain worker.', where: 'lead-scoped worker policy', module: 'sidecar/domain-task.js', zero: null }),
    row('skillReviewUsd', 'readback', 0.08, { env: 'SKILL_REVIEW_MAX_USD', unit: 'USD/pass', label: 'SKILL REVIEW SPEND', hint: 'Dollar ceiling for a skill review pass.', payers: policyPayers('dollarCaps') }),
    row('skillCuratorUsd', 'readback', 0.12, { env: 'SKILL_CURATOR_MAX_USD', unit: 'USD/pass', label: 'SKILL CURATOR SPEND', hint: 'Dollar ceiling for a skill curator pass.', payers: policyPayers('dollarCaps') }),
    row('skillReviewMs', 'readback', 45000, { env: 'SKILL_REVIEW_TIMEOUT_MS', unit: 'ms/pass', label: 'SKILL PASS TIMEOUT', hint: 'Timeout for a skill review or curator pass.', zero: null }),
    row('unknownChargeUsd', 'readback', ledger.UNKNOWN_CHARGE_USD, { env: 'UNKNOWN_CHARGE_USD', unit: 'USD', label: 'UNKNOWN CHARGE ASSUMPTION FLOOR', hint: 'An assumption, not a measured charge. Actual COUNT AS uses the larger of this floor and the largest ledger charge.', payers: policyPayers('dollarCaps'), zero: 'default', module: 'sidecar/ledger.js' })
  ]);
  const BY_KEY = Object.freeze(Object.fromEntries(ROWS.map(d => [d.key, d])));
  function definitions(group) { return ROWS.filter(d => d.group === group && d.editable); }
  function keys(group) { return definitions(group).map(d => d.key); }
  function parseKnobs(raw) {
    const k = raw && typeof raw === 'object' && raw.knobs && typeof raw.knobs === 'object' ? raw.knobs : {};
    const out = {};
    for (const d of definitions('runtime')) if (typeof k[d.key] === 'number' && isFinite(k[d.key]) && k[d.key] >= 0) out[d.key] = Math.floor(k[d.key]);
    return out;
  }
  function envLocked(env, suffix) { const e = suffix ? env(suffix) : null; return e != null && String(e).trim() !== '' && Number(e) >= 0; }
  function resolve(key, env, saved) {
    const d = BY_KEY[key];
    if (envLocked(env, d.env)) return Math.floor(Number(env(d.env)));
    const v = d.editable && saved && saved[key];
    return typeof v === 'number' && v >= 0 ? v : d.def;
  }
  function caps(env, saved) { return Object.fromEntries(['maxIters', 'maxRepeat', 'toolTimeoutMs', 'maxToolBytes', 'maxUnpricedTokens', 'maxSubscriptionTokens'].map(k => [k, resolve(k, env, saved)])); }
  function runtimeStatus(env, saved, active, ackMs) {
    const fields = {};
    for (const d of definitions('runtime')) fields[d.key] = { effective: resolve(d.key, env, saved), default: d.def,
      saved: typeof saved[d.key] === 'number' ? saved[d.key] : null, envLocked: envLocked(env, d.env), min: d.min, max: d.max,
      live: active[d.key], applies: d.applies };
    fields.consentTimeoutMs.liveAckMs = ackMs;
    return { fields, definitions: definitions('runtime') };
  }
  function takes(group) { return '{' + definitions(group).map(d => d.key + '? ' + d.min + '-' + d.max).join(', ') + '} (null = default; ' + (group === 'spending' ? 'dollars, 0 = no cap' : 'token ceilings apply from the next run; other runtime settings after restart') + ')'; }
  function applyMessage(changed) {
    const rows = (changed || []).map(k => BY_KEY[k]).filter(Boolean);
    const words = [];
    for (const [timing, text] of [['next-run', 'next run'], ['restart', 'restart'], ['live', 'now']]) {
      const labels = rows.filter(d => d.applies === timing).map(d => d.label);
      if (labels.length) words.push(labels.join(', ') + ': ' + text);
    }
    return words.length ? 'Saved. ' + words.join('; ') + '.' : 'No runtime limits changed.';
  }
  function effective(o) {
    const env = o.env || (() => null), classes = ALL.filter(c => (o.classes || []).includes(c));
    const rows = ROWS.map(d => {
      let value = null, next = null, source = 'unknown';
      if (d.group === 'runtime') {
        value = o.active && o.active[d.key]; next = resolve(d.key, env, o.runtimeSaved || {});
        const activeSaved = d.applies === 'restart' ? (o.runtimeBootSaved || {}) : (o.runtimeSaved || {});
        source = envLocked(env, d.env) ? 'env' : typeof activeSaved[d.key] === 'number' ? 'saved' : 'default';
      } else if (d.group === 'spending') {
        value = o.budget && o.budget[d.key];
        source = typeof (o.budgetSaved || {})[d.key] === 'number' ? 'saved' : envLocked(env, d.env) ? 'env' : 'default';
      } else {
        const fact = o.readback && o.readback[d.key];
        if (fact && typeof fact === 'object') { value = fact.value; source = fact.source; }
      }
      if (typeof value !== 'number' || !isFinite(value)) { value = null; source = 'unknown'; }
      return Object.assign({}, d, { value, source, inUse: d.payers.filter(c => classes.includes(c)),
        ...(typeof next === 'number' && next !== value ? { nextValue: next } : {}) });
    });
    return { classes, rows };
  }
  return { ROWS, BY_KEY, definitions, keys, parseKnobs, envLocked, resolve, caps, runtimeStatus, takes, applyMessage, effective };
});
