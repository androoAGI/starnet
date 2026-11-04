/* sidecar/routing/line-spend.js — per-LINE daily spend ledger for the chain executor's `maxUsdPerDay` cap.

   A line's LINE BUDGET (pipeline.normalizeLineLimits) may carry a $ per DAY ceiling. Per-message spend is
   measured inside one advance(); a day's spend has to outlive the call AND a sidecar restart, or the cap is a
   claim the harness cannot prove after a reboot. This is the smallest durable thing that makes it true:
   { [lineId]: { day, usd } } — one bucket per line, keyed by the UTC day index, re-zeroed on day roll.

   PURE + INJECTED I/O (sidecar determinism law): `now` is injected, persistence is a { load(), save(value) }
   pair the host builds over its domain store (index.js: makeDomainStore -> line-spend.json). Uninjected it is
   memory-only — correct within a process, honest about not surviving one. Legacy note(line,usd) remains
   best effort and never gates its reply. note(line,usd,{jobId,runId,endedAt}) is the private strict receipt
   path: canonical readback must confirm the exact observed run before a continuation can advance. */
'use strict';

const { note: failNote } = require('../failopen.js');   // tagged fail-open: a failed ledger write must never be invisible
const Accounting = require('./line-accounting.js');
const crypto = require('node:crypto');
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024, MAX_JOB_RECEIPTS = 1024;
const READONLY = Symbol('line-spend original receipt authority');
const owns = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const id = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(v);
const jobId = v => typeof v === 'string' && /^job-[a-z0-9]{8,24}$/.test(v);
const uint = v => Number.isSafeInteger(v) && v >= 0;
const money = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const num = v => (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const receiptFields = r => plain(r) && Object.keys(r).length === 4 && ['jobId', 'runId', 'day', 'usd'].every(k => owns(r, k))
  && jobId(r.jobId) && id(r.runId) && uint(r.day) && money(r.usd);
const withReceipts = r => plain(r) && (owns(r, 'receiptVersion') || owns(r, 'receipts'));

function receiptProblem(value) {
  const runs = new Map(), jobs = new Map();
  for (const line of Object.keys(value || {})) {
    const r = value[line];
    if (!withReceipts(r)) continue;
    if (!id(line) || r.receiptVersion !== 1 || Object.keys(r).length !== 4 || !['day', 'usd', 'receiptVersion', 'receipts'].every(k => owns(r, k)) || !uint(r.day) || !money(r.usd)
      || !Array.isArray(r.receipts) || r.receipts.some(x => !receiptFields(x))) return 'unsupported or malformed saved receipt authority';
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(r)); } catch (_) { return 'saved receipts are not plain JSON'; }
    if (bytes > MAX_RECEIPT_BYTES) return 'saved receipt data exceeds the per-line bound';
    let floor = 0;
    for (const rec of r.receipts) {
      if (runs.has(rec.runId)) return 'saved run receipt is duplicated or names conflicting ownership';
      runs.set(rec.runId, line);
      const j = jobs.get(rec.jobId) || { line, count: 0 };
      if (j.line !== line || ++j.count > MAX_JOB_RECEIPTS) return 'saved job receipts change line or exceed the attempt bound';
      jobs.set(rec.jobId, j);
      if (rec.day === r.day) floor += rec.usd;
    }
    // USD is binary floating point; use the same addition order at booking and a
    // tiny relative rounding allowance only for the sum, never for receipt identity.
    if (!money(floor) || floor > r.usd + Number.EPSILON * Math.max(1, floor, r.usd) * r.receipts.length) return 'saved receipts exceed their day bucket';
  }
  return '';
}
function clean(value) {
  const out = Object.create(null);
  if (!plain(value)) return out;
  for (const k of Object.keys(value)) {
    const r = value[k];
    if (!plain(r)) continue;
    if (withReceipts(r)) {
      // Unknown/future/oversized authority remains intact. The encoder refuses
      // its rewrite; legacy note must never clean it into an empty dedupe set.
      out[k] = r;
    } else if (typeof r.day === 'number' && isFinite(r.day)) out[k] = { day: r.day, usd: num(r.usd) };
  }
  const issue = receiptProblem(out);
  if (issue) Object.defineProperty(out, READONLY, { value: issue });
  else for (const k of Object.keys(out)) if (withReceipts(out[k])) {
    const r = out[k];
    out[k] = { day: r.day, usd: r.usd, receiptVersion: 1,
      receipts: r.receipts.map(x => ({ jobId: x.jobId, runId: x.runId, day: x.day, usd: x.usd })) };
  }
  return out;
}
function assertWritable(value) {
  const issue = value && value[READONLY] || receiptProblem(value);
  if (issue) { const error = new Error('line-spend: ' + issue + '; original data must be preserved'); error.code = 'ELINE_SPEND_READONLY'; throw error; }
}

