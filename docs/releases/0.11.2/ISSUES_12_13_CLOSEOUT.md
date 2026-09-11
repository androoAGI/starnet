# 0.11.2 customer fixes and installer closeout — September 11

GitHub #12 and #13 are repaired, integrated and verified in the installed bundle. The upgrade checks also exposed and drove a third repair: successful queued saves retained an obsolete browser revision, causing a false conflict after restart.

| Repair | Observed result |
| --- | --- |
| #12: saved provider fallback | Codex quota failure continues through the saved OpenRouter model using its own credential. Paid cost, dollar/token limits, restart, overrides and disconnected credentials pass. |
| #13: delegated MCP tools | Direct and delegated read/write pass, including restart, Ask approval, Full Access, denied writes and connector removal. Other autonomous effects gain no authority. |
| Queued save revision | Browser and server revisions agree after queued writes. The installed historical upgrade preserves the populated station across install and normal restart, with no false conflict. |

The real adapters and MCP transport run against controlled endpoints and isolated stations. These checks establish installed execution; they do not establish recovery on the reporters' actual Codex/OpenRouter or Close OAuth accounts. No issue comments, customer messages or public release were sent.

Pre-merge and post-merge gates passed **771 fast steps and 113 HTTP steps**. Integration source is `a6f05c505b4e1b75fafbb320f302ba9ebd21cd73`. The signed candidate source is `6e729e4cb2ca151f2ca7f280d500c86393bf0046`; subsequent changes are QA controllers, records and documentation, with no application-runtime difference.

[Build 34568119605](https://github.com/androoAGI/starnet/actions/runs/34568119605) passed all four platforms, both Mac notarizations and Intel installed acceptance. [Installer proof 34569801784](https://github.com/androoAGI/starnet/actions/runs/34569801784) passed fresh Windows install/launch, idle close, close-to-tray, the actual published 0.11.1 installer to candidate transition, normal restart and both customer regression suites using installed Node/sidecar bytes.

Windows installer SHA-256: `5baadbf8483e601db257f2b1ce8855fbc494add5db64493f501a3d93e717efeb`. Installed executable SHA-256: `28bca2f1196426eec6f4afaefa5a2f5b67cbafd3b354078e889c9d262ee87366`. The installer has a valid Andrew Sims signature. The continuity fixture preserves identity documents while allowing their derived prompt to regenerate and the existing composed-persona default to become explicit. Raw before/after states and earlier failed attempts remain in CI/local artifacts; the portable receipt records these comparison rules and original receipt hash.

Evidence: [verification and installer receipts](../../../qa/evidence/0.11.2-issues-12-13/).

## Update standing

Official pins remain 0.11.1. This is a private same-version NSIS upgrade candidate, not proof of a published automatic 0.11.2 feed. Release notes include the two customer repairs and save-restart fix. The owner's ordinary-soak waiver remains in force.

Eight earlier customer P1 reports remain open with the account/device evidence listed in [CUSTOMER_RETESTS.md](CUSTOMER_RETESTS.md). The final release freeze also needs current canonical readiness receipts and post-bump/public-artifact checks. No release-ready or bug-free claim is made, and no version bump, tag or publication was performed.
