#!/usr/bin/env node
/* bin/starnet.js — StarNet from a terminal: `starnet -p "…"` runs one real agent task headlessly.

   The desktop app is the station; this is the same station driven without the UI. Every decision lives in the
   pure core (./lib/cli-core.js); this file owns the ambient I/O only: argv/env, loopback sockets, the OS port
   lookup for the desktop's sidecar, spawning a sidecar when none is running, stdout/stderr, exit codes.

   ── HOW A RUN FINDS ITS STATION ─────────────────────────────────────────────────────────────────────────────
   1. --port / STARNET_PORT → that station, or an error (never a spawn beside a station the operator named).
   2. the default port (8787, `npm start`).
   3. the DESKTOP app's station: its workspace owner file names the sidecar pid; the OS says which loopback
      port that pid listens on (netstat/lsof; the shell's startup.log as a fallback). The per-launch API token
      is read from the served page exactly the way the browser gets it.
   4. the desktop app's station with the app CLOSED → START THE APP in the background (`--background
      --terminal-pid <this pid>`): it reads its own keychain and spawns its keyed sidecar exactly as when a person
      opens it, window parked (the tray shows it runs), and we attach as in 3. The app watches that pid: when every
      starnet session it runs for is gone and nobody opened its window, it decides as a window close does. The
      terminal never boots that station itself — the keys live in the app, so that would be a keyless copy.
   5. nothing reachable → boot a sidecar of our own against the default workspace (bootstrapping a full-power
      agent into it first if it is empty), run, and shut it down on exit.
   ONE SIDECAR PER WORKSPACE is a hard invariant, so step 5 never targets a workspace whose owner is alive.

   ── WHAT THE TERMINAL IS ALLOWED TO SAY ─────────────────────────────────────────────────────────────────────
   stdout carries the agent's real streamed text (or, with --json, one receipt object); stderr carries tool
   calls, consent decisions and notes. The exit code is the station's own agent.run.end reason; a stream that
   dies without one exits 1. Nothing here invents a "done". */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const readline = require('node:readline');
const nodeCrypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const core = require('./lib/cli-core.js');
const folderLib = require('./lib/folder.js');

const REPO = path.resolve(__dirname, '..');
const SIDECAR = path.join(REPO, 'sidecar', 'index.js');
const DESKTOP_IDENTIFIER = 'ai.skynet.harness';   // Tauri identifier — app_data_dir()/workspaces is the desktop station
const CANCEL_GRACE_MS = 5000;

function log() { try { process.stderr.write(Array.prototype.join.call(arguments, ' ') + '\n'); } catch (_) {} }

// ---- paths -------------------------------------------------------------------------------------
function desktopAppDataDir(env, platform) {
  const e = env || process.env, p = platform || process.platform;
  const home = os.homedir() || '.';
  if (p === 'darwin') return path.join(home, 'Library', 'Application Support', DESKTOP_IDENTIFIER);
  if (p === 'win32') return path.join(e.APPDATA || path.join(home, 'AppData', 'Roaming'), DESKTOP_IDENTIFIER);
  return path.join(e.XDG_DATA_HOME || path.join(home, '.local', 'share'), DESKTOP_IDENTIFIER);
}
function desktopWorkspaces(env, platform) { return path.join(desktopAppDataDir(env, platform), 'workspaces'); }
// the bare sidecar's own default (sidecar/index.js defaultWorkspaces) — an `npm start` station lives here
function bareWorkspaces(env, platform) {
  const e = env || process.env, p = platform || process.platform;
  const home = os.homedir() || '.';
  if (p === 'darwin') return path.join(home, 'Library', 'Application Support', DESKTOP_IDENTIFIER, 'workspaces');
  const base = e.LOCALAPPDATA || e.APPDATA || e.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const neu = path.join(base, 'StarNet', 'workspaces');
  const old = path.join(base, 'Skynet', 'workspaces');
  try { if (!fs.existsSync(neu) && fs.existsSync(old)) return old; } catch (_) {}
  return neu;
}
function exists(p) { try { return fs.existsSync(p); } catch (_) { return false; } }
function hasStation(ws) { return exists(path.join(ws, 'agent.save.json')) || exists(path.join(ws, 'agent.roster.json')); }

// The workspace a SPAWNED station runs against: the operator's pick, else the desktop station if one exists,
// else a bare `npm start` station if one exists, else the desktop location (so a later desktop install finds it).
function defaultWorkspace(opts) {
  if (opts.workspace) return path.resolve(opts.workspace);
  const d = desktopWorkspaces(), b = bareWorkspaces();
  if (hasStation(d)) return d;
  if (hasStation(b)) return b;
  return d;
}

// ---- desktop discovery -------------------------------------------------------------------------
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}
/* A live PID is the claim's station only while the process that STAMPED the claim still holds it. A hard-killed
   station leaves its claim behind and Windows recycles PIDs within one boot, so a claim can name a PID that now belongs
   to an unrelated program; read as alive, that made `starnet` refuse ("its port could not be discovered") until a
   reboot. sidecar/process-identity.js judges it exactly as the station's own boot does: 'reused' only on proof, an
   unreadable identity stays the owner. A live process never changes identity, so each claim is probed once. */
