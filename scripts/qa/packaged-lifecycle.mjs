#!/usr/bin/env node
/* scripts/qa/packaged-lifecycle.mjs — G1: the PACKAGED-LIFECYCLE gate (Windows only).
 *
 * WHY THIS EXISTS: 0.10.5 / 0.10.6 (and earlier) shipped with an unopenable background process on
 * window close. 650+ sidecar/frontend gate steps were green for every one of those cuts — none of
 * them exercise the Tauri shell's REAL close / relaunch branches, which is the seam every recent
 * escape came through. The 08-19 fix was even "live-proved" on the wrong branch (tray branch, while
 * production took the idle branch). This runner drives the INSTALLED exe through the close matrix
 * and reads the branch the shell actually took out of its own startup.log, so a green here names
 * the branch it proved.
 *
 * THE MATRIX (see CASES):
 *   idle-close     default prefs: WM_CLOSE → shell exe GONE, no orphan <install>\node.exe, relaunch
 *                  → visible "StarNet" window + /api/health up. Branch proof: startup.log says
 *                  `close-request: close_to_tray=false` and never `staying resident`.
 *   close-to-tray  lifecycle.json {closeToTray:true} (the shell's own versioned record, written
 *                  while the app is NOT running because it is read once at startup) → launch →
 *                  WM_CLOSE → shell + sidecar STAY, no visible window → second launch
 *                  (single-instance signal) → visible window REVEALED, still exactly one shell pid.
 *                  Branch proof: `staying resident (close-to-tray preference)` in startup.log.
 *   updater-smoke  running exe's file version == expected; the tag's own latest.json is pinned to
 *                  it; the public feed endpoint is reachable (and pinned too when the tag IS the
 *                  published latest). Read-only — no update is installed.
 *   kill-relaunch  launch → HARD-kill the shell alone (TerminateProcess / SIGKILL: no stop code runs)
 *                  → its sidecar must be gone with it, BEFORE any relaunch (Windows: the station's
 *                  kill-on-close job; macOS: the sidecar's own parent watch) → relaunch → exactly ONE
 *                  shell and ONE station sidecar, healthy. The #31 shape: orphans piling up per launch.
 *   cli-app-closed the app has run here and is closed → the INSTALLED `starnet` (bin/starnet.cmd /
 *                  bin/starnet on the bundled node) runs a task → it starts the app in the background
 *                  (startup.log: "started by starnet (--background, terminal pid N)") instead of
 *                  refusing, exactly one station runs while it works, no StarNet window appears, and
 *                  once the terminal is gone the app quits on its own (nothing armed). The run itself
 *                  may fail on a keyless CI install; the case judges the lifecycle, not the answer.
 *
 * PLATFORMS: Windows runs every case. macOS (makeMacDrivers) runs kill-relaunch and cli-app-closed:
 * the window cases need a window list, which a CI mac has no permission to read (no Accessibility).
 *
 * NOT COVERED (honestly): the tray menu "Quit" item (no scriptable handle on a tray menu without
 * UI automation); the armed-work branch (`LifecycleProbe::Armed{armed:true}`), which needs a
 * scheduled job seeded into the fresh install; the window cases on macOS; Linux.
 *
 * HOUSE PATTERN (matches scripts/qa/installed-smoke.mjs): the CORE is pure + dependency-injected
 * (process list, window enumeration, WM_CLOSE, launch, health, clock, fs are all `drivers`), so the
 * classification and every verdict test headlessly with fakes (test/packaged-lifecycle.test.js).
 * The INVOKED_DIRECTLY block is the one place real PowerShell / user32 / fetch live.
 *
 * NO NEW DEPS: node built-ins only (the bundle ships no node_modules; the CI runner has bare node).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/* ─────────────────────────────── PURE CORE ─────────────────────────────── */

export const RECEIPT_SCHEMA = 'starnet.packaged-lifecycle-receipt.v1';
export const SHELL_EXE = 'skynet-desktop.exe';
export const SIDECAR_EXE = 'node.exe';
export const WINDOW_TITLE = 'StarNet';
export const APP_IDENTIFIER = 'ai.skynet.harness';
export const PREFS_FILE = 'lifecycle.json';
export const PREFS_VERSION = 1;
export const STARTUP_LOG = 'startup.log';
export const CASES = Object.freeze(['idle-close', 'close-to-tray', 'updater-smoke', 'kill-relaunch', 'cli-app-closed']);
// what a macOS runner can prove (no window list without Accessibility permission)
export const MAC_CASES = Object.freeze(['kill-relaunch', 'cli-app-closed']);

// Bounded waits (ms). The shell's own close path is ≤2×1.5s probes + drain; everything else is
// first-boot slack on a cold VM.
export const WAITS = Object.freeze({
  windowMs: 120_000,      // first visible window after launch
  healthMs: 120_000,      // sidecar /api/health after launch
  goneMs: 45_000,         // shell + sidecar exit after WM_CLOSE (idle) / after a hard kill / after the CLI left
  cliMs: 180_000,         // the installed `starnet` run, start of the app included
  settleMs: 12_000,       // how long a resident shell must survive after WM_CLOSE (tray)
  revealMs: 30_000,       // window visible again after the single-instance second launch
  pollMs: 500,
});

function norm(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}
function under(file, dir) {
  const f = norm(file), d = norm(dir);
  return !!f && !!d && (f === d || f.startsWith(d + '\\'));
}

/** Classify a raw process list into the ONLY two processes this gate cares about.
 *  - shell: `skynet-desktop.exe` (any path — a second instance from another dir is still ours to
 *    count; the workflow installs into one place).
 *  - sidecar: `node.exe` whose image path is under the install dir — the same full-path rule the
 *    shell's reaper uses, so a dev server / CI node.exe elsewhere is NEVER counted (`foreign`). */
