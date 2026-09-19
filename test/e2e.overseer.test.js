'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const provider = await require('./helpers/overseer-provider.js').startOverseerProvider();
  const mock = provider.server;
  const fixture = SidecarFixture.create({ env: { SKYNET_OPENROUTER_BASE: 'http://127.0.0.1:' + mock.address().port + '/api/v1',
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-local-proof', SKYNET_DEFAULT_MODEL: 'test/model', SKYNET_FULL_ACCESS: '1' } });
  try {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '../dev/fixtures/seed-workspace/agent.save.json'), 'utf8'));
    seed.doc.generalId = 'general'; seed.doc.activeId = 'home';
    seed.doc.workstreams = [
      { id: 'general', agentId: 'agent', title: null, history: [], kind: 'chat', lane: 'active' },
      { id: 'home', agentId: 'agent', title: 'Launch planning', history: [], kind: 'chat', lane: 'active' }
    ];
    fs.writeFileSync(path.join(fixture.workspace, 'agent.save.json'), JSON.stringify(seed));
    await fixture.start();
    const roster = await fixture.json('POST', '/api/roster', { agents: [
      { agentId: 'agent', name: 'Overseer', model: 'test/model', provider: 'openrouter', system: 'You coordinate work.' },
      { agentId: 'mira_custom', name: 'Mira', role: 'Research', model: 'test/model', provider: 'openrouter', system: 'MIRA_CUSTOM_PERSONA: You are the user-created research specialist.' }
    ] });
    assert.equal(roster.status, 200);
    const response = await fixture.json('POST', '/api/run', { model: 'test/model', agentId: 'agent', streamId: 'home', isTask: true,
      messages: [{ role: 'user', content: 'Delegate research and review the findings' }] });
    assert.equal(response.status, 200);
    let snapshot;
    const deadline = Date.now() + 18000;
    while (Date.now() < deadline) {
      snapshot = (await fixture.json('GET', '/api/overseer')).body;
      if (snapshot.reviews && snapshot.reviews.some(r => r.status === 'done')) break;
      await sleep(100);
    }
    assert.ok(snapshot.threads.some(w => w.title === 'Research proof' && w.parentStreamId === 'home'), JSON.stringify(snapshot));
    assert.equal(snapshot.reviews.length, 1, response.text);
    assert.equal(snapshot.reviews[0].status, 'done', JSON.stringify(snapshot.reviews));
    assert.equal(provider.reviews(), 1, 'the lead reviews automatically once');
    assert.equal(snapshot.threads.find(w => w.title === 'Research proof').agentId, 'mira_custom', 'delegate uses the user-created roster agent');
    assert.ok(provider.requests.some(messages => messages.some(m => m.role === 'system' && /MIRA_CUSTOM_PERSONA/.test(m.content))), 'worker keeps its existing persona');
    assert.equal((await fixture.json('GET', '/api/transcript?stream=general&limit=100')).body.turns.length, 0, 'General is not the required home or result destination');
    await fixture.json('POST', '/api/run', { model: 'test/model', agentId: 'mira_custom', streamId: 'direct', isTask: true,
      messages: [{ role: 'user', content: 'DIRECT_PROOF: answer me directly' }] });
    const direct = provider.requests.find(messages => messages.some(m => m.role === 'user' && /DIRECT_PROOF/.test(m.content)));
    assert.ok(direct);
    assert.ok(!direct.some(m => m.role === 'system' && /Background results return here automatically/.test(m.content)), 'specialist conversation does not acquire orchestrator coordination instructions');
    assert.ok(snapshot.workers.length > 0);
    for (const worker of snapshot.workers) {
      for (const field of ['context', 'result', 'events', 'structuredResult', 'artifacts']) {
        assert.equal(Object.hasOwn(worker, field), false, 'polling projection excludes heavy worker data: ' + field);
      }
    }
    const transcript = (await fixture.json('GET', '/api/transcript?stream=home&limit=100')).body.turns;
    assert.equal(transcript.filter(m => m.role === 'user').length, 1, 'automatic review never impersonates a Commander message');
    const runs = (await fixture.json('GET', '/api/runs?agent=*&limit=30')).body.runs;
    assert.ok(runs.some(r => r.streamId === 'home' && /Reviewed findings/.test(r.deliveryText || '')), 'review delivered to original conversation');
    const childId = snapshot.threads.find(w => w.title === 'Research proof').id;
    await fixture.restart(); await sleep(2600);
    snapshot = (await fixture.json('GET', '/api/overseer')).body;
    assert.ok(snapshot.threads.some(w => w.id === childId), 'child identity survives restart');
    assert.equal(snapshot.reviews[0].status, 'done'); assert.equal(provider.reviews(), 1, 'restart does not re-run completed review');
    const followup = await fixture.json('POST', '/api/run', { model: 'test/model', agentId: 'agent', streamId: 'home', isTask: true,
      messages: [{ role: 'user', content: 'Follow up in the existing research thread' }] });
    assert.equal(followup.status, 200);
    const followupDeadline = Date.now() + 18000;
    while (Date.now() < followupDeadline) {
      snapshot = (await fixture.json('GET', '/api/overseer')).body;
      if (snapshot.reviews.filter(r => r.status === 'done').length === 2) break;
      await sleep(100);
    }
    assert.equal(snapshot.reviews.filter(r => r.status === 'done').length, 2);
    assert.equal(snapshot.threads.filter(w => w.parentStreamId === 'home').length, 1, 'follow-up reuses the child identity');
    const continued = provider.requests.find(messages => messages.some(m => m.role === 'user' && /continue from your previous findings/.test(m.content)));
    assert.ok(continued && continued.some(m => m.role === 'assistant' && /WORKER_FINDINGS/.test(m.content)), 'continued worker receives its durable prior answer');
    await fixture.stop();
    const statePath = path.join(fixture.workspace, 'overseer.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.value.reviews[1].status = 'reviewing';
    state.value.reviews[1].reviewRunId = 'interrupted-before-provider';
    fs.writeFileSync(statePath, JSON.stringify(state));
    await fixture.start(); await sleep(2600);
    snapshot = (await fixture.json('GET', '/api/overseer')).body;
    assert.equal(snapshot.reviews[1].status, 'interrupted', 'unknown review completion is never asserted or replayed');
    assert.equal(provider.reviews(), 2, 'uncertain review needs an explicit follow-up');
    await fixture.json('POST', '/api/run', { model: 'test/model', agentId: 'agent', streamId: 'home', isTask: true,
      messages: [{ role: 'user', content: 'Follow up in the existing research thread' }] });
    const halted = await fixture.json('POST', '/api/halt', {});
    assert.equal(halted.status, 200);
    assert.equal(halted.body.overseerHaltPersisted, true, 'halt response proves durable overseer stop');
    snapshot = (await fixture.json('GET', '/api/overseer')).body;
    assert.equal(snapshot.paused, true, 'E-STOP durably pauses review admission');
    assert.ok(snapshot.reviews.some(r => r.status === 'cancelled'), 'stopped worker cannot enqueue a new review');
    await fixture.restart(); await sleep(2600);
    snapshot = (await fixture.json('GET', '/api/overseer')).body;
    assert.equal(snapshot.paused, true, 'E-STOP survives process restart');
    assert.equal(provider.reviews(), 2, 'restart after stop never wakes cancelled reviews');
    await fixture.json('POST', '/api/run', { model: 'test/model', agentId: 'mira_custom', streamId: 'direct', isTask: true,
      messages: [{ role: 'user', content: 'DIRECT_PROOF: keep this specialist conversation separate' }] });
    assert.equal((await fixture.json('GET', '/api/overseer')).body.paused, true, 'talking to a specialist cannot resume orchestrator reviews');
    console.log('e2e.overseer: headless create -> background dispatch -> automatic parent review -> restart PASS');
  } catch (e) { console.error(fixture.output().slice(-2500)); throw e; }
  finally { await fixture.dispose(); await new Promise(resolve => mock.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
