# Chat response completion repair — 2026-09-19

Customer report: agent responses frequently cut off, including in new sessions. The customer's exact provider/build and failing run remain unknown. The independently reproduced browser defect is fixed; installer acceptance and customer recovery remain unverified.

## Change

Source fix `93a4ee64c`, fixture update `ebea9738f`, on integration baseline `acbf3c225`.

The browser now requires the lead run's completion receipt before treating an ended response stream as finished. It flushes the final decoder/JSON buffer, so a final record without a newline preserves its real stop status. Missing or malformed completion produces an interruption, keeps the partial reply and error, marks the task unsuccessful, and invokes the existing durable recovery workflow. Worker completion cannot complete the lead; internal calls cannot consume incomplete output as a final answer. Reader locks and lead metadata are released. A transport failure after confirmed completion does not undo the confirmed outcome.

Desktop and website implementations match. No provider limits, shared event contracts, inference retry policy or tool replay policy were changed. Automatic continuation still requires the journal's safe-recovery authorization.

## Verification

- `npm run test:fast`: **819/819 PASS**, Node 24.19.0, unchanged 900-second gate. Log: owned worktree `.dogfood/chat-cutoff/fast-verified.log`.
- `npm run qa:customer-journeys`: **36/36 PASS**.
- New registered browser/COMMS regression: **188 assertions PASS** across both mirrors; the original harness failed 78 assertions in the initial 158-assertion before/after comparison.
- Existing real-host recovery API: **37 assertions PASS**, including restart after an uncertain mutation, review-required refusal, and blocked replay of the mutation.
- Nine live seeded Chromium scenarios PASS: normal end, output limit, missing end, final record without newline, worker-only end, reader failure, cancellation, content filter, and a dropped connection after confirmed completion. Partial text plus interruption survives session switch and reload. Missing completion emits zero deliveries; normal completion emits one.
- Syntax, generated bug register and diff whitespace checks PASS. All 107 tests after the initial fixture failure also passed independently before the successful full rerun.

The first gate exposed the stale audit source lock; only the two changed frontend hashes and source reference were refreshed, with claim verdicts unchanged. The next gate exposed a legacy test double without the standard reader cleanup method; that fixture now uses a real `Response` stream. The final full gate above includes the fixture repair. The reproduction helper additionally checks its launcher is still alive before terminating its process tree.

Before/after evidence: `qa/evidence/chat-cutoff-0919/investigation.json` and `verification.json`. Durable issue: `qa/bugs/812c3bfb-chat-replies-cut-off-without-confirmed-completio.md`.

## Integration scope

Owner authorized fix, sweep and merge. No installer rebuild, push, release or customer-recovery claim. The integration SHA and post-merge gate result are recorded in the operational `qa/STATUS.md` / `docs/NEXT.md` entry after the post-merge gate completes. Preserve the queued station-save lane and all unrelated operational edits.
