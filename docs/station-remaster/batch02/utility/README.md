# Utility batch02: twelve authored props

All twelve requested utility designs have complete individual RGBA exports in `frontend/assets/industrial/batch02/utility/`: industrial_planter, tallplant, monstera, terrarium, fishtank, lavalamp, plasmaglobe, etsy_dyevat, etsy_kiln, research_samplecart, incubator and cryopod.

The user explicitly requested varied materials. These designs use natural foliage, soil, terracotta, glazed ceramic, walnut and oak, glass, water, indigo dye and cotton, refractory brick, painted enamel, medical polymer and padded fabric. Workstation and bridge references guided camera/detail only; no old procedural sprite was traced, copied or composited.

`sources/` contains every intact built-in image_gen result. `prompts/` contains the exact individual prompts. `generation-provenance.json` records the original generated file paths and reference roles. All twelve were separate image_gen calls.

`export.cjs` adapts the coordinator's user-authorized neutral-background exporter. It changes alpha only and preserves original canvas dimensions, RGB values and source files. It removes connected exterior background, inspected enclosed background gaps, and isolated tiny export specks. Enclosed gaps are recorded in `export-specs.json`. Pale pottery, cloth, medical shells, glass highlights and interior contents were visually inspected on the diagnostic dark-matte sheets. Source hashes, output hashes, alpha counts, source sizes and alpha bounds are in `export-checks.json`. All twelve outputs have transparent and opaque pixels, with zero RGB changes. The alpha matte is binary; downstream uniform smooth downsampling supplies the game-scale edge sampling.

`manifest.json` contains the actual supported south facing, footprint, desired world envelope, approximate floor contact, mounting contract and authored motion regions for every prop. Coordinates use 12 world pixels per tile. Floor contacts are author estimates for integration calibration, not live-verified anchor measurements. Lava lamp and plasma globe require an existing table host with the native 8 pixel surface rise. Terrarium and fish tank retain standing leisure approaches; no seat anchors are added. Cryopod's sleeping figure is fixed artwork and must never be asserted as real agent occupancy.

Verification: twelve PNGs decode as RGBA; source hashes are unchanged; alpha has 0 and 255; retained RGB changes are 0. `proof-01.png` through `proof-04.png` show all twelve against a dark matte. `scale-proof.png` shows uniform fitting at 4 display pixels per world pixel using the desired envelopes. Shapes/materials remain recognizable at that scale. These sheets are offline inspection evidence, not proof of simulation behavior. The parent coordinator separately reported that all twelve loaded intact in its browser review gallery.

No runtime renderer, shared manifest, owner workspace, station save or website was edited. These are complete static art candidates. All requested animated-prop motion/state integrations remain explicitly unresolved, and user acceptance/live station placement are not claimed. Full test:fast was not run for this isolated artwork lane; the runtime integration owner retains its required gate.

To reproduce exports from this worktree in PowerShell:

```powershell
$env:NODE_PATH='C:/Users/andro/gen-trees/industrial-textures-0912/node_modules'
node docs/station-remaster/batch02/utility/export.cjs
python docs/station-remaster/batch02/utility/verify-previews.py
```

