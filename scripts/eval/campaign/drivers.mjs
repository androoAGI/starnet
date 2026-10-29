import { createHash } from 'node:crypto';
import { createWriteStream, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn, spawnSync } from 'node:child_process';
import { spawnAcpClient } from './acp-client.mjs';
import { observeFixture } from './fixture-host.mjs';
import { allocatePort } from '../../../test/helpers/ports.js';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const MODEL = 'gpt-5.6-luna';
const PROVIDER = 'openai-codex';
const CONNECTOR_ID = 'parity_fixture_eval';
const CAMPAIGN_CONTROL = 'PARITY CAMPAIGN CONTROL: The authoritative fixture tool is present in this turn. Your first action MUST be a tool call to fixture_inspect (Hermes name: mcp__parity_fixture_eval__fixture_inspect) with an empty object. Do not answer that it is unavailable and do not answer before making that call. Work only through parity_fixture_eval MCP tools; do not use native terminal, file, browser, memory, or delegation tools. Verify every mutation through the fixture host and base the final answer only on host results.';

function submittedPrompt(fixturePrompt) {
  return `${CAMPAIGN_CONTROL}\n\nTASK:\n${fixturePrompt}`;
}

function promptSha256(prompt) {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

async function terminateChild(child, opts = {}) {
  if (!child || child.exitCode != null) return;
  if (process.platform === 'win32' && opts.gracefulWindow && Number.isInteger(child.pid)) {
    const script = `$p=Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue;if($p){$null=$p.CloseMainWindow()}`;
    spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    await Promise.race([new Promise(done => child.once('exit', done)), sleep(5000)]);
    if (child.exitCode != null) return;
  }
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
  } else {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
  await Promise.race([new Promise(done => child.once('exit', done)), sleep(3000)]);
}

async function waitHealth(base, child) {
  for (let attempt = 0; attempt < 180; attempt++) {
    if (child.exitCode != null) throw new Error(`StarNet process exited ${child.exitCode} before health`);
    try { const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) }); if (response.ok) return response.json(); } catch (_) {}
    await sleep(100);
  }
  throw new Error('StarNet sidecar health timeout');
}

export function installedDesktopStartupLog(workspaces) {
  return join(dirname(resolve(workspaces)), 'startup.log');
}

export function desktopStartupLogMark(file) {
  try { return statSync(resolve(file)).size; } catch (_) { return 0; }
}

export async function waitInstalledDesktopPort({ startupLog, afterBytes = 0, child, timeoutMs = 30000 }) {
  const started = performance.now(), file = resolve(startupLog);
  while (performance.now() - started < timeoutMs) {
    if (child.exitCode != null) throw new Error(`installed desktop exited ${child.exitCode} before publishing its sidecar port`);
    try {
      const body = readFileSync(file), offset = body.length >= afterBytes ? afterBytes : 0, fresh = body.subarray(offset).toString('utf8');
      const starts = Array.from(fresh.matchAll(/startup exe=.*? port=(\d+)/g));
      const port = Number(starts.at(-1)?.[1] || 0);
      if (port && new RegExp(`spawn_sidecar pid=\\d+ port=${port} listening=true`).test(fresh)) return port;
    } catch (_) {}
    await sleep(100);
  }
  throw new Error(`installed desktop did not publish a listening sidecar port within ${timeoutMs}ms`);
}

async function discoverToken(base) {
  const response = await fetch(base + '/', { signal: AbortSignal.timeout(5000) });
  const html = await response.text(), match = html.match(/window\.__STARNET_API_TOKEN__=("(?:\\.|[^"])*")/);
  if (!match) throw new Error('installed StarNet API token could not be discovered');
  return JSON.parse(match[1]);
}

