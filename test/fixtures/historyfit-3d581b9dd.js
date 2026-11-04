'use strict';
// Frozen production fitting bodies from 3d581b9dd, before the shared HistoryFit extraction.
module.exports = function (CtxGauge, TurnMerge, Harness, stationModes) {
  const HISTORY_CAP = 120;
  const HISTORY_WIRE_MAX_BYTES = 1 << 20;
  function utf8Bytes(s) {
    s = String(s == null ? '' : s);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n++;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xDC00 && s.charCodeAt(i + 1) <= 0xDFFF) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  function fitHistoryBytes(messages, maxBytes) {
    const src = Array.isArray(messages) ? messages : [];
    const limit = Math.max(1, Number(maxBytes) || HISTORY_WIRE_MAX_BYTES);
    const kept = [];
    let used = 2;   // `[]`
    for (let i = src.length - 1; i >= 0; i--) {
      const bytes = utf8Bytes(JSON.stringify(src[i])) + (kept.length ? 1 : 0);   // comma between array items
      // The newest turn is sacred: the composer already bounds it below this byte budget. Older history is the
      // expendable part, and we keep a contiguous suffix so the model never sees a temporally disjoint thread.
      if (kept.length && used + bytes > limit) break;
      kept.unshift(src[i]); used += bytes;
    }
    return kept;
  }
  function contextEstimateMessages(messages) {
    const src = Array.isArray(messages) ? messages : [];
    const dialogue = (typeof CtxGauge !== 'undefined' && CtxGauge.estimateMessages) ? CtxGauge.estimateMessages(src) : 0;
    return Math.max(dialogue, Math.ceil(utf8Bytes(JSON.stringify(src)) / 2));
  }
  function fitHistoryTokens(messages, maxTokens) {
    const src = Array.isArray(messages) ? messages : [];
    const limit = Math.max(1, Number(maxTokens) || 1);
    const kept = [];
    let used = 0;
    for (let i = src.length - 1; i >= 0; i--) {
      const tokens = contextEstimateMessages([src[i]]);
      if (kept.length && used + tokens > limit) break;
      kept.unshift(src[i]); used += tokens;
    }
    return kept;
  }
  function endOnUserTurn(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const at = list.map(m => m && m.role).lastIndexOf('user');
    if (at < 0) return list;
    const out = list.slice(0, at + 1), target = out[at];
    if (typeof target.typedText === 'string') out[at] = Object.assign({}, target, { content: target.typedText });
    return out;
  }
  function historyWindowFrom(history) {
    if (!Array.isArray(history)) return [];
    // drop LOCAL markers that are records, not dialogue: the history-cap marker (truncated) and any system status
    // line (sys — e.g. an autosessions "routine ran, nothing to report" / "couldn't load the output" framing line).
    // These must NEVER be replayed to the model as prior turns (a frontend-authored string is not the agent's word).
    // …and the ⚠ error/stop rows COMMS writes when a run fails (error:true): the Commander keeps seeing the reason after a
    // reload, but the model must never be shown "Something went wrong…" as if it had said it (2026-10-11).
    const real = TurnMerge.windowRows(history, { window: stationModes.window });
    const turnCapped = real.length > HISTORY_CAP ? real.slice(-HISTORY_CAP) : real;
    return fitHistoryBytes(turnCapped, HISTORY_WIRE_MAX_BYTES);
  }
  function modelFitHistory(history, ws) {
    const base = historyWindowFrom(history);
    if (!ws || typeof Harness === 'undefined' || typeof CtxGauge === 'undefined') return base;
    let limit = 0, selectedModel = '';
    try {
      if (Harness.getModel) selectedModel = Harness.getModel() || '';
      if (Harness.contextLimitOf) limit = Harness.contextLimitOf(selectedModel);
    } catch (_) {}
    if (!limit) return base;   // unknown catalog => byte-safe only; never invent a token ceiling
    const reserve = Math.min(16000, Math.floor(limit / 2));
    let budget = Math.max(1, Math.floor(limit * 0.85) - reserve);
    let fitted = fitHistoryTokens(base, budget);
    // Once this conversation has a real calibrated projection, replace the conservative 16K reserve with its
    // measured overhead and fit again. Older turns yield; the newest Commander message remains sacred.
    try {
      const state = Harness.contextState && Harness.contextState(ws.agentId || 'agent', ws.id, fitted);
      // A settled conversation may have been measured on a model the Commander has since switched away from.
      // That old model's limit/projection cannot govern the next request; use it only when model identities match.
      if (state && (!state.model || state.model === selectedModel) && state.limit) limit = state.limit;
      if (state && (!state.model || state.model === selectedModel) && state.used > 0 && (state.measured || state.projected)) {
        const dialogue = contextEstimateMessages(fitted);
        const overhead = Math.max(0, state.used - dialogue);
        budget = Math.max(1, Math.floor(limit * 0.85) - overhead);
        fitted = fitHistoryTokens(base, budget);
      }
    } catch (_) {}
    return fitted;
  }
  return { utf8Bytes, fitHistoryBytes, contextEstimateMessages, fitHistoryTokens, endOnUserTurn, historyWindowFrom, modelFitHistory };
};
