# Response latency repair and Hermes comparison

Source repair: `9b2ce2d35804623e97fa0a081cc11ffddd33d534` (includes the initial cache repair `6c9dd033b`) on `agent/latency-audit-0913`.

## What changed

StarNet now places reusable instructions before per-run metadata and gives the reusable system prefix its own explicit Claude cache boundary. The full system context receives a second boundary, preserving reuse within a run. The remaining two markers cover recent conversation content. Native Claude and Claude through OpenRouter implement the same layout; generic providers keep their normal string prompt and benefit where their provider supports matching prefixes. Extra leading memory-recall notes retain their text and system authority.

The repair keeps the complete task doctrine, manual, capability truth, skills, Task Brief instructions, memory, history, tool definitions and completion checks. No task step, approval check, reasoning effort, tool budget, retry budget or compaction step was removed or reduced. Runtime identity remains fresh on each request. The only prompt-content change is the order of the existing runtime block relative to reusable instructions. Old recovery checkpoints keep their existing provider-valid prompt shape.

Configured Codex/Kimi/Grok fallback providers now authenticate when selected. A successful activation is reused within the run; cancelled starts do not refresh; failed refresh remains an error and can be retried. Primary-provider authentication, credential isolation, supported effort behavior and provider fallback ordering remain in force.

## Before and after

| Observation | Before | Repaired source |
| --- | --- | --- |
| First changing byte in repeated seeded system prompts | Character 210, at the run ID | Character 25,729 |
| Explicit Claude system layout | One changing cache block | Stable prefix plus full-context boundary |
| Task context and tools | Complete | Complete; tested across three live adapters |
| Unused OAuth backup | Could refresh before primary inference | No refresh until selected |

These are request-shape and execution-path measurements, not a real-provider speedup percentage. Provider/model, effort, cache minimums and expiry, tools and upstream load still determine real latency.

The permanent `test/prompt-cache-prefix.e2e.test.js` fails against unchanged baseline `7a087d3be` (one system block where two are required) and passes on the repair. The same three-provider proof passed through `node dev/seed.js --keep`. Before/after metadata is retained in `qa/evidence/latency-0913/`.

## Does Hermes have the same issue?

Compared with public Hermes source pinned to `b9271bcb34e1a8b8fe0eeaef0ef4a6e1f93ba543` on 2026-09-13.

**The current Hermes cache path avoids this specific defect.** It orders system material into stable/context/volatile sections, stores a stable-prefix hint, and splits the outgoing system text at that prefix. Its standard marker budget is stable system, full system, and two recent non-system messages. I executed its unmodified pure cache helper on two identical prefixes with different runtime IDs: the stable blocks matched, the runtime blocks differed, and the full text was preserved. This is a helper-level comparison, not a full Hermes app or paid-provider benchmark. Sources: [system assembly](https://github.com/NousResearch/hermes-agent/blob/b9271bcb34e1a8b8fe0eeaef0ef4a6e1f93ba543/agent/system_prompt.py), [cache implementation](https://github.com/NousResearch/hermes-agent/blob/b9271bcb34e1a8b8fe0eeaef0ef4a6e1f93ba543/agent/prompt_caching.py).

**Hermes still does context compression and provider recovery.** Those are necessary work, and can still take time. Its current compressor contains explicit handling for stalled, failed and truncated summaries, including cases that abort while preserving messages. I did not copy a policy that drops task context or declare Hermes universally faster. The downloaded source is newer/more precise than some prose documentation, so the comparison uses the pinned implementation. [Compressor source](https://github.com/NousResearch/hermes-agent/blob/b9271bcb34e1a8b8fe0eeaef0ef4a6e1f93ba543/agent/context_compressor.py).

I did not establish that every Hermes fallback/authentication path is free of eager refresh waits; that separate StarNet repair is supported by StarNet's own code and regression tests.

## Remaining limitations

The earlier audit's retry/compaction progress-display gaps remain separate follow-up work. Necessary retries and summaries still execute. Large prompts were retained deliberately; the first repair enables reuse instead of deleting instructions. Neither the affected customer's exact cause nor a real-provider latency improvement has been established. No installer was rebuilt or deployed.

## Verification

- Native Claude cache and preservation regressions: 86 assertions PASS.
- OpenRouter cache, recall and preservation regressions: 89 assertions PASS.
- Provider factory/deferred OAuth regressions: 135 assertions PASS.
- Codex 66, Gemini 47, runtime identity 15, loop recovery 60 assertions PASS.
- Saved fallback HTTP suite PASS, including credential isolation and restart.
- New three-adapter HTTP regression and seeded live repetition PASS.
- Final frozen-source fast gate: 779/779 PASS. Full HTTP: 115/115 PASS. Customer journeys on frozen source: 34/34 PASS. Receipt and log hashes: `qa/evidence/latency-0913/gates.json`.
- The first HTTP attempt hit a Windows libuv closing-handle assertion after the outcomes suite. That suite passed unchanged in isolation; the complete second HTTP gate passed. The HTTP run began before the final metadata-forwarding correction; the corrected factory and cache regression also passed separately, followed by frozen-source fast and customer-journey gates.
- The audit's earlier local-voice failure came from using NODE_PATH without a local dependency directory. The repair workspace now has a dependency junction; the local-voice test passes. No test was bypassed or loosened.

Tracked bug: `qa/bugs/c9201c15-run-metadata-invalidates-reusable-prompt-cache-a.md`. Source-fixed, installer-unverified, customer-recovery-unconfirmed are distinct statuses.

