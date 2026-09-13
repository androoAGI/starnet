# Agent response latency audit — 2026-09-13

Audited source: `7a087d3be654decd9429321cae4bab7ec01c4bbc`, isolated branch `agent/latency-audit-0913`.

Follow-up: see [the repair and Hermes comparison](AGENT_LATENCY_REPAIR_2026-09-13.md) for the implemented changes. This document retains the original before-fix audit.

## Verdict

There are actionable StarNet performance and observability issues. Model, effort, provider load, tools and conversation length still matter, but the complaint should not be dismissed as model speed alone. The strongest engineering issue is a changing run ID inside the cacheable system prefix. No evidence identifies which issue affected the reporting customer: their version, settings and run trace were not supplied.

This is an audit, not a repair or release. No product source or user settings changed.

## Findings, ordered by priority

### 1. Changing run metadata defeats reuse of the full cached system prompt across requests

**Live request-shape proof; provider latency impact inferred, not benchmarked.**

`sidecar/runtimeinfo.js:53` adds a unique `Run id` to the runtime block. `sidecar/index.js:16999` places that block before the manual, capabilities, skills and other reusable instructions. Repeating the same short request in the same conversation produced two 26,506-character system prompts whose common prefix was only 210 characters; the first difference was the run ID.

The direct Anthropic adapter consolidates the system into one text block and marks it cacheable (`sidecar/providers/anthropic.js:462`). The OpenRouter Claude path likewise marks the leading system text (`sidecar/providers/openrouter.js:67`). The system prefix therefore changes at every new run, even while the remaining instructions are reusable. This does not mean caching within a multi-turn run never works, or that every provider loses every possible cache hit.

Anthropic documents exact matching through the cache breakpoint: [Prompt caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). This supports the inference that the full system cache cannot be reused across these different runs. Real cache-read usage and latency were not measured.

**Repair direction:** keep reusable instructions in a stable prefix with its own cache boundary; append run-specific metadata after it. Moving metadata to the end of the same single cacheable block alone is insufficient for the explicit Claude system breakpoint. Preserve truthful runtime identity.

### 2. Provider retries can look like unexplained thinking

**Live reproduced.**

The local provider returned two HTTP 429 responses with `Retry-After: 1`, then streamed a successful answer. StarNet made requests at 18, 1,038 and 2,262 ms; the first answer token arrived at 2,372 ms. The live run stream contained start, answer, cost and end events, but no explanation of those two retries.

Pre-stream retries occur inside the adapters. They do not invoke the loop's recovery recorder. `sidecar/providers/openai-compatible.js:377`, `openrouter.js:390` and `codex.js:407` honor provider waits up to 60 seconds per retry. Connect timeout defaults to 30 seconds; stream idle timeout is 300 seconds (`provider.js:79`). Separate loop recovery has up to 105.6 seconds of scheduled backoff (`loop.js:746`), excluding time spent on actual attempts. These limits protect recovery and are not delays added to every successful request. Exhausted pre-stream attempts are marked to avoid blindly multiplying the same retry budget.

**Repair direction:** expose and persist pre-stream retry reason, attempt and wait; distinguish waiting for provider, retrying, summarizing and receiving text. Do not simply shorten all reasoning timeouts.

### 3. Context recovery can require many sequential model calls, with late progress reporting

**Live reproduced with synthetic history and forced context-overflow responses.**

A 40-message, approximately 280 KB history caused one deliberately rejected primary call, six sequential summary calls, then a successful primary retry. First answer text arrived at 1.87 seconds with a very fast local fixture. `agent.compact` appeared only after all six summary calls completed. A second equivalent case repeated the six summaries.

`sidecar/compaction-summarizer.js:20` uses 48,000-character chunks, up to 12, folded sequentially. `loop.js:877` ordinarily waits for prior provider usage before deciding to compact; an initial overflow can instead force the fold. A long history does not automatically trigger a paid fold before every first call. Browser history fitting mitigates some cases, so these API-level stress cases are not evidence that all long browser conversations behave this way.

Without an explicitly configured auxiliary tier, summaries use the active run model and inherit its adapter effort (`sidecar/index.js:2404`, `2424`). Six slow reasoning calls could therefore add substantial time. Actual provider duration was not measured.

