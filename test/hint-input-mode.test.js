/* node test/hint-input-mode.test.js — hint.js decides mouse/pen vs touch per EVENT, not per device.
   A touchscreen laptop driven by a mouse reports maxTouchPoints > 0, and the old device gate wired it as a
   phone: a mouse click on a dock button pinned the glossary bubble (no leave, no Escape), and the help cursor
   only appeared after the first bubble. This drives the real module's handlers on a fake DOM. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

const docL = new Map(), winL = new Map();
const on = m => (name, fn) => { if (!m.has(name)) m.set(name, []); m.get(name).push(fn); };
const fire = (m, name, ev) => (m.get(name) || []).forEach(fn => fn(ev));
const styles = [];
let bubble = null;

function mkEl(attrs, parent) {
  const a = Object.assign({}, attrs || {});
  const s = new Set();
  const el = {
    parent: parent || null, style: {}, offsetWidth: 120, offsetHeight: 30, textContent: '', fv: false,
    classList: { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c),
      toggle: (c, v) => { if (v === undefined ? !s.has(c) : v) s.add(c); else s.delete(c); } },
    getAttribute: k => (k in a ? a[k] : null),
    setAttribute: (k, v) => { a[k] = String(v); },
    getBoundingClientRect: () => ({ left: 300, top: 700, bottom: 730, width: 90 }),
    closest(sel) {
      if (sel !== '[data-hint]') return null;
      for (let n = el; n; n = n.parent) if (n.getAttribute('data-hint') != null) return n;
      return null;
    },
    contains(n) { for (; n; n = n.parent) if (n === el) return true; return false; },
    matches: q => q === ':focus-visible' && !!el.fv
  };
  return el;
}

const body = mkEl();
body.appendChild = () => {};
global.document = {
  readyState: 'complete', body,
  head: { appendChild: st => styles.push(st) },
  documentElement: { clientWidth: 1360, clientHeight: 768 },
  createElement: tag => (tag === 'style' ? { id: '', textContent: '' } : (bubble = mkEl())),
  addEventListener: on(docL)
};
global.window = { innerWidth: 1360, innerHeight: 768, addEventListener: on(winL) };
Object.defineProperty(globalThis, 'navigator', { value: { maxTouchPoints: 10 }, configurable: true, writable: true });
globalThis.Glossary = require('../frontend/app/glossary.js');
require('../frontend/app/hint.js');

const over = (t, type, rel) => fire(docL, 'pointerover', { target: t, pointerType: type, relatedTarget: rel || null });
const out = (t, type, rel) => fire(docL, 'pointerout', { target: t, pointerType: type, relatedTarget: rel || null });
const down = type => fire(winL, 'pointerdown', { pointerType: type });
const key = k => fire(winL, 'keydown', { key: k });
const focusin = t => fire(docL, 'focusin', { target: t });
const focusout = t => fire(docL, 'focusout', { target: t });
const click = t => fire(docL, 'click', { target: t, detail: 1 });
const shown = () => !!(bubble && bubble.classList.contains('on'));
const says = term => shown() && bubble.textContent === Glossary.lookup(term);
const reset = () => { key('Escape'); build.setAttribute('aria-expanded', 'false'); build.fv = false; item.fv = false; };

const build = mkEl({ 'data-hint': 'build', 'aria-expanded': 'false' });
const glyph = mkEl({}, build);
const item = mkEl({ 'data-hint': 'refit' });

// 1. the help cursor is wired at load, scoped so buttons keep their pointer; no device gate remains
A.eq(styles.length, 1, 'the hint stylesheet is injected at load, before any bubble (no mid-session cursor flip)');
const css = () => styles.map(st => st.textContent).join('');
A.ok(css().includes('[data-hint]:not(button):not(a){cursor:help'), 'the help cursor skips buttons and links');
const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'hint.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
A.ok(!/maxTouchPoints|ontouchstart/.test(src), 'hint.js no longer picks its input mode from device capability');

// 2. hybrid laptop, mouse: hover shows, leaving hides
over(build, 'mouse');
A.ok(says('build'), 'mouse hover on a touchscreen laptop shows the glossary bubble');
out(build, 'mouse', body);
A.ok(!shown(), 'leaving with the mouse hides it');

// 3. mouse click on a dock trigger: no pin; nothing re-shows over the open menu
reset();
over(build, 'mouse'); down('mouse'); focusin(build); click(build);
A.ok(says('build'), 'the click keeps the hover bubble it landed on (no toggle-off flicker)');
build.setAttribute('aria-expanded', 'true'); focusout(build);   // navdock opens the menu, then blurs the trigger
A.ok(!shown(), 'the blur after a mouse toggle hides it (it is not pinned)');
over(glyph, 'mouse');
A.ok(!shown(), 'crossing the trigger glyph while its menu is open does not re-show a bubble over the menu');
over(item, 'mouse');
A.ok(says('refit'), 'hovering a menu item shows that item\'s own copy');
out(item, 'mouse', body);
A.ok(!shown(), 'and leaving the item hides it');

// 4. clicking a menu item: navdock hands focus back to the trigger — that must not pin the dock bubble
reset();
over(item, 'mouse'); down('mouse'); focusin(item); click(item); focusout(item); focusin(build);
A.ok(!shown(), 'focus returned to the trigger after a menu click shows nothing (the stuck BUILD bubble)');

// 5. Escape hides
reset();
over(build, 'mouse'); key('Escape');
A.ok(!shown(), 'Escape hides a hover bubble');

// 6. pure touch: tap shows, the post-tap blur keeps it, tap again / tap elsewhere dismisses
reset();
over(build, 'touch'); down('touch'); out(build, 'touch'); focusin(build);
A.ok(!shown(), 'a finger has no hover: touch pointerover / tap focus show nothing by themselves');
click(build);
A.ok(says('build'), 'a tap shows the bubble');
focusout(build);
A.ok(shown(), 'the blur navdock does after the tap does not kill the tapped bubble');
down('touch'); click(build);
A.ok(!shown(), 'tapping the same control again dismisses it');
down('touch'); click(build); down('touch'); click(body);
A.ok(!shown(), 'a tap elsewhere dismisses it');

// 7. hybrid leftover: pinned by a finger, cleared by a mouse click elsewhere
reset();
down('touch'); click(build);
A.ok(says('build'), 'tap pins the bubble');
down('mouse'); click(body);
A.ok(!shown(), 'a later mouse click elsewhere clears the finger-pinned bubble');

// 8. keyboard: Tab focus shows, Tab away hides, Enter keeps it until focus moves into the menu
reset();
key('Tab'); build.fv = true; focusin(build);
A.ok(says('build'), 'keyboard focus (:focus-visible) shows the bubble');
focusout(build);
A.ok(!shown(), 'tabbing away hides it');
key('Tab'); focusin(build); key('Enter'); click(build);
A.ok(says('build'), 'Enter on the focused trigger keeps its bubble');
focusout(build); item.fv = true; focusin(item);
A.ok(says('refit'), 'keyboard focus moving into the menu shows the item\'s copy');

// 9. engines without :focus-visible fall back to "was the last input a key?"
reset();
const bare = mkEl({ 'data-hint': 'build' }); delete bare.matches;
key('Tab'); focusin(bare);
A.ok(says('build'), 'without matches(): focus after a keypress shows the bubble');
key('Escape'); down('mouse'); focusin(bare);
A.ok(!shown(), 'without matches(): focus after a mouse press shows nothing');
const odd = mkEl({ 'data-hint': 'build' }); odd.matches = () => { throw new Error('unsupported selector'); };
key('Tab'); focusin(odd);
A.ok(says('build'), 'a matches() that throws uses the same fallback');

// 10. pen hovers like a mouse; any scroll dismisses
reset();
over(build, 'pen');
A.ok(says('build'), 'pen hover shows the bubble');
fire(winL, 'scroll', {});
A.ok(!shown(), 'a scroll dismisses it');

A.ok(!/\[data-hint\]\{cursor:help/.test(css()), 'no unscoped [data-hint]{cursor:help} rule, even after bubbles have shown');

A.report('hint-input-mode.test');
