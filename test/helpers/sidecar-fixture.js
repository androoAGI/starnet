'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { bootToken } = require('../_httpToken.js');

const HOST = '127.0.0.1';
const DEFAULT_ENTRY = path.resolve(__dirname, '..', '..', 'sidecar', 'index.js');
const active = new Set();

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = address && address.port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function portBindable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, HOST, () => server.close(() => resolve(true)));
  });
}

function processAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function removeTree(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

async function terminate(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  try { child.kill(); } catch (_) {}
  await Promise.race([exited, sleep(timeoutMs || 1500)]);
  if (processAlive(child.pid)) {
    try { child.kill('SIGKILL'); } catch (_) {}
    await Promise.race([exited, sleep(500)]);
  }
}

class SidecarFixture {
  constructor(options) {
    const opts = options || {};
    this.workspace = fs.mkdtempSync(path.join(os.tmpdir(), opts.prefix || 'starnet-sidecar-'));
    // HERMETIC PROFILE: the sidecar's boot-time station auto-recovery scans the REAL per-user
    // app-data roots (%APPDATA%/%LOCALAPPDATA%/XDG/~) for a lost station, and a fresh temp
    // workspace looks exactly like one — so a machine with an installed StarNet station had its
    // real save COPIED INTO every test workspace (2026-08-20: broke schema-stamp on the dev box
    // the day the desktop app was first installed there). Point every profile root the candidate
    // scan reads at an empty scratch sibling so fixture boots never see, or touch, real user data.
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), (opts.prefix || 'starnet-sidecar-') + 'profile-'));
    this.entry = opts.entry || DEFAULT_ENTRY;
    this.args = Array.isArray(opts.args) ? opts.args.slice() : [];
    this.env = Object.assign({}, opts.env || {});
    // Windows cold boots can exceed nine seconds while several isolated gates compete for disk.
    // This bounds startup only; health/token checks and explicit timeout-failure scenarios still apply.
    this.timeoutMs = Number(opts.timeoutMs) || (process.platform === 'win32' ? 30000 : 9000);
    this.bindRetries = Number.isInteger(opts.bindRetries) ? Math.max(0, opts.bindRetries) : 3;
    this.portAllocator = opts.portAllocator || allocatePort;
    this.acquireToken = opts.acquireToken !== false;
    this.child = null;
    this.port = null;
    this.baseUrl = '';
    this.token = '';
    this._output = '';
    this._disposed = false;
    active.add(this);
  }

  static create(options) { return new SidecarFixture(options); }

  output() { return this._output; }

  async start(extraEnv, bindAttempt) {
    if (this._disposed) throw new Error('sidecar fixture is already disposed');
    if (this.child) throw new Error('sidecar fixture is already running');
    const attempt = Number(bindAttempt) || 0;
    this.port = await this.portAllocator();
    if (!(await portBindable(this.port))) {
      if (attempt < this.bindRetries) return this.start(extraEnv, attempt + 1);
      await this.dispose();
      throw new Error('sidecar port remained occupied after ' + (attempt + 1) + ' allocation attempts');
    }
    this.baseUrl = 'http://' + HOST + ':' + this.port;
    this.token = '';
    this._output = '';
    const hermeticProfile = {
      APPDATA: this.profile,
      LOCALAPPDATA: this.profile,
      XDG_DATA_HOME: this.profile
    };
    // POSIX resolves ~ from $HOME (os.homedir() honors it); Windows uses USERPROFILE, which we
    // deliberately leave alone — node/npm subprocesses still need a sane Windows profile.
    if (process.platform !== 'win32') hermeticProfile.HOME = this.profile;
    // A test-booted sidecar never makes the boot-time check of Microsoft's Edge voice (media-service.js
    // startFloorProbe): no live traffic from a gate. A test that wants the probe sets it back on in its env.
    const quiet = { SKYNET_EDGE_TTS_PROBE: '0' };
    const env = Object.assign({}, process.env, hermeticProfile, quiet, this.env, extraEnv || {}, {
      SKYNET_PORT: String(this.port),
      STARNET_PORT: String(this.port),
      SKYNET_WORKSPACES: this.workspace,
      STARNET_WORKSPACES: this.workspace
    });
    const child = spawn(process.execPath, [this.entry].concat(this.args), {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.child = child;
    const onData = data => { this._output += data.toString(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    try {
      await this._waitUntilReady();
      if (this.acquireToken) {
        this.token = await bootToken(this.baseUrl, this.baseUrl);
        if (!this.token) throw new Error('sidecar became healthy but did not serve a boot token');
      }
      return this;
    } catch (error) {
      const output = this._output;
      if (/EADDRINUSE|already in use/i.test(output) && attempt < this.bindRetries) {
        await this.stop();
        return this.start(extraEnv, attempt + 1);
      }
      await this.dispose();
      error.message += '\nsidecar output:\n' + output;
      throw error;
    }
  }

  async _waitUntilReady() {
    const child = this.child;
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (/EADDRINUSE|already in use/i.test(this._output)) {
        throw new Error('sidecar port bind failed');
      }
      if (!child || child.exitCode !== null || child.signalCode) {
        throw new Error('sidecar exited before readiness (exit=' + child.exitCode + ', signal=' + child.signalCode + ')');
      }
      try {
        const response = await fetch(this.baseUrl + '/api/health', { signal: AbortSignal.timeout(250) });
        if (response.status === 200) return;
      } catch (_) {}
      await sleep(25);
    }
    throw new Error('sidecar readiness timed out after ' + this.timeoutMs + 'ms');
  }

  async restart(extraEnv) {
    await this.stop();
    return this.start(extraEnv);
  }

  async stop() {
    const child = this.child;
    this.child = null;
    await terminate(child, 1500);
  }

  async request(route, options) {
    const opts = Object.assign({}, options || {});
    const headers = Object.assign({}, opts.headers || {});
    if (!Object.keys(headers).some(key => key.toLowerCase() === 'origin')) headers.Origin = this.baseUrl;
    if (this.token && !Object.keys(headers).some(key => key.toLowerCase() === 'x-starnet-token')) {
      headers['X-StarNet-Token'] = this.token;
    }
    opts.headers = headers;
    return fetch(this.baseUrl + route, opts);
  }

  async json(method, route, body, options) {
    const opts = Object.assign({}, options || {}, { method });
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (body !== undefined) opts.body = JSON.stringify(body);
    const response = await this.request(route, opts);
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); } catch (_) { value = text; }
    return { status: response.status, body: value, text, headers: response.headers };
  }

  async dispose() {
    if (this._disposed) return;
    this._disposed = true;
    await this.stop();
    removeTree(this.workspace);
    removeTree(this.profile);
    active.delete(this);
  }
}

process.once('exit', () => {
  for (const fixture of active) {
    const child = fixture.child;
    if (child && processAlive(child.pid)) {
      try { child.kill(); } catch (_) {}
    }
    removeTree(fixture.workspace);
  }
});

module.exports = { SidecarFixture, allocatePort, processAlive, portBindable };
