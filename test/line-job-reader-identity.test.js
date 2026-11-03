'use strict';
// The durable job owner joins run membership before limiting, including reused channel streams.
const A = require('./_assert.js');
const J = require('../sidecar/routing/linejobs.js');
let state = { jobs: [] };
for (let i = 0; i < J.MAX_JOBS; i++) {
  const id = 'job-reader' + String(i).padStart(8, '0');
  state = J.start(state, { id, line: 'line-inbox', entry: 'channel', streamId: 'channel_dev_shared', at: i + 1 }).state;
  state = J.finish(state, id, { completed: true, runs: [{ runId: 'run-' + i, agentId: 'agent', reason: 'done', outcome: 'succeeded' }], output: 'Answer ' + i, at: i + 2 }).state;
}
const ids = opts => J.list(state, opts).map(job => job.id);
A.eq(ids({ stream: 'channel_dev_shared', runId: 'run-0', limit: 1 }), ['job-reader00000000'], 'oldest exact run matches before newest-first list limiting');
A.eq(ids({ stream: 'channel_dev_shared', runId: 'run-119', limit: 1 }), ['job-reader00000119'], 'newest exact run keeps its own job');
A.eq(ids({ stream: 'another-stream', runId: 'run-0', limit: 1 }), [], 'stream remains a consistency boundary');
A.eq(ids({ line: 'another-line', runId: 'run-0', limit: 1 }), [], 'line remains a consistency boundary');
A.eq(ids({ stream: 'bad stream', runId: 'run-0', limit: 1 }), [], 'invalid stream cannot remove the supplied consistency boundary');
A.eq(ids({ line: 'bad line', runId: 'run-0', limit: 1 }), [], 'invalid line cannot remove the supplied consistency boundary');
A.eq(ids({ stream: 'channel_dev_shared', runId: 'absent-run', limit: 1 }), [], 'missing exact run never returns the latest same-stream job');
for (const runId of ['', 'bad id', 'run-0' + 'x'.repeat(200)])
  A.eq(ids({ stream: 'channel_dev_shared', runId, limit: 1 }), [], 'invalid supplied identity never becomes a stream-only request');
A.eq(ids({ stream: 'channel_dev_shared', limit: 1 }), ['job-reader00000119'], 'existing stream list remains newest first when no exact run is supplied');
A.report('line-job-reader-identity');
