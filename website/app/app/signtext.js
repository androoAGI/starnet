/* STARNET — signtext.js : PURE sign-text layout engine (2026-10-21).

   A sign is a physical board standing on the station floor, and the Commander writes on it
   himself. The words decide how big the board has to be: a one-word label is a small plate, a
   notice with two paragraphs is a tall one. THIS FILE owns that rule and nothing else does.

   WHY A SEPARATE MODULE — the size of a board is read in three places that must never disagree:
   the model stores the footprint, the art draws the words onto the board, and the editor tells the
   Commander how big the board will get before they commit. One pure function (text -> lines ->
   tiles) feeds all three, so a board can never be drawn bigger than the space it was given.

   THE RULES
     - a paragraph is a line break in the text; paragraphs stack, so more paragraphs = a taller
       board (this is the "height follows the text" half);
     - a line is wrapped at the width the board can carry, so a longer text = a wider board
       (this is the "width follows the text" half);
     - both are CLAMPED: a board has a smallest and a largest size per mood, and a text that
       still does not fit is clipped with an ellipsis rather than drawn over its own frame;
     - the letter size shrinks (7 -> 4 px) before anything is clipped, exactly like the bay
       nameplate does for a long agent name.

   Pure + headless-safe: no DOM, no canvas, no station, no clock. A string goes in, a layout comes
   out. Loads under require() for the unit tests exactly like propsearch.js. */
'use strict';

