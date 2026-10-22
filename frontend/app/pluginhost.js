/* frontend/app/pluginhost.js — PLUGIN WINDOWS (plugin extensions phase 1, 2026-09-29).

   An approved plugin's `screens` (plugin.json) become real Agent OS windows. Each one is registered through the
   ordinary window registry (StationUI.registerWindow), so it opens, drags, docks, minimizes and rises in as a glass
   sheet exactly like CONNECTORS or the TASK BOARD — the station's chrome, the plugin's content.

   The content is a SANDBOXED FRAME served by the sidecar's /plugin-ui/ route with an opaque origin: it cannot read
   this page, its token, or the API. What it may ask for, it asks HERE, over postMessage, and this host answers only
   for the plugin that owns that frame — the frame never gets to say which plugin it is (we match the message's
   source window against frames we created). Everything the plugin draws stays inside its window body; the title
   bar, the PLUGIN plate and every approval stay host-drawn, so a plugin can never pass its content off as the
   station's own telemetry.

   Theme: the host pushes the station's LIVE computed tokens into each frame (starnet-kit.js applies them) when a
   frame says hello and whenever <body>'s theme class or inline theme vars change — a custom hue repaints every
   plugin window in the same frame as the station.

   Exposes window.PluginHost = { refresh, open, placeTerminal, terminalOf, list, _test } */
