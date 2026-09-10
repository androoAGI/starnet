# StarNet agent-quality benchmark

This is the dependency-free, task-outcome evaluation layer. It complements the existing wiring,
UI, release, and workload gates; it does not replace them or make a release-readiness claim.
The fixed suite identifier is `starnet-0.9.0-agent-quality-v1`. Its first baseline was captured on
the pre-version-bump 0.9.0 integration candidate while `package.json` still reported 0.8.5.

## What is gated where (2026-08-17)

| Surface | What runs | Trigger |
| --- | --- | --- |
| `test/fast.list` (release gate) | 8 eval unit suites incl. `test/agent-eval.test.js` (spawns the real runner) and `test/eval-parity-offline.test.js` (offline-driver guards + full 32+4 run) | `npm run test:fast`; release train on `v*` tag/dispatch |
| `.github/workflows/eval-gates.yml` (NEW) | `npm run eval:gate` — the whole credential-free slice below | every PR + every push to `feat/harness-backend` |
| `npm run eval:gate` | `eval:contract` → `eval:agent-quality` → fault capture ×100 (1000 rows) → fault gauntlet grade → `eval:parity:offline` (32 scenarios + 4 violation probes), then writes ONE durable receipt | local + CI (~30 s total measured; fault capture ~15 s at the frozen 100 repeats — the runner refuses any other repeat count, so there is no reduced CI mode) |
| Live campaigns (`campaign-runner.mjs`, soak, installed performance) | provider-backed, installed-candidate, Hermes-referenced | manual only; never CI |

**Durable receipts:** `npm run eval:gate` writes `qa/eval-receipts/last-gate-receipt.json`
(committed home — see `qa/eval-receipts/README.md` for exactly what it does and does NOT
prove). `.dogfood/` stays gitignored; full campaign evidence lives there with only hash
indexes committed under `docs/baselines/`.

**Offline parity driver:** `npm run eval:parity:offline`
(`adapters/parity-offline.mjs`, modeled on the scripted-provider pattern of
`adapters/quality.mjs`; the campaign runner's live drivers spawn full installed
harnesses and stay out of CI). It drives all 32 scenarios of `packs/parity-v0.9.0.jsonl`
through the REAL `runAgentLoop` + the real fixture MCP host over loopback + the real
independent grader — with a scripted in-process provider and NO keys. Coverage is
asserted in code (`assertScriptCoverage`): a pack scenario without a script fails the
run, so coverage can never shrink silently. Four deliberate-violation probes prove the
grader flags each zero-tolerance class (falseDone, wrongDestination, duplicateMutation,
authorityEscape). **This measures harness plumbing, never model quality**: receipts carry
`liveModel:false` and can never satisfy the frozen v0.9.0 contract gates — enforced by
`assertPlumbingReceipt` in code, not by convention. Do not misread a green offline run
the way a green `eval-campaign-preflight` test can be misread: it proves the rails and
the refusals work, not that any model passes the scenarios.

## OPEN DECISIONS (Andrew) — documented, not decided

1. **The frozen contract is pinned to a superseded Hermes.** `contracts/v0.9.0.json`
   freezes Hermes Agent 0.19.1 @ `cc4cab2f592e60a197e796506de9168f74baf3ea`, which
   `docs/NEXT.md` already calls stale. Options: re-pin the reference (a new frozen
   contract version) or drop the Hermes leg from recurring gates and keep it
   campaign-only. The recurring gate above deliberately runs only the Hermes-free
   surface (contract validation, quality, fault, offline parity) so it does not front-run
   this decision.
2. **The Aug 3–6 campaign's 2 falseDone zero-tolerance reds remain undecided.** The last
   real live campaign FAILED closed on two falseDone events. Nothing in this recurring
   gate re-adjudicates or supersedes that result; the campaign verdict stands until
   Andrew rules on those two events (fix + rerun, or accept + document).

## v0.9 reliability and parity contract

The frozen comparison contract is `contracts/v0.9.0.json`. It binds the comparison to Hermes Agent
v0.19.1/tag `v2026.7.30`. The annotated tag object is
`d25e2dbdbc40b49808c0a0e9cfed21cc90cffab3`; its peeled commit is
`cc4cab2f592e60a197e796506de9168f74baf3ea`, with tree
`fcdc6093750ed0a3a556e20927799d7245ba65e4`. The contract classifies every advertised StarNet
claim and freezes the release gates.
Validate it against the live product-perfect claim ledger:

