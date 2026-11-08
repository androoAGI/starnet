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

// ---- the world keeps its own colours (Andrew 2026-11-08: "it should only apply to the dashboard not add filters to
// the world itself"). The identity is chrome around the station view, never a tint or filter on it ----
const world = read('frontend/app/world.js');
A.ok(!/drawPhosphorGrade|phosphorFeed|CRT\.mono/.test(world), 'world.js paints no phosphor grade: the station renders in true colour');
A.ok(!/classList\.contains\('vx'\)/.test(world), 'world.js never reads body.vx: the dashboard identity cannot change the world');
const viewRules = (css.match(/[^{}]*#stage-wrap[^{}]*\{[^}]*\}/g) || []).join(' ');
A.ok(viewRules.length > 0, 'vector.css frames the station view');
A.ok(!/(^|[^-])filter\s*:(?!\s*(none|drop-shadow))/m.test(viewRules) && !/mix-blend-mode/.test(viewRules),
  'vector.css puts no colour filter or blend on the station view (frame lines only)');

A.report('vector-identity');
