/* StarNet Remote — the phone app.

   Three places: STATION (the picture of your station, what needs you, your crew, your latest sessions),
   SESSIONS (every conversation, the same ones the desk shows) and FILES (what the crew delivered).

   Everything here comes from the station over the sealed channel: status, approvals, sessions, files, routines,
   live run events, and the station picture, which the desk's own renderer drew (nothing is drawn or staged on the
   phone). When the link is down the app says so and shows when it last heard from the station. A run is only
   shown as working when the station said so, and the picture always carries its age: an old one is never
   called live. All station text is rendered with textContent, never as HTML. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    back: 'M10 3L5 8l5 5', close: 'M3.5 3.5l9 9M12.5 3.5l-9 9', send: 'M3 8h9M8.5 4l4 4-4 4', caret: 'M3 5.5l5 5 5-5',
    expand: 'M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9',
    gear: 'M2 5h7M12 5h2M2 11h2M7 11h7M9 3.5h3v3H9zM4 9.5h3v3H4z',
    station: 'M2.5 3.5h11v9h-11zM2.5 6.5h11M5.5 9.5h5', sessions: 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z', files: 'M4 2.5h5.5l2.5 2.5v8.5H4zM9.5 2.5V5H12', activity: 'M1.5 8.5h3l2-5 3 9 2-4h3'
  };
  function icon(name) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.4'); s.setAttribute('stroke-linecap', 'square'); s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', ICONS[name] || ''); s.appendChild(p);
    return s;
  }

  const S = {
    rec: null, client: null, linkState: 'connecting', lastOkAt: 0, latency: null,
    status: null, approvals: [], threads: [], files: [], routines: [],
    tab: 'station', page: null, thread: null, file: null, target: null, query: '',
    live: new Map(),            // runId -> { streamId, agentId, text, steps:[], ended }
    stepOf: new Map(),
    drafts: new Map(),           // promptId -> a half-typed answer           // runId -> the tool it is using right now (from the station's feed)
    view: null, viewNone: false, viewBusy: false,   // the station picture: { at, w, h, bodies, url, age0, seenAt }
    portraits: new Map(), portraitBusy: false,      // skin -> image URL (null = none)
    scroll: {}, seen: new Set(), retryMs: 1000, retryTimer: null, arrivedAt: new Map()
  };
  const LIVE_VIEW_MS = 15000;   // a picture younger than this is "live"

  /* ---------- helpers ---------- */
  const TARGET_KEY = 'starnet.remote.target';
  function setTarget(id) { S.target = id; try { localStorage.setItem(TARGET_KEY, id); } catch (_) {} }
  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    const m = Math.round(s / 60); if (m < 60) return m + 'm';
    const h = Math.round(m / 60); if (h < 48) return h + 'h';
    return Math.round(h / 24) + 'd';
  }
  function clock(ms) { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  const agents = () => (S.status && S.status.agents) || [];
  const agentOf = (id) => agents().find(x => x.agentId === id) || null;
  function agentName(id) { const a = agentOf(id); return (a && a.name) || id || 'AGENT'; }
  const isWorking = (a) => !!a && a.state === 'working' && S.linkState === 'open';
  // a one-line label from text that may carry markdown marks
  const plain = (t) => { const q = questionOf(t); return q ? 'Asks: ' + q.question : plainText(t); };
  const plainText = (t) => String(t == null ? '' : t).replace(/`{1,3}|\*\*|^\s{0,3}#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim();
  const streamLive = (streamId) => { for (const [, L] of S.live) if (L.streamId === streamId && !L.ended) return true; return false; };
  /* WHAT AN AGENT IS DOING, in plain words: one word for a crew card, a phrase for a row. Read from the name of the
     step the station last reported for that run (never a raw tool name on screen). */
  const DOING = [
    [/^fs\.(write|append|edit|patch|move|rename|delete|remove|mkdir)|^skill\.write/, 'writing', 'writing a file'],
    [/^fs\./, 'reading', 'reading files'],
    [/^(shell|terminal)\./, 'running', 'running a command'],
    [/^spotify/, 'music', 'playing music'],
    [/^web\.search/, 'searching', 'searching the web'],
    [/^(web|http)\./, 'reading', 'reading the web'],
    [/^(browser|computer)/, 'browsing', 'using the browser'],
    [/^(team|session)\./, 'managing', 'handing work to the crew'],
    [/^recall/, 'recalling', 'looking back at a conversation'],
    [/^(notebook|memory)/, 'noting', 'saving a note'],
    [/^station\./, 'building', 'working on the station'],
    [/^routine\./, 'planning', 'setting up a routine'],
    [/^brief\.ask/, 'asking', 'asking you something'],
    [/^(task|quest|brief)\./, 'planning', 'planning the work'],
    [/^skill\./, 'reading', 'reading a skill'],
    [/image|voice|video/, 'making', 'making media'],
    [/^verify/, 'checking', 'checking its work'],
    [/^plugin/, 'working', 'using a plugin']
  ];
  function doing(name) {
    const n = String(name || '').toLowerCase().replace(/_+/g, '.');
    for (const [re, word, phrase] of DOING) if (re.test(n)) return { word, phrase };
    return { word: 'working', phrase: n ? 'using ' + n.replace(/\.+/g, ' ').trim() : 'working' };
  }
  // the newest step the station reported for a run: the phone's own run stream first, then the station's tool events
  function lastStep(runId) {
    const L = runId && S.live.get(runId);
    return (L && L.steps.length ? L.steps[L.steps.length - 1].name : '') || (runId && S.stepOf.get(runId)) || '';
  }

  let toastT = null;
  function toast(msg, bad) {
    const t = $('toast'); t.textContent = msg; t.className = bad ? 'bad' : ''; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600);
  }
  function b64uDecode(s) { const str = String(s).replace(/-/g, '+').replace(/_/g, '/'); return atob(str + '==='.slice((str.length + 3) % 4)); }
  function bytesOf(b64) { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k); return u8; }

  /* ---------- a little markdown, built as DOM nodes (never innerHTML) ---------- */
  function inline(node, s) {
    const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g; let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) node.appendChild(document.createTextNode(s.slice(last, m.index)));
      const tok = m[0];
      node.appendChild(tok[0] === '`' ? el('code', null, tok.slice(1, -1)) : el('b', null, tok.slice(2, -2)));
      last = m.index + tok.length;
    }
    if (last < s.length) node.appendChild(document.createTextNode(s.slice(last)));
    for (const n of node.childNodes) if (n.nodeType === 3 && n.nodeValue.indexOf('**') >= 0) n.nodeValue = n.nodeValue.replace(/\*\*/g, '');
  }
  /* AN AGENT'S QUESTION. A run that needs the Commander's call ends on a machine line the desk turns into choice chips:
       TASK_QUESTION: <question> || <option> | <option>      (or "[free text]")      and the same shape for FORK:
     The phone renders it the same way: the question, and one key per option that answers in the same conversation. */
  const MARKER_RE = /^\s*(TASK_QUESTION|FORK):\s*(.+?)\s*\|\|\s*(.*)$/m;
  function questionOf(text) {
    const m = MARKER_RE.exec(String(text || ''));
    if (!m) return null;
    const opts = m[3].split('|').map(x => x.replace(/^[\s★*]+|[\s*]+$/g, '').trim()).filter(x => x && !/^\[free text\]$/i.test(x)).slice(0, 6);
    return { kind: m[1], question: m[2].trim(), options: opts, before: String(text).slice(0, m.index).trim() };
  }
  function mdNode(text) {
    const root = el('div', 'md');
    String(text).split('```').forEach((part, i) => {
      if (i % 2 === 1) { root.appendChild(el('pre', null, part.replace(/^[A-Za-z0-9_+-]*\n/, '').replace(/\n$/, ''))); return; }
      for (const blk of part.split(/\n{2,}/)) {
        if (!blk.trim()) continue;
        let buf = [];
        const flush = () => { if (buf.length) { const p = el('p'); inline(p, buf.join('\n')); root.appendChild(p); buf = []; } };
        for (const ln of blk.split('\n')) {
          let m;
          if ((m = /^\s{0,3}#{1,6}\s+(.*)$/.exec(ln))) { flush(); const h = el('p', 'h'); inline(h, m[1]); root.appendChild(h); }
          else if ((m = /^\s*[-*•]\s+(.*)$/.exec(ln))) { flush(); const li = el('div', 'li'); const s = el('span'); inline(s, m[1]); li.appendChild(s); root.appendChild(li); }
          else buf.push(ln);
        }
        flush();
      }
    });
    return root;
  }

  /* ---------- portraits: each agent's own sprite, from the station ---------- */
  const skinKey = (a) => (a && a.skin) || '_';
  function well(agentId, cls) {
    const a = agentOf(agentId), w = el('span', 'well' + (cls ? ' ' + cls : ''));
    const url = a && S.portraits.get(skinKey(a));
    if (url) { const img = el('img'); img.src = url; img.alt = ''; w.appendChild(img); }
    else w.textContent = (agentName(agentId) || '?').slice(0, 1).toUpperCase();
    return w;
  }
  // the sprite sits in a padded square; trim the empty margin so it fills the well
  async function cropSprite(mime, b64) {
    const img = new Image(); img.src = 'data:' + mime + ';base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return img.src;
    const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
    o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
    return o.toDataURL('image/png');
  }
  async function ensurePortraits() {
    if (S.portraitBusy || S.linkState !== 'open') return;
    S.portraitBusy = true;
    try {
      let got = 0;
      const want = agents().filter(a => !S.portraits.has(skinKey(a)));
      for (const a of want) S.portraits.set(skinKey(a), null);
      await Promise.all(want.map(async (a) => {
        const k = skinKey(a);
        try { const r = await call('portrait', { agentId: a.agentId }); if (r.ok && r.data && r.data.data) { S.portraits.set(k, await cropSprite(r.data.mime || 'image/png', r.data.data)); got++; } }
        catch (_) { S.portraits.delete(k); }
      }));
      if (got) render(true);
    } finally { S.portraitBusy = false; }
  }

  /* ---------- the link lamp ---------- */
  function paintLamp() {
    const lamp = $('lamp'), label = lamp.querySelector('span');
    lamp.className = 'lamp';
    if (S.linkState === 'open') { lamp.classList.add('ok'); label.textContent = 'LINKED'; }
    else if (S.linkState === 'offline') { lamp.classList.add('down'); label.textContent = 'OFFLINE' + (S.lastOkAt ? ' · ' + ago(Date.now() - S.lastOkAt).toUpperCase() : ''); }
    else if (S.linkState === 'removed') { lamp.classList.add('down'); label.textContent = 'NOT PAIRED'; }
    else { lamp.classList.add('busy'); label.textContent = 'CONNECTING'; }
  }

  /* ---------- connection ---------- */
  function connect() {
    clearTimeout(S.retryTimer);
    if (S.client) { try { S.client.close(); } catch (_) {} }
    const r = S.rec;
    const c = PhoneClient.connectRelay({ relay: r.station.relay, stationPub: r.station.stationPub, deviceId: r.station.deviceId, relayToken: r.station.relayToken, key: r.key });
    S.client = c;
    c.onEvent(onEvent);
    c.onStatus((s, detail) => {
      if (c !== S.client) return;
      if (s === 'open') { S.linkState = 'open'; S.retryMs = 1000; }
      else if (s === 'closed') {
        const code = detail && detail.code;
        S.linkState = code === 4401 ? 'removed' : (code === 4404 ? 'offline' : (S.lastOkAt ? 'offline' : 'connecting'));
        S.latency = null;
        if (S.linkState !== 'removed') scheduleReconnect();
      } else if (S.linkState !== 'offline' && S.linkState !== 'removed') S.linkState = 'connecting';   // a retry never un-says "offline"
      paintLamp(); render(true);
    });
    c.open().then(() => { S.lastOkAt = Date.now(); refreshAll(); }).catch(() => {});
  }
  function scheduleReconnect() {
    clearTimeout(S.retryTimer);
    S.retryTimer = setTimeout(connect, S.retryMs);
    S.retryMs = Math.min(S.retryMs * 2, 30000);
  }
  async function call(verb, args) {
    const r = await S.client.call(verb, args);
    S.lastOkAt = Date.now();
    return r;
  }
  async function ping() {
    if (S.linkState !== 'open') return;
    const t = performance.now();
    try { await S.client.call('ping', {}, 12000); S.latency = Math.round(performance.now() - t); S.lastOkAt = Date.now(); }
    catch (_) { S.latency = null; S.linkState = 'connecting'; try { S.client.close(); } catch (__) {} scheduleReconnect(); render(true); }
    paintLamp();
  }

  async function refreshStatus() {
    try {
      const r = await call('status');
      if (!r.ok) return;
      S.status = r.data;
      const running = new Set((r.data.runs || []).map(x => x.runId));
      for (const [runId, L] of S.live) if (!L.ended && !running.has(runId) && Date.now() - (L.seenAt || 0) > 4000) L.ended = { runId, reason: 'gone' };
    } catch (_) {}
  }
  async function refreshApprovals() { try { const r = await call('approvals'); if (r.ok) { S.approvals = r.data; for (const a of S.approvals) if (!S.arrivedAt.has(a.promptId)) S.arrivedAt.set(a.promptId, Date.now()); } } catch (_) {} }
  async function refreshThreads() { try { const r = await call('threads', { limit: 300 }); if (r.ok) S.threads = r.data; } catch (_) {} }
  async function refreshRoutines() { try { const r = await call('routines'); if (r.ok) S.routines = r.data; } catch (_) {} }
  async function refreshAll() {
    refreshView();   // needs nothing else: start the picture first, it is the biggest thing on the screen
    await Promise.all([refreshStatus(), refreshApprovals()]);
    if (!S.target) { try { S.target = localStorage.getItem(TARGET_KEY) || null; } catch (_) {} }
    if ((!S.target || !agentOf(S.target)) && agents().length) S.target = agents()[0].agentId;
    render(true);
    ensurePortraits(); refreshPush().then(() => render(true));
    await Promise.all([refreshThreads(), refreshActivity()]);
    render(true);
  }

  let statusSoon = null;
  function statusSoonish() { clearTimeout(statusSoon); statusSoon = setTimeout(() => refreshStatus().then(() => render(true)), 400); }

  function onEvent(e) {
    if (!e || !e.type) return;
    if (e.type === 'approval.opened') {
      if (!S.approvals.some(a => a.promptId === e.approval.promptId)) { S.approvals.push(e.approval); S.arrivedAt.set(e.approval.promptId, Date.now()); }
      try { if (navigator.vibrate) navigator.vibrate(60); } catch (_) {}
      render(true); return;
    }
    if (e.type === 'approval.closed') { S.approvals = S.approvals.filter(a => a.promptId !== e.promptId); render(true); return; }
    if (e.type === 'run.started') { S.live.set(e.runId, { streamId: e.streamId, agentId: e.agentId, text: '', steps: [], ended: null, seenAt: Date.now() }); statusSoonish(); if (S.tab === 'sessions') activitySoonish(); render(true); return; }
    const L = e.runId && S.live.get(e.runId);
    const showing = L && S.thread && S.thread.streamId === L.streamId;
    if ((e.type === 'run.text' || e.type === 'run.delta') && L) {
      // the whole reply so far (run.text), or what it grew by (run.delta, applied only where it continues what this phone has)
      if (e.type === 'run.text' && typeof e.text === 'string') L.text = e.text;
      else if (e.type === 'run.delta' && typeof e.add === 'string' && (L.text || '').length === e.at) L.text = (L.text || '') + e.add;
      else return;
      if (showing) renderLive(); return;
    }
    if (e.type === 'run.tool' && L) {
      L.steps.push({ callId: e.callId, name: e.name, ok: null });
      for (const n of document.querySelectorAll('[data-verb="' + CSS.escape(String(e.runId)) + '"]')) n.textContent = doing(e.name).word;
      if (showing) renderLive(); return;
    }
    if (e.type === 'run.step' && L) { const s = L.steps.find(x => x.callId === e.callId && x.ok === null && !x.held); if (s) { s.ok = e.held ? null : e.ok; if (e.held) s.held = true; } if (showing) renderLive(); return; }
    if (e.type === 'run.ended') {
      if (L) L.ended = e;
      statusSoonish();
      if (e.error) toast(agentName(e.agentId) + ': ' + e.error, true);
      if (showing) openThread(S.thread.streamId, S.thread.agentId, true);
      refreshThreads().then(() => render(true));
      if (S.tab === 'sessions') activitySoonish();
      return;
    }
    if (e.type === 'view.crew') { if (S.view) { S.crewPaused = !!e.paused; applyCrew(e.bodies, e.at); paintHero(); } return; }
    if (e.type === 'station' && e.name === 'agent.tool_call' && e.payload && e.payload.runId && e.payload.name) {
      S.stepOf.set(String(e.payload.runId), String(e.payload.name));
      if (S.stepOf.size > 200) S.stepOf.delete(S.stepOf.keys().next().value);
      const rid = CSS.escape(String(e.payload.runId));
      for (const n of document.querySelectorAll('[data-step="' + rid + '"]')) n.textContent = stepLine(e.payload.name);
      for (const n of document.querySelectorAll('[data-verb="' + rid + '"]')) n.textContent = doing(e.payload.name).word;
      return;
    }
    if (e.type === 'station' && (e.name === 'agent.run.start' || e.name === 'agent.run.end')) { statusSoonish(); if (S.tab === 'sessions') activitySoonish(); }
  }

  /* ---------- the station, live ----------
     The room is a still the desk's own renderer drew (refreshed every few seconds, with the crew left out). The crew
     are drawn here, on top, from the desk's crew stream: the same sprite drawings the stage is showing, in the same
     places, a few times a second, and each one glides to its next position between updates, so they move smoothly.
     A still with the crew baked in (an older desk page) gets nothing drawn on top of it. */
  const scene = { base: null, crew: new Map(), tracks: new Map(), raf: 0, last: 0 };
  const TRACK_FPS = { walk: 10, type: 6, talk: 6, drink: 4 };   // tracks the phone animates on its own between updates
  const trackKey = (key) => String(key || '').replace('.blink.', '.rot.');   // a blink is too short to sample: show the pose
  function track(key) {
    const k = trackKey(key);
    let t = scene.tracks.get(k);
    if (t) return t;
    t = { frames: null };
    scene.tracks.set(k, t);
    call('sprite', { key: k }).then(async (r) => {
      if (!r.ok || !r.data || !Array.isArray(r.data.frames)) return;
      t.frames = await Promise.all(r.data.frames.map((b64) => { const i = new Image(); i.src = 'data:image/png;base64,' + b64; return i.decode().then(() => i); }));
      kick();
    }).catch(() => { scene.tracks.delete(k); });
    return t;
  }
  /* SMOOTH MOTION. Positions arrive about five times a second, but the network spaces them unevenly (measured through
     the live relay: 186 ms typical, 309 ms at the 95th percentile, while the desk sends every 200 ms ±13). Easing
     toward each newest point made a walker surge and stall five times a second. Instead every point keeps the
     STATION's own time for it (`at`, stamped where the desk handed it over), mapped onto this phone's clock by the
     quickest arrival seen, and the crew are drawn a little in the past at constant speed between two real points:
     the uneven gaps disappear and nothing is invented (the drawing is always between two places they really were).
     How far behind adapts to the link: on the live relay the points also came in BURSTS (0.8-1 s of nothing, then
     three or four at once, every few seconds, from the internet path — a local relay showed none), so the delay
     follows how late points actually run (95th percentile + a margin): about 0.2 s on a clean link, up to 0.8 s on a
     choppy one, rising at once and settling back slowly. Replayed on recorded live-relay points: lurches while
     walking fell from 14-19 per walk to 1. */
  const clockMap = { offs: [], late: [], playout: 240 };
  function phoneTimeOf(at) {
    const arrival = performance.now();
    if (!(at > 0)) return arrival;
    const m = clockMap;
    m.offs.push(arrival - at); if (m.offs.length > 40) m.offs.shift();
    const off = Math.min.apply(null, m.offs);
    m.late.push(arrival - at - off); if (m.late.length > 40) m.late.shift();
    const l = m.late.slice().sort((a, b) => a - b), want = Math.max(160, Math.min(800, (l[Math.floor((l.length - 1) * 0.95)] || 0) + 80));
    m.playout = want > m.playout ? want : m.playout + (want - m.playout) * 0.05;
    return at + off;
  }
  function rectAt(c, now) {
    const s = c.samples, rt = now - clockMap.playout;
    if (rt <= s[0].t) return s[0];
    for (let i = 1; i < s.length; i++) {
      if (s[i].t >= rt) {
        const a = s[i - 1], b = s[i], f = (rt - a.t) / Math.max(1, b.t - a.t);
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, w: b.w, h: b.h };
      }
    }
    return s[s.length - 1];
  }
  // still between two points it has not reached yet?
  const gliding = (c, now) => { const s = c.samples, n = s.length; return n > 1 && now - clockMap.playout < s[n - 1].t && (s[n - 1].x !== s[n - 2].x || s[n - 1].y !== s[n - 2].y); };
  function applyCrew(list, at) {
    const now = performance.now(), seen = new Set(), t = phoneTimeOf(at);
    for (const b of list || []) {
      if (!b || !b.agentId || !b.key) continue;
      seen.add(b.agentId);
      const to = { t, x: b.x, y: b.y, w: b.w, h: b.h };
      let c = scene.crew.get(b.agentId);
      if (!c) { c = { samples: [to], key: b.key, keyAt: now, idx0: b.idx, idx: b.idx }; scene.crew.set(b.agentId, c); }
      else {
        const last = c.samples[c.samples.length - 1];
        // a jump across the station (a room change, a reconnect) is a cut, not a glide
        if (t <= last.t || Math.hypot(to.x - last.x, to.y - last.y) > Math.max(6, to.h) * 4) c.samples = [to];
        else { c.samples.push(to); while (c.samples.length > 2 && c.samples[1].t < now - clockMap.playout - 1500) c.samples.shift(); }
      }
      if (c.key !== b.key) { c.key = b.key; c.keyAt = now; c.idx0 = b.idx; }
      c.idx = b.idx;
      track(c.key);
    }
    for (const id of [...scene.crew.keys()]) if (!seen.has(id)) scene.crew.delete(id);
    kick();
  }
  function frameOf(c, t, now) {
    const n = t.frames.length;
    if (n < 2) return t.frames[0];
    const fps = TRACK_FPS[String(c.key).split('.')[1]];
    const i = fps ? c.idx0 + Math.floor((now - c.keyAt) / (1000 / fps)) : c.idx;
    return t.frames[((i % n) + n) % n];
  }
  // one picture onto one canvas: k = picture px -> CSS px, (ox, oy) = where the picture's corner sits, in CSS px
  function paintCanvas(cv, cssW, cssH, k, ox, oy) {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(cssW * dpr)), H = Math.max(1, Math.round(cssH * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#040302'; g.fillRect(0, 0, W, H);
    g.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
    g.imageSmoothingEnabled = true; if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = 'high';
    g.drawImage(scene.base, 0, 0, S.view.w, S.view.h);
    if (!S.view.crewFree) return;
    const now = performance.now();
    const list = [...scene.crew.values()].map(c => [c, rectAt(c, now)]).sort((a, b) => (a[1].y + a[1].h) - (b[1].y + b[1].h));
    for (const [c, r] of list) {
      const t = scene.tracks.get(trackKey(c.key));
      if (t && t.frames && t.frames.length) g.drawImage(frameOf(c, t, now), r.x, r.y, r.w, r.h);
    }
  }
  /* FRAMING. A small station fits the card whole. A big one (a picture spanning far more floor than a phone card
     can show legibly) is framed on where the crew are, and the frame drifts gently after them. */
  const HERO_ASPECT = 4 / 3;
  function bigStation() { return !!(S.view && S.view.scale && S.view.w / S.view.scale > 560); }
  /* The camera follows ONE crew member: whoever is working (the one who started first), otherwise the one you are
     talking to. Tap a portrait in CREW and the card turns to them. */
  function focusAgent() {
    const working = agents().filter(isWorking).sort((p, q) => (p.since || 0) - (q.since || 0));
    for (const a of working) if (scene.crew.has(a.agentId)) return a.agentId;
    if (S.target && scene.crew.has(S.target)) return S.target;
    const first = agents().find(a => scene.crew.has(a.agentId));
    return first ? first.agentId : null;
  }
  function cropTarget() {
    const v = S.view, full = { x: 0, y: 0, w: v.w, h: v.h };
    if (!bigStation() || !v.crewFree || !scene.crew.size) return full;
    const id = focusAgent(), c = id && scene.crew.get(id);
    if (!c) return full;
    const r = rectAt(c, performance.now()), k = v.scale;
    const w = Math.min(v.w, 330 * k), h = Math.min(v.h, w / HERO_ASPECT);   // about a room and its doorways
    const cx = r.x + r.w / 2, cy = r.y + r.h * 0.6;
    return { x: Math.max(0, Math.min(v.w - w, cx - w / 2)), y: Math.max(0, Math.min(v.h - h, cy - h / 2)), w, h };
  }
  function heroCrop() {
    const t = cropTarget(), c = scene.crop;
    if (!c || !bigStation()) { scene.crop = t; return t; }
    const e = 0.08, d = Math.abs(t.x - c.x) + Math.abs(t.y - c.y) + Math.abs(t.w - c.w);
    scene.cropMoving = d > 0.5;
    if (scene.cropMoving) scene.crop = { x: c.x + (t.x - c.x) * e, y: c.y + (t.y - c.y) * e, w: c.w + (t.w - c.w) * e, h: c.h + (t.h - c.h) * e };
    return scene.crop;
  }
  // is anything on the picture moving? (a glide in progress, a walking/typing crew member, a drifting frame, a finger)
  function animating(now) {
    if (scene.cropMoving || viewer.pts.size) return 33;
    let need = 0;
    for (const c of scene.crew.values()) {
      if (gliding(c, now)) return 16;   // someone is crossing the room: every display frame
      const fps = TRACK_FPS[String(c.key).split('.')[1]];
      if (fps) need = Math.max(need, fps);
    }
    return need ? Math.max(33, Math.round(1000 / need)) : 0;
  }
  function loop(ts) {
    scene.raf = 0;
    const viewOn = !$('viewer').hidden && S.view && scene.base;
    const heroOn = !viewOn && S.view && scene.base && hero.root.isConnected && !hero.frame.hidden;
    if (!viewOn && !heroOn) return;
    const every = animating(performance.now());
    if (document.visibilityState === 'visible' && (scene.dirty || ts - scene.last >= (every || 33))) {
      scene.last = ts; scene.dirty = false;
      if (viewOn) { viewerClamp(); paintCanvas(viewer.cv, window.innerWidth, window.innerHeight, viewer.k, viewer.x, viewer.y); }
      else { const c = heroCrop(), w = hero.frame.clientWidth, k = w / c.w; paintCanvas(hero.cv, w, hero.frame.clientHeight, k, -c.x * k, -c.y * k); }
    }
    if (every || scene.dirty) scene.raf = requestAnimationFrame(loop);   // nothing moving: stop until something changes
  }
  function kick() { scene.dirty = true; if (!scene.raf) scene.raf = requestAnimationFrame(loop); }

  const hero = (() => {
    const root = el('div', 'hero'), frame = el('div', 'hero-frame'), cv = el('canvas'), chip = el('span', 'chip'), dot = el('i'), chipText = el('span');
    const expand = el('button', 'icon-btn expand'); expand.type = 'button'; expand.setAttribute('aria-label', 'Open the station view'); expand.appendChild(icon('expand'));
    const empty = el('div', 'hero-empty'), eb = el('b'), es = el('span');
    cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', 'Your station');
    chip.appendChild(dot); chip.appendChild(chipText); empty.appendChild(eb); empty.appendChild(es);
    frame.appendChild(cv); root.appendChild(frame); root.appendChild(empty); root.appendChild(chip); root.appendChild(expand);
    return { root, frame, cv, chip, chipText, expand, empty, eb, es };
  })();
  const viewAge = () => (S.view ? S.view.age0 + (Date.now() - S.view.seenAt) : Infinity);
  const viewLive = () => S.linkState === 'open' && viewAge() < LIVE_VIEW_MS && !(S.view && S.view.crewFree && S.crewPaused);
  function stampText() {
    if (S.linkState === 'open' && viewAge() < LIVE_VIEW_MS && S.crewPaused) return 'DESK WINDOW HIDDEN';
    return viewLive() ? 'LIVE' : 'AS OF ' + ago(viewAge()).toUpperCase() + ' AGO';
  }

  function paintHero() {
    const v = S.view;
    hero.frame.hidden = !v; hero.chip.hidden = !v; hero.expand.hidden = !v; hero.empty.hidden = !!v;
    if (!v) {
      if (S.viewNone && S.deskOpen) { hero.eb.textContent = 'ALMOST THERE'; hero.es.textContent = 'StarNet is open on your computer but has not drawn your station yet. Bring its window to the front for a moment.'; }
      else if (S.viewNone) { hero.eb.textContent = 'NO PICTURE YET'; hero.es.textContent = 'Open StarNet on your computer and your station appears here.'; }
      else if (S.linkState === 'open') { hero.eb.textContent = 'LOADING YOUR STATION'; hero.es.textContent = ''; }
      else { hero.eb.textContent = 'STATION OFFLINE'; hero.es.textContent = 'The picture appears when your station is reachable.'; }
      return;
    }
    hero.frame.style.aspectRatio = bigStation() && v.crewFree ? '4 / 3' : v.w + ' / ' + v.h;
    const live = viewLive();
    hero.root.classList.toggle('stale', !live);
    hero.chip.className = 'chip' + (live ? ' live' : ''); hero.chipText.textContent = stampText();
    if (!$('viewer').hidden) paintViewer();
    kick();
  }
  async function refreshView() {
    if (S.viewBusy || S.linkState !== 'open') return;
    S.viewBusy = true;
    try {
      const r = await call('view', { have: S.view ? S.view.at : 0 });
      if (!r.ok) return;
      let d = r.data;
      if (d.none) { S.viewNone = true; S.deskOpen = !!d.desk; return; }
      S.viewNone = false;
      if (d.same && S.view) { S.view.age0 = Math.max(0, d.now - (d.checked || d.at)); S.view.seenAt = Date.now(); S.crewPaused = !!d.crewPaused; return; }
      const first = d, parts = [];
      for (let i = 0; i < 12; i++) {
        parts.push(bytesOf(d.data));
        if (d.eof) break;
        const n = await call('view', { at: first.at, offset: d.offset + d.bytes });
        if (!n.ok || n.data.changed || n.data.none) return;   // the desk drew a newer one mid-read: the next pass takes it
        d = n.data;
      }
      const url = URL.createObjectURL(new Blob(parts, { type: first.mime }));
      const pre = new Image(); pre.src = url;
      try { await pre.decode(); } catch (_) { URL.revokeObjectURL(url); return; }
      const old = S.view && S.view.url;
      if (!S.view || S.view.w !== first.w || S.view.h !== first.h) scene.crop = null;
      S.view = { at: first.at, w: first.w, h: first.h, scale: Number(first.scale) || 0, bodies: first.bodies || [], crewFree: !!first.crewFree, url, age0: Math.max(0, first.now - (first.checked || first.at)), seenAt: Date.now() };
      S.crewPaused = !!first.crewPaused;
      scene.base = pre;
      if (first.crew && Array.isArray(first.crew.bodies) && !scene.crew.size) applyCrew(first.crew.bodies, first.crew.at);
      paintHero();
      if (old) setTimeout(() => URL.revokeObjectURL(old), 1500);
      try { RemoteStore.saveView({ blob: new Blob(parts, { type: first.mime }), savedAt: Date.now(), meta: { at: S.view.at, w: S.view.w, h: S.view.h, scale: S.view.scale, bodies: S.view.bodies, crewFree: S.view.crewFree, age0: S.view.age0 } }).catch(() => {}); } catch (_) {}
    } catch (_) { /* the link lamp reports a dead link; the picture keeps its age */ }
    finally { S.viewBusy = false; paintHero(); }
  }
  // the crew member under a point (picture pixels), within `reach` picture pixels of their body
  function bodyNear(px, py, reach) {
    let best = null, bd = reach;
    if (S.view && S.view.crewFree && scene.crew.size) {
      const now = performance.now();
      for (const [id, c] of scene.crew) { const r = rectAt(c, now), d = Math.hypot(r.x + r.w / 2 - px, r.y + r.h * 0.55 - py); if (d < bd && agentOf(id)) { bd = d; best = { agentId: id }; } }
      return best;
    }
    for (const b of (S.view && S.view.bodies) || []) { const d = Math.hypot(b.x - px, (b.y - 10) - py); if (d < bd) { bd = d; best = b; } }
    return best && agentOf(best.agentId) ? best : null;
  }
  hero.root.addEventListener('click', (ev) => {
    if (!S.view) return;
    const r = hero.frame.getBoundingClientRect(), c = scene.crop || { x: 0, y: 0, w: S.view.w, h: S.view.h }, k = c.w / r.width;
    const b = ev.target.closest('.expand') ? null : bodyNear(c.x + (ev.clientX - r.left) * k, c.y + (ev.clientY - r.top) * k, 26 * k);
    if (b) { setTarget(b.agentId); toast('Talking to ' + agentName(b.agentId)); render(); return; }
    openViewer();
  });

  /* ---------- the station, full screen ---------- */
  const viewer = (() => {
    const stage = $('viewer-stage'), cv = el('canvas');
    cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', 'Your station');
    stage.appendChild(cv);
    return { stage, cv, k: 1, x: 0, y: 0, fit: 1, pts: new Map(), sel: null, tap: null, pinch: null, lastTap: 0 };
  })();
  function viewerFit() {
    const W = window.innerWidth, H = window.innerHeight;
    viewer.fit = Math.min(W / S.view.w, H / S.view.h);
    viewer.k = viewer.fit; viewer.x = (W - S.view.w * viewer.k) / 2; viewer.y = (H - S.view.h * viewer.k) / 2;
  }
  function viewerClamp() {
    const W = window.innerWidth, H = window.innerHeight;
    viewer.k = Math.max(viewer.fit, Math.min(Math.max(viewer.fit * 8, 3), viewer.k));
    const w = S.view.w * viewer.k, h = S.view.h * viewer.k;
    viewer.x = w <= W ? (W - w) / 2 : Math.min(0, Math.max(W - w, viewer.x));
    viewer.y = h <= H ? (H - h) / 2 : Math.min(0, Math.max(H - h, viewer.y));
  }
  function paintViewer() {
    if (!S.view) return;
    const st = $('viewer-stamp'); st.className = 'chip' + (viewLive() ? ' live' : ''); st.replaceChildren(el('i'), el('span', null, stampText()));
    const plate = $('viewer-plate'), a = viewer.sel && agentOf(viewer.sel);
    plate.hidden = !a;
    // rebuilt only when what it says changes: a button must never be swapped out from under a finger
    const line = a ? (isWorking(a) ? 'working' + (a.since ? ' · ' + ago(Date.now() - a.since) : '') : S.linkState === 'open' ? 'idle' : 'last seen ' + (a.state || 'idle')) : '';
    const plateKey = a ? a.agentId + '|' + a.name + '|' + line + '|' + (S.portraits.get(skinKey(a)) ? 1 : 0) : '';
    if (a && plate.dataset.key !== plateKey) {
      plate.dataset.key = plateKey;
      const t = el('span', 't'); t.appendChild(el('b', null, a.name || a.agentId));
      t.appendChild(el('span', null, line));
      const b = el('button', 'btn', 'Message'); b.type = 'button';
      b.onclick = () => { S.target = a.agentId; closeViewer(); S.tab = 'station'; S.thread = null; S.file = null; S.page = null; render(); $('compose-text').focus(); };
      plate.replaceChildren(well(a.agentId, 'sm'), t, b);
    }
    kick();
  }
  function openViewer() {
    if (!S.view) return;
    viewer.sel = null; $('viewer-plate').dataset.key = ''; $('viewer').hidden = false; viewerFit();
    const c = scene.crop;
    if (c && c.w < S.view.w * 0.95) {   // a framed big station: open on the same framing, then pan and zoom from there
      const W = window.innerWidth, H = window.innerHeight;
      viewer.k = Math.min(W / c.w, H / c.h); viewer.x = W / 2 - (c.x + c.w / 2) * viewer.k; viewer.y = H / 2 - (c.y + c.h / 2) * viewer.k;
    }
    paintViewer(); refreshView();
  }
  function closeViewer() { $('viewer').hidden = true; viewer.pts.clear(); viewer.pinch = null; kick(); }
  (function wireViewer() {
    const v = $('viewer');
    $('viewer-close').appendChild(icon('close'));
    $('viewer-close').onclick = closeViewer;
    const zoomAt = (cx, cy, k) => { const nk = Math.max(viewer.fit, Math.min(Math.max(viewer.fit * 8, 3), k)); viewer.x = cx - (cx - viewer.x) * (nk / viewer.k); viewer.y = cy - (cy - viewer.y) * (nk / viewer.k); viewer.k = nk; };
    v.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.viewer-top > *, .viewer-plate')) return;
      try { v.setPointerCapture(e.pointerId); } catch (_) {}
      viewer.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (viewer.pts.size === 1) viewer.tap = { x: e.clientX, y: e.clientY, at: Date.now(), moved: false };
      if (viewer.pts.size === 2) { const [a, b] = [...viewer.pts.values()]; viewer.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: viewer.k }; if (viewer.tap) viewer.tap.moved = true; }
    });
    v.addEventListener('pointermove', (e) => {
      const p = viewer.pts.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
      if (viewer.pts.size === 1) { viewer.x += dx; viewer.y += dy; if (viewer.tap && Math.hypot(e.clientX - viewer.tap.x, e.clientY - viewer.tap.y) > 8) viewer.tap.moved = true; }
      else if (viewer.pts.size === 2 && viewer.pinch) { const [a, b] = [...viewer.pts.values()]; zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, viewer.pinch.k * (Math.hypot(a.x - b.x, a.y - b.y) / viewer.pinch.d)); }
      kick();   // the canvas repaints on the next frame: nothing heavy happens per touch event
    });
    const up = (e) => {
      if (!viewer.pts.has(e.pointerId)) return;
      viewer.pts.delete(e.pointerId);
      if (viewer.pts.size < 2) viewer.pinch = null;
      const t = viewer.tap;
      if (viewer.pts.size === 0 && t && !t.moved && Date.now() - t.at < 350) {
        const px = (t.x - viewer.x) / viewer.k, py = (t.y - viewer.y) / viewer.k;
        const b = bodyNear(px, py, 26 / viewer.k);
        if (b) viewer.sel = b.agentId;
        else if (Date.now() - viewer.lastTap < 320) { if (viewer.k > viewer.fit * 1.05) viewerFit(); else zoomAt(t.x, t.y, viewer.k * 2.5); viewer.lastTap = 0; }
        else { viewer.sel = null; viewer.lastTap = Date.now(); }
        paintViewer();
      }
      if (viewer.pts.size === 0) viewer.tap = null;
    };
    v.addEventListener('pointerup', up); v.addEventListener('pointercancel', up);
    v.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, viewer.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); kick(); }, { passive: false });
    window.addEventListener('resize', () => { if (!v.hidden && S.view) { viewerFit(); kick(); } });
  })();

  /* ---------- notifications (Web Push, sent by the station itself) ---------- */
  // what this phone can do: 'ok' | 'install' (iPhone Safari tab: only a Home Screen app may get pushes) | 'no'
  const isStandalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  function pushSupport() {
    if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) return 'ok';
    if (/iPhone|iPad/.test(navigator.userAgent) && !isStandalone()) return 'install';
    return 'no';
  }
  S.push = { on: null, busy: false };   // on = the station holds a subscription for THIS phone (null until asked)
  function keyBytes(b64) { const bin = b64uDecode(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  async function refreshPush() {
    if (S.linkState !== 'open') return;
    try { const r = await call('pushKey'); if (r.ok) { S.push.on = !!r.data.on; S.push.key = r.data.key; } } catch (_) {}
  }
  async function pushOn() {
    if (S.push.busy) return;
    S.push.busy = true; render();
    try {
      const perm = await Notification.requestPermission();   // must run inside the tap that asked for it
      if (perm !== 'granted') { toast(perm === 'denied' ? 'Notifications are blocked for this app in your phone settings' : 'Notifications were not allowed', true); return; }
      if (!S.push.key) await refreshPush();
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      // a subscription made for another station's key (paired elsewhere before) would be refused by the push service
      const want = keyBytes(S.push.key), have = sub && sub.options && sub.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
      if (sub && (!have || have.length !== want.length || have.some((x, i) => x !== want[i]))) { await sub.unsubscribe(); sub = null; }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
      const j = sub.toJSON();
      const r = await call('pushOn', { endpoint: j.endpoint, keys: j.keys });
      if (!r.ok) { toast(r.error, true); return; }
      S.push.on = true;
      toast('Notifications on');
      // the first one proves the whole path; if the push service refuses it, say so rather than leave a silent switch
      call('pushTest').then((t) => { if (!t.ok) toast(t.error, true); }).catch(() => {});
    } catch (e) { toast('Could not turn notifications on: ' + ((e && e.message) || e), true); }
    finally { S.push.busy = false; render(); }
  }
  async function pushOff() {
    S.push.busy = true; render();
    try {
      await call('pushOff');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
      S.push.on = false; toast('Notifications off');
    } catch (e) { toast(e.message, true); }
    finally { S.push.busy = false; render(); }
  }
  const nudgeKey = 'starnet.remote.pushNudge';
  function nudgeDismissed() { try { return localStorage.getItem(nudgeKey) === '1'; } catch (_) { return false; } }
  function pushCard(compact) {
    const sup = pushSupport();
    const box = el('div', 'glass pad push-card');
    if (sup === 'install') {
      box.appendChild(el('div', 'push-h', 'Get a tap when your crew needs you'));
      box.appendChild(el('div', 'note-line', 'On iPhone, notifications work in the Home Screen app. Press PAIR A PHONE on your desktop, open the link here, and follow the steps: Copy, Add to Home Screen, Paste.'));
    } else if (sup === 'no') {
      box.appendChild(el('div', 'note-line', 'This browser cannot receive notifications.'));
    } else {
      box.appendChild(el('div', 'push-h', S.push.on ? 'Notifications are on' : 'Get a tap when your crew needs you'));
      box.appendChild(el('div', 'note-line', S.push.on
        ? 'Your station taps this phone when an agent needs your OK or has a question, and when a task you sent finishes.'
        : 'When an agent needs your OK, has a question, or finishes a task you sent, your station taps this phone, even with the app closed.'));
      const row = el('div', 'btns');
      const b = el('button', 'btn' + (S.push.on ? ' no' : ' go'), S.push.busy ? '…' : S.push.on ? 'Turn off' : 'Turn on'); b.type = 'button';
      b.disabled = S.push.busy || S.linkState !== 'open' || S.push.on === null;
      b.onclick = () => (S.push.on ? pushOff() : pushOn());
      row.appendChild(b);
      if (compact && !S.push.on) { const x = el('button', 'btn quiet', 'Not now'); x.type = 'button'; x.onclick = () => { try { localStorage.setItem(nudgeKey, '1'); } catch (_) {} render(); }; row.appendChild(x); }
      box.appendChild(row);
      if (compact) { box.classList.add('compact'); box.replaceChildren(el('div', 'push-h', 'Get a tap when your crew needs you'), row); }
    }
    return box;
  }
  // a notification tap: '#needs' opens STATION, '#thread=<id>' opens that conversation
  async function openFromPush(url) {
    const m = /^#thread=([A-Za-z0-9_-]{1,64})$/.exec(String(url || ''));
    if (m) {
      let t = S.threads.find(x => x.streamId === m[1]);
      if (!t) { await refreshThreads(); t = S.threads.find(x => x.streamId === m[1]); }
      const agentId = (t && t.agentId) || (((S.activity && S.activity.done) || []).find(r => r.streamId === m[1]) || {}).agentId || S.target;
      openThread(m[1], agentId); return;
    }
    if (url === '#needs') { closeViewer(); setTab('station'); }
  }

  /* ---------- rendering ---------- */
  const viewKey = () => (S.thread ? 'thread' : S.file ? 'file' : S.page ? S.page : S.tab);
  function setTab(t) {
    S.tab = t; S.thread = null; S.file = null; S.page = null;
    if (t === 'sessions') refreshThreads().then(() => render(true));
    if (t === 'sessions') refreshActivity().then(() => render(true));
    if (t === 'station') { refreshView(); Promise.all([refreshThreads(), refreshActivity()]).then(() => render(true)); }
    render();
  }

  // soft = a background refresh: never rebuild the screen under someone who is typing in it or has a finger on it
  let touching = false, softOwed = false;
  document.addEventListener('pointerdown', () => { touching = true; }, true);
  for (const n of ['pointerup', 'pointercancel']) document.addEventListener(n, () => { touching = false; if (softOwed) { softOwed = false; setTimeout(() => render(true), 60); } }, true);
  function render(soft) {
    const v = $('view');
    if (soft && v.contains(document.activeElement) && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName)) return;
    if (soft && touching) { softOwed = true; return; }
    const key = viewKey(), prevKey = v.dataset.key || '';
    S.scroll[prevKey] = v.scrollTop;
    const crewEl = v.querySelector('.crew'); const crewX = crewEl ? crewEl.scrollLeft : 0;
    const pushed = !!(S.thread || S.file || S.page);
    const needs = S.approvals.length;
    $('n-needs').hidden = !needs; $('n-needs').textContent = needs || '';
    for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
    $('back').hidden = !pushed; $('gear').hidden = pushed; $('tabs').hidden = pushed || S.linkState === 'removed';
    const openRow = S.thread && S.threads.find(x => x.streamId === S.thread.streamId);
    const bw = $('bar-well'); bw.hidden = !S.thread; if (S.thread) bw.replaceChildren(well(S.thread.agentId, 'sm'));
    const firstSaid = S.thread && (S.thread.turns || []).find(t => t.role === 'user');
    $('bar-title').textContent = S.thread ? ((openRow && (plain(openRow.title) || plain(openRow.preview))) || (firstSaid && plain(firstSaid.content).slice(0, 80)) || agentName(S.thread.agentId)) : S.file ? (S.file.name || 'FILE') : S.page === 'settings' ? 'SETTINGS'
      : S.tab === 'sessions' ? 'SESSIONS' :  ((S.status && S.status.station) || 'STATION');
    const sub = $('bar-sub'); sub.hidden = !S.thread;
    if (S.thread) sub.textContent = agentName(S.thread.agentId) + (streamLive(S.thread.streamId) ? ' · working' : '');
    const target = S.thread ? S.thread.agentId : S.target;
    $('compose').hidden = !(S.thread || !pushed) || S.linkState === 'removed';
    const to = $('compose-to'); to.replaceChildren(document.createTextNode('TO '), el('b', null, target ? agentName(target) : '—'));
    if (!S.thread && agents().length > 1) to.appendChild(icon('caret'));
    to.disabled = !!S.thread || agents().length < 2;
    $('compose-text').placeholder = S.thread ? 'Reply…' : target ? 'Give ' + agentName(target) + ' a task…' : 'Give your crew a task…';
    $('compose-send').disabled = S.linkState !== 'open' || !target;
    v.dataset.key = key;
    v.replaceChildren();
    if (S.linkState === 'removed') v.appendChild(removedCard());
    else if (S.file) renderFile(v);
    else if (S.thread) renderThread(v);
    else if (S.page === 'settings') renderSettings(v);
    else if (S.tab === 'station') renderStation(v);
    else if (S.tab === 'sessions') renderSessions(v);
    else renderSessions(v);
    if (key === prevKey) { v.scrollTop = S.scroll[key] || 0; const c = v.querySelector('.crew'); if (c) c.scrollLeft = crewX; }
    else v.scrollTop = key === 'thread' ? v.scrollHeight : (S.scroll[key] || 0);
  }

  function section(title, gold, more) {
    const s = el('div', 'sect'), h = el('div', 'label' + (gold ? ' gold' : ''), title);
    if (more) { const b = el('button', 'more', more.text); b.type = 'button'; b.onclick = more.go; h.appendChild(b); }
    s.appendChild(h);
    return s;
  }

  function removedCard() {
    const box = el('div', 'ask');
    box.appendChild(el('div', 'who', 'This phone was removed'));
    box.appendChild(el('div', 'what', 'The station no longer knows this phone. Pair it again from SETTINGS → DEVICES on your desktop.'));
    const b = el('button', 'btn', 'Pair again'); b.type = 'button';
    b.onclick = async () => { await RemoteStore.forget(); location.reload(); };
    const row = el('div', 'btns'); row.appendChild(b); box.appendChild(row);
    return box;
  }

  /* A PERMISSION ASK IN PLAIN WORDS. The station sends the tool's name and its arguments (a JSON object, which may be
     clipped mid-way, or a plain string). The card says what the agent wants to do and shows only the part worth
     reading (the file's text, the command), never the raw JSON. */
  function argsOf(s) {
    s = String(s || '');
    try { const o = JSON.parse(s); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch (_) {}
    const o = {}, re = /"([A-Za-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)("?)/g; let m;
    while ((m = re.exec(s))) {
      let v = m[2]; try { v = JSON.parse('"' + m[2] + '"'); } catch (_) { v = m[2].replace(/\\n/g, '\n').replace(/\\(["\\])/g, '$1'); }
      o[m[1]] = v; if (!m[3]) o._cut = true;
    }
    return o;
  }
  function askWhat(a) {
    const who = agentName(a.agentId), tool = String(a.tool || ''), t = tool.toLowerCase().replace(/_+/g, '.');
    const raw = String(a.argsSummary || '').trim(), o = argsOf(raw);
    const str = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v, null, 1));
    const cut = (v, n) => { const s = str(v); return s.length > n ? s.slice(0, n) + '…' : s; };
    const tail = (s) => (s && o._cut ? s + '\n… (cut short by the station)' : s);
    const file = str(o.path || o.file_path || o.filePath || o.file || o.target);
    const fileName = file.length > 42 ? file.split(/[\\/]/).pop() : file;
    const pm = /^plugin__(.+?)__(.+)$/.exec(tool);
    if (pm) return { line: who + ' wants to use the ' + pm[1] + ' plugin\'s "' + pm[2] + '" tool', detail: tail(listOf(o)) || cut(raw, 600) };
    if (/^plugin\.submit$/.test(t)) return { line: who + ' wants to install a plugin it built' + (o.id ? ' (' + o.id + ')' : '') + '. It stays off until you approve its code at the desk.', detail: '' };
    if (t === 'path.trust') return { line: who + ' wants to work with files in ' + (raw || 'a project folder'), detail: '' };
    if (t === 'browser.login') return { line: who + ' wants to open a browser on your PC so you can log in to ' + (raw || 'a website') + '. You type the password there; the agent never sees it.', detail: '' };
    if (t === 'browser.login.done') return { line: who + ' is waiting while you log in to ' + (raw || 'the website') + ' on your PC.', detail: '' };
    if (/^fs\.(write|append)$/.test(t) || (/write|append/.test(t) && file)) return { line: who + ' wants to ' + (/append/.test(t) ? 'add to ' : 'write ') + (fileName || 'a file'), detail: tail(cut(o.content || o.text || o.data, 1200)) };
    if (/^fs\.(edit|patch)$/.test(t) || (/edit|patch/.test(t) && file)) return { line: who + ' wants to change ' + (fileName || 'a file'), detail: tail(cut(o.new_string || o.newText || o.new || o.patch || o.content, 1200)) };
    if (/^(shell|terminal)\./.test(t)) return { line: who + ' wants to run a command on your PC', detail: tail(cut(o.command || o.cmd || o.input || o.data, 800)) || cut(raw, 600) };
    if (/notebook|memory/.test(t)) return { line: who + ' wants to save a note to its memory', detail: tail(cut(o.content || o.text || o.body, 600)) };
    if (/summon/.test(t)) return { line: who + ' wants to add a new agent to the crew', detail: tail(listOf(o)) };
    if (/^routine\.create$/.test(t)) return { line: who + ' wants to schedule a routine' + (o.name ? ' "' + o.name + '"' : '') + (o.schedule ? ', ' + o.schedule : ''), detail: tail(cut(o.prompt || o.task || o.instructions, 600)) };
    if (/^routine\.manage$/.test(t)) return { line: who + ' wants to ' + (o.action || 'change') + ' the routine' + (o.id ? ' "' + o.id + '"' : ''), detail: '' };
    if (/^station\.build$/.test(t)) return { line: who + ' wants to build on your station. One UNDO in Build mode takes it back.', detail: cut(raw, 900) };
    if (/^station\.make\.prop$/.test(t)) return { line: who + ' wants to make a new prop: ' + (raw.split('\n')[0] || 'a new prop'), detail: '' };
    if (/^web\.(request|fetch)$|^http/.test(t)) return { line: who + ' wants to reach ' + (str(o.url) || 'a website'), detail: tail(listOf(o, ['url'])) };
    return { line: who + ' wants to use ' + (t.replace(/\.+/g, ' ').trim() || 'a tool'), detail: tail(listOf(o)) || cut(raw, 600) };
  }
  // the arguments as "name: value" lines, for a tool the card has no words of its own for
  function listOf(o, skip) {
    return Object.keys(o).filter(k => k !== '_cut' && !(skip || []).includes(k))
      .map(k => k + ': ' + (typeof o[k] === 'string' ? o[k] : JSON.stringify(o[k]))).join('\n').slice(0, 900);
  }

  function askCard(a) {
    const box = el('div', 'ask');
    const isQ = a.kind === 'question';
    box.appendChild(el('div', 'who', agentName(a.agentId) + (isQ ? ' · QUESTION' : ' · ' + (a.scope || 'write').toUpperCase() + ' CHECK') + (a.surface === 'desk' ? ' · DESK RUN' : a.surface === 'channel' ? ' · CHANNEL' : '')));
    const arrived = S.arrivedAt.get(a.promptId) || Date.now();
    if (isQ) {
      let q = {}; try { q = JSON.parse(a.argsSummary || '{}'); } catch (_) {}
      box.appendChild(el('div', 'what', q.question || 'Your agent has a question.'));
      const opts = el('div', 'btns');
      for (const o of (q.options || []).slice(0, 6)) {
        const b = el('button', 'btn', o); b.type = 'button';
        b.onclick = () => replyQ(a, o, box);
        opts.appendChild(b);
      }
      if (opts.childNodes.length) box.appendChild(opts);
      const ta = el('textarea'); ta.rows = 2; ta.placeholder = 'Or type an answer…'; ta.value = S.drafts.get(a.promptId) || ''; ta.oninput = () => S.drafts.set(a.promptId, ta.value); box.appendChild(ta);
      const row = el('div', 'btns'); const send = el('button', 'btn go', 'Answer'); send.type = 'button';
      send.onclick = () => { if (ta.value.trim()) replyQ(a, ta.value, box); };
      row.appendChild(send); box.appendChild(row);
    } else {
      const w = askWhat(a);
      box.appendChild(el('div', 'what', w.line));
      if (w.detail) box.appendChild(el('pre', null, w.detail));
      const row = el('div', 'btns fill');
      const mk = (label, cls, decision) => { const b = el('button', 'btn ' + cls, label); b.type = 'button'; b.onclick = () => decide(a, decision, box); row.appendChild(b); };
      const session = !/^path\.trust$/.test(String(a.tool || ''));
      mk('Once', 'go', 'once'); if (session) mk('This task', '', 'session'); mk('Deny', 'no', 'deny');
      box.appendChild(row);
      const wait = Date.now() - arrived;
      box.appendChild(el('div', 'note', 'Asked ' + (wait < 60000 ? 'just now' : ago(wait) + ' ago') + '.' + (session ? ' "This task" lets it do this again until the task ends.' : '') + ' "Always" and full access are set at the desk.'));
    }
    if (S.linkState !== 'open') { for (const b of box.querySelectorAll('button')) b.disabled = true; box.appendChild(el('div', 'note', 'Reconnect to answer. If the station stays unreachable, it denies this on its own after a short wait.')); }
    // it is on a screen a person is looking at: earn the one bounded extension, once
    if (document.visibilityState === 'visible' && !S.seen.has(a.promptId)) { S.seen.add(a.promptId); call('seen', { runId: a.runId, promptId: a.promptId }).catch(() => {}); }
    return box;
  }
  async function decide(a, decision, box) {
    for (const b of box.querySelectorAll('button')) b.disabled = true;
    try {
      const r = await call('decide', { runId: a.runId, promptId: a.promptId, decision });
      if (!r.ok) { toast(r.error, true); for (const b of box.querySelectorAll('button')) b.disabled = false; return; }
      S.approvals = S.approvals.filter(x => x.promptId !== a.promptId);
      toast(decision === 'deny' ? 'Denied' : 'Approved');
    } catch (e) { toast(e.message, true); for (const b of box.querySelectorAll('button')) b.disabled = false; return; }
    render();
  }
  async function replyQ(a, text, box) {
    for (const b of box.querySelectorAll('button')) b.disabled = true;
    try {
      const r = await call('reply', { runId: a.runId, promptId: a.promptId, text: String(text) });
      if (!r.ok) { toast(r.error, true); for (const b of box.querySelectorAll('button')) b.disabled = false; return; }
      S.approvals = S.approvals.filter(x => x.promptId !== a.promptId);
      toast('Answered');
    } catch (e) { toast(e.message, true); for (const b of box.querySelectorAll('button')) b.disabled = false; return; }
    render();
  }

  // When the link is down, everything below is what the station LAST said. Say so, never pass it off as live.
  function staleNote(v) {
    if (S.linkState === 'open' || !S.lastOkAt) return;
    v.appendChild(el('div', 'note-line', 'Station offline. Showing what it last reported, ' + ago(Date.now() - S.lastOkAt) + ' ago.'));
  }

  // the newest finished run of each conversation, from the station's run history
  function lastRunByStream() {
    const m = new Map();
    for (const r of (S.activity && S.activity.done) || []) if (r.streamId && !m.has(r.streamId)) m.set(r.streamId, r);
    return m;
  }
  function sessionRow(t, lastRun) {
    const box = el('div', 'act');
    const row = el('button', 'row'); row.type = 'button';
    row.appendChild(well(t.agentId, 'sm'));
    const tt = el('span', 't');
    // the heading: the session's own title (not when that is just the agent's name), else what you said, else the agent
    const nm = agentName(t.agentId), t0 = plain(t.title);
    const ttl = t0 && t0.toLowerCase() !== String(nm).toLowerCase() ? t0 : '';
    const pv = plain(t.preview), head = ttl || pv || nm;
    tt.appendChild(el('b', null, head));
    // the last thing you said, unless the heading already is that (a session titled with its first message)
    const same = !pv || head === pv || ttl.slice(0, 40) === pv.slice(0, 40);
    const live = (streamLive(t.streamId) || ((S.activity && S.activity.live) || []).some(r => r.streamId === t.streamId)) && S.linkState === 'open';
    const lr = live ? null : lastRun;
    // under the title: how the latest piece of work went (its result line, or why it stopped), else what you said
    const line = lr ? (lr.state === 'done' ? plain(lr.result) : lr.state === 'stopped' ? 'Stopped' : 'Did not finish' + (lr.error ? ' · ' + lr.error : '')) : '';
    const extra = line || (same ? '' : pv);
    // a heading that is the agent's name already says whose it is: the line under it says what is in it
    const sub = head === nm ? (extra || (t.turns ? '' : 'No messages yet')) : nm + (extra ? ' · ' + extra : '');
    if (sub) tt.appendChild(el('span', lr ? 'why ' + lr.state : null, sub));
    row.appendChild(tt);
    row.appendChild(el('span', 'd' + (live ? ' work' : ''), live ? 'WORKING' : t.lastAt ? ago(Date.now() - t.lastAt) : ''));
    row.onclick = () => openThread(t.streamId, t.agentId);
    box.appendChild(row);
    if (lr && lr.files && lr.files.length) {
      const fl = el('div', 'act-files');
      for (const p of lr.files.slice(0, 4)) { const c = el('button', 'file-chip', String(p).split('/').pop()); c.type = 'button'; c.onclick = () => openFile(lr.agentId || t.agentId, p); fl.appendChild(c); }
      box.appendChild(fl);
    }
    return box;
  }

  function renderStation(v) {
    staleNote(v);
    paintHero();
    v.appendChild(hero.root);
    if (S.approvals.length) {
      const s = section('Needs you · ' + S.approvals.length, true);
      for (const a of S.approvals) s.appendChild(askCard(a));
      v.appendChild(s);
    }
    const list = agents();
    const working = list.filter(isWorking).length;
    const cs = section('Crew' + (list.length ? ' · ' + (working ? working + ' working' : list.length) : ''));
    if (!list.length) cs.appendChild(el('div', 'empty', S.linkState === 'open' ? 'No agents on this station yet.' : 'Waiting for the station…'));
    else {
      const strip = el('div', 'crew');
      for (const a of list.slice().sort((p, q) => (isWorking(q) ? 1 : 0) - (isWorking(p) ? 1 : 0))) {
        const w = isWorking(a);
        // the housed lamp says only what the station says: needs you (an open ask) gold, working amber, idle green;
        // no lamp while the link is down (the last word could be stale)
        const asking = S.linkState === 'open' && S.approvals.some(x => x.agentId === a.agentId);
        const m = el('button', 'mate' + (S.target === a.agentId ? ' sel' : '') + (w ? ' work' : '') + (asking ? ' ask' : '')); m.type = 'button';
        const pw = well(a.agentId);
        if (S.linkState === 'open') pw.appendChild(el('i', 'dot ' + (asking ? 'ask' : w ? 'work' : 'ok')));
        m.appendChild(pw);
        m.appendChild(el('b', null, a.name || a.agentId));
        // working: what it is doing in one word (from the station's newest step), and for how long
        const step = w ? lastStep(a.runId) : '';
        const em = el('em', null, S.linkState !== 'open' ? (a.state || 'idle') : w ? (step ? doing(step).word : 'working') : 'idle');
        if (w && a.runId) em.dataset.verb = a.runId;
        m.appendChild(em);
        if (w && a.since) { const c = el('em', 'clock', clock(Date.now() - a.since)); c.dataset.since = a.since; m.appendChild(c); }
        m.onclick = () => { setTarget(a.agentId); render(); kick(); };
        strip.appendChild(m);
      }
      cs.appendChild(strip);
    }
    v.appendChild(cs);
    // the station shows only where you left off; every session lives on the SESSIONS tab
    const ss = section('Latest', false, S.threads.length > 1 ? { text: 'ALL ' + S.threads.length + ' ›', go: () => setTab('sessions') } : null);
    if (!S.threads.length) ss.appendChild(el('div', 'empty', S.linkState === 'open' ? 'No sessions yet. Write a task below to start one.' : 'Waiting for the station…'));
    else { const l = el('div', 'list'); l.appendChild(sessionRow(S.threads[0], lastRunByStream().get(S.threads[0].streamId))); ss.appendChild(l); }
    v.appendChild(ss);
    if (S.push.on === false && pushSupport() !== 'no' && !nudgeDismissed()) v.appendChild(pushCard(true));
  }

  function renderSessions(v) {
    staleNote(v);
    if (S.approvals.length) {
      const s = section('Needs you · ' + S.approvals.length, true);
      for (const a of S.approvals) s.appendChild(askCard(a));
      v.appendChild(s);
    }
    const running = (S.activity && S.activity.live) || [];
    if (running.length) {
      const s = section('Working now · ' + running.length), l = el('div', 'list');
      for (const w of running) l.appendChild(activityRow(w, true));
      s.appendChild(l); v.appendChild(s);
    }
    const lr = lastRunByStream();
    const q = el('input', 'search'); q.type = 'search'; q.placeholder = 'Search sessions'; q.value = S.query; q.autocapitalize = 'off'; q.setAttribute('aria-label', 'Search sessions');
    const l = el('div', 'list');
    const fill = () => {
      const needle = S.query.trim().toLowerCase();
      const rows = needle ? S.threads.filter(t => [t.title, t.preview, agentName(t.agentId)].join(' ').toLowerCase().indexOf(needle) >= 0) : S.threads;
      l.replaceChildren();
      if (!rows.length) l.appendChild(el('div', 'empty', needle ? 'Nothing matches that.' : S.linkState === 'open' ? 'No sessions yet. Write a task below to start one.' : 'Waiting for the station…'));
      for (const t of rows) l.appendChild(sessionRow(t, lr.get(t.streamId)));
    };
    q.addEventListener('input', () => { S.query = q.value; fill(); });
    const all = section('All sessions' + (S.threads.length ? ' · ' + S.threads.length : ''));
    if (S.threads.length > 6 || S.query) all.appendChild(q);
    fill();
    all.appendChild(l); v.appendChild(all);
  }

  async function openThread(streamId, agentId, keepScroll) {
    const same = S.thread && S.thread.streamId === streamId;
    S.thread = { streamId, agentId, turns: same ? S.thread.turns : null };
    S.file = null; S.page = null; S.target = agentId;
    const v = $('view'), atEnd = v.scrollHeight - v.scrollTop - v.clientHeight < 80;
    render();
    // a refresh keeps every page already loaded (it re-reads as many turns as are on screen, at least the newest 80)
    const want = Math.max(80, (same && S.thread.turns && S.thread.turns.length) || 0);
    try {
      const r = await call('thread', { streamId, limit: Math.min(200, want), page: true });
      if (r.ok && S.thread && S.thread.streamId === streamId) {
        const d = r.data;
        if (Array.isArray(d)) { S.thread.turns = d; S.thread.earlier = 0; }   // an older station answers with the bare list
        else { S.thread.turns = d.turns || []; S.thread.earlier = Number(d.earlier) || 0; }
      }
    } catch (e) { toast(e.message, true); }
    render();
    if (!keepScroll || atEnd) v.scrollTop = v.scrollHeight;
  }

  // the older part of a long conversation, a page at a time, above what is on screen
  async function loadEarlier(btn) {
    const t = S.thread; if (!t || !t.turns) return;
    btn.disabled = true; btn.textContent = 'Loading…';
    try {
      const r = await call('thread', { streamId: t.streamId, limit: 80, before: t.turns.length, page: true });
      if (r.ok && S.thread === t && r.data && Array.isArray(r.data.turns)) {
        const v = $('view'), fromBottom = v.scrollHeight - v.scrollTop;
        t.turns = r.data.turns.concat(t.turns); t.earlier = Number(r.data.earlier) || 0;
        render(); v.scrollTop = v.scrollHeight - fromBottom;   // keep the reader where they were
        return;
      }
    } catch (e) { toast(e.message, true); }
    btn.disabled = false; btn.textContent = 'Show earlier';
  }
  function renderThread(v) {
    const log = el('div', 'log');
    const turns = S.thread.turns;
    if (turns && S.thread.earlier > 0) {
      const b = el('button', 'btn quiet earlier', 'Show earlier · ' + S.thread.earlier); b.type = 'button';
      b.onclick = () => loadEarlier(b);
      log.appendChild(b);
    }
    if (!turns) log.appendChild(el('div', 'empty', 'Loading…'));
    else {
      const shown = turns.filter(t => (t.role === 'user' || t.role === 'assistant') && t.content && t.content !== 'null');
      shown.forEach((t, i) => {
        const m = el('div', 'msg ' + (t.role === 'user' ? 'user' : 'agent'));
        m.appendChild(el('span', 'who', t.role === 'user' ? 'YOU' : agentName(t.agentId || S.thread.agentId).toUpperCase()));
        const q = t.role === 'assistant' ? questionOf(t.content) : null;
        if (!q) { m.appendChild(mdNode(t.content)); log.appendChild(m); return; }
        if (q.before) m.appendChild(mdNode(q.before));
        const box = el('div', 'qcard');
        box.appendChild(el('div', 'q', q.question));
        // only the newest question can still be answered (anything later means it was answered already)
        const open = i === shown.length - 1 && !streamLive(S.thread.streamId) && S.linkState === 'open';
        if (q.options.length) {
          const row = el('div', 'btns');
          for (const o of q.options) { const b = el('button', 'btn' + (open ? '' : ' quiet'), o); b.type = 'button'; b.disabled = !open; if (open) b.onclick = () => { $('compose-text').value = o; send(); }; row.appendChild(b); }
          box.appendChild(row);
        }
        if (open) box.appendChild(el('div', 'note-line', q.options.length ? 'Tap an answer, or type your own below.' : 'Type your answer below.'));
        m.appendChild(box);
        log.appendChild(m);
      });
    }
    const mine = S.approvals.filter(a => [...S.live.entries()].some(([rid, L]) => rid === a.runId && L.streamId === S.thread.streamId));
    for (const a of mine) log.appendChild(askCard(a));
    const liveBox = el('div', 'log'); liveBox.id = 'live'; log.appendChild(liveBox);
    v.appendChild(log);
    renderLive();
  }

  function renderLive() {
    const box = $('live'); if (!box || !S.thread) return;
    const v = $('view'), atEnd = v.scrollHeight - v.scrollTop - v.clientHeight < 80;
    box.replaceChildren();
    for (const [runId, L] of S.live) {
      if (L.streamId !== S.thread.streamId || L.ended) continue;
      for (const s of L.steps.slice(-6)) {
        const d = el('div', 'step');
        // a call the Task Brief held did not run: a dim ▸ and "not run yet", never ✕ (it runs once the brief settles)
        if (s.held) d.appendChild(el('b', 'h', '▸'));
        else d.appendChild(el('b', s.ok === false ? 'x' : s.ok === null ? 'w' : null, s.ok === null ? '…' : s.ok ? '✓' : '✕'));
        d.appendChild(el('span', null, doing(s.name).phrase + (s.held ? ' · not run yet' : ''))); box.appendChild(d);
      }
      if (L.text) { const m = el('div', 'msg agent'); m.appendChild(el('span', 'who', agentName(L.agentId).toUpperCase())); m.appendChild(mdNode(L.text)); box.appendChild(m); }
      const w = el('div', 'working'); w.appendChild(el('i')); w.appendChild(el('span', null, agentName(L.agentId) + ' is working'));
      box.appendChild(w);
      const stop = el('button', 'btn no', 'Stop'); stop.type = 'button';
      stop.onclick = async () => { stop.disabled = true; try { const r = await call('stop', { runId }); toast(r.ok ? 'Stopped' : r.error, !r.ok); } catch (e) { toast(e.message, true); } };
      const row = el('div', 'btns'); row.appendChild(stop); box.appendChild(row);
    }
    if (atEnd) v.scrollTop = v.scrollHeight;
  }

  /* ---------- ACTIVITY: what the station is doing and what it did ----------
     Straight from the station's run history: what needs you, what is running now, what finished (its result line,
     how it ended, the files it made). Tapping a piece of work opens its conversation; tapping a file opens it. */
  async function refreshActivity() { try { const r = await call('activity', { limit: 30 }); if (r.ok) S.activity = r.data; } catch (_) {} }
  let activityTimer = null;
  function activitySoonish() { clearTimeout(activityTimer); activityTimer = setTimeout(() => refreshActivity().then(() => render(true)), 500); }
  const SOURCE = { remote: 'from your phone', interactive: 'at the desk', cron: 'routine', channel: 'from a channel', host: 'autonomy', overseer: 'review' };
  const stepLine = (name) => doing(name).phrase;
  function activityRow(w, live) {
    const box = el('div', 'act' + (live ? ' live' : ''));
    const row = el(w.streamId ? 'button' : 'div', 'row'); if (w.streamId) row.type = 'button';
    const pw = well(w.agentId, 'sm'); if (live) pw.appendChild(el('i', 'dot work')); row.appendChild(pw);
    const t = el('span', 't');
    t.appendChild(el('b', null, plain(w.title) || (live ? agentName(w.agentId) + ' is working' : 'Work by ' + agentName(w.agentId))));
    const line = live ? agentName(w.agentId) + (SOURCE[w.source] ? ' · ' + SOURCE[w.source] : '')
      : w.state === 'done' ? (plain(w.result) || agentName(w.agentId) + ' finished') : w.state === 'stopped' ? 'Stopped' : 'Did not finish' + (w.error ? ' · ' + w.error : '');
    const sub = el('span', live ? null : 'why ' + w.state, line);
    if (live) {
      const last = lastStep(w.runId);
      if (last) sub.textContent = stepLine(last);
      sub.dataset.step = w.runId;
    }
    t.appendChild(sub);
    row.appendChild(t);
    const dd = el('span', 'd' + (live ? ' work' : ''), live ? (w.startedAt ? clock(Date.now() - w.startedAt) : 'NOW') : (w.endedAt ? ago(Date.now() - w.endedAt) : ''));
    if (live && w.startedAt) dd.dataset.since = w.startedAt;
    row.appendChild(dd);
    if (w.streamId) row.onclick = () => openThread(w.streamId, w.agentId);
    box.appendChild(row);
    if (w.files && w.files.length) {
      const fl = el('div', 'act-files');
      for (const p of w.files.slice(0, 4)) { const c = el('button', 'file-chip', String(p).split('/').pop()); c.type = 'button'; c.onclick = () => openFile(w.agentId, p); fl.appendChild(c); }
      box.appendChild(fl);
    }
    return box;
  }

  async function openFile(agentId, filePath) {
    S.file = { agentId, path: filePath, name: filePath.split('/').pop(), loading: true };
    render();
    const parts = []; let meta = null, offset = 0;
    try {
      for (let i = 0; i < 80; i++) {   // 80 × 256 KB = 20 MB ceiling on a phone
        const r = await call('fetch', { agentId, path: filePath, offset });
        if (!r.ok) throw new Error(r.error);
        meta = r.data; parts.push(bytesOf(meta.data)); offset += meta.bytes;
        if (meta.eof || !meta.bytes) break;
      }
      if (!S.file || S.file.path !== filePath) return;
      S.file = Object.assign(S.file, { loading: false, mime: meta.mime, active: meta.active, blob: new Blob(parts, { type: meta.active ? 'application/octet-stream' : meta.mime }), size: meta.size, name: meta.name || S.file.name });
    } catch (e) { S.file.loading = false; S.file.error = e.message; }
    render();
  }

  function renderFile(v) {
    const f = S.file, box = el('div', 'viewer-file');
    if (f.loading) { box.appendChild(el('div', 'empty', 'Fetching ' + f.name + '…')); v.appendChild(box); return; }
    if (f.error) { box.appendChild(el('div', 'err-line', f.error)); v.appendChild(box); return; }
    const url = URL.createObjectURL(f.blob);
    if (!f.active && /^image\//.test(f.mime)) { const img = el('img'); img.src = url; img.alt = f.name; box.appendChild(img); }
    else if (!f.active && /^(text\/|application\/json)/.test(f.mime)) { const pre = el('pre'); f.blob.text().then(t => { pre.textContent = t.slice(0, 200000); }); box.appendChild(pre); }
    else box.appendChild(el('div', 'empty', f.active ? 'This file can run code, so it is not opened here. Save it and open it yourself if you trust it.' : 'No preview for this type.'));
    const a = el('a', 'btn', 'Save to phone'); a.href = url; a.download = f.name;
    const row = el('div', 'btns fill'); row.appendChild(a); box.appendChild(row);
    box.appendChild(el('div', 'hint', Math.round(f.size / 1024) + ' KB · ' + f.mime));
    v.appendChild(box);
  }

  function renderSettings(v) {
    const ns = section('Notifications'); ns.appendChild(pushCard(false)); v.appendChild(ns);
    if (S.routines.length) {
      const rs = section('Routines'), l = el('div', 'list');
      for (const j of S.routines) {
        const row = el('div', 'row');
        // `held`: the station's scheduling is OFF or E-STOPped — no routine fires, so no live dot and no cadence for it
        row.appendChild(el('i', 'dot' + (j.inFlight ? ' work' : (j.enabled && !j.held) ? ' ok' : '')));
        const t = el('span', 't');
        t.appendChild(el('b', null, j.name || j.prompt || j.id));
        const when = j.held === 'halted' ? 'not running — E-STOP is on' : j.held === 'off' ? 'not running — scheduling is off' : j.enabled ? (j.schedule || 'scheduled') : 'paused';
        t.appendChild(el('span', null, when + (j.agentId ? ' · ' + agentName(j.agentId) : '')));
        row.appendChild(t);
        const b = el('button', 'btn', j.enabled ? 'Pause' : 'Resume'); b.type = 'button';
        b.onclick = async () => {
          b.disabled = true;
          try { const res = await call('routine', { jobId: j.id, enabled: !j.enabled }); if (!res.ok) toast(res.error, true); else toast(res.data.enabled ? 'Resumed' : 'Paused'); } catch (e) { toast(e.message, true); }
          await refreshRoutines(); render();
        };
        row.appendChild(b);
        l.appendChild(row);
      }
      rs.appendChild(l); v.appendChild(rs);
    }
    const s = section('This phone'), card = el('div', 'glass pad');
    const r = S.rec && S.rec.station;
    const lines = [
      ['Station', (S.status && S.status.station) || (r && r.stationId) || '—'],
      ['Phone name', (r && r.name) || '—'],
      ['Phone code', (r && r.fingerprint) || '—'],
      ['Relay', (r && r.relay) || '—'],
      ['Link', S.linkState === 'open' ? 'linked' + (S.latency != null ? ', ' + S.latency + ' ms' : '') : S.linkState]
    ];
    const kvs = el('div');
    for (const [k, val] of lines) { const row = el('div', 'kv'); row.appendChild(el('span', null, k)); row.appendChild(el('b', null, val)); kvs.appendChild(row); }
    card.appendChild(kvs);
    card.appendChild(el('div', 'note-line', 'Everything between this phone and your station is sealed end to end. The relay only passes it along.'));
    s.appendChild(card); v.appendChild(s);
    const fs = section('Forget this station');
    fs.appendChild(el('div', 'note-line', 'Removes the pairing from this phone. You can pair again from the desk.'));
    const b = el('button', 'btn no', 'Forget station'); b.type = 'button';
    let armed = false;
    b.onclick = async () => {
      if (!armed) { armed = true; b.textContent = 'Tap again to forget'; setTimeout(() => { armed = false; b.textContent = 'Forget station'; }, 4000); return; }
      try { S.client && S.client.close(); } catch (_) {}
      await RemoteStore.forget(); location.replace(location.pathname);
    };
    const row = el('div', 'btns'); row.appendChild(b); fs.appendChild(row); v.appendChild(fs);
  }

  /* ---------- the agent picker (a sheet from the bottom) ---------- */
  function openSheet() {
    const body = $('sheet-body'), l = el('div', 'list');
    for (const a of agents()) {
      const row = el('button', 'row' + (S.target === a.agentId ? ' sel' : '')); row.type = 'button';
      const pw = well(a.agentId, 'sm'); if (isWorking(a)) pw.appendChild(el('i', 'dot work'));
      row.appendChild(pw);
      const t = el('span', 't'); t.appendChild(el('b', null, a.name || a.agentId));
      t.appendChild(el('span', null, isWorking(a) ? 'working' : 'idle' + (a.model ? ' · ' + a.model : '')));
      row.appendChild(t);
      row.onclick = () => { setTarget(a.agentId); closeSheet(); render(); };
      l.appendChild(row);
    }
    body.replaceChildren(l);
    $('sheet').hidden = false; $('sheet-scrim').hidden = false;
  }
  function closeSheet() { $('sheet').hidden = true; $('sheet-scrim').hidden = true; }

  /* ---------- composer ---------- */
  async function send() {
    const ta = $('compose-text'); const text = ta.value.trim();
    const agentId = S.thread ? S.thread.agentId : S.target;
    if (!text || !agentId) return;
    $('compose-send').disabled = true;
    try {
      const r = await call('send', { agentId, text, streamId: S.thread ? S.thread.streamId : undefined });
      if (!r.ok) { toast(r.error, true); return; }
      ta.value = ''; autosize();
      S.live.set(r.data.runId, S.live.get(r.data.runId) || { streamId: r.data.streamId, agentId, text: '', steps: [], ended: null, seenAt: Date.now() });
      await openThread(r.data.streamId, agentId);
      refreshThreads();   // so the new session is in the list when you go back
    } catch (e) { toast(e.message, true); }
    finally { $('compose-send').disabled = S.linkState !== 'open'; }
  }
  function autosize() { const ta = $('compose-text'); ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; }

  /* ---------- pairing ---------- */
  const DECK = ['bar', 'view', 'tabs'];
  function showSetup(pairing) { $('setup').hidden = false; $('setup-install').hidden = true; $('setup-pairing').hidden = !pairing; $('setup-howto').hidden = !!pairing; for (const id of DECK.concat('compose')) $(id).hidden = true; }
  function showDeck() { $('setup').hidden = true; for (const id of DECK) $(id).hidden = false; }

  async function pairFrom(blob) {
    let p; try { p = JSON.parse(b64uDecode(blob)); } catch (_) { throw new Error('That pairing link is damaged. Make a new one on the desktop.'); }
    if (!p || p.v !== PhoneClient.VERSION || !p.s || !p.p || !p.c) throw new Error('That pairing link is from a different version of StarNet.');
    const relay = p.r || location.origin;
    showSetup(true);
    $('setup-fp').textContent = await PhoneClient.fingerprint(p.s);
    const key = await PhoneClient.makeDeviceKey();
    const name = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Phone';
    const res = await PhoneClient.pairRelay({ relay, stationPub: p.s, pairingId: p.p, code: p.c, name, key });
    const rec = { key, station: { stationId: res.stationId || p.i, stationPub: p.s, deviceId: res.deviceId, relayToken: res.relayToken, relay, name, fingerprint: res.fingerprint, pairedAt: Date.now() } };
    await RemoteStore.save(rec);
    return rec;
  }

  const looking = () => document.visibilityState === 'visible' && S.linkState === 'open';
  /* GETTING ONTO THE HOME SCREEN. On iPhone a Home Screen app gets its OWN storage, apart from Safari: a phone paired in
     Safari opens from the Home Screen unpaired, and its one-time code is already spent. So on an iPhone the pairing link
     does NOT pair in Safari. It walks you through copying the link and adding StarNet to the Home Screen, and the Home
     Screen app pairs from a single Paste. Everywhere else (Android, desktop) the link pairs straight away. */
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const PAIR_RE = /[#&]pair=([A-Za-z0-9_-]{20,})/;
  function showInstall(blob) {
    $('setup').hidden = false; $('setup-install').hidden = false; $('setup-pairing').hidden = true; $('setup-howto').hidden = true;
    for (const id of DECK.concat('compose')) $(id).hidden = true;
    const link = location.origin + location.pathname + '#pair=' + blob;
    const copy = $('install-copy');
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(link); copy.textContent = 'Copied'; copy.classList.add('done'); toast('Link copied. Now add StarNet to your Home Screen.'); }
      catch (_) { toast('Could not copy here. Use it in Safari instead, or press PAIR A PHONE again.', true); }
    };
    $('install-here').onclick = () => pairAndStart(blob);
  }
  async function pairAndStart(blob) {
    try { S.rec = await pairFrom(blob); toast('Paired'); }
    catch (e) { showSetup(true); $('setup-err').textContent = friendlyPairError(e); $('setup-err').hidden = false; $('setup-retry').hidden = false; return; }
    startDeck();
  }
  function friendlyPairError(e) {
    const m = String((e && e.message) || e || '');
    if (/expired|already used/i.test(m)) return 'That pairing link was already used or ran out. On your desktop press PAIR A PHONE again and use the new one.';
    if (/already paired/i.test(m)) return 'This phone is already paired. If it lost its pairing, remove it on the desktop (SETTINGS → DEVICES) and pair again.';
    return m || 'Pairing did not work. Press PAIR A PHONE on your desktop for a fresh link.';
  }
  async function pasteAndPair() {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch (_) { text = ''; }
    const m = PAIR_RE.exec(text || '');
    if (!m) { $('setup-howto').querySelector('details').open = true; toast(text ? 'That is not a StarNet pairing link' : 'Nothing to paste. Copy the pairing link first, or paste it below.', true); return; }
    pairAndStart(m[1]);
  }
  async function boot() {
    const m = PAIR_RE.exec(location.hash || '');
    if (m) {
      history.replaceState(null, '', location.pathname);   // the one-time code leaves the address bar at once
      if (isIOS() && !isStandalone()) return showInstall(m[1]);   // pair in the Home Screen app, where it will live
      return pairAndStart(m[1]);
    }
    try { S.rec = await RemoteStore.load(); } catch (_) { S.rec = null; }
    if (!S.rec) return showSetup(false);
    startDeck();
  }
  /* The app opens on the last picture this phone saw, at once, stamped with its true age ("AS OF 3M AGO") — never
     passed off as live — and the fresh one replaces it as soon as the link is up. */
  async function restoreView() {
    let v = null;
    try { v = await RemoteStore.loadView(); } catch (_) { v = null; }
    if (!v || !v.blob || !v.meta || S.view) return;
    const url = URL.createObjectURL(v.blob), pre = new Image(); pre.src = url;
    try { await pre.decode(); } catch (_) { URL.revokeObjectURL(url); return; }
    if (S.view) { URL.revokeObjectURL(url); return; }   // the fresh one won the race
    const m = v.meta;
    S.view = { at: m.at, w: m.w, h: m.h, scale: Number(m.scale) || 0, bodies: m.bodies || [], crewFree: !!m.crewFree, url,
      age0: Math.max(0, (Number(m.age0) || 0) + (Date.now() - (Number(v.savedAt) || Date.now()))), seenAt: Date.now() };
    scene.base = pre; scene.crop = null;
    paintHero();
  }
  let deckStarted = false;
  function startDeck() {
    if (deckStarted) return;
    deckStarted = true;
    showDeck(); paintLamp(); render(); connect();
    restoreView();
    const openHash = /^#(needs|thread=[A-Za-z0-9_-]{1,64})$/.test(location.hash) ? location.hash : '';
    if (openHash) { history.replaceState(null, '', location.pathname); setTimeout(() => openFromPush(openHash), 2500); }
    if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'open') openFromPush(e.data.url); });
    setInterval(ping, 20000);
    setInterval(() => { if (document.visibilityState !== 'visible') return; for (const n of document.querySelectorAll('[data-since]')) n.textContent = clock(Date.now() - Number(n.dataset.since)); }, 1000);
    setInterval(() => { if (looking()) refreshStatus().then(() => { if (S.tab === 'sessions' && !S.thread && !S.file && !S.page) return refreshActivity(); }).then(() => { render(true); ensurePortraits(); }); paintLamp(); }, 10000);
    // the station picture: asked for only while it is on screen, which is also what keeps the desk drawing it
    setInterval(() => {
      const onScreen = !$('viewer').hidden || (S.tab === 'station' && !S.thread && !S.file && !S.page);
      if (looking() && onScreen) refreshView(); else if (S.view) paintHero();
    }, 4000);
  }

  $('back').appendChild(icon('back')); $('gear').appendChild(icon('gear')); $('compose-send').appendChild(icon('send'));
  for (const s of document.querySelectorAll('[data-ico]')) s.appendChild(icon(s.dataset.ico));
  $('setup-go').onclick = () => { const v = $('setup-link').value.trim(); const m = PAIR_RE.exec(v); if (!m) { toast('Paste the whole pairing link from the desktop', true); return; } pairAndStart(m[1]); };
  $('setup-paste').onclick = pasteAndPair;
  $('setup-retry').onclick = () => location.replace(location.pathname);
  $('compose-send').onclick = send;
  $('compose-to').onclick = openSheet;
  $('sheet-scrim').onclick = closeSheet;
  $('compose-text').addEventListener('input', autosize);
  $('compose-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); send(); } });
  $('back').onclick = () => {
    const wasThread = !!S.thread;
    S.thread = null; S.file = null; S.page = null; render();
    if (S.tab === 'station') refreshView();
    if (wasThread) refreshThreads().then(() => render(true));
  };
  $('gear').onclick = () => { S.page = 'settings'; refreshRoutines().then(() => render(true)); render(); };
  for (const b of document.querySelectorAll('.tab')) b.onclick = () => setTab(b.dataset.tab);
  /* BACK IN FRONT. A phone freezes a backgrounded app's socket, and on return it can still look open while it is dead:
     every call then waited out its 30 s timeout before anything moved. Prove the link with one quick ping, or start a
     fresh one at once (no back-off: the person is looking right now). Same when the phone gets signal back. */
  async function resume() {
    if (!S.rec || document.visibilityState !== 'visible') return;
    if (S.linkState !== 'open') { if (S.linkState !== 'removed') connect(); return; }
    const c = S.client;
    try { await c.call('ping', {}, 2500); if (c === S.client) { S.lastOkAt = Date.now(); refreshAll(); } }
    catch (_) { if (c === S.client && S.linkState !== 'removed') { S.retryMs = 1000; connect(); } }
  }
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('pageshow', (e) => { if (e.persisted) resume(); });
  window.addEventListener('online', () => { if (S.rec && S.linkState !== 'open' && S.linkState !== 'removed') { S.retryMs = 1000; connect(); } });

  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!window.isSecureContext || !(window.crypto && crypto.subtle)) {
    showSetup(false);
    $('setup-howto').replaceChildren(el('p', 'err-line', 'This page must be opened over HTTPS. Open the pairing link your desktop shows.'));
    return;
  }
  boot();
})();
