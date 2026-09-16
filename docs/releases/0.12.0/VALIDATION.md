# Preparation validation — September 16, 2026 UTC

Owned workspace: `agent/release-0120-prep-0915`, created from `90d6f0111931ec3991aaba28d580422b4b02a81b`. Changes are release documentation and bug records/index only. No application, installer, shared contract, version pin, root release note, website asset or public issue was changed.

## Checks performed

| Check | Result / scope |
| --- | --- |
| Bug register validation | PASS — 149 files, no violations; generated index includes both new reports |
| Customer journeys | PASS — `run-test-list: OK — 34 step(s) green` |
| Greeting prompt source regression | PASS — `chat-prompt-diet.test: OK (7 assertions)` |
| Greeting prompt real sidecar/local mock regression | PASS — `chat-prompt-diet.e2e.test: OK (23 assertions)`; no real Ollama latency claim |
| Full fast gate | PASS — `run-fast-tests: OK — 783 step(s) green`, exit 0 |
| Whitespace and release-document secret lint | PASS |
| Live seeded source | UPLINK ONLINE and LIVE feed; WORK → QUESTS opened Now/Goals/Progress/History with the next-action view |
| GitHub read | Issues updated since September 11 inspected, including closed #14 and open #17; #15 separated as a feature request |
| Public version/preflight read | Latest published version 0.11.2; target 0.12.0 available locally, on origin and in distribution releases; all five pins agree, claims lock and website mirror PASS |

The preflight itself exited 1: dirty integration operational notes and canonical NOT READY. Existing integration edits were preserved. Signing-key presence passed without reading its contents; offline backups remain human attestation. T0/G1, post-bump receipts, target installed smoke and soak remain owed. A concurrent Guardian cycle changed the journeys artifact to BLOCKED during the later preflight; this does not invalidate this lane's separate 34-suite customer campaign or upgrade the earlier canonical result. Re-run the aggregate after the candidate is frozen.

## Canonical readiness snapshot

Read-only integration-tree result at `2026-09-16T01:21:24.197Z`, trunk `90d6f0111`:

```text
NOT READY — 5 reasons
1. Ledger open P0/P1: 2 open blocking findings (0 P0 · 2 P1)
2. Bug register open P0/P1: 5 open blocking bugs (0 P0 · 5 P1)
3. Green Guardian last cycle: last guardian cycle was RED
4. Beginner Run: aa20ee26, not exact current trunk 90d6f011
5. Installed-exe smoke: tested binary source does not equal current trunk
Journey corps: PASS, 139/139 assertions in the earlier canonical artifact.
```

This snapshot reads the canonical machine-local evidence. The two imported reports raise the preparation lane's open count to seven; they have not yet been integrated. Neither the imported count nor an empty worktree findings directory rewrites that historical snapshot.

## Retained evidence and limits

Raw preparation logs remain in the owned `.dogfood/release-prep/`: `fast.log`, `customer-journeys.log`, `ready.json`, `preflight.json` and the inventory script. [scope.json](scope.json) is the portable, sanitized source/report inventory. The logged baseline does not follow later moving branch tips automatically.

The source preview used `node dev/seed.js --keep`, an isolated workspace and application-data profile at port 9276. It had no model credential; no paid/model task was issued from that UI. The prompt regression separately ran a real sidecar against a controlled local provider. Physical macOS, real llama3.2:3b performance, current private support mail, installed 0.12.0 and the final merged visual overhaul remain unverified.

## Final fast receipt

```text
npm run test:fast
run-fast-tests: OK — 783 step(s) green
exit 0
```

Log SHA-256: `0b4efcb9935259d3e32bfe200401e1dd13d0171307a841fda385f2542ac62234`.
Customer-journey log SHA-256: `81442325ae3c1c488feff99fe645ee3cbde7432a56957db2bf3655fd8ba67fc3`.
These gates prove the preparation worktree's baseline product and updated register, not a future merged 0.12.0 candidate. Integration remained at `90d6f0111` at final inspection. The temporary browser tab and owned preview processes were closed after inspection.
