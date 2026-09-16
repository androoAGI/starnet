# 0.12.0 desktop bundle size — the blocker found at packaging time

**Correction from installed verification:** the runtime-evidence paragraph below missed a boot-time request. `industrialtextures.js` requires `calibration/crate.png` (2,784,196 bytes). Omitting it disables the entire texture pack and therefore every remastered prop, despite all 184 prop views loading. The installed `fd55ee2b2` candidate reproduced this exactly. The corrected staging set includes `calibration/`; the loader regression now executes the assembled URLs instead of relying on literal-path grep. The installer identity below is historical and must not be published. See [RECOVERY.md](RECOVERY.md).

**Found:** September 16, 2026 while cutting the local signed installer for the candidate `93ed9e63d`.
`cargo` built the shell, then NSIS failed:

```
Internal compiler error #12345: error mmapping file (1917969518, 33554432) is out of range.
failed to bundle project `The system cannot find the file specified. (os error 2)`
```

**Cause:** Tauri embeds every byte under `build.frontendDist` (`../frontend`) into the executable. The
station remaster merged on September 12–16 tracks its art SOURCES under `frontend/assets/industrial/`
(review batches, camera audits, calibration sheets, superseded prop sets) next to the runtime art:

| Measure | v0.11.2 | 0.12.0 candidate before the fix |
| --- | --- | --- |
| tracked bytes under `frontend/` | 19 MB | 1,220 MB |
| `skynet-desktop.exe` | 17.9 MB | 925.7 MB |
| NSIS data block | fits | 1.9 GB → mmap failure |

The release train would have hit the same failure on the Windows leg AFTER the tag push (burning the
version), and the macOS bundles would have shipped ~1 GB apps.

**Runtime evidence:** a CDP capture of the seeded app (boot, Build library in all three sections and a
full search scroll, close zoom) requested 405 assets totalling 208 MB: `assets/industrial/*.png` (32 root
textures, 60 MB), `assets/industrial/projection-correction/` (186 files, 82 MB), `assets/industrial/remaster/`
(39 files, 62 MB), sprites, brand, fonts. No request touched `batch02`, `batch03`, `props-v2`, `props-v3`,
`catalog-*`, `camera-audit`, `calibration`, `scale-calibration`, `parallel-0914`, `capability-*`,
`tactical-table-polish`, `sharpness-restoration` or the other review folders. Code review agrees:
`propremaster.js` loads from `projection-correction/` (default, DENSITY 6) or `approved-sheet/`
(`?propSet=approved`), its manifest reaches `../complete-sheet/`, and `industrialtextures.js` loads the
root textures plus `remaster/`. `batch03` / `props-v3` appear only as calibration `sourceRoot` strings for
review tooling and in tests.

**Fix (`61c86f4cc`):** `scripts/stage-frontend-dist.mjs` mirrors `frontend/` into the gitignored
`src-tauri/frontend-dist/` before every desktop build, dropping only `assets/industrial/<folder>/` trees
outside the runtime set {`projection-correction`, `remaster`, `complete-sheet`, `approved-sheet`}.
`tauri.conf.json` points `frontendDist` at the staged copy; `build.rs` reruns provenance when it changes;
`desktop:build`, `desktop:dev`, `release-train.yml` and `desktop-build.yml` all run the stage right after
the voice deps. The browser/dev sidecar still serves the full `frontend/` tree, so review pages and tests
are untouched. `test/frontend-dist-staging.test.js` locks the rule to the runtime roots, checks every
image the shipped projection manifest names is staged, and pins the build wiring.

**Second finding (same day):** with the staged embed the executable dropped to 268 MB, yet the first
signed installer still weighed 1,568,318,690 bytes (1.5 GB). `bundle.resources` ALSO copied the full
`../frontend` tree as the sidecar's `frontend` resource (the packaged sidecar serves it for browser-mirror
mode), so the calibration art rode along a second way. `fd55ee2b2` points that resource at the staged
copy (`"frontend-dist": "frontend"`, target name unchanged, so `sidecar/index.js`'s
`path.resolve(__dirname, '..', 'frontend')` still resolves) and the staging test now refuses a
`../frontend` resource.

| Measure | after both fixes |
| --- | --- |
| staged frontend | 11,225 files / 266 MB (dropped 670 files / 954 MB) |
| `skynet-desktop.exe` | 268 MB (was 926 MB) |
| `StarNet_0.12.0_x64-setup.exe` | 908,434,576 bytes signed, sha256 6125316eeac173ca3c1971f5b0e438623b24174d0318b9e0a62ae51a06c30820, built from `fd55ee2b2` (first cut: 1,568,318,690 bytes) |

The installer is still larger than 0.11.2 (130 MB): the remaster's runtime art is ~200 MB of PNG that
does not compress. Shrinking that further (pre-rasterizing the projection sources at their DENSITY-6
size, or moving the 954 MB of calibration sources out of `frontend/` entirely) is a follow-up art-pipeline
decision. The website source mirror (`website/app`) retains the full tree for source parity. The
corrected `stage-website-deploy.mjs` now applies the same runtime-art filter to the upload artifact,
including calibration/crate. The website staging test passes with the runtime texture retained and
review batches absent. No website deployment was performed; the handoff's Vercel diagnosis was not
independently established (the repository's staging script targets Cloudflare Pages direct upload).
