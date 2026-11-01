// scripts/lib/seed.mjs — boot a SEEDED (pre-onboarded) SKYNET_DEV sidecar so headless capture
// lands IN-GAME instead of on the title screen.
//
// A raw `SKYNET_DEV=1 node sidecar/index.js` has no agent → the page sits on the title/connect
// screen, useless for UI testing. dev/seed.js solves this by materializing a golden agent
// fixture into a scratch workspace and booting with SKYNET_DEV + SKYNET_FULL_ACCESS so the
// frontend auto-resumes onto the live floor. This module replicates that minimal boot so the
// shooter OWNS the sidecar process (and can kill it cleanly) without shelling through seed.js.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { sleep } from './cdp.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = join(REPO, 'dev', 'fixtures', 'seed-workspace');
const SIDECAR = join(REPO, 'sidecar', 'index.js');

// Mock UI tests only need a label, but live audit uses this model for a real provider call.
export const DEFAULT_MODEL = process.env.SKYNET_DEFAULT_MODEL
  || process.env.STARNET_DEFAULT_MODEL
  || 'anthropic/claude-sonnet-4.6';
export const PLACEHOLDER_KEY = process.env.SKYNET_OPENROUTER_KEY || 'sk-or-shoot-placeholder';

// Copy the golden fixture into a fresh scratch dir and stamp a current timestamp + model so the
// server save wins the boot-time reconcile against any stale localStorage on the same port.
export function materializeSeedWorkspace(scratchDir, model = DEFAULT_MODEL) {
  if (!existsSync(FIXTURE)) throw new Error('seed fixture missing: ' + FIXTURE);
  if (existsSync(scratchDir)) rmSync(scratchDir, { recursive: true, force: true });
  mkdirSync(scratchDir, { recursive: true });
  cpSync(FIXTURE, scratchDir, { recursive: true });
  const now = Date.now();   // scripts may use Date.now(); the determinism rule is world.js-only
  try {
    const p = join(scratchDir, 'agent.save.json');
    const w = JSON.parse(readFileSync(p, 'utf8'));
    w.updatedAt = now; w.savedAt = now;
    if (w.doc) { w.doc.updatedAt = now; if (w.doc.agent) w.doc.agent.model = model || w.doc.agent.model || ''; }
    writeFileSync(p, JSON.stringify(w, null, 2));
  } catch {}
  try {
    const p = join(scratchDir, 'agent.roster.json');
    const r = JSON.parse(readFileSync(p, 'utf8'));
    for (const a of (r.agents || [])) a.model = model || a.model || '';
    writeFileSync(p, JSON.stringify(r, null, 2));
  } catch {}
  return scratchDir;
}

export async function isUp(url) { try { const r = await fetch(url); return r.ok; } catch { return false; } }

// Boot the sidecar in DEV SEED mode. Returns the child process (caller owns teardown).
// logFile (opt-in): write the sidecar's stdout+stderr to that file, so a boot that never comes up leaves a trace in
// the caller's evidence dir. It is truncated first: a reused --out dir must never show the previous run's tail as
// this boot's trace. Without it stdio stays 'ignore', exactly as every other caller has always had it.
export function bootSeededSidecar({ port, model = DEFAULT_MODEL, key = PLACEHOLDER_KEY, scratchDir, fullAccess = true, env: extraEnv = {}, logFile = '' }) {
  const env = {
    ...process.env,
    ...extraEnv,
    SKYNET_DEV: '1',
    SKYNET_WORKSPACES: scratchDir,
    SKYNET_PORT: String(port),
    SKYNET_DEFAULT_MODEL: model,
    SKYNET_OPENROUTER_KEY: key,
  };
  if (fullAccess) env.SKYNET_FULL_ACCESS = '1';
  else delete env.SKYNET_FULL_ACCESS;
  if (!logFile) return spawn(process.execPath, [SIDECAR], { cwd: REPO, env, stdio: 'ignore' });
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'w');
  try { return spawn(process.execPath, [SIDECAR], { cwd: REPO, env, stdio: ['ignore', fd, fd] }); }
  finally { closeSync(fd); }   // the child holds its own copy of the handle
}

export async function waitUp(url, tries = 60) {
  for (let i = 0; i < tries; i++) { if (await isUp(url)) return true; await sleep(500); }
  return false;
}

// In-game readiness signal: the dev hook is set AND #screen-game is the active screen. This is
// what defeats the cold-boot race (a fresh sidecar's FIRST page load can transiently show the
// title screen with dev=false). We poll, reloading periodically, until the floor is truly up.
export const READY_EXPR = `(() => { try {
  if (!window.__STARNET_DEV__) return false;
  const g = document.getElementById('screen-game');
  if (g && g.classList.contains('active')) return true;
  // fallback: dock visible and the title CTA is not
  const dock = document.getElementById('bottombar');
  const begin = document.getElementById('btn-begin');
  return !!(dock && dock.offsetParent !== null && !(begin && begin.offsetParent !== null));
} catch (e) { return false; } })()`;

export async function waitDevReady(cdp, evalJS, { tries = 24, url, reloadEvery = 5 } = {}) {
  for (let i = 0; i < tries; i++) {
    const ok = await evalJS(cdp, READY_EXPR).catch(() => false);
    if (ok) return true;
    if (url && reloadEvery && i > 0 && i % reloadEvery === 0) { try { await cdp.send('Page.navigate', { url }); } catch {} }
    await sleep(1000);
  }
  return false;
}
