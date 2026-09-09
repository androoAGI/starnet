/* STARNET — glossary.js : the one place the station explains its own words to a first-minute user.

   A pure term -> one-sentence map, consumed by hint.js (data-hint="<term>" tooltips). Copy law:
   lowercase station voice, eerie-not-cute, one plain sentence a beginner can act on. Every entry
   is grounded in how the term is ACTUALLY used in the code (marketplace.js / autonomy.js / stationui.js
   / returnstore.js) — not an aspirational definition. Keys are lowercased on lookup, so
   data-hint="REFIT" and data-hint="refit" resolve the same entry.

   UMD: a `Glossary` global in the browser; module.exports under node/tests. No DOM, no deps. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Glossary = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // term -> one beginner-facing sentence. Keep each to a single sentence; no jargon inside the definition.
  const TERMS = {
    agent:        'one working AI identity with its own model, chat, workspace, memory, and run history.',
    crew:         'all agents currently on your station — each keeps its own identity and work.',
    model:        'the AI engine an agent uses to think and answer; you can change it per agent.',
    effort:       'the reasoning depth used for a run — higher effort may think longer and cost more.',
    voice:        'the speaking style and personality an agent uses; it does not change its authority.',
    focus:        'the kind of work an agent is configured to prioritize, such as code, research, or operations.',
    provider:     'the service that supplies a model, such as OpenRouter, OpenAI, Anthropic, or a local server.',
    run:          'one bounded attempt to finish a message or task, with its own stop, cost, and result.',
    approval:     'your explicit yes or no before a watched agent performs a sensitive action.',
    transcript:   'the durable conversation record for one chat thread, including what happened after restarts.',
    deliverable:  'a finished file or output from real work — open it from DELIVERABLES to inspect the result.',
    artifact:     'a file produced or checked by a run, recorded with its path and verification evidence.',
    verification: 'a fresh check performed after the work changed, so completion is proved instead of claimed.',
    context:      'the conversation and evidence currently visible to the model; older material can be compacted safely.',
    fallback:     'the next configured model or credential tried when the current provider cannot continue.',
    settings:     'the station controls for providers, models, voice, budget, permissions, and saved data.',
    update:       'a new StarNet build; the UPDATES panel shows the version and its verified delivery state.',
    restore:      'return an agent’s workspace files to a saved restore point without rewriting unrelated station data.',
    logbook:      'this agent’s durable run history — what ran, how it ended, and what it cost.',
    notification: 'a station alert about work, failure, delivery, or another event that needs your attention.',
    manual:       'the reopenable guide to first steps, the real work loop, gear, wiring, and growth.',
    commander:    'you — the person who directs the station, grants authority, and judges its work.',
    work:         'tasks, deliverables, recipes, routines, loops, and quests gathered under one dock.',
    build:        'the dock for equipping agents, shaping the floor, and connecting outside abilities.',
    system:       'the dock for the manual, settings, updates, restore points, history, and alerts.',
    workstream:   'the saved conversation behind a COMMS session; planned task conversations also appear as cards on the TASK BOARD.',
    orchestrator: 'the lead agent you talk to first — new agents inherit its model unless you pick another.',
    overseer:     'the station itself — it holds shared gear that any specialist can draw on.',
    refit:        'the station’s build mode — open it from the dock to place desks, furniture, and gear.',
    clearance:    'how hard the agent’s model thinks — more diamonds mean deeper (slower) reasoning.',
    lane:         'the kind of work a class is built for: CODE, RESEARCH, or general OPS.',
    dish:         'the WEB gear — with it on station, an agent can search and fetch live pages.',
    cabinet:      'the FILES gear — with it on station, an agent can read, write, and search your workspace.',
    notebook:     'the MEMORY gear — a durable notebook the agent can save to and recall later.',
    workbench:    'the TERMINAL gear — lets an agent run and test real code (each run asks you first).',
    studio:       'the IMAGES gear — lets an agent generate and read visuals.',
    seed:         'a saved idea you can hand back to an agent later so it picks up right where you left off.',
    drafted:      'written up by the station for you to review — nothing is summoned until you confirm it.',
    sidecar:      'the small local program that actually runs your agents — the app talks to it in the background.',
    // the WORK vocabulary, each on ONE axis (UX confusion audit 2026-07-15: recipe=WHAT to run,
    // routine=WHEN it runs, task=WHERE live work sits, quest=progress/suggestions — never a place work lives).
    automation:   'the home of standing work — ROUTINES (any job on a schedule) and LOOPS (one objective, repeated until it’s done) share this one panel.',
    routine:      'a recipe or job put on a schedule (every morning, hourly) — WHEN work runs; manage them under ∞ AUTOMATION.',
    loop:         'one objective an agent keeps working at, stopping each time for your yes or no — UNTIL it is done, not on a clock. Your verdict is what starts the next pass; it costs nothing while it waits. Manage them under ∞ AUTOMATION.',
    recipe:       'a ready-made job an agent can run right now — WHAT to run; launching one lands it on the ☑ TASK BOARD.',
    task:         'a planned piece of work created on the board or launched from a recipe or goal — it appears on the ☑ TASK BOARD and opens as a COMMS session.',
    quest:        'a suggestion or progress marker from the station — accepting one starts real work; it is never a second to-do list.',
    skill:        'something an agent CAN do — some skills only switch on once their gear is on station. Browse them under ⇄ ABILITIES ▸ SKILL LIBRARY.',
    toolset:      'a family of tools you can switch on or off for agents (web, files, terminal…) — the switches live in the TOOLSETS section of ⇄ ABILITIES.',
    capability:   'the same tool families as TOOLSETS, read-only — what an agent is equipped with right now; each agent’s readout is the SKILLS tab of its dossier.',
    connector:    'an outside service you plug IN so agents can use it as a tool (calendar, Slack actions, databases).',
    channel:      'your way IN from a messaging app — connect Telegram/Slack/Discord and talk to your agents from your pocket.',
    autonomy:     'how far an agent may act on its own between your messages — you set the ceiling.',
    initiative:   'whether an agent starts work on its own — the same four rungs everywhere: WAIT, SUGGEST, BUILD, FREE.',
    reach:        'the farthest a single unattended action may go — the same three rungs everywhere: OBSERVE (read only), SANDBOX (write locally), SEND & PUBLISH (contact the outside).',
    pace:         'how many small unattended jobs an agent may do per day at most.',
    xp:           'experience an agent earns from work you rate well — it levels up as it proves itself.',
    workspace:    'the folder on your machine where an agent’s files land (workspaces/<agent>/).',
    desk:         'an agent’s own workstation — it needs one placed in REFIT before it can take floor work.',
    recruit:      'summon a new agent class onto your crew, or re-spec the agent you already have.',
    slag:         'a post-mortem of a run that ended without producing anything — its cause, and the fix.',
    kudos:        'the good ratings you give an agent’s work — they raise its satisfaction and earn it XP.',
    leash:        'the cap on how many jobs an agent may do on its own before it stops and waits for you.',
    beat:         'one small unattended job the station does while you’re away — the daily limit caps how many.',
    'restore point': 'a saved snapshot of an agent’s workspace you can roll it back to.',
    uplink:       'the live link to your local sidecar — full bars while telemetry flows, red when it drops.'
  };

  // lookup: case-insensitive, trims surrounding whitespace. Returns the sentence or null (caller shows nothing).
  function lookup(term) {
    if (term == null) return null;
    const key = String(term).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(TERMS, key) ? TERMS[key] : null;
  }

  function has(term) { return lookup(term) != null; }

  return { TERMS, lookup, has };
});
