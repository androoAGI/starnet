/* sidecar/granted-context.js — WHAT A DESK-GRANTED UNATTENDED RUN TAKES AS ITS INSTRUCTIONS (GHSA-2hpj NEW-1, 2026-11-09).

   A routine's unattendedGrants (the terminal, the accounts, the studio) are confirmed at the desk for the routine as it will
   run: its task, script, agent, folder, toolsets, skills, upstream routines, model, provider and endpoint (cron-store.js
   RUN_FIELDS, index.js grantDrive), each sealed. The review found what the desk had NOT bound still drove that run. The key
   GET / serves (any same-user program, or a command an agent ran) wrote the Commander dossier (POST /api/dossier) or the
   active goal (POST /api/goals), both folded into every routine's prompt as trusted Commander text, and the next fire of a
   desk-granted routine ran "echo dossier> DOSSIER_PWNED.txt" with the terminal grant it legitimately held. The same held for
   the agent's own instructions (POST /api/roster rewrites an ask-first agent's), the routine's skill bodies (POST
   /api/agent-skills/manage), the dock's standing brief (the floor save), memory, quests and the station's evidence notes.

   THE RULE. A run that carries desk-granted unattended capability takes as instructions only:
     - what the desk bound: the routine's own words (sealed), and the agent's own instructions and the routine's skills as
       they were when the desk said yes. Those two are bound into the grant (index.js routineDriveFor: grantDrive's fourth
       part, instructionsDigest below); a change drops the grants and the run says so, as a new model does;
     - what the host itself writes: the [ROUTINE] note, the tool and capability ground truth, the delivery and runtime notes,
       the project folder line, the station's shipped recipes.
   Everything else the client key can rewrite over HTTP without the desk is LEFT OUT of such a run (INPUTS, below). Not
   fenced, not tainted: a taint would end every grant on any station that has a dossier, and a fence cannot stop text from
   steering a capability the run already holds (the review: the capability is granted, the attacker only redirects its use).

   WHO COUNTS (grantedRun). A run whose routine grants are still held after the drive check (index.js runOnceCore: never an
   interactive run, never one whose model, endpoint, instructions or skills moved). Workers and line hops a granted routine
   starts carry no grants (the chain-grants law), so they are not granted runs. The agent's approval posture does not
   change the answer, and turning it over does not move the instructions (instructionsOf leaves the page's approval line
   out): a Full Access agent's routine that holds grants is a granted run too (one rule the Commander can
   read in SCHEDULES: a routine allowed to run unattended works from its own words). A Full Access or FULL BYPASS agent's
   routine WITHOUT grants keeps the dossier and goal; such an agent already runs whatever anyone holding the client key asks
   it (POST /api/run, card-free), which is the Full Access contract, unchanged here.

   INPUTS is the census: every input runOnceCore folds into a run's context, whether the client key can write it over HTTP
   without the desk, and what a granted run does with it. test/granted-context.census.test.js holds runOnceCore's prompt
   assembly to this list: a new block that is not listed here fails it, and so does a 'withheld' one a granted run still
   receives. Pure: no clock, no fs. */
'use strict';
const crypto = require('node:crypto');
const LearnedTail = require('./learned-tail.js');
const FileBytes = require('./skills/file-bytes.js');

