---
fingerprint: f97e73fb
slug: preference-corrections-are-discarded-or-leave-co
title: Preference corrections are discarded or leave contradictory memories active
surface: sessions
severity: P1
status: fixed
found: 2026-09-16
lane: agent/recall-report-0916
fix: 3c8928e05
origin: customer
report: Anonymized customer complaint relayed by owner in local task on 2026-09-16
affected: Customer version model and platform unknown; investigated source 87e10e1fe on Windows
family: memory-corrections
installer: unverified
recovery: unconfirmed
---

# Preference corrections are discarded or leave contradictory memories active

## Symptom

A customer reports explicit corrections being forgotten, older memories resurfacing, and approved designs changing radically on later tasks. This record covers the reproduced correction/storage/recall mechanisms. The customer's actual transcript, model, installer, and design outputs were unavailable; their exact incident is not reproduced.

## Repro

1. Through `makeNotebookTools` in `sidecar/tools/builtin/notebook.js`, save title `Acme design`, body `User prefers rounded purple cards for Acme website design` for one agent.
2. Save the same title with body `User does not prefer rounded purple cards for Acme website design`. Observe the near-duplicate reply and unchanged notebook length of 1.
3. Follow the returned instruction and retry with `distinct:true`. Observe length 2, with both opposite preferences retained.
4. Call `reflect` from `sidecar/reflect.js` with the original preference in `existing` and a deterministic `propose` returning `PREFERENCE: User does not prefer rounded purple cards for Acme website design`. Observe `proposals: []`.
5. Boot `node dev/seed.js --keep` in an isolated worktree against a local OpenAI-compatible provider fixture. Restore the two notes using authenticated `/api/notebook/restore`; submit an ordinary `/api/run` for `Acme website design`. Inspect the provider request: both opposite notes are present in the recall fence.
6. In a fresh stream, submit `Make another one`. No recall fence is injected. This establishes a fresh-stream retrieval boundary, not loss of same-stream conversation history.

## Evidence

Source `87e10e1fe`, Windows, 2026-09-16. Local reproducer and receipts: `.dogfood/recall-report/{probe.cjs,result.json,boot.log}` in `agent/recall-report-0916`.

Direct tool receipt: `Not saved — you already remember something very close`; `countAfterCorrection: 1`. Retry receipt: `Saved note "Acme design" (note_2).` Stored bodies retain both the positive and negative preference. Reflection receipt: `reflectedCorrection: []`.

Live HTTP receipt: `memory.recall {count:2,chars:394}` and one `memory.used` for each note. The local provider captured both opposite preferences. The fresh generic request had neither a recall fence nor a `memory.recall` event. These were real sidecar runs with deterministic provider output, not live commercial-model quality tests.

Anchors: `sidecar/tools/builtin/notebook.js:136` skips the similar write; line 146 appends the override; line 153 describes the challenge. `sidecar/reflect.js:169` uses Jaccard similarity and line 170 discards the correction. `sidecar/index.js:17055` loads the agent-specific notebook and line 17059 caps recall at 1500 content characters. `sidecar/context.js:227` ranks at most eight records; zero lexical overlap excludes unpinned records. Ranking does not retire superseded facts.

The real tool's refusal is explicit, and its successful override receipt reflects an actual write. This investigation did NOT prove a false host save receipt; a model saying "saved" without making the necessary call remains an uncorrelated part of the report.

## Verdict

Source-fixed in 3c8928e05. Installer verification and customer recovery remain unverified/unconfirmed. This is a repair of the reproduced mechanisms, not proof of the customer's exact original conversation.

## Regression

Before: near-duplicate filtering discarded a negated preference and distinct:true left both opposites active. After: replaceId plus exact previousBody updates one record atomically, archives the old text outside recall and rejects stale/disk-failed writes. Reflection routes corrections to reviewed replacement, preserving pending metadata over restart. Pinned requirements follow their stream or trusted project; global preferences remain separate, and delegated task context receives relevant pinned references. Seeded writes, review, restart, stale-review rejection and manual UI Keep are recorded in qa/evidence/recall-report-0916/verification.json. Project ranking/compaction have focused deterministic coverage; arbitrary model design fidelity is not claimed.

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
