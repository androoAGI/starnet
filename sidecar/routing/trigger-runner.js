/* sidecar/routing/trigger-runner.js — LINE TRIGGERS, the runner (2026-09-23).

   Owns the live side of line triggers: the durable record mirror, admission (rate limit + a small bounded
   queue, ONE fire in flight per trigger), the folder poll, and the dispatch of each admitted work item into its
   line's INBOX. Dispatch is the SAME path the sample proof rides (index.js handleRoutingSample): a channel hub
   whose ONE resolution is scoped to the trigger's line (router.resolveDock with ctx.lineId), a real runOnce at
   the entry dock (budget governor, ledger, real cost), the shared chain runner for every stage drawn past it,
   surface:'autonomous' and NO unattendedGrants (the chain-grants law — a trigger body can never carry
   authority). Every outcome is read back from the durable run rows scoped by the fire's own streamId — never
   synthesized — and recorded on the trigger (lastFiredAt / lastOutcome / lastError / fires).

   Determinism-clean: every ambient thing is injected (clock, ids, fs, timers stay in index.js).

   makeTriggerRunner(deps)
     deps.load() -> {triggers:[…]}           the durable store read (normalized by triggers.normalizeAll)
     deps.save({triggers}) -> void           durable write (throws on failure)
     deps.seen: { load() -> {id:{key:at}}, save(obj) }   the folder trigger's fired-file record
     deps.makeHub(hooks) -> hub               a channel hub wired to the hooks (see index.js makeTriggerHub)
     deps.plan() -> the armed routing plan | null
     deps.shipsToOutbox(agentId, dockId) -> bool
     deps.dayCap(lineId) -> { cap:number|null, spent:number }
     deps.halted() -> bool                    the durable automation E-STOP (cron halt)
     deps.runsFor(streamId) -> [{runId, agentId, reason, usd}]
     deps.emit(name, payload), deps.bumpQueue(agentId, d) -> depth, deps.queueCap
     deps.watcher (trigger-folder makeFolderWatcher), deps.now(), deps.newId(), deps.warn(msg)
     deps.label(agentId) -> display name|null     for the sentences the owner reads (lastError)
     deps.folderConflict(path) -> reason|null  a watched folder inside a line's working folder (checked every fire) */
'use strict';
const T = require('./triggers.js');
const Pipeline = require('../../frontend/app/pipeline.js');

const MAX_PENDING = 5;   // work items waiting behind the one in flight, per trigger — a burst beyond this is refused
const READ_BACKOFF_MS = 15000, READ_BACKOFF_MAX_MS = 10 * 60 * 1000;   // an unreadable folder file's retry backoff

/* crewedDocksOnLine(plan, lineId?) -> the reached, crewed entry points of a line (lineId null = any line). Side-effect
   free and lane-choice-blind (plan.reach / plan.reachDock are BFS answers over every junction lane), so it can
   refuse but never names the dock a real dispatch will take.
   MULTI-BAY (2026-09-24): the question is asked of the DOCK layer — reachDock + lineOfDock — because an agent that
   crews bays on two lines has ONE lineOfAgent entry (its entry dock's line): reading the agent view refused a
   working line-2 trigger "routes work to no crewed dock" and painted the floor NO FEED. Only a plan with no dock
   layer at all (an older compile) falls back to the agent view. Shared by the trigger preflight and the sample route. */
function crewedDocksOnLine(plan, lineId) {
  if (!plan || typeof plan !== 'object') return [];
  const want = lineId == null || lineId === '' ? null : String(lineId);
  if (Pipeline.hasDockLayer(plan)) {
    const L = Pipeline.dockLayer(plan);
    return Object.keys(L.reachDock || {}).filter(d => L.reachDock[d] && L.agentOfDock[d] && (want == null || L.lineOfDock[d] === want));
  }
  const reach = plan.reach || {}, loa = plan.lineOfAgent || {};
  return Object.keys(reach).filter(a => reach[a] && (want == null || loa[a] === want));
}

