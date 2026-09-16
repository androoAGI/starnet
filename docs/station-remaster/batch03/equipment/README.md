# Equipment section — coordinated original texture task

Six complete new designs: `pixelrig`, `bench`, `workbench`, `rack`, `rackV`, `core`. These IDs belong to the original texture task; `industrial_bench` belongs to the furnishing task and is a separate prop.

Generated using the built-in image generation tool, one asset per call. Exact prompts and correction prompts are adjacent JSON files. Final source PNGs are retained here, and alpha exports are in `frontend/assets/industrial/batch03/equipment/`. Export-checks records source/output hashes, alpha counts and zero changes to source RGB. The user-authorized exporter removes only connected neutral background and crops, without recolouring or stretching the artwork.

Style anchors: the approved calibration crate, workstation, and bridge reference. The revised direction uses controlled painted planes and selective edge wear. Native geometry establishes footprint, contact and interaction, not retained sprite pixels. The long bench received a proportion correction to reduce its leg height; the data rack received newly drawn server grilles to distinguish it from a drawer cabinet.

Runtime: `integrate-equipment-batch03.cjs` uses uniform alpha-bounds fitting, original footprints and bottom contacts. Pixel Rig and Bench use newly authored display art with physical occupancy controlling screen power. Workbench's new lamp follows the existing instance-scoped shell/verification event, including separate failure colour and visible status with reduced motion. Rack activity and memory chamber motion follow use. No original sprite callback paints through these new bodies.

Live review: `http://127.0.0.1:18792/prop-atlas.html?set=new`. The browser was checked at fixed common scale beside the approved desk, crate and actual clean cadet. The gallery's animation and placement controls are explicitly labelled demonstrations, not live harness telemetry. It does not modify saved station layout.

Verification: native-art verifier covers all 47 authored views (46 IDs), source alpha/contact, screen occupancy, reduced motion, distinct verification failures, no old sprite callback and no per-frame readback. Focused contracts, mounting, workstation screen-state and simulation-lighting tests pass. Full test:fast has not been rerun for this expanded candidate; no trunk merge or release claim.

Progress is separate from acceptance: 8 earlier approved IDs, 46 new runtime designs awaiting user review, 16 additional earlier generated IDs awaiting runtime integration. Including these six, source artwork exists for 70 of 160 IDs; 90 still require new source artwork at this checkpoint. The parallel task is correcting its earlier 44 designs and owns the next 16 new transport/infrastructure IDs. Counts do not count a repaint as a newly covered catalog ID.
