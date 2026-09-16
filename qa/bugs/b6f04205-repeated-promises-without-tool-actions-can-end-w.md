---
fingerprint: b6f04205
slug: repeated-promises-without-tool-actions-can-end-w
title: Repeated promises without tool actions can end with done and no blocker explanation
surface: autonomy
severity: P1
status: fixed
found: 2026-09-16
lane: agent/recall-report-0916
fix: 46c929a88
origin: customer
report: Anonymized customer complaint relayed by owner in local task on 2026-09-16
affected: Customer version model and platform unknown; investigated source 87e10e1fe on Windows
family: premature-stops
installer: unverified
recovery: unconfirmed
---

# Repeated promises without tool actions can end with done and no blocker explanation

## Symptom

A customer reports agents starting tasks and repeatedly stopping without explanation, requiring further prompting. The investigation reproduced a provider repeatedly promising action while the host closes the run without any tool action or blocker explanation. The customer's particular transcript/model/build remains unknown.

## Repro

1. Boot the seeded app with `node dev/seed.js --keep` in an isolated worktree and use a local OpenAI-compatible provider advertising tool support.
2. Have the provider return `I'll work on that.` with finish reason `stop` for every model call, without tool calls.
3. POST authenticated `/api/run` with `isTask:true`, a fresh stream, and `Please inspect the station and report what you find.`
4. Observe the continuation nudge, repeated promise, zero tool actions, and final `agent.run.end` with `reason:done` and no blocker explanation.

## Evidence

Source `87e10e1fe`, Windows, 2026-09-16. Local reproducer and receipts: `.dogfood/recall-report/{probe.cjs,result.json,boot.log}` in `agent/recall-report-0916`.

Live run `b5ff8efa-470a-4f18-b592-f55afba7f7d6`: two provider calls, each offered 88 tools, both emitted `I'll work on that.`. The second provider request contained one `<continuation>` nudge. The event stream emitted `iteration.refunded {reason:duplicate,refundsUsed:1}` and ended with `{reason:done,turns:1,completionVerdict:not_assessed,effectVerdict:no_observed_effects}`. It emitted no tool calls or run error.

The duplicate-response path affects this exact fixture. A separate existing baseline test already establishes the varied-announcement path: `test/continuation-guard.test.js:77` expects a narrate-forever run to terminate `done` after the two-nudge budget. Relevant production anchors: `sidecar/loop.js:587` defines the budget; line 1351 guards announcement retries; line 1453 returns done for remaining nonempty output.

The backend DOES retain `no_observed_effects` and `not_assessed`; this finding does not claim those fields assert successful completion or that the UI showed a success badge. It concerns the run ending without carrying out the requested work or explaining why. No commercial model quality or installed UI was tested.

## Verdict

Source-fixed in 46c929a88. Installer verification and customer recovery remain unverified/unconfirmed. This is a repair of the reproduced mechanisms, not proof of the customer's exact original conversation.

## Regression

Before: identical promises ended done with no tool calls. After: duplicate and varied promises receive bounded continuations, then an error with an explicit incomplete-work explanation; missing memory-write receipts similarly reject unsupported save claims. Existing real-completion and disabled-guard cases still pass. Seeded real HTTP proof and live UI memory review are recorded in qa/evidence/recall-report-0916/verification.json.

## Sibling coverage

{
  "adapters": [
    {
      "target": "OpenAI-compatible wire",
      "state": "covered",
      "test": "test/memory-corrections.http.test.js",
      "scenario": "actual notebook write/update, reviewed reflection, missing write receipt, repeated promises",
      "gate": "http"
    },
    {
      "target": "provider-neutral agent loop",
      "state": "covered",
      "test": "test/continuation-guard.test.js",
      "scenario": "duplicate/varied announcements, grace exhaustion, ordinary completion, unsupported save claims",
      "gate": "fast"
    },
    {
      "target": "commercial Anthropic, Codex, Gemini and other model behavior",
      "state": "blocked",
      "reason": "Shared loop/store behavior is tested; these specific commercial-model conversations and customer model settings are unavailable."
    }
  ],
  "entrypoints": [
    {
      "target": "interactive /api/run and memory review API",
      "state": "covered",
      "test": "test/memory-corrections.http.test.js",
      "scenario": "real writes, follow-up recall, reflection review and conflict rejection",
      "gate": "http"
    },
    {
      "target": "direct notebook and reflection producers",
      "state": "covered",
      "test": "test/memory-corrections.test.js",
      "scenario": "replacement, stale write, write failure, archived text, update proposal, scoped pins and compaction context",
      "gate": "fast"
    },
    {
      "target": "Telegram/Discord, scheduled work and delegation",
      "state": "blocked",
      "reason": "They share the amended loop and memory primitives; specific reported channel/model journeys and delegated design output are not reproduced in this lane."
    }
  ],
  "displays": [
    {
      "target": "seeded desktop web UI",
      "state": "blocked",
      "reason": "Manual live UI Keep/replacement observation is recorded in qa/evidence/recall-report-0916/verification.json; no automatic browser action is registered in the mandatory gates."
    },
    {
      "target": "installed Windows/macOS/Linux UI",
      "state": "blocked",
      "reason": "No installer was rebuilt or tested in this source repair."
    }
  ],
  "lifecycle": [
    {
      "target": "restart, durable review and stale updates",
      "state": "covered",
      "test": "test/memory-corrections.http.test.js",
      "scenario": "pending correction survives restart, accepted replacement survives restart, newer edit rejects stale review without consuming it",
      "gate": "http"
    },
    {
      "target": "scope and compaction",
      "state": "covered",
      "test": "test/memory-corrections.test.js",
      "scenario": "stream/global/project pin selection, other-project exclusion, explicit search and compaction preservation",
      "gate": "fast"
    }
  ]
}
