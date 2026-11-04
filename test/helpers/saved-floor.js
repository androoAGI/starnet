'use strict';
/* test/helpers/saved-floor.js — a SAVED FLOOR for a test to route by, built the way the product builds one.

   The saved floor is the routing authority (sidecar/routing/saved-authority.js): a test that needs work to route no longer posts a
   plan, it saves a station with the REAL save owner before the sidecar boots (or through POST /api/save at runtime), and a page
   would publish only a hint of it.

     lineStation({ agents, cyclic })  the canonical station document of INBOX > agent > agent > ... > OUTBOX in one row, each bay with
                                      its console (compute), exactly as a built line is saved. cyclic: the last bay feeds the first
                                      again, which the compiler refuses (CHAIN_CYCLE) — a floor that is saved, whole and not routable
     canonical(doc)                   a station document in the form the page saves: deserialized, geometry projected, serialized
     seedSavedFloor(workspace, station)  write it with the real SaveStore into a workspace before a sidecar boots there
     hintFor(station)                 what the page POSTs to /api/routing for that station: { version:1, plan, compilerLinks }
     savePath(workspace)              the primary file the authority reads */
const fs = require('node:fs');
const path = require('node:path');
const WM = require('../../frontend/app/worldmodel.js');
const Pipeline = require('../../frontend/app/pipeline.js');
const { makeSaveStore } = require('../../sidecar/savestore.js');

const clone = v => JSON.parse(JSON.stringify(v));
function canonical(doc) { const model = WM.deserialize(doc); model.projectGeometry(); return model.serialize(); }

function lineStation(o) {
  const agents = (o && o.agents) || ['alpha', 'beta'];
  const doc = WM.defaultDoc(); doc.meta.createdAt = 1;
  const last = 4 + 3 * agents.length;   // the OUTBOX tile; every bay is 3 tiles on from the one before it
  doc.rooms[doc.order[0]].rects = [{ x1: -2, y1: -2, x2: last + 2 + 2 * agents.length + 2, y2: 10 }];
  doc.props = [{ id: 'i1', t: 'intake', x: 0, y: 0, w: 1, h: 1, lineId: 'line-one', label: 'ONE' }];
  agents.forEach((agentId, i) => doc.props.push({ id: 'b' + (i + 1), t: 'bay', x: 4 + 3 * i, y: 0, w: 1, h: 1, agentId, brief: 'Stage ' + (i + 1) + ' of the saved line' }));
  doc.props.push({ id: 'o1', t: 'outbox', x: last, y: 0, w: 1, h: 1 });
  agents.forEach((agentId, i) => doc.props.push({ id: 'pc' + (i + 1), t: 'console', x: last + 2 + 2 * i, y: 0, w: 1, h: 1, agentId }));
  doc.belts = {};
  if (o && o.cyclic) {
    // INBOX > first bay > ... > last bay, and the last bay's output turns round under the line and enters the first bay again
    for (let x = 1; x < last - 3; x++) if (!(x >= 4 && (x - 4) % 3 === 0)) doc.belts[x + ',0'] = 'E';
    const out = last - 2;   // the tile after the last bay
    doc.belts[out + ',0'] = 'S'; doc.belts[out + ',1'] = 'W';
    for (let x = out - 1; x > 4; x--) doc.belts[x + ',1'] = 'W';
    doc.belts['4,1'] = 'N';
  } else {
    for (let x = 1; x < last; x++) if (!(x >= 4 && (x - 4) % 3 === 0)) doc.belts[x + ',0'] = 'E';
  }
  delete doc.links;
  return canonical(doc);
}

function savePath(workspace) { return path.join(workspace, 'agent.save.json'); }

function seedSavedFloor(workspace, station, opts) {
  const store = makeSaveStore({ fs, pathMod: path, root: workspace, clock: { now: () => Date.now() } });
  const wrote = store.save('agent', { schema: 'starnet.save', version: 6, updatedAt: Date.now(), _saveRevision: 0,
    _saveClient: (opts && opts.client) || 'saved-floor-helper', _saveDirty: true, agent: { id: 'agent' }, station }, { compareRevision: true });
  if (!wrote || !wrote.ok) throw new Error('the saved floor could not be seeded: ' + JSON.stringify(wrote));
  return { file: savePath(workspace) };
}

// what the page posts: the same compiler and per-dock room grants as the page's compileRouting, plus the links JSON would drop
function hintFor(station) {
  const model = WM.deserialize(station), plan = Pipeline.compileRoutingPlan(model.projectGeometry());
  for (const bay of plan.bays || []) bay.objects = model.bayObjects(bay.agentId, bay.propId);
  for (const bay of plan.dockBays || []) bay.objects = model.bayObjects(bay.agentId, bay.propId);
  return clone({ version: 1, plan, compilerLinks: plan.links || null });
}

module.exports = { lineStation, canonical, seedSavedFloor, hintFor, savePath, clone };
