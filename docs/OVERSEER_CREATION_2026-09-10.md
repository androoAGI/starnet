# OVERSEER creation interface — 2026-09-10

The first-run setup now fills the screen and uses the shared glass material throughout name entry, personality selection, working style, provider connection, model selection and reasoning controls. Character search is removed; the full character gallery remains available. Appearance and entered connection details survive back navigation.

The primary account action uses the real StarNet wordmark, a prominent START WITH label and the concise subtitle “Subscribe and start. No API keys.” Its light trail runs only around the border and respects reduced motion. Clicking it opens the account connection window directly; automatic provider selection does not. Alternative providers use bundled local logos.

The six canonical personalities from the personality upgrade are integrated: Composed, Warm, Blunt, Dry, Unhinged and Upbeat. Equal-width controls become a three-column grid at narrower sizes. Unhinged retains the two-press confirmation, with an accessible explanation below the selector rather than a label that stretches the row. Detailed tuning stays in the Overseer’s settings. Mobile sections size to their content so the character area cannot overlap the identity fields.

## Evidence

- Frozen candidate ec6f2cd5d: `npm run test:fast` passed all 759 steps; log `dev/overseer-personality-final-fast.log`.
- `scripts/qa/overseer-setup-live.cjs`: passed against the seeded running sidecar. Covers six personality labels, confirmation without layout shift, no horizontal overflow or mobile section overlap, all 16 local provider logos, account-window opening and duplicate guard, failure/retry, identity preservation, custom endpoints, keyboard model selection and Escape restoration, reasoning persistence, theming and recovery.
- Viewports: 1280×800, 1024×600, 700×650 and 390×740; model dialog bounds and 145% UI scaling checked. No unstyled native controls or page errors observed.
- Model catalogs and account-link responses use isolated browser fixtures; a real paid subscription and external OAuth completion were not exercised. The underlying seeded sidecar and saved-station recovery are real. No installer or public deployment was performed by this UI task.

The source was informed by the accepted controls and flow in “Optimize deliverable purpose” and “Expand glass UI identity.” Final integration evidence is recorded separately after the dependency merges land.
