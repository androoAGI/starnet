/* sidecar/terminal-sessions.js — durable, agent-owned PTY / ConPTY sessions.

   A pipe-backed background process is not a terminal: interactive programs inspect terminal state, redraw in
   place, react to Ctrl-C, and need resize events. This manager owns that missing runtime primitive. `node-pty`
   is injected (and loaded lazily by the host) so a missing native binding makes terminal.start honestly
   unavailable without preventing the sidecar from booting.

   Process handles are intentionally NOT "reattached" after a sidecar restart. The durable store records enough
   metadata to show what existed, but a prior-life running/stopping record boots as `unknown`, with pid removed
   and attached:false. procledger owns orphan cleanup; a persisted PID alone is never authority to control a
   process in a new life.

     makeTerminalSessions({ pty, clock?, newId?, load?, save?, redact?, ledger?, stopTree?, ... }) ->
       { available, start, status, read, write, resize, interrupt, stop, stopAll, countRunning, storeHealth }
*/
'use strict';
const { stationChildEnv } = require('./child-env.js');   // a PTY with no explicit env still never inherits station secrets

const ACTIVE_STATES = new Set(['starting', 'running', 'stopping']);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const AGENT_RE = /^[A-Za-z0-9_-]{1,40}$/;

function clamp(n, lo, hi, dflt) {
  n = Number(n);
  if (!Number.isFinite(n)) n = dflt;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
function safeAgentId(id) {
  id = String(id || 'agent');
  if (!AGENT_RE.test(id)) throw new Error('bad agentId');
  return id;
}
function cleanName(name) {
  name = String(name || '').trim();
  if (!NAME_RE.test(name)) throw new Error('session name must be 1-40 letters, numbers, dot, dash, or underscore');
  return name;
}
function nameKey(agentId, name) { return agentId + '\n' + String(name).toLowerCase(); }
function stripAnsi(value) {
  // Terminal output is stored as readable scrollback, not an ANSI instruction stream. Handles CSI, OSC title
  // sequences and the single-character escapes commonly emitted by shells without attempting terminal emulation.
  return String(value == null ? '' : value)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r(?!\n)/g, '\n');
}
function defaultSpawnSpec(command, platform, env) {
  if (platform === 'win32') {
    const shell = String((env && env.ComSpec) || process.env.ComSpec || 'cmd.exe');
    return { file: shell, args: ['/d', '/s', '/c', String(command)] };
  }
  const shell = String((env && env.SHELL) || process.env.SHELL || '/bin/sh');
  return { file: shell, args: ['-lc', String(command)] };
}

