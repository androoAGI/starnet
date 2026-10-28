'use strict';
/* THE DESK REDACTS ITS COPY BEFORE IT MERGES, LIKE THE PHONE (reliability wave 1, quick win 18, 2026-10-27).
   The desk save holds every turn as typed; the station's transcript store redacts each row as it writes it. The phone
   redacts the desk copy before it merges the two (sidecar/remote/host.js mergedTurns). The desk's own read-back
   (frontend/app/chat.js reconcileServerHistory) merged the RAW copy against the redacted rows, so a turn holding a
   secret never keyed equal: the conversation showed it twice and the desk save kept its raw copy beside the station's
   redacted one (the RC1 seam behind bug ec226657's class of duplicates).

   This drives the SHIPPED restore seam (both shipped trees) against the REAL route (sidecar/transcript-redact.js)
   wired to the REAL redact() the transcript store uses (sidecar/context.js), and holds:
     · a turn the station holds merges as ONE turn, in the station's redacted form; the raw key leaves the copy;
     · a shapeless key the station holds (known-value redaction the page could never guess) merges the same way;
     · a turn the station does not hold yet (this send's own) stays exactly as typed, same object;
     · a station with nothing redacted costs no extra request and changes nothing;
     · no answer from the redaction: the merge runs as before (nothing lost), and the diagnostics say so;
     · a read superseded while the redaction is in flight writes nothing back.
   TYPED FIRST (review of quick win 18, 10-27): a station row keeps the redaction of the day it was written, so it holds
   raw a value that became a held secret only later. Redacting the whole copy with today's held set missed that row: the
   turn showed twice, and once more on every open. The copy now merges as typed first, and only the rows that merge left
   unmatched are asked and keyed redacted. So it also holds:
     · a turn filed before its secret was held stays ONE row over repeated opens (directive, and the paste-and-echo flow);
     · a steered reply that already holds its parts as typed is never re-keyed (keyed redacted, it would lose them and
       the parts would show beside it), while another directive of the same open still merges once, redacted;
     · the newest directive with no answer (the retry target) merges as one row but keeps the Commander's words, and a
       station directive the desk never held never takes another turn's typed words;
     · a long copy asks only for its unmatched rows, newest first and bounded, so the route never refuses the ask;
     · the redaction gets what is left of the read's own window, never a fresh one.
   And the route itself: same order, never a raw text passed off as redacted, bad bodies refused. */
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const A = require('./_assert');
const { redact, setKnownSecretSource } = require('../sidecar/context.js');
const { readBody } = require('../sidecar/http-body.js');
const { json } = require('../sidecar/respond.js');
const { makeTranscriptRedactRoute } = require('../sidecar/transcript-redact.js');

const VENDOR_KEY = 'sk-proj-' + 'Qx7vB2nL9mK4pR8sT1wY6zA3cD5eF0gH';
const SHAPELESS = 'zq7Shapeless0Desk4821Canary';   // a held secret with no vendor shape: only the station knows it
const LATE = 'zq7LateHeld0Desk4821Canary';          // a value that becomes a held secret only AFTER the station filed it
const held = [SHAPELESS];
setKnownSecretSource(() => held);

const handler = makeTranscriptRedactRoute({ redact: (t) => redact(t), readBody, json });
async function callRoute(body, redactFn) {
  const h = redactFn ? makeTranscriptRedactRoute({ redact: redactFn, readBody, json }) : handler;
  const req = Readable.from([Buffer.from(body, 'utf8')]);
  const res = { headersSent: false, status: 0, out: '', writeHead(c) { this.status = c; this.headersSent = true; }, end(s) { this.out = String(s == null ? '' : s); } };
  await h(req, res);
  return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => JSON.parse(res.out) };
}

