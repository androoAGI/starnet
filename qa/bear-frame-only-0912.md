# Bear frame repair only

User requested merging without the added gestures. This branch starts from trunk
fa85f521f and selects only the bear palette repair commit from the expression lane.
It carries eight repaired north-west walking frames, their website mirrors, and
the palette regression/repair scripts. It does not include gesture art, sprite-lab,
rehearsal code, animation behavior, renderer changes, or manifest changes.

The repair changes exactly 140 turquoise pixels to the existing brown fur shade;
all other pixels and alpha values are preserved. The earlier expression-lane live
review stepped through all eight corrected frames. This narrower build was also
started with `node dev/seed.js --keep` on port 9199 and verified ONLINE in the in-app
browser. Selected Teddy Bear in NOVA's appearance panel, confirmed the checked state,
closed the dossier, and observed the bear in the standard station canvas.
No provider task was launched.

The candidate's frontend/website application code and sprite manifests compare
identically to trunk. `node test/sprite-assets.test.js` passed 17,725 assertions.
