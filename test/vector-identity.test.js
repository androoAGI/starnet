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
// pass's four panel-width queries (section 26). A window-width @media is never one of them: a panel's dress follows the panel
const atRules = [...new Set(preludes.filter(p => p.startsWith('@')))];
A.eq(atRules, ['@supports (corner-shape: bevel)', '@container vx-rail (max-width: 215px)', '@container vx-rail (max-width: 190px)', '@container vx-rail (max-width: 165px)', '@container vx-comms (max-width: 260px)'],
  'the only at-rules are the corner-shape guard and the fit pass’s four panel-width queries');

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

// ---- the sheet is eight parts (2026-11-09). VECTOR = sections 1-22, the silver device Andrew kept ("I love this look so much
// its insane"), finished by section 25, fitted by section 26, its CREW and COMMS heads rebuilt by section 27, its menu panels
// dressed by section 28 and their insides by section 29. Section 23, the black chassis, is variation B's base: gated :where(.vx-b), so it adds no specificity
// and B renders exactly as it did when that pass applied to both. Section 24 is variation B itself ----
const rawCss = read('frontend/css/vector.css');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
const cut = (title) => { const at = rawCss.indexOf(title); return at < 0 ? -1 : rawCss.lastIndexOf('/*', at); };
const baseAt = cut('23 · THE BLACK CHASSIS'), bAt = cut('24 · VARIATION B'), pAt = cut('25 · THE PERFECTED VECTOR'), fAt = cut('26 · THE FIT'), hAt = cut('27 · THE HEADS'), nAt = cut('28 · THE PANELS'), iAt = cut('29 · THE INSIDES');
A.ok(baseAt > 0 && bAt > baseAt && pAt > bAt && fAt > pAt && hAt > fAt && nAt > hAt && iAt > nAt,
  'vector.css carries the black chassis, variation B, the perfected VECTOR, the fit pass, the heads, the panels and the insides as sections 23 to 29 in that order');
const cssA = strip(rawCss.slice(0, baseAt));
const cssBase = strip(rawCss.slice(baseAt, bAt));
const cssB = strip(rawCss.slice(bAt, pAt));
const cssP = strip(rawCss.slice(pAt, fAt));
const cssF = strip(rawCss.slice(fAt, hAt));
const cssH = strip(rawCss.slice(hAt, nAt));
const cssN = strip(rawCss.slice(nAt, iAt));
const cssI = strip(rawCss.slice(iAt));
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
A.ok(new RegExp(W + ' \\.con-rail-top\\.auto-init-head \\{ padding-left: 20px; \\}').test(cssN) && new RegExp(W + ' \\.empty-state > span \\{ margin-inline: auto; \\}').test(cssN),
  'the automation rail’s note lines up with the legends under it, and an empty state’s sentence sits under its headline');
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
A.report('vector-identity');
