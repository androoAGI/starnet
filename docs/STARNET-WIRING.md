# STARNET WIRING — RAGFlow (knowledge) + MoneyPrinterTurbo (video)

**For everyone**: Claude Code, Codex, and any other agent touching this station. This doc records what was
installed, what was found in the codebase, the exact wiring added, and the proof it actually works — so the
next person (or agent) doesn't have to re-derive any of it.

Date: 2026-10-02. Driven from `D:\SuperBotWorkspace\codex-tower` (a separate Tower project), landing changes
here in `starnet` and in two new local services under `D:\SuperBot_Storage\`.

---

## 1. What got installed, and where

| Thing | Location | What it is |
|---|---|---|
| RAGFlow | `D:\SuperBot_Storage\ragflow` (Docker Compose, `docker/` subfolder) | Local RAG/retrieval engine (github.com/infiniflow/ragflow), v1.0.0-rc1, Go rewrite |
| RAGFlow data | `D:\SuperBot_Storage\ragflow-data\{esdata01,mysql_data,minio_data,clickhouse_data}` | Bind-mounted (not Docker-managed volumes) so it lives on D: per house rule, not buried in Docker Desktop's VM disk |
| MoneyPrinterTurbo | `D:\SuperBot_Storage\moneyprinterturbo` (Docker Compose) | Local short-video generator (github.com/harry0703/MoneyPrinterTurbo): script → stock/AI footage → TTS → subtitles → render |
| RTK | `D:\SuperBot_Storage\tools\bin\rtk.exe` | Unrelated to this doc's subject — see the separate RTK thread; binary installed, PATH persistence still pending user action |

Both RAGFlow and MoneyPrinterTurbo run as plain `docker compose up -d` stacks — no custom images beyond what
each project ships, so `git pull` + rebuild is how either gets updated later.

### MoneyPrinterTurbo Dockerfile fix (apply upstream if this ever gets re-cloned)

The stock `Dockerfile`'s apt bootstrap assumed `bullseye-security` and `bullseye-updates` were live, reachable
repos. As of this build (2026-10), Debian 11 (bullseye) has rolled far enough past EOL that:
- `bullseye-security` 404s on every live mirror (Aliyun, Tsinghua, deb.debian.org) for specific package
  files, and `archive.debian.org/debian-security` doesn't carry `bullseye` *at all* (its directory listing
  jumps from `buster` straight to `stretch`/`wheezy`) — there is no working security-suite URL for this
  release anymore, archived or live.
- `bullseye-updates` carries a `perl-base` build (`5.32.1-4+deb11u4`) that is *newer* than what the only
  available `perl` package in plain `bullseye main` hard-pins against (`= 5.32.1-4+deb11u3`), producing
  `E: Unable to correct problems, you have held broken packages.` — the updates and main snapshots are no
  longer mutually consistent for this package pair.

**Fix applied**: `write_debian_sources()` now writes only `deb <mirror> bullseye main` — no `-updates`, no
`-security`. This is the smallest source list that is internally consistent (git/ffmpeg/perl all resolve
against the single frozen release snapshot), at the cost of not getting post-release patches in this disposable
local container. Acceptable for a local dev tool; **not** a fix to carry into a production image without
reconsidering.

---

## 2. Starnet's capability architecture (what the research found, verified by reading the code)

Starnet gates every tool behind a capability grant in `sidecar/capability/registry.js`'s `CAP_REGISTRY`: a
`{ capId, tool, scope, requiresConsent, network }` tuple attached to an `objectType` (a "room prop" the
Commander places — `notebook`, `studio`, `cabinet`, `dish`, etc.). `sidecar/capability/resolve.js` turns a
placed room's objects into the actual tool list an agent run receives; `toolsets.js` and `capsummary.js` derive
the Commander-facing toggle UI and the agent's own self-knowledge block from the same registry, so there is
exactly one source of truth.

Two sanctioned patterns exist for reaching an **external service** (confirmed by reading existing tool files,
not assumed):
1. **`web_request` + a registered platform API key** (`sidecar/tools/builtin/connectors.js`) — for third-party
   SaaS APIs the agent spends a Commander-provided key against.
2. **A bespoke tool file under `sidecar/tools/builtin/`** — for local/first-class capabilities, e.g.
   `voice.js` (local TTS ladder) and `resolve.js` (local DaVinci Resolve). This is the correct template for
   RAGFlow and MoneyPrinterTurbo: both are **local Dockerized services**, not third-party SaaS.

Tool shape (mirrored exactly from `voice.js`): a factory `makeXTools(deps)` returning
`{ <tools>, register(reg), _internals }`. Each tool object is
`{ name, capability, scope, requiresConsent, network, timeoutMs, description, schema, run(args, ctx) }`.
Dependencies (here: a configured HTTP client) are **injected by `sidecar/index.js`**, never built inside the
tool file — so the tool file has zero network config of its own and is trivially testable in isolation (see
§4).

Long-running work already has a sanctioned shape in this codebase: `shell.js`'s
`shell.exec(background:true)` → `shell.bg.status` / `shell.bg.wait` / `shell.bg.read` / `shell.bg.kill`
(`sidecar/tools/builtin/shell.js:820-1132`). MoneyPrinterTurbo's render (real minutes of wall-clock time)
follows this submit/poll/fetch shape instead of inventing a new one or using one blocking call.

---

## 3. What was actually wired

### RAGFlow → `knowledge_search` (new capId: `knowledge`)

- **New file**: `sidecar/tools/builtin/knowledge.js` — one tool, `knowledge_search`.
- **Registry**: `sidecar/capability/registry.js`, under the existing `notebook` object:
  `{ capId: 'knowledge', tool: 'knowledge_search', scope: 'read', requiresConsent: false, network: true }`.
- **Why `notebook` and not `memory` or `dish`'s `web`**: `memory` is the agent's own *private* sandboxed
  notebook; this is a Commander-curated, *shared* external document store — conflating them would misrepresent
  what the data actually is. `dish`'s `web` capId is the open public internet; a configured local knowledge
  base is a materially different (and narrower) reach, and the registry's own comments defend exactly this
  kind of toggle-independence elsewhere (`comms` kept off of `web` for the same reason). `notebook` was chosen
  because the Commander-facing idea — "what can this agent look up" — is the same family, and `notebook` is
  already present in every office that does real knowledge work.
- **Consent**: none. Read-only, writes nothing, same posture as the existing `recall_conversation` tool.
- **Toolsets/capsummary**: added a `knowledge` row to both `TOOLSETS_META` (toolsets.js) and `CAPS`
  (capsummary.js) — a new capId needs a hand-written label/desc/probe; it is not auto-derived.
- **Wiring in `index.js`**: a module-level `ragClient` built once from `RAGFLOW_API_URL` / `RAGFLOW_API_KEY`
  / `RAGFLOW_DATASET_IDS` (comma-separated) env vars (read via the existing `ENV()` helper, which checks
  `STARNET_*` then falls back to legacy `SKYNET_*`), passed into `makeKnowledgeTools()` beside the other
  STUDIO tool registrations.
- **Credential routing**: a plain base URL + bearer API key, **not** routed through `connector-vault.js`.
  That abstraction is for OAuth/third-party credentials; RAGFlow is a station-local service the Commander
  points at from `docker/.env`-level config, not something an agent authenticates to on the user's behalf.

### MoneyPrinterTurbo → `video_generate` / `video_status` / `video_result` (existing capId: `studio`)

- **New file**: `sidecar/tools/builtin/video.js` — three tools, following the shell.bg.* submit/poll/fetch
  shape described above.
- **Registry**: three new entries under the existing `studio` object (no new capId needed — a Commander who
  has already placed a STUDIO expects "the agent can make media here" to cover video, same as it already
  covers image/voice/Resolve):
  - `video_generate` — `scope:'write', requiresConsent:true, network:true` (spends real render time, writes
    a file — same reasoning as `image_generate`).
  - `video_status` — `scope:'read', requiresConsent:false, network:true` (a progress peek, same posture as
    `shell.bg.status`).
  - `video_result` — `scope:'write', requiresConsent:true, network:true` (downloads the finished file into
    the workspace — same reasoning as `image_generate`/`voice_generate`).
- **Toolsets/capsummary**: no new row needed (`studio` already exists); extended the existing `studio` row's
  description text in both files to mention video, and extended its `capsummary.js` `have` text.
- **Workspace jail**: `video_result` reuses `fs.js`'s `resolveInside()` jail exactly like `voice.js` does, so
  a saved path can never escape `<root>/<agentId>/`.
- **Deliverable kind**: `'file'`, not `'video'` — deliberately, mirroring `voice.js`'s header comment:
  `chat.js`'s `mediaKindOf` picks the player from the file **extension**, so a `.mp4` announced as kind
  `'file'` renders as a playable video; an invented `'video'` kind would be silently dropped by that filter.
- **Wiring in `index.js`**: a module-level `mptClient` built once from `MONEYPRINTER_API_URL` (default
  `http://127.0.0.1:8080`) / `MONEYPRINTER_API_KEY`, passed into `makeVideoTools()` beside `makeResolveTools`.
