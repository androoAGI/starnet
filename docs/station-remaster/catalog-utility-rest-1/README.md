# Workflow machinery source handoff

Eight south-view bodies, reviewed in the source and at 2x/4x actual native world dimensions. No live integration is claimed. Native structure lists only south for these IDs. `integration.json` contains native footprint/bounds, contact, source ROI/crop, hashes, actual uniform fit and byte verification for every export.

Built-in image generation produced `sheet-source.png` from `sheet.prompt.txt` at `C:/Users/andro/.codex/generated_images/01a09e48-0877-7203-a53f-4b137e36d69a/exec-2f63ecca-af88-4fef-938b-184211a8567c.png`. Connector was too narrow in that sheet; `connector-source.png` is a separate source correction from `connector.prompt.txt`, original `C:/Users/andro/.codex/generated_images/01a09e48-0877-7203-a53f-4b137e36d69a/exec-acc6efe2-e88a-4ce8-bfe1-09274235962b.png`.

Exporter preserves every retained RGBA byte and all RGB bytes including transparent pixels. It removes detached soft alpha beyond a radius-three fringe of the alpha>=180 body; it does not stretch, rotate or redraw art. Every body reaches at least 90% of native envelope width under uniform fit. This is an offline packaging check, not a runtime test.

Native identity evidence is in `frontend/app/propsprites.js`: splitter:3404 one west inlet/two east exits; filter:3440 west inlet/east selection routes and upright cartridge; merger:3483 two west inputs/one east output; joiner:3525 same ports with a distinct holding latch; loop:3569 west inlet and east done/return branches plus counter pillar; bay:3612 clear berth between guide arms with blank agent nameplate; outbox:2941 northeast-rising internal ejector ramp and southwest collection tray; connector_portal:7666 three socket patch cabinet with right cable spine.

Flow lanes and berth remain clear of baked parcels or people. Runtime binding names, packets, latch movement, scanner state and connector online/error/fired lights require mapping onto these new sources; `effects:false` prevents claiming those regions have already been integrated. Generated displays contain no telemetry values.
