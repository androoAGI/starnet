# Table projection candidates

The selected built-in image generation sheet supplies seven views of four tables. Preserve the wood, glass and laminate materials. `depth-rejected.png` is a later unselected attempt whose vertical proportions overshot the targets. The selected east glass table is supplied separately by `catalog-glass-fix`.

Run `node dev/industrial-textures/build-catalog-tables.cjs`, then `node dev/industrial-textures/build-projection-correction.cjs`. Extraction preserves retained source RGBA, including enclosed translucent glass. Bounds retain the native footprints and uniform image fitting. No image stretching or repainting.

Each table has newly traced usable tabletop support points. In the running catalog room fixture, all twelve near/far mug placements across eight table views resolved to authored surfaces and were visually inspected on station flooring. The fixture uses the actual room bake and prop renderer but does not establish saved-world interaction or owner approval. Wider south and narrower east views still need owner review together at gameplay zoom.
