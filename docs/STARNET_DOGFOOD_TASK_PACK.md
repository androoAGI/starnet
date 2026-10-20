# StarNet Phase 2 Dogfood Task Pack

Use this pack to prove StarNet can replace the reference harnessAgent for ordinary daily-driver work.
Run it from a seeded scratch workspace. Save evidence under `.dogfood/phase2-YYYYMMDD/`.

## Evidence Folder

Each run should leave:

- `summary.md` - human-readable result and verdict.
- `runs.json` - run ids, stream ids, model, spend label, reason, tokens.
- `artifacts/` - files StarNet wrote or verified.
- `screens/` - UI screenshots for important moments.
- `audit/` - copied audit reports when used.

## Task 1: Paid Live Smoke

Purpose: prove real provider/key/model path.

Command:

```powershell
$env:OPENROUTER_API_KEY="<real key>"
$env:SKYNET_AUDIT_LIVE_PROVIDER="1"
npm.cmd run audit
```

Pass:

- Audit task lifecycle passes.
- Report shows live provider, not deterministic mock.
- Run history records model and metered/unmetered status honestly.

## Task 2: Research With Citations

Prompt:

```text
Research the current status of a small, specific technical topic I name, cite the sources you used, and write a concise brief to a file.
```

Pass:

- Agent uses web tools instead of guessing.
- Final answer cites URLs.
- A file is written after consent.
- Logbook links the transcript and shows truthful spend/model.

## Task 3: Code Edit Plus Verify

Prompt:

```text
In the scratch workspace, make a tiny intentional code/documentation edit, then run the relevant verification command and summarize exactly what changed.
```

Pass:

- File mutation is consented.
- Verification runs through the workbench capability path.
- Output is redacted/safe.
- Any failure is surfaced as a diagnosis, not hidden.

## Task 4: Cancellation Or Tiny Budget

Prompt:

```text
Start a task that would normally take several tool calls, then cancel it or run it under a tiny budget cap.
```

Pass:

- Run ends with `cancelled` or `budget`.
- Partial output is not represented as complete.
- Ledger/logbook records the honest reason.

## Task 5: Restart And Resume

Steps:

1. Finish a task with a transcript and artifact.
2. Stop the sidecar.
3. Restart the sidecar.
4. Reopen StarNet and Logbook.

Pass:

- The run is still visible.
- Transcript opens.
- Artifact path still works.
- Spend/model labels survive restart.

## Task 6: Memory Recall

Prompt A:

```text
Remember this durable preference for this scratch run: when summarizing technical investigations, lead with the verdict, then evidence, then next action.
```

Prompt B, later:

```text
Summarize a short technical investigation using my preferred structure.
```

Pass:

- Memory write is consented or visibly proposed.
- Later response follows the stored preference.
- Memory/logbook provenance points back to the source run where available.

## Task 7: Restore Proof

Steps:

1. Make one approved file mutation.
2. Confirm a checkpoint exists.
3. Restore the checkpoint.
4. Inspect the file.

Pass:

- The file returns to its prior state.
- Restore is visible in UI or report.
- Denied mutations from a separate run remain paired tool errors, not crashes.

## Final Verdict

Phase 2 dogfood is green only if every task above passes twice:

- Once fresh from a clean seeded workspace.
- Once after a sidecar restart.

If a task fails, classify it as:

- `product-blocker` - blocks StarNet replacing the reference harnessAgent.
- `gate-bug` - gate/harness test is wrong or stale.
- `pilot-accepted-gap` - real but accepted for pilot scope.
- `phase3` - important parity work after core-loop proof.