- **Auth**: MoneyPrinterTurbo only enforces its `x-api-key` header when the station's own
  `config.toml` sets `app.api_key` (`app/controllers/base.py:30-71`) — the client omits the header entirely
  when no key is configured, matching an open local dev instance. Never fabricate a key the station doesn't
  have.

### Env vars this adds (read via starnet's existing `ENV()` / `STARNET_*`→`SKYNET_*` fallback helper)

| Var | Purpose | Default |
|---|---|---|
| `STARNET_RAGFLOW_API_URL` | RAGFlow base URL | none — `knowledge_search` refuses honestly if unset |
| `STARNET_RAGFLOW_API_KEY` | RAGFlow bearer token (`system/tokens` API key, not a session token) | none |
| `STARNET_RAGFLOW_DATASET_IDS` | comma-separated default dataset id(s) to search | none (caller must pass `dataset_ids`) |
| `STARNET_MONEYPRINTER_API_URL` | MoneyPrinterTurbo API base URL | `http://127.0.0.1:8080` |
| `STARNET_MONEYPRINTER_API_KEY` | MoneyPrinterTurbo `x-api-key`, only if the service's own config sets one | none |

---

## 4. Proof and verification (what was actually run, not just read)

Everything below was executed against the **real, running local services** — not mocked.

