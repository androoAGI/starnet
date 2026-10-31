/* node test/cli.test.js — the PURE decisions of the `starnet` CLI (bin/lib/cli-core.js), no I/O.

   Locks: argument parsing + env fallbacks · the attach-vs-spawn choice (never spawn beside a live station,
   never boot into a workspace a live desktop owns, a NAMED port that is dead is an error not a spawn) · the
   desktop port-discovery parsers · agent/model selection · the run-event reducer (text = the real token deltas,
   reason ONLY from agent.run.end, a dropped stream is never "done") · exit codes · the bootstrap documents the
   desktop can resume (and that the station record counts both as proof of a station) · the JSON receipt shape.
   Part of test:fast. */
'use strict';
const A = require('./_assert.js');
const core = require('../bin/lib/cli-core.js');
const StationRecord = require('../sidecar/station-record.js');

// ---- parseArgs ----------------------------------------------------------------------------------
{
  const o = core.parseArgs(['-p', 'hello there'], {});
  A.eq(o.cmd, 'run', '-p selects run'); A.eq(o.prompt, 'hello there', '-p carries the prompt');
  A.eq(o.host, '127.0.0.1', 'host defaults to loopback'); A.eq(o.port, 0, 'no port unless given');
  A.eq(o.name, 'OVERSEER', 'bootstrap name defaults');
  const r = core.parseArgs(['run', 'do the thing', '--agent', 'nova', '--model=x/y', '--provider', 'openai', '--json', '--cwd', 'C:\\proj', '--timeout', '30', '--yes', '--port', '9001', '--token', 'abc', '--workspace', '/ws', '--name', 'ATLAS', '--no-spawn'], {});
  A.eq(r.cmd, 'run', 'run <prompt> form'); A.eq(r.prompt, 'do the thing', 'positional prompt');
  A.eq(r.agent, 'nova', '--agent'); A.eq(r.model, 'x/y', '--model=value form'); A.eq(r.provider, 'openai', '--provider');
  A.ok(r.json && r.yes && r.noSpawn, '--json --yes --no-spawn booleans'); A.eq(r.cwd, 'C:\\proj', '--cwd');
  A.eq(r.timeoutSec, 30, '--timeout seconds'); A.eq(r.port, 9001, '--port'); A.eq(r.token, 'abc', '--token');
  A.eq(r.workspace, '/ws', '--workspace'); A.eq(r.name, 'ATLAS', '--name');
  const s = core.parseArgs(['-p', '-'], {}); A.ok(s.promptFromStdin && !s.prompt, '-p - reads stdin');
  const st = core.parseArgs(['status'], {}); A.eq(st.cmd, 'status', 'status command');
  A.eq(core.parseArgs(['doctor'], {}).cmd, 'doctor', 'doctor command');
  A.eq(core.parseArgs(['init', '--model', 'm'], {}).cmd, 'init', 'init command');
  A.ok(core.parseArgs([], {}).help, 'no arguments → help');
  A.ok(core.parseArgs(['--help'], {}).help, '--help');
  A.ok(core.parseArgs(['--version'], {}).version, '--version');
  A.ok(core.parseArgs(['-p', 'x', '--spawn'], {}).spawn, '--spawn');
  const env = core.parseArgs(['status'], { STARNET_PORT: '4444', STARNET_TOKEN: 'tk', STARNET_WORKSPACES: '/env/ws' });
  A.eq(env.port, 4444, 'STARNET_PORT env fallback'); A.eq(env.token, 'tk', 'STARNET_TOKEN env fallback'); A.eq(env.workspace, '/env/ws', 'STARNET_WORKSPACES env fallback');
  A.eq(core.parseArgs(['status', '--port', '5'], { STARNET_PORT: '4444' }).port, 5, 'a flag beats the env');
  const throws = (argv, re, label) => { let msg = ''; try { core.parseArgs(argv, {}); } catch (e) { msg = e.message; } A.ok(re.test(msg), label + ': ' + msg); };
  throws(['run'], /needs a prompt/, 'run without a prompt is a usage error');
  throws(['-p', 'x', '--timeout', 'soon'], /--timeout/, 'non-numeric timeout');
  throws(['-p', 'x', '--port', '70000'], /--port/, 'out-of-range port');
  throws(['-p', 'x', '--bogus'], /unknown option/, 'unknown option');
  throws(['-p', 'x', '--spawn', '--no-spawn'], /contradict/, '--spawn vs --no-spawn');
  throws(['status', 'extra'], /unexpected argument/, 'stray positional');
  A.ok(/Exit codes: 0 done/.test(core.USAGE), 'usage text documents the exit codes');
}

