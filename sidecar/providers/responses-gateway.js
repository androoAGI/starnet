'use strict';
// Reuse the established Responses stream/tool decoder. Only the authenticated
// gateway's model catalogue differs from ChatGPT's account catalogue.
const { makeCodexProvider } = require('./codex');
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
function makeResponsesGatewayProvider(opts) {
  const base = String(opts.baseUrl || 'http://127.0.0.1:8781/v1').replace(/\/$/, '');
  const fetcher = opts.fetch || globalThis.fetch;
  const engine = makeCodexProvider({ fetch: fetcher, token: opts.key, baseUrl: base, reasoningEffort: opts.reasoningEffort,
    normalizeReasoningEffort: value => {
      const effort = String(value || 'medium').toLowerCase();
      if (!EFFORTS.includes(effort)) throw new Error('Unsupported Responses gateway reasoning effort');
      return effort;
    }
  });
  let models = [];
  return {
    ...engine,
    async listModels() {
      const res = await fetcher(base + '/models', { headers: { Authorization: 'Bearer ' + opts.key }, signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!res.ok) throw new Error('Responses gateway model access failed (' + res.status + ')');
      const body = await res.json();
      if (!body || !Array.isArray(body.data)) throw new Error('Responses gateway returned an invalid model catalogue');
      models = body.data.filter(m => m && m.available !== false && typeof m.id === 'string' && m.id.trim()).map(m => ({
        id: m.id, displayName: m.id, supportsTools: m.supports_tools !== false, pricing: null,
        reasoningEfforts: Array.isArray(m.allowed_reasoning_efforts) ? m.allowed_reasoning_efforts.filter(e => EFFORTS.includes(e)) : [],
        defaultReasoningLevel: EFFORTS.includes(m.default_reasoning_effort) ? m.default_reasoning_effort : 'medium',
        recommended: m.recommended === true
      }));
      return models;
    },
    // Conservative local prompt budget, not a claim about provider context size.
    contextLimit: () => 32000,
    reasoningEfforts: id => models.find(m => m.id === id)?.reasoningEfforts || ['medium'],
    supportsTools: id => models.find(m => m.id === id)?.supportsTools !== false
  };
}
module.exports = { makeResponsesGatewayProvider };
