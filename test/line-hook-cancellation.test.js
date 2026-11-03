// Actual TriggerRunner + LineRunner book + durable LineJobs under a terminal-write fault.
'use strict';
const path = require('node:path'), fs = require('node:fs'), os = require('node:os');
const A = require('./_assert.js'), J = require('../sidecar/routing/linejobs.js');
const { makeDomainStore } = require('../sidecar/domain-store.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');
const { makeLineRunner } = require('../sidecar/routing/line-runner.js');
const { makeTriggerRunner } = require('../sidecar/routing/trigger-runner.js');
const turn = () => new Promise(resolve => setImmediate(resolve));

async function checkRetry(dir, retry) {
  console.log('cancellation retry: ' + retry);
  let state = { jobs: [] }, fail = false, seq = 0, finishFirst;
  const calls = [], warnings = [], second = 'job-cancel000002';
  const store = makeDomainStore({ fs, path, file: path.join(dir, 'line-jobs.json'), version: 1,
    defaults: () => ({ jobs: [] }), normalize: J.normalizeAll,
    encode: value => ({ jobs: value.jobs }),
    decode: value => value && Array.isArray(value.jobs) ? { jobs: value.jobs } : undefined,
    writeDurable: (deps, file, text) => {
      const value = JSON.parse(text);
      if (fail && (value.jobs || []).some(job => job.id === second && job.status === 'stopped')) {
        throw Object.assign(new Error('fixture stopped-job write refusal'), { code: 'EIO' });
      }
      return writeFileDurable(deps, file, text);
    }
  });
  const save = result => { store.save(result.state); state = result.state; return result.job; };
  const book = makeLineRunner({ runOnce: async () => {}, now: () => 1000, newId: () => String(++seq),
    jobs: { get: id => J.get(state, id), start: options => save(J.start(state, options)),
      finish: (id, result) => save(J.finish(state, id, result)) } });
  let triggers = { triggers: [] };
  const runner = makeTriggerRunner({ load: () => triggers, save: value => { triggers = value; }, lineRunner: book,
    now: () => 1000, newId: () => String(++seq).padStart(12, '0'), warn: message => warnings.push(message),
    plan: () => ({ lines: [{ lineId: 'line-one' }], reach: { writer: true }, lineOfAgent: { writer: 'line-one' } }),
    runsFor: () => [],
    makeHub: hooks => ({
      onInbound: message => {
        calls.push(message.text);
        hooks.onRouted({ agentId: 'writer' }); hooks.onResolved({ agentId: 'writer', lineId: 'line-one' });
        return new Promise(resolve => { finishFirst = resolve; });
      },
      close() {}
    })
  });
  const trigger = runner.create({ kind: 'webhook', lineId: 'line-one', maxPerHour: 60 }).trigger.id;
  A.ok(runner.enqueue(trigger, { jobId: 'job-running00001', text: 'first' }).ok, 'first job accepted');
  await turn();
  A.ok(runner.enqueue(trigger, { jobId: second, text: 'second' }).ok, 'second job strictly recorded before queue');
  fail = true;
  A.throws(() => book.stop(second, 'user'), 'initial cancellation reports the actual failed durable finish');
  A.eq(J.get(store.load().value, second).status, 'running', 'failed finish does not pretend the job is durably stopped');
  finishFirst();
  for (let i = 0; i < 8; i++) await turn();
  A.eq(calls, ['first'], 'cancelled queued work never reaches the hub even when finish storage fails');
  A.eq(runner.view(trigger).queued, 1, 'failed terminal storage still occupies its truthful queue slot');
  A.throws(() => book.stop(second, 'user'), 'a second failed cancellation remains explicit and owned');
  fail = false;
  if (retry === 'delete-job') A.eq(book.stop(second, 'user'), true, 'same exact job remains reachable for cancellation retry');
  else if (retry === 'disable-trigger') A.ok(runner.update(trigger, { enabled: false }).ok, 'disabling the trigger retries its retained waiting job');
  else if (retry === 'remove-trigger') A.ok(runner.remove(trigger).ok, 'removing the trigger retries its retained waiting job');
  else A.eq(runner.haltAll(), 1, 'E-STOP accounts for the exact retained waiting job');
  A.eq(J.get(state, second).status, 'stopped', 'retry after disk recovery durably settles the cancelled job');
  A.eq(J.get(store.load().value, second).status, 'stopped', 'readback proves the retry survived storage');
  A.eq(book.get(second), null, 'successful cancellation releases its private book owner');
  A.eq(calls, ['first'], 'retry never reruns paid work');
  console.log(JSON.stringify({ warnings }));
}

