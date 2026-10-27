/* sidecar/growth-fold.js — fold the Commander's acknowledged work verdicts into a station save that trails them, instead of
   refusing the save (wave-1 save-latch-kill; starnet-releases#4 Blocker 2).

   The rating ledger (growthratings.js) is the source of truth for XP; a save's stats are its projection, with the watermark
   stationStats.ratingSyncAt naming the newest rating it holds. POST /api/save used to REFUSE a save whose watermark trailed
   the ledger (growthStale), so a stale tab could not erase acknowledged XP — and so a page whose rating catch-up failed
   (one refused GET, a forbidden token) had EVERY save refused, the station file frozen, and the in-app update blocked.
   Now the station applies the ratings the save lacks itself, the same way the page does (frontend/app/xpstore.js
   syncRatingHistory: each canonical entry as a memory.feedback event, oldest first, to the agent it names and to the
   station rollup, through the same pure Xp engine with its receipts — so a rating already in the save is a no-op), moves
   the watermark, and takes the save.
   STRICT: only on a COMPLETE read of the ledger since the save's watermark (growthRatings.since: nothing the store may
   lack is newer than the watermark). Otherwise the watermark would move past ratings that were never applied — the save
   is then refused as before. Pure: no I/O. */
'use strict';

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/* foldSave(doc, read, Xp, through) -> { doc, applied } | null
     doc     the save envelope (not modified: a copy is returned)
     read    growthRatings.since({ since: watermark, through, epoch }) -> { ratings (oldest first), complete }
     Xp      the pure engine (frontend/app/xp.js)
     through the ledger's newest rating (the watermark the folded save will carry)
   null: the ledger read was not complete (or no engine) — the caller refuses the save as before. */
function foldSave(doc, read, Xp, through) {
  if (!doc || typeof doc !== 'object' || !read || read.complete !== true || !Array.isArray(read.ratings) || !Xp || typeof Xp.applyEvent !== 'function') return null;
  const out = JSON.parse(JSON.stringify(doc));
  // the agents a rating can name: the hero (the save root) and every crew row (the hero's own row too, kept in step)
  const rows = id => [out.agent].concat(Array.isArray(out.agents) ? out.agents : [])
    .filter(a => a && typeof a === 'object' && String(a.id || 'agent') === id);
  let station = out.stationStats && typeof out.stationStats === 'object' ? out.stationStats : Xp.fresh();
  let applied = 0;
  for (const rating of read.ratings) {
    for (const entry of (rating && Array.isArray(rating.entries) ? rating.entries : [])) {
      const id = entry && typeof entry.agentId === 'string' && entry.agentId.trim() ? entry.agentId.trim() : 'agent';
      const targets = rows(id);
      if (!targets.length) continue;   // an agent this save does not hold: the page skips it too (xpstore resolveAgent)
      const ev = { name: 'memory.feedback', payload: entry };
      let fresh = false;
      for (const a of targets) {
        const r = Xp.applyEvent(a.stats && typeof a.stats === 'object' ? a.stats : Xp.fresh(), ev);
        a.stats = r.stats;
        if (!(r.awards && r.awards.duplicate)) fresh = true;
      }
      const rs = Xp.applyEvent(station, ev);
      station = rs.stats;
      if (fresh || !(rs.awards && rs.awards.duplicate)) applied++;
    }
  }
  station.ratingSyncAt = Math.max(num(station.ratingSyncAt), num(through));
  station.ratingSyncVersion = 2;
  out.stationStats = station;
  return { doc: out, applied };
}

module.exports = { foldSave };
