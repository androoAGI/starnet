/* test/sign-editor.test.js — the SIGN EDITOR in BUILD MODE: the words reach the floor.

   The engine measures the text, the model stores it, the art draws it. The missing link is the
   EDITOR: one click on a board, one field, and the words land on the prop — with the size shown
   BEFORE it is set, so a growing board is never a surprise.

   build.js is a browser IIFE, so the editor is lifted out of the source and run in a vm with
   its collaborators stubbed (the same trick build-rightclick-furniture.test.js uses). The DOM is
   a thin fake: the card's markup is a template string, so the fake hands back the elements the
   editor asks for by selector. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const S = require('../frontend/app/signtext.js');

const build = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'build.js'), 'utf8');

/* lift one function out of the browser source */
function fn(name) {
  const at = build.indexOf('  function ' + name + '(');
  A.ok(at > 0, name + ' exists in build.js');
  let depth = 0, i = build.indexOf('{', at);
  for (; i < build.length; i++) { if (build[i] === '{') depth++; else if (build[i] === '}' && --depth === 0) break; }
  return build.slice(at, i + 1);
}

/* ---- the thin fake DOM ---- */
function fakeNode() {
  return {
    className: '', innerHTML: '', value: '', textContent: '', parentNode: null, onclick: null,
    _h: {}, _q: {},
    classList: { add() {} },
    addEventListener(ev, fn) { this._h[ev] = fn; },
    appendChild(c) { this.children = (this.children || []); this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = (this.children || []).filter(x => x !== c); c.parentNode = null; },
    focus() {}, select() {},
    querySelector(sel) { return this._q[sel] || null; },
    querySelectorAll() { return []; },
  };
}
const area = fakeNode(), size = fakeNode(), applyBtn = fakeNode(), clearBtn = fakeNode(), cancelBtn = fakeNode();
const g = fakeNode();
g._q = { '.refit-sign-text': area, '.refit-sign-size': size, '#sign-apply': applyBtn, '#sign-clear': clearBtn, '#sign-cancel': cancelBtn };
const root = { appendChild(c) { g.parentNode = root; return c; }, removeChild(c) { g.parentNode = null; } };

/* ---- the world the editor talks to ---- */
const prop = { id: 'p7', t: 'sign_board', x: 2, y: 2, w: 2, h: 1, text: '' };
const setCalls = [], tips = [];
const ctx = vm.createContext({
  root, document: { createElement: () => g },
  SignText: S,
  station: {
    propById: id => (id === prop.id ? prop : null),
    setPropText: (id, text, box) => { setCalls.push({ id, text, box }); return { ok: true, id, text, w: box.w, h: box.h }; },
  },
  cardCloseAll() {}, cardRegister() {}, requestAnimationFrame() {}, setTimeout() { return 0; },
  esc: s => String(s), propLabel: t => String(t).toUpperCase(),
  sfx() {}, flashTip(ev, text, ok) { tips.push({ text, ok }); },
  renderSelection() {},
});
vm.runInContext(fn('openSignEditor'), ctx);

/* ---- 1. clicking a board opens the editor, pre-filled with its words ---- */
prop.text = 'LINE ALPHA';
vm.runInContext('openSignEditor("p7", null)', ctx);
A.eq(area.value, 'LINE ALPHA', 'the editor opens with the words the board already carries');

/* ---- 2. the size readout follows the text ---- */
area.value = 'RESEARCH LINE ALPHA';
area._h.input();
const expected = S.box('RESEARCH LINE ALPHA', 'sign_board');
A.eq(size.textContent, expected.w + ' × ' + expected.h + ' TILES', 'the editor says how big the board will get');

/* ---- 3. SET WORDS hands the text AND the size to the model ---- */
area.value = 'RESEARCH LINE ALPHA';
applyBtn.onclick();
A.eq(setCalls.length, 1, 'the model is asked exactly once');
A.eq(setCalls[0].id, 'p7', 'the right board');
A.eq(setCalls[0].text, 'RESEARCH LINE ALPHA', 'the words go in unchanged');
A.eq([setCalls[0].box.w, setCalls[0].box.h], [expected.w, expected.h], 'the size the engine asked for goes with them');
A.eq(tips.length, 1, 'the editor says what happened');
A.eq(tips[0].ok, true, '…and it went well');

/* ---- 4. CLEAR empties the board ---- */
setCalls.length = 0; tips.length = 0;
clearBtn.onclick();
A.eq(setCalls.length, 1, 'clearing is an edit like any other');
A.eq(setCalls[0].text, '', 'the words are gone');
A.eq([setCalls[0].box.w, setCalls[0].box.h], [S.STYLES.sign_board.minW, S.STYLES.sign_board.minH], 'the board shrank to its smallest');

/* ---- 5. a REFUSED edit keeps the editor open and says why ---- */
{
  const g2 = fakeNode();
  const area2 = fakeNode(), size2 = fakeNode(), apply2 = fakeNode(), clear2 = fakeNode(), cancel2 = fakeNode();
  g2._q = { '.refit-sign-text': area2, '.refit-sign-size': size2, '#sign-apply': apply2, '#sign-clear': clear2, '#sign-cancel': cancel2 };
  const root2 = { appendChild(c) { g2.parentNode = root2; return c; }, removeChild(c) { g2.parentNode = null; } };
  const refused = [];
  const ctx2 = vm.createContext({
    root: root2, document: { createElement: () => g2 }, SignText: S,
    station: { propById: () => ({ id: 'p9', t: 'sign_board', x: 2, y: 2, w: 2, h: 1 }),
      setPropText: () => ({ ok: false, error: 'OVERLAP', msg: 'overlaps a prop' }) },
    cardCloseAll() {}, cardRegister() {}, requestAnimationFrame() {}, setTimeout() { return 0; },
    esc: s => String(s), propLabel: t => String(t).toUpperCase(),
    sfx() {}, flashTip(ev, text, ok) { refused.push({ text, ok }); }, renderSelection() {},
  });
  vm.runInContext(fn('openSignEditor'), ctx2);
  vm.runInContext('openSignEditor("p9", null)', ctx2);
  apply2.onclick();
  A.eq(refused.length, 1, 'a refused edit says so');
  A.eq(refused[0].ok, false, '…and it is not dressed up as a success');
  A.ok(/overlaps/.test(refused[0].text), '…with the reason');
  A.eq(g2.parentNode !== null, true, 'the editor stays open — the words are not lost');
}

/* ---- 6. the editor is REACHABLE: the click paths lead to it ---- */
A.ok(/if \(isSignProp\(t\)\) return openSignEditor\(p\.id, ev\);/.test(build), 'clicking a board opens the editor');
A.ok(/if\(isSignProp\(p\.t\)\)return openSignEditor\(p\.id,ev\);/.test(build), 'inspecting a board opens the editor');
A.ok(/isSignProp\(p\.t\)\)add\('WORDS'/.test(build), 'the selection card offers the editor');
A.ok(/if \(res && res\.ok && typeof SignText !== 'undefined' && SignText\.isSign\(propType\)\)/.test(build), 'a board placed asks for its words right away');

A.report('sign-editor.test');
