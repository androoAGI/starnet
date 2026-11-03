'use strict';
/* Real existing ledger file and domain-store; only filesystem failure boundaries are injected.
   Old control receives its actual legacy load/save callbacks and ignores the third note argument,
   reproducing additive rebooking rather than failing merely because a new method is absent. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module');
const A = require('./_assert.js');
const { makeDomainStore } = require('../sidecar/domain-store.js');
const { digest } = require('./helpers/line-continuation.js');
const ownerPath = require.resolve('../sidecar/routing/line-spend.js');
let M = require(ownerPath);
if (process.env.LINE_SPEND_RECEIPT_CONTROL) {
  const old = new Module(ownerPath, module); old.filename = ownerPath; old.paths = Module._nodeModulePaths(path.dirname(ownerPath));
  old._compile(fs.readFileSync(process.env.LINE_SPEND_RECEIPT_CONTROL, 'utf8'), ownerPath); M = old.exports;
}
const DAY = M.DAY_MS;
const request = { jobId: 'job-receiptfixture1', runId: 'run-entry', endedAt: 10 * DAY + 123 };
function attempt(fn) { try { return { value: fn() }; } catch (error) { return { error }; } }
function allocated(run, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-spend-receipts-')), file = path.join(dir, 'line-spend.json');
  const f = { mode: '', badRead: false, hide: false, landed: 0, now: 10 * DAY + 1000 };
  const proxy = Object.create(fs);
  proxy.readFileSync = (p, ...args) => {
    const target = path.resolve(String(p));
    if ((f.hide && (target === file || target === file + '.bak')) || (f.badRead && target === file)) {
      const e = new Error('fixture ledger read unavailable'); e.code = f.hide ? 'ENOENT' : 'EACCES'; throw e;
    }
    return fs.readFileSync(p, ...args);
  };
  proxy.renameSync = (from, to) => {
    if (path.resolve(String(to)) === file && f.mode === 'before-write') { const e = new Error('fixture ledger write refused'); e.code = 'EIO'; throw e; }
    fs.renameSync(from, to);
    if (path.resolve(String(to)) === file) { f.landed++; if (f.mode === 'land-readback') f.badRead = true; }
  };
  const normalizer = M.makeLineSpend();
  const store = makeDomainStore({ fs: proxy, path, file, version: 1, defaults: () => ({}), normalize: v => normalizer.clean(v),
    encode: v => { if (typeof normalizer.assertWritable === 'function') normalizer.assertWritable(v); return { lines: v }; },
    decode: e => e && e.lines });
  const fresh = () => M.makeLineSpend({ now: () => f.now, load: () => store.load().value, save: v => store.save(v),
    read: () => store.load(), write: v => store.save(v) });
  try {
    if (seed !== undefined) fs.writeFileSync(file, JSON.stringify({ version: 1, lines: seed }, null, 2));
    run({ f, file, fresh, disk: () => JSON.parse(fs.readFileSync(file, 'utf8')).lines });
  } finally {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('line-spend-receipts-')) throw new Error('fixture cleanup escaped temporary parent');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

allocated(({ f, fresh, disk }) => {
  const a = fresh(), b = fresh();
  const first = a.note('line-a', 0.125, request);
  A.ok(first && first.confirmed === true && first.replayed === false, 'owned booking has a canonical receipt');
  const replay = b.note('line-a', 0.125, request);
  A.ok(replay && replay.confirmed === true && replay.replayed === true, 'another caller re-proves the same receipt');
  A.eq(disk()['line-a'].usd, 0.125, 'same receipt cannot charge the day twice');
  A.ok(attempt(() => a.note('line-a', 0.25, request)).error, 'conflicting amount cannot reuse the same run');
  A.ok(attempt(() => a.note('line-b', 0.125, request)).error, 'one run cannot move to another line');
  A.ok(attempt(() => a.note('line-a', 0.125, Object.assign({}, request, { jobId: 'job-otherfixture1' }))).error, 'one run cannot move to another job');
  const zero = a.note('line-a', 0, Object.assign({}, request, { runId: 'run-zero' }));
  A.ok(zero && zero.confirmed && zero.receipt.usd === 0, 'a completed zero-dollar attempt still gets an exact receipt');
  for (const usd of [-1, NaN, Infinity]) A.ok(attempt(() => a.note('line-a', usd, Object.assign({}, request, { runId: 'run-bad' }))).error, 'invalid USD refuses instead of cleaning to zero');
  a.note('line-a', 0.25);
  A.eq(disk()['line-a'].usd, 0.375, 'legacy amount shares the existing total');
  A.eq((disk()['line-a'].receipts || []).length, 2, 'legacy clean/note retains owned dedupe facts');
  f.now += DAY;
  a.note('line-a', 0.5);
  const old = fresh().note('line-a', 0.125, request);
  A.ok(old && old.confirmed && old.replayed, 'retained cross-day receipt survives a restart');
  A.eq(disk()['line-a'].usd, 0.5, 'old confirmed receipt is not charged to today');
  const missing = fresh().note('line-a', 0.1, Object.assign({}, request, { runId: 'run-obsolete' }));
  A.ok(missing && missing.confirmed === false && missing.status === 'obsolete', 'newer bucket is not evidence that an absent old receipt was booked');
  A.eq(disk()['line-a'].usd, 0.5, 'obsolete unconfirmed receipt never changes today');
});

allocated(({ f, fresh, disk, file }) => {
  const ledger = fresh();
  f.mode = 'land-readback';
  A.ok(attempt(() => ledger.note('line-a', 0.125, request)).error, 'landed receipt without readback is not acknowledged');
  A.eq(f.landed, 1, 'fault follows the actual canonical rename');
  A.eq((disk()['line-a'].receipts || []).length, 1, 'the exact receipt really landed');
  const raw = digest(fs.readFileSync(file, 'utf8'));
  A.notThrows(() => ledger.note('line-a', 0.25), 'legacy reply is not gated while the prior receipt is unreadable');
  A.eq(digest(fs.readFileSync(file, 'utf8')), raw, 'legacy note cannot overwrite unresolved receipt authority');
  A.eq(ledger.spentToday('line-a'), 0.375, 'later known legacy amount stays in the bounded pending tail');
  f.mode = ''; f.badRead = false;
  const retry = ledger.note('line-a', 0.125, request);
  A.ok(retry && retry.confirmed && retry.replayed, 'primary evidence resolves lost ACK before same-run retry');
  A.eq(disk()['line-a'].usd, 0.375, 'recovery confirms each owned and later legacy amount once');
  A.eq((disk()['line-a'].receipts || []).length, 1, 'recovery preserves exactly one owned receipt');
  fresh().note('line-a', 0.125, request);
  A.eq(disk()['line-a'].usd, 0.375, 'restart retry cannot add the entry spend again');
});

allocated(({ f, fresh, disk, file }) => {
  const ledger = fresh(); f.mode = 'land-readback';
  attempt(() => ledger.note('line-a', 0.125, request));
  f.mode = ''; f.badRead = false; f.hide = true;
  const raw = digest(fs.readFileSync(file, 'utf8'));
  A.ok(attempt(() => ledger.note('line-a', 0.125, request)).error, 'absence after possible first creation cannot reset receipt authority');
  A.eq(digest(fs.readFileSync(file, 'utf8')), raw, 'hidden canonical file is not overwritten as a new empty ledger');
});

allocated(({ f, fresh, disk, file }) => {
  const ledger = fresh(); f.mode = 'land-readback';
  attempt(() => ledger.note('line-a', 0.125, request));
  f.mode = ''; f.badRead = false;
  const external = disk(); external['line-a'].usd += 2;
  fs.writeFileSync(file, JSON.stringify({ version: 1, lines: external }));
  const raw = digest(fs.readFileSync(file, 'utf8'));
  A.ok(attempt(() => ledger.note('line-a', 0.125, request)).error, 'unrelated primary state cannot authorize a cached overwrite');
  A.eq(digest(fs.readFileSync(file, 'utf8')), raw, 'unrelated canonical receipt state remains exact');
});

allocated(({ f, fresh, disk }) => {
  const ledger = fresh(); f.mode = 'land-readback';
  attempt(() => ledger.note('line-a', 1, request));
  A.notThrows(() => ledger.note('line-a', Number.MAX_SAFE_INTEGER), 'unsupported legacy sum still does not gate the reply');
  f.mode = ''; f.badRead = false;
  const retry = ledger.note('line-a', 1, request);
  A.ok(retry && retry.confirmed && retry.replayed, 'rejected legacy overflow cannot replace the exact pending before/next receipt');
  A.eq([disk()['line-a'].usd, (disk()['line-a'].receipts || []).length], [1, 1], 'pending receipt survives overflow without truncation or invented spend');
});

allocated(({ f, fresh, disk, file }) => {
  const ledger = fresh(); f.mode = 'before-write';
  A.ok(attempt(() => ledger.note('line-a', 0.125, request)).error, 'pre-write failure refuses the owned acknowledgement');
  A.eq(disk(), {}, 'pre-write refusal preserves the existing empty canonical ledger');
  ledger.note('line-a', 0.25);
  f.mode = '';
  const retry = ledger.note('line-a', 0.125, request);
  A.ok(retry && retry.confirmed && retry.replayed, 'exact unchanged canonical before-state permits retry after failed rename');
  A.eq([disk()['line-a'].usd, (disk()['line-a'].receipts || []).length], [0.375, 1], 'failed-before-write recovery retains owned and legacy amounts exactly once');
}, {});

allocated(({ f, fresh, file }) => {
  const ledger = fresh(); ledger.note('line-a', 0.125, request); ledger.note('line-a', 0.25);
  f.badRead = true;
  A.ok(attempt(() => fresh().note('line-a', 0.125, request)).error, 'unreadable primary refuses despite a readable backup');
  f.badRead = false; fs.unlinkSync(file);
  const bak = digest(fs.readFileSync(file + '.bak', 'utf8'));
  A.ok(attempt(() => fresh().note('line-a', 0.125, request)).error, 'recovered backup alone never confirms a receipt');
  A.eq(digest(fs.readFileSync(file + '.bak', 'utf8')), bak, 'refused recovered write preserves backup authority');
});

for (const row of [
  { day: 10, usd: 0.125, receiptVersion: 99, receipts: [{ opaque: 'future authority' }] },
  { day: 10, usd: 0.125, receiptVersion: 1, receipts: [{ jobId: request.jobId, runId: request.runId, day: 10, usd: -1 }] }
]) allocated(({ fresh, file }) => {
  const raw = digest(fs.readFileSync(file, 'utf8'));
  const ledger = fresh();
  A.notThrows(() => ledger.note('line-a', 0.25), 'legacy reply remains best effort beside unsupported receipt data');
  A.eq(digest(fs.readFileSync(file, 'utf8')), raw, 'legacy normalization cannot erase malformed/future raw authority');
  A.ok(attempt(() => ledger.note('line-a', 0.125, request)).error, 'strict continuation remains non-runnable with unsupported authority');
}, { 'line-a': row });

const full = { day: 10, usd: 0, receiptVersion: 1, receipts: Array.from({ length: 1024 }, (_, i) => ({ jobId: request.jobId, runId: 'run-' + i, day: 10, usd: 0 })) };
allocated(({ fresh, file }) => {
  const raw = digest(fs.readFileSync(file, 'utf8'));
  A.ok(attempt(() => fresh().note('line-a', 0, Object.assign({}, request, { runId: 'run-overflow' }))).error, '1025th receipt for a job refuses without truncation');
  A.eq(digest(fs.readFileSync(file, 'utf8')), raw, 'attempt-bound refusal preserves every original receipt');
}, { 'line-a': full });
const large = { day: 10, usd: 0, receiptVersion: 1, receipts: Array.from({ length: 12000 }, (_, i) => ({ jobId: 'job-cap' + String(Math.floor(i / 1000)).padStart(8, '0'), runId: ('run-' + i + '-' + 'x'.repeat(120)).slice(0, 120), day: 10, usd: 0 })) };
A.ok(Buffer.byteLength(JSON.stringify(large)) > 2 * 1024 * 1024, 'capacity fixture actually exceeds the approved per-line byte bound');
allocated(({ fresh, file }) => {
  const raw = digest(fs.readFileSync(file, 'utf8'));
  A.ok(attempt(() => fresh().note('line-a', 0.125, request)).error, 'oversized original receipt authority refuses strict work');
  A.eq(digest(fs.readFileSync(file, 'utf8')), raw, 'oversized original receipt bytes are not rewritten');
}, { 'line-a': large });
A.report('line-spend.receipts');
