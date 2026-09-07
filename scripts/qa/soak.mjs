#!/usr/bin/env node
/* scripts/qa/soak.mjs — the SCRIPTED, HERMETIC, UNATTENDED soak (reliability item 4).
 *
 * WHY THIS EXISTS: until now "soak" meant a human left the packaged app running on the dev desktop for
 * 15–48h and eyeballed it. It blocked the desktop, produced no machine-readable verdict, and its one
 * failure (the first v0.10.0 soak) cost ~15h before anyone could say what broke. This runner boots a
 * hermetic SOURCE sidecar (scratch workspace + scratch app-data profile, free port, MOCK provider — zero
 * provider spend), drives a repeating workload for `--minutes N`, samples the process every tick, and
 * writes a receipt with an explicit PASS/FAIL per rule. A 6-minute smoke and a 12-hour soak are the
 * same harness with a different `--minutes`.
 *
 * WORKLOAD (per tick, see runSoak):
 *   · /api/health latency probe (3 GETs; median + max)     · /api/diagnostics read (swallowed tally, error ring)
 *   · /api/state/snapshot read                             · OS-level RSS sample of the sidecar pid
 *   · every `--run-every` ticks: a real /api/run conversation (deterministic mock answer)
 *   · every `--tool-every` ticks: a real /api/run that the mock steers into shell_exec (a real child process)
 *   · a routine "every 1 minute" armed at start; the cron driver fires it on its own (fires are counted)
 *   · every `--restart-every` minutes: stop → boot on the SAME workspace → every persisted entity must come back
 *
 * VERDICT RULES (evaluate): see RULES below — each rule states its threshold and the reason for it in the
 * receipt. An unobtainable metric is `null` with a reason, never 0.
 *
 * HOUSE PATTERN (matches scripts/qa/packaged-lifecycle.mjs): the CORE (arg parsing, statistics, evaluate,
 * receipt) is pure and tests headlessly (test/soak.test.js); the orchestrator takes injected `drivers`;
 * the INVOKED_DIRECTLY block is the one place the real sidecar, fs, and OS process tools live.
 *
 * NO NEW DEPS: node built-ins only. Reuses test/helpers/sidecar-fixture.js for the hermetic boot contract.
 *
 * NOT A REPLACEMENT for the attended packaged-desktop soak (docs/RELEASE_RUNBOOK.md): this is the source
 * sidecar under a mock provider — it cannot see the Tauri shell, WebView2, the installer, or real provider
 * behavior. It is the mandatory machine verdict that runs BEFORE the human spends desktop hours.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

/* ─────────────────────────────── PURE CORE ─────────────────────────────── */

export const RECEIPT_SCHEMA = 'starnet.soak-receipt.v1';
export const MOCK_MODEL = 'soak/mock';
export const SOAK_AGENT = 'soak_agent';
export const SOAK_STREAM = 'soak-stream';
export const CONVERSATION_REPLY = 'SOAK_REPLY: acknowledged.';
export const TOOL_MARKER = 'SOAK_TOOL';
export const TOOL_STDOUT = 'SOAK_TOOL_OK';

export const ORPHAN_GRACE_MS = 3000;   // a child seen right after its parent died gets this long to finish exiting before it counts as an orphan

export const DEFAULTS = Object.freeze({
  minutes: 20,
  tickSeconds: 15,
  runEvery: 2,          // ticks between conversation runs
  toolEvery: 4,         // ticks between tool runs
  restartEvery: 10,     // minutes between restart cycles (clamped to fit ≥1 cycle in short soaks)
  maxSamples: 600,      // receipt tick samples are downsampled to this many points
  cronTickMs: 10_000,   // the sidecar's scheduler tick while soaking (routine is "every 1 minute")
  routines: 1,          // routines seeded; --routines=50 is the power-user SCALE soak (see buildRoutinePlan)
  maxParallel: 0,       // SKYNET_CRON_MAX_PARALLEL (0 = uncapped); the scale run caps it so at-capacity deferrals occur
  outageSeconds: 0,     // the FIRST restart holds the sidecar down this long: > the 2-min misfire grace proves the catch-up collapse
  slowRunMs: 75_000,    // a SOAK_SLOW routine's mock answer takes this long (> its 1-min period) so already-running skips occur
});

export const SLOW_MARKER = 'SOAK_SLOW';
export const UNFIREABLE_ERROR = 'schedule-unfireable';   // cron-store.UNFIREABLE_ERROR — the driver's mark for a schedule that can never fire

/* THE RULES — thresholds + why. Every number here is printed into the receipt beside the measurement. */
export const RULES = Object.freeze({
  completed: {
    title: 'soak ran to its planned end',
    why: 'an interrupted soak has measured nothing about the tail, which is where leaks and stalls show; INCOMPLETE is a FAIL, never a PASS by absence of evidence',
  },
  runs: {
    title: 'run failures',
    tolerance: 0,
    minRuns: 1,
    why: 'the provider is a deterministic local mock that never errors, so every run error is a harness defect; a soak with zero completed runs measured no workload and fails too',
  },
  routine: {
    title: 'scheduled routine fired',
    minFires: 1,
    why: 'the cron driver is the seam a long-running station depends on most; zero fires across the whole soak means the scheduler never ran',
  },
  swallowed: {
    title: 'swallowed-error pressure (failopen tally)',
    maxRatePerMin: 0.2,
    minCount: 3,
    why: 'with a mock provider the steady-state fail-open count should be ~0; a permanently broken 60s maintenance loop shows as ≥1/min, so a sustained ≥0.2/min over the LAST THIRD (and at least 3 events, so a single blip cannot fail a short soak) is unbounded growth. Tallies reset on restart, so deltas are summed within a boot epoch only',
  },
  rss: {
    title: 'RSS leak trend',
    maxSlopeMBPerMin: 2,
    minGrowthPct: 20,
    minPoints: 5,
    why: 'least-squares slope of RSS over the LAST HALF of the longest boot epoch in that half. 2 MB/min compounds to ~1.4 GB over a 12h soak — a leak by any definition; GC noise on a ~100 MB heap swings tens of MB but not monotonically, so BOTH the slope and ≥20% growth (mean of the last quarter of the window vs the first quarter) are required. Epochs under 5 points are not judged (null, with reason)',
  },
  latency: {
    title: '/api/health p95 latency (event-loop stall proxy)',
    maxP95Ms: 500,
    why: 'loopback health on a healthy loop answers in single-digit ms; a p95 over 500 ms across the LAST HALF means the event loop is stalling (blocked timers, sync I/O, GC thrash) — the class of degradation a human soak catches only as "it feels sluggish"',
  },
  restart: {
    title: 'restart cycles keep every persisted entity',
    why: 'agents, routines, run history, and conversation turns a user expects to survive must round-trip a stop/boot on the same workspace; any id present before and missing after is data loss (the top recurring bug class)',
  },
  process: {
    title: 'sidecar never died and never orphaned a child',
    why: 'an unplanned exit is a crash; a child process STILL alive 3s after the sidecar stopped is the close-zombie class (0.10.5/0.10.6). A child seen at the instant of the stop but gone within the grace is recorded as transient (a measurement, not a failure)',
  },
  accounting: {
    title: 'every due occurrence of every routine is accounted for exactly once',
    why: 'the power-user claim is "30–50 routines a day fire each one". For EVERY seeded routine, every occurrence its schedule owes inside the soak window (enumerated with sidecar/cron.js nextFireAt from the armed nextRunAt — the scheduler\'s own math, never a re-implementation) must end as exactly ONE of: fired (cron.fire with that scheduledFor), skipped already-running (the previous run still held the lease), caught-up (misfire=skip past the grace), collapsed (a missed occurrence folded into the ONE catch-up by the misfire policy — visible only as the store\'s nextRunAt jumping more than one period), disabled (paused routine reported once per due window), or unfireable (a corrupt schedule marked once). At-capacity deferrals are transient (the occurrence stays due and must still reach a terminal). A fire whose scheduledFor is not an owed occurrence, two fires for one occurrence (a double-fire, the restart class), an owed occurrence with no terminal (lost), or a nextRunAt advance the schedule math does not predict is a FAIL. Judged only when the cron event log is readable; a soak in which a fireable routine is owed nothing is inconclusive and FAILS (the window measured no scheduling)',
  },
  tick: {
    title: 'scheduler tick latency with N routines (whole-store verified write per advance)',
    maxP95Ms: 300,
    why: 'the cron tick runs SYNCHRONOUSLY under the process lock: planTick over every job, then saveCronJobs — a full-envelope fsync write + read-back verification of ALL routines — for each advance, and again in markRun for each result. That cost is O(routines) per tick and blocks the event loop while it runs. p95 of (lastSuccessAt − lastTickAt) sampled from GET /api/cron over the LAST HALF must stay under 300 ms at the scale the product claims (50 routines); above that the tick is visibly stalling every run and chat in the station. The first tick after a boot (the post-outage catch-up burst: every missed routine fires at once) is reported as catchUpMs and excluded from p95 — it is a one-time cost, not the steady one. A breach here is a finding against the store write model (index.js saveCronJobs), not a tuning knob',
  },
});

