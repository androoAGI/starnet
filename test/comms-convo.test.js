/* node test/comms-convo.test.js — REGRESSION LOCK for "COMMS as a conversation" (Andrew 10-03: "hard to read …
   everythings clustered all together, hard to see when you sent things … clean, nice and conversational", and
   "it still needs that terminal, tron, fallout pip boy aesthetic please, but clean").

   chat.js is browser-flow, so — like comms-presence.test.js — the DOM-layer invariants are locked by reading the
   source; the one pure formatter (fmtBreak) is lifted out and executed. The live proof is dev/comms-convo-shots.mjs. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../frontend/css/comms-convo.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');

/* ---------- 1. the empty trophy box: a folded trophy never leaves a fresh empty block behind ---------- */
const rb = src.match(/function renderBroadcast\(text, opts\) \{[\s\S]*?\n  \}\n/);
A.ok(!!rb, 'renderBroadcast found');
if (rb) {
  const body = rb[0];
  const foldReturn = body.indexOf("prevLine.appendChild(document.createTextNode(' (see GROWTH)'))");
  const blockOpen = body.indexOf("d.className = 'cmsg broadcast'");
  A.ok(foldReturn > 0 && blockOpen > foldReturn, 'the broadcast block is opened only AFTER the trophy-fold early return');
}

/* ---------- 2. stamps: every stamped row carries its real time; repeats + time breaks read only real stamps ---------- */
A.ok(/d\.dataset\.ts\s*=\s*String\(at\.getTime\(\)\)/.test(src), 'a stamped row records its real time (data-ts)');
A.ok(/timeBreak\(at\)/.test(src), 'row() asks for a time break before a stamped row');
A.ok(/const TIME_BREAK_MS = 30 \* 60 \* 1000;/.test(src), 'a 30-minute silence opens a time break');
A.ok(/classList\.add\('ts-repeat'\)/.test(src), 'a same-minute follow-up is marked ts-repeat');

const fb = src.match(/function fmtBreak\(at\) \{[\s\S]*?\n  \}\n/);
A.ok(!!fb, 'fmtBreak found');
if (fb) {
  const CLOCK_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtBreak = new Function('CLOCK_MONTHS', fb[0] + '\nreturn fmtBreak;')(CLOCK_MONTHS);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 15, 42);
  A.eq(fmtBreak(today), 'Today · 3:42 PM', 'today reads as Today + a 12-hour clock');
  // The calendar day before, not 24 hours before: on a clock-change day those are different wall-clock times.
  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 15, 42);
  A.eq(fmtBreak(yest), 'Yesterday · 3:42 PM', 'yesterday names itself');
  // A fixed January date: some zones change their clocks at midnight, and on that day 00:05 today does not exist.
  const morning = new Date(now.getFullYear() - 1, 0, 9, 0, 5);
  A.eq(fmtBreak(morning), 'Jan 9, ' + (now.getFullYear() - 1) + ' · 12:05 AM', 'midnight hour is 12, never 0 (no military time)');
  const old = new Date(now.getFullYear() - 1, 0, 9, 13, 0);
  A.eq(fmtBreak(old), 'Jan 9, ' + (now.getFullYear() - 1) + ' · 1:00 PM', 'another year carries its year');
}

/* ---------- 3. the run summary is the reply's footer, never wedged between question and answer ---------- */
A.ok(/settleSummaryUnderReply\(card\);\s*autoscroll\(\);\s*\}/.test(src), 'resolvePresence settles the summary under the reply');
const ss = src.match(/function settleSummaryUnderReply\(card\) \{[\s\S]*?\n  \}\n/);
A.ok(!!ss, 'settleSummaryUnderReply found');
if (ss) {
  A.ok(/classList\.contains\('user'\)\) break/.test(ss[0]), 'the settle walk stops at the next Commander turn');
  A.ok(/if \(fold\) card\.after\(fold\)/.test(ss[0]), 'the fold travels with its summary (hydrateRunTelemetry reads card.nextElementSibling)');
}

