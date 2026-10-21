'use strict';

// A non-destructive migration PREVIEW. Deliberately no --apply: activation of
// save/roster/routing must not reuse the old non-transactional authoring path.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const WM = require('../frontend/app/worldmodel.js');
const P = require('../frontend/app/pipeline.js');
const LE = require('../frontend/app/lineedit.js');
const { BRANDS, PROCESSES, agents } = require('../sidecar/colony/catalog.js');
const Contracts = require('../sidecar/colony/processes.js');
const { processes: homeStackR } = require('../frontend/app/homestackr-workflows.js');
const checked = result => { if (!result || !result.ok) throw new Error('COLONY_LAYOUT: ' + JSON.stringify(result)); return result; };
const ROLE_TAG = { research: 'RESEARCHER', editorial: 'WRITER', design: 'GENERALIST', product: 'GENERALIST', web: 'ENGINEER', review: 'REVIEWER', fixer: 'FIXER' };

function bindBay(st, prop, brand, role, brief, hands, label) {
  checked(st.setPropRole(prop.id, ROLE_TAG[role] || 'GENERALIST'));
  checked(st.assignPropAgent(prop.id, 'colony_' + brand + '_' + role));
  checked(st.setPropBrief(prop.id, brief)); checked(st.setPropHands(prop.id, hands));
  checked(st.setPropLabel(prop.id, label)); checked(st.ensureWorkstation('colony_' + brand + '_' + role));
}

function placeQualityBlueprint(st, room, process, brand, near, lineLabel, overrides = {}) {
  const editor = Object.assign({}, st, { lineGraph(id) {
    const g = st.lineGraph(id); if (g.ok) g.floor.rects = structuredClone(room.rects); return g;
  } });
  const placed = checked(LE.placeBlueprint(editor, 'fire_escape', near));
  const props = placed.ids.map(id => st.propById(id)).filter(Boolean);
  const intake = props.find(p => p.t === 'intake'), bays = props.filter(p => p.t === 'bay');
  const primaryReview = bays.find(p => p.role === 'REVIEWER'), fixer = bays.find(p => p.role === 'FIXER'), writer = bays.find(p => p.role === 'WRITER');
  if (!intake || !writer || !primaryReview || !fixer) throw new Error('COLONY_BLUEPRINT_ROLE_MISMATCH:' + process.id);
  checked(st.setPropLabel(intake.id, lineLabel));
  const processStep = role => {
    const index = process.roles.indexOf(role), generic = process.steps[index];
    let authored = homeStackR[process.id]?.steps[index];
    if (process.id === 'H03' && role === 'review') authored = homeStackR.H03.steps[3];
    return { brief: authored?.brief || generic.brief, hands: authored?.hands || generic.hands, label: generic.label };
  };
  const producerRole = process.producerRole;
  if (!producerRole || !process.roles.includes(producerRole) || !process.roles.includes('review')) throw new Error('COLONY_PROCESS_REVIEW_REQUIRED:' + process.id);
  const producerStep = processStep(producerRole), reviewStep = processStep('review');
  bindBay(st, writer, brand, producerRole, overrides.producerBrief || producerStep.brief,
    overrides.producerHands || producerStep.hands, producerStep.label);
  bindBay(st, primaryReview, brand, 'review', overrides.reviewBrief || reviewStep.brief,
    overrides.reviewHands || reviewStep.hands, reviewStep.label);
  bindBay(st, fixer, brand, 'fixer', Contracts.roleBrief(process.id, 'fixer'),
    'Nur die konkreten Review-Befunde reparieren; danach zum unabhängigen Review.', 'Eskalations-Fixer');
  const loop = props.find(p => p.t === 'loop');
  if (!loop || loop.when !== 'approved' || loop.maxIter !== process.qualityLoop.maxRevisions) throw new Error('COLONY_REVIEW_LOOP_MISMATCH:' + process.id);
  const roleDocks = { [producerRole]: writer.id, review: primaryReview.id, fixer: fixer.id };
  return { intake: intake.id, steps: [writer.id, primaryReview.id, fixer.id], roleDocks,
    standaloneRoles: process.roles.filter(role => !Object.hasOwn(roleDocks, role)), processRoles: structuredClone(process.roles),
    producerRole, primaryReviewStep: primaryReview.id, fixerStep: fixer.id, loopStep: loop.id,
    blueprint: 'fire_escape', executionAuthority: 'colony_backend', backendFinalReview: true,
    qualityLoop: structuredClone(process.qualityLoop) };
}

function addBrandDesk(st, room, agentId) {
  for (const r of room.rects) for (let y = r.y1 + 1; y < r.y2; y++) for (let x = r.x1; x < r.x2; x++) {
    const desk = st.addProp({ t: 'desk', x, y, w: 2, h: 1, block: true });
    if (desk.ok) { checked(st.assignDesk(desk.id, agentId)); return desk.id; }
  }
  throw new Error('COLONY_NO_BRAND_DESK:' + agentId);
}

