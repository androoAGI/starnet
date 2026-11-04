// scripts/lib/proc-footprint.mjs — the pure rules of WHOLE-APP idle measurement (2026-10-20, piece 3 of the
// "eats my PC" plan). No I/O here: the OS sampler (scripts/perf/app-footprint.ps1) and the renderer A/B bench
// (scripts/perf-idle-ab.mjs) collect; these functions attribute, judge and compare. test/proc-footprint.test.js
// pins every rule against process shapes copied from a real box.
//
// WHY a tree walk and never a name match: on the box this was built on, 13 msedgewebview2.exe processes ran and NONE
// were StarNet's (SearchHost.exe and GoogleDriveFS.exe own WebView2 trees too). A filter by process name charged
// ~100 MB and their CPU to StarNet. Attribution starts at the app's OWN pid and follows ParentProcessId only.
//
// The PowerShell sampler mirrors roleOf / gpuPct / the contention rule (PowerShell cannot import this module); the
// bench re-derives every sampler row's role with roleOf and reports a mismatch, so the two copies cannot drift
// silently. Change a rule here AND in app-footprint.ps1 in the same commit.
import { join } from 'node:path';

// A measurement taken while the box is busy is not evidence (the sidecar idle bench's rule, 2026-10-19).
export const CONTENDED_CPU_PCT = 20;    // system CPU outside the measured tree, % of ALL cores
export const CONTENDED_FREE_GB = 4;     // free physical RAM
export const VSYNC_TOLERANCE = 0.03;    // a phase whose measured refresh is >3% off the intended monitor is INVALID
export const CROSSCHECK_TOLERANCE = 0.10;   // OS sampler vs SystemInfo.getProcessInfo, per process type
export const CROSSCHECK_FLOOR_PCT = 2;  // under 2% of a core both readings are noise; do not fail on ratio alone

