/* STARNET — topbar.js : the TOPBAR INSTRUMENT-CLUSTER logic (read-only wiring).

   The topbar holds one cockpit gauge group: STATION (level + an XP-progress sliver)
   and the moved-up session-status instruments (UPLINK / ONLINE / save).

   This module OWNS none of the data. It is a pure read-only consumer:
     - STATION level      — written into #gt-station by xpstore.js (untouched); we only
                             ADD the XP sliver, painted from Xp.compute(XpStore.stationStats())
                             (a read-only exported getter) on the same U.bus growth events.
     - UPLINK / ONLINE / save — their markup was moved up from #bottombar .bb-right with ids
                             intact, so main.js save() and stationui.js tick()/flashSave() keep
                             writing them with zero changes here.

   It NEVER emits a bus event and never mutates another module's state — the frozen
   shared/events.js contract stays untouched, and the lint-emits gate has nothing to catch. */
'use strict';
const Topbar = (() => {
  let wired = false;

  const $ = sel => document.querySelector(sel);

  // ---- STATION XP sliver: read-only compute over the live station rollup ----
  function paintXp() {
    try {
      if (typeof Xp === 'undefined' || typeof XpStore === 'undefined' || !XpStore.stationStats) return;
      const stats = XpStore.stationStats();
      if (!stats) return;
      const g = Xp.compute(stats);
      const fill = $('#tb-station .tb-xp-fill');
      if (fill && g && isFinite(g.frac)) {
        const pct = Math.max(0, Math.min(100, Math.round(g.frac * 100)));
        fill.style.width = pct + '%';
        const xp = $('#tb-station .tb-xp');
        if (xp) xp.title = 'STATION Lv ' + g.level + ' — ' + pct + '% to Lv ' + (g.level + 1)
          + (isFinite(g.toNext) ? ' (' + g.toNext + ' XP to go)' : '');
      }
    } catch (_) { /* honest no-op: leave the sliver where it is */ }
  }

  /* ---- UPLINK (#sig): wired to the REAL SSE bridge health (World.linkState), the same predicate the
     canvas dims its live telemetry with. Full bars + UPLINK while the bridge is up; when it dies the
     bars collapse to the dead glyph and the label flips to LINK DOWN in red (mirrors the canvas
     LINK DOWN marker). Before the bridge is ever opened (title screen / pre-entry) it shows a neutral
     STANDBY rather than a false green or a false alarm. Was static HTML no JS ever wrote. ---- */
  // UP = the rising full-signal glyph (only when the bridge is proven live); DOWN = the dead flat glyph;
  // STANDBY = an EVEN, dim mid-level bar — deliberately NOT the full-signal glyph, so a pre-bridge state can
  // never read as a live green uplink (the bug: STANDBY painted a full SIG_UP beside the ONLINE pill).
  const SIG_UP = '▂▄▆█', SIG_DOWN = '▁▁▁▁', SIG_STANDBY = '▃▃▃▃';
  function linkNow() {
    try { if (typeof World !== 'undefined' && World.linkState) return World.linkState(); } catch (_) {}
    return null;
  }
  function paintSig() {
    const el = $('#sig'); if (!el) return;
    const bars = el.querySelector('b'); if (!bars) return;
    const ls = linkNow();
    // no world / never bridged / deliberately paused → neutral standby (never a false ONLINE-green,
    // never a false DOWN-red). Only a genuinely bridged-but-dead link paints the red fault state.
    if (!ls || !ls.bridged || ls.paused) {
      el.classList.remove('down');
      el.classList.add('standby');
      el.childNodes[0].nodeValue = 'STANDBY ';
      bars.textContent = SIG_STANDBY;   // dim even bars — NOT full signal
      el.title = ls && ls.paused ? 'connection to the background service is paused (disconnected)' : 'connection to StarNet’s background service — standby (not connected yet)';
      return;
    }
    if (ls.down) {
      el.classList.remove('standby');
      el.classList.add('down');
      el.childNodes[0].nodeValue = 'LINK DOWN ';
      bars.textContent = SIG_DOWN;
      el.title = 'lost the connection to StarNet’s background service — live numbers pause until it’s back (is the app still running?)';
    } else {
      el.classList.remove('down', 'standby');
      el.childNodes[0].nodeValue = 'UPLINK ';
      bars.textContent = SIG_UP;
      el.title = 'connected to StarNet’s background service — everything on screen is live';
    }
  }

  function init() {
    if (wired) return;
    wired = true;

    // first paints (may run before any event — honest current level)
    paintXp();
    paintSig();

    if (typeof U !== 'undefined' && U.bus) {
      // the same real outcomes xpstore.js grows the station on — repaint the sliver after it folds.
      for (const n of ['agent.run.end', 'agent.tool_result', 'memory.feedback', 'workitem.delivered', 'channel.delivery']) {
        U.bus.on(n, () => { try { paintXp(); } catch (_) {} });
      }
    }

    // repaint the XP sliver on a slow cadence too, in case a level-up celebration reset the level
    // (cheap: one read-only compute; no network). Piggybacks the same 30s tick.
    setInterval(paintXp, 30000);

    // UPLINK health: poll World.linkState on a short cadence (the readyState check is the fast signal;
    // 3s catches a dropped socket well within the DOWN threshold) so #sig tracks the live bridge, not
    // a frozen glyph. Cheap: one read-only predicate, no network.
    setInterval(paintSig, 3000);
  }

  // start once the DOM + app globals exist (this script loads after app.js)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // expose a tiny read-only surface for dev/verification (mirrors testapi.js style; inert otherwise)
  return { init, _paintXp: paintXp, _paintSig: paintSig };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { Topbar };