function harness(root, w, stationTurns, opts) {
  const o = opts || {};
  const src = fs.readFileSync(root + '/chat.js', 'utf8');
  const requests = [];
  const sessions = new Map([[w.id, w]]);
  const context = vm.createContext({
    Date, WeakMap, Map, Set, Promise, AbortController, setTimeout, clearTimeout,
    Workstreams: { get: id => sessions.get(id) }, Channels: { isBusy: () => false },
    App: { persist() {} },
    fetch: (url, init) => {
      const req = { url: String(url), method: (init && init.method) || 'GET', body: init && init.body, signal: init && init.signal };
      requests.push(req);
      if (req.url.indexOf('/api/transcript/redact') === 0) {
        if (o.redact) return o.redact(req);
        return callRoute(req.body);
      }
      const answer = { ok: true, status: 200, json: async () => ({ stream: w.id, turns: stationTurns }) };
      return o.transcriptDelay ? new Promise(resolve => setTimeout(() => resolve(answer), o.transcriptDelay)) : Promise.resolve(answer);
    },
    renderHistory() {}, replayChannel() {}, syncStatus() {}, maybeEmptyState() {}, pinLoadedHistoryAfterLayout() {},
    log: { innerHTML: '' }, activeWs: w, historyPinSeq: 3, historyPinPending: 0, revealKey: '',
  });
  const merge = A.fnBody(src, 'function mergeCanonicalHistory(local, turns)') + '\n' + A.fnBody(src, 'function placeSteerNotes(rows)');
  const start = src.indexOf('  const historyLoads = new WeakMap();');
  const seam = src.slice(start, src.indexOf('\n  // swap the rendered conversation', start));
  assert.ok(merge.length > 500 && start > 0 && seam.length > 1000 && seam.length < 16000, root + ': bounded production seam');
  vm.runInContext(merge + '\n' + seam + '\nthis.api={loadServerHistory,continuityDiagnostics,redactAsk:typeof redactAsk === "function" ? redactAsk : null};', context);
  const events = () => Array.from(context.api.continuityDiagnostics(), e => e.event);
  return { api: context.api, requests, sessions, events };
}

// what the station holds for a turn: its content through the transcript store's own redact (transcriptstore buildEntry)
const stored = (row) => Object.assign({}, row, { content: String(redact(row.content)) });
const raw = (w) => JSON.stringify(w.history);

async function secretTurnMergesOnce(root) {
  const typed = 'use this key ' + VENDOR_KEY + ' and the vault one ' + SHAPELESS + ' for the deploy';
  const w = { id: 'ws_sec', agentId: 'agent', history: [
    { role: 'user', content: typed, sourceRunId: 'r1', ts: 1 },
    { role: 'assistant', content: 'Saved both keys. Deploying with ' + VENDOR_KEY + ' now.', sourceRunId: 'r1', ts: 2 },
  ] };
  const station = w.history.map(stored).concat([{ role: 'assistant', content: 'a routine report while you were away', sourceRunId: 'r2', ts: 3 }]);
  assert.ok(station[0].content.indexOf('[redacted-') >= 0 && station[0].content.indexOf(SHAPELESS) < 0 && station[0].content.indexOf(VENDOR_KEY) < 0, root + ': the station row is redacted (vendor shape AND the held shapeless value)');
  const h = harness(root, w, station);
  assert.equal(await h.api.loadServerHistory(w, 3), true, root + ': the read answered');
  A.eq(w.history.map(m => m.role + ':' + m.content), station.map(m => m.role + ':' + m.content), root + ': each turn the station holds is ONE turn, in its redacted form, in order');
  A.eq(w.history.filter(m => m.role === 'user').length, 1, root + ': the secret-holding directive shows once, not twice');
  A.ok(raw(w).indexOf(VENDOR_KEY) < 0, root + ': the raw vendor key left the desk copy');
  A.ok(raw(w).indexOf(SHAPELESS) < 0, root + ': the raw shapeless key left the desk copy (the page could never have guessed it)');
  A.eq(h.requests.map(r => r.method + ' ' + r.url.split('?')[0]), ['GET /api/transcript', 'POST /api/transcript/redact'], root + ': one read, then one redaction of the copy');
  const asked = JSON.parse(h.requests[1].body).texts;
  A.eq(asked.length, 2, root + ': the redaction is asked once per distinct turn text');
  A.ok(h.events().includes('history-loaded') && !h.events().includes('history-redact-unavailable'), root + ': diagnostics: loaded, redaction answered');
  // the next open reads the saved (now redacted) copy: it stays one turn per row
  assert.equal(await h.api.loadServerHistory(w, 3), true);
  A.eq(w.history.map(m => m.content), station.map(m => m.content), root + ': a second read-back changes nothing');
}

