# v0.12.4 signed-candidate acceptance

Historical candidate report. The final release was subsequently published; see [PUBLICATION.md](PUBLICATION.md) for the immutable final source, exact release assets and post-publication checks.

The release-readiness gate is **READY for the exact signed candidate `f27e70f76954456b359594bebb0128e16e81e16d`**, with all six checks passing. This is a candidate-bound engineering verdict, not publication approval or a claim of exhaustive real-account/platform coverage. No release, tag, or public updater change was made. The audit branch has not been merged into the integration branch.

## Verified

- [Signed desktop build 35496956454](https://github.com/androoAGI/starnet/actions/runs/35496956454) passed on Windows, Intel macOS and Apple Silicon. Both Mac artifacts completed notarization. The publication job was skipped. The supplementary Linux build also passed.
- [Windows installed acceptance 35498817260](https://github.com/androoAGI/starnet/actions/runs/35498817260) passed on a disposable hosted Windows machine: signed clean installation, first launch, close/reopen and tray behavior, populated v0.12.3-to-v0.12.4 installation, preservation of local/durable state, synthetic native provider credential persistence, normal restart, graphics-setting persistence, installed smoke 9/9, provider fallback, delegated connectors, session continuity, and spend-authority regressions.
- Intel Mac installed acceptance passed notarized trust, Finder launch, sidecar startup, v0.9.0 station migration with source preservation, and restart. This is not an Intel v0.12.3 upgrade or a complete native UI journey sweep. Apple Silicon has build/notarization and native keychain acceptance, not an installed UI journey receipt.
- [Native Mac keychain acceptance 35496783925](https://github.com/androoAGI/starnet/actions/runs/35496783925) passed on Intel and Apple Silicon: encrypted vault migration, independent-process recovery, malformed-key preservation/restoration, locked-store refusal, unlocking/recovery, and vault fault/removal regressions. It ran at `c7d042dec`; native credential and vault source is unchanged in the signed candidate. Windows production persistent keychain roundtrip also passed separately in two processes.
- The fresh candidate Guardian cycle `20260920-072840` passed all seven gates, none skipped: fast 841/841, HTTP 129/129, adversarial sweep, screenshot and golden checks, behavioral audit, and interactive journeys. Beginner and customer journeys passed; customer journeys were 38/38. The verifier correction subsequently passed all 841 fast steps again.
- The Windows installer has valid Authenticode and its updater signature verifies against the application's configured public key. Installer SHA-256: `b05d359fccfb0f619a294a1c0eb1609d773227c4138b4fa7d42fc2a33840cbe4`, 640,524,832 bytes. Installed executable SHA-256: `1dde97eada2339675c2ad696d9afc131cb3fec38a2f72825573a11774d8ef10c`, 274,118,408 bytes.

## Windows verifier correction

The first installed upgrade run failed because ordinary conversations acquired two neutral project fields: `parentStreamId: null` and `projectHome: false`. Comparing the retained before/after state showed only those four additions (local and durable copies), after the verifier's existing derived-prompt/persona normalization. Commit `8d6f3a784` permits only those exact defaults in this fixture comparison. Regression assertions still reject changed relationships, project flags, invalid sentinel values, missing history, and changed titles. Original failure evidence is retained. The installed acceptance reran successfully against the same signed installer; no application binary was changed to obtain the pass.

## Readiness receipt provenance

The hosted runner's original installed smoke receipt and probe are retained. The signed installer was extracted without installing it on the operator's machine; its executable SHA-256 and size exactly match the live CI process identity. Every probe hash was independently verified. Only the local imported receipt's artifact path was relocated; its verdict, source identity, checks and timestamps were unchanged. `installed-receipt-import.json` records the relocation. Extraction used the portable tools from the [official 7-Zip download page](https://www.7-zip.org/download.html), without installing them system-wide.

`SKYNET_GUARDIAN_TRUNK=f27e70f76954456b359594bebb0128e16e81e16d node scripts/qa/ready.mjs --json` returned `ready: true`, no reasons, and six passing checks. This deliberately pins the tested signed candidate; it is not a receipt for the separate integration branch or later test/documentation commits. Evidence is in `qa/evidence/release-audit-0124-native/`, including an integrity manifest. The local executable needed to reverify the receipt is retained under `.qa_tmp/release-0124/signed-native/extracted/`; installers and tool binaries are not committed.

## Accepted risk and remaining limits

The owner accepted proceeding without retesting the historical customer's Mac boot incident. Bug `2f156837` records `wontfix` as owner-accepted residual risk, retains the historical reports, and does not claim affected-machine recovery. There are no open P0/P1 bug-register entries; ten P2 reports remain uncorrelated or unverified.

Real-account sign-in, token expiry/re-authentication, billing, and selected-Google-file consent/picker/readback were not exercised. The requested test-account choice was not supplied. Synthetic credentials and provider fixtures do not establish that coverage.

Windows update continuity was proven through signed NSIS installation over v0.12.3, plus updater signature verification. Delivery through the real public automatic update feed remains untested for this unpublished candidate; that feed was not modified. Do not translate the READY gate into a claim that these unperformed checks passed.

The signed candidate is available for final review with the above limits. Nothing has been released or published, and real-account acceptance remains pending account access.
