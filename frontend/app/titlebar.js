/* AGENT OS titlebar.js
   Custom window chrome for the Windows desktop shell. The Rust shell drops the
   native titlebar/border (decorations(false)) and stamps
   window.__STARNET_CUSTOM_CHROME__ = 1 in its init script; ONLY then does this
   module render the themed titlebar — a drag region plus MIN / MAX / CLOSE that
   ride the body.theme-* phosphor vars (css/titlebar.css). Browser preview and
   macOS keep their native chrome, so this module stays completely inert there.
   Truthful chrome: if the Tauri window API can't be resolved the bar is NOT
   rendered at all — never dead buttons over a window they can't control. */
'use strict';

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Titlebar = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  /** The shell opted this window into custom chrome (set by main.rs, Windows only). */
  function shouldInstall(win) {
    return !!(win && win.__STARNET_CUSTOM_CHROME__);
  }

  /** Resolve the current Tauri window handle across API shapes (same ladder as fullscreen.js). */
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

  /** Button actions against a resolved window handle. Each swallows failures —
      a broken IPC call must never throw out of a click handler. */
  function handlers(appWindow, warn) {
    const guard = p => Promise.resolve(p).catch(err => {
      if (typeof warn === 'function') warn('[titlebar] window control failed', err);
    });
    return {
      min() { return guard(appWindow.minimize()); },
      max() { return guard(appWindow.toggleMaximize()); },
      close() { return guard(appWindow.close()); }
    };
  }

  /** Apply the observed window state to the chrome: MAX button flips to the
      restore glyph while maximized; fullscreen hides the bar entirely (body.sn-fs). */
  function applyState(state, body, maxBtn) {
    const maximized = !!(state && state.maximized);
    const fullscreen = !!(state && state.fullscreen);
    if (maxBtn && maxBtn.classList) {
      maxBtn.classList.toggle('is-max', maximized);
      if (typeof maxBtn.setAttribute === 'function') {
        maxBtn.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
      }
    }
    if (body && body.classList) {
      const cl = body.classList;
      const before = typeof cl.contains === 'function' ? cl.contains('sn-fs') : null;
      cl.toggle('sn-fs', fullscreen);
      // sn-fs re-seats every .screen by the titlebar strip height after the window's
      // resize event already fired — fixed trackers (#logo via app.js positionLogo)
      // are stale until a resize re-fires. Only announce on a REAL flip: applyState
      // runs from the resize probe itself, so an unconditional dispatch would loop.
      if (before !== null && before !== fullscreen) {
        try {
          const win = body.ownerDocument && body.ownerDocument.defaultView;
          if (win && typeof win.dispatchEvent === 'function' && typeof win.Event === 'function') {
            win.dispatchEvent(new win.Event('resize'));
          }
        } catch (_) {}
      }
    }
    return { maximized, fullscreen };
  }

  /** Read maximized/fullscreen from the live window; resolves {maximized,fullscreen}.
      Missing probes read as false — the bar simply keeps its default glyphs. */
  function readState(appWindow) {
    const probe = fn => {
      try {
        return typeof appWindow[fn] === 'function'
          ? Promise.resolve(appWindow[fn]()).catch(() => false)
          : Promise.resolve(false);
      } catch (_) {
        return Promise.resolve(false);
      }
    };
    return Promise.all([probe('isMaximized'), probe('isFullscreen')])
      .then(([maximized, fullscreen]) => ({ maximized, fullscreen }));
  }

  function buildBar(doc) {
    const bar = doc.createElement('div');
    bar.id = 'sn-titlebar';
    bar.setAttribute('data-tauri-drag-region', '');

    const mark = doc.createElement('span');
    mark.className = 'sn-tb-mark';
    mark.setAttribute('data-tauri-drag-region', '');
    mark.textContent = '◆';

    const rule = doc.createElement('span');
    rule.className = 'sn-tb-rule';
    rule.setAttribute('data-tauri-drag-region', '');

    const controls = doc.createElement('div');
    controls.className = 'sn-tb-controls';
    // Windows exposes the authoritative window controls at the top-level UIA boundary.
    // Keep these themed mouse targets visual, but do not duplicate those same actions in
    // the document accessibility tree or keyboard order.
    controls.setAttribute('aria-hidden', 'true');

    const mkBtn = (id, label, iconClass, extra) => {
      const b = doc.createElement('button');
      b.id = id;
      b.type = 'button';
      b.className = 'sn-tb-btn' + (extra ? ' ' + extra : '');
      b.setAttribute('aria-label', label);
      b.tabIndex = -1;
      const ic = doc.createElement('span');
      ic.className = 'sn-ic ' + iconClass;
      // ALL glyphs are inline SVG on one shared spec — 2px strokes on INTEGER
      // geometry, so every axis-aligned edge covers whole device pixels at 100%
      // scale (a 2px stroke centered on an integer coordinate spans exactly
      // c-1..c+1) and rescales cleanly under display scaling / TEXT SIZE zoom.
      // History: CSS pseudo-element bars shredded on fractional device pixels
      // (2026-07-20, twice), then a lone 1.7px-stroke restore SVG read thinner
      // and dimmer than its 2px CSS siblings the moment the window maximized
      // (third report, same day). One weight, one medium — states now match.
      // CSS shows MAX or RESTORE one at a time via .is-max.
      if (iconClass === 'sn-ic-min') {
        ic.innerHTML =
          '<svg class="sn-g" viewBox="0 0 12 12" aria-hidden="true">' +
            '<path d="M2 7 H10"/></svg>';
      } else if (iconClass === 'sn-ic-max') {
        ic.innerHTML =
          '<svg class="sn-g sn-g-max" viewBox="0 0 12 12" aria-hidden="true">' +
            '<rect x="2" y="2" width="8" height="8"/></svg>' +
          '<svg class="sn-g sn-g-restore" viewBox="0 0 12 12" aria-hidden="true">' +
            '<path d="M5 1 H11 V7"/><rect x="2" y="4" width="6" height="6"/></svg>';
      } else if (iconClass === 'sn-ic-close') {
        ic.innerHTML =
          '<svg class="sn-g" viewBox="0 0 12 12" aria-hidden="true">' +
            '<path d="M2 2 L10 10 M10 2 L2 10"/></svg>';
      }
      b.appendChild(ic);
      controls.appendChild(b);
      return b;
    };
    const btnMin = mkBtn('sn-tb-min', 'Minimize', 'sn-ic-min');
    const btnMax = mkBtn('sn-tb-max', 'Maximize', 'sn-ic-max');
    const btnClose = mkBtn('sn-tb-close', 'Close', 'sn-ic-close', 'sn-tb-x');

    bar.appendChild(mark);
    bar.appendChild(rule);
    bar.appendChild(controls);
    return { bar, btnMin, btnMax, btnClose };
  }

  function install(win, doc) {
    win = win || root;
    doc = doc || (win && win.document);
    if (!doc || !doc.body || !shouldInstall(win)) return false;
    if (win.__STARNET_TITLEBAR_WIRED__) return false;
    const appWindow = tauriWindow(win);
    if (!appWindow) return false; // no handle → no chrome; native-less window still closable via Alt+F4
    win.__STARNET_TITLEBAR_WIRED__ = true;

    const els = buildBar(doc);
    const act = handlers(appWindow, win.console && win.console.warn ? win.console.warn.bind(win.console) : null);
    els.btnMin.addEventListener('click', act.min);
    els.btnMax.addEventListener('click', act.max);
    els.btnClose.addEventListener('click', act.close);

    const refresh = () => readState(appWindow).then(s => applyState(s, doc.body, els.btnMax));
    // resize fires on maximize/restore AND fullscreen toggles — one honest probe path.
    // Windows settles isMaximized/isFullscreen AFTER the resize event during
    // fullscreen enter/exit, so a lone immediate probe can freeze a stale glyph
    // (restore icon on a windowed frame); a trailing re-probe reads the settled truth.
    let settle = 0;
    const onResize = () => {
      refresh();
      if (settle) win.clearTimeout(settle);
      settle = win.setTimeout(() => { settle = 0; refresh(); }, 250);
    };
    win.addEventListener('resize', onResize);
    win.addEventListener('focus', refresh);

    doc.body.classList.add('sn-chrome');
    doc.body.appendChild(els.bar);
    refresh();
    return true;
  }

  if (root && root.document) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', () => install(root, root.document), { once: true });
    } else {
      install(root, root.document);
    }
  }

  return { shouldInstall, tauriWindow, handlers, applyState, readState, buildBar, install };
});