const claimVerdicts = new Map();
function claimVerdict(claim, pid) {
  const key = [pid, claim && claim.nonce, claim && claim.startedAt, claim && claim.startTicks].join('|');
  if (claimVerdicts.has(key)) return claimVerdicts.get(key);
  let verdict = 'unknown';
  try {
    const identity = require(path.join(REPO, 'sidecar', 'process-identity.js'));
    const seen = identity.makeProcessIdentity({ timeoutMs: 8000 }).probe(pid);
    verdict = identity.judgeReuse({ startedAt: claim.startedAt, executable: claim.executable, startTicks: claim.startTicks }, seen).verdict;
  } catch (_) { verdict = 'unknown'; }
  claimVerdicts.set(key, verdict);
  return verdict;
}
// when this computer last started (the sidecar's own reading: workspace-owner.js makeBootedAt), 0 when unknown
function defaultBootedAt() {
  const up = Number(os.uptime());
  return up > 0 ? Date.now() - up * 1000 : 0;
}
function claimPredatesBoot(claim, bootedAt) {
  try { return require(path.join(REPO, 'sidecar', 'process-identity.js')).predatesBoot(claim && claim.startedAt, bootedAt); }
  catch (_) { return false; }
}
function listeningPortOf(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
      return core.parseListeningPort(out, pid, 'win32');
    }
    const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    return core.parseListeningPort(out, pid, process.platform);
  } catch (_) { return 0; }
}
/* What the desktop app's workspace proves: { workspace, ownerPid, ownerAlive, port }. The owner file is the
   sidecar's own fail-closed claim (sidecar/workspace-owner.js); a live pid + its listening port is a station
   we can attach to. Read-only — nothing here writes into the desktop's workspace. */
/* `deps` (tests): { pidAlive, listeningPortOf, claimVerdict, bootedAt } — the real ones by default.
   The claim is judged by the station's own rules, cheapest first: a claim stamped before this computer last started
   is dead (sidecar/process-identity.js predatesBoot); a dead PID is dead; a live PID the OS shows LISTENING is a
   station to attach to (no identity probe on that path — the probe is a PowerShell/ps call, seconds on every
   `starnet` while the app runs). Only a live PID with no port the OS can name — the case that refused — is probed:
   a recycled PID is no owner. */
function discoverDesktop(ws, deps) {
  const d = Object.assign({ pidAlive, listeningPortOf, claimVerdict, bootedAt: defaultBootedAt }, deps || {});
  /* station: the workspace holds one; appRan: the desktop app has run on it (the shell's own startup.log or
     last-run-version sits beside it) — so its keys live in the app's keychain, not in this terminal */
  const out = { workspace: ws, ownerPid: 0, ownerAlive: false, port: 0, source: '', station: hasStation(ws),
    appRan: exists(path.join(path.dirname(ws), 'startup.log')) || exists(path.join(path.dirname(ws), 'last-run-version')) };
  let claim = null;
  try { claim = JSON.parse(fs.readFileSync(path.join(ws, '.starnet-workspace-owner.json'), 'utf8')); } catch (_) { return out; }
  out.ownerPid = Number(claim && claim.pid) || 0;
  if (claimPredatesBoot(claim, d.bootedAt())) { out.ownerStale = true; return out; }
  out.ownerAlive = d.pidAlive(out.ownerPid);
  if (!out.ownerAlive) return out;
  out.port = d.listeningPortOf(out.ownerPid);
  if (out.port) { out.source = 'os'; return out; }
  if (d.claimVerdict(claim, out.ownerPid) === 'reused') { out.ownerAlive = false; out.ownerReused = true; return out; }
  try {
    const rec = core.parseStartupLog(fs.readFileSync(path.join(path.dirname(ws), 'startup.log'), 'utf8'));
    if (rec && rec.pid === out.ownerPid && rec.port) { out.port = rec.port; out.source = 'startup.log'; }
  } catch (_) {}
  return out;
}

// the last `bytes` of a file (startup.log grows by a few lines every start; its newest lines are what count)
function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}
/* The StarNet app that owns the desktop station — what `starnet` starts in the background while it is closed. In
   order: STARNET_APP_EXE; the app this CLI was installed with (Windows ..\skynet-desktop.exe, macOS
   StarNet.app/Contents/MacOS, Linux usr/bin — the layouts bin/starnet knows); the path the app wrote into its own
   startup.log the last time it started (`startupText`: that log's tail, when the caller already read it). '' when
   none of them is on disk. */
const APP_NAMES = ['skynet-desktop', 'StarNet'];
function findAppExe(ws, env, platform, startupText) {
  const e = env || process.env, p = platform || process.platform;
  const isFile = f => { try { return fs.statSync(f).isFile(); } catch (_) { return false; } };
  const pick = String(e.STARNET_APP_EXE || '').trim();
  if (pick) return isFile(pick) ? path.resolve(pick) : '';
  const beside = p === 'darwin' ? path.join(__dirname, '..', '..', 'MacOS') : p === 'win32' ? path.join(__dirname, '..') : path.join(__dirname, '..', '..', '..', 'bin');
  for (const n of APP_NAMES) { const f = path.join(beside, n + (p === 'win32' ? '.exe' : '')); if (isFile(f)) return f; }
  let logged = '';
  try { logged = core.parseStartupExe(startupText != null ? startupText : readTail(path.join(path.dirname(ws), 'startup.log'), 256 * 1024)); } catch (_) {}
  return logged && isFile(logged) ? logged : '';
}

