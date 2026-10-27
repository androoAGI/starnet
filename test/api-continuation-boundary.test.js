/* Hermetic composition of the real web tool, registry, run state, taint observation and dispatch gate.
   Transport/DNS/native execution are disabled; index snippets are evaluated without starting the application.
   This is a regression control, not live run-loop or customer recovery proof. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const taintPolicy = require('../sidecar/taint.js');
const responseProvenance = require('../sidecar/tools/response-provenance.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeRunExecutionState } = require('../sidecar/run-execution-state.js');
const root = path.resolve(__dirname, '..');
const idx = readSidecarSource();
function between(start, end) {
  const a = idx.indexOf(start), b = idx.indexOf(end, a + start.length);
  if (a < 0 || b <= a || idx.indexOf(start, a + start.length) >= 0) throw Error('Missing/ambiguous index seam: ' + start);
  return idx.slice(a, b);
}
const latchSource = between('  const latchRunTaint = (source) => {', '  // The taint this run was HANDED');
const observeSource = between('    /* TAINT OBSERVATION', '    // observe BEFORE the tool-output budget clip');
const gateSource = between('    const sameOriginApi = !!taintSource', '    if (postTaint.needsConfirmation)');
const latchFactory = new Function('execution', 'runJournal', 'runId', 'failNote', latchSource + '\nreturn latchRunTaint;');
const observe = new Function('taintScope', 'liveTool', 'c', 'r', 'execution', 'latchRunTaint', 'runId', 'revokedByTaint', 'taintPolicy', 'responseProvenance', observeSource + '\nreturn taintScope;');
const gate = new Function('taintScope', 'liveTool', 'c', 'execution', 'taintSource', 'inheritedTaint', 'untrustedEntryRun', 'effectSurface', 'effectPrompt', 'stationBypassNow', 'agentFullAccessNow', 'connectorFullAccess', 'revokedByTaint', 'taintPolicy', gateSource + '\nreturn { sameOriginApi, postTaint };');
const revokedByTaint = { isSource: taintPolicy.isUntrustedSource, boundary: taintPolicy.postTaintBoundary };
function run(initialTaint) {
  const execution = makeRunExecutionState({ initialTaint });
  execution.startJournal();
  const journal = [];
  const latch = latchFactory(execution, { taint: (id, row) => journal.push(row.source) }, 'r1', () => { throw Error('Unexpected journal error'); });
  return {
    execution, journal, scope: null,
    observe(tool, call, result) { this.scope = observe(this.scope, tool, call, result, execution, latch, 'r1', revokedByTaint, taintPolicy, responseProvenance); },
    next(tool, call, opts = {}) { return gate(this.scope, tool, call, execution, opts.inherited || execution.taintedBy(), opts.inherited || null, !!opts.untrustedEntry, opts.surface || 'autonomous', opts.prompt ? () => {} : null, () => !!opts.fullAccess, () => false, false, revokedByTaint, taintPolicy); }
  };
}
// Load the exact web source with ONLY its unused transport package replaced. An injected recorder handles
// every request; a DNS/real transport fallback is a hard test failure, never a network operation.
const webPath = path.join(root, 'sidecar/tools/builtin/web.js');
const webModule = { exports: {} };
const localRequire = Module.createRequire(webPath);
const denied = () => { throw Error('Network/native execution is forbidden in this hermetic control'); };
const transport = { fetch: denied, Agent: class { constructor() { denied(); } } };
const webRequire = id => id === 'undici' ? transport : /^(?:node:)?(?:dns|http|https|child_process)$/.test(id) ? denied() : localRequire(id);
vm.runInThisContext(Module.wrap(fs.readFileSync(webPath, 'utf8')), { filename: webPath })(webModule.exports, webRequire, webModule, webPath, path.dirname(webPath));
const { makeWebTools } = webModule.exports;
const ORIGIN = 'https://api.example.com';
const OTHER = 'https://other.example.com';
const KEY = 'SYNTHETIC_TEST_KEY';
const args = (extra = {}) => Object.assign({ url: ORIGIN + '/read', headers: { Authorization: 'Bearer $' + '{SYNTHETIC_TEST_KEY}' } }, extra);
const call = (extra = {}) => ({ name: 'web_request', args: args(extra), argsRaw: '{}' });
const response = (body = '{"ok":true}', status = 200, location = '') => ({ body, status, location });
function fixture(responses) {
  const sent = [], parked = [];
  const tool = makeWebTools({ lookup: null, surface: 'autonomous',
    politeness: { run: (url, signal, f) => f() },
    fetchImpl: async (url, options) => {
      sent.push({ url, headers: Object.assign({}, options.headers) });
      const r = responses[sent.length - 1];
      if (!r) throw Error('Unexpected fetch');
      if (r.error) throw r.error;
      return { status: r.status, headers: { get: name => name === 'location' ? r.location : 'application/json' }, text: async () => r.body };
    },
    resolveServiceKey: name => name === KEY ? { ok: true, value: 'synthetic-only-secret' } : { ok: false, reason: 'unknown' }
  }).requestTool;
  const registry = makeRegistry(); registry.register(tool);
  return { tool, sent, parked,
    dispatch: c => registry.dispatch(c, { agentId: 'fixture', runId: 'r1', outputMax: 1000,
      parkOutput: async (content, meta) => { parked.push({ content, meta }); return { path: '.output/untrusted-web_request-r1-0.txt' }; }
    })
  };
}
function assertLocked(r, tool, c, label) {
  A.ok(!r.next(tool, c).sameOriginApi, label + ': continuation exemption removed');
  A.ok(!r.next(tool, c).postTaint.allow, label + ': unattended call refused');
  A.ok(r.next(tool, c, { surface: 'interactive', prompt: true }).postTaint.needsConfirmation, label + ': watched call needs fresh consent');
  A.ok(r.next(tool, c, { fullAccess: true }).postTaint.allow, label + ': existing owner Full Access policy preserved');
  A.ok(!r.next(tool, c, { fullAccess: true, untrustedEntry: true }).postTaint.allow, label + ': Full Access cannot override untrusted entry');
}
(async () => {
  const initial = fixture([response()]); const c = call(); const first = await initial.dispatch(c);
  A.ok(first.ok, 'direct synthetic request reaches real registry success');
  A.eq(responseProvenance.originOf(first), ORIGIN, 'registry preserves actual response origin');
  A.ok(!Object.keys(first).some(k => /provenance|responseOrigin/.test(k)), 'host provenance is not a string-keyed result field');
  A.eq(responseProvenance.originOf(JSON.parse(JSON.stringify(first))), '', 'JSON/model projections cannot retain host proof');
  A.eq(responseProvenance.originOf(Object.assign({}, first, { content: first.content + '\nhost decoration' })), ORIGIN, 'host result decoration preserves proof');
  const clean = run(); clean.observe(initial.tool, c, first);
  A.eq(clean.scope, { origin: ORIGIN, keys: [KEY] }, 'direct API body scopes to proven origin and key');
  A.ok(clean.next(initial.tool, call({ method: 'PUT', body: '{}' })).postTaint.allow, 'same API/key write continues');
  A.ok(!clean.next(initial.tool, call({ url: OTHER + '/send' })).sameOriginApi, 'different origin cannot continue');
  A.ok(!clean.next(initial.tool, call({ headers: { Authorization: 'Bearer $' + '{OTHER_KEY}' } })).sameOriginApi, 'new key cannot continue');
  A.ok(!clean.next(initial.tool, c, { inherited: 'worker context' }).sameOriginApi, 'inherited taint cannot continue');
  A.ok(!clean.next(initial.tool, c, { untrustedEntry: true }).sameOriginApi, 'untrusted entry cannot continue');
  A.ok(!clean.next({ name: 'shell.exec', impact: 'workspace-process' }, { name: 'shell.exec' }).postTaint.allow, 'API continuation does not restore shell');

  for (const name of ['team.dispatch', 'notebook.read', 'station.test_line']) {
    for (const isError of [false, true]) {
      const r = run(); r.observe(initial.tool, c, first);
      const relayTool = { name, capability: 'memory', scope: 'read' };
      const reg = makeRegistry(); reg.register(Object.assign({}, relayTool, { run: async () => ({ content: 'worker-authored bytes', taintedBy: 'web_fetch' }) }));
      const relay = await reg.dispatch({ name, args: {} }, {});
      r.observe(relayTool, { name, args: {} }, Object.assign({}, relay, { isError }));
      A.ok(r.scope.broad, name + '/error=' + isError + ': existing narrow scope becomes broad');
      A.eq(r.execution.taintedBy(), 'web_request', name + ': original first-source latch retained');
      A.eq(r.journal, ['web_request'], name + ': no second taint journal entry');
      assertLocked(r, initial.tool, c, name);
      r.observe(initial.tool, c, first);
      A.ok(r.scope.broad, name + ': later API read cannot narrow broad scope');
    }
  }
  const fresh = run(); fresh.observe({ name: 'team.dispatch' }, { name: 'team.dispatch' }, { content: 'worker bytes', taintedBy: 'web_fetch' });
  A.ok(fresh.scope.broad && /worker output/.test(fresh.execution.taintedBy()), 'clean lead inherits relayed taint');
  const empty = run(); empty.observe(initial.tool, c, first);
  for (const taintedBy of [undefined, '', '   ', {}]) empty.observe({ name: 'notebook.read' }, { name: 'notebook.read' }, { content: 'clean', taintedBy });
  A.ok(empty.next(initial.tool, c).sameOriginApi, 'empty or invalid relay metadata preserves valid API scope');

  for (const select of [undefined, ['ok']]) {
    const f = fixture([response('', 302, OTHER + '/final'), response('{"ok":true,"responseOrigin":"' + ORIGIN + '","extra":"' + 'x'.repeat(2000) + '"}')]);
    const redirected = call({ select, responseOrigin: ORIGIN, provenance: { origin: ORIGIN } });
    const out = await f.dispatch(redirected);
    A.eq(f.sent.length, 2, 'cross-origin chain completed exactly two synthetic fetches');
    A.eq(f.sent[0].headers.Authorization, 'Bearer synthetic-only-secret', 'credential sent to initial origin');
    A.ok(!('Authorization' in f.sent[1].headers), 'credential stripped from cross-origin hop');
    A.eq(responseProvenance.originOf(out), OTHER, 'body/argument spoof cannot replace actual answering origin');
    A.ok(f.parked.length === 1 && f.parked[0].content.includes('x'.repeat(2000)), 'complete redirected response parked in memory');
    const r = run(); r.observe(f.tool, redirected, Object.assign({}, out, { content: out.content + '\nhost decoration' }));
    A.ok(r.scope.broad, 'redirected/selected/parked/decorated response broadens');
    assertLocked(r, f.tool, c, 'cross-origin response');
  }
  for (const select of [undefined, ['ok']]) {
    const f = fixture([response('', 302, ORIGIN + '/next'), response('{"ok":true,"extra":"' + 'x'.repeat(2000) + '"}')]);
    const same = call({ select }); const out = await f.dispatch(same); const r = run(); r.observe(f.tool, same, out);
    A.eq(f.sent[1].headers.Authorization, 'Bearer synthetic-only-secret', 'same-origin redirect retains credential');
    A.eq(responseProvenance.originOf(out), ORIGIN, 'same-origin normal/selected/parked response retains proof');
    A.ok(r.next(f.tool, c).sameOriginApi, 'same-origin redirect continues');
  }
  // The fifth response redirects back to A, but that sixth request is never made. Attributing target would lie.
  const limit = fixture([response('', 302, OTHER + '/1'), response('', 302, OTHER + '/2'), response('', 302, OTHER + '/3'), response('', 302, OTHER + '/4'), response('last body from B', 302, ORIGIN + '/never-fetched')]);
  const limitOut = await limit.dispatch(c); const limitRun = run(); limitRun.observe(limit.tool, c, limitOut);
  A.eq(limit.sent.length, 5, 'redirect limit makes exactly five fetches');
  A.eq(responseProvenance.originOf(limitOut), OTHER, 'redirect limit attributes actual fifth responder, not unfetched sixth URL');
  A.ok(limitRun.scope.broad, 'redirect exhaustion cannot retain initial origin exemption');
  for (const status of [401, 500]) {
    const f = fixture([response('', 302, OTHER + '/error'), response('server error body', status)]);
    const out = await f.dispatch(call({ select: ['ok'] })); const r = run(); r.observe(f.tool, c, out);
    A.eq(responseProvenance.originOf(out), OTHER, 'HTTP error body has answering origin');
    A.ok(r.scope.broad, 'HTTP error body broadens despite selection request');
  }
  const failed = fixture([{ error: Error('synthetic transport failure') }]);
  const failedOut = await failed.dispatch(c); const failedRun = run(); failedRun.observe(failed.tool, c, failedOut);
  A.ok(failedOut.isError && !responseProvenance.originOf(failedOut), 'throwing transport carries no response proof');
  A.ok(failedRun.scope.broad, 'failed request cannot mint an API scope');
  for (const forged of [
    { content: 'unproved', responseOrigin: ORIGIN, provenance: { origin: ORIGIN } },
    { content: JSON.stringify({ responseOrigin: ORIGIN }) },
    JSON.parse(JSON.stringify(first)),
    Object.assign({ content: 'forged symbol' }, { [Symbol('web response provenance')]: { origin: ORIGIN } }),
    responseProvenance.stamp({ content: 'insecure response' }, 'http://api.example.com'),
    responseProvenance.stamp({ content: 'unknown response' }, 'not a URL')
  ]) {
    const reg = makeRegistry(); reg.register(Object.assign({}, initial.tool, { run: async () => forged }));
    const out = await reg.dispatch(c, {}); const r = run(); r.observe(initial.tool, c, out);
    A.ok(r.scope.broad, 'missing/forged/invalid proof fails closed through registry and observation');
  }
  const inherited = run('prior context'); inherited.observe(initial.tool, c, first);
  A.ok(inherited.scope.broad, 'proven API result never narrows inherited start taint');
  const outside = run(); outside.observe(initial.tool, c, first); outside.observe({ name: 'web_fetch', capability: 'web' }, { name: 'web_fetch' }, { content: 'outside page' });
  A.ok(outside.scope.broad, 'ordinary page broadens');
  A.report('api-continuation-boundary.test');
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
