'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const C = require('../sidecar/colony/core.js');
const { makeService } = require('../sidecar/colony/service.js');
const Boundary = require('../sidecar/colony/boundary.js');
const Catalog = require('../sidecar/colony/catalog.js');
const { importSnapshot } = require('../sidecar/colony/pinterest.js');
function createCommand() {
  return { type: 'task.create', businessUnitId: 'lifestruct', processId: 'L01', goal: 'Ein belegter Test-Pin',
    account: 'test-only', schedule: '2026-10-22T12:00:00+02:00 Europe/Berlin', audience: 'Einsteiger',
    sources: [{ id: 's1', businessUnitId: 'lifestruct', confirmed: true, uri: 'https://example.org/source',
      asOf: '2026-10-19', version: '1', excerpt: 'KI kann beim Planen helfen. Der Guide kostet 59 EUR.' }],
    targets: [{ url: 'https://example.org/guide', promise: 'Ein Guide, kein kostenloser Download.' }], boards: ['Planung'],
    inputs: { metrics: [{ metric: 'outbound_clicks', unit: 'count', period: '2026-10', level: 'pin', sourceId: 's1', value: 2 }] },
    budget: { usd: 5, tokens: 40000, ms: 600000 } };
}
function rig() {
  let state = C.initial(), seq = 0;
  const send = command => {
    const out = C.reduce(state, { expectedRevision: state.revision, ...command }, { id: 'id-' + (++seq), now: 1000 + seq });
    state = out.state; return out.result;
  };
  const t = send(createCommand());
  return { send, state: () => state, task: () => state.tasks[t.id], id: t.id };
}
const reserve = { usd: 0.1, tokens: 2000, ms: 10000 };
const usage = { usd: 0.01, tokens: 100, ms: 100 };
const facts = { facts: [{ text: '59 EUR', sourceId: 's1' }], uncertainties: [] };
const pins = { pins: [{ id: 'p1', title: 'Planen mit KI', description: 'Struktur ausprobieren', overlay: 'Dein Plan mit KI',
  url: 'https://example.org/guide', board: 'Planung', sourceIds: ['s1'] }] };
const review = { passed: true, dimensions: { facts: true, brand: true, visual: true, complete: true }, findings: [] };
function step(r, output) {
  const a = r.send({ type: 'attempt.start', taskId: r.id, reserve });
  r.send({ type: 'attempt.finish', taskId: r.id, attemptId: a.id, ok: true, output, usage });
  return a;
}
function ready(r) {
  step(r, facts); step(r, pins);
  r.send({ type: 'task.design', taskId: r.id, artifacts: [{ pinId: 'p1', businessUnitId: 'lifestruct', sha256: 'a'.repeat(64), mime: 'image/png' }] });
  r.send({ type: 'task.formal', taskId: r.id, verified: true, digest: C.snapshotDigest(r.task()) });
  step(r, review);
}
function approve(r) { return r.send({ type: 'approval.decide', taskId: r.id, digest: C.snapshotDigest(r.task()), decision: 'approve', pinIds: ['p1'], actions: ['export', 'publish'] }); }
function action(r, approval) { return { type: 'action.prepare', taskId: r.id, approvalId: approval.id, action: 'publish', pinIds: ['p1'],
  account: r.task().account, audience: r.task().audience, schedule: r.task().schedule }; }

