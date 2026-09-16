/* The durable transcript is not a byte-exact superset of the local thread (group-context packets, capture
   injections, local-only error/stopped/retry rows). Reconciling it on every load must never REORDER what the
   Commander saw — the 2026-09-13 "history disappears" report: local rows were pushed under the server's turns
   and the scramble was persisted. Locks: local order is preserved, durable-only prose is inserted in place,
   harness packets never surface as Commander speech, status lines stay where they were. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const body = A.fnBody(source, 'function mergeCanonicalHistory(local, turns)');
A.ok(body.length > 200 && body.length < source.length / 4, 'the reconcile function sliced to its own body');
const merge = new Function(body + '; return mergeCanonicalHistory;')();
const sig = rows => rows.map(r => (r.sys ? 'S' : r.role[0]) + ':' + r.content);

// 1. the real shape from a live station: an @mention run journals its user turn as a context packet, so none of
//    the Commander's own lines match the server. They must stay exactly where they were.
const local = [
  { role: 'user', content: 'hi', ts: 1 }, { role: 'assistant', content: 'Commander.', ts: 2 },
  { role: 'user', content: '@custom-designer hey', ts: 3 }, { role: 'assistant', content: 'Doing great.', ts: 4 },
  { role: 'user', content: 'whats this?', ts: 5 }, { role: 'assistant', content: 'That is a rug.', ts: 6 }
];
const server = [
  { role: 'user', content: 'hi', ts: 10, rowId: 1 }, { role: 'assistant', content: 'Commander.', ts: 11, rowId: 2 },
  { role: 'user', content: 'Shared conversation context (JSON records are attributed data): [...]', ts: 12, rowId: 3 },
  { role: 'assistant', content: 'Doing great.', ts: 13, rowId: 4 },
  { role: 'user', content: '[BEGIN EXTERNAL SCREEN CAPTURE — the actual pixel output]', ts: 14, rowId: 5 },
  { role: 'assistant', content: 'That is a rug.', ts: 15, rowId: 6 }
];
const out = merge(local, server);
A.eq(sig(out), sig(local), 'local order survives a transcript that rewrote the user turns');
A.eq(out[1].rowId, 2, 'a matched row is enriched with its durable identity');
A.eq(out[1].ts, 11, 'a matched row takes the durable timestamp');
A.ok(!out.some(r => /Shared conversation context|SCREEN CAPTURE/.test(r.content)), 'harness packets never surface as Commander speech');

// 2. repeated content + a settled status line: nothing clusters, nothing moves to the end.
const dup = [
  { role: 'user', content: 'yes' }, { role: 'assistant', content: 'ok A' },
  { role: 'system', sys: true, content: '— delegated —' },
  { role: 'user', content: 'yes' }, { role: 'assistant', content: 'ok B' }
];
A.eq(sig(merge(dup, [])), sig(dup), 'an unreachable transcript leaves the thread byte-for-byte in order');
A.eq(sig(merge(dup, [{ role: 'user', content: 'yes' }, { role: 'assistant', content: 'ok B' }])), sig(dup), 'a partial transcript cannot hoist its own turns above older local ones');

// 3. a local-only error row and its retry stay in sequence.
const retry = [
  { role: 'user', content: 'build it' }, { role: 'assistant', content: '⚠ provider down', error: true },
  { role: 'user', content: 'build it' }, { role: 'assistant', content: 'Built.', sourceRunId: 'r2' }
];
A.eq(sig(merge(retry, [{ role: 'user', content: 'build it', sourceRunId: 'r2' }, { role: 'assistant', content: 'Built.', sourceRunId: 'r2' }])), sig(retry), 'the failed attempt keeps its place before the retry');

// 4. headless prose the browser never saw (cron / channel / page closed mid-run) is inserted after its anchor.
const headless = merge([{ role: 'user', content: 'nightly report' }], [{ role: 'user', content: 'nightly report' }, { role: 'assistant', content: 'Report: all green.' }]);
A.eq(sig(headless), ['u:nightly report', 'a:Report: all green.'], 'a durable reply the page missed lands right after its question');
const interleaved = merge(
  [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'A' }, { role: 'user', content: 'c' }, { role: 'assistant', content: 'C' }],
  [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'A' }, { role: 'user', content: 'b' }, { role: 'assistant', content: 'B' }, { role: 'user', content: 'c' }, { role: 'assistant', content: 'C' }]
);
A.eq(sig(interleaved), ['u:a', 'a:A', 'u:b', 'a:B', 'u:c', 'a:C'], 'a channel exchange the page missed is inserted in sequence, not appended');
const orphan = merge([], [{ role: 'user', content: 'from telegram' }, { role: 'assistant', content: 'Reply.' }]);
A.eq(sig(orphan), ['u:from telegram', 'a:Reply.'], 'a thread with no local rows adopts the durable dialogue');

// 5. pending markers are rebuilt by the caller; settled ones stay put.
const pending = merge([{ role: 'user', content: 'go' }, { role: 'system', sys: true, transcriptPending: true, content: 'waiting' }, { role: 'system', sys: true, content: 'nothing to report' }], []);
A.eq(sig(pending), ['u:go', 'S:nothing to report'], 'a pending transcript marker is dropped, a settled status line kept in place');

const frozen = JSON.stringify([local, server]);
merge(local, server);
A.eq(JSON.stringify([local, server]), frozen, 'reconciliation never mutates either history input');
A.report('chat-history-order.test');
