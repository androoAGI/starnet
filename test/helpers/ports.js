'use strict';
/* test/helpers/ports.js — the one way a test, a mock server or a QA harness picks a TCP port.

   Ask the OS. allocatePort() binds port 0 on the loopback host and hands back the port the kernel chose, so the port
   is proven bindable on THIS machine at THIS moment. A port picked any other way is a guess: BASE + (process.pid % N)
   landed boot-security on 8884 on the remote gate laptop, where Windows reserves 8883, 8884 and 8886
   (`netsh int ipv4 show excludedportrange protocol=tcp`); the sidecar got EACCES and the test waited out its 30 s
   boot timer, because it only retried on "already in use". PID-derived ports also collide between parallel runs.

   Between allocatePort() closing its probe and the child binding the port, another process can take it. So a boot
   still retries, on a FRESH allocatePort(), never on port + 1, when the child reports that its listen was refused.
   BIND_REFUSED matches the listen failures a child prints: the sidecar's own lines (sidecar/index.js server.on('error'),
   and the degraded holding listener's "could not bind :N (EACCES) — exiting 73") and node's raw `listen E…` errors.
   It is anchored to listen/bind wording on purpose. The sidecar prints "permission denied for <dir>" for unrelated
   disk errors (sidecar/backupfile.js), and its OUTGOING calls fail with "connect EADDRNOTAVAIL …" or a provider's
   "permission denied https://host:443/…": none of those is a port of ours to retry.

   allocatePorts(n) is for a caller that needs several ports at once (a sidecar and its browser's CDP port). Two
   allocatePort() calls in a row can return the same port, because the first probe has closed before the second
   asks; allocatePorts holds every probe open until it has all n.

   test/test-ports.lint.test.js keeps every test, dev harness and script on this path. */
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

// n distinct ports, each proven bindable: all n probes are listening at the same time before any of them closes.
async function allocatePorts(n, host) {
  const count = Number(n);
  if (!Number.isInteger(count) || count < 0) throw new TypeError('allocatePorts(n) needs a whole number of ports, got ' + n);
  const servers = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = net.createServer();
      server.unref();
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host || HOST, resolve);
      });
    }
    return servers.map(server => server.address().port);
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(() => resolve()))));
  }
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
// privileges"; anything else it prints as "sidecar listen error: Error: listen E…: … 127.0.0.1:N". Its degraded
// holding listener (the owner-unavailable crash loop) prints "✗ degraded holding listener could not bind :N (<code>)".
const BIND_REFUSED = /EADDRINUSE|already in use|listen EACCES|listen EADDRNOTAVAIL|Port \d+ needs elevated privileges|could not bind :\d+ \((?:EADDRINUSE|EACCES|EADDRNOTAVAIL)\)/i;

function bindRefused(output) { return BIND_REFUSED.test(String(output || '')); }

module.exports = { HOST, allocatePort, allocatePorts, portBindable, BIND_REFUSED, bindRefused };