async function ownSendStaysAsTyped(root) {
  const typed = 'the old key was ' + VENDOR_KEY;
  const mine = { role: 'user', content: 'now use ' + VENDOR_KEY + ' again please', ts: 9 };   // this send's own turn: not on the station yet
  const w = { id: 'ws_own', agentId: 'agent', history: [
    { role: 'user', content: typed, sourceRunId: 'r1', ts: 1 },
    { role: 'assistant', content: 'Noted.', sourceRunId: 'r1', ts: 2 },
    mine,
  ] };
  const station = w.history.slice(0, 2).map(stored);
  const h = harness(root, w, station);
  assert.equal(await h.api.loadServerHistory(w, 3), true);
  A.eq(w.history.length, 3, root + ': nothing doubled, nothing lost');
  A.eq(w.history[0].content, station[0].content, root + ': the turn the station holds took its redacted form');
  A.ok(w.history[2] === mine && mine.content.indexOf(VENDOR_KEY) >= 0, root + ': a turn the station does not hold yet stays exactly as typed (same row) — the run that is about to read it gets what the Commander wrote');
}

async function nothingRedactedCostsNothing(root) {
  const rows = [{ role: 'user', content: 'plain question', sourceRunId: 'r1', ts: 1 }, { role: 'assistant', content: 'plain answer', sourceRunId: 'r1', ts: 2 }];
  const w = { id: 'ws_plain', agentId: 'agent', history: rows.slice() };
  const h = harness(root, w, rows.map(r => Object.assign({}, r)));
  assert.equal(await h.api.loadServerHistory(w, 3), true);
  A.eq(h.requests.length, 1, root + ': a station with nothing redacted is asked nothing more');
  A.eq(w.history.map(m => m.content), ['plain question', 'plain answer'], root + ': the conversation is unchanged');
}

async function noAnswerMergesAsBefore(root) {
  const typed = 'key ' + VENDOR_KEY;
  const w = { id: 'ws_down', agentId: 'agent', history: [{ role: 'user', content: typed, sourceRunId: 'r1', ts: 1 }, { role: 'assistant', content: 'ok', sourceRunId: 'r1', ts: 2 }] };
  for (const fail of [() => Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'redaction failed' }) }), () => Promise.reject(new TypeError('Failed to fetch')),
    (req) => Promise.resolve({ ok: true, status: 200, json: async () => ({ texts: JSON.parse(req.body).texts.concat('one too many') }) })]) {
    const copy = { id: w.id, agentId: 'agent', history: w.history.map(r => Object.assign({}, r)) };
    const h = harness(root, copy, w.history.map(stored), { redact: fail });
    assert.equal(await h.api.loadServerHistory(copy, 3), true, root + ': the history still loads');
    A.ok(copy.history.some(m => m.content === typed) && copy.history.some(m => m.content === 'ok'), root + ': nothing of the copy is lost when the redaction cannot answer');
    A.ok(h.events().includes('history-redact-unavailable'), root + ': the diagnostics name the missing redaction');
  }
}

async function supersededReadWritesNothing(root) {
  const typed = 'key ' + VENDOR_KEY;
  const w = { id: 'ws_race', agentId: 'agent', history: [{ role: 'user', content: typed, sourceRunId: 'r1', ts: 1 }] };
  const before = raw(w);
  let release;
  const h = harness(root, w, w.history.map(stored), { redact: (req) => new Promise(resolve => { release = () => resolve(callRoute(req.body)); }) });
  const first = h.api.loadServerHistory(w, 3);
  for (let i = 0; i < 20 && !release; i++) await new Promise(r => setImmediate(r));
  assert.ok(release, root + ': the first read is waiting on its redaction');
  h.sessions.delete(w.id);   // the conversation was removed while the redaction was in flight
  release();
  assert.equal(await first, false, root + ': a read whose conversation went away reports no load');
  A.eq(raw(w), before, root + ': and writes nothing back');
  A.ok(h.events().includes('history-stale-discarded'), root + ': the diagnostics say it was discarded');
}

