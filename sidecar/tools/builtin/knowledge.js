/* sidecar/tools/builtin/knowledge.js — `knowledge_search`: look up a configured local knowledge base.

   WHY THIS EXISTS. A station can now run RAGFlow (github.com/infiniflow/ragflow) as a local Dockerized
   retrieval engine — the Commander uploads documents into a RAGFlow dataset through RAGFlow's own web UI,
   and an agent should be able to ask it a question and get back the relevant passages. This is NOT the
   agent's private notebook (that is per-agent, sandboxed, capId 'memory') and NOT the public internet
   (that is `web_search`/`web_fetch`, capId 'web' on the DISH) — it is a Commander-curated, shared document
   store the station was pointed at. A new capId, 'knowledge', keeps it independently toggleable from both.

   READ-ONLY, NO CONSENT: this only queries an existing dataset and returns text — it writes nothing, spends
   no file-system authority, and the underlying RAGFlow call is unauthenticated-by-us (the API key is the
   station's own configured credential, never the agent's to see or set). Same posture as recall_conversation.

   THE CLIENT IS INJECTED, not rebuilt here (index.js wires `ragClient` from RAGFLOW_API_URL /
   RAGFLOW_API_KEY / RAGFLOW_DATASET_IDS so the tool file owns zero network config). With no client
   configured the tool says so honestly rather than pretending the knowledge base is simply empty.

   Verified against a real local RAGFlow v1.0.0-rc1 instance (docker/.env SVR_HTTP_PORT=9380):
     POST {base}/api/v1/retrieval
       headers: Authorization: Bearer <api_key>
       body:    { dataset_ids: string[], question: string }
       200 ok:  { code: 0, data: { chunks: [...], doc_aggs: [...], total } }
   (internal/router/router.go:331 -> DatasetsHandler.SearchDatasets; internal/service/dataset_types.go:39-64
   for the full request shape; internal/handler/dataset.go:1075-1146 for validation/response wiring.)

   makeKnowledgeTools({ ragClient, defaultDatasetIds? }) -> { searchTool, register(reg), _internals }
     ragClient.search({ question, datasetIds, topK? }) -> { ok, chunks: [{content, docName, similarity}], reason? } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).knowledge = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SEARCH_TIMEOUT_MS = 20000;
  const MAX_QUESTION = 2000;
  const MAX_CHARS = 8000;   // a tool result is re-read by the model every turn — stay cheap

  const str = v => String(v == null ? '' : v).trim();

  // Same abort-on-timeout-or-parent-cancel shape as web.js's withTimeout (sidecar/tools/builtin/web.js) —
  // duplicated here, not imported, so this file stays self-contained like voice.js/resolve.js.
  function withTimeout(promiseFactory, ms, parent) {
    const ctrl = new AbortController();
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      const reason = new Error('request timed out after ' + ms + 'ms');
      reason.__timeout = true;
      try { ctrl.abort(reason); } catch (_) { ctrl.abort(); }
    }, ms);
    if (parent) {
      if (parent.aborted) { try { ctrl.abort(parent.reason); } catch (_) { ctrl.abort(); } }
      else { try { parent.addEventListener('abort', () => { try { ctrl.abort(parent.reason); } catch (_) { ctrl.abort(); } }, { once: true }); } catch (_) {} }
    }
    return Promise.resolve(promiseFactory(ctrl.signal)).catch(e => {
      if (timedOut) {
        const reason = new Error('request timed out after ' + ms + 'ms');
        reason.__timeout = true;
        throw reason;
      }
      throw e;
    }).finally(() => clearTimeout(t));
  }

  // The real RAGFlow HTTP client. A thin, honest wrapper: no retries, no caching, no guessed defaults
  // beyond what RAGFlow itself defaults (topK -> RAGFlow's own knn_top_k default of 1024).
  function makeRagflowClient({ baseUrl, apiKey, fetchImpl }) {
    const base = str(baseUrl).replace(/\/+$/, '');
    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!base || !apiKey || !doFetch) return null;

    return {
      async search({ question, datasetIds, topK, signal }) {
        const ids = Array.isArray(datasetIds) ? datasetIds.filter(Boolean) : [];
        if (!ids.length) return { ok: false, reason: 'no dataset_ids configured for this station' };
        const body = { dataset_ids: ids, question: str(question) };
        if (topK) body.top_k = topK;

        let res;
        try {
          res = await withTimeout(signal2 => doFetch(base + '/api/v1/retrieval', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
            body: JSON.stringify(body),
            signal: signal2
          }), SEARCH_TIMEOUT_MS, signal);
        } catch (e) {
          return { ok: false, reason: e && e.__timeout ? 'RAGFlow request timed out' : ('RAGFlow request failed: ' + str(e && e.message)) };
        }

        let json;
        try { json = await res.json(); } catch (_) { json = null; }
        if (!res.ok || !json || json.code !== 0) {
          const msg = (json && (json.message || json.data)) || (res.status + ' ' + res.statusText);
          return { ok: false, reason: 'RAGFlow returned an error: ' + str(msg) };
        }

        const data = json.data || {};
        const chunks = Array.isArray(data.chunks) ? data.chunks.map(c => ({
          content: str(c.content || c.content_with_weight),
          docName: str(c.document_keyword || c.docnm_kwd || c.doc_name),
          similarity: typeof c.similarity === 'number' ? c.similarity : null
        })) : [];
        return { ok: true, chunks, total: typeof data.total === 'number' ? data.total : chunks.length };
      }
    };
  }

  function makeKnowledgeTools(deps) {
    deps = deps || {};
    const client = deps.ragClient || null;
    const defaultDatasetIds = Array.isArray(deps.defaultDatasetIds) ? deps.defaultDatasetIds.filter(Boolean) : [];

    const searchTool = {
      name: 'knowledge_search', capability: 'knowledge', scope: 'read', requiresConsent: false, network: true, timeoutMs: SEARCH_TIMEOUT_MS + 5000,
      description: 'Search the station\'s configured local knowledge base (RAGFlow) for passages relevant to a '
        + 'question. This is the Commander\'s own curated documents — NOT the public internet (use web_search for '
        + 'that) and NOT your private notebook (use notebook.read for that). Returns the matching passages with '
        + 'their source document name, most relevant first. If no dataset is configured, or the station has no '
        + 'knowledge base wired up, this says so rather than returning a fake empty result.',
      schema: {
        type: 'object', required: ['question'], properties: {
          question: { type: 'string', description: 'what to look up, as a natural-language question' },
          dataset_ids: { type: 'array', items: { type: 'string' }, description: 'optional: specific RAGFlow dataset id(s) to search, overriding the station default' }
        }
      },
      run: async (args, ctx) => {
        args = args || {};
        const question = str(args.question).replace(/\s+/g, ' ');
        if (!question) throw new Error('question is required');
        if (question.length > MAX_QUESTION) {
          throw new Error('question is ' + question.length + ' characters; the cap is ' + MAX_QUESTION + '. Ask a narrower question.');
        }
        if (!client) throw new Error('this station has no RAGFlow knowledge base wired — knowledge_search cannot run here');

        const datasetIds = (Array.isArray(args.dataset_ids) && args.dataset_ids.length ? args.dataset_ids.map(str).filter(Boolean) : defaultDatasetIds);
        const r = await client.search({ question, datasetIds, signal: ctx && ctx.signal });
        if (!r || r.ok === false) {
          throw new Error('knowledge base search failed' + (r && r.reason ? ': ' + str(r.reason) : ''));
        }
        if (!r.chunks.length) {
          return { content: 'No matching passages found for: ' + question, summary: 'knowledge_search → 0 results' };
        }

        let out = 'Found ' + r.chunks.length + ' passage(s) for: ' + question + '\n\n';
        for (const c of r.chunks) {
          const line = '— ' + (c.docName ? '[' + c.docName + '] ' : '') + c.content + '\n\n';
          if (out.length + line.length > MAX_CHARS) break;
          out += line;
        }
        return { content: out.trim(), summary: 'knowledge_search → ' + r.chunks.length + ' result(s)' };
      }
    };

    return {
      searchTool: searchTool,
      register(reg) { reg.register(searchTool); return reg; },
      _internals: { makeRagflowClient }
    };
  }

  return { makeKnowledgeTools: makeKnowledgeTools, makeRagflowClient: makeRagflowClient };
});
