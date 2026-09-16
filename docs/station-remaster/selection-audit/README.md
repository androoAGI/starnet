# Remastered prop selection alignment

Runtime change: `8637c9d8d`; test candidate: `8fb0ff787`.

Strong selected, hover and placement borders now follow the rendered prop's opaque bounds. A faint dashed rectangle retains the actual occupied floor tiles. Image dimensions, floor occupancy, collision and seating are unchanged.

Live verification used the seeded app on port 18797 with `propSet=projection&skinSet=study`:

- Opened Refit and selected the desk at 8,5. Its border followed the visible desk at 50% and 98% zoom.
- Placed a tactical table and inspected the placement border, then selected the placed table. `table-selected.png` records its close border and separate faint tile footprint.
- Undid the temporary placement: the UI returned from 160 to 159 objects, then exited Refit.

The regression in `test/remaster-physical-fit.test.js` verifies opaque bounds, glow exclusion, translation, mounting lift, cached measurements and unavailable-art fallback. This is not an exhaustive visual review of every prop orientation.

Full gate output is retained locally at `dev/.scratch-workspace/prop-selection-test-fast.log`.
