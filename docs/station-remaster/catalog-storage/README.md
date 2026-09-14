# Storage catalog projection candidates

Eight south-view PNGs and integration records. The exact native bounds are retained. Import `integration.json` records using `image`, `sourceWidth`, `sourceHeight`, `footprint`, `bounds`, and `contact`; resolve images from `frontend/assets/industrial/catalog-storage/`. Sources and prompts are preserved alongside this document. No runtime or main manifest changed.

| ID | Native footprint | Native bounds (x,y,w,h) | Actual uniform fit W×H | Source aspect error |
|---|---|---|---|---|
| bookshelf | 2×1 | (-1,-9,26,22) | 26.00×21.82 | 0.84% |
| shelf | 4×1 | (0,-14,53,26) | 53.00×25.25 | 2.98% |
| industrial_drawerbank | 3×1 | (0,-3,36,15) | 36.00×14.17 | 5.89% |
| arc_indexwall | 4×1 | (-1,-13,50,23) | 50.00×21.99 | 4.58% |
| industrial_locker | 2×1 | (0,-12,24,24) | 23.36×24.00 | -2.67% |
| rack | 2×1 | (0,-14,29,26) | 29.00×25.95 | 0.20% |
| war_intelcab | 1×2 | (0,-7,17,31) | 17.00×30.72 | 0.90% |
| safe | 1×2 | (-1,-8,18,32) | 17.99×32.00 | -0.03% |

The largest residual ratio difference is the drawer bank at5.89%; its actual height is14.17 inside the15px native standing envelope. No dimension was enlarged to hide mismatch. The other ratios differ by less than4.6%. Contact is the last nontrivial alpha180 body row divided by exported height, removing floor-height sensitivity to faint edge pixels.

Run `node dev/industrial-textures/build-catalog-storage.cjs` from the repository root to reproduce eight PNGs, pixel-preservation receipt and native-fit preview. The script reads only committed sources and verifies their SHA256 first; its sharp dependency uses the authorized workspace module location.

The intelligence screen is blank/inactive. Any prior source-specific motion, contents, LED or screen regions must be remeasured by the integration owner; baked small accent lights are decorative. No backend state or live acceptance is asserted. These are ready for the actual saved-station comparison against accepted camera anchors.
