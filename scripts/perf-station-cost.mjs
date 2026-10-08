#!/usr/bin/env node
// perf-station-cost.mjs — what an idle, open station costs the MACHINE, per process, and which layer pays it.
//
// Boots a SKYNET_DEV sidecar from --repo over a COPY of a station (--station: a dir holding agent.save.json /
// agent.roster.json; default the dev seed fixture), opens it in Chrome with the GPU at --size and, per phase,
// reads: renderer + GPU process CPU (SystemInfo.getProcessInfo on the browser target — the cores the user's
// fans hear), GPU process private memory (the #69 symptom), main-thread task time, rAF callbacks/s and the
// world's own per-draw cost. Phases toggle ONE layer each so the bill can be split:
//   baseline        the page as shipped
//   no-backdrop     every backdrop-filter off (glass blur over a live canvas re-blurs on every world draw)
//   no-css-anim     every CSS/Web animation paused
//   world-stopped   World.stop() — the DOM/CSS alone
//   blurred         window focus lost (the routine-runner case: open all day, not focused)
//
// Usage: node scripts/perf-station-cost.mjs [--repo dir] [--station dir] [--port 8971] [--cdp 9371]
//        [--size 1920,1032] [--secs 8] [--settle 20] [--headed] [--phases baseline,no-backdrop,...] [--soak 0]
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes(k);
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(arg('--repo', here));
const { connectCDP, evalJS, sleep } = await import(pathToFileURL(join(here, 'scripts/lib/cdp.mjs')).href);
const { waitUp, waitDevReady } = await import(pathToFileURL(join(here, 'scripts/lib/seed.mjs')).href);
const port = arg('--port', '8971'), cdpPort = Number(arg('--cdp', '9371')), size = arg('--size', '1920,1032');
const secs = Number(arg('--secs', '8')), settle = Number(arg('--settle', '20')), soak = Number(arg('--soak', '0'));
const phases = arg('--phases', 'baseline,no-backdrop,no-css-anim,world-stopped,blurred').split(',');
const station = resolve(arg('--station', join(repo, 'dev/fixtures/seed-workspace')));
const OUT = join(tmpdir(), 'starnet-perf-cost');
const scratch = join(OUT, '_ws-' + port), profile = join(OUT, '_profile-' + cdpPort);
for (const d of [scratch, profile]) try { rmSync(d, { recursive: true, force: true }); } catch {}
mkdirSync(scratch, { recursive: true });
// only the station's SHAPE travels: save, roster, dossier — never secrets, journals or checkpoints
for (const f of readdirSync(station)) if (/^(agent\.save|agent\.roster|_commander\.dossier)\.json$/.test(f)) cpSync(join(station, f), join(scratch, f));
try {   // stamp the save so the server copy wins the boot reconcile (same as materializeSeedWorkspace)
  const p = join(scratch, 'agent.save.json'), w = JSON.parse(readFileSync(p, 'utf8')), now = Date.now();
  w.updatedAt = now; w.savedAt = now; if (w.doc) w.doc.updatedAt = now;
  writeFileSync(p, JSON.stringify(w));
} catch {}
const APP_URL = `http://127.0.0.1:${port}/`;
const side = spawn(process.execPath, [join(repo, 'sidecar/index.js')], { cwd: repo, stdio: 'ignore', env: {
  ...process.env, SKYNET_DEV: '1', SKYNET_FULL_ACCESS: '1', SKYNET_WORKSPACES: scratch, SKYNET_PORT: port,
  SKYNET_DEFAULT_MODEL: 'anthropic/claude-sonnet-4.6', SKYNET_OPENROUTER_KEY: 'sk-or-perf-placeholder' } });
