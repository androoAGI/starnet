/* AGENT OS fullscreen.js
   F11 toggles the real desktop window in Tauri, with a browser Fullscreen API
   fallback for the local preview. */
'use strict';

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Fullscreen = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  let pendingToggle = null;

  function tauriCore(win) {
    return win && win.__TAURI__ && win.__TAURI__.core && typeof win.__TAURI__.core.invoke === 'function'
      ? win.__TAURI__.core
      : null;
  }

  function tauriWindow(win) {
    const api = win && win.__TAURI__;
    if (!api) return null;
    const windowApi = api.window || api.webviewWindow;
    if (!windowApi) return null;
    if (typeof windowApi.getCurrentWindow === 'function') return windowApi.getCurrentWindow();
    if (typeof windowApi.getCurrentWebviewWindow === 'function') return windowApi.getCurrentWebviewWindow();
    if (windowApi.Window && typeof windowApi.Window.getCurrent === 'function') return windowApi.Window.getCurrent();
    if (windowApi.WebviewWindow && typeof windowApi.WebviewWindow.getCurrent === 'function') return windowApi.WebviewWindow.getCurrent();
    if (windowApi.appWindow) return windowApi.appWindow;
    return null;
  }

  function isF11(ev) {
    return !!ev && (ev.key === 'F11' || ev.code === 'F11' || ev.keyCode === 122 || ev.which === 122);
  }

  function stopEvent(ev) {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
  }

  function toggleBrowser(doc) {
    doc = doc || (root && root.document);
    if (!doc || !doc.documentElement) return Promise.resolve(false);

    const active = doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement;
    if (active) {
      const exit = doc.exitFullscreen || doc.webkitExitFullscreen || doc.msExitFullscreen;
      return exit ? Promise.resolve(exit.call(doc)).then(() => false) : Promise.resolve(false);
    }

    const request = doc.documentElement.requestFullscreen
      || doc.documentElement.webkitRequestFullscreen
      || doc.documentElement.msRequestFullscreen;
    return request ? Promise.resolve(request.call(doc.documentElement)).then(() => true) : Promise.resolve(false);
  }

  // Flip body.sn-fs (titlebar hide + strip reclaim) the moment the toggle resolves — the
  // titlebar's own resize probe can trail by ~250ms on Windows, which reads as a second
  // layout jolt after the window has already gone fullscreen. Probes still reconcile later.
  function syncBodyClass(doc, on) {
    try {
      if (!doc || !doc.body || !doc.body.classList || typeof on !== 'boolean') return;
      const cl = doc.body.classList;
      const before = typeof cl.contains === 'function' ? cl.contains('sn-fs') : null;
      cl.toggle('sn-fs', on);
      // sn-fs moves the topbar by the titlebar strip height AFTER the window's own
      // resize already fired, so fixed-position trackers (#logo via positionLogo)
      // hold pre-flip pixel coordinates — re-announce the layout change.
      if (before !== on) dispatchResize(doc);
    } catch (_) {}
  }

  function dispatchResize(doc) {
    try {
      const win = doc && doc.defaultView;
      if (win && typeof win.dispatchEvent === 'function' && typeof win.Event === 'function') {
        win.dispatchEvent(new win.Event('resize'));
      }
    } catch (_) {}
  }

  function toggle(win, doc) {
    win = win || root;
    doc = doc || (win && win.document) || (root && root.document);
    return toggleInner(win, doc).then(on => { syncBodyClass(doc, on); return on; });
  }

  // Windows/tao: setFullscreen(true) on a MAXIMIZED window keeps the maximized
  // work-area geometry (screen minus taskbar), leaving a dead strip along the
  // bottom and a mis-sized layout — drop the maximize first, restore it on exit.
  let restoreMaximize = false;

  function unmaximizeForFullscreen(appWindow) {
    if (typeof appWindow.isMaximized !== 'function' || typeof appWindow.unmaximize !== 'function') {
      return Promise.resolve();
    }
    return Promise.resolve(appWindow.isMaximized()).then(max => {
      restoreMaximize = !!max;
      if (max) return appWindow.unmaximize();
    }).catch(() => {});
  }

  function remaximizeAfterFullscreen(appWindow) {
    if (!restoreMaximize) return Promise.resolve();
    restoreMaximize = false;
    return typeof appWindow.maximize === 'function'
      ? Promise.resolve(appWindow.maximize()).catch(() => {})
      : Promise.resolve();
  }

  function toggleInner(win, doc) {
    const appWindow = tauriWindow(win);
    if (appWindow && typeof appWindow.isFullscreen === 'function' && typeof appWindow.setFullscreen === 'function') {
      return Promise.resolve(appWindow.isFullscreen()).then(on => {
        const next = !on;
        const prep = next ? unmaximizeForFullscreen(appWindow) : Promise.resolve();
        return prep
          .then(() => appWindow.setFullscreen(next))
          .then(() => (next ? next : remaximizeAfterFullscreen(appWindow).then(() => next)));
      }).catch(err => {
        if (win && win.console && typeof win.console.warn === 'function') {
          win.console.warn('[fullscreen] Tauri window API toggle failed, trying command fallback', err);
        }
        const core = tauriCore(win);
        if (!core) return toggleBrowser(doc);
        return Promise.resolve(core.invoke('starnet_toggle_fullscreen')).catch(commandErr => {
          if (win && win.console && typeof win.console.warn === 'function') {
            win.console.warn('[fullscreen] native toggle failed, falling back to browser fullscreen', commandErr);
          }
          return toggleBrowser(doc);
        });
      });
    }
    const core = tauriCore(win);
    if (core) {
      return Promise.resolve(core.invoke('starnet_toggle_fullscreen')).catch(err => {
        if (win && win.console && typeof win.console.warn === 'function') {
          win.console.warn('[fullscreen] native toggle failed, falling back to browser fullscreen', err);
        }
        return toggleBrowser(doc);
      });
    }
    return toggleBrowser(doc);
  }

  function handleKeydown(ev, win, doc) {
    if (!isF11(ev) || ev.repeat) return false;
    stopEvent(ev);
    if (pendingToggle) return true;
    pendingToggle = toggle(win || root, doc).catch(err => {
      const consoleRef = (win && win.console) || (root && root.console);
      if (consoleRef && typeof consoleRef.warn === 'function') consoleRef.warn('[fullscreen] toggle failed', err);
    }).finally(() => {
      pendingToggle = null;
    });
    return true;
  }

  function install(win, doc) {
    win = win || root;
    doc = doc || (win && win.document);
    if (!win || typeof win.addEventListener !== 'function') return false;
    if (win.__STARNET_FULLSCREEN_WIRED__) return false;
    win.__STARNET_FULLSCREEN_WIRED__ = true;
    win.addEventListener('keydown', ev => handleKeydown(ev, win, doc), true);
    // Esc leaves browser fullscreen without going through toggle() — keep the class honest
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('fullscreenchange', () => syncBodyClass(doc, !!doc.fullscreenElement));
    }
    return true;
  }

  if (root && root.document) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', () => install(root, root.document), { once: true });
    } else {
      install(root, root.document);
    }
  }

  return { isF11, toggleBrowser, toggle, handleKeydown, install, syncBodyClass };
});
