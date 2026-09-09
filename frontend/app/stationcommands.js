/* stationcommands.js — the PAGE half of the station bridge.
 *
 * Sessions and crew are frontend state (App.openWorkstream / summonAgent / selectAgent, workstreams inside
 * agent.save.json), while agent tools run in the sidecar. So a tool that wants to open a session emits
 * `station.command` on the bus; this listens, runs the verb against the live station, and POSTs the outcome
 * back to /api/station/ack.
 *
 * ⛔ EVERY VERB REPORTS TRUTHFULLY. A refusal ("no such agent", "the crew list is not ready") is a real answer
 * and must travel back as ok:false. Never resolve ok:true for something that did not happen — a tool that says
 * "opened a session" with no session behind it is the exact failure this whole bridge is built to prevent.
 * Read-only verbs land first on purpose: they prove the channel with nothing to corrupt.
 */
'use strict';

const StationCommands = (() => {
  /* ONE resolution law for every name-addressed verb (and the same one team.dispatch applies sidecar-side):
     exact id → exact title → UNIQUE substring; anything else throws with the real names, because a
     plausible-but-wrong session is worse than a refusal the agent can read and correct. */
  function resolveSession(want) {
    if (typeof Workstreams === 'undefined' || !Workstreams.list) throw new Error('sessions are not ready yet');
    want = String(want || '').trim();
    if (!want) throw new Error('name which session');
    const generalId = Workstreams.generalId ? Workstreams.generalId() : null;
    const rows = (Workstreams.list() || []).map(w => ({ w, title: String(w.title != null ? w.title : (w.id === generalId ? 'General' : '')).trim() }));
    const lower = want.toLowerCase();
    const byId = rows.filter(r => r.w.id === want);
    const byTitle = rows.filter(r => r.title && r.title.toLowerCase() === lower);
    const byPart = rows.filter(r => r.title && r.title.toLowerCase().indexOf(lower) >= 0);
    const hits = byId.length ? byId : (byTitle.length ? byTitle : byPart);
    if (hits.length === 1) return hits[0];
    const names = rows.map(r => r.title).filter(Boolean).join(', ');
    throw new Error(hits.length > 1
      ? 'more than one session matches "' + want + '" — name it exactly. Open sessions: ' + names
      : 'there is no session called "' + want + '"' + (names ? '. Open sessions: ' + names : ''));
  }

  function taskRows(includeArchived) {
    if (typeof Workstreams === 'undefined' || !Workstreams.list) throw new Error('task board is not ready yet');
    return (Workstreams.list({ includeArchived: !!includeArchived }) || []).filter(w => w && w.kind === 'task');
  }

  function taskView(w) {
    return {
      id: w.id, title: w.title || 'Untitled task', agentId: w.agentId || 'agent',
      lane: w.lane || 'todo', archived: !!w.archived, projectRoot: w.projectRoot || null
    };
  }

  function resolveTask(want, includeArchived) {
    want = String(want || '').trim();
    if (!want) throw new Error('name which task');
    const rows = taskRows(includeArchived);
    const lower = want.toLowerCase();
    const byId = rows.filter(w => w.id === want);
    const byTitle = rows.filter(w => String(w.title || '').trim().toLowerCase() === lower);
    const byPart = rows.filter(w => String(w.title || '').toLowerCase().indexOf(lower) >= 0);
    const hits = byId.length ? byId : (byTitle.length ? byTitle : byPart);
    if (hits.length === 1) return hits[0];
    const names = rows.map(w => w.title).filter(Boolean).join(', ');
    throw new Error(hits.length > 1
      ? 'more than one task matches "' + want + '" - name it exactly. Board tasks: ' + names
      : 'there is no task called "' + want + '"' + (names ? '. Board tasks: ' + names : ''));
  }

  /* A model-facing board mutation is not complete when localStorage changed; it is complete only after the
     sidecar accepted the save and a fresh GET returned the expected workstream/tombstone. A retry after an
     ambiguous transport failure is safe because create and every state-setting manage action are idempotent. */
  async function persistWorkstreams(proof) {
    if (typeof App === 'undefined' || !App.persist) throw new Error('the station cannot save task changes right now');
    if (typeof CloudSave === 'undefined' || !CloudSave.flush || !CloudSave.pull) {
      throw new Error('durable task storage is unavailable - no change can be reported as complete');
    }
    App.persist();
    const landed = await CloudSave.flush({ force: true });
    if (!landed) throw new Error('durable task save was refused or unreachable - do not report this change as complete');
    const saved = await CloudSave.pull();
    if (!saved || !proof(saved)) throw new Error('durable task read-back did not confirm the change - do not report it as complete');
    try { if (App.refreshRail) App.refreshRail(); } catch (_) {}
  }

  /* Delivery crosses browser pages, and frontend workstream ids are page-local until their saves converge.
     Prefer the id that launched the run; if this page does not know it, heal ONLY by a unique exact title.
     Substring matching is deliberately forbidden here: an automatic fold must never guess its destination. */
  function resolveDelivery(a) {
    if (typeof Workstreams === 'undefined' || !Workstreams.get || !Workstreams.list) throw new Error('sessions are not ready yet');
    const id = String((a && a.streamId) || '');
    const byId = id && Workstreams.get(id);
    if (byId) return { w: byId, resolvedBy: 'id' };
    const title = String((a && a.sessionTitle) || '').trim();
    if (title) {
      const lower = title.toLowerCase();
      const generalId = Workstreams.generalId ? Workstreams.generalId() : null;
      const hits = (Workstreams.list() || []).filter(w =>
        String(w.title != null ? w.title : (w.id === generalId ? 'General' : '')).trim().toLowerCase() === lower);
      if (hits.length === 1) return { w: hits[0], resolvedBy: 'title' };
      if (hits.length > 1) throw new Error('more than one session is called "' + title + '" on this station');
    }
    throw new Error('there is no session with id ' + (id || '(none given)') + ' on this station');
  }

  function refreshAndPersist(ws, quiet) {
    if (quiet) return;
    const isOpen = Workstreams.activeId && Workstreams.activeId() === ws.id;
    if (isOpen && typeof Chat !== 'undefined' && Chat.load) { try { Chat.load(ws); } catch (_) {} }
    try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (_) {}
    try { if (typeof App !== 'undefined' && App.persist) App.persist(); } catch (_) {}
  }

  function foldDelivery(a, opts) {
    opts = opts || {};
    const hit = resolveDelivery(a);
    const ws = hit.w;
    const text = String((a && a.text) || '').trim();
    if (!text) throw new Error('nothing to deliver — the worker returned no text');
    const runId = String((a && a.runId) || '');
    if (runId && (ws.runIds || []).indexOf(runId) >= 0) {
      try { if (typeof Channels !== 'undefined' && Channels.end) Channels.end(ws.id); } catch (_) {}
      return { folded: false, reason: 'already delivered', session: ws.title || 'General', resolvedBy: hit.resolvedBy };
    }
    const who = String((a && a.agentId) || 'agent');
    const prompt = String((a && a.prompt) || '').trim();
    const ts = Number(a && a.ts) > 0 ? Number(a.ts) : Date.now();
    if (!Array.isArray(ws.history)) ws.history = [];
    /* The instruction goes in as a sys marker, not a user turn: the Commander did not type it here, and
       chat.js excludes sys lines from historyWindow() so it is never replayed to the model as if they had. */
    if (prompt) ws.history.push({ role: 'system', sys: true, content: '— delegated to ' + who + ': ' + prompt.slice(0, 400) + ' —', ts });
    ws.history.push({ role: 'assistant', content: text, agentId: who, ts });
    if (runId && Workstreams.appendRun) Workstreams.appendRun(ws.id, runId, ts);
    else if (Workstreams.touch) Workstreams.touch(ws.id);
    if (Workstreams.markUnread) Workstreams.markUnread(ws.id);
    try { if (typeof Channels !== 'undefined' && Channels.end) Channels.end(ws.id); } catch (_) {}
    refreshAndPersist(ws, !!opts.quiet);
    return { folded: true, session: ws.title || 'General', agentId: who, resolvedBy: hit.resolvedBy };
  }

  const VERBS = {
    /* Everything the station can currently see: which sessions exist, which is active, who is busy, what is
       waiting on approval. Reuses VoiceLive's snapshot so voice and tools cannot drift into two answers. */
    'station.status': () => {
      if (typeof VoiceLive === 'undefined' || !VoiceLive.statusSnapshot) throw new Error('the station view is not ready yet');
      const snap = VoiceLive.statusSnapshot();
      if (!snap || (snap.active === null && !(snap.workstreams || []).length)) {
        throw new Error('the station is still starting up — no sessions are readable yet');
      }
      return snap;
    },

    /* The sessions that exist, by name. This is what turns "the research session" into a real workstream id:
       the sidecar resolves against THIS list and refuses anything it cannot match uniquely, so the resolution
       is only ever as good as the truth here — report ids and titles verbatim, never a guess or a default. */
    'station.sessions': () => {
      if (typeof Workstreams === 'undefined' || !Workstreams.list) throw new Error('sessions are not ready yet');
      const rows = Workstreams.list() || [];
      const activeId = Workstreams.activeId ? Workstreams.activeId() : null;
      const generalId = Workstreams.generalId ? Workstreams.generalId() : null;
      return {
        count: rows.length,
        activeId: activeId,
        sessions: rows.map(w => ({
          id: w.id,
          // General is the untitled home stream; it has no name of its own, so give it the one the UI shows.
          title: w.title != null ? w.title : (w.id === generalId ? 'General' : null),
          agentId: w.agentId || 'agent',
          lane: w.lane || null,
          active: w.id === activeId
        }))
      };
    },

    'station.tasks': () => {
      const rows = taskRows(false).map(taskView);
      return { count: rows.length, tasks: rows };
    },

    'station.new_task': async (a) => {
      if (typeof Workstreams === 'undefined' || !Workstreams.create) throw new Error('task board is not ready yet');
      const title = String((a && a.title) || '').trim().slice(0, 80);
      if (!title) throw new Error('a task needs a title');
      const existing = taskRows(true).find(w => String(w.title || '').trim().toLowerCase() === title.toLowerCase());
      const agentId = String((a && a.agentId) || '').trim();
      if (agentId && typeof App !== 'undefined' && App.agents && !(App.agents() || []).some(x => x && x.id === agentId)) {
        throw new Error('no crew member with id "' + agentId + '" - use station.crew for the roster, or omit agentId');
      }
      const ws = existing || Workstreams.create(title, { kind: 'task', activate: false, agentId: agentId || undefined });
      if (!ws) throw new Error('the station could not create the task');
      if (existing && existing.archived) Workstreams.archive(existing.id, false);
      if (agentId && ws.agentId !== agentId && !Workstreams.setAgent(ws.id, agentId)) throw new Error('the task could not be assigned');
      await persistWorkstreams(save => (save.workstreams || []).some(w => w && w.id === ws.id && w.kind === 'task' && !w.archived));
      return Object.assign({ created: !existing, duplicate: !!existing, durable: true }, taskView(Workstreams.get(ws.id)));
    },

    'station.manage_task': async (a) => {
      const action = String((a && a.action) || '');
      const task = resolveTask(a && a.task, action === 'restore');
      const before = taskView(task);
      let removed = false;
      if (action === 'move') {
        const lane = String((a && a.lane) || '');
        if (['todo', 'active', 'shipped'].indexOf(lane) < 0) throw new Error('task lane must be todo, active, or shipped');
        if (task.lane !== lane && !Workstreams.setLane(task.id, lane)) throw new Error('the task could not move');
      } else if (action === 'rename') {
        const title = String((a && a.title) || '').trim().slice(0, 80);
        if (!title) throw new Error('a renamed task needs a title');
        const clash = taskRows(true).find(w => w.id !== task.id && String(w.title || '').trim().toLowerCase() === title.toLowerCase());
        if (clash) throw new Error('a task called "' + title + '" already exists');
        if (task.title !== title && !Workstreams.rename(task.id, title)) throw new Error('the task could not be renamed');
      } else if (action === 'assign') {
        const agentId = String((a && a.agentId) || '').trim();
        if (!agentId) throw new Error('assign needs an agentId');
        if (typeof App !== 'undefined' && App.agents && !(App.agents() || []).some(x => x && x.id === agentId)) throw new Error('no crew member with id "' + agentId + '"');
        if (task.agentId !== agentId && !Workstreams.setAgent(task.id, agentId)) throw new Error('the task could not be assigned');
      } else if (action === 'archive' || action === 'restore') {
        const archived = action === 'archive';
        if (task.archived !== archived && !Workstreams.archive(task.id, archived)) throw new Error('the task could not be ' + action + 'd');
      } else if (action === 'remove') {
        if (!Workstreams.del(task.id)) throw new Error('the task could not be removed');
        removed = true;
      } else {
        throw new Error('task action must be move, rename, assign, archive, restore, or remove');
      }
      await persistWorkstreams(save => {
        const rows = save.workstreams || [];
        if (removed) return !rows.some(w => w && w.id === task.id) && (save.deletedIds || []).indexOf(task.id) >= 0;
        const w = rows.find(x => x && x.id === task.id);
        if (!w) return false;
        if (action === 'move') return w.lane === String(a.lane);
        if (action === 'rename') return w.title === String(a.title).trim().slice(0, 80);
        if (action === 'assign') return w.agentId === String(a.agentId).trim();
        return !!w.archived === (action === 'archive');
      });
      const current = removed ? null : Workstreams.get(task.id);
      return { changed: removed || JSON.stringify(before) !== JSON.stringify(taskView(current)), removed, durable: true, task: current ? taskView(current) : null, id: task.id };
    },

    /* Create a NAMED session. Refuses a duplicate title rather than minting a twin: two sessions with one
       name would make every later name-addressed action (dispatch's `session`, switch below) AMBIGUOUS and
       therefore refused — a create that quietly poisons the namespace is worse than telling the agent to
       reuse what exists. `focus` is honored only when explicitly asked, so an agent opening sessions in the
       background can never steal what the Commander is looking at. */
    'station.new_session': async (a) => {
      if (typeof Workstreams === 'undefined' || !Workstreams.create) throw new Error('sessions are not ready yet');
      const title = String((a && a.title) || '').trim().slice(0, 80);
      if (!title) throw new Error('a session needs a title');
      const clash = (Workstreams.list() || []).find(w => String(w.title || (w.id === Workstreams.generalId() ? 'General' : '')).trim().toLowerCase() === title.toLowerCase());
      if (clash) throw new Error('a session called "' + title + '" already exists — delegate into it, focus it, or pick another name');
      const agentId = String((a && a.agentId) || '').trim();
      if (agentId && typeof App !== 'undefined' && App.agents && !(App.agents() || []).some(x => x && x.id === agentId)) {
        throw new Error('no crew member with id "' + agentId + '" — use station.crew for the roster, or omit agentId');
      }
      if (a && a.focus) requireCurrentFocus(a.origin);
      const ws = Workstreams.create(title, { agentId: agentId || undefined, activate: !!(a && a.focus) });
      if (!ws) throw new Error('the station could not create the session');
      if (a && a.focus && typeof Chat !== 'undefined' && Chat.load) { try { Chat.load(ws); } catch (_) {} }
      await persistWorkstreams(save => (save.workstreams || []).some(w => w && w.id === ws.id && w.kind === 'chat')
        && (!(a && a.focus) || save.activeId === ws.id));
      return { id: ws.id, title: ws.title, agentId: ws.agentId || 'agent', focused: !!(a && a.focus), durable: true };
    },

    /* Focus an existing session by the name the Commander says (or exact id) — resolveSession's shared law,
       because a switch that lands on a plausible-but-wrong session moves the Commander's eyes somewhere
       they did not ask to be. */
    'station.switch_session': async (a) => {
      const hit = resolveSession(a && a.session);
      requireCurrentFocus(a && a.origin);
      const ws = Workstreams.switch(hit.w.id);
      if (!ws) throw new Error('the station could not switch sessions');
      if (typeof Chat !== 'undefined' && Chat.load) { try { Chat.load(ws); } catch (_) {} }
      await persistWorkstreams(save => save.activeId === ws.id && (save.workstreams || []).some(w => w && w.id === ws.id));
      try { await reconcile(ws.id); } catch (_) {}
      // Only the call-owning run may rebind voice. An unrelated run cannot transfer the call.
      try { if (typeof VoiceLive !== 'undefined' && VoiceLive.isActive && VoiceLive.isActive() && VoiceLive.rebind
          && VoiceLive.boundSessionId && VoiceLive.boundSessionId() === a.origin.streamId) VoiceLive.rebind(ws.id); } catch (_) {}
      return { id: ws.id, title: ws.title != null ? ws.title : 'General', durable: true };
    },

    /* Read a session's recent visible conversation — the agent's EYES into work that happened elsewhere.
       Exists because of a live failure: asked "what did the researcher do?", a lead with no way to read the
       other session guessed "nothing" while the finished answer sat right there. Visible dialogue only
       (same filter the session power tools use — sys markers ride along labeled, hidden/internal never). */
    'station.read_session': (a) => {
      const hit = resolveSession(a && a.session);
      const ws = hit.w;
      const limit = Math.max(1, Math.min(30, Number(a && a.limit) || 12));
      const turns = (ws.history || [])
        .filter(m => m && !m.hidden && !m.internal && typeof m.content === 'string'
          && (m.role === 'user' || m.role === 'assistant' || m.sys))
        .slice(-limit)
        .map(m => ({
          speaker: m.sys ? 'station' : (m.role === 'user' ? 'commander' : (m.agentId || ws.agentId || 'agent')),
          sys: !!m.sys,
          text: String(m.content).slice(0, 600)
        }));
      const busy = (typeof Channels !== 'undefined' && Channels.isBusy) ? !!Channels.isBusy(ws.id) : false;
      return {
        id: ws.id, title: hit.title || 'General', agentId: ws.agentId || 'agent',
        busy, runCount: (ws.runIds || []).length, turns,
        note: turns.length ? undefined : 'this session has no visible conversation yet'
      };
    },

    /* Fold a finished delegated run's answer into the session it was filed under. APPENDS — a session usually
       already holds the Commander's own conversation, and replacing that history (the way the cron auto-session
       path can, because it OWNS its stream) would delete their thread. Idempotent by runId so a retry, a
       duplicated command, or a re-delivered background worker can never double-post. */
    'station.deliver': (a) => foldDelivery(a),

    /* A delegated worker runs in the target session while the Commander is free to remain in General. The
       bridge supplies the real runId, so this is proven activity rather than a hopeful local spinner. */
    'station.dispatch_start': (a) => {
      const hit = resolveDelivery(a);
      const ws = hit.w;
      const runId = String((a && a.runId) || '');
      if (!runId) throw new Error('dispatch start needs a run id');
      if (typeof Channels === 'undefined' || !Channels.begin || !Channels.setRunId) throw new Error('session activity is not ready yet');
      Channels.begin(ws.id, Date.now());
      Channels.setRunId(ws.id, runId, Date.now());
      if (Channels.setStatus) Channels.setStatus(ws.id, 'working…');
      try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (_) {}
      return { started: true, session: ws.title || 'General', runId, resolvedBy: hit.resolvedBy };
    },

    'station.dispatch_end': (a) => {
      const hit = resolveDelivery(a);
      if (typeof Channels !== 'undefined' && Channels.end) Channels.end(hit.w.id);
      try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (_) {}
      return { settled: true, session: hit.w.title || 'General', resolvedBy: hit.resolvedBy };
    },

    /* Who is on the roster and what each one is for — the list a delegate call has to choose from. */
    'station.crew': () => {
      if (typeof App === 'undefined' || !App.agents) throw new Error('the crew roster is not ready yet');
      const crew = App.agents() || [];
      if (!crew.length) throw new Error('no crew are on this station yet');
      return {
        count: crew.length,
        crew: crew.map(a => ({ id: a.id, name: a.name || a.id, role: a.role || null, model: a.model || null }))
      };
    }
  };

  const reconciling = Object.create(null);

  /* Recover a station.deliver command that no page received (or that the wrong page acknowledged first).
     The completed answer is stored with the run itself; fold by runId exactly once, resolving a divergent
     page-local id by the unique exact session title. A read failure is fail-open and never blocks page boot. */
  function reconcile(targetId) {
    const target = String(targetId || '');
    const key = target || '*';
    if (reconciling[key]) return reconciling[key];
    reconciling[key] = (async () => {
      let rows = [];
      try {
        const r = await fetch('/api/runs?agent=*&limit=500', { cache: 'no-store' });
        if (!r.ok) return 0;
        rows = ((await r.json()) || {}).runs || [];
      } catch (_) { return 0; }
      let folded = 0;
      // /api/runs is newest-first. Fold oldest-first so multiple missed answers preserve conversation order.
      for (const row of rows.slice().reverse()) {
        if (!row || ['done', 'max_iters', 'budget'].indexOf(String(row.reason || 'done')) < 0) continue;
        if (!String(row.sessionTitle || '').trim() || !String(row.deliveryText || '').trim()) continue;
        const args = {
          streamId: row.streamId, sessionTitle: row.sessionTitle, agentId: row.agentId,
          runId: row.runId, prompt: row.deliveryPrompt, text: row.deliveryText, ts: row.ts
        };
        let hit;
        try { hit = resolveDelivery(args); } catch (_) { continue; }
        if (target && hit.w.id !== target) continue;
        if (row.runId && (hit.w.runIds || []).indexOf(String(row.runId)) >= 0) continue;
        try {
          const out = foldDelivery(args, { quiet: true });
          if (out && out.folded) folded++;
        } catch (_) {}
      }
      if (folded) {
        try {
          const active = Workstreams.activeId && Workstreams.get(Workstreams.activeId());
          if (active && typeof Chat !== 'undefined' && Chat.load) Chat.load(active);
        } catch (_) {}
        try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (_) {}
        try { if (typeof App !== 'undefined' && App.persist) App.persist(); } catch (_) {}
      }
      return folded;
    })();
    return reconciling[key].finally(() => { delete reconciling[key]; });
  }

  function requireCurrentFocus(origin) {
    if (typeof Chat === 'undefined' || !Chat.canFocusSession || !Chat.canFocusSession(origin)) {
      throw new Error('session focus was left unchanged: the originating run is no longer current or the Commander has a draft; do not retry the switch automatically');
    }
  }

  async function run(id, verb, args) {
    let out;
    try {
      const fn = VERBS[String(verb || '')];
      if (!fn) throw new Error('unknown station verb: ' + verb);
      out = { id, ok: true, result: await fn(args || {}) };
    } catch (error) {
      out = { id, ok: false, error: String((error && error.message) || error) };
    }
    try {
      await fetch('/api/station/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(out)
      });
    } catch (_) {
      // The sidecar's own timeout is the backstop: if the ack cannot be delivered, the command fails there
      // as unattended rather than hanging. Nothing to retry — a retried side-effect is a duplicated action.
    }
  }

  function init() {
    if (typeof U === 'undefined' || !U.bus || !U.bus.on) return;
    U.bus.on('station.command', msg => {
      if (!msg || !msg.id || !msg.verb) return;
      run(String(msg.id), String(msg.verb), msg.args);
    });
  }

  return { init, run, reconcile, verbs: () => Object.keys(VERBS) };
})();

document.addEventListener('DOMContentLoaded', () => StationCommands.init());
