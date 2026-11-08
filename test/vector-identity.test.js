/* node test/vector-identity.test.js
   Locks the VECTOR identity (Andrew 2026-11-08: vector-phosphor screens in a dark-chrome chassis):
   - frontend/css/vector.css is the LAST stylesheet, and <body> boots with `vx`, so the identity is on before first paint;
   - every rule in vector.css is scoped under body.vx (the identity is one class away from off, never a leak);
   - the curved radius scales are zeroed in ONE place each (the family is closed by tokens, not per-surface patches), and
     window interiors square by structure (empty inline lights keep their round), never by [class] text;
   - the logo keeps no glow (Andrew's call) — the sheet never touches it;
   - world.js's phosphor feed is the truth law in code: one 'color' blend, gated on body.vx, drawn AFTER the environment
     and BEFORE every state signal, with the live-work layer moved after it while the feed is on. */
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
const unscoped = [];
for (const list of selectorLists) {
  for (const sel of list.split(/,(?![^(]*\))/).map(s => s.trim()).filter(Boolean)) {
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

// ---- world.js: the phosphor feed obeys the truth law ----
const world = read('frontend/app/world.js');
const grade = A.fnBody(world, 'function drawPhosphorGrade(');
A.ok(/globalCompositeOperation\s*=\s*'color'/.test(grade), 'the feed is one colour blend (luminance kept, hue = the theme)');
A.ok(/phosphorFeedOn\(\)/.test(grade), 'the grade is gated by phosphorFeedOn()');
const feedOn = A.fnBody(world, 'function phosphorFeedOn(');
A.ok(/classList\.contains\('vx'\)/.test(feedOn) && /CRT\.mono/.test(feedOn), 'the feed is on only with body.vx and a CRT.mono strength');

// drawScene() is the draw order. Sliced from its declaration to the next top-level one (fnBody's brace scan can stop
// early in a body this size: its regex-literal hazard), with a length guard so a mis-slice can't pass
const frameAt = world.indexOf('\n  function drawScene(');
const frame = world.slice(frameAt, world.indexOf('\n  function ', frameAt + 20));
A.ok(frameAt > 0 && frame.length > 4000 && frame.length < world.length / 4, 'drawScene() sliced whole (' + frame.length + ' chars)');
const at = (needle) => frame.indexOf(needle);
const gradeAt = at('drawPhosphorGrade(now)');
A.ok(gradeAt > 0, 'drawScene() draws the phosphor feed');
A.ok(at("reviewMark('lighting')") > 0 && at("reviewMark('lighting')") < gradeAt, 'the feed is drawn after the lighting (the environment is whole)');
for (const signal of ['drawDeskFlashes(now)', 'drawRunClocks(now)', 'drawWorkGlyphs(now)', 'drawActivityPlates(now)', 'drawAwaitTag(now)',
  'drawRoutingNags(now)', 'drawBayLamps(now)', 'drawLinePlates(now)', 'drawBubble(now)', 'drawNameplate(now']) {
  const i = at(signal);
  A.ok(i > gradeAt, signal + ' (a state signal) is drawn AFTER the phosphor feed, in its own colour');
}
// the live-work layer: before the lightmap without the feed, after the feed with it
const liveFn = frame.slice(at('const drawLiveWork = () => {'), at('if (!phosphorFeed) drawLiveWork();'));
for (const signal of ['convey.drawBoxes(', 'ghost.draw(', 'drawSummonLinks(now)', 'drawHandoffBoxes(now)', 'drawSendCrates()', 'drawQueueJam(now)', 'drawShippedPallet(now)']) {
  A.ok(liveFn.includes(signal), signal + ' rides the live-work layer');
  A.eq(frame.split(signal).length - 1, 1, signal + ' is drawn from one place only');
}
A.ok(at('if (!phosphorFeed) drawLiveWork();') < at("reviewMark('lighting')"), 'without the feed the live-work layer keeps its place under the lightmap');
const afterGrade = at('if (phosphorFeed) drawLiveWork();');
A.ok(afterGrade > gradeAt && afterGrade < at('drawDeskFlashes(now)'), 'with the feed the live-work layer draws right after it');

A.report('vector-identity');
