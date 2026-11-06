/* node test/comms-stop-queue-tips.test.js — org(P27): the COMMS stop key and the queued pill say what they DO.
   In a group ■ is stop-all (GroupChat.stop → every agent), so its tip and aria-label say so; a direct chat keeps
   "Stop the running turn". A queued ⤷ pill sends after the run (it is not a mid-run edit) and /steer is the way to
   change the running task. Both tips are data-tip (the station card), never a native title. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('frontend/index.html');
const chat = read('frontend/app/chat.js');

const stopTag = (html.match(/<button id="chat-stop"[^>]*>/) || [''])[0];
A.ok(stopTag, 'COMMS keeps its stop key');
A.ok(!/\stitle=/.test(stopTag), 'the stop key carries no native title (OS tooltip)');
A.ok(/data-tip="Stop the running turn \(Esc\)"/.test(stopTag), 'a direct chat keeps today\'s stop wording as a data-tip');

const uc = chat.slice(chat.indexOf('function updateControls()'), chat.indexOf('function updateControls()') + 900);
A.ok(/conversationMode === 'group'/.test(uc), 'updateControls reads whether the open chat is a group');
A.ok(uc.includes("'Stop every agent in this chat (Esc)'") && uc.includes("'Stop every agent in this chat'"), 'a group stop key says it stops every agent (tip + aria-label)');
A.ok(uc.includes("'Stop the running turn (Esc)'") && uc.includes("'Stop the running turn'"), 'a direct chat stop key keeps its wording');
A.ok(/GroupChat\.stop\(\)/.test(chat.slice(chat.indexOf('function stopActive('), chat.indexOf('function stopActive(') + 600)), 'the group wording matches what stopActive does (GroupChat.stop = stop-all)');

// the whole function body (a fixed-length slice broke when the live-walk queue comment grew the function's head)
const rq = chat.slice(chat.indexOf('function renderQueued()'), chat.indexOf('function flushQueued('));
A.ok(!/pill\.title\s*=/.test(rq), 'the queued pill no longer uses a native title');
A.ok(rq.includes("const QHINT = 'waiting for delivery · joins the running task at its next step'"), 'the queued pill tip says it waits for delivery and joins the running task at its next step (auto-steer: no send-now pill)');
{
  // run the tip line for real: the clipped pill's whole message is readable in its tip, and the hint always survives the cap
  const line = rq.slice(rq.indexOf('      const QHINT'), rq.indexOf("const label = document.createElement('span')"));
  const tipOf = t => { let tip = null; const pill = { setAttribute: (k, v) => { if (k === 'data-tip') tip = v; } }; new Function('pill', 't', line)(pill, t); return tip; };
  const long = 'please also rewrite the onboarding copy so it matches the new pricing page and keep it short';
  A.eq(tipOf(long), '“' + long + '” · waiting for delivery · joins the running task at its next step', 'the tip carries the full queued text the pill clips (it was the native title before)');
  const huge = 'x'.repeat(2000), ht = tipOf(huge);
  A.ok(ht.length <= 400 && /…” · waiting for delivery · joins the running task at its next step$/.test(ht), 'a message past the tip cap gives way, never the hint (tooltip.js keeps 400 chars)');
}
A.ok(/['"]\/steer['"]|\/steer\b/.test(chat.slice(chat.indexOf('SLASH COMMANDS'))), '/steer still exists, so the tip points at a real command');
A.report('comms-stop-queue-tips.test');
