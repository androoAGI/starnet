# Agent OS

**Agent OS** is a rebranded fork of [StarNet](https://github.com/androoAGI/starnet) (MIT, © 2026 Andrew Sims)
with a station-wide **second brain** added on top of StarNet's per-agent memory.

StarNet is unchanged upstream. This fork keeps every bit of its memory architecture and adds a cross-agent layer:

- `sidecar/secondbrain.js` — a pure graph over every agent's notebook (agents, beliefs, projects, workstreams,
  similarity links, detected neighbourhoods).
- `sidecar/secondbrain-vault.js` — writes that graph out as an **Obsidian vault**: one Markdown note per belief
  with full provenance, **`.base` files** (Obsidian Bases) for the database views, `graph.json` for graphify /
  graph tooling, and `.obsidian/graph.json` colour groups so the vault's graph view looks like the in-app brain.
- `frontend/app/secondbrain.js` — the **live BRAIN window**: a force-directed canvas fed by the station's existing
  SSE bridge, so every `memory.write` / `memory.used` / `memory.proposed` / `memory.forget` is visible as it
  happens, plus a recall probe that lights up exactly which beliefs a piece of text would surface.

## Where it lives in the app

- **CREW ▸ BRAIN** — the station-wide second brain, live.
- **AGENT DOSSIER ▸ BRAIN** — the same graph scoped to one agent, so you can see what the crew knows that *it*
  could use.
- **AGENT DOSSIER ▸ MEMORY** — unchanged; this is still where you pin, edit, forget and rate a belief.

## Running it

```bash
npm start                 # sidecar + API on 127.0.0.1
npm run serve             # UI only
```

## Rebrand scope (important)

Display text says **Agent OS**. These were deliberately **not** renamed, because they are load-bearing:

- `starnet` — the managed subscription provider id the sidecar resolves.
- `STARNET_*` — environment variables (`STARNET_WORKSPACES`, `STARNET_API_TOKEN`, …). Renaming them would silently
  break existing configs and Windows registry/env inherited by the desktop shell.
- `bin/starnet.js`, asset filenames (`starnet-logo.png`) and internal class names (`StarNetNative`).

Rename the env prefix too if you want a full fork — it is a separate, deliberate migration.

## License and attribution

MIT. The original `LICENSE` is kept verbatim, and upstream attribution in `NOTICE.md` is untouched.
This fork's additions are released under the same MIT terms.
