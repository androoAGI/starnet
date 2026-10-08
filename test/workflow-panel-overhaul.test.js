/* test/workflow-panel-overhaul.test.js — THE WORKFLOW PANEL, OVERHAULED (Andrew, 2026-09-30: "an atrocious UX disaster. tiny
   text, doesnt … match the new gorgeous buttons and new style … the crate is ugly … easy to use, simplified, and the system
   viewer or wireframe view should look better as well … a UX overhaul clean experience consistent with the rest of starnet").

   What that became, locked here so it cannot drift back:
     · READABLE — the panel speaks at the station's size: 17px body, nothing a Commander reads under 14px, and the pieces it
       borrows from other cards (trigger rows, the add forms, the WHEN picker) are restated on that scale;
     · ONE MATERIAL — the Build Library's glass keys (8px, 36px tall), matte: no glow anywhere in the sheet;
     · SIMPLER — the header says each thing once (a cost only once a step was really tested; no hint repeating the
       sentence), and the INBOX card is one block per way to start the line, its add key on the block's own row;
     · THE MAP — the line diagram shows every part as the machine it is (its own floor art), the + sits on the belt, and a
       one-row diagram stays pinned at the top while the picked part's editor scrolls under it;
     · THE FLOOR — a caption is a plate (the ride's, the paused hand-off's, the projection's), set at a reading size on
       screen and kept on the visible glass; what waits at a paused hand-off is the same crate that rides the belts.
   (The crate's own art is locked in test/conveyor.test.js.) */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const rd = f => fs.readFileSync(path.join(__dirname, '..', 'frontend', f), 'utf8').replace(/\r\n/g, '\n');
const css = rd('css/workflow-panel.css'), panel = rd('app/workflowpanel.js'), build = rd('app/build.js'), ghost = rd('app/ghostline.js'), world = rd('app/world.js');
const at = (src, from, to) => { const a = src.indexOf(from); return a < 0 ? '' : src.slice(a, to ? src.indexOf(to, a) : a + 4000); };
// every rule block the exact selector opens (a selector may have more than one), joined as text
const rule = sel => { const out = []; let i = -1; while ((i = css.indexOf('\n' + sel + ' {', i + 1)) >= 0) out.push(css.slice(i + 1, css.indexOf('}', i) + 1)); return out.join('\n'); };
const sizeIn = block => { const m = /font-size:\s*([0-9.]+)px/.exec(block); return m ? +m[1] : null; };

/* ---------- readable ---------- */
const sizes = (css.match(/font-size:\s*[0-9.]+px/g) || []).map(s => +/([0-9.]+)px/.exec(s)[1]);
A.ok(sizes.length > 40 && Math.min.apply(null, sizes) >= 14, 'nothing in the panel is set under 14px (smallest: ' + Math.min.apply(null, sizes) + 'px)');
A.eq(sizeIn(rule('.wf-panel')), 17, 'the panel reads at the station\'s size: 17px');
A.ok(sizeIn(rule('.wf-sentence')) >= 17 && sizeIn(rule('.wf-help')) >= 17, 'the how-it-runs sentence and every help line read at 17px or more');
for (const [sel, min] of [['.wf-panel .trg-row', 16], ['.wf-panel .trg-row-meta', 15], ['.wf-panel .trg-form-k', 15], ['.wf-panel :is(.refit-input,.refit-brief)', 17],
  ['.wf-panel .trg-preview', 15], ['.wf-panel :is(.sp-mode,.sp-unit)', 16], ['.wf-panel .sp-day', 16], ['.wf-panel :is(.sp-lbl,.sp-tz,.sp-hint,.sp-note)', 15], ['.wf-panel .sp .sp-num', 16]]) {
  const n = sizeIn(rule(sel));
  A.ok(n != null && n >= min, sel + ' (a piece borrowed from another card) is restated on the panel\'s scale: ' + min + 'px or more (it is ' + n + 'px)');
}

