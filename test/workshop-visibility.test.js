/* node test/workshop-visibility.test.js — SESSION DELIVERY + DELIVERY REVEAL for idle-work deliverables.

   Locked behaviors, per Andrew:
     A. (2026-07-15) An automated build never paints its card into a FOREIGN session. Every deliverable
        gets its OWN workstream ('workshop-<runId>' — the shift's durable streamId); the card renders only
        inside that session, pinned via opts.sessionId.
     A'. (2026-07-16) DELIVERY REVEAL: a landed build GREETS the Commander — its own session OPENS with the
        full return card (explanation + files + decide row) on live push, attach, and genuine return; the
        newest build opens when several are pending, the rest land unread. If the Commander is mid-something
        (or App isn't up), the reveal stands down to the unread row + one actionable toast.
     B. The 2026-07-14 honesty laws survive the reshape: a prior session's persisted seen/later ledger is
        ignored (session-scoped), undecided = still owed (re-surfaced every session until decided), an
        explicit 'later' stays quiet for the session, and a duplicate workshop.built never double-delivers.

   Proven over the real store with injected fakes (Workstreams/Chat/StationUI/fetch), plus source-guards
   for the browser-only wiring: chat.js load() calls presentFor, the card is session-pinned, and app.js
   still routes the genuine-return hook to WorkshopStore.presentOnReturn. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

/* ---------- fakes ---------- */
const mem = new Map();
global.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k)
};
// a PRIOR SESSION's persisted ledger (the pre-2026-07-14 bug): both pending runs already "seen", one later'd.
const STALE = JSON.stringify({ v: 1, later: { 'run-A': true }, seen: ['run-A', 'run-B'] });
mem.set('starnet.workshop.v1', STALE);

let pending = [
  { runId: 'run-A', title: 'older build', files: [] },
  { runId: 'run-B', title: 'newer build', files: [] }
];
let decides = [];
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.indexOf('/api/workshop/pending') === 0) return { ok: true, json: async () => ({ pending: pending.slice() }) };
  if (u.indexOf('/api/workshop/decide') === 0) { decides.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ ok: true }) }; }
  return { ok: false, json: async () => null };
};

// a minimal Workstreams fake with the REAL unread semantics (lastActiveAt > lastReadAt, never the active stream)
const streams = new Map();
let activeStreamId = 'ws_general';
const deletedIds = new Set();   // mirrors the real store's tombstones: adopt() refuses a deleted id
global.Workstreams = {
  adopt(opts) {
    if (streams.has(opts.id)) return streams.get(opts.id);
    if (deletedIds.has(opts.id) && opts.revive !== true) return null;
    deletedIds.delete(opts.id);
    const w = Object.assign({ history: [] }, opts);
    streams.set(w.id, w);
    return w;
  },
  get(id) { return streams.get(id) || null; },
  touch(id) { const w = streams.get(id); if (w) { w.lastActiveAt = Date.now(); if (id === activeStreamId) w.lastReadAt = w.lastActiveAt; } return !!w; },
  // mirrors the real store (2026-07-18): re-flag unread WITHOUT moving lastActiveAt — the re-offer polls
  // re-stamping the "last worked" time made every undecided deliverable session read "now" forever.
  markUnread(id) {
    const w = streams.get(id); if (!w) return false;
    if (id === activeStreamId) { w.lastReadAt = Date.now(); return true; }
    if ((w.lastReadAt || 0) >= (w.lastActiveAt || 0)) w.lastReadAt = 0;
    return true;
  },
  unread(w) { w = (w && w.id) ? w : streams.get(w); return !!w && w.id !== activeStreamId && (w.lastActiveAt || 0) > (w.lastReadAt || 0); }
};

let cards = [];
global.Chat = { workshopReturn: (m, o) => { cards.push({ m: m, o: o }); } };
let toasts = [];
global.StationUI = { notify: (msg, kind, cat) => toasts.push({ msg: msg, kind: kind, cat: cat }) };
// the App shim reveal() drives — openWorkstream is the real focus switch (switchWorkstream → Chat.load)
global.App = { openWorkstream: (id) => { activeStreamId = id; const w = streams.get(id); if (w) w.lastReadAt = Date.now(); } };

