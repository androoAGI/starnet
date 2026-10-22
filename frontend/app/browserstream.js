/* AGENT OS — browserstream.js : one live picture of a real browser, and (optionally) your hands on it.

   The BROWSER window shows two streamed browsers — an agent's (view only) and the Commander's own (driven) — and
   both are the same thing on the wire: a long-polled JPEG of the page plus, when allowed, mouse/keyboard events
   sent back in the page's CSS pixel space. This module is that one thing. The picture/pointer maths is the same
   as STEP-IN's (frontend/app/stepin.js), measured there against real Chromium: the frame is letterboxed by ITS OWN
   pixel aspect (object-fit: contain), and a click maps through the drawn box into the page viewport the frame
   reports (width x height) — the space CDP Input.* speaks.

   create({ vp, img, poll, send, onPage, onEnd }) → { start(), stop(), active() }
     vp    the focusable viewport element (keyboard + paste land here)
     img   the <img> the picture is painted into
     poll  (afterSeq, signal) → Promise<{ status, body }>   body: { ok, frame:{seq,mime,width,height,data}|null, page }
     send  (events[]) → Promise<{ status }>   omit for a VIEW-ONLY picture: nothing is ever sent
     onPage(page)   the page's { url, title } whenever a poll reports it
     onEnd(body)    the stream ended on its own (the station said no): body carries { code, error } */