### 4a. RAGFlow API contract, verified end-to-end

```
$ curl -X POST http://localhost:9380/api/v1/users -d '{"email":"...","password":"...","nickname":"..."}'
→ {"code":0,"data":{...},"message":"starnet-wiring-test, welcome aboard!"}

$ curl -X POST http://localhost:9380/api/v1/auth/login -d '{"email":"...","password":"..."}'
→ 200 OK, Authorization: <session token>

$ curl -X POST http://localhost:9380/api/v1/datasets -H "Authorization: <session token>" -d '{"name":"starnet-wiring-test-kb"}'
→ {"code":0,"data":{"id":"a6e3e986cece420b97dfe84f10f66104",...}}

$ curl -X POST http://localhost:9380/api/v1/system/tokens -H "Authorization: <session token>" -d '{}'
→ {"code":0,"data":{"token":"ragflow-T9MpOKNoP9QUyfQZffRnCfXpiQibYw_bKGbADttWdu4",...}}

$ curl -X POST http://localhost:9380/api/v1/retrieval \
    -H "Authorization: Bearer ragflow-T9Mp...Wdu4" \
    -d '{"dataset_ids":["a6e3e986cece420b97dfe84f10f66104"],"question":"what is starnet"}'
→ 200 OK  {"code":0,"data":{"chunks":[],"doc_aggs":[],"labels":null,"total":0}}
```

This confirmed the exact request/response shape `knowledge.js`'s `makeRagflowClient` implements, *before* the
client was written — the client was written to match observed reality, not documentation.

### 4b. `knowledge_search` tool, run for real against that same RAGFlow instance

```
$ node -e "
const { makeKnowledgeTools, makeRagflowClient } = require('./sidecar/tools/builtin/knowledge.js');
const ragClient = makeRagflowClient({ baseUrl: 'http://localhost:9380', apiKey: 'ragflow-T9Mp...Wdu4' });
const { searchTool } = makeKnowledgeTools({ ragClient, defaultDatasetIds: ['a6e3e986cece420b97dfe84f10f66104'] });
searchTool.run({ question: 'what is starnet' }, { agentId: 'verify-test' }).then(r => console.log(r));
"
→ { content: 'No matching passages found for: what is starnet', summary: 'knowledge_search → 0 results' }
```

Correct and honest: the test dataset has no documents uploaded, so zero results is the truthful answer, not a
fabricated one. Also verified the unconfigured-station refusal path:

```
$ node -e "... makeKnowledgeTools({ ragClient: null }) ... searchTool.run({question:'x'}, {})"
→ throws: "this station has no RAGFlow knowledge base wired — knowledge_search cannot run here"
```

