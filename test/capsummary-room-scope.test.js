/* node test/capsummary-room-scope.test.js — the capability note names the ROOM a room-scoped agent's missing gear must
   go in (capability/cap-scope.js, 2026-10-20; tweet: "the agents aren't good").

   The real path that breaks: the lead's station.build with "new" recruits seats a RESEARCHER and a WRITER at desks in a
   new RESEARCH room. Each owns a bay, so its floor tools come ONLY from that desk room, and RESEARCH holds no DISH,
   SERVER CART or STUDIO: the Researcher cannot search the web. The note said "place a DISH" with no room (the DISH in
   HOME does not reach it), and on its line runs said "Placing objects cannot change that here", which is false for web.
   Review fixes (same day): the unattended clause offers only what the floor really grants with nobody watching (web,
   file reading; never images: image_generate needs the routine's ALLOW IMAGES grant), memory's gear is the SERVER CART
   the palette shows (no prop is called NOTEBOOK), and the fix is named only when the job needed it.
   Built here with the REAL station builder, saved-floor validation, router.stationFor, composeOffice + execution
   profile + resolveTools, and summarizeCapabilities. Pure node: no sidecar boot (index.js is source-locked only). */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path');
const M = require('../frontend/app/worldmodel.js'), P = require('../frontend/app/pipeline.js'), W = require('../frontend/app/workflowline.js');
const SB = require('../frontend/app/stationbuilder.js'), T = require('../frontend/app/stationtemplates.js'), Sprites = require('../frontend/app/propsprites.js');
const { summarizeCapabilities } = require('../sidecar/capability/capsummary.js');
const { capScope, consistentScope, scopeForRun, makeSavedFloor } = require('../sidecar/capability/cap-scope.js');
const { savedPlacement, checkedStation } = require('../sidecar/capability/saved-placement.js');
const { composeOffice, stationWithObject } = require('../sidecar/capability/office.js');
const { resolveTools } = require('../sidecar/capability/resolve.js');
const Profiles = require('../sidecar/execution-profiles.js');
const { makeRouter } = require('../sidecar/routing/router.js');

M.setPropRules(t => { const s = Sprites.spec(t); return s ? { mount: s.mount || null, stack: !!s.stack, surface: !!s.surface, flat: !!s.flat } : null; });
const env = { WorldModel: M, Pipeline: P, WorkflowLine: W, crew: [{ id: 'agent', name: 'NOVA' }], heroId: 'agent',
  StationTemplates: T, PropSprites: Sprites, EquipmentHelp: require('../frontend/app/equipmenthelp.js'), RoomStyles: require('../frontend/app/roomstyles.js'),
  LineLayout: require('../frontend/app/linelayout.js'), LineEdit: require('../frontend/app/lineedit.js') };

// THE VERIFIED REAL PATH: the starter station, then the lead builds a research line in a new room with two recruits
const st = M.create(M.starterDoc()); st.ensureWorkstation('agent');
const made = [];
const R = Object.assign({}, env, { canRecruit: true, recruit: role => { const id = 'rq' + (made.length + 1); if (!st.ensureWorkstation(id).ok) return null; made.push(id); return { id, name: role }; } });
const pb = SB.planBuild(st.serialize(), { rooms: [{ name: 'Research', size: 'giant', lines: [{ line: 'research_line', staff: [{ step: 1, agent: 'new' }, { step: 2, agent: 'new' }] }] }] }, R);
A.ok(pb.ok && /with a desk in RESEARCH/.test(pb.plan.summary), 'fixture: the lead plans a research line whose recruits sit in RESEARCH (' + (pb.error || '') + ')');
A.ok(SB.apply(st, pb.plan, R).ok && made.join() === 'rq1,rq2', 'fixture: built, RESEARCHER = rq1');
const save = { station: st.serialize() };
const saved = checkedStation(save);
A.ok(!!saved, 'the saved floor validates');

// how runOnce builds the run's grants: office (or routed room) + the agent's execution profile objects, then resolveTools
const PROFILE = Profiles.PROFILES['trusted-project'].capabilityObjects;   // every hire since v0.9.0 (app.js summonAgent)
function withProfile(station, agentId) { for (const t of PROFILE) station = stationWithObject(station, agentId, t); return station; }
function interactiveRun(agentId, extraObjects) {
  const office = { agents: { [agentId]: { id: agentId, room: 'office' } }, rooms: { office: { id: 'office', objects: composeOffice({ surface: 'interactive', extraObjects }) } } };
  return resolveTools(agentId, withProfile(office, agentId));
}
// the autonomous strip of enforceRunAuthority for an ASK-mode agent: shell.exec / verify.run need the routine's grant
const unattended = (res) => Object.assign({}, res, { tools: res.tools.filter(n => n !== 'shell.exec' && n !== 'verify.run'),
  grants: res.grants.filter(g => g.tool !== 'shell.exec' && g.tool !== 'verify.run') });

/* 1. capScope reads the real floor */
{
  const s = capScope(saved, 'rq1');
  A.ok(s && s.scoped === true && s.roomName === 'RESEARCH' && s.via === 'desk', 'rq1 is scoped to RESEARCH, the room its desk is in: ' + JSON.stringify(s && { r: s.roomName, via: s.via }));
  A.eq(s.placedTypes, [], 'RESEARCH holds no floor gear');
  A.ok(['dish', 'notebook', 'studio', 'cabinet', 'workbench'].every(t => (s.gearElsewhere[t] || []).some(x => x.name === 'HOME' && x.id === saved.rooms().find(r => r.name === 'HOME').id)), 'every essential stands in HOME: ' + JSON.stringify(s.gearElsewhere));
  A.eq(JSON.stringify(savedPlacement(save, 'rq1')), '[]', 'savedPlacement (refactored onto checkedStation) still answers [] for rq1');
  A.eq(savedPlacement(save, 'agent').map(o => o.objectType).sort(), ['cabinet', 'dish', 'notebook', 'studio', 'workbench'], 'savedPlacement still gives the bayless hero the whole station');
  A.eq(capScope(saved, 'agent').scoped, false, 'the hero owns no bay: not room-scoped');
  A.eq(capScope(null, 'rq1'), null, 'no floor: no scope');
  // a desk-less bay agent draws on its BAY's room, and the note says so
  const fx = M.create(st.serialize());
  const desk = fx.props().find(p => p.agentId === 'rq2' && /^desk/.test(p.t));
  A.ok(desk && fx.removeProp(desk.id).ok, 'fixture: the WRITER loses its desk');
  const s2 = capScope(checkedStation({ station: fx.serialize() }), 'rq2');
  A.ok(s2 && s2.scoped && s2.via === 'bay' && s2.roomName === 'RESEARCH', 'a desk-less agent is scoped to its bay\'s room: ' + JSON.stringify(s2 && { r: s2.roomName, via: s2.via }));
  A.ok(/Place the DISH in RESEARCH, the room your bay is in: gear in any other room \(like the DISH in HOME\) does not reach you\./.test(
    summarizeCapabilities(interactiveRun('rq2', []), { surface: 'interactive', scopeFn: () => Object.assign({}, s2, { gearElsewhere: { dish: [{ id: 'r1', name: 'HOME', label: 'DISH' }] } }) })), '...and the note names the bay\'s room');
}

/* 2. the guard: a room is named only when the saved floor reproduces THIS run's floor grants */
{
  A.ok(!!consistentScope(saved, 'rq1', { grantedTypes: [] }), 'same floor -> scope');
  A.eq(consistentScope(saved, 'rq1', { grantedTypes: ['dish'] }), null, 'the page saw a DISH the saved floor lacks (stale save): no room is named');
  A.eq(consistentScope(saved, 'agent', { grantedTypes: [] }), null, 'an unscoped agent: nothing to name');
  A.eq(scopeForRun({ loadStation: () => saved, agentId: 'rq1', interactive: false, extraObjects: [] }), null, 'the autonomous office is not a floor room');
  A.eq(scopeForRun({ loadStation: () => saved, agentId: 'rq1', interactive: true, floorless: true, extraObjects: [] }), null, 'a floorless channel run names no room');
  A.eq(scopeForRun({ loadStation: () => saved, agentId: 'rq1', interactive: true }), null, 'no placement sent at all: no room');
  A.eq(scopeForRun({ loadStation: () => saved, agentId: 'rq1', runStation: { agents: { rq1: { room: 'x' } }, rooms: { x: { objects: [] } } } }), null, 'an explicit station that is not a routed floor room names nothing');
}

