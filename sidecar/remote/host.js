/* sidecar/remote/host.js — what each gateway verb actually does on this station.

   index.js builds this with the SAME in-process functions the desktop and the channels use (the roster, the
   transcript store, runOnce, the channel consent waiter, the deliverable library, the fs jail, the cron store),
   so a phone's answer is the desk's answer and nothing here re-implements station logic.

   Remote runs are DETACHED: they belong to the station, not to the phone's connection. A phone that drops,
   sleeps or changes network mid-run changes nothing; the run finishes, its transcript lands in the same
   conversation, and the phone catches up by reading the thread when it comes back. That is the difference
   from a desktop /api/run, whose run dies with its socket by design.

   Events a phone sees:
     run.started  { runId, agentId, streamId }
     run.text     { runId, text }                 the whole reply so far (the first frame, and every eighth)
     run.delta    { runId, at, add }              what it grew by from `at` (≤ ~4 per second). Its OWN type: a phone app from
                                                  before deltas ignores it (and catches up on the next whole frame) — as a
                                                  run.text it read the missing `text` and blanked the reply
     run.tool     { runId, callId, name, summary } a step the agent took
     run.step     { runId, callId, ok, ms }       how that step went
     run.ended    { runId, agentId, streamId, reason, usd, error, outcome, failureCode?, tone }   (outcome: RunOutcome's, review r7; tone:
                                                  RunOutcome.look's — ok · ask · stop · warn · bad — the phone's toast and row colour, review 9.3)
     approval.opened / approval.closed            from the shared registry
     station      { name, payload }               the station floor's own redacted feed (SSE tee) */
'use strict';
const SchedulerState = require('../scheduler-state.js');
const SteeringMessage = require('../../frontend/app/steering-message.js');

const { note } = require('../failopen.js');
const { withVoiceStyle } = require('./voice-style.js');
const { TaskIntent } = require('../../frontend/app/fork.js');   // the held-call stamp a phone step reads as "not run yet"
// TYPED OUTCOMES: a finished run's state on the phone is its recorded outcome, read through the ONE resolver every surface shares
const RunOutcome = require('../../frontend/app/runoutcome.js');
// TURN IDENTITY: the one turnId grammar, the phone host's mint ('ph' + runId) and the client time conversion
const TurnKinds = require('../../frontend/app/turnkinds.js');
const TurnMerge = require('../../frontend/app/turnmerge.js');
const TurnWindow = require('../turn-window.js');
const TurnView = require('../turn-view.js');   // the display view's forgotten side channel rides to the identity block (commit 11)

const TEXT_FLUSH_MS = 250;

