'use strict';

/* station-tooltip.test.js — the OS never paints StarNet's UI.
 *
 * Companion to control-floor-theming.test.js. That one keeps the browser from painting our CONTROLS;
 * this one keeps it from painting our DIALOGS and our TOOLTIPS — the other two surfaces the user agent
 * will happily draw in system chrome if nobody stops it:
 *   1. window.confirm/alert/prompt — an OS modal over the phosphor terminal (armconfirm.js exists
 *      precisely so no call site needs one).
 *   2. title="…" — the native hover bubble, grey and in the system font, on the OS's own timer.
 *      tooltip.js adopts every [title] into [data-tip] and draws the station's own card instead.
 */

const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
// Strip block comments AND trailing line comments — this file's own prose says "prompt (persona…"
// and "system prompt (…", which a naive scan reads as a call. The `[^:]` guard keeps `https://` intact.
const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

// ---- 1. no native dialog anywhere in the shipped frontend ---------------------------------
const jsFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir + '/' + entry.name;
    if (entry.isDirectory()) walk(rel);
    else if (entry.name.endsWith('.js')) jsFiles.push(rel);
  }
})('frontend/app');

for (const rel of jsFiles) {
  const code = stripComments(read(rel));
  // window.alert(...) / window.confirm(...) / window.prompt(...) — the qualified form
  A.ok(!/window\s*\.\s*(alert|confirm|prompt)\s*\(/.test(code),
    rel + ' calls no native window dialog (use ArmConfirm / a station panel instead)');
  // the bare form, but NOT `Foo.confirm(` / `function confirm(` — the app has its own confirm() APIs
  A.ok(!/(?:^|[;{}()\s])(?:alert|prompt)\s*\(/m.test(code.replace(/\.\s*(alert|prompt)\s*\(/g, '.X(')),
    rel + ' calls no bare alert()/prompt()');
}

// the discard flow specifically — this is the one that regressed into window.confirm
const deliverables = read('frontend/app/deliverables.js');
A.ok(/ArmConfirm\.wire\(/.test(deliverables), 'the DELIVERABLES discard arms through ArmConfirm');
A.ok(/armedLabel:/.test(deliverables), 'the armed discard label admits what is about to happen');
A.ok(/permanently/i.test(deliverables), 'the permanence warning the native dialog used to carry still exists');

// ---- 2. every control the app renders carries a surface class ------------------------------
// A class-less <button> is not a paint bug any more (the CONTROL FLOOR catches it) but it still
// ships without station chrome — cramped, UA-sized, square. These three were the last of them.
for (const rel of ['frontend/app/deliverables.js', 'frontend/app/stationui.js']) {
  const code = read(rel);
  for (const id of ['dl-clean-apply', 'dl-undo', 'ag-ws-now']) {
    const m = new RegExp('<button[^>]*id="' + id + '"').exec(code);
    if (!m) continue;
    const tag = code.slice(m.index, code.indexOf('>', m.index) + 1);
    A.ok(/class="[^"]*\bbb\b/.test(tag), id + ' renders as a station button (class="bb …"), not a bare <button>');
  }
}

// ---- 3. the tooltip controller is shipped, wired, and adopts every title -------------------
const tooltip = read('frontend/app/tooltip.js');
const indexHtml = read('frontend/index.html');
const stationUi = read('frontend/app/stationui.js');
A.ok(/<script src="app\/tooltip\.js">/.test(indexHtml), 'tooltip.js is loaded by index.html');
A.ok(/removeAttribute\('title'\)/.test(tooltip), 'the controller REMOVES title — that is what silences the OS bubble');
A.ok(/data-tip/.test(tooltip), 'the adopted text lives on data-tip');
A.ok(/data-no-tip/.test(tooltip), 'an element that owns a richer tip can opt out');
A.ok(/aria-describedby/.test(tooltip), 'the live card is announced as the description');
// the uiZoom law: a body-child fixed card MUST divide rects by the zoom factor
A.ok(/style\.zoom/.test(tooltip) && /\/\s*z\b/.test(tooltip),
  'tooltip.js honours the uiZoom law (rects are visual px, body-child style px are zoomed)');
A.ok(/\.station-tip\s*\{/.test(read('frontend/css/app.css')), 'the station tooltip card is styled');

// the ONE element allowed to keep a native title would still let the OS paint — so none may.
const titlesInHtml = (indexHtml.match(/\stitle="/g) || []).length;
A.ok(!/id="model-dock-toggle"[^>]*\stitle="/.test(indexHtml),
  'the model dock keeps no native title (it owns .model-dock-tip and opted out)');

// A repeating renderer must never write `title` back after Tooltip.adopt() removes it. The context
// gauge repaints every second, so a `g.title = ...` assignment recreates the OS bubble while the pointer
// is already resting on the gauge (there is no second pointerover for Tooltip to adopt it again).
const ctxStart = stationUi.indexOf('  function ctxTick() {');
const ctxEnd = stationUi.indexOf('\n  let compactWired', ctxStart);
A.ok(ctxStart >= 0 && ctxEnd > ctxStart, 'the context gauge ticker remains locatable');
const ctxTick = stationUi.slice(ctxStart, ctxEnd);
A.ok(!/\bg\.title\s*=/.test(ctxTick), 'the repeating context ticker never recreates a native title');
A.ok(/setAttribute\(['"]data-tip['"]/.test(ctxTick), 'the repeating context ticker updates the station tooltip source');
A.ok(/id="ctx-gauge"[^>]*\sdata-tip="/.test(indexHtml), 'the context gauge starts with a station tooltip, not an OS title');

// ---- 4. the pure geometry, exercised ------------------------------------------------------
const T = require('../frontend/app/tooltip.js');
const vp = { width: 1000, height: 800 }, tip = { width: 200, height: 40 };
const above = T.place({ left: 400, top: 300, width: 100, height: 20 }, tip, vp);
A.eq(above.below, false, 'a tip with room above renders above its anchor');
A.eq(above.left + tip.width / 2, 450, 'and is centred on the anchor');
const flipped = T.place({ left: 400, top: 10, width: 100, height: 20 }, tip, vp);
A.eq(flipped.below, true, 'a tip with no room above flips below');
const clampedL = T.place({ left: 0, top: 300, width: 20, height: 20 }, tip, vp);
A.ok(clampedL.left >= 0, 'a tip at the left edge stays on screen');
const clampedR = T.place({ left: 980, top: 300, width: 20, height: 20 }, tip, vp);
A.ok(clampedR.left + tip.width <= vp.width, 'a tip at the right edge stays on screen');
A.ok(clampedR.arrowX <= tip.width - 10 && clampedR.arrowX >= 10,
  'the arrow stays inside the card after clamping (it must keep pointing at the anchor, not off the corner)');
A.ok(T.adopt(null) === '', 'adopt() tolerates a null element');

/* ---- 5. the DELAY/CANCEL path: no ghost card beside a control the pointer already left ------------
   `anchor` is only assigned inside show(), so for the whole 320ms pending window the pointerout handler's
   opening `if (!anchor) return` bailed BEFORE hide() — and hide() holds the only clearTimeout. Brush a tipped
   control and flick away and the card still appeared ~200ms later next to a control you had left, then stayed
   until the next element boundary / click / scroll / keypress. This drives init()'s real pointer handlers,
   which no test did before, so the delay/cancel path was entirely uncovered. */
{
  const listeners = new Map();
  function mkEl(attrs, text) {
    const a = Object.assign({}, attrs || {});
    const el = {
      isConnected: true, style: { setProperty() {}, removeProperty() {} }, textContent: text || '', hidden: false,
      classList: (() => { const s = new Set(); return { add: c => s.add(c), remove: c => s.delete(c), toggle: (c, on) => { if (on === undefined) { s.has(c) ? s.delete(c) : s.add(c); } else { on ? s.add(c) : s.delete(c); } }, contains: c => s.has(c) }; })(),
      getAttribute: k => (k in a ? a[k] : null),
      setAttribute: (k, v) => { a[k] = String(v); },
      removeAttribute: k => { delete a[k]; },
      hasAttribute: k => k in a,
      getBoundingClientRect: () => ({ left: 100, top: 100, width: 40, height: 20 }),
      appendChild() {}, contains(other) { return other === el; }, closest(sel) { if (sel === '#bottombar') return a.dock ? el : null; return (/\[title\]|\[data-tip\]/.test(sel) && ('title' in a || 'data-tip' in a)) ? el : null; },
      _attrs: a
    };
    return el;
  }
  const body = mkEl({}, '');
  let card;
  const doc = {
    body,
    createElement: () => (card = mkEl({}, '')),
    addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); }
  };
  const fire = (name, ev) => (listeners.get(name) || []).forEach(fn => fn(ev));

  const T2 = require('../frontend/app/tooltip.js');
  T2.init._wired = false;                       // init() is once-only by design; this is a fresh rig
  global.window = { innerWidth: 1000, innerHeight: 700, addEventListener() {} };
  T2.init(doc);
  const tipped = mkEl({ title: 'Halt every run' }, '');
  const plain = mkEl({}, 'not tipped');

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  (async () => {
    // brush it, then flick away well inside the 320ms delay
    fire('pointerover', { target: tipped });
    await sleep(80);
    fire('pointerout', { target: tipped, relatedTarget: body });
    await sleep(400);                            // past SHOW_DELAY — the ghost used to appear here
    A.ok(!tipped.getAttribute('aria-describedby'),
      'a tip cancelled DURING the show delay never appears (no aria-describedby stamped on the control you left)');

    // and moving onto UNTIPPED background is the same cancel (enter() returns early there, so hide() is the
    // only thing that could have cleared the timer)
    fire('pointerover', { target: tipped });
    await sleep(80);
    fire('pointerout', { target: tipped, relatedTarget: plain });
    fire('pointerover', { target: plain });
    await sleep(400);
    A.ok(!tipped.getAttribute('aria-describedby'), 'flicking onto untipped background also cancels the pending tip');

    // the HAPPY path still works: rest on it past the delay and the tip shows
    fire('pointerover', { target: tipped });
    await sleep(420);
    A.eq(tipped.getAttribute('aria-describedby'), 'station-tip', 'resting on a tipped control past the delay DOES show the tip');
    // ...and leaving now hides it
    fire('pointerout', { target: tipped, relatedTarget: body });
    A.ok(!tipped.getAttribute('aria-describedby'), 'leaving a SHOWN tip still hides it');

    const dock = mkEl({ title: 'Crew', dock: true }, 'Crew');
    fire('focusin', { target: dock });
    A.ok(card.classList.contains('dock-tip'), 'a bottom-bar hover card keeps the approved dock finish');
    fire('focusin', { target: tipped });
    A.ok(!card.classList.contains('dock-tip'), 'reusing the card outside the dock clears the dock finish');

    /* ---- 6. focus from a CLICK is not a glance (touchscreen-laptop dock bug) ------------------------
       A mouse click focuses the button, and focusin showed the card at once — over the dock menu the click
       had just opened. Only keyboard focus (:focus-visible) shows it now; an engine without matches() keeps
       the old behaviour. And no card ever opens over an open dock menu (aria-expanded), even on hover. */
    fire('pointerdown', {});
    const mouseFocus = mkEl({ title: 'Your agents' }, ''); mouseFocus.matches = () => false;
    fire('focusin', { target: mouseFocus });
    A.ok(!mouseFocus.getAttribute('aria-describedby'), 'focus from a mouse click (not :focus-visible) never pops the card');
    const keyFocus = mkEl({ title: 'Your agents' }, ''); keyFocus.matches = q => q === ':focus-visible';
    fire('focusin', { target: keyFocus });
    A.eq(keyFocus.getAttribute('aria-describedby'), 'station-tip', 'keyboard focus (:focus-visible) still shows the card at once');
    fire('pointerdown', {});
    const oddEngine = mkEl({ title: 'Your agents' }, ''); oddEngine.matches = () => { throw new Error('unsupported selector'); };
    fire('focusin', { target: oddEngine });
    A.eq(oddEngine.getAttribute('aria-describedby'), 'station-tip', 'a matches() that throws falls back to showing on focus');
    fire('pointerdown', {});
    const openDock = mkEl({ title: 'Shape the station', 'aria-expanded': 'true' }, 'BUILD');
    fire('pointerover', { target: openDock });
    await sleep(420);
    A.ok(!openDock.getAttribute('aria-describedby'), 'no card opens over an open dock menu (aria-expanded="true"), even on hover');
    A.ok(!openDock.hasAttribute('title'), 'its title is still adopted, so the OS bubble stays silenced');

    A.report('station-tooltip.test');
  })().catch(e => { console.log('FAIL: tooltip rig threw — ' + (e && e.stack || e)); process.exit(1); });
}
