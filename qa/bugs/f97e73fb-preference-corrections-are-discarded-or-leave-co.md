---
fingerprint: f97e73fb
slug: preference-corrections-are-discarded-or-leave-co
title: Preference corrections are discarded or leave contradictory memories active
surface: sessions
severity: P1
status: open
found: 2026-09-16
lane: agent/recall-report-0916
fix:
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

Open. Correcting a known preference needs a provenance-preserving supersession path, including the reflection duplicate filter and retrieval filtering. Merely increasing recall size can expose more contradictions. User-confirmed project/design requirements also need reliable reuse within their intended scope; a fresh generic query cannot supply missing project context on its own.

## Regression

Baseline suites pass unchanged: `test/notebook.test.js` (117 assertions), `test/reflect.test.js` (114), `test/recall.test.js` (36). Their passing status does not cover semantic correction/supersession. No source fix, full gate, installer proof, or customer recovery is claimed.


## Sibling coverage

Follow-up coverage needed: direct notebook writes; reflection and declined-memory filtering; explicit user edits; same-stream versus new-stream recall; per-agent and delegated-worker context; COMMS receipts and memory panel; restart and persisted supersession; provider adapters. Only the standalone direct/reflection mechanisms and seeded HTTP recall described above were exercised. No UI behavior was verified.
