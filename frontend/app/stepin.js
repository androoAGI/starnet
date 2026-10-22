/* AGENT OS — stepin.js : STEP-IN, the Commander takes an agent's browser (2026-09-29).

   An agent browsing on its own hits a login, a 2FA code or a CAPTCHA and calls browser.need_human. Its run parks
   on the sidecar's handoff host (own id, own 30-minute wait) and a `browser.handoff` event arrives here over the
   station SSE bridge. This window shows THAT agent's live browser — the same headless Chrome, the same page — as
   a streamed picture, and forwards the Commander's pointer, keys and paste into it. HAND BACK resumes the agent on
   the page they left it on; CAN'T DO IT tells it to take another route.

   TRUTH (the product's core law): every state painted here is a sidecar record (GET /api/browser/handoffs, or the
   browser.handoff event that carries the same record). "Waiting for you" shows only while the handoff is live; a
   settled one says how it ended. The countdown reads the record's own expiresAt. "Remembered" is the record's
   `remembered` flag (is this run on the durable station profile?) — never a guess.

   SECRECY. Keys and pastes go page → sidecar → Chrome and nowhere else: nothing typed here is stored, logged or
   shown to the agent, and the agent is frozen (its browser tools are refused) until the handoff settles.

   SHAPE. A registered station window ('stepin'): it rises from the bottom dock between CREW and COMMS, resizes and
   minimizes like every other window. The view itself is StepIn.mount(host) → unmount(), so it can later live inside
   another window (the OUTPUT browser lane) without a rewrite. Glass recipes only; matte, no glow. */
'use strict';