export function parseArgs(argv) {
  const o = {};
  for (const a of argv || []) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) o[m[1]] = m[2] === undefined ? true : m[2];
  }
  const num = (k, d, min) => {
    if (o[k] === undefined || o[k] === true) return d;
    const n = Number(o[k]);
    if (!Number.isFinite(n) || n < min) throw new Error(`--${k} must be a number ≥ ${min}`);
    return n;
  };
  const minutes = num('minutes', DEFAULTS.minutes, 1);
  const tickSeconds = num('tick-seconds', DEFAULTS.tickSeconds, 5);
  // a short soak must still contain ≥1 restart cycle: clamp the interval to half the soak
  const restartEvery = Math.min(num('restart-every', DEFAULTS.restartEvery, 1), Math.max(1, Math.floor(minutes / 2)));
  return {
    minutes,
    tickSeconds,
    runEvery: num('run-every', DEFAULTS.runEvery, 1),
    toolEvery: num('tool-every', DEFAULTS.toolEvery, 1),
    restartEvery,
    maxSamples: num('max-samples', DEFAULTS.maxSamples, 10),
    routines: num('routines', DEFAULTS.routines, 1),
    maxParallel: num('max-parallel', DEFAULTS.maxParallel, 0),
    outageSeconds: num('outage-seconds', DEFAULTS.outageSeconds, 0),
    slowRunMs: num('slow-run-ms', DEFAULTS.slowRunMs, 1000),
    out: typeof o.out === 'string' && o.out ? o.out : null,
    aux: o.aux === true || o.aux === 'true',
    help: o.help === true,
  };
}

export function percentile(values, p) {
  const xs = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[idx];
}

/** Least-squares slope of y over x (x in minutes). null when under two distinct x. */
export function linearSlope(points) {
  const pts = (points || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 2) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) * (p.x - mx); }
  return den === 0 ? null : num / den;
}

