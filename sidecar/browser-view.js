/* sidecar/browser-view.js — THE STATION BROWSER: one built-in browser the Commander and the agents SHARE.

   WHY THIS EXISTS (Andrew, 2026-09-30, after trying the first cut: "the agent is not using the built in browser or
   controlling it at all, and cant see anything"). The first cut gave every run its own private Chrome that died with
   the run, and the Commander a second browser nobody else could see — so "open YouTube" happened in a browser that
   was gone by the time you looked, and "do you see Google?" was asked of a browser that never had it. The model
   people expect (Claude Code's browser pane, Codex's in-app browser) is ONE browser:

     · the agent DRIVES it — an interactive (COMMS) run's browser.* tools are bound to this session, not a private one;
     · it is a REAL Chrome window on the Commander's screen (index.js: preferVisible) — they use it natively, and the
       BROWSER window in the station mirrors and controls it (a live picture, an address bar, bring-to-front);
     · the Commander WATCHES the agent drive it, during the run and after it (it stays open);
     · the Commander USES it between runs — a typed address, clicks and keys go to the same page the agent will see;
     · it holds the ONE durable station profile, so a sign-in made here — by either of you — is there next time.

   ONE DRIVER AT A TIME. While a run is driving, the Commander's input is refused (they watch); taking the wheel
   mid-run is STEP-IN's handoff (browser-handoff.js) and nothing else. When nobody is driving, the Commander drives.
   A second interactive run that starts while another is driving gets a private per-run browser exactly as before
   (sessionForRun returns null), and so does every unattended run (cron, night shift, channels).

   THE PROFILE LEASE. The durable profile is a single-owner lease. The station browser holds it while open and NEVER
   gives it up to another run (Andrew: it "constantly closes" — a browser closing under you is the bug): a run that
   loses to it browses on a temporary profile instead (index.js browserProfileLeaseFor → fallback). A VISIBLE station
   browser never idles out (the Commander may be using the window directly, which the station cannot see): it closes
   when they close it. Only a headless one (STARNET_BROWSER_HEADLESS) closes after half an hour unused. If the window
   is closed or Chrome dies, the next use starts it again on the same profile (browser.js reviveIfDead).

   LAWS
     · Truthful telemetry: `open` means the session really has a browser; `driver` is the run bound right now;
       `remembered` is the session's own profile answer. The address shown is the one Chrome reports.
     · No agent receives anything from here: frames and input flow between the station page and Chrome only.
     · Every ref dies when the browser changes hands (session.handTo): the page may be one the Commander opened.
     · Pure: clock and timers are injected; the composition root (index.js) supplies them. */
'use strict';
const { swallow, note: failNote } = require('./failopen.js');
const { sanitizeInput } = require('./browser-handoff.js');

const FRAME_POLL_MAX_MS = 12000;
const VIEW_POLL_MS = 2500;                 // a still page answers this often, so the address shown is never long stale
const STREAM_IDLE_MS = 6000;               // nobody polled a picture for this long → stop capturing it
const STATION_IDLE_MS = 30 * 60 * 1000;    // nobody driving, nobody watching for this long → the browser closes
const VIEWER_RECENT_MS = 15000;            // a picture was asked for this recently → somebody is watching
const PAGE_INFO_EVERY_MS = 300;
const SEARCH_URL = 'https://duckduckgo.com/?q=';
/* WHERE THE STATION BROWSER LIVES (Settings → Browser, Andrew 2026-09-30 — Claude Code has the same split):
     window  — a real Chrome / Edge window on the desktop that the Commander and the agents share (DEFAULT — this is
               what Hermes does: its agent drives a real browser window on its own profile, and people sign in, type
               and paste there natively). The BROWSER window follows it. Where no window can open (no screen, no
               Chromium-family browser installed, or a headless pin) the station browses built-in and says so;
     builtin — hidden inside StarNet: the BROWSER window is the browser; nothing opens on the desktop;
     chrome  — YOUR own Chrome with your logins, through the StarNet extension, asking per site. Not available
               until the extension is paired; until then the station says so and browses built-in. */
const BROWSER_MODES = ['builtin', 'window', 'chrome'];
function normalizeMode(m) { return BROWSER_MODES.indexOf(String(m || '')) >= 0 ? String(m) : 'window'; }