async function checkWithdrawal(dir, mode) {
  console.log('queued withdrawal: ' + mode);
  let state = { jobs: [] }, fail = false, seq = 0, halted = false;
  const calls = [], releases = [], warnings = [], second = 'job-withdraw002';
  const store = makeDomainStore({ fs, path, file: path.join(dir, 'line-jobs.json'), version: 1,
    defaults: () => ({ jobs: [] }), normalize: J.normalizeAll,
    encode: value => ({ jobs: value.jobs }),
    decode: value => value && Array.isArray(value.jobs) ? { jobs: value.jobs } : undefined,
    writeDurable: (deps, file, text) => {
      const value = JSON.parse(text);
      if (fail && value.jobs.some(job => job.id === second && job.status !== 'running')) {
        throw Object.assign(new Error('fixture withdrawn-job write refusal'), { code: 'EIO' });
      }
      return writeFileDurable(deps, file, text);
    }
  });
  const save = result => { store.save(result.state); state = result.state; return result.job; };
  const book = makeLineRunner({ runOnce: async () => {}, now: () => 1000, newId: () => String(++seq),
    jobs: { get: id => J.get(state, id), start: options => save(J.start(state, options)),
      finish: (id, result) => save(J.finish(state, id, result)) } });
  let triggers = { triggers: [] };
  const runner = makeTriggerRunner({ load: () => triggers, save: value => { triggers = value; }, lineRunner: book,
    now: () => 1000, newId: () => String(++seq).padStart(12, '0'), halted: () => halted,
    faulted: () => mode === 'fault', warn: message => warnings.push(message),
    plan: () => ({ lines: [{ lineId: 'line-one' }], reach: { writer: true }, lineOfAgent: { writer: 'line-one' } }),
    runsFor: () => [], makeHub: hooks => ({ onInbound: message => {
      calls.push(message.text);
      hooks.onRouted({ agentId: 'writer' }); hooks.onResolved({ agentId: 'writer', lineId: 'line-one' });
      if (message.text.startsWith('active')) return new Promise(resolve => releases.push(resolve));
      return Promise.resolve();
    }, close() {} })
  });
  const first = runner.create({ kind: 'webhook', lineId: 'line-one', maxPerHour: 60 }).trigger.id;
  A.ok(runner.enqueue(first, { jobId: 'job-active0001', text: 'active-one' }).ok, 'first trigger active admitted');
  await turn();
  A.ok(runner.enqueue(first, { jobId: second, text: 'withdraw-one' }).ok, 'first queued identity admitted');
  A.ok(runner.enqueue(first, { jobId: 'job-withdraw003', text: 'withdraw-two' }).ok, 'second queued identity admitted');
  let other = null;
  if (mode === 'e-stop' || mode === 'fault') {
    other = runner.create({ kind: 'webhook', lineId: 'line-one', maxPerHour: 60 }).trigger.id;
    A.ok(runner.enqueue(other, { jobId: 'job-active0002', text: 'active-other' }).ok, 'second trigger active admitted');
    await turn();
    A.ok(runner.enqueue(other, { jobId: 'job-withdraw004', text: 'withdraw-other' }).ok, 'another trigger queued identity admitted');
  }
  const activeCalls = calls.slice();
  fail = true;
  // No explicit job STOP precedes this withdrawal: its intent must survive the failing write itself.
  if (other) { halted = true; A.throws(() => runner.haltAll(), 'E-STOP reports queue terminal persistence failure'); }
  else if (mode === 'remove') A.throws(() => runner.remove(first), 'remove reports queue terminal persistence failure');
  else A.throws(() => runner.update(first, { enabled: false }), 'disable reports queue terminal persistence failure');
  A.eq(J.get(store.load().value, second).status, 'running', 'failure keeps durable running state honest');
  A.eq(runner._internals.live.get(first).queue.length, 2, 'both exact queued owners remain held after first write fails');
  // Restore the admission gate before the active runs unwind. Withdrawn work must still stay withdrawn.
  fail = false; halted = false;
  if (mode === 'disable') A.ok(runner.update(first, { enabled: true }).ok, 'trigger can be re-enabled for future work');
  for (const release of releases) release();
  for (let i = 0; i < 12; i++) await turn();
  A.eq(calls, activeCalls, 'no withdrawn item reaches any hub after resume/re-enable');
  const ids = [second, 'job-withdraw003'].concat(other ? ['job-withdraw004'] : []);
  for (const id of ids) {
    A.eq(book.stop(id, 'user'), true, 'every withdrawn identity keeps its exact retry owner: ' + id);
    A.eq(J.get(store.load().value, id).status, 'stopped', 'recovered durable STOP is readable: ' + id);
    A.eq(book.get(id), null, 'durable settlement releases exact book owner: ' + id);
    if (mode === 'fault') A.eq(J.get(state, id).stop && J.get(state, id).stop.code, 'station_fault', 'fault cause survives later user STOP retry');
  }
  for (let i = 0; i < 6; i++) await turn();
  A.eq(calls, activeCalls, 'terminal retries never replay provider work');
  A.ok(!runner._internals.live.has(first) || runner._internals.live.get(first).queue.length === 0, 'queue capacity releases only after terminal write');
  console.log(JSON.stringify({ warnings }));
}

