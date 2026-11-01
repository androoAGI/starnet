/* sidecar/providers/antigravity-cli.js — Google's Antigravity CLI (`agy`) as a brain, on the user's own sign-in.

   WHY THE CLI AND NOT THE OAUTH TOKEN. Antigravity's subscription models (Gemini, plus the Claude and GPT-OSS models
   Google serves inside it) are reachable over HTTP with the token the Antigravity app mints, and third-party tools
   that lifted that token got their users' Google accounts suspended for a ToS violation (Google AI Developers Forum,
   2026: "This service has been disabled in this account for violation of Terms of Service"). Headless print mode
   (`agy -p`) is Google's documented way to drive the agent from scripts, and StarNet never reads, stores or forwards
   the credential: the CLI keeps its own sign-in, exactly like the Claude CLI provider (claude-cli.js).

   ONE TURN = ONE CHILD. Each turn spawns `agy --input-format stream-json --output-format stream-json -p` with the
   whole transcript as ONE stream-json user line on stdin (antigravity.google/docs/cli/headless). Output events:
     {"event":"init", "conversation_id", "init":{cwd, tools, permission_mode, model?}}
     {"event":"step_update", "step_update":{step_type, state, text_delta?, tool_name?, tool_info?, usage?}}
     {"event":"result", "result":{status, response, error?, usage:{input_tokens, output_tokens, thinking_tokens,
       cache_read_tokens, total_tokens}}}
   Text deltas of agent_response steps stream as text; exactly one 'done' follows the result line.

   CAPABILITY BOUNDARY. agy is an agent with its own tools (read_file, write_file, command, read_url, MCP) and, unlike
   `claude`, has no flag that switches them all off and no system-prompt override. So:
     - the child runs in a fresh EMPTY temp folder, with --sandbox, and never with --dangerously-skip-permissions
       (headless mode soft-denies anything that would ask for approval);
     - StarNet's own tools are described in the prompt and requested as <function_calls> text blocks, parsed by the
       Claude CLI adapter's reader, so loop.js executes them through the same capability gate and consent broker;
     - FAIL CLOSED: the moment agy starts one of its OWN tool steps the child's process tree is killed and the turn
       fails with native_tool_blocked. A brain that ran something StarNet did not gate is never reported as fine.

   COST TRUTH. agy's result line carries real token counts but no money figure. A Google sign-in (auth.type
   oauth-personal / oauth-business, the default) bills nothing per call: booked $0 with the real tokens, flagged
   `subscription` so the loop's subscription-token ceiling counts it. A Gemini API key or Agent Platform sign-in IS
   billed, and nothing here can price it, so those turns go out unpriced (the loop's unpriced-token ceiling applies).

   MODELS. `agy models` is the catalog: its slugs are display strings ('Gemini 3.1 Pro (High)') that change with the
   account's plan, so nothing is hardcoded. An unknown --model fails the run (agy does not fall back headless).

   makeAntigravityCliProvider({ spawn?, killProcess?, killGraceMs?, bin?, env?, platform?, fs?, os?, idleMs?, modelsTimeoutMs? })
     -> { stream, listModels, contextLimit, priceOf, supportsTools, supportsImages, reasoningEfforts } */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./provider.js'), require('./claude-cli.js'));
  else { root.SK = root.SK || {}; (root.SK.providers = root.SK.providers || {}).antigravityCli = factory(root.SK.providers.provider, root.SK.providers.claudeCli); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (provider, claudeCli) {
  'use strict';

  const timeouts = provider.timeouts;
  const { note: failNote } = (typeof require === 'function') ? require('../failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };
  const { buildPrompt, makeCallSplitter, parseCall, looseCall, invokeCall } = claudeCli._internals;
  const NAME = 'Antigravity CLI';
  // agy does not publish context windows; 200k is the smallest window among the families it serves (Claude), so
  // compaction never trusts a window the model behind the slug might not have.
  const DEFAULT_CONTEXT = 200000;
  const EFFORTS = ['low', 'medium', 'high'];   // headless --effort (docs/cli/headless)
  const KILL_GRACE_MS = 2000;   // SIGTERM -> SIGKILL for a child's process group
  const CALL_OPEN = '<tool_call>', CALL_CLOSE = '</tool_call>';
  const IMAGE_NOTE = '[image omitted — the Antigravity CLI takes text input only]';
  // The empty working folder and the instructions below are the soft boundary; the native-tool kill is the hard one.
  const GROUND_RULES = [
    '# Session rules',
    'You are the reasoning engine inside StarNet. Do NOT use any of your own built-in tools: no file reads or writes,',
    'no terminal commands, no browsing or URL fetches, no MCP servers, no subagents. The working folder is empty on',
    'purpose. Every action goes through the StarNet tool format described in the instructions, and nowhere else.'
  ].join('\n');

  // Images become a note: agy's stream-json input accepts text blocks only.
  function textOnly(messages) {
    return (Array.isArray(messages) ? messages : []).map(m => {
      if (!m || !Array.isArray(m.content)) return m;
      return Object.assign({}, m, { content: m.content.map(p => (p && (p.type === 'image_url' || p.type === 'image')) ? { type: 'text', text: IMAGE_NOTE } : p) });
    });
  }
  // The transcript the Claude CLI adapter renders (its tool protocol, inert tags, host-note joins), flattened into the
  // single user message agy takes: agy keeps its own system prompt, so StarNet's rides at the top of the turn.
  function composePrompt(messages, tools) {
    const built = buildPrompt(textOnly(messages), tools);
    const transcript = built.blocks.filter(b => b && b.type === 'text').map(b => b.text).join('\n\n');
    return '<starnet_instructions>\n' + String(built.system || '').trim() + '\n\n' + GROUND_RULES + '\n</starnet_instructions>\n\n' + transcript;
  }
  // `{"event":"user","message":{"content":…}}` — the documented stdin line; closing stdin ends the session (exit 0).
  function inputLine(text) {
    return JSON.stringify({ event: 'user', message: { content: [{ type: 'text', text }] } }) + '\n';
  }

  const ANSI_RE = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
  /* `agy models` prints one slug per line. Decorations (bullets, a current-model marker, a header ending in ':') are
     dropped; a slug's own parentheses ('Gemini 3.1 Pro (High)') are part of it and stay. */
  function parseModels(stdout) {
    const out = [], seen = new Set();
    for (let line of String(stdout || '').replace(ANSI_RE, '').split(/\r?\n/)) {
      line = line.replace(/^\s*(?:[-*•>›✓✔●○]\s+|\d+[.)]\s+)/, '').replace(/\s+\((?:default|current|selected|active)\)\s*$/i, '').trim();
      if (!line || /:$/.test(line) || /^(?:available models|models|usage\b)/i.test(line) || line.length > 120) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
    return out;
  }

  // How the CLI is signed in, read from its own settings file (config, never a secret). '' = not stated.
  function authTypeOf(fs, path, env) {
    const home = String(env.HOME || env.USERPROFILE || '');
    if (!home) return '';
    try {
      const j = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
      const t = (j && j.auth && typeof j.auth === 'object' && j.auth.type) || (j && j['auth.type']) || '';
      return String(t || '').trim().toLowerCase();
    } catch (_) { return ''; }
  }
  function isSubscription(authType, env) {
    if (/^oauth-/.test(authType)) return true;
    // no auth.type written: the CLI's default is the Google sign-in, unless a Gemini key is in reach of the child
    return !authType && !String(env.GEMINI_API_KEY || '').trim();
  }

  /* Every live agy child -> the removal of its scratch folder, so an exiting sidecar leaves no tree or folder behind
     (gracefulShutdown aborts runs, not a hanging `agy models`). An exit handler cannot wait on anything async, so the
     tree goes synchronously: taskkill /T on Windows, SIGKILL to the child's process group on POSIX. Only a real
     ChildProcess is ever killed by pid (as in claude-cli's LIVE). */
  const LIVE = new Map();
  let exitHooked = false;
  function hookExit() {
    if (exitHooked || typeof process === 'undefined' || typeof process.once !== 'function') return;
    exitHooked = true;
    process.once('exit', () => {
      for (const [c, dropDir] of LIVE) {
        if (c.exitCode == null && c.signalCode == null && c.pid) {
          try {
            if (process.platform === 'win32') require('node:child_process').spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
            else { try { process.kill(-c.pid, 'SIGKILL'); } catch (_) { c.kill('SIGKILL'); } }
          } catch (e) { failNote('agy.exit.kill', e); }
        }
        try { dropDir(); } catch (e) { failNote('agy.exit.rm', e); }
      }
      LIVE.clear();
    });
  }

  function makeHost(opts) {
    const childEnvLib = require('../child-env.js');
    const spawn = opts.spawn || childEnvLib.guardChildProcess(require('node:child_process')).spawn;
    const fs = opts.fs || require('fs');
    const os = opts.os || require('os');
    const path = require('path');
    const env = opts.env || process.env;
    const platform = opts.platform || process.platform;
    const isFile = p => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };
    // An injected spawn hands out fake pids: only a real child's process group is ever signalled.
    const killProcess = opts.killProcess || (opts.spawn ? null : process.kill.bind(process));
    const killGraceMs = Number(opts.killGraceMs) > 0 ? Number(opts.killGraceMs) : KILL_GRACE_MS;

    function locate() {
      const configured = String(opts.bin || env.STARNET_AGY_BIN || '').trim();
      if (configured) return configured;
      // the official installers drop agy in ~/.local/bin (macOS/Linux) or %LOCALAPPDATA%\agy\bin (Windows); a Finder-
      // launched app has a bare PATH, so those homes (and Homebrew's) are looked at directly too
      const exts = platform === 'win32' ? ['.exe', ''] : [''];
      const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
      if (platform === 'win32' && env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'agy', 'bin'));
      if (platform !== 'win32') {
        if (env.HOME) dirs.push(path.join(env.HOME, '.local', 'bin'));
        dirs.push('/opt/homebrew/bin', '/usr/local/bin');
      }
      for (const dir of dirs) for (const ext of exts) { const p = path.join(dir, 'agy' + ext); if (isFile(p)) return p; }
      return '';
    }
    /* -> { file, pre }: what spawn() runs and the arguments that go before agy's own; throws provider_not_configured.
       A .cmd/.bat shim cannot be spawned without a shell, and a shell would re-parse slugs like 'Gemini 3.1 Pro (High)',
       so a shim is refused with the remedy (claude-cli can unwrap its npm shim; agy ships no known JS entry to run). */
    function command() {
      const bin = locate();
      if (!bin) throw notInstalled();
      if (/\.(cmd|bat)$/i.test(bin)) {
        const e = new Error('The Antigravity CLI was found as a script shim (' + path.basename(bin) + '), which StarNet cannot run without a shell — set STARNET_AGY_BIN to the agy executable (agy.exe), then retry');
        e.code = 'provider_not_configured';
        throw e;
      }
      // an npm-style link to a `#!/usr/bin/env node` script: a Finder-launched app has no `node` on PATH either
      if (platform !== 'win32' && typeof fs.realpathSync === 'function') {
        let real = '';
        try { real = fs.realpathSync(bin); } catch (_) { real = ''; }
        if (/\.(c|m)?js$/i.test(real)) return { file: process.execPath, pre: [real] };
      }
      return { file: bin, pre: [] };
    }
    // registers a spawned child for the exit sweep above until it closes; an injected spawn's fake child is skipped
    function track(child, dropDir) {
      if (!(child instanceof require('node:child_process').ChildProcess)) return;
      LIVE.set(child, dropDir); hookExit();
      const untrack = () => { LIVE.delete(child); };
      child.once('close', untrack); child.once('error', untrack);
    }
    // on POSIX the child leads its own process group, so the tools and helpers it starts are killed with it
    function spawnOpts(cwd, stdio) {
      return { env: childEnv(), cwd, windowsHide: true, stdio, detached: platform !== 'win32' };
    }
    function notInstalled() {
      const e = new Error('The Antigravity CLI (agy) is not installed on this computer — install it from antigravity.google, run `agy` once in a terminal to sign in, then retry');
      e.code = 'provider_not_configured';
      return e;
    }
    function notSignedIn(detail) {
      const e = new Error('The Antigravity CLI is not signed in' + (detail ? ' (' + String(detail).slice(0, 200) + ')' : '') + ' — run `agy` once in a terminal and sign in with Google, then retry');
      e.code = 'provider_not_configured'; e.status = 401;
      return e;
    }
    function childEnv() { return childEnvLib.stationChildEnv(env); }
    function killDirect(child, sig) {
      try { child.kill(sig); } catch (e) { failNote('agy.kill', e); }
    }
    function signalGroup(child, sig) {
      if (!killProcess || !child.pid) return false;
      try { killProcess(-child.pid, sig); return true; } catch (e) { if (e && e.code !== 'ESRCH') failNote('agy.killgroup', e); return false; }
    }
    /* Ends the child and everything it started; onGone runs once, when that is confirmed: on Windows after
       `taskkill /T /F` returns, on POSIX after SIGTERM to the group and a SIGKILL KILL_GRACE_MS later. */
    function killTree(child, onGone) {
      let reported = false;
      const gone = () => { if (!reported) { reported = true; if (onGone) onGone(); } };
      if (!child) return gone();
      const leaderGone = child.exitCode != null || child.signalCode != null;
      try {
        if (platform === 'win32') {
          if (leaderGone || !child.pid) return gone();
          const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          if (!k || typeof k.on !== 'function') { killDirect(child); return gone(); }
          k.on('error', () => { killDirect(child); gone(); });
          k.on('close', gone);
          return;
        }
        if (!signalGroup(child, 'SIGTERM') && !leaderGone) killDirect(child, 'SIGTERM');
        if (!killProcess) return gone();
        const t = setTimeout(() => { signalGroup(child, 'SIGKILL'); gone(); }, killGraceMs);
        if (t && typeof t.unref === 'function') t.unref();
      } catch (e) { failNote('agy.killtree', e); killDirect(child); gone(); }
    }
    // A fresh empty folder per child: agy's own file tools find nothing of the user's to touch.
    function scratchDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-agy-')); }
    function dropDir(dir) {
      if (!dir) return;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { failNote('agy.scratch.rm', e); }
    }
    return { spawn, fs, os, path, env, platform, command, spawnOpts, track, notInstalled, notSignedIn, childEnv, killTree, scratchDir, dropDir };
  }

  const AUTH_RE = /auth(?:entication|orization)? required|not (?:signed|logged) in|sign[- ]?in required|unauthenticated|login required|401/i;
  const QUOTA_RE = /quota|rate.?limit|usage limit|resource.?exhausted|out of (?:ai )?credits|insufficient credits|429/i;
  const SHORT_WINDOW_RE = /per[- ]?(?:minute|second)|quota metric|\brpm\b|\btpm\b|requests per (?:minute|second)/i;   // errorClass's veto, minus "per day"
  function failureError(host, message) {
    const msg = String(message || '').trim();
    if (AUTH_RE.test(msg)) return host.notSignedIn(msg);
    // a spent plan window is quota_exhausted (errorClass): rotate or fall back instead of retrying this sign-in
    if (QUOTA_RE.test(msg)) {
      // a per-minute/per-second refusal clears by waiting: it stays a plain 429, which errorClass files as a retryable
      // rate_limit (its SHORT_WINDOW_RE veto), instead of a spent plan that rotates or stops the run
      if (SHORT_WINDOW_RE.test(msg)) { const e = new Error(NAME + ' rate limited: ' + msg.slice(0, 300)); e.status = 429; return e; }
      const e = new Error(NAME + ' usage limit reached: ' + msg.slice(0, 300)); e.status = 429; e.code = 'usage_limit_reached'; return e;
    }
    if (/unknown model|invalid model|model .*not (?:found|available)/i.test(msg)) {
      const e = new Error(NAME + ' does not offer that model on this account (' + msg.slice(0, 200) + ') — pick one `agy models` lists');
      e.status = 400; e.code = 'model_not_found';
      return e;
    }
    return new Error(NAME + ' error: ' + (msg || 'unknown error').slice(0, 400));
  }
  // a step that is agy running one of its OWN tools -> { name }, else null
  function nativeToolStep(j) {
    if (!j || j.event !== 'step_update') return null;
    const s = j.step_update || {};
    if (s.step_type === 'tool' || s.tool_name || s.subagent_info) return { name: s.tool_name || (s.tool_info && s.tool_info.name) };
    return null;
  }
  function nativeToolError(name) {
    const e = new Error(NAME + ' tried to run its own tool' + (name ? ' (' + String(name).slice(0, 80) + ')' : '') + ' — StarNet stopped the turn, because only StarNet\'s gated tools may run. Retry, or pick another model.');
    e.code = 'native_tool_blocked';
    return e;
  }

  function makeAntigravityCliProvider(opts) {
    opts = opts || {};
    const host = makeHost(opts);
    const { spawn, fs, path, env, command, killTree } = host;
    const idTag = require('crypto').randomBytes(4).toString('hex');   // unique call ids across adapters (see claude-cli)
    let seq = 0;
    const modelsTimeoutMs = Number(opts.modelsTimeoutMs) > 0 ? Number(opts.modelsTimeoutMs) : 20000;

    // `agy models`: the live catalog for this sign-in, and the only proof that the sign-in works.
    function runModels() {
      return new Promise((resolve, reject) => {
        let cmd;
        try { cmd = command(); } catch (e) { return reject(e); }
        let out = '', err = '', settled = false, child, cwd = '';
        const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
        const dropDir = () => host.dropDir(cwd);   // only once the child is gone
        // issue google-antigravity/antigravity-cli#318: agy can hang without a TTY — never wait on it forever
        const timer = setTimeout(() => { killTree(child, dropDir); finish(reject, new Error(NAME + ' did not answer `agy models` within ' + Math.round(modelsTimeoutMs / 1000) + 's — run `agy` once in a terminal to finish its setup, then retry')); }, modelsTimeoutMs);
        try {
          cwd = host.scratchDir();
          child = spawn(cmd.file, cmd.pre.concat(['models']), host.spawnOpts(cwd, ['ignore', 'pipe', 'pipe']));
        } catch (_) { dropDir(); return finish(reject, host.notInstalled()); }
        host.track(child, dropDir);
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.on('error', e => { dropDir(); finish(reject, (e && e.code === 'ENOENT') ? host.notInstalled() : e); });
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err = (err + d).slice(-4000); });
        child.on('close', code => {
          dropDir();
          const ids = parseModels(out);
          if (code === 0 && ids.length) return finish(resolve, ids);
          const why = (err.trim() || out.trim()).split(/\r?\n/).slice(-3).join(' ');
          finish(reject, AUTH_RE.test(why) ? host.notSignedIn(why) : new Error(NAME + ' listed no models' + (why ? ': ' + why.slice(0, 300) : ' (exit ' + code + ')')));
        });
      });
    }
    async function listModels() {
      const ids = await runModels();
      return ids.map(id => ({
        id, name: id, context_length: DEFAULT_CONTEXT, max_completion_tokens: null, pricing: null,
        supportsTools: true, supportsReasoning: true, supported_parameters: ['tools', 'reasoning'], reasoningEfforts: EFFORTS.slice()
      }));
    }

    const effortOf = req => { const e = String(req.reasoningEffort || '').trim().toLowerCase(); return EFFORTS.indexOf(e) >= 0 ? e : ''; };
    function cliArgs(req) {
      // -p last: it may take a value, and with stream-json input the prompt is on stdin
      const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--sandbox', '--disable-slash-commands'];
      if (req.model) args.push('--model', String(req.model));
      const effort = effortOf(req);
      if (effort) args.push('--effort', effort);
      args.push('-p');
      return args;
    }

    async function* stream(req) {
      req = req || {};
      if (req.signal && req.signal.aborted) return;
      const cmd = command();
      const signal = req.signal;
      const turn = ++seq;
      const subscription = isSubscription(authTypeOf(fs, path, env), env);
      const hasTools = Array.isArray(req.tools) && req.tools.length > 0;
      const splitter = makeCallSplitter({ enabled: hasTools });
      const props = {};
      for (const tl of (hasTools ? req.tools : [])) { const fn = tl && tl.function; if (fn && fn.name) props[String(fn.name)] = (fn.parameters && fn.parameters.properties) || {}; }
      const callId = i => 'call_agy_' + idTag + '_' + turn + '_' + i;

      const queue = [];
      let wake = null, closed = false, failure = null, exitCode = null, stderr = '', lineBuf = '', child = null, cwd = '';
      const push = item => { queue.push(item); if (wake) { const w = wake; wake = null; w(); } };
      const idle = opts.idleMs || timeouts.idleMs();
      let idleTimer = null, finished = false;
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (finished) return;
        idleTimer = setTimeout(() => { failure = timeouts.timeoutError(idle, 'idle'); killTree(child); push(null); }, idle);
      };
      const onAbort = () => { killTree(child); push(null); };
      // FAIL CLOSED on arrival, not when the loop reaches the line: a native tool step queued behind a finished call
      // block, or arriving while its events are being yielded, still fails the turn
      const screen = line => {
        if (failure) return;
        let j;
        try { j = JSON.parse(line); } catch (_) { return; }
        const hit = nativeToolStep(j);
        if (hit) { failure = nativeToolError(hit.name); killTree(child); push(null); }
      };
      const prompt = composePrompt(req.messages, req.tools);
      try {
        cwd = host.scratchDir();
        child = spawn(cmd.file, cmd.pre.concat(cliArgs(req)), host.spawnOpts(cwd, ['pipe', 'pipe', 'pipe']));
      } catch (_) { host.dropDir(cwd); throw host.notInstalled(); }
      host.track(child, () => host.dropDir(cwd));
      if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
      armIdle();
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.on('error', e => { failure = (e && e.code === 'ENOENT') ? host.notInstalled() : e; closed = true; push(null); });
      child.stdout.on('data', d => {
        armIdle();
        lineBuf += d;
        let nl;
        while ((nl = lineBuf.indexOf('\n')) >= 0) { const line = lineBuf.slice(0, nl).trim(); lineBuf = lineBuf.slice(nl + 1); if (line) { push(line); screen(line); } }
      });
      child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
      child.on('close', code => { exitCode = code; const tail = lineBuf.trim(); if (tail) { push(tail); screen(tail); } lineBuf = ''; closed = true; push(null); });
      child.stdin.on('error', e => failNote('agy.stdin', e));
      try { child.stdin.end(inputLine(prompt)); } catch (e) { failNote('agy.stdin', e); }

      let open = null, callIndex = 0, sawText = false, result = null, blockDone = false, lastUsage = null, outChars = 0;
      function emitSplit(part, out) {
        for (const it of part.items) {
          if (it.text != null) { if (it.text) { sawText = true; out.push({ type: 'text', delta: it.text }); } continue; }
          if (it.start) {
            open = { index: callIndex++, name: it.start };
            out.push({ type: 'tool_start', index: open.index, id: callId(open.index), name: it.start });
            continue;
          }
          const was = open; open = null;
          const call = it.kind === 'invoke' ? invokeCall(was ? was.name : '', it.body, props[was ? was.name : ''], it.closed)
            : (parseCall(it.body) || (was ? looseCall(it.body, was.name) : null));
          if (!call) { sawText = true; out.push({ type: 'text', delta: CALL_OPEN + it.body + (it.closed ? CALL_CLOSE : '') }); continue; }
          const index = was ? was.index : callIndex++;
          if (!was) out.push({ type: 'tool_start', index, id: callId(index), name: call.name });
          out.push({ type: 'tool_args', index, chunk: call.args });
          out.push({ type: 'tool_done', index });
        }
        return out;
      }
      // interrupted: the turn was stopped at its call block, so agy's last count (if any) may cover only part of it
      let usageSent = false;
      function usageChunk(u, interrupted) {
        usageSent = true;
        u = u || {};
        const counted = k => u[k] != null && u[k] !== '' && Number.isFinite(Number(u[k]));
        const cacheRead = Number(u.cache_read_tokens) || 0;
        // the whole transcript went in either way: with no count, ~4 characters a token (see claude-cli STOP)
        const input = counted('input_tokens') ? Number(u.input_tokens) : Math.ceil(prompt.length / 4);
        const streamed = Math.ceil(outChars / 4);
        const output = interrupted ? Math.max(counted('output_tokens') ? Number(u.output_tokens) : 0, streamed)
          : (counted('output_tokens') ? Number(u.output_tokens) : streamed);
        return {
          type: 'usage',
          usage: {
            prompt_tokens: input,   // agy's input_tokens already include the cache reads (total = input + output)
            completion_tokens: output,
            total_tokens: input + output,
            prompt_tokens_details: { cached_tokens: cacheRead, cache_creation_tokens: 0 },
            reasoning_tokens: Number(u.thinking_tokens) || 0,
            cost: subscription ? 0 : undefined,
            subscription: subscription || undefined
          }
        };
      }
      // one stdout line -> the harness events it yields; throws native_tool_blocked (fail closed)
      function onLine(j) {
        const out = [];
        if (!j || typeof j !== 'object') return out;
        if (j.event === 'step_update') {
          const s = j.step_update || {};
          if (s.usage) lastUsage = s.usage;
          const hit = nativeToolStep(j);
          if (hit) throw nativeToolError(hit.name);
          if (s.step_type === 'agent_response' && typeof s.text_delta === 'string' && s.text_delta) {
            outChars += s.text_delta.length;
            const part = splitter.push(s.text_delta);
            emitSplit(part, out);
            if (part.stop) blockDone = true;
          }
        } else if (j.event === 'result') result = j.result || {};
        return out;
      }

      let endedOnResult = false;
      try {
        if (subscription) yield { type: 'billing', perCall: false };
        for (;;) {
          if (signal && signal.aborted) return;
          if (!queue.length) {
            if (closed) break;
            await new Promise(r => { wake = r; });
            continue;
          }
          const line = queue.shift();
          if (line == null) {
            if (signal && signal.aborted) return;
            if (failure) throw failure;
            if (closed) break;
            continue;
          }
          let j;
          try { j = JSON.parse(line); } catch (_) { continue; }
          const evs = onLine(j);
          // the call block is over: anything agy writes after it is a guess at results it has not seen (see claude-cli
          // STOP), so agy is stopped before the loop is handed the calls
          if (blockDone) killTree(child);
          for (const ev of evs) yield ev;
          if (blockDone) break;
          if (result) { endedOnResult = true; break; }
        }
        if (signal && signal.aborted) return;
        if (failure) throw failure;   // e.g. a native tool step screened after the call block or the result
        if (blockDone) {
          yield usageChunk(lastUsage, true);
          yield { type: 'done', finishReason: 'tool_calls', truncated: false };
          return;
        }
        if (!result) {
          const tail = String(stderr || '').trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400);
          if (AUTH_RE.test(tail)) throw host.notSignedIn(tail);
          throw new Error(NAME + ' exited with code ' + exitCode + ' before answering' + (tail ? ': ' + tail : ''));
        }
        const status = String(result.status || '').toUpperCase();
        if (status !== 'SUCCESS') {
          if (result.usage) yield usageChunk(result.usage);
          const err = result.error;
          throw failureError(host, (err && typeof err === 'object' ? (err.message || JSON.stringify(err)) : err) || status || stderr);
        }
        if (!sawText && callIndex === 0 && typeof result.response === 'string') { outChars += result.response.length; const part = splitter.push(result.response); yield* emitSplit(part, []); }
        yield* emitSplit(splitter.end(), []);
        yield usageChunk(result.usage || lastUsage);
        yield { type: 'done', finishReason: callIndex > 0 ? 'tool_calls' : 'stop', truncated: false };
      } catch (e) {
        // an attempt that fails (timeout, no result, native tool) after agy counted tokens still spent them: book the
        // last count before the failure so the ledger and the token ceilings see it
        if (lastUsage && !usageSent && !(signal && signal.aborted)) yield usageChunk(lastUsage, true);
        throw e;
      } finally {
        finished = true;
        if (idleTimer) clearTimeout(idleTimer);
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        // the folder goes only once the child is gone. stdin is closed, so a child that answered exits by itself: give
        // it a moment before taking its tree
        const dropDir = () => host.dropDir(cwd);
        if (closed) dropDir();
        else if (endedOnResult && !(signal && signal.aborted)) {
          const late = setTimeout(() => { if (closed) dropDir(); else killTree(child, dropDir); }, 3000);
          if (late && typeof late.unref === 'function') late.unref();
        } else killTree(child, dropDir);
      }
    }

    return {
      stream,
      listModels,
      contextLimit() { return DEFAULT_CONTEXT; },
      priceOf() { return null; },   // no list-rate table: subscription turns are $0, keyed turns stay honestly unpriced
      supportsTools() { return true; },
      supportsImages() { return false; },
      reasoningEfforts() { return EFFORTS.slice(); }
    };
  }

  return { makeAntigravityCliProvider, _internals: { composePrompt, inputLine, parseModels, isSubscription, failureError, EFFORTS } };
});
