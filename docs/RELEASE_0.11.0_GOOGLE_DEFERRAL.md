# 0.11.0 Google Workspace deferral — 2026-09-07

The owner selected shipping 0.11.0 with the new Google integrations deferred. This
supersedes the Google activation requirement in earlier preparation records. It does
not waive other release checks or claim that Google verification has completed.

Gmail, Drive, Calendar, Docs and Sheets remain discoverable with an explicit deferred
label. Sign-in and publisher-client configuration return a deferred response before
creating an OAuth attempt. Manual aliases and older Google endpoints cannot bypass
the restriction. Startup, import and reload suspend these connections in runtime;
saved enable preferences and grants are retained. No tools are published and no token
refresh is attempted. Saved rows explain the suspension and still allow removal.

The build staging step omits the Google Desktop registration even if CI supplies it,
and clears stale staged metadata. Availability is source-controlled; there is no
product environment switch. Test-only preload injection continues exercising the
future OAuth implementation. StarNet billing account login is a separate flow and
is outside this change.

Verification: `test/google-release-deferred.e2e.test.js` exercises the real sidecar
with five saved Google connections, an old endpoint, expired synthetic grants,
reload, rejected sign-in/manual setup, restart and removal. A network sentinel
asserts no Google initialization or refresh. `test/google-connector.test.js` proves
registration omission and keeps the future enabled build's validation intact.
The seeded live UI at :9188 shows deferred catalog cards and an imported saved row
without enable/reconnect actions, while Asana sign-in remains available. Evidence:
`.bugloops/google-deferred-live-receipt.json`.

The currently installed 49d859186 candidate predates this deferral. A new signed
package and installed acceptance are required before distributing this scope.
Other customer reports without established causes remain open. Source repairs,
signed-package evidence and affected-customer recovery are separate outcomes.