/* The file's root is explicit. Existing injected load/save and read/write APIs
   still take the flat line table; only the production envelope adapter opts in.
   Metadata is never a synthetic line and cannot be erased by a legacy note. */
function normalizeLedger(value) {
  const out = Accounting.preserve(value, { lines: clean(value && value.lines) });
  if ((value && value[READONLY]) || (Accounting.owns(value, Accounting.FIELD) && !plain(value.lines))) {
    Object.defineProperty(out, READONLY, { value: value[READONLY] || 'accounting enrollment has no valid enclosing ledger' });
  }
  return out;
}
function assertLedgerWritable(value) {
  Accounting.demand(value, 'ledger');
  if (!value || !plain(value.lines) || value[READONLY]) {
    const e = new Error('line-spend: original accounting envelope must be preserved'); e.code = 'ELINE_SPEND_READONLY'; throw e;
  }
  assertWritable(value.lines);
}
function decodeEnvelope(envelope) {
  return envelope && (envelope.version === undefined || envelope.version === 1) && plain(envelope.lines)
    ? Accounting.preserve(envelope, { lines: envelope.lines }) : undefined;
}
function encodeEnvelope(value) { assertLedgerWritable(value); return Accounting.preserve(value, { lines: value.lines }); }
const withLines = (state, lines) => Accounting.preserve(state, { lines });
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function makeLineSpend(o) {
  o = o || {};
  const now = typeof o.now === 'function' ? o.now : function () { return 0; };
  const dayMs = (typeof o.dayMs === 'number' && o.dayMs > 0) ? o.dayMs : DAY_MS;
  const load = typeof o.load === 'function' ? o.load : function () { return null; };
  const save = typeof o.save === 'function' ? o.save : function () {};
  const read = typeof o.read === 'function' ? o.read : null, write = typeof o.write === 'function' ? o.write : null;
  const envelope = o.envelope === true;
  const ownedValue = raw => envelope ? normalizeLedger(raw) : { lines: clean(raw) };
  let table = null;
  let knownStore = false, pending = null, issue = '';
  let observedAccounting = null;
  const dayOf = t => Math.floor(num(t) / dayMs);
  function canonical(loaded) {
    if (!read || !write) throw new Error('line-spend: owned receipts require canonical persistence');
    loaded = loaded || read();
    if (!loaded || (loaded.status !== 'ok' && loaded.status !== 'absent') || (loaded.status === 'absent' && knownStore)) {
      knownStore = true;
      throw new Error('line-spend: canonical primary is not confirmed');
    }
    if (loaded.status === 'ok') knownStore = true;
    const value = ownedValue(loaded.value);
    assertLedgerWritable(value);
    if (loaded.status === 'ok') observedAccounting = Accounting.observe(observedAccounting, value, 'ledger');
    return { value, status: loaded.status };
  }
  function ensure() {
    if (!table) {
      try {
        if (read && write) {
          const loaded = read();
          if (loaded && (loaded.status === 'ok' || loaded.status === 'recovered')) table = ownedValue(loaded.value);
          if (loaded && loaded.status === 'recovered') {
            // Preserve the existing legacy cap projection from a valid backup.
            // This value is never a canonical write or owned-receipt proof.
            knownStore = true; table = ownedValue(loaded.value);
            issue = 'line-spend: canonical primary is not confirmed';
            failNote('line-spend.load', new Error(issue));
          } else table = canonical(loaded).value;
        } else table = { lines: clean(load()) };
      }
      catch (error) { if (!table) table = { lines: clean(null) }; issue = error.message; failNote('line-spend.load', error); }
    }
    return table;
  }
  function persist() { try { const value = normalizeLedger(table); assertLedgerWritable(value); save(value.lines); } catch (e) { failNote('line-spend.persist', e); } }
  function writeExact(value) {
    assertLedgerWritable(value);
    knownStore = true; // a creation can land before its acknowledgement fails
    write(envelope ? value : value.lines);
    const after = canonical();
    if (after.status !== 'ok' || !same(after.value, value)) throw new Error('line-spend: canonical readback did not confirm this write');
    return after.value;
  }
  function flush() {
    while (pending) {
      const current = canonical().value;
      let confirmed;
      if (same(current, pending.next)) confirmed = current;
      else if (same(current, pending.before)) confirmed = writeExact(pending.next);
      else throw new Error('line-spend: canonical state changed outside the pending receipt; refusing cached overwrite');
      const tail = pending.tail;
      table = confirmed;
      pending = same(tail, confirmed) ? null : { before: confirmed, next: tail, tail };
    }
    issue = '';
  }
  function begin(before, next) {
    assertLedgerWritable(next);
    pending = { before, next, tail: next };
    // Do not resolve a new candidate from an absent file after marking possible
    // creation. The first attempt writes directly; only retries enter flush().
    table = writeExact(next);
    pending = null; issue = '';
  }
  function legacyNext(current, line, day, usd) {
    const next = Object.assign(Object.create(null), current.lines), old = current.lines[line];
    const total = old && old.day === day ? num(old.usd) + usd : usd;
    if (!money(total)) throw new Error('line-spend: observed daily total is outside the supported range');
    next[line] = withReceipts(old) ? Object.assign(Object.create(null), old, { day, usd: total }) : { day, usd: total };
    const result = normalizeLedger(withLines(current, next));
    assertLedgerWritable(result);
    return result;
  }

  // $ this line has spent TODAY (0 when nothing, or the bucket is from an earlier day)
  function spentToday(lineId) {
    if (lineId == null) return 0;
    const r = (pending ? pending.tail : ensure()).lines[String(lineId)];
    return (r && r.day === dayOf(now())) ? num(r.usd) : 0;
  }
  // add reconciled spend to the line's bucket for today (a stale bucket rolls to zero first)
  function note(lineId, usd, observed) {
    if (arguments.length >= 3) return noteReceipt(lineId, usd, observed);
    const u = num(usd);
    if (lineId == null || !u) return spentToday(lineId);
    const k = String(lineId), day = dayOf(now());
    ensure();
    if (!read || !write) {
      try { table = legacyNext(table, k, day, u); persist(); }
      catch (error) { issue = error.message; failNote('line-spend.persist', error); }
      return spentToday(k);
    }
    let appended = false;
    try {
      if (pending) { pending.tail = legacyNext(pending.tail, k, day, u); appended = true; flush(); }
      else { table = canonical().value; const next = legacyNext(table, k, day, u); appended = true; begin(table, next); }
    } catch (error) {
      // A later legacy amount stays in the same pending write's bounded tail.
      // It never changes the exact before/next evidence needed to resolve a lost ACK.
      if (!appended && !pending) {
        try { const next = legacyNext(table, k, day, u); pending = { before: table, next, tail: next }; }
        catch (tailError) { failNote('line-spend.pending', tailError); }
      }
      issue = error.message; failNote('line-spend.persist', error);
    }
    return spentToday(k);
  }
  function observedReceipt(lineId, usd, observed) {
    if (!id(lineId) || !money(usd) || !plain(observed) || Object.keys(observed).length !== 3 || !['jobId', 'runId', 'endedAt'].every(k => owns(observed, k))
      || !jobId(observed.jobId) || !id(observed.runId) || !uint(observed.endedAt)) throw new Error('line-spend: invalid observed run receipt');
    return { jobId: observed.jobId, runId: observed.runId, day: Math.floor(observed.endedAt / dayMs), usd };
  }
  function receiptProof(lineId, usd, observed, ledgerId) {
    const receipt = observedReceipt(lineId, usd, observed);
    if (!envelope || !Accounting.validId(ledgerId) || pending) throw new Error('line-spend: exact receipt proof requires settled canonical enrollment');
    // Read only: never flush/recreate a missing receipt that a saved job already
    // vouched. A retained bucket amount cannot prove this particular payment.
    const loaded = canonical(), enrollment = Accounting.demand(loaded.value, 'ledger');
    if (loaded.status !== 'ok' || !enrollment || enrollment.state !== 'confirmed' || enrollment.ledgerId !== ledgerId) {
      throw new Error('line-spend: exact receipt has no matching canonical primary enrollment');
    }
    for (const line of Object.keys(loaded.value.lines)) for (const prior of (loaded.value.lines[line].receipts || [])) {
      if (prior.runId !== receipt.runId) continue;
      if (line !== lineId || !same(prior, receipt)) throw new Error('line-spend: exact receipt conflicts with its original line, job, run, day or amount');
      return { confirmed: true, receipt: Object.assign({}, prior) };
    }
    return { confirmed: false, status: 'missing', receipt: null };
  }
  function noteReceipt(lineId, usd, observed) {
    const receipt = observedReceipt(lineId, usd, observed);
    let verified = false;
    try {
      if (pending) flush();
      table = canonical().value;
      verified = true; issue = '';
      for (const line of Object.keys(table.lines)) for (const prior of (table.lines[line].receipts || [])) {
        if (prior.runId !== receipt.runId) continue;
        if (line !== lineId || !same(prior, receipt)) throw new Error('line-spend: run receipt conflicts with its original job, line, day or amount');
        return { confirmed: true, replayed: true, receipt: Object.assign({}, prior) };
      }
      const row = table.lines[lineId];
      if (receipt.day > dayOf(now())) throw new Error('line-spend: observed receipt is from a future day');
      if (row && row.day > receipt.day) return { confirmed: false, status: 'obsolete', receipt };
      const next = Object.assign(Object.create(null), table.lines);
      next[lineId] = { day: receipt.day, usd: (row && row.day === receipt.day ? row.usd : 0) + usd, receiptVersion: 1,
        receipts: (row && row.receipts || []).concat(receipt) };
      assertWritable(next);
      begin(table, normalizeLedger(withLines(table, next)));
      return { confirmed: true, replayed: false, receipt: Object.assign({}, receipt) };
    } catch (error) { if (!verified || pending) issue = error.message; throw error; }
  }
  function snapshot() { return clean(ensure().lines); }
  function accountingProof() {
    if (!envelope) throw new Error('line-spend: permanent enrollment requires its existing root envelope');
    if (pending) flush();
    const loaded = canonical();
    if (loaded.status !== 'ok') throw new Error('line-spend: enrollment requires an existing canonical primary ledger');
    table = loaded.value;
    return { enrollment: Accounting.demand(table, 'ledger'), fingerprint: fingerprint(table) };
  }
  function enrollAccounting(ledgerId, expectedFingerprint) {
    if (!Accounting.validId(ledgerId)) throw new Error('line-spend: invalid accounting enrollment');
    const proof = accountingProof();
    if (proof.enrollment) {
      if (proof.enrollment.ledgerId !== ledgerId) throw new Error('line-spend: accounting enrollment belongs to another ledger');
      return { enrollment: proof.enrollment, replayed: true };
    }
    if (proof.fingerprint !== expectedFingerprint) throw new Error('line-spend: ledger changed before enrollment; refusing cached authority');
    const enrollment = { version: 1, ledgerId, state: 'confirmed' };
    begin(table, Accounting.put(table, enrollment));
    return { enrollment: Accounting.demand(table, 'ledger'), replayed: false };
  }
  return { spentToday, note, snapshot, clean, assertWritable, accountingProof, enrollAccounting, receiptProof,
    status: () => ({ confirmed: !pending && !issue, pending: !!pending, issue: issue || null }) };
}

module.exports = { makeLineSpend, DAY_MS, clean, assertWritable, normalizeLedger, assertLedgerWritable, decodeEnvelope, encodeEnvelope,
  MAX_RECEIPT_BYTES, MAX_JOB_RECEIPTS };
