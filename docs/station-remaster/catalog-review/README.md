# Full catalog room fixture

Entry: `/prop-catalog-review.html?propSet=projection`.

This isolated page builds disposable WorldModel rooms and draws them through StationBake,
PropSprites, authored surface placement, current projection effects and the actual crew sprite.
It does not read, mutate, or save the user's station. It does not assert art approval or real activity.

## Integration hook

The coordinator may add `<script src="app/prop-catalog-review.js"></script>` to index.html.
The module is inert in the main app unless `?propCatalogRoom` is present. That query redirects
to the standalone facility, preserving category/search/direction/placement/page parameters and
selecting `propSet=projection`. No dependency globals are touched on this redirect path.
The standalone page already loads the module after its dependencies, including
`projection-prop-effects.js` before `propremaster.js`.

## Coverage and placement

- 160 runtime catalog types, 208 supported directions: 7 native mirrored sides and 24 native decal turns.
- `PropSprites.facings` and `footprintAt` are authoritative, including unchanged upright footprints.
- Six subject views per room, with category, ID/name, direction and placement filters; stable previous/next navigation.
- Required surface props and optional stack props receive containing native long tables. Wall-only props use the actual north wall.
- Every room has the unchanged accepted workstation, crate and chair plus the real white cadet for scale.
- Supporting furniture/anchors are excluded from catalog coverage counts. Rendered-this-visit counts are in-memory, never approval.
- Idle/powered and frozen/animated states are explicitly fixture previews; they do not issue tool calls or create agent work.
- Footprint overlay, a default fit-to-room view, and explicit 1/2/3/4 display-pixels-per-world-pixel scales assist room review.

The DOM exposes `#coverage`, `#report`, `#diagnostics`, and the read-only diagnostic object
`window.PropCatalogReviewState` with current keys, missing art, loader failures, runtime catalog
drift, mount placements, placement conflicts, and fixture state. A clean rendering sets
`body.dataset.result="rendered"`; problems use `review-issues` or `error`, never `approved`.

## Rebuild and verification

```powershell
node dev/industrial-textures/build-prop-catalog-review.cjs
node dev/industrial-textures/prop-catalog-review.test.cjs
node dev/industrial-textures/prop-catalog-review.browser.mjs
```

The browser probe expects this worktree's seeded sidecar on port 18836 and uses the repository's
existing headless Chrome/CDP helper. It creates an isolated browser profile under
`.dogfood/catalog-review`, traverses all 35 all-category rooms in idle and powered preview,
checks all 208 directions, all mounts, asset failures, and canvas pixels, then checks search and
footprint controls. It does not touch a saved station or claim in-room owner acceptance.

Verified: pure tests cover 76 all/category layouts and 38 table-mounted cases. Browser sweep:
160 types / 208 directions / 35 rooms, zero page exceptions, no placement conflicts, no missing
art and no authored-surface fallback. Pixel sample `[33,28,23,255]` confirms a rendered room.

The fixture lane's screenshot inspection covered the first room and a filtered mug-on-table
room. The coordinator subsequently inspected all 35 rooms in the integrated running demo,
covering all 208 supported directions. This is a visual review pass, not owner approval.
See [integrated polish verification](../projection-correction/POLISH-2-7.md) for final checks
and release limits. The fixture lane's screenshots are local
`.dogfood/catalog-review/first-room.png` and `surface-room.png`; the committed browser receipt
records its programmatic coverage sweep separately.

Full `npm run test:fast` was attempted but stopped at unrelated step 83/783,
`test/local-voice.test.js:32`: expected model-package availability false, actual true.
The complete suite is therefore not green in this worktree. Coordinator owns the integration gate
and the final room layout/visual assessment.
