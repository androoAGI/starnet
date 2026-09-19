'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { spawn, fork } = require('node:child_process');
const { once } = require('node:events');
const { saveConfig } = require('../remote/config');
function temporary(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-desktop-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true })); return home;
}
test('unified helper exits when its native launcher closes the lifetime pipe', { timeout: 10000 }, async t => {
  const home = temporary(t);
  const child = spawn(process.execPath, ['-e', 'require(' + JSON.stringify(path.join(__dirname, '../remote/desktop.js')) + ').main({port:0})'], {
    env: { ...process.env, HOME: home, STARNET_UNIFIED_DESKTOP: '1', STARNET_DESKTOP_STDIN_LIFETIME: '1' },
    stdio: ['pipe', 'ignore', 'pipe']
  });
  t.after(() => child.kill());
  let error = ''; child.stderr.on('data', data => error += data);
  child.stdin.end();
  const [code] = await once(child, 'exit'); assert.equal(code, 0, error);
});
test('desktop client releases its origin and SSH child when the helper crashes', { timeout: 10000 }, async t => {
  const home = temporary(t), bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  const ssh = path.join(bin, 'ssh'); fs.writeFileSync(ssh, '#!/bin/sh\nexec /bin/sleep 60\n', { mode: 0o700 });
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  saveConfig({ host: 'fixture', owner: 42, port, 'gateway-port': 18791 }, path.join(home, '.config/starnet-remote/config.json'));
  const child = fork(path.join(__dirname, '../remote/cli.js'), ['connect'], {
    env: { ...process.env, HOME: home, PATH: bin }, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    child.stdout.on('data', data => { if (data.toString().includes('Mac station:')) resolve(); });
    child.once('exit', () => reject(new Error('Client exited before readiness')));
  });
  const exited = once(child, 'exit'); child.disconnect();
  assert.equal((await exited)[0], 0);
  const check = net.createServer(); check.listen(port, '127.0.0.1'); await once(check, 'listening'); check.close();
});

test('disconnect suspends the viewer until explicit reconnect, without changing saved configuration', { timeout: 10000 }, async t => {
  const home = temporary(t), bin = path.join(home, 'bin'), attempts = path.join(home, 'ssh-attempts'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nprintf "attempt\\n" >> "$SSH_ATTEMPTS"\nexec /bin/sleep 60\n', { mode: 0o700 });
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const file = path.join(home, '.config/starnet-remote/config.json');
  saveConfig({ host: 'fixture', owner: 42, port, 'gateway-port': 18791 }, file);
  const saved = fs.readFileSync(file, 'utf8');
  const child = fork(path.join(__dirname, '../remote/cli.js'), ['connect'], {
    env: { ...process.env, HOME: home, PATH: bin, SSH_ATTEMPTS: attempts }, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    child.stdout.on('data', data => { if (data.toString().includes('Mac station:')) resolve(); });
    child.once('exit', () => reject(Error('Client stopped before readiness')));
  });
  const base = 'http://127.0.0.1:' + port;
  const headers = { 'x-starnet-client': '1', 'Content-Type': 'application/json' };
  const action = name => fetch(base + '/remote/client/' + name, { method: 'POST', headers, body: '{}' });
  for (let n = 0; n < 150 && !fs.existsSync(attempts); n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(attempts), 'the fake SSH process must start before testing disconnect');
  assert.equal((await (await action('disconnect')).json()).paused, true);
  const count = fs.readFileSync(attempts, 'utf8');
  assert.equal((await fetch(base + '/api/state/snapshot')).status, 503);
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(fs.readFileSync(attempts, 'utf8'), count, 'automatic requests cannot restart a disconnected viewer');
  assert.equal((await (await action('reconnect')).json()).paused, false);
  for (let n = 0; n < 150 && fs.readFileSync(attempts, 'utf8') === count; n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.notEqual(fs.readFileSync(attempts, 'utf8'), count, 'explicit reconnect starts SSH again');
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
  const exited = once(child, 'exit'); child.disconnect(); assert.equal((await exited)[0], 0);
});


test('CLI configuration isolates each station origin and reuses it when returning', t => {
  const { execFileSync } = require('node:child_process');
  const home = temporary(t);
  const cli = path.join(__dirname, '../remote/cli.js');
  const file = path.join(home, '.config/starnet-remote/config.json');
  const configure = host => {
    execFileSync(process.execPath, [cli, 'configure', '--host', host, '--owner', '42'], { env: { ...process.env, HOME: home } });
    return JSON.parse(fs.readFileSync(file)).port;
  };
  const first = configure('first.example');
  const second = configure('second.example');
  assert.notEqual(first, second);
  assert.equal(configure('first.example'), first);
});
