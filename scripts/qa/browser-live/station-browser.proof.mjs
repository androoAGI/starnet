// GENERATED from the live proofs run on Windows (browser-view lane, 2026-10-01). Portable: node scripts/qa/browser-live/station-browser.proof.mjs <outDir>
// Live proof for the unified BROWSER window (agent/browser-view): COMMS door, typed address (real Chrome, streamed,
// driven), agent-made page, watching an agent's browser. Real seeded sidecar from the worktree, content-aware mock
// OpenRouter, headless Chrome over CDP driving the real UI.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const requireRepo = createRequire(import.meta.url);
/* PORTABLE PROCESS CHECKS (Windows CIM, else ps): the real, HEADED Chromium main processes whose command line carries
   every needle — never a helper (--type=), never a headless one. */
function chromeProcs(needles) {
  let rows = [];
  try {
    if (process.platform === 'win32') {
      rows = require_cp.execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { [string]$_.ProcessId + ' ' + $_.CommandLine }"], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split(/\r?\n/);
    } else {
      rows = require_cp.execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n');
    }
  } catch (_) { return []; }
  return rows.map(l => l.trim()).filter(Boolean).map(l => { const i = l.indexOf(' '); return { pid: l.slice(0, i), cmd: l.slice(i + 1) }; })
    .filter(r => needles.every(n => r.cmd.indexOf(n) >= 0) && r.cmd.indexOf('--type=') < 0 && r.cmd.indexOf('--headless') < 0
      && /chrome|chromium|msedge/i.test(r.cmd) && r.cmd.indexOf('powershell') < 0 && !/^ps\b/.test(r.cmd));
}
// what clicking the window's close button does: a normal close request, not a crash
function closeWindowGracefully(pid) {
  try {
    if (process.platform === 'win32') require_cp.execFileSync('taskkill', ['/PID', String(pid)], { stdio: 'ignore' });
    else process.kill(Number(pid), 'SIGTERM');
  } catch (_) { /* already gone */ }
}

import * as require_cp from 'node:child_process';
import { openSync } from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const WT = new URL('../../lib/', import.meta.url).href;
const { sleep, launchChrome, connectCDP, evalJS, collectDiagnostics } = await import(WT + 'cdp.mjs');
const { materializeSeedWorkspace, bootSeededSidecar, waitUp, waitDevReady } = await import(WT + 'seed.mjs');

const OUT = process.argv[2] || '.';
const MODEL = 'test/model';
const results = [];
const ok = (name, cond, detail) => { results.push({ name, ok: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + String(detail).slice(0, 300) : '')); };
async function until(fn, ms, step = 300) { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn().catch(() => null); if (v) return v; await sleep(step); } return v; }

// ---- a tiny site for the Commander's own browsing (loopback) ----
const site = await new Promise(resolve => {
  const s = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (req.url.startsWith('/anim')) return res.end('<!doctype html><title>anim</title><body style="margin:0;background:#222"><div style="width:160px;height:160px;background:#e33;position:absolute;top:100px;animation:m 1s linear infinite alternate"></div><style>@keyframes m{from{left:0}to{left:900px}}</style>');
    if (req.url.startsWith('/done')) return res.end('<!doctype html><title>done</title><body style="margin:0;background:#103010;color:#fff"><h1 style="margin:40px">DONE ' + decodeURIComponent((req.url.split('v=')[1] || '')).replace(/[<>&]/g, '') + '</h1>');
    res.end('<!doctype html><title>fixture home</title><body style="margin:0;background:#101030;color:#fff">'
      + '<input id="q" style="position:absolute;left:100px;top:100px;width:300px;height:40px;font-size:20px">'
      + '<h1 style="position:absolute;left:100px;top:200px;margin:0">FIXTURE HOME</h1>'
      + '<script>q.addEventListener("keydown",e=>{if(e.key==="Enter")location.href="/done?v="+encodeURIComponent(q.value)})</script>');
  });
  s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
});

