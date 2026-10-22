/* frontend/app/apps.js — APPS: describe it, get it (2026-09-29).

   The Commander names an app and says, in their own words, what it should be — a tracker, a timer, a dashboard,
   a game, a feed that refreshes itself: anything. Agent OS creates it at once (its window opens on a "building"
   page), then hands the build to the lead in the app's OWN COMMS session — so the work is visible, runs under the
   station's normal rules, and the page appears the moment the crew writes it. Changing an app is the same move
   from the bar under its window: describe the change.

   Owns: the APPS window (NEW APP + your apps), the APPS dock (hidden until the first app exists), the bar under
   every app window (change · refresh · honest status), and the station-bridge verbs app.reload / app.data (see
   stationcommands.js). The frame, bridge and kit are PluginHost's (frontend/app/pluginhost.js, the 'app' kind).

   TRUTHFUL: every status line reads the sidecar (GET /api/apps): whether the page was ever written, when data last
   landed, the routine's real next/last run, and whether routines are switched on at all — an app never says it is
   building, refreshing or scheduled when the station cannot show that it is. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined') return;

  let list = [];            // the last GET /api/apps
  let routinesOn = true;
  let loadError = false;    // the last load failed: the window says so instead of "no apps yet"
  const refreshing = new Set();   // app ids with a REFRESH run in flight (started from this page)
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const UI = () => (typeof StationUI !== 'undefined' ? StationUI : null);
  const host = () => (typeof PluginHost !== 'undefined' ? PluginHost : null);
  const notify = (msg, cls) => { const ui = UI(); if (ui && ui.notify) ui.notify(msg, cls || 'good', 'general', { transient: true }); };
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const EXAMPLES = [
    ['Habit Tracker', 'A tracker for my daily habits: I add habits, tick them off each day, and see my streaks. Keep what I enter.'],
    ['Focus Timer', 'A pomodoro timer: 25 minutes of focus, 5 of break, with a big clock, start/pause, and a count of sessions today. Make it look like a retro arcade cabinet.'],
    ['Idea Board', 'A board where I jot ideas as cards, drag them between Now / Later / Maybe, and search them. Keep what I enter.'],
    ['Weekly Recap', 'Every Friday evening, a one-page recap of what my crew finished this week, grouped by project. Refresh weekly.']
  ];

  async function load() {
    try {
      const r = await fetch('/api/apps');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      list = Array.isArray(j.apps) ? j.apps : [];
      routinesOn = j.routinesOn !== false;
      loadError = false;
    } catch (_) { loadError = true; return false; }   // keep the last known list; the window says it could not load
    const h = host();
    for (const a of list) if (h && h.registerApp) h.registerApp(a);
    syncDock();
    return true;
  }
  const find = (id) => list.find((a) => a.id === id) || null;

  /* THE DOCK FOLLOWS THE LIST: no APPS button until the Commander has an app (NEW APP lives under BUILD until then);
     after that the APPS menu opens each app in one click. */
  function syncDock() {
    const group = document.querySelector('#bottombar .bb-group[data-group="apps"]');
    if (!group) return;
    group.hidden = !list.length;
    if (!list.length) group.classList.remove('open');
    // ONE NEW APP DOOR: BUILD carries it only until the APPS dock exists — then it lives in APPS alone
    const buildNew = document.getElementById('bb-newapp-build');
    if (buildNew) buildNew.hidden = !!list.length;
    const box = document.getElementById('bb-apps-items');
    if (!box) return;
    // each entry reads like every other dock item: the instrument icon, the name, ONE short line (its live status —
    // never the whole description, which is what the manage window is for)
    const sig = list.map((a) => a.id + '\u0000' + a.name).join('\u0001');
    if (box.dataset.sig === sig) {
      // same apps: only their one-line status moves ("Updated 3m ago") — update the text in place, so a focused
      // dock item keeps focus and the keyboard model keeps working
      box.querySelectorAll('.bb-app').forEach((b) => { const a = find(b.dataset.app), sm = b.querySelector('small'); if (a && sm) { const t = dockLine(a); if (sm.textContent !== t) sm.textContent = t; } });
      return;
    }
    box.dataset.sig = sig;
    box.textContent = '';
    for (const a of list.slice(0, 12)) {
      const b = document.createElement('button');
      b.className = 'bb bb-app'; b.type = 'button'; b.setAttribute('role', 'menuitem'); b.dataset.hint = 'app'; b.dataset.app = a.id;
      const i = document.createElement('span'); i.className = 'bb-i'; i.setAttribute('aria-hidden', 'true');
      i.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 3h12v10H2zM2 6h12M4.5 4.5h1M6.5 4.5h1"/></svg>';
      const tx = document.createElement('span'); tx.className = 'bb-tx';
      const nm = document.createElement('b'); nm.textContent = a.name;
      const sm = document.createElement('small'); sm.textContent = dockLine(a);
      tx.append(nm, sm); b.append(i, tx);
      b.addEventListener('click', () => {
        const cur = find(a.id), h = host();
        if (cur && h && h.openApp) h.openApp(cur);
        const trig = group.querySelector('.bb-grp');
        if (group.classList.contains('open') && trig) trig.click();   // collapse the dock, like every other item
      });
      box.appendChild(b);
    }
    if (list.length > 12) {
      const more = document.createElement('small'); more.className = 'bb-apps-more';
      more.textContent = '+ ' + (list.length - 12) + ' more in MANAGE APPS';
      box.appendChild(more);
    }
    const sep = document.createElement('div'); sep.className = 'bb-apps-sep'; sep.setAttribute('role', 'separator');
    box.appendChild(sep);
  }
  // the dock's one line for an app: whether it exists yet / when it last changed, and whether it refreshes itself
  function dockLine(a) {
    const last = Math.max(a.updatedAt || 0, a.changedAt || 0);
    const first = refreshing.has(a.id) ? 'Refreshing now' : last ? 'Updated ' + ago(last) : a.builtAt ? 'Built ' + ago(a.builtAt) : 'Not built yet';
    const s = a.schedule;
    return first + (s && !s.missing && s.enabled !== false ? ' · ' + (routinesOn ? 'refreshes ' + s.display : 'routines off') : '');
  }

  function ago(t) {
    if (!t) return '';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function when(t) {
    if (!t) return '';
    const d = new Date(t), today = new Date();
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === today.toDateString() ? hm : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + hm;
  }
  // has the crew written this app's page yet? (its first write, or — an app made before that was recorded — its data)
  const built = (a) => !!(a && (a.builtAt || a.updatedAt));
  // one honest line: whether it exists yet, when it last got data, and what the schedule will really do
  function statusOf(a) {
    const parts = [];
    if (refreshing.has(a.id)) parts.push('Refreshing now');
    const last = Math.max(a.updatedAt || 0, a.changedAt || 0);
    parts.push(last ? 'Updated ' + ago(last) : a.builtAt ? 'Built ' + ago(a.builtAt) : 'Not built yet');
    const s = a.schedule;
    if (s && s.missing) parts.push('its refresh routine was removed');
    else if (s) {
      if (s.enabled === false) parts.push('refresh paused' + (routinesOn ? '' : ' · routines are OFF'));
      else if (!routinesOn) parts.push('refreshes ' + s.display + ' — but routines are OFF');
      else parts.push('refreshes ' + s.display + (s.nextRunAt ? ' · next ' + when(s.nextRunAt) : ''));
      if (s.lastStatus === 'error') parts.push('last refresh failed' + (s.lastError ? ': ' + String(s.lastError).slice(0, 90) : ''));
    }
    return parts.join(' · ');
  }

  /* ---- handing work to the crew (one COMMS session per app) ------------------------------------------------ */
  const SESSIONS_KEY = 'starnet.appSessions';
  function sessions() { try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '{}') || {}; } catch (_) { return {}; } }
  function saveSessions(m) { try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(m)); } catch (_) { /* per-browser memory only */ } }
  function remember(id, wsId) { const m = sessions(); m[id] = wsId; saveSessions(m); }
  function forgetSession(id) { const m = sessions(); if (id in m) { delete m[id]; saveSessions(m); } }
  /* toCrew(app, text) -> { ok, state: 'started' | 'queued' | 'unavailable' }
     The request goes to the APP'S OWN session, which is put on screen first. (Workstreams.create makes the new
     session active WITHOUT loading it into COMMS, and App.openWorkstream no-ops on the already-active id — so a
     fresh session is loaded directly; otherwise the text would land in whatever session happened to be open.)
     A session that is mid-run QUEUES the request (Chat.sendOrQueue) — nothing typed is ever dropped. */
  function toCrew(app, text) {
    if (typeof Workstreams === 'undefined' || typeof Chat === 'undefined' || !Chat.sendOrQueue || !Chat.load) return { ok: false, state: 'unavailable' };
    let ws = null, made = false;
    const known = sessions()[app.id];
    if (known && Workstreams.get && Workstreams.get(known) && !(Workstreams.isDeleted && Workstreams.isDeleted(known))) ws = Workstreams.get(known);
    if (!ws) { ws = Workstreams.create('App · ' + app.name); made = true; if (ws) remember(app.id, ws.id); }
    if (!ws) return { ok: false, state: 'unavailable' };
    const A = (typeof App !== 'undefined') ? App : null;
    if (made) { Chat.load(ws); if (A && A.refreshRail) A.refreshRail(); }
    else if (Workstreams.activeId && Workstreams.activeId() !== ws.id) { if (A && A.openWorkstream) A.openWorkstream(ws.id); else Chat.load(ws); }
    if (Workstreams.activeId && Workstreams.activeId() !== ws.id) return { ok: false, state: 'unavailable' };   // the session never came up: send nothing anywhere else
    const r = Chat.sendOrQueue(text);
    try { if (A && A.persist) A.persist(); } catch (_) { /* the chat itself is saved by Chat */ }
    return { ok: !!(r && r.ok), state: (r && r.ok) ? r.state : 'unavailable' };
  }
  // the model's own sense of the date is its training era: every hand-off states the real one
  const today = () => { try { return 'Today is ' + new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + '. '; } catch (_) { return ''; } };
  const buildText = (a, what) => 'Build my new Agent OS app "' + a.name + '" (app id: ' + a.id + ').\n\nWhat it should do: ' + what + '\n\n' + today() +
    'Use the app tools (find them with tool.search "app"): read it with app.read, write index.html with app.write, app.check it, ' +
    'and make it exactly what I described — if I said how it should look or behave, do that; where I did not, match the station. ' +
    'If it should update by itself, app.schedule it FIRST (before any web research); if it shows information, fill it with REAL content now with app.publish; if it is a tool I use myself, make it work and keep what I enter. ' +
    'Then tell me in a sentence what it does.';
  const changeText = (a, what) => 'Change my Agent OS app "' + a.name + '" (app id: ' + a.id + '): ' + what + '\n\n' + today() +
    'Read it first with app.read (find the app tools with tool.search "app"), then app.write the new version and app.check it. Keep what already works.';

  /* create(name, what) -> { app, sent } — the app exists either way; `sent` says whether the crew has the build. */
  async function create(name, what) {
    const r = await post('/api/apps', { name, description: what });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error((j && j.error) || 'the station could not create the app');
    await load();
    const a = find(j.app.id) || j.app;
    const h = host();
    if (h && h.openApp) h.openApp(a);
    const sent = toCrew(a, buildText(a, what || name));
    if (!sent.ok) holdText(a.id, what || name);   // never lose the description: it waits in the box under the app's window
    return { app: a, sent };
  }
  function change(id, what) {
    const a = find(id);
    if (!a || !String(what || '').trim()) return { ok: false, state: 'empty' };
    // an app the crew never built is BUILT from this text, not "changed"
    return toCrew(a, (built(a) ? changeText : buildText)(a, String(what).trim()));
  }
  async function refreshNow(id) {
    const a = find(id);
    if (!a || !a.schedule || !a.schedule.jobId || refreshing.has(id)) return;
    refreshing.add(id); paintAll(id);
    try {
      const r = await post('/api/cron/run', { id: a.schedule.jobId, detach: true });   // closing this window must not cancel it
      if (!r.ok) { const j = await r.json().catch(() => ({})); notify(a.name + ': ' + ((j && (j.error || j.message)) || 'the refresh could not start'), 'warn'); return; }
      notify(a.name + ': refresh started — your crew is on it.');   // said only once the station accepted the run
      await r.text();   // the run streams until it finishes; reading it keeps it attached
    } catch (e) { notify(a.name + ': the refresh did not finish — ' + ((e && e.message) || e), 'warn'); }
    finally { refreshing.delete(id); await load(); paintAll(id); }
  }
  async function turnOnRoutines() {
    try {
      const r = await post('/api/cron/arm', { enabled: true });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      notify('Scheduling is on: your apps refresh on schedule.');
    } catch (_) { notify('Could not turn scheduling on — open WORK › AUTOMATE › SCHEDULES to check.', 'warn'); return; }
    await load(); paintAll();
  }
  async function removeApp(id) {
    try {
      const r = await post('/api/apps/delete', { id });
      if (!r.ok) { const j = await r.json().catch(() => ({})); notify((j && j.error) || 'Could not delete that app.', 'warn'); return false; }
    } catch (_) { notify('Could not delete that app — the station did not answer.', 'warn'); return false; }
    dropLocal(id);
    await load(); rerenderList();
    return true;
  }
  // the app is gone (deleted here, or by anything else): close its window, forget its session link, drop it from view
  function dropLocal(id) {
    const ui = UI(); if (ui && ui.closeTerm) ui.closeTerm('app.' + id);
    const h = host(); if (h && h.forgetApp) h.forgetApp(id);
    forgetSession(id);
    list = list.filter((a) => a.id !== id);
    syncDock();
  }
  async function renameApp(id, name) {
    const n = String(name || '').trim();
    if (!n) return false;
    try {
      const r = await post('/api/apps/rename', { id, name: n });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { notify((j && j.error) || 'Could not rename that app.', 'warn'); return false; }
    } catch (_) { notify('Could not rename that app — the station did not answer.', 'warn'); return false; }
    await load();
    const a = find(id), h = host();
    if (a && h && h.renameApp) h.renameApp(id, a.name);
    rerenderList();
    return true;
  }

  /* ---- the bar under an app window ---------------------------------------------------------------------------- */
  const held = new Map();   // app id -> text that could not be sent yet (shown in the bar's box, never dropped)
  function holdText(id, text) { held.set(id, String(text || '')); paintAll(id); }
  function barsOf(id) {
    const out = [];
    document.querySelectorAll('.term.plugin-app-win').forEach((w) => {
      const f = w.querySelector('iframe.plugin-frame'), bar = w.querySelector('.app-bar');
      if (bar && f && (!id || f.dataset.plugin === id)) out.push([bar, f.dataset.plugin]);
    });
    return out;
  }
  function mountBar(body, id) {
    let bar = body.querySelector(':scope > .app-bar');
    if (!bar) {
      bar = document.createElement('form');
      bar.className = 'app-bar';
      bar.innerHTML = '<div class="app-bar-row"><input class="apps-field app-change" maxlength="1500" autocomplete="off" aria-label="Describe a change to this app" placeholder="Describe a change — how it looks, what it shows, how it works">' +
        '<button class="apps-btn primary app-change-go" type="submit">CHANGE</button><button class="apps-btn app-refresh" type="button" hidden>⟳ REFRESH</button></div>' +
        '<div class="app-bar-status"><span class="app-status" role="status"></span><button class="apps-btn app-auto-toggle" type="button" aria-expanded="false">AUTO-UPDATE</button><button class="apps-btn app-arm" type="button" hidden>▶ TURN SCHEDULING ON</button></div>' +
        // AUTO-UPDATE: how often, and what each update does — in the Commander's own words
        '<div class="app-auto" hidden>' +
          '<div class="app-auto-h">Update this app by itself</div>' +
          '<div class="app-auto-every" role="group" aria-label="How often">' + CADENCES.map((c) => '<button class="apps-btn apps-chip" type="button" aria-pressed="false" data-every="' + c[0] + '">' + c[1] + '</button>').join('') + '</div>' +
          '<label class="app-auto-l">Each update should…</label>' +
          '<textarea class="apps-field app-auto-task" rows="2" maxlength="2000" aria-label="What each update should do" placeholder="e.g. refresh what it shows · add today\'s numbers · give it a new look every Monday"></textarea>' +
          '<div class="app-auto-acts"><button class="apps-btn primary app-auto-save" type="button">SAVE</button><span class="app-auto-note" role="status"></span></div>' +
        '</div>';
      bar.addEventListener('submit', (e) => {
        e.preventDefault();
        const inp = bar.querySelector('.app-change');
        const r = change(id, inp.value);
        if (r.ok) { inp.value = ''; held.delete(id); notify(r.state === 'queued' ? 'Queued — your crew takes it when the current task finishes.' : 'Sent to your crew — follow along in COMMS.'); paintAll(id); }
        else if (r.state !== 'empty') notify('COMMS is not ready yet — your text is kept here; press the button again in a moment.', 'warn');
      });
      bar.querySelector('.app-refresh').addEventListener('click', () => refreshNow(id));
      bar.querySelector('.app-arm').addEventListener('click', () => turnOnRoutines());
      wireAuto(bar, id);
      body.appendChild(bar);
    }
    paintBar(bar, find(id));
    if (!find(id)) load().then(() => paintBar(bar, find(id)));
  }
  // AUTO-UPDATE — the cadences on offer (the routine system goes down to a minute; each update is a crew run, so
  // the shortest here is 15 minutes; anything that must tick live is the page's own JS)
  const CADENCES = [['off', 'Off'], ['every 15m', 'Every 15 min'], ['every 1h', 'Hourly'], ['every 6h', 'Every 6h'], ['every 1d', 'Daily'], ['every 7d', 'Weekly']];
  const DEFAULT_TASK = 'Bring it up to date: refresh what it shows with current information.';
  function wireAuto(bar, id) {
    const panel = bar.querySelector('.app-auto'), toggle = bar.querySelector('.app-auto-toggle');
    let chips = bar.querySelectorAll('.app-auto-every [data-every]');
    const task = bar.querySelector('.app-auto-task');
    const note = bar.querySelector('.app-auto-note'), save = bar.querySelector('.app-auto-save');
    let pick = 'off';
    const press = (every) => { pick = every; chips.forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.every === every))); task.disabled = every === 'off'; };
    toggle.addEventListener('click', () => {
      const open = panel.hidden;
      panel.hidden = !open; toggle.setAttribute('aria-expanded', String(open));
      if (!open) return;
      const a = find(id), s = a && a.schedule && !a.schedule.missing ? a.schedule : null;
      const row = bar.querySelector('.app-auto-every');
      const oldCustom = row.querySelector('.app-auto-custom'); if (oldCustom) oldCustom.remove();
      if (s && !CADENCES.some((c) => c[0] === s.every)) {
        // a cadence the chips do not offer (the crew set it, e.g. "0 8 * * *"): shown as its own chip, kept on SAVE
        const c = document.createElement('button');
        c.className = 'apps-btn apps-chip app-auto-custom'; c.type = 'button'; c.dataset.every = s.every;
        c.textContent = 'Custom · ' + String(s.display || s.every).replace(/^every /, '');
        c.addEventListener('click', () => press(s.every));
        row.appendChild(c);
        chips = row.querySelectorAll('[data-every]');
      }
      press(s ? s.every : 'off');
      task.value = (s && s.task) || DEFAULT_TASK;
      note.textContent = 'Each update is a crew run on your model.';
    });
    chips.forEach((c) => c.addEventListener('click', () => press(c.dataset.every)));
    save.addEventListener('click', async () => {
      const t = task.value.trim();
      if (pick !== 'off' && !t) { note.textContent = 'Say what each update should do.'; task.focus(); return; }
      save.disabled = true; note.textContent = 'Saving…';
      try {
        const r = await post('/api/apps/schedule', { id, every: pick, task: t });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error((j && j.error) || 'the station could not save that');
        await load();
        panel.hidden = true; toggle.setAttribute('aria-expanded', 'false');
        paintAll(id);   // said inline: the toggle and the status line under the window now read the new schedule
      } catch (e) { note.textContent = (e && e.message) || String(e); }
      finally { save.disabled = false; }
    });
  }
  function paintBar(bar, a) {
    if (!bar) return;
    const at = bar.querySelector('.app-auto-toggle');
    if (at) { const s = a && a.schedule; at.textContent = s && !s.missing ? 'AUTO-UPDATE · ' + (s.enabled === false ? 'paused' : String(s.display || s.every).replace(/^every /, '')) : 'AUTO-UPDATE'; }
    bar.querySelector('.app-status').textContent = a ? statusOf(a) : '';
    const s = a && a.schedule, busy = !!(a && refreshing.has(a.id));
    const rf = bar.querySelector('.app-refresh');
    rf.hidden = !(s && s.jobId && !s.missing);
    rf.disabled = busy; rf.textContent = busy ? '⟳ REFRESHING…' : '⟳ REFRESH';
    bar.querySelector('.app-arm').hidden = !(s && !s.missing && !routinesOn);
    // an app the crew has not built yet: the box builds it (and holds a description that could not be sent)
    const inp = bar.querySelector('.app-change'), go = bar.querySelector('.app-change-go');
    const unbuilt = !!a && !built(a);
    go.textContent = unbuilt ? 'BUILD' : 'CHANGE';
    inp.placeholder = unbuilt ? 'Describe what it should do — your crew builds it' : 'Describe a change — how it looks, what it shows, how it works';
    if (a && held.has(a.id) && !inp.value && document.activeElement !== inp) inp.value = held.get(a.id);
  }
  // repaint from what is already known (no fetch): every bar of `id` (or all), and the list's status lines
  function paintAll(id) {
    for (const [bar, appId] of barsOf(id)) paintBar(bar, find(appId));
    if (listEl && listEl.isConnected) listEl.querySelectorAll('.app-row').forEach((row) => {
      const a = find(row.dataset.app); if (!a) return;
      const st = row.querySelector('.app-row-status'); if (st) st.textContent = statusOf(a);
      const rb = row.querySelector('[data-app-refresh]'); if (rb) { rb.disabled = refreshing.has(a.id); rb.textContent = refreshing.has(a.id) ? '⟳ REFRESHING…' : '⟳ REFRESH NOW'; }
    });
  }
  function refreshBar(id) { return load().then(() => paintAll(id)); }
  const repaintDock = () => syncDock();   // the status lines update in place (see syncDock)

  /* ---- the APPS window ---------------------------------------------------------------------------------------- */
  let listEl = null;
  function rerenderList() {
    if (!listEl || !listEl.isConnected) return;
    if (loadError && !list.length) { listEl.innerHTML = '<div class="ext-empty">Could not load your apps — the station did not answer. <button class="apps-btn" type="button" data-app-retry>RETRY</button></div>'; return; }
    if (!list.length) { listEl.innerHTML = '<div class="ext-empty">No apps yet. Describe one above — your crew builds it in its own window.</div>'; return; }
    // a card = NAME + ONE short status line + its keys; the description is the hover tip (no sentences under tiles)
    listEl.innerHTML = list.map((a) => '<div class="mc-row ext-row app-row" data-app="' + esc(a.id) + '"' +
      (a.description ? ' data-tip="' + esc(a.description) + '" aria-description="' + esc(a.description) + '"' : '') + '>' +
      '<div class="mc-top"><b class="app-row-name">' + esc(a.name) + '</b><span class="mc-state ' + (built(a) ? 'app-ready' : 'app-unbuilt') + '">' + (built(a) ? '● ready' : '○ not built yet') + '</span></div>' +
      '<div class="mc-hint app-row-status">' + esc(statusOf(a)) + '</div>' +
      '<div class="mc-acts"><button class="apps-btn" type="button" data-app-open="' + esc(a.id) + '">OPEN</button>' +
      (a.schedule && a.schedule.jobId && !a.schedule.missing ? '<button class="apps-btn" type="button" data-app-refresh="' + esc(a.id) + '"' + (refreshing.has(a.id) ? ' disabled' : '') + '>' + (refreshing.has(a.id) ? '⟳ REFRESHING…' : '⟳ REFRESH NOW') + '</button>' : '') +
      '<button class="apps-btn" type="button" data-app-rename="' + esc(a.id) + '">RENAME</button>' +
      '<button class="apps-btn danger" type="button" data-app-delete="' + esc(a.id) + '">DELETE</button></div></div>').join('');
    listEl.querySelectorAll('[data-app-delete]').forEach((btn) => {
      const del = () => removeApp(btn.dataset.appDelete);
      if (typeof ArmConfirm !== 'undefined' && ArmConfirm.wire) ArmConfirm.wire(btn, { armedLabel: 'SURE? DELETE', restLabel: 'DELETE', timeoutMs: 4000, onConfirm: del });
      else btn.addEventListener('click', del);
    });
  }
  // RENAME: the name becomes a field in place; Enter saves, Escape (or leaving it unchanged) puts the name back
  function startRename(id) {
    const row = listEl && listEl.querySelector('.app-row[data-app="' + (root.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    const a = find(id), nameEl = row && row.querySelector('.app-row-name');
    if (!a || !nameEl || row.querySelector('.app-rename-in')) return;
    const inp = document.createElement('input');
    inp.className = 'apps-field app-rename-in'; inp.maxLength = 60; inp.value = a.name; inp.autocomplete = 'off';
    inp.setAttribute('aria-label', 'New name for ' + a.name);
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      const v = inp.value.trim();
      if (save && v && v !== a.name) { if (await renameApp(id, v)) return; }
      rerenderList();
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } });
    inp.addEventListener('blur', () => finish(true));
    nameEl.replaceWith(inp);
    inp.focus(); inp.select();
  }
  function buildWindow(body) {
    body.innerHTML =
      '<form class="apps-new mc-form" aria-label="New app">' +
      '<div class="apps-h">NEW APP</div>' +
      '<label for="app-name">Name</label>' +
      '<input id="app-name" class="apps-field" maxlength="60" autocomplete="off" aria-describedby="apps-msg" placeholder="Call it anything">' +
      '<label for="app-what">What should it do?</label>' +
      '<textarea id="app-what" class="apps-field apps-what" maxlength="1500" rows="4" aria-describedby="apps-msg" placeholder="In your own words: what it shows or does, how it should look, and whether it updates by itself."></textarea>' +
      '<div class="mc-hint">It can be anything — a dashboard, a tracker, a tool, a game. Say how it should look and work; where you don\'t, it matches the station.</div>' +
      '<div class="apps-examples"><span class="mc-hint">Try:</span>' + EXAMPLES.map((e, i) => '<button class="apps-btn apps-chip" type="button" aria-pressed="false" data-app-example="' + i + '">' + esc(e[0]) + '</button>').join('') + '</div>' +
      '<div class="mc-acts"><button class="apps-btn primary" id="app-create" type="submit">+ BUILD IT</button><span id="apps-msg" class="mc-hint apps-msg" role="status"></span></div>' +
      '</form>' +
      '<div class="apps-h">YOUR APPS</div>' +
      '<div class="apps-list"><div class="mc-hint">loading…</div></div>';
    listEl = body.querySelector('.apps-list');
    const form = body.querySelector('.apps-new'), btn = body.querySelector('#app-create');
    const nameEl = body.querySelector('#app-name'), whatEl = body.querySelector('#app-what'), msg = body.querySelector('.apps-msg');
    const chips = body.querySelectorAll('[data-app-example]');
    chips.forEach((b) => b.addEventListener('click', () => { const e = EXAMPLES[+b.dataset.appExample]; nameEl.value = e[0]; whatEl.value = e[1]; chips.forEach((c) => c.setAttribute('aria-pressed', String(c === b))); whatEl.focus(); }));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (btn.disabled) return;
      const name = nameEl.value.trim(), what = whatEl.value.trim();
      if (!name) { msg.textContent = 'Give it a name.'; nameEl.focus(); return; }
      if (!what) { msg.textContent = 'Say what it should do.'; whatEl.focus(); return; }
      btn.disabled = true; msg.textContent = 'Creating…';
      try {
        const out = await create(name, what);
        nameEl.value = ''; whatEl.value = '';
        msg.textContent = out.sent.ok
          ? (out.sent.state === 'queued' ? 'Created — queued: your crew builds it when the current task finishes.' : 'Building — follow along in COMMS.')
          : 'Created, but COMMS was not ready, so your crew does not have it yet. Your description is in the box under the app\'s window — press BUILD there.';
        rerenderList();
      } catch (e) { msg.textContent = (e && e.message) || String(e); }
      finally { btn.disabled = false; }
    });
    // Enter in the description is a new line; Ctrl/Cmd+Enter builds
    whatEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); } });
    body.addEventListener('click', (ev) => {
      const o = ev.target.closest('[data-app-open]');
      if (o) { const a = find(o.dataset.appOpen), h = host(); if (a && h) h.openApp(a); return; }
      const r = ev.target.closest('[data-app-refresh]');
      if (r) { refreshNow(r.dataset.appRefresh); return; }
      const n = ev.target.closest('[data-app-rename]');
      if (n) { startRename(n.dataset.appRename); return; }
      if (ev.target.closest('[data-app-retry]')) { listEl.innerHTML = '<div class="mc-hint">loading…</div>'; load().then(rerenderList); }
    });
    load().then(rerenderList);
  }
  function openNew() {
    const ui = UI(); if (!ui || !ui.openTerm) return;
    ui.openTerm('apps');
    setTimeout(() => { const n = document.getElementById('app-name'); if (n) n.focus(); }, 60);
  }

  /* ---- the crew changed something (station bridge verbs) ----------------------------------------------------- */
  async function onReload(id, digest) {
    const was = find(id);
    await load();
    const a = find(id), h = host();
    if (!a) { if (was && !loadError) { dropLocal(id); rerenderList(); } return { ok: true }; }   // it was deleted
    // the crew made this app itself (asked for in COMMS, not through NEW APP): show it
    if (!was && h && h.openApp) h.openApp(a);
    if (h) { if (was && was.name !== a.name && h.renameApp) h.renameApp(id, a.name); h.appReload(id, a.digest || digest); }
    rerenderList(); paintAll(id);
    return { ok: true };
  }
  async function onData(id) {
    const h = host(); if (h) h.appData(id);
    await load(); paintAll(id);
    return { ok: true };
  }

  function init() {
    const ui = UI();
    if (ui && ui.registerWindow) ui.registerWindow('apps', 'APPS', buildWindow, { className: 'apps-win' });
    for (const nid of ['bb-newapp', 'bb-newapp-build']) { const nb = document.getElementById(nid); if (nb) nb.addEventListener('click', openNew); }
    // the station may still be booting: a failed first load is retried a few times, so the dock is never left wrong
    let tries = 0;
    const boot = () => load().then((ok) => { if (!ok && ++tries < 6) setTimeout(boot, 2500 * tries); else rerenderList(); });
    boot();
    // "Updated 3m ago" and "next 14:00" must not sit stale: repaint what is on screen once a minute (no fetch)
    setInterval(() => { if (document.hidden) return; repaintDock(); if (barsOf().length || (listEl && listEl.isConnected)) paintAll(); }, 60000);
  }
  root.AppsUI = { load, list: () => list.slice(), create, change, refreshNow, turnOnRoutines, renameApp, removeApp, mountBar, refreshBar, openNew, onReload, onData, _test: { statusOf, toCrew } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : this);
