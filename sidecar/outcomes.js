/* AGENT OS — outcomes.js : THE TRACK RECORD (pure fold; run outcomes finally teach the user model).

   THE GAP THIS CLOSES (rec-system audit, 2026-08-28). The harness records, for every run, whether it finished
   and why it failed — and routed NONE of it back into what the station proposes. The insights fold was consumed
   by nothing but two widgets; a task shape the Commander failed at five times in a row looked identical to a
   proven one on every proactive surface. This module folds the run history into a bounded TRACK RECORD the
   evidence composer, the night-shift context pack and the quest ranker can consult.

   HONESTY LAWS (each inherited from a sibling engine):
   1. RAW COUNTS IN A HARD WINDOW, NEVER DECAYED WEIGHTS IN A CLAIM. A displayed line says "finished 6 of 7
      recent runs" — those must be literal countable runs (WINDOW_MS), because a decayed weight is not a number
      of runs and quoting one as a count would be the app asserting arithmetic the harness can't show. The
      smoothing lives only in successPrior(), which feeds a RANKER, not a sentence.
   2. SUPPORT BEFORE SPEECH. No key with fewer than MIN_SUPPORT completed attempts produces a line or a prior —
      two data points are an anecdote, not a record (the taskbrief patterns bar, ≥2 there, ≥3 here because these
      lines steer work selection).
   3. ONLY DECIDED RUNS COUNT. reason 'done' is success; error/max_iters/budget/refusal/empty are failures the
      harness itself named. 'cancelled' (the Commander's own hand) and 'clarifying' (a question, not an attempt)
      classify NOTHING — the same rule recqualitystore holds for its outcome folds. internal rows (harness
      self-talk) are excluded wholesale.
      THE COMMANDER'S VERDICT OUTRANKS THE HARNESS (2026-10-01): a 'done' run the Commander rated `miss` is a
      failure ('rated_missed') — finishing is not the same as landing, and a record that called rejected work
      "proven" would steer the station toward exactly what they disliked. fold() takes the verdicts as an
      injected map (opts.verdicts: runId -> 'great'|'ok'|'miss'); absent = the harness reason alone, as before.
   4. PURE + DETERMINISM-CLEAN: rows in, plain object out; `now` injected; no IO, no clock, no rng. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).outcomes = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WINDOW_MS = 30 * 86400000;   // the record's memory: a month of literal, countable runs
  const MIN_SUPPORT = 3;             // decided attempts before a key may speak or lean a ranker
  const PROVEN_RATE = 0.85;          // ≥ this → a "keeps working" line
  const FAILING_RATE = 0.34;         // ≤ this → a "keeps failing" line
  const LINE_CAP = 4;                // bounded prompt real estate (commander-context caps evidence anyway)
  const KEY_CAP = 200;               // fold safety ceiling on distinct keys
  const SUCCESS = { done: 1 };
  const FAILURE = { error: 1, max_iters: 1, budget: 1, refusal: 1, empty: 1 };

  const str = (v) => (v == null ? '' : String(v));
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const clip = (v, n) => str(v).replace(/\s+/g, ' ').trim().slice(0, n);

  // the run's execution LANE, from the workstream id convention (contextpack's internal-prefix vocabulary).
  function laneOf(streamId) {
    const s = str(streamId);
    if (s.indexOf('nightshift-') === 0) return 'night shift';
    if (s.indexOf('cron-') === 0) return 'scheduled';
    if (s.indexOf('workshop-') === 0) return 'workshop';
    if (s.indexOf('loop-') === 0) return 'loop';
    return 'interactive';
  }

  /* fold(rows, {now}) → { keys: { 'recipe:<id>'|'lane:<lane>'|'model:<model>': { label, kind, n, ok, fail,
     lastAt, failReasons } }, windowMs, decided }. Rows outside the window, internal rows and undecided
     reasons contribute nothing. */
  function fold(rows, opts) {
    const now = num(opts && opts.now);
    const verdicts = (opts && opts.verdicts && typeof opts.verdicts === 'object') ? opts.verdicts : null;
    const cut = now - WINDOW_MS;
    const keys = {};
    let decided = 0;
    const bump = (key, kind, label, ok, reason, ts) => {
      if (!key || (Object.keys(keys).length >= KEY_CAP && !keys[key])) return;
      const k = keys[key] || (keys[key] = { label: clip(label, 80), kind, n: 0, ok: 0, fail: 0, lastAt: 0, failReasons: {} });
      k.n += 1; if (ok) k.ok += 1; else { k.fail += 1; k.failReasons[reason] = (k.failReasons[reason] || 0) + 1; }
      if (ts > k.lastAt) { k.lastAt = ts; if (label) k.label = clip(label, 80); }
    };
    for (const r of (Array.isArray(rows) ? rows : [])) {
      if (!r || r.internal === true) continue;
      const ts = num(r.ts);
      if (!ts || ts < cut || (now && ts > now)) continue;
      let reason = str(r.reason);
      let ok = SUCCESS[reason] === 1;
      if (!ok && FAILURE[reason] !== 1) continue;   // cancelled/clarifying/unknown: not a decided attempt
      if (ok && verdicts && verdicts[str(r.runId)] === 'miss') { ok = false; reason = 'rated_missed'; }   // finished ≠ landed
      decided += 1;
      const lane = laneOf(r.streamId);
      bump('lane:' + lane, 'lane', lane, ok, reason, ts);
      const recipeId = str(r.recipeId);
      if (recipeId) bump('recipe:' + recipeId, 'recipe', str(r.title) || recipeId, ok, reason, ts);
      const model = str(r.model);
      if (model && model !== '(unknown)') bump('model:' + model, 'model', model, ok, reason, ts);
    }
    return { keys, windowMs: WINDOW_MS, decided };
  }

  function topFailReason(k) {
    let best = '', n = 0;
    for (const r of Object.keys(k.failReasons || {})) if (k.failReasons[r] > n) { n = k.failReasons[r]; best = r; }
    return best ? { reason: best, count: n } : null;
  }

  /* the notable patterns: supported keys whose rate is strong in either direction. `lane:interactive` never
     rates as FAILING on its own — an interactive failure is usually a conversation, not a work shape — but a
     proven interactive record may still speak. Sorted most-evidenced first. */
  function summary(record, opts) {
    const min = Math.max(1, num(opts && opts.minSupport) || MIN_SUPPORT);
    const out = [];
    const keys = record && record.keys ? record.keys : {};
    for (const key of Object.keys(keys)) {
      const k = keys[key];
      if (!k || k.n < min) continue;
      const rate = k.ok / k.n;
      const failing = rate <= FAILING_RATE && key !== 'lane:interactive';
      const proven = rate >= PROVEN_RATE;
      if (!failing && !proven) continue;
      out.push({ key, kind: k.kind, label: k.label, n: k.n, ok: k.ok, fail: k.fail, rate: Math.round(rate * 100) / 100, verdict: proven ? 'proven' : 'failing', topFail: failing ? topFailReason(k) : null });
    }
    return out.sort((a, b) => (b.n - a.n) || (a.key < b.key ? -1 : 1));
  }

  // the prompt lines — every number in them is a literal count from the window (law 1).
  function lines(record, opts) {
    const cap = Math.max(1, num(opts && opts.limit) || LINE_CAP);
    return summary(record, opts).slice(0, cap).map(p => {
      const what = p.kind === 'recipe' ? '"' + p.label + '" (recipe)' : p.kind === 'model' ? p.label + ' (model)' : p.label + ' runs';
      if (p.verdict === 'proven') return what + ' — finished clean ' + p.ok + ' of ' + p.n + ' recent runs';
      const tf = p.topFail ? ' (top failure: ' + p.topFail.reason + ' ×' + p.topFail.count + ')' : '';
      // "landed", not "finished": a run the Commander rated missed DID finish, it just didn't land
      return what + ' — only ' + p.ok + ' of ' + p.n + ' recent runs landed' + tf;
    });
  }

  /* the ranker's read: a Laplace-smoothed success rate for one key, or NULL under support — an absent prior
     must leave the caller's default untouched (never a fabricated 0.5, which would silently re-rank). */
  function successPrior(record, key, opts) {
    const min = Math.max(1, num(opts && opts.minSupport) || MIN_SUPPORT);
    const k = record && record.keys ? record.keys[str(key)] : null;
    if (!k || k.n < min) return null;
    return Math.round(((k.ok + 1) / (k.n + 2)) * 1000) / 1000;
  }

  return { WINDOW_MS, MIN_SUPPORT, PROVEN_RATE, FAILING_RATE, LINE_CAP, laneOf, fold, summary, lines, successPrior };
});
