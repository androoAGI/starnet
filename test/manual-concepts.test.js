// node test/manual-concepts.test.js — the agent's manual knows EVERYTHING, and none of it can drift (2026-10-05, self-driving
// lane 2: "the agents [should] understand EVERYTHING about starnet … so it can basically use itself").
//   A. CONCEPTS names only real places ([id] = a station.show place), real tools and real station.control actions;
//   B. NAVIGATION's EVERY PLACE list is generated from frontend/app/places.js — every place, once, in the UI's words;
//   C. every "MENU › TAB" path anywhere in the manual is a real place (or a real group label, checked in its source file);
//   D. an owner on a chat app gets a short pointer to manual.read naming every reference section — never the 6K index;
//   E. the pieces the dossier no longer has are never named (the SKILLS tab, the APPROVALS hotspot, Alt+A).
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const M = require('../sidecar/manual.js');
const Places = require('../frontend/app/places.js');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');
const { ACTIONS } = require('../sidecar/tools/builtin/station-control.js');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const concepts = M.manualSection('concepts');
const nav = M.manualSection('navigation');
const full = M.starnetManual();

// ---- A. CONCEPTS: real places, real tools, real actions ----
A.ok(concepts && concepts.length > 4000, 'concepts is a real section (' + (concepts || '').length + ' chars)');
const tags = [...concepts.matchAll(/\[([a-z][a-z-]*)\]/g)].map(m => m[1]);
A.ok(tags.length >= 30, 'concepts points at places (' + tags.length + ' tags)');
for (const t of new Set(tags)) A.ok(!!Places.get(t), 'concepts tag [' + t + '] is a station.show place');
for (const must of ['CREW', 'PROPS', 'WORKFLOWS', 'OUTBOX', 'RECIPES', 'SCHEDULES', 'GOAL LOOPS', 'AWAY WORK', 'TASKS', 'GROUP CHAT', 'ACCESS',
  'AUTONOMY', 'E-STOP', 'SPENDING', 'MEMORY', 'RESTORE POINTS', 'QUESTS', 'TROPHIES', 'NOTIFICATIONS', 'ABILITIES', 'CHANNELS', 'APPS', 'STEP-IN', 'DOSSIER'])
  A.ok(concepts.indexOf(must) >= 0, 'concepts explains ' + must);
const tools = new Set(Object.values(CAP_REGISTRY).flat().map(g => g.tool));
const actions = new Set(Object.keys(ACTIONS));
const prefixes = new Set([...tools, ...actions].map(n => n.split('.')[0]));
// every dotted name in CONCEPTS: a granted tool, a station.control action, a family wildcard (agent.*), or a settings key
for (const m of new Set([...concepts.matchAll(/\b([a-z_]+)\.([a-z_*]+)\b/g)].map(x => x[0]))) {
  const [fam, verb] = m.split('.');
  const ok = tools.has(m) || actions.has(m) || (verb === '*' && prefixes.has(fam)) || m === 'memory.settings';
  A.ok(ok, 'concepts names a real tool or action: ' + m);
}
A.ok(actions.has('memory.settings'), 'memory.settings (reflection) is a real station.control action');
for (const t of ['station.show', 'manual.read', 'team.summon', 'routine.create', 'loop.create', 'station.test_line', 'station.start_line', 'connectors.list', 'deliverable_note', 'quest.update'])
  A.ok(tools.has(t), t + ' is a granted tool');

// ---- B. EVERY PLACE: generated, complete, once each ----
const listed = [...nav.matchAll(/^- ([a-z][a-z-]*) → (.+?) — /gm)].map(m => [m[1], m[2]]);
A.eq(listed.map(x => x[0]), Places.ids(), 'navigation lists every place, in catalog order');
for (const [id, words] of listed) A.eq(words, Places.get(id).words, id + ': listed in the UI\'s own words');
A.ok(nav.indexOf('station.show') >= 0, 'navigation tells the agent to OPEN places with station.show');

// ---- C. every MENU › TAB path in the manual exists ----
const paths = [...new Set(full.match(/[A-Z][A-Z&\/ -]*[A-Z](?: › [A-Z][A-Z&\/ -]*[A-Z])+/g))];
A.ok(paths.length >= 20, 'the manual names menu paths (' + paths.length + ')');
// group/section labels that are real but are not themselves a place — each proven in its own source
const LABELS = {
  'INSTALLED': ['frontend/app/windows/connectors.js', "label: 'INSTALLED'"],
  'NEEDS YOU': ['frontend/app/stationui.js', '>NEEDS YOU <']
};
for (const [label, [file, needle]] of Object.entries(LABELS)) A.ok(read(file).indexOf(needle) >= 0, 'label ' + label + ' still exists in ' + file);
const words = Places.PLACES.map(p => p.words);
for (const p of paths) {
  // a known label is dropped; what is left (a place's path, or the start of one) must be real — or the path is the label alone
  const rest = p.split(' › ').filter(seg => !LABELS[seg]).join(' › ');
  const real = !rest || words.some(w => w === rest || w.indexOf(rest + ' › ') === 0 || w.split(' › ').slice(-rest.split(' › ').length).join(' › ') === rest);
  A.ok(real, 'the manual\'s path "' + p + '" is a real place');
}

// ---- D. the owner on a chat app: a pointer, not the index ----
const ptr = M.starnetManualPointer();
A.ok(ptr.length < 600, 'the pointer is short (' + ptr.length + ' chars) — the index is ' + M.starnetManualIndex().length);
for (const s of M.MANUAL_SECTIONS.filter(x => x.kind === 'reference')) A.ok(ptr.indexOf(s.id) >= 0, 'the pointer names section ' + s.id);
A.ok(/manual\.read/.test(ptr) && /never answer that from memory/.test(ptr) && /station\.show cannot open/.test(ptr), 'the pointer says: call manual.read, never memory, cannot open places');
const ix = read('sidecar/index.js');
A.ok(/\(isTask && ownerTrusted && coreNames\.indexOf\('manual\.read'\) >= 0\) \? starnetManualPointer\(\) : ''/.test(ix), 'index.js: an owner-trusted task turn with manual.read on the wire gets the pointer');
A.ok(/\(isTask && surface === 'interactive'\) \? \(coreNames\.indexOf\('manual\.read'\) >= 0 \? starnetManualIndex\(\) : starnetManual\(\)\)/.test(ix), 'index.js: the watched station still gets the inline index');

// ---- E. nothing that is gone ----
for (const gone of [/SKILLS tab/, /APPROVALS hotspot/, /Alt\+A/]) A.ok(!gone.test(full), 'the manual never names ' + gone);

A.report('manual-concepts');
