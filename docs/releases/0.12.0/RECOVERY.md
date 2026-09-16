# 0.12.0 installer recovery — September 16

Done means the installed candidate renders the industrial texture pack and corrected prop art, all intended release merges are present, source and installed gates pass against the candidate, and the signed installer plus release evidence are staged for publication. Publication remains a separate owner action.

## Reproduced packaging regression

The running installed desktop reports clean commit `fd55ee2b26fcb30ebc9397f43af429d4b25ebb5d` at `http://tauri.localhost`. Its real WebView reports `IndustrialTextures.status().loaded === false`, with exactly one failure: `calibration/crate`. The DOM reports `texturePack=fallback` and `textureRevision=native`. All 184 prop views load, but their enablement depends on the disabled texture pack.

The staging allowlist excluded `assets/industrial/calibration/crate.png` while the production loader unconditionally requests it and treats its absence as a pack failure. This is why the merged graphics disappear in the installer even though source/browser checks pass. Evidence: `.dogfood/release-recovery/installed-before.json` and `installed-before.png` in the release-preparation worktree.

The current source baseline is `1cbd6384d`, which also includes the subsequent ChatGPT-sign-in precedence fix. The graphical coordination, sprite, shell, station-default, and response-audit branch tips are all ancestors of this baseline. The earlier installer does not contain the sign-in fix.

## Acceptance still to earn

- Package every runtime dependency and test the real loader against the staging rule.
- Build from a clean, identified candidate; verify the updater signature.
- Install and observe the remaster in the actual Tauri WebView; exercise restart and measure lag.
- Reconcile customer reports with source proof, installed proof, and unresolved customer recovery kept distinct.
- Complete candidate gates and record the exact readiness result before publication.
