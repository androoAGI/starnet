# Sprint 0 baseline and gate receipts

## Baseline identity

- Experiment: `AU-UCR-EP-000001`
- Sprint: `S0`
- Capture branch: `cursor/ucr-s0-execution-3141`
- Baseline authority branch: `feat/harness-backend` (remote HEAD)
- Baseline commit: `fbddbf992f8e7082196f07c3024781fcf1c276fc`

## Manifest baselines

- `test/fast.list` active entries: `953`
- `test/http.list` active entries: `156`
- `test/customer-journeys.list` active entries: `38`

## Gate receipts (captured)

Raw logs are captured in the run artifact directory:

- `/opt/cursor/artifacts/au-ucr-ep-000001-s0-test-fast.log`
- `/opt/cursor/artifacts/au-ucr-ep-000001-s0-test-fast-after-install.log`
- `/opt/cursor/artifacts/au-ucr-ep-000001-s0-test-fast-verified.log`
- `/opt/cursor/artifacts/au-ucr-ep-000001-s0-test-http.log`
- `/opt/cursor/artifacts/au-ucr-ep-000001-s0-test-http-after-install.log`
- `/opt/cursor/artifacts/au-ucr-ep-000001-s0-output-recovery-single.log`

## Baseline execution notes

1. A fresh clone lacked installed npm dependencies, causing early gate failures (`MODULE_NOT_FOUND` for `ajv` and `ogg-opus-decoder`).
2. After `npm ci`, gate execution proceeded further and surfaced environment and baseline test failures.
3. `test:fast` was rerun with explicit `pipefail` and `SKYNET_CHROME=/usr/local/bin/google-chrome` to produce reliable exit evidence.

## Current baseline gate outcome

- `npm run test:fast`: **FAIL** at `test/crt-context-loss.e2e.test.mjs`
  - Observed failure mode: WebGL fallback path did not satisfy expected lit WebGL start state.
- `npm run test:http`: **FAIL** at `test/output-recovery.e2e.test.js`
  - Observed failure mode: uses `type flood-a.txt` and receives `not found` in this Linux environment, cascading receipt assertions.

These are baseline defects/environment mismatches observed before any UCR implementation changes.

## Impact on S0

- Baseline is independently reviewable and reproducible (commands, manifests, and receipts are captured).
- S0 does **not** declare trunk green; it records pre-existing gate blockers that must be dispositioned by owner/reviewer policy before promotion gates that require all-green status.
