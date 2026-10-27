/* sidecar/parent-watch.js — a station never outlives the process that owns it.

   A station is started by an owner: the desktop shell (src-tauri main.rs sidecar_command) or the `starnet` terminal
   (bin/starnet.js spawnSidecar). Every graceful stop goes through that owner, but a HARD end of the owner — a crash,
   End Task, `taskkill /F`, `kill -9`, a closed terminal window — runs none of its stop code, and the station kept
   running as an orphan: it still held the workspace-owner claim, the Codex token file and the station browser, so
   the next launch met a busy workspace and a pile of node processes (#31: seven orphaned sidecars at once).

   On Windows the desktop shell already places the station in a kill-on-close Job Object (src-tauri
   process_job.rs), so the OS ends it with the shell. macOS and Linux have no such object, and a station the terminal
   booted is in no job at all. So the station watches its owner itself and runs its OWN graceful shutdown (release the
   claim, close the station browser, reap its children) the moment the owner is gone:
     · IPC — an owner that spawned the station with an ipc channel (the `starnet` terminal) is gone when the channel
       disconnects. Works on every OS, and a parent cannot vanish without closing it.
     · PID — the desktop shell names itself in STARNET_PARENT_PID (both spellings). The owner is gone when this
       process has been re-parented away from it (POSIX: launchd / init / a subreaper adopted it) or the OS says no
       such process (ESRCH). EPERM and every other error is a live owner: a watch that cannot prove the owner gone
       never stops the station.
   A STARNET_PARENT_PID that does not name this process's parent at start (an inherited variable) is ignored and
   says so; no owner named and no ipc channel = nothing to watch (`npm start`, a test harness): inert.

   makeParentWatch({ proc?, env?, platform?, intervalMs?, setInterval?, clearInterval?, onGone(reason) })
     -> { start() -> { watching: [...], ignored?: reason }, check() -> reason | null, stop() } */
'use strict';

const DEFAULT_INTERVAL_MS = 2000;

function envParentPid(env) {
  const raw = env && (env.STARNET_PARENT_PID != null && env.STARNET_PARENT_PID !== '' ? env.STARNET_PARENT_PID : env.SKYNET_PARENT_PID);
  const n = Number(String(raw == null ? '' : raw).trim());
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function makeParentWatch(deps) {
  const d = deps || {};
  const proc = d.proc || process;
  const env = d.env || proc.env || {};
  const platform = String(d.platform || proc.platform || '');
  const intervalMs = Number(d.intervalMs) > 0 ? Number(d.intervalMs) : DEFAULT_INTERVAL_MS;
  const setIntervalFn = d.setInterval || setInterval;
  const clearIntervalFn = d.clearInterval || clearInterval;
  const onGone = typeof d.onGone === 'function' ? d.onGone : function () {};
  let owner = 0, timer = null, fired = false, onDisconnect = null;

  function fire(reason) {
    if (fired) return;
    fired = true;
    stop();
    try { onGone(reason); } catch (_) {}
  }

  // the owner named by STARNET_PARENT_PID: gone only on proof
  function check() {
    if (!owner || fired) return null;
    const ppid = Number(proc.ppid) || 0;
    if (platform !== 'win32' && ppid && ppid !== owner) {
      return 'the StarNet app that started this station (pid ' + owner + ') is gone — this station was re-parented to pid ' + ppid;
    }
    try { proc.kill(owner, 0); }
    catch (e) {
      if (e && e.code === 'ESRCH') return 'the StarNet app that started this station (pid ' + owner + ') is gone';
    }
    return null;
  }

  function start() {
    const watching = [];
    let ignored = '';
    if (typeof proc.send === 'function' && typeof proc.on === 'function') {
      onDisconnect = function () { fire('the starnet terminal that started this station is gone (its ipc channel closed)'); };
      proc.on('disconnect', onDisconnect);
      watching.push('ipc');
    }
    const named = envParentPid(env);
    if (named) {
      const ppid = Number(proc.ppid) || 0;
      if (ppid && ppid === named) {
        owner = named;
        timer = setIntervalFn(function () { const why = check(); if (why) fire(why); }, intervalMs);
        if (timer && typeof timer.unref === 'function') timer.unref();   // the watch never keeps the station alive
        watching.push('pid ' + named);
      } else {
        ignored = 'STARNET_PARENT_PID=' + named + ' does not name this station\'s parent (pid ' + ppid + ') — not watched';
      }
    }
    return ignored ? { watching, ignored } : { watching };
  }

  function stop() {
    if (timer) { try { clearIntervalFn(timer); } catch (_) {} timer = null; }
    if (onDisconnect && typeof proc.removeListener === 'function') { try { proc.removeListener('disconnect', onDisconnect); } catch (_) {} }
    onDisconnect = null;
  }

  return { start, check, stop };
}

module.exports = { makeParentWatch, envParentPid, DEFAULT_INTERVAL_MS };
