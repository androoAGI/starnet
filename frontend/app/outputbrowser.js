/* AGENT OS — outputbrowser.js : the BROWSER window.

   Andrew, 2026-09-29/30: "a built in browser … when creating output" → "a browser button integrated cleanly in comms,
   so users can easily open it up to see what the agent is doing … should also allow the user to type a URL in" →
   (after trying a version where each run had a private browser) "the agent is not using the built in browser or
   controlling it at all, and cant see anything".

   So: ONE browser. The station owns a single built-in browser (sidecar/browser-view.js) that you and your agents
   SHARE. It is a real Chrome window on your screen (you use it natively: typing, sign-in popups, full speed), and
   this station window is its live mirror and remote: the picture, an address bar, SHOW WINDOW to raise it.
     · LIVE   the station browser. When an agent uses its browser tools in a COMMS run it drives THIS browser and
              you watch it happen; when the run ends the page stays. When no agent is driving it is yours — type an
              address, click, type; the next agent sees exactly the page you left. While an agent drives you watch
              (input is refused); if it needs you it says so and the STEP IN door appears.
     · PAGE   a web page an agent MADE (an .html in its workspace, or a workshop tool's entry page), rendered in a
              sandboxed iframe from /view/ or /workshop-run/ (opaque origin: it can never reach the app token/API).
     · WATCH  a PRIVATE browser — an unattended run's, or a second agent's while the shared one is busy. View only.

   The COMMS header carries the door (#comms-browser, the globe beside the +): one click opens this window on the
   browser. Its lamp is lit only while the station confirms the agent on the line is driving a browser.

   FOLLOW (off by default, remembered per viewer): when on, this window opens by itself when an agent starts
   browsing or makes a new page. With the window already open it always switches to the browser when an agent
   starts driving — an open window is somebody asking to see. Independent of FOLLOW, the PAGE on screen reloads when
   its file (or a web asset in its folder) is rewritten: the real bytes on disk, never a guess.

   Truthful telemetry: PAGE says "loaded" only after the station confirmed the file exists and the frame fired load;
   LIVE/WATCH show only frames the station sent; the address and the driver named are the ones the station reports. */
