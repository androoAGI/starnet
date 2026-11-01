'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { SidecarFixture, allocatePort, processAlive, printedListening } = require('./helpers/sidecar-fixture.js');
const { readSidecarSource } = require('./helpers/source.js');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  // ---- readiness is tied to the child's own listening line ----
  const src = readSidecarSource();
  A.ok(/const url = 'http:\/\/127\.0\.0\.1:' \+ PORT;/.test(src) && /console\.log\('\s+Open in your browser:\s+' \+ url\)/.test(src),
    'the sidecar still prints "Open in your browser:  http://127.0.0.1:<port>" from its listen callback (the fixture waits for it)');
  A.ok(printedListening('\n     Open in your browser:  http://127.0.0.1:43210\n', 43210), 'the listening line for this port is recognised');
  A.ok(!printedListening('     Open in your browser:  http://127.0.0.1:432101\n', 43210), 'a longer port that starts with this one is not this port');
  A.ok(!printedListening('   open      : http://127.0.0.1:43210\n', 43210), "dev/seed.js's pre-boot 'open :' line is not the sidecar listening");

  // Another server takes the port after the fixture's probe and answers /api/health 200, while the child (standing in for
  // a sidecar still loading its modules) has not bound anything. The fixture must not take that 200 as its sidecar.
  const raced = SidecarFixture.create({ prefix: 'starnet-fixture-impostor-', timeoutMs: 1500, acquireToken: false, bindRetries: 0 });
  const racedWorkspace = raced.workspace;
  const stillLoading = path.join(raced.workspace, 'still-loading.js');
  fs.writeFileSync(stillLoading, 'setInterval(() => {}, 1000);\n');
  raced.entry = stillLoading;
  let impostorAnswered = 0;
  const impostor = http.createServer((req, res) => { impostorAnswered++; res.writeHead(200); res.end('ok'); });
  let racedError = null, racedPid = 0;
  try {
    const pending = raced.start();
    while (!raced.child) await sleep(5);
    racedPid = raced.child.pid;
    await new Promise((resolve, reject) => { impostor.once('error', reject); impostor.listen(raced.port, '127.0.0.1', resolve); });
    await pending;
  } catch (error) {
    racedError = error;
  } finally {
    if (typeof impostor.closeAllConnections === 'function') impostor.closeAllConnections();
    impostor.close();
  }
  A.ok(impostorAnswered > 0, 'the impostor on the fixture port did answer /api/health 200');
  A.ok(racedError && /readiness timed out/.test(racedError.message) && /never printed its listening line/.test(racedError.message),
    "a 200 from another process on the port is not this child's readiness (got " + (racedError ? racedError.message.split('\n')[0] : 'a ready fixture') + ')');
  A.ok(!processAlive(racedPid), 'the child that never served is terminated');
  A.ok(!fs.existsSync(racedWorkspace), 'its temporary workspace is removed');

  const firstPort = await allocatePort();
  const secondPort = await allocatePort();
  A.ok(firstPort > 0 && secondPort > 0, 'port allocation asks the OS for valid ephemeral ports');

  const blocker = net.createServer();
  await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', resolve); });
  const occupiedPort = blocker.address().port;
  let allocationCalls = 0;
  const retrying = SidecarFixture.create({
    prefix: 'starnet-fixture-bind-retry-',
    timeoutMs: 9000,
    portAllocator: async () => (++allocationCalls === 1 ? occupiedPort : allocatePort())
  });
  try {
    await retrying.start({ OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '' });
    A.eq(allocationCalls, 2, 'fixture retries with a fresh OS port when the reserved port loses the bind race');
    A.ok(retrying.port !== occupiedPort, 'bind retry does not reuse the occupied port');
  } finally {
    await retrying.dispose();
    if (typeof blocker.closeAllConnections === 'function') blocker.closeAllConnections();
    blocker.close();
  }

  const healthy = SidecarFixture.create({ prefix: 'starnet-fixture-self-' });
  const healthyWorkspace = healthy.workspace;
  await healthy.start({ OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '' });
  const healthyPid = healthy.child.pid;
  A.ok(healthy.token.length >= 32, 'fixture waits for health and acquires the browser boot token');
  A.eq((await healthy.json('GET', '/api/health')).status, 200, 'authenticated JSON helper reaches the running sidecar');
  await healthy.dispose();
  A.ok(!processAlive(healthyPid), 'dispose waits for the sidecar process to exit');
  A.ok(!fs.existsSync(healthyWorkspace), 'dispose removes the owned temporary workspace');

  const failing = SidecarFixture.create({ prefix: 'starnet-fixture-fail-', timeoutMs: 150, acquireToken: false });
  const failingWorkspace = failing.workspace;
  const neverReady = path.join(failing.workspace, 'never-ready.js');
  fs.writeFileSync(neverReady, 'setInterval(() => {}, 1000);\n');
  failing.entry = neverReady;
  let failed = false;
  let failingPid = 0;
  try {
    const pending = failing.start();
    while (!failing.child) await new Promise(resolve => setTimeout(resolve, 5));
    failingPid = failing.child.pid;
    await pending;
  } catch (error) {
    failed = /readiness timed out/.test(String(error && error.message));
  }
  A.ok(failed, 'a child that never becomes healthy fails with a readiness timeout');
  A.ok(!processAlive(failingPid), 'readiness failure terminates the child process');
  A.ok(!fs.existsSync(failingWorkspace), 'readiness failure removes the temporary workspace');

  A.report('sidecar-fixture.test');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
