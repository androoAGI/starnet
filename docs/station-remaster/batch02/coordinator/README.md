# Boards and archive: eight complete art exports

Final PNGs are in `frontend/assets/industrial/batch02/coordinator/`. Each original source is retained here with its exact built-in image-generation prompt. Workstation and bridge images were supplied for camera/detail only, explicitly excluding universal metal armor. The wooden index cabinet, ceramic-enamel whiteboard, oak/cork/paper chart board, sage-painted calendar, felt/cork missionboard, cherry/glass/velvet case, petrol-enamel microfiche reader, and orange-painted wooden inbox use distinct purposeful materials.

`frontend/assets/industrial/batch02/coordinator/export-checks.json` records alpha counts, source/output hashes, zero RGB changes, and exact source crop. Export uses the user-authorized existing connected light-neutral background rule. Sources remain unmodified. New image files are not runtime entries or accepted live props by themselves.

## Runtime integration notes

Use each native footprint and proposed visual envelope from `dev/industrial-textures/prop-structure-manifest.json`, fitting uniformly. The output source dimensions are the recorded crop width/height, not the original canvas. Subtract crop left/top from all original-source pixel coordinates below.

- Missionboard is deliberately EMPTY. It carries no fabricated quest cards or statuses. Approximate clean source panel regions: left x215–532/y305–560, middle x616–945/y305–560, right x1032–1350/y305–560 (original 1546×1017). Only real pinned quests should populate these slots. Verify placement after uniform fit.
- Trophycase is deliberately EMPTY. Approximate clean shelf regions in original 1168×1347 source: x280–895/y360–465, x280–895/y600–700, x280–895/y850–960. Actual earned objects need new runtime artwork placed on visible shelf planes and glass/edge occlusion. Never claim invented achievements from the static case.
- Microfiche screen is blank gray glass: approximate original source x390–1005/y315–625 (original 1402×1122). New authored display motion/content should occupy this region if needed; no old procedural-screen compositing. Generated physical tuning labels are cosmetic instrument labels.
- Inbox trays are EMPTY, allowing actual message elements later. Original 1536×1024 clean felt: upper x250–1120/y145–300, middle x250–1120/y435–510, lower x250–1120/y650–715. Existing counts/events remain authoritative.
- Whiteboard has a blank writing surface and physical markers. Calendar is a blank planning grid without dates or scheduled events. Chartwall paper contains decorative geometric studies, not claimed work results. Indexwall drawer labels are empty.

Alpha/export checks and visual source/review checks are complete. Runtime animation, true-content projection, floor-contact placement and live acceptance are owned by the original texture task. Full test:fast is an integration gate and has not been claimed by this art-only lane.
