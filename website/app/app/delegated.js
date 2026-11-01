'use strict';
/* DELEGATED — the live card in a conversation that handed work to the crew.

   VERSION B (2026-10-11, chosen by a blind usability test over workers posting into the chat and over worker threads in
   SESSIONS): the conversation you asked in is the ONE place. NOVA reports back there once; this card under the ask
   says who is doing what right now (Stop while it runs), and each worker's own answer + "What MIRA did" receipt
   unfolds IN PLACE on its row (See work). Workers' threads are storage (Workstreams hides them) — never a place
   you have to go.

   TRUTHFUL TELEMETRY. Nothing here is invented:
   - the rows are this page's records of the workers filed for this conversation (worker:true threads, parentStreamId);
   - a dispatch groups by the lead run that filed the thread (/api/overseer threads[].leadRunId);
   - state reads the durable worker ledger (/api/overseer workers, polled by Overseer) for background workers and
     the thread's live channel (the bridge's real runId via station.dispatch_start/end) for foreground ones; until the
     ledger's first answer lands, a row with no live signal reads "checking…" — never stopped or ended;
   - the live step is the worker's own agent.tool_call event, matched by its runId;
   - a receipt is the worker run's own record (/api/runs?runId) and its own transcript rows (/api/transcript?runId):
     its answer, the tools it called with their arguments, the files it saved, its time and cost.
   A foreground worker that ended without delivering anything says exactly that — never "done". */