'use strict';
(function (root) {
  const MOVE_MS = 50;
  const BTN = ['left', 'middle', 'right'];
  const mods = e => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  /* COMPOSED CHARACTERS are TEXT, not shortcuts: AltGr (German/French/Nordic @ { } [ ] € …) reaches the page as
     Ctrl+Alt on Windows, and macOS Option makes characters too (Option+L = @ on a German Mac, å, ß, ©). Without this
     those characters never arrived and an email address could not be typed (release review 2026-09-30). A real
     Ctrl+Alt+letter / Option+letter shortcut gives the plain letter itself, so it stays a key. */
  const altGr = e => !!(e.getModifierState && e.getModifierState('AltGraph'))
    || !!(e.altKey && !e.metaKey && e.key && e.key.length === 1 && !/^[a-z0-9]$/i.test(e.key));
  const keyDown = e => {
    const ag = altGr(e);
    const printable = !!(e.key && e.key.length === 1 && (ag || (!e.ctrlKey && !e.metaKey)));
    const ev = { type: 'key', action: 'down', key: e.key, code: e.code, keyCode: e.keyCode || 0, modifiers: ag ? (mods(e) & ~3) : mods(e) };
    if (printable) ev.text = e.key; else if (e.key === 'Enter') ev.text = '\r';
    return ev;
  };

  function create(opts) {
    const vp = opts.vp, img = opts.img;
    const canSend = typeof opts.send === 'function';
    const s = { on: false, gen: 0, seq: 0, frame: null, abort: null, pending: [], inflight: false, lastMove: null, moveAt: 0, moveTimer: 0 };

    async function loop(gen) {
      let fails = 0;
      while (s.on && gen === s.gen) {
        let r;
        try { r = await opts.poll(s.seq, s.abort && s.abort.signal); }
        catch (_) {
          if (!s.on || gen !== s.gen) return;
          if (++fails > 5) { stop(); if (opts.onEnd) opts.onEnd({ code: 'lost', error: 'Lost the picture from the station.' }); return; }
          await new Promise(res => setTimeout(res, 400 * fails));
          continue;
        }
        fails = 0;
        if (!s.on || gen !== s.gen) return;
        if (r.status !== 200 || !r.body || !r.body.ok) { stop(); if (opts.onEnd) opts.onEnd(r.body || { code: 'lost', error: 'The station stopped answering.' }); return; }
        if (r.body.page && opts.onPage) opts.onPage(r.body.page);
        const f = r.body.frame;
        if (f && f.data) {
          s.seq = f.seq;
          s.frame = { width: f.width || 1440, height: f.height || 900 };
          img.src = 'data:' + (f.mime || 'image/jpeg') + ';base64,' + f.data;
          img.setAttribute('data-seq', String(f.seq));
        }
      }
    }
    function start() {
      stop();
      s.on = true; s.seq = 0; s.frame = null; s.pending.length = 0;
      s.abort = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      loop(++s.gen);
    }
    function stop() {
      s.on = false; s.gen++;
      if (s.abort) { try { s.abort.abort(); } catch (_) { /* already settled */ } }
      s.abort = null; s.pending.length = 0;
      if (s.moveTimer) { clearTimeout(s.moveTimer); s.moveTimer = 0; }
    }

    // ---- hands (only when a send function was given) ----
    function push(ev) { if (!canSend || !s.on) return; s.pending.push(ev); flush(); }
    async function flush() {
      if (s.inflight || !s.pending.length) return;
      s.inflight = true;
      const gen = s.gen;
      while (s.pending.length && s.on && gen === s.gen) {
        const batch = s.pending.splice(0, 48);
        let r; try { r = await opts.send(batch); } catch (_) { r = { status: 0 }; }
        if (!r || r.status !== 200) { s.pending.length = 0; break; }
      }
      s.inflight = false;
    }
    function pagePoint(e) {
      const f = s.frame; if (!f) return null;
      const r = img.getBoundingClientRect();
      const nw = img.naturalWidth || f.width, nh = img.naturalHeight || f.height;
      const scale = Math.min(r.width / nw, r.height / nh);
      if (!(scale > 0)) return null;
      const dw = nw * scale, dh = nh * scale;
      const ox = r.left + (r.width - dw) / 2, oy = r.top + (r.height - dh) / 2;
      const fx = (e.clientX - ox) / dw, fy = (e.clientY - oy) / dh;
      if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return null;
      return { x: Math.round(fx * f.width), y: Math.round(fy * f.height) };
    }
    if (canSend) {
      img.addEventListener('mousedown', e => {
        const p = pagePoint(e); if (!p || !s.on) return;
        e.preventDefault(); try { vp.focus(); } catch (_) { /* focus is best-effort */ }
        push({ type: 'mouse', action: 'move', x: p.x, y: p.y });
        push({ type: 'mouse', action: 'down', x: p.x, y: p.y, button: BTN[e.button] || 'left', clickCount: Math.min(3, e.detail || 1), modifiers: mods(e) });
      });
      img.addEventListener('mouseup', e => {
        const p = pagePoint(e); if (!p || !s.on) return;
        e.preventDefault();
        push({ type: 'mouse', action: 'up', x: p.x, y: p.y, button: BTN[e.button] || 'left', clickCount: Math.min(3, e.detail || 1), modifiers: mods(e) });
      });
      img.addEventListener('mousemove', e => {
        const p = pagePoint(e); if (!p || !s.on) return;
        s.lastMove = { x: p.x, y: p.y, button: (e.buttons & 1) ? 'left' : 'none', modifiers: mods(e) };
        const due = s.moveAt + MOVE_MS - Date.now();
        if (due <= 0) { s.moveAt = Date.now(); push(Object.assign({ type: 'mouse', action: 'move' }, s.lastMove)); }
        else if (!s.moveTimer) s.moveTimer = setTimeout(() => { s.moveTimer = 0; s.moveAt = Date.now(); if (s.lastMove) push(Object.assign({ type: 'mouse', action: 'move' }, s.lastMove)); }, due);
      });
      img.addEventListener('contextmenu', e => e.preventDefault());
      img.addEventListener('wheel', e => {
        const p = pagePoint(e); if (!p || !s.on) return;
        e.preventDefault();
        const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
        push({ type: 'wheel', x: p.x, y: p.y, dx: e.deltaX * k, dy: e.deltaY * k, modifiers: mods(e) });
      }, { passive: false });
      /* NO KEYBOARD TRAP (release review 2026-09-30): keys are taken for the page only while you can actually type in
         it (opts.canType — not while an agent drives and every key would be refused anyway), so Tab and Esc move on as
         everywhere else in the station. And F6 / Ctrl+L always leave the page for the address bar, like any browser. */
      const typing = () => s.on && (typeof opts.canType !== 'function' || !!opts.canType());
      vp.addEventListener('keydown', e => {
        if ((e.key === 'F6' || ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L'))) && typeof opts.onLeave === 'function') {
          e.preventDefault(); e.stopPropagation(); opts.onLeave(); return;
        }
        if (!typing()) return;
        e.stopPropagation();   // everything typed here belongs to the page, not the station (no hotkeys, no COMMS)
        if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) return;   // paste arrives as its own event
        e.preventDefault();
        push(keyDown(e));
      });
      vp.addEventListener('keyup', e => {
        if (!typing()) return;
        e.stopPropagation();
        if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) return;
        e.preventDefault();
        push({ type: 'key', action: 'up', key: e.key, code: e.code, keyCode: e.keyCode || 0, modifiers: mods(e) });
      });
      vp.addEventListener('paste', e => {
        if (!typing()) return;
        e.preventDefault(); e.stopPropagation();
        const t = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        if (t) push({ type: 'text', text: t.slice(0, 4000) });
      });
    }
    return { start, stop, active: () => s.on, seq: () => s.seq, _pagePoint: pagePoint };
  }

  const api = { create };
  root.BrowserStream = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
