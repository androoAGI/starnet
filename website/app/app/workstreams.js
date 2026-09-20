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
     'shipped' is only ever set by a deliberate human turn-in via setLane. A lane can't lie. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Workstreams = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LANES = ['todo', 'active', 'shipped'];
  const LANE_OF_COL = { todo: 'todo', doing: 'active', done: 'shipped' };  // station kanban col -> lane

  // ---------- internal store (the single source of truth for sessions) ----------
  let ws = [];          // Workstream[]
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

  // frontend module: ambient time/rng is fine here (lint-determinism scans only shared/ + sidecar/).
  function now() { return Date.now(); }
  function uid() { return 'ws_' + now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
  function clamp(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }
  function zeroCost() { return { tokens: 0, usd: 0, calls: 0 }; }
  function find(id) { for (const w of ws) if (w.id === id) return w; return null; }

  // The one canonical Workstream shape. Idempotent on an already-formed record (ids/timestamps
  // are preserved), so init() can re-normalize a saved slice without reshaping it.
  function make(opts) {
    opts = opts || {};
    const t = opts.t || opts.createdAt || now();
    const c = opts.cost || {};
    const lane = LANES.indexOf(opts.lane) >= 0 ? opts.lane : 'todo';
    return {
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
      parentStreamId: opts.parentStreamId ? String(opts.parentStreamId) : null,
      projectHome: opts.projectHome === true,
      history: Array.isArray(opts.history) ? opts.history.slice() : [],
      runIds: Array.isArray(opts.runIds) ? opts.runIds.slice() : [],
      connectorHandoff: normalizeConnectorHandoff(opts.connectorHandoff),
      // outcome of the stream's MOST RECENT run: true = it completed (in-band stream finished, even via a
      // stop/cut-short), false = it DIED in flight (chat.js's in-band `error` branch), null = unknown — no
      // run yet, a run currently in flight (appendRun resets it), or a pre-upgrade save. The board's DONE
      // chip reads this so a run that died can never wear "DONE — REVIEW & SHIP" (truthful telemetry).
      lastRunOk: opts.lastRunOk === true ? true : (opts.lastRunOk === false ? false : null),
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
  }

  function normalizeConnectorHandoff(value) {
    if (!value || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.connectorId || '') || !value.runId || !value.agentId) return null;
    return { connectorId: clamp(value.connectorId, 80), runId: clamp(value.runId, 120),
      agentId: clamp(value.agentId, 80), toolName: value.toolName === 'connectors.list' ? '' : clamp(value.toolName || '', 160) };
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
    tombs = Array.isArray(slice.deletedIds) ? slice.deletedIds.filter(x => typeof x === 'string' && x).slice(-MAX_TOMBS) : [];
    generalId = (slice.generalId && find(slice.generalId)) ? slice.generalId : null;
    ensureGeneral();
    activeId = (slice.activeId && find(slice.activeId)) ? slice.activeId : generalId;
    undoCheckpoint = normalizeCheckpoint(slice.sessionUndo);
    const a = active();
    if (a && (a.lastActiveAt || 0) > (a.lastReadAt || 0)) a.lastReadAt = a.lastActiveAt;   // boot renders it — read
    return a;
  }

  // wipe to a single fresh General (NEW AGENT clears everything).
  function reset() { ws = []; activeId = generalId = null; undoCheckpoint = null; tombs = []; const g = ensureGeneral(); activeId = g.id; return active(); }

  // the persisted slice — App.persist() serializes this alongside { agent, usage }.
  function serialize() { return { workstreams: ws, activeId, generalId, sessionUndo: undoCheckpoint, deletedIds: tombs }; }
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

  // display order: pinned first, then most-recently-active; archived hidden unless asked.
  function list(opts) {
    opts = opts || {};
    return ws.filter(w => opts.includeArchived ? true : !w.archived)
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
    const c = cur && cur.cost || {};
    const untouched = !!cur && cur.conversationMode !== 'group' && !cur.archived && cur.kind === 'chat' && cur.title == null
      && cur.titleAuto !== false && !cur.pinned && cur.roomId == null && !cur.goalLoop
      && (!cur.history || cur.history.length === 0)
      && (!cur.runIds || cur.runIds.length === 0)
      && (!cur.deliverables || cur.deliverables.length === 0)
      && !(+c.tokens || +c.usd || +c.calls)
      && sameScope;
    if (opts.reuseActive !== false && untouched) return cur;
    return create(null, opts);
  }
  // ADOPT a workstream with a CALLER-CHOSEN id (idempotent): if one already exists with opts.id it is
  // returned untouched; otherwise a new record is minted from opts and inserted WITHOUT stealing the active
  // stream (never sets activeId — the caller decides whether to focus it). This is the seam the autosessions
  // layer uses to surface an unattended cron run as a session keyed by its own 'cron-<runId>' stream id, so
  // the rail row and the durable server transcript share one identity. Returns the (existing or new) record.
  function adopt(opts) {
    opts = opts || {};
    if (opts.id) {
      const ex = find(opts.id); if (ex) {
        if (opts.automation) ex.automation = make(opts).automation;
        return ex;
      }
      // a DELETED id stays deleted: the boot-time resurrection paths (workshop pending poll, cron
      // backfill) must not re-mint a session the Commander removed. revive:true is the deliberate
      // human re-open (it clears the tombstone so the session behaves normally from then on).
      if (isDeleted(opts.id)) {
        if (opts.revive !== true) return null;
        tombs = tombs.filter(t => t !== opts.id);
      }
    }
    const w = make(opts);
    ws.push(w);
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
    w.agentId = agentId; return true;
  }
  function setLane(id, lane) { const w = find(id); if (!w || LANES.indexOf(lane) < 0) return false; w.lane = lane; return true; }
  // anchor (or re-anchor) a session to a blessed project root — the Projects rail's "Work here" stamps the
  // session it jumps into so the project row can truthfully list its sessions. null/'' clears the anchor.
  function setProjectRoot(id, root) { const w = find(id); if (!w) return false; w.projectRoot = root ? String(root) : null; return true; }
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
  function del(id) {
    if (id === generalId) return false;
    const i = ws.findIndex(w => w.id === id);
    if (i < 0) return false;
    ws.splice(i, 1);
    if (tombs.indexOf(id) < 0) { tombs.push(id); if (tombs.length > MAX_TOMBS) tombs = tombs.slice(-MAX_TOMBS); }
    if (activeId === id) activeId = generalId;
    return true;
  }
  // DOSSIER › DELETE AGENT support: drop every (non-General) stream bound to a now-deleted agent so the rail
  // can't reopen a stream with no agent behind it. General is never bound to a specialist, so it's untouched;
  // if the active stream was one of the removed, activeId falls back to General (via del). Returns the count.
  function removeByAgent(agentId) {
    const aid = String(agentId == null ? '' : agentId);
    if (!aid) return 0;
    let n = 0;
    for (const w of ws.slice()) { if (w.conversationMode !== 'group' && w.id !== generalId && w.agentId === aid && del(w.id)) n++; }
    return n;
  }

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
    const msgs = w ? (w.history || []).filter(m => m && m.role === 'user' && typeof m.content === 'string').map(m => m.content) : [];
    let subs = msgs.filter(t => !isLowSignal(t));
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
    const first = (w.history || []).find(m => m && m.role === 'user' && typeof m.content === 'string');
    if (!first) return false;
    if (w.title === deriveTitle(first.content)) return true;
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
  function appendRun(id, runId, at) {
    const w = find(id); if (!w || !runId) return false;
    // tolerate dup / no-op runs (e.g. the no-tool-support early error); only a NEW run resets the
    // outcome to unknown — a dup re-file of an already-settled run must not erase its truth.
    if (w.runIds.indexOf(runId) < 0) { w.runIds.push(runId); w.lastRunOk = null; }
    if (w.lane === 'todo') w.lane = 'active';                // hybrid-honest: a REAL run fired
    w.lastActiveAt = Number(at) > 0 ? Number(at) : now();
    if (id === activeId) w.lastReadAt = w.lastActiveAt;      // the open stream is being watched, not unread
    return true;
  }
  // settle the REAL outcome of a finished run (chat.js's two terminal branches call this): ok=false only
  // when the run errored in flight, ok=true when the stream completed. Only the stream's CURRENT (last-filed)
  // run may settle the flag — a stale callback from an older run is refused so it can never overwrite the
  // newer run's truth, and an outcome with no filed run is unanchored and refused too.
  function noteRunEnd(id, runId, ok) {
    const w = find(id); if (!w || !runId) return false;
    if (!w.runIds.length || w.runIds[w.runIds.length - 1] !== runId) return false;
    w.lastRunOk = ok === true;
    return true;
  }
  function recordDeliverable(id, d) {
    const w = find(id); if (!w || !d) return false;
    w.deliverables.push({ title: String(d.title || ''), kind: d.kind || 'file', runId: d.runId || null, t: d.t || now() });
    return true;
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

  // ---------- session power tools: visible search/export + reversible cleanup ----------
  // Only actual Commander/agent dialogue belongs in search or export. Local/system records can contain
  // prompts, recovery markers, tool metadata, or other implementation state and must never leak through
  // a user-facing transcript surface.
  function visibleMessages(w) {
    return ((w && Array.isArray(w.history)) ? w.history : []).filter(m => m && !m.sys && !m.hidden && !m.internal
      && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
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
  function safeTitle(w) { return scrubSecrets((w && w.title) || 'General'); }

  function exportConversation(id, format, opts) {
    const w = find(id); if (!w) return null;
    opts = opts || {};
    const title = safeTitle(w);
    const messages = visibleMessages(w).map(m => ({ role: m.role, content: scrubSecrets(m.content) }));
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'general';
    if (format === 'json') {
      const doc = { schema: 'starnet.conversation', version: 1, exportedAt: opts.exportedAt != null ? opts.exportedAt : now(), title, messages, secretsIncluded: false };
      return { format: 'json', mime: 'application/json', filename: 'starnet-' + slug + '.json', text: JSON.stringify(doc, null, 2), doc };
    }
    const lines = ['# ' + title, '', '_Exported from StarNet. Hidden/system data and obvious credentials are excluded._', ''];
    for (const m of messages) lines.push('## ' + (m.role === 'user' ? 'Commander' : 'Agent'), '', m.content, '');
    return { format: 'markdown', mime: 'text/markdown', filename: 'starnet-' + slug + '.md', text: lines.join('\n') };
  }
  function parseConversationExport(text) {
    let doc;
    try { doc = JSON.parse(String(text || '')); } catch (_) { return null; }
    if (!doc || doc.schema !== 'starnet.conversation' || doc.version !== 1 || !Array.isArray(doc.messages)) return null;
    const messages = doc.messages.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: scrubSecrets(m.content) }));
    return { title: scrubSecrets(doc.title || 'General'), messages, secretsIncluded: false };
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function normalizeCheckpoint(c) {
    if (!c || (c.kind !== 'clear' && c.kind !== 'archive') || !Array.isArray(c.rows)) return null;
    return { kind: c.kind, at: +c.at || 0, rows: clone(c.rows), activeId: c.activeId || null, count: c.rows.length };
  }
  function clearConversation(id, opts) {
    const w = find(id); if (!w || !w.history.length) return null;
    opts = opts || {};
    undoCheckpoint = normalizeCheckpoint({ kind: 'clear', at: opts.at != null ? opts.at : now(), activeId, rows: [{ id, history: clone(w.history) }] });
    w.history = [];
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
      const empty = criteria.empty && visibleMessages(w).length === 0 && w.runIds.length === 0 && w.deliverables.length === 0;
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
      for (const row of cp.rows) { const w = find(row.id); if (w && Array.isArray(row.history)) w.history = clone(row.history); }
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
    const out = [];
    for (const w of ws) {
      const title = safeTitle(w), ti = title.toLowerCase().indexOf(q);
      if (ti >= 0) { out.push({ id: w.id, title: w.title, snippet: 'title match', match: 'title' }); continue; }
      for (const m of visibleMessages(w)) {
        // Most queries do not occur in most turns. Check the raw text first so a miss does not pay
        // for every credential-redaction regex across the whole session archive. A raw candidate is
        // still scrubbed and checked again before it can become a hit: text inside a secret remains
        // unsearchable and snippets remain safe.
        const raw = m.content, rawIndex = raw.toLowerCase().indexOf(q); if (rawIndex < 0) continue;
        const body = scrubSecrets(raw), i = body.toLowerCase().indexOf(q); if (i < 0) continue;
        const start = Math.max(0, i - 20);
        out.push({ id: w.id, title: w.title, snippet: body.slice(start, start + 60).replace(/\s+/g, ' ').trim(), match: 'transcript' });
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
    if (String(w.id).startsWith('workshop-')) return { kind: 'workshop', id: w.agentId, name: 'Away builds' };
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

  return {
    init, reset, serialize, all, list, search, setConnectorHandoff, connectorHandoff, automationOf, railGroups,
    exportConversation, parseConversationExport, clearConversation,
    previewArchive, archivePreview, canUndo, undoLast,
    create, startSession, adopt, get, active, activeId: getActiveId, generalId: getGeneralId,
    switch: switchTo, rename, setAgent, setLane, setProjectRoot, pin, archive, del, removeByAgent, isDeleted, touch, markUnread, markRead, unread: isUnread,
    autoTitle, retitle, deriveTitle, needsModelTitle, isLowSignal, titleBasis,
    appendRun, noteRunEnd, recordDeliverable, addCost, costOf, noteModel, modelOf,
    // the rail's INBOX row reads these directly: the same sys/hidden/internal filter search and
    // export already trust, so the count and the preview can never surface machine chatter.
    visibleMessages,
    migrateV1, importTasks,
    LANES
  };
});
