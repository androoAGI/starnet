/* bin/lib/cli-core.js — the PURE decisions behind the `starnet` command-line surface.

   `bin/starnet.js` is the composition root (argv, env, sockets, child processes, stdout/stderr). Everything
   that can be decided without ambient I/O lives here so it is unit-testable in isolation (test/cli.test.js):
   argument parsing, the attach-vs-spawn choice, the run-event reducer that decides what the CLI is allowed to
   claim, exit codes, the desktop port-discovery parsers, and the non-interactive bootstrap documents.

   TRUTHFUL-TELEMETRY LAW, applied to a terminal: the CLI prints only what the station's own event stream
   proves. A stream that ends without agent.run.end is reported as an error, never as "done"; text is the
   concatenation of real agent.token deltas; tool lines mirror agent.tool_call / agent.tool_result one-to-one.
   No function here ever fabricates a reason, a cost, or a reply. */
'use strict';

const EXIT = Object.freeze({
  OK: 0,          // agent.run.end{reason:'done'}
  RUN_FAILED: 1,  // agent.run.end{reason:'error'} or the stream dropped before a terminal event
  USAGE: 2,       // bad arguments
  STATION: 3,     // no station reachable / could not boot one / nothing runnable configured
  CANCELLED: 4,   // Ctrl-C or --timeout (POST /api/cancel was sent)
  STOPPED: 5,     // the run ended early for a reason that is not 'done': refusal, budget, max_iters, empty, clarifying
  NOTHING: 6      // approve/deny found no open ask to answer
});

const RUN_STOP_REASONS = Object.freeze(['done', 'max_iters', 'budget', 'cancelled', 'error', 'refusal', 'empty', 'clarifying']);

// The coding office: every placed capability object a headless run may draw on. Identical to what the ACP
// bridge grants an editor session (sidecar/acp/serve.js) — files, shell + verify, web/browser, memory, on top
// of the compute-only interactive office. Consent for mutations still rides the station's own gate.
const HEADLESS_PLACED = Object.freeze([
  { objectType: 'computer' }, { objectType: 'cabinet' },
  { objectType: 'workbench' }, { objectType: 'dish' }, { objectType: 'notebook' }
]);

const DEFAULT_PORT = 8787;
const DEFAULT_AGENT_ID = 'agent';