// a value held only after the station filed some rows: `filed` runs while it is not held, `opened` while it is
async function withLateHeld(filed, opened) {
  const station = filed();
  held.push(LATE);
  try { return await opened(station); } finally { held.splice(held.indexOf(LATE), 1); }
}

async function lateHeldSecretStaysOne(root) {
  const rows = [
    { role: 'user', content: 'use the vault value ' + LATE + ' for staging', sourceRunId: 'r1', ts: 1 },
    { role: 'assistant', content: 'ok', sourceRunId: 'r1', ts: 2 },
    { role: 'user', content: 'and deploy with ' + VENDOR_KEY, sourceRunId: 'r2', ts: 3 },
    { role: 'assistant', content: 'done', sourceRunId: 'r2', ts: 4 },
  ];
  await withLateHeld(() => rows.map(stored), async (station) => {
    A.ok(station[0].content.indexOf(LATE) >= 0 && station[2].content.indexOf('[redacted-key]') >= 0, root + ': the station filed the first directive raw (not held then) and the second redacted');
    A.ok(String(redact(rows[0].content)).indexOf(LATE) < 0, root + ': today the value is held, so today\'s redaction of the copy differs from the station row');
    const w = { id: 'ws_late', agentId: 'agent', history: rows.map(r => Object.assign({}, r)) };
    for (let open = 1; open <= 3; open++) {
      const h = harness(root, w, station);
      assert.equal(await h.api.loadServerHistory(w, 3), true);
      A.eq(w.history.map(m => m.role + ':' + m.content), station.map(m => m.role + ':' + m.content), root + ': open ' + open + ': one row per station turn — the row filed before its secret was held merges as typed, the other redacted, and nothing grows');
    }
  });
  // paste, then the reply echoes it after keys.save: the directive was filed before the value was held, the reply after
  const paste = [
    { role: 'user', content: 'my acme token is ' + LATE + ', please save it', sourceRunId: 'r3', ts: 1 },
    { role: 'assistant', content: 'Saved ' + LATE + ' as ACME.', sourceRunId: 'r3', ts: 2 },
  ];
  await withLateHeld(() => [stored(paste[0])], async (station) => {
    station.push(stored(paste[1]));   // filed after the save: redacted
    const w = { id: 'ws_echo', agentId: 'agent', history: paste.map(r => Object.assign({}, r)) };
    for (let open = 1; open <= 2; open++) {
      const h = harness(root, w, station);
      assert.equal(await h.api.loadServerHistory(w, 3), true);
      A.eq(w.history.map(m => m.role + ':' + m.content), station.map(m => m.role + ':' + m.content), root + ': open ' + open + ': the pasted directive and its echo each show once');
    }
  });
}

async function steeredReplyNeverDoubles(root) {
  const rows = [
    { role: 'user', content: 'go', sourceRunId: 'r9', ts: 1 },
    { role: 'assistant', content: 'Using ' + LATE + ' now.\n[steering] skip the tests\nFinished.', sourceRunId: 'r9', ts: 2 },
    { role: 'user', content: 'and deploy with ' + VENDOR_KEY, sourceRunId: 'r10', ts: 3 },
    { role: 'assistant', content: 'done', sourceRunId: 'r10', ts: 4 },
  ];
  const parts = [rows[0], { role: 'assistant', content: 'Using ' + LATE + ' now.', sourceRunId: 'r9', ts: 2 }, { role: 'assistant', content: 'Finished.', sourceRunId: 'r9', ts: 2 }, rows[2], rows[3]];
  await withLateHeld(() => parts.map(stored), async (station) => {
    const w = { id: 'ws_steer', agentId: 'agent', history: rows.map(r => Object.assign({}, r)) };
    const h = harness(root, w, station);
    assert.equal(await h.api.loadServerHistory(w, 3), true);
    const r9 = w.history.filter(m => m.role === 'assistant' && m.sourceRunId === 'r9');
    A.eq(r9.length, 1, root + ': the steered reply stays ONE row — its parts, filed as typed, are not re-inserted beside it');
    A.ok(/\[steering\] skip the tests/.test(r9[0] && r9[0].content), root + ': and it keeps its steering note');
    A.eq(w.history.filter(m => m.role === 'user').map(m => m.content), ['go', station[3].content], root + ': the other directive still merges once, redacted');
  });
}

