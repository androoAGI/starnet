/* node test/thrown-run-reason.test.js — a run that THREW is recorded as 'error', never 'done' (bug 812c3bfb, quick win 14).

   runOnceCore settles every run in its finally block from `result`, the loop's return value. A run that threw before its
   loop returned leaves `result` unset, and three settle sites defaulted the missing reason to 'done': the managed-credit
   settle (credits.finishRun), the durable run history (runStore.record) and the quest sweep (a thrown run COMPLETED its
   open quests). runstore.js clamped any unknown reason to 'done' too. A run nobody saw finish read as a finished one.

   Locks: each of the three sites defaults to 'error' (sliced from runOnceCore, the function they live in), none of them
   defaults to 'done' any more, and the store's clamp is covered by test/runstore.test.js section B. */
'use strict';
const A = require('./_assert.js');
const { sidecarTopLevelFunction } = require('./helpers/source');
const { makeRunStore } = require('../sidecar/runstore.js');

const core = sidecarTopLevelFunction('runOnceCore');
A.ok(core.length > 100000, 'runOnceCore sliced whole (' + core.length + ' chars)');
// the settle block: from the finally that books the run's spend to the end of the function
const settle = core.slice(core.indexOf('// book this run\'s spend into the append-only ledger'));
A.ok(settle.length > 2000 && settle.length < core.length, 'the run-settle block is found inside runOnceCore');

A.ok(/credits\.finishRun\(\{[^}]*reason: \(result && result\.reason\) \|\| 'error' \}\)/.test(settle), 'a managed-credit settle of a thrown run says error');
A.ok(/runStore\.record\(\{[^\n]*reason: \(\(result && result\.reason\) \|\| 'error'\)/.test(settle), 'the run history records a thrown run as error');
A.ok(/const _qReason = taskQuestionAsked \? 'clarifying' : \(\(result && result\.reason\) \|\| 'error'\);/.test(core), 'a thrown run stalls its quests instead of completing them');
A.ok(!/\(result && result\.reason\) \|\| 'done'/.test(core), 'no settle site in runOnceCore defaults a missing reason to done');

// …and the store never upgrades a missing reason to a success on its own
const lines = [];
const s = makeRunStore({ io: { append: l => lines.push(l), readAll: () => [], rewrite: () => {} }, clock: { now: () => 1 } });
A.eq(s.record({ runId: 'thrown', agentId: 'agent' }).reason, 'error', 'a row written with no reason reads error');

A.report('thrown-run-reason.test');
