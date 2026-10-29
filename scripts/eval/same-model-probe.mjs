#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { allocatePort } from '../../test/helpers/ports.js';

function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[String(argv[i] || '').replace(/^--/, '')] = argv[i + 1];
  return out;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitHealth(base, child) {
  const start = performance.now();
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode != null) throw new Error(`StarNet sidecar exited ${child.exitCode} before health`);
    try {
      const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
      if (response.ok) return { bootMs: performance.now() - start, body: await response.json() };
    } catch (_) {}
    await sleep(100);
  }
  throw new Error('StarNet sidecar health timeout');
}

async function starnetProbe(opts, prompt, model) {
  const root = resolve(opts.starnetRoot), workspaces = resolve(opts.starnetHome);
  // the OS picks the port (test/helpers/ports.js): 19000 + pid % 1000 can land on a reserved or a taken port
  const port = await allocatePort(), base = `http://127.0.0.1:${port}`;
  const bearer = randomBytes(32).toString('hex');
  const out = createWriteStream(resolve(opts.outputDir, 'same-model-starnet.out.log'));
  const err = createWriteStream(resolve(opts.outputDir, 'same-model-starnet.err.log'));
  const child = spawn(join(root, 'node.exe'), [join(root, 'sidecar', 'index.js')], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {
      STARNET_WORKSPACES: workspaces, STARNET_PORT: String(port), STARNET_API_KEY: bearer,
      STARNET_DEFAULT_MODEL: model, STARNET_FULL_ACCESS: '1', SKYNET_FULL_ACCESS: '1',
      STARNET_CRON_ARMED: '0', SKYNET_CRON_ARMED: '0'
    })
  });
  child.stdout.pipe(out); child.stderr.pipe(err);
  try {
    const health = await waitHealth(base, child);
    const modelsResponse = await fetch(base + '/v1/models', { headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(5000) });
    const models = await modelsResponse.json();
    const agent = ((models && models.data) || []).find(row => row && row.id !== 'starnet-agent') || {};
    const started = performance.now(); let firstTokenMs = null, text = '', usage = null, terminal = false;
    const response = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: agent.id || 'starnet-agent', stream: true, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(600000)
    });
    const reader = response.body && response.body.getReader();
    const decoder = new TextDecoder(); let buffer = '';
    while (reader) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        for (const line of block.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim(); if (raw === '[DONE]') { terminal = true; continue; }
          let payload; try { payload = JSON.parse(raw); } catch (_) { continue; }
          const delta = payload.choices && payload.choices[0] && payload.choices[0].delta && payload.choices[0].delta.content;
          if (delta) { if (firstTokenMs == null) firstTokenMs = performance.now() - started; text += delta; }
          if (payload.usage) usage = payload.usage;
        }
      }
    }
    return { ok: response.ok && terminal && text.trim().length > 0, status: response.status, agentId: agent.id || '', model: agent.root || '',
      provider: 'openai-codex',
      text: text.trim(), bootMs: health.bootMs, firstTokenMs, totalMs: performance.now() - started, usage, health: health.body };
  } finally {
    try { child.kill(); } catch (_) {}
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000)]);
    out.end(); err.end();
  }
}

async function hermesProbe(opts, prompt, model) {
  const source = resolve(opts.hermesSource), python = resolve(opts.hermesPython), home = resolve(opts.hermesHome);
  const usageFile = resolve(opts.outputDir, 'same-model-hermes-usage.json');
  const started = performance.now(); let firstTokenMs = null, stdout = '', stderr = '';
  const child = spawn(python, ['-m', 'hermes_cli.main', '--ignore-rules', '--provider', 'openai-codex', '--model', model,
    '--usage-file', usageFile, '--oneshot', prompt], {
    cwd: source, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { HERMES_HOME: home })
  });
  child.stdout.on('data', chunk => { if (firstTokenMs == null) firstTokenMs = performance.now() - started; stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { try { child.kill(); } catch (_) {} reject(new Error('Hermes probe timeout')); }, 600000);
    child.once('exit', code => { clearTimeout(timeout); resolve(code); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  let usage = null; try { usage = JSON.parse(readFileSync(usageFile, 'utf8')); } catch (_) {}
  const text = stdout.trim();
  return { ok: exitCode === 0 && text.length > 0, exitCode, model, provider: 'openai-codex', text,
    firstOutputMs: firstTokenMs, totalMs: performance.now() - started, usage,
    error: exitCode === 0 ? '' : stderr.trim().slice(0, 500) };
}

const opts = argsOf(process.argv.slice(2));
for (const key of ['starnetRoot', 'starnetHome', 'hermesSource', 'hermesPython', 'hermesHome', 'output']) if (!opts[key]) throw new Error(`missing --${key}`);
opts.outputDir = resolve(opts.outputDir || '.dogfood/eval'); mkdirSync(opts.outputDir, { recursive: true });
const prompt = 'Return exactly PARITY-PROBE-731 and no other text.';
const model = String(opts.model || 'gpt-5.6-sol');
const result = { schemaVersion: 'starnet.eval.same-model-probe.v1', generatedAt: new Date().toISOString(), prompt, comparisonModel: model,
  starnet: await starnetProbe(opts, prompt, model), hermes: await hermesProbe(opts, prompt, model) };
result.sameModel = result.starnet.model === result.hermes.model && result.starnet.provider === result.hermes.provider;
result.pass = result.sameModel && result.starnet.ok && result.hermes.ok && result.starnet.text === 'PARITY-PROBE-731' && result.hermes.text === 'PARITY-PROBE-731';
writeFileSync(resolve(opts.output), JSON.stringify(result, null, 2) + '\n', 'utf8');
console.log(`[agent-eval] SAME MODEL ${result.pass ? 'PASS' : 'FAIL'} StarNet=${result.starnet.provider}/${result.starnet.model} Hermes=${result.hermes.provider}/${result.hermes.model}`);
console.log(`[agent-eval] probe ${resolve(opts.output)}`);
process.exitCode = result.pass ? 0 : 1;
