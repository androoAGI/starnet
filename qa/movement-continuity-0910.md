# Movement continuity repair — 2026-09-10

Owner reported jitter and indecisive-looking movement after the skin-frame update.

Source repair: 75a814c18. Look-back direction is captured once when its pause starts; hero, idle crew and workstation crew consume intermediate waypoint handoffs in the same frame. Collision guards and intentional pauses remain active.

Live local browser: before, 25 consecutive pause samples alternated west/east. After, the hero held west and advanced from x=113 to x=114.010684 in the first handoff frame. A separate crew browser held west for 30 samples and advanced from x=113 to x=113.4257665 on the first route sample, reaching x=138.4747905 over 42 samples. The initial crew probe incorrectly set the hero unplaced (pausing the simulation); corrected setup left the hero on distant floor and the crew check passed.

Behavior regression test: test/world-movement-continuity.test.js fails seven assertions against 343238e68, passes all 15 on the repair. Path smoothing passes 22 assertions and reports zero wall violations; workstation recovery passes 23 assertions. Customer journeys: 34/34 green.

Local raw receipts live in .worldshots/movement-*.json and movement-crew-live.log. Repro helper: dev/movement-probe.mjs. Preview: http://127.0.0.1:9241/.

Installed build and reporter recovery are unverified.
