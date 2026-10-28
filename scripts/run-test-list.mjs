#!/usr/bin/env node
/* Sequential test-list runner shared by the fast and HTTP gates.

   A list is one repository-relative JavaScript path per line; blank lines and # comments are ignored. Optional
   filters select steps by substring. Process isolation and declared order are preserved intentionally because
   many legacy suites patch globals or own sockets.

   WHAT A GATE RUN GUARANTEES (gate-seams, 2026-10-27):
   - EVERY step runs. A red step no longer hides the steps after it: the run goes to the end, then names every
     failure with its step number. Any failure still exits non-zero.
   - EVERY step is bounded. A step gets STEP_TIMEOUT_MS (120 s); a step declared in test/slow.list gets
     SLOW_STEP_TIMEOUT_MS (600 s). A hung step has its whole process tree killed, is reported by number and
     path, and the run moves on. A hang can no longer stall the gate until the outer 50/60 minute wrapper fires.
   - The WHOLE run can be bounded too: --deadline=<ms> (package.json sets one a few minutes inside each outer
     timeout.mjs wrapper). Past it the run stops starting steps, cuts the current one off, and still prints the
     failure list and an OUT OF TIME last line — the wrapper's kill would leave a log with no summary at all.
   - EVERY step is timed, and the slowest are listed at the end, so test/slow.list can be kept honest.
   - A step listed in test/flaky.list (a known flake, quarantined) is retried once ONLY when its first attempt
     failed in the named flaking case: every FAIL line it printed starts with one of the entry's case prefixes.
     A failure anywhere else in that file (or a crash with no FAIL line, or a timeout) is never retried. A pass
     on the retry is reported in its own section and does not turn the gate red; a second failure does.
   - EVERY step runs with an allowlisted environment: the variables Windows and POSIX need to spawn processes
     (PATH, SYSTEMROOT, TEMP, ...) plus a fresh scratch profile for the app-data roots. The developer's ambient
     variables (provider keys, STARNET_/SKYNET_ overrides, NODE_OPTIONS, GIT_DIR, ...) never reach a test.
     What the profile does NOT isolate, on Windows: the home directory (see buildStepEnv).
   - An INTERRUPTED run (SIGINT / SIGTERM) is never green: the current step is killed, no later step starts, and
     the last line says INTERRUPTED with how many steps ran, whatever the step that was running exited with.

   The LAST line of a run is the summary: `<label>: OK — N step(s) green` only when every step ran and passed.
   scripts/release-preflight.mjs and release-ritual.mjs read that line, never the exit code. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const STEP_TIMEOUT_MS = 120000;
export const SLOW_STEP_TIMEOUT_MS = 600000;
export const SLOW_LIST = 'test/slow.list';
export const FLAKY_LIST = 'test/flaky.list';
// After an interrupt the run waits this long for the killed step to report its exit before it exits anyway.
const INTERRUPT_GRACE_MS = 10000;
// A captured (flaky) step's pipes get this long to drain after the process exits; a grandchild holding them open
// must not hold the gate.
const DRAIN_GRACE_MS = 2000;
const MAX_FAIL_LINES = 500;

/* The variables a step may inherit. Everything else in the parent environment is dropped.
   - Spawning on Windows needs PATH/PATHEXT/COMSPEC/SYSTEMROOT/WINDIR (node, cmd.exe, taskkill, git, npm.cmd).
   - TEMP/TMP/TMPDIR keep os.tmpdir() where the machine wants scratch files.
   - USERPROFILE/HOMEDRIVE/HOMEPATH/HOME (Windows only — on POSIX HOME is the hermetic profile) keep git's global
     config reachable, which is where a developer box keeps the commit identity git-using tests rely on.
   - PROGRAMFILES and friends let browser discovery find a machine-wide Chrome; the CI knobs a workflow sets on
     purpose pass too: CI, GITHUB_ACTIONS, RUNNER_OS, RUNNER_TEMP, SKYNET_CHROME (the CDP tests' Chrome wrapper).
   - LANG, the LC_ variables and TZ keep locale-sensitive formatting what it was before the allowlist existed. */
const PASS_ENV = new Set([
  'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'TMPDIR',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'OS',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL', 'PROCESSOR_REVISION',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432', 'PROGRAMDATA', 'ALLUSERSPROFILE', 'PUBLIC',
  'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ',
  'DISPLAY', 'XDG_RUNTIME_DIR',
  'CI', 'GITHUB_ACTIONS', 'RUNNER_OS', 'RUNNER_TEMP', 'SKYNET_CHROME'
]);

