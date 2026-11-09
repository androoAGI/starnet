/* test/helpers/learning-windows.js — boot a hermetic sidecar with every LEARNING-PASS window at 0.

   Since W1.4 (sidecar/learning-cooldown.js) every ATTEMPT of reflection, failure review, study or thread mining arms
   that pass's window, whatever it kept; before it, a pass that kept nothing (the mocks' NONE) armed nothing, so it fired
   again after every eligible run. A test whose proof READS those passes across several quick runs of one agent (a
   leak check over every upstream body, a payer check over every call, "the ceiling stopped them") boots with every
   window at 0 here, so each eligible run still reaches its own passes, and adds a positive check that they ran.

   The windows are read from memory.config.json when the sidecar boots (POST /api/memory/config takes reflectCooldownMs
   only, not study's or failure review's); thread mining's is an env knob. Write before the first start. */
'use strict';
const fs = require('fs');
const path = require('path');

// memory.config.json in the fixture's workspace (SKYNET_WORKSPACES): the three persisted windows at 0, plus `extra`
function zeroLearningWindows(workspace, extra) {
  fs.writeFileSync(path.join(workspace, 'memory.config.json'),
    JSON.stringify(Object.assign({ version: 1, reflectCooldownMs: 0, studyCooldownMs: 0, failureReviewCooldownMs: 0 }, extra || {})));
}
// thread mining's window (env, read once at boot): spread into the fixture's env
const THREAD_MINE_WINDOW_ZERO = Object.freeze({ STARNET_THREAD_MINE_COOLDOWN_MS: '0', SKYNET_THREAD_MINE_COOLDOWN_MS: '0' });

module.exports = { zeroLearningWindows, THREAD_MINE_WINDOW_ZERO };