/* 3. INTERACTIVE (COMMS): the note names the room and the gear standing elsewhere */
const extra = savedPlacement(save, 'rq1');   // what /api/run uses when the page sends no `placed`
const resolvedI = interactiveRun('rq1', extra);
const scopeI = () => scopeForRun({ loadStation: () => saved, agentId: 'rq1', extraObjects: extra, interactive: true });
const BEFORE_I = '\n<capabilities_ground_truth>\nThese are your REAL powers this run, decided by the objects placed on your station floor and host-granted station roles -- not aspirational. This block is AUTHORITATIVE: if anything earlier in your instructions implies you always have web or file access, ignore it -- what follows is what you ACTUALLY have right now:\n- You CAN: read and write files, run shell commands and verify code.\n- You do NOT have: search/fetch the web and use the controlled browser.\nIf the Commander asks for something you lack, do NOT claim, promise, or pretend to do it. Say plainly you can\'t yet, and name the object to place to grant it: search/fetch the web and use the controlled browser -> place a DISH. You can always think and reply; that needs nothing.\n</capabilities_ground_truth>';
{
  A.eq(summarizeCapabilities(resolvedI, { surface: 'interactive' }), BEFORE_I, 'no scopeFn: byte-identical to the note before this change');
  A.eq(summarizeCapabilities(resolvedI, { surface: 'interactive', scopeFn: () => null }), BEFORE_I, 'a null scope: byte-identical');
  A.eq(summarizeCapabilities(resolvedI, { surface: 'interactive', scopeFn: () => { throw new Error('boom'); } }), BEFORE_I, 'a throwing scope fails open: byte-identical');
  const note = summarizeCapabilities(resolvedI, { surface: 'interactive', scopeFn: scopeI });
  A.ok(/search\/fetch the web and use the controlled browser -> place a DISH/.test(note), 'still names the DISH for web');
  A.ok(note.indexOf('Place the DISH, SERVER CART and STUDIO in RESEARCH, the room your desk is in: gear in any other room (like the ones in HOME) does not reach you.') >= 0,
    'names RESEARCH, the room the desk is in, and the gear in HOME that does not reach it: ' + note.slice(note.indexOf('Place the'), note.indexOf('Place the') + 220));
  A.ok(/You do NOT have: search\/fetch the web and use the controlled browser, keep long-term memory, generate and analyze images\./.test(note),
    'memory and images are named missing too, since that gear stands in HOME where it cannot reach');
  A.ok(/search\/fetch the web and use the controlled browser -> place a DISH; keep long-term memory -> place a SERVER CART; generate and analyze images -> place a STUDIO\./.test(note), 'each with its object');
  // REVIEW FIX 2: every object the note names is a real palette prop granting THAT power, and one of each stands in HOME
  // (the gear "the ones in HOME" points at). "a NOTEBOOK" named a prop that does not exist; manual.js says SERVER CART.
  const typeOf = { 'web': 'dish', 'keep long-term memory': 'notebook', 'generate and analyze images': 'studio' };
  const named = [];
  note.replace(/(search\/fetch the web|keep long-term memory|generate and analyze images)[^;.]*-> place an? ([A-Z][A-Z ]*[A-Z])/g, (m, power, label) => { named.push({ power: power === 'search/fetch the web' ? 'web' : power, label }); return m; });
  A.eq(named.map(n => n.label), ['DISH', 'SERVER CART', 'STUDIO'], 'the note names three objects');
  const homeId = saved.rooms().find(r => r.name === 'HOME').id;
  const homeLabels = saved.props().filter(p => saved.roomAt(p.x, p.y) === homeId).map(p => (Sprites.spec(p.t) || {}).label);
  for (const n of named) {
    A.ok(Sprites.CATALOG.some(e => e.label === n.label && M.capForProp(e.id) === typeOf[n.power]), n.label + ' is a palette prop that grants ' + n.power);
    A.ok(homeLabels.indexOf(n.label) >= 0, 'a ' + n.label + ' really stands in HOME');
  }
  A.ok(note.indexOf('NOTEBOOK') < 0 && /SERVER CART[^\n]*MEMORY/.test(require('../sidecar/manual.js').starnetManual()), 'no NOTEBOOK: the note and the manual name memory\'s gear alike');
  A.ok(note.indexOf('read and write files') < note.indexOf('You do NOT have') && !/place an INTEL CAB|place a WORKBENCH/.test(note), 'files + terminal come from the execution profile: never nagged');
  // REVIEW FIX (10-21): RESEARCH holds NO gear, yet this agent CAN read/write files and run shell (its trusted-project
  // profile), so "your tools come only from that room" was false: the note claims only what is true of floor gear
  A.eq(scopeI().placedTypes, [], 'RESEARCH grants this agent nothing');
  A.ok(!/tools come only from/.test(note) && /: gear in any other room \(like the ones in HOME\) does not reach you\./.test(note), 'the note never says the agent\'s tools come from its room');
  console.log('[room-scope] interactive note: ' + BEFORE_I.length + ' -> ' + note.length + ' chars (+' + (note.length - BEFORE_I.length) + ')');

  // the LEAD variant keeps its own opener
  const lead = summarizeCapabilities(Object.assign({}, resolvedI, { grants: resolvedI.grants.concat([{ capId: 'orchestrator', tool: 'team.dispatch' }]), tools: resolvedI.tools.concat(['team.dispatch']) }), { surface: 'interactive', scopeFn: scopeI });
  A.ok(/offer to place it yourself \(station builder add[^)]*\): .*-> place a DISH.*Place the DISH, SERVER CART and STUDIO in RESEARCH/.test(lead), 'the lead offers to place them itself, in RESEARCH');

  // a hero with the whole station: nothing missing, so the (11 ms) scope is never even asked for
  let asked = 0;
  const hero = interactiveRun('agent', savedPlacement(save, 'agent'));
  const heroNote = summarizeCapabilities(hero, { surface: 'interactive', scopeFn: () => { asked++; return scopeI(); } });
  A.eq(asked, 0, 'fully equipped: the scope is never computed (lazy)');
  A.eq(heroNote, summarizeCapabilities(hero, { surface: 'interactive' }), 'fully equipped: byte-identical');
}

/* 4. THE FIX WORKS: a DISH placed in RESEARCH grants web on the next run, and the note stops asking for it */
{
  const fx = M.create(st.serialize());
  const room = fx.rooms().find(r => r.name === 'RESEARCH'), Rr = room.rects[0];
  let placed = null;
  for (let y = Rr.y1 + 1; y < Rr.y2 && !placed; y++) for (let x = Rr.x1 + 1; x < Rr.x2 && !placed; x++) {
    const r = fx.addProp({ t: 'comms_dish', x, y, w: 1, h: 1 }); if (r && r.ok) placed = r;
  }
  A.ok(!!placed, 'fixture: a DISH placed in RESEARCH');
  const save2 = { station: fx.serialize() }, saved2 = checkedStation(save2), extra2 = savedPlacement(save2, 'rq1');
  A.eq(extra2.map(o => o.objectType), ['dish'], 'rq1 now draws a DISH from its room');
  const res2 = interactiveRun('rq1', extra2);
  A.ok(res2.tools.indexOf('web_search') >= 0, 'web_search is granted');
  const note2 = summarizeCapabilities(res2, { surface: 'interactive', scopeFn: () => scopeForRun({ loadStation: () => saved2, agentId: 'rq1', extraObjects: extra2, interactive: true }) });
  A.ok(/You CAN: search\/fetch the web/.test(note2) && !/-> place a DISH/.test(note2), 'web is a power now, never asked for');
  A.ok(/Place the SERVER CART and STUDIO in RESEARCH, the room your desk is in: gear in any other room \(like the ones in HOME\) does not reach you\./.test(note2), 'still names the memory and image gear: ' + note2.slice(note2.indexOf('Place the'), note2.indexOf('Place the') + 160));

  // a page that saw the DISH while the save has not caught up yet (debounce): no room is named at all
  const stale = summarizeCapabilities(res2, { surface: 'interactive', scopeFn: () => scopeForRun({ loadStation: () => saved, agentId: 'rq1', extraObjects: extra2, interactive: true }) });
  A.ok(stale.indexOf('RESEARCH') < 0, 'a floor that is not this run\'s names no room');
}

