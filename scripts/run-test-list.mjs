#!/usr/bin/env node
/* Sequential test-list runner shared by the fast and HTTP gates.

   A list is one repository-relative JavaScript path per line; blank lines and # comments are ignored. Optional
   filters select steps by substring. Process isolation and declared order are preserved intentionally because
   many legacy suites patch globals or own sockets. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function readSteps(listFile) {
  return readFileSync(listFile, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

export function runList(options) {
  const opts = options || {};
  const label = opts.label || 'run-test-list';
  const listFile = isAbsolute(opts.listFile) ? opts.listFile : join(ROOT, opts.listFile);
  const all = readSteps(listFile);
  const filters = Array.isArray(opts.filters) ? opts.filters.filter(Boolean) : [];
  const exclude = Array.isArray(opts.exclude) ? opts.exclude.filter(Boolean) : [];
  const filtered = filters.length ? all.filter(step => filters.some(filter => step.includes(filter))) : all;
  const steps = exclude.length ? filtered.filter(step => !exclude.some(pattern => step.includes(pattern))) : filtered;
  if (filters.length && !steps.length) {
    console.error(label + ': no step in ' + listFile + ' matches ' + filters.join(', '));
    return 1;
  }
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    // HERMETIC PROFILE (2026-08-20): the sidecar's boot-time station auto-recovery scans the real
    // per-user app-data roots for a lost station, and a test's fresh temp workspace looks exactly
    // like one — so on a machine with an installed StarNet station, test-booted sidecars ingested
    // the user's REAL station into their temp workspaces (schema-stamp and sidecar.http broke the
    // day the desktop app was first installed on the dev box). Every step gets its own empty
    // scratch profile so no spawned sidecar can see, or touch, real user data — and no step can
    // plant a station a later step would recover. (test/helpers/sidecar-fixture.js applies the
    // same isolation for directly-invoked fixture tests.)
    const profile = mkdtempSync(join(tmpdir(), 'starnet-gate-profile-'));
    const hermetic = { APPDATA: profile, LOCALAPPDATA: profile, XDG_DATA_HOME: profile };
    if (process.platform !== 'win32') hermetic.HOME = profile;
    const result = spawnSync(process.execPath, [step], {
      stdio: 'inherit',
      cwd: ROOT,
      env: Object.assign({}, process.env, hermetic)
    });
    try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
    if (result.status !== 0) {
      console.error(label + ': FAILED at step ' + (index + 1) + '/' + steps.length + ': node ' + step +
        ' (exit ' + (result.status == null ? 'signal ' + result.signal : result.status) + ')');
      return result.status == null ? 1 : result.status;
    }
  }
  console.log(label + ': OK — ' + steps.length + ' step(s) green');
  return 0;
}

export function main(argv) {
  const args = Array.isArray(argv) ? argv.slice() : process.argv.slice(2);
  const listFile = args.shift();
  if (!listFile) {
    console.error('usage: node scripts/run-test-list.mjs <list-file> [substring filters...]');
    return 1;
  }
  return runList({ listFile, filters: args });
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) process.exit(main());
