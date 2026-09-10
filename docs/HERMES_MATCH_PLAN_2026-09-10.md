# StarNet improvement plan informed by Hermes — 2026-09-10

Status: implemented in an isolated branch with full source gates green. Core browser verification passed; integration, live-model comparison and soak remain pending. See [execution receipt](../qa/audits/hermes-stress-2026-09-10/EXECUTION.md).

## Outcome

Close the four demonstrated Hermes advantages while strengthening StarNet's own promise: a usable result, a provable outcome, and a clear next action. Use Hermes's source and regression tests as an engineering reference, translate the successful behaviors into StarNet's JavaScript sidecar and station UI, and verify the result on the same workloads.

Success means a user can retry a disconnected task without accidentally starting it again, distinguish partial work from finished work, read and copy a well-structured report, and obtain validated machine-readable results from a team.

## Grounding and boundaries

The [stress audit](HERMES_STRESS_AUDIT_2026-09-10.md) provides the reproduced failures, receipts, and executable probes. Hermes is pinned to 0.21.1 / `v2026.9.7`, commit `2237be355906fbe6065ce1815711eee52b2d646e`, in `.audit/hermes` of this worktree. The original StarNet candidate was `83c896e7d`; current integration is `2aa8305c0`. On this planning pass, git diff showed no intervening changes in the four relevant StarNet files: openai-compat.js, orchestration.js, chat.js, and shared/schema.js. Recheck at implementation start.

The audit established controlled runtime and rendering behavior. It did not establish a general Hermes advantage in reasoning, speed, cost, memory, onboarding, or long-duration autonomy. Those belong in a later measured comparison.

Architecture constraints: one sidecar process per workspace, one runOnce loop, existing durable-store helpers, existing cost accounting, existing permissions, and the existing station visual language. Shared events/schema remain owner-controlled. Create narrowly scoped sidecar helpers where necessary; do not broaden the frozen shared validator just to support result contracts.

## How we will use the Hermes repository

For each slice, record a small reference note containing the pinned source function, relevant regression tests, demonstrated behavior, StarNet destination, and differences we deliberately retain. Follow implementation through its actual callers; a helper or release note alone does not prove a feature works.

| Reference to study | Lesson to extract | StarNet destination |
| --- | --- | --- |
| `gateway/platforms/api_server_openai_routes.py`: `_finish_reason`, `_hermes_extras`, sync/SSE handlers; `tests/gateway/test_api_server.py` | Preserve failure and partial-result truth across a client protocol | `sidecar/openai-compat.js`, native run/recovery records |
| `gateway/platforms/api_server.py`: `_IdempotencyCache`, `_make_request_fingerprint` | Coalesce matching in-flight requests and replay results | A request-level reservation helper composed into the existing API |
| `gateway/platforms/api_server_run_idempotency.py`; run-idempotency and runs tests | Durable admission, scope, retained run identity, interrupted-owner handling | Existing `durable-store.js`, run journal/recovery, and API run identity |
| CLI `_render_final_assistant_content`, `agent/markdown_tables.py`; CLI Markdown and table tests | Preserve document structure and adapt to available width | A shared COMMS prose renderer styled with StarNet tokens |
| `tools/delegation_output_schema.py`, delegation caller, `tests/tools/test_delegate_output_schema.py` | Validate child output and perform one bounded corrective turn | A dedicated result-contract helper used by dispatch/spawn/resume and later API output |

Translate behavioral cases into StarNet tests and shared fixture data. Select parser/validator libraries through small compatibility probes before committing to a dependency. If source or test code is reused directly, retain the applicable source notices; record provenance for adapted material.

Do not reproduce these reference limitations: chat-cache memory lifetime as a restart guarantee, raw-key-only cache identity as sufficient caller isolation, silent schema-validation fallback, or broad extraction of a convenient JSON object from surrounding prose. The five-minute chat cache is separate from Hermes's durable run store. Neither gives us permission to claim universal exactly-once external execution.

## Delivery sequence

### Slice 0 — Turn findings into acceptance cases

