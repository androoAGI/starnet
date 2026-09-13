/* test/proprotate.test.js — PROP ORIENTATION: what turns, what it turns INTO, and what rides the doc.

   Two failure modes this exists to catch, both of which shipped in the earlier rotation lane:

   1. A FACING THAT DRAWS NOTHING NEW. An R key that silently falls back to the south art is the same
      lie as a view that paints an empty box, so eligibility is MEASURED here — every facing a prop
      offers is drawn through a recording context and must differ from its south view.
   2. A TURN THAT RESIZES AN UPRIGHT PROP. `arcade` is authored 1x2 because it is TALL, not deep; the
      old code read that 2 as depth and a quarter turn made the cabinet twice as wide as itself. Only
      a floor DECAL (its footprint IS its picture) or a TABLE (its footprint IS its top surface) may
      re-tile, and the painted box has to agree with the reserved box either way.

   Plus the plumbing: r/m survive addProp -> serialize -> migrate -> projectGeometry, a turn is one
   undo step, and a prop's approach side turns with it. */
'use strict';
const A = require('./_assert.js');
const path = require('node:path');
const fs = require('node:fs');

const utilSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'util.js'), 'utf8');
global.window = global.window || { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
global.document = global.document || { addEventListener() {}, documentElement: { style: { setProperty() {} } }, createElement: () => ({ getContext: () => null, style: {} }) };
global.U = new Function(utilSrc + '; return U;')();

const PS = require('../frontend/app/propsprites.js');
const WM = require('../frontend/app/worldmodel.js');
const PA = require('../frontend/app/propanchor.js');
const TILE = PS.TILE;

/* a recording 2D context. It honours translate/transform/scale exactly the way the turned-decal
   path needs it to, so a rotated draw reports the pixels it really lands on. */
function recorder() {
  const rects = [];
  const noop = () => {};
  let m = [1, 0, 0, 1, 0, 0], stack = [];
  const mul = (a, b) => [                                  // a then b, both [a,b,c,d,e,f]
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  const pt = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  return {
    rects,
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '', textAlign: '', textBaseline: '',
    fillRect(x, y, w, h) {
      if (!(w > 0 && h > 0) || !isFinite(x) || !isFinite(y)) return;
      const p = [pt(x, y), pt(x + w, y), pt(x, y + h), pt(x + w, y + h)];
      const xs = p.map(q => q[0]), ys = p.map(q => q[1]);
      rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]);
    },
    save() { stack.push(m.slice()); }, restore() { m = stack.pop() || [1, 0, 0, 1, 0, 0]; },
    translate(tx, ty) { m = mul(m, [1, 0, 0, 1, tx, ty]); },
    scale(sx, sy) { m = mul(m, [sx, 0, 0, sy, 0, 0]); },
    transform(a, b, c, d, e, f2) { m = mul(m, [a, b, c, d, e, f2]); },
    setTransform(a, b, c, d, e, f2) { m = [a, b, c, d, e, f2]; },
    strokeRect: noop, clearRect: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, ellipse: noop, rect: noop, fill: noop, stroke: noop, clip: noop, rotate: noop,
    fillText: noop, measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    drawImage: noop, getImageData: () => ({ data: [] }), putImageData: noop,
  };
}

const ORIGIN = 3;
/* draw one prop at one facing and report the box it painted + a signature of the paint itself */
function shoot(id, r, box) {
  const ctx = recorder();
  PS.setCtx(ctx); PS.setNow(2400);
  PS.draw({ t: id, x: ORIGIN, y: ORIGIN, w: box.w, h: box.h, r: r, id: 'p1' }, true);
  const rs = ctx.rects;
  if (!rs.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y, w, h] of rs) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  return { n: rs.length, w: x1 - x0, h: y1 - y0, sig: rs.map(a => a.map(v => Math.round(v)).join(',')).join(';') };
}

