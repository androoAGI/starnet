// GENERATED from the live proofs run on Windows (browser-view lane, 2026-10-01). Portable: node scripts/qa/browser-live/station-signin.proof.mjs <outDir>
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
  'go to github so i can sign in': [
    { re: /^brief.?proceed$/, args: { objective: 'Open GitHub sign-in so the Commander can sign in' } },
    { re: /^browser.?login$/, args: { url: 'https://github.com/login' }, q: 'open a visible browser login window so the user can sign in' }
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
  env: Object.assign({}, process.env, extra, { SKYNET_DEV: '1', SKYNET_WORKSPACES: wsDir, SKYNET_PORT: String(port), SKYNET_DEFAULT_MODEL: MODEL, SKYNET_OPENROUTER_KEY: 'sk-or-v1-obproof-fake' }) });
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

  const shotTo = async name => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); };

  // 1. open the BROWSER window first (as Andrew did): it must NOT start on an error page
  await evalJS(cdp, "(document.getElementById('comms-browser').click(), 1)");
  await sleep(6000);   // the window warms the browser in the background
  const fresh = await evalJS(cdp, "fetch('/api/browser/view/frame?target=station&after=0').then(r=>r.json()).then(j=>({ok:j.ok, url:j.page&&j.page.url, code:j.code}))");
  ok('a freshly started browser shows a BLANK page, never the 403 probe page', fresh && fresh.ok && /^about:blank$/.test(fresh.url || ''), JSON.stringify(fresh));

  // 2. "go to github so i can sign in"
  await sendIdle(cdp, 'go to github so i can sign in');
  const card = await until(() => evalJS(cdp, "(() => { const b=[...document.querySelectorAll('#chat-log .consent-btn')].find(x=>/open login window/i.test(x.textContent)); return b ? 1 : null; })()"), 120000, 500);
  ok('the agent asks to open a sign-in window (the reliable flow)', !!card, JSON.stringify(mockLog.slice(-3)));
  await shotTo('login-ask');
  await evalJS(cdp, "([...document.querySelectorAll('#chat-log .consent-btn')].find(x=>/open login window/i.test(x.textContent)).click(), 1)");
  const doneCard = await until(() => evalJS(cdp, "(() => { const b=[...document.querySelectorAll('#chat-log .consent-btn')].find(x=>/^\\s*done/i.test(x.textContent)); return b ? b.textContent.trim() : null; })()"), 60000, 500);
  ok('the card waits for your DONE', !!doneCard, String(doneCard));
  const onGithub = await until(() => evalJS(cdp, "fetch('/api/browser/view/frame?target=station&after=0').then(r=>r.json()).then(j=>j.page&&j.page.url)").then(u => /github\.com\/login/.test(u || '') ? u : null), 60000, 1000);
  ok('the shared browser is on github.com/login', !!onGithub, String(onGithub));
  const st6 = (await view()).station;
  ok('DEFAULT = a real Chrome window on the desktop (what Hermes does)', st6.mode === 'window' && st6.visible === true, JSON.stringify(st6));
  const headed = chromeProcs(['browser-profile', basename(scratch)]);
  ok('that window is a REAL, headed Chrome on this station\'s profile (not a hidden one)', headed.length >= 1, headed.map(r => r.cmd.split(' ')[0]).join(' | ').slice(0, 200));
  const shown = await until(() => ui().then(u => u && u.mode === 'live' && /github\.com\/login/.test(u.url) && u.pic ? u : null), 20000);
  ok('the BROWSER window opened by itself on the GitHub sign-in page (it follows the real window; no relaunch)', !!shown, JSON.stringify(shown || await ui()));
  const signing = await until(() => ui().then(u => u && /Sign in here/.test(u.note) && u.who === 'YOU' ? u : null), 15000);
  ok('during the sign-in the window says SIGN IN HERE and the wheel is YOURS', !!signing, JSON.stringify(signing || await ui()));
  const typed = await evalJS(cdp, "fetch('/api/browser/view/input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({events:[{type:'text',text:'andrew'}]})}).then(r=>r.status)");
  ok('your typing reaches the sign-in page (accepted, not refused)', typed === 200, String(typed));
  await shotTo('login-window');
  await evalJS(cdp, "([...document.querySelectorAll('#chat-log .consent-btn')].find(x=>/^\\s*done/i.test(x.textContent)).click(), 1)");
  await until(() => evalJS(cdp, "((document.getElementById('chat-log')||{}).innerText||'').split('RUN COMPLETE').length - 1").then(n => n >= sends ? true : null), 120000, 500);
  const after = await view();
  ok('after DONE the run finishes and the station browser is still there, nobody driving', after.station.open === true && after.station.driver === null, JSON.stringify(after.station));
  await type('127.0.0.1:' + site.port);
  ok('and you can keep browsing in it', !!(await until(() => ui().then(u => u && u.mode === 'live' && u.url === HOME && u.pic ? 1 : null), 60000)), JSON.stringify(await ui()));
  ok('no page exceptions', diag.exceptions.length === 0, diag.exceptions.slice(0, 3).join(' | '));
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
