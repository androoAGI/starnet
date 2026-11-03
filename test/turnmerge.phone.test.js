'use strict';
const A = require('./_assert.js');
const crypto = require('node:crypto');
const { makeRemoteHost } = require('../sidecar/remote/host.js');
const { make } = require('../sidecar/turn-dual.js');
const { runTurnId } = require('../frontend/app/turnkinds.js');
const secret = 'FAKE-HELD-SECRET';
let now = 100;
const dual = make({ now: () => ++now, hash: s => crypto.createHash('sha256').update(s).digest('hex') });
const rows = [];
for (let i = 1; i <= 20; i++) rows.push({ streamId: 's', rowId: i, role: i % 2 ? 'user' : 'assistant', content: 'row ' + i, turnId: runTurnId('turn-000' + Math.ceil(i / 2)), sourceRunId: 'run-' + Math.ceil(i / 2), directive: i % 2 === 1, kind: 'turn', ts: i });
const desk = { id: 's', agentId: 'agent', title: 'title ' + secret, history: [{ role: 'user', content: secret + ' only on desk', ts: 0 }] };
const host = makeRemoteHost({ now: () => ++now, roster: () => [{ agentId: 'agent' }], deskSessions: () => [desk], liveRuns: () => [],
  transcript: { view: (_name, _stream, options) => options.op === 'streams' ? [{ streamId: 's', turns: rows.length, preview: 'preview ' + secret, lastAt: 100 }] : rows },
  turnDual: dual, turnProjection: (s, r) => dual.project(s, r), redact: s => s.split(secret).join('[redacted-key]') });
(async () => {
  const threads = await host.threads({ limit: 5 });
  A.ok(!JSON.stringify(threads).includes(secret), 'desk title and both preview paths are scrubbed before leaving host');
  const first = await host.thread({ streamId: 's', limit: 4, page: true });
  A.eq(first.turns.map(r => r.rowId), [17, 18, 19, 20], 'newest page keeps row ids');
  A.eq(first.beforeRowId, 17, 'cursor names the actual first row');
  A.ok(first.turns.every(r => r.turnId && r.sourceRunId && r.kind), 'phone rows retain turn, run and kind');
  rows.push({ streamId: 's', rowId: 21, role: 'user', content: 'new turn', turnId: runTurnId('new-turn'), sourceRunId: 'new-run', directive: true });
  const second = await host.thread({ streamId: 's', limit: 4, page: true, beforeRowId: first.beforeRowId, before: first.turns.length });
  A.eq(second.turns.map(r => r.rowId), [13, 14, 15, 16], 'append between requests neither repeats nor skips a row at cursor seam');
  const all = await host.thread({ streamId: 's', limit: 200, page: true });
  A.ok(!JSON.stringify(all).includes(secret), 'desk-only content is scrubbed before relay');
  A.eq(all.beforeRowId, null, 'legacy row at the seam selects offset fallback rather than a later-key cursor');
  const cursorless = await host.thread({ streamId: 's', limit: 4, before: 4, page: true });
  A.eq(cursorless.turns.map(r => r.rowId), [14, 15, 16, 17], 'old client offset paging remains supported');
  const binary = makeRemoteHost({ now: () => ++now, roster: () => [], deskSessions: () => [], liveRuns: () => [],
    transcript: { view: () => rows.map(r => Object.assign({}, r, { content: 'x'.repeat(20000), typed: 'y'.repeat(20000) })) },
    turnDual: dual, turnProjection: (s, r) => dual.project(s, r), redact: s => s });
  const large = await binary.thread({ streamId: 's', limit: 200, page: true });
  A.ok(Buffer.byteLength(JSON.stringify(large)) < 181 * 1024, 'byte budget includes typed labels and metadata as well as content');
  A.report('turnmerge.phone');
})().catch(e => { console.error(e); process.exit(1); });
