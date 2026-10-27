/* test/growth-fold.test.js — a station save that trails the rating ledger is FOLDED forward by the station, never refused,
   when the ledger read is complete (wave-1 save-latch-kill; starnet-releases#4 Blocker 2).

     a. growthratings.since() reads every rating after a watermark, oldest first, and says whether that is provably ALL of
        them: not when the store evicted (ramMax) or the bounded boot read cut (cutBefore) a rating newer than the watermark;
     b. growth-fold.js applies them exactly as the page does (frontend/app/xpstore.js syncRatingHistory: each entry as a
        memory.feedback event to the agent it names and to the station rollup, through the real Xp engine), so the folded
        save holds the same growth the page would; folding twice changes nothing; an agent the save lacks is skipped;
     c. an incomplete read folds nothing (null): the route refuses the save as before. */
'use strict';
const A = require('./_assert.js');
const Xp = require('../frontend/app/xp.js');
const { makeGrowthRatings } = require('../sidecar/growthratings.js');
const { foldSave } = require('../sidecar/growth-fold.js');

const clone = v => JSON.parse(JSON.stringify(v));
let now = 1000;
const disk = [];
const ledger = makeGrowthRatings({ io: { readAll: () => disk.slice(), append: r => disk.push(r) }, clock: { now: () => ++now } });
const rate = (runId, verdict, agents) => ledger.record({ runId, verdict, epoch: 5000, entries: agents.map((a, i) => ({ agentId: a, id: 'work:' + runId + (i ? ':' + a : ''), delta: 3, size: 'small' })) });

// ---- a. the strict read ----
rate('r1', 'great', ['agent']);
const mark = now;   // the save's watermark: r1 is in it
rate('r2', 'ok', ['agent', 'scout']);
rate('r3', 'great', ['scout']);
const read = ledger.since({ since: mark, through: now, epoch: 5000 });
A.eq(read.ratings.map(r => r.runId), ['r2', 'r3'], 'a: every rating after the watermark, oldest first');
A.eq(read.complete, true, 'a: and provably all of them');
A.eq(ledger.since({ since: 0, epoch: 5000 }).ratings.length, 3, 'a: from zero: every rating');
A.eq(ledger.since({ since: mark, epoch: 9999 }).ratings, [], 'a: another station generation has none');
{
  const small = []; let t = 0;
  const window2 = makeGrowthRatings({ ramMax: 2, io: { readAll: () => small.slice(), append: r => small.push(r) }, clock: { now: () => ++t } });
  for (const id of ['x1', 'x2', 'x3']) window2.record({ runId: id, verdict: 'ok', epoch: 1, entries: [{ agentId: 'agent', id: 'work:' + id, delta: 3 }] });
  A.eq(window2.since({ since: 0, epoch: 1 }).complete, false, 'a: a watermark older than a rating evicted from the window is NOT provably complete');
  A.eq(window2.since({ since: 1, epoch: 1 }).complete, true, 'a: a watermark at or past every evicted rating is');
  const cut = Object.assign(small.slice(1), { cutBefore: true });
  const rebooted = makeGrowthRatings({ io: { readAll: () => cut, append: () => {} }, clock: { now: () => 99 } });
  A.eq(rebooted.since({ since: 0, epoch: 1 }).complete, false, 'a: a boot read that cut older lines cannot prove a fold from before them');
  A.eq(rebooted.since({ since: 2, epoch: 1 }).complete, true, 'a: but can from its first kept rating on');
}

// ---- b. the fold matches the page ----
const fresh = () => Xp.fresh();
const save = {
  schema: 'starnet.save', version: 6, updatedAt: 1, agent: { id: 'agent', name: 'NOVA', createdAt: 5000, stats: fresh() },
  agents: [{ id: 'agent', name: 'NOVA', stats: fresh() }, { id: 'scout', name: 'SCOUT', stats: fresh() }],
  stationStats: Object.assign(fresh(), { ratingSyncAt: mark, ratingSyncVersion: 2 }), workstreams: []
};
// r1 is already in the save's stats (its watermark says so): the page applied it before saving
{
  const ev = { name: 'memory.feedback', payload: ledger.since({ since: 0, epoch: 5000 }).ratings[0].entries[0] };
  save.agent.stats = Xp.applyEvent(save.agent.stats, ev).stats; save.agents[0].stats = Xp.applyEvent(save.agents[0].stats, ev).stats;
  save.stationStats = Object.assign(Xp.applyEvent(save.stationStats, ev).stats, { ratingSyncAt: mark, ratingSyncVersion: 2 });
}
const before = clone(save);
const out = foldSave(save, read, Xp, now);
A.ok(out && out.doc, 'b: a complete read folds');
A.eq(JSON.stringify(save), JSON.stringify(before), 'b: the input save is not modified');
A.eq(out.applied, 3, 'b: three entries applied (r2 to the hero and the scout, r3 to the scout)');
// the page's own projection: xpstore onEvent per entry, oldest first, to the agent it names and to the station
const page = clone(before);
for (const r of read.ratings) for (const e of r.entries) {
  const ev = { name: 'memory.feedback', payload: e };
  for (const a of [page.agent].concat(page.agents).filter(a => a.id === e.agentId)) a.stats = Xp.applyEvent(a.stats, ev).stats;
  page.stationStats = Xp.applyEvent(page.stationStats, ev).stats;
}
A.eq(out.doc.agent.stats, page.agent.stats, 'b: the hero\'s growth is exactly what the page would hold');
A.eq(out.doc.agents[1].stats, page.agents[1].stats, 'b: so is the scout\'s');
A.ok(JSON.stringify(out.doc.agent.stats) !== JSON.stringify(before.agent.stats) && out.doc.agents[1].stats.xp > 0, 'b: the acknowledged verdicts are in the save (the scout\'s great earned XP)');
A.eq(out.doc.stationStats.ratingSyncAt, now, 'b: the watermark moves to the ledger\'s newest rating');
A.eq(out.doc.stationStats.xp, Xp.applyEvent(Xp.applyEvent(Xp.applyEvent(before.stationStats, { name: 'memory.feedback', payload: read.ratings[0].entries[0] }).stats, { name: 'memory.feedback', payload: read.ratings[0].entries[1] }).stats, { name: 'memory.feedback', payload: read.ratings[1].entries[0] }).stats.xp, 'b: the station rollup took every entry once');
const again = foldSave(out.doc, ledger.since({ since: mark, through: now, epoch: 5000 }), Xp, now);
A.eq([again.applied, again.doc.agent.stats, again.doc.stationStats.xp], [0, out.doc.agent.stats, out.doc.stationStats.xp], 'b: folding twice changes nothing (Xp receipts)');
const noScout = clone(before); noScout.agents = [noScout.agents[0]];
const partial = foldSave(noScout, read, Xp, now);
A.eq(partial.applied, 1, 'b: an agent the save does not hold is skipped, as the page skips it');

// ---- c. an incomplete read folds nothing ----
A.eq(foldSave(before, { ratings: read.ratings, complete: false }, Xp, now), null, 'c: an incomplete read folds nothing: the save is refused as before');
A.eq(foldSave(before, read, null, now), null, 'c: no engine, no fold');

A.report('growth-fold');
