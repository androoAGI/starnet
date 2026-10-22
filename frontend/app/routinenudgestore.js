/* AGENT OS — routinenudgestore.js : the "you keep launching this — schedule it?" nudge (lane D).

   A recipe the Commander keeps hand-launching is a routine that hasn't been admitted yet. This store watches
   the REAL per-recipe launch counters (ProspectStore.launches — the scout usage read) and, when a recipe
   crosses the launch floor and has NO live routine, gently offers ONCE to
   put it on a schedule. Accepting deep-links into the marketplace's SCHEDULE IT form (App.openRecipeLaunch:
   params prefilled by LaunchMemory, cadence preset, /api/cron/preview + the unattended-outbound warning all
   apply) — PROPOSE-AND-CONFIRM, never a silent cron write.

   Discipline (mirrors seedstore.js exactly): a gentle Chat.nudge, one offer per session, shares chat.js's
   single post-run beat slot (after suggestion/seed, before recruitment/curiosity), and a durable anti-nag
   ledger (own key): a recipe is offered at most OFFER_MAX times ever, and an explicit "not now" retires it
   for good. The cron check is a read-only cache of GET /api/cron refreshed off run-ends; while the cache is
   UNKNOWN the store stands down (fail-closed = no nag, never a duplicate-routine offer). READ-ONLY citizen:
   it never emits and never writes server state. node-exportable for its test. */