test('13 templates; separate brand identities with shared capability versions', () => {
  assert.equal(Object.keys(Catalog.PROCESSES).length, 13);
  assert.notEqual(Catalog.agents().find(a => a.businessUnitId === 'lifestruct' && a.role === 'editorial').id,
    Catalog.agents().find(a => a.businessUnitId === 'ashveil' && a.role === 'editorial').id);
  assert.equal(Catalog.agentBrand('colony_ashveil_editorial'), 'ashveil');
  assert.equal(Catalog.agentBrand('colony_ashveil_unknown'), null);
});
test('hard brand filters: feedback, lead, unknown legacy; explicit context rejects foreign data', () => {
  const rows = ['agent', 'hsr_writer', 'colony_ashveil_editorial', 'unknown'].map(agentId => ({ agentId, records: ['test'] }));
  assert.deepEqual(Boundary.sharedNotebooks('life_content', rows).map(x => x.agentId), ['agent']);
  assert.deepEqual(Boundary.sharedNotebooks('colony_coordinator', rows).map(x => x.agentId), ['unknown']);
  assert.equal(Boundary.sameBrand('life_content', 'hsr_writer'), false);
  assert.equal(Boundary.sameBrand('life_content', 'life_review'), true);
  assert.equal(Boundary.sameBrand('agent', 'unbranded-scribe', { legacy: false }), true, 'ordinary upstream stations are not silently classified as Lifestruct');
  const r = rig(), packet = C.context(r.state(), r.id, 'review');
  packet.sources[0].businessUnitId = 'ashveil';
  assert.throws(() => Boundary.assertContext('colony_lifestruct_review', packet), /FOREIGN/);
});
test('bad scope, stale revision, missing budgets and unknown processes fail without mutation', () => {
  const r = rig(), before = JSON.stringify(r.state());
  assert.throws(() => r.send({ ...createCommand(), businessUnitId: 'ashveil' }), /BRAND_MISMATCH/);
  assert.throws(() => r.send({ ...createCommand(), expectedRevision: 0 }), /REVISION/);
  assert.throws(() => r.send({ ...createCommand(), budget: { usd: 0, tokens: 10, ms: 10 } }), /BUDGET_REQUIRED/);
  assert.throws(() => r.send({ ...createCommand(), processId: 'UNKNOWN' }), /NOT_CONNECTED/);
  assert.throws(() => r.send({ ...createCommand(), processId: 'A01' }), /BRAND_MISMATCH/);
  assert.equal(JSON.stringify(r.state()), before);
});
test('full checked version only enters inbox; independent reviewer and no self-argument in initial context', () => {
  const r = rig(); ready(r);
  assert.equal(r.task().status, 'ready_for_approval'); assert.ok(C.quality(r.task()));
  assert.notEqual(r.task().producerAgentId, r.task().review.agentId);
  assert.equal(r.task().attempts.at(-1).context.producerQualityArgument, undefined);
  const a = approve(r); assert.equal(a.digest, C.snapshotDigest(r.task()));
  const changed = structuredClone(r.task()); changed.pins[0].description += ' text-only change';
  assert.notEqual(C.snapshotDigest(changed), a.digest, 'text changes invalidate the full object even with unchanged PNG');
});
test('missing visual review, open findings and bare pass cannot become ready', () => {
  for (const output of [{ ...review, dimensions: { ...review.dimensions, visual: false } },
    { ...review, findings: [{ pinId: 'p1', dimension: 'facts', message: 'Falsches Versprechen' }] }]) {
    const r = rig(); ready(r);
    // Re-run after content/audience change, which invalidates the old review.
    r.send({ type: 'task.change', taskId: r.id, patch: { audience: 'Andere Zielgruppe' } });
    r.send({ type: 'task.formal', taskId: r.id, verified: true, digest: C.snapshotDigest(r.task()) });
    step(r, output); assert.notEqual(r.task().status, 'ready_for_approval');
    assert.throws(() => approve(r), /UNCHECKED/);
  }
});
test('independent review output stays compact and uses actionable bounded findings', () => {
  const r = rig(); step(r, facts); step(r, pins);
  r.send({ type: 'task.design', taskId: r.id, artifacts: [{ pinId: 'p1', businessUnitId: 'lifestruct', sha256: 'a'.repeat(64), mime: 'image/png' }] });
  r.send({ type: 'task.formal', taskId: r.id, verified: true, digest: C.snapshotDigest(r.task()) });
  const bad = { ...review, findings: Array.from({ length: 7 }, (_, i) => ({ pinId: 'p1', dimension: 'facts', message: 'Issue ' + i })), summary: 'Review' };
  assert.throws(() => { const a = r.send({ type: 'attempt.start', taskId: r.id, reserve }); r.send({ type: 'attempt.finish', taskId: r.id, attemptId: a.id, ok: true, output: bad, usage }); }, /COLONY_INVALID_REVIEW/);
});
test('rejection creates brand-scoped human feedback and KVP case; only changed components rerun', () => {
  const r = rig(); ready(r); const oldFacts = structuredClone(r.task().facts);
  r.send({ type: 'approval.decide', taskId: r.id, digest: C.snapshotDigest(r.task()), decision: 'reject',
    pinIds: ['p1'], actions: ['export'], feedback: 'Der Text soll konkreter sein.' });
  assert.equal(Object.keys(r.state().cases).length, 1);
  assert.equal(r.state().feedback[0].businessUnitId, 'lifestruct');
  assert.equal(C.nextStep(r.task()), 'editorial');
  const a = step(r, pins); assert.equal(a.context.findings[0].dimension, 'human');
  assert.deepEqual(r.task().facts, oldFacts); assert.equal(r.task().review, null);
  assert.equal(r.task().activeApproval, null);
});
test('action scope, revocation, changed schedule and overlapping duplicate deliveries fail closed', () => {
  const r = rig(); ready(r); const a = approve(r);
  assert.throws(() => r.send({ ...action(r, a), account: 'wrong' }), /SCOPE/);
  const act = r.send(action(r, a));
  r.send({ type: 'action.uncertain', actionId: act.id, reason: 'Upload-Ergebnis unklar' });
  assert.throws(() => r.send(action(r, a)), /ALREADY_RECORDED/);
  r.send({ type: 'action.confirm', actionId: act.id, evidence: 'Manuell kontrollierte externe ID 123' });
  assert.equal(r.state().actions[act.id].state, 'confirmed');
  r.send({ type: 'task.change', taskId: r.id, patch: { schedule: '2026-10-24 Europe/Berlin' } });
  assert.throws(() => r.send(action(r, a)), /NOT_APPROVED/);
  const r2 = rig(); ready(r2); const a2 = approve(r2);
  r2.send({ type: 'approval.revoke', approvalId: a2.id });
  assert.throws(() => r2.send(action(r2, a2)), /NOT_APPROVED/);
});
test('interruption preserves confirmed steps; unknown spend prevents replay until evidenced resolution', () => {
  const r = rig(); step(r, facts); const a = r.send({ type: 'attempt.start', taskId: r.id, reserve });
  r.send({ type: 'recovery.scan', liveAttempts: [] });
  assert.equal(r.task().facts.facts[0].text, '59 EUR'); assert.equal(r.task().status, 'blocked');
  assert.throws(() => r.send({ type: 'attempt.start', taskId: r.id, reserve }), /NOT_RUNNABLE/);
  r.send({ type: 'recovery.resolve', taskId: r.id, usage, evidence: 'Kosten anhand des Run-Protokolls abgeglichen.' });
  assert.equal(C.nextStep(r.task()), 'editorial');
  assert.throws(() => r.send({ type: 'attempt.finish', taskId: r.id, attemptId: a.id, ok: true, output: pins, usage }), /STALE/);
});
test('budget reservations fence concurrent starts and no unpriced result is called free', () => {
  const r = rig();
  assert.throws(() => r.send({ type: 'attempt.start', taskId: r.id, reserve: { ...reserve, usd: 6 } }), /EXHAUSTED/);
  const a = r.send({ type: 'attempt.start', taskId: r.id, reserve });
  assert.throws(() => r.send({ type: 'attempt.start', taskId: r.id, reserve }), /NOT_RUNNABLE/);
  r.send({ type: 'attempt.finish', taskId: r.id, attemptId: a.id, ok: true, output: facts, usage: null });
  assert.equal(r.task().spent.unknown, true); assert.equal(r.task().status, 'blocked');
  r.send({ type: 'recovery.resolve', taskId: r.id, usage, evidence: 'Manuell verifizierter Verbrauch aus dem Run-Protokoll.' });
  assert.equal(r.task().spent.usd, usage.usd, 'resolution replaces the provisional reserve instead of counting twice');
});
test('legacy dashboard never grants approval; separate account/revision/export history', () => {
  const input = { businessUnitId: 'homestackr', account: 'h', revision: 4, pins: [{ id: 'old', status: 'exported', history: ['kept'] }] };
  const p = importSnapshot(input, 'homestackr', 'h');
  assert.equal(p.pins[0].colonyApproval, null); assert.equal(p.pins[0].externalStatus, 'exported');
  assert.equal(p.readOnly, true); assert.equal(p.connected, false);
  assert.throws(() => importSnapshot(input, 'lifestruct', 'h'), /SCOPE/);
});
test('durable service reload, CAS concurrency, invalid-result accounting, corruption blocks writes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-tests-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let n = 0; const deps = { fs, path, root, now: () => 1000 + (++n), newId: () => 'test-' + (++n) };
  const svc = makeService(deps);
  const c = await svc.command({ ...createCommand(), expectedRevision: 0 }); const id = c.result.id;
  const clash = await Promise.allSettled([svc.command({ type: 'task.change', taskId: id, patch: { audience: 'A' }, expectedRevision: 1 }),
    svc.command({ type: 'task.change', taskId: id, patch: { audience: 'B' }, expectedRevision: 1 })]);
  assert.equal(clash.filter(x => x.status === 'fulfilled').length, 1);
  await svc.run(id, svc.read().revision, reserve, async () => ({ ok: true, usage, output: { facts: [{ sourceId: 'invented', text: 'wrong' }], uncertainties: [] } }));
  const restored = makeService(deps); assert.equal(restored.read().tasks[id].spent.usd, usage.usd);
  assert.equal(restored.read().tasks[id].status, 'blocked');
  fs.writeFileSync(path.join(root, 'colony', 'state.json'), '{bad');
  assert.throws(() => restored.read(), /RECOVERY/);
  await assert.rejects(restored.command({ ...createCommand(), expectedRevision: 3 }), /RECOVERY/);
});

