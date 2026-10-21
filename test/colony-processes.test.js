'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const C = require('../sidecar/colony/core.js');
const P = require('../sidecar/colony/processes.js');
const { makeService } = require('../sidecar/colony/service.js');
const reserve = { usd: 0, tokens: 5000, ms: 10000 }, usage = { usd: null, tokens: 200, ms: 100 };
function inputs() {
  return {
    mails_1_to_7: Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1), body: 'Vorhandener echter Mailtext für diesen isolierten Test.' })), sequence: [0, 3, 6, 10, 15, 20, 27],
    audience: 'Test-Zielgruppe', schedule: 'Nur interner Test, kein Versand',
    demand_evidence: [{ id: 'd1', sourceId: 's1', metric: 'requests', value: 2, period: '2026-10' }],
    product_record: { id: 'product-1', files: ['original.stl'] }, print_evidence: [{ confirmed: true, confirmedBy: 'owner', variant: 'product-1', result: 'manual test' }],
    price: { amount: 10, currency: 'EUR' }, license: 'Bestätigte Testlizenz', file_inventory: [{ id: 'f1', path: 'original.stl', sha256: 'a'.repeat(64) }],
    owned_assets: [], rights: ['Bestätigt für isolierten Test'], channels: ['Pinterest'], dependencies: ['README', 'ZIP'],
    page_inventory: [{ id: 'page-1', url: 'https://example.org/page', purpose: 'Test-Seite' }], affiliate_inventory: [{ id: 'link-1', url: 'https://example.org/product' }],
    change_package: { version: 'test-v1', affectsTools: false }, checks: []
    , metrics: [{ metric: 'outbound_clicks', unit: 'count', period: '2026-10', level: 'pin', sourceId: 's1', value: 2 }]
  };
}
function rig(id) {
  let s = C.initial(), n = 0;
  const send = c => { const r = C.reduce(s, { ...c, expectedRevision: s.revision }, { id: 'test-' + (++n), now: 1000 + n }); s = r.state; return r.result; };
  send({ type: 'configuration.set', models: {}, accountingMode: 'tokens', poolBudget: { usd: 0, tokens: 200000, ms: 600000 }, enabled: true });
  const p = s.processes[id], data = inputs();
  if (id === 'A03') { const asset = send({ type: 'asset.register', verified: true, rightsConfirmed: true, businessUnitId: p.businessUnitId, account: 'test', sha256: 'a'.repeat(64) }); data.owned_assets = [{ id: asset.id, sha256: asset.sha256 }]; }
  const command = { type: 'task.create', processId: id, businessUnitId: p.businessUnitId, goal: 'Isolierter Funktionstest für ' + id, account: 'test', audience: 'Testgruppe', schedule: 'Kein externer Termin',
    sources: [{ id: 's1', businessUnitId: p.businessUnitId, confirmed: true, uri: 'https://example.org/source', asOf: '2026-10-21', version: 'test-v1', excerpt: 'Bestätigte Quelldaten für diesen synthetischen Test, keine echten Konten oder Veröffentlichungen.' }],
    targets: [{ url: 'https://example.org/page', promise: 'Test-Seite' }], boards: ['Testboard'], inputs: data, budget: { usd: 0, tokens: 150000, ms: 500000 } };
  const task = send(command);
  return { send, command, state: () => s, task: () => s.tasks[task.id], id: task.id };
}
function result(t, role) {
  if (role === 'research') return { facts: [{ text: 'Bestätigte Testdaten, keine Live-Ergebnisse.', sourceId: 's1' }], uncertainties: [] };
  if (role === 'review') return { passed: true, dimensions: { facts: true, brand: true, visual: true, complete: true }, findings: [] };
  if (role !== P.producer(t)) return { notes: [{ subject: 'Abgegrenzte Vorbereitung', finding: 'Belegter Ausgangsstand und noch nötige Prüfung.', sourceIds: ['s1'] }], blockers: [] };
  if (P.isPins(t)) return { pins: [{ id: 'item-1', title: 'Ein geprüfter Test', description: 'Keine öffentliche Ausspielung.', overlay: 'Ein interner Test', url: t.targets[0].url, board: t.boards[0], sourceIds: ['s1'] }] };
  const spec = t.processContract;
  const rows = Array.from({ length: spec.kind === 'sequence' ? 7 : 1 }, (_, i) => ({ id: spec.kind === 'sequence' ? String(i + 1) : 'item-1', sourceIds: ['s1'], ...Object.fromEntries(Object.keys(spec.fields).map(k => [k, 'Konkreter belegter Testinhalt für ' + k])) }));
  for (const row of rows) { if ('pageId' in row) row.pageId = 'page-1'; if ('url' in row) row.url = t.inputs.page_inventory[0].url; if ('assetId' in row) row.assetId = t.inputs.owned_assets[0].id; if ('channel' in row) row.channel = 'Pinterest'; if ('referenceId' in row) row.referenceId = 'link-1'; }
  if (spec.kind === 'optimization') rows[0].diagnosis = 'Belegte Testdaten, keine echte Conversion-Aussage.';
  if (spec.kind === 'listing') { rows[0].description += ' Download digitaler STL-Dateien.'; rows[0].files = structuredClone(t.inputs.product_record.files); rows[0].price = String(t.inputs.price.amount) + ' ' + t.inputs.price.currency; rows[0].license = t.inputs.license; }
  if (spec.kind === 'catalog') rows[0].files = structuredClone(t.inputs.file_inventory.map(({ path, sha256 }) => ({ path, sha256 })));
  return { items: rows, blockers: [] };
}
function modelStep(r, output) { const a = r.send({ type: 'attempt.start', taskId: r.id, reserve }); r.send({ type: 'attempt.finish', taskId: r.id, attemptId: a.id, usage, ok: true, output: output || result(r.task(), a.stepId) }); return a; }

