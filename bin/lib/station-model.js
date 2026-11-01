/* bin/lib/station-model.js — the PURE model behind the `starnet` dashboard, `ls` and `watch`.

   It folds what the station PROVES into what the terminal may say: the roster (GET /api/runtime/agent), the live
   feed (GET /api/observe — every run's events and approvals), the reconnect snapshot (GET /api/state/snapshot —
   which runs and asks are live right now), spend (GET /api/budget/status) and the workflow jobs (GET /api/line-jobs).
   No I/O, no clock: every input carries its own `now`, so test/cli-dashboard.test.js drives it with fakes.

   TRUTHFUL-TELEMETRY LAW, applied: an agent is "working" only while a run of its own is live (an event or the
   snapshot says so), "needs you" only while an ask of its own waits, and "done" only after the station's own
   agent.run.end{done}. A run that vanished from the snapshot without an end event is said as "ended (not seen)",
   never as done. Text in a conversation is the real streamed tokens; nothing here writes a reply. */
'use strict';

const { fileArg } = require('./mouse.js');

const SLOTS = 14;            // activity history width
const SLOT_MS = 2000;        // one activity bar = 2 s of the agent's events
const RUN_FLOOR = 0.6;       // a slot with a run open but nothing done in it (above it, the agent did something)
const RECENT_MS = 8000;      // how long "done" / "stopped" stays on a row before it settles to idle
// what an answered ask granted, in the app card's own words (the station echoes what it APPLIED: a fresh-consent ask's
// "always" comes back as once)
const GRANT_WORDS = { once: 'allowed once', always: 'always allowed', full: 'full access', session: 'allowed for this session' };
// the asks the app answers fresh every time — once or deny, no standing answer (chat.js: login windows, the station's
// leash, a plugin install)
const ONCE_ONLY_TOOLS = ['browser.login', 'browser.login.done', 'station.power', 'plugin.submit'];
const LOG_MAX = 300;         // per-agent conversation lines kept in memory
const ORPHAN_GRACE_MS = 4000;   // a run the snapshot no longer lists is only called ended after this long

// the run's origin, in the words a person reading the row would use
function sourceOf(run) {
  const r = run || {};
  if (r.cli) return 'terminal';
  if (/^cli-/.test(String(r.streamId || ''))) return 'terminal';
  if (r.lineId || r.dockId) return 'flow';
  const t = String(r.trigger || ''), s = String(r.surface || r.source || '');
  if (t === 'schedule' || t === 'loop') return 'routine';
  if (t === 'nightshift' || s === 'nightshift') return 'autonomy';
  if (s === 'interactive' || t === 'directive') return 'desktop';
  if (t === 'event') return 'trigger';
  return s || t || 'station';
}

// a tool's name as the station says it (fs.write), whether it arrived in wire form (fs_write) or not
function toolName(n) { const s = String(n || 'tool'); return /^[a-z]+_[a-z0-9_]+$/.test(s) ? s.replace('_', '.') : s; }
// one line of a tool's arguments: pretty-printed JSON and newlines collapsed, then clipped
function oneLine(s, n) { const t = String(s == null ? '' : s).replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim(); return n && t.length > n ? t.slice(0, n - 1) + '…' : t; }
/* A tool line says the SALIENT argument (the file, the query, the url, the command), not the raw JSON: the station sends a
   call's arguments as JSON cut at 240 characters, so `fs.write {"path":"notes.md","content":"# No…` buried the one word
   that matters. Same digest as the desktop COMMS chip (frontend/app/chat.js argDigest): SCAN for complete "key": value
   pairs (a value the cut halved has no closing quote and is never shown as whole), take the first salient key, else the
   only pair, else the raw line. A hand-off names its workers. Display only: it never invents a value. */