// ---- argv --------------------------------------------------------------------------------------
const USAGE = [
  'starnet — run StarNet agents from a terminal (no station UI required)',
  '',
  'Usage:',
  '  starnet                              the live crew dashboard (needs a terminal; keys below). On a station with no agent',
  '                                       yet it sets one up first: your Overseer, a brain to think with (ChatGPT, Claude,',
  '                                       Grok, Kimi, StarNet credits or Ollama), the awakening and its interview',
  '  starnet -p "<prompt>"                run one task and stream the answer to stdout',
  '  starnet run "<prompt>"               same as -p',
  '  starnet -p -                         read the prompt from stdin',
  '  starnet status                       is a station reachable? version, workspace, providers (names only)',
  '  starnet doctor                       the station\'s static diagnostics report (no live probes)',
  '  starnet init                         create the default workspace + one full-power agent for headless runs (no run;',
  '                                       `starnet` then gives it the awakening the first time you open it)',
  '  starnet ls                           every agent: status, what it is doing now, open asks',
  '  starnet approve [agent] [--session]  allow the oldest open ask (of that agent); deny [agent] refuses it',
  '  starnet watch                        print the live events of the station, one line each (--json: one object each)',
  '  starnet flow                         list workflows; flow run <name> "<text>" sends one job and waits',
  '',
  'StarNet app closed? starnet starts its station in the background: the app\'s keys, no window (the tray shows it runs).',
  '  When the last starnet session ends it closes again, unless routines are armed or StarNet is set to stay in the tray',
  '  (the same as closing its window). Opening StarNet while it runs shows that same station (on macOS: its',
  '  menu-bar icon\'s Open StarNet — a Dock click does not bring that window back yet).',
  '',
  'Folder: starnet works in the trusted project you start it in. Started in one not trusted yet, the dashboard asks',
  '  TRUST THIS FOLDER? (y trusts it, the same as adding it under PROJECTS in the app); your home folder is never asked',
  'Dashboard keys: tab switch agent · ↑↓ your earlier messages · @name message · y/n/v answer an ask · ctrl+c quit',
  'Dashboard pages: f1 STAT · f2 CREW · f3 COMMS · f4 WORK · f5 SKILLS (or /stat /crew /work) · esc back to COMMS',
  'Dashboard mouse: click an agent to open its chat, a tab for its page, a card\'s key to answer · right-click an agent',
  '  for its menu · ctrl+click opens a link or a file an agent wrote · STARNET_MOUSE=0 keeps the terminal\'s own selection',
  'Dashboard commands: /model [name] · /new · /resume · /stop · /retry · /status · /flow · /flow run <name> <text> · /help',
  '  /connect [provider] adds a provider from the app\'s AI & MODELS list: sign in (ChatGPT, Grok, Kimi, Claude Code),',
  '  link StarNet credits, use Ollama, or paste an API key (typed hidden, checked first, kept where the app keeps keys)',
  '  and the station\'s own: /usage · /tools · /routine · /away · your own commands · each skill as /<skill> <task> (/skills)',
  'Dashboard look: the StarNet logo as an image where the terminal draws Sixel (Windows Terminal, WezTerm, iTerm2), braille',
  '  dots elsewhere · STARNET_LOGO=dots|ascii|plain picks one · NO_COLOR=1 drops color · needs at least 46×16',
  '  /theme picks the colors: red (the default), amber, green, blue, purple, white — the app colors; kept for the next',
  '  starnet (STARNET_THEME=<name> overrides it)',
  '  where images draw, the foot of CREW is the station camera on the agent you talk to, in ASCII: it wanders, walks to',
  '  its desk and types while it works; its rim glows in the theme color working, amber when it needs you, green when done',
  '',
  'Run options:',
  '  --agent <id>       roster agent to run (default: "agent", else the first roster entry)',
  '  --model <slug>     override the agent\'s model',
  '  --provider <id>    override the agent\'s provider (openrouter, openai, anthropic, codex, …)',
  '  --json             print one JSON object (result + run receipt) instead of streaming text',
  '  --cwd <dir>        the folder to work in (default: the one you are in, when it is a trusted project; a folder not',
  '                     trusted yet is asked about before the agent works in it)',
  '  --timeout <sec>    cancel the run after N seconds (exit 4)',
  '  --yes              approve consent prompts automatically (non-interactive default is DENY)',
  '',
  'Station options:',
  '  --port <n>         attach to a station on this port (env STARNET_PORT)',
  '  --host <h>         station host (default 127.0.0.1)',
  '  --token <t>        station API token (env STARNET_TOKEN); otherwise read from the served page',
  '  --workspace <dir>  workspace to boot when no station is reachable (env STARNET_WORKSPACES)',
  '  --name <NAME>      agent name used by a first-time bootstrap (default OVERSEER)',
  '  --no-spawn         never boot a station; fail (exit 3) if none is reachable',
  '  --spawn            always boot a station for this run (never attach to a running one); StarNet\'s own station is',
  '                     never booted without its keys: plain starnet starts it, add --workspace <dir> for a separate one',
  '',
  'Exit codes: 0 done · 1 run failed · 2 usage · 3 no station / not configured · 4 cancelled · 5 stopped early · 6 nothing to answer',
  '',
  'Credentials are never taken on the command line. A spawned station reads them from the environment',
  '(STARNET_OPENROUTER_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, …) or from a ChatGPT/Codex sign-in already',
  'stored in the workspace; an attached station uses whatever it already has, plus what /connect adds.'
].join('\n');

const STATION_COMMANDS = ['dash', 'ls', 'approve', 'deny', 'watch', 'flow'];