function makeTerminalSessions(deps) {
  deps = deps || {};
  const pty = deps.pty || null;
  // The host owns wall-clock authority. A deterministic zero keeps the pure manager usable in
  // availability-only tests without smuggling ambient time into durable lifecycle metadata.
  const now = deps.clock && typeof deps.clock.now === 'function' ? deps.clock.now : (() => 0);
  const newId = typeof deps.newId === 'function' ? deps.newId : (() => String(now()));
  const load = typeof deps.load === 'function' ? deps.load : (() => ({ status: 'absent', value: null }));
  const save = typeof deps.save === 'function' ? deps.save : (() => {});
  const redact = typeof deps.redact === 'function' ? deps.redact : (v => String(v));
  const ledger = deps.ledger && typeof deps.ledger.record === 'function' ? deps.ledger : null;
  const stopTree = typeof deps.stopTree === 'function' ? deps.stopTree : null;
  const onExit = typeof deps.onExit === 'function' ? deps.onExit : (() => {});
  const spill = typeof deps.spill === 'function' ? deps.spill : null;
  const platform = deps.platform || process.platform;
  const spawnSpec = typeof deps.spawnSpec === 'function' ? deps.spawnSpec : defaultSpawnSpec;
  const RING = clamp(deps.ringChars, 4096, 4 * 1024 * 1024, 512 * 1024);
  const READ_MAX = clamp(deps.readMaxChars, 1024, 128 * 1024, 32000);
  const MAX_PER_AGENT = clamp(deps.maxPerAgent, 1, 32, 5);
  const MAX_HISTORY = clamp(deps.maxHistory, MAX_PER_AGENT, 1000, 100);

  const records = new Map();
  const byName = new Map();
  let lastPersisted = true;
  let persistError = '';
  let loadedStatus = 'absent';
  let storeWritable = true;

  function durableRecord(r) {
    return {
      sessionId: r.sessionId, agentId: r.agentId, name: r.name, command: r.command, cwd: r.cwd,
      state: r.state, pid: r.pid || null, cols: r.cols, rows: r.rows,
      startedAt: r.startedAt, endedAt: r.endedAt, exitCode: r.exitCode, exitSignal: r.exitSignal,
      stopRequested: !!r.stopRequested, totalOutputChars: r.totalOutputChars || 0,
      droppedChars: r.droppedChars || 0, reason: r.reason || '', outputPath: r.outputPath || null,
      outputBytes: r.outputBytes || 0, outputSpillError: r.outputSpillError || ''
    };
  }
  function persist() {
    if (!storeWritable) { lastPersisted = false; return false; }
    try {
      const rows = Array.from(records.values()).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
      save({ version: 1, sessions: rows.slice(-MAX_HISTORY).map(durableRecord) });
      lastPersisted = true; persistError = '';
      return true;
    } catch (e) {
      lastPersisted = false; persistError = String((e && e.message) || e || 'metadata write failed');
      return false;
    }
  }
  function storeHealth() { return { loaded: loadedStatus, persisted: lastPersisted, error: persistError || null }; }

  // Hydrate history, never process authority. A previously active record becomes explicitly unknowable in this
  // process life. Its PID is cleared so no caller can mistake metadata for an attached handle.
  try {
    const got = load() || {};
    loadedStatus = String(got.status || 'ok');
    if (loadedStatus === 'corrupt' || loadedStatus === 'unreadable') {
      storeWritable = false; lastPersisted = false;
      persistError = 'metadata store is ' + loadedStatus + '; refusing to overwrite untrusted prior state';
    }
    const envelope = got && Object.prototype.hasOwnProperty.call(got, 'value') ? got.value : got;
    const rows = envelope && Array.isArray(envelope.sessions) ? envelope.sessions.slice(-MAX_HISTORY) : [];
    let changed = false;
    for (const raw of rows) {
      if (!raw || !raw.sessionId || !AGENT_RE.test(String(raw.agentId || '')) || !NAME_RE.test(String(raw.name || ''))) continue;
      const r = Object.assign({}, raw, {
        sessionId: String(raw.sessionId), agentId: String(raw.agentId), name: String(raw.name),
        command: String(raw.command || ''), cwd: String(raw.cwd || ''), handle: null, attached: false,
        buffer: '', bufferStart: Number(raw.totalOutputChars) || 0, totalOutputChars: Number(raw.totalOutputChars) || 0,
        droppedChars: Number(raw.droppedChars) || 0, outputPath: raw.outputPath ? String(raw.outputPath) : null,
        outputBytes: Number(raw.outputBytes) || 0, outputSpillError: String(raw.outputSpillError || ''), exitCode: raw.exitCode == null ? null : Number(raw.exitCode),
        exitSignal: raw.exitSignal == null ? null : Number(raw.exitSignal), pid: null
      });
      if (ACTIVE_STATES.has(String(raw.state))) {
        r.state = 'unknown'; r.endedAt = now(); r.exitCode = null; r.exitSignal = null;
        r.reason = 'sidecar restarted; this prior-life terminal is not attached and its outcome is unknown';
        changed = true;
      } else if (!['exited', 'stopped', 'unknown'].includes(String(raw.state))) {
        r.state = 'unknown'; r.reason = 'stored lifecycle state was not recognized'; changed = true;
      }
      records.set(r.sessionId, r);
      byName.set(nameKey(r.agentId, r.name), r.sessionId);
    }
    if (changed) persist();
  } catch (e) {
    loadedStatus = 'unreadable'; lastPersisted = false; storeWritable = false;
    persistError = String((e && e.message) || e || 'metadata read failed');
  }

  function available() {
    return !!(pty && typeof pty.spawn === 'function');
  }
  function own(agentId, ref) {
    const aid = safeAgentId(agentId);
    const text = String(ref || '').trim();
    let r = records.get(text) || null;
    if (!r) r = records.get(byName.get(nameKey(aid, text))) || null;
    return r && r.agentId === aid ? r : null;
  }
  function runningCount(agentId) {
    const aid = safeAgentId(agentId);
    let n = 0;
    for (const r of records.values()) if (r.agentId === aid && ACTIVE_STATES.has(r.state) && r.attached) n++;
    return n;
  }
  function view(r) {
    return {
      sessionId: r.sessionId, name: r.name, command: r.command, cwd: r.cwd,
      state: r.state, running: ACTIVE_STATES.has(r.state) && !!r.attached, attached: !!r.attached,
      pid: r.attached ? (r.pid || null) : null, cols: r.cols, rows: r.rows,
      startedAt: r.startedAt, endedAt: r.endedAt || null, exitCode: r.exitCode,
      exitSignal: r.exitSignal, stopRequested: !!r.stopRequested,
      totalOutputChars: r.totalOutputChars || 0, bufferedChars: (r.buffer || '').length,
      droppedChars: r.droppedChars || 0, reason: r.reason || '', metadataPersisted: lastPersisted,
      outputPath: r.outputPath || null, outputBytes: r.outputBytes || 0,
      outputSpillVerified: !!r.outputPath && !r.outputSpillError, outputSpillError: r.outputSpillError || null
    };
  }
  function append(r, data) {
    const text = stripAnsi(redact(data));
    if (!text) return;
    if (spill) {
      try {
        const saved = spill({ agentId: r.agentId, kind: 'terminal', id: r.sessionId, text });
        if (saved && saved.path) { r.outputPath = String(saved.path); r.outputBytes = Math.max(0, Number(saved.bytes) || r.outputBytes); r.outputSpillError = ''; }
      } catch (e) { r.outputSpillError = String((e && e.message) || e || 'output spill failed').slice(0, 300); }
    }
    r.buffer += text;
    r.totalOutputChars += text.length;
    if (r.buffer.length > RING) {
      const drop = r.buffer.length - RING;
      r.buffer = r.buffer.slice(drop);
      r.bufferStart += drop;
      r.droppedChars += drop;
    }
    if (spill) persist();
  }
  function settle(r, event) {
    if (!r || !r.attached || !ACTIVE_STATES.has(r.state)) return;
    event = event || {};
    r.attached = false; r.handle = null; r.endedAt = now();
    r.exitCode = Number.isFinite(Number(event.exitCode)) ? Number(event.exitCode) : null;
    r.exitSignal = Number.isFinite(Number(event.signal)) ? Number(event.signal) : null;
    r.state = r.stopRequested ? 'stopped' : 'exited';
    r.reason = r.stopRequested ? 'stop requested by Agent OS' : '';
    try { if (ledger && r.pid) ledger.release(r.pid); } catch (_) {}
    r.pid = null;
    const persisted = persist();
    try { onExit(Object.assign(view(r), { agentId: r.agentId, persisted })); } catch (_) {}
  }
  function attach(r, handle) {
    const dataFn = data => append(r, data);
    const exitFn = event => settle(r, event);
    if (handle && typeof handle.onData === 'function') handle.onData(dataFn);
    else if (handle && typeof handle.on === 'function') handle.on('data', dataFn);
    if (handle && typeof handle.onExit === 'function') handle.onExit(exitFn);
    else if (handle && typeof handle.on === 'function') handle.on('exit', (code, signal) => exitFn({ exitCode: code, signal }));
  }

  function start(opts) {
    opts = opts || {};
    const agentId = safeAgentId(opts.agentId || 'agent');
    const name = cleanName(opts.name);
    const command = String(opts.command || '').trim();
    if (!command) return { ok: false, error: 'empty command' };
    if (!available()) return { ok: false, error: 'PTY runtime unavailable: node-pty is not installed or could not load on this platform' };
    const old = own(agentId, name);
    if (old && ACTIVE_STATES.has(old.state) && old.attached) return { ok: false, error: 'terminal session "' + name + '" is already running' };
    if (runningCount(agentId) >= MAX_PER_AGENT) return { ok: false, error: 'too many terminal sessions (max ' + MAX_PER_AGENT + ')' };
    const cols = clamp(opts.cols, 20, 500, 120), rows = clamp(opts.rows, 5, 300, 30);
    const spec = spawnSpec(command, platform, opts.env || {});
    let handle;
    try {
      handle = pty.spawn(spec.file, spec.args || [], {
        name: 'xterm-256color', cols, rows, cwd: opts.cwd, env: opts.env || stationChildEnv(process.env),
        useConpty: platform === 'win32'
      });
    } catch (e) {
      return { ok: false, error: 'could not start PTY: ' + String((e && e.message) || e) };
    }
    const sessionId = 'term_' + String(newId()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    const r = {
      sessionId, agentId, name, command: redact(command), cwd: String(opts.cwd || ''), state: 'running',
      handle, attached: true, pid: Number(handle.pid) || null, cols, rows, startedAt: now(), endedAt: null,
      exitCode: null, exitSignal: null, stopRequested: false, reason: '', buffer: '', bufferStart: 0,
      totalOutputChars: 0, droppedChars: 0, outputPath: null, outputBytes: 0, outputSpillError: ''
    };
    records.set(sessionId, r); byName.set(nameKey(agentId, name), sessionId);
    attach(r, handle);
    try {
      if (ledger && r.pid) {
        ledger.record({ pid: r.pid, cmd: r.command, kind: 'terminal.pty' });
        if (typeof ledger.pinIdentity === 'function') Promise.resolve(ledger.pinIdentity(r.pid)).catch(() => {});
      }
    } catch (_) {}
    return { ok: true, session: view(r), persisted: persist() };
  }

  function status(agentId, ref) {
    const aid = safeAgentId(agentId || 'agent');
    if (ref) { const r = own(aid, ref); return r ? view(r) : null; }
    return Array.from(records.values()).filter(r => r.agentId === aid).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).map(view);
  }
  function read(agentId, ref, opts) {
    opts = opts || {};
    const r = own(agentId, ref);
    if (!r) return { ok: false, error: 'no such terminal session' };
    const requested = opts.offset == null ? r.bufferStart : Math.max(0, Math.floor(Number(opts.offset) || 0));
    const offset = Math.max(requested, r.bufferStart);
    const local = Math.min(r.buffer.length, Math.max(0, offset - r.bufferStart));
    const maxChars = clamp(opts.maxChars, 1, READ_MAX, READ_MAX);
    const output = r.buffer.slice(local, local + maxChars);
    return {
      ok: true, session: view(r), output, offset, nextOffset: offset + output.length,
      availableFrom: r.bufferStart, endOffset: r.bufferStart + r.buffer.length,
      truncatedStart: requested < r.bufferStart, hasMore: local + output.length < r.buffer.length
    };
  }
  function write(agentId, ref, opts) {
    opts = opts || {};
    const r = own(agentId, ref);
    if (!r) return { ok: false, error: 'no such terminal session' };
    if (!r.attached || r.state !== 'running' || !r.handle || typeof r.handle.write !== 'function') return { ok: false, error: 'terminal session is not running' };
    const data = String(opts.data == null ? '' : opts.data) + (opts.submit === false ? '' : (platform === 'win32' ? '\r' : '\r'));
    if (!data) return { ok: false, error: 'empty input' };
    try { r.handle.write(data); } catch (e) { return { ok: false, error: 'terminal write failed: ' + String((e && e.message) || e) }; }
    return { ok: true, bytes: Buffer.byteLength(data), session: view(r) };
  }
  function resize(agentId, ref, cols, rows) {
    const r = own(agentId, ref);
    if (!r) return { ok: false, error: 'no such terminal session' };
    if (!r.attached || !r.handle || typeof r.handle.resize !== 'function') return { ok: false, error: 'terminal session is not attached' };
    const c = clamp(cols, 20, 500, r.cols), rr = clamp(rows, 5, 300, r.rows);
    try { r.handle.resize(c, rr); } catch (e) { return { ok: false, error: 'terminal resize failed: ' + String((e && e.message) || e) }; }
    r.cols = c; r.rows = rr;
    return { ok: true, session: view(r), persisted: persist() };
  }
  function interrupt(agentId, ref) {
    const r = own(agentId, ref);
    if (!r) return { ok: false, error: 'no such terminal session' };
    if (!r.attached || r.state !== 'running' || !r.handle || typeof r.handle.write !== 'function') return { ok: false, error: 'terminal session is not running' };
    try { r.handle.write('\x03'); } catch (e) { return { ok: false, error: 'interrupt failed: ' + String((e && e.message) || e) }; }
    return { ok: true, sent: true, session: view(r) };
  }
  function stop(agentId, ref) {
    const r = own(agentId, ref);
    if (!r) return { ok: false, error: 'no such terminal session' };
    if (!r.attached || !ACTIVE_STATES.has(r.state)) return { ok: true, alreadyExited: true, session: view(r) };
    r.stopRequested = true; r.state = 'stopping'; r.reason = 'stop requested; awaiting process exit';
    const persisted = persist();
    try {
      if (stopTree) stopTree(r.pid, r.handle, platform);
      else if (r.handle && typeof r.handle.kill === 'function') r.handle.kill();
      else return { ok: false, error: 'terminal has no stop primitive', session: view(r), persisted };
    } catch (e) { return { ok: false, error: 'stop failed: ' + String((e && e.message) || e), session: view(r), persisted }; }
    return { ok: true, requested: true, session: view(r), persisted };
  }
  function stopAll(agentId) {
    const aid = agentId == null ? null : safeAgentId(agentId);
    let count = 0;
    for (const r of records.values()) {
      if (aid != null && r.agentId !== aid) continue;
      if (r.attached && ACTIVE_STATES.has(r.state)) { const out = stop(r.agentId, r.sessionId); if (out.ok && out.requested) count++; }
    }
    return count;
  }
  function countRunning(agentId) {
    if (agentId != null) return runningCount(agentId);
    let n = 0; for (const r of records.values()) if (r.attached && ACTIVE_STATES.has(r.state)) n++;
    return n;
  }

  return {
    available, start, status, read, write, resize, interrupt, stop, stopAll, countRunning, storeHealth,
    _internals: { records, byName, own, view, append, settle, stripAnsi, defaultSpawnSpec, persist }
  };
}

module.exports = { makeTerminalSessions, _internals: { stripAnsi, defaultSpawnSpec, cleanName, safeAgentId } };
