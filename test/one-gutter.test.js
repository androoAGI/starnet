'use strict';
/* node test/one-gutter.test.js — the alignment pass (Andrew 10-21: "my only complaint is that some of it is misaligned
   like this", circling the + key that floated 6px above the SESSIONS / PROJECTS line).
   SOURCE-LOCKED, with the arithmetic the rules exist for: every block in the CREW rail spans one column 10px in from the
   rail's edges (a scrolling list keeps its 8px bar inside that gutter whether it overflows or not); + NEW / + ADD has
   the tabs' height and stands on the line, its drawn + centred; the counter-zoomed head and CREW title follow the
   gutter at every TEXT SIZE. In the windows one 10px gutter holds the title, the head keys, the tab strip, a side
   menu's search / capsule / sections and the content of the single-column windows that wear the strip; controls side
   by side share one height; the StarNet card's LINK STATION key keeps its own padding. */
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const glass = read('frontend/css/pipglass.css'), crewGlass = read('frontend/css/crew-glass.css');
const menuGlass = read('frontend/css/menu-glass.css'), dlvGlass = read('frontend/css/deliverables-glass.css'), settings = read('frontend/css/settings.css');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// top-level rules only: @media / @container / @supports blocks are set aside (their rules are locked by their own regex)
const topLevel = css => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@(?:media|container|supports)[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
// the declarations of every top-level rule whose selector is exactly `sel`, merged in source order
function rule(css, sel) {
  const re = new RegExp('(?:^|[}\\n])\\s*' + esc(sel) + '\\s*\\{([^}]*)\\}', 'g'); let m, all = null;
  for (const src = topLevel(css); (m = re.exec(src));) all = (all ? all + ';' : '') + m[1];
  return all;
}
// a property's value in such a merged body: its LAST declaration (the later rule wins at equal specificity)
const decl = (body, prop) => { if (!body) return null; const re = new RegExp('(?:^|[;\\s{])' + esc(prop) + '\\s*:\\s*([^;]+)', 'g'); let m, v = null; while ((m = re.exec(body))) v = m[1].trim(); return v; };
const px = v => parseFloat(v);
const P = 'body.glass-demo:not(.hud-mode) #screen-game ';

/* ---- 1. the CREW rail: one column, 10px in from each edge ---- */
A.ok(/#screen-game #left \{ --rail-gut-u: calc\(10px \/ var\(--sn-unzoom, 1\)\); \}/.test(glass), 'the counter-zoomed head and title read the gutter back in the rail\'s zoomed px');
const bar = px(decl(rule(glass, 'body.glass-demo:not(.hud-mode) #left ::-webkit-scrollbar'), 'width'));
A.eq(bar, 8, 'the rail\'s scrollbar is a fixed 8px lane');
// crew cards: the list's 2px padding + the card's 8px margin on the left; the 2px padding + the 8px lane on the right
const crewPad = decl(rule(crewGlass, 'body.glass-demo:not(.hud-mode) #crew'), 'padding');
const crewRowM = decl(rule(crewGlass, 'body.glass-demo:not(.hud-mode) #crew .crew-row'), 'margin');
A.eq([crewPad, crewRowM], ['6px 2px', '4px 8px'], 'the crew list\'s padding and the card\'s margin these edges are counted from');
A.eq(decl(rule(glass, P + '#crew'), 'scrollbar-gutter'), 'stable', 'the crew list keeps its lane whether it scrolls or not');
const crewRight = px(decl(rule(glass, P + '#crew .crew-row'), 'margin-right'));
A.eq([2 + 8, 2 + bar + crewRight], [10, 10], 'a crew card sits 10px in from both edges of the rail');
// session rows: the list's 4px + the row's 6px on the left; 0 + the lane + the row's 2px on the right
const wsList = rule(glass, P + '#left :is(#workstreams, #projects)');
A.eq([decl(wsList, 'padding-left'), decl(wsList, 'padding-right'), decl(wsList, 'scrollbar-gutter')], ['4px', '0', 'stable'], 'the session list\'s edges and its kept lane');
const wsRowR = px(decl(rule(glass, P + '#left :is(#workstreams, #projects) > .ws-row'), 'margin-right'));
const inboxRowM = decl(rule(glass, 'body.glass-demo.rows-inbox:not(.hud-mode) #left #workstreams .ws-row'), 'margin');
A.eq(inboxRowM, '0 6px', 'the inbox row\'s own margin (left 6px)');
A.eq([4 + 6, 0 + bar + wsRowR], [10, 10], 'a session row sits 10px in from both edges, like the crew cards above it');
// NEEDS YOU and the search were already on it
A.ok(/\.ws-needs \.ny-panel \{[^}]*margin: 0 10px 6px; margin-right: max\(0px, 10px - var\(--ny-gutter, 0px\)\)/.test(glass), 'NEEDS YOU\'s panel takes its measured lane back out of the same 10px');

/* ---- 2. the SESSIONS / PROJECTS strip and its + key ---- */
const head = rule(glass, P + '#left .ws-head');
A.ok(/padding: 14px var\(--rail-gut-u, 10px\) 0/.test(head || ''), 'the strip\'s rule ends on the rail\'s gutter at every TEXT SIZE');
A.eq(decl(rule(glass, P + '#left .ws-head .ws-view::before'), 'content'), 'none', 'no stub-and-tick before the first tab: it starts on the cards\' left edge (Andrew 10-23 circled it)');
const tab = rule(glass, P + '#left .ws-head .ws-tab'), key = rule(glass, P + '#left .ws-head :is(#ws-new, #ws-addproject)');
const acts = rule(glass, P + '#left .ws-head .ws-head-acts');
A.eq(decl(key, 'height'), decl(tab, 'height'), '+ NEW / + ADD is the tabs\' own height (it was 26px beside their 32px)');
A.eq([decl(acts, 'align-items'), decl(acts, 'padding'), decl(acts, 'background'), decl(key, 'margin-bottom')], ['flex-end', '0 0 0 10px', 'none', '-1px'],
  'the key stands on the line with its bottom edge laid on the rule and ends on the cards\' right edge, no end tick after it');
A.ok(decl(tab, 'border-bottom-width') === '0' && /--tab-rule: linear-gradient\(var\(--pip-line\), var\(--pip-line\)\) left bottom \/ 100% 1px no-repeat border-box/.test(tab || '') && decl(tab, 'background') === 'var(--tab-rule)',
  'a resting tab draws its stretch of the rule as a line across its whole box (a bottom border beside transparent sides notched every tab edge)');
A.ok(!/margin-right: -1px/.test(rule(glass, P + '#left .ws-head .ws-view::after') || ''), 'the rule\'s pieces meet edge to edge (an overlap doubled the translucent line into a bright dot)');
A.ok(/@container pip-tabs \(max-width: 330px\) \{[\s\S]*?:is\(#ws-new, #ws-addproject\):not\(\[hidden\]\) \{\s*font-size: 0 !important; letter-spacing: 0;/.test(glass),
  'the square + key\'s hidden label spaces nothing (its 1.6px tracking pushed the + 4px left of centre)');
A.ok(/@media \(max-width: 1440px\) \{\s*body\.glass-demo:not\(\.hud-mode\) #screen-game #left \.ws-head #ws-new \{ letter-spacing: 0; \}/.test(glass), '…and so does the laptop window\'s + key at any rail width');
const h3 = rule(glass, P + '#left > h3');
A.ok(/padding-left: calc\(20px \/ var\(--sn-unzoom, 1\)\); padding-right: var\(--rail-gut-u\)/.test(h3 || '') && /left var\(--rail-gut-u\) bottom 0 \/ calc\(100% - 2 \* var\(--rail-gut-u\)\) 1px no-repeat/.test(h3 || ''),
  'CREW starts on the portraits\' line, its keys and its rule end on the rail\'s gutter');
A.ok(!/1px 8px no-repeat/.test(h3 || ''), 'the CREW rule is plain: no end ticks rising at either end');
A.eq([decl(h3, 'display'), decl(rule(glass, P + '#left > h3 .crew-h3-right'), 'grid-row'), decl(rule(glass, P + '#left > h3 #crew-sum'), 'grid-column')], ['grid', '1', '1 / -1'],
  'on a narrow rail the CREW keys keep the title\'s row and the count line takes the full width (beside the keys it ran under them)');
A.ok(/@container crew-head \(min-width: 340px\) \{\s*body[^{]*#left > h3 \.crew-h3-right \{ grid-row: 1 \/ span 2; \}\s*body[^{]*#left > h3 #crew-sum \{ grid-column: 1; \}/.test(glass),
  'where the head has room the keys sit centred beside the title and the count line');
const hk = rule(glass, P + '#left > h3 .crew-hide');
A.eq([decl(hk, 'width'), decl(hk, 'height'), decl(hk, 'border-color'), decl(hk, 'background')], ['28px', '28px', decl(key, 'border').replace(/^1px solid /, ''), decl(key, 'background')],
  'the CREW keys are square and wear the + key\'s own box');

/* ---- 3. the windows: one 10px gutter ---- */
const W = 'body.glass-demo:not(.hud-mode) #terms ';
A.eq(decl(rule(glass, W + '.term-head'), 'padding-right'), '10px', 'the head keys end 10px in, where the title starts on the left');
A.eq([decl(rule(glass, W + '.fam-tabs'), 'margin-left'), decl(rule(glass, W + '.fam-tabs'), 'margin-right')], ['10px', '10px'], 'the family tab strip on the same gutter');
const scrollers = ':is(.term-body, .con-pane, .con-rail-list, .ag-list)';
A.eq(decl(rule(glass, W + '.term ' + scrollers), 'scrollbar-width'), 'auto', 'the window scrollers leave the OS thin bar…');
A.eq(px(decl(rule(glass, W + '.term ' + scrollers + '::-webkit-scrollbar'), 'width')), 8, '…for the CREW rail\'s fixed 8px bar, so a kept lane has one width everywhere');
const list = rule(glass, W + '.term.sn-menu .con-rail-list');
A.eq([decl(rule(glass, W + '.term.sn-menu .con-search'), 'padding-left'), decl(rule(glass, W + '.term.sn-menu .con-search'), 'padding-right'),
  decl(rule(glass, W + '.term.sn-menu .con-intents'), 'margin-left'), decl(list, 'padding-left')], ['10px', '10px', '10px', '10px'],
  'a side menu\'s search, capsule and sections start on one edge (CONNECT\'s sections and capsule sat on the window frame)');
A.eq([px(decl(list, 'padding-right')) + 8, decl(list, 'scrollbar-gutter')], [10, 'stable'], 'its sections end where its search ends, scrolling or not');
A.eq([decl(rule(glass, W + '.term.dossier .con-rail-top'), 'padding-right'), px(decl(rule(glass, W + '.term.dossier .ag-list'), 'padding-right')) + 8],
  ['0', 10], 'the dossier\'s crew list too');
const body = rule(glass, W + '.term:is(.tasks-win, .dlv-win, .wfw-win) .term-body');
A.eq([decl(body, 'padding-left'), px(decl(body, 'padding-right')) + 8, decl(body, 'scrollbar-gutter')], ['10px', 10, 'stable'],
  'TASKS, DELIVERABLES and WORKFLOWS put their content on the strip\'s edges');
A.ok(/minmax\(200px, 1fr\)/.test(rule(glass, W + '.term.wfw-win .wfw-tiles') || ''), 'WORKFLOWS keeps two tiles a row at the window width it did');

/* ---- 4. controls side by side share one height ---- */
const textField = rule(menuGlass, '.term.sn-menu :is(input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="password"], textarea)');
A.eq([decl(textField, 'padding'), decl(textField, 'line-height')], ['10px 13px', '1.5'], 'a window\'s text field: 10px over and under a 1.5 line');
const runBy = rule(glass, W + '.term.sn-menu .rt-identity select.key-input');
A.eq([decl(runBy, 'padding-top'), decl(runBy, 'padding-bottom'), decl(runBy, 'line-height')], ['10px', '10px', '1.5'], 'SCHEDULES\' RUN BY takes Name\'s box (it was 11px shorter)');
const tbField = rule(dlvGlass, '.term.dlv-win .deliverables-toolbar :is(input, select)');
A.ok(/padding: 7px 12px/.test(tbField) && /\/1\.3 /.test(tbField), 'DELIVERABLES\' search and status: 7px over and under a 1.3 line');
const more = rule(glass, W + '.term.dlv-win .cfg.dlv .dlv-tools > summary');
A.eq([decl(more, 'padding-top'), decl(more, 'padding-bottom'), decl(more, 'line-height')], ['7px', '7px', '1.3'], 'MORE takes the same box beside them');
A.ok(/\.dlv-tools:not\(\[open\]\) \{ flex: 0 0 auto; gap: 0; \}/.test(glass), 'closed, MORE ends on the row\'s right edge');
A.eq([decl(rule(glass, W + '.term.dossier .con-toptab'), 'padding-top'), decl(rule(glass, W + '.term.dossier .con-toptab .con-rail-label'), 'line-height')], ['10px', '24px'],
  'the dossier\'s tabs take its search field\'s height (10px over and under a 24px line)');

/* ---- 5. LINK STATION keeps its own padding ---- */
A.ok(!/\[data-provider="starnet"\] :is\(\.prov-addkey,\s*\.prov-stat\) \{[^}]*padding-left:\s*0/.test(settings) && /\[data-provider="starnet"\] \.prov-addkey \{ margin-left:0; \}/.test(settings),
  'the StarNet card drops the 42px indent but not the key\'s padding (↗ LINK STATION sat against its left edge)');

/* ---- 6. the SESSIONS / PROJECTS switch (Andrew 10-23: "i saw a UI glitch in sessions and projects") ---- */
A.ok(/#screen-game #left \.ws-head :is\(#ws-new, #ws-addproject\)\[hidden\] \{ display: none !important; \}/.test(glass),
  'a hidden + key stays hidden (the 1440px rule\'s display: inline-flex drew + NEW over the PROJECTS tab)');
A.eq(decl(rule(glass, P + '#left .ws-head .ws-tab'), 'transition'), 'none', 'the tabs switch at once: no crossfade where both read as open');
A.eq(decl(rule(glass, P + '#left .ws-head #ws-addproject'), 'font-size'), '16px', '+ ADD\'s label is + NEW\'s size, so the key keeps its size across tabs');
A.ok(/@media \(max-width: 1440px\) \{[\s\S]*?body\.glass-demo:not\(\.hud-mode\) #left \.ws-head #ws-addproject:not\(\[hidden\]\) \{\s*font-size: 0 !important/.test(glass),
  'on a laptop window + ADD becomes the same square + key as + NEW, at + NEW\'s own specificity (the narrow strip\'s key still wins)');
const proj = rule(glass, P + '#left #projects > .ws-row.proj-row');
A.eq([decl(proj, 'margin'), decl(proj, 'background'), decl(proj, 'border')], ['0 2px 0 6px', 'transparent', '1px solid transparent'],
  'project rows rest quiet on the rail gutter (the oldest base row box and its 2px left bar are gone)');
A.ok(/#projects > \.ws-row\.proj-row \+ \.ws-row\.proj-row::before \{\s*content: ''/.test(glass), 'a hairline between project rows, as between session rows');
A.ok(/#projects > \.ws-row\.proj-row:is\(\.project-selected, \[aria-current="page"\]\) \{ background: var\(--pip-fill\); \}/.test(glass), 'the entered project wears the selection mesh');
A.eq(decl(rule(glass, P + '#left #projects :is(.proj-path, .proj-sess-n)'), 'font-size'), '12.5px', 'the folder path reads at the rail\'s meta size — 12.5px in the list face, VT323\'s 15px (it was 10px)');
A.ok(/@supports \(animation-timeline: scroll\(\)\) \{\s*body[^{]*#projects :is\(\.proj-row \.ws-title, \.proj-path\) \{ text-overflow: clip; animation: sn-cut-line/.test(glass),
  'a long name or path fades where it runs out, never VT323\'s flat "…" bar');
A.ok(/@container rail-search \(max-width: 250px\) \{[\s\S]*?#ws-search::placeholder \{ color: transparent !important; \}[\s\S]*?content: 'search sessions'/.test(glass),
  'a narrow rail\'s empty search reads "search sessions", not "search sessions + tra" and a flat bar');
A.ok(!/placeholder="Find an agent…"/.test(read('frontend/index.html')) && !/placeholder="Find an agent…"/.test(read('frontend/app/workflowpanel.js')),
  'no placeholder ends on "…" (VT323 draws it as one flat bar)');

/* ---- 7. the rail's icons (Andrew 10-23: "maybe the little icons could still be slightly cleaner like the + the magnifying
   glass and the other icon on the top right"): one pixel set, drawn 1:1, centred in its key ---- */
const icons = rule(glass, P + '#left');
for (const name of ['lens', 'fold', 'plus', 'close']) {
  const v = decl(icons, '--pip-ico-' + name) || '';
  const d = (v.match(/path d='([^']*)'/) || [])[1] || '';
  A.ok(/viewBox='0 0 14 14' shape-rendering='crispEdges'/.test(v) && !/stroke|circle/.test(v), name + ': a 14px pixel map with crisp edges (a smooth 1.6px stroke was soft at 1x)');
  // every rect on whole pixels; the ink box centred in the 14px map, so a centred map centres the ink
  const rects = [...d.matchAll(/M(\d+) (\d+)h(\d+)v(\d+)h-(\d+)z/g)].map(m => m.slice(1, 6).map(Number));
  A.ok(rects.length > 0 && d.replace(/M\d+ \d+h\d+v\d+h-\d+z/g, '') === '' && rects.every(r => r[4] === r[2]), name + ': drawn only in whole-pixel rects');
  const x0 = Math.min(...rects.map(r => r[0])), x1 = Math.max(...rects.map(r => r[0] + r[2])), y0 = Math.min(...rects.map(r => r[1])), y1 = Math.max(...rects.map(r => r[1] + r[3]));
  A.eq([x0, y0], [14 - x1, 14 - y1], name + ': its ink is centred in the map');
}
A.eq([decl(rule(glass, P + '#left > h3 #crew-search-toggle'), '--pip-ico'), decl(rule(glass, P + '#left > h3 #crew-hide'), '--pip-ico'),
  decl(rule(glass, P + '#left .ws-head :is(#ws-new, #ws-addproject)'), '--pip-ico'), decl(rule(glass, P + '#left #crew-search-close'), '--pip-ico')],
  ['var(--pip-ico-lens)', 'var(--pip-ico-fold)', 'var(--pip-ico-plus)', 'var(--pip-ico-close)'], 'each key draws its icon from the one set');
const ico = rule(glass, [P + '#left > h3 .crew-hide::before', P + '#left .ws-head :is(#ws-new, #ws-addproject)::before', P + '#left #crew-search-close::before'].join(',\n'));
A.eq([decl(ico, 'position'), decl(ico, 'inset'), decl(ico, 'margin'), decl(ico, 'width'), decl(ico, 'height'), decl(ico, 'mask')],
  ['absolute', '0', 'auto', '14px', '14px', 'var(--pip-ico) 0 0 / 14px 14px no-repeat'],
  'an icon sits dead centre in its key, 1:1 (the hidden glyph text took a grid row under the lens and fold and lifted them 3px)');
A.eq(decl(rule(glass, [P + '#left > h3 .crew-hide', P + '#left .ws-head :is(#ws-new, #ws-addproject)', P + '#left #crew-search-close'].join(',\n')), 'position'), 'relative', '…of its own key');
A.ok(!/content: '\+'/.test(glass), 'the + is drawn, never a font glyph of another weight');
A.eq(decl(rule(glass, P + '#left #crew-search-close'), 'font-size'), '0', 'the agent finder\'s close key hides its fallback-font ✕ for the drawn one');
A.ok(/#crew-search-close::before \{\s*--ico-px: calc\(14px \* var\(--sn-unzoom, 1\)\);\s*width: var\(--ico-px\); height: var\(--ico-px\); -webkit-mask-size: var\(--ico-px\) var\(--ico-px\); mask-size: var\(--ico-px\) var\(--ico-px\);/.test(glass),
  'the finder row is zoomed with the rail, so its icon is sized back to 14 device px at every TEXT SIZE');

A.report('one-gutter.test');
