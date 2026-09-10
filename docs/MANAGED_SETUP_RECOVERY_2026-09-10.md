# Managed setup recovery for 0.11.2

The 0.11.1 follow-up screenshot showed an obsolete Anthropic-key message and an empty model selection. This lane fixes those reproduced frontend problems. It does not establish the cause of every historical customer error or prove recovery on the customer's account.

## Changes

- Setup messages and their buttons are owned by the setup component. They retire when the provider, focused agent or setup gap changes, including when the gap clears. Retirement does not clear another conversation's choices.
- A linked managed provider with no selected model explicitly requests a model, with a button opening the primary picker. Missing-link recovery still takes precedence over missing-model recovery. No StarNet API key is requested.
- The compact empty selector reads `CHOOSE MODEL` instead of a dash. Settings provider selection refreshes setup state immediately.
- Recovery buttons keep the model picker open through mouse and keyboard activation. Opening from outside the picker no longer immediately triggers its outside-click dismissal.
- Website app mirrors are synchronized. Existing integration fix 59b5f2462 already protects newer model/provider selections from late catalogs; it is inherited here, not duplicated.

## Verification

- Full fast gate: **763/763 steps green**, exit 0. An initial run caught the website chat mirror mismatch; after synchronizing all four changed mirrors, the full gate passed.
- `test/keycta-recovery.test.js`: provider changes, empty model, restored selection, link loss, busy chat, and focused-agent changes pass; registered in the fast gate.
- `test/free-path-ollama.test.js`: 49 assertions pass. Existing model-provider reconciliation test: 27 assertions pass.
- `node --test test/managed-endpoint.e2e.test.js`: **2/2 pass**, including managed routing with stale request endpoints and restart. This uses a local simulated gateway and real sidecar, not a production subscription.
- Live seeded app on port 19316: the real Settings provider card retires the Anthropic text and buttons; the banner and chat recovery buttons open the real model picker; selecting a managed model clears the setup prompt. Separate banner, pointer and keyboard activation receipts have no page errors. Another producer's choices survive setup retirement. A held Ollama catalog response does not overwrite `starnet / anthropic/test-model`.
- Live catalog and credits responses were simulated. The test sets the seeded agent's onboarded flag, uses a disposable profile, and makes no paid inference call. An early test locator depended on `title`, which the app's tooltip handling removes; the maintained probe uses the stable provider attribute instead.
- Syntax and whitespace checks passed. No backend source was changed; the full HTTP gate was not rerun. Final installer, production account recovery, diagnostic-field improvements and subscription billing operations are outside this change.

Evidence: `qa/evidence/managed-setup-0910/` (three live receipts plus test log hashes/tails). Reproduction: `scripts/qa/managed-setup-live.cjs <seeded-url> <banner|pointer|keyboard>`, using `STARNET_PLAYWRIGHT_MODULE` and `STARNET_CHROME` when browser dependencies are not on the default path. Launch `node dev/seed.js --keep` in this isolated worktree with `SKYNET_DEFAULT_MODEL=replay`, `SKYNET_PORT=19316`, and disposable APPDATA/LOCALAPPDATA roots. Never run this probe against a customer station.

Prepared on `agent/managed-setup-0910`, based on integration 4db93cb7d. Not merged, packaged or published by this lane.
