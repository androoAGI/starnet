# Pre-equipped station onboarding — 2026-09-15

## Behavior

The optional quick tour has two lessons: equipment already in the agent's area, then COMMS and basic building. It never enters the legacy prop-placement loop. All five essential abilities get a short purpose; room-scoped inventory determines which descriptions appear. Edited stations and unavailable inventory have separate messages. Equipment presence does not assert service connection or runtime access.

Next and Finish remain visible in a short COMMS panel; only lesson text scrolls. The tour does not set activity to WORKING or IDLE. A fresh user's typed first task survives the optional tour and returns in the same editable review. Only explicitly clicking Start submits it. Replay can return to COMMS or explicitly selected first-task recipes. No placement checklist or connector pitch follows completion. Reload no longer resurfaces the old checklist for returning users. Earned progress remains stored.

The file example is optional, preflighted, and asks to preserve an existing `starnet-welcome.txt`. Approval wording reflects access settings. Narration only begins after an explicitly launched example receives a matching agent start, and completion follows the captured run ID. Denial is correlated by prompt ID. Timeout and failure text make no unsupported claims about file contents or the cause of a connection failure.

## Verified

- Live preview at `http://127.0.0.1:18845/`, SYSTEM → FIELD MANUAL → REPLAY QUICK TOUR: all five labels appeared on the existing furnished station; no builder opened and station remained ONLINE / IDLE.
- At approximately 830 × 912, all five labels and Next / Finish were visible. The shortened second lesson and all three actions fit in COMMS.
- Finish returned to COMMS with no follow-up overlays. Reload did not restore the old placement checklist.
- Choose my first task opened the existing draft-from-notes Recipes surface. No provider run was submitted in the live preview.
- `tutorial-equipped-station.test.js` drives the actual module: full, partial, empty and unavailable inventories; skip, replay, useful-task handoff, unavailable model, demo event ownership, denial and timeout. It is registered in `test/fast.list`.
- Focused checks passed: onboarding, onboarding-refresh, onboarding-legibility, tutorial-platform-guide, tutorial-connect-beat, kitout, refit-flow-polish; syntax checks and `git diff --check` passed.

## Integration sweep — 2026-09-15

Synchronized `agent/station-default-0915` with trunk `90d6f0111931ec3991aaba28d580422b4b02a81b` by merging trunk into the isolated worktree. The remastered texture pack and trunk's additional floor, wall, and shell materials coexist. Optional material failures do not disable the core remaster. The official website sync mirrors all 6,001 frontend files and preserves the two embed-only files. Shared events/schema have no diff against trunk.

The sweep fixed a tour-to-first-task handoff that opened a generic form instead of restoring the typed draft, and a false save conflict after an immediate reload. For the latter, an identical durable payload proves that an unload save landed even when its acknowledgement was lost; any different station, roster, or conversation still follows conflict preservation. Regression coverage includes genuine two-window conflicts and subsequent writes after reload.

The claims audit now batches authority searches and reuses immutable Git blobs without dropping paths, binary checks, or verdicts. Source locks were refreshed with the existing relock tool. Earlier stale-lock failures and interrupted audit attempts are superseded only by the completed final gate recorded below.

The integrated renderer tests now include the real surface-mount helper and the material-ID-plus-paint shell API. Remaster review labels name the bundled VT323 font; three review-tool manifest requests check HTTP success before parsing. Native shell fallbacks and the unchanged palette behavior are covered explicitly. Incidental QA-history line-ending changes were removed.

### Live proof

- A separate real sidecar with an empty workspace and isolated profile completed fresh onboarding through the browser. No existing account or preview save was reset.
- Default station: one 18 × 11 room, 198 tiles, eight objects: workstation, all five capability props, two plants. The quick tour explained the installed equipment without asking for prop placement.
- Typed `Make a checklist: review the draft, check spelling, send the summary.`, took the optional tour, and returned to the identical editable draft. No task started during the tour or on return.
- Clicking Start submitted that exact task and produced a harness-confirmed completed run using the deterministic local `onboarding-fixture` provider. This verifies transport and lifecycle, not external model quality. The optional provider-backed file example was not exercised in this live pass.
- Reload retained the agent, station, and conversation without restarting onboarding or showing the old placement checklist.
- Applied Creative Studio: three rooms, two halls, 615 tiles, 27 objects. No mandatory workflow configuration opened. Save/reload retained it. Restore Previous returned the normal default room. Immediate save/reload after the fix retained that room without a false conflict warning.
- Build Mode's spacious prop library and merged material picker rendered in the live app. The original preview at port 18845 was restarted with `node dev/seed.js --keep`; its Creative Studio remained intact, ONLINE, with no captured console errors.

### Gate receipts and handoff

- Final code gate candidate: `86afcfc6403ae2750732c6169bf110ef1ace98be`; includes persistence fix `5f498be97` and renderer/test cleanup `4ceb99166`. The following receipt-only documentation commit does not change tested code.
- `npm run test:http`: PASS, all 116 steps, including the real Creative Studio sample-job harness test. Log: `.dogfood/build-interactions/sweep-http.log`. The later reload fix touches frontend persistence only; its concurrency/unload/refusal tests also passed.
- Final `npm run test:fast`: PASS, all 806 steps, exit 0; ran 22:06–22:16 EDT on 2026-09-15. Includes the previously failing claims, tutorial, lighting, shell, font, and fetch-truth checks. Log: `.dogfood/build-interactions/sweep-fast-final.log`; process receipt: `.dogfood/build-interactions/sweep-fast-result.json`.
- Website mirror check and strict JSON/no-BOM checks passed.
- This earlier handoff was superseded by the September 16 integration below.

## Final integration — 2026-09-16

Merged current graphics trunk `67eb99bdf6605eadb82e385d8285acebc4e17916` into the isolated station worktree, retaining the spacious browse-first Build library alongside trunk's inline object controls and updated authored artwork. Escape now cancels a selected object or click-to-move before leaving Build Mode. The audit preserves both batched immutable-blob reads and bounded UTF-8 streaming checks.

- Candidate and actual integration SHA: `6b05fa8486be91c424d196f6a8218fe49cad7ee0`. `feat/harness-backend` fast-forwarded to this commit; unrelated dirty queue, QA and handoff files were preserved.
- Pre-merge `npm run test:fast`: PASS, 808/808 steps, exit 0, 00:59–01:10 EDT. Receipt: `.dogfood/build-interactions/merge-final-result.json`; log: `.dogfood/build-interactions/merge-final-fast.log`.
- 166 integrated scripts passed syntax checks. Build selection handlers are defined once. The 808-step manifest has no duplicate commands. Website mirror includes 11,895 frontend files. No sidecar or shared-contract diff from current trunk; the earlier 116-step HTTP proof remains applicable to this lane.
- Live at port 18845: larger three-column prop library, seven presets, inline prop actions, Move then Escape returning to selection without leaving Build Mode, and unchanged layout after browsing presets. The two-step quick tour explicitly lists the five installed essentials, explains optional conveyors, and finishes with the agent idle. Reload returns ONLINE without restarting onboarding or displaying a save-conflict warning. Preview frontend exactly matches merged trunk.
- The first full gate attempt stopped on a key-shaped string in an agent-created temporary copy of an existing QA note. That redundant copy was removed; evidence lint and the complete rerun passed. The source QA note was not changed.
- Post-merge `npm run test:fast`: PASS on the integration tree, 808/808 steps, exit 0, 01:11–01:23 EDT. Receipt: `.dogfood/build-interactions/postmerge-result.json`; log: `.dogfood/build-interactions/postmerge-fast.log`. The following receipt commit changes documentation only.