const ARG_KEYS = ['path', 'file', 'filename', 'query', 'q', 'url', 'pattern', 'name', 'target', 'title', 'command', 'cmd', 'text', 'id'];
const ARG_PAIR = /"([A-Za-z0-9_.-]+)"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|(-?\d+(?:\.\d+)?|true|false))/g;
function argDigest(args, tool, nameOf) {
  const raw = String(args == null ? '' : args).trim();
  if (!raw || raw === '{}') return '';   // a call with no arguments says nothing after its name
  if (/^team[._]dispatch$/.test(String(tool || ''))) {
    const ids = [...new Set([...raw.matchAll(/"agentId"\s*:\s*"([^"]+)"/g)].map(m => m[1]))];
    let whole = true;
    try { JSON.parse(raw); } catch (_) { whole = false; }
    if (ids.length) return ids.map(id => (nameOf && nameOf(id)) || id).join(', ') + (whole ? '' : ' …') + (/"background"\s*:\s*true/.test(raw) ? ' · background' : '');
  }
  const pairs = new Map();
  ARG_PAIR.lastIndex = 0;
  let m;
  while ((m = ARG_PAIR.exec(raw))) {
    const v = m[2] !== undefined ? m[2] : m[3];
    const clean = String(v).replace(/\\[nrt]/g, ' ').replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim();
    if (clean && !pairs.has(m[1])) pairs.set(m[1], clean);
  }
  for (const k of ARG_KEYS) if (pairs.get(k)) return pairs.get(k);
  if (pairs.size === 1) return pairs.values().next().value;
  return oneLine(raw);
}
/* An ASK carries the WHOLE request (consentSummary: a file change is its pretty-printed JSON, a command every character),
   and each surface words its own glance — the desktop card says "change notes.md". askGlance is the terminal's glance:
   what the request acts on (the file and how many lines go in, the command, who gets the work), never the raw JSON.
   askInspect is what [v] shows: a file change read as a file (its path, then the text exactly as it will be written), any
   other request as "key: value" lines. Both are display only; the request itself is untouched. */
function parseArgs(raw) { try { const o = JSON.parse(String(raw || '')); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (_) { return null; } }
function askGlance(tool, raw, nameOf) {
  const t = String(tool || ''), s = String(raw == null ? '' : raw);
  const o = parseArgs(s);
  if (/^fs[._](?:write|append|edit|patch)$/.test(t) && o && typeof o.path === 'string') {
    const text = typeof o.content === 'string' ? o.content : '';
    const n = text ? text.replace(/\n$/, '').split('\n').length : 0;
    return o.path + (n && /write|append/.test(t) ? ' (' + n + ' line' + (n === 1 ? '' : 's') + ')' : '');
  }
  if (/^(?:shell|terminal)[._]/.test(t) && o) { const c = [o.cmd, o.command, o.input, o.data].find(v => typeof v === 'string' && v); if (c) return oneLine(c, 300); }
  if (/^web[._]?request$/.test(t) && o && typeof o.url === 'string') return (typeof o.method === 'string' && o.method ? o.method.toUpperCase() + ' ' : '') + oneLine(o.url, 280);
  if (/^routine[._](?:create|manage)$/.test(t) && o) return [o.action, o.name || o.id, o.schedule].filter(v => typeof v === 'string' && v).join(' · ') || 'a routine';
  if (/^(?:station[._]|path\.trust$|browser\.login)/.test(t)) return oneLine(s.split('\n')[0], 300);
  if (o && !/^team[._]/.test(t)) {
    for (const k of ARG_KEYS) if (typeof o[k] === 'string' && o[k].trim()) return oneLine(o[k], 300);
    const pairs = Object.keys(o).filter(k => (typeof o[k] === 'string' && o[k].trim()) || typeof o[k] === 'number' || typeof o[k] === 'boolean').slice(0, 2);
    if (pairs.length) return pairs.map(k => k + ': ' + oneLine(String(o[k]), 60)).join(', ');
  }
  return oneLine(argDigest(s, t, nameOf), 300);
}
function askInspect(tool, raw) {
  const t = String(tool || ''), s = String(raw == null ? '' : raw);
  const o = parseArgs(s);
  if (!o) return s;
  if (/^fs[._](?:write|append|edit|patch)$/.test(t)) {
    const heads = { content: '', find: 'Find:\n', replace: 'Replace with:\n', patch: 'Patch:\n' };
    const parts = typeof o.path === 'string' ? ['File: ' + o.path] : [];
    for (const k of Object.keys(o)) if (k !== 'path') parts.push((k in heads ? heads[k] : k + ': ') + (typeof o[k] === 'string' ? o[k] : JSON.stringify(o[k], null, 2)));
    return parts.join('\n\n');
  }
  return Object.keys(o).map(k => k + ': ' + (typeof o[k] === 'string' ? o[k] : JSON.stringify(o[k]))).join('\n');
}

function makeAgent(id, name) {
  return {
    id, name: String(name || id).toUpperCase().slice(0, 24), model: '', provider: '', inRoster: false,
    runs: new Set(), last: null, now: '', act: new Array(SLOTS).fill(0), bucket: 0, log: [], seq: 0
  };
}

function makeStation() {
  const st = {
    agents: new Map(), order: [], runs: new Map(), prompts: [],
    cost: { usd: null, atLeast: null, cap: null },
    lines: new Map(), jobs: [],
    feed: 'connecting', lastSlotAt: 0, sent: []
  };

  function agent(id) {
    const key = String(id || 'agent');
    let a = st.agents.get(key);
    if (!a) { a = makeAgent(key, key === 'agent' ? 'OVERSEER' : key); st.agents.set(key, a); st.order.push(key); }
    return a;
  }
  const nameOf = id => st.agents.has(String(id)) ? st.agents.get(String(id)).name : '';
  function log(a, entry) {
    entry.seq = ++a.seq;
    a.log.push(entry);
    if (a.log.length > LOG_MAX) a.log.splice(0, a.log.length - LOG_MAX);
    return entry;
  }

  // ---- roster ----------------------------------------------------------------------------------------
  function setRoster(rt) {
    const list = (rt && Array.isArray(rt.agents)) ? rt.agents : [];
    // the hero first, then the roster's own order
    const sorted = list.slice().sort((x, y) => (x && x.agentId === 'agent' ? -1 : 0) - (y && y.agentId === 'agent' ? -1 : 0));
    for (const r of sorted) {
      if (!r || !r.agentId) continue;
      const a = agent(r.agentId);
      a.name = String(r.name || r.agentId).toUpperCase().slice(0, 24);   // whole up to 24; each screen shortens it with …
      a.model = String(r.model || ''); a.provider = String(r.provider || ''); a.inRoster = true;
      // what its runs are held to, when the station says (an older station does not: the app's save is read instead)
      // a station that says the field says it whole: null is the Commander clearing it (the provider's default), never
      // "keep what the terminal last heard" — a cleared effort is not sent on the terminal's runs
      if (Object.prototype.hasOwnProperty.call(r, 'reasoningEffort')) { a.reasoningEffort = typeof r.reasoningEffort === 'string' && r.reasoningEffort ? r.reasoningEffort : null; a.rosterSettings = true; }
      if (typeof r.approvalMode === 'string' && r.approvalMode) { a.approvalMode = r.approvalMode; a.rosterSettings = true; }
      if (typeof r.personaId === 'string' && r.personaId) a.personaId = r.personaId;
    }
    // the hero is always aboard, even on a station whose roster file is empty (a bare `npm start` / headless station)
    if (!sorted.some(r => r && r.agentId === 'agent')) agent('agent');
    const rosterIds = sorted.filter(r => r && r.agentId).map(r => String(r.agentId));
    st.order = rosterIds.concat(st.order.filter(id => rosterIds.indexOf(id) < 0));
  }

  // ---- runs --------------------------------------------------------------------------------------------
  function startRun(p, now, via) {
    const runId = String(p.runId || '');
    if (!runId) return null;
    let run = st.runs.get(runId);
    const a = agent(p.agentId);
    if (!run) {
      run = { runId, agentId: a.id, startedAt: Number(p.startedAt) || now, streamId: String(p.streamId || ''), trigger: String(p.trigger || ''),
        surface: String(p.surface || p.source || ''), lineId: String(p.lineId || ''), dockId: String(p.dockId || ''), prompt: String(p.prompt || ''),
        model: String(p.model || ''), seenStart: false, text: null, tools: new Map(), cli: false };
      st.runs.set(runId, run);
    }
    // a delegated worker: the lead run that sent it (the station says it on the run's start; the FLOOR draws the handoff)
    if (p.parentRunId && !run.parentRunId) { run.parentRunId = String(p.parentRunId); run.delegatedBy = String(p.delegatedBy || ''); }
    // where it works, when the station says (an older one does not: then the run's record says, once it ends)
    if (typeof p.projectRoot === 'string') run.projectRoot = p.projectRoot;
    if (via === 'event' && !run.seenStart) {
      run.seenStart = true;
      Object.assign(run, { streamId: String(p.streamId || run.streamId), trigger: String(p.trigger || run.trigger), surface: String(p.surface || run.surface), lineId: String(p.lineId || run.lineId), dockId: String(p.dockId || run.dockId), prompt: String(p.prompt || run.prompt), model: String(p.model || run.model) });
      // a message this terminal sent: its YOU line is already in the log, so the start only marks it delivered
      const mine = st.sent.findIndex(s => s.agentId === a.id && s.streamId === run.streamId && !s.runId);
      if (mine >= 0) { st.sent[mine].runId = runId; run.cli = true; if (st.sent[mine].entry) st.sent[mine].entry.queued = false; st.sent.splice(mine, 1); }
      else if (run.prompt || sourceOf(run) !== 'desktop') log(a, { k: 'start', runId, source: sourceOf(run), text: run.prompt, at: now });
    }
    // a run already under way when the terminal attached: its start was never seen, so say only that it is running
    if (via === 'snapshot' && !run.adoptedLogged) { run.adoptedLogged = true; log(a, { k: 'start', runId, source: sourceOf(run), text: '', adopted: true, at: now }); }
    if (!a.runs.has(runId)) { a.runs.add(runId); a.bucket += 1; }
    return run;
  }
  function endRun(runId, reason, now, extra) {
    const run = st.runs.get(runId);
    if (!run) return;
    const a = agent(run.agentId);
    a.runs.delete(runId);
    st.runs.delete(runId);
    if (run.text) run.text.live = false;
    for (const t of run.tools.values()) if (t.running) { t.running = false; t.res = t.res || 'no result seen'; }
    a.last = { reason, at: now, usd: (extra && extra.usd) || 0, seen: !(extra && extra.unseen) };
    if (extra && extra.unseen) log(a, { k: 'sys', text: 'a run ended while the feed was away (its end was not seen)', at: now });
    else if (reason && reason !== 'done') log(a, { k: reason === 'cancelled' ? 'sys' : 'bad', text: 'run ended: ' + reason, at: now });
    // asks of an ended run cannot be answered any more
    st.prompts = st.prompts.filter(q => q.runId !== runId || q.background);
  }

  // ---- approvals ---------------------------------------------------------------------------------------
  function addPrompt(p, now) {
    const promptId = String(p.promptId || '');
    if (!promptId || st.prompts.some(q => q.promptId === promptId)) return;
    const asker = String(p.workerAgentId || p.agentId || 'agent');
    const q = { promptId, runId: String(p.runId || ''), agentId: asker, leadId: String(p.agentId || asker), tool: toolName(p.tool),
      scope: String(p.scope || ''), summary: askGlance(toolName(p.tool), p.argsSummary, nameOf), raw: String(p.argsSummary || ''), askedAt: now, background: p.background === true, view: false, details: null };
    if (q.tool === 'brief.ask') { try { const j = JSON.parse(q.raw); q.question = { text: String(j.question || ''), options: Array.isArray(j.options) ? j.options.map(String).slice(0, 6) : [], recommended: String(j.recommended || '') }; } catch (_) { q.question = { text: oneLine(q.raw, 400), options: [], recommended: '' }; } }
    st.prompts.push(q);
    const a = agent(asker);
    q.entry = log(a, { k: 'ask', text: askLine(q), at: now, promptId });
  }
  function askLine(q) { return q.question ? 'asks: ' + q.question.text : 'asks: ' + q.tool + (q.summary ? ' ' + oneLine(q.summary, 160) : ''); }
  // an ask adopted from the snapshot arrives without its words; once the full request is read, the line says them
  function describePrompt(promptId, args) {
    const q = st.prompts.find(x => x.promptId === String(promptId));
    if (!q || q.question) return;
    q.summary = askGlance(q.tool, args, nameOf); q.raw = String(args || '');
    if (q.entry) q.entry.text = askLine(q);
  }
  function settlePrompt(p, now) {
    const promptId = String(p.promptId || '');
    const i = st.prompts.findIndex(q => q.promptId === promptId);
    if (i < 0) return null;
    const q = st.prompts.splice(i, 1)[0];
    const a = agent(q.agentId);
    const where = p.via === 'terminal' ? ' from the terminal' : p.via ? ' (' + p.via + ')' : '';
    const what = q.question ? 'question' : q.tool + (q.summary ? ' ' + oneLine(q.summary, 44) : '');
    if (p.expired) log(a, { k: 'bad', text: 'no answer in time — denied · ' + what, at: now });
    else if (p.stopped) log(a, { k: 'sys', text: 'stopped before an answer · ' + what, at: now });
    else if (p.decision === 'deny') log(a, { k: 'bad', text: 'denied' + where + ' · ' + what, at: now });
    else log(a, { k: 'ok', text: (q.question ? 'answered' : GRANT_WORDS[p.decision] || 'allowed (' + p.decision + ')') + where + ' · ' + what, at: now });
    return q;
  }

  // ---- the live feed ----------------------------------------------------------------------------------
  function apply(name, payload, now) {
    const p = payload || {};
    if (p.runId) { const seen = st.runs.get(String(p.runId)); if (seen) seen.seenAt = now; }
    switch (name) {
      case 'agent.run.start': startRun(p, now, 'event'); return;
      case 'agent.token': {
        const run = st.runs.get(String(p.runId)) || startRun(p, now, 'implied');
        if (!run) return;
        const a = agent(run.agentId);
        if (!run.text || !run.text.live) run.text = log(a, { k: 'agent', runId: run.runId, text: '', live: true, at: now });
        run.text.text += String(p.delta || '');
        a.bucket += String(p.delta || '').length / 12;
        a.now = 'writing a reply';
        return;
      }
      case 'agent.tool_call': {
        const run = st.runs.get(String(p.runId)) || startRun(p, now, 'implied');
        if (!run) return;
        const a = agent(run.agentId);
        if (run.text) run.text.live = false;
        run.text = null;
        const t = log(a, { k: 'tool', runId: run.runId, name: toolName(p.name), args: oneLine(argDigest(p.argsSummary, toolName(p.name), nameOf), 300), file: fileArg(toolName(p.name), p.argsSummary), root: run.projectRoot, running: true, res: '', at: now });
        if (p.callId) run.tools.set(String(p.callId), t);
        a.now = t.name + (t.args ? ' ' + t.args : '');
        a.bucket += 3;
        return;
      }
      case 'agent.tool_result': {
        const run = st.runs.get(String(p.runId));
        const t = run && p.callId ? run.tools.get(String(p.callId)) : null;
        if (!t) return;
        t.running = false; t.ok = !!p.ok && !p.isError; t.ms = Number(p.ms) || 0;
        t.res = String(p.summary || (t.ok ? 'ok' : 'failed')).replace(/\s+/g, ' ').trim();
        run.tools.delete(String(p.callId));
        agent(run.agentId).bucket += 1;
        return;
      }
      case 'agent.cost': {   // spend is read from the budget route (one source for the header, never summed here)
        const run = st.runs.get(String(p.runId));
        if (run && run.text) { run.text.live = false; run.text = null; }
        // what its latest model call was sent: how full its conversation is (/compress says it)
        if (run && Number(p.tokensIn) > 0) agent(run.agentId).lastTokensIn = Number(p.tokensIn);
        return;
      }
      case 'agent.run.error': { const a = agent(p.agentId); log(a, { k: 'bad', text: String(p.message || 'run error'), at: now }); return; }
      case 'agent.run.end': endRun(String(p.runId), String(p.reason || 'error'), now, { usd: Number(p.usd) || 0 }); return;
      case 'permission.prompt': addPrompt(p, now); return;
      case 'permission.response': settlePrompt(p, now); return;
      default: return;
    }
  }

  /* The snapshot is the reconnect truth: runs and asks that are live right now. A run it lists that the feed never
     started is adopted (no prompt known); a run the feed holds that the snapshot no longer lists — for longer than a
     short grace, so a run that just started is not dropped — ended unseen. */
  function applySnapshot(snap, now) {
    const s = snap || {};
    const live = new Set();
    for (const r of (Array.isArray(s.runs) ? s.runs : [])) {
      if (!r || !r.runId || r.internal) continue;
      live.add(String(r.runId));
      if (!st.runs.has(String(r.runId))) startRun({ runId: r.runId, agentId: r.agentId, startedAt: r.startedAt, streamId: r.streamId, source: r.source }, now, 'snapshot');
    }
    for (const run of [...st.runs.values()]) {
      if (!live.has(run.runId) && now - run.startedAt > ORPHAN_GRACE_MS && (!run.seenAt || now - run.seenAt > ORPHAN_GRACE_MS)) endRun(run.runId, 'unknown', now, { unseen: true });
    }
    const waiting = new Set();
    for (const q of (Array.isArray(s.prompts) ? s.prompts : [])) {
      if (!q || !q.promptId) continue;
      waiting.add(String(q.promptId));
      if (!st.prompts.some(x => x.promptId === String(q.promptId))) addPrompt(q, now);
    }
    st.prompts = st.prompts.filter(q => waiting.has(q.promptId) || now - q.askedAt < ORPHAN_GRACE_MS);
  }
  function noteSeen(runId, now) { const r = st.runs.get(String(runId)); if (r) r.seenAt = now; }

  function applyBudget(b) {
    const x = b || {};
    st.cost = {
      usd: (x.spentToday == null || !Number.isFinite(Number(x.spentToday))) ? null : Number(x.spentToday),
      // an unsettled ledger reports its floor as { today, lifetime, runs } (older stations: a bare number)
      atLeast: (x.atLeast && typeof x.atLeast === 'object') ? (Number.isFinite(Number(x.atLeast.today)) ? Number(x.atLeast.today) : null) : (Number.isFinite(Number(x.atLeast)) && x.atLeast !== null ? Number(x.atLeast) : null),
      cap: x.day && Number.isFinite(Number(x.day.cap)) && Number(x.day.cap) > 0 ? Number(x.day.cap) : null
    };
  }

  // ---- workflows: the lines the router knows + the jobs sent down them ---------------------------------
  function applyLines(stats, jobs) {
    const lines = (stats && Array.isArray(stats.lines)) ? stats.lines : [];
    const recs = Array.isArray(jobs) ? jobs : [];
    st.jobs = recs.slice(0, 50);
    const seen = new Set();
    for (const l of lines) {
      if (!l || !l.lineId) continue;
      seen.add(String(l.lineId));
      const cur = st.lines.get(String(l.lineId)) || { lineId: String(l.lineId) };
      Object.assign(cur, { runs: Number(l.runs) || 0, shipped: Number(l.shipped) || 0, failed: Number(l.failed) || 0, usdToday: Number(l.usdToday) || 0 });
      st.lines.set(cur.lineId, cur);
    }
    for (const j of recs) if (j && j.line && !st.lines.has(String(j.line))) { st.lines.set(String(j.line), { lineId: String(j.line) }); seen.add(String(j.line)); }
    for (const id of [...st.lines.keys()]) if (!seen.has(id)) st.lines.delete(id);
    for (const l of st.lines.values()) {
      const mine = recs.filter(j => j && j.line === l.lineId);
      l.name = (mine.find(j => j.name) || {}).name || '';
      l.job = mine[0] || null;   // newest first
    }
  }

  // ---- what this terminal sent -----------------------------------------------------------------------------
  function noteSent(agentId, text, streamId, now) {
    const a = agent(agentId);
    const busy = a.runs.size > 0;
    const entry = log(a, { k: 'you', text: String(text), at: now, queued: busy });
    st.sent.push({ agentId: a.id, streamId: String(streamId || ''), at: now, entry, runId: '' });
    if (busy) log(a, { k: 'sys', text: 'queued · starts when ' + a.name + "'s current run ends", at: now });
    return entry;
  }
  function sendFailed(agentId, streamId, message, now) {
    const i = st.sent.findIndex(s => s.agentId === String(agentId) && s.streamId === String(streamId || '') && !s.runId);
    if (i >= 0) st.sent.splice(i, 1);
    log(agent(agentId), { k: 'bad', text: 'not sent: ' + String(message || 'the station refused the message'), at: now });
  }
  // the agent's own words that did not come from a run (its closing line from the awakening), in its pane
  function noteAgentLine(agentId, text, now) { log(agent(agentId), { k: 'agent', text: String(text || ''), at: now }); }
  // a station command's answer (/usage, /tools, /routine …): what the station said, under the command that asked
  function noteSaid(agentId, cmd, title, lines, ok, now) {
    log(agent(agentId), { k: 'say', cmd: String(cmd || ''), title: String(title || ''), lines: (lines || []).map(String), ok: ok !== false, at: now });
  }
  // a conversation switch (/new, /resume): the agent's pane starts over, with one line saying which conversation this is
  function resetLog(agentId, note) {
    const a = agent(agentId);
    a.log = [];
    if (note) log(a, { k: 'sys', text: String(note), at: 0, divider: true });
  }
  function seedHistory(agentId, turns) {
    const a = agent(agentId);
    const lines = [];
    for (const t of (Array.isArray(turns) ? turns : [])) {
      if (!t || (t.role !== 'user' && t.role !== 'assistant')) continue;
      const text = typeof t.content === 'string' ? t.content : '';
      if (!text.trim()) continue;
      lines.push({ k: t.role === 'user' ? 'you' : 'agent', text, at: Number(t.ts) || 0, history: true });
    }
    if (!lines.length) return;
    const fresh = a.log.slice();
    a.log = [];
    log(a, { k: 'sys', text: '— earlier in this terminal conversation —', at: 0, divider: true });
    for (const l of lines) log(a, l);
    if (fresh.length) log(a, { k: 'sys', text: '— now —', at: 0, divider: true });
    for (const l of fresh) log(a, l);
  }

  // ---- time --------------------------------------------------------------------------------------------
  function tick(now) {
    if (!st.lastSlotAt) st.lastSlotAt = now;
    while (now - st.lastSlotAt >= SLOT_MS) {
      st.lastSlotAt += SLOT_MS;
      for (const a of st.agents.values()) { a.act.push(a.bucket + (a.runs.size ? RUN_FLOOR : 0)); a.act.shift(); a.bucket = 0; }
    }
  }

  // ---- what the screen reads -------------------------------------------------------------------------------
  function statusOf(a, now) {
    const asks = st.prompts.filter(q => q.agentId === a.id);
    if (asks.length) return { key: 'needs', text: 'needs you' };
    if (a.runs.size) {
      let since = Infinity;
      for (const id of a.runs) { const r = st.runs.get(id); if (r && r.startedAt < since) since = r.startedAt; }
      return { key: 'working', since: since === Infinity ? now : since, count: a.runs.size };
    }
    if (a.last && now - a.last.at < RECENT_MS) {
      if (a.last.reason === 'done') return { key: 'done', text: 'done' };
      if (a.last.reason === 'unknown') return { key: 'idle', text: 'idle' };
      return { key: 'stopped', text: a.last.reason };
    }
    return { key: 'idle', text: 'idle' };
  }
  function nowOf(a, status) {
    if (status.key === 'needs') {
      const q = st.prompts.find(x => x.agentId === a.id);
      return q.question ? 'asks: ' + q.question.text : 'asks: ' + q.tool + (q.summary ? ' ' + oneLine(q.summary, 200) : '');
    }
    if (status.key === 'working') {
      const run = [...a.runs].map(id => st.runs.get(id)).find(Boolean);
      const src = run ? sourceOf(run) : '';
      return (a.now || 'thinking') + (src && src !== 'terminal' && src !== 'desktop' ? ' · ' + src : '');
    }
    if (a.last) return 'last run: ' + (a.last.seen === false ? 'ended unseen' : a.last.reason);
    return '';
  }
  function rows(now) {
    return st.order.map(id => st.agents.get(id)).filter(Boolean).map(a => {
      const status = statusOf(a, now);
      return { id: a.id, name: a.name, model: a.model, status, now: nowOf(a, status), act: a.act.slice() };
    });
  }
  function header(now) {
    let working = 0;
    for (const a of st.agents.values()) if (a.runs.size) working++;
    return { working, needs: st.prompts.length, cost: st.cost, feed: st.feed, agents: st.order.length, now };
  }
  function flows(now) {
    const out = [];
    for (const l of st.lines.values()) {
      const live = [...st.runs.values()].filter(r => r.lineId === l.lineId || (l.job && l.job.status === 'running' && r.streamId && r.streamId === l.job.streamId));
      const job = l.job;
      let state = 'idle', text = 'no jobs yet';
      if (live.length || (job && job.status === 'running')) {
        state = 'running';
        const r = live[0];
        text = r ? agent(r.agentId).name + ' · ' + fmtDur(now - r.startedAt) : 'running';
      } else if (job) {
        // a job that reached its OUTBOX is the line's success, whichever word its record uses
        state = (job.status === 'done' || job.status === 'delivered') ? 'done' : job.status;
        text = job.status + (job.endedAt ? ' · ' + ago(now - job.endedAt) : '');
      }
      out.push({ lineId: l.lineId, name: l.name || shortLine(l.lineId), state, text, job, runs: l.runs || 0, shipped: l.shipped || 0, steps: job ? job.steps || 0 : 0, agents: live.map(r => agent(r.agentId).name) });
    }
    return out;
  }
  function findAgent(word) {
    const w = String(word || '').replace(/^@/, '').toLowerCase();
    if (!w) return null;
    for (const id of st.order) { const a = st.agents.get(id); if (a && (a.id.toLowerCase() === w || a.name.toLowerCase() === w)) return a; }
    const pre = st.order.map(id => st.agents.get(id)).filter(a => a && (a.name.toLowerCase().indexOf(w) === 0 || a.id.toLowerCase().indexOf(w) === 0));
    return pre.length === 1 ? pre[0] : null;
  }
  function findLine(word) {
    const w = String(word || '').toLowerCase();
    const all = [...st.lines.values()];
    return all.find(l => l.lineId.toLowerCase() === w) || all.find(l => (l.name || '').toLowerCase() === w)
      || (all.filter(l => (l.name || '').toLowerCase().indexOf(w) === 0).length === 1 ? all.find(l => (l.name || '').toLowerCase().indexOf(w) === 0) : null);
  }

  return {
    state: st, agent, setRoster, apply, applySnapshot, describePrompt, applyBudget, applyLines, noteSeen, noteSent, noteSaid, noteAgentLine, sendFailed, seedHistory, resetLog, tick,
    rows, header, flows, findAgent, findLine, statusOf, front: () => st.prompts[0] || null, logOf: (id) => (st.agents.get(String(id)) || { log: [] }).log
  };
}

function fmtDur(ms) { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = s % 60; return h ? h + 'h' + String(m).padStart(2, '0') + 'm' : s >= 60 ? Math.floor(s / 60) + 'm' + String(r).padStart(2, '0') + 's' : r + 's'; }
function fmtShort(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return s >= 172800 ? Math.floor(s / 86400) + 'd' : s >= 3600 ? Math.floor(s / 3600) + 'h' : s >= 60 ? Math.floor(s / 60) + 'm' : s + 's'; }
function ago(ms) { return fmtShort(ms) + ' ago'; }
function shortLine(id) { return 'line ' + String(id || '').slice(0, 8); }
function usd(n) { return '$' + (Number(n) || 0).toFixed(2); }

// the header's spend words: unknown is never $0 (an unsettled ledger says "at least")
function costText(cost) {
  const c = cost || {};
  if (c.usd != null) return usd(c.usd) + ' today';
  // a floor of $0.00 says nothing: name the state instead (the desktop app's spend panel says which runs to settle)
  if (c.atLeast != null) return c.atLeast > 0 ? '≥' + usd(c.atLeast) + ' today' : 'spend unsettled';
  return 'spend unknown';
}

module.exports = { makeStation, sourceOf, toolName, oneLine, argDigest, askGlance, askInspect, fmtDur, fmtShort, ago, costText, SLOTS, SLOT_MS, RUN_FLOOR, RECENT_MS, ONCE_ONLY_TOOLS };
