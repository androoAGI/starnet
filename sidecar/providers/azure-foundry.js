/* Azure Foundry's OpenAI v1 wire. Deployment names are user-defined, not catalog model IDs. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.azureFoundry = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalizeEndpoint(value) {
    let url;
    try { url = new URL(String(value || '').trim()); }
    catch (_) { throw new Error('Azure Foundry requires a resource endpoint URL'); }
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
      throw new Error('Azure Foundry requires an HTTPS endpoint without credentials, query parameters, or fragments');
    }
    const path = url.pathname.replace(/\/+$/, '');
    if (!['', '/openai', '/openai/v1'].includes(path)) {
      throw new Error('Use the Azure resource endpoint or its /openai/v1 base URL, not a project, deployment, or completions URL');
    }
    return url.origin + '/openai/v1';
  }
  // A tiny inference request proves the actual deployment and credential; /models can list base models instead.
  async function validateDeployment({ fetch, baseUrl, key, model, signal }) {
    const endpoint = normalizeEndpoint(baseUrl);
    const deployment = String(model || '').trim();
    if (!deployment) throw new Error('Enter your Azure deployment name (not the base model name)');
    const response = await fetch(endpoint + '/chat/completions', {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', 'api-key': key },
      body: JSON.stringify({ model: deployment, messages: [{ role: 'user', content: 'Reply with OK.' }], max_completion_tokens: 16, stream: false })
    });
    if (!response.ok) {
      if (response.body) await response.body.cancel();
      throw new Error('Azure Foundry rejected the deployment check (HTTP ' + response.status + '). Check the endpoint, API key, deployment name, and deployment access.');
    }
    const result = await response.json();
    if (!Array.isArray(result.choices) || !result.choices.some(c => c && c.message && ((typeof c.message.content === 'string' && c.message.content.trim()) || (c.message.role === 'assistant' && c.finish_reason === 'length')))) {
      throw new Error('Azure Foundry did not return a valid completion; the deployment is not verified');
    }
    return { baseUrl: endpoint, model: deployment };
  }
  return { normalizeEndpoint, validateDeployment };
});
