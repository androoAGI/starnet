/* node test/find-window.e2e.test.mjs — FIND (Ctrl+K) END TO END, in real Chromium (2026-10-05, self-driving lane 4:
   "WAAY easier to use and navigate").

   A real seeded station page: Ctrl+K opens FIND as a docked station window with the cursor in its field; typing filters
   every place / crew tab / conversation; Enter opens the result through Places.open — the SAME opener the agent's
   station.show uses — and FIND steps aside; a query that matches nothing still has a way forward (ASK THE CREW types it
   into COMMS, never sends it). It also holds the window to the glass recipe (8px field, 10px rows, nothing under 14px)
   and writes screenshots for a human look (SKYNET_SHOT_DIR, default the OS temp dir).

   Isolated like station-show.e2e: fresh seeded workspace, APPDATA/LOCALAPPDATA/USERPROFILE/HOME/HERMES_HOME in scratch,
   a fresh Chrome profile, OS-picked ports. No model calls. Skips LOUDLY with no Chromium. In test:http. */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome, connectCDP, evalJS, collectDiagnostics, sleep } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, waitUp, waitDevReady } from '../scripts/lib/seed.mjs';

let chromePath = null;
try { chromePath = findChrome(); } catch (_) { chromePath = null; }
if (!chromePath) { console.log('find-window.e2e: SKIPPED — no Chromium installed (this box cannot run the live page)'); process.exit(0); }

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

const SCREEN = `(() => [...document.querySelectorAll('.term')].filter(w => w.isConnected).map(w => ({
  title: ((w.querySelector('.term-title') || {}).textContent || '').trim(), z: parseInt(w.style.zIndex, 10) || 0,
  active: [...w.querySelectorAll('[aria-selected="true"]')].map(x => x.textContent.replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 4) })))()`;
