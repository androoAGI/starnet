# Utility artwork handoff

Two new designs produced with the built-in image_gen tool, using the approved crate for material finish, workstation for camera, and bridge for atmosphere. These are art candidates, not user-accepted or live-integrated props. No runtime, shared manifest, owner workspace, or save was changed.

- `filter.png`: 1076 x 1462 RGB candidate. Its checkerboard is baked into the pixels. A targeted imagegen transparency attempt also returned RGB. **Do not integrate until alpha export is completed.** The original first design is retained because the attempted extraction did not improve its export status.
- `tank.png`: 1331 x 1182 actual RGBA from the targeted imagegen extraction. 478,853 fully transparent pixels; all four corners have alpha 0. Most body pixels have alpha 253. Opaque silhouette at alpha > 160 is `[43,93,1296,1063]`; any-alpha bounds `[0,90,1299,1158]` include faint peripheral dust. **Clean or explicitly handle this before PropRemaster's any-nonzero-alpha crop.**

The intended floor footprints are FILTER 1 x 1 and TANK 2 x 1 at 12 pixels per tile. Both support only the actual south-facing view. Neither image was rotated, stretched, recolored, or composited with legacy art. Original source PNGs and every exact prompt are retained here. See `manifest.json` for envelopes, floor contact estimates, interaction contracts, and authored motion regions, and `asset-checks.json` for dimensions and SHA-256 hashes.

FILTER is a content-routing machine, not ventilation hardware. Its empty roller channel leaves real packet rendering to the runtime. TANK is a physical water specimen vessel, not a computer display; water should not receive scanline or occupancy-screen animation. All motion and state mapping remain unresolved for integration. Full-resolution visual inspection passed the material/camera intent, but live game-scale readability, floor contact and interactions have not been verified. The integration owner must run the required application/test gates.

Original generated files remain under `C:/Users/andro/.codex/generated_images/01a09e48-0877-7203-a53f-4b137e36d69a/`: FILTER source `exec-0a5e73fa-76ae-4391-911e-907b8cddb92b.png`, FILTER failed alpha attempt `exec-c63645f4-77a7-447f-bb35-31bc3d266163.png`, TANK source `exec-c6737477-fa21-401e-9f7e-28583aae73b8.png`, TANK RGBA export `exec-4edc9d57-8d96-43c9-b753-18b5965b6f72.png`.
