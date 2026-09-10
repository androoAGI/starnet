#!/usr/bin/env node
/* scripts/qa/guardian.mjs — the Self-Testing Station's GREEN GUARDIAN (lane Q1).
 *
 * WHY THIS EXISTS: five-plus sessions merge into trunk in parallel and breakage is
 * currently discovered by Andrew using the app. The Guardian answers ONE question on a
 * schedule: "Is trunk green AND does the app still boot + look right?" It composes the
 * unit, HTTP, adversarial, visual, truth-audit, and multi-step journey detectors against a pinned
 * copy of trunk, files ONE deduped ledger finding per regression (fingerprinted per
 * failing suite/frame/assertion so the same defect never re-nags), refreshes the Green
 * Guardian row in qa/STATUS.md, and exits nonzero if anything is red. Scripts DETECT +
 * ledger; sessions (Overseer) JUDGE + notify — the Guardian never notifies.
 *
 * HOUSE PATTERN (matches scripts/qa/ledger.mjs + the sidecar stores): the CORE is a PURE
 * factory `makeGuardianCore({ io, clock })`. No ambient time, no ambient disk, no child
 * processes in the core — the host injects everything. The core's job is the DECISION
 * logic: turn a gate's raw result (exit code + parsed report) into a list of findings,
 * derive a STABLE per-defect fingerprint, and render the STATUS.md row. That makes the
 * whole judgement testable headlessly (test/qa-guardian.test.js) without ever spawning a
 * real gate. The IO SHELL below (the CLI) owns git, npm, evidence copying and disk — the
 * one place ambient effects live, exactly like ledger.mjs's CLI block.
 *
 * READ-ONLY LAW (Part 5): the Guardian runs gates in its OWN dedicated pinned worktree
 * (a detached `git worktree` reset to trunk head each cycle), NEVER the integration tree
 * and NEVER another agent's worktree. STATUS.md + findings are written into the qa/ dir
 * of the repo the guardian SCRIPT lives in (resolved from import.meta.url) so the
 * dashboard reflects live state and survives the pinned checkout's next reset.
 *
 * PORT LAW (Part 3/5): every sidecar the Guardian boots stays in the Guardian range
 * 8940-8949 (CDP 9340-9349). The shell passes those via the gates' documented env vars.
 *
 * NO-FAKE-GREEN LAW (Part 5): a step that CANNOT run (git/npm/spawn failure, missing
 * report) files a P0 BLOCKED finding loudly and the cycle exits nonzero — it never
 * silently passes.
 *
 * makeGuardianCore({ io, clock }) -> {
 *   fingerprint({ step, subject }) -> stable hex        // per-defect dedup key
 *   findingsFor(step, result)      -> finding[]         // gate result -> ledger findings
 *   statusRow({ cycle })           -> markdown row      // the Green Guardian STATUS row
 *   renderStatus(existingMd, row)  -> markdown          // splice the row into STATUS.md
 *   summarize(steps)               -> { verdict, red, ... }
 * }
 *
 * CLI:
 *   node scripts/qa/guardian.mjs                 # one cycle; exit nonzero if red/blocked
 *   node scripts/qa/guardian.mjs --once          # explicit single cycle (default)
 *   node scripts/qa/guardian.mjs --watch         # poll trunk HEAD; run a cycle when it moves
 *   node scripts/qa/guardian.mjs --watch --interval 120   # poll every N seconds (default 60)
 *   node scripts/qa/guardian.mjs --skip-visual   # fast + HTTP + Saboteur (no Chrome; CI-lite)
 *
 * Exit code: 0 green · 1 red (a gate failed / a step was BLOCKED).
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runBoundedCommand, coerceTimeoutMs, npmGateTimeoutMs } from '../lib/run-command.mjs';
import { fingerprintOf, makeLedger } from './ledger.mjs';
import { runSweep as runEvidenceSweep } from './evidence-sweep.mjs';

/* ─────────────────────────────── PURE CORE ─────────────────────────────── */

const CREW = 'Green Guardian';

// The gates, in dependency order (test first — cheapest, catches the most; visual
// gates last — they boot a sidecar). `visual: true` steps need Chrome + a sidecar and are
// skipped under --skip-visual. `severity` is the DEFAULT for a whole-step failure; a
// finding derived from a parsed sub-result may override it (visual/audit sub-fails are P1).
// The HTTP child has a 20-minute aggregate watchdog; the outer runner needs
// launch/teardown headroom. An explicit operator override still wins for every step.
export function guardianStepTimeoutMs(step, override) {
  return npmGateTimeoutMs(step && step.npm, override);
}

export const GUARDIAN_STEPS = [
  { id: 'test-fast', title: 'Full fast unit/contract gate', npm: 'test:fast', visual: false, severity: 'P0' },
  // HTTP/E2E INTEGRATION gate (gap-audit 2026-07-08): every new subsystem's wired-behavior proof lives in
  // test:http (scout cycle, thread ledger, night-shift act/focus/halt, path trust, workshop, cron) — before this
  // step the Guardian (and therefore qa:ready, which trusts the Guardian stamp) never exercised ANY of it, so
  // READY could not vouch for the newest features. Non-visual (boots its own sidecars on self-retrying ports;
  // no Chrome). P0: an integration break is a product break, same class as test-fast.
  { id: 'http-e2e',  title: 'HTTP/E2E integration gate',    npm: 'test:http', visual: false, severity: 'P0' },
  // SABOTEUR (EL-2): deterministic hostile-input/auth/origin mutations against an isolated real sidecar.
  // Non-visual and cheap enough for every cycle; the seed + attack id in its log make every red replayable.
  { id: 'saboteur', title: 'Adversarial API mutation sweep', npm: 'qa:saboteur', visual: false, severity: 'P1' },
  { id: 'shoot',     title: 'In-game UI screenshot sweep',   npm: 'shoot',     visual: true,  severity: 'P1' },
  { id: 'golden',    title: 'Visual golden-frame diff',       npm: 'golden',    visual: true,  severity: 'P1' },
  { id: 'audit',     title: 'Behavioral truthfulness audit',  npm: 'audit',     visual: true,  severity: 'P1' },
  // JOURNEY CORPS (EL-1): multi-step user journeys with per-step sim↔truth parity — catches the DYNAMIC seam
  // bugs the single-shot audit can't (taskboard truth under real use, interrupt honesty, double-send). Runs
  // after audit (a heavier, longer detector); one finding per failing journey STEP (P1). A journey that CANNOT
  // run (BLOCKED, exit 2) is caught by the same blocked/exit-code path as every other gate (no-fake-green).
  { id: 'journeys', title: 'Multi-step journey parity',        npm: 'qa:journeys', visual: true, severity: 'P1' },
];

