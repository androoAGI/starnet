# GitHub OAuth and Discover integration

Owner authorized merging GitHub OAuth and the preceding Discover improvements.

- Tested source: `c8b2b8e22`; integration baseline: `ed424ec28`.
- Final full fast gate: **769/769 PASS** on `c8b2b8e22` (`github-tutorial-fast.log`). Full HTTP gate: **111/111 PASS** on `6da717ba3` (`github-combined-http.log`); backend, shared contracts, dependencies and HTTP test list are identical in the final source. Final tutorial synchronization preserves both the setup explanation and expandable platform guide, and both test registrations. Connector UI: 149 assertions passed.
- Real isolated sidecar requested a real GitHub device code and successfully cancelled it. Earlier live browser verification reached StarNet's GitHub consent page and verified the visible code dialog and cancellation. No real repository grant or real GitHub tool call was approved or claimed.
- HTTP regression verifies a successful MCP connection, protected credential storage, reconnection after restart, and that an injected credential-write failure preserves the existing PAT and live connection across restart.
- OAuth App: https://github.com/settings/applications/3848711, owned by androoAGI. Device flow enabled; public client ID bundled; no client secret generated.
- Discover places curated available services in Popular, explains required setup, and offers guided API-key setup. GitHub defaults to sign-in with a short code and retains a token fallback.
- No shared event/schema changes. No push, release, installed-app update, or production-account recovery is claimed.

This dedicated receipt replaces this lane's notes in `docs/NEXT.md`, allowing the integration tree's concurrent uncommitted notes there to remain untouched. Existing shared QA and Rooms handoff content must also be preserved during fast-forward integration.

Integration candidate verified for fast-forward into `ed424ec28`. Earlier attempts safely refused occupied integration state. The real GitHub code issuance/cancellation probe passed again on `6da717ba3`; subsequent tutorial sync changed no backend files. Final merge result is recorded in the shared QA status digest.
