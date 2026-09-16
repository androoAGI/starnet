# Corner continuity and bay nameplate polish

Room corner crowns, standing faces, lower contact edges and rim transitions now render with eighth-pixel geometry for the remaster path. Binary fractional coordinates preserve exact world-origin translation. Dense face patches are batched per strip, avoiding per-sample canvas calls. Classic artwork retains its native sampling.

Bay nameplates now use a neutral metal frame, a restrained cyan accent and smooth text. Compound names can wrap onto two lines; short single words reduce type size to stay intact. Plates remain within the bay width, follow zoom, retain an honest ellipsis for excessive text and use the actual current agent binding/name. Assignment styling makes no claim about agent activity.

Live review: default station at port 18797, research room and adjoining diagonal corners, at room scale and close zoom. Browser error log was empty. No saved layout, approved prop art, lighting or routing-warning truth was modified.

Focused checks: bay-name-legibility, stationbake.materials (185), stationbake.chunk (181) and stationbake.seam (52) pass. Chunk tests verify translated texture coordinates and subpixel corner patches; label tests cover rename, unbound bays, crew name wrapping, adjacent plates, long names and zoom/DPI.

Full gate: npm run test:fast passed all 793 steps, exit 0, runtime commit e8c2a5bac. Log: dev/.scratch-workspace/corners-bays-test-fast.log. SHA-256: 833c9fd13ec72ef6a7cd04f7dd402b44aea15e0e6b168cd70bda8881af947854.