export function classifyProcesses(procs, installDir, names) {
  const out = { shell: [], sidecar: [], foreign: [] };
  const shellNames = (names && names.shell) || [SHELL_EXE];
  const sidecarNames = (names && names.sidecar) || [SIDECAR_EXE];
  for (const p of Array.isArray(procs) ? procs : []) {
    if (!p || typeof p !== 'object') continue;
    const name = String(p.name || '').toLowerCase();
    const rec = { pid: Number(p.pid), path: p.path || null, ppid: p.ppid == null ? null : Number(p.ppid) };
    if (!Number.isFinite(rec.pid)) continue;
    if (shellNames.includes(name)) out.shell.push(rec);
    else if (sidecarNames.includes(name) && rec.path && under(rec.path, installDir)) out.sidecar.push(rec);
    else out.foreign.push(rec);
  }
  return out;
}

/** The station sidecars among the bundled-node processes: the ones a running shell started. (The installed `starnet`
 *  runs on the same bundled node, so "a node.exe under the install dir" alone over-counts while a CLI runs.) */
export function stationSidecars(snap) {
  const shells = new Set(((snap && snap.shell) || []).map((p) => p.pid));
  return ((snap && snap.sidecar) || []).filter((p) => shells.has(p.ppid));
}

/** KILL-RELAUNCH verdict. `afterKill` = snapshot once the shell was hard-killed (before any relaunch); `relaunch` =
 *  snapshot after the relaunch came up. */
export function judgeKillRelaunch({ killedPid, afterKill, relaunch }) {
  const reasons = [];
  if (!afterKill) reasons.push('no post-kill snapshot');
  else {
    if (afterKill.shell.some((p) => p.pid === Number(killedPid))) reasons.push(`the hard-killed shell pid ${killedPid} is still alive`);
    if (afterKill.sidecar.length) reasons.push(`orphan sidecar node after the shell was hard-killed: pids ${afterKill.sidecar.map((p) => p.pid).join(',')} — nothing ended the station with its shell (the job / parent watch)`);
  }
  if (!relaunch) reasons.push('no relaunch snapshot');
  else {
    if (relaunch.shell.length !== 1) reasons.push(`expected exactly 1 shell after relaunch, saw ${relaunch.shell.length}`);
    if (relaunch.sidecar.length !== 1) reasons.push(`expected exactly 1 sidecar after relaunch, saw ${relaunch.sidecar.length} (pids ${relaunch.sidecar.map((p) => p.pid).join(',')})`);
    if (relaunch.health !== true) reasons.push('sidecar /api/health not up after relaunch');
  }
  return { pass: reasons.length === 0, reasons };
}

/** CLI-APP-CLOSED verdict. `cli` = { code, stdout, stderr } of the installed `starnet`; `started` = startup.log said the
 *  CLI started it in the background; `maxShells` / `maxStations` = the most seen at once while the CLI ran; `windowSeen` =
 *  a visible StarNet window appeared (null = unknown on this platform); `after` = snapshot once the CLI had exited. */
