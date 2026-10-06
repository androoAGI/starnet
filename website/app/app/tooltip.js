/* STARNET — tooltip.js : the station's own hover card, replacing the browser's native `title` bubble.

   WHY (Andrew, 2026-07-27): a native tooltip is OS chrome — a grey box in the system font, drawn by
   Windows over the phosphor terminal, on the OS's own ~500ms timer. It is the same defect class as the
   white HTML <select> the CONTROL FLOOR killed: UI the browser paints because we never said otherwise.
   There were 133 `title="…"` attributes across 13 files, and one bespoke phosphor tip (.model-dock-tip)
   that got it right in one place only.

   HOW, and why it works this way: this does NOT ask 133 call sites to change. On the first pointerover
   or focus of any `[title]` element, the controller MOVES the text to `data-tip` and REMOVES `title` —
   which is what kills the native bubble, because the OS timer only starts once the pointer rests and the
   attribute is gone before then. `data-tip` is then the source of truth. That is deliberate: a re-render
   that writes `title` again is silently re-adopted on the next hover, and every future control gets the
   station tooltip for free without anyone remembering a class. Opt out with `data-no-tip` (the model
   dock does — it owns a richer tip of its own and would otherwise show two).

   ACCESSIBILITY: removing `title` removes an accessible description, so this gives it back properly —
   the live card is referenced with aria-describedby while shown, and an element whose ONLY name came
   from its title (an icon button with no text and no aria-label) keeps that name as an aria-label.

   COORDINATES — the uiZoom law (see stationui.js uiZoom / app.js:3139): rects and clientX are VISUAL px,
   but this card is a body child, and body carries `style.zoom` for TEXT SIZE, so its style px are in
   ZOOMED space. Divide by z exactly once, like .ws-menu does, or the card lands off by the zoom factor
   on any station not at 100%.

   UMD: a `Tooltip` global in the browser; module.exports under node so the pure geometry is testable. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Tooltip = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SHOW_DELAY = 320;      // a glance, not noise — under the OS's own ~500ms, so it never feels slower
  const MAX_LEN = 400;         // a tooltip is a hint; anything longer belongs in the panel
  const EDGE = 8;              // viewport clamp margin, in zoomed px
  const GAP = 9;               // space between anchor and card
  const TIP_ID = 'station-tip';

  /* place(anchor, tip, viewport) → {left, top, below, arrowX} — ALL inputs and outputs in ZOOMED px.
     Prefers above the anchor; flips below when the card would clip the top edge; clamps horizontally and
     reports where the arrow must sit so it keeps pointing at the anchor's centre after clamping.
     Pure — no DOM — so the geometry is unit-testable. */
  function place(anchor, tip, viewport) {
    const centre = anchor.left + anchor.width / 2;
    let left = centre - tip.width / 2;
    left = Math.max(EDGE, Math.min(left, viewport.width - tip.width - EDGE));
    const roomAbove = anchor.top - tip.height - GAP;
    const below = roomAbove < EDGE;
    const top = below ? (anchor.top + anchor.height + GAP) : roomAbove;
    // the arrow tracks the anchor centre, but never past the card's own rounded corners
    const arrowX = Math.max(10, Math.min(centre - left, tip.width - 10));
    return { left, top: Math.max(EDGE, top), below, arrowX };
  }

  /* adopt(el) → the tip text, or '' if this element should not get one. Moves `title` into `data-tip`
     the first time we see it (that removal is what silences the native bubble). */
  function adopt(el) {
    if (!el || !el.getAttribute) return '';
    if (el.hasAttribute('data-no-tip')) return '';
    const native = el.getAttribute('title');
    if (native != null) {
      const text = String(native).trim();
      el.removeAttribute('title');                       // <- kills the OS bubble
      if (text) {
        el.setAttribute('data-tip', text);
        // if the title WAS the element's only accessible name, keep it as one
        const named = (el.textContent || '').trim() || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
        if (!named) el.setAttribute('aria-label', text);
      }
    }
    return String(el.getAttribute('data-tip') || '').trim().slice(0, MAX_LEN);
  }

  function init(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.body || init._wired) return;
    init._wired = true;

    const card = doc.createElement('div');
    card.className = 'station-tip';
    card.id = TIP_ID;
    card.setAttribute('role', 'tooltip');
    card.hidden = true;
    doc.body.appendChild(card);

    /* `anchor` is only set once the card SHOWS, so during the SHOW_DELAY window there was no record of which
       element the tip was armed for — and the pointerout handler opened with `if (!anchor) return`, bailing
       before hide(), which holds the only clearTimeout. Brush a tipped control and flick away and the card
       still popped up ~200ms later beside a control the pointer had already left, then sat there until the
       next element boundary, click, scroll or keypress. `pending` is that missing record. */
    let anchor = null, timer = null, pending = null;
    const zoom = () => {
      const z = parseFloat(doc.body && doc.body.style ? doc.body.style.zoom : '');
      return z > 0 ? z : 1;
    };

    function hide() {
      if (timer) { clearTimeout(timer); timer = null; }
      pending = null;
      if (anchor) { try { anchor.removeAttribute('aria-describedby'); } catch (_) {} }
      anchor = null;
      card.classList.remove('show');
      card.hidden = true;
    }

    function show(el, text) {
      pending = null;
      if (!el.isConnected) return;
      anchor = el;
      card.classList.toggle('dock-tip', !!el.closest('#bottombar'));
      // (2026-09-30) a Build Library tile's tip — and a Workflow panel tile's — is its name, then what it does, on lines of their
      // own, in the station glass
      card.classList.toggle('glass-tip', !!el.closest('.refit-dock, .wf-panel'));
      card.textContent = text;
      card.hidden = false;
      card.classList.remove('show');
      const z = zoom();
      const a = el.getBoundingClientRect(), t = card.getBoundingClientRect();
      const p = place(
        { left: a.left / z, top: a.top / z, width: a.width / z, height: a.height / z },
        { width: t.width / z, height: t.height / z },
        { width: window.innerWidth / z, height: window.innerHeight / z }
      );
      card.style.left = p.left + 'px';
      card.style.top = p.top + 'px';
      card.style.setProperty('--tip-arrow', p.arrowX + 'px');
      card.classList.toggle('below', p.below);
      try { el.setAttribute('aria-describedby', TIP_ID); } catch (_) {}
      card.classList.add('show');
    }

    function enter(ev, immediate) {
      const el = ev.target && ev.target.closest ? ev.target.closest('[title],[data-tip]') : null;
      if (!el || el === anchor || el === pending) return;
      const text = adopt(el);
      // adopt() first (it silences the OS bubble); then no card over an open dock menu
      if (!text || el.getAttribute('aria-expanded') === 'true') return;
      hide();
      if (immediate) show(el, text);
      else { pending = el; timer = setTimeout(() => { timer = null; show(el, text); }, SHOW_DELAY); }
    }

    doc.addEventListener('pointerover', ev => enter(ev, false));
    // keyboard focus only: a mouse click focuses the button too, and must not pop the card over its menu.
    // No matches()/:focus-visible (old engine, test fakes) → today's behaviour.
    doc.addEventListener('focusin', ev => {
      const t = ev.target;
      try { if (t && typeof t.matches === 'function' && !t.matches(':focus-visible')) return; } catch (_) {}
      enter(ev, true);
    });
    doc.addEventListener('pointerout', ev => {
      // A tip that is merely PENDING must be cancellable too — that is the whole ghost-card bug.
      const from = anchor || pending;
      if (!from) return;
      const to = ev.relatedTarget;
      if (to && from.contains && from.contains(to)) return;   // still inside the same anchor
      hide();
    });
    doc.addEventListener('focusout', hide);
    // any commitment (click, drag, scroll, typing) ends the glance — a tooltip must never linger over work
    doc.addEventListener('pointerdown', hide, true);
    doc.addEventListener('wheel', hide, { capture: true, passive: true });
    doc.addEventListener('scroll', hide, true);
    doc.addEventListener('keydown', hide, true);
    if (typeof window !== 'undefined') window.addEventListener('blur', hide);

    return { hide };
  }

  // Self-start in the browser: this replaces a browser default, so it has to be live before the first
  // hover, and there is no boot order to join — nothing else in the app calls into it.
  if (typeof document !== 'undefined') {
    if (document.body) init(document);
    else document.addEventListener('DOMContentLoaded', () => init(document), { once: true });
  }

  return { init, place, adopt, SHOW_DELAY, MAX_LEN };
});