// ---- loopback HTTP -----------------------------------------------------------------------------
function makeClient(host, port) {
  const base = 'http://' + host + ':' + port;
  let token = '';
  function request(method, p, body, opts) {
    const o = opts || {};
    return new Promise(resolve => {
      const headers = { 'Origin': base, 'Accept': 'application/json, text/plain, */*' };
      if (token && !o.noToken) headers['x-starnet-token'] = token;
      let payload = null;
      if (body != null) { payload = Buffer.from(JSON.stringify(body), 'utf8'); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
      let req;
      try {
        req = http.request({ host, port, method, path: p, headers }, res => {
          const chunks = [];
          res.on('data', d => chunks.push(d));
          res.on('end', () => {
            if (o.raw) return resolve({ ok: true, status: res.statusCode, buf: Buffer.concat(chunks) });   // bytes as sent (a sprite)
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null; try { json = JSON.parse(text || 'null'); } catch (_) { json = null; }
            resolve({ ok: true, status: res.statusCode, json, text });
          });
        });
      } catch (e) { return resolve({ ok: false, error: (e && e.message) || String(e) }); }
      req.on('error', e => resolve({ ok: false, error: (e && e.message) || String(e) }));
      req.setTimeout(o.timeoutMs || 30000, () => { try { req.destroy(new Error('request timed out')); } catch (_) {} });
      if (payload) req.write(payload);
      req.end();
    });
  }
  async function health(timeoutMs) {
    const r = await request('GET', '/api/health', null, { noToken: true, timeoutMs: timeoutMs || 1500 });
    return !!(r.ok && r.status === 200);
  }
  // the per-launch token, read from the served page exactly as the browser receives it
  async function discoverToken() {
    if (token) return token;
    const r = await request('GET', '/', null, { noToken: true, timeoutMs: 8000 });
    if (r.ok && r.status === 200 && typeof r.text === 'string') {
      const m = r.text.match(/window\.__STARNET_API_TOKEN__=("(?:\\.|[^"])*")/);
      if (m) { try { token = String(JSON.parse(m[1]) || ''); } catch (_) {} }
    }
    return token;
  }
  return { base, host, port, request, health, discoverToken, setToken: (t) => { token = String(t || ''); }, token: () => token };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- spawn a sidecar of our own ----------------------------------------------------------------
async function spawnSidecar(ws, env, onLine) {
  if (!exists(SIDECAR)) throw new Error('cannot find the sidecar at ' + SIDECAR);
  const port = await freePort();
  const token = nodeCrypto.randomBytes(32).toString('hex');
  const childEnv = Object.assign({}, env, {
    STARNET_WORKSPACES: ws, SKYNET_WORKSPACES: ws,
    STARNET_PORT: String(port), SKYNET_PORT: String(port),
    STARNET_API_TOKEN: token, SKYNET_API_TOKEN: token
  });
  // an ipc channel so stopChild can ask for the sidecar's GRACEFUL shutdown (Windows has no SIGTERM)
  const child = spawn(process.execPath, [SIDECAR], { cwd: REPO, env: childEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try { if (child.channel && typeof child.channel.unref === 'function') child.channel.unref(); } catch (_) {}
  const tail = [];
  const onData = d => {
    for (const line of String(d).split(/\r?\n/)) {
      if (!line.trim()) continue;
      tail.push(line); if (tail.length > 40) tail.shift();
      if (onLine) onLine(line);
    }
  };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  let exited = null;
  child.on('exit', (code, sig) => { exited = { code, sig }; });
  const client = makeClient('127.0.0.1', port);
  client.setToken(token);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (exited) throw new Error('the station exited during boot (code ' + exited.code + ')\n' + tail.join('\n'));
    if (await client.health(1000)) return { child, client, port, tail: () => tail.slice() };
    await sleep(200);
  }
  try { child.kill(); } catch (_) {}
  throw new Error('the station did not become healthy within 45s\n' + tail.join('\n'));
}
/* The sidecar's gracefulShutdown has a HARD 3s deadline (sidecar/index.js). Every wait here outlasts it by 0.5s, so
   the graceful path is never cut off by our own escalation. */
const SIDECAR_SHUTDOWN_DEADLINE_MS = 3000;
const STOP_GRACE_MS = SIDECAR_SHUTDOWN_DEADLINE_MS + 500;
async function stopChild(child, ws, timing) {
  if (!child) return;
  const t = Object.assign({ graceMs: STOP_GRACE_MS, termMs: STOP_GRACE_MS, killMs: 1000 }, timing || {});
  if (child.exitCode === null) {
    const gone = new Promise(r => child.once('exit', r));
    const alive = () => child.exitCode === null && child.signalCode == null;
    /* 1. Ask over IPC. On Windows child.kill() is TerminateProcess: the sidecar's graceful path (reap background
          jobs, MCP/LSP children, release locks) never ran, so they leaked. The message runs that path on every OS. */
    if (child.connected && typeof child.send === 'function') {
      try { child.send({ type: 'starnet.shutdown' }); await Promise.race([gone, sleep(t.graceMs)]); } catch (_) {}
    }
    // 2. SIGTERM → the sidecar's graceful path on POSIX (TerminateProcess on Windows) — with the same full grace
    if (alive()) { try { child.kill(); } catch (_) {}; await Promise.race([gone, sleep(t.termMs)]); }
    // 3. only then SIGKILL
    if (alive()) { try { child.kill('SIGKILL'); } catch (_) {}; await Promise.race([gone, sleep(t.killMs)]); }
  }
  /* The owner claim is NEVER touched here, even when the station was terminated outright (Windows has no SIGTERM) and
     left its claim behind. The claim belongs to the station's own fail-closed protocol (sidecar/workspace-owner.js):
     its next boot reclaims a claim whose PID is gone or recycled, under its election ticket. Deleting it from out here
     raced that protocol — read "our child, dead", then unlink — and a station that reclaimed the workspace in between
     lost its live claim, leaving room for a second writer on one station. `ws` stays in the signature for callers. */
  void ws;
}

// ---- bootstrap ---------------------------------------------------------------------------------
function loadRegistry() { try { return require(path.join(REPO, 'sidecar', 'providers', 'registry.js')); } catch (_) { return null; } }

/* The prior-station evidence the app's Recovery Mode reads (sidecar/workspace-lineage.js, with the sidecar's own
   candidate roots): legacy roots, update snapshots, a pending migration, state whose save is gone. The app offers that
   recovery only while there is NO save, so a save written here would hide the prior station from it for good. */
function priorStationEvidence(ws, env) {
  try {
    const lineage = require(path.join(REPO, 'sidecar', 'workspace-lineage.js'));
    const safety = require(path.join(REPO, 'sidecar', 'workspace-safety.js'));
    const dev = /^(1|true|yes|on)$/i.test(String((('STARNET_DEV' in env) ? env.STARNET_DEV : env.SKYNET_DEV) || '').trim());   // the sidecar's DEV_MODE: no sideways look
    const roots = dev ? [] : safety.workspaceCandidates({ path, env, platform: process.platform, homedir: () => os.homedir() })
      .concat([path.join(REPO, 'sidecar', 'workspaces'), path.join(REPO, 'workspaces')]);
    return !!lineage.inspectWorkspaceLineage({ fs, path, platform: process.platform, workspaceRoot: ws, candidateRoots: roots }).priorInstallEvidence;
  } catch (_) { return false; }
}

/* Write the roster + save the desktop's onboarding would have produced (core.bootstrapDocs). Refuses to touch a
   workspace that already holds a station, and (unless the operator named the workspace) one where the app would offer
   to recover a prior station. Returns { wrote, refused?, provider, model, reason }. */
function bootstrapWorkspace(ws, opts, env) {
  if (hasStation(ws)) return { wrote: false, reason: 'workspace already holds a station' };
  if (!opts.workspace && priorStationEvidence(ws, env)) return { wrote: false, refused: true, reason: 'this computer has a station from an earlier StarNet install — open the StarNet app to recover it before setting up a new one' };
  const reg = loadRegistry();
  const profiles = reg ? reg.listProviderProfiles() : [];
  const inferred = core.inferProvider({
    explicit: opts.provider, env, profiles,
    codexTokensPresent: exists(path.join(ws, 'codex', 'tokens.json'))
  });
  const model = String(opts.model || env.STARNET_DEFAULT_MODEL || env.SKYNET_DEFAULT_MODEL || '').trim();
  const docs = core.bootstrapDocs({ name: opts.name, model, provider: inferred.provider || 'openrouter', now: Date.now() });
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'agent.roster.json'), JSON.stringify(docs.roster, null, 2));
  fs.writeFileSync(path.join(ws, 'agent.save.json'), JSON.stringify(docs.save, null, 2));
  return { wrote: true, provider: inferred.provider, providerSource: inferred.source, model };
}

// ---- consent from a terminal --------------------------------------------------------------------
function askTty(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, a => { rl.close(); resolve(String(a || '').trim()); });
  });
}
async function answerConsent(client, runId, p, opts) {
  const tool = String(p.tool || 'tool');
  const summary = String(p.argsSummary || '');
  // in-turn clarify (brief.ask): a free-text answer, not a grant
  if (tool === 'brief.ask') {
    let q = summary; try { const j = JSON.parse(summary); q = String(j.question || summary) + (Array.isArray(j.options) && j.options.length ? '\n    options: ' + j.options.join(' | ') : ''); } catch (_) {}
    if (process.stdin.isTTY && !opts.json) {
      const a = await askTty('? the agent asks: ' + q + '\n  answer: ');
      if (a) { await client.request('POST', '/api/consent/answer', { runId, promptId: p.promptId, answer: a }); return 'answered'; }
    } else log('? the agent asked a question headlessly (no terminal to answer): ' + q.split('\n')[0]);
    await client.request('POST', '/api/consent', { runId, promptId: p.promptId, decision: 'deny' });
    return 'unanswered';
  }
  const label = tool === 'path.trust' ? 'work inside folder ' + summary : tool + ' (' + (p.scope || 'write') + ')' + (summary ? ' ' + summary : '');
  let decision = 'deny';
  if (opts.yes) decision = 'once';
  else if (process.stdin.isTTY && !opts.json) {
    const a = (await askTty('? allow ' + label + ' [y/N] ')).toLowerCase();
    decision = (a === 'y' || a === 'yes') ? 'once' : 'deny';
  }
  const r = await client.request('POST', '/api/consent', { runId, promptId: p.promptId, decision });
  const okd = r.ok && r.json && r.json.ok;
  log((decision === 'deny' ? '✗ denied ' : '✓ allowed ') + label + (okd ? '' : ' (the station did not acknowledge the decision)') + (decision === 'deny' && !opts.yes && !process.stdin.isTTY ? '  [non-interactive: pass --yes to approve]' : ''));
  return decision;
}

