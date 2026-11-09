/* node test/aux-effort.test.js — the station's REASON-ONLY aux work stops paying for hidden thinking.

   Measured live (isolated station, anthropic/claude-haiku-4.5 on OpenRouter, the default aux budget, a scripted
   10-turn session): 47% of the session's spend was internal/aux work, and almost all of an aux call's OUTPUT was
   reasoning the Commander never sees — every aux call inherited the chat's effort (medium):
     • a session title: 494 output tokens, 483 of them reasoning, for a 4-word title (9 tokens at 'none');
     • a reflection pass: 430 output / 401 reasoning for the SAME one-line PREFERENCE it wrote at 'none' in 24;
     • a goal plan: ~6.8k output tokens, 63 s; a session-ideas pass ran into its own 45 s deadline and was thrown away.
   'low' is no cure on that route (626 output / 617 reasoning for the same title: Anthropic's thinking budget has a floor).

   Laws under test:
     • AuxGovernor.pickAuxEffort takes the LOWEST effort the provider lists for the model (none > minimal > low), and
       makes no override when it lists none or no low tier. OpenRouter's list is a guess until the endpoint refuses a
       rung; that refusal heals in the adapter (test/openrouter-effort-heal.test.js);
     • the post-run passes and INTERNAL runs read that pick (auxPassEffort); compaction keeps auxReasoningEffort
       (a fold is the Commander's own task context, not station self-talk) — source locks, index.js is not loadable;
     • an operator who configured the aux tier gets their configured effort, through the same clamp as every background
       effort (AuxGovernor.clampEffort: the asked rung, else the nearest above, else below);
     • an internal run that must keep the Commander's effort says keepEffort, end to end: the autopilot's draft and its
       self-critique (work they read), a plan they asked for, the goal loop's done/continue judge, and the WAKE
       preflight (it must prove the path the awakening uses). Proactive self-talk (titles, ideas, the goal-arc
       decomposition, candidates) stays on the aux effort;
     • runAgentLoop carries a per-run reasoningEffort onto every request, and a run without one is byte-identical. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const G = require('../sidecar/auxgovernor.js');

// ---- the pure pick ----
A.eq(G.pickAuxEffort(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']), 'none', 'OpenRouter reasoning model: no thinking at all');
A.eq(G.pickAuxEffort(['minimal', 'low', 'medium', 'high']), 'minimal', 'a model whose floor is minimal gets minimal');
A.eq(G.pickAuxEffort(['low', 'medium', 'high']), 'low', 'adaptive-thinking Claude (native wire) gets its lowest: low');
A.eq(G.pickAuxEffort(['none']), 'none', 'a non-reasoning model: none (the adapter sends no reasoning field for it)');
A.eq(G.pickAuxEffort(['medium', 'high']), null, 'no low tier offered: no override (the provider default stands)');
A.eq(G.pickAuxEffort([]), null, 'an empty list: no override');
A.eq(G.pickAuxEffort(null), null, 'no list at all: no override');
A.eq(G.pickAuxEffort(['HIGH', 'Low']), null, 'only exact effort ids count (the providers normalize before listing)');

// ---- the effort a run is RECORDED on is the one it ran on (truthful telemetry): the adapter says what its request carried
//      (provider.effortAsSent; a refused pick healed mid-run is named as resent: test/effort-as-sent, openrouter-effort-heal),
//      so the governor keeps no second guess of the adapter's heal order ----
A.ok(!('effortAsRan' in G), 'no re-derived record clamp: the record is the adapter\'s own word for the wire');

// ---- THE ONE CLAMP (W1.5): a background effort is the asked rung, else the nearest one above, else below ----
A.eq(G.clampEffort('low', ['low', 'medium', 'high']), 'low', 'a listed rung is itself');
A.eq(G.clampEffort('low', ['minimal', 'medium', 'high']), 'medium', 'an unlisted rung clamps UP first: never thinner than asked');
A.eq(G.clampEffort('low', ['none', 'minimal']), 'minimal', 'nothing above: the nearest below');
A.eq(G.clampEffort('low', []), null, 'an empty list: no override');
A.eq(G.clampEffort('low', null), null, 'no list: no override');
A.eq(G.clampEffort('turbo', ['low']), null, 'an unknown ask: no override');
A.eq(G.clampEffort('low', ['HIGH', 'Low']), null, 'only exact effort ids count');
// pickAuxEffort is that clamp from the bottom, kept at or below low (its asserts above are unchanged)
A.ok(/clampEffort\(AUX_EFFORT_LADDER\[0\], allowed\)/.test(fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'auxgovernor.js'), 'utf8')), 'pickAuxEffort goes through clampEffort');
// ---- the background TOOL loops (skill review, curator): low, clamped, never above a run effort the list holds ----
A.eq(G.LOOP_EFFORT, 'low', 'the loop effort is low');
A.eq(G.loopEffort(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'high'), 'low', 'a high run\'s review runs low');
A.eq(G.loopEffort(['low', 'medium', 'high', 'xhigh', 'max'], 'cli-default'), 'low', 'claude-cli (its rungs start at low): low, whatever the run got');
A.eq(G.loopEffort(['none', 'minimal', 'low', 'medium', 'high'], 'minimal'), 'minimal', 'a /fast run\'s review stays minimal: a loop never goes above a run effort the list holds');
A.eq(G.loopEffort(['low', 'medium', 'high', 'xhigh'], 'none'), 'low', 'a run below every listed rung (Codex gpt-5.5 at none, sent as none): its loop gets the lowest listed rung, low, above that run');
A.eq(G.loopEffort(['none', 'minimal', 'low', 'medium', 'high'], 'none'), 'none', 'a run with no thinking: its loop has none either');
A.eq(G.loopEffort(['medium', 'high'], 'high'), 'medium', 'no low rung: the nearest above it (the lowest the model has)');
A.eq(G.loopEffort(['medium', 'high'], 'minimal'), 'medium', 'below every rung: the model\'s lowest, never nothing');
A.eq(G.loopEffort(['low', 'medium', 'high'], 'high', 'medium'), 'medium', 'a configured STARNET_AUX_EFFORT is the ask');
A.eq(G.loopEffort(null, 'high'), null, 'no list: no override (the provider default)');

// ---- the composition root wires it (source locks) ----
const idx = readSidecarSource();
const fnSrc = A.fnBody(idx, 'function auxPassEffort(');
A.ok(/AUX_EFFORT/.test(fnSrc) && /resolveAuxModel\(\)/.test(fnSrc) && /return auxReasoningEffort\(provider, model\)/.test(fnSrc),
  'auxPassEffort: a configured aux tier (STARNET_AUX_EFFORT / STARNET_AUX_MODEL) keeps exactly auxReasoningEffort');
// (W1.5 review) the configured tier goes through THE ONE CLAMP: a configured minimal on a route with no minimal runs at low
// there (the quest refresh, the post-run passes, compaction), exactly as the background loops clamp it
A.ok(/return AuxGovernor\.clampEffort\(normalizeReasoningEffort\(effortEnv \|\| 'low'\), providerEfforts\(provider, model\)\);/.test(A.fnBody(idx, 'function auxReasoningEffort(')),
  'auxReasoningEffort: the configured effort, clamped to the provider\'s rungs (AuxGovernor.clampEffort), never an exact match or nothing');
A.ok(/providerEfforts\(provider, model\)/.test(fnSrc) && /AuxGovernor\.pickAuxEffort\(/.test(fnSrc) && /provider\.reasoningEfforts\(model\)/.test(A.fnBody(idx, 'function providerEfforts(')),
  'auxPassEffort: unconfigured, it picks from the levels the provider lists for that model');
A.ok(/const _auxEffort = _auxDone \? auxPassEffort\(provider, _auxModel\) : null;/.test(idx), 'reflection · study · thread-mine · scout ride auxPassEffort');
A.ok(/const _auxFailEffort = _auxFail \? auxPassEffort\(provider, _auxFailModel\) : null;/.test(idx), 'failure review rides auxPassEffort');
A.ok(/reasoningEffort: internalEffort \|\| undefined,/.test(idx), 'and hands it to the loop (absent for every other run)');
// (effort truth, W1.12) the record reads ONE resolver: what the provider was given, read after the run
A.ok(/const effortRan = \(\) => effortAsRun\(provider, model, internalEffort, \{ tools: o\.outputOnly \? \[\] : toolDefs, isTask: internal \? undefined : isTask \}\);/.test(idx),
  'after the run, the effort is read through effortAsRun from the adapter the run ended on (a mid-run heal moved it; claude-cli without one ran on its default)');
const asRun = A.fnBody(idx, 'function effortAsRun(');
A.ok(/provider\.effortAsSent\(model, sent \|\| undefined, req\)/.test(asRun) && !/cliEffortAsSent|effortAsRan|built/.test(asRun),
  'effortAsRun: the adapter\'s own word for what its request carried (claude-cli: its argv), never the dial it was built with');
A.ok(/effortOf: \(provider, req\) => effortAsRun\(provider, req && req\.model, req && req\.reasoningEffort, req\)/.test(idx),
  'every aux meter row reads the same resolver, with the request it metered');
A.ok(/reasoningEffort: effortRan\(\), unmetered:/.test(idx) && /result\.reasoningEffort = effortRan\(\);/.test(idx),
  'the run record and the result carry the effort the run ran on');
A.ok(!/internalEffort \|\| reasoningEffort/.test(idx), 'no record keeps the pre-heal pick');
// …except an internal run whose reply IS work the Commander reads (the autopilot's desk draft + its self-critique):
// it keeps the Commander's effort. Opt-out is explicit, end to end: page -> /api/run body -> runOnce.
A.ok(/const internalEffort = o\.internal && !o\.keepEffort \? auxPassEffort\(provider, model\) : null;/.test(idx), 'an INTERNAL self-talk run picks the aux effort for its own model (o.internal, never an /v1 outputOnly repair); a work-product one keeps the Commander effort');
A.ok(/const keepEffort = !!\(internal && body && body\.keepEffort === true\);/.test(idx) && /internal, evidence, keepEffort,/.test(idx), 'handleRun reads keepEffort (only beside internal) and hands it to runOnce');
const harness = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'harness.js'), 'utf8');
A.ok(/if \(internal && keepEffort\) reqBody\.keepEffort = true;/.test(harness), 'Harness.chat forwards keepEffort only on an internal run');
const ap = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'autopilotstore.js'), 'utf8');
A.ok(/buildDoDirective\(sel\.selected, \{ name \}\) \}\], agentId: 'agent', isTask: false, placed: \[\], internal: true, keepEffort: true \}/.test(ap), 'the autopilot DRAFT run is a work product');
A.ok(/buildCritiqueDirective\(deliverable, sel\.selected, \{ style, standingOrders \}\) \}\], agentId: 'agent', isTask: false, placed: \[\], internal: true, keepEffort: true \}/.test(ap), 'its self-critique (which can rewrite the draft) is a work product');
A.ok(/buildCandidateDirective\(\{ beliefs, eligible \}\) \}\], agentId: 'agent', isTask: false, placed: \[\], internal: true \}/.test(ap), 'its candidate list stays strict-format self-talk (aux effort)');
const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
A.ok(/content: 'Reply with exactly: OK' \}\], agentId: 'agent', isTask: false, placed: \[\], internal: true, keepEffort: true \}/.test(A.fnBody(app, 'async function preflightWire(')),
  'the WAKE preflight keeps the Commander effort: it proves the path the awakening runs on, not the aux one');
const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
A.ok(/const usr = GoalLoop\.judgeUser\([^\n]*\n[^\n]*\n\s*const res = await Harness\.chat\(\{ system: sys, [^\n]*internal: true, keepEffort: true \}\);/.test(chatSrc),
  'the goal loop JUDGE keeps the Commander effort (a wrong DONE ends their loop)');
const goals = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'goalstore.js'), 'utf8');
A.ok(/isTask: false, placed: \[\], internal: true, evidence: true, keepEffort: true,\n\s*messages: \[\{ role: 'user', content: 'Help me shape this ambition/.test(goals),
  'a plan the Commander asked for (suggestPlan) keeps their effort');
A.ok(/const directive = Goals\.buildDirective\(belief\.text\);[\s\S]{0,800}?agentId: 'agent', isTask: false, placed: \[\], internal: true, evidence: true \}\);/.test(goals),
  'the proactive goal-arc decomposition stays on the aux effort');
A.ok(/auxEffortFor: auxReasoningEffort,/.test(idx), 'compaction keeps auxReasoningEffort (the Commander\'s task context)');
// the measured session's skill-review spend row carried no model ("(unknown)" in the breakdown): every aux spend row names it
A.ok(/ledger\.record\(\{ runId: reviewRunId, [^}]*model: model \|\| '',/.test(idx), 'the skill review spend row names the model it spent on');
A.ok(/ledger\.record\(\{ runId: curatorRunId, [^}]*model: model \|\| '',/.test(idx), 'the skill curator spend row names the model it spent on');
// (W1.5) both loops run on the one loop effort and their rows name the effort as it ran
for (const fn of ['async function runBackgroundSkillReview(', 'async function runSkillCurator(']) {
  const src = A.fnBody(idx, fn);
  A.ok(/const effort = auxLoopEffort\(o, provider, model\);/.test(src) && /trigger: 'event', reasoningEffort: effort\.sent\n/.test(src)
    && /ledger\.record\(\{[^}]*model: model \|\| '', reasoningEffort: effort\.ran\(\), /.test(src), fn + ' runs on auxLoopEffort and records it as it ran');
}
const loopFx = A.fnBody(idx, 'function auxLoopEffort(');
A.ok(/AuxGovernor\.loopEffort\(providerEfforts\(provider, model\), o && o\.runEffort,/.test(loopFx)
  && /ran: \(\) => effortAsRun\(provider, model, sent\)/.test(loopFx),
  'auxLoopEffort reads the provider\'s rungs for the loop model, and its row reads effortAsRun after the loop');
A.ok((idx.match(/runEffort: reasoningEffort, cost,/g) || []).length === 3, 'the review, the verdict stash and the curator carry the run\'s effort');
A.ok(/const questEffort = auxPassEffort\(provider, model\);[^\n]*\n\s*if \(questEffort\) req\.reasoningEffort = questEffort;/.test(A.fnBody(idx, 'async function runQuestRefreshCycle(')), 'the quest refresh rides the aux effort');

// ---- the loop carries a per-run effort onto every request; absent = byte-identical ----
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const priceOf = () => ({ in: 1, out: 2 });
function recorder() {
  const reqs = [];
  return { reqs, provider: { async *stream(req) { reqs.push(req); yield { type: 'text', delta: 'Short Title Here' }; yield { type: 'done', finishReason: 'stop' }; }, priceOf, contextLimit: () => 8000 } };
}
async function run(extra) {
  const r = recorder();
  const bus = A.makeBus();
  await runAgentLoop(Object.assign({
    messages: [{ role: 'system', content: 'Reply with a title.' }, { role: 'user', content: 'name this' }],
    provider: r.provider, emit: makeEmitter(bus, () => {}), cost: makeCostEngine({ priceOf }), model: 'm', agentId: 'a', runId: 'r',
    tools: [], limits: { maxIters: 2, grace: false, verifyOnStop: false },
    dispatch: async () => ({ ok: true, content: '' }), capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' }
  }, extra || {}));
  return r.reqs;
}
(async () => {
  const withEffort = await run({ reasoningEffort: 'none' });
  A.ok(withEffort.length >= 1 && withEffort.every(q => q.reasoningEffort === 'none'), 'a per-run reasoningEffort rides every model request of that run');
  const plain = await run();
  A.ok(plain.length >= 1 && plain.every(q => !('reasoningEffort' in q)), 'a run without one sends no per-request effort (the provider default, byte-identical)');
  A.report('aux-effort.test');
})().catch(e => { console.error(e); process.exit(1); });