**Repair direction:** announce compaction before starting, report chunk progress, investigate durable reuse of compacted conversation state and a deliberate low-effort summary setting. Preserve history and tool-call pairing.

### 4. Large instruction overhead even for small requests

**Live measured; performance penalty not benchmarked.**

A short greeting with a 14-character supplied system instruction became a 26,506-character system prompt with no tools. Task mode became 40,594 system characters plus 88 tool definitions. These measurements came from the dev-seeded full-access station; other capability profiles differ. They are character counts, not measured model tokens.

`sidecar/index.js:16862` adds the interactive manual, and the final prompt assembly adds runtime, capability, skill and other context. This increases uncached input processing and amplifies finding 1.

**Repair direction:** measure each prompt section, retain mandatory policy and capability truth, and make optional material demand-driven. Compare cold and cached requests before claiming a speedup.

### 5. Unused fallback authentication is on the primary request's critical path

**Code-confirmed path; stalled OAuth case not live reproduced.**

`sidecar/index.js:16178` constructs configured fallback providers before `runAgentLoop`. Codex and device-OAuth fallbacks await token refresh at lines 16194 and 16198, even when the primary provider may succeed. Refresh is bounded by the connect timeout, normally 30 seconds. Only configured, eligible fallbacks with expiring credentials incur this risk.

**Repair direction:** initialize/refresh fallback authentication when the fallback is actually selected, or prewarm separately without gating the primary call.

## What looked healthy

- Normal foreground chat does not wait for an animation before posting (`frontend/app/harness.js:738`).
- In the recorded normal runs, submission to provider request took 339 ms cold and 27–48 ms warm; provider text reached the HTTP client in 1–2 ms. This measures backend transport, not browser paint or installed WebView performance.
- Explicit effort is resolved and passed into the adapters. Current StarNet defaults include low for Codex and medium for OpenRouter. No general forced-high bug was found. Unsupported model/effort combinations can still be normalized by adapters.
- Compatible read-only tool batches can execute concurrently. Pure chat does not wait for a same-agent workspace write lease; mutation paths may legitimately wait for other work.
- Auxiliary reflection/skill work is started in the background. The fixture observed background calls; they were excluded from foreground retry and prompt measurements. They can still share provider rate limits with user work.
- Run records retain model, effort, total duration and loop recovery attempts, but do not provide a full first-token/preflight/provider/retry/compaction latency breakdown.

## Evidence and verification limits

Live app: launched `node dev/seed.js --keep` in the isolated worktree, through the repository's hermetic-profile fixture, and drove the real `/api/run` route against a local controlled provider. No real inference spend. Owned server processes were checked for cleanup. Source request assembly, streaming, retries and overflow recovery were exercised; model quality, real-provider speed and installed customer UI were not.

Evidence under this worktree:

- `.dogfood/latency-probe.cjs` and `.dogfood/latency-audit/live-results.json`: seven foreground cases, all terminated `done`.
- `.dogfood/cache-probe.cjs` and `.dogfood/latency-audit/cache-results.json`: repeated same-conversation prompt comparison.
- Focused suites: Codex 66, OpenRouter 71, OpenAI-compatible 91, model reasoning presets 3,245, compaction summarizer 341 assertions, all PASS.
- Full `npm run test:fast` stopped at step 83/779 in `test/local-voice.test.js:32`: actual available=true, expected=false. Dependencies were supplied through `NODE_PATH`; the test's manual package-directory search does not inspect `NODE_PATH`, while production `require.resolve` does. This is an audit-environment mismatch, not evidence of a response-latency failure. The full gate is NOT green. Log: `.dogfood/latency-audit/test-fast.log`. No test or product code was changed to bypass it.
- No HTTP-suite-wide or installed-app acceptance claim. The relevant caching, retry and compaction files are unchanged from the local v0.11.2 tag; the customer's installed build remains unknown.

Recommended first implementation slice: repair the cache boundary and add trustworthy latency-stage instrumentation. Then compare identical prompts on the customer's provider/model/effort, in fresh versus long conversations, separating time to first text from time to task completion.