Effort: small. Precedes implementation.

- Register durable finding records using the repository's bug workflow, with sibling API/stream/UI/recovery paths and explicit coverage gaps.
- Convert the audit probes into normal regression tests. Preserve the original failure receipts; add named scenarios rather than a parallel evaluation framework.
- Separate primary model calls, auxiliary calls, tool mutations, visible messages, and billing events in the oracle. The earlier idempotency probe counted auxiliary skill-review calls separately for a reason.
- Define contract matrices for terminal states, keyed requests, report structures, and output schemas before editing production code.

Exit: each demonstrated defect fails a focused behavioral test on the implementation base, and the live reproduction still matches the audit. Already-fixed cases are recorded and omitted from implementation.

### Slice 1 — Make completion status truthful everywhere

Effort: small to medium. Highest priority.

Build a consistent outcome mapping from the existing host result: completed, failed, cancelled, interrupted, truncated/limited, or awaiting input. Keep transport closure separate from successful task completion.

- Preserve useful partial text. For non-streaming failures with no usable result, return the existing error envelope and appropriate error status. When partial text exists, expose an explicit incomplete/failed outcome and error details.
- Once SSE headers are sent, express failure in the terminal event/chunk; do not attempt to change the HTTP status afterward. A transport `[DONE]` marker must never be the only outcome signal.
- Audit `/v1/runs` too: its current fallback maps several non-success reasons to `run.completed`. Preserve compatibility deliberately; add normalized outcome fields where needed rather than silently renaming shared events.
- Confirm COMMS history, API results, persisted run state, and the recovery UI agree. Derive any user-facing Resume/Retry/Open partial result action from existing recovery authority.
- Preserve measured usage for work already done, including failed runs. Never bill or count replayed delivery as a second execution.

Exit proof: inject failure before output, after one token, during a tool call, and at end-of-stream; test cancellation, output limits, clarification, and restart. Native state, sync responses, streamed responses, and restored history must agree. No partial failure is presented as a successful task. Test at least one real compatible client in addition to inspecting JSON.

### Slice 2 — Make request retries safe and recoverable

Effort: medium to large. Depends on Slice 1's outcomes.

Add request admission around the existing runOnce call. Keep it distinct from the existing connector-write ledger, which protects individual writes inside a work item.

- Scope a key to the authenticated authority and endpoint; bind it to a canonical request fingerprint and the selected agent/project context. Persist the effective model/provider/run identity used on first admission. Never use plaintext credentials as stored scope identifiers.
- Atomically reserve before dispatch. Matching requests attach to the original run or replay its recorded result. Conflicting reuse returns a clear conflict; a deliberately new task uses a new key.
- Make concurrent duplicates share one execution. A duplicate listener disconnecting must not cancel another listener's task. Preserve the current unkeyed-request behavior, and explicitly define cancellation/reconnect behavior for keyed work using existing run lifecycle controls.
- Persist reservations with StarNet's durable-store primitives. Link them to authoritative run/result storage; do not reconstruct an exact result from a truncated journal preview. On restart, an uncertain prior attempt becomes recoverable/interrupted, never an automatic second run.
- Recheck access before replay. Cache retention must not bypass revoked project/tool authority or expose another caller's output. Bound retained records and output references without evicting active work or introducing user-work quotas. Document the replay retention window.
- Support streamed reconnects through the existing run identity and delivery mechanism. Do not create another execution loop or invent automatic exactly-once behavior for external systems whose outcome is unknown.

Exit proof: sequential and concurrent duplicates; same key/different body; different caller/agent/project; client disconnect; explicit cancellation; restart before dispatch, during work, and after work but before reply; storage failure; retention expiry. Count actual executions, local fixture mutations, transcript rows, auxiliary triggers, and costs. Matching retries admit one run within the declared guarantee; uncertain mutations require recovery evidence.

StarNet benefit: API consumers and the station see one durable piece of work with recoverable progress, rather than unrelated attempts.

### Slice 3 — Give COMMS proper report structure

