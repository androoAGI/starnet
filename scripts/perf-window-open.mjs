#!/usr/bin/env node
// perf-window-open.mjs — what OPENING a station window costs the Commander: the main-thread freeze, the frames the
// rise animation drops, and which scripts paid for it.
//
// Boots a SKYNET_DEV sidecar from --repo over a COPY of a station (save/roster/dossier only — same rule as
// perf-station-cost.mjs), opens it in Chrome with the GPU, and for every window key: opens it through
// StationUI.openTerm (the dock's own door), records ~1.2 s, closes it, records the close. Per open it reports:
//   sync      ms spent inside openTerm itself
//   paint     ms from the open call to the frame AFTER the one that shows the window (click → pixels on screen)
//   loaf      total ms of long-animation-frames (≥50 ms) in the window, and the worst one
//   gaps      rAF intervals > 34 ms (a dropped frame or more at 30-60 fps) and the worst gap
//   top       the scripts LoAF blames (function @ file), summed across the window
// Each window opens --rounds times (round 1 = the session's first open, later rounds = warm).
// --profile <key> also writes a CPU profile of that window's first open + close (scripts/perf/cpuprofile-top.mjs reads it).
//
// Usage: node scripts/perf-window-open.mjs [--repo dir] [--station dir] [--port 8972] [--cdp 9372]
//        [--hold-world ms (A/B: stop the world loop for ms around each open)] [--size 1920,1032] [--settle 15] [--rounds 2] [--keys a,b,c] [--cpu 1] [--headed] [--profile key] [--json out]
//        [--gate-p95 ms]
// RELEASE-TIER GATE (the window render contract, wave 4): --gate-p95 250 exits 1 when the p95 of click → paint over every open
// exceeds the budget, or when any open never painted. Shoot it at Andrew's settings (the default --size, his station via
// --station). Pair it with scripts/qa/window-leaks.mjs (exit 1 on a detached tree over --max-root) for "zero detached trees".
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes(k);
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(arg('--repo', here));
const { connectCDP, evalJS, sleep } = await import(pathToFileURL(join(here, 'scripts/lib/cdp.mjs')).href);
const { waitUp, waitDevReady } = await import(pathToFileURL(join(here, 'scripts/lib/seed.mjs')).href);
const port = arg('--port', '8972'), cdpPort = Number(arg('--cdp', '9372')), size = arg('--size', '1920,1032');
const settle = Number(arg('--settle', '15')), rounds = Number(arg('--rounds', '2')), cpu = Number(arg('--cpu', '1'));
const profileKey = arg('--profile', null), jsonOut = arg('--json', null), hold = Number(arg('--hold-world', '0'));
const gateP95 = Number(arg('--gate-p95', '0'));
const KEYS = arg('--keys', 'agents,commander,tasks,deliverables,settings,notifs,manual,quests,updates,apps,automation,browser,connectors,messaging,workflows,trophies').split(',');
const station = resolve(arg('--station', join(repo, 'dev/fixtures/seed-workspace')));
const OUT = join(tmpdir(), 'starnet-perf-window');
const scratch = join(OUT, '_ws-' + port), profile = join(OUT, '_profile-' + cdpPort);
for (const d of [scratch, profile]) try { rmSync(d, { recursive: true, force: true }); } catch {}
mkdirSync(scratch, { recursive: true });
for (const f of readdirSync(station)) if (/^(agent\.save|agent\.roster|_commander\.dossier)\.json$/.test(f)) cpSync(join(station, f), join(scratch, f));
try {
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
let chrome = null;
const results = [];
try {
  if (!(await waitUp(APP_URL, 120))) throw new Error('sidecar never came up');
  chrome = spawn(CHROME, [...(flag('--headed') ? [] : ['--headless=new']), '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--mute-audio', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-features=CalculateNativeWinOcclusion',
    `--remote-debugging-port=${cdpPort}`, '--window-position=0,0', `--window-size=${size}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const cdp = await connectCDP(cdpPort);
  cdp.timeoutMs = 120000;
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Page.navigate', { url: APP_URL });
  if (!(await waitDevReady(cdp, evalJS, { tries: 60, url: APP_URL }))) throw new Error('never reached the floor');
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  // the idle director zooms in after 2 min without camera input — pin it so later windows see the same world
  await evalJS(cdp, `(() => { try { World.setCinecamIdle && World.setCinecamIdle(1e9); World.refit && World.refit(); } catch (_) {} return 1; })()`);
  console.log('repo', repo, '\nstation', station, '\ncpu x' + cpu, ' size', size);
  await sleep(settle * 1000);
  // in-page recorder: LoAF (with script attribution) + rAF gaps, armed per measurement
  await evalJS(cdp, `(() => {
    const R = window.__wperf = { on: false, loaf: [], gaps: [], last: 0 };
    try { new PerformanceObserver(l => { if (!R.on) return; for (const e of l.getEntries()) R.loaf.push({ d: e.duration, block: e.blockingDuration,
      scripts: (e.scripts || []).map(s => ({ d: s.duration, fn: s.sourceFunctionName || s.invoker || '?', src: String(s.sourceURL || '').split('/').pop() + ':' + (s.sourceCharPosition|0) })) }); })
      .observe({ type: 'long-animation-frame', buffered: false }); } catch (e) { R.noLoaf = String(e); }
    const tick = t => { if (R.on && R.last) { const g = t - R.last; if (g > 34) R.gaps.push(g); } R.last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return 1; })()`);
  const arm = () => evalJS(cdp, `(() => { const R = window.__wperf; R.loaf = []; R.gaps = []; R.last = 0; R.on = true; return 1; })()`);
  const harvest = () => evalJS(cdp, `(() => { const R = window.__wperf; R.on = false; return { loaf: R.loaf, gaps: R.gaps }; })()`);
  const closeAll = () => evalJS(cdp, `(() => { try { document.querySelectorAll('.term .term-x').forEach(x => x.click()); } catch (_) {} return document.querySelectorAll('.term').length; })()`);
  const summarize = (label, key, round, sync, h) => {
    const loafMs = h.loaf.reduce((a, e) => a + e.d, 0), worst = h.loaf.reduce((a, e) => Math.max(a, e.d), 0);
    const by = new Map();
    for (const e of h.loaf) for (const s of e.scripts) by.set(s.fn + ' @' + s.src, (by.get(s.fn + ' @' + s.src) || 0) + s.d);
    const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => Math.round(v) + 'ms ' + k);
    const row = { key, phase: label, round, sync: sync == null ? null : Math.round(sync), paint: h.paint == null ? null : Math.round(h.paint), loafMs: Math.round(loafMs), worstLoaf: Math.round(worst),
      gaps: h.gaps.length, worstGap: Math.round(h.gaps.reduce((a, g) => Math.max(a, g), 0)), top };
    results.push(row);
    console.log(`${key.padEnd(13)} ${label.padEnd(5)} r${round}  sync ${String(row.sync ?? '-').padStart(5)}ms  paint ${String(row.paint ?? '-').padStart(5)}ms  loaf ${String(row.loafMs).padStart(5)}ms (worst ${String(row.worstLoaf).padStart(4)})  gaps>34 ${String(row.gaps).padStart(3)} (worst ${String(row.worstGap).padStart(4)}ms)  ${top.join(' | ')}`);
  };
  await closeAll(); await sleep(1000);
  for (let round = 1; round <= rounds; round++) {
    for (const key of KEYS) {
      const prof = profileKey === key && round === 1;
      if (prof) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
      await arm();
      const sync = await evalJS(cdp, `(() => { const t0 = performance.now(); window.__paintMs = null; ${hold ? 'try { World.stop(); setTimeout(() => World.start(), ' + hold + '); } catch (_) {}' : ''}
        try { StationUI.openTerm(${JSON.stringify(key)}); } catch (e) { return -1; }
        const t1 = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => { window.__paintMs = performance.now() - t0; })); return t1 - t0; })()`);
      await sleep(1200);
      const h = await harvest(); h.paint = await evalJS(cdp, 'window.__paintMs');
      summarize('open', key, round, sync, h);
      await arm();
      await evalJS(cdp, `(() => { try { StationUI.closeTerm(${JSON.stringify(key)}); } catch (_) {} return 1; })()`);
      await sleep(900);
      if (prof) { const { profile: p } = await cdp.send('Profiler.stop'); const f = join(OUT, 'open-' + key + '.cpuprofile'); writeFileSync(f, JSON.stringify(p)); console.log('  profile (open + close) →', f); }
      summarize('close', key, round, null, await harvest());
      await closeAll(); await sleep(400);
    }
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 1));
  if (gateP95 > 0) {
    const opens = results.filter(r => r.phase === 'open');
    const unpainted = opens.filter(r => r.paint == null || r.paint < 0).map(r => r.key);
    const paints = opens.map(r => r.paint).filter(v => v != null && v >= 0).sort((a, b) => a - b);
    const p95 = paints.length ? paints[Math.min(paints.length - 1, Math.ceil(paints.length * 0.95) - 1)] : null;
    const pass = !unpainted.length && p95 != null && p95 <= gateP95;
    console.log(`GATE click-to-paint p95 ${p95 == null ? '-' : p95 + 'ms'} over ${paints.length} opens (budget ${gateP95}ms)${unpainted.length ? '; never painted: ' + unpainted.join(',') : ''}: ${pass ? 'PASS' : 'FAIL'}`);
    if (!pass) process.exitCode = 1;
  }
} catch (e) {
  console.error('FAILED', e && e.stack || e); process.exitCode = 1;
} finally {
  try { chrome && chrome.kill(); } catch {}
  try { side.kill(); } catch {}
}
