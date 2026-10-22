/* starnet-kit.js — the `starnet` bridge for plugin windows (plugin extensions phase 1, 2026-09-29).

   Injected first thing in every plugin page's <head> by the sidecar, so `window.starnet` exists before any of the
   plugin's own scripts run. The page is a sandboxed frame with an OPAQUE origin: it cannot read the station, its
   token, or its API. Everything it may ask of the station goes through postMessage to the page host
   (frontend/app/pluginhost.js), which knows WHICH plugin this frame belongs to and answers only for that plugin.

     await starnet.ready                    → { plugin: {id, name, version}, screen: {id, title} }
     starnet.store.get(key) / set(key, v) / delete(key) / keys()      the plugin's own durable data (JSON values)
     starnet.backend.call(name, args)                                   the plugin's own code: api.handle(name, fn)
     starnet.ui.toast(text, 'ok'|'warn'|'bad')                          a station notification
     starnet.ui.setTitle(text)                                          this window's title (plain text)
     starnet.ui.open(screenId)                                          open another of THIS plugin's screens
     starnet.ui.close()                                                 close this window
     starnet.ui.openLink(url)                                           an https:// link in the real browser
     starnet.ui.setHeight(px) / starnet.ui.autoHeight(true|false)       the window follows content by default
     starnet.theme.vars / starnet.theme.onChange(fn)                   the station's live look (already applied)
     starnet.onData(fn)                                                 an APP: the crew just published new data

   Every call returns a Promise; a refused call rejects with an Error whose message says why. */
