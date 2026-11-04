'use strict';
/* The actual host load/save/clear/tick closures over real persist owners and disk.
   Control swaps only index.js; the same strict schema owner exposes the old catch/save
   integration gaps. No live sidecar, scheduler work, provider or network is started. */
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const Source = require('./helpers/source.js');
const Store = require('../sidecar/cron-store.js'), Persist = require('../sidecar/persist/index.js'), Durable = require('../sidecar/durable-store.js');
const Kinds = require('../frontend/app/turnkinds.js');
// This test exercises index.js's exact lexical persistence composition and clear route.
const code = process.env.C9_CRON_HOST_SOURCE ? fs.readFileSync(process.env.C9_CRON_HOST_SOURCE, 'utf8') : Source.readSidecarIndex();
if (process.env.C9_CRON_HOST_SOURCE) console.log('CONTROL_SOURCE host SHA256=' + crypto.createHash('sha256').update(code).digest('hex'));
const names = ['holdCronPublication', 'inspectCronPublicationPrimary', 'loadCronJobs', 'saveCronJobs', 'withCronWrite', 'handleCronDegradedClear', 'cronTickHealthy'];
const pieces = names.map(name => A.fnBody(code, (name === 'withCronWrite' ? 'async ' : '') + 'function ' + name + '(')).filter(Boolean).join('\n');
const runId = 'publication-host-123';
const envelope = () => ({ version: 1, jobs: [{ id: 'daily', name: 'Digest', agentId: 'agent', noAgent: true, deliver: 'targets:target-a', attachToSession: true,
  finalization: { runId, state: 'delivered', outcome: 'ok', deliver: 'targets:target-a', deliveryContext: { agentId: 'agent', attachToSession: true },
    deliveredTargets: ['target-a'], givenUpTargets: [], historyReleased: false,
    historyPublications: [{ v: 1, target: 'target-a', deliveryId: 'routine:daily:' + runId + ':target-a', channel: 'telegram', chatId: 'room',
      streamId: 'stream_a', agentId: 'agent', runId, rowId: 7, turnId: Kinds.runTurnId(runId) }] } }] });
async function scenario(name, action) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-publication-')), file = path.join(root, 'cron.jobs.json');
  const state = { fault: '', writes: 0, ticks: 0, blockedRead: false }, proxy = Object.create(fs);
  proxy.readFileSync = (name, ...args) => {
    if (state.blockedRead && path.resolve(String(name)) === file) throw Object.assign(new Error('primary read unavailable'), { code: 'EACCES' });
    return fs.readFileSync(name, ...args);
  };
  const persist = Persist.host({ fs: proxy, path, writeDurable(deps, name, text) {
    if (path.resolve(name) === file && state.fault === 'before-write') throw Object.assign(new Error('primary write refused'), { code: 'EIO' });
    Persist.writeAtomic(deps, name, text);
    if (path.resolve(name) !== file) return;
    state.writes++;
    if (state.fault === 'corrupt-after' || state.fault === 'unreadable-after') {
      // A matching backup exists after a prior landed attempt, but it cannot prove this primary.
      fs.writeFileSync(file + '.bak', text);
      if (state.fault === 'corrupt-after') fs.writeFileSync(file, '{');
      else state.blockedRead = true;
    }
  } });
  const deps = { fs: proxy, CRON_FILE: file, cronPersistence: Persist, cronStore: Store,
    readJsonResilient: Durable.readJsonResilient, saveJsonVerified: Durable.saveJsonVerified,
    saveResilient: persist.saveResilient, loadResilient: persist.loadResilient, quarantineCorrupt: persist.quarantineCorrupt,
    routineToolsets: { healJobs: jobs => ({ jobs, healed: [] }) }, pairCronJobWires: jobs => ({ jobs, changed: false }),
    router: { dockOf: () => '', intakeReceiptFor: () => null },
    cronLock: { withLock(fn) { return { ran: true, result: fn() }; } }, updateHolding: () => false,
    cronDriver: { applyTick() { state.ticks++; return {}; } }, readBody: async req => JSON.stringify(req.body),
    console: { warn() {}, error() {} }, _sleep: async () => {}, CRON_WRITE_RETRIES: 2, CRON_WRITE_RETRY_MS: 0 };
  const create = new Function(...Object.keys(deps), `
    let cronJobs = [{id:'remembered',name:'unchanged RAM'}], cronDegraded = null, _cronWriteOverride = false;
    let cronToolsetsRepairedOnLoad = 0, cronWiresPairedOnLoad = 0;
    const cronToolsetsRepairNoted = new Set(), cronHealth = {};
    ${pieces}
    return { load: loadCronJobs, save: saveCronJobs, write: withCronWrite, tick: cronTickHealthy,
      get: () => ({jobs:cronJobs,degraded:cronDegraded}), set: jobs => {cronJobs=jobs},
      clear: () => new Promise(resolve => handleCronDegradedClear({body:{confirm:true}}, {
        writeHead(code) {this.code=code}, end(text) {resolve({code:this.code,body:JSON.parse(text)})}
      })) };
  `);
  try {
    fs.writeFileSync(file, JSON.stringify(envelope()));
    await action({ state, file, host: create(...Object.values(deps)), raw: () => fs.readFileSync(file, 'utf8') });
  } catch (error) { A.ok(false, name + ': unexpected fixture exception ' + (error && error.stack || error)); }
  finally {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('cron-publication-')) throw new Error('cron fixture cleanup escaped temporary parent');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