function makeRemoteHost(d) {
  const now = d.now;
  if (typeof now !== 'function') throw new Error('makeRemoteHost needs an injected clock (deps.now)');
  const remoteRuns = new Map();   // runId -> { ac, agentId, streamId, deviceId, startedAt }
  const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
  const spriteSetOf = (skin) => { try { return (d.spriteSet && d.spriteSet(skin)) || ''; } catch (e) { note('remote.host.spriteSet', e); return ''; } };
  const broadcast = (evt) => { try { d.broadcast(evt); } catch (e) { note('remote.host.d.broadcast', e); } };

  function agentsList() {
    let looks = {};
    try { looks = (d.crewLooks && d.crewLooks()) || {}; } catch (e) { note('remote.host.crewLooks', e); looks = {}; }
    return d.roster().map(a => ({ agentId: a.agentId, name: a.name || a.agentId, model: a.model || null, provider: a.provider || null,
      skin: clip((looks[a.agentId] && looks[a.agentId].skin) || '', 40), color: clip((looks[a.agentId] && looks[a.agentId].color) || '', 16),
      // the sprite set its skin draws with, so a device can fetch its walk/type tracks with no desk page open
      sprite: clip(spriteSetOf((looks[a.agentId] && looks[a.agentId].skin) || ''), 40) }));
  }

  async function status() {
    const live = d.liveRuns();
    for (const [runId, r] of remoteRuns) if (!live.some(x => x.runId === runId)) live.push({ runId, agentId: r.agentId, startedAt: r.startedAt, source: 'remote' });
    const busy = new Map();
    for (const r of live) if (!busy.has(r.agentId)) busy.set(r.agentId, r);
    const agents = agentsList().map(a => {
      const r = busy.get(a.agentId);
      return Object.assign(a, r ? { state: 'working', runId: r.runId, since: r.startedAt, source: r.source || null } : { state: 'idle' });
    });
    return { station: d.stationName ? d.stationName() : 'StarNet', at: now(), agents, runs: live.map(r => ({ runId: r.runId, agentId: r.agentId, startedAt: r.startedAt, source: r.source || null })) };
  }

  /* SESSIONS. The desk keeps its sessions (title, agent, history) in the station save; the transcript store holds
     what runs wrote. A phone must see the SAME sessions the desk shows and continue them under the same id, so:
       · the list = the desk's sessions (save.workstreams) ∪ any transcript stream the desk has not adopted yet
       · a thread = the desk's history for that session, plus any newer turns the station recorded that the desk
         page has not merged yet (a phone turn sent while the desk was closed)
     The desk reconciles the other way on its own: opening a session merges the station's transcript into it. */
  const isProse = (m) => m && (m.role === 'user' || m.role === 'assistant') && !m.sys && typeof m.content === 'string' && m.content.trim();
  /* A FILE A RUN WROTE is a row of the thread too (turn identity, commit 10): the station's canonical file row (kind deliverable), shown to the
     phone as a display row with its `deliverable` field and never as prose. Only the thread asks for it; every replay array (the legacy
     window a send hands the model, the previews, the activity feed) keeps filtering with isProse, so a file row never reaches a model. */
  const isFileRow = (m) => !!m && m.role === 'system' && m.kind === 'deliverable' && !!TurnMerge.deliverableOf(m);
  /* A NOTE THE RUN READ is a row of the thread too (commit 10): the station's canonical steer row (kind steer, the Commander's words),
     shown as a display row and, outside the rollback window, replayed to the model as the user line '[steering] <words>' that the
     station's own replay makes of it. Never prose of the agent's. keeps(true) is the thread (prose, file rows, steer rows); keeps('steer')
     is a replay window outside window:legacy (prose and steer rows); anything else is prose only, byte for byte as before. */
  const isSteerRow = (m) => !!m && m.role === 'system' && m.kind === 'steer' && typeof m.content === 'string' && !!m.content.trim();
  const keeps = (more) => (more === true ? (m) => isProse(m) || isFileRow(m) || isSteerRow(m) : more === 'steer' ? (m) => isProse(m) || isSteerRow(m) : isProse);
  const steerLine = (m) => (isSteerRow(m) ? Object.assign({}, m, { role: 'user', content: m.content.startsWith('[steering] ') ? m.content : '[steering] ' + m.content }) : m);
  // the window mode the phone's replay is built under ('legacy' = the rollback: today's bytes, no note rows, no split)
  const windowMode = () => { try { return d.turnDual && typeof d.turnDual.modes === 'function' ? d.turnDual.modes().window : 'legacy'; } catch (e) { note('remote.host.windowMode', e); return 'legacy'; } };
  function deskSessions() {
    let list = [];
    try { list = (d.deskSessions && d.deskSessions()) || []; } catch (e) { note('remote.host.deskSessions', e); list = []; }
    return Array.isArray(list) ? list.filter(w => w && typeof w.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(w.id) && !w.archived && w.conversationMode !== 'group' && w.worker !== true) : [];
  }
  // a delegated worker's own thread is the asking conversation's record, never a phone thread of its own
  function workerStreams() {
    try { return new Set(((d.workerThreadIds && d.workerThreadIds()) || []).map(String)); }
    catch (e) { note('remote.host.workerThreads', e); return new Set(); }
  }
  const STATION_TURNS = 2000;
  function stationTurns(streamId, limit, more) {
    try {
      const rows = d.transcript.view('display', streamId, { limit: limit || STATION_TURNS }) || [];
      const kept = rows.filter(keeps(more));
      // the rows the quote rule hid ride along (non-enumerable), so the merge below drops this phone's cached copies of them (TurnMerge R2/R4)
      if (rows[TurnView.FORGOTTEN]) Object.defineProperty(kept, TurnView.FORGOTTEN, { value: rows[TurnView.FORGOTTEN], enumerable: false });
      return kept;
    }
    catch (e) { note('remote.host.stationTurns', e); return []; }
  }
  /* ONE CONVERSATION, TWO COPIES: the desk's save (its own order, its status lines) and the station's transcript
     (every turn any run recorded, from the desk, the phone, a channel). A phone used to take the desk copy and add
     only station turns NEWER than its last line — so once the desk saved anything later, every phone turn before it
     vanished ("session history disappears", Andrew 10-02 on the road). Now the phone merges exactly the way the desk
     does (frontend/app/chat.js mergeCanonicalHistory, copied here; keep the two in step): the desk's rows keep their
     order, a station turn with a twin enriches it, and a turn the desk never saw is inserted after the last row a
     station turn matched. Nothing is dropped and nothing is reordered. */
  function mergeCanonical(local, turns, identity) {
    const legacy = () => TurnMerge.legacyWithIdentity(local.map(r => r && typeof r.content === 'string' ? Object.assign({}, r, { content: redactText(r.content) }) : r), turns, identity);
    if (!d.turnDual || !identity) return legacy();
    return d.turnDual.pick('merge', legacy, () => {
      const next = TurnMerge.merge(local, turns, { identity, cap: STATION_TURNS, legacyKey: redactText });
      const diff = TurnMerge.compare(legacy(), next.rows);
      if (!diff.same) d.turnDual.record('merge', { streamId: identity.streamId, classes: diff.classes.concat(next.report.classes) });
      return next.rows;
    });
  }
  // the whole conversation, prose only, oldest first
  /* The desk save is raw; the station transcript is redacted when it is written. Redact the desk copy first, so a turn holding a
     secret-shaped token is ONE turn (the two copies' keys match) and its raw text never reaches the relay. */
  const redactText = (t) => { try { return typeof d.redact === 'function' ? String(d.redact(String(t))) : String(t); } catch (e) { note('remote.host.redact', e); throw e; } };
  // limit: the newest N turns (a phone SEND hands the model at most 100, as it always did; a page reads them all); more: true keeps the
  // station's file and steer rows too (the thread asks; nothing that feeds a model does), 'steer' keeps its steer rows (a replay window
  // outside the rollback mode)
  function mergedTurns(streamId, limit, more) {
    const w = deskSessions().find(x => x.id === streamId);
    const local = w && Array.isArray(w.history) ? w.history : [];
    const st = stationTurns(streamId, undefined, more);
    const projection = typeof d.turnProjection === 'function' ? d.turnProjection(streamId, st) : { turns: st, identity: null };
    const ids = [...new Set(local.filter(row => row && row.idFrom !== 'collision' &&
      (!row.streamId || row.streamId === streamId) && Number.isSafeInteger(row.rowId) && row.rowId > 0).map(row => row.rowId))];
    if (ids.length) {
      const proof = typeof d.transcript.cacheRetractions === 'function' && d.transcript.cacheRetractions(streamId, ids);
      if (!proof || proof.state !== 'done') throw new Error('Cached transcript identity could not be proved');
      const retracted = new Set(proof.retracted);
      projection.turns = projection.turns.filter(row => !retracted.has(row.rowId));
      projection.identity = Object.assign({ streamId }, projection.identity, { retracted: proof.retracted });
    }
    const all = SteeringMessage.displayRows(mergeCanonical(local, projection.turns, projection.identity)).filter(keeps(more)).map(r => Object.assign({}, r, { content: redactText(r.content) }, typeof r.typed === 'string' ? { typed: redactText(r.typed) } : null));
    return Number(limit) > 0 ? all.slice(-Number(limit)) : all;
  }
  const lastUserLine = (turns) => { for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === 'user') return clip(turns[i].content.replace(/\s+/g, ' ').trim(), 140); return ''; };

  async function threads(o) {
    const out = [], seen = new Set();
    const names = new Map(agentsList().map(a => [a.agentId, String(a.name || '').toLowerCase()]));
    const rows = d.transcript.view('display', null, { op: 'streams', limit: 500, previewChars: 140 }) || [];
    const stationHas = new Set(rows.filter(r => Number(r.turns) > 0).map(r => r.streamId));
    const workers = workerStreams();
    const sessions = deskSessions(), candidates = [], seenKeys = new Set();
    for (const w of sessions) {
      if (o.agentId && String(w.agentId || 'agent') !== o.agentId) continue;
      for (const row of (Array.isArray(w.history) ? w.history : []).filter(isProse)) {
        if (row.idFrom === 'collision' || (row.streamId && row.streamId !== w.id) || !Number.isSafeInteger(row.rowId) || row.rowId <= 0) continue;
        const key = JSON.stringify([w.id, row.rowId]);
        if (!seenKeys.has(key)) {
          seenKeys.add(key); candidates.push({ streamId: w.id, rowId: row.rowId });
          if (candidates.length > 2000) throw new Error('Cached thread-list identity exceeds its proof capacity');
        }
      }
    }
    let retracted = new Set();
    if (candidates.length) {
      const proof = typeof d.transcript.cacheRetractionsBatch === 'function' && d.transcript.cacheRetractionsBatch(candidates);
      if (!proof || proof.state !== 'done') throw new Error('Cached thread-list identity could not be proved');
      retracted = new Set(proof.retracted.map(row => JSON.stringify([row.streamId, row.rowId])));
    }
    for (const w of sessions) {
      const agentId = String(w.agentId || 'agent');
      const hist = Array.isArray(w.history) ? w.history.filter(row => isProse(row) &&
        ((row.streamId && row.streamId !== w.id) || !retracted.has(JSON.stringify([w.id, row.rowId])))) : [];
      seen.add(w.id);
      if (o.agentId && agentId !== o.agentId) continue;
      // an untouched blank session (no title, or only the agent's own name as one, and nothing recorded anywhere) is
      // noise on a phone; one whose turns live only in the station's record (the desk never opened it since) is not
      if (!hist.length && !stationHas.has(w.id) && (!w.title || String(w.title).trim().toLowerCase() === (names.get(agentId) || agentId.toLowerCase()))) continue;
      out.push({ streamId: w.id, agentId, title: w.title ? clip(w.title, 80) : '', turns: hist.length, lastAt: Number(w.lastActiveAt) || 0, preview: lastUserLine(hist), source: 'desk' });
    }
    for (const r of rows) {
      if (seen.has(r.streamId)) {   // the station may have newer turns than the desk save: surface the later time
        const row = out.find(x => x.streamId === r.streamId);
        if (row && Number(r.lastAt) > row.lastAt) { row.lastAt = Number(r.lastAt); if (r.preview) row.preview = r.preview; }
        continue;
      }
      if (r.streamId === 'global' || /^(cron|nightshift|workshop)-/.test(r.streamId) || workers.has(r.streamId)) continue;   // background work has its own surfaces
      let agentId = r.agentId || '';
      if (!agentId) { try { const h = d.transcript.view('display', r.streamId, { limit: 1 }); agentId = (h[0] && h[0].agentId) || ''; } catch (e) { note('remote.host.threadAgent', e); } }
      if (o.agentId && agentId !== o.agentId) continue;
      out.push({ streamId: r.streamId, agentId, title: '', turns: r.turns, lastAt: r.lastAt, preview: r.preview || '', source: /^remote_/.test(r.streamId) ? 'phone' : 'station' });
    }
    out.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    return out.slice(0, o.limit).map(r => Object.assign({}, r, { title: redactText(r.title), preview: redactText(r.preview) }));
  }

  /* A PAGE OF A CONVERSATION: the newest `limit` turns before the newest `before` ones, within a byte budget so it
     always fits one sealed frame through the relay. A phone that asks for pages ({ page: true }) is also told how
     many older turns remain, and pulls them with SHOW EARLIER, so a long conversation is never cut off. */
  const THREAD_BUDGET = 180 * 1024;
  async function thread(o) {
    const all = mergedTurns(o.streamId, undefined, true);
    const cursor = Number(o.beforeRowId);
    const cursorAt = Number.isSafeInteger(cursor) && cursor > 0 ? all.findIndex(r => r.streamId === o.streamId && r.rowId >= cursor) : -1;
    const end = cursorAt >= 0 ? cursorAt : Number.isSafeInteger(cursor) && cursor > 0 ? all.length : Math.max(0, all.length - (Number(o.before) || 0));
    const rows = all.slice(Math.max(0, end - (o.limit || 60)), end).map(r => Object.assign({ role: r.role, agentId: r.agentId || null, ts: r.ts || null, content: clip(r.content, 20000) }, TurnMerge.idsOf(r), typeof r.typed === 'string' ? { typed: clip(r.typed, 20000) } : null, isFileRow(r) ? { deliverable: TurnKinds.deliverableFields(r.deliverable) } : null, isSteerRow(r) && r.noteId ? { noteId: r.noteId } : null));
    let used = 0, keep = rows.length;
    for (let i = rows.length - 1; i >= 0; i--) { used += Buffer.byteLength(JSON.stringify(rows[i])) + 1; if (used > THREAD_BUDGET && i < rows.length - 1) break; keep = i; }
    const page = rows.slice(keep);
    if (!o.page) return page;
    // A legacy local row at the seam has no identity cursor. Keep the offset fallback for that page; jumping to a
    // later keyed row would repeat the local prefix in the next page.
    const firstKeyed = page[0] && page[0].streamId === o.streamId && Number.isSafeInteger(page[0].rowId) && page[0].rowId > 0 ? page[0] : null;
    return { turns: page, earlier: end - page.length, total: all.length, beforeRowId: firstKeyed ? firstKeyed.rowId : null };
  }

  // what the desk needs to show a phone conversation as one of its own sessions (GET /api/remote/recent)
  const recent = [];   // newest last, bounded
  function noteRecent(row) {
    const i = recent.findIndex(x => x.runId === row.runId);
    if (i >= 0) recent[i] = Object.assign(recent[i], row); else recent.push(row);
    while (recent.length > 60) recent.shift();
  }
  function recentRuns() { return recent.slice().reverse(); }

  async function send(o) {
    const who = agentsList().find(a => a.agentId === o.agentId);
    if (!who) return { ok: false, error: 'there is no agent called ' + o.agentId + ' on this station' };
    const cred = d.credentials(o.agentId);
    if (!cred || !cred.ok) return { ok: false, error: (cred && cred.error) || 'this agent has no model set up yet' };
    const streamId = o.streamId || ('remote_' + String(o.agentId).replace(/[^A-Za-z0-9_-]/g, '_') + '_' + now().toString(36)).slice(0, 64);
    const runId = d.newId();
    // this phone turn's id: the phone's own (a relay resend stays one turn), else this run's ('ph' + runId, never looked up)
    const turnId = TurnKinds.isTurnId(o.turnId) ? o.turnId : TurnKinds.phoneTurnId(runId);
    const ac = new AbortController();
    const rec = { ac, agentId: o.agentId, streamId, deviceId: o.deviceId || '', startedAt: now() };

    // the conversation so far: the desk's memory of this session plus anything the station recorded since
    // Outside the rollback window (A2-REB-1) a reply the Commander steered is never replayed with the note inside the agent's message:
    // it is split at its notes (TurnMerge.splitSteer, the one helper the desk's window uses), and the station's own steer rows ride as
    // the user lines they replay as. window:legacy keeps today's rows byte for byte.
    const legacyRows = (windowMode() === 'legacy' ? mergedTurns(streamId, 100) : TurnMerge.splitSteer(mergedTurns(streamId, 100, 'steer').map(steerLine))).map(m => ({ role: m.role, content: m.content }));
    const legacyReplay = () => legacyRows;   // one cache-authority proof serves this comparison and selection
    const replay = () => d.transcript.view('model-replay', streamId, { limit: 100, shape: 'prose', form: 'pre', forAgent: o.agentId });
    const prior = d.turnDual ? d.turnDual.pick('window', legacyReplay, () => {
      const canonical = replay();
      d.turnDual.record('window', Object.assign({ caller: 'phone', streamId, runId }, TurnWindow.compare(legacyReplay(), canonical, streamId)));
      return canonical;
    }) : replay();
    const messages = prior.concat([{ role: 'user', content: o.text }]);
    let isTask = true;
    // the agent's last turn rides along, as on COMMS and the channels: "yes" to "want me to draft it?" is a TASK (tools),
    // not chat that can only promise (sweep 2026-10-02)
    let priorAgentTurn = '';
    for (let i = messages.length - 2; i >= 0; i--) if (messages[i] && messages[i].role === 'assistant') { priorAgentTurn = String(messages[i].content || ''); break; }
    try { if (typeof d.classify === 'function') isTask = !!d.classify(o.text, { priorAgentTurn }); } catch (e) { note('remote.host.classify', e); }
    // An unproven history rejects before acceptance. It must not leave a live phone run whose
    // runOnce/finally was never scheduled (including a failed affirmative cache-removal proof).
    remoteRuns.set(runId, rec);
    noteRecent({ runId, agentId: o.agentId, streamId, title: clip(o.text.replace(/\s+/g, ' ').trim(), 80), startedAt: rec.startedAt, endedAt: null, live: true });

    // the reply, coalesced: a phone on cellular gets a few frames a second, not one per token
    let buf = '', timer = null, errMsg = null, errCode = '', reason = null, usd = 0, end = null;   // end: the lead's own agent.run.end, as stamped
    /* The reply only GROWS, so a frame carries only what is new (and where it starts): resending the whole reply four
       times a second made a long answer cost its full size every quarter second on the station's uplink. Every eighth
       frame (two seconds) is the whole text again, so a phone that missed a piece is put right at once. */
    let sent = 0, flushes = 0;
    const flush = () => {
      timer = null;
      const full = clip(buf, 20000);
      flushes += 1;
      if (sent > 0 && full.length >= sent && flushes % 8) { if (full.length > sent) broadcast({ type: 'run.delta', runId, at: sent, add: full.slice(sent) }); }
      else broadcast({ type: 'run.text', runId, text: full });
      sent = full.length;
    };
    const emit = (name, payload) => {
      const p = payload || {};
      // a delegated worker's lifecycle rides the lead's emit (orchestration forwards it): a worker that errored and
      // was recovered from must not turn THIS run's phone result red — the same runId filter harness.js applies.
      if ((name === 'agent.run.error' || name === 'agent.run.end') && p.runId && p.runId !== runId) return;
      if (name === 'agent.token') { buf += (p.delta || ''); if (!timer) timer = setTimeout(flush, TEXT_FLUSH_MS); }
      else if (name === 'agent.tool_call') { buf = ''; sent = 0; broadcast({ type: 'run.tool', runId, callId: String(p.callId || ''), name: clip(p.name, 80), summary: clip(p.argsSummary, 400) }); }
      else if (name === 'agent.tool_result') {
        // a call the Task Brief held did NOT run: never a ✕ failed step on the phone (fork.js TaskIntent.GATE_HELD)
        const held = TaskIntent.isGateHeld(p);
        broadcast(Object.assign({ type: 'run.step', runId, callId: String(p.callId || ''), ok: held ? null : (!!p.ok && !p.isError), ms: Number(p.ms) || 0 }, held ? { held: true } : {}));
      }
      else if (name === 'agent.run.error') { errMsg = clip(p.message || 'run error', 400); errCode = String(p.failureCode || ''); }
      else if (name === 'agent.run.end') { reason = p.reason || null; end = p; if (typeof p.usd === 'number' && isFinite(p.usd)) usd = Math.max(usd, p.usd); }
    };
    const prompt = (call, tool) => d.askConsent({ agentId: o.agentId, runId, signal: ac.signal, call, tool, surface: 'remote', onPrompt: () => {} });

    broadcast({ type: 'run.started', runId, agentId: o.agentId, streamId, turnId });
    // setImmediate, not a microtask: runOnce does a second or more of synchronous set-up before its first await,
    // and the phone's "accepted" reply must leave first (measured: the ack took 1.3 s behind a microtask start).
    new Promise((resolve) => setImmediate(resolve)).then(() => d.runOnce({
      key: cred.key, model: cred.model, provider: cred.provider, baseUrl: cred.baseUrl || '', reasoningEffort: cred.reasoningEffort, wireSource: cred.wireSource,
      system: o.voice ? withVoiceStyle(cred.system) : cred.system, messages, agentId: o.agentId, isTask,
      // the persona (host credentials()) carries only its standing half; the station's observed evidence rides this run's
      // context note (a phone task's brief already carries it, so the host adds it only to a run without one)
      stationEvidence: true,
      voiceTurn: o.voice === true || undefined,   // a question spoken on a voice-only device is a voice turn: the voice chat model may answer it
      emit, signal: ac.signal, runId, streamId, trigger: 'event',
      // the phone's elapsed time since the turn's first submission, from the station's now (a phone clock's offset cancels)
      turnId, ...TurnKinds.clientTurnTime(o, now()), turnRowId: (Number.isSafeInteger(o.turnRowId) && o.turnRowId > 0) ? o.turnRowId : undefined,
      surface: 'interactive', prompt, ownerTrusted: true, floorless: true, broadcast: true, reflect: true,
      // A PHONE WORKS WITH THE DESK'S PERMISSIONS (Andrew 2026-10-02: "full access so I can vibe code on the go"): an
      // agent on Full Access acts from the phone without asking, exactly as at the desk. A phone the Commander marked
      // ALWAYS ASK (desk > Remote > that phone) never inherits Full Access or the station bypass: every gated step asks
      // on the phone. Host-minted, never from text, and it rides into delegated workers (run-origin.js). If the
      // setting cannot be read, the phone asks (never more power on an error).
      connectorAuthority: { withholdHostPower: phoneAsksFirst(o.deviceId) },
      taskKey: 'remote:' + (o.deviceId || 'phone'), taskSource: 'remote'
    })).catch((e) => { errMsg = errMsg || clip((e && e.message) || e, 400); })
      .finally(() => {
        if (timer) { clearTimeout(timer); flush(); }
        remoteRuns.delete(runId);
        // TYPED OUTCOMES: ok only when the run SUCCEEDED (a provider-cut 'done', a spending or step limit is not ok), and the ended
        // reason reads its outcome (RunOutcome.reasonOf: 'cut_short'); a run that never reported its end is an error, never 'done'
        noteRecent({ runId, endedAt: now(), live: false, ok: !errMsg && !!end && RunOutcome.ofEnd(end, null).ok });
        // (additive, review r7) the run's ONE outcome rides beside its reason (the lead's own end and error, RunOutcome.ofEnd; a run aborted
        // before its end was stopped): the phone push (index.js remoteNotify) said "finished" for any end that raised no error event
        const oc = end ? RunOutcome.ofEnd(end, errMsg ? { failureCode: errCode } : null)
          : (ac.signal.aborted && !errMsg ? { outcome: 'stopped', failureCode: '' } : RunOutcome.ofEnd(null, errMsg ? { failureCode: errCode } : null));
        broadcast(Object.assign({ type: 'run.ended', runId, agentId: o.agentId, streamId, reason: reason ? RunOutcome.reasonOf(end) : (ac.signal.aborted ? 'stopped' : 'error'), usd, error: errMsg, outcome: oc.outcome, tone: RunOutcome.look(oc).tone },
          oc.failureCode ? { failureCode: oc.failureCode } : null));
      });
    return { runId, streamId };
  }

  async function stop(o) {
    const r = remoteRuns.get(o.runId);
    if (r) { try { r.ac.abort(); } catch (e) { note('remote.host.r.ac.abort', e); } return { ok: true }; }
    return d.stopRun(o.runId) ? { ok: true } : { ok: false, error: 'that run is not running' };
  }

  async function files(o) {
    let rows = await d.deliverables();
    if (o.query) rows = rows.filter(r => [r.title, r.summary, r.ask, r.agentId].join(' ').toLowerCase().indexOf(o.query) >= 0);
    rows = rows.slice().sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)).slice(0, o.limit);
    return rows.map(r => ({
      id: r.id, title: r.title || null, kind: r.kind || null, status: r.status || null, agentId: r.agentId || null, createdAt: r.createdAt || null,
      summary: clip(r.summary, 300),
      files: (Array.isArray(r.files) ? r.files : []).slice(0, 20).map(f => ({ path: f.path, bytes: Number.isFinite(f.bytes) ? f.bytes : null }))
    }));
  }

  /* A PHONE READS WHAT THE STATION SHOWED IT, nothing else: a file inside that agent's own workspace (a relative
     path), or a file outside it only when one of that agent's runs or deliverables recorded it (the file chips the
     phone was given). A free-form absolute path is refused even under a folder the agents may use at the desk. */
  const isAbsPath = (p) => /^([A-Za-z]:|[\\/])/.test(String(p || ''));
  async function shownPaths(agentId) {
    const set = new Set();
    let rows = [];
    try { rows = (d.runHistory && d.runHistory(300)) || []; } catch (e) { note('remote.host.shownRuns', e); rows = []; }
    for (const r of rows) {
      if (!r || r.agentId !== agentId) continue;
      for (const a of Array.isArray(r.artifacts) ? r.artifacts : []) if (a && a.path) set.add(String(a.path).slice(0, 300));
      if (r.deliverable && r.deliverable.main) set.add(String(r.deliverable.main).slice(0, 300));
    }
    let dl = [];
    try { dl = (await d.deliverables()) || []; } catch (e) { note('remote.host.shownDeliverables', e); dl = []; }
    for (const r of dl) if (r && r.agentId === agentId) for (const f of Array.isArray(r.files) ? r.files : []) if (f && f.path) set.add(String(f.path));
    return set;
  }
  function phoneAsksFirst(deviceId) {
    if (typeof d.phoneAsksFirst !== 'function') return true;   // no way to read the setting = the phone asks (never more power on a missing wire)
    try { return d.phoneAsksFirst(deviceId) === true; } catch (e) { note('remote.host.phoneAsksFirst', e); return true; }
  }
  async function fetchFile(o) {
    if (!agentsList().some(a => a.agentId === o.agentId)) return { ok: false, error: 'unknown file' };   // never make a folder for a made-up agent
    if (isAbsPath(o.path) && !(await shownPaths(o.agentId)).has(String(o.path))) return { ok: false, error: 'unknown file' };
    return d.readFile(o.agentId, o.path, o.offset, o.length);
  }

  /* THE SCHEDULER'S OWN STATE (quick win 30, bug 96dcbade): a routine's switch says nothing about whether the station is
     scheduling at all. With scheduling OFF or the E-STOP engaged no routine fires, so each row says it is `held` ('off' /
     'halted') and the phone shows neither a live dot nor a cadence for it. null = scheduling is on; absent = the host was
     not told (never a guess either way). */
  function schedulerHold() {
    if (typeof d.scheduler !== 'function') return undefined;
    let s = null;
    try { s = d.scheduler(); } catch (e) { note('remote.host.scheduler', e); return undefined; }
    if (!s || typeof s !== 'object') return undefined;
    return SchedulerState.holdOf(s);
  }
  async function routines() {
    const held = schedulerHold();
    return (d.routines() || []).map(j => Object.assign({
      id: j.id, name: j.name || null, agentId: j.agentId || null, enabled: j.enabled !== false, inFlight: !!j.inFlight,
      schedule: j.scheduleDisplay || (j.schedule && (j.schedule.display || j.schedule.kind)) || null,
      // a fire someone STOPPED reads 'stopped' (review r7), never 'error' — an older record kept 'error' beside its outcome 'stopped'
      nextRunAt: Object.prototype.hasOwnProperty.call(j, 'nextFireAt') ? j.nextFireAt :
        (held || j.enabled === false ? null : j.nextRunAt || null),
      lastRunAt: j.lastRunAt || null, lastStatus: (j.lastStatus === 'error' && j.lastOutcome === 'stopped') ? 'stopped' : (j.lastStatus || null),
      prompt: clip(j.prompt, 200)
    }, held === undefined ? null : { held: held }));
  }

  /* A phone set to ALWAYS ASK may pause a routine but never switch one back on: a resumed routine fires later under the
     agent's standing (Full Access) authority, which that phone is not allowed to hand out — the same line
     run-origin.js standingWorkEscalates draws for tool calls (QA 2026-10-02). */
  async function setRoutine(o) {
    if (o.enabled === true && phoneAsksFirst(o.deviceId)) return { ok: false, error: 'this phone is set to ALWAYS ASK, so it can pause routines but not switch them back on — turn it on at the desk' };
    return d.setRoutine(o.jobId, o.enabled);
  }

  /* A REMOVED phone's work stops with it: revoking a phone (a lost or stolen one) aborts every run it started, which
     otherwise kept going with whatever permissions it began with (QA 2026-10-02). Returns how many it stopped. */
  function stopDevice(deviceId) {
    const id = String(deviceId || '');
    if (!id) return 0;
    let n = 0;
    for (const r of remoteRuns.values()) if (r.deviceId === id) { try { r.ac.abort(); n += 1; } catch (e) { note('remote.host.stopDevice', e); } }
    return n;
  }

  /* THE STATION VIEW. The desk page draws the still (the sidecar has no renderer); this hands it to a phone in
     sealed chunks and notes that a phone is looking, which is what makes the desk keep it fresh. The phone gets
     the time the desk drew it and shows that age: an old picture is never passed off as live. */
  async function view(o) {
    if (!d.view) return { none: true, now: now() };
    d.view.want(o.deviceId);
    const m = d.view.meta();
    let desk = false;
    try { desk = !!(d.deskOpen && d.deskOpen()); } catch (e) { note('remote.host.deskOpen', e); }
    if (!m) return { none: true, desk, now: now() };
    // `now` is this station's clock at the moment of the answer: the phone works out the picture's age from
    // (now - at), so a phone whose own clock is off still shows the right age
    if (!o.offset && o.have && o.have === m.at) return { at: m.at, checked: m.checkedAt || m.at, now: now(), same: true, crewPaused: !!m.crewPaused };
    if (o.offset && o.at !== m.at) return { at: m.at, now: now(), changed: true };   // the desk drew a newer one mid-read: start over
    const buf = d.view.read(o.offset, o.length);
    const out = { at: m.at, now: now(), w: m.w, h: m.h, mime: m.mime, size: m.size, offset: o.offset, bytes: buf.length, eof: o.offset + buf.length >= m.size, data: buf.toString('base64') };
    if (!o.offset) { out.checked = m.checkedAt || m.at; out.crewPaused = !!m.crewPaused; out.bodies = m.bodies; out.crewFree = !!m.crewFree; out.scale = m.scale || 0; out.crew = d.view.crew ? d.view.crew() : null; }
    return out;
  }

  // an agent's own sprite (the same art the desk's crew list shows), so the phone draws the real crew
  async function portrait(o) {
    const a = agentsList().find(x => x.agentId === o.agentId);
    if (!a || !d.portrait) return { ok: false, error: 'unknown agent' };
    const p = d.portrait(a.skin);
    return p ? { agentId: a.agentId, skin: p.skin, mime: p.mime, data: p.data } : { ok: false, error: 'no portrait' };
  }

  // every drawing of one sprite track, so the phone can draw a crew member exactly as the stage does
  async function sprite(o) {
    const t = d.sprites ? d.sprites(o.key) : null;
    return t ? t : { ok: false, error: 'unknown sprite' };
  }

  /* ACTIVITY: the station's work in one list, newest first — what is running now (and what the phone knows of its
     steps), then what finished, with its result line and the files it made. Background self-talk is left out.
     It reads the same run history the desk's activity feed reads; nothing here is inferred. */
  async function activity(o) {
    const live = (await status()).runs.map(r => {
      const rec = recent.find(x => x.runId === r.runId);
      return { runId: r.runId, agentId: r.agentId, state: 'working', startedAt: r.startedAt || null, source: r.source || null,
        title: rec ? rec.title : '', streamId: rec ? rec.streamId : (r.streamId || '') };
    });
    let rows = [];
    try { rows = (d.runHistory && d.runHistory(o.limit + 20)) || []; } catch (e) { note('remote.host.runHistory', e); rows = []; }
    const liveIds = new Set(live.map(r => r.runId));
    const done = [], resultOf = new Set();
    for (const r of rows) {
      if (!r || r.internal || r.parentRunId || liveIds.has(r.runId)) continue;
      const files = [];
      for (const a of Array.isArray(r.artifacts) ? r.artifacts : []) if (a && a.path && files.length < 6) files.push(String(a.path).slice(0, 300));
      if (r.deliverable && r.deliverable.main && files.indexOf(r.deliverable.main) < 0 && files.length < 6) files.push(String(r.deliverable.main).slice(0, 300));
      let said = String(r.deliveryText || (r.deliverable && r.deliverable.summary) || '').replace(/\s+/g, ' ').trim();
      /* THE ROW'S OUTCOME (typed-outcomes, 2026-10-29), not its bare reason: a reply the provider cut is not 'done', a thrown run
         names no_terminal_outcome, and a stop reads in words ("reached the step limit"), never a raw reason code. A question
         the run asked shows as its result. */
      const oc = RunOutcome.ofRow(r);
      const state = (oc.outcome === 'succeeded' || oc.outcome === 'asked') ? 'done' : oc.outcome === 'stopped' ? 'stopped' : 'failed';
      // a conversational reply has no delivery note: its result line is the newest reply in that conversation (only
      // the newest finished run of a conversation is shown against it, so that is this run's own reply)
      if (!said && state === 'done' && r.streamId && !resultOf.has(r.streamId)) {
        resultOf.add(r.streamId);
        const turns = stationTurns(r.streamId, 6);
        for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === 'assistant') { said = turns[i].content.replace(/\s+/g, ' ').trim(); break; }
      }
      // (review 9.3) the outcome's TONE rides beside the three-state contract: the phone painted every unfinished run the failure red under
      // "Did not finish", a failure's own words, reading the state alone
      done.push({ runId: r.runId, agentId: r.agentId, state, outcome: oc.outcome, tone: RunOutcome.look(oc).tone, ...(oc.failureCode ? { failureCode: oc.failureCode } : {}),
        title: clip(String(r.sessionTitle || r.title || '').replace(/\s+/g, ' ').trim(), 140), result: clip(said, 240),
        error: state === 'done' ? '' : clip(oc.outcome === 'failed' ? oc.failureCode : RunOutcome.line(oc), 80),
        startedAt: r.startedAt || null, endedAt: r.endedAt || null, usd: Number(r.usd) || 0, streamId: r.streamId || '', files });
      if (done.length >= o.limit) break;
    }
    return { at: now(), live, done };
  }

  function liveRemoteRuns() { return Array.from(remoteRuns, ([runId, r]) => ({ runId, agentId: r.agentId, startedAt: r.startedAt, source: 'remote' })); }

  return { status, threads, thread, send, stop, stopDevice, files, fetchFile, routines, setRoutine, view, portrait, sprite, activity, liveRemoteRuns, recentRuns, _remoteRuns: remoteRuns };
}

module.exports = { makeRemoteHost };