// ---- scripted "agent": per directive, ordered tool steps (a missing deferred tool is fetched with tool_search) ----
const PAGE = '<!doctype html><html><head><title>pending</title><link rel="stylesheet" href="css/app.css"></head><body><h1 id="h">Launch page</h1><script>document.title = "script-ran";</script></body></html>';
const SCRIPTS = {
  'build me a web page': [
    { re: /^brief.?proceed$/, args: { objective: 'build a small web page' } },
    { re: /^fs.?write$/, args: { path: 'site/index.html', content: PAGE } },
    { re: /^fs.?write$/, args: { path: 'site/css/app.css', content: 'h1 { color: rgb(255, 0, 0); }' } }
  ],
  'do you see my page': [
    { re: /^brief.?proceed$/, args: { objective: 'read the page open in the browser' } },
    { re: /^browser.?get.?text$/, args: {}, q: 'read the visible text of the current browser page' }
  ],
  'open example in your browser': [
    { re: /^brief.?proceed$/, args: { objective: 'open example.com in the browser' } },
    { re: /^browser.?navigate$/, args: { url: 'https://example.com/' }, q: 'navigate the browser to a web page url', holdAfter: 14000 }
  ]
};
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p && (p.text || '')).join(' ') : '';
let hits = 0; const mockLog = [];
function startMock() {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: MODEL, name: 'Browser Proof Mock', context_length: 200000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] })); }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); return res.end(); }
      let body = ''; req.on('data', d => body += d); req.on('end', () => {
        hits++;
        let reply = { text: 'done.' }, delay = 120;
        try {
          const b = JSON.parse(body); const msgs = b.messages || [];
          const tools = (b.tools || []).map(t => t.function && t.function.name).filter(Boolean);
          let lu = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { lu = i; break; }
          const txt = lu >= 0 ? textOf(msgs[lu].content).toLowerCase() : '';
          const key = Object.keys(SCRIPTS).find(k => txt.indexOf(k) >= 0);
          if (key && tools.length) {
            const calls = msgs.slice(lu + 1).filter(m => m.role === 'assistant' && m.tool_calls && m.tool_calls.length).map(m => m.tool_calls[0].function.name);
            let done = calls.filter(n => !/tool.?search/.test(n)).length;
            // a brief already settled in this chat is not offered again: skip that scripted step
            const briefOffered = tools.some(n => /^brief.?proceed$/.test(n));
            if (!briefOffered && SCRIPTS[key] && SCRIPTS[key][0] && /brief/.test(String(SCRIPTS[key][0].re))) done += 1;
            const lastWasSearch = calls.length && /tool.?search/.test(calls[calls.length - 1]);
            const steps = SCRIPTS[key];
            if (done > 0 && steps[done - 1] && steps[done - 1].holdAfter) delay = steps[done - 1].holdAfter;
            if (done < steps.length) {
              const st = steps[done]; const name = tools.find(n => st.re.test(n));
              if (name) reply = { call: [name, st.args] };
              else if (!lastWasSearch && st.q && tools.find(n => /^tool.?search$/.test(n))) reply = { call: [tools.find(n => /^tool.?search$/.test(n)), { query: st.q }] };
              else reply = { text: 'MISSING TOOL ' + st.re };
            }
            const toolOut = msgs.slice(lu + 1).filter(m => m.role === 'tool').map(m => textOf(m.content)).join(' || ');
            mockLog.push({ key, done, calls, reply: reply.call ? reply.call[0] : reply.text, toolOut });
          }
        } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const end = fr => { res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: fr }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\n'); res.write('data: [DONE]\n\n'); res.end(); };
        setTimeout(() => {
          if (reply.call) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + hits, type: 'function', function: { name: reply.call[0], arguments: JSON.stringify(reply.call[1]) } }] } }] }) + '\n\n');
            setTimeout(() => end('tool_calls'), 100);
          } else { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply.text } }] }) + '\n\n'); setTimeout(() => end('stop'), 100); }
        }, delay);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: 'http://127.0.0.1:' + server.address().port + '/api/v1' }));
  });
}
async function inFrame(cdp, urlPart, expr) {
  const tree = await cdp.send('Page.getFrameTree');
  const all = []; (function walk(n) { all.push(n.frame); (n.childFrames || []).forEach(walk); })(tree.frameTree);
  const f = all.find(fr => (fr.url || '').indexOf(urlPart) >= 0);
  if (!f) return null;
  const w = await cdp.send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'obproof' });
  const r = await cdp.send('Runtime.evaluate', { expression: expr, contextId: w.executionContextId, returnByValue: true, awaitPromise: true });
  return r.result ? r.result.value : null;
}
let sends = 0;
async function sendIdle(cdp, text) {
  await until(() => evalJS(cdp, "((document.getElementById('chat-log')||{}).innerText||'').split('RUN COMPLETE').length - 1").then(n => n >= sends ? true : null), 120000, 400);
  await sleep(800); sends++;
  await evalJS(cdp, '(Chat.send(' + JSON.stringify(text) + '), 1)');
}
const Q = s => "document.querySelector(" + JSON.stringify(s) + ")";

