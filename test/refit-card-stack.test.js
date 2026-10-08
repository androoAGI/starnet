/* test/refit-card-stack.test.js — REFIT's modal-card discipline and session-state hygiene (build.js).

   build.js is a browser IIFE over live DOM/canvas globals (not node-loadable), so — exactly like
   kitout.test.js and textsize-screen-space.test.js — these laws are asserted against the SOURCE. That is
   the right altitude for them: every one is a rule about which code path a card is closed through, and a
   test that stubbed the DOM would prove things about the stub.

   The four laws, each a shipped bug found by the 2026-08-07 conveyor audit:

   1. ESC CLOSES A CARD THROUGH THE CARD'S OWN CLOSE PATH. `.refit-guide` is shared by EIGHT cards (the
      first-run guide, the step editor, the workstation picker, the flow / belt / junction / connector /
      room / door cards). ESC matched that shared class, then called markSeen() + removeChild() itself —
      so ESC over a step card discarded an unsaved job brief AND permanently marked the build-mode guide
      seen. Only the first-run card may mark itself seen, and it does that from its OWN registered path.
   2. AN OPENER REPLACES, NEVER NO-OPS. Every opener bailed out when its own class was already mounted;
      finFocusCrew (FINISH ① CREW) and Build.openAssign (the live world's NO AGENT nag) route through
      them, so clicking either did NOTHING while another dock's card was open.
   3. A MOUNTED CARD OWNS THE KEYBOARD. With the step card open, `9` armed LINES and yanked the camera
      out from under it; Ctrl+Z undid the stamp that created the bay being edited.
   4. EVERY DRAG EXIT RELEASES THE POINTER CAPTURE. Only onUp did — ESC, right-click, pointercancel and
      window blur dropped the drag and left the canvas captured, which kills hover/pointerleave until the
      next click. And blur cancelled PAN only, so alt-tabbing mid draw/belt/paint left a frozen ghost. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = f => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', f), 'utf8');
const build = src('build.js');
const panel = src('workflowpanel.js');   // the docked Workflow panel (2026-09-22) — the step/flow cards' saves live here now
/* The "must NOT appear" assertions below run against a COMMENT-STRIPPED slice: this file documents the
   bugs it prevents, and a comment naming markSeen()/removeChild() is not a call to them. */
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*/g, ' ');

