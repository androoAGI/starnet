'use strict';
/* Private actual host enrollment, canonical filesystem writes and lost ACKs.
   The saved-old control runs only mutually representable bridge refusals below. */
const fs = require('node:fs');
const A = require('./_assert.js');
const { J, Spend, metadata, attempt, allocated, old } = require('./helpers/line-accounting-host.js');
const { fixture, clone, digest } = require('./helpers/line-continuation.js');

// Seeded old/current negative controls exercise the existing receipt bridge,
// never a missing new enrollment function or an invented successful initializer.
for (const kind of ['prepared', 'missing-job-marker', 'mismatched-id']) allocated(({ host, jobFile, spendFile, f }) => {
  const before = [digest(fs.readFileSync(jobFile, 'utf8')), digest(fs.readFileSync(spendFile, 'utf8'))];
  A.ok(attempt(() => host.book('job-holdfixture1', 1, 'run-entry')).error, kind + ': unconfirmed enrollment cannot authorize a paid-result checkpoint');
  A.eq(f.writes.length, 0, kind + ': private bridge refuses before modifying either owner');
  A.eq([digest(fs.readFileSync(jobFile, 'utf8')), digest(fs.readFileSync(spendFile, 'utf8'))], before, kind + ': original accounting and work bytes remain exact');
}, ({ write, jobFile, spendFile }) => {
  const data = fixture(); data.continuation.accounting.dayReceipts = [];
  const jobs = J.checkpoint(J.start({ jobs: [] }, Object.assign({}, data.job, { at: 100 })).state,
    data.job.id, 0, data.continuation).state.jobs;
  const jobRoot = { version: 1, jobs };
  if (kind !== 'missing-job-marker') jobRoot.continuationAccounting = metadata(kind === 'prepared' ? 'prepared' : 'confirmed');
  write(jobFile, jobRoot);
  write(spendFile, { version: 1, lines: { 'line-a': { day: 0, usd: 5 } },
    continuationAccounting: metadata('confirmed', kind === 'mismatched-id' ? 'ledger-other' : 'ledger-fixture') });
});

