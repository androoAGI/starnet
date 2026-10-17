/* sidecar/runtimeinfo.js - safe, prompt-visible run identity.

   The host knows provider/model/run metadata, but the model only sees prompt text.
   This module exposes the harmless subset as a sanitized system-prompt block so
   the agent can answer basic operator questions without guessing. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).runtimeinfo = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function oneLine(v, fallback, max) {
    const s = (v == null ? '' : String(v))
      .replace(/[\x00-\x1f\x7f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return (s || fallback || 'unknown').slice(0, max || 120);
  }

  function listLine(values, maxItems) {
    const out = [];
    const seen = new Set();
    for (const v of Array.isArray(values) ? values : []) {
      const s = oneLine(v, '', 120);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      if (out.length >= (maxItems || 6)) break;
    }
    return out;
  }

  // "Today is Wednesday, September 30, 2026 (station clock; trust it over your own sense of the date)." or '' —
  // kept short: it rides every run's system prompt, which has a hard byte budget (test/payload.budget.test.js)
  function todayLine(now) {
    const t = Number(now);
    if (!Number.isFinite(t) || t <= 0) return '';
    try { return 'Today is ' + new Date(t).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + ' (station clock; trust it over your own sense of the date).'; } catch (_) { return ''; }
  }

  function runtimeIdentityBlock(o) {
    o = o || {};
    const provider = oneLine(o.provider, 'unknown', 80);
    const model = oneLine(o.model, 'unknown', 160);
    const surface = oneLine(o.surface, 'interactive', 40);
    const trigger = oneLine(o.trigger, 'directive', 40);
    const agentId = oneLine(o.agentId, 'agent', 80);
    const runId = oneLine(o.runId, 'pending', 120);
    const harness = oneLine(o.harness, 'unknown', 80);
    const app = oneLine(o.app, 'unknown', 40);
    const platform = oneLine(o.platform, (typeof process !== 'undefined' && process.platform) || 'unknown', 40);
    const fallbacks = listLine(o.fallbackModels, 6).filter(x => x !== model);
    const lines = [
      '[RUNTIME]',
      'StarNet app version at run start: ' + app,
      'StarNet harness build at run start: ' + harness,
      'Host OS platform: ' + platform,
      'Provider: ' + provider,
      'Requested model at run start: ' + model,
      'Agent id: ' + agentId,
      'Run id: ' + runId,
      'Surface: ' + surface,
      'Trigger: ' + trigger
    ];
    if (fallbacks.length) lines.push('Possible fallback models: ' + fallbacks.join(', '));
    // TODAY (2026-09-30): a model's own sense of the date is its training era — asked for "today's news" it searched a
    // year-old month. The station's clock is the truth; `now` is injected by the caller (this file never reads a clock).
    const today = todayLine(o.now);
    if (today) lines.push(today);
    lines.push('If the Commander asks what StarNet build, model, provider, platform, run, surface, or session you are using, answer from this block. For mutable harness state such as scheduler health, routines, connectors, or errors, call station.inspect. Do not guess or invent a CLI command.');
    return '\n\n' + lines.join('\n');
  }

  return { oneLine, runtimeIdentityBlock, todayLine };
});
