# Illustrated prop production handoff

The parallel artwork pass contains **44 repaints and 78 new catalog designs**, exported as **136 PNGs** including separately authored required views. All 122 assigned IDs and every view in their native structure manifest are present. The source audit independently checks each final file against its receipt, original source hash and retained source RGB; every export has transparent and opaque pixels and zero retained RGB changes.

The working direction follows the user's correction that the coffee maker, bench and many other props were too realistic. Broad painted planes, stronger silhouettes, quieter surfaces and selective edge highlights replace photographic rendering. Wood, fabric, ceramic, rubber, paper and greenery remain distinct materials. These are candidates for the new station style, not automatic user acceptance.

Review: `http://127.0.0.1:57615/frontend/prop-style-review.html`. The four calibration examples appear first; original 44 have before/after comparisons, new designs appear individually, and directional assets have links. Detail, 4x world scale, group filters and transparency backgrounds are available.

## Production sections

| Section | New IDs | Final worker/source tip |
| --- | ---: | --- |
| Infrastructure | 5 | feeebfb9c |
| Publication | 5 | 99c6b096794fce823201433ea5923b4bb19f6030 |
| Transport | 6 | 7b308f4bbbe9a2fa622864f71f8684f2f468d8dd |
| Habitat | 8 | 1eb4f7a0f |
| Leisure and media | 12 | da770c8f08d9a5ec3cd2258e0dda06925027c658 |
| Furniture and fitness | 14 | 57b37b52a |
| Storage and treasury | 10 | ba76e48dbab148023a020275bdc6a36acfc34c61 |
| Instruments | 6 | 4f743db5b4560f5f2c8dd27450c5395faa6a2967 |
| Control room | 12 | 8f34fbf97 |

All are collected in the coordinator branch. Original sources, prompts, intermediate source revisions, export recipes and hashes are retained in each lane. `source-audit.json` contains the canonical 136-file receipt list. Rerun with `node dev/industrial-textures/audit-batch03.cjs` using the configured Sharp dependency path.

## Cross-task inventory

`combined-source-inventory.json` accounts for the full 160-ID catalog exactly once: 152 available source candidates and 8 existing approved entries. The original task contributes 18 newly generated equipment, communications and lab designs; 12 earlier source designs remain in its runtime manifest. Repainting an existing ID does not increase coverage. The cross-task inventory verifies source/output hashes for the original task's 18 and file hashes for the 12 earlier designs; existing approval is attributed to its coverage record.

## Runtime handoff

Source availability is separate from complete in-game behavior. The original task owns renderer integration, test gates and live verification. It has the native geometry and new content-region ledgers needed to compose live content without reusing fragments of the old painted body.

- Crew: `crew/FURNITURE-FITNESS.md`, per-export `authoredGeometry`, `furniture-verification.json` and `furniture-regions.json`. New seating/support/occlusion planes are measured. Booth, chair and punch-bag envelope fills differ from the old geometry; check body alignment and visual scale. Punch-bag sway needs the documented moving bag/chain region with its fixed mast preserved.
- Storage: `storage/publication-anchors.json`, `media-anchors.json` and `treasury-anchors.json`. Jukebox stays off until real Spotify connection. Outbox count, publishing cargo, coins and charts use actual runtime state. PNL solid art is deliberately a floor disk, with the translucent chart region supplied separately.
- Utility: `utility/integration-ledger.json` includes all 24 utility assets and new transport ports, motion regions, wall-host requirements and paired projections. Validate physical conveyor continuity, wall mounts and actual cosmetic triggers.
- Habitat: `habitat/anchors.json` includes floor-pass placement and lamp/steam/cable content guides. No upright bitmap rotation or stretching.
- Control: `control/anchors.json` includes empty screens, planning surfaces, queue rows, threat chamber and airlock opening. Airlock source is a frame for real open/closed/jammed iris state.
- Archive: `coordinator/README.md` supplies blank mission, trophy, calendar, inbox and microfiche regions for actual content.

The review page and native-scale sheets were visually inspected. This handoff does not claim a full running-station acceptance pass or completion of runtime mechanisms.
