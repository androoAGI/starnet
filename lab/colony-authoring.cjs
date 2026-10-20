'use strict';

// A non-destructive migration PREVIEW. Deliberately no --apply: activation of
// save/roster/routing must not reuse the old non-transactional authoring path.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const WM = require('../frontend/app/worldmodel.js');
const P = require('../frontend/app/pipeline.js');
const { create } = require('./workflow.cjs');
const { BRANDS, PROCESSES, agents } = require('../sidecar/colony/catalog.js');
const checked = result => { if (!result || !result.ok) throw new Error('COLONY_LAYOUT: ' + JSON.stringify(result)); return result; };

function prepare(input) {
  const save = structuredClone(input), st = WM.create(save.station), before = st.serialize();
  const existing = new Map([save.agent, ...(save.agents || [])].filter(Boolean).map(a => [a.id, a]));
  const generated = agents().filter(a => a.businessUnitId && (a.role === 'owner' || Object.values(PROCESSES).some(p => p.businessUnitId === a.businessUnitId && p.roles.includes(a.role))));
  if (generated.some(a => existing.has(a.id))) throw new Error('COLONY_MIGRATION_ALREADY_PREPARED');
  const rooms = {}, mappings = {}, missingRooms = [];
  const lifeIntake = st.props().find(p => p.t === 'intake' && p.label === 'Lifestruct Pinterest Pilot');
  for (const [brand, profile] of Object.entries(BRANDS)) {
    const room = brand === 'lifestruct' && lifeIntake ? st.roomById(st.roomAt(lifeIntake.x, lifeIntake.y)) : st.rooms().find(r => r.name === profile.name);
    if (room) {
      if (room.rects.length !== 1) throw new Error('COLONY_COMPLEX_ROOM_REQUIRES_MANUAL_LAYOUT');
      const r = room.rects[0];
      const width = 38, height = 72;
      const rect = brand === 'lifestruct' ? { ...r, x1: r.x2 - width + 1, y2: r.y1 + height - 1 } : { ...r, x2: r.x1 + width - 1, y2: r.y1 + height - 1 };
      checked(st.resizeRoom(room.id, rect)); checked(st.renameRoom(room.id, profile.name)); rooms[brand] = room.id;
    } else missingRooms.push(brand);
  }
  for (const brand of missingRooms) {
    const rect = st.roomSpots(38, 72, 'hab', 1)[0];
    if (!rect) throw new Error('COLONY_NO_ROOM_SPACE');
    rooms[brand] = checked(st.addRoom({ kind: 'hab', name: BRANDS[brand].name, rect, floorStyle: 'oak', floorMat: 'parquet' })).id;
  }
  const allIds = new Set([...existing.keys(), ...generated.map(a => a.id)]);
  for (const [brand, roomId] of Object.entries(rooms)) {
    const r = st.roomById(roomId).rects[0];
    const ownAgents = generated.filter(a => a.businessUnitId === brand);
    for (const [i, a] of ownAgents.entries()) {
      const desk = checked(st.addProp({ t: 'desk', x: r.x1 + 2 + i * 3, y: r.y2 - 2, w: 2, h: 1, block: true }));
      checked(st.assignDesk(desk.id, a.id));
    }
    const processes = Object.values(PROCESSES).filter(p => p.businessUnitId === brand);
    processes.forEach((process, i) => {
      const spec = { name: process.id + ' · ' + process.name, steps: process.roles.map(role => ({
        role: role === 'review' ? 'REVIEWER' : role === 'research' ? 'ANALYST' : role === 'web' ? 'ENGINEER' : 'WRITER',
        agentId: 'colony_' + brand + '_' + role, label: role,
        brief: 'Marke ' + profileName(brand) + ', Ablauf ' + process.id + '. Fachaufträge nur über die Business-Steuerung mit Versions-/Budgetnachweisen ausführen. Kein Versand, Upload oder Veröffentlichen. ' + (role === 'review' ? 'Unabhängig prüfen; nicht selbst überarbeiten oder menschliche Freigabe ersetzen.' : 'Nur belegte Quellen und freigegebene interne Werkzeuge verwenden.'),
        hands: 'Versionierte Artefaktreferenzen und konkrete Befunde; keine Selbstfreigabe.'
      })) };
      mappings[process.id] = { businessUnitId: brand, processVersion: process.version,
        ...create(st, spec, allIds, { roomId, near: { x: r.x1 + 15, y: r.y1 + 23 + i * 8 } }) };
    });
  }
  // New floor area is additive; original work, links, furniture, profiles and
  // histories stay exactly as supplied. Room names/footprints are the only edits.
  for (const prop of before.props) assert.deepEqual(st.propById(prop.id), prop);
  const after = st.serialize();
  for (const link of before.links || []) assert.deepEqual(after.links.find(x => x.id === link.id), link);
  for (const [key, belt] of Object.entries(before.belts)) assert.deepEqual(after.belts[key], belt);
  const plan = P.compileRoutingPlan(st.projectGeometry());
  if (!P.ok(plan)) throw new Error('COLONY_INVALID_MIGRATION_ROUTING: ' + JSON.stringify(plan.errors));
  save.agents = (save.agents || []).concat(generated.map(a => ({ ...a, provider: '', model: '', role: 'specialist',
    purpose: 'Eigener Markenagent für ' + profileName(a.businessUnitId) + '. Business-Steuerung verwenden; keine Außenaktion.',
    approvalMode: 'ask', workshop: false, executionProfile: 'station-gear', docs: [], skills: [] })));
  save.station = after;
  return { save, plan, rooms, mappings, report: { previewOnly: true, applied: false, originalWorkPreserved: true,
    processPipelines: Object.keys(mappings).length, newIdentities: generated.length,
    activationBlockers: ['Aktivierung ausschließlich über den revisionsgebundenen Installation-Endpunkt, nicht über diese CLI',
      'Echter L01-Pilot, Arbeitsbudgets und konkrete Integrationszugänge fehlen'] } };
}
function profileName(id) { return BRANDS[id].name; }
module.exports = { prepare };
if (require.main === module) {
  if (process.argv.includes('--apply')) throw new Error('COLONY_PREVIEW_ONLY: no non-atomic live migration');
  const file = path.resolve(__dirname, '../.lab-state/workspaces/agent.save.json');
  const wrapper = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = prepare(wrapper.doc);
  console.log(JSON.stringify({ ...result.report, rooms: result.rooms, mappings: result.mappings }, null, 2));
}
