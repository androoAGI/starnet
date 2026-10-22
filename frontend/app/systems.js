/* AGENT OS — systems.js : STATION SYSTEMS ONLINE — the dock grows with the station.

   A fresh station opens with the dock buttons a newcomer needs on day one. Every other dock button is a
   station SYSTEM that comes online the first time it matters (a finished job, a second crew member, an agent
   asking you to take its browser, you asking for something on a schedule...). Nothing is ever LOCKED:
     - every window still opens from a slash command, a deep link, a quest, an error door or the agent;
     - THE DOOR LAW: the moment anything routes the Commander to a system (a window opens, a bay opens, an
       agent's reply names it in capitals), that system comes online — the app never points at a hidden door;
     - QUESTS › Progress lists every system, offline ones included, and any of them can be brought online
       with one click; SHOW EVERYTHING (here, in SETTINGS › LOOK & SOUND, on the first dock hint) brings all of
       them online at once.
   A station that already existed when this shipped opens with EVERYTHING online — taking buttons away from
   someone who already uses them would be its own confusion. Only a station whose awakening starts after this
   ships grows its dock.

   STATE is per Commander (keyed by the hero's createdAt epoch, so a fresh start on the same machine grows again)
   and lives in localStorage — it is a UI preference, never a harness claim. The job counter is this module's
   OWN counter (finished runs it watched end), never a pre-existing stat read back as if it were history.

   This file never emits a bus event; it only listens (agent.run.end, agent.token). */