export function judgeCliAppClosed({ appRan, cli, started, maxShells, maxStations, windowSeen, after }) {
  const reasons = [];
  if (!appRan) reasons.push('precondition: the app has never run here (no startup.log) — this case proves the app-closed path');
  if (!cli) reasons.push('the installed starnet did not run');
  else {
    const err = String(cli.stderr || '');
    // the refusals (0.14.0's "open the StarNet app first", "run `starnet` to start it", "app was not found"), never the
    // notice of a start ("StarNet isn't running — starting it in the background")
    if (/isn't running — (?!starting it)|open the StarNet app first|app was not found/i.test(err)) reasons.push(`the installed starnet refused with the app closed: ${err.trim().split(/\r?\n/).slice(-1)[0]}`);
    if (cli.code === 3) reasons.push('the installed starnet exited 3 (no station)');
  }
  if (!started) reasons.push('startup.log never said the app was started by starnet (--background) — the CLI did not start it');
  if (maxShells > 1) reasons.push(`${maxShells} StarNet shells ran at once`);
  if (maxStations !== 1) reasons.push(`expected exactly 1 station sidecar while starnet ran, saw at most ${maxStations}`);
  if (windowSeen === true) reasons.push('a visible StarNet window appeared — a terminal launch must stay parked');
  if (!after) reasons.push('no snapshot after starnet exited');
  else if (after.shell.length || after.sidecar.length) reasons.push(`StarNet did not quit once its last terminal session ended: shell ${after.shell.map((p) => p.pid).join(',') || '-'} sidecar ${after.sidecar.map((p) => p.pid).join(',') || '-'}`);
  return { pass: reasons.length === 0, reasons };
}

/** Visible top-level windows titled exactly "StarNet" that belong to one of the shell pids.
 *  Title equality is deliberate: WebView2 spawns no top-level "StarNet" windows of its own. */
export function starnetWindows(windows, shellPids) {
  const pids = new Set((shellPids || []).map(Number));
  return (Array.isArray(windows) ? windows : []).filter((w) =>
    w && w.visible === true && String(w.title || '').trim() === WINDOW_TITLE && pids.has(Number(w.pid)));
}

/** Parse the shell's startup.log from `fromLine` onward. Returns the LAST spawn_sidecar record
 *  after the marker (the port changes every launch) plus the close-request branch lines. */
export function parseStartupLog(text, fromLine = 0) {
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // a trailing newline is not a line: a marker
  const tail = lines.slice(Math.max(0, fromLine | 0));             // taken at EOF must see the NEXT append
  let spawn = null;
  const closeLines = [];
  for (const line of tail) {
    const m = /spawn_sidecar pid=(\d+) port=(\d+) listening=(true|false)/.exec(line);
    if (m) spawn = { pid: Number(m[1]), port: Number(m[2]), listening: m[3] === 'true' };
    if (/close-request:/.test(line)) closeLines.push(line.trim());
  }
  return { port: spawn ? spawn.port : null, listening: spawn ? spawn.listening : null, sidecarPid: spawn ? spawn.pid : null, closeLines, lineCount: lines.length };
}

/** Which close branch did the shell take, per its own log (the 08-19 lesson: name the branch). */
export function closeBranch(closeLines) {
  // Only the LAST close decision counts: every `close_to_tray=` line opens a new decision.
  const all = closeLines || [];
  let start = 0;
  all.forEach((l, i) => { if (/close_to_tray=(true|false)/.test(l)) start = i; });
  const s = all.slice(start).join('\n');
  if (/staying resident \(close-to-tray preference\)/.test(s)) return 'tray-preference';
  if (/staying resident \(armed background work\)/.test(s)) return 'armed';
  if (/staying resident \(armed state ambiguous\)/.test(s)) return 'ambiguous';
  if (/main window is gone/.test(s)) return 'unrevealable-quit';
  if (/close_to_tray=false/.test(s)) return 'idle-quit';
  if (/close_to_tray=true/.test(s)) return 'tray-preference-pending';
  return 'unknown';
}

/** IDLE CLOSE verdict. `after` = snapshot once the bounded wait ended; `relaunch` = snapshot after
 *  the relaunch wait. */
export function judgeIdleClose({ after, relaunch, log }) {
  const reasons = [];
  if (!after) reasons.push('no post-close snapshot');
  else {
    if (after.shell.length) reasons.push(`shell still alive after close: pids ${after.shell.map((p) => p.pid).join(',')}`);
    if (after.sidecar.length) reasons.push(`orphan sidecar node.exe after close: pids ${after.sidecar.map((p) => p.pid).join(',')}`);
  }
  const branch = closeBranch(log && log.closeLines);
  if (branch !== 'idle-quit') reasons.push(`startup.log branch was "${branch}", expected "idle-quit" (close_to_tray=false, no residency line)`);
  if (!relaunch) reasons.push('no relaunch snapshot');
  else {
    if (relaunch.shell.length !== 1) reasons.push(`expected exactly 1 shell after relaunch, saw ${relaunch.shell.length}`);
    if (!relaunch.windows.length) reasons.push('no visible "StarNet" window after relaunch');
    if (relaunch.health !== true) reasons.push('sidecar /api/health not up after relaunch');
  }
  return { pass: reasons.length === 0, reasons, branch };
}

/** CLOSE-TO-TRAY verdict. `resident` = snapshot after the settle wait; `revealed` = snapshot after
 *  the second (single-instance) launch's bounded wait. */
export function judgeTrayClose({ launchedPid, resident, revealed, log }) {
  const reasons = [];
  if (!resident) reasons.push('no resident snapshot');
  else {
    if (resident.shell.length !== 1) reasons.push(`expected the shell to STAY (1 pid), saw ${resident.shell.length}`);
    else if (launchedPid != null && resident.shell[0].pid !== Number(launchedPid)) reasons.push(`resident shell pid ${resident.shell[0].pid} is not the launched pid ${launchedPid}`);
    if (!resident.sidecar.length) reasons.push('sidecar node.exe was killed although the shell stayed resident');
    if (resident.windows.length) reasons.push('a visible "StarNet" window remained after close-to-tray (should be hidden)');
    if (resident.health !== true) reasons.push('sidecar /api/health not up while resident');
  }
  const branch = closeBranch(log && log.closeLines);
  if (branch !== 'tray-preference') reasons.push(`startup.log branch was "${branch}", expected "tray-preference"`);
  if (!revealed) reasons.push('no reveal snapshot');
  else {
    if (revealed.shell.length !== 1) reasons.push(`expected exactly 1 shell after the second launch (single-instance), saw ${revealed.shell.length}`);
    else if (launchedPid != null && revealed.shell[0].pid !== Number(launchedPid)) reasons.push(`the surviving shell pid ${revealed.shell[0].pid} is not the original ${launchedPid} — the resident was replaced, not revealed`);
    if (!revealed.windows.length) reasons.push('second launch did NOT reveal a visible "StarNet" window — windowless resident (the 0.10.x escape)');
  }
  return { pass: reasons.length === 0, reasons, branch };
}

function sameVersion(a, b) {
  const clean = (v) => String(v || '').trim().replace(/^v/i, '').replace(/(\.0)+$/, '');
  return !!a && !!b && clean(a) === clean(b);
}

/** UPDATER SMOKE verdict — all read-only. `tagFeed` = latest.json attached to the tag under test;
 *  `publicFeed` = what the updater endpoint serves right now; `feedMustMatch` = the tag under test
 *  IS the published latest, so the public feed must be pinned to it too. */
export function judgeUpdater({ expectedVersion, exeVersion, tagFeed, publicFeed, feedMustMatch, publicFeedError }) {
  const reasons = [];
  if (!expectedVersion) reasons.push('no expected version (derive from the tag or --expect-version)');
  if (!sameVersion(exeVersion, expectedVersion)) reasons.push(`installed exe reports version "${exeVersion}", expected "${expectedVersion}"`);
  if (!tagFeed || typeof tagFeed !== 'object') reasons.push('latest.json for the tag is missing/unparseable');
  else {
    if (!sameVersion(tagFeed.version, expectedVersion)) reasons.push(`tag latest.json version "${tagFeed.version}" != expected "${expectedVersion}"`);
    const win = tagFeed.platforms && tagFeed.platforms['windows-x86_64'];
    if (!win || !win.url || !win.signature) reasons.push('tag latest.json has no signed windows-x86_64 entry');
  }
  if (publicFeedError) reasons.push(`public updater feed unreachable: ${publicFeedError}`);
  else if (!publicFeed || typeof publicFeed !== 'object') reasons.push('public updater feed returned no JSON');
  else if (feedMustMatch && !sameVersion(publicFeed.version, expectedVersion)) reasons.push(`public feed is pinned to "${publicFeed.version}" but the tag under test is the published latest "${expectedVersion}"`);
  return { pass: reasons.length === 0, reasons };
}

/** The machine-readable receipt (mirrors the T0 evidence style; one doc, per-case verdicts). */
export function buildReceipt({ meta, cases, startedAt, finishedAt }) {
  const list = Array.isArray(cases) ? cases : [];
  const failed = list.filter((c) => c.result !== 'PASS').map((c) => c.name);
  return {
    schema: RECEIPT_SCHEMA,
    generatedAt: new Date(finishedAt || Date.now()).toISOString(),
    verdict: list.length && failed.length === 0 ? 'PASS' : 'FAIL',
    failedCases: failed,
    durationMs: startedAt != null && finishedAt != null ? finishedAt - startedAt : null,
    meta: meta || {},
    cases: list,
    notCovered: [
      'tray menu Quit (no scriptable tray-menu handle without UI automation)',
      'armed-work residency branch (LifecycleProbe::Armed{armed:true}) — needs seeded scheduled work',
      'macOS window cases (idle-close, close-to-tray: no window list without Accessibility); Linux',
    ],
  };
}

export async function pollUntil(fn, { timeoutMs, intervalMs, sleep, now }) {
  const start = now();
  let last;
  for (;;) {
    last = await fn();
    if (last && last.ok) return { ok: true, value: last.value, elapsedMs: now() - start };
    if (now() - start >= timeoutMs) return { ok: false, value: last && last.value, elapsedMs: now() - start };
    await sleep(intervalMs);
  }
}

/* ─────────────────────────── MATRIX ORCHESTRATION ───────────────────────────
 * drivers = {
 *   listProcesses(): [{pid,name,path,ppid}]     listWindows(): [{hwnd,pid,title,visible}]
 *   closeWindow(hwnd): void (WM_CLOSE)           launch(exe): pid
 *   health(port): bool                           readStartupLog(): string
 *   writePrefs(obj): void                        exeVersion(path): string
 *   fetchJson(url): object                       kill(pids): void (cleanup only)
 *   sleep(ms), now()
 * } */

async function snapshot(drivers, installDir, port) {
  const procs = classifyProcesses(await drivers.listProcesses(), installDir, drivers.names);
  const windows = starnetWindows(await drivers.listWindows(), procs.shell.map((p) => p.pid));
  let health = null;
  if (port) { try { health = await drivers.health(port); } catch { health = false; } }
  return { shell: procs.shell, sidecar: procs.sidecar, windows, health, port: port || null };
}

async function waitForBoot(drivers, installDir, logMark, waits) {
  const win = await pollUntil(async () => {
    const s = await snapshot(drivers, installDir, null);
    return { ok: s.windows.length > 0 && s.shell.length > 0, value: s };
  }, { timeoutMs: waits.windowMs, intervalMs: waits.pollMs, sleep: drivers.sleep, now: drivers.now });
  const hp = await pollUntil(async () => {
    const log = parseStartupLog(await drivers.readStartupLog(), logMark);
    if (!log.port) return { ok: false, value: { log } };
    let ok = false;
    try { ok = await drivers.health(log.port) === true; } catch { ok = false; }
    return { ok, value: { log, port: log.port } };
  }, { timeoutMs: waits.healthMs, intervalMs: waits.pollMs, sleep: drivers.sleep, now: drivers.now });
  return { windowOk: win.ok, windowMs: win.elapsedMs, healthOk: hp.ok, healthMs: hp.elapsedMs, port: hp.value && hp.value.port || null, snap: win.value };
}

async function closeMain(drivers, installDir) {
  const s = await snapshot(drivers, installDir, null);
  if (!s.windows.length) throw new Error('cannot WM_CLOSE: no visible "StarNet" window');
  await drivers.closeWindow(s.windows[0].hwnd);
  return s.windows[0];
}

function logMark(text) { return parseStartupLog(text).lineCount; }

// boot = the sidecar this launch spawned answers /api/health (no window needed: the macOS runner cannot see windows)
async function waitForHealth(drivers, installDir, mark, waits) {
  const hp = await pollUntil(async () => {
    const log = parseStartupLog(await drivers.readStartupLog(), mark);
    if (!log.port) return { ok: false, value: { log } };
    let ok = false;
    try { ok = await drivers.health(log.port) === true; } catch { ok = false; }
    return { ok, value: { log, port: log.port } };
  }, { timeoutMs: waits.healthMs, intervalMs: waits.pollMs, sleep: drivers.sleep, now: drivers.now });
  return { healthOk: hp.ok, healthMs: hp.elapsedMs, port: hp.value && hp.value.port || null };
}

/** Precondition: nothing running. Leaves the relaunched app running — the caller cleans up. */
export async function runCaseKillRelaunch(drivers, ctx) {
  const { installDir, exe, waits } = ctx;
  const t0 = drivers.now();
  const mark = logMark(await drivers.readStartupLog());
  await drivers.launch(exe);
  const boot = await waitForHealth(drivers, installDir, mark, waits);
  const up = await snapshot(drivers, installDir, boot.port);
  if (!boot.healthOk || up.shell.length !== 1) {
    return { name: 'kill-relaunch', result: 'FAIL', reasons: [`initial boot: health=${boot.healthOk} shells=${up.shell.length}`], timings: boot };
  }
  const killedPid = up.shell[0].pid;
  const stationBefore = stationSidecars(up).map((p) => p.pid);
  await drivers.hardKill(killedPid);   // the shell ALONE, no tree: none of its stop code runs
  const gone = await pollUntil(async () => {
    const s = await snapshot(drivers, installDir, null);
    return { ok: !s.shell.some((p) => p.pid === killedPid) && s.sidecar.length === 0, value: s };
  }, { timeoutMs: waits.goneMs, intervalMs: waits.pollMs, sleep: drivers.sleep, now: drivers.now });
  const mark2 = logMark(await drivers.readStartupLog());
  const relaunchedPid = await drivers.launch(exe);
  const boot2 = await waitForHealth(drivers, installDir, mark2, waits);
  const relaunch = await snapshot(drivers, installDir, boot2.port);
  const verdict = judgeKillRelaunch({ killedPid, afterKill: gone.value, relaunch });
  return {
    name: 'kill-relaunch', result: verdict.pass ? 'PASS' : 'FAIL', reasons: verdict.reasons,
    killedPid, stationBefore, relaunchedPid,
    timings: { bootMs: boot.healthMs, orphanGoneMs: gone.ok ? gone.elapsedMs : null, relaunchHealthMs: boot2.healthMs, totalMs: drivers.now() - t0 },
    snapshots: { afterKill: gone.value, afterRelaunch: relaunch },
  };
}

/** Precondition: the app is closed and HAS run here (its startup.log exists). Runs the installed `starnet` once. */
export async function runCaseCliAppClosed(drivers, ctx) {
  const { installDir, waits } = ctx;
  const t0 = drivers.now();
  const pre = await snapshot(drivers, installDir, null);
  if (pre.shell.length) return { name: 'cli-app-closed', result: 'FAIL', reasons: [`precondition: StarNet already running (pids ${pre.shell.map((p) => p.pid).join(',')})`] };
  const text = await drivers.readStartupLog();
  const appRan = !!String(text || '').trim();
  const mark = logMark(text);
  const run = drivers.startCli(['-p', 'say hello in five words', '--timeout', '90']);
  let finished = null;
  run.done.then((r) => { finished = r; }, (e) => { finished = { code: null, stdout: '', stderr: String(e && e.message || e) }; });
  let maxShells = 0, maxStations = 0, windowSeen = drivers.canSeeWindows === false ? null : false;
  const deadline = drivers.now() + waits.cliMs;
  while (!finished && drivers.now() < deadline) {
    const s = await snapshot(drivers, installDir, null);
    maxShells = Math.max(maxShells, s.shell.length);
    maxStations = Math.max(maxStations, stationSidecars(s).length);
    if (windowSeen === false && s.windows.length) windowSeen = true;
    await drivers.sleep(waits.pollMs);
  }
  if (!finished) { try { await drivers.stopCli(run); } catch { /* best effort */ } }
  const cli = finished || { code: null, stdout: '', stderr: 'starnet did not finish within ' + waits.cliMs + ' ms' };
  const started = /started by starnet \(--background, terminal pid \d+\)/.test(String(await drivers.readStartupLog()).split(/\r?\n/).slice(mark).join('\n'));
  const after = await pollUntil(async () => {
    const s = await snapshot(drivers, installDir, null);
    return { ok: s.shell.length === 0 && s.sidecar.length === 0, value: s };
  }, { timeoutMs: waits.goneMs, intervalMs: waits.pollMs, sleep: drivers.sleep, now: drivers.now });
  const verdict = judgeCliAppClosed({ appRan, cli, started, maxShells, maxStations, windowSeen, after: after.value });
  return {
    name: 'cli-app-closed', result: verdict.pass ? 'PASS' : 'FAIL', reasons: verdict.reasons,
    observed: { exitCode: cli.code, started, maxShells, maxStations, windowSeen, stderrTail: String(cli.stderr || '').trim().split(/\r?\n/).slice(-4) },
    timings: { quitAfterCliMs: after.ok ? after.elapsedMs : null, totalMs: drivers.now() - t0 },
    snapshots: { afterCli: after.value },
  };
}

export async function runCaseIdleClose(drivers, ctx) {
  const { installDir, exe, waits } = ctx;
  const t0 = drivers.now();
  const mark = logMark(await drivers.readStartupLog());
  const pid = await drivers.launch(exe);
  const boot = await waitForBoot(drivers, installDir, mark, waits);
  if (!boot.windowOk || !boot.healthOk) {
    return { name: 'idle-close', result: 'FAIL', reasons: [`initial boot: window=${boot.windowOk} health=${boot.healthOk}`], timings: boot, launchedPid: pid };
  }
  const closeMark = logMark(await drivers.readStartupLog());
  await closeMain(drivers, installDir);
  const gone = await pollUntil(async () => {
    const s = await snapshot(drivers, installDir, null);
    return { ok: s.shell.length === 0 && s.sidecar.length === 0, value: s };
  }, { timeoutMs: waits.goneMs, intervalMs: waits.pollMs, sleep: drivers.sleep, now: drivers.now });
  const log = parseStartupLog(await drivers.readStartupLog(), closeMark);
  const mark2 = logMark(await drivers.readStartupLog());
  const pid2 = await drivers.launch(exe);
  const boot2 = await waitForBoot(drivers, installDir, mark2, waits);
  const relaunch = await snapshot(drivers, installDir, boot2.port);
  const verdict = judgeIdleClose({ after: gone.value, relaunch, log });
  return {
    name: 'idle-close', result: verdict.pass ? 'PASS' : 'FAIL', reasons: verdict.reasons, branch: verdict.branch,
    launchedPid: pid, relaunchedPid: pid2,
    timings: { bootMs: boot.windowMs, healthMs: boot.healthMs, goneMs: gone.elapsedMs, relaunchWindowMs: boot2.windowMs, relaunchHealthMs: boot2.healthMs, totalMs: drivers.now() - t0 },
    snapshots: { afterClose: gone.value, afterRelaunch: relaunch }, closeLog: log.closeLines,
  };
}

/** Precondition: the app is NOT running (prefs are read once at startup). Leaves the app running
 *  (revealed) — the caller cleans up with drivers.kill. */
export async function runCaseCloseToTray(drivers, ctx) {
  const { installDir, exe, waits } = ctx;
  const t0 = drivers.now();
  const pre = await snapshot(drivers, installDir, null);
  if (pre.shell.length) return { name: 'close-to-tray', result: 'FAIL', reasons: [`precondition: shell already running (pids ${pre.shell.map((p) => p.pid).join(',')}) — prefs are read at startup`] };
  await drivers.writePrefs({ version: PREFS_VERSION, startMinimized: false, closeToTray: true });
  const mark = logMark(await drivers.readStartupLog());
  const pid = await drivers.launch(exe);
  const boot = await waitForBoot(drivers, installDir, mark, waits);
  if (!boot.windowOk || !boot.healthOk) {
    return { name: 'close-to-tray', result: 'FAIL', reasons: [`boot with closeToTray=true: window=${boot.windowOk} health=${boot.healthOk}`], timings: boot, launchedPid: pid };
  }
  const closeMark = logMark(await drivers.readStartupLog());
  await closeMain(drivers, installDir);
  // Wait for the window to hide, then require the shell to SURVIVE the full settle window.
  await pollUntil(async () => {
    const s = await snapshot(drivers, installDir, null);
    return { ok: s.windows.length === 0, value: s };
  }, { timeoutMs: waits.goneMs, intervalMs: waits.pollMs, sleep: drivers.sleep, now: drivers.now });
  await drivers.sleep(waits.settleMs);
  const resident = await snapshot(drivers, installDir, boot.port);
  const log = parseStartupLog(await drivers.readStartupLog(), closeMark);
  // Second launch = single-instance signal → the resident must reveal its window.
  const pid2 = await drivers.launch(exe);
  const reveal = await pollUntil(async () => {
    const s = await snapshot(drivers, installDir, null);
    // exactly one shell (the second process bailed) AND a visible window
    return { ok: s.windows.length > 0 && s.shell.length === 1, value: s };
  }, { timeoutMs: waits.revealMs, intervalMs: waits.pollMs, sleep: drivers.sleep, now: drivers.now });
  const verdict = judgeTrayClose({ launchedPid: pid, resident, revealed: reveal.value, log });
  return {
    name: 'close-to-tray', result: verdict.pass ? 'PASS' : 'FAIL', reasons: verdict.reasons, branch: verdict.branch,
    launchedPid: pid, secondLaunchPid: pid2,
    timings: { bootMs: boot.windowMs, healthMs: boot.healthMs, settleMs: waits.settleMs, revealMs: reveal.elapsedMs, totalMs: drivers.now() - t0 },
    snapshots: { resident, revealed: reveal.value }, closeLog: log.closeLines,
  };
}

export async function runCaseUpdaterSmoke(drivers, ctx) {
  const { exe, expectedVersion, tagFeedUrl, publicFeedUrl, feedMustMatch } = ctx;
  const t0 = drivers.now();
  let exeVersion = null, tagFeed = ctx.tagFeed || null, publicFeed = null, publicFeedError = null, tagFeedError = null;
  try { exeVersion = await drivers.exeVersion(exe); } catch (e) { exeVersion = null; }
  if (!tagFeed && tagFeedUrl) { try { tagFeed = await drivers.fetchJson(tagFeedUrl); } catch (e) { tagFeedError = String(e && e.message || e); } }
  if (publicFeedUrl) { try { publicFeed = await drivers.fetchJson(publicFeedUrl); } catch (e) { publicFeedError = String(e && e.message || e); } }
  const verdict = judgeUpdater({ expectedVersion, exeVersion, tagFeed, publicFeed, feedMustMatch, publicFeedError });
  if (tagFeedError) verdict.reasons.push(`tag latest.json fetch failed: ${tagFeedError}`);
  return {
    name: 'updater-smoke', result: verdict.reasons.length ? 'FAIL' : 'PASS', reasons: verdict.reasons,
    observed: { exeVersion, expectedVersion, tagFeedVersion: tagFeed && tagFeed.version || null, publicFeedVersion: publicFeed && publicFeed.version || null, feedMustMatch: !!feedMustMatch },
    timings: { totalMs: drivers.now() - t0 },
  };
}

export async function runMatrix(drivers, ctx) {
  const waits = Object.assign({}, WAITS, ctx.waits || {});
  const c = Object.assign({}, ctx, { waits });
  const wanted = (ctx.cases && ctx.cases.length ? ctx.cases : CASES).filter((n) => CASES.includes(n));
  const startedAt = drivers.now();
  const results = [];
  const cleanup = async () => {
    const s = classifyProcesses(await drivers.listProcesses(), ctx.installDir, drivers.names);
    const pids = [...s.shell, ...s.sidecar].map((p) => p.pid);
    if (pids.length) await drivers.kill(pids);
  };
  for (const name of wanted) {
    let r;
    try {
      if (name === 'idle-close') { r = await runCaseIdleClose(drivers, c); await cleanupIdle(drivers, c); }
      else if (name === 'close-to-tray') { await cleanup(); r = await runCaseCloseToTray(drivers, c); await cleanup(); }
      else if (name === 'kill-relaunch') { await cleanup(); r = await runCaseKillRelaunch(drivers, c); await cleanup(); }
      else if (name === 'cli-app-closed') { await cleanup(); r = await runCaseCliAppClosed(drivers, c); await cleanup(); }
      else r = await runCaseUpdaterSmoke(drivers, c);
    } catch (e) {
      r = { name, result: 'FAIL', reasons: [`runner error: ${e && e.stack || e}`] };
      try { await cleanup(); } catch { /* best effort */ }
    }
    results.push(r);
    if (ctx.log) ctx.log(`[G1] ${name}: ${r.result}${r.reasons && r.reasons.length ? ' — ' + r.reasons.join(' | ') : ''}`);
  }
  return buildReceipt({ meta: ctx.meta || {}, cases: results, startedAt, finishedAt: drivers.now() });
}

// idle-close leaves a relaunched app running (that IS the assertion). Close it the honest way
// (WM_CLOSE) so the next case starts from nothing; force-kill only if that fails.
async function cleanupIdle(drivers, ctx) {
  const s = await snapshot(drivers, ctx.installDir, null);
  if (s.windows.length) { try { await drivers.closeWindow(s.windows[0].hwnd); } catch { /* fallthrough */ } }
  const gone = await pollUntil(async () => {
    const x = await snapshot(drivers, ctx.installDir, null);
    return { ok: x.shell.length === 0 && x.sidecar.length === 0, value: x };
  }, { timeoutMs: ctx.waits.goneMs, intervalMs: ctx.waits.pollMs, sleep: drivers.sleep, now: drivers.now });
  if (!gone.ok) {
    const pids = [...gone.value.shell, ...gone.value.sidecar].map((p) => p.pid);
    if (pids.length) await drivers.kill(pids);
  }
}

/* ─────────────────────────── WINDOWS DRIVERS (ambient) ─────────────────────────── */

function ps(script) {
  // Write the script to a temp .ps1 and run it with -File: stdin `-Command -` silently drops
  // here-strings (the Add-Type block), and -EncodedCommand has a length ceiling.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-g1-'));
  const file = path.join(dir, 'step.ps1');
  fs.writeFileSync(file, '$ErrorActionPreference = "Stop"\n' + script + '\n', 'utf8');
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(`powershell failed (${r.status}): ${(r.stderr || '').trim().slice(0, 2000)}`);
    return (r.stdout || '').trim();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

const USER32 = `
if (-not ('StarNetG1.Win32' -as [type])) {
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
namespace StarNetG1 {
  public static class Win32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    public static List<string> List() {
      var rows = new List<string>();
      EnumWindows((h, l) => {
        var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
        uint pid; GetWindowThreadProcessId(h, out pid);
        rows.Add(h.ToInt64() + "\\t" + pid + "\\t" + (IsWindowVisible(h) ? 1 : 0) + "\\t" + sb.ToString().Replace("\\t"," ").Replace("\\n"," "));
        return true; }, IntPtr.Zero);
      return rows;
    }
    public static bool Close(long hwnd) { return PostMessage(new IntPtr(hwnd), 0x0010, IntPtr.Zero, IntPtr.Zero); }
  }
}
"@
}`;

export function makeWindowsDrivers({ appDataDir, installDir }) {
  const prefsPath = path.join(appDataDir, PREFS_FILE);
  const logPath = path.join(appDataDir, STARTUP_LOG);
  return {
    installDir,
    listProcesses() {
      const out = ps(`Get-CimInstance Win32_Process -Filter "Name='${SHELL_EXE}' OR Name='${SIDECAR_EXE}'" | ForEach-Object { "$($_.ProcessId)\`t$($_.Name)\`t$($_.ParentProcessId)\`t$($_.ExecutablePath)" }`);
      return out.split(/\r?\n/).filter(Boolean).map((l) => { const [pid, name, ppid, p] = l.split('\t'); return { pid: Number(pid), name, ppid: Number(ppid), path: p || null }; });
    },
    listWindows() {
      const out = ps(`${USER32}\n[StarNetG1.Win32]::List() | ForEach-Object { $_ }`);
      return out.split(/\r?\n/).filter(Boolean).map((l) => { const [hwnd, pid, vis, ...t] = l.split('\t'); return { hwnd: Number(hwnd), pid: Number(pid), visible: vis === '1', title: t.join('\t') }; });
    },
    closeWindow(hwnd) {
      const out = ps(`${USER32}\n[StarNetG1.Win32]::Close(${Number(hwnd)})`);
      if (!/True/i.test(out)) throw new Error(`PostMessage(WM_CLOSE) to hwnd ${hwnd} returned ${out}`);
    },
    launch(exe) {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return child.pid;
    },
    async health(port) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 2000);
      try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctl.signal }); return r.ok; }
      finally { clearTimeout(t); }
    },
    readStartupLog() { try { return fs.readFileSync(logPath, 'utf8'); } catch { return ''; } },
    writePrefs(obj) {
      fs.mkdirSync(appDataDir, { recursive: true });
      fs.writeFileSync(prefsPath, JSON.stringify(obj));
      const back = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      if (back.closeToTray !== obj.closeToTray || back.version !== obj.version) throw new Error('lifecycle.json read-back mismatch');
    },
    exeVersion(exe) { return ps(`(Get-Item '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`); },
    async fetchJson(url) {
      const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'starnet-g1-packaged-lifecycle' } });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return r.json();
    },
    kill(pids) { for (const pid of pids) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); },
    // the shell ALONE (no /T): TerminateProcess, so none of its stop code runs — what End Task / a crash does
    hardKill(pid) { spawnSync('taskkill.exe', ['/PID', String(pid), '/F'], { stdio: 'ignore' }); },
    startCli(args) { return startInstalledCli(installDir, args, 'win32'); },
    stopCli(run) { if (run && run.child && run.child.pid) spawnSync('taskkill.exe', ['/PID', String(run.child.pid), '/T', '/F'], { stdio: 'ignore' }); },
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    now: () => Date.now(),
  };
}


