'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const { sidecarFunctionSource } = require('./helpers/source');

const chat = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
const harness = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'harness.js'), 'utf8');

A.ok(/postconditions:\s*opts\s*&&\s*opts\.postconditions/.test(chat), 'chat forwards caller-authored typed postconditions');
A.ok(/reqBody\.postconditions\s*=\s*postconditions/.test(harness), 'harness sends the contract to the run host');
A.ok(/completionVerdict\s*=\s*payload\.completionVerdict/.test(harness), 'harness reads the host completion verdict');
A.ok(/effectVerdict\s*=\s*payload\.effectVerdict/.test(harness), 'harness reads the host effect verdict');
A.ok(/completionVerdict\s*!==\s*'completed_verified'/.test(chat), 'explicit contract fails closed unless the host says completed_verified');
A.ok(/VERIFICATION REQUIRED/.test(chat), 'unproved contracted work has a visible terminal state');
A.ok(/!postconditionUnmet\)\s*wiEmit\('workitem\.delivered'/.test(chat), 'unproved contracted work cannot emit delivery');
A.ok(/!cutShort\s*&&\s*!taskQuestion\s*&&\s*!postconditionUnmet/.test(chat), 'unproved contracted work cannot become rateable work');
// The browser's dormant opts.lineId executor was retired: COMMS is a direct order, and the
// actual /api/run host does not advance a line. Routine/LineRunner contract admission is separate.
A.ok(!/\b(?:runWorkLine|nextStageOf)\s*\(/.test(chat) && !/\/api\/routing\/chain/.test(harness)
  && !/lineRunner\.runLineJob\s*\(/.test(sidecarFunctionSource('handleRun')), 'COMMS has no downstream executor in the browser or its actual run handler');
A.ok(/verificationRequired:\s*postconditionUnmet/.test(chat), 'presence summary receives the truthful verification-required state');

A.report('task-postconditions-ui.test');
