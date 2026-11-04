'use strict';
/* Actual OAuth consumers + real undici/socket ownership. Only the transport edge
   substitutes a validated public address for this test's allocated loopback server
   and HTTPS for HTTP; TLS/classification are covered by safe-egress.real-socket.
   The probe body is extracted from index.js, not reimplemented in the fixture. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const Module = require('node:module'), vm = require('node:vm');
const { Agent, fetch } = require('undici');
const A = require('./_assert.js');
const { makeConnectorOauthFetch } = require('../sidecar/mcp/oauth-fetch.js');
const source = require('./helpers/source.js');
const oauthPath = require.resolve('../sidecar/mcp/oauth.js');
let O = require(oauthPath);
if (process.env.OAUTH_BODY_CONTROL) {
  const old = new Module(oauthPath, module); old.filename = oauthPath; old.paths = Module._nodeModulePaths(path.dirname(oauthPath));
  old._compile(fs.readFileSync(process.env.OAUTH_BODY_CONTROL, 'utf8'), oauthPath); O = old.exports;
}
const index = process.env.OAUTH_PROBE_CONTROL ? fs.readFileSync(process.env.OAUTH_PROBE_CONTROL, 'utf8') : source.readSidecarIndex();
const start = index.indexOf('// best-effort: read the 401 WWW-Authenticate pointer');
const end = index.indexOf('    const disc = await mcpOauth.discover(', start);
if (start < 0 || end <= start) throw new Error('exact authorization probe boundary missing');
const probe = vm.compileFunction('return (async () => {\n' + index.slice(start, end) + '\nreturn www; })();',
  ['mcpOauth', 'net', 'connectorOauthFetch', 'entry']);
const POINTER = 'Bearer resource_metadata="https://auth.body.example/metadata"';
const settle = async fn => { try { return { value: await fn() }; } catch (error) { return { error }; } };
async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}
async function allocated(mode, run) {
  const events = [], requests = [], agents = [], closeErrors = [], responses = [];
  let response, socketClosed, agentClosed;
  const closedSocket = new Promise(resolve => { socketClosed = resolve; });
  const closedAgent = new Promise(resolve => { agentClosed = resolve; });
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, host: req.headers.host });
    events.push('request'); response = res;
    req.socket.once('close', () => { events.push('socket-closed'); socketClosed(); });
    if (mode === 'json') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"fixture":true}');
    } else {
      const status = mode === 'metadata-redirect' ? 302 : mode === 'metadata-error' ? 404 : mode === 'probe-401' ? 401 : 200;
      res.writeHead(status, { 'content-type': 'text/event-stream', 'www-authenticate': POINTER,
        ...(status === 302 ? { location: 'http://127.0.0.1/never-follow' } : {}) });
      res.write('data: first\n\n'); // An unread body deliberately remains open; only the owner can release it.
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port, url = 'https://auth.body.example:' + port + '/mcp';
  const transport = makeConnectorOauthFetch({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    onCloseError: error => closeErrors.push(error.message),
    agentFactory: options => {
      const agent = new Agent({ ...options, connect: { ...options.connect, lookup(host, opts, cb) {
        options.connect.lookup(host, opts, (error, answer, family) => {
          if (error) return cb(error);
          if (Array.isArray(answer)) return cb(null, answer.map(row => ({ address: '127.0.0.1', family: row.family })));
          cb(null, '127.0.0.1', family);
        });
      } } });
      agents.push(agent);
      return { dispatch: agent.dispatch.bind(agent), close: async () => {
        events.push('close-start'); await agent.close(); events.push('close-done'); agentClosed();
      } };
    },
    fetchImpl: async (target, init) => {
      A.eq(init.redirect, 'manual', mode + ': actual wrapper retains manual redirects');
      if (init.signal) init.signal.addEventListener('abort', () => events.push('request-aborted'), { once: true });
      const local = new URL(target); local.protocol = 'http:';
      const response = await fetch(local, init);
      responses.push(response); // Keep abandoned bodies reachable: GC is not consumer-owned cleanup.
      return response;
    }
  });
  const client = transport.connectorOauthFetch;
  try {
    await run({ client, url, events, requests, response: () => response,
      closed: () => within(Promise.all([closedAgent, closedSocket]), 1500) });
    A.eq(requests.map(r => r.host), ['auth.body.example:' + port], mode + ': exactly one request retains the validated Host');
    A.eq(responses.length, 1, mode + ': actual Response is retained until owned teardown');
    A.eq(closeErrors, [], mode + ': graceful close reports no error');
    console.log(JSON.stringify({ case: mode, events, requests, agents: agents.length }));
  } finally {
    // Only this case's allocated server and owned dispatchers are terminated.
    // Control failures are observed before teardown; forced teardown is never proof.
    for (const agent of agents) await agent.destroy();
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    responses.length = 0;
  }
}
(async () => {
  for (const mode of ['metadata-error', 'metadata-redirect']) await allocated(mode, async t => {
    const result = await settle(() => O.discover({ serverUrl: t.url, fetchImpl: t.client, timeoutMs: 10000 }));
    A.ok(result.error && result.error.message.includes('HTTP ' + (mode === 'metadata-error' ? 404 : 302)), mode + ': actual discovery preserves its HTTP refusal');
    A.eq(t.requests.length, 1, mode + ': rejection follows one request, no redirect or later discovery');
    A.ok(await t.closed(), mode + ': rejected unread body releases its socket and pinned dispatcher');
    A.ok(!t.events.includes('request-aborted'), mode + ': release does not rely on the OAuth deadline abort');
  });
  for (const mode of ['probe-401', 'probe-stream']) await allocated(mode, async t => {
    const www = await probe(O, { timeoutMs: 10000 }, t.client, { url: t.url });
    A.eq(www, POINTER, mode + ': exact host probe preserves the metadata pointer');
    A.eq(t.requests.map(r => r.method), ['POST'], mode + ': actual initialize probe makes one POST');
    A.ok(await t.closed(), mode + ': header-only consumer releases its unread body before moving on');
    A.ok(!t.events.includes('request-aborted'), mode + ': release does not rely on the removed probe deadline');
  });
  await allocated('json', async t => {
    const value = await O._internals.getJson(t.client, t.url, 'fixture metadata', { timeoutMs: 10000 });
    A.eq(value, { fixture: true }, 'normal metadata JSON is consumed successfully');
    A.ok(await t.closed(), 'consumed metadata closes its owned dispatcher');
    A.ok(!t.events.includes('request-aborted'), 'successful JSON read is not aborted');
  });
  await allocated('stream', async t => {
    const res = await t.client(t.url, { method: 'GET' });
    const reader = res.body.getReader();
    const first = await reader.read();
    A.eq(new TextDecoder().decode(first.value), 'data: first\n\n', 'returned streaming Response remains readable by its real consumer');
    A.ok(!t.events.includes('close-done'), 'background graceful close waits while the legitimate reader owns the stream');
    t.response().end('data: last\n\n');
    let rest = '';
    for (;;) { const part = await reader.read(); if (part.done) break; rest += new TextDecoder().decode(part.value); }
    reader.releaseLock();
    A.eq(rest, 'data: last\n\n', 'later stream content is not prematurely cancelled by the fetch wrapper');
    A.ok(await t.closed(), 'completed streaming response releases its owned dispatcher');
  });
  A.report('mcp.oauth-body-close');
})().catch(error => { console.error(error); process.exitCode = 1; });
