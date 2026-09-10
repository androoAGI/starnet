/* node test/worker-iteration-cap.test.js — source-lock for the DELEGATED-WORKER iteration ceiling.

   The bug this locks: orchestration.js has always computed `workerMaxIters` and passed it to runOnce as
   `maxIters:`, but runOnce NEVER READ `o.maxIters` — the only assignment was a hardcoded
   `limits: { maxIters: CAPS.maxIters }`. The host also never supplied `workerMaxIters`, so the dep fell to
   its literal default and was then discarded anyway. Net effect: every delegated worker ran the LEAD's full
   turn budget instead of its own smaller one. The per-worker USD cap (o.maxCostUsd) was honored the whole
   time, so spend stayed bounded and nothing looked wrong.

   Why the existing coverage missed it: test/orchestration.test.js asserts `ro.calls[0].maxIters` against a
   FAKE runOnce. That proves the PRODUCER passes the value and is a correct test of orchestration.js — but it
   is structurally incapable of noticing that the real CONSUMER ignores it. Producer and consumer each passed
   alone; the seam between them was untested. (Same shape as the servicekeys/environment/shell seam:
   "when two modules each pass alone, test the COMPOSITION".)

   sidecar/index.js boots a server on require, so — following test/harness-internal.test.js, which locks a
   sidecar invariant the same way — this is a SOURCE-LOCK, not a behavioural proof. It asserts the wire is
   connected at both ends and that the clamp is one-directional. The producer half stays behaviourally
   covered by test/orchestration.test.js. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const sidecar = fs.readFileSync(path.join(__dirname, '../sidecar/index.js'), 'utf8');
const orch = fs.readFileSync(path.join(__dirname, '../sidecar/tools/builtin/orchestration.js'), 'utf8');

// --- PRODUCER half: orchestration.js still computes and sends a per-worker ceiling ---
A.ok(/workerMaxIters/.test(orch), 'orchestration.js still computes a per-worker iteration ceiling');
A.ok(/const\s+workerMaxIters[\s\S]{0,220}:\s*0;/.test(orch),
  'orchestration.js defaults the delegated-worker ceiling off');
A.ok(/maxIters:\s*bounded\s*\?\s*lowerPositive\(workerMaxIters,\s*bounded\.workerMaxIters\)\s*:\s*workerMaxIters/.test(orch),
  'orchestration.js passes the ordinary worker ceiling and only lowers it for a task-specific bound');

// --- HOST half 1: the station actually SUPPLIES workerMaxIters (it previously never did) ---
A.ok(/const\s+ORCH_WORKER_MAX_ITERS\s*=/.test(sidecar),
  'index.js defines a per-worker iteration knob');
A.ok(/workerMaxIters:\s*ORCH_WORKER_MAX_ITERS/.test(sidecar),
  'index.js passes workerMaxIters into makeOrchestrationTools (the dep was previously never supplied)');

// --- HOST half 2: runOnce CONSUMES o.maxIters, and only ever downward ---
A.ok(/const\s+runMaxIters\s*=/.test(sidecar), 'runOnce computes a per-run iteration ceiling');
A.ok(/o\.maxIters/.test(sidecar), 'runOnce reads the caller-supplied o.maxIters (it previously never did)');
A.ok(/Math\.min\(Math\.floor\(o\.maxIters\),\s*stationMaxIters\)/.test(sidecar),
  'the caller cap is clamped against the station policy — a caller may LOWER but never RAISE an explicit ceiling');

// --- HOST half 3: ordinary runs use the computed cap; repair may only lower it to one.
// Actual one-generation/no-mutation behavior is covered by output-only-repair.e2e.test.js. ---
A.ok(/limits:\s*\{\s*maxIters:\s*(?:o\.outputOnly\s*\?\s*1\s*:\s*)?runMaxIters/.test(sidecar),
  'ordinary runs use runMaxIters; only output-only repair may lower it to one');
A.ok(!/limits:\s*\{\s*maxIters:\s*CAPS\.maxIters\s*,/.test(sidecar),
  'the old hardcoded limits.maxIters = CAPS.maxIters assignment is gone (that line WAS the bug)');

// --- the default path is unlimited: an ordinary run supplies no o.maxIters and inherits stationMaxIters ---
A.ok(/:\s*stationMaxIters\s*;/.test(sidecar),
  'runMaxIters inherits the station policy, which defaults to unlimited');

A.report('worker-iteration-cap.test');
