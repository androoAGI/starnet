/* AGENT OS — armconfirm.js : the ONE reusable "click to arm, click again to confirm" helper.

   The 2-step arm/confirm ritual (no native dialogs inside the phosphor terminal) is copy-pasted in at
   least three shapes today — the stored-key remove (stationui.js ~1990, dataset.armed + label swap +
   5s auto-disarm), the dossier forget (chat.js ~1078), and the study-card discard (chat.js ~1378). This
   extracts that idiom so the UX lanes adding NEW irreversible actions (quest dismiss, prospect dismiss)
   reuse one tested behaviour instead of forking a fourth copy.

   The chrome-voice call sites now compose this instead of forking their own dataset.armed + label-swap +
   setTimeout copies (settings key-remove / permission revoke / clear-notifications, marketplace re-spec +
   forget). The two context-menu rows (workstream/project delete) keep bespoke logic because they carry an
   aria-hidden glyph span this helper's textContent swap would flatten; the COMMS consent buttons keep their
   sentence-case register beside their siblings. All share ONE disarm timeout (4000ms) and the .armed skin.

     ArmConfirm.wire(btn, {
       armedLabel: 'DISMISS — SURE?',   // shown after the first click
       timeoutMs: 4000,                 // auto-disarm back to the resting label (default 4000)
       onArm: (b) => sfx('bad'),        // optional: danger cue / extra armed DOM (mirror in onDisarm)
       onConfirm: () => actuallyDismiss()   // fired on the second click; may return a Promise
     });

   The resting label is whatever text the button already has. On first click it arms (label → armedLabel,
   `.armed` class + data-armed for styling parity with the existing sites); a second click within the
   window confirms and calls onConfirm; no second click and it silently disarms. Returns a disposer.

   UMD: an `ArmConfirm` global in the browser; module.exports under node (pure logic is unit-testable via a
   fake button, but it needs no DOM to load). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.ArmConfirm = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_TIMEOUT = 4000;

  /* wire(btn, opts) → disposer(). opts:
       armedLabel (string, required) — the "are you sure" label shown while armed.
       onConfirm  (function, required) — called on the confirming (second) click; may return a Promise.
       timeoutMs  (number) — auto-disarm delay; default 4000. <=0 means never auto-disarm.
       restLabel  (string) — override the resting label (default: the button's current textContent).
       onArm      (function) — fired after the button arms (first click); use for the danger sfx or
                               extra DOM the site wants armed alongside (e.g. a red row hairline + hint).
       onDisarm   (function) — fired after a real disarm (auto-timeout or the confirming click); the
                               mirror of onArm — tear down whatever onArm added. Not fired on dispose-
                               when-already-resting. Both receive the button as their only argument. */
  function wire(btn, opts) {
    opts = opts || {};
    if (!btn || typeof btn.addEventListener !== 'function') return function () {};
    const armedLabel = String(opts.armedLabel != null ? opts.armedLabel : 'Confirm?');
    const timeoutMs = (typeof opts.timeoutMs === 'number') ? opts.timeoutMs : DEFAULT_TIMEOUT;
    const onConfirm = (typeof opts.onConfirm === 'function') ? opts.onConfirm : function () {};
    const onArm = (typeof opts.onArm === 'function') ? opts.onArm : null;
    const onDisarm = (typeof opts.onDisarm === 'function') ? opts.onDisarm : null;
    const restLabel = (opts.restLabel != null) ? String(opts.restLabel) : String(btn.textContent || '');

    let armed = false;
    let timer = null;

    function clearTimer() { if (timer) { try { clearTimeout(timer); } catch (_) {} timer = null; } }

    function disarm() {
      clearTimer();
      const wasArmed = armed;
      armed = false;
      try { btn.textContent = restLabel; } catch (_) {}
      if (btn.classList) btn.classList.remove('armed');
      if (btn.dataset) delete btn.dataset.armed;
      if (wasArmed && onDisarm) { try { onDisarm(btn); } catch (_) {} }
    }

    function arm() {
      armed = true;
      try { btn.textContent = armedLabel; } catch (_) {}
      if (btn.classList) btn.classList.add('armed');
      if (btn.dataset) btn.dataset.armed = '1';
      if (onArm) { try { onArm(btn); } catch (_) {} }
      clearTimer();
      if (timeoutMs > 0 && typeof setTimeout === 'function') {
        timer = setTimeout(function () {
          // only auto-disarm if the button is still in the DOM and still armed.
          if (armed && (btn.isConnected === undefined || btn.isConnected)) disarm();
        }, timeoutMs);
      }
    }

    function onClick(e) {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      if (!armed) { arm(); return; }
      disarm();
      onConfirm(e);
    }

    btn.addEventListener('click', onClick);

    // disposer: unbind + restore the resting state.
    return function dispose() {
      clearTimer();
      btn.removeEventListener('click', onClick);
      if (armed) disarm();
    };
  }

  return { wire, DEFAULT_TIMEOUT };
});
