/* sidecar/mcp/transport.stdio.js - MCP stdio transport.
   Spawns one allowlisted local command with shell:false, speaks newline-framed
   JSON-RPC over stdin/stdout, and tears the child down when the connector closes.

   makeStdioTransport({ command, args?, cwd?, env?, allowedCommands?, spawnImpl?,
     processEnv?, platform?, timeoutMs?, onError? }) -> transport
     transport = { send(message)->Promise, onMessage(cb), close(), isClosed() }

   SECURITY: stdio MCP servers are local code execution. The command must be on an
   explicit allowlist, no shell is used, ambient process.env is not inherited wholesale,
   and summaries should only expose redacted env keys. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.mcp = root.SK.mcp || {}).transportStdio = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CP = require('../child-env.js').guardChildProcess(require('node:child_process'));   // the stdio child's env is built explicitly below; helpers get the station-free default
  const P = require('path');
  const JSONRPC = '2.0';
  const LOCAL_ERROR = Symbol.for('starnet.mcp.localTransportError');   // read by client.js safeRpcError
  const DEFAULT_ALLOWED = [
    'node', 'node.exe',
    'npx', 'npx.cmd',
    'npm', 'npm.cmd',
    'pnpm', 'pnpm.cmd',
    'yarn', 'yarn.cmd',
    'python', 'python.exe', 'python3',
    'uvx', 'uvx.exe'
  ];
  const BASE_ENV_KEYS = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'
  ];
  const SECRET_ENV_RE = /(TOKEN|KEY|SECRET|PASSWORD|PASS|AUTH|BEARER|CREDENTIAL|COOKIE)/i;

  function commandBase(command) {
    const s = String(command || '').trim();
    return P.basename(s.replace(/\\/g, '/')).toLowerCase();
  }
  function normalizeAllowed(list) {
    if (!Array.isArray(list)) list = String(process.env.STARNET_MCP_STDIO_ALLOW || '').split(/[;,]/).filter(Boolean);
    const out = list.length ? list : DEFAULT_ALLOWED;
    return out.map(commandBase).filter(Boolean);
  }
  function assertAllowedCommand(command, allowedCommands) {
    const cmd = String(command || '').trim();
    if (!cmd) throw new Error('mcp stdio command is required');
    if (/[\0\r\n]/.test(cmd)) throw new Error('mcp stdio command contains a control character');
    const base = commandBase(cmd);
    const allowed = normalizeAllowed(allowedCommands);
    if (allowed.indexOf('*') < 0 && allowed.indexOf(base) < 0) {
      throw new Error('mcp stdio command is not allowlisted: ' + base);
    }
    return cmd;
  }
  function normalizeArgs(args) {
    if (args == null) return [];
    if (!Array.isArray(args)) throw new Error('mcp stdio args must be an array');
    if (args.length > 64) throw new Error('mcp stdio args are too long');
    return args.map(a => {
      const s = String(a == null ? '' : a);
      if (/[\0]/.test(s)) throw new Error('mcp stdio arg contains NUL');
      if (s.length > 4096) throw new Error('mcp stdio arg is too long');
      return s;
    });
  }
  function normalizeEnv(env) {
    if (env == null) return {};
    if (typeof env !== 'object' || Array.isArray(env)) throw new Error('mcp stdio env must be an object');
    const out = {};
    const keys = Object.keys(env);
    if (keys.length > 128) throw new Error('mcp stdio env has too many keys');
    for (const k of keys) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error('mcp stdio env key is invalid: ' + k);
      const v = String(env[k] == null ? '' : env[k]);
      if (/[\0]/.test(v)) throw new Error('mcp stdio env value contains NUL: ' + k);
      if (v.length > 8192) throw new Error('mcp stdio env value is too long: ' + k);
      out[k] = v;
    }
    return out;
  }
  function buildChildEnv(extra, base) {
    const src = base || process.env || {};
    const out = {};
    for (const k of BASE_ENV_KEYS) if (src[k] != null) out[k] = String(src[k]);
    const e = normalizeEnv(extra);
    for (const k of Object.keys(e)) out[k] = e[k];
    // Host-owned safety pins always win over connector-supplied env. These are defense in
    // depth for a future isolated stdio worker; installed preserve mode refuses host stdio
    // entirely below.
    out.STARNET_USER_CONTROL_MODE = 'preserve';
    out.STARNET_COMPUTER_DRIVER = '0';
    out.STARNET_BROWSER_HEADLESS = '1';
    out.STARNET_MCP_STDIO = '0';
    out.BROWSER = 'none';
    return out;
  }
  function hostStdioAllowed(deps, env) {
    env = env || {};
    const explicit = String(env.STARNET_MCP_STDIO != null ? env.STARNET_MCP_STDIO : (env.SKYNET_MCP_STDIO || '')).trim();
    if (/^(0|false|off|none)$/i.test(explicit)) return false;
    // Default deny everywhere, including dev/bare sidecar. Only a process broker that proves
    // a noninteractive execution cell may opt in; a user/env flag alone is insufficient.
    return !!(deps && deps.userControlIsolated === true);
  }
  function redactEnv(env) {
    const e = normalizeEnv(env || {});
    const out = {};
    for (const k of Object.keys(e).sort()) out[k] = SECRET_ENV_RE.test(k) ? '<redacted>' : '<set>';
    return out;
  }
  function safeLedgerCommand(command, args) {
    const out = [String(command || '')];
    let redactNext = false;
    for (const raw of (Array.isArray(args) ? args : [])) {
      const value = String(raw == null ? '' : raw);
      if (redactNext) { out.push('<redacted>'); redactNext = false; continue; }
      const eq = value.match(/^(--?[^=]+)=(.*)$/);
      if (eq && SECRET_ENV_RE.test(eq[1])) { out.push(eq[1] + '=<redacted>'); continue; }
      if (/^--?/.test(value) && SECRET_ENV_RE.test(value)) { out.push(value); redactNext = true; continue; }
      if (/^https?:\/\//i.test(value)) {
        try { const u = new URL(value); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; out.push(u.href); }
        catch (_) { out.push('<url>'); }
      } else out.push(value);
    }
    return out.join(' ').slice(0, 400);
  }

  function makeStdioTransport(deps) {
    deps = deps || {};
    const processEnv = deps.processEnv || process.env || {};
    if (!hostStdioAllowed(deps, processEnv)) {
      throw new Error('mcp stdio is disabled on the interactive host: use an HTTP connector or an isolated execution backend');
    }
    const command = assertAllowedCommand(deps.command, deps.allowedCommands);
    const args = normalizeArgs(deps.args);
    const cwd = deps.cwd ? String(deps.cwd) : undefined;
    if (cwd && /[\0\r\n]/.test(cwd)) throw new Error('mcp stdio cwd contains a control character');
    const childEnv = buildChildEnv(deps.env, processEnv);
    const spawnImpl = deps.spawnImpl || CP.spawn;
    const platform = deps.platform || process.platform;
    const timeoutMs = deps.timeoutMs || 30000;
    const onError = typeof deps.onError === 'function' ? deps.onError : function () {};

    const ledger = deps.ledger;
    const ledgerCommand = String(deps.ledgerCommand || safeLedgerCommand(command, args)).slice(0, 400);
    let child = null, onMsg = null, closed = false, stdoutBuf = '', stderrBuf = '';
    const pendingIds = new Set();

    function deliver(msg) {
      if (msg && msg.id != null && (('result' in msg) || ('error' in msg))) pendingIds.delete(msg.id);
      if (onMsg) { try { onMsg(msg); } catch (e) { onError(e); } }
    }
    function failTo(id, message) {
      if (id != null) deliver({ jsonrpc: JSONRPC, id: id, error: { code: -32000, message: message, [LOCAL_ERROR]: true } });
      else onError(new Error(message));
    }
    function failAll(message) {
      const ids = Array.from(pendingIds);
      pendingIds.clear();
      for (const id of ids) deliver({ jsonrpc: JSONRPC, id: id, error: { code: -32000, message: message, [LOCAL_ERROR]: true } });
    }
    function parseStdoutChunk(chunk) {
      stdoutBuf += String(chunk || '');
      for (;;) {
        const i = stdoutBuf.search(/\r?\n/);
        if (i < 0) break;
        const line = stdoutBuf.slice(0, i);
        stdoutBuf = stdoutBuf.slice(stdoutBuf.charAt(i) === '\r' && stdoutBuf.charAt(i + 1) === '\n' ? i + 2 : i + 1);
        if (!line.trim()) continue;
        try { deliver(JSON.parse(line)); }
        catch (e) { onError(new Error('mcp stdio returned non-JSON line')); }
      }
    }
    function noteStderr(chunk) {
      stderrBuf = (stderrBuf + String(chunk || '')).slice(-2000);
    }
    function ensureChild() {
      if (child) return child;
      if (closed) throw new Error('mcp stdio transport closed');
      child = spawnImpl(command, args, {
        cwd: cwd,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: platform !== 'win32'
      });
      if (!child || !child.stdin || !child.stdout) throw new Error('mcp stdio spawn did not return stdio pipes');
      const ownedChild = child;
      if (ledger && child.pid) {
        try { ledger.record({ pid: child.pid, cmd: ledgerCommand, kind: 'mcp.stdio' }); } catch (_) {}
      }
      if (child.stdout.setEncoding) child.stdout.setEncoding('utf8');
      if (child.stderr && child.stderr.setEncoding) child.stderr.setEncoding('utf8');
      if (child.stdout.on) child.stdout.on('data', parseStdoutChunk);
      if (child.stderr && child.stderr.on) child.stderr.on('data', noteStderr);
      if (child.on) {
        child.on('error', e => {
          const msg = 'mcp stdio process error: ' + ((e && e.message) || e);
          closed = true;
          failAll(msg);
          onError(new Error(msg));
        });
        child.on('exit', (code, signal) => {
          if (ledger && ownedChild.pid) { try { ledger.release(ownedChild.pid); } catch (_) {} }
          const exited = 'mcp stdio process exited' + (code == null ? '' : ' code=' + code) + (signal ? ' signal=' + signal : '');
          const detail = exited + (stderrBuf.trim() ? ': ' + stderrBuf.trim().slice(0, 200) : '');
          const hadPending = pendingIds.size > 0;
          const wasClosed = closed;                 // true only when OUR close() asked the child to go
          closed = true;
          // the RPC error is shown to the model and in status: the server's own stderr stays out of it (it is
          // server-authored text and may echo a token); the exit code is ours.
          failAll(exited);
          // ANY exit we did not request is a transport death — a clean idle code-0 self-exit included.
          // Skipping onError for those left the manager at state 'up' over a dead child: ensureLive
          // short-circuits on 'up', the stdio call path has no CALL_FAIL_LIMIT net (that lives in
          // httpCall), and per-call lastUsedAt bumps kept the idle recycle away — so the connector
          // answered -32000 forever while the panel reported up with a full tool list.
          if (!wasClosed || hadPending) onError(new Error(detail));
        });
      }
      if (timeoutMs > 0 && child.stdin && typeof child.stdin.setDefaultEncoding === 'function') child.stdin.setDefaultEncoding('utf8');
      return child;
    }
    function send(message) {
      const id = message && message.id;
      if (closed) { failTo(id, 'mcp stdio transport closed'); return Promise.resolve(); }
      let c;
      try { c = ensureChild(); } catch (e) { failTo(id, (e && e.message) || String(e)); return Promise.resolve(); }
      if (id != null) pendingIds.add(id);
      const line = JSON.stringify(message) + '\n';
      return new Promise(resolve => {
        let done = false;
        function finish() { if (!done) { done = true; resolve(); } }
        try {
          const ok = c.stdin.write(line, 'utf8', finish);
          if (!ok && c.stdin.once) c.stdin.once('drain', finish);
        } catch (e) {
          if (id != null) pendingIds.delete(id);
          failTo(id, 'mcp stdio write failed: ' + ((e && e.message) || e));
          finish();
        }
      });
    }
    function onMessage(cb) { onMsg = cb; }
    function close() {
      if (closed && !child) return;
      closed = true;
      failAll('mcp stdio transport closed');
      const c = child;
      child = null;
      if (!c) return;
      try { if (c.stdin && c.stdin.end) c.stdin.end(); } catch (e) {}
      try {
        if (platform === 'win32' && c.pid) {
          try { CP.spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (e) {}
        } else if (c.pid) {
          try { process.kill(-c.pid, 'SIGTERM'); } catch (e) { try { c.kill && c.kill('SIGTERM'); } catch (_) {} }
        } else if (c.kill) {
          c.kill('SIGTERM');
        }
      } catch (e) { onError(e); }
    }

    return { send, onMessage, close, isClosed: function () { return closed; }, get childPid() { return child && child.pid; } };
  }

  return { makeStdioTransport, _internals: { commandBase, assertAllowedCommand, normalizeArgs, normalizeEnv, buildChildEnv, hostStdioAllowed, redactEnv, safeLedgerCommand } };
});