function parseArgs(argv, env, ctx) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const e = env || {};
  const c = ctx || {};
  const out = {
    cmd: '', prompt: '', promptFromStdin: false,
    agent: '', model: '', provider: '', json: false, cwd: '', timeoutSec: 0, yes: false,
    port: 0, host: '', token: '', workspace: '', name: '', noSpawn: false, spawn: false, help: false, version: false,
    args: [], session: false
  };
  const takeValue = (flag, i) => {
    if (i + 1 >= args.length) throw new Error(flag + ' needs a value');
    return args[i + 1];
  };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    let m;
    if (a === '-h' || a === '--help' || a === 'help') { out.help = true; i++; continue; }
    if (a === '-v' || a === '--version') { out.version = true; i++; continue; }
    if (a === '-p' || a === '--prompt') {
      out.cmd = out.cmd || 'run';
      const v = takeValue(a, i);
      if (v === '-') out.promptFromStdin = true; else out.prompt = v;
      i += 2; continue;
    }
    if ((m = /^--prompt=(.*)$/.exec(a))) { out.cmd = out.cmd || 'run'; out.prompt = m[1]; i++; continue; }
    if (!out.cmd && STATION_COMMANDS.indexOf(a) >= 0) { out.cmd = a; i++; continue; }
    if (!out.cmd && (a === 'run' || a === 'status' || a === 'doctor' || a === 'init')) {
      out.cmd = a; i++;
      if (a === 'run' && i < args.length && args[i][0] !== '-') { out.prompt = args[i]; i++; }
      else if (a === 'run' && i < args.length && args[i] === '-') { out.promptFromStdin = true; i++; }
      continue;
    }
    const flagVal = (name) => {
      const eq = new RegExp('^--' + name + '=(.*)$').exec(a);
      if (eq) { i++; return eq[1]; }
      if (a === '--' + name) { const v = takeValue(a, i); i += 2; return v; }
      return undefined;
    };
    let v;
    if ((v = flagVal('agent')) !== undefined) { out.agent = v; continue; }
    if ((v = flagVal('model')) !== undefined) { out.model = v; continue; }
    if ((v = flagVal('provider')) !== undefined) { out.provider = v; continue; }
    if ((v = flagVal('cwd')) !== undefined) { out.cwd = v; continue; }
    if ((v = flagVal('timeout')) !== undefined) {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--timeout must be a positive number of seconds');
      out.timeoutSec = n; continue;
    }
    if ((v = flagVal('port')) !== undefined) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('--port must be 1–65535');
      out.port = n; continue;
    }
    if ((v = flagVal('host')) !== undefined) { out.host = v; continue; }
    if ((v = flagVal('token')) !== undefined) { out.token = v; continue; }
    if ((v = flagVal('workspace')) !== undefined) { out.workspace = v; continue; }
    if ((v = flagVal('name')) !== undefined) { out.name = v; continue; }
    if (a === '--json') { out.json = true; i++; continue; }
    if (a === '--session') { out.session = true; i++; continue; }
    if (a === '--yes' || a === '-y') { out.yes = true; i++; continue; }
    if (a === '--no-spawn') { out.noSpawn = true; i++; continue; }
    if (a === '--spawn') { out.spawn = true; i++; continue; }
    if (a[0] === '-') throw new Error('unknown option ' + a);
    // a bare word after `run "<prompt>"` or a stray positional
    if (out.cmd === 'run' && !out.prompt && !out.promptFromStdin) { out.prompt = a; i++; continue; }
    if (STATION_COMMANDS.indexOf(out.cmd) >= 0) { out.args.push(a); i++; continue; }
    throw new Error('unexpected argument ' + JSON.stringify(a));
  }
  // no command: the dashboard when a person is at a terminal, the usage text otherwise (a pipe, a script, CI)
  if (!out.cmd && !out.help && !out.version) { if (c.tty) out.cmd = 'dash'; else out.help = true; }
  if (out.cmd === 'flow' && out.args[0] === 'run' && out.args.length < 3) throw new Error('flow run needs a workflow and the job text: starnet flow run <name> "<text>"');
  if ((out.cmd === 'approve' || out.cmd === 'deny') && out.args.length > 1) throw new Error(out.cmd + ' takes at most one agent');
  if (out.cmd === 'run' && !out.prompt && !out.promptFromStdin) throw new Error('run needs a prompt (starnet -p "…")');
  if (out.spawn && out.noSpawn) throw new Error('--spawn and --no-spawn contradict each other');
  // env fallbacks (flags win)
  if (!out.port) {
    const ep = String(e.STARNET_PORT || e.SKYNET_PORT || '').trim();
    if (/^\d+$/.test(ep)) out.port = Number(ep);
  }
  if (!out.host) out.host = String(e.STARNET_HOST || e.SKYNET_HOST || '127.0.0.1');
  if (!out.token) out.token = String(e.STARNET_TOKEN || e.STARNET_API_TOKEN || e.SKYNET_API_TOKEN || '');
  if (!out.workspace) out.workspace = String(e.STARNET_WORKSPACES || e.SKYNET_WORKSPACES || '');
  if (!out.name) out.name = 'OVERSEER';
  out.name = String(out.name).slice(0, 40);
  return out;
}

// ---- attach vs spawn ---------------------------------------------------------------------------
/* Decide where the run goes. `candidates` are probe results in PRIORITY order, each { source, port, reachable }
   (source: 'flag' | 'env' | 'default' | 'desktop'). `desktop` describes what the desktop-app workspace's owner
   claim proved: { ownerAlive, port } (port 0 when the OS could not tell us which port that pid listens on).

   Rules, in order:
     1. the first REACHABLE candidate wins → attach (never spawn a second station beside a live one);
     2. an explicit --port/env port that is NOT reachable is an error, not a spawn (the operator named a station);
     3. a live desktop owner whose port we could not resolve → refuse to spawn INTO that workspace (one
        sidecar per WORKSPACES dir is a hard invariant) — unless the operator picked another workspace;
     4. the desktop app's station (desktop.station: it holds a save; desktop.appRan: the app has run there) with
        the app CLOSED → START THE APP in the background (launch-app: desktop.appExe `--background`, window
        parked, no window opens), unless the operator picked another workspace. The app keeps that station's keys,
        key pools, bot tokens and credits token in the OS keychain and gives them only to the sidecar it spawns,
        so the terminal never boots that station itself — that would be a keyless copy of the real station (agents
        fail, bots stay offline, routines fire and fail). No app to start (desktop.appExe '') → refuse and say so.
        --no-spawn (a question: status, ls, …) → refuse, saying `starnet` starts it. --spawn alone refuses too:
        with no --workspace it boots the default workspace, which IS that station, so the reason names both ways;
     5. --no-spawn → refuse; otherwise → spawn. */
