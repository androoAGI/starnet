'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { makeProxy, privateIPv4 } = require('./lan.cjs');

test('only private IPv4 networks are accepted', () => {
  for (const ip of ['172.26.61.46', '192.168.1.8', '10.1.2.3', '::ffff:127.0.0.1']) assert.equal(privateIPv4(ip), true);
  for (const ip of ['8.8.8.8', '0.0.0.0', '100.92.167.126', '172.32.1.1', '192.168.1.999', '::1']) assert.equal(privateIPv4(ip), false);
});

test('Tailscale mode requires an exact HTTPS origin and loopback bind', () => {
  const args = { host: '127.0.0.1', port: 8792, username: 'lab', password: 'test-only' };
  assert.throws(() => makeProxy(args), /explicit Tailscale/);
  assert.throws(() => makeProxy({ ...args, publicOrigin: 'https://attacker.invalid' }), /Tailscale HTTPS/);
  assert.throws(() => makeProxy({ ...args, publicOrigin: 'http://test.ts.net' }), /Tailscale HTTPS/);
  assert.throws(() => makeProxy({ ...args, host: '192.168.1.20', publicOrigin: 'https://test.ts.net:8791' }), /Tailscale HTTPS/);
  assert.ok(makeProxy({ ...args, publicOrigin: 'https://test.ts.net:8791' }));
});

test('password, Host and Origin are enforced before forwarding; SSE and API token survive', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: local-lab\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = makeProxy({ host: '192.168.1.20', port: 8791, username: 'lab', password: 'test-only', upstreamPort: upstream.address().port });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const send = headers => new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: proxy.address().port, headers }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ code: res.statusCode, text }));
    });
    req.on('error', reject);
  });
  try {
    const host = '192.168.1.20:8791';
    const authorization = 'Basic ' + Buffer.from('lab:test-only').toString('base64');
    assert.equal((await send({ host })).code, 401);
    assert.equal((await send({ host, authorization: 'Basic wrong' })).code, 401);
    assert.equal((await send({ host: 'attacker.invalid', authorization })).code, 403);
    assert.equal((await send({ host, authorization, origin: 'http://attacker.invalid' })).code, 403);
    assert.equal(seen.length, 0);
    const response = await send({ host, authorization, origin: 'http://' + host, 'x-starnet-token': 'test-token', 'x-forwarded-for': '8.8.8.8' });
    assert.equal(response.code, 200);
    assert.match(response.text, /data: local-lab/);
    assert.equal(seen[0].host, '127.0.0.1:' + upstream.address().port);
    assert.equal(seen[0].origin, 'http://127.0.0.1:' + upstream.address().port);
    assert.equal(seen[0]['x-starnet-token'], 'test-token');
    assert.equal(seen[0].authorization, undefined);
    assert.equal(seen[0]['x-forwarded-for'], undefined);
  } finally {
    await new Promise(resolve => proxy.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
  }
});
