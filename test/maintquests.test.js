/* node test/maintquests.test.js — the PURE maintenance-quest generator (frontend/app/maintquests.js).
   Locks the G1c contract: one entry per cause — repeats NEVER duplicate; threshold-gated at the store (the
   engine trusts the caller's tally, but tally() itself is tested); completion is the signal clearing (refresh
   flips done only when the injected active() predicate says the cause stopped recurring); dismissal = STOP
   FOREVER (survives hydrate, blocks re-record); a cleared cause that bites again RE-OPENS (a maintenance issue
   can recur); the projection rides the shared Quests shape (kind 'maintenance', open-before-done); no quest
   rewards a fake currency; deterministic (injected clock). */
'use strict';
const A = require('./_assert.js');
const MQ = require('../frontend/app/maintquests.js');

/* ---------- defensive ---------- */
A.eq(MQ.project(null), [], 'project(null) → [] — never throws');
A.eq(MQ.openCount(null), 0, 'openCount(null) → 0');
A.eq(MQ.record(null, { cause: 'slag:error' }, 1), null, 'record on a null state is refused');
A.eq(MQ.refresh(null, () => false, 1), [], 'refresh on a null state closes nothing');
A.eq(MQ.dismiss(null, 'x', 1), false, 'dismiss on a null state is refused');
A.eq(MQ.record({ quests: {} }, null, 1), null, 'record with no diagnosis is refused');

/* ---------- tally: group a SlagLog ring by cause (reason) ---------- */
const ring = [
  { reason: 'max_iters', title: 'looped without finishing', fix: 'Tighten the ask.' },
  { reason: 'budget', title: 'hit the budget cap', fix: 'Raise the budget.' },
  { reason: 'max_iters', title: 'looped without finishing', fix: 'Split the task.' }
];
const t = MQ.tally(ring);
A.eq(t.max_iters.count, 2, 'tally groups by reason — max_iters bit twice');
A.eq(t.budget.count, 1, 'budget bit once');
A.eq(t.max_iters.fix, 'Split the task.', 'the FRESHEST diagnosis wording wins (ring is oldest→newest)');
A.eq(MQ.tally(null), {}, 'tally(null) → {}');

/* ---------- record: mint + dedup ---------- */
const s = MQ.fresh();
const id = MQ.record(s, { cause: 'slag:max_iters', title: '2 runs looped without finishing', fix: 'Split the task.', hits: 2 }, 1000);
A.eq(id, 'mq:slag:max_iters', 'the quest id is the stable cause key');
A.eq(MQ.openCount(s), 1, 'one open maintenance quest');
A.eq(MQ.record(s, { cause: 'slag:max_iters', title: '3 runs looped', fix: 'Split it.', hits: 3 }, 2000), id, 'a repeat of the same cause returns the same id');
A.eq(MQ.openCount(s), 1, 'repeats NEVER duplicate — still one quest');
A.eq(s.quests[id].firstSeenAt, 1000, 'a repeat never resets firstSeenAt (history preserved)');
A.eq(s.quests[id].hits, 3, 'a repeat refreshes the hit count (the card reads "3 runs …")');
A.eq(MQ.record(s, { cause: '' }, 1), null, 'no cause → no quest');

/* ---------- projection: the shared Quests shape, honest text, no fake currency ---------- */
let proj = MQ.project(s);
A.eq(proj.length, 1, 'projection carries the live quest');
A.eq(proj[0].kind, 'maintenance', 'kind is maintenance (one quest shape, never a parallel system)');
A.eq(proj[0].status, 'open', 'open until the signal clears');
A.ok(/3 runs looped/.test(proj[0].title), 'the title carries the diagnosis');
A.ok(proj[0].desc.length > 0, 'the desc carries the fix');
A.ok(typeof proj[0].reward === 'string' && proj[0].reward.length > 0, 'names a real reward');
A.ok(!/\bXP\b|points|coins/i.test(proj[0].reward + ' ' + proj[0].desc), 'no quest rewards a fake currency');

/* ---------- completion: the signal clearing flips it done (never a claim) ---------- */
let stillActive = true;
let closed = MQ.refresh(s, () => stillActive, 3000);
A.eq(closed.length, 0, 'while the cause still recurs, nothing closes');
stillActive = false;
closed = MQ.refresh(s, () => stillActive, 4000);
A.eq(closed.length, 1, 'the cause stopped recurring → the quest transitions done');
A.eq(s.quests[id].completedAt, 4000, 'completedAt is stamped from the injected clock');
proj = MQ.project(s);
A.eq(proj[0].status, 'done', 'the projection reads done');
A.ok(/^fixed —/.test(proj[0].title), 'a done maintenance quest reads as fixed');
closed = MQ.refresh(s, () => stillActive, 5000);
A.eq(closed.length, 0, 'refresh is idempotent — a cleared cause never re-transitions');

/* ---------- a cleared cause that bites AGAIN re-opens (maintenance issues can recur) ---------- */
const reopen = MQ.record(s, { cause: 'slag:max_iters', title: '2 runs looped again', fix: 'Split it.', hits: 2 }, 6000);
A.eq(reopen, id, 'the same cause re-recording returns the same id');
A.eq(s.quests[id].completedAt, null, 'a genuine recurrence RE-OPENS the quest (unlike a one-time station gap)');
A.eq(s.quests[id].firstSeenAt, 6000, 'the re-open stamps a fresh firstSeenAt so the card reads current');

/* ---------- dismissal: permanent, survives hydrate, blocks re-record ---------- */
A.eq(MQ.dismiss(s, id, 7000), true, 'dismissing an open quest takes (always dismissible)');
A.eq(MQ.isDismissed(s, id), true, 'it is now dismissed');
A.eq(MQ.project(s).some(q => q.id === id), false, 'a dismissed quest never re-renders');
A.eq(MQ.record(s, { cause: 'slag:max_iters', title: 'x', fix: 'y', hits: 5 }, 8000), null, 'a dismissed cause never re-mints (stop forever)');
const round = MQ.hydrate(JSON.parse(JSON.stringify(s)));
A.eq(MQ.isDismissed(round, id), true, 'dismissal survives a hydrate round-trip');

/* ---------- hydrate is defensive (never a crash / a resurrected epoch entry) ---------- */
const junk = MQ.hydrate({ quests: { 'mq:bad': { /* no firstSeenAt */ }, 'mq:ok': { cause: 'slag:error', firstSeenAt: 10, completedAt: null, dismissedAt: null } } });
A.eq(Object.keys(junk.quests).length, 1, 'an entry with no firstSeenAt is dropped');
A.eq(junk.quests['mq:ok'].completedAt, null, 'null completedAt round-trips as null (never a 0-epoch resurrection)');

// the errored-run fix is ~166 chars and a classified cause's copy runs ~230: the old 160 cap cut the card's
// last instruction mid-word ("…from the failed reply and repo", 2026-10-07). It must survive record + reload whole.
{
  const SlagLog = require('../frontend/app/slaglog.js');
  const longFix = SlagLog.diagnose('error', {}).fix;
  const st = MQ.fresh();
  MQ.record(st, { cause: 'slag:error', title: '3 runs errored out', fix: longFix, hits: 3 }, 1);
  A.eq(st.quests['mq:slag:error'].fix, longFix, 'the full errored-run fix is kept (no mid-word cut)');
  A.eq(MQ.hydrate(JSON.parse(JSON.stringify(st))).quests['mq:slag:error'].fix, longFix, 'and survives a reload whole');
  A.ok(/report it\.$/.test(MQ.project(st)[0].desc), 'the card ends on its real last words');
}

A.report('maintquests.test');
