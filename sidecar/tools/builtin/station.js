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

    const statusTool = {
      name: 'station.status', capability: 'orchestrator', scope: 'read', requiresConsent: false,
      description: 'Read the live station-wide operational snapshot from the attached StarNet page: active session, open workstreams, which are busy, and any approval state the station can currently prove. Call this before answering station-wide status questions or deciding which existing session/work to inspect; never infer missing station state from your own thread.',
      schema: { type: 'object', properties: {} },
      run: async () => {
        const out = await ask('station.status', {});
        if (!out.ok) return refuse(out.error);
        return { content: JSON.stringify(out.result || {}), summary: 'live station status' };
      }
    };

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

    const agentConfigTool = {
      name: 'team.config', capability: 'orchestrator', scope: 'read', requiresConsent: false,
      description: 'List crew IDs and names, or pass an exact agentId to read that agent\'s current Dossier documents: identity, purpose, manual (standing orders), and context. Read the target before changing it with team.configure. Notebook memory does not edit these documents.',
      schema: { type: 'object', properties: { agentId: { type: 'string' } } },
      run: async (args) => {
        const out = await ask('station.agent_config', { agentId: args && args.agentId });
        return out.ok ? { content: JSON.stringify(out.result), summary: 'crew configuration' } : refuse(out.error);
      }
    };
    // Rewrites text ANOTHER agent obeys on every later run (including unattended ones), so: its own consent class
    // (an "always" on team.summon/routine.create never pre-approves it), locked once this run read untrusted
    // content, and the new text passes the same strict injection scan a routine prompt does.
    const scanText = typeof deps.scanText === 'function' ? deps.scanText : null;
    const agentConfigureTool = {
      name: 'team.configure', capability: 'orchestrator', consentKey: 'team.configure', taintLocked: true, scope: 'write', requiresConsent: true,
      description: 'Edit one existing crew member Dossier document, using the exact agentId and previousText from team.config. Preserve unrelated instructions in the replacement text. An empty text explicitly clears the document. Uses the Dossier save path; applies to the next run, not a currently running turn. Requires an open station page. Does not change skills, permissions, Bay briefs, or layout. Never substitute notebook.write for this edit.',
      schema: { type: 'object', additionalProperties: false, required: ['agentId', 'field', 'previousText', 'text'], properties: {
        agentId: { type: 'string' }, field: { type: 'string', enum: ['identity', 'purpose', 'manual', 'context'] },
        previousText: { type: 'string' }, text: { type: 'string', maxLength: 20000 }
      } },
      run: async (args) => {
        if (scanText && args && typeof args.text === 'string') {
          let scan; try { scan = scanText(args.text); } catch (e) { scan = { ok: false, error: 'the instruction scan failed' }; }
          if (!scan || scan.ok !== true) {
            return refuse('the new ' + String(args.field || 'document') + ' text contains a pattern that tries to override instructions or leak credentials'
              + (scan && scan.patternId ? ' (' + scan.patternId + ')' : '') + '. Tell the Commander what was blocked; they can edit the Dossier by hand', 'blocked by instruction scan');
          }
        }
        const out = await ask('station.update_agent', args || {});
        return out.ok ? { content: JSON.stringify(out.result), summary: 'saved agent document' } : refuse(out.error);
      }
    };

    /* station.layout (2026-09-28; builds on PR #48 by @mvanhorn) — the lead's EYES on the floor. Asked "what does my
       line do?" or "why isn't step 2 running?", a lead with no view of the floor guessed. The page answers from the
       Workflow panel's own readers (frontend/app/stationcommands.js describeLayout), so the lead can quote the same
       status pill and sentence the Commander sees. Read-only, so it is a consent-free orchestrator read.
       AUDIT 2026-09-28: the page's answer is completed HERE with what only the harness knows, and shaped to the
       model's window — a 10-line floor used to cost ~10k tokens a call, and a 32k-token model got it clamped into
       invalid JSON with a line missing:
         • ROUTING is confirmed against the router's own plan (deps.layoutFacts.routed): the page's poster is a
           belief — a second, stale page or a lost routing file could make it say "live" over a router holding
           nothing, or a different floor.
         • each line's EFFECTIVE budget (the runner's own effectiveLimits: line budget, defaults, global pool), its
           numbers TODAY and each BAY's last run come from the run store (the Workflow panel's line plate + lamps).
         • the overview is compact (the panel sentence carries the flow; no briefs); `line` returns one line in full.
           Whatever the mode, the answer fits ctx.outputMax as VALID JSON, dropping detail before it drops a line
           and naming anything it left out. */
    const lf = deps.layoutFacts || {};
    const call = (fn, ...a) => { if (typeof fn !== 'function') return undefined; try { return fn(...a); } catch (_) { return undefined; } };
    const agoText = ms => { const m = Math.round(ms / 60000); return m < 1 ? 'just now' : m < 60 ? m + 'm ago' : m < 2880 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago'; };
    // the clock is INJECTED (sidecar determinism law); without one, "how long ago" is not claimed at all
    const clock = typeof deps.now === 'function' ? deps.now : null;
    const lastRun = (d, now) => ({ result: d.reason || 'unknown', failed: !!d.failed, at: d.ts ? new Date(d.ts).toISOString() : null,
      ago: (d.ts && now != null) ? agoText(Math.max(0, now - d.ts)) : null, runId: d.runId || null });
    function completeLayout(r, now) {
      const ro = r.routing || (r.routing = { state: 'unknown', note: 'The page could not say whether the router holds this floor.' });
      const held = call(lf.routed);
      if (held !== undefined && (ro.state === 'live' || ro.state === 'unconfirmed') && (r.lines || []).length) {
        if (held === null) Object.assign(ro, { state: 'off', confirmed: false, note: 'Routing is OFF: the router holds no routing plan right now, so no line routes work (the page believed otherwise). Opening or editing the floor sends it again.' });
        else if (held.hash && ro.planHash && held.hash !== ro.planHash) Object.assign(ro, { state: 'unconfirmed', confirmed: false, note: 'The router is running a different version of the floor than the page shows (another open page, or a floor that was not saved), so what runs may differ from this answer.' });
        else if (held.hash && held.hash === ro.planHash) ro.confirmed = true;
      }
      delete ro.planHash;
      const today = call(lf.today);
      const byLine = {}; for (const l of ((today && today.lines) || [])) if (l && l.lineId) byLine[l.lineId] = l;
      const docks = (today && today.docks) || {};
      for (const L of (r.lines || [])) {
        const b = call(lf.budget, L.lineId);
        if (b) { L.budget = { maxHops: b.maxHops, maxUsdPerMessage: b.maxUsdPerMessage, maxUsdPerDay: b.maxUsdPerDay == null ? null : b.maxUsdPerDay }; if (b.clamped && b.clamped.length) L.budget.clamped = b.clamped; }
        const t = byLine[L.lineId];
        if (t) L.today = { runs: t.runs, shipped: t.shipped, failed: t.failed, tests: t.tests, usd: t.usdToday, capUsdPerDay: t.capUsdPerDay, medianMs: t.medianMs, day: t.spendDay === 'utc' ? 'UTC day' : 'local day' };
        else if (today) L.today = null;   // the router runs no such line (routing off, or edits not sent): no numbers to claim
        for (const s of (L.steps || [])) { const d = docks[s.propId]; if (d) s.lastRun = lastRun(d, now); }
      }
      for (const b of (r.loneBays || [])) { const d = docks[b.propId]; if (d) b.lastRun = lastRun(d, now); }
      if (today === undefined && (r.lines || []).length) r.todayUnread = true;
      return r;
    }
    const nameOf = a => a ? a.name + (a.onCrew === false ? ' (not on the crew)' : '') : null;
    // the OVERVIEW: every line, compact — the sentence carries the flow, the steps say who and where
    function overviewOf(r) {
      const o = { routing: r.routing, automation: r.automation || null };
      o.lines = (r.lines || []).map(L => {
        const x = { lineId: L.lineId, name: L.name, status: L.status, ready: L.ready, howItRuns: L.howItRuns, blocking: L.blocking, hints: L.hints,
          starts: { schedules: L.starts.schedules, channels: L.starts.channels, events: L.starts.events, paused: L.starts.paused } };
        if (L.startsUnread) x.startsUnread = L.startsUnread;
        if (L.budget) x.budget = L.budget;
        if (L.today !== undefined) x.today = L.today;
        x.steps = (L.steps || []).map(s => {
          const y = { step: s.step, propId: s.propId, role: s.role, agent: nameOf(s.agent), room: s.room };
          if (s.runsWith) y.runsWith = s.runsWith;
          if (s.note) y.note = s.note;
          if (s.lastRun) y.lastRun = s.lastRun.result + (s.lastRun.ago ? ', ' + s.lastRun.ago : '');
          return y;
        });
        if ((L.issues || []).length) x.issues = L.issues;
        return x;
      });
      // a lone BAY is no line, so the overview is the only place its brief is read: kept, cut short
      if ((r.loneBays || []).length) o.loneBays = r.loneBays.map(b => Object.assign({ propId: b.propId, role: b.role, agent: nameOf(b.agent), room: b.room, note: b.note },
        b.brief ? { brief: b.brief.length > 300 ? b.brief.slice(0, 300) + '…' : b.brief } : {},
        b.lastRun ? { lastRun: b.lastRun.result + (b.lastRun.ago ? ', ' + b.lastRun.ago : '') } : {}));
      if ((r.otherIssues || []).length) o.otherIssues = r.otherIssues;
      o.rooms = (r.rooms || []).map(x => x.name || x.kind || x.id);
      o.workstations = (r.workstations || []).map(w => ({ agent: nameOf(w.agent), type: w.type, room: w.room }));
      if (r.todayUnread) o.todayUnread = true;
      o.more = 'For one line in full (each Bay\'s exact brief, tools, hand-offs, loop, escalation and filter rules), call station.layout with line = its name or lineId.';
      return o;
    }
    // FIT: shrink detail in order until the JSON is under the budget; the result is always valid JSON and says what it left out
    function fitLayout(o, max, detail) {
      const size = x => JSON.stringify(x).length;
      if (size(o) <= max) return o;
      const x = JSON.parse(JSON.stringify(o));
      const linesOf = () => detail ? (x.line ? [x.line] : []) : (x.lines || []);
      const steps = () => linesOf().reduce((a, L) => a.concat(L.steps || []), []);
      const cutBriefs = n => () => { for (const s of steps()) if (s.brief && s.brief.length > n) { s.brief = s.brief.slice(0, n) + '…'; s.briefTruncated = true; } };
      const cuts = detail ? [
        cutBriefs(600), cutBriefs(160),
        () => { for (const L of linesOf()) if (L.starts) { delete L.starts.routines; delete L.starts.channelBots; } },
        () => { for (const s of steps()) { delete s.tools; delete s.getsWorkFrom; } },
        () => { for (const s of steps()) { delete s.brief; s.briefOmitted = true; } }
      ] : [
        () => { for (const L of (x.lines || [])) delete L.hints; delete x.workstations; delete x.rooms; },
        () => { for (const s of steps()) { delete s.room; delete s.propId; } },
        () => { for (const L of (x.lines || [])) L.steps = (L.steps || []).map(s => s.step + '. ' + (s.agent || 'no agent') + (s.note ? ' — ' + s.note : '')); },
        () => { for (const L of (x.lines || [])) { delete L.steps; delete L.budget; delete L.starts; delete L.issues; } delete x.loneBays; }
      ];
      for (const cut of cuts) { cut(); if (size(x) <= max) { x.shortened = true; return x; } }
      if (detail) {
        const L = x.line || {};
        return { routing: { state: (x.routing || {}).state || 'unknown' }, shortened: true,
          line: x.line ? { lineId: L.lineId, name: L.name, status: L.status, howItRuns: String(L.howItRuns || '').slice(0, Math.max(200, max - 600)) } : null };
      }
      // still too big: keep whole lines from the front, and NAME the rest (never a silent drop)
      const all = x.lines || [], kept = [];
      x.lines = kept;
      for (const L of all) { kept.push(L); if (size(x) > max - 200) { kept.pop(); break; } }
      x.shortened = true;
      if (kept.length < all.length) x.omittedLines = all.slice(kept.length).map(L => (L.name || 'unnamed') + ' (' + L.lineId + ')');
      if (size(x) > max) return { routing: { state: (x.routing || {}).state || 'unknown' }, shortened: true, lines: [], omittedLines: all.map(L => (L.name || 'unnamed') + ' (' + L.lineId + ')'), more: 'This answer was too large for your context: call station.layout with line = one of these.' };
      return x;
    }
    const layoutTool = {
      name: 'station.layout', capability: 'orchestrator', scope: 'read', requiresConsent: false,
      description: 'Read the station floor the way the Workflow panel shows it: whether routing is live (confirmed against the router) and whether automation is stopped (E-STOP); every assembly line with its status pill, its plain-English "how it runs" sentence, what starts it (schedules, channels, folder and webhook triggers — and any that are paused, with the reason), what is blocking it, its budget, and its numbers today; each step in run order with its Bay, room, agent and last run; Bays on no belt line; routing issues; rooms; and who holds which workstation. With `line` (a line name or lineId) it returns that one line in full: each Bay\'s exact brief (added to the agent\'s Dossier), its tools there, its hand-offs, loops and escalation lanes, and filter rules. ⛔ Call this before explaining, troubleshooting, or suggesting changes to Bays and assembly lines, and never answer those from memory. Quote its status and sentence as given, and when routing is not live or starts are paused, say so. Read-only: it cannot assign agents, edit briefs, or change the layout; the Commander does that in Build mode. Requires an open station page.',
      schema: { type: 'object', properties: { line: { type: 'string' } } },
      run: async (args, ctx) => {
        const line = String((args && args.line) || '').trim().slice(0, 80);
        const out = await ask('station.layout', line ? { line } : {});
        if (!out.ok) return refuse(out.error);
        const r = completeLayout(out.result || {}, clock ? clock() : null);
        const max = (ctx && Number(ctx.outputMax) > 0) ? Math.floor(Number(ctx.outputMax)) : 80000;
        const shaped = line ? { routing: r.routing, automation: r.automation || null, line: (r.lines || [])[0] || null } : overviewOf(r);
        if (line && r.todayUnread) shaped.todayUnread = true;
        const fitted = fitLayout(shaped, Math.max(2000, max - 64), !!line);
        const lines = r.lines || [];
        const routing = r.routing && r.routing.state ? 'routing ' + r.routing.state : 'routing unknown';
        const head = lines.length === 1 ? '"' + (lines[0].name || 'unnamed line') + '": ' + (lines[0].status || '?') : lines.length + ' line(s)';
        return { content: JSON.stringify(fitted), summary: head + ' · ' + routing };
      }
    };

    return {
      statusTool, agentConfigTool, agentConfigureTool, layoutTool,
      listTool, createTool, peekTool, focusTool, taskListTool, taskCreateTool, taskManageTool,
      register(reg) { [statusTool, listTool, createTool, peekTool, focusTool, taskListTool, taskCreateTool, taskManageTool, agentConfigTool, agentConfigureTool, layoutTool].forEach(t => reg.register(t)); return reg; }
    };
  }

  return { makeStationTools };
});
