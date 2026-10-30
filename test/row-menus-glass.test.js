/* test/row-menus-glass.test.js — a SESSIONS / PROJECTS row's menu is the dock's glass menu (old-UI review 10-26 #2).

   Andrew's screenshot (10-26): the session right-click menu still wore the July phosphor box — a solid 1px edge, a second
   ring and an 18px orange glow, 13px items, and fallback-font symbols (✎ ★ ⤓ ⤓ ⇲ ✕) sitting on another baseline than their
   words, both exports on one symbol. The PROJECTS row menu reuses the component.

   Locks: (1) both menus draw their icons from one 16px-grid set (rowMenuIcon), a distinct icon per action, no symbol
   characters; (2) the glass pass gives the menu the dock menu's face — card radius, no outer glow — and labels on VT323's
   grid; (3) the danger rows never fight the canonical armed skin. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('frontend/app/app.js');
const body = name => { const m = new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n').exec(app); if (!m) throw new Error('missing ' + name); return m[0]; };

/* ---- (1) the icons ---- */
const paths = /const ROW_MENU_PATHS = \{([\s\S]*?)\n  \};/.exec(app);
A.ok(!!paths, 'app.js holds one icon set for the row menus');
const icons = {}; for (const m of paths[1].matchAll(/(\w+): '([^']+)'/g)) icons[m[1]] = m[2];
for (const k of ['rename', 'pin', 'unpin', 'markdown', 'json', 'archive', 'unarchive', 'open', 'comms', 'delete'])
  A.ok(/^M[\d.\sMLHVZhvlmz-]+$/i.test(icons[k] || ''), 'icon "' + k + '" is a 16px-grid path');
A.ok(icons.markdown !== icons.json, 'the two exports no longer share one icon');
A.ok(/<svg viewBox="0 0 16 16"/.test(app) && /const rowMenuIcon = name =>/.test(app), 'rowMenuIcon draws an svg on the 16px grid');
for (const fn of ['openWsMenu', 'openProjectMenu']) {
  const src = body(fn);
  A.ok(/rowMenuIcon\(/.test(src), fn + ' draws its icons with rowMenuIcon');
  A.ok(!/[✎★☆⤓⇲⇱✕▸]/.test(src), fn + ' carries no symbol characters (they were fallback-font glyphs off the baseline)');
}
A.ok(/item\('export-md', 'Export \.md', 'markdown'\) \+ item\('export-json', 'Export \.json', 'json'\)/.test(body('openWsMenu')), 'each export names its own icon');

/* ---- (2)(3) the glass pass ---- */
const pip = read('frontend/css/pipglass.css').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = sel => { const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'); const m = re.exec(pip); return m ? m[1] : ''; };
const menu = rule('body.glass-demo:not(.hud-mode) .ws-menu');
A.ok(/border-radius:\s*var\(--sn-r-card\)/.test(menu), 'the menu takes the card radius');
A.ok(/var\(--bg\)/.test(menu), 'on the opaque face the dock menu uses (it opens over windows)');
A.ok(!/0 0 \d+px/.test(menu) && !/0 0 0 1px/.test(menu), 'no outer glow and no second ring');
const item = rule('body.glass-demo:not(.hud-mode) .ws-menu-item');
A.ok(/round\(nearest, 16px \/ var\(--sn-unzoom, 1\), 2\.5px\)/.test(item), 'labels sit on VT323\'s 2.5px device grid (15 device px at TEXT SIZE 90-100)');
A.ok(/:not\(\.armed\):is\(:hover, :focus-visible\)/.test(pip), 'hover never paints over an armed row');
A.ok(/\.ws-menu-item\.danger:not\(\.armed\)/.test(pip), 'the danger colour leaves the armed skin alone');
A.ok(/\.ws-menu-glyph svg \{[^}]*stroke: currentColor/.test(read('frontend/css/app.css')), 'the base sheet strokes the icon in the text colour (HUD mode too)');

A.report('row-menus-glass.test');