const Delegated = (() => {
  const steps = new Map();   // worker runId -> { name, args } of its latest agent.tool_call
  let ticker = 0, tickGen = 0, wired = false;
  const $log = () => document.getElementById('chat-log');
  const esc = s => U.esc(s == null ? '' : s);   // the one complete impl (escapes & < > " ' — the local copy left ' raw, qw36)
  const clock = ms => { const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const snap = () => (typeof Overseer !== 'undefined' && Overseer.snapshot && Overseer.snapshot()) || {};
  // the instant CREW is painting when this repaint rides its turn (CrewClock.now), so the row reads exactly what CREW shows
  const crewNow = () => (typeof CrewClock !== 'undefined' && CrewClock && typeof CrewClock.now === 'function') ? CrewClock.now() : Date.now();
  const has = (o, k) => typeof o !== 'undefined' && o && typeof o[k] === 'function';

  function agentOf(id) {
    const list = has(App, 'agents') ? App.agents() : [];
    return list.find(a => a.id === id) || { id, name: (has(App, 'agentName') && App.agentName(id)) || id };
  }
  /* one card = the threads one lead run filed: its dispatch calls in the order they were made (a thread's `call`, the
     requestId's middle segment), each call's workers in the order it asked for them. */
  function batches(parentId) {
    if (typeof Workstreams === 'undefined' || !parentId) return [];
    const s = snap();
    const threads = new Map((s.threads || []).map(t => [t.id, t]));
    const workers = Array.isArray(s.workers) ? s.workers : [];
    const groups = new Map();
    // workers' threads are hidden from every session list; the card is the one place that reads them
    const kids = Workstreams.list({ includeArchived: true, includeWorkers: true }).filter(w => w && w.worker === true && w.parentStreamId === parentId)
      .sort((a, b) => (+a.createdAt || 0) - (+b.createdAt || 0));
    for (const k of kids) {
      const worker = workers.filter(x => x && x.streamId === k.id).sort((a, b) => (+b.startedAt || 0) - (+a.startedAt || 0))[0] || null;
      const t = threads.get(k.id);
      const lead = (t && t.leadRunId) || (worker && worker.parentRunId) || ('at:' + Math.floor((+k.createdAt || 0) / 60000));
      if (!groups.has(lead)) groups.set(lead, { lead, at: +k.createdAt || 0, rows: [] });
      groups.get(lead).rows.push({ ws: k, worker, slot: (t && Number(t.slot)) || 0, call: (t && t.call) || '' });
    }
    // a lead run's dispatch calls in the order they were made (rows are in createdAt order here), and each call's
    // workers in the order the lead asked for them (threads made in the same instant tie on createdAt; slots restart
    // at 0 for every call, so sorting by slot alone would interleave two calls)
    groups.forEach(g => {
      const first = new Map();
      g.rows.forEach((r, i) => { if (!first.has(r.call)) first.set(r.call, i); });
      g.rows.sort((x, y) => (first.get(x.call) - first.get(y.call)) || (x.slot - y.slot));
    });
    return Array.from(groups.values()).sort((a, b) => a.at - b.at);
  }

  /* what a worker is doing, in words: the verb its tool call means plus the one argument that says what about
     (the query, the page, the file). Read off its own agent.tool_call event — never a guess. */
  const VERBS = [[/search/, 'searching', 'searched'], [/fetch|request|browse|browser|navigate/, 'reading the web', 'opened'], [/(^|[._])(write|edit|patch|append)/, 'writing', 'wrote'],
    [/(^|[._])(read|list|glob|grep|find)/, 'looking through files', 'looked through'], [/shell|exec|terminal|verify/, 'running a command', 'ran'],
    [/image|voice|video|audio|media/, 'making media', 'made'], [/notebook|memory|recall/, 'checking its notes', 'checked its notes']];
  function argOf(raw) {
    let v = '';
    try {
      const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (j && typeof j === 'object') for (const k of ['query', 'q', 'url', 'path', 'file', 'command', 'cmd', 'pattern', 'prompt', 'text', 'name']) if (typeof j[k] === 'string' && j[k].trim()) { v = j[k]; break; }
    } catch (_) { v = /^[\s{[]/.test(String(raw)) ? '' : String(raw || ''); }
    v = String(v).replace(/\s+/g, ' ').trim();
    return v.length > 60 ? v.slice(0, 59) + '…' : v;
  }
  function verbOf(name, past) {
    const n = String(name || '').toLowerCase().replace(/^mcp__/, '');
    const hit = VERBS.find(([re]) => re.test(n));
    return hit ? hit[past ? 2 : 1] : n.replace(/^[a-z]+[._]/, '').replace(/[_.]+/g, ' ');
  }
  function doing(step) {
    if (!step) return 'working';
    const arg = argOf(step.args);
    const verb = verbOf(step.name, false);
    return arg && arg !== '.' ? verb + ' · ' + arg : verb;
  }

  // Polling can lag behind a newer run on this thread. Never use the old ledger's state, Stop, or receipt.
  function currentWorker(r) {
    const w = r.worker, C = typeof Channels !== 'undefined' ? Channels : null;
    if (!w || !w.runId) return w;
    const live = C && C.isBusy && C.isBusy(r.ws.id) && C.runIdOf && C.runIdOf(r.ws.id);
    if (live && String(live) !== String(w.runId)) return null;
    const ids = (r.ws.runIds || []).map(String), i = ids.indexOf(String(w.runId));
    return i >= 0 && i < ids.length - 1 ? null : w;
  }

  // a stale worker was cut off by a station restart, or stopped by the liveness check while the station stayed up
  // (the sidecar records that reason as "stalled: …"): say which, never a restart that did not happen
  const staleLine = w => /^stalled\b/.test(String((w && w.reason) || '')) ? 'stopped after making no progress' : 'stopped when the station restarted';
  // why a worker ended, in a few plain words: the ledger's reason codes are internal ('refused', 'output_limit', …).
  // A code with no phrase shows as itself only while it is short; a long free-text reason shows nothing here.
  const WHY = { refused: 'couldn\'t start (too many running, or a sign-in is needed)', timeout: 'ran out of time', empty: 'the model sent an empty reply', refusal: 'the model declined the task',
    output_limit: 'hit the model\'s output limit', 'invalid-result': 'its result failed the format check', 'not-dispatched': 'never started',
    stalled: 'made no progress', error: 'hit an error' };
  function whyOf(r) {
    const s = String(r || '').trim();
    return WHY[s] || WHY[s.split(':')[0].trim()] || (s.length > 40 ? '' : s.replace(/[_-]+/g, ' '));
  }
  // the sidecar's own explanation of a bad end, for a hover tip: a refusal's or an error's sentence (the ledger's result;
  // a timeout's or a rejected answer's result is the worker's partial work, never a reason) or a long free-text reason
  // the status line leaves out (the liveness check's receipt). Clipped, never invented. /api/overseer workers[] carry
  // `failure` only for a refused or failed worker (never `result`), so a timeout's partial work never reaches this tip.
  function tipOf(w) {
    if (!w || !['error', 'refused', 'stale'].includes(w.status)) return '';
    const reason = String(w.reason || '').trim();
    const said = w.status !== 'stale' && (w.status === 'refused' || reason === 'refused' || reason === 'error') ? String(w.failure || '') : '';
    const one = (said.trim() || (reason.length > 40 ? reason : '')).replace(/\s+/g, ' ').trim();
    return one.length > 200 ? one.slice(0, 199) + '…' : one;
  }

  /* HAS THE LEDGER ANSWERED THIS PAGE? Overseer reads the station's worker ledger (/api/overseer) from page load; until
     its first answer lands snapshot() is null, and every row looks like a worker with no record. Reopening a conversation
     then read "3 stopped" for half a second, and "1 stopped" for a worker that was waiting on an approval (live walk
     10-14): silence before the first read is not an answer. 'answered' | 'checking' (the first read is on its way) |
     'unreachable' (it failed or hangs: the station is not answering). A page with no ledger module has no answer either. */
  function ledgerRead() {
    const O = typeof Overseer !== 'undefined' ? Overseer : null;
    if (O && typeof O.snapshot === 'function' && O.snapshot()) return 'answered';
    return O && typeof O.unreachable === 'function' && O.unreachable() ? 'unreachable' : 'checking';
  }

  /* the row's state, in priority order. `parentLive` = the lead run that dispatched it is still running on this page. */
  function stateOf(r, parentId, lead) {
    const k = r.ws, w = currentWorker(r), C = typeof Channels !== 'undefined' ? Channels : null;
    // a worker's approval or question is raised on the conversation that dispatched it (the lead's consent broker),
    // stamped with the worker that asked — the row matches it EXACTLY by that worker's thread or run, never by agent
    const pend = askOf(r, parentId);
    if (pend) return { cls: 'waiting', live: pend.tool === 'brief.ask' ? 'asking you a question' : 'needs you', t: '', pend };
    if (w && w.status === 'running') {
      // the station stopped answering (Overseer.fresh): the last ledger can no longer vouch for this worker, so the row
      // claims neither working nor stopped — no live clock, no Stop key (a failed poll repaints at once)
      if (typeof Overseer !== 'undefined' && Overseer.fresh && !Overseer.fresh()) return { cls: 'unknown', live: 'status unknown — station unreachable', t: '' };
      // the worker's OWN run as CREW clocks it (every wait on the Commander excluded — rc walk #21: this branch still read the
      // ledger's wall clock, so a worker that waited on an approval read a minute ahead of CREW and the world tag); the
      // ledger's start only when this page never saw that run begin
      const runMs = (typeof CrewClock !== 'undefined' && CrewClock && typeof CrewClock.elapsedOfRun === 'function' && w.runId) ? CrewClock.elapsedOfRun(w.runId, crewNow()) : null;
      return { cls: 'working', live: doing(steps.get(String(w.runId))), t: clock(typeof runMs === 'number' && isFinite(runMs) ? runMs : Date.now() - (+w.startedAt || Date.now())), stop: !!w.canInterrupt, worker: w };
    }
    // elapsedOf needs NOW: without it the clock read NaN and painted "0:00" for the whole run (live walkthrough 2026-10-13)
    if (C && C.isBusy && C.isBusy(k.id)) {
      // Only the current channel identifies this run; a historical run or the agent's oldest run may be its sibling.
      // Read at the instant CREW is painting (crewNow), so the row turns its second with CREW and the world tag.
      const now = crewNow(), runId = C.runIdOf ? C.runIdOf(k.id) : null;
      const runMs = runId && typeof CrewClock !== 'undefined' && CrewClock.elapsedForRun ? CrewClock.elapsedForRun(runId, now) : null;
      return { cls: 'working', live: 'working', t: Number.isFinite(runMs) ? clock(runMs) : (C.elapsedOf ? clock(C.elapsedOf(k.id, now)) : '') };
    }
    // a row the ledger has not answered for (no ledger record for it, and no first read yet) claims nothing past the live
    // signals above (its own ask, its live channel): not stopped, not "ended without a result", not "starting", and not
    // its thread's last recorded end either (the ledger may hold a newer run on it). `unread` = it was never seen running,
    // so it neither opens the card nor counts as a stopped or settled worker
    if (!r.worker) {
      const read = ledgerRead();
      if (read !== 'answered') return { cls: 'unknown', live: read === 'unreachable' ? 'status unknown — station unreachable' : 'checking…', t: '', unread: read };
    }
    const reason = String((w && w.reason) || k.lastRunReason || '');
    if (reason === 'budget' || reason === 'max_iters') return { cls: 'stopped', live: reason === 'budget' ? 'budget limit reached' : 'step limit reached', t: '' };
    if (['aborted', 'cancelled', 'interrupted', 'stopped'].includes(reason)) return { cls: 'stopped', live: 'stopped before completion', t: '' };
    if (w && w.status === 'done') return { cls: 'done', live: 'done', t: w.completedAt && w.startedAt ? clock(w.completedAt - w.startedAt) : '' };
    if (w && (w.status === 'error' || w.status === 'refused')) return { cls: 'failed', live: 'failed' + (w.reason && w.reason !== 'error' && whyOf(w.reason) ? ' · ' + whyOf(w.reason) : ''), t: '', tip: tipOf(w) };
    if (w && (w.status === 'interrupted' || w.status === 'stale')) return { cls: 'stopped', live: w.status === 'stale' ? staleLine(w) : 'stopped', t: '', tip: tipOf(w) };
    if (k.lastRunOk === false) return { cls: 'failed', live: 'failed', t: '' };
    if (reason === 'done') return { cls: 'done', live: 'done', t: '' };
    if (reason) return { cls: 'failed', live: 'ended · ' + (whyOf(reason) || 'before finishing'), t: '' };
    // a thread filed before outcomes were recorded (0.13.x and earlier) holds an answer, but the old recovery also filed
    // budget / step-limit partials: say only what is provable — it was delivered — never 'done'
    if ((k.runIds || []).length) return { cls: 'recorded', live: 'delivered', t: '' };
    const parentBusy = C && C.isBusy && C.isBusy(parentId) && (!C.runIdOf || !lead || C.runIdOf(parentId) === lead);
    if (parentBusy) return { cls: 'queued', live: 'starting', t: '' };
    return { cls: 'stopped', live: 'ended without a result', t: '' };
  }
  // the prompt waiting on the Commander that THIS worker raised: matched by the stamp the sidecar puts on a delegated
  // worker's ask (workerStreamId / workerRunId), never by agent id (the lead's id rides every worker's ask)
  function askOf(r, parentId) {
    const C = typeof Channels !== 'undefined' ? Channels : null;
    if (!C) return null;
    const own = C.pendingOf ? C.pendingOf(r.ws.id) : null;
    if (own) return own;
    const all = C.pendingAllOf ? C.pendingAllOf(parentId) : [C.pendingOf ? C.pendingOf(parentId) : null];
    const runIds = new Set([r.worker && r.worker.runId, ...(r.ws.runIds || []), C.runIdOf ? C.runIdOf(r.ws.id) : ''].filter(Boolean).map(String));
    return (all || []).find(p => p && ((p.workerStreamId && p.workerStreamId === r.ws.id) || (p.workerRunId && runIds.has(String(p.workerRunId))))) || null;
  }

  /* ONE CARD PER LEAD RUN under the ask (its dispatch calls in order): "Delegated to MIRA, ROOK and VEX · 2 working · 1 done". While anything runs (or
     waits on you) its rows show (2026-10-10 blind test: who-has-what and Stop without a click); once all settle it
     folds to that one line. The Commander's own click wins either way while the page lives. */
  const opened = new Set();   // batch keys the Commander expanded
  const closed = new Set();   // batch keys the Commander folded while they were still running
  const seen = new Set();     // worker thread ids whose work is unfolded (See work)
  const receipts = new Map(); // worker thread id -> { status: 'loading'|'ok'|'err', data, at, runId, error }
  const loadingReceipts = new Set();
  const answering = new Set();
  const closedAsks = new Map();   // worker thread id -> the ask the station no longer held when this page answered it (answer())
  const stopping = new Set();
  const WORD = { recorded: 'delivered', working: 'working', waiting: 'needs you', done: 'done', failed: 'failed', stopped: 'stopped', queued: 'starting', unknown: 'status unknown' };
  function names(list) {
    // each agent once (rc walk #44: a re-dispatch read "Delegated to RESEARCH, COPY and COPY"); its rows below still list every task
    const n = list.map(a => String(a.name || a.id)).filter((x, i, all) => all.indexOf(x) === i);
    return n.length <= 3 ? (n.length > 1 ? n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1] : n[0] || '')
      : n.slice(0, 2).join(', ') + ' and ' + (n.length - 2) + ' more';
  }
  const cap = s => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
  function lineHtml(b, parentId) {
    const rows = b.rows.map(r => ({ r, st: stateOf(r, parentId, b.lead), a: agentOf(r.ws.agentId || 'agent') }));
    const count = c => rows.filter(x => x.st.cls === c).length;
    // rows the ledger has not answered for yet (stateOf `unread`): the first read is on its way (checking…) or failed
    const unread = rows.filter(x => x.st.unread).length, checking = rows.filter(x => x.st.unread === 'checking').length;
    const sum = [count('waiting') && count('waiting') + ' need' + (count('waiting') === 1 ? 's' : '') + ' you', count('working') && count('working') + ' working',
      count('queued') && count('queued') + ' starting', count('failed') && count('failed') + ' failed', count('stopped') && count('stopped') + ' stopped',
      count('unknown') - checking && (count('unknown') - checking) + ' status unknown',
      checking && (checking === rows.length ? 'checking…' : checking + ' checking'),
      count('recorded') && count('recorded') + ' delivered',
      count('done') && (count('done') === rows.length ? (rows.length > 1 ? 'all ' + rows.length + ' done' : 'done') : count('done') + ' done')]
      .filter(Boolean).join(' · ');
    // a row whose state the station cannot confirm right now (unknown) keeps an open card open: it was running a beat ago.
    // A row the ledger has not answered for yet was never seen running: it opens nothing
    const live = count('working') + count('waiting') + count('queued') + count('unknown') - unread > 0;
    // a worker waiting on you always shows (folding it would hide the one thing that needs you)
    const open = opened.has(b.lead) || count('waiting') > 0 || (live && !closed.has(b.lead));
    // the batch lamp: the most urgent worker state (needs you > working > failed > unknown > done); unknown keeps the
    // plain unlit lamp, neither the working pulse nor the failed red
    const tone = count('waiting') ? 'waiting' : (count('working') || count('queued')) ? 'working' : (count('failed') || count('stopped')) ? 'failed' : count('unknown') ? 'unknown' : count('recorded') ? 'recorded' : 'done';
    const head = '<button type="button" class="dg-line-head" data-dg-toggle="' + esc(b.lead) + '" aria-expanded="' + open + '">'
      + '<span class="dg-lamp ' + tone + '" aria-hidden="true"></span>'
      + '<span class="dg-line-text">Delegated to <b>' + esc(names(rows.map(x => x.a))) + '</b></span>'
      + '<span class="dg-line-sum ' + tone + '">' + esc(sum) + '</span><span class="dg-caret" aria-hidden="true"></span></button>';
    if (!open) return head;
    return head + '<div class="dg-line-list">' + rows.map(({ r, st, a }) => {
      // the thread's " (2)" is only there to keep thread titles unique; the card says the task in its own words
      const task = String(r.ws.title || 'Delegated task').replace(/ \(\d+\)$/, '').replace(/ · \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/, '');
      const who = a.name || a.id, id = r.ws.id, shown = seen.has(id);
      // its last answer reached no ask (answer()): said on the row while it still works, until it asks again or settles
      if (closedAsks.has(id) && (st.cls === 'waiting' || !['working', 'unknown', 'queued'].includes(st.cls))) closedAsks.delete(id);
      const status = st.cls === 'waiting' ? askLine(st.pend) : cap(st.live || WORD[st.cls]) + (closedAsks.has(id) ? ' · approval no longer waiting — your answer was not applied' : '');
      // ONE way to act per state: answer its ask, stop it while it runs, else see its work
      const key = st.cls === 'waiting' && st.pend.tool === 'brief.ask'
        ? '<button type="button" class="dg-key primary" data-dg-question="' + esc(st.pend.promptId) + '">Answer</button>'
        : st.cls === 'waiting'
        ? '<span class="dg-keys"><button type="button" class="dg-key primary" data-dg-consent="once" data-dg-ws="' + esc(id) + '" data-dg-prompt="' + esc(st.pend.promptId) + '"' + (answering.has(String(st.pend.promptId)) ? ' disabled' : '') + '>Approve once</button>'
          + '<button type="button" class="dg-key deny" data-dg-consent="deny" data-dg-ws="' + esc(id) + '" data-dg-prompt="' + esc(st.pend.promptId) + '"' + (answering.has(String(st.pend.promptId)) ? ' disabled' : '') + '>Deny</button></span>'
        : st.stop
          ? '<button type="button" class="dg-key deny" data-dg-stop="' + esc(st.worker.id) + '" data-tip="Stop ' + esc(who) + '"' + (stopping.has(st.worker.id) ? ' disabled' : '') + '>' + (stopping.has(st.worker.id) ? 'Stopping…' : 'Stop') + '</button>'
          : '<button type="button" class="dg-key" data-dg-see="' + esc(id) + '" aria-expanded="' + shown + '">' + (shown ? 'Hide work' : 'See work') + '</button>';
      return '<div class="dg-li ' + st.cls + '" data-dg-row="' + esc(id) + '" role="group" aria-label="' + esc(who + ': ' + task + ' — ' + (st.unread === 'checking' ? 'checking' : WORD[st.cls])) + '">'
        + '<span class="dg-lamp ' + st.cls + '" aria-hidden="true"></span><span class="dg-li-who">' + esc(who) + '</span>'
        + '<span class="dg-li-task" data-tip="' + esc(task) + '">' + esc(task) + '</span><span class="dg-li-st"' + (st.tip ? ' data-tip="' + esc(st.tip) + '"' : '') + '>' + esc(status) + '<span data-dg-clock="' + esc(id) + '"></span></span>' + key
        + '</div>' + (st.pend && st.pend.tool !== 'brief.ask' ? '<div class="dg-inspect" data-dg-inspect="' + esc(id) + '" data-dg-prompt="' + esc(st.pend.promptId) + '"></div>' : '')
        + (shown ? '<div class="dg-work" data-dg-work="' + esc(id) + '">' + workHtml(id, who) + '</div>' : '');
    }).join('') + '</div>';
  }
  // what a waiting worker wants, in its own words (the same phrase the approval card would use)
  function askLine(p) {
    if (!p) return 'Needs you';
    if (p.tool === 'brief.ask') { try { const q = JSON.parse(p.argsSummary || '{}'); return 'Needs you · ' + (q.question || 'a question'); } catch (_) { return 'Needs you · a question'; } }
    const phrase = typeof Chat !== 'undefined' && Chat.consentPhrase ? Chat.consentPhrase(p) : String(p.tool || '').replace(/[_.]+/g, ' ');
    return 'Needs you · ' + phrase;
  }

  /* ---------------- SEE WORK: the worker's own answer and receipt, unfolded in place ---------------- */
  function workerRunOf(r) {
    const C = typeof Channels !== 'undefined' ? Channels : null;
    const live = C && C.isBusy && C.isBusy(r.ws.id) && C.runIdOf && C.runIdOf(r.ws.id);
    const worker = currentWorker(r);
    return String(live || (worker && worker.runId) || (r.ws.runIds || []).slice(-1)[0] || (C && C.runIdOf ? C.runIdOf(r.ws.id) : '') || '');
  }
  const fmtMs = ms => { const s = Math.round((Number(ms) || 0) / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function costOf(row) {
    if (!row) return '';
    if (row.unmetered) return 'subscription';
    if (row.spendUnknown) return 'spend unknown';
    const usd = Number(row.usd) || 0;
    return usd <= 0 ? '' : usd < 0.01 ? '<$0.01' : '$' + usd.toFixed(2);
  }
  const hostOf = u => { try { return new URL(String(u)).host.replace(/^www\./, ''); } catch (_) { return String(u || '').slice(0, 40); } };
  const pageOf = u => { try { const x = new URL(String(u)); return (x.host.replace(/^www\./, '') + x.pathname.replace(/\/$/, '')).slice(0, 60); } catch (_) { return String(u || '').slice(0, 60); } };
  // fold the run record + its transcript rows into what the receipt shows. Pure: the tests drive it directly.
  function foldReceipt(row, turns, deliveryText) {
    const parsed = typeof DeskScreen !== 'undefined' && DeskScreen.parseScreens ? DeskScreen.parseScreens(turns || []) : [];
    // a call the Task Brief held did not run (it is made again once the brief settles): never a step, done or failed
    const heldTrace = t => typeof TaskIntent !== 'undefined' && TaskIntent.isGateHeld && TaskIntent.isGateHeld(t);
    const list = parsed.length ? parsed : ((row && row.toolTrace) || []).filter(t => !heldTrace(t)).map(t => ({ name: t.name, args: {}, isError: !!t.isError || t.ok === false, done: true }));
    const stepsOut = [], sites = [], searches = [], seenUrl = new Set();
    for (const s of list) {
      if (s.held) continue;
      const n = String(s.name || '').toLowerCase().replace(/\./g, '_'), a = s.args || {};
      if (/web_search/.test(n) && a.query) searches.push(String(a.query));
      const url = typeof a.url === 'string' ? a.url : '';
      if (url && /web_fetch|web_request|browser_navigate|browser_open/.test(n) && !seenUrl.has(url)) { seenUrl.add(url); sites.push({ url, host: hostOf(url), ok: !s.isError }); }
      const raw = url ? pageOf(url) : argOf(a), arg = /^\.[\\/]?$/.test(raw) ? 'the workspace' : raw;   // a bare "." reads as nothing
      // a step with no result yet (it may be waiting on your approval) reads in the present tense: "Writing x.md …", never "Wrote"
      stepsOut.push({ verb: verbOf(s.name, s.done !== false), arg, ok: !s.isError, done: s.done !== false });
    }
    const delivery = row && row.dispatchDelivery;
    let answer = String(delivery ? (delivery.state === 'final' ? delivery.text || '' : '') : (row && row.deliveryText) || '');
    if (!delivery && (!answer || answer.length >= 24000)) {   // the run record caps its delivery: the transcript has the whole answer
      for (let i = (turns || []).length - 1; i >= 0; i--) { const t = turns[i]; if (t && t.role === 'assistant' && typeof t.content === 'string' && t.content.trim()) { answer = t.content; break; } }
    }
    // Expand a capped answer only from the finalized delivery projection, never the original execution.
    if (delivery && delivery.state === 'final' && (answer.length >= 24000 || (delivery.textLength != null && delivery.textLength !== answer.length))) {
      answer = typeof deliveryText === 'string' ? deliveryText : '';
    }
    const files = ((row && row.artifacts) || []).filter(x => x && x.path && (!x.kind || x.kind === 'file' || x.kind === 'image'))
      .map(x => ({ name: String(x.path).split(/[\\/]/).pop(), path: String(x.path), agentId: row.agentId || 'agent', projectRoot: row.projectRoot || '' }));
    return { answer, agentId: (row && row.agentId) || '', projectRoot: row ? (row.projectRoot || '') : null, steps: stepsOut, sites, searches, files, ms: row ? Number(row.durationMs) || 0 : 0, cost: costOf(row), live: !row || !!(delivery && delivery.state === 'pending') };
  }
  async function loadReceipt(id) {
    const r = findRow(id); if (!r) return;
    const runId = workerRunOf(r);
    if (!runId) { receipts.set(id, { status: 'err', error: 'no run is recorded for this worker yet', at: Date.now() }); repaint(); return; }
    const requestKey = id + ':' + runId;
    if (loadingReceipts.has(requestKey)) return;
    loadingReceipts.add(requestKey);
    const prev = receipts.get(id);
    if (!prev || prev.runId !== runId) receipts.set(id, { status: 'loading', at: Date.now(), runId });
    try {
      const read = async url => { const response = await fetch(url, { cache: 'no-store' }); if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); };
      const agent = encodeURIComponent(r.ws.agentId || 'agent');
      const [runs, tr] = await Promise.all([
        read('/api/runs?agent=*&runId=' + encodeURIComponent(runId)),
        read('/api/transcript?agent=' + agent + '&stream=' + encodeURIComponent(id) + '&runId=' + encodeURIComponent(runId) + '&limit=500')
      ]);
      const row = ((runs && runs.runs) || []).find(x => x && x.runId === runId) || null;
      if (!row && !['working', 'waiting', 'queued'].includes(stateOf(r, r.ws.parentStreamId, r.lead).cls)) throw new Error('The run record is unavailable. Try again to retrieve its work.');
      let deliveryText;
      const delivery = row && row.dispatchDelivery;
      if (delivery && delivery.state === 'pending' && !['working', 'waiting', 'queued'].includes(stateOf(r, r.ws.parentStreamId, r.lead).cls)) {
        throw new Error('This worker ended, but its finalized result could not be recovered. Try again to retrieve its work.');
      }
      if (delivery && delivery.state === 'final' && (String(delivery.text || '').length >= 24000 || (delivery.textLength != null && delivery.textLength !== String(delivery.text || '').length))) {
        const full = await read('/api/transcript?stream=' + encodeURIComponent(id) + '&runId=' + encodeURIComponent(runId) + '&delivery=1&limit=1');
        deliveryText = await Workstreams.finalDeliveryText(row, full && full.turns);
        if (deliveryText == null) throw new Error('The complete finalized result is unavailable. Try again to retrieve its work.');
      }
      if (receipts.get(id) && receipts.get(id).runId !== runId) return; // a newer run owns this receipt now
      receipts.set(id, { status: 'ok', data: foldReceipt(row, (tr && tr.turns) || [], deliveryText), at: Date.now(), runId });
    } catch (e) {
      if (!receipts.get(id) || receipts.get(id).runId === runId) receipts.set(id, { status: 'err', error: String((e && e.message) || e), at: Date.now(), runId });
    } finally { loadingReceipts.delete(requestKey); }
    repaint();
  }
  function workHtml(id, who) {
    const rec = receipts.get(id);
    if (!rec || rec.status === 'loading') return '<p class="dg-work-note">Loading ' + esc(who) + '\'s work…</p>';
    if (rec.status === 'err') return '<p class="dg-work-note bad">Couldn\'t load this work: ' + esc(rec.error) + '</p><button type="button" class="dg-key" data-dg-retry="' + esc(id) + '">Try again</button>';
    const d = rec.data, meta = [d.steps.length && d.steps.length + ' step' + (d.steps.length === 1 ? '' : 's'), d.ms && fmtMs(d.ms), d.cost].filter(Boolean).join(' · ');
    const MAX = 12, shownSteps = d.steps.slice(0, MAX);
    return (d.answer ? '<div class="dg-work-answer" data-dg-answer="' + esc(id) + '"></div>' : (d.live ? '<p class="dg-work-note">Still working — its answer lands here when it finishes.</p>' : '<p class="dg-work-note">It delivered no answer.</p>'))
      + '<div class="dg-receipt"><div class="dg-receipt-head"><span>What ' + esc(who) + ' did</span><span>' + esc(meta || (d.live ? 'working' : '')) + '</span></div>'
      + (shownSteps.length ? '<ol class="dg-receipt-steps">' + shownSteps.map(s => '<li class="' + (s.ok ? '' : 'bad') + '"><span>' + esc(cap(s.verb)) + '</span>' + (s.arg ? ' <b>' + esc(s.arg) + '</b>' : '') + (s.done ? '' : ' <i>…</i>') + '</li>').join('') + '</ol>'
        + (d.steps.length > MAX ? '<p class="dg-work-note">+ ' + (d.steps.length - MAX) + ' more step' + (d.steps.length - MAX === 1 ? '' : 's') + '</p>' : '')
        : '<p class="dg-work-note">No tools used — it answered from what it knew.</p>')
      + (d.sites.length ? '<div class="dg-receipt-row"><span class="k">Sites</span><span class="v">' + d.sites.length + ' opened · ' + esc(d.sites.map(s => s.host).join(', ')) + '</span></div>' : '')
      + (d.searches.length ? '<div class="dg-receipt-row"><span class="k">Searched</span><span class="v">' + esc(d.searches.slice(0, 3).map(q => '"' + q + '"').join(', ')) + '</span></div>' : '')
      + d.files.map((f, i) => '<div class="dg-receipt-row"><span class="k">' + (i ? '' : 'Files') + '</span><span class="v">' + esc(f.name) + '</span>'
        + '<button type="button" class="dg-key" data-dg-file="' + esc(f.path) + '" data-dg-agent="' + esc(f.agentId) + '" data-dg-project="' + esc(f.projectRoot) + '">Open</button></div>').join('')
      + '</div>';
  }
  // a worker's answer is untrusted output: rendered through COMMS' safe prose renderer, never raw HTML
  function hydrate(card) {
    card.querySelectorAll('[data-dg-answer]').forEach(el => {
      const rec = receipts.get(el.dataset.dgAnswer), text = rec && rec.data ? rec.data.answer : '';
      const ws = typeof Workstreams !== 'undefined' && Workstreams.get(el.dataset.dgAnswer);
      const agentId = (rec && rec.data && rec.data.agentId) || (ws && ws.agentId) || 'agent';
      const projectRoot = rec && rec.data && rec.data.projectRoot != null ? rec.data.projectRoot : (ws && ws.projectRoot) || '';
      const scope = 'delegated:' + el.dataset.dgAnswer + ':' + ((rec && rec.runId) || '') + ':' + agentId + ':' + projectRoot;
      if (typeof Chat !== 'undefined' && Chat.renderProse) {
        if (el.__proseSource !== text || el.__dgScope !== scope) Chat.renderProse(el, text, { files: Chat.workspaceFileRefs ? Chat.workspaceFileRefs(agentId, scope, projectRoot) : undefined });
        el.__dgScope = scope;
      } else el.textContent = text;
    });
  }
  function hydrateInspectors(card, parentId) {
    card.querySelectorAll('[data-dg-inspect]').forEach(host => {
      if (host.childNodes.length || typeof Chat === 'undefined' || !Chat.appendConsentDetails) return;
      const r = findRow(host.dataset.dgInspect), p = r && askOf(r, parentId);
      if (p && String(p.promptId) === host.dataset.dgPrompt) Chat.appendConsentDetails(host, p);
    });
  }
  function findRow(id) {
    if (typeof Workstreams === 'undefined') return null;
    for (const b of batches(Workstreams.activeId())) { const r = b.rows.find(x => x.ws.id === id); if (r) return Object.assign({ lead: b.lead }, r); }
    return null;
  }

  // a dispatch's card sits under the lead's reply to that ask: the first agent row stamped at/after the dispatch
  function anchorFor(log, at) {
    const rows = Array.from(log.querySelectorAll(':scope > .cmsg.agent[data-ts]'));
    const hit = rows.find(n => +n.dataset.ts >= at - 1500);
    if (!hit) return null;
    let n = hit; while (n.nextElementSibling && n.nextElementSibling.matches('.comms-presence.resolved, .run-fold')) n = n.nextElementSibling;
    return n;
  }

  function repaint() {
    const log = $log();
    if (!log || typeof Workstreams === 'undefined') return;
    const parentId = Workstreams.activeId();
    const list = batches(parentId);
    const keepKeys = new Set(list.map(b => b.lead));
    log.querySelectorAll(':scope > .dg-line').forEach(n => { if (n.dataset.dgParent !== parentId || !keepKeys.has(n.dataset.dgBatch)) n.remove(); });
    for (const b of list) {
      let card = Array.from(log.querySelectorAll(':scope > .dg-line')).find(n => n.dataset.dgBatch === b.lead);
      if (!card) {
        card = document.createElement('div'); card.className = 'dg-line'; card.dataset.dgBatch = b.lead; card.dataset.dgParent = parentId;
        card.setAttribute('role', 'group'); card.setAttribute('aria-label', 'Delegated work');
        const anchor = anchorFor(log, b.at);
        if (anchor) anchor.after(card); else log.appendChild(card);
      } else {
        // made before the lead's reply landed (appended at the end), it settles under that reply once it exists
        const anchor = anchorFor(log, b.at);
        if (anchor && anchor !== card && anchor.nextElementSibling !== card) anchor.after(card);
      }
      const html = lineHtml(b, parentId);
      if (card.dataset.dgHtml !== html) {
        // keep the key the Commander is on (the 1s clock repaints a live card)
        const focused = document.activeElement && card.contains(document.activeElement) ? document.activeElement : null;
        const focusKey = focused ? keyOf(focused) : '';
        const retained = new Map(Array.from(card.querySelectorAll('[data-dg-inspect], [data-dg-answer]')).map(n => [n.hasAttribute('data-dg-inspect') ? 'ask:' + n.dataset.dgPrompt : 'answer:' + n.dataset.dgAnswer, n]));
        card.innerHTML = html; card.dataset.dgHtml = html;
        card.querySelectorAll('[data-dg-inspect], [data-dg-answer]').forEach(n => {
          const old = retained.get(n.hasAttribute('data-dg-inspect') ? 'ask:' + n.dataset.dgPrompt : 'answer:' + n.dataset.dgAnswer);
          if (old) n.replaceWith(old);
        });
        if (focused && card.contains(focused) && focused.focus) focused.focus({ preventScroll: true });
        else if (focusKey) { const again = card.querySelector(focusKey); if (again && again.focus) again.focus({ preventScroll: true }); }
      }
      // Clock-only ticks never replace the reader's disclosure, text selection, images or focused controls.
      hydrate(card); hydrateInspectors(card, parentId);
      for (const r of b.rows) {
        const st = stateOf(r, parentId, b.lead), clockNode = Array.from(card.querySelectorAll('[data-dg-clock]')).find(n => n.dataset.dgClock === r.ws.id);
        if (clockNode) { const text = st.t && (st.cls === 'working' || st.cls === 'done') ? ' · ' + st.t : ''; if (clockNode.textContent !== text) clockNode.textContent = text; }
      }
      // an unfolded receipt of a worker still running refreshes itself (its transcript grows as it works)
      for (const r of b.rows) {
        const rec = receipts.get(r.ws.id);
        if (seen.has(r.ws.id) && (!rec || (rec.status === 'ok' && rec.data.live && Date.now() - rec.at > 3000) || (rec.runId && rec.runId !== workerRunOf(r)))) loadReceipt(r.ws.id);
      }
    }
    const anyLive = list.some(b => b.rows.some(r => (r.worker && r.worker.status === 'running') || (typeof Channels !== 'undefined' && Channels.isBusy && Channels.isBusy(r.ws.id))));
    // the clock tick rides CREW's own turn (CrewClock.atNextTurn: right after CREW paints, in the frame CREW and the world tag
    // turn in), a 1 s timer only where that clock is absent; repaint re-arms it while anything is live (ticker -1 = armed on CREW)
    if (anyLive && !ticker) {
      const gen = ++tickGen;
      const fire = () => { if (gen !== tickGen) return; ticker = 0; repaint(); };
      if (typeof CrewClock !== 'undefined' && CrewClock && typeof CrewClock.atNextTurn === 'function') { ticker = -1; CrewClock.atNextTurn(fire); }
      else ticker = setTimeout(fire, 1000);
    }
    if (!anyLive && ticker) { if (ticker > 0) clearTimeout(ticker); ticker = 0; tickGen++; }
    linkSavedFiles(parentId);
  }
  /* THE REPORT OPENS WHAT IT NAMES (live walk 10-14: the lead's "COPY finished: tagline.md is saved and ready to open." was
     plain text — the file it named could be opened only by finding this card). A file a worker of THIS conversation really
     saved (the worker ledger's own artifacts: /api/overseer workers[].files) becomes an Open link wherever a crew message
     here names it — the same door as the card's Open key (data-dg-file → Chat.openFile). Code, links, a longer name or a
     path that merely ends in the name stay text. */
  function savedFiles(parentId) {
    const out = new Map();
    const workers = parentId ? (snap().workers || []) : [];
    for (const w of (Array.isArray(workers) ? workers : [])) {
      if (!w || w.parentStreamId !== parentId || !Array.isArray(w.files)) continue;
      for (const f of w.files) {
        const p = String((f && f.path) || '').trim();
        if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.length > 240) continue;
        const entry = { path: p, agentId: String((f && f.agentId) || w.agentId || 'agent'), projectRoot: String(w.projectRoot || '') };
        out.set(p, entry);
        const base = p.split(/[\\/]/).pop();
        if (base && base !== p && !out.has(base)) out.set(base, entry);
      }
    }
    return out;
  }
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function linkMentions(body, files) {
    if (!body || !files || !files.size || typeof document === 'undefined') return;
    const names = Array.from(files.keys()).sort((a, b) => b.length - a.length);
    // a whole name: not inside a longer word or path, and a trailing "." only as the end of a sentence
    const re = new RegExp('(^|[^\\w./\\\\-])(' + names.map(reEsc).join('|') + ')(?=$|[^\\w./\\\\-]|\\.(?!\\w))', 'g');
    const fileLink = f => {
      const a = document.createElement('a');
      a.className = 'md-file dg-file-ref'; a.setAttribute('href', '#');
      a.setAttribute('data-dg-file', f.path); a.setAttribute('data-dg-agent', f.agentId); a.setAttribute('data-dg-project', f.projectRoot);
      a.setAttribute('data-tip', 'open ' + f.path);
      return a;
    };
    const visit = node => {
      for (const c of Array.from(node.childNodes || [])) {
        if (c.nodeType === 1) {
          // models backtick the files they name ("saved it to `tagline.md`"): an inline code span that IS a saved file's
          // name stays code-styled and becomes the link (the house rule for a code span that is a URL); any other code,
          // a fenced block, a link or a key is left alone
          const isCode = c.tagName === 'CODE' || (c.classList && c.classList.contains('md-code'));
          if (isCode && files.get(String(c.textContent || '').trim())) {
            const a = fileLink(files.get(String(c.textContent || '').trim()));
            node.insertBefore(a, c); node.removeChild(c); a.appendChild(c);
            continue;
          }
          if (!isCode && !/^(A|PRE|BUTTON)$/.test(c.tagName) && !(c.classList && (c.classList.contains('md-pre') || c.classList.contains('md-pre-wrap')))) visit(c);
          continue;
        }
        if (c.nodeType !== 3 || !c.nodeValue) continue;
        const v = c.nodeValue; let last = 0, m, hit = false;
        re.lastIndex = 0;
        while ((m = re.exec(v))) {
          const at = m.index + m[1].length, name = m[2], f = files.get(name);
          if (!f) continue;
          if (at > last) node.insertBefore(document.createTextNode(v.slice(last, at)), c);
          const a = fileLink(f);
          a.appendChild(document.createTextNode(name));
          node.insertBefore(a, c);
          last = at + name.length; hit = true;
        }
        if (!hit) continue;
        if (last < v.length) node.insertBefore(document.createTextNode(v.slice(last)), c);
        node.removeChild(c);
      }
    };
    visit(body);
  }
  const linkedBodies = new WeakMap();   // body -> the prose + file set it was last linked for (a repaint never re-walks it)
  function linkSavedFiles(parentId) {
    const log = $log();
    if (!log || !log.querySelectorAll) return;
    const files = savedFiles(parentId);
    if (!files.size) return;
    const sig = Array.from(files.keys()).join('\n');
    log.querySelectorAll('.cmsg.agent:not(.tool) > .body').forEach(body => {
      const src = typeof body.__proseSource === 'string' ? body.__proseSource : body.textContent;
      const was = linkedBodies.get(body);
      // a body re-rendered in place (same prose) lost its links: walk it again
      if (was && was.sig === sig && was.src === src && (!was.hits || (body.querySelector && body.querySelector('a.dg-file-ref')))) return;
      linkMentions(body, files);
      linkedBodies.set(body, { sig, src, hits: !!(body.querySelector && body.querySelector('a.dg-file-ref')) });
    });
  }
  function keyOf(el) {
    for (const a of ['data-dg-see', 'data-dg-stop', 'data-dg-toggle', 'data-dg-file', 'data-dg-question', 'data-dg-retry']) if (el.hasAttribute && el.hasAttribute(a)) return '[' + a + '="' + String(el.getAttribute(a)).replace(/["\\]/g, '\\$&') + '"]';
    if (el.hasAttribute && el.hasAttribute('data-dg-consent')) return '[data-dg-consent="' + el.getAttribute('data-dg-consent') + '"][data-dg-ws="' + String(el.getAttribute('data-dg-ws')).replace(/["\\]/g, '\\$&') + '"]';
    return '';
  }

  // open a dispatch and unfold one worker's work (a search hit, a deliverable or a "needs you" item landing here)
  function reveal(workerId) {
    const r = findRow(String(workerId || ''));
    if (!r) return false;
    opened.add(r.lead); closed.delete(r.lead); seen.add(r.ws.id);
    if (!receipts.has(r.ws.id)) loadReceipt(r.ws.id);
    repaint();
    const log = $log(), row = log && log.querySelector('[data-dg-row="' + String(r.ws.id).replace(/["\\]/g, '\\$&') + '"]');
    if (row && row.scrollIntoView) { if (typeof Chat !== 'undefined' && Chat.revealHistory) Chat.revealHistory(row); else row.scrollIntoView({ block: 'center' }); }
    return true;
  }

  async function stop(id, key) {
    if (stopping.has(id)) return;
    stopping.add(id); key.disabled = true; key.textContent = 'Stopping…';
    try {
      const r = await fetch('/api/subagents/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      let j = null; try { j = await r.json(); } catch (_) { j = null; }
      if (!r.ok || (j && j.ok === false)) throw new Error((j && j.error) || ('HTTP ' + r.status));
    } catch (e) {
      key.disabled = false; key.textContent = 'Stop';
      if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('Could not stop that worker: ' + e.message, 'warn', undefined, { kind: 'alert' });
    }
    if (typeof Overseer !== 'undefined' && Overseer.refresh) await Overseer.refresh();
    stopping.delete(id); repaint();
  }
  // answer a worker's ask from its row: the SAME answer path as the approval card (Chat.answerConsent), once or deny only
  // (Always / Full access are standing grants; a worker row grants only this request)
  /* NEVER A DEAD KEY (soak 10-15). A key whose ask this page no longer holds repaints the card to what the ask became, and
     an ask the STATION no longer holds (Chat.answerConsent rejects gone: answered on a surface whose word never reached this
     page, expired, or withdrawn) leaves the row saying its approval is no longer waiting — your answer was not applied —
     never "try again" on a key nothing can answer. A failed send (the station did not answer) keeps the keys. */
  function answer(wsId, decision, key) {
    const r = findRow(wsId); if (!r) { repaint(); return; }
    const p = askOf(r, Workstreams.activeId());
    if (!p || p.tool === 'brief.ask' || typeof Chat === 'undefined' || !Chat.answerConsent) { repaint(); return; }
    // the key answers the ask it was drawn for: if a different one is waiting now, show that one first, never answer it
    if (key && key.dataset && key.dataset.dgPrompt && String(p.promptId) !== key.dataset.dgPrompt) { repaint(); return; }
    const promptId = String(p.promptId); if (answering.has(promptId)) return;
    answering.add(promptId); key.disabled = true; repaint();
    const notify = (text) => { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(text, 'warn'); };
    Promise.resolve(Chat.answerConsent(p, Workstreams.get(Workstreams.activeId()), decision === 'deny' ? 'deny' : 'once', 'row'))
      .catch(e => {
        if (e && e.gone) { closedAsks.set(String(r.ws.id), promptId); notify((agentOf(r.ws.agentId || 'agent').name || 'The worker') + '\'s approval is no longer waiting — your answer was not applied'); return; }
        key.disabled = false; notify('Could not send that answer: ' + ((e && e.message) || e));
      })
      .then(() => { answering.delete(promptId); repaint(); });
  }

  function wire() {
    if (wired || typeof document === 'undefined') return; wired = true;
    document.addEventListener('click', e => {
      const t = e.target && e.target.closest ? e.target : null; if (!t) return;
      const s = t.closest('#chat-log [data-dg-stop]');
      if (s) { e.preventDefault(); stop(s.dataset.dgStop, s); return; }
      const q = t.closest('#chat-log [data-dg-question]');
      if (q) {
        e.preventDefault();
        // A question already has its real choices/free-text card in COMMS. Approve/Deny would resolve
        // its waiter without an answer; this key brings that exact card into view (drawing it again if needed).
        if (typeof Chat !== 'undefined' && Chat.revealAsk) Chat.revealAsk(q.dataset.dgQuestion);
        return;
      }
      const c = t.closest('#chat-log [data-dg-consent]');
      if (c) { e.preventDefault(); answer(c.dataset.dgWs, c.dataset.dgConsent, c); return; }
      const f = t.closest('#chat-log [data-dg-file]');
      if (f) {
        e.preventDefault();
        // a file name in prose is selectable text: ending a drag-selection over it is not an open (COMMS' SELECTION GUARD)
        if (f.tagName === 'A' && typeof window !== 'undefined' && window.getSelection && String(window.getSelection())) return;
        if (typeof Chat !== 'undefined' && Chat.openFile) Chat.openFile(f.dataset.dgFile, f.dataset.dgAgent, f.dataset.dgProject);
        return;
      }
      const retry = t.closest('#chat-log [data-dg-retry]');
      if (retry) { e.preventDefault(); receipts.delete(retry.dataset.dgRetry); loadReceipt(retry.dataset.dgRetry); repaint(); return; }
      const see = t.closest('#chat-log [data-dg-see]');
      if (see) {
        e.preventDefault(); const id = see.dataset.dgSee;
        if (seen.has(id)) seen.delete(id); else { seen.add(id); if (!receipts.has(id) || receipts.get(id).status === 'err') loadReceipt(id); }
        repaint(); return;
      }
      const tog = t.closest('#chat-log [data-dg-toggle]');
      if (tog) {
        e.preventDefault(); const k = tog.dataset.dgToggle;
        if (tog.getAttribute('aria-expanded') === 'true') { opened.delete(k); closed.add(k); } else { opened.add(k); closed.delete(k); }
        repaint();
      }
    });
    if (typeof U !== 'undefined' && U.bus && U.bus.on) {
      U.bus.on('agent.tool_call', p => { if (p && p.runId && p.name) { steps.set(String(p.runId), { name: String(p.name), args: String(p.argsSummary || '') }); } });
      U.bus.on('agent.run.end', p => { if (p && p.runId) steps.delete(String(p.runId)); });
      // a worker's ask arrives or is answered (here, on the phone, or by its timeout): its row changes state now
      U.bus.on('permission.prompt', () => repaint());
      U.bus.on('permission.response', () => Promise.resolve().then(repaint)); // pending-state listeners settle first
    }
  }

  // Chat.load calls this after it repaints a stream (the log is rebuilt, so the cards are re-placed)
  async function presentFor() { wire(); repaint(); }
  // does a card row in the open conversation host this worker's ask? (then the transcript draws no second approval card)
  function hosts(p) {
    if (!p || !(p.workerStreamId || p.workerRunId) || typeof Workstreams === 'undefined') return false;
    const parentId = Workstreams.activeId();
    // by promptId: the live event and the copy Channels holds are different objects for the same ask
    return batches(parentId).some(b => b.rows.some(r => { const a = askOf(r, parentId); return !!a && (a === p || (p.promptId != null && String(a.promptId) === String(p.promptId))); }));
  }

  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', wire);
  return { presentFor, repaint, batches, stateOf, reveal, hosts, staleLine, whyOf, tipOf, _internals: { workerRunOf, anchorFor, lineHtml, opened, closed, seen, receipts, foldReceipt, askOf, hydrate, loadReceipt, savedFiles, linkMentions } };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Delegated;