/* 5. UNATTENDED LINE RUN: router.stationFor's routed room, the floor marker, and the false "cannot change that" fixed */
{
  const router = makeRouter();
  const set = router.setStation(st.serialize());
  A.ok(set.ok, 'fixture: the router takes the built station (' + (set.error || '') + ')');
  const rs = router.stationFor('rq1');
  const bay = st.props().find(p => p.t === 'bay' && p.agentId === 'rq1');
  A.ok(rs && rs.floor && rs.floor.dockId === bay.id, 'stationFor marks its routed room with the dock it resolved: ' + JSON.stringify(rs && rs.floor));
  const bare = Object.assign({}, rs); delete bare.floor;
  A.eq(JSON.stringify(resolveTools('rq1', rs)), JSON.stringify(resolveTools('rq1', bare)), 'resolveTools ignores the marker: grants unchanged');
  const resolvedU = unattended(resolveTools('rq1', withProfile(rs, 'rq1')));
  A.ok(resolvedU.tools.indexOf('web_search') < 0 && resolvedU.tools.indexOf('fs.read') >= 0, 'fixture: the line run has files, no web');
  const before = summarizeCapabilities(resolvedU, { surface: 'autonomous' });
  A.ok(/search\/fetch the web and use the controlled browser, run shell commands and verify code, use live MCP connector tools and desktop control are unavailable on this run -- each needs either a watched session or an explicit per-routine grant the Commander sets on the routine itself\. Placing objects cannot change that here\./.test(before),
    'baseline (no scope): web is lumped under "placing objects cannot change that" — the false claim');
  const scopeU = () => scopeForRun({ loadStation: () => saved, agentId: 'rq1', runStation: rs, interactive: false });
  A.eq((scopeU() || {}).floorRouted, true, 'the routed run\'s scope is floor-routed');
  const note = summarizeCapabilities(resolvedU, { surface: 'autonomous', scopeFn: scopeU });
  A.ok(/so run shell commands and verify code, use live MCP connector tools and desktop control are unavailable on this run -- each needs either a watched session or an explicit per-routine grant the Commander sets on the routine itself\. Placing objects cannot change that here\. /.test(note),
    'the terminal and connectors keep the authority sentence (placing cannot grant them unattended)');
  A.ok(note.indexOf('Placing objects cannot change that here') > note.indexOf('run shell commands') && !/search\/fetch the web[^.]*Placing objects cannot change that here/.test(note),
    'web is no longer under "placing objects cannot change that"');
  A.ok(note.indexOf('No web on this run: RESEARCH, the room your desk is in, has no DISH; the Commander can place one there for your next job (the DISH in HOME does not reach you). If the job needed it, name that fix in your closing clause. ') >= 0,
    'names the room, the missing gear and where it stands instead: ' + note.slice(note.indexOf('No web'), note.indexOf('No web') + 300));
  // REVIEW FIX 1: a placed STUDIO does not give a line hop images (image_generate needs the routine's ALLOW IMAGES grant;
  // a line hop runs with unattendedGrants []), so the unattended note never offers images (or memory) as a floor fix
  A.ok(!/STUDIO|images|SERVER CART|NOTEBOOK|memory/.test(note), 'the unattended note offers no image or memory gear: ' + note.slice(note.indexOf('No web'), note.indexOf('No web') + 200));
  const lackOf = (s) => (s.match(/- You do NOT have: [^\n]*/) || [''])[0];
  A.eq(lackOf(note), lackOf(before), 'the lack list is the one the run had before the room scope (memory and images never join it unattended)');
  A.ok(/Say it in the Commander's terms, in one short closing clause/.test(note), 'the closing-clause rule still carries it to the delivered reply');
  console.log('[room-scope] unattended note: ' + before.length + ' -> ' + note.length + ' chars (+' + (note.length - before.length) + ')');

  // REVIEW FIX 3: the fix is named only when the job needed it, never as an order on every hop; a toolless turn
  // (a conversational channel reply) has no job that needed it, so it carries no order at all
  A.ok(!/Name that fix/.test(note), 'no unconditional order');
  const chat = summarizeCapabilities(resolvedU, { surface: 'autonomous', toolless: true, scopeFn: scopeU });
  A.ok(chat.indexOf('has no DISH; the Commander can place one there for your next job (the DISH in HOME does not reach you). Do NOT claim') >= 0 && !/name that fix/i.test(chat),
    'a toolless turn keeps the fact and drops the order: ' + chat.slice(chat.indexOf('No web'), chat.indexOf('No web') + 200));

  // the INTEL CAB half: a legacy agent (no execution profile) also lacks files; unattended, placing one grants READING
  // only (fs.write/edit stay default-denied without an AWAY WORKSHOP grant), so that is all the note offers
  const legacy = summarizeCapabilities(unattended(resolveTools('rq1', rs)), { surface: 'autonomous', scopeFn: scopeU });
  A.ok(legacy.indexOf('No web or file reading on this run: RESEARCH, the room your desk is in, has no DISH or INTEL CAB; the Commander can place them there for your next job (the ones in HOME do not reach you). If the job needed them, name that fix in your closing clause. ') >= 0,
    'a legacy agent is offered web and file reading: ' + legacy.slice(legacy.indexOf('No web'), legacy.indexOf('No web') + 260));

  // the fully furnished room: only the terminal (authority) is missing -> the old sentence, byte-identical
  const fx = M.create(st.serialize()), room = fx.rooms().find(r => r.name === 'RESEARCH'), Rr = room.rects[0];
  const want = ['comms_dish', 'gigs_servercart', 'studio'];
  for (let y = Rr.y1 + 1; y < Rr.y2 && want.length; y++) for (let x = Rr.x1 + 1; x < Rr.x2 && want.length; x++) {
    const r = fx.addProp({ t: want[0], x, y, w: 1, h: 1 }); if (r && r.ok) want.shift();
  }
  A.eq(want.length, 0, 'fixture: DISH + SERVER CART + STUDIO placed in RESEARCH');
  const r2 = makeRouter(); A.ok(r2.setStation(fx.serialize()).ok, 'fixture: the router takes the furnished station');
  const rs2 = r2.stationFor('rq1'), saved2 = checkedStation({ station: fx.serialize() });
  const res2 = unattended(resolveTools('rq1', withProfile(rs2, 'rq1')));
  const note2 = summarizeCapabilities(res2, { surface: 'autonomous', scopeFn: () => scopeForRun({ loadStation: () => saved2, agentId: 'rq1', runStation: rs2 }) });
  A.eq(note2, summarizeCapabilities(res2, { surface: 'autonomous' }), 'only the terminal is missing: the unattended note is byte-identical (no room clause)');

  // a DISH alone in RESEARCH: memory and images are still absent, but unattended they are no floor fix, so the (11 ms)
  // scope is never even asked for and the note is byte-identical
  const fd = M.create(st.serialize()), Rd = fd.rooms().find(r => r.name === 'RESEARCH').rects[0];
  let dish = null;
  for (let y = Rd.y1 + 1; y < Rd.y2 && !dish; y++) for (let x = Rd.x1 + 1; x < Rd.x2 && !dish; x++) { const r = fd.addProp({ t: 'comms_dish', x, y, w: 2, h: 2 }); if (r && r.ok) dish = r; }
  const r3 = makeRouter(); A.ok(!!dish && r3.setStation(fd.serialize()).ok, 'fixture: a DISH alone in RESEARCH');
  const res3 = unattended(resolveTools('rq1', withProfile(r3.stationFor('rq1'), 'rq1')));
  A.ok(res3.tools.indexOf('web_search') >= 0 && res3.tools.indexOf('image_generate') < 0, 'fixture: web granted, no studio');
  let asked3 = 0;
  const note3 = summarizeCapabilities(res3, { surface: 'autonomous', scopeFn: () => { asked3++; return null; } });
  A.eq(asked3, 0, 'only memory/images missing on an unattended run: the scope is never computed');
  A.eq(note3, summarizeCapabilities(res3, { surface: 'autonomous' }), '...and the note is byte-identical');

  // a DELEGATED worker keeps its own branch and never asks for the scope
  let asked = 0;
  const del = summarizeCapabilities(resolvedU, { surface: 'autonomous', delegatedBy: 'agent', scopeFn: () => { asked++; return scopeU(); } });
  A.eq(asked, 0, 'a delegated worker run never computes the scope');
  A.eq(del, summarizeCapabilities(resolvedU, { surface: 'autonomous', delegatedBy: 'agent' }), 'delegated: byte-identical');
  A.eq((() => { let n = 0; summarizeCapabilities(resolvedU, { surface: 'autonomous', unrestrictedHost: true, scopeFn: () => { n++; return null; } }); return n; })(), 0, 'FULL POWER never computes the scope');
}

/* 6. makeSavedFloor: one validation per save stamp; an unclean read is never memoized */
{
  let stamp = 's1', loads = 0;
  const floor = makeSavedFloor({ stamp: () => stamp, loadStamped: () => { loads++; return { doc: save, stamp }; } });
  const a = floor(), b = floor();
  A.ok(!!a && a === b && loads === 1, 'the same stamp reuses the validated floor (' + loads + ' load)');
  stamp = 's2'; floor();
  A.eq(loads, 2, 'a new stamp re-reads');
  let n = 0;
  const unclean = makeSavedFloor({ stamp: () => '', loadStamped: () => { n++; return { doc: save, stamp: '' }; } });
  unclean(); unclean();
  A.eq(n, 2, 'an empty stamp never memoizes');
  A.eq(makeSavedFloor({ stamp: () => 'x', loadStamped: () => ({ doc: undefined, stamp: 'x' }) })(), null, 'no save: null');
}

/* 7. THE HOST WIRING (index.js is never required: it boots a real sidecar). runOnceCore passes the lazy scope at the ONE
      capability-note seam, built from this run's own routed station / placed objects and the stamped saved floor. */
{
  const idx = readSidecarSource();
  A.ok(/const savedFloor = makeSavedFloor\(\{ stamp: \(\) => saveStore\.stamp\('agent'\), loadStamped: \(\) => saveStore\.loadStamped\('agent'\) \}\);/.test(idx), 'the saved floor is memoized by the save stamp');
  A.ok(/toolless: !isTask,\s*\n(?:\s*\/\/[^\n]*\n)*\s*disabledCaps: unrestrictedHostNow\(\) \? new Set\(\) : disabledCapsSet\(\), enabledToolsets: unrestrictedHostNow\(\) \? null : o\.enabledToolsets,\s*\n\s*mediaRoute: !!\(studioRoute && studioRoute\.ok\),\s*\n(?:\s*\/\/[^\n]*\n)*\s*scopeFn: \(\) => \{ try \{ return scopeForRun\(\{ loadStation: savedFloor, agentId, runStation: o\.station, extraObjects: o\.extraObjects, interactive: surface === 'interactive', floorless: !!o\.floorless, hasBay: \(\) => router\.docksOf\(agentId\)\.length > 0 \}\); \} catch \(e\) \{ failNote\('capsummary\.roomscope', e\); return null; \} \} \}\) \+ skillBlock;/.test(idx),
    'summarizeCapabilities gets the TOOLSETS switches, the routine\'s own toolset list, the image route and scopeFn from this run\'s station, placed objects, surface and the router\'s docks, failing open to null');
  A.ok(/^const router = makeRouter\(\{ savedStation: \(\) => savedFloor\(\) \}\);$/m.test(idx) && /const r = router\.setPlan\(plan\);/.test(idx), 'hasBay reads the router handleRouting posts the plan into (section 13 runs that very check on a posted plan)');
  A.ok(idx.indexOf('resolved = enforceEnabledToolsets(resolved, registry, unrestrictedHostNow() ? null : o.enabledToolsets);') > 0,
    '...and that toolset list is the very one enforceEnabledToolsets narrowed this run with');
  // ...and those two facts are the very ones the run's grants and its unavailable set were built from
  A.ok(idx.indexOf('resolveTools(agentId, station, undefined, { disabledCaps: unrestrictedHostNow() ? new Set() : disabledCapsSet() })') > 0 &&
    idx.indexOf('mediaRoute: !!(studioRoute && studioRoute.ok),             // the SAME route makeImageTools was built from') > 0,
    'resolveTools and unavailableTools read the same disabledCaps and image route');
  const at = idx.indexOf('let station = o.station ||');
  A.ok(at > 0 && idx.indexOf('composeOffice({ surface: officeSurface, lead: o.lead || ownerTrusted, connectorIds: connectors.ids(), extraObjects: o.extraObjects })') > 0,
    'the office the scope compares against is composed from the same o.extraObjects');
}

