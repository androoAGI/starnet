# Remote uplink proposal validation

## Current integration refresh — 2026-09-20

Merged official `feat/harness-backend` at `f00aa04dfceac4e0d1a3a1e95b7b8d24d55456d1` into the contribution branch. Integration commit: `5e38ea511`. Source-manifest refresh and tested candidate: `01181967b08e130b6c3e8c71c24e2bd201570bed`. Later documentation-only commits do not change the tested runtime or frontend.

All merge conflicts were resolved. Both parent branches' test entries were retained. The combined code preserves remote transport exports alongside chat continuity diagnostics, connector-storage errors alongside scroll preservation, the native connector encryption key alongside gateway credentials, and upstream HTML5 file drops in the extracted native window builder. A new regression executes the connector refresh failure path and checks its message, escaping, scroll retention, and refusal to present an empty saved-service list. The error-handling ratchet was tightened to the combined source count.

### Passing checks

- macOS focused validation: all 14 selected suites passed (48 Node test cases across the remote and adjacent onboarding/native-scene suites), followed by all 20 existing remote regression suites.
- All 852 fast-manifest and 132 HTTP-manifest entries were exercised: **851/852 fast entries and 131/132 HTTP entries exited successfully**. The normal commands stopped at the failures below; every remaining entry was then executed in manifest order with the same repository runner, isolated profiles, and a 180-second per-entry bound. No remainder entry timed out. Counts are runner entries, including any checks that explicitly self-skip; these are not fully green uninterrupted gates.
- The previously unreliable CRT context-loss test and browser gauntlet passed on this candidate. The browser gauntlet completed all 105 assertions, including on the unchanged upstream comparison.
- Native Rust: **51 passed, 1 ignored**. The ignored test explicitly requires an unlocked native credential store and can create a persistent connector key; it was not run against the user's keychain.
- macOS arm64 developer app built with ad-hoc signing; `codesign --verify --deep --strict` passed. Public updater artifacts were disabled only through the local build command: `APPLE_SIGNING_IDENTITY=- npm run tauri -- build --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'`. The repository's release signing configuration remains intact. The developer build is not a notarized public release.
- Frontend/website mirror, JavaScript syntax for all 91 changed JS/MJS files, shell syntax, whitespace, source-manifest tests (64 assertions), package checksums, and contribution-history Gitleaks scan passed.

### Clean Linux x86_64 installation and restart

Installed the checksum-verified server archive into a fresh Debian 12 systemd container using rootless Podman, with no network access or host service/data mounts. The real installer and unchanged service hardening ran successfully: runtime health returned successfully and the gateway returned HTTP 401 without authentication. Re-running the installer refused to replace the active station and left it active.

Seeded synthetic provider and backup keys, a loopback endpoint, a custom model ID, and a session through the installed runtime API. After a real `systemctl restart starnet-remote`, all remained intact; provider API responses contained no key readback and the credential file/directory retained modes 0600/0700. No model inference was performed.

All 11 remote suites and all 20 related regression suites also passed on Linux using the packaged sources. The test harness and frontend mirror fixture were supplied separately because they are not release payloads. The disposable container, custom image, and copied artifacts were removed afterward. The existing station and installed macOS application were not replaced.

### Remaining upstream failures

Both normal contribution gates remain non-green. Assertions were not relaxed or waived:

| Check | Current result and unchanged-upstream comparison |
| --- | --- |
| `test/worldlight-receiver.test.mjs` | Exact canvas pixel comparison fails on macOS/Chrome. Reproduced using the unchanged test, renderer, and CDP helper from `f00aa04df`. |
| `test/shell.test.js` | Five failures: three Windows `type` fixtures on POSIX plus two timeout/abort duration assertions. Reproduced against unchanged `f00aa04df` on macOS, and also on Linux with the packaged source. |

Validation host: macOS arm64, Node 22.23.2 and Chrome 153.0.8010.52; Linux packaged runtime: Node 22.23.2. Test processes used scratch profiles rather than the working station. Upstream CI/maintainer disposition of these baseline failures remains necessary before claiming fully green contribution gates.

### Acceptance still outside this evidence

The final attended macOS journey in [TESTING.md](TESTING.md), a clean Linux arm64 installation, Windows-native acceptance, resource sizing, and public signing/notarization/update policy remain release acceptance work. Unit tests, a signed developer bundle, and the x86_64 container do not prove those outcomes.

## Historical review — 2026-09-19

Reviewed on 2026-09-19 against official `feat/harness-backend` at `3ba5b84922f3b62caa4e159999ef3acc82af2a3e`. The reviewed runtime changes are through `3d7ce42c544f4304d21d01f2ef1a9d11c247c519`; later commits refresh the existing source manifest and document verification. The contribution branch starts at official upstream and contains no private deployment history.

### Passing checks

- `node --test test/remote-*.test.js`: 42 tests, no skips. Covers authentication, origin separation, SSH arguments, connection setup, streaming/disconnect ownership, request fencing, provider persistence and migration, goals, settings reconciliation and shared UI assets.
- `node scripts/run-test-list.mjs test/remote-regression.list`: all 20 retained upstream suites pass. Includes authentication, boot, SSE, consent, station commands, orchestration, cron, recovery, cloud saves and cancellation.
- Native Rust tests: 50 pass, including credential separation, window lifecycle and native authority checks.
- Provider registry, pricing and existing Codex decoder suites pass; the product source-manifest check passes with 64 assertions. The source-lock refresh does not change claim verdicts.
- The final review checks pass for deterministic clocks, fail-open diagnostics, packaging provenance, settings write failures, native click geometry and saved-agent rating continuity.
- macOS app packaging and ad-hoc signature verification pass. The build is a developer candidate, not a notarized distribution. The installed working application and live server were not replaced.
- Shell syntax, frontend/website mirror, diff whitespace, package checksums and contribution-history secret scanning pass.

### Broad contribution gates remain non-green on this host

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

### Attended acceptance and release work

The complete manual checklist is in [TESTING.md](TESTING.md): first setup, invalid connection recovery, local/remote transitions, one-window startup, exhausted-provider opening, custom model retention, narrow provider cards, draft retention and scroll stability through reconnect. Repeat it against the final candidate. Clean Linux x86_64/arm64 installation, resource sizing, public signing/notarization and release/update policy remain maintainer acceptance work. Automated coverage is not a substitute for those checks.
