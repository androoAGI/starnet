# Kepler Relay composition study

Launch from this worktree with `node dev/launch-kepler-showcase.mjs`, then open
<http://127.0.0.1:18795/?propSet=projection&skinSet=study&showcase=kepler>.
The launcher refuses an occupied port. It creates its own seeded workspace on first
launch and reuses that save on later launches; it never replaces the 18794 demo.

Three furnished rooms and one connecting gallery use the projection prop set,
industrial station materials, and study crew skin. There are 48 placed props and
17 conveyor tiles. Command has the tactical table, desks, equipment and greenery;
fabrication has storage, tool surfaces and an intake/bay/outbox line; the lounge
has a wood bar, aquarium, arcades, billiards, upholstered seating and book storage.
The local review overlay provides whole-station and individual-room camera views.

## Verification

- Inspected the whole station and all three room views in the running seeded app
  on September 14, 2026. Reloaded and checked the final overview framing.
- `node --test test/kepler-showcase.test.js`: passed. It checks placement contracts,
  room-to-room walking paths, and the real routing compiler's intake/bay/outbox chain.
- Syntax checks passed for the preset, launcher, overlay, world renderer and test.
- `npm run test:fast` was started and interrupted before completion; no full-suite
  pass is claimed. Its partial output is in the local `test-fast.log`.
- The conveyor is connected but idle. The intake's NO FEED notice is real; no job
  execution or production readiness is claimed by this composition review.
- Existing generated props remain candidates for owner art approval. Arranging
  them here does not establish full-catalog projection or animation approval.

Preset source: `dev/kepler-showcase.cjs`. The first-launch save and test logs live
under the ignored `dev/.scratch-workspace/kepler-showcase/` directory.
