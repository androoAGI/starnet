/* AGENT OS — briefing.js : THE ONE RETURN REPORT, delivered as ONE session.

   THE PROBLEM (2026-10-04 audit): coming back meant a new rail row per routine fire, a new row per away build,
   a COMMS digest that skipped every cron/workshop/night-shift run, a morning report that only knew the night
   shift, a drafts nudge, a workshop reveal that jumped focus, and toasts — ~10 places, stitched together by hand.

   THE SHAPE NOW: the sidecar owns the truth (sidecar/away-briefing.js + POST /api/away/briefing/deliver): one
   durable "briefed through" stamp, everything unattended that ended after it folded into ONE assistant turn in
   ONE durable session (stream 'briefing', pinned, titled "While you were away"). This module only decides WHEN to
   ask (boot, and the first input after a real absence), adopts that one session, opens it when the Commander
   isn't mid-something (else it stays the single unread row), and renders tap-to-open chips for the briefed
   items. The per-run sessions still exist — they are the evidence and hold each build's keep/toss card — but
   they are reached FROM the briefing instead of each one shouting on return. Replying in the briefing continues
   from it: the sidecar gives that run the briefed items' real locations.

   The older return surfaces (ReturnStore's digest beat, NightReportStore, NightNudge, WorkshopStore's return
   reveal) ask ownsReturn() and stand down while this is live — their stores keep working (OUTBOX crates,
   deliverable sessions), only their competing "welcome back" beats go quiet. Never emits on U.bus; fail-open. */