/* ---------- 1. eligibility is honest ---------- */
let rotatables = 0, sideViews = 0;
for (const spec of PS.CATALOG) {
  const fs2 = PS.facings(spec.id);
  A.ok(fs2[0] === 0, spec.id + ': south is always the first facing');
  if (fs2.length === 1) { A.ok(!PS.canRotate(spec.id), spec.id + ': one facing means canRotate is false'); continue; }
  rotatables++;
  A.ok(spec.tier !== 'functional', spec.id + ': only cosmetic props turn (a functional prop\'s facing is load-bearing)');
  const south = shoot(spec.id, 0, { w: spec.w, h: spec.h });
  A.ok(south, spec.id + ': paints something facing south');
  for (const r of fs2.slice(1)) {
    const box = PS.footprintAt(spec.id, r);
    const shot = shoot(spec.id, r, box);
    A.ok(shot, spec.id + ' r=' + r + ': paints something');
    // THE FACING MUST BE A DIFFERENT PICTURE — this is what makes "it rotates" a true claim
    A.ok(shot && shot.sig !== south.sig, spec.id + ' r=' + r + ': draws something OTHER than its south view');
    // AND IT MUST FILL THE BOX IT RESERVED: a turned view is drawn for the box it occupies
    if (shot) {
      A.ok(Math.abs(shot.w - box.w * TILE) <= 12, spec.id + ' r=' + r + ': painted width matches the reserved box');
      A.ok(shot.h >= box.h * TILE * 0.5, spec.id + ' r=' + r + ': painted height fills the reserved box');
    }
    if (!spec.flat) sideViews++;
  }
  // A TURN NEVER RESIZES AN UPRIGHT PROP
  for (const r of [1, 3]) {
    const box = PS.footprintAt(spec.id, r);
    const swapped = box.w !== spec.w || box.h !== spec.h;
    if (swapped) A.ok(spec.flat || spec.surface || PS.PLAN_FOOTPRINT.indexOf(spec.id) >= 0,
      spec.id + ': a turn only re-tiles a prop whose footprint IS its plan (decal, table, sofa)');
  }
}
A.ok(rotatables >= 5, 'the catalog has real rotatable props (got ' + rotatables + ')');
A.ok(sideViews >= 3, 'authored (non-decal) turned views exist (got ' + sideViews + ')');

/* the props this lane authored, named so a deletion is loud rather than silent */
A.eq(PS.facings('chair'), [0, 1, 2, 3], 'CHAIR turns to all four facings');
A.eq(PS.facings('loungetable'), [0, 3], 'LOUNGE TABLE offers ONE turn — its two sides are the same picture');
A.eq(PS.facings('longtable'), [0, 3], 'LONG TABLE offers ONE turn');
A.eq(PS.footprintAt('longtable', 3), { w: 1, h: 3 }, 'a turned 3x1 table really is 1x3');
A.eq(PS.footprintAt('chair', 3), { w: 1, h: 1 }, 'a turned chair keeps its box');
A.eq(PS.facings('stool'), [0], 'the STOOL is round — it offers no turn at all');
A.eq(PS.facings('desk'), [0], 'a WORKSTATION never turns (its front is load-bearing)');
/* the COUCH deliberately does NOT turn: a west-facing sofa view was authored in an earlier lane and
   is not part of what shipped here, so the couch keeps trunk's behaviour and offers south only. */
A.eq(PS.facings('couch'), [0], 'the COUCH offers no turn (its turned view is not part of this lane)');
/* the seats and tables THIS lane authored, named so a deletion is loud rather than silent */
A.eq(PS.facings('podchair'), [0, 1, 2, 3], 'POD CHAIR turns to all four facings');
A.eq(PS.facings('dinerchair'), [0, 1, 2, 3], 'DINER CHAIR turns to all four facings');
A.eq(PS.facings('booth'), [0, 1, 3], 'the BOOTH turns to the sides but has NO back view');
A.eq(PS.facings('lowtable'), [0, 3], 'LOW TABLE offers ONE turn');
A.eq(PS.facings('glasstable'), [0, 3], 'GLASS TABLE offers ONE turn');
A.eq(PS.facings('dinertable'), [0, 3], 'DINER TABLE offers ONE turn');
A.eq(PS.footprintAt('dinertable', 3), { w: 2, h: 3 }, 'a turned 3x2 diner table really is 2x3');
A.eq(PS.footprintAt('booth', 3), { w: 1, h: 2 }, 'a turned 2x1 booth really is 1x2');
A.eq(PS.facings('guitar'), [0], 'the GUITAR offers no turn — it is one object on a stand');

/* R must never dead-end: nextFacing walks the prop's own cycle in both directions */
for (const id of ['chair', 'longtable', 'rug']) {
  const fs2 = PS.facings(id);
  let r = 0;
  for (let i = 0; i < fs2.length; i++) r = PS.nextFacing(id, r, 1);
  A.eq(r, 0, id + ': R all the way round comes back to south');
  A.eq(PS.nextFacing(id, 0, -1), fs2[fs2.length - 1], id + ': shift+R steps back to the last facing');
}
A.eq(PS.nextFacing('stool', 0, 1), 0, 'a prop with one facing has nowhere to go');

