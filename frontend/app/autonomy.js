/* AGENT OS — autonomy.js : the PURE engine for the AUTONOMY POSTURE — the tunable "alive between sessions" dial.

   THE DIAL IS THE PRODUCT. The station can do real work while the Commander is away and feel alive — honestly — and
   the Commander tunes exactly HOW MUCH, per agent, along TWO independent axes (separating them is the whole insight:
   "be productive on your own all day" can coexist with "but ask before anything irreversible"):

     • INITIATIVE — does it start work on its own, and how far:  wait → propose → leash → free
     • REACH      — how far any single unattended action may go before it must pause for you (= the consent ceiling):
                    observe → sandbox → reach

   The awakening's cadence beat sets the OPENING posture from four concrete, picture-able choices (never an abstract
   "how autonomous do you want me to be?" — see the awakening-question-design rule); a station dial retunes it later.
   Range is honored at BOTH ends: full wait-for-me (off) and full free-range (on).

   SAFE BY DEFAULT: fresh() PROPOSES (studies the Commander, lines up suggestions to approve, never acts unattended)
   with a Sandbox ceiling; a corrupt save degrades to fully wait-for-me; and even FREE-RANGE initiative keeps Reach
   capped at 'sandbox' — running free toward goals must never silently send/publish/spend; the Commander raises Reach
   to 'reach' deliberately. That default IS the "productive all day, asks before anything irreversible" guarantee.

   This is Slice 1: the posture MODEL only (the enums, the presets, the derived read surface). The self-directed
   task-selection engine, the cron self-initiation, and the "while you were away" digest are later slices.

   PURE + node-testable, mirroring pitch.js / quests.js: an `Autonomy` global in the browser, module.exports under
   node. NO Date.now / Math.random — a posture is a deterministic function of what the Commander chose. The thin
   browser store (autonomystore.js) self-persists it and is a read-only U.bus citizen; the awakening + the dial panel
   are the only writers. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Autonomy = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // THE TWO AXES, ascending (index === how-much). Keep these as the single source of order; every comparison and
  // clamp derives from them, so adding a future rung is a one-line change here.
  const INITIATIVE = ['wait', 'propose', 'leash', 'free'];
  //   wait    — wait for me: nothing runs unless I ask (full off; this end is honored, not a degenerate case).
  //   propose — line up suggestions I approve; still never acts unattended.
  //   leash   — may do up to leashPerDay small, grounded things unattended per day.
  //   free    — free-range: picks + does work toward my goals while idle/away (within Reach + the leash).
  const REACH = ['observe', 'sandbox', 'reach'];
  //   observe — read-only: research / read / watch; writes nothing unattended.
  //   sandbox — may write/build locally (files, drafts); nothing leaves the machine.
  //   reach   — external / irreversible: send, publish, spend. The true-unsupervised ceiling.

  const DEFAULT_LEASH = 3;            // 'leash' allowance: small grounded jobs per day (anti-runaway, anti-spend)
  const LEASH_MIN = 1, LEASH_MAX = 12;

  const rankOf = (axis, v) => axis.indexOf(v);

  // the persisted shape. DEFAULT (USER-STUDY LOOP, 2026-09-28, Andrew's call) = PROPOSE with a Sandbox ceiling:
  // a new station studies the Commander and lines up goal-grounded suggestions and quests for them to approve,
  // but never ACTS unattended (actsUnattended stays false below 'leash'). 'wait' remains one tap away and is
  // honored exactly. Reach is stored (at 'sandbox') even below 'leash', so later RAISING initiative inherits a
  // ceiling the Commander actually set — never a surprise reach.
  function fresh() { return { v: 1, initiative: 'propose', reach: 'sandbox', leashPerDay: DEFAULT_LEASH }; }
  // the conservative floor a CORRUPT or partial save degrades to, per field: fully wait-for-me. A save the
  // Commander wrote and the disk mangled must never come back MORE active than the safest reading of it.
  function floor() { return { v: 1, initiative: 'wait', reach: 'sandbox', leashPerDay: DEFAULT_LEASH }; }

  function clampLeash(n) {
    n = Math.round(Number(n));
    if (!Number.isFinite(n)) return DEFAULT_LEASH;
    return Math.max(LEASH_MIN, Math.min(LEASH_MAX, n));
  }

  // tolerant hydrate: clamp every field to a known value. A corrupt / old / partial save degrades to the safe floor
  // per field — never throws, never yields an out-of-enum posture that the runtime gates could misread.
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return fresh();   // nothing saved yet → the new-station default
    const s = floor();
    if (INITIATIVE.indexOf(raw.initiative) >= 0) s.initiative = raw.initiative;
    if (REACH.indexOf(raw.reach) >= 0) s.reach = raw.reach;
    if (raw.leashPerDay != null) s.leashPerDay = clampLeash(raw.leashPerDay);
    return s;
  }

  // is the posture AT LEAST this level on an axis? The downstream runtime gates (later slices) read through this so
  // "may it build unattended?" is one tested predicate, never an ad-hoc string compare.
  function atLeast(state, axis, level) {
    const s = normalize(state);
    if (axis === 'initiative') return rankOf(INITIATIVE, s.initiative) >= rankOf(INITIATIVE, level) && rankOf(INITIATIVE, level) >= 0;
    if (axis === 'reach') return rankOf(REACH, s.reach) >= rankOf(REACH, level) && rankOf(REACH, level) >= 0;
    return false;
  }

  // single-axis setters (the dial panel). An out-of-enum level is ignored (posture stays valid), not thrown.
  function setInitiative(state, level) { const s = normalize(state); if (INITIATIVE.indexOf(level) >= 0) s.initiative = level; return s; }
  function setReach(state, level) { const s = normalize(state); if (REACH.indexOf(level) >= 0) s.reach = level; return s; }
  function setLeash(state, n) { const s = normalize(state); s.leashPerDay = clampLeash(n); return s; }

  // THE AWAKENING CADENCE BEAT — concrete, scenario-grounded choices (each a tangible behavior the Commander can
  // picture, NOT an abstract slider). Order = least → most autonomous. NB: 'free' caps Reach at 'sandbox' on
  // purpose — see the file header. The store maps the picked id through applyPreset to set the opening posture.
  function cadencePresets() {
    return [
      { id: 'wait',    initiative: 'wait',    reach: 'observe', label: "wait for me — do nothing until i'm back" },
      { id: 'suggest', initiative: 'propose', reach: 'observe', label: 'line up suggestions i can one-tap when i return' },
      { id: 'build',   initiative: 'leash',   reach: 'sandbox', label: 'quietly build a few small things while i’m away (a beat every ~45 min, up to the daily leash) — each one arrives as a new session in my rail to review' },
      { id: 'free',    initiative: 'free',    reach: 'sandbox', label: 'run free toward my goals while i’m away — build all night up to the leash; everything arrives as new sessions in my rail when i’m back' }
    ];
  }
  function presetById(id) { return cadencePresets().filter(p => p.id === id)[0] || null; }
  function applyPreset(state, id) {
    const p = presetById(id);
    const s = normalize(state);
    if (p) { s.initiative = p.initiative; s.reach = p.reach; }
    return s;
  }
  // which preset (if any) the current posture EXACTLY matches — lets the dial highlight the chosen cadence, and
  // returns null once the Commander hand-tunes off a preset (a legitimate custom posture).
  function matchPreset(state) {
    const s = normalize(state);
    const p = cadencePresets().filter(x => x.initiative === s.initiative && x.reach === s.reach)[0];
    return p ? p.id : null;
  }

  // the single derived READ surface (booleans + label) so callers never re-derive posture logic. Every flag is
  // honest about the AND of both axes: it only "builds unattended" if initiative acts AND reach permits writing.
  function summary(state) {
    const s = normalize(state);
    return {
      initiative: s.initiative,
      reach: s.reach,
      leashPerDay: s.leashPerDay,
      enabled: s.initiative !== 'wait',                                          // anything at all happen unattended?
      proposesOnly: s.initiative === 'propose',                                  // lines up ideas, never acts
      actsUnattended: atLeast(s, 'initiative', 'leash'),                         // leash or free → does work on its own
      buildsUnattended: atLeast(s, 'initiative', 'leash') && atLeast(s, 'reach', 'sandbox'),
      reachesOut: atLeast(s, 'initiative', 'leash') && atLeast(s, 'reach', 'reach'),
      preset: matchPreset(s)
    };
  }

  // one-line plain-English posture for the dial header + the digest. This describes the ENFORCED reality (NS-1): the
  // night shift is server-owned — while you're away it considers ONE beat about every 45 minutes, the daily leash is
  // actually counted and enforced, and each act arrives as a new session in the rail (a draft shows in LAST REPORT). Legibility (you always see
  // what it did, next time you're back) is the universal tail — true at every level, including Reach-out. Shown ONLY in
  // SETTINGS › AUTONOMY (#auto-desc), so LAST REPORT is 'below', never a breadcrumb back to the page it is on; and no
  // inline ⚒ — a symbol glyph draws from a fallback font with its own weight and baseline inside VT323 text.
  function describe(state) {
    const s = normalize(state);
    if (s.initiative === 'wait') return 'Waiting for you — nothing runs on its own.';
    if (s.initiative === 'propose') return 'Lines up suggestions for you to approve — never acts on its own.';
    const reachWord = s.reach === 'observe' ? 'research only (writes nothing)'
      : s.reach === 'sandbox' ? 'builds locally, nothing leaves the machine'
      : 'can send, publish, or contact external services';
    const how = s.initiative === 'leash' ? ('up to ' + s.leashPerDay + ' small jobs a day') : ('freely toward your goals (up to ' + s.leashPerDay + ' jobs a day)');
    return 'While you’re away it works on its own ' + how + ' — one small job about every 45 min — ' + reachWord + '. Each finished job arrives as a new session in your rail; drafts show under LAST REPORT below. You see everything it did.';
  }

  return {
    fresh, normalize, atLeast, setInitiative, setReach, setLeash,
    cadencePresets, presetById, applyPreset, matchPreset, summary, describe,
    INITIATIVE, REACH, DEFAULT_LEASH, LEASH_MIN, LEASH_MAX
  };
});