/** Even downsample to at most `max` points, always keeping the first and last. */
export function boundSamples(samples, max) {
  const xs = Array.isArray(samples) ? samples : [];
  if (xs.length <= max) return xs.slice();
  const out = [];
  const step = (xs.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(xs[Math.round(i * step)]);
  return out;
}

// Compare complete history at one fixed watermark, not two moving newest-500 windows.
// New routine runs can complete between the pre-stop read and the post-boot read.
// Pagination errors must fail the restart measurement, never become an empty history.
export async function readRunHistory(json, through) {
  const ids = [], seen = new Set(), cursors = new Set();
  let watermark = through, cursor = '';
  do {
    const query = new URLSearchParams({ agent: '*', limit: '500' });
    if (watermark != null) query.set('through', String(watermark));
    if (cursor) query.set('beforeRunId', cursor);
    const response = await json('GET', '/api/runs?' + query);
    const body = response && response.body;
    if (response.status !== 200 || !body || !Array.isArray(body.runs) ||
        !Number.isFinite(body.snapshotAt) || body.snapshotAt <= 0) throw new Error('run history snapshot unreadable');
    if (watermark != null && body.snapshotAt !== watermark) throw new Error('run history watermark changed');
    watermark = body.snapshotAt;
    for (const row of body.runs) {
      if (!row || typeof row.runId !== 'string' || !row.runId || seen.has(row.runId)) throw new Error('invalid or duplicate run history identity');
      seen.add(row.runId); ids.push(row.runId);
    }
    cursor = body.nextCursor || '';
    if (cursor && (!body.runs.length || cursors.has(cursor) || cursor !== body.runs[body.runs.length - 1].runId)) throw new Error('run history cursor did not advance');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return { ids, through: watermark };
}

// The fixture's process-exit handler deletes its scratch roots. Copy both roots while
// the sidecar is stopped, before disposal, so a failed receipt remains investigable.
export function preserveSoakState(fixture, outDir) {
  const root = path.join(path.resolve(outDir), 'forensics');
  if (fs.existsSync(root)) throw new Error('refusing to overwrite soak forensics: ' + root);
  fs.mkdirSync(root, { recursive: true });
  const copies = {};
  for (const name of ['workspace', 'profile']) {
    const source = path.resolve(fixture[name]);
    const destination = path.join(root, name);
    if (destination === source || destination.startsWith(source + path.sep)) throw new Error('forensics destination overlaps fixture');
    fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
    copies[name] = destination;
  }
  return copies;
}

function tail(xs, fraction) { return xs.slice(Math.floor(xs.length * (1 - fraction))); }
function minutesFrom(t0, t) { return (t - t0) / 60_000; }

/* ─────────────────────────────── ROUTINE SCALE: plan + accounting ───────────────────────────────
   buildRoutinePlan(n) — the N routines a scale soak seeds, with deliberately OVERLAPPING schedules:
   1-min and 2-min intervals mixed with cron minute patterns (every `*`/`*\/2`/`*\/3`/`*\/5` minute, odd
   minutes), so many come due in the same minute. Roles: 'disabled' (created enabled, then paused, so its
   nextRunAt ages into the past and the driver must report it), 'unfireable' (the store is corrupted under the
   first restart so the driver must mark it), 'slow' (its mock answer outlives its 1-min period, so the lease
   forces already-running skips), else 'fireable'. n=1 is the classic single heartbeat. */
export function buildRoutinePlan(n) {
  n = Math.max(1, Math.floor(Number(n) || 1));
  if (n === 1) return [{ label: 'r00-heartbeat', schedule: 'every 1 minute', misfire: 'fire_once', role: 'fireable' }];
  const disabledCount = 1, unfireableCount = n >= 4 ? 2 : 0, slowCount = n >= 8 ? 3 : (n >= 5 ? 1 : 0);
  const cadences = ['every 1 minute', '* * * * *', 'every 2 minutes', '*/2 * * * *', 'every 1 minute', '*/3 * * * *', '1-59/2 * * * *', 'every 1 minute', '*/2 * * * *', '*/5 * * * *'];
  const plan = [];
  for (let i = 0; i < n; i++) {
    let role = 'fireable';
    if (i < disabledCount) role = 'disabled';
    else if (i < disabledCount + unfireableCount) role = 'unfireable';
    else if (i < disabledCount + unfireableCount + slowCount) role = 'slow';
    plan.push({ label: `r${String(i).padStart(2, '0')}-${role}`, schedule: role === 'fireable' ? cadences[i % cadences.length] : 'every 1 minute', misfire: i % 2 ? 'skip' : 'fire_once', role });
  }
  return plan;
}

/** Parse the sidecar console for the validated cron telemetry lines (`[cron] <name> <json>`), in order. */
export function parseCronLog(text) {
  const out = [];
  const re = /^\[cron\] (cron\.[a-z_.]+) (\{.*\})\s*$/;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    let payload; try { payload = JSON.parse(m[2]); } catch (e) { continue; }
    out.push({ seq: out.length, name: m[1], payload });
  }
  return out;
}

/** The occurrences a schedule owes from `fromMs` (inclusive) up to `toMs` (exclusive) — the scheduler's own math. */
export function occurrencesBetween(cronLib, schedule, fromMs, toMs, defaultTz) {
  const out = [];
  let t = fromMs;
  for (let guard = 0; guard < 100_000 && t != null && t < toMs; guard++) {
    out.push(t);
    t = cronLib.nextFireAt(schedule, new Date(t).toISOString(), t, { defaultTz: defaultTz || 'UTC' });
  }
  return out;
}

/* accountRoutines({ routines, events, trail, endAt, cronLib, defaultTz }) — the per-routine ledger.
     routines : [{ id, label, role, schedule(obj), misfire, firstNextRunAt(iso) }]
     events   : parseCronLog() output (ordered)
     trail    : [{ at, jobs: { id: { nextRunAt, enabled, lastError } } }] — GET /api/cron snapshots, ordered
     endAt    : ms — the last instant the store was read (occurrences after it are the open tail)
   An occurrence is CONSUMED when the store's nextRunAt moves past it; the occurrence at the old nextRunAt is
   the HEAD (it owes exactly one terminal event), the ones between old and new are COLLAPSED by the misfire
   policy. Fires carry scheduledFor and are matched to heads exactly; skips carry no scheduledFor and fill the
   remaining heads in order. Returns { pass, routines:[...], totals, problems } — never throws. */
export function accountRoutines(input) {
  const cronLib = input.cronLib;
  const tz = input.defaultTz || 'UTC';
  const events = Array.isArray(input.events) ? input.events : [];
  const trail = Array.isArray(input.trail) ? input.trail : [];
  const endAt = Number(input.endAt) || 0;
  const byJob = new Map();
  for (const e of events) { const id = e.payload && e.payload.jobId; if (!id) continue; if (!byJob.has(id)) byJob.set(id, []); byJob.get(id).push(e); }
  const totals = { routines: 0, owed: 0, fired: 0, alreadyRunning: 0, caughtUp: 0, collapsed: 0, deferred: 0, disabled: 0, unfireable: 0, tail: 0, lost: 0, doubled: 0, unexpected: 0, offSchedule: 0 };
  const problems = [];
  const rows = [];
  for (const r of input.routines || []) {
    totals.routines++;
    const ev = byJob.get(r.id) || [];
    const fires = ev.filter((e) => e.name === 'cron.fire');
    const skipsOf = (reason) => ev.filter((e) => e.name === 'cron.skipped' && e.payload.reason === reason);
    const row = { id: r.id, label: r.label, role: r.role, schedule: r.schedule && r.schedule.display || null, owed: 0, fired: 0, alreadyRunning: skipsOf('already-running').length, caughtUp: skipsOf('caught-up').length, collapsed: 0, deferred: skipsOf('at-capacity').length, disabled: skipsOf('disabled').length, unfireable: ev.filter((e) => e.name === 'cron.result' && e.payload.reason === UNFIREABLE_ERROR).length, tail: 0, lost: [], doubled: [], unexpected: [], offSchedule: [], otherSkips: ev.filter((e) => e.name === 'cron.skipped' && ['already-running', 'caught-up', 'at-capacity', 'disabled'].indexOf(e.payload.reason) < 0).map((e) => e.payload.reason), ok: true, note: null };
    // 1. the store's nextRunAt advances → heads + collapsed
    const seq = [];
    let prev = r.firstNextRunAt || null;
    for (const snap of trail) {
      const j = snap.jobs && snap.jobs[r.id];
      if (!j) continue;
      if (j.nextRunAt && j.nextRunAt !== prev) { seq.push({ from: prev, to: j.nextRunAt }); prev = j.nextRunAt; }
    }
    const heads = [];
    for (const adv of seq) {
      const from = Date.parse(adv.from), to = Date.parse(adv.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || !r.schedule) { row.offSchedule.push(`${adv.from}→${adv.to}`); continue; }
      if (to <= from) { row.offSchedule.push(`${adv.from}→${adv.to} (moved backwards)`); continue; }
      const occ = occurrencesBetween(cronLib, r.schedule, from, to, tz);
      const predictedNext = occ.length ? cronLib.nextFireAt(r.schedule, new Date(occ[occ.length - 1]).toISOString(), occ[occ.length - 1], { defaultTz: tz }) : null;
      if (predictedNext !== to) row.offSchedule.push(`${adv.from}→${adv.to} (schedule math predicts ${predictedNext == null ? 'null' : new Date(predictedNext).toISOString()})`);
      heads.push(from);
      row.collapsed += Math.max(0, occ.length - 1);
    }
    row.owed = heads.length + row.collapsed;
    // 2. match fires to heads by scheduledFor; skips fill the rest in order
    const headSet = new Map(heads.map((h) => [h, 0]));
    const pending = prev ? Date.parse(prev) : null;
    for (const f of fires) {
      const sf = Number(f.payload.scheduledFor);
      if (headSet.has(sf)) { headSet.set(sf, headSet.get(sf) + 1); row.fired++; }
      else if (pending != null && sf === pending) { row.tail++; }   // fired after the last store read: the open tail occurrence
      else row.unexpected.push(new Date(sf).toISOString());
    }
    for (const [h, n] of headSet) if (n > 1) row.doubled.push(new Date(h).toISOString());
    const unfiredHeads = [...headSet].filter(([, n]) => n === 0).length;
    const skipTerminals = row.alreadyRunning + row.caughtUp;
    // skips have no scheduledFor: they account for the unfired heads (any surplus is a skip for the open tail)
    if (skipTerminals < unfiredHeads) row.lost = [...headSet].filter(([, n]) => n === 0).slice(0, unfiredHeads - skipTerminals).map(([h]) => new Date(h).toISOString());
    else if (skipTerminals > unfiredHeads) row.tail += skipTerminals - unfiredHeads;
    // 3. role expectations
    if (r.role === 'disabled') {
      if (fires.length) row.note = 'a paused routine fired';
      else if (!row.disabled) row.note = 'paused + due but the driver never reported cron.skipped{disabled}';
      if (heads.length) row.note = (row.note ? row.note + '; ' : '') + 'a paused routine advanced its nextRunAt';
    } else if (r.role === 'unfireable') {
      const markIdx = ev.findIndex((e) => e.name === 'cron.result' && e.payload.reason === UNFIREABLE_ERROR);
      if (markIdx < 0) row.note = 'corrupt schedule was never marked ' + UNFIREABLE_ERROR;
      else if (row.unfireable > 1) row.note = 'marked unfireable more than once';
      else if (ev.slice(markIdx + 1).some((e) => e.name === 'cron.fire')) row.note = 'fired AFTER being marked unfireable';
      const lastSnap = [...trail].reverse().find((s) => s.jobs && s.jobs[r.id]);
      if (lastSnap && lastSnap.jobs[r.id].lastError !== UNFIREABLE_ERROR) row.note = (row.note ? row.note + '; ' : '') + 'store lastError is not ' + UNFIREABLE_ERROR;
    } else {
      if (!heads.length) row.note = 'owed nothing in the window (no nextRunAt advance observed)';
      if (r.role === 'slow' && !row.alreadyRunning) row.note = (row.note ? row.note + '; ' : '') + 'slow routine never produced an already-running skip';
    }
    row.ok = !row.lost.length && !row.doubled.length && !row.unexpected.length && !row.offSchedule.length && !row.note;
    for (const k of ['owed', 'fired', 'alreadyRunning', 'caughtUp', 'collapsed', 'deferred', 'disabled', 'unfireable', 'tail']) totals[k] += row[k];
    totals.lost += row.lost.length; totals.doubled += row.doubled.length; totals.unexpected += row.unexpected.length; totals.offSchedule += row.offSchedule.length;
    if (!row.ok) problems.push(`${row.label}: ${[row.lost.length && `lost ${row.lost.length} (${row.lost[0]})`, row.doubled.length && `double-fired ${row.doubled[0]}`, row.unexpected.length && `unexpected fire ${row.unexpected[0]}`, row.offSchedule.length && `off-schedule advance ${row.offSchedule[0]}`, row.note].filter(Boolean).join('; ')}`);
    rows.push(row);
  }
  return { pass: totals.routines > 0 && problems.length === 0, totals, problems, routines: rows, endAt: endAt ? new Date(endAt).toISOString() : null };
}

/* A tick sample:
   { at, epoch, rssBytes|null, rssReason?, healthMs:{median,max}|null, swallowedTotal|null, swallowedTags:{tag:n}|null,
     errorRing:[ts...]|null, workspaceBytes|null, runs:{ok,failed}, routineFires, tickMs|null } */

export function evaluate(input) {
  const samples = Array.isArray(input.samples) ? input.samples : [];
  const restarts = Array.isArray(input.restarts) ? input.restarts : [];
  const runs = input.runs || { ok: 0, failed: 0, errors: [] };
  const routineFires = Number(input.routineFires) || 0;
  const process = input.process || { unexpectedExits: 0, orphans: [] };
  const t0 = samples.length ? samples[0].at : 0;
  const rules = {};

  // completed
  rules.completed = { pass: input.completed === true, actual: { completed: input.completed === true, reason: input.stopReason || null }, expected: { completed: true }, why: RULES.completed.why };

  // runs
  rules.runs = {
    pass: (runs.failed || 0) <= RULES.runs.tolerance && (runs.ok || 0) >= RULES.runs.minRuns,
    actual: { ok: runs.ok || 0, failed: runs.failed || 0, errors: (runs.errors || []).slice(0, 10) },
    expected: { failed: `<= ${RULES.runs.tolerance}`, ok: `>= ${RULES.runs.minRuns}` }, why: RULES.runs.why,
  };

  // routine
  rules.routine = { pass: routineFires >= RULES.routine.minFires, actual: { fires: routineFires }, expected: { fires: `>= ${RULES.routine.minFires}` }, why: RULES.routine.why };

  // swallowed: sum positive within-epoch deltas over the last third
  {
    const third = tail(samples, 1 / 3).filter((s) => Number.isFinite(s.swallowedTotal));
    if (third.length < 2) {
      rules.swallowed = { pass: true, actual: { ratePerMin: null, count: null, reason: 'fewer than 2 swallowed-tally samples in the last third' }, expected: { ratePerMin: `<= ${RULES.swallowed.maxRatePerMin}`, orCount: `< ${RULES.swallowed.minCount}` }, why: RULES.swallowed.why };
    } else {
      let count = 0;
      for (let i = 1; i < third.length; i++) {
        if (third[i].epoch !== third[i - 1].epoch) continue;
        count += Math.max(0, third[i].swallowedTotal - third[i - 1].swallowedTotal);
      }
      const span = minutesFrom(third[0].at, third[third.length - 1].at);
      const rate = span > 0 ? count / span : (count > 0 ? Infinity : 0);
      const tags = third[third.length - 1].swallowedTags || null;
      rules.swallowed = {
        pass: !(rate > RULES.swallowed.maxRatePerMin && count >= RULES.swallowed.minCount),
        actual: { ratePerMin: Number.isFinite(rate) ? +rate.toFixed(3) : rate, count, windowMinutes: +span.toFixed(2), lastTags: tags, totalAtEnd: third[third.length - 1].swallowedTotal },
        expected: { ratePerMin: `<= ${RULES.swallowed.maxRatePerMin}`, orCount: `< ${RULES.swallowed.minCount}` }, why: RULES.swallowed.why,
      };
    }
  }

  // rss: longest epoch inside the last half
  {
    const half = tail(samples, 1 / 2).filter((s) => Number.isFinite(s.rssBytes));
    const byEpoch = new Map();
    for (const s of half) { if (!byEpoch.has(s.epoch)) byEpoch.set(s.epoch, []); byEpoch.get(s.epoch).push(s); }
    let best = null;
    for (const [epoch, xs] of byEpoch) if (!best || xs.length > best.xs.length) best = { epoch, xs };
    if (!best || best.xs.length < RULES.rss.minPoints) {
      const reason = half.length ? `longest boot epoch in the last half has ${best ? best.xs.length : 0} RSS points (< ${RULES.rss.minPoints})` : (samples.some((s) => s.rssReason) ? samples.find((s) => s.rssReason).rssReason : 'no RSS samples');
      rules.rss = { pass: true, actual: { slopeMBPerMin: null, growthPct: null, reason }, expected: { slopeMBPerMin: `<= ${RULES.rss.maxSlopeMBPerMin}`, orGrowthPct: `< ${RULES.rss.minGrowthPct}` }, why: RULES.rss.why };
    } else {
      const xs = best.xs;
      const slopeB = linearSlope(xs.map((s) => ({ x: minutesFrom(t0, s.at), y: s.rssBytes })));
      const slopeMB = slopeB / (1024 * 1024);
      // growth = mean of the last quarter vs mean of the first quarter (a GC sawtooth's phase cannot fake it)
      const q = Math.max(1, Math.floor(xs.length / 4));
      const mean = (arr) => arr.reduce((s, p) => s + p.rssBytes, 0) / arr.length;
      const headMean = mean(xs.slice(0, q)), tailMean = mean(xs.slice(-q));
      const growthPct = ((tailMean - headMean) / headMean) * 100;
      rules.rss = {
        pass: !(slopeMB > RULES.rss.maxSlopeMBPerMin && growthPct >= RULES.rss.minGrowthPct),
        actual: { slopeMBPerMin: +slopeMB.toFixed(3), growthPct: +growthPct.toFixed(1), epoch: best.epoch, points: xs.length, firstMB: +(xs[0].rssBytes / 1048576).toFixed(1), lastMB: +(xs[xs.length - 1].rssBytes / 1048576).toFixed(1), peakMB: +(Math.max(...samples.filter((s) => Number.isFinite(s.rssBytes)).map((s) => s.rssBytes)) / 1048576).toFixed(1) },
        expected: { slopeMBPerMin: `<= ${RULES.rss.maxSlopeMBPerMin}`, orGrowthPct: `< ${RULES.rss.minGrowthPct}` }, why: RULES.rss.why,
      };
    }
  }

  // latency: p95 of per-tick max over the last half
  {
    const half = tail(samples, 1 / 2).map((s) => s.healthMs && s.healthMs.max).filter((v) => Number.isFinite(v));
    const p95 = percentile(half, 95);
    const all = samples.map((s) => s.healthMs && s.healthMs.median).filter((v) => Number.isFinite(v));
    rules.latency = {
      pass: p95 === null ? true : p95 <= RULES.latency.maxP95Ms,
      actual: { p95Ms: p95, points: half.length, medianOfMediansMs: percentile(all, 50), maxMs: half.length ? Math.max(...half) : null, reason: p95 === null ? 'no health latency samples in the last half' : undefined },
      expected: { p95Ms: `<= ${RULES.latency.maxP95Ms}` }, why: RULES.latency.why,
    };
  }

  // restart
  {
    const cycles = restarts.map((r) => {
      const lost = {};
      for (const k of Object.keys(r.before || {})) {
        const b = new Set(r.before[k] || []), a = new Set((r.after || {})[k] || []);
        const missing = [...b].filter((id) => !a.has(id));
        if (missing.length) lost[k] = missing.slice(0, 20);
      }
      return { at: r.at, epoch: r.epoch, bootMs: r.bootMs ?? null, stopMode: r.stopMode || null, runHistoryThrough: r.runHistoryThrough ?? null, counts: Object.fromEntries(Object.keys(r.before || {}).map((k) => [k, { before: (r.before[k] || []).length, after: ((r.after || {})[k] || []).length }])), lost, ok: Object.keys(lost).length === 0 && r.error == null, error: r.error || null };
    });
    rules.restart = { pass: cycles.length > 0 && cycles.every((c) => c.ok), actual: { cycles: cycles.length, failed: cycles.filter((c) => !c.ok).length, detail: cycles, reason: cycles.length ? undefined : 'no restart cycle completed' }, expected: { cycles: '>= 1', lost: 'none' }, why: RULES.restart.why };
  }

  // process
  rules.process = { pass: (process.unexpectedExits || 0) === 0 && (process.orphans || []).length === 0, actual: { unexpectedExits: process.unexpectedExits || 0, orphans: (process.orphans || []).slice(0, 20), transientChildren: (process.transientChildren || []).slice(0, 20), orphanCheck: process.orphanCheck || null }, expected: { unexpectedExits: 0, orphans: 0 }, why: RULES.process.why };

  // accounting: the per-routine occurrence ledger (computed by runSoak via accountRoutines; null when the cron log was unreadable)
  {
    const acc = input.accounting || null;
    if (!acc || !acc.totals) {
      rules.accounting = { pass: true, actual: { reason: (acc && acc.reason) || 'cron event log not available to this run (no cronEvents driver)', routines: null }, expected: { lost: 0, doubled: 0, unexpected: 0, offSchedule: 0 }, why: RULES.accounting.why };
    } else {
      const t = acc.totals;
      rules.accounting = {
        pass: acc.pass === true,
        actual: { routines: t.routines, owed: t.owed, fired: t.fired, alreadyRunning: t.alreadyRunning, caughtUp: t.caughtUp, collapsed: t.collapsed, deferred: t.deferred, disabled: t.disabled, unfireable: t.unfireable, tail: t.tail, lost: t.lost, doubled: t.doubled, unexpected: t.unexpected, offSchedule: t.offSchedule, problems: (acc.problems || []).slice(0, 20), detail: acc.routines },
        expected: { lost: 0, doubled: 0, unexpected: 0, offSchedule: 0, 'every fireable routine': 'owed >= 1' }, why: RULES.accounting.why,
      };
    }
  }

  // tick: p95 of the STEADY-STATE scheduler tick duration over the last half. The first sample of each boot epoch
  // is the catch-up tick (every routine missed during the outage fires at once — a one-time burst, not the
  // steady cost) and is reported separately as catchUpMs, never folded into p95.
  {
    const seen = new Set(); const catchUp = [];
    const steady = [];
    for (const s of samples) {
      const first = !seen.has(s.epoch); seen.add(s.epoch);
      if (!Number.isFinite(s.tickMs)) continue;
      if (first && s.epoch > 0) catchUp.push(s.tickMs); else steady.push(s);
    }
    const half = tail(steady, 1 / 2).map((s) => s.tickMs);
    const p95 = percentile(half, 95);
    rules.tick = {
      pass: p95 === null ? true : p95 <= RULES.tick.maxP95Ms,
      actual: { p95Ms: p95, maxMs: half.length ? Math.max(...half) : null, medianMs: percentile(half, 50), points: half.length, catchUpMs: catchUp.length ? Math.max(...catchUp) : null, routines: input.options && input.options.routines || null, reason: p95 === null ? 'no scheduler tick samples in the last half (GET /api/cron lastTickAt/lastSuccessAt unavailable)' : undefined },
      expected: { p95Ms: `<= ${RULES.tick.maxP95Ms}` }, why: RULES.tick.why,
    };
  }

  const failed = Object.keys(rules).filter((k) => !rules[k].pass);
  return { verdict: failed.length ? 'FAIL' : 'PASS', failedRules: failed, rules };
}

export function buildReceipt(input) {
  const ev = evaluate(input);
  const samples = Array.isArray(input.samples) ? input.samples : [];
  const ws = samples.map((s) => s.workspaceBytes).filter((v) => Number.isFinite(v));
  const ring = samples.map((s) => s.errorRingSeen).filter((v) => Number.isFinite(v));
  return {
    schema: RECEIPT_SCHEMA,
    verdict: ev.verdict,
    failedRules: ev.failedRules,
    sidecarHead: input.meta && input.meta.sidecarHead || null,
    startedAt: input.startedAt ? new Date(input.startedAt).toISOString() : null,
    endedAt: input.endedAt ? new Date(input.endedAt).toISOString() : null,
    plannedMinutes: input.plannedMinutes ?? null,
    actualMinutes: input.startedAt && input.endedAt ? +((input.endedAt - input.startedAt) / 60_000).toFixed(2) : null,
    options: input.options || null,
    meta: input.meta || {},
    rules: ev.rules,
    measurements: {
      // measurements without a verdict rule — reported, never judged
      workspaceBytes: ws.length ? { first: ws[0], last: ws[ws.length - 1], growth: ws[ws.length - 1] - ws[0] } : { first: null, last: null, growth: null, reason: 'workspace size not sampled' },
      errorRingSeen: ring.length ? ring[ring.length - 1] : null,
      heapBytes: null, heapReason: 'the sidecar exposes no process.memoryUsage endpoint; RSS is sampled at the OS level instead',
      openHandles: null, openHandlesReason: 'open-handle counts need an in-process hook or a native tool; not obtainable from outside the sidecar with built-ins',
      restarts: (input.restarts || []).length,
      ticks: samples.length,
    },
    processSnapshots: (input.processSnapshots || []).slice(-50),
    samples: boundSamples(samples, input.maxSamples || DEFAULTS.maxSamples),
  };
}

export function renderSummary(r) {
  const L = [];
  L.push(`# StarNet soak — ${r.verdict}`);
  L.push('');
  L.push(`- schema: ${r.schema}`);
  L.push(`- sidecar head: ${r.sidecarHead || 'unknown'}`);
  L.push(`- window: ${r.startedAt} → ${r.endedAt} (${r.actualMinutes} of ${r.plannedMinutes} planned minutes)`);
  L.push(`- ticks: ${r.measurements.ticks} · restarts: ${r.measurements.restarts} · stop mode: ${r.meta && r.meta.stopMode || 'unknown'}`);
  L.push('');
  L.push('| rule | verdict | measured | threshold |');
  L.push('|---|---|---|---|');
  for (const [k, v] of Object.entries(r.rules)) {
    const actual = Object.assign({}, v.actual); delete actual.detail; delete actual.lastTags; delete actual.errors;
    L.push(`| ${k} | ${v.pass ? 'PASS' : 'FAIL'} | \`${JSON.stringify(actual)}\` | \`${JSON.stringify(v.expected)}\` |`);
  }
  L.push('');
  const acc = r.rules.accounting && r.rules.accounting.actual;
  if (acc && Array.isArray(acc.detail)) {
    L.push(`## Routine accounting (${acc.routines} routines · owed ${acc.owed} · fired ${acc.fired} · already-running ${acc.alreadyRunning} · caught-up ${acc.caughtUp} · collapsed ${acc.collapsed} · deferred(at-capacity) ${acc.deferred} · disabled ${acc.disabled} · unfireable ${acc.unfireable} · tail ${acc.tail})`);
    L.push('');
    L.push('| routine | schedule | owed | fired | already-running | caught-up | collapsed | deferred | disabled | unfireable | tail | verdict |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const x of acc.detail) L.push(`| ${x.label} | ${x.schedule || '?'} | ${x.owed} | ${x.fired} | ${x.alreadyRunning} | ${x.caughtUp} | ${x.collapsed} | ${x.deferred} | ${x.disabled} | ${x.unfireable} | ${x.tail} | ${x.ok ? 'ok' : 'FAIL — ' + [x.lost.length && 'lost ' + x.lost.length, x.doubled.length && 'doubled ' + x.doubled.length, x.unexpected.length && 'unexpected ' + x.unexpected.length, x.offSchedule.length && 'off-schedule ' + x.offSchedule.length, x.note].filter(Boolean).join(', ')} |`);
    L.push('');
  }
  L.push('## Measurements (no rule)');
  L.push(`- workspace bytes: ${JSON.stringify(r.measurements.workspaceBytes)}`);
  L.push(`- diagnostics error ring entries seen: ${r.measurements.errorRingSeen}`);
  L.push(`- heap: null (${r.measurements.heapReason})`);
  L.push(`- open handles: null (${r.measurements.openHandlesReason})`);
  L.push('');
  L.push('## Why each threshold');
  for (const [k, v] of Object.entries(r.rules)) L.push(`- **${k}** — ${v.why}`);
  L.push('');
  L.push('This is the scripted source-sidecar soak under a mock provider. It does not replace the attended packaged-desktop soak.');
  return L.join('\n') + '\n';
}

/* ─────────────────────────────── ORCHESTRATOR (injected drivers) ─────────────────────────────── */

/* drivers = {
     boot(): Promise<{pid}>        restart(): Promise<{pid, bootMs}>      stop(): Promise<void>
     isAlive(): bool               childrenOf(pid): Promise<{pid,name,cmd}[]|null>
     json(method, route, body): Promise<{status, body}>     runConversation(text): Promise<{reason, events}>
     rss(pid): Promise<number|null>     workspaceBytes(): number|null
     now(): number     sleep(ms): Promise<void>     log(msg)
   } */
export async function runSoak(drivers, opts, hooks) {
  const now = drivers.now, log = drivers.log || (() => {});
  const state = {
    samples: [], restarts: [], processSnapshots: [],
    runs: { ok: 0, failed: 0, errors: [] }, routineFires: 0,
    process: { unexpectedExits: 0, orphans: [], transientChildren: [], orphanCheck: null },
    epoch: 0, completed: false, stopReason: null,
  };
  const seenRoutineRuns = new Set();
  const errorRingSeen = new Set();
  const startedAt = now();
  const endAt = startedAt + opts.minutes * 60_000;
  let lastRestartAt = startedAt;
  const routines = [];          // seeded routine specs: { id, label, role, schedule(obj), misfire, firstNextRunAt }
  const trail = [];             // GET /api/cron store snapshots: { at, jobs: { id: { nextRunAt, enabled, lastError } } }
  let lastStoreReadAt = null;

  const entities = async (runThrough) => {
    const out = { agents: [], routines: [], runs: [], turns: [] };
    try { const d = await drivers.json('GET', '/api/diagnostics'); const n = d.body && d.body.report && d.body.report.agentCount; out.agents = Array.from({ length: Number(n) || 0 }, (_, i) => 'agent#' + i); } catch (e) { out.agents = null; }
    try { const c = await drivers.json('GET', '/api/cron'); out.routines = (c.body && c.body.jobs || []).map((j) => j.id); } catch (e) { out.routines = null; }
    const history = await readRunHistory((m, r) => drivers.json(m, r), runThrough);
    out.runs = history.ids;
    try { const t = await drivers.json('GET', `/api/transcript?agent=${SOAK_AGENT}&stream=${SOAK_STREAM}&limit=500`); out.turns = (t.body && t.body.turns || []).map((x, i) => i + '|' + (x.ts || '') + '|' + (x.role || '')); } catch (e) { out.turns = null; }
    for (const k of Object.keys(out)) if (out[k] === null) delete out[k];   // unreadable before → cannot judge; never a fake empty set
    return { values: out, runThrough: history.through };
  };

  const seed = async () => {
    const roster = await drivers.json('POST', '/api/roster', { updatedAt: now(), agents: [{ agentId: SOAK_AGENT, name: 'SOAK', system: 'You are the soak agent. Answer briefly.', provider: 'openrouter', model: MOCK_MODEL, approvalMode: 'full', executionProfile: 'trusted-project' }] });
    if (!(roster.body && roster.body.ok)) throw new Error('roster seed failed: ' + JSON.stringify(roster.body).slice(0, 300));
    const plan = buildRoutinePlan(opts.routines);
    for (const spec of plan) {
      const prompt = spec.role === 'slow' ? `${SLOW_MARKER} Soak routine ${spec.label}: reply with one line.` : `Soak routine ${spec.label}: reply with one line.`;
      const cron = await drivers.json('POST', '/api/cron', { name: spec.label, prompt, schedule: spec.schedule, agentId: SOAK_AGENT, model: MOCK_MODEL, provider: 'openrouter', deliver: 'local', enabled: true, misfire: spec.misfire });
      if (!(cron.body && cron.body.ok && cron.body.job && !cron.body.duplicate)) throw new Error(`routine ${spec.label} create failed: ` + JSON.stringify(cron.body).slice(0, 300));
      const job = cron.body.job;
      if (spec.role === 'disabled') {
        // pause AFTER creation so the armed nextRunAt stays on the record and ages into the past (a routine created
        // paused has no nextRunAt and can never be "due", so the driver would have nothing to report)
        const paused = await drivers.json('POST', '/api/cron/update', { id: job.id, patch: { enabled: false } });
        if (!(paused.body && paused.body.ok)) throw new Error(`routine ${spec.label} pause failed: ` + JSON.stringify(paused.body).slice(0, 300));
      }
      routines.push({ id: job.id, label: spec.label, role: spec.role, schedule: job.schedule || null, misfire: spec.misfire, firstNextRunAt: job.nextRunAt || null });
    }
    const armed = await drivers.json('POST', '/api/cron/arm', { enabled: true });
    const roles = Object.entries(plan.reduce((m, p) => { m[p.role] = (m[p.role] || 0) + 1; return m; }, {})).map(([k, v]) => `${k}=${v}`).join(' ');
    log(`[soak] seeded agent ${SOAK_AGENT}, ${routines.length} routine(s) [${roles}] (arm → ${armed.status})`);
  };

  // one GET /api/cron read: counts new routine runs (any routine), snapshots the store for the accounting trail,
  // and samples the scheduler tick duration. Called every tick and once more right before every stop.
  const readStore = async (s) => {
    try {
      const c = await drivers.json('GET', '/api/cron');
      const jobs = (c.body && c.body.jobs) || [];
      const snap = { at: now(), jobs: {} };
      for (const job of jobs) {
        if (!job || !job.id) continue;
        snap.jobs[job.id] = { nextRunAt: job.nextRunAt || null, enabled: job.enabled !== false, lastError: job.lastError || null };
        const key = job.id + '|' + job.lastRunId;
        if (job.lastRunId && !seenRoutineRuns.has(key)) { seenRoutineRuns.add(key); state.routineFires++; if (s) { s.routineFires = state.routineFires; s.routineLast = { id: job.id, status: job.lastStatus, reason: job.lastReason }; } }
      }
      trail.push(snap); lastStoreReadAt = snap.at;
      const h = c.body && c.body.health;
      if (s && h && Number.isFinite(h.lastTickAt) && Number.isFinite(h.lastSuccessAt) && h.lastSuccessAt >= h.lastTickAt) s.tickMs = h.lastSuccessAt - h.lastTickAt;
      else if (s) s.tickReason = h ? 'last tick had not completed at read time' : 'GET /api/cron carries no health block';
    } catch (e) { if (s) s.storeReason = 'GET /api/cron failed: ' + (e && e.message); }
  };

  const sample = async (tick) => {
    const s = { at: now(), tick, epoch: state.epoch, rssBytes: null, healthMs: null, swallowedTotal: null, swallowedTags: null, errorRingSeen: null, workspaceBytes: null, runs: { ok: state.runs.ok, failed: state.runs.failed }, routineFires: state.routineFires };
    const lat = [];
    for (let i = 0; i < 3; i++) { const t = now(); try { await drivers.json('GET', '/api/health'); lat.push(now() - t); } catch (e) { lat.push(NaN); } }
    const good = lat.filter(Number.isFinite);
    s.healthMs = good.length ? { median: percentile(good, 50), max: Math.max(...good), failed: 3 - good.length } : null;
    try {
      const d = await drivers.json('GET', '/api/diagnostics');
      const rep = d.body && d.body.report;
      if (rep && rep.swallowed && rep.swallowed.present) {
        s.swallowedTotal = rep.swallowed.total;
        s.swallowedTags = Object.fromEntries((rep.swallowed.tags || []).map((t) => [t.tag, t.count]));
      } else s.swallowedReason = 'diagnostics.swallowed not present';
      for (const e of (rep && rep.errors) || []) errorRingSeen.add(`${e.ts}|${e.message}`);
      s.errorRingSeen = errorRingSeen.size;
    } catch (e) { s.swallowedReason = 'diagnostics unreadable: ' + (e && e.message); }
    try { await drivers.json('GET', '/api/state/snapshot'); } catch (e) { s.snapshotError = String(e && e.message); }
    try { const pid = drivers.pid(); const r = await drivers.rss(pid); if (Number.isFinite(r)) s.rssBytes = r; else s.rssReason = 'OS memory probe returned nothing for pid ' + pid; } catch (e) { s.rssReason = 'OS memory probe failed: ' + (e && e.message); }
    try { const b = drivers.workspaceBytes(); s.workspaceBytes = Number.isFinite(b) ? b : null; } catch (e) { s.workspaceBytes = null; }
    s.tickMs = null;
    await readStore(s);
    state.samples.push(s);
    if (hooks && hooks.onSample) hooks.onSample(s);
    return s;
  };

  const doRun = async (kind) => {
    const text = kind === 'tool' ? `${TOOL_MARKER} run the soak command` : 'Soak conversation: say hello.';
    try {
      const r = await drivers.runConversation(text);
      const toolOk = kind !== 'tool' || r.toolOk === true;
      if (r.reason === 'done' && toolOk) state.runs.ok++;
      else { state.runs.failed++; state.runs.errors.push({ at: now(), kind, reason: r.reason, toolOk, detail: r.detail || null }); }
    } catch (e) { state.runs.failed++; state.runs.errors.push({ at: now(), kind, reason: 'exception', detail: String(e && e.message) }); }
  };

  /* ORPHAN PROBE: children of the stopped sidecar pid. A child still alive the instant its parent is gone is
     normal OS semantics (it is mid-exit on a closed pipe); the zombie class is a child that STAYS. So: enumerate,
     and if anything is there, re-enumerate after ORPHAN_GRACE_MS — survivors are orphans (with name + command
     line so the receipt names the process), the rest are recorded as transient children (a measurement). */
  const orphanProbe = async (pid, final) => {
    const kids = await drivers.childrenOf(pid);
    state.process.orphanCheck = kids === null ? 'child enumeration unavailable on this host' : `enumerated after stop, re-checked after ${ORPHAN_GRACE_MS}ms grace`;
    if (!Array.isArray(kids) || !kids.length) return;
    await drivers.sleep(ORPHAN_GRACE_MS);
    const survivors = await drivers.childrenOf(pid);
    const alive = new Set((survivors || []).map((k) => k.pid));
    for (const k of kids) {
      const row = Object.assign({}, k, { afterStopOf: pid, final: !!final });
      if (alive.has(k.pid)) state.process.orphans.push(row); else state.process.transientChildren.push(row);
    }
  };

  const restartCycle = async () => {
    const rec = { at: now(), epoch: state.epoch, before: null, after: null, bootMs: null, stopMode: drivers.stopMode || null, error: null };
    try {
      const before = await entities();
      rec.before = before.values;
      rec.runHistoryThrough = before.runThrough;
      await readStore(null);
      const pid = drivers.pid();
      await drivers.stop();
      await orphanProbe(pid, false);
      if (state.restarts.length === 0) {
        // FIRST restart only: (a) corrupt the unfireable routines' schedules in the store while the sidecar is down
        // (the only way a can-never-fire schedule reaches the driver — the API validates every schedule it accepts);
        // (b) hold the outage so missed occurrences age past the misfire grace and the catch-up collapse is exercised.
        const corrupt = routines.filter((r) => r.role === 'unfireable').map((r) => r.id);
        if (corrupt.length && typeof drivers.corruptSchedules === 'function') { await drivers.corruptSchedules(corrupt); rec.corrupted = corrupt; log(`[soak] corrupted ${corrupt.length} routine schedule(s) in the store under the outage`); }
        if (opts.outageSeconds > 0) { rec.outageMs = opts.outageSeconds * 1000; log(`[soak] holding the sidecar down for ${opts.outageSeconds}s (misfire grace is 2 min)`); await drivers.sleep(rec.outageMs); }
      }
      const t = now();
      const booted = await drivers.restart();
      rec.bootMs = now() - t;
      state.epoch++;
      state.processSnapshots.push({ at: now(), event: 'restart', epoch: state.epoch, pid: booted.pid, bootMs: rec.bootMs });
      rec.after = (await entities(rec.runHistoryThrough)).values;
    } catch (e) { rec.error = String(e && e.message); }
    state.restarts.push(rec);
    log(`[soak] restart #${state.restarts.length}: boot ${rec.bootMs}ms ${rec.error ? 'ERROR ' + rec.error : ''}`);
  };

  try {
    const booted = await drivers.boot();
    state.processSnapshots.push({ at: now(), event: 'boot', epoch: 0, pid: booted.pid });
    await seed();
    let tick = 0;
    while (now() < endAt) {
      tick++;
      if (!drivers.isAlive()) { state.process.unexpectedExits++; state.stopReason = 'sidecar exited unexpectedly'; log('[soak] sidecar died'); break; }
      if (tick % opts.runEvery === 0) await doRun('conversation');
      if (tick % opts.toolEvery === 0) await doRun('tool');
      const s = await sample(tick);
      log(`[soak] t+${((now() - startedAt) / 60000).toFixed(1)}m tick ${tick} epoch ${state.epoch} rss=${s.rssBytes ? (s.rssBytes / 1048576).toFixed(0) + 'MB' : 'n/a'} health=${s.healthMs ? s.healthMs.median + '/' + s.healthMs.max + 'ms' : 'n/a'} swallowed=${s.swallowedTotal} runs=${state.runs.ok}/${state.runs.failed} fires=${state.routineFires}`);
      if (now() - lastRestartAt >= opts.restartEvery * 60_000 && now() + 30_000 < endAt) { await restartCycle(); lastRestartAt = now(); }
      if (hooks && hooks.shouldStop && hooks.shouldStop()) { state.stopReason = 'interrupted'; break; }
      const next = Math.min(endAt, s.at + opts.tickSeconds * 1000);
      const wait = next - now();
      if (wait > 0) await drivers.sleep(wait);
    }
    if (!state.stopReason) state.completed = true;
  } catch (e) {
    state.stopReason = 'harness error: ' + (e && e.stack || e);
    log(state.stopReason);
  } finally {
    try { if (drivers.isAlive()) await readStore(null); } catch (e) { /* measurement only */ }
    try { const pid = drivers.pid(); await drivers.stop(); await orphanProbe(pid, true); } catch (e) { /* teardown */ }
  }
  const endedAt = now();
  // the per-routine occurrence ledger — needs the cron event log (console `[cron]` lines) and the scheduler's own math
  if (typeof drivers.cronEvents === 'function' && drivers.cronLib) {
    try {
      const events = parseCronLog(await drivers.cronEvents());
      state.accounting = accountRoutines({ routines, events, trail, endAt: lastStoreReadAt, cronLib: drivers.cronLib, defaultTz: 'UTC' });
      state.accounting.events = events.length;
    } catch (e) { state.accounting = { reason: 'accounting failed: ' + (e && e.message) }; }
  } else state.accounting = { reason: 'cron event log not available to this run (no cronEvents/cronLib driver)' };
  state.routines = routines;
  return Object.assign({}, state, { startedAt, endedAt, plannedMinutes: opts.minutes, options: opts, maxSamples: opts.maxSamples });
}

/* ─────────────────────────────── REAL DRIVERS (ambient) ─────────────────────────────── */

/** In-process OpenRouter double: deterministic text; a TOOL_MARKER prompt is steered into one shell_exec. */
export function startMockProvider(mockOpts) {
  const slowRunMs = mockOpts && Number.isFinite(mockOpts.slowRunMs) ? mockOpts.slowRunMs : DEFAULTS.slowRunMs;
  const calls = { total: 0, slow: 0 };
  const server = http.createServer((req, res) => {
    if (req.url.indexOf('/models') >= 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: MOCK_MODEL, context_length: 16000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    }
    if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); return res.end(); }
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      calls.total++;
      let body = {}; try { body = JSON.parse(raw); } catch (e) { /* ignore */ }
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const users = msgs.filter((m) => m && m.role === 'user');
      const last = users.length ? String(users[users.length - 1].content || '') : '';
      // only tool results AFTER the last user turn count: the stream's replayed history carries earlier runs' tool turns
      let lastUserIdx = -1; msgs.forEach((m, i) => { if (m && m.role === 'user') lastUserIdx = i; });
      const toolResults = msgs.slice(lastUserIdx + 1).filter((m) => m && m.role === 'tool');
      const hasShell = (body.tools || []).some((t) => t && t.function && t.function.name === 'shell_exec');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
      const toolCall = (id, name, args) => {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage }) + '\n\n');
      };
      const hasBrief = (body.tools || []).some((t) => t && t.function && t.function.name === 'brief_proceed');
      const wantsTool = last.indexOf(TOOL_MARKER) >= 0;
      // a TASK run walks the real task-brief gate first (brief_proceed), then one real shell_exec, then the final line
      if (wantsTool && toolResults.length === 0 && hasBrief) {
        toolCall('soak_brief_1', 'brief_proceed', { objective: 'run the soak command', deliverable: 'the command output', assumptions: ['use the host shell'] });
      } else if (wantsTool && toolResults.length === (hasBrief ? 1 : 0) && hasShell) {
        toolCall('soak_shell_1', 'shell_exec', { cmd: `node -e "process.stdout.write('${TOOL_STDOUT}')"` });
      } else if (last.indexOf(SLOW_MARKER) >= 0) {
        // a SLOW routine: the answer arrives after slowRunMs (keepalive comments every 5s so the provider idle
        // watchdog sees bytes) — the run outlives the routine's period, so its next occurrence meets the lease
        calls.slow++;
        const ka = setInterval(() => { try { res.write(': keepalive\n\n'); } catch (e) { clearInterval(ka); } }, 5000);
        const fin = setTimeout(() => {
          clearInterval(ka);
          try {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: CONVERSATION_REPLY } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + '\n\n');
            res.write('data: [DONE]\n\n'); res.end();
          } catch (e) { /* client gone */ }
        }, slowRunMs);
        res.on('close', () => { clearInterval(ka); clearTimeout(fin); });
        return;
      } else {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: CONVERSATION_REPLY } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + '\n\n');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, calls, baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/v1',
    close() { try { if (server.closeAllConnections) server.closeAllConnections(); server.close(); } catch (e) { /* teardown */ } },
  })));
}