async function api(base, token, path, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-StarNet-Token': token, Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000)
  });
  const text = await response.text(); let value = null; try { value = JSON.parse(text); } catch (_) { value = { text }; }
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${text.slice(0, 500)}`);
  return value;
}

async function readStarNetRun(response, base, token) {
  if (!response.ok) throw new Error(`StarNet run HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', finalText = '', firstOutputMs = null, runId = '', end = null;
  const events = [], started = performance.now();
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, boundary).trim(); buffer = buffer.slice(boundary + 1);
      if (!line) continue;
      let event; try { event = JSON.parse(line); } catch (_) { continue; }
      events.push(event);
      if (event.name === 'agent.run.start') runId = String(event.payload?.runId || '');
      if (event.name === 'agent.token') {
        if (firstOutputMs == null) firstOutputMs = performance.now() - started;
        finalText += String(event.payload?.delta || '');
      }
      if (event.name === 'permission.prompt') {
        await api(base, token, '/api/consent', { runId, promptId: event.payload?.promptId, decision: 'once' });
      }
      if (event.name === 'agent.run.end') end = event.payload || {};
    }
  }
  return { runId, finalText: finalText.trim(), events, firstOutputMs, totalMs: performance.now() - started, end };
}

export async function startStarNetDriver(opts) {
  const root = resolve(opts.root), workspaces = resolve(opts.workspaces), fixtureUrl = String(opts.fixtureUrl);
  const runTimeoutMs = Number(opts.timeoutMs || 300000);
  // an explicit --port wins; otherwise the OS picks one (test/helpers/ports.js): 19200 + pid % 600 was a guess that
  // can land on a Windows-reserved port or on a parallel run's sidecar. The desktop build reports its own port below.
  let port = Number(opts.port) || await allocatePort();
  const stdout = createWriteStream(resolve(opts.outputDir, 'campaign-starnet.out.log'), { flags: 'a' });
  const stderr = createWriteStream(resolve(opts.outputDir, 'campaign-starnet.err.log'), { flags: 'a' });
  const desktopExecutable = opts.desktopExecutable ? resolve(opts.desktopExecutable) : null;
  const command = desktopExecutable || join(root, 'node.exe');
  const args = desktopExecutable ? [] : [join(root, 'sidecar', 'index.js')];
  const startupLog = desktopExecutable ? installedDesktopStartupLog(workspaces) : null;
  const startupMark = startupLog ? desktopStartupLogMark(startupLog) : 0;
  const env = Object.assign({}, process.env, {
    STARNET_WORKSPACES: workspaces, STARNET_DEFAULT_MODEL: MODEL,
    STARNET_FULL_ACCESS: '1', SKYNET_FULL_ACCESS: '1', STARNET_CRON_ARMED: '0', SKYNET_CRON_ARMED: '0'
  });
  if (!desktopExecutable) env.STARNET_PORT = String(port);
  const child = spawn(command, args, {
    cwd: desktopExecutable ? dirname(desktopExecutable) : root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env
  });
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  if (desktopExecutable) port = await waitInstalledDesktopPort({ startupLog, afterBytes: startupMark, child, timeoutMs: Math.min(runTimeoutMs, 60000) });
  const base = `http://127.0.0.1:${port}`;
  const health = await waitHealth(base, child), token = await discoverToken(base);
  try { await api(base, token, '/api/connectors/remove', { id: CONNECTOR_ID }); } catch (_) {}
  const configured = await api(base, token, '/api/connectors', { id: CONNECTOR_ID, label: 'Parity fixture host', transport: 'http', url: fixtureUrl, enabled: true, timeoutMs: 120000 });
  if (!configured.connected) throw new Error('StarNet fixture connector did not connect: ' + JSON.stringify(configured).slice(0, 500));

  return {
    process: child, base,
    identity: { harness: 'starnet', mode: desktopExecutable ? 'installed-desktop' : 'installed-runtime', model: MODEL, provider: PROVIDER, health },
    async run({ fixture, state, root: fixtureRoot, attempt }) {
      const startedAt = new Date().toISOString(), prompt = submittedPrompt(fixture.prompt);
      const response = await fetch(base + '/api/run', {
        method: 'POST', headers: { 'X-StarNet-Token': token, Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL, provider: PROVIDER, agentId: 'agent', isTask: true, projectRoot: resolve(fixtureRoot),
          system: 'Execute the parity fixture through its authoritative parity_fixture_eval tools. Inspect before acting, use host results as truth, verify mutations, and never claim success after a tool failure.',
          messages: [{ role: 'user', content: prompt }],
          placed: [{ objectType: 'connector', connectorId: CONNECTOR_ID }]
        }), signal: AbortSignal.timeout(runTimeoutMs)
      });
      const run = await readStarNetRun(response, base, token), endedAt = new Date().toISOString();
      const host = observeFixture(state, run.finalText, { sessionId: run.runId, agentId: 'agent' });
      return {
        schemaVersion: 'starnet.eval.trajectory.v1', taskId: fixture.taskId, attempt, runId: run.runId,
        startedAt, endedAt, finalText: run.finalText, events: run.events.map((event, index) => ({ seq: index + 1, at: endedAt, type: event.name, data: event.payload || {} })),
        observation: host.observation, routing: host.routing, artifacts: host.artifacts,
        metrics: { firstOutputMs: run.firstOutputMs, totalMs: run.totalMs, model: MODEL, provider: PROVIDER, stopReason: run.end?.reason || '', submittedPromptSha256: promptSha256(prompt) },
        hostEvidence: { fixtureCalls: host.calls }
      };
    },
    async close() {
      try { await api(base, token, '/api/connectors/remove', { id: CONNECTOR_ID }); } catch (_) {}
      await terminateChild(child, { gracefulWindow: !!desktopExecutable });
      stdout.end(); stderr.end();
    }
  };
}