// what a granted run does with an input
//   sealed   — part of what the desk confirmed (cron-store RUN_FIELDS, sealed in cron.jobs.json): a change drops the grants
//   bound    — confirmed with the grant through grantDrive (instructionsDigest): a change drops the grants at the next run
//   host     — written by StarNet itself (constants, tool ground truth, labels the host derives); no client-key text in it
//   taint    — the run starts tainted, so the grants are revoked before any tool runs
//   withheld — left out of a granted run
const INPUTS = Object.freeze([
  // the run's own words and identity
  { id: 'routine-prompt', vars: ['messages'], client: false, granted: 'sealed', how: 'the routine\'s prompt (RUN_FIELDS + cron.jobs.json seal); a client-key edit drops the grants' },
  { id: 'upstream-context', vars: [], client: true, granted: 'taint', how: 'contextFrom: other routines\' output rides the prompt and the run starts tainted (initialTaint)' },
  { id: 'agent-instructions', vars: ['persona.stable'], client: true, granted: 'bound', how: 'POST /api/roster rewrites an ask-first agent\'s instructions; bound into grantDrive, a change drops the grants' },
  { id: 'routine-skills', vars: ['preloadedSkillBlock'], client: true, granted: 'bound', how: 'POST /api/agent-skills/manage rewrites a skill body; the routine\'s skills are bound into grantDrive and a body that moved is not loaded' },
  { id: 'persona-learned-tail', vars: ['persona.learned'], client: true, granted: 'withheld', how: 'the dossier, goal and fork blocks the page bakes into a roster persona (POST /api/roster)' },
  { id: 'persona-crew-line', vars: [], client: true, granted: 'withheld', how: 'the YOUR CREW line the page bakes into a lead\'s persona (agent names and roles, POST /api/roster)' },
  { id: 'persona-approval-line', vars: [], client: true, granted: 'withheld', how: 'the APPROVAL / AUTHORITY line the page bakes into a persona from its approval posture (POST /api/roster); what a run may do is the grant and the consent broker, and the host\'s capabilities note says when FULL POWER is active' },
  { id: 'commander-dossier', vars: [], client: true, granted: 'withheld', how: 'POST /api/dossier; cronSystemFor/personaWithNote (withDossier) and commanderEvidenceContext fold it in' },
  { id: 'active-goal', vars: [], client: true, granted: 'withheld', how: 'POST /api/goals; folded in beside the dossier' },
  { id: 'standing-brief', vars: [], client: true, granted: 'withheld', how: 'the dock\'s standing brief in the saved floor (POST /api/save); the routine callers append it to the system' },
  { id: 'project-house-rules', vars: [], client: false, granted: 'withheld', how: 'AGENTS.md / CLAUDE.md / .cursorrules in the routine\'s folder: files any same-user process or command can write (not HTTP)' },
  // the per-run context note
  { id: 'station-evidence', vars: ['stationEvidenceBlock', 'evidenceBlock'], client: true, granted: 'withheld', how: 'topics, open threads, recent activity, POST /api/scout/context worksignal, POST /api/growth/ratings verdicts, track record' },
  { id: 'task-context', vars: ['taskBriefContext', 'taskIntentNote', 'taskContextBlock'], client: true, granted: 'withheld', how: 'commanderEvidenceContext (dossier + goal + evidence) for a task run, also handed to its workers (taskContext / getTaskContext)' },
  { id: 'delegated-context', vars: ['delegatedBlock'], client: true, granted: 'withheld', how: 'the [TASK CONTEXT] a lead hands a worker it dispatches (orchestration.js workerPrompt, cost lane W1.10): the lead\'s brief, Commander evidence, recall and taste from getTaskContext; only host code sets it, a granted lead hands none and a worker carries no grants, left out all the same' },
  { id: 'recalled-memory', vars: ['recall.text'], client: true, granted: 'withheld', how: 'the agent\'s notebook, the Commander\'s taste and standing notes (POST /api/notebook/restore, /api/growth/ratings/correction, /api/taste/keep-style)' },
  { id: 'runtime-skill-index', vars: ['runtimeSkillBlock'], client: true, granted: 'withheld', how: 'the agent\'s saved skills by name and summary (POST /api/agent-skills/manage)' },
  { id: 'quests', vars: ['questsBlock'], client: true, granted: 'withheld', how: 'open quests (POST /api/quests/mint, /api/quests/update)' },
  { id: 'slim-note-guides', vars: ['slimStable'], client: true, granted: 'withheld', how: 'STARNET_SLIM_NOTE: the constant paragraphs slim-note.js takes out of runtimeSkillBlock and questsBlock and puts in the system prompt\'s tail (the first-skill line, the quest how-to and minting doctrine). Host-written words, but whether the first-skill line rides, and its archived count, follow the skill store the client key writes; a granted run is given neither block, so nothing is moved for it' },
  { id: 'journey-adaptation', vars: ['journeyBlock'], client: true, granted: 'withheld', how: 'the verified journey adaptation (POST /api/journey)' },
  { id: 'away-briefing', vars: ['awayBriefingNote'], client: true, granted: 'withheld', how: 'only on the briefing session\'s stream, never a routine\'s; left out all the same' },
  { id: 'crew-call', vars: ['crewCallNote'], client: false, granted: 'withheld', how: 'only for the owner\'s own words, never a routine; left out all the same' },
  { id: 'stream-history', vars: ['convo', 'earlier.note'], client: true, granted: 'withheld', how: 'the stream\'s earlier turns (the resume seed and the <conversation_summary> note); a routine\'s stream is new for every run, left out all the same' },
  { id: 'crew-roster-labels', vars: ['teamNote'], client: true, granted: 'host', how: 'the lead\'s team list: a granted run lists each crew member by id only (names, roles and track records are POST /api/roster text)' },
  // what the host writes
  { id: 'routine-note', vars: [], client: false, granted: 'host', how: 'CRON_ROUTINE_NOTE / CRON_PERSONA (constants)' },
  { id: 'delivery-note', vars: [], client: false, granted: 'host', how: 'routine-delivery.js cronDeliveryNote: the channel labels from the registry' },
  { id: 'project-scope-line', vars: [], client: false, granted: 'host', how: 'projectscope / workflow folder lines naming the routine\'s sealed folder' },
  { id: 'tool-notes', vars: ['toolNote'], client: false, granted: 'host', how: 'the [HARNESS] tool list and work rules' },
  { id: 'operator-manual', vars: ['operatorManual'], client: false, granted: 'host', how: 'shipped manual text (interactive only)' },
  { id: 'capabilities', vars: ['summarizeCapabilities'], client: false, granted: 'host', how: 'the capabilities ground truth the host computes' },
  { id: 'skill-library', vars: ['skillBlock'], client: false, granted: 'host', how: 'the shipped recipe library and signed market recipes (which ones are on is a preference; every text is shipped or signed)' },
  { id: 'service-keys', vars: ['serviceKeysBlock'], client: false, granted: 'host', how: 'key NAMES (environment-variable syntax) and the shipped catalog notes; never a value' },
  { id: 'task-doctrine', vars: ['taskDoctrine'], client: false, granted: 'host', how: 'the constant Task Brief doctrine (only with a brief)' },
  { id: 'deliverable-note', vars: ['deliverableNote'], client: false, granted: 'host', how: 'DELIVERABLE_NOTE_CLAUSE (constant)' },
  { id: 'domain-task', vars: ['directDomainBlock'], client: false, granted: 'host', how: 'DomainTask.prompt of a host scope read from the sealed prompt' },
  { id: 'runtime-identity', vars: ['runtimeBlock'], client: false, granted: 'host', how: 'run id, model, surface, date (runtimeIdentityBlock)' },
  { id: 'run-context-note', vars: ['runContext'], client: false, granted: 'host', how: 'the fence the per-run blocks above ride in' },
  // what reaches a run while it runs
  { id: 'steer-note', vars: ['drainSteer'], client: true, granted: 'taint', how: 'a SEND NOW note (POST /api/run/steer): read into the run, which is tainted first, so its grants end before the model sees it' },
  { id: 'task-plan', vars: ['Todo.formatForInjection'], client: true, granted: 'withheld', how: 'the agent\'s todo plan from its notebook, re-injected after a compaction' },
  // not context: what a tool returns when the model calls it (taint.js documents why these are not taint sources)
  { id: 'tool-reads', vars: [], client: true, granted: 'tool', how: 'notebook / skill.view / team.config / fs reads and a worker\'s answer reach the run only as tool results, when the model calls for them' }
]);
const CLASSES = Object.freeze(['sealed', 'bound', 'host', 'taint', 'withheld', 'tool']);

