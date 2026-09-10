# Adversarial audit fixes — 2026-09-10

Source repair: `64ed8711b`, synchronized with movement trunk `e80acf63d` in `a5cc394ef`. Recovery follow-ups: `bb1aa021e` (edits during reload), `de01a1343` (conversion retry payload), `eab106abd` (nonblocking dirty-cache startup). Generated mirror synchronized. Final combined candidate `4dfbaee6f27de083a99e138779f8985ba7d3f18a` includes the completed cleanup, personality and OVERSEER creation integrations.

All three audited P1 failures have source repairs and focused live proof:

- Review requests share a guard through validation, Git undo and verdict persistence. The losing approval returns 409. Mutations and dispatch cannot change that loop during review. Real-Git suite: 56 assertions passed.
- Saves use revisions instead of trusting write timestamps. A stale snapshot is saved separately without replacing current station state. The UI offers a download of that window's work and a reload of current state. It intentionally asks the user to recover conflicting work rather than guessing how to merge deletions, roster/configuration and conversation changes.
- Direct-to-group conversion snapshots file bytes before committing, retains the full transcript and message-file links, and supports retries. A failed file read leaves the direct session intact.

Live seeded app proof used a local deterministic provider and disposable workspaces. Browser actions proved the two-window conflict/reload flow and Add agents conversion with a readable file. A real sidecar restart retained current and conflicting messages, the converted file bytes, and the truthful rejected verdict. Receipt: `qa/evidence/adversarial-0910/fixed-restart-receipt.json`.

Additional regression coverage includes offline dirty restart, queued saves, unload/refusal/unknown-save paths, backward clock movement, idempotent replay, full history conversion, missing-file rollback and conversion retry after restart.

Final combined-candidate verification (all exit 0):

- Full fast gate: **762/762 steps**.
- Full HTTP gate: **110/110 steps**.
- Customer journeys: **34/34 steps**.
- Browser journeys: **139/139 assertions** on the repair source; final combined browser smoke reopened the converted attachment with exact original bytes after restart.
- Real Git review regression: **56 assertions**. Equipment projection: **10 real runs**, file writes, model selection, revocation and restart.
- Live final-candidate stale-save rejection passed. Exact group-conversion retry returned 200; changed payload returned 409, retaining one artifact and one historical message.
- Final restarted-sidecar receipt proves the original current message, conflicting window's recovery copy, converted file bytes and truthful rejected verdict remain durable.

Candidate gate receipts (including source SHA, exit codes and log hashes): `qa/evidence/adversarial-0910/combined-gates.json`. Restart receipt: `qa/evidence/adversarial-0910/fixed-restart-receipt.json`. Conversion retry receipt: `qa/evidence/adversarial-0910/final-conversion-retry.json`.

Earlier development attempts exposed the pre-existing HTTP watchdog limit and two fixtures that intentionally wrote a full save without reading its revision. The watchdog correction is included from cleanup; the fixtures now use current revisions. All three full combined suites subsequently completed successfully.

Merged to `feat/harness-backend` as **`18817ae0fa3819e536ba1bd19fcaab0ce902cffd`**. Mandatory postmerge fast **762/762** and HTTP **110/110** both completed with exit 0 on that exact merge. No runtime changes were required after the passing candidate. Postmerge receipts: `qa/evidence/adversarial-0910/postmerge-gates.json`. Existing unrelated QA notes and Rooms handoff were preserved byte-for-byte at merge; the required digest is appended without staging foreign notes. This is not a claim that the installed desktop build or every unrelated feature is defect-free.
