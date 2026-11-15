/* Ends a headless Chrome a test started, waits for it to be gone, then removes its profile folder.

   WHY: the two Chrome tests used to kill only the parent process (child.kill('SIGKILL')) and then fail with EBUSY on
   chrome_debug.log AFTER passing (8e09831f6 FAST shard 1): Chrome's renderer and GPU processes outlived the parent
   and held the profile open.

   ORDER (each step only when the one before did not finish the job):
     1. CDP Browser.close over the connection the test already has. Chrome closes its own whole process tree.
     2. Wait up to graceMs (5 s) for the child's 'exit'.
     3. ONLY IF the child has still not exited (exitCode === null && signalCode === null), so its pid is still ours:
        win32  taskkill /PID <child.pid> /T /F     (the child's own tree, by its own pid)
        POSIX  process.kill(-pid, 'SIGKILL')       (the child's process group: the test spawns it detached)
        then wait for its 'exit' again.
     4. rmSync of the profile with retries, and the FINAL error is thrown, not swallowed: a leak stays visible.

   NEVER signal a pid after the child has exited, and NEVER find processes by walking ParentProcessId: Windows reuses
   pids, and a parent-id walk once killed an unrelated app on this machine (2026-10-31). */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

const alive = child => !!child && child.exitCode === null && child.signalCode === null;

export function killCommand(pid, platform) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) throw new Error('chrome-stop: refusing to signal pid ' + pid);
  if (platform === 'win32') return { cmd: 'taskkill', args: ['/PID', String(n), '/T', '/F'] };
  return { signalGroup: -n, signal: 'SIGKILL' };
}

function defaultKillTree(pid, platform) {
  const c = killCommand(pid, platform);
  if (c.cmd) spawnSync(c.cmd, c.args, { stdio: 'ignore', windowsHide: true });
  else {
    try { process.kill(c.signalGroup, c.signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }   // ESRCH: the group is already gone, which is the goal
  }
}

function waitForExit(child, ms) {
  return new Promise(done => {
    if (!alive(child)) { done(); return; }
    const timer = setTimeout(done, ms);
    child.once('exit', () => { clearTimeout(timer); done(); });
  });
}

/* Test options (all optional): platform, killTree(pid), beforeKill(), rm(path, options). */
export async function stopChrome({ child, cdp, profile, prefix, graceMs = 5000, platform = process.platform, killTree, beforeKill, rm = rmSync } = {}) {
  if (alive(child)) {
    // A refused or failed Browser.close is expected on some Chrome builds; step 3 is the answer to it.
    if (cdp) { try { await cdp.send('Browser.close'); } catch (error) { void error; } }
    await waitForExit(child, graceMs);
    if (beforeKill) beforeKill();
    if (alive(child)) {
      (killTree || (pid => defaultKillTree(pid, platform)))(child.pid);
      await waitForExit(child, graceMs);
    }
  }
  // Closing the websocket of a browser that is gone (or going) may throw; there is nothing left to tell.
  if (cdp && cdp.ws) { try { cdp.ws.close(); } catch (error) { void error; } }
  if (profile) {
    const rel = relative(resolve(tmpdir()), resolve(profile));
    if (!(rel && !rel.startsWith('..') && !isAbsolute(rel) && (!prefix || rel.startsWith(prefix)))) {
      throw new Error('chrome-stop: refusing to remove ' + profile + ' (not inside its own unique temp directory)');
    }
    rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