const StepIn = (() => {
  const REASON = { login: 'SIGN-IN', '2fa': '2FA CODE', captcha: 'HUMAN CHECK', payment: 'PAYMENT', other: 'NEEDS YOU' };
  const ENDED = { returned: 'HANDED BACK', cancelled: 'YOU COULDN\'T', expired: 'EXPIRED — NOBODY CAME', aborted: 'RUN STOPPED' };
  const MOVE_MS = 50;
  let live = [];          // live handoff records (sidecar truth)
  let recent = [];        // settled records, newest first
  let signins = { profile: false, inUse: false, sites: [] };
  let loaded = false, loading = null;
  let focusId = '';       // the handoff the view shows
  const seen = new Set(); // handoff ids already announced (one toast per handoff)
  let view = null;        // the mounted view { host, … } or null

  const base = () => (typeof window !== 'undefined' ? String(window.__STARNET_API__ || '') : '');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function getJson(path, signal) {
    return fetch(base() + path, { cache: 'no-store', signal }).then(async r => { let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, body: j || {} }; });
  }
  function postJson(path, body) {
    return fetch(base() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(async r => { let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, body: j || {} }; });
  }
  function agentName(aid) {
    try {
      const list = (typeof StationUI !== 'undefined' && StationUI.h) ? StationUI.h.present : [];
      const a = (list || []).find(x => x && x.id === aid);
      return String((a && a.name) || aid || 'AGENT').toUpperCase();
    } catch (_) { return String(aid || 'AGENT').toUpperCase(); }
  }
  function focused() { return live.find(h => h.id === focusId) || live[0] || null; }

  /* ---------------- state (sidecar truth) ---------------- */
  function upsert(p) {
    if (!p || !p.id) return;
    const ended = p.state && ENDED[p.state];
    live = live.filter(h => h.id !== p.id);
    recent = recent.filter(h => h.id !== p.id);
    if (ended) { recent.unshift(p); recent = recent.slice(0, 8); settle(p.id); } else live.push(p);
  }
  // the hand-back (or a cancel) ends the wait: the bell's STEP-IN line leaves NEEDS YOU (it stayed lit for good)
  function settle(id) { if (typeof StationUI !== 'undefined' && StationUI.settleNotifs) StationUI.settleNotifs('stepin-' + id); }
  function refresh() {
    if (loading) return loading;
    loading = getJson('/api/browser/handoffs').then(r => {
      if (r.status === 200 && r.body && r.body.ok) {
        live = Array.isArray(r.body.live) ? r.body.live : [];
        recent = Array.isArray(r.body.recent) ? r.body.recent : [];
        for (const h of recent) if (h && h.id) settle(h.id);   // ended while this page was away (or before a restart)
        // …or gone from the station altogether (a restart drops its handoffs): a line for a handoff that is not live any more waits on nothing
        if (typeof StationUI !== 'undefined' && StationUI.waitingNotifKeys) for (const k of StationUI.waitingNotifKeys('stepin-')) if (!live.some(h => 'stepin-' + h.id === k)) StationUI.settleNotifs(k);
        signins = r.body.signins || signins;
        for (const h of live) seen.add(h.id);
        loaded = true;
      }
    }).catch(() => {}).then(() => { loading = null; badge(); paint(); });
    return loading;
  }
  function onEvent(p) {
    if (!p || !p.id) return;
    const isNew = p.state === 'waiting' && !seen.has(p.id);
    seen.add(p.id);
    upsert(p);
    if (isNew) announce(p);
    if (p.state === 'returned' || p.state === 'cancelled') refreshSignins();
    badge(); paint();
  }
  function refreshSignins() {
    getJson('/api/browser/signins').then(r => { if (r.status === 200 && r.body) { signins = r.body; paint(); } }).catch(() => {});
  }
  function announce(p) {
    if (typeof StationUI === 'undefined' || !StationUI.notify) return;
    const why = { login: 'sign in', '2fa': 'enter a sign-in code', captcha: 'get past a human check', payment: 'confirm a payment', other: 'help with a page' }[p.reason] || 'help with a page';
    StationUI.notify('STEP-IN: ' + agentName(p.agentId) + ' needs you to ' + why + (p.where ? ' at ' + p.where : '') + ' — click to take its browser', 'gold', undefined, {
      key: 'stepin-' + p.id, kind: 'needs', go: { term: 'stepin' },   // a destination, so the bell's line is a door too
      onClick: () => open(p.id)
    });
  }
  function badge() {
    if (typeof document === 'undefined') return;
    const n = live.length;
    const b = document.getElementById('si-badge');
    if (b) { b.textContent = n ? String(n) : ''; b.style.display = n ? 'inline-block' : 'none'; }
    const g = document.getElementById('bb-crew-stepin-badge');
    if (g) { g.hidden = !n; g.textContent = n ? String(n) : ''; }
    // the CREW dock carries STEP-IN only while an agent is actually waiting for you (Andrew 10-02: no standing button)
    const item = document.querySelector('#bottombar .bb[data-term="stepin"]');
    if (item && item.hidden === !!n) item.hidden = !n;
    // STATION SYSTEMS: an agent waiting for you is the moment STEP-IN joins a growing dock
    if (n && typeof Systems !== 'undefined' && Systems.growTo) Systems.growTo(['stepin']);
  }

  /* ---------------- the view ---------------- */
  function open(id) {
    if (id) focusId = String(id);
    if (typeof StationUI === 'undefined' || !StationUI.openTerm) return;
    StationUI.openTerm('stepin');
    if (view) paint();
  }

  function mount(host) {
    unmount();
    host.innerHTML = '<div class="si-root">'
      + '<div class="si-strip"><span class="si-lamp" aria-hidden="true"></span><span class="si-name"></span><span class="si-st"></span><span class="si-clock"></span></div>'
      + '<div class="si-tabs" hidden></div>'
      // the hands sit ABOVE the picture, beside the agent's ask: HAND BACK must never scroll out of a short window
      + '<div class="si-head"><p class="si-ask"></p>'
      +   '<div class="si-foot">'
      +     '<button type="button" class="bb si-take" hidden>TAKE THE WHEEL</button>'
      +     '<button type="button" class="bb si-back" hidden>HAND BACK</button>'
      +     '<button type="button" class="bb sm si-cancel" hidden>CAN\'T DO IT</button>'
      +   '</div>'
      + '</div>'
      + '<p class="si-note" role="status"></p>'
      + '<div class="si-screen" data-mode="none">'
      +   '<div class="si-view" tabindex="0" aria-label="The agent\'s browser. Click to drive it; your keys go to the page." hidden><img class="si-img" alt="Live view of the agent\'s browser" draggable="false"></div>'
      +   '<div class="si-off"><span class="si-off-h"></span><small class="si-off-s"></small></div>'
      + '</div>'
      + '<p class="si-keep"></p>'
      + '<details class="si-more"><summary>SAVED SIGN-INS &amp; HISTORY</summary><div class="si-hist"></div><div class="si-saved"></div></details>'
      + '</div>';
    const q = s => host.querySelector(s);
    view = { host, root: q('.si-root'), img: q('.si-img'), vp: q('.si-view'), frame: null, seq: 0, streamId: '', abort: null, pending: [], inflight: false, moveAt: 0, moveTimer: 0, clockTimer: 0, note: '' };
    wireInput(view);
    q('.si-take').addEventListener('click', () => act('take'));
    q('.si-back').addEventListener('click', () => act('back'));
    const cancelBtn = q('.si-cancel');
    if (typeof ArmConfirm !== 'undefined' && ArmConfirm.wire) ArmConfirm.wire(cancelBtn, { armedLabel: 'CAN\'T DO IT — SURE?', onConfirm: () => act('cancel') });
    else cancelBtn.addEventListener('click', () => act('cancel'));
    q('.si-tabs').addEventListener('click', e => { const b = e.target.closest('button[data-id]'); if (!b) return; focusId = b.getAttribute('data-id'); stopStream(); paint(); });
    view.clockTimer = setInterval(() => { if (!view || !view.host.isConnected) { unmount(); return; } paintClock(); }, 1000);
    if (!loaded) refresh(); else { refreshSignins(); paint(); }
    return unmount;
  }
  function unmount() {
    if (!view) return;
    stopStream();
    if (view.clockTimer) clearInterval(view.clockTimer);
    if (view.moveTimer) clearTimeout(view.moveTimer);
    view = null;
  }

  async function act(kind) {
    const h = focused(); if (!h || !view) return;
    const v = view;
    say(kind === 'take' ? 'Taking the wheel…' : kind === 'back' ? 'Handing back…' : 'Telling the agent…');
    const r = await postJson('/api/browser/handoff/' + kind, { id: h.id }).catch(() => ({ status: 0, body: {} }));
    if (v !== view) return;
    const b = r.body || {};
    if (b.view) upsert(b.view);
    if (kind === 'take') {
      if (!b.ok) say(b.error || 'The station could not hand you this browser.');
      else { say(''); try { v.vp.focus(); } catch (_) {} }
    } else if (r.status === 200) say(kind === 'back' ? 'Handed back. ' + agentName(h.agentId) + ' is carrying on.' : 'Told ' + agentName(h.agentId) + ' to take another route.');
    else say(b.error || 'That handoff had already ended.');
    badge(); paint();
  }
  function say(t) { if (view) { view.note = String(t || ''); const n = view.host.querySelector('.si-note'); if (n) n.textContent = view.note; } }

  function fmtLeft(ms) {
    if (!(ms > 0)) return 'expiring';
    const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
    return m >= 1 ? m + ' min left' : s + ' s left';
  }
  function paintClock() {
    if (!view) return;
    const h = focused(); const c = view.host.querySelector('.si-clock');
    if (c) c.textContent = h && h.expiresAt ? fmtLeft(h.expiresAt - Date.now()) : '';
  }

  function paint() {
    if (!view || !view.host.isConnected) { if (view) unmount(); return; }
    const q = s => view.host.querySelector(s);
    const h = focused();
    if (h && h.id !== focusId) focusId = h.id;
    const root = view.root;
    const tabs = q('.si-tabs');
    tabs.hidden = live.length < 2;
    tabs.innerHTML = live.length < 2 ? '' : live.map(x => '<button type="button" class="bb sm' + (h && x.id === h.id ? ' on' : '') + '" data-id="' + esc(x.id) + '">' + esc(agentName(x.agentId)) + ' · ' + esc(x.host || '') + '</button>').join('');
    const take = q('.si-take'), back = q('.si-back'), cancel = q('.si-cancel');
    if (!h) {
      const last = recent[0];
      root.setAttribute('data-state', last ? 'ended' : 'idle');
      q('.si-name').textContent = last ? agentName(last.agentId) : 'STEP-IN';
      q('.si-st').textContent = last ? (ENDED[last.state] || last.state.toUpperCase()) : 'NO AGENT NEEDS YOU';
      q('.si-ask').textContent = last && last.note ? '“' + last.note + '”' : '';
      q('.si-screen').setAttribute('data-mode', 'off');
      view.vp.hidden = true;
      q('.si-off-h').textContent = last ? (ENDED[last.state] || 'ENDED') : 'NOTHING TO TAKE';
      q('.si-off-s').textContent = last
        ? (last.state === 'returned' ? 'You handed the browser back' + (last.where ? ' at ' + last.where : '') + '. The agent carried on from there.'
          : last.state === 'expired' ? 'Nobody took the browser within 30 minutes, so the agent was told nobody came.'
          : last.state === 'cancelled' ? 'You said you couldn\'t do it, so the agent was told to take another route.'
          : 'The run stopped while it was waiting, so there is nothing to hand back.')
        : 'When an agent hits a sign-in, a 2FA code or a human check, it asks for you here. You drive its own browser, then hand it back.';
      take.hidden = back.hidden = cancel.hidden = true;
      q('.si-keep').textContent = '';
      stopStream();
    } else {
      const taken = h.state === 'taken';
      root.setAttribute('data-state', h.state);
      q('.si-name').textContent = agentName(h.agentId);
      q('.si-st').textContent = (taken ? 'YOU HAVE THE WHEEL' : 'WAITING FOR YOU') + ' · ' + (REASON[h.reason] || 'NEEDS YOU') + (h.where ? ' · ' + h.where : '');
      q('.si-ask').textContent = h.note ? '“' + h.note + '”' : '';
      take.hidden = taken; back.hidden = !taken; cancel.hidden = false;
      // said before you take the wheel; while you drive, the picture gets the room (the line would only repeat)
      q('.si-keep').textContent = taken ? '' : (h.remembered
        ? 'This browser keeps its sign-ins: later runs start signed in. SAVED SIGN-INS below can forget them.'
        : 'This run\'s browser is temporary: a sign-in here lasts only until the run ends.');
      if (taken) {
        q('.si-screen').setAttribute('data-mode', 'live');
        view.vp.hidden = false;
        if (view.streamId !== h.id) startStream(h.id);
      } else {
        stopStream();
        q('.si-screen').setAttribute('data-mode', 'off');
        view.vp.hidden = true;
        q('.si-off-h').textContent = agentName(h.agentId) + ' IS PAUSED' + (h.where ? ' ON ' + h.where.toUpperCase() : '');
        q('.si-off-s').textContent = 'Take the wheel to drive its browser yourself. It is frozen until you hand it back, and it never sees what you type. It never solves a human check on its own.';
      }
    }
    paintClock();
    paintMore(q('.si-hist'), q('.si-saved'));
    if (q('.si-note').textContent !== view.note) q('.si-note').textContent = view.note;
  }

  function paintMore(hist, saved) {
    const rel = t => { if (!t) return ''; const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago'; };
    hist.innerHTML = recent.length
      ? '<h4 class="si-h">RECENT HANDOFFS</h4><ul class="si-list">' + recent.slice(0, 6).map(r => '<li><b>' + esc(agentName(r.agentId)) + '</b> · ' + esc(r.where || r.host || 'a page') + ' · <span class="si-end" data-s="' + esc(r.state) + '">' + esc(ENDED[r.state] || r.state) + '</span> <small>' + esc(rel(r.endedAt)) + '</small></li>').join('') + '</ul>'
      : '';
    const sites = (signins && signins.sites) || [];
    const sig = JSON.stringify([signins.profile, signins.inUse, sites.map(s => s.host + s.at)]);
    if (saved.getAttribute('data-sig') === sig) return;   // never rebuild an armed FORGET button under the pointer
    saved.setAttribute('data-sig', sig);
    saved.innerHTML = '<h4 class="si-h">SAVED SIGN-INS</h4>'
      + (sites.length
        ? '<ul class="si-list">' + sites.map(s => '<li><b>' + esc(s.host) + '</b> <small>signed in for ' + esc(agentName(s.agentId)) + ' · ' + esc(rel(s.at)) + '</small></li>').join('') + '</ul>'
          + '<p class="si-dim">Sites you signed in to through STEP-IN. A site can still sign the browser out on its own.</p>'
        : '<p class="si-dim">' + (signins.profile ? 'The station browser has a saved profile, but no STEP-IN sign-ins are recorded in it.' : 'No saved sign-ins. The station browser profile is empty.') + '</p>')
      + (signins.profile ? '<button type="button" class="bb sm si-forget"' + (signins.inUse ? ' disabled' : '') + '>FORGET ALL SIGN-INS</button>'
        + (signins.inUse ? '<p class="si-dim">A run is using the station browser right now. Forget works once it finishes.</p>' : '') : '');
    const f = saved.querySelector('.si-forget');
    if (f && typeof ArmConfirm !== 'undefined' && ArmConfirm.wire) {
      ArmConfirm.wire(f, { armedLabel: 'FORGET EVERY SIGN-IN — SURE?', onConfirm: async () => {
        const r = await postJson('/api/browser/signins/forget', {}).catch(() => ({ status: 0, body: {} }));
        const b = r.body || {};
        signins = { profile: !!b.profile, inUse: !!b.inUse, sites: Array.isArray(b.sites) ? b.sites : [] };
        say(b.ok ? 'Every saved sign-in is gone. Agents will browse signed out.' : (b.error || 'Could not forget the sign-ins.'));
        paint();
      } });
    }
  }

  /* ---------------- the live picture ---------------- */
  function startStream(id) {
    stopStream();
    if (!view) return;
    const v = view;
    v.streamId = id; v.seq = 0;
    const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    v.abort = ctl;
    (async () => {
      let fails = 0;
      while (view === v && v.streamId === id) {
        let r;
        try { r = await getJson('/api/browser/handoff/frame?id=' + encodeURIComponent(id) + '&after=' + v.seq, ctl && ctl.signal); }
        catch (_) { if (view !== v || v.streamId !== id) return; if (++fails > 5) { say('Lost the picture from the station.'); return; } await new Promise(res => setTimeout(res, 400 * fails)); continue; }
        fails = 0;
        if (view !== v || v.streamId !== id) return;
        if (r.status !== 200 || !r.body || !r.body.ok) {
          if (r.body && r.body.view) { upsert(r.body.view); badge(); }
          v.streamId = '';
          paint();
          return;
        }
        const f = r.body.frame;
        if (f && f.data) {
          v.seq = f.seq;
          v.frame = { width: f.width || 1440, height: f.height || 900 };
          v.img.src = 'data:' + (f.mime || 'image/jpeg') + ';base64,' + f.data;
          v.img.setAttribute('data-seq', String(f.seq));
        }
      }
    })();
  }
  function stopStream() {
    if (!view) return;
    if (view.abort) { try { view.abort.abort(); } catch (_) {} }
    view.abort = null; view.streamId = '';
  }

  /* ---------------- the Commander's hands ---------------- */
  function send(v, ev) {
    const h = focused();
    if (!h || h.state !== 'taken' || v !== view) return;
    v.pending.push(ev);
    flush(v, h.id);
  }
  async function flush(v, id) {
    if (v.inflight || !v.pending.length) return;
    v.inflight = true;
    while (v.pending.length && v === view) {
      const batch = v.pending.splice(0, 48);
      const r = await postJson('/api/browser/handoff/input', { id, events: batch }).catch(() => ({ status: 0, body: {} }));
      if (r.status !== 200) { v.pending.length = 0; if (r.status === 409 || r.status === 404) refresh(); break; }
    }
    v.inflight = false;
  }
  function pagePoint(v, e) {
    const img = v.img, f = v.frame;
    if (!f) return null;
    const r = img.getBoundingClientRect();
    // object-fit: contain — the picture is letterboxed inside the element by ITS OWN pixel aspect; map through the
    // drawn box, then into the page's CSS viewport (f.width x f.height), which is the space Input.* speaks.
    const nw = img.naturalWidth || f.width, nh = img.naturalHeight || f.height;
    const scale = Math.min(r.width / nw, r.height / nh);
    if (!(scale > 0)) return null;
    const dw = nw * scale, dh = nh * scale;
    const ox = r.left + (r.width - dw) / 2, oy = r.top + (r.height - dh) / 2;
    const fx = (e.clientX - ox) / dw, fy = (e.clientY - oy) / dh;
    if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return null;
    return { x: Math.round(fx * f.width), y: Math.round(fy * f.height) };
  }
  const mods = e => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  const BTN = ['left', 'middle', 'right'];
  function wireInput(v) {
    const vp = v.vp, img = v.img;
    img.addEventListener('mousedown', e => {
      const p = pagePoint(v, e); if (!p) return;
      e.preventDefault(); try { vp.focus(); } catch (_) {}
      send(v, { type: 'mouse', action: 'move', x: p.x, y: p.y });
      send(v, { type: 'mouse', action: 'down', x: p.x, y: p.y, button: BTN[e.button] || 'left', clickCount: Math.min(3, e.detail || 1), modifiers: mods(e) });
    });
    img.addEventListener('mouseup', e => {
      const p = pagePoint(v, e); if (!p) return;
      e.preventDefault();
      send(v, { type: 'mouse', action: 'up', x: p.x, y: p.y, button: BTN[e.button] || 'left', clickCount: Math.min(3, e.detail || 1), modifiers: mods(e) });
    });
    img.addEventListener('mousemove', e => {
      const p = pagePoint(v, e); if (!p) return;
      v.lastMove = { x: p.x, y: p.y, button: (e.buttons & 1) ? 'left' : 'none', modifiers: mods(e) };
      const due = v.moveAt + MOVE_MS - Date.now();
      if (due <= 0) { v.moveAt = Date.now(); send(v, Object.assign({ type: 'mouse', action: 'move' }, v.lastMove)); }
      else if (!v.moveTimer) v.moveTimer = setTimeout(() => { v.moveTimer = 0; v.moveAt = Date.now(); if (v.lastMove) send(v, Object.assign({ type: 'mouse', action: 'move' }, v.lastMove)); }, due);
    });
    img.addEventListener('contextmenu', e => e.preventDefault());
    img.addEventListener('wheel', e => {
      const p = pagePoint(v, e); if (!p) return;
      e.preventDefault();
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      send(v, { type: 'wheel', x: p.x, y: p.y, dx: e.deltaX * k, dy: e.deltaY * k, modifiers: mods(e) });
    }, { passive: false });
    vp.addEventListener('keydown', e => {
      // Everything typed here belongs to the page, not the station (no station hotkeys, no COMMS).
      e.stopPropagation();
      // Paste arrives as its own event with the text; the chord itself must not also paste the headless clipboard.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) return;
      e.preventDefault();
      // AltGr (@ { € on German/French keyboards) arrives as Ctrl+Alt on Windows: it is text, not a shortcut
      // macOS Option makes characters too (Option+L = @ on a German Mac): composed characters are text, not shortcuts
      const ag = !!(e.getModifierState && e.getModifierState('AltGraph')) || !!(e.altKey && !e.metaKey && e.key && e.key.length === 1 && !/^[a-z0-9]$/i.test(e.key));
      const printable = e.key && e.key.length === 1 && (ag || (!e.ctrlKey && !e.metaKey));
      const ev = { type: 'key', action: 'down', key: e.key, code: e.code, keyCode: e.keyCode || 0, modifiers: ag ? (mods(e) & ~3) : mods(e) };
      if (printable) ev.text = e.key;
      else if (e.key === 'Enter') ev.text = '\r';
      send(v, ev);
    });
    vp.addEventListener('keyup', e => {
      e.stopPropagation();
      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) return;
      e.preventDefault();
      send(v, { type: 'key', action: 'up', key: e.key, code: e.code, keyCode: e.keyCode || 0, modifiers: mods(e) });
    });
    vp.addEventListener('paste', e => {
      e.preventDefault(); e.stopPropagation();
      const t = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
      if (t) send(v, { type: 'text', text: t.slice(0, 4000) });
    });
  }

  /* ---------------- boot ---------------- */
  // Registration + bus wiring happen at parse time (this file loads after stationui.js, like windows/*.js); the
  // first sidecar read waits for the DOM so the harness's token-bearing fetch is in place.
  function init() {
    if (typeof U !== 'undefined' && U.bus && U.bus.on) U.bus.on('browser.handoff', onEvent);
    if (typeof StationUI !== 'undefined' && StationUI.registerWindow) {
      StationUI.registerWindow('stepin', 'STEP-IN — TAKE THE AGENT\'S BROWSER', body => mount(body), { className: 'stepin-win', onClose: () => {
        // Closing the window while you hold the wheel is a hand back (the plan's rule): the agent must never sit
        // frozen behind a window nobody can see.
        const h = focused();
        if (h && h.state === 'taken') postJson('/api/browser/handoff/back', { id: h.id }).then(r => { if (r.body && r.body.view) upsert(r.body.view); badge(); }).catch(() => {});
        unmount();
      } });
    }
  }
  if (typeof window !== 'undefined') {
    init();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => refresh(), { once: true });
    else refresh();
  }

  // live(): the handoffs waiting on / held by the Commander right now (a copy) — the public read other windows use
  // (the DESK SCREEN banner), so nobody has to reach into _state().
  return { mount, unmount, open, refresh, live: () => live.slice(), _state: () => ({ live: live.slice(), recent: recent.slice(), signins, focusId, streaming: !!(view && view.streamId), seq: view ? view.seq : 0 }) };
})();
if (typeof window !== 'undefined') window.StepIn = StepIn;
