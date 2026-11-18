'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bootToken } = require('../_httpToken.js');
const { allocatePort, portBindable, BIND_REFUSED } = require('./ports.js');
const { makeDeskCodeReader } = require('./desk-code.js');

const HOST = '127.0.0.1';
const DEFAULT_ENTRY = path.resolve(__dirname, '..', '..', 'sidecar', 'index.js');
const active = new Set();

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// The sidecar's own listening line, printed from its server.listen callback (sidecar/index.js):
// "     Open in your browser:  http://127.0.0.1:<port>". dev/seed.js prints its own "open : <url>" before it starts the
// sidecar, which is why the match is on the sidecar's wording and not on the bare URL.
function printedListening(output, port) {
  return new RegExp('Open in your browser:\\s+http://127\\.0\\.0\\.1:' + Number(port) + '(?!\\d)').test(String(output || ''));
}

function processAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function removeTree(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

async function terminate(child, timeoutMs, signal) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  try { child.kill(signal); } catch (_) {}
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
    // A cold boot can exceed nine seconds while several isolated gates compete for disk, on any platform, so a rig naming a
    // shorter limit still gets this one. Only a test of the timeout itself (timeoutUnderTest) goes under it. A child that dies
    // fails at once whatever the limit. This bounds startup only; health/token checks still apply.
    const askedMs = Number(opts.timeoutMs) || 0;
    this.timeoutMs = opts.timeoutUnderTest ? askedMs : Math.max(askedMs, 30000);
    this.bindRetries = Number.isInteger(opts.bindRetries) ? Math.max(0, opts.bindRetries) : 3;
    this.portAllocator = opts.portAllocator || allocatePort;
    this.acquireToken = opts.acquireToken !== false;
    this.child = null;
    this.port = null;
    this.baseUrl = '';
    this.token = '';
    this._output = '';
    // the desk codes this station prints on its own console, read as the person at it reads them (desk-code.js)
    this.desk = makeDeskCodeReader();
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
    // Readiness may ask the local CLI for auth status without a Settings page. Never discover a real
    // installed account in a test fixture; callers testing CLI behavior can supply their fixture bin.
    // The fixture is this station's operator and reads its console for desk codes (this.desk). On Linux and macOS that
    // console is a socket pair, which the station treats as a kept log and writes no code to, so the fixture says the
    // operator's choice outright (scripts/run-test-list.mjs buildStepEnv does the same for every gate step). It is set after
    // the test's own env: many tests blank every STARNET_/SKYNET_ variable they find (their hermeticEnv), the gate's included;
    // a test that wants the station's own rule passes '0'.
    const quiet = { SKYNET_EDGE_TTS_PROBE: '0', STARNET_CLAUDE_BIN: path.join(this.profile, 'fixture-cli-absent.cmd') };
    const env = Object.assign({}, process.env, hermeticProfile, quiet, this.env, extraEnv || {}, {
      SKYNET_PORT: String(this.port),
      STARNET_PORT: String(this.port),
      SKYNET_WORKSPACES: this.workspace,
      STARNET_WORKSPACES: this.workspace
    });
    if (!env.STARNET_DESK_CODE_TO_LOG && !env.SKYNET_DESK_CODE_TO_LOG) env.STARNET_DESK_CODE_TO_LOG = '1';
    this._childEnv = env;
    const child = spawn(process.execPath, [this.entry].concat(this.args), {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.child = child;
    const onData = data => { this._output += data.toString(); this.desk.feed(data); };
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
      if (BIND_REFUSED.test(output) && attempt < this.bindRetries) {
        await this.stop();
        return this.start(extraEnv, attempt + 1);
      }
      await this.dispose();
      error.message += '\nsidecar output:\n' + output;
      throw error;
    }
  }

  /* Ready means THIS child serves the port: it printed its own listening line, and /api/health on the port says 200.
     A 200 alone proves only that something answers there. Between the probe in start() and the child's bind, another
     process can take the port (another test's sidecar, say); the child then fails its bind seconds later, after its
     module load, while that other process answers /api/health. The listening line comes from the sidecar's own
     server.listen callback and names the port, and only this child's output is read, so it ties the port to it. */
  async _waitUntilReady() {
    const child = this.child;
    const deadline = Date.now() + this.timeoutMs;
    let foreignHealth = false;
    while (Date.now() < deadline) {
      if (BIND_REFUSED.test(this._output)) {
        throw new Error('sidecar port bind failed');
      }
      if (!child || child.exitCode !== null || child.signalCode) {
        throw new Error('sidecar exited before readiness (exit=' + child.exitCode + ', signal=' + child.signalCode + ')');
      }
      try {
        const response = await fetch(this.baseUrl + '/api/health', { signal: AbortSignal.timeout(250) });
        if (response.status === 200) {
          if (printedListening(this._output, this.port)) return;
          foreignHealth = true;
        }
      } catch (_) {}
      await sleep(25);
    }
    throw new Error('sidecar readiness timed out after ' + this.timeoutMs + 'ms' + (foreignHealth
      ? ' (/api/health on :' + this.port + ' answered 200, but this child never printed its listening line: another process holds the port)'
      : ''));
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

  // A CRASH, not a stop. On POSIX stop() is SIGTERM: the sidecar's graceful shutdown ends and books every run, which leaves nothing
  // to recover. On Windows both end the process outright. A scenario about an interrupted run calls this one.
  async crash() {
    const child = this.child;
    this.child = null;
    await terminate(child, 1500, 'SIGKILL');
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

  /* deskJson: json(), and when the station answers with its desk challenge (an authority change: an owner code, Full
     Access, a standing grant...), the same request again with the code this station printed for it, as the person at
     the station would type it. A test that means to make the change uses this; json() keeps showing the refusal. */
  async deskJson(method, route, body, options) {
    const send = extra => this.json(method, route, body,
      Object.assign({}, options || {}, { headers: Object.assign({}, (options && options.headers) || {}, extra || {}) }));
    let first = await send();
    /* A DESKTOP-MODE station (STARNET_DESKTOP_SHELL with its IPC token) takes an authority change only from the StarNet
       window's own key, and only after its shell reported the person's yes in the native dialog (POST /api/desk/approve,
       guarded by the IPC token). A test that set both keys plays the window and the shell here, with the words the
       station issued; one that did not gets the refusal as it came. */
    const e = this._childEnv || {};
    const api = e.STARNET_API_TOKEN || e.SKYNET_API_TOKEN || '', ipc = e.STARNET_IPC_TOKEN || e.SKYNET_IPC_TOKEN || '';
    const code = first && first.body && typeof first.body === 'object' ? first.body.code : '';
    if (first.status === 403 && code === 'desk_only' && api) first = await send({ 'X-StarNet-Token': api });
    const ch = first.status === 403 && first.body && first.body.code === 'desk_confirm_required' && first.body.deskConfirm;
    if (ch && ch.mode === 'desktop' && ipc) {
      const ok = await fetch(this.baseUrl + '/api/desk/approve', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': ipc, Origin: this.baseUrl },
        body: JSON.stringify({ id: ch.id, title: ch.title, summary: ch.summary, verb: ch.verb }) });
      if (ok.status !== 200) return first;
      return send(Object.assign(api ? { 'X-StarNet-Token': api } : {}, { 'X-StarNet-Desk-Proof': ch.id }));
    }
    return this.desk.confirm(first, send);
  }

  async dispose() {
    if (this._disposed) return;
    this._disposed = true;
    await this.stop();
    removeTree(this.workspace);
    if (this.workspace) removeTree(this.workspace + '.recovery-owner.json.generations');   // final review B12: what a station leaves beside it
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
    if (fixture.workspace) removeTree(fixture.workspace + '.recovery-owner.json.generations');
  }
});

module.exports = { SidecarFixture, allocatePort, processAlive, portBindable, printedListening };