function prepare(input, previousInstallation) {
  if (previousInstallation?.commitId) return preparePilotUpgrade(input, previousInstallation);
  const save = structuredClone(input), st = WM.create(save.station), before = st.serialize();
  const existing = new Map([save.agent, ...(save.agents || [])].filter(Boolean).map(a => [a.id, a]));
  const generated = agents().filter(a => a.businessUnitId && (a.role === 'owner' || Object.values(PROCESSES).some(p => p.businessUnitId === a.businessUnitId && (p.roles.includes(a.role) || p.qualityLoop?.fixerRole === a.role))));
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
  for (const [brand, roomId] of Object.entries(rooms)) {
    const room = st.roomById(roomId), r = room.rects[0];
    const ownAgents = generated.filter(a => a.businessUnitId === brand);
    for (const [i, a] of ownAgents.entries()) {
      const desk = checked(st.addProp({ t: 'desk', x: r.x1 + 2 + i * 3, y: r.y2 - 2, w: 2, h: 1, block: true }));
      checked(st.assignDesk(desk.id, a.id));
    }
    const processes = Object.values(PROCESSES).filter(p => p.businessUnitId === brand);
    processes.forEach((process, i) => {
      const near = { x: r.x1 + 15, y: r.y1 + 23 + i * 8 };
      // Reuse the exact StarNet "Review + a fixer" blueprint. The Colony backend,
      // not this native outbox, remains the authority for final independent review.
      const mapping = placeQualityBlueprint(st, room, process, brand, near, process.id + ' · ' + process.name);
      const compiled = P.compileRoutingPlan(st.projectGeometry());
      if (!P.ok(compiled)) throw new Error('COLONY_INVALID_PROCESS_ROUTING:' + process.id + ':' + JSON.stringify(compiled.errors));
      mappings[process.id] = { businessUnitId: brand, processVersion: process.version, ...mapping };
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

function preparePilotUpgrade(input, previous) {
  const save = structuredClone(input), st = WM.create(save.station), before = st.serialize();
  if (save.colonyInstallation?.commitId !== previous.commitId || !previous.mappings?.L01) throw new Error('COLONY_UPGRADE_BASE_MISMATCH');
  const legacy = previous.mappings.L01, oldIntake = st.propById(legacy.intake), oldLine = st.lineGraph(legacy.intake);
  if (!oldIntake || !oldLine.ok || legacy.businessUnitId !== 'lifestruct') throw new Error('COLONY_L01_LEGACY_LINE_REQUIRED');
  const roomId = previous.rooms?.lifestruct || st.roomAt(oldIntake.x, oldIntake.y), room = st.roomById(roomId);
  if (!room) throw new Error('COLONY_LIFESTRUCT_ROOM_REQUIRED');
  const existing = new Set([save.agent, ...(save.agents || [])].filter(Boolean).map(a => a.id));
  const generated = agents().filter(a => a.businessUnitId && a.role === 'fixer' && !existing.has(a.id));
  if (!generated.some(a => a.id === 'colony_lifestruct_fixer') && !existing.has('colony_lifestruct_fixer')) throw new Error('COLONY_LIFESTRUCT_FIXER_REQUIRED');
  for (const a of generated) {
    const deskRoom = st.roomById(previous.rooms?.[a.businessUnitId]);
    if (!deskRoom) throw new Error('COLONY_BRAND_ROOM_REQUIRED:' + a.businessUnitId);
    addBrandDesk(st, deskRoom, a.id);
  }
  // Keep the prior pipeline and its role briefs intact as a reversible archive;
  // the new managed intake is the exact prebuilt FIRE ESCAPE blueprint.
  checked(st.setPropLabel(oldIntake.id, 'L01 · Legacy (nicht Pilot)'));
  const oldBays = oldLine.graph.nodes.filter(n => n.t === 'bay').map(n => st.propById(n.id));
  const oldProducer = oldBays.find(p => p.agentId === 'colony_lifestruct_editorial');
  const oldReview = oldBays.find(p => p.agentId === 'colony_lifestruct_review');
  const process = PROCESSES.L01, near = { x: oldIntake.x, y: oldIntake.y };
  const mapping = placeQualityBlueprint(st, room, process, 'lifestruct', near, 'L01 · Review + Fixer (Pilot)', {
    producerBrief: oldProducer?.brief, producerHands: oldProducer?.hands, reviewBrief: oldReview?.brief, reviewHands: oldReview?.hands
  });
  const compiled = P.compileRoutingPlan(st.projectGeometry());
  if (!P.ok(compiled)) throw new Error('COLONY_INVALID_PILOT_UPGRADE_ROUTING:' + JSON.stringify(compiled.errors));
  for (const prop of before.props) if (prop.id !== oldIntake.id) assert.deepEqual(st.propById(prop.id), prop);
  for (const link of before.links || []) assert.deepEqual(st.serialize().links.find(x => x.id === link.id), link);
  for (const [key, belt] of Object.entries(before.belts)) assert.deepEqual(st.serialize().belts[key], belt);
  const mappings = structuredClone(previous.mappings);
  mappings.L01 = { businessUnitId: 'lifestruct', processVersion: process.version, ...mapping };
  save.agents = (save.agents || []).concat(generated.map(a => ({ ...a, provider: '', model: '', role: 'specialist',
    purpose: 'Eigener Markenagent für ' + profileName(a.businessUnitId) + '. Nur interne Eskalation; keine Außenaktion.',
    approvalMode: 'ask', workshop: false, executionProfile: 'station-gear', docs: [], skills: [] })));
  save.station = st.serialize();
  return { save, plan: compiled, rooms: structuredClone(previous.rooms), mappings,
    report: { previewOnly: true, applied: false, upgrade: true, upgradeFromCommitId: previous.commitId, originalWorkPreserved: true,
      blueprint: 'fire_escape', blueprintCount: 1, changedProcesses: ['L01'], untouchedProcesses: Object.keys(mappings).filter(id => id !== 'L01'),
      newIdentities: generated.length, activationBlockers: ['Upgrade nur über den commit-gebundenen atomaren Installation-Endpunkt', 'Der L01-Livepilot bleibt separat und ausdrücklich testOnly.'] } };
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
