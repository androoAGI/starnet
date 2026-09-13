'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:19427';
(async () => {
  const html = await (await fetch(base)).text();
  const token = html.match(/window\.__STARNET_API_TOKEN__\s*=\s*"([^"]+)"/)[1];
  const get = async url => (await fetch(base + url, { headers: { 'X-StarNet-Token': token } })).json();
  const post = async (url, data) => {
    const r = await fetch(base + url, { method: 'POST', headers: { 'X-StarNet-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: r.status, body: await r.json() };
  };
  const j = await get('/api/cron');
  const job = j.jobs.find(x => x.name === 'Repair follow-up persistence');
  assert.ok(job); assert.equal(job.attachToSession, true);
  assert.ok(job.origin.sessionId); assert.equal(job.origin.sessionTitle, 'Audit original session');
  assert.equal(job.provider, null, 'selected agent provider remains inherited');
  const bad = await post('/api/cron', { name: 'Repair invalid follow-up', prompt: 'Summarize progress', schedule: '0 9 * * *', attachToSession: true });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /captured session/);
  const patch = await post('/api/cron/update', { id: job.id, patch: { origin: null } });
  assert.equal(patch.status, 400); assert.match(patch.body.error, /captured session/);
  const after = (await get('/api/cron')).jobs.find(x => x.id === job.id);
  assert.deepEqual(after.origin, job.origin);
  const result = { at: new Date().toISOString(), phase: process.argv[2] || 'before-restart', schedulerArmed: j.armed,
    job: { id: job.id, deliver: job.deliver, attachToSession: job.attachToSession, origin: job.origin, provider: job.provider },
    invalidCreate: bad, invalidUpdate: patch, rejectedUpdatePreservedOrigin: true };
  fs.writeFileSync(path.join(__dirname, 'repair-http-' + result.phase + '.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
