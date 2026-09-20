# StarNet v0.12.4

Full update notes: https://github.com/androoAGI/starnet/releases/tag/v0.12.4

Projects now bring their orchestrator conversation, crew, and delegated work together in COMMS. This release also adds selected Google file access and optional Windows accessibility computer control, alongside extensive conversation, station-saving, and recovery improvements.

## Projects and crew coordination

- Open a project into one persistent orchestrator conversation with the project's working context.
- Choose and save a preferred crew for each project.
- Follow delegated work inside COMMS, with inline status updates and expandable activity details showing the agent, task, result, tools used, outputs, and directions.
- Send a direction to a working agent or request that its work stop from the activity view. Queued directions remain visible and are included in the orchestrator's review.
- Keep the station visible while moving between project conversation, crew, and activity views.
- Improve project control spacing, activity readability, and consistency with COMMS' glass appearance. Status announcements occur when an update actually changes.
- Fix saved projects getting stuck during loading because of an undefined session status.
- Preserve crew controls when reopening projects, keep activity order stable, and prevent duplicate worker controls during refreshes.
- Keep transcript navigation out of project detail views. Failed or revoked project opens no longer relabel the previously open conversation, and late responses cannot pull focus back after navigating away.
- Show unavailable project context and activity-refresh failures explicitly, retaining the last confirmed activity while reconnecting.

## Overseer and delegated conversations

- Coordinate background workers from existing COMMS orchestrator conversations, with durable worker conversations and results returned to the originating conversation for review.
- Restore worker conversation history and project context when continuing or resuming delegated work.
- Reconcile delegated conversations and completed results without switching the conversation you are reading.
- Deliver review summaries without exposing internal task labels in the conversation.
- Refresh queued conversation context before execution and retain compatibility with legacy session dispatch and the first-save bridge.
- Keep automatic coordination scoped to COMMS orchestrator runs. Stop, halt, emergency recovery, and update handling respect coordinator boundaries.
- Refuse new overseer work if its durable halt state cannot be saved, and preserve worker/review state through restart and failure paths.

## Conversations, attachments, and COMMS

- Restore conversation history before sending a new message, including when history arrives slowly or a conversation is reopened while a read is pending.
- Keep unsent messages when history cannot be restored and report the failure instead of sending without the expected context.
- Discard stale history responses after switching, clearing, or removing a conversation; preserve drafts and conversation identity through reconnects.
- Require confirmed completion before marking a streamed reply complete. Interrupted replies retain their partial content instead of appearing successfully finished.
- Drop files anywhere across the chat panel, with a visible attachment target, multiple-file handling, previews, and the existing attachment limits.
- Handle cancelled drags, unavailable files, disabled chat, and folder drops. Accidental drops outside an attachment target no longer navigate away from the station; normal text and link editing is preserved.
- Adjust COMMS layout and expand/restore behavior for narrow and short windows while retaining drafts and panel sizing.
- Retain bounded conversation-continuity and page-error diagnostics to help investigate interrupted sessions without recording message contents in the continuity trace.

## Station building and movement

- Autosave station design changes while editing, before leaving build mode, including bursts of changes without losing conversation state.
- Reuse the existing environment render during object placement to avoid unnecessary floor rebakes in populated stations.
- Let agents yield, step aside, or retreat through narrow hallways so opposing traffic can reach its destination; improve following distance and handling around seated and working crew.
- Keep the website demo aligned with the station, placement, COMMS, onboarding, project, and reliability improvements.

## Google files and connector storage

- Add **Selected Google files** in Abilities: use Google's file picker to grant access to specific Docs and Sheets through the limited `drive.file` permission.
- Provide 11 tools for accessible-file metadata/export, reading/creating/editing Docs, and reading/creating/editing Sheets. This is not whole-account Drive search; broad Drive, Docs, Sheets, Gmail, and Calendar connections remain deferred.
- Use **CHOOSE GOOGLE FILES** on a connected service to select more files. Cancelled, empty, or broader-than-supported grants preserve the previous connection.
- Require a durable refresh grant and recheck the limited permission after restart and refresh; refreshing cannot silently widen access.
- Encrypt desktop connector credentials using an encryption key backed by the operating system credential store, with migration from existing plaintext connector state.
- Preserve original credentials and recovery copies when migration, writing, key access, or JSON validation fails. A locked or malformed credential store reports an error rather than replacing the original key or state.
- Export encrypted connector settings through the running app with its credential store unlocked, while removing credentials and machine-specific permissions from recovery exports.
- Clarify privacy disclosures: encrypted credentials do not encrypt retained file contents. Disconnecting removes local credentials, not Google's grant or previously retained work.

