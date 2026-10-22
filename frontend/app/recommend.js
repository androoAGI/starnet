/* AGENT OS — recommend.js : THE RECOMMENDATION SPINE (pure, node-testable, zero DOM / zero fetch).

   The station used to talk to its Commander through ~9 independent proactive channels (study, arc, trust,
   thread, rate, suggestion, seed, routine, recruitment, curiosity), each with its own timer. Whoever armed
   EARLIEST won the one post-run beat, so the LOWEST-value ask usually spoke first and the priority order
   baked into beatcard.js was inert. This module is the single relevance bar they all pass through.

   Two laws it enforces, both of them the product's truthful-telemetry law applied to recommendations:

     1. ONE VOICE — pick() returns at most ONE candidate. Best-first, or silence.
     2. EVIDENCE OR SILENCE — a candidate with no non-empty `why` is DROPPED, never shown. The station may
        only make a proactive offer it can justify out of real state (the Commander's own words, a real
        streak count, a real targeted gap). No citable evidence means the channel stays quiet.

   A candidate is a plain object:
     { kind, why, dim?, base?, streak?, declines?, strength?, quality?, preference?, title?, target? }
       kind     — the channel id (see PRIORITY). Its beat-slot family is slotKindOf(kind).
       why      — the evidence string, derived from REAL state by the channel adapter. Required.
       dim      — optional dossier dimension this offer targets (enables the value-of-information term).
       base     — optional explicit base score override (tests / future channels).
       streak   — optional non-negative run of corroborating signal (trust's approval streak).
       declines — optional count of recent declines on this channel (a soft penalty, never a hard block;
                  the per-channel session caps/denylists remain the real floor and live in their stores).
       strength — optional 0..1 EVIDENCE STRENGTH (recquality.js): how well-grounded this candidate's citation
                  actually is — dim confidence, belief freshness, a real repeat counter. Weak evidence is
                  DISCOUNTED within its tier; it never fabricates a bonus, and an absent reading is NEUTRAL.
       quality  — optional CHANNEL QUALITY WEIGHT (recqualitystore.js): the EWMA of the outcomes this channel's
                  accepted offers really produced. Neutral 1, floored at 0.5 so quality alone can never silence
                  a channel — a dud channel gets quieter, never mute.
       preference — optional LEARNED PREFERENCE WEIGHT (−0.75..+0.75) from the durable cross-surface ledger
                  (recledger.js): the Commander's own decayed accept/decline history for this kind. The one
                  TWO-SIDED modifier here, because it is their answers rather than the station's confidence.
       title    — optional plain-language name of the thing being proposed. Not scored: it is what the ledger
                  records and what the shared declined memory is matched against. A channel that proposes an
                  IDEA should carry one; a channel that asks a question about the station need not.
       target   — optional stable key for the ledger row (defaults to a fingerprint of the title).

   SCORING IS BANDED (redesigned 2026-08-04, after the scorer was proved INERT). It used to give every KIND its
   own 100-wide tier and clamp the whole modifier sum to ±50 — which, since the pass emits at most one candidate
   per kind and pick() breaks a dead tie by rank, meant no modifier could ever change the winner. Exhaustively
   proved: 0 of 20000 random fields ranked differently from pure priority order. Strength, quality, VOI, streaks
   and declines were decoration. The structure now has two levels:

     BANDS  — memory alone, then the turn-ins [study arc trust thread], then rate, then the five gentle channels.
              Bands are BAND_STEP apart and the whole modifier budget (MOD_CAP, ±) is strictly under half the
              smallest gap between adjacent bands, so NO stack of modifiers can ever move a candidate across a
              band. That is the part of the old law worth keeping: a gentle nudge can never outrank a turn-in.
     RANK   — inside a band, kinds sit RANK_STEP apart. That step is a TIE-BIAS, not a wall: it decides who
              speaks when the station knows nothing about either channel, and the modifiers are deliberately
              large enough to overturn it. Same-band reordering is the POINT — a fresh, high-value curiosity
              question may beat a stale recruit pitch, and a dud-channel suggestion may lose to a routine nudge
              whose accepted offers really produced work. Priority is the default, not the verdict. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Recommend = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* The one priority order. Its head is beatcard.js's DEFAULT_PRIORITY (memory > study > arc > trust >
     thread > rate > nudge); its tail expands the single 'nudge' slot family into the five gentle channels
     in the EXACT precedence the old wireCuriosity if/return ladder used (suggestion → seed → routine →
     recruitment → curiosity). That order is the TIE-BIAS — what decides when the station knows nothing about
     either channel — NOT a wall: since the band restructure, evidence really does reorder same-band kinds, which
     is the point of measuring it. (This comment used to claim consolidating the ladder "changes who can speak,
     never the pecking order". That was true only while the scorer was inert; it is exactly what got fixed.) */
  const BANDS = [
    ['memory'],                                                 // the run reporting back — never an interruption
    ['study', 'arc', 'trust', 'thread'],                        // the turn-ins: real evidence the run just produced
    ['rate'],                                                   // the control the Commander is asking FOR
    ['suggest', 'seed', 'routine', 'recruit', 'curiosity']      // the gentle asides, one shared slot
  ];
  const PRIORITY = BANDS.reduce((a, b) => a.concat(b), []);

  // channel id → the beat-slot kind beatcard.js arbitrates on. The five gentle channels all render through
  // chat.js's shared nudge() aside, so they share the one 'nudge' slot family.
  const SLOT_KIND = {
    memory: 'memory', study: 'study', arc: 'arc', trust: 'trust', thread: 'thread', rate: 'rate',
    suggest: 'nudge', seed: 'nudge', routine: 'nudge', recruit: 'nudge', curiosity: 'nudge'
  };

  /* THE SESSION ASK BUDGET. Per-channel caps are the second floor, but nothing bounded the TOTAL number of
     unprompted consent cards a single browser session could stack up — five channels each spending their own
     one-per-session cap is still five interruptions. This is the spine-level ceiling on PROACTIVE asks.
     TUNABLE: raise/lower this one number to make the station more or less talkative.
     Two kinds are EXEMPT because the run itself earns them rather than the station choosing to interrupt:
       · memory — the Commander's own reflection deck; it is the run reporting back, and it never routes
                  through the pass at all (it reserves the slot directly on memory.proposed).
       · rate   — the primary leveling beat for work that was just done, and the one control the Commander
                  is asking FOR when they finish a task. */
  const SESSION_ASK_MAX = 4;
  const ASK_EXEMPT = { memory: true, rate: true };
  function asksBudget(kind) { return !Object.prototype.hasOwnProperty.call(ASK_EXEMPT, String(kind || '')); }

  const BAND_STEP = 1000;  // the distance between two BANDS — a wall no modifier may climb
  const RANK_STEP = 10;    // the distance between two kinds INSIDE a band — a tie-bias modifiers may overturn
  const VOI_MAX = 60;      // value-of-information term ceiling
  const STREAK_STEP = 5;   // per corroborating signal…
  const STREAK_MAX = 20;   // …bounded
  const DECLINE_STEP = 15; // per recent decline…
  const DECLINE_MAX = 45;  // …bounded
  /* MOD_CAP is a SLACK INVARIANT CAP, not a working limit — it is never reached and is not meant to be. It exists
     so the band wall is enforced STRUCTURALLY (2 × MOD_CAP < BAND_GAP_MIN, asserted below and in recommend.test),
     which keeps the guarantee true for any future modifier someone adds without re-deriving the arithmetic.
     The really achievable range today is much smaller: VOI 0..+60, streak 0..+20, declines 0..−45, strength
     −15..0, quality −15..+7.5, preference −20..+20 → mod ∈ [−95 .. +107.5]. So the clamp below is inert at
     present, deliberately. */
  const MOD_CAP = 240;     // the TOTAL modifier budget, ± — see BAND_GAP_MIN below

  // the base score of every kind, derived from the band table. Higher band + earlier inside it = higher base.
  const BASE = {};
  for (let b = 0; b < BANDS.length; b++) {
    for (let i = 0; i < BANDS[b].length; i++) BASE[BANDS[b][i]] = (BANDS.length - b) * BAND_STEP + (BANDS[b].length - i) * RANK_STEP;
  }
  /* THE BAND WALL, computed rather than asserted: the smallest distance between the WEAKEST member of a band and
     the STRONGEST member of the band below it. 2 × MOD_CAP must stay strictly under it — then a maxed-out
     candidate in a lower band still cannot reach a bottomed-out candidate in a higher one, and priority survives
     as the spine's law exactly where it matters. (Inside a band there is no wall, on purpose.) */
  const BAND_GAP_MIN = BANDS.slice(1).reduce((min, band, i) => {
    const upper = BANDS[i];
    return Math.min(min, BASE[upper[upper.length - 1]] - BASE[band[0]]);
  }, Infinity);

  /* THE TWO DAMPED MULTIPLIERS (quality loop, Q1/Q2). Both are read as multipliers in the [floor..1(..cap)]
     range and converted into a bounded WITHIN-TIER term: `MAX × (multiplier − 1)`. That shape is deliberate —
       · a NEUTRAL reading (1) contributes exactly 0, so a cold station scores identically to the pre-quality
         spine (fail-open, truthful telemetry);
       · a WEAK reading only ever SUBTRACTS. The station does not promote an offer for having strong evidence;
         it declines to shout about one whose evidence is thin.
     THE HONEST CONSEQUENCE, stated rather than glossed: because the term is one-sided, ABSENT strength is not
     neutral in effect — it is a small RELATIVE ADVANTAGE over a channel that reports one honestly and reports it
     low. Every channel with real data to read now reads it (chat.js: arc, study, trust, seed, routine); the ones
     that abstain do so because there is genuinely nothing to read (curiosity asks rather than asserts, thread has
     no dim and no age, the re-confirm ask asserts nothing). The residual edge is bounded by STRENGTH_MAX/2 —
     under two rank steps, never a band — and fabricating a reading to erase it would cost more than it buys. */
  // STRENGTH_MAX is the SCALE, not the swing: the multiplier band is [0.5 .. 1], so the real term is −15 .. 0 —
  // i.e. thin evidence costs at most 1.5 rank steps, and strong evidence is worth exactly nothing (by design).
  const STRENGTH_MAX = 30;
  const STRENGTH_FLOOR = 0.5;   // strength 0 → ×0.5 → −STRENGTH_MAX/2 = −15.
  /* QUALITY OUTRANKS RANK, NOT EVERYTHING (measured live 2026-08-04). Its swing comfortably clears a RANK_STEP,
     so a channel's real outcome record reorders it against its band siblings — which is the whole point. It does
     NOT clear a maximum-VOI promotion: forty real declines still leave a blank high-weight dimension the most
     valuable thing the station can ask about. That is deliberate and it is this module's stated law — silencing a
     channel is the job of the per-channel caps and the Commander's own explicit "never", not of a number the
     station computed. Raising this until quality could veto VOI was tried and reverted. */
  // …and the same SCALE-not-swing reading: the multiplier band is [0.5 .. 1.25], so the real term is −15 .. +7.5.
  // A dud channel loses 1.5 rank steps; a proven one gains under one. Both clear a tie, neither clears a band.
  const QUALITY_MAX = 30;
  const QUALITY_FLOOR = 0.5;    // matches recquality.js Q_FLOOR — a dud channel is quieter, NEVER silent
  const QUALITY_CAP = 1.25;     // matches recquality.js Q_CAP — a proven channel earns a small, bounded edge

  /* ── THE LEARNED PREFERENCE TERM (one-memory lane, 2026-08-05) ──────────────────────────────────────────
     `preference` is the DURABLE CROSS-SURFACE LEDGER's own learned weight for this candidate's kind and traits
     (sidecar/recommendation-ledger.js replay → foldPref → the Bayesian-smoothed, half-life-decayed weight in
     −0.75..+0.75; recledger.js carries it into the browser). Until now the spine could not see it at all: the
     ledger had been recording what the Commander accepts and declines across the bay, the night shift, the
     quests and the scout for months, and the one component that decides who speaks was ranking blind to all of it.

     WHY THIS ONE IS TWO-SIDED, when strength and quality are not. Those two are the STATION's readings about its
     own confidence, and the law there is that the station never promotes an offer for feeling sure — it only
     declines to shout about a thin one. This is not the station's reading. It is a decayed tally of the
     COMMANDER'S OWN ANSWERS, and their yes deserves exactly as much weight as their no. Rejecting the positive
     half would mean a kind they have accepted eight times running is ranked identically to one they have never
     seen — which is not caution, it is deafness.

     BOUNDED, LIKE EVERYTHING ELSE HERE. ±0.75 of ledger weight maps onto ±PREF_MAX, which is two rank steps: it
     reorders a band comfortably and cannot come near the band wall. A cold ledger, a paused personalization
     setting (the server sends `model: null` and recledger reports 0), or a kind with no history all read exactly
     0 — the neutral contribution — so nothing changes until the Commander's real history says it should. */
  const PREF_MAX = 20;          // ±2 rank steps: enough to reorder a band, never enough to cross one
  const PREF_RANGE = 0.75;      // the ledger's own clamp (recommendation-ledger.js preferenceFor)

  /* A READING THE STATION CANNOT PARSE IS NO READING AT ALL (fail-open, explicit). `Number('')`, `Number(false)`
     and `Number(null)` are all a perfectly finite 0 — which used to hand an empty string or a `false` the FULL
     thin-evidence penalty, i.e. the station punished a channel for a field it had failed to read.
     ALLOWLIST, NOT DENYLIST (2026-08-04). The denylist version ('' / null / boolean) still let `' '`, `[]` and
     `[0]` through as a hard 0 — the same bug, a shape further out. Only a real finite number, or a string that
     actually spells one, is a reading; EVERY other shape is neutral. recquality.js num() is the same predicate,
     deliberately duplicated because that module is pure and imports nothing. */
  function reading(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') { const t = v.trim(); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : null; }
    return null;   // null / undefined / boolean / array / object / Date → no reading at all
  }
  // an unreadable / absent multiplier is NEUTRAL (1) — the station never invents a reading it does not have.
  function damp(v, floor, cap) {
    const n = reading(v);
    if (n == null) return 1;
    return n < floor ? floor : n > cap ? cap : n;
  }
  // strength arrives 0..1 (recquality.js) and maps onto the [STRENGTH_FLOOR..1] multiplier band.
  function strengthDamp(candidate) {
    const n = reading(candidate && candidate.strength);
    if (n == null) return 1;
    return STRENGTH_FLOOR + (1 - STRENGTH_FLOOR) * (n < 0 ? 0 : n > 1 ? 1 : n);
  }
  function qualityDamp(candidate) { return damp(candidate && candidate.quality, QUALITY_FLOOR, QUALITY_CAP); }
  /* the learned-preference term. An unreadable or absent weight is NO reading (0), never a fabricated lean —
     the same allowlist predicate every other modifier here goes through. */
  function preferenceTerm(candidate) {
    const n = reading(candidate && candidate.preference);
    if (n == null) return 0;
    const w = n < -PREF_RANGE ? -PREF_RANGE : n > PREF_RANGE ? PREF_RANGE : n;
    return PREF_MAX * (w / PREF_RANGE);
  }

  function rank(kind) {
    const i = PRIORITY.indexOf(String(kind || ''));
    return i < 0 ? PRIORITY.length : i;
  }
  // which BAND a kind sits in (-1 = unknown). Two candidates in the same band may be reordered by evidence; two
  // in different bands never may.
  function bandOf(kind) {
    const k = String(kind || '');
    for (let b = 0; b < BANDS.length; b++) if (BANDS[b].indexOf(k) >= 0) return b;
    return -1;
  }
  function sameBand(a, b) { const x = bandOf(a); return x >= 0 && x === bandOf(b); }
  function slotKindOf(kind) {
    const k = String(kind || '');
    return Object.prototype.hasOwnProperty.call(SLOT_KIND, k) ? SLOT_KIND[k] : k;
  }
  // the only leading words whyLine may de-capitalize: sentence-starter pronouns/determiners that carry no
  // identity of their own. Never a proper noun, a language, a product, or a person's name.
  const STARTER = /^(You|It|This|That|These|Those|We|They|There|I)\b/;
  // streak / declines are COUNTS: an absent or unparseable one is zero of them. Routed through reading() so the
  // "what counts as a number" question has exactly one answer in this module.
  function num(v) { const n = reading(v); return n == null ? 0 : n; }
  function text(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }

  // a candidate may speak only if it can cite. This is the evidence-or-silence law in one predicate.
  function citable(candidate) {
    return !!(candidate && typeof candidate === 'object' && text(candidate.why).length > 0);
  }

  /* the value-of-information term for a dim-targeted candidate: the SAME weight × (1 − conf) gap the
     understanding engine already computes (understanding.js) and CuriosityStore.voiOrder() already ranks
     on — generalized here rather than duplicated. Returns 0 when the read or the dim is unavailable, so a
     cold station simply falls back to pure priority order (fail-open, never a fabricated bonus). */
  function voi(candidate, uRead) {
    if (!candidate || !candidate.dim) return 0;
    const dims = uRead && uRead.dims;
    const d = dims && dims[candidate.dim];
    if (!d) return 0;
    const w = reading(d.weight), c = reading(d.conf);
    if (w == null || c == null) return 0;      // an unreadable dimension is no reading, never a fabricated gap
    const gap = Math.max(0, Math.min(1, w * (1 - c)));
    return gap * VOI_MAX;
  }

  /* score(candidate, uRead) → number. Higher speaks first. Deterministic: no clock, no randomness. */
  function score(candidate, uRead) {
    if (!candidate) return 0;
    const explicit = reading(candidate.base);
    const base = explicit != null ? explicit
      : (Object.prototype.hasOwnProperty.call(BASE, String(candidate.kind || '')) ? BASE[String(candidate.kind)] : RANK_STEP);
    const streak = Math.min(STREAK_MAX, Math.max(0, num(candidate.streak)) * STREAK_STEP);
    const declines = Math.min(DECLINE_MAX, Math.max(0, num(candidate.declines)) * DECLINE_STEP);
    const mod = voi(candidate, uRead) + streak - declines
      + STRENGTH_MAX * (strengthDamp(candidate) - 1)
      + QUALITY_MAX * (qualityDamp(candidate) - 1)
      + preferenceTerm(candidate);
    // the whole modifier budget is clamped well inside one BAND gap, so no stack of modifiers can cross a band.
    // Inside a band it is deliberately larger than the rank step: that is what makes the modifiers mean anything.
    return base + Math.max(-MOD_CAP, Math.min(MOD_CAP, mod));
  }

  /* pick(candidates, uRead) → the one candidate that may speak, or null.
     Drops every uncitable candidate FIRST (evidence or silence), then takes the highest score. Ties break
     by priority rank, then by input order — so the result never depends on Object key order or timing. */
  function pick(candidates, uRead) {
    const list = (Array.isArray(candidates) ? candidates : []).filter(citable);
    let best = null, bestScore = 0, bestRank = 0, bestIndex = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const s = score(c, uRead);
      const r = rank(c.kind);
      if (!best || s > bestScore || (s === bestScore && (r < bestRank || (r === bestRank && i < bestIndex)))) {
        best = c; bestScore = s; bestRank = r; bestIndex = i;
      }
    }
    return best;
  }

  /* whyLine(candidate) → the normalized display string, one grammar for every card and the FOR YOU shelf:
     "because <the evidence, in the Commander's own words>". Idempotent (an already-"because …" string is
     not doubled), trailing sentence punctuation trimmed, never invents text. '' when there is nothing to
     cite — a caller that gets '' must render nothing. */
  function whyLine(candidate) {
    let s = text(candidate && candidate.why);
    if (!s) return '';
    s = s.replace(/^(?:because|since|as)\b\s*/i, '');
    s = s.replace(/[.…]+$/, '');
    if (!s) return '';
    // a citation that already opens with its own preposition is a complete phrase ("from the task you gave me:
    // …") — "because from …" is not English. Return it as written; the framing is already there.
    if (/^(?:from|after)\b/i.test(s)) return s;
    /* THE SPINE NEVER REWRITES THE COMMANDER'S WORDS (fixed 2026-08-04). This used to lower-case any plain
       leading capital so the clause joined mid-sentence — which quietly mangled the evidence itself: a belief
       citing "Python is your stack" rendered "because python…", and a RETIRE citation naming a person renamed
       them. The evidence is quoted material; only the FRAMING word the spine itself adds may be adjusted. So we
       de-capitalize exactly one thing: a leading sentence-starter pronoun in an UNQUOTED citation. Any citation
       carrying a quote is passed through untouched, and every proper noun survives. */
    if (STARTER.test(s) && s.indexOf('“') < 0 && s.indexOf('"') < 0) s = s.charAt(0).toLowerCase() + s.slice(1);
    return 'because ' + s;
  }

  return {
    score, pick, whyLine, citable, rank, slotKindOf, asksBudget, strengthDamp, qualityDamp, preferenceTerm,
    bandOf, sameBand,
    PRIORITY: PRIORITY.slice(), SLOT_KIND: Object.assign({}, SLOT_KIND),
    BANDS: BANDS.map(b => b.slice()), BASE: Object.assign({}, BASE), BAND_STEP, RANK_STEP, BAND_GAP_MIN,
    VOI_MAX, SESSION_ASK_MAX, MOD_CAP, STRENGTH_MAX, STRENGTH_FLOOR, QUALITY_MAX, QUALITY_FLOOR, QUALITY_CAP,
    PREF_MAX, PREF_RANGE
  };
});
