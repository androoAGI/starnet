# Structural texture completion pass

The owner approved the workstation-derived capability-v2 props. This pass preserves those assets and the approved CRT/lighting profile.

Coverage audit: all 24 floor materials already have remastered images. Seven of ten wall materials had images; viewport, wainscot and hedge still used the earlier primitive recipes. Ceiling coping used a low-resolution procedural strip. Four built-in image generations now cover those gaps, with exact prompts/sources recorded here.

- Coping: authored steel plates and recessed channels, sampled in world coordinates on straight and corner cap spans. Existing wall silhouette and light masks remain authoritative.
- Viewport: authored lintel, mullion and sill slices surround the existing live-starfield hole. No opaque generated glass or baked stars cover the opening.
- Wainscot and hedge: selected material images replace the native wall faces and feed high-resolution side/corner strips. Geometry remains unchanged.
- Classic mode and unavailable-pack fallback retain the complete original rendering path.

Checks: industrial texture contracts include specialized image identity, high-resolution strips, transparent window interior, coping phase wrap and classic fallback. Wall seams, material tests and chunk parity pass. Live review and full-gate receipts are recorded after verification.

Local preview: http://127.0.0.1:18797/?propSet=projection&skinSet=study