/* What the Commander typed → the address to open. A scheme is kept; a bare host gets https (http for loopback —
   a dev server rarely has a certificate); anything that is not address-shaped becomes a web search. Only http(s)
   ever comes out: file:, chrome:, javascript: and friends are refused. */
function resolveAddress(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { ok: false, error: 'type an address' };
  if (text.length > 2000) return { ok: false, error: 'that address is too long' };
  let candidate = text;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  const loopbackHost = h => /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(h) || /\.localhost$/i.test(h);
  if (scheme && !/^[^/:]+:\d{1,5}(\/|$)/.test(text)) {   // "localhost:3000/x" is host:port, not a scheme
    if (!/^https?$/i.test(scheme[1])) return { ok: false, error: 'only http and https addresses open here' };
  } else if (/\s/.test(text) || !/^[^/]+\.[^/]+|^localhost\b|^\[?[0-9a-f:.]+\]?(:\d+)?(\/|$)/i.test(text)) {
    return { ok: true, url: SEARCH_URL + encodeURIComponent(text), local: false, search: true };
  } else {
    const hostPart = text.split('/')[0].replace(/:\d+$/, '');
    candidate = (loopbackHost(hostPart) ? 'http://' : 'https://') + text;
  }
  let u;
  try { u = new URL(candidate); } catch (_) { return { ok: true, url: SEARCH_URL + encodeURIComponent(text), local: false, search: true }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'only http and https addresses open here' };
  return { ok: true, url: u.href, local: loopbackHost(u.hostname), search: false };
}

