# Complete agent skin design collection

Owner request: reimagine five existing agent sprites for the newer station, with cleaner proportions and somewhat more realistic materials. These are review candidates, not approved production replacements.

Open `/skin-review-0914.html` on the seeded preview. The page compares the existing default android, astronaut, robot, CRT-head and alien against four newly generated standing directions. It fits alpha bounds to equal visual height and preserves aspect ratio. The small row shows a 48px-tall silhouette with smooth downscaling; it is not an in-world placement or animation claim.

Study 02 adds Ultron, Skeleton, Plague Doctor, Secret Agent and Void Wizard after the owner invited further exploration. The page opens on the new five and retains batch controls for the original five or all ten. Study 02 identifiers and prompts are in `generation-batch2.json`.

Study 03 adds Xenomorph, Robocop, Master Chief, Grim Reaper and Crewmate. The review opens on this latest batch, with access to each earlier batch and all fifteen. Generation identifiers and prompts are in `generation-batch3.json`.

The final design pass adds all 23 remaining selectable skins, including the four colored Cadets. The complete collection covers every set in `DATA.SKINS` (37) plus the special `ultron` overseer: 38 candidates and 152 new directional PNGs. The page opens on Remaining 23, provides all earlier batches and All 38, and searches the full collection by name. `generation-remaining.json` records the final group, while `remaining-briefs.json` records its prompts. Files named `*-revision.json` identify the selected corrections that supersede initial generation records (android, Grim Reaper, Pepe and Capybara).

Coverage verification checks all registry sets and every original/proposed four-direction PNG: 304 files, zero missing. This is a complete design review collection; it does not claim production animation or installed-game verification.

Generated with PixelLab standard, detailed shading, selective outlines, low top-down view. Generation identifiers and prompts are retained in `generation.json`. Source PNGs are retained as returned by PixelLab (136px padded canvases despite the requested 96px size).

No sprite manifest or playable character was changed. Approval should precede eight-direction production art, walk/work/sit animations and live feet-anchor / station-scale verification.
