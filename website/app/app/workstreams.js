/* STARNET — workstreams.js : the unified unit-of-work record (session organization).
   A WORKSTREAM is one named conversation that simultaneously IS the Comms thread (its
   `history`), IS a kanban card (its `lane`), and OWNS its backend runs + deliverables +
   per-conversation cost. This module is the single owner of workstreams[] + activeId +
   generalId — one record, no fourth silo.

   Pure + dependency-free (no DOM / localStorage / Harness): exposes a `Workstreams` global in
   the browser, module.exports under node — so it is unit-testable headless like classify.js.
   It persists by handing serialize() to App.persist(); save.js delegates its v1->v2 upgrade to
   migrateV1() (the migration lives HERE because save.js has no module export — and so a v2 save
   never reaches the live app until the slice-2 wiring lands with it).

   Two invariants from the locked design:
   - TRUTHFUL TELEMETRY: per-stream cost is accumulated from the SAME real model-usage deltas
     that mint the lifetime total (chat.js feeds addCost a copy-snapshotted Harness.totals()
     diff) — never an invented number.
   - HYBRID-HONEST LANES: appendRun auto-advances todo->active the instant a real run fires;
     'shipped' is only ever set by a deliberate human turn-in via setLane. A lane can't lie.

   PACKED HISTORIES (save v7, save-history-by-reference). A saved session's `history` may name a run of rows the station's
   transcript holds as one element { "$ref": "…" } (historyref.js) instead of repeating them. The page cannot draw that
   element, so init keeps such a history whole as w.historyRef (the PACKED form, verbatim) and w.history holds only the rows
   the page keeps itself: every inline element, in order, the very same objects, and whatever is pushed after boot.
   Until the named rows are read back (hydrate(), driven by chat.js) the session is PARTIAL and says so:
     · isUntouched / hasHistory / turnCount / hasUserTurn count the named rows; latestVisibleMessage names a message only when
       the packed form proves it is the newest (the digest); titleBasis / needsModelTitle / exportConversation / the
       archive-empty test refuse to judge from the inline rows alone;
     · serialize() hands out the packed form (historyRef) followed by the rows pushed since, so a session nobody opened is
       never rewritten and nothing is dropped;
     · writers that insert, replace or remove rows hydrate first (chat.js hydrateHistory) or use setHistory().
   Both properties are NOT enumerable: a record can never be stringified (or copied) carrying a second copy of its history.

   PACKING (save v7). serialize() also PACKS: a session whose rows are all here has its history passed through
   HistoryRef.pack with the page's SEALS — the turns the station returned in a successful read (sealTurns, called by chat.js after the
   open-time reconcile, a seal pass, a hydration and app.js's idle seal sweep; held in page memory only, never saved). A row the station provably holds and the
   page still holds field for field becomes part of one { "$ref": … } element; every other row stays inline where it is. */