const SignText = (() => {
  const TILE = 12;              // one station tile is 12px — the same constant the art and the model use
  const MAX_CHARS = 240;        // a sign is a label, not a letter: the text is bounded

  /* THE THREE MOODS. A sign is one of these three shapes, and each has its own letter metrics
     and its own size limits — the board the Commander gets is always one of these three.

     THE CHROME — the board is not only text. Every mood spends pixels around the words, and the
     ENGINE has to know how many, or it would promise a board whose face is one pixel tall:
       frameX/frameY  the plate's own border (left/right, top/bottom)
       padX/padY      the quiet margin INSIDE the text area
       extraH         what the mood needs BELOW the text area (the board's legs, the holo's
                      emitter, the pylon's mast and foot)
     The art reads these same numbers, so the measured board and the drawn board are one thing. */
  const STYLES = {
    sign_board: { id: 'sign_board', label: 'SIGN BOARD', font: 7, padX: 3, padY: 2, frameX: 2, frameY: 2, extraH: 4, minW: 2, maxW: 8, minH: 2, maxH: 4, maxChars: 22 },
    sign_holo:  { id: 'sign_holo',  label: 'HOLO SIGN',  font: 6, padX: 2, padY: 2, frameX: 1, frameY: 1, extraH: 5, minW: 2, maxW: 6, minH: 2, maxH: 4, maxChars: 18 },
    sign_pylon: { id: 'sign_pylon', label: 'SIGN PYLON', font: 7, padX: 2, padY: 2, frameX: 2, frameY: 2, extraH: 8, minW: 2, maxW: 3, minH: 2, maxH: 4, maxChars: 10 },
  };

  const styleFor = id => STYLES[id] || STYLES.sign_board;
  const isSign = id => !!STYLES[id];

  /* the pixel font is a monospace terminal face, so a character is worth about half its size */
  const metrics = (style, font) => ({ font, charW: Math.max(3, Math.round(font * 0.6)), lineH: font + 1 });

  /* ONE CLEAN TEXT: line endings folded, runs of spaces collapsed, empty paragraphs dropped,
     hard cap. The paragraphs (line breaks) survive — they are WHY a board gets taller. */
  function normalize(text) {
    const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const out = [];
    for (const line of raw.split('\n')) {
      const s = line.replace(/[ \t]+/g, ' ').trim();
      if (s) out.push(s);
    }
    return out.join('\n').slice(0, MAX_CHARS);
  }
  const paragraphsOf = text => { const n = normalize(text); return n ? n.split('\n') : []; };

  /* wrap ONE paragraph into lines of at most `max` characters. A single word longer than the
     line is broken rather than dropped: a sign never loses a word silently. */
  function wrapParagraph(text, max) {
    const limit = Math.max(1, max | 0), words = String(text).split(' ').filter(Boolean), lines = [];
    let line = '';
    for (const word of words) {
      let w = word;
      while (w.length > limit) {                       // a word that cannot fit: break it
        if (line) { lines.push(line); line = ''; }
        lines.push(w.slice(0, limit));
        w = w.slice(limit);
      }
      const candidate = line ? line + ' ' + w : w;
      if (candidate.length > limit && line) { lines.push(line); line = w; }
      else line = candidate;
    }
    if (line) lines.push(line);
    return lines;
  }
  /* all paragraphs -> the flat list of lines the art draws, each tagged with its paragraph */
  function wrap(paragraphs, max) {
    const lines = [];
    (paragraphs || []).forEach((p, i) => {
      for (const l of wrapParagraph(p, max)) lines.push({ text: l, para: i });
    });
    return lines;
  }

  /* how many characters a board of `w` tiles carries, and how wide a line of `len` characters
     makes that board. The two are the same formula read backwards — a board is never narrower
     than the longest line it holds. */
  const capacity = (w, style, mt) => Math.max(1, Math.floor((w * TILE - 2 * style.frameX - 2 * style.padX) / mt.charW));
  function widthFor(lines, style, mt) {
    let longest = 1;
    for (const l of lines || []) longest = Math.max(longest, l.text.length);
    return Math.max(style.minW, Math.min(style.maxW, Math.ceil((longest * mt.charW + 2 * style.padX + 2 * style.frameX) / TILE)));
  }
  /* the height a line count needs — and the RAW height, so the caller can tell a board that fits
     from one whose text would be cut off. The mood's chrome (the frame, the legs, the emitter)
     is part of the board, so it is part of the measure. */
  function heightFor(count, style, mt) {
    const raw = Math.ceil((count * mt.lineH + 2 * style.padY + 2 * style.frameY + style.extraH) / TILE);
    return { h: Math.max(style.minH, Math.min(style.maxH, raw)), raw };
  }

  /* the layout AT ONE LETTER SIZE: wrap, measure, re-wrap at the width the text really needs.
     `capW` caps the board's width (the fit() path hands in the board that already exists); without
     it the board may grow to the mood's widest. */
  function layoutAt(text, styleId, font, capW) {
    const style = styleFor(styleId), mt = metrics(style, font), paras = paragraphsOf(text);
    const hardMax = capW ? Math.max(style.minW, Math.min(style.maxW, capW | 0)) : style.maxW;
    let lines = wrap(paras, Math.min(style.maxChars, capacity(hardMax, style, mt)));
    let w = widthFor(lines, style, mt);
    // The board is only as wide as the text needs: re-wrap at the width we just chose, so a short
    // line does not leave a wide empty board. (A second pass cannot make the board wider than the
    // first, so this converges in one step.)
    const cap = Math.min(style.maxChars, capacity(w, style, mt));
    if (cap < style.maxChars) {
      const again = wrap(paras, cap);
      if (again.length) { lines = again; w = widthFor(lines, style, mt); }
    }
    const { h, raw } = heightFor(lines.length, style, mt);
    return { style: style.id, font, charW: mt.charW, lineH: mt.lineH, lines, w, h, rawH: raw, text: paras.join('\n') };
  }

  /* THE LAYOUT: the biggest letter size whose text still fits the mood's tallest board. */
  function layout(text, styleId) {
    const style = styleFor(styleId);
    for (let font = style.font; font > 4; font--) {
      const l = layoutAt(text, style.id, font);
      if (l.rawH <= style.maxH) return l;
    }
    const l = layoutAt(text, style.id, 4);
    l.clipped = l.rawH > style.maxH;
    return l;
  }

  /* THE LAYOUT FOR A GIVEN BOARD: the words as they fit INTO a board of w × h tiles. A board
     larger than the text needs simply carries it centred; a board too small shrinks the letters
     and, as a last resort, clips the last line with an ellipsis. */
  function fit(text, styleId, wTiles, hTiles) {
    const style = styleFor(styleId);
    const w = Math.max(1, wTiles | 0 || style.minW), h = Math.max(1, hTiles | 0 || style.minH);
    for (let font = style.font; font >= 4; font--) {
      const l = layoutAt(text, style.id, font, w);
      if (l.w <= w && l.rawH <= h) return l;
    }
    const l = layoutAt(text, style.id, 4, w);
    const maxLines = Math.max(1, Math.floor((h * TILE - 2 * style.padY - 2 * style.frameY - style.extraH) / l.lineH));
    const lines = l.lines.slice(0, maxLines);
    if (l.lines.length > maxLines && lines.length) {
      const last = lines[lines.length - 1];
      lines[lines.length - 1] = { text: last.text.slice(0, Math.max(0, last.text.length - 1)) + '…', para: last.para };
    }
    return Object.assign({}, l, { lines, clipped: true });
  }

  /* the board a text asks for — the ONE number the model stores and the editor shows */
  const box = (text, styleId) => { const l = layout(text, styleId); return { w: l.w, h: l.h }; };

  return { TILE, MAX_CHARS, STYLES, styleFor, isSign, normalize, wrap, wrapParagraph, metrics, layout, layoutAt, fit, box };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SignText;