for (const id of Object.keys(P.definitions)) test(id + ': genuine process-specific states, role, result schema, formal gate and independent approval', () => {
  const r = rig(id), seen = [];
  for (let i = 0; i < 10 && r.task().status !== 'ready_for_approval'; i++) {
    const next = C.nextStep(r.task()); seen.push(next);
    if (next === 'design' && P.isPins(r.task())) r.send({ type: 'task.design', taskId: r.id, artifacts: [{ pinId: 'item-1', businessUnitId: r.task().businessUnitId, sha256: 'a'.repeat(64), mime: 'image/png' }] });
    else if (next === 'formal') r.send({ type: 'task.formal', taskId: r.id, verified: true, digest: C.snapshotDigest(r.task()) });
    else modelStep(r);
  }
  assert.equal(r.task().status, 'ready_for_approval', id + ': ' + seen.join(' -> '));
  assert.ok(C.quality(r.task())); assert.equal(r.task().spent.usdUnknown, true); assert.equal(r.task().spent.unknown, false);
  assert.equal(r.task().attempts.some(a => a.stepId === 'fixer'), false, id + ': passing first review never calls the optional fixer');
  assert.notEqual(r.task().review.agentId, r.task().producerAgentId);
  assert.deepEqual(r.task().processRoles.filter(x => x !== 'design' || !P.isPins(r.task())).filter(x => x !== 'review'), seen.filter(x => !['formal', 'review', 'design'].includes(x) || (x === 'design' && !P.isPins(r.task()))));
  if (!P.isPins(r.task())) { assert.ok(r.task().items); assert.equal(r.task().pins, null); }
  const actions = r.state().processes[id].actions.length ? [r.state().processes[id].actions[0]] : ['accept'];
  const approval = r.send({ type: 'approval.decide', taskId: r.id, digest: C.snapshotDigest(r.task()), decision: 'approve', pinIds: C.selections(r.task()).map(x => x.id), actions });
  assert.equal(approval.actor, 'owner'); assert.equal(r.state().externalActionsEnabled, false);
});

