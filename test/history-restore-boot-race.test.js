'use strict';
/* THE FIRST MESSAGE AFTER A STATION RESTART (soak S2, 2026-10-15 05:27 + 05:36 local).
   After a station restart the first COMMS message in an existing conversation showed "⚠ Conversation history could not
   be restored. Your message is kept; try again…" and no run started. The page's open-time history read
   (GET /api/transcript, 8 s timeout) landed while the freshly booted sidecar was still slow to answer (the soak
   driver's own API calls took 5-11 s in that window, 0.5 s once warm); the read timed out and its promise settled
   `false`. The FIRST send then awaited that already-settled failure and refused without asking the station again —
   only a second send would have retried. A merge agent saw the same: /api/transcript timed out at 8 s at boot and
   answered 200 a moment later.

   This drives the shipped restore/admission seam (chat.js, both shipped trees) with a fake clock and a controllable
   transport and holds the user-visible contract:
     · a send after a failed open-time read asks again and is admitted once the history arrives — never before;
     · a station that answers slower than one read's 8 s window (busy boot) still gets the message sent;
     · the message is in the conversation exactly once, earlier history intact (never lost, never doubled);
     · a station that never answers ends in the honest refusal after a bounded wait, message kept, no hot loop;
     · STOP (the send's abort) or a removed conversation ends the wait at once and asks nothing more;
     · an answer the station gave on purpose (4xx) is final — no retry loop;
     · a server error (5xx) is an answer too, not silence: one fresh ask, then the honest refusal at once.
   The diagnostics (page-local events, no prose) say "loaded" only when a read really answered. */
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const A = require('./_assert');

const SEND_TEXT = 'first message after the restart';
const EARLIER = [
  { role: 'user', content: 'earlier question', sourceRunId: 'r1', ts: 1 },
  { role: 'assistant', content: 'earlier answer', sourceRunId: 'r1', ts: 2 },
];

function harness(root, opts) {
  const o = opts || {};
  const src = fs.readFileSync(root + '/chat.js', 'utf8');
  let now = 1800000000000, seq = 0;
  const timers = [];
  class FakeDate extends Date { static now() { return now; } }
  const requests = [];
  const w = { id: 'ws_a', agentId: 'agent', history: EARLIER.map(r => Object.assign({}, r)) };
  const sessions = new Map([[w.id, w]]);
  const respond = (req, status, turns) => { if (!req.done) { req.done = true; req.resolve({ ok: status >= 200 && status < 300, status, json: async () => ({ stream: w.id, turns }) }); } };
  const context = vm.createContext({
    Date: FakeDate, WeakMap, Map, Promise, AbortController,
    setTimeout: (fn, ms) => { const t = { id: ++seq, at: now + Math.max(0, Number(ms) || 0), fn }; timers.push(t); return t.id; },
    clearTimeout: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    Workstreams: { get: id => sessions.get(id) }, Channels: { isBusy: () => !!o.busy },
    App: { persist() {} },
    fetch: (url, init) => new Promise((resolve, reject) => {
      const req = { url, resolve, reject, at: now, done: false, aborted: false };
      requests.push(req);
      if (init && init.signal) init.signal.addEventListener('abort', () => {
        if (req.done) return;
        req.done = true; req.aborted = true;
        reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
      });
      if (typeof o.server === 'function') o.server(req, { respond: (status, turns) => respond(req, status, turns), now: () => now });
    }),
    renderHistory() {}, replayChannel() {}, syncStatus() {}, maybeEmptyState() {}, pinLoadedHistoryAfterLayout() {},
    log: { innerHTML: '' }, activeWs: w, historyPinSeq: 3, historyPinPending: 0, revealKey: '',
  });
  // the read-back places mid-run notes after merging (comms-flow 10-26): the real placeSteerNotes rides with the real merge
  const merge = A.fnBody(src, 'function mergeCanonicalHistory(local, turns)') + '\n' + A.fnBody(src, 'function placeSteerNotes(rows)');
  const start = src.indexOf('  const historyLoads = new WeakMap();');
  const seam = src.slice(start, src.indexOf('\n  // swap the rendered conversation', start));
  assert.ok(merge.length > 500 && start > 0 && seam.length > 1000 && seam.length < 16000, root + ': bounded production seam');
  vm.runInContext(merge + '\n' + seam + '\nthis.api={loadServerHistory,ensureHistoryReady,continuityDiagnostics};', context);
  const flush = async () => { for (let i = 0; i < 25; i++) await new Promise(r => setImmediate(r)); };
  // Advance the fake clock, firing every timer that falls due (in order) and letting the page's promises settle between.
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      await flush();
      timers.sort((a, b) => (a.at - b.at) || (a.id - b.id));
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift(); now = Math.max(now, t.at); t.fn();
    }
    now = end; await flush();
  }
  // The page's own send path: the user turn lands in the conversation first, then admission waits for the history.
  function send(signal) {
    w.history.push({ role: 'user', content: SEND_TEXT, ts: now });
    const out = { settled: false, ok: null, error: null };
    out.promise = context.api.ensureHistoryReady(w, signal).then(
      v => { out.settled = true; out.ok = v; },
      e => { out.settled = true; out.error = e; });
    return out;
  }
  const events = () => Array.from(context.api.continuityDiagnostics(), e => e.event);
  const serverRows = [...EARLIER, { role: 'assistant', content: 'routine report while you were away', sourceRunId: 'r2', ts: 3 }];
  return { api: context.api, w, sessions, requests, respond, advance, flush, send, events, serverRows, now: () => now };
}

