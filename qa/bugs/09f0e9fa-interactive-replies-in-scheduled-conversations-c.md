---
fingerprint: 09f0e9fa
slug: interactive-replies-in-scheduled-conversations-c
title: Interactive replies in scheduled conversations cannot be rated
surface: sessions
severity: P1
status: fixed
found: 2026-09-16
lane: release-0120-prep-0915
fix: da0658486
origin: customer
report: https://github.com/androoAGI/starnet/issues/18
affected: v0.11.2 Windows, source 69baf91a5b2c22230f87e614da6a72882278bc6c
family: work-rating-origin
installer: unverified
recovery: unconfirmed
---

# Interactive replies in scheduled conversations cannot be rated

## Symptom

Interactive replies in a conversation containing scheduled work repeatedly reject ratings with “This task is not in the saved run history, so it cannot be rated.” The completed runs exist. GitHub #18 was created September 16, 2026 UTC and imported during the 0.12.0 preparation follow-through.

## Repro

1. Run a routine, then continue its `cron-` conversation through the interactive run endpoint.
2. Submit a rating for the new completed interactive run.
3. On the pre-fix source, the saved run is classified as internal by its conversation prefix and the rating endpoint returns 404. The same failure occurs for `nightshift-` and `workshop-` conversations.
4. After repair, repeat, restart the sidecar, and resubmit the rating: the first verdict persists and duplicate XP is not minted.

## Evidence

`test/growth-rating-upgrade.e2e.test.js` drives the real sidecar, local controlled provider, durable run and rating stores, and process restarts. Before the source change: 11 failed assertions, 40 passed; all three interactive prefixes returned `rateable run not found`. After repair and expanded scheduled/legacy controls: 57 assertions pass. The expanded test actually creates and runs a routine, then uses that exact saved stream for the interactive continuation. `test/xpstore.test.js` passes 107 assertions, `test/runstore.test.js` 95, and the shared rating-control test 5. Raw receipts: `.dogfood/release-followthrough/rating-before.log` and `rating-after.log` in the owned preparation worktree.

Cause: `handleGrowthRatings` and `withRunTruth` in `sidecar/index.js` applied `contextpack.isInternalStream` to every run, including new interactive continuations. The durable row did not retain the run's host-selected surface.

## Verdict

Source-fixed by `da0658486`: persist the host-selected interactive/autonomous surface, use it for individual run eligibility and history projection, and preserve internal, scheduled, generation and completion safeguards. The browser catch-up projection uses the same distinction. Error copy separates missing history, internal activity, scheduled activity and unknown legacy origin. The generated website copy is synchronized.

This does not retroactively invent provenance for older saved replies. An old prefixed row with no saved origin remains ineligible with an explicit explanation. No customer recovery, installed update or final 0.12.0 readiness is claimed.

## Regression

The real routine remains autonomous and ineligible under existing policy; its new interactive continuation rates normally. Internal self-talk and nonexistent runs still fail closed. Historical rows without origin are not promoted during restart. Three continuation ratings survive restart and retain their first verdict. Full release gates are tracked in `docs/releases/0.12.0/FOLLOWTHROUGH.md`.

## Sibling coverage

{"adapters":[{"target":"provider-independent durable rating endpoint","state":"covered","test":"test/growth-rating-upgrade.e2e.test.js","scenario":"real sidecar and controlled provider execute scheduled work and interactive continuations","gate":"http"}],"entrypoints":[{"target":"routine, night-shift and workshop conversations","state":"covered","test":"test/growth-rating-upgrade.e2e.test.js","scenario":"new interactive replies rate individually; internal and scheduled runs remain excluded","gate":"http"}],"displays":[{"target":"rating errors and progression catch-up","state":"covered","test":"test/xpstore.test.js","scenario":"origin-specific errors and interactive catch-up preserve scheduled and legacy exclusions","gate":"fast"}],"lifecycle":[{"target":"durable ratings and ambiguous historical origin","state":"covered","test":"test/growth-rating-upgrade.e2e.test.js","scenario":"restart retains first verdict without duplicate XP; missing legacy origin stays unknown","gate":"http"},{"target":"affected Windows installation","state":"blocked","reason":"No candidate installer or customer recovery receipt yet."}]}
