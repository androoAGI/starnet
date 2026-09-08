/* Data-only sidecar bridge. No old client, renderer, or sprite dependencies.
 * Auth comes from the entry page. /api/save returns the document, not its disk wrapper.
 * Attended runs use NDJSON; background events use SSE. Only backend facts establish activity.
 */
(function (root, factory) {
  const Bridge = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = Bridge;
  else root.NextBridge = Bridge;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const active = r => ['working', 'waiting', 'unknown'].includes(r.status);
  const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
  function fail(message, code) { const e = new Error(message); e.code = code; return e; }
  class NextBridge {
    static create(options) { return new NextBridge(options); }
    constructor(options = {}) {
      this._fetch = options.fetch || (root.fetch && root.fetch.bind(root));
      this._EventSource = options.EventSource || root.EventSource;
      this._model = options.WorldModel || root.WorldModel;
      this._pipeline = options.Pipeline || root.Pipeline;
      this._token = options.token || root.__STARNET_API_TOKEN__ || '';
      this._clock = options.clock || Date.now;
      const page = new URL(options.pageUrl || (root.location && root.location.href) || 'http://localhost/');
      const base = new URL(options.baseUrl || root.__STARNET_API__ || '/', page);
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
          (base.origin !== page.origin && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
        throw fail('Sidecar must use the page origin or a loopback address.', 'origin');
      this._base = base.origin; this._owner = options.agentId || 'agent';
      if (!validId(this._owner)) throw fail('Invalid save owner.', 'agent');
      this._subs = new Set(); this._controllers = new Set(); this._pending = new Map();
      this._runs = new Map(); this._docs = new Map(); this._seen = new Set();
      this._saveQueue = Promise.resolve(); this._disposed = false; this._generation = 0;
      this._state = { connection: { status: 'idle', error: null, lastEventAt: null },
        station: null, roster: [], runtime: null, capabilities: {}, runs: [], conversations: {},
        prompts: [], summons: [], queues: [], events: [], save: { status: 'idle', error: null },
        routing: { status: 'unknown', error: null }, degraded: false, recovery: null };
      this._state.conversations = Object.create(null);
    }
    snapshot() { return clone(this._state); }
    subscribe(fn) {
      if (typeof fn !== 'function') throw new TypeError('Subscriber must be a function.');
      this._subs.add(fn); fn(this.snapshot()); return () => this._subs.delete(fn);
    }
    _publish() {
      if (this._disposed) return;
      this._state.runs = Array.from(this._runs.values()).slice(-150);
      for (const fn of this._subs) { try { fn(this.snapshot()); } catch (_) {} }
    }
    _assert() { if (this._disposed) throw fail('Bridge is disposed.', 'disposed'); }
    // Fetch-like JSON helper for additive panels; credentials can only reach this sidecar's /api routes.
    request(path, options = {}) {
      if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('\\')) return Promise.reject(fail('Request must target a sidecar /api route.', 'route'));
      const url = new URL(path, this._base);
      if (url.origin !== this._base || !url.pathname.startsWith('/api/')) return Promise.reject(fail('Request must target a sidecar /api route.', 'route'));
      const method = String(options.method || (options.body === undefined ? 'GET' : 'POST')).toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return Promise.reject(fail('Unsupported request method.', 'method'));
      let body = options.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { return Promise.reject(fail('Request body must be JSON.', 'body')); } }
      if (method === 'GET' && body !== undefined) return Promise.reject(fail('GET requests cannot have a body.', 'body'));
      return this._request(url.pathname + url.search, body, { method, text: !!options.text, signal: options.signal });
    }
    async _request(path, body, options = {}) {
      this._assert();
      if (!this._token) throw fail('This page has no sidecar authentication bootstrap. Reload the sidecar entry page.', 'bootstrap');
      if (typeof this._fetch !== 'function') throw fail('Fetch is unavailable.', 'transport');
      const controller = options.controller || new AbortController(); this._controllers.add(controller);
      const abort = () => controller.abort();
      if (options.signal) { if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true }); }
      try {
        const response = await this._fetch(this._base + path, {
          method: options.method || (body === undefined ? 'GET' : 'POST'), cache: 'no-store', redirect: 'error',
          headers: Object.assign({ 'X-StarNet-Token': this._token }, body === undefined ? {} : { 'Content-Type': 'application/json' }),
          body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal
        });
        this._assert();
        if (!response.ok && !(options.acceptStatus || []).includes(response.status)) throw fail('Sidecar request failed (' + response.status + '): ' + (await response.text()).slice(0, 300), 'http');
        if (options.stream) return response;
        const text = await response.text(); this._assert();
        if (options.text) return text;
        try { return JSON.parse(text); } catch (_) { throw fail('Sidecar returned invalid JSON.', 'protocol'); }
      } finally {
        if (!options.stream) this._controllers.delete(controller);
        if (options.signal) options.signal.removeEventListener('abort', abort);
      }
    }
    async start() {
      this._assert(); if (this._startPromise) return this._startPromise;
      this._state.connection = { status: 'connecting', error: null, lastEventAt: null }; this._publish();
      this._startPromise = (async () => {
        try {
          const [runtime, saved] = await Promise.all([
            this._request('/api/runtime/agent'), this._request('/api/save?agent=' + encodeURIComponent(this._owner))
          ]);
          if (!runtime || runtime.ok !== true || !Array.isArray(runtime.agents)) throw fail('Invalid runtime roster.', 'protocol');
          this._state.runtime = runtime; this._acceptSave(saved);
          this._state.roster = runtime.agents.filter(a => a && validId(a.agentId)).map(a => {
            const doc = this._docs.get(a.agentId); return Object.assign({}, doc && doc.agent, a, { id: a.agentId });
          });
          await this.refreshCapabilities(); await this._reconcile(); this._openEvents();
          this._timer = setInterval(() => {
            if (this._disposed) return;
            if (this._state.connection.lastEventAt && this._clock() - this._state.connection.lastEventAt > 60000) this._disconnected('Live event heartbeat expired.');
            this._reconcile().catch(e => this._disconnected(e.message));
          }, 30000);
          if (this._timer && this._timer.unref) this._timer.unref();
          this._publish(); return this.snapshot();
        } catch (e) {
          this._state.connection = { status: 'error', error: e.message, lastEventAt: null };
          this._publish(); this._startPromise = null; throw e;
        }
      })();
      return this._startPromise;
    }
    _acceptSave(result) {
      if (!result || !Object.prototype.hasOwnProperty.call(result, 'save')) throw fail('Invalid save response.', 'protocol');
      const doc = result.save;
      if (doc && (doc.schema !== 'starnet.save' || !doc.agent || doc.agent.id !== this._owner ||
          (doc.agentId && doc.agentId !== this._owner))) throw fail('Unrecognized save document or owner; refusing to replace it.', 'save-schema');
      this._saveDoc = clone(doc); this._state.station = clone(doc && doc.station);
      this._state.degraded = !!result.degraded; this._state.recovery = clone(result.recovery || null);
      this._state.save = { status: doc ? 'loaded' : 'empty', error: null, updatedAt: doc && doc.updatedAt };
      if (doc) {
        this._docs.set(doc.agent.id, doc);
        for (const a of doc.agents || []) if (a && validId(a.id)) this._docs.set(a.id, { agent: a, prov: doc.prov });
      }
    }
    _placements(agentId) {
      if (!this._state.station || !this._model || typeof this._model.deserialize !== 'function') return { known: false, placed: [], stationPlaced: [] };
      const station = this._model.deserialize(clone(this._state.station));
      const all = (station.doc().props || []).map(p => station.capForProp(p.t));
      const scoped = station.agentRoomId(agentId) ? station.bayObjects(agentId) : all;
      const normalize = values => Array.from(new Set(values.map(v => typeof v === 'object' && v ? v.objectType : v)
        .filter(v => v && v !== 'computer' && v !== 'connector'))).map(objectType => ({ objectType }));
      return { known: true, placed: normalize(scoped), stationPlaced: normalize(all) };
    }
    async refreshCapabilities() {
      const entries = await Promise.all(this._state.roster.map(async agent => {
        try {
          const placement = this._placements(agent.agentId);
          if (!placement.known) return [agent.agentId, { status: 'unknown', error: 'Station capability model is unavailable.' }];
          const query = '?agent=' + encodeURIComponent(agent.agentId) + '&placed=' + encodeURIComponent(placement.placed.map(p => p.objectType).join(','));
          const data = await this._request('/api/toolsets' + query);
          if (!data || !Array.isArray(data.toolsets) || !data.authority) throw fail('Invalid capability response.', 'protocol');
          return [agent.agentId, Object.assign({ status: 'loaded', placement }, data)];
        } catch (e) { return [agent.agentId, { status: 'error', error: e.message }]; }
      }));
      this._assert(); this._state.capabilities = Object.fromEntries(entries); this._publish(); return clone(this._state.capabilities);
    }
    async _reconcile() {
      const generation = this._generation;
      const data = await this._request('/api/state/snapshot');
      if (!data || !Array.isArray(data.runs)) throw fail('Invalid live-state snapshot.', 'protocol');
      // An event arriving during this request is newer than the snapshot; never erase it.
      if (generation !== this._generation) return;
      const ids = new Set(data.runs.map(r => r.runId));
      for (const run of this._runs.values()) if (active(run) && !ids.has(run.runId)) { run.status = 'ended'; run.reason = run.reason || 'outcome-unavailable'; }
      for (const row of data.runs) if (row && row.runId) {
        this._runs.set(row.runId, Object.assign({}, this._runs.get(row.runId), row, { status: 'working', observedAt: this._clock() }));
      }
      this._state.prompts = (data.prompts || []).map(p => Object.assign({}, this._state.prompts.find(x => x.promptId === p.promptId), p));
      for (const p of this._state.prompts) { const run = this._runs.get(p.runId); if (run) run.status = 'waiting'; }
      this._state.summons = data.summons || []; this._state.queues = data.queues || []; this._publish();
    }
    _openEvents() {
      if (!this._EventSource) { this._disconnected('Live event transport is unavailable.'); return; }
      const source = this._source = new this._EventSource(this._base + '/api/channels/events?token=' + encodeURIComponent(this._token));
      source.onopen = () => {
        if (this._disposed) return;
        this._state.connection = { status: 'connected', error: null, lastEventAt: this._clock() };
        this._reconcile().catch(e => this._disconnected(e.message)); this._publish();
      };
      source.onerror = () => this._disconnected('Live events disconnected; reconnecting.');
      source.onmessage = event => {
        if (this._disposed) return;
        this._state.connection = { status: 'connected', error: null, lastEventAt: this._clock() };
        try {
          const message = JSON.parse(event.data);
          if (message.stream === 'ready' && message.reset) this._reconcile().catch(e => this._disconnected(e.message));
          if (event.lastEventId && this._seen.has(event.lastEventId)) return;
          if (event.lastEventId) { this._seen.add(event.lastEventId); if (this._seen.size > 1000) this._seen.delete(this._seen.values().next().value); }
          if (message.name) this._event(message.name, message.payload || {}); else this._publish();
        } catch (_) { this._disconnected('Live event stream contained invalid data.'); }
      };
    }
    _disconnected(error) {
      if (this._disposed) return;
      this._state.connection.status = 'disconnected'; this._state.connection.error = error;
      for (const run of this._runs.values()) if (active(run)) run.status = 'unknown'; this._publish();
    }
    _event(name, payload) {
      this._generation++;
      const p = clone(payload), now = this._clock();
      this._state.events.push({ name, payload: p, at: now });
      if (this._state.events.length > 120) this._state.events.shift();
      let run = p.runId && this._runs.get(p.runId);
      if (name === 'agent.run.start' && p.runId) {
        run = Object.assign({}, run, p, { status: 'working', observedAt: now }); this._runs.set(p.runId, run);
      }
      if (run) {
        run.observedAt = now;
        if (name === 'agent.tool_call') { run.tool = p.name; run.status = 'working'; }
        if (name === 'agent.tool_result') { run.tool = null; run.lastTool = p; }
        if (name === 'agent.run.error') run.error = p.message;
        if (name === 'agent.cost') run.cost = p;
        if (name === 'agent.run.end') { run.status = 'ended'; run.reason = p.reason; run.result = p; run.tool = null; }
      }
      if (name === 'permission.prompt' && p.promptId) {
        this._state.prompts = this._state.prompts.filter(x => x.promptId !== p.promptId).concat(p); if (run) run.status = 'waiting';
      }
      if (name === 'permission.response') {
        const prompt = this._state.prompts.find(x => x.promptId === p.promptId);
        const resumed = prompt && this._runs.get(prompt.runId);
        if (resumed && resumed.status === 'waiting') resumed.status = 'working';
        this._state.prompts = this._state.prompts.filter(x => x.promptId !== p.promptId);
      }
      if (name === 'agent.run.end') this._state.prompts = this._state.prompts.filter(x => x.runId !== p.runId);
      if (name === 'crew.summon.request') this._state.summons.push(p);
      this._publish();
    }
    saveStation(stationDoc) {
      this._assert(); const requested = clone(stationDoc);
      if (!requested || !requested.rooms || !Array.isArray(requested.order) || !Array.isArray(requested.props)) return Promise.reject(fail('Invalid station document.', 'station'));
      const operation = this._saveQueue.then(async () => {
        this._assert(); this._state.save = { status: 'saving', error: null }; this._publish();
        try {
          const latest = await this._request('/api/save?agent=' + encodeURIComponent(this._owner));
          if (latest.degraded) throw fail('Workspace was written by a newer app; station is read-only.', 'degraded');
          if (!latest.save || latest.save.schema !== 'starnet.save' || !latest.save.agent || latest.save.agent.id !== this._owner ||
              (latest.save.agentId && latest.save.agentId !== this._owner)) throw fail('Create a valid saved agent before saving its station.', 'save-schema');
          if (!equal(latest.save.station, this._saveDoc && this._saveDoc.station)) throw fail('Station changed in another client. Reload before saving.', 'conflict');
          const doc = clone(latest.save); doc.station = requested; doc.updatedAt = Math.max(this._clock(), Number(doc.updatedAt || 0) + 1);
          const receipt = await this._request('/api/save', doc);
          if (!receipt || receipt.ok !== true) throw fail(receipt && receipt.stale ? 'Sidecar refused a stale save; reload before saving.' : (receipt && receipt.error) || 'Sidecar did not confirm the save.', 'save-refused');
          const verified = await this._request('/api/save?agent=' + encodeURIComponent(this._owner));
          if (!verified.save || !equal(verified.save.station, requested)) throw fail('Saved station could not be verified.', 'save-verify');
          this._acceptSave(verified); this._state.save.status = 'saved'; this._publish();
          let routing = null, routingError = null;
          try {
            if (!this._model || !this._pipeline || typeof this._pipeline.compileRoutingPlan !== 'function') throw fail('Routing compiler is unavailable.', 'routing');
            const plan = this._pipeline.compileRoutingPlan(this._model.deserialize(clone(requested)).projectGeometry());
            // Even a well-formed non-deployable plan must reach the sidecar, which disarms obsolete routing.
            routing = await this._request('/api/routing', plan, { acceptStatus: [422] });
            if (!routing || routing.ok !== true) throw fail((routing && (routing.error || routing.reason)) || 'Sidecar refused the routing plan.', 'routing');
            this._state.routing = { status: 'deployed', error: null, hash: plan.hash, receipt: routing };
          } catch (e) {
            routingError = e.message; this._state.routing = { status: 'error', error: routingError, receipt: routing };
            this._state.save = { status: 'partial', stationSaved: true, routingError, error: 'Station saved; routing was not deployed: ' + routingError };
          }
          this._publish(); await this.refreshCapabilities();
          return Object.assign({}, clone(receipt), { ok: !routingError, stationSaved: true, routingSaved: !routingError, routingError, routing });
        } catch (e) { this._state.save = { status: 'error', error: e.message, code: e.code }; this._publish(); throw e; }
      });
      this._saveQueue = operation.catch(() => {}); return operation;
    }
    async send(agentId, text) {
      this._assert();
      if (!validId(agentId) || !this._state.roster.some(a => a.agentId === agentId)) throw fail('Select a registered agent.', 'agent');
      text = String(text || '').trim(); if (!text) throw fail('Message is empty.', 'message');
      if (this._pending.has(agentId)) throw fail('This agent already has an attended request.', 'busy');
      const controller = new AbortController(); this._pending.set(agentId, controller);
      const conversation = this._state.conversations[agentId] || (this._state.conversations[agentId] = {
        messages: [], status: 'idle', runId: null, text: '', error: null,
        streamId: 'next_' + (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID().replace(/-/g, '') : this._clock().toString(36) + Math.random().toString(36).slice(2))
      });
      conversation.status = 'connecting'; conversation.error = null; conversation.text = ''; conversation.runId = null; this._publish();
      let reader, ended = false, reason, output = '', leadRunId = null;
      try {
        const saved = await this._request('/api/save?agent=' + encodeURIComponent(agentId));
        const agent = this._state.roster.find(a => a.agentId === agentId), doc = saved.save || this._docs.get(agentId) || {}, ident = doc.agent || {};
        const model = agent.model || ident.model || this._state.runtime.model, provider = agent.provider || doc.prov || this._state.runtime.provider;
        if (!model) throw fail('This agent has no configured model.', 'model');
        const placement = this._placements(agentId);
        if (!placement.known) throw fail('Station capabilities are unknown; load the station model before sending.', 'capabilities');
        const messages = conversation.messages.filter(m => m.status !== 'failed').map(m => ({ role: m.role, content: m.content }));
        messages.push({ role: 'user', content: text });
        const userMessage = { role: 'user', content: text, status: 'sending' }; conversation.messages.push(userMessage);
        const docs = ident.docs || {}, system = ['identity', 'purpose', 'manual', 'context'].map(k => typeof docs[k] === 'string' ? docs[k] : '').filter(Boolean).join('\n\n');
        const response = await this._request('/api/run', { agentId, model, provider, system, messages, isTask: true,
          streamId: conversation.streamId, placed: placement.placed, stationPlaced: placement.stationPlaced }, { stream: true, controller });
        if (!response.body || !response.body.getReader) throw fail('Sidecar did not provide a run stream.', 'protocol');
        reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
        const consume = line => {
          if (!line.trim()) return;
          let event; try { event = JSON.parse(line); } catch (_) { throw fail('Invalid run event.', 'protocol'); }
          if (!event || typeof event.name !== 'string' || !event.payload || typeof event.payload !== 'object') throw fail('Invalid run event shape.', 'protocol');
          const p = event.payload;
          if (event.name === 'agent.run.start' && !leadRunId && p.agentId === agentId) {
            leadRunId = p.runId; conversation.runId = leadRunId; conversation.status = 'working'; userMessage.status = 'sent';
          }
          if (p.runId === leadRunId && leadRunId) {
            if (event.name === 'agent.token') { output += String(p.delta || ''); conversation.text = output; conversation.status = 'working'; }
            if (event.name === 'agent.tool_call') { output = ''; conversation.text = ''; conversation.status = 'working'; }
            if (event.name === 'permission.prompt') conversation.status = 'waiting';
            if (event.name === 'agent.run.error') conversation.error = p.message || 'Run error';
            if (event.name === 'agent.run.end') { ended = true; reason = p.reason; }
          }
          this._event(event.name, p);
        };
        while (true) {
          const chunk = await reader.read(); this._assert();
          if (chunk.done) { buffer += decoder.decode(); break; }
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length > 4 * 1024 * 1024) throw fail('Run event exceeded the stream limit.', 'protocol');
          let cut; while ((cut = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, cut)); buffer = buffer.slice(cut + 1); }
        }
        if (buffer.trim()) consume(buffer);
        if (!ended) throw fail('Run connection closed before a confirmed outcome.', 'interrupted');
        conversation.status = reason === 'done' ? 'complete' : 'ended'; conversation.reason = reason;
        if (output) conversation.messages.push({ role: 'assistant', content: output, runId: leadRunId, reason });
        this._publish(); return { runId: leadRunId, text: output, reason };
      } catch (e) {
        controller.abort(); conversation.status = 'error'; conversation.error = e.message;
        const last = conversation.messages[conversation.messages.length - 1]; if (last && last.role === 'user' && last.status === 'sending') last.status = 'failed';
        const run = leadRunId && this._runs.get(leadRunId); if (run && !ended) run.status = 'unknown';
        this._publish(); throw e;
      } finally {
        if (reader) { try { await reader.cancel(); } catch (_) {} }
        this._controllers.delete(controller); this._pending.delete(agentId);
      }
    }
    async stopRun(runId) {
      if (!runId || !this._runs.has(runId)) throw fail('No observed run with that id.', 'run');
      await this._request('/api/cancel', { runId }, { text: true });
      // This endpoint acknowledges unknown ids too. It does not prove cancellation completed.
      this._runs.get(runId).cancelRequested = true; this._publish(); return { requested: true, runId };
    }
    acknowledgePrompt(runId, promptId) { return this._request('/api/consent/ack', { runId, promptId }); }
    respondPermission(runId, promptId, decision) {
      if (!['once', 'session', 'always', 'deny', 'full'].includes(decision)) return Promise.reject(fail('Invalid permission decision.', 'permission'));
      return this._request('/api/consent', { runId, promptId, decision });
    }
    answerPrompt(runId, promptId, answer) { return this._request('/api/consent/answer', { runId, promptId, answer: String(answer), receipt: true }); }
    dispose() {
      if (this._disposed) return;
      this._disposed = true; clearInterval(this._timer);
      if (this._source) { this._source.onopen = this._source.onerror = this._source.onmessage = null; this._source.close(); }
      for (const controller of this._controllers) controller.abort(); for (const controller of this._pending.values()) controller.abort();
      this._controllers.clear(); this._pending.clear(); this._subs.clear();
      for (const run of this._runs.values()) if (active(run)) run.status = 'unknown';
      this._state.runs = Array.from(this._runs.values()).slice(-150);
      this._state.connection.status = 'disconnected'; this._state.connection.error = 'Bridge disposed.';
    }
  }
  return NextBridge;
});
