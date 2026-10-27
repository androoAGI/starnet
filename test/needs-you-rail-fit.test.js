'use strict';
/* node test/needs-you-rail-fit.test.js — NEEDS YOU's panel by kind, laid out at every rail width and every TEXT SIZE.

   (Andrew 10-19: "Go with the inbox: drop the REVIEW/ANSWER keys, keep only the safe one-tap actions, compact rows", then,
   of three rendered at his settings, "B · ONE PANEL BY KIND": "I like B when they are organized together perfectly".) The
   rail approves nothing from its row: every row is the door to the card that holds it all, and its only key is a safe
   one-tap action (Deny, Retry, Dismiss). The waits sit in ONE panel, each kind under its own strip, every row the agent's
   portrait, its two lines and one right-hand column (the key, or a caret where the row only opens). This test lays each
   row out the way the browser does (the metrics from pipglass.css and the rail CSS, the bundled VT323's own advance width,
   word wrap with overflow-wrap: anywhere, the one-line asks, the three container queries on the panel's width) on every
   rail, at every TEXT SIZE step and the 150% clamp, and drives the REAL render path (needsyou.js html, fitRows) on a host
   laid out by that model:
   1. no row anywhere offers Approve once, Review or Answer: an approval's one key is Deny, a question has none;
   2. the real fitRows runs, and a room that holds two rows shows both whole (a kind's strip with them);
   3. a row's key stands in its column beside the two lines wherever the panel is wider than the container query, leaving
      the ask its room, and steps under them on a narrower panel (it never covers the ask); the column holds every key whole;
      the portrait steps out before the ask is squeezed;
   4. the name line: a name stays on one line wherever it and its time fit; the place gives up its room first, and the time
      ends the line, whole;
   5. an agent's builds are one row whose COUNT is never cut. */
const A = require('./_assert.js');
require('./helpers/frontend-esc.js').installEsc();   // delegated.js / needsyou.js escape with the production U.esc, as in the page (qw36)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const glass = read('frontend/css/pipglass.css');
const appCss = read('frontend/css/app.css');
const stationui = read('frontend/app/stationui.js');

