/* STARNET — hint.js : a tiny HTML-layer tooltip that explains the station's jargon on hover/tap.

   The app speaks fluent StarNet at users who have been here zero minutes (see the UX audit's jargon
   wall). This is the shared primitive every screen sprinkles onto its own confusing labels instead of
   inventing local tooltip code:

     <span data-hint="workstream">workstream</span>        ← auto-wired via delegation (late DOM works)
     Hint.attach(el, 'refit')                              ← imperative, same result

   Behavior:
   • mouse/pen → the glossary one-liner shows on hover (pointerenter) / keyboard focus.
   • touch     → shows on tap; a tap elsewhere dismisses it.
   • decided per EVENT, not per device: a touchscreen laptop driven by a mouse gets hover, its finger gets taps.
   • the bubble is appended to <body>, so it inherits the themed phosphor tokens (var(--ph)/var(--gold)
     resolve to the ACTIVE theme, never the :root amber — per the frontend theming law) and clamps to
     the viewport so an edge label never renders a bubble off-screen.

   HARD LAW: this is the HTML UI layer ONLY. It never touches canvas hover paths — in-world hover stays a
   nameplate glance (locked). data-hint lives on DOM elements (panels, windows, cards), never on the game
   canvas. Copy comes from glossary.js; an unknown term shows nothing (no empty bubble).

   UMD: a `Hint` global in the browser; a no-op-safe module.exports under node (no DOM there). */
