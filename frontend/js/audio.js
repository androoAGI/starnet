/* ============================================================================
   AGENT OS — audio.js : the colony sound Director.

   The generative background score was removed (2026-07-04, by decision): the
   station now speaks only through designed SFX (see util.js). What remains is
   the Director's other job — turning REAL colony events on the U.bus into
   notification sounds — plus the autoplay arm: browsers block Web Audio until
   a user gesture, so the first pointer/key/touch boots the SFX context and
   every later notification can actually sound.

   Node-safe: this file is browser-only (never loaded by the headless tests)
   and only ever LISTENS on the bus — it emits nothing, so the emit linter
   ignores it. Rapid event storms are tamed by the per-sound gates inside SFX
   itself (util.js), not here.
   ========================================================================== */
'use strict';

(function () {
  /* ---- wire the colony Director to the bus (browser only) ---- */
  function wire() {
    if (typeof U === 'undefined' || !U.bus) return;
    const on = (ev, fn) => U.bus.on(ev, fn);

    // problems — the dark sting
    on('agent.tool_result', p => { if (p && p.isError) SFX.alarm(); });
    on('agent.run.error', () => SFX.alarm());
    on('flagged', () => SFX.alarm());
    on('capdenied', () => SFX.alarm());
    on('budget.threshold', () => SFX.alarm());
    on('task', p => {
      if (!p) return;
      if (p.status === 'done') SFX.ship();
      if (p.status === 'failed') SFX.alarm();
    });

    // work moving through the pipeline
    on('workitem.placed', () => SFX.msg());
    on('workitem.delivered', () => SFX.ship());
    on('deliverable', () => SFX.ship());

    // attention chimes
    on('channel.inbound', () => SFX.msg());
    on('memory.write', () => SFX.chime());
    on('permission.prompt', () => SFX.chime());
  }

  /* ---- delegated UI interaction sounds (2026-07-19): every interactive control inside any
     window sounds without per-handler wiring. Bubble phase + the _lastAny check means explicit
     cues (a dock button playing open(), a handler's own click()) always win — the delegate only
     fills silence. Selectors are conservative: real controls only, never canvas/window chrome. ---- */
  const CLICKY = 'button, [role="button"], a[href], select, summary, [data-act], .chip, .tab';
  // COMMS (model selector included — it lives in #chat-panel) sounds like the bottom docks: press(), not click()
  // composedPath() is snapshotted at dispatch, so it still holds the panel when the handler re-rendered (and
  // detached) the pressed node — a model row / effort key rebuilds its list before the click bubbles here.
  const inComms = ev => { const p = ev.composedPath ? ev.composedPath() : []; for (let i = 0; i < p.length; i++) if (p[i] && p[i].id === 'chat-panel') return true; return false; };
  function wireUI() {
    document.addEventListener('click', ev => {
      if (ev.button) return;
      const t = ev.target && ev.target.closest ? ev.target.closest(CLICKY) : null;
      if (!t || t.disabled) return;
      if (Date.now() - SFX._lastAny < 80) return;       // an explicit cue just sounded — yield
      if (inComms(ev)) SFX.press(); else SFX.click();
    }, { passive: true });                              // bubble phase: after app handlers
    document.addEventListener('change', ev => {
      const t = ev.target;
      if (!t || !t.matches) return;
      if (Date.now() - SFX._lastAny < 80) return;
      if (t.matches('input[type="checkbox"], input[type="radio"]')) SFX.toggle();
      else if (t.matches('select')) { if (inComms(ev)) SFX.press(); else SFX.click(); }
    }, { passive: true });
    document.addEventListener('input', ev => {
      const t = ev.target;
      if (t && t.matches && t.matches('input[type="range"]')) SFX.slidertick();
    }, { passive: true });
  }

  /* ---- autoplay: browsers block audio until a gesture, so arm on first input ---- */
  function arm() {
    ['pointerdown', 'keydown', 'touchstart'].forEach(e => { try { window.removeEventListener(e, arm); } catch (_) { } });
    SFX.boot();
  }

  if (typeof window !== 'undefined') {
    wire();
    wireUI();
    ['pointerdown', 'keydown', 'touchstart'].forEach(e => window.addEventListener(e, arm, { passive: true }));
  }
})();
