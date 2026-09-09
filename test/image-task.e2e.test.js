/* Real sidecar regression for STUDIO routing and artifact-backed completion.
   All provider/image responses are local mocks; no external key or account is used. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function sse(res, chunks, finishReason) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const delta of chunks) res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason || 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

function startProvider() {
  const requests = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }));
      }
      if (!req.url.includes('/chat/completions')) { res.writeHead(404); return res.end(); }
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch (_) {}
        requests.push({ body, authorization: String(req.headers.authorization || '') });
        if (Array.isArray(body.modalities) && body.modalities.includes('image')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,' + PNG_B64 } }] } }] }));
        }
        const blob = JSON.stringify(body.messages || []);
        if (blob.includes('ORDINARY_TEXT')) return sse(res, [{ content: 'The requested text or code explanation is complete.' }]);
        if (blob.includes('IMAGE_FALSE_DONE')) return sse(res, [{ content: 'Done - here is your image.' }]);
        const hasToolResult = (body.messages || []).some(m => m && m.role === 'tool');
        if (!hasToolResult) {
          return sse(res, [{ tool_calls: [{ index: 0, id: 'make_image', type: 'function', function: { name: 'image_generate', arguments: JSON.stringify({ prompt: 'a blue cube' }) } }] }], 'tool_calls');
        }
        return sse(res, [{ content: 'The image was generated and saved.' }]);
      });
    });
    server.listen(0, HOST, () => resolve({ server, requests, baseUrl: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function boot(port, env, attempts) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const onData = d => {
      output += d.toString();
      if (!settled && output.includes('http://' + HOST + ':' + port)) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(output)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attempts > 0) resolve(boot(port + 1, env, attempts - 1)); else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + output)); } }, 9000);
  });
}

async function run(base, token, body) {
  const res = await fetch(base + '/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: base }, body: JSON.stringify(body)
  });
  A.eq(res.status, 200, 'image task run streams');
  return (await res.text()).split('\n').map(s => s.trim()).filter(Boolean).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
}

(async () => {
  const provider = await startProvider();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-image-task-e2e-'));
  const noOpenRouterKey = { STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '', OPENROUTER_KEY: '', OPENROUTER_API_KEY: '' };
  const env = Object.assign({}, noOpenRouterKey, {
    SKYNET_WORKSPACES: workspace,
    STARNET_OPENROUTER_BASE: provider.baseUrl,
    SKYNET_FULL_ACCESS: '1',
    SKYNET_AUX_BUDGET: '0'
  });
  const { child, port } = await boot(8870 + (process.pid % 40), env, 20);
  const base = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(base, base);

    // Reproduction: a valid configured custom-model key cannot authorize STUDIO's OpenRouter wire.
    const beforeBlocked = provider.requests.length;
    const blocked = await run(base, token, {
      provider: 'custom', baseUrl: provider.baseUrl, key: 'custom-model-key', model: 'test/model',
      agentId: 'image-blocked', isTask: true, placed: ['studio'],
      messages: [{ role: 'user', content: 'Create an image of a red cube' }]
    });
    const blockedError = blocked.find(e => e.name === 'agent.run.error');
    A.ok(blockedError && /for custom \/ test\/model/.test(blockedError.payload.message), 'configured model/key mismatch surfaces the exact STUDIO blocker');
    A.ok(/link this station/.test(blockedError.payload.message), 'the blocker tells the user exactly how to authorize generation');
    A.eq(provider.requests.length, beforeBlocked, 'an impossible route never calls the configured model or a fallback');
    A.eq(blocked.filter(e => e.name === 'agent.run.end').pop().payload.reason, 'error', 'the impossible route ends error, never OK');

    // False image matches must reach the configured conversation model, without
    // requiring either STUDIO gear or a media credential, and may finish as text.
    for (const placed of [[], ['studio']]) {
      for (const prompt of [
        'Draw a distinction between TCP and UDP',
        'Illustrate your reasoning with a text example',
        'Create a Docker image for this Node app',
        'Make the profile picture clickable',
        'Explain how image generators create pictures'
      ]) {
        const before = provider.requests.length;
        const events = await run(base, token, {
          provider: 'custom', baseUrl: provider.baseUrl, key: 'custom-model-key', model: 'test/model',
          agentId: 'ordinary-' + before, isTask: true, placed,
          messages: [{ role: 'user', content: prompt + '. ORDINARY_TEXT' }]
        });
        A.ok(provider.requests.length > before, 'ordinary request reaches its model: ' + prompt);
        A.ok(!events.some(e => e.name === 'agent.run.error'), 'ordinary request has no image blocker/completion error: ' + prompt);
        A.eq(events.filter(e => e.name === 'agent.run.end').pop().payload.reason, 'done', 'text-only completion is accepted: ' + prompt);
        A.ok(!provider.requests.slice(before).some(r => Array.isArray(r.body.modalities) && r.body.modalities.includes('image')), 'ordinary request does not invoke image generation');
      }
    }

    // A compatible route that returns success prose but never invokes STUDIO is also not completion.
    const falseDone = await run(base, token, {
      provider: 'openrouter', key: 'openrouter-run-key', model: 'test/model',
      agentId: 'image-false-done', isTask: true, placed: ['studio'],
      messages: [{ role: 'user', content: 'Create an image of a green cube. IMAGE_FALSE_DONE' }]
    });
    A.ok(falseDone.some(e => e.name === 'agent.run.error' && /without a produced image artifact/.test(e.payload.message)), 'prose-only success emits the missing-artifact error');
    A.eq(falseDone.filter(e => e.name === 'agent.run.end').pop().payload.reason, 'error', 'prose-only image completion is terminal error');

    // The same configured OpenRouter key routes the tool call, writes the file, and earns done.
    const produced = await run(base, token, {
      provider: 'openrouter', key: 'openrouter-run-key', model: 'test/model',
      agentId: 'image-produced', isTask: true, placed: ['studio'],
      messages: [{ role: 'user', content: 'Generate an image of a blue cube. IMAGE_PRODUCE' }]
    });
    A.ok(produced.some(e => e.name === 'agent.tool_result' && e.payload.callId === 'make_image' && e.payload.ok), 'the compatible route executes image_generate successfully');
    A.eq(produced.filter(e => e.name === 'agent.run.end').pop().payload.reason, 'done', 'a produced image artifact earns done');
    const generationCall = provider.requests.find(r => Array.isArray(r.body.modalities) && r.body.modalities.includes('image'));
    A.eq(generationCall && generationCall.authorization, 'Bearer openrouter-run-key', 'STUDIO used the configured OpenRouter run key');
    A.ok(fs.readdirSync(path.join(workspace, 'image-produced', 'images')).some(name => /^gen-.*\.png$/.test(name)), 'the done run has a real saved PNG artifact');
  } finally {
    try { child.kill(); } catch (_) {}
    await new Promise(resolve => provider.server.close(resolve));
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('image-task.e2e.test');
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
