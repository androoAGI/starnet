/* node test/hop-resume-seed.test.js — A HOP IS NOT A RESUME (token-burn audit 2026-10-17).

   runOnceCore's H1.2 resume seed prepends a stream's last 100 transcript rows to any run that arrives with one message
   and a streamId. Every work-line hop has exactly that shape, so each stage was re-sent the earlier stages' tool calls
   and results as its own past turns, on top of a handoff that already carries the upstream output (owner's station:
   median 64 KB, p90 205 KB per hop, on every turn of the hop). Each hop runner opts out with resumeSeed:false.

   cron.run-now.e2e proves one runner on the wire; this source lock pins EVERY runner in the fast gate, so deleting one
   opt-out (or the guard that reads it) goes red before merge. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
// the host's runners wherever they live; the hub's own opt-out is counted on its own below
const idx = readSidecarSource({ except: ['sidecar/channels/hub.js'] });
const hub = read('sidecar/channels/hub.js');
const count = (s, needle) => s.split(needle).length - 1;

// the guards: the resume seed and the queued-turn re-seed both honor the opt-out
A.ok(/!o\.recovery && !o\.groupTools && !internal && o\.resumeSeed !== false && streamId && Array\.isArray\(messages\)/.test(idx),
  'runOnceCore: the resume seed skips a run that opted out (resumeSeed:false)');
A.ok(/if \(queued && o\.resumeSeed !== false && !o\.recovery/.test(idx), 'a queued turn is not re-seeded from the stream when it opted out');

// the runners: two cron / Run Now line drivers + the step test (index.js), and the channel / trigger / SEND TO hub (hub.js)
A.eq(count(idx, 'resumeSeed: false,'), 3, 'index.js: both line drivers and the step-test runner opt their hops out');
A.ok(/streamId: o\.streamId, parallelBranch: !!h\.parallel,[^\n]*\n\s*resumeSeed: false,/.test(idx), 'the scheduled fire line driver (cron-driver advanceChain, stream = the fire) opts out');
A.ok(/streamId: 'cron-' \+ runId, parallelBranch: !!h\.parallel,[^\n]*\n\s*resumeSeed: false,/.test(idx), 'the Run Now line driver opts out');
A.ok(/streamId: h\.streamId,\n\s*resumeSeed: false,/.test(idx), 'the step-test runner opts out (one stream shared by every step)');
A.eq(count(hub, 'resumeSeed: false,'), 1, 'hub.js: the channel / trigger / SEND TO hop opts out (its dock history rides `hist`)');
A.ok(/streamId: canonicalStreamId \|\| undefined, parallelBranch: !!h\.parallel,[^\n]*\n\s*resumeSeed: false,/.test(hub), 'the hub hop opt-out sits on the hop runOnce');

A.report('hop-resume-seed.test');