test('total token admission caps native provider request, refuses insufficient prompt headroom', async () => {
  const { runAgentLoop } = require('../sidecar/loop.js');
  const { makeReplayProvider } = require('../sidecar/providers/replay.js');
  const { makeCostEngine } = require('../sidecar/cost.js');
  const { makeContext } = require('../sidecar/context.js');
  for (const cap of [10, 500]) {
    const provider = makeReplayProvider({ turns: [[{ type: 'text', delta: 'ok' }, { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } }, { type: 'done', finishReason: 'stop' }]] });
    const stream = provider.stream.bind(provider), requests = [];
    provider.stream = req => { requests.push(req); return stream(req); };
    const result = await runAgentLoop({ provider, messages: [{ role: 'user', content: 'test' }], model: 'replay/model', emit: () => {},
      cost: makeCostEngine({ priceOf: () => ({ in: 1, out: 1 }) }), context: makeContext({ contextLimit: 8000 }),
      limits: { maxTotalTokens: cap, grace: false, maxIters: 1 } });
    if (cap === 10) { assert.equal(result.reason, 'budget'); assert.equal(requests.length, 0); }
    else { assert.equal(result.reason, 'done'); assert.ok(requests[0].maxTokens < cap); }
  }
});

test('global preferences require owner confirmation and secret-shaped input is not persisted', async t => {
  const r = rig();
  assert.throws(() => r.send({ type: 'preference.global', text: 'Kurze Antworten' }), /REQUIRES_OWNER/);
  r.send({ type: 'preference.global', confirmedGlobal: true, text: 'Kurze Antworten' });
  assert.equal(C.context(r.state(), r.id, 'review').preferences[0].scope, 'global');
  const root = fs.mkdtempSync('/tmp/opencode/colony-secret-test-'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const svc = makeService({ fs, path, root, now: () => 1, newId: () => 'id' });
  await assert.rejects(svc.command({ type: 'preference.global', confirmedGlobal: true,
    text: 'api_key=sk-proj-' + 'a'.repeat(30), expectedRevision: 0 }), /SECRET_IN_INPUT/);
  assert.equal(svc.read().revision, 0);
});

test('additive three-room migration preview uses native compiler, preserves old work and refuses duplicate application', () => {
  const WM = require('../frontend/app/worldmodel.js');
  const P = require('../frontend/app/pipeline.js');
  const { create } = require('../lab/workflow.cjs');
  const { prepare } = require('../lab/colony-authoring.cjs');
  const life = require('../lab/fixtures/lifestruct.json'), st = WM.create(WM.starterDoc());
  create(st, life, new Set(life.steps.map(s => s.agentId)));
  const source = { agent: { id: 'agent', name: 'Legacy', provider: 'custom', model: '' },
    agents: [{ id: 'life_content' }, { id: 'life_review' }], station: st.serialize(), workstreams: [{ id: 'keep-me' }] };
  const before = structuredClone(source), preview = prepare(source);
  assert.deepEqual(source, before); assert.deepEqual(preview.save.workstreams, before.workstreams);
  assert.deepEqual(preview.save.agent, before.agent); assert.equal(preview.report.previewOnly, true);
  assert.equal(Object.keys(preview.mappings).length, 13); assert.equal(P.ok(preview.plan), true);
  const world = WM.create(preview.save.station);
  assert.ok(Object.values(preview.mappings).every(m => m.blueprint === 'fire_escape' && m.backendFinalReview === true), 'all process quality loops reuse the existing Review + Fixer blueprint and keep the Colony final-review gate');
  const l01 = preview.mappings.L01, nativeQualityBays = l01.steps.map(id => world.propById(id));
  assert.deepEqual(nativeQualityBays.map(p => p.role), ['WRITER', 'REVIEWER', 'FIXER'], 'no custom bays or conveyor stages are added to the preset');
  assert.deepEqual(l01.standaloneRoles, ['research']); assert.equal(l01.roleDocks.editorial, l01.steps[0]);
  assert.equal(world.lineGraph(l01.intake).graph.nodes.filter(p => p.t === 'bay').length, 3);
  for (const brand of Object.keys(Catalog.BRANDS)) assert.equal(world.roomById(preview.rooms[brand]).name, Catalog.BRANDS[brand].name);
  for (const prop of st.props()) assert.deepEqual(world.propById(prop.id), prop);
  assert.throws(() => prepare(preview.save), /ALREADY_PREPARED/);
});
