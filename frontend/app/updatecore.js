/* AGENT OS updatecore.js
   Pure goal/loop planner for desktop updates. Browser wiring lives in updates.js;
   this file stays deterministic so the autonomous update loop has fast tests. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UpdateCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const RETRY_BASE_MS = 15 * 60 * 1000;
  const RETRY_MAX_MS = 6 * 60 * 60 * 1000;
  const REMIND_LATER_MS = 24 * 60 * 60 * 1000;
  // Opening the Update Center re-checks when the last check is older than this (or none ran this session):
  // "up to date" is only true as of a check, and a window that shows an hours-old answer as current lies.
  const OPEN_RECHECK_MS = 15 * 60 * 1000;

  function finite(n, fallback) {
    n = Number(n);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  function hydrateSettings(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    return {
      v: 1,
      autoCheck: raw.autoCheck !== false,
      lastCheckAt: finite(raw.lastCheckAt, 0),
      nextCheckAt: finite(raw.nextCheckAt, 0),
      remindAfter: finite(raw.remindAfter, 0),
      ignoredVersion: typeof raw.ignoredVersion === 'string' ? raw.ignoredVersion : '',
      notifiedVersion: typeof raw.notifiedVersion === 'string' ? raw.notifiedVersion : '',
      // The newer version the LAST successful check found ('' = none). The native pending update lives only in
      // memory, so a restart forgets it — this is what lets the next launch re-arm it instead of showing
      // "no update" for up to CHECK_INTERVAL_MS while the station already knew one exists (0.13.1 → 0.13.2 report).
      availableVersion: typeof raw.availableVersion === 'string' ? raw.availableVersion : '',
      failureCount: Math.max(0, raw.failureCount | 0)
    };
  }

  function due(settings, now) {
    settings = hydrateSettings(settings);
    return now >= (settings.nextCheckAt || 0);
  }

  function nextAction(input) {
    input = input || {};
    const settings = hydrateSettings(input.settings);
    const runtime = input.runtime || {};
    const now = finite(input.now, 0);
    const phase = runtime.phase || 'idle';

    if (!runtime.desktop) return { action: 'noop', reason: 'not-desktop' };
    if (settings.autoCheck === false) return { action: 'noop', reason: 'auto-disabled' };
    if (phase === 'checking' || phase === 'downloading' || phase === 'installing' || phase === 'restarting') {
      return { action: 'noop', reason: 'busy' };
    }
    if (runtime.hasUpdate && settings.remindAfter && now < settings.remindAfter) {
      return { action: 'noop', reason: 'waiting-reminder', nextAt: settings.remindAfter };
    }
    // Re-arming a remembered update must still honor a failed check's backoff, even after a restart.
    if (settings.failureCount > 0 && !due(settings, now)) {
      return { action: 'noop', reason: 'waiting-retry', nextAt: settings.nextCheckAt };
    }
    // A known newer version that this launch hasn't re-armed yet: check now, not after the interval. Not for the
    // version already running (the update landed) or one the Commander chose to skip.
    if (!runtime.hasUpdate && settings.availableVersion &&
        settings.availableVersion !== String(runtime.currentVersion || '') &&
        settings.availableVersion !== settings.ignoredVersion) {
      return { action: 'check', reason: 'known-update' };
    }
    if (!due(settings, now)) return { action: 'noop', reason: 'waiting-interval', nextAt: settings.nextCheckAt };
    return { action: 'check', reason: 'due' };
  }

  function recordCheckResult(settings, result, now) {
    const next = hydrateSettings(settings);
    now = finite(now, 0);
    const checkedAt = finite(result && result.checkedAt, now);
    next.lastCheckAt = checkedAt;
    next.nextCheckAt = checkedAt + CHECK_INTERVAL_MS;
    next.failureCount = 0;
    if (!(result && result.update)) next.remindAfter = 0;
    next.availableVersion = (result && result.update && result.update.version) ? String(result.update.version) : '';
    return next;
  }

  function recordCheckError(settings, now) {
    const next = hydrateSettings(settings);
    now = finite(now, 0);
    next.failureCount += 1;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, next.failureCount - 1));
    next.nextCheckAt = now + delay;
    return next;
  }

  function shouldNotify(settings, version, now, critical) {
    settings = hydrateSettings(settings);
    version = String(version || '');
    now = finite(now, 0);
    if (!version) return false;
    if (!critical && settings.ignoredVersion === version) return false;
    if (!critical && settings.remindAfter && now < settings.remindAfter) return false;
    return settings.notifiedVersion !== version;
  }

  function recordNotified(settings, version) {
    const next = hydrateSettings(settings);
    next.notifiedVersion = String(version || '');
    return next;
  }

  function remindLater(settings, version, now, delayMs) {
    const next = hydrateSettings(settings);
    next.remindAfter = finite(now, 0) + finite(delayMs, REMIND_LATER_MS);
    if (version && next.notifiedVersion === String(version)) next.notifiedVersion = '';
    return next;
  }

  function ignoreVersion(settings, version) {
    const next = hydrateSettings(settings);
    next.ignoredVersion = String(version || '');
    return next;
  }

  function setAutoCheck(settings, on, now) {
    const next = hydrateSettings(settings);
    next.autoCheck = !!on;
    if (on && !next.nextCheckAt) next.nextCheckAt = finite(now, 0);
    return next;
  }

  // GB-4: installing restarts the app (NSIS even kills it), which terminates every live
  // provider stream mid-run. Killing N working agents must be an EXPLICIT choice, never a
  // side effect of clicking INSTALL. Returns null when installing is fine, else the
  // human-readable reason to pause. `force` = the user already confirmed "install anyway".
  function installBlockReason(busyCount, force) {
    busyCount = Math.max(0, busyCount | 0);
    if (force || !busyCount) return null;
    return busyCount === 1
      ? '1 agent is still working - installing now would kill its run'
      : busyCount + ' agents are still working - installing now would kill their runs';
  }

  // Opening the Update Center: check unless a check already ran this session within OPEN_RECHECK_MS.
  // sessionCheckAt is in-memory (0 = none this launch) — a persisted lastCheckAt from a previous run never counts.
  function shouldCheckOnOpen(sessionCheckAt, now) {
    sessionCheckAt = finite(sessionCheckAt, 0);
    if (!sessionCheckAt) return true;
    return finite(now, 0) - sessionCheckAt >= OPEN_RECHECK_MS;
  }

  function progress(downloaded, contentLength) {
    downloaded = finite(downloaded, 0);
    contentLength = finite(contentLength, 0);
    if (!contentLength) return 0;
    return Math.max(0, Math.min(100, Math.round((downloaded / contentLength) * 100)));
  }

  return {
    CHECK_INTERVAL_MS, RETRY_BASE_MS, RETRY_MAX_MS, REMIND_LATER_MS, OPEN_RECHECK_MS,
    hydrateSettings, due, nextAction, recordCheckResult, recordCheckError, shouldCheckOnOpen,
    shouldNotify, recordNotified, remindLater, ignoreVersion, setAutoCheck, progress,
    installBlockReason
  };
});
