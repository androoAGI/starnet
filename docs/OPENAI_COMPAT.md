# OpenAI-compatible `/v1` API (external-harness ingress)

StarNet exposes an OpenAI-compatible HTTP surface so external local clients (an OpenAI SDK,
another agent harness, a CLI) can start **real StarNet agent runs** over HTTP. Implementation:
`sidecar/openai-compat.js` (all logic, testable) + thin route wiring in `sidecar/index.js`.
Ported from the reference harness's `gateway/platforms/api_server.py`.

## Enabling it

`/v1` is **disabled by default** and refuses to enable without a strong bearer key — it
dispatches terminal-capable agent work, so a guessable key is remote code execution.

- Set `STARNET_API_KEY` (or `STARNET_V1_KEY`) to a secret of **≥16 characters**
  (e.g. `openssl rand -hex 32`) and restart. With no key, or a key <16 chars, every `/v1/*`
  request returns **403** (`code: api_disabled`) and one honest boot line is logged.
- Auth is its **own seam**, separate from the page-injected `/api` launch token: external
  clients never see that token. Bearer compared timing-safe (`apiauth.constTimeEq`).
- The sidecar-wide loopback **Host pin** (`apiauth.isAllowedHost`) is applied to `/v1` too.
- `STARNET_V1_MAX_CONCURRENT` (default 10) caps concurrent runs across all `/v1` run modes;
  over the cap → **429** (`code: rate_limit_exceeded`). `0` disables the cap.
- `STARNET_V1_MODEL` / `STARNET_DEFAULT_MODEL` sets the run model when a client selects the
  generic advertised model `starnet-agent`.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | liveness, **no auth** |
| GET | `/v1/models` | advertises `starnet-agent` + each roster agent (by name) |
| GET | `/v1/capabilities` | machine-readable surface description |
| POST | `/v1/chat/completions` | sync JSON, or SSE `chat.completion.chunk` deltas + `[DONE]` when `stream:true`; client disconnect interrupts the run |
| POST | `/v1/runs` | 202 `{run_id, status:"started"}` + async run |
| GET | `/v1/runs/{id}` | poll status |
| GET | `/v1/runs/{id}/events` | SSE of typed lifecycle events (`run.started`, `tool.started`, `tool.completed`, `message.delta`, `run.completed`/`run.failed`/`run.cancelled`) |
| POST | `/v1/runs/{id}/stop` | interrupt an in-flight run |

Unlike StarNet's media endpoints' 200-always contract, `/v1` returns **real HTTP status
codes** (401/403/429/400/404/502) because OpenAI-client compatibility is the contract.

## How runs execute (design invariants)

- Every run rides the **same `runOnce` autonomous seam** the channels hub uses:
  `surface:'autonomous'` (a headless HTTP caller has no browser to answer a
  `permission.prompt`, so an ungranted mutation default-denies and the run continues —
  never stalls) and `broadcast:true` (so an external-harness run **lights the station floor**
  — the user sees that an outside harness talked to their station).
- Transcripts land in the **channel transcript store** (like channel-inbound runs), so
  they're visible in the app.
- Cost/billing reconciliation flows untouched through `runOnce`. The OpenAI `usage` object is
  **summed from the run's real `agent.cost` token counters** — never synthesized.
- The request `model` field may select a roster agent by name/id (→ that agent's `agentId`);
  otherwise the default agent runs. Stateless calls get an ephemeral per-request agent so
  concurrent external callers never collide on one agent's workspace mutex; an
  `X-StarNet-Session-Id` header (honored only under auth) threads a stable session agent.

## Deliberately deferred (NOT in this slice)

These are intentional follow-ups, not oversights:

1. **`/v1/responses` (Responses API)** — the stateful `previous_response_id` surface + its
   SQLite response store. Chat Completions + `/v1/runs` cover the primary use cases.
2. **`model_routes` multi-backend routing** — mapping incoming `model` aliases to distinct
   upstream provider/model/base_url configs on one server. StarNet already routes per-agent
   provider via the roster; multi-tenant upstream routing is out of scope here.
3. **CORS opt-in** — no browser-origin allow-list. `/v1` is for non-browser local clients;
   browser access would need an explicit, audited CORS allow-list.
4. **Interactive approvals** (`approval.request` / `POST /v1/runs/{id}/approval`) — StarNet's
   autonomous surface **default-denies** ungranted mutations (there is no browser to answer),
   so there is no interactive approval round-trip to expose. Only lifecycle events provable
   from backend state are emitted (truthful telemetry).
5. **At-rest key persistence** — the bearer key is read from env (`STARNET_API_KEY`),
   matching how provider keys are injected at spawn. A persisted server-config setting
   (following `sidecar/channels/secrets.js`) is a possible future addition.

## Result truth, JSON contracts and safe retries (2026-09-10)

A terminal response includes a `starnet` object with `status`, the native `reason`, and
`completed`, `partial`, `failed`, and `error`. Only a confirmed done event sets completed
true. Partial provider failures retain their text and usage with finish_reason error.
Limits use length; cancellation and missing terminal events never report successful
completion. Run-status responses also retain partial output and usage. Clients should
consume the status extension when distinguishing awaiting_input, refused or limited.

For chat completions, send `Idempotency-Key` (1–256 printable characters) to reserve work
before dispatch. Matching requests under the same bearer principal and explicit session
share progress and replay the exact saved response, including after sidecar restart.
Request content and resolved model configuration are bound to the key; conflicts return
409. A reservation interrupted before its durable result also returns 409 instead of
silently repeating side effects. A disconnected waiter does not abort shared keyed work.
Pre-dispatch concurrency rejection stays retryable. Terminal records are eligible for
cleanup after 24 hours on subsequent admissions; active/orphan records are not evicted.
This protection currently applies to `/v1/chat/completions`, not `/v1/runs` creation.

`response_format` supports text, json_object, and json_schema with a schema. Structured
responses are host-validated as whole JSON and get at most one output-only repair with
no tool execution. Usage includes both calls. Failed validation remains an explicit failed
completion. Structured streaming currently returns 400 before dispatch; use stream:false.
Result contracts support bounded draft-07-style constraints including minimum, minItems,
oneOf, and local JSON Pointer references. Recursive/remote references and complex regex
patterns are rejected explicitly. Schemas are bounded to 12,000 characters and structured
results to 1 MiB for validation. No validator-unavailable fallback accepts unvalidated JSON.
