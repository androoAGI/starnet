# 0.11.0 owner-test polish — 2026-09-06

The owner reported four issues while testing candidate `2cfdcb04e`: sent group images appeared only in SHARED, Recipe Bay cards collapsed, the context extraction surface did not fit the theme, and bay names were unreadable. The owner authorized fixing them and rebuilding an unpublished installer for another test before release.

## Repairs and focused proof

- Group messages now persist their exact attachment IDs and display image thumbnails or file buttons on the sent message. Image buttons open the full image. Upload retries are idempotent; conversation branches retain only files belonging to retained messages. Historical shared uploads without a proven message association remain in SHARED. `test/group-message-attachments.test.js` and the real-sidecar `test/group-sessions.http.test.js` cover association, bytes, isolation, invalid sends, retry and restart. The live seeded browser sent an image plus Markdown with an empty composer and showed both under “Please review the attached files”; reload after a sidecar restart retained them.
- Four late grid overrides now exclude deep recommendation rails. The same live six-offer fixture changed from `0px 0px 0px 232px 232px 232px` columns to six `232px` columns at a 463px rail width, with 98px-high cards.
- Context extraction keeps its outline and interaction model while using the existing themed face, panel, well and edge variables. Live conversation-mode `brief_ask` was exercised with typed context, appended shortcut and delegation; the sent receipt folded correctly. No horizontal overflow at 312px or 651px card width. Existing task-conversation tests pass.
- Bay names are drawn directly after room lighting in both the station and REFIT. The owner rejected the first repair's minimum screen size and floating collision stacks after testing installer `5eb4ac201`. The correction uses compact, single-line tags fixed to each bay's top, with geometry in station units so tags shrink with their bays. Long names shorten to the bay width with an ellipsis. Live six-bay screenshots confirm normal-scale tags and proportional shrinking at distant zoom. `test/bay-name-legibility.test.js` checks proportional zoom/DPR, fixed anchors, complete ULTRON, live binding/rename, unassigned bays and bounded long names.

The live preview was an isolated dev-seeded workspace on port 9188 with a deterministic local provider on 9189. No external model was called. Evidence: `.bugloops/polish-live-proof.json`, `.bugloops/polish-attachments-before.log`, `.bugloops/polish-group-http.log`, and the CUA screenshot/DOM receipts in the release task. Canvas pixel readback is unavailable through the browser tool’s read-only DOM adapter; the canvas was visually inspected instead.

Owner records: `de0bb232`, `8ac0662a`, `b87dbc17`, `0ff9dfc6`. Source closure, installer verification and owner recovery are separate fields; passing these source checks does not assert recovery on an installer.

## Lighting incorporation

The separately verified room-colour repair is trunk merge `cac60f4a990d84b49c734edb67d56cf1a384d307`, source `ba3e66447`. It fixes `#stage` to the approved `saturate(1.06) contrast(1.1) brightness(0.94)` grade independently of the UI theme. It preserves custom UI colours and all three lighting settings. The owner’s approved reference used LOW; their installed profile had MEDIUM. Do not reset the owner’s exposure globally. See `qa/digests/2026-09-06-room-colour-parity.md` after integrating that trunk.

## Release boundary

The combined product-code candidate passed all 729 fast steps and 130/130 browser-journey assertions. The first HTTP gate exposed a fixture-isolation issue: the staged Google Desktop registration took precedence over the legacy connector suite's fake/no-client setup. The suite now explicitly supplies an empty Desktop-registration fixture and clears inherited legacy credentials, then applies its own scenario credentials. Production registration precedence is unchanged. The corrected suite passes all 129 assertions; the separate native Desktop PKCE suite still exercises the native flow. Full HTTP rerun and final integration receipts are recorded with the replacement artifact.

This is an unpublished replacement 0.11.0 candidate. The version is not bumped again. Preserve the previously tested installer and receipt before overwriting the candidate path. Full gates, exact clean source identity, updater-signature validation and resource-byte verification must precede delivery. Publication still waits for the owner’s test and release decision. The 48-hour soak waiver does not waive installed acceptance or the existing public-readiness blockers.
