'use strict';
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { watchDesktopParent } = require('../sidecar/desktop-parent.js');

(async () => {
  let parent = 42;
  let stopped = 0;
  const options = { platform: 'linux', getParentPid: () => parent,
    shutdown: () => stopped++, intervalMs: 5 };
  for (const parentPid of [undefined, '', 'bad', '1', '0', '-1', '2.5', '9007199254740992']) {
    assert.equal(watchDesktopParent({ ...options, parentPid }), null);
  }
  assert.equal(watchDesktopParent({ ...options, parentPid: '42', platform: 'darwin' }), null);
  const timer = watchDesktopParent({ ...options, parentPid: '42' });
  try {
    assert.equal(timer.hasRef(), false, 'watcher cannot keep an otherwise finished process alive');
    await delay(30);
    assert.equal(stopped, 0, 'live desktop parent is retained');
    parent = 1;
    await delay(30);
    assert.equal(stopped, 1, 'reparenting shuts down once');
    await delay(30);
    assert.equal(stopped, 1, 'shutdown is not repeatedly invoked');
  } finally { clearInterval(timer); }
  // Also catch the shell dying before the watcher was installed.
  const early = watchDesktopParent({ ...options, parentPid: '42' });
  try { await delay(30); assert.equal(stopped, 2); }
  finally { clearInterval(early); }
  console.log('desktop parent tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
