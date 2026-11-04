/* test/refit-playtest-fixes.test.js — the 2026-09-23 first-time-user playtest of REFIT conveyors.

   1. WORKFLOW PIECES WERE BURIED: the Conveyors tab offered LINES + BELT only; every single machine was a
      Props-search away, and "inbox" found two different INBOX pieces. Now the tab carries a MACHINES shelf
      computed from the catalog (every cat:'workflow' entry, each with its one-line purpose), and the decor
      tray is the MAIL TRAY — one canonical INBOX (its id unchanged, so old saves keep rendering).
   3. STALE HELP COPY: the guide named "PROPS → WORKSTATIONS & WORKFLOWS", "LAYOUTS (9)" and "PREVIEW"; the
      Field Manual said "PROPS › WORKFLOW", "TEST", and its BRANCHES entry had no JOINER/LOOP. Every name and
      count now comes from the UI's own tables (Build.refitNames), and the testing copy names the docked
      Workflow panel's STEP TEST.
   4. SMALL ONES: a bare ESC no longer throws you out of REFIT (it arms "press again"); mid-connect only the
      HOVERED target says CLICK TO CONNECT; the NOT FED nag is short (full sentence on the hover card); a
      machine moved away from its belts says they stay behind. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PS = require('../frontend/app/propsprites.js');
const PropSearch = require('../frontend/app/propsearch.js');


const read = f => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', f), 'utf8');
const build = read('build.js');
const tutorialSrc = read('tutorial.js');

/* ---------- 1. one canonical INBOX + the MACHINES shelf ---------- */
{
  const cat = PS.CATALOG;
  const inboxes = cat.filter(c => String(c.label).toUpperCase() === 'INBOX');
  A.eq(inboxes.map(c => c.id), ['intake'], 'exactly ONE catalog piece is labelled INBOX — the workflow intake');
  const tray = cat.find(c => c.id === 'comms_inbox');
  A.ok(tray && tray.label === 'MAIL TRAY' && tray.tier === 'cosmetic', 'the decor tray keeps its id (old saves render) under its own name');
  A.ok(tray && /routes nothing/.test(tray.desc || ''), '…and its card says it is not the workflow INBOX');
  const hits = PropSearch.matchProps(cat, 'inbox').map(c => c.label);
  A.eq(hits.filter(l => l === 'INBOX').length, 1, 'searching "inbox" offers one INBOX (the tray, if listed, reads MAIL TRAY)');
  A.eq(hits[0], 'INBOX', '…and the workflow INBOX ranks first');

  const wf = cat.filter(c => c.cat === 'workflow').map(c => c.id).sort();
  A.eq(wf, ['bay', 'filter', 'intake', 'joiner', 'loop', 'merger', 'outbox', 'splitter'], 'the catalog\'s workflow machines are the eight the shelf lists');
  // every machine on the shelf carries its one-line purpose (PALETTE_PURPOSE, parsed from build.js)
  const pp = build.slice(build.indexOf('const PALETTE_PURPOSE = {'), build.indexOf('};', build.indexOf('const PALETTE_PURPOSE = {')));
  for (const id of wf) A.ok(new RegExp('\\n\\s+' + id + ': \'').test(pp), id + ' has a one-line purpose on the shelf');
  A.ok(/function workflowMachines\(\) \{\s*const all = catalog\(\)\.filter\(c => c && c\.cat === 'workflow'\)/.test(build), 'the shelf is COMPUTED from the catalog (a new workflow machine shows up with no second list)');
  const wfBranch = build.slice(build.indexOf("} else if (tool === 'line' || ((tool === 'select' || tool === 'prop') && buildGroup === 'workflow')) {"), build.indexOf('function updateSafetyClearance'));
  A.ok(wfBranch.length > 200 && /pal\.appendChild\(machinePalette\(\)\)/.test(wfBranch), 'the Conveyors tab renders the MACHINES shelf above the line library');
  A.ok(/\['lines', LINES_LABEL, blueprints\(\)\.length\], \['machines', MACHINES_LABEL, workflowMachines\(\)\.length\]/.test(wfBranch), 'the line library header counts the real catalog (the LINES · MACHINES section keys)');
  A.ok(/\(tool === 'prop' && buildGroup !== 'workflow'\) \|\| \(\(tool === 'select' \|\| tool === 'dupe'\) && buildGroup === 'props'\)/.test(build), 'arming a machine from the Conveyors tab keeps the Conveyors tab up (it does not jump to the Props catalog); a copy held from the Props tab keeps the catalog up (2026-10-01)');
  const mp = build.slice(build.indexOf('function machinePalette()'), build.indexOf('const THUMB_PAD'));
  // THE HAND (2026-10-10): a shelf pick puts the machine IN HAND — the hotbar's own hand, a sub-state of SELECT (never a second placement mode)
  A.ok(/propType = c\.id;\s*setHand\(\{ t: c\.id \}, \{ silent: true \}\);/.test(mp), 'a shelf pick puts that machine in hand (the hotbar’s own hand)');
}

/* ---------- 3. the guide + Field Manual read their names from the UI ---------- */
{
  const guide = build.slice(build.indexOf('function showGuide()'), build.indexOf('function openStepCard'));
  for (const stale of ['WORKSTATIONS &amp; WORKFLOWS', 'LAYOUTS (', '<b>PREVIEW</b>', '<b>Done</b>'])
    A.ok(guide.indexOf(stale) < 0, 'the REFIT guide no longer names "' + stale + '"');
  A.ok(/\$\{G\.lineCount\} ready-made layouts/.test(guide) && /\$\{esc\(G\.preview\)\}/.test(guide) && /\$\{esc\(G\.tab\)\}/.test(guide), 'the guide\'s tab, button and count are interpolated from guideNames()');
  A.ok(/STEP TEST/.test(guide) && /Workflow panel/.test(guide), 'the guide explains testing with the docked Workflow panel\'s STEP TEST');
  const gn = build.slice(build.indexOf('function guideNames()'), build.indexOf('function showGuide()'));
  A.ok(/BUILD_GROUPS\.find\(g => g\[0\] === 'workflow'\)/.test(gn) && /TOOLS\.find/.test(gn) && /blueprints\(\)\.length/.test(gn) && /workflowMachines\(\)/.test(gn), 'guideNames reads BUILD_GROUPS, TOOLS, the blueprint catalog and the machine shelf');
  A.ok(/id="refit-test"[^>]*>\$\{esc\(PREVIEW_LABEL\)\}</.test(build), 'the top-bar preview button is labelled from the same PREVIEW_LABEL the guide quotes');
  A.ok(/refitNames: guideNames/.test(build), 'Build.refitNames exposes the names to the Field Manual');

  // render the Field Manual LINES chapter in a sandbox — once with REFIT's real names, once headless (fallback)
  function renderLines(Build) {
    let html = '';
    const body = { buttons: [], classList: { add() {} }, focus() {},
      querySelectorAll(sel) { return sel === '.fm-tab[data-t]' ? this.buttons : []; }, querySelector() { return null; } };
    Object.defineProperty(body, 'innerHTML', { get() { return html; }, set(h) { html = h;
      body.buttons = Array.from(h.matchAll(/<button\s+([^>]*)>([^<]+)<\/button>/g), m => { const t = (m[1].match(/data-t="([^"]*)"/) || [])[1]; return t ? { dataset: { t }, onclick: null } : null; }).filter(Boolean); } });
    const ctx = { console, setTimeout, clearTimeout, document: { createElement: () => ({ style: {}, classList: { add() {} }, appendChild() {}, setAttribute() {} }), querySelector: () => null, querySelectorAll: () => [], body: {}, addEventListener() {} },
      window: { addEventListener() {} }, localStorage: { getItem() { return null; }, setItem() {} }, globalThis: null };
    if (Build) ctx.Build = Build;
    ctx.globalThis = ctx;
    require('./helpers/frontend-esc.js').installEsc(ctx);
    vm.runInNewContext(tutorialSrc + '\n;globalThis.__tutorial = Tutorial;', ctx);
    ctx.__tutorial.fillFieldManual(body);
    const btn = body.buttons.find(b => b.dataset.t === 'LINES');
    if (btn && typeof btn.onclick === 'function') btn.onclick();
    return html;
  }
  const names = { tab: 'CONVEYORS', lines: 'CONVEYOR LINES', belt: 'BELT', lineKey: '9', beltKey: '7', preview: '▸ PREVIEW FLOW', lineCount: 19, machinesShelf: 'MACHINES',
    machines: [{ id: 'intake', label: 'INBOX', purpose: 'the front door', junction: false }, { id: 'splitter', label: 'SPLITTER', purpose: 'fans out', junction: true },
      { id: 'joiner', label: 'JOINER', purpose: 'waits for every branch', junction: true }, { id: 'loop', label: 'LOOP', purpose: 'sends work round again', junction: true }] };
  const live = renderLines({ refitNames: () => names });
  A.ok(live.length > 200, 'the LINES chapter rendered with REFIT\'s names');
  A.ok(/CONVEYORS › MACHINES/.test(live) && /CONVEYORS › CONVEYOR LINES/.test(live) && /19 ready-made layouts/.test(live), 'LINES names the real tab, shelf, tool and live line count');
  A.ok(/▸ PREVIEW FLOW/.test(live) && /STEP THROUGH/.test(live) && /SEND A REAL JOB/.test(live) && /Workflow panel/.test(live), 'LINES explains the one TEST control and its modes (2026-09-28: WATCH IT · STEP THROUGH · SEND A REAL JOB — org P17)');
  A.ok(/<b>JOINER<\/b>/.test(live) && /<b>LOOP<\/b>/.test(live) && /<b>SPLITTER<\/b>/.test(live), 'BRANCHES lists every junction the shelf offers (JOINER and LOOP included)');
  A.ok(!/<b>INBOX<\/b>:/.test(live), '…and only junctions, not the docks');
  for (const stale of ['PROPS › WORKFLOW', 'for <b>LAYOUTS</b>', 'Use <b>TEST</b>']) A.ok(live.indexOf(stale) < 0, 'LINES no longer says "' + stale + '"');
  const headless = renderLines(null);
  A.ok(/CONVEYORS › MACHINES/.test(headless) && /<b>JOINER<\/b>/.test(headless) && /<b>LOOP<\/b>/.test(headless), 'without REFIT loaded the chapter falls back to the same names');
  A.ok(!/null/.test(headless), 'the headless fallback prints no "null" count');
}

/* ---------- 4. small ones ---------- */
{
  // ESC: the bare select-mode ESC arms, a second one inside the window leaves; any other key disarms
  const between = (a, b) => build.slice(build.indexOf(a), build.indexOf(b, build.indexOf(a)));
  const s = { tool: 'select', buildGroup: 'workflow', drag: null, dragPid: null, connectFrom: null, connectTo: null, dupe: null, selectedPropId: null, movingPropId: null, groupIds: [], selectedRoomId: null, closed: 0, tipped: '',
    hand: null, touchArm: null, dropPick: null, altHeld: false, hoverPropId: null, HOTBAR: [], setHand() {}, toggleHand() {}, flipCorner() {}, pipette() {}, floatHistory() {}, orientEv: () => ({}),   // THE HAND's state (2026-10-10)
    selBelts: null, setSelection() {}, turnClip() {}, cutSelected() {}, holdClip() {}, deleteGroup() {},   // THE HAND part 2 (2026-10-11): the belts a box took, the clip keys
    root: { querySelector: () => null, querySelectorAll: () => [] }, cardTop: () => null, WorkflowPanel: { isOpen: () => false },
    performance: { now: () => s.now }, now: 1000, tipTimer: 0,
    showTip: t => { s.tipped = t; }, hideTip() {}, setTimeout: () => 0, clearTimeout() {}, sfx() {}, selectTool() {}, deselectTool() {}, fitCamera() {},
    station: { undo: () => ({ ok: true }), redo: () => ({ ok: true }) } };
  s.close = () => { s.closed++; };
  vm.createContext(s);
  vm.runInContext(between('  const ESC_EXIT_WINDOW_MS', 'function onKeyUp(ev)'), s);
  const esc = () => s.onKey({ key: 'Escape', target: null });
  esc();
  A.eq(s.closed, 0, 'a bare ESC does NOT leave REFIT');
  A.ok(/PRESS ESC AGAIN TO SAVE & EXIT/.test(s.tipped), '…it says what a second press will do');
  s.now += 800; esc();
  A.eq(s.closed, 1, 'a second ESC inside the window leaves (saving)');
  s.now += 10000; esc(); s.now += 4000; esc();
  A.eq(s.closed, 1, 'two ESCs further apart than the window do not leave');
  s.now += 10000; esc(); s.onKey({ key: 'f', target: null }); s.now += 100; esc();
  A.eq(s.closed, 1, 'any other key between the two ESCs disarms the exit');

  // CLICK TO CONNECT: only the hovered target speaks mid-gesture
  const glow = build.slice(build.indexOf('function drawBeltEndpointGlow('), build.indexOf('function drawAgentTag('));
  // (2026-10-09: a refusal with a caption of its own — a belt into an INBOX — prints that caption instead of NO ROUTE)
  // (2026-10-09: JOIN A LINE arms the DESTINATION — connectTo — and the lane is previewed from the hovered machine into it)
  A.ok(/if \(!isFrom && hoverPropId !== p\.id\) continue;\s*const pv = isFrom \? null : connectTo \? beltPreview\(p\.id, connectTo\) : beltPreview\(connectFrom, p\.id\);\s*const role = isFrom \? \(connectTo \? 'TO ▸ NOW CLICK THE MACHINE THAT HANDS IT WORK' : 'FROM ▸ NOW CLICK A DESTINATION'\) : \(pv && !pv\.ok\) \? \(pv\.short \|\| 'NO ROUTE — ' \+ \(NO_ROUTE\[pv\.error\] \|\| 'NO CLEAR PATH'\)\) : 'CLICK TO CONNECT';/.test(glow), 'mid-connect, CLICK TO CONNECT (or why there is no route) prints on the HOVERED target only (the rest keep the glow)');
  // conveyor links phase B: the hovered destination shows the very lane the click would lay
  A.ok(/if \(pv && pv\.ok\) drawBeltPreview\(t, pv, '#7ee2a8'\);/.test(glow) && /station\.previewBelt\(from, to\)/.test(build), 'mid-connect, the hovered destination draws the lane the click would lay (station.previewBelt)');

  // floor nags are short; the full sentences ride the hover card
  const vl = build.slice(build.indexOf('const VAL_LABEL = {'), build.indexOf('const VAL_WHY = {'));
  const vw = build.slice(build.indexOf('const VAL_WHY = {'), build.indexOf('const valWhy ='));
  const labels = [...vl.matchAll(/([A-Z_]+): '([^']+)'/g)].map(m => [m[1], m[2]]);
  A.ok(labels.length >= 14, 'VAL_LABEL parsed (' + labels.length + ')');
  for (const [code, text] of labels) A.ok(text.length <= 42, code + ' floor label fits a room (' + text.length + ' chars): ' + text);
  A.ok(/BAY_NOT_FED: 'NOT FED — BELT INTO IT'/.test(vl), 'NOT FED is the short form on the floor');
  A.ok(/BAY_NOT_FED: 'Not fed — no belt brings work into this BAY\. Run a belt INTO it/.test(vw) && /THROUGH the junction’s tile, not past its corner/.test(vw), '…the full sentence (junction rule included) lives in VAL_WHY');
  A.ok(/function placedFindingsHTML\(placed\)/.test(build) && /assign \+= placedFindingsHTML\(placed\);/.test(build), 'the hover card carries the full sentence for every finding on that machine');

  // a machine moved away from its belts: the ghost and the drop both say the belts stay
  const cm = build.slice(build.indexOf('function commitPropMove('), build.indexOf('function commitPaint('));
  const mm = build.slice(build.indexOf('  function moveMsg('), build.indexOf('  function ghostInfo('));
  A.ok(/beltsLeftBehind\(mp, mp\.x \+ dx, mp\.y \+ dy\)/.test(cm) && /feedback\(moved, ev, moveMsg\(moved, left, 'relocated'\)\)/.test(cm) && /its belts stayed behind/.test(mm), 'dropping a moved machine away from its belts says they stayed behind (a ring-rule floor)');
  // (wave 2, worldmodel-09: a belt that finds no route now REFUSES the move in its own words — moveProp's LINK_LOST, "Its belt finds no
  //  clear route from there" — so the drop never lands with a belt taken up; test/floor-wave2 drives the refusal for real)
  const wm = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'worldmodel.js'), 'utf8');
  A.ok(/came with it/.test(mm) && /if \(lost && lost\.length\) return Object\.assign\(sendFail\('LINK_LOST', 'Its belt finds no clear route from there/.test(wm) && /linkedFloor\(\)\) return 0;/.test(build), '…and on a linked floor that its belts came with it, or the move is refused because one found no route (conveyor links phase B)');
}

A.report('refit-playtest-fixes.test');
