/* AGENT OS — trust.js : the PURE engine for EARNED AUTONOMY (Growth Tier 3 — track record → trust).

   THE MISSING LOOP. Level + confidence were explicitly cosmetic (xp.js:12 — "these DESCRIBE the agent's growth,
   they never GATE it"); the Initiative/Reach dial was user-set only (autonomy.js) with no path from performance
   to posture. This engine closes it: a demonstrated track record (real runs + a positive-feedback streak + a
   calibrated satisfaction %) MINTS a one-tap OFFER — "you've earned it, may I raise the leash one rung?" — that
   the Commander CONSENTS to (never a silent escalation). The earned rung persists with provenance, and a
   sustained bad streak DEMOTES it back (with an explicit notice — trust is bidirectional).

   THE DESIGN LAWS (locked by Andrew's prior decisions — encoded here as constants, not prose):
     • CONSENT, NOT SILENT ESCALATION. This engine only ever PROPOSES; the store applies on Accept. assess() is a
       pure read; nothing here writes a posture. Decline/ignore-2× negative state (persisted by the store) is fed
       back in via `declinedRungs` so a refused rung never re-offers that level band.
     • CEILINGS ARE HARD. An initiative offer never proposes past a caller-supplied ceiling (default 'free' — but
       the store caps it so REACH is never offered and the dial ceiling is honored). A grant offer only ever
       proposes a key from the caller's GRANTABLE list (permgrants — cabinet:write today). Never reach-out.
     • LEVEL GATES WHEN OFFERS MAY FIRE. This is level's first mechanical consumer: an initiative offer needs
       L≥3, a grant offer needs L≥5. XP purity is untouched — the OFFER is gated, the capability still needs the
       Commander's tap. No number here feeds back into xp.js.
     • HONEST PROVENANCE. Every offer carries {earnedAt, runs, confidence, streak} so the dial can show an EARNED
       badge + the real track record behind it. Nothing is fabricated — every field is read off the folded state.

   PURE + node-testable, mirroring autonomy.js / autopilot.js / xp.js: a `Trust` global in the browser,
   module.exports under node. NO Date.now / Math.random — a decision is a deterministic function of (folded
   state, xp stats, posture, level). The store (truststore.js) injects the clock + persists + applies. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Trust = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- the axis order (mirrors autonomy.INITIATIVE; kept inline so trust stays standalone + node-loadable). The
  // store cross-locks this against the live Autonomy.INITIATIVE in its test — a drift is caught there. ----
  const INITIATIVE = ['wait', 'propose', 'leash', 'free'];
  const rankInit = (v) => INITIATIVE.indexOf(v);

  // ---- THE THRESHOLDS (one place to retune the whole feel; every gate below reads from here) ----
  const INITIATIVE_MIN_LEVEL = 3;    // an initiative offer may not fire below this level (level's first real consumer)
  const INITIATIVE_MIN_CONF = 70;    // …nor below this calibrated satisfaction %
  const INITIATIVE_MIN_TASKS = 10;   // …nor before this many shipped tasks (a real track record, not two lucky runs)
  const INITIATIVE_MIN_STREAK = 5;   // …nor without a positive-feedback streak this long (recent, sustained approval)

  const GRANT_MIN_LEVEL = 5;         // a grant (pre-bless) offer is rarer: a higher level bar
  const GRANT_MIN_CONF = 80;         // …a higher confidence bar
  const GRANT_MIN_TASKS = 20;        // …and more shipped work behind it

  const DEMOTE_NEG_STREAK = 3;       // this many consecutive bad outcomes retires an earned rung (with a notice)
  const DEMOTE_CONF_FLOOR = 40;      // …OR confidence collapsing below this while an earned rung is active

  const WINDOW = 20;                 // the rolling outcome window this engine folds itself (FIFO) — recency for streaks
  const MIN_CONF_SAMPLES = 3;        // confidence is "calibrating" below this many feedback samples (mirrors xp.MIN_SAMPLES) — no offer on an un-calibrated meter

  // ---- the folded shape (persisted by the store). posStreak/negStreak are CONSECUTIVE run-outcome streaks;
  // window is the recent FIFO ring of {ok} outcomes (used only to recompute streaks defensively on hydrate).
  // lastStreakRun caps the streak at ONE move per runId (review fix 3): a single turn-in deck can fold five keeps
  // from one run — that is five APPROVALS, not five runs — so only the FIRST feedback carrying a runId moves the
  // streak for that run. Feedback with NO runId (the sidecar turn-in path today) still counts each — the offer
  // copy says "approvals in a row" so the provenance line stays honest either way. ----
  function fresh() {
    return { v: 1, posStreak: 0, negStreak: 0, window: [], samples: 0, lastConf: 0, lastStreakRun: null };
  }
  function clone(s) { return s ? JSON.parse(JSON.stringify(s)) : fresh(); }
  function num(v, d) { return Number.isFinite(v) ? v : d; }

  // tolerant hydrate: a corrupt/old/partial save degrades to a clean track record per field — never throws.
  function sanitize(raw) {
    const s = fresh();
    if (raw && typeof raw === 'object') {
      s.posStreak = Math.max(0, Math.floor(num(raw.posStreak, 0)));
      s.negStreak = Math.max(0, Math.floor(num(raw.negStreak, 0)));
      s.samples = Math.max(0, Math.floor(num(raw.samples, 0)));
      s.lastConf = Math.max(0, Math.min(100, num(raw.lastConf, 0)));
      if (typeof raw.lastStreakRun === 'string' && raw.lastStreakRun) s.lastStreakRun = raw.lastStreakRun;
      if (Array.isArray(raw.window)) s.window = raw.window.filter(x => x && typeof x === 'object').map(x => ({ ok: !!x.ok })).slice(-WINDOW);
    }
    return s;
  }

  // classify a feedback verdict into an outcome sign: +1 (approval), -1 (dissatisfaction), 0 (neutral, no signal).
  // Mirrors xp.js's turn-in quality mapping so trust and XP agree on what "positive" means. 'work_ok'/👌 is
  // deliberately neutral — it neither extends nor breaks a streak (a middling verdict is not a track-record event).
  function feedbackSign(reason) {
    const r = String(reason || '').trim().toLowerCase();
    if (r === 'kept' || r === 'edited' || r === 'work_great') return 1;
    if (r === 'discarded' || r === 'work_miss') return -1;
    return 0;   // work_ok, unknown → no track-record signal
  }

  // ---- THE ONE TRANSFORM: fold a real event into a NEW folded state (pure). Only two event kinds matter:
  //   memory.feedback — the explicit user verdict: extends/breaks the consecutive streaks + the window + samples.
  //   agent.run.end   — a clean 'done' run is a mild positive outcome for the window ONLY (it never touches the
  //                     feedback streaks — an unrated run is not approval), so a good streak isn't reset by chatter.
  // ev = { name, payload }. Returns the new state (never mutates the input). ----
  function fold(state, ev) {
    const s = sanitize(clone(state));
    const name = (ev && ev.name) || '', p = (ev && ev.payload) || {};
    if (name === 'memory.feedback') {
      const sign = feedbackSign(p.reason);
      if (sign === 0) return s;                       // 👌/unknown: no track-record signal, streaks untouched
      s.samples += 1;
      // review fix 3 — one streak move per runId: a turn-in deck folds several keeps from ONE run; only the
      // first feedback of that run moves the streak (either direction). The window still records each verdict.
      const runId = (typeof p.runId === 'string' && p.runId) ? p.runId : null;
      const streakMoves = !runId || runId !== s.lastStreakRun;
      if (streakMoves) {
        if (sign > 0) { s.posStreak += 1; s.negStreak = 0; }
        else { s.negStreak += 1; s.posStreak = 0; }
        if (runId) s.lastStreakRun = runId;
      }
      s.window.push({ ok: sign > 0 });
      while (s.window.length > WINDOW) s.window.shift();
    } else if (name === 'agent.run.end') {
      // a clean run is a window positive only (no streak effect — the streak is FEEDBACK-driven). An errored /
      // cancelled / budget / refusal run is a window negative but again leaves the feedback streaks alone.
      if (p.reason === 'done') s.window.push({ ok: true });
      else if (p.reason === 'error' || p.reason === 'refusal') s.window.push({ ok: false });
      else return s;   // max_iters / budget / cancelled: not a clean signal either way
      while (s.window.length > WINDOW) s.window.shift();
    }
    return s;
  }

  // read the confidence + shipped-task track record off the XP stats (xp.compute() render-state OR raw stats).
  // We read the SAME honest numbers xp.js exposes — never re-derive or invent. Returns a normalized snapshot.
  function xpSnapshot(xp) {
    const x = xp || {};
    const level = Math.max(1, Math.floor(num(x.level, 1)));
    const confidence = Math.max(0, Math.min(100, Math.round(num(x.confidence, 0))));
    const samples = Math.max(0, Math.floor(num(x.samples, 0)));
    // tasksDone lives under counters on raw stats, or flat on the compute() render-state.
    const tasksDone = Math.max(0, Math.floor(num(
      (x.counters && x.counters.tasksDone != null) ? x.counters.tasksDone : x.tasksDone, 0)));
    return { level, confidence, samples, tasksDone, known: samples >= MIN_CONF_SAMPLES };
  }

  // the provenance record stamped onto every offer + every earned rung — the HONEST track record, read straight
  // off the folded state + xp snapshot (nothing fabricated). earnedAt is injected (clock-free engine).
  function provenance(state, snap, earnedAt) {
    const s = sanitize(state);
    return {
      earnedAt: (typeof earnedAt === 'number' && isFinite(earnedAt)) ? earnedAt : null,
      runs: (snap && snap.tasksDone) || 0,
      confidence: (snap && snap.confidence) || 0,
      streak: s.posStreak
    };
  }

  // is a rung on the declined denylist for THIS level band? The store persists {rung: bandLevel} declines; a rung
  // declined at the level band it's re-proposed in is suppressed (a NEW level band re-opens the offer — earning a
  // level is a fresh mandate). bandOf() buckets levels so "this level band" is stable across a few XP points.
  function bandOf(level) { return Math.max(1, Math.floor(num(level, 1))); }
  function isRungDeclined(declined, kind, to, level) {
    if (!declined || typeof declined !== 'object') return false;
    const key = kind + ':' + to;
    const band = declined[key];
    if (band == null) return false;
    return bandOf(level) <= bandOf(band);   // declined at this band or a higher one already → still suppressed
  }

  // ---- THE OFFER DECISION (pure read; the store consents + applies). Returns { offer } where offer is null OR
  //   { kind:'initiative'|'grant', to, why, provenance }. Order: an INITIATIVE raise is offered first (the common
  //   path); a GRANT pre-bless only when initiative is already maxed-usable AND the higher grant bars are cleared.
  //   ctx: { level, confidence, samples, tasksDone } via xpSnapshot(xp) OR pass xp directly;
  //        currentInitiative (the live dial rung), ceilingInitiative (hard cap, default 'free'),
  //        grants:[key] (held), grantable:[key] (the ONLY keys a grant offer may propose — permgrants.GRANTABLE),
  //        declined:{ 'kind:to': bandLevel } (persisted negative state), earnedAt (clock, for provenance). ----
  function assess(state, ctx) {
    ctx = ctx || {};
    const s = sanitize(state);
    const snap = ctx.xp ? xpSnapshot(ctx.xp) : xpSnapshot(ctx);
    const curInit = INITIATIVE.indexOf(ctx.currentInitiative) >= 0 ? ctx.currentInitiative : 'wait';
    const ceiling = INITIATIVE.indexOf(ctx.ceilingInitiative) >= 0 ? ctx.ceilingInitiative : 'free';
    const declined = ctx.declined || {};
    const earnedAt = ctx.earnedAt;

    // the calibrated-satisfaction gate is shared by BOTH offer kinds — never offer on an un-calibrated meter.
    if (!snap.known) return { offer: null };

    // ---- INITIATIVE RAISE — the common earned rung. Propose the NEXT rung up (curInit+1), never a jump; never
    // past the ceiling; never a rung already declined in this level band. ----
    const nextRank = rankInit(curInit) + 1;
    if (nextRank >= 0 && nextRank < INITIATIVE.length && nextRank <= rankInit(ceiling)) {
      const to = INITIATIVE[nextRank];
      const initReady = snap.level >= INITIATIVE_MIN_LEVEL
        && snap.confidence >= INITIATIVE_MIN_CONF
        && snap.tasksDone >= INITIATIVE_MIN_TASKS
        && s.posStreak >= INITIATIVE_MIN_STREAK
        && s.negStreak === 0;
      if (initReady && !isRungDeclined(declined, 'initiative', to, snap.level)) {
        return {
          offer: {
            kind: 'initiative', to: to,
            why: snap.tasksDone + ' tasks, ' + snap.confidence + '% satisfaction — ready for more',
            provenance: provenance(s, snap, earnedAt)
          }
        };
      }
    }

    // ---- GRANT PRE-BLESS — rarer (higher bars). Only after initiative can no longer be raised toward the ceiling
    // (or its raise isn't ready) do we consider pre-blessing a GRANTABLE capability the Commander hasn't granted. ----
    const grantable = Array.isArray(ctx.grantable) ? ctx.grantable : [];
    const held = new Set(Array.isArray(ctx.grants) ? ctx.grants : []);
    const grantReady = snap.level >= GRANT_MIN_LEVEL
      && snap.confidence >= GRANT_MIN_CONF
      && snap.tasksDone >= GRANT_MIN_TASKS
      && s.posStreak >= INITIATIVE_MIN_STREAK
      && s.negStreak === 0;
    if (grantReady) {
      for (const key of grantable) {
        if (held.has(key)) continue;                                   // already blessed — nothing to offer
        if (isRungDeclined(declined, 'grant', key, snap.level)) continue;
        return {
          offer: {
            kind: 'grant', to: key,
            why: snap.tasksDone + ' tasks at ' + snap.confidence + '% — trusted to write on its own',
            provenance: provenance(s, snap, earnedAt)
          }
        };
      }
    }

    return { offer: null };
  }

  // ---- THE DEMOTION DECISION (pure read; the store applies + notices). trust is bidirectional: a sustained bad
  //   streak OR a confidence collapse retires an EARNED rung back toward — but NEVER below — the Commander's own
  //   manual floor. Returns { demote } where demote is null OR { from, to, why }.
  //   ctx: { earned:{ initiative:{ to, floor } } | null, xp } — `earned.initiative` is the store's record of the
  //        rung IT raised (to) and the manual floor it must never go below (floor). Only an earned rung demotes. ----
  function demote(state, ctx) {
    ctx = ctx || {};
    const s = sanitize(state);
    const earned = ctx.earned && ctx.earned.initiative ? ctx.earned.initiative : null;
    if (!earned) return { demote: null };                              // nothing was earned → nothing to take back
    const snap = ctx.xp ? xpSnapshot(ctx.xp) : xpSnapshot(ctx);

    const badStreak = s.negStreak >= DEMOTE_NEG_STREAK;
    const confCollapse = snap.known && snap.confidence < DEMOTE_CONF_FLOOR;
    if (!badStreak && !confCollapse) return { demote: null };

    const from = INITIATIVE.indexOf(earned.to) >= 0 ? earned.to : null;
    if (!from) return { demote: null };
    // step DOWN one rung, but never below the Commander's own manual floor (the rung they set before we raised it).
    const floorRank = INITIATIVE.indexOf(earned.floor) >= 0 ? rankInit(earned.floor) : 0;
    const toRank = Math.max(floorRank, rankInit(from) - 1);
    if (toRank >= rankInit(from)) return { demote: null };             // already at/below the floor — nothing to take
    const to = INITIATIVE[toRank];
    const why = badStreak
      ? 'stepping back a rung after ' + s.negStreak + ' rough results'
      : 'confidence slipped to ' + snap.confidence + '% — easing off until it recovers';
    return { demote: { from: from, to: to, why: why } };
  }

  return {
    fresh, sanitize, fold, feedbackSign, xpSnapshot, provenance, bandOf, isRungDeclined,
    assess, demote,
    INITIATIVE,
    INITIATIVE_MIN_LEVEL, INITIATIVE_MIN_CONF, INITIATIVE_MIN_TASKS, INITIATIVE_MIN_STREAK,
    GRANT_MIN_LEVEL, GRANT_MIN_CONF, GRANT_MIN_TASKS,
    DEMOTE_NEG_STREAK, DEMOTE_CONF_FLOOR, WINDOW, MIN_CONF_SAMPLES
  };
});
