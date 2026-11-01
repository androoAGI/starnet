/* sidecar/tools/builtin/quests.js — the QUEST capability write half: a single `quest.update` tool
   (QUEST V2, plan §B — agent awareness). The read half is questinject.js (the STATION QUESTS prompt block);
   this lets the agent ACT on those quests. It is the ONLY way an agent touches the ledger.

   Ops (op-routed like the todo tool):
     • start           — bind the ONE named run-contract quest to the current run. Agent-scoped. Run admission
                         never guesses among open objectives; only this explicit claim (or a named progress tick)
                         lets run-end completion settle that quest.
     • progress        — tick a NAMED open step with a short note (questStore.tickStep). Agent-scoped: the quest
                         must be OPEN FOR THIS agent (openForAgent) — an agent can't tick a step on a quest that
                         isn't its own / station-wide. Progress is display only; it NEVER completes a quest.
     • attest_complete — PROPOSE a quest done with concrete evidence (questStore.attest). Agent-scoped like
                         progress (openForAgent — its own + station-wide quests only; sequential quest ids are
                         guessable, so an unscoped attest would let any agent file a completion proposal on
                         another agent's quest). Evidence REQUIRED. This
                         NEVER completes the quest — it sets a pending attest the Commander confirms (rate-the-work
                         beat). The store rejects mechanical (prop/run/fact/artifact) contracts: their completion
                         stays machine-owned. Result copy says "proposed — awaiting confirmation", never "completed".
     • mint            — mint a NEW personalized quest (questStore.mint), kind:'generated', createdBy:'agent:<id>',
                         scoped to the calling agent (generative-minting, plan §E). The store enforces THE CONTRACT
                         RULE (no valid contract → rejected), title-dedup, and the ≤3-open-generated cap; its error
                         strings are surfaced VERBATIM so the model can self-correct. A MECHANICAL per-run cap (this
                         file) caps it at ONE successful mint per run — a run can't dump a backlog in a single pass.

   capability: 'quest' — a FREEBIE family carried by the `computer` object, the one object present in BOTH the
   interactive baseline office (compute-only) and the full default office, so quest.update rides EVERY task surface.
   (It rode capId 'memory'/the `notebook` object originally, but the interactive floor has no placed notebook, so the
   tool was ABSENT while the STATION QUESTS prompt commanded it — a truthful-telemetry break; see CAP_REGISTRY.computer.)
   A quest is the agent's own standing objective — reading/updating it is part of being able to think at all, the same
   freebie class as compute: no filesystem reach, no network, no outward mutation until the Commander confirms an
   attest. So, like todo, NO consent gate.

   makeQuestTools({ store, clock }) -> { questUpdateTool, register(reg) }
     store : the questStore instance (openForAgent, tickStep, attest, mint)
     clock : { now() } — injected wall-clock (the store takes every timestamp as a parameter). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).quests = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const OPS = ['start', 'progress', 'attest_complete', 'mint'];
  const str = v => String(v == null ? '' : v).trim();

  const MINTS_PER_RUN = 1;      // at most ONE successful mint per run — enforced MECHANICALLY here, not just by prompt doctrine
  const MINT_RUNS_CAP = 200;    // FIFO bound on the per-run mint counter so a long-lived process never grows it unbounded

  function makeQuestTools(deps) {
    deps = deps || {};
    const store = deps.store;
    if (!store) throw new Error('quests.js requires { store }');
    if (!deps.clock || typeof deps.clock.now !== 'function') throw new Error('quests.js requires { clock }');   // injected wall-clock only — determinism law, no ambient Date.now
    const now = () => deps.clock.now();

    // per-run mint budget: runId → count of SUCCESSFUL mints this run. Insertion-ordered Map, FIFO-evicted at
    // MINT_RUNS_CAP so it stays bounded across the process lifetime. A run with no runId can't be tracked, so the
    // mechanical cap simply doesn't apply there (the store's ≤3-open-generated cap still bounds it).
    const mintsByRun = new Map();

    const questUpdateTool = {
      name: 'quest.update', capability: 'quest', scope: 'write', requiresConsent: false, timeoutMs: 8000,
      description: 'Act on your STATION QUESTS (listed in your prompt). op:start binds the named run quest to '
        + 'this run; use it before doing that quest so an unrelated run can never complete it. op:progress ticks a named step '
        + '(pass id, stepKey and a short note on what you did); progress is display only and never completes a '
        + 'quest. op:attest_complete PROPOSES a quest is done (pass id and concrete evidence of what was '
        + 'accomplished); this NEVER marks it complete: the Commander must confirm. Quests that complete '
        + 'mechanically (a run finishing, a capability going live, a deliverable existing) cannot be attested; leave '
        + 'them to the harness. op:mint creates a NEW personalized quest for the Commander (pass title, a completion '
        + 'contract, domain, and groundedIn citing the dossier/memory fact that motivated it); every quest MUST declare a '
        + 'contract. Never claim a quest done in prose — use this tool.',
      schema: {
        type: 'object', required: ['op'], properties: {
          op: { type: 'string', enum: OPS },
          id: { type: 'string' },            // start / progress / attest_complete: which quest
          stepKey: { type: 'string' },       // progress: which step
          note: { type: 'string' },          // progress: what you did on this step
          evidence: { type: 'string' },      // attest_complete: concrete proof of completion
          title: { type: 'string' },         // mint: the new quest's title
          desc: { type: 'string' },          // mint: optional description
          reward: { type: 'string' },        // mint: the REAL outcome it unlocks (never points)
          domain: { type: 'string', enum: ['building', 'research', 'writing', 'growth', 'operations', 'creative', 'planning', 'support'] },
          contract: {                        // mint: the completion contract (REQUIRED by the store)
            type: 'object', properties: {
              type: { type: 'string', enum: ['prop', 'run', 'fact', 'artifact', 'attest'] },
              key: { type: 'string' }
            }
          },
          steps: {                           // mint: optional progress steps
            type: 'array', items: {
              type: 'object', properties: { key: { type: 'string' }, label: { type: 'string' } }
            }
          },
          groundedIn: { type: 'string' }     // mint: the dossier/memory fact that motivated this quest
        }
      },
      run: async (args, ctx) => {
        args = args || {};
        const op = str(args.op);
        const agentId = (ctx && ctx.agentId) || 'agent';
        const runId = ctx && ctx.runId ? String(ctx.runId) : null;

        // ---- start: explicitly bind the named mechanical run quest to THIS run ----
        if (op === 'start') {
          const id = str(args.id);
          if (!id) return { content: 'Pass the quest id to start (from your STATION QUESTS list).', summary: 'noop' };
          if (!runId) return { content: 'Starting a run quest needs the current run. No live runId was available.', summary: 'noop' };
          const mine = store.openForAgent(agentId, now()).find(q => q.id === id);
          if (!mine) return { content: 'Quest ' + id + ' is not one of your open quests. Only quests listed for you can be started.', summary: 'not yours' };
          if (!mine.contract || mine.contract.type !== 'run') return { content: 'Quest ' + id + ' is not a run quest, so it cannot be bound to this run.', summary: 'wrong contract' };
          const ok = await store.bindRun(id, runId, agentId);
          if (!ok) return { content: 'Could not start quest ' + id + ' on this run.', summary: 'no-op' };
          return { content: 'Started quest ' + id + ' on this run. Only this explicitly named quest is bound.', summary: 'started ' + id };
        }

        // ---- progress: tick a named step, agent-scoped ----
        if (op === 'progress') {
          const id = str(args.id);
          const stepKey = str(args.stepKey);
          if (!id) return { content: 'Pass the quest id to progress (from your STATION QUESTS list).', summary: 'noop' };
          if (!stepKey) return { content: 'Pass the stepKey of the step to tick.', summary: 'noop' };
          // AGENT SCOPING: only a quest OPEN FOR THIS agent (its own or station-wide) can be progressed here.
          const mine = store.openForAgent(agentId, now()).find(q => q.id === id);
          if (!mine) return { content: 'Quest ' + id + ' is not one of your open quests. Only work quests listed for you can be updated.', summary: 'not yours' };
          const ok = await store.tickStep(id, stepKey, args.note, now());
          if (!ok) return { content: 'No open step "' + stepKey + '" on ' + id + ' (it may not exist or already be done).', summary: 'no-op' };
          // QUEST V2 §A — RUN-contract binding at the tool seam: a successful progress tick during run R is the
          // agent PROVABLY working this quest in this run, so bind R (store.bindRun) — the run-end settle hook's
          // completeByContract('run', runId) then completes it on 'done' (non-done stalls it). This is the ONLY
          // binding path for a STATION-WIDE run quest (the prompt-injection seam binds only agent-OWNED ones —
          // an unrelated agent's next run must never claim a shared quest it did no work on). Fail-open.
          if (mine.contract && mine.contract.type === 'run' && runId) { try { await store.bindRun(id, runId, agentId); } catch (_) {} }
          return { content: 'Ticked step "' + stepKey + '" on ' + id + '.', summary: 'progress ' + id };
        }

        // ---- attest_complete: propose done with evidence (never completes) ----
        if (op === 'attest_complete') {
          const id = str(args.id);
          const evidence = str(args.evidence);
          if (!id) return { content: 'Pass the quest id to attest complete (from your STATION QUESTS list).', summary: 'noop' };
          if (!evidence) return { content: 'attest_complete needs concrete evidence of what was accomplished — attesting without proof is not allowed.', summary: 'noop' };
          // AGENT SCOPING (mirrors op:"progress"): only a quest OPEN FOR THIS agent (its own or station-wide —
          // openForAgent, the store's own visibility rule) may be attested. Quest ids are sequential and guessable;
          // without this gate any agent could file a completion proposal on ANOTHER agent's quest and put a
          // false "reports this quest complete" beat in front of the Commander. A station-wide (agentId:null)
          // quest stays attestable by any agent — shared by the store's design, exactly like progress.
          const attestable = store.openForAgent(agentId, now()).some(q => q.id === id);
          if (!attestable) return { content: 'Quest ' + id + ' is not one of your open quests. Only quests listed for you can be attested.', summary: 'not yours' };
          const r = await store.attest(id, { agentId: agentId, runId: runId, evidence: evidence }, now());
          if (!r || r.ok === false) return { content: (r && r.error) ? r.error : 'could not attest ' + id, summary: 'rejected' };
          return { content: 'Completion proposed for ' + id + ' — awaiting the Commander\'s confirmation. It is NOT complete yet.', summary: 'attest proposed' };
        }

        // ---- mint: create a new personalized quest (contract-enforced by the store) ----
        if (op === 'mint') {
          // MECHANICAL per-run cap: one successful mint per run. This guards against a run trying to dump a backlog
          // of quests in a single pass, independent of the prompt doctrine. Only SUCCESSFUL mints consume the budget
          // (a rejected contract/dup/cap doesn't burn it — the agent can fix and retry).
          if (runId && (mintsByRun.get(runId) || 0) >= MINTS_PER_RUN) {
            return { content: 'one quest per run — the Commander\'s log is not a backlog dump. You already minted a quest this run.', summary: 'mint cap' };
          }
          let activeGoal = null;
          try { activeGoal = typeof deps.activeGoal === 'function' ? deps.activeGoal() : null; } catch (_) { activeGoal = null; }
          const r = await store.mint({
            title: args.title,
            desc: args.desc,
            reward: args.reward,
            contract: args.contract,
            steps: args.steps,
            groundedIn: args.groundedIn,
            domain: args.domain,
            goalId: activeGoal && activeGoal.id,
            milestoneId: activeGoal && activeGoal.milestoneId,
            kind: 'generated',
            agentId: agentId,
            createdBy: 'agent:' + agentId
          }, now());
          if (!r || r.ok === false) return { content: (r && r.error) ? r.error : 'could not mint quest', summary: 'rejected' };
          if (runId) {
            mintsByRun.set(runId, (mintsByRun.get(runId) || 0) + 1);
            if (mintsByRun.size > MINT_RUNS_CAP) { const oldest = mintsByRun.keys().next().value; mintsByRun.delete(oldest); }   // FIFO evict the oldest run
          }
          return { content: 'Minted quest ' + r.id + '. It is now live in the Commander\'s QUEST LOG.', summary: 'minted ' + r.id };
        }

        return { content: 'Unknown op "' + op + '". Use one of: ' + OPS.join(', ') + '.', summary: 'noop' };
      }
    };

    return { questUpdateTool: questUpdateTool, register(reg) { reg.register(questUpdateTool); return reg; } };
  }

  return { makeQuestTools: makeQuestTools };
});
