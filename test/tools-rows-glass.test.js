/* test/tools-rows-glass.test.js — CONNECT › ABILITIES › TOOLS reads as one tidy list (old-UI review 10-26 #5).

   The review called it "the densest old area left": colour emoji icons (🛰 📡 🗄 🔧 🕸 🎨 📓 ♫) beside VT323 in a column with no
   fixed width, so the names started anywhere from 279 to 290 px; JUKEBOX's switch lower than every other row's; a boxed
   green AVAILABLE and a boxed yellow FULL POWER on every row (16 boxes saying the same two things); 11px tool chips and dashed
   "+31 more" keys. Measured live on 10-30 after this change: 8 rows, every name at one x, every switch within 1px of its
   name line, 8 drawn icons, 0 emoji, 0 boxed tags, chips at 14px.

   Locks: (1) a drawn icon per toolset in a fixed column; (2) one plain tag line joined by dots; (3) the row keeps its switch
   on the name line however tall it grows; (4) readable chips; (5) no glow on hover. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const js = read('frontend/app/windows/connectors.js');
const css = read('frontend/css/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
const ui = read('frontend/css/interface.css').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (src, sel) => { const m = new RegExp('(?:^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(src); return m ? m[1] : ''; };

/* (1) */
const icons = /const TS_ICON = \{([\s\S]*?)\n    \};/.exec(js);
A.ok(!!icons, 'connectors.js holds one drawn icon set for the toolsets');
for (const id of ['web', 'comms', 'cabinet', 'workbench', 'orchestrator', 'studio', 'memory', 'jukebox', 'core'])
  A.ok(new RegExp('\\b' + id + ": 'M").test(icons[1]), 'toolset "' + id + '" has a drawn icon');
A.ok(/'<span class="ts-glyph" aria-hidden="true">' \+ tsIcon\(t\.id\) \+ '<\/span>'/.test(js), 'every row draws its icon (never the sidecar\'s emoji glyph)');
A.ok(!/esc\(t\.glyph/.test(js), 'the emoji glyph is no longer printed');
A.ok(/flex: 0 0 20px; width: 20px;/.test(rule(css, '.ts-glyph')), 'the icon column has a fixed width, so every name starts on one edge');
A.ok(/stroke: currentColor/.test(rule(css, '.ts-glyph svg')), 'the icon is stroked in the text colour');
A.ok(!/⚒/.test(js.slice(js.indexOf('function tsRowHTML'), js.indexOf('function tsRowHTML') + 4000)), 'the PLACE ONE key carries no ⚒');

/* (2) */
A.ok(/\.join\('<span class="ts-sep" aria-hidden="true"> · <\/span>'\)/.test(js) && /'<span class="ts-meta">' \+ meta \+ '<\/span>'/.test(js), 'availability, grant, ask and count read as one dotted line under the name');
A.ok(/border: 0;/.test(rule(css, '.ts-tag')) && /font-size: 14px/.test(rule(css, '.ts-tag')), 'the grant tag is plain 14px words, not a yellow box');
A.ok(/border: 0; padding: 0; font-size: 14px/.test(rule(ui, '.ts-availability')), 'AVAILABLE is plain words too');
A.ok(/color: var\(--ok\)/.test(rule(ui, '.ts-availability.available')), 'in green text');

/* (3)(4)(5) */
A.ok(/align-items: flex-start/.test(rule(ui, '#ts-list .ts-row')), 'a tall row (JUKEBOX) keeps its switch on the name line — motion.css centres checkbox rows otherwise');
A.ok(/font-size: 14px/.test(rule(css, '.ts-tools code')), 'tool chips are 14px');
A.ok(/border: 0/.test(rule(css, '.ts-more')) && !/dashed/.test(rule(css, '.ts-more')), '"+N more" is a plain key, not a dashed chip');
A.ok(/box-shadow: none/.test(rule(ui, '#ts-list .ts-row:hover')), 'a hovered row does not glow');

A.report('tools-rows-glass.test');