const toMs = v => (v == null || v === '' ? NaN : typeof v === 'number' ? v : Date.parse(v));
export const normPath = p => String(p || '').replace(/\//g, '\\').replace(/^"+|"+$/g, '').replace(/\\+$/, '').toLowerCase();

/* Breadth-first walk over ParentProcessId from the root pid(s). rows: [{ pid, ppid, name, cmd?, created? }].
   A row whose creation time is EARLIER than its parent's is not that parent's child: Windows reuses pids, and an
   orphan whose dead parent's pid was handed to a newer process would otherwise be adopted by it. */
export function walkTree(rows, rootPids) {
  const byPid = new Map(), kids = new Map();
  for (const r of rows || []) {
    byPid.set(Number(r.pid), r);
    const pp = Number(r.ppid);
    if (!kids.has(pp)) kids.set(pp, []);
    kids.get(pp).push(r);
  }
  const out = [], seen = new Set(), q = [];
  for (const p of [].concat(rootPids || [])) { const r = byPid.get(Number(p)); if (r) q.push(r); }
  while (q.length) {
    const r = q.shift(), pid = Number(r.pid);
    if (seen.has(pid)) continue;
    seen.add(pid); out.push(r);
    const born = toMs(r.created);
    for (const c of kids.get(pid) || []) {
      if (Number(c.pid) === pid) continue;                       // pid 0 / System report themselves as their parent
      const cb = toMs(c.created);
      if (Number.isFinite(born) && Number.isFinite(cb) && cb < born) continue;   // pid reuse, see above
      q.push(c);
    }
  }
  return out;
}

const WEB_EXE = /^(msedgewebview2|msedge|chrome|chromium|chrome-headless-shell)\.exe$/i;
const SHELL_EXE = /^(conhost|cmd|powershell|pwsh|bash|sh)\.exe$/i;
const SIDECAR_ENTRY = /sidecar[\\/]+index\.js/i;

/* What a process IS in the app's tree:
     host                the app's own root exe (skynet-desktop.exe)
     web-browser         the WebView2 / Edge browser process (no --type)
     web-gpu             --type=gpu-process (composite + present; the backdrop re-blur lands here)
     web-renderer        --type=renderer (the page's main thread: world draws, DOM/CSS)
     web-util:<x>        --type=utility, <x> from --utility-sub-type (network, storage, audio …)
     web-crashpad        --type=crashpad-handler
     web-other:<type>    any other Chromium child type
     sidecar             node.exe running …sidecar\index.js
     node-child          any other node.exe (MCP servers, tools the sidecar spawned)
     shell               conhost / cmd / powershell / pwsh / bash / sh
     other:<name>        anything else under the root */
export function roleOf(name, cmd, { root = false } = {}) {
  const n = String(name || ''), c = String(cmd || '');
  if (WEB_EXE.test(n)) {
    const t = /--type=([\w-]+)/.exec(c);
    if (!t) return 'web-browser';
    if (t[1] === 'gpu-process') return 'web-gpu';
    if (t[1] === 'renderer') return 'web-renderer';
    if (t[1] === 'crashpad-handler') return 'web-crashpad';
    if (t[1] === 'utility') {
      const s = /--utility-sub-type=([\w.]+)/.exec(c);
      return 'web-util:' + (s ? s[1].replace(/\.mojom\..*$/i, '').toLowerCase() : 'unknown');
    }
    return 'web-other:' + t[1];
  }
  if (/^node(\.exe)?$/i.test(n)) return SIDECAR_ENTRY.test(c) ? 'sidecar' : 'node-child';
  if (SHELL_EXE.test(n)) return 'shell';
  if (root) return 'host';
  return 'other:' + n.replace(/\.exe$/i, '').toLowerCase();
}

// --user-data-dir from a Chromium command line, quoted or bare
export function userDataDirOf(cmd) {
  const m = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(String(cmd || ''));
  return m ? (m[1] || m[2]) : null;
}

/* Is this WebView2 browser child really the app's? Its --user-data-dir must end in <identifier>\EBWebView (the
   Tauri default, %LOCALAPPDATA%\<identifier>\EBWebView), or be the WEBVIEW2_USER_DATA_FOLDER override (with or
   without the EBWebView leaf WebView2 appends). A foreign dir means the walk started at the wrong root. */
export function webviewIdentity(row, { identifier = 'ai.skynet.harness', userDataFolder = '' } = {}) {
  const dir = userDataDirOf(row && row.cmd);
  if (!dir) return { ok: false, userDataDir: null, reason: 'no --user-data-dir on the browser command line' };
  const d = normPath(dir), want = [];
  if (identifier) want.push('\\' + normPath(identifier) + '\\ebwebview');
  const udf = normPath(userDataFolder);
  const ok = (identifier && d.endsWith(want[0])) || (!!udf && (d === udf || d === udf + '\\ebwebview'));
  return ok ? { ok: true, userDataDir: dir }
    : { ok: false, userDataDir: dir, reason: 'user-data-dir is not ' + (identifier ? '<…>\\' + identifier + '\\EBWebView' : '') + (udf ? (identifier ? ' or ' : '') + userDataFolder : '') };
}

// CPU as a percent of ONE core (100 = one core busy for the whole wall), from a CPU-time delta over the same wall
export function cpuPctOneCore(deltaCpuMs, wallMs) {
  return wallMs > 0 && Number.isFinite(deltaCpuMs) ? +(100 * deltaCpuMs / wallMs).toFixed(2) : null;
}

/* '\GPU Engine(pid_<p>_luid_<hi>_<lo>_phys_<n>_eng_<n>_engtype_<type>)\Utilization Percentage' instance names. */
export function parseGpuInstance(instance) {
  const m = /^pid_(\d+)_luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_(\d+)(?:_eng_(\d+)_engtype_(.*))?$/i.exec(String(instance || '').trim());
  if (!m) return null;
  return { pid: Number(m[1]), luid: m[2].toLowerCase(), phys: Number(m[3]), eng: m[4] == null ? null : Number(m[4]), engtype: m[5] == null ? null : m[5].toLowerCase() };
}

/* Task Manager's per-process GPU %: sum the engine instances of each (adapter, engine type), then the busiest. Two
   adapters live on the reference box (AMD 144 Hz, NVIDIA 239 Hz), so the luid is part of the key: a 3D engine on one
   card never adds to a 3D engine on the other. samples: [{ instance, value }] for ONE pid at ONE moment. */
export function gpuPct(samples) {
  const sum = new Map();
  for (const s of samples || []) {
    const g = parseGpuInstance(s.instance);
    if (!g || g.engtype == null) continue;
    const k = g.luid + '|' + g.engtype;
    sum.set(k, (sum.get(k) || 0) + (Number(s.value) || 0));
  }
  let max = 0, key = null;
  for (const [k, v] of sum) if (v > max) { max = v; key = k; }
  return { pct: +max.toFixed(2), busiest: key, byType: Object.fromEntries([...sum].map(([k, v]) => [k, +v.toFixed(2)])) };
}

// the same rule over a mixed sample set: { pid: { pct, busiest, byType } }
export function gpuPctByPid(samples) {
  const per = new Map();
  for (const s of samples || []) {
    const g = parseGpuInstance(s.instance);
    if (!g) continue;
    if (!per.has(g.pid)) per.set(g.pid, []);
    per.get(g.pid).push(s);
  }
  return Object.fromEntries([...per].map(([pid, rows]) => [pid, gpuPct(rows)]));
}

// '\GPU Process Memory(pid_<p>_luid_…_phys_<n>)\Dedicated Usage' / '…\Shared Usage' (bytes) → MB per pid, all adapters
export function gpuMemByPid(samples) {
  const out = {};
  for (const s of samples || []) {
    const g = parseGpuInstance(s.instance);
    if (!g) continue;
    const kind = /dedicated/i.test(String(s.path || s.counter || '')) ? 'dedicatedMB' : /shared/i.test(String(s.path || s.counter || '')) ? 'sharedMB' : null;
    if (!kind) continue;
    const o = out[g.pid] || (out[g.pid] = { dedicatedMB: 0, sharedMB: 0 });
    o[kind] = +(o[kind] + (Number(s.value) || 0) / 1048576).toFixed(1);
  }
  return out;
}

/* Contention: the box is busy with something that is not us. systemCpuPct is % of ALL cores (Processor(_Total));
   treeCpuPctOneCore is our own tree in %-of-one-core and is taken back out before judging. */
export function preflight({ systemCpuPct = null, treeCpuPctOneCore = 0, cores = 1, freeGB = null, forced = '' } = {}) {
  const reasons = [];
  const outside = systemCpuPct == null ? null : +(systemCpuPct - (treeCpuPctOneCore || 0) / Math.max(1, cores)).toFixed(1);
  if (outside != null && outside > CONTENDED_CPU_PCT) reasons.push('system CPU outside the measured tree ' + outside + '% > ' + CONTENDED_CPU_PCT + '%');
  if (freeGB != null && freeGB < CONTENDED_FREE_GB) reasons.push('free RAM ' + (+freeGB).toFixed(2) + ' GB < ' + CONTENDED_FREE_GB + ' GB');
  if (forced) reasons.push('marked contended by the operator: ' + forced);
  return { contended: reasons.length > 0, reasons, outsideCpuPct: outside, freeGB: freeGB == null ? null : +(+freeGB).toFixed(2) };
}

/* A phase's label is what the page REPORTED, never what the bench asked for. Never mislabel a phase:
     want.focus 'focused'   hasFocus true → 'focused'; true under Emulation.setFocusEmulationEnabled → 'focused(emulated)';
                            false → INVALID
     want.focus 'unfocused' hasFocus false → 'unfocused'; true → INVALID
     want.visibility        the document's visibilityState must match ('hidden' when minimized, 'visible' otherwise)
     want.hz                1000/renderPace().vsyncMs within VSYNC_TOLERANCE of the monitor the window is on — except an
                            observation that says why it cannot be read (o.hzExempt: the STILL pace, 2026-10-21, books rAF
                            from a timer ~30x a second, so the probe sees the timer's gaps, not the panel's); the skip is
                            reported in `skipped`, never silent
     want.camera            cameraDbg().mode: 'manual' (pinned) or 'auto' (the cinecam P6 engages)
   obs may be one observation or a list (window start AND end); every one must pass. */
export function phaseValidity(want = {}, obs = {}) {
  const list = [].concat(obs), reasons = [], skipped = [];
  let label = want.focus || want.name || 'phase';
  for (const o of list) {
    if (want.focus === 'focused') {
      if (o.hasFocus !== true) reasons.push('labelled focused but document.hasFocus() is ' + o.hasFocus);
      else if (o.focusEmulated) label = 'focused(emulated)';
    } else if (want.focus === 'unfocused' && o.hasFocus !== false) reasons.push('labelled unfocused but document.hasFocus() is ' + o.hasFocus);
    if (want.visibility && o.visibilityState !== want.visibility) reasons.push('visibilityState is ' + o.visibilityState + ', want ' + want.visibility);
    if (want.hz && o.hzExempt) skipped.push('hz not checked: ' + o.hzExempt);
    else if (want.hz) {
      const hz = o.vsyncMs > 0 ? 1000 / o.vsyncMs : null;
      if (hz == null) reasons.push('no vsync reading (renderPace().vsyncMs is 0)');
      else if (Math.abs(hz - want.hz) / want.hz > VSYNC_TOLERANCE) reasons.push('vsync ' + hz.toFixed(1) + ' Hz is more than ' + (VSYNC_TOLERANCE * 100) + '% off the intended ' + want.hz + ' Hz');
    }
    if (want.camera && o.cameraMode !== want.camera) reasons.push('camera mode is ' + o.cameraMode + ', want ' + want.camera);
    if (want.rested != null && o.cineRested !== want.rested) reasons.push('cinecam rested is ' + o.cineRested + ', want ' + want.rested);
  }
  return { label, valid: reasons.length === 0, reasons: [...new Set(reasons)], skipped: [...new Set(skipped)] };
}

// the pacer's own rule (world.js frame()): a pace under the timer line draws on the first vsync at or past pace - half a vsync.
// The STILL pace (mode 'still', 2026-10-21) waits in a timer that fires 2 ms early and books rAF: the draw lands on the first
// vsync at or past pace - 2 (on 60 Hz 30/s, on 144 Hz 28.8/s, on 239.76 Hz 30.0/s). Pass the WORLD's vsync for a still row:
// the probe's own rAF timestamps are the timer's, ~33 ms apart, and say nothing about the panel.
export function expectedDraws(paceMs, vsyncMs, mode) {
  if (!(paceMs > 0)) return null;
  if (paceMs >= 100 || !(vsyncMs > 0)) return +(1000 / paceMs).toFixed(1);
  const k = mode === 'still' ? Math.max(1, Math.ceil((paceMs - 2) / vsyncMs - 1e-9))
    : Math.max(1, Math.ceil((paceMs - Math.max(1, Math.min(vsyncMs, 17) / 2)) / vsyncMs));
  return +(1000 / (k * vsyncMs)).toFixed(1);
}
// what a window's STILL verdicts were (world.js renderPace counters): the share of its draws judged still, and what kept the
// rest moving — so a phase that never went still (a live belt in frame, a breathing body, a meteor) is labelled, not measured
// at 60 as if it were the tier
export function stillWindow(a, b) {
  const d = (b && b.draws) - (a && a.draws);
  if (!(d > 0) || !b || b.stillFrames == null || !a || a.stillFrames == null) return null;
  const why = {};
  for (const [k, n] of Object.entries(b.stillWhyCounts || {})) { const x = n - ((a.stillWhyCounts || {})[k] || 0); if (x > 0) why[k] = x; }
  return { share: +((b.stillFrames - a.stillFrames) / d).toFixed(3), draws: d, why };
}

/* What a window's pacer did, from two page reads (pageState: draws, the passive rAF probe, the renderPace counters). rafPerDraw is
   the PAGE's rAF callbacks per draw: the crew clock's short rides (crewcards.js, 6-7 a second) count in it. worldRafPerDraw is the
   world's own: every callback frame() takes ends as a draw, a skip (renderPace().skippedFrames) or a UI-first yield (a window opening:
   none in a quiet window, and a yield would only make the figure read low), so (draws + skipped) / draws. The old still pacer booked
   two callbacks per draw (a spin the draw rate hides: P7 read 59 + 27 rAF a second for 30 draws). null: a tree that does not count
   the callbacks it skips, or a window with no draws. */
export function pacerWindow(a, b) {
  if (!a || !b || !a.raf || !b.raf) return null;
  const draws = b.draws - a.draws, rafFired = b.raf.fired - a.raf.fired;
  if (!(draws > 0) || !Number.isFinite(rafFired)) return null;
  const delta = k => { const x = a.pace && a.pace[k], y = b.pace && b.pace[k]; return Number.isFinite(x) && Number.isFinite(y) ? y - x : null; };
  const skippedFrames = delta('skippedFrames');
  return { draws, rafFired, rafPerDraw: +(rafFired / draws).toFixed(2), skippedFrames,
    worldRafPerDraw: skippedFrames == null ? null : +((draws + skippedFrames) / draws).toFixed(2), dueDraws: delta('dueDraws'), dueLate: delta('dueLate') };
}

/* THE IDLE BUDGET (the world-idle-renderer lane: "an idle station costs close to nothing, without lowering the visible frame rate";
   done means the idle main thread is at most 15%). One pure verdict over the quiet-window row (P7), so the run judges itself:
     mainBusyPct   the page's main thread, % of the wall                  <= 15
     rafPerDraw    rAF callbacks per draw: the WORLD's own when the tree counts its skips (the crew clock's rides are another
                   module's and bounded), else the page's                <= 1.25   (the base still pacer spun at ~2)
     drawsPerS     the approved still pace, 30 a second                   28 - 32
     crewSettled   bodies holding still for the rest, at BOTH ends        > 0       (a floor that never settled is not the rest)
     stillShare    the window's draws the frame judge read as still       >= 95%
   Evidence first: an invalid phase, a contended box, or a phase that never said either is 'unjudged', and so is a row with a line
   that was not measured. A busy box's numbers are not evidence either way, so contention outranks a fail. A line that WAS measured
   and is over its budget is a 'fail' whatever else is missing. Pure: the row is not touched. */
export const IDLE_BUDGET = Object.freeze({ mainBusyPct: 15, rafPerDraw: 1.25, drawsPerS: Object.freeze([28, 32]), stillShare: 0.95 });
export function idleBudgetVerdict(row) {
  if (!row || typeof row !== 'object') return { verdict: 'unjudged', checks: [], reasons: ['no row to judge'] };
  const B = IDLE_BUDGET, num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const world = num(row.worldRafPerDraw), page = num(row.rafPerDraw);
  const settled = (Array.isArray(row.obs) ? row.obs : []).map(o => num(o && o.crewSettled));
  const lines = [
    { name: 'mainBusyPct', value: num(row.mainBusyPct), want: '<= ' + B.mainBusyPct + '%', pass: v => v <= B.mainBusyPct },
    { name: 'rafPerDraw', value: world != null ? world : page, note: world != null ? 'world' : page != null ? 'page' : null, want: '<= ' + B.rafPerDraw, pass: v => v <= B.rafPerDraw },
    { name: 'drawsPerS', value: num(row.drawsPerS), want: B.drawsPerS[0] + '-' + B.drawsPerS[1], pass: v => v >= B.drawsPerS[0] && v <= B.drawsPerS[1] },
    { name: 'crewSettled', value: settled.length && settled.every(x => x != null) ? Math.min(...settled) : null, want: '> 0', pass: v => v > 0 },
    { name: 'stillShare', value: num(row.still && row.still.share), want: '>= ' + Math.round(B.stillShare * 100) + '%', pass: v => v >= B.stillShare },
  ];
  const checks = lines.map(l => { const c = { name: l.name, ok: l.value == null ? null : l.pass(l.value), value: l.value, want: l.want }; if (l.note) c.note = l.note; return c; });
  const why = [];
  if (row.valid === false) why.push('the phase is not valid: ' + ((row.invalidWhy || []).join('; ') || 'no reason given'));
  else if (row.valid !== true) why.push('the phase never reported its validity');
  if (row.contended === true) why.push('the box was contended: ' + ((row.contendedWhy || []).join('; ') || 'no reason given'));
  else if (row.contended !== false) why.push('the phase never reported whether the box was contended');
  if (why.length) return { verdict: 'unjudged', checks, reasons: why };
  const failed = checks.filter(c => c.ok === false);
  if (failed.length) return { verdict: 'fail', checks, reasons: failed.map(c => c.name + ' ' + c.value + ' (want ' + c.want + ')') };
  const unread = checks.filter(c => c.ok === null);
  if (unread.length) return { verdict: 'unjudged', checks, reasons: unread.map(c => c.name + ' was not measured') };
  return { verdict: 'pass', checks, reasons: [] };
}
// the one line the bench prints for P7: the verdict, then every reading (with what it wanted when it failed), then why it was unjudged
export function idleBudgetLine(v) {
  const read = (v.checks || []).map(c => c.name + ' ' + (c.value == null ? 'n/a' : c.value) + (c.ok === false ? ' (want ' + c.want + ')' : '')).join(', ');
  return String(v.verdict).toUpperCase() + ' :: ' + read + (v.verdict === 'unjudged' ? ' :: ' + (v.reasons || []).join('; ') : '');
}

export function stats(values) {
  const v = (values || []).filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, median: null, min: null, max: null, mean: null, p95: null };
  const r = x => +x.toFixed(2);
  const median = v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return { n: v.length, median: r(median), min: r(v[0]), max: r(v[v.length - 1]), mean: r(v.reduce((a, b) => a + b, 0) / v.length), p95: r(v[Math.min(v.length - 1, Math.floor(v.length * 0.95))]) };
}

