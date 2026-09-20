# Google Workspace OAuth status — 2026-09-19

Audited source: `acbf3c225`, isolated branch `agent/google-oauth-audit-0919`.

## Current finding

Google Workspace activation is still blocked on data-access verification. The live Google Cloud Verification Center for `starnet-505202` states:

> Your branding has been verified and is being shown to users.

> Your app's data access is not verified. Verification is required because your app requests sensitive or restricted scopes.

The page offers **Prepare for verification**. This is a current console observation, not an inference from the old deferral document. No Google configuration or submission was changed.

Console: https://console.cloud.google.com/auth/verification?project=starnet-505202

## Completed prerequisites and existing evidence

- GitHub Actions secret metadata confirms `STARNET_GOOGLE_DESKTOP_CLIENT_JSON` exists in `androoAGI/starnet`, last updated 2026-09-06T20:02:13Z. Secret contents were not retrieved or printed; existence alone does not revalidate its contents.
- The public privacy page now describes Workspace service access, model-provider/credits-gateway transfers, local retention, plaintext connector credentials and disconnect versus revocation. The earlier missing-disclosure note is stale. https://starnetos.com/legal/privacy
- `docs/RELEASE_FOLLOWTHROUGH_2026-09-06.md` records prior signed-Windows consent for all five services and 20 successful Google API calls. This is historical acceptance on an older candidate, not a fresh installed-build result.
- That same record identifies the unfinished intended-use/demo-video submission and outstanding lifecycle/assessment work. This audit did not reopen the form or independently verify each unfinished form field.

## Current source and regression checks

`sidecar/mcp/google-client.js` still sets `RELEASE_DEFERRED = true`. Routes refuse Google sign-in and suppress saved Google connections; `scripts/stage-google-client.mjs` deliberately omits the native registration even when CI supplies it. This is an active source-controlled release exclusion, not a missing environment variable.

Focused checks passed on Node v22.23.0 using existing dependency modules through NODE_PATH:

- `node test/google-connector.test.js`: PASS — registration validation, 23 mocked API tool paths, errors/bounds, customer UI and staging gate.
- `node test/google-release-deferred.e2e.test.js`: PASS — real isolated sidecar, five services and legacy/custom endpoints, no Google network, preserved grants, restart and removal.
- `node test/google-signin.e2e.test.js`: PASS — real isolated sidecar with mocked Google endpoints and test-only future-release injection; PKCE callback, denied/partial consent, replay, cancellation, persistence failure, restart, refresh, revocation, removal and redaction.

These checks establish local implementation behavior, not Google's approval or current public-account access. No production source was changed. Full fast/HTTP gates, qa:ready and fresh signed-installer acceptance were not run; no station-wide release verdict is claimed.

## Remaining path to activation

1. Complete the Google verification submission: intended use, exact scope justifications, and a real consent/feature/data-flow demonstration covering the applicable OAuth clients. Check the form's current requirements before submitting.
2. Resolve restricted-data handling and Google's applicable security-assessment requirements for model-provider and credits-relay transfers; obtain the required data-access approval. Branding approval alone is insufficient. Official guidance: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
3. Remove the source deferral in an isolated implementation change, update deferral-dependent expectations/copy, validate native-client staging, and run the full required code gates.
4. Build signed candidates and establish current real-account consent, each service's operations, refresh/restart, denied access, removal and revocation recovery. Preserve platform-specific evidence limits.
5. Run the release readiness checks and normal release train before public activation.

StarNet billing/account Google login is a separate flow; this finding concerns Gmail, Drive, Calendar, Docs and Sheets connectors.