function rssOf(pid) {
  if (!pid) return null;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      const m = /"([\d.,\s]+)\s*K"\s*$/m.exec(out.trim());
      return m ? Number(m[1].replace(/[^\d]/g, '')) * 1024 : null;
    }
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
    const kb = Number(out.trim());
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
  } catch (e) { return null; }
}

function childrenOf(pid) {
  if (!pid) return null;
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.CommandLine)" }`], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      if (r.status !== 0) return null;
      return (r.stdout || '').split(/\r?\n/).filter(Boolean).map((l) => { const [p, name, ...cmd] = l.split('|'); return { pid: Number(p), name: name || null, cmd: cmd.join('|').slice(0, 300) || null }; }).filter((k) => Number.isFinite(k.pid) && k.pid > 0);
    }
    const r = spawnSync('ps', ['-o', 'pid=,comm=,args=', '--ppid', String(pid)], { encoding: 'utf8' });
    if (r.status !== 0 && !(r.stdout || '').trim()) return [];
    return (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const m = /^(\d+)\s+(\S+)\s*(.*)$/.exec(l); return m ? { pid: Number(m[1]), name: m[2], cmd: (m[3] || '').slice(0, 300) || null } : null; }).filter((k) => k && k.pid > 0);
  } catch (e) { return null; }
}

