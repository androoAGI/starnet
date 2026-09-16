# 0.12.0 combined-build acceptance

Unchecked means owed. Each completed row needs candidate SHA, artifact identity where applicable, date, observable result and receipt path. Earlier lane receipts guide testing; they do not prove the final combination. Follow [the release runbook](../../RELEASE_RUNBOOK.md) and [readiness protocol](../../RELEASE_READINESS.md) for authoritative commands and release order.

## Preparation and merge handoff

- [x] Identify public base, baseline and existing/new report dispositions.
- [x] Draft user-facing notes and a traceable scope inventory.
- [ ] Refresh GitHub and private support intake; disposition every new symptom.
- [ ] Record final owner-selected overhaul tips and confirm their changes in the combined tree. Reconcile overlapping prop/sprite/starter branches by content.
- [ ] Record one final combined SHA and stop counting moving previews as acceptance.

## Existing 0.11.2 station → 0.12.0

- [ ] Start from an actual signed public 0.11.2 installation with a representative populated save; take and verify a closed backup. Record roster IDs, layouts/props/rotation/materials, conversations, projects, capabilities, routines/loops, goals/XP, settings and credential state without exporting secrets.
- [ ] Upgrade through Update Center. Confirm exact source/executable version, embedded frontend and bundled sidecar identity. A repo patch is not installed proof.
- [ ] Existing stations retain their chosen layout and state. New default/furnished presets do not silently replace old saves. Any intentional migration must be named and verified.
- [ ] Test old prop IDs/rotations, occupied seats, mounted objects, corridors/door openings, saved zoom/CRT settings and old skin selections under the new renderer; verify floor contact, click geometry and room containment.
- [ ] Restart normally and compare saved state again. Open old conversations, completed outputs, routines, goals and ratings; exercise fresh writes and prove persistence.
- [ ] Exercise update-check outage/retry, cancellation, interrupted download/install, backup/recovery and queued writes through the existing lifecycle harness. No destructive trial on the personal station.

## New aesthetic and product flow

- [ ] Fresh Commander: account/model → agent arrival → first useful task → open result → goal/progress follow-through. Test skip/replay without repeating setup or duplicating work.
- [ ] Every selected furnished preset: choose, place/rotate/remove, undo, save/restart; verify props grant the actual tools advertised. A prepared conveyor must run and deliver its claimed output.
- [ ] Build library: readable categories and previews, placement/cancel feedback, selection/rotation, keyboard Escape and reliable pointer targets under curvature.
- [ ] Remastered agents: all shipped skins, all walk directions, turns, idle/talk/sit cycles, crowded collisions and foot anchors; legacy settings and selections continue to work.
- [ ] Structural art: room/corridor joins, ceiling/wall masks, labels, seated/standing depth, object hitboxes, maximum zoom-out and enlarged UI. Review GPU/memory/frame performance on representative modest hardware.
- [ ] World truth: zones contain agents; gaze does not secretly move them; placed grants and capability displays reconcile; work/idle/approval/error states match backend events.
- [ ] Fresh screenshot set on the final candidate: hero/default station, furnished alternative, active real task + output, Build, and personal progress. Replace website/manual screenshots and terminology only with final observed behavior.
- [ ] Website demo remains generated from frontend; final marketing/manual links, mobile layout and platform download targets work. Do not advertise pending gallery/AI-building features.

## Bug and regression campaign

- [ ] Complete each row in [BUG_DISPOSITION.md](BUG_DISPOSITION.md); preserve separate source/installer/recovery outcomes.
- [ ] Run `npm run test:fast`, `npm run test:http`, `npm run qa:customer-journeys` on the final combined source; full HTTP is owed because this release changes sidecar and providers.
- [ ] Run the full Guardian and Beginner campaign on that candidate. Investigate audit failures before accepting image baselines; keep actual gameplay/permission assertions intact.
- [ ] Verify real-provider tasks across relevant managed/BYOK/local/OAuth adapters, outputs, errors, retry and restart. Simulated upstream tests do not establish live service or physical-device acceptance.
- [ ] Exercise supported Windows and macOS installers, microphone/voice, native credentials, permissions and relink. Mac-specific open boot evidence needs actual Mac acceptance or an explicit documented gap.

## Freeze, packaging and publication handoff

- [ ] Recheck target availability with read-only `npm run release:preflight -- --version 0.12.0`; resolve readiness/pin/mirror/claim drift using current receipts. Use `--allow-lane` only for the documented isolated preparation stage.
- [ ] Use the existing release ritual to move all five pins together; finalize root release notes, synchronize the generated website app, refresh source locks without changing claim verdicts, and earn fresh gates **after** the bump and **before** the tag push.
- [ ] Run source smoke/scale/release soak and attended installed acceptance under current policy. The 0.11.2 duration waiver does not apply to 0.12.0.
- [ ] Build the exact candidate with required signing/notarization. Record per-platform SHA-256 and provenance. Verify staged draft T0 clean install and G1 packaged lifecycle.
- [ ] Capture current canonical `npm run qa:ready` receipt; no readiness claim from a clean worktree with missing local evidence or an old installed stamp.
- [ ] Complete the explicit publication decision, then verify source release, public body/updater notes equality, signatures, all download URLs and public 0.11.2 → 0.12.0 Update Center canary. Retain backup and normal-restart evidence.

Preparation ends before publication. Nothing in this checklist is a waiver, a fabricated PASS or permission to reset customer data.