if (!old) {
  A.throws(() => J.enrollAccounting({ jobs: [] }, 'ledger-fixture', 'confirmed'), 'pure owner cannot skip the durable prepared phase');
  const preparedState = J.enrollAccounting({ jobs: [] }, 'ledger-fixture', 'prepared').state;
  const confirmedState = J.enrollAccounting(preparedState, 'ledger-fixture', 'confirmed').state;
  A.eq(J.enrollAccounting(confirmedState, 'ledger-fixture', 'prepared').state, confirmedState, 'a repeated prepare never downgrades confirmed authority');
  A.throws(() => J.enrollAccounting(preparedState, 'ledger-conflict', 'confirmed'), 'prepared authority cannot be adopted by another ID');

  allocated(({ host, raw, jobFile, spendFile, f, loadHost }) => {
    const enrolled = host.enroll();
    A.eq(f.writes.map(r => [r.file === jobFile ? 'jobs' : 'ledger', r.enrollment.state]),
      [['jobs', 'prepared'], ['ledger', 'confirmed'], ['jobs', 'confirmed']], 'prepared receipt, ledger proof and job confirmation occur in order');
    A.eq([raw(jobFile).continuationAccounting, raw(spendFile).continuationAccounting], [enrolled, enrolled], 'both canonical primary owners confirm the same permanent ID');
    A.eq(raw(spendFile).lines, { 'line-a': { day: 0, usd: 5 } }, 'adoption preserves all existing amounts without a synthetic booking');
    A.eq(loadHost().enroll(), enrolled, 'a restarted second caller reconciles the same enrollment');
    A.eq([f.writes.length, f.mints], [3, 1], 'confirmed retry writes nothing and mints no replacement identity');
    host.ledger.note('line-a', 0, { jobId: 'job-receiptfixture1', runId: 'run-zero', endedAt: 100 });
    host.ledger.note('line-a', 0.25);
    A.eq(raw(spendFile).continuationAccounting, enrolled, 'strict zero receipt and legacy note preserve permanent enrollment');
    A.eq(raw(spendFile).lines['line-a'].receipts.length, 1, 'legacy note preserves exact zero-USD receipt authority');
  });

  // Real writes land before readback faults. Restart and same-process retries
  // each prove their own phase; no fixture simply makes save return true.
  for (const phase of ['prepare', 'ledger', 'confirm']) for (const mode of ['before', 'after']) for (const restart of [false, true]) {
    allocated(({ host, f, raw, jobFile, spendFile, loadHost }) => {
      const originalLines = clone(raw(spendFile).lines);
      const target = phase === 'ledger' ? spendFile : jobFile;
      f[mode] = target; f.atWrite = phase === 'confirm' ? 2 : 1;
      A.ok(attempt(() => host.enroll()).error, phase + '/' + mode + '/' + restart + ': unconfirmed write refuses the enrollment ACK');
      const savedId = raw(jobFile).continuationAccounting && raw(jobFile).continuationAccounting.ledgerId;
      const writes = f.writes.length;
      A.eq(raw(spendFile).lines, originalLines, phase + ': refused enrollment preserves the entire positive/zero-USD receipt authority');
      f.before = ''; f.after = ''; f.atWrite = 0; f.readsBlocked.clear();
      const retry = (restart ? loadHost() : host).enroll();
      A.eq([raw(jobFile).continuationAccounting, raw(spendFile).continuationAccounting], [retry, retry], phase + ': retry proves both exact primary records');
      A.eq(raw(spendFile).lines, originalLines, phase + ': successful reconciliation also preserves every original amount and receipt');
      if (savedId) A.eq(retry.ledgerId, savedId, phase + ': lost ACK preserves the already durable ID');
      A.ok(f.writes.length >= writes && f.writes.length <= 3, phase + ': retry never duplicates a confirmed phase write');
    }, ({ write, spendFile }) => write(spendFile, { version: 1, lines: { 'line-a': { day: 0, usd: 5, receiptVersion: 1, receipts: [
      { jobId: 'job-enrollmentprior1', runId: 'run-prior-paid', day: 0, usd: 5 },
      { jobId: 'job-enrollmentprior1', runId: 'run-prior-zero', day: 0, usd: 0 }
    ] } } }));
  }

  allocated(({ host, f, raw, jobFile, spendFile }) => {
    f.after = spendFile;
    A.ok(attempt(() => host.enroll()).error, 'landed ledger metadata with failed readback is not acknowledged');
    const original = digest(fs.readFileSync(spendFile, 'utf8'));
    A.notThrows(() => host.ledger.note('line-a', 0.25), 'ordinary reply still tolerates a legacy spend note during enrollment uncertainty');
    A.eq(digest(fs.readFileSync(spendFile, 'utf8')), original, 'legacy note cannot overwrite uncertain landed metadata');
    A.eq(raw(jobFile).continuationAccounting.state, 'prepared', 'job marker remains prepared while ledger proof is unavailable');
    f.after = ''; f.readsBlocked.clear();
    const enrolled = host.enroll();
    A.eq([raw(spendFile).continuationAccounting, raw(spendFile).lines['line-a'].usd], [enrolled, 5.25], 'exact pending write reconciliation preserves enrollment plus the later legacy amount');
  });

  allocated(({ host, f, raw, write, spendFile }) => {
    f.after = spendFile;
    A.ok(attempt(() => host.enroll()).error, 'uncertain metadata write is retained before testing a conflicting canonical state');
    f.after = ''; f.readsBlocked.clear();
    const other = raw(spendFile); other.lines['line-a'].usd = 9; write(spendFile, other);
    const before = digest(fs.readFileSync(spendFile, 'utf8')), count = f.writes.length;
    A.ok(attempt(() => host.enroll()).error, 'a pending write cannot use same-ID metadata to overwrite an unrelated canonical snapshot');
    A.eq([digest(fs.readFileSync(spendFile, 'utf8')), f.writes.length], [before, count], 'uncertain retry preserves the competing nine-dollar ledger');
  });

  for (const missing of ['ledger', 'jobs', 'both']) allocated(({ host, f, jobFile, spendFile, loadHost }) => {
    host.enroll();
    const before = f.writes.length, mints = f.mints;
    for (const file of missing === 'both' ? [jobFile, spendFile] : [missing === 'jobs' ? jobFile : spendFile]) {
      f.hidden.add(file); f.hidden.add(file + '.bak');
    }
    A.ok(attempt(() => loadHost().enroll()).error, missing + ': restart cannot reinterpret missing enrolled history as a new generation');
    A.eq([f.writes.length, f.mints], [before, mints], missing + ': no reinitialization write or identity mint occurs');
  });

  for (const mode of ['missing', 'corrupt', 'locked']) allocated(({ host, f, jobFile, spendFile, raw }) => {
    const bytes = [digest(fs.readFileSync(jobFile, 'utf8')), fs.existsSync(spendFile) ? digest(fs.readFileSync(spendFile, 'utf8')) : null,
      digest(fs.readFileSync(spendFile + '.bak', 'utf8'))];
    if (mode === 'locked') f.readsBlocked.add(spendFile);
    A.ok(attempt(() => host.enroll()).error, mode + ': backup or unreadable primary never authorizes enrollment');
    A.eq(f.writes.length, 0, mode + ': enrollment leaves both real store owners untouched');
    if (mode !== 'locked') A.eq(host.ledger.spentToday('line-a'), 5, mode + ': recovered legacy cap floor is still visible');
    A.eq([digest(fs.readFileSync(jobFile, 'utf8')), fs.existsSync(spendFile) ? digest(fs.readFileSync(spendFile, 'utf8')) : null,
      digest(fs.readFileSync(spendFile + '.bak', 'utf8'))], bytes, mode + ': original primary/backup bytes remain exact');
  }, ({ write, spendFile }) => {
    write(spendFile + '.bak', { version: 1, lines: { 'line-a': { day: 0, usd: 5 } } });
    if (mode === 'missing') fs.unlinkSync(spendFile);
    if (mode === 'corrupt') fs.writeFileSync(spendFile, '{fixture corrupt primary');
  });

  for (const target of ['jobs', 'ledger']) for (const bad of [null, { version: 2, ledgerId: 'future', state: 'confirmed', opaque: ['keep', 7] }]) {
    allocated(({ host, f, raw, jobFile, spendFile }) => {
      const file = target === 'jobs' ? jobFile : spendFile, before = digest(fs.readFileSync(file, 'utf8'));
      A.ok(attempt(() => host.enroll()).error, target + ': future/malformed enrollment refuses migration');
      if (target === 'ledger') {
        A.eq(host.ledger.spentToday('line-a'), 5, 'unknown root authority does not erase the existing legacy floor projection');
        A.notThrows(() => host.ledger.note('line-a', 0.25), 'legacy note remains best effort while root authority is opaque');
      } else A.ok(attempt(() => host.mutate(s => J.start(s, { id: 'job-opaquechange1', line: 'line-a', at: 2 }))).error, 'ordinary host mutation cannot erase opaque job-root authority');
      A.eq([f.writes.length, digest(fs.readFileSync(file, 'utf8'))], [0, before], target + ': opaque root bytes remain exact');
      A.eq(raw(file).continuationAccounting, bad, target + ': unknown metadata remains in its original existing store');
    }, ({ raw, write, jobFile, spendFile }) => {
      const file = target === 'jobs' ? jobFile : spendFile;
      write(file, Object.assign(raw(file), { continuationAccounting: bad }));
    });
  }

  allocated(({ host, f, jobFile, spendFile, raw, write }) => {
    f.onWrite = target => {
      if (target !== jobFile) return;
      f.onWrite = null;
      const value = raw(spendFile); value.lines['line-a'].usd = 7;
      write(spendFile, value); // Represents a different canonical owner write, not cached RAM.
    };
    A.ok(attempt(() => host.enroll()).error, 'changed canonical ledger between preparation and adoption requires explicit retry');
    A.eq(raw(spendFile).lines['line-a'].usd, 7, 'stale enrollment candidate never restores the old five-dollar snapshot');
    const enrolled = host.enroll();
    A.eq([raw(spendFile).lines['line-a'].usd, raw(spendFile).continuationAccounting], [7, enrolled], 'explicit retry adopts the fresh seven-dollar authority');
  });

  allocated(({ host, f, jobFile, spendFile, raw, write }) => {
    host.enroll();
    const value = raw(spendFile); value.continuationAccounting = metadata('confirmed', 'ledger-conflict'); write(spendFile, value);
    const before = f.writes.length;
    A.ok(attempt(() => host.enroll()).error, 'conflicting permanent ledger identity cannot replace the confirmed job-root receipt');
    A.eq(f.writes.length, before, 'identity conflict causes no repair-by-overwrite');
    A.eq(raw(jobFile).continuationAccounting.ledgerId !== 'ledger-conflict', true, 'original job-root identity remains unchanged');
  });

  allocated(({ host, f, jobFile, spendFile, raw, write }) => {
    f.onWrite = target => {
      if (target !== spendFile) return;
      f.onWrite = null;
      write(jobFile, Object.assign(raw(jobFile), { continuationAccounting: metadata('prepared', 'ledger-other-owner') }));
    };
    A.ok(attempt(() => host.enroll()).error, 'another prepared identity at the confirmation boundary cannot be stolen by the original caller');
    A.eq(raw(jobFile).continuationAccounting, metadata('prepared', 'ledger-other-owner'), 'fresh confirmation refuses rather than overwriting the other prepared receipt');
    A.ok(attempt(() => host.enroll()).error, 'explicit retry still refuses the now-mismatched pair');
  });

  allocated(({ host, f, jobFile, spendFile, raw, loadHost }) => {
    const enrolled = host.enroll();
    for (let i = 0; i < J.MAX_JOBS + 2; i++) {
      const id = 'job-' + String(i).padStart(12, '0');
      host.mutate(s => J.start(s, { id, line: 'line-a', at: i + 1 }));
      host.mutate(s => J.finish(s, id, { status: 'failed', outcome: 'error', at: i + 2, usd: 0, runs: [] }));
    }
    A.ok(!raw(jobFile).jobs.some(j => j.id === 'job-000000000000'), 'actual host retention prunes the first completed record');
    A.eq(raw(jobFile).continuationAccounting, enrolled, 'permanent root authority survives actual host retention and readback');
    f.hidden.add(spendFile); f.hidden.add(spendFile + '.bak');
    const writes = f.writes.length;
    A.ok(attempt(() => loadHost().enroll()).error, 'pruned job history cannot make a missing ledger appear uninitialized');
    A.eq(f.writes.length, writes, 'retention followed by ledger loss cannot create empty replacement history');
  });
}
A.report('line-accounting.enrollment');
