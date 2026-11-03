/* Owned proxy shutdown must settle with HTTP, CONNECT, upgrade, DNS and dial work still open.
   Loopback fixtures only; the pending dial is injected and never contacts an external address. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http'), net = require('node:net'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { startPinnedProxy } = require('../sidecar/tools/builtin/browser-proxy.js');
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const tick = () => new Promise(resolve => setImmediate(resolve));
function bounded(promise, label) {
  let timer;
  return Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(Error(label + ' did not settle')), 5000); })]).finally(() => clearTimeout(timer));
}
function wire(mode, port) {
  if (mode === 'connect') return 'CONNECT fixture.test:' + port + ' HTTP/1.1\r\nHost: fixture.test\r\n\r\n';
  return 'GET ' + (mode === 'upgrade' ? 'ws:' : 'http:') + '//fixture.test:' + port + '/open HTTP/1.1\r\nHost: fixture.test\r\n' + (mode === 'upgrade' ? 'Connection: Upgrade\r\nUpgrade: websocket\r\n' : '') + '\r\n';
}
async function clientFor(port) {
  const socket = net.connect(port, '127.0.0.1');
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.on('error', () => {});
  try { await bounded(new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); }), 'fixture client connect'); }
  catch (e) { socket.destroy(); throw e; }
  return { socket, closed };
}
async function cleanup(proxy, client, server, sockets = []) {
  // Even a regression in proxy.close must not strand the independent fixture listener.
  try {
    if (client) client.socket.destroy();
    for (const socket of sockets) socket.destroy();
    if (proxy) await bounded(proxy.close(), 'proxy cleanup');
  } finally {
    if (server) {
      const closed = new Promise((resolve, reject) => server.close(e => e && e.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(e) : resolve()));
      if (server.closeAllConnections) server.closeAllConnections();
      await bounded(closed, 'fixture server cleanup');
    }
  }
}
const proxySource = fs.readFileSync(path.join(__dirname, '../sidecar/tools/builtin/browser-proxy.js'), 'utf8');
function loadProxy(netImpl, httpImpl = http, source = proxySource) {
  const scope = { module: { exports: {} }, URL, require(id) {
    if (id === 'node:http') return httpImpl;
    if (id === 'node:net') return netImpl;
    if (id === '../../failopen.js') return { note() {} };
    if (id === '../../net/safe-egress.js') return require('../sidecar/net/safe-egress.js');   // the boundary's pinned lookup
    throw Error('Unexpected proxy dependency: ' + id);
  } };
  vm.runInNewContext(source, scope);
  return scope.module.exports.startPinnedProxy;
}
function request(port, target, agent) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: target, agent, headers: { Connection: 'keep-alive' } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body })); res.on('error', reject);
    });
    req.on('error', reject);
  });
}

// Both candidate and historical negative control use the same isolated default-agent facade.
// It never replaces http.globalAgent; every agent and socket here belongs to this fixture.
async function poolOwnership(source, expectShared) {
  const sharedAgent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  const clientAgent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  const agents = new Set([sharedAgent, clientAgent]), freeListeners = [], exchanges = new Map();
  const facade = { ...http, globalAgent: sharedAgent, request(options, callback) {
    const agent = options.agent === undefined ? sharedAgent : options.agent;
    agents.add(agent);
    const outgoing = http.request({ ...options, agent }, callback);
    let markFree;
    const exchange = { outgoing, free: new Promise(resolve => { markFree = resolve; }) };
    exchanges.set(options.path, exchange);
    outgoing.once('socket', socket => {
      exchange.socket = socket;
      const onFree = freed => { if (freed === socket) { agent.removeListener('free', onFree); markFree(); } };
      agent.on('free', onFree); freeListeners.push(() => agent.removeListener('free', onFree));
    });
    return outgoing;
  } };
  const start = loadProxy(net, facade, source);
  let proxyA, proxyB, activeResponse, started, heldSocketClosed;
  const active = new Promise(resolve => { started = resolve; });
  const ids = new Map(), seen = [];
  const server = http.createServer((req, res) => {
    if (!ids.has(req.socket)) ids.set(req.socket, ids.size + 1);
    seen.push({ path: req.url, socketId: ids.get(req.socket), connection: req.headers.connection });
    if (req.url === '/held') {
      activeResponse = res;
      heldSocketClosed = new Promise(resolve => req.socket.once('close', resolve));
      started();
    } else res.end('first');
  });
  try {
    const port = await listen(server);
    const deps = { validate: url => new URL(url), resolve: async () => ({ address: '127.0.0.1' }) };
    proxyA = await start(deps); proxyB = await start(deps);
    for (const route of ['/first', '/again']) {
      A.eq(await bounded(request(proxyA.port, 'http://fixture.test:' + port + route, clientAgent), 'proxy A response'),
        { status: 200, body: 'first' }, 'proxy A completes ' + route);
      await bounded(exchanges.get(route).free, 'proxy A exact socket returns to its pool');
    }
    A.eq(seen[0].socketId, seen[1].socketId, 'proxy A actually reuses its upstream socket');
    A.eq(exchanges.get('/again').outgoing.reusedSocket, true, 'second outgoing request confirms keep-alive reuse');
    const response = request(proxyB.port, 'http://fixture.test:' + port + '/held', clientAgent)
      .then(value => ({ response: value }), error => ({ error: { code: error.code || null, message: error.message } }));
    await bounded(active, 'proxy B held same-origin request');
    A.eq(seen.map(item => String(item.connection).toLowerCase()), ['keep-alive', 'keep-alive', 'keep-alive'],
      'all three upstream requests explicitly carry keep-alive');
    const samePoolSocket = seen[1].socketId === seen[2].socketId;
    A.eq(samePoolSocket, expectShared, expectShared
      ? 'negative control proves B borrowed the exact socket retained by A'
      : 'separate proxy pools give B a distinct upstream socket');
    A.eq(exchanges.get('/again').socket === exchanges.get('/held').socket, expectShared,
      'outgoing socket identity independently agrees with upstream readback');
    await bounded(proxyA.close(), 'proxy A close while B response is held');
    if (expectShared) await bounded(heldSocketClosed, 'negative control observes B upstream interrupted by A close');
    activeResponse.end('second survived');
    const outcome = await bounded(response, 'proxy B terminal response');
    if (expectShared) {
      A.ok((outcome.response && outcome.response.status === 502) ||
        (outcome.error && ['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(outcome.error.code)),
        'negative control observes an interrupted B request, never a timeout or arbitrary failure');
    } else A.eq(outcome, { response: { status: 200, body: 'second survived' } },
      'closing A leaves the held request through B intact');
    console.log('PROXY_POOL_OWNERSHIP_RECEIPT ' + JSON.stringify({
      sourceSha256: crypto.createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex'),
      control: expectShared ? 'shared-pool-negative' : 'candidate', requests: seen,
      reusedWithinA: exchanges.get('/again').outgoing.reusedSocket, samePoolSocket, outcome
    }));
  } finally {
    if (activeResponse) activeResponse.end();
    for (const remove of freeListeners) remove();
    for (const agent of agents) agent.destroy();
    try { await cleanup(proxyA); } finally { await cleanup(proxyB, null, server); }
  }
}

(async () => {
  if (process.argv[2] === '--shared-pool-negative-control') {
    if (!process.argv[3]) throw Error('Pass the exported bf473eb6b browser-proxy.js path');
    const source = fs.readFileSync(process.argv[3], 'utf8').replace(/\r\n/g, '\n');
    if (crypto.createHash('sha256').update(source).digest('hex') !== '3595b57085c9b740f0b3fcf64ee075021356194502458e28e7257af04f15cf62')
      throw Error('Negative control requires the exact bf473eb6b browser-proxy.js blob');
    await poolOwnership(source, true);
    A.report('browser-proxy-cleanup.shared-pool-negative-control');
    return;
  }
  for (const mode of ['http', 'connect', 'upgrade']) {
    const upstreams = new Set();
    let hits = 0, upstreamClosed, proxy, client;
    const closedUpstream = new Promise(resolve => { upstreamClosed = resolve; });
    const server = net.createServer(socket => {
      socket.once('close', upstreamClosed);
      hits++; upstreams.add(socket); socket.on('close', () => upstreams.delete(socket)); socket.on('error', () => {});
      if (mode !== 'connect') socket.once('data', () => socket.write(mode === 'upgrade'
        ? 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
        : 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n'));
      socket.resume();   // consume FIN even when a CONNECT tunnel has no application bytes
    });
    try {
      const port = await listen(server);
      proxy = await startPinnedProxy({ validate: url => new URL(url), resolve: async () => ({ address: '127.0.0.1' }) });
      client = await clientFor(proxy.port);
      let data = '';
      const ready = new Promise(resolve => client.socket.on('data', chunk => { data += chunk; if (data.includes(mode === 'http' ? 'abc' : mode === 'upgrade' ? '101 Switching' : '200 Connection')) resolve(); }));
      client.socket.write(wire(mode, port));
      await bounded(ready, mode + ' fixture response');
      A.eq(hits, 1, mode + ' establishes exactly one owned upstream');
      const closed = proxy.close();
      A.ok(proxy.close() === closed, mode + ' repeated close shares its result');
      await bounded(closed, mode + ' proxy close');
      await bounded(client.closed, mode + ' client close');
      await bounded(closedUpstream, mode + ' upstream close');
      A.eq(proxy.listening(), false, mode + ' proxy is no longer listening');
      A.eq(upstreams.size, 0, mode + ' upstream connection is closed');
      A.eq(server.listening, true, mode + ' closing proxy leaves the separate fixture server running');
    } finally { await cleanup(proxy, client, server, upstreams); }
  }

  for (const mode of ['http', 'connect', 'upgrade']) {
    let release, asked, proxy, client, dials = 0;
    const pending = new Promise(resolve => { release = resolve; });
    const requested = new Promise(resolve => { asked = resolve; });
    let hits = 0;
    const server = net.createServer(socket => { hits++; socket.destroy(); });
    const start = loadProxy({ ...net, connect(...args) { dials++; return net.connect(...args); } },
      { ...http, request(...args) { dials++; return http.request(...args); } });
    try {
      const port = await listen(server);
      proxy = await start({ validate: url => new URL(url), resolve: async () => { asked(); await pending; return { address: '127.0.0.1' }; } });
      client = await clientFor(proxy.port);
      client.socket.write(wire(mode, port));
      await bounded(requested, mode + ' DNS start');
      await bounded(proxy.close(), mode + ' close during DNS');
      await bounded(client.closed, mode + ' DNS client close');
      release(); await tick(); await tick();
      A.eq(dials, 0, mode + ' resolving after close cannot even attempt an upstream');
      A.eq(hits, 0, mode + ' late DNS never reaches the fixture server');
      A.eq(proxy.listening(), false, mode + ' closes without waiting for DNS');
    } finally { release(); await cleanup(proxy, client, server); }
  }

  // The connect callback can arrive after shutdown. Inject the dialing socket, keep the HTTP listener real.
  {
    let dialed, destroyed = 0, writes = 0, proxy, client;
    const dialing = new Promise(resolve => { dialed = resolve; });
    const upstream = new EventEmitter();
    upstream.destroy = () => { if (!upstream.destroyed) { upstream.destroyed = true; destroyed++; queueMicrotask(() => upstream.emit('close')); } };
    upstream.write = () => { writes++; }; upstream.pipe = () => { writes++; };
    const start = loadProxy({ isIP: net.isIP, connect() { dialed(); return upstream; } });
    try {
      proxy = await start({ validate: url => new URL(url), resolve: async () => ({ address: '127.0.0.1' }) });
      client = await clientFor(proxy.port);
      client.socket.write(wire('connect', 54321));
      await bounded(dialing, 'pending dial creation');
      await bounded(proxy.close(), 'pending dial close');
      await bounded(client.closed, 'pending dial client close');
      upstream.emit('connect');
      A.eq(destroyed, 1, 'close destroys the exact owned pending dial');
      A.eq(writes, 0, 'late dial callback cannot establish a tunnel after shutdown');
    } finally { upstream.destroy(); await cleanup(proxy, client); }
  }

  await poolOwnership(proxySource, false);
  A.report('browser-proxy-cleanup.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
