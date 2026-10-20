'use strict';

// Configuration only: no inference, key access, external repo writes or job routes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const WM = require('../frontend/app/worldmodel.js');
const { create, inspect, client } = require('./workflow.cjs');
const spec = require('./fixtures/homestackr.json');
const checked = r => { if (!r || !r.ok) throw new Error(JSON.stringify(r)); return r; };
const MODEL = 'deepseek-v4.1-flash-free';

function prepare(input) {
  const save = structuredClone(input);
  const st = WM.create(save.station);
  if (st.rooms().some(r => r.name === spec.name)) throw new Error('HomeStackR room already exists; refusing duplicate');
  const existing = new Set([save.agent, ...(save.agents || [])].map(a => a.id));
  if (spec.agents.some(a => existing.has(a.id))) throw new Error('HomeStackR agent ID already exists');
  const original = st.serialize();
  const spot = st.roomSpots(26, 24, 'hab', 1)[0];
  if (!spot) throw new Error('No connected room space available');
  const roomId = checked(st.addRoom({ kind: 'hab', name: spec.name, rect: spot.rect || spot, floorStyle: 'oak', floorMat: 'parquet' })).id;
  checked(st.setWalls(roomId, { style: 'bone', mat: 'courses' }));
  checked(st.setHull(roomId, { mat: 'stone' }));
  const rect = st.roomById(roomId).rects[0];
  // Dedicated computers are placed IN the new room, never seeded into Lifestruct.
  for (const [i, a] of spec.agents.entries()) {
    const desk = checked(st.addProp({ t: 'desk', x: rect.x1 + 2 + i * 2, y: rect.y1 + 1, w: 2, h: 1, block: true }));
    checked(st.assignDesk(desk.id, a.id));
  }
  const allIds = new Set([...existing, ...spec.agents.map(a => a.id)]);
  const made = spec.lines.map((line, i) => ({
    name: line.name,
    ...create(st, line, allIds, { roomId, near: { x: rect.x1 + 12, y: rect.y1 + 5 + i * 7 } })
  }));
  const result = inspect(st);
  if (!result.valid) throw new Error('Routing failed: ' + JSON.stringify(result.errors));
  // Byte-for-byte preservation of all pre-existing room/prop/link/belt records.
  const after = st.serialize();
  for (const [id, room] of Object.entries(original.rooms)) assert.deepEqual(after.rooms[id], room);
  for (const p of original.props) assert.deepEqual(after.props.find(q => q.id === p.id), p);
  for (const l of original.links || []) assert.deepEqual(after.links.find(q => q.id === l.id), l);
  for (const [key, belt] of Object.entries(original.belts)) assert.deepEqual(after.belts[key], belt);
  assert.deepEqual(after.edges, original.edges);
  const oldProps = new Set(original.props.map(p => p.id));
  for (const p of after.props.filter(p => !oldProps.has(p.id))) {
    for (let y = p.y; y < p.y + (p.h || 1); y++) for (let x = p.x; x < p.x + (p.w || 1); x++) assert.equal(st.roomAt(x, y), roomId);
  }
  for (const l of after.links.filter(l => !(original.links || []).some(q => q.id === l.id))) {
    for (const t of l.path || []) assert.equal(st.roomAt(t.x, t.y), roomId);
  }
  const template = (save.agents || []).find(a => a.id !== save.agent.id) || save.agent;
  const colors = ['#b7a07a', '#bca68b', '#879780'];
  const profiles = spec.agents.map((a, i) => ({
    id: a.id, name: a.name, color: colors[i % colors.length], skin: template.skin,
    model: MODEL, provider: 'custom', reasoningEffort: null, personaId: template.personaId,
    role: 'specialist', approvalMode: 'ask', executionProfile: 'trusted-project', workshop: false,
    purpose: a.purpose + ' Nur Entwürfe zur manuellen Freigabe; keine Veröffentlichung, Uploads, Repo-Änderungen oder automatischen Folgeaufträge. Fehlende Daten als BLOCKIERT melden.',
    specialtyId: null, docs: [], skills: [], createdAt: Date.now()
  }));
  save.agents = [...(save.agents || []), ...profiles];
  save.station = after;
  save.updatedAt = Math.max(Date.now(), Number(save.updatedAt || 0) + 1);
  return { save, plan: result.plan, report: { valid: true, roomId, room: spec.name, lines: made, agents: profiles.map(a => a.id), model: MODEL, existingPreserved: true, executionStarted: false } };
}

async function main(args) {
  const request = await client('http://127.0.0.1:8790', { allowLiveAuthoring: args.includes('--live-authoring') });
  const before = (await request('/api/save')).save;
  const prepared = prepare(before);
  if (!args.includes('--apply')) return { ...prepared.report, applied: false };
  const dir = path.resolve(__dirname, '../.lab-state/authoring-backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Private backup, never printed (the station may contain private conversation data).
  fs.writeFileSync(path.join(dir, 'before-homestackr-' + Date.now() + '.json'), JSON.stringify(before), { mode: 0o600, flag: 'wx' });
  const saved = await request('/api/save', prepared.save);
  try { await request('/api/routing', prepared.plan); }
  catch (e) { throw new Error('Room saved, routing publish failed; reload UI to reconcile: ' + e.message); }
  return { ...prepared.report, applied: true, revision: saved.revision, note: 'Reload browser to adopt the room and sync the native crew roster. No job was started.' };
}

module.exports = { prepare, main };
if (require.main === module) main(process.argv.slice(2)).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => {
  console.error(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 1;
});
