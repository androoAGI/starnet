'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const providerOptions = { reviewDelay: 1500 };
  const provider = await require('./helpers/overseer-provider.js').startOverseerProvider(providerOptions);
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
    const reviewStartedDeadline = Date.now() + 18000;
    while (provider.reviews() === 0 && Date.now() < reviewStartedDeadline) await sleep(25);
    assert.equal(provider.reviews(), 1, 'automatic review has reached the provider');
    // A real client sends its captured prior history, not just the new turn.
    const queued = await fixture.json('POST', '/api/run', { model: 'test/model', agentId: 'agent', streamId: 'home', isTask: true,
      messages: [{ role: 'user', content: 'Delegate research and review the findings' },
        { role: 'assistant', content: 'Research started. You can keep talking here.' },
        { role: 'user', content: 'DIRECT_PROOF: queued while the review is finishing' }] });
    assert.equal(queued.status, 200);
    const queuedPrompt = provider.requests.find(messages => messages.some(m => m.role === 'user' && /queued while the review/.test(m.content)));
    assert.ok(queuedPrompt && queuedPrompt.some(m => m.role === 'assistant' && /Reviewed findings/.test(m.content)), 'queued user turn sees the review that finished while it waited');
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
    const direct = provider.requests.find(messages => messages.some(m => m.role === 'user' && /DIRECT_PROOF: answer me directly/.test(m.content)));
    assert.ok(direct);
    assert.ok(!direct.some(m => m.role === 'system' && /Background results return here automatically/.test(m.content)), 'specialist conversation does not acquire orchestrator coordination instructions');
    assert.ok(snapshot.workers.length > 0);
    for (const worker of snapshot.workers) {
      for (const field of ['context', 'result', 'events', 'structuredResult', 'artifacts']) {
        assert.equal(Object.hasOwn(worker, field), false, 'polling projection excludes heavy worker data: ' + field);
      }
    }
    const transcript = (await fixture.json('GET', '/api/transcript?stream=home&limit=100')).body.turns;
    assert.equal(transcript.filter(m => m.role === 'user').length, 2, 'automatic review never impersonates a Commander message');
    const runs = (await fixture.json('GET', '/api/runs?agent=*&limit=30')).body.runs;
    assert.ok(runs.some(r => r.streamId === 'home' && /Reviewed findings/.test(r.deliveryText || '')), 'review delivered to original conversation');
    assert.equal(runs.find(r => r.streamId === 'home' && /Reviewed findings/.test(r.deliveryText || '')).deliveryPrompt, '', 'automatic review uses existing assistant delivery without a delegated-task marker');
    const childId = snapshot.threads.find(w => w.title === 'Research proof').id;
    const publicReview = transcript.filter(m => m.kind === 'delivery' && m.sourceRunId === snapshot.reviews[0].reviewRunId);
    assert.equal(publicReview.length, 1, 'the completed review has exactly one canonical public delivery');
    // Crash after publication but before the done acknowledgement: restart must recover the same row.
    await fixture.stop();
    const firstStatePath = path.join(fixture.workspace, 'overseer.json');
    const firstState = JSON.parse(fs.readFileSync(firstStatePath, 'utf8'));
    firstState.value.reviews[0].status = 'reviewing';
    fs.writeFileSync(firstStatePath, JSON.stringify(firstState));
    await fixture.start(); await sleep(2600);
    snapshot = (await fixture.json('GET', '/api/overseer')).body;
    assert.ok(snapshot.threads.some(w => w.id === childId), 'child identity survives restart');
    assert.equal(snapshot.reviews[0].status, 'done'); assert.equal(provider.reviews(), 1, 'restart does not re-run completed review');
    const restartedTranscript = (await fixture.json('GET', '/api/transcript?stream=home&limit=100')).body.turns;
    assert.deepEqual(restartedTranscript.filter(m => m.kind === 'delivery' && m.sourceRunId === snapshot.reviews[0].reviewRunId), publicReview,
      'lost done acknowledgement reuses the exact public row after process restart');
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
    assert.equal((await fixture.json('GET', '/api/halt')).body.subsystems.overseer.halted, true, 'existing halt status includes coordination');
    const resumed = await fixture.json('POST', '/api/halt/resume', { confirm: true });
    assert.equal(resumed.body.subsystems.overseer.halted, false, 'existing explicit resume also resumes coordination');
    assert.equal((await fixture.json('GET', '/api/overseer')).body.reviews.some(r => r.status === 'pending'), false, 'explicit resume does not revive cancelled reviews');
    // One lead makes two background dispatch calls with a real poll interval between them. The first worker
    // finishes before the second is assigned; the report must wait for the lead and cover both exactly once.
    const reviewsBeforeBatch = provider.reviews();
    const batchTurn = await fixture.json('POST', '/api/run', { model: 'test/model', agentId: 'agent', streamId: 'home', isTask: true,
      messages: [{ role: 'user', content: 'BATCH_TIMING_PROOF: delegate two findings and report together.' }] });
    assert.equal(batchTurn.status, 200);
    const batchDeadline = Date.now() + 18000;
    let batchReviews = [];
    while (Date.now() < batchDeadline) {
      snapshot = (await fixture.json('GET', '/api/overseer')).body;
      const batchWorkers = snapshot.workers.filter(w => /BATCH_WORKER_/.test(w.prompt || ''));
      const ids = new Set(batchWorkers.map(w => w.runId));
      batchReviews = snapshot.reviews.filter(r => (r.workerRunIds || []).some(id => ids.has(id)));
      if (batchWorkers.length === 2 && batchReviews.some(r => r.status === 'done')) break;
      await sleep(100);
    }
    await sleep(2600);
    assert.equal(batchReviews.length, 1, 'late dispatches from the same lead turn receive one report');
    assert.equal(batchReviews[0].members.length, 2, 'the report covers the fast worker and the later dispatch');
    assert.equal(batchReviews[0].waitingOn.length, 0, 'no finished worker is called still working');
    assert.equal(provider.reviews(), reviewsBeforeBatch + 1, 'no redundant follow-up provider run appears');
    await fixture.restart(); await sleep(2600);
    const restoredBatch = (await fixture.json('GET', '/api/overseer')).body.reviews.find(r => r.id === batchReviews[0].id);
    assert.equal(restoredBatch.members.length, 2, 'the combined report membership survives process restart');
    assert.equal(restoredBatch.status, 'done');
    assert.equal(provider.reviews(), reviewsBeforeBatch + 1, 'restart never re-reviews the combined hand-off');
    console.log('e2e.overseer: delayed second dispatch -> ONE two-worker report -> restart PASS');
    await fixture.stop();
    const beforeUpdate = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    beforeUpdate.value.paused = false;
    // Two pending reviews, the provider holding any review it gets, and a forced prepare. The 2 s tick may start one before prepare
    // arrives, and a live run rightly refuses a plain prepare: this test's red on a loaded box. One review runs at a time, so the
    // held one keeps the other pending for as long as prepare takes, and that one is what polling must leave alone.
    let releaseReviews;
    providerOptions.reviewGate = new Promise(resolve => { releaseReviews = resolve; });
    beforeUpdate.value.reviews[0].status = 'pending';
    beforeUpdate.value.reviews[beforeUpdate.value.reviews.length - 1].status = 'pending';
    fs.writeFileSync(statePath, JSON.stringify(beforeUpdate));
    await fixture.start();
    const prepared = await fixture.json('POST', '/api/update/prepare', { targetVersion: '9.9.9', force: true });
    assert.equal(prepared.body.ok, true, JSON.stringify(prepared.body));
    const frozenBytes = fs.readFileSync(statePath, 'utf8');
    const frozenReviews = JSON.parse(frozenBytes).value.reviews.map(r => r.status);
    assert.ok(frozenReviews.includes('pending'), 'a pending review is there for polling to start: ' + frozenReviews.join());
    providerOptions.reviewGate = null; releaseReviews();
    await sleep(2600);
    assert.equal(fs.readFileSync(statePath, 'utf8'), frozenBytes, 'review polling cannot change state behind the pre-update snapshot');
    await fixture.json('POST', '/api/update/cancel', {});
    await fixture.stop();
    // A schema-invalid envelope cannot recover from a JSON backup: preserve it,
    // keep coordination disabled, and let the rest of the station start normally.
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, value: { threads: 'invalid', reviews: [] } }));
    await fixture.start();
    const damaged = (await fixture.json('GET', '/api/overseer')).body;
    assert.equal(damaged.paused, true);
    assert.match(damaged.error, /unavailable/);
    const ordinary = await fixture.json('POST', '/api/run', { model: 'test/model', agentId: 'agent', streamId: 'home', isTask: true,
      messages: [{ role: 'user', content: 'DIRECT_PROOF: answer normally while coordination is unavailable' }] });
    assert.equal(ordinary.status, 200);
    assert.ok(provider.requests.some(messages => messages.some(m => m.role === 'user' && /answer normally while coordination/.test(m.content))), 'ordinary chat reaches its provider with damaged optional state');
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).value.threads, 'invalid', 'ordinary chat does not overwrite damaged coordination state');
    console.log('e2e.overseer: headless create -> background dispatch -> automatic parent review -> restart PASS');
  } catch (e) { console.error(fixture.output().slice(-2500)); throw e; }
  finally { await fixture.dispose(); await new Promise(resolve => mock.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
