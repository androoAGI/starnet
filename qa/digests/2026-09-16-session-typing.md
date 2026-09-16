# Session switching while typing — source repair

Owner explicitly requested fixing and merging the remaining session-switch complaint. Branch: `agent/typing-focus-0916-c7a2`, based on trunk `87e10e1fe`. Source changes: `86b33ace3`, refined at `dc7ea8633`. Final tested candidate: `50791280bd428d0c3bee9681e41f105489ef5dcb`.

## What changed

Workshop delivery reveal now checks the actual composer before opening a session. Live delivery, startup polling and return-from-away polling leave a focused input, any unsent text, and staged/uploading attachments alone. The deliverable still lands in its own unread session; the existing live notification remains actionable. Explicit session selection and idle delivery reveal retain their behavior.

Connector continuation now checks navigation generation and composer engagement after asynchronous connection verification. If the user navigated (including away and back), started composing, or the target disappeared, it starts no run and retains the handoff for deliberate retry. Duplicate-click protection and successful continuation remain intact. The same repair is present in the website app.

The existing model-requested session-focus rule retains its prior behavior: a valid foreground request with no draft/attachments may navigate, including when Send leaves an empty input focused. Background delivery uses the stricter focus guard. This distinction avoids blocking intentional agent navigation while preventing unrelated arrivals from stealing the caret.

## Proof

- Before-fix seeded browser: `workshop.built` changed the selected session to the deliverable and replaced the visible draft with an empty composer.
- After-fix seeded browser: delivery, focused-empty input, blurred draft with attach/return polling, and an attachment-only composer preserved the selected session. The next real composer Send recorded its turn only in the original conversation. Explicit review worked.
- A delayed connector response preserved the new draft, selected session and handoff; deliberate retry started one run. Reload retained the original conversation turn.
- The existing live voice/model-focus/upload campaign also passed, including valid foreground focus, refusal of stale/background requests, and no cross-post after upload-time navigation. Both browser campaigns had zero page errors.
- Final `npm run test:fast`: **812/812 PASS**. Final `npm run qa:customer-journeys`: **35/35 PASS**. Syntax and diff checks passed. Earlier exploratory runs stopped for the foreground-navigation compatibility refinement are not acceptance receipts.

Portable receipts and gate-log hashes: `qa/evidence/session-typing-0916/`. Repeatable live runner: `scripts/qa/session-typing-live.cjs`; regression: `test/session-typing-safety.test.js` (registered in fast and customer journeys). Real seeded UI/stores were exercised with controlled delivery and connector/model transports; no paid provider or personal station was used. No backend, shared contract, credential storage or packaging source changed.

## Delivery boundary

This verifies the source repair, not an installed binary or reporter recovery. Any release candidate must include these commits and rebuild/reverify its installers. Prior 0.12.0 installer receipts cannot establish delivery of this later repair. The original customer symptom record `774641dc` now includes these formerly missed paths and retains installer/customer status as unverified/unconfirmed.