const DESKTOP_CLOSED = 'StarNet isn\'t running — run `starnet` to start it (in the background: your keys stay in the app, no window opens)';
const DESKTOP_CLOSED_SPAWN = '--spawn would boot StarNet\'s own station without the keys the app keeps — run plain `starnet` to start it with them (no window opens), or add --workspace <dir> for a separate terminal-only station';
const DESKTOP_NO_APP = 'StarNet\'s station keeps its keys in the StarNet app, and the app was not found on this computer — reinstall StarNet, set STARNET_APP_EXE to the app, or add --workspace <dir> for a separate terminal-only station';
function chooseStation(input) {
  const o = input || {};
  const d = o.desktop || {};
  const desktopClosed = !!(d.station && d.appRan && !d.ownerAlive && !o.workspaceOverride);
  if (o.forceSpawn) {
    if (o.noSpawn) return { mode: 'refuse', reason: '--spawn and --no-spawn contradict each other' };
    return desktopClosed ? { mode: 'refuse', reason: DESKTOP_CLOSED_SPAWN } : { mode: 'spawn', forced: true };
  }
  const cands = Array.isArray(o.candidates) ? o.candidates : [];
  const hit = cands.find(c => c && c.reachable);
  if (hit) return { mode: 'attach', port: hit.port, source: hit.source };
  const named = cands.find(c => c && (c.source === 'flag' || c.source === 'env'));
  if (named) return { mode: 'refuse', reason: 'no station is answering on port ' + named.port + ' (from ' + (named.source === 'flag' ? '--port' : 'STARNET_PORT') + ')' };
  if (d.ownerAlive && !d.port && !o.workspaceOverride) {
    return { mode: 'refuse', reason: 'the desktop app owns the default workspace (pid ' + d.ownerPid + ') but its port could not be discovered — pass --port <n> to attach, or --workspace <dir> to boot a separate station' };
  }
  if (desktopClosed) {
    if (o.noSpawn) return { mode: 'refuse', reason: DESKTOP_CLOSED };
    if (!d.appExe) return { mode: 'refuse', reason: DESKTOP_NO_APP };
    return { mode: 'launch-app', exe: d.appExe };
  }
  if (o.noSpawn) return { mode: 'refuse', reason: 'no station reachable and --no-spawn was given' };
  return { mode: 'spawn' };
}

// ---- desktop discovery parsers -----------------------------------------------------------------
// `netstat -ano` (Windows): "  TCP    127.0.0.1:64769   0.0.0.0:0   LISTENING   10436"
// `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>` (macOS/Linux): "node 10436 andro 23u IPv4 0x… 0t0 TCP 127.0.0.1:64769 (LISTEN)"
// Returns the first loopback port the pid LISTENS on, else 0.
function parseListeningPort(text, pid, platform) {
  const want = String(pid || '');
  if (!want) return 0;
  const lines = String(text || '').split(/\r?\n/);
  if (platform === 'win32') {
    for (const line of lines) {
      const m = /^\s*TCP\s+(127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
      if (m && m[3] === want) return Number(m[2]);
    }
    return 0;
  }
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9 || cols[1] !== want) continue;
    const m = /(?:127\.0\.0\.1|localhost|\[::1\]|\*):(\d+)$/.exec(cols[8]);
    if (m && /LISTEN/.test(line)) return Number(m[1]);
  }
  return 0;
}

// The desktop shell's startup.log: "spawn_sidecar pid=10436 port=64769 listening=true". Last such line wins.
function parseStartupLog(text) {
  let out = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /spawn_sidecar\s+pid=(\d+)\s+port=(\d+)\s+listening=(true|false)/.exec(line);
    if (m) out = { pid: Number(m[1]), port: Number(m[2]), listening: m[3] === 'true' };
  }
  return out;
}
/* The app's own path, from the line it writes at every start: `startup exe=Ok("C:\\Users\\…\\skynet-desktop.exe") …`
   (Rust's Debug of current_exe(): \\ \" \' \n \t \r and \u{…} escaped). The LAST start wins; '' when there is none. */