'use strict';
(function (root, factory) {
  const node = typeof module !== 'undefined' && module.exports;
  const api = factory(node ? require('./turnkinds.js') : root.TurnKinds, node ? require('./historyref.js') : root.HistoryRef);
  if (node) module.exports = api;
  else { root.Workstreams = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (TurnKinds, HistoryRef) {
  'use strict';

  const LANES = ['todo', 'active', 'shipped'];
  const LANE_OF_COL = { todo: 'todo', doing: 'active', done: 'shipped' };  // station kanban col -> lane

  // ---------- internal store (the single source of truth for sessions) ----------
  let ws = [];          // Workstream[]
  let delegatedAgents = null;   // parent id -> participating agent ids; rebuilt only when thread identity changes
  let activeId = null;
  let generalId = null;
  let undoCheckpoint = null;   // one durable, bounded recovery point for clear/bulk archive
  // DELETED-SESSION TOMBSTONES: adopt() is the seam that re-mints sessions from server-side state
  // (workshop deliverables, cron backfill) — without a durable record of the delete, every restart
  // resurrected rows the Commander had deliberately removed. A deleted id lands here, rides
  // serialize()/init(), and adopt() refuses it unless the caller passes revive:true (a deliberate
  // human re-open, e.g. the OUTBOX crate's "review"). Bounded so the list can't grow unboundedly.
  const MAX_TOMBS = 500;
  let tombs = [];       // string ids of deleted workstreams, oldest first
  // FORGOTTEN SESSIONS (qa/bugs/3e926b6a): the subset the Commander deleted AS A CONVERSATION (the rail's Delete, and
  // station.control session.delete, which asks them first) — del(id, { forget: true }). It rides the save as
  // `forgetIds`, and the sidecar forgets only these: their history, recall and the memory they wrote. A row removed as a
  // side effect (DELETE AGENT's removeByAgent, a task card's remove) is only hidden, as it always was: deleting an
  // agent archives its record, it is not a privacy delete of its conversations. Same bound, same revive/reset rules.
  let forgets = [];

  // frontend module: ambient time/rng is fine here (lint-determinism scans only shared/ + sidecar/).
  function now() { return Date.now(); }
  function uid() { return 'ws_' + now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
  function clamp(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }
  function zeroCost() { return { tokens: 0, usd: 0, calls: 0 }; }
  function find(id) { for (const w of ws) if (w.id === id) return w; return null; }

  // ---------- packed histories (see the header) ----------
  // a packed element (HistoryRef: a $ref run, or the stub an engine left in one). Without HistoryRef (a bare sandbox) the $ref shape is still recognised.
  const isPacked = el => HistoryRef && HistoryRef.isRef
    ? (HistoryRef.isRef(el) || (HistoryRef.isStub && HistoryRef.isStub(el)))
    : (!!el && typeof el === 'object' && !Array.isArray(el) && typeof el.$ref === 'string');
  const countPacked = h => HistoryRef && HistoryRef.countOf ? HistoryRef.countOf(h) : h.length;
  const packedInfo = new WeakMap();   // a packed array (never mutated once held) -> the rows it holds inline, as a list and a set
  function infoOf(ref) {
    let info = packedInfo.get(ref);
    if (!info) { const rows = ref.filter(el => !isPacked(el)); info = { rows, set: new Set(rows) }; packedInfo.set(ref, info); }
    return info;
  }
  // WHAT THE PACKED FORM PROVES ABOUT A SESSION'S ENDS, and no more: the first user message only when no packed run comes before it, the
  // newest visible one only when no packed run comes after it (a run could hold anything newer), and the exact count of rows. Taken of the
  // packed form itself, because nothing else is there after a boot; a digest of full rows (HistoryRef.digestOf) would name the newest
  // INLINE row even when a packed run is newer than it.
  function digestOfPacked(ref) {
    let firstUser = null, latest = null;
    for (const el of ref) { if (isPacked(el)) break; if (el && el.role === 'user' && isVisibleMessage(el) && el.content.trim()) { firstUser = el; break; } }
    for (let i = ref.length - 1; i >= 0; i--) { const el = ref[i]; if (isPacked(el)) break; if (isVisibleMessage(el) && el.content.trim()) { latest = el; break; } }
    return { v: 1, count: countPacked(ref), firstUser, latest };
  }
  // keep `ref` (a history holding at least one packed element) as the session's packed form; w.history is left to the caller
  function setPacked(w, ref) {
    Object.defineProperty(w, 'historyRef', { value: ref, writable: true, configurable: true, enumerable: false });
    Object.defineProperty(w, 'historyDigest', { value: digestOfPacked(ref), writable: true, configurable: true, enumerable: false });
  }
  function clearPacked(w) { if (w && Object.prototype.hasOwnProperty.call(w, 'historyRef')) { w.historyRef = null; w.historyDigest = null; } }
  // a whole history put into a record: rows with a packed element in them keep those runs packed, anything else clears the packed form
  function installHistory(w, rows) {
    clearPacked(w);
    if (rows.some(isPacked)) { w.history = rows.filter(el => !isPacked(el)); setPacked(w, rows.slice()); }
    else w.history = rows;
  }
  /* The history the save carries for `w`: its packed form followed by the rows pushed since. A row the page dropped from the rows it holds
     (a filter, a cap, a pop) stays dropped, and a row it added lands after the packed form, where an append puts it. */
  function composedHistory(w) {
    const h = Array.isArray(w.history) ? w.history : [];
    if (!w.historyRef) return h;
    const ref = w.historyRef, info = infoOf(ref);
    if (h.length === info.rows.length && info.rows.every((r, i) => h[i] === r)) return ref;   // nothing added or taken: the packed form IS the history
    const kept = new Set(h), out = [];
    for (const el of ref) if (isPacked(el) || kept.has(el)) out.push(el);
    for (const r of h) if (!info.set.has(r)) out.push(r);
    return out;
  }

  /* SEALS: WHAT THIS PAGE HAS PROVED THE STATION HOLDS. A seal is a turn exactly as the station returned it in a successful read — a
     private deep copy (HistoryRef.snapshotOf: plain JSON, strings shared), kept in page memory under HistoryRef.keyOf(stream, rowId),
     never mutated and never saved. serialize() hands HistoryRef.pack the seals, and pack names a row instead of repeating it ONLY when
     the page's row still equals its seal field for field (whatever it holds beyond the seal rides as residue); every other row stays
     inline where it is. So an unproven row makes the save bigger, never lossier — and a page that has read nothing (a fresh boot, a
     station that does not answer) packs nothing: init() and reset() start from no seals. A later read replaces a seal with the
     station's newer copy; a row the page changed since falls off its seal and is saved inline again. */
  const seals = new Map();
  const sealAsks = new Map();   // seal key -> how many sweep reads asked for it without an answer (SEAL_ASKS_MAX = never again this page lifetime)
  const SEAL_ASKS_MAX = 3;
  const STREAM_ID = /^[A-Za-z0-9_-]{1,64}$/;   // the stream ids POST /api/transcript/rows takes
  const sealOf = key => seals.get(key) || null;
  // keep the turns of one stream a successful read returned as seals; returns how many were kept. A stream the rows route cannot name (an id
  // outside its grammar, such as a restored copy's "<id>~restored") is never sealed: the station's ordinary read answers such an id with the
  // GLOBAL stream, so what it returned proves nothing about this session, and a reference the page could never read back would strand the rows
  function sealTurns(streamId, turns) {
    streamId = String(streamId == null ? '' : streamId);
    if (!HistoryRef || !HistoryRef.snapshotOf || !STREAM_ID.test(streamId) || !Array.isArray(turns)) return 0;
    let n = 0;
    for (const t of turns) {
      if (!t || typeof t !== 'object' || t.idFrom === 'collision' || (t.streamId && t.streamId !== streamId)) continue;   // a collided id proves nothing; another stream's row is not this stream's seal
      const snap = HistoryRef.snapshotOf(t);
      if (!snap) continue;
      seals.set(HistoryRef.keyOf(streamId, snap.rowId), snap); n++;
    }
    return n;
  }
  function sealed(streamId, rowId) { return seals.get(HistoryRef.keyOf(String(streamId), rowId)) || null; }
  // The station says these rows of a stream were undone or forgotten: the copy of them the page kept as proof goes too (a deleted turn's text
  // is held nowhere a later read has to clean up). The row, if the page still holds it, is saved inline until the station says otherwise.
  function unseal(streamId, rowIds) {
    if (!HistoryRef || !Array.isArray(rowIds)) return 0;
    let n = 0;
    for (const id of rowIds) if (seals.delete(HistoryRef.keyOf(String(streamId), id))) n++;
    return n;
  }
  // a deleted session's seals go with it (the key is "<stream>:<digits>", so a stream whose own id has a colon is never confused with another)
  function dropSeals(streamId) {
    const prefix = String(streamId) + ':';
    for (const k of seals.keys()) if (k.startsWith(prefix) && /^\d+$/.test(k.slice(prefix.length))) seals.delete(k);
    for (const k of sealAsks.keys()) if (k.startsWith(prefix) && /^\d+$/.test(k.slice(prefix.length))) sealAsks.delete(k);
  }
  /* The rows the idle seal sweep still has to ask the station about: for every session whose rows are all here (newest first), the
     ids of its inline rows that could be packed (a rowId, a kind the transcript owns) and carry no seal yet, in batches the rows route
     takes (<= maxIds ids across <= maxStreams sessions). Rows with no rowId are never here: nothing is matched by content. Nothing is
     stored; asking again after a pause gives the rest. opts.any: only whether there is anything left (the first one found, unordered).
     -> [{ streamId, agentId, rowIds }] */
  function sealCandidates(opts) {
    const o = opts || {};
    const maxIds = Math.max(1, Math.min(1000, Math.floor(Number(o.maxIds)) || 1000)), maxStreams = Math.max(1, Math.min(50, Math.floor(Number(o.maxStreams)) || 50));
    if (!HistoryRef || !HistoryRef.sealable) return [];
    const found = [];
    for (const w of ws) {
      if (w.historyRef || w.conversationMode === 'group' || !Array.isArray(w.history) || !w.history.length || !STREAM_ID.test(w.id)) continue;   // (the rows route refuses a whole request for one id it does not take)
      const want = [], seen = new Set();
      for (const r of w.history) {
        if (!HistoryRef.sealable(r, w.id) || seen.has(r.rowId)) continue;
        const k = HistoryRef.keyOf(w.id, r.rowId);
        if (seals.has(k) || (sealAsks.get(k) || 0) >= SEAL_ASKS_MAX) continue;
        seen.add(r.rowId); want.push(r.rowId);
        if (o.any) return [{ streamId: w.id, agentId: w.agentId || 'agent', rowIds: want }];   // "is there anything left?" needs no ordering and no more than one
      }
      if (want.length) found.push({ streamId: w.id, agentId: w.agentId || 'agent', rowIds: want, at: +w.lastActiveAt || 0 });
    }
    found.sort((a, b) => b.at - a.at);
    const out = [];
    let left = maxIds;
    for (const f of found) {
      if (out.length >= maxStreams || left <= 0) break;
      out.push({ streamId: f.streamId, agentId: f.agentId, rowIds: f.rowIds.slice(0, left) });
      left -= out[out.length - 1].rowIds.length;
    }
    return out;
  }
  // a sweep read asked for `asked` ids of a stream and the station answered for `answered` of them (a turn, or the proof that it was undone
  // or forgotten): the rest stay candidates for a few more reads — a request reads a bounded number of segments — and then are left alone
  function noteSealRead(streamId, asked, answered) {
    if (!HistoryRef || !Array.isArray(asked)) return;
    const done = new Set(Array.isArray(answered) ? answered : []);
    for (const id of asked) {
      const k = HistoryRef.keyOf(String(streamId), id);
      sealAsks.set(k, done.has(id) ? SEAL_ASKS_MAX : Math.min(SEAL_ASKS_MAX, (sealAsks.get(k) || 0) + 1));
    }
  }

  // The history one record is saved with. A session whose rows are not all here: its packed form, verbatim, followed by the rows pushed
  // since. A session whose rows are all here: HistoryRef.pack over the seals (the very record when nothing packs, so a page that has read
  // nothing saves exactly the live records). A group chat's rows are the backend's own copy and carry no transcript row ids: never packed.
  function persistedRecord(w) {
    if (w.historyRef) return Object.assign({}, w, { history: composedHistory(w) });
    const h = w.history;
    if (!seals.size || !HistoryRef || !HistoryRef.pack || w.conversationMode === 'group' || !Array.isArray(h) || !h.length) return w;   // (and a stream the rows route cannot name has no seal: sealTurns)
    const packed = HistoryRef.pack(h, { streamId: w.id, seal: sealOf });
    return packed.length === h.length && packed.every((el, i) => el === h[i]) ? w : Object.assign({}, w, { history: packed });
  }
  function persistedList() {
    let out = null;
    for (let i = 0; i < ws.length; i++) {
      const rec = persistedRecord(ws[i]);
      if (rec !== ws[i] && !out) out = ws.slice(0, i);   // the first record that differs: the list is a copy from here on
      if (out) out.push(rec);
    }
    return out || ws;
  }

  // The one canonical Workstream shape. Idempotent on an already-formed record (ids/timestamps
  // are preserved), so init() can re-normalize a saved slice without reshaping it.
  function make(opts) {
    opts = opts || {};
    const t = opts.t || opts.createdAt || now();
    const c = opts.cost || {};
    const lane = LANES.indexOf(opts.lane) >= 0 ? opts.lane : 'todo';
    const packed = Array.isArray(opts.history) && opts.history.some(isPacked);   // a saved history that names rows the station holds (see the header)
    const w = {
      id: opts.id || uid(),
      title: opts.title != null ? clamp(opts.title, 80) : null,    // null = the General default stream
      agentId: opts.agentId || 'agent',
      conversationMode: opts.conversationMode === 'group' ? 'group' : 'direct',
      roomId: opts.roomId != null ? opts.roomId : null,            // dormant builder seam: a room IS a channel, later
      lane: lane,
      // TASK-BOARD TRUTH: 'task' = a deliberate board directive (renders as a card); 'chat' = a plain session
      // (rail-only, never on the board). A NEW record honours opts.kind ('task' only when asked, else 'chat').
      // On the idempotent re-normalize of a SAVED record, kind is preserved verbatim; a pre-upgrade save with NO
      // kind is INFERRED — only the two lanes a human board action can produce (todo/shipped) imply a task; every
      // other saved stream (including auto-advanced 'active' sessions) was a chat. The inference runs ONLY when
      // opts.kind is absent/invalid, so a saved 'chat' in the 'shipped' lane (impossible today) still can't lie.
      kind: (opts.kind === 'task' || opts.kind === 'chat')
        ? opts.kind
        : ((lane === 'todo' || lane === 'shipped') ? 'task' : 'chat'),
      // the blessed project root this session works in (set by the Projects rail's "Work here" jump, or
      // setProjectRoot when a session joins a project later). null = not anchored to a project. Additive:
      // records saved before this field existed simply read null. The PROJECTS rail uses it to list the
      // sessions attached to each project — a REAL stored link, never a guessed title match.
      projectRoot: opts.projectRoot != null ? String(opts.projectRoot) : null,
      // WHEN this session joined that project (ms). chat.js resolves an unstamped reply's relative links at the root only
      // when the reply is newer than this. create/adopt stamp a session born in a project with its createdAt and
      // setProjectRoot stamps a later join; a record saved before this field existed keeps null, never an invented time.
      projectRootAt: Number(opts.projectRootAt) > 0 ? Number(opts.projectRootAt) : null,
      parentStreamId: opts.parentStreamId ? String(opts.parentStreamId) : null,
      // a delegated WORKER's own thread (team.dispatch files one per worker). Only these fold under their parent in
      // SESSIONS; a session the agent opened with session.create (it records its parent too) keeps its own row.
      worker: opts.worker === true,
      projectHome: opts.projectHome === true,
      history: Array.isArray(opts.history) ? (packed ? opts.history.filter(el => !isPacked(el)) : opts.history.slice()) : [],
      runIds: Array.isArray(opts.runIds) ? opts.runIds.slice() : [],
      connectorHandoff: normalizeConnectorHandoff(opts.connectorHandoff),
      // outcome of the stream's MOST RECENT run: true = it completed (in-band stream finished, even via a
      // stop/cut-short), false = it DIED in flight (chat.js's in-band `error` branch), null = unknown — no
      // run yet, a run currently in flight (appendRun resets it), or a pre-upgrade save. The board's DONE
      // chip reads this so a run that died can never wear "DONE — REVIEW & SHIP" (truthful telemetry).
      lastRunOk: opts.lastRunOk === true ? true : (opts.lastRunOk === false ? false : null),
      // The backend's terminal reason is stronger evidence than a completed transport or a filed run id.
      lastRunReason: typeof opts.lastRunReason === 'string' ? clamp(opts.lastRunReason.trim(), 80) : '',
      // crew an agent asked to bring into this chat (station.control group.add) while its own reply was still running
      // there: they join when THAT reply ends (group-chat.js drainAfterRun). Saved, so a reload that kills the reply
      // settles it truthfully ("not added") instead of leaving "they join when I finish" hanging.
      pendingJoin: opts.pendingJoin && typeof opts.pendingJoin === 'object' && Array.isArray(opts.pendingJoin.ids) && opts.pendingJoin.ids.length
        ? { runId: String(opts.pendingJoin.runId || ''), ids: opts.pendingJoin.ids.map(String).slice(0, 10), at: Number(opts.pendingJoin.at) || 0 } : null,
      // the model id the SIDECAR reported for this stream's most recent run (harness usage payload,
      // not local config) — the only model claim about a session this app can actually prove. '' = we
      // have never measured one here: no run yet, or a save written before this field existed. The
      // rail's INBOX receipt renders '' as an em dash rather than borrowing the agent's current model,
      // which would assert a model over a transcript three different ones may have written.
      lastModel: opts.lastModel != null ? clamp(opts.lastModel, 60) : '',
      deliverables: Array.isArray(opts.deliverables) ? opts.deliverables.slice() : [],
      cost: { tokens: +c.tokens || 0, usd: +c.usd || 0, calls: +c.calls || 0 },
      pinned: !!opts.pinned,
      archived: !!opts.archived,
      // true = a machine-derived placeholder title, eligible for the one-shot LLM summary upgrade after the
      // stream's first run. A manual rename() flips it false so the upgrade (and any future auto-title) can
      // never stomp a title the human chose. Defaults true; preserved verbatim through init()'s re-normalize.
      titleAuto: opts.titleAuto != null ? !!opts.titleAuto : true,
      // true = the current auto title was model-written FROM substantive content — the terminal state of
      // the auto-title ladder (needsModelTitle stops here). False/absent (incl. every pre-upgrade save)
      // leaves a small-talk-born title eligible for ONE healing upgrade once the session does real work.
      titleStrong: !!opts.titleStrong,
      // /goal AUTONOMOUS LOOP state (chat.js owns the shape via GoalLoop.normalize) — carried through verbatim so a
      // standing goal survives a reload/switch exactly like the thread history. Undefined for a stream with no loop.
      goalLoop: (opts.goalLoop && typeof opts.goalLoop === 'object') ? opts.goalLoop : undefined,
      // Backend job identity, never an inferred title match. Unknown legacy parents stay separate.
      automation: opts.automation && ['routine', 'workshop'].includes(opts.automation.kind)
        ? { kind: opts.automation.kind, id: clamp(opts.automation.id || '', 160), name: clamp(opts.automation.name || '', 160) } : null,
      createdAt: opts.createdAt || t,
      lastActiveAt: opts.lastActiveAt || t,
      // when the Commander last had this stream OPEN. unread = lastActiveAt > lastReadAt (truthful:
      // both are real stored timestamps — no invented counts). A record saved before this field
      // existed defaults to its lastActiveAt so an upgrade never floods the rail with false unreads.
      lastReadAt: opts.lastReadAt != null ? opts.lastReadAt : (opts.lastActiveAt || t)
    };
    if (packed) setPacked(w, opts.history.slice());   // the saved history, verbatim: w.history above holds only its inline rows
    return w;
  }

  function normalizeConnectorHandoff(value) {
    if (!value || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.connectorId || '') || !value.runId || !value.agentId) return null;
    const out = { connectorId: clamp(value.connectorId, 80), runId: clamp(value.runId, 120),
      agentId: clamp(value.agentId, 80), toolName: value.toolName === 'connectors.list' ? '' : clamp(value.toolName || '', 160) };
    // held while the run's question is still open: CONTINUE TASK would ANSWER that question with boilerplate
    if (value.awaitingAnswer === true) out.awaitingAnswer = true;
    return out;
  }
  function setConnectorHandoff(id, value) {
    const w = find(id); if (!w) return null;
    w.connectorHandoff = normalizeConnectorHandoff(value);
    return w.connectorHandoff;
  }
  function connectorHandoff(id) {
    const w = find(id), h = w && w.connectorHandoff;
    return h && !w.archived && h.agentId === w.agentId && w.runIds[w.runIds.length - 1] === h.runId ? h : null;
  }

  // ---------- lifecycle ----------
  // adopt or mint the General default; guarantees there is always exactly one home for casual chat.
  // Only a CHAT may be adopted as General: an untitled board task (e.g. a legacy kanban import that
  // never got a title) is a directive, not the chat home — adopting one would drag a task card into
  // the never-archivable, never-deletable General slot forever.
  function ensureGeneral() {
    let g = generalId ? find(generalId) : null;
    if (!g) g = ws.filter(w => w.title == null && !w.archived && w.kind !== 'task')[0] || null;
    if (!g) { g = make({ title: null, lane: 'active' }); ws.push(g); }
    generalId = g.id;
    return g;
  }

  // hydrate from a saved slice { workstreams, activeId, generalId }; ensures a General exists and
  // the active id is valid. Returns the active workstream (for Chat.load on enter/resume).
  function init(slice) {
    slice = slice || {};
    ws = Array.isArray(slice.workstreams) ? slice.workstreams.map(make) : [];
    seals.clear(); sealAsks.clear();   // a page that has just read a save has proved nothing yet: its seals are what the next reads give it
    delegatedAgents = null;
    tombs = Array.isArray(slice.deletedIds) ? slice.deletedIds.filter(x => typeof x === 'string' && x).slice(-MAX_TOMBS) : [];
    forgets = Array.isArray(slice.forgetIds) ? slice.forgetIds.filter(x => typeof x === 'string' && x).slice(-MAX_TOMBS) : [];
    generalId = (slice.generalId && find(slice.generalId)) ? slice.generalId : null;
    ensureGeneral();
    activeId = (slice.activeId && find(slice.activeId)) ? slice.activeId : generalId;
    activeId = homeOf(activeId);   // a station saved while a worker's thread was open boots into its conversation
    undoCheckpoint = normalizeCheckpoint(slice.sessionUndo);
    const a = active();
    if (a && (a.lastActiveAt || 0) > (a.lastReadAt || 0)) a.lastReadAt = a.lastActiveAt;   // boot renders it — read
    return a;
  }

  // wipe to a single fresh General (NEW AGENT clears everything).
  function reset() { ws = []; seals.clear(); sealAsks.clear(); delegatedAgents = null; activeId = generalId = null; undoCheckpoint = null; tombs = []; forgets = []; const g = ensureGeneral(); activeId = g.id; return active(); }

  // the persisted slice — App.persist() serializes this alongside { agent, usage }. The live records, except a session whose rows are not all here
  // (see the header): that one is handed out as a copy carrying its packed form, so a session nobody opened is written back as it was read.
  function serialize() { return { workstreams: persistedList(), activeId, generalId, sessionUndo: undoCheckpoint, deletedIds: tombs, forgetIds: forgets }; }
  function all() { return ws; }

  // ---------- selection ----------
  function active() { return find(activeId); }
  function get(id) { return find(id); }
  function getActiveId() { return activeId; }
  function getGeneralId() { return generalId; }
  function switchTo(id) { const w = find(id); if (w) { activeId = id; w.lastReadAt = now(); } return w; }
  // opening a stream reads it; new activity on the OPEN stream is read as it lands (touch/appendRun sync below).
  function markRead(id) { const w = find(id); if (!w) return false; w.lastReadAt = now(); return true; }
  function isUnread(w) {
    w = (w && w.id) ? w : find(w);
    return !!w && w.id !== activeId && (w.lastActiveAt || 0) > (w.lastReadAt || 0);
  }

  // DELEGATED WORK IS NOT A CONVERSATION (2026-10-11, a blind usability test picked this over threads in SESSIONS):
  // a worker's own thread is storage for its run. It never shows in a session list; anything that opens it lands on
  // the conversation that asked (homeOf), where the delegation card holds the worker's answer and receipt. A worker
  // whose parent is gone stays visible (never an unreachable record).
  function isHidden(w) {
    w = (w && w.id) ? w : find(w);
    return !!w && w.worker === true && !!w.parentStreamId && w.parentStreamId !== w.id && !!find(w.parentStreamId);
  }
  function homeOf(id) { const w = find(id); return w && isHidden(w) ? w.parentStreamId : id; }
  /* THE NAME A SESSION IS SHOWN BY (rc walk 2026-10-13: the rail read "General" twice). Only the General home is "General";
     any other session without a title yet — a +NEW session nothing was sent in, a session made for an agent — is a
     "New session" until its first message names it (autoTitle). One word everywhere a session is named.
     A delivery session ('workshop-<runId>') was stored as "⚒ <title>" until 10-27: that fallback-font hammer pushed its
     name off the rail's title column (Andrew: "misaligned"), so the name is the title alone, everywhere. */
  const BUILD_MARK = /^\s*⚒\s*/;
  function titleOf(w) {
    w = (w && w.id) ? w : find(w);
    if (!w) return '';
    const t = w.title && String(w.id).indexOf('workshop-') === 0 ? w.title.replace(BUILD_MARK, '') : w.title;
    return t || (w.id === generalId ? 'General' : 'New session');
  }

  // display order: pinned first, then most-recently-active; archived hidden unless asked; delegated workers'
  // threads hidden unless asked (includeWorkers: the delegation card and the busy-peer chip read them).
  function list(opts) {
    opts = opts || {};
    return ws.filter(w => (opts.includeArchived ? true : !w.archived) && (opts.includeWorkers === true || !isHidden(w)))
      .slice()
      .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.lastActiveAt - a.lastActiveAt));
  }

  // ---------- create / mutate ----------
  // start a new (untitled) workstream and make it active; it auto-titles on its first message.
  function create(title, opts) {
    opts = opts || {};
    // create() always mints a 'todo' record, so make()'s lane-inference would read it as a task — pass an
    // EXPLICIT kind so a freshly-created stream is 'chat' UNLESS the caller is a board directive (kind:'task').
    const w = make({ title: title || null, lane: 'todo', agentId: opts.agentId, kind: opts.kind === 'task' ? 'task' : 'chat', projectRoot: opts.projectRoot });   // summon binds a stream to its NEW agent
    if (w.projectRoot) w.projectRootAt = w.createdAt;   // born in the project: every turn of it ran with the root
    ws.push(w);
    if (opts.activate !== false) activeId = w.id;   // board "add" passes {activate:false} so it won't hijack the active chat
    return w;
  }
  // The +NEW session seam. An untouched active chat is already the blank line the Commander
  // asked for, so focus it instead of minting another durable row. This makes a burst of clicks
  // idempotent without a timer: the first legitimate create becomes active synchronously and the
  // rest observe that same blank. Project-scoped actions only reuse a blank carrying the exact
  // stored project root; entering another project must never silently re-anchor a session.
  function startSession(opts) {
    opts = opts || {};
    const cur = active();
    const scoped = Object.prototype.hasOwnProperty.call(opts, 'projectRoot');
    const wantedRoot = scoped && opts.projectRoot != null ? String(opts.projectRoot) : null;
    const sameScope = !scoped || ((cur && cur.projectRoot) || null) === wantedRoot;
    if (opts.reuseActive !== false && isUntouched(cur) && sameScope) return cur;
    /* …and an untouched blank already in the rail, just not the open one, is the same blank line (org live walk 10-14:
       +NEW from another session minted a SECOND empty 'New session' row beside it). Same untouched test, same scope rule
       — scoped: the exact stored root; unscoped (+NEW on the sessions rail): an unanchored blank only. Never the General
       home (its own row, not a 'New session'), a worker's hidden thread or an automation's session. The newest wins and
       is focused here, exactly as create() focuses a fresh one (activate:false leaves the focus to the caller). */
    if (opts.reuseActive !== false) {
      const blank = ws.filter(w => w !== cur && w.id !== generalId && !w.worker && !w.parentStreamId && !w.automation
        && isUntouched(w) && ((w.projectRoot || null) === wantedRoot) && (!opts.agentId || (w.agentId || 'agent') === opts.agentId)).pop();
      if (blank) { if (opts.activate !== false) switchTo(blank.id); return blank; }
    }
    return create(null, opts);
  }
  // UNTOUCHED = a plain chat nobody has used or shaped yet: no messages, runs, deliverables or spend, and no
  // title / pin / room / goal loop / task-card kind someone gave it. The ONE blank test every "reuse the open session
  // instead of minting a row" seam shares (+NEW above, COMMS starter ideas in chat.js), so a titled task card or a
  // pinned empty session is never taken over by a different conversation.
  function isUntouched(w) {
    const c = (w && w.cost) || {};
    return !!w && w.conversationMode !== 'group' && !w.archived && w.kind === 'chat' && w.title == null
      && w.titleAuto !== false && !w.pinned && w.roomId == null && !w.goalLoop
      && (!w.history || w.history.length === 0) && !w.historyRef   // rows named by a packed history are messages the page has not read yet, not a blank
      && (!w.runIds || w.runIds.length === 0)
      && (!w.deliverables || w.deliverables.length === 0)
      && !(+c.tokens || +c.usd || +c.calls);
  }
  // ADOPT a workstream with a CALLER-CHOSEN id (idempotent): if one already exists with opts.id it is
  // keeps its content and adopts only missing thread metadata; otherwise a new record is minted WITHOUT stealing the active
  // stream (never sets activeId — the caller decides whether to focus it). This is the seam the autosessions
  // layer uses to surface an unattended cron run as a session keyed by its own 'cron-<runId>' stream id, so
  // the rail row and the durable server transcript share one identity. Returns the (existing or new) record.
  function adopt(opts) {
    opts = opts || {};
    if (opts.id) {
      const ex = find(opts.id); if (ex) {
        if (opts.automation) ex.automation = make(opts).automation;
        // A run can be reconciled before the overseer files its thread metadata. Adopt those
        // additive links here, so the participation index follows the same store mutation.
        let threadChanged = false;
        if (!ex.parentStreamId && opts.parentStreamId) { ex.parentStreamId = String(opts.parentStreamId); threadChanged = true; }
        if (opts.worker === true && ex.worker !== true) { ex.worker = true; threadChanged = true; }
        if (!ex.projectRoot && opts.projectRoot) { ex.projectRoot = String(opts.projectRoot); ex.projectRootAt = now(); }
        if (threadChanged) delegatedAgents = null;
        return ex;
      }
      // a DELETED id stays deleted: the boot-time resurrection paths (workshop pending poll, cron
      // backfill) must not re-mint a session the Commander removed. revive:true is the deliberate
      // human re-open (it clears the tombstone so the session behaves normally from then on).
      if (isDeleted(opts.id)) {
        if (opts.revive !== true) return null;
        tombs = tombs.filter(t => t !== opts.id);
        forgets = forgets.filter(t => t !== opts.id);   // what was forgotten stays forgotten (the sidecar keeps its stamp)
      }
    }
    const w = make(opts);
    if (w.projectRoot && !w.projectRootAt) w.projectRootAt = w.createdAt;   // born in the project (a caller's own stamp wins)
    ws.push(w);
    if (w.worker) delegatedAgents = null;
    return w;
  }
  function isDeleted(id) { return !!id && tombs.indexOf(String(id)) >= 0; }

  // a MANUAL rename: locks the title (titleAuto=false) so the auto-summary upgrade never overwrites it.
  function rename(id, title) { const w = find(id); if (!w) return false; w.title = title ? clamp(title, 80) : null; w.titleAuto = false; return true; }
  // bind this stream to an agent (the multi-agent summon seam). The id must match the backend's agentId
  // grammar (^[A-Za-z0-9_-]{1,40}$) — an invalid id is rejected so a stream can never route to a bad path.
  function setAgent(id, agentId) {
    const w = find(id); if (!w) return false;
    agentId = String(agentId == null ? '' : agentId);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(agentId)) return false;
    w.agentId = agentId;
    if (w.worker) delegatedAgents = null;
    return true;
  }
  function setLane(id, lane) { const w = find(id); if (!w || LANES.indexOf(lane) < 0) return false; w.lane = lane; return true; }
  // anchor (or re-anchor) a session to a blessed project root — the Projects rail's "Work here" stamps the
  // session it jumps into so the project row can truthfully list its sessions. null/'' clears the anchor.
  // The join time moves only when the root actually changes (naming the same root again keeps it).
  function setProjectRoot(id, root) {
    const w = find(id); if (!w) return false;
    const next = root ? String(root) : null;
    if (next !== (w.projectRoot || null)) w.projectRootAt = next ? now() : null;
    w.projectRoot = next;
    return true;
  }
  function pin(id, val) { const w = find(id); if (!w) return false; w.pinned = val !== false; return true; }
  function touch(id) { const w = find(id); if (w) { w.lastActiveAt = now(); if (id === activeId) w.lastReadAt = w.lastActiveAt; } return !!w; }
  // re-flag REAL unseen state WITHOUT lying about when the work happened: unlike touch(), this never
  // moves lastActiveAt (the rail's "last worked" stamp — re-stamping it made every undecided deliverable
  // session read "now" forever). It only re-opens the unread gap; the open stream is being watched, so
  // it reads as read instead (same guard touch() has).
  function markUnread(id) {
    const w = find(id); if (!w) return false;
    if (id === activeId) { w.lastReadAt = now(); return true; }
    if ((w.lastReadAt || 0) >= (w.lastActiveAt || 0)) w.lastReadAt = 0;
    return true;
  }

  // General can never be archived or deleted (it's the always-present chat home); archiving/deleting
  // the active stream falls back to General so the UI is never left pointing at nothing.
  function archive(id, val) {
    if (id === generalId) return false;
    const w = find(id); if (!w) return false;
    w.archived = val !== false;
    if (w.archived && activeId === id) activeId = generalId;
    return true;
  }
  // opts.forget === true: the Commander deleted this conversation (see `forgets` above); its workers' threads with it
  function del(id, opts) {
    if (id === generalId) return false;
    const i = ws.findIndex(w => w.id === id);
    if (i < 0) return false;
    ws.splice(i, 1);
    dropSeals(id);   // what the page proved about a deleted conversation's rows goes with it
    delegatedAgents = null;
    if (tombs.indexOf(id) < 0) { tombs.push(id); if (tombs.length > MAX_TOMBS) tombs = tombs.slice(-MAX_TOMBS); }
    if (opts && opts.forget === true && forgets.indexOf(id) < 0) { forgets.push(id); if (forgets.length > MAX_TOMBS) forgets = forgets.slice(-MAX_TOMBS); }
    if (activeId === id) activeId = generalId;
    // its delegated workers' threads were its record: they go with it (never left behind, unreachable)
    for (const k of ws.filter(x => x.worker === true && x.parentStreamId === id)) del(k.id, opts);
    return true;
  }
  // DOSSIER › DELETE AGENT support: drop every (non-General) stream bound to a now-deleted agent so the rail
  // can't reopen a stream with no agent behind it. General is never bound to a specialist, so it's untouched;
  // if the active stream was one of the removed, activeId falls back to General (via del). Returns the count.
  function removeByAgent(agentId) {
    const aid = String(agentId == null ? '' : agentId);
    if (!aid) return 0;
    let n = 0;
    // a worker's thread is the asking conversation's record of that work (its card reads it): it stays
    for (const w of ws.slice()) { if (w.conversationMode !== 'group' && w.id !== generalId && w.worker !== true && w.agentId === aid && del(w.id)) n++; }
    return n;
  }

  // ---------- goal steps (org P29-sys wiring) ----------
  // A goal-loop continuation rides history as a user-role turn, but the Commander never typed it. GoalLoop.stepOfTurn is
  // the ONE predicate every reader shares (a browser global; the sibling pure module under node). Every reader here that
  // means "the Commander's words" (titles, export) asks it, so the internal prompt never names or speaks for a session.
  function goalLoopApi() {
    if (typeof GoalLoop !== 'undefined' && GoalLoop && GoalLoop.stepOfTurn) return GoalLoop;
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') return require('./goalloop.js');
    return null;
  }
  function goalStepOf(m) { const g = goalLoopApi(); return g ? g.stepOfTurn(m) : null; }
  // the words a user turn stands for: a goal step stands for its goal, anything else for its own text
  function userWordsOf(m) { const g = goalStepOf(m); return g != null ? g : m.content; }

  // ---------- titles ----------
  function deriveTitle(text) {
    let t = String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
    if (!t) return null;
    t = (t.split(/[.!?\n]/)[0] || t).trim() || t;   // first sentence
    const CAP = 60;
    if (t.length <= CAP) return t;
    let cut = t.slice(0, CAP);
    const sp = cut.lastIndexOf(' ');
    if (sp > 0) cut = cut.slice(0, sp);             // never cut mid-word
    return cut.replace(/[\s,.;:!?-]+$/, '') + '…';
  }
  // SMALL-TALK DETECTOR: true when every word of the message is greeting/ack filler ("hey", "good
  // morning", "how are you", "ok thanks") — i.e. there is nothing here a title could be made OF.
  // One content word ("hey, research keyboards") flips the message substantive.
  const FILLER_WORD = /^(?:h+e+y+a*|h+i+y*a*|he+l+o+|yo+|su+p+|howdy|hola|greetings|gm|gn|good|morning|afternoon|evening|night|day|there|and|or|so|well|just|whats|what's|up|new|how|hows|how's|are|is|it|its|it's|going|goes|you|ya|u|r|doing|been|wyd|hbu|wbu|test|testing|ping|ok+|o+k+a+y+|k+|cool|nice|great|awesome|sweet|wow|lol|lmao|ha+|he+h+e*|hm+|mm+|um+|uh+|yes|yea+h*|yep|yup|no+|nah|nope|sure|thanks|thank|thx|ty|tysm|please|pls|plz|dude|bro|man|buddy|friend|wassup|anyone|anybody|home)$/;
  function isLowSignal(text) {
    const t = String(text == null ? '' : text).toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return true;
    return t.split(' ').every(w => FILLER_WORD.test(w));
  }

  // What a model title should be written FROM: a compact digest of the session's SUBSTANTIVE user
  // messages (small-talk filler skipped) — the founding directive plus the latest turns, so the title
  // names what the session became, not whatever pleasantry happened to open it. Returns null when the
  // session holds no substance yet: the caller must NOT spend a model call — the instant placeholder
  // stays (an honest "hey" beats a minted "Casual Greeting Exchange" that locks in forever).
  function titleBasis(id, fallbackText) {
    const w = find(id);
    if (w && w.historyRef) return null;   // part of the conversation is packed and not read yet: a title is never made of half of it
    // a goal step counts as its GOAL (never the station's continuation prompt): a /goal session is titled from what it is for
    const msgs = w ? (w.history || []).filter(m => m && m.role === 'user' && typeof m.content === 'string').map(userWordsOf) : [];
    let subs = msgs.filter(t => !isLowSignal(t));
    if (fallbackText != null) fallbackText = userWordsOf({ role: 'user', content: String(fallbackText) });
    if (!subs.length && fallbackText != null && !isLowSignal(fallbackText)) subs = [String(fallbackText)];
    if (!subs.length) return null;
    const pick = [];
    for (const t of [subs[0]].concat(subs.slice(-2))) if (pick.indexOf(t) < 0) pick.push(t);
    return pick.map(t => t.replace(/\s+/g, ' ').trim().slice(0, 300)).join('\n');
  }

  // name an untitled, non-General stream from its first user message (no-op otherwise). This is the INSTANT
  // placeholder (first-sentence truncation); retitle() later upgrades it to a model-written summary.
  function autoTitle(id, text) {
    const w = find(id);
    if (!w || w.id === generalId || w.title != null) return false;
    const tt = deriveTitle(text);
    if (!tt) return false;
    w.title = tt; w.titleAuto = true; return true;
  }
  // is this stream still wearing its MACHINE-DERIVED placeholder (deriveTitle of its first user message)?
  // true => eligible for the model summary upgrade. Covers more than the first turn: a session whose first
  // upgrade attempt failed (network hiccup / unparseable model reply) or one saved by a pre-upgrade build
  // retries on its next completed turn instead of wearing the truncated first-words title forever. A manual
  // rename (titleAuto === false) — even to the exact placeholder text — always wins; General never titles.
  function needsModelTitle(id) {
    const w = find(id);
    if (!w || w.id === generalId || w.titleAuto === false || w.title == null) return false;
    if (w.titleStrong) return false;   // already model-titled from real content — the ladder's terminal rung
    if (w.historyRef) return false;    // its first message may be in a packed run not read yet: the title waits for the whole conversation
    const first = (w.history || []).find(m => m && m.role === 'user' && typeof m.content === 'string');
    if (!first) return false;
    if (w.title === deriveTitle(userWordsOf(first))) return true;   // a goal step's placeholder was derived from its goal
    // HEAL a weak model title: a session OPENED with small talk wears whatever the model made of "hey"
    // (pre-upgrade builds minted "Casual Greeting Exchange"-style titles from it). Once the session
    // holds a substantive user message, it earns one upgrade pass — which lands strong and stops here.
    return isLowSignal(first.content)
      && (w.history || []).some(m => m && m.role === 'user' && typeof m.content === 'string' && !isLowSignal(m.content));
  }
  // UPGRADE an auto-derived placeholder to a concise model-written summary (chat.js fires this once, after a
  // new stream's first run, passing a 3-6 word LLM title). Honors the human: a stream whose title was MANUALLY
  // renamed (titleAuto === false) is never stomped, and General is never titled. Returns false (no change) when
  // locked / General / the summary is empty — so a model hiccup just leaves the instant placeholder in place.
  function retitle(id, title, strong) {
    const w = find(id);
    if (!w || w.id === generalId || w.titleAuto === false) return false;
    const tt = clamp(String(title == null ? '' : title).trim().replace(/\s+/g, ' '), 80);
    if (!tt) return false;
    w.title = tt; w.titleAuto = true;
    if (strong) w.titleStrong = true;   // written from substantive content — no further auto passes
    return true;
  }

  // ---------- runs · deliverables · cost (filed onto the stream that spawned them) ----------
  // `at` (optional, epoch ms): the run's REAL event time. A live caller omits it (now IS the event); a
  // backfill/heal caller that learned about an already-finished run passes the run record's end time, so
  // the rail's "last worked" stamp never reads as boot/poll time (timestamp-honesty law, 2026-07-19).
  // Recovery may insert an older run before a known newer one; that history cannot change current activity or outcome.
  function appendRun(id, runId, at, beforeRunId) {
    const w = find(id); if (!w || !runId) return false;
    // tolerate dup / no-op runs (e.g. the no-tool-support early error); only a NEW run resets the
    // outcome to unknown — a dup re-file of an already-settled run must not erase its truth.
    if (w.runIds.indexOf(runId) < 0) {
      const before = beforeRunId ? w.runIds.indexOf(beforeRunId) : -1;
      if (before >= 0) { w.runIds.splice(before, 0, runId); return true; }
      w.runIds.push(runId); w.lastRunOk = null; w.lastRunReason = '';
    }
    if (w.lane === 'todo') w.lane = 'active';                // hybrid-honest: a REAL run fired
    w.lastActiveAt = Number(at) > 0 ? Number(at) : now();
    if (id === activeId) w.lastReadAt = w.lastActiveAt;      // the open stream is being watched, not unread
    return true;
  }
  // settle the REAL outcome of a finished run (chat.js's two terminal branches call this): ok=false only
  // when the run errored in flight, ok=true when the stream completed. Only the stream's CURRENT (last-filed)
  // run may settle the flag — a stale callback from an older run is refused so it can never overwrite the
  // newer run's truth, and an outcome with no filed run is unanchored and refused too.
  function noteRunEnd(id, runId, ok, reason) {
    const w = find(id); if (!w || !runId) return false;
    if (!w.runIds.length || w.runIds[w.runIds.length - 1] !== runId) return false;
    w.lastRunOk = ok === true ? true : (ok === null ? null : false);   // null: a deliberate Stop — no verdict, its reason recorded
    if (typeof reason === 'string' && reason.trim()) w.lastRunReason = clamp(reason.trim(), 80);
    return true;
  }
  /* A FILE A RUN WROTE (the chips a reload replays). One record per file: the same run and the same exact path (TurnKinds.sameDeliverable) is
     one file however many times it is filed, so the live chip, the station's canonical row (TurnMerge.deliverableOf) and a re-filing all
     land on one record. A record also carries what only some of them know: the writing agent when it is not the session's (agentId), the
     project root its relative path lives under (root) and the station's row id (rowId); a second filing adds what the first lacked.
     true = a new record; false = the file was already filed. */
  function adoptDeliverable(held, d) {
    if (typeof d.agentId === 'string' && d.agentId && held.agentId == null) held.agentId = d.agentId;
    if (typeof d.root === 'string' && d.root && held.root == null) held.root = d.root;
    if (Number.isSafeInteger(d.rowId) && d.rowId > 0 && held.rowId == null) held.rowId = d.rowId;
  }
  function recordDeliverable(id, d) {
    const w = find(id); if (!w || !d) return false;
    const rec = { title: String(d.title || ''), kind: d.kind || 'file', runId: d.runId || null, t: d.t || now() };
    const held = rec.runId ? w.deliverables.find(r => TurnKinds.sameDeliverable(r, rec)) : null;
    adoptDeliverable(held || rec, d);
    if (held) return false;
    w.deliverables.push(rec);
    return true;
  }
  // is this file (same run, same exact path) already in the stream's ledger? A hit takes the agent, root and row id the caller knows
  function knownDeliverable(id, d) {
    const w = find(id); if (!w || !d) return false;
    const held = w.deliverables.find(r => TurnKinds.sameDeliverable(r, d));
    if (held) adoptDeliverable(held, d);
    return !!held;
  }
  // accumulate a per-stream usage delta (chat.js passes a copy-snapshotted Harness.totals() diff).
  function addCost(id, delta) {
    const w = find(id); if (!w || !delta) return false;
    w.cost.tokens += +delta.tokens || 0;
    w.cost.usd += +delta.usd || 0;
    w.cost.calls += +delta.calls || 0;
    return true;
  }
  function costOf(id) { const w = find(id); return w ? { tokens: w.cost.tokens, usd: w.cost.usd, calls: w.cost.calls } : zeroCost(); }
  // file the model the sidecar REPORTED for this stream's latest run (chat.js reads it off the usage
  // payload, which is the harness's own measurement — never the local model dropdown). An empty/absent
  // model is refused rather than stored as '' so a usage event that omitted the field can't erase a
  // model we already measured.
  function noteModel(id, model) {
    const w = find(id); if (!w) return false;
    const m = String(model == null ? '' : model).trim();
    if (!m) return false;
    w.lastModel = clamp(m, 60);
    return true;
  }
  function modelOf(id) { const w = find(id); return w ? (w.lastModel || '') : ''; }

  // A conversation belongs to its lead, group members, and the workers whose work it holds. Worker
  // records stay hidden: CREW and search show their parent conversation, with the parent's archive state.
  // Historical participation remains after a run settles; deleting the worker record removes that link.
  function hasAgent(w, agentId, membersOf) {
    if (!w || !agentId) return false;
    if ((w.agentId || 'agent') === agentId) return true;
    if (!delegatedAgents) {
      delegatedAgents = new Map();
      for (const child of ws) {
        if (child.worker !== true || !child.parentStreamId || child.parentStreamId === child.id) continue;
        if (!delegatedAgents.has(child.parentStreamId)) delegatedAgents.set(child.parentStreamId, new Set());
        delegatedAgents.get(child.parentStreamId).add(child.agentId || 'agent');
      }
    }
    if (delegatedAgents.get(w.id)?.has(agentId)) return true;
    if (w.conversationMode !== 'group' || typeof membersOf !== 'function') return false;
    const members = membersOf(w.id);
    return Array.isArray(members) && members.includes(agentId);
  }
  // ---------- session power tools: visible search/export + reversible cleanup ----------
  // Only actual Commander/agent dialogue belongs in search or export. Local/system records can contain
  // prompts, recovery markers, tool metadata, or other implementation state and must never leak through
  // a user-facing transcript surface.
  const isVisibleMessage = m => !!(m && !m.sys && !m.hidden && !m.internal
    && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
    && TurnKinds.MATRIX[TurnKinds.classify(m).cell].display === true);
  function visibleMessages(w) {
    return ((w && Array.isArray(w.history)) ? w.history : []).filter(isVisibleMessage);
  }
  // the last message visibleMessages(w) holds whose text is not blank — read from the END, so the rail's 1s
  // heartbeat costs a few rows per session instead of a copy of every session's whole history (2026-10-07)
  function latestVisibleMessage(w) {
    const h = (w && Array.isArray(w.history)) ? w.history : [];
    if (w && w.historyRef) {
      // a session whose rows are not all read: only a row pushed since boot (after every packed row) or the packed form's own proof
      // of its newest message can be named; an older inline row would be a stale line, so it is never taken for the latest
      const inline = infoOf(w.historyRef).set;
      for (let i = h.length - 1; i >= 0 && !inline.has(h[i]); i--) if (isVisibleMessage(h[i]) && h[i].content.trim()) return h[i];
      const proven = w.historyDigest && w.historyDigest.latest;
      return proven && h.includes(proven) ? proven : null;   // (a row the page has since dropped is not a line to show)
    }
    for (let i = h.length - 1; i >= 0; i--) if (isVisibleMessage(h[i]) && h[i].content.trim()) return h[i];
    return null;
  }

  // ---------- packed histories: what a session holds before its named rows are read back, and the hydrate seam ----------
  const idOrRecord = x => (x && typeof x === 'object') ? x : find(x);
  // does the session hold any row at all — one the page keeps, or one a packed run names? (the empty-state / blank-session tests)
  function hasHistory(w) { w = idOrRecord(w); return !!w && (!!w.historyRef || (Array.isArray(w.history) && w.history.length > 0)); }
  // how many rows the session holds, packed ones included
  function turnCount(w) { w = idOrRecord(w); return !w ? 0 : (w.historyRef ? countPacked(composedHistory(w)) : (Array.isArray(w.history) ? w.history.length : 0)); }
  // has the Commander said anything here? A packed run is user and assistant rows, so a session holding one has started
  function hasUserTurn(w) { w = idOrRecord(w); return !!w && (!!w.historyRef || (Array.isArray(w.history) && w.history.some(m => m && m.role === 'user'))); }
  // is part of the session's history still packed, i.e. named by row id and not read back?
  function needsHydration(w) { w = idOrRecord(w); return !!(w && w.historyRef); }
  // the ids of the sessions that still need it, the most recently active first (the idle pass reads them in this order)
  function pendingHydration() {
    return ws.filter(w => w.historyRef).sort((a, b) => (+b.lastActiveAt || 0) - (+a.lastActiveAt || 0)).map(w => w.id);
  }
  /* Put the rows read back for a session's packed runs into it. `expanded` is HistoryRef.expand(historyRef).rows: the packed history
     with every run the station returned laid out as rows, in place, and every run it could not left as its element (so it stays packed
     and is saved as it was). opts.ref is the packed form the caller expanded: when the session no longer holds that very one (it was
     cleared, undone or replaced while the rows were out) nothing is put back — a read can never bring back what the Commander removed.
     The rows the page holds that the packed form did not name (pushed since boot) follow the expanded ones; an inline row the page
     dropped meanwhile stays dropped. Returns false when nothing could be put back (no such session, not packed, or a stale read). */
  function hydrate(id, expanded, opts) {
    const w = idOrRecord(id);
    if (!w || !w.historyRef || !Array.isArray(expanded)) return false;
    const ref = w.historyRef;
    if (opts && opts.ref && opts.ref !== ref) return false;
    const info = infoOf(ref), h = Array.isArray(w.history) ? w.history : [], kept = new Set(h);
    const next = expanded.filter(el => !info.set.has(el) || kept.has(el));
    // the station returned nothing: every run is still the element it was (expand makes a new, equal one for a run it left packed)
    if (next.length === ref.length && next.every((el, i) => el === ref[i] || (isPacked(el) && isPacked(ref[i]) && JSON.stringify(el) === JSON.stringify(ref[i])))) return true;
    const added = h.filter(r => !info.set.has(r));
    w.history = next.filter(el => !isPacked(el)).concat(added);
    if (next.some(isPacked)) setPacked(w, next); else clearPacked(w);
    return true;
  }
  // Replace a session's whole history (a transcript fold, a group chat's server copy): the rows it named are replaced with it, never kept beside it
  function setHistory(id, rows) {
    const w = idOrRecord(id);
    if (!w || !Array.isArray(rows)) return false;
    installHistory(w, rows);
    return true;
  }
  // The one reader of a packed history chat.js registers (hydrateHistory), so a module that needs the whole conversation can ask for it.
  let hydrator = null;
  function setHydrator(fn) { hydrator = typeof fn === 'function' ? fn : null; }
  /* Everything that names a session's rows and runs, for a purge ("forgotten everywhere"): hydrates first, because an unhydrated
     session's packed runs hold run ids the page does not have. -> Promise<{ streamId, runIds, rowIds, complete }>; `complete` is false
     when part of the history could not be read (its row ids are still named, its run ids are not known). */
  async function sourceIdsOf(id) {
    const w = idOrRecord(id);
    if (!w) return { streamId: '', runIds: [], rowIds: [], complete: true };
    if (w.historyRef && hydrator) { try { await hydrator(w); } catch (_) { /* the ids below say what is still packed */ } }
    const runIds = new Set((w.runIds || []).map(String)), rowIds = new Set();
    for (const r of Array.isArray(w.history) ? w.history : []) {
      if (!r) continue;
      if (r.sourceRunId) runIds.add(String(r.sourceRunId));
      if (Number.isSafeInteger(r.rowId) && r.rowId > 0) rowIds.add(r.rowId);
    }
    if (w.historyRef && HistoryRef && HistoryRef.idsOf) for (const rid of HistoryRef.idsOf(w.historyRef)) rowIds.add(rid);
    return { streamId: w.id, runIds: [...runIds], rowIds: [...rowIds].sort((a, b) => a - b), complete: !w.historyRef };
  }

  const SECRET_RES = [
    /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    /\b(?:xox[baprs]-|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{10,}\b/g,
    /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi,
    /\b[A-Fa-f0-9]{32,}\b/g
  ];
  function scrubSecrets(s) {
    let out = String(s == null ? '' : s);
    for (const re of SECRET_RES) out = out.replace(re, '[redacted]');
    return out;
  }
  // the exported file's heading / name and the search title are the name the rail shows (titleOf): an untitled
  // session exports as "New session", never as a second "General"
  function safeTitle(w) { return scrubSecrets(titleOf(w) || 'New session'); }

  function exportConversation(id, format, opts) {
    const w = find(id); if (!w) return null;
    if (w.historyRef) return null;   // never a file made of the rows the page happens to hold: the caller reads the rest back first (chat.js hydrateHistory)
    opts = opts || {};
    const title = safeTitle(w);
    // a goal step keeps its record (role + the prompt the model received) and is NAMED as one: the readable export writes it
    // as the station's line, never under "## Commander" (org P29-sys wiring)
    /* opts.rows = the station's DISPLAY view of this session (GET /api/transcript): the rows it will still show after any delete - a reply that quotes a
       deleted session is not in it. The page's own copy may still hold such a row, so an export reads the display view whenever the station answered;
       without it (an older station, a session the store never held) the page history is exported minus any row that carries a quote stamp. */
    const shown = Array.isArray(opts.rows)
      ? opts.rows.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim() && (!m.kind || m.kind === 'turn'))
      : visibleMessages(w).filter(m => !(Array.isArray(m.quotes) && m.quotes.length));
    const messages = shown.map(m => {
      const out = { role: m.role, content: scrubSecrets(m.content) };
      const step = goalStepOf(m);
      if (step != null) out.goalStep = scrubSecrets(step);
      return out;
    });
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'general';
    if (format === 'json') {
      const doc = { schema: 'starnet.conversation', version: 1, exportedAt: opts.exportedAt != null ? opts.exportedAt : now(), title, messages, secretsIncluded: false };
      return { format: 'json', mime: 'application/json', filename: 'starnet-' + slug + '.json', text: JSON.stringify(doc, null, 2), doc };
    }
    const lines = ['# ' + title, '', '_Exported from StarNet. Hidden/system data and obvious credentials are excluded._', ''];
    for (const m of messages) {
      if (m.goalStep != null) { lines.push('## Station', '', 'Goal step: ' + m.goalStep, ''); continue; }
      lines.push('## ' + (m.role === 'user' ? 'Commander' : 'Agent'), '', m.content, '');
    }
    return { format: 'markdown', mime: 'text/markdown', filename: 'starnet-' + slug + '.md', text: lines.join('\n') };
  }
  /* what a delete of a session leaves in the page (commit 16): the runs it held (and its delegated workers' runs) and the attachment files its
     messages name. The page purges the beliefs learned from those runs and asks the station to delete the files no other session names. */
  function runIdsOf(id) {
    const w = find(id); if (!w) return [];
    const out = [];
    for (const x of ws) if (x.id === id || (x.worker === true && x.parentStreamId === id)) for (const r of (Array.isArray(x.runIds) ? x.runIds : [])) if (typeof r === 'string' && out.indexOf(r) < 0) out.push(r);
    return out;
  }
  // the files a session's messages name, as this page holds them: its rows and a packed run's residue. A packed run is not in x.history until it
  // is read back, and a row from before 0.15 names its files only in that residue (the transcript row behind it names none)
  function attachmentsOf(x) {
    const out = [];
    const add = m => { for (const a of (Array.isArray(m && m.attachments) ? m.attachments : [])) out.push(a); };
    for (const m of (Array.isArray(x.history) ? x.history : [])) add(m);
    for (const el of (Array.isArray(x.historyRef) ? x.historyRef : [])) {
      if (!isPacked(el)) continue;
      add(el);   // a stub holds its row's residue on itself
      if (el.res && typeof el.res === 'object') for (const k of Object.keys(el.res)) add(el.res[k]);
    }
    return out;
  }
  function attachmentRefs(id) {
    const w = find(id); if (!w) return [];
    const out = [];
    for (const x of ws) if (x.id === id || (x.worker === true && x.parentStreamId === id)) {
      for (const a of attachmentsOf(x)) {
        if (a && typeof a.path === 'string' && a.path && !out.some(o => o.path === a.path && o.agent === (x.agentId || 'agent'))) out.push({ path: a.path, agent: x.agentId || 'agent' });
      }
    }
    return out;
  }
  // does any session still in the list name this file? (a branch copy or a re-send shares one upload with the session it came from)
  function attachmentInUse(path, agent) {
    for (const x of ws) for (const a of attachmentsOf(x)) {
      if (a && a.path === path && (x.agentId || 'agent') === agent) return true;
    }
    return false;
  }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function normalizeCheckpoint(c) {
    if (!c || (c.kind !== 'clear' && c.kind !== 'archive') || !Array.isArray(c.rows)) return null;
    return { kind: c.kind, at: +c.at || 0, rows: clone(c.rows), activeId: c.activeId || null, count: c.rows.length };
  }
  function clearConversation(id, opts) {
    const w = find(id); if (!w || !hasHistory(w)) return null;
    opts = opts || {};
    // the checkpoint keeps the history as the save carries it (a packed run stays one element), so an undo puts back exactly what was cleared
    undoCheckpoint = normalizeCheckpoint({ kind: 'clear', at: opts.at != null ? opts.at : now(), activeId, rows: [{ id, history: clone(composedHistory(w)) }] });
    w.history = [];
    clearPacked(w);   // the rows it named are cleared with it: a read that was out for them must find nothing to put back
    w.lastActiveAt = opts.at != null ? opts.at : now();
    if (id === activeId) w.lastReadAt = w.lastActiveAt;
    return clone(undoCheckpoint);
  }
  function criteriaOf(input) {
    input = input || {};
    return { empty: !!input.empty, completed: !!input.completed, olderThanMs: Math.max(0, +input.olderThanMs || 0), includePinned: !!input.includePinned };
  }
  function hashPreview(criteria, stamp, ids) {
    const s = JSON.stringify(criteria) + '|' + stamp + '|' + ids.join(',');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return 'pv_' + (h >>> 0).toString(16);
  }
  function previewArchive(input, opts) {
    const criteria = criteriaOf(input); opts = opts || {};
    const stamp = opts.now != null ? +opts.now : now();
    const ids = ws.filter(w => {
      if (w.id === generalId || w.archived || (!criteria.includePinned && w.pinned)) return false;
      const empty = criteria.empty && !w.historyRef && visibleMessages(w).length === 0 && w.runIds.length === 0 && w.deliverables.length === 0;   // a packed run is messages, not a blank
      const complete = criteria.completed && w.lane === 'shipped';
      const old = criteria.olderThanMs > 0 && (+w.lastActiveAt || 0) <= stamp - criteria.olderThanMs;
      return empty || complete || old;
    }).map(w => w.id).sort();
    return { criteria, now: stamp, ids, count: ids.length, token: hashPreview(criteria, stamp, ids) };
  }
  function archivePreview(preview, opts) {
    if (!preview || !Array.isArray(preview.ids)) return null;
    const fresh = previewArchive(preview.criteria, { now: preview.now });
    if (fresh.token !== preview.token || JSON.stringify(fresh.ids) !== JSON.stringify(preview.ids)) return null;
    opts = opts || {};
    const rows = fresh.ids.map(id => ({ id, archived: !!find(id).archived }));
    undoCheckpoint = normalizeCheckpoint({ kind: 'archive', at: opts.at != null ? opts.at : now(), activeId, rows });
    for (const id of fresh.ids) archive(id, true);
    return { kind: 'archive', ids: fresh.ids.slice(), count: fresh.ids.length };
  }
  function canUndo() { return !!undoCheckpoint; }
  function undoLast() {
    const cp = undoCheckpoint; if (!cp) return false;
    if (cp.kind === 'clear') {
      for (const row of cp.rows) { const w = find(row.id); if (w && Array.isArray(row.history)) installHistory(w, clone(row.history)); }
    } else {
      for (const row of cp.rows) { const w = find(row.id); if (w) w.archived = !!row.archived; }
    }
    if (cp.activeId && find(cp.activeId) && !find(cp.activeId).archived) activeId = cp.activeId;
    undoCheckpoint = null;
    return true;
  }

  // ---------- search (title + visible message bodies; client-side, localStorage scale) ----------
  function search(q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return [];
    const out = [], seen = new Set();
    for (const w of ws) {
      // a delegated worker's words are found, but the hit is its CONVERSATION (workerId says whose work it is)
      const hidden = isHidden(w);
      const title = safeTitle(w), ti = title.toLowerCase().indexOf(q);
      if (!hidden && ti >= 0) { if (!seen.has(w.id)) { seen.add(w.id); out.push({ id: w.id, title: w.title, snippet: 'title match', match: 'title' }); } continue; }
      for (const m of visibleMessages(w)) {
        // Most queries do not occur in most turns. Check the raw text first so a miss does not pay
        // for every credential-redaction regex across the whole session archive. A raw candidate is
        // still scrubbed and checked again before it can become a hit: text inside a secret remains
        // unsearchable and snippets remain safe.
        const raw = m.content, rawIndex = raw.toLowerCase().indexOf(q); if (rawIndex < 0) continue;
        const body = scrubSecrets(raw), i = body.toLowerCase().indexOf(q); if (i < 0) continue;
        const start = Math.max(0, i - 20), snippet = body.slice(start, start + 60).replace(/\s+/g, ' ').trim();
        if (hidden) {
          const home = find(w.parentStreamId);
          if (!seen.has(home.id)) { seen.add(home.id); out.push({ id: home.id, title: home.title, snippet, match: 'delegated', workerId: w.id }); }
        } else if (!seen.has(w.id)) { seen.add(w.id); out.push({ id: w.id, title: w.title, snippet, match: 'transcript' }); }
        break;
      }
    }
    return out;
  }

  // ---------- migrations / imports (pure; save.js + stationui.js delegate here) ----------
  // starnet.save v1 { agent, history, usage } -> the v2 workstreams slice. The entire legacy
  // conversation becomes a single General stream; its cost is SEEDED from the existing lifetime
  // usage so the per-stream number matches reality (nothing invented). agent + lifetime usage stay
  // at the envelope root (save.js merges this slice in) — they remain the billing source of truth.
  function migrateV1(doc) {
    doc = doc || {};
    const u = doc.usage || {};
    const t = doc.updatedAt || now();
    const general = make({
      id: 'ws_general', title: null, lane: 'active',
      history: Array.isArray(doc.history) ? doc.history : [],
      cost: { tokens: +u.tokens || 0, usd: +u.cost || 0, calls: +u.calls || 0 },
      createdAt: t, lastActiveAt: t
    });
    return { workstreams: [general], activeId: general.id, generalId: general.id };
  }

  // one-shot import of the legacy station kanban tasks[] into real workstreams (col -> lane,
  // empty history). The caller (slice 3) guards this to run exactly once, then clears tasks[].
  // Every legacy kanban card was a BOARD card, so kind is passed explicitly: without it, make()'s
  // lane inference read a 'doing' card (lane active) as kind:'chat' and silently dropped it off
  // the board it was being imported onto.
  function importTasks(tasks) {
    const created = (Array.isArray(tasks) ? tasks : []).map(tk => make({
      title: (tk && tk.title) || null,
      lane: LANE_OF_COL[tk && tk.col] || 'todo',
      kind: 'task',
      createdAt: (tk && tk.t) || now(), lastActiveAt: (tk && tk.t) || now()
    }));
    for (const w of created) ws.push(w);
    return created;
  }

  function automationOf(w) {
    if (w.automation) return w.automation;
    if (String(w.id).startsWith('cron-')) return { kind: 'routine', id: '', name: 'Scheduled run' };
    // (2026-10-02, Andrew: the 'Away builds' rail fold is old UI) — an away build stays tagged as automation, but with
    // no group id it lists as an ordinary session row, never folded under a header
    if (String(w.id).startsWith('workshop-')) return { kind: 'workshop', id: '', name: 'Away build' };
    if (w.goalLoop) return { kind: 'loop', id: w.id, name: w.title || 'Goal loop' };
    return null;
  }

  // A display projection only: never merges, archives or deletes underlying sessions.
  function railGroups(rows, options) {
    const opts = options || {}, expanded = new Set(opts.expanded || []), urgent = new Set(opts.urgent || []);
    const groups = new Map(), result = [];
    for (const w of rows) {
      const auto = automationOf(w), keep = w.id === opts.activeId || w.pinned || w.lastRunOk === false || urgent.has(w.id);
      // AUTOMATED means automation only. Pending responses remain reachable through session attention.
      if (opts.view === 'automated' && !auto) continue;
      if (!auto || !auto.id) {
        if (!keep && ((opts.view === 'conversations' && auto) || (opts.view === 'automated' && !auto))) continue;
        result.push({ type: 'session', w }); continue;
      }
      const key = JSON.stringify([auto.kind, auto.id, w.agentId]);
      let group = groups.get(key);
      if (!group) {
        group = { type: 'group', key, name: auto.name || w.title || 'Automated work', agentId: w.agentId, rows: [], visible: [] };
        groups.set(key, group); result.push(group);
      }
      group.rows.push(w);
      if (keep) group.visible.push(w);
    }
    groups.forEach(group => {
      const latest = group.rows.reduce((a, b) => (+b.lastActiveAt || 0) > (+a.lastActiveAt || 0) ? b : a);
      const included = opts.view !== 'conversations' || group.visible.length > 0;
      group.visible = included ? group.rows.filter(w => expanded.has(group.key) || (opts.view !== 'conversations' && w === latest) || group.visible.includes(w)) : [];
    });
    return result.filter(item => item.type === 'session' || item.visible.length);
  }


  // A run preview cannot prove the end of a recovered answer. Both conversation recovery and
  // delegated receipts use this identity/completeness check before reserving its run id.
  async function finalDeliveryText(row, turns) {
    const d = row && row.dispatchDelivery;
    if (!d || d.state !== 'final') return null;
    const preview = String(d.text || '');
    const t = (turns || []).find(t => t && t.role === 'assistant' && t.dispatchState === 'final'
      && t.sourceRunId === row.runId && t.streamId === row.streamId && typeof t.content === 'string');
    if (!t || !t.content.startsWith(preview)) return null;
    if (d.textLength == null && d.textSha256 == null) {
      // Older projections were silently capped here; they cannot prove completion at that boundary.
      return t.content.length < 200000 ? t.content : null;
    }
    if (!Number.isSafeInteger(d.textLength) || t.content.length !== d.textLength
      || !/^[a-f0-9]{64}$/.test(d.textSha256 || '')
      || t.textLength !== d.textLength || t.textSha256 !== d.textSha256) return null;
    try {
      let hash;
      try {
        if (globalThis.crypto && globalThis.crypto.subtle) {
          const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(t.content));
          hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
        }
      } catch (_) { /* a browser without a usable native digest can use the same byte-tested JS digest */ }
      if (!hash && typeof ApiTicket !== 'undefined' && ApiTicket.sha256Text) hash = ApiTicket.sha256Text(t.content);
      return hash === d.textSha256 ? t.content : null;
    } catch (_) { return null; }
  }

  return {
    init, reset, serialize, all, list, search, setConnectorHandoff, connectorHandoff, automationOf, railGroups,
    exportConversation, clearConversation, attachmentRefs, attachmentInUse, runIdsOf,
    previewArchive, archivePreview, canUndo, undoLast,
    create, startSession, isUntouched, adopt, get, active, activeId: getActiveId, generalId: getGeneralId, isHidden, homeOf, titleOf,
    switch: switchTo, rename, setAgent, setLane, setProjectRoot, pin, archive, del, removeByAgent, isDeleted, touch, markUnread, markRead, unread: isUnread,
    autoTitle, retitle, deriveTitle, needsModelTitle, isLowSignal, titleBasis,
    finalDeliveryText, appendRun, noteRunEnd, recordDeliverable, knownDeliverable, addCost, costOf, noteModel, modelOf,
    // the rail's INBOX row reads these directly: the same sys/hidden/internal filter search and
    // export already trust, so the count and the preview can never surface machine chatter.
    visibleMessages, latestVisibleMessage, hasAgent,
    // PACKED HISTORIES (see the header): what a session holds before its named rows are read back, and the seam that reads them
    hasHistory, turnCount, hasUserTurn, needsHydration, pendingHydration, hydrate, setHistory, setHydrator, sourceIdsOf,
    sealTurns, sealed, unseal, sealCandidates, noteSealRead,
    migrateV1, importTasks,
    LANES
  };
});