/* ---------- 4. the layer: loaded last, terminal vocabulary, theme tokens only ---------- */
const iPip = html.indexOf('css/pipglass.css'), iConvo = html.indexOf('css/comms-convo.css');
A.ok(iConvo > iPip && iPip > 0, 'comms-convo.css loads after pipglass.css');
A.ok(!/border-radius:\s*(999px|50%|[1-9]\d+px)/.test(css), 'no pills or round bubbles — crisp 4px terminal corners only');
A.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'no hardcoded hex colours — theme tokens only');
A.ok(/\.cmsg:is\(\.agent, \.user\) \.cmsg-ts \{ opacity: \.62/.test(css), 'stamps are visible at rest, not hover-only');

/* ---------- 5. the standalone rate ask is a slim inline row, not a big centered card (Andrew 10-03) ---------- */
A.ok(/r\.d\.classList\.add\('rate-inline'\)/.test(src), 'workRateBeat marks the standalone ask .rate-inline');
A.ok(/\.cmsg\.work-rate\.rate-inline \{[^}]*border: 0;[^}]*background: none;/.test(css), 'the inline rate row has no card frame');
A.ok(/\.rate-inline \.work-rate-reference \{ display: none; \}/.test(css), 'the task · run reference rides the hover tip, not a printed line');

/* ---------- 6. no text boxes (Andrew 10-03: "idk if im a fan of the text boxes … terminal ASCII aesthetic") ---------- */
A.ok(/\.cmsg\.user > \.body \{[^}]*border: 0; border-right: 2px solid/.test(css), 'the Commander turn is a rail + prompt, not an outlined plate');
A.ok(/\.cmsg\.user > \.body::before \{ content: '> '/.test(css), 'the Commander turn opens with a > prompt');
A.ok(/\.cmsg\.broadcast \.bc-line \{[^}]*border: 0;[^}]*background: none;/.test(css), 'station lines are ruled ASCII lines, not boxed tags');
A.ok(/\.choice-row \.choice::before \{ content: '\[ '/.test(css), 'choices are [ bracketed ] terminal keys');

/* ---------- 7. the agent's line mirrors the Commander's: name as is, no portrait (Andrew 10-03: "without the pfp") ---------- */
A.ok(!/agentFace|cmsg-face/.test(src) && !/cmsg-face/.test(css), 'no portrait beside the agent callsign');
A.ok(/:not\(\.deliverable\) > \.body \{[^}]*border-left: 2px solid/.test(css), 'the agent text rides a phosphor rail (the Commander line, mirrored)');

/* ---------- 8. a light dither field, not a fade (10-04: "a different approach then the fade" → "make variant 4 a bit
   lighter on the text boxes") ---------- */
A.ok(!/linear-gradient\((90|270)deg/.test(css), 'no fading fields behind speech');
A.ok(/repeating-conic-gradient\(var\(--dot\) 0 25%, transparent 0 50%\) 0 0 \/ 2px 2px/.test(css), 'speech sits on a 1px ordered-dither field (pipglass lit-row material)');
const dots = [...css.matchAll(/--dot: rgba\(var\(--(?:ph|gold)-rgb\), (\.\d+)\)/g)].map(m => +m[1]);
A.ok(dots.length === 2 && dots.every(a => a <= .06), 'the dither stays LIGHT (cell alpha ≤ .06), lighter than the shot variant (.075/.09)');

/* ---------- 9. no hover glow on the agent's message (Andrew 10-04) ---------- */
A.ok(!/:not\(\.deliverable\):is\(:hover, :focus-within\) > \.body \{[^}]*--rail/.test(css), 'hovering an agent message never lights its rail');
A.ok(!/\.cmsg\.user:is\(:hover, :focus-within\) > \.body \{[^}]*(--rail|border-right-color)/.test(css), "hovering the Commander's message never lights its gold rail");

A.report('comms-convo.test');