(function () {
  'use strict';
  if (window.starnet && window.starnet.__kit) return;
  const parentWin = window.parent;
  const pending = new Map();
  let seq = 0;
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  const themeListeners = [];
  const dataListeners = [];   // an APP: the crew published new data (app.publish) — re-read and re-render
  const theme = { vars: {} };
  // The host gave THIS page a nonce (in the URL fragment); every call carries it, so the station only ever answers
  // the page it loaded — never whatever a link might navigate this frame to.
  const NONCE = (/(?:^#|&)sn=([0-9a-f]{16,64})/.exec(location.hash || '') || [])[1] || '';
  // A window call runs the plugin's own code (up to 30 s in the station, plus a cold start): wait longer for it.
  const TIMEOUT = { 'backend.call': 45000 };

  function call(method, args) {
    if (!parentWin || parentWin === window) return Promise.reject(new Error('this page is not open in a Agent OS window'));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      // The frame is an opaque origin, so its messages carry origin "null" and the host checks the SOURCE window
      // instead. '*' is the only target an opaque origin can name; nothing sent here is secret.
      parentWin.postMessage({ __sn: 1, n: NONCE, id, m: String(method), a: args === undefined ? null : args }, '*');
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error('the station did not answer ' + method)); }
      }, TIMEOUT[method] || 15000);
    });
  }

  function applyTheme(vars) {
    if (!vars || typeof vars !== 'object') return;
    const root = document.documentElement;
    for (const k of Object.keys(vars)) {
      if (!/^--[a-z0-9-]{1,40}$/i.test(k)) continue;
      const v = String(vars[k] == null ? '' : vars[k]);
      if (v) root.style.setProperty(k, v);
    }
    theme.vars = Object.assign({}, theme.vars, vars);
    for (const fn of themeListeners.slice()) { try { fn(theme.vars); } catch (_) {} }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== parentWin) return;
    const d = ev.data;
    if (!d || d.__sn !== 1) return;
    if (d.ev === 'theme') { applyTheme(d.vars); return; }
    if (d.ev === 'data') { for (const fn of dataListeners.slice()) { try { fn(); } catch (_) {} } return; }
    if (d.re != null && pending.has(d.re)) {
      const p = pending.get(d.re); pending.delete(d.re);
      if (d.ok) p.resolve(d.v); else p.reject(new Error(String(d.err || 'refused')));
    }
  });

  // ---- auto height: the window hugs the page (like every native Agent OS window) until the page opts out ----
  // A page sized FROM the viewport (min-height:100vh plus a margin) would grow every time the frame grows: after a
  // run of back-to-back growth the kit stops following and leaves the height where it is.
  let auto = true, lastH = 0, raf = 0, growRun = 0, growAt = 0;
  function measure() {
    raf = 0;
    if (!auto || !document.body) return;
    const cs = getComputedStyle(document.body);
    const h = Math.ceil(document.body.getBoundingClientRect().height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0));
    if (Math.abs(h - lastH) < 2) return;
    const t = performance.now();
    growRun = (h > lastH && t - growAt < 400) ? growRun + 1 : 0;
    growAt = t;
    if (growRun > 12) { auto = false; return; }
    lastH = h;
    call('ui.height', { px: h }).catch(() => {});
  }
  // Links. A link to another page of THIS plugin keeps the nonce, so a multi-page plugin keeps its bridge. A link
  // ANYWHERE ELSE opens in the real browser: inside the frame it could only fail (most sites refuse to be framed,
  // and the page would lose its window). Caught here, in capture, so it works for a plain <a href> and even when
  // the page's own click handler is broken.
  document.addEventListener('click', (ev) => {
    // <a>, <area>, and an SVG <a> (whose link may be xlink:href)
    const a = ev.target && ev.target.closest ? ev.target.closest('a, area') : null;
    if (!a) return;
    const raw = a.getAttribute('href') || a.getAttribute('xlink:href') || '';
    if (!raw || raw.charAt(0) === '#' || /^javascript:/i.test(raw)) return;
    let u;
    try { u = new URL(raw, location.href); } catch (_) { return; }
    // this plugin's own files: http://host/plugin-ui/~t/<ticket>/<id>/<digest>/… (or /plugin-draft/…) — same 8 parts
    const prefix = location.href.split('#')[0].split('/').slice(0, 8).join('/') + '/';
    if (u.href.indexOf(prefix) === 0) {
      if (NONCE && !/(?:^#|&)sn=/.test(u.hash)) { u.hash = u.hash ? u.hash + '&sn=' + NONCE : 'sn=' + NONCE; a.setAttribute(a.hasAttribute('href') ? 'href' : 'xlink:href', u.href); }
      return;
    }
    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (u.protocol === 'http:') u.protocol = 'https:';   // the station opens https only
    if (u.protocol === 'https:') call('ui.link', { url: u.href }).catch(() => {});
  }, true);
  function schedule() { if (!raf) raf = requestAnimationFrame(measure); }
  function watch() {
    if (!document.body) return;
    try { new ResizeObserver(schedule).observe(document.body); } catch (_) {}
    schedule();
  }

  const starnet = {
    __kit: 1,
    ready,
    call,
    onData(fn) { if (typeof fn === 'function') dataListeners.push(fn); return () => { const i = dataListeners.indexOf(fn); if (i >= 0) dataListeners.splice(i, 1); }; },
    theme: {
      get vars() { return theme.vars; },
      onChange(fn) { if (typeof fn === 'function') themeListeners.push(fn); return () => { const i = themeListeners.indexOf(fn); if (i >= 0) themeListeners.splice(i, 1); }; }
    },
    // the plugin's own code in the station (api.handle(name, fn) in its main file)
    backend: {
      call: (fn, args) => call('backend.call', { fn: String(fn || ''), args: args === undefined ? null : args })
    },
    store: {
      get: (key) => call('store.get', { key }),
      set: (key, value) => call('store.set', { key, value }),
      delete: (key) => call('store.delete', { key }),
      keys: () => call('store.keys', {})
    },
    ui: {
      toast: (text, kind) => call('ui.toast', { text: String(text || ''), kind: kind || 'ok' }),
      setTitle: (text) => call('ui.title', { text: String(text || '') }),
      open: (screen) => call('ui.open', { screen: String(screen || '') }),
      close: () => call('ui.close', {}),
      openLink: (url) => call('ui.link', { url: String(url || '') }),
      setHeight: (px) => { auto = false; return call('ui.height', { px: Number(px) || 0 }); },
      autoHeight: (on) => { auto = on !== false; lastH = 0; schedule(); }
    }
  };
  window.starnet = starnet;

  call('hello', {}).then((info) => {
    if (info && info.theme) applyTheme(info.theme);
    resolveReady({ plugin: info && info.plugin, screen: info && info.screen });
  }).catch(() => resolveReady({ plugin: null, screen: null }));

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
  else watch();
})();