/** Run the INSTALLED `starnet` the way a shell does: bin\starnet.cmd (Windows) / bin/starnet (macOS), which runs
 *  bin/starnet.js on the bundled node, the app found beside it. Returns { child, done: Promise<{code,stdout,stderr}> }. */
function startInstalledCli(installDir, args, platform) {
  const quote = (a) => /[\s"]/.test(a) ? '"' + String(a).replace(/"/g, '\\"') + '"' : String(a);
  const child = platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/s', '/c', '"' + ['"' + path.join(installDir, 'bin', 'starnet.cmd') + '"'].concat(args.map(quote)).join(' ') + '"'], { windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    : spawn(path.join(installDir, '..', 'Resources', 'bin', 'starnet'), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => {
    child.on('error', (e) => resolve({ code: null, stdout, stderr: stderr + String(e && e.message || e) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

/* ─────────────────────────── macOS DRIVERS (ambient, CI) ───────────────────────────
 * The installed app is <bundle>/Contents/MacOS/{skynet-desktop|StarNet} with the bundled node beside it; its data is
 * ~/Library/Application Support/ai.skynet.harness. No window list (a CI mac grants no Accessibility), so only the
 * process-level cases run (MAC_CASES). Not run on the Windows dev box this was written on: CI is its proof. */
export function makeMacDrivers({ appDataDir, installDir, exeName }) {
  const logPath = path.join(appDataDir, STARTUP_LOG);
  const shellName = String(exeName || 'skynet-desktop').toLowerCase();
  return {
    installDir,
    canSeeWindows: false,
    names: { shell: [shellName], sidecar: ['node'] },
    listProcesses() {
      const r = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' });
      return String(r.stdout || '').split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(l)).filter(Boolean)
        .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), path: m[3], name: path.basename(m[3]) }));
    },
    listWindows() { return []; },
    closeWindow() { throw new Error('macOS runner cannot close windows (no Accessibility)'); },
    launch(exe) {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
      child.unref();
      return child.pid;
    },
    async health(port) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 2000);
      try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctl.signal }); return r.ok; }
      finally { clearTimeout(t); }
    },
    readStartupLog() { try { return fs.readFileSync(logPath, 'utf8'); } catch { return ''; } },
    writePrefs() { throw new Error('not used on macOS'); },
    exeVersion() { return ''; },
    async fetchJson(url) { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); },
    kill(pids) { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } },
    hardKill(pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } },
    startCli(args) { return startInstalledCli(installDir, args, 'darwin'); },
    stopCli(run) { try { run.child.kill('SIGKILL'); } catch { /* gone */ } },
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    now: () => Date.now(),
  };
}

