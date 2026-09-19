# One home conversation

General is the home conversation. Ask the overseer for an outcome there; it can create a named working session, dispatch a specialist in the background, and review the result back in the originating conversation. Follow-ups can reuse the same working session and its durable history. The existing voice input remains attached to the selected conversation.

Open **Overseer · delegated work** in the sessions rail to inspect a working session, or choose **Talk to overseer** to return to General. New sessions and completed reviews do not change the selected conversation or replace an unsent draft. The overview shows the latest attempt for each session, preferring a running attempt, and distinguishes starting, working, awaiting review, reviewed, stopped, and interrupted states.

## Implementation

- `sidecar/overseer.js` stores stable child/parent identities and a durable review queue in `overseer.json`. Existing saved sessions keep their IDs, names, histories, and deletion tombstones.
- Session list/create/read operations use server-owned state without requiring a browser. Visual actions still use the station bridge; older unsaved pages retain their list fallback.
- Worker records carry their parent and target session IDs. Target history and trusted project scope are refreshed when a queued worker actually starts.
- Completed workers enqueue one review per run. User turns and reviews serialize within a session. Completed reviews survive restart; an uncertain interrupted review is surfaced rather than replayed automatically.
- E-STOP cancels pending reviews durably. A later user turn permits new reviews without replaying cancelled work. Review triggers never appear as Commander messages.
- The browser adopts new sessions, recovers missed answers from the run ledger, and projects backend status. A working label requires a live controller and a confirmed run-start event.

## Reproduce locally

Run `node dev/overseer-preview.cjs` from this worktree. It launches the real app through `node dev/seed.js --keep` with an isolated profile and a deterministic local provider; it uses no real model credentials. Recruit a Researcher, return to General, and send “Delegate research and review the findings.” Then send “Follow up in the existing research thread.”

The scripted provider is a test fixture, not evidence of production model reasoning quality. Automated coverage lives in `test/overseer.test.js` and `test/e2e.overseer.test.js`; the latter exercises real HTTP runs, browser-independent creation, automatic review, follow-up history, completed-review restart, and interrupted-review recovery.

## Scope

This is local orchestration while the sidecar runs. Closing the page does not remove backend work; closing the app stops execution. Interrupted work is reported and can be continued through existing worker controls. This does not add cloud execution, a replacement voice engine, or automatic permission expansion. Microphone/audio behavior and production-provider decision quality require separate checks.
