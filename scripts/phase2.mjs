#!/usr/bin/env node
// phase2.mjs - StarNet ref-replacement Phase 2 steering runner.
//
// This is not a new product test suite. It is the control loop that turns the Phase 2
// replacement plan into evidence: run the gates that can run on this machine, mark
// live-provider/toolchain blockers honestly, and write a rerunnable status bundle.
//
// Usage:
//   npm run phase2              # mock-safe gates + evidence
//   npm run phase2:live         # also run paid live gates when a key exists
//   npm run phase2:desktop      # classify desktop build/toolchain state too

import { existsSync, mkdirSync, rmSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coerceTimeoutMs, runBoundedCommand, npmGateTimeoutMs } from './lib/run-command.mjs';
import { hasLiveProviderKey, liveProviderEnv, withoutLiveProviderEnv } from './lib/provider-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const WANT_LIVE = args.has('--live');
const WANT_DESKTOP = args.has('--desktop');
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
const OUT = resolve(process.env.STARNET_PHASE2_DIR || join(ROOT, '.dogfood', 'phase2-' + STAMP));
const LATEST = join(ROOT, '.dogfood', 'phase2-latest');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const nodeCmd = process.execPath;
const STEP_TIMEOUT_MS = coerceTimeoutMs(process.env.STARNET_PHASE2_STEP_TIMEOUT_MS || 900000);

function ensureDir(p) { mkdirSync(p, { recursive: true }); }
function hasEnvKey() {
  return hasLiveProviderKey();
}
function cargoAvailable() {
  const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const paths = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  return paths.some(p => p && existsSync(join(p, exe)));
}
function tail(s, n = 5000) {
  s = String(s || '');
  return s.length > n ? s.slice(s.length - n) : s;
}
function mdEscape(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}
function statusIcon(status) {
  return status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : status === 'blocked' ? 'BLOCKED' : 'SKIP';
}

async function runStep(step) {
  ensureDir(OUT);
  if (step.skip) {
    return Object.assign({}, step, { status: step.blocked ? 'blocked' : 'skip', exitCode: null, durationMs: 0, logFile: null, outputTail: step.reason || '' });
  }
  const logFile = join(OUT, step.id + '.log');
  const result = await runBoundedCommand({
    cmd: step.cmd,
    args: step.args || [],
    cwd: ROOT,
    env: step.env || process.env,
    timeoutMs: step.timeoutMs || STEP_TIMEOUT_MS,
    label: 'phase2/' + step.id
  });
  writeFileSync(logFile, result.output);
  return Object.assign({}, step, {
    status: result.exitCode === 0 ? 'pass' : (step.allowFailure ? 'blocked' : 'fail'),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    logFile,
    outputTail: tail(result.output),
    reason: result.timedOut ? 'Timed out after ' + (step.timeoutMs || STEP_TIMEOUT_MS) + 'ms.' : step.reason
  });
}

function copyIfExists(src, destName) {
  try {
    if (!existsSync(src)) return null;
    const dest = join(OUT, destName);
    ensureDir(dirname(dest));
    copyFileSync(src, dest);
    return dest;
  } catch (_) { return null; }
}

function writeSummary(results) {
  const pass = results.filter(r => r.status === 'pass').length;
  const fail = results.filter(r => r.status === 'fail').length;
  const blocked = results.filter(r => r.status === 'blocked').length;
  const skipped = results.filter(r => r.status === 'skip').length;
  const json = {
    generatedAt: new Date().toISOString(),
    phase: 2,
    outDir: OUT,
    verdict: fail ? 'red' : blocked ? 'blocked' : 'green',
    counts: { pass, fail, blocked, skipped },
    liveKeyPresent: hasEnvKey(),
    desktopCargoPresent: cargoAvailable(),
    results: results.map(r => ({
      id: r.id, title: r.title, status: r.status, exitCode: r.exitCode, required: !!r.required,
      durationMs: r.durationMs, timedOut: !!r.timedOut, logFile: r.logFile,
      reason: (r.status === 'skip' || r.status === 'blocked' || r.status === 'fail') ? (r.reason || '') : ''
    }))
  };
  writeFileSync(join(OUT, 'phase2-status.json'), JSON.stringify(json, null, 2));

  let md = '# StarNet Phase 2 Evidence\n\n';
  md += '- Generated: `' + json.generatedAt + '`\n';
  md += '- Verdict: `' + json.verdict + '`\n';
  md += '- Live key present: `' + json.liveKeyPresent + '`\n';
  md += '- Cargo present: `' + json.desktopCargoPresent + '`\n\n';
  md += '| Status | Step | Required | Notes |\n|---|---|---:|---|\n';
  for (const r of results) {
    const note = r.timedOut
      ? (r.reason || 'Timed out.')
      : (r.status === 'skip' || r.status === 'blocked')
      ? (r.reason || '')
      : (r.exitCode == null ? '' : 'exit ' + r.exitCode);
    md += '| ' + statusIcon(r.status) + ' | `' + r.id + '` ' + mdEscape(r.title) + ' | ' + (r.required ? 'yes' : 'no') + ' | ' + mdEscape(note) + ' |\n';
  }
  md += '\n## Logs\n\n';
  for (const r of results) if (r.logFile) md += '- `' + r.id + '`: `' + r.logFile + '`\n';
  md += '\n## Next Action\n\n';
  if (fail) md += 'Fix the failing required step before claiming Phase 2 progress.\n';
  else if (blocked) md += 'Blocked steps need external state: usually a real OpenRouter key or desktop Rust/Cargo toolchain.\n';
  else md += 'All enabled Phase 2 gates are green. Proceed to real dogfood task execution.\n';
  writeFileSync(join(OUT, 'summary.md'), md);

  rmSync(LATEST, { recursive: true, force: true });
  ensureDir(LATEST);
  for (const name of readdirSync(OUT)) {
    const src = join(OUT, name);
    const dest = join(LATEST, name);
    try { copyFileSync(src, dest); } catch (_) {}
  }
  return json;
}