function parseStartupExe(text) {
  let raw = null;
  const re = /startup exe=Ok\("((?:[^"\\]|\\.)*)"\)/g;
  let m;
  while ((m = re.exec(String(text || '')))) raw = m[1];
  if (raw === null) return '';
  return raw.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\(.)/g, (all, hex, ch) => {
    if (hex) { const n = parseInt(hex, 16); return n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
    return ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch === '0' ? '\0' : ch;
  });
}
/* What StarNet's startup.log says about ONE terminal session (src-tauri main.rs logs its --background start and every
   join outcome with the session's pid): 'started-for' (it was started for this pid), 'joined', 'starting' (it asked
   before setup was done; tracked once it is), 'closing' (its sessions ended and it is closing: start it again once it
   has quit), 'not-tracked' (a person's StarNet, or one staying in the tray: a terminal ending never closes it), or
   null (nothing about this pid). The LAST line about the pid wins. */
function joinOutcome(text, pid) {
  const want = String(pid);
  let out = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    let m = /started by starnet \(--background, terminal pid (\d+)\)/.exec(line);
    if (m && m[1] === want) { out = 'started-for'; continue; }
    m = /starnet session pid (\d+)[: ]\s*(.*)$/.exec(line);
    if (!m || m[1] !== want) continue;
    out = /^joins the station/.test(m[2]) ? 'joined' : /^joins once StarNet has started/.test(m[2]) ? 'starting'
      : /^arrived while StarNet is closing/.test(m[2]) ? 'closing' : 'not-tracked';
  }
  return out;
}
// the exit code of a terminal-started StarNet whose engine failed and whose startup dialog was cancelled
// (src-tauri terminal_session.rs EXIT_START_CANCELLED): a 0 would read as a hand-off to a StarNet already starting
const APP_EXIT_START_CANCELLED = 3;

// ---- agent selection ---------------------------------------------------------------------------
/* GET /api/runtime/agent lists the roster ({agentId, name, model, provider}). Pick the run target:
   --agent must exist; otherwise 'agent' (the hero); otherwise the first roster entry. --model / --provider
   override the roster's. An empty roster is fine only when a model is given explicitly (the station runs a
   bare 'agent' identity — same grace the cron driver has for a roster-less headless sidecar). */
function pickAgent(runtime, want) {
  const rt = runtime || {};
  const w = want || {};
  const agents = Array.isArray(rt.agents) ? rt.agents : [];
  let rec = null;
  if (w.agent) {
    rec = agents.find(a => a && a.agentId === w.agent) || null;
    if (!rec) return { ok: false, error: 'unknown agent ' + JSON.stringify(w.agent) + (agents.length ? ' — roster: ' + agents.map(a => a.agentId).join(', ') : ' — the roster is empty') };
  } else {
    rec = agents.find(a => a && a.agentId === DEFAULT_AGENT_ID) || agents[0] || null;
  }
  const agentId = rec ? rec.agentId : DEFAULT_AGENT_ID;
  const model = String(w.model || (rec && rec.model) || rt.model || '').trim();
  const provider = String(w.provider || (rec && rec.provider) || rt.provider || 'openrouter').trim();
  if (!model) return { ok: false, error: 'no model to run: agent ' + JSON.stringify(agentId) + ' has none configured — pass --model <slug> (or set STARNET_DEFAULT_MODEL for a spawned station)' };
  return { ok: true, agentId, name: rec ? rec.name : agentId, model, provider };
}

/* Task or talk? The station wires tools ONLY into a run marked isTask, and the page decides it with the shared
   classifier (frontend/app/classify.js). A run sent without it got no tools at all, so a real model could only
   answer in words. The terminal asks the same question the same way. priorAgentTurn: the agent's last reply, so a
   bare "yes" to its offer to act is the task. */
const Classify = require('../../frontend/app/classify.js');
const { argDigest } = require('./station-model.js');
function isTaskText(text, priorAgentTurn) { return !!Classify.isTaskDirective(text, priorAgentTurn ? { priorAgentTurn } : undefined); }

function buildRunBody(sel, prompt, opts) {
  const o = opts || {};
  const text = String(prompt == null ? '' : prompt);
  const body = {
    model: sel.model,
    provider: sel.provider,
    agentId: sel.agentId,
    messages: [{ role: 'user', content: text }],
    // the agent as its roster defines it, told it is in the terminal (no GUI to point at): handleRun TERMINAL_NOTE
    rosterSystem: true,
    client: 'terminal',
    isTask: isTaskText(text),
    placed: HEADLESS_PLACED.map(p => Object.assign({}, p))
  };
  if (o.cwd) body.projectRoot = String(o.cwd);
  return body;
}

