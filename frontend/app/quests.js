/* AGENT OS — quests.js : the PURE quest-skin engine. Dresses the station's EXISTING, honest progress as RPG
   quests — without inventing anything. It is a read PROJECTION over three real sources:
     • xp.js MILESTONES   — real achievements (tasks shipped, memories reused…); earned = a done quest.
     • the Commander dossier — each still-blank dimension is a "get to know you" quest; known = done.
     • a pending agent idea  — an ONGOING suggestion currently waiting in COMMS = one actionable quest. (The one-time
       First Pitch is NOT surfaced here: it fires the instant it's earned — it never sits "waiting" — so it has no
       quest-log state. Only the recurring SuggestStore.willSuggest cadence produces a waiting idea.)

   THE LAW (inherited from xp.js): every quest cashes out in a REAL capability or outcome — never a fake XP
   currency — and the log NEVER gates anything. It reveals the order of progress; it does not withhold. So an
   "open" quest is always something the Commander can just do now; nothing is locked behind a level.

   PURE + node-testable (a `Quests` global in the browser, module.exports under node). No Date.now / Math.random:
   the quest list is a deterministic function of the live state the store passes in. The browser wiring (the
   quest-log panel) reads DossierStore / XpStore / SuggestStore, calls build(), and renders — it owns nothing here. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Quests = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // build the ordered quest list. input:
  //   milestones  — Xp.milestones(stats) → [{ id, label, hint, earned }]
  //   dossierDims — [{ key, label, known }] (the store joins Dossier.DIMS with DossierStore.summary())
  //   pendingIdea — true when an ONGOING suggestion is due (SuggestStore.willSuggest()). The First Pitch is excluded
  //                 on purpose: it fires immediately on graduation, so it's never a "waiting" log entry.
  //   ledgerQuests — (QUEST V2 §C) the sidecar-owned quest ledger (/api/quests), pre-shaped by QuestLedgerStore
  //                 as [{ id:'q:N', kind:'ledger', ledgerKind, title, desc, reward, status, contract, steps,
  //                 attest, declineNote, ... }]. Spliced right after the waiting idea. Absent input → unchanged.
  //   stationGaps — (G1b) fix-it quests projected from StationQuests: [{ id, kind:'station-gap', title, desc,
  //                 reward, status }] — an agent reached for a tool its room can't grant. Already fully shaped
  //                 by the pure StationQuests.project engine (the store owns the live reads); build() just splices
  //                 them into the ordered list right after the waiting idea, so a real capability failure surfaces
  //                 as the most-actionable direction. Absent input → unchanged (older callers untouched).
  //   workQuests  — (G1c) accepted-idea builds projected from WorkQuests: [{ id, kind:'work', title, desc,
  //                 reward, status }] — a pitch/idea the Commander said "build it" to, with real step progress.
  //   maintQuests — (G1c) fix-it quests projected from MaintQuests: [{ id, kind:'maintenance', title, desc,
  //                 reward, status }] — a recurring slag cause or a jammed routine became actionable direction.
  //                 All three (station/work/maint) are absent-input → unchanged (older callers untouched).
  // OPEN quests (actionable now) come first, then DONE (the trophy shelf). Each quest names its REAL reward.
  function build(input) {
    input = input || {};
    const milestones = Array.isArray(input.milestones) ? input.milestones : [];
    const dims = Array.isArray(input.dossierDims) ? input.dossierDims : [];
    const open = [], done = [];

    // 1) a waiting idea — the single most actionable thing (only ever open).
    if (input.pendingIdea) {
      open.push({ id: 'idea', kind: 'idea', title: 'An idea is waiting', desc: 'your agent has a tailored build in mind — finish a task and it’ll offer it in COMMS.', reward: 'a real, working build', status: 'open' });
    }

    // 1-ledger) HARNESS LEDGER quests (QUEST V2 §C) — the sidecar-owned, agent-aware quest ledger
    //           (/api/quests). Pre-shaped by QuestLedgerStore (kind:'ledger', with contract/attest/steps/
    //           declineNote carried through); build() only sorts them into open/done so the honest ordering +
    //           the QuestState open→done celebration both hold for them free. They lead right after the waiting
    //           idea because a personalized, agent-minted quest is the most actionable direction the station has.
    //           Absent input → unchanged (older callers untouched — the established additive pattern).
    if (Array.isArray(input.ledgerQuests)) {
      for (const q of input.ledgerQuests) {
        if (!q || !q.id) continue;
        (q.status === 'done' ? done : open).push(q);
      }
    }

    // 1-arc) THE GOAL ARC (Tier 2) — the ACTIVE GOAL, decomposed into a path. Pre-shaped by Goals.project as a
    //        header (kind 'arc-goal', progress meter) + one row per milestone (kind 'arc-step', the next OPEN one
    //        the actionable front). Spliced as a WHOLE BLOCK right after the waiting idea so the goal path reads as
    //        the top-level direction: the header + its still-open steps lead the OPEN set, the done steps join DONE.
    //        Absent input → no arc (older callers unchanged). Honest: progress is milestones-done/total, nothing synthetic.
    if (Array.isArray(input.arcQuests)) {
      for (const q of input.arcQuests) {
        if (!q || !q.id) continue;
        (q.status === 'done' ? done : open).push(q);
      }
    }

    // 1a) STATION-GAP fix-it quests (G1b) — a real capdenied/capability-gap became playable direction. These are
    //     pre-shaped by StationQuests.project (id 'sq:<agent>:<cap>', kind 'station-gap'); we only need to sort them
    //     into the open/done buckets so the honest open-before-done ordering + the QuestState fold both hold. They
    //     lead the actionable set (right after the idea) because they name a WALL the agent just hit.
    if (Array.isArray(input.stationGaps)) {
      for (const q of input.stationGaps) {
        if (!q || !q.id) continue;
        (q.status === 'done' ? done : open).push(q);
      }
    }

    // 1a-i) WORK quests (G1c) — an accepted pitch/idea became a trackable multi-step build. Pre-shaped by
    //       WorkQuests.project (id 'wq:<n>', kind 'work'); each carries its own step progress in the desc. They
    //       lead right after the station gaps: a build the Commander SAID YES to is the most actionable direction.
    if (Array.isArray(input.workQuests)) {
      for (const q of input.workQuests) {
        if (!q || !q.id) continue;
        (q.status === 'done' ? done : open).push(q);
      }
    }

    // 1a-ii) MAINTENANCE quests (G1c) — recurring wasted-spend (slag post-mortems) + a jammed routine became a
    //        fix-it. Pre-shaped by MaintQuests.project (id 'mq:<cause>', kind 'maintenance'). Sorted like the
    //        station gaps; they name a recurring WALL the line keeps hitting, so they sit with the actionable set.
    if (Array.isArray(input.maintQuests)) {
      for (const q of input.maintQuests) {
        if (!q || !q.id) continue;
        (q.status === 'done' ? done : open).push(q);
      }
    }

    // 1b) THE STATION ARC — the "what do i build next" spine the tutorial hands off to (recruit → belts →
    //     portals). Pure projections of the live floor (input.station = { crew, belts, connectors } counts);
    //     absent input → no arc (older callers unchanged). Honest-loot: each names the real capability it
    //     cashes out in, and like everything here it gates NOTHING.
    const st = input.station;
    if (st && typeof st === 'object') {
      const arc = [
        { id: 'st:crew', done: (st.crew || 0) >= 2, title: 'Add a second agent', doing: 'summon a second mind — it takes a station of its own and your lead starts delegating.', reward: 'a crew your lead can point' },
        // completes on a LIVE ROUTE (intake → belt → agent-bound bay, the same energized set the floor
        // draws) — never on bare belts-laid, which rewarded a cold dead line and taught the wrong model.
        { id: 'st:belt', done: (st.liveRoute || 0) >= 1, title: 'Send work to an agent automatically', doing: 'in BUILD MODE: place an INBOX and a BAY, drag from the INBOX onto the BAY to lay a belt, and click the bay to assign an agent — the line lights up when the route is complete.', reward: 'a live work route' },
        { id: 'st:connector', done: (st.connectors || 0) >= 1, title: 'Place your first service portal', doing: 'in BUILD MODE, place a connector portal, then connect a service to it in ABILITIES — its tools land in real hands.', reward: 'new real capabilities' }
      ];
      for (const a of arc) {
        const q = { id: a.id, kind: 'station', title: a.title, desc: a.done ? 'done — it’s live on your floor.' : a.doing, reward: a.reward, status: a.done ? 'done' : 'open' };
        (a.done ? done : open).push(q);
      }
    }

    // 2) get-to-know-you quests — one per dossier dimension. Each says what the station DOES with that
    //    dimension (all of these are true: the dossier rides every agent's system prompt), because nine
    //    cards repeating one generic sentence read as one wall — the reader can't tell why THIS one
    //    matters. Unknown/new dimensions keep the honest generic line rather than inventing a claim.
    const DIM_WHY = {
      identity: 'who you are frames how every agent addresses you and pitches its work.',
      stack: 'agents reach for the tools you actually use instead of guessing.',
      goals: 'suggested work gets weighed against what you’re actually trying to reach.',
      style: 'agents match how you like work done — depth, pace, and format.',
      standing_orders: 'rules every agent follows on every run, without being reminded.',
      pain: 'the work that eats your time becomes the work agents offer to take.',
      ambition: 'the things you never find time for become work the station can pick up.',
      people: 'output lands in the right voice for whoever it’s really for.',
      schedule: 'work and check-ins land when you’re actually at the desk.'
    };
    for (const d of dims) {
      if (!d || !d.key) continue;   // a dimension needs a real key — no key, no quest (never a 'dim:null')
      const label = String(d.label || d.key).trim();
      if (!label) continue;
      const q = { id: 'dim:' + d.key, kind: 'dossier', title: 'Tell the station your ' + label.toLowerCase(), desc: DIM_WHY[d.key] || 'every agent on the station will know this about you.', reward: 'sharper, personalized agents', status: d.known ? 'done' : 'open' };
      (d.known ? done : open).push(q);
    }

    // 3) milestone quests — real outcomes; the hint is how to earn an unearned one.
    for (const m of milestones) {
      if (!m || !m.id) continue;
      const q = { id: 'ms:' + m.id, kind: 'milestone', title: String(m.label || m.id), desc: m.earned ? 'earned' : ('how: ' + String(m.hint || '')), reward: 'recognition for real work shipped', status: m.earned ? 'done' : 'open' };
      (m.earned ? done : open).push(q);
    }

    return open.concat(done);
  }

  // counts for the panel header / a soft badge: how many quests are open vs done.
  function summary(list) {
    const arr = Array.isArray(list) ? list : [];
    let open = 0, done = 0;
    for (const q of arr) { if (q && q.status === 'done') done++; else if (q) open++; }
    return { open, done, total: open + done };   // total counts only real quests, so open + done === total always holds
  }

  return { build, summary };
});
