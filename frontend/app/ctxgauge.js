/* AGENT OS — ctxgauge.js : the CONTEXT-WINDOW gauge model. Pure + testable
   (UMD: a `CtxGauge` global in the browser, module.exports under node).

   Turns real numbers into a render-agnostic gauge state:
     - used  = how many tokens THIS CONVERSATION occupies in the model's window.
     - limit = the model's real max context length (OpenRouter catalog
               context_length).

   `used` has two honest provenances, and the gauge keeps them distinct:
     MEASURED  — the provider's reconciled prompt_tokens for a request this
                 conversation actually made (agent.cost.tokensIn). Exact.
     PROJECTED — harness overhead measured on a REAL request (system prompt +
                 tool schemas + server-side dressing) plus a char/4 estimate of
                 the dialogue this conversation would send next. Used when the
                 conversation on screen has not run a turn yet (a new session, a
                 session resumed from disk, or turns typed since the last reply).
                 Rendered with a leading "~" and reported as projected:true so
                 no caller can mistake it for a measurement.

   No fabricated values: with no limit AND no calibration there is nothing to
   project from, so the gauge reports known:false and the renderer shows a
   "calibrating" state — never a made-up percentage. This is the truthful-
   telemetry rule applied to context: the bar only ever asserts a fill that is
   either measured, or derived from a measurement and visibly marked as derived. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.CtxGauge = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WARN = 0.75;   // amber: context getting full
  const CRIT = 0.90;   // red: near the model's real ceiling → overflow / compaction risk

  // Rough per-message framing tokens. Mirrors sidecar/context.js MSG_OVERHEAD — the two estimators
  // MUST agree, because the calibrated overhead below is the difference between a real prompt_tokens
  // and this estimate of the same message array. A drift here shows up as a biased projection.
  const MSG_OVERHEAD = 4;

  function clampInt(n) {
    n = Number(n);
    if (!isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }

  // human token count: 850 → "850", 64000 → "64k", 1500000 → "1.5M".
  // NOTE: kept self-contained (not routed through U.tokens) because this UMD module is pure +
  // node-testable and must not depend on the browser-global U (util.js). U.tokens mirrors this exact
  // logic — they are the one canonical token format, just duplicated across the node/browser seam.
  function fmtTokens(n) {
    n = clampInt(n);
    if (n < 1000) return String(n);
    if (n < 1e6) {
      const k = n / 1000;
      return (k < 10 ? k.toFixed(1).replace(/\.0$/, '') : String(Math.round(k))) + 'k';
    }
    const m = n / 1e6;
    return (m < 10 ? m.toFixed(1).replace(/\.0$/, '') : String(Math.round(m))) + 'M';
  }

  /* char/4 token estimate — the SAME rule sidecar/context.js uses to decide compaction, duplicated
     across the node/browser seam for the same reason fmtTokens is. Counts tool-call arguments, not
     just content: in an agentic turn the arguments (a written file body) are routinely the largest
     thing on the wire, and undercounting them by 300x is a bug this project has already paid for. */
  function estimateTokens(text) {
    return Math.ceil(String(text == null ? '' : text).length / 4);
  }
  function estimateMessage(m) {
    let t = estimateTokens(m && m.content) + MSG_OVERHEAD;
    if (m && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) {
        const fn = (c && c.function) || {};
        t += estimateTokens(fn.name) + estimateTokens(fn.arguments) + MSG_OVERHEAD;
      }
    }
    return t;
  }
  function estimateMessages(messages) {
    if (!Array.isArray(messages)) return 0;
    let t = 0;
    for (const m of messages) t += estimateMessage(m);
    return t;
  }

  /* CALIBRATION — what makes a projection honest instead of invented.

     A request costs far more than the visible dialogue: the system prompt, every tool schema, and the
     sidecar's own dressing (manual / capabilities / skills / memory) ride along. On this station that
     overhead measured ~13k tokens against a two-line chat, so a browser-side estimate of the dialogue
     alone understates the truth by an order of magnitude and is worse than useless.

     It is directly observable, though: a request's real prompt_tokens MINUS our own estimate of the
     messages we put in it. That is a genuine per-model constant (the same system prompt and the same
     tool schemas ride every request), which is what makes it safe to remember and reuse.

     ⛔ Only fit it when the estimate came in AT OR BELOW the measurement. A measurement smaller than
     the transcript we sent does NOT mean the model's overhead is small — it means the sidecar folded
     older turns away before sending (context.js compacts at 0.65 of the window). That is a property of
     ONE long conversation, not of the model, and baking it into a per-model figure would understate
     every other chat on that model. Learn nothing from those and keep the last good fit; the
     conversation that was compacted is covered by its own baseline instead (see projectFromBaseline).
     Returns null when there is nothing trustworthy to learn. */
  function calibrate(measuredTokensIn, sentMessages) {
    return calibrateFromEstimate(measuredTokensIn, estimateMessages(sentMessages));
  }
  // Same fit, when the caller already estimated the array it sent (the harness records that estimate at
  // run.start and no longer holds the messages by the time the provider's usage comes back).
  function calibrateFromEstimate(measuredTokensIn, sentEstimate) {
    const measured = clampInt(measuredTokensIn);
    if (measured <= 0) return null;
    const est = clampInt(sentEstimate);
    if (est > measured) return null;   // compaction, not a small overhead — see above
    return { overhead: measured - est };
  }

  /* Project a conversation that has NO measurement of its own (a new session, or one resumed from disk):
     the model's learned overhead plus this transcript. */
  function projectFrom(cal, messages) {
    if (!cal) return 0;
    return clampInt(cal.overhead) + estimateMessages(messages);
  }

  /* Project a conversation that HAS been measured: start from that real reading of this exact
     transcript and add only our estimate of what has been said since. Strictly better than the
     model-level fit for any chat that has run once — the baseline already contains this conversation's
     real overhead AND whatever the sidecar compacted away, so neither has to be re-guessed. */
  function projectFromBaseline(baselineTokens, estimateAtBaseline, messages) {
    const grown = estimateMessages(messages) - clampInt(estimateAtBaseline);
    return clampInt(clampInt(baselineTokens) + grown);
  }

  // used = this conversation's occupancy; limit = the model's max context.
  // opts.measured === false  -> `used` is not a provider reading.
  // opts.projected === true  -> `used` is a calibrated projection (see above): a fill may be asserted,
  //                             but every label carries "~" and projected:true rides the snapshot.
  // Returns a pure, render-agnostic snapshot. level ∈ unknown | idle | ok | warn | crit.
  function compute(used, limit, opts) {
    opts = opts || {};
    const measured = opts.measured !== false;
    const projected = !measured && opts.projected === true;
    used = clampInt(used);
    limit = clampInt(limit);
    const known = (measured || projected) && limit > 0;
    let frac = 0;
    if (known) { frac = used / limit; if (frac > 1) frac = 1; if (frac < 0) frac = 0; }
    const pct = Math.round(frac * 100);
    let level;
    if (!known) level = 'unknown';
    else if (used === 0) level = 'idle';
    else if (frac >= CRIT) level = 'crit';
    else if (frac >= WARN) level = 'warn';
    else level = 'ok';
    const tilde = projected ? '~' : '';
    return {
      known, measured, projected, used, limit, frac, pct, level,
      label: known ? (tilde + fmtTokens(used) + ' / ' + fmtTokens(limit))
        : (limit ? ('-- / ' + fmtTokens(limit)) : (used ? fmtTokens(used) : '--')),
      pctLabel: known ? (tilde + pct + '%') : '—'
    };
  }

  return { compute, fmtTokens, estimateTokens, estimateMessages, calibrate, calibrateFromEstimate, projectFrom, projectFromBaseline, WARN, CRIT, MSG_OVERHEAD };
});
