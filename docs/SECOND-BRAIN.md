# The Second Brain

Agent OS gives every agent a durable notebook. Recall ranks that notebook **when its owner works** — which
means a lesson learned by one crew member is invisible to the rest, and nothing shows the Commander the shape of
what the station actually knows.

The second brain is the missing layer: **one graph over every notebook**, live in the app, and a generated
Obsidian vault you can open, browse, back up, or hand to another AI.

---

## 1. How memory already worked (and where it lives on disk)

| Store | File | What it is |
| --- | --- | --- |
| `notebook:<agent>` | `<WORKSPACES>/<agent>.notebook.json` | The durable long-term memory — an array of §5.2 records |
| `todo:<agent>` | `<agent>.todo.json` | Active task plan, survives restarts |
| `declined:<agent>` | `<agent>.declined.json` | Permanent reject-list (a discarded proposal is never re-proposed) |
| `minted:<agent>` | `<agent>.minted.json` | Idempotency ledger |
| `pending:<agent>` | `<agent>.pending.json` | High-stakes proposals awaiting a Keep/Edit/Discard verdict |
| `embed:<agent>` | `<agent>.embed.json` | Derived embedding vectors for the hybrid recall lane |

Those files sit **outside** the agent's fs jail, so an agent's own tools cannot read or corrupt them.

A record looks like:

```json
{
  "id": "note_3",
  "kind": "note | fact | profile | skill",
  "title": "Registry throttling",
  "body": "The npm registry keeps rate-limiting uploads during release windows; back off 60s and retry.",
  "scope": "global | project | stream",
  "projectRoot": "C:/work/repo",
  "streamId": "qa-sweep",
  "confirmation": "user-confirmed | inferred",
  "origin": "reflect | feedback | notebook.write | channel:telegram | schedule",
  "trust": 0.15,
  "useCount": 3,
  "pinned": false,
  "lastUsedAt": 1699999999999
}
```

**Recall** is `context.rank()`: BM25 over the record text, plus an optional embedding cosine (records above the
semantic floor are admitted even with zero word overlap), plus recency decay, plus time-decayed trust, plus a
same-workstream boost and a same-project boost. Pinned records are a hard top. The winner is rendered inside a
`<recalled-memory>` fence and injected as a system note before the newest user turn.

**Taste** (`feedbackmemory.js`) is separate: verdicts and corrections become `profile` records with
`origin: "feedback"`, injected as an always-on block, not retrieved by keyword.

So the second brain reads all of that and adds nothing to the write path — it is a **projection**, rebuilt on
demand, so it can never drift from what the agents believe.

---

## 2. What the second brain adds

`sidecar/secondbrain.js` (pure, no IO):

- **Nodes** — `agent`, `memory`, `project`, `stream`, `concept` (a detected neighbourhood).
- **Edges** — `wrote` (agent → belief), `similar` (belief ↔ belief), `references` (explicit `[[wikilink]]`),
  `same_project`, `same_stream`, `in_concept`.
- **Similarity** — embedding cosine when vectors exist, otherwise an **IDF-weighted cosine** over token sets.
  Plain Jaccard was the wrong metric: two agents independently learning the same registry lesson shared 3 of 23
  words (0.13) and never linked, which is precisely the edge worth surfacing. Weighting by rarity means a shared
  "registry"/"throttled" counts and a shared "during" does not.
- **Neighbourhoods** — deterministic label propagation over the similarity graph.
- **Stats** — honest sums over the stores: recalls, avg trust, pinned, never-recalled, cross-agent links.

`sidecar/secondbrain-vault.js` (IO only, takes a built graph) writes the Obsidian vault.

`frontend/app/secondbrain.js` draws the whole thing live.

---

## 3. In the app

- **CREW ▸ BRAIN** — the station-wide window (one graph, every agent).
- **AGENT DOSSIER ▸ BRAIN** — the same graph scoped to one agent.
- **AGENT DOSSIER ▸ MEMORY** — unchanged; pin / edit / forget / rate still lives there.

The canvas is fed by the station's existing SSE bridge (`world.js` re-emits every server channel event onto
`U.bus`), so what you see is real telemetry, never a simulation:

| Event | What it draws |
| --- | --- |
| `memory.write` | the agent pulses, a new belief lands and settles into its cluster |
| `memory.used` | a spark travels agent → the belief that was recalled |
| `memory.proposed` | a proposal waits (it is not a belief yet) |
| `memory.forget` | the node leaves on the next rebuild |
| `agent.run.start` / `.end` | the agent's ring lights while it works |

**PROBE** runs a recall query against the whole station without running an agent — type "our uploads keep
getting throttled" and watch which beliefs it would surface, ranked, across every crew member.

---

## 4. The Obsidian vault

**BRAIN ▸ EXPORT TO OBSIDIAN** writes to `~/Documents/Agent OS Brain` (override with `AGENT_OS_BRAIN_VAULT`).

```
Brain.md                     dashboard, embeds the base views
Memories.base                every belief (table + cards + never-recalled)
Agents.base                  the crew, sized by beliefs
Concepts.base                the detected neighbourhoods
Preferences.base             the Commander's taste (origin: feedback)
Stale.base                   beliefs nothing has recalled
Agents/<Agent>.md            one hub note per agent
Memories/<Agent>/<Title>.md  one note per belief, with provenance + related links
Projects/<slug>.md
Streams/<slug>.md
Concepts/<slug>.md
graph.json                   nodes/links, graphify-shaped
.obsidian/graph.json         colour groups per agent
Attach an AI.md              the paste-in prompt below
```

