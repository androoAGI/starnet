/* sidecar/providers/cache-ttl.js — THE CACHE TTL RESOLVER (W1.13 cache TTL plumbing, cost audit 2026-11-08).

   Prompt caching writes on one of two tiers (claude-api skill, shared/prompt-caching.md):
     cache_control {type:'ephemeral'}             5 minutes, the default                                        (:123)
     cache_control {type:'ephemeral', ttl:'1h'}   1 hour                                                         (:124)
   A write bills 1.25x input on the 5-minute tier and 2x on the 1-hour tier (:144). A 1-hour entry must come before any
   5-minute one (:172); a 1-hour marker followed by a 5-minute tail is the allowed order (:176). usage.cache_creation
   splits cache_creation_input_tokens by tier: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens } (:208).

   This file decides which tier a request ASKS for, and carries the split a response REPORTS. How a reported write is
   counted and priced per tier is cost.js (writeSplit / writeUnits); the rates are prices.js. Every Claude cache stamper
   asks here — anthropic.js breakpoints, and openrouter.js applyCacheControl, which the managed (credits) route uses
   too — and prices.js asks here which tier an unreported write may have been. Nothing else reads
   SKYNET_ANTHROPIC_CACHE_TTL (test/cache-ttl.invariant.test.js). Read per call: a change applies to the next request.

     unset, '5m', anything else  -> '5m'     every anchor on the 5-minute tier: the wire bodies from before this file,
                                             byte for byte (the kill switch, and the default until W3.6)
     '1h'                        -> '1h'     every anchor on the 1-hour tier (the 2026-07-31 opt-in; it now reaches the
                                             OpenRouter and managed routes too, which used to ignore it)
     'mixed'                     -> 'mixed'  STABLE anchors on the 1-hour tier: the tool catalogue, the system prompt,
                                             and the END OF HISTORY, the last block before the newest message's
                                             <run_context> note — the last bytes the conversation's NEXT message still
                                             shares after a human-paced gap. TAIL anchors (the newest messages) stay on
                                             5 minutes: the run re-reads them seconds later.
   Pure apart from reading process.env (lint-determinism). */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.cacheTtl = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MODES = ['5m', '1h', 'mixed'];
  const DEFAULT_MODE = '5m';   // W3.6 decides whether 'mixed' becomes the default; until then nothing changes unasked
  const known = m => MODES.indexOf(m) >= 0;

  // the switch, tolerant of garbage (a typo must never wedge a request): an unknown value is the default
  function mode(env) {
    try {
      const e = env || ((typeof process !== 'undefined' && process.env) ? process.env : {});
      const raw = String(e.SKYNET_ANTHROPIC_CACHE_TTL == null ? '' : e.SKYNET_ANTHROPIC_CACHE_TTL).trim().toLowerCase();
      return known(raw) ? raw : DEFAULT_MODE;
    } catch (_) { return DEFAULT_MODE; }
  }
  // the cache_control an anchor carries, a fresh object each time. kind: 'stable' (the tool catalogue, the system
  // prompt, the end of history) or 'tail' (the newest messages)
  function control(kind, m) {
    const md = known(m) ? m : mode();
    return (md === '1h' || (md === 'mixed' && kind === 'stable')) ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  }
  // only 'mixed' pins an anchor at the end of history; '5m' and '1h' keep every message anchor sliding, as before
  function anchorsHistory(m) { return (known(m) ? m : mode()) === 'mixed'; }
  // the dearest tier a request in this mode can write: what a write whose tier split went unreported is priced at
  function longestTier(m) { return (known(m) ? m : mode()) === '5m' ? '5m' : '1h'; }
  // usage.cache_creation as the provider reported it: the two documented counts, nothing else, never a made-up one
  // (a missing or non-numeric count stays missing; cost.js prices per tier only when both are there and add up)
  function reportedSplit(cc) {
    if (!cc || typeof cc !== 'object') return null;
    const out = {};
    for (const k of ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']) {
      if (typeof cc[k] === 'number' && Number.isFinite(cc[k]) && cc[k] >= 0) out[k] = cc[k];
    }
    return Object.keys(out).length ? out : null;
  }

  return { MODES, DEFAULT_MODE, mode, control, anchorsHistory, longestTier, reportedSplit };
});