/* 8. ROOM NAMES ride the note VERBATIM (review fix 10-21): the old allowlist [A-Za-z0-9 &'._-] rewrote 'BÜRO' to 'B RO'
      and 'OPS / INTEL' to 'OPS INTEL', naming rooms that do not exist. A name the note cannot carry as-is ('<', '>',
      a line break, a control/format character, over 24) is never rewritten: no room is named, the old note stays. */
{
  function builtIn(roomName) {   // the lead's station.build, exactly as the top fixture, into a room the lead names
    const s = M.create(M.starterDoc()); s.ensureWorkstation('agent');
    const ids = [];
    const Rb = Object.assign({}, env, { canRecruit: true, recruit: role => { const id = 'rq' + (ids.length + 1); if (!s.ensureWorkstation(id).ok) return null; ids.push(id); return { id, name: role }; } });
    const plan = SB.planBuild(s.serialize(), { rooms: [{ name: roomName, size: 'giant', lines: [{ line: 'research_line', staff: [{ step: 1, agent: 'new' }, { step: 2, agent: 'new' }] }] }] }, Rb);
    A.ok(plan.ok && SB.apply(s, plan.plan, Rb).ok && ids[0] === 'rq1', 'fixture: built a research line in "' + roomName + '"');
    return s;
  }
  function renamed(from, to) { const s = M.create(st.serialize()); A.ok(s.renameRoom(s.rooms().find(r => r.name === from).id, to).ok, 'fixture: ' + from + ' renamed'); return s; }
  function noteOn(s) {
    const sv = { station: s.serialize() }, fl = checkedStation(sv), ex = savedPlacement(sv, 'rq1'), res = interactiveRun('rq1', ex);
    return { res, note: summarizeCapabilities(res, { surface: 'interactive', scopeFn: () => scopeForRun({ loadStation: () => fl, agentId: 'rq1', extraObjects: ex, interactive: true }) }),
      plain: summarizeCapabilities(res, { surface: 'interactive' }), floor: fl };
  }
  const PLACE = (room) => 'Place the DISH, SERVER CART and STUDIO in ' + room + ', the room your desk is in: gear in any other room (like the ones in HOME) does not reach you.';
  // the lead's own names (station.build keeps '/', accents and any script; roomCut uppercases)
  for (const [asked, room] of [['Ops / Intel', 'OPS / INTEL'], ['Büro', 'BÜRO'], ['Laboratório 研究', 'LABORATÓRIO 研究']]) {
    const s = builtIn(asked);
    A.ok(s.rooms().some(r => r.name === room), 'the floor shows ' + room);
    const n = noteOn(s).note;
    A.ok(n.indexOf(PLACE(room)) >= 0, 'station.build "' + asked + '": the note names ' + room + ' exactly: ' + n.slice(n.indexOf('Place the'), n.indexOf('Place the') + 90));
  }
  // REFIT renames (renameRoom keeps any text up to 24)
  for (const room of ['CAFÉ LAB', 'R+D/QA', 'LAB #2', '研究室']) {
    const n = noteOn(renamed('RESEARCH', room)).note;
    A.ok(n.indexOf(PLACE(room)) >= 0, 'RESEARCH renamed "' + room + '": the note names it exactly: ' + n.slice(n.indexOf('Place the'), n.indexOf('Place the') + 90));
  }
  // the gear's room, named verbatim too
  A.ok(noteOn(renamed('HOME', 'CAFÉ')).note.indexOf('(like the ones in CAFÉ) does not reach you.') >= 0, 'the room the gear stands in is named verbatim');
  // the unattended clause reads the same names
  {
    const s = builtIn('Büro'), rt = makeRouter();
    A.ok(rt.setStation(s.serialize()).ok, 'fixture: the router takes the BÜRO station');
    const rsB = rt.stationFor('rq1'), flB = checkedStation({ station: s.serialize() });
    const u = summarizeCapabilities(unattended(resolveTools('rq1', withProfile(rsB, 'rq1'))), { surface: 'autonomous', scopeFn: () => scopeForRun({ loadStation: () => flB, agentId: 'rq1', runStation: rsB }) });
    A.ok(u.indexOf('No web on this run: BÜRO, the room your desk is in, has no DISH;') >= 0, 'unattended: BÜRO named exactly: ' + u.slice(u.indexOf('No web'), u.indexOf('No web') + 80));
  }
  // names the note cannot carry as-is: FAIL CLOSED to the old note, byte-identical (never a rewritten name)
  for (const bad of ['LAB <2>', 'R&D</capabilities', 'TWO\nLINES', 'TAB\tROOM', 'RTL' + String.fromCharCode(0x202e) + 'BAL', 'LS' + String.fromCharCode(0x2028) + 'LAB']) {
    const o = noteOn(renamed('RESEARCH', bad));
    A.eq((capScope(o.floor, 'rq1') || {}).roomName, '', JSON.stringify(bad) + ': the scope carries no room name');
    A.eq(o.note, o.plain, JSON.stringify(bad) + ': no room is named, the note is the old one byte-for-byte');
  }
  {
    // a hand-edited save past renameRoom's 24: never truncated into another name
    const doc = st.serialize(), id = Object.keys(doc.rooms).find(k => doc.rooms[k].name === 'RESEARCH');
    doc.rooms[id].name = 'RESEARCH AND DEVELOPMENT LAB';
    const fl = checkedStation({ station: doc });
    A.ok(!!fl && fl.roomById(id).name === 'RESEARCH AND DEVELOPMENT LAB', 'fixture: a 28-char name validates');
    A.eq(consistentScope(fl, 'rq1', { grantedTypes: [] }), null, 'over 24: no scope, no truncated name');
  }
  // gear standing in a room whose name cannot be carried: that room is never named (nor rewritten)
  const o = noteOn(renamed('HOME', 'HO<ME'));
  A.ok(o.note.indexOf('Place the DISH in RESEARCH, the room your desk is in: gear in any other room does not reach you.') >= 0 && !/HO.?ME/.test(o.note),
    'a lossy gear room is skipped: ' + o.note.slice(o.note.indexOf('Place the'), o.note.indexOf('Place the') + 120));
}

