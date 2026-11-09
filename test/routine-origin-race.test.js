'use strict';
const { readSidecarSource } = require('./helpers/source');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = readSidecarSource();
const start = source.indexOf('function handleCronUpdate(');
const end = source.indexOf('// POST /api/cron/remove', start);
(async () => {
  let finish, writes = 0;
  const result = new Promise(resolve => { finish = resolve; });
  const before = { id: 'routine', agentId: 'agent', attachToSession: false, origin: { sessionId: 'old-session' } };
  const afterConcurrentEdit = { ...before, origin: null };
  const ctx = vm.createContext({ Date, cronJobs: [before], CRON_HOST_TZ: 'UTC',
    // fix-sec2 review 3: the route reads which unattended grants an edit adds (none here, so no desk confirmation)
    normalizeUnattendedGrants: require('../sidecar/inputpolicy.js').normalizeUnattendedGrants,
    // review2 #2: which grants an edit revokes is the store's own pure reducer (none: this edit changes no run field)
    cronStore: { getJob: jobs => jobs[0], updateJob: () => { writes++; throw new Error('must not persist invalid state'); },
      grantsRevokedByEdit: require('../sidecar/cron-store.js').grantsRevokedByEdit },
    // review2 #3: the host's own stale-script check (this routine runs no script, so it never digests one)
    cronScriptDigest: () => { throw new Error('a routine with no script is never digested'); },
    readBody: async () => JSON.stringify({ id: 'routine', patch: { attachToSession: true } }),
    withCronWrite: async fn => fn([afterConcurrentEdit]) });
  const staleAt = source.indexOf('\nfunction cronScriptStale(');
  assert.ok(staleAt >= 0, 'fixture: cronScriptStale is in index.js');
  vm.runInContext(source.slice(staleAt, source.indexOf('\n}\n', staleAt) + 3), ctx);
  vm.runInContext(source.slice(start, end), ctx);
  let status;
  ctx.handleCronUpdate({}, { writeHead: n => { status = n; }, end: body => finish(JSON.parse(body)) });
  const body = await result;
  assert.equal(status, 500); assert.match(body.error, /captured session origin/);
  assert.equal(writes, 0, 'the write lock validates the current origin, not the stale preflight snapshot');
  console.log('routine origin race: concurrent origin removal cannot persist an invalid follow-up PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
