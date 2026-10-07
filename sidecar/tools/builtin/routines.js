/* sidecar/tools/builtin/routines.js -- StarNet ROUTINES tools.

   These tools let the lead/orchestrator create and inspect scheduled routines through the SAME server-owned
   cron store that backs the ROUTINES panel. They intentionally do not use shell, crontab, Windows Task
   Scheduler, or any OS-level scheduler: a created job is a StarNet CronJob and fires through the harness. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).routines = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  const NAME_CHARS = 80;
  const PROMPT_CHARS = 12000;

  function clean(s, n) {
    s = String(s == null ? '' : s).trim();
    return n && s.length > n ? s.slice(0, n) : s;
  }
  function lower(s) { return String(s == null ? '' : s).toLowerCase(); }
  function validId(id) { return ID_RE.test(String(id || '')); }

  function asEntries(rosterLike) {
    const out = [];
    if (rosterLike && typeof rosterLike.forEach === 'function') {
      rosterLike.forEach((ident, id) => out.push({ id: String(id || ''), ident: ident || {} }));
    } else if (rosterLike && typeof rosterLike === 'object') {
      for (const id in rosterLike) out.push({ id: String(id || ''), ident: rosterLike[id] || {} });
    }
    return out.filter(e => validId(e.id));
  }

  function agentHaystack(e) {
    const i = e.ident || {};
    return lower([
      e.id, i.name, i.role, i.purpose, i.specId, i.specialty, i.persona, i.system
    ].filter(Boolean).join(' '));
  }

  const ROUTES = [
    {
      name: 'research',
      triggers: ['research', 'news', 'latest', 'source', 'sources', 'web', 'paper', 'papers', 'arxiv', 'scan', 'monitor', 'brief'],
      roles: ['research', 'researcher', 'scout', 'analyst', 'intelligence', 'web', 'prospector', 'strategist', 'paralegal', 'jobhunter', 'opportunist', 'sentinel', 'harvester', 'hiring', 'pitchwriter']
    },
    {
      name: 'engineering',
      triggers: ['code', 'repo', 'bug', 'test', 'build', 'implement', 'fix', 'debug', 'ci'],
      roles: ['engineer', 'engineering', 'developer', 'coder', 'reviewer', 'drafter', 'apptester', 'auditor', 'deployer', 'dbhelper', 'a11y']
    },
    {
      name: 'writing',
      triggers: ['write', 'draft', 'copy', 'post', 'email', 'newsletter', 'document', 'summary', 'script', 'publish'],
      roles: ['scribe', 'writer', 'editor', 'publisher', 'envoy', 'marketer', 'ghostwriter', 'negotiator', 'anchor', 'diplomat', 'copywriter', 'webdesigner', 'support', 'processwriter']
    },
    {
      name: 'ops',
      triggers: ['check', 'remind', 'watch', 'backup', 'sync', 'ops', 'operate', 'admin'],
      roles: ['operator', 'ops', 'chief', 'treasurer', 'nightwatch', 'foreman', 'pilot', 'taskmaster', 'registrar', 'provisioner', 'medic']
    },
    {
      name: 'design',
      triggers: ['design', 'image', 'visual', 'ui', 'ux', 'mockup', 'sprite'],
      roles: ['designer', 'design', 'artist', 'producer']
    }
  ];

  function words(s) {
    const m = lower(s).match(/[a-z0-9_-]{4,}/g);
    return m || [];
  }

  function hasAny(text, arr) {
    for (const x of arr) if (text.indexOf(x) >= 0) return true;
    return false;
  }

  function scoreEntry(e, intent) {
    const hay = agentHaystack(e);
    let score = 0;
    const hint = clean(intent.hint, 80);
    if (hint) {
      const h = lower(hint);
      if (e.id.toLowerCase() === h) score += 100;
      if (hay.indexOf(h) >= 0) score += 35;
    }
    for (const r of ROUTES) {
      if (!hasAny(intent.text, r.triggers)) continue;
      if (hasAny(hay, r.roles)) score += 30;
      if (hasAny(lower(e.id), r.roles)) score += 10;
      if (hasAny(lower((e.ident && e.ident.name) || ''), r.roles)) score += 8;
    }
    for (const w of words(intent.text).slice(0, 24)) {
      if (hay.indexOf(w) >= 0) score += 1;
    }
    return score;
  }

  function chooseAgent(args, ctx, rosterEntries) {
    const requested = clean(args && args.agentId, 80);
    if (requested) {
      if (!validId(requested)) throw new Error('agentId must be one of your station agents');
      const known = rosterEntries.some(e => e.id === requested);
      if (rosterEntries.length && !known && requested !== 'agent') {
        throw new Error('unknown routine agentId "' + requested + '" (known: ' + rosterEntries.map(e => e.id).join(', ') + ')');
      }
      return { agentId: requested, reason: 'requested' };
    }

    const fallback = (ctx && validId(ctx.agentId)) ? ctx.agentId : 'agent';
    if (!rosterEntries.length) return { agentId: fallback, reason: 'no roster available; used current agent' };

    const intent = {
      hint: clean((args && args.agentHint) || '', 80),
      text: lower([args && args.name, args && args.prompt, args && args.agentHint].filter(Boolean).join(' '))
    };
    let best = null;
    for (const e of rosterEntries) {
      const score = scoreEntry(e, intent);
      if (!best || score > best.score) best = { entry: e, score: score };
    }
    if (best && best.score > 0) return { agentId: best.entry.id, reason: 'matched roster specialty' };
    if (rosterEntries.some(e => e.id === fallback)) return { agentId: fallback, reason: 'used current agent' };
    if (rosterEntries.some(e => e.id === 'agent')) return { agentId: 'agent', reason: 'used default agent' };
    return { agentId: rosterEntries[0].id, reason: 'used first available agent' };
  }

  // describe (injected by the host) turns a job into plain words: { when, next } on the host's wall clock. The model
  // reports a routine's cadence back to the Commander, and reading `cron 0 10 * * 1` it once told them "bi-weekly".
  function packJob(job, describe) {
    if (!job) return null;
    let words = null;
    try { words = typeof describe === 'function' ? describe(job) : null; } catch (_) { words = null; }
    return {
      id: job.id,
      name: job.name,
      agentId: job.agentId,
      scheduleDisplay: job.scheduleDisplay,
      when: (words && words.when) || undefined,
      nextRunLocal: (words && words.next) || undefined,
      enabled: !!job.enabled,
      state: job.state,
      nextRunAt: job.nextRunAt,
      lastRunAt: job.lastRunAt,
      lastStatus: job.lastStatus,
      lastError: job.lastError || (job.blockedConfig && job.blockedConfig.reason) || null,
      lastReason: job.lastReason || null,
      deliver: job.deliver || 'local',
      completedRuns: job.repeat && job.repeat.completed || 0,
      provider: job.provider || null,
      model: job.model || null
    };
  }

  /* ---- routine.manage: resolve a job REFERENCE -----------------------------------------------------------
     A model that just called routine.list has the NAME in front of it far more often than the uuid, and a
     re-listed uuid is the single most likely thing for it to mistype. So a reference resolves by id first
     (exact), then by name: exact case-insensitive, then unique case-insensitive substring. AMBIGUITY IS AN
     ERROR, never a guess — silently picking one of two routines called "morning brief" would edit or delete
     the wrong standing job, and the agent has no way to notice. Mirrors the reference harness's
     resolve_job_ref (cron/jobs.py), which learned the same lesson. */
  function resolveJobRef(jobs, ref) {
    const want = clean(ref, 200);
    if (!want) throw new Error('id or name is required');
    const all = (jobs || []).filter(j => j && j.id);
    const byId = all.find(j => String(j.id) === want);
    if (byId) return byId;
    const w = lower(want);
    const exactName = all.filter(j => lower(j.name) === w);
    if (exactName.length === 1) return exactName[0];
    if (exactName.length > 1) throw new Error(ambiguous(want, exactName));
    const partial = all.filter(j => lower(j.name).indexOf(w) >= 0);
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) throw new Error(ambiguous(want, partial));
    throw new Error('no routine matches "' + want + '" — call routine.list to see the current routines');
  }
  function ambiguous(want, matches) {
    return '"' + want + '" matches ' + matches.length + ' routines — pass an exact id: '
      + matches.slice(0, 6).map(j => j.id + ' (' + j.name + ')').join(', ');
  }

  /* THE PATCH WHITELIST — a hard privilege boundary, not a convenience.
     cron-store's updateJob patches more fields than an agent may ever touch: the standing unattended
     capability grant the COMMANDER ticks in the ROUTINES panel (the one that hands a routine a terminal with
     nobody watching), plus `script` / `workdir` / `skills` / `contextFrom`. An agent that could patch those
     could give its OWN scheduled routine powers it was never granted — a straight escalation off one hostile
     web page. So this path ENUMERATES what it may touch and silently drops everything else; widening a
     routine's power stays a human action in the panel. Deliberately an allowlist and not a denylist: a field
     added to the store later is then withheld by default instead of quietly becoming agent-writable.
     (test/tool-withheld-message.test.js additionally source-greps this file to prove no code path here even
     NAMES that grant field — which is why the sentence above describes it instead of spelling it.) */
  const AGENT_PATCHABLE = ['name', 'prompt', 'schedule', 'model', 'provider', 'repeatTimes', 'timezone', 'monitorMode', 'deliver', 'attachToSession'];

  function makeRoutineTools(deps) {
    deps = deps || {};
    const listJobs = typeof deps.listJobs === 'function' ? deps.listJobs : function () { return []; };
    const createRoutine = deps.createRoutine;
    // routine.manage's four store verbs. Kept as DISCRETE injected verbs (not one host-side `manage`) so the
    // policy — reference resolution, the patch whitelist, the queued-not-run wording — lives here where it is
    // node-testable, and the host keeps only the locked read-modify-write it already owns for the HTTP routes.
    // Each is async and returns the updated job (or undefined); absent => the tool answers "unavailable".
    const updateRoutine = deps.updateRoutine;
    const removeRoutine = deps.removeRoutine;
    const setRoutineEnabled = deps.setRoutineEnabled;
    const triggerRoutine = deps.triggerRoutine;
    const getRoutineNotepad = deps.getRoutineNotepad;
    const setRoutineNotepad = deps.setRoutineNotepad;
    const armScheduler = deps.armScheduler;
    const schedulerState = typeof deps.schedulerState === 'function' ? deps.schedulerState : function () { return false; };
    /* THE E-STOP IS A SECOND, INDEPENDENT FACT. `schedulerArmed` reports the arm INTENT, which E-STOP deliberately
       leaves true — so every readout here said "armed" about a scheduler the Commander had durably stood down, and
       run_now told the model the routine "fires on its next tick (within ~1 minute)" when no tick was coming. */
    const schedulerHalted = typeof deps.schedulerHalted === 'function' ? deps.schedulerHalted : function () { return false; };
    const armedNote = function () {
      if (schedulerHalted()) return "the scheduler is STOPPED by the Commander's E-STOP — nothing fires until they resume it";
      return schedulerState() ? null : 'the scheduler is DISARMED — nothing fires until it is armed';
    };
    const roster = typeof deps.roster === 'function' ? deps.roster : function () { return new Map(); };
    const pack = function (job) { return packJob(job, deps.describeSchedule); };
    // W6: the plain anti-retry line + the per-agent "you already maintain: …" summary. Injected so this tool
    // stays node-testable; defaults keep it a no-op when the host doesn't wire the mint ledger.
    const ANTI_RETRY = 'this routine already exists — do not recreate it';
    const mintSummary = typeof deps.mintSummary === 'function' ? deps.mintSummary : function () { return ''; };
    const normalizeProvider = typeof deps.normalizeProvider === 'function' ? deps.normalizeProvider : function (p) {
      p = lower(p).trim();
      if (!p) return null;
      return p === 'codex' || p === 'openai-codex' ? 'codex' : (p === 'openrouter' ? 'openrouter' : '');
    };
    /* ⛔ AN ALLOWLIST IS A DENYLIST FOR EVERY CLASS ADDED LATER. `provider` was hardcoded
       enum:['openrouter','codex'] in BOTH tool schemas while the station shipped 17 providers. A Commander
       running on Kimi, Grok, Ollama or a custom endpoint had an agent that could not pin a routine to the very
       provider the station runs on: shared/schema.js enforces `enum`, so the call died with
       '"kimi" not in enum' before run() was ever reached. Read the live registry instead (injected, so this
       module stays node-testable), and fall back to the historical pair only when the host wires nothing. */
    const providerIds = typeof deps.providerIds === 'function' ? deps.providerIds : function () { return ['openrouter', 'codex']; };
    const providerEnum = (function () {
      let ids = [];
      try { ids = providerIds() || []; } catch (_) { ids = []; }
      ids = ids.map(x => lower(x).trim()).filter(Boolean);
      return ids.length ? Array.from(new Set(ids)) : ['openrouter', 'codex'];
    })();

    const listTool = {
      name: 'routine.list', capability: 'orchestrator', scope: 'read', requiresConsent: false,
      description: 'List StarNet ROUTINES scheduled jobs. Use this to check existing routines before creating another one.',
      schema: { type: 'object', properties: { agentId: { type: 'string' } } },
      run: async (args) => {
        const agentId = clean(args && args.agentId, 80);
        if (agentId && !validId(agentId)) throw new Error('agentId must be one of your station agents');
        let jobs = (listJobs() || []).map(pack).filter(Boolean);
        if (agentId) jobs = jobs.filter(j => j.agentId === agentId);
        return { content: JSON.stringify({ schedulerArmed: !!schedulerState(), schedulerHalted: !!schedulerHalted(), schedulerNote: armedNote() || undefined, jobs: jobs }), summary: jobs.length + ' routine(s)' };
      }
    };

    const createTool = {
      name: 'routine.create', capability: 'orchestrator', scope: 'write', requiresConsent: true, timeoutMs: 15000,
      /* Trimmed 2026-07-26 (tool-schema cost pass). Re-sent every turn, so it keeps only what changes a
         decision and lives nowhere better: what this is, the trigger words that route work HERE instead of
         to a shell, and the check-first rule. Dropped: the agentId auto-routing and `arm` default, both of
         which the schema below already states at the point of use, and the explanation that the server
         rejects a duplicate name — it says so itself, at call time, more precisely than a remembered note. */
      description: 'Create a StarNet ROUTINE: work an agent runs on a schedule (digests, research, monitoring, reports, drafts, reminders). Use it whenever the Commander wants anything recurring, scheduled or automated — never shell.exec, crontab or an OS scheduler. Results come back to this chat by default; do not ask where to send them. Write a self-contained prompt: task, sources, format, what to flag. Asked to automate something broadly? Create 2-5 routines your own tools can run now (web research, writing, checks; no connection needed), then list them. Call routine.list first; never duplicate.',
      schema: {
        type: 'object',
        required: ['prompt', 'schedule'],
        properties: {
          name: { type: 'string' },
          prompt: { type: 'string', description: 'The instruction the target agent will run every time the routine fires.' },
          schedule: { type: 'string', description: 'Plain English (every day at 7am, weekdays at 9am, mondays at 6pm, 1st of every month, tomorrow at 9am), every 30m, in 2h, or cron.' },
          agentId: { type: 'string', description: 'Optional exact station agent id. Omit to auto-route by specialty.' },
          agentHint: { type: 'string', description: 'Optional specialty hint such as research, engineer, scribe, operator, designer.' },
          timezone: { type: 'string', description: 'Optional IANA timezone for cron expressions, e.g. America/New_York.' },
          provider: { type: 'string', enum: providerEnum },
          model: { type: 'string' },
          enabled: { type: 'boolean' },
          arm: { type: 'boolean', description: 'Default true. When true, also enables the scheduler so routines will fire.' },
          repeatTimes: { type: ['integer', 'null'], description: 'Omit/null for recurring forever; one-shot schedules still run once.' }
          ,deliver: { type: 'string', enum: ['local', 'origin'], description: 'Where to send each result. origin returns it to this chat/session.' }
          ,attachToSession: { type: 'boolean', description: 'Keep delivered results in the origin conversation so replies can continue from them.' }
          ,skills: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Saved runtime skills to preload on every run.' }
          ,contextFrom: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Routine ids whose latest successful outputs feed this routine.' }
          ,monitorMode: { type: 'boolean', description: 'When true with contextFrom, run only after the durable upstream source hash changes.' }
          ,enabledToolsets: { type: 'array', items: { type: 'string' }, maxItems: 16, description: 'Only these toolset ids (e.g. web, cabinet); omit = station defaults.' }
        }
      },
      run: async (args, ctx) => {
        if (typeof createRoutine !== 'function') throw new Error('routine creation unavailable');
        const prompt = clean(args && args.prompt, PROMPT_CHARS);
        const schedule = clean(args && args.schedule, 200);
        if (!prompt) throw new Error('prompt is required');
        if (!schedule) throw new Error('schedule is required');

        const entries = asEntries(roster());
        const route = chooseAgent(args || {}, ctx || {}, entries);
        let provider = null;
        if (args && args.provider != null && args.provider !== '') {
          provider = normalizeProvider(args.provider);
          if (!provider) throw new Error('provider must be openrouter or codex');
        }
        const repeatTimes = (args && Object.prototype.hasOwnProperty.call(args, 'repeatTimes')) ? args.repeatTimes : null;
        const spec = {
          name: clean((args && args.name) || 'Scheduled routine', NAME_CHARS),
          prompt: prompt,
          schedule: schedule,
          timezone: clean((args && args.timezone) || '', 80),
          agentId: route.agentId,
          provider: provider,
          model: args && args.model != null ? clean(args.model, 120) : null,
          enabled: !(args && args.enabled === false),
          deliver: clean((args && args.deliver) || (ctx && ctx.deliveryOrigin ? 'origin' : 'local'), 40),
          origin: ctx && ctx.deliveryOrigin ? ctx.deliveryOrigin : null,
          attachToSession: !!(args && args.attachToSession),
          skills: Array.isArray(args && args.skills) ? args.skills.slice(0, 8) : [],
          contextFrom: Array.isArray(args && args.contextFrom) ? args.contextFrom.slice(0, 8) : null,
          monitorMode: !!(args && args.monitorMode),
          enabledToolsets: Array.isArray(args && args.enabledToolsets) && args.enabledToolsets.length ? args.enabledToolsets.slice(0, 16) : null,   // [] = no restriction, never "no tools"
          repeat: { times: repeatTimes == null ? null : Math.max(1, parseInt(repeatTimes, 10) || 1) }
        };
        const job = await createRoutine(spec);

        // W6 MINT GATE: the server refused to mint a duplicate. `_duplicate` -> this agent already runs an
        // exact/near-identical routine (job is the existing one); `_declined` -> the Commander previously deleted
        // this routine and it must not be resurrected. Either way, answer plainly with the anti-retry line and do
        // NOT arm — nothing new was created (server is the authority; this is truthful, not a second store entry).
        if (job && job._declined) {
          return {
            content: JSON.stringify({ ok: false, declined: true, message: ANTI_RETRY, routedTo: route.agentId }),
            summary: 'not created — this routine was removed and must not be recreated'
          };
        }
        if (job && job._duplicate) {
          const existing = pack(job);
          return {
            content: JSON.stringify({ ok: true, duplicate: true, message: ANTI_RETRY, routedTo: route.agentId, job: existing }),
            summary: 'already exists — did not create a duplicate for ' + route.agentId
          };
        }

        let armError = null;
        if (!args || args.arm !== false) {
          try { if (typeof armScheduler === 'function') armScheduler(true); }
          catch (e) { armError = (e && e.message) || String(e); }
        }

        const body = {
          ok: true,
          schedulerArmed: !!schedulerState(),
          schedulerHalted: !!schedulerHalted(),
          // so the model cannot report "this will run daily" over a stopped scheduler
          schedulerNote: armedNote() || undefined,
          armError: armError,
          routedTo: route.agentId,
          routingReason: route.reason,
          job: pack(job),
          // W6: the plain "you already maintain: …" reminder so the model tracks what exists across turns.
          maintains: mintSummary(route.agentId) || undefined
        };
        return {
          content: JSON.stringify(body),
          summary: 'scheduled routine for ' + route.agentId + (armError ? ' (arm failed)' : '')
        };
      }
    };

    /* ---- routine.manage — edit / pause / resume / delete / fire-now ------------------------------------
       ONE action-oriented tool, not five. Every tool schema is re-sent on EVERY turn of every run (the
       tool-schema cost pass measured the whole surface at 37.7KB/req), so five near-identical
       {id,name} schemas would buy the same five verbs at five times the standing cost. The reference
       harness collapsed its cron tools for exactly this reason ("a single compressed action-oriented tool
       to avoid schema/context bloat", tools/cronjob_tools.py) — same call here.

       Consent-gated as a whole, like routine.create: an EDIT is the same attack surface as a create (a
       routine authored clean can be patched into a payload), and pausing or deleting standing autonomous
       work is a Commander-visible change to what the station does while nobody watches.

       `run_now` QUEUES rather than runs. The panel's POST /api/cron/run streams a real run to a watching
       human; doing that from inside a tool call would nest a run inside a run (re-entrant runOnce, a second
       spend path with no separate cap, and a stream nobody is reading). Re-anchoring nextRunAt to now makes
       the SCHEDULER fire it on its next tick through the ordinary unattended path — which is also what the
       reference harness's trigger_job does. It reports the armed time, never "it ran". */
    const manageTool = {
      name: 'routine.manage', capability: 'orchestrator', scope: 'write', requiresConsent: true, timeoutMs: 15000,
      description: 'Edit, pause, resume, delete, or queue an immediate fire of an existing StarNet ROUTINES job. Call routine.list first to see what exists; reference a routine by its exact id, or by name when that name is unambiguous.',
      schema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['update', 'pause', 'resume', 'remove', 'run_now'] },
          id: { type: 'string', description: 'The routine id, or its name when unambiguous.' },
          name: { type: 'string', description: 'For action=update, the NEW name. To reference a routine by name, pass it as `id`.' },
          prompt: { type: 'string', description: 'update: replace the instruction the routine runs.' },
          schedule: { type: 'string', description: 'update: a new schedule, e.g. every 30m, 0 9 * * *, in 2h.' },
          timezone: { type: 'string', description: 'update: IANA timezone for a cron schedule.' },
          provider: { type: 'string', enum: providerEnum },
          model: { type: 'string' },
          repeatTimes: { type: ['integer', 'null'], description: 'update: null for recurring forever.' }
          ,monitorMode: { type: 'boolean', description: 'update: suppress runs while contextFrom source bytes are unchanged.' }
          ,deliver: { type: 'string', enum: ['local', 'origin'], description: 'update: local output or return to the captured chat/session.' }
          ,attachToSession: { type: 'boolean', description: 'update: keep local results in the captured session.' }
        }
      },
      run: async (args) => {
        const action = lower(clean(args && args.action, 20));
        if (['update', 'pause', 'resume', 'remove', 'run_now'].indexOf(action) < 0) {
          throw new Error('action must be update, pause, resume, remove, or run_now');
        }
        const job = resolveJobRef(listJobs() || [], args && args.id);

        if (action === 'remove') {
          if (typeof removeRoutine !== 'function') throw new Error('routine removal unavailable');
          await removeRoutine(job.id);
          return {
            content: JSON.stringify({ ok: true, action: action, removed: { id: job.id, name: job.name } }),
            summary: 'deleted routine "' + job.name + '"'
          };
        }

        if (action === 'pause' || action === 'resume') {
          if (typeof setRoutineEnabled !== 'function') throw new Error('routine pause/resume unavailable');
          const updated = await setRoutineEnabled(job.id, action === 'resume');
          return {
            content: JSON.stringify({ ok: true, action: action, schedulerArmed: !!schedulerState(), schedulerHalted: !!schedulerHalted(), schedulerNote: armedNote() || undefined, job: pack(updated || job) }),
            summary: (action === 'resume' ? 'resumed' : 'paused') + ' routine "' + job.name + '"'
          };
        }

        if (action === 'run_now') {
          if (typeof triggerRoutine !== 'function') throw new Error('routine trigger unavailable');
          const updated = await triggerRoutine(job.id);
          const halted = !!schedulerHalted();
          const armed = !!schedulerState() && !halted;
          return {
            content: JSON.stringify({
              ok: true, action: action, queued: true, schedulerArmed: !!schedulerState(), schedulerHalted: halted,
              // TRUTHFUL TELEMETRY: this did NOT run the routine, it moved its next fire to now. Say so, or the
              // model reports "I ran it" to the Commander and then reads no result. And an E-STOP means no tick
              // is coming at all — promising one "within ~1 minute" is the same lie with a deadline on it.
              note: halted
                ? "queued, but the scheduler is STOPPED by the Commander's E-STOP so nothing will fire until they resume it"
                : armed
                  ? 'queued — the scheduler fires this routine on its next tick (within ~1 minute); it has not run yet'
                  : 'queued, but the scheduler is DISARMED so nothing will fire until it is armed',
              job: pack(updated || job)
            }),
            summary: 'queued routine "' + job.name + '" to fire on the next tick' + (armed ? '' : ' (scheduler disarmed)')
          };
        }

        // ---- update ----
        if (typeof updateRoutine !== 'function') throw new Error('routine editing unavailable');
        const patch = {};
        // Test the CLEANED value, not the raw one: `name: '   '` is not-null and not-'' but cleans to empty, and
        // the first cut happily persisted a routine with a blank name and reported "updated (name)".
        const set = (key, raw, max) => { const v = clean(raw, max); if (v) patch[key] = v; };
        if (args) {
          set('name', args.name, NAME_CHARS);
          set('prompt', args.prompt, PROMPT_CHARS);
          set('schedule', args.schedule, 200);
          set('timezone', args.timezone, 80);
          set('model', args.model, 120);
          if (args.deliver != null) {
            if (args.deliver !== 'local' && args.deliver !== 'origin') throw new Error('deliver must be local or origin');
            patch.deliver = args.deliver;
          }
          if (Object.prototype.hasOwnProperty.call(args, 'attachToSession')) patch.attachToSession = args.attachToSession === true;
          if (Object.prototype.hasOwnProperty.call(args, 'monitorMode')) patch.monitorMode = args.monitorMode === true;
        }
        /* A TIMEZONE ONLY MEANS SOMETHING WITH A SCHEDULE. The host resolves tz inside the schedule parse
           (parseCronScheduleOr400(schedule, now, tz)), so a patch carrying tz and no schedule reaches the store
           as an empty patch: nothing changes, while the tool answers "updated routine (timezone)". Refuse it and
           say what to pass instead — a false "done" is worse than a rejected call. */
        if (patch.timezone && !patch.schedule) {
          throw new Error('a timezone only applies to a schedule — pass `schedule` as well (e.g. schedule "0 9 * * *" + timezone "America/New_York")');
        }
        if (args && args.provider != null && args.provider !== '') {
          const p = normalizeProvider(args.provider);
          if (!p) throw new Error('provider must be openrouter or codex');
          patch.provider = p;
        }
        if (args && Object.prototype.hasOwnProperty.call(args, 'repeatTimes')) patch.repeatTimes = args.repeatTimes;
        const touched = Object.keys(patch).filter(k => AGENT_PATCHABLE.indexOf(k) >= 0);
        if (!touched.length) throw new Error('nothing to update — pass at least one of ' + AGENT_PATCHABLE.join(', '));
        const updated = await updateRoutine(job.id, patch);
        // TRUTHFUL TELEMETRY: a rewritten prompt drops the routine's unattended grants (host rule, see updateRoutine
        // in index.js) — say so, or the model promises the Commander a routine that will now be locked out.
        const cleared = updated && Array.isArray(updated._grantsCleared) ? updated._grantsCleared : [];
        const out = { ok: true, action: action, changed: touched, job: pack(updated || job) };
        if (cleared.length) out.standingGrantsCleared = { grants: cleared, note: 'the new instruction was not approved by the Commander, so its unattended ' + cleared.join('/') + ' grant was removed; the Commander can re-grant it in ROUTINES' };
        return {
          content: JSON.stringify(out),
          summary: 'updated routine "' + job.name + '" (' + touched.join(', ') + ')' + (cleared.length ? ' — unattended grants cleared' : '')
        };
      }
    };

    const notepadTool = {
      name: 'routine.notepad', capability: 'routinescratch', scope: 'write', requiresConsent: false,
      description: 'Read or replace the bounded private scratchpad for THIS scheduled routine. The host selects the job from the current scheduled run; no job id is accepted, so one routine cannot read or write another routine\'s notes. Notes survive restart. Use action=write with empty text to clear it.',
      schema: {
        type: 'object', required: ['action'],
        properties: { action: { type: 'string', enum: ['read', 'write'] }, text: { type: 'string' } }
      },
      run: async (args, ctx) => {
        const jobId = String((ctx && ctx.cronJobId) || '');
        if (!jobId) return { content: 'routine.notepad is available only inside a scheduled routine run', summary: 'unavailable' };
        const action = lower(clean(args && args.action, 20));
        if (action === 'read') {
          if (typeof getRoutineNotepad !== 'function') return { content: 'routine notepad unavailable', summary: 'unavailable' };
          const note = await getRoutineNotepad(jobId);
          return { content: String(note == null ? '' : note).slice(0, 8000), summary: String(note || '').length + ' character(s)' };
        }
        if (action !== 'write') throw new Error('action must be read or write');
        if (typeof setRoutineNotepad !== 'function') return { content: 'routine notepad unavailable', summary: 'unavailable' };
        const note = String(args && args.text != null ? args.text : '').slice(0, 8000);
        const saved = await setRoutineNotepad(jobId, note);
        if (saved === false) throw new Error('routine notepad could not be persisted');
        return { content: JSON.stringify({ ok: true, characters: note.length }), summary: note ? 'routine notepad saved' : 'routine notepad cleared' };
      }
    };

    return {
      listTool: listTool,
      createTool: createTool,
      manageTool: manageTool,
      notepadTool: notepadTool,
      _chooseAgent: chooseAgent,
      _resolveJobRef: resolveJobRef,
      register(reg) { reg.register(listTool); reg.register(createTool); reg.register(manageTool); reg.register(notepadTool); return reg; }
    };
  }

  return { makeRoutineTools };
});