Effort: medium. Independent of request admission; integrate as a separate slice.

Extract the current prose renderer into a reusable module and expand it deliberately: tables, ordered and nested lists, blockquotes, and named links, retaining headings, emphasis, fenced code, and copy controls.

- Use semantic structure with StarNet's existing colors, typography, spacing, and control styling. Preserve the phosphor station appearance.
- Keep raw source as the durable content. Live streaming, restored history, and any sibling surface using the same prose path render from that source consistently.
- Preserve escaping, safe link protocols, literal code contents, and inert HTML. Handle incomplete Markdown during streaming without resetting selection or jumping the viewport on every token.
- Let wide tables scroll within the report or use an explicitly tested compact presentation. Keep headers associated with values; do not silently omit columns or force the whole panel wider.
- Retain exact code copying. Verify existing message-copy semantics explicitly. Make a clear distinction between copying the report source and copying a runnable code block.
- For large deliverables, reuse the existing artifact-opening flow. A transcript remains a useful summary and evidence trail; it does not become a second document editor.

Exit proof: the audit's identical report renders correctly at narrow, normal, and expanded COMMS widths, at supported UI zoom levels, during streaming, after reload, and after restart. Test keyboard access, selection/copy, malformed links, escaped pipes, nested structures, and large reports. Verify readability in the real seeded UI and check for scroll/selection regressions.

StarNet benefit: comparisons and instructions are immediately usable inside the station, while runnable artifacts still open through their normal payoff action.

### Slice 4 — Strengthen result contracts, then support API JSON output

Effort: medium to large. Uses Slice 1's failure reporting and Slice 2's retry identity.

Create a dedicated host-owned result-contract module. Keep the existing basic contracts and one-repair ceiling compatible.

- Select and pin a JavaScript validator after testing the current basic schemas plus numeric bounds, string patterns/lengths, item bounds, enums, alternatives, additional properties, and local references. Publish the supported dialect/subset.
- Reject unsupported schemas before work starts. Bound validation complexity, regex work, reference depth, and payload size. Disable remote reference retrieval. A missing validator or failed validation must not silently become a successful result.
- Use the same implementation for foreground dispatch, background spawn, resumed workers, and final API responses. Request additive shared-contract fields through the owner only if required.
- Validate the final value. Allow at most one output-only corrective turn, using concise validation errors and existing task context. Repair must not repeat the original side effects. Record original/repair usage and preserve failed output for diagnosis without marking it valid.
- Maintain strict whole-response JSON for machine contracts. Human-facing Markdown can be rendered independently; do not ambiguously extract whichever object happens to validate.
- Immediately reject unsupported `response_format` requests clearly while implementation is pending. Once available, honor `json_object` and supported `json_schema` requests through provider support where available plus authoritative host validation.
- For strict JSON streaming, buffer until validation or explicitly reject that streaming combination until supported. Never stream invalid bytes and then imply that a later correction erased them.

Exit proof: every rich schema case accepted and enforced in the Hermes reference has a StarNet equivalent; malformed and semantically invalid output cannot finish as valid. Exercise dispatch/spawn/resume, missing dependency, one successful repair, exhausted repair, cancellation, restart, and unsupported provider behavior. Validate returned bytes independently at the client. Run a local multi-worker extraction task and prove no duplicate fixture writes during repair.

StarNet benefit: teams can reliably hand one another usable records, with readable summaries and machine-checkable artifacts derived from the same validated result.

### Slice 5 — Establish practical parity with real tasks

Effort: medium for the campaign, plus a separate 48-hour soak. Starts after the repaired scenarios pass.

First promote the existing deterministic audit cases into a permanent, named regression pack. Then run a bounded same-model comparison. Use identical task data, available capabilities, permissions, model/provider settings, task budgets, and fresh profiles; record native tool differences. Do not give StarNet extra instructions that conceal a weakness or restrict both systems to a fixture-only path for all usability judgments.

Proposed first campaign: 12 practical scenarios, three attempts per system (72 runs):