// ---- the run ------------------------------------------------------------------------------------
function streamRun(client, body, handlers) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; fn(v); };
    let req;
    try {
      req = http.request({
        host: client.host, port: client.port, method: 'POST', path: '/api/run',
        headers: { 'Origin': client.base, 'Content-Type': 'application/json', 'Content-Length': payload.length, 'x-starnet-token': client.token(), 'Accept': 'application/x-ndjson' }
      }, res => {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on('data', d => chunks.push(d));
          res.on('end', () => finish(reject, new Error('the station refused the run (HTTP ' + res.statusCode + '): ' + Buffer.concat(chunks).toString('utf8').slice(0, 300))));
          return;
        }
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', chunk => {
          const r = core.splitNdjson(buf + chunk);
          buf = r.rest;
          for (const line of r.lines) {
            let ev = null; try { ev = JSON.parse(line); } catch (_) { continue; }
            if (ev && ev.name) handlers.onEvent(ev);
          }
        });
        const done = () => finish(resolve, { dropped: !handlers.sawEnd() });
        res.on('end', done); res.on('close', done);
        res.on('error', e => { if (handlers.cancelled()) return done(); finish(reject, e instanceof Error ? e : new Error(String(e))); });
      });
    } catch (e) { return finish(reject, e instanceof Error ? e : new Error(String(e))); }
    req.on('error', e => { if (handlers.cancelled()) return finish(resolve, { dropped: true }); finish(reject, new Error('run stream failed: ' + ((e && e.message) || e))); });
    handlers.bindAbort(() => { try { req.destroy(); } catch (_) {} });
    req.write(payload); req.end();
  });
}

