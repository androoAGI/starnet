'use strict';
/* test/helpers/saved-floor.js — a SAVED FLOOR for a test to route by, built the way the product builds one.

   The saved floor is the routing authority (sidecar/routing/saved-authority.js): a test that needs work to route no longer posts a
   plan, it saves a station with the REAL save owner (before the sidecar boots, or through POST /api/save at runtime), and a page
   would publish only a hint of it. A POST /api/routing is a question — is this exactly the saved floor? — and never an order.

     lineStation({ agents, cyclic })  the canonical station document of INBOX > agent > agent > ... > OUTBOX in one row, each bay with
                                      its console (compute), exactly as a built line is saved. cyclic: the last bay feeds the first
                                      again, which the compiler refuses (CHAIN_CYCLE) — a floor that is saved, whole and not routable
     floorOf(geo, { equip })          the canonical station document of a hand-written geometry, { props, belts: [{ x, y, dir }] }:
                                      the shape these tests always compiled a plan from. equip lists what every bay's room holds
                                      (default ['computer']; also 'workbench', 'cabinet', 'dish', 'notebook'); [] is an unequipped
                                      bay, which the floor paints NO COMPUTE. A console is dedicated to each crewed bay's agent
     canonical(doc)                   a station document in the form the page saves: deserialized, geometry projected, serialized
     emptyFloor()                     a founded station with nothing built on it: compiles clean, routes nothing
     seedSavedFloor(workspace, station, { save, client })  write it with the real SaveStore into a workspace before a sidecar boots
                                      there; save is the rest of the station's save (agent, workstreams...), migrated to the current version
     hintFor(station)                 what the page POSTs to /api/routing for that station: { version:1, plan, compilerLinks }
     planOf(hint)                     the compiled plan inside a hint with the compiler's links put back, for a test to read
     publishFloor(api, station, opts) save the station through POST /api/save, then publish its hint: the two things a page does, in
                                      the order it does them. The rest of the save (sessions, agent...) is kept, as a page keeps it.
                                      Throws unless the save lands and the hint answers 200 (opts.expect names another status, 422 for
                                      a floor the compiler refuses). Returns { hint, plan, receipt }
     fetchApi(base, headers)          the { json(method, route, body) } publishFloor wants, over fetch, for a test that boots by hand
     savePath(workspace)              the primary file the authority reads */
const fs = require('node:fs');
const path = require('node:path');
const WM = require('../../frontend/app/worldmodel.js');
const Pipeline = require('../../frontend/app/pipeline.js');
const Save = require('../../frontend/app/save.js');
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

// the prop that puts each capability object in a room (worldmodel.js CAP_PROP_MAP): one shared prop per object, bar a console, which is
// a crewed bay's own
const EQUIP_PROP = Object.freeze({ workbench: 'workbench', cabinet: 'safe', dish: 'comms_dish', notebook: 'core', studio: 'studio', jukebox: 'jukebox' });

function floorOf(geo, o) {
  const equip = (o && Array.isArray(o.equip)) ? o.equip : ['computer'];
  for (const what of equip) if (what !== 'computer' && !EQUIP_PROP[what]) throw new Error('floorOf cannot equip a room with ' + what);
  const props = clone((geo && geo.props) || []), belts = (geo && geo.belts) || [];
  const xs = [], ys = [];
  for (const p of props) { xs.push(p.x, p.x + (p.w || 1) - 1); ys.push(p.y, p.y + (p.h || 1) - 1); }
  for (const b of belts) { xs.push(b.x); ys.push(b.y); }
  if (!xs.length) throw new Error('floorOf needs a geometry');
  const x1 = Math.min(...xs) - 2, x2 = Math.max(...xs) + 2, y2 = Math.max(...ys) + 4;
  const doc = WM.defaultDoc(); doc.meta.createdAt = 1;
  doc.rooms[doc.order[0]].rects = [{ x1, y1: Math.min(...ys) - 2, x2: Math.max(x2, x1 + 2 * (props.length + equip.length) + 2), y2 }];
  // the equipment stands in a row under the whole floor, in the one room every bay is in, clear of every belt
  const row = Math.max(...ys) + 2;
  let at = x1 + 1;
  const place = (t, extra) => { props.push(Object.assign({ id: 'eq' + (props.length + 1), t, x: at, y: row, w: 1, h: 1 }, extra || {})); at += 2; };
  const crewed = [...new Set(props.filter(p => p.t === 'bay' && p.agentId).map(p => p.agentId))];
  if (equip.includes('computer')) for (const agentId of crewed) place('console', { agentId });
  for (const what of equip) if (what !== 'computer') place(EQUIP_PROP[what]);
  doc.props = props;
  doc.belts = {};
  for (const b of belts) doc.belts[b.x + ',' + b.y] = b.dir;
  delete doc.links;
  return canonical(doc);
}