const { WorkshopStore } = require('../frontend/app/workshopstore.js');

(async () => {
  /* ---------- A1. the attach poll adopts a session per deliverable and REVEALS the newest: its own session
     opens with the full return card; older deliverables land unread; no card in a foreign session ---------- */
  WorkshopStore.init({ enabled: true, agentIds: () => ['agent'] });
  await new Promise(r => setTimeout(r, 2300));   // past ATTACH_DELAY_MS (1800)
  A.ok(streams.has('workshop-run-A') && streams.has('workshop-run-B'), 'every undecided deliverable got its own session (a prior session\'s persisted seen/later ledger is IGNORED)');
  A.eq(activeStreamId, 'workshop-run-B', 'the NEWEST deliverable\'s own session OPENED (delivery reveal, 2026-07-16)');
  A.eq(cards.length, 1, 'the reveal presented exactly ONE return card');
  A.eq(cards[0].m.runId, 'run-B', 'the card is the newest build\'s');
  A.eq(cards[0].o.sessionId, 'workshop-run-B', 'the card is pinned to the deliverable\'s OWN session — never a foreign feed');
  A.ok(Workstreams.unread(streams.get('workshop-run-A')), 'the older delivery session lands UNREAD in the rail');
  A.ok((streams.get('workshop-run-A').history || []).some(m2 => m2 && m2.sys), 'the session opens with an honest sys marker, never fabricated agent speech');

  /* ---------- A2. the card renders ONLY when its session is opened (presentFor), pinned to it ---------- */
  cards = [];
  await WorkshopStore.presentFor('workshop-run-A');
  A.eq(cards.length, 1, 'opening the delivery session presents its return card');
  A.eq(cards[0].m.runId, 'run-A', 'the card carries THAT session\'s deliverable');
  A.eq(cards[0].o.sessionId, 'workshop-run-A', 'the card is PINNED to its own session (chat.js refuses to paint it elsewhere)');
  cards = [];
  await WorkshopStore.presentFor('ws_general');
  A.eq(cards.length, 0, 'a non-delivery session id never presents a card');
  await WorkshopStore.presentFor('workshop-run-GONE');
  A.eq(cards.length, 0, 'a decided/unknown run presents nothing (server truth, fail-open)');

  /* ---------- B1. return-from-away re-surfaces UNDECIDED work: sessions bump unread, the newest REVEALS ---------- */
  const wsA = streams.get('workshop-run-A');
  wsA.lastReadAt = Date.now() + 1;   // simulate: the Commander read it, then went away
  activeStreamId = 'ws_general';     // …and is back on a plain stream
  const builtStampA = wsA.lastActiveAt;   // when the work actually landed — the honest rail stamp
  await new Promise(r => setTimeout(r, 5));
  cards = [];
  await WorkshopStore.presentOnReturn();
  A.eq(cards.length, 1, 'a genuine return reveals the newest undecided deliverable\'s card');
  A.eq(cards[0].o.sessionId, 'workshop-run-B', 'that card lives in its own session, never the stream the Commander left open');
  A.ok(Workstreams.unread(wsA), 'an undecided deliverable\'s session goes unread again on a genuine return — undecided = still owed');
  A.eq(wsA.lastActiveAt, builtStampA, 'the re-offer never re-stamps lastActiveAt — the rail\'s "last worked" time stays the build\'s, not a perpetual "now" (2026-07-18 timestamp-honesty fix)');

  /* ---------- B2. an explicit LATER stays quiet for the session; an explicit OPEN still shows the card ---------- */
  await WorkshopStore.decide('agent', 'run-A', 'later');
  A.ok(decides.some(d => d.runId === 'run-A' && d.decision === 'later'), 'later reached the server');
  wsA.lastReadAt = Date.now() + 1;
  activeStreamId = 'ws_general';
  await new Promise(r => setTimeout(r, 5));
  await WorkshopStore.presentOnReturn();
  A.ok(!Workstreams.unread(wsA), 'a later\'d deliverable is not re-bumped on return (anti-nag)');
  cards = [];
  await WorkshopStore.presentFor('workshop-run-A');
  A.eq(cards.length, 1, 'but deliberately OPENING its session still shows the card — an explicit open is the opposite of nagging');

  /* ---------- B3. the live workshop.built push REVEALS: its own session opens with the card, once per runId ---------- */
  cards = []; toasts = [];
  const builtPayload = { agentId: 'agent', runId: 'run-C', manifest: { title: 'fresh build', files: [] } };
  WorkshopStore.onBuilt(builtPayload);
  A.ok(streams.has('workshop-run-C'), 'a live build adopts its own session immediately');
  A.eq(activeStreamId, 'workshop-run-C', 'the live build OPENS its own session (delivery reveal)');
  A.eq(cards.length, 1, 'and presents the full return card there');
  A.eq(cards[0].o.sessionId, 'workshop-run-C', 'the card is pinned to the build\'s own session');
  A.eq(toasts.length, 0, 'a revealed build needs no toast — the card IS the announcement');
  WorkshopStore.onBuilt(builtPayload);
  A.eq(cards.length, 1, 'a duplicate workshop.built event never double-delivers (seen guard)');

  /* ---------- B3b. the reveal FALLBACK: no App shell → unread session + ONE actionable toast ---------- */
  const savedApp = global.App; delete global.App;
  cards = []; toasts = [];
  WorkshopStore.onBuilt({ agentId: 'agent', runId: 'run-D', manifest: { title: 'quiet build', files: [] } });
  A.ok(streams.has('workshop-run-D'), 'the fallback still adopts the deliverable\'s own session');
  A.ok(Workstreams.unread(streams.get('workshop-run-D')), 'the fallback session lands unread');
  A.eq(cards.length, 0, 'no card without the reveal — it belongs to the session open');
  A.eq(toasts.length, 1, 'the fallback announces ONE toast');
  A.ok(/^Built while you were away: “quiet build”/.test(toasts[0].msg), 'the toast says what happened (a sentence, no ✦ in front — old-UI review 10-26 #3)');
  A.eq(toasts[0].cat, 'cronDigest', 'the toast stays in the Commander-mutable autonomous category (P1-8 mute works)');
  global.App = savedApp;

  /* ---------- B5. DELETED = GONE (2026-07-16): a session the Commander deleted never re-forms,
     never reveals, never toasts — even while its manifest is still pending server-side ---------- */
  pending.push({ runId: 'run-E', title: 'doomed build', files: [] });
  streams.delete('workshop-run-E'); deletedIds.add('workshop-run-E');   // simulate rail delete → tombstone
  activeStreamId = 'ws_general';
  cards = []; toasts = [];
  await WorkshopStore.presentOnReturn();
  A.ok(!streams.has('workshop-run-E'), 'a deleted deliverable session is NOT resurrected by the return poll');
  A.ok(activeStreamId !== 'workshop-run-E', 'and its session is never revealed/focused');
  cards = []; toasts = [];
  WorkshopStore.onBuilt({ agentId: 'agent', runId: 'run-E', manifest: { title: 'doomed build', files: [] } });
  A.ok(!streams.has('workshop-run-E'), 'the live push cannot resurrect a deleted session either');
  A.eq(cards.length, 0, 'no card for a deleted session');
  A.eq(toasts.length, 0, 'no toast for a deleted session');
  // discardIfPending: the delete handler's server-side cleanup — discards ONLY a genuinely-pending run.
  decides = [];
  const dp = await WorkshopStore.discardIfPending('agent', 'run-E');
  A.ok(dp.ok === true, 'discardIfPending succeeds for a pending run');
  A.ok(decides.some(d => d.runId === 'run-E' && d.decision === 'discard'), 'the pending deliverable is DISCARDED server-side (gone forever)');
  decides = [];
  const dp2 = await WorkshopStore.discardIfPending('agent', 'run-NOT-PENDING');
  A.ok(dp2.ok === true && dp2.pending === false, 'a run that is not pending is left alone');
  A.eq(decides.length, 0, 'no spurious discard for an already-decided run');

  /* ---------- B6. TIMESTAMP HONESTY (2026-07-19): a manifest carrying builtAt stamps the session's
     lastActiveAt with the REAL build-landed time — never the adopt/poll moment. (The re-offer non-restamp
     is locked in B1; this locks the FIRST adopt.) ---------- */
  cards = []; toasts = [];
  const BUILT_AT = Date.now() - 8 * 3600 * 1000;   // "built 8 hours ago, while the Commander slept"
  WorkshopStore.onBuilt({ agentId: 'agent', runId: 'run-T', manifest: { title: 'overnight build', files: [], builtAt: BUILT_AT } });
  A.eq(streams.get('workshop-run-T').lastActiveAt, BUILT_AT,
    'the adopted session\'s "last worked" = the manifest\'s builtAt (the real production time, not now)');
  A.ok(Workstreams.unread(streams.get('workshop-run-T')) || activeStreamId === 'workshop-run-T',
    'the builtAt-stamped session still lands unread (or revealed) — honesty never mutes delivery');

  /* ---------- B4. the ledger never persists (the 2026-07-14 root regression) ---------- */
  A.eq(mem.get('starnet.workshop.v1'), STALE, 'no session state was written back to localStorage — the ledger is in-memory only');

  /* ---------- C. source-guards for the browser-only wiring (not node-loadable) ---------- */
  const chatSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
  A.ok(/WorkshopStore\.presentFor/.test(chatSrc), 'chat.js load() routes a freshly opened session through WorkshopStore.presentFor');
  A.ok(/opts\.sessionId/.test(chatSrc) && /inOwnSession/.test(chatSrc), 'chat.js pins the delivery card to its own session (never another stream\'s feed)');
  A.ok(/setAttribute\('data-wsrun'/.test(chatSrc), 'chat.js tags each delivery card with its runId (data-wsrun)');
  A.ok(/\.workshop-return\[data-wsrun=/.test(chatSrc), 'chat.js drops a stale duplicate card before re-presenting (one live card per deliverable)');
  A.ok(!/folder to copy into/.test(chatSrc), 'the folder-picker Keep flow is gone from the card (simplified: message + Implement/Later/Discard)');
  A.ok(/Implement/.test(chatSrc), 'the card offers the one-click Implement decision');

  const appSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
  A.ok(/onReturn:\s*\(\)\s*=>/.test(appSrc), 'app.js wires the genuine-return hook into AutopilotStore');
  A.ok(/WorkshopStore\.presentOnReturn/.test(appSrc), 'app.js routes the return hook to WorkshopStore.presentOnReturn');
  A.ok(/WorkshopStore\.discardIfPending/.test(appSrc), 'app.js deleteWorkstream discards a deleted deliverable session server-side (deleted = gone forever)');

  const apSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/autopilotstore.js'), 'utf8');
  A.ok(/deps\.onReturn/.test(apSrc), 'autopilotstore.js fires deps.onReturn on a genuine return (independent of the local draft log)');

  const originalFetch = global.fetch;
  for (const body of [{}, { ok: false, error: 'not saved' }, null]) {
    global.fetch = async () => ({ ok: true, json: async () => body });
    const decision = await WorkshopStore.decide('agent', 'run-ack', 'keep');
    A.eq(decision.ok, false, 'Keep requires explicit success, never a missing or negative acknowledgement');
  }
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, destPath: '/confirmed/output' }) });
  A.eq((await WorkshopStore.decide('agent', 'run-ack', 'keep')).destPath, '/confirmed/output', 'a confirmed decision retains its proven output path');
  global.fetch = originalFetch;
  A.report('workshop-visibility.test');
})();