```powershell
npm run eval:contract
```

The 10 run-boundary fault scenarios and 32 shared workload scenarios live under `packs/`. They are
all active: a missing trajectory is a failure, never a pending green. Fault evidence requires 100
attempts per boundary (1,000 rows), and parity evidence requires three attempts per harness and
scenario (96 rows each). Run captured evidence with:

```powershell
node scripts/eval/runner.mjs capture-fault --out fault-trajectories.jsonl
node scripts/eval/runner.mjs fault --candidate fault-trajectories.jsonl --subject-manifest starnet-manifest.json --signing-key receipt-private.pem --receipt fault-receipt.json
node scripts/eval/runner.mjs compare --starnet starnet.jsonl --reference hermes.jsonl --subject-manifest starnet-manifest.json --reference-manifest hermes-manifest.json --signing-key receipt-private.pem --receipt parity-receipt.json
```

Bind exact installed/runtime identities before scoring, then create or verify Ed25519 receipt keys:

```powershell
node scripts/eval/runner.mjs bind --profile starnet --source-dir <source> --runtime-root <installed-root> --executable <desktop-exe> --commit <commit> --tree <tree> --describe <describe> --version 0.8.5 --health-url <health-url> --manifest starnet-manifest.json
node scripts/eval/runner.mjs bind --profile hermes --source-dir <frozen-checkout> --executable <venv-python> --home-dir <isolated-home> --manifest hermes-manifest.json
node scripts/eval/runner.mjs keygen --private receipt-private.pem --public receipt-public.pem
node scripts/eval/runner.mjs verify-receipt --receipt fault-receipt.json
```

The 32 workload declarations are paired one-for-one with independent fixtures in
`fixtures/parity-v0.9.0.jsonl`. Each fixture freezes its own setup, identical prompt, mutation budget,
and host-observation oracle. `compare` always runs `independent-grader.mjs` over both harness trajectory
files before scoring: a submitted `outcome.passed` is discarded, safety violations are recomputed, route
and post-mutation verification requirements are enforced, and the fixture/grader hashes are included in
the receipt evidence. A trajectory therefore needs host-captured `observation`, `routing`, and artifact
fields; model prose alone cannot green a scenario.

Receipts emit `starnet.eval.receipt.v1`. `candidateBound:true` requires verified executable-to-source
provenance, a clean source tree, commit/tree identity, and an executable SHA-256. Reference binding
also requires the frozen Hermes commit, tree, version, and executable manifest. A source run remains
truthfully `candidateBound:false`. The zero-tolerance invariants are false completion, wrong
destination, duplicate mutation, and authority escape.

If a harness or grader cannot actually execute, record all expected rows as explicit failures instead
of manufacturing a partial score:

```powershell
node scripts/eval/runner.mjs mark-unavailable --harness starnet --reason <reason> --out starnet-unavailable.jsonl
```

Provider evaluation homes may copy non-secret roster/state fixtures, but must never copy OAuth token,
auth, or `.env` files. Bindings prove the executable; they do not authorize credential use.

Before the full campaign, probe both harnesses with one explicit comparison model. `--model` is applied
to Hermes and to StarNet's default-model environment; the probe still fails if a persisted StarNet roster
selects a different model, so a nominal CLI flag cannot hide a real mismatch:

```powershell
node scripts/eval/same-model-probe.mjs --model <model> --starnetRoot <installed-root> --starnetHome <active-workspaces> --hermesSource <frozen-checkout> --hermesPython <venv-python> --hermesHome <isolated-home> --output <probe.json> --outputDir <evidence-dir>
```

After exactly three successful attempts, bind and sign their immutable raw evidence. The finalizer
fails closed on a duplicate file, model/provider drift, non-exact output, missing timing/token data,
or either executable no longer matching its manifest:

```powershell
node scripts/eval/same-model-receipt.mjs --probes <probe-1.json>,<probe-2.json>,<probe-3.json> --subject-manifest <starnet-manifest.json> --reference-manifest <hermes-manifest.json> --contract scripts/eval/contracts/v0.9.0.json --signing-key <receipt-private.pem> --receipt <performance-receipt.json>
node scripts/eval/runner.mjs verify-receipt --receipt <performance-receipt.json>
```

