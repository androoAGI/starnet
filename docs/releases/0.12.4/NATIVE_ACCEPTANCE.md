# Latest result

Signed-candidate acceptance has now completed within the scope recorded in [NATIVE_RESULTS.md](NATIVE_RESULTS.md). This earlier matrix remains the record of the broader requested coverage; unperformed real-account and platform journeys must not be inferred from the READY gate.

---

# Native acceptance still required for 0.12.4

This is outstanding work, not a passing receipt. Product candidate: `0c5f0d54a73122105ace05f9ca4627b5a94bb774`. Nothing in this checklist authorizes publication or an updater-pointer change.

## Test hosts and artifact identity

Use a disposable Windows account or VM and native Intel/Apple Silicon macOS hosts. Record OS version, architecture, WebView/Safari version, artifact SHA-256, source commit/tree, build provenance, signature, and macOS notarization/trust result. The audit host is Windows; its NSIS build is unsigned. A Windows WebKit engine test does not certify macOS.

Do not label process-local APPDATA redirection a fresh installed profile. `scripts/qa/installed-first-run.mjs` documents that installed WebView storage can ignore that redirection and verifies separate OS-user/VM authority. Use the supported isolation evidence, rather than changing the verifier to accept the current user's profile.

## Acceptance matrix

| Journey | Required observation on each native platform |
| --- | --- |
| Clean install and first run | Exact artifact launches, bundled catalog loads, overseer creation completes, real supported provider authenticates, a first directive returns visible output, and restart preserves identity/history. |
| Existing 0.12.3 station | Upgrade preserves agents, projects, conversations, drafts, schedules, permissions, station layout and credentials. Reopen the exact old station; a fresh empty station is not migration proof. |
| Conversations and projects | Open ordinary and project conversations, switch while a worker runs, steer/stop work, read returned results, and restart. Identical project crew settings retain their controls; failed/revoked opens retain the actual conversation identity. |
| Conveyors and approvals | Exercise at least one real filtered/merged delivery, tool approval pause/resume, and exactly-once output; verify durable outcomes after restart. |
| Authentication and integrations | Real account pairing, expiry/re-authentication, disconnect/reconnect and selected-Google-file consent/picker/readback. Broad Workspace activation remains deferred. Observe failure without losing the last credential copy. |
| Native credential storage | Windows Credential Manager and macOS Keychain write/readback, denied/locked store, restart, migration failure and explicit recovery. Use disposable test credentials for destructive cases. The production persistent Rust roundtrip passed on Windows in two independent processes on September 20; macOS and installed-app migration/locked-store acceptance remain outstanding. |
| Connection and error recovery | Healthy idle stays UP for more than 40 seconds; actual service/connection loss shows DOWN; reconnect restores state. Exercise crash/restart, interrupted replies, failed saves, malformed state and last-good recovery. |
| Native UI | Check short windows, high DPI/text zoom, focus, project activity, file picker/drop/paste, dialogs, WebView caching and startup errors. Reproduce the affected Mac boot issue `2f156837` on the affected configuration before closing it. |
| Updates | Exact signed artifact installs, relaunches and upgrades through a controlled non-public update path; snapshot/recovery works and credentials persist. Verify rollback/failed-update behavior without publishing release metadata. |
| Large stations | Run the unchanged 3,000-conversation budgets, including a genuinely cold installed start. Retain failures as well as retries; the earlier cold-start variance is not waived. |

Windows native CUA has live production-path proof in this audit. macOS native CUA is explicitly unavailable in this candidate; verify the truthful unsupported state rather than presenting it as supported.

## Receipt closure

Run the repository's installed-smoke, installed-first-run, installed-link-transport, graphics and customer-regression verifiers against the exact artifacts. Preserve their candidate/artifact-bound receipts and inspect failures. Re-run Guardian, beginner and journey gates after final integration, then `npm run qa:ready`. The product-perfection controller remains non-publishing and must retain BLOCKED for unavailable native or real-account evidence. Neither historical receipts nor manually edited verdicts establish release readiness.
