/* node test/harness.integration.test.js — THE real-harness contract, end to end and headless.
   Wires the SAME graph the sidecar host builds (registry + web + fs + notebook tools, object=capability
   resolution, the dotted->underscore wire-name boundary, the dispatch guard) and drives a four-step
   mission — web_search -> web_fetch -> fs.write -> final answer — through the UNCHANGED agentic loop on
   the replay provider. Zero network, zero spend (fetch + DNS injected). Proves the agent can actually ACT.

   This is the test that would have caught BOTH default-path showstoppers: the dotted tool names (the wire
   regex assertion) and a CAP_REGISTRY/registration drift (the resolved-toolset assertion). */
'use strict';
const A = require('./_assert.js');
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const os = require('os');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeWebTools } = require('../sidecar/tools/builtin/web.js');
const { makeConnectorTools } = require('../sidecar/tools/builtin/connectors.js');
const { makeBrowserTools } = require('../sidecar/tools/builtin/browser.js');
const { makeDesktopTools } = require('../sidecar/tools/builtin/desktop.js');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');
const { makeNotebookTools } = require('../sidecar/tools/builtin/notebook.js');
const { makeWidgetTools } = require('../sidecar/tools/builtin/widgets.js');
const { makeTodoTool } = require('../sidecar/tools/builtin/todo.js');
const { makeDeliverableTool } = require('../sidecar/tools/builtin/deliverable.js');
const { makeRecallTool } = require('../sidecar/tools/builtin/recall.js');
const { makeToolSearchTool } = require('../sidecar/tools/builtin/toolsearch.js');
const { makeCodeTools } = require('../sidecar/tools/builtin/code.js');
const { makeStationInspectTool } = require('../sidecar/tools/builtin/station-inspect.js');
const { makeManualReadTool } = require('../sidecar/tools/builtin/manual-read.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const { makeSkillTools } = require('../sidecar/tools/builtin/skills.js');
const { makeSkillStore } = require('../sidecar/skillstore.js');
const { makeQuestTools } = require('../sidecar/tools/builtin/quests.js');
const { makeCommsTools } = require('../sidecar/tools/builtin/comms.js');
const { makeRoutineTools } = require('../sidecar/tools/builtin/routines.js');
const { makeQuestStore } = require('../sidecar/quest-store.js');
const { resolveTools } = require('../sidecar/capability/resolve.js');
const { makeCapCtx } = require('../sidecar/capability/capGate.js');
const { makeConsentBroker } = require('../sidecar/permissions.js');
const { renderRecall, injectRecall, rank } = require('../sidecar/context.js');

const ROOT = path.join(os.tmpdir(), 'starnet-itest-' + process.pid);

// canned web: a DDG results page for search, and the ARTICLE ITSELF for fetch. (No real network.)
// The article is served on the DIRECT url, not through r.jina.ai, because that is the path a default
// install actually takes: Jina Reader is keyed now (keyless returns 401), so web_fetch only attempts it
// when a key is configured — which no default station has. This mock used to answer ONLY r.jina.ai, so the
// integration mission was silently exercising a path real users never reach.
const DDG_HTML = '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Farticle">Example Article</a>' +
  '<div class="result__snippet">A great article about the answer.</div>';
const ARTICLE_HTML = '<html><body><article>The top result confirms the answer is 42.</article></body></html>';
function cannedFetch(url) {
  const u = String(url);
  if (u.indexOf('duckduckgo') >= 0) return Promise.resolve({ status: 200, text: async () => DDG_HTML });
  if (u.indexOf('r.jina.ai') >= 0) return Promise.resolve({ status: 200, text: async () => 'Title: Example\nURL Source: https://example.com/article\nMarkdown Content:\nThe top result confirms the answer is 42.' });
  if (u.indexOf('example.com/article') >= 0) {
    return Promise.resolve({ status: 200, text: async () => ARTICLE_HTML, headers: { get: (h) => (/content-type/i.test(h) ? 'text/html' : '') } });
  }
  return Promise.resolve({ status: 404, text: async () => '', headers: { get: () => '' } });
}

// the model's scripted run: search -> fetch -> write -> report. Tool names are the WIRE names the model
// would actually return (fs_write, not fs.write) — the dispatch boundary maps them back.
const fixture = {
  models: [{ id: 'replay/model', context_length: 8000, pricing: { prompt: '0.000001', completion: '0.000002' }, supportsTools: true }],
  turns: [
    [ { type: 'text', delta: 'On it, Commander — searching.' },
      { type: 'tool_start', index: 0, id: 'c1', name: 'web_search' },
      { type: 'tool_args', index: 0, chunk: '{"query":"the answer"}' },
      { type: 'usage', usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } },
      { type: 'done', finishReason: 'tool_calls' } ],
    [ { type: 'tool_start', index: 0, id: 'c2', name: 'web_fetch' },
      { type: 'tool_args', index: 0, chunk: '{"url":"https://example.com/article"}' },
      { type: 'usage', usage: { prompt_tokens: 60, completion_tokens: 10, total_tokens: 70 } },
      { type: 'done', finishReason: 'tool_calls' } ],
    [ { type: 'tool_start', index: 0, id: 'c3', name: 'fs_write' },
      { type: 'tool_args', index: 0, chunk: '{"path":"report.md","content":"# Report\\nThe answer is 42."}' },
      { type: 'usage', usage: { prompt_tokens: 80, completion_tokens: 12, total_tokens: 92 } },
      { type: 'done', finishReason: 'tool_calls' } ],
    [ { type: 'text', delta: 'Done, Commander. Saved report.md.' },
      { type: 'usage', usage: { prompt_tokens: 90, completion_tokens: 9, total_tokens: 99 } },
      { type: 'done', finishReason: 'stop' } ]
  ]
};

