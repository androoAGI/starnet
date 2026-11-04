/* sidecar/providers/replay.js — a fake LLMProvider that yields HarnessEvents from a
   recorded fixture. ZERO network, ZERO spend. The linchpin of headless CI: it proves
   loop correctness, the event contract, determinism, and tool-result pairing without a
   real token. The real openrouter adapter (M2) implements the SAME interface, so it can
   never silently break the proven loop — the same fixtures gate CI forever.

   fixture = {
     turns:  [ HarnessEvent[], HarnessEvent[], ... ]   // one array per successive stream() call
     models: [{ id, context_length, max_completion_tokens, pricing, supportsTools }]
   }
   Each stream() call yields the next turn; once exhausted it yields a graceful stop. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.providers = root.SK.providers || {}).replay = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_MODELS = [{
    id: 'replay/model', context_length: 8000, max_completion_tokens: 4096,
    pricing: { prompt: '0.000001', completion: '0.000002' }, supportsTools: true
  }];

  function makeReplayProvider(fixture) {
    fixture = fixture || {};
    const turns = fixture.turns || [];
    const models = fixture.models || DEFAULT_MODELS;
    let cursor = 0, calls = 0;

    async function* stream(req) {
      calls++;
      const turn = cursor < turns.length ? turns[cursor++] : [{ type: 'done', finishReason: 'stop' }];
      for (const ev of turn) {
        if (req && req.signal && req.signal.aborted) return;
        yield ev;
      }
    }

    function listModels() { return models.map(m => Object.assign({}, m)); }
    function contextLimit(id) { const m = models.find(x => x.id === id); return m ? m.context_length : 8000; }
    // the catalog row's max output (provider.js outputLimit); 0 = the row names none
    function outputLimit(id) { const m = models.find(x => x.id === id); return (m && Number(m.max_completion_tokens)) || 0; }
    function priceOf(id) {
      const m = models.find(x => x.id === id);
      if (!m || !m.pricing) return null;
      const i = parseFloat(m.pricing.prompt) * 1e6, o = parseFloat(m.pricing.completion) * 1e6;
      return (isFinite(i) && isFinite(o)) ? { in: i, out: o } : null;
    }

    return { stream, listModels, verifyCredential: async () => ({ ok: false, status: 'unverified', credentialVerified: false, reachable: false, error: 'replay fixture has no remote credential' }),
      contextLimit, outputLimit, priceOf, callCount: () => calls, reset() { cursor = 0; calls = 0; } };
  }

  return { makeReplayProvider };
});
