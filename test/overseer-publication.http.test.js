'use strict';
// Real sidecar/provider/stores: fail only the canonical publication, then restart with the same paid run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const provider = await require('./helpers/overseer-provider.js').startOverseerProvider();
  const fixture = SidecarFixture.create({ env: { SKYNET_OPENROUTER_BASE: 'http://127.0.0.1:' + provider.server.address().port + '/api/v1',
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-publication-proof', SKYNET_DEFAULT_MODEL: 'test/model', SKYNET_FULL_ACCESS: '1' } });
  try {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '../dev/fixtures/seed-workspace/agent.save.json'), 'utf8'));
    seed.doc.generalId = 'general'; seed.doc.activeId = 'home';
    seed.doc.workstreams = ['general', 'home'].map(id => ({ id, agentId: 'agent', title: id, history: [], kind: 'chat', lane: 'active' }));
    fs.writeFileSync(path.join(fixture.workspace, 'agent.save.json'), JSON.stringify(seed));
    const fault = path.join(fixture.workspace, 'publication-fault');
    fs.writeFileSync(fault, 'Only canonical review publication is refused.');
    const boot = path.join(fixture.workspace, 'publication-boot.cjs');
    fs.writeFileSync(boot, `const fs=require('node:fs');const d=require(${JSON.stringify(path.resolve(__dirname, '../sidecar/turn-delivery.js'))});const write=d.write;d.write=(...args)=>{if(fs.existsSync(${JSON.stringify(fault)}))throw new Error('injected review publication fault');return write(...args);};require(${JSON.stringify(path.resolve(__dirname, '../sidecar/index.js'))});`);
    fixture.entry = boot;
    await fixture.start();
    assert.equal((await fixture.json('POST', '/api/roster', { agents: [
      { agentId: 'agent', name: 'Overseer', model: 'test/model', provider: 'openrouter', system: 'You coordinate work.' },
      { agentId: 'researcher', name: 'Researcher', role: 'Research', model: 'test/model', provider: 'openrouter', system: 'Return the requested research.' }
    ] })).status, 200);
    assert.equal((await fixture.json('POST', '/api/run', { model: 'test/model', agentId: 'agent', streamId: 'home', isTask: true,
      messages: [{ role: 'user', content: 'Delegate research and review the findings' }] })).status, 200);
    async function waitReview(predicate) {
      const until = Date.now() + 20000; let review;
      do {
        review = (await fixture.json('GET', '/api/overseer')).body.reviews[0];
        if (review && predicate(review)) return review;
        await sleep(75);
      } while (Date.now() < until);
      assert.fail('review state did not arrive: ' + JSON.stringify(review));
    }
    const pending = await waitReview(row => /publication is pending/.test(row.error));
    assert.equal(pending.status, 'reviewing', 'successful execution with failed publication is not done');
    assert.equal(provider.reviews(), 1, 'exactly one model review has executed');
    const deliveries = async () => (await fixture.json('GET', '/api/transcript?stream=home&limit=100')).body.turns
      .filter(row => row.kind === 'delivery' && row.sourceRunId === pending.reviewRunId);
    assert.deepEqual(await deliveries(), [], 'failed publication cannot leak hidden execution into public history');
    await sleep(2300);
    assert.equal(provider.reviews(), 1, 'automatic publication retries do not rerun the model');
    await fixture.stop();
    fs.unlinkSync(fault);
    await fixture.start();
    const done = await waitReview(row => row.status === 'done');
    assert.equal(done.reviewRunId, pending.reviewRunId, 'restart retains the already executed review');
    assert.equal(provider.reviews(), 1, 'restart repairs only publication');
    const rows = await deliveries();
    assert.equal(rows.length, 1, 'restart publishes exactly one durable answer');
    assert.match(rows[0].content, /Reviewed findings/);
    // A restarted page reads its current host-backed history. The separate queued-turn e2e exercises
    // stale captured history while a review is still running; an ordinary legacy request posts its full history.
    const visible = (await fixture.json('GET', '/api/transcript?stream=home&limit=100')).body.turns;
    const messages = visible.filter(row => row.role === 'user' || row.role === 'assistant').map(row => ({ role: row.role, content: row.content }));
    messages.push({ role: 'user', content: 'DIRECT_PROOF: after publication recovery' });
    assert.equal((await fixture.json('POST', '/api/run', { model: 'test/model', agentId: 'agent', streamId: 'home', isTask: true, messages })).status, 200);
    const prompt = provider.requests.find(messages => messages.some(row => row.role === 'user' && /after publication recovery/.test(row.content)));
    assert.ok(prompt && prompt.some(row => row.role === 'assistant' && /Reviewed findings/.test(row.content)), 'the next real run sees the recovered canonical review');
    assert.equal(provider.reviews(), 1, 'following conversation does not repeat the review');
    console.log('overseer-publication: PASS publication fault -> no paid rerun -> restart -> one public answer -> real next prompt');
  } finally { await fixture.dispose(); await new Promise(resolve => provider.server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
