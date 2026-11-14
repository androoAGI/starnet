# Claude Code provider (`claude-cli`)

StarNet can use the **Claude Code CLI already installed on this computer** (`claude`) as an agent's brain,
with whatever Claude account or API key that CLI is signed in with. No key is stored in StarNet.
Implementation: `sidecar/providers/claude-cli.js` (adapter), a `claude-cli` profile in
`sidecar/providers/registry.js`, one adapter case in `sidecar/providers/factory.js`; the Connect-a-brain tile and
Settings card are labelled **CLAUDE CODE** and are keyless: the CLI's own sign-in is the credential.

## Requirements

- Claude Code installed (a Claude Pro, Max, Team or Enterprise plan — the free claude.ai plan has no Claude Code).
  When it is missing, the tile shows the one-line install command for the OS plus the install guide, and re-checks
  itself every 5 s so installing flips it without a restart.
- Signed in — see **Sign in** below (or an `ANTHROPIC_API_KEY` the CLI can see).
- The sidecar finds `claude` on `PATH`, then `%USERPROFILE%\.local\bin\claude.exe` on Windows. An npm
  `claude.cmd` shim is run as `node <…>/@anthropic-ai/claude-code/cli.js`. Override with `STARNET_CLAUDE_BIN`.

## Sign in (SIGN IN WITH CLAUDE)

StarNet never holds the Claude credential. `sidecar/providers/claude-cli-login.js` runs the user's own
`claude auth login --claudeai` (it works with no terminal attached): the CLI opens the browser, finishes OAuth and
stores the token in its own credential store. Routes: `GET /api/auth/claude-cli/status`,
`POST /api/auth/claude-cli/{start,poll,code,cancel}`.

