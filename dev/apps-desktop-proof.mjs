// APPS on the DESKTOP APP (2026-09-30): the real Tauri/WebView2 build, not a browser.
//   DESK_EXE=<path to a debug skynet-desktop.exe> node dev/apps-desktop-proof.mjs
// Build an ISOLATED one first (its own identifier, so it never touches an installed StarNet):
//   node scripts/prepare-node.mjs && node scripts/stage-voice-deps.mjs && node scripts/stage-frontend-dist.mjs
//   CARGO_TARGET_DIR=…/.cargo-targets/<lane> npx tauri build --debug --no-bundle --config <{"identifier":"ai.skynet.harness.appstest"}>
// Launched with its own HOME/APPDATA/LOCALAPPDATA and WebView2 data folder, driven over WebView2's CDP port. On the
// desktop the page is tauri.localhost and an app frame is http://127.0.0.1 — a cross-origin frame WebView2 runs as its
// own target — so this is exactly where APPS could differ from the browser: the API from the page, the sandboxed
// frame under the desktop CSP, the bridge, links (Tauri's opener, recorded here, never actually launched), and a frame
// that tries to navigate itself away.
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, openSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { allocatePort } from '../test/helpers/ports.js';
import { connectCDP, evalJS, capture, sleep } from '../scripts/lib/cdp.mjs';