'use strict';
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Hint = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const doc = (typeof document !== 'undefined') ? document : null;

  // resolve the glossary lazily so load order between glossary.js and hint.js never matters.
  function copyFor(term) {
    const G = (typeof Glossary !== 'undefined') ? Glossary
            : (root && root.Glossary) ? root.Glossary : null;
    return G && G.lookup ? G.lookup(term) : null;
  }

  // the pointer behind the next focus/click: 'mouse' | 'pen' | 'touch', '' = keyboard (a keypress clears it).
  // A device gate (maxTouchPoints > 0) wired a touchscreen laptop as a phone: a mouse click pinned the bubble.
  let lastPointer = '';

  const GAP = 10;          // px between the anchor and the bubble
  const EDGE = 8;          // min px from any viewport edge (the clamp margin)
  let bubble = null;       // the single reused tooltip element
  let styleInjected = false;
  let currentAnchor = null;

  // one stylesheet, injected once. Themed entirely through existing CSS vars — no literal amber (frontend law):
  // the gold accent uses rgb(var(--gold-rgb)) which re-resolves per active theme.
  function injectStyle() {
    if (styleInjected || !doc || !doc.head) return;
    styleInjected = true;
    const css =
      '.hint-bubble{' +
        'position:fixed;z-index:100000;max-width:280px;pointer-events:none;' +
        'padding:7px 10px;font-family:inherit;font-size:15px;line-height:1.35;' +
        'color:var(--text,#eec88f);background:var(--panel2,#0c0704);' +
        'border:1px solid rgba(var(--gold-rgb,255,211,74),0.55);border-radius:6px;' +
        'box-shadow:0 2px 14px rgba(0,0,0,0.6), 0 0 10px rgba(var(--ph-rgb,255,170,51),0.18);' +
        'text-shadow:0 0 3px var(--ph-glow2,rgba(255,170,51,0.14));' +
        'opacity:0;transform:translateY(2px);transition:opacity .12s ease, transform .12s ease;' +
        'letter-spacing:.2px;}' +
      '.hint-bubble.on{opacity:1;transform:translateY(0);}' +
      '[data-hint]:not(button):not(a){cursor:help;}';   // controls keep their pointer; jargon spans get help
    const el = doc.createElement('style');
    el.id = 'hint-style';
    el.textContent = css;
    doc.head.appendChild(el);
  }

  function ensureBubble() {
    if (bubble || !doc || !doc.body) return bubble;
    injectStyle();
    bubble = doc.createElement('div');
    bubble.className = 'hint-bubble';
    bubble.setAttribute('role', 'tooltip');
    bubble.setAttribute('aria-hidden', 'true');
    doc.body.appendChild(bubble);
    return bubble;
  }

  // place the bubble above the anchor by default; flip below if it would clip the top, then clamp X into view.
  function place(anchor) {
    const b = bubble; if (!b || !anchor) return;
    // anchor rect + viewport are visual px; the bubble's style px are body-zoomed (TEXT SIZE) — /z once.
    const z = (typeof U !== 'undefined' && U.uiZoom) ? U.uiZoom() : 1;
    const r0 = anchor.getBoundingClientRect();
    const r = { left: r0.left / z, top: r0.top / z, bottom: r0.bottom / z, width: r0.width / z };
    const vw = (window.innerWidth || doc.documentElement.clientWidth) / z;
    const vh = (window.innerHeight || doc.documentElement.clientHeight) / z;
    const bw = b.offsetWidth, bh = b.offsetHeight;

    // vertical: prefer above; if not enough room above, drop below.
    let top = r.top - bh - GAP;
    if (top < EDGE) top = r.bottom + GAP;
    // if it still overflows the bottom, pin to the bottom edge.
    if (top + bh > vh - EDGE) top = Math.max(EDGE, vh - EDGE - bh);

    // horizontal: center on the anchor, then clamp both edges into the viewport.
    let left = r.left + r.width / 2 - bw / 2;
    if (left + bw > vw - EDGE) left = vw - EDGE - bw;
    if (left < EDGE) left = EDGE;

    b.style.left = Math.round(left) + 'px';
    b.style.top = Math.round(top) + 'px';
  }

  function show(anchor) {
    if (doc && doc.body && doc.body.classList.contains('no-hints')) return;   // Settings › HINTS is off
    const term = anchor && anchor.getAttribute && anchor.getAttribute('data-hint');
    const msg = copyFor(term);
    if (!msg) return;                       // unknown term → nothing (never an empty bubble)
    const b = ensureBubble(); if (!b) return;
    currentAnchor = anchor;
    b.classList.toggle('dock-tip', !!(anchor.closest && anchor.closest('#bottombar')));
    b.textContent = msg;
    b.setAttribute('aria-hidden', 'false');
    // measure with a first paint (opacity 0), place, then flip on.
    b.classList.remove('on');
    b.style.left = '-9999px'; b.style.top = '-9999px';
    // force layout so offsetWidth/Height are real before placing.
    void b.offsetWidth;
    place(anchor);
    b.classList.add('on');
  }

  function hide() {
    if (!bubble) return;
    bubble.classList.remove('on');
    bubble.setAttribute('aria-hidden', 'true');
    currentAnchor = null;
  }

  // find the nearest [data-hint] ancestor from an event target (delegation → late-rendered windows work).
  function hintAncestor(node) {
    if (!node || !node.closest) return null;
    return node.closest('[data-hint]');
  }

  // keyboard focus only: a click or a tap focuses a button too, and that must not (re)show a bubble.
  function keyboardFocus(el) {
    try { if (el && typeof el.matches === 'function') return el.matches(':focus-visible'); } catch (_) {}
    return !lastPointer;
  }

  function wireDelegation() {
    if (!doc) return;
    injectStyle();      // at wire time — the help cursor must not wait for the first bubble
    window.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType || ''; }, true);
    window.addEventListener('keydown', (e) => { lastPointer = ''; if (e.key === 'Escape') hide(); }, true);
    // hover: mouse / pen. A finger has no hover; taps go through click below.
    doc.addEventListener('pointerover', (e) => {
      if (e.pointerType === 'touch') return;
      const a = hintAncestor(e.target);
      // an open dock trigger's menu sits above it — a bubble there would cover the menu
      if (a && a !== currentAnchor && a.getAttribute('aria-expanded') !== 'true') show(a);
    }, true);
    doc.addEventListener('pointerout', (e) => {
      if (e.pointerType === 'touch') return;
      const a = hintAncestor(e.target);
      if (a && a === currentAnchor) {
        // ignore moves that stay inside the same anchor.
        const to = e.relatedTarget;
        if (to && a.contains(to)) return;
        hide();
      }
    }, true);
    doc.addEventListener('focusin', (e) => {
      const a = hintAncestor(e.target);
      if (a && keyboardFocus(e.target)) show(a);
      else if (a !== currentAnchor) hide();
    }, true);
    // a tapped bubble survives the blur that follows the tap (navdock drops focus after a pointer toggle)
    doc.addEventListener('focusout', () => { if (lastPointer !== 'touch') hide(); }, true);
    // any scroll invalidates the anchored position — cheapest correct answer is to dismiss.
    window.addEventListener('scroll', () => { if (currentAnchor) hide(); }, true);
    // touch: a tap toggles; a tap anywhere else dismisses. Any other click away clears a leftover bubble.
    doc.addEventListener('click', (e) => {
      const a = hintAncestor(e.target);
      if (lastPointer === 'touch') { if (a && a !== currentAnchor) show(a); else hide(); }
      else if (a !== currentAnchor) hide();
    }, true);
  }

  // imperative wiring for callers that build the element in JS (adds the attribute + participates in delegation).
  function attach(el, term) {
    if (!el || !el.setAttribute) return el;
    if (term != null) el.setAttribute('data-hint', String(term));
    return el;
  }

  // init once the DOM exists (delegation handlers are cheap; the bubble is created lazily on first show).
  if (doc) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', wireDelegation, { once: true });
    else wireDelegation();
  }

  return { attach, show, hide, _internals: { place, copyFor, hintAncestor, keyboardFocus } };
});