/* HERMETIC PROFILE (2026-08-20): the sidecar's boot-time station auto-recovery scans the real per-user app-data
   roots for a lost station, and a test's fresh temp workspace looks exactly like one — so on a machine with an
   installed StarNet station, test-booted sidecars ingested the user's REAL station into their temp workspaces
   (schema-stamp and sidecar.http broke the day the desktop app was first installed on the dev box). Every step
   gets its own empty scratch profile for APPDATA / LOCALAPPDATA / XDG_DATA_HOME (and HOME on POSIX), so no
   spawned sidecar can find or recover the real station through them — and no step can plant a station a later
   step would recover. (test/helpers/sidecar-fixture.js applies the same isolation for directly-invoked fixture
   tests.) The profile is applied AFTER the allowlist, so it always wins.

   NOT ISOLATED ON WINDOWS: the home directory. USERPROFILE (and HOME, when set) stay the real ones, so
   os.homedir() is the developer's real home and a test-booted sidecar that resolves a path from it — project
   discovery's Desktop/Documents roots, a workshop deliverable on the Desktop, a station export to Downloads —
   reads or writes there. This is what trunk did before the allowlist; it is kept because git-using tests take
   their commit identity from the real ~/.gitconfig. A test that writes under the home must override USERPROFILE
   itself (config-export-save.e2e does). */
export function buildStepEnv(parentEnv, profile, platform) {
  const plat = platform || process.platform;
  const env = {};
  for (const [key, value] of Object.entries(parentEnv || {})) {
    if (value == null) continue;
    const upper = key.toUpperCase();
    if (upper === 'HOME' && plat !== 'win32') continue;
    if (PASS_ENV.has(upper) || (upper === 'HOME' && plat === 'win32')) env[key] = String(value);
  }
  env.APPDATA = profile;
  env.LOCALAPPDATA = profile;
  env.XDG_DATA_HOME = profile;
  if (plat !== 'win32') env.HOME = profile;
  return env;
}

export function readSteps(listFile) {
  return readFileSync(listFile, 'utf8')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

function readOptionalSteps(listFile) {
  return listFile && existsSync(listFile) ? readSteps(listFile) : [];
}

/* test/flaky.list entry: `<step> | <case prefix> [| <case prefix> ...]`. A case prefix is the start of the FAIL
   message (after "FAIL: ") of an assertion known to flake. Returns Map<step, prefixes[]>; an entry that names no
   case keeps an empty array and is never retried. */
export function parseFlakyEntries(lines) {
  const out = new Map();
  for (const line of lines || []) {
    const parts = String(line).split('|').map(part => part.trim());
    const step = parts.shift();
    if (!step) continue;
    out.set(step, (out.get(step) || []).concat(parts.filter(Boolean)));
  }
  return out;
}

/* Whether a quarantined step's failed attempt is the known flake: at least one FAIL line, and every FAIL line
   starts with one of the entry's case prefixes. Returns { retry, unmatched } (unmatched: the first FAIL line
   outside the cases, or a reason). */
export function flakyCaseMatch(failLines, prefixes) {
  const cases = (prefixes || []).filter(Boolean);
  if (!cases.length) return { retry: false, unmatched: 'the flaky.list entry names no flaking case' };
  const fails = (failLines || []).map(line => String(line).replace(/^FAIL:\s*/, ''));
  if (!fails.length) return { retry: false, unmatched: 'it printed no FAIL line (a crash, or a failure outside the assertions)' };
  const outside = fails.find(message => !cases.some(prefix => message.startsWith(prefix)));
  return outside === undefined ? { retry: true, unmatched: null } : { retry: false, unmatched: 'FAIL: ' + outside };
}

/* "2/4" → { index: 2, total: 4 }. Shards are contiguous slices in declared order, so steps that sit next to each
   other in a list keep running in the same order on the same machine. */
export function parseShard(text) {
  const m = /^(\d+)\/(\d+)$/.exec(String(text || '').trim());
  if (!m) throw new Error('--shard must look like K/N (got "' + text + '")');
  const index = Number(m[1]), total = Number(m[2]);
  if (!(total >= 1) || !(index >= 1) || index > total) throw new Error('--shard ' + text + ' is out of range');
  return { index, total };
}

export function shardSteps(steps, shard) {
  if (!shard) return steps.slice();
  const size = Math.ceil(steps.length / shard.total);
  return steps.slice((shard.index - 1) * size, shard.index * size);
}

function seconds(ms) {
  return (ms / 1000).toFixed(1) + 's';
}

function clock(ms) {
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
}

function killTree(child) {
  return new Promise(done => {
    if (!child || !child.pid) return done();
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => done());
      killer.on('close', () => done());
      return;
    }
    try { process.kill(-child.pid, 'SIGTERM'); } catch (_) { try { child.kill('SIGTERM'); } catch (_) {} }
    setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
      done();
    }, 2000).unref();
  });
}

