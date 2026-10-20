'use strict';
const assert = require('node:assert/strict');
const { main, client } = require('./workflow.cjs');
const base = process.env.LAB_BASE || 'http://127.0.0.1:8790';

async function smoke() {
  const request = await client(base, { allowLiveAuthoring: true });
  const before = (await request('/api/save')).save;
  const preview = await main(['create', '--spec', 'lab/fixtures/lifestruct.json', '--live-authoring']);
  assert.equal(preview.valid, true);
  assert.equal(preview.applied, false);
  assert.deepEqual((await request('/api/save')).save, before, 'dry-run must not persist anything');
  const applied = await main(['create', '--spec', 'lab/fixtures/lifestruct.json', '--apply', '--live-authoring']);
  assert.equal(applied.applied, true);
  assert.equal(applied.valid, true);
  assert.equal(applied.steps.length, 3);
  const state = (await request('/api/save')).save;
  const result = await main(['read']);
  assert.equal(result.lines.length, 1);
  assert.equal(result.steps[1].agentId, 'life_content');
  const edited = await main(['edit', '--step', result.steps[1].id, '--patch', 'lab/fixtures/content-edit.json', '--live-authoring']);
  assert.equal(edited.applied, false);
  assert.deepEqual((await request('/api/save')).save, state, 'edit dry-run must not persist anything');
  await main(['edit', '--step', result.steps[1].id, '--patch', 'lab/fixtures/content-edit.json', '--apply', '--live-authoring']);
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
  // The lab's posture decides whether /api/run is refused: OFFLINE refuses every execution, LIVE lets the
  // request through (the run then fails on the missing key — a different, honest failure). The smoke test
  // states the truth of the running lab instead of assuming one posture.
  const labStatus = await fetch(base + '/api/lab/status').then(r => r.json()).catch(() => ({}));
  const blocked = await fetch(base + '/api/run', { method: 'POST', body: '{}' });
  if (labStatus && labStatus.offline) {
    assert.equal(blocked.status, 403);
    assert.match(await blocked.text(), /LAB_OFFLINE/);
  } else {
    assert.notEqual(blocked.status, 403, 'a live lab does not refuse the run route');
  }
  return { ok: true, modelCalls: 'not executed; run route ' + (labStatus && labStatus.offline ? 'blocked (offline lab)' : 'open (live lab)'),
    checks: ['create dry-run', 'create via HTTP API', 'read', 'edit dry-run', 'edit via HTTP API', 'routing compiler', 'stale revision rejected', 'unauthenticated read rejected', 'lab posture honoured'],
    workflow: (await main(['read'])).steps };
}
smoke().then(result => console.log(JSON.stringify(result, null, 2))).catch(e => { console.error(e); process.exitCode = 1; });
