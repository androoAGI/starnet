# Claude CLI provider (`claude-cli`)

StarNet can use the **Claude Code CLI already installed on this computer** (`claude`) as an agent's brain,
with whatever Claude account or API key that CLI is signed in with. No key is stored in StarNet.
Implementation: `sidecar/providers/claude-cli.js` (adapter), a `claude-cli` profile in
`sidecar/providers/registry.js`, one adapter case in `sidecar/providers/factory.js`; the Connect-a-brain tile and
Settings row treat it like Ollama (keyless, local).

## Requirements

- Claude Code installed and signed in: run `claude` once in a terminal and log in (or use an API key).
- The sidecar finds `claude` on `PATH`, then `%USERPROFILE%\.local\bin\claude.exe` on Windows. An npm
  `claude.cmd` shim is run as `node <…>/@anthropic-ai/claude-code/cli.js`. Override with `STARNET_CLAUDE_BIN`.

## How a turn runs

Every `stream()` call is **one** `claude -p` child process:

```text
claude -p --output-format stream-json --verbose --include-partial-messages
       --tools "" --strict-mcp-config --mcp-config {"mcpServers":{}}
       --disable-slash-commands --setting-sources "" --no-session-persistence
       --model <sonnet|opus|haiku> [--effort <level>] --system-prompt-file <tmp file>
```

- The leading system messages go to a temporary system-prompt file (deleted after the turn); the transcript goes
  on stdin. `text_delta` stream events become `text` events.
- **Every CLI tool is off** (built-ins, MCP connectors, skills, settings, session file). The CLI never acts on
  the machine by itself.
- StarNet's own tools are described in the system prompt. The model asks for one with
  `<tool_call>{"name": …, "arguments": {…}}</tool_call>`; the adapter turns each block into
  `tool_start` / `tool_args` / `tool_done`, so `loop.js` runs it through the normal capability gate and consent
  broker. Results return on the next turn as `<tool_result>` blocks.
- Exactly one `done` is emitted, only after the child exited with a `result` line. A CLI error result, or an
  exit without a result, is thrown as an error (with the CLI's message / stderr tail), never delivered as an
  empty answer.
- Images in user messages are replaced by an explicit "image omitted" note: the CLI's text input cannot carry them.

## Stop, timeouts, budget

- **Stop** aborts the run signal; the adapter kills the child's process tree (`taskkill /T /F` on Windows,
  `SIGTERM` elsewhere) and ends the turn as cancelled.
- The shared provider **idle watchdog** (`SKYNET_PROVIDER_IDLE_MS`, default 300 s) kills a child that stays
  silent and reports a `timeout`.
- Per-run budgets and caps apply unchanged: each turn reports its cost (below) to the loop.

## Cost

The CLI's `init` line says how it is authenticated and its `result` line carries real usage:

| CLI sign-in | Booked per turn |
| --- | --- |
| Claude subscription (`apiKeySource: "none"`) | `$0` — nothing is billed per call; real token counts are kept |
| API key | the CLI's own `total_cost_usd` |

The profile is therefore **not** `unmetered`: an API-key sign-in is real spend and stays inside the budgets.

## Models and readiness

`listModels()` runs `claude auth status` (a local check, no model call). Signed in → the CLI's aliases
`sonnet`, `opus`, `haiku` (always the newest model of each family the account can use). Not installed or not
signed in → no models and an error naming the fix, so the tile and Settings row read "not detected / not
signed in" instead of claiming a working brain.
