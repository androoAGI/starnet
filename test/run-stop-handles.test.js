/* node test/run-stop-handles.test.js — which runs get a stop-by-id handle (QA 2026-10-02 + review).
   Every run runOnce drives with its own id (routine fires, line hops, hubs, step tests) is stoppable and steerable by id
   (see test/cancel-host-run.e2e.test.js for the live proof). A DELEGATED worker is not: the subagent manager owns its stop
   (interrupt, cancelChildren) and it reads steering from its own buffer — a desk STEER by its id answered "Sent" and was
   never read, and a desk STOP bypassed the manager. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const idx = readSidecarSource();
const fn = idx.slice(idx.indexOf('async function runOnceTracked(o) {'), idx.indexOf('async function runOnceTrackedBelt(o) {'));
A.ok(fn.length > 0, 'runOnceTracked exists ahead of its belt');
A.ok(fn.includes("const delegated = !!(o && (o.parentRunId || typeof o.steer === 'function'));"), 'a run with a parent or its own steer is a delegated worker');
A.ok(fn.includes('if (rid && !delegated && !runStopHandles.has(rid)'), 'and gets no stop handle');
A.ok(fn.includes('o.signal = o.signal ? AbortSignal.any([o.signal, kc.signal]) : kc.signal;'), 'every other run with an id does, joined to its own signal');
const steer = idx.slice(idx.indexOf('async function handleRunSteer('), idx.indexOf('async function handleRunSteer(') + 900);
A.ok(steer.includes('(runs.has(runId) || runStopHandles.has(runId))'), 'a steer is accepted only for a run that reads the shared buffer');
A.report('run-stop-handles');
