# Station design persistence investigation

Customer report: a station design reverted and the user's build changes disappeared. The owner relayed this report on 2026-09-19; the customer's version, operating system and exact interruption are unknown. Durable record: [996e399b](../bugs/996e399b-station-design-edits-disappear-when-build-is-int.md).

## Finding

On baseline `acbf3c225` (source version 0.12.3), Build's model-change subscription invalidated its rendering caches but did not persist changes. The editor saved on `close()`; unrelated conversation or configuration actions could also save the current station. Consequently a long uninterrupted editing session could remain entirely in memory, and reload or renderer termination could restore an older layout. The existing unload transport could only flush documents already queued by App.persist; it could not recover never-serialized Build edits.

This is a proven source defect consistent with the report, not proof of the original customer's exact cause. The sidecar already protects writes with revisions, atomic replacement, a previous-save backup and conflict preservation. Those protections cannot preserve a design the editor never submitted.

## Repair

Source commit `fb02b1e7d` subscribes App persistence to canonical WorldModel changes. It coalesces synchronous operations within one browser event with a microtask, immediately writes the final document to the local cache, and queues the existing debounced durable sidecar write. This covers station edits even when Build is closed, plus undo/redo and layout replacement. Reentry unsubscribes the old model.

App.persist now reports local-write failure and avoids flashing saved. SAVE & EXIT only reports success when the local write succeeded and explicitly labels it saved locally. Normal durable retry and conflict handling remain in CloudSave.

The generated website frontend mirror is synchronized. `4d555826f` updates only the two changed release-surface hashes and their source commit; claim verdicts are unchanged.

## Live evidence

Isolated worktree `C:/Users/andro/gen-trees/station-save-0919`, seeded backend port 8939. No installed or customer station files were edited.

- Before: apply QUIET RETREAT; editor readout changes from 1 room/198 tiles/8 objects to 2 rooms/1 hall/408 tiles/12 objects. Disk remains at 8 props. Reload without SAVE & EXIT returns to 1 room/8 objects.
- After: same interaction writes 12 props and all three room records, including the hall, to disk at revision 7 while Build is open. Reload preserves the complete new layout.
- Stop the owned sidecar process and relaunch with `node dev/seed.js --keep`. A fresh browser origin, `localhost:8939`, distinct from the original `127.0.0.1:8939` cache, restores the 2-room/12-object layout from disk.
- Apply DEFAULT, undo, redo: readouts are 1 room/8 objects, 2 rooms/12 objects, 1 room/8 objects.
- Apply amber PLANK deck through the editor. Disk stores `floorStyle: amber`, `floorMat: plank`; reload retains the rendered plank floor without SAVE & EXIT.
- Stop the test backend, apply QUIET RETREAT in the still-open editor, restart the backend, reload: the dirty local design remains 2 rooms/12 objects and subsequently reaches disk at revision 19.
- Browser error-level console inspection was empty before the deliberate network interruption.

## Validation and limits

Production App/Save/WorldModel regression: `test/station-autosave.test.js` PASS. It checks appearance, placement/movement/removal, undo/redo, presets, synchronous coalescing, reentry subscription cleanup, quota-failure honesty and retry. Customer journeys: 36/36 PASS. Changed JavaScript syntax and `git diff --check` PASS.

Initial fast run stopped at 291/819 because the two modified frontend files no longer matched the advertised-claims source hashes. Direct comparison proved baseline claims planning PASS and candidate planning blocked only by these two hashes. They were refreshed after review.

Final `npm run test:fast` on source candidate `4d555826f`, Node 24.19.0: **819/819 PASS**, exit 0. Receipt: `.station-save-fast-final.log` in the owned worktree, ending `run-fast-tests: OK — 819 step(s) green`. Customer-journey receipt: `.station-save-journeys.log`, ending `run-test-list: OK — 36 step(s) green`. No test limits or assertions were relaxed. The final evidence commit changes documentation and the bug register only.

No integration merge, installer rebuild or publication was performed. Installed Windows/macOS acceptance, abrupt operating-system/power-loss durability and the affected customer's recovery are unverified. Recovering an already-lost design requires examining that user's cache, prior layout backup and durable save/backup/conflict copies; none were supplied.

## Owner-requested merge regression review

The owner subsequently requested integration and a check for newly introduced issues. Test-only commit `0b98366e5` adds coverage for rejected edits, 500 synchronous mutations producing one final save, replacing the station with an old save microtask still queued, and autosaving while a crew member and another session are focused. These checks pass: no old station resurrection, loss of the hero identity, crew roster or active session content was found. Eleven focused save/recovery suites passed again.

A live conversation draft remained intact and editable after a Build preset change and SAVE & EXIT. The same check passed on the candidate combining station autosave with the separately owned chat-cutoff repair (`ebea9738f`); the layout reached disk with the same hero and active session at revision 27. The browser's selector-evaluation call timed out twice after closing Build, but native accessibility inspection and immediate typing proved the page responsive with the original draft intact and no error-level console entries. No application patch was needed for that inspection failure.

Integration was queued behind the existing chat-cutoff merge reservation. The isolated combined candidate contains both regression suites; its generated bug index was regenerated and validated, and its source audit retains both lanes' reviewed hashes. Final merge and gate receipts follow in the completed integration record.
