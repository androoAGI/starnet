/* node test/toolsearch.test.js — tool.search and the DEFERRED tool split.

   The claim under test: a deferred tool is GRANTED but not advertised, and the agent can find it and then
   actually call it. The load-bearing case is the last one — a real runAgentLoop where the model asks for a
   tool it cannot see, searches, and calls it on the next turn. Everything above it is the machinery that
   makes that possible; if only the unit tests passed, the feature would still be broken. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeToolSearchTool } = require('../sidecar/tools/builtin/toolsearch.js');
const { resolveTools } = require('../sidecar/capability/resolve.js');
const { attenuate, makeCapCtx } = require('../sidecar/capability/capGate.js');

const priceOf = () => ({ in: 1, out: 2 });

// A registry with one advertised tool and two hidden ones, so "hidden" is observable without the whole floor.
function fixture() {
  const registry = makeRegistry();
  registry.register({
    name: 'page.open', capability: 'web', scope: 'read', requiresConsent: false,
    description: 'Open a web page.', schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
    run: async () => ({ content: 'opened', summary: 'ok' })
  });
  registry.register({
    name: 'page.screenshot', capability: 'web', scope: 'read', requiresConsent: false,
    description: 'Capture a screenshot of the current page as an image. Use it to show the Commander what you saw.',
    schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    run: async () => ({ content: 'shot taken', summary: 'ok' })
  });
  registry.register({
    name: 'page.upload', capability: 'web', scope: 'execute', requiresConsent: false,
    description: 'Attach a local file to a file input on the page.',
    schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    run: async () => ({ content: 'uploaded', summary: 'ok' })
  });
  makeToolSearchTool({ registry }).register(registry);
  return registry;
}
const DEFERRED = ['page.screenshot', 'page.upload'];

(async () => {
  // ---- A. resolveTools: deferral narrows ADVERTISING, never the grant ----
  {
    const CAP = {
      computer: [
        { capId: 'compute', tool: 'model.chat', scope: 'execute', requiresConsent: false, network: true },
        { capId: 'toolsearch', tool: 'tool.search', scope: 'read', requiresConsent: false, network: false }
      ],
      dish: [
        { capId: 'web', tool: 'page.open', scope: 'read', requiresConsent: false, network: true },
        { capId: 'web', tool: 'page.screenshot', scope: 'read', requiresConsent: false, network: true, deferred: true },
        { capId: 'web', tool: 'page.upload', scope: 'execute', requiresConsent: false, network: true, deferred: true }
      ]
    };
    const station = { rooms: { r: { id: 'r', objects: [{ objectType: 'computer' }, { objectType: 'dish' }] } }, agents: { a: { id: 'a', room: 'r' } } };
    const r = resolveTools('a', station, CAP);
    A.eq(r.tools.slice().sort(), ['page.open', 'page.screenshot', 'page.upload', 'tool.search'], 'every granted tool is still in `tools` — the gate reads this');
    A.eq(r.deferred.slice().sort(), ['page.screenshot', 'page.upload'], 'deferred names are reported separately');
    A.eq(r.hasCompute, true, 'the compute gate is unaffected');
    A.eq(r.approvalRules['page.upload'].scope, 'execute', 'a deferred tool keeps its full policy triple');

    // The kill-switch still wins over deferral: a disabled family grants nothing to find.
    const off = resolveTools('a', station, CAP, { disabledCaps: new Set(['web']) });
    A.eq(off.tools, ['tool.search'], 'a switched-off toolset grants nothing, deferred or not');
    A.eq(off.deferred, [], 'and therefore has nothing to search for');

    // ATTENUATION: a delegated worker must not be able to FIND what it may not run.
    const worker = attenuate(r, new Set(['page.open', 'tool.search']));
    A.eq(worker.deferred, [], 'attenuation filters `deferred` by the same subset as `tools`');
    A.eq(makeCapCtx(worker).deferred, [], 'the worker capCtx exposes nothing to search');
    A.eq(makeCapCtx(r).deferred.slice().sort(), ['page.screenshot', 'page.upload'], 'the lead capCtx exposes its hidden set');
  }

  // ---- B. the search itself ----
  {
    const registry = fixture();
    const search = registry.get('tool.search');
    const ctx = { deferred: DEFERRED.slice() };

    const hit = await search.run({ query: 'take a screenshot of the page' }, ctx);
    A.ok(hit.content.indexOf('page.screenshot') >= 0, 'a plain-language query finds the tool');
    A.eq(hit.control.revealTools, ['page.screenshot'], 'the reveal signal names exactly what matched');
    A.ok(hit.content.indexOf('(name)') >= 0, 'the required params are shown so the model can call it');
    A.ok(hit.content.indexOf('"type"') < 0 && hit.content.indexOf('properties') < 0,
      'the result carries NO raw JSON schema — returning it here would hand back the bytes the split just saved');

    A.eq((await search.run({ query: 'page.upload' }, ctx)).control.revealTools, ['page.upload'], 'an exact tool name resolves to that tool');

    // An advertised tool is not in the hidden set, so it can never be "revealed".
    const already = await search.run({ query: 'open a web page' }, ctx);
    A.ok(!already.control || already.control.revealTools.indexOf('page.open') < 0, 'an already-advertised tool is not among the findable ones');

    // A miss names the shelf instead of dead-ending — a wrong guess is usually vocabulary, not absence.
    const miss = await search.run({ query: 'send an email' }, ctx);
    A.ok(!miss.control, 'a miss reveals nothing');
    A.ok(miss.content.indexOf('page.screenshot') >= 0 && miss.content.indexOf('page.upload') >= 0, 'a miss lists what IS findable');

    A.ok((await search.run({ query: 'anything' }, { deferred: [] })).content.indexOf('already listed') >= 0, 'with nothing deferred it says so plainly');
    A.ok((await search.run({ query: '  ' }, ctx)).content.indexOf('`query`') >= 0, 'an empty query asks for one');

    // Determinism: the lint forbids clock/random in sidecar/, and a flaky tool list would be untestable.
    const a = await search.run({ query: 'file' }, ctx), b = await search.run({ query: 'file' }, ctx);
    A.eq(a.content, b.content, 'the same query always returns the same ordering');

    /* RUN-POLICY WITHHOLDING (direct-domain): the host keeps a policy-withheld name OUT of ctx.deferred, and
       tool.search explains it instead of answering with an unrelated hidden tool. */
    const policy = { deferred: ['page.upload'], policyWithheld: { names: ['web_search', 'team.delegate'], why: 'W', enable: 'E' } };
    const ws = await search.run({ query: 'search the web for it' }, policy);
    A.ok(/WITHHELD on this run/.test(ws.content) && ws.content.indexOf('team.delegate, web_search') >= 0, 'a query for a policy-withheld tool names it as withheld (saw: ' + ws.content + ')');
    A.ok(ws.content.indexOf('Why: W. What works instead: E.') >= 0, 'with the policy\'s own reason and remedy');
    A.ok(ws.content.indexOf('Now available') < 0 && !ws.control, 'and never announces it, or anything else, as now available');
    const wsEmpty = await search.run({ query: 'web search' }, { deferred: [], policyWithheld: policy.policyWithheld });
    A.ok(/WITHHELD on this run/.test(wsEmpty.content) && wsEmpty.content.indexOf('already listed') < 0, 'an empty hidden pool still explains the withheld tool');
    A.eq((await search.run({ query: 'take a screenshot of the page' }, ctx)).content,
      (await search.run({ query: 'take a screenshot of the page' }, Object.assign({}, ctx, { policyWithheld: null }))).content, 'no policy: byte-identical output');

    /* ALREADY LISTED: a model that missed an advertised tool is pointed at it, not at the nearest hidden one. */
    const listedCtx = { deferred: DEFERRED.slice(), advertised: ['page.open', 'tool.search'] };
    const open = await search.run({ query: 'open a web page' }, listedCtx);
    A.ok(/Already in your tool list/.test(open.content) && open.content.indexOf('page.open (url)') >= 0, 'a listed tool is named as callable now (saw: ' + open.content + ')');
    A.ok(!open.control, 'and no weaker hidden tool is revealed in its place');
    const shot = await search.run({ query: 'take a screenshot of the page' }, listedCtx);
    A.eq(shot.control && shot.control.revealTools, ['page.screenshot'], 'a hidden tool that IS the best match is still revealed with listed tools present');
    A.eq((await search.run({ query: 'take a screenshot of the page' }, ctx)).content.indexOf('Already in your tool list'), -1, 'no advertised list: unchanged');
  }

  /* ---- C. THE REAL FLOW: a run that needs a tool it cannot see. Turn 1 the model can only see page.open and
     tool.search; it searches. Turn 2 the revealed tool is in the request and it calls it. ---- */
  {
    const registry = fixture();
    const bus = A.makeBus();
    A.collectBus(bus, events.names());
    const emit = makeEmitter(bus, () => {});

    const toolsSeenPerTurn = [];
    let turn = 0;
    const provider = {
      priceOf, contextLimit: () => 0,
      stream: async function* (req) {
        toolsSeenPerTurn.push(req.tools.map(t => t.function.name).sort());
        turn++;
        if (turn === 1) {
          yield { type: 'tool_start', index: 0, id: 'c1', name: 'tool_search' };
          yield { type: 'tool_args', index: 0, chunk: '{"query":"screenshot"}' };
          yield { type: 'tool_done', index: 0 };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else if (turn === 2) {
          yield { type: 'tool_start', index: 0, id: 'c2', name: 'page_screenshot' };
          yield { type: 'tool_args', index: 0, chunk: '{"name":"after"}' };
          yield { type: 'tool_done', index: 0 };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text', delta: 'done' };
          yield { type: 'done', finishReason: 'stop' };
        }
      }
    };

    /* The wire lists are renamed dotted -> underscored exactly as index.js does it, because that rename is
       what the reveal path has to survive: the loop's map ends up keyed 'page_screenshot' while the reveal
       signal carries the registry's real 'page.screenshot'. Testing the un-renamed shape passed while the
       live run did nothing at all — the reveal missed on every lookup, silently. */
    const core = registry.wireFormat(registry.list(new Set(['page.open', 'tool.search'])));
    const deferredDefs = registry.wireFormat(registry.list(new Set(DEFERRED)));
    const fromWire = new Map();
    for (const d of core.concat(deferredDefs)) { const real = d.function.name; const w = real.replace(/\./g, '_'); fromWire.set(w, real); d.function.name = w; }
    const capCtx = makeCapCtx({
      agentId: 'a', room: 'r', hasCompute: true,
      tools: ['page.open', 'page.screenshot', 'page.upload', 'tool.search'],
      deferred: DEFERRED.slice(), approvalRules: {}
    }, { timeoutMs: 5000 });

    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'screenshot the page' }],
      provider, emit, cost: makeCostEngine({ priceOf }),
      tools: core, deferredTools: deferredDefs,
      dispatch: (c, ctx) => registry.dispatch(fromWire.has(c.name) ? Object.assign({}, c, { name: fromWire.get(c.name) }) : c, ctx),
      capCtx, model: 'm', agentId: 'a', runId: 'r'
    });

    A.eq(res.reason, 'done', 'the run completed');
    A.eq(toolsSeenPerTurn[0], ['page_open', 'tool_search'], 'TURN 1: the deferred tools are NOT advertised');
    A.ok(toolsSeenPerTurn[1].indexOf('page_screenshot') >= 0, 'TURN 2: the searched-for tool is now advertised (across the dotted->underscored rename)');
    A.ok(toolsSeenPerTurn[1].indexOf('page_upload') < 0, 'only what MATCHED was revealed — searching is not "advertise everything"');
    A.ok(toolsSeenPerTurn[2].indexOf('page_screenshot') >= 0, 'a revealed tool stays advertised for the rest of the run');

    // and it actually RAN — a reveal that could not be called would be theatre.
    const ran = res.messages.some(m => m.role === 'tool' && String(m.content).indexOf('shot taken') >= 0);
    A.ok(ran, 'the revealed tool was dispatched and returned its real result');
  }

  // ---- D. reveals are idempotent and never duplicate a declaration ----
  {
    const registry = fixture();
    let searches = 0;
    const provider = {
      priceOf, contextLimit: () => 0,
      stream: async function* (req) {
        if (req.tools.filter(t => t.function.name === 'page_screenshot').length > 1) throw new Error('duplicate tool declaration');
        const n = req.messages.filter(m => m.role === 'tool').length;
        if (n < 2) {
          searches++;
          yield { type: 'tool_start', index: 0, id: 'c' + n, name: 'tool_search' };
          yield { type: 'tool_args', index: 0, chunk: '{"query":"screenshot"}' };
          yield { type: 'tool_done', index: 0 };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else { yield { type: 'text', delta: 'ok' }; yield { type: 'done', finishReason: 'stop' }; }
      }
    };
    const core = registry.wireFormat(registry.list(new Set(['tool.search'])));
    const deferredDefs = registry.wireFormat(registry.list(new Set(DEFERRED)));
    const fromWire = new Map();
    for (const d of core.concat(deferredDefs)) { const real = d.function.name; const w = real.replace(/\./g, '_'); fromWire.set(w, real); d.function.name = w; }
    const bus = A.makeBus(); A.collectBus(bus, events.names());
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'go' }], provider, emit: makeEmitter(bus, () => {}),
      cost: makeCostEngine({ priceOf }),
      tools: core, deferredTools: deferredDefs,
      dispatch: (c, ctx) => registry.dispatch(fromWire.has(c.name) ? Object.assign({}, c, { name: fromWire.get(c.name) }) : c, ctx),
      capCtx: makeCapCtx({ agentId: 'a', room: 'r', hasCompute: true, tools: ['tool.search'].concat(DEFERRED), deferred: DEFERRED.slice(), approvalRules: {} }, { timeoutMs: 5000 }),
      model: 'm', agentId: 'a', runId: 'r'
    });
    A.eq(searches, 2, 'the same search really did run twice (otherwise this proves nothing)');
    A.eq(res.reason, 'done', 'searching the same thing twice does not duplicate the declaration or wedge the run');
  }

  // ---- E. a run with nothing deferred behaves exactly as before ----
  {
    const registry = fixture();
    const provider = {
      priceOf, contextLimit: () => 0,
      stream: async function* () { yield { type: 'text', delta: 'hi' }; yield { type: 'done', finishReason: 'stop' }; }
    };
    const bus = A.makeBus(); A.collectBus(bus, events.names());
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'go' }], provider, emit: makeEmitter(bus, () => {}),
      cost: makeCostEngine({ priceOf }), tools: registry.wireFormat(registry.list(new Set(['page.open']))),
      dispatch: (c, ctx) => registry.dispatch(c, ctx),
      capCtx: makeCapCtx({ agentId: 'a', room: 'r', hasCompute: true, tools: ['page.open'], approvalRules: {} }, { timeoutMs: 5000 }),
      model: 'm', agentId: 'a', runId: 'r'
    });
    A.eq(res.reason, 'done', 'omitting deferredTools entirely is a no-op — the old call shape still works');
  }

  /* ---- F. A REFUSAL THAT NAMES A DEFERRED TOOL REVEALS IT (browser.eval -> browser.inspect, 10-07). The refusal is
     a thrown error, and an error result used to carry no control at all, so the tool it named stayed uncallable
     until the model happened to search for it. It stays an error; only granted+deferred names become advertised. ---- */
  {
    const registry = fixture();
    registry.register({
      name: 'page.refuse', capability: 'web', scope: 'read', requiresConsent: false,
      description: 'Always refuses.', schema: { type: 'object', properties: {} },
      run: async () => { const e = new Error('refused: use page.screenshot instead'); e.revealTools = ['page.screenshot', 'not.granted', 42, '../bad']; e.toolSummary = 'refused'; throw e; }
    });
    const direct = await registry.dispatch({ id: 'x', name: 'page.refuse', args: {}, argsRaw: '{}' }, {});
    A.eq([direct.ok, direct.isError, direct.summary], [false, true, 'refused'], 'the refusal is still an error result with its own summary');
    A.eq(direct.control && direct.control.revealTools, ['page.screenshot', 'not.granted'], 'the error carries only well-formed tool names to reveal');
    const plain = await registry.dispatch({ id: 'y', name: 'page.missing.args', args: {}, argsRaw: '{}' }, {});
    A.ok(!plain.control, 'an ordinary error carries no control');

    const toolsSeenPerTurn = [];
    let turn = 0;
    const provider = {
      priceOf, contextLimit: () => 0,
      stream: async function* (req) {
        toolsSeenPerTurn.push(req.tools.map(t => t.function.name).sort());
        turn++;
        if (turn === 1) {
          yield { type: 'tool_start', index: 0, id: 'r1', name: 'page_refuse' };
          yield { type: 'tool_args', index: 0, chunk: '{}' };
          yield { type: 'tool_done', index: 0 };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else { yield { type: 'text', delta: 'ok' }; yield { type: 'done', finishReason: 'stop' }; }
      }
    };
    const core = registry.wireFormat(registry.list(new Set(['page.refuse', 'tool.search'])));
    const deferredDefs = registry.wireFormat(registry.list(new Set(DEFERRED)));
    const fromWire = new Map();
    for (const d of core.concat(deferredDefs)) { const real = d.function.name; const w = real.replace(/\./g, '_'); fromWire.set(w, real); d.function.name = w; }
    const bus = A.makeBus(); A.collectBus(bus, events.names());
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'go' }], provider, emit: makeEmitter(bus, () => {}),
      cost: makeCostEngine({ priceOf }),
      tools: core, deferredTools: deferredDefs,
      dispatch: (c, ctx) => registry.dispatch(fromWire.has(c.name) ? Object.assign({}, c, { name: fromWire.get(c.name) }) : c, ctx),
      capCtx: makeCapCtx({ agentId: 'a', room: 'r', hasCompute: true, tools: ['page.refuse', 'tool.search'].concat(DEFERRED), deferred: DEFERRED.slice(), approvalRules: {} }, { timeoutMs: 5000 }),
      model: 'm', agentId: 'a', runId: 'r'
    });
    A.eq(res.reason, 'done', 'the run completed');
    A.ok(toolsSeenPerTurn[0].indexOf('page_screenshot') < 0, 'TURN 1: the named tool is not advertised yet');
    A.ok(toolsSeenPerTurn[1].indexOf('page_screenshot') >= 0, 'TURN 2: the refusal revealed the deferred tool it named');
    A.ok(toolsSeenPerTurn[1].indexOf('page_upload') < 0 && toolsSeenPerTurn[1].indexOf('not_granted') < 0, 'nothing else was advertised — a reveal never widens the grant');
  }

  A.report('toolsearch.test');
})().catch(e => { console.log('THREW', e && e.stack || e); process.exit(1); });