function str(v) { return v == null ? '' : String(v); }
function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
function shortSha(sha) { return str(sha).trim().slice(0, 8) || '(unknown)'; }

// CROSS-PROCESS LOCK (pure decision half — the ambient fs/pid side lives in the IO shell).
// The Guardian runs from THREE launch styles that all target the SAME pinned worktree + the SAME
// port range: the hourly Task-Scheduler one-shot, the standing --watch process, and any manual
// run. Before the lock they overlapped and collided — two `git reset --hard`/`worktree` ops raced
// on the shared `.git/worktrees/**/index.lock` (proven: finding 90fe0bcc), and two sidecars fought
// for ports 8940-8943, timing the visual gates out into BLOCKED P0s (findings 9b077d5e/6fc6c002).
// A single machine-global lock serializes them. `isLockStale` decides whether an EXISTING lock
// record may be reclaimed: a record whose heartbeat is older than staleMs belongs to a dead holder
// (a live Guardian refreshes its heartbeat every LOCK_HEARTBEAT_MS). A missing/garbled record is
// treated as stale (reclaimable) — the caller adds an mtime grace so a mid-write record is not
// stolen. Pure + injectable-now so it is unit-tested without touching disk or real time.
export function isLockStale(record, now, staleMs) {
  if (!record || typeof record !== 'object') return true;
  const hb = Number(record.heartbeatAt);
  if (!Number.isFinite(hb)) return true;
  return (num(now) - hb) > num(staleMs);
}

// A stable per-defect fingerprint. Same crew everywhere; the SUBJECT is what makes one
// defect distinct from another (a failing suite name, a changed frame name, a failing
// assertion name). Delegates to the ledger's fingerprintOf so the Guardian and the ledger
// agree on the hash — never re-implement the dedup key.
export function guardianFingerprint(parts) {
  parts = parts || {};
  return fingerprintOf({ crew: CREW, checkId: str(parts.step), subject: str(parts.subject) });
}

// Parse `golden-report.json` -> the flagged frames (structural visual changes). Returns
// [] on any shape we don't recognise (fail-open on parse; the step-level exit code still
// gates, so a missing report can't silently pass — see findingsFor).
export function parseGoldenReport(report) {
  if (!report || !Array.isArray(report.flagged)) return [];
  return report.flagged.map(f => ({
    name: str(f && f.name),
    diff: (f && f.diff != null) ? f.diff : null,
    frame: str(f && f.frame),
    reason: str(f && f.reason)
  })).filter(f => f.name);
}

// Parse `audit-report.json` -> the HARD-failing assertions (soft failures are environment
// signals, never build failures — mirror audit.mjs's own rule).
export function parseAuditReport(report) {
  if (!report || !Array.isArray(report.scenarios)) return [];
  const out = [];
  for (const sc of report.scenarios) {
    const assertions = (sc && Array.isArray(sc.assertions)) ? sc.assertions : [];
    for (const a of assertions) {
      if (a && a.pass === false && a.soft !== true) {
        out.push({ scenario: str(sc.name), name: str(a.name), detail: str(a.detail) });
      }
    }
  }
  return out;
}

// Parse `journeys-report.json` -> the HARD-failing journey assertions (soft failures are environment signals,
// never build failures — mirror audit.mjs's own rule). Shape mirrors the audit report: { journeys: [{ name,
// assertions:[{ name, pass, soft, detail }] }] }. A journey marked blocked:true whose assertions all "pass"
// still surfaces as a step-level BLOCKED via the step exit code (findingsFor's blocked path), so we only need
// to attribute the per-assertion hard fails here.
export function parseJourneysReport(report) {
  if (!report || !Array.isArray(report.journeys)) return [];
  const out = [];
  for (const jr of report.journeys) {
    const assertions = (jr && Array.isArray(jr.assertions)) ? jr.assertions : [];
    for (const a of assertions) {
      if (a && a.pass === false && a.soft !== true) {
        out.push({ journey: str(jr.name), name: str(a.name), detail: str(a.detail) });
      }
    }
  }
  return out;
}

// Parse `manifest.json` from shoot -> the states that FAILED to open (ok:false).
export function parseShootManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.states)) return [];
  return manifest.states
    .filter(s => s && s.ok === false)
    .map(s => ({ name: str(s.name), driveResult: str(s.driveResult) }));
}