async function checkPrestart(mode, writeFailure) {
  console.log('withdraw before dispatch microtask: ' + mode + ', writeFailure=' + writeFailure);
  let state = { jobs: [] }, seq = 0, fail = writeFailure, halted = false;
  const calls = [], id = 'job-prestart001';
  const book = makeLineRunner({ runOnce: async () => {}, now: () => 1000, newId: () => String(++seq), jobs: {
    get: key => J.get(state, key), start: opts => { const r = J.start(state, opts); state = r.state; return r.job; },
    finish: (key, facts) => {
      if (fail) throw Object.assign(new Error('prestart terminal write fault'), { code: 'EIO' });
      const r = J.finish(state, key, facts); state = r.state; return r.job;
    }
  } });
  const runner = makeTriggerRunner({ load: () => ({ triggers: [] }), save() {}, lineRunner: book,
    now: () => 1000, newId: () => String(++seq).padStart(12, '0'), halted: () => halted, warn() {},
    plan: () => ({ lines: [{ lineId: 'line-one' }], reach: { writer: true }, lineOfAgent: { writer: 'line-one' } }),
    makeHub: hooks => ({ onInbound: async message => {
      calls.push(message.text); hooks.onRouted({ agentId: 'writer' });
      hooks.onResolved({ agentId: 'writer', lineId: 'line-one' });
    }, close() {} })
  });
  const trigger = runner.create({ kind: 'webhook', lineId: 'line-one', maxPerHour: 60 }).trigger.id;
  A.ok(runner.enqueue(trigger, { jobId: id, text: 'must not start' }).ok, 'scheduled item admitted before microtask');
  const withdraw = () => mode === 'disable' ? runner.update(trigger, { enabled: false })
    : mode === 'remove' ? runner.remove(trigger) : runner.haltAll();
  halted = mode === 'e-stop';
  if (writeFailure) A.throws(withdraw, 'prestart withdrawal reports strict persistence failure');
  else A.notThrows(withdraw, 'prestart withdrawal can persist normally');
  halted = false;
  if (mode === 'disable') runner.update(trigger, { enabled: true });
  for (let i = 0; i < 10; i++) await turn();
  A.eq(calls, [], 'withdrawn scheduled item never enters hub after immediate resume');
  if (writeFailure) {
    A.eq(J.get(state, id).status, 'running', 'failed prestart finish does not claim durable settlement');
    A.ok(book.get(id), 'failed scheduled item keeps exact retry ownership');
    fail = false;
    A.eq(book.stop(id, 'user'), true, 'recovered scheduled item can settle by exact STOP');
  }
  A.eq(book.get(id), null, 'successful prestart finish releases exact book handle');
  A.ok(J.get(state, id).status !== 'running', 'terminal prestart state is recorded');
  A.eq(calls, [], 'no retry buys provider work');
}

async function checkQueuedFile(dir) {
  const calls = []; let seq = 0;
  const runner = makeTriggerRunner({ load: () => ({ triggers: [] }), save() {},
    now: () => 1000, newId: () => String(++seq).padStart(12, '0'),
    plan: () => ({ lines: [{ lineId: 'line-one' }], reach: { writer: true }, lineOfAgent: { writer: 'line-one' } }),
    makeHub: hooks => ({ onInbound: async message => {
      calls.push(message.text); hooks.onRouted({ agentId: 'writer' });
      hooks.onResolved({ agentId: 'writer', lineId: 'line-one' });
    }, close() {} })
  });
  const created = runner.create({ kind: 'folder', lineId: 'line-one', config: { path: dir, task: 'read the file' } });
  A.ok(created.ok, 'folder trigger created');
  const trigger = created.trigger.id, item = { text: 'file work', seenKey: 'file-v1' };
  A.ok(runner.enqueue(trigger, item).ok, 'folder item without durable jobId admitted');
  A.ok(runner.update(trigger, { enabled: false }).ok, 'folder prestart item withdrawn');
  runner.update(trigger, { enabled: true });
  for (let i = 0; i < 8; i++) await turn();
  A.eq(calls, [], 'withdrawn folder item never reaches hub');
  A.eq(runner.seenFor(trigger), {}, 'withdrawal never records a folder file as fired');
  A.eq(runner._internals.live.get(trigger).queuedKeys.size, 0, 'withdrawal releases exact pending seen key');
  A.ok(runner.enqueue(trigger, item).ok, 'later intentional file admission is allowed');
  for (let i = 0; i < 8; i++) await turn();
  A.eq(calls, ['file work'], 'only the later intentional admission executes');
  A.eq(runner.seenFor(trigger)['file-v1'], 1000, 'real dispatch records the file as fired');
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'line-hook-stop-'));
  try {
    for (const retry of ['delete-job', 'disable-trigger', 'remove-trigger', 'e-stop']) await checkRetry(path.join(root, retry), retry);
    for (const mode of ['disable', 'remove', 'e-stop', 'fault']) await checkWithdrawal(path.join(root, 'withdraw-' + mode), mode);
    for (const mode of ['disable', 'remove', 'e-stop']) for (const failed of [false, true]) await checkPrestart(mode, failed);
    await checkQueuedFile(root);
  } finally {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('line-hook-stop-')) {
      throw new Error('unexpected fixture cleanup path');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  A.report('line-hook-cancellation');
})().catch(error => { console.error(error); process.exitCode = 1; });