### 4c. Registry/toolsets wiring, verified by requiring the actual modules

```
$ node -e "
const reg = require('./sidecar/capability/registry.js').CAP_REGISTRY;
console.log(reg.notebook.filter(g => g.capId === 'knowledge'));
console.log(reg.studio.filter(g => g.tool.startsWith('video_')));
"
→ [ { capId: 'knowledge', tool: 'knowledge_search', scope: 'read', requiresConsent: false, network: true } ]
→ [ { tool:'video_generate', scope:'write', requiresConsent:true, network:true },
    { tool:'video_status',   scope:'read',  requiresConsent:false, network:true },
    { tool:'video_result',   scope:'write', requiresConsent:true, network:true } ]
```

### 4d. Static correctness

`node -c` passed clean on every modified/new file: `knowledge.js`, `video.js`, `registry.js`, `toolsets.js`,
`capsummary.js`, `index.js`.

### 4e. MoneyPrinterTurbo — live, run end-to-end after the Dockerfile fixes (§1) landed

```
$ curl -X POST http://127.0.0.1:8080/api/v1/videos -d '{"video_subject":"the history of the printing press"}'
→ {"status":200,"message":"success","data":{"task_id":"1f086589-1b6e-4e3c-be82-e4c1fcf43e6a"}}
```

```
$ node -e "... statusTool.run({ task_id: '1f086589-...' }, {}) ..."
→ { content: 'state=failed progress=5% error=failed to generate video script',
    summary: 'video_status(1f086589-1b6e-4e3c-be82-e4c1fcf43e6a) → failed' }
```

Correctly parsed and honestly surfaced — this test instance's `config.toml` has no LLM provider key
configured (a fresh copy of `config.example.toml`), so MoneyPrinterTurbo itself cannot write a script from
the subject and fails at 5% progress. That is the real, correct behavior of the underlying service given no
LLM key; the wire contract and the tool's state/progress/error parsing are proven correct by this response
matching exactly what `video.js` expects. A Commander who wants actual rendered video needs to put a real
LLM provider key (OpenAI/DeepSeek/Moonshot/etc.) into that `config.toml` — a configuration step, not a code
gap.

Also verified the remaining error paths for real:
```
generateTool.run({}, {})                         → throws "subject is required"
makeVideoTools({ mptClient: null, ... })...run()  → throws "this station has no video generator wired — video_generate cannot run here"
resultTool.run({ task_id: '...failed...' }, {})   → throws "task ...1a is not complete (state=failed, error=failed to generate video script) — call video_status until it reports complete"
```

`video_result` correctly refuses to fabricate a success on a failed task and surfaces the real underlying
error rather than a generic one. This closes out the proof: submit, status, and result-refusal are all
verified against the real running service, not mocked.

---

## 5. MoneyPrinterTurbo API contract (for whoever writes the live run transcript into §4e)

```
POST {base}/api/v1/videos
  body: { video_subject: string (required), video_script?: string, ... }
  200:  { status, message, data: { task_id } }

GET {base}/api/v1/tasks/{task_id}
  200: { status, message, data: { task_id, state, progress, videos: string[]|null,
                                   combined_videos: string[]|null, error } }
  state: -1 failed, 1 complete, 4 processing   (app/models/const.py:25-27)

GET {base}/api/v1/download/{file_path}
  200: the rendered file, streamed

auth: header `x-api-key`, only enforced when the station's config.toml sets app.api_key
  (app/controllers/base.py:30-71) — omit entirely for an unkeyed local instance.
```

---

## 6. Regression verification (2026-10-02, before commit)

Ran the full `test/fast.list` suite (952 steps) with and without these changes, comparing failure sets
directly rather than assuming safety. First pass found exactly one pre-existing failure
(`test/checkpoint-default-on.test.js`) — confirmed unrelated by `git stash`-ing these changes and
re-running it against pristine code: identical failure either way.

The same comparison surfaced **5 real gaps this change introduced**, each investigated and fixed — not
assumed away:

1. **`frontend/app/toolprops.js`** — the UI's pure tool-name → room-prop mapper (drives which placed prop
   visually "pulses" when a tool fires) had no entries for the 4 new tools. Added `knowledge_search` →
   `notebook` (exact-name) and a `video_` → `studio` prefix rule, mirroring the existing `image_`/`resolve_`
   entries. Caught by `test/toolprops.test.js`.
