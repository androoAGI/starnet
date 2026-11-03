'use strict';
/* Exact source01 control: both old and current implement enrollment. Only saved
   metadata is edited; every job, line amount and receipt remains unchanged. */
const fs = require('node:fs');
const A = require('./_assert.js');
const { J, metadata, attempt, allocated } = require('./helpers/line-accounting-host.js');
const { digest } = require('./helpers/line-continuation.js');
function changed(root, mode) {
  if (mode === 'erase') delete root.continuationAccounting;
  else if (mode === 'replace') root.continuationAccounting = metadata('confirmed', 'ledger-replacement');
  else root.continuationAccounting = metadata('prepared', root.continuationAccounting.ledgerId);
  return root;
}
for (const mode of ['erase', 'replace', 'downgrade']) allocated(({ host, f, raw, write, jobFile, spendFile }) => {
  host.enroll();
  const work = raw(jobFile).jobs, lines = raw(spendFile).lines;
  write(jobFile, changed(raw(jobFile), mode));
  if (mode !== 'downgrade') write(spendFile, changed(raw(spendFile), mode));
  const bytes = [digest(fs.readFileSync(jobFile, 'utf8')), digest(fs.readFileSync(spendFile, 'utf8'))];
  const writes = f.writes.length, mints = f.mints;
  A.ok(attempt(() => host.enroll()).error, mode + ': an observed confirmed pair cannot become a new/earlier enrollment');
  A.eq([f.writes.length, f.mints], [writes, mints], mode + ': refusal writes nothing and mints no replacement ID');
  A.eq([digest(fs.readFileSync(jobFile, 'utf8')), digest(fs.readFileSync(spendFile, 'utf8'))], bytes, mode + ': refusal preserves the externally changed canonical bytes');
  A.eq([raw(jobFile).jobs, raw(spendFile).lines], [work, lines], mode + ': the diagnostic changes no job or accounting history');
});

allocated(({ host, f, raw, write, jobFile }) => {
  // The first boot read observes prepared; no successful initializer has run.
  write(jobFile, changed(raw(jobFile), 'erase'));
  A.ok(attempt(() => host.enroll()).error, 'observed prepared identity cannot disappear before adoption');
  A.eq([f.writes.length, f.mints], [0, 0], 'prepared observation is a negative constraint, never permission to mint another ID');
}, ({ raw, write, jobFile }) => write(jobFile, Object.assign(raw(jobFile), { continuationAccounting: metadata('prepared') })));

for (const mode of ['erase', 'replace']) allocated(({ host, f, raw, write, spendFile }) => {
  A.eq(host.ledger.spentToday('line-a'), 5, 'ordinary legacy read observes the enrolled existing floor');
  write(spendFile, changed(raw(spendFile), mode));
  const bytes = digest(fs.readFileSync(spendFile, 'utf8'));
  A.notThrows(() => host.ledger.note('line-a', 0.25), mode + ': legacy reply retains its best-effort contract');
  A.eq([f.writes.length, digest(fs.readFileSync(spendFile, 'utf8'))], [0, bytes], mode + ': the legacy writer cannot erase its earlier enrollment observation');
  A.ok(attempt(() => host.ledger.accountingProof()).error, mode + ': strict ledger proof independently refuses changed observed identity');
}, ({ raw, write, spendFile }) => write(spendFile, Object.assign(raw(spendFile), { continuationAccounting: metadata() })));

for (const mode of ['erase', 'replace', 'downgrade']) allocated(({ host, f, raw, write, jobFile }) => {
  write(jobFile, changed(raw(jobFile), mode));
  const bytes = digest(fs.readFileSync(jobFile, 'utf8'));
  A.ok(attempt(() => host.mutate(s => J.start(s, { id: 'job-laterowner01', line: 'line-a', at: 3 }))).error,
    mode + ': ordinary job writes also honor the first verified root observation');
  A.eq([f.writes.length, digest(fs.readFileSync(jobFile, 'utf8'))], [0, bytes], mode + ': ordinary mutation never replaces changed observed root authority');
}, ({ raw, write, jobFile }) => write(jobFile, Object.assign(raw(jobFile), { continuationAccounting: metadata() })));

for (const phase of ['ledger', 'confirm']) allocated(({ host, f, raw, write, jobFile, spendFile }) => {
  f.after = phase === 'ledger' ? spendFile : jobFile; f.atWrite = phase === 'confirm' ? 2 : 1;
  A.ok(attempt(() => host.enroll()).error, phase + ': actual lost ACK occurs after prepared authority was observed');
  f.after = ''; f.atWrite = 0; f.readsBlocked.clear();
  write(jobFile, changed(raw(jobFile), 'erase')); write(spendFile, changed(raw(spendFile), 'erase'));
  const writes = f.writes.length, mints = f.mints;
  A.ok(attempt(() => host.enroll()).error, phase + ': lost ACK does not clear already observed prepared/confirmed identity');
  A.eq([f.writes.length, f.mints], [writes, mints], phase + ': uncertain retry cannot rewrite a lost marker or mint a new one');
});

A.report('line-accounting.observation');