// ---- the run tracker: what the stream PROVED ---------------------------------------------------
/* Feed every NDJSON event; read `.summary()` at the end. Terminal truth:
     - reason comes ONLY from agent.run.end. A stream that closes without it settles as
       'cancelled' when the CLI itself asked for the cancel (Ctrl-C / --timeout), else 'error'.
     - text is the joined agent.token deltas (the answer as it streamed, nothing synthesized).
   feed() returns a small list of render actions so the composition root can print without re-deriving
   anything: { kind:'text', delta } | { kind:'tool', line } | { kind:'note', line } | { kind:'consent', ev }. */
function makeRunTracker() {
  const st = {
    runId: '', started: false, sawEnd: false, reason: '', finishReason: '',
    text: '', turns: 0, usd: 0, tokensIn: 0, tokensOut: 0, model: '',
    toolCalls: [], errors: [], events: 0, cancelRequested: false, timedOut: false,
    budgetScope: '', budgetCapUsd: null, pendingTools: new Map()
  };
  function feed(ev) {
    const actions = [];
    if (!ev || typeof ev.name !== 'string') return actions;
    const p = ev.payload || {};
    st.events++;
    switch (ev.name) {
      case 'agent.run.start':
        // the LEAD's run is the first run.start: a delegated worker's run.start rides this stream too, and must never
        // become the run Ctrl-C / --timeout cancels or the receipt reports
        st.started = true; if (!st.runId) st.runId = String(p.runId || ''); if (p.model && !st.model) st.model = String(p.model);
        break;
      case 'agent.token':
        if (typeof p.delta === 'string' && p.delta) { st.text += p.delta; actions.push({ kind: 'text', delta: p.delta }); }
        break;
      case 'agent.tool_call': {
        const rec = { callId: String(p.callId || ''), name: String(p.name || 'tool'), argsSummary: String(p.argsSummary || ''), ok: null, ms: null, summary: '' };
        st.toolCalls.push(rec);
        if (rec.callId) st.pendingTools.set(rec.callId, rec);
        const said = argDigest(rec.argsSummary, rec.name);   // the salient argument, not the raw JSON (--json keeps it whole)
        actions.push({ kind: 'tool', line: '⋯ ' + rec.name + (said ? ' ' + said : '') });
        break;
      }
      case 'agent.tool_result': {
        let rec = p.callId ? st.pendingTools.get(String(p.callId)) : null;
        if (!rec) { rec = { callId: String(p.callId || ''), name: 'tool', argsSummary: '', ok: null, ms: null, summary: '' }; st.toolCalls.push(rec); }
        rec.ok = !!p.ok; rec.ms = Number.isFinite(Number(p.ms)) ? Number(p.ms) : null; rec.summary = String(p.summary || '');
        if (rec.callId) st.pendingTools.delete(rec.callId);
        actions.push({ kind: 'tool', line: '  ↳ ' + (rec.ok ? 'ok' : 'FAIL') + (rec.ms != null ? ' ' + rec.ms + 'ms' : '') + (rec.summary ? ' — ' + rec.summary : '') });
        break;
      }
      case 'agent.cost':
        if (Number.isFinite(Number(p.usd))) st.usd = Math.max(st.usd, Number(p.usd));   // the loop reports cumulative spend; the last/largest is the run total
        if (Number.isFinite(Number(p.tokensIn))) st.tokensIn = Number(p.tokensIn);
        if (Number.isFinite(Number(p.tokensOut))) st.tokensOut = Number(p.tokensOut);
        if (p.model) st.model = String(p.model);
        break;
      case 'agent.run.error':
        st.errors.push(String(p.message || 'run error'));
        actions.push({ kind: 'note', line: '! ' + String(p.message || 'run error') });
        break;
      case 'permission.prompt':
        actions.push({ kind: 'consent', ev: p });
        break;
      case 'crew.summon.request':
        actions.push({ kind: 'note', line: '! the agent asked to summon a crew member (' + String(p.name || p.specId || 'unnamed') + ') — not available headless; the station will time the request out' });
        break;
      case 'provider.fallback':
        actions.push({ kind: 'note', line: '· provider fallback: ' + JSON.stringify(p).slice(0, 200) });
        break;
      case 'agent.run.end':
        st.sawEnd = true;
        st.reason = RUN_STOP_REASONS.indexOf(p.reason) >= 0 ? p.reason : 'error';
        st.turns = Number(p.turns) || st.turns;
        if (Number.isFinite(Number(p.usd))) st.usd = Number(p.usd);
        if (p.finishReason) st.finishReason = String(p.finishReason);
        if (p.budgetScope) { st.budgetScope = String(p.budgetScope); if (p.budgetCapUsd != null) st.budgetCapUsd = p.budgetCapUsd; }
        break;
      default: break;
    }
    return actions;
  }
  function markCancel(why) { st.cancelRequested = true; if (why === 'timeout') st.timedOut = true; }
  function settledReason() {
    if (st.sawEnd) return st.reason;
    return st.cancelRequested ? 'cancelled' : 'error';
  }
  function summary() {
    const reason = settledReason();
    return {
      ok: reason === 'done',
      reason,
      proven: st.sawEnd,                 // false = the stream dropped before agent.run.end; `reason` is the CLI's honest fallback
      timedOut: st.timedOut,
      runId: st.runId, model: st.model, text: st.text, turns: st.turns, usd: st.usd,
      tokens: { in: st.tokensIn, out: st.tokensOut },
      toolCalls: st.toolCalls.map(t => ({ name: t.name, argsSummary: t.argsSummary, ok: t.ok, ms: t.ms, summary: t.summary })),
      errors: st.errors.slice(), events: st.events,
      finishReason: st.finishReason || undefined,
      budgetScope: st.budgetScope || undefined, budgetCapUsd: st.budgetCapUsd == null ? undefined : st.budgetCapUsd
    };
  }
  return { feed, markCancel, summary, state: st };
}

