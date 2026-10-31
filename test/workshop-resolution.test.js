/* test/workshop-resolution.test.js — the deliverable session must ALWAYS tell the truth on open.

   THE BUG THIS LOCKS OUT (2026-07-18): a 'workshop-<runId>' session's stub line promises "open this
   session any time to review and decide", but when the run stopped being pending server-side (decided
   from another surface/origin, files wiped, workspace moved) presentFor() went TOTALLY SILENT — the
   Commander opened the session and saw only the naked stub, which read as a broken/old UI (no card,
   no Open-it, no decisions, no explanation). Truthful telemetry says the session must state what
   actually happened, from server truth (the deliverable lifecycle library), or honestly say the files
   are gone — and must stay SILENT only when the station is unreachable (never assert an unproven
   resolution).

   Proven over the real store with injected fakes (Workstreams/Chat/fetch), same harness style as
   workshop-visibility.test.js. */
'use strict';
const A = require('./_assert.js');

/* ---------- fakes ---------- */
const mem = new Map();
global.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k)
};

let pending = [];            // rows served by /api/workshop/pending
let libraryRows = [];        // rows served by /api/deliverables
let pendingUnreachable = false;   // simulate a dead station for the pending probe
global.fetch = async (url) => {
  const u = String(url);
  if (u.indexOf('/api/workshop/pending') === 0) {
    if (pendingUnreachable) throw new Error('ECONNREFUSED');
    return { ok: true, json: async () => ({ pending: pending.slice() }) };
  }
  if (u.indexOf('/api/deliverables') === 0) return { ok: true, json: async () => ({ ok: true, items: libraryRows.slice() }) };
  return { ok: false, json: async () => null };
};

const streams = new Map();
let activeStreamId = 'ws_general';
global.Workstreams = {
  adopt(opts) { if (streams.has(opts.id)) return streams.get(opts.id); const w = Object.assign({ history: [] }, opts); streams.set(w.id, w); return w; },
  get(id) { return streams.get(id) || null; },
  touch(id) { return streams.has(id); },
  activeId() { return activeStreamId; }
};

let cards = [];
global.Chat = { workshopReturn: (m, o) => { cards.push({ m: m, o: o }); } };
let persists = 0;
global.App = { persist: () => { persists++; }, refreshRail: () => {} };

const { WorkshopStore } = require('../frontend/app/workshopstore.js');

const sysLines = (id) => (streams.get(id).history || []).filter(m => m && m.sys).map(m => String(m.content));
// a resolution line carries its outcome as a field since 10-30 (old-UI review 10-26 #3: the copy lost its ◈ prefix and its
// mid-sentence capitals, so the outcome is no longer read out of the words)
const resolutions = (id) => (streams.get(id).history || []).filter(m => m && m.sys && m.resolution);
const seedSession = (runId, extraHistory) => {
  streams.set('workshop-' + runId, {
    id: 'workshop-' + runId, agentId: 'agent', history: [
      { role: 'system', sys: true, content: '⚒ built while you were away — “x”. open this session any time to review and decide.' }
    ].concat(extraHistory || [])
  });
};

