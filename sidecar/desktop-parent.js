'use strict';

// Linux reparents a child when its desktop shell dies, including when an AppImage
// mount disappears. Checking ppid avoids killing by executable name or a reused PID.
function watchDesktopParent({ parentPid, platform = process.platform,
  getParentPid = () => process.ppid, shutdown, intervalMs = 1000 }) {
  if (platform !== 'linux' || !/^[1-9]\d*$/.test(String(parentPid || ''))
      || !Number.isSafeInteger(Number(parentPid)) || Number(parentPid) <= 1) return null;
  const expected = Number(parentPid);
  const timer = setInterval(() => {
    if (getParentPid() === expected) return;
    clearInterval(timer);
    shutdown('desktop parent exited');
  }, intervalMs);
  timer.unref();
  return timer;
}

module.exports = { watchDesktopParent };