async function retryTargetStaysAsTyped(root) {
  const typed = 'save this key ' + VENDOR_KEY + ' as OPENAI';
  const w = { id: 'ws_retry', agentId: 'agent', history: [
    { role: 'user', content: typed, sourceRunId: 'r1', ts: 1 },
    { role: 'system', sys: true, error: true, content: '⚠ StarNet could not reach the AI provider', ts: 2 },
  ] };
  const station = [stored(w.history[0])];
  for (let open = 1; open <= 2; open++) {
    const h = harness(root, w, station);
    assert.equal(await h.api.loadServerHistory(w, 3), true);
    const users = w.history.filter(m => m.role === 'user');
    A.eq(users.length, 1, root + ': open ' + open + ': a failed directive shows once');
    A.eq(users[0] && users[0].content, typed, root + ': open ' + open + ': and keeps the Commander\'s words — retry re-sends what they typed, not [redacted-key]');
    A.ok(w.history.some(m => m.sys && m.error), root + ': the error row stays');
  }
  // an answer follows it: the next open redacts it
  const answered = station.concat([{ role: 'assistant', content: 'Saved OPENAI.', sourceRunId: 'r1', ts: 3 }]);
  const h = harness(root, w, answered);
  assert.equal(await h.api.loadServerHistory(w, 3), true);
  A.eq(w.history.filter(m => m.role === 'user').map(m => m.content), [station[0].content], root + ': once an answer follows, the directive takes its redacted form');
  A.ok(raw(w).indexOf(VENDOR_KEY) < 0, root + ': and the raw key leaves the copy');
  // a directive the desk never held (sent from the phone) that redacts the same way keeps the station's text
  const KEY_B = 'sk-proj-' + 'Zz9yX8wV7uT6sR5qP4oN3mL2kJ1iH0gF';
  const w2 = { id: 'ws_phone', agentId: 'agent', history: [{ role: 'user', content: 'key ' + VENDOR_KEY, sourceRunId: 'r1', ts: 1 }, { role: 'assistant', content: 'ok', sourceRunId: 'r1', ts: 2 }] };
  const station2 = w2.history.map(stored).concat([stored({ role: 'user', content: 'key ' + KEY_B, sourceRunId: 'r2', ts: 3 })]);
  A.eq(station2[2].content, station2[0].content, root + ': (both directives redact to the same text)');
  const h2 = harness(root, w2, station2);
  assert.equal(await h2.api.loadServerHistory(w2, 3), true);
  A.eq(w2.history.map(m => m.content), station2.map(m => m.content), root + ': the phone\'s directive keeps the station\'s text — never another turn\'s typed key');
  A.ok(raw(w2).indexOf(VENDOR_KEY) < 0 && raw(w2).indexOf(KEY_B) < 0, root + ': no raw key in the copy');
}

async function longCopyAsksOnlyLeftovers(root) {
  // a long desk copy (a desk copy is uncapped between sends; each open can add station rows): the station returns its newest 200
  const plain = Array.from({ length: 700 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: (i % 2 ? 'answer ' : 'question ') + i, sourceRunId: 'p' + (i >> 1), ts: i }));
  const secret = [{ role: 'user', content: 'deploy with ' + VENDOR_KEY, sourceRunId: 'rs', ts: 800 }, { role: 'assistant', content: 'deployed', sourceRunId: 'rs', ts: 801 }];
  const w = { id: 'ws_long', agentId: 'agent', history: plain.concat(secret).map(r => Object.assign({}, r)) };
  const station = plain.slice(-198).concat(secret.map(stored));
  const h = harness(root, w, station);
  assert.equal(await h.api.loadServerHistory(w, 3), true);
  const post = h.requests.find(r => r.method === 'POST');
  const asked = post ? JSON.parse(post.body).texts : [];
  A.ok(asked.length > 0 && asked.length <= 400, root + ': the ask is bounded (' + asked.length + ' texts, the route takes 500)');
  A.ok(asked.indexOf(secret[0].content) >= 0 && asked.indexOf('answer 699') < 0, root + ': it carries the unmatched secret directive, never a row the typed merge already matched');
  A.eq(w.history.filter(m => /^deploy with /.test(m.content)).map(m => m.content), [station[198].content], root + ': the directive merges once, redacted');
  A.ok(!h.events().includes('history-redact-unavailable'), root + ': the route answered the ask');
  // a row past the JSON budget is not sent (it merges as typed); the rest still go, newest first
  const ask = h.api.redactAsk;
  A.ok(typeof ask === 'function', root + ': the ask is bounded by redactAsk');
  if (typeof ask === 'function') A.eq(Array.from(ask([{ content: 'a' }, { content: 'x'.repeat(2000001) }, { content: 'b' }, { content: 'a' }])), ['a', 'b'], root + ': distinct texts, newest first, an oversized one left out');
}

