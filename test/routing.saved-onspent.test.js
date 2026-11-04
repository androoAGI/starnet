/* node test/routing.saved-onspent.test.js — GitHub #122 ON THE PATH THAT SHIPS (batch-4c: line-hold x saved-floor).

   floor.onspent.seam proves a gate's onSpent policy survives the world model, the compiler and the posted-plan router. The posted-plan
   path is the one the saved-floor lane retired: the station now routes from the floor a person SAVED, read through
   makeSavedFloorProjection (save store -> station doc -> parsed.projectGeometry() -> Pipeline.compileRoutingPlan) and handed to the
   router as its savedProjection. This test runs a saved world document through exactly that: one loop gate on onSpent 'hold' and one on
   'escalate', then asks the saved router's loopGateAfter what each gate will do. The hold holds and the escalate escalates. A floor that
   never named the field has no onSpent anywhere and keeps the plan identity it has always had (pinned below), so no older saved floor
   reads as "changed". */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const A = require('./_assert.js');
const WM = require('../frontend/app/worldmodel.js');
const Save = require('../frontend/app/save.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const { makeSavedFloorProjection } = require('../sidecar/station-store.js');
const { makeSaveStore } = require('../sidecar/savestore.js');
const { geometry } = require('./helpers/line-hold-rig.js');

const canonical = raw => { const model = WM.deserialize(raw); model.projectGeometry(); return model.serialize(); };
// the rig's review line as a saved world document (the same document the app saves), with the gate's props as given
function docWith(gate, wiring) {
  const geo = geometry(gate, wiring || 'esc to an OUTBOX only');
  const doc = WM.defaultDoc(); doc.meta.createdAt = 1;
  for (const id in doc.rooms) for (const r of doc.rooms[id].rects) { r.x2 = 60; r.y2 = 30; }
  doc.props = geo.props.map(p => Object.assign({}, p, { block: undefined }));
  doc.belts = {};
  for (const b of geo.belts) doc.belts[b.x + ',' + b.y] = b.dir;
  delete doc.links;
  return canonical(doc);
}
// a station whose ONLY routing authority is the saved floor on disk: the actual save store, the actual projection, the actual router
function station(doc) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-onspent-'));
  let now = 1;
  const store = makeSaveStore({ fs, pathMod: path, root, clock: { now: () => now++ } });
  const result = store.save('agent', { schema: 'starnet.save', version: Save.CURRENT, updatedAt: now++, agent: { id: 'agent' },
    _saveRevision: 0, _saveClient: 'onspent-fixture', _saveDirty: true, station: doc }, { compareRevision: true });
  if (!result.ok) throw new Error('fixture actual save failed');
  const read = makeSavedFloorProjection({ agentId: 'agent', stamp: () => store.stamp('agent'), loadPrimaryState: () => store.loadPrimaryState('agent') });
  return { root, saved: read(), router: makeRouter({ savedProjection: read }) };
}
const roots = [];
try {
  const gates = {};
  for (const policy of ['hold', 'escalate']) {
    const s = station(docWith({ onSpent: policy, maxIter: 2 })); roots.push(s.root);
    A.eq([s.saved.status, s.saved.routingOk], ['ok', true], policy + ': the saved floor is deployable');
    const gate = s.router.loopGateAfter('reviewer', null, 'p3');
    A.ok(gate && gate.onSpent === policy, policy + ': the SAVED router, asked what the reviewer\'s gate will do, says ' + policy + ': ' + JSON.stringify(gate));
    A.eq(gate.max, 2, policy + ': and it is the gate the floor saved (two passes)');
    A.ok(!Object.values(s.saved.plan.junctions).some(j => j.kind === 'loop' && j.onSpent !== policy), policy + ': the plan the authority compiled carries it on its gate');
    gates[policy] = { gate, identity: s.saved.identity };
  }
  A.ok(gates.hold.identity !== gates.escalate.identity, 'the two policies are two floors: the policy is part of the plan identity, so a change of it reads as changed');

  // a floor that never named the field: no onSpent anywhere, and the plan identity it has always had
  const bare = station(docWith({ maxIter: 2 }, 'esc unwired')); roots.push(bare.root);
  const bareGate = bare.router.loopGateAfter('reviewer', null, 'p3');
  A.ok(bareGate && !('onSpent' in bareGate), 'a saved floor with no policy: its gate says nothing about onSpent: ' + JSON.stringify(bareGate));
  A.ok(!JSON.stringify(bare.saved.plan).includes('onSpent'), 'and nothing in its compiled plan names the field');
  const outbox = station(docWith({ maxIter: 2 })); roots.push(outbox.root);
  const outboxGate = outbox.router.loopGateAfter('reviewer', null, 'p3');
  A.ok(outboxGate && !('onSpent' in outboxGate), 'the same holds for a floor whose escalation lane ships into an OUTBOX: no policy named, none appears');
  // pinned from the plan this floor compiled to BEFORE the line-hold lane (checked against a39860621's pipeline.js and worldmodel.js)
  A.eq(bare.saved.identity, 'saved-plan-v1:f65f393837175d9af4bf0fcfbd7f290b8731b8edf48a289f7ddced282874b45f', 'and it keeps its exact plan identity hash (older saved floors are not seen as changed)');
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} }
}
A.report('routing.saved-onspent');