const CHROME = [process.env.SKYNET_CHROME, 'C:/Users/andro/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find(existsSync);
const privMB = pid => { try { const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).PrivateMemorySize64`], { encoding: 'utf8' }); return Math.round(Number(r.stdout.trim()) / 1048576); } catch { return null; } };
let chrome = null;
try {
  if (!(await waitUp(APP_URL, 120))) throw new Error('sidecar never came up');
  chrome = spawn(CHROME, [...(flag('--headed') ? [] : ['--headless=new']), '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--mute-audio', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-features=CalculateNativeWinOcclusion',
    `--remote-debugging-port=${cdpPort}`, '--window-position=0,0', `--window-size=${size}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const cdp = await connectCDP(cdpPort);
  cdp.timeoutMs = 120000;
  const bv = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
  const bws = new WebSocket(bv.webSocketDebuggerUrl);
  await new Promise((res, rej) => { bws.addEventListener('open', res, { once: true }); bws.addEventListener('error', rej, { once: true }); });
  let bid = 0; const bpend = new Map();
  bws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && bpend.has(m.id)) { bpend.get(m.id)(m.result || m.error); bpend.delete(m.id); } });
  const bsend = (method, params = {}) => new Promise(r => { const id = ++bid; bpend.set(id, r); bws.send(JSON.stringify({ id, method, params })); });
  const procs = async () => { const r = await bsend('SystemInfo.getProcessInfo'); const o = {}; for (const p of (r.processInfo || [])) { o[p.type] = o[p.type] || { cpu: 0, ids: [] }; o[p.type].cpu += p.cpuTime; o[p.type].ids.push(p.id); } return o; };
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Performance.enable');
  // a desktop window the user is working in HAS focus; headless Chrome reports none unless told to
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Page.navigate', { url: APP_URL });
  if (!(await waitDevReady(cdp, evalJS, { tries: 60, url: APP_URL }))) throw new Error('never reached the floor');
  const info = await evalJS(cdp, `({ vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, ver: (document.querySelector('meta[name=starnet-version]')||{}).content || null,
    canvases: [...document.querySelectorAll('canvas')].filter(c => c.width * c.height > 4096).map(c => (c.id || c.className || 'canvas') + ' ' + c.width + 'x' + c.height + (c.offsetParent ? '' : ' (hidden)')),
    backdrop: [...document.querySelectorAll('*')].filter(e => { const s = getComputedStyle(e); return (s.backdropFilter && s.backdropFilter !== 'none') && e.offsetParent !== null; }).map(e => { const r = e.getBoundingClientRect(); return (e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + String(e.className).split(/\\s+/)[0]) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' ' + getComputedStyle(e).backdropFilter; }) })`);
  console.log('repo', repo, '\nstation', station, '\n' + JSON.stringify(info, null, 1));
  await sleep(settle * 1000);
  const gpuPid = (await procs()).GPU?.ids?.[0];
  async function phase(label, setup, teardown) {
    if (setup) await evalJS(cdp, setup); await sleep(1500);
    const hasPerf = await evalJS(cdp, `!!(typeof World !== "undefined" && World._dbgReviewPerformance && (World._dbgReviewPerformance(true), 1))`).catch(() => false);
    await evalJS(cdp, `(() => { window.__fr = 0; window.__frOn = true; const t = () => { window.__fr++; if (window.__frOn) requestAnimationFrame(t); }; requestAnimationFrame(t); return 1; })()`);
    if (label === 'baseline' && flag('--profile')) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
    const p0 = await procs(), m0 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value])), t0 = Date.now();
    await sleep(secs * 1000);
    const p1 = await procs(), m1 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value])), wall = (Date.now() - t0) / 1000;
    if (label === 'baseline' && flag('--profile')) {
      const { profile: pr } = await cdp.send('Profiler.stop'); const self = new Map(), byId = new Map(pr.nodes.map(n => [n.id, n])); let tot = 0;
      pr.samples.forEach((sid, i) => { const d = pr.timeDeltas[i] || 0, n = byId.get(sid), cf = n.callFrame; tot += d;
        const k = (cf.functionName || '(anon)') + ' ' + (cf.url || '').split('/').pop() + ':' + (cf.lineNumber + 1); self.set(k, (self.get(k) || 0) + d); });
      const NL = String.fromCharCode(10);
      console.log('PROFILE top self-time (% of wall):' + NL + [...self].sort((a, b) => b[1] - a[1]).slice(0, Number(arg('--top', '30'))).map(([k, v]) => '  ' + (100 * v / tot).toFixed(1).padStart(5) + '%  ' + k).join(NL));
    }
    const rafs = await evalJS(cdp, `(() => { window.__frOn = false; return window.__fr; })()`);
    const w = hasPerf ? await evalJS(cdp, `(() => { const o = World._dbgReviewPerformance(false), ms = o.samples.map(x => x.ms).sort((a, b) => a - b);
      const parts = {}; for (const x of o.samples) for (const k in (x.parts || {})) parts[k] = (parts[k] || 0) + x.parts[k];
      for (const k in parts) parts[k] = +(parts[k] / Math.max(1, o.samples.length)).toFixed(2);
      return { parts, draws: ms.length, drawMs: +(ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length)).toFixed(2), drawP95: +(ms[Math.floor(ms.length * .95)] || 0).toFixed(2), crt: o.crtBackend }; })()`) : {};
    const pct = t => Math.round(100 * ((p1[t]?.cpu || 0) - (p0[t]?.cpu || 0)) / wall);
    const row = { phase: label, rendererCpu: pct('renderer'), gpuCpu: pct('GPU'), browserCpu: pct('browser'), mainTaskPct: Math.round(100 * (m1.TaskDuration - m0.TaskDuration) / wall),
      styleMs: Math.round(1000 * (m1.RecalcStyleDuration - m0.RecalcStyleDuration) / wall), layoutMs: Math.round(1000 * (m1.LayoutDuration - m0.LayoutDuration) / wall),
      rafPerS: Math.round(rafs / wall), drawsPerS: w.draws != null ? Math.round(w.draws / wall) : null, drawMs: w.drawMs, drawP95: w.drawP95, parts: w.parts, crt: w.crt,
      jsHeapMB: Math.round(m1.JSHeapUsedSize / 1048576), nodes: m1.Nodes, gpuPrivMB: gpuPid ? privMB(gpuPid) : null };
    console.log(JSON.stringify(row));
    if (teardown) await evalJS(cdp, teardown);
    return row;
  }
  const P = {
    'baseline': [null, null],
    'no-backdrop': [`(() => { const s = document.createElement('style'); s.id = '__perf_nobd'; s.textContent = '*,*::before,*::after{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}'; document.head.appendChild(s); return 1; })()`, `(document.getElementById('__perf_nobd').remove(), 1)`],
    'no-css-anim': [`(() => { window.__pa = document.getAnimations().filter(a => a.playState === 'running'); window.__pa.forEach(a => a.pause()); return window.__pa.length; })()`, `(window.__pa.forEach(a => a.play()), 1)`],
    'world-stopped': [`(World.stop(), 1)`, `(World.start(), 1)`],
    'blurred': [`(() => { window.__hf = Document.prototype.hasFocus; Document.prototype.hasFocus = () => false; window.dispatchEvent(new Event('blur')); return 1; })()`, `(Document.prototype.hasFocus = window.__hf, window.dispatchEvent(new Event('focus')), 1)`],
  };
  for (const ph of phases) await phase(ph, ...(P[ph] || [null, null]));
  if (soak > 0) {   // the #69 shape: left open — sample the GPU process's memory every 30s
    for (let t = 0; t < soak; t += 30) { await sleep(30000); const pr = await procs(); console.log(JSON.stringify({ soakS: t + 30, gpuPrivMB: privMB(gpuPid), gpuCpuS: +(pr.GPU?.cpu || 0).toFixed(1), rendererCpuS: +(pr.renderer?.cpu || 0).toFixed(1) })); }
  }
} finally { try { chrome && chrome.kill(); } catch {} try { side.kill(); } catch {} }
process.exit(0);
