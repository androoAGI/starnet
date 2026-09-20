# 0.12.4 audit evidence

The final tested product candidate is `0c5f0d54a73122105ace05f9ca4627b5a94bb774`. See `docs/releases/0.12.4/AUDIT.md` and its validation receipt for scope and outstanding acceptance.

- `guardian-combined.json` and `guardian-*.log` are the complete seven-gate final cycle. `guardian-earlier-source.json` deliberately retains the preceding red cycle.
- `*-combined.*`, `project-entry-live.log`, `project-live.json`, and `webkit-windows.*` contain the later combined-source checks. The standalone `project-http-combined.log` was produced at `09133132c`; the final `guardian-http.log` repeats that test on the final candidate.
- Earlier logs such as `fast-final.log`, `http-candidate.log`, `audit-final.log`, and `windows-artifact-hashes.json` predate the project COMMS merge. They are historical evidence, not final-candidate receipts. `artifacts-final-combined.json` identifies the final unsigned Windows build.
- `golden-original.log`, `visual-review.json`, `golden-repeat.log`, and `visual-disposition.json` preserve the visual failure, review, separate repeat, and final disposition. The threshold remains 1.5; no final frame was suppressed.
- `longhaul.json` is the failed initial performance-budget attempt. `perf-paired.json` and `longhaul-repeat.json` retain the investigation and unchanged-budget repeat. Cold installed performance acceptance is still required.
- `ready-combined.json` is NOT READY. `ready-integration-combined.log` additionally records that the isolated audit candidate has not been integrated into trunk. No native macOS or signed installed-Windows receipt is present.
- `keychain-windows-persistent.log` is the September 20 follow-up: the production persistent Windows credential roundtrip passed in two independent candidate test-binary processes. It does not cover macOS or installed migration/locked-store recovery.

Raw screenshots, fixture scripts, unsuccessful exploratory command logs, and local binary artifacts remain in this audit worktree under `.qa_tmp/release-0124` and the cycle directories referenced by the logs. No installer, browser runtime, private credential, release tag or publication is included in this evidence commit.

Command logs retain their original Windows line endings and trailing blank output lines. The integrity manifest hashes those exact bytes.
