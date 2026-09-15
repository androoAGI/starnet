# Creative Studio working example

Creative Studio now opens a single setup card after applying the preset. Existing
studios can reopen it from Build Mode → Presets → Set up current studio, or from
the conveyor line's setup card.

The card explains the brief → draft → review → outbox flow, saves both role
assignments through the normal station model, and offers a small fictional
community-garden announcement as a sample. The saved Bay instructions remain
editable through the existing prop controls. Room geometry and furniture are
unchanged.

Readiness comes from the actual directed routing graph, distinct roster agents,
and `WorldModel.bayObjects` computer access. The sample uses the existing
`/api/routing/sample` endpoint after `World.syncPlan` confirms the current plan.
It never runs automatically. The completion label requires the endpoint's
successful delivery result; changing the station invalidates that displayed
proof. The finished response can be expanded inline.

## Verification — 2026-09-15

- Live preview `http://127.0.0.1:18845`: opened through Conveyors and Presets;
  assigned NOVA to Drafter, rejected NOVA as the second role, and observed the
  assignment after a saved reload. Restored the original blank assignments.
- A save-conflict notice appeared on two immediate save/reload checks. Loading
  the current station recovered the saved assignment. No save-layer changes
  were made in this work; the notice remains a separate follow-up.
- Visually checked the glass card at the normal desktop size and 390×844.
  Scrolled to the sample button and status on the narrow viewport, then reset
  the viewport and left the card open for review.
- `station-templates.test.js`: passes for classic and remastered catalogs,
  including read-only inspection, route-derived role order, duplicate agents,
  missing computer access, and reversed belts.
- `station-template-example.e2e.test.js`: passes against a real sidecar with a
  local deterministic provider. Two durable runs, saved drafting/review briefs,
  actual draft handoff, and final reviewer delivery are asserted. Capabilities
  come from real workstation furniture through the same enrichment as World.
  Registered in `test/http.list`.
- Existing run-gate and junction-card regressions: 23 + 117 assertions pass.
- No paid-provider sample was run in the user's preview. It contains one agent;
  the guide correctly leaves the sample disabled until a second is assigned.

Full gate: **not green**. After several minutes,
`qa-product-perfect-claims.test.js` reported the same planning-authority failures
as the preceding library pass (expected PASS, received BLOCKED; missing wave
verdict explanation). It also reported a candidate-HEAD mismatch because this
change was committed while that audit was running. Stopped that owned test;
the runner exited 1. No full-green claim or merge. Logs:
`.dogfood/build-interactions/creative-test-fast.log` and `library-test-fast.log`
in the same directory.
