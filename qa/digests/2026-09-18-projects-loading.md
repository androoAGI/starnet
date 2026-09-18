# Projects loading repair — 2026-09-18

Source repair: `fa3d96b12` (customer bug `25120f27`). Affected source: v0.12.3, also reproduced at trunk baseline `882897d52` on Windows.

## Cause and change

Every nonempty Projects overview referenced `st.status`, but `st` belongs to session rows and is undefined in the project renderer. The successful API response was cached before rendering, so the rejection handler retried the same renderer and threw again. This left the loading text and one unhandled rejection even with a healthy backend.

Remove the invalid status reference. Retain only successfully rendered snapshots; contain errors while rendering a stale snapshot and show a terminal recovery message. The generated website copy is synchronized. No store, permission, agent, session, workspace or migration code changes.

## Evidence

The baseline live seeded app returned a valid nonempty projects array but rendered zero rows and `loading projects…`, with `ReferenceError: st is not defined`. After the change, the same saved root renders with no page exceptions. A second tiny non-Git folder with one text file also loads.

Seven live checks pass: nonempty overview, enter project, create scoped session, return to overview, offline stale-list message, reconnect, and reload saved projects. Evidence in the retained worktree: `.dogfood/projects/{before,after,verified}.json` and `.dogfood/projects-live.mjs`.

`test/projects-view.test.js`: 78 assertions pass. Replaying the same tests against baseline app.js fails with the original ReferenceError in both the renderer and rejection fallback (`regression-before.log`). Tests execute production renderer functions, including trusted/revoked and empty results, failed refresh, failed rendering and subsequent recovery.

Customer journeys: 36/36 PASS (`customer-journeys.log`). Installer behavior and affected-customer recovery remain unverified; this source merge needs a future rebuilt release.

## Support guidance

Do not ask the reporter to delete or reset application data. This is a rendering defect, independent of folder size or contents. Clearing project metadata would only hide the trigger until a project is added again. There is no cache reset needed for this repair.

The backend stores project metadata in `projects.json` under its active workspaces directory; trust grants are separately held in `permissions.allow.json`. Neither should be manually removed to address this issue. Agents, sessions and station state need no migration for the fix.

Suggested reply after an installer containing the repair is available: We reproduced the Projects loading issue and found a UI error in version 0.12.3. Your folder contents and station data do not need to be cleared. Please keep the application-data folder intact and install the update containing this fix. If it persists afterward, provide the new Diagnostics report and the page error text; do not send credentials or the whole station-data directory.
