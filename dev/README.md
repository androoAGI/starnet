# Dev seed — boot a pre-onboarded StarNet in one command

**Problem this solves:** every fresh sidecar launch (a new `SKYNET_WORKSPACES` dir, or just a new
browser port — each worktree runs on a different port, and `localStorage` is per-origin) drops you at
the title screen → connect screen (paste key, pick model) → the WAKE ceremony. Re-doing that on every
test run is the friction this kills.

## One-time setup

```bash
cp dev/.env.dev.example dev/.env.dev    # then edit dev/.env.dev
```

Fill in `dev/.env.dev` (gitignored):

```
SKYNET_OPENROUTER_KEY=sk-or-...           # held server-side; never injected into the page
SKYNET_DEFAULT_MODEL=anthropic/claude-3.5-sonnet
# SKYNET_PORT=8787                        # optional; handy with multiple worktrees
```

## Every launch after that

```bash
npm run dev:seed
```

Open the printed URL. You land **straight in the live station** — agent `NOVA` awake, model set,
ready to chat. No BEGIN, no key paste, no ceremony, on any port. Full access is on, so no consent
prompts interrupt a test.

- `npm run dev:seed` — fresh seeded workspace each run (clean slate, still onboarded). **Default.**
- `npm run dev:seed:keep` — reuse the previous scratch workspace (keep prior runs' memory/files/world).

## How it works

1. **`dev/seed.js`** loads `dev/.env.dev`, copies the golden fixture into a throwaway
   `dev/.scratch-workspace/` (stamping in your model + a fresh timestamp), then launches the real
   `sidecar/index.js` with `SKYNET_DEV=1`, `SKYNET_FULL_ACCESS=1`, and that workspace.
2. **The seed fixture** (`dev/fixtures/seed-workspace/`) is a committed, already-onboarded agent:
   `agent.save.json` (identity + a filled `purpose`, which is what skips the awakening),
   `agent.roster.json` (server-side identity for cron/headless), `_commander.dossier.json`.
3. **`SKYNET_DEV=1`** makes the sidecar inject `window.__STARNET_DEV__ = {model, prov}` into the page.
   The frontend (`harness.js`) treats that like the desktop "server holds the key" seam: it reports
   `configured()` without a browser key and omits the key from run requests, so the sidecar uses its
   own env key (the credential store). The existing boot path then auto-resumes the server-seeded save.

**The API key never leaves the server.** Only a model + provider hint cross to the page. The
`SKYNET_DEV` flag is never set in a packaged build, so none of this can leak into shipping.

## Editing the seeded agent

Edit the JSON under `dev/fixtures/seed-workspace/` (it's committed, so the whole team gets the same
golden agent). Leave `agent.model` as `""` — the launcher stamps in your `SKYNET_DEFAULT_MODEL`.

## Testing onboarding itself

When you actually want the cold first-run flow, launch the plain way (`npm start` with a fresh
`SKYNET_WORKSPACES` and a clean browser profile) — no `SKYNET_DEV`, no seed.