This measures StarNet's bound installed runtime node/sidecar path, not desktop UI cold boot, and is
only the provider/model equivalence preflight. It does not replace the 32-scenario gauntlet or the
installed provider-backed 48-hour soak.

Before any provider-backed campaign, run the metadata-only preflight. It fails closed unless the
installed executable exactly matches the bound candidate, the frozen Hermes identity and executable
still match, all 32 tasks have independent fixtures, three attempts are contracted, and the credential
envelope modification time is later than the declared rotation boundary. It never reads credential
contents and never authorizes provider spend:

```powershell
node scripts/eval/campaign-preflight.mjs --contract scripts/eval/contracts/v0.9.0.json --candidate-manifest <starnet-manifest.json> --reference-manifest <hermes-manifest.json> --fixtures scripts/eval/fixtures/parity-v0.9.0.jsonl --tasks scripts/eval/packs/parity-v0.9.0.jsonl --installed-executable <installed-desktop-exe> --credential-envelope <tokens.json> --rotation-after <exposure-utc> --output <preflight.json>
```

The common campaign runner materializes each fixture into a new isolated workspace, exposes one local
HTTP MCP host to the selected harness, and appends every host-observed trajectory immediately. Output is
resumable by `(taskId, attempt)`. Hermes v0.19.1 needs its declared ACP and MCP extras installed in the
isolated comparison venv, its evaluation profile default pinned to the comparison model, and automatic
tool-search collapsing disabled so the Codex-backed ACP session retains and sees its dynamic MCP surface.
The driver verifies the session model and fails closed on drift.

The additive focused pack `packs/output-reliability-v1.jsonl` and matching fixture pack exercise truncated
output continuation, malformed-result recovery, cancellation resume, timeout honesty, and real concurrent
workers completing out of request order. It is intentionally separate from the frozen 32-scenario v0.9
release contract. Run three attempts per harness through the same campaign runner and grade the raw rows with
`applyIndependentParityGrades`; exact output markers are checked with `count_equals`. The fixture's
`fixture_status` tool is the authoritative post-action read-back. `fixture_inspect` reports setup only and
must not be treated as evidence that an action persisted.

```powershell
node scripts/eval/campaign-runner.mjs --harness starnet --fixtures scripts/eval/fixtures/parity-v0.9.0.jsonl --manifest <starnet-manifest.json> --output <starnet.jsonl> --output-dir <evidence-dir> --attempts 3 --runtime-root <installed-root> --workspaces <active-credential-workspaces>
node scripts/eval/campaign-runner.mjs --harness hermes --fixtures scripts/eval/fixtures/parity-v0.9.0.jsonl --manifest <hermes-manifest.json> --output <hermes.jsonl> --output-dir <evidence-dir> --attempts 3 --source <frozen-hermes-source> --python <frozen-hermes-python> --home <isolated-hermes-home>
```

After parity is green, measure the actual installed desktop process and a provider-backed verified artifact.
The signed result distinguishes desktop process-to-health/station readiness from installed-runtime
send-to-first-token and send-to-verified-artifact latency.

```powershell
node scripts/eval/installed-performance.mjs --desktop-executable <installed-desktop-exe> --runtime-root <installed-root> --workspaces <active-credential-workspaces> --manifest <starnet-manifest.json> --contract scripts/eval/contracts/v0.9.0.json --fixtures scripts/eval/fixtures/parity-v0.9.0.jsonl --tasks scripts/eval/packs/parity-v0.9.0.jsonl --signing-key <receipt-private.pem> --output <performance.json> --receipt <performance-receipt.json> --output-dir <evidence-dir> --samples 5
```

The qualifying soak keeps the installed runtime alive for at least 48 wall-clock hours, samples health and
Windows CPU/RSS every minute, and executes an independently graded provider-backed fixture hourly. It cannot
set `qualifiesRelease:true` for a shorter duration, a missing provider call, a failed host grade, version drift,
an unexpected exit, or less than 99% planned sample coverage.

