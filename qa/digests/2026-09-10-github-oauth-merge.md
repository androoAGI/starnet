# GitHub OAuth and Discover integration

Owner authorized merging GitHub OAuth and the preceding Discover improvements.

- Tested source: `852d732a5`; integration baseline: `716662c87`.
- Final full fast gate: **767/767 PASS**. Full HTTP gate: **111/111 PASS** on `0c9db8608`; backend, shared contracts, dependencies and HTTP test list are identical in the final source. Subsequent synchronization retained reviewed logo, sprite, world-lifecycle and evidence changes.
- Real isolated sidecar requested a real GitHub device code and successfully cancelled it. Earlier live browser verification reached StarNet's GitHub consent page and verified the visible code dialog and cancellation. No real repository grant or real GitHub tool call was approved or claimed.
- HTTP regression verifies a successful MCP connection, protected credential storage, reconnection after restart, and that an injected credential-write failure preserves the existing PAT and live connection across restart.
- OAuth App: https://github.com/settings/applications/3848711, owned by androoAGI. Device flow enabled; public client ID bundled; no client secret generated.
- Discover places curated available services in Popular, explains required setup, and offers guided API-key setup. GitHub defaults to sign-in with a short code and retains a token fallback.
- No shared event/schema changes. No push, release, installed-app update, or production-account recovery is claimed.

This dedicated receipt replaces this lane's notes in `docs/NEXT.md`, allowing the integration tree's concurrent uncommitted notes there to remain untouched. Existing shared QA and Rooms handoff content must also be preserved during fast-forward integration.

Integration remains pending: the final fast-forward was stopped before any mutation because another task staged voice changes, bug records, tests, and source fingerprints in trunk. Those staged files were left untouched. The earlier fast-forward refusal likewise preserved concurrent `docs/NEXT.md` edits.
