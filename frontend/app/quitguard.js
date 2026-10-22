/* AGENT OS quitguard.js
   GB-4 quit half: closing the desktop window kills every live provider stream mid-run.
   Intercept close-requested (titlebar X routes through appWindow.close(), Alt+F4 and the
   taskbar land here too) and, when agents are working, make the kill an EXPLICIT choice —
   never a side effect of a click. Count comes from Channels.busyCount(): sidecar-CONFIRMED
   runs only (truthful telemetry), so the guard can never block on a phantom.
   Browser preview has no __TAURI__ → install() no-ops and the page behaves as before. */
'use strict';

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QuitGuard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function liveRunCount(channels) {
    try {
      const c = channels || (typeof root.Channels !== 'undefined' ? root.Channels : null);
      return (c && typeof c.busyCount === 'function') ? c.busyCount() : 0;
    } catch (_) { return 0; }
  }

  function tauriWindow(win) {
    const api = win && win.__TAURI__;
    if (!api || !api.window) return null;
    const w = api.window;
    if (typeof w.getCurrentWindow === 'function') return w.getCurrentWindow();
    if (w.Window && typeof w.Window.getCurrent === 'function') return w.Window.getCurrent();
    return null;
  }

  // Last-breath state flush before the webview dies, bounded so a dead sidecar can never
  // wedge the close. Reuses Updates.preInstallDrain (CloudSave force-flush + roster push) —
  // destroy() skips beforeunload on some platforms, so relying on it would silently drop
  // the newest ~1.2s of world changes on every quit.
  async function drainState(deps) {
    const updates = (deps && deps.updates) || (typeof root.Updates !== 'undefined' ? root.Updates : null);
    if (updates && typeof updates.preInstallDrain === 'function') {
      try { await updates.preInstallDrain(3000); } catch (_) {}
    }
  }

  let overlay = null;
  function removeOverlay() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }

  function showConfirm(doc, n, onCloseAnyway) {
    removeOverlay();
    overlay = doc.createElement('div');
    overlay.className = 'quit-guard-backdrop';
    overlay.innerHTML =
      '<div class="quit-guard-card" role="alertdialog" aria-label="Agents still working">' +
      '<div class="up-guard">' +
      (n === 1 ? '1 AGENT IS STILL WORKING' : n + ' AGENTS ARE STILL WORKING') +
      ' - CLOSING AGENT OS KILLS ' + (n === 1 ? 'ITS RUN' : 'THEIR RUNS') + '.</div>' +
      '<div class="up-actions">' +
      '<button class="bb sm" id="qg-stay">STAY</button>' +
      '<button class="bb sm danger" id="qg-close">CLOSE ANYWAY</button>' +
      '</div></div>';
    overlay.addEventListener('click', ev => { if (ev.target === overlay) removeOverlay(); });
    overlay.querySelector('#qg-stay').addEventListener('click', removeOverlay);
    overlay.querySelector('#qg-close').addEventListener('click', () => { removeOverlay(); onCloseAnyway(); });
    doc.body.appendChild(overlay);
  }

  // The close-requested decision, dependency-injected so tests can drive it without Tauri.
  // deps: { channels, updates, doc, destroy, confirmed, show } — `confirmed` = CLOSE ANYWAY
  // already clicked; `destroy` performs the real window teardown; `show` renders the card
  // (defaults to the real overlay; tests inject a spy).
  // Is an update install committed? Then this close IS the updater's restart (macOS/Linux end
  // install with app.restart(), which can emit close-requested). Blocking it would swap the files
  // but never relaunch the app — the user already consented to the update, so let it through.
  function updateInstalling(deps) {
    try {
      const u = (deps && deps.updates) || (typeof root.Updates !== 'undefined' ? root.Updates : null);
      return !!(u && typeof u.isInstalling === 'function' && u.isInstalling());
    } catch (_) { return false; }
  }

  async function keepsRunningAfterClose(deps) {
    try {
      return !!(deps && typeof deps.keepsRunning === 'function' && await deps.keepsRunning());
    } catch (_) { return false; }
  }

  async function handleCloseRequested(ev, deps) {
    deps = deps || {};
    const doc = deps.doc || root.document;
    if (deps.confirmed && deps.confirmed()) { await drainState(deps); return; } // allow: API destroys
    if (updateInstalling(deps)) { await drainState(deps); return; }              // allow: update restart
    // If the native supervisor proves this close only HIDES the window (the explicit close-to-tray preference,
    // or armed background work), there is no run-kill to warn about. Flush browser state and let Rust hide it.
    if (await keepsRunningAfterClose(deps)) {
      await drainState(deps);
      // Tauri's JS onCloseRequested wrapper destroys the webview window unless this event is
      // prevented. Rust already intercepted the native close and hid the window; keep the
      // `main` window registered so tray Open and a second launch can reveal it again.
      ev.preventDefault();
      return;
    }
    const n = liveRunCount(deps.channels);
    if (!n) {
      // Nothing live: flush state, then STILL prevent the JS-side default. Tauri's onCloseRequested
      // wrapper destroys the webview window when the event is un-prevented — but the native
      // supervisor already intercepted this close (hid the window) and owns the outcome: full quit
      // (process exit tears everything down) or tray residency (the window MUST survive so tray
      // Open / a second launch can reveal it). Destroying here while the supervisor chose residency
      // left a windowless, unrevealable background process (the 0.10.x zombie).
      await drainState(deps);
      ev.preventDefault();
      return;
    }
    ev.preventDefault();                                                          // block; ask first
    (deps.show || showConfirm)(doc, n, () => { if (typeof deps.destroy === 'function') deps.destroy(); });
  }

  async function install(win) {
    win = win || root;
    const appWindow = tauriWindow(win);
    if (!appWindow || typeof appWindow.onCloseRequested !== 'function') return false; // browser preview
    if (win.__STARNET_QUITGUARD_WIRED__) return false;
    win.__STARNET_QUITGUARD_WIRED__ = true;
    let confirmed = false;
    const deps = {
      confirmed: () => confirmed,
      keepsRunning: async () => {
        const lifecycle = root && root.Lifecycle;
        if (!lifecycle || typeof lifecycle.status !== 'function') return false;
        const state = await lifecycle.status();
        return !!(state && state.supervised && (state.closeToTray || state.armed));
      },
      destroy: async () => {
        confirmed = true;
        await drainState(null);
        // destroy() tears the window down directly (close() would loop back through this
        // guard); the drain above already ran, and the guard card was an explicit consent.
        try { await appWindow.destroy(); } catch (_) { try { appWindow.close(); } catch (__) {} }
      }
    };
    try {
      // Never let a guard failure make the window unclosable: any error in the handler
      // falls through WITHOUT preventDefault, so the close proceeds.
      await appWindow.onCloseRequested(async ev => {
        try { await handleCloseRequested(ev, deps); } catch (_) {}
      });
      return true;
    } catch (_) { return false; }
  }

  if (root && root.document) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', () => { install(root); }, { once: true });
    } else {
      install(root);
    }
  }

  return { liveRunCount, keepsRunningAfterClose, handleCloseRequested, install, _removeOverlay: removeOverlay };
});