```powershell
node scripts/eval/installed-provider-soak.mjs --desktop-executable <installed-skynet-desktop.exe> --runtime-root <installed-root> --workspaces <active-credential-workspaces> --manifest <starnet-manifest.json> --contract scripts/eval/contracts/v0.9.0.json --fixtures scripts/eval/fixtures/parity-v0.9.0.jsonl --tasks scripts/eval/packs/parity-v0.9.0.jsonl --signing-key <receipt-private.pem> --output <soak.json> --receipt <soak-receipt.json> --output-dir <evidence-dir> --duration-hours 48 --health-interval-seconds 60 --active-interval-seconds 3600
```

Capture the provisional source-harness performance baseline with:

```powershell
npm run eval:baseline -- --samples 15 --receipt .dogfood/eval/performance-baseline.json
```

That baseline covers the deterministic bridge/evaluation rails and process startup. It explicitly
does not stand in for installed cold boot, first-token/useful-artifact latency, or the 48-hour soak.

After a provider-free control soak ends, validate every sample and bind the immutable evidence to the
candidate before signing it. This finalizer checks completion time, at least 99% planned sample coverage,
health/version continuity, process survival, and manifest provenance. Its receipt always retains
`qualifiesRelease:false` and cannot replace the installed provider-backed soak:

```powershell
node scripts/eval/soak-receipt.mjs --soak <soak.json> --manifest <starnet-manifest.json> --contract scripts/eval/contracts/v0.9.0.json --signing-key <receipt-private.pem> --receipt <soak-receipt.json>
node scripts/eval/runner.mjs verify-receipt --receipt <soak-receipt.json>
```

Run the deterministic seed pack:

```powershell
node scripts/eval/runner.mjs run --report .dogfood/agent-eval/report.json
```

The package shortcut is `npm run eval:agent-quality`. The default run executes five fixed quality
scenarios through the production `runAgentLoop`, six bridge-parity adapters, and two legacy seed
trajectories. It needs no credential and performs no network, shell, browser, message, or persistent
filesystem action. Quality tools are an in-memory allowlist; any tool marked external is refused by
the adapter and makes the task's exact tool-sequence grader fail.

## Fixed quality suite

| Task | Behavior under test | Side-effect boundary |
| --- | --- | --- |
| `quality-inspect-plan` | inspect before a bounded, evidence-based plan | read-only virtual project |
| `quality-dedicated-tool` | authoritative dedicated tool beats shell/browser | shell and browser hard-disabled |
| `quality-recover-failure` | one failed source leads to a different verified source | virtual docs and cache |
| `quality-stop-on-proof` | exact NXDOMAIN evidence ends research | no DNS, search, or browser call |
| `quality-verify-completion` | write, read back, report exact completion | in-memory draft; send hard-disabled |

These tasks are deliberately small and stable. Add a scenario only when it represents a distinct
decision boundary; do not turn the pack into a copy of the broad HTTP or UI gates.

## Scoring

Every grader is assigned to one of seven dimensions: `planning`, `toolSelection`, `recovery`,
`stopping`, `completion`, `latency`, or `cost`. A dimension score is passed graders divided by total
graders in that dimension. `qualityScore` is the unweighted mean of the seven dimension scores, so a
large completion rubric cannot hide a recovery failure. The process still fails closed when any
active task misses its configured correctness floor or regresses beyond its committed baseline.

Latency is deterministic trajectory time, not wall-clock scheduler noise. Cost uses reconciled
`agent.cost` rows; token input/output and USD are reported when observable. Exact tool order,
error-to-success order, terminal reason, artifact hash, and fresh read-back are graded from events or
receipts rather than from an agent's unsupported final claim.

### Current baseline (2026-08-03, source `cdd04226`)

`npm run eval:agent-quality` produces `PASS active=13 passed=13 failed=0 quality=100.0`; each of the
seven dimensions is 100%. The five judgment scenarios have these deterministic measurements:

| Task | Turns | Tools | Tokens | Observed USD | Deterministic latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| inspect + plan | 3 | 2 | 113 | 0.000153 | 170 ms |
| dedicated tool | 2 | 1 | 58 | 0.000077 | 120 ms |
| recover failure | 3 | 2 | 106 | 0.000138 | 170 ms |
| stop on proof | 2 | 1 | 54 | 0.000072 | 120 ms |
| verify completion | 3 | 2 | 91 | 0.000114 | 180 ms |

This is a replay/loop conformance baseline. A perfect score means the harness, scoring, accounting,
and safety boundaries reproduce the reviewed trajectories; it does **not** mean every production
model will make the same decisions. Stochastic model/prompt comparisons must record repeated runs
against these same virtual tools and report model, prompt/build identity, sample count, and variance.

