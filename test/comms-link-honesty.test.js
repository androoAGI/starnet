/* node test/comms-link-honesty.test.js — source-lock for the COMMS status bar's LINK HONESTY (adversarial
   sweep 2026-07-14, F2) and the run routes' disconnect seam (F1).

   F2: SIGKILL the sidecar under a live page → #chat-status kept asserting `online` INDEFINITELY (observed
   1m49s, unbounded) while same-origin fetches failed — connectivity the harness, being dead, provably could
   not back. The fix folds the idle claim on World.linkState() (the E1 bridge-health predicate the topbar
   #sig and the canvas LINK DOWN marker already read): a genuinely bridged-but-dead link reads
   `station unreachable` in the fault palette, re-derived on the same 3s cadence topbar repaints #sig.

   F1: Node ≥15 emits IncomingMessage 'close' at MESSAGE COMPLETION, so a run route that reads its body and
   THEN attaches req.on('close') attaches after the event has already fired — the disconnect cleanup is dead
   code and a vanished watcher leaves the run spending unwatched (behavioral proof: e2e.run.test.js F1 block).
   Lock here that the three run routes listen on the RESPONSE's 'close'.

   chat.js is browser-flow (DOM + streaming), not node-loadable, so — like chat-runmeta.test.js — the
   invariants are locked by reading the source. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const chatSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(__dirname, '../frontend/css/app.css'), 'utf8');
const sidecarSrc = fs.readFileSync(path.join(__dirname, '../sidecar/index.js'), 'utf8');

// ---- F2: the idle status claim folds the real bridge health ----
// syncStatus consults World.linkState() and only downgrades a genuinely bridged-but-dead link
// (never pre-entry, never a deliberate pause) — the same guard discipline as topbar.paintSig.
A.ok(/World\.linkState\s*\(\)/.test(chatSrc), 'chat.js reads World.linkState() (the E1 bridge-health predicate)');
A.ok(/ls\.bridged\s*&&\s*!ls\.paused\s*&&\s*ls\.down/.test(chatSrc), 'only a bridged-but-dead link downgrades (pre-entry / deliberate pause never false-alarm)');
// the downgraded claim is the honest one, and it can never mask live run-state (busy/approval win the ternary).
A.ok(/down\s*\?\s*'station unreachable'\s*:\s*'online'/.test(chatSrc), "the idle claim is 'station unreachable' when the link is provably dead — 'online' only when it isn't");
// the status classifier maps the downgraded label onto a distinct fault class.
A.ok(/unreachable[^:]*\?\s*'status-down'/.test(chatSrc), "status() maps 'unreachable' onto the status-down class");
A.ok(/'status-online'\s*,\s*'status-down'/.test(chatSrc) || /'status-down'\s*,\s*'status-online'/.test(chatSrc) || /status-down/.test(chatSrc.match(/statusEl\.classList\.remove\([^)]*\)/)[0]), 'status-down is in the class reset list (no sticky fault paint)');
// a link that dies with NO run in flight still gets noticed: the once-armed idle re-derive interval.
A.ok(/__chatLinkStatusTimer/.test(chatSrc) && /setInterval\([\s\S]{0,120}?syncStatus/.test(chatSrc), 'an idle re-derive interval re-checks the link (a dead sidecar flips the label without any run event)');
// the fault palette exists and matches the LINK DOWN family (#ff6a4c).
A.ok(/#chat-status\.status-down\s*\{[^}]*#ff6a4c/i.test(cssSrc), 'app.css paints status-down in the LINK DOWN fault palette');

// ---- F1: the run routes' disconnect seam is the RESPONSE 'close' (req 'close' is dead after readBody) ----
const streamSrc = fs.readFileSync(path.join(__dirname, '../sidecar/remote-runtime.js'), 'utf8');
const streamSites = (sidecarSrc.match(/remoteRuntime\.makeRunStream\(/g) || []).length;
A.eq(streamSites, 2, 'handleRun and handleCronRun use the shared response-close lifecycle');
A.ok(/res\.once\('close', detach\)/.test(streamSrc), 'shared stream listens to RESPONSE close');
A.ok(/if \(!persistent\) controller\.abort\(\)/.test(streamSrc), 'local response closure still cancels; explicit remote ownership keeps work running');
A.ok(/res\.on\('close',\s*onClose\)/.test(sidecarSrc), 'the nightshift beat route aborts on the RESPONSE close too');
// the trap itself must not come back: no run route may attach its abort cleanup to req 'close'.
A.ok(!/req\.on\('close',\s*\(\)\s*=>\s*\{\s*ac\.abort\(\)/.test(sidecarSrc), "no route attaches ac.abort() to req 'close' (fires at message completion on Node >=15 — a dead seam after readBody)");

A.report('comms-link-honesty.test');