const DESK_EXE = process.env.DESK_EXE;
if (!DESK_EXE) throw new Error('set DESK_EXE');
const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const out = '.worldshots/apps-desktop';
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'starnet-apps-desk-'));
const appdata = join(home, 'appdata'), localappdata = join(home, 'localappdata');
const deskWs = join(localappdata, 'ai.skynet.harness', 'workspaces');
mkdirSync(deskWs, { recursive: true });
cpSync(join(REPO, 'dev', 'fixtures', 'seed-workspace'), deskWs, { recursive: true });
const cdpPort = await allocatePort();   // WebView2's CDP port: one the OS proves bindable, never a PID-derived guess
const env = () => Object.assign({}, process.env, {
  HOME: home, USERPROFILE: home, APPDATA: appdata, LOCALAPPDATA: localappdata,
  SKYNET_OPENROUTER_KEY: 'sk-or-v1-apps-desktop-fake', SKYNET_DEFAULT_MODEL: 'test/model', SKYNET_QUEST_REFRESH: '0', SKYNET_SCOUT: '0',
  WEBVIEW2_USER_DATA_FOLDER: join(home, 'wv2'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + cdpPort
});
let failed = 0, app = null, cdp = null;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); if (!ok) failed++; };
const run = (s) => evalJS(cdp, s);
const until = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await run(cond); if (v) return v; } catch {} await sleep(500); } return null; };
const killTree = (pid) => { try { execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' }); } catch (_) {} };
function findAppDir(root, id, depth = 0) {
  if (depth > 7) return null;
  let names = []; try { names = readdirSync(root, { withFileTypes: true }); } catch (_) { return null; }
  for (const d of names) {
    if (!d.isDirectory()) continue;
    const p = join(root, d.name);
    if (d.name === id && existsSync(join(p, 'app.json'))) return p;
    const r = findAppDir(p, id, depth + 1); if (r) return r;
  }
  return null;
}
// evaluate inside the app frame: on the desktop it is its own CDP target (cross-origin frame)
async function inApp(expr) {
  const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json();
  const t = list.find((x) => /\/app-ui\//.test(x.url || '') && x.webSocketDebuggerUrl);
  if (!t) return { none: true };
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const v = await new Promise((r) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d.result && d.result.result ? d.result.result.value : (d.result && d.result.exceptionDetails ? { error: d.result.exceptionDetails.text } : null)); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  ws.close();
  return v;
}
const APP_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Desk Test</title></head><body>
<div class="sn-stack"><div class="sn-panel sn-stack">
<div class="sn-title">Desk Test</div>
<input id="t" class="sn-input" placeholder="type something">
<button id="save" class="sn-btn primary">SAVE</button>
<div id="shown" class="sn-hint">nothing saved</div>
<a id="out" href="https://example.com/apps-desktop-proof">an outside link</a>
</div></div>
<script>
starnet.store.get('note').then((v) => { if (v) document.getElementById('shown').textContent = 'saved: ' + v; });
document.getElementById('save').addEventListener('click', async () => {
  const v = document.getElementById('t').value;
  await starnet.store.set('note', v);
  document.getElementById('shown').textContent = 'saved: ' + (await starnet.store.get('note'));
});
</script></body></html>`;

try {
  // WARM-UP: a WebView2's first launch on a fresh data folder does not open its debugging port; a later one does.
  // On a busy machine the first launch needs time to finish initialising the folder — and a relaunch may be needed.
  { const w = spawn(DESK_EXE, [], { stdio: 'ignore', env: env() }); await sleep(25000); killTree(w.pid); await sleep(4000); }
  for (let attempt = 1; attempt <= 3 && !cdp; attempt++) {
    app = spawn(DESK_EXE, [], { stdio: ['ignore', openSync(join(out, 'desktop.log'), 'w'), openSync(join(out, 'desktop.log'), 'a')], env: env() });
    for (let i = 0; i < 6 && !cdp; i++) { try { cdp = await connectCDP(cdpPort); } catch (e) { await sleep(4000); } }
    if (!cdp) { console.log('no debugging port on launch ' + attempt + ' — relaunching'); killTree(app.pid); await sleep(5000); }
  }
  check('the DESKTOP APP is up (its own WebView2, isolated data)', !!cdp, 'pid ' + app.pid);
  if (!cdp) throw new Error('no debugging port');
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  const url = await until(`/tauri\\.localhost|127\\.0\\.0\\.1/.test(location.href) && location.href`, 60000);
  console.log('desktop page:', url);
  check('the station loads in the desktop window', !!(await until(`!!document.querySelector('#screen-game.active') && typeof AppsUI === 'object' && typeof PluginHost === 'object'`, 120000)));
  await run(`(() => { const c = document.getElementById('nav-coach'); if (c) c.hidden = true; return true; })()`);
  // Tauri's opener is recorded, never actually launched (a test must not open the machine's browser)
  // __TAURI__.core is FROZEN (invoke is non-writable): swap the whole __TAURI__ object, and only click links if it took
  const stub = await run(`(() => { window.__opened = []; const T = window.__TAURI__; if (!T) return 'no __TAURI__'; const real = T.core.invoke.bind(T.core); const inv = (cmd, args) => cmd === 'open_external_url' ? (window.__opened.push(args && args.url), Promise.resolve()) : real(cmd, args); try { window.__TAURI__ = Object.assign({}, T, { core: Object.assign({}, T.core, { invoke: inv }) }); } catch (e) { return 'ERR ' + e.message; } return window.__TAURI__.core.invoke === inv ? 'ok' : 'not installed'; })()`);
  check('the desktop opener is recorded for this test (never launched)', stub === 'ok', stub);
  // ---- the dock ----
  const loaded = await run(`AppsUI.load()`);
  check('the page reaches the station API for apps (GET /api/apps from tauri.localhost)', loaded === true);
  check('no apps yet → the APPS dock is not displayed', await run(`(() => { const g = document.querySelector('#bottombar .bb-group[data-group="apps"]'); return !!g && g.getClientRects().length === 0; })()`));
  check('BUILD → NEW APP is there', await run(`!!document.getElementById('bb-newapp-build')`));
  // ---- an app: created through the page's own API path, its page written on disk (no model needed) ----
  const made = await run(`fetch('/api/apps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Desk Test', description: 'desktop proof' }) }).then((r) => r.json())`);
  check('POST /api/apps from the desktop page creates the app', !!(made && made.ok && made.app), JSON.stringify(made).slice(0, 120));
  const id = made.app.id;
  // where this desktop build keeps its station: find the app's own folder under the isolated home
  const appDir = findAppDir(home, id);
  check('the app folder is on disk under the isolated station: ' + (appDir || '?').replace(home, '~'), !!appDir);
  writeFileSync(join(appDir, 'index.html'), APP_PAGE);
  await sleep(2000);   // the station caches an app's version for 1.5 s; the crew's own write (app.write) clears it at once
  await run(`AppsUI.onReload(${JSON.stringify(id)}).then(() => true)`);
  check('the APPS dock appeared with the first app', !!(await until(`(() => { const g = document.querySelector('#bottombar .bb-group[data-group="apps"]'); return !!g && g.getClientRects().length > 0; })()`, 10000)));
  await run(`PluginHost.openApp(AppsUI.list().find((a) => a.id === ${JSON.stringify(id)})), true`);
  check('its window opens with the sandboxed frame', !!(await until(`(() => { const f = document.querySelector('.term.plugin-app-win iframe.plugin-frame'); return !!f && /\\/app-ui\\//.test(f.src) && f.getAttribute('sandbox') === 'allow-scripts'; })()`, 15000)));
  // ---- inside the frame (its own target on the desktop) ----
  let txt = null;
  for (let i = 0; i < 30 && !(txt && txt.indexOf && txt.indexOf('Desk Test') >= 0); i++) { txt = await inApp(`document.body ? document.body.innerText : ''`).catch(() => null); if (!(txt && txt.indexOf && txt.indexOf('Desk Test') >= 0)) await sleep(1000); }
  check('the app page renders inside the desktop window', typeof txt === 'string' && txt.indexOf('Desk Test') >= 0, String(txt && txt.slice ? txt.slice(0, 60) : JSON.stringify(txt)));
  const kit = await inApp(`(() => { const p = document.querySelector('.sn-panel'); const cs = p && getComputedStyle(p); return !!(window.starnet && window.starnet.__kit) && !!cs && cs.borderTopStyle === 'solid'; })()`);
  check('the station kit is injected (starnet bridge + glass classes)', kit === true);
  const saved = await inApp(`(async () => { document.getElementById('t').value = 'hello from the desktop'; document.getElementById('save').click(); await new Promise((r) => setTimeout(r, 1500)); return document.getElementById('shown').textContent; })()`);
  check('the bridge works: the page saves and reads back through the station store', saved === 'saved: hello from the desktop', JSON.stringify(saved));
  const back = await run(`fetch('/api/apps/store', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ${JSON.stringify(id)}, op: 'get', key: 'note' }) }).then((r) => r.json())`);
  check('…and it is really on the station (store read from the page host)', back && back.value === 'hello from the desktop', JSON.stringify(back));
  // ---- the bar ----
  check('the bar under the window: change box, AUTO-UPDATE, honest status', await run(`(() => { const b = document.querySelector('.term.plugin-app-win .app-bar'); return !!b && !!b.querySelector('.app-change') && !!b.querySelector('.app-auto-toggle') && /Built|Updated|Not built/.test(b.querySelector('.app-status').textContent); })()`));
  await capture(cdp, out, '01-desktop-app-window');
  // ---- links: Tauri's opener, not the frame (only when the recorder is in: a test must never open the real browser) ----
  if (stub === 'ok') await inApp(`(() => { document.getElementById('out').click(); return true; })()`);
  await sleep(1500);
  const opened = await run(`window.__opened || []`);
  check('an outside link goes to the desktop opener (the real browser), not into the frame', opened.length === 1 && opened[0] === 'https://example.com/apps-desktop-proof', JSON.stringify(opened));
  const still = await inApp(`location.href`);
  check('the app frame stayed on its page', typeof still === 'string' && /\/app-ui\//.test(still), String(still).slice(0, 80));
  // ---- a page that tries to leave by navigating itself ----
  await inApp(`(() => { setTimeout(() => { location.href = 'https://example.com/?leak=1'; }, 50); return true; })()`);
  await sleep(3000);
  const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json();
  console.log('targets 3 s after the escape:', JSON.stringify(list.map((x) => (x.url || '').slice(0, 50))));
  await sleep(3000);
  const list2 = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json();
  check('a frame that navigates itself away is THROWN OUT (no foreign page stays in the window)', !list2.some((x) => /example\.com/.test(x.url || '')), JSON.stringify(list2.map((x) => (x.url || '').slice(0, 50))));
  let restored = null; for (let i = 0; i < 10 && !(typeof restored === 'string' && restored.indexOf('Desk Test') >= 0); i++) { restored = await inApp(`document.body ? document.body.innerText : ''`).catch(() => null); if (!(typeof restored === 'string' && restored.indexOf('Desk Test') >= 0)) await sleep(1000); }
  check('…and the app is back in its window', typeof restored === 'string' && restored.indexOf('Desk Test') >= 0);
  await capture(cdp, out, '02-desktop-after');
} catch (e) { console.error(String((e && e.stack) || e)); failed++; }
finally {
  try { cdp && cdp.ws.close(); } catch (_) {}
  if (app) killTree(app.pid);
  setTimeout(() => { try { rmSync(home, { recursive: true, force: true }); } catch (_) {} process.exit(failed ? 1 : 0); }, 2500);
}
