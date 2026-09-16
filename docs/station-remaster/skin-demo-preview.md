# Combined local prop and skin preview

Open `http://127.0.0.1:18794/?propSet=projection&skinSet=study` for the existing large demo layout, revised props and 38 proposed agent skins from the `sprite-reimagine-0914` task. The selector compares a mixed crew or one design across all existing visible bodies. This is an opt-in rendering override; saved agent identities, skin selections and activity are unchanged.

All 152 cardinal PNGs were copied without pixel modification. Sources and generation/revision records remain under `frontend/assets/skin-study-0914/`. `runtime-preview.json` records SHA-256, image dimensions and visible alpha bounds. Reimport with `node dev/import-skin-study.cjs <source-asset-directory>`.

These are four standing poses, not finished walking, seated, talking or work animations. The simulation continues moving its existing bodies, while the appearance preview resolves only the available cardinal standing pictures. The visible label states that limitation. No new agents, tasks or backend work are invented for the preview.

The existing sprite renderer supplies lighting, smoothing and ground shadows. Each skin uses one uniform scale across its four views, at up to 18 world pixels visible height (25 for Ultron). Every direction uses its own measured foot padding. The existing prop placement, camera and lighting remain active.

Verified in the running 144-prop demo in cinema view, including mixed crew and the revised teddy selection. The opt-in test verifies isolation, 38 distinct assignments, all 152 file hashes and foot anchors. Existing sprite loading, walk motion, seated facing and direction-detail tests pass. This does not establish production animation acceptance.