/* ---------- 2. the doc carries it ---------- */
const st = WM.create(WM.defaultDoc());
const rid = st.rooms()[0].id;
st.setFloor && st.setFloor(rid);
const room = st.roomById(rid).rects[0];
const bx = room.x1 + 1, by = room.y1 + 1;
const add = st.addProp({ t: 'chair', x: bx, y: by, w: 1, h: 1, block: true, r: 3 });
A.ok(add.ok, 'a prop can be placed already turned: ' + JSON.stringify(add));
A.eq(st.propById(add.id).r, 3, 'the facing is stored on the doc');
const plain = st.addProp({ t: 'stool', x: bx + 2, y: by, w: 1, h: 1, block: true });
A.ok(plain.ok && !('r' in st.propById(plain.id)) && !('m' in st.propById(plain.id)),
  'an unturned prop serializes byte-identical to before — no r, no m');

const ser = JSON.parse(JSON.stringify(st.serialize ? st.serialize() : st.doc()));
const back = WM.create(WM.migrate ? WM.migrate(ser) : ser);
const kept = back.props().find(p => p.t === 'chair');
A.eq(kept && kept.r, 3, 'r survives serialize -> migrate');
const geo = back.projectGeometry();
const lp = geo.props.find(p => p.t === 'chair');
A.eq(lp && lp.r, 3, 'r reaches the renderer through projectGeometry');

/* a turn is ONE undo step, and it restores the previous facing */
const t1 = st.rotateProp(add.id, 1);
A.ok(t1.ok && !('r' in st.propById(add.id)), 'a quarter turn from east lands back on south — and DROPS the field rather than storing a default');
st.undo();
A.eq(st.propById(add.id).r, 3, 'UNDO restores the facing');
const mir = st.mirrorProp(add.id);
A.ok(mir.ok && st.propById(add.id).m === 1, 'a prop can be flipped');
st.mirrorProp(add.id);
A.ok(!('m' in st.propById(add.id)), 'flipping twice removes the field rather than storing a default');

/* a table turn RESIZES, and can be refused when the new box does not fit */
const tb = st.addProp({ t: 'longtable', x: bx + 4, y: by, w: 3, h: 1, block: true });
A.ok(tb.ok, 'a long table is placed');
const turn = st.faceProp(tb.id, 3, PS.footprintAt('longtable', 3));
A.ok(turn.ok, 'the table turns: ' + JSON.stringify(turn));
A.eq([st.propById(tb.id).w, st.propById(tb.id).h], [1, 3], 'and its footprint really is 1x3 now');

/* ---------- 3. the approach side turns with the prop ---------- */
A.eq(PA.frontOf({ r: 0 }), 'south', 'an unturned prop fronts south');
A.eq(PA.frontOf({ r: 1 }), 'west', 'one clockwise quarter turn points its front west');
A.eq(PA.frontOf({ r: 2 }), 'north', 'two point it north');
A.eq(PA.frontOf({ r: 3 }), 'east', 'three point it east');
const openGeo = { walkable: () => true };
const a0 = PA.deriveAnchor({ x: 5, y: 5, w: 1, h: 1 }, openGeo, { approach: 'front' });
A.eq([a0.tx, a0.ty, a0.face], [5, 6, 'north'], 'an unturned prop is walked up to from the south');
const a3 = PA.deriveAnchor({ x: 5, y: 5, w: 1, h: 1, r: 3 }, openGeo, { approach: 'front' });
A.eq([a3.tx, a3.ty, a3.face], [6, 5, 'west'], 'a prop turned east is walked up to from the EAST');
const aPlain = PA.deriveAnchor({ x: 5, y: 5, w: 1, h: 1 }, openGeo, { approach: 'south' });
A.eq([aPlain.tx, aPlain.ty], [5, 6], 'an absolute compass approach is unchanged by all of this');


