/* node test/vector-identity.test.js
   Locks the VECTOR identity (Andrew 2026-11-08: vector-phosphor screens in a dark-chrome chassis):
   - frontend/css/vector.css is the LAST stylesheet, and <body> boots with `vx`, so the identity is on before first paint;
   - every rule in vector.css is scoped under body.vx (the identity is one class away from off, never a leak);
   - the curved radius scales are zeroed in ONE place each (the family is closed by tokens, not per-surface patches), and
     window interiors square by structure (empty inline lights keep their round), never by [class] text;
   - the mark keeps its own letterforms and mask (style.css), and VECTOR ends on the clean mark (Andrew 2026-11-09:
     "remove the glow entirely and just be the clean logo"; the 11-08 glow and digit field stay only under variation B);
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
// the at-rules are the bevel guard (a square fallback where corner-shape is unsupported, never a rounded one) and the fit
// pass's four panel-width queries (section 26). A window-width @media is never one of them: a panel's dress follows the panel.
// The deep end of the dark knob adds one more guard: the legend flip needs clamp() inside a color-mix() percentage, and a
// webview without it keeps the dark legends (the knob still darkens, it only never flips them)
const atRules = [...new Set(preludes.filter(p => p.startsWith('@')))];
const INK_GUARD = '@supports (color: color-mix(in srgb, red, blue calc(clamp(0, .5, 1) * 100%)))';
A.eq(atRules, ['@supports (corner-shape: bevel)', INK_GUARD, '@container vx-rail (max-width: 215px)', '@container vx-rail (max-width: 190px)', '@container vx-rail (max-width: 165px)', '@container vx-comms (max-width: 260px)'],
  'the only at-rules are the corner-shape guard, the dark knob’s legend-flip guard and the fit pass’s four panel-width queries');

// ---- the radius families close by token ----
for (const token of ['--sn-r-card', '--sn-r-key', '--sn-r-row', '--sn-r-chip', '--r-sm', '--r', '--r-lg']) {
  A.ok(new RegExp(token + ':\\s*0px;').test(css), token + ' is zeroed under the identity');
}

// ---- window interiors square by STRUCTURE: no class-name text matching (every class change would pay a restyle) ----
A.ok(!/\[class/.test(css), 'vector.css never keys on [class] text');
A.ok(css.includes('#screen-game #terms .term:not(.pw) *:not(:is(span, i, b, em):empty)'),
  'window interiors square everything but empty inline lights, anchored where every window lives');

// ---- the mark is never reshaped: VECTOR may colour it, the letterforms stay the master art's own ----
A.ok(!/\.logo-img \{[^}]*mask/.test(css), 'vector.css never swaps the mark\'s mask (the letterforms are the master art\'s own)');

// ---- fully committed (Andrew 2026-11-08: "i want it to be actually fully committed"): the shared glass tokens are
// closed under body.vx once, and the screens before the station is up wear the same console ----
for (const tok of ['--gd-face', '--gd-light', '--gd-edge', '--cg-card', '--cg-glass', '--menu-glass', '--quest-glass', '--utility-glass']) {
  A.ok(new RegExp('html body\\.vx:not\\(\\.hud-mode\\) \\{[^}]*' + tok + ':').test(css), tok + ' is redefined once under body.vx (every surface that reads it joins the identity)');
}
for (const screen of ['#screen-connect', '#screen-future', '#screen-recovery', '#screen-unreachable', '#screen-lineage']) {
  A.ok(css.includes(screen) && /\.ov-panel \{[^}]*--vx-frame/.test(css), screen + ' is a framed VECTOR screen');
}
A.ok(/\.term:not\(\.pw\) \.term-title::before/.test(css), 'every window title carries the lit lead mark');
// LITE EFFECTS (css/litefx.css, on through body.sn-lite-glass on a weak machine) fills a window's own box opaque. A VECTOR
// window's box is empty by design: its screen is the opaque ::before, so the fill only showed as dark wedges outside the
// bezel's round top corners (measured 2026-11-13 on the 0.15.2 candidate: about 6 x 6 px at the top left). The box stays
// empty, and the rule carries two ids so it outranks that sheet's own (one id, both !important)
A.ok(/\nhtml body\.vx\.sn-lite-glass:not\(\.hud-mode\) #screen-game #terms \.term:not\(\.pw\) \{ background-color: transparent !important; \}/.test(css),
  'a VECTOR window keeps its empty box under LITE EFFECTS (no dark wedge outside the bezel’s round corners)');
A.ok(/\.term:not\(\.pw\)::before \{[^}]*var\(--vx-black\);/.test(css) && /--vx-black: #000106;/.test(css),
  'the window’s screen is opaque on its own, so the lite fill has nothing to do behind it');

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
A.ok(/#topbar::before \{[^}]*content: ''/.test(css), 'the mark sits in an LCD well cut into the rail');
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
  'the wide + NEW key of 11-08 stays dropped and PROJECTS keeps its + ADD (the fit pass, section 26, gives VECTOR a round + key back)');
A.ok(/#left, #chat-panel\) > h3 \{[^}]*display: flex[^}]*#eef2f6/.test(css), 'the CREW and COMMS heads are chrome title plates');
A.ok(/#left > h3 #crew-sum,\n[^{]*\.comms-session \{[^}]*background: var\(--vx-lcd\)/.test(css), 'the live head readouts sit in LCD pills');
A.ok(/#left > h3 \.crew-hide \{[^}]*border-radius: 50%/.test(css), 'find and fold are round chrome knobs');
A.ok(/#left > h3 #crew-search-toggle\[aria-expanded="true"\] \{[^}]*var\(--ph\)/.test(css), 'an open finder is the lit knob (its aria-expanded state stays visible)');
A.ok(/#chat-panel \.comms-portrait \{[^}]*width: 56px/.test(css), 'the COMMS portrait has a bigger bezel');
A.ok(/:is\(\.crew-resizer, \.col-resizer\)::before \{[^}]*pointer-events: none/.test(css), 'the gutters carry clamp brackets that never catch the drag');
A.ok(/:is\(\.crew-resizer, \.col-resizer\)::before \{[^}]*data:image\/svg\+xml/.test(css), 'the clamps are drawn brackets, not stacked gradients');
A.ok(/calc\(var\(--vx-dim, 0\)/.test(css), 'the device darkens with the BRIGHTNESS knob (--vx-dim)');
A.ok(/setProperty\('--vx-dim', dim\.toFixed\(3\)\)/.test(fsx.readFileSync(pathx.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8')),
  'stationui writes --vx-dim from SETTINGS › BRIGHTNESS');
// ---- the finish (Andrew 2026-11-08: "the comms looks weird and overly large for no reason", "the grpahics for certain elements
// look so low quality") ----
A.ok(/#left, #chat-panel\) > h3 \{ height: 42px;/.test(css), 'the CREW and COMMS plates are one slim height');
A.ok(/#chat-panel #comms-idbar \{ min-height: 0;[^}]*border-bottom: 0/.test(css), 'the COMMS identity is a compact strip with no rule under it');
A.ok(/#chat-panel \.comms-portrait \{ width: 46px; height: 52px;/.test(css), 'the COMMS portrait is sized to the strip');
A.ok(/\.cam-hud::after \{[^}]*--cm: #c9d0d8/.test(css), 'the viewfinder marks are chrome, not lit HUD green (the marks themselves stay)');
A.ok(/\.cam-cine \{[^}]*border-radius: 999px/.test(css), 'CINEMA is a silver pill key');
A.ok(/#left \.ws-head \{ background: none; \}/.test(css), 'no green hairlines over the rail head');
// ---- the lit mark, the finder, the clean rails (Andrew 2026-11-08: "starnet logo top left needs to be immensely improved",
// "the search bar needs to be better, and get rid of the line on the top and bottom thats in the middle of the bar") ----
const rails = (css.match(/\(#topbar, #bottombar\) \{\s*background:[^}]*\}/g) || []).pop() || '';
A.ok(rails && !/vx-pipe/.test(rails), 'the rails\' last background carries no light pipe across the middle');
A.ok(/:is\(\.ws-rail-search, \.crew-search-wrap\) \{ background: none !important; box-shadow: none !important; \}/.test(css), 'the finder row is not a second frame around the finder');
A.ok(/\.ws-rail-search label::before \{[^}]*mask:/.test(css) && /\.crew-search-wrap::before \{[^}]*mask:/.test(css), 'both finders lead with the lit lens');
A.ok(/#crew-search-close \{[^}]*border-radius: 50%/.test(css), 'the crew finder closes on a round chrome knob');

// ---- the sheet is eleven parts (2026-11-10). VECTOR = sections 1-22, the silver device Andrew kept ("I love this look so much
// its insane"), finished by section 25, fitted by section 26, its CREW and COMMS heads rebuilt by section 27, its menu panels
// dressed by section 28, their insides by section 29, the cards inside COMMS by section 30, the last old surfaces by section 31
// and the windows re-formatted as the device by section 32. Section 23, the black chassis, is variation B's base: gated :where(.vx-b), so it adds no specificity
// and B renders exactly as it did when that pass applied to both. Section 24 is variation B itself ----
const rawCss = read('frontend/css/vector.css');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
const cut = (title) => { const at = rawCss.indexOf(title); return at < 0 ? -1 : rawCss.lastIndexOf('/*', at); };
const baseAt = cut('23 · THE BLACK CHASSIS'), bAt = cut('24 · VARIATION B'), pAt = cut('25 · THE PERFECTED VECTOR'), fAt = cut('26 · THE FIT'), hAt = cut('27 · THE HEADS'), nAt = cut('28 · THE PANELS'), iAt = cut('29 · THE INSIDES'), cAt = cut('30 · THE CARDS'), lAt = cut('31 · THE REST'), xAt = cut('32 · THE FORMAT'), tAt = cut('33 · THE FIRST TEST'), sAt = cut('34 · THE SECOND TEST'), crewAt = cut('35 · THE CREW LENS');
A.ok(baseAt > 0 && bAt > baseAt && pAt > bAt && fAt > pAt && hAt > fAt && nAt > hAt && iAt > nAt && cAt > iAt && lAt > cAt && xAt > lAt && tAt > xAt && sAt > tAt && crewAt > sAt,
  'vector.css carries the black chassis, variation B, the perfected VECTOR, the fit pass, the heads, the panels, the insides, the cards, the rest, the format and the first test’s fixes as sections 23 to 33 in that order');
const cssA = strip(rawCss.slice(0, baseAt));
const cssBase = strip(rawCss.slice(baseAt, bAt));
const cssB = strip(rawCss.slice(bAt, pAt));
const cssP = strip(rawCss.slice(pAt, fAt));
const cssF = strip(rawCss.slice(fAt, hAt));
const cssH = strip(rawCss.slice(hAt, nAt));
const cssN = strip(rawCss.slice(nAt, iAt));
const cssI = strip(rawCss.slice(iAt, cAt));
const cssC = strip(rawCss.slice(cAt, lAt));
const cssL = strip(rawCss.slice(lAt, xAt));
const cssX = strip(rawCss.slice(xAt, tAt));
const cssT = strip(rawCss.slice(tAt, sAt));
const cssS = strip(rawCss.slice(sAt, crewAt));
const cssK = strip(rawCss.slice(crewAt));
// an at-rule's own prelude (@container ... {) is not a selector: drop it, and its closing brace leaves an empty chunk
const selsOf = (t) => t.replace(/@[a-z-]+[^{};]*\{/g, '').split('}').map(r => r.slice(0, Math.max(0, r.indexOf('{')))).filter(x => x.trim()).flatMap(x => x.split(/,\n/)).map(x => x.trim());
// a selector list can also run on ONE line, so the line-start check alone is not enough: every root in a section must carry its gate
const stray = (t, gate) => (t.match(/html body\.vx:not\(\.hud-mode\)[^ ]*/g) || []).filter(x => x !== 'html body.vx:not(.hud-mode)' + gate);
A.ok(!/\.vx-b\b/.test(cssA), 'nothing in sections 1-22 mentions .vx-b: VECTOR does not depend on its variation');

