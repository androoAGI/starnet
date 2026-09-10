import { spawn } from 'node:child_process';

export const DEFAULT_TIMEOUT_MS = Math.max(1000, Number(process.env.STARNET_COMMAND_TIMEOUT_MS || 600000) || 600000);

export function coerceTimeoutMs(value, fallback = DEFAULT_TIMEOUT_MS) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.max(1000, Math.floor(n)) : fallback;
}

// Gate runners must allow the HTTP child's 20-minute watchdog plus teardown.
// Explicit runner overrides retain authority; other npm gates keep 15 minutes.
export function npmGateTimeoutMs(script, override) {
  return coerceTimeoutMs(override || (script === 'test:http' ? 1260000 : 900000));
}

export function normalizeCommand(cmd) {
  if (process.platform !== 'win32') return cmd;
  if (cmd === 'npm') return 'npm.cmd';
  if (cmd === 'node') return process.execPath;
  return cmd;
}

function killProcessTree(pid) {
  return new Promise(resolve => {
    if (!pid) return resolve();
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => resolve());
      killer.on('close', () => resolve());
      return;
    }
    try { process.kill(-pid, 'SIGTERM'); } catch (_) {
      try { process.kill(pid, 'SIGTERM'); } catch (_) {}
    }
    setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); } catch (_) {
        try { process.kill(pid, 'SIGKILL'); } catch (_) {}
      }
      resolve();
    }, 1500).unref?.();
  });
}

export async function runBoundedCommand(options) {
  const cmd = normalizeCommand(options.cmd);
  const args = options.args || [];
  const timeoutMs = coerceTimeoutMs(options.timeoutMs);
  const label = options.label || [cmd].concat(args).join(' ');
  const started = Date.now();
  let output = '';
  let timedOut = false;

  return await new Promise(resolve => {
    let finished = false;
    let fallbackTimer = null;
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)
    });

    const done = exitCode => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      resolve({
        exitCode: timedOut ? 124 : (exitCode == null ? 1 : exitCode),
        timedOut,
        durationMs: Date.now() - started,
        output
      });
    };

    const timer = setTimeout(async () => {
      timedOut = true;
      const message = '\n[timeout] ' + label + ' exceeded ' + timeoutMs + 'ms; terminating process tree.\n';
      output += message;
      if (options.inherit) process.stderr.write(message);
      await killProcessTree(child.pid);
      fallbackTimer = setTimeout(() => done(124), 3000);
      fallbackTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', d => {
      const s = d.toString();
      output += s;
      if (options.inherit) process.stdout.write(s);
    });
    child.stderr.on('data', d => {
      const s = d.toString();
      output += s;
      if (options.inherit) process.stderr.write(s);
    });
    child.on('error', e => {
      output += '\n[spawn error] ' + ((e && e.message) || e) + '\n';
      done(127);
    });
    child.on('close', code => done(code));
  });
}
