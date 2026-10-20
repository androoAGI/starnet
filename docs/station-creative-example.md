# Preset setup guide (was: Creative Studio working example)

Updated 2026-09-28: the guide now serves every **work preset** (Software Studio, Research Station, Creative
Studio, Operations Station, Cozy Workshop), not only Creative Studio. See
[DEFAULT-STATIONS.md](station-remaster/DEFAULT-STATIONS.md) for the catalog.

- **When it opens:** right after a work preset is applied; from WORK › WORKFLOWS while any step of the guided line has
  nobody working it (once staffed, WORKFLOWS opens the Workflow panel as before); and from Build Mode → Presets →
  SET UP <PRESET> or the conveyor line's setup card. The onboarding station pick's closing line points at WORKFLOWS.
- **Use it for real:** OPEN THE INBOX closes the guide and opens the line's Inbox in the Workflow panel, where it is set
  to run on a schedule or from a chat app (and, for Software Studio, where the working folder is chosen).
- **Words:** the run button reads ▶ SEND A REAL JOB (↻ SEND IT AGAIN once a job has been delivered; the cost is said in the note
  above it: the agents run it on their own models and normal model costs apply), the
  same words as the TEST control's SEND A REAL JOB and the FINISH card's ③ SEND A REAL JOB (org P17, 2026-10-14; it read
  RUN THE SAMPLE JOB / RUN ONE REAL JOB before). A recruited Tester is named TESTER (the role's `name`), not after the reviewer class it
  borrows. The first-ride coach waits until the guide or the presets dialog closes (one voice).
- **What it shows:** the line's purpose and flow, one card per step in the line's run order
  (`WorkflowLine.lineFlow` on a probe copy, so it follows the belts), and the preset's sample job.
- **Staffing:** each step offers the crew, a one-click RECRUIT of that step's specialist (the Workflow panel's
  `summonForRole` seam), and GIVE <NAME> A DESK when the step's agent has no computer of its own there
  (`requisitionPcFor`). One agent may work every step (multi-bay routing); the old "two different agents" rule is
  gone. A GIVE <NAME> EVERY STEP button appears once the first step is staffed.
- **Readiness:** `StationTemplates.example(doc, WorldModel, Pipeline, WorkflowLine)` returns
  `WorkflowLine.readiness` for the guided line: the same blocking list as the Workflow panel's pill.
- **Sample:** ▶ SEND A REAL JOB posts the plan and runs the sample job through `/api/routing/sample`. It never runs
  on its own, and the completion label requires the endpoint's successful delivery result.

The guided line is found by its Inbox label (for example `SOFTWARE · BUILD & TEST`). Renaming that Inbox or cutting
its belts ends the guide; the line still works and stays editable in the Workflow panel.

Tests: `test/station-templates.test.js` (every work preset: staffing, one-agent readiness, belt-order steps, loop
gates, cut belts) and `test/station-template-example.e2e.test.js` (Creative ships after one approval; Software goes
Builder → Tester → Builder → Tester and ships on a pass, through a real sidecar).

Live check 2026-09-28 (isolated seeded sidecar, headless Chromium, mock model): the picker shows both groups;
applying Software Studio rebuilt five rooms and opened the guide; the lead on every step read ready; RECRUIT added
a real specialist with its own desk; the sample ran NOVA ▸ REVIEWER ▸ NOVA ▸ REVIEWER and delivered; no OS-painted
controls; undo returned to the one-room station; no page exceptions.
