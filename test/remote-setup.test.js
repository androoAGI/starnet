'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), net = require('node:net');
const { EventEmitter } = require('node:events');
const { connectionConfig, saveConfig, saveConnection, readConfig, sshArgs } = require('../remote/config');
const { SetupController, createSetupServer } = require('../remote/setup');
const { probeConnection } = require('../remote/connection');
const { createGateway } = require('../remote/gateway');
const { terminalScript } = require('../remote/desktop');
const baseConfig = { host: 'alice@example.test', owner: 42, port: 8790, 'gateway-port': 18791 };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function done(controller) { for (let n = 0; n < 100 && controller.job; n++) await tick(); assert.equal(controller.job, null); }
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-setup-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, 'config.json'); }
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
function close(server) { server.closeAllConnections?.(); server.close(); }

test('connection settings reject command injection and persist atomically with private permissions', t => {
  const file = temp(t);
  saveConfig({ ...baseConfig, 'ssh-port': 22222 }, file);
  assert.deepEqual(readConfig(file), { ...baseConfig, 'ssh-port': 22222 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  for (const host of ['-oProxyCommand=evil', 'user@host;touch x', 'host\nnext', 'ssh://host', 'a b', 'a@b@c']) assert.throws(() => saveConfig({ ...baseConfig, host }, file));
  assert.equal(readConfig(file).host, baseConfig.host);
  assert.throws(() => connectionConfig({ ...baseConfig, 'ssh-port': 0.1 }));
  assert(sshArgs(baseConfig).includes('StrictHostKeyChecking=yes'));
  assert(sshArgs(baseConfig, true).includes('StrictHostKeyChecking=ask'));
});

test('failed and cancelled checks retain the working connection, including late completions', async t => {
  const file = temp(t); saveConfig(baseConfig, file);
  let release, applied = 0;
  const controller = new SetupController({ config: baseConfig, configFile: file, profile: async () => ({ id: 42, login: 'alice' }), probe: () => new Promise(resolve => { release = resolve; }), onSave: () => applied++ });
  controller.test({ host: 'new-server' }); await tick();
  controller.cancel(); release(); await tick();
  assert.equal(readConfig(file).host, baseConfig.host); assert.equal(applied, 0);
  controller.probe = async () => { throw new Error('Wrong owner'); };
  controller.test({ host: 'new-server' }); await done(controller);
  assert.equal(controller.state.phase, 'error'); assert.equal(readConfig(file).host, baseConfig.host);
  controller.probe = async cfg => assert.equal(cfg.owner, 42);
  controller.test({ host: 'new-server', owner: 999 }); await done(controller);
  assert.equal(controller.state.phase, 'connected'); assert.equal(applied, 1);
  assert.equal(readConfig(file).owner, 42, 'owner comes from authenticated GitHub identity, not the form');
  assert.equal(readConfig(file).host, 'new-server');
});

test('setup is isolated from station origins, hostile hosts and requests without its CSRF token', async t => {
  const controller = new SetupController({ configFile: temp(t), profile: async () => ({ id: 42, login: 'alice' }) });
  const server = createSetupServer(controller); const port = await listen(server); t.after(() => close(server));
  const base = 'http://127.0.0.1:' + port;
  const html = await (await fetch(base)).text(); const token = html.match(/name="setup-token" content="([a-f0-9]+)"/)[1];
  assert.equal((await fetch(base + '/api/status')).status, 403);
  assert.equal((await fetch(base + '/api/status', { headers: { 'x-starnet-setup': token, Origin: 'http://127.0.0.1:8790' } })).status, 403);
  const hostileStatus = await new Promise(resolve => { http.get(base, { headers: { Host: 'attacker.test:' + port } }, reply => { reply.resume(); resolve(reply.statusCode); }); });
  assert.equal(hostileStatus, 403);
  assert.equal((await fetch(base + '/api/status', { headers: { 'x-starnet-setup': token } })).status, 200);
  const response = await fetch(base + '/api/profile', { method: 'POST', headers: { 'x-starnet-setup': token, 'Content-Type': 'application/json', Origin: base }, body: '{}' });
  assert.equal(response.status, 200); await done(controller); assert.equal(controller.user.login, 'alice');
  assert.equal((await fetch(base)).headers.get('x-frame-options'), 'DENY');
  assert.match((await fetch(base)).headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('connection probe authenticates, checks runtime and SSE, and releases its temporary session', async t => {
  const apiToken = 'a'.repeat(64); let streams = 0, loggedOut = 0;
  const runtime = http.createServer((req, res) => {
    if (req.url.startsWith('/api/channels/events')) {
      assert.equal(new URL(req.url, 'http://localhost').searchParams.get('token'), apiToken);
      streams++; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('retry: 3000\n\n'); return;
    }
    assert.equal(req.headers['x-starnet-token'], apiToken);
    if (req.url === '/api/health') { res.setHeader('Content-Type', 'text/plain'); res.end('ok'); return; }
    res.setHeader('Content-Type', 'application/json'); res.end('{}');
  });
  const runtimePort = await listen(runtime); t.after(() => close(runtime));
  const gateway = createGateway({ runtimePort, runtimeToken: apiToken, ownerId: 42, verifyIdentity: async () => ({ id: 42, login: 'alice' }) });
  gateway.on('request', req => { if (req.url === '/remote/logout') loggedOut++; });
  const gatewayPort = await listen(gateway); t.after(() => close(gateway));
  function spawnSSH(command, args) {
    assert.equal(command, 'ssh'); assert(args.includes('StrictHostKeyChecking=yes'));
    const forwarding = args[args.indexOf('-L') + 1], port = Number(forwarding.split(':')[1]);
    const child = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
    const sockets = new Set();
    const tunnel = net.createServer(socket => {
      const target = net.connect(gatewayPort, '127.0.0.1'); sockets.add(socket); sockets.add(target);
      socket.pipe(target); target.pipe(socket); socket.on('error', () => {}); target.on('error', () => {});
    });
    tunnel.listen(port, '127.0.0.1');
    child.kill = () => { child.exitCode = 0; for (const s of sockets) s.destroy(); tunnel.close(); };
    return child;
  }
  await probeConnection(baseConfig, { spawnSSH, token: async () => 'synthetic-token' });
  assert.equal(streams, 1); assert.equal(loggedOut, 1);
  await assert.rejects(probeConnection({ ...baseConfig, owner: 99 }, { spawnSSH, token: async () => 'synthetic-token' }), /unexpected station identity/);
  assert.equal(loggedOut, 2);
});

test('installer command uses a reviewed local archive and does not overwrite a running service itself', () => {
  const script = terminalScript({ ...baseConfig, 'ssh-port': 22222 }, true, "/Applications/StarNet.app/Contents/Resources/starnet-server.tar.gz");
  assert.match(script, /StrictHostKeyChecking=ask/); assert.match(script, /StrictHostKeyChecking=yes/);
  assert.match(script, /scp .* -P 22222/); assert.match(script, /sudo bash remote\/install-linux.sh 42/);
  assert.doesNotMatch(script, /systemctl stop|curl.*\|.*sh|StrictHostKeyChecking=no/);
});


test('each server gets a stable separate browser origin while existing client storage is retained', t => {
  const file = temp(t); saveConfig(baseConfig, file);
  assert.equal(saveConnection(baseConfig, file).port, 8790);
  const other = saveConnection({ ...baseConfig, host: 'other-server' }, file);
  assert.notEqual(other.port, 8790);
  assert.equal(saveConnection(baseConfig, file).port, 8790);
  assert.equal(saveConnection({ ...baseConfig, host: 'other-server' }, file).port, other.port);
  assert.notEqual(saveConnection({ ...baseConfig, owner: 43 }, file).port, 8790);
});

test('setup serves the actual StarNet component styles, font and ASCII wordmark unchanged', async t => {
  const { UI_ASSETS } = require('../remote/ui-assets');
  const controller = new SetupController({ configFile: temp(t) });
  const server = createSetupServer(controller); const port = await listen(server); t.after(() => close(server));
  const base = 'http://127.0.0.1:' + port;
  for (const file of UI_ASSETS) {
    const response = await fetch(base + '/starnet/' + file);
    assert.equal(response.status, 200);
    const actual = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(actual, fs.readFileSync(path.join(__dirname, '../frontend', file)), file + ' comes directly from the shared station UI');
  }
  const css = await (await fetch(base + '/setup.css')).text();
  assert.doesNotMatch(css, /font-family|@font-face|#[a-f0-9]{3,8}\b|linear-gradient|box-shadow/i, 'setup adds layout, not a competing design system');
});
