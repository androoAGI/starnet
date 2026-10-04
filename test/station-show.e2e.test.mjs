/* node test/station-show.e2e.test.mjs — station.show END TO END, in real Chromium (2026-10-04, "so it can basically use
   itself instead of the user having to navigate").

   The unit suite proves the tool and the page verb against a recorded StationUI. Only this proves the chain a Commander
   meets: they TYPE "show me …" into COMMS → a MOCK model finds the deferred tool with tool_search and calls station_show
   → the REAL sidecar tool → the REAL station bridge → stationcommands.js station.show → StationUI's own doors → the window
   is really on screen, raised, on the right tab. Then the guard: a run the Commander is NOT watching (a direct /api/run,
   like a routine or a phone turn) is refused and opens nothing.

   Isolated exactly like station-control.e2e: fresh seeded workspace, APPDATA/LOCALAPPDATA/USERPROFILE/HOME/HERMES_HOME in
   scratch, a fresh Chrome profile, OS-picked ports, a local mock model. Skips LOUDLY with no Chromium. In test:http. */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { findChrome, connectCDP, evalJS, collectDiagnostics, sleep } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, waitUp, waitDevReady } from '../scripts/lib/seed.mjs';
const require = createRequire(import.meta.url);
const { bootToken } = require('./_httpToken.js');

let chromePath = null;
try { chromePath = findChrome(); } catch (_) { chromePath = null; }
if (!chromePath) { console.log('station-show.e2e: SKIPPED — no Chromium installed (this box cannot run the live bridge)'); process.exit(0); }

const failures = [];
const check = (name, ok, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); if (!ok) failures.push(name); };
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const a = server.address(); server.close(e => e ? reject(e) : resolve(a.port)); });
});
const stopChild = (child) => new Promise(resolve => {
  if (!child || child.exitCode != null) { resolve(); return; }
  const timer = setTimeout(resolve, 6000);
  child.once('exit', () => { clearTimeout(timer); resolve(); });
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => { try { child.kill('SIGKILL'); } catch {} });
    else child.kill('SIGKILL');
  } catch (_) { clearTimeout(timer); resolve(); }
});

