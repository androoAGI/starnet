/* sidecar/tools/builtin/station.js — the agent's SESSION verbs, over the station bridge.

   WHY: sessions are PAGE state (Workstreams in the browser, persisted through agent.save.json), while agent
   tools run here in the sidecar. team.dispatch can already RUN work inside a named session; what the agent
   could not do was CREATE a session, LIST them, or FOCUS one — so "make a session called research and have
   the researcher work in it" half-worked: the delegation landed, but the session had to already exist. These
   three verbs close that, riding the same station bridge (sidecar/station-bridge.js) the dispatch resolver
   uses, so a headless run (cron, Night Shift, nobody watching) fails VISIBLY instead of claiming a session
   it never opened.

   ⛔ EVERY REFUSAL IS AN ANSWER. "No station page attached", "that title already exists", "no session called
   X — these exist: …" all travel back as the tool result, because the model repeats what it is told: a
   cheerful nothing here becomes "done!" in the transcript with no session behind it — the exact lie the
   bridge exists to prevent (and the same law as dispatch's session refusal: never default, never guess).

   makeStationTools({ station }) — station: the bridge ({ request(verb, args) }); absent → honest unavailable. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).station = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function makeStationTools(deps) {
    deps = deps || {};
    const station = (deps.station && typeof deps.station.request === 'function') ? deps.station : null;

    // Mint provenance from the execution context, never from model-supplied arguments.
    function focusOrigin(ctx) {
      return ctx && ctx.streamId && ctx.runId ? { streamId: String(ctx.streamId), runId: String(ctx.runId) } : null;
    }

    // one shape for every verb: bridge absent / page silent / page refused / page answered.
    async function ask(verb, args) {
      if (!station) return { ok: false, error: 'this run has no station bridge — session actions need the live StarNet page' };
      let out;
      try { out = await station.request(verb, args || {}); }
      catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      return out && out.ok ? { ok: true, result: out.result } : { ok: false, error: String((out && out.error) || 'the station did not answer') };
    }
    const refuse = (error, summary) => ({ content: 'REFUSED: ' + error + ' — do not report this action as done.', summary: summary || 'refused' });

    const listTool = {
      name: 'session.list', capability: 'orchestrator', scope: 'read', requiresConsent: false,
      description: 'List the sessions (workstreams) open on this station: id, title, bound agent, and which one the Commander has focused. Use the TITLES when talking to the Commander and when passing `session` to team.dispatch or session.focus. Read this before creating a session so you never mint a duplicate title.',
      schema: { type: 'object', properties: {} },
      run: async () => {
        const out = await ask('station.sessions', {});
        if (!out.ok) return refuse(out.error);
        const r = out.result || {};
        return { content: JSON.stringify(r), summary: (r.count != null ? r.count : (r.sessions || []).length) + ' session(s)' };
      }
    };

    const createTool = {
      name: 'session.create', capability: 'orchestrator', scope: 'write', requiresConsent: false,
      description: 'Create a NEW named session (workstream) on the station — e.g. when the Commander says "make a session called research". Optionally bind it to a crew agentId, and pass focus:true only when the Commander asked to open/switch to it. Refuses a title that already exists (delegate into the existing one instead). After creating, you can run work in it by passing its title as `session` on a team.dispatch worker.',
      schema: {
        type: 'object', required: ['title'], properties: {
          title: { type: 'string' },      // the name the Commander said, shown on the rail (≤80 chars)
          agentId: { type: 'string' },    // optional crew member this session belongs to
          focus: { type: 'boolean' }      // true = also make it the Commander's active session
        }
      },
      run: async (args, ctx) => {
        const title = String((args && args.title) || '').trim().slice(0, 80);
        if (!title) return refuse('a session needs a title');
        const out = await ask('station.new_session', { title, agentId: String((args && args.agentId) || '').trim() || undefined, focus: !!(args && args.focus), origin: focusOrigin(ctx) });
        if (!out.ok) return refuse(out.error);
        return { content: JSON.stringify(out.result), summary: 'created "' + title + '"' + (args && args.focus ? ' (focused)' : '') };
      }
    };

    const peekTool = {
      name: 'session.peek', capability: 'orchestrator', scope: 'read', requiresConsent: false,
      description: 'Read another session\'s recent conversation — who said what, including delegated work that landed there. ⛔ ALWAYS call this before answering any question about what another session or agent did ("what did the researcher do?", "did anything finish in research?"): your own thread does NOT contain other sessions\' turns, so answering from memory is guessing. Pass the session\'s title as the Commander says it (or an exact id); an unknown or ambiguous name is refused with the list of real ones.',
      schema: {
        type: 'object', required: ['session'], properties: {
          session: { type: 'string' },
          limit: { type: 'integer' }     // optional: how many recent turns (default 12, max 30)
        }
      },
      run: async (args) => {
        const ref = String((args && args.session) || '').trim().slice(0, 80);
        if (!ref) return refuse('name which session to read');
        const limit = Math.max(1, Math.min(30, Number(args && args.limit) || 12));
        const out = await ask('station.read_session', { session: ref, limit });
        if (!out.ok) return refuse(out.error);
        const r = out.result || {};
        return { content: JSON.stringify(r), summary: '"' + (r.title || ref) + '": ' + ((r.turns || []).length) + ' recent turn(s)' + (r.busy ? ' — still working' : '') };
      }
    };

    const focusTool = {
      name: 'session.focus', capability: 'orchestrator', scope: 'write', requiresConsent: false,
      description: 'Switch the Commander\'s focused session to an existing one, by the title they say (or an exact id) — e.g. "open the research session". The name must match exactly one session; an unknown or ambiguous name is refused with the list of real ones, so never guess — use session.list. This changes what the Commander is LOOKING at; use it only when they asked to switch.',
      schema: { type: 'object', required: ['session'], properties: { session: { type: 'string' } } },
      run: async (args, ctx) => {
        const ref = String((args && args.session) || '').trim().slice(0, 80);
        if (!ref) return refuse('name which session to focus');
        const out = await ask('station.switch_session', { session: ref, origin: focusOrigin(ctx) });
        if (!out.ok) return refuse(out.error);
        const r = out.result || {};
        return { content: JSON.stringify(r), summary: 'focused "' + (r.title || ref) + '"' };
      }
    };

    const taskListTool = {
      name: 'task.list', capability: 'orchestrator', scope: 'read', requiresConsent: false,
      description: 'List the durable cards on the Commander\'s task board. Use this for requests about board cards or tasks; sessions are separate and come from session.list.',
      schema: { type: 'object', properties: {} },
      run: async () => {
        const out = await ask('station.tasks', {});
        if (!out.ok) return refuse(out.error);
        const r = out.result || {};
        return { content: JSON.stringify(r), summary: (r.count != null ? r.count : (r.tasks || []).length) + ' board task(s)' };
      }
    };

    const taskCreateTool = {
      name: 'task.create', capability: 'orchestrator', scope: 'write', requiresConsent: false,
      description: 'Add one durable card to the Commander\'s task board when they say “add this to my board”, “make a task”, or equivalent. This does not start work and does not create a chat session. Repeating the same title returns the existing card instead of creating a duplicate.',
      schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, agentId: { type: 'string' } } },
      run: async (args) => {
        const title = String((args && args.title) || '').trim().slice(0, 80);
        if (!title) return refuse('a task needs a title');
        const out = await ask('station.new_task', { title, agentId: String((args && args.agentId) || '').trim() || undefined });
        if (!out.ok) return refuse(out.error);
        const r = out.result || {};
        return { content: JSON.stringify(r), summary: r.created === false ? 'already on board: "' + (r.title || title) + '"' : 'added "' + (r.title || title) + '" to the board' };
      }
    };

    const taskManageTool = {
      name: 'task.manage', capability: 'orchestrator', scope: 'write', requiresConsent: true,
      description: 'Change an EXISTING durable task-board card: move it between todo/active/shipped, rename it, assign it to a crew agent, archive/restore it, or remove it. Never call this to start work; use team.dispatch for delegation. `shipped` is allowed only when the Commander explicitly asks to mark/ship/complete that card. Destructive actions are consent-gated.',
      schema: {
        type: 'object', required: ['task', 'action'], properties: {
          task: { type: 'string' }, action: { type: 'string', enum: ['move', 'rename', 'assign', 'archive', 'restore', 'remove'] },
          lane: { type: 'string', enum: ['todo', 'active', 'shipped'] }, title: { type: 'string' }, agentId: { type: 'string' }
        }
      },
      run: async (args) => {
        args = args || {};
        if (!String(args.task || '').trim()) return refuse('name which task to change');
        const out = await ask('station.manage_task', args);
        if (!out.ok) return refuse(out.error);
        const r = out.result || {};
        const done = { move: 'moved', rename: 'renamed', assign: 'assigned', archive: 'archived', restore: 'restored', remove: 'removed' }[args.action] || 'changed';
        return { content: JSON.stringify(r), summary: r.changed === false ? 'task already had that state' : (done + ' task') };
      }
    };

    return {
      listTool, createTool, peekTool, focusTool, taskListTool, taskCreateTool, taskManageTool,
      register(reg) { [listTool, createTool, peekTool, focusTool, taskListTool, taskCreateTool, taskManageTool].forEach(t => reg.register(t)); return reg; }
    };
  }

  return { makeStationTools };
});