/* 9. TOOLSETS KILL-SWITCH (review fix 10-21): resolveTools drops a switched-off family's grants (resolve.js isDisabled),
      so its gear is missing because of the switch, not the floor. Placing that gear grants nothing, so it is never a
      room fix: the unattended web clause said "the Commander can place one there" and interactive gained SERVER CART
      advice for a memory family switched OFF. */
{
  const officeRun = (off) => resolveTools('rq1', withProfile({ agents: { rq1: { id: 'rq1', room: 'office' } }, rooms: { office: { id: 'office', objects: composeOffice({ surface: 'interactive', extraObjects: extra }) } } }, 'rq1'), undefined, { disabledCaps: off });
  const off = { web: true, memory: true };
  const resOff = officeRun(off);
  A.ok(resOff.tools.indexOf('web_search') < 0 && resOff.tools.indexOf('notebook.write') < 0 && resOff.tools.indexOf('fs.read') >= 0, 'fixture: the switches dropped web + memory');
  const n = summarizeCapabilities(resOff, { surface: 'interactive', disabledCaps: off, scopeFn: scopeI });
  A.ok(!/SERVER CART|long-term memory|DISH[^.]*in RESEARCH/.test(n), 'a switched-off web or memory family is never offered as gear to place in RESEARCH: ' + n.slice(n.indexOf('If the Commander')));
  A.ok(n.indexOf('Place the STUDIO in RESEARCH, the room your desk is in: gear in any other room (like the STUDIO in HOME) does not reach you.') >= 0, 'the STUDIO, not switched off, is still the room fix');
  // every switchable floor family off: byte-identical to the note with no scope, in each shape resolve.js takes
  const all = ['web', 'memory', 'studio'];
  for (const shape of [{ web: true, memory: true, studio: true }, new Set(all), all.slice()]) {
    const res = officeRun(shape);
    let asked = 0;
    A.eq(summarizeCapabilities(res, { surface: 'interactive', disabledCaps: shape, scopeFn: () => { asked++; return scopeI(); } }), summarizeCapabilities(res, { surface: 'interactive' }),
      'interactive, ' + (Array.isArray(shape) ? 'array' : shape instanceof Set ? 'Set' : 'map') + ' of switched-off families: byte-identical to the no-scope note');
    A.eq(asked, 0, '...and the scope is never computed');
  }
  // the UNATTENDED routed line run: web switched off keeps "Placing objects cannot change that here", byte-identical
  const rt = makeRouter(); A.ok(rt.setStation(st.serialize()).ok, 'fixture: the router takes the built station');
  const rsK = rt.stationFor('rq1');
  const resU = unattended(resolveTools('rq1', withProfile(rsK, 'rq1'), undefined, { disabledCaps: off }));
  let askedU = 0;
  const u = summarizeCapabilities(resU, { surface: 'autonomous', disabledCaps: off, scopeFn: () => { askedU++; return scopeForRun({ loadStation: () => saved, agentId: 'rq1', runStation: rsK }); } });
  A.eq(u, summarizeCapabilities(resU, { surface: 'autonomous' }), 'unattended, web + memory switched off: byte-identical to the no-scope note');
  A.ok(/so search\/fetch the web and use the controlled browser, [^\n]*on the routine itself\. Placing objects cannot change that here\./.test(u) && !/No web on this run|place one there/.test(u), 'web stays under "placing objects cannot change that"');
  A.eq(askedU, 0, '...and the scope is never computed');
}

/* 10. NO IMAGE ROUTE (review fix 10-21): without a ChatGPT sign-in, an OpenAI/OpenRouter key or a StarNet account a
       placed STUDIO grants image_analyze only (image_generate is certainly unavailable and leaves the note), so the room
       advice offers the STUDIO for analysis, never generation; with a route it still offers generation. */
{
  const { unavailableTools } = require('../sidecar/capability/effective-toolsets.js');
  // runOnce's own seam: the certainly-unavailable tools leave the list before the note is written
  const seam = (res, mediaRoute) => { const un = unavailableTools({ mediaRoute }, new Set(res.tools)).byTool; return Object.assign({}, res, { tools: res.tools.filter(t => !Object.prototype.hasOwnProperty.call(un, t)) }); };
  const n = summarizeCapabilities(seam(resolvedI, false), { surface: 'interactive', mediaRoute: false, scopeFn: scopeI });
  A.ok(/You do NOT have: [^\n]*, analyze images\./.test(n) && /; analyze images -> place a STUDIO\./.test(n) && !/generate/.test(n), 'no image route: the STUDIO is offered for analysis only: ' + n.slice(n.indexOf('- You do NOT'), n.indexOf('- You do NOT') + 140));
  // the promise holds: the STUDIO placed in RESEARCH (the real floor) gives exactly that power and no more
  const fx = M.create(st.serialize()), Rs = fx.rooms().find(r => r.name === 'RESEARCH').rects[0];
  let placed = null;
  for (let y = Rs.y1 + 1; y < Rs.y2 && !placed; y++) for (let x = Rs.x1 + 1; x < Rs.x2 && !placed; x++) { const r = fx.addProp({ t: 'studio', x, y, w: 1, h: 1 }); if (r && r.ok) placed = r; }
  const saveS = { station: fx.serialize() }, flS = checkedStation(saveS), exS = savedPlacement(saveS, 'rq1');
  A.ok(!!placed && exS.map(o => o.objectType).join() === 'studio', 'fixture: a STUDIO placed in RESEARCH reaches rq1');
  const nS = summarizeCapabilities(seam(interactiveRun('rq1', exS), false), { surface: 'interactive', mediaRoute: false, scopeFn: () => scopeForRun({ loadStation: () => flS, agentId: 'rq1', extraObjects: exS, interactive: true }) });
  A.ok(/- You CAN: [^\n]*, analyze images\./.test(nS) && !/generate|STUDIO/.test(nS), 'with it placed: "analyze images" is a power, generation is never claimed');
  // with an image route the advice is unchanged
  const nR = summarizeCapabilities(seam(resolvedI, true), { surface: 'interactive', mediaRoute: true, scopeFn: scopeI });
  A.ok(/; generate and analyze images -> place a STUDIO\./.test(nR), 'an image route: the STUDIO is offered for generation');
  A.eq(nR, summarizeCapabilities(resolvedI, { surface: 'interactive', scopeFn: scopeI }), 'mediaRoute true = the note before this fix');
  console.log('[room-scope] no-image-route note: ' + nR.length + ' -> ' + n.length + ' chars (' + (n.length - nR.length) + ')');
}