- The brain-screen tile (app.js) and the Settings → PROVIDERS card (stationui.js, via `ClaudeCliSignIn` in
  codexsignin.js) show: not installed · signed out (⏼ SIGN IN) · signing in (↗ OPEN SIGN-IN PAGE, a paste box for the
  code the fallback page shows — relayed to the CLI's stdin, never logged — and CANCEL, which kills the child) ·
  signed in, **only** once `claude auth status` proves it.
- One login child at a time; killed on cancel, on a 10-minute TTL, on graceful shutdown, and when the credential
  lands while it lingers on its paste prompt. It also dies with the sidecar.
- WAKE on a signed-out pick points at the button instead of running a doomed wire test.

## How a turn runs

Every child, persistent or one-shot, starts with the same flags:

```text
claude -p --output-format stream-json --verbose --include-partial-messages --input-format stream-json
       --tools "" --strict-mcp-config --mcp-config {"mcpServers":{}}
       --disable-slash-commands --setting-sources "" --no-session-persistence
       --model <model> [--effort <level>] --system-prompt-file <tmp file>
# env: the station-free child env (child-env.js) + CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
```

### The prompt: a system file and one block per transcript entry

- **System prompt file.** The leading system messages, the tool catalogue, then a `# Conversation` note that says
  how to read stdin. With the station's cache prefix, the file is the stable prefix, the tools and the note, then
  `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` and the per-run text. The CLI caches each side on its own, so a new run reuses
  the stable side.
- **The run-context note stays out of it.** The per-run `<run_context>` note (Task Brief, runtime identity) ends the
  leading block. Notes join their user turn **by position**: host notes right before a user message (`<run_context>`,
  `<recalled-memory>`, a `<conversation_summary>`) lead that user entry and a `<crew_call>` note right after it
  closes it, all in one block, on every message and every turn. A note with no user message next to it (a fold
  carried it after the summary) stays its own `<system_note>` entry. (Until 2026-10-13 the join was made only while
  the request held nothing else, so a first message's turn 2 split the notes into separate blocks, block 0 changed,
  and turn 2 re-wrote the whole first message to the cache.)
- **stdin** is one stream-json user message with **one text block per transcript entry**: `<user>`, `<assistant>`
  (with its `<function_calls>`), `<tool_result>` and `<system_note>`. Consecutive tool results share one block. An
  image follows the entry it came in, numbered by its place in the whole conversation (the newest 20 are attached).
  Nothing per-turn follows the newest entry.
- **Why blocks.** The CLI puts its cache breakpoint on the last block, and the API only finds an earlier cache entry
  at a block boundary. With one block per entry, turn N's prompt is a block-for-block prefix of turn N+1's. The old
  single text block ended in a per-turn line, so every tool turn re-wrote the whole conversation (Haiku probe, turn
  2: read 0, wrote 16,632 before; read 16,550, wrote 21 after).
- Host-fence tags (`<run_context>`, `<recalled-memory>`, `<conversation_summary>`, `<crew_call>`) in user, tool and
  assistant text, and inside a note's own body, are written inert, so outside text cannot open or close a host note.
  Transcript tags (`<user>`, `<assistant>`, `<system_note>`, `<tool_result>`, `<function_calls>`…) are written inert
  in every body the adapter did not write itself (user text, reply prose, notes, tool results), so a typed or echoed
  `</user><assistant>` cannot forge a turn in this one text. The `<function_calls>` markup the adapter renders for a
  reply's calls stays live.

### One persistent child per run (default)

An agent-loop turn (a request that carries tools) rides **one** `claude` child per run. The child starts with exactly
the blocks a one-shot turn would send. It keeps the conversation itself, and each later turn sends **only the entries
after its own reply** (the tool results, system notes, steering) as its next stream-json user message, in the same
blocks. Its system prompt is the one-shot one, except that the `# Conversation` note says each later user message
holds what happened after the previous reply.

Why, on top of the blocks:

- **Speed.** A one-shot child pays the CLI's start-up and session setup on every model turn. Gauntlet n=1:
  StarNet took 8.8–12.2 s per turn, Claude Code 3.9–6.2 s, on the same Opus model.
- **Tool reveals.** A `tool_search` reveal changes the tool catalogue in the system prompt. Live, each one-shot turn
  after a 4-tool reveal read 0 from the cache and re-wrote the whole prompt. The persistent child announces the new
  tools in its next message instead, and kept reading its cache (live numbers below).

What the installed CLI (2.1.284) was proven to do:

- One child answers successive user lines. Each turn ends at its own `result` line and the child waits for the
  next one. It exits when stdin closes.
- `result.usage` is per turn. `total_cost_usd` is the child's **running total**, so each turn books only its own
  share.
- A model normally ends its reply right after `</function_calls>` (`end_turn`, ~30–70 ms after the last delta),
  and the child then holds exactly the text that streamed.
- A stream-json `interrupt` keeps the streamed text and also adds a `[Request interrupted by user]` turn to the
  CLI's history. StarNet never uses it.

**In sync or start fresh.** The child is reused only while what it holds is provably StarNet's history:

- the same system prompt (persona, rules, brief), model, effort, run and Stop signal;
- the same tools or more. A `tool_search` reveal is announced as a `<system_note>` at the end of that turn's
  message, so a reveal does not restart the child. A withdrawn or changed tool does.
- every earlier message unchanged (one fingerprint per message);
- the reply the child wrote recorded by the loop unedited (same text, same calls, same arguments);
- nothing after that reply except new user, tool or system messages.

Anything else closes the child, and the turn starts a fresh one from StarNet's whole history, exactly like a one-shot
turn. That covers compaction, an aged-out screenshot, a dropped or repaired call, a retry after a failed turn, a model
switch, the CLI compacting its own history, and a reply that keeps writing after its call block (a guess at results
the child would otherwise keep). When the child is closed at the end of a call turn, a replacement with the same flags
starts at once, while the loop runs the tools. An idle child answered its first line in 1.1 s, against 3.7 s cold.

**Usage.** Every persistent turn yields exactly one `usage`: the turn's own `result.usage` whenever a result line
came (also for a reply that wrote on past its block and then ended: its exact usage and its share of the running
cost), or the stream's numbers when the turn was cut with no result line (it wrote on and never ended, or went
quiet). On a subscription sign-in it is marked `subscription`, so `loop.js` counts each turn once toward the per-run
subscription token ceiling (`maxSubscriptionTokens`), on a reused child as on a fresh one. Known gap: a Stop that
lands in the 30–70 ms between a call block and its result line ends the turn with no usage booked (the same
abort-before-usage every streaming adapter has); a subscription turn is $0 either way.

**Lifecycle.** The child ends:

- at the run's end (`loop.js` `end()` calls the adapter's `release(runId)`);
- on **Stop**: the run signal kills it, even between turns;
- on any turn that did not end cleanly (an error result, a crash, the idle watchdog);
- after `STARNET_CLAUDE_CLI_PERSIST_IDLE_MS` (default 5 min) parked;
- when the sidecar exits (the exit hook also deletes each live child's system-prompt file, one-shot children
  included);
