#!/usr/bin/env node
/*
 * webkit-floor-boot.mjs — the station page boots in a real WebKit with every API newer than the engine floor removed.
 *
 * WHY. On macOS the app window is the system WebKit, and it only updates with Safari / macOS. gh#136 (macOS Intel,
 * 0.13.5) and qa/bugs/5308fc67: one construct the customer's WebKit lacked dropped a whole module (WorkflowLine, Chat),
 * every gate was green, and only a customer saw it. The lexical ratchet (test/webkit-floor-syntax.test.js) gates the
 * syntax; this job gates the boot, in a real engine.
 *
 * WHAT. Boots the sidecar of this checkout KEYLESS and hermetic (scripts/canary/keyless-sidecar.mjs) on a port the OS
 * hands out, then opens / and /agent-station-demo.html in Playwright WebKit with the floor shim as an init script
 * (scripts/lib/engine-floor.mjs shimSource: every table API newer than the floor is deleted before any page script
 * runs) and requires, page by page:
 *   - the boot guard's own per-script accounting (BootGuard.verdict()): every station script counted, seen, and RAN;
 *   - no page error while the page boots, and no station script that answered an HTTP error or never arrived;
 *   - no fatal boot banner, no missing critical module, and the engine not below the floor (the guard's floor probes);
 *   - with --floor, the shim ran and kept nothing it was told to delete.
 * It writes <out>/receipt.json and one screenshot per page.
 *
 * HONEST LIMIT. Playwright's WebKit is today's WebKit minus the removed APIs, not a real Safari 15.4: syntax is gated
 * lexically and APIs by removal; the engine bugs and CSS of a real 15.4 are not reproduced.
 *
 * PLAYWRIGHT is never a dependency of this repo (node_modules is shared with the trunk tree). It is resolved from
 * PLAYWRIGHT_MODULE_DIR when that is set (that directory only), else from this checkout's node_modules (CI installs
 * playwright@PLAYWRIGHT_PIN with npm i --no-save). Not found: exit 3, "unconfigured", never green.
 *
 * USAGE  node scripts/qa/webkit-floor-boot.mjs [--floor] [--sidecar <entry.js> | --url <http://127.0.0.1:PORT>]
 *          [--pages /,/agent-station-demo.html] [--retry N] [--out <dir>] [--timeout-ms N] [--settle-ms N]
 *   --floor     apply the floor shim (CI always does; without it the run is today's WebKit, for comparison)
 *   --url       judge a sidecar that is already running (keyless) instead of booting one
 *   --retry N   run a red check again N more times, 5 s apart, on a fresh sidecar (CI: 1; a boot under CI load can flake)
 * Prints ONE verdict line {"harness":"webkit-floor-boot","ok":…}. Exit 0 green, 1 red, 2 usage, 3 unconfigured.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFloor, shimSource } from '../lib/engine-floor.mjs';
import { withKeylessSidecar } from '../canary/keyless-sidecar.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PLAYWRIGHT_PIN = '1.64.1';
export const PAGES = Object.freeze(['/', '/agent-station-demo.html']);
export const EXIT = Object.freeze({ green: 0, red: 1, usage: 2, unconfigured: 3 });
const require = createRequire(import.meta.url);
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function parseArgs(argv) {
  const o = { floor: false, sidecar: join(ROOT, 'sidecar', 'index.js'), url: '', pages: PAGES.slice(), retry: 0, out: '', timeoutMs: 90000, settleMs: 3000, bootMs: 120000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (i + 1 >= argv.length) throw new Error(a + ' needs a value'); return argv[++i]; };
    if (a === '--floor') o.floor = true;
    else if (a === '--sidecar') o.sidecar = resolve(next());
    else if (a === '--url') o.url = String(next()).replace(/\/+$/, '');
    else if (a === '--pages') o.pages = String(next()).split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--retry') o.retry = Math.max(0, Number(next()) || 0);
    else if (a === '--out') o.out = resolve(next());
    else if (a === '--timeout-ms') o.timeoutMs = Math.max(1000, Number(next()) || 0);
    else if (a === '--settle-ms') o.settleMs = Math.max(0, Number(next()) || 0);
    else throw new Error('unknown argument: ' + a);
  }
  if (!o.pages.length || o.pages.some(p => !p.startsWith('/'))) throw new Error('--pages takes paths that start with /');
  return o;
}

/* Playwright from PLAYWRIGHT_MODULE_DIR (only there, when set) or this checkout's node_modules. null = unconfigured. */
export function resolvePlaywright(env = process.env, root = ROOT) {
  const dir = env.PLAYWRIGHT_MODULE_DIR;
  const candidates = dir ? [join(dir, 'node_modules', 'playwright'), join(dir, 'playwright'), dir] : [join(root, 'node_modules', 'playwright')];
  for (const c of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(join(c, 'package.json'), 'utf8'));
      if (pkg && pkg.name === 'playwright') return { dir: resolve(c), version: String(pkg.version || '') };
    } catch (_) { /* not this one */ }
  }
  return null;
}

