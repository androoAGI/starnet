/* sidecar/tools/builtin/skills.js - runtime skill library tools.

   skill.list and skill.view provide progressive disclosure. skill.manage is
   the reference-harness-style lifecycle surface. skill.write remains as a compatibility
   wrapper for simple create/update flows.
*/
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).skills = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function fileLabel(files) {
    return files && files.length ? ('; files: ' + files.map(f => f.path).join(', ')) : '';
  }
  function emitSkill(ctx, skill, isNew) {
    if (ctx && typeof ctx.emit === 'function' && skill) {
      const label = skill.pendingCandidate ? (isNew ? 'Proposed skill: ' : 'Proposed revision: ') : '';
      try { ctx.emit('deliverable', { id: skill.id, agentId: skill.agentId || ((ctx && ctx.agentId) || 'agent'), kind: 'skill', title: label + skill.name }); } catch (_) {}
    }
  }
  // The model's reply for a staged write. A brand-new skill is a proposed skill, not a "revision", and neither is
  // something the skill guard held: it waits on the Commander's evaluation and approval.
  function proposedReply(r, isNew) {
    return {
      content: isNew
        ? 'Proposed new skill "' + r.skill.name + '". It is not active until the Commander evaluates and approves it in ABILITIES > SKILLS.'
        : 'Proposed revision for skill "' + r.skill.name + '". It is not active until the Commander evaluates and approves it in ABILITIES > SKILLS; the active version is unchanged.',
      summary: 'proposed'
    };
  }

  /* A MODEL SETS ONLY WHAT ITS SCHEMA OFFERS. skill.manage used to hand the model's arguments to the store
     wholesale, so a model could write provenance the store trusts: sourceUrl/sourceDigest (the trust tier),
     packageFiles/packageDigest (what hydrate serves and export seals), createdBy, force. Everything outside the
     advertised schema is dropped here; the host adds agentId/createdBy/sourceRunId itself. */
  const MODEL_FIELDS = ['action', 'target', 'id', 'name', 'summary', 'description', 'body', 'category', 'setup',
    'platforms', 'requires', 'find', 'replace', 'path', 'content', 'absorbedInto', 'pinned'];
  function modelArgs(args) {
    const out = {};
    if (!args || typeof args !== 'object') return out;
    for (const k of MODEL_FIELDS) if (Object.prototype.hasOwnProperty.call(args, k)) out[k] = args[k];
    return out;
  }

  /* The host's field-first stored-text scrub (index.js scrubSkillsForPrompt): each field through prompt-scrub's
     scrubStored, one read of the held list per call. skill.list / skill.view default to it when no scrubSkills is
     passed. Where there is no require (a browser copy), there is no scrub to take, so nothing is shown. */
  function storedTextScrub() {
    if (typeof require !== 'function') return () => { throw new Error('no stored-text scrub is available here, so nothing was shown'); };
    const PS = require('../../prompt-scrub.js');
    const runtime = require('../../skills/runtime.js');
    return (list) => PS.withHeld(() => list.map(s => runtime.scrubSkillText(s, PS.scrubStored)));
  }

  function makeSkillTools(deps) {
    const store = deps && deps.store;
    const onView = deps && deps.onView;
    // onManage(skill, ctx, action, { isNew }): isNew marks a proposal for a skill with no active version, so an
    // observer whose own deliverable title replaces emitSkill's (the review/curator passes) can say 'Proposed skill'.
    const onManage = deps && deps.onManage;
    const gate = (deps && deps.gate) || null;                          // skills/gate.js instance: may the MODEL read this skill?
    const readBeforeWrite = !!(deps && deps.readBeforeWrite);           // set for the autonomous review/curator passes
    // countViews:false for the review/curator passes: a maintenance read is not a use, so it must not refresh a
    // skill's lastUsedAt (the 30/90-day aging clock) or its view count.
    const countViews = !(deps && deps.countViews === false);
    /* BUNDLED RECIPES ON DEMAND (2026-09-23). The run prompt indexes the Commander's enabled library recipes
       instead of inlining their bodies; this is where a body is fetched. `bundled(name, ctx)` resolves a name
       against the recipes THIS run is offered and returns { name, content } or null. It is consulted ONLY after
       the agent's own store finds nothing, so every agent-authored lookup is unchanged, and it never touches the
       guard, the read-before-write ledger, or onView — a shipped recipe is curated content, not a model-authored
       skill the review/curator passes may rewrite. Absent (the review/curator forks), skill.view is exactly as before. */
    const bundled = (deps && typeof deps.bundled === 'function') ? deps.bundled : null;
    /* FIELD FIRST (review r2, M1). The store keeps a skill's exact text and cuts a summary at 280 characters, so a key
       the cut left half-there is found at the end of its own field but not inside a composed row ('-- <summary>
       [active, …'): the registry's scrub of the result alone let the fragment through. `scrubSkills(list) -> list` (the
       host's scrubSkillsForPrompt, the run index's own field-first scrub, one held read per call) scrubs each field of
       what a row or a view prints first; the registry scrubs the composed result again. The gate still decides from the
       record as stored. A scrub that fails withholds the result (the registry turns the throw into an error result).
       With none passed, the tools take that same scrub themselves (storedTextScrub, review r3): a construction that
       leaves it out shows the scrubbed text, never the raw. A caller that wants the stored text as it is (a test of the
       byte path) passes the identity, scrubSkills: l => l. */
    const scrubSkills = (deps && typeof deps.scrubSkills === 'function') ? deps.scrubSkills : storedTextScrub();
    function shownAs(list) {
      const out = scrubSkills(list);
      if (!Array.isArray(out) || out.length !== list.length) throw new Error('the skill text scrub failed, so nothing was shown');
      return out;
    }

    /* THE READ-BEFORE-WRITE LEDGER (autonomous passes only).
       The background review and curator forks are handed skill.write/manage over the Commander's
       whole skillbase with no human in the loop. Nothing tied a rewrite to a READ, so a pass could
       patch or archive a skill it had only INFERRED from the run transcript — the most expensive
       possible failure here, because the loss is silent and the original body is already gone from
       the prompt. The ledger is closure-scoped, and both forks build their own tool instance per
       pass, so it starts empty every pass and never leaks between them. Create is always free
       (there is nothing to have read); pin/unpin/restore are lifecycle, not content. */
    const viewedThisPass = new Set();
    const CONTENT_ACTIONS = ['edit', 'patch', 'archive', 'delete', 'write_file', 'remove_file'];
    function markRead(skill) { if (skill && skill.id) viewedThisPass.add(String(skill.id)); }
    function unreadRefusal(skill, action) {
      if (!readBeforeWrite || !skill || !skill.id) return null;
      if (CONTENT_ACTIONS.indexOf(action) < 0) return null;
      if (viewedThisPass.has(String(skill.id))) return null;
      return {
        content: 'Refused: you have not read "' + skill.name + '" this pass. Call skill.view on it first, then '
          + action.replace(/_/g, ' ') + ' it — never rewrite a skill from what the transcript implied it says.',
        summary: 'unread'
      };
    }
    function withheldRefusal(decision, skill) {
      const cats = (decision && decision.categories && decision.categories.length)
        ? ' Guard findings: ' + decision.categories.join(', ') + '.' : '';
      return {
        content: 'The skill "' + (skill && skill.name) + '" is withheld by the skill guard and its body was not loaded: '
          + ((decision && decision.reason) || 'held by the skill guard') + '.' + cats
          + ' Do not recreate it and do not guess its contents; tell the Commander it needs review in ABILITIES > SKILLS.',
        summary: 'withheld'
      };
    }
    function decideFor(skill, withBody) {
      if (skill && skill.pendingCandidate) return { visible: false, reason: 'proposed skill awaits behavior evaluation and Commander approval' };
      if (!gate || !skill) return { visible: true };
      try {
        const d = (withBody && typeof gate.verify === 'function') ? gate.verify(skill)
          : (typeof gate.decide === 'function' ? gate.decide(skill) : { visible: true });
        return d || { visible: true };
      } catch (_) { return { visible: true }; }   // a gate hiccup must never strand the library
    }
    /* The existing record behind a name, WITHOUT counting as a read: bump:false so an internal
       lookup can never satisfy the ledger above or inflate usage telemetry. */
    function reviewContext(ctx) {
      return readBeforeWrite && !!(ctx && (ctx.skillReview || ['background-review', 'skill-review', 'curator'].includes(ctx.createdBy)));
    }
    function peek(agentId, nameOrId) {
      if (!store || typeof store.view !== 'function' || !nameOrId) return null;
      try { return (readBeforeWrite && store.pendingView && store.pendingView(agentId, nameOrId)) || store.view(agentId, nameOrId, { bump: false, includeArchived: true, hydrate: false }); } catch (_) { return null; }
    }
    // A staged write proposes a NEW skill when no active (or archived) version exists to revise. Read the active
    // record only: a pending draft is not a version the Commander approved. Unknown counts as a revision.
    function proposesNew(agentId, r) {
      if (typeof r.isNew === 'boolean') return r.isNew;
      if (!r.skill || !store || typeof store.view !== 'function') return false;
      try { return !store.view(agentId, r.skill.id, { bump: false, includeArchived: true, hydrate: false }); } catch (_) { return false; }
    }

    const writeTool = {
      name: 'skill.write', capability: 'memory', scope: 'write', requiresConsent: false, taintLocked: true,
      description: 'Save or update a reusable SKILL: a named, multi-step procedure you can reload later. Use skill.manage for patch/archive/support-file lifecycle work.',
      schema: {
        type: 'object', required: ['name', 'body'],
        properties: {
          name: { type: 'string', description: 'a short title, e.g. "Deploy the site"' },
          summary: { type: 'string', description: 'one line: what this skill does and when to use it' },
          description: { type: 'string', description: 'short package description' },
          body: { type: 'string', description: 'the full multi-step procedure' },
          category: { type: 'string' },
          setup: { type: 'string', description: 'setup notes, prerequisites, or environment details' },
          platforms: { type: 'array', items: { type: 'string' } }
        }
      },
      run: (args, ctx) => {
        if (!store) return { content: 'The skill library is unavailable.', summary: 'unavailable' };
        const aid = (ctx && ctx.agentId) || 'agent';
        // On an existing name this wrapper is an EDIT, so the ledger applies exactly as it does to
        // skill.manage — otherwise skill.write would be the way around it.
        const prior = readBeforeWrite ? peek(aid, args && args.name) : null;
        const unread = unreadRefusal(prior, 'edit');
        if (unread) return unread;
        const r = store.write({
          agentId: aid, name: args && args.name, summary: args && args.summary, body: args && args.body,
          description: args && args.description, category: args && args.category, setup: args && args.setup,
          platforms: args && args.platforms, createdBy: (ctx && ctx.createdBy) || (ctx && ctx.skillReview ? 'background-review' : 'agent'), sourceRunId: ctx && ctx.runId
        });
        if (!r.ok) return { content: 'Could not save the skill: ' + r.error, summary: 'not saved' };
        const isNew = !!r.pending && proposesNew(aid, r);
        emitSkill(ctx, r.skill, isNew);
        if (typeof onManage === 'function') { try { onManage(r.skill, ctx, r.pending ? 'propose' : (r.edited ? 'edit' : 'create'), { isNew }); } catch (_) {} }
        if (r.pending) return proposedReply(r, isNew);
        return { content: (r.edited ? 'Updated' : 'Saved') + ' skill "' + r.skill.name + '". Reload it anytime with skill.view.', summary: r.edited ? 'edited' : 'saved' };
      }
    };

    const manageTool = {
      name: 'skill.manage', capability: 'memory', scope: 'write', requiresConsent: false, taintLocked: true,
      description: 'Create, edit, patch, archive, restore, pin, or attach support files for saved skills. Prefer patching or updating an existing skill before creating a duplicate.',
      schema: {
        type: 'object', required: ['action'],
        properties: {
          action: { type: 'string', enum: ['create', 'edit', 'patch', 'archive', 'delete', 'restore', 'pin', 'unpin', 'write_file', 'remove_file'] },
          target: { type: 'string', description: 'existing skill name or id (every action but create)' },
          id: { type: 'string' },
          name: { type: 'string', description: 'name for create; lookup fallback otherwise' },
          summary: { type: 'string' },
          description: { type: 'string' },
          body: { type: 'string' },
          category: { type: 'string' },
          setup: { type: 'string' },
          platforms: { type: 'array', items: { type: 'string' } },
          requires: { type: 'array', items: { type: 'string' } },
          find: { type: 'string', description: 'patch: text to find' },
          replace: { type: 'string', description: 'patch: replacement text' },
          path: { type: 'string', description: 'support file path under references/, templates/, scripts/, or assets/' },
          content: { type: 'string', description: 'write_file: the file content' },
          absorbedInto: { type: 'string', description: 'archive after a merge: the skill now carrying this content (required for consolidation passes)' },
          pinned: { type: 'boolean' }
        }
      },
      run: (args, ctx) => {
        if (!store || typeof store.manage !== 'function') return { content: 'The skill manager is unavailable.', summary: 'unavailable' };
        const aid = (ctx && ctx.agentId) || 'agent';
        const action = String((args && args.action) || 'create').toLowerCase();
        // The pin is the Commander's lock against model writes (bug 97743dff): a run may add it, never take it off.
        if (action === 'unpin') return { content: 'Refused: only the Commander can unpin a skill, in ABILITIES > SKILLS. Leave it pinned and tell the Commander what you would change.', summary: 'not saved' };
        if (readBeforeWrite && action !== 'create') {
          const prior = peek(aid, (args && (args.target != null ? args.target : (args.id != null ? args.id : args.name))));
          const unread = unreadRefusal(prior, action);
          if (unread) return unread;
        }
        const r = store.manage(Object.assign(modelArgs(args), { agentId: aid, createdBy: (ctx && ctx.createdBy) || (ctx && ctx.skillReview ? 'background-review' : 'agent'), sourceRunId: ctx && ctx.runId }));
        if (!r.ok) return { content: 'Could not manage the skill: ' + r.error, summary: 'not saved' };
        const isNew = !!r.pending && proposesNew(aid, r);
        emitSkill(ctx, r.skill, isNew);
        if (typeof onManage === 'function') { try { onManage(r.skill, ctx, r.pending ? 'propose' : (r.action || (args && args.action) || 'manage'), { isNew }); } catch (_) {} }
        if (r.pending) return proposedReply(r, isNew);
        const done = r.action || (args && args.action) || 'updated';
        const path = r.path ? (' (' + r.path + ')') : '';
        const heir = r.absorbedInto ? (' Content now lives in "' + r.absorbedInto + '".') : '';
        return { content: 'Skill "' + r.skill.name + '" ' + done.replace(/_/g, ' ') + ' complete' + path + '.' + heir, summary: done };
      }
    };

    const listTool = {
      name: 'skill.list', capability: 'memory', scope: 'read', requiresConsent: false,
      description: 'Search or page through saved skills available to you, including explicitly shared station and project skills. Names, summaries, owners, scope and usage only. Load a procedure with skill.view; pass ownerAgentId for a shared skill.',
      schema: { type: 'object', properties: { includeArchived: { type: 'boolean' }, query: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
      run: (args, ctx) => {
        if (!store) return { content: 'The skill library is unavailable.', summary: 'unavailable' };
        const aid = (ctx && ctx.agentId) || 'agent';
        const options = { includeArchived: !!(args && args.includeArchived), projectRoot: ctx && ctx.projectRoot };
        let available = (!reviewContext(ctx) && store.listAccessible) ? store.listAccessible(aid, options) : store.list(aid, options);
        if (reviewContext(ctx) && store.candidates) for (const row of store.candidates(aid, { includeBody: false })) {
          if (!available.some(s => s.id === row.skill.id)) available.push(Object.assign({}, row.skill, { pendingCandidate: true }));
        }
        const query = args && args.query;
        if (query) available = require('../../skills/runtime.js').searchIndex(available, query);
        const offset = Math.max(0, Math.floor(Number(args && args.offset) || 0));
        const limit = Math.min(100, Math.max(1, Math.floor(Number(args && args.limit) || 40)));
        const list = available.slice(offset, offset + limit);
        if (!list.length) return { content: query ? 'No accessible skills match that query. Try another query or list without a query.' : (offset ? 'No more accessible skills on this page.' : 'No skills saved yet. Save one with skill.manage after you work out a repeatable procedure.'), summary: '0 skills' };
        let held = 0;
        const shown = shownAs(list);   // each field scrubbed before the row is composed (FIELD FIRST above)
        const lines = list.map((s, i) => {
          const t = shown[i] || {};
          // A review pass can read and continue its own pending draft: it is a draft, not a guard hold.
          if (s.pendingCandidate && reviewContext(ctx)) return '- ' + t.name + ' [PENDING DRAFT: not active; skill.view loads it for review]';
          const d = decideFor(s, false);
          // Same rule as the prompt index: name a withheld skill, never summarize it.
          if (d.visible === false) { held++; return '- ' + t.name + ' [WITHHELD: ' + (d.reason || 'held by the skill guard') + ']'; }
          return '- ' + t.name + ' [owner: ' + s.agentId + ', scope: ' + (s.scope || 'agent') + ']' + (t.summary ? ' -- ' + t.summary : '') + ' [' + (s.state || 'active') + ', used ' + (s.useCount || 0) + 'x' + fileLabel(t.files) + ']';
        });
        return {
          content: lines.join('\n') + (offset + list.length < available.length ? '\n\nMore matches: call skill.list with offset:' + (offset + list.length) + ' and the same query.' : '\n\nEnd of accessible matches.') ,
          summary: list.length + ' skill(s)' + (held ? ', ' + held + ' withheld' : '')
        };
      }
    };

    const viewTool = {
      name: 'skill.view', capability: 'memory', scope: 'read', requiresConsent: false,
      description: bundled
        ? 'Load the full step-by-step body of one saved skill, or of an installed recipe by its library:<slug> name, by name or id. Call this whenever a saved skill or installed recipe may apply.'
        : 'Load the full step-by-step body of one saved skill by name or id. Call this whenever a saved skill may apply.',
      schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, ownerAgentId: { type: 'string', description: 'owner shown in skill.list; required when shared names are ambiguous' } } },
      run: (args, ctx) => {
        if (!store) return { content: 'The skill library is unavailable.', summary: 'unavailable' };
        const aid = (ctx && ctx.agentId) || 'agent';
        const opts = { projectRoot: ctx && ctx.projectRoot, ownerAgentId: args && args.ownerAgentId, bump: countViews };
        const pending = reviewContext(ctx) && store.pendingView ? store.pendingView(aid, args && args.name) : null;
        const v = pending || (store.viewAccessible ? store.viewAccessible(aid, args && args.name, opts) : store.view(aid, args && args.name, opts));
        if (!v) {
          const recipe = bundled ? bundled(args && args.name, ctx) : null;
          if (recipe && recipe.content) return { content: recipe.content, summary: 'loaded ' + recipe.name };
          return { content: 'No skill named "' + (args && args.name) + '". Use skill.list to see what you have.', summary: 'not found' };
        }
        /* THE DELIVERY GATE. This is the only place a full body crosses into the conversation, so it
           gets the strict check (gate.verify re-digests the hydrated package: SKILL.md is read back
           off disk and can differ from what the scanner saw). A refused view is NOT a read — it must
           not reach onView (which would list it as a loaded skill in the run's telemetry) and must
           not satisfy the read-before-write ledger. */
        // A proposal this run cannot read is waiting on the Commander, not held by the guard: say so, or the agent
        // reports a guard hold that does not exist.
        if (v.pendingCandidate && !pending) return {
          content: 'The skill "' + v.name + '" is a proposal awaiting the Commander\'s evaluation and approval in ABILITIES > SKILLS; it is not active and its body was not loaded. Do not recreate it.',
          summary: 'pending'
        };
        const decision = pending && gate && typeof gate.verifyDraft === 'function' ? gate.verifyDraft(v) : decideFor(v, true);
        if (decision.visible === false) return withheldRefusal(decision, v);
        const t = shownAs([v])[0];   // composed from each field scrubbed first; decided, read and counted as stored
        markRead(v);
        if (!pending && typeof onView === 'function') { try { onView(v, ctx); } catch (_) {} }
        const files = t.files && t.files.length
          ? '\n\nSupport files:\n' + t.files.map(require('../../skills/runtime.js').supportFileLine).join('\n')   // base64 text decoded, binary named (#145)
          : '';
        const setup = t.setup ? '\n\nSetup:\n' + t.setup : '';
        return { content: (pending ? '[Pending review draft — not active or approved]\n' : '') + '# ' + t.name + (t.summary ? '\n' + t.summary : '') + setup + '\n\n' + t.body + files, summary: 'loaded ' + v.name };
      }
    };

    return {
      writeTool, manageTool, listTool, viewTool,
      register(reg) { reg.register(writeTool); reg.register(manageTool); reg.register(listTool); reg.register(viewTool); return reg; }
    };
  }

  return { makeSkillTools };
});
