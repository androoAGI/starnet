# Image intent false-trigger repair — 2026-09-09

Source repair: e6cdd0f1a. Customer record: b0431c24. Synchronized trunk: 0a9d02b35.

Ordinary wording (draw a distinction, illustrate reasoning, Docker image, clickable profile picture, image-generation discussion) now reaches the configured model and can complete as text, with or without STUDIO. The host preflight is limited to direct visual-content requests; ambiguous drawing and code/vector/text media retain ordinary tool routing. Explicit image requests retain credential admission and artifact-backed completion.

Proof: pure classifier 55 assertions; real sidecar 63 assertions; the same 63 assertions passed through node dev/seed.js --keep with synthetic local model/image responses. The original TCP/UDP reproduction failed before the model with turns=0; the repaired path reaches the model and earns a text-only done terminal.

Synchronized candidate: full fast manifest 733/733, HTTP 107/107, customer journeys 32/32; all exit 0. The standard 15-minute fast wrapper timed out on a previous run with no test failures after the asset checks. The final full manifest used the unchanged test:fast:raw command under a 30-minute bounded wrapper; no test was filtered or skipped.

Two separate test-only reliability repairs were necessary: c90ee5890 asserts that a quiet browser page does not schedule the old 900ms blind wait, instead of using an OS-sensitive elapsed-time assertion. The original test failed twice in full runs but passed on both trunk and branch in isolation; injecting the old wait in memory fails exactly the revised assertion. c8a5dd2fb extends the existing bounded Chromium temporary-profile cleanup retry from 2 to 10 seconds for Windows cache handles; all CRT behavior assertions passed before and after, and the cleanup repair passed twice in isolation and in the full gate. No browser or CRT production code changed.

The installed customer build and the reporter's exact prompt were not available. Installer verification and customer recovery remain unconfirmed. No push or release is included.

Integration synchronization: trunk advanced to 76ddd181c with inbox UI changes and cd7bde1bc, a Chromium worker-shutdown repair. That landed cleanup supersedes the temporary c8a5dd2fb retry extension, which was removed from the final diff. Fast verification is repeated on this combined tree; backend source is unchanged from the successful 107/107 HTTP receipt.

Final integration: agent/image-intent-0909 merged to trunk as 407b82b4dc9beffe7d2c007088bf66ba04856ce9 from snapshot 76ddd181c. The merged tree matched the verified branch. Standard npm run test:fast passed 733/733 and npm run test:http passed 107/107 after merge, both exit 0. Customer journeys passed 32/32 before integration. Existing uncommitted qa/STATUS.md and docs/HANDOFF_ROOMS_2026-09-04.md bytes were preserved at merge.