/* ---- the font: every VT323 glyph advances the same width (read from the bundled woff2's hmtx, not assumed) ---- */
function woff2Advances(buf) {
  const KNOWN = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep'];
  let o = 48;
  const numTables = buf.readUInt16BE(12), compressed = buf.readUInt32BE(20);
  const b128 = () => { let v = 0; for (let i = 0; i < 5; i++) { const b = buf[o++]; v = (v * 128) + (b & 0x7f); if (!(b & 0x80)) return v; } throw new Error('bad UIntBase128'); };
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[o++], idx = flags & 0x3f;
    let tag = KNOWN[idx] || '?';
    if (idx === 63) { tag = buf.toString('latin1', o, o + 4); o += 4; }
    const xf = (flags >> 6) & 3, len = b128();
    const transformed = (tag === 'glyf' || tag === 'loca') ? xf === 0 : xf !== 0;
    tables.push({ tag, transformed, len: transformed ? b128() : len });
  }
  const data = zlib.brotliDecompressSync(buf.subarray(o, o + compressed));
  let at = 0; const T = {};
  for (const t of tables) { T[t.tag] = Object.assign(t, { at }); at += t.len; }
  if (T.hmtx.transformed) throw new Error('hmtx is transformed: read the glyf table instead');
  const upem = data.readUInt16BE(T.head.at + 18), n = data.readUInt16BE(T.hhea.at + 34);
  const adv = new Set();
  for (let i = 0; i < n; i++) adv.add(data.readUInt16BE(T.hmtx.at + i * 4));
  return { upem, advances: [...adv].filter(a => a > 0) };   // 0 = combining marks, which take no room
}
const font = woff2Advances(fs.readFileSync(path.join(ROOT, 'frontend/assets/fonts/vt323.woff2')));
A.eq(font.advances.length, 1, 'VT323 is monospaced: one advance width for every spacing glyph (got ' + font.advances.join(', ') + ')');
const EM = font.advances[0] / font.upem;
A.ok(/#left \.ws-needs \{\s*flex: 0 0 auto;[^}]*font-family: 'VT323', monospace;/.test(glass), 'the NEEDS YOU section is set in VT323');

/* ---- the panel and its rows: what stands between the rail's edge and the lines, the two lines, the right-hand column ---- */
const block = sel => {
  const at = glass.indexOf(sel + ' {');
  A.ok(at >= 0, 'pipglass.css still has `' + sel + ' {`');
  return glass.slice(at, glass.indexOf('}', at));
};
const px = (src, re, what) => { const m = re.exec(src); A.ok(!!m, what + ' (update the layout below if this moved)'); return m ? m.slice(1).map(Number) : [NaN]; };
const P = 'body.glass-demo:not(.hud-mode) #left .ws-needs ';
const needs = block('body.glass-demo:not(.hud-mode) #left .ws-needs');
const panel = block(P + '.ny-panel');
const item = block(P + '.ny-item');
const what = block(P + '.ny-what');
const oneLine = block(P + '.ny-item:is(.approval, .question, .build, .failed, .routine) .ny-what');
const grp = block(P + '.ny-grp');
const faceRule = block(P + '.ny-face');
const lineRule0 = block(P + '.ny-line');
const whoRule0 = block(P + '.ny-who');
const [needsMx] = px(needs, /margin: \d+px (\d+)(?:px)? \d+px;/, 'the section keeps its side margins');
const [panelMx] = px(panel, /margin: \d+(?:px)? (\d+)px \d+px;/, 'the panel keeps its side margins (the rail\'s 10px gutter)');
const [panelBorder] = px(panel, /border: (\d+)px solid /, 'the panel keeps its 1px frame');
A.ok(/container-type: inline-size;/.test(panel), 'the panel is the container its rows\' queries read');
const [itemPy, itemPx] = px(item, /padding: (\d+)px (\d+)px;/, 'a row keeps its padding');
A.ok(/border: 0;/.test(item) && /background: transparent;/.test(item), 'a row is no box of its own (no edge, no gold wash): it rests on the panel');
const [hair] = px(glass, /\.ny-item \+ \.ny-item \{ border-top: (\d+)px solid /, 'rows rest on hairlines');
const [faceCol, keyCol] = px(item, /grid-template-columns: (\d+)px minmax\(0, 1fr\) (\d+)px;/, 'a row is its portrait, its lines and its right-hand column');
const [colGap] = px(item, /column-gap: (\d+)px;/, 'a row keeps its column gap');
const [rowGap] = px(item, /row-gap: (\d+)px;/, 'a row keeps its row gap');
const [faceW] = px(faceRule, /width: (\d+)px;/, 'the portrait well keeps its width');
const [faceH] = px(faceRule, /height: (\d+)px;/, 'the portrait well keeps its height');
A.eq(faceW, faceCol, 'the portrait well fills its column');
const [fontPx] = px(what, /font-size: (\d+)px;/, 'the ask line keeps its type size');
const [lineH] = px(what, /line-height: (\d*\.?\d+);/, 'the ask line keeps its line height');
const [spacing] = px(what, /letter-spacing: (\.?\d*\.?\d+)px;/, 'the ask line keeps its letter-spacing');
A.ok(/display: block;/.test(what) && /overflow-wrap: anywhere;/.test(what) && !/line-clamp|white-space/.test(what),
  'line 2 itself wraps whole, a word too long for its line broken anywhere (a wait whose last words are the claim: STEP-IN, a quest, a loop, a group)');
A.ok(/white-space: nowrap;/.test(oneLine) && /overflow: hidden;/.test(oneLine) && /text-overflow: clip;/.test(oneLine)
  && /-webkit-mask-image: linear-gradient\(90deg, #000 calc\(100% - \d+px\), transparent\);/.test(oneLine) && /(?:^|[\s;])mask-image: linear-gradient\(90deg, #000 calc\(100% - \d+px\), transparent\);/.test(oneLine),
  'an approval, a question, a build and a failure keep ONE line that fades out where it runs on (never VT323\'s flat "…", which read as a typo)');
A.ok(!/-webkit-line-clamp: [1-9]/.test(glass.slice(glass.indexOf(P + '.ny-panel {'), glass.indexOf('/* --- old-style leftovers'))), 'no row of the panel is line-clamped (a clamp draws the ellipsis)');
const [nameLh] = px(lineRule0, /line-height: (\d*\.?\d+);/, 'the name line keeps its line height');
const [whoPx] = px(whoRule0, /font-size: (\d+)px;/, 'the name keeps its type size');
const NAME_LINE = Math.ceil(whoPx * nameLh);
const [grpFont] = px(grp, /font-size: (\d+)px;/, 'a kind\'s strip keeps its type size');
const [grpLh] = px(grp, /line-height: (\d*\.?\d+);/, 'a kind\'s strip keeps its line height');
const [grpPt, grpPb] = px(grp, /padding: (\d+)px \d+px (\d+)px;/, 'a kind\'s strip keeps its padding');
const [grpRule] = px(grp, /border-bottom: (\d+)px solid /, 'a kind\'s strip keeps its rule under it');
A.ok(/\.ny-sec \+ \.ny-sec > \.ny-grp \{ border-top: 1px solid /.test(glass), 'a kind after another starts on a rule over its strip');
const STRIP = Math.ceil(grpFont * grpLh) + grpPt + grpPb + grpRule;
const [railEdge] = px(read('frontend/css/glass-demo.css'), /\.glass-demo :is\(#left,#chat-panel,#topbar,#bottombar\) \{\s*background: var\(--gd-face\); border: (\d+)px solid/, 'the rail keeps its 1px edge');
const outside = 2 * (railEdge + needsMx + panelMx + panelBorder);   // the rail's edge to the panel's content box (the container), both sides
/* ---- the three container queries, read off the panel's width ---- */
const cqAt = (re, what) => { const m = re.exec(glass); A.ok(!!m, what); return m ? m.slice(1).map(Number) : [0]; };
const [FACE_OUT_AT] = cqAt(/@container \(max-width: (\d+)px\) \{[^@]*\.ny-face \{ display: none; \}/, 'a narrow panel takes the portrait out first (the container query)');
const [PLACE_OUT_AT] = cqAt(/@container \(max-width: (\d+)px\) \{\s*body\.glass-demo:not\(\.hud-mode\) #left \.ws-needs \.ny-where \{[^}]*position: absolute;/, 'a narrow panel takes the place out of its name line (the container query)');
const [KEY_UNDER_AT, KEY_UNDER_GAP] = cqAt(/@container \(max-width: (\d+)px\) \{[^@]*\.ny-item > \.ny-keys \{ grid-column: 1; grid-row: 3; margin-top: (\d+)px; \}/, 'the narrowest panel puts the key under the lines (the container query)');
A.ok(FACE_OUT_AT > PLACE_OUT_AT && PLACE_OUT_AT > KEY_UNDER_AT, 'the portrait steps out first, then the place, then the key leaves its column (' + [FACE_OUT_AT, PLACE_OUT_AT, KEY_UNDER_AT].join(' > ') + ')');
/* ---- its one key: a terminal key in the right-hand column, or under the lines on the narrowest panel ---- */
const keyRule = block(P + '.ny-key'), keyEach = block(P + '.ny-keys > .ny-key');
const [, keyPx] = px(keyRule, /padding: (\d+)px (\d+)px;/, 'a key keeps its side padding');
const [keyFont] = px(keyRule, /font: (\d+)px\/[\d.]+ 'VT323'/, 'a key keeps its 15px label');
const [keySpacing] = px(keyRule, /letter-spacing: (\.?\d*\.?\d+)px;/, 'a key keeps its letter-spacing');
const [keyEdge] = px(keyRule, /border: (\d+)px solid /, 'a key keeps its 1px edge');
const [keyH] = px(keyEach, /min-height: (\d+)px;/, 'a key in a row keeps its height');
const [keyMin] = px(keyEach, /min-width: (\d+)px;/, 'every key is the column\'s one width');
A.ok(keyH >= 34, 'a NEEDS YOU key is the glass key\'s 34px or taller (got ' + keyH + ')');
A.eq(keyMin, keyCol, 'every key is as wide as the right-hand column, so the keys stand in one column row to row');
const keyWidth = label => label.length * (keyFont * EM + keySpacing) + 2 * keyPx + 2 * keyEdge;
for (const label of ['Deny', 'Retry', 'Dismiss', 'Running']) A.ok(keyWidth(label) <= keyCol, 'the column holds "' + label + '" whole (' + keyWidth(label).toFixed(1) + 'px of ' + keyCol + ')');

/* ---- the rails (px, and whether TEXT SIZE's zoom is counter-zoomed out of their width) ---- */
const [desk] = px(appCss, /grid-template-columns: calc\(var\(--crew-w, (\d+)px\) \* var\(--cz\)\) 1fr/, 'a desktop window keeps its counter-zoomed default rail');
const [laptop] = px(read('frontend/css/comms-layout.css'), /@media \(min-width: 861px\) and \(max-width: 1440px\), \(min-width: 861px\) and \(max-height: 740px\) \{\s*body #screen-game\.active \{[^}]*grid-template-columns: calc\(var\(--crew-w, (\d+)px\) \* var\(--cz\)\)/, 'a laptop window keeps its counter-zoomed default rail');
const [narrow] = px(appCss, /@media \(max-width: 860px\) \{\s*#screen-game\.active \{[^}]*grid-template-columns: calc\((\d+)px \* var\(--cz\)\) 1fr;/, 'a browser window of 860px or less keeps its counter-zoomed rail (one visual width at every TEXT SIZE, like the SESSIONS / PROJECTS strip in it)');
const [dragMin, dragMax] = px(read('frontend/app/leftrail.js'), /WMIN = (\d+), WMAX = (\d+),/, 'the rail seam keeps its range');
const RAILS = [{ px: narrow, cz: true, name: narrow + 'px narrow window' }, { px: laptop, cz: true, name: laptop + 'px laptop' },
  { px: desk, cz: true, name: desk + 'px desktop' }, { px: dragMin, cz: true, name: dragMin + 'px dragged (narrowest)' }, { px: dragMax, cz: true, name: dragMax + 'px dragged (widest)' }];
A.ok(/#left > h3, #chat-panel > h3, \.ws-head \{ zoom: var\(--sn-unzoom, 1\); --cz: 1; \}/.test(appCss) && !/#left[^{]*\.ws-needs[^{]*\{[^}]*zoom:/.test(glass),
  'NEEDS YOU is not counter-zoomed: its text grows with TEXT SIZE inside the rail');

/* ---- every TEXT SIZE a user can pick, AUTO's steps, and the clamp on a stored value ---- */
const steps = [...((/const TEXT_SCALES = \[([^\n]+)\];/.exec(stationui) || [])[1] || '').matchAll(/\[(\d+), '[A-Z-]+'\]/g)].map(m => Number(m[1])).filter(Boolean);
A.ok(steps.length >= 5, 'TEXT SIZE keeps its steps (' + steps.join(', ') + ')');
const autoSteps = px(stationui, /return long <= 1470 \? (\d+) : long <= 1740 \? (\d+) : (\d+);/, 'AUTO text size keeps its steps');
const [lo, hi] = px(stationui, /return n === 0 \? autoTextScale\(\) : clampN\(n, (\d+), (\d+), 100\);/, 'a stored TEXT SIZE is clamped');
const ZOOMS = [...new Set([...steps, ...autoSteps, lo, hi])].sort((a, b) => a - b);
A.ok(ZOOMS.includes(130) && ZOOMS.includes(145) && ZOOMS.includes(150), 'X-LARGE, HUGE and the 150% clamp are all laid out (' + ZOOMS.join(', ') + ')');

/* ---- the browser's layout of one row (live getters: a TEXT SIZE change moves them with no redraw) ---- */
const perChar = fontPx * EM + spacing;
let layout = { rail: RAILS[1], zoom: 100 };
const railPx = () => layout.rail.cz ? layout.rail.px / (layout.zoom / 100) : layout.rail.px;
const panelW = () => railPx() - outside;                     // the panel's content box: the container its queries read
const faceIn = () => panelW() > FACE_OUT_AT;
const placeIn = () => panelW() > PLACE_OUT_AT;
const keyBeside = () => panelW() > KEY_UNDER_AT;
const rowContent = () => panelW() - 2 * itemPx;              // a row fills the panel: its content box
// the ask's column: the row less the portrait's column (while it shows) and the right-hand column (every row keeps it, a
// key or a caret, so the ages and the keys line up)
const lineWidth = () => rowContent() - (faceIn() ? faceCol + colGap : 0) - (keyBeside() ? keyCol + colGap : 0);
/* ---- the browser's layout of one ask line: greedy wrap at spaces, a word too long for a line broken anywhere ---- */
function linesOf(text) {
  const per = Math.max(1, Math.floor(lineWidth() / perChar));
  let lines = 1, cur = 0;
  const place = w => { lines += Math.floor((w.length - 1) / per); cur = ((w.length - 1) % per) + 1; };
  for (const w of text.split(' ').filter(Boolean)) {
    if (!cur) place(w);
    else if (cur + 1 + w.length <= per) cur += 1 + w.length;
    else { lines++; place(w); }
  }
  return lines;
}
const unesc = s => s.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/* ---- the real page objects: the approval card's own phrase and INSPECT rule (chat.js, run for real) and the rail ---- */
const card = {};
{
  const src = read('frontend/app/chat.js'), at = src.indexOf('function glance(');
  vm.createContext(card); vm.runInContext(src.slice(at, src.indexOf('  function clarifyRow(', at)), card);
}
let pending = [];
const opened = [], answered = [];
global.localStorage = { getItem: () => null, setItem() {} };
global.Workstreams = { get: id => id === 'home' ? { id: 'home', title: null, agentId: 'agent' } : null, list: () => [], unread: () => false, generalId: () => 'home' };
global.Channels = { allPending: () => pending };
global.App = { agentName: id => ({ agent: 'NOVA' })[id] || id, openWorkstream: id => opened.push(id) };
global.Chat = { consentPhrase: card.actionPhrase, consentInspect: card.consentInspect, revealAsk: () => true, answerConsent: async (p, ws, d) => { answered.push(p.promptId + ':' + d); } };
const doc = { activeElement: null, hidden: false };
/* the section, laid out as the browser stacks it, so the REAL fitRows runs on every render (its fold key, each row's and each
   kind's hidden flag, the section's scrollHeight against its room): the head, the panel's frame, each kind that shows a row
   (its strip, then its rows: padding, the name line, the row gap, the ask, the portrait beside them, the key beside them or
   under them), the fold key */
const dataset = attrs => Object.fromEntries([...attrs.matchAll(/data-([a-z-]+)="([^"]*)"/g)].map(m => [m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()), m[2]]));
const ROOM = 440;                      // the section's cap at a tall rail: min(48%, 440px)
const HEAD = 33, MORE = 38;
let fitRuns = 0;                       // how many times fitRows set a row's hidden flag (it sets every row's, every run)
function rowHeight(kind, text, labels, first) {
  const lines = /^(approval|question|build|failed|routine)$/.test(kind) ? 1 : linesOf(text);
  const textBlock = NAME_LINE + rowGap + lines * Math.round(fontPx * lineH);
  let content = Math.max(textBlock, faceIn() ? faceH : 0);
  if (labels.length) content = keyBeside() ? Math.max(content, keyH) : textBlock + rowGap + KEY_UNDER_GAP + keyH;
  return 2 * itemPy + content + (first ? 0 : hair);
}
const host = { hidden: false, rows: [], secs: [], buttons: [], more: null, listeners: {}, _h: '', clientHeight: ROOM, classList: { toggle() {} },
  setAttribute() {}, addEventListener(t, fn) { this.listeners[t] = fn; }, contains: () => false,
  querySelectorAll: sel => sel === 'li.ny-item[data-ny-key]' ? host.rows : sel === '[data-ny-act]' ? host.buttons : sel === '.ny-sec' ? host.secs : [],
  querySelector: sel => sel === '.ny-more' ? host.more : null,
  get scrollHeight() {
    const shown = host.secs.filter(s => s.rows.some(r => !r.hidden));
    return HEAD + (shown.length ? 2 * panelBorder : 0)
      + shown.reduce((sum, s, k) => sum + STRIP + (k ? 1 : 0) + s.rows.filter(r => !r.hidden).reduce((a, r, j) => a + r.height(j === 0), 0), 0)
      + (host.more && !host.more.hidden ? MORE : 0);
  },
  get innerHTML() { return this._h; },
  set innerHTML(h) {
    this._h = h;
    this.rows = []; this.secs = [];
    for (const sm of h.matchAll(/<div class="ny-sec ([^"]*)"[^>]*>([\s\S]*?)<\/ul><\/div>/g)) {
      const sec = { kind: sm[1], rows: [], hidden: false, strip: unesc((/<div class="ny-grp"[^>]*>([\s\S]*?)<\/div>/.exec(sm[2]) || [])[1] || '') };
      sec.querySelectorAll = sel => sel === 'li.ny-item[data-ny-key]' ? sec.rows : [];
      for (const m of sm[2].matchAll(/<li class="ny-item ([^" ]*)[^"]*"([^>]*)>([\s\S]*?)<\/li>/g)) {
        const kind = m[1], inner = m[3];
        const ageEl = { textContent: (/<span class="ny-age">([^<]*)<\/span>/.exec(inner) || [])[1] };
        const text = unesc((/<div class="ny-what"[^>]*>([\s\S]*?)<\/div>/.exec(inner) || [])[1] || '');
        let hidden = false;
        const labels = [...inner.matchAll(/class="ny-key\b[^"]*"[^>]*>([^<]*)</g)].map(k => k[1]);
        const row = { kind, dataset: dataset(m[2]), text, labels, face: /class="ny-face"/.test(inner), caret: /class="ny-go"/.test(inner), querySelector: sel => sel === '.ny-age' ? ageEl : null,
          get hidden() { return hidden; }, set hidden(v) { fitRuns++; hidden = !!v; },
          height: first => rowHeight(kind, text, labels, first) };
        sec.rows.push(row); this.rows.push(row);
      }
      this.secs.push(sec);
    }
    const mm = /<button type="button" class="ny-more"([^>]*)>([^<]*)<\/button>/.exec(h);
    this.more = mm ? { dataset: dataset(mm[1]), hidden: / hidden/.test(mm[1]), textContent: mm[2] } : null;
    this.buttons = [...h.matchAll(/<button type="button" class="([^"]*)" data-ny-act="([^"]*)" data-ny-key="([^"]*)"[^>]*>([^<]*)</g)].map(m =>
      ({ className: m[1], dataset: { nyAct: m[2], nyKey: m[3] }, label: m[4] }));
  } };
doc.getElementById = id => id === 'ws-needs' ? host : null;
global.document = doc;
const NY = require('../frontend/app/needsyou.js');
const keysOf = k => host.buttons.filter(b => b.dataset.nyKey === k && /\bny-key\b/.test(b.className)).map(b => b.label).join(' · ');

// the shapes the sidecar sends (consentSummary): a lone path is the bare path; a call with no arguments is '{}'
const ASKS = [['mcp__fs__rm', 'a'], ['mcp__fs__rm', 'a.md'], ['fs.list', 'src'], ['mcp__fs__rm', 'notes.md'], ['fs.read', 'notes.md'],
  ['mcp__filesystem__read_file', 'notes.md'], ['fs.read', 'notes/launch-prep/pricing.md'], ['mcp__git__push', '{}'],
  ['fs.write', JSON.stringify({ path: 'opportunity-brief.md', content: '# GO / TEST / NO-GO' })]];
let n = 0;
// an older question waits beside each ask, so the section has two kinds, two rows and a fold key: the real fitRows runs
const QUESTION = { promptId: 'fit-q', tool: 'brief.ask', argsSummary: JSON.stringify({ question: 'Which tier should lead?' }), agentId: 'agent', askedAt: Date.now() - 600000 };
function show(tool, argsSummary) {
  const p = { promptId: 'fit' + (++n), tool, argsSummary, agentId: 'agent', askedAt: Date.now() - 1000 };
  pending = [{ wsId: 'home', p: QUESTION }, { wsId: 'home', p }];
  NY.render();
  return 'ask:' + p.promptId;
}

/* ---- 1. no row anywhere offers Approve once, Review or Answer: an approval's one key is Deny, a question has none ---- */
const wrong = [];
for (const rail of RAILS) for (const zoom of ZOOMS) for (const [tool, args] of ASKS) {
  layout = { rail, zoom };
  const k = show(tool, args);
  if (keysOf(k) !== 'Deny' || keysOf('ask:fit-q') !== '' || /data-ny-act="(once|attest-yes|attest-no)"|>(Approve once|Review|Answer)</.test(host.innerHTML))
    wrong.push(rail.name + ' @' + zoom + '%: ' + tool + ' offered "' + keysOf(k) + '", the question "' + keysOf('ask:fit-q') + '"');
}
A.eq(wrong.slice(0, 6), [], 'at every rail width and TEXT SIZE, an approval offers Deny alone and a question no key: nothing is approved or answered from the rail (' + wrong.length + ' wrong)');
A.eq(host.secs.map(s => s.kind + ':' + s.strip), ['approvals:Approval', 'questions:Question'], 'each kind under its own strip, the approval first (a strip counts only from two waits up)');
A.ok(host.rows.every(r => r.face) && host.rows.find(r => r.kind === 'question').caret && !host.rows.find(r => r.kind === 'approval').caret,
  'every row that names an agent carries its portrait; a row with no key carries the caret in its column instead');

/* ---- 2. the real fitRows ran on every render above; a room that holds two rows shows both, whole ---- */
fitRuns = 0;
layout = { rail: RAILS.find(r => r.px === narrow), zoom: hi };
show('fs.read', 'notes.md');
A.ok(fitRuns > 0, 'fitRows runs on the rail\'s render (this host has the fold key, the rows\' and kinds\' hidden flags and the section\'s room)');
A.ok(host.rows.every(r => !r.hidden) && host.secs.every(s => !s.hidden) && host.more && host.more.hidden, 'at the narrowest rail and the largest TEXT SIZE both rows fit the room: nothing folds, "N more" stays hidden');
{
  const rows = Array.from({ length: 9 }, (_, i) => ({ wsId: 'home', p: { promptId: 'nine' + i, tool: 'fs.read', argsSummary: 'notes/' + i + '.md', agentId: 'agent', askedAt: Date.now() - (i + 1) * 60000 } }));
  pending = rows; layout = { rail: RAILS.find(r => r.px === dragMax), zoom: 90 };
  host.clientHeight = 286;               // Andrew's rail at TEXT SIZE 90 with four CREW rows (measured live 10-19)
  NY.render();
  const shownRows = host.rows.filter(r => !r.hidden).length, foldN = Number((/^(\d+) more$/.exec(host.more ? host.more.textContent : '') || [])[1]);
  A.ok(shownRows >= 3 && shownRows + foldN === 9 && host.scrollHeight <= host.clientHeight + 1,
    'nine approvals in Andrew\'s 286px room: ' + shownRows + ' rows show whole under their strip and "' + foldN + ' more" holds the rest (live 10-19: three)');
  A.eq(host.secs.map(s => s.strip), ['Approvals9'], '…under one strip that counts all nine');
  // two kinds: a kind whose rows all fold folds its strip with them
  pending = rows.slice(0, 3).concat([{ wsId: 'home', p: Object.assign({}, QUESTION, { askedAt: Date.now() - 30000 }) }]);
  NY.render();
  A.eq(host.secs.map(s => s.kind + (s.hidden ? ':folded' : ':shown')), ['approvals:shown', 'questions:folded'], 'the question folds into "1 more" and its strip folds with it (never a strip over no row)');
  A.eq(host.more && host.more.textContent, '1 more', '…counted in "N more"');
  host.clientHeight = ROOM;
}

/* ---- 3. the key in its column beside the lines (the ask keeps its room), under them on the narrowest panel ---- */
{
  const tight = [], beside = [], under = [], faces = [];
  for (const rail of RAILS) for (const zoom of ZOOMS) {
    layout = { rail, zoom };
    if (faceIn()) faces.push(rail.name + '@' + zoom);
    // (the type scale 10-19: the ask is 17px now, so the narrowest rails keep 15 characters, faded where they run on)
    if (keyBeside()) { beside.push(rail.name + '@' + zoom); if (lineWidth() / perChar < 15) tight.push(rail.name + ' @' + zoom + '%: ' + Math.floor(lineWidth() / perChar) + ' characters beside the key'); }
    else under.push(rail.name + '@' + zoom);
  }
  A.ok(beside.length > 0 && under.length > 0 && faces.length > 0, '(the layouts include rows with the key beside (' + beside.length + '), under (' + under.length + ') and with the portrait (' + faces.length + '))');
  A.eq(tight, [], 'wherever the key stands beside the lines, the ask keeps at least 15 characters of its line');
  layout = { rail: RAILS.find(r => r.px === dragMax), zoom: 90 };
  A.ok(faceIn() && keyBeside() && lineWidth() / perChar >= 30, 'Andrew\'s 400px rail at 90%: the portrait, the lines and the key in its column, the ask keeps ' + Math.floor(lineWidth() / perChar) + ' characters');
  layout = { rail: RAILS.find(r => r.px === desk), zoom: 100 };
  A.ok(!faceIn() && keyBeside() && lineWidth() / perChar >= 15, 'the ' + desk + 'px default rail at 100%: the portrait steps out, the key stays beside the lines (two-line rows), the ask keeps ' + Math.floor(lineWidth() / perChar) + ' characters');
  layout = { rail: RAILS.find(r => r.px === laptop), zoom: 100 };
  A.ok(!keyBeside(), 'the ' + laptop + 'px laptop rail: the key steps under the lines (the panel is ' + Math.round(panelW()) + 'px, the query ' + KEY_UNDER_AT + 'px)');
}

/* ---- 4. the name line: WHO · in <where> · how long. The PLACE gives up its room before the NAME does (fix round 10-16), and
   the time ends the line, whole. Line 1 is a flex line; a group's names may wrap (.ny-who shrinks), and that let the flex
   algorithm shrink the name in proportion beside a long place (MISS / FORTUNE on Andrew's 400px rail). The line is laid
   out here with the CSS flex algorithm (Flexbox §9.7, one line) from the REAL rules — each item's flex, min-width and type,
   the line's gap, the container query that takes the place out of the line on a narrow panel — and VT323's own advance. */
{
  const topRule = sel => { const m = new RegExp('^' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}', 'm').exec(glass); A.ok(!!m, 'pipglass.css still has `' + sel + ' {` at the top level'); return m ? m[1] : ''; };
  const lineRule = topRule(P + '.ny-line'), whoRule = topRule(P + '.ny-who'), whereRule = topRule(P + '.ny-where'), ageRule = topRule(P + '.ny-age');
  const flexOf = (rule, what) => {
    const m = /(?:^|[;\s])flex:\s*([^;]+);/.exec(rule); A.ok(!!m, what + ' keeps a flex rule');
    const v = m ? m[1].trim() : 'none';
    if (v === 'none') return { grow: 0, shrink: 0, basis: 'auto' };
    if (v === 'auto') return { grow: 1, shrink: 1, basis: 'auto' };
    const t = v.split(/\s+/), num = s => /^\d*\.?\d+$/.test(s);
    if (t.length === 1 && num(t[0])) return { grow: +t[0], shrink: 1, basis: 0 };
    const grow = +t[0], shrink = t[1] && num(t[1]) ? +t[1] : 1, b = num(t[1] || '') ? t[2] : t[1];
    return { grow, shrink, basis: !b || /^0(px|%)?$/.test(b) ? 0 : b === 'auto' || b === 'content' ? 'auto' : parseFloat(b) };
  };
  const minOfRule = rule => { const m = /(?:^|[;\s])min-width:\s*(\d+)(?:px)?;/.exec(rule); return m ? +m[1] : 'auto'; };
  const typeOf = (rule, what) => { const [f] = px(rule, /font(?:-size)?: (\d+)px/, what + ' keeps its type size'); const [ls] = px(rule, /letter-spacing: (\.?\d*\.?\d+)px;/, what + ' keeps its letter-spacing'); return f * EM + ls; };
  const [gap] = px(lineRule, /gap: 0 (\d+)px;/, 'the name line keeps its gap');
  const perWho = typeOf(whoRule, 'the name'), perWhere = typeOf(whereRule, 'the place'), perAge = typeOf(ageRule, 'the time');
  const moreEm = Number((/\.ny-who > \.ws-agent-more \{ margin-left: (\.?\d*\.?\d+)em; \}/.exec(glass) || [])[1]) || 0;   // a group's "+N" keeps its gap
  // a name's widths: max-content (one line) and min-content (its longest unbreakable run: a group's "+N" rides its last name)
  function nameBox(names, more) {
    const w = s => s.length * perWho, gapMore = more ? moreEm * fontPxOf(whoRule) : 0, tail = more ? gapMore + w('+' + more) : 0;
    const words = names.split(' ');
    return { maxC: w(names) + tail, minC: Math.max(...words.map((x, k) => w(x) + (k === words.length - 1 ? tail : 0))) };
  }
  function fontPxOf(rule) { return +(/font-size: (\d+)px/.exec(rule) || [])[1]; }
  // Flexbox §9.7 resolving flexible lengths, one line, no wrap
  function flexLine(avail, items) {
    const minOf = i => i.min === 'auto' ? i.minC : i.min;
    const base = items.map(i => i.basis === 'auto' ? i.maxC : i.basis);
    const hypo = items.map((i, k) => Math.max(minOf(i), base[k]));
    const gaps = gap * (items.length - 1);
    const growing = hypo.reduce((s, x) => s + x, 0) + gaps < avail;
    const factor = i => growing ? i.grow : i.shrink;
    const target = hypo.slice();
    const frozen = items.map((i, k) => factor(i) === 0 || (growing ? base[k] > hypo[k] : base[k] < hypo[k]));
    const initialFree = avail - gaps - items.reduce((s, i, k) => s + (frozen[k] ? target[k] : base[k]), 0);
    for (let guard = 0; guard < 12 && frozen.some(f => !f); guard++) {
      const un = items.map((_, k) => k).filter(k => !frozen[k]);
      let free = avail - gaps - items.reduce((s, i, k) => s + (frozen[k] ? target[k] : base[k]), 0);
      const sumF = un.reduce((s, k) => s + factor(items[k]), 0);
      if (sumF < 1 && Math.abs(initialFree * sumF) < Math.abs(free)) free = initialFree * sumF;
      if (growing) un.forEach(k => { target[k] = base[k] + (sumF ? free * items[k].grow / sumF : 0); });
      else { const sumS = un.reduce((s, k) => s + items[k].shrink * base[k], 0); un.forEach(k => { target[k] = base[k] + (sumS ? free * items[k].shrink * base[k] / sumS : 0); }); }
      let total = 0; const viol = {};
      un.forEach(k => { const c = Math.max(minOf(items[k]), target[k]); viol[k] = c - target[k]; total += viol[k]; target[k] = c; });
      un.forEach(k => { if (Math.abs(total) < 1e-9 || (total > 0 ? viol[k] > 0 : viol[k] < 0)) frozen[k] = true; });
    }
    return { sizes: target, used: target.reduce((s, x) => s + x, 0) + gaps };
  }
  const qRow = NY._internals.html([{ key: 'ask:t', kind: 'question', who: 'NOVA', aid: 'agent', what: 'Which tier?', where: 'General', since: Date.now() - 120000, p: { promptId: 't', tool: 'brief.ask' } }], Date.now());
  A.ok(/<div class="ny-line">[\s\S]*?<span class="ny-age">[^<]*<\/span><\/div>/.test(qRow) && /<span class="ny-face" aria-hidden="true" data-ny-aid="agent">/.test(qRow) && !/ny-strip/.test(qRow),
    'a row\'s time ends its name line, its portrait beside it, and no strip of its own (its kind\'s strip heads the group)');
  A.ok(/flex: none;/.test(ageRule) && /margin-left: auto;/.test(ageRule), 'the time keeps its room at the line\'s right end, whole');
  A.ok(/text-overflow: clip;/.test(whereRule) && /mask-image: linear-gradient\(90deg, #000 calc\(100% - \d+px\), transparent\);/.test(whereRule), 'a place too long for its room fades out (never VT323\'s flat "…")');
  const whoF = flexOf(whoRule, 'the name'), whereF = flexOf(whereRule, 'the place'), ageF = flexOf(ageRule, 'the time');
  const AGE = '59m';
  const ROWS = [
    { what: 'MISS FORTUNE beside a build session\'s long place', names: 'MISS FORTUNE', place: 'in ⚒ Speedrun timer with checkpoint splits + test course' },
    { what: 'a group of five beside its long title', names: 'ULTRON, CYPHER', more: 3, place: 'in Scout the speedrun community for course ideas and leaderboards' },
    { what: 'ULTRON beside "General"', names: 'ULTRON', place: 'in General' }
  ];
  const wrapped = [], placeWide = [], ageCut = [], tooNarrow = new Set();
  let placeShown = 0, oneLineAt400 = 0;
  for (const rail of RAILS) for (const zoom of ZOOMS) for (const r of ROWS) {
    layout = { rail, zoom };
    const avail = lineWidth(), inLine = placeIn();
    const nb = nameBox(r.names, r.more);
    const who = Object.assign({ min: minOfRule(whoRule) }, whoF, nb);
    const where = Object.assign({ min: minOfRule(whereRule), maxC: r.place.length * perWhere, minC: r.place.length * perWhere }, whereF);
    const age = Object.assign({ min: minOfRule(ageRule), maxC: AGE.length * perAge, minC: AGE.length * perAge }, ageF);
    const items = inLine ? [who, where, age] : [who, age], out = flexLine(avail, items);
    const at = rail.name + ' @' + zoom + '%: ' + r.what;
    const roomForName = nb.maxC + age.maxC + (items.length - 1) * gap <= avail + 0.01;
    if (roomForName && out.sizes[0] < nb.maxC - 0.01) wrapped.push(at + ' — the name gets ' + out.sizes[0].toFixed(1) + 'px of the ' + nb.maxC.toFixed(1) + ' it needs, the place ' + (inLine ? out.sizes[1].toFixed(1) : 'none'));
    if (out.sizes[items.length - 1] < age.maxC - 0.01) ageCut.push(at + ' — the time gets ' + out.sizes[items.length - 1].toFixed(1) + 'px of ' + age.maxC.toFixed(1));
    if (nb.minC > avail + 0.01) tooNarrow.add(rail.name + ' @' + zoom + '%');
    if (inLine) {
      placeShown++;
      if (out.sizes[1] > Math.max(0, avail - (out.sizes[0] + gap + age.maxC + gap)) + 0.01) placeWide.push(at + ' — the place takes more than the name and the time leave');
      if (rail.px === dragMax && zoom === 90 && roomForName) oneLineAt400++;
    }
  }
  A.ok(placeShown > 10 && oneLineAt400 === ROWS.length, '(the place is in the line on the wide rails: ' + placeShown + ' layouts, all three rows at Andrew\'s 400px rail at 90%)');
  A.eq(wrapped.slice(0, 4), [], 'a name stays on one line wherever it, its time and the gaps fit the line: the place gives up its room first (' + wrapped.length + ' wrapped)');
  A.eq(ageCut.slice(0, 4), [], 'the time is never squeezed: it ends the line whole (' + ageCut.length + ')');
  if (tooNarrow.size) console.log('NOTE: not even a name\'s longest word fits one line at ' + [...tooNarrow].join(', ') + ' (unchanged by this rule)');
  A.eq(placeWide.slice(0, 4), [], 'the place takes only the room the name and the time leave, and fades out on the rest (' + placeWide.length + ')');
}

/* ---- 5. an agent's builds are one row whose COUNT is never cut (two reviews 10-16, P1) ----
   The count leads the line, so it stands whole on the row's one line on every rail, at every TEXT SIZE. */
(async () => {
  const builds = Array.from({ length: 23 }, (_, i) => ({ runId: 'b' + i, agentId: 'agent', title: i ? 'Ghost replay recorder v' + i : 'Speedrun timer with checkpoint splits + test course', builtAt: Date.now() - (30 - i) * 60000 }));
  global.WorkshopStore = { pendingAll: async () => builds, pendingAllOk: () => true, ensureSession: m => 'workshop-' + m.runId, sessionIdOf: r => 'workshop-' + r, sessionTitleOf: m => '⚒ ' + m.title };
  global.fetch = async url => ({ ok: true, json: async () => url === '/api/hooks' ? { hooks: [], pending: [] } : { plugins: [] } });
  await NY.refreshFeeds(true);
  pending = [];
  layout = { rail: RAILS[1], zoom: 100 };
  NY.render();
  const row = host.rows.find(r => /^build:/.test(r.dataset.nyKey));
  A.ok(!!row && host.rows.length === 1, 'the 23 builds are ONE row (' + host.rows.length + ' rows)');
  A.eq((/<span class="ny-count">(\d+)<\/span>/.exec(host.innerHTML) || [])[1], '23', 'the header counts every one of them');
  A.eq(host.secs.map(s => s.strip), ['Builds to review23'], 'their kind\'s strip counts every one of them too');
  A.eq(row ? row.labels : null, [], 'a build row has no key: its row opens its own session, where it is kept or discarded');
  const line = row ? row.text : '', count = /\+\d+ more|\b\d+ builds?\b/.exec(line);
  A.ok(!!count && /23/.test(count[0]), 'the row says how many builds wait: "' + line + '"');
  const cutAt = [];
  for (const rail of RAILS) for (const zoom of ZOOMS) {
    layout = { rail, zoom };
    const upTo = count ? linesOf(line.slice(0, count.index + count[0].length)) : Infinity;
    if (upTo > 1) cutAt.push(rail.name + ' @' + zoom + '%: the count needs ' + upTo + ' lines of the one');
  }
  A.eq(cutAt.slice(0, 6), [], 'the count of builds stands whole on the row\'s one line on every rail at every TEXT SIZE (' + cutAt.length + ' cut)');
  A.report('needs-you-rail-fit');
})().catch(e => { console.error(e); process.exit(1); });
