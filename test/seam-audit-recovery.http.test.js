'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
let reply = 0;
const provider = http.createServer((req, res) => {
  req.resume(); req.on('end', () => {
    if (req.method !== 'POST') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 128000, supported_parameters: ['tools'] }] })); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Isolated answer ' + (++reply) }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n');
  });
});
(async () => {
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + provider.address().port;
  const fixture = SidecarFixture.create({ prefix: 'seam-recovery-', timeoutMs: 20000, env: {
    SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_BASE: base,
    SKYNET_OPENROUTER_KEY: 'fixture', STARNET_OPENROUTER_KEY: 'fixture',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_CRON_ENABLED: '0', STARNET_CRON_ENABLED: '0'
  } });
  try {
    await fixture.start();
    const ids = [];
    for (const ask of ['First request A', 'Later request B']) {
      const r = await fixture.json('POST', '/api/run', { model: 'test/model', provider: 'openrouter', key: 'fixture', agentId: 'agent', streamId: 'shared-run-review', messages: [{ role: 'user', content: ask }] });
      assert.equal(r.status, 200);
      const events = r.body.trim().split('\n').filter(Boolean).map(JSON.parse);
      assert.equal(events.find(e => e.name === 'agent.run.end').payload.reason, 'done');
      ids.push(events.find(e => e.name === 'agent.run.start').payload.runId);
    }
    const spec = { name: 'Follow-up contract', prompt: 'Summarize progress', schedule: '0 9 * * *', attachToSession: true, deliver: 'local' };
    const invalid = await fixture.json('POST', '/api/cron', spec);
    assert.equal(invalid.status, 400); assert.match(invalid.body.error, /captured session/);
    const created = await fixture.json('POST', '/api/cron', { ...spec, origin: { sessionId: 'shared-run-review', streamId: 'shared-run-review', sessionTitle: 'Shared review' } });
    assert.equal(created.status, 200); assert.ok(created.body.job.id);
    const jobId = created.body.job.id;
    const refused = await fixture.json('POST', '/api/cron/update', { id: jobId, patch: { origin: null } });
    assert.equal(refused.status, 400);
    await fixture.restart();
    const rows = await fixture.json('GET', '/api/transcript?stream=shared-run-review&limit=1&runId=' + ids[0]);
    assert.equal(rows.status, 200); assert.equal(rows.body.turns.length, 1);
    assert.equal(rows.body.turns[0].sourceRunId, ids[0]);
    assert.equal(rows.body.turns[0].content, 'Isolated answer 1');
    const session = await fixture.json('GET', '/api/transcript?stream=shared-run-review&limit=1');
    assert.equal(session.body.turns[0].sourceRunId, ids[1], 'default session route still returns the latest dialogue');
    const missing = await fixture.json('GET', '/api/transcript?stream=shared-run-review&runId=not-a-run');
    assert.equal(missing.body.turns.length, 0);
    const jobs = await fixture.json('GET', '/api/cron');
    const saved = jobs.body.jobs.find(j => j.id === jobId);
    assert.equal(saved.origin.sessionId, 'shared-run-review'); assert.equal(saved.attachToSession, true); assert.equal(saved.provider, null);
    console.log('seam recovery HTTP: two real completed runs, filtered transcript after restart, inherited provider, and follow-up validation PASS');
  } finally { await fixture.dispose(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