const sends = (w) => w.history.filter(m => m && m.role === 'user' && m.content === SEND_TEXT).length;

async function bootRaceSendsOnce(root) {
  // The station is still booting when the page opens: the open-time read gets no answer inside its 8 s window.
  const h = harness(root, { busy: true });
  const opened = h.api.loadServerHistory(h.w, 3);
  await h.advance(8000);
  assert.equal(await opened, false, root + ': the open-time read timed out (the soak S2 boot race)');
  assert.ok(h.requests[0].aborted, root + ': the open-time read was abandoned at its 8 s window');
  assert.ok(h.events().includes('history-unavailable'), root + ': an unanswered read is recorded as unavailable, never as loaded');
  // The Commander's first message after the restart.
  const s = h.send(new AbortController().signal);
  await h.advance(1000);
  assert.equal(s.error ? s.error.message : undefined, undefined, root + ': the first send does not fail on the open-time read that timed out');
  assert.equal(s.settled, false, root + ': nothing is admitted before the history has arrived');
  assert.equal(h.requests.length, 2, root + ': the send asks the station again (one fresh read)');
  h.respond(h.requests[1], 200, h.serverRows);
  await h.advance(10);
  assert.ok(s.settled && s.ok && !s.error, root + ': the send is admitted once the history arrives');
  assert.deepEqual(Array.from(h.w.history, m => m.content), ['earlier question', 'earlier answer', 'routine report while you were away', SEND_TEXT], root + ': restored history + the message, in order');
  assert.equal(sends(h.w), 1, root + ': the message is in the conversation exactly once');
  const ev = h.events();
  assert.ok(ev.includes('history-loaded') && ev.includes('send-history-ready'), root + ': diagnostics say loaded only after a real answer');
  assert.ok(!ev.includes('send-held-history-unavailable'), root + ': no refusal was recorded');
}