## Windows computer control

- Add optional **CUA · Accessibility** under **Abilities → Computer Control** for Windows x64, alongside **Windows · Classic** and **Off**. Installing CUA does not enable it; the selected driver persists across restarts and applies to new runs.
- Give authorized agents app/window discovery, screenshots with accessibility elements, semantic and pixel input, menus, window positioning, clipboard actions, and bounded state verification.
- Verify the downloaded driver's hash, version, and helper before activation. **Check Driver** and **Reinstall CUA** support diagnosis and repair; a failed replacement download preserves the current installation.
- Isolate native control sessions per run, serialize their actions, and close them on completion, cancellation, transport failure, or driver changes. Applications opened for you remain running after the agent's session closes.
- Recover expired sessions on a subsequent call, reject stale element references, and report refused or unverified actions without automatically repeating an ambiguous mutation.
- Keep driver telemetry disabled and provider credentials out of its child environment; report cleanup failures without logging desktop content.
- Native CUA control is currently Windows x64 only. It does not add always-listening audio or change voice permissions, and restricted runs cannot start the native driver.

## Saving, permissions, routines, and recovery

- Preserve the last known saved station when reads fail or save acknowledgements are missing; distinguish local restore failures from a disconnected backend.
- Strengthen durable-store recovery so read/write failures cannot masquerade as empty state or confirmed changes.
- Serialize permission changes and reject stale responses, preserving the latest confirmed grant, revoke, or bypass decision.
- Validate routine, messaging, and other asynchronous control acknowledgements before showing success.
- Keep marketplace skills, project, connector, routine, and run-history reads from treating service failures as verified empty results. Disabled or unauthenticated connectors no longer count as ready capabilities.
- Preserve spending authority through failed writes, incomplete or truncated ledger reads, and hard restarts. Uncertain accounting no longer appears as a trustworthy zero balance or silently restores permission to spend.
- Allocate limited routine execution slots to the oldest due work to prevent starvation.
- Elect a single writer during concurrent stale-workspace recovery using immutable ownership generations; protect whole-root recovery and workspace activation from takeover races and crash windows.
- Refuse recovery when process ownership cannot be established, including ambiguous routine-lock ownership, rather than assuming another process is gone.
- Improve queue and browser-probe cleanup so failures do not strand pending work or timers. Isolate seeded lifecycle and recovery-test workspaces to avoid cross-session interference.

## Desktop compatibility, packaging, and maintenance

- Bundle the shared specialty catalog with the desktop frontend and validate staged boot assets.
- Replace regular-expression lookbehind and newer timeout-API assumptions that prevented older macOS WebKit from parsing or running affected chat, widget, and history paths; preserve escaped-pipe table rendering.
- Improve onboarding sign-in-code contrast on dark glass in the desktop app and website demo.
- Stage production dependencies in desktop bundles and update Sharp and archive dependencies to patched versions.
- Expand regression coverage for persistence faults, ownership races, spending uncertainty, conversation continuity, project recovery, file drops, responsive layouts, native control, and credential migration.
- Improve QA isolation, screenshot readiness, shared-host gate deadlines, installed Mac version receipts, and upgrade comparisons that account only for the new neutral project fields while still rejecting lost or changed user state.

## Release verification and scope

The final release passed the automated regression gates, signed Windows installation, installed v0.12.3 upgrade continuity, Intel Mac installed launch/restart, both Mac architectures' notarization and native keychain checks, and the live Windows public automatic-update test with restart and populated-data preservation. The public feed serves Windows x64, Intel Mac, and Apple Silicon assets.

The final release audit did not repeat real-account authentication, token-expiry/re-authentication, billing, or Google consent/readback, and did not complete a 48-hour installed soak. Earlier selected-Google-file integration acceptance separately recorded real Picker consent and Docs/Sheets read/write checks. The historical affected-Mac retest was accepted by the owner as a residual risk; it is not claimed fixed by an affected-machine retest. Native Mac installed coverage is not an exhaustive UI sweep on both architectures.

For every source, test, documentation, and maintenance change, see the [complete v0.12.3 → v0.12.4 comparison](https://github.com/androoAGI/starnet/compare/v0.12.3...v0.12.4).
