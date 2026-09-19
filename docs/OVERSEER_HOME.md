# Talk to the station orchestrator

Select the station orchestrator in the existing COMMS agent selector and talk in any conversation. For work that benefits from delegation, it uses the agents already on the user's station, with their existing identities, roles, models and tools. Simple requests can be answered directly. The orchestrator can reuse or create working sessions, follow up with the crew and review results back in the conversation that requested them.

There is no additional sidebar button, dashboard, review panel or required General session. Working conversations appear in the existing sessions list. The user can inspect them or talk to specialists directly as before. Switching conversations does not cancel background work or redirect its return destination; unsent drafts and selected focus remain owned by the existing chat UI.

## Reused mechanisms

- The existing COMMS selector chooses the station orchestrator (stable agent ID agent) or a specialist. No new agent type or mode toggle is added.
- Existing roster and team.dispatch/team.subagents/team.steer/team.interrupt/team.resume tools provide delegation and management. The crew list and each worker's identity come from the current roster. Automatic follow-through instructions and review admission apply only to the station orchestrator; other agents retain their existing tools.
- sidecar/overseer.js adds durable session ownership and a review queue. User turns and reviews serialize within the originating conversation. Reviews do not become synthetic Commander transcript messages. Uncertain interrupted reviews are surfaced rather than blindly replayed.
- frontend/app/overseer.js only adopts durable working sessions and calls the existing StationCommands transcript reconciliation. It builds no interface and never changes focus. Polling is bounded and retried after connection recovery.
- Project context remains scoped to its conversation. Permission and capability enforcement use the existing harness.

## Local proof

Run node dev/overseer-preview.cjs. It uses an isolated workspace through dev/seed.js --keep --workspace and a deterministic local provider, with no real model credentials. Recruit a research agent, choose the orchestrator in COMMS, and ask it to delegate research. Follow up in the same conversation. The scripted provider proves the harness flow, not real-model judgment.

Automated proof uses a user-created agent named Mira in a Launch planning conversation separate from General, verifies its persona reaches the provider, confirms General receives no result, and verifies direct specialist chat receives no automatic-coordination briefing. Existing stop, follow-up history and restart proofs remain included.

This is local execution while the sidecar runs. It does not replace voice input or add cloud execution. Real-provider judgment, microphone/audio and installed-package readiness require separate verification.