/* ---------- 1. the card stack exists and ESC goes through it ---------- */
A.ok(/function cardRegister\(/.test(build), 'a card registers its own close path (cardRegister)');
A.ok(/function cardTop\(/.test(build), 'the stack can name its TOPMOST card (cardTop)');
A.ok(/function cardClose\(/.test(build), 'and close one through that registered path (cardClose)');
A.ok(/function cardCloseAll\(/.test(build), 'and close every card an opener is replacing (cardCloseAll)');

// the ESC branch: it must close the topmost card, and must NOT mark-seen or removeChild by hand
const escBlock = build.slice(build.indexOf("if (ev.key === 'Escape') {"), build.indexOf("if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'z'"));
const escCode = strip(escBlock);
A.ok(escBlock.length > 100 && escBlock.length < 3000, 'the ESC branch was located');
A.ok(/cardClose\(modal\)/.test(escCode), 'ESC closes the topmost card through its own close path');
A.ok(!/markSeen\(\)/.test(escCode), 'ESC never marks the first-run guide seen itself — only that card does');
A.ok(!/removeChild/.test(escCode), 'ESC never tears a card out of the DOM behind its back');
A.ok(!/querySelector\('\.refit-guide'\)/.test(escCode), "ESC no longer gates on the class EIGHT cards share");

// the first-run card — and ONLY it — registers a close path that marks the guide seen
const guideBlock = build.slice(build.indexOf('function showGuide()'), build.indexOf('function openStepCard'));
A.ok(/const dismiss = \(\) => \{ markSeen\(\);/.test(guideBlock), 'the first-run card still marks itself seen when dismissed');
A.ok(/cardRegister\(g, dismiss\)/.test(guideBlock), '…and registers THAT as its close path, so ESC on it does the same thing');

/* ---------- 2. the cards that SAVE something close through the save ---------- */
/* THE STEP + FLOW CARDS BECAME THE DOCKED WORKFLOW PANEL (2026-09-22). The saves they were held to moved
   with them: the panel's ONE close path saves every open field (brief + hand-off, line name, LINE BUDGET,
   gate config) — and every way out (✕, ✓ DONE, ESC, REFIT close) goes through it. */
const stepBlock = build.slice(build.indexOf('function openStepCard'), build.indexOf('function openWorkflowPanel'));
A.ok(/cardCloseAll\(\)/.test(stepBlock), 'opening the step card REPLACES whatever card was up (FINISH ① CREW / the world nag)');
A.ok(/openWorkflowPanel\(bayId\)/.test(stepBlock), '…and opens the docked panel on that BAY (never silently no-ops)');
const flowBlock = build.slice(build.indexOf('function openFlowCard'), build.indexOf('function openBeltCard'));
A.ok(/openWorkflowPanel\(propId\)/.test(flowBlock), 'the INBOX / gate door opens the same panel');
const pClose = panel.slice(panel.indexOf('  function close() {'), panel.indexOf('  const isOpen'));
A.ok(/saveOpenFields\(\);/.test(pClose), "the panel's close path saves its open fields first");
const pSave = panel.slice(panel.indexOf('  function saveOpenFields() {'), panel.indexOf('/* ===== BAY'));
for (const k of ['_saveName', '_saveBay', '_saveLimits', '_saveGate']) A.ok(pSave.indexOf(k) > 0, 'saveOpenFields saves ' + k);
A.ok(/WorkflowPanel\.isOpen\(\)\) \{ WorkflowPanel\.close\(\); return; \}/.test(build), 'ESC closes the docked panel THROUGH its close path (saving) before it leaves REFIT');
A.ok(/if \(typeof WorkflowPanel !== 'undefined' && WorkflowPanel\.isOpen\(\)\) WorkflowPanel\.close\(\);/.test(build.slice(build.indexOf('  function close() {'), build.indexOf('  const toggle'))), 'closing REFIT closes the panel through its save path while the station is still ours');

// the ROOM card docks above the library now (2026-10-01 build-mode upgrade, phase 2): its rename saves on Enter or on leaving the field
const roomBlock = build.slice(build.indexOf('function renderRoomCard'), build.indexOf('function renderGroupCard'));
A.ok(/nameEl\.onblur = saveName;/.test(roomBlock), "the room card saves the rename when the field is left");
A.ok(/if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); nameEl\.blur\(\); \}/.test(roomBlock), '…and on Enter');

// EVERY card opener replaces rather than bailing out
for (const fn of ['openStepCard', 'openWorkstationPicker', 'openFlowCard', 'openBeltCard',
                  'openJunctionEditor', 'openConnectorEditor', 'openRoomCard', 'openDoorPicker']) {
  const i = build.indexOf('function ' + fn + '(');
  A.ok(i > 0, fn + ' is still a card opener');
  A.ok(build.slice(i, i + 700).indexOf('cardCloseAll()') > 0, fn + ' replaces the open card instead of no-opping');
}
// …and every card registers SOME close path (7 cards; a new one that forgets is the bug this counts)
A.ok((build.match(/cardRegister\(g, /g) || []).length >= 7,
  'every mounted card registers its close path (first-run + the modal editors; the step/flow cards are the docked panel now; the desk picker is the selection card since 2026-10-07)');

/* ---------- 3. a mounted card owns the keyboard ---------- */
const keyBlock = build.slice(build.indexOf('function onKey(ev)'), build.indexOf('function onKeyUp(ev)'));
A.ok(/const modal = cardTop\(\);/.test(keyBlock), 'onKey asks whether a card is mounted');
A.ok(/if \(modal && ev\.key !== 'Escape'\) return;/.test(keyBlock), 'and every key but ESC is refused while one is');
A.ok(/&& \(!modal \|\| ev\.key !== 'Escape'\)\) return;/.test(keyBlock),
  'an input keeps ordinary editing keys but lets ESC reach the mounted card close/save path');
// the guard must come BEFORE the tool digits and the undo binding, or it guards nothing
A.ok(keyBlock.indexOf('const modal = cardTop()') < keyBlock.indexOf("a.tagName === 'INPUT'"),
  'the mounted card is known before the input guard decides whether ESC may cross it');
A.ok(keyBlock.indexOf('const modal = cardTop()') < keyBlock.indexOf("'9': 'line'"), 'the guard precedes the tool shortcuts');
A.ok(keyBlock.indexOf('const modal = cardTop()') < keyBlock.indexOf("ev.key === 'z'"), 'the guard precedes undo/redo');

/* ---------- 4. drag hygiene: every exit releases the captured pointer ---------- */
A.ok(/function releaseDrag\(\)/.test(build), 'there is ONE way to drop a drag (releaseDrag)');
A.ok(/releasePointerCapture\(dragPid\)/.test(build), '…and it releases the pointer the canvas captured');
A.ok(/setPointerCapture\(ev\.pointerId\); dragPid = ev\.pointerId;/.test(build), 'onDown remembers which pointer it captured');
A.ok(/function onCancel\(\) \{[^}]*releaseDrag\(\)/.test(build), 'pointercancel releases the capture');
const blur = build.slice(build.indexOf('function onBlur()'), build.indexOf('function onBlur()') + 200);
A.ok(/releaseDrag\(\)/.test(blur), 'window blur releases the capture');
A.ok(!/drag\.mode === 'pan'/.test(blur), 'and blur cancels EVERY drag, not just a pan (no frozen ghost after alt-tab)');
A.ok(/if \(drag \|\| connectFrom \|\| dupe\) \{ selectTool\('select'\); return; \}/.test(escCode)
  && /if \(drag \|\| dragPid != null\) releaseDrag\(\)/.test(build), 'ESC cancels the gesture and tool through the capture-release path');

/* ---------- 5. completed Build actions leave truthful controls and status ---------- */
// STARTER GEAR (2026-08-18, Andrew — replaced STATION ORDERS): the card's rows come from the ONE
// catalog list, and done is read by GRANT off the live doc (a VAULT ticks the INTEL CAB row).
const ordersBlock = build.slice(build.indexOf('function ordersSteps()'), build.indexOf('function renderOrders()'));
A.ok(/PropSprites\.STARTER/.test(ordersBlock), 'STARTER GEAR reads PropSprites.STARTER (no second list)');
A.ok(/grantLabelOf/.test(ordersBlock), '…and done keys on the GRANT, not the prop id');
const renderOrdersBlock = build.slice(build.indexOf('function renderOrders()'), build.indexOf('function renderFinCard()'));
A.ok(/done === steps\.length\) return ordersHide\(\)/.test(renderOrdersBlock),
  'the card retires on its own at all-powers-placed');
A.ok(!/setItem\(ORDERS_KEY\(\), '1'\); \}[\s\S]*?done === steps\.length/.test(renderOrdersBlock)
  && renderOrdersBlock.indexOf('done === steps.length') < renderOrdersBlock.indexOf('setItem(ORDERS_KEY()'),
  '…WITHOUT burning the dismiss key (reclaiming a power must re-summon the card)');