function makeTriggerRunner(deps) {
  const d = deps || {};
  const now = d.now, newId = d.newId;
  if (typeof now !== 'function' || typeof newId !== 'function') throw new Error('trigger-runner: now/newId are required');
  if (typeof d.load !== 'function' || typeof d.save !== 'function') throw new Error('trigger-runner: load/save are required');
  const warn = typeof d.warn === 'function' ? d.warn : function () {};
  const emit = typeof d.emit === 'function' ? d.emit : function () {};
  const bumpQueue = typeof d.bumpQueue === 'function' ? d.bumpQueue : function () { return 0; };
  const halted = typeof d.halted === 'function' ? d.halted : function () { return false; };
  // the halt is the station's own process-fault containment, not the Commander's E-STOP: only the words differ (see handoff-runner)
  const faulted = typeof d.faulted === 'function' ? d.faulted : function () { return false; };
  const dayCap = typeof d.dayCap === 'function' ? d.dayCap : function () { return { cap: null, spent: 0 }; };
  const runsFor = typeof d.runsFor === 'function' ? d.runsFor : function () { return []; };
  const shipsToOutbox = typeof d.shipsToOutbox === 'function' ? d.shipsToOutbox : function () { return false; };
  const planOf = typeof d.plan === 'function' ? d.plan : function () { return null; };
  // the owner reads an agent's display name in lastError, never its raw id (sweep 2026-09-25)
  const nameOf = id => { let n = null; try { n = typeof d.label === 'function' ? d.label(id) : null; } catch (e) { warn('[triggers] label: ' + ((e && e.message) || e)); } return n ? String(n) : String(id); };
  const seenStore = d.seen || { load: function () { return {}; }, save: function () {} };

  let records = T.normalizeAll(d.load()).triggers;
  let seen = (function () { try { const s = seenStore.load(); return (s && typeof s === 'object') ? s : {}; } catch (e) { warn('[triggers] fired-file record unreadable: ' + ((e && e.message) || e)); return {}; } })();
  const live = new Map();   // id -> { queue:[], busy:false, hub:null, current:null, pending:Map, scanning:false }

  function stateOf(id) {
    let s = live.get(id);
    if (!s) { s = { queue: [], busy: false, hub: null, current: null, pending: new Map(), scanning: false, queuedKeys: new Set(), readBackoff: new Map() }; live.set(id, s); }
    return s;
  }
  const get = id => records.find(t => t.id === id) || null;

  /* persist the WHOLE list; on failure the in-memory mirror rolls back so live state never outruns disk. */
  function commit(next) {
    const prev = records;
    records = next;
    try { d.save({ triggers: next }); return true; }
    catch (e) { records = prev; warn('[triggers] persist failed: ' + ((e && e.message) || e)); return false; }
  }
  function patch(id, fn) {
    const i = records.findIndex(t => t.id === id);
    if (i < 0) return null;
    const cur = records[i];
    const nx = T.normalizeTrigger(Object.assign({}, cur, fn(cur)));
    if (!nx) return null;
    const next = records.slice(); next[i] = nx;
    return commit(next) ? nx : null;
  }
  function saveSeen() {
    // bound each trigger's record in place (callers hold references to the inner maps): drop the OLDEST stamps
    for (const id of Object.keys(seen)) {
      const m = seen[id], keys = m ? Object.keys(m) : [];
      if (keys.length > T.SEEN_MAX) keys.sort((a, b) => m[a] - m[b]).slice(0, keys.length - T.SEEN_MAX).forEach(k => { delete m[k]; });
    }
    try { seenStore.save(seen); return true; } catch (e) { warn('[triggers] fired-file record persist failed: ' + ((e && e.message) || e)); return false; }
  }
  /* an honest, de-duplicated failure note on the trigger (the UI shows lastError). Same message twice = one write. */
  function recordError(id, msg) {
    const t = get(id); if (!t) return;
    const m = String(msg || 'failed').slice(0, 400);
    if (t.lastError === m) return;
    patch(id, () => ({ lastError: m, lastErrorAt: now() }));
  }
  function clearError(id) { const t = get(id); if (t && t.lastError) patch(id, () => ({ lastError: null, lastErrorAt: null })); }

  /* ---- preflight: can THIS line take work right now? (no side effects) ---- */
  function preflight(t) {
    if (halted()) return faulted() ? 'the station hit an internal fault and stopped its background work — restart Agent OS and this trigger fires again' : 'automation is stopped (E-STOP) — resume it and this trigger fires again';
    const plan = planOf();
    if (!plan) return 'no work line is armed — the floor has no complete line to run';
    if (!(Array.isArray(plan.lines) ? plan.lines : []).some(l => l && String(l.lineId) === t.lineId)) return 'its line is no longer on the floor (the line changed or was removed) — delete this trigger or re-create it on the line';
    if (!crewedDocksOnLine(plan, t.lineId).length) return 'its line routes work to no crewed dock — assign an agent to the first step';
    // a folder that is (now) inside a line's working folder would feed that line its own output — re-asked every fire,
    // because a line's project can change after the trigger was created
    if (t.kind === 'folder' && typeof d.folderConflict === 'function') {
      let why = null;
      try { why = d.folderConflict(t.config.path); } catch (e) { why = 'the station could not check this folder against its lines\' working folders'; warn('[triggers] folder conflict check failed: ' + ((e && e.message) || e)); }
      if (why) return why;
    }
    let cap = null;
    try { cap = dayCap(t.lineId); } catch (e) { cap = null; warn('[triggers] day-cap read failed: ' + ((e && e.message) || e)); }
    if (cap && typeof cap.cap === 'number' && cap.cap > 0 && (cap.spent || 0) >= cap.cap) return 'the line reached its $' + cap.cap.toFixed(2) + ' daily limit — it fires again tomorrow';
    return null;
  }

  /* canAccept(id) — would enqueue() admit one more item now? Pure read, used by the folder poll BEFORE it reads
     or marks a file, so a file that cannot run yet simply waits in the folder for a later scan. */
  function canAccept(id, nowMs) {
    const t = get(id);
    if (!t) return { ok: false, code: 'unknown', error: 'no such trigger' };
    if (!t.enabled) return { ok: false, code: 'disabled', error: 'this trigger is disabled' };
    const pf = preflight(t);
    if (pf) return { ok: false, code: 'refused', error: pf };
    const s = stateOf(id);
    if (s.queue.length >= MAX_PENDING) return { ok: false, code: 'busy', error: 'this trigger already has ' + s.queue.length + ' items waiting behind the one running' };
    const a = T.admit(t, nowMs == null ? now() : nowMs);
    if (!a.ok) return { ok: false, code: 'rate', error: a.error, retryAfterMs: a.retryAfterMs };
    return { ok: true };
  }

  /* enqueue(id, item) — admit ONE work item { text, preview, source }. Admission is durable before the item
     queues (the rate window lives on the record), so a restart can never hand a burst a fresh allowance. */
  function enqueue(id, item) {
    const nowMs = now();
    const c = canAccept(id, nowMs);
    if (!c.ok) { if (c.code === 'refused' || c.code === 'rate' || c.code === 'busy') recordError(id, c.error); return c; }
    const t = get(id);
    const a = T.admit(t, nowMs);
    if (!patch(id, () => ({ recent: a.recent }))) return { ok: false, code: 'persist', error: 'the fire could not be recorded durably — refused' };
    const s = stateOf(id);
    const seenKey = item.seenKey ? String(item.seenKey) : null;   // a folder file: marked fired only when it dispatches
    s.queue.push({ text: String(item.text || ''), preview: String(item.preview || '').slice(0, 40), source: String(item.source || '').slice(0, 200), at: nowMs, seenKey });
    if (seenKey) s.queuedKeys.add(seenKey);
    const position = s.queue.length + (s.busy ? 1 : 0);
    pump(id);
    return { ok: true, queued: position };
  }

  function pump(id) {
    const s = stateOf(id);
    if (s.busy || !s.queue.length) return;
    const t = get(id);
    if (!t) { dropQueue(s); return; }
    // THE PRE-FIRE CHECKS AGAIN AT DISPATCH (sweep 2026-09-25): an item waited behind the fire in flight, and while it
    // waited the line may have hit its daily $ cap, been disarmed or left the floor, or E-STOP was pressed. Admission's
    // answer is stale by now — every waiting item is dropped with the reason on record, never run past a closed gate.
    const why = !t.enabled ? 'the trigger was paused' : preflight(t);
    if (why) {
      const n = s.queue.length;
      dropQueue(s);
      recordError(id, n + ' waiting item' + (n === 1 ? ' was' : 's were') + ' dropped before running: ' + why);
      return;
    }
    const item = s.queue.shift();
    s.busy = true;
    Promise.resolve().then(() => dispatch(t, item, s)).catch(e => {
      recordError(id, 'dispatch failed: ' + ((e && e.message) || e));
    }).then(() => {
      s.busy = false; s.current = null;
      if (s.removed) { retire(id, s); return; }   // deleted mid-fire: retired only now that the fire has settled
      pump(id);
    });
  }
  // drop every WAITING item; a folder file among them was never marked fired, so it simply fires on a later scan
  function dropQueue(s) { for (const it of s.queue) if (it && it.seenKey) s.queuedKeys.delete(it.seenKey); const n = s.queue.length; s.queue.length = 0; return n; }

  /* ---- the hub: one per trigger, built lazily, bound to hooks that read THIS trigger's live record ---- */
  function hubFor(id, s) {
    if (s.hub) return s.hub;
    s.hub = d.makeHub({
      lineId: () => { const t = get(id); return t ? t.lineId : null; },
      // the ONE counter-advancing resolution the hub makes; remembered so the entry run config can refuse
      // any agent the line did not route to (a fallback agent must never run a trigger's work)
      onRouted: (r) => { if (s.current) s.current.routed = r || null; return r; },
      entryAllowed: (agentId) => !!(s.current && s.current.routed && s.current.routed.agentId === agentId),
      onResolved: (info) => { if (s.current && !s.current.resolved) s.current.resolved = info; },
      onLineOutcome: (info) => { if (s.current) s.current.lineOutcome = info; },
      streamId: () => (s.current && s.current.streamId) || undefined,
      // a fire is ONE standalone job: the hub's per-agent turn history lives only for this fire (never a prior fire's)
      turns: (agentId) => { if (!s.current) return []; const k = String(agentId || ''); return s.current.turns[k] || (s.current.turns[k] = []); },
      send: (text) => { if (s.current) { s.current.replies.push(String(text == null ? '' : text)); if (s.current.replies.length > 20) s.current.replies.shift(); } }
    });
    return s.hub;
  }

  async function dispatch(t, item, s) {
    const startedAt = now();
    const streamId = 'trigger-' + String(newId()).replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
    if (item.seenKey) {
      // the folder file is recorded as FIRED now, as its run begins (durably, before any spend): a restart after this
      // point never refires it. A record that cannot be written refuses the fire rather than risk running it twice.
      s.queuedKeys.delete(item.seenKey);
      const mine = seen[t.id] || (seen[t.id] = {});
      mine[item.seenKey] = startedAt;
      if (!saveSeen()) { delete mine[item.seenKey]; recordError(t.id, 'could not record fired files — paused to avoid refiring'); return null; }
    }
    s.current = { streamId, routed: null, resolved: null, lineOutcome: null, replies: [], turns: {} };
    // the previous fire's outcome is cleared as this one starts: a fire that dies mid-run (a restart, a crash) must
    // never leave the OLD "✓ reached the OUTBOX" standing beside the NEW lastFiredAt (sweep 2026-09-25)
    patch(t.id, cur => ({ fires: cur.fires + 1, lastFiredAt: startedAt, lastOutcome: null }));
    const hub = hubFor(t.id, s);
    const settled = Promise.resolve(hub.onInbound({ chatId: 'trg-' + t.id, userId: 'trigger', text: item.text, chatType: 'dm' }))
      .catch(e => ({ error: (e && e.message) || String(e) }));
    // resolution lands in onInbound's first synchronous slice (the one-resolver law); the crate follows it
    const info = s.current.resolved;
    let workitemId = '', agentId = '';
    // a crate only for the dock the LINE routed to (a hub fallback agent is refused its run config and gets none)
    if (info && info.agentId && s.current.routed && s.current.routed.agentId === info.agentId) {
      agentId = String(info.agentId);
      workitemId = String(newId());
      const depth = bumpQueue(agentId, +1);
      emit('workitem.placed', { workitemId, queueId: agentId, agentId, kind: 'trigger', trigger: t.kind, triggerId: t.id,
        lineId: info.lineId || undefined, dockId: info.dockId || undefined, preview: item.preview, queueDepth: depth, ts: startedAt });
      emit('queue.status', { queueId: agentId, depth, maxCapacity: d.queueCap || 64, nextAdvanceAt: 0 });
    }
    const threw = await settled;
    let runs = [];
    try { runs = (runsFor(streamId) || []).filter(r => r && String(r.streamId || streamId) === streamId); } catch (e) { runs = []; warn('[triggers] run read-back failed: ' + ((e && e.message) || e)); }
    const lo = s.current.lineOutcome;
    const onLine = !!(info && info.lineId === t.lineId);
    const allDone = runs.length > 0 && runs.every(r => r.reason === 'done');
    // a PARTIAL joined job (chain out.partial) is not clean, even when every run row that exists ended done (runtime repair 2026-10-12)
    const ships = !!(lo && !lo.stopped && !lo.partial && shipsToOutbox(lo.agentId, lo.dockId));
    const completed = onLine && allDone && ships;
    const usd = runs.reduce((a, r) => a + ((typeof r.usd === 'number' && isFinite(r.usd)) ? r.usd : 0), 0);
    if (workitemId) {
      const dep = bumpQueue(agentId, -1);
      if (completed) emit('workitem.delivered', { workitemId, finalQueueId: 'outbox', agentId, box: '', ms: now() - startedAt, ts: now() });
      emit('queue.status', { queueId: agentId, depth: dep, maxCapacity: d.queueCap || 64, nextAdvanceAt: 0 });
    }
    let err = null;
    if (!completed) {
      const firstReply = (s.current.replies.find(x => /^⚠/.test(String(x).trim())) || '').replace(/^⚠\s*/, '').trim();
      if (threw && threw.error) err = 'the line failed: ' + threw.error;
      else if (!info || !info.agentId || !s.current.routed || s.current.routed.agentId !== info.agentId) err = firstReply || 'the line routed this work to no dock';
      else if (!onLine) err = 'the work did not enter through this trigger\'s line';
      else if (!runs.length) err = firstReply || 'no run was recorded for this work';
      else if (!allDone) { const bad = runs.find(r => r.reason !== 'done'); err = 'a stage (' + (bad.agentId ? nameOf(bad.agentId) : '?') + ') ended "' + (bad.reason || 'unknown') + '"' + (firstReply ? ': ' + firstReply : ''); }
      else if (lo && lo.stopped) err = 'the line stopped early: ' + lo.stopped;
      else if (lo && lo.partial) err = 'the joiner sent on without every branch (' + lo.partial + ')';
      else err = 'the line did not reach its OUTBOX';
    }
    const outcome = { ok: completed, at: now(), streamId, runs: runs.length, usd, agentId: (lo && lo.agentId) || agentId || null, source: item.source || null };
    patch(t.id, () => (err ? { lastOutcome: outcome, lastError: err.slice(0, 400), lastErrorAt: now() } : { lastOutcome: outcome, lastError: null, lastErrorAt: null }));
    return outcome;
  }

  /* ---- CRUD (the host validates the folder path before calling create/update with it) ---- */
  /* the live facts a record cannot hold: queue depth, a fire in flight, and blockedBy — what stops the NEXT fire
     right now (the fire preflight, or a folder the last scan could not read). The panel, the how-it-runs sentence
     and the floor's FEED truth all read blockedBy, so a trigger that cannot fire is never claimed as a feed. */
  function liveView(t, n) {
    const s = stateOf(t.id);
    return Object.assign(T.publicView(t, n), { queued: s.queue.length, running: !!s.busy,
      blockedBy: t.enabled ? (preflight(t) || (t.kind === 'folder' && s.scanError ? s.scanError : null)) : null });
  }
  function list(nowMs) { const n = nowMs == null ? now() : nowMs; return records.map(t => liveView(t, n)); }
  function view(id) { const t = get(id); return t ? liveView(t, now()) : null; }

  /* create(fields, { secretHash, baselineKeys }) -> { ok, trigger } | { ok:false, error } */
  function create(fields, extra) {
    if (records.length >= T.MAX_TRIGGERS) return { ok: false, error: 'at most ' + T.MAX_TRIGGERS + ' triggers per station' };
    const at = now();
    const id = 'trg_' + String(newId()).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12);
    const raw = Object.assign({ id, enabled: true, createdAt: at, updatedAt: at, fires: 0, recent: [] }, fields);
    if (raw.kind === 'webhook') { raw.secretHash = extra && extra.secretHash; raw.secretSetAt = at; }
    const t = T.normalizeTrigger(raw);
    if (!t) return { ok: false, error: 'invalid trigger' };
    if (t.kind === 'folder') {
      seen[t.id] = {};
      for (const k of ((extra && extra.baselineKeys) || [])) seen[t.id][k] = at;   // baseline = armed now (never fires)
      if (!saveSeen()) { delete seen[t.id]; return { ok: false, error: 'the folder\'s existing files could not be recorded — refused (they would all fire)' }; }
    }
    if (!commit(records.concat([t]))) return { ok: false, error: 'the trigger could not be saved' };
    return { ok: true, trigger: view(t.id) };
  }

  /* update(id, fields, { secretHash?, baselineKeys? }) — a re-pointed or re-enabled folder is re-baselined */
  function update(id, fields, extra) {
    const t = get(id);
    if (!t) return { ok: false, code: 'unknown', error: 'no such trigger' };
    if (fields.kind && fields.kind !== t.kind) return { ok: false, error: 'a trigger\'s kind cannot change — delete it and create a new one' };
    if (t.kind === 'folder' && extra && Array.isArray(extra.baselineKeys)) {
      const prev = seen[id];
      seen[id] = {};
      { const at = now(); for (const k of extra.baselineKeys) seen[id][k] = at; }
      if (!saveSeen()) { seen[id] = prev; return { ok: false, error: 'the folder\'s existing files could not be recorded — refused' }; }
      stateOf(id).pending = new Map(); stateOf(id).scanError = null;
    }
    const changes = Object.assign({}, fields, { updatedAt: now() });
    if (fields.config) changes.config = Object.assign({}, t.config, fields.config);
    if (extra && extra.secretHash) { changes.secretHash = extra.secretHash; changes.secretSetAt = now(); }
    // re-enabling (or editing) clears a stale failure: the next fire writes the new truth
    if (fields.enabled === true || fields.config || fields.lineId) { changes.lastError = null; changes.lastErrorAt = null; }
    const nx = patch(id, () => changes);
    if (!nx) return { ok: false, error: 'the trigger could not be saved' };
    if (fields.enabled === false) dropQueue(stateOf(id));   // a disabled trigger drops what was waiting (files stay unfired)
    return { ok: true, trigger: view(id) };
  }

  function remove(id) {
    if (!get(id)) return { ok: false, code: 'unknown', error: 'no such trigger' };
    if (!commit(records.filter(t => t.id !== id))) return { ok: false, error: 'the trigger could not be deleted' };
    const s = live.get(id);
    if (s) {
      dropQueue(s);
      // A FIRE IN FLIGHT STAYS REACHABLE (sweep 2026-09-25): its hub's inflight record is what E-STOP kills
      // (inflights() reads `live`). Dropping the state mid-fire hid a still-spending run from every stop — so a
      // deleted trigger's state is retired only once its fire settles (pump's settle step), never before.
      if (s.busy) s.removed = true;
      else retire(id, s);
    }
    if (seen[id]) { delete seen[id]; saveSeen(); }
    return { ok: true };
  }
  function retire(id, s) {
    if (s.hub && typeof s.hub.close === 'function') { try { s.hub.close(); } catch (e) { warn('[triggers] hub close: ' + ((e && e.message) || e)); } }
    if (live.get(id) === s) live.delete(id);
  }

  /* ---- the FOLDER poll: one pass over every enabled folder trigger (the host arms the interval) ---- */
  async function tickFolders() {
    if (!d.watcher) return 0;
    let admitted = 0;
    for (const t of records.slice()) {
      if (t.kind !== 'folder' || !t.enabled || !t.config.path) continue;
      const s = stateOf(t.id);
      if (s.scanning) continue;
      s.scanning = true;
      try {
        const mine = seen[t.id] || (seen[t.id] = {});
        const res = await d.watcher.scan(t.config.path, mine, s.pending, now());
        if (!res.ok) { s.scanError = res.error; recordError(t.id, res.error); s.pending = new Map(); continue; }
        // the folder is readable again: a scan failure on record is no longer true — clear it (a fire error stays)
        if (s.scanError || /^(the folder no longer exists|cannot read the folder)/.test(t.lastError || '')) { s.scanError = null; clearError(t.id); }
        s.pending = res.pending;
        /* NO prune on absence (live proof 2026-09-23): a folder moved by copy+delete, a cloud-sync placeholder or a
           flaky share makes files vanish for a moment — forgetting them would refire every one of them (real spend)
           the instant they reappear. The record is bounded by count instead (newest SEEN_MAX per trigger). */
        const ready = res.ready.slice().sort((a, b) => a.mtimeMs - b.mtimeMs);
        for (const f of ready) {
          const c = canAccept(t.id);
          if (!c.ok) { if (c.code === 'refused' || c.code === 'rate') recordError(t.id, c.error); break; }   // the file waits in the folder
          if (s.queuedKeys.has(f.key)) continue;   // already admitted, waiting its turn (marked fired when it dispatches)
          const bo = s.readBackoff.get(f.key);
          if (bo && bo.until > now()) continue;    // it failed to read recently: wait out its backoff
          const body = await d.watcher.readItem(f.abs, f.name);
          // a file that could not be READ (EBUSY / locked by the app still holding it / a sync placeholder) did not
          // fire: it stays unmarked so a later scan retries it, instead of recording it as fired and dropping it forever.
          // Each retry BACKS OFF (15 s doubling to 10 min, sweep 2026-09-25) so a file that stays unreadable is not
          // re-opened on every 3 s poll forever.
          if (!body.ok) {
            const k = (bo ? bo.n : 0) + 1;
            s.readBackoff.set(f.key, { n: k, until: now() + Math.min(READ_BACKOFF_MAX_MS, READ_BACKOFF_MS * Math.pow(2, k - 1)) });
            if (s.readBackoff.size > 200) s.readBackoff.delete(s.readBackoff.keys().next().value);
            recordError(t.id, body.error + ' — retrying it later');
            continue;
          }
          if (bo) s.readBackoff.delete(f.key);
          const text = T.composeFolderItem({ name: t.name, task: t.config.task, filePath: f.abs, size: f.size,
            mtimeIso: new Date(f.mtimeMs).toISOString(), binary: body.binary, content: body.content, truncated: body.truncated });
          /* ADMITTED IS NOT FIRED (sweep 2026-09-25): the waiting queue is in memory, so a file is recorded as fired
             only when its item DISPATCHES (dispatch marks `seenKey`). A restart, an E-STOP or a pause that drops the
             waiting item leaves the file unmarked in the folder — it fires on a later scan, never silently lost. */
          const r = enqueue(t.id, { text, preview: 'FILE ' + f.name, source: f.abs, seenKey: f.key });
          if (!r.ok) break;
          admitted++;
        }
      } catch (e) {
        recordError(t.id, 'folder scan failed: ' + ((e && e.message) || e));
      } finally { s.scanning = false; }
    }
    return admitted;
  }

  /* E-STOP: drop every waiting item; the host kills the in-flight runs through the hubs' inflight maps. */
  function haltAll() { let n = 0; for (const s of live.values()) n += dropQueue(s); return n; }
  function inflights() { const out = []; for (const s of live.values()) if (s.hub && s.hub._internals && s.hub._internals.inflight) out.push(s.hub._internals.inflight); return out; }
  function seenFor(id) { return Object.assign({}, seen[id] || {}); }

  return { list, view, get, create, update, remove, enqueue, canAccept, tickFolders, recordError, clearError, preflight,
    haltAll, inflights, seenFor, _internals: { dispatch, live, MAX_PENDING } };
}

module.exports = { makeTriggerRunner, crewedDocksOnLine, MAX_PENDING };
