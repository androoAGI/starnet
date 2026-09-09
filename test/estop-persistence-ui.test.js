/* Legacy stop-only hotkey stays retired. Explicit state-backed recovery is owner-authorized.
   Per-conversation Stop and the backend halt receipt remain separate capabilities. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('frontend/index.html');
const chat = read('frontend/app/chat.js');
const harness = read('frontend/app/harness.js');
A.ok(!/id="estop-btn"|app\/safety\.js|Alt\+H/.test(html), 'legacy stop-only control and hotkey remain retired');
A.ok(html.includes('app/emergency-control.js') && !html.includes('id="automation-stop-toggle"') && !html.includes('id="automation-stop-retry"') && html.includes('id="automation-resume"'), 'global stop actions are removed; legacy saved pauses retain discoverable recovery');
A.ok(!fs.existsSync(path.join(root, 'frontend/app/safety.js')), 'the retired global hotkey handler is removed');
A.ok(/id="chat-stop"/.test(html) && /function stopActive\(/.test(chat), 'COMMS keeps its per-conversation Stop control');
for (const field of ['nightshiftHaltPersisted', 'cronHaltPersisted', 'loopsHaltPersisted']) {
  A.ok(harness.includes(field + ': j.' + field), 'backend halt receipt still preserves ' + field);
}
A.ok(/halted:\s*n\('halted'\) \+ n\('cronAborted'\) \+ n\('beatAborted'\)/.test(harness), 'backend receipts retain real abort counts');
const { friendlyError } = require('../frontend/app/friendlyerror.js');
const message = friendlyError(new Error('That agent is already running a task. Wait, or press E-STOP to stop everything.'));
A.ok(!/E-STOP|Alt\+H/.test(message.userMessage), 'errors do not direct users to the removed control');
A.report('estop-persistence-ui.test');