let activeChild = null;

/* Forwards a captured stream to our own and keeps its FAIL lines (bounded), line by line. */
function captureFailLines(stream, sink, failLines) {
  let rest = '';
  const take = line => { if (/^FAIL:/.test(line) && failLines.length < MAX_FAIL_LINES) failLines.push(line.replace(/\r$/, '')); };
  stream.on('data', chunk => {
    try { sink.write(chunk); } catch (_) {}
    const lines = (rest + chunk.toString('utf8')).split('\n');
    rest = lines.pop();
    if (rest.length > 65536) rest = rest.slice(-65536);
    lines.forEach(take);
  });
  return () => { if (rest) take(rest); rest = ''; };
}

/* One attempt at one step: a fresh hermetic profile, a bounded lifetime, and the whole process tree killed if the
   bound is hit. opts.capture tees the step's output (to opts.stdout/opts.stderr, our own by default) and keeps its
   FAIL lines (only flaky steps need that).
   Resolves { status, signal, timedOut, ms, failLines }; never rejects. */
function runAttempt(step, opts) {
  const profile = mkdtempSync(join(tmpdir(), 'starnet-gate-profile-'));
  const started = Date.now();
  const capture = !!opts.capture;
  const failLines = [];
  return new Promise(done => {
    let finished = false, timedOut = false, fallback = null, drain = null, exited = null;
    const child = spawn(process.execPath, (opts.nodeArgs || []).concat([step]), {
      stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      cwd: opts.cwd || ROOT,
      env: buildStepEnv(opts.parentEnv || process.env, profile),
      // POSIX: the step leads its own process group, so a timeout can kill the sidecars it spawned too.
      detached: process.platform !== 'win32'
    });
    activeChild = child;
    const flushers = capture
      ? [captureFailLines(child.stdout, opts.stdout || process.stdout, failLines), captureFailLines(child.stderr, opts.stderr || process.stderr, failLines)]
      : [];
    const finish = (status, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (fallback) clearTimeout(fallback);
      if (drain) clearTimeout(drain);
      activeChild = null;
      flushers.forEach(flush => flush());
      if (capture) { try { child.stdout.destroy(); } catch (_) {} try { child.stderr.destroy(); } catch (_) {} }
      try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
      done({ status: timedOut ? 124 : status, signal: signal || null, timedOut, ms: Date.now() - started, failLines });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      opts.log(opts.label + ': step ' + opts.position + ' ' + (opts.deadlineCut ? 'reached the run deadline' : 'TIMED OUT') +
        ' after ' + seconds(opts.timeoutMs) + ' — killing its process tree: node ' + step);
      killTree(child).then(() => {
        // a child that never reports its exit must not hang the gate either
        fallback = setTimeout(() => finish(124, null), 10000);
        fallback.unref();
      });
    }, opts.timeoutMs);
    child.on('error', error => {
      opts.log(opts.label + ': step ' + opts.position + ' could not start: ' + ((error && error.message) || error));
      finish(127, null);
    });
    child.on('exit', (code, signal) => {
      if (!capture) return finish(code, signal);
      exited = { code, signal };
      drain = setTimeout(() => finish(code, signal), DRAIN_GRACE_MS);
    });
    // a captured step: its output is complete once its pipes close
    if (capture) child.on('close', (code, signal) => finish(exited ? exited.code : code, exited ? exited.signal : signal));
  });
}

function describeFailure(r) {
  if (r.timedOut) return r.deadlineCut ? 'stopped at the run deadline after ' + seconds(r.timeoutMs) : 'timed out after ' + seconds(r.timeoutMs);
  if (r.status == null) return 'signal ' + r.signal;
  return 'exit ' + r.status;
}

/* Runs every selected step and resolves the process exit code: 0 when every step ran and passed; 130 when the run
   was interrupted; 124 when the run deadline cut it short; otherwise the first failing step's exit code (124 for a
   timeout, 1 for a signal). */