/* ---------- 4. the builder turns saved boxes, not today's catalog size ---------- */
const buildSource = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'build.js'), 'utf8');
const boxSource = A.fnBody(buildSource, 'function propBox(');
const turnSource = A.fnBody(buildSource, 'function turnUnderCursor(');
A.ok(boxSource.length > 100 && boxSource.length < 1300, 'builder box test binds exactly the real sizing helper');
A.ok(turnSource.length > 500 && turnSource.length < 2200, 'builder turn test binds exactly the real keyboard turn handler');
// Model the remaster's authored four-facing upright desk and its new catalog
// width. The saved document below intentionally retains the earlier compact size.
const remasterPS = {
  ...PS,
  spec: id => id === 'desk' ? { ...PS.spec(id), w: 3, h: 1 } : PS.spec(id),
  footprintAt: (id, r) => id === 'desk' ? { w: 3, h: 1 } : PS.footprintAt(id, r),
  canRotate: id => id === 'desk' || PS.canRotate(id),
  nextFacing: (id, r, dir) => id === 'desk' ? ((r + dir) & 3) : PS.nextFacing(id, r, dir)
};
const boxFor = new Function('PS', 'propSpec', boxSource + '; return propBox;')(() => remasterPS, id => remasterPS.spec(id));
function builderTurn(station, id, dir = 1) {
  let result;
  const noop = () => {};
  const turn = new Function('station', 'orientEv', 'orientTarget', 'canTurn', 'nextFace', 'propBox',
    'pushFlash', 'feedback', 'sfx', 'flashTip', 'propLabel', 'FACE_WORD', turnSource + ';return turnUnderCursor;')(
    station, () => ({ clientX: 0, clientY: 0 }), () => station.propById(id), remasterPS.canRotate,
    remasterPS.nextFacing, boxFor, noop, res => { result = res; }, noop, noop, t => t, ['south', 'west', 'north', 'east']);
  turn(dir); return result;
}
const savedStation = WM.create(WM.defaultDoc());
savedStation.rooms()[0].rects = [{ x1: 0, y1: 0, x2: 12, y2: 10 }];
const compact = savedStation.addProp({ t: 'desk', x: 1, y: 1, w: 2, h: 1, block: true });
const neighbour = savedStation.addProp({ t: 'stool', x: 3, y: 1, w: 1, h: 1, block: true });
A.ok(compact.ok && neighbour.ok, 'compact saved desk has a real blocking prop beside its exact footprint');
for (const facing of [1, 2, 3, 0]) {
  A.ok(builderTurn(savedStation, compact.id).ok, 'compact desk turns successfully beside its neighbour');
  const p = savedStation.propById(compact.id);
  A.eq([p.w, p.h, p.r | 0], [2, 1, facing], 'upright desk changes facing without adopting catalog 3x1 size');
}
savedStation.undo();
A.eq([savedStation.propById(compact.id).w, savedStation.propById(compact.id).h, savedStation.propById(compact.id).r], [2, 1, 3], 'undo restores compact size and the previous facing');
const restoredStation = WM.create(JSON.parse(JSON.stringify(savedStation.doc())));
A.ok(builderTurn(restoredStation, compact.id, -1).ok, 'compact saved desk remains turnable after reload');
A.eq([restoredStation.propById(compact.id).w, restoredStation.propById(compact.id).h], [2, 1], 'reloaded upright desk still preserves its original footprint');
for (const [type, x, w, h] of [['rug', 1, 4, 3], ['longtable', 7, 2, 1], ['booth', 10, 2, 1]]) {
  const made = savedStation.addProp({ t: type, x, y: 5, w, h, block: type !== 'rug' });
  A.ok(made.ok, type + ' saved plan prop is placed');
  A.ok(builderTurn(savedStation, made.id).ok, type + ' builder turn is accepted');
  let p = savedStation.propById(made.id);
  A.eq([p.w, p.h], [h, w], type + ' rotates its actual saved floor plan');
  A.ok(builderTurn(savedStation, made.id, -1).ok, type + ' reverse turn is accepted');
  p = savedStation.propById(made.id);
  A.eq([p.w, p.h], [w, h], type + ' reverse turn restores its exact original size');
}
const customRug = savedStation.addProp({ t: 'rug_small', x: 7, y: 8, w: 3, h: 2, block: false });
A.ok(customRug.ok && builderTurn(savedStation, customRug.id).ok, 'rectangular saved variant of a square catalog decal can turn');
A.eq([savedStation.propById(customRug.id).w, savedStation.propById(customRug.id).h], [2, 3], 'square catalog dimensions do not hide a real floor-plan rotation');
A.eq(boxFor('desk', 3), { w: 3, h: 1 }, 'new desk placement still uses the current catalog dimensions');
A.eq(boxFor('longtable', 3), { w: 1, h: 3 }, 'new plan placement still uses the catalog turned box');

A.report('proprotate');
