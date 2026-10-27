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
setKnownSecretSource(() => [SHAPELESS]);

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
      const req = { url: String(url), method: (init && init.method) || 'GET', body: init && init.body };
      requests.push(req);
      if (req.url.indexOf('/api/transcript/redact') === 0) {
        if (o.redact) return o.redact(req);
        return callRoute(req.body);
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ stream: w.id, turns: stationTurns }) });
    },
    renderHistory() {}, replayChannel() {}, syncStatus() {}, maybeEmptyState() {}, pinLoadedHistoryAfterLayout() {},
    log: { innerHTML: '' }, activeWs: w, historyPinSeq: 3, historyPinPending: 0, revealKey: '',
  });
  const merge = A.fnBody(src, 'function mergeCanonicalHistory(local, turns)') + '\n' + A.fnBody(src, 'function placeSteerNotes(rows)');
  const start = src.indexOf('  const historyLoads = new WeakMap();');
  const seam = src.slice(start, src.indexOf('\n  // swap the rendered conversation', start));
  assert.ok(merge.length > 500 && start > 0 && seam.length > 1000 && seam.length < 16000, root + ': bounded production seam');
  vm.runInContext(merge + '\n' + seam + '\nthis.api={loadServerHistory,continuityDiagnostics};', context);
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
    () => Promise.resolve({ ok: true, status: 200, json: async () => ({ texts: ['short'] }) })]) {
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
  }
  A.report('desk-merge-redaction.test');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