const MARK = 'STATION-SHOW-E2E';
// the mock model: a request whose LATEST user message carries mock.phase plays mock.script one call per turn (counting only the
// tool results after that message — a second ask carries the first ask's history), then answers in words
function startMock() {
  const mock = { script: [], results: [], phase: MARK, seen: [] };
  const server = http.createServer((req, res) => {
    if (req.url.indexOf('/models') >= 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    }
    if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); return res.end(); }
    let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
      let p = {}; try { p = JSON.parse(body); } catch (_) {}
      const msgs = p.messages || [];
      let lastUser = -1; for (let k = msgs.length - 1; k >= 0; k--) if (msgs[k] && msgs[k].role === 'user') { lastUser = k; break; }
      const mine = lastUser >= 0 && JSON.stringify(msgs[lastUser].content || '').indexOf(mock.phase) >= 0 && (p.tools || []).length > 0;
      const answered = msgs.slice(lastUser + 1).filter(m => m && m.role === 'tool');
      mock.seen.push({ user: lastUser >= 0 ? JSON.stringify(msgs[lastUser].content || '').slice(0, 90) : null, tools: (p.tools || []).length, answered: answered.length });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      if (mine && answered.length < mock.script.length) {
        const c = mock.script[answered.length];
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + answered.length, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] });
        send({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
      } else {
        if (mine) mock.results = answered.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
        send({ choices: [{ delta: { content: 'Done.' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
      }
      res.write('data: [DONE]\n\n'); res.end();
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => { mock.server = server; mock.base = 'http://127.0.0.1:' + server.address().port + '/api/v1'; r(mock); }));
}

// what is on screen: every open window (title, minimized, z) and the active rail/tab item inside each
const SCREEN = `(() => [...document.querySelectorAll('.term')].filter(w => w.isConnected).map(w => ({
  title: ((w.querySelector('.term-title') || {}).textContent || '').trim(),
  z: parseInt(w.style.zIndex, 10) || 0, hidden: w.hidden || getComputedStyle(w).display === 'none',
  active: [...w.querySelectorAll('[aria-selected="true"]')].map(x => x.textContent.replace(/\\s+/g, ' ').trim()).filter(Boolean) })))()`;

const root = mkdtempSync(join(tmpdir(), 'starnet-show-e2e-'));
const iso = {};
for (const [k, d] of [['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata'], ['USERPROFILE', 'home'], ['HOME', 'home'], ['HERMES_HOME', 'hermes']]) { iso[k] = join(root, 'iso', d); mkdirSync(iso[k], { recursive: true }); }
const workspace = join(root, 'workspace'), profile = join(root, 'profile');
const mock = await startMock();
const appPort = await freePort(), cdpPort = await freePort();
const base = 'http://127.0.0.1:' + appPort;
materializeSeedWorkspace(workspace, 'test/model');
const sidecar = bootSeededSidecar({ port: appPort, scratchDir: workspace, model: 'test/model', key: 'sk-or-v1-fake', env: Object.assign({ SKYNET_OPENROUTER_BASE: mock.base }, iso) });
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--hide-scrollbars', '--mute-audio',
  '--remote-debugging-port=' + cdpPort, '--window-size=1440,900', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

let cdp = null;
try {
  check('isolated seeded sidecar starts', await waitUp(base + '/'));
  const token = await bootToken(base, base);
  cdp = await connectCDP(cdpPort);
  cdp.timeoutMs = 45000;
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  const diagnostics = collectDiagnostics(cdp);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 60); window.cancelAnimationFrame = id => clearTimeout(id);' });
  await cdp.send('Page.navigate', { url: base + '/' });
  check('the real page reaches the live station', await waitDevReady(cdp, evalJS, { url: base + '/', tries: 60 }));
  const hero = await evalJS(cdp, `(() => { const h = App.agents().find(a => a.id === 'agent'); return h && h.name; })()`);
  const before = await evalJS(cdp, SCREEN);
  check('no window is open before the ask', Array.isArray(before) && before.length === 0, JSON.stringify(before));

  // ---- the Commander TYPES the ask into COMMS; the lead shows four places, then one that cannot exist ----
  mock.script = [
    { name: 'tool_search', args: { query: 'open a window to show the Commander' } },
    { name: 'station_show', args: { place: 'deliverables' } },
    { name: 'station_show', args: { place: 'settings-spending' } },
    { name: 'station_show', args: { place: 'agent-config', agent: String(hero || '').toLowerCase() } },
    { name: 'station_show', args: { place: 'agent', agent: 'Nobody-Here' } },
    { name: 'station_show', args: { place: 'recruit' } }
  ];
  await evalJS(cdp, `(() => { const t = document.getElementById('chat-input'); t.value = ${JSON.stringify(MARK + ' show me my deliverables, my spending limits, your config, and the recruitment bay')}; t.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('chat-send').click(); return true; })()`);
  for (let i = 0; i < 360 && mock.results.length < mock.script.length; i++) await sleep(500);   // ≤3 min: a loaded gate is slow
  const R = mock.results;
  check('the model received every result', R.length === mock.script.length, R.length + ' of ' + mock.script.length + (R.length === mock.script.length ? '' : ' :: model saw ' + JSON.stringify(mock.seen.slice(-8)) + ' :: COMMS ' + JSON.stringify(await evalJS(cdp, `(() => ({ busy: !!(Chat.isBusy && Chat.isBusy()), input: (document.getElementById('chat-input') || {}).value, lines: [...document.querySelectorAll('#chat .msg, #chat-log > *')].slice(-4).map(x => x.innerText.slice(0, 120)) }))()`))));
  check('tool_search reveals station_show', /station[._]show/.test(R[0] || ''), (R[0] || '').slice(0, 300));
  check('shown: MY WORK › DELIVERABLES', /^OPEN on the Commander's screen: MY WORK › DELIVERABLES/.test(R[1] || ''), (R[1] || '').slice(0, 200));
  check('shown: SETTINGS › SPENDING LIMITS', /^OPEN on the Commander's screen: SETTINGS › SPENDING LIMITS/.test(R[2] || ''), (R[2] || '').slice(0, 200));
  check('shown: the hero\'s CONFIG (by name, any case)', new RegExp('^OPEN on the Commander\'s screen: CREW › AGENTS › CONFIG for ' + hero).test(R[3] || ''), (R[3] || '').slice(0, 200));
  check('an agent that does not exist is refused with the real crew', /^REFUSED: no agent called "Nobody-Here" \(crew: /.test(R[4] || ''), (R[4] || '').slice(0, 200));
  check('shown: the Recruitment Bay', /^OPEN on the Commander's screen: CREW › RECRUIT/.test(R[5] || ''), (R[5] || '').slice(0, 200));

  // ---- the screen really shows it ----
  await sleep(600);
  const screen = await evalJS(cdp, SCREEN) || [];
  const win = re => screen.find(w => re.test(w.title));
  // a ONE MENU window is titled by its menu (MY WORK) with the member's tab active
  const isDlv = w => /^MY WORK/.test(w.title) && w.active.some(t => /^DELIVERABLES/.test(t));
  const dlv = screen.find(isDlv), set = win(/^SETTINGS/), dos = win(/DOSSIER/), bay = screen.slice().sort((a, b) => b.z - a.z)[0];
  check('screen: DELIVERABLES is open', !!dlv && !dlv.hidden, JSON.stringify(screen.map(w => w.title)));
  check('screen: SETTINGS is open on SPENDING LIMITS', !!set && set.active.some(t => /SPENDING LIMITS/.test(t)), JSON.stringify(set));
  check('screen: the dossier is open on CONFIG', !!dos && dos.active.some(t => /^CONFIG/.test(t)), JSON.stringify(dos));
  check('screen: the last place shown (the Recruitment Bay) is on top', !!bay && /RECRUITMENT BAY/.test(bay.title), JSON.stringify(bay));

  // a buried window is RAISED when shown again — the Commander sees it, not a window behind another
  mock.results = []; mock.phase = MARK + '-AGAIN';
  mock.script = [{ name: 'station_show', args: { place: 'deliverables' } }];
  for (let i = 0; i < 360 && await evalJS(cdp, 'Chat.isBusy && Chat.isBusy()'); i++) await sleep(500);   // the first ask's run has ended
  await evalJS(cdp, `(() => { const t = document.getElementById('chat-input'); t.value = ${JSON.stringify(MARK + '-AGAIN show me my deliverables again')}; t.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('chat-send').click(); return true; })()`);
  for (let i = 0; i < 360 && mock.results.length < 1; i++) await sleep(500);
  const top = ((await evalJS(cdp, SCREEN)) || []).sort((a, b) => b.z - a.z)[0];
  check('a buried DELIVERABLES is raised to the top', !!top && isDlv(top), JSON.stringify(top));
  const count = ((await evalJS(cdp, SCREEN)) || []).filter(w => /^MY WORK/.test(w.title)).length;
  check('raised, not duplicated', count === 1, count + ' DELIVERABLES windows');

  // ---- ⛔ a run the Commander is NOT watching (a direct /api/run: a routine, a phone turn) moves nothing ----
  await evalJS(cdp, `(() => { document.querySelectorAll('.term .term-x, .term [aria-label^="Close"]').forEach(b => { try { b.click(); } catch (_) {} }); return true; })()`);
  await sleep(800);
  const cleared = ((await evalJS(cdp, SCREEN)) || []).length;
  mock.results = []; mock.phase = MARK + '-UNWATCHED';
  mock.script = [{ name: 'tool_search', args: { query: 'open a window to show the Commander' } }, { name: 'station_show', args: { place: 'settings' } }];
  const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: base };
  const res = await fetch(base + '/api/run', { method: 'POST', headers, body: JSON.stringify({ key: 'sk-or-v1-fake', model: 'test/model', agentId: 'agent', isTask: true, messages: [{ role: 'user', content: MARK + '-UNWATCHED open my settings' }] }) });
  await res.text();
  check('unwatched run: the model was told the screen was left alone', /^REFUSED: the Commander is not looking at this conversation/.test(mock.results[1] || ''), (mock.results[1] || '').slice(0, 200));
  const after = ((await evalJS(cdp, SCREEN)) || []).filter(w => /^SETTINGS/.test(w.title));
  check('unwatched run: no SETTINGS window appeared', after.length === 0, 'cleared to ' + cleared + ' windows; settings now ' + after.length);

  const errs = (diagnostics.exceptions || []).filter(e => !/favicon|ERR_ABORTED|net::ERR/i.test(String(e)));
  check('no uncaught page exceptions', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  check('the e2e ran to the end', false, (e && e.stack) || String(e));
} finally {
  try { if (cdp) cdp.close(); } catch (_) {}
  await stopChild(chrome); await stopChild(sidecar);
  try { mock.server.close(); } catch (_) {}
  try { rmSync(root, { recursive: true, force: true }); } catch (_) {}
}
if (failures.length) { console.log('station-show.e2e: ' + failures.length + ' FAILED'); process.exit(1); }
console.log('station-show.e2e: ALL PASS');