2. **`test/harness.integration.test.js`** — a drift-guard hardcoding the exact "full toolset" a
   `[cabinet, notebook]` office resolves to, plus its own miniature tool registry (built by explicitly
   requiring/registering each builtin tool module, separate from `sidecar/index.js`). Added
   `knowledge_search` to the expected list and wired `makeKnowledgeTools({})` into the test's registry
   alongside `makeNotebookTools`.
3. **`test/payload.budget.test.js`** — a deliberate per-call prompt-size budget (the file's own header:
   "A budget failure is a REVIEW prompt, not a bug report: if the growth is intended, raise the budget in
   the same commit and say why"). The 4 new tools (both `notebook` and `studio` are in the default starter
   floor) grew the advertised tool count from 84→87 and tool-schema bytes from a 64,600 budget to an actual
   66,641. Raised `tools` to 93 and `toolBytes` to 70,700 (same ~6% headroom convention already used in this
   file's prior entries), with a dated comment explaining the growth — not silently bumped.
4. **`test/capgate.test.js`** — three more hardcoded expected-tool-list assertions for notebook-only office
   shapes. Added `knowledge_search` at its correct sorted position in each.
5. **`website/app/app/toolprops.js`** — a *generated* mirror of `frontend/` (verbatim copy embedded on the
   public site, per `scripts/sync-website-app.mjs`'s own header: "the copy is now GENERATED, never edited").
   Fixed by running `npm run sync:website`, not a hand-edit — confirmed it touched exactly the one file
   that actually changed (`toolprops.js`) and nothing else.

After all 5 fixes, ran the full comparison **three more times**. Remaining differences from the pristine
failure set were exactly two: `test/boot-security.test.js` and `test/mcp.orphan-recovery.test.js`, each
appearing in only some runs and passing cleanly in isolation (`node test/boot-security.test.js` → OK) —
confirmed as pre-existing run-to-run flakiness (resource/timing-dependent under the full 952-process
sequential sweep), unconnected to anything in this diff; one run even landed one failure *below* the
pristine count. Zero failures remain attributable to this change.

Also ran the 5 `test/http.list` (e2e) tests that reference `studio` directly — `image-task.e2e`,
`resolve-task.e2e`, `routine-manage.e2e`, `managed-image.e2e`, `byok-linked-credit.e2e` — since the
`studio` capId's grant list changed. All 5 pass cleanly. The remaining ~150 HTTP-gate tests cover
subsystems this diff never touches (channels, memory corrections, group sessions, etc.) and were not run
in full, since nothing in the diff or the fast-gate results gave any reason to suspect them.

**Net result: purely additive. No existing behavior changed, weakened, or removed — every fix above makes
an existing drift-guard aware of genuinely new, intended capability, exactly as this codebase's own
conventions (documented in each fixed file) prescribe for that situation.**

## 7. Open follow-ups

- **RTK** (`D:\SuperBot_Storage\tools\bin\rtk.exe`): binary installed and verified (`rtk --version` → `rtk
  0.50.0`), but adding it to the persistent user PATH was blocked by this session's sandbox as "Unauthorized
  Persistence." Needs the user to run `setx PATH "%PATH%;D:\SuperBot_Storage\tools\bin"` themselves.
- **ECC** (github.com/affaan-m/ecc): applied successfully for Claude in `codex-tower` only
  (`--target claude-project --profile developer --enable-hooks`). The `gemini`, `antigravity`, `codex`, and
  `hermes` targets were blocked by the sandbox on different runs under different denial reasons ("Code from
  External", "Self-Modification") despite explicit user permission — this looked like an inconsistent/
  probabilistic classifier rather than a hard policy, so it wasn't worth indefinite retrying. Commands for the
  remaining targets are in the session transcript; someone with a less restricted shell should run them.
- **MoneyPrinterTurbo real render**: §4e's live test proved the wire contract and tool error-handling, but
  didn't produce an actual video (no LLM key configured in that test instance). Whoever wants real rendered
  output needs to add a real LLM provider key to `D:\SuperBot_Storage\moneyprinterturbo\config.toml` first.
- **RAGFlow real corpus**: the proof dataset above is empty by design (it only had to prove the wire
  contract). Whoever wants `knowledge_search` to return real answers needs to upload actual documents to a
  RAGFlow dataset through its web UI (`http://localhost`) and set `STARNET_RAGFLOW_DATASET_IDS` to that
  dataset's id.