// ---- chooseStation ------------------------------------------------------------------------------
{
  const c = core.chooseStation;
  A.eq(c({ candidates: [{ source: 'default', port: 8787, reachable: true }] }).mode, 'attach', 'a reachable default attaches');
  const d = c({ candidates: [{ source: 'default', port: 8787, reachable: false }, { source: 'desktop', port: 64769, reachable: true }], desktop: { ownerAlive: true, port: 64769 } });
  A.eq(d.mode + ':' + d.port + ':' + d.source, 'attach:64769:desktop', 'the desktop station is attached when the default is dead');
  const named = c({ candidates: [{ source: 'flag', port: 9, reachable: false }] });
  A.eq(named.mode, 'refuse', 'a NAMED dead port is an error, never a spawn'); A.ok(/--port/.test(named.reason), 'and names the flag');
  const envNamed = c({ candidates: [{ source: 'env', port: 9, reachable: false }] });
  A.ok(envNamed.mode === 'refuse' && /STARNET_PORT/.test(envNamed.reason), 'an env-named dead port names STARNET_PORT');
  const owned = c({ candidates: [{ source: 'default', port: 8787, reachable: false }], desktop: { ownerAlive: true, ownerPid: 10436, port: 0 } });
  A.eq(owned.mode, 'refuse', 'a live desktop owner with an unknown port is never spawned over'); A.ok(/10436/.test(owned.reason), 'the refusal names the pid');
  const ownedOverride = c({ candidates: [{ source: 'default', port: 8787, reachable: false }], desktop: { ownerAlive: true, ownerPid: 10436, port: 0 }, workspaceOverride: true });
  A.eq(ownedOverride.mode, 'spawn', '…unless the operator picked another workspace');
  A.eq(c({ candidates: [{ source: 'default', port: 8787, reachable: false }], desktop: { ownerAlive: false } }).mode, 'spawn', 'nothing reachable, no live owner → spawn');
  A.eq(c({ candidates: [{ source: 'default', port: 8787, reachable: false }], noSpawn: true }).mode, 'refuse', '--no-spawn refuses');
  A.eq(c({ candidates: [{ source: 'default', port: 8787, reachable: true }], forceSpawn: true }).mode, 'spawn', '--spawn boots even when a station answers');
  A.eq(c({ forceSpawn: true, noSpawn: true }).mode, 'refuse', '--spawn + --no-spawn refuses');
  /* The desktop app's station while the app is CLOSED: its keys, bot tokens and credits token live in the OS keychain,
     which only the app hands its sidecar. A station the terminal boots there would be a keyless second copy of the real
     one (routines firing and failing, bots offline) — so `starnet` STARTS THE APP in the background (no window) and
     attaches to the station it brings up. The terminal never needs the app open. */
  const dead = [{ source: 'default', port: 8787, reachable: false }];
  const EXE = 'C:\\Users\\x\\AppData\\Local\\StarNet\\skynet-desktop.exe';
  const closedApp = c({ candidates: dead, desktop: { ownerAlive: false, station: true, appRan: true, appExe: EXE } });
  A.eq(closedApp.mode, 'launch-app', 'the desktop app\'s station with the app closed: start the app in the background, never refuse');
  A.eq(closedApp.exe, EXE, '…the app it found');
  const noApp = c({ candidates: dead, desktop: { ownerAlive: false, station: true, appRan: true, appExe: '' } });
  A.eq(noApp.mode, 'refuse', 'no app on this computer to start: refused, never booted keyless');
  A.ok(/app was not found/.test(noApp.reason) && /STARNET_APP_EXE/.test(noApp.reason) && /--workspace <dir>/.test(noApp.reason), '…and the reason says so, and the two ways on: ' + noApp.reason);
  const closedAsk = c({ candidates: dead, desktop: { ownerAlive: false, station: true, appRan: true, appExe: EXE }, noSpawn: true });
  A.eq(closedAsk.mode, 'refuse', '--no-spawn (a question: status, ls) never starts the app');
  A.ok(/isn't running/.test(closedAsk.reason) && /run `starnet` to start it/.test(closedAsk.reason) && !/open the StarNet app/i.test(closedAsk.reason), '…and says `starnet` starts it, never "open the app": ' + closedAsk.reason);
  A.eq(c({ candidates: dead, desktop: { ownerAlive: false, station: true, appRan: true, appExe: EXE }, workspaceOverride: true }).mode, 'spawn', '…a workspace the operator named still boots (headless use)');
  /* --spawn alone still targets that same workspace (defaultWorkspace picks the desktop station whenever it holds one), so
     it is the same keyless copy: refused, and the reason names both ways that work */
  const closedSpawn = c({ candidates: dead, desktop: { ownerAlive: false, station: true, appRan: true, appExe: EXE }, forceSpawn: true });
  A.eq(closedSpawn.mode, 'refuse', '…an explicit --spawn never boots the closed app\'s station keyless');
  A.ok(/plain `starnet`/.test(closedSpawn.reason) && /--workspace <dir>/.test(closedSpawn.reason) && !/open the StarNet app/i.test(closedSpawn.reason), '…and says plain starnet starts it with its keys, or name a --workspace: ' + closedSpawn.reason);
  A.eq(c({ candidates: dead, desktop: { ownerAlive: false, station: true, appRan: true }, forceSpawn: true, workspaceOverride: true }).mode, 'spawn', '--spawn --workspace <dir> still boots (headless use)');
  A.eq(c({ candidates: dead, desktop: { ownerAlive: false, station: true, appRan: false }, forceSpawn: true }).mode, 'spawn', '--spawn on a terminal-only station still boots');
  A.eq(c({ candidates: dead, desktop: { ownerAlive: false, station: true, appRan: false, appExe: EXE } }).mode, 'spawn', 'a station in that folder that no desktop app ever ran (a terminal-only one) still boots');
  A.eq(c({ candidates: dead, desktop: { ownerAlive: false, station: false, appRan: true, appExe: EXE } }).mode, 'spawn', 'no station there yet → the terminal may set one up (the awakening)');
  A.eq(c({ candidates: [{ source: 'default', port: 8787, reachable: true }], desktop: { ownerAlive: false, station: true, appRan: true, appExe: EXE } }).mode, 'attach', 'a reachable station still wins');
  A.eq(c({ candidates: [...dead, { source: 'desktop', port: 64769, reachable: true }], desktop: { ownerAlive: true, ownerPid: 10436, port: 64769, station: true, appRan: true, appExe: EXE } }).mode, 'attach', 'the app open: attach to it, nothing started');
}

// ---- the app's own path, from its startup.log -------------------------------------------------------------------
{
  const P = core.parseStartupExe;
  const win = 'startup exe=Ok("C:\\\\Users\\\\andro\\\\AppData\\\\Local\\\\StarNet\\\\skynet-desktop.exe") resource_dir=Ok("\\\\\\\\?\\\\C:\\\\Users\\\\andro\\\\AppData\\\\Local\\\\StarNet") root=C:\\Users\\andro\\AppData\\Local\\StarNet port=1';
  A.eq(P(win), 'C:\\Users\\andro\\AppData\\Local\\StarNet\\skynet-desktop.exe', 'Rust\'s Debug escaping is undone (\\\\ → \\), and resource_dir is not mistaken for it');
  A.eq(P('startup exe=Ok("/old/StarNet")\nspawn_sidecar pid=1 port=2 listening=true\nstartup exe=Ok("/Applications/StarNet.app/Contents/MacOS/skynet-desktop") port=3\n'), '/Applications/StarNet.app/Contents/MacOS/skynet-desktop', 'the LAST start wins');
  A.eq(P('startup exe=Ok("C:\\\\Users\\\\O\\\'Brien \\"x\\"\\\\caf\\u{e9}\\\\a.exe")'), 'C:\\Users\\O\'Brien "x"\\café\\a.exe', 'quotes, apostrophes and \\u{…} come back as written');
  A.eq(P('startup exe=Err(Os { code: 2 })'), '', 'a start that could not tell its own path gives none');
  A.eq(P(''), '', 'no log, no app');
  A.eq(P(null), '', 'null-safe');
}

// ---- what the app logged about this terminal (its --background start and every join, with the session's pid) ----
{
  const J = core.joinOutcome;
  // the exact lines src-tauri/src/main.rs writes (setup's start line; join_terminal_session's four outcomes)
  const started = 'startup: started by starnet (--background, terminal pid 4242) — the station runs with the app\'s keys; the window stays parked until someone opens StarNet';
  const joined = 'second-launch --background: starnet session pid 4242 joins the station the terminal started';
  const starting = 'second-launch --background: starnet session pid 4242 joins once StarNet has started';
  const closing = 'second-launch --background: starnet session pid 4242 arrived while StarNet is closing (its starnet sessions ended); start StarNet again once it has quit';
  const notTracked = 'second-launch --background: starnet session pid 4242: this StarNet is a person\'s or stays in the tray; a terminal ending never closes it';
  A.eq(J(started, 4242), 'started-for', 'the start line names the terminal it was started for');
  A.eq(J(joined, 4242), 'joined', 'a join it took');
  A.eq(J(starting, 4242), 'starting', 'a join that arrived while it was still starting (tracked once it has)');
  A.eq(J(closing, 4242), 'closing', 'a join that arrived while it closes: start it again');
  A.eq(J(notTracked, 4242), 'not-tracked', 'a person\'s StarNet, or one staying in the tray');
  A.eq(J(joined.replace('4242', '42420'), 4242), null, 'another pid (even one that starts with ours) is not ours');
  A.eq(J([started, closing].join('\n'), 4242), 'closing', 'the LAST line about the pid wins');
  A.eq(J([joined, 'close-request: close_to_tray=false', notTracked.replace('4242', '7')].join('\r\n'), 4242), 'joined', 'other pids\' lines and CRLF are ignored');
  A.eq(J('', 4242), null, 'an empty log says nothing');
  A.eq(J(null, 4242), null, 'null-safe');
  // the app still writes those words: rewording a line there would leave every join here unconfirmed
  const mainRs = require('fs').readFileSync(require('path').join(__dirname, '..', 'src-tauri', 'src', 'main.rs'), 'utf8');
  for (const line of [started, joined, starting, closing, notTracked]) {
    const shape = line.replace('4242', '{pid}').replace(/ — .*$/, '');
    A.ok(mainRs.indexOf(shape) >= 0, 'main.rs still writes: ' + shape);
  }
  // one number on both sides: the app's EXIT_START_CANCELLED is what the CLI reads as "you cancelled"
  const rs = require('fs').readFileSync(require('path').join(__dirname, '..', 'src-tauri', 'src', 'terminal_session.rs'), 'utf8');
  const rust = Number((/pub const EXIT_START_CANCELLED: i32 = (\d+);/.exec(rs) || [])[1]);
  A.eq(core.APP_EXIT_START_CANCELLED, rust, 'the CLI and the app agree on the cancelled-start exit code (' + rust + ')');
  A.ok(rust !== 0, 'and it is never 0, which is a hand-off');
}

// ---- discovery parsers --------------------------------------------------------------------------
{
  const netstat = [
    '', 'Active Connections', '', '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234',
    '  TCP    127.0.0.1:64769        0.0.0.0:0              LISTENING       10436',
    '  TCP    127.0.0.1:64770        127.0.0.1:64769        ESTABLISHED     10436',
    '  TCP    127.0.0.1:8787         0.0.0.0:0              LISTENING       555'
  ].join('\r\n');
  A.eq(core.parseListeningPort(netstat, 10436, 'win32'), 64769, 'windows netstat: the pid\'s LISTENING loopback port');
  A.eq(core.parseListeningPort(netstat, 555, 'win32'), 8787, 'windows netstat: another pid');
  A.eq(core.parseListeningPort(netstat, 999, 'win32'), 0, 'windows netstat: unknown pid → 0');
  A.eq(core.parseListeningPort(netstat, 10436, 'win32'), 64769, 'an ESTABLISHED row never counts as the listener');
  const lsof = [
    'COMMAND   PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'node    10436 andro   23u  IPv4 0x1a2b3c4d5e6f      0t0  TCP 127.0.0.1:64769 (LISTEN)'
  ].join('\n');
  A.eq(core.parseListeningPort(lsof, 10436, 'darwin'), 64769, 'lsof: the listening loopback port');
  A.eq(core.parseListeningPort(lsof, 1, 'darwin'), 0, 'lsof: unknown pid → 0');
  A.eq(core.parseListeningPort('', 10436, 'win32'), 0, 'empty output → 0');
  const logTxt = 'startup exe=...\nspawn_sidecar pid=1 port=2 listening=true\nother\nspawn_sidecar pid=10436 port=64769 listening=true\nwebview-browser-args: x\n';
  const rec = core.parseStartupLog(logTxt);
  A.eq(rec.pid + ':' + rec.port + ':' + rec.listening, '10436:64769:true', 'startup.log: the LAST spawn line wins');
  A.eq(core.parseStartupLog('nothing here'), null, 'startup.log without a spawn line → null');
}

// ---- pickAgent / buildRunBody -------------------------------------------------------------------
{
  const rt = { provider: 'openrouter', model: 'env/default', agents: [
    { agentId: 'researcher', name: 'NOVA', model: 'gpt-5', provider: 'codex' },
    { agentId: 'agent', name: 'ULTRON', model: 'anthropic/x', provider: 'openrouter' }
  ] };
  const d = core.pickAgent(rt, {});
  A.eq(d.agentId + '/' + d.model + '/' + d.provider, 'agent/anthropic/x/openrouter', 'default = the hero "agent", with its own model + provider');
  const first = core.pickAgent({ agents: [rt.agents[0]] }, {});
  A.eq(first.agentId, 'researcher', 'no hero → the first roster entry');
  const named = core.pickAgent(rt, { agent: 'researcher', model: 'gpt-6' });
  A.eq(named.name + '/' + named.model + '/' + named.provider, 'NOVA/gpt-6/codex', '--agent + --model override');
  const unknown = core.pickAgent(rt, { agent: 'ghost' });
  A.ok(!unknown.ok && /unknown agent "ghost"/.test(unknown.error) && /researcher, agent/.test(unknown.error), 'unknown agent lists the roster');
  const bare = core.pickAgent({ provider: 'openrouter', model: 'env/default', agents: [] }, {});
  A.eq(bare.agentId + '/' + bare.model, 'agent/env/default', 'an empty roster runs the bare agent on the station default model');
  const none = core.pickAgent({ agents: [{ agentId: 'agent', name: 'X', model: '', provider: 'openrouter' }] }, {});
  A.ok(!none.ok && /--model/.test(none.error), 'no model anywhere → an actionable error');
  // --provider names the provider the station's alias map knows (sidecar/providers/registry.js): `openai-codex` IS the
  // 'codex' the agent runs on, so it is no bare provider to refuse; an id the registry does not know is still refused
  const alias = core.pickAgent(rt, { agent: 'researcher', provider: 'openai-codex' });
  A.ok(alias.ok && alias.provider === 'codex' && alias.model === 'gpt-5', '--provider openai-codex is the codex the agent runs on: ' + JSON.stringify(alias));
  const aliasModel = core.pickAgent(rt, { agent: 'agent', provider: 'OR', model: 'x/y' });
  A.eq([aliasModel.provider, aliasModel.model], ['openrouter', 'x/y'], '--provider resolves its alias with --model too');
  const unknownProv = core.pickAgent(rt, { agent: 'researcher', provider: 'not-a-provider' });
  A.ok(!unknownProv.ok && /--provider "not-a-provider" is not a provider this station knows/.test(unknownProv.error), 'an unknown bare --provider is still refused: ' + JSON.stringify(unknownProv));
  // (review round 4) ...and so is an unknown --provider WITH --model: it was sent as typed, and the station's /api/run ran
  // it on openrouter with its own key (`starnet run --provider olama --model llama3` ran openrouter/llama3)
  for (const typo of ['olama', 'open-router', 'chatgpt']) {
    const sel = core.pickAgent(rt, { agent: 'researcher', provider: typo, model: 'llama3' });
    A.ok(!sel.ok && sel.error === '--provider "' + typo + '" is not a provider this station knows', '--provider ' + typo + ' --model llama3 is refused: ' + JSON.stringify(sel));
  }
  // the help says what --model / --provider really do (the run-wire rule), not "override the agent's provider"
  const help = core.USAGE;
  A.ok(!/override the agent's provider/.test(help) && /a provider alone names no/.test(help) && /--model <slug>\s+run this model instead of the agent's \(on the agent's provider unless --provider names one\)/.test(help),
    'the help text states the --model / --provider rule');
  const body = core.buildRunBody(d, 'do it', { cwd: '/proj' });
  A.eq(body.messages[0].role + ':' + body.messages[0].content, 'user:do it', 'one user message');
  A.eq(body.placed.map(p => p.objectType).join(','), 'computer,cabinet,workbench,dish,notebook', 'the headless coding office is placed');
  A.eq(body.projectRoot, '/proj', '--cwd rides as projectRoot');
  A.ok(!('projectRoot' in core.buildRunBody(d, 'x', {})), 'no cwd → no projectRoot');
}

// ---- the run tracker: what the stream proves ----------------------------------------------------
{
  const t = core.makeRunTracker();
  const acts = [];
  const feed = (name, payload) => { for (const a of t.feed({ name, payload })) acts.push(a); };
  feed('agent.run.start', { agentId: 'agent', runId: 'r1', trigger: 'user', model: 'm/1' });
  feed('agent.token', { agentId: 'agent', runId: 'r1', delta: 'PO' });
  feed('agent.tool_call', { agentId: 'agent', runId: 'r1', callId: 'c1', name: 'fs.read', argsSummary: 'notes.md' });
  feed('agent.tool_result', { agentId: 'agent', runId: 'r1', callId: 'c1', ok: true, ms: 12, summary: '3 lines' });
  feed('agent.cost', { agentId: 'agent', runId: 'r1', usd: 0.001, tokensIn: 100, tokensOut: 5, model: 'm/1' });
  feed('agent.token', { agentId: 'agent', runId: 'r1', delta: 'NG' });
  feed('permission.prompt', { promptId: 'p1', agentId: 'agent', tool: 'fs.write', scope: 'write', argsSummary: 'x' });
  feed('agent.run.end', { agentId: 'agent', runId: 'r1', reason: 'done', turns: 2, usd: 0.0042 });
  const s = t.summary();
  A.eq(s.text, 'PONG', 'text is exactly the joined token deltas');
  A.ok(s.ok && s.reason === 'done' && s.proven, 'done comes from agent.run.end');
  A.eq(s.runId + ':' + s.turns + ':' + s.usd, 'r1:2:0.0042', 'runId/turns/usd from the real events (run.end usd wins)');
  A.eq(s.tokens.in + ':' + s.tokens.out, '100:5', 'token counts from agent.cost');
  A.eq(s.toolCalls.length, 1, 'one tool call');
  A.eq(s.toolCalls[0].name + ':' + s.toolCalls[0].ok + ':' + s.toolCalls[0].ms + ':' + s.toolCalls[0].summary, 'fs.read:true:12:3 lines', 'the call and its result are paired by callId');
  A.eq(acts.filter(a => a.kind === 'text').map(a => a.delta).join(''), 'PONG', 'text actions mirror the deltas');
  A.ok(acts.some(a => a.kind === 'tool' && /⋯ fs\.read notes\.md/.test(a.line)), 'a terse tool line');
  A.ok(acts.some(a => a.kind === 'tool' && /↳ ok 12ms — 3 lines/.test(a.line)), 'a terse result line');
  A.ok(acts.some(a => a.kind === 'consent' && a.ev.promptId === 'p1'), 'a consent prompt is surfaced to the host');
  A.eq(core.exitCodeForReason(s.reason, { proven: s.proven }), 0, 'done → exit 0');

  // a stream that drops before agent.run.end is NEVER done
  const drop = core.makeRunTracker();
  drop.feed({ name: 'agent.run.start', payload: { runId: 'r2' } });
  drop.feed({ name: 'agent.token', payload: { delta: 'half an ans' } });
  const ds = drop.summary();
  A.ok(!ds.ok && ds.reason === 'error' && ds.proven === false, 'no terminal event → error, proven:false');
  A.eq(ds.text, 'half an ans', 'the partial text is still reported as what streamed');
  A.eq(core.exitCodeForReason(ds.reason, { proven: false }), 1, 'a dropped stream exits 1');

  // a cancel the CLI itself asked for settles as cancelled, not as a failure
  const c = core.makeRunTracker();
  c.feed({ name: 'agent.run.start', payload: { runId: 'r3' } });
  c.markCancel('timeout');
  const cs = c.summary();
  A.ok(cs.reason === 'cancelled' && cs.timedOut && !cs.proven, 'an unsettled stream after our own cancel → cancelled (timedOut flagged)');
  A.eq(core.exitCodeForReason('cancelled'), 4, 'cancelled → exit 4');
  // …but the station's own verdict wins when it arrives
  c.feed({ name: 'agent.run.end', payload: { runId: 'r3', reason: 'cancelled', turns: 1, usd: 0 } });
  A.ok(c.summary().proven && c.summary().reason === 'cancelled', 'the station\'s agent.run.end{cancelled} is the proven reason');

  // an unknown reason string never passes through as a claim
  const u = core.makeRunTracker();
  u.feed({ name: 'agent.run.end', payload: { reason: 'totally-made-up' } });
  A.eq(u.summary().reason, 'error', 'an out-of-contract reason is reported as error');
  // run.error is recorded
  const e = core.makeRunTracker();
  const ea = e.feed({ name: 'agent.run.error', payload: { message: 'boom', transient: false } });
  A.ok(ea.some(a => a.kind === 'note' && /boom/.test(a.line)) && e.summary().errors[0] === 'boom', 'agent.run.error is surfaced and kept');
  // budget stop carries the scope
  const b = core.makeRunTracker();
  b.feed({ name: 'agent.run.end', payload: { reason: 'budget', turns: 3, usd: 1, budgetScope: 'run', budgetCapUsd: 1 } });
  A.eq(b.summary().budgetScope + ':' + b.summary().budgetCapUsd, 'run:1', 'a budget stop names its cap');
  A.eq(core.exitCodeForReason('budget'), 5, 'budget → exit 5 (stopped early)');
  A.eq(core.exitCodeForReason('refusal'), 5, 'refusal → exit 5');
  A.eq(core.exitCodeForReason('error'), 1, 'error → exit 1');
  A.eq(core.exitCodeForReason('max_iters'), 5, 'max_iters → exit 5');
  A.ok(core.RUN_STOP_REASONS.indexOf('done') >= 0 && core.RUN_STOP_REASONS.indexOf('clarifying') >= 0, 'the reason enum mirrors shared/events.js');
}

// ---- bootstrap docs ----------------------------------------------------------------------------
{
  const d = core.bootstrapDocs({ name: 'ATLAS', model: 'anthropic/claude-haiku-4.5', provider: 'openrouter', now: 1700000000123 });
  A.eq(d.roster.version, 1, 'roster envelope version 1');
  A.eq(d.roster.agents.length, 1, 'exactly one agent');
  const a = d.roster.agents[0];
  A.eq(a.agentId + ':' + a.name + ':' + a.model + ':' + a.provider, 'agent:ATLAS:anthropic/claude-haiku-4.5:openrouter', 'the hero id is "agent"');
  A.eq(a.approvalMode, 'full', 'FULL POWER from minute one — no consent gate for the bootstrapped agent');
  A.ok(/ATLAS/.test(a.system), 'the system prompt names the agent');
  A.eq(d.save.agentId + ':' + d.save.version, 'agent:1', 'save envelope');
  A.eq(d.save.doc.schema + ':' + d.save.doc.version, 'starnet.save:5', 'the save doc is the schema the desktop resumes');
  A.eq(d.save.doc.agent.id + ':' + d.save.doc.agent.name + ':' + d.save.doc.agent.model, 'agent:ATLAS:anthropic/claude-haiku-4.5', 'save.agent mirrors the roster');
  A.eq(d.save.doc.prov, 'openrouter', 'the provider rides doc.prov (the desktop restores it before the credential check)');
  A.eq(d.save.updatedAt + ':' + d.save.doc.updatedAt, '1700000000123:1700000000123', 'timestamps come from the injected clock');
  A.ok(Array.isArray(d.save.doc.agents) && d.save.doc.station === null && d.save.doc.workstreams.length === 0, 'the rest of the golden shape is present');
  // the recovery gate must see these as a REAL station, never as an empty root to recover into: either file is proof of a
  // station to the station record (P1: whatever a record says) and to its frozen fallback
  const proof = name => StationRecord._internals.HARD_PROOF.test(name) && StationRecord.STATE_EVIDENCE.test(name);
  A.ok(proof('agent.save.json') && proof('agent.roster.json'), 'both bootstrap files are proof of a station to the station record');
  const long = core.bootstrapDocs({ name: 'X'.repeat(80) });
  A.eq(long.roster.agents[0].name.length, 40, 'names are clipped to the roster limit');
}

// ---- inferProvider ------------------------------------------------------------------------------
{
  const profiles = [
    { id: 'openrouter', keyEnv: ['OPENROUTER_KEY', 'OPENROUTER_API_KEY'] },
    { id: 'openai', keyEnv: ['OPENAI_API_KEY'] },
    { id: 'anthropic', keyEnv: ['ANTHROPIC_API_KEY'] }
  ];
  A.eq(core.inferProvider({ env: {}, profiles }).provider, '', 'nothing set → no provider');
  A.eq(core.inferProvider({ env: { ANTHROPIC_API_KEY: 'k' }, profiles }).provider, 'anthropic', 'a bare key env');
  A.eq(core.inferProvider({ env: { STARNET_OPENROUTER_KEY: 'k' }, profiles }).provider, 'openrouter', 'STARNET_-scoped');
  A.eq(core.inferProvider({ env: { SKYNET_OPENAI_API_KEY: 'k' }, profiles }).provider, 'openai', 'SKYNET_-scoped legacy');
  A.eq(core.inferProvider({ env: { OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }, profiles }).provider, 'openai', 'registry order decides ties');
  A.eq(core.inferProvider({ env: {}, profiles, codexTokensPresent: true }).provider, 'codex', 'a stored ChatGPT sign-in counts');
  A.eq(core.inferProvider({ env: { OPENAI_API_KEY: 'k' }, profiles, explicit: 'gemini' }).provider, 'gemini', '--provider wins');
  A.eq(core.inferProvider({ env: { OPENAI_API_KEY: '   ' }, profiles }).provider, '', 'a blank value is not a credential');
}

// ---- jsonResult / splitNdjson -------------------------------------------------------------------
{
  const t = core.makeRunTracker();
  t.feed({ name: 'agent.run.start', payload: { runId: 'r9', model: 'm' } });
  t.feed({ name: 'agent.token', payload: { delta: 'ok' } });
  t.feed({ name: 'agent.run.end', payload: { reason: 'done', turns: 1, usd: 0.5 } });
  const j = core.jsonResult(t.summary(), { agentId: 'agent', agentName: 'X', provider: 'openrouter', baseUrl: 'http://127.0.0.1:1', mode: 'attached', workspace: null, version: 'v1', startedAt: 10, endedAt: 25 });
  for (const k of ['ok', 'reason', 'proven', 'exitCode', 'text', 'runId', 'agentId', 'agentName', 'model', 'provider', 'station', 'usd', 'turns', 'tokens', 'toolCalls', 'errors', 'timedOut', 'startedAt', 'endedAt', 'durationMs']) A.ok(k in j, 'receipt carries ' + k);
  A.eq(j.exitCode + ':' + j.durationMs + ':' + j.station.mode + ':' + j.text, '0:15:attached:ok', 'receipt values');
  const sp = core.splitNdjson('{"a":1}\r\n\n{"b":2}\n{"c"');
  A.eq(sp.lines.length + ':' + sp.rest, '2:{"c"', 'ndjson split keeps the partial tail and drops keep-alive blanks');
}

A.report('cli.test');
