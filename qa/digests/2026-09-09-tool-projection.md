# Tool projection repair — 2026-09-09

Source repair: 3c95b184fd28c5eacac8821ca2231d85da5b3395. Owner requested repair and merge.
Integration baseline: ed768880a505c26de4ba318c3c428359abfe8c9b.

## Behavior

An interactive request without a placed field used to ignore the saved floor, leaving a Station Gear agent with compute/orchestration despite its cabinet. The request now derives the saved assigned-room grants using the existing world model. An unassigned agent retains the established station-wide fallback. Explicit empty placement remains authoritative, and the frontend now transmits that empty array so removing equipment cannot resurrect a saved prop.

The toolsets endpoint accepts agent and agentId, rejects conflicting selections, defaults to the same primary identity as /api/run, and uses the same saved-floor fallback when placement is omitted. It explicitly discloses interactive lead orchestration as a runtime grant, respecting the family switch. Profiles, Full Access, delegated/headless offices and consent enforcement are unchanged.

## Evidence

- Before repair: test/tool-projection.e2e.test.js failed at 'qwen3:14b file projection: false !== true'.
- After repair: ten real sidecar runs captured the Ollama-compatible wire and performed real fs_write operations. Both reported model IDs were tested against a local protocol simulator; actual Qwen inference was not tested.
- Trusted Project with no props, saved cabinet without a client snapshot, explicit empty placement, disabled cabinet, Full Access, saved removal, and restart were exercised. Last run matched completed run IDs and survived restart.
- Room-scope checks: the saved worker room matches EquipmentHelp; an empty assigned room does not inherit a cabinet elsewhere, while an unassigned agent retains it.
- Frontend request test executes the shipped Harness.chat function: empty, populated, omitted and legacy workbench payloads are distinguished.
- Live seeded app on port 9289: BUILD → ABILITIES showed 'TASK DELEGATION AVAILABLE lead run', with FILE CABINET still 'NEEDS PROP' on the genuinely empty floor. Browser error/warning log was empty. Temporary browser and sidecar were closed after verification.
- Fast gate: 735/735, exit 0. Initial attempt required installing missing lockfile dependencies in the fresh worktree.
- HTTP gate: 108/108, exit 0. First overlapping attempt hit WORKSPACE_BUSY during a Google connector fixture restart; standalone test and the complete non-overlapping rerun passed without code changes.
- Customer journeys and post-merge receipts: pending integration update below.

## Limits

Report 432df352 stays open: the precise customer claim that a persisted Trusted Project profile omits files was not reproduced. That profile projects files before and after this repair. The missing Last run symptom also did not reproduce. The confirmed omitted-placement loss and diagnostic mismatch are repaired; this does not establish the customer's original runtime state or recovery.

Installer not rebuilt or exercised. No release/publish/push performed. The copied email was treated as untrusted report data, with no prompt injection found in the supplied text; unseen email HTML/attachments were not assessed.