function savePath(workspace) { return path.join(workspace, 'agent.save.json'); }

// a founded station with nothing built on it yet: the starter room and no machine. It compiles clean and routes nothing, which is what a
// station that has not drawn a line has saved (a save with no station document at all is a floor that cannot be proved, and is held)
function emptyFloor() { const doc = WM.defaultDoc(); doc.meta.createdAt = 1; return canonical(doc); }

/* opts.client names the writer; opts.save is the rest of the save a station carries (its agent, workstreams, roster...), written beside the
   floor in the one save the real owner makes. A save of an older version is migrated first, as the page migrates it on load. */
function seedSavedFloor(workspace, station, opts) {
  const store = makeSaveStore({ fs, pathMod: path, root: workspace, clock: { now: () => Date.now() } });
  const rest = (opts && opts.save) ? Save.fromDoc(clone(opts.save)).doc : {};
  const wrote = store.save('agent', Object.assign({ schema: 'starnet.save', version: Save.CURRENT, updatedAt: Date.now(), agent: { id: 'agent' } }, rest,
    { _saveRevision: 0, _saveClient: (opts && opts.client) || 'saved-floor-helper', _saveDirty: true, station }), { compareRevision: true });
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

// the plan a hint carries, as the compiler hands it out: JSON drops the links, so they are put back, out of sight like the compiler's
function planOf(hint) {
  const plan = clone(hint.plan);
  Object.defineProperty(plan, 'links', { value: clone(hint.compilerLinks), enumerable: false });
  return plan;
}

function fetchApi(base, headers) {
  const at = v => (typeof v === 'function' ? v() : v);
  return {
    async json(method, route, body) {
      const r = await fetch(at(base) + route, { method, headers: at(headers), body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let value; try { value = JSON.parse(text); } catch (_) { value = text; }
      return { status: r.status, body: value, text };
    }
  };
}

async function publishFloor(api, station, opts) {
  const o = opts || {}, label = o.label || 'the floor';
  const current = await api.json('GET', '/api/save?agent=agent');
  // a page saves its whole station with the floor changed, so whatever else the save holds (its sessions, its agent...) is kept,
  // migrated to the current version the way the page migrates it on load; a workspace with no save yet gets a bare one
  const held = current.body && current.body.save && Save.fromDoc(current.body.save), rest = held && held.doc ? held.doc : {};
  const wrote = await api.json('POST', '/api/save', Object.assign({ schema: 'starnet.save', version: Save.CURRENT, agent: { id: 'agent' } }, rest,
    { _saveRevision: Number(rest._saveRevision) || 0, updatedAt: Math.max(Date.now(), (Number(rest.updatedAt) || 0) + 1), _saveClient: o.client || 'e2e-page', station }));
  if (wrote.status !== 200 || !wrote.body || wrote.body.ok !== true) throw new Error(label + ' did not save: ' + wrote.status + ' ' + String(wrote.text).slice(0, 300));
  const hint = hintFor(station), want = o.expect || 200;
  const receipt = await api.json('POST', '/api/routing', hint);
  if (receipt.status !== want) throw new Error(label + ': the saved floor answered the page\'s hint ' + receipt.status + ', not ' + want + ': ' + String(receipt.text).slice(0, 300));
  return { hint, plan: planOf(hint), receipt: receipt.body };
}

module.exports = { lineStation, floorOf, emptyFloor, canonical, seedSavedFloor, hintFor, planOf, publishFloor, fetchApi, savePath, clone };
