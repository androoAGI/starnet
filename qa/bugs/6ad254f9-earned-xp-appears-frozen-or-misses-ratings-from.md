---
fingerprint: 6ad254f9
slug: earned-xp-appears-frozen-or-misses-ratings-from
title: Earned XP appears frozen or misses ratings from another window
surface: sessions
severity: P2
status: open
found: 2026-09-14
lane: agent/xp-status-0914
fix:
origin: customer
report: Owner relayed a new customer report on 2026-09-14: misses the XP system working. Exact failing action is unknown.
affected: Unknown customer version and platform; reproduced on source 7a087d3be
family: work-rating
installer: unverified
recovery: unconfirmed
---

# Earned XP appears frozen or misses ratings from another window

## Symptom

Customer says they miss XP working; their exact version/action is unavailable. The investigation reproduced an open Growth panel showing old XP after a successful rating, and a second window permanently missing another window's acknowledged rating after it submits newer feedback.

## Repro

1. Launch an isolated station with `node dev/seed.js --keep` and a deterministic local tool-capable provider. Complete and positively rate two tasks, reaching 60 XP / level 2.
2. Keep the dossier Growth tab open. Complete and rate a third task. Before repair the saved agent has 90 XP / three approvals, but the open panel still shows 60 XP / two approvals.
3. Open another station window at 90 XP. Rate a fourth task in the first window, then a fifth in the second. Before repair the second projection has only four approvals (129 XP / level 2) despite five durable ratings. Reloading retains that missing credit.
4. `node test/growth-rating-upgrade.e2e.test.js` reproduces the checkpoint failure with real sidecar runs, the production XP adapter and a real process restart.

## Evidence

Live source baseline 7a087d3be, isolated loopback :21980. Third run 139b9811-43ea-4c74-9260-2fc61a9cae90: clicking the actual control showed `★ +XP`; `agent.save.json` held `{xp:90,level:2,ratings:3}`, while the already-open panel still showed `60 total XP` and `POSITIVE FEEDBACK 2`.

Fourth/fifth runs 095610d9-2fe8-4bb9-808e-4816ad29967a and c8f4b458-b2a8-457c-8312-9d6e6e6826e3 demonstrated the lost-rating checkpoint across two browser windows. Before the XP-store repair, the updated real-run regression failed: expected 129 XP, got 90; expected four hero approvals, got three (plus one specialist approval). After the repair it passes 31 assertions.

Live after repair: the already-open Growth panel advanced from 90 to 129 XP without crossing a level; recovery of the previously stranded second-window projection displayed `168 total XP`, five approvals and level 3 (`18 / 150 XP`, `132 XP TO LV 4`). The actual second rating had earlier displayed NOVA REACHED LEVEL 2 and the crew rail changed to Lv 2.

Source seams: `frontend/app/stationui.js` refreshGrowthLive / refreshDossierLive; `frontend/app/xpstore.js` recordWorkRating / syncRatingHistory / init. Regressions: test/dossier-growth-live.test.js, test/xpstore.test.js, test/growth-rating-upgrade.e2e.test.js. Local detailed receipts are retained in `.dogfood/xp/` in the owning worktree.

## Verdict

The open dossier refreshed only status, not XP or kudos. The rating adapter incorrectly treated a single acknowledgement as proof that all preceding ratings had been consumed. Repair refreshes read-only progression independently of editors and advances the rating checkpoint only after a complete history snapshot. Older checkpoints receive one safe replay when the saved receipt history has not reached its eviction cap. Capped histories retain their prior checkpoint rather than risking duplicate awards; older missing receipts in that exceptional case are not claimed recovered. The new customer's exact cause and recovery remain unconfirmed. Source verification is in progress; no installer or public release is claimed.

## Regression

Before: ordinary positive feedback left the open panel stale, and a later local rating could permanently hide earlier external feedback behind its checkpoint. After: XP/kudos repaint during the existing dossier tick; canonical history is folded chronologically, local feedback celebrates once, failed history reads preserve the previous checkpoint, and restart recovery retains all acknowledged ratings without duplicates.

## Sibling coverage

{"adapters":[{"target":"provider-independent XP and rating adapter","state":"covered","test":"test/xpstore.test.js","scenario":"canonical rating, unavailable history, rejected writes, duplicate acknowledgements, old checkpoint recovery and capped receipt safety","gate":"fast"}],"entrypoints":[{"target":"lead and specialist ratings with another window's feedback","state":"covered","test":"test/growth-rating-upgrade.e2e.test.js","scenario":"real hero/specialist runs, interleaved remote/local ratings and restart","gate":"http"},{"target":"shared COMMS/outbox rating control","state":"covered","test":"test/work-rating-control.test.js","scenario":"failed submission remains retryable and successful retry shows XP","gate":"fast"}],"displays":[{"target":"open Growth and Brief dossier","state":"covered","test":"test/dossier-growth-live.test.js","scenario":"ordinary XP, threshold, kudos, level and selected-agent refresh","gate":"fast"},{"target":"shipped Windows/macOS installer","state":"blocked","reason":"No rebuilt installer was installed; customer version/platform and original failing action remain unknown."}],"lifecycle":[{"target":"legacy station, reload and sidecar restart","state":"covered","test":"test/growth-rating-upgrade.e2e.test.js","scenario":"legacy identity, delayed saves, acknowledged ratings, cross-window checkpoint and real process restart","gate":"http"},{"target":"very old missing ratings after dedupe receipt eviction","state":"blocked","reason":"Automatic historical replay is deliberately withheld when any consumer has reached the receipt cap; evicted acknowledgements cannot safely be distinguished from missing credit."}]}