/* 11. THE PROP THAT REALLY STANDS THERE (review fix 10-21): the hint named each power's CANONICAL prop ("like the DISH in
       HOME") wherever any web gear stood, so a HOME holding an UPLINK, a RELAY STACK or a SAFE was said to hold a DISH,
       a SERVER CART or an INTEL CAB; and a gear room sharing the agent's own room's name made the note name one room
       as both places ("Place the DISH in RESEARCH ... (like the DISH in RESEARCH)"). Rooms are keyed by id, named for display. */
{
  const { GEAR_LABEL } = require('../sidecar/capability/cap-scope.js');
  const NOT_GEAR = { computer: 1, connector: 1, plugin: 1 };
  for (const t of Object.keys(M.CAP_PROP_MAP).filter(t => !NOT_GEAR[M.capForProp(t)]))
    A.eq((GEAR_LABEL || {})[t], (Sprites.spec(t) || {}).label, 'the note names a ' + t + ' as the floor labels it');
  function swapIn(s, roomName, pairs) {   // replace a room's gear with a sibling granting the same power
    const room = s.rooms().find(r => r.name === roomName);
    for (const [from, to] of pairs) {
      const old = s.props().find(p => p.t === from && s.roomAt(p.x, p.y) === room.id);
      A.ok(!!old && s.removeProp(old.id).ok, 'fixture: ' + roomName + '\'s ' + from + ' removed');
      const sp = Sprites.spec(to);
      let ok = false;
      for (const Rr of room.rects) for (let y = Rr.y1 + 1; y < Rr.y2 && !ok; y++) for (let x = Rr.x1 + 1; x < Rr.x2 && !ok; x++) { const r = s.addProp({ t: to, x, y, w: sp.w, h: sp.h }); ok = !!(r && r.ok); }
      A.ok(ok, 'fixture: a ' + sp.label + ' placed in ' + roomName);
    }
    return s;
  }
  const labelsIn = (fl, roomName) => { const id = fl.rooms().find(r => r.name === roomName).id; return fl.props().filter(p => fl.roomAt(p.x, p.y) === id).map(p => (Sprites.spec(p.t) || {}).label); };
  const sw = swapIn(M.create(st.serialize()), 'HOME', [['comms_dish', 'comms_uplink'], ['gigs_servercart', 'bridge_relaystack'], ['war_intelcab', 'safe']]);
  const svS = { station: sw.serialize() }, flS = checkedStation(svS), exS = savedPlacement(svS, 'rq1');
  A.ok(['UPLINK', 'RELAY STACK', 'SAFE', 'STUDIO'].every(l => labelsIn(flS, 'HOME').indexOf(l) >= 0) &&
    labelsIn(flS, 'HOME').every(l => ['DISH', 'SERVER CART', 'INTEL CAB'].indexOf(l) < 0), 'fixture: HOME holds an UPLINK, a RELAY STACK, a SAFE and a STUDIO, and no DISH, SERVER CART or INTEL CAB');
  const nI = summarizeCapabilities(interactiveRun('rq1', exS), { surface: 'interactive', scopeFn: () => scopeForRun({ loadStation: () => flS, agentId: 'rq1', extraObjects: exS, interactive: true }) });
  A.ok(nI.indexOf('Place the DISH, SERVER CART and STUDIO in RESEARCH, the room your desk is in: gear in any other room (like the UPLINK, RELAY STACK and STUDIO in HOME) does not reach you.') >= 0,
    'interactive: the hint names the props HOME really holds: ' + nI.slice(nI.indexOf('Place the'), nI.indexOf('Place the') + 200));
  A.ok(!/(DISH|SERVER CART|ones) in HOME/.test(nI), 'never "the DISH in HOME" or "the ones in HOME" when they are not there');
  // the unattended line run (a legacy agent lacks files too): the routed room as the router builds it
  const rtS = makeRouter(); A.ok(rtS.setStation(sw.serialize()).ok, 'fixture: the router takes the swapped station');
  const rsS = rtS.stationFor('rq1');
  const nU = summarizeCapabilities(unattended(resolveTools('rq1', rsS)), { surface: 'autonomous', scopeFn: () => scopeForRun({ loadStation: () => flS, agentId: 'rq1', runStation: rsS }) });
  A.ok(nU.indexOf('has no DISH or INTEL CAB; the Commander can place them there for your next job (the UPLINK and SAFE in HOME do not reach you). ') >= 0,
    'unattended: the UPLINK and SAFE are named: ' + nU.slice(nU.indexOf('No web'), nU.indexOf('No web') + 220));
  // a gear room named like the agent's own room: never named as where the gear stands (it would be both places)
  const twin = M.create(st.serialize());
  A.ok(twin.renameRoom(twin.rooms().find(r => r.name === 'HOME').id, 'RESEARCH').ok && twin.rooms().filter(r => r.name === 'RESEARCH').length === 2, 'fixture: HOME renamed RESEARCH (renameRoom allows a twin name)');
  const svT = { station: twin.serialize() }, flT = checkedStation(svT), exT = savedPlacement(svT, 'rq1');
  const nT = summarizeCapabilities(interactiveRun('rq1', exT), { surface: 'interactive', scopeFn: () => scopeForRun({ loadStation: () => flT, agentId: 'rq1', extraObjects: exT, interactive: true }) });
  A.ok(nT.indexOf('Place the DISH, SERVER CART and STUDIO in RESEARCH, the room your desk is in: gear in any other room does not reach you.') >= 0,
    'twin name, interactive: the gear\'s room is not named: ' + nT.slice(nT.indexOf('Place the'), nT.indexOf('Place the') + 160));
  const rtT = makeRouter(); A.ok(rtT.setStation(twin.serialize()).ok, 'fixture: the router takes the twin-named station');
  const rsT = rtT.stationFor('rq1');
  const uT = summarizeCapabilities(unattended(resolveTools('rq1', rsT)), { surface: 'autonomous', scopeFn: () => scopeForRun({ loadStation: () => flT, agentId: 'rq1', runStation: rsT }) });
  A.ok(uT.indexOf('RESEARCH, the room your desk is in, has no DISH or INTEL CAB; the Commander can place them there for your next job. ') >= 0 && !/in RESEARCH (do|does) not reach/.test(uT),
    'twin name, unattended: never "has no DISH ... (the ones in RESEARCH do not reach you)": ' + uT.slice(uT.indexOf('No web'), uT.indexOf('No web') + 200));
  // two OTHER rooms sharing a name stay two rooms: the SERVER CART moved to a new room also called HOME
  const two = M.create(st.serialize()), spot = two.roomSpots(6, 6, 'hab', 1)[0];
  A.ok(!!spot, 'fixture: room for a third room');
  const added = two.addRoom({ kind: 'hab', rect: spot.rect || spot });
  A.ok(added && added.ok, 'fixture: a third room added (' + JSON.stringify(added && (added.msg || added.error)) + ')');
  const third = two.rooms().find(r => r.name !== 'HOME' && r.name !== 'RESEARCH');
  A.ok(!!third && two.renameRoom(third.id, 'HOME').ok, 'fixture: the third room is also called HOME');
  const cart = two.props().find(p => p.t === 'gigs_servercart');
  A.ok(two.removeProp(cart.id).ok, 'fixture: the SERVER CART leaves the first HOME');
  let moved = false;
  for (const Rr of two.roomById(third.id).rects) for (let y = Rr.y1 + 1; y < Rr.y2 && !moved; y++) for (let x = Rr.x1 + 1; x < Rr.x2 && !moved; x++) { const r = two.addProp({ t: 'gigs_servercart', x, y, w: 1, h: 1 }); moved = !!(r && r.ok); }
  A.ok(moved, 'fixture: the SERVER CART stands in the second HOME');
  const svW = { station: two.serialize() }, flW = checkedStation(svW), exW = savedPlacement(svW, 'rq1');
  const nW = summarizeCapabilities(interactiveRun('rq1', exW), { surface: 'interactive', scopeFn: () => scopeForRun({ loadStation: () => flW, agentId: 'rq1', extraObjects: exW, interactive: true }) });
  A.ok(nW.indexOf('(like the DISH and STUDIO in HOME and the SERVER CART in HOME) does not reach you.') >= 0,
    'two rooms called HOME are two rooms, never "the ones in HOME": ' + nW.slice(nW.indexOf('Place the'), nW.indexOf('Place the') + 200));
  // the starter floor (one of each canonical prop in HOME) keeps its exact words
  A.ok(summarizeCapabilities(resolvedI, { surface: 'interactive', scopeFn: scopeI }).indexOf('(like the ones in HOME) does not reach you.') >= 0, 'canonical gear: "the ones in HOME", unchanged');
}

