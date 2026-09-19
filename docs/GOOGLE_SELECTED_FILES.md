# Selected Google files

Implementation candidate in `agent/google-oauth-audit-0919`. Not deployed or accepted
against a real Google account yet.

The new **Selected Google files** card uses Google's desktop Picker authorization
flow: PKCE and state, `prompt=consent`, `trigger_onepick=true`, multiple Docs/Sheets,
and exactly `https://www.googleapis.com/auth/drive.file`. It does not request identity
scopes or call userinfo. Whole-Drive, Gmail and Calendar connectors stay deferred.

The callback requires selected file IDs, a durable refresh grant and the exact limited
scope. Broader grants and cancelled/empty selections preserve the previous connection.
Tokens are encrypted with the desktop keychain-backed vault. Restart checks the scope
again; a refresh cannot upgrade the grant. File contents follow the existing disclosed
model-provider and local retention paths; credential encryption does not encrypt them.

Eleven tools cover accessible-file metadata/export, Docs read/create/edit and Sheets
read/create/edit. Google enforces per-file access, including files previously granted
to this application and newly created files. This is not an account-wide file search.
**CHOOSE GOOGLE FILES** on the connected service reopens Picker. Removing the connection
clears local credentials; Google grants and previously retained work are not erased.

The release build stages the existing publisher Desktop registration for this limited
connector while `RELEASE_DEFERRED` remains true for the five broad services. The native
review launcher now uses this same split without the future-release override.

Google Picker API is enabled in `starnet-505202`, verified in the Cloud Console.
The real native-client flow reached Google's per-file consent screen, without an
unverified-app interstitial on the observed path. The file-access grant is awaiting
file selection. The user authorized consent and it was submitted, but automated
clicks and keyboard input failed inside Picker. No completed real file selection or
read/edit acceptance is claimed.
The existing broad verification draft remains separate and unsubmitted.

Source: https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker
(checked 2026-09-19; desktop Picker accepts only drive.file).

## Verification record

- Full fast suite: 819 steps green. Focused follow-up checks passed for status
  redaction, toggles, refresh and broad-service deferral.
- Full HTTP suite: 120 steps green, including the new selected-file lifecycle test.
- Native Windows review launcher built successfully. No signed installer or Mac
  acceptance is claimed.
- Live seeded app, using synthetic Google endpoints: selected-file disclosure and
  button displayed; callback connected 11 tools; restart recovered the encrypted
  grant; the panel showed **1 connected · 5 deferred**; disable/re-enable worked.
- Real Google Picker API activation and the authorized per-file consent step completed.
  File selection is still incomplete; no personal files were read or edited.
- Branch remains isolated and unmerged. Full public release readiness is not claimed.
- Synced trunk into this branch at merge `41f8bc76c`; the sole conflict was the
  release-surface hash ledger, resolved using trunk's verdicts and regenerated hashes.
  A second trunk sync is recorded at `3d516ffbb`, with combined hashes at `e151f09da`.
- The user cleared disk space. Fresh gates on `e151f09da` passed: **823 fast steps**
  and **120 HTTP steps**, including Google selected-file and broad-deferral lifecycle
  checks. Logs: `.local/google-review/final-fast-retry.log` and
  `.local/google-review/final-http.log` (local, ignored).
- The first fresh fast run stopped at session-reliability step 777 because the Google
  preview owned the same dev workspace. Stopping only this lane's preview resolved the
  collision; the focused test and complete rerun passed. The native-keychain preview
  was restarted afterward. No product workaround or test exclusion was introduced.
- The user confirmed there is no Mac access; native Mac acceptance remains unverified.
- The user selected both dedicated StarNet verification files in the real Picker.
  The selected state and enabled **Insert 2 items** button were observed. Both semantic
  and screenshot-coordinate confirmation attempts failed in the browser-control tool;
  no completed OAuth callback or real read/edit acceptance is claimed.
