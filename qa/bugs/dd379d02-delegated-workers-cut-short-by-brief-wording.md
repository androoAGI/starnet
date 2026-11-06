---
fingerprint: dd379d02
slug: delegated-workers-cut-short-by-brief-wording
title: Delegated workers cut to 3 tools and 45s by brief wording
surface: autonomy
severity: P1
status: fixed
found: 2026-10-15
lane: domain-task-advisory
fix: 52f213958
origin: customer
report: https://github.com/androoAGI/starnet-releases/issues/5
affected: 0.13.3 as reported; the prose gates it hit still ship in 0.14.2
family: prose-classifier-authority
installer: unverified
recovery: unconfirmed
---

# Delegated workers cut to 3 tools and 45s by brief wording

## Symptom

Delegated work stopped short, and nothing told the user why. Engineering and Automation workers were refused after about three tool turns. Security and QA workers were terminated at 45 seconds. A request about a local Markdown file was handled as a website, and delegation was withheld. Delegated workers in Ask mode could not run shell commands or tests. The report asks what enforces the 3-call and 45-second limits.

## Repro

The report published no verbatim briefs. The security, QA and automation briefs below are rebuilt from its observations. The engineering brief is the one the 10-15 lane pinned as the reporter's.

The lane wrote both tests, so 0b8441064 (the base before it) does not have them. They use only test/helpers and sidecar files that 0b8441064 already has.

