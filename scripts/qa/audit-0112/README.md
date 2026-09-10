# 0.11.2 audit reproductions

Run from the repository root on released v0.11.1. These harnesses capture defects; successful harness exit does not mean the product defect is fixed. They are deliberately not registered as passing product gates. Convert the captured invariants into normal regressions when repairing them.

Use an isolated worktree, installed lockfile dependencies and a disposable profile. Never run against a customer station. The media harnesses use SidecarFixture, real temporary files and local simulated providers; they make no paid request. They dispose of their own fixture directories.

- `node scripts/qa/audit-0112/image-ledger.cjs`
- `node scripts/qa/audit-0112/image-cancel.cjs`
- `node scripts/qa/audit-0112/byok-recovery.cjs`

For the browser harness, launch `node dev/seed.js --keep` in this worktree with `SKYNET_DEFAULT_MODEL=replay`, an unused `SKYNET_PORT` (19312 was used), and disposable APPDATA/LOCALAPPDATA profile roots. The seed warns that replay is not in the public OpenRouter catalog; these UI checks do not make inference calls. Supply `STARNET_PLAYWRIGHT_MODULE` and `STARNET_CHROME` to use locally installed Playwright/Chrome if needed, then run:

`node scripts/qa/audit-0112/live-probes.cjs http://127.0.0.1:19312/`

It drives Settings resize/close/reopen through the DOM and fault-injects a delayed catalog through the real browser ModelDock/Harness interfaces. It changes provider/model selection in the disposable station, so do not reuse that profile as a real station. The browser closes; stop the seeded process separately when finished. Results go to `qa/evidence/0.11.2-audit/`; review them before committing new evidence.

The media ledger and cancellation harnesses derive from `test/managed-image.e2e.test.js`, retaining its normal restart/refusal assertions with added observation/fault injection. Optional STARNET_TEST_CLOUD_ROOT has the same meaning as that test; recorded audit evidence used the simulated gateway, not a production cloud account.
