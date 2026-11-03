/* Durable INBOX identity through the real saved model, compiler and line-stat readers. */
'use strict';
const A = require('./_assert.js');
const WM = require('../frontend/app/worldmodel.js');
const P = require('../frontend/app/pipeline.js');
const { makeLineSpend } = require('../sidecar/routing/line-spend.js');
const { lineStats } = require('../sidecar/routing/line-stats.js');
const clone = value => JSON.parse(JSON.stringify(value));
const planOf = station => P.compileRoutingPlan(station.projectGeometry());
const intakeLine = station => planOf(station).lines.find(line => line.intakes.includes('p2'));

function legacyDoc() {
  const doc = WM.starterDoc();
  doc.props = [
    { id: 'p1', t: 'bay', x: 10, y: 5, w: 1, h: 1, agentId: 'forge' },
    { id: 'p2', t: 'intake', x: 6, y: 5, w: 1, h: 1 },
    { id: 'p3', t: 'outbox', x: 14, y: 5, w: 1, h: 1 }
  ];
  doc._nid = 20; doc.belts = {}; delete doc.links;
  for (let x = 7; x <= 13; x++) doc.belts[x + ',6'] = 'E';
  return doc;
}

{
  const station = WM.deserialize(legacyDoc());
  const before = intakeLine(station);
  A.ok(!!before, 'legacy INBOX belongs to a compiled line');
  A.eq(before && before.lineId, 'p1', 'first migration preserves the existing key; history is not renamed');
  A.eq(station.propById('p2').lineId, 'p1', 'the INBOX persists that legacy identity');
  const saved = station.serialize();
  A.eq(saved.props.find(p => p.id === 'p2').lineId, 'p1', 'the identity crosses the save boundary');
  A.eq(WM.deserialize(saved).serialize(), saved, 'migration is idempotent on reload');

  let durable = null;
  const store = { now: () => 1000, load: () => clone(durable), save: value => { durable = clone(value); } };
  const spend = makeLineSpend(store);
  spend.note(before.lineId, 1.25);
  const receipt = { lineId: before.lineId, entryRunId: 'run-one', terminalRunId: 'run-one', outboxId: 'p3', at: 900 };
  const read = st => lineStats({ lines: planOf(st).lines, rows: [], since: 0, spentToday: makeLineSpend(store).spentToday, shipments: [receipt] }).lines.find(line => line.lineId === intakeLine(st).lineId);
  A.eq([read(station).usdToday, read(station).shipped], [1.25, 1], 'actual readers see the existing spend and shipment');
  A.eq(station.removeProp('p1').ok, true, 'the oldest machine is deleted through the model');
  A.ok(!!intakeLine(station), 'the remaining INBOX is still a line');
  A.eq(intakeLine(station).lineId, before.lineId, 'deleting the oldest machine preserves line identity');
  A.eq([read(station).usdToday, read(station).shipped], [1.25, 1], 'deletion preserves day spend and SHIPPED');
  const restarted = WM.deserialize(station.serialize());
  A.eq(intakeLine(restarted).lineId, before.lineId, 'identity survives save/reload after deletion');
  A.eq([read(restarted).usdToday, read(restarted).shipped], [1.25, 1], 'reopened ledgers still address the same saved line');
}

