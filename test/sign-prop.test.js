/* test/sign-prop.test.js — the SIGNS as objects on the floor: catalog, model, saving.

   The text engine (signtext.test.js) decides how big a board is. This file pins down everything
   around it:
     - the three signs are in the catalog as DECOR under their own SIGNS shelf, and each has art;
     - the model stores the words AND the size the engine asked for, in one edit;
     - a board that has to grow into something else is REFUSED (a sign must never eat a machine);
     - the words survive a save/load round trip (migrate keeps them) — a sign whose text was lost
       on reload would be a lie on the floor.

   The model never imports the catalog (the catalog is INJECTED), so the test injects it the same
   way the app does. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');

/* the prop art needs the global U (util.js is a browser script) — lift it out, exactly like
   prop-render-smoke.test.js does */
global.window = global.window || { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
global.document = global.document || { addEventListener() {}, documentElement: { style: { setProperty() {} } }, createElement: () => ({ getContext: () => null, style: {} }) };
const utilSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'util.js'), 'utf8');
global.U = new Function(utilSrc + '; return U;')();

const WM = require('../frontend/app/worldmodel.js');
const S = require('../frontend/app/signtext.js');
const PS = require('../frontend/app/propsprites.js');

WM.setPropRules(t => { const s = PS.spec(t); return s ? { mount: s.mount || null, stack: !!s.stack, surface: !!s.surface, flat: !!s.flat } : null; });

/* a room with room to grow a sign into (the fresh doc already owns a starter room, so this one
   stands beside it) */
function station() {
  const s = WM.create();
  const r = s.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 52, y2: 10 } });
  A.ok(r.ok, 'test room placed');
  return s;
}

/* ---- the catalog ---- */
{
  for (const id of Object.keys(S.STYLES)) {
    const row = PS.spec(id);
    A.ok(!!row, id + ' is in the catalog');
    A.eq(row.cat, 'signs', id + ' sits in the SIGNS shelf');
    A.eq(row.tier, 'cosmetic', id + ' is decoration — a sign grants no power');
    A.eq(PS.CAT_LABEL.signs, 'SIGNS', 'the shelf has a name the Commander can read');
    A.eq(PS.has(id), true, id + ' has art');
    A.ok(!!row.desc, id + ' explains itself in the hover card');
  }
  /* the catalog row is the EMPTY board — the size the words ask for arrives with the words */
  for (const id of Object.keys(S.STYLES)) {
    const row = PS.spec(id), empty = S.box('', id);
    A.eq([row.w, row.h], [empty.w, empty.h], id + ' ships as the engine\u2019s empty board');
  }
}

/* ---- the model: words + size, in one edit ---- */
{
  const s = station();
  const placed = s.addProp({ t: 'sign_board', x: 2, y: 2, w: 2, h: 1, block: true });
  A.ok(placed.ok, 'a sign board places');
  const text = 'RESEARCH LINE ALPHA';
  const box = S.box(text, 'sign_board');
  const res = s.setPropText(placed.id, text, box);
  A.ok(res.ok, 'the words are set');
  A.eq(res.text, text, 'the model stores the words');
  A.eq([res.w, res.h], [box.w, box.h], 'the model stores the size the engine asked for');
  const p = s.propById(placed.id);
  A.eq(p.text, text, 'the prop carries the words');
  A.eq([p.w, p.h], [box.w, box.h], 'the prop really is that big on the floor');
}

/* ---- a sign with no words is a small board, not a big empty one ---- */
{
  const s = station();
  const placed = s.addProp({ t: 'sign_board', x: 2, y: 2, w: 2, h: 1, block: true });
  const res = s.setPropText(placed.id, '', S.box('', 'sign_board'));
  A.ok(res.ok, 'clearing the words is an edit like any other');
  A.eq(res.text, null, 'an empty sign carries no words');
  A.eq([res.w, res.h], [S.STYLES.sign_board.minW, S.STYLES.sign_board.minH], 'an empty sign is the smallest board');
}

