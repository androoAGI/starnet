'use strict';

// Insert a staffed coordination room without changing or running either BU's lines.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const WM = require('../frontend/app/worldmodel.js');
const { client, inspect } = require('./workflow.cjs');
const checked = r => { if (!r || !r.ok) throw new Error(JSON.stringify(r)); return r; };
const AGENT_ID = 'colony_coordinator';
const ROOM_NAME = 'ORCHESTRATOR';
const WIDTH = 9, HEIGHT = 7;

function topology(st) {
  return st.props().filter(p => p.t === 'intake').map(p => {
    const g = st.lineGraph(p.id);
    if (!g.ok) throw new Error('Cannot read existing line');
    return { id: p.id, nodes: g.graph.nodes.map(n => [n.id, n.t, n.agentId || '', n.role || '']).sort(),
      links: g.graph.links.map(l => JSON.stringify([l.from, l.to])).sort() };
  });
}

function prepare(input) {
  const save = structuredClone(input), st = WM.create(save.station);
  const agents = [save.agent, ...(save.agents || [])];
  if (st.rooms().some(r => r.name === ROOM_NAME) || agents.some(a => a.id === AGENT_ID)) throw new Error('Orchestrator already exists; refusing duplicate');
  const lifeIntake = st.props().find(p => p.t === 'intake' && p.label === 'Lifestruct Pinterest Pilot');
  const life = lifeIntake && st.roomById(st.roomAt(lifeIntake.x, lifeIntake.y));
  const home = st.rooms().find(r => r.name === 'HomeStackR');
  if (!life || !home || life.id === home.id || life.rects.length !== 1 || home.rects.length !== 1) throw new Error('Expected separate rectangular Lifestruct and HomeStackR rooms');
  const a = life.rects[0], b = home.rects[0];
  if (a.x2 + 1 !== b.x1) throw new Error('Rooms are not adjacent left/right; refusing an assumed layout');
  const y1 = Math.max(a.y1, b.y1), y2 = Math.min(a.y2, b.y2);
  if (y2 - y1 + 1 < HEIGHT) throw new Error('Not enough shared height for the central room');
  const original = st.serialize(), originalTopology = topology(st);
  const whollyInHome = p => p.x >= b.x1 && p.x + (p.w || 1) - 1 <= b.x2 && p.y >= b.y1 && p.y + (p.h || 1) - 1 <= b.y2;
  // Cross-room belts/props require a bespoke re-layout, not this safe room insertion.
  for (const p of original.props) {
    const hits = p.x <= b.x2 && p.x + (p.w || 1) - 1 >= b.x1 && p.y <= b.y2 && p.y + (p.h || 1) - 1 >= b.y1;
    if (hits && !whollyInHome(p)) throw new Error('A prop straddles the HomeStackR boundary');
  }
  for (const l of original.links || []) {
    const from = st.propById(l.from.prop), to = st.propById(l.to.prop);
    if (whollyInHome(from) !== whollyInHome(to)) throw new Error('A workflow crosses room boundaries');
  }
  checked(st.moveRoom(home.id, WIDTH, 0));
  const top = y1 + Math.floor((y2 - y1 + 1 - HEIGHT) / 2);
  const rect = { x1: a.x2 + 1, y1: top, x2: a.x2 + WIDTH, y2: top + HEIGHT - 1 };
  const roomId = checked(st.addRoom({ kind: 'bridge', name: ROOM_NAME, rect, floorStyle: 'oak', floorMat: 'parquet' })).id;
  checked(st.setWalls(roomId, { style: 'bone', mat: 'courses' }));
  checked(st.setHull(roomId, { mat: 'stone' }));
  const desk = checked(st.addProp({ t: 'desk', x: rect.x1 + 3, y: rect.y1 + 2, w: 2, h: 1, block: true }));
  checked(st.assignDesk(desk.id, AGENT_ID));
  const after = st.serialize();
  assert.deepEqual(topology(st), originalTopology, 'Every existing workflow connection must stay the same');
  for (const p of original.props) assert.deepEqual(st.propById(p.id), { ...p, x: p.x + (whollyInHome(p) ? WIDTH : 0) });
  for (const [id, room] of Object.entries(original.rooms)) {
    const expected = structuredClone(room);
    if (id === home.id) {
      expected.rects = expected.rects.map(r => ({ ...r, x1: r.x1 + WIDTH, x2: r.x2 + WIDTH }));
      expected.floorPaint = Object.fromEntries(Object.entries(expected.floorPaint || {}).map(([key, value]) => {
        const [x, y] = key.split(',').map(Number); return [(x + WIDTH) + ',' + y, value];
      }));
    }
    assert.deepEqual(st.roomById(id), expected);
  }
  for (const [key, dir] of Object.entries(original.belts)) {
    const [x, y] = key.split(',').map(Number), moved = x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2;
    assert.equal(after.belts[(x + (moved ? WIDTH : 0)) + ',' + y], dir);
  }
  assert.equal(Object.keys(after.belts).length, Object.keys(original.belts).length);
  assert.deepEqual(after.edges, original.edges);
  const result = inspect(st);
  if (!result.valid) throw new Error('Routing failed: ' + JSON.stringify(result.errors));
  const template = agents.find(a => a.id === 'hsr_research') || save.agent;
  // Native StarNet reserves its founder/overseer role for the existing hero. This is
  // an additional, removable coordination specialist, not a second global founder.
  const coordinator = {
    id: AGENT_ID, name: 'Orchestrator', color: '#c6a86a', skin: template.skin,
    model: 'deepseek-v4.1-flash-free', provider: 'custom', reasoningEffort: null,
    personaId: template.personaId, role: 'specialist', approvalMode: 'ask',
    executionProfile: 'trusted-project', workshop: false, specialtyId: null, docs: [], skills: [], createdAt: Date.now(),
    purpose: 'Zentraler manueller Koordinator für Lifestruct und HomeStackR. Kläre Ziel, benötigte Daten und Zuständigkeit; bereite konkrete Aufträge für die vorhandenen Pipelines vor und fasse tatsächlich vorliegende Ergebnisse/Blockaden zusammen. Halte beide Marken und Daten getrennt. Starte keine Pipeline, Delegation, Modellketten, Zeitpläne oder Folgeaufträge ohne ausdrücklichen Betreiberauftrag. Behaupte keinen Live-Status ohne Nachweis. Keine Veröffentlichung, Uploads, Repo-Änderungen oder automatische Freigaben. Noch keine technische Automatik angebunden; fehlende Daten als BLOCKIERT melden.'
  };
  save.agents = [...(save.agents || []), coordinator];
  save.station = after;
  save.updatedAt = Math.max(Date.now(), Number(save.updatedAt || 0) + 1);
  return { save, plan: result.plan, report: { valid: true, roomId, room: ROOM_NAME, deskId: desk.id, agentId: AGENT_ID,
    leftRoom: life.name, rightRoom: home.name, roomRect: rect, movedHomeStackRBy: { x: WIDTH, y: 0 },
    existingWorkflowTopologyPreserved: true, existingAgentSettingsPreserved: true, automationEnabled: false, executionStarted: false } };
}

async function main(args) {
  const req = await client('http://127.0.0.1:8790', { allowLiveAuthoring: args.includes('--live-authoring') });
  const before = (await req('/api/save')).save, prepared = prepare(before);
  if (!args.includes('--apply')) return { ...prepared.report, applied: false };
  const dir = path.resolve(__dirname, '../.lab-state/authoring-backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'before-orchestrator-' + Date.now() + '.json'), JSON.stringify(before), { mode: 0o600, flag: 'wx' });
  const saved = await req('/api/save', prepared.save);
  try { await req('/api/routing', prepared.plan); }
  catch (e) { throw new Error('Room saved, routing publish failed; reload UI to reconcile: ' + e.message); }
  return { ...prepared.report, applied: true, revision: saved.revision, note: 'Reload browser to load the new room/profile and sync the native roster. No jobs started.' };
}

module.exports = { prepare, topology, AGENT_ID, ROOM_NAME };
if (require.main === module) main(process.argv.slice(2)).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => {
  console.error(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 1;
});
