# StarNet v0.12.4

Unpublished candidate for owner review. Release acceptance is still in progress.

- Conversations restore history before sending, retain interrupted replies, and preserve drafts across session changes and reconnects.
- Station design changes autosave during editing. Placement avoids unnecessary floor rebakes, and agents navigate narrow hallways more reliably.
- COMMS adapts to short laptop windows and accepts file drops across the chat panel. Projects recover from loading and rendering failures.
- The station overseer coordinates background workers through durable conversations and returns their results for review.
- Projects keep a shared orchestrator conversation, preferred crew, and worker activity inside COMMS. Reopening or failing to load a project preserves crew controls and conversation identity.
- Selected Google files can be granted separately from broad Workspace access. Desktop connector credentials use encrypted storage backed by the OS credential store; broad Workspace access remains deferred.
- Windows x64 desktop users can install the optional CUA accessibility driver from Abilities. Native CUA control is not available on macOS in this candidate.
- Persistence, spending records, routine scheduling, and failure acknowledgements have stronger recovery checks. Concurrent stale-workspace recovery now elects a single writer; invalid connector state preserves its recovery copy.
- Desktop startup bundles the shared specialty catalog and avoids unsupported older-WebKit regular expressions. Affected-Mac recovery still requires installed validation.
- Updated Sharp and archive dependencies to patched versions.

Do not publish this candidate until the release-readiness audit and native platform acceptance are complete. Earlier installer receipts do not validate these combined changes.
