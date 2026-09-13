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
A.report('transcript-history-v2.test');
