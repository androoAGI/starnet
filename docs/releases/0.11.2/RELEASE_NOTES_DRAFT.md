# StarNet v0.11.2 — draft

This update brings more reliable saves and task results, clearer setup, and smoother station movement and backdrops.

- Provider and model choices stay selected when an older catalog request finishes late.
- Saved OpenRouter fallbacks switch provider and credentials correctly after a Codex quota failure. Paid fallback usage retains its spending limits and cost record.
- Delegated specialists retain connected MCP tools through the lead's approval flow. Denials, connector removal and fresh confirmation after external content still apply.
- Image charges appear in local run receipts without a second debit. Cancelling image work prevents later file publication; upstream work may already have been billed.
- Concurrent station saves preserve conflicting edits for recovery instead of overwriting newer work. Conversation conversion retains historical attachments and safely handles retries.
- Compatible API clients can use durable request keys to avoid repeating work after connection loss. Partial, failed and interrupted runs retain their real status and evidence.
- Structured JSON results are validated, with at most one repair that cannot execute tools.
- COMMS preserves report tables, lists, quotations and named links. Copy keeps the original report text. Plus bullets and tab-separated list markers render consistently.
- Claude tasks can continue through host verification notes on OpenRouter and compatible managed connections without an unsupported assistant-prefill request.
- Reopening a completed conversation reconciles a combined local reply with its durable turns, avoiding duplicate replies while retaining uncommitted text and attachments.
- Overseer creation has a two-step identity and connection flow, clearer model selection, and expanded personality controls. Outdated setup warnings retire when the selected connection changes.
- The Field Manual guides work-app and messaging setup. GitHub supports device sign-in, with visible errors and protection for an existing connection if saving fails.
- Speech playback recovers after an output-device interruption.
- Agent movement, doorway paths, desk seating and furniture cleanup behave more consistently. Crew waiting for approval display the waiting state.
- Refreshed sky and ground backdrops retain their detail while heavy artwork generation runs in the background. Cached terrain reduces camera-movement work, especially in large, zoomed-out forest views.
- Docked panel height survives reopen and reload. Image setup guidance includes the supported OpenRouter credential route.

Google Workspace connections remain deferred while verification is completed. Google login for StarNet billing is separate.

Editorial draft only. These notes describe included source changes; the release remains subject to the acceptance work in [FOLLOWTHROUGH.md](FOLLOWTHROUGH.md). Canary installers are test artifacts; no public release or tag is implied.

Release preparation decision (September 11): Andrew waived the typical source and installed soak durations for 0.11.2 in favor of focused update/regression checks. Partial soak runs are not PASS receipts. See [SOAK_WAIVER.md](SOAK_WAIVER.md); carry this exception into the final release notes.
