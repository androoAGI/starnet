# Orchestrator in existing COMMS — corrected scope

This supersedes the sidebar/home-button design and associated UX claims in `2026-09-19-overseer-home.md`. The owner rejected that interface and confirmed the scope: select the station orchestrator in existing COMMS; talk to one agent that coordinates the user's existing station crew. No new dashboard, sidebar controls, replacement crew, mandatory General conversation or mode selector.

Branch: `agent/overseer-home-0919`. Final source: `8cce77fc1`; frontend source lock points to `3d5e1afad`. Synced with accepted reliability integration `eaac6fc97` through merge `2e33eafeb`. No trunk integration or release is claimed here.

Implementation:

- Removed all sidebar UI and styling introduced by this lane. The small browser module only adopts durable sessions and uses the existing transcript reconciliation. It never changes focus. Polls time out and retry after recovery.
- Existing roster, worker persona/model handling and team tools remain the execution path. The extra coordination briefing and automatic review admission apply only to the existing station orchestrator (`agent`). A direct specialist conversation cannot resume its paused review queue. Already-admitted orchestrator work continues if the user switches elsewhere.
- Results return to the requesting conversation, with no requirement to use General. Follow-ups reuse existing crew sessions and history. New automatic reviews use the ordinary assistant delivery path without the extra internal delegated-task label.

Focused regression proof:

- A user-created `mira_custom` research agent runs with its `MIRA_CUSTOM_PERSONA` instructions.
- Launch planning is distinct from General; delegation and review arrive only in Launch planning. General's transcript remains empty.
- Direct specialist chat receives no automatic-coordination briefing. Specialist-led background work does not enter the orchestrator review queue.
- Host eligibility is limited to interactive station orchestrator runs and their already-admitted reviews. Internal helpers, scheduled work, specialists and external channels (including channel interactive-approval mode) are excluded. Dispatch/spawn only attach return-to-parent review ownership when this host eligibility is true.
- Follow-up history, interrupted-review recovery, halt/restart, and no synthetic Commander review messages remain covered.
- Browser synchronization does not create interface elements or move focus; unchanged polling avoids rebuilding transcripts; offline and hung-request recovery retry reconciliation.

Live app proof (local scripted provider, real sidecar and browser):

1. Recruited Mira through existing CREW → RECRUIT → Researcher controls.
2. Created and named Launch planning through existing session controls. Selected NOVA using the existing COMMS agent selector.
3. Asked NOVA to use Mira. Mira's background work and the orchestrator's review completed; the selected session and unsent Launch planning draft remained intact.
4. Sent another follow-up, then selected Mira's direct conversation while her background work was running. After completion, Mira remained selected with `Draft for Mira.` unchanged. Launch planning received the answer; navigating back restored `Draft in Launch planning.`
5. Created a clean Crew coordination example that reused Mira's existing research session. DOM receipt:

```json
{
  "extraPanels": 0,
  "selected": "Crew coordination session, NOVA, read; Enter to open; Shift+F10 for actions",
  "conversation": "COMMANDER: Follow up with Mira on the research and bring her findings back to this conversation. / NOVA: Follow-up started in the existing working session. / Reviewed findings: the worker returned two observations."
}
```

The browser error log was empty. One older internal marker remains in the earlier Launch planning test transcript from the preceding build; two subsequent reviews added no marker, and the clean Crew coordination example has none. Existing transcript history was not rewritten.

Preview uses `.dogfood/overseer/workspace` through `dev/seed.js --keep --workspace`, separate from regression campaign workspaces. Provider responses are fixtures; real-provider selection/judgment, microphone/audio and installed-package behavior are not certified by this proof.

Final source `8cce77fc1` was restarted and exercised again in the real app. Crew coordination's existing answer survived without duplication; another follow-up reused Mira's same research session and returned a second review. DOM receipt: `extraPanels: 0`, `technicalLabels: false`, `reviews: 2`, selected `Crew coordination session, NOVA, read; Enter to open; Shift+F10 for actions`, draft `Unsent draft.`. The live preview remains available at `http://127.0.0.1:60319/` for owner review.

Regression-run note: an earlier full fast run stopped at the crew-track assertion because that test read only the first 2,600 characters of the orchestration briefing. The protected wording remained present past that cutoff. Test-only commit `01f39fb16` bounds the assertion by the actual briefing section instead; its 25 assertions passed. Product source stayed unchanged, and the full fast suite was restarted. Earlier interrupted runs are not counted as full passes.

## Final verification

Both complete suites exited 0 on the final product source:

```text
run-fast-tests: OK — 831 step(s) green
run-test-list: OK — 123 step(s) green
```

Fast log: `.overseer-comms-complete-fast.log`, candidate `01f39fb16`. HTTP log: `.overseer-comms-accepted-http.log`, candidate `8cce77fc1`; the only intervening commit changed the fast-suite source-inspection test, not product code. Full fast includes the corrected crew briefing assertion, website parity, source claims, real session lifecycle and no-UI synchronization tests. Full HTTP includes the custom-crew/non-General/direct-specialist/stop/restart journey. All touched JavaScript passed syntax checks and `git diff --check` passed.

The preview's test draft was cleared through the normal composer after verification. It remains open on Crew coordination. No trunk merge, push, installer build or publication occurred. The previous sidebar design remains rejected and removed.
