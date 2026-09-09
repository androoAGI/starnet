/* DEV ONLY — a loopback OpenRouter-compatible scripted model, not fabricated UI state.
 * Run: node dev/world-next-model.cjs
 * Copy its printed environment into the sidecar terminal, then node dev/seed.js --keep.
 * Ask NOVA: Run the world proof
 * The REAL harness executes brief.proceed -> fs.write -> deliverable_note.
 * This process writes no files and never starts a sidecar or another process.
 */
'use strict';
const http = require('node:http');
const MODEL = 'world-proof';
const PROMPT = 'Run the world proof';
const ARTIFACT_PATH = 'world-next-proof.html';
const ARTIFACT = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kepler — World Next local proof</title>
<style>body{margin:0;background:#071018;color:#d9e6e9;font:16px/1.65 system-ui,sans-serif}main{max-width:780px;margin:9vh auto;padding:32px}small{letter-spacing:.2em;color:#71b4bb}h1{font-size:clamp(42px,8vw,80px);line-height:1.1;margin:24px 0}p{color:#adc4cc}.rooms{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:36px 0}.room{padding:20px;border:1px solid #315260;background:#102633}.room:nth-child(2){background:#33251b;border-color:#76563b}.room:nth-child(3){background:#1e3026;border-color:#456c4e}.room b{display:block;font-size:13px;letter-spacing:.08em}.room span{font-size:13px;color:#b7c7c9}code{color:#8ed3c4}footer{border-top:1px solid #315260;padding-top:20px;font-size:13px;color:#8babb5}@media(max-width:560px){.rooms{grid-template-columns:1fr}}</style>
<main><small>KEPLER / LOCAL DEVELOPMENT ARTIFACT</small><h1>Made aboard<br>the station.</h1>
<p>This HTML file is the output of a real filesystem tool call made by StarNet's harness using an explicitly scripted local model.</p>
<div class="rooms"><div class="room"><b>COMMAND</b><span>NOVA · cobalt alloy</span></div><div class="room"><b>FABRICATION</b><span>EMBER · warm industrial steel</span></div><div class="room"><b>CONSERVATORY</b><span>FERN · timber and botanical glass</span></div></div>
<p>The local proof exercises model streaming, tool dispatch, artifact recording and opening a deliverable. It does not establish renderer performance, visual quality or production readiness.</p>
<footer>Model: <code>world-proof</code> · Provider: local fixture · No external account or paid inference</footer></main></html>`;

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', data => { body += data; if (body.length > 4 * 1024 * 1024) { reject(new Error('Request too large')); req.destroy(); } });
    req.once('error', reject);
    req.once('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (error) { reject(error); } });
  });
}
function contentText(message) {
  const content = message && message.content;
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.map(c => c.text || '').join('\n') : JSON.stringify(content || '');
}
function failedTool(message) {
  const text = contentText(message);
  try {
    const result = JSON.parse(text);
    return result.ok === false || result.isError === true || !!result.error;
  } catch (_) { return /^(error|denied|rejected|failed)\b/i.test(text.trim()); }
}
function nextTurn(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const userAt = messages.findLastIndex(message => message.role === 'user');
  const ask = contentText(messages[userAt]);
  if (ask.trim().replace(/[.!]+$/, '').toLowerCase() !== PROMPT.toLowerCase())
    return { text: `This is a local scripted model. Ask "${PROMPT}" to write and open its proof artifact.` };
  const recent = messages.slice(userAt + 1);
  const results = recent.filter(message => message.role === 'tool');
  const failure = results.find(failedTool);
  if (failure) return { text: 'The local proof stopped because a real tool returned an error: ' + contentText(failure).slice(0, 500) };
  const available = (body.tools || []).map(tool => tool.function && tool.function.name).filter(Boolean);
  const resolveTool = names => names.find(name => available.includes(name));
  const calls = recent.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || []);
  const completed = names => calls.some(call => names.includes(call.function && call.function.name) && results.some(result => result.tool_call_id === call.id));
  const brief = ['brief_proceed', 'brief.proceed'];
  const write = ['fs_write', 'fs.write'];
  const note = ['deliverable_note', 'deliverable.note'];
  if (!completed(brief)) {
    const tool = resolveTool(brief);
    if (tool) return { tool, args: { objective: 'Write the World Next local proof HTML artifact and report the real filesystem result.' } };
  }
  if (!completed(write)) {
    const tool = resolveTool(write);
    if (!tool) return { text: 'The local proof cannot write: the harness did not expose a filesystem write tool for this agent.' };
    return { tool, args: { path: ARTIFACT_PATH, content: ARTIFACT } };
  }
  if (!completed(note)) {
    const tool = resolveTool(note);
    if (tool) return { tool, args: { title: 'Kepler — local world proof', summary: 'A real HTML artifact written through the harness by the local scripted model.', kind: 'page', main: ARTIFACT_PATH } };
  }
  return { text: `The filesystem tool wrote ${ARTIFACT_PATH}. Open the saved deliverable to inspect it. This run used the local scripted model; renderer quality and performance require separate verification.` };
}

function createMockServer({ delayMs = 350 } = {}) {
  let requestId = 0;
  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && (pathname === '/api/v1/models' || pathname === '/models')) {
      return json(res, 200, { data: [{ id: MODEL, name: 'World Next — local scripted fixture', context_length: 64000,
        pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'],
        architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] } }] });
    }
    if (req.method === 'GET' && pathname === '/health') return json(res, 200, { ok: true, fixture: MODEL, requests: requestId });
    if (req.method !== 'POST' || pathname !== '/api/v1/chat/completions') return json(res, 404, { error: 'Local model route not found' });
    try {
      const body = await readBody(req);
      const turn = nextTurn(body);
      const id = 'world_proof_' + (++requestId);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = payload => res.write('data: ' + JSON.stringify({ id, model: MODEL, ...payload }) + '\n\n');
      const delta = turn.tool ? { tool_calls: [{ index: 0, id: id + '_call', type: 'function',
        function: { name: turn.tool, arguments: JSON.stringify(turn.args) } }] } : { content: turn.text };
      send({ choices: [{ index: 0, delta }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: turn.tool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 32, completion_tokens: 24, total_tokens: 56 } });
      res.end('data: [DONE]\n\n');
    } catch (error) { if (!res.destroyed) json(res, 400, { error: error.message }); }
  });
}

module.exports = { createMockServer, nextTurn, ARTIFACT, ARTIFACT_PATH, MODEL, PROMPT };
if (require.main === module) {
  const port = Number(process.env.WORLD_NEXT_MODEL_PORT || 8796);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid WORLD_NEXT_MODEL_PORT');
  const server = createMockServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    const base = 'http://127.0.0.1:' + server.address().port + '/api/v1';
    console.log('DEV ONLY local scripted model listening at ' + base);
    console.log('In the separate sidecar PowerShell terminal:');
    console.log("$env:SKYNET_PORT='" + (process.env.SKYNET_PORT || '8795') + "'");
    console.log("$env:SKYNET_DEFAULT_MODEL='" + MODEL + "'");
    console.log("$env:SKYNET_OPENROUTER_KEY='local-world-proof'");
    console.log("$env:SKYNET_OPENROUTER_BASE='" + base + "'");
    console.log('node dev/seed.js --keep');
    console.log('In COMMS, ask NOVA: ' + PROMPT);
  });
}
