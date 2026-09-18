---
fingerprint: 2b7a920c
slug: roaming-agents-jam-nose-to-nose-in-narrow-hallwa
title: Roaming agents jam nose to nose in narrow hallways
surface: world
severity: P2
status: fixed
found: 2026-09-18
lane: hallway-awareness-0917
fix: 54105ec6c
origin: owner
report: Owner report 2026-09-17 with hallway screenshot
affected: Desktop new skins; exact installed build unknown
family: hallway-traffic
installer: unverified
recovery: unconfirmed
---

# Roaming agents jam nose to nose in narrow hallways

## Symptom

Owner reports larger new skins pushing against each other in hallways for 20–30 seconds, without making space to pass.

## Repro

Send two roaming bodies toward opposite ends of a narrow corridor, with their routes planned before either arrives at the bottleneck. Observe repeated opposing movement followed by separation pushes. Reproduction is automated in test/hallway-traffic.test.js.

## Evidence

The owner supplied a screenshot of a pair at the north doorway of a room. In the seeded browser reproduction against 3ba5b8492, both bodies remain at y=248/257 until the separation timeout abandons both wander goals. Local trace: .dogfood/hallway/before.json. Navigation and separation are exercised by test/hallway-traffic.test.js.

## Verdict

Source repair 54105ec6c adds advance right-of-way, reachable refuge paths, waiting and resumption of original destinations, occupied-seat detours, and following distance. The old axial separation remains a containment backstop. Installer and owner recovery are unverified.

## Regression

`node dev/hallway-traffic.mjs --before` loads baseline 3ba5b8492 into the seeded browser: opposing walkers abandon both destinations in one-, two-, and four-tile corridors. The identical repaired scenarios complete both destinations with no abandonment and zero illegal foot segments. The normal animation loop also completes the two-tile route with Pikachu and Retro Astronaut skins: 458 observed frames, zero wall violations, both original destinations reached. Committed traces: qa/evidence/hallway-awareness-0917/before.json and after.json. Local screenshots: .dogfood/hallway/yielding.png and completed.png. This is source/browser proof, not installed-app proof.

`test/hallway-traffic.test.js` executes the shipped avoidance, separation and gait against production world geometry: 27 assertions across widths 1/2/3/4, stationary and seated bodies, three-way traffic, work priority, command cancellation and slower walkers. Existing wall-route, containment, sightline and sprite-motion regressions pass. Customer journeys: 36/36 green.


## Sibling coverage

{
  "adapters": [{"target":"hero, roaming crew and workstation crew","state":"covered","test":"test/hallway-traffic.test.js","scenario":"shared traffic-step wiring, working state retained while opposite traffic finishes","gate":"fast"}],
  "entrypoints": [{"target":"opposite routes, stationary bodies, occupied seats and following","state":"covered","test":"test/hallway-traffic.test.js","scenario":"hall widths 1/2/3/4, three walkers, seat anchors and faster follower","gate":"fast"}],
  "displays": [{"target":"browser world and larger skins","state":"covered","test":"test/hallway-traffic.test.js","scenario":"physical feet and wall clearance; visual skins separately verified by dev/hallway-traffic.mjs","gate":"fast"},{"target":"installed desktop","state":"blocked","reason":"No rebuilt installer was requested or tested; source proof does not update the installed application."}],
  "lifecycle": [{"target":"new movement command","state":"covered","test":"test/hallway-traffic.test.js","scenario":"changed target cancels both halves of the previous passing agreement","gate":"fast"},{"target":"restart persistence","state":"not-applicable","reason":"Passing agreements are transient WeakMap state and are never saved; normal navigation rebuilds them after load."}]
}



