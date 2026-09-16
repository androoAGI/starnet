'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../sidecar/index.js'), 'utf8');
const start = source.indexOf('function handleCronUpdate(');
const end = source.indexOf('// POST /api/cron/remove', start);
(async () => {
  let finish, writes = 0;
  const result = new Promise(resolve => { finish = resolve; });
  const before = { id: 'routine', agentId: 'agent', attachToSession: false, origin: { sessionId: 'old-session' } };
  const afterConcurrentEdit = { ...before, origin: null };
  const ctx = vm.createContext({ Date, cronJobs: [before], CRON_HOST_TZ: 'UTC',
    cronStore: { getJob: jobs => jobs[0], updateJob: () => { writes++; throw new Error('must not persist invalid state'); } },
    readBody: async () => JSON.stringify({ id: 'routine', patch: { attachToSession: true } }),
    withCronWrite: async fn => fn([afterConcurrentEdit]) });
  vm.runInContext(source.slice(start, end), ctx);
  let status;
  ctx.handleCronUpdate({}, { writeHead: n => { status = n; }, end: body => finish(JSON.parse(body)) });
  const body = await result;
  assert.equal(status, 500); assert.match(body.error, /captured session origin/);
  assert.equal(writes, 0, 'the write lock validates the current origin, not the stale preflight snapshot');
  console.log('routine origin race: concurrent origin removal cannot persist an invalid follow-up PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
