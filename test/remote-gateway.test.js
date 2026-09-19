'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createGateway, createClient } = require('../remote/gateway');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); };

test('gateway requires the verified numeric GitHub owner, expires sessions and never retries mutations', async () => {
  let calls = 0, time = 100;
  const runtime = http.createServer((req, res) => { calls++; res.setHeader('Content-Type', 'text/html'); res.end('<head></head>station'); });
  const runtimePort = await listen(runtime);
  const gateway = createGateway({ runtimePort, runtimeToken: 'private', ownerId: 42, now: () => time, sessionMs: 1000,
    verifyIdentity: async token => { if (token === 'bad') throw Error('bad'); return { id: token === 'owner' ? 42 : 43, login: 'owner' }; } });
  const base = 'http://127.0.0.1:' + await listen(gateway);
  const login = token => fetch(base + '/remote/login', { method: 'POST', body: JSON.stringify({ githubToken: token }) });
  try {
    for (const route of ['/', '/remote/bootstrap', '/api/state/snapshot', '/api/run', '/app/app.js']) assert.equal((await fetch(base + route)).status, 401);
    assert.equal(calls, 0);
    assert.equal((await login('bad')).status, 401);
    assert.equal((await login('someone')).status, 403);
    const session = await (await login('owner')).json();
    const headers = { Authorization: 'Bearer ' + session.token };
    const html = await (await fetch(base + '/', { headers })).text();
    assert.match(html, /__STARNET_REMOTE__/);
    const bootstrap = await fetch(base + '/remote/bootstrap', { headers });
    assert.deepEqual(await bootstrap.json(), { token: 'private' }, 'only the authenticated gateway can renew the station token');
    assert.equal((await fetch(base + '/remote/bootstrap', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(base + '/', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    assert.equal(await new Promise(resolve => { const r = http.get(base + '/', { headers: { ...headers, Host: 'evil.example' } }, reply => { reply.resume(); resolve(reply.statusCode); }); r.on('error', () => resolve(0)); }), 403);
    assert.equal(calls, 1);
    time += 1001;
    assert.equal((await fetch(base + '/api/run', { method: 'POST', headers })).status, 401);
    assert.equal(calls, 1);
  } finally { await close(gateway); await close(runtime); }
});
test('local proxy rejects malicious origins and carries SSE immediately through both hops', async () => {
  const runtime = http.createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('id: epoch:1\ndata: {"live":true}\n\n');
    } else { res.writeHead(403); res.end('forbidden token'); }
  });
  const runtimePort = await listen(runtime);
  const gateway = createGateway({ runtimePort, runtimeToken: 'private', ownerId: 42, verifyIdentity: async () => ({ id: 42, login: 'owner' }) });
  const gatewayPort = await listen(gateway);
  const session = await (await fetch('http://127.0.0.1:' + gatewayPort + '/remote/login', { method: 'POST', body: JSON.stringify({ githubToken: 'test' }) })).json();
  const client = createClient({ gatewayPort, localPort: 8790, getSession: async () => session });
  const base = 'http://127.0.0.1:' + await listen(client);
  try {
    assert.equal((await fetch(base + '/events', { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(base + '/api/run', { method: 'POST' })).status, 403);
    const start = Date.now(), ac = new AbortController();
    const response = await fetch(base + '/events', { signal: ac.signal });
    const frame = await response.body.getReader().read();
    assert.match(new TextDecoder().decode(frame.value), /epoch:1/);
    assert.ok(Date.now() - start < 500, 'SSE must flush without waiting for stream completion');
    ac.abort();
  } finally { await close(client); await close(gateway); await close(runtime); }
});

test('gateway reuses its runtime connection without retrying requests', async () => {
  const sockets = new Set(); let calls = 0;
  const runtime = http.createServer((req, res) => { sockets.add(req.socket); calls++; res.end('ok'); });
  const runtimePort = await listen(runtime);
  const gateway = createGateway({ runtimePort, runtimeToken: 'test', ownerId: 42, verifyIdentity: async () => ({ id: 42, login: 'fixture' }) });
  const base = 'http://127.0.0.1:' + await listen(gateway);
  try {
    const session = await (await fetch(base + '/remote/login', { method: 'POST', body: JSON.stringify({ githubToken: 'fixture' }) })).json();
    for (let i = 0; i < 4; i++) {
      const reply = await fetch(base + '/api/fixture', { method: 'POST', headers: { Authorization: 'Bearer ' + session.token }, body: '{}' });
      assert.equal(await reply.text(), 'ok');
    }
    assert.equal(calls, 4, 'exactly one upstream request per caller');
    assert.equal(sockets.size, 1, 'sequential requests reuse one TCP connection');
  } finally { await close(gateway); await close(runtime); }
});

test('viewer connection controls require same-origin custom-header requests and serialize changes', async () => {
  let sessions = 0, disconnects = 0, reconnects = 0, release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const client = createClient({ gatewayPort: 1, localPort: 8790, getSession: async () => { sessions++; throw Error('offline'); }, connection: {
    status: () => ({ host: 'fixture-server', paused: disconnects > reconnects }),
    disconnect: async () => { disconnects++; entered(); await new Promise(resolve => { release = resolve; }); },
    reconnect: async () => { reconnects++; }
  } });
  const base = 'http://127.0.0.1:' + await listen(client);
  const headers = { 'x-starnet-client': '1', 'Content-Type': 'application/json' };
  const post = (action, extra = {}) => fetch(base + '/remote/client/' + action, { method: 'POST', headers: { ...headers, ...extra }, body: '{}' });
  try {
    assert.equal((await fetch(base + '/remote/client/status')).status, 403);
    assert.equal((await post('disconnect', { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('disconnect', { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await fetch(base + '/remote/client/disconnect', { headers })).status, 405);
    assert.deepEqual(await (await fetch(base + '/remote/client/status', { headers })).json(), { host: 'fixture-server', paused: false });
    const disconnect = post('disconnect'); await started;
    assert.equal((await post('reconnect')).status, 409);
    release(); assert.equal((await disconnect).status, 200);
    assert.equal((await (await fetch(base + '/remote/client/status', { headers })).json()).paused, true);
    assert.equal((await post('reconnect')).status, 200);
    assert.equal(sessions, 0, 'controls remain usable offline and never authenticate or forward a runtime request');
    assert.equal(disconnects, 1); assert.equal(reconnects, 1);
  } finally { release?.(); await close(client); }
});


test('JSON bodies preserve multibyte characters across chunks and enforce byte limits', async () => {
  const { Readable } = require('node:stream');
  const { readJson } = require('../remote/gateway');
  const bytes = Buffer.from(JSON.stringify({ text: 'Station α 🌍' }));
  const split = bytes.indexOf(Buffer.from('🌍')) + 1;
  const chunks = [bytes.subarray(0, split), bytes.subarray(split)];
  assert.deepEqual(await readJson(Readable.from(chunks), bytes.length), { text: 'Station α 🌍' });
  await assert.rejects(readJson(Readable.from(chunks), bytes.length - 1), /too large/);
});

test('HTML injection preserves UTF-8 when the runtime splits a code point', async () => {
  const bytes = Buffer.from('<head></head><body>Station 🌍</body>');
  const split = bytes.indexOf(Buffer.from('🌍')) + 1;
  const runtime = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.write(bytes.subarray(0, split));
    setImmediate(() => res.end(bytes.subarray(split)));
  });
  const gateway = createGateway({ runtimePort: await listen(runtime), runtimeToken: 'fixture', ownerId: 42,
    verifyIdentity: async () => ({ id: 42, login: 'fixture' }) });
  const base = 'http://127.0.0.1:' + await listen(gateway);
  try {
    const session = await (await fetch(base + '/remote/login', { method: 'POST', body: JSON.stringify({ githubToken: 'fixture' }) })).json();
    const html = await (await fetch(base + '/', { headers: { Authorization: 'Bearer ' + session.token } })).text();
    assert.ok(html.includes('Station 🌍'));
    assert.ok(html.includes('__STARNET_REMOTE__'));
    assert.ok(!html.includes('�'));
  } finally { await close(gateway); await close(runtime); }
});
