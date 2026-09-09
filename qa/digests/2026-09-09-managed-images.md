# Managed image credits repair receipt

Code merge: 050e1eec55901a3de156e27ccde5c4aa8f62702b, from trunk 76d06117d and
agent/managed-image-repair-0909. Source repair: 05fbfbd28; regression and bug record: 6218ab4c9.

The image router previously accepted only OpenRouter credentials and rejected a linked
StarNet station before any image request. It now pairs the linked account credential with
its cloud endpoint and lets the cloud use its server-held upstream key and meter credits.
Conversation-provider switches can use the same managed image route. Missing managed
credentials do not silently redirect a StarNet run to BYOK, and image-generation failures
no longer tell customers to connect OpenRouter.

Verification:

- Full fast gate before and after code merge: **733 steps green**.
- Full HTTP gate before and after code merge: **106 steps green**.
- Customer-journey campaign: **32 steps green**.
- The new managed-image end-to-end regression fails on the original router with the
  reported OpenRouter-key blocker, and passes on the repair.
- Running the real sidecar and the local cloud backend at clean revision 518e6ce with
  a disposable account and synthetic upstream saved and served identical PNG bytes.
  A 0.02 upstream image cost caused exactly one 0.025 debit at the configured 1.25 margin.
- Restart with the credential removed from the link file and injected through the desktop
  credential environment still generated successfully. This exercises the sidecar's
  keychain-injection input, not the physical Windows Credential Manager.
- HTTP 402/503 and an image response with no image did not earn a done terminal.
- The cloud-backed proof also passed through node dev/seed.js --keep.

Logs remain in the isolated worktree: .fast-managed-image.log, .http-managed-image.log,
.customer-managed-image.log, .merge-fast-managed-image.log, .merge-http-managed-image.log,
and .seed-managed-image.log.

The existing uncommitted qa/STATUS.md and docs/HANDOFF_ROOMS_2026-09-04.md were preserved
byte-for-byte. This separate receipt avoids editing another session's status file.

No cloud source change, production account charge, publication or deployment was made.
No live upstream image generation, rebuilt installer or customer recovery was verified.
The separate reported localhost connection refusal is not established as the same bug.

Customer record: [a9374d2c](../bugs/a9374d2c-linked-starnet-credits-cannot-authorize-image-ge.md).
