/* node test/transcript-history-v2.test.js — scaled lifetime-history persistence proof. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./_assert.js');
const { makeSegmentedTranscriptIo } = require('../sidecar/transcript-history.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');

function temp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-' + name + '-')); }
function remove(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function ioAt(base, extra) {
  return makeSegmentedTranscriptIo(Object.assign({
    fs, path, root: path.join(base, 'history'), segmentBytes: 700, recentPerStream: 8,
    legacyFiles: [path.join(base, 'transcript.jsonl.1'), path.join(base, 'transcript.jsonl')]
  }, extra || {}));
}

// A pristine transcript has no JSONL yet. Its manifest must not advertise a phantom active segment that
// readRecent() then misreports as an unreadable/corrupt file during ordinary first boot.
{
  const dir = temp('history-pristine');
  const warnings = [];
  try {
    let io = ioAt(dir, { onWarning: m => warnings.push(m) });
    let store = makeTranscriptStore({ io, clock: { now: () => 1 } });
    A.eq(store.count(), 0, 'pristine transcript starts empty');
    A.eq(io.status().segments.length, 0, 'pristine manifest advertises no segment before the first row exists');
    io = ioAt(dir, { onWarning: m => warnings.push(m) });
    store = makeTranscriptStore({ io, clock: { now: () => 2 } });
    A.eq(store.count(), 0, 'pristine transcript remains empty after restart');
    A.eq(warnings.length, 0, 'pristine startup never reports its not-yet-created active segment as unreadable');
    store.append({ streamId: 'first', role: 'user', content: 'hello' });
    A.ok(fs.existsSync(path.join(dir, 'history', 'segment-000001.jsonl')), 'first durable row creates the active segment');
    A.eq(io.status().segments.length, 1, 'first durable row publishes the now-real segment');
  } finally { remove(dir); }
}

// User-controlled terms and stream ids must never collide with Object.prototype.
{
  const dir = temp('history-prototype-keys');
  const warnings = [];
  try {
    let io = ioAt(dir, { onWarning: m => warnings.push(m) });
    io.appendDurable({ streamId: 'constructor', role: 'user', content: 'constructor __proto__ prototype', ts: 1 });
    io.appendDurable({ streamId: '__proto__', role: 'assistant', content: 'prototype constructor', ts: 2 });
    io = ioAt(dir, { onWarning: m => warnings.push(m) });
    A.eq(io.search('constructor', 'constructor', { scope: 'all' }).length, 2, 'prototype-named term remains searchable after restart');
    A.eq(io.history('__proto__', { limit: 5 }).length, 1, 'prototype-named stream remains readable after restart');
    A.eq(warnings.length, 0, 'prototype-named content never degrades history initialization');
  } finally { remove(dir); }
}

// Unicode words survive indexing/restart, and compatibility spellings normalize deterministically.
{
  const dir = temp('history-unicode');
  try {
    let io = ioAt(dir);
    let store = makeTranscriptStore({ io, clock: { now: () => 8888 } });
    const cyrillic = '\u041f\u0440\u0438\u0432\u0435\u0442 \u043a\u043e\u043c\u0430\u043d\u0434\u0438\u0440';
    const cjk = '\u6771\u4eac\u8a08\u753b';
    store.append({ streamId: 'unicode', role: 'user', content: cyrillic + ' ' + cjk + ' \uff21\uff22\uff23\uff11\uff12\uff13' });
    io = ioAt(dir);
    store = makeTranscriptStore({ io, clock: { now: () => 9999 } });
    A.eq(store.search('unicode', '\u041f\u0440\u0438\u0432\u0435\u0442', { scope: 'all' }).length, 1, 'Cyrillic content is searchable after restart');
    A.eq(store.search('unicode', '\u6771\u4eac', { scope: 'all' }).length, 1, 'CJK content is searchable after restart');
    A.eq(store.search('unicode', 'abc123', { scope: 'all' }).length, 1, 'NFKC normalizes full-width letters and digits deterministically');
  } finally { remove(dir); }
}

// More than 64 tiny segments is a scaled >64 MB lifetime: oldest recall survives restart
// while the RAM mirror remains capped and every closed segment has a durable index.
{
  const dir = temp('history-scale');
  try {
    let io = ioAt(dir);
    let store = makeTranscriptStore({ io, clock: { now: () => 7777 }, ramPerStream: 8 });
    let first;
    for (let i = 0; i < 600; i++) {
      const row = store.append({
        streamId: i % 11 === 0 ? 'quiet' : 'loud', role: i % 2 ? 'assistant' : 'user',
        content: (i === 0 ? 'oldest zircon beacon ' : 'ordinary message ') + i + ' ' + 'x'.repeat(80),
        ts: 1000 + Math.floor(i / 2)
      });
      if (i === 0) first = row;
    }
    const before = io.status();
    A.ok(before.segments.length > 64, 'scaled lifetime rolled through more than 64 immutable numbered segments');
    A.ok(store.count() <= 16, 'RAM mirror remains per-stream bounded while disk retains lifetime history');
    const firstSegment = path.join(dir, 'history', 'segment-000001.jsonl');
    const firstBytes = fs.readFileSync(firstSegment);
    A.ok(fs.existsSync(path.join(dir, 'history', 'segment-000001.index.json')), 'closed first segment has a durable term index');
    for (let i = 600; i < 625; i++) store.append({ streamId: 'loud', role: 'user', content: 'later append ' + i + ' ' + 'y'.repeat(80), ts: 2000 + i });
    A.eq(Buffer.compare(fs.readFileSync(firstSegment), firstBytes), 0, 'closed numbered segment remains byte-immutable after later appends');
    A.ok(io.readById(first.rowId).content.indexOf('oldest zircon') >= 0, 'strict durable append/read-back API retrieves oldest stable row id');

    io = ioAt(dir); // sidecar restart
    store = makeTranscriptStore({ io, clock: { now: () => 9999 }, ramPerStream: 8 });
    const hits = store.search('loud', 'zircon beacon', { scope: 'all', limit: 5 });
    A.eq(hits.length, 1, 'oldest record remains indexed and searchable after restart');
    A.eq(hits[0].rowId, first.rowId, 'search returns the same stable row id after restart');
    const window = io.around(first.streamId, 'tx-' + first.rowId, { window: 2 });
    A.eq(window[0].rowId, first.rowId, 'stable anchor resolves the exact timestamp-colliding row');
    A.ok(io.streams({ limit: 20 }).find(s => s.streamId === 'loud').turns > 500, 'browse count spans every segment, not the RAM tail');
  } finally { remove(dir); }
}

// A crash after persisting a roll pointer but before creating its first row must not reopen the closed tail.
{
  const dir = temp('history-roll-gap');
  try {
    let io = ioAt(dir, { segmentBytes: 300 });
    for (let i = 0; i < 8; i++) io.appendDurable({ streamId: 'g', role: 'user', content: 'gap ' + i + ' ' + 'q'.repeat(100), ts: i + 1 });
    const state = io.status();
    const closed = path.join(dir, 'history', state.segments[0].file);
    const closedBytes = fs.readFileSync(closed);
    const manifestFile = path.join(dir, 'history', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.activeSegment = Math.max.apply(null, manifest.segments.map(s => s.number)) + 1;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest)); // models the durable roll-pointer / no-row crash gap
    io = ioAt(dir, { segmentBytes: 300 });
    io.appendDurable({ streamId: 'g', role: 'assistant', content: 'post restart', ts: 99 });
    A.eq(Buffer.compare(fs.readFileSync(closed), closedBytes), 0, 'restart honors a higher empty active pointer and never reopens a closed segment');
    A.ok(fs.existsSync(path.join(dir, 'history', 'segment-' + String(manifest.activeSegment).padStart(6, '0') + '.jsonl')), 'post-restart append lands in the intended new segment');
  } finally { remove(dir); }
}

// Legacy .1 then live logs migrate chronologically; originals remain untouched and repeat boot is idempotent.
{
  const dir = temp('history-migrate');
  try {
    const oldFile = path.join(dir, 'transcript.jsonl.1');
    const liveFile = path.join(dir, 'transcript.jsonl');
    const oldBytes = JSON.stringify({ streamId: 'm', role: 'user', content: 'legacy oldest cobalt', ts: 1 }) + '\n';
    const liveBytes = JSON.stringify({ streamId: 'm', role: 'assistant', content: 'legacy newest', ts: 2 }) + '\n';
    fs.writeFileSync(oldFile, oldBytes); fs.writeFileSync(liveFile, liveBytes);
    let io = ioAt(dir);
    const migrated = io.history('m', { limit: 10 });
    A.eq(migrated.map(r => r.content), ['legacy oldest cobalt', 'legacy newest'], 'archive migrates before active legacy log');
    A.ok(migrated.every(r => !Object.prototype.hasOwnProperty.call(r, 'legacyKey')), 'internal migration keys never leak through transcript reads');
    A.eq(fs.readFileSync(oldFile, 'utf8'), oldBytes, 'legacy archive is not removed or rewritten');
    A.eq(fs.readFileSync(liveFile, 'utf8'), liveBytes, 'legacy active file is not removed or rewritten');
    io = ioAt(dir);
    A.eq(io.streams({ limit: 10 })[0].turns, 2, 'restart does not duplicate migrated legacy rows');
    A.eq(io.search('m', 'cobalt', { limit: 5 })[0].content, 'legacy oldest cobalt', 'migrated oldest content is indexed');
  } finally { remove(dir); }
}

// A malformed closed segment line and index are isolated; later history remains searchable and writable.
{
  const dir = temp('history-corrupt');
  const warnings = [];
  try {
    let io = ioAt(dir, { onWarning: m => warnings.push(m) });
    for (let i = 0; i < 40; i++) io.appendDurable({ streamId: 'c', role: 'user', content: 'record ' + i + (i === 39 ? ' final-neon' : ''), ts: i + 1 });
    const status = io.status();
    const first = path.join(dir, 'history', status.segments[0].file);
    fs.appendFileSync(first, '{broken-json\n');
    fs.writeFileSync(path.join(dir, 'history', 'segment-000001.index.json'), '{broken-index');
    io = ioAt(dir, { onWarning: m => warnings.push(m) });
    io.search('c', 'record 0', { limit: 5 }); // lazily touches/rebuilds the damaged early index
    A.eq(io.search('c', 'final neon', { limit: 5 }).length, 1, 'corrupt early segment does not hide later searchable history');
    A.ok(warnings.some(m => /corrupt line/.test(m)), 'corrupt segment line is surfaced and isolated');
    const added = io.appendDurable({ streamId: 'c', role: 'assistant', content: 'still writable', ts: 99 });
    A.eq(io.readById(added.rowId).content, 'still writable', 'store remains durably writable after corruption isolation');
  } finally { remove(dir); }
}

// Exact OpenAI assistant/tool pairing remains intact even when a pair straddles segments.
{
  const dir = temp('history-pairing');
  try {
    const io = ioAt(dir, { segmentBytes: 300 });
    let tick = 1;
    const store = makeTranscriptStore({ io, clock: { now: () => tick++ }, ramPerStream: 20 });
    store.append({ streamId: 'p', role: 'user', content: 'read it ' + 'z'.repeat(180) });
    store.append({ streamId: 'p', role: 'assistant', content: '', toolCalls: [{ id: 'tc1', function: { name: 'fs_read', arguments: '{}' } }] });
    store.append({ streamId: 'p', role: 'tool', content: 'contents', toolCallId: 'tc1' });
    store.append({ streamId: 'p', role: 'assistant', content: 'done' });
    const restarted = makeTranscriptStore({ io: ioAt(dir, { segmentBytes: 300 }), clock: { now: () => 9 }, ramPerStream: 20 });
    const rebuilt = restarted.reconstruct('p', { limit: 10 });
    A.eq(rebuilt.map(m => m.role), ['user', 'assistant', 'tool', 'assistant'], 'restart reconstructs the exact cross-segment role sequence');
    A.eq(rebuilt[1].tool_calls[0].id, 'tc1', 'assistant tool call survives segmentation');
    A.eq(rebuilt[2].tool_call_id, 'tc1', 'tool result remains paired to the call');
  } finally { remove(dir); }
}

{
  const dir = temp('history-run-attribution');
  try {
    let s = makeTranscriptStore({ io: ioAt(dir), clock: { now: () => 1 } });
    s.appendStrict({ streamId: 'shared', role: 'user', content: 'request A', sourceRunId: 'A' });
    s.appendStrict({ streamId: 'shared', role: 'assistant', content: 'answer A', sourceRunId: 'A' });
    for (let n = 0; n < 100; n++) s.appendStrict({ streamId: 'shared', role: 'assistant', content: 'answer B ' + n, sourceRunId: 'B' });
    s = makeTranscriptStore({ io: ioAt(dir), clock: { now: () => 2 } });
    A.eq(s.history('shared', { limit: 2, sourceRunId: 'A' }).map(r => r.content), ['request A', 'answer A'], 'run attribution survives segmented restart beyond the recent page');
    A.eq(s.history('shared', { limit: 2 }).map(r => r.sourceRunId), ['B', 'B'], 'session history keeps its default recent conversation behavior');
  } finally { remove(dir); }
}

// Search hits and browse previews retain row-bound provenance through segment rolls and restart.
{
  const dir = temp('history-recall-provenance');
  try {
    let s = makeTranscriptStore({ io: ioAt(dir), clock: { now: () => 1 } });
    const source = s.appendStrict({ streamId: 'external', role: 'user', content: 'external zircon reference', taint: 'web_fetch' });
    s.appendStrict({ streamId: 'clean', role: 'user', content: 'clean orchid reference', taint: null });
    s.appendStrict({ streamId: 'legacy', role: 'user', content: 'legacy cobalt reference' });
    for (let i = 0; i < 20; i++) s.appendStrict({ streamId: 'noise', role: 'assistant', content: 'filler '.repeat(50), taint: null });
    s = makeTranscriptStore({ io: ioAt(dir), clock: { now: () => 2 }, ramMax: 2 });
    A.eq(s.search('clean', 'zircon', { scope: 'all' })[0].taint, 'web_fetch', 'lifetime search preserves old source taint outside RAM after restart');
    A.ok(s.search('clean', 'orchid', { scope: 'all' })[0].taintKnown, 'explicit clean provenance survives restart');
    A.eq(s.search('clean', 'cobalt', { scope: 'all' })[0].taintKnown, false, 'unknown provenance remains unknown after restart');
    A.eq(s.around('external', 'tx-' + source.rowId, { window: 1 })[0].taint, 'web_fetch', 'stable-anchor scroll preserves exact-row taint');
    A.eq(s.streams({ limit: 10 }).find(r => r.streamId === 'external').previewTaint, 'web_fetch', 'persisted preview carries the preview row source');
    A.ok(s.streams({ limit: 10 }).find(r => r.streamId === 'clean').previewTaintKnown, 'clean preview is distinguishable from unknown legacy preview');
  } finally { remove(dir); }
}


// Accepted output remains lossless at the validator's maximum even when JSON escaping exceeds segment target.
{
  const dir = temp('history-full-accepted');
  const hash = text => require('crypto').createHash('sha256').update(text, 'utf8').digest('hex');
  try {
    const content = '{"answer":"' + '\ud800'.repeat(1048576 - 13) + '"}';
    A.eq(content.length, 1048576, 'large accepted text reaches the exact JS-character contract limit');
    A.ok(require('../sidecar/result-contract.js').inspect({ type: 'object' }, content).ok, 'max-size escaped Unicode JSON is accepted by the real validator');
    let store = makeTranscriptStore({ io: ioAt(dir, { segmentBytes: 4 * 1024 * 1024 }), clock: { now: () => 1 } });
    store.appendStrict({ streamId: 'full', sourceRunId: 'original', role: 'assistant', dispatchState: 'final', content, textLength: content.length, textSha256: hash(content), dispatchReason: 'done' });
    A.ok(fs.statSync(path.join(dir, 'history', 'segment-000001.jsonl')).size > 4 * 1024 * 1024, 'escaped durable row exceeds segment roll target without being cut');
    store = makeTranscriptStore({ io: ioAt(dir, { segmentBytes: 4 * 1024 * 1024 }), clock: { now: () => 2 } });
    const restored = store.history('full', { sourceRunId: 'original', dispatchState: 'final', strict: true, limit: 1 })[0];
    A.eq(restored.content.length, content.length, 'restarted segmented history preserves maximum full length');
    A.eq(hash(restored.content), hash(content), 'restarted segmented history preserves maximum full UTF-8 hash');
    A.ok(restored.content === content, 'restarted segmented history preserves exact surrogate code units too');
    // A torn fragment of some OTHER row never names this run, so it was never this run's accepted answer:
    // it must not fail the acceptance lookup (it used to fail every worker finalize until the segment rolled).
    const seg = path.join(dir, 'history', 'segment-000001.jsonl');
    fs.appendFileSync(seg, '{bad line}\n');
    const afterTorn = store.history('full', { sourceRunId: 'original', dispatchState: 'final', strict: true, limit: 1 })[0];
    A.ok(!!afterTorn && hash(afterTorn.content) === hash(content), 'an unrelated torn line no longer fails the strict acceptance lookup');
    // A damaged line that names this run may be its accepted answer: that still fails closed, never falls back to RAM.
    fs.appendFileSync(seg, '{"streamId":"full","sourceRunId":"original","dispatchState":"fin\n');
    A.throws(() => store.history('full', { sourceRunId: 'original', dispatchState: 'final', strict: true }), 'strict acceptance lookup rejects a damaged line naming this run rather than falling back to RAM');
  } finally { remove(dir); }
}

// Conversation previews use indexed visible prompts, never internal repair instructions, without per-thread scans.
{
  const dir = temp('history-conversation-preview');
  try {
    let reads = 0, tick = 1;
    const countedFs = Object.create(fs); countedFs.readFileSync = (...args) => { reads++; return fs.readFileSync(...args); };
    let io = ioAt(dir, { fs: countedFs, segmentBytes: 500 });
    let store = makeTranscriptStore({ io, clock: { now: () => tick++ } });
    store.appendStrict({ streamId: 'chat', role: 'user', content: 'Original visible question', taint: null });
    store.appendStrict({ streamId: 'chat', sourceRunId: 'original', dispatchState: 'pending', role: 'user', content: 'RAW CONTRACT' });
    store.appendStrict({ streamId: 'chat', sourceRunId: 'repair', dispatchState: 'internal', role: 'user', content: 'INTERNAL REPAIR PROMPT' });
    A.eq(store.streams().find(r => r.streamId === 'chat').preview, 'Original visible question', 'pending/internal rows never replace indexed visible preview');
    store.appendStrict({ streamId: 'chat', sourceRunId: 'original', dispatchState: 'final', role: 'assistant', content: 'accepted', dispatchPrompt: 'Accepted work request', dispatchReason: 'done', taint: 'web_fetch' });
    store.appendStrict({ streamId: 'chat', sourceRunId: 'repair', dispatchState: 'internal', role: 'user', content: 'LATE INTERNAL PROMPT' });
    const before = reads;
    A.eq(store.streams().find(r => r.streamId === 'chat').preview, 'Accepted work request', 'accepted projection supplies the original visible work request as preview');
    A.eq(reads, before, 'indexed stream previews require no transcript body reads');
    A.eq(store.streams().find(r => r.streamId === 'chat').previewTaint, 'web_fetch', 'accepted visible preview carries its own source, not earlier clean user metadata');
    store = makeTranscriptStore({ io: ioAt(dir, { segmentBytes: 500 }), clock: { now: () => tick++ } });
    A.eq(store.streams().find(r => r.streamId === 'chat').preview, 'Accepted work request', 'safe preview survives segmented restart');
    A.eq(store.streams().find(r => r.streamId === 'chat').previewTaint, 'web_fetch', 'accepted preview provenance survives restart with its text');
    A.ok(store.history('chat', { sourceRunId: 'repair' }).some(r => r.content === 'INTERNAL REPAIR PROMPT'), 'preview filtering never removes raw execution evidence');
    // Old closed-segment summaries have no visibility provenance; their preview is never trusted. A deferred one-time
    // upgrade rebuilds it from the immutable JSONL (see the next block), so it can never keep the planted text.
    const manifestFile = path.join(dir, 'history', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    for (const segment of manifest.segments) if (segment.number !== manifest.activeSegment && segment.streams.chat) {
      delete segment.streams.chat.previewVersion; segment.streams.chat.preview = 'UNVERIFIED OLD REPAIR PREVIEW';
    }
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const later = [];
    store = makeTranscriptStore({ io: ioAt(dir, { segmentBytes: 500, schedule: fn => later.push(fn) }), clock: { now: () => tick++ } });
    A.ok(!/UNVERIFIED/.test(store.streams().find(r => r.streamId === 'chat').preview), 'unversioned closed preview metadata is not trusted as visible conversation text');
    while (later.length) later.shift()();
    A.ok(!/UNVERIFIED/.test(store.streams().find(r => r.streamId === 'chat').preview), 'the upgrade rebuilds the preview from the JSONL, never the planted text');
  } finally { remove(dir); }
}

// A conversation whose latest activity sits in a closed segment written before preview provenance existed gets its
// preview back: a deferred, one-segment-at-a-time upgrade (never a boot-time scan of every segment).
{
  const dir = temp('history-preview-upgrade');
  const sha = v => require('crypto').createHash('sha256').update(JSON.stringify(v)).digest('hex');
  try {
    let tick = 1;
    let store = makeTranscriptStore({ io: ioAt(dir, { segmentBytes: 500 }), clock: { now: () => tick++ } });
    store.appendStrict({ streamId: 'old-chat', role: 'user', content: 'Plan the garden beds', taint: null });
    store.appendStrict({ streamId: 'old-chat', role: 'assistant', content: 'Raised beds, north side.', taint: null });
    for (let i = 0; i < 12; i++) store.appendStrict({ streamId: 'other', role: 'assistant', content: 'filler '.repeat(20), taint: null });
    // rewrite every closed segment's summary the way the previous release wrote it (no previewVersion)
    const manifestFile = path.join(dir, 'history', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    let downgraded = 0;
    for (const meta of manifest.segments) {
      if (meta.number === manifest.activeSegment) continue;
      const idxPath = path.join(dir, 'history', 'segment-' + String(meta.number).padStart(6, '0') + '.index.json');
      const index = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
      for (const sid of Object.keys(index.streams)) { const s = index.streams[sid]; delete s.previewVersion; delete s.previewTaint; delete s.previewTaintKnown; }
      fs.writeFileSync(idxPath, JSON.stringify(index));
      meta.streams = index.streams; meta.indexHash = sha(index); downgraded++;
    }
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    A.ok(downgraded >= 2, 'several closed segments carry pre-upgrade summaries');
    const later = [];
    let reads = 0;
    const countedFs = Object.create(fs); countedFs.readFileSync = (...args) => { if (/\.jsonl$/.test(String(args[0]))) reads++; return fs.readFileSync(...args); };
    store = makeTranscriptStore({ io: ioAt(dir, { fs: countedFs, segmentBytes: 500, schedule: fn => later.push(fn) }), clock: { now: () => tick++ } });
    A.eq(store.streams({ limit: 10 }).find(r => r.streamId === 'old-chat').preview, '', 'before the upgrade an unversioned preview is not shown');
    A.ok(later.length === 1, 'the upgrade is scheduled, not run during boot');
    const bootReads = reads;
    let steps = 0;
    while (later.length && steps < 100) { later.shift()(); steps++; }
    A.ok(steps >= 2 && reads - bootReads === steps, 'each deferred step reads one closed segment (' + steps + ' steps, ' + (reads - bootReads) + ' reads)');
    A.eq(store.streams({ limit: 10 }).find(r => r.streamId === 'old-chat').preview, 'Plan the garden beds', 'the pre-upgrade conversation lists with its preview again');
    store = makeTranscriptStore({ io: ioAt(dir, { segmentBytes: 500, schedule: fn => later.push(fn) }), clock: { now: () => tick++ } });
    A.eq(store.streams({ limit: 10 }).find(r => r.streamId === 'old-chat').preview, 'Plan the garden beds', 'the upgraded preview survives restart');
    A.eq(later.length, 0, 'an upgraded store schedules nothing on the next boot');
    A.ok(store.search('old-chat', 'garden', { scope: 'all' }).length === 1, 'search still finds the upgraded segment\'s rows');
  } finally { remove(dir); }
}

// A torn line left by a killed sidecar must not block worker finalization, and finalize must not
// re-read every old segment of a long stream ('global') that predates the run.
{
  const dir = temp('history-finalize-torn');
  const hash = text => require('crypto').createHash('sha256').update(text, 'utf8').digest('hex');
  const { makeRunStore } = require('../sidecar/runstore.js');
  const { finalizeDispatchDelivery, recoverPendingDeliveries } = require('../sidecar/dispatch-delivery.js');
  try {
    let now = 1000;
    const clock = { now: () => now };
    const reads = [];
    const countedFs = Object.create(fs);
    countedFs.readFileSync = (file, ...rest) => { reads.push(path.basename(String(file))); return fs.readFileSync(file, ...rest); };
    const io = ioAt(dir, { fs: countedFs, segmentBytes: 700 });
    const transcriptStore = makeTranscriptStore({ io, clock });
    for (let i = 0; i < 12; i++) transcriptStore.appendStrict({ streamId: 'global', role: 'assistant', content: 'old global chatter ' + i + ' ' + 'x'.repeat(80) });
    const oldSegments = io.status().segments.filter(s => s.number !== io.status().activeSegment).map(s => s.file);
    A.ok(oldSegments.length >= 2, 'the old global history spans several closed segments');
    // the sidecar died mid-append in an OLD segment and in the ACTIVE one
    fs.appendFileSync(path.join(dir, 'history', oldSegments[0]), '{"streamId":"global","role":"assi\n');
    now = 1000 + 2 * 24 * 60 * 60 * 1000;
    fs.appendFileSync(path.join(dir, 'history', 'segment-' + String(io.status().activeSegment).padStart(6, '0') + '.jsonl'), '{"streamId":"global","con');
    const runStore = makeRunStore({ io: { readAll: () => [], append() {} }, clock });
    transcriptStore.appendStrict({ streamId: 'global', sourceRunId: 'w1', dispatchState: 'pending', role: 'user', content: 'Summarize the inbox' });
    runStore.record({ runId: 'w1', agentId: 'ada', reason: 'done', startedAt: now, dispatchDelivery: { state: 'pending' } });
    now += 1000;
    reads.length = 0;
    const deps = { runStore, transcriptStore, redact: t => t, hash };
    let row = null;
    A.notThrows(() => { row = finalizeDispatchDelivery(deps, 'w1', { text: 'Three unread invoices.', reason: 'done' }); }, 'a torn line from another row never fails this worker\'s finalization');
    A.eq(row && row.dispatchDelivery && row.dispatchDelivery.state, 'final', 'the worker\'s delivery is final, not left pending');
    A.ok(!oldSegments.some(f => reads.includes(f)), 'finalize never re-reads closed segments that end before the run started (read: ' + reads.join(',') + ')');
    A.eq(transcriptStore.history('global', { sourceRunId: 'w1', dispatchState: 'final' }).length, 1, 'exactly one accepted final row is written');
    A.notThrows(() => finalizeDispatchDelivery(deps, 'w1', { text: 'Three unread invoices.', reason: 'done' }), 'a repeated finalize stays idempotent past the torn lines');
    A.eq(recoverPendingDeliveries(Object.assign({ onFailure: e => { throw e; } }, deps)), 0, 'no pending delivery is left to recover');
  } finally { remove(dir); }
}
// eachRow (forget-wiring namedElsewhere): every durable row once, across segments and a restart. A claim the walk cannot rule out comes
// back doubted (the caller keeps that file) instead of failing the walk: one a damaged line names (a torn or garbled row may be a live one),
// or every claim when a listed segment is gone for good. A closed segment never changes, so a refusal would come back at every pass. A
// segment that cannot be read at the moment fails the walk (the pass is retried), and a visitor's own error is its own.
{
  const dir = temp('history-eachrow');
  try {
    let io = ioAt(dir);
    let store = makeTranscriptStore({ io, clock: { now: () => 1 } });
    for (let i = 0; i < 30; i++) store.append({ streamId: 's' + (i % 3), role: 'user', content: 'row ' + i + ' ' + 'x'.repeat(40) });
    A.ok(io.status().segments.length > 2, 'the rows span several segments');
    io = ioAt(dir);
    store = makeTranscriptStore({ io, clock: { now: () => 2 } });
    const seen = [];
    A.eq(store.eachRow(r => seen.push(r.content), { claims: ['.attachments/x.txt'] }), { doubted: [], unread: [] }, 'a whole, healthy history doubts nothing');
    A.eq(seen.length, 30, 'eachRow visits every durable row after a restart, far past the per-stream RAM mirror');
    A.eq(seen[0].slice(0, 6), 'row 0 ', 'oldest segment first');
    let own = null;
    try { store.eachRow(() => { throw new Error('a visitor bug'); }); } catch (e) { own = e; }
    A.eq([own && own.message, own && own.code], ['a visitor bug', undefined], 'a visitor that throws propagates its own error, never an unvouched history');
    const segPath = n => path.join(dir, 'history', 'segment-' + String(n).padStart(6, '0') + '.jsonl');
    fs.appendFileSync(segPath(io.status().activeSegment), '{"streamId":"s1","attachments":[{"path":".attachments/a b.txt"\n');
    io = ioAt(dir);
    store = makeTranscriptStore({ io, clock: { now: () => 3 } });
    let count = 0;
    const torn = store.eachRow(() => { count++; }, { claims: ['.attachments/a b.txt', '.attachments/other.txt'] });
    A.eq(torn, { doubted: ['.attachments/a b.txt'], unread: [] }, 'a damaged line doubts the claim it names, and only that one');
    A.eq(count, 30, 'and every good row is still visited');
    // a closed segment that cannot be read at the moment (locked, busy) fails the walk: the pass is retried, never settled on a guess
    const closed = io.status().segments.map(s => s.number).filter(n => n !== io.status().activeSegment);
    let busy = false;
    const busyFs = Object.assign({}, fs, { readFileSync: (p, ...rest) => {
      if (busy && closed.some(n => path.resolve(String(p)) === path.resolve(segPath(n)))) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return fs.readFileSync(p, ...rest);
    } });
    io = ioAt(dir, { fs: busyFs });
    store = makeTranscriptStore({ io, clock: { now: () => 4 } });
    busy = true;
    let locked = null;
    try { store.eachRow(() => {}, { claims: ['.attachments/x.txt'] }); } catch (e) { locked = e; }
    A.eq(locked && locked.code, 'TRANSCRIPT_UNVOUCHED', 'a segment that cannot be read at the moment fails the walk (' + (locked && locked.message) + ')');
    busy = false;
    // a closed segment gone for good: every claim is doubted, the segments still there are still walked, and the walk returns
    fs.rmSync(segPath(closed[0]));
    io = ioAt(dir);
    store = makeTranscriptStore({ io, clock: { now: () => 5 } });
    count = 0;
    const gone = store.eachRow(() => { count++; }, { claims: ['.attachments/x.txt', '.attachments/y.txt'] });
    A.eq(gone, { doubted: ['.attachments/x.txt', '.attachments/y.txt'], unread: [closed[0]] }, 'a missing segment doubts every claim and names itself');
    A.ok(count > 0 && count < 30, 'the segments still there are still walked (' + count + ' rows)');
  } finally { remove(dir); }
}
A.report('transcript-history-v2.test');