const CTRL_K = `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`;
const TYPE = q => `(() => { const f = document.querySelector('.find-win .fnd-field'); if (!f) return false; f.value = ${JSON.stringify(q)}; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
const KEY = k => `(() => { const f = document.querySelector('.find-win .fnd-field'); if (!f) return false; f.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true })); return true; })()`;
const ROWS = `(() => [...document.querySelectorAll('.find-win .fnd-row')].map(r => ({ name: (r.querySelector('.fnd-n') || {}).textContent, on: r.classList.contains('on') })))()`;

const shotDir = process.env.SKYNET_SHOT_DIR || tmpdir();
const root = mkdtempSync(join(tmpdir(), 'starnet-find-e2e-'));
const iso = {};
for (const [k, d] of [['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata'], ['USERPROFILE', 'home'], ['HOME', 'home'], ['HERMES_HOME', 'hermes']]) { iso[k] = join(root, 'iso', d); mkdirSync(iso[k], { recursive: true }); }
const workspace = join(root, 'workspace'), profile = join(root, 'profile');
const appPort = await freePort(), cdpPort = await freePort();
const base = 'http://127.0.0.1:' + appPort;
materializeSeedWorkspace(workspace, 'test/model');
const sidecar = bootSeededSidecar({ port: appPort, scratchDir: workspace, model: 'test/model', key: 'sk-or-v1-fake', env: Object.assign({ SKYNET_OPENROUTER_BASE: 'http://127.0.0.1:9/api/v1' }, iso) });
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--hide-scrollbars', '--mute-audio',
  '--remote-debugging-port=' + cdpPort, '--window-size=1440,900', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

let cdp = null;
async function shot(name) {
  try { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); const p = join(shotDir, 'find-' + name + '.png'); writeFileSync(p, Buffer.from(r.data, 'base64')); console.log('[shot] ' + p); } catch (e) { console.log('[shot] ' + name + ' skipped: ' + ((e && e.message) || e)); }
}
try {
  check('isolated seeded sidecar starts', await waitUp(base + '/'));
  cdp = await connectCDP(cdpPort);
  cdp.timeoutMs = 45000;
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  const diagnostics = collectDiagnostics(cdp);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 60); window.cancelAnimationFrame = id => clearTimeout(id);' });
  await cdp.send('Page.navigate', { url: base + '/' });
  check('the real page reaches the live station', await waitDevReady(cdp, evalJS, { url: base + '/', tries: 60 }));
  const hero = await evalJS(cdp, `(() => { const h = App.agents().find(a => a.id === 'agent'); return h && h.name; })()`);
  check('the dock offers SYSTEM › FIND', await evalJS(cdp, `!!document.querySelector('#bottombar .bb[data-term="find"]')`));

  // ---- Ctrl+K: FIND opens, docked, the cursor in its field ----
  await evalJS(cdp, CTRL_K); await sleep(400);
  let screen = await evalJS(cdp, SCREEN);
  check('Ctrl+K opens FIND as a station window', (screen || []).some(w => w.title === 'FIND'), JSON.stringify(screen));
  check('the cursor is in the FIND field', await evalJS(cdp, `document.activeElement === document.querySelector('.find-win .fnd-field')`));
  let rows = await evalJS(cdp, ROWS);
  check('an empty field lists the places (and each crew member)', rows.length >= 40 && rows.some(r => r.name === 'MY WORK › DELIVERABLES') && rows.some(r => r.name === String(hero).toUpperCase() + ' › BRIEF'), rows.length + ' rows');
  const look = await evalJS(cdp, `(() => { const f = getComputedStyle(document.querySelector('.find-win .fnd-field')), r = getComputedStyle(document.querySelector('.find-win .fnd-row')), l = getComputedStyle(document.querySelector('.find-win .fnd-l'));
    return { fieldRadius: f.borderRadius, fieldBg: f.backgroundColor, rowRadius: r.borderRadius, nameSize: getComputedStyle(document.querySelector('.find-win .fnd-n')).fontSize, lineSize: l.fontSize, glow: f.textShadow }; })()`);
  check('glass recipe: 8px recessed field, 10px rows, text ≥14px, no glow', look && look.fieldRadius === '8px' && look.rowRadius === '10px' && parseFloat(look.lineSize) >= 14 && parseFloat(look.nameSize) >= 16 && /none/.test(look.glow), JSON.stringify(look));
  await shot('empty');

  // ---- type, Enter: the place opens through its own door, FIND steps aside ----
  await evalJS(cdp, TYPE('spend')); await sleep(200);
  rows = await evalJS(cdp, ROWS);
  check('"spend" ranks SETTINGS › SPENDING LIMITS first', rows[0] && rows[0].name === 'SETTINGS › SPENDING LIMITS' && rows[0].on, JSON.stringify(rows.slice(0, 3)));
  check('a typed query always ends with ASK THE CREW', rows.length && rows[rows.length - 1].name === 'ASK THE CREW');
  await shot('spend');
  await evalJS(cdp, KEY('Enter')); await sleep(700);
  screen = await evalJS(cdp, SCREEN);
  const set = (screen || []).find(w => w.title === 'SETTINGS');
  check('Enter opens SETTINGS on SPENDING LIMITS', !!set && set.active.some(t => /SPENDING LIMITS/.test(t)), JSON.stringify(screen));
  check('FIND stepped aside', !(screen || []).some(w => w.title === 'FIND'));

  // ---- an agent by name, arrows to choose ----
  await evalJS(cdp, CTRL_K); await sleep(400);
  await evalJS(cdp, TYPE(String(hero).toLowerCase() + ' config')); await sleep(200);
  rows = await evalJS(cdp, ROWS);
  check('"<lead> config" finds the lead\'s CONFIG tab', rows[0] && rows[0].name === String(hero).toUpperCase() + ' › CONFIG', JSON.stringify(rows.slice(0, 3)));
  await evalJS(cdp, KEY('ArrowDown')); await evalJS(cdp, KEY('ArrowUp')); await sleep(100);
  await evalJS(cdp, KEY('Enter')); await sleep(800);
  screen = await evalJS(cdp, SCREEN);
  const dos = (screen || []).find(w => /DOSSIER/.test(w.title));
  check('Enter opens the dossier on CONFIG', !!dos && dos.active.some(t => /^CONFIG/.test(t)), JSON.stringify(dos));

  // ---- nothing matches: the words go to the crew, typed in, never sent ----
  await evalJS(cdp, `(() => { document.getElementById('chat-input').value = ''; return true; })()`);
  await evalJS(cdp, CTRL_K); await sleep(400);
  await evalJS(cdp, TYPE('zzqx how do i make my agents sing')); await sleep(200);
  rows = await evalJS(cdp, ROWS);
  check('a query that matches nothing offers only ASK THE CREW', rows.length === 1 && rows[0].name === 'ASK THE CREW' && rows[0].on, JSON.stringify(rows));
  await shot('ask');
  const busyBefore = await evalJS(cdp, 'Chat.isBusy && Chat.isBusy()');
  await evalJS(cdp, KEY('Enter')); await sleep(500);
  const composer = await evalJS(cdp, `(() => ({ value: document.getElementById('chat-input').value, focused: document.activeElement === document.getElementById('chat-input'), busy: !!(Chat.isBusy && Chat.isBusy()) }))()`);
  check('ASK THE CREW types the words into COMMS', composer && /zzqx how do i make my agents sing/.test(composer.value) && composer.focused, JSON.stringify(composer));
  check('…and never sends them', composer && composer.busy === busyBefore && composer.busy === false, JSON.stringify({ busyBefore, after: composer && composer.busy }));

  const errs = (diagnostics.exceptions || []).filter(e => !/favicon|ERR_ABORTED|net::ERR/i.test(String(e)));
  check('no uncaught page exceptions', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  check('the e2e ran to the end', false, (e && e.stack) || String(e));
} finally {
  try { if (cdp) cdp.close(); } catch (_) {}
  await stopChild(chrome); await stopChild(sidecar);
  try { rmSync(root, { recursive: true, force: true }); } catch (_) {}
}
if (failures.length) { console.log('find-window.e2e: ' + failures.length + ' FAILED'); process.exit(1); }
console.log('find-window.e2e: ALL PASS');
