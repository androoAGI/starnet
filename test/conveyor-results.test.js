/* test/conveyor-results.test.js — testing a line and reading its result (2026-09-27 first-run audit, lane 4).

   X1 — four "test" controls meant four different things: the one that runs no agent now says FREE, every one that runs agents
        says REAL, and the live INBOX's ONE REAL JOB runs the Commander's own test job (not "summarize this line").
   X3 — a step whose tool the consent gate refused showed "✓ finished"; the refusal is recorded on the hop and said.
   R1 — the VERDICT line (the loop gate's control signal) no longer ships as part of the work (see loop-verdict.test.js).
   R2 — the OUTBOX titled a line's result with the machine hand-off prompt; it now reads the ORIGINAL request.
   R3 — the live INBOX says SCHEDULE OFF (with the switch) instead of NO FEED when a schedule is saved but scheduling is off;
        the hover glance replaces the resting plate instead of stacking on it; the plate counts tests; a quick tour
        covering COMMS steps aside when the Commander clicks the INBOX. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const P = require('../frontend/app/pipeline.js');
const build = read('frontend/app/build.js'), panel = read('frontend/app/workflowpanel.js'), chat = read('frontend/app/chat.js');
const world = read('frontend/app/world.js'), outbox = read('frontend/app/windows/outbox.js'), dialogue = read('frontend/app/dialogue.js');

/* X1 */
// (2026-09-28: the four controls became ONE TEST control with modes — conveyor-retest.test.js pins the modes)
A.ok(/const PREVIEW_LABEL = '▶ TEST';/.test(build), 'the top bar has one TEST control');
A.ok(/\['watch', 'WATCH IT · FREE'/.test(panel) && /\['step', 'STEP THROUGH · REAL'/.test(panel), 'the free mode says FREE, the step-through says REAL');
A.ok(/'▶ SEND A REAL JOB'\) \+ '<\/button>'/.test(panel) && /'③ SEND A REAL JOB'/.test(build) && (chat.match(/'▸ SEND A REAL JOB'/g) || []).length === 2 && !/RUN ONE REAL JOB'/.test(panel + build + chat), 'every sample control says SEND A REAL JOB (org P17: one word set)');
A.ok(!/RUN A SAMPLE JOB/.test(panel + build + chat), 'the old "sample job" label is gone');
A.ok(/function testJobForProp\(propId\)/.test(build) && /testJobForProp, close,/.test(build), 'Build answers the test job saved for a prop’s line');
A.ok(/Build\.testJobForProp\(opts\.propId\)/.test(chat) && /job\.text \? \{ text: job\.text \}/.test(chat) && /job\.line \? \{ line: job\.line \}/.test(chat), 'the live INBOX card sends the Commander’s own test job, scoped to its line');

/* X3 */
A.ok(/name === 'agent\.tool_result' && p && p\.summary === 'denied'/.test(readSidecarSource()), 'the step test’s runner records consent-refused tools from the real tool_result event');
A.ok(/denied: Array\.isArray\(r\.denied\)/.test(read('sidecar/routing/steptest.js')), '…onto the hop');
A.ok(/function deniedLine\(h\)/.test(panel) && /\(deniedLine\(h\) \? '⚠ ' : '✓ '\)/.test(panel), 'the panel says ⚠ with the refused tools instead of a clean ✓');

/* R2 */
const t = P.handoffPrompt('Write the weekly newsletter.', 'writer', 'the draft', 1, 'be picky');
A.eq(P.parseHandoff(t), { stage: 2, original: 'Write the weekly newsletter.', from: 'writer' }, 'parseHandoff inverts handoffPrompt');
A.eq(P.parseHandoff('Write the weekly newsletter.'), null, 'an ordinary request is not a hand-off');
A.ok(/Pipeline\.parseHandoff\(users\[0\]\.content\)/.test(outbox) && /firstLine\(hand \? hand\.original : users\[0\]\.content, 64\)/.test(outbox), 'the OUTBOX titles a line result by the original request');
A.ok(/lineTitle \? 'work line result'/.test(outbox), '…and never shows the machine prompt as the provisional title');
const NL = String.fromCharCode(10);
A.eq(P.stripVerdictLine(['the post', '', 'VERDICT: approved'].join(NL)), 'the post', 'the OUTBOX shows a line result without its VERDICT control line');
A.eq(P.stripVerdictLine('VERDICT: approved'), 'VERDICT: approved', 'a reply that is only the verdict is left as it is');
A.ok(/Pipeline\.stripVerdictLine\(rawReply\)/.test(outbox), 'the OUTBOX strips it for a work line stage');

/* R3 */
A.ok(/const offJobs = \(cron && !cron\.enabled\) \? jobs\.filter\(j => j && j\.enabled !== false\)/.test(world) && /label: schedOffFor\(p\.id\) \? 'SCHEDULE OFF — CLICK' : 'NO FEED — CLICK'/.test(world), 'the INBOX says SCHEDULE OFF when that is what is missing (per line since the 2026-09-28 retest)');
A.ok(/if \(opts\.schedOff\) \{/.test(chat) && /Harness\.api\.post\('\/api\/cron\/arm', \{ enabled: true \}\)/.test(chat), 'the INBOX card carries the scheduling switch');
A.ok(/hoverPlate\.lineId === p\.lineId\) continue;/.test(world), 'the hover glance replaces the resting plate');
A.ok(/function yieldTour\(\)/.test(dialogue) && /Dialogue\.yieldTour\(\)/.test(chat), 'a quick tour covering COMMS steps aside for the INBOX card');
A.ok(/value: 'handoff', yield: true/.test(read('frontend/app/tutorial.js')), '…through the tour’s own way out');

A.report('conveyor-results.test');