{
  const station = WM.create();
  A.ok(station.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 60, y2: 16 } }).ok, 'new floor');
  const made = station.addProp({ t: 'intake', x: 32, y: 5, w: 1, h: 1 });
  A.ok(made.ok, 'new INBOX placed');
  const prop = station.propById(made.id);
  A.ok(typeof prop.lineId === 'string' && prop.lineId.length > 0, 'new INBOX owns an identity before any belts connect');
  A.eq(WM.deserialize(station.serialize()).propById(made.id).lineId, prop.lineId, 'new identity survives save/reload');
}
{
  const doc = legacyDoc();
  doc.props.find(p => p.id === 'p2').lineId = 'line-p20';
  const station = WM.deserialize(doc);
  const added = station.addProp({ t: 'intake', x: 2, y: 2, w: 1, h: 1 });
  A.ok(added.ok && added.id === 'p20', 'fixture mints a prop whose default line ID already belongs to an imported door');
  A.ok(station.propById(added.id).lineId !== 'line-p20', 'new INBOX cannot borrow the imported ledger key');
  A.eq(new Set(station.props().filter(p => p.t === 'intake').map(p => p.lineId)).size, 2, 'both persisted door identities are unique before reload');
}
{
  const doc = legacyDoc();
  doc.props.find(p => p.id === 'p2').lineId = 'line-A';
  doc.props.push({ id: 'p4', t: 'intake', lineId: 'line-B', x: 6, y: 7, w: 1, h: 1 });
  const station = WM.deserialize(doc);
  A.eq(intakeLine(station).lineId, 'line-A', 'joined doors use the oldest INBOX as identity owner');
  A.eq(station.removeProp('p2').ok, true, 'owning INBOX can be removed');
  A.eq(station.propById('p4').lineId, 'line-B', 'removing an INBOX never overwrites another door historical identity');
  A.eq(planOf(station).lines.find(l => l.intakes.includes('p4')).lineId, 'line-B', 'the surviving intake resumes its own identity');
}
{
  const props = [
    { id: 'p2', t: 'intake', lineId: 'line-p2', x: 0, y: 0 },
    { id: 'p3', t: 'bay', agentId: 'forge', x: 3, y: 0 },
    { id: 'p10', t: 'intake', lineId: 'line-p10', x: 20, y: 0 },
    { id: 'p11', t: 'bay', agentId: 'forge', x: 23, y: 0 }
  ];
  const belts = [1, 2, 21, 22].map(x => ({ x, y: 0, dir: 'E' }));
  const plan = P.compileRoutingPlan({ props, belts });
  A.eq(plan.lines.map(l => l.lineId), ['line-p2', 'line-p10'], 'durable string IDs do not reorder the physical components');
  A.eq(plan.lineOfAgent.forge, 'line-p2', 'multi-bay first-line ownership retains its numeric prop order');
  const imported = clone(props); imported[0].lineId = 'zz-import'; imported[2].lineId = 'aa-import';
  A.eq(P.compileRoutingPlan({ props: imported, belts }).lineOfAgent.forge, 'zz-import', 'arbitrary imported IDs cannot change the selected physical line');
}
{
  const props = [
    { id: 'p1', t: 'bay', x: 0, y: 0 },
    { id: 'p2', t: 'intake', lineId: 'p1', x: 20, y: 0 },
    { id: 'p3', t: 'intake', lineId: 'unfed-p1', x: 40, y: 0 }
  ];
  const belts = [1, 21, 41].map(x => ({ x, y: 0, dir: 'E' }));
  const comps = P.lineComponents({ props, belts });
  A.eq(new Set(comps.map(c => c.key)).size, 3, 'unfed fragment suffix avoids every already-owned key');
  A.eq(comps.find(c => c.props.includes('p2')).key, 'p1', 'legacy saved owner keeps its key');
  A.eq(comps.find(c => c.props.includes('p3')).key, 'unfed-p1', 'reserved-looking imported owner keeps its key');
  A.ok(!['p1', 'unfed-p1'].includes(comps.find(c => c.props.includes('p1')).key), 'unfed fragment does not inherit either line ledger');
}
{
  const doc = legacyDoc();
  doc.props = doc.props.filter(p => p.id !== 'p1');
  doc.props.find(p => p.id === 'p2').lineId = 'line-A';
  doc.props.push({ id: 'p4', t: 'intake', lineId: 'line-B', x: 14, y: 7, w: 1, h: 1 });
  const joined = WM.deserialize(doc);
  A.eq(joined.propById('p4').lineId, 'line-B', 'joining components retains the second door own identity');
  const split = joined.serialize(); delete split.links; delete split.belts['10,6'];
  const reopened = WM.deserialize(split);
  const keys = planOf(reopened).lines.filter(l => l.intakes.length).map(l => l.lineId).sort();
  A.eq(keys, ['line-A', 'line-B'], 'a saved belt split restores each surviving intake own identity');
  const duplicated = clone(doc); duplicated.props.find(p => p.id === 'p4').lineId = 'line-A';
  const repaired = WM.deserialize(duplicated);
  A.eq(repaired.propById('p2').lineId, 'line-A', 'duplicate imported identity keeps its deterministic first owner');
  A.ok(repaired.propById('p4').lineId !== 'line-A', 'duplicate imported door receives a distinct identity');
  A.eq(WM.deserialize(repaired.serialize()).serialize(), repaired.serialize(), 'duplicate repair survives reload without a second rename');
}
A.report('line-intake-identity');
