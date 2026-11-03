/*
 * keyless-sidecar.mjs — boot a sidecar entry KEYLESS and hermetic, use it, and tear it down.
 *
 * Moved unchanged out of voice-floor.mjs (which re-exports keylessEnv), so the live voice canary and the WebKit floor
 * job (scripts/qa/webkit-floor-boot.mjs) boot the station the same way: an allowlisted environment (no *_KEY / *_TOKEN
 * can leak in), a fresh profile and workspace, the caller's port, and the boot-time Edge probe off. It stays under
 * scripts/canary because floor-canaries.yml sparse-checks-out only that folder from its own commit.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The environment a KEYLESS sidecar boots with: an allowlist (no *_KEY / *_TOKEN can leak in), a fresh profile and
// workspace, the canary's port, and the boot-time floor probe off (this script IS the probe).
const PASS_ENV = new Set(['PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'TMPDIR',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'LANG', 'LC_ALL', 'TZ', 'CI', 'GITHUB_ACTIONS', 'RUNNER_OS', 'RUNNER_TEMP']);
export function keylessEnv(parent, profile, port) {
  const env = {};
  for (const [k, v] of Object.entries(parent || {})) if (v != null && PASS_ENV.has(k.toUpperCase())) env[k] = String(v);
  Object.assign(env, {
    APPDATA: profile, LOCALAPPDATA: profile, XDG_DATA_HOME: profile,
    STARNET_PORT: String(port), SKYNET_PORT: String(port),
    STARNET_WORKSPACES: join(profile, 'workspaces'), SKYNET_WORKSPACES: join(profile, 'workspaces'),
    SKYNET_EDGE_TTS_PROBE: '0'
  });
  if (process.platform !== 'win32') env.HOME = profile;
  return env;
}

/* Spawn `entry` keyless on `port`, wait up to healthMs for /api/health (at once if the entry exits), then hand
   use(base, { output }) the running station; kill it and remove the profile afterwards. A sidecar that never comes up
   answers { ok: false, why, tail } with its own last output. */
export async function withKeylessSidecar(entry, port, use, { profilePrefix = 'starnet-keyless-', healthMs = 90000 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), profilePrefix));
  const base = 'http://127.0.0.1:' + port;
  let output = '';
  const child = spawn(process.execPath, [entry], { env: keylessEnv(process.env, profile, port), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  try {
    let healthy = false;
    for (let waited = 0; waited < healthMs && child.exitCode === null; waited += 250) {
      try { const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(1000) }); if (r.status === 200) { healthy = true; break; } } catch (_) { /* not up yet */ }
      await sleep(250);
    }
    if (!healthy) return { ok: false, why: 'the keyless sidecar did not come up on ' + base, tail: output.slice(-1500) };
    return await use(base, { output: () => output });
  } finally {
    try { child.kill(); } catch (_) { /* already gone */ }
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch (_) { /* a file still held on Windows */ }
  }
}
