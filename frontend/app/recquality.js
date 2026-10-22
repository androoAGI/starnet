/* AGENT OS — recquality.js : THE RECOMMENDATION QUALITY LOOP (pure, node-testable, zero DOM / zero fetch / zero clock).

   The spine (recommend.js) decides WHO speaks: one voice, evidence or silence. It answers "can this offer cite?"
   — a yes/no. This module answers the two questions that come after:

     1. HOW STRONG is that citation?  A pain corroborated twice this week is not the same evidence as a one-off
        remark from three weeks ago, and the station should not present them as if they were. `strength` is a
        0..1 read over evidence the station ALREADY holds (dimension confidence, belief freshness, a real repeat
        counter) — never a fabricated certainty. recommend.js turns it into a bounded WITHIN-TIER discount, so
        weak evidence speaks later, never louder. Absent state → null → neutral (no discount at all).

     2. IS THE BELIEF STILL TRUE?  A belief that is old AND thinly corroborated may not be ASSERTED in an offer
        ("because you said X") — but it is a perfectly good QUESTION ("still true that X?"). `staleness()` is
        that read. Stale memory becomes a source of good questions instead of confident bad recommendations.

   And it carries the arithmetic of the outcome loop (Q2): a per-channel EWMA quality weight that starts NEUTRAL
   and moves only on real, attributed outcomes, floored so quality alone can never silence a channel.

   Everything here is a pure function of state that already persists. The clock is INJECTED (`now`) exactly like
   understanding.js — it reads no clock and no randomness of its own — so staleness is deterministic and a node
   test can fast-forward time. The live wiring (browser storage, the bus, the attribution stamps) lives in
   recqualitystore.js. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RecQuality = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;

  /* ── EVIDENCE STRENGTH ──────────────────────────────────────────────────────────────────────────────────
     Strength is a 0..1 READ, never a score the station invents. Every producer below returns `null` when the
     state it reads is absent — and null means NEUTRAL everywhere downstream (recommend.js applies no discount).
     A cold station therefore ranks on pure priority, exactly as it did before this module existed. */

  /* NULL IS NOT ZERO (fixed 2026-08-04). `Number(null)`, `Number('')` and `Number(false)` are all a perfectly
     finite 0, so an explicit `conf: null` used to read as CONFIDENCE ZERO — which marked the belief stale and
     asked the Commander to re-confirm it — while an ABSENT conf correctly failed open to neutral. The same
     unreadable state has to fail open the same way whichever shape it arrives in.
     ALLOWLIST, NOT DENYLIST (2026-08-04). Listing the bad shapes ('' / null / boolean) still let `' '`, `[]` and
     `[0]` through as a hard 0 — the identical bug one shape further out. Only a real finite number, or a string
     that actually spells one, is a reading. Kept byte-identical to recommend.js reading(); duplicated rather than
     shared because this module is pure and imports nothing. */
  function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') { const t = v.trim(); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : null; }
    return null;   // null / undefined / boolean / array / object / Date → no reading at all
  }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  // the confidence the understanding engine already computes for a dimension. This is the right strength for a
  // candidate that ASSERTS something about that dimension. It is deliberately NOT used for a candidate that ASKS
  // about one (curiosity): a blank dim is weak evidence for an assertion and a HIGH-value question — that is what
  // recommend.js's VOI term is for, and the two must never be confused.
  function dimStrength(uRead, dim) {
    const dims = uRead && uRead.dims;
    const d = dims && dim && dims[dim];
    if (!d) return null;                                  // no read / unknown dim → neutral, never fabricated
    const c = num(d.conf);
    return c == null ? null : clamp01(c);
  }

  /* a repeat counter's strength — the "corroborated twice beats a one-off" law, saturating. A seed shape seen
     once is real but thin; by ~4 repeats it is as strong as this signal gets. 1→0.39, 2→0.63, 3→0.78, 5→0.92.
     A count of 0 (or unusable) is NOT strength 0 — it is no reading at all → neutral. */
  const COUNT_SAT = 2;
  function countStrength(n) {
    const v = num(n);
    if (v == null || v <= 0) return null;
    return clamp01(1 - Math.exp(-v / COUNT_SAT));
  }

  /* a cited BELIEF's own strength: how fresh it still is, tempered by how well the dimension holding it is
     corroborated. Freshness mirrors understanding.js exactly (60-day half-life; a PINNED belief is Commander-
     asserted-durable and never decays; an undatable belief is treated as fresh — unknown age is not evidence of
     staleness). When the dim confidence is unavailable the freshness alone is the reading. */
  const HALF_LIFE_MS = 60 * DAY_MS;
  function freshness(belief, now) {
    if (!belief || belief.pinned) return 1;
    const t = num(belief.updatedAt) || num(belief.observedAt) || num(belief.createdAt);
    const at = num(now);
    if (!t || t <= 0 || at == null || at <= 0 || at <= t) return 1;   // undatable / future-dated → fresh
    return clamp01(Math.pow(0.5, (at - t) / HALF_LIFE_MS));
  }
  /* FRESHNESS IS THE TRUNK; CORROBORATION ONLY MODULATES IT (reshaped 2026-08-04).
     This was the MEAN of the two readings, under a comment claiming "a well-understood dimension cannot rescue a
     belief the Commander last touched a season ago". The mean does not enforce that: a FIVE-YEAR-OLD belief in a
     0.9-confidence dimension still measured 0.45 — a middling score for a citation with no life left in it — and
     the mean's floor means age can never take the reading below 0.5 at all. Documenting that as a law the code
     did not have would have been the app asserting something it cannot prove, so the CURVE was fixed instead of
     the comment: this module exists to serve "stale asks, fresh asserts", and a shape where age cannot dominate
     cannot serve it.
     Now: strength = freshness × (0.5 + confidence/2). Confidence lives in [0.5 .. 1] as a MULTIPLIER, so it can
     only ever discount freshness — never manufacture it — which is the same law strength obeys everywhere else
     (weak evidence subtracts; strong evidence is not a bonus). The live finding that produced the mean survives
     exactly: a FRESH belief in a dimension reading conf 0 still scores 0.5, never 0, because the confidence read
     is a lagging aggregate and a seed-weighted belief scores 0 by design. Strength is a soft ordering signal. */
  function beliefStrength(belief, now, uRead, dim) {
    if (!belief) return null;
    const f = clamp01(freshness(belief, now));
    const c = dimStrength(uRead, dim);
    if (c == null) return f;                       // no confidence read → freshness alone is the reading
    return clamp01(f * (0.5 + clamp01(c) / 2));
  }

  /* ── STALENESS: a belief this old and this thin may be ASKED about, never ASSERTED ───────────────────────
     Two conditions, both required, because either alone is a false positive:
       · OLD          — untouched for STALE_DAYS. Age alone is not doubt: a well-corroborated belief stays true.
       · UNDER-CONFIRMED — the dimension holding it reads below STALE_CONF (just under a single fresh authored
                        belief, ≈0.51 in understanding.js), i.e. nothing since has corroborated it.
     A PINNED belief is never stale — the Commander pinned it as durable truth and the station does not
     second-guess that. An UNDATABLE belief is never stale either: unknown age is not evidence (fail-open to
     "fresh", the same law understanding.js's freshness() follows). No clock is read here — `now` is injected,
     and an absent `now` yields `stale:false` rather than a guess. */
  const STALE_DAYS = 21;
  const STALE_CONF = 0.55;
  function staleness(belief, now, uRead, dim) {
    const at = num(now), t = belief ? (num(belief.updatedAt) || num(belief.observedAt) || num(belief.createdAt)) : null;
    const out = { ageDays: null, conf: dimStrength(uRead, dim), pinned: !!(belief && belief.pinned), stale: false };
    if (!belief || out.pinned || !t || t <= 0 || at == null || at <= 0) return out;
    out.ageDays = Math.max(0, (at - t) / DAY_MS);
    out.stale = out.ageDays >= STALE_DAYS && out.conf != null && out.conf < STALE_CONF;
    return out;
  }

  /* a stable fingerprint for a belief RE-CONFIRM, so a denied "still true?" question is never re-asked until the
     belief itself changes — the same discipline (and the same token rule) as goalstore.js's offered set. */
  function beliefFingerprint(dim, belief) {
    if (!belief) return '';
    const toks = String(belief.text == null ? '' : belief.text).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    return String(dim || '') + ':' + String(belief.id || '') + '|' + Array.from(new Set(toks)).sort().join(' ');
  }

  /* ── THE OUTCOME LOOP'S ARITHMETIC (Q2) ─────────────────────────────────────────────────────────────────
     One channel-quality weight, an EWMA over the outcomes its ACCEPTED offers actually produced.

       start NEUTRAL (1) — a channel is never presumed good or bad; it has to earn either.
       FLOOR (0.5)       — quality alone can NEVER silence a channel. A dud channel gets structurally quieter and
                           still speaks when nothing better is on the table. Silencing is the job of the per-channel
                           caps and the Commander's own declines, never of a number the station computed.
       CAP (1.25)        — a proven channel earns a small edge, bounded well inside one priority tier (recommend.js
                           converts this whole range into a ±small WITHIN-TIER term), so no amount of good history
                           lets a gentle nudge outrank a turn-in. Priority order remains the spine's law.
       ALPHA (0.25)      — ~4 outcomes to substantially re-rate a channel: responsive, but one bad day is not a verdict. */
  const Q_START = 1, Q_FLOOR = 0.5, Q_CAP = 1.25, Q_ALPHA = 0.25;
  // the outcome vocabulary. Each verdict names the target the weight moves TOWARD — never a raw delta, so the
  // weight is always a bounded blend of real outcomes rather than an unbounded running total.
  const OUTCOME = {
    great: Q_CAP,        // 👍 on work this offer spawned — the offer was worth making
    completed: 1.05,     // the spawned work ran to a clean finish, unrated — weak positive, honestly weak
    ok: 0.95,            // 👌 — a shrug is very slightly below neutral, not a punishment
    engaged: 1.1,        // accepted where no trackable work is spawned (a kept belief, an answered question)
    deferred: 0.9,       // "not now" — a real signal about timing, the mildest negative we record
    declined: 0.75,      // "no" / "never" — the Commander did not want this
    miss: Q_FLOOR,       // 👎 on the work this offer spawned — the strongest honest negative there is
    abandoned: 0.85      // accepted, then the spawned work never ran / never finished (only when provable)
  };
  function isOutcome(verdict) { return Object.prototype.hasOwnProperty.call(OUTCOME, String(verdict || '')); }
  function clampQuality(w) {
    const v = num(w);
    if (v == null) return Q_START;
    return v < Q_FLOOR ? Q_FLOOR : v > Q_CAP ? Q_CAP : v;
  }
  // fold ONE outcome into a weight. Unknown verdict → the weight is returned untouched: the loop only ever moves
  // on an outcome it can name, so an unrecognised signal can never quietly re-rate a channel.
  function fold(weight, verdict) {
    const w = clampQuality(weight);
    if (!isOutcome(verdict)) return w;
    return clampQuality(w + Q_ALPHA * (OUTCOME[String(verdict)] - w));
  }

  return {
    dimStrength, countStrength, beliefStrength, freshness, staleness, beliefFingerprint,
    fold, clampQuality, isOutcome,
    DAY_MS, COUNT_SAT, HALF_LIFE_MS, STALE_DAYS, STALE_CONF,
    Q_START, Q_FLOOR, Q_CAP, Q_ALPHA, OUTCOME: Object.assign({}, OUTCOME)
  };
});
