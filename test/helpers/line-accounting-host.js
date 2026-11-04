'use strict';
/* Actual private composition-root blocks + real existing domain stores. Only
   allocated filesystem faults and the host's ID/clock sources are injected. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), Module = require('node:module');
const crypto = require('node:crypto');
const { makeDomainStore } = require('../../sidecar/domain-store.js');
function controlSource(env) {
  const file = process.env[env], source = fs.readFileSync(file, 'utf8');
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  console.log('CONTROL_SOURCE ' + env + ' ' + file + ' SHA256=' + hash);
  if (hash !== String(process.env[env + '_SHA256'] || '').toLowerCase()) throw new Error('saved control hash mismatch: ' + env);
  return source;
}
function owner(rel, env) {
  const file = require.resolve(rel);
  if (!process.env[env]) return require(file);
  const old = new Module(file, module); old.filename = file; old.paths = Module._nodeModulePaths(path.dirname(file));
  old._compile(controlSource(env), file); return old.exports;
}
const J = owner('../../sidecar/routing/linejobs.js', 'LINE_ACCOUNTING_CONTROL_JOBS');
const Spend = owner('../../sidecar/routing/line-spend.js', 'LINE_ACCOUNTING_CONTROL_SPEND');
const C = require('../../sidecar/routing/line-continuation.js');
const source = process.env.LINE_ACCOUNTING_CONTROL_INDEX ? controlSource('LINE_ACCOUNTING_CONTROL_INDEX')
  : require('./source.js').readSidecarIndex();
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b <= a) throw new Error('production enrollment owner boundary missing');
  return source.slice(a, b);
}
const blocks = section('const LINE_SPEND_FILE = ', '/* SHIPPED is durable') + '\n'
  + section('const LINE_JOBS_FILE = ', '/* GET /api/line-jobs?line=');
const metadata = (state = 'confirmed', ledgerId = 'ledger-fixture') => ({ version: 1, ledgerId, state });
const attempt = fn => { try { return { value: fn() }; } catch (error) { return { error }; } };
function allocated(run, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-accounting-'));
  const jobFile = path.join(dir, 'line-jobs.json'), spendFile = path.join(dir, 'line-spend.json');
  const f = { before: '', after: '', atWrite: 0, readsBlocked: new Set(), hidden: new Set(), writes: [], mints: 0,
    now: 1000, onWrite: null };
  const proxy = Object.create(fs);
  proxy.readFileSync = (p, ...args) => {
    const target = path.resolve(String(p));
    if (f.hidden.has(target) || f.readsBlocked.has(target)) {
      const e = new Error('fixture canonical read unavailable'); e.code = f.hidden.has(target) ? 'ENOENT' : 'EACCES'; throw e;
    }
    return fs.readFileSync(p, ...args);
  };
  proxy.renameSync = (from, to) => {
    const target = path.resolve(String(to)), owned = target === jobFile || target === spendFile;
    const count = f.writes.filter(row => row.file === target).length + 1;
    const armed = owned && (!f.atWrite || f.atWrite === count);
    if (armed && f.before === target) { const e = new Error('fixture canonical write refused'); e.code = 'EIO'; throw e; }
    fs.renameSync(from, to);
    if (owned) {
      const value = JSON.parse(fs.readFileSync(target, 'utf8'));
      f.writes.push({ file: target, enrollment: value.continuationAccounting || null });
      if (f.onWrite) f.onWrite(target, value);
      if (armed && f.after === target) f.readsBlocked.add(target);
    }
  };
  const loadHost = () => {
    const context = { fs: proxy, path, WORKSPACES: dir, makeDomainStore, writeFileDurable: undefined, LineJobs: J, LineContinuation: C,
      makeLineSpend: Spend.makeLineSpend, cleanLineSpend: Spend.clean, assertLineSpendWritable: Spend.assertWritable,
      normalizeLineSpendLedger: Spend.normalizeLedger, decodeLineSpendEnvelope: Spend.decodeEnvelope, encodeLineSpendEnvelope: Spend.encodeEnvelope,
      LINE_SPEND_DAY_MS: Spend.DAY_MS, Date: { now: () => f.now }, failNote: () => {}, console: { warn: () => {} },
      crypto: { randomBytes: n => Buffer.alloc(n, ++f.mints) } };
    context.LineEntryInvocation = require('../../sidecar/routing/line-entry-invocation.js');
    context.LineEntryAdoption = owner('../../sidecar/routing/line-entry-adoption.js', 'LINE_ADOPTION_CONTROL');
    context.chainRunner = require('../../sidecar/routing/chain.js').makeChainRunner({});
    const build = vm.compileFunction(blocks + '\nreturn {book:lineJobsBookReceipt, mutate:lineJobsSet, jobs:()=>lineJobs, ledger:lineSpend,'
      + 'hold:typeof lineJobsHold === "function" ? lineJobsHold : null,'   // the durable hold writer (line-hold lane): absent on an older host
      // the decision owner's store (line-hold lane, S4): the fresh read, the claim, the refusal and one checkpoint of a saved walk
      + 'store:typeof lineJobsAdvance === "function" ? { read: lineJobsRead, claim: lineJobsClaimDecision, refuse: lineJobsRefuseDecision, advance: lineJobsAdvance } : null,'
      + 'enroll:typeof lineJobsEnrollAccounting === "function" ? lineJobsEnrollAccounting : null,'
      + 'prepare:typeof lineJobsPrepareEntry === "function" ? lineJobsPrepareEntry : null,'
      + 'checkpoint:typeof lineJobsCheckpointEntry === "function" ? lineJobsCheckpointEntry : null,'
      + 'adoption:(authority,chain)=>LineEntryAdoption.makeEntryAdoption({read:lineJobsRefresh,write:lineJobsSet,'
      + 'requireAccounting:lineJobsRequireAccounting,note:(line,usd,receipt)=>lineSpend.note(line,usd,receipt),'
      + 'receiptProof:(line,usd,receipt,ledgerId)=>lineSpend.receiptProof(line,usd,receipt,ledgerId),authority,chain})};', Object.keys(context));
    return build(...Object.values(context));
  };
  const raw = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  let pending = false;
  function cleanup() {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('line-accounting-')) throw new Error('fixture cleanup escaped temp parent');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  try {
    write(jobFile, { version: 1, jobs: [] });
    write(spendFile, { version: 1, lines: { 'line-a': { day: 0, usd: 5 } } });
    const env = { f, dir, jobFile, spendFile, raw, write, loadHost };
    if (seed) seed(env);
    const result = run(Object.assign(env, { host: loadHost() }));
    if (result && typeof result.then === 'function') { pending = true; return result.finally(cleanup); }
    return result;
  } finally {
    if (!pending) cleanup();
  }
}
module.exports = { J, Spend, metadata, attempt, allocated, old: !!process.env.LINE_ACCOUNTING_CONTROL_INDEX };
