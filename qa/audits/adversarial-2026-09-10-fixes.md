# Adversarial audit fixes — 2026-09-10

Source repair: `64ed8711b`, synchronized with movement trunk `e80acf63d` in `a5cc394ef`; source lock `9cb548870`.

All three audited P1 failures have source repairs and focused live proof:

- Review requests share a guard through validation, Git undo and verdict persistence. The losing approval returns 409. Mutations and dispatch cannot change that loop during review. Real-Git suite: 56 assertions passed.
- Saves use revisions instead of trusting write timestamps. A stale snapshot is saved separately without replacing current station state. The UI offers a download of that window's work and a reload of current state. It intentionally asks the user to recover conflicting work rather than guessing how to merge deletions, roster/configuration and conversation changes.
- Direct-to-group conversion snapshots file bytes before committing, retains the full transcript and message-file links, and supports retries. A failed file read leaves the direct session intact.

Live seeded app proof used a local deterministic provider and disposable workspaces. Browser actions proved the two-window conflict/reload flow and Add agents conversion with a readable file. A real sidecar restart retained current and conflicting messages, the converted file bytes, and the truthful rejected verdict. Receipt: `qa/evidence/adversarial-0910/fixed-restart-receipt.json`.

Additional regression coverage includes offline dirty restart, queued saves, unload/refusal/unknown-save paths, backward clock movement, idempotent replay, full history conversion, missing-file rollback and conversion retry after restart.

Verification is still in progress: full fast and HTTP gates, customer journeys, synchronization after the preceding merge lane, and post-merge checks. This is not a claim that the installed desktop build or every unrelated feature is defect-free.