// Does this run carry desk-granted unattended capability? `grants`: the run's unattended grants after the drive check.
function grantedRun(surface, grants) {
  return surface !== 'interactive' && Array.isArray(grants) && grants.length > 0;
}

// The agent's own instructions: the persona's stable half, without the one-line YOUR CREW clause the page re-composes as
// the crew changes (the same text index.js fullAccessDriveOf binds a Full Access agent to), and without the one-line
// approval clause the page composes from the agent's approval posture (app.js approvalClause: "APPROVAL — ASK FIRST: ..."
// or "AUTHORITY — FULL POWER: ...", and the reach-scoped Full Power clauses "AUTHORITY — FULL POWER INSIDE YOUR PROJECT
// FOLDERS: ..." (TRUSTED PROJECT) and "AUTHORITY — FULL POWER ON YOUR REMOTE MACHINE: ..." (REMOTE SSH)). Turning Full Access on or off, a clamped raise
// or the upgrade's clamp re-composes that line, and binding it silently dropped every grant of that agent's routines (review56 R2-3). Each line is removed from
// what the grant binds AND from what the granted run is given, so nothing written on it reaches a granted run; a second
// such line, words after it, or any other edit is still instructions. A granted run is given exactly this text, never the
// persona's learned tail.
const CREW_LINE = /\n\nYOUR CREW: [^\n]*/;
const APPROVAL_LINE = /\n\n(?:AUTHORITY — FULL POWER(?: INSIDE YOUR PROJECT FOLDERS| ON YOUR REMOTE MACHINE)?|APPROVAL — ASK FIRST): [^\n]*/;
function instructionsOf(system) {
  return LearnedTail.split(String(system == null ? '' : system)).stable.replace(CREW_LINE, '').replace(APPROVAL_LINE, '');
}

// What a skill gives a run, for the binding: everything runtimeSkills.composeLoaded shows the model (its name, summary,
// setup, body and support files, each file as its bytes: skills/file-bytes.js contentKey) and whether it is loadable at
// all. SHA-256, not the guard's digestOf: that one is a 32-bit change detector (skills/gate.js says so), and a binding
// the client key could match with a different body would bind nothing.
function skillDigest(skill) {
  if (!skill || typeof skill !== 'object') return '-';
  const str = v => (v == null ? '' : String(v));
  const files = (Array.isArray(skill.files) ? skill.files : []).filter(Boolean)
    .map(f => [str(f.path), FileBytes.contentKey(f)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash('sha256').update(JSON.stringify(['granted-skill/v1', str(skill.name), str(skill.summary), str(skill.setup),
    str(skill.body), str(skill.state), !!skill.withheld, !!skill.pendingCandidate, files])).digest('hex').slice(0, 32);
}

// skills: [[name, skillDigest]] ('-' for a name that does not resolve). The order is the routine's own (sorted here),
// names compared case-blind.
function instructionsDigest(instructions, skills) {
  const rows = (Array.isArray(skills) ? skills : []).map(s => [String(s[0] || '').toLowerCase(), String(s[1] || '-')])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash('sha256').update(JSON.stringify(['granted-instructions/v1', String(instructions == null ? '' : instructions), rows])).digest('hex').slice(0, 32);
}

module.exports = { INPUTS, CLASSES, grantedRun, instructionsOf, skillDigest, instructionsDigest };