/* ---------- one material: the Build Library's glass keys, matte ---------- */
const bb = rule('.wf-panel .bb');
A.ok(/min-height:\s*36px/.test(bb) && /border-radius:\s*8px/.test(bb) && /background:\s*var\(--refit-glass/.test(bb) && /border:\s*1px solid var\(--wf-edge\)/.test(bb), 'every key in the panel is the Build Library\'s glass key: 36px tall, 8px, one hairline');
A.ok(!/--ph-glow/.test(css) && !(css.match(/text-shadow:\s*[^;]+/g) || []).some(s => !/text-shadow:\s*none/.test(s)), 'matte: no phosphor glow and no text-shadow anywhere in the sheet');
const chip = rule('.wf-chip');
A.ok(/min-height:\s*34px/.test(chip) && /border-radius:\s*8px/.test(chip) && sizeIn(chip) >= 16, 'a chip is a key too (34px, 8px, 16px type)');

/* ---------- simpler: the header says each thing once ---------- */
const head = at(panel, '  function paintHead(f) {', '  /* ---------- the flow strip');
A.ok(/\$\('#wf-est'\)\.textContent = est && est\.tested \? est\.text : '';/.test(head), 'a cost is shown only once a step was really tested (never an instruction in its place)');
A.ok(/r\.hints\.filter\(h => !\/\^nothing starts it\/\.test\(h\.what\)\)/.test(head) && /hints\.hidden = !tips\.length;/.test(head), 'no hint repeats what the sentence already says about what starts the line; no hints, no row');
A.ok(/\(i === 0 && intake\) \? '<span class="wf-st" data-go="' \+ esc\(intake\.id\) \+ '">'/.test(head), 'the sentence\'s first clause (what starts the line) opens the INBOX');
A.ok(/'WORKFLOW · ' \+ nSteps \+ ' STEP' \+ \(nSteps === 1 \? '' : 'S'\);/.test(head), 'the kicker says what this is and how long, nothing else');

/* ---------- simpler: the INBOX card is one block per way to start the line ---------- */
const trig = at(panel, '  function paintTrigger(body, f, p) {', '  /* WORKING FOLDER');
A.ok(/startHead\('A schedule', !S\.cron \? 'reading…' : routines\.length \? '' : 'none yet', 'rt',/.test(trig) && /startHead\('A channel message', !S\.chans \? 'checking…' : tr\.chanRows\.length \? '' : 'none connected', 'ch',/.test(trig),
  'a schedule and a channel are blocks whose header says what they have and carries their add key');
const lts = at(panel, '  function ltSectionHtml() {', '  const ltSay');
A.ok(/startHead\('A file lands in a folder', ltNote\('folder'\), 'fo',/.test(lts) && /startHead\('A webhook is called', ltNote\('webhook'\), 'wh',/.test(lts), '…and so are a watched folder and a webhook');
A.ok(/\(hooked \? '<p class="wf-help dim">A webhook address lives on this computer/.test(lts), 'where a webhook can be reached from is said where a webhook IS (one on the line, or one being made)');
A.ok(/return S\.lt \? ltMine\(\)\.filter\(t => t\.kind === kind\)\.map\(ltRowHtml\)\.join\(''\) : '';/.test(panel), 'an empty list shows nothing: its block\'s header says "none yet"');
A.ok(/noteEl\.textContent = ltNote\(rowKind\);/.test(at(panel, '  function ltPatch() {', '  // the one thing that moves')), '…and the 5 s re-read keeps that header note true');
A.ok(/const startHead = \(name, note, id, keys\) => '<div class="wf-start"><div class="wf-start-h"><h4>' \+ name \+ '<\/h4><span class="wf-start-n" id="wf-start-n-' \+ id \+ '">' \+ esc\(note\) \+ '<\/span>'/.test(panel), 'one builder makes every block\'s header row');
A.ok(/display:\s*flex/.test(rule('.wf-start-h')) && /border-radius:\s*10px/.test(rule('.wf-start')) && /\.wf-start \.trg-list:empty \{ display: none; \}/.test(css), 'a block is a glass card with its header on one row; an empty list takes no room');

/* ---------- the map: real machines, the + on the belt, pinned ---------- */
A.ok(/<div class="wf-strip-wrap" id="wf-map">/.test(panel), 'the diagram\'s well is the panel\'s map');
A.ok(/const mthumb = t => \{ const u = \(t && H\.machineStill\) \? H\.machineStill\(t\) : '';/.test(panel) && /<img class="wf-mthumb" src="' \+ u \+ '" alt="" aria-hidden="true" draggable="false">/.test(panel), 'a part\'s card leads with the machine\'s own floor art (no art: the name alone)');
/* THE MACHINES AS TILES (2026-09-30 — Andrew on the diagram: "make this look way better"): the Build Library's glass tile — the
   machine's art big in a lit well (a BAY's agent stands at it), its name, one short line; the sentences are the tile's tip */
const tile = at(panel, '  function tileHTML(o) {', '  // the roles a step can take');
A.ok(/'<span class="wf-nart">' \+ mthumb\(o\.mach\) \+ \(o\.agent \|\| ''\) \+ '<\/span>'/.test(tile) && /'<span class="wf-nname">' \+ esc\(o\.name\) \+ '<\/span>'/.test(tile)
  && /'<span class="wf-nmeta' \+ \(o\.warn \? ' warn' : ''\) \+ '">' \+ esc\(o\.meta\) \+ '<\/span><\/button>'/.test(tile), 'a tile is the machine\'s art (with its agent), its name and one short line');
A.ok(/data-tip="' \+ esc\(o\.tip\) \+ '"/.test(tile) && /\(o\.lamp != null \? '<span class="dot' \+ \(o\.lamp \? ' ok' : ''\) \+ '"><\/span>' : ''\)/.test(tile), '…with its lamp, and its whole story as its hover tip');
const node = at(panel, '  function nodeHTML(n, f) {', '  function drawArcs(');
A.ok(/mach: n\.propId \? n\.mach : null, lamp: n\.ok, name: n\.name, meta: n\.meta/.test(node) && /mach: loop \? 'loop' : 'joiner'/.test(node)
  && /mach: 'bay', agent: d\.agentId \? thumb\(d\.agentId, 26, 32, 'wf-nthumb'\) : '', lamp: ok, name: role, meta: who \|\| 'needs an agent', warn: !who/.test(node),
  'the INBOX, every BAY, a gate and the OUTBOX are all shown as their machine, with their lamp');
A.ok(/'\\n' \+ \(brief \? '“' \+ brief\.slice\(0, 140\)/.test(node) && /: 'no instructions yet'\) \+ \(t \? '\\n✓ tested' : ''\);/.test(node) && !/<span class="s">|no agent yet<\/span>/.test(node),
  'a step\'s instructions, its missing agent and its test live in the tip — no sentence is printed on a tile');
A.ok(/meta: f\.outbox\.reached \? 'the result' : f\.outbox\.reachedOnceCrewed \? 'needs crew' : 'not connected'/.test(panel) && /meta: !ip \? 'none yet' : kinds > 1/.test(panel), 'the INBOX and OUTBOX say one short thing each');
/* the joins are a clean line with a chevron — NEVER the floor's real conveyor art (2026-09-30, Andrew: "ew … that u put the
   actual conveyor there. terrible") — a shade brighter once a job entering the INBOX would reach the OUTBOX, never moving */
A.ok(!/beltStill|wf-belt-cold|wf-belt-live|has-belt/.test(panel + build + css) && !/Conveyor\./.test(panel), 'the diagram never draws the real conveyor');
A.ok(/\.wf-belt \.rail \{ position: relative; width: 100%; height: 10px;/.test(css) && /clip-path: polygon\(0 4px, calc\(100% - 9px\) 4px, calc\(100% - 9px\) 0, 100% 5px, calc\(100% - 9px\) 10px, calc\(100% - 9px\) 6px, 0 6px\)/.test(rule('.wf-belt .rail'))
  && !/\.wf-belt \.rail::(after|before)/.test(css), 'a join is ONE clean shape: a 2px line into a solid arrowhead that touches the next part');
A.ok(/strip\.classList\.toggle\('live', !!\(f && f\.trigger\.propId && f\.outbox\.reached\)\);/.test(panel) && /\.wf-strip\.live \.wf-belt \.rail \{ background: rgba\(var\(--ph-rgb\),\.55\); \}/.test(css), '…a shade brighter on a line that can run');
/* THE ARROW SITS ON THE TILES' MIDDLE (2026-09-30, Andrew: "CENTER THE ARROW IN THE MIDDLE NOT ON THE TOP"): the strip centres
   every part and join, and a join's line is its own centre row (what it carries above, an equal empty row below) */
A.ok(/align-items:\s*center/.test(rule('.wf-strip')) && !/flex-start/.test(rule('.wf-strip')), 'every part and join sits on the line\'s middle');
A.ok(/align-self:\s*center/.test(rule('.wf-belt')) && /grid-template-rows:\s*27px 28px 27px/.test(rule('.wf-belt')) && !/\.wf-belt\.mid/.test(css) && !/' mid'/.test(panel),
  '…a join\'s line is its centre row, so the arrow meets each tile at its middle (never up at the art)');
A.ok(/grid-row: 2; align-self: center;/.test(rule('.wf-belt.gap .carry')), '…and a break in the line says so where the line would run');
const arcs = at(panel, '  function drawArcs(strip, f) {', '  function insertStep(');
A.ok(/for \(const el of strip\.children\) if \(el\.offsetLeft < Math\.max\(ax, bx\) && el\.offsetLeft \+ el\.offsetWidth > Math\.min\(ax, bx\)\) y0 = Math\.max\(y0, el\.offsetTop \+ el\.offsetHeight\);/.test(arcs),
  'a loop\'s way back runs under everything between its ends (a branch group between them hangs lower)');
A.ok(/head\.setAttribute\('class', 'head'\);/.test(arcs) && /\['stem', stem\]/.test(arcs) && /\.wf-arcs \.head \{ fill: var\(--wf-cyan\);/.test(css) && /\.wf-arcs path\.stem \{ stroke: var\(--wf-cyan\); stroke-width: 2;/.test(css),
  '…and ends in the joins\' arrowhead on a solid stem, up into the part it goes back to');
A.ok(/meta: loop \? 'back to ' \+ who : 'waits for all'/.test(panel), 'the LOOP tile\'s one line fits the tile (the count is on the way back\'s label)');
A.ok(!/wf-belt \.rail[^{]*\{[^}]*animation/.test(css) && /\.wf-strip\.live \.wf-arcs path\.chev \{ animation:/.test(css), 'the joins never move; the loop\'s way back moves only on a line that can run');
A.ok(/card\.classList\.toggle\('glass-tip', !!el\.closest\('\.refit-dock, \.wf-panel'\)\)/.test(rd('app/tooltip.js')), 'the panel\'s tips are the glass card that keeps its lines');
A.ok(/mach: 'intake'/.test(panel) && /mach: 'outbox'/.test(panel), 'the INBOX and OUTBOX cards name their machines');
A.ok(/machineStill: type => machineStill\(type\)/.test(build), 'the Build host offers a machine\'s art to the panel');
const still = at(build, '  function machineStill(type) {', '  function setLibraryPlacement(');
A.ok(/PropSprites\.draw\(\{ t: c\.id, x: 0, y: 0, w: c\.w, h: c\.h \}, true\)/.test(still) && /off\.toDataURL\('image\/png'\)/.test(still), '…drawn by the same sprite the floor draws, kept as a still');
A.ok(/if \(had && had\.rev === rev\) return had\.url;/.test(still) && /machineStills\[key\] = \{ rev, url \};/.test(still), '…one per machine, made again when the authored art finishes loading');
A.ok(/finally \{ if \(ctx\) PropSprites\.setCtx\(ctx\); \}/.test(still), '…and the sprite module\'s draw context goes back to the floor\'s canvas');
A.ok(/width:\s*96px;\s*height:\s*62px/.test(rule('.wf-nart')) && /width:\s*80px;\s*height:\s*62px/.test(rule('.wf-nart .wf-mthumb')) && /width:\s*124px/.test(rule('.wf-node')), 'the machine is drawn big, in a lit well, on a 124px tile');
A.ok(/\.wf-belt :is\(\.rail,\.wf-plus\) \{ grid-row: 2; grid-column: 1; \}/.test(css), 'the + sits ON its belt');
A.ok(/overflow-wrap:\s*break-word/.test(rule('.wf-belt .carry')) && /max-width:\s*112px/.test(rule('.wf-belt')), 'what a belt carries wraps between words, never inside one');
A.ok(/\.wf-strip-wrap\.pin \{ position: sticky; top: 0; z-index: 3; \}/.test(css), 'a pinned map holds the top of the scroll');
A.ok(/var\(--panel2\)/.test(rule('.wf-strip-wrap')), '…over an opaque well (the panel\'s own sheet is translucent: text scrolling under it would show through)');
A.ok(/strip\.parentNode\.classList\.toggle\('pin', !nodes\.some\(n => n\.kind === 'col' && n\.col\.docks\.length > 1\)\);/.test(panel), 'only a one-row diagram is pinned (stacked branches would hold too much of the panel)');
const tc = at(panel, '  function toCard(always) {', '  // called by build.js after every plan recompile');
A.ok(/if \(!always && sc\.scrollTop <= head\.offsetHeight\) return;/.test(tc) && /sc\.scrollTop = head\.offsetHeight;/.test(tc), 'toCard brings the view back so the map sits at the top with the card under it (a view still showing the header is left alone)');
A.ok(/const lack = head\.offsetHeight - \(sc\.scrollHeight - sc\.clientHeight\);\s*if \(always && lack > 0 && body\) body\.style\.minHeight = \(body\.offsetHeight \+ lack\) \+ 'px';/.test(tc) && /if \(body\) body\.style\.minHeight = '';/.test(tc),
  '…and a short TEST card holds the room open under it, so the map never stops half-way up the header');
A.ok(/S\.sel = propId; S\.insertAt = null; S\.view = 'edit';\s*paint\(true\);\s*toCard\(\);/.test(panel), 'picking a part brings its card under the map');
A.ok(/if \(newLine\) \{ const sc = \$\('#wf-scroll'\), bd = \$\('#wf-body'\); if \(bd\) bd\.style\.minHeight = ''; if \(sc\) sc\.scrollTop = 0; \} else toCard\(\);/.test(panel), 'a floor click does too; a new line starts at its top');
A.ok(/paintStrip\(flow\(\)\); if \(S\.insertAt != null\) toCard\(\);/.test(panel) && /S\.view = 'edit'; paint\(true\); toCard\(\);/.test(panel), 'the + inserter and SETUP open in view');
A.ok(/function parked\(fn\) \{[\s\S]{0,260}fn\(\);\s*if \(atMap && Math\.abs\(sc\.scrollTop - hd\.offsetHeight\) >= 1\) sc\.scrollTop = hd\.offsetHeight;\s*\}/.test(panel) && /parked\(\(\) => paintAll\(force\)\)/.test(panel)
  && (panel.match(/if \(el\) parked\(paintToday\);/g) || []).length === 2, 'a view parked at the map stays parked when the header changes height (a repaint, or the TODAY row arriving on its own timer)');
A.ok((panel.match(/S\.view = 'test'; paint\(true\); toCard\(true\);/g) || []).length === 2, 'TEST (the footer key and the top bar\'s) always opens with the map at the top: its modes and RUN key are not pushed under the fold');

/* ---------- the floor: captions are plates ---------- */
const notes = at(build, '  function drawTestNotes(now, t) {', '  /* A FLOOR CAPTION IS A PLATE');
A.ok(/captionBox\(n\.text, \(n\.x \+ 0\.5\) \* t, n\.y \* t - 5 \/ zoom - rise\)/.test(notes) && /captionPlate\(c, n\.text, box, n\.col, alpha\)/.test(notes) && !/shadowBlur/.test(notes), 'a ride caption is a plate over its tile: no bare glowing text');
A.ok(/const alpha = k < 0\.12 \? k \/ 0\.12 : k > 0\.75 \? \(1 - k\) \/ 0\.25 : 1;/.test(notes), '…fully lit while it is read, fading only at the end');
const cap = at(build, '  /* A FLOOR CAPTION IS A PLATE', '  /* ---------- FINISH THE LINE');
A.ok(/const capFs = \(\) => 17 \* \(dpr \|\| 1\) \* \(\(typeof U !== 'undefined' && U\.uiZoom && U\.uiZoom\(\)\) \|\| 1\) \/ zoom;/.test(cap), 'a caption is set at a reading size ON SCREEN (17px, by pixel ratio and TEXT SIZE), whatever the camera zoom');
A.ok(/function captionFit\(box\)/.test(cap) && /const left = \(ins\.l - panX\) \/ zoom \+ m, right = \(cv\.width - \(ins\.r \|\| 0\) - panX\) \/ zoom - m;/.test(cap), '…and kept on the visible glass (never under the Build Library or the docked panel)');
A.ok(/c\.fillStyle = 'rgba\(4,6,8,0\.86\)'; c\.fillRect\(box\.x, box\.y, box\.w, box\.h\);/.test(cap) && /c\.strokeRect\(/.test(cap) && !/shadowBlur/.test(cap), 'the plate is the gesture badge\'s: a dark field, a hairline in the caption\'s colour, plain text');
const marks = at(build, '  function drawWorkflowMarks(t, now) {', '  /* ---------- WHO SITS AT THIS DESK');
A.ok(/Conveyor\.drawCrate\(ctx, Math\.round\(x \+ t \/ 2\), Math\.round\(y \+ t \/ 2\) \+ 1, 'product'\)/.test(marks), 'what waits at a paused hand-off is the same crate that rides the belts');
A.ok(/captionPlate\(c, label, box, '#5fd8ff'\)/.test(marks) && !/shadowBlur/.test(marks), '…and its label is a plate');
A.ok(/ghost\.draw\(ctx, now, t, capFs\(\), \(box, paint\) => voiceSay\('ghostCaption', box, box, paint\), captionFit\);/.test(build), 'the projection\'s captions take the same size and stay on the glass');
const gdraw = at(ghost, '    function draw(ctx, nowMs, T, fontPx, say, fit) {', '    function reset()');
A.ok(/ctx\.fillStyle = 'rgba\(4,6,8,0\.86\)'; ctx\.fillRect\(b\.x, b\.y, b\.w, b\.h\);/.test(gdraw) && /ctx\.setLineDash\(\[3 \* px1, 2 \* px1\]\)/.test(gdraw) && !/shadowBlur/.test(ghost), 'a WOULD-caption is a plate edged with a DASHED hairline (dashed = projected), with no glow');
A.ok(/return \(fit && fit\(b\)\) \|\| b;/.test(gdraw), '…placed by the caller\'s fit when it gives one');
A.ok(/k < 0\.12 \? k \/ 0\.12 : k > 0\.75 \? \(1 - k\) \/ 0\.25 : 1/.test(gdraw), '…and lit while it is read');
const wait = at(world, '  function drawWaitCrate(cx, cy) {', '  /* SHIPPED TODAY'), ship = at(world, '  function drawShipCrate(cx, cy, pop) {', '  // E2 verification hooks');
A.ok(/Conveyor\.drawCrate\(ctx, Math\.round\(cx\), Math\.round\(cy\), 'ore'\)/.test(wait) && /Conveyor\.drawCrate\(ctx, x, y, 'product'\)/.test(ship), 'the INBOX\'s waiting jam and the OUTBOX\'s shipped pallet park the same crate');

A.report('workflow-panel-overhaul.test');