async function runCommand(opts, station) {
  const { client, mode } = station;
  const rt = await client.request('GET', '/api/runtime/agent');
  if (!rt.ok || rt.status !== 200 || !rt.json) throw stationError('could not read the station roster (' + (rt.error || 'HTTP ' + rt.status) + ')');
  const sel = core.pickAgent(rt.json, { agent: opts.agent, model: opts.model, provider: opts.provider });
  if (!sel.ok) throw stationError(sel.error);
  // the folder the run works in: the trusted project this folder (or --cwd) sits in; a named --cwd that is not trusted
  // still goes (the station says it is not trusted and asks before the agent works in it)
  let cwd = opts.cwd ? path.resolve(opts.cwd) : '';
  let untrusted = null;
  if (folderLib.isLocalHost(client.host)) {
    const f = folderLib.locate({ cwd: cwd || process.cwd(), projects: await folderLib.trustedProjects(client).catch(() => []), stationDirs: stationDirs(station) });
    if (f.trusted) cwd = f.trusted;
    else if (!cwd && !f.skip) untrusted = f.root;
  }
  const body = core.buildRunBody(sel, opts.prompt, { cwd });
  const tracker = core.makeRunTracker();
  const startedAt = Date.now();
  if (!opts.json) log('▸ ' + sel.name + ' (' + sel.agentId + ') · ' + sel.provider + '/' + sel.model + ' · ' + mode + ' ' + client.base + (cwd ? ' · in ' + cwd : ''));
  if (untrusted) log('· ' + untrusted + ' is not a trusted project, so ' + sel.name + ' works in its own workspace — run `starnet` there once and press y to trust it, or pass --cwd');

  let abortSocket = null, cancelSent = false, graceTimer = null, timeoutTimer = null;
  async function cancel(why) {
    if (cancelSent) return;
    cancelSent = true; tracker.markCancel(why);
    if (tracker.state.runId) await client.request('POST', '/api/cancel', { runId: tracker.state.runId }).catch(() => {});
    graceTimer = setTimeout(() => { if (abortSocket) abortSocket(); }, CANCEL_GRACE_MS);
    if (graceTimer.unref) graceTimer.unref();
  }
  const onSigint = () => { log('\n· cancelling…'); cancel('signal'); };
  process.once('SIGINT', onSigint);
  if (opts.timeoutSec) { timeoutTimer = setTimeout(() => { log('\n· --timeout reached, cancelling'); cancel('timeout'); }, opts.timeoutSec * 1000); }

  const pendingConsent = [];
  const handlers = {
    sawEnd: () => tracker.state.sawEnd,
    cancelled: () => cancelSent,
    bindAbort: (fn) => { abortSocket = fn; },
    onEvent: (ev) => {
      for (const a of tracker.feed(ev)) {
        if (a.kind === 'text') { if (!opts.json) process.stdout.write(a.delta); }
        else if (a.kind === 'tool' || a.kind === 'note') log(a.line);
        else if (a.kind === 'consent') pendingConsent.push(answerConsent(client, tracker.state.runId, a.ev, opts).catch(e => log('! consent reply failed: ' + (e && e.message))));
      }
    }
  };
  let dropped = false;
  try {
    const r = await streamRun(client, body, handlers);
    dropped = !!r.dropped;
  } finally {
    process.removeListener('SIGINT', onSigint);
    if (graceTimer) clearTimeout(graceTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    await Promise.all(pendingConsent);
  }
  const summary = tracker.summary();
  const endedAt = Date.now();
  const code = core.exitCodeForReason(summary.reason, { proven: summary.proven });
  if (opts.json) {
    process.stdout.write(JSON.stringify(core.jsonResult(summary, {
      agentId: sel.agentId, agentName: sel.name, model: sel.model, provider: sel.provider,
      baseUrl: client.base, mode, workspace: station.workspace || null, version: String(rt.json.version || ''),
      startedAt, endedAt
    })) + '\n');
  } else {
    if (summary.text && !summary.text.endsWith('\n')) process.stdout.write('\n');
    const spend = summary.usd ? ' · $' + summary.usd.toFixed(4) : '';
    if (summary.proven) log('■ ' + summary.reason + (summary.finishReason ? ' (' + summary.finishReason + ')' : '') + ' · ' + summary.turns + ' turn(s)' + spend + ' · ' + summary.toolCalls.length + ' tool call(s) · run ' + (summary.runId || '?'));
    else log('■ ' + (dropped ? 'the stream ended without agent.run.end' : 'no terminal event') + ' — reported as ' + summary.reason + ' (nothing proves the run finished)');
    if (summary.errors.length) log('  ' + summary.errors.join('\n  '));
  }
  return code;
}

// ---- status / doctor ---------------------------------------------------------------------------
async function statusCommand(opts, station) {
  const { client, mode } = station;
  const [ver, rt, prov, dir] = await Promise.all([
    client.request('GET', '/api/version'), client.request('GET', '/api/runtime/agent'),
    client.request('GET', '/api/providers'), client.request('GET', '/api/workspace/dir?agent=' + encodeURIComponent(core.DEFAULT_AGENT_ID))
  ]);
  const v = (ver.ok && ver.json) || {};
  const r = (rt.ok && rt.json) || {};
  const configured = (prov.ok && prov.json && Array.isArray(prov.json.providers)) ? prov.json.providers.filter(p => p && p.configured).map(p => p.id) : [];
  const wsFromStation = (dir.ok && dir.status === 200 && dir.json && dir.json.dir) ? path.dirname(String(dir.json.dir)) : '';
  const workspace = station.workspace || wsFromStation || '';
  const out = {
    reachable: true, baseUrl: client.base, mode,
    version: { harness: v.harness || '', app: v.app || '', node: v.node || '' },
    workspace: workspace || null,
    providers: configured,
    keychain: !!(prov.ok && prov.json && prov.json.keychainMode),
    agents: Array.isArray(r.agents) ? r.agents.map(a => ({ agentId: a.agentId, name: a.name, model: a.model, provider: a.provider })) : []
  };
  if (opts.json) { process.stdout.write(JSON.stringify(out) + '\n'); return 0; }
  process.stdout.write([
    'station    ' + out.baseUrl + ' (' + mode + ')',
    'version    harness ' + (out.version.harness || '?') + (out.version.app ? ' · app ' + out.version.app : '') + ' · node ' + out.version.node,
    'workspace  ' + (out.workspace || 'not disclosed by the station'),
    'providers  ' + (out.providers.length ? out.providers.join(', ') : 'none configured') + (out.keychain ? ' (keys in the OS keychain)' : ''),
    'agents     ' + (out.agents.length ? out.agents.map(a => a.agentId + '=' + a.name + ' [' + (a.provider || '?') + '/' + (a.model || 'no model') + ']').join('\n           ') : 'none')
  ].join('\n') + '\n');
  return 0;
}
async function doctorCommand(opts, station) {
  const r = await station.client.request('GET', '/api/diagnostics');
  if (!r.ok || r.status !== 200 || !r.json) throw stationError('diagnostics unavailable (' + (r.error || 'HTTP ' + r.status) + ')');
  if (opts.json) process.stdout.write(JSON.stringify(r.json.report || r.json) + '\n');
  else process.stdout.write(String(r.json.text || JSON.stringify(r.json, null, 2)) + '\n');
  return 0;
}

// ---- station resolution ------------------------------------------------------------------------
function stationError(msg) { const e = new Error(msg); e.exitCode = core.EXIT.STATION; return e; }
// StarNet's own workspaces: never offered as a project folder
function stationDirs(station) { return [station && station.workspace, desktopWorkspaces(process.env)].filter(Boolean); }

// a station answering: read its API token the way the browser does (or --token) and prove it is accepted
async function attachClient(client, opts) {
  if (opts.token) client.setToken(opts.token);
  else await client.discoverToken();
  if (!client.token()) throw stationError('a station answers at ' + client.base + ' but its API token could not be read — pass --token');
  const probe = await client.request('GET', '/api/version', null, { timeoutMs: 5000 });
  if (probe.ok && (probe.status === 401 || probe.status === 403)) throw stationError('the station at ' + client.base + ' rejected the API token');
  return client;
}

// ---- the desktop app, started for the terminal (step 4) ------------------------------------------------------
const APP_START_MS = 90000;
// the sessions that keep a station they started or joined: a question (status, ls, approve, …) is over before it matters
const APP_SESSIONS = ['dash', 'run', 'watch', 'flow'];
/* The app's terminal launch (src-tauri/src/terminal_session.rs): this process is the session it runs for. Detached,
   no stdio: the app is not this terminal's child to stop (its own close decision ends it), and nothing it prints
   lands on the dashboard. NOT windowsHide: Windows hands a hidden start to the app's FIRST ShowWindow, so the
   window a person later opens from the tray would stay hidden. */
function launchApp(exe) {
  const args = ['--background', '--terminal-pid', String(process.pid)];
  const js = /\.[cm]?js$/i.test(exe);   // a .js app (a test or dev stand-in for the desktop shell) runs on this node
  const child = spawn(js ? process.execPath : exe, js ? [exe].concat(args) : args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}
// startup.log: its size now, and what the app wrote after a size (it only appends, so that is about this start/join)
function startupLogFile(desktopWs) { return path.join(path.dirname(desktopWs), 'startup.log'); }
function startupLogSize(desktopWs) { try { return fs.statSync(startupLogFile(desktopWs)).size; } catch (_) { return 0; } }
function startupLogFrom(desktopWs, offset) {
  const file = startupLogFile(desktopWs);
  try {
    const size = fs.statSync(file).size, from = Math.max(offset, size - 256 * 1024);
    if (size <= from) return '';
    const fd = fs.openSync(file, 'r');
    try { const buf = Buffer.alloc(size - from); fs.readSync(fd, buf, 0, buf.length, from); return buf.toString('utf8'); } finally { fs.closeSync(fd); }
  } catch (_) { return ''; }
}
// what the app said about this terminal since `offset` (cli-core joinOutcome), waiting up to `ms` for it to say it
const JOIN_CONFIRM_MS = 5000;
async function awaitJoinOutcome(desktopWs, offset, ms) {
  const t0 = Date.now();
  for (;;) {
    const got = core.joinOutcome(startupLogFrom(desktopWs, offset), process.pid);
    if (got || Date.now() - t0 >= ms) return got || 'unconfirmed';
    await sleep(150);
  }
}
/* The station the app brings up: its owner file names the new sidecar, the OS its port (discoverDesktop). `avoidOwner`
   is the sidecar of a StarNet that is closing: never attached to, unless that StarNet turns out to stay (in the tray).
   A launch that hands off to a StarNet on its way out is told so (`closing`) and starts again once it has gone. */
async function startAppStation(exe, desktopWs, host, said, avoidOwner) {
  const logFile = startupLogFile(desktopWs);
  log(said || '· StarNet isn\'t running — starting it in the background (your keys stay in the app; no window opens)');
  const t0 = Date.now();
  let slow = false, avoid = avoidOwner || 0;
  for (let tries = 0; tries < 30 && Date.now() - t0 < APP_START_MS; tries++) {
    const at = startupLogSize(desktopWs);
    let gone = null, child, again = false;
    try { child = launchApp(exe); } catch (e) { throw stationError('StarNet could not be started (' + exe + '): ' + ((e && e.message) || e)); }
    child.on('error', e => { gone = { error: e }; });
    child.on('exit', (code, signal) => { gone = gone || { code, signal }; });
    while (Date.now() - t0 < APP_START_MS) {
      const d = discoverDesktop(desktopWs);
      if (d.ownerAlive && d.port && d.ownerPid !== avoid) {
        const client = makeClient(host, d.port);
        if (await client.health(1500)) return client;
      }
      if (gone && gone.error) throw stationError('StarNet could not be started (' + exe + '): ' + ((gone.error && gone.error.message) || gone.error));
      if (gone && gone.code === core.APP_EXIT_START_CANCELLED) throw stationError('StarNet\'s engine didn\'t start, and its startup dialog was cancelled — ' + logFile + ' says why');
      if (gone && (gone.code || gone.signal)) throw stationError('StarNet stopped while starting (' + (gone.signal || 'exit ' + gone.code) + ') — ' + logFile + ' says why');
      // exit 0 is a hand-off to a StarNet already running or starting: one on its way out says `closing` (start again
      // once it has gone); one that stayed in the tray after all says this terminal is not tracked (its station is fine)
      if (gone) {
        const told = core.joinOutcome(startupLogFrom(desktopWs, at), process.pid);
        if (told === 'closing') { again = true; break; }
        if (told === 'not-tracked') avoid = 0;
      }
      if (!slow && Date.now() - t0 > 20000) { slow = true; log('· still starting StarNet…'); }
      await sleep(400);
    }
    if (!again) break;
    await sleep(1000);
  }
  throw stationError('StarNet was started in the background, but its station did not answer within ' + (APP_START_MS / 1000) + 's — if a StarNet dialog is open, answer it; ' + logFile + ' says why');
}
// the app's own record of the sidecar it spawned last (startup.log), so a station some OTHER terminal booted on the
// desktop's workspace is never mistaken for the app's
function startupLogTail(desktopWs) {
  try { return readTail(path.join(path.dirname(desktopWs), 'startup.log'), 256 * 1024); } catch (_) { return ''; }
}

async function resolveStation(opts, env) {
  const host = opts.host || '127.0.0.1';
  const candidates = [];
  if (opts.port) candidates.push({ source: 'flag', port: opts.port });
  else candidates.push({ source: 'default', port: core.DEFAULT_PORT });
  const desktopWs = desktopWorkspaces(env);
  const desktop = discoverDesktop(desktopWs);
  const tail = startupLogTail(desktopWs);
  desktop.appExe = findAppExe(desktopWs, env, null, tail);
  const spawned = core.parseStartupLog(tail);
  desktop.appOwned = !!(desktop.ownerAlive && spawned && spawned.pid === desktop.ownerPid);
  // a NAMED port is that station or an error: the desktop is a candidate only when no port was named (a dead --port
  // used to fall through to the desktop app's station, so `approve --port N` could answer asks on the wrong station)
  if (!opts.port && desktop.port && !candidates.some(c => c.port === desktop.port)) candidates.push({ source: 'desktop', port: desktop.port });
  if (!opts.spawn) {
    for (const c of candidates) {
      const client = makeClient(host, c.port);
      c.reachable = await client.health(1500);
      c.client = client;
    }
  }
  const choice = core.chooseStation({ candidates, desktop, workspaceOverride: !!opts.workspace, noSpawn: opts.noSpawn, forceSpawn: opts.spawn });
  if (choice.mode === 'refuse') throw stationError(choice.reason);
  if (choice.mode === 'launch-app') {
    const client = await attachClient(await startAppStation(choice.exe, desktopWs, host), opts);
    return { mode: 'attached', client, workspace: desktopWs, child: null };
  }
  if (choice.mode === 'attach') {
    const c = candidates.find(x => x.port === choice.port);
    /* joining the app's station: tell the app this terminal uses it too (the same --background launch; it reaches the
       running app and ends), so when it was started for another starnet session, that one ending never closes the
       station under this one. Sent BEFORE the token fetch (the sooner the app hears, the less room for a close to
       overtake it), then confirmed from what the app logs: tracked, a person's StarNet (nothing to track), or closing
       — its last session just ended — so start it again once it has quit (review 0.14.1, F7). */
    const joining = !!(desktop.appOwned && desktop.appExe && desktop.port === choice.port && APP_SESSIONS.indexOf(opts.cmd) >= 0);
    const joinAt = joining ? startupLogSize(desktopWs) : -1;
    if (joining) { try { launchApp(desktop.appExe).on('error', () => {}); } catch (_) {} }
    // the attach and the app's answer run together: a closing station can fail the token fetch before its "closing" is
    // read, and a StarNet on its way out is started again either way
    const attaching = attachClient(c.client, opts).then(cl => ({ cl }), err => ({ err }));
    const told = joining ? await awaitJoinOutcome(desktopWs, joinAt, JOIN_CONFIRM_MS) : null;
    const attached = await attaching;
    if (told === 'closing') {
      const fresh = await startAppStation(desktop.appExe, desktopWs, host, '· StarNet is closing (its last starnet session just ended) — starting it again', desktop.ownerPid);
      return { mode: 'attached', client: await attachClient(fresh, opts), workspace: desktopWs, child: null };
    }
    if (attached.err) throw attached.err;
    return { mode: 'attached', client: attached.cl, workspace: (choice.source === 'desktop' && desktop.ownerAlive) ? desktopWs : '', child: null };
  }
  // spawn
  const ws = defaultWorkspace(opts);
  if (path.resolve(ws) === path.resolve(desktopWs) && desktop.ownerAlive) throw stationError('the desktop app owns ' + ws + ' (pid ' + desktop.ownerPid + '); refusing to boot a second station on it');
  // the dashboard sets a new station up itself (the awakening); a headless run gets the one-agent station it needs
  const boot = opts.cmd === 'dash' ? { wrote: false } : bootstrapWorkspace(ws, opts, env);
  if (boot.refused) throw stationError(boot.reason);
  if (boot.wrote) log('· bootstrapped ' + ws + ' — agent ' + opts.name + ' (full power)' + (boot.provider ? ' · provider ' + boot.provider + ' from ' + boot.providerSource : ' · no provider credential found in the environment') + (boot.model ? ' · model ' + boot.model : ' · no model (pass --model or set STARNET_DEFAULT_MODEL)'));
  log('· booting a station on ' + ws);
  const sp = await spawnSidecar(ws, env, null);
  return { mode: 'spawned', client: sp.client, workspace: ws, child: sp.child };
}

// ---- main --------------------------------------------------------------------------------------
async function main() {
  let opts;
  try { opts = core.parseArgs(process.argv.slice(2), process.env, { tty: !!(process.stdin.isTTY && process.stdout.isTTY) }); }
  catch (e) { log('starnet: ' + e.message + '\n'); log(core.USAGE); return core.EXIT.USAGE; }
  if (opts.version) { process.stdout.write('starnet ' + require('./lib/version.js').cliVersion(REPO) + '\n'); return 0; }
  if (opts.help) { process.stdout.write(core.USAGE + '\n'); return 0; }
  if (opts.promptFromStdin) {
    opts.prompt = await new Promise(r => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { s += d; }); process.stdin.on('end', () => r(s)); });
    opts.prompt = opts.prompt.replace(/\s+$/, '');
    if (!opts.prompt) { log('starnet: stdin carried no prompt'); return core.EXIT.USAGE; }
  }

  if (opts.cmd === 'init') {
    const ws = defaultWorkspace(opts);
    const desktop = discoverDesktop(desktopWorkspaces(process.env));
    if (path.resolve(ws) === path.resolve(desktop.workspace) && desktop.ownerAlive) { log('starnet: the desktop app is running on ' + ws + ' — nothing to bootstrap'); return 0; }
    const r = bootstrapWorkspace(ws, opts, process.env);
    if (!r.wrote) { log('starnet: ' + ws + ' — ' + r.reason); return r.refused ? core.EXIT.STATION : 0; }
    log('starnet: bootstrapped ' + ws + '\n  agent    ' + opts.name + ' (approvalMode full)\n  provider ' + (r.provider || 'openrouter (no credential found in the environment yet)') + (r.providerSource ? ' — from ' + r.providerSource : '') + '\n  model    ' + (r.model || '(none — pass --model or set STARNET_DEFAULT_MODEL)'));
    return 0;
  }

  if (opts.cmd === 'dash' && !(process.stdin.isTTY && process.stdout.isTTY)) {
    log('starnet: the dashboard needs an interactive terminal — for a pipe or a script use `starnet ls`, `starnet watch` or `starnet approve`');
    return core.EXIT.USAGE;
  }
  let station = null;
  const io = { out: s => process.stdout.write(s), err: s => process.stderr.write(s), columns: process.stdout.columns || 100 };
  try {
    // a question never boots a station, and an answer or a watch only means something on a station already running
    // (`flow run` sends a job: that one starts it, like -p)
    if (['status', 'doctor', 'ls', 'approve', 'deny', 'watch'].indexOf(opts.cmd) >= 0 || (opts.cmd === 'flow' && opts.args[0] !== 'run')) opts.noSpawn = true;
    station = await resolveStation(opts, process.env);
    if (opts.cmd === 'status') return await statusCommand(opts, station);
    if (opts.cmd === 'doctor') return await doctorCommand(opts, station);
    if (opts.cmd === 'dash') return await require('./lib/dashboard.js').runDashboard(station, { cwd: opts.cwd ? path.resolve(opts.cwd) : '', stationDirs: stationDirs(station) });
    const sc = require('./lib/station-commands.js');
    if (opts.cmd === 'ls') return await sc.lsCommand(opts, station, io);
    if (opts.cmd === 'approve' || opts.cmd === 'deny') return await sc.answerCommand(opts, station, io);
    if (opts.cmd === 'watch') return await sc.watchCommand(opts, station, io);
    if (opts.cmd === 'flow') return await sc.flowCommand(opts, station, io);
    return await runCommand(opts, station);
  } catch (e) {
    const code = (e && e.exitCode) || core.EXIT.RUN_FAILED;
    if (opts.json) process.stdout.write(JSON.stringify({ ok: false, reason: 'error', proven: false, exitCode: code, error: String((e && e.message) || e) }) + '\n');
    log('starnet: ' + String((e && e.message) || e));
    if (opts.cmd === 'status' && code === core.EXIT.STATION && !opts.json && String(e && e.message) !== core.DESKTOP_CLOSED) log('(no station reachable — run `starnet -p "…"` to boot one, or start the desktop app)');
    return code;
  } finally {
    if (station && station.child) await stopChild(station.child, station.workspace);
  }
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; setTimeout(() => process.exit(code), 50).unref(); },
    e => { log('starnet: ' + ((e && e.stack) || e)); process.exit(core.EXIT.RUN_FAILED); });
}

module.exports = { desktopWorkspaces, bareWorkspaces, defaultWorkspace, discoverDesktop, findAppExe, readTail, makeClient, bootstrapWorkspace, resolveStation, stopChild, STOP_GRACE_MS, SIDECAR_SHUTDOWN_DEADLINE_MS, _core: core };
