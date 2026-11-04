#!/usr/bin/env node
// perf-idle-ab.mjs — the RENDERER idle A/B bench (2026-10-20, piece 3 of the "eats my PC" plan). It prices what a
// visible, idle StarNet window costs the machine, per payer and per phase, before any renderer change is chosen.
// Supersedes scripts/perf-station-cost.mjs for idle work, which could not measure it:
//   - headless: a synthetic 60 Hz BeginFrame source hides the 144/239 Hz rAF spin and does no real present;
//   - its own rAF counter loop kept a vsync-rate rAF alive in EVERY phase (its "world-stopped" floor paid for the
//     probe's own frame production);
//   - focus emulation forced on, the cinecam never pinned (it zooms ~2.6x after 2 min and drifts any A/B), and its
//     sidecar saw the real APPDATA (boot auto-recovery could ingest Andrew's REAL station).
//
// What this one does instead:
//   - HEADED msedge.exe (same engine build as the WebView2 runtime; Chrome is a different build), its own
//     --user-data-dir inside the run dir, GPU on (d3d11 ANGLE), native window occlusion off (the desktop host owns
//     visibility: a covered bench window must not fake a 0), DPR 1, placed on the monitor under test, app-mode
//     window (no tab strip, like the desktop webview).
//   - a hermetic sidecar (proc-footprint.mjs hermeticEnv: every profile path inside the run dir, whitelisted env,
//     DEV on, live prices off, provider base on a closed port) over a COPY of a station's save/roster/dossier only.
//   - a PASSIVE rAF counter installed before any page script: it wraps requestAnimationFrame, counts callbacks and
//     samples the booking call site 1 in 50. It never books a frame itself.
//   - the cinecam pinned (setCinecamIdle(1e9) + refit, asserted) in every phase but P6.
//   - per phase: settle, then one window read three ways — the page (draws, rAF callbacks by site, vsync, main-thread
//     task time, draw cost, heap), Chromium (SystemInfo.getProcessInfo CPU per process type) and the OS (the
//     app-footprint.ps1 sampler over this bench's own Edge + sidecar trees: CPU, private bytes, GPU 3D %, GPU MB),
//     cross-checked against each other. Nothing reads pixels back and nothing captures the screen, ever.
//   - every phase is labelled by what the page REPORTED (hasFocus, visibilityState, vsync, camera mode): a phase
//     that did not get the state it asked for is INVALID, never mislabelled. A contended box gives NO VERDICT.
//   - teardown kills only the pids it spawned, after proving identity (name + creation time + a per-run marker on
//     the command line), whole tree by pid; never by image name.
//
// Phases (--phases, default all, in this order):
//   P0  minimized (Browser.setWindowBounds 'minimized'). Must read 0 draws/s and 0 rAF/s, or the harness is broken.
//   P1  visible + focused (Page.bringToFront; if Windows refuses the foreground, Emulation focus → 'focused(emulated)').
//   P2  visible + unfocused (a small bench-owned window on the other monitor takes focus).
//   P3  World.stop(), no rAF anywhere: the DOM/CSS/compositor floor.
//   P3b World.stop() + a bare rAF spinner: P3b - P3 prices the panel-rate skip callbacks alone.
//   P4  CSS/Web animations paused.            P5  every backdrop-filter off.
//   AB  in-page draw-rate A/B: World.setFrameCap(0 | 1000/30 | 200) = 60 | 30 | 5 draws/s, cycled ABCABC in one page.
//   P6  cinecam engaged (setCinecamIdle(1000), wait for mode 'auto'): the true "left open" state.
//   P7  the IDLE RENDERER's rest (wave 5, flag): World.setIdleRenderer(true) + setCinecamIdle(1000) + setCinecamRest(2000),
//       wait for cameraDbg().cineRested: what a truly idle "left open" station costs with the flag on. P7 vs P6 prices the
//       cinecam rest. It also waits for the CREW SETTLE (cameraDbg().crewSettled reaching the body count, at most 90 s), and
//       after the window reads the wake: one synthetic pointermove must leave no body settled one frame later. Then the same
//       for NEWS: the touched station rests and settles again (at most 40 s), a channel.inbound (a message that starts no run)
//       goes through the page's own bus, and one frame later the rest must be over and no body settled. A station that did not
//       settle again is "skipped: did not re-settle", never a pass. P7 then judges itself: idleBudgetVerdict (proc-footprint.mjs)
//       over its own row, main thread <= 15%, rAF callbacks per draw <= 1.25, 28-32 draws/s, crew settled, still share >= 95%;
//       a contended or invalid window is "unjudged". Every phase records rafPerDraw (the page's, and the world's own) and the
//       callbacks the pacer sent back undrawn (skippedFrames), and timerLateMs: how late the still timers ran on this machine
//       (the pacer measures it). A rafPerDraw over budget with timerLateMs near 15.6 on a 144/239 Hz panel is the machine's
//       tick-late timer clock - a due change is then booked rAF for the last 3-4 vsyncs - not a booking that regressed.
//       The flag's other half (LAZY ART) needs the page loaded with it: run twice, --idle-renderer off|on, with
//       two --labels, and compare. Runs last.
//
//   node scripts/perf-idle-ab.mjs run [--repo <tree>] [--station <dir with agent.save.json>] [--label before]
//        [--monitor 239|144|<x>,<y>] [--hz <n>] [--phases P0,P1,...] [--settle 20] [--window 60]
//        [--caps 0,33.333,200] [--slice 30] [--slice-settle 5] [--rounds 3] [--walk-secs 20]
//        [--look andrew|none|<json>] [--runs 1] [--force-contended "<why>"] [--min-free-gb 1.5] [--keep] [--idle-renderer off|on]
//   node scripts/perf-idle-ab.mjs compare --a <label> --b <label> [--dir <runs root>]
//   node scripts/perf-idle-ab.mjs cleanup <runDir>     (crash recovery: pids.json → identity-checked kills)
//
// Never run it beside a test gate or another bench for numbers you mean to keep: the preflight marks such a run
// CONTENDED and compare refuses it a verdict. It opens Edge windows that take OS focus for the whole run.
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync, readdirSync, openSync, closeSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir, freemem, cpus } from 'node:os';
import { createServer } from 'node:net';
import { CDP, evalJS, sleep } from './lib/cdp.mjs';
import { waitDevReady } from './lib/seed.mjs';
import * as F from './lib/proc-footprint.mjs';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i > -1 && argv[i + 1] != null ? argv[i + 1] : d; };
const flag = k => argv.includes(k);
const RUNS_ROOT = resolve(arg('--dir', join(tmpdir(), 'starnet-idle-ab')));
const SAMPLER = join(here, 'scripts', 'perf', 'app-footprint.ps1');
const EDGE = [process.env.STARNET_BENCH_EDGE, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find(existsSync);
const WV2_DIR = 'C:/Program Files (x86)/Microsoft/EdgeWebView/Application';
const PHASE_ORDER = ['P0', 'P1', 'P2', 'P3', 'P3b', 'P4', 'P5', 'AB', 'P6', 'P7'];
// Andrew's real view (read 10-15 from his app's WebView2 localStorage; re-read it before a run that matters): 1x
// pixels, TEXT SIZE 90, a 400 px crew rail, custom hue 216. The look goes through StationUI.setLook, the same path
// the Settings controls run; the rail and chat widths are per-machine localStorage seeded before the page loads.
const ANDREW_LOOK = { theme: 'custom', themeHue: 216, themeSat: 100, themeGlow: 20, panelBright: -100, flicker: false, textScale: 90, sessionRow: 'inbox', backdrop: 'nursery' };
const ANDREW_LOCAL = { 'starnet.crewrail.w': '400', 'starnet.crewrail.rows': '2', 'starnet.chatw': '767' };
process.on('unhandledRejection', e => console.error('[idle-ab] unhandled rejection (teardown continues):', e && e.stack || e));

// ---------- OS plumbing (Windows) ----------
function ps(script, timeout = 60000) {   // -EncodedCommand: any script text, no quoting traps
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ProgressPreference = 'SilentlyContinue'; " + script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function cim(pid) {
  const out = ps('Get-CimInstance Win32_Process -Filter "ProcessId=' + Number(pid) + '" | Select-Object ProcessId,Name,@{n="Created";e={$_.CreationDate.ToUniversalTime().ToString("o")}},CommandLine | ConvertTo-Json -Compress');
  return out ? JSON.parse(out) : null;
}
function recordPid(runDir, key, pid, marker) {
  let info = null;
  for (let i = 0; i < 20 && !info; i++) { try { info = cim(pid); } catch (_) {} }
  const file = join(runDir, 'pids.json'), all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  all[key] = { pid, name: info && info.Name, created: info && info.Created, marker };
  writeFileSync(file, JSON.stringify(all, null, 2));
  return all[key];
}
// Kill ONLY a process this bench spawned: same image name, same creation time, our marker on its command line.
function killOwn(rec) {
  if (!rec || !rec.pid) return 'no-pid';
  let now = null; try { now = cim(rec.pid); } catch (_) {}
  if (!now) return 'gone';
  if (now.Name !== rec.name || now.Created !== rec.created || String(now.CommandLine || '').indexOf(rec.marker) < 0)
    return 'REFUSED: pid ' + rec.pid + ' is no longer ours (' + now.Name + ' ' + now.Created + ')';
  try { execFileSync('taskkill', ['/PID', String(rec.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); return 'killed-tree'; }
  catch (e) { return 'taskkill-failed: ' + e.message; }
}
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
function systemPreflight(forced) {
  let load = null; try { load = Number(ps('(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average')); } catch (_) {}
  return F.preflight({ systemCpuPct: Number.isFinite(load) ? load : null, cores: cpus().length, freeGB: freemem() / 1073741824, forced });
}
// every display with its CURRENT refresh rate (EnumDisplaySettings; Win32_VideoController only names adapters)
function displays() {
  const out = ps(`Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class IdleAbDisp {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra; public int dmFields;
    public int dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
  public static int Hz(string dev) { var d = new DEVMODE(); d.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE)); return EnumDisplaySettings(dev, -1, ref d) ? d.dmDisplayFrequency : 0; }
}
'@
@([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [ordered]@{ name = $_.DeviceName; primary = $_.Primary; x = $_.Bounds.X; y = $_.Bounds.Y; w = $_.Bounds.Width; h = $_.Bounds.Height; wx = $_.WorkingArea.X; wy = $_.WorkingArea.Y; ww = $_.WorkingArea.Width; wh = $_.WorkingArea.Height; hz = [IdleAbDisp]::Hz($_.DeviceName) } }) | ConvertTo-Json -Compress`);
  return [].concat(JSON.parse(out));
}
function fileVersion(p) { try { return ps(`(Get-Item -LiteralPath '${p.replace(/'/g, "''")}').VersionInfo.ProductVersion`); } catch (_) { return null; } }
function webview2Versions() { try { return readdirSync(WV2_DIR).filter(d => /^\d+\.\d+\.\d+\.\d+$/.test(d)); } catch (_) { return []; } }

// the OS sampler over this bench's own trees for one window, lined up on startAtMs
function startSampler(roots, seconds, startAtMs, live) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SAMPLER, '-RootPid', roots.join(','),
    '-Seconds', String(Math.max(2, Math.round(seconds))), '-Interval', '2', '-StartAtMs', String(startAtMs), '-NoIdentity', '-Compress'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  live.add(child);
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const result = new Promise(res => {
    const t = setTimeout(() => { try { child.kill(); } catch (_) {} }, (seconds + 90) * 1000);
    child.on('close', code => {
      clearTimeout(t); live.delete(child);
      try { const j = JSON.parse(out.replace(/^\uFEFF/, '')); res(j.running ? j.windows[0] : { error: 'sampler: tree not running' }); }
      catch (e) { res({ error: 'sampler exit ' + code + ': ' + (err || out).slice(0, 400) }); }
    });
  });
  return { result };
}

// ---------- page-side probes (stringified functions: no escaping traps) ----------
function rafProbe() {   // PASSIVE: wraps rAF, never books a frame of its own
  if (window.__idleAbRaf) return;
  const native = window.requestAnimationFrame.bind(window);
  // vsync from the frame timestamps themselves: the median gap between consecutive DISTINCT rAF timestamps (2-50 ms) of
  // the last 2 s. The world's own vsyncMs keeps the smallest gap it has seen, so one early callback under load reads a
  // 240 Hz panel as 248 Hz (smoke run 2026-10-20); a median does not move for a few jittered frames.
  const S = window.__idleAbRaf = { fired: 0, booked: 0, sampled: 0, every: 50, sites: Object.create(null), lastT: 0, gapT: new Float64Array(600), gapD: new Float64Array(600), gi: 0 };
  const tick = t => {
    S.fired++;
    if (t !== S.lastT) { const d = t - S.lastT; if (S.lastT && d > 2 && d < 50) { S.gapT[S.gi] = t; S.gapD[S.gi] = d; S.gi = (S.gi + 1) % 600; } S.lastT = t; }   // typed rings: no allocation per frame
  };
  window.requestAnimationFrame = function requestAnimationFrame(cb) {
    const k = ++S.booked;
    if (k % S.every) return native(t => { tick(t); return cb(t); });
    const line = String(new Error().stack || '').split('\n')[2] || '';
    const m = /at (?:(\S+) )?\(?(?:[a-z]+:\/\/[^/]+\/)?([^?:)\s]+)(?:\?[^:)]*)?:(\d+):\d+\)?/.exec(line);
    const site = m ? (m[1] || '(anon)') + ' ' + m[2] + ':' + m[3] : line.trim().slice(0, 80) || '(unknown)';
    return native(t => { tick(t); S.sampled++; S.sites[site] = (S.sites[site] || 0) + 1; return cb(t); });
  };
}
function seedLocal(seed) { try { for (const k of Object.keys(seed)) if (localStorage.getItem(k) == null) localStorage.setItem(k, seed[k]); } catch (_) {} }
function pageState() {
  const p = World.renderPace(), c = World.cameraDbg(), r = window.__idleAbRaf || {}, now = performance.now();
  const gaps = [];
  if (r.gapT) for (let i = 0; i < r.gapT.length; i++) if (r.gapT[i] > now - 2000) gaps.push(r.gapD[i]);
  gaps.sort((a, b) => a - b);
  const vsyncMs = gaps.length >= 20 ? +gaps[gaps.length >> 1].toFixed(3) : 0;   // under 20 gaps: no vsync-rate frames to read
  return { t: now, draws: p.draws, hasFocus: document.hasFocus(), visibilityState: document.visibilityState, vsyncMs, vsyncGaps: gaps.length,
    pace: { running: p.running, mode: p.mode, focused: p.focused, motion: p.motion, paceMs: p.paceMs, vsyncMs: p.vsyncMs, drawCostMs: p.drawCostMs, strained: p.strained, timerWait: p.timerWait,
      still: p.still, stillWhy: p.stillWhy, stillFrames: p.stillFrames, stillWhyCounts: p.stillWhyCounts || null,
      skippedFrames: p.skippedFrames, dueDraws: p.dueDraws, dueLate: p.dueLate, timerLateMs: p.timerLateMs },   // a tree without the counters leaves them out (pacerWindow reads that as null)
    raf: { fired: r.fired || 0, booked: r.booked || 0, sampled: r.sampled || 0, sites: Object.assign({}, r.sites || {}) },
    camera: { mode: c.mode, thresholdMs: c.thresholdMs, scale: c.scale, rested: c.cineRested === true, crewSettled: typeof c.crewSettled === 'number' ? c.crewSettled : null } };
}
function firstTouchWake() {
  const before = World.cameraDbg();
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: 4, clientY: 4 }));
  return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
    const after = World.cameraDbg();
    res({ settledBefore: before.crewSettled, restedBefore: before.cineRested === true, settledAfter: after.crewSettled, restedAfter: after.cineRested === true,
      ok: before.crewSettled > 0 && after.cineRested !== true && after.crewSettled === 0 });
  })));
}
// THE MESSAGE WAKE (P7, after the first-touch wake): news that starts no run ends the rest the way a hand does. A channel message
// the dish only pulses for goes through the page's own bus, so the world's production taps run, not a copy of them; one frame later
// the rest must be over and no body settled. The touch just woke the station, so it must be rested AND settled again first: a
// station that is not proves nothing, and that is a skip with its reason, never a pass (ok stays null).
function messageWake() {
  const before = World.cameraDbg();
  if (!(before.crewSettled > 0 && before.cineRested === true))
    return Promise.resolve({ ok: null, skipped: 'did not re-settle', settledBefore: before.crewSettled, restedBefore: before.cineRested === true });
  const hero = World.bodies().find(b => b.hero);
  U.bus.emit('channel.inbound', { channel: 'probe', chatId: '0', agentId: hero ? hero.id : null });
  return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
    const after = World.cameraDbg();
    res({ ok: after.cineRested !== true && after.crewSettled === 0, skipped: null, settledBefore: before.crewSettled, restedBefore: true, settledAfter: after.crewSettled, restedAfter: after.cineRested === true });
  })));
}
function reviewRead() {
  const o = World._dbgReviewPerformance(false), ms = o.samples.map(x => x.ms).sort((a, b) => a - b);
  return { n: ms.length, mean: ms.length ? +(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(2) : null, p95: ms.length ? +ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))].toFixed(2) : null, crt: o.crtBackend };
}
function pageInfo() {
  const meta = document.querySelector('meta[name=starnet-version]');
  return { vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, ver: meta ? meta.content : null,
    canvases: [...document.querySelectorAll('canvas')].filter(c => c.width * c.height > 4096).map(c => (c.id || c.className || 'canvas') + ' ' + c.width + 'x' + c.height + (c.offsetParent ? '' : ' (hidden)')),
    backdrop: [...document.querySelectorAll('*')].filter(e => { const s = getComputedStyle(e); return s.backdropFilter && s.backdropFilter !== 'none' && e.offsetParent !== null; })
      .map(e => { const r = e.getBoundingClientRect(); return (e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + String(e.className).split(/\s+/)[0]) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); }),
    bodies: typeof World.bodies === 'function' ? World.bodies().length : null };
}
const call = (fn, ...args) => '(' + fn.toString() + ')(' + args.map(a => JSON.stringify(a)).join(',') + ')';
const PHASE_JS = {
  P3: ['(World.stop(), 1)', '(World.start(), 1)'],
  P3b: ['(World.stop(), window.__idleAbSpin = true, (function idleAbSpin() { if (window.__idleAbSpin) requestAnimationFrame(idleAbSpin); })(), 1)', '(window.__idleAbSpin = false, World.start(), 1)'],
  P4: ['(() => { window.__idleAbPaused = document.getAnimations().filter(a => a.playState === "running"); window.__idleAbPaused.forEach(a => a.pause()); return window.__idleAbPaused.length; })()', '((window.__idleAbPaused || []).forEach(a => a.play()), 1)'],
  P5: ['(() => { const s = document.createElement("style"); s.id = "__idle_ab_nobd"; s.textContent = "*,*::before,*::after{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}"; document.head.appendChild(s); return 1; })()', '((document.getElementById("__idle_ab_nobd") || { remove() {} }).remove(), 1)'],
};
// what each phase must REPORT to be valid (proc-footprint phaseValidity)
const PHASE_WANT = {
  P0: { focus: null, visibility: 'hidden', camera: 'manual', mode: 'minimized' },
  P1: { focus: 'focused', visibility: 'visible', camera: 'manual', hz: true, mode: 'focused' },
  P2: { focus: 'unfocused', visibility: 'visible', camera: 'manual', hz: true, mode: 'unfocused' },
  P3: { focus: 'focused', visibility: 'visible', camera: 'manual', mode: 'focused' },
  P3b: { focus: 'focused', visibility: 'visible', camera: 'manual', hz: true, mode: 'focused' },
  P4: { focus: 'focused', visibility: 'visible', camera: 'manual', hz: true, mode: 'focused' },
  P5: { focus: 'focused', visibility: 'visible', camera: 'manual', hz: true, mode: 'focused' },
  AB: { focus: 'focused', visibility: 'visible', camera: 'manual', hz: true, mode: 'focused' },
  P6: { focus: 'focused', visibility: 'visible', camera: 'auto', hz: true, mode: 'focused' },
  P7: { focus: 'focused', visibility: 'visible', camera: 'manual', rested: true, hz: true, mode: 'focused' },   // rested: a never-engaged director also reads 'manual'
};
// the pacer's draw-rate rule, the STILL window readout, the rAF-per-draw window and the P7 budget verdict live in proc-footprint.mjs
// (F.expectedDraws, F.stillWindow, F.pacerWindow, F.idleBudgetVerdict: tested there)
const MSG_WAKE_SETTLE_MS = 40000;   // P7's message wake waits this long, at most, for the touched station to rest and settle again (a social beat runs up to 55 s)

