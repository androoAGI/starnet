/* STARNET hudmode.js — HUD MODE: StarNet as a small always-on-top panel.
   For the Commander who is gaming or doing something else on the PC and wants every piece of work the
   station is doing one glance away, with a hand on each of them, without the whole station on screen.

   The HUD is NOT a second app. It is this same page with the station hidden, the world renderer
   stopped, and the REAL COMMS panel filling a compact frame. On the desktop the Rust shell
   (src-tauri/src/hud_mode.rs) turns the window itself into a corner panel: small, pinned above other
   windows, and restored to the exact size/position/maximized/fullscreen state it had when the HUD closes.

   ACTIVITY (where the HUD opens) is the project ACTIVITY feed (project-home.js) for the whole station:
   one .ph-card per piece of work, in the same markup and glass, each opening onto what it produced and
   the same hands the project feed gives (a direction, STOP WORK) plus OPEN CONVERSATION. CHAT is the
   COMMS conversation itself. Every card states only what the harness can prove:
     · WORKING cards are the runs GET /api/state/snapshot lists as live (the authority the world
       reconciles against), enriched by the real agent.run.* / agent.tool_call events on U.bus (the step
       a run is on). A run the snapshot stops listing is gone, whatever the last event said.
     · NEEDS YOUR OK is the snapshot showing a permission prompt pending on that run.
     · delegated work is GET /api/subagents (the worker ledger the project feed reads); finished work is
       GET /api/runs (the run history), with the harness's own self-talk (internal) left out.
     · a failing poll says so; before the first answer lands the feed claims nothing.
   Everything is event/interval driven; the HUD adds no animation loop of its own. */