async function slowBootAnswerStillSends(root) {
  // A busy boot answers every read — but only after 12 s, longer than one 8 s read window. The message must still go.
  const h = harness(root, { busy: true, server: (req, io) => { req.answerAt = io.now() + 12000; } });
  const pump = async (ms) => { // the fake station answers each read that is still open once its 12 s have passed
    for (let left = ms; left > 0; left -= 250) { await h.advance(Math.min(250, left)); for (const r of h.requests) if (!r.done && h.now() >= r.answerAt) h.respond(r, 200, h.serverRows); }
  };
  const opened = h.api.loadServerHistory(h.w, 3);
  await pump(8000);
  assert.equal(await opened, false, root + ': the open-time read gave up at 8 s');
  const s = h.send(new AbortController().signal);
  await pump(40000);
  assert.ok(s.settled && s.ok && !s.error, root + ': a station that answers in 12 s still gets the message sent (' + (s.error && s.error.message) + ')');
  assert.equal(sends(h.w), 1, root + ': exactly once');
  assert.ok(h.w.history.some(m => m.content === 'routine report while you were away'), root + ': the server history is merged before admission');
}

async function neverAnswersIsHonest(root) {
  // The station is gone (connection refused on every read): the wait is bounded and ends in the honest refusal.
  const h = harness(root, { busy: true, server: (req) => { req.done = true; req.reject(new TypeError('Failed to fetch')); } });
  assert.equal(await h.api.loadServerHistory(h.w, 3), false);
  const before = JSON.stringify(h.w.history.concat([{ role: 'user', content: SEND_TEXT }]).map(m => [m.role, m.content]));
  const s = h.send(new AbortController().signal);
  await h.advance(120000);
  assert.ok(s.settled && s.error, root + ': the wait ends');
  assert.equal(s.error.code, 'HISTORY_UNAVAILABLE', root + ': with the honest refusal');
  assert.match(s.error.message, /history could not be restored/, root + ': worded as before');
  assert.equal(JSON.stringify(h.w.history.map(m => [m.role, m.content])), before, root + ': the message is kept and nothing is erased');
  assert.ok(h.requests.length >= 3 && h.requests.length <= 30, root + ': it asked a few times, never a hot loop (' + h.requests.length + ' reads)');
  const ev = h.events();
  assert.ok(ev.includes('send-held-history-unavailable') && !ev.includes('history-loaded') && !ev.includes('send-history-ready'), root + ': never claims a restore that did not happen');
}

async function stopEndsTheWait(root) {
  const h = harness(root, { busy: true, server: (req) => { req.done = true; req.reject(new TypeError('Failed to fetch')); } });
  await h.api.loadServerHistory(h.w, 3);
  const ac = new AbortController();
  const s = h.send(ac.signal);
  await h.advance(3000);
  assert.equal(s.settled, false, root + ': still waiting for the station');
  ac.abort();
  await h.flush();
  assert.ok(s.settled && s.error && /changed before sending/.test(s.error.message), root + ': STOP ends the wait at once');
  const asked = h.requests.length;
  await h.advance(120000);
  assert.equal(h.requests.length, asked, root + ': nothing more is asked after STOP');
}

async function removedConversationEndsTheWait(root) {
  const h = harness(root, { busy: true, server: (req) => { req.done = true; req.reject(new TypeError('Failed to fetch')); } });
  await h.api.loadServerHistory(h.w, 3);
  const s = h.send(new AbortController().signal);
  await h.advance(2000);
  h.sessions.delete(h.w.id);
  await h.advance(10000);
  assert.ok(s.settled && s.error && /changed before sending/.test(s.error.message), root + ': a removed conversation ends the wait');
  const asked = h.requests.length;
  await h.advance(120000);
  assert.equal(h.requests.length, asked, root + ': and asks nothing more');
}

async function answeredRefusalIsFinal(root) {
  const h = harness(root, { busy: true, server: (req, io) => io.respond(403, null) });
  assert.equal(await h.api.loadServerHistory(h.w, 3), false);
  const s = h.send(new AbortController().signal);
  await h.advance(60000);
  assert.ok(s.settled && s.error && s.error.code === 'HISTORY_UNAVAILABLE', root + ': a refusal the station answered is final');
  assert.ok(h.requests.length <= 2, root + ': no retry loop on a deliberate refusal (' + h.requests.length + ' reads)');
}