/* The verdict rule (same as the sidecar idle bench): B improved a metric only when EVERY B run beats EVERY A run
   (non-overlapping ranges), n >= 3 on both sides and no run was CONTENDED. Anything else is NO VERDICT. */
export function verdict(a, b, { lowerIsBetter = true, contended = false, minN = 3 } = {}) {
  const A = (a || []).filter(Number.isFinite), B = (b || []).filter(Number.isFinite);
  if (contended) return { verdict: 'NO VERDICT', reason: 'a run was CONTENDED' };
  if (A.length < minN || B.length < minN) return { verdict: 'NO VERDICT', reason: 'n=' + A.length + '/' + B.length + ' (need ' + minN + ' each)' };
  const [aLo, aHi, bLo, bHi] = [Math.min(...A), Math.max(...A), Math.min(...B), Math.max(...B)];
  const better = lowerIsBetter ? bHi < aLo : bLo > aHi, worse = lowerIsBetter ? bLo > aHi : bHi < aLo;
  return better ? { verdict: 'IMPROVED', reason: 'every B run beats every A run' }
    : worse ? { verdict: 'WORSE', reason: 'every B run is worse than every A run' }
    : { verdict: 'NO VERDICT', reason: 'ranges overlap' };
}

// two readings of the same cost (OS sampler vs Chromium's SystemInfo) agree within tol, or both sit under the noise floor
export function crossCheck(a, b, { tol = CROSSCHECK_TOLERANCE, floor = CROSSCHECK_FLOOR_PCT } = {}) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { ok: null, diffPct: null };
  if (Math.max(a, b) < floor) return { ok: true, diffPct: null, note: 'both under ' + floor + '% of a core' };
  const diff = Math.abs(a - b) / Math.max(a, b);
  return { ok: diff <= tol, diffPct: +(100 * diff).toFixed(1) };
}

