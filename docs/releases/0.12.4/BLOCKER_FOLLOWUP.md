# Later acceptance results

The owner subsequently authorized public audit-branch upload and non-release CI. See [NATIVE_RESULTS.md](NATIVE_RESULTS.md) for the completed native acceptance and candidate-bound READY receipt. The earlier discovery and Windows keychain results below are historical.

---

# Native acceptance follow-up — September 20

Product source remains `0c5f0d54a73122105ace05f9ca4627b5a94bb774`. No product files changed for this follow-up.

## Completed

The previously ignored `credentials::tests::connector_keychain_roundtrip` passed twice, each in a separate execution of the candidate's compiled Rust test binary. This invokes the production Windows Credential Manager function, verifies the exact 256-bit encoding, and verifies successive reads return the same key. The function preserves existing keys and creates a persistent key only when none exists. No secret values were logged or removed. Evidence: `qa/evidence/release-audit-0124-0920/keychain-windows-persistent.log` (includes test executable SHA-256).

Together with the earlier default 54 tests and isolated process-reaping test, all 56 Rust tests have now been executed successfully on Windows. These were separate invocations, not a single all-tests run. This is native credential-function acceptance; it does not establish installed-app migration, locked-store recovery, or macOS behavior.

## Available acceptance route

Read-only GitHub inspection found Apple signing/notarization, Azure Windows signing, and updater signing secret names configured in `androoAGI/starnet`. Secret values were neither fetched nor logged. The repository is public, and the product candidate is not present remotely (commit lookup returned HTTP 422). This machine has no configured SSH host and no local code-signing certificate. A bounded, noninteractive SSH attempt to its sole previously known host timed out before connecting; no remote machine was accessed. No StarNet provider credential environment variables or local VM command were found.

`desktop-build.yml` supports `publish-test=false` and `require_signed_mac=true`, with native Apple Silicon and Intel builds, signing/notarization, and Intel Finder-launch/restart acceptance. `connector-keychain-acceptance.yml` exercises production credential code on disposable native macOS keychains, including separate-process recovery, malformed-value preservation and locked-store failure. `t0-clean-install-proof.yml` accepts a desktop build run ID plus exact installer hash and supports a historical baseline and controlled candidate updater manifest.

The existing Intel installed acceptance proves process/sidecar health and v0.9.0 migration; it does not by itself prove that the affected customer's WebView loaded the specialty catalog. Keep Mac P1 `2f156837` open until actual affected-configuration boot/recovery is observed. Broader macOS user journeys and the v0.12.3 upgrade remain separately owed.

Uploading the local candidate would expose source to a public repository. Explicit permission for that upload and non-release CI was requested; no upload, workflow dispatch, release, tag, or updater change has occurred. Real-account authentication also needs the selected test account and interactive access; no account or customer machine has been assumed.

## Remaining

- Affected Mac boot P1 and native macOS acceptance.
- Signed candidate Windows installation, controlled update, restart, recovery and migration.
- Real-account authentication and selected-file Google consent/picker/readback.
- macOS persistent keychain and both platforms' installed migration/locked-store recovery.

Readiness remains blocked. The Windows roundtrip removes one unexecuted check, not the remaining acceptance requirements.
