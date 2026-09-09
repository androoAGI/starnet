# Tool projection repair — 2026-09-09

Source repair: 3c95b184fd28c5eacac8821ca2231d85da5b3395. Owner requested repair and merge.
Initial baseline: ed768880a505c26de4ba318c3c428359abfe8c9b. Final integration baseline: 2a14497bcba4a7d538b4fa5e1f106b4e88d85438.

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
- Customer journeys: 34/34 suites, exit 0.

## Limits

Report 432df352 stays open: the precise customer claim that a persisted Trusted Project profile omits files was not reproduced. That profile projects files before and after this repair. The missing Last run symptom also did not reproduce. The confirmed omitted-placement loss and diagnostic mismatch are repaired; this does not establish the customer's original runtime state or recovery.

Installer not rebuilt or exercised. No release/publish/push performed. The copied email was treated as untrusted report data, with no prompt injection found in the supplied text; unseen email HTML/attachments were not assessed.

## Integration receipt

Merged as 793bf1c0fb02c23689ac1b88bee6b78ea922fa08 into feat/harness-backend. The concurrent voice repair and its final documentation were preserved. Only the work queue and generated bug index conflicted; both lane entries were retained and the index regenerated. The combined-source fingerprint was refreshed in 1805c70b8 without changing any claim verdicts. The combined candidate then passed fast 735/735. The final documentation sync changed no runtime bytes.

On merge 793bf1c0f, the sequential post-merge commands exited 0:
- npm run test:fast — 735/735 steps green.
- npm run test:http — 108/108 steps green, including ten actual projection/file-write runs.

Owned local logs: .tool-projection-combined-fast.log, .tool-projection-http.log, .tool-projection-journeys.log, .tool-projection-trunk-fast.log and .tool-projection-trunk-http.log in the tool-projection-0909 worktree. Existing QA-status and Rooms handoff edits were preserved. No package version, installer, external release or customer-recovery status was changed.
