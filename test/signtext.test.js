/* test/signtext.test.js — the SIGN TEXT ENGINE: the words decide the board's size.

   The rule this file pins down is the one the whole feature rests on: a sign standing on the
   floor is sized by what the Commander wrote on it. Width follows the length of the text, height
   follows the number of paragraphs, and BOTH are clamped to what the mood of the sign can carry.
   If this drifts, the model stores one size, the art draws another and the board either spills
   its words over its frame or carries a frame the text never asked for.

   Pure module: no DOM, no canvas, no station. */
'use strict';
const A = require('./_assert.js');
const S = require('../frontend/app/signtext.js');

/* ---- the three moods exist and know their own limits ---- */
A.eq(Object.keys(S.STYLES).sort(), ['sign_board', 'sign_holo', 'sign_pylon'], 'the three sign moods are fixed');
A.eq(S.isSign('sign_board'), true, 'a sign board is a sign');
A.eq(S.isSign('desk'), false, 'a desk is not a sign');

/* ---- the text is cleaned before anything is measured ---- */
A.eq(S.normalize('LINE   A\r\n\r\n  RESEARCH  '), 'LINE A\nRESEARCH', 'runs of spaces collapse, empty paragraphs drop, CRLF folds');
A.eq(S.normalize(null), '', 'no text is no text');
A.eq(S.normalize('x'.repeat(400)).length, S.MAX_CHARS, 'a sign is a label, not a letter: the text is bounded');

/* ---- WIDTH follows the text ---- */
{
  const short = S.box('A', 'sign_board');
  const longer = S.box('RESEARCH LINE ALPHA', 'sign_board');
  A.ok(longer.w >= short.w, 'a longer text asks for a wider board (' + short.w + ' -> ' + longer.w + ')');
  A.ok(longer.w > short.w, 'a much longer text asks for a MEASURABLY wider board');
  A.ok(longer.w <= S.STYLES.sign_board.maxW, 'the board never grows past its mood');
  A.ok(short.w >= S.STYLES.sign_board.minW, 'the board never shrinks below its mood');
}

/* ---- HEIGHT follows the paragraphs ---- */
{
  const one = S.box('LINE ALPHA', 'sign_board');
  const three = S.box('LINE ALPHA\nSECOND ROW\nTHIRD ROW', 'sign_board');
  A.ok(three.h > one.h, 'more paragraphs ask for a taller board (' + one.h + ' -> ' + three.h + ')');
  A.ok(three.h <= S.STYLES.sign_board.maxH, 'the board never grows past its mood');
  const same = S.box('LINE ALPHA\nSECOND ROW', 'sign_board');
  A.ok(same.h >= one.h, 'a second paragraph never makes the board shorter');
}

/* ---- the two halves are independent: width from the length, height from the rows ---- */
{
  const wide = S.layout('A VERY LONG SINGLE LINE OF TEXT', 'sign_board');
  const tall = S.layout('A\nB\nC', 'sign_board');
  A.ok(wide.lines.length < tall.lines.length, 'one long line is fewer lines than three short rows');
  A.ok(wide.w > tall.w, 'one long line is wider than three short ones');
  A.ok(tall.h >= wide.h, 'three short rows are never shorter than one long line');
}

/* ---- every mood keeps its words inside its own board ---- */
for (const id of Object.keys(S.STYLES)) {
  const style = S.STYLES[id];
  const cases = ['', 'A', 'RESEARCH', 'RESEARCH LINE ALPHA', 'ONE\nTWO\nTHREE', 'A VERY LONG SENTENCE THAT KEEPS GOING AND GOING', 'WORT\n\n\n\nMEHR'];
  for (const text of cases) {
    const l = S.layout(text, id);
    A.ok(l.w >= style.minW && l.w <= style.maxW, id + ': the board width stays inside the mood (' + l.w + ')');
    A.ok(l.h >= style.minH && l.h <= style.maxH, id + ': the board height stays inside the mood (' + l.h + ')');
    for (const line of l.lines) A.ok(line.text.length <= Math.max(1, Math.floor((l.w * S.TILE - 2 * style.padX) / l.charW)),
      id + ': no line is wider than the board (' + line.text + ')');
  }
}

/* ---- an empty sign is the smallest board of its mood, and it carries no words ---- */
{
  const b = S.box('', 'sign_board');
  A.eq(b.w, S.STYLES.sign_board.minW, 'an empty board is the narrowest of its mood');
  A.eq(b.h, S.STYLES.sign_board.minH, 'an empty board is the lowest of its mood');
  A.eq(S.layout('', 'sign_board').lines.length, 0, 'an empty board has no lines to draw');
}

/* ---- FIT: the words as they fit INTO a board that already exists ---- */
{
  const l = S.fit('RESEARCH LINE ALPHA', 'sign_board', 4, 2);
  A.ok(l.w <= 4 && l.rawH <= 2, 'the fitted layout fits the board it was given');
  const clipped = S.fit('ONE\nTWO\nTHREE\nFOUR\nFIVE\nSIX\nSEVEN', 'sign_board', 2, 1);
  A.ok(clipped.lines.length <= 2, 'text that cannot fit is clipped, not drawn over the frame');
  A.eq(clipped.clipped, true, 'a clipped layout says so');
  A.ok(/…$/.test(clipped.lines[clipped.lines.length - 1].text), 'the clipped line ends in an ellipsis');
}

/* ---- a word longer than the line is BROKEN, never dropped ---- */
{
  const l = S.layout('SUPERCALIFRAGILISTICEXPIALIDOCIOUS', 'sign_pylon');
  A.ok(l.lines.length > 1, 'a word too long for the board is broken into lines');
  A.eq(l.lines.map(x => x.text).join(''), 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS', 'no character is lost');
}

/* ---- the empty-board box the catalog stores is the engine's own answer ---- */
{
  for (const id of Object.keys(S.STYLES)) {
    const b = S.box('', id);
    A.ok(b.w >= 1 && b.h >= 1, id + ': the empty board has a size');
  }
}

A.report('signtext.test');
