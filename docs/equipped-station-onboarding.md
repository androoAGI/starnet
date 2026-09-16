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

- Final gate candidate: recorded in `.dogfood/build-interactions/sweep-fast-result.json`; includes persistence fix `5f498be97` and the subsequent renderer/test cleanup.
- `npm run test:http`: PASS, all 116 steps, including the real Creative Studio sample-job harness test. Log: `.dogfood/build-interactions/sweep-http.log`. The later reload fix touches frontend persistence only; its concurrency/unload/refusal tests also passed.
- Final `npm run test:fast`: pending. Log: `.dogfood/build-interactions/sweep-fast-final.log`.
- Website mirror check and strict JSON/no-BOM checks passed.
- No branch-to-trunk merge has been performed. Trunk has unrelated uncommitted handoff/queue edits; these remain untouched. Recheck trunk's SHA and serialize integration before merging. A new trunk commit requires another synchronization and gate pass.
