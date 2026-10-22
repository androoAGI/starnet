/* AGENT OS — dockglow.js : the deferred BUILD-dock glow-target (G1c, feature 4b).

   The kit-out tour glows the path into REFIT while it's teaching the first floor. This is the SAME idea, but
   standing on its own AFTER the tour: while a STATION quest is open (an agent reached for a tool its room can't
   grant — a real capability gap the Commander can close by placing a prop), gently glow the BUILD dock so the
   fix is one obvious click away. The glow is a soft HINT, not the tutorial's imperative ring — it never scrims,
   never blocks, and vanishes the instant the last station gap closes.

   Reuses the kit-out's resolver DISCIPLINE, honoring its two locked traps:
     • TRAP 1 — dock targets are HIDDEN until the dock is open. So we glow the ALWAYS-VISIBLE BUILD dock toggle
       (.bb-group[data-group="build"] .bb-grp) while the dock popover is closed, and switch to the ⚒ BUILD
       STATION item (#bb-build) once its dock is open (the same #bb-build-only-visible-when-open rule).
     • TRAP 2 — never hardcode a prop label/category; the station quest already carries the LIVE-catalog prop
       label, and the dock is the neutral entry point, so nothing here names a prop.

   Coordination — TUTORIAL WINS: while the tutorial is actively coaching (Tutorial.isCoaching()), this stands
   fully down (removes its glow), so the two can never point at different controls at once. Also stands down on
   the title screen (only glows once the Commander is in-game) and while REFIT is already open (they're already
   there). Pure DOM + a cheap poll; no bus subscription, no persistence, never emits. */
'use strict';
const DockGlow = (() => {
  const POLL_MS = 500;
  const CLASS = 'dock-glow';
  let timer = 0, glowed = null;   // the element currently wearing the glow (or null)

  const q = sel => { try { return document.querySelector(sel); } catch (_) { return null; } };

  // are any STATION quests currently open? (the capability-gap generator's live count — G1b). Work/maintenance
  // quests deliberately DON'T drive the BUILD-dock glow: only a station gap is closed by PLACING a prop, which
  // is exactly what the BUILD dock is for. A work/maint quest is closed elsewhere (a run finishing / a fix).
  function stationOpen() {
    try { return (typeof StationQuestStore !== 'undefined' && StationQuestStore.openCount) ? StationQuestStore.openCount() > 0 : false; } catch (_) { return false; }
  }
  // "on the floor" = the BUILD dock toggle is actually in the DOM + laid out (it lives in the in-game bottom
  // bar; the title/connect screens have no bottom bar). Cheaper + more honest than a body-class flag.
  const inGame = () => { const el = q('.bb-group[data-group="build"] .bb-grp'); return !!(el && el.getClientRects().length); };
  const tutorialCoaching = () => { try { return !!(typeof Tutorial !== 'undefined' && Tutorial.isCoaching && Tutorial.isCoaching()); } catch (_) { return false; } };
  const refitOpen = () => { try { return !!(typeof Build !== 'undefined' && Build.isOpen && Build.isOpen()); } catch (_) { return false; } };

  // is the BUILD dock popover open? (#bb-build is only laid out once its dock is expanded — TRAP 1). getClientRects
  // is the same open-ness probe the kit-out uses (tutorial.js kitGuideToRefit).
  function dockOpen() { const el = q('#bb-build'); return !!(el && el.getClientRects().length); }

  // the element to glow RIGHT NOW: the ⌂ REFIT STATION item if its dock is open, else the BUILD dock toggle.
  function target() {
    if (dockOpen()) return q('#bb-build');
    return q('.bb-group[data-group="build"] .bb-grp');
  }

  function clear() { if (glowed) { try { glowed.classList.remove(CLASS); } catch (_) {} glowed = null; } }
  function apply(el) {
    if (glowed === el) return;
    clear();
    if (el) { try { el.classList.add(CLASS); glowed = el; } catch (_) {} }
  }

  function tick() {
    // stand-down conditions (any true → no glow): not in-game, REFIT already open, the tutorial is coaching, or
    // no station gap is open. Otherwise glow the resolved dock entry.
    if (!inGame() || refitOpen() || tutorialCoaching() || !stationOpen()) { clear(); return; }
    apply(target());
  }

  function start() { if (timer) return; tick(); timer = setInterval(tick, POLL_MS); }
  function stop() { if (timer) { clearInterval(timer); timer = 0; } clear(); }

  return { start, stop, tick, _target: target };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { DockGlow };