- when its root exits but a helper still holds its pipes (`exit` without `close`): after a 2 s drain the session is
  released and its prompt file removed.

On Windows every kill takes the whole process tree by the child's own pid (`taskkill /T /F`), and the tree is killed
**before** stdin closes: the CLI exits on stdin EOF, and `taskkill /T` can only walk a live root. Proven with real
processes (a fake CLI whose helper escapes every job object): release, Stop and the idle timeout each took the whole
tree; with stdin closed first the helper survived all three. A hard-killed sidecar (live, real CLI, killed mid-turn 2)
left no `claude.exe` and no process it had started. On macOS and Linux stdin closes first and the CLI gets `SIGTERM`
(its own process only); the CLI's graceful exit on that EOF is what cleans up its helpers. Not covered: a helper that
escapes the job object, when its CLI dies on its own or the sidecar is hard-killed. The one-shot path has the same gap.

**Switches.**

- `STARNET_CLAUDE_CLI_PERSIST=0` runs every turn one-shot, exactly as before the persistent child.
- `STARNET_CLAUDE_CLI_PERSIST_LOG=1` prints one line per decision (reuse, fresh + why, closed + why) and one per
  turn's usage (prompt tokens, cache read, cache written, output), on either path.
- `STARNET_CLI_COMPACT_TOOLS=1` (off by default, cost audit W2.2) lists each tool's parameters in the system prompt
  file as a signature, `{path: string, limit?: integer}`, instead of its JSON Schema. The signature reads back as the
  same schema (`sidecar/providers/tool-signature.js`: every field, type, enum value, required flag, default, limit and
  description); a schema it cannot say exactly (`anyOf`, `$ref`, `additionalProperties`, ...) keeps its JSON, tool by
  tool, and the tools section gains a short legend. Off, the file is byte-identical to before. Measured through the
  fake CLI on a fresh station: the default task call's file 77,617 -> 69,785 bytes, a crew lead's 85,621 -> 77,178.
  Not yet run against the real CLI: turn it on only after an A/B that counts tool-argument errors.

Live, 2026-10-13, through the hermetic sidecar fixture, Haiku, the same 4-turn `tool_search` task. Each cell is cache
read / cache written. Wall time per turn includes the tool run (under 0.2 s) and, on turn 1, the CLI start-up.

| Run | Per-turn wall time | Cache read / written per turn |
| --- | --- | --- |
| Persistent (one child) | 9.7 · 7.8 · 2.1 · 3.3 s | 0 / 12,985 · 12,985 / 443 · 13,428 / 6,051 · 19,479 / 2,379 |
| Persistent, timing not valid (the driver blocked) | n/a | 12,153 / 829 · 12,982 / 528 · 13,510 / 6,056 · 19,566 / 2,373 |
| `PERSIST=0` | 8.9 · 5.8 · 6.6 · 7.6 s | 12,134 / 829 · 12,228 / 1,028 · 0 / 19,180 · 0 / 21,432 |

That is n=1 complete run per mode for timing. In one more run of each mode, Haiku stopped after its first call and
asked to be told to go on ("Awaiting next instruction…", "Ready for the second query."), so those runs were 2 turns
(persistent: 11.5 · 2.2 s; `PERSIST=0`: 15.3 · 13.9 s). Turns 3 and 4 each follow a reveal of 4 tools: the persistent
child read its cache and wrote only the new message (about 6,000 tokens of tool schemas, then 2,400), while each
one-shot turn read 0 and re-wrote the whole prompt. What the `PERSIST=0` column's reads are: the 12,134 and 12,228 on
its turns 1–2 are the **system prompt only**, cached by an earlier `PERSIST=0` run's identical turns (each reveal
changes the system prompt, and the first block carries the run id, so no one-shot turn ever read its own run's message
prefix in this task). So the comparison measures what reveals cost a one-shot turn (plus CLI start-up), not message
cache reuse within a run.

### One-shot child