/* ---- a board that would grow into a machine is REFUSED ---- */
{
  const s = station();
  const sign = s.addProp({ t: 'sign_board', x: 2, y: 2, w: 2, h: 1, block: true });
  const machine = s.addProp({ t: 'crate', x: 4, y: 2, w: 2, h: 1, block: true });
  A.ok(machine.ok, 'a crate stands next to the sign');
  const wide = S.box('A VERY LONG LABEL INDEED FOR THE LINE', 'sign_board');
  const res = s.setPropText(sign.id, 'A VERY LONG LABEL INDEED FOR THE LINE', wide);
  A.eq(res.ok, false, 'a board may not grow into the crate beside it');
  A.eq(res.error, 'OVERLAP', '…and it says why');
  const p = s.propById(sign.id);
  A.eq(p.text, undefined, 'the refused edit changed nothing');
  A.eq([p.w, p.h], [2, 1], 'the refused edit did not resize the board either');
}

/* ---- a board that would grow off the deck is refused too ---- */
{
  const s = station();
  const sign = s.addProp({ t: 'sign_board', x: 51, y: 2, w: 2, h: 1, block: true });
  A.ok(sign.ok, 'the sign stands at the edge of the room');
  const res = s.setPropText(sign.id, 'A VERY LONG LABEL INDEED', S.box('A VERY LONG LABEL INDEED', 'sign_board'));
  A.eq(res.ok, false, 'a board may not grow off the deck');
  A.eq(res.error, 'OFF_DECK', '…and it says why');
}

/* ---- the words survive a save / load round trip ---- */
{
  const s = station();
  const placed = s.addProp({ t: 'sign_pylon', x: 3, y: 3, w: 1, h: 2, block: true });
  const text = 'LINE B\nSECOND ROW';
  const box = S.box(text, 'sign_pylon');
  s.setPropText(placed.id, text, box);
  const doc = s.serialize();
  const back = WM.deserialize(doc);
  const p = back.propById(placed.id);
  A.ok(!!p, 'the sign is still there after a reload');
  A.eq(p.text, text, 'the words survived the reload');
  A.eq([p.w, p.h], [box.w, box.h], 'the board kept its size');
}

/* ---- a legacy/hand-edited blob can never smuggle an unbounded text into a save ---- */
{
  const s = station();
  const placed = s.addProp({ t: 'sign_board', x: 2, y: 2, w: 2, h: 1, block: true });
  const doc = s.serialize();
  const prop = doc.props.find(p => p.id === placed.id);
  prop.text = 'x'.repeat(5000);
  const back = WM.deserialize(doc);
  A.ok(back.propById(placed.id).text.length <= 240, 'the text is bounded on the way in');
}

/* ---- a copy of a sign keeps its words (the builder copies the text with the board) ---- */
{
  const s = station();
  const placed = s.addProp({ t: 'sign_board', x: 2, y: 2, w: 2, h: 1, block: true });
  const text = 'LINE ALPHA';
  s.setPropText(placed.id, text, S.box(text, 'sign_board'));
  const copy = s.addProp({ t: 'sign_board', x: 8, y: 2, w: 2, h: 1, block: true, text });
  A.ok(copy.ok, 'the copy places');
  A.eq(s.propById(copy.id).text, text, 'the copy carries the words too');
}

/* ---- the words really reach the pixels ---- */
{
  /* a recording 2D context: fillText is what the words are drawn with */
  const texts = [], rects = [];
  const noop = () => {};
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '', textAlign: '', textBaseline: '',
    fillRect(x, y, w, h) { if (w > 0 && h > 0) rects.push([x, y, w, h]); },
    fillText(t) { texts.push(String(t)); },
    measureText: () => ({ width: 0 }),
    strokeRect: noop, clearRect: noop, save: noop, restore: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, arc: noop, ellipse: noop, rect: noop, fill: noop, stroke: noop, clip: noop,
    translate: noop, scale: noop, rotate: noop, transform: noop,
    createLinearGradient: () => ({ addColorStop: noop }), drawImage: noop,
    getImageData: () => ({ data: [] }), putImageData: noop,
  };
  PS.setCtx(ctx); PS.setNow(0);
  const box = S.box('LINE ALPHA', 'sign_board');
  PS.draw({ t: 'sign_board', x: 2, y: 2, w: box.w, h: box.h, text: 'LINE ALPHA' }, false);
  A.ok(texts.indexOf('LINE ALPHA') >= 0, 'the words are drawn on the board');
  A.ok(rects.length > 6, 'the board itself is painted (' + rects.length + ' rects)');
  /* an EMPTY board draws no words at all — it never invents a placeholder sentence */
  texts.length = 0;
  PS.draw({ t: 'sign_board', x: 2, y: 2, w: box.w, h: box.h }, false);
  A.eq(texts, [], 'an empty board carries no words');
}

A.report('sign-prop.test');
