# Selected Google files

Merged into `feat/harness-backend` at `3b15f522d`. Real Google connection,
Windows native-keychain restart recovery, and Docs/Sheets read/write checks passed.
No release was published. Native macOS keychain/migration CI passed on Intel and
Apple Silicon; signed-installer and physical-Mac acceptance remain separate.

Final pre-merge and post-merge gates both passed: **837 fast steps and 126 HTTP
steps**. See [merge receipt](../qa/digests/2026-09-20-google-selected-files.md).

The original audit branch is preserved. The merge candidate includes accepted trunk
`760426bc5`, including the coordinator and reliability updates. The earlier temporary
coordinator rollback was respected; those changes were included only after acceptance.

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
unverified-app interstitial on the observed path. The user completed selection of the
two dedicated verification fixtures. The callback connected 11 tools with the exact
drive.file grant. A stale earlier attempt returned Google's generic 400; a fresh
attempt completed successfully. Browser automation could inspect but not operate
Picker's iframe, so the user performed its final selection and Insert actions.
The existing broad verification draft remains separate and unsubmitted.

Source: https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker
(checked 2026-09-19; desktop Picker accepts only drive.file).

## Verification record

- Full fast suite: 819 steps green. Focused follow-up checks passed for status
  redaction, toggles, refresh and broad-service deferral.
- Full HTTP suite: 120 steps green, including the new selected-file lifecycle test.
- Native Windows review launcher built successfully. No signed-installer acceptance
  is claimed; native Mac keychain acceptance is recorded below.
- Live seeded app, using synthetic Google endpoints: selected-file disclosure and
  button displayed; callback connected 11 tools; restart recovered the encrypted
  grant; the panel showed **1 connected · 5 deferred**; disable/re-enable worked.
- Real Google Picker activation, consent, file selection, and callback completed.
  Only dedicated StarNet verification files were used for acceptance.
- Initial acceptance was performed in isolation; the final merge is recorded above.
  Full public release readiness is not claimed.
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
- The user has no physical Mac access. Native keychain/migration acceptance instead
  ran on GitHub-hosted Intel and Apple Silicon macOS runners, using a disposable
  keychain and the production `src-tauri/src/credentials.rs` module. Both passed
  on combined candidate `69794ac6d`: https://github.com/androoAGI/starnet/actions/runs/35477411495.
  Coverage: create/read-back; plaintext-to-encrypted migration; synthetic write failure
  preserves originals; both encrypted recovery copies survive a new native process;
  malformed key rejection without replacement; locked keychain fails closed; unlocking
  recovers the original state. No Google tokens or signing secrets were used in CI.
  This proves the keychain/migration seam, not signed-app installation or physical-Mac UI.
- Real-account acceptance after restarting the native-keychain review preview: connector
  returned up with 11 tools, encrypted storage, and no storage error. Eight real Google
  calls through StarNet's /api/run and MCP adapter succeeded: read the selected Doc;
  read selected Sheet cells; create/edit/read back a new Doc; create/write/read back a
  new Sheet. Exact marker text and cell values were asserted after writes.
- A loopback-only scripted model drove those calls, with Google endpoints unmocked and
  no external model provider. Test artifacts remain as two files titled
  `StarNet selected-file acceptance 2026-09-19`; existing fixtures were read only.
  Local ignored receipts: `.local/google-review/doc-readback.json`,
  `.local/google-review/sheet-readback.json`, and the local tool-check driver.
- Real refresh-token renewal, revocation recovery, and signed-installer acceptance
  are not established by this session's live read/write proof; lifecycle fault paths
  have automated coverage described above.
- After syncing trunk for macOS CI, the real Windows preview was restarted on the
  combined source. Both previously written Doc and Sheet markers were read back and
  asserted again through real Google calls. No external model provider was used.
- Combined source `01f13e470` passed native keychain/migration CI on both Intel and
  Apple Silicon: https://github.com/androoAGI/starnet/actions/runs/35481435583.
  The Windows native preview was restarted on that source, and exact Doc and Sheet
  marker read-back passed again through the real Google API.
- The first local merge was rolled back after the 15-minute fast-gate watchdog
  expired; no assertion failed in that attempt. The accepted reliability update
  supplies a 20-minute fast deadline with matching Guardian headroom. The temporary
  30-minute candidate override was removed after the Guardian test rejected it.