const commitDrawBlock = build.slice(build.indexOf('function commitDraw('), build.indexOf('function commitMove('));
A.ok(/if \(res && res\.ok\) \{[\s\S]*rememberDrawn\(rect\);[\s\S]*deselectTool\(\{ silent: true \}\);[\s\S]*\}/.test(commitDrawBlock),
  'a successful room or hallway placement disarms the tool before its remembered footprint can self-overlap');
A.ok(commitDrawBlock.indexOf('deselectTool({ silent: true })') < commitDrawBlock.indexOf('feedback(res'),
  'the post-placement hover is neutral before feedback returns control to the pointer');
A.ok(/const isHall = tool === 'hall'/.test(commitDrawBlock) && /feedback\(res, ev, isHall \?/.test(commitDrawBlock),
  'the feedback label reads the tool captured BEFORE deselect — a hallway commit must never flash "room placed"');

/* ---------- 6. per-station latches + session-state hygiene ---------- */
A.ok(/const ORDERS_KEY = \(\) => 'starnet\.refit\.orders\.dis\.' \+ stationKeyOf\(station\)/.test(build),
  'the ORDERS dismissal is namespaced per station (it shipped global, with no suffix at all)');
A.ok(/localStorage\.setItem\(ORDERS_KEY\(\), '1'\)/.test(build), '…and the writer uses the same per-station key');
A.ok(/'starnet\.refit\.firstride\.' \+ stationKeyOf\(station\)/.test(build), 'the first ride is per station');
A.ok(/'starnet\.refit\.finline\.' \+ stationKeyOf\(st \|\| station\)/.test(build), 'the finish-the-line registry is per station');

const openBlock = build.slice(build.indexOf('function open() {'), build.indexOf('function open() {') + 2500);
A.ok(/for \(const k in layerFailed\) delete layerFailed\[k\];/.test(openBlock),
  'renderDegraded is cleared per session — a transient throw must not claim degradation forever (truthful telemetry)');
A.ok(/propCardKey = null;/.test(openBlock), 'the hover-card key is cleared (a stale key painted an EMPTY card)');
A.ok(/ordersSeenDone = null;/.test(openBlock), 'the ORDERS completion set is cleared (no chime for steps finished while REFIT was shut)');
A.ok(/propQuery = '';/.test(openBlock), 'the palette search is cleared (no invisible filter on reopen)');
A.ok(/dragPid = null;/.test(openBlock), 'and no captured pointer is inherited from a prior session');

/* ---------- 7. the spawn-lock badge is arbitrated and font-free ---------- */
A.ok(!/fillText\('⌂'/.test(build), "the '⌂' glyph is gone — it is not in VT323 and rendered at fallback-font metrics");
const lockBlock = build.slice(build.indexOf('if (protectedSpawn) {'), build.indexOf('if (protectedSpawn) {') + 1200);
A.ok(/voiceSay\('hover'/.test(lockBlock), 'the lock badge speaks through the one-voice arbiter, not a bare fillText');

/* ---------- 8. delivery bookkeeping resolves against the LIVE station ---------- */
const noteBlock = build.slice(build.indexOf('function noteLineDelivered'), build.indexOf('function noteLineDelivered') + 900);
A.ok(/opts\.getStation\(\)[\s\S]*const st = live \|\| station;/.test(noteBlock),
  'noteLineDelivered prefers the live station over the module-level one close() never nulls');

A.report('refit-card-stack');
