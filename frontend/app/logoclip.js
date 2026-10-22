/* AGENT OS logoclip.js — the brand mark yields to windows.

   #logo is hoisted to <body>, which parks it above every floating window: #terms lives INSIDE
   #screen-game, a z-index:10 stacking context, so a .term can never out-stack a <body> child no
   matter how high zTop() climbs — drag a panel into the top-left and the logo bleeds straight
   through it (2026-07-29 layering report). Lowering the mark under the CRT glass (z935, so the beam
   runs across it) does NOT fix that and never could: the glass sits at 940/950, still far above the
   z10 screen, so every seat that keeps the mark under the glass is also a seat above the windows.
   Hence this module — the mark is CLIPPED under them instead. It owns the pure geometry: subtract the occluding
   window rects from the mark's box and emit the CSS clip-path for what is left. Subtracting the
   real rects (rather than hiding the whole mark on first contact) is what makes it read as true
   occlusion — a window's left edge cuts the wordmark exactly where the edge lands.

   All inputs are VISUAL px (getBoundingClientRect); clip-path coordinates are the element's own
   LAYOUT px, so the uiZoom law applies — divide by the zoom exactly once, here. */
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LogoClip = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EPS = 0.01;           // sub-pixel slivers are not occlusion
  const NOTHING = 'inset(50%)';   // valid CSS for "clip it all away"; an empty path() string is NOT

  /** Intersect each occluder with the mark's box and return the holes in mark-local layout px. */
  function holes(box, rects, zoom) {
    const z = zoom > 0 ? zoom : 1;
    const W = box.width / z, H = box.height / z;
    const out = [];
    (rects || []).forEach(r => {
      if (!r || !(r.right - r.left > 0) || !(r.bottom - r.top > 0)) return;   // display:none → no rect, no occlusion
      const x1 = Math.max(0, (Math.max(r.left, box.left) - box.left) / z);
      const y1 = Math.max(0, (Math.max(r.top, box.top) - box.top) / z);
      const x2 = Math.min(W, (Math.min(r.right, box.left + box.width) - box.left) / z);
      const y2 = Math.min(H, (Math.min(r.bottom, box.top + box.height) - box.top) / z);
      if (x2 - x1 > EPS && y2 - y1 > EPS) out.push({ x1, y1, x2, y2 });
    });
    return out;
  }

  /** The CSS clip-path that hides exactly the covered part of the mark. '' = nothing covers it. */
  function clipFor(box, rects, zoom) {
    const z = zoom > 0 ? zoom : 1;
    if (!box || !(box.width > 0) || !(box.height > 0)) return '';
    const W = box.width / z, H = box.height / z;
    const cut = holes(box, rects, zoom);
    if (!cut.length) return '';   // nothing covers the mark — leave it unclipped and crisp
    // Sweep the vertical bands between every hole edge; inside a band the covered y-runs are fixed,
    // so keep that band's UNCOVERED runs as their own rectangular subpath. Exact for any number of
    // overlapping windows — clip-path: path() unions its subpaths, so no even-odd keyhole tricks.
    const edges = [0, W];
    cut.forEach(h => { edges.push(h.x1, h.x2); });
    const cuts = Array.from(new Set(edges)).sort((a, b) => a - b);
    const px = n => Math.round(n * 100) / 100;
    let d = '';
    for (let i = 0; i < cuts.length - 1; i++) {
      const x1 = cuts[i], x2 = cuts[i + 1];
      if (x2 - x1 < EPS) continue;
      const mid = (x1 + x2) / 2;
      const spans = cut.filter(h => h.x1 <= mid && h.x2 >= mid).sort((a, b) => a.y1 - b.y1);
      let y = 0;
      spans.forEach(s => {
        if (s.y1 - y > EPS) d += `M${px(x1)} ${px(y)}H${px(x2)}V${px(s.y1)}H${px(x1)}Z`;
        y = Math.max(y, s.y2);
      });
      if (H - y > EPS) d += `M${px(x1)} ${px(y)}H${px(x2)}V${px(H)}H${px(x1)}Z`;
    }
    return d ? `path("${d}")` : NOTHING;
  }

  return { clipFor, holes, NOTHING };
});