'use strict';
const Systems = (() => {
  const KEY = 'starnet.systems.v1';

  /* The dock, in dock order. sel = the dock button; terms = window keys whose opening brings it online (door
     law); words = capitalised names an agent may use for it in a reply; start = online on a fresh station;
     jobs = finished jobs after which it comes online on its own; how = the one short line QUESTS shows while it
     is offline; tip = what it is (the hover tip, never a sentence under a tile). */
  const LIST = [
    { id: 'agents', label: 'AGENTS', group: 'crew', sel: '.bb[data-term="agents"]', terms: ['agents', 'logbook', 'rewind'], start: true, tip: 'Each crew member’s dossier — config, memory, record' },
    { id: 'recruit', label: 'RECRUIT', group: 'crew', sel: '#bb-recruit', words: ['RECRUIT', 'RECRUITMENT BAY'], start: true, tip: 'Pick a class, or re-spec your agent' },
    { id: 'commander', label: 'YOU', group: 'crew', sel: '.bb[data-term="commander"]', terms: ['commander'], start: true, tip: 'What the station has learned about you' },
    { id: 'stepin', label: 'STEP-IN', group: 'crew', sel: '.bb[data-term="stepin"]', terms: ['stepin'], words: ['STEP-IN'], how: 'when an agent needs you to take its browser', tip: 'Take an agent’s browser when it needs you to sign in' },
    // ONE MENU (2026-10-01): MY WORK / AUTOMATE / CONNECT are each one dock button over several windows (stationui
    // FAMILIES) — every member window's key is listed in terms, so opening any of them by any door counts.
    { id: 'mywork', label: 'MY WORK', group: 'work', sel: '#bb-mywork', terms: ['tasks', 'work', 'deliverables', 'outbox'], start: true, tip: 'Tasks, finished work, work to rate, and ready-made jobs' },
    { id: 'automate', label: 'AUTOMATE', group: 'work', sel: '#bb-automate', terms: ['workflows', 'automation', 'routines', 'loops'], words: ['AUTOMATE', 'AUTOMATION', 'WORKFLOWS', 'WORKFLOW', 'ROUTINE', 'ROUTINES', 'CONVEYOR'], jobs: 3, crew: 2, how: 'when you ask for something on a schedule', tip: 'Workflows, schedules, goal loops and away work' },
    { id: 'quests', label: 'QUESTS', group: 'work', sel: '.bb[data-term="quests"]', terms: ['quests'], start: true, tip: 'Small steps toward your goals, and your progress' },
    { id: 'refit', label: 'BUILD MODE', group: 'build', sel: '#bb-build', start: true, tip: 'Rooms, gear and workflow lines' },
    { id: 'connect', label: 'CONNECT', group: 'build', sel: '#bb-connect', terms: ['connectors', 'skills', 'messaging'], words: ['ABILITIES', 'CHANNELS'], start: true, tip: 'Services your agents use, and where you message them' },
    { id: 'newapp', label: 'NEW APP', group: 'build', sel: '#bb-newapp-build', start: true, tip: 'Describe anything and your crew builds it in its own window' },
    { id: 'manual', label: 'FIELD MANUAL', group: 'system', sel: '.bb[data-term="manual"]', terms: ['manual'], start: true, tip: 'First mission, controls and the station handbook' },
    { id: 'settings', label: 'SETTINGS', group: 'system', sel: '.bb[data-term="settings"]', terms: ['settings'], start: true, tip: 'Models, keys, permissions, spending & more' },
    { id: 'updates', label: 'UPDATES', group: 'system', sel: '.bb[data-term="updates"]', terms: ['updates'], start: true, tip: 'Version and release notes' },
    { id: 'notifs', label: 'NOTIFICATIONS', group: 'system', sel: '.bb[data-term="notifs"]', terms: ['notifs'], start: true, tip: 'Alerts and unread events' }
  ];
  const BY_ID = new Map(LIST.map(s => [s.id, s]));
  const BY_TERM = new Map();
  LIST.forEach(s => (s.terms || []).forEach(t => BY_TERM.set(t, s.id)));

  // what the Commander types that means "this belongs on a schedule" / "reach me elsewhere"
  const SCHEDULE_RX = /\b(every\s+(day|morning|night|evening|week|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hour|month)|each\s+(day|morning|night|week)|daily|weekly|hourly|nightly|on a schedule|schedule[ds]?|remind me|recurring|routine)\b/i;
  const CHANNEL_RX = /\b(telegram|slack|discord|whatsapp|signal app|matrix|my phone|from my phone|text me|message me)\b/i;

  let state = null;          // { v, epoch, mode: 'staged'|'all', online: [], fresh: [], jobs, seenRuns: [] }
  let crewCount = () => 0;
  const replyBuf = new Map(); // runId -> trailing reply text (door law: an agent naming a system brings it online)
  let wired = false;

  const blank = (epoch, mode) => ({ v: 1, epoch: String(epoch), mode, online: LIST.filter(s => s.start).map(s => s.id), fresh: [], jobs: 0, seenRuns: [] });
  function load() { try { const r = JSON.parse(localStorage.getItem(KEY)); return r && r.v === 1 ? r : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }

  /* init({ epoch, fresh, crewCount }) — called once the game screen is entered. `fresh` = this Commander's
     awakening has not happened yet (a brand-new station). An unknown epoch on an already-awake station = an
     existing station meeting this feature for the first time → everything online. */
  function init(opts) {
    const o = opts || {};
    if (typeof o.crewCount === 'function') crewCount = o.crewCount;
    const epoch = String(o.epoch == null ? 'legacy' : o.epoch);
    const prior = load();
    if (prior && prior.epoch === epoch) state = prior;
    else state = blank(epoch, o.fresh ? 'staged' : 'all');
    if (!Array.isArray(state.online)) state.online = [];
    if (!Array.isArray(state.fresh)) state.fresh = [];
    // ONE MENU (2026-10-01) folded eight dock buttons into MY WORK / AUTOMATE / CONNECT: carry a growing dock's
    // old ids onto the menu that now holds them, so nothing that was online goes dark
    const FOLD = { tasks: 'mywork', deliverables: 'mywork', recipes: 'mywork', workflows: 'automate', automation: 'automate', abilities: 'connect', channels: 'connect' };
    const fold = list => Array.from(new Set(list.map(id => FOLD[id] || id).filter(id => BY_ID.has(id))));
    state.online = fold(state.online); state.fresh = fold(state.fresh);
    LIST.forEach(s => { if (s.start && !state.online.includes(s.id)) state.online.push(s.id); });
    if (!Array.isArray(state.seenRuns)) state.seenRuns = [];
    save();
    wire();
    apply();
    // the first-dock hint carries SHOW EVERYTHING for a returning power user (shown only while the dock is growing)
    const all = typeof document !== 'undefined' ? document.getElementById('nav-coach-all') : null;
    if (all && !all.dataset.sysWired) {
      all.dataset.sysWired = '1';
      all.addEventListener('click', () => { showEverything(); const x = document.getElementById('nav-coach-x'); if (x) x.click(); });
    }
  }

  const staged = () => !!state && state.mode === 'staged';
  function isOnline(id) {
    if (!state || state.mode !== 'staged') return true;
    return state.online.includes(id);
  }
  const itemOf = s => (typeof document !== 'undefined' && s && s.sel) ? document.querySelector('#bottombar ' + s.sel) : null;

  /* paint the dock: an offline system's button carries data-offline (CSS hides it; navdock's keyboard walk skips
     it). A separate attribute from `hidden`, so apps.js (which hides BUILD's NEW APP once the APPS dock exists)
     and this module never fight over one switch. A freshly-online button wears data-fresh until it is opened. */
  function apply() {
    if (typeof document === 'undefined') return;
    LIST.forEach(s => {
      const b = itemOf(s); if (!b) return;
      if (isOnline(s.id)) b.removeAttribute('data-offline'); else b.setAttribute('data-offline', '');
      if (state && state.fresh.includes(s.id) && isOnline(s.id)) b.setAttribute('data-fresh', ''); else b.removeAttribute('data-fresh');
    });
    document.querySelectorAll('#bottombar .bb-group').forEach(g => {
      g.classList.toggle('has-fresh', !!g.querySelector('.bb-menu .bb[data-fresh]:not([hidden])'));
    });
    const coachAll = document.getElementById('nav-coach-all');
    if (coachAll) coachAll.hidden = !staged();
    if (typeof StationUI !== 'undefined' && StationUI.refreshSystems) { try { StationUI.refreshSystems(); } catch (_) {} }
  }

  /* bring one system online. why = 'door' (something routed the Commander there — quiet, no fanfare beyond the
     NEW marker, because they are already looking at it) | 'grow' (a milestone — the level-up beat). */
  function online(id, why) {
    const s = BY_ID.get(id);
    if (!s || !state || isOnline(id)) return false;
    state.online.push(id);
    if (why !== 'opened') state.fresh.push(id);
    save();
    apply();
    if (why === 'grow') announce([s]);
    return true;
  }
  function announce(list) {
    if (!list.length || typeof StationUI === 'undefined' || !StationUI.notify) return;
    const names = list.map(s => s.label);
    const msg = (list.length === 1 ? 'NEW SYSTEM ONLINE — ' : 'NEW SYSTEMS ONLINE — ') + names.join(' · ')
      + ' · find ' + (list.length === 1 ? 'it' : 'them') + ' in the ' + Array.from(new Set(list.map(s => s.group.toUpperCase()))).join(' / ') + ' dock';
    try { StationUI.notify(msg, 'gold', undefined, { key: 'systems-online', transient: true, onClick: () => { if (StationUI.openTerm) StationUI.openTerm('quests', 'progress'); } }); } catch (_) {}   // a toast, not inbox history
    try { if (typeof SFX !== 'undefined' && SFX.level) SFX.level(); } catch (_) {}
  }
  function growTo(ids) {
    const fresh = [];
    ids.forEach(id => {
      const s = BY_ID.get(id);
      if (!s || isOnline(id)) return;
      state.online.push(id); state.fresh.push(id); fresh.push(s);
    });
    if (!fresh.length) return;
    save(); apply(); announce(fresh);
  }

  /* the Commander opened a system (any path): it is online, and no longer NEW */
  function opened(id) {
    if (!state) return;
    if (!isOnline(id)) online(id, 'opened');
    const i = state.fresh.indexOf(id);
    if (i >= 0) { state.fresh.splice(i, 1); save(); apply(); }
  }
  // door law for windows: StationUI calls this whenever a window opens, whoever opened it
  function openedTerm(key) {
    // the bay window is RECIPES (a MY WORK tab) or the recruit bay, depending on which library it opened on
    if (key === 'marketplace') { opened(typeof Marketplace !== 'undefined' && Marketplace.currentTab && Marketplace.currentTab() === 'recipes' ? 'mywork' : 'recruit'); return; }
    const id = BY_TERM.get(key); if (id) opened(id);
  }

  function showEverything() {
    if (!state) return;
    state.mode = 'all';
    state.online = LIST.map(s => s.id);
    state.fresh = [];
    save(); apply();
  }
  // the Commander ASKED for the small dock: back to the day-one buttons plus every system whose milestone this
  // station has already reached (the job counter runs in both modes, so a long-running station keeps those)
  function growWithMe() {
    if (!state) return;
    state.mode = 'staged';
    state.online = LIST.filter(s => s.start).map(s => s.id);
    state.fresh = [];
    const crew = (() => { try { return Number(crewCount()) || 0; } catch (_) { return 0; } })();
    LIST.forEach(s => { if (!s.start && ((s.jobs && state.jobs >= s.jobs) || (s.crew && crew >= s.crew))) state.online.push(s.id); });
    save(); apply();
  }

  /* milestones: jobs finished (this module's own counter) and crew size */
  function checkMilestones() {
    if (!staged()) return;
    const crew = (() => { try { return Number(crewCount()) || 0; } catch (_) { return 0; } })();
    growTo(LIST.filter(s => !isOnline(s.id) && ((s.jobs && state.jobs >= s.jobs) || (s.crew && crew >= s.crew))).map(s => s.id));
  }
  function noticeText(text) {
    if (!staged()) return;
    const t = String(text || '');
    const ids = [];
    if (SCHEDULE_RX.test(t)) ids.push('automate');
    if (CHANNEL_RX.test(t)) ids.push('connect');
    growTo(ids.filter(id => !isOnline(id)));
  }
  // door law for agent replies: a system named in CAPITALS (the way the manual teaches agents to name doors)
  function noticeReply(text) {
    if (!staged()) return;
    const t = String(text || '');
    growTo(LIST.filter(s => !isOnline(s.id) && (s.words || []).some(w => new RegExp('(^|[^A-Z])' + w.replace(/[-]/g, '\\-') + '($|[^A-Z])').test(t))).map(s => s.id));
  }

  function wire() {
    if (wired || typeof U === 'undefined' || !U.bus || !U.bus.on) return;
    wired = true;
    U.bus.on('agent.token', p => {
      if (!state || !staged() || !p || !p.runId || typeof p.delta !== 'string') return;
      const prev = replyBuf.get(p.runId) || '';
      replyBuf.set(p.runId, (prev + p.delta).slice(-4000));
      if (replyBuf.size > 24) replyBuf.delete(replyBuf.keys().next().value);
    });
    U.bus.on('agent.run.end', p => {
      if (!state || !p) return;
      const reply = p.runId ? replyBuf.get(p.runId) : '';
      if (p.runId) replyBuf.delete(p.runId);
      if (reply) noticeReply(reply);   // no-op unless the dock is growing
      // a finished job = a clean run that actually took a turn, counted once per run id (in both modes, so a
      // later GROW WITH ME knows which milestones this station already reached)
      if (p.reason !== 'done' || p.turns === 0) return;
      const id = String(p.runId || '');
      if (id && state.seenRuns.includes(id)) return;
      if (id) { state.seenRuns.push(id); if (state.seenRuns.length > 40) state.seenRuns.splice(0, state.seenRuns.length - 40); }
      state.jobs = (Number(state.jobs) || 0) + 1;
      save();
      checkMilestones();   // no-op unless the dock is growing
    });
  }

  // the QUESTS › Progress track reads this (truthful: the counts are the dock's real state)
  function snapshot() {
    return {
      mode: state ? state.mode : 'all',
      total: LIST.length,
      online: LIST.filter(s => isOnline(s.id)).length,
      list: LIST.map(s => ({ id: s.id, label: s.label, group: s.group, tip: s.tip, how: s.how || '', online: isOnline(s.id), fresh: !!(state && state.fresh.includes(s.id)) }))
    };
  }
  /* bring a system online from the QUESTS track and open it the way its own dock button would */
  function openSystem(id) {
    const s = BY_ID.get(id); if (!s) return;
    opened(id);
    const b = itemOf(s);
    if (b) { try { b.click(); } catch (_) {} }
  }

  return { init, apply, online, opened, growTo: ids => { if (staged()) growTo(ids || []); }, openedTerm, showEverything, growWithMe, checkMilestones, noticeText, noticeReply, snapshot, openSystem, isOnline, staged, LIST };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Systems;