// per-role and total sums of sampler rows ({ role, cpuPctOneCore, privMB, wsMB, gpuPct, gpuDedMB })
export function summarize(rows) {
  const byRole = {}, total = { n: 0, cpuPctOneCore: 0, privMB: 0, wsMB: 0, gpuPct: 0, gpuDedMB: 0 };
  for (const r of rows || []) {
    const o = byRole[r.role] || (byRole[r.role] = { n: 0, cpuPctOneCore: 0, privMB: 0, wsMB: 0, gpuPct: 0, gpuDedMB: 0 });
    for (const t of [o, total]) {
      t.n++;
      for (const k of ['cpuPctOneCore', 'privMB', 'wsMB', 'gpuPct', 'gpuDedMB']) t[k] = +(t[k] + (Number(r[k]) || 0)).toFixed(2);
    }
  }
  return { byRole, total };
}

/* The hermetic sidecar environment (copied from the sidecar idle bench's hermeticEnv, 2026-10-19). A sidecar that
   sees the real APPDATA / LOCALAPPDATA / USERPROFILE runs boot auto-recovery against Andrew's REAL station (the
   close-zombie trap; perf-station-cost.mjs and seed.mjs still spread process.env). Every profile path lives inside
   the run dir, the env is a whitelist (no provider keys, no NODE_OPTIONS), DEV is on (index.js offers no recovery
   candidates and refuses the canonical roots), live prices are off (no boot fetch = less variance) and any stray
   provider call dies on a closed local port. Pure: returns the env plus the dirs the caller must create. */
