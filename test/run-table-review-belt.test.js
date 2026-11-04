/* Contract fault injection at the review core boundary. Not evidence of an existing silent-return provider path. */
'use strict';
const root = require('node:path').resolve(__dirname, '..');
const A = require(root + '/test/_assert.js');
const vm = require('node:vm');
const RunTable = require(root + '/sidecar/run-table.js');
const RunOutcome = require(root + '/frontend/app/runoutcome.js');
const { readSidecarSource, sidecarFunctionSource } = require(root + '/test/helpers/source.js');
const src = readSidecarSource();
const start = src.indexOf('        const reviewRun = runTable.admit(');
const end = src.indexOf('\n      });', start);
A.ok(start > 0 && end > start && end - start < 4000, 'actual review admission/try/finally seam is bounded');
const block = src.slice(start, end);
(async () => {
  for (const mode of ['missing-end', 'success', 'throw']) {
    const events = [], table = RunTable.makeRunTable({ now: () => 1 });
    const context = { runTable: table, RunOutcome, endedOutcomes: new Map(), review: { agentId: 'reviewer' }, runId: 'review-proof',
      parent: { id: 'parent' }, key: 'fake', provider: 'fake', baseUrl: '', reviewWire: {}, ident: {}, members: [{ runId: 'worker' }],
      taintPolicy: { relayedTaint: () => null, firstTaint: () => '' }, cronSystemFor: () => '', reviewAbort: new AbortController(),
      transcriptStore: { view: (projection, streamId, options) => { A.eq([projection, streamId, options.shape], ['model-replay', 'parent', 'pairs'], 'review reads the canonical pair projection'); return []; } }, instruction: 'review the work', runStore: { all: () => [] },
      settleReview: () => {}, runs: new Map(), grantsSession: new Map(), task: { running: true },
      chanEmit: (name, payload) => events.push({ name, payload }) };
    context.runOnceCore = async o => {
      const emit = table.get(o.runId).guard(RunOutcome.sink(o.emit));
      emit('agent.run.start', { agentId: o.agentId, runId: o.runId });
      emit('agent.cost', { agentId: o.agentId, runId: o.runId, usd: 0.125, tokensIn: 5, tokensOut: 3 });
      if (mode === 'throw') throw new Error('core boundary fault');
      if (mode === 'success') emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', usd: 0.125, turns: 1 });
      return undefined;
    };
    vm.createContext(context);
    vm.runInContext(sidecarFunctionSource('settleRun') + '\nasync function runReview() {\n' + block + '\n}', context);
    await context.runReview();
    const starts = events.filter(e => e.name === 'agent.run.start'), ends = events.filter(e => e.name === 'agent.run.end');
    A.eq(starts.length, 1, mode + ': exactly one start');
    A.eq(ends.length, 1, mode + ': exactly one terminal despite a silent or throwing core');
    A.eq(ends[0] && ends[0].payload.reason, mode === 'success' ? 'done' : 'error', mode + ': terminal is truthful');
    A.eq(ends[0] && ends[0].payload.usd, 0.125, mode + ': terminal keeps observed spend floor');
    A.eq(table.size(), 0, mode + ': review admission is released');
    A.eq(context.task.running, false, mode + ': review task is no longer running');
  }
  A.report('run-table-review-belt');
})().catch(e => { A.ok(false, e.stack); A.report('run-table-review-belt'); });
