/* node test/station-control-gaps.e2e.test.mjs — the lane-3 station actions END TO END, in real Chromium (2026-10-05,
   "100% full freedom with the harness").

   The unit suite pins each action's route and tier against stubs. This proves the chain: a MOCK lead finds the tools with
   tool_search and calls them → the REAL sidecar tools → page actions over the REAL station bridge and route actions through
   the sidecar's OWN route table in-process → then every change is held to what the station really shows: the server's own
   GET routes, the page's saved notifications, and — for the E-STOP — the halt state and the top bar's RESUME AUTOMATION.

   Isolated like station-control.e2e: fresh seeded workspace, APPDATA/LOCALAPPDATA/USERPROFILE/HOME/HERMES_HOME in scratch,
   a fresh Chrome profile, OS-picked ports, a local mock model. Skips LOUDLY with no Chromium. In test:http. */
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
if (!chromePath) { console.log('station-control-gaps.e2e: SKIPPED — no Chromium installed (this box cannot run the live bridge)'); process.exit(0); }

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

const MARK = 'STATION-GAPS-E2E';
// the mock lead: a request whose LATEST user message carries MARK plays mock.script one call per turn (counting the tool
// results after that message), and every request records the results so far — the E-STOP may end the run before a reply
function startMock() {
  const mock = { script: [], results: [] };
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
      const mine = lastUser >= 0 && JSON.stringify(msgs[lastUser].content || '').indexOf(MARK) >= 0 && (p.tools || []).length > 0;
      const answered = msgs.slice(lastUser + 1).filter(m => m && m.role === 'tool');
      if (mine) mock.results = answered.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      if (mine && answered.length < mock.script.length) {
        const c = mock.script[answered.length];
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + answered.length, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] });
        send({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
      } else {
        send({ choices: [{ delta: { content: 'Done.' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
      }
      res.write('data: [DONE]\n\n'); res.end();
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => { mock.server = server; mock.base = 'http://127.0.0.1:' + server.address().port + '/api/v1'; r(mock); }));
}
const api = async (base, token, method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: base }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, json: j };
};

const root = mkdtempSync(join(tmpdir(), 'starnet-gaps-e2e-'));
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

const NOTIFS = `(() => { try { return (JSON.parse(localStorage.getItem('starnet.station.v1')) || {}).notifs || []; } catch (_) { return null; } })()`;
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

  // two notifications the way the station raises them: a finished result, and one still WAITING on the Commander
  await evalJS(cdp, `(() => { StationUI.notify('E2E finished result', '', undefined, { kind: 'result' }); StationUI.notify('E2E agent waiting on you', '', undefined, { kind: 'needs', key: 'e2e-needs' }); return true; })()`);
  const seeded = await evalJS(cdp, NOTIFS);
  check('setup: a result and a NEEDS YOU notification are saved', Array.isArray(seeded) && seeded.some(n => n.kind === 'result') && seeded.some(n => n.kind === 'needs'), JSON.stringify((seeded || []).map(n => n.kind)));
  // the NOTIFICATIONS window's counts include the NEEDS YOU row it shows, and "New" is the bell badge's own number
  await evalJS(cdp, `(() => { StationUI.openTerm('notifs'); return true; })()`); await sleep(400);
  const counts = await evalJS(cdp, `(() => ({ all: (document.querySelector('[data-nf-view="all"]') || {}).textContent, fresh: (document.querySelector('[data-nf-view="unread"]') || {}).textContent,
    bell: (document.getElementById('nf-badge') || {}).textContent, needs: document.querySelectorAll('.nf-list-needs .nf').length, rest: document.querySelectorAll('.nf-list:not(.nf-list-needs) .nf').length }))()`);
  check('NOTIFICATIONS counts what it shows: All · 2, New · 2 = the bell', counts && counts.all === 'All · 2' && counts.fresh === 'New · 2' && counts.bell === '2' && counts.needs === 1 && counts.rest === 1, JSON.stringify(counts));
  await evalJS(cdp, `(() => { StationUI.closeTerm('notifs'); return true; })()`);
  const halt0 = await api(base, token, 'GET', '/api/halt');
  check('setup: the station is not halted', halt0.json && halt0.json.halted === false, JSON.stringify(halt0.json));

  mock.script = [
    { name: 'tool_search', args: { query: 'station settings' } },                                                                   // 0
    { name: 'station_control', args: { action: 'away.queue', args: { agent: 'agent', title: 'E2E-AWAY tidy the docs' } } },           // 1
    { name: 'station_settings', args: { section: 'away', agent: 'agent' } },                                                         // 2
    { name: 'station_control', args: { action: 'browser.mode', args: { mode: 'window' } } },                                          // 3
    { name: 'station_control', args: { action: 'notifications.clear', args: {} } },                                                  // 4
    { name: 'station_control', args: { action: 'deliverables.cleanup', args: {} } },                                                 // 5
    { name: 'station_control', args: { action: 'limits.set', args: { maxIters: 150 } } },                                            // 6 (refused: an escalation)
    { name: 'station_power', args: { action: 'limits.set', args: { maxIters: 150 } } },                                              // 7
    { name: 'station_settings', args: { section: 'limits' } },                                                                       // 8
    { name: 'station_control', args: { action: 'estop.engage', args: {} } }                                                           // 9
  ];
  const res = await fetch(base + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: base },
    body: JSON.stringify({ key: 'sk-or-v1-fake', model: 'test/model', agentId: 'agent', isTask: true, messages: [{ role: 'user', content: MARK + ' queue tidy-the-docs as away work, browser in its own window, clear my notifications, clean up deliverables, max 150 steps, then hit the E-STOP' }] }) });
  await res.text();
  const R = mock.results;
  check('the lead received every tool result', R.length === mock.script.length, R.length + ' of ' + mock.script.length);
  const done = i => typeof R[i] === 'string' && /^{"done":"/.test(R[i]);
  check('tool_search reveals the station tools', /station[._]control/.test(R[0] || ''), (R[0] || '').slice(0, 200));
  check('away.queue: done', done(1), (R[1] || '').slice(0, 200));
  check('station_settings away: the queued item is listed with its id', /E2E-AWAY tidy the docs/.test(R[2] || '') && /"id":"/.test(R[2] || ''), (R[2] || '').slice(0, 300));
  check('browser.mode: done', done(3), (R[3] || '').slice(0, 200));
  check('notifications.clear: done', done(4) && /"cleared":1/.test(R[4]) && /"waiting":1/.test(R[4]), (R[4] || '').slice(0, 200));
  check('deliverables.cleanup: done (an empty library clears nothing, honestly)', done(5) && /"removed":0/.test(R[5]) && /nothing to clear/.test(R[5]), (R[5] || '').slice(0, 200));
  check('⛔ limits.set through station_control is refused (an escalation)', /^REFUSED: .*station\.power/.test(R[6] || ''), (R[6] || '').slice(0, 200));
  check('limits.set through station_power: done', done(7), (R[7] || '').slice(0, 200));
  check('station_settings limits shows maxIters saved at 150', /"maxIters":\{[^}]*"saved":150/.test(R[8] || ''), (R[8] || '').slice(0, 300));
  check('estop.engage: the result says ENGAGING (never "halted")', done(9) && /"engaging":true/.test(R[9]) && /stops this run too/.test(R[9]), (R[9] || '').slice(0, 260));

  // ---- held to what the station really shows ----
  const backlog = await api(base, token, 'GET', '/api/workshop/backlog?agent=agent');
  check('server: the away queue holds the item', !!(backlog.json && (backlog.json.items || []).some(i => i.title === 'E2E-AWAY tidy the docs')), JSON.stringify(backlog.json && backlog.json.items));
  const browser = await api(base, token, 'GET', '/api/browser/settings');
  check('server: the browser mode is window', browser.json && browser.json.mode === 'window', JSON.stringify(browser.json && { mode: browser.json.mode }));
  const knobs = await api(base, token, 'GET', '/api/runtime/knobs');
  check('server: maxIters is saved at 150', knobs.json && knobs.json.fields && knobs.json.fields.maxIters && knobs.json.fields.maxIters.saved === 150, JSON.stringify(knobs.json && knobs.json.fields && knobs.json.fields.maxIters));
  const after = await evalJS(cdp, NOTIFS);
  check('page: the finished result was cleared, the NEEDS YOU entry stayed', Array.isArray(after) && after.length === 1 && after[0].kind === 'needs', JSON.stringify((after || []).map(n => n.kind + ':' + n.txt)));
  let halted = null;
  for (let i = 0; i < 40; i++) { const h = await api(base, token, 'GET', '/api/halt'); if (h.json && h.json.halted) { halted = h.json; break; } await sleep(250); }
  check('server: the E-STOP engaged (after the result was handed back)', !!halted, JSON.stringify(halted));
  let resumeShown = false;
  for (let i = 0; i < 40 && !resumeShown; i++) { resumeShown = await evalJS(cdp, `(() => { const b = document.getElementById('automation-resume'); return !!b && !b.hidden && getComputedStyle(b).display !== 'none'; })()`); if (!resumeShown) await sleep(250); }
  check('page: the top bar shows RESUME AUTOMATION (the Commander\'s door back)', resumeShown);
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
if (failures.length) { console.log('station-control-gaps.e2e: ' + failures.length + ' FAILED'); process.exit(1); }
console.log('station-control-gaps.e2e: ALL PASS');
