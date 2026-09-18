# Hallway right-of-way

Source repair: `54105ec6c`, branch `agent/hallway-awareness-0917`.

Walkers previously followed stale routes into one another. Axial separation undid
their forward motion until jam recovery abandoned their destinations. Larger skins
made the standoff conspicuous; narrower raised-doorway clearance limited sideways
escape. The owner reported repeated pushing for 20–30 seconds.

Walkers now notice approaching bodies, choose a reachable shoulder or retreat into
an opening, let the other body pass, then resume the original waypoint. Standing
bodies make room, seated bodies keep their anchors, and faster followers leave room
behind slower walkers. Movement continues through the existing gait and wall
clearance checks. New commands cancel the old passing agreement.

## Evidence

- `node dev/hallway-traffic.mjs --before`: baseline `3ba5b8492` abandoned both
  destinations at widths 1, 2 and 4. [Before trace](../evidence/hallway-awareness-0917/before.json).
- `node dev/hallway-traffic.mjs`: all six original destinations reached, no
  abandoned goals, zero illegal foot segments. The normal rendered animation loop
  with Pikachu and Retro Astronaut completed both routes over 458 observed frames
  with zero wall violations. [After trace](../evidence/hallway-awareness-0917/after.json).
- Live-tested world source SHA-256:
  `6fe9f101e8650294412f68f66deb925a8127c72a2fc3122000318d6bb022e4c2`.
- `test/hallway-traffic.test.js`: 27 assertions covering corridor widths 1/2/3/4,
  three walkers, stationary and seated bodies, work priority, command cancellation
  and following distance. Registered in the fast gate.
- Existing movement regressions: wall paths 78, containment 23, sightline 52,
  sprite motion 6,354, seat recovery 82 and corner continuity 15 assertions pass.
- Customer journeys: 36/36 green. Final 36 movement/rendering fast steps also pass.

The initial full gate caught two single-body test fixtures missing the new traffic
dependency. Those fixtures were corrected without weakening their seat or corner
assertions. The committed release-surface lock was refreshed for the new world
source bytes; claim verdicts were not changed. Combined npm run test:fast passes 817/817 on the synchronized source (local receipt: .dogfood/hallway/final-fast.log). Merged to feat/harness-backend at cee250d8ee5c7d3ba41f7b9cbf72b8f4ad1905d2. Post-merge npm run test:fast also passes 817/817, exit 0 (local receipt: .dogfood/hallway/post-merge-fast.log). Merged source hash and website mirror are identical to the live-tested source.

This is source and browser verification. No installer was rebuilt, no update was
published, and recovery in the owner's installed station remains unconfirmed.