export function makeGuardianCore(opts) {
  opts = opts || {};
  const clock = opts.clock || { now() { return 0; } };
  const io = opts.io || {};
  // io (host-owned, all optional; fail-open): readGolden()/readAudit()/readShoot() return
  // the parsed report objects (or null), evidencePath(name) maps an evidence label to a
  // copied artifact path in the cycle bundle.
  const readGolden = typeof io.readGolden === 'function' ? io.readGolden.bind(io) : () => null;
  const readAudit  = typeof io.readAudit  === 'function' ? io.readAudit.bind(io)  : () => null;
  const readShoot  = typeof io.readShoot  === 'function' ? io.readShoot.bind(io)  : () => null;
  const readJourneys = typeof io.readJourneys === 'function' ? io.readJourneys.bind(io) : () => null;
  const evidencePath = typeof io.evidencePath === 'function' ? io.evidencePath.bind(io) : (n) => str(n);

  function fingerprint(parts) { return guardianFingerprint(parts); }

  // Turn ONE gate's result into a list of ledger-ready findings. A result carries:
  //   { exitCode, timedOut, spawnError, blocked, logFile }
  // - blocked/spawnError/timedOut  -> ONE P0 BLOCKED finding (no-fake-green law).
  // - a clean exit (0, or golden's review-exit 3 with no flagged frames) -> [].
  // - a red gate -> one finding PER parsed sub-defect (suite/frame/assertion) so dedup is
  //   per-defect; if the report can't be parsed, ONE step-level finding (still deduped).
  function findingsFor(step, result) {
    step = step || {};
    result = result || {};
    const ts = num(result.ts) || clock.now();
    const sha = shortSha(result.sha);
    const stepId = str(step.id);
    const logEv = result.logFile ? [evidencePath(result.logFile)] : [];

    const mk = (over) => Object.assign({
      crew: CREW, ts, severity: step.severity || 'P1',
      evidence: logEv.slice()
    }, over);

    // BLOCKED: the detector could not run. Loud P0. (spawn error / timeout / explicit block)
    if (result.blocked || result.spawnError || result.timedOut) {
      const why = result.spawnError ? ('spawn error: ' + str(result.spawnError))
        : result.timedOut ? ('timed out after ' + num(result.durationMs) + 'ms')
        : ('blocked: ' + str(result.blockReason || 'step could not run'));
      const subject = stepId + '/blocked';
      return [mk({
        fingerprint: fingerprint({ step: stepId, subject }),
        severity: 'P0',
        title: 'Guardian BLOCKED: ' + str(step.title) + ' could not run',
        detail: 'trunk ' + sha + ' — ' + why + '. A detector that cannot run is a P0 (no-fake-green law): treat as red until it runs clean.',
      })];
    }

    // Golden's exit 3 means "frames flagged for review" — inspect the report; only real
    // flagged frames are findings. A clean pass (exit 0) yields nothing.
    if (stepId === 'golden') {
      if (result.exitCode === 0) return [];
      const flagged = parseGoldenReport(readGolden());
      if (!flagged.length) {
        // nonzero exit but no parseable flagged frames => step-level regression (e.g. no baseline / capture failed).
        const subject = 'golden/step';
        return [mk({
          fingerprint: fingerprint({ step: stepId, subject }),
          severity: 'P0',
          title: 'Golden gate failed to produce a review report',
          detail: 'trunk ' + sha + ' — golden exited ' + result.exitCode + ' but golden-report.json had no flagged frames (missing baseline or capture failure). See log.',
        })];
      }
      return flagged.map(f => mk({
        fingerprint: fingerprint({ step: stepId, subject: 'frame/' + f.name }),
        severity: 'P1',
        title: 'Visual regression: frame `' + f.name + '` changed beyond animation noise',
        detail: 'trunk ' + sha + ' — ' + (f.reason || ('mean-abs-diff ' + f.diff + ' exceeds the golden threshold')) + '. The vision model should read ONLY this frame.',
        evidence: (f.frame ? [evidencePath(f.frame)] : []).concat(logEv),
      }));
    }

    // Any other clean exit => no findings.
    if (result.exitCode === 0) return [];

    // AUDIT red: one finding per hard-failing assertion.
    if (stepId === 'audit') {
      const fails = parseAuditReport(readAudit());
      if (fails.length) {
        return fails.map(a => mk({
          fingerprint: fingerprint({ step: stepId, subject: 'assert/' + a.scenario + '/' + a.name }),
          severity: 'P1',
          title: 'Truth regression: audit assertion `' + a.name + '` failed (' + a.scenario + ')',
          detail: 'trunk ' + sha + ' — ' + (a.detail || 'assertion failed') + '. The UI showed something the harness did not do (app-lies pattern).',
        }));
      }
      // red but unparseable -> step-level (still deduped).
      const subject = 'audit/step';
      return [mk({
        fingerprint: fingerprint({ step: stepId, subject }),
        severity: 'P1',
        title: 'Behavioral audit failed (no parseable assertion report)',
        detail: 'trunk ' + sha + ' — audit exited ' + result.exitCode + ' but audit-report.json had no hard-failing assertions to attribute. See log.',
      })];
    }

    // JOURNEYS red: one finding per hard-failing journey step (P1). Same structure as the audit branch.
    if (stepId === 'journeys') {
      const fails = parseJourneysReport(readJourneys());
      if (fails.length) {
        return fails.map(a => mk({
          fingerprint: fingerprint({ step: stepId, subject: 'journey/' + a.journey + '/' + a.name }),
          severity: 'P1',
          title: 'Journey parity regression: `' + a.name + '` failed (' + a.journey + ')',
          detail: 'trunk ' + sha + ' — ' + (a.detail || 'assertion failed') + '. A multi-step user journey diverged (sim↔UI↔task-truth) — the dynamic-seam bug class.',
        }));
      }
      // red but unparseable -> step-level (still deduped). exit 2 is BLOCKED (already handled above); a bare
      // nonzero with no attributable assertion means the report was lost or the driver failed whole.
      const subject = 'journeys/step';
      return [mk({
        fingerprint: fingerprint({ step: stepId, subject }),
        severity: 'P1',
        title: 'Journey run failed (no parseable journey report)',
        detail: 'trunk ' + sha + ' — qa:journeys exited ' + result.exitCode + ' but journeys-report.json had no hard-failing assertions to attribute. See log.',
      })];
    }

    // SHOOT red: one finding per state that failed to open.
    if (stepId === 'shoot') {
      const fails = parseShootManifest(readShoot());
      if (fails.length) {
        return fails.map(s => mk({
          fingerprint: fingerprint({ step: stepId, subject: 'state/' + s.name }),
          severity: 'P1',
          title: 'UI state `' + s.name + '` failed to open',
          detail: 'trunk ' + sha + ' — screenshot sweep could not reach state `' + s.name + '` (' + (s.driveResult || 'no detail') + ').',
        }));
      }
      // shoot failed to reach the floor at all (exit 2) or another whole-run failure.
      const subject = 'shoot/step';
      return [mk({
        fingerprint: fingerprint({ step: stepId, subject }),
        severity: 'P0',
        title: 'Screenshot sweep failed (app did not reach the floor)',
        detail: 'trunk ' + sha + ' — shoot exited ' + result.exitCode + ' without a per-state failure to attribute (the app likely never booted in-game). See log.',
      })];
    }

    // TEST-FAST red (default): one step-level finding. Suite-level attribution would need a
    // structured test reporter the suite doesn't emit; the log tail carries the failing suite.
    const subject = stepId + '/step';
    return [mk({
      fingerprint: fingerprint({ step: stepId, subject }),
      severity: step.severity || 'P0',
      title: 'Gate red: `' + str(step.npm || stepId) + '` failed (exit ' + result.exitCode + ')',
      detail: 'trunk ' + sha + ' — the ' + str(step.title) + ' failed. See the log tail for the failing suite/assertion.',
    })];
  }

  // Roll up the per-step outcomes into a cycle verdict.
  function summarize(steps) {
    const list = Array.isArray(steps) ? steps : [];
    // `reviewClean` = a red gate whose EVERY derived finding is on the dismissed/known baseline
    // (anti-nag law) — the same review-clean concept the golden gate already applies per-frame,
    // lifted to the whole cycle so a single dismissed flake (e.g. the J2b panel-close busy-poll
    // flake, finding 6feab179) can no longer pin the release gate RED forever. Only exit-code reds
    // are excusable this way; a genuinely BLOCKED step (spawn/timeout/explicit) is never marked
    // reviewClean, so a detector that CANNOT run still reddens (no-fake-green law holds).
    const red = list.filter(s => {
      if (!s) return false;
      // A detector that could not RUN is always red — reviewClean can never excuse a BLOCKED step.
      if (s.blocked || s.spawnError || s.timedOut) return true;
      // Otherwise a red exit-code whose every finding is dismissed/known is review-clean (not red).
      if (s.reviewClean) return false;
      return s.id === 'golden' ? (s.exitCode !== 0 && (s.flaggedCount || 0) > 0) : (s.exitCode !== 0 && s.exitCode != null);
    });
    const blocked = list.filter(s => s && (s.blocked || s.spawnError || s.timedOut));
    return {
      verdict: red.length ? 'red' : 'green',
      red: red.map(s => s.id),
      blocked: blocked.map(s => s.id),
      ran: list.filter(s => s && !s.skipped).map(s => s.id),
      skipped: list.filter(s => s && s.skipped).map(s => s.id),
    };
  }

  // The Green Guardian row for qa/STATUS.md. `cycle` = { ts, sha, verdict, findings, steps, isoTime }.
  function statusRow(cycle) {
    cycle = cycle || {};
    const iso = str(cycle.isoTime) || '—';
    const sha = shortSha(cycle.sha);
    const verdict = str(cycle.verdict) || '—';
    const result = verdict === 'green' ? 'GREEN'
      : verdict === 'red' ? 'RED'
      : verdict.toUpperCase();
    const openFindings = num(cycle.findings);
    const lastRun = iso === '—' ? '—' : (iso + ' @ ' + sha);
    return '| Green Guardian | Is trunk green and does the app still boot + look right? | ' +
      lastRun + ' | ' + result + ' | ' + openFindings + ' |';
  }

  // Splice a fresh Green Guardian row into an existing STATUS.md, preserving every other
  // row byte-for-byte. Matches the leading `| Green Guardian |` cell. Fail-safe: if the row
  // isn't found (someone reformatted the table), the original is returned unchanged and the
  // caller is told (so it can warn rather than silently drop the update).
  function renderStatus(existingMd, row) {
    const md = str(existingMd);
    const lines = md.split('\n');
    let replaced = false;
    const out = lines.map(line => {
      if (!replaced && /^\|\s*Green Guardian\s*\|/.test(line)) { replaced = true; return row; }
      return line;
    });
    return { markdown: out.join('\n'), replaced };
  }

  return {
    fingerprint, findingsFor, summarize, statusRow, renderStatus,
    _steps: GUARDIAN_STEPS,
  };
}

