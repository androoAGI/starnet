# Floor projection correction

Ten built-in generated raster props replace wrong floor silhouettes. The airlock is an octagonal floor iris; the archive light is a recessed round fixture; the deck perimeter is a thin painted outline with a transparent center. Rugs align with horizontal and vertical deck axes. Cable channel and vent are flush floor details. The original outline had incorrectly depicted standing railings.

`sheet-source.png` supplies eight views. `cables-source.png` supplies the final cable run and channel. Prompts and native reference montage are retained. The montage resizes existing native structure guides only for reference; it is not used as replacement artwork.

Build with `node dev/industrial-textures/build-catalog-floor.cjs`. Exports preserve every retained source RGBA pixel and native bounds. Uniform fitting keeps the 24-pixel cable run narrow (5.29 pixels tall versus its 9-pixel envelope); it is a loose floor cable, with transparent gaps, not a solid 9-pixel panel. The channel fits36×5.66. Other shapes stay within about13% of their native dimension targets; perimeter fits144×91.57 versus144×94.

All ten were inspected in the running StationBake/PropSprites room fixture at fit-room and enlarged game scale. This verifies visual floor alignment in that fixture, not owner approval or all saved-world operational states. The existing airlock state contract is unchanged.