// ---------- one run ----------
async function runOnce(k) {
  const repo = resolve(arg('--repo', here)), label = arg('--label', 'x');
  const station = resolve(arg('--station', join(repo, 'dev', 'fixtures', 'seed-workspace')));
  const settleS = Number(arg('--settle', '20')), windowS = Number(arg('--window', '60'));
  const phases = arg('--phases', PHASE_ORDER.join(',')).split(',').map(s => s.trim()).filter(Boolean);
  for (const p of phases) if (!PHASE_ORDER.includes(p)) throw new Error('unknown phase ' + p + ' (have ' + PHASE_ORDER.join(',') + ')');
  const forced = arg('--force-contended', ''), minFreeGB = Number(arg('--min-free-gb', '1.5'));
  if (!EDGE) throw new Error('msedge.exe not found (set STARNET_BENCH_EDGE)');
  if (!existsSync(join(station, 'agent.save.json'))) throw new Error('no agent.save.json in --station ' + station);

  const runId = [label, basename(station).replace(/[^\w.-]+/g, '_'), k, Date.now().toString(36)].join('-');
  const runDir = join(RUNS_ROOT, runId), ws = join(runDir, 'ws'), edgeProfile = join(runDir, 'edge-profile');
  mkdirSync(ws, { recursive: true });
  // only the station's SHAPE travels: save, roster, dossier — never secrets, journals or checkpoints
  for (const f of readdirSync(station)) if (/^(agent\.save|agent\.roster|_commander\.dossier)\.json$/.test(f)) cpSync(join(station, f), join(ws, f));
  try {   // stamp the save so the server copy wins the boot reconcile (same as materializeSeedWorkspace)
    const p = join(ws, 'agent.save.json'), w = JSON.parse(readFileSync(p, 'utf8')), now = Date.now();
    w.updatedAt = now; w.savedAt = now; if (w.doc) w.doc.updatedAt = now;
    writeFileSync(p, JSON.stringify(w));
  } catch (_) {}

  const res = { tool: 'perf-idle-ab', schema: 1, runId, label, repo, station, at: new Date().toISOString(), node: process.version, phases: [], ab: null, errors: [] };
  try { res.repoHead = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch (_) {}
  res.preflight = systemPreflight(forced);
  console.log('[idle-ab] run', runId, '\n  preflight', JSON.stringify(res.preflight));
  if (res.preflight.freeGB != null && res.preflight.freeGB < minFreeGB) {
    res.errors.push('refused: free RAM ' + res.preflight.freeGB + ' GB is under --min-free-gb ' + minFreeGB + ' (starting Edge + a sidecar now could starve whatever is running)');
    writeFileSync(join(runDir, 'result.json'), JSON.stringify(res, null, 1));
    console.log('[idle-ab] REFUSED:', res.errors[0]);
    return res;
  }
  res.edge = { path: EDGE, version: fileVersion(EDGE) };
  res.webview2Runtime = webview2Versions();
  res.engineParity = !!res.edge.version && res.webview2Runtime.includes(res.edge.version);
  const disp = displays();
  const monArg = arg('--monitor', '');
  let mon = null;
  if (/^\d+,\d+$/.test(monArg)) { const [x, y] = monArg.split(',').map(Number); mon = disp.find(d => x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h) || { name: 'explicit', wx: x, wy: y, hz: 0 }; }
  else if (monArg) mon = disp.find(d => Math.abs(d.hz - Number(monArg)) <= 1);
  else mon = disp.find(d => d.primary) || disp[0];
  if (!mon) throw new Error('no display at ' + monArg + ' Hz (have ' + disp.map(d => d.name + '@' + d.hz).join(', ') + ')');
  const other = disp.find(d => d !== mon && d.name !== mon.name) || mon;
  const targetHz = Number(arg('--hz', '')) || mon.hz || null;
  const bounds = { left: mon.wx, top: mon.wy, width: Math.min(1920, mon.ww || 1920), height: Math.min(1032, mon.wh || 1032) };
  res.display = { monitor: mon, other: other === mon ? null : other, targetHz, bounds, all: disp };

  const live = new Set(), own = {};
  const port = await freePort(), cdpPort = await freePort(), base = 'http://127.0.0.1:' + port;
  const marker = '--idle-ab-run=' + runId;
  const { env, dirs } = F.hermeticEnv({ baseEnv: process.env, runDir, ws, port });
  for (const d of dirs) mkdirSync(d, { recursive: true });
  const log = openSync(join(runDir, 'sidecar.log'), 'a');
  const side = spawn(process.execPath, [join(repo, 'sidecar', 'index.js'), marker], { cwd: repo, env, stdio: ['ignore', log, log, 'ipc'], windowsHide: true });
  own.sidecar = recordPid(runDir, 'sidecar', side.pid, marker);
  let edge = null, browser = null, page = null, helperId = null, stationTargetId = null, windowId = null, focusEmulated = false;

  const teardown = async () => {
    const out = {};
    for (const c of live) { try { c.kill(); } catch (_) {} }   // our sampler PowerShells, by handle
    try { if (browser) await Promise.race([browser.send('Browser.close'), sleep(5000)]); } catch (_) {}
    if (edge && edge.exitCode === null) await Promise.race([new Promise(r => edge.once('exit', r)), sleep(10000)]);
    if (side.exitCode === null) {
      const exited = new Promise(r => side.once('exit', r));
      try { side.send({ type: 'starnet.shutdown' }); } catch (_) {}   // index.js graceful IPC stop (Windows has no SIGTERM)
      await Promise.race([exited, sleep(15000)]);
    }
    for (const [key, rec] of Object.entries(own)) out[key] = killOwn(rec);
    return out;
  };
  const onInt = () => { teardown().then(t => { console.log('[idle-ab] interrupted; teardown', JSON.stringify(t)); process.exit(130); }); };
  process.once('SIGINT', onInt);

  try {
    // sidecar up
    const t0 = Date.now();
    let up = false;
    for (let i = 0; i < 360 && !up; i++) { try { up = (await fetch(base + '/api/health', { signal: AbortSignal.timeout(1000) })).status === 200; } catch (_) {} if (!up) await sleep(500); }
    if (!up) throw new Error('sidecar never became healthy (see ' + join(runDir, 'sidecar.log') + ')');
    res.sidecarBootMs = Date.now() - t0;

    // headed Edge on the monitor under test
    const edgeArgs = [`--user-data-dir=${edgeProfile}`, `--remote-debugging-port=${cdpPort}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
      '--disable-extensions', '--disable-default-apps', '--disable-background-networking', '--disable-component-update', '--mute-audio',
      '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--disable-features=CalculateNativeWinOcclusion', '--force-device-scale-factor=1',
      `--window-position=${bounds.left},${bounds.top}`, `--window-size=${bounds.width},${bounds.height}`, '--app=data:text/html,<title>idle-ab</title>'];
    edge = spawn(EDGE, edgeArgs, { stdio: 'ignore' });
    own.edge = recordPid(runDir, 'edge', edge.pid, edgeProfile);
    res.edgeArgs = edgeArgs;
    let ver = null;
    for (let i = 0; i < 120 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(); } catch (_) { await sleep(250); } }
    if (!ver) throw new Error('Edge CDP endpoint never came up');
    const open = async url => { const w = new WebSocket(url); await new Promise((r, j) => { w.addEventListener('open', r, { once: true }); w.addEventListener('error', j, { once: true }); }); const c = new CDP(w); c.timeoutMs = 120000; return c; };
    browser = await open(ver.webSocketDebuggerUrl);
    const pinfo = (await browser.send('SystemInfo.getProcessInfo')).processInfo || [];
    const bpid = (pinfo.find(p => p.type === 'browser') || {}).id;
    res.edgeBrowserPid = bpid;
    if (bpid && bpid !== edge.pid) own.edgeBrowser = recordPid(runDir, 'edgeBrowser', bpid, edgeProfile);   // Edge handed off: own that one too

    // the station page: exactly one page target, picked by URL
    let pages = [];
    for (let i = 0; i < 40; i++) { pages = (await browser.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page'); if (pages.some(t => t.url.startsWith('data:text/html'))) break; await sleep(250); }
    const mine = pages.find(t => t.url.startsWith('data:text/html'));
    if (!mine) throw new Error('no bench page target (have ' + pages.map(t => t.url).join(', ') + ')');
    stationTargetId = mine.targetId;
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    page = await open(list.find(t => t.id === stationTargetId).webSocketDebuggerUrl);
    await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Performance.enable');
    const look = arg('--look', 'andrew');
    const lookPatch = look === 'none' ? null : look === 'andrew' ? ANDREW_LOOK : JSON.parse(look);
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: call(rafProbe) + ';' + (look === 'andrew' ? call(seedLocal, ANDREW_LOCAL) : '') });
    // the idle renderer flag rides the page URL, so LAZY ART is in force from the first script (--idle-renderer on|off)
    const idleFlag = arg('--idle-renderer', null);
    await page.send('Page.navigate', { url: base + '/' + (idleFlag ? '?idleRenderer=' + (idleFlag === 'on' ? '1' : '0') : '') });
    if (!(await waitDevReady(page, evalJS, { tries: 90, url: base + '/' }))) throw new Error('the page never reached the floor');
    const extra = (await browser.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page' && t.targetId !== stationTargetId);
    for (const t of extra) { try { await browser.send('Target.closeTarget', { targetId: t.targetId }); } catch (_) {} }
    res.closedExtraTargets = extra.map(t => t.url);
    const pagesNow = (await browser.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page');
    if (pagesNow.length !== 1 || pagesNow[0].targetId !== stationTargetId) throw new Error('want exactly one page target, have ' + pagesNow.map(t => t.url).join(', '));
    windowId = (await browser.send('Browser.getWindowForTarget', { targetId: stationTargetId })).windowId;
    if (!(await evalJS(page, '!!(window.__idleAbRaf && window.__idleAbRaf.booked > 0)'))) throw new Error('the passive rAF probe is not installed (or the world never booked a frame)');

    if (lookPatch) { try { res.look = await evalJS(page, `(() => { const r = StationUI.setLook(${JSON.stringify(lookPatch)}); return { now: r.now, saved: r.saved }; })()`); } catch (e) { res.errors.push('look: ' + e.message); } }
    res.lookLocal = await evalJS(page, `(${JSON.stringify(Object.keys(ANDREW_LOCAL))}).map(k => k + '=' + localStorage.getItem(k))`);
    // pin the cinecam: after 2 min hands-off it zooms ~2.6x and drifts every A/B
    await evalJS(page, '(World.setCinecamIdle(1e9), World.refit(), 1)');
    await sleep(500);
    const cam = await evalJS(page, 'World.cameraDbg()');
    if (cam.thresholdMs !== 1e9) throw new Error('cinecam pin did not take (thresholdMs ' + cam.thresholdMs + ')');
    res.cameraPinned = cam;
    res.info = await evalJS(page, call(pageInfo));
    console.log('  page', JSON.stringify(res.info).slice(0, 600));

    // ---------- window control ----------
    const restore = async () => {
      const b = (await browser.send('Browser.getWindowBounds', { windowId })).bounds;
      if (b.windowState !== 'normal') await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await browser.send('Browser.setWindowBounds', { windowId, bounds });
    };
    const closeHelper = async () => { if (helperId) { try { await browser.send('Target.closeTarget', { targetId: helperId }); } catch (_) {} helperId = null; } };
    const setMode = async mode => {
      await page.send('Emulation.setFocusEmulationEnabled', { enabled: false }); focusEmulated = false;
      if (mode === 'minimized') { await closeHelper(); await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }); return; }
      await restore();
      if (mode === 'focused') {
        await closeHelper();
        await browser.send('Target.activateTarget', { targetId: stationTargetId });
        await page.send('Page.bringToFront');
        await sleep(800);
        if (!(await evalJS(page, 'document.hasFocus()'))) { await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }); focusEmulated = true; }
      } else if (mode === 'unfocused') {
        if (!helperId) {
          helperId = (await browser.send('Target.createTarget', { url: 'about:blank', newWindow: true })).targetId;
          const hw = (await browser.send('Browser.getWindowForTarget', { targetId: helperId })).windowId;
          await browser.send('Browser.setWindowBounds', { windowId: hw, bounds: { left: other.wx + 40, top: other.wy + 40, width: 480, height: 320 } });
        }
        await browser.send('Target.activateTarget', { targetId: helperId });
        await sleep(800);
      }
    };
    const metrics = async () => Object.fromEntries((await page.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const procs = async () => ((await browser.send('SystemInfo.getProcessInfo')).processInfo || []).map(p => ({ type: p.type, id: p.id, cpu: p.cpuTime }));
    const roots = () => [own.edgeBrowser ? own.edgeBrowser.pid : edge.pid, side.pid];

    // one measured window: page + Chromium + OS, nothing else touches the page in between
    const measure = async (seconds, { sampler = true } = {}) => {
      const startAt = Date.now() + (sampler ? 3000 : 200);
      const samp = sampler ? startSampler(roots(), seconds, startAt, live) : null;
      await sleep(Math.max(0, startAt - Date.now()));
      await evalJS(page, '(World._dbgReviewPerformance && World._dbgReviewPerformance(true), 1)');
      const a = { p: await procs(), m: await metrics(), s: await evalJS(page, call(pageState)), t: Date.now() };
      await sleep(seconds * 1000);
      const b = { p: await procs(), m: await metrics(), s: await evalJS(page, call(pageState)), t: Date.now() };
      const review = await evalJS(page, call(reviewRead)).catch(e => ({ error: e.message }));
      const os = samp ? await samp.result : null;
      const wallS = (b.t - a.t) / 1000, pageS = (b.s.t - a.s.t) / 1000;
      const cpuBy = {}, perProc = [];
      for (const q of b.p) {
        const q0 = a.p.find(x => x.id === q.id);
        const pct = +(100 * (q.cpu - (q0 ? q0.cpu : 0)) / wallS).toFixed(2);
        perProc.push({ type: q.type, pid: q.id, pct, bornInWindow: !q0 });
        const kind = /mojom/i.test(q.type) ? 'utility' : q.type;   // Edge names utilities by service (network.mojom.NetworkService …)
        cpuBy[kind] = +((cpuBy[kind] || 0) + pct).toFixed(2);
      }
      const renderers = perProc.filter(x => x.type === 'renderer').sort((x, y) => y.pct - x.pct);
      const fired = b.s.raf.fired - a.s.raf.fired, sampled = b.s.raf.sampled - a.s.raf.sampled, bySite = {};
      for (const [site, n] of Object.entries(b.s.raf.sites)) { const d = n - (a.s.raf.sites[site] || 0); if (d > 0) bySite[site] = sampled ? Math.round(fired * d / sampled / pageS) : null; }
      const pw = F.pacerWindow(a.s, b.s);
      const row = {
        wallS: +wallS.toFixed(2),
        drawsPerS: +((b.s.draws - a.s.draws) / pageS).toFixed(2),
        rafPerS: +(fired / pageS).toFixed(2), rafBySitePerS: bySite,
        // the pacer's own account of the window: rAF callbacks per draw (the page's, and the world's own = draws + skipped) and the
        // callbacks its pace check sent back undrawn; null on a tree that does not count them (see F.pacerWindow)
        rafPerDraw: pw ? pw.rafPerDraw : null, worldRafPerDraw: pw ? pw.worldRafPerDraw : null, skippedFrames: pw ? pw.skippedFrames : null, pacer: pw,
        timerLateMs: Number.isFinite(b.s.pace.timerLateMs) ? b.s.pace.timerLateMs : null,   // the margin the still booking allowed for at the window's end (15.6 = the tick: unmeasured or late)
        vsyncHz: b.s.vsyncMs > 0 ? +(1000 / b.s.vsyncMs).toFixed(2) : null, worldVsyncHz: b.s.pace.vsyncMs > 0 ? +(1000 / b.s.pace.vsyncMs).toFixed(2) : null,
        mainBusyPct: +(100 * (b.m.TaskDuration - a.m.TaskDuration) / wallS).toFixed(2),
        scriptPct: +(100 * (b.m.ScriptDuration - a.m.ScriptDuration) / wallS).toFixed(2),
        stylePct: +(100 * (b.m.RecalcStyleDuration - a.m.RecalcStyleDuration) / wallS).toFixed(2),
        layoutPct: +(100 * (b.m.LayoutDuration - a.m.LayoutDuration) / wallS).toFixed(2),
        draw: { meanMs: review.mean ?? null, p95Ms: review.p95 ?? null, samples: review.n ?? null, emaMs: b.s.pace.drawCostMs, crt: review.crt ?? null },
        cdp: { rendererPct: cpuBy.renderer ?? 0, stationRendererPct: renderers[0] ? renderers[0].pct : null, renderers: renderers.length, gpuPct: cpuBy.GPU ?? 0, browserPct: cpuBy.browser ?? 0,
          utilityPct: cpuBy.utility ?? 0, otherPct: +Object.entries(cpuBy).filter(([t]) => !['renderer', 'GPU', 'browser', 'utility'].includes(t)).reduce((s, [, v]) => s + v, 0).toFixed(2), procs: perProc },
        jsHeapMB: Math.round(b.m.JSHeapUsedSize / 1048576), nodes: b.m.Nodes,
        obs: [a.s, b.s].map(s => ({ hasFocus: s.hasFocus, focusEmulated, visibilityState: s.visibilityState, vsyncMs: s.vsyncMs, vsyncGaps: s.vsyncGaps, worldVsyncMs: s.pace.vsyncMs, cameraMode: s.camera.mode, cineRested: s.camera.rested, crewSettled: s.camera.crewSettled, paceMode: s.pace.mode, paceMs: s.pace.paceMs, running: s.pace.running,
          // the STILL pace books rAF from a timer ~30x a second: the probe sees the timer's gaps, not the panel's (see phaseValidity)
          hzExempt: s.pace.mode === 'still' ? 'the still pace is timer-booked: no vsync-rate frame to read the panel from' : null, stillWhy: s.pace.stillWhy })),
        still: F.stillWindow({ draws: a.s.draws, stillFrames: a.s.pace.stillFrames, stillWhyCounts: a.s.pace.stillWhyCounts }, { draws: b.s.draws, stillFrames: b.s.pace.stillFrames, stillWhyCounts: b.s.pace.stillWhyCounts }),
      };
      if (os) {
        if (os.error) row.os = { error: os.error };
        else {
          const gpuPid = (b.p.find(q => q.type === 'GPU') || {}).id, sidecarPid = side.pid;
          const rows = os.processes || [], pick = pid => rows.find(r => r.pid === pid) || null;
          const drift = rows.filter(r => F.roleOf(r.name, r.sig, { root: roots().includes(r.pid) }) !== r.role).map(r => r.pid + ':' + r.role);
          const sum = F.summarize(rows), role = r => sum.byRole[r] || { cpuPctOneCore: 0, privMB: 0 };
          const g = pick(gpuPid), sc = pick(sidecarPid);
          const sidecarTree = F.walkTree(rows.map(r => ({ pid: r.pid, ppid: r.ppid, created: r.created })), [sidecarPid]).map(r => r.pid);
          row.os = {
            wallS: os.wallS, preflight: os.preflight, byRole: sum.byRole, total: sum.total,
            gpu3dPct: g ? g.gpuPct : null, gpu3dPctMax: g ? g.gpuPctMax : null, gpuByType: g ? g.gpuByType : null, gpuDedMB: g ? g.gpuDedMB : null, gpuSharedMB: g ? g.gpuSharedMB : null, gpuPrivMB: g ? g.privMB : null,
            sidecarCpuPct: sc ? sc.cpuPctOneCore : null, sidecarPrivMB: sc ? sc.privMB : null,
            sidecarTreeCpuPct: +rows.filter(r => sidecarTree.includes(r.pid)).reduce((s, r) => s + r.cpuPctOneCore, 0).toFixed(2),
            webCpuPct: +rows.filter(r => /^web-/.test(r.role)).reduce((s, r) => s + r.cpuPctOneCore, 0).toFixed(2),
            webPrivMB: +rows.filter(r => /^web-/.test(r.role)).reduce((s, r) => s + r.privMB, 0).toFixed(1),
            roleDrift: drift,   // a sampler role proc-footprint.mjs disagrees with: the two rule copies drifted
          };
          row.crossCheck = { renderer: F.crossCheck(role('web-renderer').cpuPctOneCore, row.cdp.rendererPct), gpu: F.crossCheck(role('web-gpu').cpuPctOneCore, row.cdp.gpuPct), browser: F.crossCheck(role('web-browser').cpuPctOneCore, row.cdp.browserPct) };
        }
      }
      row.contended = !!forced || !!res.preflight.contended && !os || !!(os && os.preflight && os.preflight.contended);
      row.contendedWhy = [].concat(forced ? ['forced: ' + forced] : [], os && os.preflight ? os.preflight.reasons || [] : (res.preflight.reasons || []));
      return row;
    };
    const judge = (name, row, extra = {}) => {
      const w = PHASE_WANT[name] || {};
      const v = F.phaseValidity({ name, focus: w.focus, visibility: w.visibility, camera: w.camera, rested: w.rested, hz: w.hz ? targetHz : null, ...extra }, row.obs);
      return Object.assign({ phase: name, label: v.label || name, valid: v.valid, invalidWhy: v.reasons, checksSkipped: v.skipped }, row);
    };
    const show = r => console.log('  ' + (r.phase + (r.cap != null ? '@' + r.capLabel : '')).padEnd(14) + (r.valid ? 'ok     ' : 'INVALID') + (r.contended ? ' CONTENDED' : '          ') +
      ` draws ${r.drawsPerS}/s raf ${r.rafPerS}/s` + (r.rafPerDraw != null ? ` (${r.rafPerDraw}/draw` + (r.skippedFrames != null ? `, world ${r.worldRafPerDraw}, ${r.skippedFrames} skipped` : '') + ')' : '') + (r.timerLateMs != null ? ` timers<=${r.timerLateMs}ms` : '') + ` vsync ${r.vsyncHz}Hz main ${r.mainBusyPct}%` + (r.still ? ` still ${Math.round(r.still.share * 100)}%` + (r.still.share < 0.95 ? ' (' + Object.entries(r.still.why).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, n]) => k + ' ' + n).join(', ') + ')' : '') : '') +
      ` | cdp rend ${r.cdp.rendererPct}% gpu ${r.cdp.gpuPct}% brw ${r.cdp.browserPct}%` +
      (r.os && !r.os.error ? ` | os gpu3d ${r.os.gpu3dPct}% gpuDed ${r.os.gpuDedMB}MB side ${r.os.sidecarCpuPct}% ${r.os.sidecarPrivMB}MB` : r.os ? ' | os ' + r.os.error : '') +
      (r.valid ? '' : ' :: ' + r.invalidWhy.join('; ')));

    // ---------- phases ----------
    for (const name of phases) {
      const want = PHASE_WANT[name];
      if (name === 'AB') {
        const caps = arg('--caps', '0,33.333,200').split(',').map(Number), rounds = Number(arg('--rounds', '3'));
        const sliceS = Number(arg('--slice', '30')), sliceSettleS = Number(arg('--slice-settle', '5'));
        await setMode('focused');
        await sleep(settleS * 1000);
        const rows = [];
        for (let r = 1; r <= rounds; r++) for (const cap of caps) {
          await evalJS(page, `(World.setFrameCap(${cap}), 1)`);
          if (!focusEmulated && !(await evalJS(page, 'document.hasFocus()'))) await setMode('focused');
          await sleep(sliceSettleS * 1000);
          const row = judge('AB', await measure(sliceS), cap >= 100 ? { hz: null } : {});   // the timer path books no vsync-rate frame to read the panel from
          row.cap = cap; row.capLabel = cap ? Math.round(1000 / cap) + '/s' : 'pace'; row.round = r;
          const pace = row.obs[1].paceMs, mode = row.obs[1].paceMode;
          // a still row's draws are timer-booked: expect them from the world's own vsync; a row that mixed still and moving
          // frames has no single pace to track, so it is labelled instead of judged
          const mixed = !cap && row.still && row.still.share > 0.05 && row.still.share < 0.95;
          row.expectedDrawsPerS = mixed ? null : F.expectedDraws(pace, mode === 'still' ? (row.worldVsyncHz ? 1000 / row.worldVsyncHz : 0) : (row.vsyncHz ? 1000 / row.vsyncHz : 0), mode);
          row.tracksPacer = row.expectedDrawsPerS ? Math.abs(row.drawsPerS - row.expectedDrawsPerS) / row.expectedDrawsPerS <= 0.1 : null;
          if (mixed) row.paceNote = 'mixed: ' + Math.round(row.still.share * 100) + '% of draws still (' + Object.entries(row.still.why).map(([k, n]) => k + ' ' + n).join(', ') + ')';
          if (cap && row.obs.some(o => o.paceMode !== 'capped')) { row.valid = false; row.invalidWhy.push('setFrameCap(' + cap + ') but renderPace().mode is not capped'); }
          rows.push(row); show(row);
        }
        await evalJS(page, '(World.setFrameCap(0), 1)');
        const metricsOf = ['drawsPerS', 'rafPerS', 'mainBusyPct', r => r.cdp.rendererPct, r => r.cdp.gpuPct, r => r.cdp.browserPct, r => r.os && r.os.gpu3dPct, r => r.os && r.os.webCpuPct];
        const names = ['drawsPerS', 'rafPerS', 'mainBusyPct', 'cdp.rendererPct', 'cdp.gpuPct', 'cdp.browserPct', 'os.gpu3dPct', 'os.webCpuPct'];
        const byCap = {};
        for (const cap of caps) {
          const rs = rows.filter(x => x.cap === cap && x.valid);
          byCap[cap] = Object.fromEntries(names.map((n, i) => [n, F.stats(rs.map(x => typeof metricsOf[i] === 'function' ? metricsOf[i](x) : x[metricsOf[i]]))]));
        }
        const verdicts = {};
        const anyContended = rows.some(x => x.contended);
        for (const cap of caps.slice(1)) {
          verdicts[caps[0] + '->' + cap] = Object.fromEntries(names.map((n, i) => {
            const get = x => typeof metricsOf[i] === 'function' ? metricsOf[i](x) : x[metricsOf[i]];
            return [n, F.verdict(rows.filter(x => x.cap === caps[0] && x.valid).map(get), rows.filter(x => x.cap === cap && x.valid).map(get), { contended: anyContended })];
          }));
        }
        res.ab = { caps, rounds, sliceS, rows, byCap, verdicts };
        // the draw-rate price, medians over the valid slices (verdicts need --rounds >= 3 and an uncontended box)
        for (const cap of caps) console.log('  AB ' + (cap ? Math.round(1000 / cap) + '/s' : 'pace').padEnd(5) + names.map(n => ' ' + n + ' ' + byCap[cap][n].median).join(''));
        for (const [pair, vs] of Object.entries(verdicts)) console.log('  AB ' + pair + ': ' + names.map(n => n + ' ' + vs[n].verdict).join(', '));
        continue;
      }
      const saveCam = name === 'P6' || name === 'P7' ? await evalJS(page, 'World.cameraState()') : null;
      const hasIdle = await evalJS(page, 'typeof World.setIdleRenderer === "function"');
      if (name === 'P7' && !hasIdle) { console.log('  P7            skipped: this tree has no idle renderer'); continue; }
      const saveIdle = hasIdle && (name === 'P6' || name === 'P7') ? await evalJS(page, 'World.idleRendererOn()') : null;
      await setMode(want.mode);
      const js = PHASE_JS[name];
      if (js) await evalJS(page, js[0]);
      if (name === 'P6') {
        if (hasIdle) await evalJS(page, '(World.setCinecamRest(1e9), 1)');   // the engaged director, even on a page loaded with the flag on
        await evalJS(page, '(World.setCinecamIdle(1000), 1)');
        for (let i = 0; i < 60; i++) { if ((await evalJS(page, 'World.cameraDbg().mode')) === 'auto') break; await sleep(500); }
      }
      if (name === 'P7') {
        // engage the director first and let its shot land (the zoom and culling P6 measured), THEN let it rest where it is
        await evalJS(page, '(World.setIdleRenderer(true, false), World.setCinecamRest(1e9), World.setCinecamIdle(1000), 1)');
        for (let i = 0; i < 60; i++) { if ((await evalJS(page, 'World.cameraDbg().mode')) === 'auto') break; await sleep(500); }
        await sleep(4000);
        await evalJS(page, '(World.setCinecamRest(1000), 1)');
        for (let i = 0; i < 60; i++) { if ((await evalJS(page, 'World.cameraDbg().cineRested')) === true) break; await sleep(500); }
        // THE CREW SETTLE: each body settles at its next idle decision, after the step it is on (a social beat is capped at 55 s)
        for (let i = 0; i < 180; i++) { const c = await evalJS(page, 'World.cameraDbg()'); if (typeof c.crewSettled !== 'number' || c.crewSettled >= (await evalJS(page, 'typeof World.bodies === "function" ? World.bodies().length : 0'))) break; await sleep(500); }
      }
      await sleep(settleS * 1000);
      const row = judge(name, await measure(windowS));
      if (name === 'P0') row.harnessOk = row.drawsPerS === 0 && row.rafPerS === 0;   // anything else = the harness is broken
      if (name === 'P1') {   // walker duty cycle (F1 pricing), sampled AFTER the window so the window stays untouched
        const walkS = Number(arg('--walk-secs', '20')), samples = [];
        for (let t = 0; t < walkS * 2; t++) { samples.push(await evalJS(page, 'typeof World.bodies === "function" ? World.bodies().map(b => b.moving ? 1 : 0) : null')); await sleep(500); }
        const ok = samples.filter(Boolean);
        row.walkers = ok.length ? { samples: ok.length, bodies: ok[0].length, anyMovingShare: +(ok.filter(s => s.some(Boolean)).length / ok.length).toFixed(2),
          meanMoving: +(ok.reduce((a, s) => a + s.reduce((x, y) => x + y, 0), 0) / ok.length).toFixed(2) } : null;
      }
      // THE CREW SETTLE's wake, read AFTER the window so the window stays untouched: one synthetic pointermove (a first touch,
      // through the window's own input listener) must end the rest and hand every settled body its next decision by the next frame
      if (name === 'P7' && row.obs && typeof row.obs[1].crewSettled === 'number') row.wake = await evalJS(page, call(firstTouchWake));
      // ...and the same for NEWS: the touch just woke the station, so let it rest and settle AGAIN on the phase's own knobs (a hand
      // ends the rest for 2 s here), then send a message that starts no run. messageWake reads the state itself, so a wait that ran
      // out is its "skipped: did not re-settle", never a pass. A probe that throws is a skip too: it must not cost the measured window.
      if (name === 'P7' && row.wake) {
        try {
          await evalJS(page, '(World.setCinecamIdle(1000), World.setCinecamRest(1000), 1)');
          for (const t0 = Date.now(); Date.now() - t0 < MSG_WAKE_SETTLE_MS;) { const c = await evalJS(page, 'World.cameraDbg()'); if (c.crewSettled > 0 && c.cineRested === true) break; await sleep(500); }
          row.msgWake = await evalJS(page, call(messageWake));
        } catch (e) { row.msgWake = { ok: null, skipped: 'probe error: ' + (e && e.message || e) }; }
      }
      if (name === 'P7') row.budget = F.idleBudgetVerdict(row);   // P7 judges itself: a contended or invalid window is "unjudged", never a pass
      if (js) await evalJS(page, js[1]);
      if (name === 'P6') { await evalJS(page, `(World.setCinecamIdle(1e9), ${hasIdle ? 'World.setCinecamRest(0), ' : ''}World.restoreCamera(${JSON.stringify(saveCam)}), 1)`); }
      if (name === 'P7') { await evalJS(page, `(World.setIdleRenderer(${JSON.stringify(!!saveIdle)}, false), World.setCinecamRest(0), World.setCinecamIdle(1e9), World.restoreCamera(${JSON.stringify(saveCam)}), 1)`); }
      res.phases.push(row); show(row);
      if (row.wake) console.log('  P7 wake       ' + (row.wake.ok ? 'ok' : 'FAIL') + ': settled ' + row.wake.settledBefore + ' -> ' + row.wake.settledAfter + ' one frame after a first touch, rested ' + row.wake.restedBefore + ' -> ' + row.wake.restedAfter);
      if (row.msgWake) console.log('  P7 msg wake   ' + (row.msgWake.skipped ? 'skipped: ' + row.msgWake.skipped + (row.msgWake.settledBefore === undefined ? '' : ' within ' + MSG_WAKE_SETTLE_MS / 1000 + ' s (settled ' + row.msgWake.settledBefore + ', rested ' + row.msgWake.restedBefore + ')')
        : (row.msgWake.ok ? 'ok' : 'FAIL') + ': settled ' + row.msgWake.settledBefore + ' -> ' + row.msgWake.settledAfter + ' one frame after a message that starts no run, rested ' + row.msgWake.restedBefore + ' -> ' + row.msgWake.restedAfter));
      if (name === 'P7' && row.obs) console.log('  P7 crew       settled ' + row.obs.map(o => o.crewSettled).join(' -> ') + ' of ' + (await evalJS(page, 'typeof World.bodies === "function" ? World.bodies().length : null')) + ' bodies over the window');
      if (row.budget) console.log('  P7 budget     ' + F.idleBudgetLine(row.budget));
    }
    await setMode('focused').catch(() => {});
  } catch (e) {
    res.errors.push(String(e && e.stack || e));
    console.error('[idle-ab] ERROR', e && e.message || e);
  } finally {
    process.removeListener('SIGINT', onInt);
    res.teardown = await teardown();
    closeSync(log);
    res.finishedAt = new Date().toISOString();
    writeFileSync(join(runDir, 'result.json'), JSON.stringify(res, null, 1));
    const out = arg('--out', '');
    if (out) writeFileSync(resolve(out), JSON.stringify(res, null, 1));
    if (!flag('--keep')) { for (const d of [ws, edgeProfile, join(runDir, 'profile')]) { try { rmSync(d, { recursive: true, force: true }); } catch (_) {} } }
    console.log('[idle-ab]', runId, res.errors.length ? 'ERRORS ' + res.errors.length : 'ok', 'teardown', JSON.stringify(res.teardown), res.preflight.contended ? 'CONTENDED' : '', '\n  result', join(runDir, 'result.json'));
  }
  return res;
}

// ---------- compare: medians, ranges, the verdict rule ----------
function compare() {
  const A = arg('--a', ''), B = arg('--b', '');
  if (!A || !B) throw new Error('compare needs --a <label> --b <label>');
  const runs = [];
  for (const d of existsSync(RUNS_ROOT) ? readdirSync(RUNS_ROOT) : []) {
    const f = join(RUNS_ROOT, d, 'result.json');
    if (!existsSync(f)) continue;
    const r = JSON.parse(readFileSync(f, 'utf8'));
    if (r.tool === 'perf-idle-ab' && (r.label === A || r.label === B)) runs.push(r);
  }
  const M = { drawsPerS: r => r.drawsPerS, rafPerS: r => r.rafPerS, rafPerDraw: r => r.rafPerDraw, worldRafPerDraw: r => r.worldRafPerDraw, mainBusyPct: r => r.mainBusyPct, 'cdp.renderer': r => r.cdp && r.cdp.rendererPct, 'cdp.gpu': r => r.cdp && r.cdp.gpuPct,
    'cdp.browser': r => r.cdp && r.cdp.browserPct, 'os.gpu3d': r => r.os && r.os.gpu3dPct, 'os.web': r => r.os && r.os.webCpuPct, 'os.sidecar': r => r.os && r.os.sidecarCpuPct, 'os.webPrivMB': r => r.os && r.os.webPrivMB };
  const groups = {};
  for (const r of runs) {
    for (const p of r.phases || []) (groups[p.phase] = groups[p.phase] || []).push({ label: r.label, row: p });
    for (const p of (r.ab && r.ab.rows) || []) (groups['AB@' + p.capLabel] = groups['AB@' + p.capLabel] || []).push({ label: r.label, row: p });
  }
  console.log(`compare A=${A} (${runs.filter(r => r.label === A).length} runs) vs B=${B} (${runs.filter(r => r.label === B).length} runs) in ${RUNS_ROOT}`);
  for (const [g, rows] of Object.entries(groups)) {
    const valid = rows.filter(x => x.row.valid), contended = valid.some(x => x.row.contended);
    console.log(`\n== ${g}  valid ${valid.length}/${rows.length}${contended ? '  SOME CONTENDED' : ''}`);
    for (const [k, get] of Object.entries(M)) {
      const a = valid.filter(x => x.label === A).map(x => get(x.row)).filter(Number.isFinite), b = valid.filter(x => x.label === B).map(x => get(x.row)).filter(Number.isFinite);
      if (!a.length && !b.length) continue;
      const sa = F.stats(a), sb = F.stats(b), v = F.verdict(a, b, { contended });
      console.log('  ' + k.padEnd(15) + ` A ${String(sa.median).padStart(8)} [${sa.min}..${sa.max}] n${sa.n}   B ${String(sb.median).padStart(8)} [${sb.min}..${sb.max}] n${sb.n}   ${v.verdict}${v.verdict === 'NO VERDICT' ? ' (' + v.reason + ')' : ''}`);
    }
  }
  console.log('\nVERDICT RULE: improved only when every B run beats every A run, n>=3 each, valid phases only, no CONTENDED run.');
}

const cmd = argv[0];
if (cmd === 'run') {
  const n = Number(arg('--runs', '1'));
  for (let k = 1; k <= n; k++) await runOnce(k);
  process.exit(0);
} else if (cmd === 'compare') compare();
else if (cmd === 'cleanup') {
  const runDir = resolve(argv[1] || '.'), pids = JSON.parse(readFileSync(join(runDir, 'pids.json'), 'utf8'));
  for (const [key, rec] of Object.entries(pids)) console.log(key, rec.pid, killOwn(rec));
} else console.log('usage: node scripts/perf-idle-ab.mjs run|compare|cleanup (see the header)');