// ---- the black chassis (Andrew 2026-11-09: "seriously touch it up more") now rides only under variation B ----
const selsBase = selsOf(cssBase);
A.ok(selsBase.length > 20, 'the black chassis is a whole pass (' + selsBase.length + ' selectors)');
A.eq(selsBase.filter(x => !x.startsWith('html body.vx:not(.hud-mode):where(.vx-b)')).join(' | '), '', 'every black-chassis selector is gated :where(.vx-b): zero added specificity, and VECTOR never sees it');
A.eq(stray(cssBase, ':where(.vx-b)').join(' | '), '', 'no black-chassis selector slips its gate inside a one-line list');
const lastBase = (tail) => (cssBase.match(new RegExp('html body\\.vx:not\\(\\.hud-mode\\):where\\(\\.vx-b\\) ' + tail + ' \\{[^}]*\\}', 'g')) || []).pop() || '';
const railBase = lastBase('#screen-game :is\\(#topbar, #bottombar\\)');
A.ok(/corner-shape: round/.test(railBase) && !/vx-pipe/.test(railBase), 'its rails are one slab of black chrome with no pipe across the middle of the bar');
const headBase = lastBase('#screen-game :is\\(#left, #chat-panel\\) > h3');
A.ok(/height: 40px/.test(headBase) && !/#eef2f6/.test(headBase) && /rgba\(var\(--ph-rgb\)/.test(headBase), 'its CREW and COMMS titles sit on a band of hue glass, not a silver plate');
A.ok(/--pg-glow: 0 0 8px rgba\(var\(--ph-rgb\)/.test(headBase) && !/text-shadow/.test(headBase),
  'its titles are lit through --pg-glow (pipglass owns text-shadow there with three ids: a plain text-shadow never paints)');
const houseBase = lastBase('#screen-game :is\\(#left, #chat-panel\\)::after');
A.ok(/filter: drop-shadow/.test(houseBase) && !/brightness/.test(houseBase), 'its housings show as baked: the dark knob does not flatten the render to grey');
const gutBase = lastBase('#screen-game :is\\(\\.crew-resizer, \\.col-resizer\\)');
A.ok(/center \/ 1px 100% no-repeat/.test(gutBase), 'each of its gutters is one thin lit seam');
A.ok(/:where\(\.vx-b\) #screen-game :is\(\.crew-resizer, \.col-resizer\)::before \{ content: none; \}/.test(cssBase), 'and nothing is bolted across that seam (VECTOR\'s clamps are cancelled under variation B)');
A.ok(/:is\(#topbar, #bottombar\) \.widget-rail \.wg-add \{[^}]*radial-gradient\(circle at 38% 28%, #f4f7fa/.test(cssBase), 'both of its + keys are the same silver knob');
A.ok(/#left #workstreams > \.ws-row\.ws-row\.ws-row\.sel:not\(\.attn\),[^{]*\{[^}]*rgba\(var\(--ph-rgb\), \.75\)/.test(cssBase), 'its chosen track is a lit capsule (.sel stays visible)');

// ---- variation B, LUMINOUS GLASS (Andrew 2026-11-09: "I want another entire variation as well"). It ships DORMANT: one more
// body class, and nothing in the app sets it until Andrew asks for a way to (no unrequested setting, key or button) ----
const selsB = selsOf(cssB);
A.ok(selsB.length > 40, 'variation B restyles the whole dashboard (' + selsB.length + ' selectors)');
A.eq(selsB.filter(x => !x.startsWith('html body.vx:not(.hud-mode).vx-b')).join(' | '), '', 'every selector in variation B is scoped body.vx.vx-b');
A.eq(stray(cssB, '.vx-b').join(' | '), '', 'no variation B selector slips its scope inside a one-line list');
const appDir = path.join(ROOT, 'frontend', 'app');
const hooks = fs.readdirSync(appDir).filter(f => f.endsWith('.js')).filter(f => /vx-b\b/.test(fs.readFileSync(path.join(appDir, f), 'utf8')));
A.eq(hooks.join(' '), '', 'no script sets vx-b: the variation is dormant until Andrew asks for a way to pick it');
A.ok(!/vx-b\b/.test(html), 'index.html does not boot with vx-b');
A.ok(/\.vx-b #screen-game :is\(#topbar, #bottombar\)::after \{ content: none; \}/.test(cssB), 'variation B draws no line on, across or along the bars');
A.ok(/#stage-wrap::after \{[^}]*border-image: none[^}]*box-shadow: var\(--vxb-tube\)/.test(cssB), 'variation B has no metal: every housing is one lit tube');
A.ok(!/url\(/.test(cssB) && !/#(c9d0d8|eef2f6|a9b2bd|f4f7fa)/i.test(cssB), 'variation B ships no art and no silver');
A.ok(/> \.bb-grp:not\(:hover\):not\(:focus-visible\) \{[^}]*inset 0 0 0 1px rgba\(var\(--ph-rgb\), \.58\)[^}]*--pg-glow: var\(--vxb-lit\)/.test(cssB),
  'variation B dock keys are lit ghost keys (a hue ring and a lit legend), never dark smoked caps');
A.ok(/\.has-active > \.bb-grp::after \{[^}]*var\(--gold\)/.test(cssB), 'variation B keeps the dock’s live lamp in its state colour');

// ---- the perfected VECTOR (Andrew 2026-11-09: the dock keys "should have more of the 3D effect like the add a widget does",
// the logo "is not properly centered ... remove the glow entirely and just be the clean logo", the search and collapse keys
// "are a bit too glitchy looking", "the 0 working also glitches out") ----
const selsP = selsOf(cssP);
A.ok(selsP.length > 15, 'the perfected pass is its own section (' + selsP.length + ' selectors)');
A.eq(selsP.filter(x => !x.startsWith('html body.vx:not(.hud-mode):not(.vx-b)')).join(' | '), '', 'every selector in the perfected pass is scoped :not(.vx-b): variation B never sees it');
A.eq(stray(cssP, ':not(.vx-b)').join(' | '), '', 'no perfected-pass selector slips its scope inside a one-line list');
// pipglass zeroes a resting dock key's box-shadow with THREE ids, so a two-id key rule can never give the key a body. The
// dock id is doubled on rest, hover and open alike (a three-id rest rule would otherwise beat a two-id hover or open rule)
const keyP = (state) => (cssP.match(new RegExp('#bottombar#bottombar \\.bb-group' + state + ' \\{[^}]*\\}')) || [''])[0];
A.ok(/box-shadow:[^;]*inset 0 -12px[^;]*0 0 0 1px #050608, 0 2px 4px rgba\(0, 0, 0, \.7\)/.test(keyP(' > \\.bb-grp')),
  'a resting dock key is a domed chrome body wearing the add knob\'s ring and drop shadow (three ids: it out-ranks the pipglass reset)');
A.ok(/background:/.test(keyP(' > \\.bb-grp:is\\(:hover, :focus-visible\\)')), 'a hovered dock key keeps its own lit body over the three-id rest rule');
A.ok(/inset 0 3px 5px rgba\(0, 0, 0, \.7\)[^}]*var\(--ph-rgb\)/.test(keyP('\\.open > \\.bb-grp')), 'an open dock key is pushed in and lit (the .open state stays visible on the new body)');
A.ok(!/#bottombar [^{]*\.bb-grp[^{]*\{/.test(cssP.replace(/#bottombar#bottombar/g, '')), 'no dock key rule in the perfected pass falls back to a single dock id');
A.ok(/:is\(#topbar, #bottombar\) \.widget-rail \.wg-add \{[^}]*width: 30px; min-width: 30px; height: 30px;[^}]*radial-gradient\(circle at 38% 28%, #f4f7fa/.test(cssP),
  'both + keys are the same round silver knob');
A.ok(/\.wg-add::before \{[^}]*12px 2px no-repeat[^}]*2px 12px no-repeat/.test(cssP), 'the plus is drawn on whole pixels (2px arms in a 12px box on a 30px knob)');
A.ok(/:not\(\.vx-b\) #logo \{ filter: none; \}/.test(cssP) && /:not\(\.vx-b\) #logo::before \{ content: none; \}/.test(cssP),
  'the mark is the clean logo: no glow and no digit field');
A.ok(/:not\(\.vx-b\) #logo \.logo-img \{ background: var\(--ph\); \}/.test(cssP) && !/:not\(\.vx-b\) #logo \.logo-img \{[^}]*(?:--vx-core|#fff|255, 255, 255)/.test(cssP),
  'the mark is painted in the theme colour itself, never the pale core tint or white (Andrew 11-10: “its just white. it should be the color of the theme”)');
A.ok(/#topbar::before \{ content: none; \}/.test(cssP) && /#topbar > #logo-anchor::before \{[^}]*content: ''[^}]*left: -18px; right: -18px;/.test(cssP),
  'the brand well is drawn on the mark\'s own anchor, so the mark stays centred in it at either logo size (style.css shrinks the mark on narrow windows)');
A.ok(!/#logo::before \{[^}]*content: ''/.test(cssP), 'the well is never drawn on #logo itself (logoclip.js clips that box)');
A.ok(/#left > h3 \.crew-hide \{[^}]*font-size: 0/.test(cssP) && /#crew-search-close \{[^}]*font-size: 0/.test(cssP),
  'find, fold and the finder\'s close knob draw ONE icon each: the fallback glyph under pipglass\'s pixel-map icon is off');
A.ok(/#crew-sum \.pos::after \{ content: none; \}/.test(cssP) && /#crew-sum \.dim::before \{ content: '·'/.test(cssP),
  'the crew readout\'s separator belongs to the idle count, so the working count never trails a loose dot when the idle count sheds');
A.ok(/#left > h3 #crew-sum \{[^}]*min-width: min-content/.test(cssP), 'the crew readout sheds whole counts on a narrow rail, never half a word');
A.ok(/:is\(#topbar, #bottombar\) \{ --vx-rivet: none; \}/.test(cssP), 'the rails carry no end rivets under the wells');

// ---- the fit pass (Andrew 2026-11-09: "if its small it will glitch out for users", "there is no + or new session button, it
// is literally completely missing", the CREW and COMMS bars "feel a bit off ... adjusting to be made to make it fit better",
// the seam between the world and COMMS "cuts off the oval shapes entirely") ----
const selsF = selsOf(cssF);
A.ok(selsF.length > 20, 'the fit pass is its own section (' + selsF.length + ' selectors)');
A.eq(selsF.filter(x => !x.startsWith('html body.vx:not(.hud-mode):not(.vx-b)')).join(' | '), '', 'every selector in the fit pass is scoped :not(.vx-b), inside its container queries too');
A.eq(stray(cssF, ':not(.vx-b)').join(' | '), '', 'no fit-pass selector slips its scope inside a one-line list');
// small windows: a clipped housing is no scroll container, so as a grid item it must be told it may shrink, or the rail
// holds the middle row open at a large TEXT SIZE and pushes the dock off the bottom of the window
A.ok(/#screen-game :is\(#left, #chat-panel\) \{ overflow: clip; overflow-clip-margin: 6px; min-height: 0; \}/.test(css),
  'a clipped housing may shrink (min-height 0): the dock never leaves the window at a large TEXT SIZE');
A.ok(/#left \{ container: vx-rail \/ inline-size; \}/.test(cssF) && /#chat-panel \{ container: vx-comms \/ inline-size; \}/.test(cssF),
  'each panel is its own size container: its narrow dress follows the panel, never the window');
A.ok(/:is\(#left, #chat-panel\) \{ --vx-gut: 15px; --vx-gut-u: calc\(15px \/ var\(--sn-unzoom, 1\)\); \}/.test(cssF),
  'one gutter for every block in a housing, with its counter-zoomed twin for the heads and the tab strip');
A.ok(/:is\(#left, #chat-panel\) > h3 \{\s*margin: calc\(12px \/ var\(--sn-unzoom, 1\)\) var\(--vx-gut-u\) 6px;/.test(cssF), 'the CREW and COMMS plates sit on that gutter');
A.ok(/#chat-panel :is\(#chat-log, #chat-inputrow\) \{ margin-left: var\(--vx-gut\); margin-right: var\(--vx-gut\); \}/.test(cssF), 'the transcript and the composer sit on it too');
// the rail head: both tabs whole on any rail
const tabF = (cssF.match(/\.ws-view > \.ws-tab \{[^}]*\}/) || [''])[0];
A.ok(/flex: 1 1 0; min-width: 0;/.test(tabF) && /\.ws-head \.ws-view \{ flex: 1 1 0; min-width: 0;/.test(cssF), 'SESSIONS and PROJECTS split one seat that spans the rail');
A.ok(/font-size: 14px; letter-spacing: 0;\s*font-size: clamp\(13px, calc\(\(50cqw - /.test(tabF),
  'the tab type follows the strip’s own width (cq units), after a plain size for an engine without them');
A.ok(/\.ws-head \.ws-view::after \{ content: none; \}/.test(cssF), 'pipglass’s flex filler is off, or it takes a third of the seat from the tabs');
A.ok(/\.ws-view > \.ws-tab\.on:is\(:hover, :focus-visible\) \{[^}]*var\(--vx-cap-on\)/.test(cssF), 'the chosen tab stays lit under the pointer (.on stays visible)');
// the + key
A.ok(/id="ws-new"/.test(html) && /id="ws-addproject"/.test(html), 'the rail’s two add keys are in the page');
const keyF = (cssF.match(/:is\(#ws-new, #ws-addproject\):not\(\[hidden\]\) \{[^}]*\}/) || [''])[0];
A.ok(/display: inline-grid !important;[^}]*width: 28px; min-width: 28px; height: 28px;[^}]*border-radius: 50%;[^}]*var\(--vx-knob\)/.test(keyF),
  'the rail has its + key back: a round silver knob on SESSIONS (+ NEW) and PROJECTS (+ ADD)');
A.ok(!/#ws-(new|addproject)(?![^{]*:not\(\[hidden\]\))[^{]*\{[^}]*display:/.test(cssF), 'a key the app hides stays hidden: no fit rule shows one without :not([hidden])');
A.ok(/\.ws-head \.ws-head-acts \{\s*display: inline-flex !important;/.test(cssF), 'the key’s seat shows on SESSIONS too (section 20 folded it with the dropped + NEW)');
A.ok(/:is\(#ws-new, #ws-addproject\)::before \{[^}]*12px 2px no-repeat[^}]*2px 12px no-repeat/.test(cssF), 'its plus is drawn on whole pixels, the same as the bars’ + keys');
// the seams
A.ok(/#chat-panel \{ overflow: visible; clip-path: inset\(-6px -6px -6px -30px\); \}/.test(cssF),
  'COMMS clips by a path that is open on the seam’s side: #comms-resizer lives inside the panel, and the 6px clip margin cut its clamps in half');
A.ok(/:is\(\.crew-resizer, \.col-resizer\)::before \{ width: 30px; margin-left: -15px; background-size: 30px 15px; \}/.test(cssF), 'the clamps run bezel to bezel on both seams');
// a narrow panel
A.ok(/@container vx-rail \(max-width: 190px\) \{[^@]*#crew \.crew-room \{ display: none; \}/.test(cssF) && /@container vx-rail \(max-width: 165px\)/.test(cssF) && /@container vx-comms \(max-width: 260px\)/.test(cssF),
  'a narrow panel runs compact: the crew card sheds its room before it cuts a name');
A.ok(/@container vx-rail \(max-width: 165px\) \{[^@]*\.ws-rail-search label:has\(> #ws-search:placeholder-shown\)::after \{ content: 'search'; \}/.test(cssF),
  'the empty finder never runs out mid-letter: under 165 its short line is one word');
// the stock 200px rail (every window 861 to 1440 wide) left the crew name 87px, one short of a ten-letter name in VT323
A.ok(/@container vx-rail \(max-width: 215px\) \{\s*html body\.vx:not\(\.hud-mode\):not\(\.vx-b\) #screen-game #left #crew \.crew-row \{ gap: 8px; \}\s*\}/.test(cssF),
  'the stock 200px rail keeps a ten-letter crew name whole: the card closes its gap from 215 down');
A.ok(!/\bfilter:/.test(cssF) && !/\[class/.test(cssF), 'the fit pass adds no filter and no [class] selector');

// ---- the heads (Andrew 2026-11-09: "make the crew and comms top look better, just looks a bit off. needs improvements").
// They were flat pale plates on a dark panel. Each is now built like the dock: a black bay behind a chrome lip, the panel's
// name on a domed chrome key that carries the lamp, the live readout as lit type on the black, the crew knobs as chrome domes ----
const selsH = selsOf(cssH);
A.ok(selsH.length > 15, 'the heads are their own section (' + selsH.length + ' selectors)');
A.eq(selsH.filter(x => !x.startsWith('html body.vx:not(.hud-mode):not(.vx-b)')).join(' | '), '', 'every selector in the heads pass is scoped :not(.vx-b), inside its container query too');
A.eq(stray(cssH, ':not(.vx-b)').join(' | '), '', 'no heads selector slips its scope inside a one-line list');
const ruleH = (tail) => (cssH.match(new RegExp('html body\\.vx:not\\(\\.hud-mode\\):not\\(\\.vx-b\\) #screen-game ' + tail + ' \\{[^}]*\\}')) || [''])[0];
// the bay
const bayH = ruleH(':is\\(#left, #chat-panel\\) > h3');
A.ok(/height: 42px;[^}]*border-radius: 21px;/.test(bayH) && /#05070a 0, #0d1116 60%, #161b21 100%/.test(bayH) && /0 0 0 2px #c4ccd5, 0 1px 0 2px #eef2f6/.test(bayH),
  'each head is the dock’s black bay behind its chrome lip, with capsule ends (21px on a 42px bay)');
A.ok(/isolation: isolate;/.test(bayH), 'the bay is its own stacking context: the key drawn behind the name (z-index -1) stays in front of the bay’s black');
A.ok(/filter: brightness\(calc\(1 - var\(--vx-dim, 0\) \* \.35\)\)/.test(bayH),
  'the dark knob takes the heads down with the dock and the composer (.35): .22 left them the brightest thing in a dim panel');
// the name key and its lamp
const DOME = /border-radius: 17px 9px 9px 17px;[^}]*#f4f7fa 0, #e9edf1 26%, #c3cad2 50%, #8f98a3 74%, #6b747f 100%[^}]*0 0 0 1px #050608, 0 2px 3px rgba\(0, 0, 0, \.7\)/;
const domeH = (cssH.match(/> h3::after,\s*html body\.vx:not\(\.hud-mode\):not\(\.vx-b\) #screen-game #chat-panel > h3 #comms-title:not\(:has\(> \.comms-session\)\) \{[^}]*\}/) || [''])[0];
A.ok(DOME.test(domeH), 'the name sits on the dock key’s chrome dome, and a COMMS title with no session beside it wears the same dome');
const keyH = ruleH(':is\\(#left, #chat-panel\\) > h3::after');
A.ok(/content: ''; display: block; position: absolute; z-index: -1;/.test(keyH) && /width: calc\(4ch \+ 51px\);/.test(keyH) && /#chat-panel > h3::after \{ width: calc\(5ch \+ 54px\); \}/.test(cssH),
  'the key is drawn behind the name by the head’s own ::after and sized to the word (CREW four glyphs, COMMS five)');
A.ok(/#chat-panel > h3:not\(:has\(\.comms-session\)\)::after \{ content: none; \}/.test(cssH)
  && /#comms-title:not\(:has\(> \.comms-session\)\) \{\s*display: block;[^}]*text-overflow: ellipsis;/.test(cssH),
  'a bare COMMS title (no session yet, or a project’s own name) is the whole key and never wears two: a long project name ends in an ellipsis');
const lampH = ruleH(':is\\(#left, #chat-panel\\) > h3::before');
A.ok(/width: 10px; height: 10px;[^}]*border-radius: 50%;/.test(lampH) && /var\(--ph\) 48%/.test(lampH) && /0 0 7px 1px rgba\(var\(--ph-rgb\), \.7\)/.test(lampH),
  'the panel lamp is a lit jewel in the station’s hue, set into the key');
// the readouts
const readH = ruleH(':is\\(#left, #chat-panel\\) > h3 :is\\(#crew-sum, \\.comms-session\\)');
A.ok(/padding: 0; border-radius: 0; background: none; box-shadow: none;/.test(readH) && /text-shadow: 0 0 7px rgba\(var\(--ph-rgb\), \.75\)/.test(readH),
  'the readouts are lit type on the black, not pills (named through :is(#crew-sum, .comms-session), or section 21’s id inside :is() out-ranks them)');
A.ok(/#left > h3 \{ padding-right: 76px; justify-content: flex-start; \}/.test(cssH) && /#left > h3 #crew-sum \{ justify-content: flex-start; \}/.test(cssH),
  'the crew counts start beside the key and the bay keeps the knobs’ room, so the counts still shed whole');
A.ok(/#chat-panel > h3 :is\(#crew-sum, \.comms-session\) \{[^}]*overflow: hidden; text-overflow: ellipsis; white-space: nowrap;\s*text-indent: calc\(-2ch - 3px\);/.test(cssH),
  'the session name reads beside the COMMS key: a long one ends in an ellipsis, and the lead dot chat.js writes is drawn out of its box');
// the knobs
const knobH = ruleH('#left > h3 \\.crew-hide');
A.ok(/width: 28px; height: 28px; background: var\(--vx-knob\);/.test(knobH) && /0 0 0 1px #050608, 0 2px 4px rgba\(0, 0, 0, \.7\)/.test(knobH) && /\.crew-h3-right \{ right: 7px; height: 28px;/.test(cssH),
  'find and fold are the add knob’s chrome dome, concentric with the bay’s end (28px in 42px, 7px all round)');
A.ok(/\.crew-hide:is\(:hover, :focus-visible\) \{ background: var\(--vx-knob-hot\);/.test(cssH), 'a hovered or focused knob is the hot chrome of every other knob');
A.ok(/#crew-search-toggle\[aria-expanded="true"\] \{[^}]*var\(--ph\) 60%[^}]*0 0 10px 2px rgba\(var\(--ph-rgb\), \.55\)/.test(cssH), 'an open finder lights its knob (the open state stays visible on the new dome)');
// a narrow rail
A.ok(/@container vx-rail \(max-width: 165px\) \{[^@]*#left > h3 \{ padding-left: 31px; \}[^@]*#left > h3::before \{ left: 13px; \}[^@]*#left > h3::after \{ width: calc\(4ch \+ 45px\); \}/.test(cssH),
  'on a stock rail at a large TEXT SIZE the CREW key closes its lead and its tail: the knobs keep their own room');
A.eq((cssH.match(/\bfilter:/g) || []).length, 1, 'the heads pass has one filter, the dark knob on the heads themselves');
A.ok(!/#stage-wrap/.test(cssH) && !/\[class/.test(cssH), 'the heads pass styles nothing under #stage-wrap and adds no [class] selector');

// ---- the panels (Andrew 2026-11-09: "then we need to start to update every single menu panel within starnet completely").
// A window wore chrome on its bezel and flat parts inside. Every window now opens with the heads' black bay and name key, every
// tab row is a key bar or a keypad, every panel key is a glossy cap, and the dock menus are black bays in a chrome lip ----
const selsN = selsOf(cssN);
A.ok(selsN.length > 25, 'the panels are their own section (' + selsN.length + ' selectors)');
A.eq(selsN.filter(x => !x.startsWith('html body.vx:not(.hud-mode):not(.vx-b) #screen-game ')).join(' | '), '', 'every selector in the panels pass is scoped :not(.vx-b) and lives on the station screen');
A.eq(stray(cssN, ':not(.vx-b)').join(' | '), '', 'no panels selector slips its scope inside a one-line list');
A.eq(selsN.filter(x => !/ #screen-game (#terms \.term:not\(\.pw\)|#bottombar \.bb-menu)/.test(x)).join(' | '), '',
  'the pass dresses station windows and the dock menus, nothing else (a pre-station screen and the plain window stay as they are)');
const W = 'html body\\.vx:not\\(\\.hud-mode\\):not\\(\\.vx-b\\) #screen-game #terms \\.term:not\\(\\.pw\\)';
const ruleN = (tail) => (cssN.match(new RegExp(W + tail + ' \\{[^}]*\\}')) || [''])[0];
// the window head
const headN = ruleN(' \\.term-head');
A.ok(/#05070a 0, #0d1116 60%, #161b21 100%/.test(headN) && /inset 0 -2px 0 #eef2f6, inset 0 -3px 0 #c4ccd5/.test(headN) && /border-bottom: 0;/.test(headN),
  'a window opens with the heads’ black bay, closed by the chrome lip (no flat title strip, no hairline under it)');
A.ok(new RegExp(W + ' \\.term-head::after \\{ content: none; \\}').test(cssN), 'the old title strip’s own rule line is off: the lip is the only line under the head');
const nameN = ruleN(' \\.term-head \\.term-title');
A.ok(/border-radius: 14px 7px 7px 14px;[^}]*#f4f7fa 0, #e9edf1 26%, #c3cad2 50%, #8f98a3 74%, #6b747f 100%[^}]*0 0 0 1px #050608, 0 2px 3px rgba\(0, 0, 0, \.7\)/.test(nameN),
  'the window’s name is engraved on the heads’ domed chrome key');
A.ok(/flex: 0 1 auto; min-width: 0; margin-right: auto;/.test(nameN) && /overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/.test(nameN),
  'the name key is as long as its word and gives way in a narrow window (an ellipsis, never a wrapped or clipped name)');
const lampN = ruleN(' \\.term-head \\.term-title::before');
A.ok(/width: 10px; height: 10px;[^}]*border-radius: 50%;/.test(lampN) && /var\(--ph\) 48%/.test(lampN) && /0 0 7px 1px rgba\(var\(--ph-rgb\), \.7\)/.test(lampN),
  'the name key carries the panel lamp in the station’s hue');
const wkeyN = ruleN(' \\.term-head :is\\(\\.gd-window-button, \\.term-x\\)');
A.ok(/width: 28px; min-width: 28px; height: 28px;/.test(wkeyN) && /background: var\(--vx-knob\);/.test(wkeyN) && /0 0 0 1px #050608, 0 2px 4px rgba\(0, 0, 0, \.7\)/.test(wkeyN),
  'minimise, maximise and close are the chrome dome of every other knob (28px, the CREW knobs’ size)');
A.ok(/\.term-head :is\(\.gd-window-button, \.term-x\):is\(:hover, :focus-visible\) \{\s*background: var\(--vx-knob-hot\);/.test(cssN), 'a hovered or focused window key is the hot chrome');
// the dossier and recruit tabs
const seatN = ruleN(' :is\\(\\.con-toptabs, \\.mkt-recipe-detail-tabs\\)');
A.ok(/border-radius: 21px !important;/.test(seatN) && /background: var\(--vx-seat\) !important; box-shadow: var\(--vx-seat-shadow\) !important;/.test(seatN),
  'the dossier tabs and the recruit detail tabs sit in a chrome seat (21px = a pill at one 42px row)');
A.ok(/flex-wrap: wrap;/.test(seatN), 'those tabs wrap to a second row in a small window (two of the five dossier tabs ran off the window’s edge)');
const TABS = ' :is\\(\\.con-toptabs > \\.con-toptab, \\.mkt-recipe-detail-tabs > button\\)';
const capN = ruleN(TABS);
A.ok(/height: 34px;/.test(capN) && /background: var\(--vx-cap\) !important; box-shadow: var\(--vx-cap-shadow\) !important;/.test(capN) && /color: var\(--vx-core\) !important;/.test(capN),
  'each of those tabs is a glossy cap with a lit legend');
const onN = ruleN(TABS + ':is\\(\\.active, \\.on, \\[aria-selected="true"\\], \\[aria-pressed="true"\\]\\)');
A.ok(/background: var\(--vx-cap-on\) !important;/.test(onN) && /color: #020604 !important;/.test(onN), 'the chosen tab is the pressed, lit cap with dark ink (the open tab stays visible)');
A.ok(new RegExp(W + TABS + ':is\\(:hover, :focus-visible\\) \\{\\s*background: var\\(--vx-cap-hot\\) !important;').test(cssN), 'a hovered or focused tab is the hot cap (keyboard focus stays visible)');
// the dock menus
const D = 'html body\\.vx:not\\(\\.hud-mode\\):not\\(\\.vx-b\\) #screen-game #bottombar \\.bb-menu';
const menuN = (cssN.match(new RegExp(D + ' \\{[^}]*\\}')) || [''])[0];
A.ok(/#05070a 0, #0d1116 60%, #161b21 100%/.test(menuN) && /0 0 0 2px #c4ccd5, 0 1px 0 2px #eef2f6, 0 0 0 3px #2a3037/.test(menuN) && /border-radius: 18px !important;/.test(menuN),
  'a dock menu is a black bay in the dock’s chrome lip');
A.ok(new RegExp(D + '::before,\\s*' + D + '::after \\{ content: none; \\}').test(cssN), 'the dock menu’s old frame pieces are off');
A.ok(new RegExp(D + ' \\.bb \\.bb-i \\{[^}]*background: var\\(--vx-well\\); box-shadow: var\\(--vx-well-shadow\\);').test(cssN), 'a menu row’s icon sits in a glass well');
// every panel key
const KEYS = ' :is\\(\\.bb, \\.settings-jumps > button, \\.consent-btn, \\.cd-addbtn, \\.cd-starter, \\.cf-nav-b, \\.fm-action, \\.q-dismiss, \\.apps-btn, \\.mkt-cta-alt, \\.mkt-lane, \\.cc-filter, \\.q-filter\\)';
const pkeyN = ruleN(KEYS);
A.ok(/background: var\(--vx-cap\) border-box !important; box-shadow: var\(--vx-cap-shadow\) !important;/.test(pkeyN), 'every panel key is the glossy cap (no flat or outlined button is left in a window)');
A.ok(new RegExp(W + KEYS + ':not\\(:is\\(\\.danger, \\.deny\\)\\) \\{\\s*color: var\\(--vx-core\\) !important;').test(cssN),
  'a key’s legend is lit in the station’s hue, and a danger or deny key keeps its own warning ink');
A.ok(new RegExp(W + KEYS + ':is\\(:hover, :focus-visible\\):not\\(:disabled\\) \\{\\s*background: var\\(--vx-cap-hot\\) border-box !important;').test(cssN),
  'a hovered or focused key is the hot cap, and a disabled key does not answer the pointer');
const LIT = ' :is\\(\\.bb:is\\(\\.active, \\.sel, \\.on, \\[aria-pressed="true"\\]\\), \\.mkt-lane\\.on, \\.cc-filter\\.active, \\.q-filter:is\\(\\.on, \\.active, \\[aria-pressed="true"\\]\\), \\.mkt-cta-main, \\.apps-btn\\.primary, \\.bb\\.refit-primary, \\.q-go, \\.cd-interview\\):not\\(:disabled\\)';
const litN = ruleN(LIT);
A.ok(/background: var\(--vx-cap-on\) border-box !important; box-shadow: var\(--vx-cap-on-shadow\) !important;/.test(litN) && /color: #020604 !important; text-shadow: none !important;/.test(litN),
  'the chosen key and the one key a panel wants pressed are the lit cap with dark ink; a disabled key is never lit');
A.ok(new RegExp(W + LIT + ' \\* \\{ color: inherit !important; text-shadow: none !important; \\}').test(cssN), 'an icon or a count inside a lit key takes the dark ink too (never lit type on a lit cap)');
// the keypads
const padN = ruleN(' \\.settings-jumps');
A.ok(/width: fit-content; max-width: 100%; border-radius: 12px !important;/.test(padN) && /background: var\(--vx-seat\); box-shadow: var\(--vx-seat-shadow\);/.test(padN),
  'the settings jumps are a keypad in a square-shouldered seat no wider than its keys');
A.ok(new RegExp(W + ' \\.settings-jumps > button \\{ flex: 1 1 auto; border-radius: 7px !important; \\}').test(cssN), 'a wrapped row of settings keys fills its row (no bare chrome slab beside a short row)');
A.ok(new RegExp(W + ' \\.fm-tabs \\{ border-radius: 12px !important; \\}').test(cssN)
  && new RegExp(W + ' \\.fm-tabs > \\.fm-tab:is\\(\\*, :first-child, :last-child\\) \\{ border-radius: 7px !important; \\}').test(cssN),
  'the manual’s chapters are the same keypad: its grid runs 2, 4 or 8 across, and a pill seat cut its corner keys off');
// the fit
A.ok(new RegExp(W + ' \\.fm-tabs > \\.fm-tab \\{ padding-inline: 4px; letter-spacing: 1px; \\}').test(cssN), 'the manual’s longest chapter name is whole on its key');
A.ok(new RegExp(W + ':is\\(\\.tasks-win, \\.dlv-win, \\.wfw-win\\) \\.term-body \\{ padding-left: 16px; padding-right: 8px; \\}').test(cssN),
  'the three work sheets get the gutter every other window has (their text ran against the bezel)');
A.ok(new RegExp(W + ' \\.quests-content \\.q-view-tabs::before \\{ background: color-mix\\(in srgb, var\\(--ph\\) 13%, #02060a\\); \\}').test(cssN),
  'the band the quest tabs stick on is the window’s own glass (no black strip over the page)');
A.ok(new RegExp(W + ' \\.empty-state > span \\{ margin-inline: auto; \\}').test(cssN), 'an empty state’s sentence sits under its headline');
A.ok(!/con-rail-top/.test(css), 'AUTOMATE has no rail note any more (one screen per tab, 2026-11-11), so nothing is left fitting one');
// what the pass must never do
A.ok(!/[;{\s]filter:\s/.test(cssN) && !/#stage-wrap/.test(cssN) && !/\[class/.test(cssN), 'the panels pass declares no filter, styles nothing under #stage-wrap and adds no [class] selector');
A.ok(!/@/.test(cssN), 'the panels pass has no at-rule: a panel that wraps is dressed to wrap at any width');
A.eq((cssN.match(/content:[^;}]*/g) || []).filter(x => x !== "content: ''" && x !== 'content: none').join(' | '), '',
  'the panels pass writes no words: it adds no legend, label or control');
A.ok(!/background(-image)?:[^;]*url\(/.test(cssN) && !/repeating-/.test(cssN), 'the screens stay plain glass: the pass draws no crest, trace or grid');

// ---- the insides (Andrew 2026-11-09: "update every single menu panel within starnet completely", then "Yes, insides next").
// Section 28 dressed each window's head, tabs and keys. Inside, every card is now one pane of the same glass, every readout one
// recess, every tile one slot whose pick is a hard ring and a lit leading edge, every field one well, every switch a well track
// under a chrome knob. The pass is paint: it moves nothing, adds nothing, a restyled control keeps every state it had, and the
// words on a tile stay readable (a bright fill under dim words measured 1.5:1 on a chosen tile, so no tile ground is one) ----
const PFX = 'html body.vx:not(.hud-mode):not(.vx-b) #screen-game #terms .term:not(.pw)';
const selsI = selsOf(cssI);
A.ok(selsI.length > 30, 'the insides are their own section (' + selsI.length + ' selectors)');
A.eq(selsI.filter(x => x !== PFX && !x.startsWith(PFX + ' ')).join(' | '), '',
  'every selector in the insides pass opens with the window prefix: station windows only, VECTOR only, never the plain window');
A.eq(stray(cssI, ':not(.vx-b)').join(' | '), '', 'no insides selector slips its scope inside a one-line list');
const ruleI = (tail) => (cssI.match(new RegExp(W + tail + ' \\{[^}]*\\}')) || [''])[0];
const rulesI = cssI.split('}').filter(r => r.includes('{')).map(r => ({ sel: r.slice(0, r.indexOf('{')).split(PFX).join('').trim(), body: r.slice(r.indexOf('{') + 1).replace(/\s+/g, ' ').trim() }));
const ruleBy = (needle) => rulesI.find(r => r.body.includes(needle)) || { sel: '', body: '' };
const named = (sel) => (sel.match(/\.[a-z][\w-]*/g) || []).map(x => x.slice(1)).sort().join(' ');
// the parts
const partsI = ruleI('');
A.ok(/--vx-pane:\s*linear-gradient\(180deg, rgba\(255, 255, 255, \.055\) 0, rgba\(255, 255, 255, 0\) 26px\),\s*linear-gradient\(180deg, rgba\(var\(--ph-rgb\), \.1\) 0, rgba\(var\(--ph-rgb\), \.03\) 100%\),\s*rgba\(0, 3, 1, \.58\);/.test(partsI)
  && /--vx-pane-shadow: inset 0 1px 0 rgba\(255, 255, 255, \.12\)[^;]*0 0 0 1px rgba\(0, 0, 0, \.66\), 0 3px 9px rgba\(0, 0, 0, \.42\);/.test(partsI),
  'a pane is glass with a top light and a wash of the station’s hue, seated on a dark line');
A.ok(/--vx-read-shadow: inset 0 2px 6px rgba\(0, 0, 0, \.95\), inset 0 0 0 1px rgba\(0, 0, 0, \.7\)/.test(partsI), 'a readout is recessed: its first shadow falls inward');
A.ok(/--vx-tile-shadow: inset 0 1px 0 rgba\(255, 255, 255, \.16\)[^;]*0 0 0 1px rgba\(0, 0, 0, \.66\)/.test(partsI), 'a tile is lifted: a top light over a dark seat');
// a tile's three grounds: [top light, hue at the top, hue above the fold, hue below the fold, hue at the foot], each over the dark base
const groundI = (name) => { const m = partsI.match(new RegExp('--vx-' + name + ':\\s*linear-gradient\\(180deg, rgba\\(255, 255, 255, (\\.\\d+)\\), transparent 40%\\),\\s*'
  + 'linear-gradient\\(180deg, rgba\\(var\\(--ph-rgb\\), (\\.\\d+)\\), rgba\\(var\\(--ph-rgb\\), (\\.\\d+)\\) 50%, rgba\\(var\\(--ph-rgb\\), (\\.\\d+)\\) 51%, rgba\\(var\\(--ph-rgb\\), (\\.\\d+)\\)\\),\\s*rgba\\(0, 3, 1, \\.5\\);')); return m ? m.slice(1).map(Number) : null; };
const gTile = groundI('tile'), gHot = groundI('tile-hot'), gPick = groundI('pick');
A.eq(JSON.stringify(gTile), '[0.05,0.13,0.06,0.03,0.09]', 'a tile is quiet glass over a dark base: it carries words, so it is dimmer than a list slot and never a bare tint');
A.eq(JSON.stringify(gHot), '[0.09,0.26,0.12,0.07,0.16]', 'a tile under the pointer is the same glass a notch brighter, still over the dark base');
A.eq(JSON.stringify(gPick), '[0.08,0.18,0.08,0.045,0.12]', 'a chosen tile keeps dark glass over the dark base');
A.ok(gTile && gHot && gPick && gPick.every((v, i) => v <= gHot[i] && v >= gTile[i]),
  'the chosen ground is never brighter than a hover: the pick is carried by its ring and edge, so its words stay as readable as its neighbours’');
A.ok(/--vx-pick-shadow: inset 3px 0 0 rgba\(var\(--ph-rgb\), \.95\), inset 0 1px 0 rgba\(255, 255, 255, \.3\), [^;]*0 0 0 1px rgba\(var\(--ph-rgb\), \.85\), 0 2px 5px rgba\(0, 0, 0, \.45\);/.test(partsI),
  'the pick is a lit leading edge listed FIRST (so it paints on top) inside a hard ring of the hue: a pick never reads as a hover');
A.ok(!/--vx-band/.test(cssI), 'the bright band is gone: nothing in a window lays a half-strength fill under words');
A.ok(!/var\(--vx-slot(-hot)?\)/.test(cssI), 'nothing inside a window wears the list slot’s bright glass: it has no dark base, so dim words on it lose a full step of contrast (tiles, trophies and provider cards take --vx-tile)');
// panes
const paneI = ruleBy('background: var(--vx-pane);');
A.eq(named(paneI.sel), ['ag-hero', 'ag-mission', 'ag-growth-hero', 'ag-achievements', 'ag-reflection-panel', 'ag-next-challenge', 'cf-group', 'cd-sec', 'cd-overview', 'cd-brief', 'cd-record',
  'q-return-card', 'q-life-goal', 'q-commander-growth', 'q-evolution', 'q-track', 'q-progress-section', 'q-refresh-options', 'q-metric-editor', 'q-card',
  'cc-card', 'kb-col', 'fm-route', 'fm-mission', 'ob-stage', 'ob-row', 'ds-off', 'wh-source-settings', 'mc-row',
  'platform-guide', 'ch-preferences', 'ch-setup', 'ch-connection', 'ch-bots', 'perm-master', 'perm-glance', 'perm-agent', 'perm-fold', 'settings-group',
  'mkt-fam', 'mkt-dossier', 'mkt-roster'].sort().join(' '),
  'every card in every window is one pane: the dossier, the quests, the work sheets and the manual, connect and settings, the market');
A.ok(/border-radius: 10px !important;/.test(paneI.body) && /box-shadow: var\(--vx-pane-shadow\);/.test(paneI.body) && !/border(-color|-width|-style)?:/.test(paneI.body),
  'a pane is fill, shadow and a 10px corner only: a card keeps its own border colour, so a gold wait, a red failure edge or an armed row still says so');
// readouts
const readI = ruleBy('background: var(--vx-well); box-shadow: var(--vx-read-shadow);');
A.eq(named(readI.sel), ['perk', 'cf-card', 'cf', 'cf-body', 'cd-stat', 'cd-rec', 'cd-brief-text', 'stat-cell', 'ns-cell', 'ag-level-badge', 'ag-portrait-well', 'brief-block', 'up-mini',
  'bp-streak', 'bp-chal', 'q-journal-count', 'gx-well', 'gx-station',
  'fb-empty', 'dlv-head-strip', 'dlv-empty', 'empty-state', 'cc-filters', 'cc-details-body', 'ob-addr', 'fm-note', 'diag-pre',
  'key-row', 'key-mask', 'mkt-scoutlog', 'mkt-consent-strip', 'mkt-fam-consent'].sort().join(' '),
  'everything that only reports (a stat, a count, a key on file, an empty state) is one recessed readout');
A.eq(readI.body, 'background: var(--vx-well); box-shadow: var(--vx-read-shadow);', 'a readout is fill and shadow only: it keeps its own border and corner');
A.ok(new RegExp(W + ' \\.gx-tro\\.off:not\\(\\.q-card\\) \\{ background: var\\(--vx-well\\); box-shadow: var\\(--vx-read-shadow\\); \\}').test(cssI)
  && new RegExp(W + ' \\.gx-tro\\.on:not\\(\\.q-card\\) \\{ background: var\\(--vx-tile\\); box-shadow: var\\(--vx-tile-shadow\\); \\}').test(cssI),
  'a trophy not yet earned sits in a recess and an earned one on a lifted tile of quiet glass (earned stays visible, and its dim words stay readable: the bright list slot took them from 6.0:1 to 4.7:1); a quest card that is also a trophy stays a pane');
// tiles
const TILES = ' :is\\(\\.ag-item, \\.ag-setup-row, \\.ov-vchip, \\.pp-card, \\.set-theme:not\\(\\.settings-swatch\\), \\.skin-thumb, \\.ch-sum-row, \\.mkt-card, \\.mkt-rec, \\.mkt-build, \\.wfw-tile, \\.q-mission, \\.set-bd\\)';
const tileI = ruleI(TILES);
A.ok(/\{\s*background: var\(--vx-tile\);\s*box-shadow: var\(--vx-tile-shadow\);\s*\}/.test(tileI),
  'anything you press to choose is a glass tile, fill and shadow only (a colour swatch keeps its own colour, a tile its own border)');
A.ok(new RegExp(W + TILES + ':is\\(:hover, :focus-visible\\):not\\(:is\\(\\.sel, \\.selected, \\.on, \\[aria-pressed="true"\\], \\[disabled\\]\\)\\) \\{\\s*background: var\\(--vx-tile-hot\\);\\s*\\}').test(cssI),
  'a tile brightens under the pointer or the keyboard; a chosen or disabled tile does not answer');
A.ok(new RegExp(W + ' :is\\(\\.ag-item, \\.ov-vchip, \\.pp-card, \\.set-theme:not\\(\\.settings-swatch\\), \\.skin-thumb, \\.mkt-card, \\.q-mission, \\.set-bd\\):is\\(\\.sel, \\.selected, \\[aria-pressed="true"\\]\\),\\s*'
  + W + ' :is\\(\\.dlv-proj, \\.wfw-tile\\)\\.on \\{\\s*background: var\\(--vx-pick\\);\\s*box-shadow: var\\(--vx-pick-shadow\\);\\s*\\}').test(cssI),
  'the chosen tile wears the pick (its ring and lit edge over dark glass): a chosen tile never looks like its neighbours and never disappears under the tile');
// fields
const fieldI = ruleI(' input:is\\(\\[type="number"\\], \\[type="password"\\], \\[type="url"\\], \\[type="email"\\], \\[type="tel"\\], \\[type="date"\\], \\[type="time"\\]\\):not\\(\\[readonly\\]\\)');
A.ok(/background: var\(--vx-well\) !important;/.test(fieldI) && /box-shadow: var\(--vx-well-shadow\) !important;/.test(fieldI),
  'number, password, link, mail, phone, date and time fields are the glass well of a text field; a read-only field is not dressed as one you can type in');
const selI = ruleI(' select');
A.ok(/linear-gradient\(45deg, transparent 50%, var\(--vx-core\) 50%\) right 14px top 52% \/ 5px 5px no-repeat,\s*linear-gradient\(135deg, var\(--vx-core\) 50%, transparent 50%\) right 9px top 52% \/ 5px 5px no-repeat,\s*var\(--vx-well\) !important;/.test(selI)
  && /padding-right: 26px;/.test(selI) && /box-shadow: var\(--vx-well-shadow\) !important;/.test(selI),
  'every select is a well that draws its own chevron in the station’s hue and keeps room for it (the OS arrow cannot be themed)');
// switches
const HOSTS = ' :is\\(\\.set-row, \\.mkt, \\.skm-agree, \\.ch-optin, \\.settings-toggle-row, \\.sbs-agree\\) input\\[type="checkbox"\\]';
const PERS = ' input\\[data-persona-toggle\\]';
const swOff = (cssI.match(new RegExp(W + HOSTS + ',\\s*' + W + PERS + ',\\s*' + W + ' \\.sk-sw-track \\{[^}]*\\}')) || [''])[0];
A.ok(/box-shadow: inset 0 0 0 1px rgba\(var\(--ph-rgb\), \.62\), inset 0 2px 3px rgba\(0, 0, 0, \.9\)/.test(swOff) && /border-color: transparent !important;/.test(swOff),
  'every switch (the source’s own hosts, the persona switches, the skill switch) is a recessed track whose hue rim is the FIRST shadow, so an off switch still shows where it is');
const swOn = (cssI.match(new RegExp(W + HOSTS + ':checked,\\s*' + W + PERS + ':checked,\\s*' + W + ' \\.sk-switch\\.on \\.sk-sw-track \\{[^}]*\\}')) || [''])[0];
A.ok(/linear-gradient\(90deg, rgba\(var\(--ph-rgb\), \.9\), rgba\(var\(--ph-rgb\), \.55\)\) !important;/.test(swOn) && /0 0 8px rgba\(var\(--ph-rgb\), \.45\) !important;/.test(swOn),
  'ON floods the track with the hue and glows: on and off never look alike');
const swKnob = (cssI.match(new RegExp(W + HOSTS + '::after,\\s*' + W + PERS + '::after,\\s*' + W + ' \\.sk-sw-knob \\{[^}]*\\}')) || [''])[0];
A.ok(/border-radius: 50% !important;/.test(swKnob) && /background: var\(--vx-knob\) !important;/.test(swKnob) && /box-shadow: 0 0 0 1px #050608/.test(swKnob),
  'the switch knob is the round chrome dome of every other knob');
// faders
const FADER = ' \\.set-slider input\\[type="range"\\]';
A.ok(/box-shadow: inset 0 0 0 1px rgba\(var\(--ph-rgb\), \.62\), inset 0 2px 3px rgba\(0, 0, 0, \.9\), 0 1px 0 rgba\(255, 255, 255, \.2\) !important;/.test(ruleI(FADER))
  && new RegExp(W + FADER + ':not\\(\\.set-hue-track\\) \\{\\s*background: var\\(--vx-well\\) !important;\\s*\\}').test(cssI),
  'a fader’s track is a well under a rim of the hue listed FIRST (an empty fader still shows where it runs: the shared well shadow buried a .2 rim), and the hue fader keeps its spectrum');
const thumbI = ruleI(FADER + '::-webkit-slider-thumb'), thumbM = ruleI(FADER + '::-moz-range-thumb');
A.ok(/width: 14px; height: 22px; border: 0; border-radius: 4px !important;/.test(thumbI) && /linear-gradient\(90deg, transparent 0 6px, var\(--vx-core\) 6px 8px, transparent 8px\), var\(--vx-capsule\);/.test(thumbI)
  && /box-shadow: var\(--vx-capsule-shadow\);/.test(thumbI),
  'the fader thumb is a dark capsule with one lit line (a colour, never the --vx-lit gradient stack)');
A.ok(thumbM && thumbM.slice(thumbM.indexOf('{')) === thumbI.slice(thumbI.indexOf('{')), 'both engines draw the same thumb');
// settings
A.ok(new RegExp(W + ' \\.settings-group \\{ border-color: var\\(--vx-hair\\); \\}').test(cssI), 'a settings group is a pane on a hairline');
const provI = ruleI(' \\.prov-card');
A.ok(/border-radius: 10px !important; corner-shape: round;/.test(provI) && /background: var\(--vx-tile\);/.test(provI) && /box-shadow: var\(--vx-tile-shadow\);/.test(provI),
  'a provider card is a round-cornered tile (the older bevel is off)');
A.ok(new RegExp(W + ' \\.prov-card\\.conn \\{ border-color: var\\(--vx-line-mid\\); \\}').test(cssI)
  && new RegExp(W + ' \\.prov-card\\.expired \\{ border-color: var\\(--bad\\); \\}').test(cssI)
  && new RegExp(W + ' \\.prov-card\\.prov-landed \\{\\s*border-color: var\\(--vx-core\\);\\s*box-shadow: inset 0 0 0 1px rgba\\(var\\(--ph-bright-rgb\\), \\.45\\), var\\(--vx-tile-shadow\\);').test(cssI),
  'a provider card keeps every state the source gives it: connected on a brighter line, expired on the station’s red, the card an error door lands on ringed bright');
const foldI = ruleI(' \\.prov-fold > summary');
A.ok(/border-radius: 10px !important; corner-shape: round;/.test(foldI) && /border-color: var\(--vx-hair\);/.test(foldI) && /background: var\(--vx-tile\);/.test(foldI) && /box-shadow: var\(--vx-tile-shadow\);/.test(foldI)
  && new RegExp(W + ' \\.prov-fold > summary:is\\(:hover, :focus-visible\\) \\{\\s*border-color: var\\(--vx-line-mid\\);\\s*background: var\\(--vx-tile-hot\\);').test(cssI),
  'the strip that holds a group’s cards with nothing saved is one more tile in the column, lit a step under the pointer or the keyboard');
// the list down a window's left side
const railI = ruleI(' \\.con-rail');
A.ok(/color-mix\(in srgb, var\(--ph\) 7%, #000\), color-mix\(in srgb, var\(--ph\) 3%, #000\)/.test(railI) && /inset -1px 0 0 rgba\(0, 0, 0, \.8\), inset 0 2px 8px rgba\(0, 0, 0, \.7\)/.test(railI),
  'the list down a window’s left side is one dark display, like the session list');
// what the pass must never do
A.eq([...new Set((cssI.match(/[{;]\s*-{0,2}[a-z][a-z-]*(?=:)/g) || []).map(x => x.replace(/^[{;]\s*/, '')))].filter(x => !x.startsWith('--vx-')).sort().join(' '),
  'background border border-color border-radius box-shadow corner-shape height padding-right width',
  'the insides pass is paint: its only box metrics are the fader thumb’s size and the room a select keeps for its chevron, so nothing in a window moves');
A.ok(!/[;{\s]filter:\s/.test(cssI) && !/#stage-wrap/.test(cssI) && !/\[class/.test(cssI), 'the insides pass declares no filter, styles nothing under #stage-wrap and adds no [class] selector');
A.ok(!/@/.test(cssI), 'the insides pass has no at-rule');
A.ok(!/content:/.test(cssI), 'the insides pass writes no words and draws no extra part: no legend, label or control');
A.ok(!/url\(/.test(cssI) && !/repeating-/.test(cssI), 'the insides stay plain glass: the pass draws no crest, trace, scan line or grid');
// ---- 30 · THE CARDS (Andrew 2026-11-10: "Yes, finish them"). The cards COMMS shows inside a conversation join the windows: a card
// is a pane, a command key a cap, the one key a card wants pressed the lit cap, an answer you choose a tile whose pick is the ring,
// what a card only shows a recess, what you type into a well. The conversation is not touched: speech has no box, the nudge stays
// an aside, a question stays ONE frame. Paint only ----
const CPFX = 'html body.vx:not(.hud-mode):not(.vx-b) #screen-game #chat-panel';
const selsC = selsOf(cssC);
A.ok(selsC.length > 15, 'the cards are their own section (' + selsC.length + ' selectors)');
A.eq(selsC.filter(x => x !== CPFX && !x.startsWith(CPFX + ' ')).join(' | '), '',
  'every selector in the cards pass opens with the COMMS prefix: COMMS only, VECTOR only, never variation B');
A.eq(stray(cssC, ':not(.vx-b)').join(' | '), '', 'no cards selector slips its scope inside a one-line list');
const rulesC = cssC.split('}').filter(r => r.includes('{')).map(r => ({ sel: r.slice(0, r.indexOf('{')).split(CPFX).join('').replace(/\s+/g, ' ').trim(), body: r.slice(r.indexOf('{') + 1).replace(/\s+/g, ' ').trim() }));
const atC = (sel) => rulesC.findIndex(r => r.sel === sel);
const ruleC = (sel) => (rulesC[atC(sel)] || { body: '' }).body;
// the materials
const partsOf = (t) => (t.match(/--vx-[a-z-]+:[^;]*;/g) || []).map(x => x.replace(/\s+/g, ' '));
A.eq(partsOf(ruleC('')).map(x => x.slice(0, x.indexOf(':'))).join(' '), '--vx-pane --vx-pane-shadow --vx-read-shadow --vx-tile-shadow --vx-tile --vx-tile-hot --vx-pick --vx-pick-shadow',
  'COMMS names the eight materials of a window’s insides on itself (section 29 names them on a station window, which COMMS is not)');
A.eq(partsOf(ruleC('')).join('\n'), partsOf(partsI).join('\n'), 'and they are section 29’s, word for word: a card in COMMS and a card in a window are the same glass');
// the conversation is not a card
const speechBodies = strip(rawCss).split('}').filter(r => /\.cmsg[^{]*> \.body\s*\{/.test(r));
A.ok(speechBodies.length === 1 && /#chat-log \.cmsg\.user > \.body \{ border-right-color: currentColor;\s*$/.test(speechBodies[0]),
  'the sheet paints no fill on a speech body: the base speech rule out-ranks one, so the agent’s only ever landed as a lit band behind tool lines and inside cards. The Commander’s rail takes the colour of their words and that is all');
A.ok(!/> \.body|\.who\b|\.choice\b|\.choice-row|\.cmsg-head|presence|\.run-/.test(cssC),
  'the cards pass names no speech body, name tag, bracket chip or run summary: the conversation keeps its own design');
A.eq(cssC.split('.cmsg:is(.turnin, .nudge, .consent):not([data-clarify-prompt]) .consent-btn:not(.tc-shortcut)').join('').includes('.nudge'), false,
  'the nudge is an aside: it is named only as a host of its keys, never as a pane');
A.ok(!/\.task-conversation(?! \.tc-shortcut)/.test(cssC), 'the conversation inside a question is named only for its shortcut tiles: a question card is ONE frame, never a card in a card');
// panes
const PANE = '.cmsg:is(.turnin, .consent):not(.receipts), .cmsg.tb-read:not(.tb-read-spent), #chat-log > .dg-line';
const WAIT = '.cmsg.consent[data-live-ask], #chat-log > .dg-line:has(.dg-line-sum.waiting)';
A.eq(ruleC(PANE), 'background: var(--vx-pane); box-shadow: var(--vx-pane-shadow);',
  'a card (a review, an approval, a question, a workshop return, a live read, the delegated crew) is one pane of the window glass, fill and shadow only: it keeps its own border, the receipts line is not a card and a spent read is not one');
A.eq(ruleC(WAIT), 'background: linear-gradient(180deg, rgba(var(--gold-rgb), .06), rgba(var(--gold-rgb), .012) 55%), var(--vx-pane);',
  'a card that waits on you keeps its gold wash, laid over the pane');
A.ok(atC(PANE) >= 0 && atC(WAIT) > atC(PANE), 'the waiting wash follows the pane rule, so it is the one that paints');
A.eq(rulesC.filter(r => /var\(--vx-pane\)/.test(r.body)).map(r => r.sel).join(' | '), PANE + ' | ' + WAIT, 'nothing else in COMMS is made a pane');
// command keys
const CAP = ':is(.cmsg:is(.turnin, .nudge, .consent):not([data-clarify-prompt]) .consent-btn:not(.tc-shortcut), .cmsg[data-clarify-prompt] :is(.consent-confirm, .tc-actions > .consent-btn), .dg-inspect .consent-btn, .dg-line .dg-key):not(.thumb):not(.quiet)';
const HOT = ':is(:hover, :focus-visible):not(:disabled)';
const LIT_C = CAP + ':is(.primary, .ws-openit, .ws-primary, .consent-confirm):not(:disabled)';
A.eq(ruleC(CAP), 'border-color: transparent !important; background: var(--vx-cap) border-box !important; box-shadow: var(--vx-cap-shadow) !important;',
  'a key that does something is the windows’ glossy cap; a quiet key keeps its hairline and the thumbs have their own rule');
A.eq(ruleC(CAP + ':not(:is(.danger, .deny))'), 'color: var(--vx-core) !important; text-shadow: 0 0 6px rgba(var(--ph-rgb), .75);', 'a cap’s words are lit, and a deny or danger key keeps its own red');
A.eq(ruleC(CAP + HOT), 'background: var(--vx-cap-hot) border-box !important;', 'a cap brightens under the pointer or the keyboard; a disabled one does not answer');
A.eq(ruleC(LIT_C), 'border-color: transparent !important; background: var(--vx-cap-on) border-box !important; box-shadow: var(--vx-cap-on-shadow) !important; color: #020604 !important; text-shadow: none !important;',
  'the one key a card wants pressed is the lit cap with dark words; a key that cannot be pressed yet never lights');
A.eq(ruleC(LIT_C + ' *'), 'color: inherit !important; text-shadow: none !important;', 'anything inside the lit key takes its dark ink');
A.ok(atC(CAP) >= 0 && atC(CAP + HOT) > atC(CAP) && atC(LIT_C) > atC(CAP + HOT), 'the lit rule follows the hover rule, so a lit key stays lit under the pointer');
A.eq(rulesC.filter(r => /var\(--vx-cap-on(-shadow)?\)/.test(r.body)).map(r => r.sel).join(' | '), LIT_C, 'only that rule lights a key: never a thumb, a quiet key or an answer');
A.eq(ruleC('.consent-btn.thumb'), 'border-color: transparent !important; background: var(--vx-cap) border-box !important; box-shadow: var(--vx-cap-shadow) !important;',
  'the two thumbs are dark caps and the rule names no colour: thumb-up carries .primary and thumb-down .deny, and each keeps its own colour');
A.eq(ruleC('.consent-btn.thumb' + HOT), 'background: var(--vx-cap-hot) border-box !important;', 'a thumb brightens under the pointer');
// answers
const ANS = ':is(.cmsg[data-clarify-prompt] .consent-btns > .consent-btn:not(.consent-confirm), .task-conversation .tc-shortcut, .cmsg.tb-read .tb-read-assump):not(.quiet)';
const ANS_HOT = ANS + ':is(:hover, :focus-visible):not(:is(.sel, [aria-pressed="true"], :disabled))';
const PICK = ANS + ':is(.sel, [aria-pressed="true"])';
A.eq(ruleC(ANS), 'background: var(--vx-tile) border-box !important; box-shadow: var(--vx-tile-shadow) !important;', 'an answer you choose between is a glass tile, not a key');
A.eq(ruleC(ANS + ':not(.primary)'), 'border-color: transparent !important;', 'a tile sits on its own seat, and the answer the agent recommends keeps the border the base sheet gives it');
A.eq(ruleC(ANS_HOT), 'background: var(--vx-tile-hot) border-box !important;', 'a tile brightens under the pointer or the keyboard; a picked or disabled tile does not answer');
A.eq(ruleC(PICK), 'border-color: transparent !important; background: var(--vx-pick) border-box !important; box-shadow: var(--vx-pick-shadow) !important;',
  'a picked answer wears the pick (its ring and lit edge over dark glass): picked never looks like its neighbours');
A.ok(atC(ANS) >= 0 && atC(ANS_HOT) > atC(ANS) && atC(PICK) > atC(ANS_HOT), 'the pick is the last tile rule, so it is the one that paints');
A.ok(CAP.includes(':not([data-clarify-prompt]) .consent-btn:not(.tc-shortcut)') && CAP.includes('.cmsg[data-clarify-prompt] :is(.consent-confirm, .tc-actions > .consent-btn)') && ANS.includes('.consent-btns > .consent-btn:not(.consent-confirm)'),
  'the two lists never overlap: on a question card only the send keys are caps, every answer is a tile, and a shortcut is never a cap');
// what a card shows, and what you type into
A.eq(ruleC(':is(.cmsg, .dg-line) :is(.ws-pane, .tc-understanding, .tc-sample, .consent-payload > pre)'), 'background: var(--vx-well); box-shadow: var(--vx-read-shadow);',
  'what a card only shows (the files that came back, what the agent understood, a sample, a request’s payload) sits in a recess');
const FIELD = '.cmsg :is(.turnin-edit, .tb-read-in, .tc-answer)';
A.eq(ruleC(FIELD), 'border-color: transparent !important; background: var(--vx-well) !important; box-shadow: var(--vx-well-shadow) !important;', 'what you type into is the glass well of every other field');
A.eq(ruleC(FIELD + ':focus'), 'box-shadow: inset 0 0 0 1px var(--vx-node), var(--vx-well-shadow) !important;', 'the field you are in wears a bright edge, and its focus outline is left alone');
// what the pass must never do
A.eq([...new Set((cssC.match(/[{;]\s*-{0,2}[a-z][a-z-]*(?=:)/g) || []).map(x => x.replace(/^[{;]\s*/, '')))].filter(x => !x.startsWith('--vx-')).sort().join(' '),
  'background border-color box-shadow color text-shadow',
  'the cards pass is paint: no size, no spacing, no radius, no outline, so nothing in the conversation moves');
A.ok(!/[;{\s]filter:\s/.test(cssC) && !/#stage-wrap/.test(cssC) && !/\[class/.test(cssC), 'the cards pass declares no filter, styles nothing under #stage-wrap and adds no [class] selector');
A.ok(!/@/.test(cssC), 'the cards pass has no at-rule');
A.ok(!/content:/.test(cssC), 'the cards pass writes no words and draws no extra part: no legend, label or control');
A.ok(!/url\(/.test(cssC) && !/repeating-/.test(cssC), 'the cards stay plain glass: the pass draws no crest, trace, scan line or grid');
// ---- 31 · THE REST (Andrew 2026-11-10: "Yes, restyle them"). The last old surfaces take the silver device: the five pop-up lists
// (the model list, the slash commands, the agent list, a session row's menu, WIDGETS), the toasts, three small leftovers, the boot
// loader + title screen and Build Mode. Paint and shape: nothing moves, no control and no word is added, and the conversation is
// not touched. What was looked at and left: the top bar's status box and the context gauge (already LCD wells), the error screens
// and Genesis (section 13's), and the placement plate Build Mode draws on the canvas ----
const LPFX = 'html body.vx:not(.hud-mode):not(.vx-b)';
const selsL = selsOf(cssL);
A.ok(selsL.length > 100, 'the rest is its own section (' + selsL.length + ' selectors)');
A.eq(selsL.filter(x => x !== LPFX && !x.startsWith(LPFX + ' ')).join(' | '), '', 'every selector in the last pass opens with the VECTOR gate: VECTOR only, never variation B');
A.eq(stray(cssL, ':not(.vx-b)').join(' | '), '', 'no selector in the last pass slips its scope inside a one-line list');
const ROOTS = ['#model-dock', '#chat-slash', '#gd-agent-menu', '.ws-menu', '.wg-pop.wg-library', '#toast-stack', '#screen-game #left #ws-agent-filter',
  '#screen-game #terms .term:not(.pw) .q-star-map', '#screen-game #terms .term:not(.pw) .q-star:not(.q-sys-off)', '#wr-cine-hint',
  ':is(#screen-boot, #screen-splash)', '#screen-boot', '#screen-splash', '.refit-overlay'];
A.eq(selsL.map(x => x.slice(LPFX.length).trim()).filter(x => x && !ROOTS.some(r => x === r || x.startsWith(r + ' ') || x.startsWith(r + ':'))).join(' | '), '',
  'the last pass reaches only the surfaces it was asked to restyle: the five pop-up lists, the toasts, the crew filter, the quest tiles, the cinema hint, the boot + title screens and Build Mode');
A.eq(selsL.filter(x => x === LPFX).length, 1, 'the bare gate is used once, for the materials');
A.ok(!/\.cmsg|#chat-log|#chat-panel|\.dg-line|presence|\.nudge|\.consent/.test(cssL), 'the last pass names nothing inside the conversation: speech, the nudge and the cards keep the design they have');
A.ok(!/\.tb-status|\.tb-xp|#ctx-gauge|\.ctx-cells|#screen-connect|\.cc-tb-tag|\.ov-wordmark|\.ov-journey|\.ov-actions/.test(cssL),
  'what was looked at and left stays left: the top bar’s status box and the context gauge are LCD wells already, the error screens and Genesis are section 13’s');
const rulesL = cssL.split('}').filter(r => r.includes('{')).map(r => ({ sel: r.slice(0, r.indexOf('{')).split(LPFX).join('').replace(/\s+/g, ' ').trim(), body: r.slice(r.indexOf('{') + 1).replace(/\s+/g, ' ').trim() }));
const atL = (sel) => rulesL.findIndex(r => r.sel === sel);
const ruleL = (sel) => (rulesL[atL(sel)] || { body: '' }).body;
// the materials
A.eq(partsOf(ruleL('')).map(x => x.slice(0, x.indexOf(':'))).join(' '), '--vx-pane --vx-pane-shadow --vx-read-shadow --vx-tile-shadow --vx-tile --vx-tile-hot --vx-pick --vx-pick-shadow',
  'the body names the eight materials of a window’s insides once, for the surfaces that are not inside a station window or COMMS');
A.eq(partsOf(ruleL('')).join('\n'), partsOf(partsI).join('\n'), 'and they are section 29’s, word for word: a tile in a pop-up list, in Build Mode and in a window are the same glass');
A.eq((cssL.match(/--vx-[a-z-]+:/g) || []).length, 8, 'the last pass defines no material of its own');
// the pop-up lists
const BAY = 'border-color: transparent; border-radius: 16px; background: linear-gradient(180deg, rgba(0, 0, 0, .9) 0, rgba(0, 0, 0, 0) 6px) border-box, linear-gradient(180deg, #05070a 0, #0d1116 60%, #161b21 100%) border-box; box-shadow: var(--vx-lip2), 0 0 0 1px #000, 0 0 0 2px #c4ccd5, 0 1px 0 2px #eef2f6, 0 0 0 3px #2a3037, 0 10px 30px 3px rgba(0, 0, 0, .7); -webkit-backdrop-filter: none; backdrop-filter: none;';
const HEAD_LIP = 'inset 0 -3px 0 var(--vx-veilc), inset 0 -1px 0 #2a3037, inset 0 -2px 0 #eef2f6, inset 0 -3px 0 #c4ccd5, inset 0 -4px 0 #000';
A.eq(ruleL('#model-dock, #chat-slash, #gd-agent-menu, .ws-menu, .wg-pop.wg-library'), BAY,
  'the five pop-up lists share one shell: a black bay in the chrome lip, no blur. Shell only: what opens and closes them is not touched');
A.eq(ruleL('#model-dock .model-dock-head, #chat-slash .slash-head, .wg-pop.wg-library .wg-library-header'),
  'border-color: transparent; border-radius: 0; background: linear-gradient(180deg, #05070a 0, #0d1116 100%); box-shadow: ' + HEAD_LIP + ';',
  'a pop-up’s head is the bay’s own top with the chrome lip under it, as a window’s head has');
const ROW = '#model-dock .model-dock-row, #chat-slash .slash-item, #gd-agent-menu .gd-agent-option, .ws-menu .ws-menu-item:not(.armed), .wg-pop.wg-library :is(.wg-app-row, .wg-library-card)';
const ROW_HOT = '#model-dock .model-dock-row:is(:hover, :focus-visible):not(.sel), #chat-slash .slash-item:hover:not(.sel), #gd-agent-menu .gd-agent-option:is(:hover, :focus-visible):not([aria-selected="true"]), .ws-menu .ws-menu-item:not(.armed):is(:hover, :focus-visible), .wg-pop.wg-library :is(.wg-app-row, .wg-library-card):is(:hover, :focus-within)';
const ROW_PICK = '#model-dock .model-dock-row.sel, #chat-slash .slash-item.sel, #gd-agent-menu .gd-agent-option[aria-selected="true"]';
A.eq(ruleL(ROW), 'border-color: transparent; border-radius: 8px; background: var(--vx-tile) border-box; box-shadow: var(--vx-tile-shadow);', 'a row in a pop-up list is a glass tile');
A.eq(ruleL(ROW_HOT), 'border-color: transparent; background: var(--vx-tile-hot) border-box; box-shadow: var(--vx-tile-shadow);', 'the row under the pointer or the keyboard lifts; the chosen row does not answer');
A.eq(ruleL(ROW_PICK), 'border-color: transparent; background: var(--vx-pick) border-box; box-shadow: var(--vx-pick-shadow);',
  'the chosen row (the model in use, the command about to run, the agent you are talking to) wears the pick: its ring and lit edge over dark glass');
A.ok(atL(ROW) >= 0 && atL(ROW_HOT) > atL(ROW) && atL(ROW_PICK) > atL(ROW_HOT), 'the pick is the last row rule, so it is the one that paints');
// an armed key ("click again to delete") is the base sheet's: nothing here may match it or out-rank it
const menuSels = selsL.filter(x => x.includes('.ws-menu-item'));
A.ok(menuSels.length === 3 && menuSels.every(x => /\.ws-menu-item(\.danger)?:not\(\.armed\)/.test(x)), 'every rule on a row of the session menu steps aside for an armed row (' + menuSels.length + ' selectors)');
A.ok(rulesL.filter(r => r.sel.includes('.ws-menu')).every(r => !/!important/.test(r.body)), 'and nothing under the session menu is forced: the armed fill always wins');
A.ok(/rgba\(255, 92, 77/.test(ruleL('.ws-menu .ws-menu-item.danger:not(.armed):is(:hover, :focus-visible)')), 'a destructive row keeps its red under the pointer');
// keys
const POP_CAP = '#model-dock .model-dock-effort, #model-dock .model-dock-foot :is(button, a), .wg-pop.wg-library .wg-library-filters button, .wg-pop.wg-library :is(.wg-studio-button, .wg-library-action)';
const POP_LIT = '#model-dock .model-dock-effort.sel, .wg-pop.wg-library .wg-library-filters button[aria-pressed="true"], .wg-pop.wg-library .wg-studio-primary:not(:disabled)';
const LIT_BODY = 'border-color: transparent; background: var(--vx-cap-on) border-box; box-shadow: var(--vx-cap-on-shadow); color: #020604; text-shadow: none;';
A.eq(ruleL(POP_CAP), 'border-color: transparent; border-radius: 7px; background: var(--vx-cap) border-box; box-shadow: var(--vx-cap-shadow); color: var(--vx-core); text-shadow: 0 0 6px rgba(var(--ph-rgb), .75);',
  'a key in a pop-up list is the windows’ glossy cap with lit words');
A.eq(ruleL(POP_LIT), LIT_BODY, 'the chosen key of a bar, and the one key WIDGETS wants pressed, is the lit cap with dark words; one that cannot be pressed yet never lights');
A.ok(atL(POP_CAP) >= 0 && atL(POP_LIT) > atL(POP_CAP), 'the lit rule follows the cap and hover rules');
A.eq(ruleL('#model-dock :is(.model-dock-presets, .model-dock-exact), .wg-pop.wg-library .wg-library-filters'), 'gap: 4px; padding: 4px; border: 0; border-radius: 12px; background: var(--vx-seat); box-shadow: var(--vx-seat-shadow);',
  'a bar of keys sits on a chrome seat');
// fields: a drop-down keeps the chevron the base sheet draws as its background, so it only ever gets a background COLOUR
const WELL_SELECT = 'border-color: transparent; border-radius: 9px; background-color: #010302; box-shadow: var(--vx-well-shadow);';
A.eq(ruleL('.wg-pop.wg-library select.wg-studio-input'), WELL_SELECT, 'a drop-down in WIDGETS is a well by colour and shadow alone');
A.eq(ruleL('.refit-overlay select:is(.refit-input, .refit-object-finder)'), WELL_SELECT, 'so is a drop-down in Build Mode');
const WELL_POP = '#model-dock #model-dock-search, .wg-pop.wg-library :is(.wg-library-search, .wg-studio-input:not(select))';
const WELL_BM = '.refit-overlay :is(.refit-input, .refit-num, .refit-searchfield):not(select)';
A.eq(ruleL(WELL_POP), 'border-color: transparent; border-radius: 9px; background: var(--vx-well); box-shadow: var(--vx-well-shadow);', 'a field in a pop-up list is a recessed well, and the rule steps round a drop-down');
A.eq(ruleL(WELL_BM), 'border-color: transparent; border-radius: 9px; background: var(--vx-well) border-box; box-shadow: var(--vx-well-shadow);', 'so is a field in Build Mode');
A.eq(rulesL.filter(r => /var\(--vx-well\)/.test(r.body)).map(r => r.sel).join(' | '),
  [WELL_POP, '.wg-pop.wg-library .wg-detail-reading', '#screen-game #terms .term:not(.pw) .q-star-map', WELL_BM, '.refit-overlay :is(.refit-linetile-view, .refit-preview-art, .refit-step-art, .station-build-art)'].join(' | '),
  'the well’s fill is never laid over a drop-down: it would paint out the drawn chevron');
A.eq(ruleL('#model-dock #model-dock-search:focus, .wg-pop.wg-library :is(.wg-library-search, .wg-studio-input):focus'), 'outline: 0; box-shadow: inset 0 0 0 1px var(--vx-node), var(--vx-well-shadow);', 'the field you are in wears a bright edge');
// toasts
A.ok(/^border-color: transparent transparent transparent var\(--sev\); border-radius: 12px;/.test(ruleL('#toast-stack .toast')) && /0 0 0 2px #c4ccd5/.test(ruleL('#toast-stack .toast')),
  'a toast is a small bay in the chrome lip, and it keeps the left edge that says its severity');
A.eq(ruleL('#toast-stack .toast::after'), 'content: none;', 'a toast’s old corner ticks go');
// the small leftovers
A.eq(ruleL('#screen-game #left #ws-agent-filter'), 'border-color: transparent; background: var(--vx-pick) border-box; box-shadow: var(--vx-pick-shadow);', 'the crew filter in force reads as the chosen thing: ring and lit edge');
A.eq(ruleL('#screen-game #terms .term:not(.pw) .q-star:not(.q-sys-off)'), 'background: var(--vx-tile) border-box; box-shadow: var(--vx-tile-shadow);',
  'a quest tile is a glass tile: it keeps the border that says its state, and an offline one is left as it is');
A.eq(ruleL('#wr-cine-hint'), 'border-color: transparent; border-radius: 999px; padding: 4px 18px; background: var(--vx-lcd) border-box; box-shadow: var(--vx-lcd-shadow);', 'the cinema hint is one line on a small readout');
// before the station is up
A.ok(/var\(--vx-grain\)/.test(ruleL(':is(#screen-boot, #screen-splash)')) && /linear-gradient\(180deg, #6d7682 0%/.test(ruleL(':is(#screen-boot, #screen-splash)')),
  'the boot loader and the title screen stand in the station’s own brushed cabinet');
A.eq(ruleL('#screen-boot .boot-veil, #screen-splash .sp-center'), 'position: absolute; inset: 10px; border-radius: 16px; box-shadow: var(--vx-lip2), 0 0 0 1px #000, 0 0 0 2px #c4ccd5, 0 1px 0 2px #eef2f6, 0 0 0 3px #2a3037;',
  'each is one black bay in the chrome lip, the same margin the station’s frame keeps');
A.eq(rulesL.filter(r => /position:/.test(r.body)).map(r => r.sel).join(' | '), '#screen-boot .boot-veil, #screen-splash .sp-center', 'nothing else is re-positioned');
A.eq(ruleL('#screen-splash :is(.sp-floor, .cc-bracket)'), 'display: none;', 'the title screen’s grid floor and corner brackets go: a screen stays plain');
A.eq(rulesL.filter(r => /display:/.test(r.body)).map(r => r.sel).join(' | '), '#screen-boot .boot-veil | #screen-splash :is(.sp-floor, .cc-bracket)', 'nothing else is hidden or re-flowed');
A.eq(ruleL('#screen-splash .sp-press'), 'padding: 9px 24px; border-radius: 9px; background: var(--vx-cap-on) border-box; box-shadow: var(--vx-cap-on-shadow); color: #020604; text-shadow: none;',
  'the one control on the title screen is the lit cap; its blink is left running');
// Build Mode
A.eq(ruleL('.refit-overlay .refit-dock, .refit-overlay .refit-guide-card, .refit-overlay .station-build-box'), BAY, 'Build Mode’s library and its cards are the same bay as a pop-up list');
A.ok(ruleL('.refit-overlay .refit-top').includes(HEAD_LIP) && ruleL('.refit-overlay .refit-dock-head').includes(HEAD_LIP), 'Build Mode’s top strip and the library’s head carry the chrome lip of a window’s head');
const BM_KEYS = '.refit-overlay :is(.bb, .btn-sm, #refit-kit-toggle)';
const OWN = ':not(:is(.station-build-card, .armed, .refit-tool-reclaim, .refit-danger, .refit-sel-del))';
const BM_HOT = BM_KEYS + OWN + ':is(:hover, :focus-visible):not(:disabled)';
const BM_LIT = BM_KEYS + ':is(.active, .sel, .on, [aria-pressed="true"], .refit-primary)' + OWN + ':not(:disabled)';
A.eq(ruleL(BM_KEYS + ':not(:is(.station-build-card, .armed))'), 'border-radius: 7px; background: var(--vx-cap) border-box; box-shadow: var(--vx-cap-shadow); animation: none;',
  'a key in Build Mode is a cap, and a cap is whole: the base sheet fades the end of a button whose legend overflows, which melts a cap into its seat. An armed key keeps its fill');
A.eq(ruleL(BM_KEYS + OWN), 'border-color: transparent; color: var(--vx-core); text-shadow: 0 0 6px rgba(var(--ph-rgb), .75);', 'a cap’s words are lit; a destructive key keeps its own ink and edge');
A.eq(ruleL(BM_HOT), 'background: var(--vx-cap-hot) border-box; color: color-mix(in srgb, var(--vx-core) 55%, #fff);', 'a cap brightens under the pointer or the keyboard; a disabled one does not answer');
A.eq(ruleL(BM_LIT), 'border-color: transparent !important; background: var(--vx-cap-on) border-box !important; box-shadow: var(--vx-cap-on-shadow); color: #020604 !important; text-shadow: none;',
  'the chosen key (a tool, a tab, a tier, the primary action) is the lit cap with dark words');
A.eq(ruleL(BM_LIT + ' *'), 'color: inherit; text-shadow: none;', 'anything inside the lit key takes its dark ink');
A.ok(atL(BM_KEYS + OWN) >= 0 && atL(BM_HOT) > atL(BM_KEYS + OWN) && atL(BM_LIT) > atL(BM_HOT), 'the lit rule follows the hover rule, so a lit key stays lit under the pointer');
A.eq(rulesL.filter(r => /var\(--vx-cap-on(-shadow)?\)/.test(r.body)).map(r => r.sel).join(' | '), POP_LIT + ' | #screen-splash .sp-press | ' + BM_LIT,
  'only those three rules light a key: a chosen key in a pop-up list, the title key, a chosen key in Build Mode');
const RED = '.refit-overlay :is(.bb, .btn-sm):is(.refit-tool-reclaim, .refit-danger, .refit-sel-del):not(.armed)';
A.eq(ruleL(RED), 'color: #ffc2bb; text-shadow: 0 0 6px rgba(255, 92, 77, .7);', 'a destructive key is a cap whose legend stays red, lifted to read on the cap');
A.ok(/rgba\(255, 92, 77, \.34\)/.test(ruleL(RED + ':is(:hover, :focus-visible, .active):not(:disabled)')), 'and it takes a red wash under the pointer, never the green one');
A.eq(ruleL('.refit-overlay :is(.bb, .btn-sm).refit-primary:disabled'), 'border-color: transparent !important; background: var(--vx-cap) border-box !important; color: var(--vx-core) !important;',
  'a primary key that cannot be pressed yet is a dark cap, not a flat lit block');
const BM_TILE = '.refit-overlay :is(.refit-proptile, .refit-mattile, .refit-linetile, .refit-machinetile, .refit-linetile-makeroom, .refit-hotslot, .refit-handkey, .refit-keyrow, .refit-step, .station-build-card, .refit-category-menu > summary)';
const BM_PICK = '.refit-overlay :is(.refit-proptile, .station-build-card)[aria-pressed="true"], .refit-overlay :is(.refit-mattile, .refit-linetile, .refit-machinetile, .refit-hotslot, .refit-handkey):is(.active, [aria-pressed="true"])';
A.eq(ruleL(BM_TILE), 'background: var(--vx-tile) border-box; box-shadow: var(--vx-tile-shadow);', 'the things you pick in Build Mode are glass tiles');
A.eq(ruleL(BM_PICK), 'border-color: transparent; background: var(--vx-pick) border-box; box-shadow: var(--vx-pick-shadow);',
  'the chosen one wears the pick. A prop tile is chosen by aria-pressed="true" alone: picking a prop toggles .active on the other prop tiles too, so .active on a prop tile says nothing');
A.ok(atL(BM_TILE) >= 0 && atL(BM_PICK) > atL(BM_TILE), 'the pick follows the tile and hover rules, so it is the one that paints');
A.eq(rulesL.filter(r => /var\(--vx-pick(-shadow)?\)/.test(r.body)).map(r => r.sel).join(' | '), ROW_PICK + ' | #screen-game #left #ws-agent-filter | ' + BM_PICK,
  'the pick goes to a chosen row, the crew filter in force and a chosen thing in Build Mode: nothing else');
A.ok(/border-color: var\(--bad\);/.test(ruleL('.refit-overlay .refit-handkey[data-handkey="remove"].active')) && /var\(--gold\)/.test(ruleL('.refit-overlay .refit-goalcell .refit-linetile')),
  'the states a tile already says with its edge stay said: the red of the REMOVE hand, the gold of the goal');
// what the pass must never do
A.eq([...new Set((cssL.match(/[{;]\s*-{0,2}[a-z][a-z-]*(?=:)/g) || []).map(x => x.replace(/^[{;]\s*/, '')))].filter(x => !x.startsWith('--vx-')).sort().join(' '),
  '-webkit-backdrop-filter align-items animation backdrop-filter background background-color border border-bottom-color border-color border-radius border-top-color bottom box-shadow clip-path color content display flex-direction gap height inset justify-content margin margin-top opacity outline padding padding-bottom padding-inline position text-shadow top',
  'the last pass is paint and shape: no width, no font, no transform, no z-index, no transition, so nothing changes size class, face or stacking');
A.eq((cssL.match(/animation:[^;]*;/g) || []).join(' '), 'animation: none; animation: none;', 'the last pass adds no motion: it only stills the boot veil’s flicker and the fade that melts a cap');
A.eq((cssL.match(/(?<![a-z-])content:[^;]*;/g) || []).join(' '), 'content: none;', 'the last pass writes no words and draws no extra part: its one content line removes the toast’s corner ticks');
A.eq((cssL.match(/backdrop-filter:[^;]*;/g) || []).filter(x => x !== 'backdrop-filter: none;').join(' '), '', 'the last pass blurs nothing: a bay is solid');
A.ok(!/[;{\s]filter:\s/.test(cssL) && !/#stage-wrap/.test(cssL) && !/\[class/.test(cssL), 'the last pass declares no filter, styles nothing under #stage-wrap and adds no [class] selector');
A.ok(!/@/.test(cssL), 'the last pass has no at-rule');
A.ok(!/url\(/.test(cssL) && !/repeating-/.test(cssL) && !/background-size/.test(cssL), 'the last surfaces stay plain: the pass draws no crest, trace, scan line or grid');

// ---- THE FORMAT (Andrew 2026-11-10: "we need to adjust certain UI areas like settings, and every single UI panel and reformat
// it to our newer aesthetic and style. I want a full commitment to the new look"). Sections 28 to 31 repainted the old terminal
// layout. This one lays a station window out as the device: dark screens set into the glass body (as CREW and COMMS are), lit
// headings over one hairline, modules with a head strip and its lamp, a readout beside each slider, the market windows as one
// screen, a drawn chevron on every fold. Nothing is added or removed: no control, no word, no window. The conversation, the
// pop-up lists and Build Mode are not touched, and the battle pass keeps its drawn reward track ----
const XPFX = LPFX + ' #screen-game #terms .term:not(.pw)';
const selsX = selsOf(cssX);
A.ok(selsX.length >= 40, 'the format is its own section (' + selsX.length + ' selectors)');
A.eq(selsX.filter(x => !x.startsWith(XPFX + ' ')).join(' | '), '', 'every selector in the format opens with the VECTOR gate and stays inside a station window: VECTOR only, never variation B, never a plugin window');
A.eq(stray(cssX, ':not(.vx-b)').join(' | '), '', 'no selector in the format slips its scope inside a one-line list');
const rulesX = cssX.split('}').filter(r => r.includes('{')).map(r => ({ sel: r.slice(0, r.indexOf('{')).split(XPFX).join('').replace(/\s+/g, ' ').trim(), body: r.slice(r.indexOf('{') + 1).replace(/\s+/g, ' ').trim() }));
const atX = (sel) => rulesX.findIndex(r => r.sel === sel);
const ruleX = (sel) => (rulesX[atX(sel)] || { body: '' }).body;
// the screens
const SCREENS = ':is(.con-rail, .con-pane, .mkt-stage, .term-body:not(.term-console-body):not(.mkt-window-body))';
A.eq(ruleX(SCREENS), 'border-radius: 12px; background: var(--vx-lcd); box-shadow: var(--vx-lcd-shadow);',
  'a window’s list, its page and a one-page window’s body are dark screens set into the glass: the same readout CREW and COMMS use, by the same two tokens');
A.eq(rulesX.filter(r => /var\(--vx-lcd(-shadow)?\)/.test(r.body)).map(r => r.sel).join(' | '), SCREENS + ' | .auto-own', 'two rules make a screen, the shared one and AUTOMATE’s strip: a card on a screen is never a second screen');
// AUTOMATE, one screen per tab (Andrew 2026-11-11, "All three"): the tabs across its top pick the area, so the second side rail
// is not drawn. Its tab buttons stay in the page, because the empty-state keys, the chat doors and the QA journey click them
A.eq(ruleX('.auto-own'), 'padding: 6px 8px 6px 16px; border: 0; border-radius: 12px; background: var(--vx-lcd); box-shadow: var(--vx-lcd-shadow);', 'ON ITS OWN is a slim screen of its own over the page: a sibling of the page’s screen, never a card on it');
A.eq(ruleX('.auto-own .set-sub-d'), 'padding: 3px 10px; border-radius: 6px; background: var(--vx-well); box-shadow: var(--vx-read-shadow); color: var(--vx-core);', 'and the rung sits in a readout, as a slider’s value does');
const autoJs = read('frontend/app/windows/automation.js'), utilCss = read('frontend/css/utility-menus.css');
A.ok(autoJs.includes("mountConsole(body, 'automation', sections, { search: false });") && !/railTop/.test(autoJs), 'AUTOMATE mounts its console with nothing over the rail: ON ITS OWN is a strip over the page');
A.ok(/\.automation-win \.con-rail \{ display: none; \}/.test(utilCss) && !/\.automation-win \.con-rail-item/.test(utilCss), 'the second rail is not drawn in either look, and no rule is left dressing its entries');
A.ok(autoJs.includes("body.querySelector('#con-tab-automation-' + to)") && /tab\.click\(\); land\(to, to === form\);/.test(autoJs), 'a page key goes through the console’s own tab button, so the page ids every door uses still route');
A.ok(/body\.querySelectorAll\('\.con-rail-item'\)\.forEach\(tab => tab\.addEventListener\('click', \(\) => \{[\s\S]{0,220}land\(id, id === 'routines-create' \|\| id === 'loops-start'\)/.test(autoJs),
  'whoever changes the page (a page key, an empty-state key), a keyboard left on the unseen tab button lands on the page it opened');
A.ok(autoJs.includes("[['routines', 'routines-create'], ['loops', 'loops-start']]") && autoJs.includes("className = 'bb sm auto-page-key'"), 'each list page carries its NEW key and each form its way back, drawn as a station key');
A.ok(autoJs.includes('id="auto-init-change"') && autoJs.includes("H.openTerm('settings', 'autonomy')") && autoJs.includes('StationUI.initiativeLabel(sum.initiative)'), 'the strip keeps the CHANGE door and reads the rung from the confirmed posture');
A.eq(ruleX('.quests-content .q-view-tabs::before'), 'background: color-mix(in srgb, var(--ph) 3%, #030507);', 'the band that covers scrolled quest rows is the screen’s own tone, so it never shows as a lighter block');
// the inset: the glass shows round a screen in a roomy window and gives the room back in a narrow one (1366 wide at a large TEXT SIZE)
const XINSET = 'clamp(0px, (100% - 640px) * .04, 11px)';
A.eq(ruleX('.term-console-body'), 'padding: 4px ' + XINSET + ' ' + XINSET + '; gap: 11px ' + XINSET + ';', 'a two-screen window sets its screens in from the glass by a margin that is nothing at 640px and full at 915px');
A.eq(ruleX('.term-body:not(.term-console-body):not(.mkt-window-body)'), 'margin: 4px ' + XINSET + ' ' + XINSET + ';', 'a one-screen window takes the same inset');
A.eq(ruleX('.mkt-stage'), 'margin: 0 ' + XINSET + ' ' + XINSET + ';', 'and so does a market window');
A.eq((cssX.match(/clamp\(0px, [^;]*?, 11px\)/g) || []).filter(x => x !== XINSET).join(' | '), '', 'every inset is the one expression: no window keeps a fixed margin a narrow window cannot afford');
// headings
const XLIT = 'color: color-mix(in srgb, var(--vx-core) 80%, #fff); text-shadow: 0 0 6px rgba(var(--ph-rgb), .45);';
A.ok(ruleX('.con-sec-head .sec-l').endsWith(XLIT) && ruleX('.ms-h') === XLIT, 'a page’s title and a group’s title are lit type on the screen');
A.eq(ruleX('.con-sec-head .sec-r'), 'display: none;', 'the page title loses the rule that ran beside it');
A.ok(/border-bottom: 1px solid var\(--vx-hair\); border-radius: 0;/.test(ruleX('.con-sec-desc')), 'one square hairline closes a page’s head (a rounded one curls up at its ends)');
A.eq(ruleX('.sec .sec-nd'), 'display: none;', 'a divider’s end diamond goes');
A.eq(ruleX(':is(.ms-h, .mkt-sect-h)::before'), 'content: none;', 'a heading’s diamond (a glyph the pixel face does not have) goes');
A.eq(ruleX(':is(.ms-h, .mkt-sect-h)::after'), 'height: 1px; background: var(--vx-hair);', 'a heading’s rule is one plain hairline');
// modules
const HEADS = ':is(.settings-group > .ms-h, .set-erase > .ms-h, .set-reset-browser > .ms-h, .cd-sec > .cd-sech, .cd-record > .cd-record-h, .cd-brief > .cd-brief-head, .ch-bots > .ch-bots-head, .ch-connection > .ch-section-title, .ag-mission > .ag-mission-lbl, .ag-reflection-panel > .gx-sec, .ag-achievements > .gx-trohead, .fm-mission > .fm-eyebrow, .kb-cols > .kb-col > h4):first-child';
A.ok(/^display: flex; align-items: center; justify-content: flex-start; flex-wrap: wrap; gap: 4px 10px; height: auto; margin: -16px -18px 14px; padding: 9px 16px 8px; border: 0; border-bottom: 1px solid var\(--vx-hair\); border-radius: 9px 9px 0 0;/.test(ruleX(HEADS)),
  'a module’s title is a head strip across the top of its card: it reaches the card’s edges by undoing the card’s own padding, and in a narrow card it wraps rather than run out of the card');
A.eq(ruleX(HEADS + ' > :is(.dim, .cd-dn, .cd-brief-meter, .gx-tag)'), 'flex: 0 1 auto; min-width: 0; margin: 0 0 0 auto; text-align: right; text-shadow: none; white-space: normal;',
  'the note at a strip’s right end may shrink and break its line: it never pushes the strip wider than its card');
A.ok(ruleX(HEADS).endsWith(XLIT), 'and its name is lit type');
A.eq(ruleX(':is(.settings-group, .set-erase, .set-reset-browser, .settings-pane > .set-row)'), 'padding: 16px 18px; margin: 0 0 14px;', 'the strip’s pull is the padding this section gives the card');
A.eq(ruleX(':is(.cd-sec, .cd-record, .cd-brief, .ch-bots, .ch-connection, .ag-mission, .ag-reflection-panel, .ag-achievements, .fm-mission)'), 'padding: 16px 18px;', 'for every card that carries a strip');
const LAMP = ruleX(HEADS + '::before');
A.ok(/^content: ''; display: block; position: static; order: -1; flex: 0 0 auto; width: 8px; height: 8px;/.test(LAMP) && /border-radius: 50%/.test(LAMP) && /radial-gradient\(circle at 35% 30%, color-mix\(in srgb, var\(--vx-core\) 60%, #fff\) 0, var\(--ph\) 48%/.test(LAMP),
  'the strip leads with a small lamp: the jewel on the CREW and COMMS heads, in the theme’s colour');
A.eq(ruleX(HEADS + '::after'), 'content: none;', 'a strip has no rule of its own: its lower edge is the line');
A.ok(atX(HEADS) >= 0 && atX('.kb-cols > .kb-col > h4:first-child') > atX(HEADS), 'a task column’s strip is fitted to that column’s padding after the shared rule, so it is the one that applies');
// rows
A.ok(ruleX('.set-slider').startsWith('grid-template-columns: clamp(76px, 38%, 136px) minmax(0, 1fr) clamp(40px, 18%, 62px); gap: 14px clamp(6px, 4%, 14px);') && /border-top: 1px solid rgba\(var\(--ph-rgb\), \.1\);/.test(ruleX('.set-slider')),
  'a slider is a row: its name, the fader, its value, under a faint rule. The name and value columns give way in a narrow card (136 and 62 at most), so the row never asks for more room than the card has');
A.eq(ruleX('.set-slider-val'), 'padding: 3px 4px; border-radius: 6px; background: var(--vx-well); box-shadow: var(--vx-read-shadow); color: var(--vx-core); text-align: center;', 'the value sits in a small readout');
A.eq(ruleX('.set-about'), 'opacity: 1; color: rgba(var(--ph-rgb), .72);', 'a note under a setting is dimmed by its ink, never by fading the whole line');
// the jump keys
A.eq(selsX.filter(x => x.includes('.settings-jumps > button')).length, 6, 'the jump keys are counted three ways (six, seven or eight, nine and up), so a row never ends in one key alone');
// the market windows
A.eq(ruleX('.mkt-stage > :is(.mkt-roster, .mkt-dossier)'), 'border: 0; border-radius: 0 !important; background: none; box-shadow: none;', 'in a market window the list and the detail share one screen: neither is a card of its own');
A.eq(ruleX('.mkt-stage > .mkt-dossier'), 'border-left: 1px solid var(--vx-hair);', 'a hairline parts them');
A.eq(ruleX('.mkt-stage > .mkt-roster'), 'padding-left: clamp(8px, (100% - 360px) * .12, 14px); padding-right: clamp(8px, (100% - 360px) * .12, 14px);', 'the list’s side margin is fluid: a list column under about 480px gives it back, so three cards in a row keep the width their labels need');
// MY WORK › RECIPES, the shorter list (Andrew 2026-11-11, "All three"): a row is its seal and its name, and the ten category keys
// are seated key to key so they share one line at a normal window width. Nothing is removed: the sentence is the row's hover tip
// and the first line of the pane beside the list, and a narrow window wraps the keys (a sideways-scrolling rail was tried before
// and replaced, and a cut label is never the answer)
const mktJs = read('frontend/app/marketplace.js'), mktCss = read('frontend/css/marketplace.css');
const recRow = mktJs.slice(mktJs.indexOf('function recipeCardHTML'), mktJs.indexOf('/* ---------- the dossier'));
A.ok(recRow.includes("const tip = r.tagline ? ' data-tip=\"' + esc(r.tagline) + '\" aria-description=\"' + esc(r.tagline) + '\"' : '';") && recRow.includes("'\"' + tip + ' style=\"--ci:'"),
  'a recipe row carries its sentence as the station tip and as its description for a screen reader');
A.ok(!recRow.includes('mkt-tag') && !/\btitle="' \+/.test(recRow), 'and prints no sentence under its name (and never falls back to the OS bubble)');
A.ok(mktJs.includes("'<div class=\"mkt-dos-tag\">' + esc(r.tagline) + '</div>'"), 'the sentence still opens the pane beside the list');
A.ok(mktCss.includes('grid-template-columns: 34px minmax(0, 1fr); gap: 12px; padding: 8px 12px; min-height: 0;') && mktCss.includes('.mkt-recipes .mkt-rows .mkt-card .mkt-coin { --coin: 34px; }'),
  'a one-line row is sized for one line: a 34px seal, 8px above and below, and no floor left over from the two-line row');
A.ok(mktJs.includes("'<span class=\"mkt-lanes-lbl\">BROWSE</span><div class=\"mkt-lanes mkt-cats\">' + rail + '</div>'") && mktJs.includes("'<span class=\"mkt-lanes-lbl\">FILTER</span><div class=\"mkt-lanes\">' + rail + '</div>'"),
  'the recipe categories are named as their own rail; the class rail (four or five keys) is left as it was');
A.eq(ruleX('.mkt-cats'), 'gap: 4px;', 'the ten category keys sit at the keypad’s gap');
A.eq(ruleX('.mkt-cats > .mkt-lane'), 'padding-left: 6px; padding-right: 6px;', 'with a glass key’s narrow sides');
A.eq(ruleX('.mkt-cats > .mkt-lane > .ct'), 'margin-left: 3px;', 'and the count a step nearer its name');
A.ok(!/overflow|nowrap|letter-spacing|font-size|text-overflow|display: none/.test(rulesX.filter(r => r.sel.includes('.mkt-cats')).map(r => r.body).join(' ')) && /\.mkt-lanes \{ display: flex; align-items: center; gap: 7px; flex-wrap: wrap; \}/.test(mktCss),
  'the rail still WRAPS in a narrow window: it never scrolls sideways, never cuts or hides a key, and the key type is not touched');
// the Library options suggestion cards follow their own rail's width (three across in a 394px list column broke every name)
A.ok(mktCss.includes('.mkt-recipes .mkt-rec-rail:not(.mkt-rail-deep) { grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr)); }')
  && !/\.mkt-recipes \.mkt-rec-rail:not\(\.mkt-rail-deep\) \{ grid-template-columns: repeat\(3/.test(mktCss),
  'a recipe suggestion card is never under 240px: a narrow list shows them as rows, a wide one two or three across');
// the quest pass: every tier in view; the PROGRESS tab: the dock map is one of the page's folds
const questCss = read('frontend/css/quests.css'), suiJs = read('frontend/app/stationui.js');
const trackRule = (questCss.match(/\.quests-win \.bp-track \{([^}]*)\}/) || [])[1] || '';
A.ok(/flex-wrap: wrap;/.test(trackRule) && !/overflow|scrollbar/.test(trackRule),
  'the tier track wraps in a narrow window and never scrolls sideways: no tier sits off the edge behind a scrollbar');
A.ok(questCss.includes('.quests-win .bp-node { flex: 1 1 80px;') && questCss.includes('.quests-win .bp-node :is(.bp-here, .bp-node-frame, .bp-need, .bp-got, .bp-claim) { white-space: nowrap; }'),
  'the tiers share the line in equal parts (never under 80px) and a tier’s one-line labels stay one line');
A.ok(suiJs.includes("'<ol class=\"bp-track\">' + nodes + '</ol>'") && suiJs.includes("const box = '.------.\\n| T ' + pad(t.tier) + ' |\\n\\'------\\'';"),
  'and the pass keeps its drawn track: the same boxes and links, only laid out so all of them show');
const sysFn = suiJs.slice(suiJs.indexOf('function systemsHtml()'), suiJs.indexOf('function refreshSystems()'));
A.ok(sysFn.includes("'<details class=\"q-systems q-progress-section\" id=\"q-systems\"' + (openNow ? ' open' : '') + '><summary><span>Station systems</span><span class=\"q-section-note\">'")
  && sysFn.includes("+ s.online + ' OF ' + s.total + ' ONLINE</span></summary><div class=\"q-section-body\">'"),
  'STATION SYSTEMS is a fold with the page’s own fold recipe; its count (read from the dock’s snapshot) stays on the strip');
A.ok(sysFn.includes("const openNow = fresh || (sysFoldUser != null ? sysFoldUser : s.online < s.total);") && sysFn.includes("const fresh = s.list.some(x => x.fresh);"),
  'it opens itself while a system is missing from the dock or has just come online, and otherwise keeps the Commander’s last choice');
A.ok(['q-star-map q-sys-map', 'q-sys-all', 'arc-bar q-bar', "data-sys=\"' + esc(x.id)"].every(k => sysFn.includes(k)) && sysFn.includes("strip.addEventListener('click', ev => { if (!ev.defaultPrevented) sysFoldUser = !root.open; });"),
  'nothing left the block: every tile, the bar and SHOW EVERYTHING are inside the fold, and a hand-turned fold is remembered');
// folds
const FOLDS = ':is(.perm-fold, .ch-setup, .mkt-orders, .mkt-model-settings, .mkt-brief, .si-more, .q-progress-section, .q-journal-records > details, .q-refresh-options, .mc-adv, .mc-effective-payer, .mkt-library-more, .mkt-recipe-instructions, .platform-guide)';
A.ok(/^content: ''; display: inline-block;/.test(ruleX(FOLDS + ' > summary::before')) && /border: 0; border-right: 1\.5px solid currentColor; border-bottom: 1\.5px solid currentColor; transform: rotate\(-45deg\);$/.test(ruleX(FOLDS + ' > summary::before')),
  'a fold is marked by a drawn chevron in the summary’s own ink (any older drawn triangle is cleared first)');
A.eq(ruleX(FOLDS + '[open] > summary::before'), 'transform: rotate(45deg);', 'which turns down when the fold is open');
const NATIVE = ':is(.mc-effective-payer, .mkt-library-more, .mkt-recipe-instructions) > summary';
A.eq(ruleX(NATIVE), 'list-style: none;', 'a fold that still showed the browser’s own triangle loses it');
A.eq(ruleX(NATIVE + '::-webkit-details-marker'), 'display: none;', 'in both engines (WebView2 reads list-style, WebKit reads its marker)');
A.ok(NATIVE.slice(4, NATIVE.indexOf(')')).split(', ').every(k => FOLDS.includes(', ' + k + ',')), 'and each of them takes the drawn chevron instead: none is left without a mark');
// what the format must never do
A.eq((cssX.match(/--vx-[a-z-]+:/g) || []).length, 0, 'the format defines no material: every surface is one the dark knob already takes down');
A.eq([...new Set(cssX.match(/(?<![a-z-])content:[^;]*;/g) || [])].sort().join(' '), "content: ''; content: none;", 'the format writes no word: it removes old marks and draws two parts, the lamp and the chevron');
A.eq([...new Set(cssX.match(/(?<![a-z-])position:[^;]*;/g) || [])].join(' '), 'position: static;', 'nothing is lifted out of the flow');
A.ok(!/font-family|z-index|animation|transition|(?<![a-z-])float:/.test(cssX), 'the format changes no face and adds no motion or stacking');
A.ok(!/\.cmsg|#chat-log|#chat-panel|\.dg-line|presence|\.nudge|\.consent/.test(cssX), 'the format names nothing inside the conversation');
A.ok(!/\.q-pass|\.bp-|battle/.test(cssX), 'the battle pass keeps its drawn reward track');
A.ok(!/[;{\s]filter:\s/.test(cssX) && !/#stage-wrap/.test(cssX) && !/\[class/.test(cssX), 'the format declares no filter, styles nothing under #stage-wrap and adds no [class] selector');
A.ok(!/@/.test(cssX), 'the format has no at-rule');
A.ok(!/url\(/.test(cssX) && !/repeating-/.test(cssX) && !/background-size/.test(cssX), 'a screen stays plain: the format draws no crest, trace, scan line or grid');

// ---- THE DEEP END of the dark knob (Andrew 2026-11-10: "improve the brightness as well, lets make it to be able to get
// really dark for the dashboard"). The knob is the same SETTINGS › BRIGHTNESS slider; at 0 nothing may change, so every
// veil's alpha is a product with the knob and every flipped ink starts from the old ink ----
const dkAt = cssA.indexOf('--vx-dk: calc(var(--vx-dim, 0) / .85);');
const dkRule = dkAt < 0 ? '' : cssA.slice(cssA.lastIndexOf('}', dkAt) + 1, cssA.indexOf('}', dkAt) + 1).replace(/\s+/g, ' ').trim();
A.ok(dkRule.startsWith('html body.vx:not(.hud-mode) {'), 'the deep end’s tokens sit on the body in the shared sections, so they reach every part without moving a locked rule');
for (const [tok, val] of [['veilc', 'calc(var(--vx-dk) * .88)'], ['keyc', 'calc(var(--vx-dk) * .5 + var(--vx-night) * (.48 - var(--vx-dk) * .1))'], ['litc', 'calc(var(--vx-dk) * .5)'], ['onc', 'calc(var(--vx-dim, 0) * .35)']]) {
  A.ok(dkRule.includes('--vx-' + tok + ': rgba(0, 0, 0, ' + val + ');'), 'the ' + tok + ' veil is black at an alpha that is 0 when the knob is 0');
}
A.ok(dkRule.includes('--vx-night: 0; --vx-inkp: 0%;'), 'outside the guard the legends never flip: the keys stop at the half veil and keep their dark ink');
A.ok(css.includes(INK_GUARD + ' {\n  html body.vx:not(.hud-mode) {\n    --vx-night: clamp(0, calc((var(--vx-dk) - .325) * 1000), 1);\n    --vx-inkp: calc(var(--vx-night) * 100%);\n  }\n}'),
  'inside the guard the night step goes 0 to 1 between -30 and -35 (the slider moves in fives) and the ink follows it: a dark legend on a half-dimmed key was about 3.4:1 at -50');
A.ok(dkRule.includes('--vx-ink: color-mix(in srgb, #06100a, var(--vx-core) var(--vx-inkp));') && dkRule.includes('--vx-ink2: color-mix(in srgb, #0b1014, var(--vx-core) var(--vx-inkp));')
  && dkRule.includes('--vx-ink-hot: color-mix(in srgb, #020604, color-mix(in srgb, var(--vx-core) 55%, #fff) var(--vx-inkp));'),
  'a key legend is the old dark ink until the night step, then the lit ink: a dark key never carries a dark legend');
A.eq((css.match(/var\(--vx-dim\)/g) || []).length, 0, 'the knob is always read with a 0 fallback: a station that never set it is undimmed');
// the bare metal goes down under veils
A.ok(/#screen-game\.active \{\s*background:\s*var\(--vx-veilg\),/.test(cssA) && /#chat-panel #chat-inputrow \{[^}]*background:\s*var\(--vx-veilg\),/.test(cssA), 'the chassis and the composer deck take the deep veil');
A.ok(/:is\(#topbar, #bottombar\) \{\s*box-shadow: inset 0 0 0 200px var\(--vx-veilc\),/.test(cssA), 'the two bars take it as an inset wash, so the legends on them are never filtered');
A.ok(/--vx-seat: var\(--vx-veilg\), /.test(cssA) && /--vx-knob: var\(--vx-keyg\), /.test(cssA) && /--vx-knob-hot: var\(--vx-keyg\), /.test(cssA) && /--vx-lcd-shadow: var\(--vx-lip3\), /.test(cssA),
  'seats, knobs and the chrome lip round a readout carry their veil in the token, so every user of the token goes down with it');
A.eq((cssA.match(/linear-gradient\(rgba\(0, 0, 0, calc\(var\(--vx-dim, 0\) \* \.9\)\), rgba\(0, 0, 0, calc\(var\(--vx-dim, 0\) \* \.9\)\)\)/g) || []).length, 2,
  'the two panels’ glass and a window’s glass go equally deep');
A.ok(/:is\(#left, #chat-panel\)::after \{\s*filter: brightness\(calc\(1 - var\(--vx-dim, 0\) \* 1\.02\)\)/.test(cssA) && /\.term:not\(\.pw\)::after \{ filter: brightness\(calc\(1 - var\(--vx-dim, 0\) \* 1\.02\)\)/.test(cssA),
  'the chrome frames of the panels and the windows go to black (they carry no legend, so a filter is safe there)');
A.ok(/opacity: calc\(1 - var\(--vx-dim, 0\) \* \.65\)/.test(cssA), 'the bars’ light pipes ease down with the knob');
A.ok(/\[aria-current="page"\]\) \{\s*background:\s*var\(--vx-litg\),/.test(cssA), 'the chosen session band eases down under its white words');
// the station view's bezel: the one housing that may not take a filter
const silP = (cssP.match(/#screen-game:not\(\.cinema\) #stage-wrap \.cam-hud::before \{[^}]*\}/) || [''])[0];
A.ok(/background: #000; -webkit-mask-box-image: url\("vx\/win\.png"\) 92 \/ 46px stretch;\s*opacity: calc\(var\(--vx-dk\) \* \.86\);/.test(silP) && /pointer-events: none/.test(silP) && !/filter/.test(silP),
  'the station view’s bezel darkens under a black cut-out of its own 9-slice (no filter near the world, and it never catches a click)');
// keys: off keys ease down, lit keys take one step, never two
A.ok(/--vx-cap: var\(--vx-litg\), /.test(cssA) && /--vx-cap-hot: var\(--vx-litg\), /.test(cssA), 'an off cap’s sheen eases down (its legend is lit, so the veil only helps it)');
A.ok(/--vx-cap-on: var\(--vx-ong\), var\(--vx-cap-on-raw\);/.test(cssA) && /--vx-gloss:\s*var\(--vx-ong\),/.test(cssA), 'a lit cap and the lit nav key take the mild lit veil (dark ink on them stays above 7:1)');
A.ok(/#chat-panel #chat-inputrow \{ filter: brightness\(calc\(1 - var\(--vx-dim, 0\) \* \.35\)\); --vx-cap-on: var\(--vx-cap-on-raw\); \}/.test(cssA),
  'the three housings that already take their keys down with a filter hand their lit keys the raw fill');
A.eq((css.match(/--vx-cap-on: var\(--vx-cap-on-raw\);/g) || []).length, 1, 'so a lit key is dimmed once, never twice (twice puts its dark legend under 4:1)');
// every chrome lip goes down: none is left bare to stay white in a dark room
A.eq((css.match(/box-shadow: 0 0 0 1px #000, 0 0 0 2px #c4ccd5/g) || []).length, 0, 'no chrome ring is left without its lip veil');
A.eq((css.match(/box-shadow: inset 0 -1px 0 #2a3037/g) || []).length, 0, 'no head’s chrome lip is left without its veil');
// the screens before the station is up
A.ok(/^background: var\(--vx-veilg\),/.test(ruleL(':is(#screen-boot, #screen-splash)')), 'the cabinet round the boot loader and the title screen goes down too');
A.ok(/#screen-lineage\)\.active \{\s*background:\s*var\(--vx-veilg\),/.test(cssA) && /#screen-lineage\) \.ov-foot \{[^}]*background:\s*var\(--vx-veilg\),/.test(cssA),
  'and the steel backdrop and foot rail of the full screens (the lit card on them stays lit)');
// ---- THE THEME KEYS + AI & MODELS (Andrew 2026-11-12: "the flat solid phosphor theme colors, they are very flat and the color
// icon should have that reflectiveness" and "the AI and models is a bit ugly ... needs to look and be a bit more presentable").
// A theme colour is a lit glass key in its own colour, with the gloss the chosen rail key wears. AI & MODELS is laid out
// as the device: its groups sit straight on the screen under a lit label and a hairline, a provider's mark sits in a dark
// seat, a status has the room to read on one line and a saved key's actions are one row. Nothing is added or removed ----
const XGLOSS = 'linear-gradient(180deg, color-mix(in srgb, var(--sw) 45%, #fff) 0, color-mix(in srgb, var(--sw) 78%, #fff) 47%, var(--sw) 51%, color-mix(in srgb, var(--sw) 72%, #000) 100%)';
const railGloss = (cssA.match(/--vx-gloss:\s*var\(--vx-ong\),\s*(linear-gradient\([^;]*\));/) || [])[1] || '';
A.eq(railGloss.replace(/var\(--vx-core\)|var\(--ph\)/g, 'var(--sw)'), XGLOSS, 'a theme colour wears the chosen rail key’s gloss, stop for stop, in its own colour');
const swKey = ruleX('.set-theme.settings-swatch');
A.ok(swKey.includes('background: var(--vx-ong), ' + XGLOSS + ';'), 'a theme colour is lit glass, never a flat fill, and it dims with BRIGHTNESS by the lit key’s own veil');
A.ok(/box-shadow: inset 0 1px 0 rgba\(255, 255, 255, \.6\), inset 0 -2px 0 rgba\(0, 0, 0, \.3\), 0 0 0 1px #000, 0 2px 4px rgba\(0, 0, 0, \.6\);$/.test(swKey), 'it has a bright top edge and sits in a black ring: edges, not a glow');
A.ok(!/background: var\(--sw\)\s*;/.test(cssX), 'no rule in the format paints a theme colour as a flat fill');
A.ok(ruleX('.set-theme.settings-swatch[aria-pressed="true"]').endsWith('0 0 0 1px #000, 0 0 12px color-mix(in srgb, var(--sw) 55%, transparent);'), 'the chosen colour glows in its own colour (its ring stays the base sheet’s outline)');
const swAny = ruleX('.set-theme.settings-swatch-custom');
const themeHexes = (read('frontend/app/stationui.js').match(/const THEMES = \[(.*?)\];/) || ['', ''])[1].match(/#[0-9a-f]{6}/g) || [];
A.ok(swAny.includes('var(--vx-ong),') && /linear-gradient\(180deg, rgba\(255, 255, 255, \.5\) 0, rgba\(255, 255, 255, \.2\) 47%, rgba\(255, 255, 255, 0\) 51%, rgba\(0, 0, 0, \.28\) 100%\)/.test(swAny), 'the any-colour key is the same glass: light above the fold line, shade below it');
A.eq(['#ff4136', '#ffaa33', '#3dff70', '#46c8ff', '#b46bff'].filter(h => !themeHexes.includes(h) || !swAny.includes(h)).join(' | '), '', 'and under the glass it shows the station’s own theme colours, not a pastel rainbow');
A.ok(/#screen-connect \.phosphor-swatches \.swatch::before \{\s*background: linear-gradient\(180deg, color-mix\(in srgb, var\(--sw\) 45%, #fff\) 0, color-mix\(in srgb, var\(--sw\) 78%, #fff\) 47%, var\(--sw\) 51%, color-mix\(in srgb, var\(--sw\) 72%, #000\) 100%\);/.test(cssA),
  'the first-run screen’s colour chips are the same lit glass');
// AI & MODELS
const setBase = read('frontend/css/settings.css');
A.eq(ruleX('.settings-group:has(> .prov-list)'), 'padding: 0; border: 0; border-radius: 0; background: none; box-shadow: none;', 'the ways to connect are not a card holding cards: their group is not a pane');
const provGroup = ruleX('.prov-list > .prov-group');
A.ok(provGroup.includes('justify-content: space-between;') && provGroup.includes('border-bottom: 1px solid var(--vx-hair); border-radius: 0;') && !/margin-left: auto|text-align: right/.test(provGroup + ruleX('.prov-list > .prov-group > .set-sub-d')),
  'a group is a label, its note at the far end and one straight hairline; in a narrow window the note drops under the label and starts at the left');
A.ok(ruleX('.prov-list > .prov-group > .set-sub-k').endsWith(XLIT), 'a group’s label is lit type, as a module’s title is');
A.eq(ruleX('.prov-card'), '--prov-mark: 44px; --prov-stat-w: fit-content(58%);', 'a card hands the base sheet two sizes: the mark’s column and a status column wide enough for one line');
A.ok(setBase.includes('grid-template-columns:minmax(0,1fr) var(--prov-stat-w,190px);') && setBase.includes('grid-template-columns:var(--prov-mark,30px) minmax(0,1fr);'), 'the base sheet reads both sizes and keeps its own when no look sets them');
A.eq((setBase.match(/calc\(var\(--prov-mark,30px\) \+ 12px\)/g) || []).length, 2, 'the narrow layout’s two indents follow the mark');
A.ok(!/(margin|padding)-left:42px/.test(setBase), 'so no fixed indent is left to fall out of line with a wider mark');
A.eq(ruleX('.prov-card:not([data-provider="starnet"]) > .prov-select::before'), "content: ''; grid-column: 1; grid-row: 1; width: 44px; height: 44px; border-radius: 9px; background: var(--vx-well); box-shadow: var(--vx-read-shadow);",
  'a provider’s mark sits in a dark seat: a readout well drawn in the mark’s own cell (no positioning, no second element)');
A.eq(ruleX('.prov-card:not([data-provider="starnet"]) > .prov-select > .prov-logo'), 'grid-column: 1; grid-row: 1; place-self: center;', 'the mark is centred in its seat');
A.eq(ruleX('.prov-card:not([data-provider="starnet"]) > .prov-select > .prov-main'), 'grid-column: 2; grid-row: 1;', 'and the name keeps the second column');
A.eq(ruleX('.prov-logo-starnet'), 'color: var(--ph);', 'the STARNET wordmark on its card is the theme colour, as the mark in the top bar is');
A.eq(ruleX('.prov-card > .prov-accounts'), 'margin-top: 6px; padding-top: 12px; border-top: 1px solid var(--vx-hair); border-radius: 0;', 'a card’s accounts sit under one straight hairline');
A.eq(ruleX('.settings-pane .key-list > .key-row'), 'flex-wrap: wrap;', 'a saved key’s row may wrap');
A.eq(ruleX('.settings-pane .key-list > .key-row > .key-main'), 'flex: 1 1 200px;', 'its name keeps 200px before the keys drop under it');
A.eq(ruleX('.settings-pane .key-list > .key-row > .key-acts'), 'flex-direction: row; justify-content: flex-end; margin-left: auto;', 'and its actions are one row of keys at the far end, never a stack');
const provJs = read('frontend/app/stationui.js');
A.ok(provJs.includes('class="set-theme settings-swatch settings-swatch-custom ') && provJs.includes("data-act=\"prov-claude-add\"") && provJs.includes('data-act="pool-edit"') && provJs.includes('data-act="rm"'),
  'nothing is removed: the any-colour key, ADD ACCOUNT, SPARE KEYS and REMOVE are all still drawn');

// ---- section 33, the first test's fixes (Andrew 11-14): VECTOR only, and each fault pinned by the state it lost ----
const TPFX = 'html body.vx:not(.hud-mode):not(.vx-b)';
const selsT = selsOf(cssT);
A.ok(selsT.length >= 30, 'the first test’s fixes are their own section (' + selsT.length + ' selectors)');
A.eq(selsT.filter(x => !x.startsWith(TPFX + ' ') && !x.startsWith(TPFX + ':not(.vx-dimmed) ')).join(' | '), '', 'every selector there opens with the VECTOR gate (five of them with the undimmed gate too): variation B never sees it');
A.eq(stray(cssT, ':not(.vx-b)').filter(x => x !== TPFX + ':not(.vx-dimmed)').join(' | '), '', 'and none slips its scope inside a one-line list');
A.ok(!/\[class/.test(cssT) && !/#stage-wrap [^{]*\{[^}]*filter/.test(cssT), 'no [class] selector, and nothing filters the world');
const rulesT = cssT.split('}').filter(r => r.includes('{')).map(r => ({ sel: r.slice(0, r.indexOf('{')).split(TPFX).join('').replace(/\s+/g, ' ').trim(), body: r.slice(r.indexOf('{') + 1).replace(/\s+/g, ' ').trim() }));
const ruleT = (sel) => (rulesT.find(r => r.sel === sel) || { body: '' }).body;
// the roster: section 22 flattens every row with !important, so each state a row can be in has to out-rank it and say !important too
const CREWROW = '#screen-game #left #crew > .crew-row.crew-row.crew-row';
const flatRow = (css.match(/#screen-game #left #crew > \.crew-row\.crew-row\.crew-row \{[^}]*\}/) || [''])[0];
A.ok(/background: transparent !important;/.test(flatRow) && /box-shadow: none !important;/.test(flatRow), 'the roster is a flat screen: every row starts transparent');
const hov = ruleT(CREWROW + ':not(.selected):not(.filtering):not(.asking):is(:hover, :focus-visible)');
A.ok(/^background: linear-gradient\([^;]*rgba\(var\(--ph-rgb\), \.2\)[^;]* !important; box-shadow: [^;]* !important;$/.test(hov), 'a crew row under the pointer (or the keyboard) lights: a glass band over the flat screen');
const narrowed = ruleT(CREWROW + '.filtering:not(.asking)');
A.ok(/!important; box-shadow: inset 3px 0 0 var\(--vx-node\)[^;]* !important;$/.test(narrowed), 'the agent the rail is narrowed to (a click) is the lit band with a lead bar');
A.eq(ruleT('#screen-game #left #crew:has(> .crew-row.filtering) > .crew-row.crew-row.crew-row.selected:not(.filtering):not(.asking):not(:hover):not(:focus-visible)'),
  'background: transparent !important; box-shadow: none !important;', 'while the rail is narrowed, the narrowed row is the only lit one');
const waitRow = ruleT(CREWROW + '.asking');
A.ok(/rgba\(var\(--gold-rgb\), \.26\)/.test(waitRow) && /box-shadow: inset 3px 0 0 var\(--gold\)[^;]* !important;$/.test(waitRow), 'a wait keeps its gold, on a chosen row too');
// NEEDS YOU: a screen on the rail, its keys caps
A.eq(ruleT('#screen-game #left .ws-needs:not([hidden])'), 'margin: 4px 15px 8px; padding: 2px 0 4px; border-radius: 12px; corner-shape: round; background: var(--vx-lcd); box-shadow: var(--vx-lcd-shadow);',
  'NEEDS YOU is a screen on the rail: the roster’s gutter, the same LCD in the same chrome ring');
A.ok(/border: 0 !important;/.test(ruleT('#screen-game #left .ws-needs .ny-panel')), 'its old framed panel is gone: the screen is the frame');
A.ok(/rgba\(var\(--ny-k\), \.26\)/.test(ruleT('#screen-game #left .ws-needs .ny-grp')), 'a kind’s strip is lit in the kind’s own colour (a wait gold, a failure red)');
A.ok(/background: var\(--vx-cap\) border-box !important; box-shadow: var\(--vx-cap-shadow\) !important;/.test(ruleT('#screen-game #left .ws-needs :is(.ny-key, .ny-more)')), 'its keys are the glossy caps');
A.ok(/^color: var\(--bad\);/.test(ruleT('#screen-game #left .ws-needs .ny-key.deny')), 'Deny keeps its red legend');
const nyJs = read('frontend/app/needsyou.js');
A.ok(nyJs.includes('class="ny-key') && nyJs.includes('class="ny-more"') && nyJs.includes('class="ny-grp"') && nyJs.includes('class="ny-face"'), 'and those are the parts needsyou.js draws');
// the shut stage: the grid says it, one seam draws the clamps
const crJs = read('frontend/app/chatresize.js');
A.ok(/new ResizeObserver\(sayShut\)\.observe\(stageWrap\)/.test(crJs) && crJs.includes("game.classList.toggle('stage-shut', shut)") && crJs.includes("game.style.setProperty('--stage-now', w + 'px')"),
  'the grid says when the stage is shut, and how wide the sliver is, from the stage’s own box');
A.ok(!/stage-shut/.test(read('frontend/app/world.js')) && !/body\.vx|classList\.contains\('vx'\)/.test(crJs), 'the world never reads that state, and the seam code never reads the look');
A.eq(ruleT('#screen-game.stage-shut .col-resizer::before'), 'content: none;', 'shut, the COMMS seam draws no clamp');
A.eq(ruleT('#screen-game.stage-shut .crew-resizer::before'), 'left: calc(10px + var(--stage-now, 2px) / 2); width: 36px; margin-left: -18px; background-size: 36px 18px;',
  'and the crew seam (the one stacked on top) draws ONE row, centred across both conduits');
A.eq(ruleT('#screen-game.stage-shut #stage-wrap'), 'visibility: hidden;', 'a shut stage draws no sliver of bezel');
// the window searches and the menu rail keys
const FINDERS = '#screen-game #terms .term:not(.pw) :is(.con-search .con-search-in, .mkt-search, #dl-query)';
A.ok(/border-radius: 999px !important;[^}]*background: var\(--vx-lcd\) !important;/.test(ruleT(FINDERS)), 'every window search is the rail’s finder: an LCD pill');
const lensRail = (css.match(/\.ws-rail-search label::before \{[^}]*?mask: (url\("[^"]+"\))/) || [])[1] || 'none';
A.ok(ruleT('#screen-game #terms .term:not(.pw) .con-search .con-search-i, #screen-game #terms .term:not(.pw) .mkt-search::before').includes('mask: ' + lensRail), 'with the rail finder’s own lens at its lead');
const stJs = read('frontend/app/stationui.js'), dlJs = read('frontend/app/deliverables.js');
A.ok(stJs.includes('class="con-search-i"') && stJs.includes('class="con-search-in"') && mktJs.includes('<div class="mkt-search">') && dlJs.includes('<input id="dl-query"'), 'and those are the three search fields the windows draw');
A.ok(/background: var\(--vx-cap-hot\) border-box; box-shadow: var\(--vx-cap-shadow\);/.test(ruleT('#screen-game #terms .term.sn-menu .con-rail-item:not(.con-toptab):is(:hover, :focus-visible):not(.active):not([aria-selected="true"])')),
  'a menu’s rail key hovers as a glossy cap, never a flat outline');
// the desktop title bar
const tbCss = read('frontend/css/titlebar.css'), tbJs = read('frontend/app/titlebar.js');
A.ok(/var\(--vx-grain\)/.test(ruleT('#sn-titlebar')) && /^border-bottom: 0;/.test(ruleT('#sn-titlebar')), 'the desktop title bar is the device’s top rail: brushed silver, no green hairline');
A.ok(/border-radius: 999px;/.test(ruleT('#sn-titlebar .sn-tb-btn')) && /#ff6a5c/.test(ruleT('#sn-titlebar .sn-tb-x:hover')), 'its controls are chrome domes, and close goes hazard red under the pointer');
A.ok(tbCss.includes('#sn-titlebar { display: none; }') && tbJs.includes("b.className = 'sn-tb-btn'") && tbJs.includes("'sn-tb-x'"), 'and it is still drawn only where the shell asks for it (titlebar.css keeps it off everywhere else)');
// the lag: no brightness pass while the knob is at 0, and the same rules as ever the moment it moves
const DIMGATE = TPFX + ':not(.vx-dimmed)';
const suiDim = read('frontend/app/stationui.js');
A.ok(suiDim.includes("document.body.classList.toggle('vx-dimmed', Number(dim.toFixed(3)) > 0);"), 'stationui says whether the BRIGHTNESS knob is darkening at all: vx-dimmed exactly while the --vx-dim it wrote is above 0');
const undim = cssT.split('}').filter(r => r.includes(':not(.vx-dimmed)')).map(r => ({ sel: r.slice(0, r.indexOf('{')).split(DIMGATE).join('').replace(/\s+/g, ' ').trim(), body: r.slice(r.indexOf('{') + 1).replace(/\s+/g, ' ').trim() }));
const undimOf = (sel) => (undim.find(r => r.sel === sel) || { body: '' }).body;
A.eq(undim.length, 5, 'five rules lift the no-op pass');
A.eq(undim[0].sel + ' => ' + undim[0].body, '#screen-game :is(#left, #chat-panel) > h3, #screen-game #bottombar .bb-group, #screen-game #left .ws-head :is(.ws-view, .ws-head-acts), #screen-game #chat-panel #chat-inputrow => filter: none;',
  'undimmed, the rail heads, the bar groups, the SESSIONS keys and the composer carry no filter at all (brightness(1) was an offscreen pass for the same picture)');
// a chained shadow stays exactly as the dimmed rule draws it: only the brightness stage leaves
const chained = (re) => { const all = cssA.match(re) || []; const last = all[all.length - 1] || ''; return (/filter: ([^;]*);/.exec(last) || ['', ''])[1].replace(/ ?brightness\(calc\(1 - var\(--vx-dim, 0\) \* [\d.]+\)\) ?/, '').trim(); };
A.eq(undimOf('#screen-game :is(#left, #chat-panel)::after'), 'filter: ' + chained(/#screen-game :is\(#left, #chat-panel\)::after \{\s*filter: brightness[^}]*\}/g) + ';', 'the rail bezels keep their two cast shadows');
A.eq(undimOf('.term:not(.pw)::after'), 'filter: ' + chained(/\.term:not\(\.pw\)::after \{ filter: brightness[^}]*\}/g) + ';', 'a window’s bezel keeps its cast shadow');
A.eq(undimOf('#screen-game :is(.crew-resizer, .col-resizer)'), 'filter: ' + chained(/#screen-game :is\(\.crew-resizer, \.col-resizer\) \{[^}]*brightness[^}]*\}/g) + ';', 'the seams keep their glow');
A.eq(undimOf('#screen-game :is(.crew-resizer, .col-resizer)::before'), 'filter: ' + chained(/#screen-game :is\(\.crew-resizer, \.col-resizer\)::before \{[^}]*brightness[^}]*\}/g) + ';', 'and the clamps their shadow');
A.ok(!/vx-dimmed/.test(cssA + cssBase + cssB + cssP + cssF + cssH + cssN + cssI + cssC + cssL + cssX), 'nothing before section 33 knows the class: with it set, the darkening rules apply exactly as they were written');
// ---- section 34 · THE SECOND TEST (Andrew 2026-11-14, after the next build: NEEDS YOU "does not match our new vibe", "the
// panel that pops up ... doesnt match that well", "deliverables needs to be updated", the dossier's "growth section needs some
// love ... same as the brief"). Dress and layout of four surfaces from parts the device already has ----
const SPFX = TPFX + ' #screen-game ';
const selsS = selsOf(cssS);
A.ok(selsS.length >= 140, 'the second test’s four surfaces are their own section (' + selsS.length + ' selectors)');
A.eq(selsS.filter(x => !x.startsWith(SPFX)).join(' | '), '', 'every selector there opens with the VECTOR gate on the game screen: variation B never sees it');
A.eq(stray(cssS, ':not(.vx-b)').join(' | '), '', 'and none slips its scope inside a one-line list');
A.ok(!/\[class/.test(cssS) && !/@/.test(cssS) && !/[;{\s]filter:\s/.test(cssS) && !/#stage-wrap/.test(cssS), 'it has no [class] selector, no at-rule and no filter, and styles nothing under #stage-wrap');
A.ok(!/font-family|z-index|animation|transition|display: none|visibility|content: '[^']/.test(cssS), 'it changes no face, adds no motion or stacking, hides nothing and writes no word');
A.eq(selsS.map(x => x.slice(SPFX.length)).filter(x => !/^(#left \.ws-needs[ :]|#terms \.term:not\(\.pw\) )/.test(x)).join(' | '), '', 'it reaches NEEDS YOU on the rail and the inside of a station window, nothing else');
const rulesS = cssS.split('}').filter(r => r.includes('{')).map(r => ({ sel: r.slice(0, r.indexOf('{')).split(SPFX).join('').replace(/\s+/g, ' ').trim(), body: r.slice(r.indexOf('{') + 1).replace(/\s+/g, ' ').trim() }));
const ruleS = (sel) => (rulesS.find(r => r.sel === sel) || { body: '' }).body;
const SWIN = '#terms .term:not(.pw) ';
// every class the section dresses is one its source really draws (a rule for a class nobody emits is a dead promise)
const namedS = (re) => [...new Set(cssS.match(re) || [])].map(c => c.slice(1));
A.eq(namedS(/\.ny-[a-z-]+/g).filter(c => !nyJs.includes(c)).join(' '), '', 'every .ny- class it names is drawn by needsyou.js');
A.eq(namedS(/\.dlv-[a-z-]+/g).filter(c => !dlJs.includes(c)).join(' '), '', 'every .dlv- class it names is drawn by deliverables.js');
A.eq(namedS(/\.(?:ag|gx|stat)-[a-z0-9-]+/g).filter(c => !stJs.includes(c)).join(' '), '', 'every dossier class it names is drawn by stationui.js');
// NEEDS YOU: the roster head's twin
const BAYLIP = '0 0 0 1px #000, 0 0 0 2px #c4ccd5, 0 1px 0 2px #eef2f6, 0 0 0 3px #2a3037';
const KEYDOME = 'linear-gradient(180deg, #f4f7fa 0, #e9edf1 26%, #c3cad2 50%, #8f98a3 74%, #6b747f 100%)';
A.ok(ruleS('#left .ws-needs .ny-head').includes(BAYLIP) && cssH.includes(BAYLIP), 'the NEEDS YOU head is the CREW head’s bay: the same black well in the same chrome lip');
A.ok(ruleS('#left .ws-needs .ny-title').includes(KEYDOME) && cssH.includes(KEYDOME), 'its name sits on the same silver key as CREW and COMMS');
A.ok(/^margin-left: auto;|; margin-left: auto;/.test(ruleS('#left .ws-needs .ny-count')) && /color: var\(--gold\)/.test(ruleS('#left .ws-needs .ny-count')), 'the count is lit type at the far end of the bay, in the wait colour');
A.ok(/^content: none;/.test(ruleS('#left .ws-needs .ny-head::after')), 'the old hairline between the name and the count is gone (the bay parts them)');
A.ok((ruleS('#left .ws-needs .ny-grp').match(/gradient\(/g) || []).length === 3 && /rgba\(var\(--ny-k\), \.55\)/.test(ruleS('#left .ws-needs .ny-grp')) && /#050607 48%/.test(ruleS('#left .ws-needs .ny-grp')),
  'a kind’s strip is a dark glossy cap lit from below in the kind’s colour, never a flat wash of it');
A.ok(/background: var\(--vx-knob\)/.test(ruleS('#left .ws-needs .ny-go')) && /transform: none/.test(ruleS('#left .ws-needs .ny-go')) && /rotate\(45deg\)/.test(ruleS('#left .ws-needs .ny-go::before')),
  'a row that only opens ends in a chrome knob with the caret drawn on it');
A.ok(/background: none; box-shadow: none/.test(ruleS('#left .ws-needs:not([hidden])')), 'the module itself is no box: the head bay and the one screen under it are the two parts');
// DELIVERABLES
A.ok(/background: var\(--vx-knob\)/.test(ruleS(SWIN + '.dlv-caret')) && /font-size: 0/.test(ruleS(SWIN + '.dlv-caret')) && /rotate\(135deg\)/.test(ruleS(SWIN + '.dlv-head.on > .dlv-caret::before')),
  'a deliverable opens on a chrome knob whose caret turns down when its drawer is open');
A.ok(!/(^|; )color:/.test(ruleS(SWIN + '.dlv-pill')) && /currentColor/.test(ruleS(SWIN + '.dlv-pill::before')), 'a status jewel is lit in the colour the source gave that status: the look sets none of its own');
A.ok(/background: var\(--vx-cap-on\) border-box/.test(ruleS(SWIN + '.dlv-chip.on')) && /background: var\(--vx-cap\) border-box/.test(ruleS(SWIN + '.dlv-chip')), 'a kind is a console key, the chosen one lit');
A.ok(/background: var\(--vx-pane\); box-shadow: var\(--vx-pane-shadow\)/.test(ruleS(SWIN + '.dlv-card')) && /background: var\(--vx-well\); box-shadow: var\(--vx-read-shadow\)/.test(ruleS(SWIN + ':is(.dlv-quote, .dlv-said)')),
  'a piece of work is a pane of the window’s glass; the ask and the answer sit in recessed screens');
A.ok(/var\(--gold-rgb\)/.test(ruleS(SWIN + '.dlv-needs')) && /#050607 46%/.test(ruleS(SWIN + '.dlv-needs')), 'the route to what needs a decision is a cap lit in the wait colour');
// the dossier
A.ok(/grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 250px\), 1fr\)\)/.test(ruleS(SWIN + '.ag-growth .gx-2')) && /^grid-column: 1 \/ -1;/.test(ruleS(SWIN + '.ag-growth .gx-2 > #gx-practice')),
  'the two measured scores stand side by side at full width and PRACTICE runs under both (they were four 150px columns, two of them empty)');
A.ok(/grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 188px\), 1fr\)\)/.test(ruleS(SWIN + '.ag-growth .gx-tros')) && /white-space: nowrap; overflow: hidden; text-overflow: ellipsis/.test(ruleS(SWIN + '.ag-growth .gx-tro .nm')),
  'a trophy is wide enough to keep its name on one line (96px tiles broke FIRST LIGHT in two and cut DEPENDABLE)');
A.ok(/font-size: 16px !important/.test(ruleS(SWIN + '.ag-growth .ag-xp-panel .gx-row')), 'the XP lines read at 16px (agent-dossier.css pinned them to 13px)');
A.ok(!/canvas|#ag-portrait/.test(cssS), 'the portrait canvas is never resized or restyled: the figure is the floor’s own drawing');
A.ok(/background: var\(--vx-knob\)/.test(ruleS(SWIN + '.ag-setup-go')) && /font-size: 0/.test(ruleS(SWIN + '.ag-setup-go')), 'a SET UP AS tile ends in the knob that opens it');
const sizesS = (cssS.match(/font-size: (\d+(?:\.\d+)?)px/g) || []).map(x => Number(x.replace(/[^\d.]/g, '')));
A.ok(sizesS.length > 40 && Math.min(...sizesS) >= 14, 'no type in the section is under 14px (smallest ' + Math.min(...sizesS) + ')');
// ---- section 35 · THE CREW LENS (Andrew 2026-11-15: "improve the agent profile pictures on the crew panel on the left side
// of starnet, i feel it looks a bit cheap"). Paint and crop of the crew portrait only ----
const KPFX = TPFX + ' #screen-game #left #crew ';
const selsK = selsOf(cssK);
A.ok(selsK.length >= 6, 'the crew lens is its own section (' + selsK.length + ' selectors)');
A.eq(selsK.filter(x => !x.startsWith(KPFX)).join(' | '), '', 'every selector there opens with the VECTOR gate on the crew list: variation B and every other surface never see it');
A.eq(selsK.filter(x => !x.includes('.crew-portrait')).join(' | '), '', 'and every one of them is about the portrait: the row, the name and the status are not touched');
A.eq(stray(cssK, ':not(.vx-b)').join(' | '), '', 'none slips its scope inside a one-line list');
A.ok(!/\[class/.test(cssK) && !/@/.test(cssK) && !/[;{\s]filter:\s/.test(cssK) && !/#stage-wrap/.test(cssK), 'it has no [class] selector, no at-rule and no filter, and styles nothing under #stage-wrap');
A.ok(!/font-family|font-size|animation|transition|display: none|visibility|content: '[^']/.test(cssK), 'it changes no type, adds no motion, hides nothing and writes no word');
const rulesK = cssK.split('}').filter(r => r.includes('{')).map(r => ({ sel: r.slice(0, r.indexOf('{')).split(KPFX).join('').replace(/\s+/g, ' ').trim(), body: r.slice(r.indexOf('{') + 1).replace(/\s+/g, ' ').trim() }));
const ruleK = (sel) => (rulesK.find(r => r.sel === sel) || { body: '' }).body;
A.ok(stJs.includes('<span class="crew-portrait" aria-hidden="true"><img alt="" draggable="false" hidden></span>') && /AgentPortraits\.paint\(li\.querySelector\('\.crew-portrait img'\)/.test(stJs),
  'the picture is still the one image the app’s own painter fills: the look adds no element and no second drawing');
const lensK = ruleK('.crew-portrait');
A.ok(/border-radius: 50%;/.test(lensK) && /width: 55px; height: 55px; margin: 0 -2px 0 -6px;/.test(lensK), 'the portrait is a round lens that takes the room the old well had (55 wide, 8 of it given back by its margins)');
A.ok((lensK.match(/padding-box/g) || []).length === 2 && /linear-gradient\(160deg, #ffffff 0,[^;]*#f4f7fa 100%\) border-box;/.test(lensK) && /border: 3\.4px solid transparent;/.test(lensK),
  'its ring is chrome drawn in the border, its glass is dark with a backlight in the theme hue');
A.ok(/rgba\(var\(--ph-rgb\), \.5\) 0/.test(lensK) && !/#[0-9a-f]{3,6}[^;]*padding-box[^;]*rgba\(var\(--gold/.test(lensK), 'the backlight is the theme’s own hue');
const imgK = ruleK('.crew-portrait img');
A.ok(/--pf: calc\(1\.5 \* var\(--sn-unzoom, 1\)\);/.test(lensK) && /transform: scale\(var\(--pf\)\); transform-origin: 0 0;/.test(imgK) && /width: calc\(100% \/ var\(--pf\)\); height: calc\(100% \/ var\(--pf\)\);/.test(imgK),
  'the figure is drawn at one and a half screen pixels per sprite pixel at ANY text size (the zoom is cancelled), so each art pixel is three whole screen pixels');
A.ok(/object-fit: none; object-position: 50% 2px; image-rendering: pixelated;/.test(imgK) && /border-radius: 50%;$/.test(imgK), 'it is cropped to the head and shoulders from the top of the sprite, never stretched, and clipped to the port');
A.ok(/^content: ''; position: absolute; inset: 0; border-radius: 50%; pointer-events: none;/.test(ruleK('.crew-portrait::after')), 'the gloss over the glass takes no pointer');
const lampK = ruleK('.crew-portrait > .dot');
A.ok(/background-image: /.test(lampK) && !/background: |background-color:/.test(lampK), 'the lamp keeps the colour its source gives it (idle, working, asking): the look only cuts it as a jewel');
A.ok(/right: -4px; bottom: -3px;/.test(lampK) && /0 0 0 2px #050608, 0 0 0 3px #aeb6c0/.test(lampK), 'and seats it on the ring in a black pocket with a chrome lip');
A.ok(/rgba\(var\(--ph-rgb\), \.7\)/.test(ruleK('.crew-row.working .crew-portrait')) && /rgba\(var\(--gold-rgb\), \.7\)/.test(ruleK('.crew-row.asking .crew-portrait')),
  'a working agent’s lens is lit in the run colour and an asking agent’s in the wait colour: both are states the row already proves');
// the lens finds the face (Andrew 2026-11-15: "some are not centered properly … scriptwriter and scout look a bit off"): sprites whose
// head is not at the top centre (a tall hat, ears, a scythe, a tail) get their own crop offset, keyed on the set the painter stamps
const fitK = rulesK.filter(r => r.sel.includes('[data-portrait-set='));
A.ok(fitK.length >= 6, 'sprites whose head is off the top centre have a fit of their own (' + fitK.length + ' rules)');
A.eq(fitK.filter(r => !/^object-position: (50%|calc\(50% [+-] \d+px\)) -?\d+px;$/.test(r.body)).map(r => r.sel).join(' | '), '',
  'a fit only moves the crop, in whole sprite pixels: it never scales, stretches or restyles the figure');
const setsK = fitK.flatMap(r => r.sel.split(', ')).map(x => (/^\.crew-portrait img\[data-portrait-set="([\w-]+)"\]$/.exec(x) || [])[1] || ('BAD ' + x));
A.eq(setsK.filter(x => x.startsWith('BAD ')).join(' | '), '', 'each fit names one sprite set on the portrait image and nothing else');
A.eq(setsK.filter((x, i) => setsK.indexOf(x) !== i).join(' | '), '', 'no sprite is fitted twice');
A.eq(setsK.filter(x => !fs.existsSync(path.join(ROOT, 'frontend', 'assets', 'sprites', x, 'rot_south.png'))).join(' | '), '', 'every fitted set is a sprite the app ships: a renamed set cannot leave a dead fit behind');
A.ok(['approved_catinthehat', 'approved_xenomorph', 'approved_grimreaper'].every(x => setsK.includes(x)), 'the three he could not read (the hat, the scythe, the tail) are fitted');
A.ok(/img\.dataset\.portraitSet = set;/.test(read('frontend/app/agentportraits.js')), 'the painter still stamps the sprite set on the image: that stamp is what a fit keys on');
A.report('vector-identity');
