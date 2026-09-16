# Integration receipt — 2026-09-16

The remaster was merged into `feat/harness-backend` at **4330361a8af9ffe7738074d676b1ee6dd3927e0c**, from previous trunk **545ddd30f746ec7132a7252afdf85942ace7df04**. The merge tree exactly matched the reviewed lane candidate.

## Results

- Pre-merge `npm run test:fast`: **804/804 PASS**, exit 0.
- Post-merge customer journeys on 4330361a8: **34/34 PASS**, exit 0.
- The first post-merge fast run reached the sprite tests but exceeded the 900000 ms wrapper deadline. It is retained as a timeout, not counted as PASS.
- Before rollback, a guard detected the concurrently integrated exterior-lighting fix. No rollback occurred; another task's work was preserved.
- The combined remaster and exterior-lighting source **5a224c66fc6342611e9f2f65f05a60ebfe2bd353** was synchronized into this worktree and passed the complete canonical `npm run test:fast`: **804/804 PASS**, exit 0.
- The prior HTTP result was **117/117 PASS**. This lane changes no backend, shared contracts, package dependencies or credentials relative to its integration base, so no additional HTTP gate was required for its merge.
- The live synchronized preview reached ONLINE/LIVE; Refit selection, workbench coordinates, Flip and Undo were checked. Earlier receipts cover 12 doorway walks and 42 sitting/departure cycles.

Trunk advanced independently to **67eb99bdf6605eadb82e385d8285acebc4e17916** (finalized skins/movement) after the tested snapshot. Its new changes are not represented as covered by this lane's 804-test receipt. The remaster merge is an ancestor and remains integrated. This receipt does not overwrite or take ownership of that task's validation.

All three operational files present before the remaster merge were verified byte-identical immediately afterward. A remaster digest is appended separately to the shared uncommitted `qa/STATUS.md` notes; existing notes are preserved. The worktree is retained because it contains unrelated untracked files and raw evidence.

## Release boundary

`qa:ready` evaluated the 4330361a8 source as **NOT READY**: two existing ledger P1 findings, five existing bug-register P1s, a RED Guardian receipt, outdated journey/beginner receipts and an installed binary not matching trunk. Source integration is complete; no installer rebuild, push, deployment or publication was performed. Multi-hour/hardware coverage is not inferred from the short live soak.

Raw logs remain in `dev/.scratch-workspace/`: `remaster-merge-review-fast.log`, `remaster-postmerge-fast.log`, `remaster-postmerge-journeys.log`, and `remaster-combined-final-fast.log`. `integration-verification.json` records hashes and last lines.
