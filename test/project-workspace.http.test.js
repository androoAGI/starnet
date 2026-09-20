'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const provider = await require('./helpers/overseer-provider.js').startOverseerProvider({ workerDelay: 2500 });
  const fixture = SidecarFixture.create({ env: { SKYNET_OPENROUTER_BASE: 'http://127.0.0.1:' + provider.server.address().port + '/api/v1', SKYNET_OPENROUTER_KEY: 'sk-or-v1-local-proof', SKYNET_DEFAULT_MODEL: 'test/model', SKYNET_FULL_ACCESS: '1' } });
  try {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '../dev/fixtures/seed-workspace/agent.save.json'), 'utf8'));
    fs.writeFileSync(path.join(fixture.workspace, 'agent.save.json'), JSON.stringify(seed));
    await fixture.start();
    await fixture.json('POST', '/api/roster', { agents: [
      { agentId: 'agent', name: 'Overseer', model: 'test/model', provider: 'openrouter', system: 'Coordinate work.' },
      { agentId: 'researcher', name: 'Mira', role: 'Research', model: 'test/model', provider: 'openrouter', system: 'Use the existing research persona.' }
    ] });
    const roots = [];
    for (const name of ['alpha', 'beta']) {
      const folder = path.join(fixture.workspace, name); fs.mkdirSync(folder);
      const blessed = await fixture.json('POST', '/api/projects/bless', { path: folder });
      assert.equal(blessed.status, 200, blessed.text);
      roots.push(blessed.body.root || blessed.body.project && blessed.body.project.root);
    }
    if (roots.some(r => !r)) {
      const projects = (await fixture.json('GET', '/api/projects')).body.projects;
      roots[0] = projects.find(p => /alpha$/i.test(p.root)).root; roots[1] = projects.find(p => /beta$/i.test(p.root)).root;
    }
    const open = root => fixture.json('POST', '/api/projects/workspace', { root });
    const first = await open(roots[0]); assert.equal(first.status, 200, first.text);
    const home = first.body.session;
    const read = await fixture.json('GET', '/api/projects/workspace?root=' + encodeURIComponent(roots[0]));
    assert.equal(read.status, 200, read.text); assert.equal(read.body.session.id, home.id, 'activity polling resolves query-scoped project');
    assert.equal((await open(roots[0])).body.session.id, home.id);
    const second = await open(roots[1]); assert.notEqual(second.body.session.id, home.id);
    assert.equal((await fixture.json('POST', '/api/projects/workspace', { root: roots[0], preferredAgents: ['researcher'] })).status, 200);
    assert.equal((await fixture.json('POST', '/api/projects/workspace', { root: roots[0], preferredAgents: ['unknown'] })).status, 400);
    const run = await fixture.json('POST', '/api/run', { model: 'test/model', agentId: 'agent', streamId: home.id, projectRoot: roots[0], isTask: true, messages: [{ role: 'user', content: 'Have the crew review this project.' }] });
    assert.equal(run.status, 200, run.text);
    let activity = (await open(roots[0])).body.activity;
    assert.equal(activity.length, 1, JSON.stringify(activity));
    const worker = activity[0]; assert.equal(worker.agentId, 'researcher');
    assert.equal((await fixture.json('POST', '/api/subagents/steer', { id: worker.id, generation: worker.generation, text: 'Focus on the first milestone.' })).body.ok, true);
    assert.equal((await open(roots[1])).body.activity.length, 0, 'other project activity is isolated');
    const deadline = Date.now() + 18000;
    while (Date.now() < deadline) {
      const snapshot = (await fixture.json('GET', '/api/overseer')).body;
      if (snapshot.reviews.some(r => r.status === 'done')) break;
      await sleep(100);
    }
    const snapshot = (await fixture.json('GET', '/api/overseer')).body;
    assert.ok(snapshot.reviews.some(r => r.status === 'done' && r.parentStreamId === home.id), JSON.stringify(snapshot));
    assert.equal(snapshot.threads.filter(w => w.parentStreamId === home.id).length, 0, 'project delegation does not create visible child sessions');
    assert.ok(provider.requests.some(ms => ms.some(m => m.role === 'system' && /Preferred crew: \["researcher"\]/.test(m.content))), 'preferences reach the orchestrator');
    assert.ok(provider.requests.some(ms => ms.some(m => m.role === 'user' && /commanderDirections/.test(m.content) && /first milestone/.test(m.content))), 'review includes direct worker steering');
    await fixture.restart();
    const reopened = await open(roots[0]); assert.equal(reopened.body.session.id, home.id);
    assert.deepEqual(reopened.body.project.preferredAgents, ['researcher']);
    assert.equal(reopened.body.activity[0].status, 'done');
    assert.equal((await fixture.json('POST', '/api/permissions/revoke', { key: 'path:' + roots[0] })).body.ok, true);
    const revoked = await fixture.json('GET', '/api/projects/workspace?root=' + encodeURIComponent(roots[0]));
    assert.equal(revoked.status, 200); assert.equal(revoked.body.project.blessed, false, 'revocation remains visible without erasing activity');
    assert.equal(revoked.body.session.id, home.id);
    assert.equal((await open(roots[0])).status, 403, 'opening cannot silently re-grant a revoked folder');
    assert.equal((await open('unknown-project')).status, 404, 'arbitrary roots cannot create project conversations');
    console.log('project workspace: stable conversation, scoped crew activity, steering, automatic return and restart PASS');
  } finally { await fixture.dispose(); await new Promise(resolve => provider.server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
