/* node test/growth-stale-save-recovery.test.js — starnet-releases#4 "Blocker 2": a stale rating watermark refused every
   save, forever.

   The sidecar refuses a save whose stationStats.ratingSyncAt trails its rating ledger ({ ok:false, growthStale:true }):
   a stale tab must not replace the durable save and erase acknowledged XP. That check is right and stays. But the
   watermark only advanced on a complete rating sync — at boot or after a new rating — and a failed sync (one refused
   GET /api/growth/ratings) was never retried, while cloudsave.js resent the SAME refused save on every retry. Durable
   saves stopped silently, and the update gate (which needs a confirmed save) refused to install. Locks:
     A. XpStore retries a failed rating catch-up (boot, or the history read after a new rating) with a growing backoff,
        and the retry advances the watermark and persists; a replaced station drops the retry.
     B. cloudsave answers growthStale by asking XpStore to catch up, and retries with the save THAT persists — never
        the refused one, never a rewritten one. The update drain gets the re-synced save confirmed in one pass. A
        catch-up that keeps failing stays a failed save (one request per attempt, no loop, no OK stamp).
     C. the sidecar's protection stays: a trailing save is folded forward from a complete ledger read, refused otherwise. */
'use strict';
const { sidecarFunctionSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

global.Xp = require('../frontend/app/xp.js');
global.U = { bus: A.makeBus() };
global.document = { getElementById: () => null };
global.World = { setXp() {}, pulseLevelUp() {} };
global.StationUI = { notify() {}, setRoster() {} };
global.Chat = { broadcast() {} };
global.SFX = { level() {} };
global.Tutorial = { onLevelUp() {} };
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

(async () => {
  // ================= A. XpStore retries a failed rating catch-up =================
  const realSetTimeout = global.setTimeout, realClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; };
  global.clearTimeout = t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
  const { XpStore } = require('../frontend/app/xpstore.js');
  const warn = console.warn; console.warn = () => {};
  {
    const hero = { id: 'agent', name: 'OVERSEER', createdAt: 1, stats: Xp.fresh() };
    const station = Xp.fresh(); station.ratingSyncAt = 100; station.ratingSyncVersion = 2;
    const rated = { runId: 'r1', ts: 1500, entries: [{ agentId: 'agent', id: 'work:r1', delta: 3, reason: 'work_great' }] };
    const floors = []; let persists = 0, fail = true;
    const boot = await XpStore.init({
      getAgent: () => hero, agents: () => [hero], station, syncRatingsSince: 100, persist: () => { persists++; },
      loadRatings: async since => { floors.push(since); if (fail) throw new Error('rating history HTTP 403'); return { snapshotAt: 2000, ratings: [rated] }; }
    });
    A.ok(boot.failed, 'the boot rating sync failed (a refused GET /api/growth/ratings)');
    A.eq(XpStore.stationStats().ratingSyncAt, 100, 'a failed sync never advances the watermark');
    A.eq(timers.length, 1, 'a failed boot rating sync schedules a retry instead of waiting for the next boot');
    const first = timers[0] && timers[0].ms;
    A.ok(first >= 1000 && first <= 60000, 'the first retry is seconds away, not a hot loop (' + first + 'ms)');
    { const t = timers.shift(); if (t) t.fn(); } await settle();
    A.eq(floors.length, 2, 'the retry reads the ledger again');
    A.eq(timers.length, 1, 'a retry that fails again schedules the next one');
    A.ok(timers[0] && timers[0].ms > first, 'with a longer wait (' + (timers[0] && timers[0].ms) + 'ms > ' + first + 'ms)');
    fail = false; const persistsBefore = persists;
    { const t = timers.shift(); if (t) t.fn(); } await settle();
    A.eq(floors[2], 100, 'the retry resumes from the unadvanced watermark');
    A.eq(XpStore.stationStats().ratingSyncAt, 2000, 'a successful retry advances the watermark to the ledger snapshot');
    A.eq(hero.stats.xp > 0, true, 'and folds the rating it had missed');
    A.ok(persists > persistsBefore, 'and persists, so the next save carries the re-synced stats');
    A.eq(timers.length, 0, 'nothing more is scheduled once the watermark is current');
    // On demand (the save path's growthStale answer): one shared catch-up, no retry once it lands.
    A.eq(typeof XpStore.catchUpRatings, 'function', 'XpStore offers an on-demand rating catch-up');
    if (typeof XpStore.catchUpRatings === 'function') {
      const a = XpStore.catchUpRatings(), b = XpStore.catchUpRatings();
      A.ok(a === b, 'concurrent catch-up requests share one ledger read');
      const r = await a;
      A.ok(r && !r.failed, 'an on-demand catch-up reports success');
    }
  }
  // A new rating whose history read fails leaves the watermark behind the ledger: that gets a retry too.
  {
    const hero = { id: 'agent', name: 'OVERSEER', createdAt: 1, stats: Xp.fresh() };
    const station = Xp.fresh(); station.ratingSyncAt = 3000; station.ratingSyncVersion = 2;
    await XpStore.init({ getAgent: () => hero, agents: () => [hero], station, persist() {} });
    timers.length = 0;
    const r = await XpStore.recordWorkRating({ runId: 'r2', verdict: 'great' }, async (url, opts) => {
      if (opts && opts.method === 'POST') return { ok: true, json: async () => ({ ok: true, rating: { runId: 'r2', ts: 3100, entries: [{ agentId: 'agent', id: 'work:r2', delta: 3, reason: 'work_great' }] } }) };
      return { ok: false, status: 403, json: async () => ({}) };
    });
    A.ok(r.ok, 'the acknowledged rating still counts');
    A.eq(XpStore.stationStats().ratingSyncAt, 3000, 'the watermark stays behind the unread ledger');
    A.eq(timers.length, 1, 'a failed history read after a new rating schedules a catch-up retry');
    // a replaced station drops the old station's retry
    const other = { id: 'agent', name: 'NEW', createdAt: 5, stats: Xp.fresh() };
    await XpStore.init({ getAgent: () => other, agents: () => [other], station: Xp.fresh(), persist() {} });
    A.eq(timers.length, 0, 'replacing the station cancels the old station\'s pending retry');
  }
  console.warn = warn;
  global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout;

  // ================= B. cloudsave recovers through the re-synced save =================
  let ledgerLatest = 500;
  const posts = [];
  const sentMark = i => { const p = posts[i < 0 ? posts.length + i : i]; return p && p.stationStats ? p.stationStats.ratingSyncAt : undefined; };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.fetch = (url, init) => {
    const sent = JSON.parse(init.body); posts.push(sent);
    const mark = Number(sent.stationStats && sent.stationStats.ratingSyncAt) || 0;
    // the sidecar's rule (sidecar/index.js handleSaveWrite), verbatim in effect: a watermark behind the ledger is refused
    const body = ledgerLatest > mark ? { ok: false, stale: true, growthStale: true, latestRatingAt: ledgerLatest } : { ok: true, revision: posts.length, updatedAt: sent.updatedAt };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  const CloudSave = require('../frontend/app/cloudsave.js');
  let stamp = 0;
  const doc = ratingSyncAt => ({ schema: 'starnet.save', version: 3, updatedAt: ++stamp, agent: { id: 'agent', name: 'NOVA', createdAt: 1 }, stationStats: { ratingSyncAt, xp: ratingSyncAt } });
  // XpStore's catch-up: on success it advances the watermark and persists (App.persist -> CloudSave.push), as the real one does.
  let catchUps = 0, catchUpWorks = true;
  global.XpStore = { catchUpRatings: async () => {
    catchUps++;
    if (!catchUpWorks) return { applied: 0, failed: true };
    CloudSave.push(doc(ledgerLatest + 100));
    return { applied: 1, snapshotAt: ledgerLatest + 100 };
  } };

  // B1. the update drain: a growth-stale save is caught up and the re-synced save confirmed in the same drain
  CloudSave.push(doc(100));
  const drained = await CloudSave.flushForUpdate();
  A.eq(drained.ok, true, 'the update drain confirms a save after a growth-stale refusal (was: refused forever)');
  A.eq(catchUps, 1, 'the refusal asked XpStore to catch up on the ledger, once');
  A.eq(posts.length, 2, 'one refused write, then one accepted write');
  A.eq(sentMark(0), 100, 'the refused write carried the stale watermark');
  A.eq(sentMark(1), 600, 'the accepted write is the save the catch-up persisted, with the re-synced stats');
  A.ok(CloudSave.health().lastPushOkAt > 0 && CloudSave.health().consecutiveFailures === 0, 'and the save light recovers on that real acknowledgement');

  // B2. a catch-up that cannot read the ledger stays a truthful failure — one request per attempt, no loop
  ledgerLatest = 900; catchUpWorks = false;
  const okAt = CloudSave.health().lastPushOkAt;
  CloudSave.push(doc(600));
  const blocked = await CloudSave.flushForUpdate();
  A.eq(blocked.ok, false, 'with the ledger unreadable the update stays paused (no unconfirmed install)');
  A.eq(posts.length, 3, 'exactly one write per attempt — the refused save is not resent in a loop');
  A.eq(catchUps, 2, 'exactly one catch-up per refusal');
  A.ok(CloudSave.health().consecutiveFailures >= 1, 'the save light shows the failure');
  A.eq(CloudSave.health().lastPushOkAt, okAt, 'a refused save never stamps the mirror healthy');

  // B3. the ordinary retry path: the next attempt sends the re-synced save, never the refused one
  catchUpWorks = true;
  A.eq(await CloudSave.flush({ force: true }), false, 'the queued stale save is refused once more');
  A.eq(catchUps, 3, 'which asks for a catch-up again');
  await settle();
  A.eq(await CloudSave.flush({ force: true }), true, 'the next attempt lands');
  A.eq(sentMark(-1), 1000, 'with the save the catch-up persisted');
  A.eq(posts.filter(p => p.stationStats.ratingSyncAt < ledgerLatest).every(p => p.stationStats.ratingSyncAt !== 1000), true, 'cloudsave never rewrote a watermark itself');

  // ================= C. the protection stays, stronger (save-latch-kill) =================
  // a save whose watermark trails the ledger is FOLDED forward by the station when its ledger read is complete
  // (sidecar/growth-fold.js: every rating since the watermark applied, so no acknowledged XP is erased), and refused as
  // before when it is not — the watermark never moves past a rating the save does not hold. Behaviour: growth-fold.test.js,
  // roster-cas.http.test.js.
  const save = sidecarFunctionSource('handleSaveWrite');
  // (review 10-27: since its watermark — or from the start for a save from the old per-acknowledgement scheme, the replay the
  // page itself makes before it stamps version 2: growth-fold.js foldSince, growth-fold.test.js)
  A.ok(/GrowthFold\.foldSave\(body, growthRatings\.since\(\{ since: GrowthFold\.foldSince \? GrowthFold\.foldSince\(body, XpEngine\) : ratingSyncAt, through: latestRatingAt, epoch: growthEpoch \}\), XpEngine, latestRatingAt\)/.test(save),
    'the station folds a trailing save from a strict read of the ledger since its watermark (or from the start, for an old-scheme save)');
  A.ok(/if \(!folded\) return json\(200, \{ ok: false, stale: true, growthStale: true, latestRatingAt \}\);/.test(save),
    'and still refuses one whose fold cannot be proven complete');
  A.report('growth-stale-save-recovery');
})().catch(e => { console.error(e); process.exit(1); });
