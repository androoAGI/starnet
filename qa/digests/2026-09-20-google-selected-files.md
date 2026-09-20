# Selected Google files merge receipt

`agent/google-oauth-merge-0920` integrated into `feat/harness-backend` at
`3b15f522d5d40f05c2ef527c3f4de279771af02d`, from trunk `5398b4d36`.
The merge was a fast-forward with an identical tracked candidate tree. Existing
uncommitted `docs/NEXT.md` and `qa/STATUS.md` edits were preserved.

- Pre-merge: `npm run test:fast` **837 steps PASS**; `npm run test:http`
  **126 steps PASS**.
- Post-merge, run from the integration checkout: `npm run test:fast` **837 steps
  PASS**, exit 0; `npm run test:http` **126 steps PASS**, exit 0.
- Syntax checks passed for all 19 changed JavaScript files. Shared event/schema
  contracts were unchanged. Connector credential migration verifies durable
  read-back before removing legacy copies; failure coverage preserves originals.
- Native production keychain/migration CI passed on Intel and Apple Silicon:
  https://github.com/androoAGI/starnet/actions/runs/35481734937.
- Real Google Picker consent connected 11 selected-file tools. Through StarNet's
  actual run/MCP path, selected Doc/Sheet reads and new dedicated Doc/Sheet
  create/write/read-back passed. Windows native-keychain restart retained the
  connection. Both exact markers were read again on the combined source; a final
  real document read passed after integration. A loopback scripted model drove
  tool calls; Google endpoints were not mocked and no external model was used.

Local ignored logs are in the retained Google audit worktree under
`.local/google-review/`: `shared-deadline-fast.log`, `combined-final-http.log`,
`final-trunk-fast.log`, `final-trunk-http.log`, and `postmerge-live-doc.log`.
The worktree is retained because it holds the connected native preview and local
acceptance receipts. No unrelated worktree or credentials were removed.

Whole-Drive, Gmail, Calendar and the other broad Google services remain deferred.
This is selected-file integration acceptance, not a full-public-release verdict.
No release was published. Signed-installer/physical-Mac UI acceptance and real
revocation/forced-refresh scenarios are not established by the live checks above;
automated lifecycle and native migration coverage are recorded separately.
