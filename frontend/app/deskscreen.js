/* AGENT OS — deskscreen.js : the DESK SCREEN (2026-09-29, Andrew: "click the computer, see the work from your agent").

   Click an agent's workstation on the live floor (world.js deskAt → onDesk) and the DESK SCREEN window opens on
   THAT agent's computer: the app its current step is working in, rendered from the run transcript — the file it is
   writing (editor), the diff of an edit, the command and what it printed (terminal), the search results or page it
   is reading (web / browser), its reply as it writes it. ‹ › flips back through this job's earlier screens. At rest
   the screen holds the last job's last screen. Hands: a mid-run note (POST /api/run/steer), two-step STOP
   (POST /api/cancel), OPEN CHAT. The activity feed is COMMS — this window never repeats it.
   Connected, when those windows exist: a web page it wrote opens in the BROWSER window (OPEN PAGE), and when it asks
   for a human in its browser (STEP-IN: login / 2FA / CAPTCHA) the screen says so with a STEP IN door.

   TRUTH (the product's core law): every row is either a real bus event this page observed (agent.run.start /
   tool_call / tool_result / token / cost / run.end / permission.* / deliverable) or a server row. Liveness is
   cross-checked against GET /api/state/snapshot while the window is open. Where this page cannot know something it
   says so instead of guessing: a run joined mid-way says its earlier steps are not on this screen; a routine or
   channel run's tool arguments are not carried by the station's event bridge, so only the tool name shows.

   The fold (every agent, from boot) is always on and bounded. The view is a registered station WINDOW ('desk'): it
   rises from the bottom dock between CREW and COMMS, resizes and minimizes like every other window, and switches
   agents by clicking another agent's desk (no roster selector — Andrew 2026-09-30). Never a popover beside the desk. */
'use strict';