'use strict';
(function (root) {
  const FOLLOW_KEY = 'starnet.outputBrowser.follow';
  const RECENT_MAX = 8;
  const RELOAD_DEBOUNCE_MS = 400;
  const LIVE_DEBOUNCE_MS = 500;
  const HTML_RE = /\.html?$/i;
  const ASSET_RE = /\.(html?|css|m?js|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp3|wav|ogg|mp4|webm)$/i;
  const NO_STATION = { available: true, open: false, driver: null, handoff: false, remembered: false };

  const state = {
    mode: 'empty',       // 'empty' | 'page' | 'live' | 'watch'
    target: null,        // PAGE: { agentId, path, runId?, source: 'workspace'|'workshop' }
    watch: null,         // WATCH: { agentId, runId, target }
    recent: [],          // pages made this session, newest first
    live: { agents: [], station: NO_STATION },   // station truth (GET /api/browser/view)
    liveLoaded: false,
    driver: null,        // LIVE: who the station says is driving right now { agentId, runId } | null
    page: null,          // LIVE/WATCH: the address the browser itself reports { url, title }
    follow: false,
    ui: null,
    reloadTimer: null, liveTimer: null,
    loadSeq: 0, opSeq: 0, loadedAt: 0, lastCause: '', note: '', busy: false,
    doorPressedAt: 0     // when the COMMS globe was pressed (its window rises only after the station answers)
  };
  try { state.follow = !!(root.localStorage && root.localStorage.getItem(FOLLOW_KEY) === '1'); } catch (_) { state.follow = false; }

  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = p => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const dirOf = p => { const n = norm(p); const i = n.lastIndexOf('/'); return i < 0 ? '' : n.slice(0, i); };
  const baseOf = p => { const n = norm(p); return n.slice(n.lastIndexOf('/') + 1); };
  // Does a write to `path` change what the page at `pagePath` renders? The page itself, or a web asset in its
  // folder tree (a page at the workspace root owns the whole tree).
  function feedsPage(path, pagePath) {
    if (path === pagePath) return true;
    if (!ASSET_RE.test(path)) return false;
    const d = dirOf(pagePath);
    return !d || path.indexOf(d + '/') === 0;
  }
  const keyOf = t => t ? [t.source, t.agentId, t.runId || '', norm(t.path)].join('|') : '';
  function agentLabel(id) {
    if (typeof App !== 'undefined' && App && typeof App.agentName === 'function') { try { return App.agentName(id) || id; } catch (_) { /* fall through to the id */ } }
    try {
      const list = (typeof StationUI !== 'undefined' && StationUI.h) ? StationUI.h.present : [];
      const a = (list || []).find(x => x && x.id === id);
      if (a && a.name) return String(a.name);
    } catch (_) { /* fall through to the id */ }
    return String(id || 'agent');
  }
  const apiBase = () => String(root.__STARNET_API__ || '');
  function tauriCore() { return (root.__TAURI__ && root.__TAURI__.core) ? root.__TAURI__.core : null; }
  function notify(msg, tone) { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(msg, tone || 'warn'); }
  function getJson(path, signal) {
    return fetch(apiBase() + path, { cache: 'no-store', signal }).then(async r => { let j = null; try { j = await r.json(); } catch (_) { j = null; } return { status: r.status, body: j || {} }; });
  }
  function postJson(path, body) {
    return fetch(apiBase() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(async r => { let j = null; try { j = await r.json(); } catch (_) { j = null; } return { status: r.status, body: j || {} }; });
  }

  // The jail-relative path the station's own /api/file route knows this file by (a workshop file lives under
  // workshop/<runId>/ — the same rel the deliverable library builds).
  function jailRel(t) { return t.source === 'workshop' ? 'workshop/' + t.runId + '/' + norm(t.path) : norm(t.path); }
  function pageUrl(t) {
    if (typeof ApiTicket === 'undefined') return '';
    return t.source === 'workshop' ? ApiTicket.runUrl(t.agentId, t.runId, norm(t.path)) : ApiTicket.viewUrl(t.agentId, norm(t.path));
  }
  function normalizeTarget(t) {
    if (!t || !t.path) return null;
    const source = t.source === 'workshop' && t.runId ? 'workshop' : 'workspace';
    return { agentId: String(t.agentId || 'agent'), path: norm(t.path), runId: source === 'workshop' ? String(t.runId) : '', source };
  }
  function remember(t) {
    const k = keyOf(t);
    state.recent = [t].concat(state.recent.filter(x => keyOf(x) !== k)).slice(0, RECENT_MAX);
  }
  const station = () => state.live.station || NO_STATION;
  function privateRun(agentId) { return (state.live.agents || []).find(a => a && a.agentId === agentId) || null; }

  // ---------- icons (drawn, never a glyph: symbol characters fall back to the OS font) ----------
  const ICON = {
    back: 'M10 3L5 8l5 5', forward: 'M6 3l5 5-5 5', reload: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3',
    globe: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM1.5 8h13M8 1.5c-2 2-2 11 0 13M8 1.5c2 2 2 11 0 13'
  };
  function icon(kind) {
    return '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.4" data-ob-icon="' + kind + '"><path d="' + ICON[kind] + '"/></svg>';
  }

  // ---------- the window ----------
  function build(body) {
    body.innerHTML =
      '<div class="ob" data-mode="empty">'
      + '<form class="ob-bar" autocomplete="off">'
      + '<button type="button" class="bb sm ob-ic ob-back" aria-label="Back">' + icon('back') + '</button>'
      + '<button type="button" class="bb sm ob-ic ob-fwd" aria-label="Forward">' + icon('forward') + '</button>'
      + '<button type="button" class="bb sm ob-ic ob-reload" aria-label="Reload">' + icon('reload') + '</button>'
      + '<div class="ob-addr"><span class="ob-lamp" aria-hidden="true"></span><span class="ob-who"></span>'
      + '<input class="ob-url" type="text" spellcheck="false" autocapitalize="off" autocorrect="off" maxlength="2000" aria-label="Address" placeholder="Type an address or search"></div>'
      + '</form>'
      + '<div class="ob-strip"><div class="ob-recent"></div>'
      + '<button type="button" class="bb sm ob-front" hidden>SHOW WINDOW</button>'
      + '<button type="button" class="bb sm ob-follow" aria-pressed="false"></button>'
      + '<button type="button" class="bb sm ob-out">OPEN OUTSIDE</button></div>'
      + '<div class="ob-stage">'
      + '<iframe class="ob-frame" title="Agent-made page" sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock" referrerpolicy="no-referrer" hidden></iframe>'
      + '<div class="ob-vp" tabindex="0" role="application" aria-label="Live browser picture" hidden><img class="ob-live" alt="" draggable="false"></div>'
      + '<div class="ob-empty"></div>'
      + '</div>'
      + '<p class="ob-note" role="status"></p>'
      + '</div>';
    const q = s => body.querySelector(s);
    const ui = state.ui = { body, root: q('.ob'), bar: q('.ob-bar'), back: q('.ob-back'), fwd: q('.ob-fwd'), reload: q('.ob-reload'),
      who: q('.ob-who'), url: q('.ob-url'), front: q('.ob-front'), follow: q('.ob-follow'), out: q('.ob-out'), recent: q('.ob-recent'),
      frame: q('.ob-frame'), vp: q('.ob-vp'), img: q('.ob-live'), empty: q('.ob-empty'), note: q('.ob-note'), watchStream: null, liveStream: null };
    if (typeof BrowserStream !== 'undefined') {
      const ended = mode => b => { if (state.mode === mode) streamEnded(b || {}); };
      const onPage = p => { state.page = p; paintBar(); };
      ui.watchStream = BrowserStream.create({ vp: ui.vp, img: ui.img, onPage, onEnd: ended('watch'),
        poll: (seq, signal) => getJson('/api/browser/view/frame?target=' + encodeURIComponent(state.watch ? state.watch.target : '') + '&after=' + seq, signal) });
      ui.liveStream = BrowserStream.create({ vp: ui.vp, img: ui.img, onPage, onEnd: ended('live'),
        // every picture says who is driving: that is what the address bar and the status line report
        poll: (seq, signal) => getJson('/api/browser/view/frame?target=station&after=' + seq, signal).then(r => {
          if (r.status === 200 && r.body && r.body.ok) setDriver(r.body.driver || null);
          return r;
        }),
        // the station refuses input while an agent drives (409): the picture is then simply view-only
        send: events => postJson('/api/browser/view/input', { events }),
        canType: () => true,   // the Commander's hands are never refused (sidecar/browser-view.js driving)
        onLeave: () => { try { ui.url.focus(); } catch (_) { /* focus is best-effort */ } } });
    }
    setTimeout(watchMinimize, 0);   // once the window is in place
    ui.bar.addEventListener('submit', ev => { ev.preventDefault(); go(ui.url.value); });
    ui.url.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Escape') { ev.preventDefault(); paintBar(true); ui.url.blur(); } });
    ui.url.addEventListener('focus', () => { try { ui.url.select(); } catch (_) { /* selection is a nicety */ } });
    ui.reload.onclick = () => reload();
    ui.back.onclick = () => liveNav('back');
    ui.fwd.onclick = () => liveNav('forward');
    ui.follow.onclick = () => setFollow(!state.follow);
    ui.out.onclick = openOutside;
    ui.front.onclick = () => { postJson('/api/browser/view/front', {}).then(r => { if (r.status !== 200) setNote('Could not raise the browser window: ' + ((r.body && r.body.error) || 'the station did not answer') + '.'); }).catch(() => setNote('Could not raise the browser window.')); };
    ui.recent.addEventListener('click', ev => {
      const b = ev.target && ev.target.closest ? ev.target.closest('button[data-k]') : null;
      if (!b) return;
      if (b.dataset.k === 'page') { const t = state.recent[Number(b.dataset.i)]; if (t) showPage(t, 'opened'); }
      else if (b.dataset.k === 'agent') { const a = (state.live.agents || [])[Number(b.dataset.i)]; if (a) showWatch(a); }
      else if (b.dataset.k === 'live') showLive();
    });
    ui.empty.addEventListener('click', ev => {
      const b = ev.target && ev.target.closest ? ev.target.closest('button[data-act]') : null;
      if (!b) return;
      if (b.dataset.act === 'stepin' && typeof StepIn !== 'undefined' && StepIn.open) StepIn.open(b.dataset.id || '');
    });
    ui.frame.addEventListener('load', () => {
      if (!state.ui || state.mode !== 'page' || ui.frame.hidden || !ui.frame.getAttribute('src')) return;
      state.loadedAt = Date.now();
      setNote((state.lastCause === 'updated' ? 'Updated on disk, reloaded at ' : 'Showing the file on disk as of ') + new Date(state.loadedAt).toLocaleTimeString() + '.');
      ui.root.dataset.state = 'live';
    });
    paintBar();
    render('opened');
    // start the station browser now, in the background, so it is ready by the time an address is typed
    refreshLive().then(() => { if (!station().open && station().available !== false) postJson('/api/browser/view/warm', {}).catch(() => { /* it starts on first use anyway */ }); });
  }
  function mounted() { return !!(state.ui && state.ui.body && state.ui.body.isConnected); }
  function setNote(text) { state.note = String(text || ''); if (mounted() && state.ui.note.textContent !== state.note) state.ui.note.textContent = state.note; }
  function stopStreams() { const ui = state.ui; if (!ui) return; if (ui.watchStream) ui.watchStream.stop(); if (ui.liveStream) ui.liveStream.stop(); }
  function stage(which) {   // 'frame' | 'live' | 'empty'
    const ui = state.ui;
    ui.frame.hidden = which !== 'frame'; if (which !== 'frame') ui.frame.removeAttribute('src');
    ui.vp.hidden = which !== 'live'; if (which !== 'live') ui.img.removeAttribute('src');
    ui.empty.hidden = which !== 'empty';
  }
  function liveNote() {
    const d = state.driver;
    const su = station().setup;
    if (su && (su.state === 'downloading' || su.state === 'unpacking')) {
      const mb = n => Math.round(n / 1048576);
      return 'Setting up the browser for the first time (this computer has no Chrome, Edge or Chromium): '
        + (su.state === 'unpacking' ? 'unpacking…' : 'downloading Chromium' + (su.total ? ', ' + mb(su.received) + ' of ' + mb(su.total) + ' MB' : '') + '…');
    }
    if (su && su.state === 'failed' && !station().open) return 'Could not set up a browser on this computer: ' + su.error;
    const win = station().visible ? ' It is open in its own window too (SHOW WINDOW).' : '';
    if (d && d.signIn) return 'Sign in here: click the page and type. The agent is waiting and never sees what you type. Click Done in COMMS when you have finished.';
    if (d) return agentLabel(d.agentId) + ' is using the browser. You can click and type in it too.' + win;
    return 'The station browser, shared by you and your agents.' + (station().visible ? ' Use it in its own window, or click this live view to type in it.' : ' Click the page to type in it.') + (station().remembered ? ' Sign-ins are saved.' : '');
  }
  function setDriver(d) {
    const was = state.driver ? state.driver.runId + (state.driver.signIn ? '+' : '') : '', is = d ? d.runId + (d.signIn ? '+' : '') : '';
    state.driver = d;
    if (was === is) return;
    if (state.mode === 'live' && mounted() && state.ui.root.dataset.state === 'live') setNote(liveNote());
    paintBar();
    scheduleLive();   // the door lamp and the strip follow
  }

  function paintBar(forceUrl) {
    if (!mounted()) return;
    const ui = state.ui, m = state.mode, t = state.target, d = state.driver;
    ui.root.dataset.mode = m;
    ui.root.classList.toggle('driven', m === 'live' && !!d);
    const who = m === 'page' && t ? agentLabel(t.agentId) : m === 'watch' && state.watch ? agentLabel(state.watch.agentId) : m === 'live' ? (d && !d.signIn ? agentLabel(d.agentId) : 'YOU') : '';
    ui.who.textContent = who ? who.toUpperCase() : '';
    ui.who.hidden = !who;
    // never overwrite what the Commander is typing
    if (forceUrl || root.document.activeElement !== ui.url) {
      ui.url.value = m === 'page' && t ? t.path : (m === 'watch' || m === 'live') && state.page ? (state.page.url || '') : '';
    }
    ui.url.title = m === 'page' && t ? t.path + (t.source === 'workshop' ? ' (workshop)' : '') : (state.page && state.page.title) || '';
    const yours = m === 'live';   // the shared browser always takes your hands, agent or not
    ui.front.hidden = !(m === 'live' && station().visible);
    ui.back.disabled = ui.fwd.disabled = !yours || state.busy;
    ui.reload.disabled = !(m === 'page' || yours) || state.busy;
    ui.out.disabled = !((m === 'page' && t) || ((m === 'watch' || m === 'live') && state.page && /^https?:/i.test(state.page.url || '')));
    ui.follow.textContent = state.follow ? 'FOLLOW: ON' : 'FOLLOW: OFF';
    ui.follow.setAttribute('aria-pressed', String(state.follow));
    ui.follow.classList.toggle('on', state.follow);
    ui.follow.title = state.follow
      ? 'On: this window opens by itself when an agent starts browsing or makes a web page.'
      : 'Off: this window opens only when you open it. Turn on to have it open by itself when an agent starts browsing or makes a web page.';
    paintStrip();
  }
  function paintStrip() {
    if (!mounted()) return;
    const ui = state.ui, parts = [], st = station();
    if (st.open || st.driver) {
      const d = st.driver;
      parts.push('<button type="button" class="ob-chip ob-livechip' + (state.mode === 'live' ? ' on' : '') + '" data-k="live" title="' + esc(d ? agentLabel(d.agentId) + ' is driving the station browser' : 'The station browser') + '">'
        + (d ? '<span class="ob-dot' + (st.handoff ? ' ask' : '') + '" aria-hidden="true"></span>' + esc(agentLabel(d.agentId).toUpperCase()) + (st.handoff ? ' · NEEDS YOU' : ' · DRIVING') : 'BROWSER') + '</button>');
    }
    (state.live.agents || []).forEach((a, i) => {
      const on = state.mode === 'watch' && state.watch && state.watch.runId === a.runId;
      parts.push('<button type="button" class="ob-chip' + (on ? ' on' : '') + '" data-k="agent" data-i="' + i + '" title="' + esc(agentLabel(a.agentId)) + (a.handoff ? ' needs you in its browser' : ' has a browser of its own open: watch it') + '">'
        + '<span class="ob-dot' + (a.handoff ? ' ask' : '') + '" aria-hidden="true"></span>' + esc(agentLabel(a.agentId).toUpperCase()) + (a.handoff ? ' · NEEDS YOU' : ' · OWN BROWSER') + '</button>');
    });
    const others = state.recent.filter(x => !(state.mode === 'page' && keyOf(x) === keyOf(state.target)));
    if (others.length) parts.push('<span class="ob-rlab">PAGES</span>' + others.map(x => '<button type="button" class="ob-chip" data-k="page" data-i="' + state.recent.indexOf(x) + '" title="' + esc(agentLabel(x.agentId) + ' · ' + x.path) + '">' + esc(baseOf(x.path)) + '</button>').join(''));
    const html = parts.join('');
    if (ui.recent.innerHTML !== html) ui.recent.innerHTML = html;
  }

  // ---------- what the stage shows ----------
  function render(cause) {
    if (!mounted()) return;
    if (state.mode === 'page' && state.target) return loadPage(cause);
    if (state.mode === 'watch' && state.watch) return startWatch();
    if (state.mode === 'live') return startLive();
    showEmpty();
  }
  function showEmpty(closedWhy) {
    state.mode = 'empty'; state.page = null;
    stopStreams(); stage('empty');
    state.ui.root.dataset.state = closedWhy ? 'ended' : 'empty';
    state.ui.empty.innerHTML = (closedWhy ? '<p>' + esc(closedWhy) + '</p>' : '<p>Type an address above to open the browser.</p>')
      + '<p class="ob-dim">This is the station\'s browser. When an agent browses, it drives this one and you watch it here. When no agent is using it, it\'s yours.</p>';
    setNote('');
    paintBar(true);
  }

  // Confirm the file is really there before claiming a page (the frame's load event fires on a 404 too, and a
  // cross-origin frame can't be asked). HEAD on the station's own jailed file route answers for both sources.
  async function exists(t) {
    try {
      const r = await fetch('/api/file?agent=' + encodeURIComponent(t.agentId) + '&path=' + encodeURIComponent(jailRel(t)), { method: 'HEAD', cache: 'no-store' });
      return r.ok ? true : (r.status === 404 ? false : null);
    } catch (_) { return null; }
  }
  async function loadPage(cause) {
    if (!mounted() || !state.target) return;
    const t = state.target, seq = ++state.loadSeq, ui = state.ui;
    state.lastCause = cause || 'opened';
    stopStreams();
    paintBar(true);
    ui.root.dataset.state = 'loading';
    setNote('Loading…');
    const ok = await exists(t);
    if (seq !== state.loadSeq || !mounted() || state.mode !== 'page') return;
    if (ok === false) {
      stage('empty');
      ui.empty.innerHTML = '<p>That page isn\'t on disk any more.</p><p class="ob-dim">' + esc(t.path) + ' was moved or deleted after the agent wrote it.</p>';
      ui.root.dataset.state = 'missing'; setNote('');
      return;
    }
    const url = pageUrl(t);
    if (!url) {
      stage('empty');
      ui.empty.innerHTML = '<p>The station isn\'t reachable, so this page can\'t be shown right now.</p>';
      ui.root.dataset.state = 'missing'; setNote('');
      return;
    }
    stage('frame');
    ui.frame.src = url;   // a fresh ticket every load: the old one may be past its ten-minute life
  }
  function scheduleReload() {
    clearTimeout(state.reloadTimer);
    state.reloadTimer = setTimeout(() => { state.reloadTimer = null; if (state.mode === 'page') loadPage('updated'); }, RELOAD_DEBOUNCE_MS);
  }

  function startLive() {
    const ui = state.ui, st = station();
    if (ui.watchStream) ui.watchStream.stop();
    if (st.handoff && st.driver) return showHandoff(st.driver.agentId);
    state.driver = st.driver || state.driver;
    stage('live');
    ui.root.dataset.state = 'live';
    setNote(liveNote());
    paintBar(true);
    // always a FRESH stream: start() drops any poll still in flight from before (a stale "closed" from a browser that
    // has since been started again must never blank the picture)
    if (ui.liveStream) ui.liveStream.start();
  }
  function startWatch() {
    const ui = state.ui, w = state.watch;
    if (ui.liveStream) ui.liveStream.stop();
    state.page = null;
    const a = privateRun(w.agentId);
    if (a && a.handoff) return showHandoff(w.agentId);
    stage('live');
    ui.root.dataset.state = 'live';
    setNote('Watching ' + agentLabel(w.agentId) + '\'s own browser. View only: the agent is driving.');
    paintBar(true);
    if (ui.watchStream) ui.watchStream.start();
  }
  function showHandoff(agentId) {
    const ui = state.ui;
    stopStreams(); stage('empty');
    ui.root.dataset.state = 'ask';
    const name = esc(agentLabel(agentId).toUpperCase());
    let id = '';
    try { const l = (typeof StepIn !== 'undefined' && typeof StepIn.live === 'function') ? StepIn.live() : []; const h = l.find(x => x && x.agentId === agentId); if (h) id = String(h.id); } catch (_) { id = ''; }
    const canOpen = typeof StepIn !== 'undefined' && typeof StepIn.open === 'function';
    ui.empty.innerHTML = '<p>' + name + ' needs you in the browser.</p>'
      + '<p class="ob-dim">It is paused on a page only you can get past (a sign-in, a code, a human check). Take the wheel in STEP-IN, then hand it back.</p>'
      + (canOpen ? '<button type="button" class="bb sm" data-act="stepin" data-id="' + esc(id) + '">STEP IN</button>' : '');
    setNote('');
    paintBar(true);
  }
  function streamEnded(b) {
    if (!mounted()) return;
    const ui = state.ui, code = b && b.code;
    if (state.mode === 'watch' && state.watch) {
      const agentId = state.watch.agentId;
      if (code === 'handoff') { refreshLive(); return showHandoff(agentId); }
      stage('empty');
      ui.root.dataset.state = 'ended';
      ui.empty.innerHTML = '<p>' + esc(agentLabel(agentId).toUpperCase()) + '\'s own browser closed.</p><p class="ob-dim">' + (code === 'ended' ? 'The run finished, and its private browser went with it.' : code === 'closed' ? 'It has no page open right now.' : esc((b && b.error) || 'The picture stopped.')) + '</p>';
      setNote(''); state.page = null; paintBar(true); refreshLive();
      return;
    }
    if (state.mode === 'live') {
      if (code === 'handoff') { refreshLive(); return showHandoff(state.driver ? state.driver.agentId : (station().driver || {}).agentId); }
      // "closed" may be stale: the window was closed and has already been started again (by you or an agent). Ask the
      // station before giving up the picture — only a browser the station says is closed shows as closed.
      const why = code === 'closed' ? 'The browser is closed.' : ((b && b.error) || 'The picture stopped.');
      refreshLive().then(() => {
        if (!mounted() || state.mode !== 'live') return;
        const now = Date.now();
        state.liveRestarts = (state.liveRestarts || []).filter(t => now - t < 10000);
        if (station().open && state.liveRestarts.length < 3) { state.liveRestarts.push(now); startLive(); return; }
        state.driver = null;
        showEmpty(why);
      });
    }
  }

  // ---------- the address bar ----------
  async function go(text) {
    const raw = String(text || '').trim();
    if (!raw || !mounted()) return;
    const ui = state.ui;
    // the page on screen, retyped or untouched → just reload it
    if (state.mode === 'page' && state.target && raw === state.target.path) { loadPage('reloaded'); return; }
    // a typed address always wins: it supersedes a back/forward/reload (or an earlier address) still in flight
    const op = ++state.opSeq;
    state.busy = true; paintBar();
    setNote('Opening…');
    /* A SLOW START SHOWS ITS PICTURE (measured 2026-10-01 at ~90% CPU: switching to a Chrome window, the old browser
       took 10+ s to exit and the open answered after ~30 s — the window sat on a blank "Opening…"). While the open is
       in flight, ask the station each second, and as soon as it says the browser is up, show the live picture (the
       page loading in it); the note keeps saying "Opening…" until the open answers. */
    const early = setInterval(() => {
      if (op !== state.opSeq || !mounted()) { clearInterval(early); return; }
      refreshLive().then(() => {
        if (op === state.opSeq && mounted() && state.busy && station().open && state.mode !== 'live') {
          clearInterval(early);
          state.mode = 'live'; state.watch = null;
          startLive(); setNote('Opening…');
        }
      });
    }, 1000);
    const r = await postJson('/api/browser/view/open', { url: raw }).catch(() => ({ status: 0, body: {} }));
    clearInterval(early);
    if (op !== state.opSeq) return;
    state.busy = false;
    if (!mounted()) return;
    if (r.status !== 200 || !r.body.ok) {
      if (r.body && r.body.code === 'driving') {
        // say why nothing happened, put the real address back, and keep saying it (a status refresh must not bury it)
        const why = agentLabel(r.body.agentId) + ' is driving the browser right now. Wait for it to finish (or stop the run), then type your address.';
        try { ui.url.blur(); } catch (_) { /* focus is best-effort */ }
        refreshLive().then(() => { if (!mounted()) return; if (state.mode !== 'live') showLive(); paintBar(true); setNote(why); });
        setNote(why);
      } else setNote('Could not open that: ' + ((r.body && r.body.error) || 'the station did not answer') + '.');
      paintBar();
      return;
    }
    state.mode = 'live'; state.watch = null; state.driver = null;
    state.page = { url: r.body.url || '', title: '' };
    state.live.station = Object.assign({}, station(), { open: true, driver: null, handoff: false, remembered: !!r.body.remembered, visible: !!r.body.visible });
    try { ui.url.blur(); } catch (_) { /* focus is best-effort */ }
    startLive();
    try { ui.vp.focus(); } catch (_) { /* focus is best-effort */ }
    paintDoor();
  }
  async function liveNav(action) {
    if (state.mode !== 'live' || state.driver || state.busy) return;
    const op = ++state.opSeq;
    state.busy = true; paintBar();
    const r = await postJson('/api/browser/view/nav', { action }).catch(() => ({ status: 0, body: {} }));
    if (op !== state.opSeq) return;
    state.busy = false;
    if (r.status !== 200) setNote('Could not go ' + action + ': ' + ((r.body && r.body.error) || 'the station did not answer') + '.');
    paintBar();
  }
  function reload() {
    if (state.mode === 'page' && state.target) loadPage('reloaded');
    else if (state.mode === 'live') liveNav('reload');
  }
  function openOutside() {
    let url = '';
    if (state.mode === 'page' && state.target) url = pageUrl(state.target);
    else if ((state.mode === 'watch' || state.mode === 'live') && state.page && /^https?:/i.test(state.page.url || '')) url = state.page.url;
    if (!url) { notify('could not open that — the station may be unreachable'); return; }
    const core = tauriCore();
    if (core && core.invoke) { Promise.resolve(core.invoke('open_external_url', { url })).catch(() => notify('could not open your browser')); return; }
    let win = null;
    try { win = root.open(url, '_blank', 'noopener'); } catch (_) { win = null; }
    if (!win) notify('your browser blocked the new tab — allow popups for the station, then try again');
  }

  function setFollow(on) {
    state.follow = !!on;
    try { if (root.localStorage) root.localStorage.setItem(FOLLOW_KEY, state.follow ? '1' : '0'); } catch (_) { /* a private window has no storage: FOLLOW just isn't remembered */ }
    paintBar();
  }

  // ---------- station truth: is the browser open, and who is driving ----------
  function refreshLive() {
    return getJson('/api/browser/view').then(r => {
      if (r.status !== 200 || !r.body || !r.body.ok) return;
      const wasRun = station().driver ? station().driver.runId : '';
      state.live = { agents: Array.isArray(r.body.agents) ? r.body.agents : [], station: r.body.station || NO_STATION };
      const first = !state.liveLoaded; state.liveLoaded = true;
      const st = station();
      const started = !!(st.driver && st.driver.runId !== wasRun);   // an agent just took the browser
      if (st.driver && st.driver.signIn) {
        stopSignInWatch();
        if (state.signInShownFor !== st.driver.runId) { state.signInShownFor = st.driver.runId; showLive(); }   // you sign in here
      }
      if (st.driver && state.mode === 'live' && mounted()) setDriver(st.driver);   // e.g. a sign-in handed you the wheel
      paintDoor();
      if (mounted()) {
        const typing = root.document.activeElement === state.ui.url;
        if (state.mode === 'live') {
          if (st.handoff && st.driver) { if (state.ui.root.dataset.state !== 'ask') showHandoff(st.driver.agentId); }
          else if (st.open && (state.ui.root.dataset.state === 'ask' || !state.ui.liveStream || !state.ui.liveStream.active())) startLive();
          else setDriver(st.driver || null);
        } else if (started && !typing) {
          showLive();   // an open window is somebody asking to see: show the agent at work
        } else if (state.mode === 'watch' && state.watch) {
          const a = privateRun(state.watch.agentId);
          if (a && a.handoff && state.ui.root.dataset.state !== 'ask') showHandoff(state.watch.agentId);
          else if (a && !a.handoff && (state.ui.root.dataset.state === 'ask' || state.ui.root.dataset.state === 'ended')) { state.watch = { agentId: a.agentId, runId: a.runId, target: a.target }; startWatch(); }
        }
        paintStrip();
        // first-use browser download: keep the progress line moving until it is ready
        const su = st.setup;
        if (su && (su.state === 'downloading' || su.state === 'unpacking')) {
          if (state.mode === 'live') setNote(liveNote());
          if (state.setupTimer) clearTimeout(state.setupTimer);
          state.setupTimer = setTimeout(() => { state.setupTimer = null; refreshLive(); }, 1000);
        }
      } else if (state.follow && started && !first) {
        showLive(true);   // FOLLOW: the window opens by itself when an agent starts browsing (your typing stays put)
      }
    }).catch(() => { /* the station is unreachable: the door simply shows no lamp */ });
  }
  function scheduleLive() {
    clearTimeout(state.liveTimer);
    state.liveTimer = setTimeout(() => { state.liveTimer = null; refreshLive(); }, LIVE_DEBOUNCE_MS);
  }

  /* MINIMIZED is not closed (release review 2026-09-30): a minimized BROWSER window stays mounted, so the "show" paths
     used to do nothing visible — and its picture kept streaming, which also kept the station browser from idling out.
     Any show now restores it, and while it is minimized nothing streams. */
  function termEl() { return state.ui && state.ui.root && state.ui.root.closest ? state.ui.root.closest('.term') : null; }
  function isMinimized() { const w = termEl(); return !!(w && w.classList.contains('term-min-hidden')); }
  /* ONE CUE PER PRESS (Andrew 10-13: COMMS sounds like the bottom docks, once per press). The globe's press already
     played the docks' open() cue (audio.js → SFX.press); its window rises a beat later, after the awaited station
     read, outside open()'s 80 ms gate — so that rise would play the same sample a second time. When the press really
     sounded open() and this rise answers it (within a second), re-arm the gate so the press stays the only cue. */
  function quietDoorEcho() {
    const pressed = state.doorPressedAt; state.doorPressedAt = 0;
    if (!pressed || Date.now() - pressed > 1000) return;
    const sfx = typeof SFX === 'object' && SFX ? SFX : null;
    if (sfx && sfx._lastAt && sfx._lastAt.open >= pressed) sfx._lastAt.open = Date.now();
  }
  function openBrowserTerm() { quietDoorEcho(); StationUI.openTerm('browser'); }
  function restoreIfMinimized() { if (isMinimized() && typeof StationUI !== 'undefined' && StationUI.openTerm) openBrowserTerm(); }
  function watchMinimize() {
    const w = termEl();
    if (!w || typeof MutationObserver === 'undefined' || state.ui.minObs) return;
    state.ui.minObs = new MutationObserver(() => {
      const hidden = w.classList.contains('term-min-hidden');
      if (hidden && !state.minimized) { state.minimized = true; stopStreams(); }
      else if (!hidden && state.minimized) {
        state.minimized = false;
        if (state.mode === 'live') startLive(); else if (state.mode === 'watch' && state.watch) startWatch();
      }
    });
    state.ui.minObs.observe(w, { attributes: true, attributeFilter: ['class'] });
  }
  /* keepFocus: an open the Commander did not ask for (FOLLOW, an agent starting to browse) must not take the keyboard
     from wherever they are typing — COMMS above all. */
  function showWindow(keepFocus) {
    if (typeof StationUI === 'undefined' || !StationUI.openTerm) return false;
    if (mounted()) { restoreIfMinimized(); return true; }
    const doc = root.document;
    const prev = keepFocus && doc ? doc.activeElement : null;
    openBrowserTerm();
    if (prev && doc && prev !== doc.body && prev.isConnected && typeof prev.focus === 'function') { try { prev.focus({ preventScroll: true }); } catch (_) { /* focus is best-effort */ } }
    return mounted();
  }
  function showPage(t, cause, keepFocus) {
    remember(t);
    state.mode = 'page'; state.target = t; state.watch = null;
    if (mounted()) { loadPage(cause || 'opened'); restoreIfMinimized(); return true; }
    return showWindow(keepFocus);
  }
  function showWatch(a) {
    state.mode = 'watch'; state.watch = { agentId: a.agentId, runId: a.runId, target: a.target };
    if (mounted()) { restoreIfMinimized(); if (!isMinimized()) startWatch(); return true; }
    return showWindow();
  }
  function showLive(keepFocus) {
    state.mode = 'live'; state.watch = null;
    if (mounted()) { restoreIfMinimized(); if (!isMinimized()) startLive(); return true; }
    return showWindow(keepFocus);
  }

  // ---------- public ----------
  // Open a page in the window (the click path from COMMS, the LIBRARY, a workshop card, the desk screen).
  function open(target) {
    const t = normalizeTarget(target);
    if (!t) return false;
    return showPage(t, 'opened');
  }
  // The COMMS door: the browser if it is open (or an agent is driving it), else that agent's own private browser,
  // else the last page it made, else the address bar.
  async function openFor(agentId) {
    const aid = String(agentId || 'agent');
    await refreshLive();
    const st = station();
    if (st.open || st.driver) return showLive();
    const a = privateRun(aid);
    if (a) return showWatch(a);
    const last = state.recent.find(x => x.agentId === aid);
    if (last) return showPage(last, 'opened');
    if (!mounted()) { if (state.mode !== 'page' || !state.target) state.mode = 'empty'; showWindow(); }
    else if (state.mode === 'live') showEmpty();
    if (mounted() && state.mode === 'empty') { try { state.ui.url.focus(); } catch (_) { /* focus is best-effort */ } }
    return mounted();
  }
  // Every file an agent writes lands here (the hero run's stream and the channel bridge both call it; a burst of
  // writes collapses into one reload). Only kind:'file' carries a real workspace path.
  function noteOutput(ev) {
    if (!ev || ev.kind !== 'file' || !ev.title) return;
    const agentId = String(ev.agentId || 'agent');
    const path = norm(ev.title);
    const t = state.target;
    const onScreen = !!(state.mode === 'page' && t && t.source === 'workspace' && t.agentId === agentId && mounted());
    // ANOTHER page (not the one on screen): it joins the PAGES strip, and with FOLLOW on it takes the window
    if (HTML_RE.test(path) && !(onScreen && path === t.path)) {
      const nt = { agentId, path, source: 'workspace', runId: '' };
      remember(nt);
      if (state.follow && state.mode !== 'live') { showPage(nt, 'opened', true); return; }
      if (mounted()) paintStrip();
      return;
    }
    // the page on screen was rewritten, or a web asset under its folder was (its css, its js) → show the new bytes
    if (onScreen && feedsPage(path, t.path)) scheduleReload();
  }

  // ---------- the COMMS door ----------
  function lineAgent() {
    try { const sel = root.document.getElementById('comms-agent-select'); if (sel && sel.value) return String(sel.value); } catch (_) { /* no COMMS header */ }
    return 'agent';
  }
  function paintDoor() {
    const b = root.document && root.document.getElementById('comms-browser');
    if (!b) return;
    const aid = lineAgent(), name = agentLabel(aid), st = station(), a = privateRun(aid);
    const mine = !!(st.driver && st.driver.agentId === aid);
    const ask = (mine && st.handoff) || !!(a && a.handoff);
    b.classList.toggle('live', (mine || !!a) && !ask);
    b.classList.toggle('ask', ask);
    b.classList.toggle('open', !!st.open);
    const tip = ask ? name + ' needs you in the browser' : (mine || a) ? name + ' is using the browser: watch it' : st.driver ? agentLabel(st.driver.agentId) + ' is using the browser' : 'Browser';
    b.setAttribute('aria-label', tip);
    if (b.hasAttribute('data-tip')) b.setAttribute('data-tip', tip); else b.title = tip;
  }
  function mountDoor() {
    const doc = root.document; if (!doc) return false;
    const bar = doc.getElementById('comms-idbar');
    if (!bar || doc.getElementById('comms-browser')) return !!bar;
    const b = doc.createElement('button');
    b.type = 'button'; b.id = 'comms-browser'; b.className = 'comms-browser';
    b.innerHTML = icon('globe') + '<span class="cb-lamp" aria-hidden="true"></span>';
    b.addEventListener('click', () => {
      const at = state.doorPressedAt = Date.now();
      Promise.resolve(openFor(lineAgent())).finally(() => { if (state.doorPressedAt === at) state.doorPressedAt = 0; });
    });
    bar.appendChild(b);   // after the + (add agents): CSS `order` keeps + then globe whichever mounts first
    const sel = doc.getElementById('comms-agent-select');
    if (sel) sel.addEventListener('change', paintDoor);
    paintDoor();
    return true;
  }

  /* ---------- Settings → BROWSER ----------
     Where the station browser lives. Same button idiom as AUTONOMY (.set-themes / .set-theme / .sel), so no new
     chrome. The live line under it says what is RUNNING now, from the station — never just what was clicked. */
  const MODE_TEXT = {
    window: 'A real Chrome window on your desktop that you and your agents share. Sign in, type and paste in it like any browser; the BROWSER window follows it.',
    builtin: 'Hidden inside Agent OS: nothing opens on your desktop. The BROWSER window shows the page.',
    chrome: 'Your own Chrome, with your logins. Agents ask before acting on each site. Needs the Agent OS extension in your Chrome.'
  };
  function mountSettings(el, arrange) {
    el.innerHTML = '<p class="set-about" id="brw-desc">' + esc(MODE_TEXT.window) + '</p>'
      + '<div class="set-sub"><span class="set-sub-k">WHERE IT RUNS</span><span class="set-sub-d">for you and for your agents</span></div>'
      + '<div class="set-themes" id="brw-mode">'
      + '<button type="button" class="set-theme" data-mode="window" title="' + esc(MODE_TEXT.window) + '">CHROME WINDOW</button>'
      + '<button type="button" class="set-theme" data-mode="builtin" title="' + esc(MODE_TEXT.builtin) + '">BUILT-IN</button>'
      // YOUR CHROME (your own Chrome via the Agent OS extension) is not offered until that extension exists (release review)
      + '</div>'
      + '<p class="set-about dim" id="brw-state" role="status"></p>';
    if (typeof arrange === 'function') { try { arrange(el); } catch (_) { /* plain layout is fine */ } }
    const wrap = el.querySelector('#brw-mode'), desc = el.querySelector('#brw-desc'), stateLine = el.querySelector('#brw-state');
    let current = null;
    const paint = s => {
      current = s;
      wrap.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('sel', !!s && b.dataset.mode === s.mode));
      desc.textContent = MODE_TEXT[(s && s.mode) || 'window'];
      const lines = [];
      const fallback = s && s.effective === 'window' ? 'uses a Chrome window' : 'browses built-in';
      if (s && s.mode === 'chrome' && !s.chromeAvailable) lines.push('The Agent OS extension is not paired with your Chrome yet, so the station ' + fallback + ' until it is.');
      if (s && s.mode === 'window' && s.effective === 'builtin') lines.push('No Chrome window can open here (no screen, or no Chrome, Edge or Chromium installed), so the station browses built-in.');
      if (s && s.running && s.running !== s.effective) lines.push('The browser that is open now keeps its old mode until an agent finishes with it; it switches after that.');
      else if (s && s.running) lines.push('Running now: ' + (s.running === 'window' ? 'a Chrome window' : 'built-in') + '.');
      stateLine.textContent = lines.join(' ');
    };
    getJson('/api/browser/settings').then(r => { if (r.status === 200 && r.body && r.body.ok) paint(r.body); else stateLine.textContent = 'Could not read the browser setting from the station.'; }).catch(() => { stateLine.textContent = 'Could not read the browser setting from the station.'; });
    wrap.addEventListener('click', ev => {
      const b = ev.target && ev.target.closest ? ev.target.closest('[data-mode]') : null;
      if (!b || (current && current.mode === b.dataset.mode)) return;
      stateLine.textContent = 'Saving…';
      postJson('/api/browser/settings', { mode: b.dataset.mode }).then(r => {
        if (r.status === 200 && r.body && r.body.ok) { paint(r.body); refreshLive(); }
        else stateLine.textContent = 'Could not save: ' + ((r.body && r.body.error) || 'the station did not answer') + '.';
      }).catch(() => { stateLine.textContent = 'Could not save: the station did not answer.'; });
    });
  }

  function stopSignInWatch() { if (state.signInWatch) { clearInterval(state.signInWatch); state.signInWatch = null; } }
  function watchSignIn() {
    stopSignInWatch();
    let n = 0;
    state.signInWatch = setInterval(() => { if (++n > 600) stopSignInWatch(); else refreshLive(); }, 700);   // ≤7 min
  }

  let busWired = false;
  function init() {
    if (typeof StationUI !== 'undefined' && StationUI.registerWindow) {
      // Closing the window does NOT close the browser: it is the agents' too, and it closes itself when nobody has
      // driven or watched it for ten minutes.
      StationUI.registerWindow('browser', 'BROWSER', build, { wide: true, className: 'browser-win', onClose: () => { stopStreams(); if (state.ui && state.ui.minObs) state.ui.minObs.disconnect(); state.minimized = false; state.ui = null; } });
    }
    if (!busWired && typeof U !== 'undefined' && U.bus && U.bus.on) {
      busWired = true;
      U.bus.on('deliverable', p => { try { noteOutput(p); } catch (_) { /* a bad event never breaks the bus */ } });   // background (channel/routine) runs
      // who is driving changes when a run starts or ends, when an agent uses a browser tool, and around a handoff —
      // ask the station then (never poll, never guess from the event itself)
      U.bus.on('agent.tool_call', p => {
        if (!p || !/^browser[._]/.test(String(p.name || ''))) return;
        scheduleLive();
        /* a sign-in is for YOU: the browser shows itself when the sign-in actually starts on the shared browser —
           AFTER you approved it in COMMS (release review 2026-09-30: opening on the tool call popped the window before
           the question was answered, took the keyboard from COMMS, and stayed open on "driving" if you declined).
           Ask the station until the sign-in begins or the tool returns. */
        if (/^browser[._]login$/.test(String(p.name))) watchSignIn();
      });
      U.bus.on('agent.tool_result', p => {
        if (!p || !/^browser[._]/.test(String(p.name || ''))) return;
        if (/^browser[._]login$/.test(String(p.name))) stopSignInWatch();
        scheduleLive();
      });
      ['agent.run.start', 'agent.run.end', 'agent.run.error', 'browser.handoff'].forEach(n => U.bus.on(n, () => scheduleLive()));
    }
    if (root.document) {
      const boot = () => { if (!mountDoor()) return; refreshLive(); };
      if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
    }
  }

  const api = { open, openFor, noteOutput, setFollow, mountSettings, isFollowing: () => state.follow, isHtml: p => HTML_RE.test(String(p || '')), init,
    _state: state, _test: { norm, dirOf, jailRel, normalizeTarget, feedsPage } };
  root.OutputBrowser = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
