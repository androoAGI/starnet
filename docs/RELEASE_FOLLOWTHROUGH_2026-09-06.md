# 0.11.0 release follow-through — 2026-09-06

The installed desktop candidate remains `bd65c7737f116c6d55f334473534a49efa568ecb`.
This follow-through changed the deployed credits gateway and public privacy disclosure;
it did not publish a desktop release, tag or updater feed. Historical customer recovery
is not inferred from successful synthetic requests.

## Production gateway

After owner restored Fly access, the running app source matched `cc81e768`, before three
already committed repairs: `f7f8afd` unbilled-generation reconciliation, `74ddeef` magic-link
SameSite session recovery, and `b83271e` sanitized upstream error correlation. The clean
cloud main branch was deployed at `b83271e5cf2556c3ef301a55e4e2c971f36e8838`.

- Before deployment: 221/221 tests; live local proof 22 checks passed, with the separate
  live catalog/margin check explicitly skipped because the local host had no upstream key.
  Backup/restore drill passed; Windows used hard-kill recovery because it cannot send SIGTERM.
- Separate production backup verified at
  `/data/release-backups/0.11.0-b83271e/starnet-20260907T022021Z.db`.
- One existing machine `6835e5ef373068`, one existing `/data` volume, rolling deployment,
  `--ha=false`. Current image:
  `registry.fly.io/starnet-cloud:deployment-01M1WTP0VJXYH87GYJZESGFY1K`.
  Previous image retained for rollback:
  `registry.fly.io/starnet-cloud:deployment-01M0XVX7VAYEB58FJ8PH6J2VRJ`.
- After deployment: all 18 source files match the clean candidate. All 112,082 ledger rows
  present in the predeployment backup are identical in the live database; integrity check
  passes. Public health returns 200 and an unauthenticated models request returns 401 with
  the new correlation header. Local proof and restore drill passed again after deployment.
- Real synthetic Sonnet 5 requests from the production host succeeded both without tools
  and with tools/high reasoning. A subsequent request through the deployed gateway module
  succeeded with response content, completed stream and metered cost. Its test account and
  ledger lived only in memory; no customer account or credit balance was changed by the test.
  A deliberately invalid model produced 400 with matching header/body request IDs and no
  raw provider metadata. The live customer's historical malformed/failing request remains
  unavailable, so the original Sonnet report remains open.
- Fly SSH on this Windows host prints `The handle is invalid` after completed remote commands.
  Remote results were checked independently; this trailing CLI error is not represented as
  a clean command exit. The deployment itself exited zero.

## Google activation

The live privacy page now discloses Google service operations, transfer of tool content to
the selected model/credits gateway, plaintext local connector credentials and recovery copies,
retained artifacts/memory, and local removal versus Google-account revocation. No unverified
claim about third-party training practices or blanket policy compliance was added.

The website change used a separate owned worktree based on live production source `46b944c`.
Only `legal/privacy.html` differs among 3,944 staged files. Existing staging checks passed
24 assertions; browser review verified the section, links and lack of horizontal overflow.
Publication source is `1976b0e82` (with content commit `09bf42cfd`), deployment
`https://66fbffce.starnet-site.pages.dev`. The public canonical page matches the prepared
HTML after reversing only the observed Cloudflare email-obfuscation transform.

Google's first branding check identified missing site ownership. Cloudflare Domain Connect
added one Google verification TXT record for starnetos.com; its authorization explicitly
granted no future DNS-change permission. Search Console confirmed ownership. The next
branding check passed and the verified StarNet branding was published.

Data access is **not verified or submitted**. Google's review page names missing intended
data usage and a YouTube demo video covering the OAuth clients. Drive productivity and Email
productivity fit the implemented tasks, but the form cannot save those selections without
the video. Existing scope justifications remain available. A real consent/operation demo,
real-account refresh/removal/revocation/restart acceptance, and the applicable sensitive/
restricted-scope review still remain. The Workspace data policy and any required security
assessment must be addressed for the actual model-provider data flow before attestation.

Official references:
- https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- https://developers.google.com/workspace/workspace-api-user-data-developer-policy
- https://developers.google.com/workspace/gmail/api/auth/scopes