(async () => {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});

  // ---- build the graph EXACTLY as sidecar/index.js does ----
  const registry = makeRegistry();
  makeWebTools({ fetchImpl: cannedFetch, lookup: null }).register(registry);
  makeBrowserTools({ driver: { navigate: async u => u, snapshot: async () => [], click: async () => '', type: async () => '', press: async k => k, scroll: async () => '', back: async () => '', getText: async () => '', consoleLog: () => [], handleDialog: async () => ({}), screenshot: async () => '' } }).register(registry);
  makeDesktopTools({ opener: async () => 'launched' }).register(registry);
  makeFsTools({ fsp, pathMod: path, root: ROOT, limits: { writeBytes: 1 << 20, readReturn: 24000 } }).register(registry);
  makeNotebookTools({ store: new Map(), clock: { now: () => 0 } }).register(registry);
  makeWidgetTools({ store: new Map(), clock: { now: () => 0 } }).register(registry);   // WIDGET RAILS Phase 2: widget.set rides the notebook (memory) grant
  makeTodoTool({ store: new Map() }).register(registry);
  makeDeliverableTool({ notes: new Map() }).register(registry);   // deliverable_note rides COMPUTER, so the full office resolves it
  makeToolSearchTool({ registry }).register(registry);   // tool.search — rides the computer object, so it is in every office
  makeCodeTools({}).register(registry);
  makeStationInspectTool({ inspect: () => ({ schemaVersion: 1 }) }).register(registry);
  makeManualReadTool().register(registry);   // manual.read rides COMPUTER beside station.inspect
  // plugin.* authoring is NOT registered for runs (no grant): the crew builds APPS — mirrors index.js
  // app.* rides COMPUTER too (deferred; an app page is a network-less sandbox) — registered like index.js does
  require('../sidecar/tools/builtin/apps.js').makeAppTools({ apps: {} }).register(registry);
  makeRecallTool({ transcriptStore: makeTranscriptStore({ io: { readAll() { return []; }, append() {} }, clock: { now: () => 0 } }) }).register(registry);
  makeSkillTools({ store: makeSkillStore({ io: { readAll() { return []; }, append() {} }, clock: { now: () => 0 } }) }).register(registry);
  // QUEST V2 §B: quest.update rides the COMPUTER (the 'quest' freebie), present in this office. In-memory questStore
  // so registration + resolve mirror sidecar/index.js exactly (the drift guard below expects quest.update resolved).
  const _qFiles = new Map();
  const _qFs = {
    readFileSync(f) { if (!_qFiles.has(String(f))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return _qFiles.get(String(f)); },
    writeFileSync(f, d) { _qFiles.set(String(f), String(d)); }, renameSync(a, b) { _qFiles.set(String(b), _qFiles.get(String(a))); _qFiles.delete(String(a)); },
    existsSync(f) { return _qFiles.has(String(f)); }, mkdirSync() {}, unlinkSync(f) { _qFiles.delete(String(f)); }, openSync() { return 1; }, fsyncSync() {}, closeSync() {}
  };
  makeQuestTools({ store: makeQuestStore({ fs: _qFs, path, workspaces: '/ws', writeDurable: ({ fs }, file, data) => fs.writeFileSync(file, data) }), clock: { now: () => 0 } }).register(registry);
  // COMMS: channel.targets / channel.send ride the placed DISH (capId 'comms'), so this office resolves them —
  // register them here for the same reason every other family is registered: the drift guard below proves the
  // CAP_REGISTRY and the tool registrations agree, and a resolved-but-unregistered tool is exactly the "dark
  // tool" bug it exists to catch. No reachable chats in a headless fixture, which is the honest empty case.
  makeCommsTools({ listTargets: () => [], sendTo: () => Promise.resolve({ ok: false, error: 'no channel in test' }) }).register(registry);
  // connectors.list rides the same placed DISH as web_request (capId 'web'). Registered with NO deps: the
  // honest empty station, which is also the case that must not pretend "you have nothing to add".
  makeConnectorTools({}).register(registry);
  // routine.notepad rides the computer on every runnable station but remains inert without a host-minted
  // scheduled cronJobId. Register the honest unwired shape so the capability/registration drift guard stays exact.
  makeRoutineTools({}).register(registry);

  const station = { agents: { agent: { id: 'agent', room: 'office' } }, rooms: { office: { id: 'office', objects: [
    { instanceId: 'pc1', objectType: 'computer' }, { instanceId: 'd1', objectType: 'dish' },
    { instanceId: 'cab1', objectType: 'cabinet' }, { instanceId: 'nb1', objectType: 'notebook' }
  ] } } };
  const resolved = resolveTools('agent', station);
  // P1.5: drive the mission through the REAL consent broker, not an allow-all stub. The mission's single
  // write (report.md) is sanctioned up-front via a session grant on its danger class (cabinet:write), so it
  // flows through the cache tier — proving a granted mutation is allowed without resorting to Full Access.
  const consent = makeConsentBroker({ sessionKey: 'itest', surface: 'autonomous' });
  consent.grant('session', { name: 'fs.write' }, registry.get('fs.write'));
  const capCtx = makeCapCtx(resolved, { emit, consent, timeoutMs: 5000 });

  // ---- DRIFT GUARDS (these alone would have caught both default-path showstoppers) ----
  const EXPECTED = ['app.check', 'app.create', 'app.publish', 'app.read', 'app.schedule', 'app.write', 'browser.attach', 'browser.back', 'browser.click', 'browser.console', 'browser.detach', 'browser.dialog', 'browser.drag', 'browser.emulate', 'browser.eval', 'browser.find', 'browser.forward', 'browser.get_text', 'browser.hover', 'browser.inspect', 'browser.intercept', 'browser.login', 'browser.navigate', 'browser.need_human', 'browser.network', 'browser.pdf', 'browser.press', 'browser.reset', 'browser.screenshot', 'browser.scroll', 'browser.select', 'browser.snapshot', 'browser.tab_close', 'browser.tab_select', 'browser.tabs', 'browser.type', 'browser.upload', 'browser.viewport', 'browser.vision', 'browser.wait', 'channel.send', 'channel.targets', 'code.run', 'connectors.list', 'deliverable_note', 'fs.append', 'fs.edit', 'fs.list', 'fs.patch', 'fs.read', 'fs.search', 'fs.write', 'manual.read', 'notebook.feedback', 'notebook.read', 'notebook.write', 'quest.update', 'recall_conversation', 'routine.notepad', 'skill.list', 'skill.manage', 'skill.view', 'skill.write', 'station.inspect', 'todo', 'tool.search', 'web_fetch', 'web_request', 'web_search', 'widget.get', 'widget.set'];
  A.eq(resolved.tools.slice().sort(), EXPECTED.slice().sort(), 'office objects resolve to the full toolset (object=capability is real)');
  for (const name of EXPECTED) A.ok(registry.get(name), 'tool registered: ' + name);

  /* DEFERRAL IS ADVERTISING, NOT CAPABILITY: `resolved.tools` above is the full GRANT set and is what the gate
     reads, so it must still list every deferred tool. Only the wire list narrows. */
  A.ok(resolved.deferred.length > 0, 'this office defers part of its toolset');
  for (const n of resolved.deferred) A.ok(resolved.tools.indexOf(n) >= 0, 'a deferred tool is still granted: ' + n);
  A.ok(resolved.deferred.indexOf('tool.search') < 0, 'tool.search is never itself deferred — the finder cannot be the thing that must be found');
  A.ok(resolved.deferred.indexOf('browser.navigate') < 0, 'the core browsing path stays advertised');
  // Measured with real models (2026-07-26): deferring browser.screenshot made gpt-4.1-mini report a
  // screenshot it never took. A headline capability the model may CLAIM to have performed stays advertised;
  // only the specialist tail is deferred.
  A.ok(resolved.deferred.indexOf('browser.screenshot') < 0, 'a headline capability is never deferred (fabrication risk)');
  A.ok(resolved.deferred.indexOf('browser.vision') < 0, 'nor the other half of "look at the page"');
  A.ok(resolved.deferred.indexOf('browser.network') >= 0, 'the specialist tail IS deferred');
  A.ok(resolved.deferred.indexOf('browser.upload') >= 0, 'and so is the rest of it');

  const deferredNames = new Set(resolved.deferred);
  const coreNames = resolved.tools.filter(n => !deferredNames.has(n));
  const toolDefs = registry.wireFormat(registry.list(new Set(coreNames)));
  const deferredToolDefs = registry.wireFormat(registry.list(deferredNames));
  A.ok(toolDefs.length < resolved.tools.length, 'the advertised list is smaller than the granted list');
  const fromWire = new Map();
  // BOTH lists translate: a revealed tool still has to carry a provider-legal name.
  for (const d of toolDefs.concat(deferredToolDefs)) { const real = d.function.name; const w = real.replace(/\./g, '_'); fromWire.set(w, real); d.function.name = w; }
  for (const d of toolDefs.concat(deferredToolDefs)) A.ok(/^[A-Za-z0-9_-]{1,64}$/.test(d.function.name), 'wire tool name is provider-legal: ' + d.function.name);

  const dispatch = async (c, ctx) => {
    if (fromWire.has(c.name)) c = Object.assign({}, c, { name: fromWire.get(c.name) });
    return registry.dispatch(c, ctx);
  };

  // ---- run the mission ----
  const provider = makeReplayProvider(fixture);
  const cost = makeCostEngine({ priceOf: provider.priceOf });
  const res = await runAgentLoop({
    messages: [{ role: 'user', content: 'find the answer and write report.md' }],
    provider, emit, cost, tools: toolDefs, dispatch, capCtx,
    model: 'replay/model', agentId: 'agent', runId: 'itest',
    limits: { maxIters: 8, maxCostUsd: 1 }, clock: { now: () => 0 }
  });

  // ---- assert the agent actually ACTED ----
  A.eq(res.reason, 'done', 'multi-step mission ends done');
  A.eq(provider.callCount(), 4, 'four model turns (search, fetch, write, report)');

  const calls = seq.filter(e => e.name === 'agent.tool_call').map(e => e.payload.name);
  A.eq(calls, ['web_search', 'web_fetch', 'fs_write'], 'tools called in order (wire names)');

  const tr = seq.filter(e => e.name === 'agent.tool_result').map(e => e.payload);
  A.eq(tr.length, 3, 'exactly one result per call (pairing held)');
  A.ok(tr.every(r => r.isError === false), 'every tool succeeded — no 400, no capdenied, no jail/SSRF block');
  A.ok(seq.find(e => e.name === 'agent.run.error') === undefined, 'no run error across the whole multi-tool run');

  const dl = seq.find(e => e.name === 'deliverable');
  A.ok(dl && dl.payload.kind === 'file' && dl.payload.title === 'report.md', 'fs.write produced a deliverable');

  const onDisk = await fsp.readFile(path.join(ROOT, 'agent', 'report.md'), 'utf8');
  A.ok(/answer is 42/.test(onDisk), 'the report was REALLY written into the agent workspace on disk');

  A.ok(seq.filter(e => e.name === 'agent.token').some(e => /Saved report\.md/.test(e.payload.delta)), 'the final answer streamed to the user');

  // ---- P1.5 default-deny: an UN-granted mutation under an autonomous surface is denied, body never runs ----
  // (a fresh broker with no grant — the same fs.write the model is fully capable of calling otherwise.)
  const denyCtx = makeCapCtx(resolved, { emit, consent: makeConsentBroker({ sessionKey: 'deny', surface: 'autonomous' }), timeoutMs: 5000 });
  const denied = await dispatch({ name: 'fs_write', args: { path: 'unsanctioned.md', content: 'nope' } }, denyCtx);
  A.eq(denied.isError, true, 'un-granted mutation default-denies');
  A.eq(denied.summary, 'denied', 'denial surfaced as a consent denial, not a crash');
  A.ok(/silence is not consent/.test(denied.content), 'denial carries the silence-is-not-consent reason');
  let wrote = true; try { await fsp.access(path.join(ROOT, 'agent', 'unsanctioned.md')); } catch (e) { wrote = false; }
  A.ok(!wrote, 'the denied write never touched disk (no action on deny)');

  // ---- Cortex (M-mem.3): the recalled-memory injection the host performs before a run. Mirrors index.js's
  //      composition exactly — RANK the notebook by relevance to THIS message (BM25 + recency/trust/pin),
  //      surface the top few as a fence before the user message, and emit memory.used per surfaced record.
  //      An empty notebook is byte-identical (the memoryless run is unchanged). ----
  {
    const notes = [{ id: 'note_1', title: 'API base', body: 'openrouter.ai/api/v1', ts: 1 },
                   { id: 'note_2', title: 'User tz', body: 'PST timezone', ts: 2 }];
    const convo = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'what is the api base url again?' }];
    const ranked = rank(notes, 'what is the api base url again?', { now: 100 });
    A.eq(ranked[0].id, 'note_1', 'M-mem.3: the query-relevant note ranks first');
    A.eq(ranked.length, 1, 'relevance floor: the zero-overlap note is DROPPED under a real query (no off-topic padding)');
    const r = renderRecall(ranked, { limit: 1500 });
    A.eq(r.count, 1, 'only the relevant note is recalled');
    A.ok(r.text.indexOf('API base') >= 0 && r.text.indexOf('User tz') === -1, "recall surfaces the relevant note and withholds the off-topic one");
    const withMem = injectRecall(convo, r.text);
    A.eq(withMem.length, 3, 'recall adds exactly one system note');
    A.eq(withMem[2], convo[1], 'fence sits immediately before the newest user message');
    A.ok(withMem[1].role === 'system' && /recalled-memory/.test(withMem[1].content), 'fence is a system note');
    // index.js emits memory.used for the ids renderRecall actually SURFACED (excludes blocked/skipped) — mirror it
    A.eq(JSON.stringify(r.usedIds), JSON.stringify(['note_1']),
      'memory.used fires for each surfaced record (driven by renderRecall.usedIds, not positional ranked[i])');
    const empty = injectRecall(convo, renderRecall(rank([], 'q', { now: 0 }), {}).text);
    A.eq(JSON.stringify(empty), JSON.stringify(convo), 'empty notebook -> byte-identical messages (memoryless run unchanged)');
  }

  // ---- Lane 5 (truthful telemetry): a PROVIDER-TRUNCATED reply must surface finishReason on BOTH the return
  //      value (index.js gates reflection/study/skills on it) AND the emitted agent.run.end event (the frontend
  //      renders a "cut short" recap instead of a delivered crate). A clean 'stop' still omits it. ----
  {
    const cutBus = A.makeBus();
    const cutSeq = A.collectBus(cutBus, events.names());
    const cutEmit = makeEmitter(cutBus, () => {});
    // Explicit opt-out preserves the cut-short telemetry contract for a host that disables semantic continuation.
    const cutProvider = makeReplayProvider({
      models: fixture.models,
      turns: [[ { type: 'text', delta: 'The answer begins but is cut o' },
                { type: 'usage', usage: { prompt_tokens: 30, completion_tokens: 7, total_tokens: 37 } },
                { type: 'done', finishReason: 'length' } ]]
    });
    const cutCost = makeCostEngine({ priceOf: cutProvider.priceOf });
    const cutRes = await runAgentLoop({
      messages: [{ role: 'user', content: 'write me a long essay' }],
      provider: cutProvider, emit: cutEmit, cost: cutCost, tools: toolDefs, dispatch, capCtx,
      model: 'replay/model', agentId: 'agent', runId: 'cut1',
      limits: { maxIters: 8, maxCostUsd: 1, outputContinuation: false }, clock: { now: () => 0 }
    });
    A.eq(cutRes.reason, 'done', 'a truncated turn with prose still ends reason:done (not a new run-end reason)');
    A.eq(cutRes.finishReason, 'length', 'finishReason:length rides the RETURN value (index.js reflection gate)');
    const cutEnd = cutSeq.find(e => e.name === 'agent.run.end' && e.payload.runId === 'cut1');
    A.ok(cutEnd, 'agent.run.end emitted for the truncated run');
    A.eq(cutEnd.payload.finishReason, 'length', 'finishReason:length rides the EMITTED event too (the frontend reads it)');
    A.ok(events.validate('agent.run.end', cutEnd.payload).ok, 'the finishReason-carrying run-end payload is still schema-valid');
    // a CLEAN stop omits finishReason entirely (old clean-run payloads stay byte-identical).
    const cleanEnd = seq.find(e => e.name === 'agent.run.end' && e.payload.runId === 'itest');
    A.ok(cleanEnd && cleanEnd.payload.finishReason === undefined, 'a clean run omits finishReason (additive, not always-on)');
  }

  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
  A.report('harness.integration.test');
})();