export async function runList(options) {
  const opts = options || {};
  const label = opts.label || 'run-test-list';
  const log = typeof opts.log === 'function' ? opts.log : (line => console.log(line));
  const at = p => (isAbsolute(p) ? p : join(ROOT, p));
  const listFile = at(opts.listFile);
  const all = readSteps(listFile);
  const filters = Array.isArray(opts.filters) ? opts.filters.filter(Boolean) : [];
  const filtered = filters.length ? all.filter(step => filters.some(filter => step.includes(filter))) : all;
  if (filters.length && !filtered.length) {
    log(label + ': no step in ' + listFile + ' matches ' + filters.join(', '));
    return 1;
  }
  const steps = shardSteps(filtered, opts.shard || null);
  if (opts.shard) log(label + ': shard ' + opts.shard.index + '/' + opts.shard.total + ' — ' + steps.length + ' of ' + filtered.length + ' step(s)');
  const slow = new Set(readOptionalSteps(opts.slowList === undefined ? at(SLOW_LIST) : (opts.slowList && at(opts.slowList))));
  const flaky = parseFlakyEntries(readOptionalSteps(opts.flakyList === undefined ? at(FLAKY_LIST) : (opts.flakyList && at(opts.flakyList))));
  for (const [step, cases] of flaky) if (!cases.length) log(label + ': flaky list entry ' + step + ' names no flaking case — it is NOT quarantined');
  const stepTimeout = Number(opts.stepTimeoutMs) > 0 ? Number(opts.stepTimeoutMs) : STEP_TIMEOUT_MS;
  const slowTimeout = Number(opts.slowTimeoutMs) > 0 ? Number(opts.slowTimeoutMs) : SLOW_STEP_TIMEOUT_MS;
  const deadlineMs = Number(opts.deadlineMs) > 0 ? Number(opts.deadlineMs) : 0;
  const exit = typeof opts.exit === 'function' ? opts.exit : (code => process.exit(code));

  const results = [];
  const failures = [];
  const flakyNotes = [];
  const runStarted = Date.now();
  const deadlineAt = deadlineMs ? runStarted + deadlineMs : Infinity;
  let interrupted = null, outOfTime = false, hardExit = null;
  const onSignal = signal => {
    if (interrupted) return;
    interrupted = signal;
    log(label + ': interrupted by ' + signal + ' — stopping the current step and the run');
    if (activeChild) killTree(activeChild);
    // the loop ends the run once the killed step reports its exit; this only fires if it never does
    hardExit = setTimeout(() => {
      log(label + ': INTERRUPTED by ' + signal + ' — the running step never reported its exit; not a green run');
      exit(130);
    }, INTERRUPT_GRACE_MS);
    hardExit.unref();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    for (let index = 0; index < steps.length && !interrupted; index++) {
      const step = steps[index];
      const position = (index + 1) + '/' + steps.length;
      const declared = slow.has(step) ? slowTimeout : stepTimeout;
      const left = deadlineAt - Date.now();
      if (left <= 0) { outOfTime = true; break; }
      const timeoutMs = Math.min(declared, left);
      const deadlineCut = timeoutMs < declared;
      const cases = flaky.get(step);
      const attemptOpts = { label, position, timeoutMs, deadlineCut, log, nodeArgs: opts.nodeArgs, parentEnv: opts.parentEnv, cwd: opts.cwd, capture: !!cases, stdout: opts.stdout, stderr: opts.stderr };
      let r = Object.assign(await runAttempt(step, attemptOpts), { timeoutMs, deadlineCut });
      if (interrupted) { log(label + ': step ' + position + ' interrupted — node ' + step); break; }
      const attempts = [r];
      if (r.status !== 0 && cases) {
        const match = r.timedOut ? { retry: false, unmatched: 'it timed out (a quarantined case fails, it does not hang)' } : flakyCaseMatch(r.failLines, cases);
        if (match.retry && Date.now() < deadlineAt) {
          log(label + ': step ' + position + ' failed (' + describeFailure(r) + ') in its quarantined flaky case (test/flaky.list) — retrying once: node ' + step);
          const retryLeft = deadlineAt - Date.now();
          const retryTimeout = Math.min(declared, retryLeft);
          r = Object.assign(await runAttempt(step, Object.assign({}, attemptOpts, { timeoutMs: retryTimeout, deadlineCut: retryTimeout < declared })),
            { timeoutMs: retryTimeout, deadlineCut: retryTimeout < declared });
          if (interrupted) { log(label + ': step ' + position + ' interrupted — node ' + step); break; }
          attempts.push(r);
          flakyNotes.push({ step, position, attempts });
        } else {
          log(label + ': step ' + position + ' is quarantined in test/flaky.list but failed outside its flaking case — not retried: ' +
            (match.unmatched || 'the run deadline passed'));
          flakyNotes.push({ step, position, attempts, notRetried: match.unmatched || 'the run deadline passed' });
        }
      }
      const ms = attempts.reduce((sum, a) => sum + a.ms, 0);
      const ok = r.status === 0;
      const row = { step, position, ok, ms, status: r.status, signal: r.signal, timedOut: r.timedOut, timeoutMs: r.timeoutMs, deadlineCut: !!(r.timedOut && r.deadlineCut), attempts: attempts.length };
      results.push(row);
      if (row.deadlineCut) outOfTime = true;
      if (!ok) failures.push(Object.assign({ index }, row, { why: describeFailure(r) }));
      log(label + ': step ' + position + ' ' + (ok ? 'ok' : 'FAILED (' + describeFailure(r) + ')') + ' ' + seconds(ms) + ' — node ' + step);
      if (typeof opts.onStepResult === 'function') opts.onStepResult(row);
      if (outOfTime) break;
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  if (opts.timingsFile) {
    try { writeFileSync(at(opts.timingsFile), JSON.stringify({ label, list: opts.listFile, steps: results }, null, 2) + '\n'); }
    catch (error) { log(label + ': could not write timings to ' + opts.timingsFile + ': ' + error.message); }
  }

  log(label + ': ran ' + results.length + ' of ' + steps.length + ' step(s) in ' + clock(Date.now() - runStarted));
  const slowest = results.slice().sort((a, b) => b.ms - a.ms).slice(0, 10);
  if (slowest.length) {
    log(label + ': slowest steps:');
    for (const r of slowest) log('  ' + seconds(r.ms).padStart(7) + '  ' + r.step + (slow.has(r.step) ? '  (slow.list)' : ''));
  }
  if (flakyNotes.length) {
    log(label + ': quarantined flaky steps that failed at least once (test/flaky.list):');
    for (const note of flakyNotes) {
      const final = note.attempts[note.attempts.length - 1];
      log('  step ' + note.position + ' node ' + note.step + ' — first attempt ' + describeFailure(note.attempts[0]) +
        (note.notRetried ? ', not retried (' + note.notRetried + '), counted as a failure'
          : final.status === 0 ? ', passed on retry' : ', retry ' + describeFailure(final) + ' (counted as a failure)'));
    }
  }
  for (const f of failures) log(label + ': FAILED at step ' + f.position + ': node ' + f.step + ' (' + f.why + ')');
  const firstCode = () => {
    const first = failures[0];
    return first.timedOut ? 124 : (first.status == null || first.status === 0 ? 1 : first.status);
  };
  try {
    // an interrupted or cut-short run is never green, whatever the last step it ran exited with
    if (interrupted) {
      log(label + ': INTERRUPTED by ' + interrupted + ' — ran ' + results.length + ' of ' + steps.length + ' step(s)' +
        (failures.length ? ', ' + failures.length + ' failed' : '') + '; not a green run');
      return 130;
    }
    if (outOfTime || results.length < steps.length) {
      log(label + ': OUT OF TIME — the ' + clock(deadlineMs) + ' run deadline passed after ' + results.length + ' of ' + steps.length +
        ' step(s)' + (failures.length ? ', ' + failures.length + ' failed' : '') + '; not a green run');
      return 124;
    }
    if (failures.length) {
      log(label + ': FAILED — ' + failures.length + ' of ' + steps.length + ' step(s) failed');
      return firstCode();
    }
    log(label + ': OK — ' + steps.length + ' step(s) green');
    return 0;
  } finally {
    if (hardExit) clearTimeout(hardExit);
  }
}

export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const out = { listFile: null, filters: [], shard: null, timingsFile: null, deadlineMs: 0 };
  for (const arg of args) {
    if (arg.startsWith('--shard=')) out.shard = parseShard(arg.slice('--shard='.length));
    else if (arg.startsWith('--timings=')) out.timingsFile = arg.slice('--timings='.length);
    else if (arg.startsWith('--deadline=')) {
      const ms = Number(arg.slice('--deadline='.length));
      if (!Number.isInteger(ms) || ms <= 0) throw new Error('--deadline must be a whole number of milliseconds (got "' + arg.slice('--deadline='.length) + '")');
      out.deadlineMs = ms;
    }
    else if (arg.startsWith('--')) throw new Error('unknown option ' + arg);
    else if (!out.listFile) out.listFile = arg;
    else out.filters.push(arg);
  }
  return out;
}

export async function main(argv) {
  let parsed;
  try { parsed = parseArgs(Array.isArray(argv) ? argv : process.argv.slice(2)); }
  catch (error) { console.error(error.message); parsed = null; }
  if (!parsed || !parsed.listFile) {
    console.error('usage: node scripts/run-test-list.mjs <list-file> [--shard=K/N] [--timings=<file.json>] [--deadline=<ms>] [substring filters...]');
    return 1;
  }
  return runList(parsed);
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) process.exit(await main());
