/* frontend/app/turnkinds.js — the one home of a turn's identity grammar and of row kinds (turn-identity, commit 1).

   Pure UMD, reusing Pipeline and GoalLoop's legacy recognizers: the sidecar's transcript store and run writer require() it, and the page and phone
   host load the SAME module, so a turnId the desk mints and the station checks follow one grammar. No clock, no
   randomness, no fs, no crypto: a mint takes an injected rng, a time conversion an injected `now`.

     TURN_ID_RE, isTurnId(v)          the turnId grammar (8-64 of [A-Za-z0-9_-]); a bad value is dropped, never thrown
     runTurnId(runId)                 'r' + runId, sanitized and clipped to 64 ('' when that is not a turnId): the
                                      server's own mint for a run, so it is never looked up as a resend
     phoneTurnId(runId)               'ph' + runId, sanitized and clipped the same way (the phone host's mint)
     ownMint(turnId, runId)           true only for an id derived from THIS run's own id (either mint above)
     mintTurnId(rng)                  't' + 24 base36 chars drawn from rng() in [0,1); a TypeError without an rng
     QUOTES_MAX                       the ONE quote capacity (32 stream ids)
     quoteStamp(entries)              [{id, at}] (a bare string is {id, at: 0}) -> { quotes, quotesAt }: up to 32
                                      distinct ids with their read times aligned; more, or any '*', is the
                                      saturated stamp { quotes: ['*'], quotesAt: [min at] }; {} for none
     stationTime(clientTs, clientNow, now)   the station time of a client instant, from the client's own elapsed
                                      time (now - (clientNow - clientTs)), so a client clock's offset cancels
     clientTurnTime(body, now)        { turnAt, clientClock: { clientNow, at } } for a body carrying a usable
                                      turnAt + clientNow pair, else {}
     KINDS, isKind(v), SYSTEM_KINDS   row kinds; rows of a SYSTEM kind are stored with role 'system', so an older
                                      reader (reconstruct, appendNew, markRecorded, the page merges) skips them
     tag(msg, kind, extra) / tagOf(msg)   a kind carried on a message object under a non-enumerable Symbol: invisible
                                      to JSON.stringify, so a tagged message's wire and disk bytes never change
     ofRun(o, { internal, trigger })  a run's kinds, from host-minted origin flags only (never from content; commit 4):
                                      { directiveKind, rowKind, line, kindOf }. directiveKind, first match wins:
                                      station (internal / outputOnly / syntheticTrigger, any stream), hop (o.lineHop),
                                      goal-step (o.goalContinuation), routine (trigger 'schedule' | 'manual', exactly
                                      routine-identity.js isRoutineTrigger), group (o.groupTools), api (o.taskSource
                                      'api'), else turn. rowKind 'station' | 'hop' | undefined; line 'lineId@dockId'
                                      (<= 120) when o.lineHop; kindOf(m) = messageKind(m, rowKind)
     messageKind(m, rowKind)          a drained row's kind: its tag; else 'station' for a user row (any user row a run
                                      writes besides its directive is the station's own); else rowKind, else 'turn' */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./pipeline.js'), require('./goalloop.js'));
  else { root.TurnKinds = factory(root.Pipeline, root.GoalLoop); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Pipeline, GoalLoop) {
  'use strict';

  const TURN_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
  const ID_MAX = 64;
  const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
  const MINT_CHARS = 24;
  const QUOTES_MAX = 32;
  const SATURATED = '*';
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  const KINDS = Object.freeze(['turn', 'station', 'goal-step', 'routine', 'group', 'hop', 'capture', 'steer', 'observed',
    'deliverable', 'delivery', 'retract', 'briefing', 'api']);
  // stored role 'system': trunk's readers skip these, so a downgrade never replays one as the Commander's words.
  // 'delivery' is NOT here: it is a routine's reply, assistant speech, and stays role 'assistant'.
  const SYSTEM_KINDS = Object.freeze(['steer', 'deliverable', 'retract']);

  function isTurnId(v) { return typeof v === 'string' && TURN_ID_RE.test(v); }
  function isKind(v) { return typeof v === 'string' && KINDS.indexOf(v) >= 0; }
  function isSafeNonNeg(v) { return Number.isSafeInteger(v) && v >= 0; }

  function derived(prefix, runId) {
    const id = (prefix + (runId == null ? '' : String(runId))).replace(/[^A-Za-z0-9_-]/g, '').slice(0, ID_MAX);
    return isTurnId(id) ? id : '';
  }
  function runTurnId(runId) { return derived('r', runId); }
  function phoneTurnId(runId) { return derived('ph', runId); }
  // derived from THIS run's own id; every other value, whatever its prefix, was supplied and must be looked up
  function ownMint(turnId, runId) {
    if (!isTurnId(turnId)) return false;
    return turnId === runTurnId(runId) || turnId === phoneTurnId(runId);
  }

  function mintTurnId(rng) {
    if (typeof rng !== 'function') throw new TypeError('TurnKinds.mintTurnId needs an rng() returning a number in [0,1)');
    let id = 't';
    for (let i = 0; i < MINT_CHARS; i++) {
      const v = Number(rng());
      const k = Math.floor((v >= 0 && v < 1 ? v : 0) * BASE36.length);
      id += BASE36[Math.min(BASE36.length - 1, Math.max(0, k))];
    }
    return id;
  }

  // [{id, at}] -> { quotes, quotesAt }. An entry's `at` is the read epoch of the first dispatch that read that stream;
  // a missing or unusable one counts as 0 (the earliest, so a delete never misses it). Duplicates keep their earliest.
  function quoteStamp(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const ids = [];
    const firstAt = new Map();
    let saturated = false, minAt = Infinity;
    for (const e of list) {
      const id = typeof e === 'string' ? e : (e && typeof e === 'object' && typeof e.id === 'string' ? e.id : '');
      if (!id) continue;
      const at = (e && typeof e === 'object' && isSafeNonNeg(e.at)) ? e.at : 0;
      if (at < minAt) minAt = at;
      if (id === SATURATED) { saturated = true; continue; }
      if (!firstAt.has(id)) { firstAt.set(id, at); ids.push(id); }
      else if (at < firstAt.get(id)) firstAt.set(id, at);
    }
    if (!saturated && !ids.length) return {};
    if (saturated || ids.length > QUOTES_MAX) return { quotes: [SATURATED], quotesAt: [minAt] };
    return { quotes: ids, quotesAt: ids.map(id => firstAt.get(id)) };
  }

  // a client instant in station time: the client's own elapsed time since it (clientNow - clientTs), subtracted from
  // the station's now. Only a pair of non-negative safe integers no more than 7 days apart is used.
  function stationTime(clientTs, clientNow, now) {
    if (!isSafeNonNeg(clientTs) || !isSafeNonNeg(clientNow) || !Number.isSafeInteger(now)) return undefined;
    const elapsed = clientNow - clientTs;
    if (elapsed < 0 || elapsed > WEEK_MS) return undefined;
    return now - elapsed;
  }
  function clientTurnTime(body, now) {
    const b = body && typeof body === 'object' ? body : {};
    const turnAt = stationTime(b.turnAt, b.clientNow, now);
    return turnAt === undefined ? {} : { turnAt, clientClock: { clientNow: b.clientNow, at: now } };
  }

  // Symbol-keyed and non-enumerable: JSON.stringify, Object.keys and object spread never see it, so a tag rides the
  // message object through the loop without reaching the wire or the disk (the transcript's PERSISTED marker idiom).
  const KIND_TAG = Symbol('starnet.turn.kind');
  function tag(msg, kind, extra) {
    if (!msg || typeof msg !== 'object' || !isKind(kind)) return msg;
    if (!Object.isExtensible(msg) && !Object.prototype.hasOwnProperty.call(msg, KIND_TAG)) return msg;
    const value = { kind };
    if (extra && typeof extra === 'object' && extra.noteId != null) value.noteId = String(extra.noteId);
    Object.defineProperty(msg, KIND_TAG, { value: Object.freeze(value), enumerable: false, configurable: true, writable: true });
    return msg;
  }
  function tagOf(msg) { return msg && typeof msg === 'object' && msg[KIND_TAG] ? msg[KIND_TAG] : null; }

  const LINE_MAX = 120;
  const ROUTINE_TRIGGERS = Object.freeze(['schedule', 'manual']);   // routine-identity.js isRoutineTrigger (test-checked)
  function messageKind(m, rowKind) {
    const t = tagOf(m);
    if (t) return t.kind;
    if (m && m.role === 'user') return 'station';
    return rowKind || 'turn';
  }
  function ofRun(o, ctx) {
    const x = o && typeof o === 'object' ? o : {};
    const c = ctx && typeof ctx === 'object' ? ctx : {};
    let directiveKind = 'turn';
    if (c.internal || x.internal || x.outputOnly || x.syntheticTrigger) directiveKind = 'station';
    else if (x.lineHop === true) directiveKind = 'hop';
    else if (x.goalContinuation === true) directiveKind = 'goal-step';
    else if (ROUTINE_TRIGGERS.indexOf(c.trigger) >= 0) directiveKind = 'routine';
    else if (x.groupTools) directiveKind = 'group';
    else if (x.taskSource === 'api') directiveKind = 'api';
    const rowKind = directiveKind === 'station' || directiveKind === 'hop' ? directiveKind : undefined;
    const line = x.lineHop === true && (x.lineId || x.dockId)
      ? (String(x.lineId || '') + '@' + String(x.dockId || '')).slice(0, LINE_MAX) : undefined;
    return { directiveKind, rowKind, line, kindOf: m => messageKind(m, rowKind) };
  }

  // Each non-boolean cell names the additional proof/context its view must supply. This is the shared
  // visibility table; neither the page nor a sidecar reader keeps a second list of hidden kinds.
  const VIEWS = Object.freeze(['model-replay', 'owner-evidence', 'recall', 'display', 'proof']);
  const cells = (replay, owner, recall, display, proof) => Object.freeze(Object.fromEntries(VIEWS.map((v, i) => [v, [replay, owner, recall, display, proof][i]])));
  const MATRIX = Object.freeze({
    'turn-user': cells(true, 'owner', true, true, true),
    'delegator': cells(true, false, true, true, true),
    'api': cells(true, false, true, true, true),
    'assistant': cells(true, false, true, true, true),
    'tool': cells('pairs', false, true, true, true),
    'goal-step': cells(true, false, true, true, true),
    'routine': cells('own-stream', false, 'own-stream', true, true),
    'group': cells('group', false, false, false, true),
    'station': cells(false, false, false, false, true),
    'capture': cells(false, false, false, false, true),
    'hop': cells('own-line', false, true, true, true),
    'steer': cells(true, 'owner', true, true, true),
    'deliverable': cells(false, false, true, true, true),
    'delivery': cells(true, false, true, true, true),
    'observed': cells(true, false, true, true, true),
    'carried': cells(true, false, true, true, true),
    'dispatch-prompt': cells('paired-final', false, true, true, true),
    'dispatch-final': cells(true, false, true, true, true),
    'dispatch-unaccepted': cells(false, false, false, true, true),
    'retract': cells(false, false, false, false, true),
    'retract-target': cells(false, false, false, 'retry-target', true),
    'forgotten': cells(false, false, false, false, true),
    'live': cells(false, false, false, 'live-directive', true),
    'idless': cells(false, false, false, false, false),
    'local': cells(false, false, false, true, true)
  });
  function legacyPrompt(r) {
    if (!r || r.streamId !== 'global' || r.role !== 'user') return false;
    const c = r.content == null ? '' : String(r.content);
    return c.indexOf('\n\nAssistant reply (context only): ') >= 0 || c.startsWith('INTERNAL —')
      || (c.startsWith('Goal:\n') && /Is the goal satisfied — done or continue\?$/.test(c));
  }
  function runOf(row, ctx) { return ctx && typeof ctx.runOf === 'function' ? ctx.runOf(row && row.sourceRunId) : null; }
  const LEGACY_FINAL_CONTENT_MAX = 200000;
  // The final-row integrity rule is shared with the store and the page's model window. The station
  // supplies its hash and expected durable run envelope; a page consumes the already verified GET row.
  function isFinalDeliveryRow(row, hash, expected) {
    if (!row || row.dispatchState !== 'final' || row.role !== 'assistant' || !row.sourceRunId || typeof row.content !== 'string') return false;
    const hasIntegrity = row.textLength != null || row.textSha256 != null;
    const verified = hasIntegrity ? Number.isSafeInteger(row.textLength) && row.textLength === row.content.length
      && /^[a-f0-9]{64}$/.test(String(row.textSha256 || '')) && (typeof hash !== 'function' || hash(row.content) === row.textSha256)
      : row.content.length < LEGACY_FINAL_CONTENT_MAX;
    if (!verified) return false;
    if (expected && expected.state === 'final') {
      if (!row.content.startsWith(String(expected.text || '')) || row.dispatchReason !== expected.reason
          || (row.dispatchRepairRunId != null && row.dispatchRepairRunId !== expected.repairRunId)) return false;
      if (hasIntegrity || expected.textLength != null || expected.textSha256 != null) {
        if (row.textLength !== expected.textLength || row.textSha256 !== expected.textSha256) return false;
      }
    }
    return true;
  }
  function legacyKind(row, ctx) {
    const r = row || {}, c = ctx || {}, run = runOf(r, c), text = typeof r.content === 'string' ? r.content : '';
    if (r.dispatchState === 'internal' || (run && run.internal === true) || legacyPrompt(r)
        || (r.streamId === 'global' && c.selfTalkRuns && c.selfTalkRuns.has(String(r.sourceRunId || '')))) return 'station';
    if (r.role === 'user' && text.startsWith('[BEGIN EXTERNAL SCREEN CAPTURE')) return 'capture';
    if (r.role === 'user' && text.startsWith('Shared conversation context (')) return 'group';
    if ((r.role === 'user' && Pipeline && Pipeline.isHandoff(text)) || (c.hopRuns && c.hopRuns.has(String(r.sourceRunId || '')))
        || (run && typeof run.taskKey === 'string' && run.taskKey.startsWith('chain:'))) return 'hop';
    if (r.role === 'user' && text.startsWith('[STRUCTURED RESULT REPAIR]')) return 'station';
    if (GoalLoop && GoalLoop.stepOfTurn(r)) return 'goal-step';
    return 'turn';
  }
  function classify(row, ctx) {
    const r = row || {}, c = ctx || {}, run = runOf(r, c), legacy = !isKind(r.kind);
    // These marks are produced only after projectConversation verified/emitted the accepted final.
    // A pending stored prompt remains pending on disk but is accepted in this projection.
    if (r.displayOf === 'final' && r.role === 'user') return { kind: 'turn', cell: 'dispatch-prompt', speaker: 'brief', legacy };
    if (r.dispatchState === 'final') return (typeof c.isFinalDeliveryRow === 'function' ? c.isFinalDeliveryRow(r) : isFinalDeliveryRow(r, c.hash, run && run.dispatchDelivery))
      ? { kind: 'turn', cell: 'dispatch-final', speaker: 'assistant', legacy }
      : { kind: 'station', cell: 'dispatch-unaccepted', speaker: 'station', legacy };
    if (r.dispatchState === 'pending' || r.dispatchState === 'internal' || r.dispatchState === 'interrupted' || r.dispatchState === 'page-closed')
      return { kind: 'station', cell: 'dispatch-unaccepted', speaker: 'station', legacy };
    if (r.foreign || r.steerEcho || r.truncated || r.error || r.stopped || (r.sys && !isKind(r.kind)))
      return { kind: 'local', cell: 'local', speaker: 'station', legacy };
    const kind = legacy ? legacyKind(r, c) : r.kind;
    let cell = kind, speaker = r.role === 'assistant' ? 'assistant' : 'station';
    if (kind === 'turn') {
      if (r.carriedBy) { cell = 'carried'; speaker = r.role; }
      else if (r.role === 'tool' || (r.role === 'assistant' && !String(r.content || '').trim() && r.toolCalls)) { cell = 'tool'; speaker = r.role; }
      else if (r.role === 'assistant') { cell = 'assistant'; speaker = 'assistant'; }
      else if (r.role === 'user') { cell = r.from ? 'delegator' : 'turn-user'; speaker = r.from ? 'brief' : run && run.ownerDirective === true ? 'owner' : 'user'; }
      else cell = 'local';
    } else if (kind === 'api') speaker = 'member';
    else if (kind === 'hop') speaker = 'agent';
    else if (kind === 'delivery' || kind === 'routine') speaker = 'routine';
    return { kind, cell: MATRIX[cell] ? cell : 'local', speaker, legacy };
  }
  // Who wrote a row: its own agent, else its run's agent; '' when neither is recorded.
  function authorOf(row, ctx) {
    if (row && typeof row.agentId === 'string' && row.agentId) return row.agentId;
    const run = runOf(row, ctx);
    return run && typeof run.agentId === 'string' ? run.agentId : '';
  }
  /* opts.forAgent names the STAGE that replays a stream other agents also wrote (a line stage reading its chat). A tool-call turn and a
     tool result are their author's: replayed to another agent they arrive as THAT agent's own assistant turns and tell the provider it
     made calls it never made (DESIGN 5.2). With no forAgent (a chat's own agent) every row's tool traffic is the reader's, as before;
     an author that cannot be proved is not the stage. The message shaper asks this too, so a call that carried words keeps only its
     words once its results are gone: a call is never left without its result, nor a result without its call. */
  function foreignTools(row, opts, ctx) {
    const reader = opts && typeof opts.forAgent === 'string' ? opts.forAgent : '';
    return !!reader && authorOf(row, ctx) !== reader;
  }
  function replayable(row, opts) {
    const o = opts || {}, c = o.ctx || {}, classification = classify(row, c), rule = MATRIX[classification.cell]['model-replay'];
    if (rule === true || rule === false) return rule;
    if (rule === 'pairs') return o.shape === 'pairs' && !foreignTools(row, o, c);
    if (rule === 'own-stream') return !o.streamId || !row.streamId || o.streamId === row.streamId;
    if (rule === 'group') return o.group === true;
    if (rule === 'own-line') return !!o.line && row.line === o.line;
    if (rule === 'paired-final') return !!(c.finalRuns && c.finalRuns.has(String(row.sourceRunId || '')));
    return false;
  }

  return {
    TURN_ID_RE, isTurnId, runTurnId, phoneTurnId, ownMint, mintTurnId,
    QUOTES_MAX, quoteStamp, stationTime, clientTurnTime,
    KINDS, isKind, SYSTEM_KINDS, tag, tagOf, ofRun, messageKind,
    VIEWS, MATRIX, legacyPrompt, legacyKind, classify, replayable, foreignTools, isFinalDeliveryRow, LEGACY_FINAL_CONTENT_MAX
  };
});
