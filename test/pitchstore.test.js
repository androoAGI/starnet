/* node test/pitchstore.test.js — the browser wiring around the First Pitch engine (frontend/app/pitchstore.js).
   pitchstore.js is glue (bus hook + model call + Dialogue beat + build routing); its DECISIONS live in the pure
   pitch.js (tested separately). This test fakes the globals it talks to (U.bus / Harness / Dialogue /
   DossierStore / Recipes / localStorage) — with shapes that match the REAL APIs so a green test means a green
   browser — and locks the wiring promises deterministically:
     - subscribes read-only to agent.run.end (never emits); the real emit→onRunEnd→fire path is exercised
     - the gate fires only for a clean, hero, non-onboarding, non-intake, dialogue-closed, knows-enough run, once
     - it runs the directive as a REASON-ONLY call (placed:[], isTask:false) on the live system prompt
     - it renders the confident beat and routes "build it" into a real run: a fully-runnable recipe launches; a
       recipe that still needs its gap (or an unknown recipe) becomes the gap-asking directive — never an empty template
     - a model error / unparseable reply degrades gracefully and stays un-pitched so a later run can retry
     - the fire-once flag round-trips through localStorage (survives reload); reset() re-arms for a new hero */
'use strict';
const A = require('./_assert.js');

// real pure engine (we want the integration, not a fake of it) + fakes for everything browser-only.
global.Pitch = require('../frontend/app/pitch.js');

// in-memory localStorage so the self-persist round-trip is actually exercised (Node has none).
const mem = {};
global.localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }
};

const bus = A.makeBus();
global.U = { bus };

let knownDims = ['goals', 'identity'];
global.DossierStore = { summary: () => ({ known: knownDims, blank: [] }) };

// V3 §6: the shared readiness gate. The store reads UnderstandingStore.readiness() FAIL-CLOSED (no read = no
// pitch), so the fake mirrors the real API shape; tests flip `readyState` to drive the gate.
let readyState = { ready: true, reasons: [] };
global.UnderstandingStore = { readiness: () => readyState };

// recipe fakes shaped like the REAL Recipes API: get() returns null for an unknown id; a recipe can carry
// required params; requiredMissing() reports which required params lack a value (mirrors recipes.js).
global.Recipes = {
  list: () => [
    { id: 'morning-brief', name: 'Morning Brief', tagline: 'daily digest', task: 'Brief me on {topic}.' },
    { id: 'quick-note', name: 'Quick Note', task: 'Jot a quick note.' }
  ],
  get: (id) => ({
    'morning-brief': { id: 'morning-brief', name: 'Morning Brief', task: 'Brief me on {topic}.', params: [{ key: 'topic', required: true }] },
    'quick-note': { id: 'quick-note', name: 'Quick Note', task: 'Jot a quick note.', params: [] }
  })[id] || null,
  requiredMissing: (r, v) => (r && r.params ? r.params.filter(p => p.required && !((v || {})[p.key] && String((v || {})[p.key]).trim())).map(p => p.key) : [])
};

const dlg = {
  opened: 0, said: [], noded: 0, closed: 0, _open: false, nextChoice: { value: 'build' }, lastNode: null,
  open() { this._open = true; this.opened++; },
  say(s) { this.said.push(String(s)); return Promise.resolve(); },
  node(cfg) { this.noded++; this.lastNode = cfg; return Promise.resolve(this.nextChoice); },
  close() { this._open = false; this.closed++; },
  isOpen() { return this._open; }
};
global.Dialogue = dlg;

const hn = { calls: [], next: { text: '' }, chat(args) { this.calls.push(args); return Promise.resolve(this.next); } };
global.Harness = hn;

let launchedRecipe = null, launchedDirective = null, recentTaskArg = '__unset__';
const SYSTEM = 'SYSTEM PROMPT\nWHAT YOU KNOW ABOUT YOUR COMMANDER: goals — ship the dossier.';
const deps = {
  getSystem: () => SYSTEM,
  getName: () => 'NOVA',
  getCaps: () => [{ id: 'computer', label: 'run code' }],
  getRecentTask: (runId) => { recentTaskArg = runId; return 'wrote a hello file'; },   // capture the runId fire() threads in (#18)
  launchRecipe: (r) => { launchedRecipe = r; },
  launchDirective: (t) => { launchedDirective = t; }
};

