'use strict';
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { freePort, waitPort } = require('./cli');
const { connectionConfig, sshArgs } = require('./config');
async function githubUser(signal) {
  try {
    const { stdout } = await run('gh', ['api', 'user', '--hostname', 'github.com'], { timeout: 15000, maxBuffer: 65536, signal });
    const user = JSON.parse(stdout);
    if (!Number.isSafeInteger(user.id) || user.id <= 0 || !/^[a-z0-9-]{1,39}$/i.test(user.login)) throw new Error();
    return { id: user.id, login: user.login };
  } catch (_) { throw new Error('Sign in with GitHub to continue.'); }
}
function sshFailure(stderr) {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) return 'The server identity has changed. Verify its fingerprint with your server administrator before repairing your SSH known_hosts entry.';
  if (/Host key verification failed/i.test(stderr)) return 'Verify this server’s fingerprint using “Set up SSH access”, then test again.';
  if (/Permission denied/i.test(stderr)) return 'SSH could not sign in. Add your SSH public key to the server, or unlock your key in the Mac SSH agent, then test again.';
  return 'Could not reach the server. Check the SSH address, port and network connection.';
}
async function probeConnection(input, { signal, phase = () => {}, spawnSSH = spawn, token = async () => (await run('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 10000, maxBuffer: 65536, signal })).stdout.trim() } = {}) {
  const cfg = connectionConfig(input), tunnelPort = await freePort();
  const bounded = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(35000)]);
  let stderr = '', child;
  try {
    phase('Checking SSH access…');
    bounded.throwIfAborted();
    child = spawnSSH('ssh', ['-N', '-T', ...sshArgs(cfg), '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${tunnelPort}:127.0.0.1:${cfg['gateway-port']}`, cfg.host], { stdio: ['ignore', 'ignore', 'pipe'], signal: bounded });
    child.stderr?.on('data', data => { stderr = (stderr + data).slice(-4096); });
    child.on('error', () => {});
    try { await waitPort(tunnelPort, child, 14000); } catch (_) { throw new Error(sshFailure(stderr)); }
    phase('Verifying station ownership…');
    const base = `http://127.0.0.1:${tunnelPort}`;
    let reply;
    try { reply = await fetch(base + '/remote/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ githubToken: await token() }), signal: bounded, redirect: 'error' }); }
    catch (_) { bounded.throwIfAborted(); throw new Error('SSH works, but the StarNet gateway is unavailable. Install or start StarNet on this server, then test again.'); }
    if (reply.status === 401) throw new Error('GitHub sign-in has expired. Sign in again, then test the connection.');
    if (reply.status === 403) throw new Error('This station belongs to a different GitHub account. Sign in as its owner.');
    if (!reply.ok) throw new Error('The gateway could not sign you in (' + reply.status + '). Try again shortly.');
    const session = await reply.json();
    if (!/^[a-f0-9]{64}$/.test(session.token || '')) throw new Error('The server returned an unexpected station identity.');
    const headers = { Authorization: 'Bearer ' + session.token };
    try {
      if (session.user?.id !== cfg.owner) throw new Error('The server returned an unexpected station identity.');
      phase('Checking runtime and live updates…');
      const bootstrap = await fetch(base + '/remote/bootstrap', { headers, signal: bounded });
      if (!bootstrap.ok) throw new Error('Could not authenticate to the runtime.');
      const { token: runtimeToken } = await bootstrap.json();
      if (!/^[a-f0-9]{64}$/.test(runtimeToken || '')) throw new Error('The runtime returned invalid credentials.');
      const runtimeHeaders = { ...headers, 'x-starnet-token': runtimeToken };
      for (const route of ['/api/health', '/api/state/snapshot']) {
        const response = await fetch(base + route, { headers: runtimeHeaders, signal: bounded });
        if (!response.ok) throw new Error('The runtime is not ready. Check the server service and try again.');
        if (route === '/api/state/snapshot') await response.json();
        else await response.text(); // StarNet health returns plain-text "ok".
      }
      const streamAbort = new AbortController();
      try {
        const events = await fetch(base + '/api/channels/events?token=' + encodeURIComponent(runtimeToken), { headers, signal: AbortSignal.any([bounded, streamAbort.signal]) });
        if (!events.ok || !events.headers.get('content-type')?.includes('text/event-stream')) throw new Error('The live-update connection failed. Check the gateway before continuing.');
        const first = await events.body.getReader().read();
        if (first.done) throw new Error('The server closed the live-update connection.');
      } finally { streamAbort.abort(); }
      return { cfg, user: session.user };
    } finally {
      // A setup probe is not a viewer. Release its session instead of filling the gateway's client limit.
      await fetch(base + '/remote/logout', { method: 'POST', headers, signal: AbortSignal.timeout(2000) }).catch(() => {});
    }
  } finally {
    child?.kill('SIGTERM');
  }
}
module.exports = { githubUser, sshFailure, probeConnection };