1. Exact JSON extraction with numeric and string constraints.
2. Three workers completing out of order, with deterministic aggregation.
3. A malformed worker result repaired without repeating its mutation.
4. A failed check, repair, and identical check rerun.
5. Large tool output with a decisive fact at the end.
6. Provider disconnect after useful partial output.
7. Duplicate API submission while work is in flight.
8. Restart after a local mutation but before response delivery.
9. Switching projects and later resuming the original task.
10. Producing, reading, and copying a report with a wide table.
11. Opening and revising a produced artifact through the normal UI.
12. Recovering a blocked scheduled task with a local destination.

Use host-observed artifacts and mutations as the correctness oracle. Measure success, false completion, duplicate work, schema validity, retained context, manual interventions, model/auxiliary calls, token usage, and latency to a verified usable artifact. Inspect actual UI workflows for usability; add a small attended novice task set and count required decisions/backtracking rather than inferring ease of use from test counts. Use blind artifact review where quality is subjective. Keep interrupted/unavailable trials visible and publish individual outcomes; three attempts are an initial diagnostic sample, not a statistical superiority claim.

Acceptance: zero false completions, duplicate fixture mutations, cross-project leakage, or invalid accepted contract results in the repaired scenarios. Compare task success and user interventions case by case. Preserve pre-change and post-change runs where practical. Approve a concrete model/provider and spending ceiling before paid execution; no model calls are included in this planning task.

After the short campaign, run a 48-hour isolated soak covering reconnect, restart, cancellation, scheduled local delivery, and long-lived state. Do not claim long-duration parity until it finishes. Signed/installed desktop evidence is separate from source-sidecar proof.

## Next source-guided investigations

These are hypotheses to investigate after the proven gaps, not extra confirmed Hermes wins or an automatic feature backlog.

| Area | Hermes material to inspect | Question for StarNet |
| --- | --- | --- |
| Long-session context | compression watermark/lineage, truncated-summary guards, compaction stall/interrupt tests | Does compaction retain decisive facts, task ownership, and recovery instructions without losing progress? |
| Memory and skills | memory lifecycle and curator/skill tests, actual persistence callers | Do repeated tasks improve without creating stale or incorrect user beliefs? |
| Reconnect and operator recovery | MCP reconnect tests, empty-response recovery, pending-turn recovery | Can users recover through the normal workflow with fewer manual interventions? |
| Continuation usability | cwd-scoped resume and session-recovery CLI tests | Can a user reliably find and resume the right StarNet task across projects and restarts? |
| Efficiency | prompt/cache invalidation and auxiliary-call tests | Which calls contribute to a usable result, and which add cost or delay without measurable benefit? |

For each candidate, first run an equivalent scenario against current StarNet. Prioritize only demonstrated user impact. Re-pin the Hermes reference explicitly for later campaigns; maintain a delta notebook of relevant upstream changes rather than silently moving the baseline.

## Integration and completion rules

Use isolated worktrees and small commits. The API slices share a hot file and should integrate sequentially. Renderer and result-contract work have separate boundaries, but this plan does not start or delegate implementation agents. Preserve the original audit as historical evidence.

For every production slice: focused regression, production-sidecar live proof, relevant customer journeys, full fast gate, and full HTTP gate for backend/route changes. Exercise persistence through a real restart and review billing/permission/lifecycle siblings. Synchronize Codex branches by merging current trunk into the lane, following the merge ritual, before integration.

The audit's full HTTP command timed out; a passing tail rerun is coverage evidence, not a green full-command receipt. Before integration, obtain a complete gate run under a justified runner budget without removing tests or concealing the timeout. No release or station-wide readiness claim follows from these lane results.

Definition of matched: the four original reproducers now pass through the real StarNet surfaces, no relevant sibling path still has the defect, and the controlled same-model campaign supports the specific claimed parity. Report source-verified, installed-verified, and long-soak-verified outcomes separately.

Recommended first delivery: Slice 0 + Slice 1, then safe retry admission. Deliver the renderer and stronger contracts as subsequent reviewable increments. The real-task campaign determines the next investment.
