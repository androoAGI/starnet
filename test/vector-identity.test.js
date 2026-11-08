/* node test/vector-identity.test.js
   Locks the VECTOR identity (Andrew 2026-11-08: vector-phosphor screens in a dark-chrome chassis):
   - frontend/css/vector.css is the LAST stylesheet, and <body> boots with `vx`, so the identity is on before first paint;
   - every rule in vector.css is scoped under body.vx (the identity is one class away from off, never a leak);
   - the curved radius scales are zeroed in ONE place each (the family is closed by tokens, not per-surface patches), and
     window interiors square by structure (empty inline lights keep their round), never by [class] text;
   - the logo keeps no glow (Andrew's call) — the sheet never touches it;
   - the world keeps its own colours: no phosphor grade in world.js and no colour filter on the station view (Andrew
     2026-11-08: the identity is the dashboard's, never a filter on the world). */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---- index.html: loaded last, on from first paint ----
const html = read('frontend/index.html');
const head = html.slice(0, html.indexOf('</head>'));
const sheets = [...head.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)].map(m => m[1]);
A.ok(sheets.length > 10, 'index.html loads its stylesheets in <head>');
A.eq(sheets[sheets.length - 1], 'css/vector.css', 'vector.css is the last stylesheet (it repaints every surface under it)');
const bodyTag = (html.match(/<body\b[^>]*>/) || [''])[0];
A.ok(/\bclass="[^"]*\bvx\b[^"]*"/.test(bodyTag), '<body> boots with the vx class: ' + bodyTag);

// ---- vector.css: every selector scoped under body.vx ----
const css = read('frontend/css/vector.css').replace(/\/\*[\s\S]*?\*\//g, '');
const preludes = [];
{
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') { preludes.push(css.slice(start, i).trim()); start = i + 1; }
    else if (c === '}' || c === ';') start = i + 1;
  }
}
const selectorLists = preludes.filter(p => p && !p.startsWith('@'));
A.ok(selectorLists.length > 60, 'vector.css parsed into rules (' + selectorLists.length + ')');
// split a selector list on its top-level commas only (a comma inside :is(…) / :not(…), nested or not, stays)
const splitTop = (list) => {
  const out = []; let depth = 0, start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(list.slice(start, i)); start = i + 1; }
  }
  out.push(list.slice(start));
  return out;
};
const unscoped = [];
for (const list of selectorLists) {
  for (const sel of splitTop(list).map(s => s.trim()).filter(Boolean)) {
    if (!/(^|\s)(html\s+)?body\.vx\b/.test(sel)) unscoped.push(sel);
  }
}
A.eq(unscoped, [], 'every vector.css selector is scoped under body.vx');
// the only at-rule is the bevel guard (a square fallback where corner-shape is unsupported, never a rounded one)
const atRules = [...new Set(preludes.filter(p => p.startsWith('@')))];
A.eq(atRules, ['@supports (corner-shape: bevel)'], 'the only at-rule is the corner-shape guard');

// ---- the radius families close by token ----
for (const token of ['--sn-r-card', '--sn-r-key', '--sn-r-row', '--sn-r-chip', '--r-sm', '--r', '--r-lg']) {
  A.ok(new RegExp(token + ':\\s*0px;').test(css), token + ' is zeroed under the identity');
}

