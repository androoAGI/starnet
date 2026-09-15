/* node test/recliner-side-seat.test.js — A BODY SITS IN THE RECLINER, NOT BEHIND IT (2026-08-17).

   THE BUG Andrew reported: "we have a new side angle chair the recliner, currently the agents do not
   even sit in it ... they sit behind it." He was right, and the cause was that the recliner is the
   catalog's first PROFILE seat wearing the couch's render rules. A couch is a low back a body shows
   over; those rules sort the WHOLE prop in front of its sitter. At 19px of chair over a 20px seated
   body that leaves nothing on screen but the crown of the head above the backrest.

   THE FIX has two halves and this file locks both:
     · world.js SIDE_SEAT — the body renders on the cushion, faces the way the chair points, and the
       chair sorts BEHIND it (a stool's rule) instead of in front (a sofa's).
     · propsprites drawSeatFront — the chair's near arm comes back OVER the sitter's shins, drawn by
       CLIPPING the seat's own draw function to its seat line rather than by copying those rows, so
       the overlay can never disagree with the base pass about what the chair looks like.

   The propsprites half is EXECUTED here against a recording context. The world.js half is a SOURCE
   LOCK — world.js is a browser IIFE that cannot be required under node, which is this repo's
   established pattern for it (see prop-awareness / crew-containment). */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');

/* ---------- propsprites: executed, not read ---------- */
const utilSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'util.js'), 'utf8');
global.window = global.window || { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
global.document = global.document || { addEventListener() {}, documentElement: { style: { setProperty() {} } }, createElement: () => ({ getContext: () => null, style: {} }) };
global.U = new Function(utilSrc + '; return U;')();

const PS = require('../frontend/app/propsprites.js');
const TILE = PS.TILE;

/* Same recorder idiom as prop-render-smoke, plus the two calls this lane actually turns on: `rect`
   (the clip band) and `clip` (that the band is armed at all). A noop clip means the recorded
   fillRects are the WHOLE chair — which is fine, because what is under test here is the band. */
function recorder() {
  const rects = [], clips = [];
  const noop = () => {};
  let pending = null;
  return {
    rects, clips,
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '', textAlign: '', textBaseline: '',
    fillRect(x, y, w, h) { if (w > 0 && h > 0 && isFinite(x) && isFinite(y)) rects.push([x, y, w, h]); },
    rect(x, y, w, h) { pending = [x, y, w, h]; },
    clip() { if (pending) clips.push(pending); pending = null; },
    strokeRect: noop, clearRect: noop,
    save: noop, restore: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, ellipse: noop, fill: noop, stroke: noop,
    translate: noop, scale: noop, rotate: noop, fillText: noop, measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    drawImage: noop, getImageData: () => ({ data: [] }), putImageData: noop,
  };
}

const TX = 4, TY = 5;                                  // a non-zero origin: a seat front that ignores f.x/f.y is caught
const SEAT_LINE = 3;                                   // px below the tile top where F.recliner's near arm starts

for (const t of ['recliner', 'recliner_r']) {
  const ctx = recorder();
  PS.setCtx(ctx); PS.setNow(0);
  PS.drawSeatFront({ t, x: TX, y: TY, w: 1, h: 1 });

  A.eq(ctx.clips.length, 1, t + ': the seat front arms exactly one clip band');
  const [, cy, , ch] = ctx.clips[0] || [0, 0, 0, 0];
  A.eq(cy, TY * TILE + SEAT_LINE, t + ": the band starts at the chair's seat line, so the sitter's lap stays visible");
  A.ok(ch >= TILE, t + ': the band reaches past the tile floor line, so the shins are covered all the way down');
  A.ok(ctx.rects.length >= 6, t + ': the seat front actually paints (a clipped no-op would leave the body bare)');

  /* The overlay must be the chair's OWN art. Painting it a second time over the base pass is only
     safe because it is the same function: compare it to a full base draw of the same prop and
     require the overlay's rows to be a subset of what the base already puts down. */
  const base = recorder();
  PS.setCtx(base); PS.setNow(0);
  PS.draw({ t, x: TX, y: TY, w: 1, h: 1 }, false);
  const key = r => r.join(':');
  const baseKeys = new Set(base.rects.map(key));
  const stray = ctx.rects.filter(r => !baseKeys.has(key(r)));
  A.eq(stray.length, 0, t + ': every rect the seat front paints is one the base pass paints too (no divergent copy to ghost)');
}

/* the stool/chair sliver is a different mechanism and must not have been swept into the new branch */
for (const t of ['stool', 'chair']) {
  const ctx = recorder();
  PS.setCtx(ctx); PS.setNow(0);
  PS.drawSeatFront({ t, x: TX, y: TY, w: 1, h: 1 });
  A.eq(ctx.clips.length, 0, t + ': the single-tile pad rim still paints unclipped, exactly as before');
  A.ok(ctx.rects.length >= 4, t + ': ...and still paints its rim');
}

/* The catalog rows stay exactly as they were, and that is the point: a profile seat is couch-kind, so
   the whole lounge/leisure machinery (planCouchSit, loungePair, the fun picker) already reaches it, and
   `use.sit` stays FALSE because that flag only ever meant "the generic PropAnchor path may pose a sit
   here" — the door the SEAT LAW shut on sofas and beds. Opening it would buy nothing (couch-kind never
   takes that path) and would quietly reopen the bed-sitting bug's route. */
for (const id of ['recliner', 'recliner_r']) {
  const spec = PS.CATALOG.find(c => c.id === id);
  A.ok(!!spec, id + ' is in the catalog');
  A.eq(spec.use.kind, 'couch', id + ' stays couch-kind (planCouchSit owns the cushion claim)');
  A.eq(spec.use.sit, false, id + " keeps the SEAT LAW's generic-path flag shut — SIDE_SEAT owns its sit");
  A.eq([spec.w, spec.h], [1, 1], id + ' is the single-tile footprint SIDE_SEAT is measured against');
}

/* ---------- world.js: source locks ---------- */
const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'world.js'), 'utf8');

