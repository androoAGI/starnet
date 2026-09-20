// scripts/lib/cdp.mjs — shared headless-Chrome + DevTools-Protocol plumbing for the
// StarNet visual/behavioral test harness. Extracted from uishoot.mjs so the screenshotter
// (uishoot/shoot), the interactive driver (uiplay), the probe, and the P2 scenario runner
// all speak one CDP dialect and capture frames the same way.
//
// WHY CDP + a fixed wall-clock wait (not preview_screenshot / --virtual-time-budget):
// StarNet's canvas animates every rAF and never goes "idle", so the idle-based capture paths
// hang forever. Driving Chrome over CDP and capturing on a timer is the proven unlock.
//
// Zero dependencies: Node 22 has global fetch + global WebSocket.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_CANDIDATES = [
  process.env.SKYNET_CHROME,
  ...(process.platform === 'win32'
    ? [
        'C:/Users/andro/AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe',
        'C:/Users/andro/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      ]
    : [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chrome',
        '/usr/bin/chrome-headless-shell',
      ]),
].filter(Boolean);

function commandOnPath(names) {
  const command = process.platform === 'win32' ? 'where' : 'which';
  for (const name of names) {
    const probe = spawnSync(command, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const resolved = String(probe.stdout || '').split(/\\r?\\n/).map(s => s.trim()).find(Boolean);
    if (resolved && existsSync(resolved)) return resolved;
  }
  return null;
}

export function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  const discovered = commandOnPath(process.platform === 'win32'
    ? ['chrome', 'chrome.exe', 'chromium', 'chromium.exe']
    : ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome', 'chrome-headless-shell']);
  if (discovered) return discovered;
  throw new Error('No Chrome/Chromium binary found. Set SKYNET_CHROME.');
}

// Launch a headless Chrome with the CDP endpoint open. Returns the child process.
export function launchChrome({ cdpPort, win = '1440,900', profileDir }) {
  const chrome = findChrome();
  const proc = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--mute-audio', `--remote-debugging-port=${cdpPort}`,
    `--window-size=${win}`, `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: 'ignore' });
  return { proc, chrome };
}

// ---- minimal CDP client over the page target's websocket ----
export class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      } else if (m.method) { (this.handlers.get(m.method) || []).forEach((h) => h(m.params)); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
    });
  }
  on(method, fn) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(fn); }
}

export async function connectCDP(port) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await r.json();
      const page = targets.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
        return new CDP(ws);
      }
    } catch {}
    await sleep(250);
  }
  throw new Error('Could not connect to CDP on ' + port);
}

// Evaluate an expression in the page and return its value by-value (throws on page exception).
export async function evalJS(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

// Capture a PNG of the current viewport to <outDir>/<name>.png. Returns the path + size.
export async function capture(cdp, outDir, name) {
  mkdirSync(outDir, { recursive: true });
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const path = join(outDir, `${name}.png`);
  const buf = Buffer.from(r.data, 'base64');
  writeFileSync(path, buf);
  return { path, kb: Math.round(buf.length / 1024) };
}

// Attach console + exception collectors to a CDP session. Returns the arrays it fills.
export function collectDiagnostics(cdp) {
  const consoleMsgs = [], exceptions = [];
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'warning')
      consoleMsgs.push({ type: p.type, text: (p.args || []).map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 240) });
  });
  cdp.on('Runtime.exceptionThrown', (p) =>
    exceptions.push((p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'exception').slice(0, 240)));
  return { consoleMsgs, exceptions };
}
