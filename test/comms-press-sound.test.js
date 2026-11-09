/* test/comms-press-sound.test.js — COMMS sounds like the bottom docks (Andrew 2026-10-13).

   Andrew: the COMMS keys' bright Click_02 tick was annoying, COMMS must make the same sound as the bottom
   CREW/WORK/BUILD/SYSTEM docks, and the model selector rang a bell on top of his own pick. This pins the three
   pieces that deliver that, executed (not grepped):
     A. SFX.press() IS the docks' open() cue (Data_Point_04 at full pitch), sharing its gate, and close() is the
        same sample pitched down.
     B. The delegated UI layer (audio.js wireUI) plays press() for a control inside #chat-panel, click() outside
        it, and yields to an explicit cue that just sounded.
     C. The model/effort receipt toast is silent for the user's own dock pick and keeps its bell for a
        catalog-driven change.
     D. The COMMS speaker key (voice.js) and the browser globe (outputbrowser.js) use the same cue, once.
   Node-only: no browser, no sidecar. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const A = require('./_assert.js');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function loadSfx(now) {
  const util = read('frontend/js/util.js');
  const start = util.indexOf('const SFX = {');
  const end = util.indexOf('\n};', start);
  A.ok(start >= 0 && end > start, 'the production SFX object is found in util.js');
  const ctx = vm.createContext({ Date: { now: () => now.t }, console });
  vm.runInContext(util.slice(start, end + 3) + '\nthis.SFX = SFX;', ctx);
  const played = [];
  ctx.SFX._sample = (name, o) => { played.push(name + '@' + ((o && o.rate) || 1)); return true; };
  return { SFX: ctx.SFX, played };
}

// ---- A. press() is open(), gate included; close() is the same sample pitched down ----
{
  const now = { t: 10000 };
  const { SFX, played } = loadSfx(now);
  SFX.press();
  A.eq(played, ['open@1'], 'press plays the docks’ open sample at full pitch');
  now.t += 30; SFX.open();
  A.eq(played, ['open@1'], 'a window rising in the same moment as the press does not play the sample a second time');
  now.t += 100; SFX.press();
  A.eq(played, ['open@1', 'open@1'], 'a later press sounds again');
  now.t += 200; SFX.close();
  A.eq(played.slice(-1), ['open@0.85'], 'close is the same sample pitched down (direction reads)');
  now.t += 200; SFX.click();
  A.ok(played.length === 4 && /^click@/.test(played[3]), 'click() is still the Click_02 tick for the rest of the station');
}

// ---- B. the delegated layer: press inside #chat-panel, click outside, yield to an explicit cue ----
{
  const handlers = {};
  const calls = [];
  const SFX = { _lastAny: 0, press: () => calls.push('press'), click: () => calls.push('click'), toggle: () => calls.push('toggle'), slidertick: () => calls.push('slider') };
  const now = { t: 50000 };
  const ctx = vm.createContext({
    SFX, Date: { now: () => now.t }, console,
    document: { addEventListener: (type, fn) => { handlers[type] = fn; } },
    window: { addEventListener: () => {}, removeEventListener: () => {} }
  });
  vm.runInContext(read('frontend/js/audio.js'), ctx);
  A.ok(typeof handlers.click === 'function' && typeof handlers.change === 'function', 'wireUI listens for click and change on the document');
  const panel = { id: 'chat-panel' }, body = { id: '' };
  const control = { disabled: false, closest: () => control, matches: sel => /select/.test(sel) && control.isSelect };
  const click = (pathNodes, extra) => Object.assign({ button: 0, target: control, composedPath: () => pathNodes }, extra || {});
  handlers.click(click([control, { id: 'chat-inputrow' }, panel, body]));
  A.eq(calls, ['press'], 'a COMMS key plays press()');
  now.t += 200; calls.length = 0;
  handlers.click(click([control, { id: 'terms' }, body]));
  A.eq(calls, ['click'], 'a control outside COMMS keeps click()');
  now.t += 200; calls.length = 0;
  // a model row / effort key re-renders (detaches) the pressed node before the click bubbles: the snapshotted path
  // still holds the panel
  const detached = { disabled: false, closest: () => detached };
  handlers.click({ button: 0, target: detached, composedPath: () => [detached, { id: 'model-dock-list' }, { id: 'model-dock' }, panel, body] });
  A.eq(calls, ['press'], 'a model-selector row that re-rendered itself still sounds like COMMS');
  now.t += 200; calls.length = 0;
  SFX._lastAny = now.t - 20;
  handlers.click(click([control, panel, body]));
  A.eq(calls, [], 'an explicit cue that just sounded wins: the delegate yields');
  now.t += 200; calls.length = 0;
  control.isSelect = true;
  handlers.change({ target: control, composedPath: () => [control, { id: 'comms-idbar' }, panel, body] });
  A.eq(calls, ['press'], 'the COMMS agent select sounds like COMMS');
  now.t += 200; calls.length = 0;
  handlers.change({ target: control, composedPath: () => [control, body] });
  A.eq(calls, ['click'], 'a select elsewhere keeps click()');
  control.isSelect = false;
  now.t += 200; calls.length = 0;
  handlers.click(click([control, panel, body], { button: 2 }));
  A.eq(calls, [], 'a non-primary button is ignored');
}

// ---- C. the model/effort receipt is silent for the user's own pick, keeps its bell otherwise ----
{
  const app = read('frontend/app/app.js');
  const start = app.indexOf('  function applyQuickModel(sel) {');
  const end = app.indexOf('\n  // the persisted shape of a crew member', start);
  A.ok(start >= 0 && end > start, 'applyQuickModel is found in app.js');
  const notes = [];
  const ctx = vm.createContext({
    agent: { id: 'agent', model: 'm0', provider: 'openrouter' },
    agents: new Map(),
    el: () => null,
    Harness: { getModel: () => 'm0', getProv: () => 'openrouter', setProv() {}, setModel() {}, setReasoningEffort() {}, normalizeReasoningEffort: e => e || 'medium' },
    normalizeProviderId: p => p, syncChannels() {}, pushRoster() {}, persist() {}, noteWirePin() {}, noteEffortSource() {},
    providerLabel: p => p.toUpperCase(), shortModelLabel: m => m, effortLabel: e => String(e).toUpperCase(),
    StationUI: { notify: (msg, cls, category, opts) => notes.push({ msg, opts: opts || null }) }
  });
  vm.runInContext(app.slice(start, end) + '\nthis.applyQuickModel = applyQuickModel;', ctx);
  for (const [reason, silent] of [['model', true], ['effort', true], ['catalog_reconcile', false], ['catalog_unavailable', false]]) {
    notes.length = 0;
    ctx.applyQuickModel({ model: 'm1', provider: 'openrouter', effort: 'medium', reason, previousModel: 'm0' });
    A.eq(notes.length, 1, 'one receipt toast for reason ' + reason);
    A.eq(!!(notes[0] && notes[0].opts && notes[0].opts.silent), silent, (silent ? 'the user’s own ' + reason + ' pick is a silent receipt' : 'a ' + reason + ' change keeps its bell'));
  }
  const st = read('frontend/app/stationui.js');
  A.ok(/toast\(String\(text \|\| ''\), cls \|\| '', \(opts && opts\.silent\) \? false : pref\.sound, tOpts\)/.test(st), 'StationUI.notify honours silent by toasting without the sound');
}

// ---- D. the speaker key and the browser globe: the COMMS cue, once ----
{
  const voice = read('frontend/app/voice.js');
  const fn = voice.slice(voice.indexOf('  function toggleSpeakReplies() {'), voice.indexOf('  function setSpeakReplies('));
  A.ok(fn.length > 0 && /\(SFX\.press \|\| SFX\.click\)\(\)/.test(fn) && !/SFX\.click\(\)/.test(fn), 'the COMMS speaker key plays press(), not the Click_02 tick');
  const ob = read('frontend/app/outputbrowser.js');
  const quiet = ob.slice(ob.indexOf('  function quietDoorEcho() {'), ob.indexOf('  function restoreIfMinimized()'));
  A.ok(quiet.length > 0, 'outputbrowser has the door-echo guard');
  // execute the guard: a rise within a second of a press that really sounded open() is re-gated; otherwise untouched
  if (quiet.length > 0) {
  const now = { t: 70000 };
  const SFX = { _lastAt: {} };
  const state = { doorPressedAt: 0 };
  const ctx = vm.createContext({ SFX, state, Date: { now: () => now.t } });
  vm.runInContext(quiet + '\nthis.quietDoorEcho = quietDoorEcho;', ctx);
  state.doorPressedAt = now.t; SFX._lastAt.open = now.t; now.t += 95;
  ctx.quietDoorEcho();
  A.eq([SFX._lastAt.open, state.doorPressedAt], [now.t, 0], 'the globe window rising 95 ms after its press is gated (the press stays the only cue)');
  state.doorPressedAt = now.t; SFX._lastAt.open = now.t - 500; const before = SFX._lastAt.open; now.t += 95;
  ctx.quietDoorEcho();
  A.eq(SFX._lastAt.open, before, 'a press that did not sound open() leaves the window’s own cue alone (never silent)');
  state.doorPressedAt = now.t; SFX._lastAt.open = now.t; const late = SFX._lastAt.open; now.t += 1500;
  ctx.quietDoorEcho();
  A.eq(SFX._lastAt.open, late, 'a window that rises long after the press is its own event and sounds');
  }
  A.ok(/state\.doorPressedAt = Date\.now\(\)/.test(ob) && /openBrowserTerm\(\)/.test(ob), 'the globe stamps its press and every browser-window rise goes through the guard');
}

A.report('comms-press-sound.test');