test('required domain data, all seven sequence mails, confirmed asset scope and stable page IDs fail closed', () => {
  for (const id of ['A01', 'A02', 'A04', 'H01', 'H02', 'H04', 'H05', 'L02a', 'L03']) {
    const r = rig(id); assert.throws(() => r.send({ ...r.command, inputs: {} }), /INPUT_REQUIRED/);
  }
  const r = rig('L02a'), bad = structuredClone(r.command); bad.inputs.mails_1_to_7.pop(); assert.throws(() => r.send(bad), /ALL_SEVEN/);
  const h = rig('H01'); const output = result(h.task(), 'web'); output.items[0].pageId = 'invented'; assert.throws(() => modelStep(h, output), /UNKNOWN_PAGE/);
  const a = rig('A03'); const wrong = structuredClone(a.command); wrong.inputs.owned_assets[0].sha256 = 'b'.repeat(64); assert.throws(() => a.send(wrong), /ASSET_SCOPE/);
});
test('bounded internal revision preserves facts, sends concrete findings back, and detects no progress', () => {
  const r = rig('H02'); modelStep(r); modelStep(r);
  const original = structuredClone(r.task().items), facts = structuredClone(r.task().facts);
  for (let i = 0; i < 3; i++) {
    r.send({ type: 'task.formal', taskId: r.id, verified: true, digest: C.snapshotDigest(r.task()) });
    modelStep(r, { passed: false, dimensions: { facts: false, brand: true, complete: true }, findings: [{ pinId: 'item-1', dimension: 'facts', message: 'Konkreten Messbeleg ergänzen; keine Wirkung erfinden.' }] });
    if (r.task().status === 'blocked') break;
    const a = modelStep(r); assert.ok(a.context.findings.length); assert.deepEqual(r.task().facts, facts); assert.deepEqual(r.task().items, original);
  }
  assert.equal(r.task().status, 'blocked'); assert.equal(r.task().reason, 'revision_without_progress');
  assert.ok(Object.values(r.state().cases).some(c => c.trigger === 'revision_without_progress'));
});
test('exhausted revisions call the optional fixer once, then require a fresh independent review', () => {
  function exhaust(r) {
    modelStep(r); modelStep(r); // research, first producer output
    for (let i = 0; i < 4; i++) {
      r.send({ type: 'task.formal', taskId: r.id, verified: true, digest: C.snapshotDigest(r.task()) });
      modelStep(r, { passed: false, dimensions: { facts: false, brand: true, complete: true }, findings: [{ pinId: 'item-1', dimension: 'facts', message: 'Beleg zur konkreten Aussage ergänzen.' }] });
      if (i < 3) {
        const revised = result(r.task(), 'web'); revised.items[0].change = 'Korrektur-Runde ' + (i + 1);
        modelStep(r, revised);
      }
    }
    assert.equal(r.task().status, 'needs_revision'); assert.equal(C.nextStep(r.task()), 'fixer');
    assert.equal(r.task().revisionRounds, 3);
  }
  const r = rig('H02'); exhaust(r);
  const fixer = r.send({ type: 'attempt.start', taskId: r.id, reserve });
  assert.match(fixer.context.roleInstructions, /begrenzte Eskalation/);
  assert.match(fixer.context.roleInstructions, /neuer unabhängiger Review/);
  const repaired = result(r.task(), 'web'); repaired.items[0].change = 'Gezielte Fixer-Korrektur nach Befund.';
  r.send({ type: 'attempt.finish', taskId: r.id, attemptId: fixer.id, usage, ok: true, output: repaired });
  assert.equal(C.nextStep(r.task()), 'formal');
  r.send({ type: 'task.formal', taskId: r.id, verified: true, digest: C.snapshotDigest(r.task()) });
  const finalReview = r.send({ type: 'attempt.start', taskId: r.id, reserve });
  assert.equal(finalReview.stepId, 'review');
  r.send({ type: 'attempt.finish', taskId: r.id, attemptId: finalReview.id, usage, ok: true,
    output: { passed: true, dimensions: { facts: true, brand: true, complete: true }, findings: [] } });
  assert.equal(r.task().status, 'ready_for_approval'); assert.ok(C.quality(r.task()));
  assert.notEqual(r.task().review.agentId, r.task().fixerAgentId);
  assert.deepEqual(r.task().attempts.filter(a => a.stepId === 'fixer').length, 1);

  const rejected = rig('H02'); exhaust(rejected);
  const fixerAttempt = rejected.send({ type: 'attempt.start', taskId: rejected.id, reserve });
  const secondRepair = result(rejected.task(), 'web'); secondRepair.items[0].change = 'Eine andere gezielte Korrektur.';
  rejected.send({ type: 'attempt.finish', taskId: rejected.id, attemptId: fixerAttempt.id, usage, ok: true, output: secondRepair });
  rejected.send({ type: 'task.formal', taskId: rejected.id, verified: true, digest: C.snapshotDigest(rejected.task()) });
  modelStep(rejected, { passed: false, dimensions: { facts: false, brand: true, complete: true }, findings: [{ pinId: 'item-1', dimension: 'facts', message: 'Weiterhin unbelegt; menschliche Klärung nötig.' }] });
  assert.equal(rejected.task().status, 'blocked'); assert.equal(rejected.task().reason, 'fixer_final_review_failed');
  assert.ok(Object.values(rejected.state().cases).some(c => c.trigger === 'fixer_final_review_failed'));
});
test('unknown dollar cost is not free; token mode requires explicit owner configuration, and unknown usage still blocks', () => {
  const r = rig('H01'); const a = r.send({ type: 'attempt.start', taskId: r.id, reserve });
  r.send({ type: 'attempt.finish', taskId: r.id, attemptId: a.id, ok: false, usage: null });
  assert.equal(r.task().spent.unknown, true); assert.equal(r.task().status, 'blocked');
  assert.throws(() => r.send({ type: 'attempt.start', taskId: r.id, reserve }), /NOT_RUNNABLE/);
  const fresh = C.initial(); assert.throws(() => C.reduce(fresh, { ...r.command, accountingMode: 'tokens', expectedRevision: 0 }, { id: 'x', now: 1 }), /REQUIRES_OWNER/);
});
test('catalog upgrade leaves running task contract and facts pinned', () => {
  const r = rig('H02'); modelStep(r); const before = structuredClone(r.task());
  r.send({ type: 'catalog.sync' }); assert.deepEqual(r.task(), before);
  assert.equal(C.context(r.state(), r.id, 'web').roleInstructions.includes(before.processContract.rule), true);
});
test('catalog sync adds optional fixer identities to an already-installed older roster', () => {
  const old = C.initial(); delete old.roles.fixer; old.agents = old.agents.filter(a => a.role !== 'fixer');
  const synced = C.reduce(old, { type: 'catalog.sync', expectedRevision: 0 }, { id: 'catalog-upgrade', now: 1 }).state;
  assert.equal(synced.roles.fixer.name, 'Eskalations-Fixer');
  for (const brand of ['lifestruct', 'ashveil', 'homestackr']) assert.ok(synced.agents.some(a => a.id === 'colony_' + brand + '_fixer'));
});
test('stale research uncertainty about a missing PNG is reconciled only after the complete artifact set is host-verified', () => {
  const r = rig('L01'); modelStep(r, { facts: [{ text: 'A source-backed fact about the test account.', sourceId: 's1' }], uncertainties: ['No visual artifacts or PNGs were provided; review cannot assess readability.'] });
  modelStep(r); assert.match(C.nextStep(r.task()), /design/);
  r.send({ type: 'task.design', taskId: r.id, artifacts: [{ pinId: 'item-1', businessUnitId: 'lifestruct', sha256: 'c'.repeat(64), mime: 'image/png' }] });
  assert.deepEqual(r.task().facts.uncertainties, []);
  assert.equal(r.task().factReconciliations[0].resolvedBy, 'host_verified_complete_artifact_set');
  r.send({ type: 'task.formal', taskId: r.id, verified: true, digest: C.snapshotDigest(r.task()) });
  const attempt = r.send({ type: 'attempt.start', taskId: r.id, reserve });
  assert.equal(attempt.context.factReconciliations.length, 1);
  assert.equal(attempt.context.artifacts.length, 1);
});
test('durable service: content manifests survive restart; missing mobile evidence cannot pass H05', async t => {
  for (const id of ['H01', 'H05']) {
    const root = fs.mkdtempSync('/tmp/opencode/colony-contracts-'); t.after(() => fs.rmSync(root, { recursive: true, force: true })); let n = 0;
    const deps = { fs, path, root, now: () => ++n, newId: () => 'run-' + (++n) }, svc = makeService(deps), r = rig(id);
    await svc.command({ type: 'configuration.set', expectedRevision: 0, models: {}, accountingMode: 'tokens', poolBudget: { usd: 0, tokens: 200000, ms: 600000 }, enabled: true });
    const created = await svc.command({ ...r.command, expectedRevision: svc.read().revision });
    await svc.runToGate(created.result.id, svc.read().revision, reserve, async a => ({ ok: true, usage, output: result(svc.read().tasks[a.taskId], a.stepId) }));
    const restored = makeService(deps), task = restored.read().tasks[created.result.id];
    if (id === 'H01') { assert.equal(task.status, 'ready_for_approval'); assert.equal(restored.artifact(task.artifacts[0].sha256).items[0].pageId, 'page-1'); }
    else { assert.equal(task.status, 'blocked'); assert.match(task.reason, /checks_missing/); }
  }
});

