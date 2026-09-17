# 0.12.0 user-bug disposition

**Historical preparation snapshot, superseded by [FINAL_INTAKE.md](FINAL_INTAKE.md).** The final September 16 intake records 83 customer/owner reports: 76 source-fixed, one permission-policy disposition, and six open P2 investigations. Gmail was subsequently connected and reviewed. Installed candidate verification subsequently resolved the local Refit and graphics findings. The details below retain the earlier evidence boundary; they are not the final release verdict.

Refreshed September 16 after reviewing the release handoff and current GitHub issues. The authoritative records are in [qa/BUGS.md](../../../qa/BUGS.md). There are 159 records, including 76 customer/owner reports: 74 source-fixed and two open investigations. These are cumulative counts, not 76 defects introduced by 0.11.2. Six records have prior installer verification; only one has explicit customer-confirmed recovery. A source fix is not proof that the affected customer's installation recovered.

All 70 previously recorded customer/owner fix commits were verified as ancestors of candidate `725664380009a5e609b77a0a44f2efaa9b942948`. The additional saved-file report imports an already merged fix, `8d4f3f5ca`. Machine-readable source checks are in `.dogfood/release-recovery/source-audit.json`. The session-typing lane through `50791280b` is now included via merge `97325c2fe`; its focused typing and session-navigation regressions pass.

## Customer repairs requiring candidate acceptance

| Report | Included source repair | Evidence and remaining limit |
| --- | --- | --- |
| Memory corrections forgotten or contradicted, `f97e73fb` | `3c8928e05`, `46c929a88`, included via `e2f0de9c7` | Real seeded UI review, durable supersession, stale-edit rejection, scoped pinning and restart proof. Corrected memories use update recency. Original customer's model and design fidelity remain unverified. |
| Promises without action end as done, `b6f04205` | `3c8928e05`, included via `e2f0de9c7` | Controlled provider and real run loop finish as an explained incomplete-work error; unsupported memory-save claims require successful write receipts. Arbitrary model wording is not exhaustively covered. |
| Agent sprites still legacy, `84e26970` | `df4d1ba25` activates selected roster and complete tracks in normal runtime | Installed before-capture proves preview-only activation gap. Production renderer verifies all 37 selections and motion. Rebuilt installed floor, portraits, picker and restart remain required. |
| Graphical refresh absent in installer, `4a108286` | `d1848af00` includes required calibration texture | Original installed WebView reproduced fallback from missing calibration/crate. Production-loader regression fails before and passes after. New installer must show industrial materials and enabled props. |
| Ratings in scheduled conversations, #18 / `09f0e9fa` | `da0658486` persists per-run origin | Real routine, interactive continuation, rating and restart: 57 assertions. Legacy rows without origin stay explicitly ineligible. Customer recovery unconfirmed. |
| Local-model small talk, #17 / `a76b93c4` | `5acf4640f`, plus `fc4c9e0f` reply ceiling | Prompt diet and capped-casual-reply regressions. The reporter's llama3.2:3b latency has not been measured on their hardware. Latest discussion also asks for setup/cost guidance. |
| Telegram delegation, #14 / `98454b83` | `887210a7b` | Real-sidecar desktop/Telegram tool and briefing parity through restart; original customer's account recovery unconfirmed. |
| Saved-file links, `253e5a8e` | `8d4f3f5ca` | Stored deliverables replay through original renderers. Inspected browser fixture restores the clickable row after reload. Native opening and customer recovery are separate. |
| Conversation order and disappearing sessions | `f1bae44d9`, plus session-focus repairs through `50791280b` | History repair and remaining composing/background-navigation protections are merged. Both focused regression suites pass. |
| ChatGPT sign-in loses to stored API key, `f46a1875` | `f7e050e6f` | Actual wake-handler test: live sign-in with blank field chooses Codex; typed key still wins. Real keychain/OAuth installed acceptance is separate. |
| Account unlink controls, `99a1517b` | `02332ee85` | Error/read recovery, retry and link controls are covered; original account recovery unconfirmed. |
| Browser campaign discovery, `305a9e3d` | `dcbc2b941` | Expanded discovery and controlled browser proofs; customer's authenticated campaign account not exercised. |
| Shared catalog boot failure, `2f156837` | `788578969` | Retry/backoff and one reload after successful catalog load; persistent errors remain visible. Source hardening does not reproduce the original unidentified Mac installation. |

## Still-open investigations

September 16 release interruption: owner-reported REFIT entry freeze is recorded as `bf3be27e`. Source fix `15ac83ceb` passes the copied 33-footprint/141-prop station entry, edit and undo probe. The installed candidate remains blocked until rebuilt-installation verification resolves the P1 machine finding. Repeated Task Board openings were caused by the release QA runner; its panel-driving loop has been removed. Performance observation is now passive.

| Report | Disposition | Evidence needed to close |
| --- | --- | --- |
| `acb47320` unexplained idle usage | Open P2; no claim of a reproduced billing defect or recovery | Affected account/run ledger matched to armed routines, loops, night shift and provider receipts. Candidate tests cannot explain an unavailable historical bill. |
| `fd9c4b4d` managed Sonnet HTTP 400 | Open P2; historical v0.10.13 report | Exact sanitized request/model/error correlation against the deployed route, then successful retry/restart. A positive reply is not a managed-run receipt. |

## Intake and communication

GitHub was refreshed September 16: #18 and #17 remain publicly open; #14 is closed. No customer messages or issue-status changes were sent. The handoff's September 14 hotspot report is accounted for: history ordering has an existing repair, saved-file replay now has a durable record, and the alleged ten-second connection ceiling remains uncorrelated (shipped default is thirty seconds). The latter needs the affected version/provider and any custom connect-timeout override.

Private support inbox access is not connected in this task. The reviewed handoff and durable register are not a fresh private-inbox sweep. Do not state that every customer has recovered or every issue is closed. Final installed receipts and canonical readiness must retain exact candidate/artifact identities.