'use strict';
const Briefing = (() => {
  const STREAM = 'briefing';
  const TITLE = 'While you were away';
  const AWAY_MS = 30 * 60000;       // "genuinely away" — matches the sidecar's NIGHTSHIFT_AWAY_MS default
  const BOOT_DELAY_MS = 1600;       // let the floor + COMMS settle (same cadence family as ReturnStore)
  const SEEN_EVERY_MS = 60000;      // presence stamps while the Commander is here — one a minute vs the 30-minute threshold
  let enabled = false, wired = false, inFlight = false;
  let lastInputAt = Date.now(), hiddenAt = 0;
  let bootSettled = false, lastSeenAt = 0;
  let agentId = 'agent';
  let lastItems = null;             // the last delivered briefing's items (from the server), for the chips

  const tzOffsetMin = () => { try { return -new Date().getTimezoneOffset(); } catch (_) { return 0; } };
  const hasWS = () => typeof Workstreams !== 'undefined' && Workstreams && Workstreams.adopt;

  // the Commander is mid-something a focus jump would stomp (same probes WorkshopStore's reveal uses)
  function engaged() {
    try { if (typeof Chat !== 'undefined' && Chat.isComposerEngaged && Chat.isComposerEngaged()) return true; } catch (_) { return true; }
    try { if (typeof Chat !== 'undefined' && Chat.isBusy && Chat.isBusy()) return true; } catch (_) {}
    try { if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return true; } catch (_) {}
    try { if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return true; } catch (_) {}
    try { if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) return true; } catch (_) {}
    return false;
  }
  /* A WAITING ASK OUTRANKS THE REPORT (live walk 10-14: a reload jumped to the briefing and took the screen off the
     conversation whose worker approval was still pending). The station's own count rides the delivery — a reloaded
     page may not have refiled a background ask yet — and any ask this page already holds counts too. */
  function asksWaiting(j) {
    if (j && Number(j.asksWaiting) > 0) return true;
    try { return typeof Channels !== 'undefined' && !!Channels.allPending && Channels.allPending().length > 0; }
    catch (e) { console.warn('[briefing] could not read the open asks; staying put', e); return true; }
  }

  // adopt (idempotent) the ONE briefing session: pinned, unread (real unseen content), never a duplicate row.
  function ensureSession(at) {
    if (!hasWS()) return null;
    const ws = Workstreams.adopt({ id: STREAM, title: TITLE, titleAuto: false, agentId: agentId, lane: 'active', kind: 'chat', history: [],
      lastActiveAt: at || Date.now(), lastReadAt: 0, revive: true });
    if (!ws) return null;
    // the name is locked like a manual rename: a reply here must never re-title the briefing after that reply's
    // topic. A Commander's own rename (titleAuto already false, a different title) is theirs and is kept.
    if (ws.titleAuto !== false) { ws.title = TITLE; ws.titleAuto = false; }
    if (Workstreams.pin) Workstreams.pin(STREAM, true);
    if (at && (+ws.lastActiveAt || 0) < at) ws.lastActiveAt = at;
    if (Workstreams.markUnread) Workstreams.markUnread(STREAM);
    try { if (typeof App !== 'undefined') { if (App.refreshRail) App.refreshRail(); if (App.persist) App.persist(); } } catch (_) {}
    return ws;
  }

  async function deliver(why) {
    if (!enabled || inFlight) return null;
    inFlight = true;
    lastSeenAt = Date.now();   // a delivery moves the stamp itself; the next presence stamp waits its turn behind it
    try {
      // minAwayMs: the sidecar briefs only an absence at least this long — a reload or a restart is not one
      const r = await fetch('/api/away/briefing/deliver', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tzOffsetMin: tzOffsetMin(), why: String(why || ''), minAwayMs: AWAY_MS }) });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      if (!j || !j.delivered) return j;
      if (j.agentId) agentId = String(j.agentId);
      lastItems = Array.isArray(j.items) ? j.items : null;
      const ws = ensureSession(Number(j.at) || Date.now());
      const onScreen = typeof Workstreams !== 'undefined' && Workstreams.activeId && Workstreams.activeId() === STREAM;
      if (ws && onScreen && typeof Chat !== 'undefined' && Chat.load) {
        try { Chat.load(ws); } catch (_) {}   // already on screen: re-sync from the server so the new turn shows
      } else if (ws && !engaged() && !asksWaiting(j) && typeof App !== 'undefined' && App.openWorkstream) {
        try { App.openWorkstream(STREAM); } catch (_) {}
      }
      return j;
    } catch (_) { return null; }
    finally { inFlight = false; }
  }

  // the chips under the briefing: each briefed thing's OWN session (the evidence + the keep/toss card). Only
  // sessions that really exist are offered (a deleted one stays gone); nothing to offer → no chips.
  function chipsFor(items) {
    const out = [];
    const seen = new Set();
    for (const it of (Array.isArray(items) ? items : [])) {
      let open = '', label = '';
      if (it.kind === 'build') { open = it.open; label = '⚒ review “' + it.title + '”'; }
      else if (it.kind === 'builds-waiting') { open = it.open; label = '⚒ ' + it.count + ' earlier build' + (it.count === 1 ? '' : 's'); }
      else if (it.kind === 'routine' && it.latest) { open = it.latest.open; label = (it.latest.failed ? '⚠ ' : '✦ ') + it.name; }
      else if (it.kind === 'loop' && it.latest) { open = it.latest.open; label = '∞ ' + it.name; }
      // delegated work opens the conversation that asked for it (its workers' threads fold under it)
      else if (it.kind === 'delegated') { open = it.open; label = (it.failed ? '⚠ ' : '✦ ') + it.name; }
      if (!open || seen.has(open)) continue;
      if (!(typeof Workstreams !== 'undefined' && Workstreams.get && Workstreams.get(open))) continue;
      seen.add(open);
      out.push({ label: label.slice(0, 60), value: open });
      if (out.length >= 6) break;
    }
    return out;
  }
  async function presentFor(wsId) {
    if (String(wsId || '') !== STREAM) return;
    if (typeof Chat === 'undefined' || !Chat.choices) return;
    let items = lastItems;
    if (!items) {
      try {
        const r = await fetch('/api/away/briefing', { cache: 'no-store' });
        if (r.ok) { const j = await r.json(); items = (j && j.last && Array.isArray(j.last.items)) ? j.last.items : []; lastItems = items; }
      } catch (_) { return; }
    }
    if (typeof Workstreams === 'undefined' || !Workstreams.activeId || Workstreams.activeId() !== STREAM) return;   // switched away meanwhile
    const chips = chipsFor(items);
    const log = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('chat-log') : null;
    if (!log) return;
    // a STANDING row under the briefing (not Chat.choices): the open-doors are navigation, not a one-shot question,
    // so another beat's chips must never clear them; renderHistory wipes the log, and load()/repaint re-present it.
    const old = log.querySelector('.briefing-links'); if (old) old.remove();
    if (!chips.length) return;
    const row = document.createElement('div'); row.className = 'choice-row briefing-links';
    for (const c of chips) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'choice'; b.textContent = c.label;
      b.addEventListener('click', () => { try { if (typeof App !== 'undefined' && App.openWorkstream) App.openWorkstream(String(c.value)); } catch (_) {} });
      row.appendChild(b);
    }
    log.appendChild(row);
  }

  // has the Commander been gone (no input) long enough that new unattended work belongs to a briefing?
  function isAway(now) { return ((now || Date.now()) - lastInputAt) >= AWAY_MS; }
  /* PRESENCE (live walk 10-14). The briefing stamp used to move only when a briefing was delivered, so a reload briefed
     everything that had ended since the PREVIOUS one — work the Commander had watched land. While they are here the page
     stamps their presence (throttled), and on the way out (tab hidden, reload, close) it stamps the moment they left.
     Never before the boot delivery settles and never while a delivery is in flight: a stamp racing ahead of a return
     would swallow the very absence it is about to brief. A page with the briefing OFF (the awakening) still stamps: a
     stamp delivers nothing, and without it a new station's first reload briefed its whole first session (review 10-14). */
  function stampPresence(leaving) {
    // isAway: an idle page is not a present Commander — hiding or reloading it after an hour untouched must not erase that hour
    if (!wired || !bootSettled || inFlight || isAway()) return;
    const now = Date.now();
    if (!leaving && now - lastSeenAt < SEEN_EVERY_MS) return;
    lastSeenAt = now;
    fetch('/api/away/briefing/deliver', { method: 'POST', keepalive: !!leaving, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seen: true }) })
      .catch(e => console.warn('[briefing] presence stamp did not land (the next one retries)', e));
  }
  function noteInput() {
    const now = Date.now();
    const wasAway = isAway(now);
    lastInputAt = now;
    if (wasAway && enabled) deliver('return').catch(e => console.warn('[briefing] return delivery failed', e));
    else stampPresence(false);   // present — or back on a page that never briefs (the awakening): either way they are here now
  }
  function onVisibility() {
    try {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); stampPresence(true); return; }
      if (hiddenAt && Date.now() - hiddenAt >= AWAY_MS) { lastInputAt = Date.now(); deliver('return').catch(e => console.warn('[briefing] return delivery failed', e)); }
      hiddenAt = 0;
    } catch (e) { console.warn('[briefing] visibility change not handled', e); }
  }
  function onPageHide() { stampPresence(true); }

  // init({ enabled, agentId }) — called from enterGame. enabled:false (the awakening) never briefs.
  function init(opts) {
    opts = opts || {};
    enabled = opts.enabled !== false;
    if (opts.agentId) agentId = String(opts.agentId);
    lastInputAt = Date.now();
    bootSettled = !enabled;   // no boot delivery to wait for on a page that never briefs: presence stamps from the first input
    if (!wired && typeof window !== 'undefined') {
      wired = true;
      try {
        window.addEventListener('pointerdown', noteInput, { capture: true, passive: true });
        window.addEventListener('keydown', noteInput, { capture: true, passive: true });
        window.addEventListener('pagehide', onPageHide);
        document.addEventListener('visibilitychange', onVisibility);
      } catch (e) { console.warn('[briefing] could not watch for the Commander returning', e); }
    }
    if (enabled) setTimeout(() => deliver('boot').catch(e => console.warn('[briefing] boot delivery failed', e)).then(() => { bootSettled = true; }), BOOT_DELAY_MS);
  }
  function ownsReturn() { return enabled; }
  // a fresh start: nothing stamps until the next page's init (the awakening's own init stamps again from there)
  function reset() { enabled = false; lastItems = null; bootSettled = false; }

  return { init, reset, deliver, presentFor, ownsReturn, isAway, chipsFor, STREAM, TITLE, _ensureSession: ensureSession };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Briefing;
