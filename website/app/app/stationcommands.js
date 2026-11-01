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
    // an exact id the lists hide (a delegated worker's thread) still reads: it is the lead's evidence; opening it
    // lands on its conversation (App.openWorkstream re-homes it)
    const exact = !hits.length && Workstreams.get ? Workstreams.get(want) : null;
    if (exact) return { w: exact, title: String(exact.title || '').trim() };
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

  /* STATION CONTROL helpers (station.control). A crew member by id or by the name the Commander says; a session (chat,
     never a task card: task.manage owns those) by id or name, archived ones included so they can be restored. */
  function resolveCrew(ref) {
    if (typeof App === 'undefined' || !App.agents) throw new Error('the crew roster is not ready yet');
    const want = String(ref || '').trim(), crew = App.agents() || [];
    if (!want) throw new Error('name which crew member (an id or a name from station.settings)');
    const hit = crew.find(x => x.id === want) || crew.filter(x => String(x.name || '').toLowerCase() === want.toLowerCase())[0];
    if (!hit) throw new Error('there is no crew member "' + want + '". The crew: ' + crew.map(x => x.name + ' (' + x.id + ')').join(', '));
    return hit;
  }
  /* THE NAME A RESULT GIVES A SESSION = the name the rail shows it by (Workstreams.titleOf): only the General home is
     "General"; an untitled other session is a "New session". A result that said `session: 'General'` for a run filed in a
     fresh untitled session had the lead tell the Commander the work landed in General while the rail read "New session".
     Lookup is unchanged — an untitled session is still addressed by its id — and the session LISTS keep `title: null` for
     untitled, so the model can tell an unnamed session from one literally called "New session". */
  function sessionName(w) {
    if (typeof Workstreams !== 'undefined' && Workstreams.titleOf) return Workstreams.titleOf(w) || 'New session';
    return (w && w.title) || 'General';
  }
  function resolveChat(want) {
    if (typeof Workstreams === 'undefined' || !Workstreams.list) throw new Error('sessions are not ready yet');
    want = String(want || '').trim();
    if (!want) throw new Error('name which session');
    const gid = Workstreams.generalId ? Workstreams.generalId() : null;
    const rows = (Workstreams.list({ includeArchived: true }) || []).filter(w => w && w.kind !== 'task')
      .map(w => ({ w, title: String(w.title != null ? w.title : (w.id === gid ? 'General' : '')).trim() }));
    const lower = want.toLowerCase();
    const byId = rows.filter(r => r.w.id === want), byTitle = rows.filter(r => r.title && r.title.toLowerCase() === lower);
    const hits = byId.length ? byId : byTitle;
    if (hits.length === 1) return hits[0];
    const names = rows.map(r => r.title + (r.w.archived ? ' (archived)' : '')).filter(Boolean).join(', ');
    throw new Error(hits.length > 1 ? 'more than one session is called "' + want + '": use its id from station.settings' : 'there is no session called "' + want + '"' + (names ? '. Sessions: ' + names : ''));
  }
  // the save on disk must show the change before it is reported: flush, read back, check the agent's row
  async function proveCrewSaved(id, check, what) {
    if (typeof CloudSave === 'undefined' || !CloudSave.flush || !CloudSave.pull) throw new Error('durable agent storage is unavailable; do not report ' + what + ' as done');
    if (App.configSynced && await App.configSynced() === false) throw new Error('the crew roster did not reach the station; ' + what + ' may be local only — do not report it as done');
    App.persist();
    if (!await CloudSave.flush({ force: true })) throw new Error('the agent save was refused; do not report ' + what + ' as done');
    const saved = await CloudSave.pull();
    const row = saved && (((saved.agents || []).find(x => x && x.id === id)) || (saved.agent && saved.agent.id === id ? saved.agent : null));
    if (!check(row || null)) throw new Error('the saved station does not show ' + what + '; do not report it as done');
  }
  async function agentControl(act, a) {
    const cfg = App.agentConfig || {};
    const x = resolveCrew(a.agent);
    const row = () => (App.agents() || []).find(r => r.id === x.id) || null;
    if (act === 'agent.model') {
      const model = String(a.model || '').trim(), provider = String(a.provider || '').trim() || (model ? (x.provider || '') : '');
      if (!cfg.setModel) throw new Error('model pins are not available on this page');
      const ok = a.effort != null ? cfg.setModel(x.id, model, provider, String(a.effort)) : cfg.setModel(x.id, model, provider);
      if (!ok) throw new Error('the model could not be set');
      await proveCrewSaved(x.id, r => r && (r.model || '') === model, 'the model change');
      const now = row();
      return { agent: x.name, model: now.model || 'follows the station default', provider: now.provider, reasoningEffort: now.reasoningEffort, applies: 'next run' };
    }
    if (act === 'agent.personality') {
      const pid = String(a.personality || '').trim().toLowerCase();
      if (typeof Personas === 'undefined' || !Personas.exists(pid)) throw new Error('"' + pid + '" is not a personality. Choose: ' + (typeof Personas !== 'undefined' ? Personas.list().map(p => p.id).join(', ') : 'none loaded'));
      if (!cfg.setPersona || !cfg.setPersona(x.id, pid)) throw new Error('the personality could not be set');
      await proveCrewSaved(x.id, r => r && r.personaId === row().personaId, 'the personality change');
      return { agent: x.name, personality: row().personaId, applies: 'next reply' };
    }
    if (act === 'agent.rename') {
      if (!cfg.setName || !cfg.setName(x.id, a.name)) throw new Error('that name could not be used (it needs letters; names are up to 18 characters)');
      const nm = row().name;
      await proveCrewSaved(x.id, r => r && r.name === nm, 'the rename');
      return { agent: x.id, was: x.name, name: nm };
    }
    if (act === 'agent.skin') {
      const sk = String(a.skin || '').trim();
      if (!cfg.setSkin || !cfg.setSkin(x.id, sk)) throw new Error('"' + sk + '" is not a skin; station.settings lists them under options.skin');
      await proveCrewSaved(x.id, r => r && r.skin === sk, 'the new skin');
      return { agent: x.name, skin: sk };
    }
    if (act === 'agent.approval') {
      const mode = a.mode === 'full' ? 'full' : a.mode === 'ask' ? 'ask' : '';
      if (!mode) throw new Error('approval is "ask" or "full"');
      if (!App.setApproval || !App.setApproval(x.id, mode)) throw new Error('the approval mode could not be set');
      await proveCrewSaved(x.id, r => r && (r.approvalMode || 'ask') === mode, 'the approval change');
      return { agent: x.name, approval: mode, applies: 'next run' };
    }
    if (act === 'agent.reach') {
      const p = String(a.reach || '').trim();
      if (!App.setExecutionProfile || !await App.setExecutionProfile(x.id, p)) throw new Error('"' + p + '" could not be set (reach is one of station-gear, safe-cell, remote-ssh, trusted-project, this-computer; the station refused it otherwise)');
      await proveCrewSaved(x.id, r => r && r.executionProfile === p, 'the reach change');
      return { agent: x.name, reach: p, applies: 'next run' };
    }
    if (act === 'agent.away_work') {
      if (!cfg.setWorkshop || !await cfg.setWorkshop(x.id, a.on === true)) throw new Error('the station did not record the away-work change');
      await proveCrewSaved(x.id, r => r && !!r.workshop === (a.on === true), 'the away-work change');
      return { agent: x.name, awayWork: a.on === true };
    }
    if (act === 'agent.delete') {
      if (x.id === 'agent' || x.role === 'orchestrator') throw new Error(x.name + ' is the Overseer and cannot be deleted');
      if (!cfg.deleteAgent || !await cfg.deleteAgent(x.id)) throw new Error('the station refused to delete ' + x.name + ' (it may be working right now: stop it first)');
      await proveCrewSaved(x.id, r => !r, 'the deletion');
      return { deleted: x.name, id: x.id, note: 'its notebook and workspace were archived, not wiped' };
    }
    throw new Error('unknown agent action "' + act + '"');
  }
  async function sessionControl(act, a) {
    const sc = App.sessionControl || {};
    const hit = resolveChat(a.session), id = hit.w.id, label = hit.title || sessionName(hit.w);
    const rowOf = save => (save.workstreams || []).find(w => w && w.id === id);
    if (act === 'session.rename') {
      const title = String(a.title || '').trim().slice(0, 80);
      if (!title) throw new Error('a renamed session needs a title');
      const gid = Workstreams.generalId ? Workstreams.generalId() : null;
      const clash = (Workstreams.list({ includeArchived: true }) || []).find(w => w.id !== id && String(w.title || (w.id === gid ? 'General' : '')).trim().toLowerCase() === title.toLowerCase());
      if (clash) throw new Error('a session called "' + title + '" already exists');
      if (!sc.rename || !await sc.rename(id, title)) throw new Error('the session could not be renamed');
      await persistWorkstreams(save => { const w = rowOf(save); return !!w && w.title === title; });
      return { id, was: label, title };
    }
    if (act === 'session.pin') {
      if (!sc.pin || !sc.pin(id, a.pinned !== false)) throw new Error('the session could not be pinned');
      await persistWorkstreams(save => { const w = rowOf(save); return !!w && !!w.pinned === (a.pinned !== false); });
      return { session: label, pinned: a.pinned !== false };
    }
    if (act === 'session.archive') {
      if (!sc.archive || !await sc.archive(id, a.archived !== false)) throw new Error('the session could not be ' + (a.archived !== false ? 'archived' : 'restored') + (id === (Workstreams.generalId && Workstreams.generalId()) ? ' (General cannot be archived)' : ''));
      await persistWorkstreams(save => { const w = rowOf(save); return !!w && !!w.archived === (a.archived !== false); });
      return { session: label, archived: a.archived !== false };
    }
    if (act === 'session.delete') {
      if (!sc.remove || !await sc.remove(id)) throw new Error('the session could not be deleted (General cannot be deleted, and a session that is working must be stopped first)');
      // a deleted conversation is forgotten: its id is in the save's forgetIds too (qa/bugs/3e926b6a)
      await persistWorkstreams(save => !rowOf(save) && (save.deletedIds || []).indexOf(id) >= 0 && (save.forgetIds || []).indexOf(id) >= 0);
      return { deleted: label, id };
    }
    throw new Error('unknown session action "' + act + '"');
  }

  /* Delivery crosses browser pages, and frontend workstream ids are page-local until their saves converge.
     Prefer the id that launched the run; if this page does not know it, heal ONLY by a unique exact title.
     Substring matching is deliberately forbidden here: an automatic fold must never guess its destination. */
  function resolveDelivery(a) {
    if (typeof Workstreams === 'undefined' || !Workstreams.get || !Workstreams.list) throw new Error('sessions are not ready yet');
    // a routine's result names its session as sessionId (cron delivery); a dispatched worker names it streamId
    const id = String((a && (a.streamId || a.sessionId)) || '');
    const byId = id && Workstreams.get(id);
    if (byId) return { w: byId, resolvedBy: 'id' };
    // A worker thread the overseer JUST filed under a conversation (orchestration.js fileUnderThreads) announces itself
    // before the 2.5s overseer poll adopts it. Adopt it now, under its parent, so its lamp lights and its result lands
    // in its own thread — never refused, never misfiled. Only for a parent this page really holds.
    const parentId = String((a && a.parentStreamId) || '');
    if (id && parentId && Workstreams.get(parentId) && Workstreams.adopt) {
      const w = Workstreams.adopt({ id, title: String((a && a.sessionTitle) || '').trim() || null, titleAuto: false,
        agentId: String((a && a.agentId) || 'agent'), parentStreamId: parentId, worker: true, kind: 'chat', lane: 'active',
        projectRoot: Workstreams.get(parentId).projectRoot || null });   // a project conversation's worker keeps its project
      if (w) { try { if (typeof App !== 'undefined' && App.persist) App.persist(); } catch (_) {} return { w, resolvedBy: 'adopted' }; }
    }
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

  function refreshAndPersist(ws, quiet, turns) {
    const isOpen = Workstreams.activeId && Workstreams.activeId() === ws.id;
    if (isOpen && turns && typeof Chat !== 'undefined' && Chat.deliverTurns) { try { Chat.deliverTurns(ws, turns); } catch (_) {} }
    if (quiet) return;
    try { if (typeof Delegated !== 'undefined' && Delegated.repaint) Delegated.repaint(); } catch (_) {}
    try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (_) {}
    try { if (typeof App !== 'undefined' && App.persist) App.persist(); } catch (_) {}
  }

  // A delivered answer can be partial (budget/iteration/stop). Preserve the recorded terminal reason;
  // the presence of text or a run id alone never establishes that a worker completed its task.
  function noteOutcome(ws, runId, reason) {
    const why = typeof reason === 'string' ? reason.trim().slice(0, 80) : '';
    if (!why || !runId || !Workstreams.noteRunEnd) return false;
    if (ws.lastRunReason === why && ws.lastRunOk === (why === 'done')) return false;
    return Workstreams.noteRunEnd(ws.id, runId, why === 'done', why);
  }

  // Recovery and delayed bridge messages may concern an older attempt on this same thread.
  // Only the run that owns the live channel may settle it; an idle channel is safe to clear.
  function endDeliveredRun(ws, runId) {
    if (typeof Channels === 'undefined' || !Channels.end) return false;
    const busy = Channels.isBusy && Channels.isBusy(ws.id);
    const current = Channels.runIdOf && Channels.runIdOf(ws.id);
    if (busy && (!runId || String(current || '') !== String(runId))) return false;
    Channels.end(ws.id);
    return true;
  }

  /* ONE ANSWER, ONE ROW (org live walk 2026-10-14: a delegated report that finished while the app was closed showed twice,
     and the copy persisted). Opening the session merges its durable transcript (Chat.reconcileServerHistory), which files
     the run's answer as an assistant row stamped with its sourceRunId but never touches ws.runIds; the /api/runs recovery
     below then saw no runId and spliced the same answer in again. A run is filed when the session's run list names it OR
     its history already holds that run's answer. */
  function answerFiled(ws, runId) {
    const id = String(runId || '');
    if (!id) return false;
    return (Array.isArray(ws.history) ? ws.history : []).some(m => m && !m.sys && m.role === 'assistant'
      && String(m.sourceRunId || '') === id && String(m.content == null ? '' : m.content).trim());
  }
  // a run whose answer the transcript merge filed joins the session's run list, so its outcome and run count are true
  function recordFiledRun(ws, runId, ts, beforeRunId) {
    if (!runId || !Workstreams.appendRun || (ws.runIds || []).map(String).indexOf(String(runId)) >= 0) return false;
    return !!Workstreams.appendRun(ws.id, String(runId), ts, beforeRunId);
  }

  function foldDelivery(a, opts) {
    opts = opts || {};
    const hit = resolveDelivery(a);
    const ws = hit.w;
    if (ws.conversationMode === 'group') throw new Error('"' + (ws.title || 'that chat') + '" is a group chat: its transcript belongs to its members, so a worker\'s result cannot be filed into it. Nothing was delivered there');
    const text = String((a && a.text) || '').trim();
    if (!text) throw new Error('nothing to deliver — the worker returned no text');
    const runId = String((a && a.runId) || '');
    if (runId && ((ws.runIds || []).indexOf(runId) >= 0 || answerFiled(ws, runId))) {
      const recorded = recordFiledRun(ws, runId, a.ts, opts.beforeRunId);
      if (noteOutcome(ws, runId, a.reason) || recorded) refreshAndPersist(ws, !!opts.quiet);
      try { endDeliveredRun(ws, runId); } catch (_) {}
      return { folded: false, reason: 'already delivered', session: sessionName(ws), resolvedBy: hit.resolvedBy };
    }
    const who = String((a && a.agentId) || 'agent');
    const prompt = String((a && a.prompt) || '').trim();
    const ts = Number(a && a.ts) > 0 ? Number(a.ts) : Date.now();
    if (!Array.isArray(ws.history)) ws.history = [];
    /* The instruction goes in as a sys marker, not a user turn: the Commander did not type it here, and
       chat.js excludes sys lines from historyWindow() so it is never replayed to the model as if they had. */
    // a worker's OWN thread (filed under its parent) already holds the brief as its first durable turn, named for the
    // agent that wrote it — the marker would say the same thing twice
    const turns = [];
    if (prompt && !ws.worker) turns.push({ role: 'system', sys: true, content: '— delegated to ' + who + ': ' + prompt.slice(0, 400) + ' —', ts });
    turns.push({ role: 'assistant', content: text, agentId: who, ts, sourceRunId: runId || undefined, streamId: ws.id });
    const beforeTurn = opts.recover || opts.beforeRunId ? ws.history.findIndex(m => Number(m && m.ts) > ts) : -1;
    ws.history.splice(beforeTurn < 0 ? ws.history.length : beforeTurn, 0, ...turns);
    if (runId && Workstreams.appendRun) Workstreams.appendRun(ws.id, runId, ts, opts.beforeRunId);
    else if (Workstreams.touch) Workstreams.touch(ws.id);
    noteOutcome(ws, runId, a.reason);
    if (Workstreams.markUnread && !ws.worker) Workstreams.markUnread(ws.id);   // a worker's thread is hidden: the asking conversation gets the one report
    try { endDeliveredRun(ws, runId); } catch (_) {}
    refreshAndPersist(ws, !!opts.quiet, turns);
    return { folded: true, session: sessionName(ws), agentId: who, resolvedBy: hit.resolvedBy };
  }

  /* ---------- station.layout: THE FLOOR AS THE LEAD READS IT (2026-09-28; builds on PR #48 by @mvanhorn) ----------
     Asked to explain or fix a workflow, the lead could not see the floor, so it guessed. This answers from the live
     WorldModel through the Workflow panel's OWN readers, never a second derivation: WorkflowLine.lineFlow (the run
     order, keyed by BAY, so one agent crewing two Bays is two steps), readiness + pillText (what blocks the line,
     the per-BAY workstation gate and a blocking finding anywhere on the floor included), howItRuns (the sentence),
     and lineStarts (schedules, channels, folder and webhook triggers — and the PAUSED ones, with the server's own
     reason — from the same three reads the panel makes). So the lead says what the panel shows, and a panel fix is
     a lead fix. A brief is the text the agent RECEIVES (the compiled dockBays brief = brief + HANDS OFF). Routing is
     the plan poster's verdict (World.planStatus), read in RUN NOW's order. A fact that could not be read is
     reported as unread, never as "nothing". Bays on no line (a crewed lone BAY is a complete dock) are listed too.
     The page answers with the WHOLE floor in full; the sidecar (sidecar/tools/builtin/station.js) adds what only the
     harness knows — the router's own plan, each line's effective budget, today's numbers, each BAY's last run — and
     shapes the answer to the model's window. ⛔ READ-ONLY: nothing here assigns, edits, saves, or posts a plan.
     (Audit 2026-09-28: lone Bays, paused starts, the station-wide refusal, per-BAY compute, the loop's escalation
     lane, the routing verdict order, the belt CYCLE, crew membership and filter rules were fixed here.) */
  const LAYOUT_FACT_MS = 2500;    // each server read gets this long (the bridge itself gives up at 6 s)
  async function readFact(url) {
    let timer = null;
    try {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      if (ctl) timer = setTimeout(() => ctl.abort(), LAYOUT_FACT_MS);
      const r = await fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
      return r && r.ok ? await r.json() : null;
    } catch (_) { return null; } finally { if (timer) clearTimeout(timer); }
  }
  // the three reads the Workflow panel makes for a line's starts (workflowpanel.js refreshServerFacts + ltRefresh)
  async function layoutFacts() {
    const [cron, chans, lt] = await Promise.all([readFact('/api/cron'), readFact('/api/channels/status'), readFact('/api/routing/triggers')]);
    const f = { cron: cron && Array.isArray(cron.jobs) ? cron : null,
      chans: chans && typeof chans === 'object' && !Array.isArray(chans) ? chans : null,
      lt: lt && Array.isArray(lt.triggers) ? lt : null };
    f.unread = [!f.cron && 'routines', !f.chans && 'channels', !f.lt && 'folder and webhook triggers'].filter(Boolean);
    return f;
  }
  const uniq = xs => xs.filter((v, i, a) => a.indexOf(v) === i);
  /* the poster's verdict, read in the order REFIT's RUN NOW gate reads it (build.js finPlanGate): a REFUSED post is
     off; a post that failed or is still in flight is UNCONFIRMED — the router may still be running the previous
     floor — before any compiler finding is read as "off". planHash rides along so the sidecar can confirm the claim
     against the plan the router actually holds. */
  function routingState(sync, drawnBlocking, label) {
    const labels = errs => uniq(errs.map(e => label(e.code))).join(' · ');
    const errs = (sync && sync.errors) || [];
    let out;
    if (!sync || !sync.station) out = { state: 'unknown', note: 'The page could not say whether the router holds this floor.' };
    else if (sync.refusedHash && sync.refusedHash === sync.lastHash) out = { state: 'off', note: 'Routing is OFF for the whole station: the router refused the floor it was last sent, so no line routes work.' + (errs.length ? ' Fix: ' + labels(errs) + '.' : '') };
    else if (sync.stale || sync.inflight || sync.retryPending) out = { state: 'unconfirmed', note: 'The router has not confirmed this floor (the last send failed or is still in flight), so it may still be routing by the previous floor.' };
    else if (errs.length) out = { state: 'off', note: 'Routing is OFF for the whole station: the router refuses the entire floor while any blocking error is on it, so no line routes work. Fix: ' + labels(errs) + '.' };
    else if (!sync.lastHash) out = { state: 'unknown', note: 'The router has not answered for this floor yet.' };
    else out = { state: 'live', note: 'Routing is live: the router is running ' + (sync.pending ? 'the floor as last sent.' : 'this floor.') };
    if (sync && sync.station) out.planHash = sync.hash || null;
    if (sync && sync.station && sync.pending) {
      out.pendingEdits = true;
      out.note += ' The floor has newer edits the router has not received yet (Build mode sends them when it closes, and running a line sends them first)'
        + (out.state === 'off' ? '; they are checked when sent.' : '.');
      if (drawnBlocking.length) out.note += ' As drawn now, the floor has a blocking error the router will refuse: ' + labels(drawnBlocking) + '.';
    }
    return out;
  }
  // one line by exact lineId, exact name, or a UNIQUE name fragment — the same law as resolveSession
  function pickLine(lines, want) {
    const lower = want.toLowerCase();
    const byId = lines.filter(l => l.lineId === want);
    // …or by the word the floor shows it under (LINE F for an unnamed line, LINE RESEARCH for 'Research' — final floor lane M25)
    // An exact NAME speaks before a shown word (repair: a line named 'F' and an unnamed line both matched "F", one by name and one
    // by word; the floor now shows the unnamed one as LINE F 2, and its own name is asked first all the same).
    const shown = typeof Pipeline !== 'undefined' && Pipeline.lineWord ? Pipeline.lineWord(want) : null;
    const byLabel = lines.filter(l => l.name && l.name.toLowerCase() === lower);
    const byName = byLabel.length ? byLabel : lines.filter(l => shown && l.word && l.word === shown);
    const byPart = lines.filter(l => l.name && l.name.toLowerCase().indexOf(lower) >= 0);
    const hits = byId.length ? byId : (byName.length ? byName : byPart);
    if (hits.length === 1) return hits[0];
    const names = lines.map(l => (l.name || l.word || 'unnamed') + ' (' + l.lineId + ')').join(', ');
    throw new Error(hits.length > 1 ? 'more than one line matches "' + want + '" — name it exactly. Lines: ' + names
      : 'there is no line called "' + want + '"' + (names ? '. Lines: ' + names : ' — this station has no assembly lines'));
  }
  // when a LOOP's escalation lane is taken — the router's own rule (chain.js loopDecision), in words
  function escWhen(g) {
    const tries = ' after ' + (g.max || 5) + ' tries';
    if (!g.when) return 'never: the LOOP has no pass condition, so it never gives up';
    return g.when === 'approved' ? 'if it is still not approved' + tries : g.when === 'revise' ? 'if the verdict still does not say revise' + tries
      : 'if it still reads as ' + g.when + ' work' + tries;
  }
  function describeLayout(st, agents, facts, sync, want) {
    const P = Pipeline, W = WorkflowLine, B = typeof Build !== 'undefined' ? Build : null;
    const roster = (agents || []).filter(a => a && a.id);
    const names = {}; for (const a of roster) names[a.id] = a.name || a.id;
    // an id the roster does not hold still RUNS, on the station's default identity; an unread roster says nothing
    const onCrew = id => !roster.length || Object.prototype.hasOwnProperty.call(names, id);
    const who = id => id ? Object.assign({ agentId: id, name: names[id] || id }, onCrew(id) ? {} : { onCrew: false }) : null;
    const upper = id => String(names[id] || id || 'AGENT').toUpperCase();   // the panel's agent label (build.js agentLabelFor)
    const label = code => (B && B.nagLabel) ? B.nagLabel(code) : code;       // the floor's short nag
    const why = code => (B && B.nagWhy) ? B.nagWhy(code) : label(code);      // the panel's full fix sentence (its labelOf)
    const propOf = id => (id && st.propById(id)) || null;
    const roomName = p => { const id = p ? st.roomAt(p.x, p.y) : null; const r = id && st.roomById(id); return r ? (r.name || r.kind || id) : null; };
    const toolsAt = (aid, pid) => { try { return (aid && st.bayObjects(aid, pid)) || []; } catch (_) { return []; } };
    const hasCompute = (aid, pid) => !!aid && toolsAt(aid, pid).indexOf('computer') >= 0;   // PER BAY: router.stationFor(agentId, dockId)
    const toolName = o => (o && typeof o === 'object') ? (o.objectType + (o.connectorId ? ':' + o.connectorId : '')) : String(o);
    // a routine's schedule in words, exactly as the panel says it (build.js wfHost.human)
    const human = d => { const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } })();
      return (typeof CronHuman !== 'undefined' && CronHuman.describeDisplay) ? CronHuman.describeDisplay(d, { tz }) : String(d == null ? '' : d); };

    // geometry props carry the projected frame (station tile = geometry tile + origin); room lookups use station tiles
    const geo = st.projectGeometry(), plan = P.compileRoutingPlan(geo) || {};
    const origin = geo.origin || { tx: 0, ty: 0 };
    const roomAtTile = t => { const id = st.roomAt(t.x + origin.tx, t.y + origin.ty); const r = id && st.roomById(id); return r ? (r.name || r.kind || id) : null; };
    // advice that is not a routing finding (never painted on the floor at rest) still reaches the lead, in its own words
    const ADVICE_LABEL = { SEND_TO_PRIVATE_FILES: 'PRIVATE FILES — THE NEXT CREW CANNOT OPEN THEM' };
    const issue = e => {
      const o = { code: e.code, label: ADVICE_LABEL[e.code] || label(e.code), blocking: !e.warn, propId: e.propId || null };
      const f = why(e.code); if (f !== o.label) o.fix = f;
      if (!o.propId && e.tile) { const room = roomAtTile(e.tile); if (room) o.room = room; }   // a belt CYCLE has only a tile: say where it is
      return o;
    };
    const D = P.dockLayer(plan), dockChains = D.dockChains || {};
    const received = {}; for (const d of (plan.dockBays || [])) received[d.propId] = d.brief || '';
    // a crewed Bay: the compiled brief its agent receives; an uncrewed one: what it WILL receive once crewed
    const briefFor = pid => {
      if (Object.prototype.hasOwnProperty.call(received, pid)) return received[pid];
      const p = propOf(pid);
      return (p && P.composeStageBrief && P.composeStageBrief(p.brief, p.hands)) || '';
    };
    // + the SEND TO file advice, only where it is TRUE (Pipeline.sendToFileAdvice: no project folder, a different crew next — M19 / M29)
    const errors = (plan.errors || []).filter(Boolean).concat(P.sendToFileAdvice ? P.sendToFileAdvice(plan) : []), claimed = new Set();
    const onLine = (c, e) => (e.propId != null && c.props.indexOf(e.propId) >= 0) || !!(e.tile && c.tiles && c.tiles[e.tile.x + ',' + e.tile.y])
      || (e.propId == null && !e.tile && [].concat(e.agentId || [], e.agents || []).some(a => c.bays.some(b => b.agentId === a)));
    const unread = (facts && facts.unread) || [];
    // FILTER rules: a filter junction's routes (tag -> lane) and default, each lane named by the docks it leads to
    const laneDocks = (P.junctionLaneDocks ? P.junctionLaneDocks(plan) : {}) || {};
    const I = P._internals || {};
    const junctionKeyOf = p => (plan.belts && plan.belts[p.x + ',' + p.y]) ? p.x + ',' + p.y
      : (I.beltTileNear ? (t => t ? t.x + ',' + t.y : null)(I.beltTileNear(plan.belts || {}, p.x, p.y, p.w || 1, p.h || 1)) : null);
    const comps = (P.lineComponents(geo) || []).filter(c => c.intakes.length || c.bays.length || c.outboxes.length);
    // SEND TO (2026-10-10): a line names another by its INBOX's label; the hand-offs are the COMPILED plan's (plan.sendTo)
    /* the floor's own name for a line (worldmodel.lineName: its first named INBOX, else LINE <its first INBOX's letter> — what the
       plates and the SEND TO chips say), with its lineId when unnamed so station.layout line= can still take it (final floor lane
       M25 / R62: 'an unnamed line' named no line the Commander could see) */
    const floorWord = id => (typeof st.lineName === 'function' ? st.lineName(id) : null);
    const lineName = id => { const cc = comps.find(x => x.key === id), l = cc ? (cc.intakes.map(i => propOf(i)).find(p => p && p.label) || {}).label : null; if (l) return P.lineWord ? P.lineWord(l) : 'LINE ' + String(l).replace(/^line\b[\s:·-]*/i, '').toUpperCase(); const w = floorWord(id); return (w || 'an unnamed line') + ' (lineId ' + id + ')'; };
    // the SEND TOs a step's own lane can ship into (a line with two OUTBOXes hands on only from the one that sends — 10-11 repair)
    const sendsOf = (lineId, pid) => (P.sendsReachedOf ? P.sendsReachedOf(plan, lineId, pid) : []);
    const reachedOf = pid => (P.outboxesReached ? P.outboxesReached(plan, pid) : []);
    const sendWords = (lineId, pid) => {
      const ss = sendsOf(lineId, pid);
      if (!ss.length) return 'OUTBOX';
      const to = ss.map(x => lineName(x.toLine)).filter((v, i, a) => a.indexOf(v) === i).join(' or ');
      return reachedOf(pid).length > ss.length ? 'OUTBOX (the one that sends on goes to ' + to + ' — SEND TO; another OUTBOX it can reach keeps its work)'
        : 'OUTBOX, then on to ' + to + ' (SEND TO: that line’s own crew and budget work it next)';
    };

    let lines = comps.map(c => {
      const flow = W.lineFlow(plan, c, P, geo.props);
      const starts = W.lineStarts(flow, { lt: facts.lt, lineKey: c.key, cron: facts.cron, chans: facts.chans, agents, human });
      const anyStart = !!(starts.schedules.length || starts.channels.length || starts.events.length);
      // the panel's facts, verbatim (build.js wfHost: hasCompute per BAY; workflowpanel.js paintHead: briefOf, labelOf, isCrew)
      const ready = W.readiness(flow, c, { hasCompute, errors: plan.errors || [], labelOf: why, isCrew: onCrew,
        briefOf: pid => { const p = propOf(pid); return p && (p.brief || p.hands); }, stepName: pid => { const p = propOf(pid); return p && p.label; }, triggers: starts });
      const segs = W.howItRuns(flow, { nameOf: upper, handsOf: pid => { const p = propOf(pid); return p && p.hands; }, triggers: starts });
      let hints = ready.hints.map(h => h.what);
      if (unread.length && flow.trigger.propId && !anyStart && !flow.cyclic) {
        // a start the page could not read is unknown, not absent: never let "nothing starts it" stand on a failed read
        const unsure = 'What starts it could not be fully read right now (' + unread.join(', ') + ' unavailable)' + (starts.paused.length ? '; paused: ' + starts.paused.join('; ') : '') + '; ';
        if (segs[0] && /^(Nothing starts it|It runs when you send it a job)/.test(segs[0].s)) segs[0] = { t: 'text', s: unsure };   // (2026-09-30: the short opening too)
        hints = hints.filter(h => !/^nothing starts it/.test(h)).concat(['check what starts this line again: ' + unread.join(', ') + ' could not be read']);
      }
      const step = {}; flow.order.forEach((pid, i) => { step[pid] = i + 1; });
      const ref = pid => ({ step: step[pid] || null, propId: pid, agent: flow.docks[pid] && flow.docks[pid].agentId ? upper(flow.docks[pid].agentId) : null });
      // the ESCALATION lanes: gate -> the docks it runs after, and the dock it escalates to (never a plain hand-off)
      const escGates = flow.gates.filter(g => g.kind === 'loop' && g.escTo);
      const escFrom = (from, to) => escGates.some(g => g.escTo === to && (g.after || []).indexOf(from) >= 0);
      const MODE = { all: 'in parallel', turns: 'taking turns', oneof: 'whichever the content routes to' };
      const colMode = {}; for (const col of flow.cols) for (const d of col.docks) colMode[d.propId] = col.docks.length > 1 ? (MODE[col.mode] || null) : null;
      const steps = flow.order.map(pid => {
        const d = flow.docks[pid], sp = propOf(pid), nb = W.neighbours(flow, pid), ch = dockChains[pid];
        const fed = !!(D.reachDock || {})[pid];
        const s = { step: step[pid], propId: pid, role: d.role || null, room: roomName(sp), agent: who(d.agentId),
          routed: !!d.routed, fedByInbox: fed,
          getsWorkFrom: (fed ? ['INBOX'] : []).concat(nb.prev.map(p => escFrom(p, pid) ? Object.assign(ref(p), { onEscalation: true }) : ref(p))),
          // (its OUTBOX may SEND the line's finished work on to another line: the agent must never say the work stops there)
          sendsTo: d.agentId ? nb.next.filter(n => !escFrom(pid, n)).map(ref).concat(ch && ch.outbox ? [sendWords(c.key, pid)] : []) : [],
          brief: briefFor(pid), tools: d.agentId ? toolsAt(d.agentId, pid).map(toolName) : [] };
        const esc = escGates.filter(g => (g.after || []).indexOf(pid) >= 0);
        if (esc.length && d.agentId) s.escalatesTo = esc.map(g => Object.assign(ref(g.escTo), { when: escWhen(g), runs: !!g.when }));
        if (colMode[pid]) s.runsWith = colMode[pid];
        const gate = escGates.find(g => g.escTo === pid);
        if (!d.agentId) s.note = 'no agent yet: not routed until one is assigned';
        else if (flow.cyclic) s.note = 'a belt LOOP on the floor stops all routing';
        else if (d.escalation && gate) s.note = gate.when ? 'runs only on the LOOP\'s escalation lane: ' + escWhen(gate) : 'on the LOOP\'s escalation lane, which never runs: the LOOP has no pass condition';
        else if (d.detached) s.note = 'not connected to the INBOX';
        else if (flow.probeNext && flow.probeNext[pid]) s.note = 'its belt leads on to ' + flow.probeNext[pid].map(n => 'step ' + (step[n] || '?')).join(' or ') + ', which has no agent yet';
        else if (d.deadEnd) s.note = 'its work goes nowhere: connect a belt onward';
        if (d.agentId && !onCrew(d.agentId)) s.note = (s.note ? s.note + '; ' : '') + 'its agent is not on the crew, so its runs use the station\'s default identity';
        return s;
      });
      const gates = flow.gates.map(g => g.kind === 'loop'
        ? Object.assign({ kind: 'loop', propId: g.propId || null, after: (g.after || []).map(ref), sendsBackTo: g.backTo ? ref(g.backTo) : null, until: g.when || null, maxPasses: g.max || null },
          g.escTo ? { escalatesTo: ref(g.escTo), escalation: escWhen(g) } : {})
        : { kind: g.kind, propId: g.propId || null, after: (g.after || []).map(ref) });
      // FILTER rules on this line: which tagged work goes to which step (the rest takes the default lane)
      const filters = [];
      for (const fp of (geo.props || [])) {
        if (fp.t !== 'filter' || c.props.indexOf(fp.id) < 0) continue;
        const jk = junctionKeyOf(fp), j = jk && plan.junctions && plan.junctions[jk], lanes = (jk && laneDocks[jk]) || {};
        if (!j || j.kind !== 'filter') continue;
        const to = dir => (lanes[dir] || []).filter(pid => step[pid]).map(ref);
        filters.push({ propId: fp.id, rules: Object.keys(j.routes || {}).map(tag => ({ tag, goesTo: to(j.routes[tag]) })), otherwise: j.def ? to(j.def) : [] });
      }
      const mine = errors.filter(e => onLine(c, e)); mine.forEach(e => claimed.add(e));
      const out = { lineId: c.key, name: (c.intakes.map(id => propOf(id)).find(p => p && p.label) || {}).label || null, word: floorWord(c.key) || null,
        status: W.pillText(ready), ready: !!ready.ready, howItRuns: W.sentenceText(segs),
        blocking: ready.blocking.map(b => b.what), hints,
        starts: { schedules: starts.schedules, channels: starts.channels, events: starts.events, paused: starts.paused,
          routines: starts.routines.map(r => ({ name: r.name, agent: upper(r.agentId), enabled: r.enabled, runsWholeLine: r.runsLine, atEntry: r.atEntry, startsLine: r.startsLine, schedule: human(r.display) })),
          channelBots: starts.chanRows.map(r => ({ label: r.label, connected: r.connected, answersAs: r.answersAs, feedsThisLine: r.feeds })) },
        steps, gates, filters, issues: mine.map(issue) };
      // SEND TO: where this line hands every finished job on to, and which lines hand theirs to it (compiled — a SEND TO the
      // compiler turned off, a circle or a gone INBOX, is in `issues`, never here)
      const st = plan.sendTo || {}, outs = Object.keys(st).filter(k => st[k].fromLine === c.key), ins = Object.keys(st).filter(k => st[k].toLine === c.key);
      if (outs.length) {
        // which steps ship into each sending OUTBOX: only THOSE jobs ride on (a line with two OUTBOXes hands on from the one that sends)
        const afterOf = k => flow.order.filter(pid => reachedOf(pid).indexOf(k) >= 0).map(pid => step[pid]).filter(Boolean);
        out.sendsWorkTo = outs.map(k => ({ lineId: st[k].toLine, name: lineName(st[k].toLine), outboxPropId: k, afterSteps: afterOf(k) }));
        if (c.outboxes.length <= 1) out.howItRuns += ' Then every job it finishes cleanly is sent on to ' + out.sendsWorkTo.map(x => x.name).join(' and ') + ' (SEND TO), whose own crew works it next.';
        else out.howItRuns += ' Then ' + out.sendsWorkTo.map(x => 'a job that lands in its OUTBOX ' + x.outboxPropId + (x.afterSteps.length ? ' (after step ' + x.afterSteps.join(' or ') + ')' : '') + ' is sent on to ' + x.name).join('; ')
          + ' (SEND TO), whose own crew works it next' + (outs.length < c.outboxes.length ? '; a job that lands in another of its ' + c.outboxes.length + ' OUTBOXes stops there.' : '.');
      }
      if (ins.length) out.getsWorkFromLines = ins.map(k => ({ lineId: st[k].fromLine, name: lineName(st[k].fromLine), intakePropId: st[k].intakeId }));
      if (unread.length) out.startsUnread = unread;
      return out;
    });
    // BAYS ON NO LINE: a crewed lone BAY is a complete dock (work addressed to its agent lands there, with its brief and
    // its room's tools — router.stationFor); an uncrewed one does nothing. Never invisible, never only an issue code.
    const onAnyLine = {}; for (const c of comps) for (const b of c.bays) onAnyLine[b.propId] = true;
    const loneBays = (st.props() || []).filter(p => p && p.t === 'bay' && !onAnyLine[p.id]).map(p => {
      const aid = p.agentId || null;
      const o = { propId: p.id, role: p.role || null, room: roomName(p), agent: who(aid), brief: briefFor(p.id), tools: aid ? toolsAt(aid, p.id).map(toolName) : [] };
      o.note = !aid ? 'no agent and not on a belt line: it does nothing until an agent is assigned'
        : 'not on a belt line: work addressed to ' + upper(aid) + ' arrives at this BAY directly, with this brief and this room\'s tools'
          + (hasCompute(aid, p.id) ? '' : '; it has no workstation here, so those runs cannot compute')
          + (onCrew(aid) ? '' : '; its agent is not on the crew, so its runs use the station\'s default identity');
      return o;
    });
    if (want) lines = [pickLine(lines, want)];
    const drawnBlocking = errors.filter(e => !e.warn);
    const cron = facts && facts.cron;
    return {
      routing: routingState(sync, drawnBlocking, label),
      // the scheduler as the routines panel reads it: E-STOP freezes it even while its arm intent stays on
      automation: cron ? { scheduler: cron.halted ? 'stopped by E-STOP' : cron.enabled ? 'on' : 'off' } : null,
      lines,
      loneBays: want ? [] : loneBays,
      // a finding on no line (a beltless Inbox, a buried belt, a stray CYCLE) is still a finding: reported, never dropped
      otherIssues: want ? [] : errors.filter(e => !claimed.has(e)).map(issue),
      rooms: (st.rooms() || []).filter(r => r && r.kind !== 'corridor').map(r => ({ id: r.id, name: r.name || null, kind: r.kind || null })),
      workstations: (st.props() || []).filter(p => p && p.agentId && p.t !== 'bay').map(p => ({ propId: p.id, type: p.t, room: roomName(p), agent: who(p.agentId),
        grants: (typeof WorldModel !== 'undefined' && WorldModel.capForProp && WorldModel.capForProp(p.t)) || null }))
    };
  }

  // the station builder's parked plans: planId -> { plan, at }, ten minutes, used once
  const builderPlans = new Map(), PLAN_TTL_MS = 10 * 60 * 1000;
  /* the lead's builds on this station, newest last: what an undo may take back. Kept per station (its createdAt) in
     localStorage so a reload keeps them; an undo still plans only while the station is exactly as that build left it. */
  const builtKey = st => 'starnet.builderBuilt.' + ((st && st.doc && st.doc().meta && st.doc().meta.createdAt) || 'station');
  const builtRead = st => { try { const v = JSON.parse(localStorage.getItem(builtKey(st)) || '[]'); return Array.isArray(v) ? v.slice(-10) : []; } catch (_) { return []; } };
  const builtWrite = (st, list) => { try { localStorage.setItem(builtKey(st), JSON.stringify(list.slice(-10))); } catch (_) {} };
  let planSeq = 0;
  const NEXT_STEP = 'Tell the Commander the summary in plain words, then call station.build with this planId. Nothing has been built yet.';
  // a LINE plan with nobody on a step says how to staff it in the same plan (StationBuilder.planNext: its top-level steps), else the
  // usual word; a room or build plan staffs a line inside its zones and lines (staff), so its receipt names the staff form instead
  const planNextOf = pl => (StationBuilder.planNext && StationBuilder.planNext(pl, (App.agents ? App.agents() : []).map(x => x && x.name).filter(Boolean))) || NEXT_STEP;
  function park(r) {
    if (!r || !r.ok) throw new Error((r && r.error) || 'the plan failed');
    const now = Date.now();
    for (const [id, e] of builderPlans) if (now - e.at > PLAN_TTL_MS) builderPlans.delete(id);
    const planId = 'plan-' + now.toString(36).slice(-5) + '-' + (++planSeq);
    builderPlans.set(planId, { plan: r.plan, at: now });
    return { planId, plan: r.plan };
  }
  // the card's drawing for a build card: the newest parked plan with that summary (the card shows the plan's own words)
  function previewFor(summary) {
    let best = null;
    for (const e of builderPlans.values()) if (e.plan && e.plan.summary === summary && e.plan.preview && Date.now() - e.at <= PLAN_TTL_MS && (!best || e.at >= best.at)) best = e;
    return best ? best.plan.preview : null;
  }
  /* LOOK (2026-10-01): the station as it really renders (the scene pass the stage draws: floors, walls, every piece, light),
     so a model that can see judges its own design and fixes what looks wrong. A room name frames that room up close (one
     tile round it, walls included); no name frames the whole station. WebP (else JPEG), shrunk until it fits one page
     answer (the sidecar takes 256 KB). */
  const LOOK_CHARS = 180000;
  const blobOfCanvas = (cv, type, q) => new Promise(res => { try { cv.toBlob(b => res(b || null), type, q); } catch (_) { res(null); } });
  const base64OfBlob = b => new Promise(res => { try { const fr = new FileReader(); fr.onload = () => { const s = String(fr.result || ''); res(s.slice(s.indexOf(',') + 1)); }; fr.onerror = () => res(''); fr.readAsDataURL(b); } catch (_) { res(''); } });
  async function lookAt(st, env, ref) {
    if (typeof World === 'undefined' || typeof World.renderStill !== 'function' || typeof World.renderStillOfTiles !== 'function') throw new Error('the station picture is not available on this page');
    let tiles = null, of = 'the whole station', issues = null;
    if (ref) {
      const d = StationBuilder.mapOf(st.serialize(), env, { room: ref });
      if (!d || !d.ok) throw new Error((d && d.error) || 'there is no room "' + ref + '"');
      const rs = d.map.rects || [];
      tiles = { x1: Math.min(...rs.map(q => q.x)), y1: Math.min(...rs.map(q => q.y)), x2: Math.max(...rs.map(q => q.x + q.w - 1)), y2: Math.max(...rs.map(q => q.y + q.h - 1)) };
      of = d.map.room; issues = Array.isArray(d.map.issues) ? d.map.issues : [];
    }
    for (let px = 1400; px >= 400; px = Math.round(px * 0.75)) {
      const still = tiles ? World.renderStillOfTiles(tiles, px, { noBodies: false }) : World.renderStill(px);
      if (!still || !still.canvas) throw new Error('the station is not drawn yet (it may still be waking up): look again in a moment');
      let b = await blobOfCanvas(still.canvas, 'image/webp', 0.82);
      if (!b || b.type !== 'image/webp') b = await blobOfCanvas(still.canvas, 'image/jpeg', 0.85);
      if (!b || !/^image\/(webp|jpeg)$/.test(b.type)) throw new Error('this page could not encode the picture');
      const data = await base64OfBlob(b);
      if (!data) throw new Error('this page could not encode the picture');
      if (data.length > LOOK_CHARS) continue;
      const out = { look: of, mime: b.type, width: still.width, height: still.height, data };
      if (issues) out.issues = issues.slice(0, 12);
      if (tiles) Object.assign(out, { shows: { x1: tiles.x1 - 1, y1: tiles.y1 - 1, x2: tiles.x2 + 1, y2: tiles.y2 + 1 }, tilePx: Math.round(still.width / (tiles.x2 - tiles.x1 + 3)) });
      return out;
    }
    throw new Error('the picture of ' + of + ' is too big to send: look at one room');
  }
  async function builderServices(projects, services) {
    const get = async url => { try { const r = await fetch(url, { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch (_) { return null; } };
    const out = {};
    if (projects) { const j = await get('/api/projects'); if (j && Array.isArray(j.projects)) out.projects = j.projects.filter(x => x && x.blessed === true && x.root).map(x => ({ name: x.name || x.label || null, root: x.root })); }
    if (services) {
      const c = await get('/api/connectors'); if (c && Array.isArray(c.connectors)) out.connectors = c.connectors.map(x => ({ id: x.id, label: x.label || x.id }));
      const p = await get('/api/plugins'); if (p && Array.isArray(p.plugins)) out.plugins = p.plugins.filter(x => x && x.active).map(x => ({ id: x.id, name: x.name || x.id }));
    }
    return out;
  }
  function builderReady(a) {
    const st = typeof App !== 'undefined' && App.station ? App.station() : null;
    if (!st || !st.serialize || !st.transact || !st.roomSpots) throw new Error('the station is not ready yet');
    if (typeof StationBuilder === 'undefined' || typeof WorldModel === 'undefined' || typeof Pipeline === 'undefined' || typeof WorkflowLine === 'undefined')
      throw new Error('the station builder is not loaded on this page');
    if (typeof Build !== 'undefined' && Build.isOpen && Build.isOpen()) throw new Error('Build mode is open, so the Commander is editing the floor. Ask them to close Build mode, then plan again.');
    const crew = (App.agents ? App.agents() : []).map(x => ({ id: x.id, name: x.name }));
    return { st, env: { WorldModel, Pipeline, WorkflowLine, crew, heroId: App.heroId ? App.heroId() : null,
      StationTemplates: typeof StationTemplates !== 'undefined' ? StationTemplates : null, PropSprites: typeof PropSprites !== 'undefined' ? PropSprites : null,
      // vibe design: the zone styles, and the Workflow panel's own layout engine and graph edits for a zone's line
      RoomStyles: typeof RoomStyles !== 'undefined' ? RoomStyles : null, LineLayout: typeof LineLayout !== 'undefined' ? LineLayout : null, LineEdit: typeof LineEdit !== 'undefined' ? LineEdit : null,
      EquipmentHelp: typeof EquipmentHelp !== 'undefined' ? EquipmentHelp : null,
      // a step marked "new" recruits that role's specialist exactly as the setup guide's RECRUIT does (Build.summonForRole: its desk comes with it)
      // a LENT plan (team.dispatch builder:true; the sidecar sets delegated) never recruits: new crew stays the lead's call
      canRecruit: !(a && a.delegated) && typeof Build !== 'undefined' && typeof Build.summonForRole === 'function' && !!App.summonAgent,
      recruitRefusal: a && a.delegated ? 'Recruiting new crew stays with the lead who lent you the builder. Staff the step with a crew member, or leave agent out and name the role in your result.' : null,
      recruit: role => Build.summonForRole(role, WorldModel.bayRoleInfo ? WorldModel.bayRoleInfo(role) : null) } };
  }

  // A build is a mutation boundary: do not depend on the next animation frame to publish its floor.
  // Keep the receipt inside the bridge's six-second deadline. Publication may continue after this wait;
  // its failure never undoes the applied floor or makes the consumed plan safe to apply twice.
  async function builderPublication() {
    const unconfirmed = reason => ({ published: false, reason });
    const unknown = 'The floor was built, but its work lines are not confirmed yet. Check Workflow before starting a line.';
    if (typeof World === 'undefined' || typeof World.syncPlan !== 'function') return unconfirmed(unknown);
    let timer = null;
    try {
      const pending = World.syncPlan(); // rederive is synchronous; pin exactly the floor this build offered
      const offered = typeof World.planStatus === 'function' ? World.planStatus() : null;
      const expectedHash = offered && offered.hash, expectedKey = offered && (offered.pendingHash || offered.lastHash);
      const s = await Promise.race([
        pending,
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 3500); })
      ]);
      if (!s || !expectedHash || !expectedKey || s.hash !== expectedHash || s.lastHash !== expectedKey
        || String(s.lastHash).split('|')[0] !== s.hash) return unconfirmed(unknown);
      const current = typeof World.planStatus === 'function' ? World.planStatus() : s;
      for (const state of [s, current]) {
        if (!state) return unconfirmed(unknown);
        const errors = (state.errors || []).filter(e => !e.warn);
        if (errors.length) return unconfirmed('The floor was built, but its work lines need repairs: '
          + [...new Set(errors.map(e => typeof Build !== 'undefined' && Build.nagLabel ? Build.nagLabel(e.code) : e.code))].join(' · ') + '. Check Workflow.');
        if (state.refusedHash && state.refusedHash === state.lastHash)
          return unconfirmed('The floor was built, but the station refused its work lines. Fix the findings in Workflow before starting a line.');
        if (state.pending || state.stale || state.inflight || state.retryPending || state.pendingHash) return unconfirmed(unknown);
      }
      if (current.hash !== s.hash || current.lastHash !== s.lastHash) return unconfirmed(unknown);
      return { published: true, hash: s.hash };
    } catch (_) { return unconfirmed(unknown); }
    finally { if (timer != null) clearTimeout(timer); }
  }

  /* #121: a build is SAVED only when the station file holds it. The floor on screen proves nothing about a restart (the
     browser cache can be full), so, like station.update_agent: queue the live save, flush it, read the station file
     back and compare the floor. Bounded so the receipt stays inside the bridge's six-second deadline (it runs beside
     builderPublication); any doubt answers durable:false, and the build itself is never undone. */
  const DURABLE_WAIT_MS = 3000;
  async function builderDurability(st) {
    const unproven = { durable: false, durability: 'The floor is built on screen, but the station file has not confirmed it yet, so it could revert after a restart. Do not tell the Commander it is saved.' };
    if (typeof App === 'undefined' || !App.persist || typeof CloudSave === 'undefined' || !CloudSave.flush || !CloudSave.pull || typeof StationBuilder === 'undefined' || !StationBuilder.sigOf) return unproven;
    let timer = null;
    try {
      // the floor as JSON carries it (a key holding undefined is dropped on the wire, so compare like with like)
      const want = StationBuilder.sigOf(JSON.parse(JSON.stringify(st.serialize())));
      App.persist();
      const proof = (async () => {
        if (await CloudSave.flush({ force: true }) !== true) return false;
        const saved = await CloudSave.pull();
        return !!(saved && saved.station && StationBuilder.sigOf(saved.station) === want);
      })().catch(() => false);
      const ok = await Promise.race([proof, new Promise(resolve => { timer = setTimeout(() => resolve(false), DURABLE_WAIT_MS); })]);
      return ok === true ? { durable: true } : unproven;
    } catch (_) { return unproven; }
    finally { if (timer != null) clearTimeout(timer); }
  }

  const VERBS = {
    /* A crew-written plugin DRAFT's window, previewed (plugin.preview tool): sandboxed, a throwaway store, no backend.
       The sidecar names the draft, its digest and its screens; PluginHost opens (or reloads) the DRAFT window. */
    // APPS: the crew rewrote an app's page, or published new data into it — the open window follows at once
    'app.reload': (a) => {
      if (typeof AppsUI === 'undefined' || !AppsUI.onReload) throw new Error('apps are not loaded on this page');
      return AppsUI.onReload(String((a && a.id) || ''), a && a.digest);
    },
    'app.data': (a) => {
      if (typeof AppsUI === 'undefined' || !AppsUI.onData) throw new Error('apps are not loaded on this page');
      return AppsUI.onData(String((a && a.id) || ''));
    },
    'plugin.preview': (a) => {
      if (typeof PluginHost === 'undefined' || !PluginHost.preview) throw new Error('plugin windows are not loaded on this page');
      return PluginHost.preview(a || {});
    },

    /* The floor, read-only, for the lead: routing state, every assembly line as the Workflow panel reads it, rooms,
       and workstation holders. Refuses honestly when the station, routing, or the line reader is not loaded. */
    'station.layout': async (a) => {
      const st = typeof App !== 'undefined' && App.station ? App.station() : null;
      if (!st || !st.projectGeometry || !st.rooms || !st.bayObjects) throw new Error('the station layout is not ready yet');
      if (typeof Pipeline === 'undefined' || !Pipeline.compileRoutingPlan || !Pipeline.lineComponents || !Pipeline.dockLayer) throw new Error('workflow routing is not loaded on this page');
      if (typeof WorkflowLine === 'undefined' || !WorkflowLine.lineStarts) throw new Error('the workflow line reader is not loaded on this page');
      const want = String((a && a.line) || '').trim().slice(0, 80);
      let sync = null;
      try { sync = (typeof World !== 'undefined' && World && World.planStatus) ? World.planStatus() : null; } catch (_) { sync = null; }   // unreadable = unknown, never live
      const facts = await layoutFacts();
      return describeLayout(st, typeof App !== 'undefined' && App.agents ? App.agents() : [], facts, sync, want);
    },

    /* THE STATION BUILDER (2026-09-29, the Agent Station Builder plan): the lead ADDS a ready-made line and never places
       anything itself. plan_line builds the request on a copy (StationBuilder.plan — every check runs there) and parks the
       plan here for ten minutes; station.build applies exactly that plan in one undo step (StationBuilder.apply). They
       refuse while Build mode is open: the Commander's own edits own the floor then. */
    'station.plan_line': (a) => {
      const { st, env } = builderReady(a);
      const p = park(StationBuilder.plan(st.serialize(), (a && a.request) || {}, env));
      return { planId: p.planId, summary: p.plan.summary, line: p.plan.line, where: p.plan.where, steps: p.plan.steps, ready: p.plan.ready, blocking: p.plan.blocking,
        recruits: p.plan.recruits, picked: p.plan.picked, notes: p.plan.notes, expiresInMinutes: PLAN_TTL_MS / 60000, next: planNextOf(p.plan) };
    },
    // ROOMS & DECOR (phase 2): a hand-designed room kit (a new room, or furnishing one with clear floor), or every room of a preset
    'station.plan_room': (a) => {
      const { st, env } = builderReady(a);
      const p = park(StationBuilder.planRoom(st.serialize(), (a && a.request) || {}, env));
      return { planId: p.planId, summary: p.plan.summary, rooms: p.plan.rooms, lines: p.plan.lines, steps: p.plan.steps, notes: p.plan.notes, expiresInMinutes: PLAN_TTL_MS / 60000, next: NEXT_STEP };
    },
    /* THE SPATIAL BUILDER (2026-09-30): the lead SEES the floor (station.map: every room's place and size, what joins what,
       what fits where, the floor drawn in characters) and then says where rooms go in words — beside which room, on which
       side, how big, by a hallway or open plan, empty or filled. StationBuilder.planBuild turns that into tiles. */
    'station.map': async (a) => {
      const st = typeof App !== 'undefined' && App.station ? App.station() : null;
      if (!st || !st.serialize || !st.rooms) throw new Error('the station is not ready yet');
      if (typeof StationBuilder === 'undefined' || !StationBuilder.mapOf || typeof WorldModel === 'undefined') throw new Error('the station builder is not loaded on this page');
      const crew = (App.agents ? App.agents() : []).map(x => ({ id: x.id, name: x.name }));
      const env = { WorldModel, Pipeline: typeof Pipeline !== 'undefined' ? Pipeline : null, crew,
        PropSprites: typeof PropSprites !== 'undefined' ? PropSprites : null, RoomStyles: typeof RoomStyles !== 'undefined' ? RoomStyles : null, LineEdit: typeof LineEdit !== 'undefined' ? LineEdit : null };
      if (a && a.look != null && a.look !== false) return lookAt(st, env, a.look === true ? null : String(a.look).slice(0, 60));
      const r = StationBuilder.mapOf(st.serialize(), env, { room: a && a.room != null ? String(a.room) : null, catalog: !!(a && a.catalog) });
      if (!r || !r.ok) throw new Error((r && r.error) || 'the map could not be read');
      return r.map;
    },
    'station.plan_build': (a) => {
      const { st, env } = builderReady(a);
      const p = park(StationBuilder.planBuild(st.serialize(), (a && a.request) || {}, env));
      return { planId: p.planId, summary: p.plan.summary, rooms: p.plan.rooms, hallways: p.plan.hallways, lines: p.plan.lines, steps: p.plan.steps, notes: p.plan.notes, expiresInMinutes: PLAN_TTL_MS / 60000, next: NEXT_STEP };
    },
    // the one cosmetic change: a room's floor, material or name
    'station.plan_restyle': (a) => {
      const { st, env } = builderReady(a);
      const p = park(StationBuilder.planRestyle(st.serialize(), (a && a.request) || {}, env));
      return { planId: p.planId, summary: p.plan.summary, notes: p.plan.notes, expiresInMinutes: PLAN_TTL_MS / 60000, next: NEXT_STEP };
    },
    // EDIT WHAT STANDS: remove rooms, refurnish a room in another style, or clear a room's furniture
    'station.plan_edit': async (a) => {
      const { st, env } = builderReady(a);
      if (!StationBuilder.planEdit) throw new Error('this page cannot edit what stands yet; reload it');
      const req = (a && a.request) || {};
      // a refit that sets a line's folder or binds a portal: the trusted projects / connected services / plugins that are on,
      // read from the sidecar as Build mode reads them, so the plan only ever names what the station has
      const ops = Array.isArray(req.refit) ? req.refit : [], want = k => ops.some(o => o && typeof o.op === 'string' && o.op.toLowerCase().trim() === k);
      if (want('folder') || want('bind')) env.services = await builderServices(want('folder'), want('bind'));
      const p = park(StationBuilder.planEdit(st.serialize(), req, env));
      return { planId: p.planId, summary: p.plan.summary, steps: p.plan.steps, notes: p.plan.notes, expiresInMinutes: PLAN_TTL_MS / 60000, next: NEXT_STEP };
    },
    // a line by name or by a machine on it (station.test_line): the routing plan's lineId and its steps in words
    'station.line_ref': (a) => {
      const st = typeof App !== 'undefined' && App.station ? App.station() : null;
      if (!st || !st.serialize) throw new Error('the station is not ready yet');
      if (typeof StationBuilder === 'undefined' || !StationBuilder.lineRef || typeof Pipeline === 'undefined') throw new Error('this page cannot read its lines yet; reload it');
      const crew = (App.agents ? App.agents() : []).map(x => ({ id: x.id, name: x.name }));
      const r = StationBuilder.lineRef(st.serialize(), { WorldModel, Pipeline, crew, PropSprites: typeof PropSprites !== 'undefined' ? PropSprites : null }, String((a && a.line) || '').slice(0, 80), a && a.room != null ? String(a.room).slice(0, 60) : null);
      if (!r || !r.ok) throw new Error((r && r.error) || 'that line could not be found');
      return { lineId: r.lineId, name: r.name, room: r.room, steps: r.steps, crewed: r.crewed };
    },
    // a prop the lead just made (station.make_prop): load the MADE BY YOU library so the builder can place it by name
    'station.props_reload': async () => {
      if (typeof UserProps === 'undefined' || !UserProps.load) throw new Error('made props are not loaded on this page');
      const r = await UserProps.load({ fresh: true });
      return { props: ((r && r.props) || []).map(p => ({ id: p.id, label: p.label })) };
    },
    // "no, undo that": the lead's own last build, only while nothing has changed since
    'station.plan_undo': () => {
      const { st } = builderReady();
      if (!StationBuilder.planUndo) throw new Error('this page cannot undo a build yet; reload it');
      const built = builtRead(st);
      const p = park(StationBuilder.planUndo(st.serialize(), built[built.length - 1] || null, { canUndo: typeof st.canUndo === 'function' ? st.canUndo() : true }));
      return { planId: p.planId, summary: p.plan.summary, notes: p.plan.notes, expiresInMinutes: PLAN_TTL_MS / 60000, next: NEXT_STEP };
    },
    // builds ANY parked plan, exactly, in one undo step
    'station.build': async (a) => {
      const { st, env } = builderReady();
      const planId = String((a && a.planId) || '').trim();
      const e = builderPlans.get(planId);
      if (!e || Date.now() - e.at > PLAN_TTL_MS) { builderPlans.delete(planId); throw new Error('There is no plan "' + planId.slice(0, 40) + '" (plans last ten minutes and are used once). Plan it again.'); }
      // a swap backs the current layout up to Build mode's own slot first, so RESTORE PREVIOUS in Build → Presets brings it back
      let backup = null;
      if (e.plan.spec && (e.plan.spec.kind === 'swap' || e.plan.spec.kind === 'relayout')) {
        const key = 'starnet.layoutBackup.' + st.doc().meta.createdAt;
        try { backup = { key, old: localStorage.getItem(key) }; localStorage.setItem(key, JSON.stringify(st.serialize())); }
        catch (_) { throw new Error('Your current layout could not be backed up, so nothing was changed.'); }
      }
      const r = StationBuilder.apply(st, e.plan, env);
      if (!r.ok) {
        if (backup) { try { if (backup.old == null) localStorage.removeItem(backup.key); else localStorage.setItem(backup.key, backup.old); } catch (_) {} }
        throw new Error(r.error);
      }
      builderPlans.delete(planId);
      { const built = builtRead(st);
        if (e.plan.spec && e.plan.spec.kind === 'undo') built.pop();
        else built.push({ resultSig: StationBuilder.sigOf(st.serialize()), floorSig: e.plan.floorSig, summary: String(e.plan.summary || '').slice(0, 400), recruited: (r.recruited || []).length > 0 });
        builtWrite(st, built); }
      const hallsBuilt = (r.hallways || []).length, roomNames = (r.rooms || []).map(x => x.name).join(', ');
      const what = r.line ? r.line.name + ' in ' + r.where : r.kind === 'restyle' ? 'the restyle of ' + r.where : r.kind === 'edit' ? r.where : r.kind === 'swap' ? (r.preset ? r.preset.name : 'the preset') + ' (RESTORE PREVIOUS in Build → Presets brings your old station back)'
        : roomNames + (hallsBuilt ? (roomNames ? ' and ' : '') + (hallsBuilt > 1 ? hallsBuilt + ' hallways' : 'a hallway') : '');
      const by = a && a.by ? String(a.by) : '', builder = (env.crew || []).find(x => x.id === (by || env.heroId));
      try { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('Built by ' + (builder ? builder.name : by ? 'your crew' : 'your lead') + ': ' + what + ' · open BUILD and press UNDO to remove it', 'good'); } catch (_) {}
      // the camera shows what was built: the one room, or the whole station when a preset added several
      const ids = r.roomIds || [];
      setTimeout(() => { try { if (typeof World !== 'undefined' && World.frameReviewRoom) World.frameReviewRoom(ids.length === 1 ? ids[0] : ''); } catch (_) {} }, 700);
      const undo = 'The Commander can take all of it back with one UNDO in Build mode'
        + (r.kind === 'swap' ? ', or bring the old station back with RESTORE PREVIOUS in Build → Presets' : '')
        + ((r.recruited || []).length ? '; the recruited agents stay on the crew (DELETE AGENT in a Dossier removes one)' : '') + '.';
      // the receipt's body is the builder's own (StationBuilder.receipt): every line it laid or touched, with the floor's readiness
      const result = Object.assign({ built: true, undo }, StationBuilder.receipt(r, e.plan));
      // publication and the station-file proof run side by side, so together they stay inside the bridge deadline
      const [routing, durability] = await Promise.all([builderPublication(), builderDurability(st)]);
      result.routing = routing;
      Object.assign(result, durability);
      if (!result.routing.published) {
        result.ready = false;
        result.blocking = (result.blocking || []).concat(result.routing.reason);
        if (result.lines) result.lines = result.lines.map(l => Object.assign({}, l, { ready: false, blocking: (l.blocking || []).concat(result.routing.reason) }));
      }
      return result;
    },

    'station.agent_config': (args) => {
      if (typeof App === 'undefined' || !App.agents) throw new Error('the crew roster is not ready yet');
      const crew = App.agents();
      if (!args.agentId) return { agents: crew.map(a => ({ id: a.id, name: a.name })) };
      const a = crew.find(row => row.id === args.agentId);
      if (!a) throw new Error('unknown agentId; list the crew with team.config first');
      return { id: a.id, name: a.name,
        docs: Object.fromEntries(['identity', 'purpose', 'manual', 'context'].map(field => [field, String((a.docs || {})[field] || '')])) };
    },

    'station.update_agent': async (a) => {
      if (typeof App === 'undefined' || !App.agents || !App.applyConfig || !App.configSynced) throw new Error('agent configuration is unavailable');
      if (typeof CloudSave === 'undefined' || !CloudSave.flush || !CloudSave.pull) throw new Error('durable agent storage is unavailable');
      const target = App.agents().find(row => row.id === a.agentId);
      if (!target) throw new Error('unknown agentId; read team.config before editing');
      if (!['identity', 'purpose', 'manual', 'context'].includes(a.field)) throw new Error('only Dossier documents can be edited');
      if (typeof a.text !== 'string' || a.text.length > 20000 || typeof a.previousText !== 'string') throw new Error('text and previousText are required; text is limited to 20000 characters');
      const current = String((target.docs || {})[a.field] || '');
      // Compare before writing: never overwrite a newer Dossier edit or guess a target.
      if (current !== a.previousText && current !== a.text) throw new Error('the document changed; read team.config again before editing');
      App.applyConfig({ [a.field]: a.text }, target.id);
      if (await App.configSynced() !== true) throw new Error('agent roster sync failed; the edit may be local only, do not report completion');
      if (!await CloudSave.flush({ force: true })) throw new Error('agent save failed; do not report completion');
      const saved = await CloudSave.pull();
      const row = saved && ((saved.agents || []).find(x => x.id === target.id) || (saved.agent && saved.agent.id === target.id ? saved.agent : null));
      if (!row || !row.docs || row.docs[a.field] !== a.text) throw new Error('saved agent read-back did not confirm the edit; do not report completion');
      return { agentId: target.id, field: a.field, text: a.text, durable: true, applies: 'next run' };
    },

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
          group: w.conversationMode === 'group',   // a group takes work through its members (group.add + group.handoff), never a dispatched worker
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
      if (a && a.focus) await requireCurrentFocus(a.origin);
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
      await requireCurrentFocus(a && a.origin);
      const ws = Workstreams.switch(hit.w.id);
      if (!ws) throw new Error('the station could not switch sessions');
      if (typeof Chat !== 'undefined' && Chat.load) { try { Chat.load(ws); } catch (_) {} }
      await persistWorkstreams(save => save.activeId === ws.id && (save.workstreams || []).some(w => w && w.id === ws.id));
      try { await reconcile(ws.id); } catch (_) {}
      // Only the call-owning run may rebind voice. An unrelated run cannot transfer the call.
      try { if (typeof VoiceLive !== 'undefined' && VoiceLive.isActive && VoiceLive.isActive() && VoiceLive.rebind
          && VoiceLive.boundSessionId && VoiceLive.boundSessionId() === a.origin.streamId) VoiceLive.rebind(ws.id); } catch (_) {}
      return { id: ws.id, title: sessionName(ws), durable: true };
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
        .map(m => {
          // a goal-loop step is the STATION's prompt, never the Commander's words (org P29-sys wiring): a lead reading it must
          // not tell the user "you asked me to continue…"
          const step = (typeof GoalLoop !== 'undefined' && GoalLoop.stepOfTurn) ? GoalLoop.stepOfTurn(m) : null;
          if (step != null) return { speaker: 'station', sys: true, text: ('Goal step: ' + step).slice(0, 600) };
          return {
            speaker: m.sys ? 'station' : (m.role === 'user' ? 'commander' : (m.agentId || ws.agentId || 'agent')),
            sys: !!m.sys,
            text: String(m.content).slice(0, 600)
          };
        });
      const busy = (typeof Channels !== 'undefined' && Channels.isBusy) ? !!Channels.isBusy(ws.id) : false;
      return {
        id: ws.id, title: hit.title || sessionName(ws), agentId: ws.agentId || 'agent',
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
      return { started: true, session: sessionName(ws), runId, resolvedBy: hit.resolvedBy };
    },

    'station.dispatch_end': async (a) => {
      const hit = resolveDelivery(a);
      const settled = endDeliveredRun(hit.w, a && a.runId);
      // The producer ends dispatch only after validating/finalizing its delivery. Recovery ignores provisional
      // execution rows, including a repair run, so run termination alone can never publish raw output.
      await reconcile(hit.w.id);
      try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (_) {}
      return { settled, session: sessionName(hit.w), resolvedBy: hit.resolvedBy };
    },

    /* STATION CONTROL (2026-10-02, "the agent can do anything the Commander asks"): what the Dossier CONFIG card, the
       session rail's ⋯ menu and Settings › LOOK & SOUND show and change, for station.settings / station.control. Every
       change runs the button's own setter and is proven by reading the save back (the roster/save) or localStorage
       (the look), so a change that did not stick is a refusal, never a "done". */
    'station.settings': () => {
      if (typeof App === 'undefined' || !App.agents) throw new Error('the crew roster is not ready yet');
      const out = {
        crew: App.agents().map(a => ({ id: a.id, name: a.name, role: a.role, model: a.model || 'follows the station default', provider: a.provider || null,
          reasoningEffort: a.reasoningEffort || null, approval: a.approvalMode || 'ask', reach: a.executionProfile, personality: a.personaId || null,
          skin: a.skin || null, awayWork: !!a.workshop }))
      };
      if (typeof Workstreams !== 'undefined' && Workstreams.list) {
        const gid = Workstreams.generalId ? Workstreams.generalId() : null;
        out.sessions = (Workstreams.list({ includeArchived: true }) || []).filter(w => w && w.kind !== 'task').map(w => ({ id: w.id,
          title: w.title != null ? w.title : (w.id === gid ? 'General' : null), agentId: w.agentId || 'agent', pinned: !!w.pinned, archived: !!w.archived,
          group: w.conversationMode === 'group' }));
      }
      if (typeof StationUI !== 'undefined' && StationUI.lookNow) out.look = StationUI.lookNow();
      out.options = {
        approval: ['ask', 'full'], reach: ['station-gear', 'safe-cell', 'remote-ssh', 'trusted-project', 'this-computer'],
        personality: typeof Personas !== 'undefined' && Personas.list ? Personas.list().map(p => p.id) : [],
        skin: typeof DATA !== 'undefined' && DATA.SKINS ? Object.keys(DATA.SKINS) : [],
        look: typeof StationUI !== 'undefined' && StationUI.lookOptions ? StationUI.lookOptions() : null
      };
      return out;
    },
    /* A PROVIDER KEY FROM THE TERMINAL (`starnet` /connect, POST /api/providers/connect): saved the way the AI & MODELS
       card's ＋ ADD KEY saves it — proven with a live call first, then kept where this app keeps keys (the OS keychain in
       the desktop window, this browser + the station's copy otherwise). The command names only a one-time slot; the key
       is collected from the station once. Not a station.control action: no agent tool can reach it. A page that cannot
       keep it (a browser tab of a desktop station) or finds the slot already taken (another page has it) stays quiet, so
       the page that saves it is the one that answers. */
    'provider.key': async (a) => {
      const h = typeof Harness === 'object' && Harness ? Harness : null;
      const quiet = () => Object.assign(new Error('not this page'), { quiet: true });
      if (!h || !h.validateAndSetKey) throw quiet();
      if (a.desktop && !(h.isDesktop && h.isDesktop())) throw quiet();
      const r = await fetch('/api/providers/connect/take', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot: String(a.slot || '') }) });
      if (!r.ok) throw quiet();
      const got = await r.json();
      const provider = String(got.provider || '');
      if (provider === 'custom' && got.baseUrl) {
        if (!h.setBaseUrl) throw new Error('this page cannot save a custom endpoint');
        await Promise.resolve(h.setBaseUrl(String(got.baseUrl), 'custom'));
      }
      const res = got.key ? await h.validateAndSetKey(String(got.key), provider) : null;
      try { if (typeof ModelDock !== 'undefined' && ModelDock.reflect) ModelDock.reflect(); } catch (_) {}
      try { if (typeof KeyCTA !== 'undefined' && KeyCTA.refresh) KeyCTA.refresh(); } catch (_) {}
      try { if (typeof StationUI !== 'undefined' && StationUI.rerender) StationUI.rerender('settings'); } catch (_) {}
      return { provider, store: h.isDesktop && h.isDesktop() ? 'keychain' : 'browser', verified: !!(res && res.credentialVerified), endpointOnly: !got.key };
    },
    'station.control': async (a) => {
      const act = String((a && a.action) || '');
      if (/^agent\./.test(act)) return agentControl(act, a);
      if (/^session\./.test(act)) return sessionControl(act, a);
      if (act === 'group.add') return groupAdd(a);
      if (act === 'look.set') {
        if (typeof StationUI === 'undefined' || !StationUI.setLook) throw new Error('the look settings are not loaded on this page');
        // an empty look changes nothing — never answer it as saved (it read back "done" while hints stayed on, 2026-10-08)
        if (!a.look || typeof a.look !== 'object' || !Object.keys(a.look).length) throw new Error('no look setting was named, so nothing changed');
        const r = StationUI.setLook(a.look);
        if (!r.saved) throw new Error('the look changed on screen but this browser did not keep it (local storage refused) — it will reset on restart; do not report it as saved');
        return r;
      }
      if (act === 'notifications.read' || act === 'notifications.clear') {
        if (typeof StationUI === 'undefined' || !StationUI.notifsMarkRead) throw new Error('notifications are not loaded on this page');
        const r = act === 'notifications.read' ? StationUI.notifsMarkRead() : StationUI.notifsClear();
        if (!r.saved) throw new Error('the notifications changed on screen but this browser did not keep it (local storage refused) — do not report it as saved');
        return r;
      }
      throw new Error('this page has no station control "' + act + '"; reload it');
    },

    /* SHOW THE COMMANDER A PLACE (station.show, 2026-10-04): open one of the PLACES (app/places.js) through the same door
       its dock button / tab / menu entry uses, raise it to the front, and answer with what is really on screen. Only the
       run the Commander is watching may move their eyes (requireWatching). */
    'station.show': async (a) => {
      await requireWatching(a && a.origin);
      const place = typeof Places !== 'undefined' && Places.get ? Places.get(a && a.place) : null;
      if (!place) throw new Error('there is no StarNet place "' + String((a && a.place) || '') + '"; places: ' + (typeof Places !== 'undefined' ? Places.ids().join(', ') : 'none loaded — reload the page'));
      if (typeof StationUI === 'undefined' || !StationUI.showTerm) throw new Error('the station windows are not ready yet');
      const o = place.open;
      const ag = (o.agent || o.desk) ? resolveAgent(a && a.agent) : null;
      // the ONE opener (app/places.js), with this page's own objects
      const out = await Places.open(place, { ui: StationUI, agentId: ag && ag.id,
        build: typeof Build !== 'undefined' ? Build : null, app: typeof App !== 'undefined' ? App : null, market: typeof Marketplace !== 'undefined' ? Marketplace : null });
      if (ag && out) out.agentName = ag.name || ag.id;
      if (!out || !out.open) throw new Error(place.words + ' did not open on the Commander\'s screen' + (o.term === 'apps' ? ' (no app exists yet)' : '') + '; tell them where it is instead');
      return Object.assign({ place: place.id, words: place.words }, out);
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
  /* EVERY RECONCILE READ HAS A DEADLINE (idle CPU piece 3 fix round 4, 2026-10-20). A pass is memoized while it runs, so
     a /api/runs or /api/transcript read the sidecar accepted and never answered held that pass — and every reconcile
     that joined it — for good; the overseer's ledger beat awaited it too, and /api/overseer was never asked again. Past
     the deadline the read fails like any other (fail-open: nothing is folded) and the next reconcile reads afresh. */
  const RECONCILE_READ_MS = 15000;
  const readInit = () => (typeof U !== 'undefined' && U && typeof U.timeoutSignal === 'function')
    ? { cache: 'no-store', signal: U.timeoutSignal(RECONCILE_READ_MS) } : { cache: 'no-store' };

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
        const r = await fetch('/api/runs?agent=*&limit=500', readInit());
        if (!r.ok) return -1;
        rows = ((await r.json()) || {}).runs || [];
      } catch (_) { return -1; }   // -1 = the run list was never read: nothing was reconciled, a caller may retry
      let folded = 0, outcomes = 0;
      const rank = new Map(rows.filter(r => r && r.runId).map((r, i) => [String(r.runId), i]));
      // /api/runs is newest-first. Fold oldest-first so multiple missed answers preserve conversation order.
      for (const row of rows.slice().reverse()) {
        if (!row || !String(row.sessionTitle || '').trim()) continue;
        const delivery = row.dispatchDelivery;
        if (delivery && delivery.state !== 'final') continue;
        const reason = delivery ? delivery.reason : row.reason;
        let text = delivery ? delivery.text : row.deliveryText;
        const args = {
          streamId: row.streamId, sessionTitle: row.sessionTitle, agentId: row.agentId,
          runId: row.runId, prompt: row.deliveryPrompt, text, reason, ts: row.ts
        };
        let hit;
        try { hit = resolveDelivery(args); } catch (_) { continue; }
        if (target && hit.w.id !== target) continue;
        // Ordinary conversations retain their existing recovery policy. A worker's record also retains failed
        // or interrupted attempts: even an empty result needs its truthful outcome and inspection link.
        if (!hit.w.worker && ['done', 'max_iters', 'budget'].indexOf(String(reason || 'done')) < 0) continue;
        // An earlier missed attempt can be recovered after a newer answer was already filed locally.
        // Use the server's run order to insert it before that known successor, preserving current truth.
        const liveRunId = typeof Channels !== 'undefined' && Channels.isBusy && Channels.isBusy(hit.w.id) && Channels.runIdOf && Channels.runIdOf(hit.w.id);
        const beforeRunId = (hit.w.runIds || []).find(id => rank.has(String(id)) && rank.get(String(id)) < rank.get(String(row.runId)))
          || (liveRunId && liveRunId !== row.runId && (hit.w.runIds || []).includes(liveRunId) ? liveRunId : undefined);
        if (row.runId && ((hit.w.runIds || []).indexOf(String(row.runId)) >= 0 || answerFiled(hit.w, row.runId))) {
          if (recordFiledRun(hit.w, String(row.runId), row.ts, beforeRunId)) outcomes++;
          if (noteOutcome(hit.w, String(row.runId), reason)) outcomes++;
          continue;
        }
        // The run index stores a bounded preview. Do not let that preview deduplicate the complete answer.
        // Read only the finalized delivery projection; exact execution transcripts may contain rejected output.
        if (delivery && (String(text || '').length >= 24000 || (delivery.textLength != null && delivery.textLength !== String(text || '').length))) {
          try {
            const response = await fetch('/api/transcript?stream=' + encodeURIComponent(row.streamId || '') + '&runId=' + encodeURIComponent(row.runId || '') + '&delivery=1&limit=1', readInit());
            if (!response.ok) continue;
            const result = await response.json();
            const full = await Workstreams.finalDeliveryText(row, result.turns);
            if (full == null) continue;
            text = full;
          } catch (_) { continue; }
        }
        args.text = text;
        if (!String(text || '').trim()) {
          if (hit.w.worker && row.runId && reason && Workstreams.appendRun) {
            if (Workstreams.appendRun(hit.w.id, String(row.runId), row.ts, beforeRunId)) outcomes++;
            noteOutcome(hit.w, String(row.runId), reason);
          }
          continue;
        }
        try {
          const out = foldDelivery(args, { quiet: true, beforeRunId, recover: true });
          if (out && out.folded) folded++;
        } catch (_) {}
      }
      if (folded || outcomes) {
        try { if (typeof Delegated !== 'undefined' && Delegated.repaint) Delegated.repaint(); } catch (_) {}
        try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (_) {}
        try { if (typeof App !== 'undefined' && App.persist) App.persist(); } catch (_) {}
      }
      return folded;
    })();
    return reconciling[key].finally(() => { delete reconciling[key]; });
  }

  /* A RUN'S FIRST CALL CAN OVERTAKE ITS OWN START (2026-10-22). A station command reaches this page on the event stream;
     the run's agent.run.start reaches it on that run's own /api/run stream — two connections, no order between them. A
     watched run whose FIRST tool call was station.show landed here a few ms before the page learned its runId, so the
     Commander's own run was refused as "not looking at this conversation" and the window never rose (station-show.e2e,
     1 run in 10). The same race refused a first-call session switch. So when the origin names the focused session and
     that session has a send in flight the sidecar has not confirmed to this page yet, wait for the confirmation (its
     agent.run.start, bounded) before a guard reads it. The guards themselves are unchanged: a different run, an ended
     run or another session is refused exactly as before. */
  const RUN_CONFIRM_WAIT_MS = 2000;   // well inside the bridge's 6s answer deadline (sidecar/station-bridge.js)
  function unconfirmedWatchedRun(origin) {
    if (!origin || !origin.streamId || !origin.runId) return false;
    const active = typeof Workstreams !== 'undefined' && Workstreams.activeId ? Workstreams.activeId() : null;
    return active === origin.streamId && typeof Channels !== 'undefined' && !!Channels.isBusy && Channels.isBusy(origin.streamId)
      && !!Channels.runIdOf && !Channels.runIdOf(origin.streamId);
  }
  function runConfirmed(origin) {
    if (!unconfirmedWatchedRun(origin) || typeof U === 'undefined' || !U.bus || !U.bus.on || !U.bus.off) return Promise.resolve();
    return new Promise(resolve => {
      let timer = 0;
      const done = () => { clearTimeout(timer); U.bus.off('agent.run.start', onStart); resolve(); };
      // the bus hears run.start BEFORE the run's own handler stamps the channel (harness.js emits, then calls onRunId),
      // so read the channel once that handler has run; a run.start for another session keeps waiting
      const onStart = () => setTimeout(() => { if (!unconfirmedWatchedRun(origin)) done(); }, 0);
      U.bus.on('agent.run.start', onStart);
      timer = setTimeout(done, RUN_CONFIRM_WAIT_MS);
    });
  }

  async function requireCurrentFocus(origin) {
    await runConfirmed(origin);
    if (typeof Chat === 'undefined' || !Chat.canFocusSession || !Chat.canFocusSession(origin)) {
      throw new Error('session focus was left unchanged: the originating run is no longer current or the Commander has a draft; do not retry the switch automatically');
    }
  }

  /* station.show moves the Commander's EYES, so only the run they are watching may call it: its session is the focused
     one and it is that session's live run. A background worker, a routine, a phone/Telegram turn, or a run that ended is
     refused. Unlike a session switch, a typed draft is no reason to refuse — opening a window leaves the composer alone. */
  async function requireWatching(origin) {
    await runConfirmed(origin);
    const active = typeof Workstreams !== 'undefined' && Workstreams.activeId ? Workstreams.activeId() : null;
    const live = !!(origin && origin.streamId && origin.runId && active === origin.streamId
      && typeof Channels !== 'undefined' && Channels.isBusy && Channels.isBusy(origin.streamId)
      && Channels.runIdOf && Channels.runIdOf(origin.streamId) === origin.runId);
    if (!live) throw new Error('the Commander is not looking at this conversation right now, so their screen was left alone — tell them where it is instead');
  }
  // an agent by exact id or name (case-insensitive) — never a guess: unknown or ambiguous refuses with the real roster
  /* group.add (station-control.js): bring crew into a chat through the SAME path the chat's + Add agents key takes
     (group-chat.js addAgents). Names resolve strictly (two agents with one name are refused, never guessed). The caller
     — the run that asked, host-stamped by the sidecar — lets a chat whose reply is still running take the join when
     THAT reply ends; the result then says "joining", never "added". */
  async function groupAdd(a) {
    if (typeof GroupChat === 'undefined' || !GroupChat.addAgents) throw new Error('group chat is not loaded on this page; reload it, nothing changed');
    const hit = resolveChat(a.session);
    const ids = [];
    for (const ref of (Array.isArray(a.agents) ? a.agents : [])) { const ag = resolveAgent(ref); if (!ids.includes(ag.id)) ids.push(ag.id); }
    if (!ids.length) throw new Error('no crew member was named, so nothing changed');
    return GroupChat.addAgents(hit.w, ids, a.caller && typeof a.caller === 'object' ? a.caller : null);
  }
  function resolveAgent(ref) {
    const crew = (typeof App !== 'undefined' && App.agents && App.agents()) || [];
    const want = String(ref || '').trim().toLowerCase();
    const roster = () => crew.map(x => x.name || x.id).join(', ');
    if (!want) throw new Error('name which agent (crew: ' + roster() + ')');
    const byId = crew.filter(x => x && String(x.id).toLowerCase() === want);
    const hits = byId.length ? byId : crew.filter(x => x && String(x.name || '').trim().toLowerCase() === want);
    if (hits.length !== 1) throw new Error((hits.length ? 'more than one agent is called "' : 'no agent called "') + ref + '" (crew: ' + roster() + ')');
    return hits[0];
  }

  async function run(id, verb, args) {
    let out;
    try {
      const fn = VERBS[String(verb || '')];
      if (!fn) throw new Error('unknown station verb: ' + verb);
      out = { id, ok: true, result: await fn(args || {}) };
    } catch (error) {
      if (error && error.quiet) return;   // not this page's to answer (provider.key): the page that is answers
      out = { id, ok: false, error: String((error && error.message) || error) };
    }
    /* TWO STATION PAGES (the app and a browser tab): every open page gets the command and the FIRST answer wins. A page
       that cannot even find the chat it names (a chat another page just made) must not out-race the page that owns it
       with "there is no session called …" — the agent was told REFUSED for a change the other page made (2026-10-13).
       It answers a beat later; the owner's answer lands first and the bridge drops the late one. Alone, it still answers. */
    if (!out.ok && /^there is no session called /.test(out.error)) await new Promise(r => setTimeout(r, 1500));
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

  return { init, run, reconcile, previewFor, verbs: () => Object.keys(VERBS) };
})();

document.addEventListener('DOMContentLoaded', () => StationCommands.init());
