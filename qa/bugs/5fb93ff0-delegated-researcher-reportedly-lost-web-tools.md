---
fingerprint: 5fb93ff0
slug: delegated-researcher-reportedly-lost-web-tools
title: Delegated researcher reportedly lost its web tools
surface: autonomy
severity: P2
status: claimed
found: 2026-10-14
lane: domain-task-advisory
fix:
origin: customer
report: direct user report 2026-10-14 (run 0d4eafac on the reporter's machine)
affected: Windows desktop; build not stated
family: prose-classifier-authority
installer: unverified
recovery: unconfirmed
---

# Delegated researcher reportedly lost its web tools

## Symptom

A researcher run as a delegated (team.dispatch) or Conveyor worker had no web_search, browser_navigate or browser_snapshot, and tool_search found only browser.test_* and browser.intercept. The same researcher had its web tools in direct chat. The reporter ran a GPT-6 Sol lead and a GPT-5.6 Terra worker on the Windows desktop app.

## Repro

Not reproduced on the reporter's setup. Run 0d4eafac is on the reporter's machine, and no transcript, worker prompt, bay props or TOOLSETS settings were sent. On 10-14 a hermetic dispatch (SidecarFixture with a mock OpenRouter) on trunk and on v0.13.3 gave the worker all three tools with a neutral brief.

The one-site lead does reproduce. The lane wrote both tests below, so 0b8441064 (the base before it) does not have them; they use only test/helpers and sidecar files that 0b8441064 already has.

1. Check out 0b8441064, then copy test/domain-task.metamorphic.e2e.test.js and test/domain-task.metamorphic.test.js from the lane's branch (agent/domain-task-advisory-1103, b64956730) into its test/ folder.
2. Run `node test/domain-task.metamorphic.e2e.test.js` (the real sidecar, with a mock OpenRouter as the only fake). Its brief 'Review the itch.io site for our game page and check the latest reviews.' is rebuilt from the report's "check/review itch.io ... site" lead.
3. As the lead's message, that brief costs the lead web_search and all nine team_* tools, and its team_dispatch is refused, so no worker gets the brief from it. As a dispatched worker's brief, the worker loses web_search and runs only 3 of its 4 scripted tool calls. As a routine, it loses web_search.
4. Run `node test/domain-task.metamorphic.test.js`. The same brief gives a dispatched worker 3 turns, 3 tool calls and a 45000 ms slice. The reporter's Conveyor run took about 35 s.

## Evidence

At 0b8441064 a one-host brief acted as authority over the run:

- sidecar/index.js:23254 took web_search and team.* off the wire: `const directDomainWithheld = (name) => ProjectTools.directDomainWithheld(!!directDomainTask, name);`
- sidecar/tools/builtin/orchestration.js:997 cut a dispatched worker whose brief read as a pure one-host read to 3 turns, 3 tool calls and 45 s: `const bounded = boundedDomainTask(job.prompt, fileProbeFor(job.agentId, projectOptions(job.sessionContext || ctx).projectRoot));`

That explains a missing web_search and a short worker. It does not explain the missing browser_navigate and browser_snapshot, because prose never withheld browser tools. The other leads from 10-14 are not prose:

- A Conveyor step or line hop resolves its tools from its bay room. A bay without a DISH has no web by per-bay isolation, which is by design.
- sidecar/capability/capsummary.js uses web_search as its only probe for "web + browser". If web_search left resolved.tools while browser.* stayed, the note would wrongly tell the model the browser is unavailable. This is latent: no path does it today, prose no longer removes web_search at all, and a lead's onlyHost filters web_search from the wire only, leaving it in resolved.tools.

## Verdict

_Filled in when the bug leaves the backlog: what was true, and why it is closed._

## Change

Lane domain-task-advisory, branch agent/domain-task-advisory-1103 (84c78e50a, daaae6b83, 538d85799, d554cb0f1, b4a1beea6; review round 1: 60f43c313, 518c82883, d14035afa, bd88d59d4, 8de3e3b75, aebcc65b1, b64956730). The companion record is qa/bugs/dd379d02-delegated-workers-cut-short-by-brief-wording.md. A one-site brief is now advice: it adds the '[DIRECT DOMAIN CHECK — ADVICE]' block, and it never withholds web_search or team.*, refuses a call, stops a run or budgets a worker. A worker is bounded only by its lead's bounded:true and confined to one host only by its lead's onlyHost, and both are stamped on its row. The advice never tells the lead to use either (review round 1: it once said "dispatch it with onlyHost <host>", and a lead that followed it took web_search from its own worker).

## Still open

- The missing browser tools are unexplained. Prose never withheld them.
- The bay-room lead is by design and belongs to the bay and line lanes, not this one.
- Setting this record fixed would cover the one-site lead only. The cause on the reporter's station stays unconfirmed until their transcript, worker prompt, bay props and TOOLSETS settings are in.
- No reply has been sent to the reporter, and recovery is unconfirmed.

## Regression

Before, at 0b8441064 (the Repro above): through the real sidecar, the itch.io brief cost the lead 10 tools and got its dispatch refused, cut the dispatched worker to 3 of 4 tool calls without web_search, and cost the routine web_search (test/domain-task.metamorphic.e2e.test.js, 17 of 27 assertions failed in all). The dispatcher gave that brief 3 turns, 3 tool calls and a 45000 ms slice (test/domain-task.metamorphic.test.js, 47 failed). After, at b64956730: both pass, with 27 and 57 assertions. The brief keeps the control's wire tools on all four surfaces (the lead, the worker that lead hands it to while following its own advice, a dispatched worker and a routine), the dispatched worker runs all 4 calls, and dispatch, spawn and resume give it the control's budgets. This proves the one-site lead only, not the cause on the reporter's station.

## Sibling coverage

{
  "adapters": [
    {"target": "OpenRouter chat transport (mock at the transport edge)", "state": "covered", "test": "test/domain-task.metamorphic.e2e.test.js", "scenario": "the itch.io brief keeps the control's wire tools on the lead, the worker it hands the brief to on its advice, a dispatched worker and a routine", "gate": "http"},
    {"target": "the reporter's provider route for GPT-6 Sol and GPT-5.6 Terra", "state": "blocked", "reason": "The reporter's provider route and station were not reproduced; the change sits before any adapter."}
  ],
  "entrypoints": [
    {"target": "team.dispatch, team.spawn and team.resume", "state": "covered", "test": "test/domain-task.metamorphic.test.js", "scenario": "the itch.io brief gets the control's turns, tool calls and wall clock on dispatch, spawn and resume", "gate": "fast"},
    {"target": "Conveyor step and line hop", "state": "blocked", "reason": "They resolve tools from the bay room; a bay without a DISH has no web by design, and the reporter's bay props are unknown."}
  ],
  "displays": [
    {"target": "the worker's offered tools (what the model sees)", "state": "covered", "test": "test/domain-task.metamorphic.e2e.test.js", "scenario": "the dispatched worker on the itch.io brief is offered web_search like the control worker", "gate": "http"},
    {"target": "tool_search results and the capability note", "state": "blocked", "reason": "The reporter's tool_search output (only browser.test_* and browser.intercept) was not reproduced, and no transcript was sent."}
  ],
  "lifecycle": [
    {"target": "worker admission to completion", "state": "covered", "test": "test/domain-task.metamorphic.e2e.test.js", "scenario": "the worker on the itch.io brief runs all 4 scripted tool calls with no prose bound", "gate": "http"},
    {"target": "the reporter's station after upgrading", "state": "blocked", "reason": "No reply or diagnostics from the reporter; customer recovery is unconfirmed."}
  ]
}
