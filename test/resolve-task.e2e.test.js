/* Real sidecar regression for the STUDIO's DaVinci Resolve tools (tools/builtin/resolve.js).
   A local mock model drives the real run path: the tools must be ADVERTISED to an agent standing at a studio (and
   to nobody else — object = capability), resolve_timeline_file must write a real FCPXML into the agent's workspace,
   and resolve_status must answer honestly on a machine with no Resolve. No external key, account, or Resolve install. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function sse(res, chunks, finishReason) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const delta of chunks) res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason || 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
const call = (id, name, args) => [{ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }];

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
        requests.push(body);
        const msgs = body.messages || [];
        const toolResults = msgs.filter(m => m && m.role === 'tool').length;
        const blob = JSON.stringify(msgs);
        if (blob.includes('NO_STUDIO')) return sse(res, [{ content: 'No edit bay here.' }]);
        if (toolResults === 0) {
          return sse(res, call('cut', 'resolve_timeline_file', { name: 'E2E Cut', fps: 29.97, clips: [
            { path: 'clips/a.mp4', in: 1, out: 4 }, { path: 'clips/a.mp4', in: 0, out: 2, lane: 1, at: 1 }], markers: [{ at: 0.5, name: 'Open' }] }), 'tool_calls');
        }
        if (toolResults === 1) return sse(res, call('status', 'resolve_status', {}), 'tool_calls');
        return sse(res, [{ content: 'Timeline written.' }]);
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
      else if (!settled && BIND_REFUSED.test(output)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attempts > 0) resolve(allocatePort().then(next => boot(next, env, attempts - 1))); else reject(new Error('no free port'));
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
  A.eq(res.status, 200, 'run streams');
  return (await res.text()).split('\n').map(s => s.trim()).filter(Boolean).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
}
const toolNames = req => ((req && req.tools) || []).map(t => (t.function && t.function.name) || t.name);

(async () => {
  const provider = await startProvider();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-resolve-e2e-'));
  fs.mkdirSync(path.join(workspace, 'editor', 'clips'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'editor', 'clips', 'a.mp4'), 'not really video');   // ffprobe refuses it -> honest note
  const env = { SKYNET_WORKSPACES: workspace, SKYNET_FULL_ACCESS: '1', SKYNET_AUX_BUDGET: '0', STARNET_OPENROUTER_KEY: '', OPENROUTER_API_KEY: '' };
  const { child, port } = await boot(await allocatePort(), env, 20);
  const base = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(base, base);

    // object = capability: the Resolve tools ride EXACTLY the studio gate image_generate rides — never apart from it.
    const before = provider.requests.length;
    await run(base, token, { provider: 'custom', baseUrl: provider.baseUrl, key: 'k', model: 'test/model', agentId: 'bare', isTask: true, placed: [],
      messages: [{ role: 'user', content: 'Cut my footage into a timeline. NO_STUDIO' }] });
    // Coupled to the studio GRANT, not to image_generate's presence on the wire: image_generate is deferred as certainly
    // unavailable when there is no image connection (this sidecar has no key), while the Resolve tools need none.
    const RESOLVE = ['resolve_timeline_file', 'resolve_status', 'resolve_control'];
    const resolveOn = r => RESOLVE.map(t => toolNames(r).includes(t));
    const coupled = r => { const s = resolveOn(r); return s.every(Boolean) || s.every(x => !x); };   // the family rides together
    // The studio grant is visible per request as image_generate on the wire OR named in the "CANNOT work right now" line
    // (deferred: no image connection). Full Power (this sidecar) grants the studio family even with nothing placed.
    const studioGranted = r => toolNames(r).includes('image_generate') || JSON.stringify(r.messages || []).includes('image_generate — ');
    A.ok(provider.requests.slice(before).every(r => (studioGranted(r) ? resolveOn(r).every(Boolean) : resolveOn(r).every(x => !x))),
      'Resolve tools appear iff the studio grant does (advertised or deferred-unavailable image_generate)');

    const start = provider.requests.length;
    const events = await run(base, token, { provider: 'custom', baseUrl: provider.baseUrl, key: 'k', model: 'test/model', agentId: 'editor', isTask: true, placed: ['studio'],
      messages: [{ role: 'user', content: 'Build a DaVinci Resolve timeline from clips/a.mp4' }] });
    const first = provider.requests.slice(start).find(r => toolNames(r).length > 0 && JSON.stringify(r.messages || []).includes('Build a DaVinci Resolve timeline'));   // the main loop turn (aux calls carry no tools)
    for (const n of ['resolve_timeline_file', 'resolve_status', 'resolve_control']) A.ok(first && toolNames(first).includes(n), 'a studio agent is offered ' + n);
    A.ok(provider.requests.slice(start).every(coupled), 'studio run: coupling holds on every request');
    const cut = events.find(e => e.name === 'agent.tool_result' && e.payload.callId === 'cut');
    A.ok(cut && cut.payload.ok, 'resolve_timeline_file runs through the real dispatcher: ' + JSON.stringify(cut && cut.payload).slice(0, 300));
    const file = path.join(workspace, 'editor', 'edits', 'E2E_Cut.fcpxml');
    A.ok(fs.existsSync(file), 'the FCPXML is on disk in the agent workspace');
    const xml = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    A.ok(/frameDuration="1001\/30000s"/.test(xml) && /lane="1"/.test(xml) && /value="Open"/.test(xml), 'NTSC rate, the connected clip and the marker are in the file');
    const status = events.find(e => e.name === 'agent.tool_result' && e.payload.callId === 'status');
    A.ok(status && status.payload.ok, 'resolve_status answers (read, no consent)');
    A.eq(events.filter(e => e.name === 'agent.run.end').pop().payload.reason, 'done', 'the run completes');
    const statusText = JSON.stringify(provider.requests.slice(start).pop().messages || []);
    A.ok(/Live control: (NO|YES)/.test(statusText), 'the model is told plainly whether live control exists');
  } finally {
    try { child.kill(); } catch (_) {}
    await new Promise(resolve => provider.server.close(resolve));
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('resolve-task.e2e.test');
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