/* 12. A ROUTINE'S OWN TOOLSET LIST (review fix 10-21): runOnceCore narrows the run with enforceEnabledToolsets(resolved,
       registry, o.enabledToolsets), and every cron fire and line hop passes job.enabledToolsets with a routed bay station.
       A routine limited to ['cabinet'] lacks web because of ITS list, not the floor, so a DISH placed in RESEARCH grants it
       nothing. The note said "No web on this run: RESEARCH ... has no DISH; the Commander can place one there"; the true
       sentence (a per-routine setting; placing cannot change that) is the note with no scope, byte-identical. */
{
  const { enforceEnabledToolsets } = require('../sidecar/inputpolicy.js');
  // the registry's family for each tool is its capability (fs.read -> cabinet, web_search -> web, as the tool defs declare)
  const fam = {};
  const registry = { get: (n) => ({ capability: fam[n] || '' }) };
  const lineRun = (station, profiled, list) => {
    const base = unattended(resolveTools('rq1', profiled ? withProfile(station, 'rq1') : station));
    for (const g of base.grants) fam[g.tool] = g.capId;
    return enforceEnabledToolsets(base, registry, list);
  };
  const rt = makeRouter(); A.ok(rt.setStation(st.serialize()).ok, 'fixture: the router takes the built station');
  const rsE = rt.stationFor('rq1');
  const scopeE = (fl, rs) => scopeForRun({ loadStation: () => fl, agentId: 'rq1', runStation: rs });
  const res = lineRun(rsE, true, ['cabinet']);
  A.ok(res.tools.indexOf('web_search') < 0 && res.tools.indexOf('fs.read') >= 0, 'fixture: the routine limited to FILES has files, no web');
  // the promise the old note made is false: a DISH placed in RESEARCH, the same list, still no web
  const fx = M.create(st.serialize()), Rr = fx.rooms().find(r => r.name === 'RESEARCH').rects[0];
  let dish = null;
  for (let y = Rr.y1 + 1; y < Rr.y2 && !dish; y++) for (let x = Rr.x1 + 1; x < Rr.x2 && !dish; x++) { const r = fx.addProp({ t: 'comms_dish', x, y, w: 1, h: 1 }); if (r && r.ok) dish = r; }
  const rtD = makeRouter(); A.ok(!!dish && rtD.setStation(fx.serialize()).ok, 'fixture: a DISH placed in RESEARCH');
  A.ok(lineRun(rtD.stationFor('rq1'), true, null).tools.indexOf('web_search') >= 0 && lineRun(rtD.stationFor('rq1'), true, ['cabinet']).tools.indexOf('web_search') < 0,
    'that DISH grants web to an unrestricted run, never to the routine limited to FILES');
  let asked = 0;
  const n = summarizeCapabilities(res, { surface: 'autonomous', enabledToolsets: ['cabinet'], scopeFn: () => { asked++; return scopeE(saved, rsE); } });
  A.eq(n, summarizeCapabilities(res, { surface: 'autonomous' }), 'limited to [\'cabinet\']: byte-identical to the no-scope note');
  A.ok(/so search\/fetch the web and use the controlled browser, [^\n]*on the routine itself\. Placing objects cannot change that here\./.test(n) && !/No web on this run|place one there/.test(n),
    'web stays under the per-routine sentence: ' + n.slice(n.indexOf('This is an UNATTENDED'), n.indexOf('This is an UNATTENDED') + 160));
  A.eq(asked, 0, '...and the scope is never computed');
  // a family the list keeps is still a true room fix: a legacy agent (no profile) limited to FILES is offered the INTEL CAB,
  // never the DISH, and an INTEL CAB placed in RESEARCH really gives that routine file reading
  const legacy = summarizeCapabilities(lineRun(rsE, false, ['cabinet']), { surface: 'autonomous', enabledToolsets: ['cabinet'], scopeFn: () => scopeE(saved, rsE) });
  A.ok(legacy.indexOf('No file reading on this run: RESEARCH, the room your desk is in, has no INTEL CAB; the Commander can place one there for your next job (the INTEL CAB in HOME does not reach you). ') >= 0 &&
    !/has no DISH|No web/.test(legacy), 'a kept family is still offered, a left-out one never: ' + legacy.slice(legacy.indexOf('Placing objects'), legacy.indexOf('Placing objects') + 260));
  const fc = M.create(st.serialize()), Rc = fc.rooms().find(r => r.name === 'RESEARCH').rects[0];
  let cab = null;
  for (let y = Rc.y1 + 1; y < Rc.y2 && !cab; y++) for (let x = Rc.x1 + 1; x < Rc.x2 && !cab; x++) { const sp = Sprites.spec('war_intelcab'); const r = fc.addProp({ t: 'war_intelcab', x, y, w: sp.w, h: sp.h }); if (r && r.ok) cab = r; }
  const rtC = makeRouter(); A.ok(!!cab && rtC.setStation(fc.serialize()).ok, 'fixture: an INTEL CAB placed in RESEARCH');
  A.ok(lineRun(rtC.stationFor('rq1'), false, ['cabinet']).tools.indexOf('fs.read') >= 0, '...and the routine limited to FILES then reads files: the offer holds');
  // null = no restriction: the section 5 note, unchanged; [] restricts as the gate does (every family out): no scope
  const resU = unattended(resolveTools('rq1', withProfile(rsE, 'rq1')));
  A.eq(summarizeCapabilities(resU, { surface: 'autonomous', enabledToolsets: null, scopeFn: () => scopeE(saved, rsE) }), summarizeCapabilities(resU, { surface: 'autonomous', scopeFn: () => scopeE(saved, rsE) }),
    'enabledToolsets null: the room note is unchanged');
  let askedEmpty = 0;
  const resEmpty = lineRun(rsE, true, []);
  A.eq(summarizeCapabilities(resEmpty, { surface: 'autonomous', enabledToolsets: [], scopeFn: () => { askedEmpty++; return scopeE(saved, rsE); } }), summarizeCapabilities(resEmpty, { surface: 'autonomous' }),
    'an empty list (the gate keeps only the freebies): byte-identical, no room fix');
  A.eq(askedEmpty, 0, '...and the scope is never computed');
}