## Failure interpretation

- A correctness failure names the grader and actual evidence. Treat a wrong tool sequence or a
  claimed completion without fresh read-back as a behavior regression, even if the prose sounds good.
- `toolSelection` plus a nonzero `externalDispatches` is a benchmark isolation breach. Stop; do not
  accept or rebaseline that receipt.
- `recovery` failure means the agent repeated a dead path, failed to change strategy, or reported an
  answer without the successful fallback.
- `stopping` failure means redundant turns/tools, the wrong terminal reason, or work continuing after
  sufficient evidence. It often predicts excess latency and tokens too.
- `latency`/`cost` alone means the outcome stayed correct but became less efficient. Inspect turns,
  tool calls, retries, and token split before changing thresholds.
- A missing task, invalid row, unknown grader, or pending adapter is never counted as an evaluated
  pass. Do not update `baseline.jsonl` merely to make a regression green; review the changed
  trajectory and explain why the new behavior is preferable.

## Highest-leverage next measurements

1. Add an opt-in repeated-model runner over the same virtual tool boundary (minimum five samples),
   keeping the deterministic replay run as the merge gate. This is the missing evidence for prompt
   and model-quality claims.
2. Capture p50/p95 wall latency and token variance separately from deterministic trajectory time;
   never mix provider jitter into the conformance score.
3. Add one multi-agent delegation scenario only after its worker transcript and aggregate accounting
   can be captured without network or external writes. The current suite measures a single lead loop.

Evaluate a candidate trajectory file against another baseline:

```powershell
node scripts/eval/runner.mjs run --tasks tasks.jsonl --candidate candidate.jsonl --baseline baseline.jsonl --report report.json
```

The process exits `1` when a correctness grader or configured metric threshold fails, and `2`
for invalid input. Pending tasks are visible skips, never green evaluations.
The versioned JSON schemas live in `schema/task.schema.json` and
`schema/trajectory.schema.json`; the runner also validates the required invariants without adding
a JSON-schema runtime dependency.

## Recording a run

Export raw harness events as JSONL (`name`/`payload` or `type`/`data`), then normalize and redact:

```powershell
node scripts/eval/runner.mjs record --task my-task --input raw-events.jsonl --meta run-meta.json --output trajectory.jsonl
```

`run-meta.json` may carry `runId`, `startedAt`, `endedAt`, `finalText`, `artifacts`, and explicit
metrics. An artifact receipt should include `path`, `sha256`, `mutatedAt`, `verifiedSha256`, and
`verifiedAt`. Verification is fresh only when its hash matches and its timestamp is not older than
the mutation.

Secrets are removed by sensitive field name and common bearer/key patterns before a trajectory or
report is written. Keep source event captures in ignored evidence directories; only synthetic,
reviewed fixtures belong in Git.

## Activating a bridge scenario

The six bridge scenarios are active and default runs execute their real adapters from
`adapters/bridge.mjs`: semantic continuation through `runAgentLoop`, restart analysis through the
append-only run journal, isolated `code.run`, stdio LSP edit deltas, and segmented-history recall
after restart. `fixtures/candidate.jsonl` is the reviewed deterministic receipt; the test requires
the live adapters to reproduce it byte-for-byte. New scenarios follow the same pattern: add an
adapter, baseline/candidate evidence, concrete graders, and fail-closed thresholds.

## Personality response evaluation

`node scripts/personality-eval.mjs --out .tmp/personality-trials` prepares a credential-free
trial plan from the actual shipped personality composer. It produces no model responses or
quality verdict. Each of the six presets, plus Dry with humor disabled, receives the same ten
turns covering disagreement, uncertainty, failure, correction, frustration, formal artifacts
and conversational drift.

For real responses, supply an isolated `STARNET_PERSONALITY_EVAL_KEY` and run the script with
`--live --model <OpenRouter model id> --out <new directory>`. Repeat for each model being
certified. It executes no tools and reads no installed credentials. Review the randomly named
response files before consulting `plan.json`, which contains the personality answer key.
Score factual fidelity, uncertainty, usefulness, respectful disagreement and artifact style
separately from whether the reviewer can identify the intended personality. Do not count
successful capture or the fast wiring tests as proof of model personality quality.
