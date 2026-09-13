# One-prop calibration — 2026-09-13

The broad prop batch was rejected for camera drift, excessive detail and weak recognition. It remains unapproved and is not connected to the normal renderer. This pass calibrates only the existing CRATE.

Open `http://127.0.0.1:18792/?propReview=crate` for the candidate. The ordinary URL retains the previous crate. Both use the existing station, collision rules and saved placements. One crate was placed through REFIT on the command deck; the three-room layout and previous nineteen props were retained.

The original sprite was used as a visual structure guide, alongside the approved bridge reference and workstation. The new drawing retains the broad lid, five front ribs, two reinforcing bands, central latch and short skids. It has no lights or invented machine state. Built-in image generation produced the artwork; export removes only connected neutral background pixels and preserves subject RGB.

Native rendering measured a 26×21 solid silhouette, a 2×1 tile footprint and the exact original floor edge. The PNG is scaled uniformly and is not rotated into an unsupported view. These measurements establish geometry, not subjective approval of the design.

`crate-scale-comparison.png` compares the previous and candidate crate at identical scale, with the approved workstation and unchanged white agent. The live REFIT placement/save was observed and the loaded page reports `data-prop-review="crate"`.

Validation: industrial loader contracts 299 assertions; 160-prop regression 1413 assertions; workstation state 538 assertions; render smoke 13 assertions. The native calibration render passes footprint, alpha bounds, floor contact and no-emitter checks. Full gate receipt is recorded after completion.

Prompt/provenance: `CRATE-PROMPT.json`, `CRATE-CALIBRATION.json`, `crate-structure-guide.png`. Recreate the native comparison with `dev/industrial-textures/review-crate-calibration.cjs` using the bundled canvas runtime. No broader prop artwork is accepted by this checkpoint.
