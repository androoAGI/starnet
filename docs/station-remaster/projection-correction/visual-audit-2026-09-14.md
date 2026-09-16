# Combined station visual audit — 2026-09-14

Audited live URL: `http://127.0.0.1:18794/?propSet=projection&skinSet=study`.
Scope: station overview, recreation room, lounge, central work areas, and saved placement/native view resolution. This is an audit, not visual approval of every catalog item. No production art or saved layout was changed for this audit.

## Assessment

The strongest anchors remain the compact workstation, crate, chair, TV, arcades and pool table. The current lounge has a much more coherent projection than the earlier product-render imports. Preserve those proportions and camera treatment. Wood, upholstery and colored felt give the station useful material variety.

The largest remaining gaps are character poses, guaranteed placement orientation, consistent readability at game scale, and incomplete in-scene coverage. Asset availability is not release readiness.

## Prioritized findings

| Priority | Evidence | Required finishing work |
| --- | --- | --- |
| P0 | The live panel explicitly says standing poses only. Characters at seating positions still show upright bodies. The study renderer forces standing directional frames for all activities. | Author matching walk, sit and interaction poses for the runtime's supported directions/states. Align feet, hips and chair contact points; verify chair fronts, tables and foreground props occlude the body correctly. Moving agents need matching locomotion, not sliding standing sprites. |
| P0 | Saved booth `p68` requests rotation 2 (north). The native resolver returns no north view and drawing falls back to south. | Supply the actual north-facing asset or correct the placement to a supported direction. Check every saved placement against the supported-view contract; do not rotate a frontal bitmap into a fake projection. |
| P0 | This layout contains 144 instances but only 43 of the 160 catalog types. 117 types are absent. | Review the remaining types in furnished native-scale rooms with neighboring anchors and agents. Include every supported orientation, wall adjacency, table mounts and overlap cases. This demo alone cannot approve the catalog. |
| P1 | 26 saved desks are 2×1 while the candidate manifest expects 3×1: 23 `desk`, 3 `desk2`. The remaster intentionally refuses that footprint and uses native fallback. | Preserve the accepted compact desk where intended. Explicitly label that coverage, and give the new desk2 art a correctly sized review placement. Do not stretch it into the compact footprint. |
| P1 | At overview scale, hull/floor detail and yellow work-bay labels compete with the props. Long work-bay annotations were visible extending beyond the hull into space. | Collapse or aggregate labels at low zoom, reveal full truthful details on selection, and constrain annotation placement. Tune floor/wall contrast so important prop silhouettes survive without globally brightening the station. |
| P1 | Several bright study characters dominate the dark room, while darker characters lose their outline. Different materials and edge treatments do not yet feel equally grounded. | Calibrate skin values, edge contrast and contact shadows in the actual room lighting. Keep character identity and material color; avoid applying a uniform metal finish. Measure body landmarks as well as total alpha bounds, since hats, ears and weapons can distort apparent body scale. The latter is a code-derived risk requiring individual visual checks. |
| P1 | 173 revised prop views have `effects:false`, deliberately excluding old image-specific effect mappings. Normal screen-power behavior still exists. | Re-author each applicable mechanism, indicator and local effect against its new image, driven only by real state. Review powered/unpowered and active/idle appearances; do not use constant glow to conceal missing state integration. |
| P2 | The four large work areas repeat similar arrangements; small end cabins have little visual purpose. | Give rooms a clear function through a focal object, supporting storage and intentional circulation. Cluster related furniture, confirm access to chairs and consoles, and reserve quiet floor areas. Add clutter only where it explains use. |

## Finish order

1. Fix unsupported directions and explicit footprint/asset selection. Freeze the approved anchors.
2. Complete the skin pose contract and validate sitting, moving and working against those anchors.
3. Review all remaining props in room fixtures, correcting projection and scale before surface detail.
4. Apply one coordinated lighting, silhouette, shadow and label pass at overview and normal play zoom.
5. Restore applicable state-driven prop effects, then run interaction and performance acceptance.

## Readiness criteria

- All 160 catalog types reviewed in context, with a recorded result for each supported view. No unexplained fallback; intentionally retained compact desks documented.
- Native-scale and enlarged room views preserve orientation, footprint, recognizable silhouette and useful material separation. Large source resolution does not count as detail quality.
- Character movement, seating and work states use appropriate poses with stable body proportions, feet and chair contact points. Check front/behind crossings at furniture and walls.
- Powered/unpowered and active/idle props match real state; no stale effect coordinates or invented activity.
- Overview labels remain readable and bounded without overwhelming the station.
- Measure cold load, texture memory and pan/zoom/animation performance on the target machine; set and meet a concrete budget. No performance result is claimed by this audit.
- Complete the required test gate and live interaction checks. Prior asset/hash tests establish integrity, not aesthetic or animation approval.

## Reproducible placement evidence

Run `node dev/audit-prop-demo.cjs` from this worktree after launching the isolated layout demo. It reads the saved station and compares it with the actual native view resolver and projection manifest. Snapshot: [demo-placement-audit.json](demo-placement-audit.json).

The skin set is a local visual study: 38 candidates × 4 standing directions, with 152 loaded images verified in the browser. Mixed crew assignment is a preview override, not saved production skin identity. Portrait/roster consistency and durable identity remain separate integration checks.
