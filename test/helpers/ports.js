'use strict';
/* test/helpers/ports.js — the one way a test, a mock server or a QA harness picks a TCP port.

   Ask the OS. allocatePort() binds port 0 on the loopback host and hands back the port the kernel chose, so the port
   is proven bindable on THIS machine at THIS moment. A port picked any other way is a guess: BASE + (process.pid % N)
   landed boot-security on 8884 on the remote gate laptop, where Windows reserves 8883, 8884 and 8886
   (`netsh int ipv4 show excludedportrange protocol=tcp`); the sidecar got EACCES and the test waited out its 30 s
   boot timer, because it only retried on "already in use". PID-derived ports also collide between parallel runs.

   Between allocatePort() closing its probe and the child binding the port, another process can take it. So a boot
   still retries, on a FRESH allocatePort(), never on port + 1, when the child reports that its listen was refused.
   BIND_REFUSED matches the listen failures a child prints: the sidecar's own lines (sidecar/index.js server.on('error'))
   and node's raw `listen E…` errors. It is anchored to listen/port wording on purpose: the sidecar prints
   "permission denied for <dir>" for unrelated disk errors (sidecar/backupfile.js), and that must not read as a
   port to retry.

   test/test-ports.lint.test.js keeps every test on this path. */
const net = require('node:net');

const HOST = '127.0.0.1';

function allocatePort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host || HOST, () => {
      const address = server.address();
      const port = address && address.port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function portBindable(port, host) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, host || HOST, () => server.close(() => resolve(true)));
  });
}

// in use (EADDRINUSE), reserved or privileged (EACCES: a Windows excluded range answers with this), or not a local
// address (EADDRNOTAVAIL). The sidecar words the first two itself: "Port N is already in use", "Port N needs elevated
// privileges"; anything else it prints as "sidecar listen error: Error: listen E…: … 127.0.0.1:N".
const BIND_REFUSED = /EADDRINUSE|already in use|listen EACCES|Port \d+ needs elevated privileges|permission denied [^\s]*:\d+|EADDRNOTAVAIL|address not available/i;

function bindRefused(output) { return BIND_REFUSED.test(String(output || '')); }

module.exports = { HOST, allocatePort, portBindable, BIND_REFUSED, bindRefused };