(function (root) {
  'use strict';
  if (typeof document === 'undefined') return;

  const KEY_PREFIX = 'plugin.';
  const SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads';
  const DRAFT_SANDBOX = 'allow-scripts';   // a crew-written draft draws and runs, nothing more (the sidecar's CSP agrees)
  // A NONCE per frame, in the URL fragment the kit reads: the bridge answers only the page the host loaded. A plugin page
  // that navigates its frame elsewhere (a plain link to some site) keeps the same contentWindow — without the nonce that
  // site could call the plugin's store and backend.
  const nonce = () => { const a = new Uint8Array(12); (root.crypto || window.crypto).getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); };
  // A plugin may notify, not flood: 4 toasts per 10 s per plugin, kept out of the notification history.
  const toastLog = new Map();   // plugin id -> [times]
  const linkLog = new Map();    // plugin id -> [times] (ui.link)
  // The tokens a plugin page is kept in step with. The rgb triplets matter most: every kit recipe derives its
  // translucent glass from them, exactly as the station's own glass does.
  const THEME_VARS = ['--ph', '--ph-bright', '--ph-dim', '--ph-faint', '--ink', '--bg', '--panel', '--panel2', '--text',
    '--gold', '--ph-rgb', '--ph-bright-rgb', '--gold-rgb', '--ok', '--ok-rgb', '--bad', '--bad-rgb', '--warn',
    '--gd-edge', '--gd-light', '--gd-face', '--gd-hover', '--gd-shadow', '--t-fast', '--t-med', '--ease-soft'];

  const screens = new Map();   // window key -> { plugin, screen }   (live, approved screens only)
  const keyPlugin = new Map(); // window key -> plugin id, kept after a plugin goes off so its window can say why
  const frames = new Set();    // live { key, iframe, plugin, screen }
  let plugins = [];
  let lastError = '';

  // DRAFT previews (phase 4): a crew-written plugin shown before it is installed. Same window, same sandbox, a DRAFT
  // plate, a THROWAWAY in-memory store (a draft never writes to the station) and no backend (its code never runs).
  const DRAFT_PREFIX = 'plugindraft.';
  // APPS (frontend/app/apps.js owns the APPS window): an app is a network-less page the crew writes, its data, and an
  // optional schedule. Same frame, bridge and kit as a plugin window; an APP plate; a host-drawn bar underneath
  // (describe a change · refresh · honest status). The app never gets a backend.
  const APP_PREFIX = 'app.';
  const draftStores = new Map();   // draft id -> Map(key -> JSON text)
  const plainTitle = (s) => String(s == null ? '' : s).replace(/[&<>"'`\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'PLUGIN';
  const keyOf = (pluginId, screenId, draft) => (draft ? DRAFT_PREFIX : KEY_PREFIX) + pluginId + '.' + screenId;
  const UI = () => (typeof StationUI !== 'undefined' ? StationUI : null);
  const zoom = () => { try { return (typeof U !== 'undefined' && U.uiZoom) ? U.uiZoom() : 1; } catch (_) { return 1; } };

  function themeVars() {
    const out = {};
    let cs;
    try { cs = getComputedStyle(document.body); } catch (_) { return out; }
    for (const k of THEME_VARS) {
      const v = String(cs.getPropertyValue(k) || '').trim();
      if (v) out[k] = v;
    }
    return out;
  }
  function post(entry, msg) {
    try { entry.iframe.contentWindow.postMessage(Object.assign({ __sn: 1 }, msg), '*'); } catch (_) {}
  }
  function pushTheme() {
    if (!frames.size) return;
    const vars = themeVars();
    for (const f of frames) post(f, { ev: 'theme', vars });
  }

  function openExternal(url) {
    try {
      const invoke = root.__TAURI__ && root.__TAURI__.core && root.__TAURI__.core.invoke;
      if (invoke) { invoke('open_external_url', { url }).catch(() => { try { root.open(url, '_blank', 'noopener'); } catch (_) {} }); return; }
    } catch (_) {}
    try { root.open(url, '_blank', 'noopener'); } catch (_) {}
  }

  // Keep the window hugging its page like a native one, inside the room the viewport actually has.
  function fitHeight(entry, px) {
    const want = Math.max(0, Number(px) || 0);
    const maxH = Math.max(160, Math.floor((root.innerHeight / zoom()) * 0.78));
    entry.iframe.style.height = Math.max(80, Math.min(want, maxH)) + 'px';
  }

  function toastFor(entry, text, kind) {
    const ui = UI();
    const t = Date.now(), recent = (toastLog.get(entry.plugin.id) || []).filter((x) => t - x < 10000);
    if (recent.length >= 4) throw new Error('too many notifications — at most 4 every 10 seconds');
    recent.push(t); toastLog.set(entry.plugin.id, recent);
    const msg = entry.plugin.name + ': ' + String(text || '').slice(0, 280);
    const cls = kind === 'bad' ? 'bad' : (kind === 'warn' ? 'warn' : 'good');
    // transient: shown, never written into the station's notification history (a plugin cannot push the
    // Commander's real approvals out of the bell)
    if (ui && ui.notify) ui.notify(msg, cls, 'general', { transient: true });
  }
  // The station refused a call for this plugin (turned off, edited, removed): learn the new state so its windows
  // say so, instead of a page that keeps running old code under the PLUGIN plate.
  function refusedRefresh(status) { if (status === 409 || status === 410) refresh().catch(() => {}); }

  async function storeOp(entry, op, a) {
    if (entry.draft) {
      let m = draftStores.get(entry.plugin.id);
      if (!m) { m = new Map(); draftStores.set(entry.plugin.id, m); }
      const key = String((a && a.key) || '');
      if (op === 'keys') return Array.from(m.keys());
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(key) || key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('a store key is 1-128 letters, numbers, _ . : or -');
      if (op === 'get') return m.has(key) ? JSON.parse(m.get(key)) : null;
      if (op === 'set') {
        const text = JSON.stringify(a.value === undefined ? null : a.value);
        if (text.length > 256 * 1024) throw new Error('that value is over 256 KB');
        if (!m.has(key) && m.size >= 1000) throw new Error('this plugin already stores 1000 keys');
        m.set(key, text); return null;
      }
      if (op === 'delete') { m.delete(key); return null; }
      throw new Error('unknown store operation');
    }
    const r = await fetch(entry.app ? '/api/apps/store' : '/api/plugins/store', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: entry.plugin.id, op, key: a && a.key, value: a && a.value })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) { refusedRefresh(r.status); throw new Error((j && j.error) || ('the station refused (' + r.status + ')')); }
    return j.value;
  }

  /* THE BRIDGE. One table, every method named; anything else is refused. `entry` was resolved from the message's
     SOURCE window, so every answer is for the plugin that owns that frame and nothing else. */
  const METHODS = {
    hello: (entry) => ({
      plugin: { id: entry.plugin.id, name: entry.plugin.name, version: entry.plugin.version },
      screen: { id: entry.screen.id, title: entry.screen.title },
      theme: themeVars()
    }),
    'store.get': (entry, a) => storeOp(entry, 'get', a),
    'store.set': (entry, a) => storeOp(entry, 'set', a),
    'store.delete': (entry, a) => storeOp(entry, 'delete', a),
    'store.keys': (entry) => storeOp(entry, 'keys', {}),
    // the plugin's OWN backend (api.handle in its main), run in its own process by the sidecar
    'backend.call': async (entry, a) => {
      if (entry.draft) throw new Error('a draft preview has no backend — its code runs only after it is installed and approved');
      if (entry.app) throw new Error('an app has no backend — its data arrives with app.publish (read it with starnet.store.get)');
      const r = await fetch('/api/plugins/call', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: entry.plugin.id, fn: String((a && a.fn) || ''), args: a && a.args })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { refusedRefresh(r.status); throw new Error((j && j.error) || ('the station refused (' + r.status + ')')); }
      return j.value;
    },
    'ui.toast': (entry, a) => { toastFor(entry, a && a.text, a && a.kind); return null; },
    'ui.height': (entry, a) => { fitHeight(entry, a && a.px); return null; },
    'ui.title': (entry, a) => {
      const w = entry.iframe.closest('.term');
      const t = w && w.querySelector('.term-title');
      const extra = String((a && a.text) || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
      if (t) t.textContent = plainTitle(entry.screen.title) + (extra ? ' · ' + extra : '');
      return null;
    },
    'ui.open': (entry, a) => {
      const sid = String((a && a.screen) || '');
      const key = keyOf(entry.plugin.id, sid, entry.draft);
      if (!screens.has(key)) throw new Error('this plugin has no screen named "' + sid + '"');
      const ui = UI(); if (ui && ui.openTerm) ui.openTerm(key);
      return null;
    },
    'ui.close': (entry) => { const ui = UI(); if (ui && ui.closeTerm) ui.closeTerm(entry.key); return null; },
    'ui.link': (entry, a) => {
      // a crew-written DRAFT preview may never carry anything out of the station (index.js draft rule), and an
      // https link it opens on load could carry whatever the agent embedded in it: drafts open no links (sweep 2026-10-01)
      if (entry.draft) throw new Error('a draft preview cannot open links — approve the plugin first');
      let u;
      try { u = new URL(String((a && a.url) || '')); } catch (_) { throw new Error('that is not a link'); }
      if (u.protocol !== 'https:') throw new Error('only https:// links can be opened');
      // a page cannot open a storm of browser tabs (nothing here proves a click): one a second, eight a minute
      const t = Date.now(), recent = (linkLog.get(entry.plugin.id) || []).filter((x) => t - x < 60000);
      if (recent.length >= 8 || (recent.length && t - recent[recent.length - 1] < 1000)) throw new Error('too many links opened — slow down');
      recent.push(t); linkLog.set(entry.plugin.id, recent);
      openExternal(u.href);
      return null;
    }
  };

  function onMessage(ev) {
    const d = ev.data;
    if (!d || d.__sn !== 1 || typeof d.m !== 'string' || !Number.isFinite(d.id)) return;
    let entry = null;
    for (const f of frames) { if (f.iframe.contentWindow === ev.source) { entry = f; break; } }
    if (!entry) return;   // not one of ours: never answered
    if (d.n !== entry.nonce) return;   // the frame navigated away from the page we loaded: never answered
    // a page of THIS plugin/app loaded (see watchLeave) — capped at one ahead of the loads, so a page cannot bank
    // hellos to cover later navigations of its own
    if (d.m === 'hello') entry.hellos = Math.min((entry.hellos || 0) + 1, (entry.loads || 0) + 1);
    const fn = Object.prototype.hasOwnProperty.call(METHODS, d.m) ? METHODS[d.m] : null;
    const reply = (ok, v, err) => post(entry, { re: d.id, ok, v: ok ? v : undefined, err: ok ? undefined : String(err || 'refused') });
    if (!fn) return reply(false, null, 'unknown call: ' + d.m);
    Promise.resolve().then(() => fn(entry, d.a && typeof d.a === 'object' ? d.a : {}))
      .then((v) => reply(true, v === undefined ? null : v), (e) => reply(false, null, (e && e.message) || e));
  }

  // ---- the window builder -----------------------------------------------------------------------------------------
  /* A FRAME THAT LEAVES. Under site isolation (the desktop's WebView2, and Chrome by default) a sandboxed frame that
     navigates ITSELF is not stopped by the station page's frame-src — measured 2026-09-30: an app page's
     `location.href = 'https://…'` reached the site on the desktop. Every page we serve carries the kit, and the kit's
     first act is a 'hello' with the frame's nonce; a page that loads in the frame WITHOUT saying hello is not ours.
     It is thrown out and the plugin/app put back on its LATEST version (a stale page — the code changed while the
     window was open — is the station's no-script 410 page, which also never says hello; a refresh first fixes that
     case). A second time within 15 s leaves the window stopped and says so, neutrally: the host cannot tell an
     escape from a page that will not load, so it accuses nothing.
     Honest limits: the one request that loaded the foreign page has already been made — what a frame can reach is
     only its own plugin's/app's data, and it never stays on screen to pose as Agent OS; and a page may send one hello
     ahead of a navigation (or hand its nonce to a page it opens), so a determined page can stay out of sight for one
     hop. The guard is about what the Commander SEES in a Agent OS window, not a network wall. */
  const leaveLog = new Map();   // window key -> last time its frame was thrown out
  function watchLeave(key, body, entry) {
    entry.iframe.addEventListener('load', () => {
      entry.loads = (entry.loads || 0) + 1;
      const n = entry.loads;
      setTimeout(() => {
        if (!entry.iframe.isConnected || entry.loads !== n || (entry.hellos || 0) >= n) return;
        const name = (entry.plugin && entry.plugin.name) || 'This ' + (entry.app ? 'app' : 'plugin');
        const ui = UI();
        forget(entry.iframe);
        entry.iframe.remove();
        const again = leaveLog.has(key) && Date.now() - leaveLog.get(key) < 15000;
        leaveLog.set(key, Date.now());
        if (again) {
          const note = document.createElement('div');
          note.className = 'plugin-gone';
          note.textContent = name + ' keeps failing to load its own page, so its window is stopped. Reopen it to try again.';
          body.insertBefore(note, body.firstChild);
          return;
        }
        // put it back on its LATEST version (the app/plugin list is re-read first, so a changed page loads fresh)
        const reread = entry.app && typeof AppsUI !== 'undefined' && AppsUI.load ? AppsUI.load() : refresh();
        Promise.resolve(reread).catch(() => null).then(() => { if (body.isConnected && !frameFor(body)) build(key, body); });
        if (ui && ui.notify) ui.notify(name + ' could not load its own page — Agent OS reopened it.', 'warn', 'general', { transient: true });
      }, 2500);
    });
  }

  function frameFor(body) { return body && body.querySelector ? body.querySelector(':scope > iframe.plugin-frame') : null; }
  function forget(iframe) { for (const f of frames) if (f.iframe === iframe) frames.delete(f); }

  function build(key, body) {
    const def = screens.get(key);
    const existing = frameFor(body);
    // IDEMPOTENT: the window manager re-runs builders on re-render; a live plugin must never be reloaded (and lose
    // its state) because the station repainted. Same plugin code → keep the running frame.
    if (existing && def && existing.dataset.digest === def.plugin.digest) return;
    if (existing) forget(existing);
    // An APP keeps its bar across a reload: the crew rewrites the page while the Commander is typing the next change.
    const keepBar = (def && def.app) ? body.querySelector(':scope > .app-bar') : null;
    const keepHeight = existing ? existing.style.height : '';
    for (const ch of Array.from(body.childNodes)) if (ch !== keepBar) ch.remove();
    body.classList.add('plugin-body');
    const w = body.closest && body.closest('.term');
    if (w && def && def.draft) w.classList.add('plugin-draft-win');   // one class token per add (the window manager adds className whole)
    if (w && def && def.app) w.classList.add('plugin-app-win');
    if (w && !w.querySelector('.plugin-plate')) {
      const title = w.querySelector('.term-title');
      if (title) {
        const plate = document.createElement('span');
        const draft = !!(def && def.draft), isApp = !!(def && def.app);
        plate.className = 'plugin-plate' + (draft ? ' draft' : '') + (isApp ? ' app' : '');
        plate.textContent = draft ? 'DRAFT' : (isApp ? 'APP' : 'PLUGIN');
        plate.setAttribute('data-tip', draft ? 'A plugin draft your crew wrote — not installed; its code does not run and nothing it saves is kept'
          : (isApp ? 'An app your crew built for you. It can only draw — its content comes from your crew' : 'Drawn by a plugin you approved, not by Agent OS'));
        title.insertAdjacentElement('afterend', plate);
      }
    }
    if (!def) {
      // say WHY, from the listing: an edited plugin is not the same as a removed or switched-off one
      const pid = keyPlugin.get(key);
      const p = pid ? plugins.find((x) => x.id === pid) : null;
      const why = String(key).indexOf(APP_PREFIX) === 0 ? 'This app was deleted.' : !p ? 'This plugin was removed.'
        : (p.pending ? (p.name || p.id) + ' changed since you approved it, so its window is closed until you approve the new code in ABILITIES → EXTENSIONS.'
          : (p.name || p.id) + ' is turned off. Turn it on in ABILITIES → EXTENSIONS.');
      const note = document.createElement('div');
      note.className = 'plugin-gone';
      note.textContent = why;
      body.appendChild(note);
      return;
    }
    const url = (typeof ApiTicket === 'undefined') ? ''
      : (def.app ? (ApiTicket.appUrl ? ApiTicket.appUrl(def.plugin.id, def.plugin.digest, def.screen.entry) : '')
        : def.draft ? (ApiTicket.draftUrl ? ApiTicket.draftUrl(def.plugin.id, def.plugin.digest, def.screen.entry) : '')
        : (ApiTicket.pluginUrl ? ApiTicket.pluginUrl(def.plugin.id, def.plugin.digest, def.screen.entry) : ''));
    if (!url) { body.innerHTML = '<div class="plugin-gone">The station could not open this window (no session).</div>'; return; }
    const iframe = document.createElement('iframe');
    iframe.className = 'plugin-frame';
    iframe.setAttribute('sandbox', (def.draft || def.app) ? DRAFT_SANDBOX : SANDBOX);
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('allow', '');
    iframe.setAttribute('aria-label', def.plugin.name + ' — ' + def.screen.title);
    iframe.dataset.digest = def.plugin.digest;
    iframe.dataset.plugin = def.plugin.id;
    iframe.style.height = keepHeight || '240px';   // a reload keeps the height the page already reported (no jump)
    const entry = { key, iframe, plugin: def.plugin, screen: def.screen, draft: !!def.draft, app: !!def.app, nonce: nonce() };
    frames.add(entry);
    iframe.src = url + '#sn=' + entry.nonce;
    watchLeave(key, body, entry);
    if (keepBar) body.insertBefore(iframe, keepBar); else body.appendChild(iframe);
    if (def.app && typeof AppsUI !== 'undefined' && AppsUI.mountBar) AppsUI.mountBar(body, def.plugin.id);
  }

  // A closed window's frame must stop being answered.
  const reaper = new MutationObserver(() => {
    for (const f of frames) if (!f.iframe.isConnected) frames.delete(f);
  });

  async function refresh() {
    let data;
    try {
      const r = await fetch('/api/plugins');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json();
    } catch (e) { lastError = (e && e.message) || String(e); return false; }
    lastError = '';
    plugins = Array.isArray(data.plugins) ? data.plugins : [];
    const ui = UI();
    const live = new Set();
    for (const p of plugins) {
      if (!p.active || !Array.isArray(p.screens)) continue;
      for (const s of p.screens) {
        const key = keyOf(p.id, s.id);
        live.add(key);
        keyPlugin.set(key, p.id);
        screens.set(key, { plugin: { id: p.id, name: p.name || p.id, version: p.version || '0', digest: p.digest }, screen: s });
        if (ui && ui.registerWindow) {
          // The window manager renders a title as HTML; a plugin's title is plain text, so markup characters are
          // dropped outright (escaping would double-escape in the footer plate and the close button's label).
          ui.registerWindow(key, plainTitle(s.title), (body) => build(key, body), { className: 'plugin-win', wide: s.size === 'wide' });
        }
      }
    }
    // A plugin turned off or edited: its registry entry goes; any open window re-renders into the honest notice
    // (off) or the newly approved code (edited). Never leave old code looking live.
    for (const key of Array.from(screens.keys())) if (!live.has(key) && key.indexOf(DRAFT_PREFIX) !== 0 && key.indexOf(APP_PREFIX) !== 0) screens.delete(key);
    for (const f of Array.from(frames)) {
      if (f.app) continue;   // apps follow their own reload signal (app.reload), not the plugin list
      const def = screens.get(f.key);
      if (!def || def.plugin.digest !== f.iframe.dataset.digest) { if (ui && ui.rerender) ui.rerender(f.key); }
    }
    return true;
  }

  /* preview({ id, digest, screen, name, screens }) — the station bridge verb 'plugin.preview' (the crew's
     plugin.preview tool). Registers every screen of the draft at THIS digest and opens (or reloads) the one asked
     for; a later preview of an edited draft re-renders the open window onto the new code. */
  function preview(a) {
    const id = String((a && a.id) || '');
    const digest = String((a && a.digest) || '');
    const list = Array.isArray(a && a.screens) ? a.screens : [];
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || !/^[0-9a-f]{64}$/.test(digest) || !list.length) throw new Error('that draft has no window to preview');
    const ui = UI();
    if (!ui || !ui.registerWindow || !ui.openTerm) throw new Error('the station windows are not ready');
    const plugin = { id, name: String((a && a.name) || id).slice(0, 60), version: 'draft', digest };
    for (const s of list) {
      if (!s || !s.id || !s.entry) continue;
      const key = keyOf(id, s.id, true);
      screens.set(key, { plugin, screen: { id: String(s.id), title: String(s.title || s.id), entry: String(s.entry), size: s.size === 'wide' ? 'wide' : 'panel' }, draft: true });
      keyPlugin.set(key, id);
      ui.registerWindow(key, plainTitle(s.title || s.id), (body) => build(key, body), { className: 'plugin-win', wide: s.size === 'wide' });
    }
    const want = list.find((s) => s && s.id && s.entry && s.id === (a && a.screen)) || list.find((s) => s && s.id && s.entry);
    if (!want) throw new Error('that draft has no window to preview');
    const key = keyOf(id, want.id, true);
    // every open window of this draft moves to the new code (rerender swaps frames whose digest changed)
    for (const f of Array.from(frames)) if (f.draft && f.plugin.id === id && ui.rerender) ui.rerender(f.key);
    ui.openTerm(key);   // opens it, or restores it when minimized
    const opened = Array.from(frames).some((f) => f.key === key);
    if (!opened) throw new Error('the preview window did not open');
    return { title: plainTitle(want.title || want.id) };
  }

  function open(pluginId, screenId) {
    const p = plugins.find((x) => x.id === pluginId);
    const sid = screenId || (p && p.screens && p.screens[0] && p.screens[0].id);
    const key = keyOf(pluginId, sid || '');
    if (!screens.has(key)) return false;
    const ui = UI();
    // once a plugin is installed and opened, its DRAFT preview has done its job: close it rather than leave a stale
    // copy of the same window docked on top
    if (ui && ui.closeTerm) for (const f of Array.from(frames)) if (f.draft && f.plugin.id === pluginId) ui.closeTerm(f.key);
    if (ui && ui.openTerm) ui.openTerm(key);
    return true;
  }

  /* A plugin with TOOLS needs a body in the station (object = capability): its PLUGIN TERMINAL. Installing places one
     in the lead's room (Andrew 2026-09-29) — a real prop through the world model's ordinary placement rules, saved
     like any REFIT edit, idempotent (an existing terminal for the plugin is reused, never duplicated). */
  function station() { try { return (typeof App !== 'undefined' && App.station) ? App.station() : null; } catch (_) { return null; } }
  function terminalOf(pluginId) {
    const st = station();
    const doc = st && st.serialize ? st.serialize() : null;
    const p = doc && Array.isArray(doc.props) ? doc.props.find((x) => x && x.t === 'plugin_terminal' && x.pluginId === pluginId) : null;
    return p ? { id: p.id, x: p.x, y: p.y } : null;
  }
  function placeTerminal(pluginId) {
    const st = station();
    if (!st || typeof st.placePluginTerminal !== 'function') return { ok: false, error: 'NO_STATION', msg: 'the station floor is not loaded' };
    const r = st.placePluginTerminal(pluginId, 'agent');
    if (r && r.ok && !r.existing) { try { if (typeof App !== 'undefined' && App.persist) App.persist(); } catch (_) {} }
    return r;
  }

  /* ---- apps ---------------------------------------------------------------------------------------------------- */
  // registerApp(a) — a described app ({ id, name, digest }) becomes an openable window (idempotent).
  function registerApp(a) {
    const ui = UI();
    if (!a || !a.id || !a.digest || !ui || !ui.registerWindow) return null;
    const key = APP_PREFIX + a.id;
    screens.set(key, { plugin: { id: a.id, name: a.name || a.id, version: 'app', digest: a.digest }, screen: { id: 'main', title: a.name || a.id, entry: 'index.html', size: 'panel' }, app: true });
    keyPlugin.set(key, a.id);
    ui.registerWindow(key, plainTitle(a.name || a.id), (body) => build(key, body), { className: 'plugin-win' });
    return key;
  }
  function openApp(a) {
    const key = registerApp(a);
    if (!key) return false;
    const ui = UI(); if (ui && ui.openTerm) ui.openTerm(key);
    return true;
  }
  // the crew rewrote the page: move every open window of it onto the new code (a new digest = a new page URL)
  function appReload(id, digest) {
    const key = APP_PREFIX + id, def = screens.get(key);
    if (!def) return false;
    if (digest) def.plugin.digest = digest;
    const ui = UI();
    for (const f of Array.from(frames)) if (f.key === key && ui && ui.rerender) ui.rerender(key);
    return true;
  }
  // the crew published data: tell the page (starnet.onData) and refresh the bar's status line
  function appData(id) {
    const key = APP_PREFIX + id;
    for (const f of frames) if (f.key === key) post(f, { ev: 'data' });
    return true;
  }
  // the app was deleted: its window key stops resolving (an open window says so instead of showing a dead page)
  function forgetApp(id) { const key = APP_PREFIX + id; screens.delete(key); keyPlugin.delete(key); toastLog.delete(id); linkLog.delete(id); }
  function renameApp(id, name) {
    const key = APP_PREFIX + id, def = screens.get(key);
    if (def) { def.plugin.name = name; def.screen.title = name; registerApp({ id, name, digest: def.plugin.digest }); }
    for (const f of frames) if (f.key === key) { const t = f.iframe.closest('.term') && f.iframe.closest('.term').querySelector('.term-title'); if (t) t.textContent = plainTitle(name); }
  }

  function init() {
    root.addEventListener('message', onMessage);
    try { reaper.observe(document.getElementById('terms') || document.body, { childList: true, subtree: true }); } catch (_) {}
    // theme changes are a class swap (body.theme-*) or inline vars/zoom on <body> — one observer covers every path
    let t = 0;
    try {
      new MutationObserver(() => { clearTimeout(t); t = setTimeout(pushTheme, 30); })
        .observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    } catch (_) {}
    refresh();
  }

  const api = {
    refresh, open, preview, placeTerminal, terminalOf, registerApp, openApp, appReload, appData, renameApp, forgetApp,
    list: () => plugins.slice(),
    _test: { frames, screens, themeVars, METHODS, get lastError() { return lastError; } }
  };
  root.PluginHost = api;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : this);