const { PitchStore } = require('../frontend/app/pitchstore.js');

const tick = ms => new Promise(r => setTimeout(r, ms));
function clearFakes() {
  hn.calls = []; dlg.opened = dlg.noded = dlg.closed = 0; dlg.said = []; dlg._open = false; dlg.nextChoice = { value: 'build' };
  launchedRecipe = null; launchedDirective = null;
}

/* ---------- init: subscribes read-only to the bus ---------- */
PitchStore.init(deps);
A.ok(bus._h['agent.run.end'] && bus._h['agent.run.end'].length === 1, 'init subscribes exactly one agent.run.end listener');

/* ---------- the gate (decide) — sync, side-effect free ---------- */
A.eq(PitchStore._decide({ reason: 'error', agentId: 'agent' }).go, false, 'a failed run never pitches');
A.eq(PitchStore._decide({ reason: 'done', agentId: 'worker-2' }), { go: false, reason: 'not-hero' }, 'only the hero pitches');
A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent' }), { go: true, reason: 'ready' }, 'a clean hero run that knows enough → pitch');

knownDims = ['identity', 'stack'];
A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent' }), { go: false, reason: 'missing:goals' }, 'cannot pitch without knowing the goal');
knownDims = ['goals', 'identity'];

/* ---------- V3 §6: the shared readiness gate, wired through decide ---------- */
readyState = { ready: false, reasons: ['no-direction'] };
A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent' }), { go: false, reason: 'not-ready:no-direction' }, 'a shut readiness gate structurally blocks the pitch (with the honest reason)');
const savedUS = global.UnderstandingStore;
global.UnderstandingStore = undefined;
A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent' }).reason, 'not-ready:no-readiness-read', 'no readiness read = FAIL-CLOSED (a station that cannot prove readiness never advises)');
global.UnderstandingStore = savedUS;
readyState = { ready: true, reasons: [] };

dlg._open = true;
A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent' }), { go: false, reason: 'dialogue-open' }, 'never stomps an open Dialogue (awakening/tutorial)');
dlg._open = false;

global.Onboarding = { isRunning: () => true };
A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent' }), { go: false, reason: 'onboarding' }, 'never fires during the awakening');
global.Onboarding = undefined;

global.Intake = { isRunning: () => true };
A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent' }), { go: false, reason: 'intake' }, 'never fires while the intake interview runs');
global.Intake = undefined;

// the live gate degrades gracefully if the dossier model is absent (no summary → too-cold, never a crash)
const _ds = global.DossierStore;
global.DossierStore = undefined;
A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent' }), { go: false, reason: 'missing:goals' }, 'no dossier yet → stays quiet (missing goals), never throws');
global.DossierStore = _ds;

/* ---------- the not-task gate (#17): only a REAL task graduates the agent, never casual chat ---------- */
deps.wasTaskRun = (runId) => runId === 'task-run';   // app.js injects this, backed by Chat's run-meta ledger
A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent', runId: 'chat-run' }), { go: false, reason: 'not-task' }, 'a casual chat run (not a task) never fires the First Pitch');
A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent', runId: 'task-run' }), { go: true, reason: 'ready' }, 'a genuine task run passes the gate');
delete deps.wasTaskRun;   // restore back-compat (dep absent → check skipped) so the fire-path tests below are unaffected
A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent' }), { go: true, reason: 'ready' }, 'with no wasTaskRun dep wired the gate is skipped (back-compat)');

