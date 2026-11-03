'use strict';
// The actual request reservation owner and durable LineJobs, with filesystem faults and an injected clock.
const A = require('./_assert.js');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { makeRequestReservations } = require('../sidecar/request-reservations.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');
const { makeDomainStore } = require('../sidecar/domain-store.js');
const J = require('../sidecar/routing/linejobs.js');
const { makeLineRunner } = require('../sidecar/routing/line-runner.js');
const DAY = 86400000, TRIGGER = 'trg_abcdefgh1234';
const attempt = async fn => { try { return { value: await fn() }; } catch (error) { return { error }; } };

function fixture(dir) {
  let now = 1000, seq = 0, calls = 0, failResult = false, failReservation = false, writeThenThrow = false;
  const jobs = makeDomainStore({ fs, path, file: path.join(dir, 'line-jobs.json'), version: 1, writeDurable: writeFileDurable,
    defaults: () => ({ jobs: [] }), normalize: J.normalizeAll, encode: value => ({ jobs: value.jobs }),
    decode: value => value && Array.isArray(value.jobs) ? { jobs: value.jobs } : undefined });
  let state = jobs.load().value;
  const save = result => { jobs.save(result.state); state = result.state; return result.job; };
  const book = makeLineRunner({ runOnce: async () => {}, now: () => now, newId: () => String(++seq),
    jobs: { get: id => J.get(state, id), start: o => save(J.start(state, o)), finish: (id, o) => save(J.finish(state, id, o)) } });
  const deps = { fs, path, workspaces: dir, now: () => now, writeDurable: (d, file, value) => {
    if (file === path.join(dir, 'api-requests.json')) {
      const completed = JSON.parse(value).some(row => row.response);
      if (failReservation && !completed) throw new Error('reservation disk fault');
      if (failResult && completed) {
        if (writeThenThrow) writeFileDurable(d, file, value);
        throw new Error('response disk fault');
      }
    }
    return writeFileDurable(d, file, value);
  } };
  const accepted = job => ({ status: 202, body: { jobId: job.id, streamId: job.streamId, durable: true } });
  const recover = receipt => {
    const job = J.get(state, receipt.runId), delivery = job && job.delivery;
    if (!job || job.entry !== 'trigger' || !delivery || delivery.triggerId !== TRIGGER
      || receipt.scope !== 'trigger:' + TRIGGER || delivery.reservationId !== receipt.id || delivery.fingerprint !== receipt.fingerprint) return null;
    return accepted(job);
  };
  const args = key => ({ scope: 'trigger:' + TRIGGER, key, body: { contentType: 'text/plain', body: 'first delivery' },
    runId: 'job-' + String(++seq).padStart(12, '0'), metadata: { kind: 'line-hook', triggerId: TRIGGER }, recover });
  const execute = async (id, _emit, receipt) => {
    calls++;
    A.ok(receipt && receipt.scope === 'trigger:' + TRIGGER, 'dispatch receives its exact durable reservation identity');
    const job = book.open({ id, line: 'line-intake', entry: 'trigger', text: 'first delivery', streamId: 'trigger-' + id,
      delivery: receipt ? { triggerId: TRIGGER, reservationId: receipt.id, fingerprint: receipt.fingerprint } : undefined });
    return accepted(job);
  };
  return { args, execute, recover, ledger: () => makeRequestReservations(deps), calls: () => calls,
    time: value => { now = value; }, failResult: (value, lands) => { failResult = value; writeThenThrow = !!lands; },
    failReservation: value => { failReservation = value; }, state: () => state,
    restart: () => { state = J.boot(jobs.load().value, now).state; jobs.save(state); },
    replaceJob: patch => { state = { jobs: state.jobs.map(job => Object.assign({}, job, patch)) }; jobs.save(state); } };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'line-hook-reservation-'));
  try {
    {
      const f = fixture(path.join(root, 'duplicates')), ledger = f.ledger(), request = f.args('same');
      const [one, two] = await Promise.all([ledger.run(request, f.execute), ledger.run({ ...request, runId: 'job-second00000' }, f.execute)]);
      A.eq(one, two, 'concurrent duplicates share one accepted job receipt');
      A.eq(f.calls(), 1, 'one dispatch under concurrent duplicates');
      A.eq(one.receiptExpiresAt, 1000 + DAY, 'receipt names the existing completed-response retention boundary');
      A.ok(f.state().jobs[0].delivery && f.state().jobs[0].delivery.triggerId === TRIGGER, 'job durably retains its trigger delivery identity');
      const conflict = await attempt(() => ledger.run({ ...request, body: { body: 'changed' } }, f.execute));
      A.eq(conflict.error && conflict.error.code, 'idempotency_conflict', 'changed payload cannot borrow a delivery key');
      f.restart();
      A.eq(f.state().jobs[0].status, 'interrupted', 'restart honestly interrupts unfinished work');
      A.eq(await f.ledger().run(request, f.execute), one, 'restart returns the same accepted receipt without rerunning');
      A.eq(f.calls(), 1, 'replay after restart never dispatches paid work');
    }
    for (const lands of [false, true]) {
      const f = fixture(path.join(root, 'lost-' + lands)), request = f.args('lost'), ledger = f.ledger();
      f.failResult(true, lands);
      const lost = await attempt(() => ledger.run(request, f.execute));
      A.ok(lost.error && /response disk fault/.test(lost.error.message), 'response persistence fault reaches the caller');
      A.eq(f.calls(), 1, 'work was admitted once before its response failed');
      const original = f.state().jobs[0].id;
      f.failResult(false); f.restart();
      const replay = await attempt(() => f.ledger().run(request, f.execute));
      A.eq(replay.value && replay.value.body.jobId, original, 'lost response recovers only the same durable job: landed=' + lands);
      A.eq(f.calls(), 1, 'lost response never reexecutes after restart');
    }
    for (const mismatch of ['fingerprint', 'reservationId', 'triggerId', 'scope', 'metadata', 'absent']) {
      const f = fixture(path.join(root, 'mismatch-' + mismatch)), request = f.args('held');
      f.failResult(true);
      await attempt(() => f.ledger().run(request, f.execute));
      f.failResult(false);
      let replayArgs = request;
      if (mismatch === 'metadata') replayArgs = { ...request, metadata: { kind: 'different-owner' } };
      else if (mismatch === 'scope') replayArgs = { ...request, recover: receipt => f.recover({ ...receipt, scope: 'trigger:another' }) };
      else if (mismatch === 'absent') f.replaceJob({ id: 'job-unrelated000' });
      else f.replaceJob({ delivery: { ...(f.state().jobs[0].delivery || {}), [mismatch]: mismatch === 'triggerId' ? 'trg_another12345' : 'f'.repeat(64) } });
      const held = await attempt(() => f.ledger().run(replayArgs, f.execute));
      A.eq(held.error && held.error.code, 'request_interrupted', 'missing response refuses mismatched ' + mismatch);
      A.eq(f.calls(), 1, 'a mismatched receipt never recreates work');
    }
    {
      const f = fixture(path.join(root, 'lifetime')), ledger = f.ledger(), request = f.args('timed');
      const first = await ledger.run(request, f.execute);
      f.time(1000 + DAY - 1);
      await ledger.run(f.args('before-boundary'), f.execute);
      A.eq((await ledger.run(request, f.execute)).body.jobId, first.body.jobId, 'another admission just inside24h retains the same job');
      f.time(1000 + DAY);
      await ledger.run(f.args('at-boundary'), f.execute);
      const after = await ledger.run({ ...request, runId: 'job-afterexpiry1' }, f.execute);
      A.ok(after.body.jobId !== first.body.jobId, 'at24h a subsequent admission may prune the completed receipt, as documented');
      A.eq(after.receiptExpiresAt, 1000 + DAY + DAY, 'new admission has its own complete retention window');
      const orphan = f.args('orphan');
      await attempt(() => ledger.run(orphan, async () => { throw new Error('before job creation'); }));
      f.time(1000 + 10 * DAY);
      await ledger.run(f.args('late-admission'), f.execute);
      const held = await attempt(() => f.ledger().run(orphan, f.execute));
      A.eq(held.error && held.error.code, 'request_interrupted', 'unfinished reservations never expire into replay permission');
    }
    {
      const f = fixture(path.join(root, 'reserve-failure'));
      f.failReservation(true);
      const failed = await attempt(() => f.ledger().run(f.args('cannot-start'), f.execute));
      A.ok(failed.error && /reservation disk fault/.test(failed.error.message), 'write-ahead reservation failure is surfaced');
      A.eq([f.calls(), f.state().jobs.length], [0, 0], 'failed reservation creates no job and dispatches nothing');
    }
    A.report('line-hook-reservations.test');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