test('service routes malformed producer JSON into one bounded internal revision before review', async t => {
  const root = fs.mkdtempSync('/tmp/opencode/colony-output-repair-'); t.after(() => fs.rmSync(root, { recursive: true, force: true })); let n = 0;
  const svc = makeService({ fs, path, root, now: () => ++n, newId: () => 'repair-' + (++n) });
  await svc.command({ type: 'configuration.set', expectedRevision: 0, models: {}, accountingMode: 'tokens', poolBudget: { usd: 0, tokens: 200000, ms: 600000 }, enabled: true });
  const template = C.initial().processes.L01;
  const task = await svc.command({ type: 'task.create', expectedRevision: 1, processId: 'L01', businessUnitId: 'lifestruct', testOnly: true, goal: 'Isolated JSON repair test', account: 'fixture', audience: 'test', schedule: 'none',
    sources: [{ id: 's1', businessUnitId: 'lifestruct', confirmed: true, uri: 'https://example.org/', asOf: '2026-10-21', version: '1', excerpt: 'Confirmed synthetic source facts for this automated test only.' }],
    targets: [{ url: 'https://example.org/guide', promise: 'Synthetic test target' }], boards: ['Test'], inputs: { pinCount: 1 }, budget: { usd: 0, tokens: 150000, ms: 500000 } });
  let editorialCalls = 0, repairFindings = null;
  const run = async attempt => {
    if (attempt.stepId === 'research') return { ok: true, usage, output: { facts: [{ sourceId: 's1', text: 'Confirmed synthetic fact for this test.' }], uncertainties: [] } };
    if (attempt.stepId === 'editorial') {
      editorialCalls++;
      if (editorialCalls === 2) repairFindings = attempt.context.findings;
      return { ok: true, usage, output: { pins: [{ id: 'test-pin', title: 'Test pin', overlay: 'Test overlay', description: editorialCalls === 1 ? 'x'.repeat(501) : 'Short validated description.', url: 'https://example.org/guide', board: 'Test', sourceIds: ['s1'] }] } };
    }
    if (attempt.stepId === 'review') return { ok: true, usage, output: { passed: true, dimensions: { facts: true, brand: true, visual: true, complete: true }, findings: [] } };
    assert.fail('Unexpected model stage ' + attempt.stepId);
  };
  const output = await svc.runToGate(task.result.id, svc.read().revision, reserve, run);
  assert.equal(editorialCalls, 2); assert.equal(output.result.status, 'ready_for_approval');
  assert.match(repairFindings[0].message, /500/);
  assert.equal(output.result.attempts.filter(a => a.stepId === 'editorial').length, 2);
  assert.equal(output.result.attempts.find(a => a.stepId === 'editorial').state, 'failed');
  assert.equal(output.result.review.findings.length, 0);
  assert.ok(output.result.spent.tokens > usage.tokens * 3, 'failed first draft consumes budget and is retained');
});
