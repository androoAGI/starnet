# Hermes advantage stress audit — 2026-09-10 UTC

Four concrete Hermes advantages were reproduced: honest partial-failure status at the OpenAI-compatible API, retry deduplication at that API boundary, richer delegated-result validation, and more readable report rendering. These are bounded findings, not a claim that Hermes is more reliable overall.

## Subjects and method

- StarNet 0.11.1, commit `83c896e7d2c5b88d99147e75fbeedde6fb93c27b`, isolated `agent/hermes-stress-0910` worktree.
- Hermes 0.21.1, official `v2026.9.7` release, commit `2237be355906fbe6065ce1815711eee52b2d646e`. A separate shallow checkout was used; the installed Hermes 0.19.0 and the existing reference checkout were not updated.
- No paid-provider calls or real external messages/actions. StarNet tests booted production sidecars with deterministic loopback providers. The UI report used `node dev/seed.js --keep` through an audit wrapper and the normal COMMS send path.
- Hermes HTTP probes used production routes with controlled agent results on an actual loopback aiohttp server. They establish API behavior, not end-to-end reasoning or provider recovery. Renderer and schema probes executed production Python functions. Python 3.11.15 used available installed dependencies plus an isolated pytest/jsonschema environment; this is not a clean-installer claim.
- Same-model task quality, cost, completion speed, long-duration soak, installed desktop lifecycle, and remote delivery reliability were not measured. No exhaustive “all edges found” claim.

## Ranked findings

### 1. P1 — StarNet hides failure after partial output from API clients

**Reproduction:** provider emits `PARTIAL: started checking the report.` then an SSE error `401 Unauthorized: AUDIT_FATAL_PROVIDER`. Repeat three times each through StarNet's native run endpoint, non-streaming chat-completions endpoint, and streaming chat-completions endpoint.

**StarNet:** all three native runs ended `reason: error`. All six compatible API replies returned HTTP 200 and `finish_reason: stop`; streamed replies also emitted `[DONE]`. The client-facing envelope omitted the failure. This is a real failed run being represented as normal completion at the adapter boundary.

**Hermes:** all three HTTP probes supplied the corresponding partial/failed agent result and received `finish_reason: error` plus explicit `completed: false`, `partial: true`, `failed: true`, and the error explanation.

**Impact:** an API consumer can accept incomplete work as finished instead of offering recovery. This does not establish that StarNet's native COMMS hides the error.

**Source:** `sidecar/openai-compat.js:132` maps an error with text to stop; sync and stream paths use it at lines 401/422. Hermes `gateway/platforms/api_server_openai_routes.py:68` and its response envelope preserve failure.

**Recommended repair:** preserve the partial text while emitting an explicit terminal error in both API modes. Add a regression that injects an error after the first token and compares native truth to both client envelopes.

### 2. P1 — API retries start the StarNet task twice

**Reproduction:** three pairs of identical non-streamed `/v1/chat/completions` requests, each pair sharing an `Idempotency-Key`.

**StarNet:** exactly two primary provider calls per pair. Background skill-review calls were separately identified and excluded; the raw total is not the primary-run count.

**Hermes:** one agent dispatch per pair, observed at the production HTTP adapter's run boundary.

**Impact:** a client retry can duplicate task execution and associated work. Duplicate real-world mutations were not performed or proven. StarNet's within-run tool idempotency is a different mechanism and passed its dedicated 24-assertion suite.

**Source:** `sidecar/openai-compat.js` has no handling for `Idempotency-Key`. Hermes `api_server_openai_routes.py` uses `_run_idempotent` and body fingerprints.

**Recommended repair:** key requests by authenticated caller plus idempotency key, bind the key to a body fingerprint, coalesce in-flight duplicates, and reject conflicting reuse. Define retention and restart behavior explicitly; this audit only measured sequential retries within one process.

### 3. P2 — Hermes renders work reports more clearly

**Identical report:** heading, three-column table, numbered steps with a nested bullet, quoted warning, named link, and fenced JSON.

**StarNet live COMMS:** table pipes and separator row remained literal text; the quote retained its `>` marker; `[Open evidence](URL)` remained literal surrounding a bare-URL anchor. Read-only DOM inspection found zero tables, zero ordered lists, and zero blockquotes. The nested bullet lost its indentation in the rendered text. The report persisted after reload. Headings, bold text, fenced JSON, and a code-copy button were present; clicking copy showed `Copied`.

**Hermes production CLI renderer:** the same text became a readable table, nested numbered list, quote block, and `Open evidence` link label at widths 40, 80, and 120. Captured outputs are committed beside the receipt.