'use strict';
const RoutineNudgeStore = (() => {
  const KEY = 'starnet.routinenudge.v1';
  const CAP = 1;             // at most one schedule offer per session
  const LAUNCH_FLOOR = 3;    // a recipe earns the offer only after this many REAL launches
  const OFFER_MAX = 2;       // …and is never offered more than this many times, ever (ignored ≠ declined, but twice is enough)
  let sessionProposed = 0;
  let cronCache = null;      // null = UNKNOWN (stand down); an array = the live jobs list (may be empty)

  // Shared query seam. Absent spine → cache stays unknown → the store never fires.
  let query = (typeof QuerySpine !== 'undefined') ? QuerySpine : null;
  let stopCron = null;

  /* ---- the durable anti-nag ledger: { offers: { recipeId: { n, lastAt, dismissed } } } ---- */
  function readOffers() {
    try {
      if (typeof localStorage === 'undefined') return {};
      const o = JSON.parse(localStorage.getItem(KEY) || 'null');
      return (o && typeof o === 'object' && o.offers && typeof o.offers === 'object') ? o.offers : {};
    } catch (_) { return {}; }
  }
  function writeOffers(offers) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify({ v: 1, offers: offers })); } catch (_) {}
  }
  function markProposed(id) {
    const offers = readOffers();
    const cur = offers[id] || { n: 0, lastAt: 0, dismissed: false };
    offers[id] = { n: (cur.n || 0) + 1, lastAt: Date.now(), dismissed: !!cur.dismissed };
    writeOffers(offers);
  }
  function markDismissed(id) {
    const offers = readOffers();
    const cur = offers[id] || { n: 0, lastAt: 0, dismissed: false };
    offers[id] = { n: cur.n || 0, lastAt: Date.now(), dismissed: true };
    writeOffers(offers);
  }

  /* ---- the read-only cron cache (the no-duplicate-routine gate) ---- */
  function foldCron(s) {
    const jobs = s && s.hasData && s.data && Array.isArray(s.data.jobs) ? s.data.jobs : null;
    if (jobs) cronCache = jobs;       // failed reads retain last-good cache; unknown stays unknown
  }
  function refreshCron() {
    if (!query || !query.refresh) return;
    try { query.refresh('cron').then(foldCron).catch(() => {}); } catch (_) {}
  }
  function scheduledRecipeIds() {
    const out = {};
    for (const j of (Array.isArray(cronCache) ? cronCache : [])) {
      const rid = j && j.meta && j.meta.recipeId;
      if (rid) out[String(rid)] = true;
    }
    return out;
  }

  function init() {
    sessionProposed = 0;
    if (typeof WorkflowTakeoverStore !== 'undefined') WorkflowTakeoverStore.init();
    if (stopCron) { try { stopCron(); } catch (_) {} stopCron = null; }
    if (query && query.subscribe) {
      try { stopCron = query.subscribe('cron', foldCron); } catch (_) { stopCron = null; }
    }
  }
  function reset() { sessionProposed = 0; try { if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY); } catch (_) {} }
  function onRunEnd() { refreshCron(); }   // keep the duplicate gate fresh off the same signal that opens the beat slot

  // the best schedule-worthy recipe right now, or null. All gates SYNC (the beat slot consults this inline).
  function pick() {
    if (cronCache === null) return null;   // cron state unknown → stand down (fail-closed, never a duplicate offer)
    if (typeof ProspectStore === 'undefined' || !ProspectStore.launches) return null;
    if (typeof Recipes === 'undefined' || !Recipes.get) return null;
    const launches = ProspectStore.launches() || {};
    const scheduled = scheduledRecipeIds();
    const offers = readOffers();
    let best = null;
    for (const id of Object.keys(launches)) {
      const u = launches[id];
      const n = (u && typeof u === 'object') ? u.n : u;
      if (!Number.isFinite(n) || n < LAUNCH_FLOOR) continue;
      /* ⛔ LAUNCH COUNT IS NOT THE ONLY COUNTER ON RECORD (2026-08-05). This read `u.n` and nothing else, so a
         recipe the Commander ran three times and rated 👎 all three times still earned "want this every day?" —
         the station reading repetition as approval while its own rate-the-work verdicts said the opposite. The
         usage store already keeps `rated.great` / `rated.miss` beside `n` (the FOR YOU ranker spends them).
         A MISMATCH OF KIND MUST EXCLUDE, NOT DOWN-RANK (repo law): this offer is binary, so a miss-heavy
         recipe is dropped outright rather than sorted below — there is no "slightly less" schedule to propose.
         Miss-heavy = at least two misses AND no more praise than misses; one bad run, or a recipe that was
         mostly liked, still qualifies. Malformed counters read as zero and change nothing. */
      const rated = (u && typeof u === 'object' && u.rated && typeof u.rated === 'object') ? u.rated : null;
      const miss = (rated && Number.isFinite(rated.miss) && rated.miss > 0) ? Math.floor(rated.miss) : 0;
      const great = (rated && Number.isFinite(rated.great) && rated.great > 0) ? Math.floor(rated.great) : 0;
      if (miss >= 2 && miss >= great) continue;                       // the Commander already said this one misses
      if (scheduled[id]) continue;                                    // already a live routine
      const off = offers[id];
      if (off && (off.dismissed || (off.n || 0) >= OFFER_MAX)) continue;   // durably waved off / offered enough
      const r = Recipes.get(id);
      if (!r) continue;                                               // the recipe is gone (deleted custom) → nothing to schedule
      /* THE CADENCE GATE IS GONE (2026-08-05) — it was a dead end, not a filter.
         This used to require `r.cadence` (the CATALOG AUTHOR's suggestion). But the station's own self-growing
         path — seedstore → Recipes.draft → saveCustom — mints every recipe with `cadence: null` (recipes.js
         draft()), so an agent-authored recipe the Commander went on to launch eight times by hand could NEVER
         earn "want it on a schedule?". The one recipe shape that PROVES a habit was the one shape structurally
         excluded from the habit nudge.
         The evidence for the offer was never the author's suggestion anyway — it is LAUNCH_FLOOR real
         hand-launches, which is exactly what the nudge cites. Nothing here fabricates a schedule: the offer
         states the count and nothing else, and accepting opens the SCHEDULE IT form where the Commander picks
         the cadence and sees the live next-fire preview before anything is written (propose-and-confirm).
         Launch SPACING is deliberately not inferred: the usage store keeps `n` and a single `lastAt`, so there
         is no interval to compute, and guessing one from a lone timestamp would be the fabricated schedule this
         lane exists to prevent. */
      const cadence = r.cadence || null;
      // ties break toward the recipe whose author DID declare a rhythm — a real corroborating signal, used only
      // to order equally-launched candidates, never to admit or exclude one.
      if (!best || n > best.n || (n === best.n && cadence && !best.cadence)) {
        best = { id: id, name: r.name || id, n: Math.floor(n), cadence: cadence };
      }
    }
    return best;
  }

  // the sync gate the post-run beat slot consults (read-only): a candidate exists AND this session's budget is free.
  function willPropose() { return sessionProposed < CAP && !!pick(); }

  // render the gentle offer; "schedule it" deep-links into the SCHEDULE IT form, "not now" retires the recipe for good.
  function propose() {
    if (sessionProposed >= CAP) return;
    if (typeof Chat === 'undefined' || !Chat.nudge) return;
    const c = pick(); if (!c) return;
    sessionProposed++;         // spend the session's one offer whether or not they act (anti-nag)
    markProposed(c.id);        // durable tally — an IGNORED nudge stops re-surfacing after OFFER_MAX sessions
    let handled = false;       // one-shot: a double-click can't double-open the bay
    Chat.nudge(
      'you’ve launched ' + c.name + ' ' + c.n + ' times by hand — want it on a schedule instead? I’ll bring it to you.',
      [{ label: '▸ put it on a schedule', value: 'routine' }, { label: 'not now', value: 'no', skip: true }],
      choice => {
        if (handled) return; handled = true;
        // THE OUTCOME LOOP (quality loop, Q2): scheduling opens the SCHEDULE IT form rather than launching a
        // run, so the accept IS the outcome; a wave-off is real signal about this channel. Fail-open.
        // AND THE LEDGER'S HALF (dead-wires lane, 2026-08-28): the spine minted a `shown` row for this card
        // (RecLedger.note — routine is not OWN_LEDGER) and nothing ever answered it; the durable ledger read
        // every routine nudge as permanently unanswered. The verdict lands in both places.
        const rq = (typeof RecQualityStore !== 'undefined') ? RecQualityStore : null;
        const rl = (typeof RecLedger !== 'undefined') ? RecLedger : null;
        if (choice && choice.value === 'routine') {
          if (typeof App !== 'undefined' && App.openRecipeLaunch) App.openRecipeLaunch(c.id, 'routine');
          if (rq && rq.noteAccept) { try { rq.noteAccept({ channel: 'routine', spawnsWork: false, id: c.id }); } catch (_) {} }
          if (rl && rl.accepted) { try { rl.accepted('routine'); } catch (_) {} }
        } else {
          markDismissed(c.id);   // an explicit "not now" is a decision — never offer this recipe again
          if (rq && rq.noteDecline) { try { rq.noteDecline({ channel: 'routine' }, false); } catch (_) {} }
          if (rl && rl.declined) { try { rl.declined('routine', false); } catch (_) {} }
        }
      }
    );
  }

  return { init, reset, onRunEnd, willPropose, propose,
    LAUNCH_FLOOR, OFFER_MAX, KEY,
    _pick: pick, _setQueryForTest: q => { query = q; }, _setCronForTest: c => { cronCache = c; } };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { RoutineNudgeStore };
