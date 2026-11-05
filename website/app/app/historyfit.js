/* One shared history fit for the page and station. The five original fitting bodies are preserved (test/fixtures/historyfit-3d581b9dd.js
   holds them frozen); what moved is the line a token fit may fill: the server's fold line when the model row publishes it (ONE
   BUDGET AUTHORITY, below), the former share of the model's window when it does not. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ctxgauge.js'), require('./turnmerge.js'));
  else root.HistoryFit = factory(root.CtxGauge, root.TurnMerge);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CtxGauge, TurnMerge) {
  'use strict';
  // 120 ROWS of page history (user and assistant alike); what a long chat drops is carried by the earlier-conversation note and the persisted summary (chat.js HISTORY CAP)
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
    // the last turn the Commander started: a note that steered a run (a window's user '[steering] …' message, kind 'steer') is not one,
    // or a retry would end on the replaced attempt's note instead of on the directive it re-runs
    const at = list.map(m => m && m.role === 'user' && m.kind !== 'steer' ? 'user' : '').lastIndexOf('user');
    if (at < 0) return list;
    const out = list.slice(0, at + 1), target = out[at];
    if (typeof target.typedText === 'string') out[at] = Object.assign({}, target, { content: target.typedText });
    return out;
  }

  function windowRows(history, options) {
    if (!Array.isArray(history)) return [];
    const real = TurnMerge.windowRows(history, options || {});
    const capped = real.length > HISTORY_CAP ? real.slice(-HISTORY_CAP) : real;
    return fitHistoryBytes(capped, HISTORY_WIRE_MAX_BYTES);
  }
  /* ONE BUDGET AUTHORITY (context-budget-and-fold). The server folds a run once its prompt passes compactAt of the window the run
     works in, and publishes both on every model row (/api/models: runWindow, compactAt; context.js RUN_CONTEXT_DEFAULTS is the one
     place the share lives). A fit to that same line means a fitted send is never already past the fold, so a long chat stops paying
     for a fold on every send: the dialogue the line leaves out is carried by the persisted summary or the free earlier note.
     A row that publishes no compactAt (an older sidecar) keeps the former fit, LEGACY_FIT_SHARE of the model's own window: that
     is the fallback for a missing fact, not a second fold line, and test/historyfit.gate.test.js holds it against the frozen
     3d581b9dd bodies. */
  const LEGACY_FIT_SHARE = 0.85;
  function foldShare(compactAt) {
    const share = Number(compactAt);
    return share > 0 && share <= 1 ? share : 0;   // a share of the window: anything else is no published fold line
  }
  // the window a RUN works in: a row's runWindow (the model's window stopped at a long-context price tier) can only lower the model's own
  function runWindowOf(m, limit) {
    const run = Number(m && m.runWindow);
    return run > 0 && run < limit ? run : limit;
  }
  // `limit` is the window the share applies to: the run's window when compactAt is given (the sidecar's own limitOf already stops at
  // the tier), the model's own window for the former fit. The reserve stands for the system prompt and tool schemas of an unmeasured chat.
  function uncalibratedBudget(limit, compactAt) {
    return Math.max(1, Math.floor(limit * (foldShare(compactAt) || LEGACY_FIT_SHARE)) - Math.min(16000, Math.floor(limit / 2)));
  }
  // state is measured against the preliminary fit, exactly as the former page owner did.
  // Reading that state stays in the page; this module receives only the observed model data.
  function fitModel(history, model) {
    const m = model || {}, base = windowRows(history, { window: m.window || 'legacy' });
    let limit = Number(m.limit) || 0;
    if (!(limit > 0)) return { messages: base, budget: null };
    const share = foldShare(m.compactAt), windowFor = size => share ? runWindowOf(m, size) : size;
    let budget = uncalibratedBudget(windowFor(limit), share), fitted = fitHistoryTokens(base, budget);
    const state = m.state;
    if (state && (!state.model || state.model === m.selected) && state.limit) limit = state.limit;
    if (state && (!state.model || state.model === m.selected) && state.used > 0 && (state.measured || state.projected)) {
      // the measured overhead already holds the system prompt and tool schemas (state.used minus the dialogue it carried): it is
      // the only thing taken off the line, never the unmeasured reserve besides
      const dialogue = contextEstimateMessages(fitted), overhead = Math.max(0, state.used - dialogue);
      budget = Math.max(1, Math.floor(windowFor(limit) * (share || LEGACY_FIT_SHARE)) - overhead);
      fitted = fitHistoryTokens(base, budget);
    }
    return { messages: fitted, budget };
  }
  function capsOf(identity) {
    const value = identity && identity.identity || identity;
    const caps = value && value.caps;
    if (!value || !Number.isFinite(value.v) || value.v < 2 || !caps || !['shadow', 'id'].includes(caps.window)) return null;
    return { v: value.v, window: caps.window, windowRequired: caps.windowRequired === true };
  }
  function hasForeign(rows, streamId) {
    return (Array.isArray(rows) ? rows : []).some(row => row && row.streamId && row.streamId !== streamId);
  }
  function skipWait(ws, caps, options) {
    return !!(ws && caps && Number.isFinite(caps.v) && caps.v >= 2 && caps.window === 'id' &&
      !(options && options.recovery) && !hasForeign(ws.history, ws.id));
  }
  function stationWindowFallback(ws, caps) {
    return !!(ws && caps && Number.isFinite(caps.v) && caps.v >= 2 && caps.windowRequired === true &&
      ['shadow', 'id'].includes(caps.window) && !hasForeign(ws.history, ws.id));
  }
  function sendPlan(rows, options) {
    const o = options || {}, fitted = fitModel(rows, o.model);
    let messages = o.retry ? endOnUserTurn(fitted.messages) : fitted.messages;
    const post = o.recovery ? {} : Object.assign({}, o.ids || {});
    if (!o.recovery) {
      if (Number.isFinite(fitted.budget)) post.windowTokens = fitted.budget;
      if (o.historyRead && (o.historyRead.degraded || o.historyRead.skipped)) post.windowFrom = 'station';
      if (o.historyRead && o.historyRead.degraded) {
        const newest = [...messages].reverse().find(row => row && row.role === 'user');
        messages = messages.filter(row => row && row.role === 'system').concat(newest ? [newest] : []);
      }
    }
    return { messages, post };
  }
  return { HISTORY_CAP, HISTORY_WIRE_MAX_BYTES, utf8Bytes, fitHistoryBytes, fitHistoryTokens, contextEstimateMessages,
    endOnUserTurn, windowRows, uncalibratedBudget, fitModel, capsOf, hasForeign, skipWait, stationWindowFallback, sendPlan };
});