const DeskScreen = (() => {
  const STEP_CAP = 80, TEXT_TAIL = 900, RUNS_PER_AGENT = 4, STALE_MS = 10 * 60 * 1000;
  const runs = new Map();       // runId -> rec
  const byAgent = new Map();    // agentId -> [runId…] newest last (bounded)
  const asks = new Map();       // agentId -> { promptId, tool, at }
  const handoffs = new Map();   // agentId -> the live STEP-IN handoff record (browser.handoff: waiting | taken)
  const clock = () => Date.now();

  /* ---------------- the fold (pure over its maps; exported for tests) ---------------- */
  function remember(aid, rid) {
    const l = byAgent.get(aid) || [];
    if (l.indexOf(rid) < 0) l.push(rid);
    while (l.length > RUNS_PER_AGENT) runs.delete(l.shift());
    byAgent.set(aid, l);
  }
  function mk(p, partial, now) {
    const rec = { runId: p.runId, agentId: p.agentId, trigger: p.trigger || '', model: p.model || '', startedAt: now, lastAt: now,
      partial: !!partial, steps: [], dropped: 0, text: '', usd: 0, ended: false, reason: '', endedAt: 0, error: '', made: [], task: '', wsId: '', streamId: String(p.streamId || '') };
    runs.set(p.runId, rec); remember(p.agentId, p.runId);
    return rec;
  }
  function liveRecOf(aid) {
    const l = byAgent.get(aid) || [];
    for (let i = l.length - 1; i >= 0; i--) { const r = runs.get(l[i]); if (r && !r.ended) return r; }
    return null;
  }
  function fold(name, p, now) {
    if (!p || typeof p !== 'object') return;
    now = now || clock();
    // a delegated worker's ask is on the WORKER's desk (workerAgentId), never the lead's
    if (name === 'permission.prompt') { const who = p.workerAgentId || p.agentId; if (who && p.promptId) asks.set(who, { promptId: p.promptId, tool: p.tool || '', at: now }); return; }
    if (name === 'permission.response') { for (const [aid, a] of asks) if (a.promptId === p.promptId) asks.delete(aid); return; }
    if (name === 'browser.handoff') {
      if (!p.id || !p.agentId) return;
      if (p.state === 'waiting' || p.state === 'taken') handoffs.set(p.agentId, { id: String(p.id), state: p.state, reason: p.reason || '', note: p.note || '', where: p.where || p.host || '' });
      else { const h = handoffs.get(p.agentId); if (h && h.id === String(p.id)) handoffs.delete(p.agentId); }
      return;
    }
    if (name === 'deliverable') {
      const r = p.agentId && liveRecOf(p.agentId);
      if (r && r.made.length < 20) r.made.push({ title: String(p.title || p.kind || 'deliverable') });
      return;
    }
    if (!p.agentId || !p.runId) return;
    let rec = runs.get(p.runId);
    if (name === 'agent.run.start') {
      if (!rec) rec = mk(p, false, now);
      else { rec.partial = false; rec.trigger = p.trigger || rec.trigger; rec.model = p.model || rec.model; if (p.streamId) rec.streamId = String(p.streamId); }
      rec.lastAt = now; return;
    }
    // a tool step proves real work even when this page never saw the start (reload mid-run, or the SSE bridge
    // joined late) — open a PARTIAL record the card labels honestly. Tokens alone never open one: the harness's
    // internal self-talk streams tokens with its start/end suppressed, and must never read as an agent's job.
    if (!rec && name === 'agent.tool_call') rec = mk(p, true, now);
    if (!rec) return;
    rec.lastAt = now;
    if (name === 'agent.tool_call') {
      if (rec.ended) return;
      rec.steps.push({ callId: p.callId || '', name: String(p.name || 'tool'), args: String(p.argsSummary || ''), at: now, done: false, ok: null, ms: null, summary: '' });
      if (rec.steps.length > STEP_CAP) { rec.steps.shift(); rec.dropped++; }
      rec.text = '';   // prose before a tool call was narration; the tail shows what it is writing NOW
    } else if (name === 'agent.tool_result') {
      let s = null;
      for (let i = rec.steps.length - 1; i >= 0; i--) { const x = rec.steps[i]; if (!x.done && (!p.callId || !x.callId || x.callId === p.callId)) { s = x; break; } }
      if (!s) return;
      // a call the Task Brief gate held never ran: no outcome (null), never a failed step
      s.done = true; s.ok = (typeof TaskIntent !== 'undefined' && TaskIntent.isGateHeld && TaskIntent.isGateHeld(p)) ? null : (!p.isError && p.ok !== false);
      if (typeof p.ms === 'number' && isFinite(p.ms)) s.ms = p.ms;
      if (p.summary) s.summary = String(p.summary);
    } else if (name === 'agent.token') {
      if (rec.ended || typeof p.delta !== 'string') return;
      rec.text = (rec.text + p.delta).slice(-TEXT_TAIL);
    } else if (name === 'agent.cost') {
      if (typeof p.usd === 'number' && isFinite(p.usd) && p.usd > 0) rec.usd += p.usd;
    } else if (name === 'agent.run.error') {
      rec.error = String(p.message || p.error || 'error');
    } else if (name === 'agent.run.end') {
      rec.ended = true; rec.reason = String(p.reason || 'done'); rec.endedAt = now;
      if (typeof p.usd === 'number' && isFinite(p.usd) && p.usd > rec.usd) rec.usd = p.usd;
      for (const s of rec.steps) if (!s.done) { s.done = true; s.ok = null; }   // never leave a step spinning after the run ended
    }
  }
  // a live record whose run went silent for STALE_MS with no end is not asserted live by the fold alone
  function currentOf(aid, now) {
    now = now || clock();
    const r = liveRecOf(aid);
    return r && now - r.lastAt < STALE_MS ? r : null;
  }
  function lastEndedOf(aid) {
    const l = byAgent.get(aid) || [];
    for (let i = l.length - 1; i >= 0; i--) { const r = runs.get(l[i]); if (r && r.ended) return r; }
    return null;
  }

  /* ---------------- display helpers ---------------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    const money = v => (typeof U !== 'undefined' && U.usd) ? U.usd(v) : '$' + (+v || 0).toFixed(4);
  const toolName = n => String(n || 'tool').replace(/^mcp__/, '').replace(/__/g, '.').replace(/_/g, '.');
  // the SALIENT argument (the file, the query, the url) — the COMMS chip's scan-don't-parse digest: argsSummary is a
  // capped JSON prefix, so only COMPLETE "key": value pairs are read; an unrecognised shape shows clipped raw text.
  const ARG_KEYS = ['path', 'file', 'filename', 'query', 'q', 'url', 'pattern', 'name', 'target', 'title', 'command', 'cmd', 'text', 'id'];
  const ARG_PAIR = /"([A-Za-z0-9_.-]+)"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|(-?\d+(?:\.\d+)?|true|false))/g;
  function argDigest(raw) {
    raw = String(raw == null ? '' : raw).trim();
    if (!raw) return '';
    const pairs = new Map(); let m; ARG_PAIR.lastIndex = 0;
    while ((m = ARG_PAIR.exec(raw))) {
      const v = m[2] !== undefined ? m[2] : m[3];
      const c = String(v == null ? '' : v).replace(/\\[nrt]/g, ' ').replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim();
      if (c && !pairs.has(m[1])) pairs.set(m[1], c);
    }
    for (const k of ARG_KEYS) if (pairs.get(k)) return clip(pairs.get(k), 60);
    if (pairs.size === 1) return clip(pairs.values().next().value, 60);
    return clip(raw, 60);
  }
  const dur = ms => { ms = Math.max(0, ms | 0); const s = Math.floor(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's'; return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'; };
  function ago(ts, now) {
    if (!ts) return '';
    const d = Math.max(0, now - ts);
    if (d < 60000) return 'just now';
    const m = Math.floor(d / 60000); if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }
  const OUTCOME = { done: 'DONE', cancelled: 'STOPPED', error: 'FAILED', budget: 'HIT ITS BUDGET', max_iters: 'HIT ITS STEP LIMIT', refusal: 'REFUSED', empty: 'EMPTY REPLY', clarifying: 'ASKED YOU A QUESTION' };
  const outcomeState = r => r === 'done' ? 'done' : (r === 'error' || r === 'refusal' || r === 'empty') ? 'failed' : 'idle';
  const TRIGGER = { schedule: 'A scheduled routine', event: 'An incoming event', loop: 'A loop iteration', nightshift: 'Autonomy' };   // 'nightshift' stays the internal trigger id; the user-facing name is Autonomy

  // the task this run is working: the Commander's own words when this page launched it (the workstream whose live
  // run IS this run — Channels.runIdOf), else an honest label for what started it. Never a guess.
  function taskOf(rec) {
    if (rec.task) return { text: rec.task, known: true };
    try {
      if (typeof Workstreams !== 'undefined' && typeof Channels !== 'undefined' && Channels.runIdOf) {
        for (const w of Workstreams.all()) {
          if (Channels.runIdOf(w.id) !== rec.runId) continue;
          rec.wsId = w.id;
          const h = Array.isArray(w.history) ? w.history : [];
          for (let i = h.length - 1; i >= 0; i--) if (h[i] && h[i].role === 'user' && h[i].content) {
            // a goal-loop step is the station's prompt, not the Commander's words: the task is the GOAL it works toward
            const step = (typeof GoalLoop !== 'undefined' && GoalLoop.stepOfTurn) ? GoalLoop.stepOfTurn(h[i]) : null;
            rec.task = step != null ? step : String(h[i].content); break;
          }
          if (rec.task) return { text: rec.task, known: true };
        }
      }
    } catch (_) { /* a store mid-reload: fall through to the label */ }
    return { text: (TRIGGER[rec.trigger] || 'Started outside this window') + ' — the task text lands in the record when the run ends', known: false };
  }

  /* ---------------- the agent's screen ----------------
     Every tool step is an app on the agent's computer. The run transcript holds each step's FULL arguments (the
     assistant tool-call turn is checkpointed BEFORE the tool runs) and its full result (checkpointed after), so the
     screen shows the real thing: the file as it is being written, the diff of an edit, the command and what it
     printed, the search results or page text the agent is reading. Nothing is synthesised: a step whose content the
     station has not written yet shows the bus-level name + argument digest and says it is working. */
  const APPS = [
    [/^fs[._](write|append)$/, 'EDITOR'], [/^fs[._](edit|patch)$/, 'EDITOR'], [/^fs[._]read$/, 'EDITOR'],
    [/^fs[._](list|search)$/, 'FILES'], [/^(shell[._]|code[._]run)/, 'TERMINAL'],
    [/^web[._]search$/, 'WEB'], [/^web[._](fetch|request)$/, 'WEB'], [/^browser[._]/, 'BROWSER'],
    [/^(skill|brief|memory)[._]/, 'NOTES']
  ];
  const appOf = name => { const n = String(name || ''); for (const [re, app] of APPS) if (re.test(n)) return app; return 'APP'; };
  const argsObj = a => { if (a && typeof a === 'object') return a; try { const j = JSON.parse(String(a || '')); return j && typeof j === 'object' ? j : {}; } catch (_) { return {}; } };
  const pick = (o, keys) => { for (const k of keys) if (o[k] != null && String(o[k]).trim()) return String(o[k]); return ''; };
  const CAP = 60000;
  const capText = s => { s = String(s == null ? '' : s); return s.length > CAP ? s.slice(0, CAP) + '\n… (' + (s.length - CAP) + ' more characters in the RECORD)' : s; };

  // rows (GET /api/transcript?runId=) → the run's screens in order: [{ callId, name, args, result, isError, done }]
  function parseScreens(rows) {
    const out = [], byId = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r) continue;
      if (r.role === 'assistant' && r.toolCalls) {
        let tc = []; try { tc = JSON.parse(r.toolCalls); } catch (_) { tc = []; }
        for (const c of Array.isArray(tc) ? tc : []) {
          if (!c || !c.id) continue;
          const f = c.function || {};
          const s = { callId: String(c.id), name: String(f.name || c.name || 'tool'), args: argsObj(f.arguments != null ? f.arguments : c.arguments), result: null, isError: false, done: false };
          byId.set(s.callId, s); out.push(s);
        }
      } else if (r.role === 'tool' && r.toolCallId) {
        const s = byId.get(String(r.toolCallId)); if (!s) continue;
        const body = String(r.content == null ? '' : r.content);
        s.done = true;
        // a call the Task Brief held did not run: not a failure, and its text is the gate's note to the model, never a screen
        if (typeof TaskIntent !== 'undefined' && TaskIntent.isGateHeldBody && TaskIntent.isGateHeldBody(body)) { s.held = true; s.isError = false; s.result = ''; continue; }
        s.isError = /^ERROR: /.test(body); s.result = s.isError ? body.slice(7) : body;
      }
    }
    return out;
  }

  // one step → what its screen shows: { app, target, kind: 'code'|'diff'|'term'|'text', body, note }. A held step shows what it
  // was asked to do, with the honest status: it has not run yet (it runs once the task brief settles).
  function screenOf(s) {
    const sc = stepScreen(s);
    if (s && s.held) sc.note = (typeof TaskIntent !== 'undefined' && TaskIntent.GATE_HELD) || 'not run yet';
    return sc;
  }
  function stepScreen(s) {
    const a = s.args || {}, app = appOf(s.name), n = String(s.name || '').replace(/_/g, '.');
    const res = s.result == null ? '' : String(s.result);
    const waiting = !s.done ? 'working…' : '';
    if (/^fs\.(write|append)$/.test(n)) return { app, target: pick(a, ['path', 'file', 'filename']), kind: 'code', body: capText(pick(a, ['content', 'text', 'data'])), note: n === 'fs.append' ? 'appending' + (waiting ? ' · ' + waiting : '') : (waiting ? 'writing…' : (s.isError ? 'not written: ' + clip(res, 160) : clip(res, 160))) };
    if (n === 'fs.edit') return { app, target: pick(a, ['path', 'file']), kind: 'diff', body: capText(String(a.find || '').split('\n').map(l => '- ' + l).join('\n') + '\n' + String(a.replace || '').split('\n').map(l => '+ ' + l).join('\n')), note: waiting || clip(res, 160) };
    if (n === 'fs.patch') return { app, target: 'patch', kind: 'diff', body: capText(pick(a, ['patch'])), note: waiting || clip(res, 160) };
    if (n === 'fs.read') return { app, target: pick(a, ['path', 'file']), kind: 'code', body: capText(res), note: waiting ? 'opening…' : '' };
    if (app === 'TERMINAL') return { app, target: pick(a, ['command', 'cmd', 'code', 'id']) ? clip(pick(a, ['command', 'cmd', 'id']) || 'code', 90) : n, kind: 'term', body: capText((pick(a, ['command', 'cmd']) ? '$ ' + pick(a, ['command', 'cmd']) : pick(a, ['code']) ? pick(a, ['code']) : '$ ' + n) + '\n' + (s.done ? res : '')), note: waiting ? 'running…' : '' };
    if (app === 'WEB') return { app, target: pick(a, ['query', 'q', 'url']), kind: 'text', body: capText(res), note: waiting ? (a.query || a.q ? 'searching…' : 'loading…') : '' };
    if (app === 'BROWSER') return { app, target: pick(a, ['url', 'selector', 'text', 'ref']) || n.replace(/^browser\./, ''), kind: 'text', body: capText(res), note: waiting || n.replace(/^browser\./, '') };
    if (app === 'FILES') return { app, target: pick(a, ['path', 'pattern', 'query']) || '.', kind: 'text', body: capText(res), note: waiting };
    return { app, target: toolName(s.name), kind: 'text', body: capText((Object.keys(a).length ? JSON.stringify(a, null, 2) + '\n\n' : '') + res), note: waiting };
  }

  /* ---------------- the window ----------------
     A registered station window ('desk'): it rises from the bottom dock between CREW and COMMS, resizes and
     minimizes like every other window; another agent's desk re-targets it (no roster selector). The activity feed is
     COMMS; this window is only the agent's screen. Built once per agent, repainted in place each second (the note
     field is never rebuilt under the Commander's cursor). */
  let doors = {};                                              // openChat (app.js)
  let cur = null, timer = 0;                                   // cur = { agentId, name, body }
  let snap = null, snapAt = 0, snapBusy = false;               // /api/state/snapshot: this agent's server-proven live runs
  let hist = null, histFor = '', histAt = 0, histBusy = false; // /api/runs rows for this agent
  let scr = { key: '', list: [], at: 0, busy: false, sig: '' };// the viewed run's screens (from its transcript)
  let pos = -1;                                                // -1 = follow the newest screen; else a pinned index
  let steerNote = '', stopNote = '', stopAt = 0, wasLive = false;

  function getJson(u) { return fetch(u, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null); }
  function postJson(u, body) {
    return fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async r => { let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, ok: r.ok, body: j }; })
      .catch(() => ({ status: 0, ok: false, body: null }));
  }
  // this agent's server-live runs, minus the harness's own self-talk (`internal`: session ideas, a title, a goal plan) —
  // it is not the agent's job, exactly as the run history below leaves it out. null = the snapshot could not be read.
  function liveRowsFor(runs, agentId) {
    return Array.isArray(runs) ? runs.filter(r => r && r.agentId === agentId && !r.internal) : null;
  }
  function pollSnap(force) {
    if (!cur || snapBusy || (!force && clock() - snapAt < 4000)) return;
    snapBusy = true; const want = cur;
    getJson('/api/state/snapshot').then(j => {
      snapBusy = false; if (cur !== want) return;
      snapAt = clock();
      snap = liveRowsFor(j && j.runs, want.agentId);
      paint();
    });
  }
  function pollHist(force) {
    if (!cur || histBusy) return;
    if (!force && histFor === cur.agentId && clock() - histAt < 15000) return;
    histBusy = true; const want = cur;
    getJson('/api/runs?agent=' + encodeURIComponent(want.agentId) + '&limit=6').then(j => {
      histBusy = false; if (cur !== want) return;
      histAt = clock(); histFor = want.agentId;
      hist = j && Array.isArray(j.runs) ? j.runs.filter(r => r && r.agentId === want.agentId && !r.internal && !r.stepTest) : null;
      paint();
    });
  }
  // the viewed run's transcript → its screens. sig = what the bus has told us about the run, so a new step or result
  // refetches at once; a live run is also re-read every 3 s (a checkpoint can land after its bus event).
  function pollScreens(src, sig) {
    if (!cur || !src || !src.runId || !src.stream) return;
    const key = src.runId;
    if (scr.busy) return;
    if (scr.key === key && scr.sig === sig && clock() - scr.at < (src.live ? 3000 : 60000)) return;
    scr.busy = true; const want = cur;
    getJson('/api/transcript?agent=' + encodeURIComponent(want.agentId) + '&stream=' + encodeURIComponent(src.stream) + '&runId=' + encodeURIComponent(key) + '&limit=80').then(j => {
      scr.busy = false; if (cur !== want) return;
      if (scr.key !== key) pos = -1;
      scr = { key, list: j && Array.isArray(j.turns) ? parseScreens(j.turns) : scr.key === key ? scr.list : [], at: clock(), busy: false, sig };
      paint();
    });
  }

  // what the window shows right now, resolved from the fold + the server reads
  function view() {
    const now = clock(), aid = cur.agentId;
    let live = currentOf(aid, now);
    const serverLive = snap ? snap.map(r => r.runId) : null;
    // the snapshot outranks a fold record that never saw its end: not listed + quiet for 10 s = not asserted live
    if (live && serverLive && serverLive.indexOf(live.runId) < 0 && now - live.lastAt > 10000 && snapAt > live.lastAt) live = null;
    const unseen = !live && serverLive && serverLive.length ? snap[0] : null;   // live on the server, no event seen here yet
    const last = hist && hist.length ? hist[0] : null;
    let src = null;
    if (live) { taskOf(live); src = { runId: live.runId, stream: live.streamId || live.wsId || '', live: true }; }
    else if (last && last.runId && last.streamId) src = { runId: last.runId, stream: last.streamId, live: false };
    return { now, aid, name: cur.name, live, unseen, ask: asks.get(aid) || null, last, src };
  }

  // the screens to show: the transcript's, with any bus-seen step the transcript hasn't caught up to appended
  function screensFor(v) {
    const list = (v.src && scr.key === v.src.runId) ? scr.list.slice() : [];
    if (v.live) {
      const have = new Set(list.map(s => s.callId));
      for (const st of v.live.steps) {
        // a done step with no outcome (ok null) is one the Task Brief held: it stays held, never "ok" or "bad"
        if (have.has(st.callId)) { const s = list.find(x => x.callId === st.callId); if (s && !s.done && st.done) { s.done = true; s.isError = st.ok === false; s.held = !!(st.done && st.ok === null); if (s.result == null) s.result = s.held ? '' : (st.summary || ''); } continue; }
        list.push({ callId: st.callId, name: st.name, args: argsObj(st.args), result: st.done ? (st.ok === null ? '' : (st.summary || '')) : null, isError: st.ok === false, held: !!(st.done && st.ok === null), done: st.done, partial: true });
      }
    }
    return list;
  }

  function screenHtml(s, idx, total, v) {
    const sc = screenOf(s);
    const body = sc.kind === 'code'
      ? '<ol class="ds-code">' + (sc.body ? sc.body.split('\n').map(l => '<li>' + (esc(l) || ' ') + '</li>').join('') : '<li class="ds-dim">(empty)</li>') + '</ol>'
      : sc.kind === 'diff'
        ? '<pre class="ds-diff">' + sc.body.split('\n').map(l => '<span class="' + (/^\+/.test(l) ? 'ds-add' : /^-/.test(l) ? 'ds-del' : /^@@/.test(l) ? 'ds-hunk' : '') + '">' + (esc(l) || ' ') + '</span>').join('\n') + '</pre>'
        : '<pre class="ds-' + (sc.kind === 'term' ? 'term' : 'page') + '">' + (esc(sc.body) || '<span class="ds-dim">' + (s.done ? '(nothing came back)' : '…') + '</span>') + '</pre>';
    const partial = s.partial && !(s.args && Object.keys(s.args).length)
      ? '<p class="ds-dim ds-partial">' + (v.src && v.src.stream ? 'Loading this step…' : 'This run was started outside this window, so its full screen is available once it ends. For now the station reports only the tool name.') + '</p>' : '';
    return '<div class="ds-app" data-app="' + sc.app.toLowerCase() + '" data-s="' + (!s.done ? 'run' : s.held ? 'held' : s.isError ? 'bad' : 'ok') + '">'
      + '<div class="ds-bar"><span class="ds-appname">' + esc(sc.app) + '</span><span class="ds-target">' + esc(clip(sc.target, 120)) + '</span>'
      + (canOpenPage(s, sc) ? '<button type="button" class="bb xs ds-openpage" data-a="page" data-path="' + esc(sc.target) + '">OPEN PAGE</button>' : '')
      + '<span class="ds-pager"><button type="button" class="bb xs" data-a="prev"' + (idx <= 0 ? ' disabled' : '') + ' aria-label="Previous screen">‹</button>'
      + '<span class="ds-pos">' + (idx + 1) + '/' + total + '</span>'
      + '<button type="button" class="bb xs" data-a="next"' + (idx >= total - 1 ? ' disabled' : '') + ' aria-label="Next screen">›</button></span></div>'
      + (sc.note ? '<div class="ds-status">' + esc(sc.note) + '</div>' : '')
      + partial + '<div class="ds-view">' + body + '</div></div>';
  }

  // CONNECTED WINDOWS (feature-detected, so this file stands alone): the BROWSER window renders a page the agent
  // wrote; the STEP-IN window is where you take the agent's browser when it asks for a human (login, 2FA, CAPTCHA).
  const HTML_RE = /\.html?$/i;
  function canOpenPage(s, sc) {
    return sc.app === 'EDITOR' && sc.kind === 'code' && s.done && !s.isError && HTML_RE.test(sc.target || '')
      && typeof OutputBrowser !== 'undefined' && typeof OutputBrowser.open === 'function';
  }
  function handoffOf(aid) {
    let h = handoffs.get(aid) || null;
    if (!h && typeof StepIn !== 'undefined' && (typeof StepIn.live === 'function' || StepIn._state)) {   // a handoff raised before this page loaded: STEP-IN's own sidecar read
      try { const r = ((typeof StepIn.live === 'function' ? StepIn.live() : StepIn._state().live) || []).find(x => x && x.agentId === aid && (x.state === 'waiting' || x.state === 'taken')); if (r) h = { id: String(r.id), state: r.state, reason: r.reason || '', note: r.note || '', where: r.where || r.host || '' }; } catch (_) {}
    }
    return h;
  }
  function handoffHtml(h, name) {
    const canOpen = typeof StepIn !== 'undefined' && typeof StepIn.open === 'function';
    return '<div class="ds-ask ds-handoff"><span>' + esc(name) + (h.state === 'taken' ? ' handed you its browser' : ' needs you in its browser')
      + (h.where ? ' · ' + esc(clip(h.where, 60)) : '') + (h.note ? '<small>' + esc(clip(h.note, 200)) + '</small>' : '') + '</span>'
      + (canOpen ? '<button type="button" class="bb sm" data-a="stepin" data-id="' + esc(h.id) + '">' + (h.state === 'taken' ? 'OPEN STEP-IN' : 'STEP IN') + '</button>' : '') + '</div>';
  }

  function paint() {
    const body = cur && cur.body;
    if (!body || !body.isConnected) return;
    const v = view(), strip = body.querySelector('.ds-strip'), main = body.querySelector('.ds-main');
    let state, label, html;
    const list = screensFor(v);
    if (v.src) pollScreens(v.src, v.live ? v.live.steps.length + ':' + v.live.steps.filter(s => s.done).length : 'end');
    const idx = !list.length ? -1 : (pos < 0 || pos >= list.length) ? list.length - 1 : pos;
    if (v.live) {
      state = v.ask ? 'ask' : 'running';
      label = (v.ask ? 'NEEDS YOUR OK' : 'WORKING') + ' · ' + dur(v.now - v.live.startedAt) + (v.live.usd > 0 ? ' · ' + money(v.live.usd) : '');
      const writingNow = v.live.text.trim() && (!list.length || list[list.length - 1].done) && pos < 0;
      if (writingNow) html = '<div class="ds-app" data-app="writing" data-s="run"><div class="ds-bar"><span class="ds-appname">WRITING</span><span class="ds-target">its reply</span></div><pre class="ds-page">' + esc(v.live.text.trim()) + '</pre></div>';
      else if (idx >= 0) html = screenHtml(list[idx], idx, list.length, v);
      else html = '<div class="ds-off"><span>Thinking…</span><small>Nothing is open on its screen yet.</small></div>';
      const ho = handoffOf(v.aid);
      if (ho) { state = 'ask'; label = (ho.state === 'taken' ? 'YOU HAVE ITS BROWSER' : 'NEEDS YOU') + ' · ' + dur(v.now - v.live.startedAt); html = handoffHtml(ho, v.name) + html; }
      if (v.ask) html = '<p class="ds-ask">Waiting for your approval' + (v.ask.tool ? ' to use ' + esc(toolName(v.ask.tool)) : '') + '. Answer it in COMMS.</p>' + html;
      if (v.live.partial) html = '<p class="ds-dim">Joined mid-run: screens from before this page was watching aren\'t shown.</p>' + html;
      if (stopNote && v.now - stopAt > 12000) stopNote = 'The station hasn\'t confirmed the stop yet. It is still running.';
    } else if (v.unseen) {
      state = 'running';
      label = 'WORKING' + (v.unseen.startedAt ? ' · ' + dur(v.now - v.unseen.startedAt) : '');
      html = '<div class="ds-off"><span>Working</span><small>This run started before this page was watching. Its screen appears with its next step.</small></div>';
    } else {
      const ended = lastEndedOf(v.aid);
      if (stopAt && stopNote && stopNote !== 'Stopped.') stopNote = ended && ended.reason === 'cancelled' && ended.endedAt >= stopAt ? 'Stopped.' : '';
      if (v.last) {
        state = outcomeState(v.last.reason);
        label = (v.last.reason === 'done' ? 'IDLE' : (OUTCOME[v.last.reason] || 'IDLE')) + ' · last screen ' + ago(v.last.endedAt || v.last.ts, v.now);
        html = '<p class="ds-job">Last job: ' + esc(clip(v.last.title || 'Untitled run', 160)) + '</p>'
          + (idx >= 0 ? screenHtml(list[idx], idx, list.length, v)
            : '<div class="ds-off"><span>' + (scr.key === (v.src && v.src.runId) ? 'Screen off' : 'Loading…') + '</span><small>' + (scr.key === (v.src && v.src.runId) ? 'That job used no tools. Its reply is in COMMS.' : '') + '</small></div>');
      } else if (hist) {
        state = 'idle'; label = 'IDLE';
        html = '<div class="ds-off"><span>Screen off</span><small>' + esc(v.name) + ' hasn\'t worked at this desk yet. Give it a task and you\'ll see its screen here.</small></div>';
      } else { state = 'idle'; label = 'IDLE'; html = '<div class="ds-off"><span>Loading…</span></div>'; }
    }
    body.querySelector('.ds-screen').setAttribute('data-state', state);
    const stripHtml = '<span class="ds-lamp" aria-hidden="true"></span><span class="ds-st">' + esc(label) + '</span>';
    if (strip.__html !== stripHtml) { strip.innerHTML = stripHtml; strip.__html = stripHtml; }
    if (main.__html !== html) {
      // keep the reader's place inside the screen: follow new output only when they were already at the bottom
      const prev = main.querySelector('.ds-view, .ds-page'), atEnd = !prev || prev.scrollTop + prev.clientHeight >= prev.scrollHeight - 4, top = prev ? prev.scrollTop : 0;
      const sameScreen = main.__screen === (idx + ':' + (v.src && v.src.runId));
      main.innerHTML = html; main.__html = html; main.__screen = idx + ':' + (v.src && v.src.runId);
      const nv = main.querySelector('.ds-view, .ds-page');
      if (nv) nv.scrollTop = sameScreen ? (atEnd && v.live ? nv.scrollHeight : top) : (v.live ? nv.scrollHeight : 0);
    }
    const liveRid = v.live && v.live.runId;
    body.querySelector('.ds-steer').hidden = !liveRid;
    body.querySelector('.ds-in').placeholder = 'Tell ' + v.name + ' something mid-run…';
    body.querySelector('.ds-stop').hidden = !liveRid;
    body.querySelector('[data-a="chat"]').textContent = v.live || v.unseen ? 'OPEN CHAT' : 'GIVE IT A TASK';
    const note = [stopNote, steerNote].filter(Boolean).join(' ');
    const n = body.querySelector('.ds-note'); if (n.textContent !== note) n.textContent = note;
  }

  function tick() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      if (!cur || !cur.body || !cur.body.isConnected) { cur = null; return; }   // the window closed: stop polling
      const live = !!currentOf(cur.agentId);
      if (wasLive && !live) { pollHist(true); steerNote = ''; pos = -1; }   // a run just ended here: fetch its row; its steer receipt is history
      wasLive = live;
      pollSnap(false); if (!live) pollHist(false);
      paint(); tick();
    }, 1000);
  }

  // the window is titled by whose desk it is — "NOVA'S DESK" — on open and every time another desk re-targets it.
  // The term chrome drew the registered title once; the head, the footer label, the close label and the dock chip follow here.
  const deskTitle = name => String(name || 'AGENT').toUpperCase() + '\'S DESK';
  function setTitle(body, title) {
    const term = body && body.closest ? body.closest('.term') : null;
    const t = term && term.querySelector('.term-title'); if (t && t.textContent !== title) t.textContent = title;
    const x = term && term.querySelector('.term-x'); if (x) x.setAttribute('aria-label', 'Close ' + title);
    const foot = term && term.querySelector('.term-foot-k'); if (foot && foot.textContent !== title) foot.textContent = title;   // the window's footer label
    const chip = typeof document !== 'undefined' ? document.querySelector('.term-chip[data-key="desk"]') : null;
    if (chip) { const ct = chip.querySelector('.term-chip-t'); if (ct) ct.textContent = title; chip.setAttribute('aria-label', 'Restore ' + title); }
  }

  // the window builder (StationUI calls it on open, and again when another desk re-targets it)
  function build(body) {
    // the desk's own target (openDesk), never the dossier's selection; a dock-opened desk falls back to it
    const H = StationUI.h, a = (H.deskAgentId && H.present.find(x => x && x.id === H.deskAgentId)) || H.present[H.sel] || null;
    if (!a) { body.innerHTML = '<p class="ds-dim">No agent selected.</p>'; return; }
    const same = cur && cur.agentId === a.id;
    cur = { agentId: a.id, name: a.name || a.id, body };
    setTitle(body, deskTitle(cur.name));
    if (!same) { snap = null; hist = null; histFor = ''; steerNote = stopNote = ''; scr = { key: '', list: [], at: 0, busy: false, sig: '' }; pos = -1; }
    wasLive = !!currentOf(a.id);
    body.innerHTML = '<div class="ds-screen" data-state="idle">'
      + '<div class="ds-strip"></div>'
      + '<div class="ds-main"></div>'
      + '<form class="ds-steer" hidden><input class="ds-in" type="text" maxlength="2000" autocomplete="off" aria-label="Tell this agent something mid-run">'
      + '<button type="submit" class="bb sm">SEND</button></form><p class="ds-note" role="status"></p>'
      + '<div class="ds-foot">'
      + '<button type="button" class="bb sm ds-stop" data-a="stop" hidden>STOP</button>'
      + '<button type="button" class="bb sm" data-a="chat">OPEN CHAT</button></div></div>';
    const aid = a.id;
    body.querySelector('.ds-main').addEventListener('click', e => {
      const b = e.target.closest('button[data-a]'); if (!b) return;
      const act = b.getAttribute('data-a');
      if (act === 'page') { if (typeof OutputBrowser !== 'undefined') OutputBrowser.open({ agentId: aid, path: b.getAttribute('data-path') || '' }); return; }
      if (act === 'stepin') { if (typeof StepIn !== 'undefined') StepIn.open(b.getAttribute('data-id') || ''); return; }
      const v = view(), n = screensFor(v).length; if (!n) return;
      const at = (pos < 0 || pos >= n) ? n - 1 : pos;
      const next = b.getAttribute('data-a') === 'prev' ? Math.max(0, at - 1) : Math.min(n - 1, at + 1);
      pos = next >= n - 1 ? -1 : next;   // stepping onto the newest screen resumes following it
      paint();
    });
    body.querySelector('.ds-foot').addEventListener('click', e => {
      const b = e.target.closest('button[data-a]'); if (!b || b.getAttribute('data-a') !== 'chat') return;
      const v = view(); if (doors.openChat) doors.openChat(aid, v.live && v.live.wsId);
    });
    const stop = body.querySelector('.ds-stop');
    const doStop = () => {
      const v = view(); const rid = v.live && v.live.runId; if (!rid) return;
      stopAt = clock(); stopNote = 'Stop sent. Waiting for the station to confirm…'; paint();
      postJson('/api/cancel', { runId: rid }).then(r => { if (!r.ok) { stopNote = 'The station refused the stop (http ' + r.status + ').'; paint(); } });
    };
    if (typeof ArmConfirm !== 'undefined' && ArmConfirm.wire) ArmConfirm.wire(stop, { armedLabel: 'CONFIRM STOP', onConfirm: doStop });
    else stop.addEventListener('click', doStop);
    body.querySelector('.ds-steer').addEventListener('submit', e => {
      e.preventDefault();
      const inp = body.querySelector('.ds-in'), text = inp.value.trim(), v = view(), rid = v.live && v.live.runId;
      if (!text || !rid) return;
      steerNote = 'Sending…'; paint();
      postJson('/api/run/steer', { runId: rid, text }).then(r => {
        if (r.ok) { steerNote = 'Sent. ' + v.name + ' reads it before its next step.'; if (inp.value.trim() === text) inp.value = ''; }
        else if (r.status === 404 || r.status === 409) steerNote = 'That run already finished. Use OPEN CHAT to give it a new task.';
        else if (r.status === 429) steerNote = 'It already has notes waiting. Give it a moment.';
        else steerNote = 'Not sent (http ' + r.status + ').';
        paint();
      });
    });
    paint(); pollSnap(true); pollHist(true); tick();
  }

  // open THIS agent's desk window (the StationUI core selects the agent, then opens or re-targets the window)
  function open(agentId) {
    if (!agentId || typeof StationUI === 'undefined' || !StationUI.openDesk) return false;
    return StationUI.openDesk(agentId);
  }

  // the fold listens from boot, so a desk opened mid-run already holds every step this page has seen
  let wired = false;
  function init(o) {
    if (o) doors = o;
    if (typeof StationUI !== 'undefined' && StationUI.registerWindow) StationUI.registerWindow('desk', 'DESK', build, { className: 'desk-win' });   // retitled "<NAME>'S DESK" by build()
    if (wired || typeof U === 'undefined' || !U.bus) return;
    wired = true;
    for (const n of ['agent.run.start', 'agent.tool_call', 'agent.tool_result', 'agent.token', 'agent.cost', 'agent.run.error', 'agent.run.end', 'permission.prompt', 'permission.response', 'deliverable', 'browser.handoff']) {
      U.bus.on(n, p => { try { fold(n, p); } catch (_) { /* a malformed event never breaks the bus */ } });
    }
  }

  const isOpen = () => !!(cur && cur.body && cur.body.isConnected);
  const text = () => (isOpen() ? cur.body.innerText : null);
  const agentOfOpen = () => (isOpen() ? cur.agentId : null);
  return { init, open, isOpen, text, agentOfOpen, parseScreens, _deskTitle: deskTitle,
    _fold: fold, _currentOf: currentOf, _lastEndedOf: lastEndedOf, _argDigest: argDigest, _taskOf: taskOf, _liveRowsFor: liveRowsFor,
    _parseScreens: parseScreens, _screenOf: screenOf,
    _handoffOf: aid => handoffs.get(aid) || null,
    _reset: () => { runs.clear(); byAgent.clear(); asks.clear(); handoffs.clear(); } };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = DeskScreen;