(async () => {
  try {
    /* ---------- fire: a fully-runnable recipe (no required params) launches the recipe ---------- */
    clearFakes(); PitchStore.reset();
    hn.next = { text: 'PITCH: a quick standup note\nWHY: matches your goal\nBUILD: recipe:quick-note\nGAP: none' };
    dlg.nextChoice = { value: 'build' };
    await PitchStore._fire();

    A.eq(hn.calls.length, 1, 'fire makes exactly one model call');
    const call = hn.calls[0];
    A.eq(call.system, SYSTEM, 'the call uses the LIVE system prompt (which carries the dossier block)');
    A.eq(call.isTask, false, 'the pitch is a reason-only call (isTask:false)');
    A.eq(call.placed, [], 'the pitch call gets NO capabilities (placed:[]) — it cannot touch tools');
    A.eq(call.agentId, 'agent', 'the pitch runs as the hero');
    A.eq(call.internal, true, 'the pitch is flagged internal → harness.js suppresses its run.start/end bus re-emit (the self-talk never counts as a shipped task in XP/quests/throughput)');
    const directive = call.messages[0].content;
    A.ok(/PITCH:/.test(directive) && directive.indexOf('recipe:morning-brief') >= 0, 'the directive carries the strict format + the real recipe shelf');
    A.ok(directive.indexOf('run code') >= 0, 'the directive lists the agent\'s real capabilities');
    A.ok(directive.indexOf('wrote a hello file') >= 0, 'the directive references the task just completed');

    A.ok(dlg.opened >= 1 && dlg.said.length >= 1, 'it opens the Dialogue and speaks a lead-in beat');
    A.eq(dlg.noded, 1, 'it renders exactly one choice node');
    A.eq(dlg.lastNode.options.length, 2, 'the beat offers the confident single pitch — two options, never a menu');
    A.eq(PitchStore._state().pitched, true, 'a delivered pitch sets the fire-once flag');
    A.ok(dlg.closed >= 1, 'the Dialogue is closed after the choice');
    A.ok(launchedRecipe && launchedRecipe.id === 'quick-note', 'a fully-runnable recipe is launched directly (no dead gap)');
    A.eq(launchedDirective, null, 'a runnable recipe build does not also send a raw directive');
    A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent' }), { go: false, reason: 'already-pitched' }, 'the First Pitch fires once, ever');

    /* ---------- fire: a recipe that still needs its gap → the gap-asking directive (NOT an empty template) ---------- */
    clearFakes(); PitchStore.reset();
    hn.next = { text: 'PITCH: a daily brief\nBUILD: recipe:morning-brief\nGAP: which repo to watch' };
    dlg.nextChoice = { value: 'build' };
    await PitchStore._fire();
    A.eq(launchedRecipe, null, 'a recipe with an unfilled required param is NOT launched as an empty template');
    A.ok(launchedDirective && launchedDirective.indexOf('which repo to watch') >= 0, 'instead the build directive asks for the gap (the required value) — making it theirs');

    /* ---------- fire: an unknown/hallucinated recipe id → graceful directive, never a broken build ---------- */
    clearFakes(); PitchStore.reset();
    hn.next = { text: 'PITCH: a thing\nBUILD: recipe:ghost-recipe\nGAP: the detail' };
    dlg.nextChoice = { value: 'build' };
    await PitchStore._fire();
    A.eq(launchedRecipe, null, 'an unknown recipe id launches no recipe');
    A.ok(launchedDirective && launchedDirective.indexOf('a thing') >= 0, 'an unknown recipe falls through to a real directive run (no dead gap)');

    /* ---------- fire: workflow build (no recipe) routes to a directive ---------- */
    clearFakes(); PitchStore.reset();
    hn.next = { text: 'PITCH: a custom invoice sorter\nWHY: you do it by hand\nBUILD: workflow\nGAP: where the invoices live' };
    dlg.nextChoice = { value: 'build' };
    await PitchStore._fire();
    A.eq(launchedRecipe, null, 'a workflow pitch does not launch a recipe');
    A.ok(launchedDirective && launchedDirective.indexOf('a custom invoice sorter') >= 0, 'a workflow build sends a real directive (run starts immediately)');
    A.ok(launchedDirective.indexOf('where the invoices live') >= 0, 'the build directive asks for the one gap');

    /* ---------- fire: "something else" closes gracefully, still fires-once ---------- */
    clearFakes(); PitchStore.reset();
    hn.next = { text: 'PITCH: x\nBUILD: workflow' };
    dlg.nextChoice = { value: 'other' };
    await PitchStore._fire();
    A.eq(launchedRecipe, null, '"something else" launches nothing');
    A.eq(launchedDirective, null, '"something else" sends no directive');
    A.eq(PitchStore._state().pitched, true, 'declining still spends the one-time pitch (anti-nag)');
    A.ok(dlg.closed >= 1, 'the panel closes after declining');

    /* ---------- graceful degradation: model error / unparseable reply stays un-pitched (retry later) ---------- */
    clearFakes(); PitchStore.reset();
    hn.next = { error: true, text: '' };
    await PitchStore._fire();
    A.eq(PitchStore._state().pitched, false, 'a model error does NOT burn the pitch — a later run can retry');
    A.eq(dlg.noded, 0, 'no choice node is rendered on a model error');
    A.ok(dlg.closed >= 1, 'the panel is cleaned up after a model error');

    clearFakes(); PitchStore.reset();
    hn.next = { text: 'sorry, I have no idea' };
    await PitchStore._fire();
    A.eq(PitchStore._state().pitched, false, 'an unparseable reply does not burn the pitch');
    A.eq(dlg.noded, 0, 'no beat is shown when there is no usable pitch');

    /* ---------- integration: a real agent.run.end emit drives onRunEnd → fire (the wiring, not just decide) ---------- */
    clearFakes(); PitchStore.reset();
    hn.next = { text: 'PITCH: y\nBUILD: workflow' };
    dlg.nextChoice = { value: 'other' };
    recentTaskArg = '__unset__';
    bus.emit('agent.run.end', { reason: 'done', agentId: 'agent', runId: 'R-42' });
    await tick(10);
    A.eq(hn.calls.length, 1, 'emitting agent.run.end actually runs the pitch (onRunEnd → fire)');
    A.eq(recentTaskArg, 'R-42', 'fire() threads the ENDED run\'s runId into getRecentTask (#18 — names the right run, not the displayed stream)');

    clearFakes(); PitchStore.reset();
    dlg._open = true;   // an open Dialogue must block a real emit, not just a direct decide()
    bus.emit('agent.run.end', { reason: 'done', agentId: 'agent' });
    await tick(10);
    A.eq(hn.calls.length, 0, 'an open Dialogue blocks the pitch on a real emit');
    dlg._open = false;

    /* ---------- fire-once persists through localStorage (survives a reload) ---------- */
    clearFakes(); PitchStore.reset();
    hn.next = { text: 'PITCH: persist me\nBUILD: workflow' };
    dlg.nextChoice = { value: 'other' };
    await PitchStore._fire();
    A.ok(mem['starnet.pitch.v1'] && JSON.parse(mem['starnet.pitch.v1']).pitched === true, 'a delivered pitch persists to its own localStorage key (no save.js)');
    PitchStore.init(deps);   // simulate a page reload
    A.eq(PitchStore._state().pitched, true, 'a fresh init hydrates the persisted fire-once flag (survives reload)');
    A.eq(PitchStore._decide({ reason: 'done', agentId: 'agent' }), { go: false, reason: 'already-pitched' }, 'the persisted flag blocks a re-pitch after reload');

    /* ---------- reset re-arms for a brand-new hero ---------- */
    PitchStore.reset();
    A.eq(mem['starnet.pitch.v1'], undefined, 'reset() removes the persisted key');
    PitchStore.init(deps);
    A.eq(PitchStore._state().pitched, false, 'after reset + reload the new hero re-earns the First Pitch');

    /* ---------- offerAtHandoff: the tutorial hands the stage over deliberately at its close ----------
       Same engine gate + earned-work honesty as the auto path; resolves true ONLY when a pitch beat was
       actually delivered, so the tour knows whether the pitch replaced its classic "yours to point" close. */
    clearFakes(); PitchStore.reset(); PitchStore.init(deps);
    A.eq(await PitchStore.offerAtHandoff('demo-run'), false, 'no wasTaskRun dep wired → the handoff offer REFUSES (stricter than the auto path — the tour must prove the run was real)');
    A.eq(hn.calls.length, 0, 'and makes no model call');

    deps.wasTaskRun = (runId) => runId === 'demo-run';
    PitchStore.init(deps);
    A.eq(await PitchStore.offerAtHandoff('chat-run'), false, 'a non-task run id never graduates at handoff');
    A.eq(await PitchStore.offerAtHandoff(null), false, 'a missing run id (skipped/failed demo) never graduates at handoff');
    A.eq(hn.calls.length, 0, 'refused offers reach no model');

    knownDims = ['identity', 'stack'];
    A.eq(await PitchStore.offerAtHandoff('demo-run'), false, 'a cold dossier (no goals) stays quiet at handoff too');
    knownDims = ['goals', 'identity'];

    hn.next = { text: 'PITCH: automate the weekly digest\nWHY: it eats your friday\nBUILD: workflow\nGAP: where the notes live' };
    dlg.nextChoice = { value: 'other' };
    A.eq(await PitchStore.offerAtHandoff('demo-run'), true, 'a real completed demo + a warm dossier → the pitch DELIVERS at handoff');
    A.eq(hn.calls.length, 1, 'the handoff offer runs exactly one reason-only call');
    A.eq(PitchStore._state().pitched, true, 'a delivered handoff pitch spends the one-time flag');
    A.eq(await PitchStore.offerAtHandoff('demo-run'), false, 'the handoff offer never double-fires (already-pitched)');

    clearFakes(); PitchStore.reset(); PitchStore.init(deps);
    hn.next = { error: true, text: '' };
    A.eq(await PitchStore.offerAtHandoff('demo-run'), false, 'a model hiccup at handoff resolves false (the tour falls back to its classic close)');
    A.eq(PitchStore._state().pitched, false, 'and the un-fired pitch stays ARMED for a later real task');
    delete deps.wasTaskRun;

    /* ---------- V3 B10: the interview-grabbed first move — armed, persisted, offered ONCE at the floor ---------- */
    {
      clearFakes(); PitchStore.reset(); PitchStore.init(deps);
      const nudges = [];
      global.Chat = { nudge: (text, chips, cb) => { nudges.push({ text, chips, cb }); }, isBusy: () => false, clearNudge() {} };
      PitchStore.armFirstMove('  draft your sponsor-brief replies each morning  ');
      A.eq(PitchStore._state().firstMove, 'draft your sponsor-brief replies each morning', 'armFirstMove trims + persists the grabbed move');
      readyState = { ready: false, reasons: ['no-direction'] };   // the grab outranks the gate — the Commander chose it
      A.eq(await PitchStore.offerStarter(), true, 'the armed first move is offered even below the readiness gate');
      A.eq(nudges.length, 1, 'exactly one nudge');
      A.ok(/the move you picked at my wake/.test(nudges[0].text), 'the nudge names the interview grab, never a generated guess');
      A.eq(hn.calls.length, 0, 'an armed move needs NO model call');
      A.eq(PitchStore._state().firstMove, undefined, 'the armed move is consumed on offer (one-shot)');
      nudges[0].cb({ value: 'run' });
      A.eq(launchedDirective, 'draft your sponsor-brief replies each morning', '"run it" launches the grabbed move as a real directive');
      A.eq(await PitchStore.offerStarter(), false, 'the floor never re-offers (starterDone spent)');
      readyState = { ready: true, reasons: [] };
      delete global.Chat;
    }

    // First-work handoff: proposals, edits and tour survive; only explicit Start dispatches.
    {
      PitchStore.reset();
      let sent = [], allow = false, next;
      const realNode = dlg.node;
      global.Chat = { isBusy: () => false, prefill: text => { next = text; } };
      const hd = { getPurpose: () => 'Learn to build my own game.', launchDirective: text => { sent.push(text); return allow; } };
      PitchStore.init(hd);
      PitchStore.armFirstMove('Build a game together');
      dlg.node = async cfg => {
        A.eq(cfg.customValue, 'Build a game together', 'selected interview proposal carries into first task');
        cfg.onCustomInput('Teach me collision detection; let me write the code.');
        return { value: 'tour' };
      };
      A.eq((await PitchStore.offerHandoff({ tour: true })).action, 'tour', 'tour can defer the first task');
      A.eq(sent.length, 0, 'opening and touring cannot start work');
      PitchStore.init(hd);
      A.eq(PitchStore.handoffPending(), true, 'pending handoff survives reload');
      dlg.node = async cfg => {
        A.eq(cfg.customValue, 'Teach me collision detection; let me write the code.', 'correction survives reload and replaces initial proposal');
        return { custom: true, value: cfg.customValue };
      };
      const pick = await PitchStore.offerHandoff();
      A.eq(sent.length, 0, 'review returns task before closing tutorial, without dispatch');
      A.eq(PitchStore.startHandoff(pick.task), false, 'failed dispatch does not finish handoff');
      A.eq(PitchStore.handoffPending(), true, 'failed launch stays resumable');
      A.eq(next, pick.task, 'failed launch restores exact task to composer');
      allow = true;
      A.eq(PitchStore.startHandoff(pick.task), true, 'explicit start routes into existing real task path');
      A.eq(sent.at(-1), pick.task, 'latest correction, not old proposal, goes to agent');
      A.eq(PitchStore.handoffPending(), false, 'dispatched task completes handoff');
      A.eq(await PitchStore.offerHandoff(), null, 'completed handoff does not repeat');
      PitchStore.reset(); PitchStore.init(hd);
      dlg.node = async cfg => {
        A.ok(cfg.lines[0].text.includes('Learn to build my own game.'), 'cold handoff references saved purpose');
        return { skip: true, value: 'explore' };
      };
      await PitchStore.offerHandoff();
      A.eq(PitchStore.handoffPending(), false, 'explore explicitly dismisses handoff');
      PitchStore.reset(); PitchStore.init(hd);
      let release;
      dlg.node = cfg => new Promise(resolve => { release = resolve; });
      const pending = PitchStore.offerHandoff();
      A.eq(await PitchStore.offerHandoff(), null, 'concurrent handoffs cannot open twice');
      PitchStore.reset(); PitchStore.init(hd);
      release({ custom: true, value: 'old agent task' });
      A.eq(await pending, null, 'reset cancels a stale handoff result');
      A.eq(PitchStore._state().handoffDraft, undefined, 'stale result cannot overwrite a new agent');
      dlg.node = realNode; delete global.Chat;
    }

    /* ---------- source-locks: tutorial.js wires the handoff honestly (browser IIFE — lock the source) ---------- */
    const tutSrc = require('fs').readFileSync(require('path').join(__dirname, '../frontend/app/tutorial.js'), 'utf8');
    A.ok(/PitchStore\.offerAtHandoff\b/.test(tutSrc), 'the tutorial handoff offers the First Pitch');
    A.ok(/cleanRunId\s*&&\s*typeof PitchStore/.test(tutSrc), 'the handoff offer is gated on a captured CLEAN run id');
    A.ok(/if\s*\(sawDeny\)[\s\S]{0,400}reason === 'done'[\s\S]{0,120}cleanRunId\s*=/.test(tutSrc),
      'cleanRunId is captured only on a clean done (the sawDeny branch is checked first — a denied demo never pitches)');
    A.ok(/const classicClose\s*=/.test(tutSrc) && /yours to point/.test(tutSrc),
      'the classic close survives as the fallback — the tour never stalls on a quiet pitch');

    A.report('pitchstore.test');
  } catch (e) {
    A.ok(false, 'unexpected throw: ' + (e && e.stack || e));
    A.report('pitchstore.test');
  }
})();