function describeNotRun(n) {
  if (!n || typeof n !== 'object') return 'a station script did not run';
  if (n.why === 'load') return n.file + ' did not load';
  if (n.why === 'never') return n.file + ' never ran (no load event)';
  return n.file + ' threw while loading (' + (n.kind || 'Error') + (n.line ? ' at line ' + n.line : '') + ')';
}

/* The verdict for one page, from what the browser saw. Green only for a FULL accounting: the guard counted the page's
   station scripts, saw each one, and every one ran; nothing else went wrong. Pure (test/webkit-floor-boot.test.js). */
export function judgePage(r, { floor = true } = {}) {
  const why = [];
  if (!r || !r.loaded) {
    why.push('the page did not load' + (r && r.error ? ': ' + r.error : r && r.status ? ' (HTTP ' + r.status + ')' : ''));
    return { ok: false, why };
  }
  const a = r.accounting;
  if (!a || typeof a !== 'object') why.push('no per-script accounting: the page has no BootGuard.verdict() (a boot guard older than this job, or none ran)');
  else {
    const before = why.length;
    if (!a.checked) why.push('the boot guard never ran its check');
    if (!a.listed || !(a.total > 0)) why.push('the boot guard counted no station script');
    for (const n of Array.isArray(a.notRun) ? a.notRun : []) why.push(describeNotRun(n));
    if (a.listed && a.total > 0 && a.ran !== a.total && !(Array.isArray(a.notRun) && a.notRun.length)) why.push(a.ran + ' of ' + a.total + ' station scripts ran');
    if (a.listed && a.total > 0 && a.seen !== a.total) why.push('a load or error event was seen for ' + a.seen + ' of ' + a.total + ' station scripts');
    if (Array.isArray(a.missing) && a.missing.length) why.push('critical modules missing: ' + a.missing.join(', '));
    if (a.belowFloor) why.push('the boot guard calls this engine below the floor (no ' + (Array.isArray(a.floorMissing) ? a.floorMissing.join(', ') : '?') + ')');
    if (why.length === before && a.verdict !== 'passed') why.push('the boot check reads ' + a.verdict);
  }
  if (r.banner) why.push('the fatal boot banner is showing');
  for (const e of r.pageErrors || []) why.push('page error while booting: ' + e);
  for (const s of r.failedScripts || []) why.push('a script did not arrive: ' + s);
  if (floor) {
    if (!r.shim || typeof r.shim !== 'object') why.push('the floor shim did not run');
    else if (Array.isArray(r.shim.kept) && r.shim.kept.length) why.push('the floor shim could not remove: ' + r.shim.kept.join(', '));
  }
  return { ok: why.length === 0, why };
}

const shortUrl = (u, base) => String(u || '').replace(base, '').replace(/[?#].*$/, '') || '/';
function errorLine(err, base) {
  const msg = String((err && err.message) || err || 'error').split('\n')[0];
  const at = /(?:@|at |\()((?:https?|tauri):\/\/[^\s)]+:\d+(?::\d+)?)/.exec(String((err && err.stack) || ''));
  return (msg + (at ? ' @ ' + shortUrl(at[1], base) : '')).replace(base, '').slice(0, 300);
}

async function openPage(browser, base, path, o, shim) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (shim) await context.addInitScript({ content: shim });
  const page = await context.newPage();
  const r = { path, loaded: false, status: 0, error: '', accounting: null, banner: false, shim: null, pageErrors: [], failedScripts: [], screenshot: '' };
  let booting = true;
  const sameOrigin = u => String(u || '').indexOf(base + '/') === 0;
  page.on('pageerror', err => { if (booting && r.pageErrors.length < 40) r.pageErrors.push(errorLine(err, base)); });
  page.on('response', res => {
    try { if (booting && res.request().resourceType() === 'script' && sameOrigin(res.url()) && res.status() >= 400) r.failedScripts.push(shortUrl(res.url(), base) + ' (HTTP ' + res.status() + ')'); } catch (_) { /* a response we cannot read */ }
  });
  page.on('requestfailed', req => {
    try { if (booting && req.resourceType() === 'script' && sameOrigin(req.url())) r.failedScripts.push(shortUrl(req.url(), base) + ' (' + ((req.failure() && req.failure().errorText) || 'failed') + ')'); } catch (_) { /* a request we cannot read */ }
  });
  try {
    const res = await page.goto(base + path, { waitUntil: 'load', timeout: o.timeoutMs });
    r.status = res ? res.status() : 0;
    r.loaded = !!res && r.status < 400;
    // the guard's verdict is final at DOMContentLoaded (or after a shared/ retry); then let the boot settle
    await page.waitForFunction(() => !!(window.BootGuard && window.BootGuard.state && window.BootGuard.state().checked), null, { timeout: o.timeoutMs }).catch(() => {});
    await page.waitForTimeout(o.settleMs);
    const seen = await page.evaluate(() => {
      const g = window.BootGuard;
      return {
        accounting: g && typeof g.verdict === 'function' ? g.verdict() : null,
        banner: !!document.getElementById('bootguard-fatal'),
        shim: window.__STARNET_FLOOR_SHIM__ || null
      };
    });
    Object.assign(r, seen);
  } catch (e) {
    r.error = String((e && e.message) || e).split('\n')[0].slice(0, 300);
  }
  booting = false;
  if (o.out) {
    try {
      const file = join(o.out, (path.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'index') + '.png');
      await page.screenshot({ path: file });
      r.screenshot = file;
    } catch (_) { /* a page that cannot be drawn is already red above */ }
  }
  await context.close().catch(() => {});
  return Object.assign(r, judgePage(r, { floor: !!shim }));
}

async function judgeAll(pw, base, o, shim) {
  const browser = await pw.webkit.launch({ headless: true });
  try {
    const engine = 'WebKit ' + (typeof browser.version === 'function' ? browser.version() : '?');
    const pages = [];
    for (const p of o.pages) pages.push(await openPage(browser, base, p, o, shim));
    return { ok: pages.length > 0 && pages.every(p => p.ok), base, engine, pages };
  } finally {
    await browser.close().catch(() => {});
  }
}

/* A port from the OS (test/helpers/ports.js); a bind refused between the probe and the sidecar's own listen retries on
   a fresh port, never port + 1. */
async function bootAndJudge(pw, o, shim) {
  const { allocatePort, bindRefused } = require(join(ROOT, 'test', 'helpers', 'ports.js'));
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await allocatePort();
    last = await withKeylessSidecar(o.sidecar, port, base => judgeAll(pw, base, o, shim), { profilePrefix: 'starnet-webkit-floor-', healthMs: o.bootMs });
    if (last && last.ok === false && !last.pages && bindRefused(last.tail)) continue;
    break;
  }
  return last;
}