function dirBytes(dir) {
  let total = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); try { if (e.isDirectory()) walk(p); else total += fs.statSync(p).size; } catch (x) { /* racing writes */ } } };
  try { walk(dir); } catch (e) { return null; }
  return total;
}

function gitHead(cwd) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(); } catch (e) { return null; }
}

export function makeRealDrivers({ fixture, logFile, cronLib }) {
  const flushLog = () => { try { const o = fixture.output(); if (o) { fs.appendFileSync(logFile, o); fixture._output = ''; } } catch (e) { /* best effort */ } };
  return {
    cronLib: cronLib || null,
    // the complete sidecar console so far (flushed log + the live buffer) — the `[cron] <event> <json>` lines are the ledger's input
    async cronEvents() { flushLog(); try { return fs.readFileSync(logFile, 'utf8'); } catch (e) { return ''; } },
    // while the sidecar is DOWN: rewrite the given routines' schedule kind in the store (main + .bak, so the
    // resilient reader cannot recover the good copy) — the only way a can-never-fire schedule reaches the driver
    async corruptSchedules(ids) {
      const file = path.join(fixture.workspace, 'cron.jobs.json');
      const env = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const j of env.jobs || []) if (ids.indexOf(j.id) >= 0 && j.schedule) j.schedule = Object.assign({}, j.schedule, { kind: 'soak-corrupt' });
      const data = JSON.stringify(env);
      fs.writeFileSync(file, data);
      try { if (fs.existsSync(file + '.bak')) fs.writeFileSync(file + '.bak', data); } catch (e) { /* best effort */ }
    },
    stopMode: process.platform === 'win32' ? 'terminate (TerminateProcess, as the desktop shell stops it)' : 'SIGTERM (graceful shutdown path)',
    pid: () => (fixture.child ? fixture.child.pid : null),
    async boot() { await fixture.start(); return { pid: fixture.child.pid }; },
    async restart() { flushLog(); await fixture.start(); return { pid: fixture.child.pid }; },
    async stop() { flushLog(); await fixture.stop(); flushLog(); },
    isAlive() { const c = fixture.child; return !!(c && c.exitCode === null && !c.signalCode); },
    childrenOf: async (pid) => childrenOf(pid),
    json: (m, r, b) => fixture.json(m, r, b),
    async runConversation(text) {
      const response = await fixture.request('/api/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'sk-or-v1-soak-mock', provider: 'openrouter', model: MOCK_MODEL, agentId: SOAK_AGENT, streamId: SOAK_STREAM, isTask: text.indexOf(TOOL_MARKER) >= 0, placed: [], messages: [{ role: 'user', content: text }] }),
      });
      if (response.status !== 200) return { reason: 'http_' + response.status, detail: (await response.text()).slice(0, 200) };
      const reader = response.body.getReader(); const dec = new TextDecoder();
      let buf = '', reason = 'no_end', toolOk = false, detail = null;
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
          if (ev.name === 'agent.run.end') reason = ev.payload && ev.payload.reason;
          if (ev.name === 'agent.tool_result' && ev.payload && ev.payload.callId === 'soak_shell_1') { toolOk = ev.payload.ok === true && ev.payload.isError !== true; if (!toolOk) detail = JSON.stringify(ev.payload).slice(0, 300); }
          if (ev.name === 'agent.error') detail = JSON.stringify(ev.payload).slice(0, 300);
        }
      }
      return { reason, toolOk, detail };
    },
    rss: async (pid) => rssOf(pid),
    workspaceBytes: () => dirBytes(fixture.workspace),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (m) => console.log(m),
  };
}

