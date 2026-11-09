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

A.ok(css.includes('.ws-row.sel:not(.attn) *:not(.ws-dot)') && !/\.ws-row\.sel:not\(\.attn\) \* \{/.test(css),
  'inverse video never inks the row state dot: a failed/working mark keeps its true colour on a selected row');
// ---- no grids (Andrew 2026-11-08: "not a fan of the grid at all tbh") and no circuit traces (rejected the same day): the
// screens are plain glass ----
A.ok(!/1px, transparent 1px\)/.test(css), 'vector.css draws no grid lines anywhere (no 1px-line tiles)');
A.ok(!/background-blend-mode:[^;]*multiply/.test(css), 'no circuit-trace patch anywhere: CREW and COMMS are plain glass (Andrew rejected the traces)');
A.ok(/#left :is\(#workstreams, #projects, #crew\) :is\(\.ws-row, \.crew-row\) \{ border-radius: 9px/.test(css),
  'rail rows are moulded glass slots (rounded), never square tiles');
A.ok(/--vx-slot:/.test(css) && /--vx-gloss:/.test(css), 'list entries are glass slots and the chosen one is the gloss slot');
// ---- luminous glass (Andrew 2026-11-08: "more gorgeous like these … 2010s y2k future winamp style"): the screens are deep
// tinted glass with a gloss sweep, the body is liquid chrome, the fat housing corners carry lit lenses ----
A.ok(/--vx-glass-deep:\s*linear-gradient\([^;]*var\(--ph\)/.test(css), 'the glass holds the theme hue (deep tinted glass, never flat black)');
A.ok(/#left, #chat-panel\)::before \{[^}]*var\(--vx-glass-sweep\)[^}]*var\(--vx-glass-deep\)/.test(css), 'CREW and COMMS glass carry the gloss sweep over the tinted body');
A.ok(/#left::after \{[^}]*var\(--vx-lens\)/.test(css) && /#chat-panel::after \{[^}]*var\(--vx-lens\)/.test(css), 'the fat housing corners carry lit lenses');
A.ok(/#topbar::before \{[^}]*content: ''/.test(css) && !/logo/i.test(css), 'the logo sits in an LCD well cut into the rail, never by styling the logo itself');
// ---- the dock keys are one transport bar (Andrew 2026-11-08: "improve the bottom left buttons … lets make that look perfect"),
// and the restyle never hides the group's real state: a group with an open window (.has-active) lights its LED ----
A.ok(/#bottombar \.bb-group::before \{[^}]*content: ''/.test(css), 'a chrome seat runs under the dock keys (one transport bar)');
A.ok(/#bottombar \.bb-group\.has-active > \.bb-grp::after \{[^}]*var\(--gold\)/.test(css),
  'a dock group with an open window lights its LED in the state colour (the restyle keeps .has-active visible)');
A.ok(/#bottombar \.bb-group\.open > \.bb-grp \{[^}]*translateY/.test(css), 'an open dock group reads as a pressed, lit key');
// ---- key bars + control decks (Andrew 2026-11-08: "change the sessions, projects and new as well, and improve the panels"):
// the rail tabs and window tab rows sit on a chrome seat with the chosen tab pressed and lit (keyed on the SAME state hooks the
// app sets, so the restyle can never show a different tab as chosen); the composer is a chrome deck around a recessed well ----
A.ok(/#left \.ws-head :is\(\.ws-view, \.ws-head-acts\) \{[^}]*background: var\(--vx-seat\)/.test(css), 'the rail tabs and + NEW sit on chrome seats');
A.ok(/#left \.ws-head \.ws-tab\.on \{[^}]*var\(--vx-cap-on\)/.test(css), 'the chosen rail tab (.on) is the pressed, lit cap');
A.ok(/\.fam-tabs > \.fam-tab\.on, \.q-view-tabs > button\[aria-selected="true"\], \.utility-tabs > button\[aria-pressed="true"\], \.fm-tabs > \.fm-tab\.on\) \{[^}]*var\(--vx-cap-on\)/.test(css),
  'window tab rows light the chosen tab from the app’s own state (.on / aria-selected / aria-pressed)');
A.ok(/#chat-inputrow \.chat-editline \{[^}]*var\(--vx-well\)/.test(css), 'the COMMS composer text sits in a recessed well inside a chrome deck');
// ---- the playlist (Andrew 2026-11-08: "the session list should almost be like what the music playlist is here"): one dark LCD
// screen, a lit band on the chosen track. The band is NOT inverse video, so every state mark keeps its true colour on it. No
// track numbers (Andrew 2026-11-08: "get rid of the 01 02 03 in the sessions") ----
A.ok(/#left :is\(#workstreams, #projects\) \{[^}]*background: var\(--vx-lcd\)/.test(css), 'the session list is one LCD screen');
A.ok(!/counter\(vxtrack/.test(css) && !/counter-reset: vxtrack/.test(css), 'the sessions carry no track numbers (Andrew removed them)');
for (const [st, col] of [['unseen', 'var(--gold)'], ['working', 'var(--ph-bright)'], ['failed', 'var(--bad)']])
  A.ok(css.split('\n').some(l => l.includes('.ws-row.ws-row.sel:not(.attn) .ws-dot.' + st) && (l.includes('{ background: ' + col) || css.includes('.ws-dot.' + st + ',\n'))),
    'the chosen track keeps its ' + st + ' dot colour on the band');
A.ok(/\.sel:not\(\.attn\) \.ws-dot\.unseen,\n[^{]*\.ws-dot\.needsyou \{ background: var\(--gold\)/.test(css), 'unseen and needs-you tracks keep --gold on the band');
A.ok(/\.ws-dot\.unseen ~ \.ws-meta \{ color: var\(--gold\) !important/.test(css), 'an unseen track keeps its gold time token (the playlist type never repaints it)');
A.ok(/#chat-panel #chat-log \{[^}]*background: var\(--vx-lcd\)/.test(css), 'the COMMS transcript is the same kind of LCD screen');
// ---- the brand well is centred on the bar's axis and holds the whole mark; the dock keys are silver keys parted by black
// channels, each LED in a dark lamp pocket so lit vs dark reads on the bright key ----
A.ok(/#topbar::before \{[^}]*top: calc\(50% - 22px\)[^}]*width: 202px/.test(css), 'the brand well is centred on the top bar and wide enough for the whole mark');
A.ok(/#bottombar \.bb-group > \.bb-grp::before \{[^}]*border-radius: 50%/.test(css), 'each dock LED sits in a dark lamp pocket');
A.ok(!/border-radius: 999px \d+px \d+px 999px/.test(css) && !/border-radius: \d+px 999px 999px \d+px/.test(css),
  'end keys use real pill radii (999px corners get scaled down with their neighbours and square the inner corners)');
// ---- title plates, knobs, clamps, the dark knob (Andrew 2026-11-08: "get rid of NEW in the crew section", "the search and
// collapse button to be updated", "the right side agent profile picture needs more space", "more detail between the panels",
// "settings to make it darker", "improve the crew and comms on the top") ----
A.ok(/#left \.ws-head #ws-new \{ display: none !important; \}/.test(css) && !/#ws-addproject(?!\[hidden\])[^{]*\{[^}]*display: none/.test(css),
  'the rail drops + NEW but PROJECTS keeps its + ADD');
A.ok(/#left, #chat-panel\) > h3 \{[^}]*display: flex[^}]*#eef2f6/.test(css), 'the CREW and COMMS heads are chrome title plates');
A.ok(/#left > h3 #crew-sum,\n[^{]*\.comms-session \{[^}]*background: var\(--vx-lcd\)/.test(css), 'the live head readouts sit in LCD pills');
A.ok(/#left > h3 \.crew-hide \{[^}]*border-radius: 50%/.test(css), 'find and fold are round chrome knobs');
A.ok(/#left > h3 #crew-search-toggle\[aria-expanded="true"\] \{[^}]*var\(--ph\)/.test(css), 'an open finder is the lit knob (its aria-expanded state stays visible)');
A.ok(/#chat-panel \.comms-portrait \{[^}]*width: 56px/.test(css), 'the COMMS portrait has a bigger bezel');
A.ok(/:is\(\.crew-resizer, \.col-resizer\)::before \{[^}]*pointer-events: none/.test(css), 'the gutters carry clamp brackets that never catch the drag');
A.ok(/calc\(var\(--vx-dim, 0\)/.test(css), 'the device darkens with the BRIGHTNESS knob (--vx-dim)');
A.ok(/setProperty\('--vx-dim', dim\.toFixed\(3\)\)/.test(fsx.readFileSync(pathx.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8')),
  'stationui writes --vx-dim from SETTINGS › BRIGHTNESS');
// ---- the finish (Andrew 2026-11-08: "the comms looks weird and overly large for no reason", "the grpahics for certain elements
// look so low quality") ----
A.ok(/#left, #chat-panel\) > h3 \{ height: 42px;/.test(css), 'the CREW and COMMS plates are one slim height');
A.ok(/#chat-panel #comms-idbar \{ min-height: 0;[^}]*border-bottom: 0/.test(css), 'the COMMS identity is a compact strip with no rule under it');
A.ok(/#chat-panel \.comms-portrait \{ width: 46px; height: 52px;/.test(css), 'the COMMS portrait is sized to the strip');
A.ok(/:is\(\.crew-resizer, \.col-resizer\)::before \{[^}]*data:image\/svg\+xml/.test(css), 'the clamps are drawn brackets, not stacked gradients');
A.ok(/\.cam-hud::after \{[^}]*--cm: #c9d0d8/.test(css), 'the viewfinder marks are chrome, not lit HUD green (the marks themselves stay)');
A.ok(/\.cam-cine \{[^}]*border-radius: 999px/.test(css), 'CINEMA is a silver pill key');
A.ok(/#left \.ws-head \{ background: none; \}/.test(css), 'no green hairlines over the rail head');
A.report('vector-identity');