**Source:** StarNet `frontend/app/chat.js:531` deliberately implements a small Markdown subset. Hermes `_render_final_assistant_content` returns a Rich Markdown renderable. This is a demonstrated presentation capability advantage; terminal and desktop pixel aesthetics were not ranked.

**Recommended repair:** support tables, nested ordered/unordered lists, quotes, and named links without losing the existing escaping and code-copy behavior. Test narrow panels and clipboard text independently.

### 4. P2 — Hermes accepts and enforces richer delegated output contracts

A basic object schema worked in both. StarNet rejected all five richer cases before starting the child: `minimum`, `pattern`, `minItems`, `oneOf`, and `$defs`/`$ref`. Hermes accepted all five schemas, accepted valid examples, and rejected the corresponding invalid examples.

StarNet already supports basic strict JSON plus one bounded repair; it is not missing structured delegation. Hermes's advantage is schema expressiveness. The comparison had `jsonschema` installed; Hermes's helper can degrade to JSON parsing without semantic validation if that package is missing, so this result must not be generalized to that configuration.

**Source:** `sidecar/tools/builtin/orchestration.js:80` permits only six schema keywords; Hermes `tools/delegation_output_schema.py` selects a JSON Schema validator.

**Recommended repair:** expand validated schema support for actual business constraints while retaining bounded validation work and explicit unsupported-schema errors.

## Shared weakness: JSON response-format requests

Both compatible APIs accepted `response_format: json_object` and strict `json_schema` requests but returned HTTP 200 with non-JSON text. StarNet did not forward the format to the scripted provider; Hermes did not forward it to the controlled agent boundary. This is not counted as a Hermes win. Neither API should silently imply enforcement: implement it or reject unsupported format requests clearly.

## Verification and controls

- StarNet offline evaluation: 1,000/1,000 fault attempts; 32/32 workload scenarios; 4/4 intentional violation probes flagged. These are scripted harness tests, not live-model benchmarks.
- Seven focused production-sidecar suites: output-pressure/restart recovery (15 assertions), tool idempotency (24), provider recovery (15), transcript compaction (19), project scope (9), delegated-session isolation (31), run-recovery API (37): **150 assertions passed**.
- Hermes targeted set: **48 passed**; expanded set: **142 passed**, with 54 aiohttp AppKey warnings. Total **190 tests passed** across 12 selected files.
- Full StarNet fast gate: 752/752 steps passed. HTTP coverage: all 108 declared suites passed across a 101-suite prefix and a seven-suite tail rerun. The standard full HTTP command timed out, so its gate is not green.
- Initial fresh-worktree fast gate stopped at missing dependencies (step 84); dependencies were installed and a full rerun launched. Initial Hermes test collection likewise lacked dependencies; the recorded passing rerun used the explicit dependency environment.
- The first UI launcher combined two workspace-variable aliases incorrectly and entered onboarding. That was corrected in the audit wrapper before the reported COMMS check. The accidental onboarding delay is not scored as a product disadvantage.

## Evidence and rerun locations

Machine-readable receipt: `qa/audits/hermes-stress-2026-09-10/receipt.json`. It contains exact identities, outcomes, method boundaries, and SHA-256 hashes of raw evidence retained in this worktree's `.audit/` directory.

Audit probes: `.audit/partial.cjs`, `.audit/idempotency.cjs`, `.audit/schema.cjs`, `.audit/live-seeded.cjs`, `.audit/seed-entry.cjs`, and `.audit/hermes/probe_{http,format,audit}.py`. Run Node probes from the worktree root. Run Python probes from `.audit/hermes` with `.audit/py/Scripts/python.exe`, an isolated `HERMES_HOME`, and the recorded installed Python site-packages path. The UI provider is deliberately scripted and its output is retained in `.audit/live.json`.

Official reference release: [Hermes Agent 0.21.1](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.7).

No product code was changed or merged by this audit. The receipt generated by `eval:gate` is retained as evidence in this isolated branch.

## Full gate receipt

StarNet full fast gate: **752/752 steps passed**, exit 0. Both temporary UI audit servers were stopped after verifying their recorded process identities. The standard HTTP command exceeded its 900,000 ms limit and exited 124 after 101 suites completed, while workflow-takeover was at the interruption boundary. Rerunning from workflow-takeover through the final suite passed all seven remaining suites, exit 0. This covers all 108 declared suites across two runs; it is not a passing receipt for the uninterrupted full HTTP command. Probe copies with normalized LF line endings are archived under qa/audits/hermes-stress-2026-09-10/probes/ (see its layout instructions).