function hermesPermission(_method, params) {
  const options = Array.isArray(params?.options) ? params.options : [];
  const once = options.find(row => row.optionId === 'once' || row.optionId === 'allow_once');
  return once?.optionId || options.find(row => /allow|approve/i.test(String(row.name || row.optionId || '')))?.optionId || null;
}

export async function startHermesDriver(opts) {
  const python = resolve(opts.python), source = resolve(opts.source), home = resolve(opts.home), fixtureUrl = String(opts.fixtureUrl);
  const runTimeoutMs = Number(opts.timeoutMs || 300000);
  const client = spawnAcpClient({
    command: python, args: ['-m', 'acp_adapter.entry'], cwd: source,
    env: { HERMES_HOME: home, HERMES_ACP_SKIP_CONFIGURED_MCP: '1' }, permission: hermesPermission, timeoutMs: runTimeoutMs
  });
  const init = await client.initialize('starnet-wave-b-parity');
  return {
    identity: { harness: 'hermes', model: MODEL, provider: PROVIDER, agentInfo: init.agentInfo },
    async run({ fixture, state, root: fixtureRoot, attempt }) {
      const startedAt = new Date().toISOString(), prompt = submittedPrompt(fixture.prompt);
      const session = await client.newSession(resolve(fixtureRoot), [{ type: 'http', name: 'parity_fixture_eval', url: fixtureUrl, headers: [] }]);
      const activeModel = String(session.models?.currentModelId || session.modelState?.currentModelId || '');
      if (activeModel && !activeModel.endsWith(`:${MODEL}`) && activeModel !== MODEL) throw new Error(`Hermes session model drifted: ${activeModel}`);
      const run = await client.prompt(session.sessionId, prompt, runTimeoutMs), endedAt = new Date().toISOString();
      const host = observeFixture(state, run.text, { sessionId: session.sessionId, agentId: 'agent' });
      return {
        schemaVersion: 'starnet.eval.trajectory.v1', taskId: fixture.taskId, attempt, runId: session.sessionId,
        startedAt, endedAt, finalText: run.text,
        events: run.updates.map((update, index) => ({ seq: index + 1, at: endedAt, type: `acp.${update.sessionUpdate || 'update'}`, data: update })),
        observation: host.observation, routing: host.routing, artifacts: host.artifacts,
        metrics: { totalMs: run.totalMs, model: MODEL, provider: PROVIDER, stopReason: run.result?.stopReason || '', submittedPromptSha256: promptSha256(prompt) },
        hostEvidence: { fixtureCalls: host.calls }
      };
    },
    async close() { await terminateChild(client.child); }
  };
}
