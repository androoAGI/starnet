/* sidecar/tools/builtin/todo.js — the in-session TASK PLAN, part of the NOTEBOOK (memory) capability.
   A single `todo` tool: pass `todos` to write, omit to read; merge=true updates items by id, merge=false
   (default) replaces the whole list. State is the agent's own working memory (per-agent, via the same
   injected kv store the notebook uses) — no consent, no outward effect, no network. The ACTIVE plan is
   re-injected after a context compaction (loop.js) so a long run never loses its task list. Replicates
   the reference harness's todo tool: id/content/status items, list-order = priority, one in_progress
   at a time, bounded so a replayed/oversized list can't defeat the compaction it rides through.

   makeTodoTool({ store }) -> { todoTool, register(reg) }
     store : { get(key)->value|undefined, set(key,value) }
   Static export formatForInjection(store, agentId) -> string|null  (loop compaction re-injection). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).todo = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* EVERY lookup in this file is keyed by a MODEL-SUPPLIED string (a todo id, a status), so none of them may
     be a bare object literal — `({})['constructor']` is truthy, and `byId[id]` for id 'constructor' resolves
     to the global Object function. Measured before the fix: a todo with id "constructor" took the
     update-an-existing-item branch, wrote its content and status onto `Object` ITSELF (Object.content =
     'PWNED'), and was then dropped from the list — so the model asked for a task and got global mutation,
     no task, and no error. A Set for membership; a null-prototype map for anything keyed by an id. */
  const STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled']);
  const MARK = { pending: '[ ]', in_progress: '[>]', completed: '[x]', cancelled: '[~]' };
  const bag = () => Object.create(null);   // a map that cannot inherit a key from Object.prototype
  // Bounds: the list rides through context compaction (formatForInjection), so an oversized item or a
  // runaway count would defeat the very compression it survives. Generous vs real plans (a handful of items).
  const MAX_ITEMS = 256, MAX_CONTENT = 4000, TRUNC = '… [truncated]';
  const KEY = aid => 'todo:' + (aid || 'agent');

  function capContent(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return '(no description)';
    return s.length > MAX_CONTENT ? s.slice(0, MAX_CONTENT - TRUNC.length) + TRUNC : s;
  }
  function validate(t) {
    const id = String((t && t.id) != null ? t.id : '').trim() || '?';
    let status = String((t && t.status) || 'pending').trim().toLowerCase();
    if (!STATUSES.has(status)) status = 'pending';
    return { id, content: capContent(t && t.content), status };
  }
  // collapse duplicate ids, keeping the LAST occurrence in its first position (parity with the reference harness)
  function dedupeById(todos) {
    const lastIndex = bag();
    todos.forEach((t, i) => { const id = String((t && t.id) != null ? t.id : '').trim() || '?'; lastIndex[id] = i; });
    return Object.keys(lastIndex).map(k => lastIndex[k]).sort((a, b) => a - b).map(i => todos[i]);
  }
  function listOf(store, aid) { const v = store && store.get(KEY(aid)); return Array.isArray(v) ? v.map(validate) : []; }

  function buildList(current, todos, merge) {
    todos = Array.isArray(todos) ? todos : [];
    let items;
    if (!merge) {
      items = dedupeById(todos).map(validate);
    } else {
      items = Array.isArray(current) ? current.map(validate) : [];
      const byId = bag(); items.forEach(it => { byId[it.id] = it; });
      for (const raw of dedupeById(todos)) {
        const id = String((raw && raw.id) != null ? raw.id : '').trim();
        if (!id) continue;                                   // can't merge without an id
        if (byId[id]) {                                      // update only the fields the model actually sent
          if (raw.content) byId[id].content = capContent(raw.content);
          if (raw.status) { const s = String(raw.status).trim().toLowerCase(); if (STATUSES.has(s)) byId[id].status = s; }
        } else { const v = validate(raw); byId[id] = v; items.push(v); }   // new item -> append
      }
      const seen = bag();
      items = items.filter(it => (seen[it.id] ? false : (seen[it.id] = 1))).map(it => byId[it.id] || it);
    }
    if (items.length > MAX_ITEMS) items = items.slice(0, MAX_ITEMS);   // keep the highest-priority head
    return items;
  }
  function writeList(store, aid, todos, merge) {
    const items = buildList(merge ? store.get(KEY(aid)) : [], todos, merge);
    store.set(KEY(aid), items);
    return items;
  }
  function updateList(store, aid, todos, merge) {
    if (store && typeof store.update === 'function') {
      return store.update(KEY(aid), cur => buildList(cur, todos, merge));
    }
    return Promise.resolve(writeList(store, aid, todos, merge));
  }

  function render(items) {
    return items.map(it => (Object.prototype.hasOwnProperty.call(MARK, it.status) ? MARK[it.status] : '[?]') + ' ' + it.id + '. ' + it.content + ' (' + it.status + ')').join('\n');
  }
  function summarize(items) {
    const c = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
    for (const it of items) c[it.status] = (c[it.status] || 0) + 1;
    return items.length + ' task' + (items.length === 1 ? '' : 's') + ': '
      + c.pending + ' pending, ' + c.in_progress + ' in progress, ' + c.completed + ' done'
      + (c.cancelled ? ', ' + c.cancelled + ' cancelled' : '');
  }

  // loop.js re-injects this after a context compaction so the active plan survives. Only pending/
  // in_progress items — replaying completed/cancelled ones makes the model re-do finished work.
  function formatForInjection(store, aid) {
    const items = listOf(store, aid).filter(it => it.status === 'pending' || it.status === 'in_progress');
    if (!items.length) return null;
    return '[Your active task list was preserved across context compaction]\n'
      + items.map(it => '- ' + (Object.prototype.hasOwnProperty.call(MARK, it.status) ? MARK[it.status] : '[?]') + ' ' + it.id + '. ' + it.content + ' (' + it.status + ')').join('\n');
  }

  function makeTodoTool(deps) {
    deps = deps || {};
    const store = deps.store;
    if (!store) throw new Error('todo.js requires { store }');

    const todoTool = {
      // NO consent gate: the plan is the agent's OWN working memory — no filesystem reach, no network,
      // no outward effect — exactly like notebook.write. Approval is reserved for outward mutations.
      // capability 'taskplan' (not 'memory') since 2026-08-17: the grant rides the COMPUTER object so every
      // runnable agent has a task list — see the CAP_REGISTRY note. The plan still persists via the notebook STORE.
      name: 'todo', capability: 'taskplan', scope: 'write', requiresConsent: false, impact: 'none', timeoutMs: 5000,   // the run's own checklist: no effect outside it (undeclared it read as external-unknown)
      description: 'Manage your task list for this session: use it for any job with 3+ steps or multiple requests, to plan and track progress. Call with NO arguments to read the current list. To write, pass todos: [{ id, content, status }]. merge=false (default) replaces the whole list with a fresh plan; merge=true updates existing items by id and appends new ones. List order is priority; keep only ONE item in_progress at a time; mark an item completed the moment it is done, and cancel + re-add if something has to change. Always returns the full updated list. Your active plan is preserved across context compaction.',
      schema: { type: 'object', properties: {
        todos: { type: 'array', items: { type: 'object', required: ['id', 'content', 'status'], properties: {
          id: { type: 'string' }, content: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] }
        } } },
        merge: { type: 'boolean' }
      } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const items = (args && args.todos != null) ? await updateList(store, aid, args.todos, !!args.merge) : listOf(store, aid);
        if (!items.length) return { content: 'Your task list is empty. Pass "todos" to create a plan.', summary: '0 tasks' };
        return { content: render(items), summary: summarize(items) };
      }
    };

    return { todoTool, register(reg) { reg.register(todoTool); return reg; } };
  }

  return { makeTodoTool, formatForInjection, _internals: { validate, dedupeById, buildList, writeList, updateList, listOf, render, summarize } };
});
