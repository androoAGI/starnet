/* sidecar/lsp-manager.js — lazy, detected language-server diagnostics for file edits.

   This is the ambient half of sidecar/verify.js's diagnosticDelta(): it detects an already-installed
   language server, keeps one stdio client per project/language, captures diagnostics BEFORE an edit,
   captures them again AFTER the edit, and returns only the delta. It never installs anything and never
   turns "no server" or an unconfirmed diagnostic pass into a success-shaped result.

   makeLspManager({ spawn, fs, fsp, pathMod, env?, clock?, servers?, limits? })
     .beginEdit({ agentId, files:[{ abs, base, rel, text }], signal? }) -> ticket
     .finishEdit(ticket, { signal? }) -> { status, added[], removed[], addedCount, removedCount, ... }
     .closeAll()

   `servers` is injectable for deterministic tests. Production defaults cover common servers that are
   present on PATH; command discovery is read-only and bounded. Child environments contain only runtime
   plumbing (PATH/home/temp/locale), never Agent OS/provider/channel credentials. */
'use strict';

const { pathToFileURL, fileURLToPath } = require('node:url');
const { diagnosticDelta } = require('./verify.js');

const DEFAULT_SERVERS = Object.freeze([
  /* typescript-language-server EXECUTES THE PROJECT too (review security-storage-01): with no tsserver.path set it
     forks the workspace's own node_modules/typescript/lib/tsserver.js (searching parent folders too) ahead of its
     bundled copy. An agent's fs.write can plant that file, so it gets the same watched-run-only gate as rust-analyzer
     below. The gate only stops UNATTENDED runs from starting it: a planted file still runs on the next watched .js/.ts
     edit under that folder. Closing that needs tsserver.path pinned to a TypeScript outside the workspace. */
  { id: 'typescript', command: 'typescript-language-server', args: ['--stdio'], extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'], languageIds: { '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript' }, executesProject: true,
    executesWhy: 'can run the project\'s own TypeScript (node_modules/typescript)' },
  { id: 'pyright', command: 'pyright-langserver', args: ['--stdio'], extensions: ['.py', '.pyi'], languageIds: { '.py': 'python', '.pyi': 'python' } },
  /* rust-analyzer EXECUTES THE PROJECT (2026-10-10 security pass): `cargo metadata` honours the project's .cargo/config
     (build.rustc / rustc-wrapper) and rust-toolchain.toml (a path toolchain), and by default it also runs build.rs,
     proc macros and `cargo check` on save. An agent's own fs.write can plant any of those, so starting it is code
     execution: it starts only for a WATCHED run (executesProject) and never builds, expands or checks on its own. */
  { id: 'rust-analyzer', command: 'rust-analyzer', args: [], extensions: ['.rs'], languageIds: { '.rs': 'rust' }, executesProject: true,
    settings: { cargo: { buildScripts: { enable: false } }, procMacro: { enable: false }, checkOnSave: false, check: { workspace: false } } },
  { id: 'gopls', command: 'gopls', args: ['serve'], extensions: ['.go'], languageIds: { '.go': 'go' } },
  { id: 'clangd', command: 'clangd', args: ['--background-index=0'], extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh'], languageIds: { '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp' } }
]);

const PROJECT_MARKERS = Object.freeze([
  'tsconfig.json', 'jsconfig.json', 'package.json', 'pyproject.toml', 'setup.cfg', 'setup.py',
  'Cargo.toml', 'go.mod', 'compile_commands.json', 'CMakeLists.txt', '.git'
]);

function cleanMessage(s, max) {
  s = String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > (max || 500) ? s.slice(0, max || 500) + '…' : s;
}

function safeChildEnv(env) {
  env = env || {};
  // SystemDrive/ProgramData/ALLUSERSPROFILE are Windows system locations (never secrets): without them native
  // code resolves "%ProgramData%\..." caches as RELATIVE paths and litters the child's cwd (the user's project).
  const allow = ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP',
    'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL', 'RUSTUP_HOME', 'CARGO_HOME',
    'SystemDrive', 'ProgramData', 'ALLUSERSPROFILE'];
  const out = {};
  for (const key of allow) if (env[key] != null) out[key] = String(env[key]);
  return out;
}