/* 13. THE PRODUCTION PATH (polish 10-21): sections 5-12 hand the router the station (setStation), which no sidecar route
       calls. Live, world.js compileRouting compiles Pipeline.compileRoutingPlan(station.projectGeometry()), stamps every
       bay record with station.bayObjects(agentId, propId), and POSTs it; handleRouting JSON-parses it into router.setPlan,
       and stationFor builds a routed run's room from those stamped objects. index.js's scopeFn asks router.docksOf first. */
{
  function posted(s) {   // world.js compileRouting -> postRoutingPlan -> handleRouting, byte for byte through JSON
    const plan = P.compileRoutingPlan(s.projectGeometry());
    for (const b of (plan.bays || [])) b.objects = s.bayObjects(b.agentId, b.propId);
    for (const b of (plan.dockBays || [])) b.objects = s.bayObjects(b.agentId, b.propId);
    return JSON.parse(JSON.stringify(plan));
  }
  const hasBayOn = (rt, id) => () => rt.docksOf(id).length > 0;   // index.js's cheap check, verbatim
  const { floorTypes } = require('../sidecar/capability/cap-scope.js');
  const floorTypesOf = (r) => floorTypes(r.rooms.bay.objects);
  const rt = makeRouter(), set = rt.setPlan(posted(st));
  A.ok(set.ok || set.caps, 'fixture: the router takes the posted plan (' + JSON.stringify(set) + ')');
  const bay1 = st.props().find(p => p.t === 'bay' && p.agentId === 'rq1');
  const rs = rt.stationFor('rq1', bay1.id);
  A.ok(rs && rs.floor && rs.floor.dockId === bay1.id, 'the posted plan\'s routed room carries the floor marker: ' + JSON.stringify(rs && rs.floor));
  A.eq(floorTypesOf(rs), [], '...built from the stamped objects: RESEARCH holds no floor gear');
  let loads = 0;
  const loadSaved = () => { loads++; return saved; };
  const resU = unattended(resolveTools('rq1', withProfile(rs, 'rq1')));
  const u = summarizeCapabilities(resU, { surface: 'autonomous', scopeFn: () => scopeForRun({ loadStation: loadSaved, agentId: 'rq1', runStation: rs, hasBay: hasBayOn(rt, 'rq1') }) });
  A.ok(u.indexOf('No web on this run: RESEARCH, the room your desk is in, has no DISH; the Commander can place one there for your next job (the DISH in HOME does not reach you). ') >= 0,
    'a posted-plan line run names RESEARCH: ' + u.slice(u.indexOf('No web'), u.indexOf('No web') + 200));
  A.eq(loads, 1, '...loading the saved floor once');
  const nI = summarizeCapabilities(resolvedI, { surface: 'interactive', scopeFn: () => scopeForRun({ loadStation: loadSaved, agentId: 'rq1', extraObjects: extra, interactive: true, hasBay: hasBayOn(rt, 'rq1') }) });
  A.ok(nI.indexOf('Place the DISH, SERVER CART and STUDIO in RESEARCH, the room your desk is in: gear in any other room (like the ones in HOME) does not reach you.') >= 0, 'a COMMS run of a crew with a bay on the posted plan names RESEARCH');

  // PERF: the bayless hero missing gear (no STUDIO placed: the common floor) never loads or validates the saved floor
  const fh = M.create(st.serialize());
  A.ok(fh.removeProp(fh.props().find(p => p.t === 'studio').id).ok, 'fixture: the station has no STUDIO');
  const rtH = makeRouter(), setH = rtH.setPlan(posted(fh)); A.ok(setH.ok || setH.caps, 'fixture: the router takes the STUDIO-less plan');
  const heroRes = interactiveRun('agent', savedPlacement({ station: fh.serialize() }, 'agent'));
  A.ok(heroRes.tools.indexOf('image_generate') < 0, 'fixture: the hero lacks images');
  loads = 0;
  let asked = 0;
  const heroNote = summarizeCapabilities(heroRes, { surface: 'interactive', scopeFn: () => { asked++; return scopeForRun({ loadStation: loadSaved, agentId: 'agent', extraObjects: [], interactive: true, hasBay: hasBayOn(rtH, 'agent') }); } });
  A.eq([asked, loads], [1, 0], 'the hero crews no bay on the posted plan: the scope is asked, the saved floor is never loaded');
  A.eq(heroNote, summarizeCapabilities(heroRes, { surface: 'interactive' }), '...and its note is byte-identical');
  A.eq(scopeForRun({ loadStation: loadSaved, agentId: 'rq1', interactive: true, extraObjects: extra, hasBay: () => false }), null, 'no bay on the plan: no scope');
  A.eq(loads, 0, '...and no load');

  // MULTI-BAY: a desk-less WRITER crews its RESEARCH bay AND a bay in HOME. Its HOME runs DO get HOME's gear, so the note
  // never says that gear "does not reach you", and "your bay" (which one?) is "this bay" on a line run
  const fm = M.create(st.serialize());
  A.ok(fm.removeProp(fm.props().find(p => p.agentId === 'rq2' && /^desk/.test(p.t)).id).ok, 'fixture: the WRITER loses its desk');
  const home = fm.rooms().find(r => r.name === 'HOME'), research = fm.rooms().find(r => r.name === 'RESEARCH');
  let bayH = null;
  for (const Rr of home.rects) for (let y = Rr.y1 + 1; y < Rr.y2 && !bayH; y++) for (let x = Rr.x1 + 1; x < Rr.x2 && !bayH; x++) {
    const r = fm.addProp({ t: 'bay', x, y, w: 2, h: 2, block: true, agentId: 'rq2' }); if (r && r.ok) bayH = r;
  }
  const bayR = fm.props().find(p => p.t === 'bay' && p.agentId === 'rq2' && fm.roomAt(p.x, p.y) === research.id);
  A.ok(!!bayH && !!bayR && fm.props().filter(p => p.t === 'bay' && p.agentId === 'rq2').length === 2 && fm.roomAt(fm.props().find(p => p.id === bayH.id).x, fm.props().find(p => p.id === bayH.id).y) === home.id,
    'fixture: the WRITER crews a bay in RESEARCH and one in HOME');
  const svM = { station: fm.serialize() }, flM = checkedStation(svM);
  const rtM = makeRouter(), setM = rtM.setPlan(posted(fm));
  A.ok(setM.ok || setM.caps, 'fixture: the router takes the multi-bay plan (' + JSON.stringify(setM) + ')');
  A.eq(rtM.docksOf('rq2').length, 2, 'the posted plan knows both docks');
  const rsH = rtM.stationFor('rq2', bayH.id), rsR = rtM.stationFor('rq2', bayR.id);
  A.ok(rsH.floor.dockId === bayH.id && floorTypesOf(rsH).indexOf('dish') >= 0, 'its HOME bay\'s runs DO draw on HOME\'s DISH');
  A.ok(rsR.floor.dockId === bayR.id && floorTypesOf(rsR).indexOf('dish') < 0, 'its RESEARCH bay\'s runs do not');
  const sM = capScope(flM, 'rq2', bayR.id);
  A.ok(sM && sM.roomName === 'RESEARCH' && sM.via === 'bay' && sM.bays === 2, 'scoped to the RESEARCH bay\'s room, two bays: ' + JSON.stringify(sM && { r: sM.roomName, via: sM.via, bays: sM.bays }));
  A.ok(Object.keys(sM.gearElsewhere).every(t => sM.gearElsewhere[t].every(x => x.id !== home.id)), 'HOME, a capability room of its other bay, is never "elsewhere": ' + JSON.stringify(sM.gearElsewhere));
  const uM = summarizeCapabilities(unattended(resolveTools('rq2', withProfile(rsR, 'rq2'))), { surface: 'autonomous',
    scopeFn: () => scopeForRun({ loadStation: () => flM, agentId: 'rq2', runStation: rsR, hasBay: hasBayOn(rtM, 'rq2') }) });
  A.ok(uM.indexOf('No web on this run: RESEARCH, the room this bay is in, has no DISH; the Commander can place one there for your next job. If the job needed it') >= 0 && !/HOME/.test(uM),
    'the RESEARCH line run: "this bay", and HOME\'s DISH is never said not to reach it: ' + uM.slice(uM.indexOf('No web'), uM.indexOf('No web') + 200));
  const uH = summarizeCapabilities(unattended(resolveTools('rq2', withProfile(rsH, 'rq2'))), { surface: 'autonomous',
    scopeFn: () => scopeForRun({ loadStation: () => flM, agentId: 'rq2', runStation: rsH, hasBay: hasBayOn(rtM, 'rq2') }) });
  A.ok(/You CAN: [^\n]*search\/fetch the web/.test(uH) && !/No web/.test(uH), 'the HOME line run has web: no room fix');
  // a COMMS chat is at no bay: it draws on the agent's first bay's room (worldmodel.agentRoomId with no dock)
  const exM = savedPlacement(svM, 'rq2');
  A.eq(exM.map(o => o.objectType), [], 'fixture: the chat draws on the first bay\'s room, RESEARCH');
  const iM = summarizeCapabilities(interactiveRun('rq2', exM), { surface: 'interactive', scopeFn: () => scopeForRun({ loadStation: () => flM, agentId: 'rq2', extraObjects: exM, interactive: true, hasBay: hasBayOn(rtM, 'rq2') }) });
  A.ok(iM.indexOf('Place the DISH in RESEARCH, the room your first bay is in: gear in any other room does not reach you.') >= 0 && !/HOME/.test(iM),
    'the chat: "your first bay", HOME never named: ' + iM.slice(iM.indexOf('Place the'), iM.indexOf('Place the') + 160));
  // one bay is unchanged: "your bay"
  A.ok(/Place the DISH in RESEARCH, the room your bay is in:/.test(summarizeCapabilities(interactiveRun('rq2', []), { surface: 'interactive', scopeFn: () => Object.assign({}, sM, { bays: 1 }) })), 'one bay: "your bay"');
}

A.report('capsummary-room-scope.test');