/* A SERVER ERROR IS AN ANSWER (night-sr-fix, 2026-10-15). The station is up and answers every read at once with a
   server error — a degraded station's 503, a broken transcript store's 500. The send above treated that like silence:
   it asked again 12 times over the whole 45 s bound, holding the message at 'connecting…' against identical answers,
   and test/session-reliability.e2e.test.js (transcript answering 503) hung its 30 s CDP evaluate on exactly that wait.
   An answered failure gets ONE fresh ask (the open-time failure may be stale), then the honest refusal at once. */
async function serverErrorRefusesAtOnce(root) {
  const h = harness(root, { busy: true, server: (req, io) => io.respond(503, null) });
  assert.equal(await h.api.loadServerHistory(h.w, 3), false);
  const before = JSON.stringify(h.w.history.concat([{ role: 'user', content: SEND_TEXT }]).map(m => [m.role, m.content]));
  const s = h.send(new AbortController().signal);
  await h.advance(1000);
  assert.ok(s.settled, root + ': a station that answers 503 is refused at once, not after the 45 s unanswered-read bound');
  assert.ok(s.error && s.error.code === 'HISTORY_UNAVAILABLE', root + ': with the honest refusal');
  assert.match(s.error.message, /history could not be restored/, root + ': worded as before');
  assert.equal(h.requests.length, 2, root + ': the send asked the station exactly once more (' + h.requests.length + ' reads)');
  assert.equal(JSON.stringify(h.w.history.map(m => [m.role, m.content])), before, root + ': the message is kept, nothing erased');
  const ev = h.events();
  assert.ok(ev.includes('send-held-history-unavailable') && !ev.includes('history-loaded') && !ev.includes('send-history-ready'), root + ': never claims a restore that did not happen');
  await h.advance(120000);
  assert.equal(h.requests.length, 2, root + ': and asks nothing more after refusing');
}

async function staleServerErrorAsksAgain(root) {
  // The open-time read met a 500; the station has recovered by the time the Commander sends. The settled failure is
  // not the answer to THIS send: it asks again at once and goes, exactly once.
  let failing = true;
  const h = harness(root, { busy: true, server: (req, io) => { if (failing) io.respond(500, null); } });
  assert.equal(await h.api.loadServerHistory(h.w, 3), false);
  failing = false;
  const s = h.send(new AbortController().signal);
  await h.advance(10);
  assert.equal(s.settled, false, root + ': nothing is admitted before the history has arrived');
  assert.equal(h.requests.length, 2, root + ': the send asks the station again at once');
  h.respond(h.requests[1], 200, h.serverRows);
  await h.advance(10);
  assert.ok(s.settled && s.ok && !s.error, root + ': admitted once the recovered station answered (' + (s.error && s.error.message) + ')');
  assert.equal(sends(h.w), 1, root + ': exactly once');
}

(async () => {
  for (const root of ['frontend/app', 'website/app/app']) {
    for (const [name, fn] of [['boot race: the first send asks again and goes once', bootRaceSendsOnce],
      ['slow boot (12 s answers) still sends', slowBootAnswerStillSends],
      ['a station that never answers ends honestly', neverAnswersIsHonest],
      ['STOP ends the wait', stopEndsTheWait],
      ['a removed conversation ends the wait', removedConversationEndsTheWait],
      ['an answered refusal is final', answeredRefusalIsFinal],
      ['a server error is an answer: one fresh ask, then the honest refusal at once', serverErrorRefusesAtOnce],
      ['a stale open-time server error is asked again', staleServerErrorAsksAgain]]) {
      try { await fn(root); A.ok(true, root + ': ' + name); }
      catch (e) { A.ok(false, root + ': ' + name + ' — ' + (e && e.message)); }
    }
  }
  A.report('history-restore-boot-race (first send after a restart waits for history, sends once; both shipped trees)');
})().catch(e => { console.error(e); process.exitCode = 1; });