// ---- window interiors square by STRUCTURE: no class-name text matching (every class change would pay a restyle) ----
A.ok(!/\[class/.test(css), 'vector.css never keys on [class] text');
A.ok(css.includes('#screen-game #terms .term:not(.pw) *:not(:is(span, i, b, em):empty)'),
  'window interiors square everything but empty inline lights, anchored where every window lives');

// ---- the logo keeps no glow ----
A.ok(!/logo/i.test(css), 'vector.css never targets the logo (no glow, no drop-shadow: Andrew\'s call)');

// ---- fully committed (Andrew 2026-11-08: "i want it to be actually fully committed"): the shared glass tokens are
// closed under body.vx once, and the screens before the station is up wear the same console ----
for (const tok of ['--gd-face', '--gd-light', '--gd-edge', '--cg-card', '--cg-glass', '--menu-glass', '--quest-glass', '--utility-glass']) {
  A.ok(new RegExp('html body\\.vx:not\\(\\.hud-mode\\) \\{[^}]*' + tok + ':').test(css), tok + ' is redefined once under body.vx (every surface that reads it joins the identity)');
}
for (const screen of ['#screen-connect', '#screen-future', '#screen-recovery', '#screen-unreachable', '#screen-lineage']) {
  A.ok(css.includes(screen) && /\.ov-panel \{[^}]*--vx-frame/.test(css), screen + ' is a framed VECTOR screen');
}
A.ok(/\.term:not\(\.pw\) \.term-title::before/.test(css), 'every window title carries the lit lead mark');

// ---- the world keeps its own colours (Andrew 2026-11-08: "it should only apply to the dashboard not add filters to
// the world itself"). The identity is chrome around the station view, never a tint or filter on it ----
const world = read('frontend/app/world.js');
A.ok(!/drawPhosphorGrade|phosphorFeed|CRT\.mono/.test(world), 'world.js paints no phosphor grade: the station renders in true colour');
A.ok(!/classList\.contains\('vx'\)/.test(world), 'world.js never reads body.vx: the dashboard identity cannot change the world');
const viewRules = (css.match(/[^{}]*#stage-wrap[^{}]*\{[^}]*\}/g) || []).join(' ');
A.ok(viewRules.length > 0, 'vector.css frames the station view');
A.ok(!/(^|[^-])filter\s*:(?!\s*(none|drop-shadow))/m.test(viewRules) && !/mix-blend-mode/.test(viewRules),
  'vector.css puts no colour filter or blend on the station view (frame lines only)');

// ---- the deeper pass (Andrew 2026-11-08: "I need to dive deeper in … This is the look and aesthetic"): the dock menus
// are cut HUD plates (9-slice SVG masks: a fill and a lit line), selection is inverse video, a failed run is a hazard
// plate in the TRUE state colour ----
for (const [sel, label] of [['.bb-menu::before', 'dock menu face'], ['.bb-menu::after', 'dock menu line']]) {
  const rules = css.split(sel + ' {').slice(1).map(r => r.slice(0, r.indexOf('}')));
  A.ok(rules.some(r => /-webkit-mask-box-image: url\("data:image\/svg\+xml,/.test(r)), label + ' is a cut HUD plate (9-slice SVG mask)');
}

// ---- the alien device (Andrew 2026-11-08: "like it was designed by aliens"): every screen sits in a moulded chrome
// housing, baked to PNG (a lit SVG slices wrong as a border-image). Andrew rejected the brow eye crest and the circuit-trace
// patches (2026-11-08: "I do not like everything I circled here"): neither may come back ----
const fsx = require('fs'), pathx = require('path');
for (const [sel, label] of [['#left::after', 'CREW'], ['#chat-panel::after', 'COMMS'], ['.term:not(.pw)::after', 'every window'],
  ['#stage-wrap::after', 'the station view']]) {
  const rules = css.split(sel + ' {').slice(1).map(r => r.slice(0, r.indexOf('}')));
  const m = rules.map(r => r.match(/border-image: url\("(vx\/[\w-]+\.png)"\)/)).find(Boolean);
  A.ok(m, label + ' sits in a moulded housing (a 9-slice PNG border-image)');
  if (m) A.ok(fsx.existsSync(pathx.join(__dirname, '..', 'frontend', 'css', m[1])), label + ' housing file ' + m[1] + ' ships next to the sheet');
}
A.ok(!/vx\/crest\.png/.test(css) && !fsx.existsSync(pathx.join(__dirname, '..', 'frontend', 'css', 'vx', 'crest.png')),
  'no brow eye crest (Andrew rejected it): the sheet never draws it and the art does not ship');
A.ok(!/#stage-wrap::after \{[^}]*(mix-blend|[^-]filter\s*:)/.test(css), 'the station view housing is a frame only (no filter, no blend on the world)');
A.ok(/\.comms-presence\.resolved\.tone-bad \{ --hz: var\(--bad/.test(css) && /\.comms-presence\.resolved\.tone-warn \{ --hz: var\(--warn/.test(css),
  'the hazard plate wears the run\'s true state colour (bad = red, warn = amber), never the theme hue');
A.ok(/\.ws-row\.sel:not\(\.attn\) \{[^}]*color: #020604/.test(css), 'a selected row is inverse video (black type on the lit slot)');

A.ok(css.includes('.ws-row.sel:not(.attn) *:not(.ws-dot)') && !/\.ws-row\.sel:not\(\.attn\) \* \{/.test(css),
  'inverse video never inks the row state dot: a failed/working mark keeps its true colour on a selected row');
// ---- no grids (Andrew 2026-11-08: "not a fan of the grid at all tbh") and no circuit traces (rejected the same day): the
// screens are plain glass ----
A.ok(!/1px, transparent 1px\)/.test(css), 'vector.css draws no grid lines anywhere (no 1px-line tiles)');
A.ok(!/background-blend-mode:[^;]*multiply/.test(css), 'no circuit-trace patch anywhere: CREW and COMMS are plain glass (Andrew rejected the traces)');
A.ok(/#left :is\(#workstreams, #projects, #crew\) :is\(\.ws-row, \.crew-row\) \{ border-radius: 9px/.test(css),
  'rail rows are moulded glass slots (rounded), never square tiles');
A.ok(/--vx-slot:/.test(css) && /--vx-gloss:/.test(css), 'list entries are glass slots and the chosen one is the gloss slot');
A.report('vector-identity');
