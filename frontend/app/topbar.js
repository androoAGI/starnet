/* STARNET — topbar.js : the TOPBAR INSTRUMENT-CLUSTER logic (read-only wiring).

   The topbar holds one cockpit gauge group: COMMANDER (level + achievement progress)
   and the moved-up session-status instruments (UPLINK / ONLINE / save).

   This module OWNS none of the data. It is a pure read-only consumer:
     - COMMANDER level   — read from JourneyStore's server-owned progression snapshot.
                             Crew XP cannot write this headline or celebrate its level.
     - UPLINK / ONLINE / save — their markup was moved up from #bottombar .bb-right with ids
                             intact, so main.js save() and stationui.js tick()/flashSave() keep
                             writing them with zero changes here.

   It NEVER emits a bus event and never mutates another module's state — the frozen
   shared/events.js contract stays untouched, and the lint-emits gate has nothing to catch. */
'use strict';
const Topbar = (() => {
  let wired = false;
  let lastCommanderLevel = null;

  const $ = sel => document.querySelector(sel);

  // ---- Commander achievement sliver: read-only projection of durable Journey proof ----
  function paintXp() {
    try {
      const j = typeof JourneyStore !== 'undefined' && JourneyStore.status ? JourneyStore.status() : null;
      const g = j && j.progression;
      const label = document.getElementById('gt-station');
      if (!g || !Number.isFinite(g.level)) {
        if (label) label.textContent = '—'; lastCommanderLevel = null;
        const emptyFill = $('#tb-station .tb-xp-fill'); if (emptyFill) emptyFill.style.width = '0%';
        return;
      }
      const stale = JourneyStore.state && JourneyStore.state().stale;
      if (label) label.textContent = 'Lv ' + g.level + (stale ? ' · saved' : '');
      if (lastCommanderLevel != null && g.level > lastCommanderLevel) {
        const chip = document.getElementById('tb-station');
        if (chip) { chip.classList.remove('lvup'); void chip.offsetWidth; chip.classList.add('lvup'); }
        if (typeof SFX !== 'undefined' && SFX.level) SFX.level();
      }
      lastCommanderLevel = g.level;
      const fill = $('#tb-station .tb-xp-fill');
      if (fill && g.nextLevelAt > g.levelStartsAt) {
        const pct = Math.max(0, Math.min(100, Math.round(100 * (g.points - g.levelStartsAt) / (g.nextLevelAt - g.levelStartsAt))));
        fill.style.width = pct + '%';
        const xp = $('#tb-station .tb-xp');
        if (xp) xp.title = 'COMMANDER Lv ' + g.level + ' — ' + g.points + ' achievement points; ' + g.pointsToNextLevel + ' to the next level';
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
  /* LINK DOWN → WHY + A WAY OUT (link-down 2026-10-07). A red LINK DOWN that never said why and offered nothing
     left customers hunting for a way to quit or restart. Once the link has stayed down DOWN_ESCALATE_MS, the chip
     asks the service itself (Harness.engineState, bounded, at most every PROBE_EVERY_MS) and its tip carries THAT
     answer verbatim — the sidecar's own 503 'degraded: …' line or the guardian's halt, never an invented cause.
     On the desktop, while the service is not answering healthily, the connection box becomes the RESTART door
     (Harness.restartEngine — the same shell command the boot recovery screen uses). It is user-initiated only: a
     slow service may still be finishing live work. The World bridge reconnects on its own after a respawn (same
     port, same per-launch token), so there is no reload. A browser has nothing to restart: the tip names the step. */
  const DOWN_ESCALATE_MS = 15000, PROBE_EVERY_MS = 10000;
  let downSince = 0, lastProbeAt = 0, probing = false, engine = null, restarting = false, recoverable = false;
  const DOWN_TIP = 'lost the connection to StarNet’s background service — live numbers pause until it’s back (is the app still running?)';
  const BROWSER_STEP = ' — if you launched with `npm start`, check that terminal; otherwise open the desktop app';
  function canRestart() { try { return typeof Harness !== 'undefined' && !!Harness.canRestartEngine && Harness.canRestartEngine(); } catch (_) { return false; } }
  function probeEngine() {
    if (probing || typeof Harness === 'undefined' || !Harness.engineState) return;
    probing = true; lastProbeAt = Date.now();
    Promise.resolve(Harness.engineState()).then(s => { engine = s || null; }, () => { engine = null; })
      .finally(() => { probing = false; try { paintSig(); } catch (_) {} });
  }
  function downTip(desktop) {
    if (!engine) return DOWN_TIP;
    if (engine.state === 'ok') return 'lost the live link to StarNet’s background service — the service itself is answering, so this window is reconnecting on its own';
    const what = engine.reason || (engine.state === 'silent' ? 'StarNet’s background service isn’t answering (it may be stuck)' : 'StarNet’s background service isn’t running');
    return what + (desktop ? ' — click to restart the station service' : BROWSER_STEP);
  }
  function connectionBox(el) { return (el && el.closest && el.closest('.tb-connection')) || el; }
  function setRecoverable(el, on) {
    if (recoverable === on) return;
    recoverable = on;
    const box = connectionBox(el);
    if (!box) return;
    box.classList.toggle('recoverable', on);
    if (on) { box.setAttribute('role', 'button'); box.tabIndex = 0; box.setAttribute('aria-label', 'LINK DOWN — restart the station service'); }
    else { box.removeAttribute('role'); box.removeAttribute('tabindex'); box.removeAttribute('aria-label'); }
  }
  function notifyUser(text, cls) { try { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(text, cls); } catch (_) {} }
  async function restartFromChip() {
    const ls = linkNow();
    if (!recoverable || restarting || !ls || !ls.down || typeof Harness === 'undefined' || !Harness.restartEngine) return;
    restarting = true;
    notifyUser('restarting the station service…', 'warn');
    let ok = false;
    try { ok = await Harness.restartEngine(); } catch (_) { ok = false; }
    if (!ok) notifyUser('the station service could not be restarted — quit StarNet fully (tray → Quit) and open it again. Your save is untouched.', 'warn');
    else {
      // A respawn that comes straight back degraded (a workspace owned by another process, a crash at boot) is not
      // healed: say what the service now says instead of claiming success.
      let after = null;
      try { after = await Harness.engineState(); } catch (_) { after = null; }
      if (after && after.state === 'degraded' && after.reason) notifyUser('restarted, but the station service still reports: ' + after.reason, 'warn');
      else notifyUser('station service restarted — reconnecting…', 'good');
    }
    // give the bridge a full escalation window to reconnect before the door is offered again
    downSince = Date.now(); engine = null; lastProbeAt = 0; restarting = false;
    paintSig();
  }

  function paintSig() {
    const el = $('#sig'); if (!el) return;
    const bars = el.querySelector('b'); if (!bars) return;
    const ls = linkNow();
    // no world / never bridged / deliberately paused → neutral standby (never a false ONLINE-green,
    // never a false DOWN-red). Only a genuinely bridged-but-dead link paints the red fault state.
    if (!ls || !ls.bridged || ls.paused || !ls.down) { downSince = 0; engine = null; setRecoverable(el, false); }
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
      bars.textContent = SIG_DOWN;
      const now = Date.now();
      if (!downSince) downSince = now;
      const held = now - downSince >= DOWN_ESCALATE_MS;
      if (held && !restarting && now - lastProbeAt >= PROBE_EVERY_MS) probeEngine();
      const door = held && canRestart() && !!engine && engine.state !== 'ok';
      setRecoverable(el, door || restarting);
      el.childNodes[0].nodeValue = restarting ? 'RESTARTING… ' : door ? 'LINK DOWN · RESTART ' : 'LINK DOWN ';
      el.title = held ? downTip(canRestart()) : DOWN_TIP;
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

    // ONE PROGRESS DOOR: the COMMANDER gauge opens QUESTS › Progress (its tooltip always promised the quest log)
    const chip = document.getElementById('tb-station');
    if (chip) {
      chip.setAttribute('role', 'button'); chip.tabIndex = 0; chip.style.cursor = 'pointer';
      const go = () => { if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('quests', 'progress'); };
      chip.addEventListener('click', go);
      chip.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
    }

    // LINK DOWN restart door: wired once on the connection box, live only while paintSig marks it recoverable.
    const box = connectionBox($('#sig'));
    if (box && box.addEventListener) {
      box.addEventListener('click', () => { restartFromChip(); });
      box.addEventListener('keydown', ev => { if (recoverable && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); restartFromChip(); } });
    }

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
  return { init, _paintXp: paintXp, _paintSig: paintSig, _restartFromChip: restartFromChip };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { Topbar };
