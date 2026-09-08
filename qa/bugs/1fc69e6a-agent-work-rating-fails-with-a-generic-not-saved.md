---
fingerprint: 1fc69e6a
slug: agent-work-rating-fails-with-a-generic-not-saved
title: Agent work rating fails with a generic not saved message
surface: sessions
severity: P2
status: fixed
found: 2026-09-07
lane: agent/rating-repair-0908
fix: a55a1ed07
origin: customer
report: Owner relayed reports from two different customers on 2026-09-08; rating all agents failed after updating, and one reported spontaneous recovery after about half an hour.
affected: Customer-reported 0.11.0; platforms unknown
family: work-rating
installer: unverified
recovery: unconfirmed
---

# Agent work rating fails with a generic not saved message

## Symptom

Two separate customers reported that agent ratings failed with "Rating was not saved" after updating. One reported that ratings started working after roughly half an hour without intervention. The earlier investigation commits 6f052299c and c0083700a recorded the symptom and error masking but did not repair it; those records had not reached integration.

## Repro

Run `node test/growth-rating-upgrade.e2e.test.js`. It boots the real sidecar with a local deterministic provider, stores a legacy save without hero.createdAt, completes hero and specialist runs, and executes the production App.resumeInto function with rendering stubbed. An ahead-of-clock save timestamp deliberately keeps the ordinary background save refused, modeling a delayed write-through without waiting thirty minutes. This condition is fault injection, not a claim about either customer's clock.

Before the repair, resumeInto invents hero.createdAt from save.updatedAt. XpStore sends that new value while the server still owns legacy growth epoch 1. Both real runs receive HTTP 409 and the UI hides the reason. The mismatch lasts until the unrelated full-station save succeeds. Resuming should not found a new station or move its rating history to a new generation.

## Evidence

Before source change on 63179b5ce: the real-run HTTP regression failed six checks, including both hero and specialist submissions returning `{ok:false,error:"rating was not saved"}`, zero durable ratings and zero ratings after restart.

Live source app on loopback :8978, launched with `node dev/seed.js --keep` and a local deterministic provider: a real fs.list task completed with toolsOk=1, reason=done, runId dcd91010-cae2-48e7-af81-a9ce9658cd46. Clicking the real "nailed it" control displayed "Rating was not saved". The delayed legacy-save fixture remained in place throughout the before/after check.

After repair, a second real fs.list task (efda4881-d4f3-4558-b65f-9ce314e8ffba) displayed "★ +XP" on the same live control. The exact previously failing run also saved through production XpStore against the same server: `{samePreviouslyFailedRun:true,epoch:1,verdict:"great",applied:true,serverCreationDateStillMissing:true,backgroundSaveStillFuture:true}`. Both fsynced rows were read from growth-ratings.jsonl. After a real sidecar restart using the same scratch data on :21978 and a fresh browser origin, the live GROWTH panel showed level 2, 60 total XP and 2 positive ratings; the BRIEF panel kept the unknown founding date as an em dash.

Current regression: test/growth-rating-upgrade.e2e.test.js passes 24 assertions, including persisted roster identity, existing legacy feedback replay, hero and specialist ratings while save is blocked, duplicate handling, restart persistence, and rejection of stale identities after a genuinely new station is created. test/xpstore.test.js passes 89 assertions; test/work-rating-control.test.js passes 5.

Full integrated-candidate gates: test:fast 733/733 and test:http 105/105, exit 0. The rating customer journey is registered in both the HTTP gate and the customer-journey campaign.

Source anchors: frontend/app/app.js resumeInto preserves unknown creation dates; frontend/app/xpstore.js recordWorkRating parses failed HTTP responses; frontend/app/chat.js workRateControl displays the returned actionable error and preserves retry controls.

## Verdict

A repeatable legacy-update failure is reproduced and repaired in source. Existing station identities and rating history remain unchanged on resume; only new-Commander creation mints a new identity. Backend generation checks remain intact. Generic error masking is also repaired for stale identity, missing/ineligible run, authentication, unavailable history, and transport failures.

This establishes the mechanism in a controlled installation, not the precise cause on either customer's machine. Their original save metadata and failed HTTP responses are unavailable. No installer or customer recovery is claimed, and spontaneous recovery is not proof of a shipped fix.

## Regression

The unchanged application rejected both real completed runs before the background save succeeded. The repaired application rates them in their original generation immediately, retains prior ratings, and replays the ledger after restart. Failed requests award no XP; the UI keeps all three verdict buttons retryable and shows the actual class of failure.

## Sibling coverage

{"adapters":[{"target":"shared rating HTTP adapter across model providers","state":"covered","test":"test/xpstore.test.js","scenario":"409, 404, 403, 503, 500, invalid JSON and offline responses do not mint XP and preserve actionable errors","gate":"fast"},{"target":"real local OpenRouter-compatible run transport","state":"covered","test":"test/growth-rating-upgrade.e2e.test.js","scenario":"real hero and specialist runs reach the durable rating endpoint","gate":"http"}],"entrypoints":[{"target":"lead and specialist work ratings","state":"covered","test":"test/growth-rating-upgrade.e2e.test.js","scenario":"both agents rate before a delayed background station save succeeds","gate":"http"},{"target":"shared COMMS and outbox rating control","state":"covered","test":"test/work-rating-control.test.js","scenario":"production shared control displays rejection, keeps all verdicts retryable and accepts retry","gate":"fast"}],"displays":[{"target":"browser and website mirror","state":"covered","test":"test/website-app-sync.test.js","scenario":"website copy matches the repaired frontend","gate":"fast"},{"target":"customer Windows/macOS installer","state":"blocked","reason":"No installer was built or exercised for this source repair; customer platforms and original failing installation metadata remain unavailable."}],"lifecycle":[{"target":"legacy update, held save, existing feedback, restart and fresh station","state":"covered","test":"test/growth-rating-upgrade.e2e.test.js","scenario":"legacy epoch remains stable, prior feedback replays, ratings survive restart, duplicates do not mint twice, and fresh station generation checks remain enforced","gate":"http"}]}