(async () => {
  WorkshopStore.init({ enabled: false, agentIds: () => ['agent'] });   // enabled:false = no attach poll; we drive presentFor directly

  /* ---------- 1. still pending → the full card renders, no resolution marker ---------- */
  seedSession('run-P');
  pending = [{ runId: 'run-P', title: 'still owed', files: [] }];
  await WorkshopStore.presentFor('workshop-run-P');
  A.eq(cards.length, 1, 'a still-pending run presents its return card on open');
  A.eq(cards[0].o.sessionId, 'workshop-run-P', 'the card stays pinned to its own session');
  A.eq(resolutions('workshop-run-P').length, 0, 'no resolution marker while the run is genuinely pending');

  /* ---------- 2. not pending + a KEPT lifecycle row → the honest decided line, exactly once ---------- */
  seedSession('run-K');
  pending = [];
  libraryRows = [{ id: 'workshop:agent:run-K', agentId: 'agent', runId: 'run-K', status: 'kept', title: 'kept build' }];
  cards = [];
  await WorkshopStore.presentFor('workshop-run-K');
  A.eq(cards.length, 0, 'a decided run never re-presents a card');
  A.eq(resolutions('workshop-run-K').map(m => m.resolution), ['kept'], 'the session states the KEPT outcome from server truth');
  A.ok(/^Kept — /.test(resolutions('workshop-run-K')[0].content), 'in a plain sentence: no symbol in front, no capitals mid-sentence');
  A.ok(persists > 0, 'the resolution line is persisted (durable across reloads)');
  await WorkshopStore.presentFor('workshop-run-K');   // reopen
  A.eq(resolutions('workshop-run-K').length, 1, 'reopening never stacks a second resolution line');

  /* ---------- 3. not pending + a DISCARDED row → says discarded ---------- */
  seedSession('run-D');
  libraryRows = [{ id: 'workshop:agent:run-D', agentId: 'agent', runId: 'run-D', status: 'discarded', title: 'gone build' }];
  await WorkshopStore.presentFor('workshop-run-D');
  A.eq(resolutions('workshop-run-D').map(m => m.resolution), ['discarded'], 'a discarded build says so');
  A.ok(/^Discarded — /.test(resolutions('workshop-run-D')[0].content), 'a discarded build says so in words');

  /* ---------- 4. not pending + NO record anywhere → the honest "nothing left to review" line ---------- */
  seedSession('run-G');
  libraryRows = [];
  await WorkshopStore.presentFor('workshop-run-G');
  A.eq(resolutions('workshop-run-G').map(m => m.resolution), ['gone'], 'a vanished build gets the honest no-record line (never silence, never a guess)');
  A.ok(/^Nothing left to review — /.test(resolutions('workshop-run-G')[0].content), 'which says nothing is left to review');

  /* ---------- 5. the session already tells the story (live-card decision marker) → no double-tell ---------- */
  seedSession('run-M', [{ role: 'system', sys: true, content: '✓ implemented — files saved to C:/somewhere' }]);
  await WorkshopStore.presentFor('workshop-run-M');
  A.eq(resolutions('workshop-run-M').length, 0, 'a session that already carries its ✓ decision marker gets no extra resolution line');
  seedSession('run-M2', [{ role: 'system', sys: true, decided: true, content: 'Implemented — files saved to C:/somewhere.' }]);
  await WorkshopStore.presentFor('workshop-run-M2');
  A.eq(resolutions('workshop-run-M2').length, 0, 'nor one that carries a decision line in the new words (the decided field)');

  /* ---------- 6. station unreachable → SILENCE (never assert a resolution the server didn't prove) ---------- */
  seedSession('run-U');
  pendingUnreachable = true;
  await WorkshopStore.presentFor('workshop-run-U');
  A.eq(resolutions('workshop-run-U').length, 0, 'an unreachable station appends NOTHING — fail-open stays honest');
  pendingUnreachable = false;

  /* ---------- 7. unreachable at open (cold-boot race) → RETRIES while the session is on screen, and the
     card appears the moment the station answers. THE BUG THIS LOCKS OUT (2026-07-19, 3rd report): on
     desktop the bundled frontend paints before the sidecar listens; presentFor's one-shot probe failed
     silently and the Commander saw only the naked stub — no card, no buttons, forever. ---------- */
  seedSession('run-R');
  pending = [{ runId: 'run-R', title: 'late but owed', files: [] }];
  pendingUnreachable = true;
  activeStreamId = 'workshop-run-R';   // the Commander is looking at this session
  cards = [];
  WorkshopStore._pfDelays.fast = 20; WorkshopStore._pfDelays.slow = 20;
  await WorkshopStore.presentFor('workshop-run-R');
  A.eq(cards.length, 0, 'no card while the station is down (never a fabricated card)');
  pendingUnreachable = false;          // the sidecar comes up
  await new Promise(r => setTimeout(r, 120));   // let the retry chain fire
  A.eq(cards.length, 1, 'the retry presents the card once the station answers');
  A.eq(cards[0].o.sessionId, 'workshop-run-R', 'the late card is still pinned to its own session');

  /* ---------- 8. unreachable + the Commander switched away → the chain retires (no card into a
     session that is no longer on screen; reopening re-fires presentFor anyway) ---------- */
  seedSession('run-S');
  pending = [{ runId: 'run-S', title: 'switched away', files: [] }];
  pendingUnreachable = true;
  activeStreamId = 'workshop-run-S';
  cards = [];
  await WorkshopStore.presentFor('workshop-run-S');
  activeStreamId = 'ws_general';       // switched away before the station answered
  pendingUnreachable = false;
  await new Promise(r => setTimeout(r, 120));
  A.eq(cards.length, 0, 'a retired chain never paints into a session the Commander left');

  /* ---------- 9. the ATTACH POLL is one-shot no more: station down at boot → maybePresent retries,
     and the deliverable's session is adopted (greet path) the moment the station answers ---------- */
  streams.delete('workshop-run-A'); pending = [{ runId: 'run-A', title: 'boot-race build', files: [] }];
  pendingUnreachable = true;
  activeStreamId = 'ws_general';
  await WorkshopStore._maybePresent();
  A.ok(!streams.has('workshop-run-A'), 'no session adopted while the station is down (never a fabricated row)');
  pendingUnreachable = false;          // sidecar comes up
  await new Promise(r => setTimeout(r, 120));
  A.ok(streams.has('workshop-run-A'), 'the attach-poll retry adopts the deliverable session once the station answers');

  A.report('workshop-resolution');
})().catch(e => { console.error(e); process.exit(1); });