async function main() {
  ensureDir(OUT);
  const nonLiveEnv = withoutLiveProviderEnv();
  const noKeyReason = 'No live key found. Set SKYNET_OPENROUTER_KEY, STARNET_OPENROUTER_KEY, or OPENROUTER_API_KEY.';
  const liveSkippedReason = 'Run `npm run phase2:live` to execute paid provider proof.';
  const steps = [
    { id: 'test-fast', title: 'Core harness unit/integration gate', cmd: npmCmd, args: ['run', 'test:fast'], env: nonLiveEnv, required: true },
    { id: 'test-http', title: 'Sidecar HTTP/e2e gate', cmd: npmCmd, args: ['run', 'test:http'], env: nonLiveEnv, required: true, timeoutMs: npmGateTimeoutMs('test:http', process.env.STARNET_PHASE2_STEP_TIMEOUT_MS) },
    { id: 'audit-mock', title: 'Deterministic UI audit gate', cmd: npmCmd, args: ['run', 'audit'], env: nonLiveEnv, required: true },
    { id: 'golden', title: 'Reviewed UI golden gate', cmd: npmCmd, args: ['run', 'golden'], env: nonLiveEnv, required: true },
    // The 'validate-map' + 'test-world' steps were removed 2026-07-24 with the scripts they invoked:
    // both were Phase-0.0 wrappers around the ported v7 engine files frontend/js/map.js and
    // frontend/js/data.js, which no longer exist — so two REQUIRED steps here could never pass. The
    // current engine is gated by worldmodel/crew-containment/station-authority inside test:fast above.
    {
      id: 'live-smoke',
      title: 'Paid provider smoke via /api/run',
      cmd: nodeCmd,
      args: ['test/live.smoke.js'],
      env: liveProviderEnv(),
      required: WANT_LIVE,
      skip: !WANT_LIVE || !hasEnvKey(),
      blocked: WANT_LIVE && !hasEnvKey(),
      reason: WANT_LIVE ? noKeyReason : liveSkippedReason
    },
    {
      id: 'audit-live',
      title: 'Paid provider smoke through seeded UI audit',
      cmd: npmCmd,
      args: ['run', 'audit'],
      env: liveProviderEnv(),
      required: WANT_LIVE,
      skip: !WANT_LIVE || !hasEnvKey(),
      blocked: WANT_LIVE && !hasEnvKey(),
      reason: WANT_LIVE ? noKeyReason : liveSkippedReason
    },
    {
      id: 'desktop-prepare',
      title: 'Desktop bundled Node preparation',
      cmd: npmCmd,
      args: ['run', 'desktop:prepare'],
      env: nonLiveEnv,
      required: false,
      skip: !WANT_DESKTOP,
      reason: 'Run `npm run phase2:desktop` to classify desktop release prep.'
    },
    {
      id: 'desktop-build',
      title: 'Desktop Tauri build',
      cmd: npmCmd,
      args: ['run', 'desktop:build'],
      env: nonLiveEnv,
      required: false,
      allowFailure: true,
      skip: !WANT_DESKTOP || !cargoAvailable(),
      blocked: WANT_DESKTOP && !cargoAvailable(),
      reason: WANT_DESKTOP && !cargoAvailable()
        ? 'Cargo/Rust is not on PATH. Install Rust toolchain, then rerun `npm run phase2:desktop`.'
        : 'Run `npm run phase2:desktop` to classify desktop release prep.'
    }
  ];

  const results = [];
  for (const step of steps) {
    console.log('[phase2] ' + step.id + ' - ' + step.title);
    const r = await runStep(step);
    results.push(r);
    console.log('[phase2]   ' + statusIcon(r.status) + (r.exitCode == null ? '' : ' exit=' + r.exitCode));
    if (r.status === 'fail' && r.required) break;
    if (r.id === 'audit-mock') copyIfExists(join(ROOT, '.uiaudit', 'audit-report.json'), 'audit/mock-audit-report.json');
    if (r.id === 'audit-live') copyIfExists(join(ROOT, '.uiaudit', 'audit-report.json'), 'audit/live-audit-report.json');
    if (r.id === 'golden') copyIfExists(join(ROOT, '.uigolden', 'golden-report.json'), 'golden/golden-report.json');
  }
  const summary = writeSummary(results);
  console.log('[phase2] evidence: ' + OUT);
  console.log('[phase2] latest: ' + LATEST);
  if (summary.verdict === 'red') process.exit(1);
  if (WANT_LIVE && results.some(r => r.required && r.status === 'blocked')) process.exit(2);
}

main().catch(e => { console.error('[phase2] FATAL: ' + ((e && e.stack) || e)); process.exit(1); });