/* ─────────────────────────────── CLI ─────────────────────────────── */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('node scripts/qa/soak.mjs --minutes=N [--tick-seconds=15] [--run-every=2] [--tool-every=4] [--restart-every=10] [--max-samples=600] [--routines=1] [--max-parallel=0] [--outage-seconds=0] [--slow-run-ms=75000] [--out=dir] [--aux]');
    return process.exit(0);
  }
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = opts.out ? path.resolve(opts.out) : path.join(repo, '.dogfood', 'soak', stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const logFile = path.join(outDir, 'sidecar.log');
  const require = createRequire(import.meta.url);
  const { SidecarFixture } = require(path.join(repo, 'test', 'helpers', 'sidecar-fixture.js'));
  const cronLib = require(path.join(repo, 'sidecar', 'cron.js'));
  const mock = await startMockProvider({ slowRunMs: opts.slowRunMs });
  const env = {
    SKYNET_OPENROUTER_BASE: mock.baseUrl, STARNET_OPENROUTER_BASE: mock.baseUrl,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-soak-mock', STARNET_OPENROUTER_KEY: 'sk-or-v1-soak-mock',
    SKYNET_DEFAULT_MODEL: MOCK_MODEL, STARNET_DEFAULT_MODEL: MOCK_MODEL,
    SKYNET_CRON_ENABLED: '1', STARNET_CRON_ENABLED: '1',
    SKYNET_CRON_TICK_MS: String(DEFAULTS.cronTickMs), STARNET_CRON_TICK_MS: String(DEFAULTS.cronTickMs),
    SKYNET_CRON_TZ: 'UTC', STARNET_CRON_TZ: 'UTC',                     // the accounting enumerates occurrences in UTC
    SKYNET_CONSENT_TIMEOUT_MS: '2000',
  };
  if (opts.maxParallel > 0) { env.SKYNET_CRON_MAX_PARALLEL = String(opts.maxParallel); env.STARNET_CRON_MAX_PARALLEL = String(opts.maxParallel); }
  if (!opts.aux) { env.SKYNET_AUX_BUDGET = '0'; env.STARNET_AUX_BUDGET = '0'; }   // aux passes off by default: deterministic mock answers feed them garbage
  const fixture = SidecarFixture.create({ prefix: 'starnet-soak-', timeoutMs: 20000, env });
  const drivers = makeRealDrivers({ fixture, logFile, cronLib });
  let interrupted = false;
  process.on('SIGINT', () => { interrupted = true; });
  console.log(`[soak] ${opts.minutes} min · tick ${opts.tickSeconds}s · restart every ${opts.restartEvery} min · routines ${opts.routines}${opts.maxParallel ? ' · cron max-parallel ' + opts.maxParallel : ''}${opts.outageSeconds ? ' · first-restart outage ' + opts.outageSeconds + 's' : ''} · out ${outDir}`);
  console.log(`[soak] hermetic: workspace=${fixture.workspace} profile=${fixture.profile} provider=mock@${mock.baseUrl}`);
  const result = await runSoak(drivers, opts, { shouldStop: () => interrupted });
  mock.close();
  const meta = { sidecarHead: gitHead(repo), platform: `${process.platform} ${os.release()} ${os.arch()}`, node: process.version, host: os.hostname(), stopMode: drivers.stopMode, provider: 'mock (in-process OpenRouter double)', mockCalls: mock.calls.total, mockSlowCalls: mock.calls.slow, cronEvents: result.accounting && result.accounting.events || null, workspace: fixture.workspace, auxPasses: opts.aux ? 'default' : 'disabled (SKYNET_AUX_BUDGET=0)' };
  const receipt = buildReceipt(Object.assign({}, result, { meta }));
  try { receipt.meta.forensics = preserveSoakState(fixture, outDir); }
  catch (e) {
    receipt.meta.forensicsError = String(e && e.message || e);
    receipt.verdict = 'FAIL';
    receipt.failedRules.push('forensics');
    receipt.rules.forensics = { pass: false, actual: { error: receipt.meta.forensicsError }, expected: { preserved: true }, why: 'restart failures must retain the scratch state before fixture cleanup' };
  }
  fs.writeFileSync(path.join(outDir, 'soak-receipt.json'), JSON.stringify(receipt, null, 2));
  fs.writeFileSync(path.join(outDir, 'SUMMARY.md'), renderSummary(receipt));
  await fixture.dispose();
  console.log(renderSummary(receipt));
  console.log(`[soak] receipt → ${path.join(outDir, 'soak-receipt.json')}\n[soak] VERDICT: ${receipt.verdict}${receipt.failedRules.length ? ' — ' + receipt.failedRules.join(', ') : ''}`);
  process.exit(receipt.verdict === 'PASS' ? 0 : 1);
}

const INVOKED_DIRECTLY = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (INVOKED_DIRECTLY) main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