const scratch = mkdtempSync(join(tmpdir(), 'obproof2-'));
const home = join(scratch, 'home'); mkdirSync(home);
const wsDir = materializeSeedWorkspace(join(scratch, 'ws'), MODEL);
const mock = await startMock();
// both ports come from the OS (test/helpers/ports.js): a fixed or PID-derived pick can land on a reserved port
const { allocatePort } = requireRepo(join(REPO, 'test', 'helpers', 'ports.js'));
const port = await allocatePort(), cdpPort = await allocatePort();
const SIDELOG = openSync(join(OUT, 'sidecar.log'), 'w');
const bootWith = extra => require_cp.spawn(process.execPath, [join(REPO, 'sidecar', 'index.js')], { cwd: REPO, stdio: ['ignore', SIDELOG, SIDELOG],
  env: Object.assign({}, process.env, extra, { SKYNET_DEV: '1', SKYNET_FULL_ACCESS: '1', SKYNET_WORKSPACES: wsDir, SKYNET_PORT: String(port), SKYNET_DEFAULT_MODEL: MODEL, SKYNET_OPENROUTER_KEY: 'sk-or-v1-obproof-fake' }) });
const sidecar = bootWith({
  SKYNET_OPENROUTER_BASE: mock.base, STARNET_OPENROUTER_BASE: mock.base, SKYNET_QUEST_REFRESH: '0', SKYNET_SCOUT: '0',
  HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata') });
let chrome = null;
try {
  const url = 'http://127.0.0.1:' + port + '/';
  ok('sidecar up', await waitUp(url, 160), url + ' pid ' + sidecar.pid);
  chrome = launchChrome({ cdpPort, profileDir: join(scratch, 'chrome') });
  const cdp = await connectCDP(cdpPort);
  const diag = collectDiagnostics(cdp);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url });
  ok('in-game', await waitDevReady(cdp, evalJS, { url, tries: 60 }));
  await sleep(4000);
  await evalJS(cdp, "(() => { window.__obIn = 0; const f = window.fetch; window.fetch = function (u) { if (String(u).indexOf('view/input') >= 0) window.__obIn++; return f.apply(this, arguments); }; return 1; })()");
  const shot = async name => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); };

  const view = () => evalJS(cdp, "fetch('/api/browser/view').then(r=>r.json())");
  const ui = () => evalJS(cdp, "(() => { const o=" + Q('.ob') + "; if(!o) return null; return { mode:o.dataset.mode, st:o.dataset.state, who:" + Q('.ob-who') + ".textContent, url:" + Q('.ob-url') + ".value, note:" + Q('.ob-note') + ".textContent, pic: !!" + Q('.ob-live') + ".getAttribute('src'), backOff:" + Q('.ob-back') + ".disabled }; })()");
  const type = async text => { await evalJS(cdp, "(() => { const u=" + Q('.ob-url') + "; u.focus(); u.value=" + JSON.stringify(text) + "; u.closest('form').requestSubmit(); return 1; })()"); };
  const HOME = 'http://127.0.0.1:' + site.port + '/';

  // A — the COMMS door: + then the globe, top right
  const door = await evalJS(cdp, "(() => { const b=document.getElementById('comms-browser'), bar=document.getElementById('comms-idbar'), add=document.getElementById('gc-add-agents'); if(!b) return null; const s=getComputedStyle(b), r=b.getBoundingClientRect(), p=document.getElementById('chat-panel').getBoundingClientRect(), ar=add&&add.getBoundingClientRect(); return { inBar: b.parentNode===bar, afterPlus: !!ar && ar.right <= r.left + 1 && Math.abs(ar.top - r.top) < 2, addText: add ? add.textContent.trim() : null, addW: ar ? Math.round(ar.width) : 0, w:Math.round(r.width), bg:s.backgroundColor, bd:s.borderTopColor, inside: r.left>=p.left && r.right<=p.right, live:b.classList.contains('live') }; })()");
  ok('COMMS header top right: + (add agents) then the globe (browser)', door && door.inBar && door.afterPlus && door.inside && door.addText === '' && door.addW === door.w, JSON.stringify(door));
  ok('the door is station glass, not OS paint', door && !/rgb\(255, 255, 255\)|rgb\(239, 239, 239\)/.test(door.bg) && !/rgb\(118, 118, 118\)/.test(door.bd));
  await evalJS(cdp, "(document.getElementById('comms-browser').click(), 1)");
  const opened = await until(() => evalJS(cdp, "(() => { const w=document.querySelector('.term.browser-win'); if(!w) return null; return { mode:w.querySelector('.ob').dataset.mode, focused: document.activeElement===w.querySelector('.ob-url'), docked: w.classList.contains('gd-docked') }; })()"), 8000);
  ok('the globe opens the BROWSER window (a standard docked window), address bar ready', opened && opened.mode === 'empty' && opened.focused && opened.docked, JSON.stringify(opened));

  // B — YOU open a page in the station browser
  await type('javascript:alert(1)');
  ok('a javascript: address is refused in plain words', /only http and https/.test(String(await until(() => evalJS(cdp, Q('.ob-note') + '.textContent').then(t => /Could not open that/.test(t) ? t : null), 8000))));
  await type('127.0.0.1:' + site.port);
  const mine = await until(() => ui().then(u => u && u.mode === 'live' && u.pic && u.url === HOME ? u : null), 60000);
  ok('a typed address opens the station browser, streamed into the window', !!mine, JSON.stringify(mine || await ui()));
  ok('it is yours while no agent is driving', mine && mine.who === 'YOU' && mine.backOff === false, mine && mine.note);
  const v1 = await view();
  ok('station truth: open, nobody driving, on the durable profile (sign-ins saved)', v1.station.open && v1.station.driver === null && v1.station.remembered === true, JSON.stringify(v1.station));
  // drive it
  const fr = await evalJS(cdp, "fetch('/api/browser/view/frame?target=station&after=0').then(r=>r.json()).then(j=>({w:j.frame&&j.frame.width,h:j.frame&&j.frame.height}))");
  const pt = await evalJS(cdp, "(() => { const i=" + Q('.ob-live') + ", r=i.getBoundingClientRect(), fw=" + (fr.w || 1440) + ", fh=" + (fr.h || 900) + "; const sc=Math.min(r.width/i.naturalWidth, r.height/i.naturalHeight), dw=i.naturalWidth*sc, dh=i.naturalHeight*sc; const ox=r.left+(r.width-dw)/2, oy=r.top+(r.height-dh)/2; return { x: ox + (250/fw)*dw, y: oy + (120/fh)*dh }; })()");
  for (const t of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type: t, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await sleep(500);
  for (const ch of 'hi') { await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: 'Key' + ch.toUpperCase(), text: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Key' + ch.toUpperCase(), windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) }); await sleep(120); }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  ok('clicking and typing in the picture drives the page (typed "hi", Enter)', !!(await until(() => ui().then(u => /\/done\?v=hi$/.test(u.url) ? u.url : null), 20000)), (await ui()).url);
  ok('typing in the page did NOT leak into COMMS', (await evalJS(cdp, "document.getElementById('chat-input').value")) === '');
  await evalJS(cdp, "(" + Q('.ob-back') + ".click(), 1)");
  ok('BACK goes back', !!(await until(() => ui().then(u => u.url === HOME ? 1 : null), 20000)));
  await sleep(1500);

  // SMOOTHNESS — built-in mode: frames that actually reach the in-app picture, on an animated page
  ok('the default is a real CHROME WINDOW on the desktop', (await view()).station.visible === true && (await view()).station.mode === 'window', JSON.stringify((await view()).station));
  await type('127.0.0.1:' + site.port + '/anim');
  await until(() => ui().then(u => /\/anim$/.test(u.url) && u.pic ? 1 : null), 30000);
  await sleep(1500);
  const fps = await evalJS(cdp, "new Promise(res => { const img = document.querySelector('.ob-live'); let n = 0; const mo = new MutationObserver(() => n++); mo.observe(img, { attributes: true, attributeFilter: ['data-seq'] }); setTimeout(() => { mo.disconnect(); res(n / 3); }, 3000); })");
  ok('the in-app picture is smooth: >= 20 frames/s on an animated page (was ~7)', fps >= 20, fps.toFixed(1) + ' fps');
  await shot('builtin-anim');
  // COVERED: another window on top of the station's Chrome window must not freeze the in-app picture (on Windows,
  // StarNet's own window covering it froze it at 0 frames/s; macOS and Linux have their own occlusion rules)
  {
    const T = requireRepo(join(REPO, 'sidecar', 'tools', 'builtin', 'browser.js'))._internals;
    const bin = (T.resolveChrome(true) || {}).path;
    const coverDir = mkdtempSync(join(tmpdir(), 'obcover-'));
    await type('127.0.0.1:' + site.port + '/anim');
    await until(() => ui().then(u => /\/anim$/.test(u.url) && u.pic ? 1 : null), 30000);
    const cover = bin ? require_cp.spawn(bin, ['--user-data-dir=' + coverDir, '--no-first-run', '--no-default-browser-check', '--window-position=0,0', '--window-size=2400,1600',
      'data:text/html,<body style="margin:0;background:%23333;color:%23fff;font:40px sans-serif">COVERING WINDOW</body>'], { stdio: 'ignore' }) : null;
    await sleep(4000);
    const fpsCovered = await evalJS(cdp, "new Promise(res => { const img = document.querySelector('.ob-live'); let n = 0; const mo = new MutationObserver(() => n++); mo.observe(img, { attributes: true, attributeFilter: ['data-seq'] }); setTimeout(() => { mo.disconnect(); res(n / 3); }, 3000); })");
    ok('with ANOTHER WINDOW covering the station\'s Chrome window, the in-app picture keeps moving (>= 10 frames/s)', !!cover && fpsCovered >= 10, (cover ? '' : 'no browser to cover with — ') + Number(fpsCovered).toFixed(1) + ' fps');
    await shot('covered-window');
    try { if (cover) { if (process.platform === 'win32') require_cp.execFileSync('taskkill', ['/T', '/F', '/PID', String(cover.pid)], { stdio: 'ignore' }); else cover.kill('SIGKILL'); } } catch (_) { /* gone */ }
    await type('127.0.0.1:' + site.port);
    await until(() => ui().then(u => u.url === HOME ? 1 : null), 30000);
  }
  await type('127.0.0.1:' + site.port);
  await until(() => ui().then(u => u.url === HOME ? 1 : null), 30000);

  // C — "do you see my page?": the AGENT reads THE SAME browser
  await sendIdle(cdp, 'do you see my page');
  const saw = await until(async () => { const e = mockLog.filter(m => m.key === 'do you see my page' && /FIXTURE HOME/.test(m.toolOut || '')); return e.length ? e[e.length - 1] : null; }, 120000, 500);
  ok('the agent\'s browser tool read the page YOU opened (it saw "FIXTURE HOME")', !!saw, JSON.stringify((mockLog.filter(m => m.key === 'do you see my page').slice(-1)[0] || {})).slice(0, 400));
  ok('no second browser was launched for the agent (the list has no private browsers)', (await view()).agents.length === 0);

  // D — "open X in your browser": the agent DRIVES the same browser, you watch, and it STAYS
  await sendIdle(cdp, 'open example in your browser');
  const drv = await until(() => view().then(v => v.station.driver && v.station.driver.agentId ? v.station : null), 120000, 400);
  ok('station truth: the agent is the driver once it uses the browser', !!drv, JSON.stringify(drv));
  const watching = await until(() => ui().then(u => u && u.mode === 'live' && /example\.com/.test(u.url) && u.pic ? u : null), 30000);
  ok('the open window shows the agent\'s navigation live (example.com)', !!watching, JSON.stringify(watching || await ui()));
  ok('it says the AGENT is using it — and your controls stay ON (you can click and type alongside)', watching && /NOVA/i.test(watching.who) && /is using the browser/.test(watching.note) && /click and type/.test(watching.note) && watching.backOff === false, watching && (watching.who + ' | ' + watching.note + ' | backOff ' + watching.backOff));
  ok('the door lamp is lit while the agent drives', !!(await until(() => evalJS(cdp, "document.getElementById('comms-browser').classList.contains('live')"), 10000)));
  await shot('shared-agent-driving');
  // your hands while the agent drives: a key reaches the page (accepted, never "driving")
  const handsWhileDriving = await evalJS(cdp, "fetch('/api/browser/view/input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({events:[{type:'key',action:'down',key:'Shift',code:'ShiftLeft',keyCode:16,modifiers:8},{type:'key',action:'up',key:'Shift',code:'ShiftLeft',keyCode:16,modifiers:0}]})}).then(async r=>({status:r.status, body: await r.json().catch(()=>null)}))");
  ok('while the agent drives, YOUR clicks and keys still reach the page (not refused)', handsWhileDriving && handsWhileDriving.status === 200 && !(handsWhileDriving.body && handsWhileDriving.body.code === 'driving'), JSON.stringify(handsWhileDriving));
  // the run ends
  await until(() => evalJS(cdp, "((document.getElementById('chat-log')||{}).innerText||'').split('RUN COMPLETE').length - 1").then(n => n >= sends ? true : null), 120000, 500);
  const after = await until(() => view().then(v => v.station.driver === null ? v.station : null), 20000, 400);
  ok('after the run the browser is STILL OPEN, nobody driving', after && after.open === true, JSON.stringify(after));
  const stays = await until(() => ui().then(u => u && u.mode === 'live' && u.who === 'YOU' && /example\.com/.test(u.url) && u.pic && u.backOff === false ? u : null), 20000);
  ok('the window still shows what the agent opened, and it is yours again', !!stays, JSON.stringify(stays || await ui()));
  ok('the lamp goes out', await until(() => evalJS(cdp, "!document.getElementById('comms-browser').classList.contains('live')"), 15000));
  await shot('shared-after-run');
  await type('127.0.0.1:' + site.port);
  ok('you can type an address again', !!(await until(() => ui().then(u => u.url === HOME ? 1 : null), 30000)));

  // R — it is a REAL window on this machine; closing it, and the agent bringing it back
  // switch Settings → Browser → CHROME WINDOW through the real UI
  await evalJS(cdp, "(StationUI.openTerm('settings', 'browser'), 1)");
  const pane = await until(() => evalJS(cdp, "document.querySelector('#brw-mode [data-mode=\"window\"]') ? 1 : null"), 10000);
  ok('Settings has a BROWSER section with its two choices (YOUR CHROME hidden until its extension exists)', !!pane && (await evalJS(cdp, "[...document.querySelectorAll('#brw-mode [data-mode]')].map(b=>b.textContent).join('|')")) === 'CHROME WINDOW|BUILT-IN');
  ok('CHROME WINDOW is selected by default', !!(await until(() => evalJS(cdp, "document.querySelector('#brw-mode [data-mode=\"window\"]').classList.contains('sel') ? 1 : null"), 10000)));
  await evalJS(cdp, "(document.querySelector('#brw-mode [data-mode=\"builtin\"]').click(), 1)");
  const selB = await until(() => evalJS(cdp, "document.querySelector('#brw-mode [data-mode=\"builtin\"]').classList.contains('sel') ? 1 : null"), 10000);
  ok('clicking BUILT-IN selects it and saves it', !!selB && (await evalJS(cdp, "fetch('/api/browser/settings').then(r=>r.json()).then(j=>j.mode)")) === 'builtin');
  await evalJS(cdp, "(document.querySelector('#brw-mode [data-mode=\"window\"]').click(), 1)");
  const sel = await until(() => evalJS(cdp, "document.querySelector('#brw-mode [data-mode=\"window\"]').classList.contains('sel') ? 1 : null"), 10000);
  ok('clicking CHROME WINDOW selects it and saves it', !!sel && (await evalJS(cdp, "fetch('/api/browser/settings').then(r=>r.json()).then(j=>j.mode)")) === 'window');
  await evalJS(cdp, "(document.querySelector('.term .term-x') && [...document.querySelectorAll('.term')].filter(t=>t.querySelector('#brw-mode')).forEach(t=>t.querySelector('.term-x').click()), 1)");
  await sleep(800);
  await evalJS(cdp, "(document.getElementById('comms-browser').click(), 1)");
  await sleep(800);
  await type('127.0.0.1:' + site.port);
  await until(() => view().then(v => v.station.visible === true && v.station.open ? 1 : null), 60000, 500);
  const vis = await view();
  ok('station truth: the browser is a VISIBLE window', vis.station.visible === true, JSON.stringify(vis.station));
  const headedPids = () => chromeProcs(['browser-profile', basename(scratch)]).map(r => r.pid);
  const wins = headedPids();
  ok('a headed Chrome process (no --headless) runs on this station\'s profile', wins.length >= 1, wins.join(','));
  await until(() => ui().then(u => u && u.mode === 'live' && !/Opening/.test(u.note) ? 1 : null), 60000);   // a mode switch can take a while on a loaded box
  const frontShown = await until(() => evalJS(cdp, "!" + Q('.ob-front') + ".hidden"), 8000);
  ok('SHOW WINDOW is offered', !!frontShown, frontShown ? '' : JSON.stringify(await ui()) + ' | ' + JSON.stringify((await view()).station));
  const fr1 = await evalJS(cdp, "fetch('/api/browser/view/front',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.status)");
  ok('SHOW WINDOW raises the real window (200)', fr1 === 200, String(fr1));
  await shot('real-window-mirror');
  // the Commander closes the Chrome window (gracefully)
  // a normal close request — what clicking the window's X does (WM_CLOSE; taskkill without /F), not a crash
  for (const pid of wins) closeWindowGracefully(pid);
  const gone = await until(() => view().then(v => v.station.open === false ? 1 : null), 20000, 500);
  ok('after the window is closed the station says the browser is closed (no stale picture)', !!gone);
  const closedUi = await until(() => ui().then(u => u && (u.st === 'ended' || u.st === 'empty') ? u : null), 20000);
  ok('the in-app view says it is closed', !!closedUi, JSON.stringify(closedUi || await ui()));
  const before = mockLog.filter(m => m.key === 'do you see my page').length;
  await sendIdle(cdp, 'do you see my page');
  const revived = await until(async () => { const e = mockLog.filter(m => m.key === 'do you see my page').slice(before); return e.find(m => /BEGIN EXTERNAL WEB CONTENT/.test(String(m.toolOut || '').split('||').pop())) || null; }, 120000, 500);
  ok('the next agent browser call starts the window again and works', !!revived, JSON.stringify((mockLog.filter(m => m.key === 'do you see my page').slice(-1)[0] || {})).slice(0, 300));
  ok('…as a real window again', headedPids().length >= 1);
  await until(() => evalJS(cdp, "((document.getElementById('chat-log')||{}).innerText||'').split('RUN COMPLETE').length - 1").then(n => n >= sends ? true : null), 120000, 500);
  await type('127.0.0.1:' + site.port);
  const again = await until(() => ui().then(u => u.mode === 'live' && u.url === HOME && u.pic ? 1 : null), 60000);
  ok('and you can browse in it again', !!again, again ? '' : JSON.stringify(await ui()) + ' | view ' + JSON.stringify((await view()).station));

  // E — closing the window does not close the browser; the globe brings it back
  await evalJS(cdp, "(document.querySelector('.term.browser-win .term-x').click(), 1)");
  await sleep(1500);
  ok('closing the window leaves the browser open', (await view()).station.open === true);
  await evalJS(cdp, "(document.getElementById('comms-browser').click(), 1)");
  ok('the globe reopens it on the same page', !!(await until(() => ui().then(u => u && u.mode === 'live' && u.url === HOME && u.pic ? 1 : null), 20000)));

  // F — a page an agent MADE still opens as a PAGE, one chip from the browser
  await sendIdle(cdp, 'build me a web page');
  ok('an agent run wrote a page', !!(await until(() => evalJS(cdp, "(() => { const a=[...document.querySelectorAll('#chat-log a.deliverable-link')].find(x=>/index\\.html$/.test(x.title||x.textContent)); return a ? 1 : null; })()"), 120000)));
  ok('a run that never browsed did not become the driver', (await view()).station.driver === null);
  await evalJS(cdp, "([...document.querySelectorAll('#chat-log a.deliverable-link')].find(x=>/index\\.html$/.test(x.title||x.textContent)).click(), 1)");
  ok('clicking the COMMS row shows the PAGE', (await until(() => ui().then(u => u.mode === 'page' && u.st === 'live' ? u.url : null), 20000)) === 'site/index.html');
  const f1 = await until(() => inFrame(cdp, '/view/~t/', "({ title: document.title, color: getComputedStyle(document.getElementById('h')).color, origin: self.origin })").then(v => v && v.title === 'script-ran' && v.color === 'rgb(255, 0, 0)' ? v : null), 20000);
  ok('the page runs sandboxed (script ran, css loaded, opaque origin)', f1 && f1.origin === 'null', JSON.stringify(f1));
  const chips = await evalJS(cdp, "[...document.querySelectorAll('.ob-recent .ob-chip')].map(b=>b.textContent.trim())");
  ok('the BROWSER is one chip away', chips.includes('BROWSER'), JSON.stringify(chips));
  await evalJS(cdp, "([...document.querySelectorAll('.ob-recent .ob-chip')].find(b=>b.textContent.trim()==='BROWSER').click(), 1)");
  ok('…and clicking it returns to it', !!(await until(() => ui().then(u => u.mode === 'live' && u.pic ? 1 : null), 15000)));

  const os = await evalJS(cdp, "[...document.querySelectorAll('.term.browser-win button, .term.browser-win input')].map(b=>{const s=getComputedStyle(b);return {t:(b.textContent||b.className).trim().slice(0,20),bg:s.backgroundColor,bd:s.borderTopColor}}).filter(x=>/rgb\\(255, 255, 255\\)|rgb\\(239, 239, 239\\)/.test(x.bg)||/rgb\\(118, 118, 118\\)/.test(x.bd))");
  ok('no white/OS-painted controls in the window', os.length === 0, JSON.stringify(os));
  ok('no page exceptions', diag.exceptions.length === 0, diag.exceptions.slice(0, 3).join(' | '));
  console.log('console errors/warnings:', JSON.stringify(diag.consoleMsgs.slice(0, 8)));
  // QUIT: quitting StarNet closes the shared Chrome window too (it used to stay open with a dead network proxy)
  {
    const mine = () => chromeProcs(['browser-profile', basename(scratch)]);
    await type('127.0.0.1:' + site.port);
    await until(() => view().then(v => v.station.open ? 1 : null), 60000, 500);
    ok('before quitting, the shared Chrome window is running', mine().length >= 1, mine().map(r => r.pid).join(','));
    const q = await evalJS(cdp, "fetch('/api/lifecycle/quit',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.status).catch(e=>'ERR '+e.message)");
    ok('the app can ask the station to shut down cleanly', q === 202, String(q));
    const gone = await until(async () => mine().length === 0 ? 1 : null, 20000, 500);
    ok('after quitting, the shared Chrome window is gone (not left open and broken)', !!gone, mine().map(r => r.pid).join(','));
  }
} catch (e) {
  ok('script threw', false, e && e.stack || String(e));
  console.log('mockLog tail', JSON.stringify(mockLog.slice(-6)));
} finally {
  try { chrome && chrome.proc.kill(); } catch (_) {}
  try { sidecar.kill(); } catch (_) {}
  try { mock.server.close(); site.server.close(); } catch (_) {}
  const bad = results.filter(r => !r.ok);
  console.log('\n' + (results.length - bad.length) + '/' + results.length + ' passed');
  await sleep(500);
  process.exit(bad.length ? 1 : 0);
}