function exitCodeForReason(reason, opts) {
  const o = opts || {};
  if (reason === 'done') return EXIT.OK;
  if (reason === 'cancelled') return EXIT.CANCELLED;
  if (reason === 'error') return EXIT.RUN_FAILED;
  if (o.proven === false) return EXIT.RUN_FAILED;
  return EXIT.STOPPED;   // refusal / budget / max_iters / empty / clarifying — the run ended, just not with 'done'
}

// ---- non-interactive bootstrap -----------------------------------------------------------------
/* A fresh workspace needs exactly what the desktop's onboarding would have written: a roster entry the sidecar
   can run (agent.roster.json) and a save document the desktop can RESUME (agent.save.json, schema starnet.save
   v5 — the same golden shape dev/fixtures/seed-workspace uses). The desktop's boot path sees a valid save and
   resumes it (or shows the RESUME connect screen when its keychain holds no key) — it never re-runs the
   first-run ceremony over it. approvalMode:'full' is the product law: full power from minute one.
   Both files are STATE_EVIDENCE (workspace-lineage.js), so the sidecar's recovery gate treats this workspace
   as a real station, not an empty one to recover into. */
function bootstrapDocs(input) {
  const o = input || {};
  const now = Number(o.now) || 0;
  const agentId = DEFAULT_AGENT_ID;
  const name = String(o.name || 'OVERSEER').slice(0, 40);
  const model = String(o.model || '');
  const provider = String(o.provider || 'openrouter');
  const identity = 'You are ' + name + ', the resident agent of a StarNet station driven from the command line. Sharp, concise, a little dry. Use your real tools (web, files, shell, memory) when a task needs them and report what they actually returned — never what you assume they would.';
  const purpose = 'Be the always-ready general agent for this station: take a task from the terminal, do the real work with real tools, and answer plainly.';
  const roster = {
    version: 1,
    updatedAt: now,
    agents: [{
      agentId, name, system: identity, model, provider,
      role: 'general agent / terminal operator',
      approvalMode: 'full'
    }]
  };
  const save = {
    version: 1, agentId, updatedAt: now, savedAt: now,
    doc: {
      schema: 'starnet.save', version: 5, updatedAt: now,
      agent: {
        id: agentId, name, color: '#5ad0ff', model, personaId: 'worker-homie', purpose, specialtyId: null, createdAt: now,
        // a station set up for a headless run, never met by a person: the dashboard runs the awakening over it (dashboard.js)
        bootstrappedBy: 'starnet-cli',
        docs: {
          identity, purpose,
          manual: 'Keep replies brief. Use your real tools when a task needs them and report what they actually returned. Say plainly when something is broken or out of reach.',
          context: 'This station was bootstrapped headlessly by the starnet CLI. The desktop app can open it at any time; the layout and crew grow from there.'
        },
        stats: { xp: 0, level: 1, lifetimeXp: 0, confidence: 50, samples: 0, counters: {}, milestones: [] }
      },
      agents: [],
      usage: { tokens: 0, cost: 0, calls: 0 },
      prov: provider,
      station: null,
      stationStats: { xp: 0, level: 1, lifetimeXp: 0, confidence: 50, samples: 0, counters: {}, milestones: [] },
      profile: { v: 1, tags: {}, seed: null, enabled: true, total: 0 },
      dossier: { v: 1, dims: { identity: [], stack: [], goals: [], style: [], standing_orders: [] }, seededFrom: {}, updatedAt: 0 },
      workstreams: [], activeId: null, generalId: null
    }
  };
  return { roster, save };
}

