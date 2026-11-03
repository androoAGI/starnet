'use strict';
/* One reviewed inventory drives the existing editors/validators. Readback rows take policy/defaults from
 * their owners; this inventory never becomes a second admission implementation. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const R = require('../sidecar/limits-registry.js');
const billing = require('../sidecar/billing-class.js');
const budget = require('../sidecar/budgetcaps.js');
const spend = require('../sidecar/spend.js');
const aux = require('../sidecar/auxgovernor.js');
const domain = require('../sidecar/domain-task.js');
const ledger = require('../sidecar/ledger.js');
const defaults = { maxIters: 0, maxConcurrentAgents: 0, consentTimeoutMs: 120000, cronTickMs: 60000,
  maxSubscriptionTokens: 2000000, maxUnpricedTokens: 2000000 };
assert.deepEqual(R.keys('runtime'), Object.keys(defaults), 'existing six editable runtime limits, no hidden extra editor');
for (const [key, value] of Object.entries(defaults)) assert.equal(R.BY_KEY[key].def, value, key + ': shipped default unchanged');
assert.deepEqual(R.keys('spending'), budget.KEYS, 'spending validator remains the owner of cap names');
for (const key of budget.KEYS) assert.equal(R.BY_KEY[key].def, budget.shippedDefaults()[key]);
const owners = { managedPerRun: budget.DEFAULT_MANAGED_PER_RUN_USD, unknownImageRun: spend.MEDIA_UNKNOWN_COST_MAX,
  unknownImageDay: spend.MEDIA_UNKNOWN_COST_DAY_MAX, auxBudget: aux.DEFAULT_BUDGET, auxTokenCeiling: aux.DEFAULT_TOKEN_CEILING,
  domainWorkerIters: domain.WORKER_MAX_ITERS, domainWorkerTools: domain.WORKER_MAX_TOOLS, domainWorkerMs: domain.WORKER_MAX_MS,
  unknownChargeUsd: ledger.UNKNOWN_CHARGE_USD };
for (const [key, value] of Object.entries(owners)) assert.equal(R.BY_KEY[key].def, value, key + ': owner supplies the default');
const auditedReadback = ['maxToolBytes', 'maxRepeat', 'toolTimeoutMs', 'managedPerRun', 'unknownImageRun', 'unknownImageDay',
  'auxBudget', 'auxTokenCeiling', 'workerUsd', 'workerIters', 'workerStallMs', 'workerStallInToolMs',
  'domainWorkerIters', 'domainWorkerTools', 'domainWorkerMs', 'skillReviewUsd', 'skillCuratorUsd', 'skillReviewMs', 'unknownChargeUsd'];
assert.deepEqual(R.ROWS.filter(row => row.group === 'readback').map(row => row.key), auditedReadback, 'all reviewed env-only/owner limits are inspectable');
assert.equal(new Set(R.ROWS.map(row => row.key)).size, R.ROWS.length, 'one definition per limit');
for (const row of R.ROWS) {
  for (const key of ['label', 'hint', 'unit', 'where', 'module']) assert.ok(typeof row[key] === 'string' && row[key], row.key + ': ' + key);
  assert.ok(['next-run', 'restart', 'live'].includes(row.applies), row.key + ': explicit application timing');
  assert.ok(row.payers.length && row.payers.every(p => billing.CLASSES.includes(p)), row.key + ': only existing payer classes');
  assert.ok(Object.isFrozen(row) && Object.isFrozen(row.payers), row.key + ': shared definitions cannot mutate enforcement metadata');
}
const saved = R.parseKnobs({ knobs: { ...Object.fromEntries(Object.keys(defaults).map(k => [k, 7000.9])),
  maxToolBytes: 9, inventedKnob: 1, bad: Infinity } });
assert.deepEqual(saved, Object.fromEntries(Object.keys(defaults).map(k => [k, 7000])), 'boot parser uses exactly the editable registry keys');
assert.equal(R.resolve('maxToolBytes', () => null, { maxToolBytes: 9 }), 120000, 'dead saved tool-output setting is explicitly env-only');
for (const d of R.definitions('runtime')) {
  assert.equal(R.resolve(d.key, () => null, saved), 7000, d.key + ': saved beats default');
  assert.equal(R.resolve(d.key, k => k === d.env ? '0' : null, saved), 0, d.key + ': explicit env zero wins');
  assert.equal(R.resolve(d.key, () => '-1', saved), 7000, d.key + ': invalid env does not hide saved value');
  assert.equal(R.resolve(d.key, () => ' ', {}), d.def, d.key + ': blank env keeps shipped default');
}
assert.match(R.applyMessage(['maxSubscriptionTokens', 'maxIters']), /SIGN-IN TOKEN CEILING: next run; MAX ITERATIONS: restart/);
assert.match(R.applyMessage([]), /No runtime limits changed/);
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const host = require('./helpers/source.js').readSidecarSource(), ui = read('frontend/app/stationui.js'), tool = read('sidecar/tools/builtin/station-control.js');
assert.match(host, /const parseKnobs = limitsRegistry\.parseKnobs;/, 'host boot reader uses inventory parser');
assert.match(host, /const CAPS = limitsRegistry\.caps\(ENV, runtimeKnobs\);/, 'host resolves runtime CAPS from inventory');
assert.match(host, /const RUNTIME_KNOB_DEFS = limitsRegistry\.definitions\('runtime'\);/, 'host validator uses inventory bounds');
assert.doesNotMatch(ui, /const ADV_FIELDS\s*=/, 'browser no longer copies runtime definitions');
assert.match(ui, /definitions\.map\(f =>/, 'runtime form renders returned definitions');
assert.match(tool, /limitsRegistry\.keys\('runtime'\)/, 'station control takes same runtime keys');
assert.match(tool, /limitsRegistry\.keys\('spending'\)/, 'station control takes same spending keys');
console.log('limits-registry.completeness.test: inventory, defaults, owner metadata and consumers OK');
