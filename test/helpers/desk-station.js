'use strict';
/* test/helpers/desk-station.js — boot the REAL sidecar the way the desktop app does (keyed seal, desk shell IPC token, a served
   client key) or bare, and play the person at the desk. Built from the final review's probe harness (2026-11-08), for the
   regression tests of its findings.

     const st = await station(ws, env, 'desktop' | 'bare')
       st.CLIENT                 the key GET / serves (what a same-user script holds)
       st.call(tok, method, path, body, headers)
       st.viaDesk(method, path, body)   the page's request, confirmed at the desk and replayed (desktop: the shell's IPC yes;
                                          bare: the code the station printed on its console)
       st.stop()                 kill it and wait for the exit
     model(name, steps)          a fake OpenAI-compatible model: steps[toolTurns] = { name, args } (a tool call) | { text }
     cleanup(ws)                 remove a workspace and the recovery-owner folder a station leaves beside it */
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), http = require('http'), net = require('net');

const HOST = '127.0.0.1';
const API = 'desk-station-api-token-' + 'a'.repeat(40), IPC = 'desk-station-ipc-token-' + 'b'.repeat(40);
const KEYHEX = 'c'.repeat(64);
const INDEX = path.join(__dirname, '..', '..', 'sidecar', 'index.js');
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, HOST, () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function sse(res, chunks, fin) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const d of chunks) res.write('data: ' + JSON.stringify({ choices: [{ delta: d }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: fin || 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
function model(name, steps) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    if (req.url.includes('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: name, context_length: 8000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] })); }
    if (!req.url.includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
      let b = {}; try { b = JSON.parse(raw); } catch (_) { b = {}; }
      seen.push(b);
      const toolTurns = (b.messages || []).filter(m => m && m.role === 'tool').length;
      const step = typeof steps === 'function' ? steps(b, toolTurns) : (steps || [])[toolTurns];
      if (step && step.name) return sse(res, [{ tool_calls: [{ index: 0, id: 'c' + toolTurns, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args || {}) } }] }], 'tool_calls');
      return sse(res, [{ content: (step && step.text) || 'done' }]);
    });
  });
  return new Promise(r => srv.listen(0, HOST, () => r({ srv, seen, base: 'http://' + HOST + ':' + srv.address().port + '/v1', close: () => new Promise(c => srv.close(() => c())) })));
}

function boot(port, ws, env, mode) {
  return new Promise((resolve, reject) => {
    const prof = path.join(ws, '_appdata'); fs.mkdirSync(prof, { recursive: true });
    const desk = mode !== 'bare' ? { SKYNET_DESKTOP_SHELL: '1', STARNET_DESKTOP_SHELL: '1', SKYNET_IPC_TOKEN: IPC, SKYNET_API_TOKEN: API } : { SKYNET_API_TOKEN: API };
    if (mode === 'desktop') desk.STARNET_CONNECTOR_ENCRYPTION_KEY = KEYHEX;
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, {
      SKYNET_PORT: String(port), STARNET_PORT: String(port), SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws,
      SKYNET_EDGE_TTS_PROBE: '0', STARNET_CLAUDE_BIN: path.join(prof, 'none.cmd'), SKYNET_AUX_BUDGET: '0',
      SKYNET_FULL_ACCESS: '', STARNET_FULL_ACCESS: '',
      LOCALAPPDATA: prof, APPDATA: prof, XDG_DATA_HOME: prof }, desk, env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', done = false;
    const on = d => { buf += d.toString(); if (!done && /Open in your browser:\s+http:\/\/127\.0\.0\.1:\d+/.test(buf)) { done = true; resolve(child); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('close', c => { child.exited = true; if (!done) { done = true; reject(new Error('exited ' + c + '\n' + buf.slice(-3000))); } });
    child.out = () => buf;
    setTimeout(() => { if (!done) { done = true; child.kill(); reject(new Error('boot timeout\n' + buf.slice(-3000))); } }, 150000).unref();
  });
}

async function station(ws, env, mode) {
  const port = await freePort();
  const child = await boot(port, ws, env, mode || 'desktop');
  const B = 'http://' + HOST + ':' + port;
  const page = await (await fetch(B + '/')).text();
  const m = /window\.__STARNET_API_TOKEN__=("[^"]*")/.exec(page);
  const CLIENT = m ? JSON.parse(m[1]) : '';
  const call = async (tok, method, p, body, extra) => {
    const r = await fetch(B + p, { method, headers: Object.assign({ 'Content-Type': 'application/json', 'X-StarNet-Token': tok, Origin: B }, extra || {}), body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; } return { status: r.status, body: v };
  };
  const viaDesk = async (method, p, body) => {
    const first = await call(API, method, p, body);
    const ch = first.body && first.body.deskConfirm;
    if (first.status !== 403 || !ch) return first;
    if (ch.mode === 'desktop') {
      const ok = await call(IPC, 'POST', '/api/desk/approve', { id: ch.id, title: ch.title, summary: ch.summary, verb: ch.verb });
      if (ok.status !== 200) return { status: ok.status, body: ok.body };
      return call(API, method, p, body, { 'X-StarNet-Desk-Proof': ch.id });
    }
    await sleep(200);
    const re = new RegExp('(\\d{6})[^\\n]*' + ch.code + '|' + ch.code + '[^\\n]*?(\\d{6})', 'g');
    let code = '', mm; while ((mm = re.exec(child.out()))) code = mm[1] || mm[2];
    return call(API, method, p, body, { 'X-StarNet-Desk-Proof': ch.id, 'X-StarNet-Desk-Code': code });
  };
  const stop = async () => {
    if (!child.exited) { try { child.kill(); } catch (_) { /* gone */ } }
    for (let i = 0; i < 60 && !child.exited; i++) await sleep(100);
    await sleep(300);
  };
  return { child, B, CLIENT, API, IPC, call, viaDesk, stop, port };
}

function findFile(dir, name) {
  let list = [];
  try { list = fs.readdirSync(dir); } catch (_) { return null; }
  for (const n of list) {
    const f = path.join(dir, n);
    let st; try { st = fs.lstatSync(f); } catch (_) { continue; }
    if (st.isDirectory() && !st.isSymbolicLink()) { const x = findFile(f, name); if (x) return x; }
    else if (n === name) return f;
  }
  return null;
}
// a workspace made by fs.mkdtempSync, and the recovery-owner generations folder a station leaves beside it (B12). Only under
// the temp folder, and never a tree holding a link or junction (a recursive delete must not follow one).
function hasLink(dir) {
  let st; try { st = fs.lstatSync(dir); } catch (_) { return false; }
  if (st.isSymbolicLink()) return true;
  if (!st.isDirectory()) return false;
  for (const n of fs.readdirSync(dir)) if (hasLink(path.join(dir, n))) return true;
  return false;
}
function cleanup(ws) {
  const tmp = path.resolve(fs.realpathSync(require('os').tmpdir())).toLowerCase();
  for (const p of [ws, ws + '.recovery-owner.json.generations']) {
    if (!p || path.resolve(fs.existsSync(p) ? fs.realpathSync(p) : p).toLowerCase().indexOf(tmp) !== 0) continue;
    if (hasLink(p)) { console.log('kept ' + p + ': it holds a link or junction'); continue; }
    try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) { /* best effort */ }
  }
}

module.exports = { HOST, API, IPC, KEYHEX, freePort, sleep, model, station, findFile, cleanup };
