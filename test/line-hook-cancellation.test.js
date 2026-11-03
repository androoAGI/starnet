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

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'line-hook-stop-'));
  try {
    for (const retry of ['delete-job', 'disable-trigger', 'remove-trigger', 'e-stop']) await checkRetry(path.join(root, retry), retry);
  } finally {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('line-hook-stop-')) {
      throw new Error('unexpected fixture cleanup path');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  A.report('line-hook-cancellation');
})().catch(error => { console.error(error); process.exitCode = 1; });