1. Check out 0b8441064, then copy test/domain-task.metamorphic.e2e.test.js and test/domain-task.metamorphic.test.js from the lane's branch (agent/domain-task-advisory-1103, b64956730) into its test/ folder.
2. Run `node test/domain-task.metamorphic.e2e.test.js`. It boots the real sidecar with a mock OpenRouter as the only fake. The roster is a Full Access lead and one Full Access crew worker.
3. For each report brief, the test compares the sorted wire tool names with those of the control brief 'Summarize what we know about the release plan.' on four surfaces: the lead run (the brief is its message), the worker that lead hands the brief to, a dispatched worker (a neutral lead message, with the brief in the worker's prompt) and a routine (POST /api/cron, then /api/cron/run).
4. With 'Review the security headers and TLS setup on starnet-demo.io and list the risks.', the lead loses web_search and all nine team_* tools, so its team_dispatch is refused and no worker gets the brief from it. As a worker's brief, the worker loses web_search and runs only 3 of its 4 scripted fs_list calls. As a routine, it loses web_search.
5. Run `node test/domain-task.metamorphic.test.js`. It drives team.dispatch (foreground and background), team.spawn and team.resume (after a registry reload) through makeOrchestrationTools for 81 one-host briefs. An affected brief gets 3 turns, 3 tool calls and, on dispatch, a 45000 ms slice. The control brief gets 16 turns, no tool cap and the ordinary wall clock (9 turns on spawn, 7 on resume).

## Evidence

RED at 0b8441064, measured with the tests as they are at b64956730 (the Repro above):

- test/domain-task.metamorphic.e2e.test.js failed 17 of 27 assertions. Its INV-3 check found 41 violations across 9 report briefs and 4 surfaces. Seven briefs (the four rel#5 one-site briefs, two gh#58 briefs and the 10-14 itch.io brief) cost the lead web_search and its nine team_* tools, and its dispatch came back "REFUSED withheld", so no worker got the brief from that lead. Their dispatched workers and routines lost web_search, and six of those workers stopped after 3 of 4 tool calls. bounded:true and onlyHost were ignored.
- test/domain-task.metamorphic.test.js failed 47 of the 55 assertions it reaches there (its pure-function half needs DomainTask.scopeOf, refusalOf and afterCall, which 0b8441064 does not have), including 224 budget violations across 81 one-host briefs and 4 entry points (dispatch, background dispatch, spawn, resume after a reload).

Cause, at 0b8441064. runOnceCore classified the latest user message of every task run with DomainTask.classify (sidecar/index.js:22131): the Commander's message, a routine's whole spec, or a dispatched worker's brief. When the prose read as one exact host, the classification acted as authority:

- sidecar/index.js:23254 took team.* and web_search off the wire: `const directDomainWithheld = (name) => ProjectTools.directDomainWithheld(!!directDomainTask, name);`
- sidecar/index.js:24048 refused delegation and search calls: `if (directDomainTask && directDomainWithheld(c.name)) {`
- sidecar/index.js:24312 removed every tool after an NXDOMAIN: `r = Object.assign({}, r, { control: Object.assign({}, r && r.control, DomainTask.stopControl(directDomainTask)) });`
- sidecar/tools/builtin/orchestration.js:997 re-read each worker's brief and cut a "pure read" to 3 turns, 3 tool calls and 45 s. Spawn and resume did the same: `const bounded = boundedDomainTask(job.prompt, fileProbeFor(job.agentId, projectOptions(job.sessionContext || ctx).projectRoot));`
- sidecar/domain-task.js:209 decided "pure read" with regex rungs over the wording: `if (asksForWork(src)) return { kind: 'direct-domain', host: hosts[0], pureRead: false };`

6f4a61e6c (10-25, shipped by 0.14.2) narrowed the worker bound to briefs without a work verb. Engineering briefs got their budget back, but security, QA and automation reads were still cut, and a lead still lost delegation on any one-host brief. No worker row said where a bound came from.

## Verdict

Prose classifiers no longer grant, withhold or budget tools: a one-host brief keeps web_search and the team tools, a delegated worker keeps its ordinary turns, tool calls and wall clock, and DomainTask now only advises. Fixed by lane domain-task-advisory, merged at 52f213958 and shipped in 0.15.0. Proof on the release tree (agent/release-0150): test/domain-task.metamorphic.e2e.test.js 27/27 (lead, worker, dispatched worker and routine surfaces) and test/domain-task.metamorphic.test.js 57/57 (81 one-host briefs over dispatch, background dispatch, spawn and resume), both red at 0b8441064.

## Change

Lane domain-task-advisory, branch agent/domain-task-advisory-1103 (84c78e50a, daaae6b83, 538d85799, d554cb0f1, b4a1beea6; review round 1: 60f43c313, 518c82883, d14035afa, bd88d59d4, 8de3e3b75, aebcc65b1, b64956730). Prose classifiers no longer grant, withhold or budget tools.

- A one-host request is advice. DomainTask.classify still runs at admission. Its result only adds the '[DIRECT DOMAIN CHECK — ADVICE]' block and a note on a failed exact-host web_fetch or browser.navigate. It never withholds a tool, refuses a call, stops a run or budgets a worker. classify returns {kind, host} only, and asksForWork and its regex rungs are deleted.
- A worker is bounded only when its lead passes bounded:true on team.dispatch or team.spawn: 3 turns and 3 tool calls, plus a 45 s wall clock on dispatch. The result row, the dispatch summary on the COMMS chip, the background start handle, the timeout row and the run host's tool-budget refusal all say 'bounded read (requested by lead)'. The subagent record keeps bounded, and team.resume re-applies it instead of re-reading the prompt.
- Only the lead's onlyHost scopes a run. Under a scope the worker has no web_search or team.*, calls off that host are refused, and an NXDOMAIN on it stops the worker's tools after one synthesis turn. An onlyHost that is not a host name starts no worker, and its row says to fix the value or send the worker without it. A URL with an '@' or '*' in its path or query names its host (youtube.com/@channel). Each refusal names the lead's onlyHost and the way out.
- The advice never tells the lead to scope or bound its worker. Review round 1 found it did ("dispatch it with onlyHost <host>, plus bounded:true"), so a lead that followed it on a report brief scoped its own worker off web_search and every other host. That sentence is gone (60f43c313), and GET /api/toolsets no longer says a one-host message withholds team.* and web_search (d14035afa).

## Still open

- Ask-mode delegated workers still cannot run shell.exec or verify.run (report item 3). That is the delegated Ask worker shell policy, not a prose gate, and it stays unchanged until Andrew decides. Today's routes: give that worker Full Access, or have the lead run the commands.
- A Conveyor step or line hop uses its bay room's tools. A bay without a DISH has no web by design (per-bay isolation).
- gh#58 (androoAGI/starnet#58, fixed in 0.13.2 by the API-wording carve-out and isTargetRequest) was this family's earlier fix. It moved one wording out of the gate, and the gate came back here. This lane removes prose authority itself. ImageTask's admission gate and the keys.save key-shaped-text gate are prose gates outside this lane.
- The record stays claimed until a published tag contains the lane. Nothing has been posted on the issue, and recovery is unconfirmed.

## Regression

Before, at 0b8441064: test/domain-task.metamorphic.e2e.test.js failed 17 of 27 assertions and test/domain-task.metamorphic.test.js failed 47 (see Evidence). After, at b64956730: both pass, with 27 and 57 assertions. The e2e test runs on the http gate and the unit test on the fast gate. Through the real sidecar, every report brief keeps the control's wire tools on the lead, the worker that lead hands the brief to, the dispatched worker and the routine; the lead's dispatch runs; and the dispatched worker makes all 4 tool calls. The lead follows its one-host advice to the letter, and the worker it hands the brief to still keeps web_search, fetches another host and has no scope or bound on its row. At b4a1beea6 that check found 21 violations, because the advice named onlyHost and bounded:true. A bounded:true worker runs at most 3 tool calls, and its summary and row name the bound. An onlyHost worker has no web_search, is refused off its host and stops after its own NXDOMAIN.

## Sibling coverage

{
  "adapters": [
    {"target": "OpenRouter chat transport (mock at the transport edge)", "state": "covered", "test": "test/domain-task.metamorphic.e2e.test.js", "scenario": "9 report briefs keep the control's wire tools on the lead, the worker it hands the brief to on its advice, a dispatched worker and a routine through the real sidecar", "gate": "http"},
    {"target": "Codex, Anthropic, Gemini, Ollama and managed adapters", "state": "blocked", "reason": "Classification, scope and bounds are applied in runOnceCore and orchestration before any adapter; runs on these adapters were not exercised for this report."}
  ],
  "entrypoints": [
    {"target": "team.dispatch, foreground and background", "state": "covered", "test": "test/domain-task.metamorphic.test.js", "scenario": "81 one-host briefs get the control's turns, tool calls and wall clock; bounded:true gives 3 turns, 3 tool calls and 45 s", "gate": "fast"},
    {"target": "team.spawn and team.resume after a registry reload", "state": "covered", "test": "test/domain-task.metamorphic.test.js", "scenario": "the same budgets as the control brief; a bounded record is re-applied on resume and the prompt is never re-read", "gate": "fast"},
    {"target": "lead run through POST /api/run", "state": "covered", "test": "test/domain-task.metamorphic.e2e.test.js", "scenario": "the lead keeps team_* and web_search, its team_dispatch is not refused, and a hand-off that follows its advice leaves the worker unscoped and unbounded", "gate": "http"},
    {"target": "routine through /api/cron/run", "state": "covered", "test": "test/domain-task.metamorphic.e2e.test.js", "scenario": "the routine request that carries routine_notepad keeps web_search", "gate": "http"},
    {"target": "Conveyor steps, line hops, channel and /v1 runs", "state": "blocked", "reason": "They reach the same runOnceCore admission, but their ingress paths were not exercised for this report."}
  ],
  "displays": [
    {"target": "team_dispatch summary on the COMMS chip and the worker row", "state": "covered", "test": "test/domain-task.metamorphic.e2e.test.js", "scenario": "a bounded:true dispatch summary and row read 'bounded read (requested by lead)'; an onlyHost row carries the host", "gate": "http"},
    {"target": "timeout row, background start handle, spawn and resume summaries, tool-budget refusal", "state": "covered", "test": "test/domain-task.metamorphic.test.js", "scenario": "each names 'bounded read (requested by lead)'", "gate": "fast"},
    {"target": "installed desktop COMMS panel", "state": "blocked", "reason": "No installer was rebuilt or driven for this lane; the label rides the existing tool summary string."}
  ],
  "lifecycle": [
    {"target": "subagent registry reload", "state": "covered", "test": "test/domain-task.metamorphic.test.js", "scenario": "bounded survives a reload and team.resume re-applies it; a prose brief never re-derives a bound", "gate": "fast"},
    {"target": "registry records written before this lane", "state": "blocked", "reason": "Older records have no bounded or onlyHost field and resume with ordinary budgets and no scope; no older registry file was replayed."}
  ]
}