`.base` files are the Obsidian **Bases** core plugin format (1.9+): views, filters and formulas over note
properties. Example — `Memories.base`:

```yaml
filters:
  and:
    - file.inFolder("Memories")
    - 'type == "memory"'
formulas:
  trust_pct: '(trust * 100).round(0)'
views:
  - type: table
    name: By trust
    order: [file.name, agent, kind, scope, confirmation, trust_pct, use_count, file.mtime]
```

Open the folder as a vault (*Manage vaults → Open folder as vault*). The graph view lights up from the
`[[wikilinks]]`, and the colour groups are pre-set so each agent's beliefs read as its own colour.

### Using graphify

`graph.json` uses graphify's shape (`nodes[]`, `links[]`), so it can be consumed directly:

```bash
graphify --obsidian "/c/Users/bryce/Documents/Agent OS Brain"
```

Run it after an export if you want graphify's own concept extraction layered on top of the vault. The vault is
already Obsidian-ready without it — graphify is optional enrichment, not a dependency.

---

## 5. The prompt pack — attaching your other AIs

Any AI that can read files (Claude Code, Codex, Cursor, Gemini CLI, local models with a filesystem tool) can be
pointed at the vault. `Attach an AI.md` is written into the vault for exactly this.

### 5a. The prompt for a *reader* (let an AI use your brain)

```text
You are connected to my Agent OS second brain at C:\Users\bryce\Documents\Agent OS Brain.

Before answering anything about me, my projects, or my preferences:
1. Read Brain.md, then the .base views it embeds (Memories.base, Concepts.base, Preferences.base).
2. Search Memories/ for the 5 most relevant notes using their frontmatter (agent, kind, scope, tags) and body.
3. Treat "confirmation: inferred" as an unconfirmed hypothesis and "user-confirmed" as fact.
4. Weigh trust and use_count: high-trust, recently recalled beliefs outrank cold ones.
5. Cite the note you used by its [[title]] so I can trace the answer.

Do not rewrite notes you did not create. Do not edit Brain.md — it is generated.
```

### 5b. The prompt for a *writer* (let an AI contribute memories back)

Give this to an AI whose work you want folded into the station. It writes new notes in the exact shape the
vault uses, which then round-trips into Agent OS as beliefs.

```text
You are contributing to my Agent OS second brain at <VAULT PATH>.

Rules:
- One belief per note. One idea. State it plainly.
- Only write something DURABLE: a preference, a fact about my setup, a lesson from a failure,
  a project constraint. Never a status update, never a summary of the current conversation.
- Never rewrite or delete a note you did not create.
- Never touch Brain.md or any .base file.

Write the note as Markdown at Memories/<YourName>/<Short Title>.md with exactly this frontmatter:

---
type: memory
agent: "<Your name>"
agent_id: "<your-name>"
kind: note          # note | fact | profile | skill
scope: global       # global | project | stream
confirmation: inferred
origin: "<how you learned it — e.g. session with Bryce>"
authority: reference-only
trust: 0
use_count: 0
generated_by: "Agent OS · Second Brain"
tags: ["agent-os/memory", "agent/<your-name>", "kind/note", "inferred"]
---
# <Short title>

<The belief, in 1–3 sentences.>

## Why this is durable
<One line: what future task this should change.>
```

### 5c. The prompt for an AI that already has its own memory

Use this to *migrate* an existing assistant's memory into the brain. It asks the AI to dump what it knows, then
you paste the result into `Memories/Imported/` or feed it through the app.

```text
Before we continue: list everything you have persisted about me as durable facts, one per line, in this format:

TOPIC | KIND (note|fact|profile|skill) | CONFIDENCE (confirmed|inferred) | the belief in one sentence

Rules for the list:
- Only things that would change how you work on a FUTURE task.
- No conversation summaries, no task status, no restating what I asked today.
- Include the reason you believe it (I told you / you inferred it / it came from a file).
- Aim for 10–40 items. If you have fewer than 5, say so honestly.
```

Then attach the output — either write the notes into `Memories/Imported/` using the writer prompt's shape, or
paste each line into the agent's MEMORY tab in the app to seed it directly.

### 5d. Keeping them in sync

- Agent OS → other AIs: export, and every AI reading the vault sees the same brain.
- Other AIs → Agent OS: their notes land in `Memories/<TheirName>/`, and the next Agent OS export/import cycle
  keeps them in one place. The graph will visibly show their notes joining (or not joining) the station's
  existing neighbourhoods — which is exactly how you spot an AI that is describing a different world than your
  crew works in.

---

## 6. Rebrand note

Display text says **Agent OS**. Deliberately unchanged, because they are load-bearing:

- `starnet` — the managed subscription provider id the sidecar resolves.
- `STARNET_*` — environment variables. (The API header now accepts `x-agent-os-token` **as well as**
  `x-starnet-token` and `x-skynet-token`, so existing clients keep working.)
- `bin/starnet.js`, asset filenames, internal class names.

Renaming the env prefix is a separate migration; do it deliberately, not incidentally.