export const ENV_WHITELIST = ['SystemRoot', 'windir', 'ComSpec', 'PATH', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERDOMAIN', 'USERNAME'];
export function hermeticEnv({ baseEnv = {}, runDir, ws, port }) {
  const P = d => join(runDir, 'profile', d);
  const home = P('home'), roaming = P('roaming'), local = P('local'), tmp = P('tmp');
  const env = {};
  for (const k of ENV_WHITELIST) if (baseEnv[k] != null) env[k] = baseEnv[k];
  Object.assign(env, {
    USERPROFILE: home, HOME: home, APPDATA: roaming, LOCALAPPDATA: local, XDG_DATA_HOME: local, TEMP: tmp, TMP: tmp,
    HERMES_HOME: join(home, '.hermes'), CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    STARNET_WORKSPACES: ws, SKYNET_WORKSPACES: ws, STARNET_PORT: String(port), SKYNET_PORT: String(port),
    STARNET_DEV: '1', SKYNET_DEV: '1',
    SKYNET_DEFAULT_MODEL: 'anthropic/claude-sonnet-4.6',   // the DEV page lands in-game without a key
    SKYNET_LIVE_PRICES: '0',
    SKYNET_OPENROUTER_BASE: 'http://127.0.0.1:9/',
  });
  return { env, dirs: [home, roaming, local, tmp] };
}