/* ─────────────────────────────── CLI ─────────────────────────────── */

export function parseArgs(argv) {
  const o = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) o[m[1]] = m[2] === undefined ? true : m[2];
  }
  return o;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const mac = process.platform === 'darwin';
  if (process.platform !== 'win32' && !mac) { console.error('packaged-lifecycle: Windows or macOS only'); process.exit(2); }
  const exe = a.exe || process.env.STARNET_G1_EXE;
  if (!exe || !fs.existsSync(exe)) { console.error('packaged-lifecycle: --exe=<path to the installed shell executable> is required'); process.exit(2); }
  const installDir = a['install-dir'] || path.dirname(exe);
  const appDataDir = a['app-data'] || (mac ? path.join(os.homedir(), 'Library', 'Application Support', APP_IDENTIFIER) : path.join(process.env.APPDATA || '', APP_IDENTIFIER));
  const tag = a.tag || process.env.STARNET_G1_TAG || '';
  const expectedVersion = a['expect-version'] || (tag ? tag.replace(/^v/i, '') : '');
  const out = a.out || 'packaged-lifecycle-receipt.json';
  const cases = a.cases ? String(a.cases).split(',').map((s) => s.trim()).filter(Boolean) : (mac ? MAC_CASES : CASES).slice();
  if (mac) {
    const unsupported = cases.filter((c) => !MAC_CASES.includes(c));
    if (unsupported.length) { console.error('packaged-lifecycle: macOS runs only ' + MAC_CASES.join(', ') + ' (asked for ' + unsupported.join(', ') + ')'); process.exit(2); }
  }
  const drivers = mac ? makeMacDrivers({ appDataDir, installDir, exeName: path.basename(exe) }) : makeWindowsDrivers({ appDataDir, installDir });
  const receipt = await runMatrix(drivers, {
    exe, installDir, cases, expectedVersion,
    tagFeedUrl: a['tag-feed-url'] || '',
    // the tag's own latest.json, already downloaded next to the installer (drafts are not public)
    tagFeed: a['tag-feed-path'] ? JSON.parse(fs.readFileSync(String(a['tag-feed-path']), 'utf8')) : null,
    publicFeedUrl: a['public-feed-url'] || 'https://github.com/androoAGI/starnet-releases/releases/latest/download/latest.json',
    feedMustMatch: a['feed-must-match'] === true || a['feed-must-match'] === 'true',
    meta: { exe, installDir, appDataDir, tag, runId: process.env.GITHUB_RUN_ID || null, host: process.env.COMPUTERNAME || null, image: process.env.ImageOS ? `${process.env.ImageOS} ${process.env.ImageVersion || ''}`.trim() : null },
    log: (m) => console.log(m),
  });
  fs.writeFileSync(out, JSON.stringify(receipt, null, 2));
  console.log(`[G1] receipt → ${out}\n[G1] VERDICT: ${receipt.verdict}${receipt.failedCases.length ? ' — ' + receipt.failedCases.join(', ') : ''}`);
  process.exit(receipt.verdict === 'PASS' ? 0 : 1);
}

const INVOKED_DIRECTLY = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (INVOKED_DIRECTLY) main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
