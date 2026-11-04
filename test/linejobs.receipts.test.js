'use strict';
/* Private production two-store bridge. Real domain stores, continuation owner and
   ledger; synthetic already-observed attempt facts, zero provider or resume calls. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const A = require('./_assert.js'), J = require('../sidecar/routing/linejobs.js'), C = require('../sidecar/routing/line-continuation.js');
const Spend = require('../sidecar/routing/line-spend.js');
const { makeDomainStore } = require('../sidecar/domain-store.js');
const { fixture, clone, digest } = require('./helpers/line-continuation.js');
// Exact private index storage declarations; no copied bridge or substitute save implementation.
const src = require('./helpers/source.js').readSidecarIndex();
const spendStart = src.indexOf('const LINE_SPEND_FILE = '), spendEnd = src.indexOf('/* SHIPPED is durable', spendStart);
const jobStart = src.indexOf('const LINE_JOBS_FILE = '), jobEnd = src.indexOf('/* GET /api/line-jobs?line=', jobStart);
if (spendStart < 0 || spendEnd <= spendStart || jobStart < 0 || jobEnd <= jobStart) throw new Error('private owner block missing');
const blocks = src.slice(spendStart, spendEnd) + '\n' + src.slice(jobStart, jobEnd);
const attempt = fn => { try { return { value: fn() }; } catch (error) { return { error }; } };
function allocated(run, setup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-job-receipts-'));
  const jobFile = path.join(dir, 'line-jobs.json'), spendFile = path.join(dir, 'line-spend.json');
  const f = { failBefore: '', failAfter: '', badRead: '', jobWrites: 0, spendWrites: 0, afterLedger: null, now: 1000 };
  const data = fixture(); data.continuation.accounting.dayReceipts = [];
  const initial = J.checkpoint(J.start({ jobs: [] }, Object.assign({}, data.job, { at: 100 })).state, data.job.id, 0, data.continuation).state;
  const proxy = Object.create(fs);
  proxy.readFileSync = (p, ...args) => {
    if (path.resolve(String(p)) === f.badRead) { const e = new Error('fixture readback unavailable'); e.code = 'EIO'; throw e; }
    return fs.readFileSync(p, ...args);
  };
  proxy.renameSync = (from, to) => {
    const target = path.resolve(String(to));
    if (target === f.failBefore) { const e = new Error('fixture write refused'); e.code = 'EIO'; throw e; }
    fs.renameSync(from, to);
    if (target === jobFile) f.jobWrites++;
    if (target === spendFile) { f.spendWrites++; if (f.afterLedger) { const once = f.afterLedger; f.afterLedger = null; once(); } }
    if (target === f.failAfter) f.badRead = target;
  };
  const loadHost = () => {
    const context = { fs: proxy, path, WORKSPACES: dir, makeDomainStore, writeFileDurable: undefined, LineJobs: J, LineContinuation: C,
      LineEntryInvocation: require('../sidecar/routing/line-entry-invocation.js'),
      LineEntryAdoption: require('../sidecar/routing/line-entry-adoption.js'), chainRunner: require('../sidecar/routing/chain.js').makeChainRunner({}),
      makeLineSpend: Spend.makeLineSpend, normalizeLineSpendLedger: Spend.normalizeLedger,
      decodeLineSpendEnvelope: Spend.decodeEnvelope, encodeLineSpendEnvelope: Spend.encodeEnvelope,
      crypto: { randomBytes: n => Buffer.alloc(n, 7) },
      LINE_SPEND_DAY_MS: Spend.DAY_MS, Date: { now: () => f.now }, failNote: () => {}, console: { warn: () => {} } };
    // Production declarations and continuation validation share one realm. A
    // separate VM prototype is correctly rejected by capture's plain-JSON guard.
    const build = vm.compileFunction(blocks + '\nreturn {book:lineJobsBookReceipt, enroll:lineJobsEnrollAccounting, jobs:()=>lineJobs, ledger:lineSpend};', Object.keys(context));
    return build(...Object.values(context));
  };
  try {
    fs.writeFileSync(jobFile, JSON.stringify({ version: 1, jobs: initial.jobs }));
    fs.writeFileSync(spendFile, JSON.stringify({ version: 1, lines: {} }));
    if (setup) setup({ f, data, initial, jobFile, spendFile });
    const host = loadHost();
    if (fs.existsSync(spendFile) && JSON.parse(fs.readFileSync(spendFile, 'utf8')).version === 1) {
      host.enroll(); // The private receipt bridge now requires the actual permanent two-owner enrollment.
      f.jobWrites = 0; f.spendWrites = 0;
    }
    run({ f, data, host, loadHost, jobFile, spendFile,
      jobs: () => JSON.parse(fs.readFileSync(jobFile, 'utf8')).jobs,
      lines: () => JSON.parse(fs.readFileSync(spendFile, 'utf8')).lines });
  } finally {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('line-job-receipts-')) throw new Error('fixture escaped temp parent');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

allocated(({ f, data, host, jobs, lines, loadHost }) => {
  A.ok(attempt(() => host.book(data.job.id, 2, 'run-entry')).error, 'wrong revision refuses before booking money');
  A.eq([f.spendWrites, f.jobWrites], [0, 0], 'invalid candidate causes neither ledger nor job write');
  const booked = host.book(data.job.id, 1, 'run-entry');
  A.eq(booked.receipt, { runId: 'run-entry', day: 0, usd: 0.125 }, 'bridge derives exact day from observed endedAt');
  A.eq(jobs()[0].continuation.revision, 2, 'verified acknowledgement advances its saved cursor once');
  A.eq(lines()['line-a'].usd, 0.125, 'original observed amount is booked once');
  const again = host.book(data.job.id, 1, 'run-entry');
  A.ok(again.replayed, 'lost caller ACK re-proves existing ledger receipt and saved acknowledgement');
  A.eq([f.spendWrites, jobs()[0].continuation.revision], [1, 2], 'same-operation retry buys neither another booking nor revision');
  f.now += Spend.DAY_MS;
  const restart = loadHost().book(data.job.id, 1, 'run-entry');
  A.ok(restart.replayed, 'restart on another day reuses exact original receipt');
  A.eq(lines()['line-a'].day, 0, 'resume clock never changes original-day booking');
});

allocated(({ f, data, host, jobs, lines, jobFile }) => {
  f.failAfter = jobFile;
  A.ok(attempt(() => host.book(data.job.id, 1, 'run-entry')).error, 'landed job checkpoint with failed readback is not acknowledged');
  A.eq([f.spendWrites, f.jobWrites], [1, 1], 'both real canonical writes occurred');
  A.eq(host.jobs().jobs[0].continuation.revision, 1, 'unconfirmed checkpoint never becomes published job state');
  A.eq(jobs()[0].continuation.revision, 2, 'the exact job acknowledgement really landed');
  f.failAfter = ''; f.badRead = '';
  const retry = host.book(data.job.id, 1, 'run-entry');
  A.ok(retry.replayed, 'retry reconciles landed job receipt instead of advancing twice');
  A.eq([lines()['line-a'].usd, f.spendWrites, jobs()[0].continuation.accounting.dayReceipts.length], [0.125, 1, 1], 'lost checkpoint ACK never re-adds paid entry cost');
});

allocated(({ data, host, jobs, lines }) => {
  const booked = host.book(data.job.id, 1, 'run-entry');
  A.eq(booked.receipt, { runId: 'run-entry', day: 0, usd: 0 }, 'zero-dollar completion keeps the same exact day/run acknowledgement');
  A.eq([lines()['line-a'].usd, lines()['line-a'].receipts.length, jobs()[0].continuation.accounting.dayReceipts.length], [0, 1, 1], 'zero cost does not skip either durable receipt owner');
}, ({ initial, jobFile }) => {
  initial.jobs[0].continuation.accounting.entryUsd = 0;
  initial.jobs[0].continuation.attempts[0].usd = 0;
  fs.writeFileSync(jobFile, JSON.stringify({ version: 1, jobs: initial.jobs }));
});

allocated(({ f, data, host, jobs, lines, spendFile }) => {
  f.failAfter = spendFile;
  A.ok(attempt(() => host.book(data.job.id, 1, 'run-entry')).error, 'ledger readback failure leaves continuation unadvanced');
  A.eq([jobs()[0].continuation.revision, f.jobWrites], [1, 0], 'no job ACK is written before money proof');
  host.ledger.note('line-a', 0.25);
  f.failAfter = ''; f.badRead = '';
  host.book(data.job.id, 1, 'run-entry');
  A.eq([lines()['line-a'].usd, lines()['line-a'].receipts.length], [0.375, 1], 'interleaved legacy amount preserves owned receipt after lost ACK');
  A.eq(jobs()[0].continuation.accounting.dayReceipts, [{ runId: 'run-entry', day: 0, usd: 0.125 }], 'only this job exact run amount enters its continuation receipt');
});

allocated(({ f, data, host, jobFile, jobs, lines }) => {
  f.afterLedger = () => {
    const rows = jobs(); rows[0].continuation.revision = 2; rows[0].continuation.hold.why = 'a newer valid checkpoint';
    fs.writeFileSync(jobFile, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(jobFile, 'utf8')), { jobs: rows })));
  };
  A.ok(attempt(() => host.book(data.job.id, 1, 'run-entry')).error, 'competing job revision after money proof cannot be overwritten');
  A.eq([jobs()[0].continuation.revision, jobs()[0].continuation.accounting.dayReceipts.length], [2, 0], 'newer checkpoint remains authoritative');
  host.book(data.job.id, 2, 'run-entry');
  A.eq([jobs()[0].continuation.revision, jobs()[0].continuation.hold.why, lines()['line-a'].usd], [3, 'a newer valid checkpoint', 0.125], 'explicit fresh-revision retry adopts one receipt without another charge');
});

allocated(({ data, host, jobs, f }) => {
  A.ok(attempt(() => host.book(data.job.id, 1, 'run-entry')).error, 'newer bucket without exact old receipt remains unconfirmed');
  A.eq([jobs()[0].continuation.revision, f.jobWrites, f.spendWrites], [1, 0, 0], 'obsolete accounting cannot advance or rewrite either owner');
}, ({ f, spendFile }) => { f.now = 2 * Spend.DAY_MS; fs.writeFileSync(spendFile, JSON.stringify({ version: 1, lines: { 'line-a': { day: 2, usd: 0.5, receiptVersion: 1, receipts: [] } } })); });

allocated(({ data, host, f, jobFile }) => {
  const raw = digest(fs.readFileSync(jobFile, 'utf8'));
  A.ok(attempt(() => host.book(data.job.id, 1, 'run-entry')).error, 'saved day acknowledgement cannot authorize replacing a missing ledger');
  A.eq([f.jobWrites, f.spendWrites], [0, 0], 'known missing accounting file causes no write');
  A.eq(digest(fs.readFileSync(jobFile, 'utf8')), raw, 'known receipt survives the missing ledger refusal');
}, ({ initial, jobFile, spendFile }) => {
  initial.jobs[0].continuation.accounting.dayReceipts = [{ runId: 'run-entry', day: 0, usd: 0.125 }];
  fs.writeFileSync(jobFile, JSON.stringify({ version: 1, jobs: initial.jobs })); fs.unlinkSync(spendFile);
});

for (const boundary of ['ledger', 'job']) allocated(({ data, host, f, jobFile, spendFile, loadHost }) => {
  f.failAfter = boundary === 'ledger' ? spendFile : jobFile;
  A.ok(attempt(() => host.book(data.job.id, 1, 'run-entry')).error, boundary + ' lost ACK is observed before restart');
  A.eq(f.spendWrites, 1, boundary + ' lost ACK follows the actual ledger write');
  f.failAfter = ''; f.badRead = '';
  const raw = digest(fs.readFileSync(jobFile, 'utf8')), writes = [f.jobWrites, f.spendWrites];
  fs.unlinkSync(spendFile);
  if (fs.existsSync(spendFile + '.bak')) fs.unlinkSync(spendFile + '.bak');
  A.ok(attempt(() => loadHost().book(data.job.id, 1, 'run-entry')).error, boundary + ' ACK retry after restart refuses missing canonical and backup history');
  A.eq([f.jobWrites, f.spendWrites], writes, boundary + ' ACK retry cannot recreate guessed empty accounting');
  A.eq(digest(fs.readFileSync(jobFile, 'utf8')), raw, boundary + ' ACK retry preserves exact saved continuation bytes');
});

allocated(({ data, host, f }) => {
  A.ok(attempt(() => host.book(data.job.id, 1, 'run-entry')).error, 'private bridge requires explicit canonical ledger initialization even without a saved ACK');
  A.eq([f.jobWrites, f.spendWrites], [0, 0], 'absence is never an implicit initialization operation');
}, ({ spendFile }) => fs.unlinkSync(spendFile));

allocated(({ data, host, f }) => {
  A.ok(attempt(() => host.book(data.job.id, 2, 'run-entry')).error, 'accepted human decision cannot acquire a changed accounting checkpoint');
  A.eq([f.jobWrites, f.spendWrites], [0, 0], 'decision-bound validation occurs before any ledger write');
}, ({ initial, jobFile }) => {
  const claimed = J.claimDecision(initial, initial.jobs[0].id, { token: 'decision-held', revision: 1, action: 'approve', note: '', at: 300 });
  fs.writeFileSync(jobFile, JSON.stringify({ version: 1, jobs: claimed.state.jobs }));
});

allocated(({ data, host, f, spendFile }) => {
  const raw = digest(fs.readFileSync(spendFile, 'utf8'));
  A.notThrows(() => host.ledger.note('line-a', 0.25), 'legacy reply remains best effort beside a future ledger envelope');
  A.ok(attempt(() => host.book(data.job.id, 1, 'run-entry')).error, 'future envelope is not reinterpreted as current receipt authority');
  A.eq([f.jobWrites, f.spendWrites, digest(fs.readFileSync(spendFile, 'utf8'))], [0, 0, raw], 'future envelope stays byte-for-byte unchanged through legacy and strict paths');
}, ({ spendFile }) => fs.writeFileSync(spendFile, JSON.stringify({ version: 2, lines: {}, future: 'opaque receipt authority' })));
A.report('linejobs.receipts');
