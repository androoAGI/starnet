/* STARNET — chatresize.js : draggable COMMS / stage divider.
   The station grid pins COMMS to a fixed width; this lets the Commander grab the seam on the
   panel's left edge and drag it LEFT to widen COMMS (the centre stage gives up the space) or
   RIGHT to shrink it. The width is a CSS var (--chat-w) the grid reads, persisted per machine.
   The stage canvas re-fits on its own — world.js observes #stage-wrap via ResizeObserver. */
'use strict';

(() => {
  const KEY = 'starnet.chatw';
  const handle = document.getElementById('comms-resizer');
  const game = document.getElementById('screen-game');
  if (!handle || !game) return;

  // Focus is temporary: never overwrite either saved divider width or the crew preference.
  const expand = document.getElementById('comms-expand');
  if (expand) expand.addEventListener('click', () => {
    const expanded = game.classList.toggle('comms-expanded');
    expand.textContent = expanded ? 'RESTORE' : 'EXPAND';
    expand.setAttribute('aria-pressed', String(expanded));
    expand.setAttribute('aria-label', expanded ? 'Restore station layout' : 'Expand conversation');
    // Existing canvas, overlays and logo trackers share this layout notification.
    window.dispatchEvent(new Event('resize'));
  });

  // All of these are VISUAL px, and so is --chat-w. The grid holds the cabinet at its designed
  // size regardless of TEXT SIZE (app.css `#screen-game.active` counter-zooms every frame
  // dimension), so the padding/gap/rail the seam has to clear no longer move with the zoom — and a
  // width the Commander dragged means the same thing at every text size instead of silently
  // meaning 45% more at HUGE.
  const LEFT_COL = 232, PAD = 11, GAP = 9, MIN = 300;
  const stageWrap = document.getElementById('stage-wrap');
  // COMMS may swallow the centre stage ENTIRELY (stage width → 0) — Commanders who don't want
  // to see the station while they work drag the seam all the way to the crew rail. The stage's
  // left edge is fixed by the grid, so the ceiling is everything right of it minus one gap;
  // world.js's resize() floors the canvas at 1px, so a zero-width stage is safe.
  function maxWidth() {
    const stageLeft = stageWrap ? stageWrap.getBoundingClientRect().left : LEFT_COL + PAD + GAP;
    return Math.max(MIN, window.innerWidth - PAD - GAP - stageLeft);
  }
  const clamp = w => Math.max(MIN, Math.min(maxWidth(), w));
  function apply(w) { game.style.setProperty('--chat-w', clamp(w) + 'px'); }

  // restore a saved width (re-clamped to the current window)
  try { const s = parseInt(localStorage.getItem(KEY), 10); if (s) apply(s); } catch (_) {}

  let dragging = false, pendingW = null, moveRaf = 0;
  // coalesce to one width write per frame: pointermove can fire several times between paints, and each
  // write resizes the centre stage's canvas — batching to rAF keeps the resize cadence in step with paint.
  function flushMove() {
    moveRaf = 0;
    if (pendingW != null) { apply(pendingW); pendingW = null; }
  }
  function onMove(e) {
    if (!dragging) return;
    // COMMS right edge is the window edge minus padding; its width is that edge minus the cursor x.
    // clientX/innerWidth and --chat-w are all visual px now, so there is nothing to convert.
    pendingW = (window.innerWidth - e.clientX) - PAD;
    if (!moveRaf) moveRaf = requestAnimationFrame(flushMove);
    e.preventDefault();
  }
  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0; }
    if (pendingW != null) { apply(pendingW); pendingW = null; }   // land the final position the rAF hadn't flushed yet
    document.body.classList.remove('col-resizing');
    try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
    const cur = getComputedStyle(game).getPropertyValue('--chat-w').trim();
    try { if (cur) localStorage.setItem(KEY, parseInt(cur, 10)); } catch (_) {}
    try { if (typeof SFX === 'object' && SFX.click) SFX.click(); } catch (_) {}
  }
  handle.addEventListener('pointerdown', e => {
    dragging = true;
    document.body.classList.add('col-resizing');
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);

  // double-click the seam to snap COMMS back to its default width
  handle.addEventListener('dblclick', () => {
    game.style.removeProperty('--chat-w');
    try { localStorage.removeItem(KEY); } catch (_) {}
    try { if (typeof SFX === 'object' && SFX.close) SFX.close(); } catch (_) {}
  });

  // a shrinking window can leave a stored width too wide — re-clamp on resize
  window.addEventListener('resize', () => {
    if (game.classList.contains('comms-expanded')) return;
    const cur = parseInt(getComputedStyle(game).getPropertyValue('--chat-w'), 10);
    if (cur) apply(cur);
  });
})();