'use strict';

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HudMode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const PREF_KEY = 'starnet.hud';          // { pinned, rect } — per machine, a convenience only
  const POLL_MS = 4000;                    // live cadence while the HUD is up (local sidecar, tiny JSON)
  const HISTORY_MS = 12000;                // finished-work cadence (run history + worker ledger)
  const START_GRACE_MS = 8000;             // an event-only run the snapshot has not caught up with yet
  const RECENT_MAX = 12;                   // finishes this page saw (one per run)
  const RECENT_TTL_MS = 15 * 60 * 1000;    // a finish older than this is history, not "recent"
  const LIVE_MAX = 5;                      // (summary model) live rows before "+N MORE"
  const FINISHED_WINDOW_MS = 12 * 60 * 60 * 1000;   // finished work shown: the last 12 hours…
  const FINISHED_MAX = 10;                 // …at most this many cards
  const TAURI_EVENT = 'starnet-hud';       // hud_mode.rs emits { active } from the tray menu

  /* ---------------- pure feed model (unit-tested in test/hudmode.test.js) ---------------- */

  function createFeed() {
    return { runs: new Map(), recent: [], prompts: new Set(), queues: new Map(), snapAt: 0, snapOk: null };
  }

  function touchRun(feed, p, now) {
    const id = String(p.runId);
    let r = feed.runs.get(id);
    if (!r) {
      r = { runId: id, agentId: String(p.agentId || ''), startedAt: null, seenAt: now, tool: '', callId: '', writing: false, trigger: '', confirmed: false };
      feed.runs.set(id, r);
    }
    if (p.agentId) r.agentId = String(p.agentId);
    r.seenAt = now;
    return r;
  }

  function onRunStart(feed, p, now) {
    if (!p || !p.runId || !p.agentId) return;
    const r = touchRun(feed, p, now);
    if (!r.startedAt) r.startedAt = now;
    if (p.trigger) r.trigger = String(p.trigger);
  }

  function onToolCall(feed, p, now) {
    if (!p || !p.runId || !p.name) return;
    const r = touchRun(feed, p, now);
    r.tool = String(p.name);
    r.callId = String(p.callId || '');
    r.writing = false;
  }

  /* The tool came back: the run is with the model again, so the row stops naming the tool.
     Returns whether the row changed (callers re-render only then). */
  function onToolResult(feed, p, now) {
    if (!p || !p.runId) return false;
    const r = feed.runs.get(String(p.runId));
    if (!r || !r.tool || (r.callId && p.callId && String(p.callId) !== r.callId)) return false;
    r.tool = ''; r.callId = ''; r.seenAt = now;
    return true;
  }

  /* Reply text is streaming (only the page that started a run receives its tokens — the SSE tee never
     carries them — so this lights for COMMS turns sent from this window, never guessed for others). */
  function onToken(feed, p, now) {
    if (!p || !p.runId) return false;
    const r = feed.runs.get(String(p.runId));
    if (!r) return false;
    r.seenAt = now;
    if (r.writing && !r.tool) return false;
    r.writing = true; r.tool = ''; r.callId = '';
    return true;
  }

  function pushRecent(feed, row) {
    feed.recent.unshift(row);
    if (feed.recent.length > RECENT_MAX) feed.recent.length = RECENT_MAX;
  }

  function onRunEnd(feed, p, now) {
    if (!p || !p.runId) return;
    const r = feed.runs.get(String(p.runId));
    feed.runs.delete(String(p.runId));
    const agentId = String(p.agentId || (r && r.agentId) || '');
    if (!agentId) return;
    // One row per run: a run.error already recorded for it is superseded by the run's own end.
    feed.recent = feed.recent.filter(x => x.runId !== String(p.runId));
    const reason = String(p.reason || 'done');
    pushRecent(feed, { runId: String(p.runId), agentId, reason, at: now });
  }

  function onRunError(feed, p, now) {
    if (!p || !p.runId) return;
    const r = feed.runs.get(String(p.runId));
    feed.runs.delete(String(p.runId));
    const agentId = String(p.agentId || (r && r.agentId) || '');
    if (!agentId) return;
    // run.error is usually followed by run.end{error} for the same run: keep ONE row for it.
    feed.recent = feed.recent.filter(x => x.runId !== String(p.runId));
    pushRecent(feed, { runId: String(p.runId), agentId, reason: 'error', at: now });
  }

  /* The snapshot is the authority on WHAT is running. Event-only runs survive a short grace (the
     snapshot may simply be older than the run.start that arrived a moment ago); anything else the
     snapshot does not list is dropped. */
  function applySnapshot(feed, snap, now) {
    if (!snap || !Array.isArray(snap.runs)) return false;
    const live = new Set();
    for (const s of snap.runs) {
      if (!s || !s.runId) continue;
      const id = String(s.runId);
      live.add(id);
      const r = touchRun(feed, { runId: id, agentId: s.agentId }, now);
      const started = Number(s.startedAt);
      if (isFinite(started) && started > 0) r.startedAt = started;
      else if (!r.startedAt) r.startedAt = now;
      r.confirmed = true;
      if (s.source) r.source = String(s.source);
      if (s.streamId) r.streamId = String(s.streamId);
      r.internal = s.internal === true;
      // whether STOP / a direction can reach this run (a work-line step or a channel hub run is not in the
      // station's stoppable set): the card never offers a control whose 'ok' would be a lie
      if (typeof s.stoppable === 'boolean') r.stoppable = s.stoppable;
    }
    for (const [id, r] of feed.runs) {
      if (live.has(id)) continue;
      if (r.confirmed || now - r.seenAt > START_GRACE_MS) feed.runs.delete(id);
    }
    feed.prompts = new Set((Array.isArray(snap.prompts) ? snap.prompts : []).map(p => p && String(p.runId)).filter(Boolean));
    feed.queues = new Map();
    for (const q of (Array.isArray(snap.queues) ? snap.queues : [])) {
      if (q && q.agentId && (q.depth | 0) > 0) feed.queues.set(String(q.agentId), q.depth | 0);
    }
    feed.snapAt = now;
    feed.snapOk = true;
    return true;
  }

  function snapshotFailed(feed) { feed.snapOk = false; }

  /** mcp__github__create_issue → GITHUB::CREATE.ISSUE, web_search → WEB.SEARCH (the CAM-HUD spelling). */
  function toolLabel(name) {
    let n = String(name || '').trim();
    if (!n) return '';
    const m = /^mcp__(.+?)__(.+)$/.exec(n);
    if (m) n = m[1] + '::' + m[2];
    return n.replace(/[_-]+/g, '.').toUpperCase();
  }

  function fmtElapsed(ms) {
    if (!isFinite(ms) || ms < 0) return '';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  }

  function fmtAgo(ms) {
    if (!isFinite(ms) || ms < 0) return '';
    const s = Math.floor(ms / 1000);
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    return Math.round(m / 60) + 'h ago';
  }

  // run.end reasons in the HUD's words. 'clarifying' is the agent asking the Commander a question:
  // the one finish a glancing Commander most needs to catch.
  const END_WORDS = {
    done: { text: 'DONE', tone: 'ok' },
    clarifying: { text: 'ASKED YOU', tone: 'ask' },
    cancelled: { text: 'STOPPED', tone: 'dim' },
    error: { text: 'FAULT', tone: 'bad' },
    budget: { text: 'SPEND CAP', tone: 'bad' },
    max_iters: { text: 'TURN LIMIT', tone: 'bad' },
    refusal: { text: 'REFUSED', tone: 'bad' },
    empty: { text: 'EMPTY REPLY', tone: 'bad' }
  };

  /** The deck's rows + summary from the feed. `who(agentId)` → { name, color } or null. */
  function view(feed, who, now) {
    const name = id => { const w = who(id); return (w && w.name) || (id ? String(id).slice(0, 10).toUpperCase() : 'AGENT'); };
    const color = id => { const w = who(id); return (w && w.color) || ''; };
    const live = Array.from(feed.runs.values())
      .sort((a, b) => (a.startedAt || now) - (b.startedAt || now))
      .map(r => {
        const waiting = feed.prompts.has(r.runId);
        return {
          kind: 'live', runId: r.runId, agentId: r.agentId, name: name(r.agentId), color: color(r.agentId),
          waiting,
          step: waiting ? 'NEEDS YOUR OK' : r.tool ? toolLabel(r.tool) : r.writing ? 'WRITING REPLY' : 'RUNNING',
          trigger: r.trigger === 'schedule' ? 'ROUTINE' : r.trigger === 'nightshift' ? 'AUTONOMY' : r.trigger === 'loop' ? 'LOOP' : '',
          elapsed: r.startedAt ? fmtElapsed(now - r.startedAt) : '',
          queued: feed.queues.get(r.agentId) || 0
        };
      });
    const recent = feed.recent
      .filter(x => now - x.at <= RECENT_TTL_MS)
      .map(x => {
        const w = END_WORDS[x.reason] || { text: String(x.reason || '').toUpperCase(), tone: 'dim' };
        return { kind: 'recent', runId: x.runId, agentId: x.agentId, name: name(x.agentId), color: color(x.agentId), text: w.text, tone: w.tone, ago: fmtAgo(now - x.at) };
      });
    const waiting = live.filter(r => r.waiting).length;
    const working = live.length;
    let summary;
    if (feed.snapOk === false) summary = { text: 'NO LINK', tone: 'bad' };
    else if (feed.snapOk == null && !working) summary = { text: '…', tone: 'dim' };
    else if (waiting) summary = { text: waiting + ' NEED' + (waiting === 1 ? 'S' : '') + ' YOU', tone: 'ask' };
    else if (working) summary = { text: working + ' WORKING', tone: 'live' };
    else summary = { text: 'STATION IDLE', tone: 'dim' };
    return {
      summary,
      live: live.slice(0, LIVE_MAX),
      more: Math.max(0, live.length - LIVE_MAX),
      recent
    };
  }

  /* ---------------- the ACTIVITY feed: every piece of work on the station ---------------- */

  const arr = v => (Array.isArray(v) ? v : []);
  const SOURCE_WORDS = {
    cron: 'Scheduled routine', nightshift: 'Autonomy', workshop: 'Workshop build', host: 'Work line step',
    telegram: 'Message from Telegram', discord: 'Message from Discord', slack: 'Message from Slack',
    matrix: 'Message from Matrix', signal: 'Message from Signal'
  };
  const TRIGGER_WORDS = { schedule: 'Scheduled routine', nightshift: 'Autonomy', loop: 'Loop' };
  // a finished run's reason, in the project feed's words: [state, status]
  const FINISH = {
    done: ['done', 'Completed'], clarifying: ['ask', 'Asked you a question'], cancelled: ['stopped', 'Stopped'],
    error: ['fault', 'Needs attention'], budget: ['fault', 'Stopped at the spend cap'], max_iters: ['fault', 'Stopped at the turn limit'],
    refusal: ['fault', 'Refused'], empty: ['fault', 'Ended without a reply']
  };
  const WORKER_END = {
    done: ['done', 'Completed'], interrupted: ['stopped', 'Stopped'], error: ['fault', 'Needs attention'],
    stale: ['fault', 'Lost when the station restarted'], refused: ['fault', 'Refused']
  };

  function oneLine(v, max) {
    const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    const cap = max || 160;
    return t.length > cap ? t.slice(0, cap - 1).replace(/\s+\S*$/, '') + '…' : t;
  }
  const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && typeof p.text === 'string' ? p.text : '')).join(' ') : '');
  const artifactNames = list => arr(list)
    .map(a => (typeof a === 'string' ? a : (a && (a.path || a.name || a.title)) || ''))
    .filter(Boolean).map(p => String(p).split(/[\\/]/).pop());
  const uniq = list => Array.from(new Set(list));

  /** What a live run is about: the Commander's words in the conversation that owns it (its stream lists
      the run), else that conversation's title. '' when no conversation on this page owns the run. */
  function taskOfRun(runId, streams, streamId) {
    for (const s of arr(streams)) {
      if (!s || !(arr(s.runIds).includes(runId) || (streamId && s.id === streamId))) continue;
      const h = arr(s.history);
      for (let i = h.length - 1; i >= 0; i--) {
        if (h[i] && h[i].role === 'user') { const t = oneLine(textOf(h[i].content), 200); if (t) return { task: t, streamId: s.id || '' }; }
      }
      return { task: oneLine(s.title || '', 200), streamId: s.id || '' };
    }
    return { task: '', streamId: '' };
  }

  /** What a run said: the assistant rows its own conversation tagged with that run (the transcript COMMS
      renders), joined. '' when this page holds no such rows. */
  function replyOfRun(runId, streamId, streams) {
    for (const s of arr(streams)) {
      if (!s || !(s.id === streamId || arr(s.runIds).includes(runId))) continue;
      // a folded direction streams back as a '[steering] …' line inside the reply text (COMMS draws it as its own
      // note row): it is the Commander's words, never the agent's result
      const said = arr(s.history).filter(h => h && h.role === 'assistant' && h.sourceRunId === runId && !h.error)
        .map(h => textOf(h.content).replace(/(^|\n)\[steering\] [^\n]*/g, '$1')).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
      if (said) return said.length > 2000 ? said.slice(0, 1999) + '…' : said;
    }
    return '';
  }

  /** The feed. input = { feed, workers (GET /api/subagents records), finished (GET /api/runs rows),
      agents (roster), streams (Workstreams), now }. Returns cards in the order a glance needs them:
      needs your OK, then working (oldest first), then finished (newest first). A run appears once:
      a delegated worker's run is its worker card, a live run is never also a finished one. */
  function workItems(input) {
    const i = input || {};
    const t = isFinite(i.now) ? i.now : Date.now();
    const feed = i.feed || createFeed();
    const agents = arr(i.agents), streams = arr(i.streams), workers = arr(i.workers), finished = arr(i.finished);
    const who = id => {
      const a = agents.find(x => x && x.id === id);
      return { name: String((a && (a.name || a.id)) || (id ? String(id).slice(0, 10) : 'AGENT')).toUpperCase(), color: (a && a.color) || '' };
    };
    const workerRuns = new Set(workers.map(w => w && w.runId).filter(Boolean));
    const seen = new Set();
    const out = [];

    for (const r of feed.runs.values()) {
      // the harness's own self-talk (a post-reply pass, a reflection) is real but it is not the Commander's work
      if (!r || r.internal || workerRuns.has(r.runId) || r.source === 'subagent') continue;
      const asking = feed.prompts.has(r.runId);
      const found = taskOfRun(r.runId, streams, r.streamId);
      const w = who(r.agentId);
      out.push({
        key: 'run:' + r.runId, kind: 'run', runId: r.runId, agentId: r.agentId, name: w.name, color: w.color,
        state: asking ? 'ask' : 'live',
        status: asking ? 'Needs your OK' : r.tool ? 'Using ' + toolLabel(r.tool) : r.writing ? 'Writing reply' : 'Working',
        time: r.startedAt ? fmtElapsed(t - r.startedAt) : '', sortAt: r.startedAt || t,
        task: found.task || TRIGGER_WORDS[r.trigger] || SOURCE_WORDS[r.source] || 'Working on a task',
        result: '', tools: [], outputs: [], directions: [],
        canSteer: !asking && r.stoppable !== false, canStop: r.stoppable !== false, streamId: found.streamId
      });
      seen.add(r.runId);
    }

    for (const wk of workers) {
      if (!wk || !wk.id) continue;
      const running = wk.status === 'running';
      const endAt = wk.completedAt || wk.updatedAt || 0;
      if (!running && !(endAt && t - endAt <= FINISHED_WINDOW_MS)) continue;
      const asking = running && !!wk.runId && feed.prompts.has(wk.runId);
      const end = WORKER_END[wk.status] || ['stopped', wk.status ? 'Ended (' + String(wk.status) + ')' : 'Ended'];
      const w = who(wk.agentId);
      out.push({
        key: 'worker:' + wk.id, kind: 'worker', workerId: wk.id, generation: wk.generation, runId: wk.runId || '',
        agentId: wk.agentId, name: w.name, color: w.color,
        state: running ? (asking ? 'ask' : 'live') : end[0],
        status: running ? (asking ? 'Needs your OK' : wk.working ? 'Working' : 'Starting') : end[1],
        time: running ? (wk.startedAt ? fmtElapsed(t - wk.startedAt) : '') : (endAt ? fmtAgo(t - endAt) : ''),
        sortAt: running ? (wk.startedAt || t) : endAt,
        task: oneLine(wk.prompt, 200) || 'Delegated work',
        result: String(wk.result || ''), tools: [], outputs: artifactNames(wk.artifacts),
        directions: arr(wk.steerHistory).map(s => (s && s.status === 'applied' ? 'Direction applied: ' : 'Direction queued: ') + ((s && s.text) || '')),
        canSteer: running && !!wk.canInterrupt, canStop: running && !!wk.canInterrupt,
        streamId: wk.streamId || wk.parentStreamId || ''
      });
      if (wk.runId) seen.add(wk.runId);
    }

    let shown = 0;
    const rows = finished.slice().sort((a, b) => ((b && (b.endedAt || b.ts)) || 0) - ((a && (a.endedAt || a.ts)) || 0));
    for (const row of rows) {
      if (shown >= FINISHED_MAX) break;
      if (!row || !row.runId || row.internal || row.stepTest || seen.has(row.runId) || workerRuns.has(row.runId)) continue;
      const endAt = row.endedAt || row.ts || 0;
      if (!endAt || t - endAt > FINISHED_WINDOW_MS) continue;
      const f = row.clarifying ? FINISH.clarifying : (FINISH[row.reason] || FINISH.done);
      const w = who(row.agentId);
      out.push({
        key: 'done:' + row.runId, kind: 'done', runId: row.runId, agentId: row.agentId, name: w.name, color: w.color,
        state: f[0], status: f[1], time: fmtAgo(t - endAt), sortAt: endAt,
        task: oneLine(row.title || row.deliveryPrompt || row.sessionTitle, 200) || 'Task',
        result: String(row.deliveryText || '') || replyOfRun(row.runId, row.streamId, streams),
        tools: uniq(arr(row.toolTrace).map(x => x && x.name && toolLabel(x.name)).filter(Boolean)),
        outputs: artifactNames(row.artifacts), directions: [],
        canSteer: false, canStop: false, streamId: row.streamId || ''
      });
      seen.add(row.runId);
      shown++;
    }

    const rank = s => (s === 'ask' ? 0 : s === 'live' ? 1 : 2);
    return out.sort((a, b) => {
      const d = rank(a.state) - rank(b.state);
      if (d) return d;
      return rank(a.state) < 2 ? a.sortAt - b.sortAt : b.sortAt - a.sortAt;
    });
  }

  /** The header's one line over the feed. `linkOk` false = a poll is failing (said, never hidden). */
  function feedSummary(items, feed, linkOk) {
    if ((feed && feed.snapOk === false) || linkOk === false) return { text: 'NO LINK', tone: 'bad' };
    if (feed && feed.snapOk == null && !arr(items).length) return { text: '…', tone: 'dim' };
    const ask = arr(items).filter(x => x.state === 'ask').length;
    const live = arr(items).filter(x => x.state === 'live').length;
    const parts = [];
    if (ask) parts.push(ask + ' NEED' + (ask === 1 ? 'S' : '') + ' YOU');
    if (live) parts.push(live + ' WORKING');
    if (!parts.length) return { text: 'ALL QUIET', tone: 'dim' };
    return { text: parts.join(' · '), tone: ask ? 'ask' : 'live' };
  }

  /* ---------------- preferences (localStorage is a convenience; failures read as defaults) ---------------- */

  function readPrefs(store) {
    try {
      const raw = store && store.getItem(PREF_KEY);
      const p = raw ? JSON.parse(raw) : null;
      const rect = p && p.rect && ['x', 'y', 'w', 'h'].every(k => isFinite(Number(p.rect[k]))) ? {
        x: Math.round(Number(p.rect.x)), y: Math.round(Number(p.rect.y)), w: Math.round(Number(p.rect.w)), h: Math.round(Number(p.rect.h))
      } : null;
      const widget = p && p.widget && ['w', 'h'].every(k => Number(p.widget[k]) > 0) ? { w: Math.round(Number(p.widget.w)), h: Math.round(Number(p.widget.h)) } : null;
      return { pinned: !(p && p.pinned === false), rect, widget };
    } catch (_) { return { pinned: true, rect: null, widget: null }; }
  }

  function writePrefs(store, prefs) {
    try { if (store) store.setItem(PREF_KEY, JSON.stringify({ pinned: !!prefs.pinned, rect: prefs.rect || null, widget: prefs.widget || null })); } catch (_) {}
  }

  /* ---------------- desktop bridge (Tauri) ---------------- */

  function tauriCore(win) {
    const t = win && win.__TAURI__;
    return t && t.core && typeof t.core.invoke === 'function' ? t.core : null;
  }

  /* ---------------- DOM + lifecycle (browser only) ---------------- */

  const doc = root && root.document;
  const S = {
    active: false, view: 'activity', pinned: true, desktop: false, busy: false,
    pollT: 0, histT: 0, tickT: 0, histSoon: 0, feed: createFeed(), workers: [], finished: [], histOk: null,
    els: null, cards: new Map(), bound: false, fetching: false, fetchingHist: false, titleWas: null, foldedH: 0,
    widget: null, frameT: 0, widgetFit: null, followId: '', followPinned: ''
  };

  const now = () => Date.now();
  const $ = id => (doc ? doc.getElementById(id) : null);
  const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const setText = (n, v) => { const t = String(v == null ? '' : v); if (n.textContent !== t) n.textContent = t; };

  function roster() {
    try { return (typeof App !== 'undefined' && App.agents) ? (App.agents() || []) : []; } catch (_) { return []; }
  }
  function streams() {
    try { return (typeof Workstreams !== 'undefined' && Workstreams.list) ? (Workstreams.list() || []) : []; } catch (_) { return []; }
  }
  function onLineId() {
    try { const ref = typeof Chat !== 'undefined' && Chat.contextRef ? Chat.contextRef() : null; if (ref && ref.agentId) return String(ref.agentId); } catch (_) {}
    try { if (typeof App !== 'undefined' && App.heroId) return String(App.heroId()); } catch (_) {}
    return '';
  }
  function gameScreen() { return $('screen-game'); }
  function inGame() { const g = gameScreen(); return !!(g && g.classList.contains('active')); }

  /* OPEN CONVERSATION: the conversation that owns this work when this page has it, else the agent's own
     most recent conversation. Never App.selectAgent from a blank thread: that rebinds the thread on screen
     to the picked agent and strands the one the Commander came back for. */
  function openConversation(item) {
    try {
      if (typeof App === 'undefined') return;
      const sid = item && item.streamId;
      const has = sid && typeof Workstreams !== 'undefined' && Workstreams.get && Workstreams.get(sid);
      if (has && App.openWorkstream) App.openWorkstream(sid);
      else if (item && item.agentId && item.agentId !== onLineId()) {
        const mine = streams().filter(w => (w.agentId || 'agent') === item.agentId);
        if (mine.length && App.openWorkstream) App.openWorkstream(mine[0].id);
        else if (App.selectAgent) App.selectAgent(item.agentId);
      }
    } catch (_) {}
    setView('chat');
  }

  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (_) {}
    if (!r.ok || (j && j.ok === false)) throw new Error((j && (j.error || j.reason)) || ('HTTP ' + r.status));
    return j;
  }

  // One card, built once and patched in place, so an open card keeps its place and a half-typed direction
  // survives every poll. The markup is the project ACTIVITY card (project-home.js createCard).
  function createCard(key) {
    const node = el('details', 'ph-card'), summary = el('summary');
    const agent = el('span', 'ph-agent'), status = el('span', 'ph-status'), task = el('span', 'ph-task');
    const body = el('div', 'ph-card-body');
    const result = el('pre', 'ph-result'), tools = el('p', 'ph-tools'), outputs = el('p', 'ph-tools'), directions = el('pre', 'ph-directions');
    const controls = el('div', 'ph-controls');
    const input = el('textarea'); input.rows = 2; input.placeholder = 'Give this agent a direction…'; input.setAttribute('aria-label', 'Direction for this work');
    const send = el('button', 'btn', 'SEND DIRECTION'), stop = el('button', 'btn', 'STOP WORK');
    const nav = el('div', 'ph-controls hud-card-nav'), open = el('button', 'btn', 'OPEN CONVERSATION');
    const receipt = el('p', 'ph-receipt'); receipt.setAttribute('role', 'status');
    send.type = stop.type = open.type = 'button';
    summary.append(agent, status, task); controls.append(input, send, stop); nav.append(open);
    body.append(result, tools, outputs, directions, controls, nav, receipt); node.append(summary, body);
    node.dataset.key = key;
    const card = { node, agent, status, task, result, tools, outputs, directions, controls, input, send, stop, open, receipt, item: null, pending: false };
    node.addEventListener('toggle', () => refit());
    open.addEventListener('click', () => openConversation(card.item));
    async function command(kind) {
      const it = card.item; if (!it) return;
      const text = input.value.trim();
      if (kind === 'steer' && !text) { input.focus(); return; }
      card.pending = true; send.disabled = stop.disabled = true;
      try {
        if (it.kind === 'worker') {
          await post(kind === 'steer' ? '/api/subagents/steer' : '/api/subagents/interrupt',
            kind === 'steer' ? { id: it.workerId, generation: it.generation, text } : { id: it.workerId });
        } else {
          await post(kind === 'steer' ? '/api/run/steer' : '/api/cancel', kind === 'steer' ? { runId: it.runId, text } : { runId: it.runId });
        }
        receipt.textContent = kind === 'steer' ? 'Direction sent. The agent takes it before its next step.' : 'Stop requested.';
        if (kind === 'steer') input.value = '';
      } catch (e) {
        receipt.textContent = (kind === 'steer' ? 'Direction not sent: ' : 'Stop not sent: ') + ((e && e.message) || 'the station did not answer') + '.';
      } finally {
        card.pending = false;
        poll();
        render();
      }
    }
    send.addEventListener('click', () => command('steer'));
    stop.addEventListener('click', () => command('stop'));
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); command('steer'); } });
    return card;
  }

  /* A card with no reply text on this page. The reply may well exist (a routine's, a Telegram thread's, one in a
     conversation this page has not loaded): say where it is, never that there was none. */
  function noResultWords(it) {
    if (it.state === 'live' || it.state === 'ask') return 'Waiting for the agent’s result.';
    if (it.state === 'stopped') return 'Stopped before it finished.';
    return it.streamId ? 'Its reply is in the conversation.' : 'Its reply isn’t shown here.';
  }

  function patchCard(card, it) {
    card.item = it;
    card.node.dataset.state = it.state;
    setText(card.agent, it.name);
    if (it.color) card.agent.style.color = it.color; else card.agent.style.removeProperty('color');
    setText(card.status, it.status + (it.time ? ' · ' + it.time : ''));
    setText(card.task, it.task);
    setText(card.result, it.result || noResultWords(it));
    setText(card.tools, it.tools.length ? 'Tools used: ' + it.tools.join(', ') : '');
    setText(card.outputs, it.outputs.map(o => 'Output: ' + o).join('\n'));
    setText(card.directions, it.directions.join('\n'));
    card.controls.hidden = !(it.canSteer || it.canStop);
    card.input.hidden = card.send.hidden = !it.canSteer;
    card.stop.hidden = !it.canStop;
    card.send.disabled = card.stop.disabled = card.pending;
    card.node.setAttribute('aria-label', it.name + ' · ' + it.status + (it.time ? ' ' + it.time : '') + ': ' + it.task);
  }

  /* ---------------- WIDGET: the HUD at its smallest ----------------
     The REAL station, small: the world renderer keeps running into the station's own view (#stage-wrap,
     its camera frame included) and its camera follows the agent a glance most needs, so what the widget
     shows is what the station is doing — at the desk when it works, walking the floor when it is idle.
     Under it, one row per agent with work under way: its lamp, name, run clock, step. A click on the view
     opens ACTIVITY; a click on a row points the camera at that agent. The world stops again whenever the
     widget is not on screen (ACTIVITY / CHAT), so the HUD costs nothing it does not show. */

  const ROW_MAX = 3;

  /** The widget's rows from the feed's items: one per agent with live or asking work (needs your OK
      first, then the longest-running), at most ROW_MAX with the rest counted. Nothing under way: the
      agent on the line, idle, with its last finish. */
  function widgetTiles(items, onLine, agents) {
    const busy = new Map();
    for (const it of arr(items)) {
      if (it.state !== 'live' && it.state !== 'ask') continue;
      const had = busy.get(it.agentId);
      if (!had || (it.state === 'ask' && had.state !== 'ask') || (it.state === had.state && it.sortAt < had.sortAt)) busy.set(it.agentId, it);
    }
    const list = Array.from(busy.values()).sort((a, b) => (a.state === b.state ? a.sortAt - b.sortAt : a.state === 'ask' ? -1 : 1));
    if (list.length) {
      return { tiles: list.slice(0, ROW_MAX).map(it => ({ agentId: it.agentId, name: it.name, color: it.color, working: true, state: it.state, startedAt: it.sortAt, step: it.status })), more: Math.max(0, list.length - ROW_MAX) };
    }
    const a = arr(agents).find(x => x && x.id === onLine) || arr(agents)[0];
    if (!a) return { tiles: [], more: 0 };
    const last = arr(items).find(it => it.agentId === a.id);
    return { tiles: [{ agentId: a.id, name: String(a.name || a.id).toUpperCase(), color: a.color || '', working: false, state: 'idle', startedAt: 0,
      step: last ? last.status + (last.time ? ' · ' + last.time : '') : 'Nothing running' }], more: 0 };
  }

  /** 42s → "0:42", 12m 5s → "12:05", 1h 2m 3s → "1:02:03". */
  function fmtClock(ms) {
    if (!isFinite(ms) || ms < 0) return '';
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0') : m + ':' + String(r).padStart(2, '0');
  }

  // The widget's world is drawn ~20 times a second (World.setFrameCap): alive to a glance, a fraction of the
  // full station's cost while a game has the GPU. 48ms stays under the world's 64ms step clamp, so bodies
  // still move at their true speed. The full station gets the world's own RENDER PACING back (30 fps focused, slower unfocused — world.js).
  const WIDGET_FRAME_MS = 48;
  function worldStart(capped) {
    // the widget shows the world only: its rows already say who works, for how long and on what, so the
    // station's in-world readouts (clocks, tickers, bubbles, plates, the work pulse) are off while it shows
    try { if (typeof World !== 'undefined') { if (World.setFrameCap) World.setFrameCap(capped ? WIDGET_FRAME_MS : 0); if (World.setOverlays) World.setOverlays(!capped); if (World.start) World.start(); } } catch (_) {}
  }
  function worldStop() { try { if (typeof World !== 'undefined' && World.stop) World.stop(); } catch (_) {} }

  // Point the station's camera at an agent (its own follow-lock: the same one a CREW click makes).
  const WIDGET_ZOOM = 4.5;   // the agent fills the small picture; the station's own lock is 3
  const WIDGET_SEAT_AT = 0.84;   // an agent at its desk: feet low in the frame, so its desk and screen show above it
  /* The framing: the agent is always shown at the same closeness (4.5, the agent cam Andrew liked); a picture the
     Commander makes bigger shows MORE STATION round the agent, never a bigger agent (Andrew 09-30: "the agent cam
     is WAY TOO BIG" — it used to zoom up to a third closer as the window grew). A seated worker moves from low in
     the small frame (its desk and screen above it) toward the middle of a tall one. */
  function widgetFraming() {
    let h = 0; try { h = $('stage-wrap').clientHeight || 0; } catch (_) {}
    const t = h > WIDGET_VIEW_H ? Math.min(1, (h - WIDGET_VIEW_H) / 210) : 0;
    return { zoom: WIDGET_ZOOM, seatAt: +(WIDGET_SEAT_AT - 0.18 * t).toFixed(2) };
  }
  function cameraOn(id) {
    try { const d = typeof World !== 'undefined' && World.cameraDbg ? World.cameraDbg() : null; return !d || d.lockId === id; } catch (_) { return true; }
  }
  function follow(id) {
    if (!id) return;
    const fr = widgetFraming(), key = id + '|' + fr.zoom + '|' + fr.seatAt;
    if (S.followId === id && S.followKey === key && cameraOn(id)) return;
    S.followId = id; S.followKey = key;
    try {
      if (typeof World === 'undefined' || !World.lockBody) return;
      keepStationCamera();
      World.lockBody(id, fr.zoom, { seatAt: fr.seatAt });
    } catch (_) {}
  }
  /* The widget BORROWS the station's camera. Before its first follow it keeps what the station was showing (a
     free view or a CREW follow, its zoom and where it looked), and leaving the HUD gives exactly that back — the
     station never comes back zoomed in on whoever the widget last watched. */
  function keepStationCamera() {
    if (S.stationCam) return;
    try { S.stationCam = (typeof World !== 'undefined' && World.cameraState) ? World.cameraState() : null; } catch (_) { S.stationCam = null; }
  }
  function unfollow() {
    try { if (S.stationCam && typeof World !== 'undefined' && World.restoreCamera) World.restoreCamera(S.stationCam); } catch (_) {}
    S.stationCam = null;
  }

  /* MOVE THE AGENT CAM (Andrew 09-30: "I cant drag the agent cam mode, its just stuck in the top right"). The picture
     and its rows are what you click, so they are also what you hold: press and move a few pixels and the WINDOW
     moves (the OS drag, the same one the title bar's drag region uses); a press that does not move stays a click —
     open ACTIVITY on the picture, watch that agent on a row. Where it is left is where the HUD comes back. */
  const DRAG_PX = 4;
  function startWindowDrag() {
    try {
      const w = root.__TAURI__ && root.__TAURI__.window;
      const cur = w && (typeof w.getCurrentWindow === 'function' ? w.getCurrentWindow() : (typeof w.getCurrent === 'function' ? w.getCurrent() : null));
      if (cur && typeof cur.startDragging === 'function') return Promise.resolve(cur.startDragging()).catch(() => null);
    } catch (_) {}
    return invoke('plugin:window|start_dragging', { label: 'main' });
  }
  function holdToMove(node) {
    let down = null;
    node.addEventListener('pointerdown', e => {
      down = (S.desktop && e.button === 0 && e.isPrimary !== false) ? { x: e.clientX, y: e.clientY } : null;
    });
    node.addEventListener('pointermove', e => {
      if (!down || !(e.buttons & 1)) { down = null; return; }
      if (Math.abs(e.clientX - down.x) < DRAG_PX && Math.abs(e.clientY - down.y) < DRAG_PX) return;
      down = null;
      S.movedAt = now();   // the click that may follow a drag is not a click
      startWindowDrag();
    });
    const clear = () => { down = null; };
    node.addEventListener('pointerup', clear);
    node.addEventListener('pointercancel', clear);
  }
  const justMoved = () => now() - (S.movedAt || 0) < 500;

  function buildWidget() {
    if (S.widget) return S.widget;
    const g = gameScreen(); if (!g) return null;
    // the view: a click-catcher over the station view (a click on the world would otherwise open a dossier)
    const open = el('button', 'hud-wview'); open.type = 'button';
    open.setAttribute('aria-label', 'Open activity'); open.title = 'Click to open activity · drag to move';
    const box = el('section', 'hud-widget');
    box.id = 'hud-widget';
    box.setAttribute('aria-label', 'StarNet HUD: your agents at work');
    box.setAttribute('data-tauri-drag-region', '');
    const rows = el('div', 'hud-wrows'); rows.setAttribute('data-tauri-drag-region', '');
    const more = el('button', 'hud-wmore'); more.type = 'button'; more.hidden = true;
    box.append(rows, more);
    g.insertBefore(box, g.firstChild);
    g.insertBefore(open, g.firstChild);
    holdToMove(open); holdToMove(rows);
    open.addEventListener('click', () => { if (!justMoved()) setView('activity'); });
    more.addEventListener('click', () => { setView('activity'); });
    rows.addEventListener('click', e => {
      if (justMoved()) return;
      const row = e.target && e.target.closest && e.target.closest('[data-agent]');
      if (!row) return;
      S.followPinned = row.getAttribute('data-agent');   // the Commander chose who to watch
      S.followId = '';
      follow(S.followPinned);
      renderWidget();
    });
    S.widget = { box, rows, more, open, map: new Map() };
    return S.widget;
  }

  function renderWidget() {
    const w = S.widget; if (!w || S.view !== 'widget') return;
    const t = now();
    const agents = roster();
    const plan = widgetTiles(S.lastItems || [], onLineId(), agents);
    // whom the camera watches: the Commander's pick while that agent is still listed, else the top row
    if (S.followPinned && !plan.tiles.some(x => x.agentId === S.followPinned)) S.followPinned = '';
    const watch = S.followPinned || (plan.tiles[0] && plan.tiles[0].agentId) || '';
    follow(watch);
    // the station stopped answering: what the rows last knew may be over, so no clock keeps counting it
    const down = S.feed.snapOk === false;
    const keep = new Set();
    let prev = null;
    for (const tile of plan.tiles) {
      keep.add(tile.agentId);
      let v = w.map.get(tile.agentId);
      if (!v) {
        const node = el('button', 'hud-wrow'); node.type = 'button';
        const dot = el('span', 'dot'), name = el('span', 'hud-wname'), clock = el('span', 'hud-wclock'), step = el('span', 'hud-wstep');
        dot.setAttribute('aria-hidden', 'true');
        node.append(dot, name, clock, step);
        v = { node, dot, name, clock, step };
        w.map.set(tile.agentId, v);
      }
      v.node.setAttribute('data-agent', tile.agentId);
      v.node.dataset.state = down ? 'fault' : tile.state;
      v.node.classList.toggle('on', tile.agentId === watch);
      v.dot.className = 'dot' + (tile.state === 'ask' ? ' alert' : '');
      setText(v.name, tile.name);
      if (tile.color) v.name.style.color = tile.color; else v.name.style.removeProperty('color');
      setText(v.clock, down ? 'NO LINK' : tile.working ? fmtClock(t - tile.startedAt) : 'ALL QUIET');
      setText(v.step, down ? 'The station is not answering' : tile.step);
      v.node.setAttribute('aria-label', tile.name + (tile.working ? ' · ' + tile.step + ' · running ' + fmtClock(t - tile.startedAt) : ' · all quiet · ' + tile.step) + '. Watch');
      v.node.title = 'Watch ' + tile.name;
      const want = prev ? prev.nextSibling : w.rows.firstChild;
      if (want !== v.node) w.rows.insertBefore(v.node, want);
      prev = v.node;
    }
    for (const [id, v] of w.map) if (!keep.has(id)) { v.node.remove(); w.map.delete(id); }
    w.more.hidden = !plan.more;
    if (plan.more) { setText(w.more, '+' + plan.more + ' MORE WORKING'); w.more.setAttribute('aria-label', plan.more + ' more agents working. Open activity'); }
    fitWidget();
  }

  function stopWidgetFrames() {}

  /* The widget's window. It opens at the DEFAULT size (a 300x190 picture + its rows); the picture fills whatever
     the window is, so when the Commander drags the window bigger the station view grows with it — and that
     size is theirs: it is kept (no auto-fit fights it) and remembered for the next time the HUD opens. */
  const WIDGET_VIEW_W = 300, WIDGET_VIEW_H = 190;
  function widgetDefaultSize() {
    try {
      const box = S.widget.box, r = box.getBoundingClientRect();
      const z = box.offsetWidth > 0 ? r.width / box.offsetWidth : 1;   // the text-size body zoom (visual px per css px)
      return { w: Math.ceil((WIDGET_VIEW_W + 8) * z), h: Math.ceil((WIDGET_VIEW_H + 12) * z + r.height) };
    } catch (_) { return null; }
  }
  function widgetSize() { return S.widgetUser || widgetDefaultSize(); }
  function askWidgetSize(z) {
    if (!z) return Promise.resolve(null);
    S.widgetFit = z;
    S.fitQuietUntil = now() + 900;   // the resize this request causes is ours, not the Commander's
    return invoke('starnet_hud_fold', { folded: true, height: z.h, width: z.w });
  }
  // default-sized: follow the rows (an agent starting or finishing adds or removes one); user-sized: hands off
  function fitWidget() {
    if (!S.active || S.view !== 'widget' || !S.desktop || S.widgetUser) return;
    const z = widgetDefaultSize(); if (!z) return;
    if (S.widgetFit && Math.abs(z.w - S.widgetFit.w) < 3 && Math.abs(z.h - S.widgetFit.h) < 3) return;
    askWidgetSize(z);
  }
  // a resize we did not ask for, while the widget shows, is the Commander sizing it: keep and remember that size.
  // Only a REAL window resize counts: the synthetic 'resize' the HUD dispatches after every view change (so the
  // layout reflows) is untrusted, and the moments around a view change or an entry are quiet.
  function onWindowResize(e) {
    if (e && e.isTrusted === false) return;
    if (!S.active || S.view !== 'widget' || !S.desktop || S.busy || now() < (S.fitQuietUntil || 0)) return;
    const w = Math.round(root.innerWidth), h = Math.round(root.innerHeight);
    if (!(w > 0 && h > 0)) return;
    if (S.widgetFit && Math.abs(w - S.widgetFit.w) < 4 && Math.abs(h - S.widgetFit.h) < 4) return;
    S.widgetUser = { w, h }; S.widgetFit = S.widgetUser;
    const prefs = readPrefs(root.localStorage); prefs.widget = S.widgetUser; writePrefs(root.localStorage, prefs);
    renderWidget();   // the picture changed size: re-frame the agent for it
  }

  function buildUi() {
    if (S.els) return S.els;
    const panel = $('chat-panel'), log = $('chat-log'), h3 = panel && panel.querySelector(':scope > h3');
    if (!panel || !log || !h3) return null;
    // ACTIVITY: the project activity view, for the whole station
    const section = el('section', 'project-home hud-activity');
    section.id = 'hud-activity';
    section.setAttribute('aria-label', 'All work on the station');
    const notice = el('p', 'ph-notice'); notice.setAttribute('role', 'status');
    const empty = el('p', 'ph-empty', 'No work yet. Ask an agent something and it shows up here.');
    const list = el('div', 'ph-activity');
    section.append(notice, empty, list);
    panel.insertBefore(section, log);
    // the HUD's hands live in the COMMS header, where the project feed keeps its CREW / ACTIVITY switch
    const ctl = el('span', 'ph-actions hud-ctl');
    const view = el('button', 'btn'); view.type = 'button'; view.id = 'hud-view';
    const small = el('button', 'btn', 'AGENT CAM'); small.type = 'button'; small.id = 'hud-small';
    small.title = 'Shrink the HUD to the agent cam';
    const pin = el('button', 'btn', 'PIN'); pin.type = 'button'; pin.id = 'hud-pin'; pin.hidden = true;
    const exitBtn = el('button', 'btn', 'STATION'); exitBtn.type = 'button'; exitBtn.id = 'hud-exit';
    exitBtn.title = 'Back to the full station';
    ctl.append(view, small, pin, exitBtn);
    const right = h3.querySelector('.h3-right') || h3;
    right.appendChild(ctl);
    view.addEventListener('click', () => setView(S.view === 'activity' ? 'chat' : 'activity'));
    small.addEventListener('click', () => setView('widget'));
    pin.addEventListener('click', () => setPinned(!S.pinned));
    exitBtn.addEventListener('click', () => exit());
    S.els = { panel, h3, section, notice, empty, list, ctl, view, pin, exit: exitBtn, title: $('comms-title') };
    return S.els;
  }

  function syncButtons() {
    if (!S.els) return;
    const act = S.view === 'activity';
    const items = S.lastItems || [];
    const busy = items.filter(x => x.state === 'live' || x.state === 'ask').length;
    setText(S.els.view, act ? 'CHAT' : ('ACTIVITY' + (busy ? ' · ' + busy : '')));
    S.els.view.title = act ? 'Open the conversation' : 'See all the work on the station';
    S.els.view.setAttribute('aria-pressed', 'false');
    S.els.pin.hidden = !S.desktop;
    setText(S.els.pin, S.pinned ? 'PINNED' : 'PIN');
    S.els.pin.setAttribute('aria-pressed', String(S.pinned));
    S.els.pin.title = S.pinned ? 'Pinned above other windows' : 'Keep the HUD above other windows';
  }

  function render() {
    if (!S.els || !S.active) return;
    const t = now();
    const items = workItems({ feed: S.feed, workers: S.workers, finished: S.finished, agents: roster(), streams: streams(), now: t });
    S.lastItems = items;
    const sum = feedSummary(items, S.feed, S.histOk);
    doc.body.classList.toggle('hud-asking', sum.tone === 'ask');
    if (S.view === 'activity' && S.els.title) setText(S.els.title, '▮ ACTIVITY');
    setText(S.els.notice, sum.text === 'NO LINK' ? 'The station is not answering. What is shown may be out of date.' : '');
    S.els.empty.hidden = items.length > 0 || S.feed.snapOk == null;
    const have = new Map(S.cards);
    let prev = null;
    for (const it of items) {
      let card = S.cards.get(it.key);
      if (!card) { card = createCard(it.key); S.cards.set(it.key, card); }
      have.delete(it.key);
      patchCard(card, it);
      const want = prev ? prev.nextSibling : S.els.list.firstChild;
      if (want !== card.node) S.els.list.insertBefore(card.node, want);
      prev = card.node;
    }
    for (const [key, card] of have) { card.node.remove(); S.cards.delete(key); }
    syncButtons();
    if (S.view === 'widget') renderWidget(); else refit();
  }

  /* ---------------- polling ---------------- */

  function poll() {
    if (!S.active || S.fetching || typeof fetch !== 'function') return;
    S.fetching = true;
    fetch('/api/state/snapshot', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(snap => { if (!applySnapshot(S.feed, snap, now())) snapshotFailed(S.feed); })
      .catch(() => snapshotFailed(S.feed))
      .then(() => { S.fetching = false; render(); });
  }

  function pollHistory() {
    if (!S.active || S.fetchingHist || typeof fetch !== 'function') return;
    S.fetchingHist = true;
    const get = url => fetch(url, { cache: 'no-store' }).then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))));
    Promise.all([get('/api/subagents'), get('/api/runs?agent=*&limit=40')])
      .then(([w, h]) => { S.workers = arr(w && w.records); S.finished = arr(h && h.runs); S.histOk = true; })
      .catch(() => { S.histOk = false; })
      .then(() => { S.fetchingHist = false; render(); });
  }

  // a run just ended: its history row lands a moment later, so look again soon rather than in 12s
  function historySoon() {
    if (!S.active) return;
    root.clearTimeout(S.histSoon);
    S.histSoon = root.setTimeout(pollHistory, 900);
  }

  function bindBus() {
    if (S.bound || typeof U === 'undefined' || !U.bus) return;
    S.bound = true;
    // Always listening (cheap), so a run already under way when the HUD opens still shows its step.
    U.bus.on('agent.run.start', p => { onRunStart(S.feed, p, now()); if (S.active) render(); });
    U.bus.on('agent.tool_call', p => { onToolCall(S.feed, p, now()); if (S.active) render(); });
    U.bus.on('agent.tool_result', p => { if (onToolResult(S.feed, p, now()) && S.active) render(); });
    U.bus.on('agent.token', p => { if (onToken(S.feed, p, now()) && S.active) render(); });
    U.bus.on('agent.run.end', p => { onRunEnd(S.feed, p, now()); if (S.active) { render(); historySoon(); } });
    U.bus.on('agent.run.error', p => { onRunError(S.feed, p, now()); if (S.active) { render(); historySoon(); } });
  }

  /* ---------------- desktop window ---------------- */

  function invoke(cmd, args) {
    const core = tauriCore(root);
    if (!core) return Promise.resolve(null);
    return Promise.resolve(core.invoke(cmd, args || {})).catch(err => {
      try { root.console && root.console.warn && root.console.warn('[hud] ' + cmd + ' failed', err); } catch (_) {}
      return null;
    });
  }

  function announceLayout() { try { root.dispatchEvent(new root.Event('resize')); } catch (_) {} }

  // ACTIVITY hugs its cards: the window height the feed needs, in viewport px (= the window's logical px).
  function activityHeight() {
    try {
      const s = S.els.section, list = S.els.list;
      const lastBottom = Math.max(list.getBoundingClientRect().bottom, S.els.empty.hidden ? 0 : S.els.empty.getBoundingClientRect().bottom);
      // + the feed's bottom padding, the panel's border and the frame's padding, with room so no scrollbar appears for a fit
      return Math.ceil(lastBottom + s.scrollTop + 30);
    } catch (_) { return 0; }
  }

  // The window follows the feed while it is on screen: a card arriving or opening grows it, one leaving
  // shrinks it back. Only asks the shell when the needed height actually moved.
  function refit() {
    if (!S.active || S.view !== 'activity' || !S.desktop) return;
    const h = activityHeight();
    if (!h || Math.abs(h - (S.foldedH || 0)) < 3) return;
    S.foldedH = h;
    invoke('starnet_hud_fold', { folded: true, height: h });
  }

  function applyView() {
    const act = S.view === 'activity', small = S.view === 'widget';
    doc.body.classList.toggle('hud-view-activity', act);
    doc.body.classList.toggle('hud-view-widget', small);
    doc.body.classList.toggle('hud-folded', act || small);
    // the world renders only while the widget shows it: ACTIVITY and CHAT cost no GPU
    if (small) worldStart(true); else { worldStop(); S.followId = ''; }
    if (S.els && S.els.title) {
      if (act) { if (S.titleWas == null) S.titleWas = S.els.title.textContent; }
      else if (S.titleWas != null) { S.els.title.textContent = S.titleWas; S.titleWas = null; }
    }
  }

  function setView(next) {
    if (!S.active) return Promise.resolve(false);
    S.view = next === 'chat' ? 'chat' : next === 'widget' ? 'widget' : 'activity';
    if (S.view === 'widget') S.widgetFit = null;
    S.fitQuietUntil = now() + 900;   // the window is about to change size for this view: that is ours
    applyView();
    render();
    announceLayout();
    if (S.view === 'chat') {
      try { const input = $('chat-input'); if (input) input.focus(); } catch (_) {}
      S.foldedH = 0;
      return invoke('starnet_hud_fold', { folded: false, height: null }).then(() => true);
    }
    if (S.view === 'widget') return askWidgetSize(widgetSize()).then(() => true);
    S.foldedH = activityHeight();
    return invoke('starnet_hud_fold', { folded: true, height: S.foldedH, width: null }).then(() => true);
  }

  function enter() {
    if (S.active || S.busy || !doc || !inGame()) return Promise.resolve(false);
    if (!buildUi() || !buildWidget()) return Promise.resolve(false);
    S.busy = true;
    const prefs = readPrefs(root.localStorage);
    S.pinned = prefs.pinned;
    S.widgetUser = prefs.widget || null;   // the size the Commander last gave the widget, if they ever did
    S.fitQuietUntil = now() + 3000;        // entering reshapes the window several times: none of that is the Commander
    S.view = 'widget';                       // the HUD opens SMALL: the agents at work, a click from everything else
    S.desktop = !!tauriCore(root);
    S.active = true;
    bindBus();
    doc.body.classList.add('hud-mode');
    applyView();
    // the COMMS header is the HUD's drag handle
    S.els.h3.setAttribute('data-tauri-drag-region', '');
    if (S.els.title) S.els.title.setAttribute('data-tauri-drag-region', '');
    render();
    poll(); pollHistory();
    S.pollT = root.setInterval(poll, POLL_MS);
    S.histT = root.setInterval(pollHistory, HISTORY_MS);
    S.tickT = root.setInterval(render, 1000);   // clocks + "ago" words only; no data invented between polls
    announceLayout();
    return invoke('starnet_hud_set', { active: true, pinned: S.pinned, rect: prefs.rect })
      // a remembered rect the shell cannot take must never strand the HUD layout in a full-size window
      .then(v => v || (prefs.rect && S.desktop ? invoke('starnet_hud_set', { active: true, pinned: S.pinned }) : v))
      .then(v => { if (v) { S.pinned = !!v.pinned; syncButtons(); } return true; })
      // the shell opened the HUD at its full rect: now hug the widget
      .then(ok => askWidgetSize(widgetSize()).then(() => ok))
      .finally(() => { S.busy = false; if (S.exitAfter) { S.exitAfter = false; exit(); } });
  }

  function exit() {
    if (S.busy) { S.exitAfter = true; return Promise.resolve(false); }   // entering: leave right after
    if (!S.active) {
      // the page is not in HUD mode, but the shell may still hold the small pinned window (a reload that never
      // reached the station): hand the window back so it is never stranded tiny and on top
      if (!tauriCore(root)) return Promise.resolve(false);
      return invoke('starnet_hud_status').then(v => (v && v.active ? invoke('starnet_hud_set', { active: false }) : null)).then(() => false);
    }
    S.busy = true;
    return invoke('starnet_hud_set', { active: false })
      .then(v => {
        if (v && v.rect) { const prefs = readPrefs(root.localStorage); prefs.rect = v.rect; writePrefs(root.localStorage, prefs); }
      })
      .finally(() => {
        S.active = false;
        root.clearInterval(S.pollT); root.clearInterval(S.histT); root.clearInterval(S.tickT); root.clearTimeout(S.histSoon);
        S.pollT = S.histT = S.tickT = S.histSoon = 0;
        S.view = 'chat'; applyView();
        stopWidgetFrames();
        doc.body.classList.remove('hud-mode', 'hud-folded', 'hud-view-activity', 'hud-view-widget', 'hud-asking');
        if (S.els) {
          S.els.h3.removeAttribute('data-tauri-drag-region');
          if (S.els.title) S.els.title.removeAttribute('data-tauri-drag-region');
        }
        unfollow();
        S.followId = S.followPinned = '';
        if (inGame()) worldStart(false);   // the full station always gets its world back, uncapped
        announceLayout();
        S.busy = false;
      });
  }

  function setPinned(pinned) {
    if (!S.active) return Promise.resolve(false);
    return invoke('starnet_hud_pin', { pinned: !!pinned }).then(v => {
      if (v) S.pinned = !!v.pinned;   // the shell's read-back, never the request
      const prefs = readPrefs(root.localStorage); prefs.pinned = S.pinned; writePrefs(root.localStorage, prefs);
      syncButtons();
      return S.pinned;
    });
  }

  function toggle() { return S.active ? exit() : enter(); }

  function wire() {
    if (!doc) return;
    bindBus();
    const btn = $('comms-hud');
    if (btn) {
      // The HUD's point is a panel that stays above a game: only the desktop shell can do that, so a
      // browser tab gets no header button (Ctrl+Shift+H still folds the page for anyone who wants it).
      btn.hidden = !tauriCore(root);
      btn.addEventListener('click', () => { enter(); });
    }
    root.addEventListener('resize', onWindowResize);
    // Ctrl+Shift+H toggles the HUD from anywhere in the app (Alt+H stays the help overlay's).
    doc.addEventListener('keydown', e => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.code === 'KeyH' || e.key === 'H' || e.key === 'h')) {
        e.preventDefault();
        toggle();
      }
    });
    // The tray's HUD Mode / Open StarNet items (hud_mode.rs) ask the page to switch.
    try {
      const ev = root.__TAURI__ && root.__TAURI__.event;
      if (ev && typeof ev.listen === 'function') {
        ev.listen(TAURI_EVENT, e => { const on = !!(e && e.payload && e.payload.active); if (on) enter(); else exit(); });
      }
    } catch (_) {}
    // A reload (or a WebView2 crash rebuild) inside HUD mode: the shell still holds the HUD window,
    // so the page puts its HUD layout back instead of drawing the full station into a tiny frame.
    invoke('starnet_hud_status').then(v => {
      if (!v || !v.active) return;
      // the station may take a while to boot; if it never gets there, give the window back rather than strand it
      const tryEnter = (n) => { if (inGame()) enter(); else if (n > 0) root.setTimeout(() => tryEnter(n - 1), 500); else exit(); };
      tryEnter(240);
    });
  }

  if (doc) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', wire, { once: true });
    else wire();
  }

  return {
    enter, exit, toggle, setView, setPinned,
    active: () => S.active, currentView: () => S.view, pinned: () => S.pinned,
    // pure model — exported for tests
    createFeed, onRunStart, onToolCall, onToolResult, onToken, onRunEnd, onRunError, applySnapshot, snapshotFailed,
    view: view, workItems, feedSummary, taskOfRun, replyOfRun, widgetTiles, fmtClock, oneLine, toolLabel, fmtElapsed, fmtAgo, readPrefs, writePrefs,
    _feed: () => S.feed, _render: render, _poll: poll, _pollHistory: pollHistory
  };
});
