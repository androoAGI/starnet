# Adversarial audit fixes — 2026-09-10

Source repair: `64ed8711b`, synchronized with movement trunk `e80acf63d` in `a5cc394ef`. Recovery follow-ups: `bb1aa021e` (edits during reload), `de01a1343` (conversion retry payload), `eab106abd` (nonblocking dirty-cache startup). Generated mirror synchronized; source lock `6d2111c27`.

All three audited P1 failures have source repairs and focused live proof:

- Review requests share a guard through validation, Git undo and verdict persistence. The losing approval returns 409. Mutations and dispatch cannot change that loop during review. Real-Git suite: 56 assertions passed.
- Saves use revisions instead of trusting write timestamps. A stale snapshot is saved separately without replacing current station state. The UI offers a download of that window's work and a reload of current state. It intentionally asks the user to recover conflicting work rather than guessing how to merge deletions, roster/configuration and conversation changes.
- Direct-to-group conversion snapshots file bytes before committing, retains the full transcript and message-file links, and supports retries. A failed file read leaves the direct session intact.

Live seeded app proof used a local deterministic provider and disposable workspaces. Browser actions proved the two-window conflict/reload flow and Add agents conversion with a readable file. A real sidecar restart retained current and conflicting messages, the converted file bytes, and the truthful rejected verdict. Receipt: `qa/evidence/adversarial-0910/fixed-restart-receipt.json`.

Additional regression coverage includes offline dirty restart, queued saves, unload/refusal/unknown-save paths, backward clock movement, idempotent replay, full history conversion, missing-file rollback and conversion retry after restart.

Verification so far:

- Full fast gate: 761/761 steps passed (`dev/audit-0910/complete-fast.log`).
- Browser journeys: 139/139 assertions passed (`dev/audit-0910/journeys-fix.log`).
- Real Git review regression: 56 assertions passed. Growth upgrade: 24 assertions passed. Equipment projection: 10 real runs, writes, revocation and restart passed.
- Full HTTP run: incomplete; the existing 900000 ms watchdog terminated it. No pass is claimed. The preceding integration lane contains the watchdog correction; the combined candidate still needs a complete HTTP run.
- Customer journeys: first run reached the final equipment fixture and failed because it intentionally replaced the station without reading the new revision. That fixture now reads the revision and its standalone test passes; full customer-journey rerun is pending.

Integration is serialized behind the preceding authorized lanes. Remaining: synchronize the resulting trunk, complete the full combined gates and post-merge verification. This is not a claim that the installed desktop build or every unrelated feature is defect-free.
