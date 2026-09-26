# StarNet Onboarding Progression Story

## Goal

Give the Overseer a structured, durable model of the Commander's StarNet learning journey so guidance becomes:

- contextual rather than generic
- progressive rather than repetitive
- tapering rather than permanent

The Overseer should start as both guide and orchestrator, then gradually shift toward orchestration-first behavior as the Commander becomes competent and self-directed.

## Problem

Today the Overseer can be instructed to guide the Commander and remember prior advice through existing memory/dossier facilities, but that progression is prompt-shaped rather than explicitly modeled.

That leaves several gaps:

- guidance may repeat because prior instruction is not captured in a normalized progression record
- the Overseer may not know whether a feature was merely mentioned or actually used successfully
- the system has no stable way to distinguish beginner, intermediate, and autonomous Commander behavior inside StarNet itself
- proactive suggestions cannot easily rank whether the next best help is onboarding, capability expansion, or orchestration support

## Story

As a Commander learning StarNet,
I want the Overseer to track my actual in-app progress,
so that it teaches me the next useful thing once, remembers that it taught me, notices when I have successfully used it, and eventually stops over-explaining surfaces I already understand.

## Proposed Design

Introduce a durable "StarNet progression" record owned by the Overseer and updated over time from real evidence.

This should not be a fake XP system. It is a capability-and-fluency map grounded in observed actions, accepted guidance, and successful usage.

## Progression Dimensions

Track progression across concrete StarNet areas rather than one global score.

Suggested dimensions:

- `navigation`: COMMS, session switching, Recruitment Bay, REFIT, ABILITIES, TASKS, AUTOMATION
- `station_building`: rooms, bays, desks, capability props, shared-vs-per-agent understanding
- `crew_management`: recruiting specialists, understanding roles, delegation, background workers, session routing
- `automation`: routines, loops, unattended work, handovers
- `integrations`: connectors, keys, MCP routes, channels
- `workflow_design`: sessions, task board use, work splitting, conveyors or route-like work organization
- `autonomy_posture`: understanding approvals, watched vs unattended behavior, when Full Access changes behavior

## Milestone Shape

Each dimension should be represented as observed milestones rather than open-ended prose.

Example milestone states:

- `unknown`: never introduced
- `suggested`: Overseer recommended it
- `explained`: Overseer taught it in context
- `attempted`: Commander tried it
- `confirmed`: Commander successfully used it
- `fluent`: Commander has used it repeatedly without needing guidance

Example milestone keys:

- `opened_refit_once`
- `placed_first_dish`
- `understands_shared_gear_model`
- `recruited_first_specialist`
- `delegated_background_task`
- `created_first_routine`
- `connected_first_platform`
- `used_session_split_effectively`

## Evidence Sources

Only advance progression from evidence the harness can actually prove.

Candidate evidence sources:

- accepted or dismissed Overseer suggestions
- UI actions already visible to the station state or event pipeline
- successful tool outcomes that imply a surface was used correctly
- session/task/crew state changes
- explicit Commander statements like "I already know that" or "I did that"
- repeated success without repeated explanation

The system should distinguish:

- `taught`: the Overseer explained a thing
- `suggested`: the Overseer recommended a thing
- `used`: the Commander successfully did the thing

These are not equivalent and should not collapse into one flag.

## Overseer Behavior Contract

The Overseer should use progression state to decide how much to teach.

Rules:

- If a useful StarNet feature has never been suggested, suggest it briefly when relevant.
- If it was suggested but not confirmed, allow one or two context-sensitive reminders later.
- If it was confirmed, stop teaching the basics of that surface unless the Commander appears stuck again.
- If the Commander is fluent in a surface, default to concise references instead of walkthroughs.
- If the Commander repeatedly ignores a suggestion, reduce its priority unless the current task is actually blocked by the missing feature.

## UI/Prompt Integration

Likely implementation path:

- add a bounded progression summary block to the Overseer prompt
- store the full durable record in an existing memory-like store or dossier-adjacent structure
- update it from existing event/state seams rather than freeform model self-reporting alone
- expose a concise readout for future UI work if desired

The prompt should receive only a compact operational summary, for example:

- what the Commander already knows well
- what was suggested recently
- what the most useful next StarNet lesson is
- which surfaces should no longer be over-explained

## Acceptance Criteria

- The Overseer does not repeatedly give the same onboarding instruction after it has already been taught and confirmed.
- The Overseer can suggest the next useful StarNet-native upgrade based on current station gaps and Commander fluency.
- Guidance tapers as the Commander becomes more autonomous.
- The progression record is grounded in real evidence, not generic confidence guesses.
- The Overseer remains primarily an orchestrator once the Commander is fluent.

## Open Questions

- Which existing durable store is the best home: notebook memory, dossier, journey store, or a new progression slice?
- Which UI events are already available to prove learning milestones without adding new instrumentation?
- Should the progression summary be Overseer-only, or shared with any agent acting as guide?
- What is the right decay model for stale knowledge if the Commander has not used a feature in months?
- Should suggestions be throttled globally per session so the guide never becomes noisy?

## Suggested Next Slice

Implement a minimal progression ledger for just a few high-value milestones:

- first REFIT use
- first capability prop placed
- first specialist recruited
- first delegated background task
- first routine created
- first connector added

Then feed a compact summary of those milestones into the Overseer prompt and let that drive the first adaptive-guidance pass.