const decl = src.slice(src.indexOf('const SIDE_SEAT ='), src.indexOf('function planCouchSit('));
const resolveSide=Function(decl+';return sideSeat;')();
for(const t of ['recliner','recliner_r']){
  const normal=resolveSide({t}),flipped=resolveSide({t,m:true});
  A.eq(flipped.dx,-normal.dx,t+' mirrored cushion follows the artwork');
  A.eq(flipped.face,normal.face==='west'?'east':'west',t+' mirrored sitter faces the front');
  A.eq(flipped.lift,normal.lift,t+' mirror retains the same perch');
}
A.ok(decl.length > 0, 'SIDE_SEAT is declared ahead of planCouchSit');
A.ok(/recliner:\s*\{\s*face:\s*'west'/.test(decl) && /recliner_r:\s*\{\s*face:\s*'east'/.test(decl),
  'each profile seat carries the ONE direction its art points (a chair cannot swivel to the planner)');
A.ok(/dx:\s*-?\d/.test(decl), 'and a cushion offset off tile centre, so the body rests against the crown');
/* The perch lift is load-bearing, not decoration: drawBody only switches to the sit frame's OWN bottom
   padding (getTrackPad) when a seat carries a lift. At 0 it anchors a seated body by its STANDING foot
   pad, and every set whose sit master has empty rows under the tucked legs (pikachu, xenomorph) floats
   up onto the backrest. A couch hides that behind its own back; a profile seat shows the whole body. */
A.ok(/lift:\s*[1-9]/.test(decl), 'and a non-zero perch lift, which is what makes every skin anchor by its own sit frame');

const pcs = src.slice(src.indexOf('function planCouchSit('), src.indexOf('/* SINGLE-TILE REAL SIT'));
A.ok(/const side = sideSeat\(couch\);/.test(pcs), 'planCouchSit resolves whether the cushion it claimed is a profile seat');
A.ok(/pendSeat = \{ px: \(sx \+ 0\.5\) \* T \+ \(side \? side\.dx : 0\), py: \(vertical \? sy \+ 1 : couch\.y \+ h\) \* T - 2, lift: side \? side\.lift :/.test(pcs),
  'profile seats retain their cushion offset, floor anchor and explicit perch ahead of authored sofa calibration');
A.ok(/self\.useFace = side \? side\.face :/.test(pcs),
  "a profile seat's sitter faces the way the chair points, not the way the planner guessed");

const lp = src.slice(src.indexOf('function loungePair('), src.indexOf('function stoolAt('));
A.ok(/const side = sideSeat\(couch\);\s*\n\s*if \(side && dirToward\(cx, cy, best\.tv\.cx, best\.tv\.cy\) !== side\.face\) continue;/.test(lp),
  'a profile seat is only a TV lounge when the screen is on the side it faces (never light a TV a body has its back to)');

const draw = src.slice(src.indexOf('const sitter = (agent && agent.seated'), src.indexOf('// the COVERS, after the body'));
A.ok(/const sitterSide = sitter \? sideSeat\(p\) : null;/.test(draw), 'the y-sort pass knows whether the prop under the sitter is a profile seat');
A.ok(/sitter\.seatPy \+ \(sitterUse && sitterUse\.kind === 'couch' && !sitterSide \? 1 : -1\)/.test(draw),
  'a profile seat sorts BEHIND its sitter (a stool\'s rule); every other couch still sorts in front');
A.ok(/\(\(sitterUse && sitterUse\.kind === 'seat'\) \|\| sitterSide\)/.test(draw),
  'and its near arm comes back over the sitter through the same seat-front overlay the stool uses');

A.report('recliner-side-seat');
