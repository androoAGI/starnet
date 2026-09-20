# StarNet v0.12.4

Reliability, conversation recovery, project coordination, and desktop storage improvements.

- Conversations restore history before sending, retain interrupted replies, and preserve drafts across session changes and reconnects.
- Station design changes autosave during editing. Placement avoids unnecessary floor rebakes, and agents navigate narrow hallways more reliably.
- COMMS adapts to short laptop windows and accepts file drops across the chat panel. Projects recover from loading and rendering failures.
- The station overseer coordinates background workers through durable conversations and returns their results for review.
- Projects keep a shared orchestrator conversation, preferred crew, and worker activity inside COMMS. Reopening or failing to load a project preserves crew controls and conversation identity.
- Selected Google files can be granted separately from broad Workspace access. Desktop connector credentials use encrypted storage backed by the OS credential store; broad Workspace access remains deferred.
- Windows x64 desktop users can install the optional CUA accessibility driver from Abilities. Native CUA control is not available on macOS in this candidate.
- Persistence, spending records, routine scheduling, and failure acknowledgements have stronger recovery checks. Concurrent stale-workspace recovery now elects a single writer; invalid connector state preserves its recovery copy.
- Desktop startup bundles the shared specialty catalog and avoids unsupported older-WebKit regular expressions.
- Updated Sharp and archive dependencies to patched versions.

Release validation includes signed Windows installation and v0.12.3 upgrade continuity, Intel Mac installation and restart, both Mac architectures' notarization and native keychain checks, and the full automated regression suite. Real-account authentication and a complete 48-hour installed soak were not performed; the owner authorized publication after reviewing the candidate acceptance results. The historical affected-Mac retest was explicitly accepted as a residual risk. Public automatic-update delivery is verified after publication.
