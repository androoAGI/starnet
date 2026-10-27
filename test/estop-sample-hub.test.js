/* node test/estop-sample-hub.test.js — E-STOP reaches the whole-line SAMPLE run (conveyor sweep 2026-09-25).

   The sample hub (POST /api/routing/sample) drives a REAL entry run plus every chained stage inside its own
   inflight record, exactly like a channel hub. handleHalt and the process-fault quiesce both killAll() a list of
   hub inflight maps — and the sample hub was missing from both, so an E-STOP left a running sample spending.
   Locks: both kill sites include the sample hub's inflight map, and killAll really aborts a hub-shaped record. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { killAll } = require('../sidecar/halt.js');

const src = readSidecarSource();
function body(name) {
  const i = src.indexOf('\nfunction ' + name + '(');
  A.ok(i >= 0, name + ' exists');
  const j = src.indexOf('\n}\n', i);
  return src.slice(i, j);
}
const halt = body('handleHalt');
A.ok(/sampleHub\._internals\.inflight/.test(halt), 'handleHalt reads the sample hub inflight map');
A.ok(/killAll\([^)]*sampleInflight\)/.test(halt), 'handleHalt passes it to killAll');
const quiesce = body('quiesceForProcessFault');
A.ok(/contain\('sample',[^\n]*killAll\(null, \(sampleHub && sampleHub\._internals\) \? sampleHub\._internals\.inflight/.test(quiesce), 'the process-fault quiesce kills the sample run in its own containment');

// the hub record shape the sample hub keeps ({ runId, abort, superseded, halted }) is what killAll aborts
let aborted = 0;
const rec = { runId: 'r1', abort: { abort: () => { aborted++; } }, superseded: false, halted: false };
const n = killAll(null, new Map([['sample', rec]]));
A.eq(n, 1, 'killAll counts the sample run');
A.eq(aborted, 1, 'and aborts it');
A.ok(rec.superseded === true, 'the record is marked so the hub abandons its reply');

A.report('estop-sample-hub.test');
