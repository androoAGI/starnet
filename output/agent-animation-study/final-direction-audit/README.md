# Final movement audit

Compared standing and walking directions across the 37 selected skins (page-0 through page-4). Alien south and forward-diagonal cycles had an exaggerated lateral stride / weak diagonal torso consistency. Replaced those 24 frames from the existing Alien rotation references using built-in ImageGen; source sheets, prompts, source hashes, selected hashes and mechanical packing are recorded here. Existing dimensions, transparent padding, 19 px height and floor anchors are retained.

Walking no longer inherits standing-facing hysteresis. With resolved movement available, it uses the nearest directional sector even before faceA initialization; stationary turning keeps its easing. The regression checks 106560 stale-facing/heading cases plus 555 movement cases. Cardinal-only Pikachu retains its approved release set and closest available cardinal direction.

The five contact pages document the pre-correction comparison. The live station is checked separately before merging. Catalog and provenance validation cover all selected assets, including the three replacement sheets.