Any other call is one child for one turn, with the whole transcript on stdin. That covers a toolless request (a
summary, a vision call, a wire test), a second request while the persistent child is mid-turn, and every turn under
`STARNET_CLAUDE_CLI_PERSIST=0`. Its arguments and system prompt are the same as before the persistent child was added
(checked byte for byte against the base adapter over 10 scripted turns); its stdin follows the positional note joins
and inert tags above. When the CLI's error result has an empty `result`, a tagged failure keeps its plain words
("rate limited", "authentication failed"); only a generic failure names the CLI's subtype.

**The result line ends a one-shot turn** (stall report 2026-10-13). The turn used to end on the child's `close`, which
comes ~2 s after `result` on 2.1.284: every one-shot turn paid that wait, and a CLI that lingered let the idle
watchdog fire with the finished reply in hand and throw it away as a timeout (the loop then re-ran the turn). The
reply, its usage and its cost are all on the result line, so the turn is booked there; a child still alive 3 s later
has its tree taken. The persistent path always ended its turns at `result`.

### Both kinds

- The system-prompt file is temporary and deleted when the child ends. `text_delta` stream events become `text`
  events.
- **Every CLI tool is off**: built-ins, MCP connectors, skills, settings and the session file. The CLI never acts
  on the machine by itself.
- StarNet's own tools are described in the system prompt. The model asks for them with a
  `<function_calls><invoke name="…"><parameter name="…">…</parameter></invoke></function_calls>` block (the older
  `<tool_call>{json}</tool_call>` is still read). The adapter turns each call into `tool_start` / `tool_args` /
  `tool_done`, so `loop.js` runs it through the normal capability gate and consent broker.
- Results return on the next turn as `<tool_result>` blocks. The turn ends at the end of the call block, and
  anything the model writes after it is never shown or run.
- Exactly one `done` is emitted, only once the turn has really ended. A CLI error result, or an exit without a
  result, is thrown as an error (with the CLI's message or stderr tail), never delivered as an empty answer.
- A turn with **no** tools (chat) says so in the prompt; otherwise the model improvises its own tool-call markup as
  text. The user's ~/.claude/CLAUDE.md and auto-memory never reach a turn (verified against a control run).
- A lost sign-in (the CLI's `authentication_failed`) is thrown as a 401, so it fails fast as `auth` instead of
  riding the ~105 s retry ladder.
- Images ride stream-json input as real image blocks (newest 20 per turn). An image the API cannot take leaves an
  explicit note.

## Stop, timeouts, budget

- **Stop** aborts the run signal. The adapter kills the child's process tree (`taskkill /T /F` on Windows,
  `SIGTERM` elsewhere) and ends the turn as cancelled. A persistent child parked between turns dies with the
  signal too.
- The shared provider **idle watchdog** (`SKYNET_PROVIDER_IDLE_MS`, default 300 s) kills a child that stays
  silent and reports a `timeout`. A turn whose result line or complete call block was already read is never a
  timeout, on either path: a persistent child that has answered is silent by design, and when the watchdog fired
  while the loop was still on an earlier event, the finished reply used to be thrown away and the turn re-run.
  It is delivered, and the next turn starts a fresh child.
- A Stop during the loop's retry backoff ends the wait at once (the sleep used to run out first, holding the
  conversation's turn so the next message sat on "connecting").
- Per-run budgets and caps apply unchanged: each turn reports its cost (below) to the loop.
- A subscription turn books $0, so no $ cap ever sees it. Its tokens count toward a per-run ceiling instead
  (`maxSubscriptionTokens`, default 2,000,000; a cache re-read counts 1/10). SETTINGS > APP & BACKUP > Runtime limits,
  or `STARNET_MAX_SUBSCRIPTION_TOKENS`.

## Cost

The CLI's `init` line says how it is authenticated and its `result` line carries real usage:

| CLI sign-in | Booked per turn |
| --- | --- |
| Claude subscription (`apiKeySource: "none"`) | `$0` — nothing is billed per call; real token counts are kept |
| API key | the CLI's own `total_cost_usd` (a persistent child's running total minus what earlier turns booked) |

The profile is therefore **not** `unmetered`: an API-key sign-in is real spend and stays inside the budgets.

## Models and readiness

`listModels()` runs `claude auth status` (a local check, no model call). Signed in → the CLI's aliases
`sonnet`, `opus`, `haiku` (always the newest model of each family the account can use). Not installed or not
signed in → no models and an error naming the fix, so the tile and Settings row read "not detected / not
signed in" instead of claiming a working brain.