/* Which provider can a SPAWNED station run headlessly, from the environment alone? Mirrors the sidecar's own
   envFirst() (bare name, STARNET_<name>, SKYNET_<name>) over the registry's keyEnv lists. `codexTokensPresent`
   is the workspace's codex/tokens.json (a ChatGPT sign-in the desktop stored), checked by the caller. */
function inferProvider(input) {
  const o = input || {};
  const env = o.env || {};
  const profiles = Array.isArray(o.profiles) ? o.profiles : [];
  const has = (name) => {
    for (const k of [name, 'STARNET_' + name, 'SKYNET_' + name]) { if (env[k] != null && String(env[k]).trim()) return true; }
    return false;
  };
  if (o.explicit) return { provider: String(o.explicit), source: 'flag' };
  for (const p of profiles) {
    if (!p || !Array.isArray(p.keyEnv)) continue;
    if (p.keyEnv.some(has)) return { provider: p.id, source: 'env:' + p.keyEnv.find(has) };
  }
  if (o.codexTokensPresent) return { provider: 'codex', source: 'workspace codex sign-in' };
  return { provider: '', source: '' };
}

// ---- output shaping ----------------------------------------------------------------------------
function jsonResult(summary, ctx) {
  const s = summary || {};
  const c = ctx || {};
  return {
    ok: !!s.ok,
    reason: s.reason,
    proven: s.proven,
    exitCode: exitCodeForReason(s.reason, { proven: s.proven }),
    text: s.text || '',
    runId: s.runId || '',
    agentId: c.agentId || '',
    agentName: c.agentName || '',
    model: s.model || c.model || '',
    provider: c.provider || '',
    station: { baseUrl: c.baseUrl || '', mode: c.mode || '', workspace: c.workspace || null, version: c.version || '' },
    usd: s.usd || 0,
    turns: s.turns || 0,
    tokens: s.tokens || { in: 0, out: 0 },
    toolCalls: s.toolCalls || [],
    errors: s.errors || [],
    finishReason: s.finishReason,
    budgetScope: s.budgetScope, budgetCapUsd: s.budgetCapUsd,
    timedOut: !!s.timedOut,
    startedAt: c.startedAt || 0, endedAt: c.endedAt || 0,
    durationMs: (c.startedAt && c.endedAt) ? Math.max(0, c.endedAt - c.startedAt) : 0
  };
}

// NDJSON splitter shared by the stream reader: returns complete lines, keeps the remainder.
function splitNdjson(buf) {
  const lines = [];
  let rest = String(buf || '');
  let nl;
  while ((nl = rest.indexOf('\n')) >= 0) {
    const line = rest.slice(0, nl).replace(/\r$/, '');
    rest = rest.slice(nl + 1);
    if (line.trim()) lines.push(line);
  }
  return { lines, rest };
}

/* SSE splitter for the live feed (GET /api/observe): complete events out, the partial tail kept. Each event is
   { id, data } where data is the joined `data:` lines; comment lines and `retry:` are dropped. */
function splitSse(buf) {
  const events = [];
  let rest = String(buf || '').replace(/\r\n/g, '\n');
  let cut;
  while ((cut = rest.indexOf('\n\n')) >= 0) {
    const block = rest.slice(0, cut);
    rest = rest.slice(cut + 2);
    let id = '', data = [];
    for (const line of block.split('\n')) {
      if (line.indexOf('data:') === 0) data.push(line.slice(5).replace(/^ /, ''));
      else if (line.indexOf('id:') === 0) id = line.slice(3).trim();
    }
    if (data.length) events.push({ id, data: data.join('\n') });
  }
  return { events, rest };
}

// the conversation a terminal holds with one agent: its own stream, so the desk's sessions are never written into
function cliStreamId(agentId) { return ('cli-' + String(agentId || 'agent').replace(/[^A-Za-z0-9_-]/g, '')).slice(0, 64); }

module.exports = {
  EXIT, USAGE, DEFAULT_PORT, DEFAULT_AGENT_ID, DESKTOP_CLOSED, DESKTOP_CLOSED_SPAWN, DESKTOP_NO_APP, HEADLESS_PLACED, RUN_STOP_REASONS,
  APP_EXIT_START_CANCELLED, parseArgs, chooseStation, parseListeningPort, parseStartupLog, parseStartupExe, joinOutcome, pickAgent, buildRunBody,
  makeRunTracker, exitCodeForReason, bootstrapDocs, inferProvider, jsonResult, splitNdjson, splitSse, cliStreamId, isTaskText
};
