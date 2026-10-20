'use strict';
const assert = require('node:assert/strict');
const { main, client } = require('./workflow.cjs');
const base = 'http://127.0.0.1:8790';

async function smoke() {
  const request = await client(base);
  const before = (await request('/api/save')).save;
  const preview = await main(['create', '--spec', 'lab/fixtures/lifestruct.json']);
  assert.equal(preview.valid, true);
  assert.equal(preview.applied, false);
  assert.deepEqual((await request('/api/save')).save, before, 'dry-run must not persist anything');
  const applied = await main(['create', '--spec', 'lab/fixtures/lifestruct.json', '--apply']);
  assert.equal(applied.applied, true);
  assert.equal(applied.valid, true);
  assert.equal(applied.steps.length, 3);
  const state = (await request('/api/save')).save;
  const result = await main(['read']);
  assert.equal(result.lines.length, 1);
  assert.equal(result.steps[1].agentId, 'life_content');
  const edited = await main(['edit', '--step', result.steps[1].id, '--patch', 'lab/fixtures/content-edit.json']);
  assert.equal(edited.applied, false);
  assert.deepEqual((await request('/api/save')).save, state, 'edit dry-run must not persist anything');
  await main(['edit', '--step', result.steps[1].id, '--patch', 'lab/fixtures/content-edit.json', '--apply']);
  assert.match((await main(['read'])).steps[1].brief, /Drei Test-Pins/);

  // Real server compare-and-swap: a second writer cannot overwrite a newer station revision.
  const current = (await request('/api/save')).save;
  const fresh = structuredClone(current);
  fresh.updatedAt = Math.max(Date.now(), current.updatedAt + 1);
  fresh.agent.purpose = 'Offline authoring smoke passed. Model execution remains disabled.';
  await request('/api/save', fresh);
  const stale = structuredClone(current);
  stale.updatedAt = fresh.updatedAt + 1;
  stale.agent.purpose = 'This stale edit must never be stored.';
  await assert.rejects(request('/api/save', stale), /conflict/);
  assert.equal((await request('/api/save')).save.agent.purpose, fresh.agent.purpose);

  const unauthenticated = await fetch(base + '/api/save');
  assert.equal(unauthenticated.status, 403);
  const blocked = await fetch(base + '/api/run', { method: 'POST', body: '{}' });
  assert.equal(blocked.status, 403);
  assert.match(await blocked.text(), /LAB_OFFLINE/);
  return { ok: true, modelCalls: 'not executed; run endpoint blocked',
    checks: ['create dry-run', 'create via HTTP API', 'read', 'edit dry-run', 'edit via HTTP API', 'routing compiler', 'stale revision rejected', 'unauthenticated read rejected', 'execution blocked'],
    workflow: (await main(['read'])).steps };
}
smoke().then(result => console.log(JSON.stringify(result, null, 2))).catch(e => { console.error(e); process.exitCode = 1; });