function pathInside(P, candidate, base) {
  let a = P.resolve(candidate), b = P.resolve(base);
  if (P.sep === '\\') { a = a.toLowerCase(); b = b.toLowerCase(); }
  return a === b || a.indexOf(b + P.sep) === 0;
}

function makeLspManager(deps) {
  deps = deps || {};
  const spawn = deps.spawn;
  const fs = deps.fs;
  const fsp = deps.fsp || (fs && fs.promises);
  const P = deps.pathMod;
  if (typeof spawn !== 'function' || !fs || !fsp || !P) throw new Error('lsp-manager requires { spawn, fs, fsp, pathMod }');
  const env = deps.env || {};
  const ledger = deps.ledger && typeof deps.ledger.record === 'function' ? deps.ledger : null;
  const servers = (deps.servers || DEFAULT_SERVERS).map(s => Object.assign({}, s, {
    args: Array.isArray(s.args) ? s.args.slice() : [],
    extensions: (s.extensions || []).map(x => String(x).toLowerCase())
  }));
  const limits = deps.limits || {};
  const requestTimeoutMs = Math.max(250, Number(limits.requestTimeoutMs) || 8000);
  const diagnosticTimeoutMs = Math.max(100, Number(limits.diagnosticTimeoutMs) || 2500);
  const idleMs = Math.max(500, Number(limits.idleMs) || 120000);
  const clients = new Map();
  const unavailable = new Map();

  function extensionOf(file) { return P.extname(String(file || '')).toLowerCase(); }
  function descriptorFor(file) {
    const ext = extensionOf(file);
    return servers.find(s => s.extensions.indexOf(ext) >= 0) || null;
  }

  function executableCandidates(command) {
    command = String(command || '').trim();
    if (!command) return [];
    if (P.isAbsolute(command) || /[\\/]/.test(command)) return [command];
    const rawPath = String(env.PATH || env.Path || '');
    const dirs = rawPath.split(P.delimiter).filter(Boolean);
    const hasExt = !!P.extname(command);
    const exts = process.platform === 'win32'
      ? (hasExt ? [''] : String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean))
      : [''];
    const out = [];
    for (const dir of dirs) for (const ext of exts) out.push(P.join(dir, command + ext));
    return out;
  }

  function locateExecutable(descriptor) {
    const cacheKey = descriptor.id + '|' + descriptor.command;
    if (unavailable.has(cacheKey)) return unavailable.get(cacheKey);
    let found = '';
    for (const candidate of executableCandidates(descriptor.command)) {
      try {
        const st = fs.statSync(candidate);
        if (st && st.isFile()) { found = candidate; break; }
      } catch (_) {}
    }
    unavailable.set(cacheKey, found);
    return found;
  }

  function nearestProjectRoot(file, base) {
    const boundary = P.resolve(base || P.dirname(file));
    let cur = P.dirname(P.resolve(file));
    if (!pathInside(P, cur, boundary)) return boundary;
    for (;;) {
      for (const marker of PROJECT_MARKERS) {
        try { if (fs.existsSync(P.join(cur, marker))) return cur; } catch (_) {}
      }
      if (cur === boundary) return boundary;
      const parent = P.dirname(cur);
      if (parent === cur || !pathInside(P, parent, boundary)) return boundary;
      cur = parent;
    }
  }

  function normalizeDiagnostic(d, uri, projectRoot) {
    d = d || {};
    let file = uri;
    try { file = fileURLToPath(uri); } catch (_) {}
    file = P.relative(projectRoot, file).split(P.sep).join('/') || P.basename(file);
    const start = d.range && d.range.start || {};
    return {
      file,
      line: Number(start.line == null ? 0 : start.line) + 1,
      col: Number(start.character == null ? 0 : start.character) + 1,
      severity: Number(d.severity || 0),
      code: d.code == null ? '' : String(d.code),
      source: cleanMessage(d.source || '', 80),
      message: cleanMessage(d.message || '', 500)
    };
  }

  class Client {
    constructor(descriptor, command, projectRoot) {
      this.descriptor = descriptor;
      this.command = command;
      this.projectRoot = projectRoot;
      this.child = null;
      this.buffer = Buffer.alloc(0);
      this.pending = new Map();
      this.waiters = new Map();
      this.latest = new Map();
      this.open = new Map();
      this.nextId = 1;
      this.started = null;
      this.dead = false;
      this.failure = '';
      this.stderr = '';
      this.idleTimer = null;
    }

    touch() {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        const hasWaiters = Array.from(this.waiters.values()).some(rows => rows && rows.length);
        // Idle means no work is outstanding, not merely that the wall clock reached the reap interval. A slow
        // language server can legitimately hold an initialize request or diagnostic publish past `idleMs`; closing
        // it here turns a real edit check into a false "LSP unavailable" result. Re-arm from this point and let the
        // request/diagnostic timeout remain the sole authority over in-flight work.
        if (this.pending.size || hasWaiters) { this.touch(); return; }
        this.close().catch(() => {});
      }, idleMs);
      if (this.idleTimer && typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
    }

    send(msg) {
      if (!this.child || this.dead || !this.child.stdin || this.child.stdin.destroyed) throw new Error(this.failure || 'language server is not running');
      const body = Buffer.from(JSON.stringify(msg), 'utf8');
      this.child.stdin.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'), body]));
    }

    notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }

    request(method, params, timeoutMs) {
      const id = this.nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(method + ' timed out'));
        }, timeoutMs || requestTimeoutMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
        this.pending.set(id, { resolve, reject, timer });
        try { this.send({ jsonrpc: '2.0', id, method, params }); }
        catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
      });
    }

    onData(chunk) {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
      for (;;) {
        const split = this.buffer.indexOf('\r\n\r\n');
        if (split < 0) return;
        const head = this.buffer.slice(0, split).toString('ascii');
        const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(head);
        if (!match) { this.buffer = this.buffer.slice(split + 4); continue; }
        const len = Number(match[1]);
        if (this.buffer.length < split + 4 + len) return;
        const raw = this.buffer.slice(split + 4, split + 4 + len).toString('utf8');
        this.buffer = this.buffer.slice(split + 4 + len);
        let msg;
        try { msg = JSON.parse(raw); } catch (_) { continue; }
        this.onMessage(msg);
      }
    }

    onMessage(msg) {
      if (msg && msg.id != null && !msg.method) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer); this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(cleanMessage(msg.error.message || 'language-server request failed')));
        else p.resolve(msg.result);
        return;
      }
      if (msg && msg.id != null && msg.method) {
        let result = null;
        if (msg.method === 'workspace/configuration') result = (msg.params && msg.params.items || []).map(it => (this.descriptor.settings && it && it.section === this.descriptor.id) ? this.descriptor.settings : null);
        else if (msg.method === 'workspace/workspaceFolders') result = [{ uri: pathToFileURL(this.projectRoot).href, name: P.basename(this.projectRoot) }];
        try { this.send({ jsonrpc: '2.0', id: msg.id, result }); } catch (_) {}
        return;
      }
      if (!msg || msg.method !== 'textDocument/publishDiagnostics') return;
      const uri = String(msg.params && msg.params.uri || '');
      const rows = Array.isArray(msg.params && msg.params.diagnostics) ? msg.params.diagnostics : [];
      this.latest.set(uri, rows);
      const waiting = this.waiters.get(uri) || [];
      const publishedVersion = Number.isInteger(msg.params && msg.params.version) ? msg.params.version : null;
      const remaining = [];
      for (const w of waiting) {
        // Versionless diagnostic servers are common and remain supported. When a version is
        // supplied, however, it must describe the edit this waiter initiated; an older publish
        // must not make a newer edit look confirmed and clean.
        if (publishedVersion != null && w.expectedVersion != null && publishedVersion !== w.expectedVersion) {
          remaining.push(w); continue;
        }
        clearTimeout(w.timer);
        if (w.abort) w.signal.removeEventListener('abort', w.abort);
        w.resolve({ confirmed: true, diagnostics: rows, version: publishedVersion });
      }
      if (remaining.length) this.waiters.set(uri, remaining); else this.waiters.delete(uri);
    }

    fail(err) {
      if (this.dead) return;
      this.dead = true;
      this.failure = cleanMessage((err && err.message) || err || this.stderr || 'language server exited');
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(this.failure)); }
      this.pending.clear();
      for (const rows of this.waiters.values()) for (const w of rows) {
        clearTimeout(w.timer); if (w.abort) w.signal.removeEventListener('abort', w.abort); w.reject(new Error(this.failure));
      }
      this.waiters.clear();
    }

    async start() {
      if (this.started) return this.started;
      this.started = (async () => {
        let child;
        try {
          child = spawn(this.command, this.descriptor.args, {
            cwd: this.projectRoot,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: safeChildEnv(env)
          });
        } catch (e) {
          this.fail(e);
          throw e;
        }
        this.child = child;
        if (ledger && child && Number(child.pid) > 0) {
          try {
            ledger.record({ pid: child.pid, cmd: this.command + ' ' + this.descriptor.args.join(' '), kind: 'lsp:' + this.descriptor.id });
            if (typeof ledger.pinIdentity === 'function') Promise.resolve(ledger.pinIdentity(child.pid)).catch(() => {});
          } catch (_) {}
        }
        child.stdout.on('data', chunk => this.onData(chunk));
        child.stderr.on('data', chunk => { this.stderr = (this.stderr + String(chunk)).slice(-4000); });
        child.once('error', e => this.fail(e));
        child.once('exit', (code, signal) => {
          if (ledger && typeof ledger.release === 'function') { try { ledger.release(child.pid); } catch (_) {} }
          this.fail(new Error('language server exited (' + (signal || code) + ')' + (this.stderr ? ': ' + cleanMessage(this.stderr) : '')));
        });
        const init = await this.request('initialize', {
          processId: process.pid,
          clientInfo: { name: 'Agent OS', version: '1' },
          rootUri: pathToFileURL(this.projectRoot).href,
          capabilities: {
            workspace: { workspaceFolders: true, configuration: true },
            textDocument: { publishDiagnostics: { relatedInformation: false, versionSupport: true } }
          },
          workspaceFolders: [{ uri: pathToFileURL(this.projectRoot).href, name: P.basename(this.projectRoot) }],
          initializationOptions: this.descriptor.settings || undefined
        });
        this.capabilities = init && init.capabilities || {};
        this.notify('initialized', {});
        this.touch();
        return this;
      })();
      return this.started;
    }

    waitForDiagnostics(uri, signal, action, expectedVersion) {
      return new Promise((resolve, reject) => {
        if (signal && signal.aborted) return reject(Object.assign(new Error('diagnostic check aborted'), { name: 'AbortError' }));
        const row = { resolve, reject, signal, abort: null, timer: null, expectedVersion };
        row.timer = setTimeout(() => {
          const arr = this.waiters.get(uri) || [];
          this.waiters.set(uri, arr.filter(x => x !== row));
          if (row.abort) signal.removeEventListener('abort', row.abort);
          resolve({ confirmed: false, diagnostics: this.latest.get(uri) || [] });
        }, diagnosticTimeoutMs);
        if (signal) {
          row.abort = () => {
            clearTimeout(row.timer);
            const arr = this.waiters.get(uri) || [];
            this.waiters.set(uri, arr.filter(x => x !== row));
            reject(Object.assign(new Error('diagnostic check aborted'), { name: 'AbortError' }));
          };
          signal.addEventListener('abort', row.abort, { once: true });
        }
        const arr = this.waiters.get(uri) || [];
        arr.push(row); this.waiters.set(uri, arr);
        try { action(); } catch (e) {
          clearTimeout(row.timer); this.waiters.set(uri, arr.filter(x => x !== row));
          if (row.abort) signal.removeEventListener('abort', row.abort); reject(e);
        }
      });
    }

    async diagnosticsFor(file, text, signal, save) {
      await this.start();
      this.touch();
      const uri = pathToFileURL(file).href;
      const ext = extensionOf(file);
      const languageId = this.descriptor.languageIds && this.descriptor.languageIds[ext] || ext.slice(1) || 'plaintext';
      const current = this.open.get(uri);
      const version = current ? current.version + 1 : 1;
      const action = () => {
        if (current) this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text: String(text) }] });
        else this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text: String(text) } });
        this.open.set(uri, { version, languageId });
        if (save) this.notify('textDocument/didSave', { textDocument: { uri }, text: String(text) });
      };
      return this.waitForDiagnostics(uri, signal, action, version);
    }

    closeFile(file) {
      const uri = pathToFileURL(file).href;
      if (!this.open.has(uri)) return;
      try { this.notify('textDocument/didClose', { textDocument: { uri } }); } catch (_) {}
      this.open.delete(uri); this.latest.delete(uri);
    }

    async close() {
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
      if (!this.child) { this.dead = true; return; }
      const child = this.child;
      try { await Promise.race([this.request('shutdown', null, 500), new Promise(r => setTimeout(r, 550))]); } catch (_) {}
      try { this.notify('exit', null); } catch (_) {}
      // Await actual exit before reporting cleanup complete. On Windows a still-exiting server holds its cwd,
      // which made workspace teardown fail EBUSY even though closeAll() had already resolved.
      await Promise.race([
        new Promise(resolve => { if (child.exitCode != null || child.signalCode) resolve(); else child.once('exit', resolve); }),
        new Promise(resolve => setTimeout(resolve, 500))
      ]);
      try { if (child.exitCode == null && !child.killed) child.kill(); } catch (_) {}
      if (child.exitCode == null) await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 500))
      ]);
      this.dead = true;
      for (const [key, value] of clients) if (value === this) clients.delete(key);
    }
  }

  function getClient(descriptor, file, base) {
    const command = locateExecutable(descriptor);
    if (!command) return { unavailable: true, reason: descriptor.command + ' is not installed on PATH' };
    const projectRoot = nearestProjectRoot(file, base);
    const key = descriptor.id + '|' + (P.sep === '\\' ? projectRoot.toLowerCase() : projectRoot);
    let client = clients.get(key);
    if (!client || client.dead) { client = new Client(descriptor, command, projectRoot); clients.set(key, client); }
    return { client, projectRoot };
  }

  async function beginEdit(input) {
    input = input || {};
    const ticket = { items: [], unavailable: [], unsupported: [], signal: input.signal || null };
    for (const file of input.files || []) {
      if (input.signal && input.signal.aborted) throw Object.assign(new Error('diagnostic check aborted'), { name: 'AbortError' });
      const descriptor = descriptorFor(file.abs);
      if (!descriptor) { ticket.unsupported.push(String(file.rel || file.abs)); continue; }
      if (descriptor.executesProject && input.allowProjectExecution !== true) {
        // detection first (a stat, never a spawn): the watched-run reason is only true for a server that exists
        const reason = locateExecutable(descriptor)
          ? descriptor.command + ' ' + (descriptor.executesWhy || 'runs the project\'s own build configuration') + ', so it starts only for a watched run'
          : descriptor.command + ' is not installed on PATH';
        ticket.unavailable.push({ file: String(file.rel || file.abs), server: descriptor.id, reason });
        continue;
      }
      const got = getClient(descriptor, file.abs, file.base);
      if (got.unavailable) { ticket.unavailable.push({ file: String(file.rel || file.abs), server: descriptor.id, reason: got.reason }); continue; }
      try {
        const before = await got.client.diagnosticsFor(file.abs, file.text == null ? '' : file.text, input.signal, false);
        ticket.items.push({ file: Object.assign({}, file), descriptor, client: got.client, projectRoot: got.projectRoot, before });
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        ticket.unavailable.push({ file: String(file.rel || file.abs), server: descriptor.id, reason: cleanMessage((e && e.message) || e) });
      }
    }
    return ticket;
  }

  async function finishEdit(ticket, input) {
    input = input || {};
    ticket = ticket || { items: [], unavailable: [], unsupported: [] };
    const added = [], removed = [], failures = [];
    let confirmedFiles = 0;
    for (const item of ticket.items || []) {
      let text;
      try { text = await fsp.readFile(item.file.abs, 'utf8'); }
      catch (e) {
        if (e && e.code === 'ENOENT') {
          item.client.closeFile(item.file.abs);
          if (item.before.confirmed) {
            const beforeRows = (item.before.diagnostics || []).map(d => normalizeDiagnostic(d, pathToFileURL(item.file.abs).href, item.projectRoot));
            removed.push(...beforeRows); confirmedFiles++;
          } else failures.push({ file: item.file.rel, reason: 'baseline diagnostics were not confirmed before deletion' });
          continue;
        }
        failures.push({ file: item.file.rel, reason: cleanMessage((e && e.message) || e) }); continue;
      }
      try {
        const after = await item.client.diagnosticsFor(item.file.abs, text, input.signal, true);
        if (!item.before.confirmed || !after.confirmed) {
          failures.push({ file: item.file.rel, reason: !item.before.confirmed ? 'baseline diagnostics were not confirmed' : 'post-edit diagnostics were not confirmed' });
          continue;
        }
        const uri = pathToFileURL(item.file.abs).href;
        const beforeRows = (item.before.diagnostics || []).map(d => normalizeDiagnostic(d, uri, item.projectRoot));
        const afterRows = (after.diagnostics || []).map(d => normalizeDiagnostic(d, uri, item.projectRoot));
        const delta = diagnosticDelta(beforeRows, afterRows);
        added.push(...delta.added); removed.push(...delta.removed); confirmedFiles++;
      } catch (e) {
        failures.push({ file: item.file.rel, reason: cleanMessage((e && e.message) || e) });
      }
    }
    if (!confirmedFiles) {
      const reasons = (ticket.unavailable || []).concat(failures).map(x => x.server ? x.server + ': ' + x.reason : x.reason);
      return {
        status: (ticket.items || []).length || reasons.length ? 'unavailable' : 'unsupported',
        reason: cleanMessage(reasons.join('; ') || 'no detected language server for the edited file type', 1000),
        added: [], removed: [], addedCount: 0, removedCount: 0,
        unsupported: ticket.unsupported || [], unavailable: ticket.unavailable || [], failures
      };
    }
    return {
      status: failures.length ? 'partial' : 'available',
      added, removed, addedCount: added.length, removedCount: removed.length,
      checkedFiles: confirmedFiles, unsupported: ticket.unsupported || [], unavailable: ticket.unavailable || [], failures
    };
  }

  async function closeAll() {
    const current = Array.from(new Set(clients.values()));
    await Promise.all(current.map(c => c.close().catch(() => {})));
    clients.clear();
  }

  return {
    beginEdit, finishEdit, closeAll,
    status: () => Array.from(clients.values()).map(c => ({ server: c.descriptor.id, root: c.projectRoot, running: !!c.child && !c.dead })),
    _internals: { descriptorFor, locateExecutable, nearestProjectRoot, normalizeDiagnostic, safeChildEnv, pathInside, Client }
  };
}

module.exports = { makeLspManager, DEFAULT_SERVERS, PROJECT_MARKERS, _internals: { safeChildEnv, cleanMessage } };