function makeBrowserViews(deps) {
  deps = deps || {};
  if (typeof deps.now !== 'function') throw new Error('browser-view requires deps.now (the composition root injects the clock)');
  const now = deps.now;
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const handoffLive = typeof deps.handoffLive === 'function' ? deps.handoffLive : () => false;
  const makeSession = typeof deps.makeStationSession === 'function' ? deps.makeStationSession : null;
  const readMode = typeof deps.readMode === 'function' ? deps.readMode : () => 'window';
  const writeMode = typeof deps.writeMode === 'function' ? deps.writeMode : () => {};
  const chromeAvailable = typeof deps.chromeAvailable === 'function' ? deps.chromeAvailable : () => false;
  const windowAvailable = typeof deps.windowAvailable === 'function' ? deps.windowAvailable : () => true;
  // first-use download of a browser on a computer that has none (sidecar/browser-install.js): its progress, for the window
  const browserSetup = typeof deps.browserSetup === 'function' ? deps.browserSetup : () => null;
  function setupState() { try { const s = browserSetup(); return s ? { state: s.state, received: s.received || 0, total: s.total || 0, error: s.error || null } : null; } catch (e) { failNote('view.setup', e); return null; } }
  /* the mode the station browser actually RUNS in: a Chrome window needs a screen and an installed browser (else
     built-in); YOUR CHROME needs the paired extension (else the best of the other two). */
  function effectiveMode() {
    const m = normalizeMode(readMode());
    const win = !!windowAvailable();
    if (m === 'chrome' && !chromeAvailable()) return win ? 'window' : 'builtin';
    if (m === 'window' && !win) return 'builtin';
    return m;
  }
  const downloadDirFor = typeof deps.downloadDirFor === 'function' ? deps.downloadDirFor : () => null;
  // where the COMMANDER's own downloads go between runs (their Downloads folder) — never the last agent's jail
  const commanderDownloadDir = typeof deps.commanderDownloadDir === 'function' ? deps.commanderDownloadDir : () => null;
  const attended = deps.attended || null;   // the session's attendedLogin holder: .prompt is set to the driving run's
  const streamIdleMs = deps.streamIdleMs > 0 ? deps.streamIdleMs : STREAM_IDLE_MS;
  const stationIdleMs = deps.stationIdleMs > 0 ? deps.stationIdleMs : STATION_IDLE_MS;

  const runs = new Map();    // runId -> { agentId, runId, session }   private per-run browsers (watch only)
  const chans = new Map();   // target key -> channel
  let station = null;        // { session, driver: null|{agentId,runId}, idleTimer, lastPollAt }

  function surfaceOf(session) {
    try { return session && typeof session.handoffSurface === 'function' ? session.handoffSurface() : null; }
    catch (_) { return null; }   // "no browser page is open" — the honest answer is simply: nothing to show yet
  }
  function chan(key) {
    let c = chans.get(key);
    if (!c) { c = { key, surface: null, streaming: false, frame: null, seq: 0, waiters: new Set(), idle: null, polls: 0, page: null, pageAt: 0 }; chans.set(key, c); }
    return c;
  }
  function wake(c) { for (const w of Array.from(c.waiters)) { try { w(); } catch (e) { failNote('view.wake', e); } } c.waiters.clear(); }
  function stopStream(c, keepDriverStream) {
    if (c.idle) { clearT(c.idle); c.idle = null; }
    if (c.streaming && c.surface && !keepDriverStream) {
      try { const p = c.surface.stopStream(); if (p && typeof p.catch === 'function') p.catch(swallow('view.stop-stream')); }
      catch (e) { failNote('view.stop-stream', e); }
    }
    c.streaming = false; c.surface = null;
    wake(c);
  }
  function dropChan(key, keepDriverStream) { const c = chans.get(key); if (!c) return; stopStream(c, keepDriverStream); chans.delete(key); }
  function armIdle(c, onIdle) {
    if (c.idle) clearT(c.idle);
    c.idle = setT(() => { c.idle = null; onIdle(); }, streamIdleMs);
    if (c.idle && typeof c.idle.unref === 'function') c.idle.unref();
  }

  // ---- the station browser's life ----
  function touchStation() {
    if (!station) return;
    if (station.idleTimer) { clearT(station.idleTimer); station.idleTimer = null; }
    if (station.driver) return;   // a run is driving: it cannot be idle
    station.idleTimer = setT(() => {
      if (!station || station.driver) return;
      if (now() - station.lastPollAt < VIEWER_RECENT_MS) return touchStation();   // somebody is looking at it
      const sf = surfaceOf(station.session);
      if (sf && sf.visible) return touchStation();   // a real window: the Commander may be using it directly
      closeStation().catch(swallow('view.station-idle-close'));
    }, stationIdleMs);
    if (station.idleTimer && typeof station.idleTimer.unref === 'function') station.idleTimer.unref();
  }
  async function closeStation() {
    const st = station; if (!st) return { ok: true, open: false };
    if (st.driver) return { ok: false, error: 'an agent is driving the browser right now' };
    station = null;
    if (st.idleTimer) clearT(st.idleTimer);
    dropChan('station');
    if (attended) attended.prompt = undefined;
    try { await st.session.close(); } catch (e) { failNote('view.station-close', e); }
    return { ok: true, open: false };
  }
  function ensureStation() {
    if (!station) { const mode = effectiveMode(); station = { session: makeSession(mode), mode, driver: null, idleTimer: null, lastPollAt: 0 }; }
    return station;
  }
  // ---- a run takes / releases the station browser ----
  /* Session methods that do not DRIVE the page: asking them never makes a run the driver. */
  const PASSIVE = new Set(['handoffSurface', 'freeze', 'thaw', 'frozen', 'handTo', 'hasDriver', 'visible', 'headlessFallback', 'attachedPort', 'lastResponse', 'evalAllowed', 'close']);
  /* An interactive run asks for the station browser. It gets a VIEW of the shared session, and becomes the DRIVER
     only when it actually uses it (its first driving call) — a run that never browses never locks the Commander
     out, and "driving" is only ever said of a run that is. Returns null when the run must use a private browser
     (not interactive, or no station browser on this host). While another run is driving, a driving call throws. */
  /* A RUN THAT HAS ENDED NEVER TAKES THE WHEEL BACK (release review 2026-09-30, reproduced): the tool registry stops
     waiting for a tool ~3 s after STOP (or at its timeout) while the tool itself is still running. The run's finally
     released the browser — then that late tool's next driving call made the ended run the driver again, and nothing
     ever released it: the Commander's input was refused as "driving" and every later run was told the browser was in
     use, until the sidecar restarted. Each run's view carries a released flag; releaseRun sets it, and take() refuses. */
  const runHandles = new Map();   // runId -> the run's identity, while its view is live
  function sessionForRun(info) {
    info = info || {};
    if (!makeSession || info.interactive !== true || !info.runId) return null;
    const me = { agentId: String(info.agentId || 'agent'), runId: String(info.runId), released: false };
    runHandles.set(me.runId, me);
    const loginPrompt = typeof info.loginPrompt === 'function' ? info.loginPrompt : undefined;
    /* returns null when this run already drives; a promise while it takes the wheel; 'private' when ANOTHER run holds
       the station browser and this run browses in its own private browser instead (release review 2026-09-30: it used
       to throw "in use by another run", so a second agent could not browse at all for the whole of a long COMMS run).
       A run that went private stays private for the rest of the run: one run, one browser. */
    function take() {
      if (me.released) throw new Error('this run has ended — it no longer drives the station browser');
      if (me.private) return 'private';
      const st = ensureStation();
      if (st.driver && st.driver.runId === me.runId) return null;
      if (st.driver) {
        if (typeof info.makePrivate !== 'function') throw new Error('the station browser is in use by another run right now — retry after it finishes');
        me.private = info.makePrivate();
        registerRun({ agentId: me.agentId, runId: me.runId, session: me.private });   // the Commander may still watch it
        return 'private';
      }
      st.driver = me;
      if (st.idleTimer) { clearT(st.idleTimer); st.idleTimer = null; }
      if (attended) attended.prompt = loginPrompt;
      const c = chans.get('station'); if (c) c.pageAt = 0;
      if (typeof st.session.handTo !== 'function') return null;
      return Promise.resolve(st.session.handTo({ downloadDir: downloadDirFor(me.agentId) })).catch(e => { failNote('view.hand-to', e); });
    }
    return new Proxy({}, {
      get(_t, prop) {
        if (me.private) { const pv = me.private[prop]; return typeof pv === 'function' ? pv.bind(me.private) : pv; }
        const st = ensureStation();
        const v = st.session[prop];
        if (typeof v !== 'function') return v;
        if (PASSIVE.has(String(prop))) return v.bind(st.session);
        return (...args) => {
          const taking = take();
          if (taking === 'private') return me.private[prop](...args);
          return taking ? taking.then(() => ensureStation().session[prop](...args)) : v.apply(st.session, args);
        };
      },
      has(_t, prop) { return prop in (me.private || ensureStation().session); }
    });
  }
  function releaseRun(runId) {
    const h = runHandles.get(String(runId || ''));
    if (h) {
      h.released = true; runHandles.delete(h.runId);   // its view can never drive again, even from a late tool
      if (h.private) {   // it browsed privately (the station browser was busy): that browser ends with the run
        const priv = h.private; h.private = null;
        unregisterRun(h.runId);
        Promise.resolve().then(() => priv.close()).catch(e => failNote('view.private-close', e));
      }
    }
    if (!station || !station.driver || station.driver.runId !== String(runId || '')) return false;
    station.driver = null; station.signIn = null;
    if (attended) attended.prompt = undefined;
    if (station.switchPending) { closeStation().catch(swallow('view.mode-switch-close')); return true; }   // the setting changed mid-run
    /* PRIVACY (release review 2026-09-30): handTo pointed Chrome's downloads at the driving agent's workspace and
       nothing pointed them back, so a file the Commander downloaded in the shared window afterwards (a bank statement)
       landed where that agent's later runs — unattended ones too — could read it. Downloads go back to theirs. */
    const home = commanderDownloadDir();
    if (home && typeof station.session.handTo === 'function') {
      Promise.resolve().then(() => station && station.session.handTo({ downloadDir: home })).catch(e => failNote('view.downloads-home', e));
    }
    touchStation();
    return true;
  }
  function registerRun(info) {   // a PRIVATE per-run browser: the Commander may still watch it
    if (!info || !info.runId || !info.session) return false;
    runs.set(String(info.runId), { agentId: String(info.agentId || 'agent'), runId: String(info.runId), session: info.session });
    return true;
  }
  function unregisterRun(runId) {
    const id = String(runId || '');
    dropChan('run:' + id, true);   // the run is closing its own browser: never reach into it again
    return runs.delete(id);
  }

  // ---- the Commander's hands (only while no run is driving) ----
  /* A SIGN-IN hands the wheel to the Commander. browser.login (station path) opens the page and then the run waits
     for their Done — the agent does nothing meanwhile — so their clicks and keys must reach the page (they are the
     one typing the password). Opened by the session's onLoginOpen, closed by onLoginClose or when the run lets go. */
  function signInOpen(info) { if (station && station.driver) station.signIn = { host: String((info && info.host) || ''), runId: station.driver.runId }; return !!(station && station.signIn); }
  function signInClose() { if (station) station.signIn = null; }
  /* THE COMMANDER'S HANDS ARE NEVER REFUSED (Andrew 2026-10-02: "the whole point was for it to be interactive inside
     of the window"). It used to refuse their clicks, keys, addresses and back/forward while an agent drove — the
     BROWSER window turned into a view-only mirror for the whole run. Like Claude Code's browser pane, the shared
     browser now takes the Commander's input at any time; the agent keeps going (its element refs re-find themselves
     after a page change — withRefRecovery). */
  function driving() { return null; }
  async function open(raw) {
    if (!makeSession) return { ok: false, error: 'this station cannot open a browser of its own' };
    const addr = resolveAddress(raw);
    if (!addr.ok) return addr;
    const busy = driving(); if (busy) return busy;
    const st = ensureStation();
    touchStation();
    let finalUrl;
    try {
      if (typeof st.session.waitForProfile === 'function') await st.session.waitForProfile();
      finalUrl = await st.session.navigate(addr.url, addr.local ? { local: true } : {});
    } catch (e) {
      // a session that never got a page is not "open": close it so the profile lease is not held by a blank browser
      if (station === st && !st.driver && !surfaceOf(st.session)) await closeStation();
      return { ok: false, error: String((e && e.message) || e), url: addr.url };
    }
    if (station !== st) return { ok: false, error: 'the browser was closed' };
    const s = surfaceOf(st.session);
    const ch = chans.get('station'); if (ch) ch.pageAt = 0;
    if (s && s.visible && typeof s.front === 'function') { try { await s.front(); } catch (e) { failNote('view.front', e); } }   // they typed it: show it
    return { ok: true, url: finalUrl || addr.url, search: !!addr.search, remembered: !!(s && s.remembered), visible: !!(s && s.visible) };
  }
  async function nav(action) {
    const busy = driving(); if (busy) return busy;
    const st = station;
    if (!st || !surfaceOf(st.session)) return { ok: false, error: 'open a page first' };
    touchStation();
    try {
      if (action === 'back') await st.session.back();
      else if (action === 'forward') await st.session.forward();
      else if (action === 'reload') {
        const at = await surfaceOf(st.session).pageInfo();
        if (!at || !at.url) return { ok: false, error: 'nothing to reload' };
        const addr = resolveAddress(at.url);
        if (!addr.ok) return addr;
        await st.session.navigate(addr.url, addr.local ? { local: true } : {});
      } else return { ok: false, error: 'unknown action' };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    const ch = chans.get('station'); if (ch) ch.pageAt = 0;
    return { ok: true };
  }
  async function input(ev) {
    const busy = driving(); if (busy) return busy;
    const st = station;
    const s = st ? surfaceOf(st.session) : null;
    if (!s) return { ok: false, error: 'open a page first' };
    let clean;
    try { clean = sanitizeInput(ev); } catch (e) { return { ok: false, error: e.message }; }
    touchStation();
    await s.input(clean);
    const ch = chans.get('station'); if (ch) ch.pageAt = 0;   // the Commander acted: re-read where the page is
    return { ok: true };
  }

  /* WARM: the Commander opened the BROWSER window — start Chromium now, in the background, so it is ready by the
     time they have typed an address (a real window can take many seconds to start on a busy machine). Nothing is
     navigated; a browser already open, or one a run is driving, is left alone. */
  function warm() {
    if (!makeSession) return { ok: false, error: 'this station cannot open a browser of its own' };
    if (station && station.driver) return { ok: true, open: true };
    const st = ensureStation();
    touchStation();
    if (surfaceOf(st.session)) return { ok: true, open: true };
    if (!st.warming) st.warming = Promise.resolve().then(() => st.session.tabs()).catch(e => failNote('view.warm', e)).then(() => { st.warming = null; });
    return { ok: true, warming: true };
  }
  /* The Commander changed the setting. The browser that is open keeps running in its old mode until it next starts;
     an idle one is restarted now (closed — the next use starts it in the new mode, same profile, sign-ins kept).
     One an agent is driving is never pulled out from under it: it switches when that run lets go. */
  async function setMode(m) {
    const want = normalizeMode(m);
    if (BROWSER_MODES.indexOf(String(m || '')) < 0) return { ok: false, error: 'unknown browser mode' };
    writeMode(want);
    let applied = true;
    if (station) {
      const differs = station.mode !== effectiveMode();
      // switched away and back while an agent drives: nothing is pending any more (QA 2026-10-02 — the flag was only ever
      // set, so the browser still closed when the run let go)
      if (station.driver) { station.switchPending = differs; applied = !differs; }
      else if (differs) await closeStation();
    }
    return Object.assign({ ok: true, applied }, settings());
  }
  function settings() { return { mode: normalizeMode(readMode()), effective: effectiveMode(), chromeAvailable: !!chromeAvailable(), windowAvailable: !!windowAvailable(), running: station ? station.mode : null }; }
  async function front() {
    const s = station ? surfaceOf(station.session) : null;
    if (!s) return { ok: false, code: 'closed', error: 'the browser is not open' };
    if (!s.visible || typeof s.front !== 'function') return { ok: false, error: 'the browser is running hidden on this station (STARNET_BROWSER_HEADLESS)' };
    try { await s.front(); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    return { ok: true };
  }

  // ---- pictures ----
  function resolveTarget(target) {
    const t = String(target || '');
    if (t === 'station') {
      const st = station;
      if (st && st.driver && handoffLive(st.driver.runId)) return { error: 'handoff', message: 'the agent is waiting for you in STEP-IN' };
      const s = st ? surfaceOf(st.session) : null;
      return s ? { key: 'station', surface: s, handoffRun: st.driver ? st.driver.runId : '' } : { error: 'closed', message: 'no page is open' };
    }
    if (t.indexOf('run:') === 0) {
      const r = runs.get(t.slice(4));
      if (!r) return { error: 'ended', message: 'that run has ended' };
      if (handoffLive(r.runId)) return { error: 'handoff', message: 'this agent is waiting for you in STEP-IN' };
      const s = surfaceOf(r.session);
      return s ? { key: t, surface: s, handoffRun: r.runId } : { error: 'closed', message: 'this agent has no browser page open' };
    }
    return { error: 'unknown', message: 'unknown browser' };
  }
  async function pageOf(c) {
    if (c.page && now() - c.pageAt < PAGE_INFO_EVERY_MS) return c.page;
    try { const p = await c.surface.pageInfo(); c.page = { url: String((p && p.url) || ''), title: String((p && p.title) || '') }; }
    catch (e) { failNote('view.page-info', e); }
    c.pageAt = now();
    return c.page;
  }
  /* Long-poll for the next picture of `target` ('station' | 'run:<runId>'). Starts the capture on first ask and
     stops it when nobody has asked for streamIdleMs. */
  // nobody has watched for streamIdleMs: stop the picture, unless a STEP-IN handoff holds this browser NOW. Read who drives at the
  // moment the clock runs out, never who drove at the last poll: a run that took the wheel (and a sign-in) inside the idle window
  // had its STEP-IN picture stopped, since the browser has ONE stream
  function idleOut(target, r, c) {
    const cur = resolveTarget(target), run = (cur && !cur.error && cur.handoffRun) || r.handoffRun;
    if ((cur && cur.error === 'handoff') || (run && handoffLive(run))) dropChan(r.key, true); else stopStream(c);
  }
  async function frame(target, after, budgetMs) {
    const r = resolveTarget(target);
    if (r.error) {
      // a handoff took this browser's one stream: forget ours without touching the driver's
      if (r.error === 'handoff') dropChan(String(target), true);
      else if (r.error !== 'unknown') dropChan(String(target), r.error === 'ended');
      return { ok: false, code: r.error, error: r.message };
    }
    const c = chan(r.key);
    if (r.key === 'station' && station) { station.lastPollAt = now(); touchStation(); }
    if (!c.streaming) {
      c.surface = r.surface; c.streaming = true;
      try {
        await c.surface.startStream(f => {
          if (!c.streaming || !f || !f.data) return;
          c.frame = { seq: ++c.seq, mime: f.mime || 'image/jpeg', width: f.width, height: f.height, data: f.data };
          wake(c);
        });
      } catch (e) { stopStream(c, true); return { ok: false, code: 'closed', error: String((e && e.message) || e) }; }
    }
    // "Nobody is watching" is measured from the END of the last poll: a long-poll on a still page is somebody
    // watching, and the idle clock must not run underneath it.
    if (c.idle) { clearT(c.idle); c.idle = null; }
    c.polls++;
    const release = () => {
      c.polls = Math.max(0, c.polls - 1);
      if (c.polls === 0 && c.streaming && chans.get(r.key) === c) armIdle(c, () => idleOut(target, r, c));
    };
    const since = Number(after) || 0;
    if (!(c.frame && c.frame.seq > since)) {
      const wait = Math.max(0, Math.min(FRAME_POLL_MAX_MS, Number(budgetMs) >= 0 ? Number(budgetMs) : FRAME_POLL_MAX_MS));
      if (wait > 0) await new Promise(resolve => {
        const t = setT(done, wait);
        function done() { clearT(t); c.waiters.delete(done); resolve(); }
        c.waiters.add(done);
      });
    }
    release();
    if (r.key === 'station' && station) station.lastPollAt = now();
    if (chans.get(r.key) !== c || !c.streaming) {
      const again = resolveTarget(target);
      return { ok: false, code: again.error || 'closed', error: again.message || 'the picture stopped' };
    }
    const page = await pageOf(c);
    const d = r.key === 'station' && station ? station.driver : null;
    return { ok: true, frame: c.frame && c.frame.seq > since ? c.frame : null, page, driver: d ? { agentId: d.agentId, runId: d.runId, signIn: !!(station && station.signIn) } : null };
  }

  function list() {
    const agents = [];
    for (const r of runs.values()) {
      const handoff = !!handoffLive(r.runId);
      if (!handoff && !surfaceOf(r.session)) continue;   // no page open: nothing to watch, nothing listed
      agents.push({ agentId: r.agentId, runId: r.runId, target: 'run:' + r.runId, handoff });
    }
    const st = station;
    const s = st ? surfaceOf(st.session) : null;
    const d = st && st.driver ? { agentId: st.driver.agentId, runId: st.driver.runId, signIn: !!st.signIn } : null;
    return { agents, settings: settings(), station: { available: !!makeSession, open: !!s, mode: st ? st.mode : effectiveMode(), visible: !!(s && s.visible), driver: d, handoff: !!(d && handoffLive(d.runId)), remembered: !!(s && s.remembered), setup: setupState() } };
  }
  /* RESET STATION BROWSER (#61, Settings > BROWSER): close the station browser, then end any ORPHANED StarNet browser
     on the durable profile (one an earlier StarNet process started and left behind, its proxy dead) and clear the
     profile's stale locks (deps.sweepStationProfile -> tools/builtin/browser-orphans.js). Refused while an agent is
     driving: STOP that run first. The receipt is what happened, never what was hoped. */
  async function reset() {
    const out = { ok: false, closed: false, driving: null, sweep: null, error: null };
    if (station && station.driver) {
      out.driving = { agentId: station.driver.agentId, runId: station.driver.runId };
      out.error = 'an agent is driving the browser right now - stop that run, then reset';
      return out;
    }
    const r = await closeStation();
    out.closed = !!(r && r.ok);
    if (!out.closed) { out.error = (r && r.error) || 'the station browser did not close'; return out; }
    if (typeof deps.sweepStationProfile === 'function') {
      try { out.sweep = await deps.sweepStationProfile(); }
      catch (e) { out.sweep = { ok: false, error: String((e && e.message) || e), found: 0, killed: [], survivors: [], ours: [], locks: { removed: [], failed: [] } }; }
    }
    out.ok = !out.sweep || out.sweep.ok === true;
    if (!out.ok) out.error = (out.sweep && out.sweep.error) || 'an orphaned browser is still running';
    return out;
  }
  async function closeAll() {
    for (const k of Array.from(chans.keys())) dropChan(k, k !== 'station');
    if (station) { station.driver = null; await closeStation(); }
  }

  return { sessionForRun, releaseRun, registerRun, unregisterRun, open, nav, input, front, warm, frame, list, setMode, settings, signInOpen, signInClose, close: closeStation, closeAll, reset,
    _internals: { runs, chans, station: () => station } };
}

function makeViewRoutes(deps) {
  const { views, readBody, respondJson } = deps;
  const MAX_EVENTS = 64;
  async function body(req, max) { try { return JSON.parse(await readBody(req, max || 8192)) || {}; } catch (_) { return null; } }
  async function list(req, res) { respondJson(res, 200, Object.assign({ ok: true }, views.list())); }
  async function open(req, res) {
    const b = await body(req); if (!b) return respondJson(res, 400, { ok: false, error: 'bad json' });
    const r = await views.open(b.url);
    respondJson(res, r.ok ? 200 : 409, r);
  }
  async function nav(req, res) {
    const b = await body(req); if (!b) return respondJson(res, 400, { ok: false, error: 'bad json' });
    const r = await views.nav(String(b.action || ''));
    respondJson(res, r.ok ? 200 : 409, r);
  }
  async function close(req, res) { const r = await views.close(); respondJson(res, r.ok ? 200 : 409, r); }
  async function reset(req, res) { const r = await views.reset(); respondJson(res, r.ok ? 200 : 409, r); }
  async function front(req, res) { const r = await views.front(); respondJson(res, r.ok ? 200 : 409, r); }
  async function warm(req, res) { const r = views.warm(); respondJson(res, r.ok ? 200 : 409, r); }
  async function getSettings(req, res) { respondJson(res, 200, Object.assign({ ok: true }, views.settings())); }
  async function setSettings(req, res) {
    const b = await body(req); if (!b) return respondJson(res, 400, { ok: false, error: 'bad json' });
    const r = await views.setMode(b.mode);
    respondJson(res, r.ok ? 200 : 400, r);
  }
  async function frame(req, res) {
    const u = new URL(req.url, 'http://x');
    const r = await views.frame(String(u.searchParams.get('target') || '').slice(0, 120), Number(u.searchParams.get('after')) || 0, VIEW_POLL_MS);
    if (!r.ok) return respondJson(res, 409, r);
    respondJson(res, 200, { ok: true, page: r.page || null, driver: r.driver || null, frame: r.frame ? { seq: r.frame.seq, mime: r.frame.mime, width: r.frame.width, height: r.frame.height, data: r.frame.data } : null });
  }
  async function input(req, res) {
    const b = await body(req, 64 * 1024); if (!b) return respondJson(res, 400, { ok: false, error: 'bad json' });
    const events = Array.isArray(b.events) ? b.events.slice(0, MAX_EVENTS) : [];
    if (!events.length) return respondJson(res, 400, { ok: false, error: 'no input events' });
    let n = 0;
    for (const ev of events) {
      let r;
      try { r = await views.input(ev); }
      catch (e) { return respondJson(res, 502, { ok: false, error: 'the browser did not take the input: ' + ((e && e.message) || e), applied: n }); }
      if (!r.ok) return respondJson(res, 409, Object.assign({}, r, { applied: n }));
      n++;
    }
    respondJson(res, 200, { ok: true, applied: n });
  }
  return {
    routes: [
      { m: 'GET', exact: '/api/browser/view', h: list },
      { m: 'POST', exact: '/api/browser/view/open', h: open },
      { m: 'POST', exact: '/api/browser/view/nav', h: nav },
      { m: 'POST', exact: '/api/browser/view/close', h: close },
      { m: 'POST', exact: '/api/browser/reset', h: reset },   // #61: Settings > BROWSER > RESET STATION BROWSER
      { m: 'POST', exact: '/api/browser/view/front', h: front },
      { m: 'POST', exact: '/api/browser/view/warm', h: warm },
      { m: 'GET', exact: '/api/browser/settings', h: getSettings },
      { m: 'POST', exact: '/api/browser/settings', h: setSettings },
      { m: 'GET', qsplit: '/api/browser/view/frame', h: frame },
      { m: 'POST', exact: '/api/browser/view/input', h: input }
    ]
  };
}

module.exports = { makeBrowserViews, makeViewRoutes, resolveAddress, normalizeMode, BROWSER_MODES, STREAM_IDLE_MS, STATION_IDLE_MS };
