'use strict';
/* Production settings handlers + real durable stores on temp files. Filesystem faults occur before
 * the write or after the new main file lands but before readback. No successful save is inferred. */
const A = require('./_assert.js');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const limitsRegistry = require('../sidecar/limits-registry.js');
const budgetCaps = require('../sidecar/budgetcaps.js');
const configExport = require('../sidecar/configexport.js');
const { makeDomainStore } = require('../sidecar/domain-store.js');
const { writeJsonResilient, saveJsonVerified } = require('../sidecar/durable-store.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');
const source = process.env.SPEND_LIMITS_SOURCE ? fs.readFileSync(process.env.SPEND_LIMITS_SOURCE, 'utf8') : require('./helpers/source.js').readSidecarSource();
function fn(name) {
  const m = new RegExp('^(?:async )?function ' + name + '\\(', 'm').exec(source);
  if (!m) throw new Error('missing host function ' + name);
  const close = /\n\}/.exec(source.slice(m.index));
  if (!close) throw new Error('unclosed host function ' + name);
  return source.slice(m.index, m.index + close.index + 2);
}
const funcs = ['saveRuntimeKnobs', 'activeRuntimeKnobs', 'runtimeKnobsStatus', 'handleRuntimeKnobsSet',
  'saveBudgetOverrides', 'applyBudgetCaps', 'handleBudgetCaps', 'handleConfigImport', 'handleConfigReset'];

async function scenario(action, failure) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-persist-'));
  const runtimeFile = path.join(dir, 'runtime.knobs.json'), budgetFile = path.join(dir, 'budget.json');
  const target = action === 'runtime' ? runtimeFile : budgetFile;
  let fault = '', landed = false;
  const eio = () => Object.assign(new Error('fixture limits storage fault'), { code: 'EIO' });
  const disk = Object.create(fs);
  disk.readFileSync = (file, ...args) => {
    if (fault === 'readback' && landed && String(file) === target) throw eio();
    return fs.readFileSync(file, ...args);
  };
  const writer = (deps, file, data) => {
    if (fault === 'write' && String(file) === target) throw eio();
    writeFileDurable(deps, file, data);
    if (String(file) === target) landed = true;
  };
  const store = makeDomainStore({ fs: disk, path, file: budgetFile, version: 1, writeDurable: writer,
    defaults: () => ({}), normalize: value => budgetCaps.cleanOverrides(value || {}),
    encode: value => ({ caps: value }), decode: value => value && value.caps });
  const oldRuntime = { maxSubscriptionTokens: 2000000 }, oldBudget = { perDay: 3 };
  const saved = (file, value) => writeJsonResilient({ fs: disk, path, writeDurable: writer }, file, value);
  try {
    saved(runtimeFile, { version: 1, knobs: oldRuntime }); store.save(oldBudget); landed = false;
    const ctx = vm.createContext({ fs: disk, path, console: { warn() {} }, limitsRegistry, budgetCaps, configExport,
      saveJsonVerified, saveResilient: saved, budgetStore: store, RUNTIME_KNOBS_FILE: runtimeFile,
      runtimeKnobs: { ...oldRuntime }, budgetOverrides: { ...oldBudget }, effectiveCaps: { perRun: 0, perAgent: 0, perDay: 3, global: 0 },
      BUDGET_CAPS: { perRun: 0, perAgent: 0, perDay: 25, global: 0 }, budget: { setCaps() {} },
      CAPS: limitsRegistry.caps(() => null, oldRuntime), MAX_CONCURRENT_AGENTS: 0, CONSENT_TIMEOUT_MS: 120000,
      CONSENT_ACK_EXTEND_MS: 600000, CRON_TICK_MS: 60000, RUNTIME_KNOB_DEFS: limitsRegistry.definitions('runtime'),
      ENV: () => undefined, knobEnvLocked: () => false, readBody: async req => req.body,
      handleBudgetStatus: (req, res) => { res.writeHead(200); res.end(JSON.stringify({ ok: true })); }
    });
    vm.runInContext('function resolveKnob(key) { return limitsRegistry.resolve(key, ENV, runtimeKnobs); }\n' + funcs.map(fn).join('\n'), ctx);
    const request = action === 'runtime' ? { maxSubscriptionTokens: 9000000 }
      : action === 'budget' ? { perDay: 7 }
      : action === 'import' ? { envelope: configExport.buildExport({ budget: { perDay: 7 } }, { now: 1 }), only: ['budget'] }
      : { section: 'budget' };
    const handler = { runtime: 'handleRuntimeKnobsSet', budget: 'handleBudgetCaps', import: 'handleConfigImport', reset: 'handleConfigReset' }[action];
    async function post() {
      let status = 0, body = null;
      const res = { writeHead: n => { status = n; }, end: value => { body = JSON.parse(value); } };
      try { await ctx[handler]({ body: JSON.stringify(request) }, res); }
      catch (e) { return { status: 599, body: { error: String(e && e.message || e) } }; }
      return { status, body };
    }
    fault = failure;
    const refused = await post(), label = action + '/' + failure;
    A.eq(refused.status, 500, label + ': failed durability is an explicit refusal');
    A.ok(refused.body && /(?:persist|disk|sav|confirm)/i.test(refused.body.error || ''), label + ': refusal names the save problem');
    A.eq(JSON.parse(JSON.stringify(ctx.runtimeKnobs)), oldRuntime, label + ': runtime saved-state projection remains proven value');
    A.eq(JSON.parse(JSON.stringify(ctx.budgetOverrides)), oldBudget, label + ': spending saved-state projection remains proven value');
    A.eq(ctx.CAPS.maxSubscriptionTokens, 2000000, label + ': failed save never installs a live token ceiling');
    A.eq(ctx.effectiveCaps.perDay, 3, label + ': failed save never installs/resets a live dollar cap');
    if (action === 'import') A.eq(refused.body.applied, [], label + ': failed budget import is not advertised applied');
    if (failure === 'write') A.eq(JSON.parse(fs.readFileSync(target, 'utf8'))[action === 'runtime' ? 'knobs' : 'caps'], action === 'runtime' ? oldRuntime : oldBudget, label + ': pre-write fault preserves old durable values');
    else A.ok(landed, label + ': new bytes really landed before their readback failed');
    fault = ''; landed = false;
    const retried = await post();
    A.eq(retried.status, 200, label + ': explicit retry succeeds once disk is readable');
    const intended = action === 'runtime' ? { maxSubscriptionTokens: 9000000 } : action === 'reset' ? {} : { perDay: 7 };
    A.eq(JSON.parse(fs.readFileSync(target, 'utf8'))[action === 'runtime' ? 'knobs' : 'caps'], intended, label + ': successful reply matches durable main readback');
    A.eq(action === 'runtime' ? limitsRegistry.parseKnobs(JSON.parse(fs.readFileSync(target, 'utf8'))) : store.load().value, intended, label + ': independent restart reader sees the accepted state');
  } finally {
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('limits-persist-')) throw new Error('unexpected fixture cleanup path');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
(async () => {
  for (const action of ['runtime', 'budget', 'import', 'reset']) for (const failure of ['write', 'readback']) await scenario(action, failure);
  A.report('limits.persistence.test');
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
