# Industrial station integration — 2026-09-12

Owner request: implement the reviewed industrial station materials, broader
workstations and matching chairs, and sharper wall/corner/shell rendering.

Source: `312b7b5d6`; source-audit binding: `0d1e015e9`.
Integration base: `b4652157b` on `feat/harness-backend`.

## Change and compatibility

The eight reference-authored images load by default. The former industrial query
URL remains valid; `?textures=classic` provides the original renderer. An asset
failure retains the original set atomically. New Refit desks occupy three tiles.
Saved two-tile desks retain their placement and use the compact reference body
at the same height. No save migration or neighboring-prop movement is performed.

Six-times-resolution visual plates retain floor, wall, corner and shell detail.
The original geometry canvas still owns collision, picking, lighting and masks.
Workstation and chair artwork preserve aspect ratio and floor contact; all chair
facings use matching occupied-seat rims.

## Source-audit review

Reviewed the complete frontend delta against current trunk, including the new
image-loading and rendering module. No provider, credential, billing, execution,
shared-schema, activity-state or release-readiness behavior is changed.

Two existing advertised-claim records reference affected files: the deliverables
menu locator and the absence checks for retired emergency-stop controls, all in
`frontend/index.html`. That file only adds the material-loader script; the menu
locator and absence checks remain intact. New UI text is limited to the material
lighting control in the existing CRT lab. The new loader reports only actual
asset-load results; it makes no product completion claim.

Rebuilt the release surface from committed source through `buildReleaseSurface`.
The manifest adds the industrial module and updates seven existing file hashes.
All 37 claim records, live-proof states, wave verdicts and exception records are
byte-equivalent as parsed JSON before and after the manifest update. The audit
binding is separate from any assertion of release readiness.

## Live proof

The running station at `http://127.0.0.1:18792/` reports
`texturePack: industrial`, `textureResolution: 6`, with browser errors `[]`.
The default URL displays the broad desks, centered dark chairs and detailed
connected walls and shell. Existing saved desk/chair coordinates remain intact.
Refit lists both industrial desks as 3 × 1. Placing a desk increments the station
from five to six objects and opens its assignment dialog. Canceling assignment
and undoing placement returns to five objects; DONE reports `Station layout
saved`, and the persisted five prop coordinates/dimensions are unchanged.

Native-canvas verification: 6,400 geometry-alpha comparisons; eight chair facing
and mirror cases; exact occupied rim agreement; fixed floor contact and preserved
sprite proportions; saved two-tile desk compatibility; unchanged wall masks;
pixel-identical straight/wrapped wall projection; all three nested image-blit
overloads preserve shell detail through masks; classic and missing-asset fallback.
All seven changed frontend JavaScript modules pass syntax checks.

## Full gate and integration receipts

Pre-merge: `npm run test:fast` passes **771 / 771**, exit 0, on `0d1e015e9`.
The source-audit regression now passes all 64 assertions. Log:
`dev/industrial-textures/integration-fast.log`.

Merged by fast-forward from `b4652157b` to the exact tested commit `0d1e015e9`.
The pre-existing unstaged `docs/NEXT.md`, `qa/STATUS.md` and untracked room handoff
document were preserved; the tracked diff and status matched the pre-merge
snapshot exactly. No sidecar, shared contract or package changes are introduced
relative to trunk. Restarted the own-worktree dev-seed sidecar and rechecked the
default URL, saved furniture, active texture dataset and empty browser error log.

The first main-checkout rerun hit the existing 900-second wrapper limit without
an assertion failure. During that run the website-docs lane advanced trunk to
`f8ddd9c363899ed48135f061d53b7bcdd3f4e899`. The snapshot check correctly refused to
roll back that newer work; no reset was performed. The combined commit changes
no frontend, sidecar, shared-contract or package bytes relative to our tested
source, and includes one additional website test.

Authoritative post-merge proof: GitHub Actions run
https://github.com/androoAGI/starnet/actions/runs/34728957569, independently read
with `gh run view`, reports `conclusion: success` for exact head `f8ddd9c36`.
Its logs report **772 / 772 fast steps green** and **34 / 34 customer journeys
green**. Log copy: `dev/industrial-textures/postmerge-ci.log`. This completed
combined-source run supersedes the incomplete local rerun; no tests were filtered
or bypassed and no third local run was needed.

The installed desktop executable was not rebuilt. This lane did not publish a
release or deploy the website; the separate website lane owns that deployment.
