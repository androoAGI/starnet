/* node test/hints-setting.test.js — Settings › LOOK & SOUND › DISPLAY › HINTS turns the glossary hover bubbles
   (hint.js) off once the station's words are familiar, and a control with a glossary hint never stacks the
   station tip (tooltip.js) on top of it: hovers come from the glossary only. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const ui = read('frontend/app/stationui.js');

// ---- 1. the setting: default on, rendered in DISPLAY, wired, applied live, carried by backups ----------
A.ok(/function defaults\(\) \{ return \{[^}]*\bhints: true\b/.test(ui), 'HINTS defaults to on (existing users keep today\'s help)');
A.ok(/<input type="checkbox" id="set-hints" ' \+ \(s\.hints \? 'checked' : ''\) \+ '> HINTS <span class="dim">— explain station terms when you hover them<\/span>/.test(ui),
  'a HINTS checkbox with a one-line purpose is rendered in Settings');
const display = ui.indexOf("id=\"set-stationdock\""), crt = ui.indexOf('// CRT — its own section', display), row = ui.indexOf('id="set-hints"');
A.ok(display > 0 && row > display && row < crt, 'it sits in LOOK & SOUND › DISPLAY (after STATION DOCK, before CRT)');
A.ok(/bind\('#set-hints', 'hints'\)/.test(ui), 'the checkbox saves through the same bind() as SCREEN FLICKER / TERMINAL AUDIO');
A.ok(/document\.body\.classList\.toggle\('no-hints', !s\.hints\)/.test(ui), 'applySettings() toggles body.no-hints live (no reload)');
A.ok(/if \(!s\.hints && typeof Hint === 'object' && Hint\.hide\) Hint\.hide\(\)/.test(ui), 'switching it off clears a bubble already on screen');

const collectStart = ui.indexOf('    const browserSections = () => {');
const collectEnd = ui.indexOf('    if (exportBtn)', collectStart);
A.ok(collectStart >= 0 && collectEnd > collectStart, 'the backup collector is located');
const collect = new Function('store', 'notifyDefaults', 'resolveRoomLighting',
  ui.slice(collectStart, collectEnd) + '\nreturn browserSections;')({ settings: { hints: false, notifyPrefs: {} } }, () => ({}), v => v);
A.eq(collect().settings.hints, false, 'a backup carries HINTS, so an import restores it');
// the lead can flip it from chat like every other look setting (station.settings lists it, look.set accepts it)
A.ok(/sound: 'true\|false', hints: 'true\|false'/.test(ui), 'station.settings lists hints as true|false');
A.ok(/'sound', 'hints', 'backdrop', 'sessionRow'\]\.forEach\(k => \{ out\[k\] = s\[k\]; \}\)/.test(ui), 'look readback reports hints');
A.ok(/else if \(k === 'flicker' \|\| k === 'sound' \|\| k === 'hints'\) bool\(k\);/.test(ui), 'look.set accepts hints as a boolean');

// every bottom-bar dock trigger speaks through the glossary, so HINTS quiets the whole dock (CREW too)
const triggers = read('frontend/index.html').match(/<button class="bb-grp"[^>]*>/g) || [];
A.ok(triggers.length >= 5, 'the bottom-bar dock triggers are located');
A.ok(triggers.every(t => /data-hint="[a-z]+"/.test(t)), 'every dock trigger (CREW, WORK, BUILD, APPS, SYSTEM) carries a glossary hint');
A.ok(/<button class="bb-grp" data-hint="crew"/.test(read('frontend/index.html')), 'CREW uses the core "crew" glossary term');

// on the dock the glossary bubble is the only hover, so it wears the station tip's themed nameplate (not gold)
const dockHint = (read('frontend/css/interface.css').match(/body > \.hint-bubble\.dock-tip \{([^}]*)\}/g) || []).join(' ');
A.ok(/color: var\(--ph-bright\)/.test(dockHint) && /border: 1px solid var\(--ph-dim\)/.test(dockHint) && /inset 2px 0 0 var\(--ph\)/.test(dockHint),
  'the dock\'s glossary bubble uses the station tip\'s phosphor colour, border and stripe');
A.ok(!/gold/.test(dockHint), 'and no gold accent on the dock');

// ---- 2. hint.js honours it at show time --------------------------------------------------------------
function mkEl(attrs) {
  const a = Object.assign({}, attrs || {}), s = new Set();
  const el = {
    style: { setProperty() {}, removeProperty() {} }, offsetWidth: 120, offsetHeight: 30, textContent: '', isConnected: true,
    classList: { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c),
      toggle: (c, v) => { if (v === undefined ? !s.has(c) : v) s.add(c); else s.delete(c); } },
    getAttribute: k => (k in a ? a[k] : null), setAttribute: (k, v) => { a[k] = String(v); },
    removeAttribute: k => { delete a[k]; }, hasAttribute: k => k in a,
    getBoundingClientRect: () => ({ left: 300, top: 600, bottom: 630, width: 90, height: 30 }),
    closest: sel => (sel === '[data-hint]' ? ('data-hint' in a ? el : null)
      : (/\[title\]|\[data-tip\]/.test(sel) && ('title' in a || 'data-tip' in a)) ? el : null),
    contains: n => n === el, appendChild() {}, matches: () => false
  };
  return el;
}
const hintL = new Map(), winL = new Map();
const on = m => (n, fn) => { if (!m.has(n)) m.set(n, []); m.get(n).push(fn); };
const fire = (m, n, ev) => (m.get(n) || []).forEach(fn => fn(ev));
let bubble = null;
const body = mkEl();
global.document = { readyState: 'complete', body, head: { appendChild() {} }, documentElement: { clientWidth: 1360, clientHeight: 768 },
  createElement: tag => (tag === 'style' ? { textContent: '' } : (bubble = mkEl())), addEventListener: on(hintL) };
global.window = { innerWidth: 1360, innerHeight: 768, addEventListener: on(winL) };
globalThis.Glossary = require('../frontend/app/glossary.js');
require('../frontend/app/hint.js');
const build = mkEl({ 'data-hint': 'build', title: 'Shape the station' });
const shown = () => !!(bubble && bubble.classList.contains('on'));

body.classList.add('no-hints');
fire(hintL, 'pointerover', { target: build, pointerType: 'mouse' });
A.ok(!shown(), 'HINTS off: hovering a hinted control shows no glossary bubble');
body.classList.remove('no-hints');
fire(hintL, 'pointerover', { target: build, pointerType: 'mouse' });
A.ok(shown() && bubble.textContent === Glossary.lookup('build'), 'HINTS on: the same hover shows the glossary copy');

// ---- 3. tooltip.js: glossary only — no station tip stacked on a hinted control -----------------------
const tipL = new Map();
const T = require('../frontend/app/tooltip.js');
T.init._wired = false;
T.init({ body, createElement: () => mkEl(), addEventListener: on(tipL) });
const plain = mkEl({ title: 'Your agents' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  fire(tipL, 'pointerover', { target: build });
  await sleep(420);
  A.ok(!build.getAttribute('aria-describedby'), 'a hinted control gets no station tip (no double box on hover)');
  A.ok(!build.hasAttribute('title'), 'its title is still adopted, so the OS bubble stays silenced too');
  fire(tipL, 'pointerout', { target: build, relatedTarget: body });
  fire(tipL, 'pointerover', { target: plain });
  await sleep(420);
  A.eq(plain.getAttribute('aria-describedby'), 'station-tip', 'a plain control (CREW-style) keeps its station tip');
  A.report('hints-setting.test');
})().catch(e => { console.log('FAIL: hints-setting rig threw — ' + (e && e.stack || e)); process.exit(1); });
