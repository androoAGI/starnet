# 0.12.0 installer recovery — September 16

Done means the installed candidate renders the industrial texture pack and corrected prop art, all intended release merges are present, source and installed gates pass against the candidate, and the signed installer plus release evidence are staged for publication. Publication remains a separate owner action.

## Reproduced packaging regression

The running installed desktop reports clean commit `fd55ee2b26fcb30ebc9397f43af429d4b25ebb5d` at `http://tauri.localhost`. Its real WebView reports `IndustrialTextures.status().loaded === false`, with exactly one failure: `calibration/crate`. The DOM reports `texturePack=fallback` and `textureRevision=native`. All 184 prop views load, but their enablement depends on the disabled texture pack.

The staging allowlist excluded `assets/industrial/calibration/crate.png` while the production loader unconditionally requests it and treats its absence as a pack failure. This is why the merged graphics disappear in the installer even though source/browser checks pass. Evidence: `.dogfood/release-recovery/installed-before.json` and `installed-before.png` in the release-preparation worktree.

The current source baseline is `1cbd6384d`, which also includes the subsequent ChatGPT-sign-in precedence fix. The graphical coordination, sprite, shell, station-default, and response-audit branch tips are all ancestors of this baseline. The earlier installer does not contain the sign-in fix.

## Acceptance still to earn

### Second activation gap: agent sprites

The installed intermediate build still rendered legacy agent sets and portraits. The sprite lane was merged, but its complete motion manifest and roster were installed only by the localhost `?skinSet=study` review hook. Git ancestry alone did not detect this. Evidence: `.dogfood/release-recovery/sprites-before.json` from the real Tauri origin.

Production now maps the existing saved skin IDs to all 37 selected sets and ships their complete motion tracks in the canonical sprite manifest. The retained Pikachu stays selected; the retired duplicate `minionchar` remains readable as the approved Station Minion without becoming an extra picker choice. Portraits, first-paint preload, lazy loading, leader loading, and scale resolution follow the production selection. No saved agent records are rewritten. The preview remains an optional review surface.

The production renderer regression verifies selected bytes/order for every track, all four walking directions, measured ground contact, existing skin IDs, and default/leader resolution. Installed acceptance now also requires selected catalog mappings, actual world draw tracks, and loaded portraits with preview mode disabled. Neither previous installer is the complete release candidate.

The combined lane now includes the typing/focus repair through `50791280b`, merged as `97325c2fe`, and the subsequent trunk operational digest. Website deploy staging uses the same corrected runtime-art filter as the installer. `scripts/qa/installed-graphics.mjs` requires exact shell/sidecar/executable identities and enabled graphics before collecting visible frame timing, engine-health latency, panel responsiveness and render errors. Its receipt is measured evidence on this machine, not a cross-hardware performance guarantee.

The first recovery build is `725664380009a5e609b77a0a44f2efaa9b942948`. It is an intermediate graphics verification artifact, not the final combined release. The final installer must be rebuilt after the combined-source gates and source lock.

- Package every runtime dependency and test the real loader against the staging rule.
- Build from a clean, identified candidate; verify the updater signature.
- Install and observe the remaster in the actual Tauri WebView; exercise restart and measure lag.
- Reconcile customer reports with source proof, installed proof, and unresolved customer recovery kept distinct.
- Complete candidate gates and record the exact readiness result before publication.