async function fails(fn) { try { await fn(); return false; } catch (_) { return true; } }
(async () => {
  const bootLines = code.split('\n').filter(line => line.includes('cronDriver.recoverFinalizations()'));
  A.eq(bootLines.length, 1, 'the exact host has one boot recovery invocation');
  for (const heldAtExecution of [false, true]) {
    let result, error;
    try {
      result = new Function('heldAtExecution', 'console', `
        let cronDegraded = null;
        const seen = [], cronDriver = { recoverFinalizations() { seen.push(lateChannelOwner); } };
        ${bootLines[0] || ''}
        const lateChannelOwner = 'initialized';
        if (heldAtExecution) cronDegraded = {publicationReadOnly:true};
        return seen;
      `)(heldAtExecution, { warn() {} });
    } catch (caught) { error = caught; }
    A.ok(!error, 'actual boot invocation waits for later channel owner initialization: hold=' + heldAtExecution);
    await Promise.resolve(); await Promise.resolve();
    A.eq(result, heldAtExecution ? [] : ['initialized'], 'actual boot invocation checks the hold at execution: hold=' + heldAtExecution);
  }
  for (const kind of ['future-envelope', 'future-receipt', 'bad-release']) await scenario(kind, async f => {
    const raw = envelope();
    if (kind === 'future-envelope') raw.version = 99;
    if (kind === 'future-receipt') raw.jobs[0].finalization.historyPublications[0].v = 9;
    if (kind === 'bad-release') raw.jobs[0].finalization.historyReleased = 'maybe';
    const bytes = JSON.stringify(raw); fs.writeFileSync(f.file, bytes);
    fs.writeFileSync(f.file + '.bak', JSON.stringify(envelope()));
    const prior = JSON.stringify(f.host.get().jobs);
    f.host.load();
    A.eq(JSON.stringify(f.host.get().jobs), prior, kind + ': load preserves prior RAM');
    A.ok(f.host.get().degraded?.publicationReadOnly === true, kind + ': actual load installs read-only hold');
    A.ok(await fails(() => f.host.save()), kind + ': actual save refuses instead of reinitializing');
    A.ok(await fails(() => f.host.write(() => [{ id: 'replacement', name: 'must not land' }])), kind + ': CRUD path cannot overwrite held bytes');
    A.eq(JSON.stringify(f.host.get().jobs), prior, kind + ': refused CRUD leaves prior RAM intact');
    f.host.tick();
    A.eq(f.state.ticks, 0, kind + ': actual tick dispatches nothing');
    A.eq(f.raw(), bytes, kind + ': primary bytes remain exact');
    A.eq(f.state.writes, 0, kind + ': no save/quarantine/recovery write occurs');
    const refused = await f.host.clear();
    A.eq(refused.code, 409, kind + ': explicit clear cannot trust old RAM or matching backup');
    A.eq(f.raw(), bytes, kind + ': refused clear preserves primary');
    fs.writeFileSync(f.file, JSON.stringify(envelope()));
    const repaired = await f.host.clear();
    A.eq(repaired.code, 200, kind + ': explicit fresh primary validation clears repaired store');
    A.eq(f.host.get().degraded, null, kind + ': hold clears only after primary proof');
    A.eq(f.host.get().jobs, envelope().jobs, kind + ': RAM is restored from primary rather than old memory');
    A.eq(f.state.writes, 0, kind + ': safe clear performs no rewrite');
  });
  for (const fault of ['corrupt-after', 'unreadable-after']) await scenario(fault, async f => {
    f.host.set(envelope().jobs); f.state.fault = fault;
    A.ok(await fails(() => f.host.save()), fault + ': matching backup cannot acknowledge publication persistence');
    A.ok(fs.existsSync(f.file + '.bak'), fault + ': actual matching backup exists');
    A.eq(JSON.parse(fs.readFileSync(f.file + '.bak', 'utf8')).jobs, envelope().jobs, fault + ': backup would falsely satisfy the intended equality');
    f.state.blockedRead = false; f.state.fault = '';
    f.host.save();
    A.eq(JSON.parse(f.raw()).jobs, envelope().jobs, fault + ': later actual primary write/readback can recover');
  });
  await scenario('absent primary clear', async f => {
    const future = envelope(); future.version = 99; fs.writeFileSync(f.file, JSON.stringify(future)); f.host.load();
    fs.writeFileSync(f.file + '.bak', JSON.stringify(envelope())); fs.unlinkSync(f.file);
    const result = await f.host.clear();
    A.eq(result.code, 409, 'clear cannot replace an absent canonical primary with matching backup');
    A.ok(f.host.get().degraded?.publicationReadOnly === true, 'missing primary keeps the read hold');
    A.ok(!fs.existsSync(f.file), 'clear preserves absence rather than recovering backup');
  });
  A.report('cron publication primary proof');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