async function redactionKeepsTheReadWindow(root) {
  const w = { id: 'ws_slow', agentId: 'agent', history: [{ role: 'user', content: 'key ' + VENDOR_KEY, sourceRunId: 'r1', ts: 1 }, { role: 'assistant', content: 'ok', sourceRunId: 'r1', ts: 2 }] };
  let askedAt = 0, abortedAt = 0;
  const h = harness(root, w, w.history.map(stored), { transcriptDelay: 2000, redact: (req) => {
    askedAt = Date.now();
    return new Promise((_, reject) => req.signal.addEventListener('abort', () => { abortedAt = Date.now(); reject(new Error('aborted')); }));
  } });
  assert.equal(await h.api.loadServerHistory(w, 3, 2500), true, root + ': the history still loads (a send-time read with a 2.5 s window)');
  A.ok(askedAt > 0 && abortedAt > 0, root + ': the redaction was asked, then given up');
  A.ok(abortedAt - askedAt < 1800, root + ': the redaction gets what is left of the read\'s window (1 s floor), not a fresh 2.5 s: ' + (abortedAt - askedAt) + ' ms');
  A.ok(h.events().includes('history-redact-unavailable'), root + ': and the diagnostics say it did not answer');
}

async function routeContract() {
  const texts = ['a ' + VENDOR_KEY, 'plain', 'b ' + SHAPELESS, ''];
  const r = await callRoute(JSON.stringify({ texts }));
  A.eq(r.status, 200, 'route: answers');
  A.eq((await r.json()).texts, texts.map(t => String(redact(t))), 'route: each text through the transcript store\'s own redact, in order');
  A.eq((await callRoute('{"texts":"x"}')).status, 400, 'route: texts must be an array');
  A.eq((await callRoute(JSON.stringify({ texts: ['ok', 7] }))).status, 400, 'route: every text must be a string');
  A.eq((await callRoute(JSON.stringify({ texts: new Array(501).fill('x') }))).status, 400, 'route: at most 500 texts');
  A.eq((await callRoute('not json')).status, 400, 'route: bad json');
  const broken = await callRoute(JSON.stringify({ texts: ['a ' + VENDOR_KEY] }), () => { throw new Error('boom ' + VENDOR_KEY); });
  A.eq(broken.status, 500, 'route: a redact that throws is a 500');
  A.ok(JSON.stringify(await broken.json()).indexOf(VENDOR_KEY) < 0, 'route: never the raw text (or an error quoting it) passed back');
  assert.throws(() => makeTranscriptRedactRoute({ readBody, json }), /required/, 'route: refuses to build without a redact');
}

(async () => {
  await routeContract();
  for (const root of ['frontend/app', 'website/app/app']) {
    await secretTurnMergesOnce(root);
    await ownSendStaysAsTyped(root);
    await nothingRedactedCostsNothing(root);
    await noAnswerMergesAsBefore(root);
    await supersededReadWritesNothing(root);
    await lateHeldSecretStaysOne(root);
    await steeredReplyNeverDoubles(root);
    await retryTargetStaysAsTyped(root);
    await longCopyAsksOnlyLeftovers(root);
    await redactionKeepsTheReadWindow(root);
  }
  A.report('desk-merge-redaction.test');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