Follow-up at 23:04 EDT: the installed signed Windows candidate completed real Gmail
consent. Its callback reported six tools and the native catalog displayed MANAGE SERVICE.
Run `5451d600-a49e-4410-8d99-d713c8087687` successfully created one unsent test draft,
searched only the exact test subject in drafts, and read the matching message. Its durable
tool trace contains those three successful operations and no send operation. Gmail's own
UI independently showed exactly one matching draft with the requested subject and body.
Drive, Docs, Sheets and Calendar also completed real Google consent. The Clients page
lists StarNet Desktop and StarNet Account (web); both belong in the verification demo.

Subsequent installed-candidate runs exercised 20 actual Google API calls: Gmail draft
creation/search/read (3), Docs creation/update/read plus Sheets creation/write/read/format
and Drive folder creation/rename/search/metadata/export (12), and Calendar calendar/event
lookup, event read, free/busy and repeated read (5). All completed successfully. Four
additional internal task-list calls are not counted as Google calls. Only dedicated
verification fixtures were used; the Gmail message stayed an unsent draft and the Calendar
fixture was dated January 2000 with no attendees or reminders. Installed connector state
reported all five authorized and up. This proves these operations on Windows, not every
tool, physical Mac behavior, or every real-account revocation/recovery path.

The review also found the Google data-transfer disclosure existed on the privacy page but
was absent before in-app sign-in. The new connector panel now explains model-provider and
credits-gateway transfer, local credential storage, retained work and removal/revocation
before an explicit Continue to Google action. Cancel begins no OAuth attempt. The actual
seeded UI verified all five Continue routes, zero requests on opening/cancel, unchanged
non-Google sign-in, a detached panel unable to start sign-in, and readable 900px layout
without horizontal overflow. The source fix supersedes the bd65 package for the next build;
the prior package's acceptance receipts must not be relabeled as proof of this change.

## Local distribution-folder reconciliation

The release folder's top-level installer and feed still described the superseded unsigned
`d611e156a` candidate. Those exact files and their notes/checksum/receipt are preserved in
`release/history/unsigned-d611e156a`. The root now holds the signed `bd65c7737` Windows
installer, both finalized Mac DMGs, and both signed Mac updater archives. Every source and
staged asset hash was checked; the three updater signatures verify against the baked key.
`SHA256SUMS.txt` and `CANDIDATE-RECEIPT.json` now cover these five current assets. Test notes
describe the accepted compact single-line bay tags rather than the abandoned wrapping
behavior. The old unsigned `latest.json` was archived, with no root feed or public release
created. This reconciles local packaging; it does not change the installed executable.

## Desktop verification and limits

- Fresh StarNet fast gate: 729/729, exit zero; no desktop runtime code changed in this follow-through.
- ABILITIES opened in the real seeded app and passed eight instrumented capture cycles,
  four at normal CPU and four with only that test browser throttled 4x. Stable geometry and
  zero visible loaders were observed in 120–206 ms after the normal opening wait. The
  historical four-second timeout did not reproduce; no detector threshold or baseline changed.
- Both Mac updater archives were inspected directly. Their version is 0.11.0, bundle ID is
  `ai.skynet.harness`, and their signed executable carries hardened runtime and the true
  `com.apple.security.device.audio-input` entitlement. The entitlement's CodeDirectory hash
  and every executable code-page hash match. Both Info.plists contain the microphone purpose
  string. Updater signatures were separately verified against the baked public key.
- This direct inspection matters: the release-train workflow checks the signed microphone
  declaration, but the build-only workflow used for this candidate does not execute that
  particular assertion. Notarization alone was not substituted for the inspection.
- Owner said no physical Mac tester is available and requested proceeding from known evidence.
  The packaging fix is verified; physical capture, permission recovery and the affected Mac
  paid-account path are still unconfirmed. No hardware result was invented.

Local evidence is in the release worktree's `.bugloops/cloud-*`,
`.bugloops/privacy-*`, `.bugloops/abilities-diagnostic-receipt.json`, and
`release/MAC-MICROPHONE-BUNDLE-PROOF.json`. Source-fixed, installed behavior, and customer
recovery remain separate in the bug register. The historical QA P1 and eight customer/
activation P1 records are not automatically closed by these partial proofs.