function emit(verdict, o) {
  const line = JSON.stringify({ harness: verdict.harness, ok: verdict.ok, unconfigured: verdict.unconfigured || undefined, floor: verdict.floor, engine: verdict.engine, attempts: verdict.attempts,
    pages: (verdict.pages || []).map(p => ({ path: p.path, ok: p.ok, why: p.why })), why: verdict.why || undefined, receipt: verdict.receipt || undefined });
  console.log(line);
  if (o && o.out) writeFileSync(join(o.out, 'receipt.json'), JSON.stringify(verdict, null, 2) + '\n');
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(String((e && e.message) || e)); process.exit(EXIT.usage); }
  if (!o.out) o.out = mkdtempSync(join(tmpdir(), 'starnet-webkit-floor-'));
  mkdirSync(o.out, { recursive: true });
  const table = readFloor();
  const verdict = { harness: 'webkit-floor-boot', ok: false, floor: o.floor ? { safari: table.safari, macos: table.macos } : null, pin: PLAYWRIGHT_PIN,
    target: o.url || o.sidecar, receipt: join(o.out, 'receipt.json') };
  const found = resolvePlaywright();
  if (!found) {
    Object.assign(verdict, { unconfigured: true, why: 'playwright is not installed: set PLAYWRIGHT_MODULE_DIR, or npm i --no-save playwright@' + PLAYWRIGHT_PIN + ' (then npx playwright install webkit). An unconfigured run is never green.' });
    emit(verdict, o);
    console.log('::warning::the WebKit floor boot was not run (unconfigured): ' + verdict.why);
    process.exit(EXIT.unconfigured);
  }
  verdict.playwright = found.version;
  const pw = require(found.dir);
  if (!o.url && !existsSync(o.sidecar)) { console.error('no sidecar entry at ' + o.sidecar); process.exit(EXIT.usage); }
  const shim = o.floor ? shimSource(table) : '';
  const attempts = [];
  for (let i = 0; i <= o.retry; i++) {
    if (i) await sleep(5000);
    let run;
    try { run = o.url ? await judgeAll(pw, o.url, o, shim) : await bootAndJudge(pw, o, shim); } catch (e) { run = { ok: false, why: String((e && e.message) || e).split('\n')[0] }; }
    attempts.push(run);
    if (run.ok) break;
  }
  const last = attempts[attempts.length - 1];
  Object.assign(verdict, { ok: !!last.ok, engine: last.engine, attempts: attempts.length, pages: last.pages || [], why: last.pages ? undefined : last.why, tail: last.tail });
  emit(verdict, o);
  if (!verdict.ok) {
    const first = (verdict.pages.find(p => !p.ok) || { why: [verdict.why] });
    console.log('::error::the station page does not boot in WebKit at the floor (Safari ' + table.safari + '): ' + (first.path ? first.path + ': ' : '') + (first.why || []).slice(0, 3).join('; '));
    process.exit(EXIT.red);
  }
  process.exit(EXIT.green);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