/* ───────────────────────────── IO SHELL / CLI ─────────────────────────────
 * The ONLY place ambient effects live: git, npm/child processes, disk, real clock, and the
 * pinned worktree. Runs only when invoked directly. Mirrors ledger.mjs's composition-root
 * pattern; the static fs/path/url/child_process imports are side-effect-free so a CJS test
 * can require() the pure core without any of this executing.
 */

const INVOKED_DIRECTLY = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch (_) { return false; }
})();

if (INVOKED_DIRECTLY) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const GUARDIAN_REPO = path.resolve(__dirname, '..', '..');       // scripts/qa/ -> the repo the guardian LIVES in
  // STATUS.md + findings live in the guardian's OWN repo (live dashboard, survives the
  // pinned checkout reset). Findings are written via the ledger CLI so dedup/known-refusal
  // is the ONE implementation.
  const QA_DIR = path.join(GUARDIAN_REPO, 'qa');
  const STATUS_FILE = path.join(QA_DIR, 'STATUS.md');
  const LEDGER_CLI = path.join(GUARDIAN_REPO, 'scripts', 'qa', 'ledger.mjs');
  const BUGLOOPS = path.join(GUARDIAN_REPO, '.bugloops');
  // The dedicated pinned checkout: a git worktree the Guardian OWNS, detached, reset to
  // trunk head each cycle. Prefixed `_` so `git worktree list` reads it as guardian infra,
  // not an agent lane. NEVER the integration tree, NEVER another agent's worktree.
  const PIN_DIR = process.env.SKYNET_GUARDIAN_PIN || path.resolve(GUARDIAN_REPO, '..', '_qa-guardian-pin');
  const TRUNK_BRANCH = process.env.SKYNET_GUARDIAN_TRUNK || 'feat/harness-backend';

  // Guardian port range (Part 3/5 port law): 8940-8949 sidecar, 9340-9349 CDP.
  const PORTS = {
    saboteur: { SKYNET_SABOTEUR_PORT: '8944', SKYNET_SABOTEUR_NO_LEDGER: '1' },
    shoot:    { SKYNET_SHOT_PORT:    '8940', SKYNET_CDP_PORT:     '9340' },
    golden:   { SKYNET_GOLDEN_PORT:  '8941', SKYNET_GOLDEN_CDP:   '9341' },
    audit:    { SKYNET_AUDIT_PORT:   '8942', SKYNET_AUDIT_CDP:    '9342' },
    journeys: { SKYNET_JOURNEY_PORT: '8943', SKYNET_JOURNEY_CDP:  '9343' },   // stays in the Guardian range (Part 3/5)
  };

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  const log = (...a) => console.log('[guardian]', ...a);
  const errlog = (...a) => console.error('[guardian]', ...a);

  /* ───────────────────────────── CROSS-PROCESS LOCK ─────────────────────────────
   * ONE machine-global lock so the hourly scheduled task, the standing --watch process, and any
   * manual run SERIALIZE instead of colliding on the shared pin worktree + the 8940-8943 ports.
   * The lock is a single file (default under the OS temp dir so it is the SAME path regardless of
   * which repo/worktree launched the guardian — a gen-tree launch and an integration-tree launch
   * must contend for the SAME lock). It carries the holder's pid + hostname + a heartbeat the live
   * holder refreshes on a timer; a crashed holder's lock goes stale and is reclaimed. Default
   * behavior on a live lock is SKIP (a redundant trigger exits 0 without touching STATUS/findings —
   * the running cycle already covers this or a newer trunk); pass --wait to queue instead. */
  const LOCK_FILE = process.env.SKYNET_GUARDIAN_LOCK || path.join(os.tmpdir(), 'starnet-qa-guardian.lock');
  const LOCK_HEARTBEAT_MS = coerceTimeoutMs(process.env.SKYNET_GUARDIAN_LOCK_HEARTBEAT_MS || 30000, 30000);
  // Stale window: comfortably larger than the heartbeat cadence so a live-but-busy holder (a gate
  // can run up to its step deadline) is never mistaken for dead — its heartbeat timer keeps firing.
  const LOCK_STALE_MS = coerceTimeoutMs(process.env.SKYNET_GUARDIAN_LOCK_STALE_MS || 120000, 120000);

  let __lockRec = null;          // the record THIS process wrote (null until acquired)
  let __heartbeatTimer = null;

  function readLockRecord() { try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch (_) { return null; } }
  function lockFileMtimeMs() { try { return fs.statSync(LOCK_FILE).mtimeMs; } catch (_) { return 0; } }
  // Is a same-host holder pid still alive? signal 0 = existence check; EPERM means it exists but is
  // owned by another user (alive). Cross-host we cannot probe a pid — rely on heartbeat staleness only.
  function holderAlive(rec) {
    if (!rec || rec.host !== os.hostname()) return false;
    const pid = Number(rec.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
  }
  function stopHeartbeat() { if (__heartbeatTimer) { clearInterval(__heartbeatTimer); __heartbeatTimer = null; } }
  function startHeartbeat() {
    stopHeartbeat();
    __heartbeatTimer = setInterval(() => {
      if (!__lockRec) return;
      try {
        const cur = readLockRecord();
        // only refresh if WE still own it (guard against a reclaim having handed it off).
        if (cur && cur.pid === process.pid && cur.host === os.hostname()) {
          __lockRec.heartbeatAt = Date.now();
          fs.writeFileSync(LOCK_FILE, JSON.stringify(__lockRec), 'utf8');
        }
      } catch (_) { /* best-effort; a missed heartbeat just shortens our margin */ }
    }, LOCK_HEARTBEAT_MS);
    if (__heartbeatTimer.unref) __heartbeatTimer.unref();
  }
  function releaseLock() {
    stopHeartbeat();
    if (!__lockRec) return;
    try { const cur = readLockRecord(); if (cur && cur.pid === process.pid && cur.host === os.hostname()) fs.unlinkSync(LOCK_FILE); } catch (_) {}
    __lockRec = null;
  }
  // Try to claim the lock. Returns { ok:true } on success, or { ok:false, held:true, holder } when a
  // live holder owns it (and !wait), or { ok:false, error } on an unexpected fs error. With wait:true
  // it blocks (polling) until the lock frees or goes stale. Reclaims a stale/dead holder's lock.
  async function acquireLock({ wait }) {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    for (let attempt = 0; ; attempt++) {
      try {
        const rec = { pid: process.pid, host: os.hostname(), startedAt: Date.now(), heartbeatAt: Date.now(), cmd: process.argv.slice(2).join(' ') || '(once)' };
        const fd = fs.openSync(LOCK_FILE, 'wx');      // atomic exclusive create — fails EEXIST if held
        try { fs.writeSync(fd, JSON.stringify(rec)); } finally { fs.closeSync(fd); }
        __lockRec = rec;
        startHeartbeat();
        return { ok: true };
      } catch (e) {
        if (e.code !== 'EEXIST') return { ok: false, error: str(e && e.message || e) };
        const rec = readLockRecord();
        const now = Date.now();
        const reclaimable = rec
          ? (isLockStale(rec, now, LOCK_STALE_MS) || (rec.host === os.hostname() && !holderAlive(rec)))
          // a null/garbled record: only reclaim once its mtime is itself stale (grace for a mid-write
          // record so two racers on a fresh lock don't steal each other's just-created file).
          : ((now - lockFileMtimeMs()) > LOCK_STALE_MS);
        if (reclaimable) {
          log('reclaiming stale guardian lock (holder pid=' + (rec && rec.pid) + ' host=' + (rec && rec.host) +
            ' heartbeatAge=' + (rec && rec.heartbeatAt ? (now - rec.heartbeatAt) + 'ms' : 'unknown') + ')');
          try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
          continue;   // retry the exclusive create
        }
        if (!wait) return { ok: false, held: true, holder: rec };
        if (attempt === 0) log('another guardian cycle is running (pid ' + (rec && rec.pid) + ', started ' + (rec && rec.startedAt ? new Date(rec.startedAt).toISOString() : '?') + '); --wait: queuing…');
        await sleep(2000);
      }
    }
  }

  // The dismissed/known fingerprints from the guardian's OWN ledger (qa/findings + KNOWN_ISSUES.md).
  // A red gate whose EVERY derived finding is on this set is review-clean (see summarize's reviewClean).
  // Fail-open to an empty Set so a ledger read problem can never HIDE a real regression.
  function loadSuppressedFingerprints() {
    try {
      const findingsDir = path.join(QA_DIR, 'findings');
      const knownFile = path.join(QA_DIR, 'KNOWN_ISSUES.md');
      const io = {
        listFindings() {
          let names; try { names = fs.readdirSync(findingsDir); } catch (_) { return []; }
          const out = [];
          for (const n of names) { if (!n.endsWith('.json')) continue; try { out.push(JSON.parse(fs.readFileSync(path.join(findingsDir, n), 'utf8'))); } catch (_) {} }
          return out;
        },
        knownFingerprints() {
          try {
            const txt = fs.readFileSync(knownFile, 'utf8'); const set = new Set();
            const re = /fingerprint[:=]\s*`?([0-9a-fA-F]{6,})`?/g; let m;
            while ((m = re.exec(txt))) set.add(m[1].toLowerCase());
            return set;
          } catch (_) { return new Set(); }
        }
      };
      return makeLedger({ io })._internals.suppressedFingerprints();
    } catch (_) { return new Set(); }
  }

  function git(args, cwd) {
    const r = spawnSync('git', args, { cwd: cwd || GUARDIAN_REPO, encoding: 'utf8', windowsHide: true });
    return { code: r.status == null ? 1 : r.status, out: str(r.stdout).trim(), err: str(r.stderr).trim() };
  }
  function trunkHead() {
    // The guardian repo is a worktree of trunk; resolve the trunk branch tip (fetch-free —
    // in this multi-worktree checkout every worktree shares the same object store).
    const r = git(['rev-parse', TRUNK_BRANCH]);
    return r.code === 0 ? r.out : '';
  }

  // First-run: create the pinned worktree (detached at trunk head). Every run refreshes
  // dependencies after reset: the pin keeps ignored node_modules between cycles, and reusing
  // that tree after package-lock changes produces a false-red gate on missing new packages.
  function ensurePinnedCheckout(sha) {
    const exists = fs.existsSync(path.join(PIN_DIR, '.git'));
    if (!exists) {
      log('first run: creating pinned checkout at ' + PIN_DIR + ' (detached @ ' + shortSha(sha) + ')');
      fs.mkdirSync(path.dirname(PIN_DIR), { recursive: true });
      const add = git(['worktree', 'add', '--detach', PIN_DIR, sha]);
      if (add.code !== 0) return { ok: false, reason: 'git worktree add failed: ' + (add.err || add.out) };
    }
    // Reset the pinned checkout to the target trunk head, clean of any prior cycle's spew.
    const reset = git(['reset', '--hard', sha], PIN_DIR);
    if (reset.code !== 0) return { ok: false, reason: 'git reset --hard ' + shortSha(sha) + ' failed: ' + (reset.err || reset.out) };
    git(['clean', '-fd', '.bugloops', '.uishots', '.uishots-x', '.uigolden', '.uiaudit'], PIN_DIR); // best-effort scrub of gate artifacts
    log('refreshing pinned dependencies...');
    const inst = spawnSync(npmCmd, ['install', '--no-audit', '--no-fund'], { cwd: PIN_DIR, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' });
    if ((inst.status == null ? 1 : inst.status) !== 0) return { ok: false, reason: 'npm install in pinned checkout failed: ' + str(inst.stderr).slice(-400) };
    return { ok: true };
  }

  function readJsonMaybe(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  }

  function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
  function copyInto(src, destDir, destName) {
    try {
      if (!fs.existsSync(src)) return '';
      ensureDir(destDir);
      const dest = path.join(destDir, destName);
      fs.copyFileSync(src, dest);
      return dest;
    } catch (_) { return ''; }
  }

  // File a finding through the ledger CLI (the ONE dedup/known path). Returns true if the
  // ledger accepted or deduped it (both are "handled"); false only on a hard CLI error.
  function fileFinding(finding) {
    const r = spawnSync(process.execPath, [LEDGER_CLI, '--add', '--json', JSON.stringify(finding)], {
      cwd: GUARDIAN_REPO, encoding: 'utf8', windowsHide: true
    });
    const out = str(r.stdout).trim();
    const err = str(r.stderr).trim();
    if (out) log('ledger:', out);
    if (err) errlog('ledger:', err);
    // exit 2 = rejected/refused (e.g. known/dismissed) — that's a HANDLED outcome, not a Guardian error.
    return (r.status === 0 || r.status === 2);
  }

  async function runStep(step, cycleDir, sha) {
    const env = Object.assign({}, process.env, PORTS[step.id] || {});
    // The golden child runs in the immutable pin, whose ignored qa/findings directory is empty.
    // Route the Guardian repo's operational ledger explicitly so already-triaged frame noise is
    // review-clean there too. Novel fingerprints remain absent and therefore still fail closed.
    if (step.id === 'golden') {
      env.STARNET_QA_FINDINGS_DIR = path.join(QA_DIR, 'findings');
      env.STARNET_QA_KNOWN_FILE = path.join(QA_DIR, 'KNOWN_ISSUES.md');
    }
    const logFile = path.join(cycleDir, step.id + '.log');
    log(step.id + ' — ' + step.title);
    const res = await runBoundedCommand({
      cmd: npmCmd, args: ['run', step.npm],
      cwd: PIN_DIR, env, timeoutMs: guardianStepTimeoutMs(step, process.env.SKYNET_GUARDIAN_STEP_TIMEOUT_MS), label: 'guardian/' + step.id
    });
    fs.writeFileSync(logFile, res.output, 'utf8');

    // Copy each gate's structured report + flagged frames INTO the cycle bundle so evidence
    // outlives the pinned checkout's next reset.
    let flaggedCount = 0;
    if (step.id === 'golden') {
      const gp = copyInto(path.join(PIN_DIR, '.uigolden', 'golden-report.json'), cycleDir, 'golden-report.json');
      const report = readJsonMaybe(gp) || readJsonMaybe(path.join(PIN_DIR, '.uigolden', 'golden-report.json'));
      const flagged = parseGoldenReport(report);
      flaggedCount = flagged.length;
      for (const f of flagged) if (f.frame) copyInto(f.frame, path.join(cycleDir, 'golden-frames'), path.basename(f.frame));
    } else if (step.id === 'audit') {
      copyInto(path.join(PIN_DIR, '.uiaudit', 'audit-report.json'), cycleDir, 'audit-report.json');
    } else if (step.id === 'journeys') {
      copyInto(path.join(PIN_DIR, '.uijourneys', 'journeys-report.json'), cycleDir, 'journeys-report.json');
      // The runner executes in the immutable pinned checkout, so its candidate-bound READY stamp
      // lands there too. Preserve that exact stamp in the guardian repo before the next pin reset.
      copyInto(path.join(PIN_DIR, 'qa', 'journeys-last-run.json'), QA_DIR, 'journeys-last-run.json');
      // copy every per-journey failure screenshot the runner captured (_FAIL-*.png / <id>.png) into the bundle.
      try {
        const shotDir = path.join(PIN_DIR, '.uijourneys');
        for (const f of (fs.existsSync(shotDir) ? fs.readdirSync(shotDir) : [])) {
          if (/\.png$/i.test(f)) copyInto(path.join(shotDir, f), path.join(cycleDir, 'journey-shots'), f);
        }
      } catch (_) {}
    } else if (step.id === 'shoot') {
      copyInto(path.join(PIN_DIR, '.uishots', 'manifest.json'), cycleDir, 'shoot-manifest.json');
    }

    const spawnError = /\[spawn error\]/.test(res.output) ? res.output.slice(-200) : '';
    return {
      id: step.id, npm: step.npm, title: step.title, severity: step.severity,
      exitCode: res.exitCode, timedOut: res.timedOut, durationMs: res.durationMs,
      spawnError, blocked: false, flaggedCount, logFile, sha, ts: Date.now(),
    };
  }

  // Reload the gate reports FROM the cycle bundle (copied above) so the pure core's
  // finding-derivation reads stable, post-reset-safe paths.
  function cycleIo(cycleDir) {
    return {
      readGolden() { return readJsonMaybe(path.join(cycleDir, 'golden-report.json')); },
      readAudit()  { return readJsonMaybe(path.join(cycleDir, 'audit-report.json')); },
      readShoot()  { return readJsonMaybe(path.join(cycleDir, 'shoot-manifest.json')); },
      readJourneys() { return readJsonMaybe(path.join(cycleDir, 'journeys-report.json')); },
      evidencePath(p) {
        const s = str(p);
        // Log files already live in the cycle bundle; golden frames were copied to golden-frames/, journey
        // failure shots to journey-shots/.
        if (s.startsWith(cycleDir)) return s;
        const base = path.basename(s);
        const inFrames = path.join(cycleDir, 'golden-frames', base);
        if (fs.existsSync(inFrames)) return inFrames;
        const inShots = path.join(cycleDir, 'journey-shots', base);
        if (fs.existsSync(inShots)) return inShots;
        const inRoot = path.join(cycleDir, base);
        if (fs.existsSync(inRoot)) return inRoot;
        return s;
      }
    };
  }

  async function oneCycle(opts) {
    opts = opts || {};
    const skipVisual = !!opts.skipVisual;
    const sha = trunkHead();
    if (!sha) { errlog('FATAL: could not resolve trunk head (' + TRUNK_BRANCH + ')'); return { code: 1, sha: '' }; }

    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
    const cycleDir = path.join(BUGLOOPS, 'guardian-' + stamp);
    ensureDir(cycleDir);
    log('cycle ' + stamp + ' — trunk @ ' + shortSha(sha) + (skipVisual ? ' (visual gates skipped)' : ''));

    // Bound the evidence dir BEFORE this cycle drops its bundle. `.bugloops` has no other cleanup and
    // grows every cycle (>1 GB by 2026-07-09). This sweep deletes only bundles older than 7 days that
    // are outside the newest-5-per-family floor, not a `*-latest` pointer, and not cited by a
    // non-resolved finding's evidence — and it FAILS OPEN (deletes nothing) if findings can't be parsed.
    // Best-effort: a sweep failure never changes the cycle verdict. Manifest lands in THIS cycle's dir.
    try {
      const swept = runEvidenceSweep({
        bugloopsDir: BUGLOOPS,
        findingsDir: path.join(QA_DIR, 'findings'),
        manifestDir: cycleDir,
        manifestName: 'sweep-manifest.json',
        log: (m) => log(m), warn: (m) => errlog(m)
      });
      if (swept && swept.counts) log('  evidence-sweep: deleted ' + swept.counts.deleted + ', kept ' + swept.counts.kept + (swept.findingsError ? ' (FAIL-OPEN — findings unreadable)' : ''));
    } catch (e) { errlog('WARNING: evidence-sweep failed (non-fatal): ' + str(e && e.message || e)); }

    const core = makeGuardianCore({ io: cycleIo(cycleDir), clock: { now: () => Date.now() } });

    // Pin trunk. A pin failure is a BLOCKED P0 (no-fake-green) — we cannot vouch for green.
    const pin = ensurePinnedCheckout(sha);
    const stepResults = [];
    if (!pin.ok) {
      errlog('BLOCKED: ' + pin.reason);
      const blockedResult = { id: 'pin', title: 'Pin trunk into the dedicated checkout', severity: 'P0', blocked: true, blockReason: pin.reason, logFile: '', sha, ts: Date.now() };
      // write the reason as evidence so the finding carries an artifact path.
      const pinLog = path.join(cycleDir, 'pin.log');
      fs.writeFileSync(pinLog, 'BLOCKED pinning trunk ' + shortSha(sha) + ':\n' + pin.reason + '\n', 'utf8');
      blockedResult.logFile = pinLog;
      for (const f of core.findingsFor({ id: 'pin', title: 'Pin trunk', severity: 'P0' }, blockedResult)) fileFinding(f);
      finishCycle(core, [Object.assign({}, blockedResult, { exitCode: 1 })], sha, cycleDir, stamp);
      return { code: 1, sha };
    }

    // The dismissed/known baseline, read ONCE per cycle. A red gate whose every finding is on this
    // set is review-clean (anti-nag) — see the reviewClean handling below + summarize().
    const suppressed = loadSuppressedFingerprints();

    // Run the gates in order. Each red step files its findings; we KEEP GOING so one cycle
    // surfaces every regression (not just the first), then verdict is computed over all.
    const steps = GUARDIAN_STEPS.filter(s => !(skipVisual && s.visual));
    for (const step of steps) {
      let result;
      try {
        result = await runStep(step, cycleDir, sha);
      } catch (e) {
        // an exception spawning/reading is a BLOCKED P0.
        result = { id: step.id, title: step.title, severity: 'P0', blocked: true, blockReason: str(e && e.message || e), logFile: path.join(cycleDir, step.id + '.log'), sha, ts: Date.now(), exitCode: 1 };
        try { fs.writeFileSync(result.logFile, 'BLOCKED running ' + step.id + ':\n' + result.blockReason + '\n', 'utf8'); } catch (_) {}
      }
      stepResults.push(result);
      const findings = core.findingsFor(step, result);
      // REVIEW-CLEAN: a red (non-BLOCKED) gate whose EVERY finding is already dismissed/known is not
      // counted red — the dismissal takes effect at the cycle verdict, exactly as golden already does
      // per-frame. A BLOCKED step (a detector that could not run) is never excused this way.
      if (!result.blocked && !result.spawnError && !result.timedOut && findings.length > 0 &&
          findings.every(f => suppressed.has(str(f.fingerprint)))) {
        result.reviewClean = true;
      }
      for (const f of findings) fileFinding(f);
      const tag = (result.blocked ? 'BLOCKED'
        : result.exitCode === 0 ? 'ok'
        : (step.id === 'golden' && result.flaggedCount === 0) ? 'ok (review-clean)'
        : result.reviewClean ? 'ok (review-clean: all findings dismissed/known)'
        : 'RED');
      log('  ' + tag + '  ' + step.id + ' exit=' + result.exitCode + (findings.length ? ' (' + findings.length + ' finding' + (findings.length > 1 ? 's' : '') + ')' : ''));
    }

    const code = finishCycle(core, stepResults, sha, cycleDir, stamp);
    return { code, sha };
  }

  // Compute the verdict, refresh the STATUS.md row, print the cycle summary. Returns exit code.
  function finishCycle(core, stepResults, sha, cycleDir, stamp) {
    const summary = core.summarize(stepResults);
    // count OPEN Green Guardian findings live from the ledger (the source of truth).
    let openFindings = 0;
    try {
      const st = spawnSync(process.execPath, [LEDGER_CLI, '--status'], { cwd: GUARDIAN_REPO, encoding: 'utf8', windowsHide: true });
      const m = str(st.stdout).split('\n').find(l => /^\|\s*Green Guardian\s*\|/.test(l));
      if (m) { const cells = m.split('|').map(c => c.trim()); openFindings = num(Number(cells[3])); }
    } catch (_) {}

    const isoTime = new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z';
    const row = core.statusRow({ isoTime, sha, verdict: summary.verdict, findings: openFindings });
    try {
      const existing = fs.readFileSync(STATUS_FILE, 'utf8');
      const { markdown, replaced } = core.renderStatus(existing, row);
      if (replaced) { fs.writeFileSync(STATUS_FILE, markdown, 'utf8'); log('STATUS.md Green Guardian row updated → ' + summary.verdict.toUpperCase()); }
      else errlog('WARNING: could not find the Green Guardian row in ' + STATUS_FILE + ' (table reformatted?); STATUS not updated');
    } catch (e) {
      errlog('WARNING: could not update STATUS.md: ' + (e && e.message || e));
    }

    // Write a small cycle summary for the evidence bundle.
    try {
      fs.writeFileSync(path.join(cycleDir, 'cycle-summary.json'), JSON.stringify({
        stamp, sha, generatedAt: new Date().toISOString(), verdict: summary.verdict,
        red: summary.red, blocked: summary.blocked, ran: summary.ran, skipped: summary.skipped,
        steps: stepResults.map(s => ({ id: s.id, exitCode: s.exitCode, blocked: !!s.blocked, timedOut: !!s.timedOut, flaggedCount: s.flaggedCount || 0, durationMs: s.durationMs || 0 }))
      }, null, 2) + '\n', 'utf8');
    } catch (_) {}

    // ADDITIVE (EL-7): a stable machine-readable last-cycle stamp the READY gate (scripts/qa/ready.mjs)
    // reads. Lives at qa/guardian-last-cycle.json (NOT qa/findings/ — the ledger scans every .json there
    // as a finding; a non-finding dropped in would pollute it). Survives the pinned checkout's next reset
    // because it is written into the guardian's OWN repo qa/ dir. Best-effort: a write failure never
    // changes the cycle verdict — the STATUS.md row + evidence bundle already stand.
    try {
      fs.mkdirSync(QA_DIR, { recursive: true });
      fs.writeFileSync(path.join(QA_DIR, 'guardian-last-cycle.json'), JSON.stringify({
        stampIso: new Date().toISOString(),
        trunkHead: sha,
        result: summary.verdict,                 // 'green' | 'red'
        gatesRan: summary.ran, gatesSkipped: summary.skipped,
        gates: stepResults.map(s => ({ id: s.id, exitCode: s.exitCode == null ? null : s.exitCode, blocked: !!s.blocked, timedOut: !!s.timedOut })),
      }, null, 2) + '\n', 'utf8');
    } catch (_) {}

    log('cycle ' + stamp + ' verdict: ' + summary.verdict.toUpperCase() +
      (summary.red.length ? ' — red: ' + summary.red.join(', ') : '') +
      (summary.blocked.length ? ' — BLOCKED: ' + summary.blocked.join(', ') : ''));
    log('evidence: ' + cycleDir);
    return summary.verdict === 'green' ? 0 : 1;
  }

  function parseCliArgs(argv) {
    const a = { once: false, watch: false, skipVisual: false, interval: 60, wait: false };
    for (let i = 0; i < argv.length; i++) {
      const t = argv[i];
      if (t === '--once') a.once = true;
      else if (t === '--watch') a.watch = true;
      else if (t === '--skip-visual') a.skipVisual = true;
      else if (t === '--wait') a.wait = true;
      else if (t === '--interval') a.interval = Math.max(5, Number(argv[++i]) || 60);
    }
    return a;
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Never leave a stale lock behind: release on normal exit AND on the signals a scheduler/Ctrl-C
  // uses to stop the watch process. (The heartbeat timer is unref'd, so 'exit' fires on a clean end.)
  process.on('exit', () => { try { releaseLock(); } catch (_) {} });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { try { releaseLock(); } catch (_) {} process.exit(130); });
  }

  (async () => {
    const args = parseCliArgs(process.argv.slice(2));
    if (args.watch) {
      log('watch mode: polling ' + TRUNK_BRANCH + ' HEAD every ' + args.interval + 's; a cycle runs when it moves.');
      let last = '';
      // run one cycle immediately on the current head, then poll for movement.
      // (Ctrl-C to stop; the scheduler/loop owns lifecycle — this script is schedule-agnostic.)
      for (;;) {
        const head = trunkHead();
        if (head && head !== last) {
          // Take the lock only for the duration of a cycle; if another guardian holds it (an hourly
          // one-shot fired mid-watch), SKIP this cycle and retry on the next poll — do NOT advance
          // `last`, so the moved head is still picked up once the lock frees.
          const lock = await acquireLock({ wait: false });
          if (!lock.ok) {
            if (lock.held) log('watch: another guardian cycle is running (pid ' + (lock.holder && lock.holder.pid) + '); skipping this poll, will retry.');
            else errlog('watch: could not acquire lock: ' + lock.error);
          } else {
            last = head;
            try { const { code } = await oneCycle({ skipVisual: args.skipVisual }); log('watch: cycle done (exit ' + code + '); waiting for the next trunk move...'); }
            finally { releaseLock(); }
          }
        }
        await sleep(args.interval * 1000);
      }
    } else {
      // One-shot (the hourly scheduled task / a manual run). If a live guardian already holds the
      // lock, this trigger is REDUNDANT — exit 0 without touching STATUS/findings (the running cycle
      // covers this or a newer trunk). --wait queues behind it instead of skipping.
      const lock = await acquireLock({ wait: args.wait });
      if (!lock.ok) {
        if (lock.held) {
          log('another guardian cycle is running (pid ' + (lock.holder && lock.holder.pid) + ', started ' +
            (lock.holder && lock.holder.startedAt ? new Date(lock.holder.startedAt).toISOString() : '?') +
            '); this trigger is redundant — skipping. Pass --wait to queue.');
          process.exit(0);
        }
        errlog('FATAL: could not acquire guardian lock: ' + lock.error);
        process.exit(1);
      }
      let code = 1;
      try { ({ code } = await oneCycle({ skipVisual: args.skipVisual })); }
      finally { releaseLock(); }
      process.exit(code);
    }
  })().catch(e => { errlog('FATAL: ' + (e && e.stack || e)); try { releaseLock(); } catch (_) {} process.exit(1); });
}
