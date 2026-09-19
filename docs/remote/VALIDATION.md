# Draft proposal validation

Reviewed on 2026-09-19 against official `feat/harness-backend` at `3ba5b84922f3b62caa4e159999ef3acc82af2a3e`. The reviewed runtime changes are through `3d7ce42c544f4304d21d01f2ef1a9d11c247c519`; later commits refresh the existing source manifest and document verification. The contribution branch starts at official upstream and contains no private deployment history.

## Passing checks

- `node --test test/remote-*.test.js`: 42 tests, no skips. Covers authentication, origin separation, SSH arguments, connection setup, streaming/disconnect ownership, request fencing, provider persistence and migration, goals, settings reconciliation and shared UI assets.
- `node scripts/run-test-list.mjs test/remote-regression.list`: all 20 retained upstream suites pass. Includes authentication, boot, SSE, consent, station commands, orchestration, cron, recovery, cloud saves and cancellation.
- Native Rust tests: 50 pass, including credential separation, window lifecycle and native authority checks.
- Provider registry, pricing and existing Codex decoder suites pass; the product source-manifest check passes with 64 assertions. The source-lock refresh does not change claim verdicts.
- The final review checks pass for deterministic clocks, fail-open diagnostics, packaging provenance, settings write failures, native click geometry and saved-agent rating continuity.
- macOS app packaging and ad-hoc signature verification pass. The build is a developer candidate, not a notarized distribution. The installed working application and live server were not replaced.
- Shell syntax, frontend/website mirror, diff whitespace, package checksums and contribution-history secret scanning pass.

## Broad contribution gates remain non-green on this host

Every entry in the 826-step fast manifest and 122-step HTTP manifest was attempted using isolated scratch profiles. Runs were resumed after failures; affected checks were rerun after fixes. At the end, 824 fast steps and 120 HTTP steps exited successfully. These are runner-step results, not assertion counts or an assertion that optional live checks ran. The manifests were not green in a single uninterrupted invocation.

The four remaining checks were compared with an unchanged checkout of the upstream commit above:

| Check | Observed result in proposal and upstream baseline |
| --- | --- |
| `test/crt-context-loss.e2e.test.mjs` | Intermittent Chromium `Page.navigate` timeout. The baseline also had a successful run; an instrumented proposal run exercised the context-loss fallback successfully. The standard test remains unreliable here. |
| `test/worldlight-receiver.test.mjs` | Exact pixel comparison differs by two red-channel values between receiver implementations under the installed Chromium. |
| `test/shell.test.js` | Five assertions fail on macOS: three fixtures invoke Windows `type`, and two timeout/abort timing expectations fail. Shell implementation and suite are unchanged by this proposal. |
| `test/browser.gauntlet.e2e.test.js` | Stalls in both trees; proposal run was bounded at 120 seconds and the baseline was stopped after exceeding the same interval. |

Host: macOS arm64, Node 26.9.0 for the broad traversal, bundled Node 22.23.2 for additional browser comparison, Chrome 153.0.8010.52. HTTP fixtures use the canonical macOS temporary path. No test loads the working station profile or uses real provider credentials for inference. Environment setup and reproducible commands are in [TESTING.md](TESTING.md).

These failures are recorded, not waived. Run the normal contribution gates in upstream CI before merging. This draft does not claim complete live-app, cross-platform or release acceptance.

## Attended acceptance and release work

The complete manual checklist is in [TESTING.md](TESTING.md): first setup, invalid connection recovery, local/remote transitions, one-window startup, exhausted-provider opening, custom model retention, narrow provider cards, draft retention and scroll stability through reconnect. Repeat it against the final candidate. Clean Linux x86_64/arm64 installation, resource sizing, public signing/notarization and release/update policy remain maintainer acceptance work. Automated coverage is not a substitute for those checks.
