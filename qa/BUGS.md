# QA bug register

**GENERATED — do not hand-edit.** Rebuild with `npm run qa:bugs:index`.
One tracked file per bug under `qa/bugs/`; this is only the index. File a new bug with
`node scripts/qa/bugs.mjs --new --title "..." --surface <surface>`.

**40** open (open+claimed) of 380 total — 0 P0 · 0 P1 · 40 P2

Engineering status is separate from delivery and customer recovery. Legacy rows without origin are not a customer census.

User/owner reports: **116** · source fixed: **99** · installer verified: **6** · customer confirmed: **1** · still reported failing: **5** · recovery unconfirmed: **110**.

| Report | Family | Source | Installer | Customer |
| --- | --- | --- | --- | --- |
| [Checkpoint maintenance bypass and orphan Git pack processes](bugs/8bdf73bb-checkpoint-maintenance-bypass-and-orphan-git-pac.md) | checkpoint-maintenance | fixed | unverified | unconfirmed |
| [Delegated specialist lacks connected MCP tools](bugs/acd9ecb4-delegated-specialist-lacks-connected-mcp-tools.md) | delegated-capabilities | fixed | verified | unconfirmed |
| [Customer reports an ONCE routine absent from Active Routines](bugs/c2a6c3c8-once-routine-reported-missing.md) | durability-and-visibility | fixed | unverified | unconfirmed |
| [Persisted E-STOP cannot be resumed from the desktop control](bugs/8f911536-persisted-e-stop-cannot-be-resumed-from-the-desk.md) | emergency-stop | fixed | unverified | unconfirmed |
| [Repeated promises without tool actions can end with done and no blocker explanation](bugs/b6f04205-repeated-promises-without-tool-actions-can-end-w.md) | premature-stops | fixed | unverified | unconfirmed |
| [Windows computer movement resolves to filesystem Move-Item](bugs/758185bc-windows-computer-movement-resolves-to-filesystem.md) | computer-movement | fixed | verified | unconfirmed |
| [Chat replies cut off without confirmed completion](bugs/812c3bfb-chat-replies-cut-off-without-confirmed-completio.md) | chat-response-completion | fixed | unverified | unconfirmed |
| [Connector stays up after an authenticated tool returns 401](bugs/9dc98fa0-connector-401-still-shows-up.md) | recovery-truth | fixed | unverified | unconfirmed |
| [Connector times out waiting for a buffered SSE reply](bugs/11341152-connector-buffered-sse-times-out.md) | protocol-lifecycle | fixed | unverified | unconfirmed |
| [Telegram-bound lead reports crew delegation unavailable](bugs/98454b83-telegram-lead-delegation-unavailable.md) | channel-delegation-parity | fixed | unverified | unconfirmed |
| [Erase Everything resurrects an acknowledged legacy station on restart](bugs/5451970e-erase-everything-resurrects-an-acknowledged-lega.md) | erase-recovery-authority | fixed | unverified | unconfirmed |
| [Google account connection asks customers for developer credentials](bugs/e5d4b743-google-account-connection-asks-customers-for-dev.md) | google-sign-in | fixed | unverified | unconfirmed |
| [Mac paid onboarding becomes unreachable after reload and relink](bugs/eaaa3ec8-mac-onboarding-unreachable-after-link.md) | recovery-truth | fixed | unverified | unconfirmed |
| [Older Mac WebKit cannot initialize Chat and widget polling](bugs/5308fc67-older-mac-webkit-cannot-initialize-chat-and-widg.md) | boot-integrity | fixed | unverified | unconfirmed |
| [Stored OpenAI API key silently outranks a live ChatGPT sign-in at Wake](bugs/f46a1875-stored-openai-api-key-silently-outranks-a-live-c.md) | genesis-provider-credential-selection | fixed | unverified | unconfirmed |
| [Unlink failures silently hide account recovery controls](bugs/99a1517b-unlink-failures-silently-hide-account-recovery-c.md) | recovery-truth | fixed | unverified | unconfirmed |
| [Wake mistakes DEV configuration for an OpenAI API credential](bugs/32f959e0-wake-mistakes-dev-configuration-for-an-openai-ap.md) | genesis-provider-credential-selection | fixed | unverified | unconfirmed |
| [Valid BYOK wake is blocked by an empty managed wallet](bugs/2b6d70fb-byok-blocked-by-empty-managed-wallet.md) | execution-configuration | fixed | unverified | unconfirmed |
| [Casual replies continue after the local output ceiling](bugs/2e6344fc-casual-replies-continue-after-the-local-output-c.md) | response-latency | fixed | unverified | unconfirmed |
| [Live Doctor overrides selected model reasoning with none](bugs/2a9cb952-doctor-forces-unsupported-reasoning.md) | execution-configuration | fixed | unverified | unconfirmed |
| [Follow station default retains managed model pin and blocks BYOK delegation](bugs/0e3d3914-follow-station-default-retains-managed-model-pin.md) | execution-configuration | fixed | unverified | unconfirmed |
| [Funded working station still displays a zero-credit warning](bugs/72af29f4-funded-station-false-zero-warning.md) | recovery-truth | fixed | unverified | unconfirmed |
| [Gemini rejects the turn after a tool call loses its signature](bugs/0d63e5d1-gemini-loses-tool-signature.md) | tool-history | fixed | unverified | unconfirmed |
| [Linked StarNet credits cannot authorize image generation](bugs/a9374d2c-linked-starnet-credits-cannot-authorize-image-ge.md) | managed-media | fixed | unverified | unconfirmed |
| [Linked account warning confuses provider quota with disconnection](bugs/6c54d22e-linked-state-confused-with-quota.md) | recovery-truth | fixed | unverified | unconfirmed |
| [Local model small talk carries excessive context and produces prolonged replies](bugs/a76b93c4-local-model-small-talk-overload.md) | local-model-conversation-latency | fixed | unverified | unconfirmed |
| [Managed chat can use a stale request endpoint](bugs/3195ab5a-managed-chat-can-use-a-stale-request-endpoint.md) | managed-routing | fixed | unverified | unconfirmed |
| [Managed model selection retains the wrong provider identity](bugs/7ed4a93c-managed-selection-keeps-wrong-provider.md) | catalog-truth | fixed | unverified | unconfirmed |
| [Ollama strict templates reject late host system messages](bugs/4a1447ff-ollama-strict-templates-reject-late-host-system.md) | local-provider-system-projection | fixed | unverified | unconfirmed |
| [Routed OpenRouter conversation fails on orphan tool results](bugs/112199f5-openrouter-orphan-tool-results.md) | tool-history | fixed | unverified | unconfirmed |
| [Ordinary wording incorrectly requires image generation](bugs/b0431c24-ordinary-wording-incorrectly-requires-image-gene.md) | image-intent | fixed | unverified | unconfirmed |
| [Doctor works but sample ignores the saved provider](bugs/c978e7b7-sample-ignores-saved-provider.md) | execution-configuration | fixed | unverified | unconfirmed |
| [Saved equipment omitted from interactive tool projection and toolset diagnostics](bugs/432df352-saved-equipment-omitted-from-interactive-tool-pr.md) | capability-projection | fixed | unverified | unconfirmed |
| [Saved fallback changes model without switching provider](bugs/8b22d414-saved-fallback-changes-model-without-switching-p.md) | provider-fallback | fixed | verified | unconfirmed |
| [Tier picker reports available managed models missing](bugs/ddea3c5d-tiers-ignore-managed-catalog.md) | catalog-truth | fixed | unverified | unconfirmed |
| [Unavailable spend history blocks work without usable recovery](bugs/d688ea20-unavailable-spend-history-blocks-work-without-us.md) | spend-history-blocking | fixed | unverified | persists |
| [Desktop bundle drops required calibration texture and disables graphical refresh](bugs/4a108286-desktop-bundle-drops-required-calibration-textur.md) | packaged-runtime-asset-closure | fixed | unverified | unconfirmed |
| [File approval hides the proposed edit and patch payload](bugs/48c51661-file-approval-omits-mutation.md) | informed-approval | fixed | unverified | unconfirmed |
| [Shell approvals and history hide full command arguments](bugs/082ee8e5-shell-approvals-and-history-hide-full-command-ar.md) | shell-consent-history-visibility | fixed | unverified | unconfirmed |
| [Add agents silently fails when group backend is unavailable](bugs/0245a284-add-agents-silently-fails-when-group-backend-is.md) | group-chat-picker | fixed | unverified | unconfirmed |
| [Agent session focus commands can unexpectedly retarget the composer](bugs/774641dc-agent-session-focus-commands-can-unexpectedly-re.md) | session-focus | fixed | unverified | unconfirmed |
| [Feedback cards do not identify the run being rated](bugs/c7fa86fc-feedback-run-reference-ambiguous.md) | feedback-attribution | fixed | unverified | unconfirmed |
| [Interactive replies in scheduled conversations cannot be rated](bugs/09f0e9fa-interactive-replies-in-scheduled-conversations-c.md) | work-rating-origin | fixed | unverified | unconfirmed |
| [Preference corrections are discarded or leave contradictory memories active](bugs/f97e73fb-preference-corrections-are-discarded-or-leave-co.md) | memory-corrections | fixed | unverified | unconfirmed |
| [Projects overview remains loading after a valid nonempty response](bugs/25120f27-projects-overview-remains-loading-after-a-valid.md) | projects-rendering | fixed | unverified | unconfirmed |
| [Reopened conversations send before history is restored and hide late messages](bugs/2426399e-reopened-conversations-send-before-history-is-re.md) | session-continuity | fixed | unverified | unconfirmed |
| [Saved file links disappear when conversation history is restored](bugs/253e5a8e-saved-file-links-disappear-when-conversation-his.md) | deliverable-history-replay | fixed | unverified | unconfirmed |
| [Sent group attachments appear only in the shared shelf](bugs/de0bb232-sent-group-attachments-appear-only-in-the-shared.md) | message-attachments | fixed | unverified | unconfirmed |
| [Approved skill is withheld from autonomous workers](bugs/f702f2f6-approved-skill-is-withheld-from-autonomous-worke.md) | skill-approval-worker | fixed | unverified | persists |
| [Campaign cards missing from browser element discovery](bugs/305a9e3d-campaign-cards-missing-from-browser-element-disc.md) | browser-card-discovery | fixed | unverified | unconfirmed |
| [Live spoken replies stall after the output audio context closes](bugs/3364dfb0-live-spoken-replies-stall-after-the-output-audio.md) | speech-device-recovery | fixed | unverified | unconfirmed |
| [Mac desktop microphone blocked while browser mirror works](bugs/8a553481-mac-desktop-microphone-blocked-while-browser-mir.md) | desktop-microphone | fixed | unverified | unconfirmed |
| [Spoken replies fragment at punctuation and omit failed audio chunks](bugs/e1051446-spoken-replies-fragment-at-punctuation-and-omit.md) | voice-continuity | fixed | unverified | unconfirmed |
| [Agents cross walls beside hallway openings](bugs/49192a68-agents-cross-walls-beside-hallway-openings.md) | doorway-movement | fixed | unverified | unconfirmed |
| [Approved agent sprites remain behind preview switch in normal desktop](bugs/84e26970-approved-agent-sprites-remain-behind-preview-swi.md) | production-skin-activation | fixed | unverified | unconfirmed |
| [Bay names are unreadable at normal station zoom](bugs/0ff9dfc6-bay-names-are-unreadable-at-normal-station-zoom.md) | bay-labels | fixed | verified | confirmed |
| [GPU loss replaces authored props with legacy art and disables floor recovery](bugs/0db3e69c-gpu-loss-replaces-authored-props-with-legacy-art.md) | local-memory-graphics-recovery | fixed | unverified | unconfirmed |
| [New backdrops stall switching and zoomed-out terrain rendering](bugs/04ca4207-new-backdrops-stall-switching-and-zoomed-out-ter.md) | backdrop-performance | fixed | verified | unconfirmed |
| [Refit entry freezes the installed remastered station for roughly ten seconds](bugs/bf3be27e-refit-entry-freezes-the-installed-remastered-sta.md) | refit-entry-rendering | fixed | unverified | unconfirmed |
| [Station design edits disappear when Build is interrupted](bugs/996e399b-station-design-edits-disappear-when-build-is-int.md) | station-design-persistence | fixed | unverified | unconfirmed |
| [Customer viewport becomes blank after ten to twenty minutes](bugs/9256a771-viewport-black-after-idle.md) | durability-and-visibility | fixed | unverified | unconfirmed |
| [Website station preview fails when hosting beacon is blocked](bugs/b3b8d28f-website-station-preview-fails-when-hosting-beaco.md) | deployment-integrity | fixed | not-applicable | unconfirmed |
| [Mac boot guard reports shared specialty catalog load failure](bugs/2f156837-mac-boot-guard-reports-shared-specialty-catalog.md) | boot-integrity | wontfix | unverified | unconfirmed |
| [Customer requests accounting for credits consumed during Mac boot trouble](bugs/abd75bb4-credit-usage-during-mac-boot-failure.md) | account-usage-correlation | open | unverified | unconfirmed |
| [Customer cannot explain idle behavior and unexpectedly high usage](bugs/acb47320-idle-usage-customer-unexplained.md) | work-and-spend-truth | open | unverified | unconfirmed |
| [Repeated project verification reportedly consumes overnight budget](bugs/f8d479d9-repeated-project-verification-reportedly-consume.md) | autonomous-completion-and-cost | open | unverified | unconfirmed |
| [Zoho Mail bootstrap tool reportedly requires undiscoverable account](bugs/54564ff9-zoho-mail-bootstrap-tool-reportedly-requires-und.md) | connector-schema-projection | open | unverified | unconfirmed |
| [Google Drive authorization is hard blocked for a fresh personal account](bugs/f2ac6356-google-drive-authorization-is-hard-blocked-for-a.md) | google-drive-oauth-block | open | unverified | unconfirmed |
| [Customer reports unusable visibility without build or platform details](bugs/6bb9d2a1-visibility-failure-without-diagnostics.md) | uncorrelated-visibility | open | unverified | unconfirmed |
| [Connector sign-in is lost after credential-store recovery](bugs/e7b2ffcd-connector-sign-in-is-lost-after-credential-store.md) | connector-credential-persistence | open | unverified | persists |
| [Funded account runs fail again after a credit-limit workaround](bugs/a5060cc3-funded-account-runs-fail-again-after-a-credit-li.md) | funded-account-run-refusal | open | unverified | persists |
| [Managed Sonnet request still returns an uncorrelated HTTP 400](bugs/fd9c4b4d-managed-sonnet-400-unresolved.md) | production-request-truth | open | unverified | persists |
| [Ollama run times out with no chat POST observed by reporter](bugs/5274c7b7-ollama-chat-request-not-observed.md) | local-provider-transport | open | unverified | unconfirmed |
| [Reported macOS web fetch TLS decode and socket failures](bugs/1d3ac09a-reported-macos-web-fetch-tls-decode-and-socket-f.md) | outbound-transport | open | unverified | unconfirmed |
| [Mac installer reports application unsupported on the computer](bugs/ff3fb4cb-mac-unsupported-installation-uncorrelated.md) | mac-install-compatibility | open | unverified | unconfirmed |
| [Windows 0.13.2 startup fails loading a packaged backend module](bugs/85f602c4-windows-0132-packaged-backend-startup.md) | packaged-backend-integrity | open | unverified | unconfirmed |
| [Execution history shows a shortened shell command instead of the full redacted command](bugs/9f908b02-execution-history-shows-a-shortened-shell-comman.md) | shell-consent-history-visibility | open | unverified | unconfirmed |
| [Saved station opening is blocked despite a reachable engine](bugs/4c0efd8c-saved-station-opening-is-blocked-despite-a-reach.md) | saved-station-load | open | unverified | unconfirmed |
| [Deliverable naming instruction conflicts with explicit stop limits](bugs/5a35bcfe-deliverable-note-overrides-stop.md) | task-scope | fixed | unverified | unconfirmed |
| [Paused routines falsely keep an idle desktop armed](bugs/ce430c35-paused-routines-falsely-keep-an-idle-desktop-arm.md) | lifecycle-truth | fixed | verified | unconfirmed |
| [Dense service cards squeeze technical prose into tiny columns](bugs/734b469e-dense-service-cards-squeeze-technical-prose-into.md) | record-readability | fixed | unverified | unconfirmed |
| [Station button redesign escaped the bottom navigation](bugs/d28ba8f4-station-button-redesign-escaped-the-bottom-navig.md) | dock-style-scope | fixed | unverified | unconfirmed |
| [Onboarding sign-in codes have dark text on dark backgrounds](bugs/c9929ae3-onboarding-sign-in-codes-have-dark-text-on-dark.md) | onboarding-code-contrast | fixed | unverified | unconfirmed |
| [Ollama task runs finish without reported filesystem tool calls](bugs/678ac951-ollama-task-runs-finish-without-reported-filesys.md) | local-provider-tool-projection | fixed | unverified | unconfirmed |
| [OpenAI image model is routed through a chat completion path](bugs/6c6c34e1-openai-image-model-selected-for-comms.md) | image-versus-chat-routing | fixed | unverified | unconfirmed |
| [Provider card status alignment and dated identity artwork](bugs/4a151231-provider-card-status-alignment-and-dated-identit.md) | provider-settings-presentation | fixed | unverified | unconfirmed |
| [Run metadata invalidates reusable prompt cache and unused fallback authentication delays primary requests](bugs/c9201c15-run-metadata-invalidates-reusable-prompt-cache-a.md) | response-latency | fixed | unverified | unconfirmed |
| [Secondary console layouts lose provider text and dropdown affordances at enlarged scale](bugs/6c91f5d9-secondary-console-layouts-lose-provider-text-and.md) | secondary-console-polish | fixed | unverified | unconfirmed |
| [Mac receipt test fails when Python is missing](bugs/046bd4a1-mac-receipt-test-fails-when-python-is-missing.md) | test-portability | fixed | not-applicable | unconfirmed |
| [Browser upload resolves wrong project file and claims success without selection proof](bugs/d9a3499f-browser-upload-resolves-wrong-project-file-and-c.md) | browser-upload-selection-truth | fixed | unverified | unconfirmed |
| [Agent work rating fails with a generic not saved message](bugs/1fc69e6a-agent-work-rating-fails-with-a-generic-not-saved.md) | work-rating | fixed | unverified | unconfirmed |
| [COMMS starters suggest arbitrary tasks and lose session context](bugs/e84d1dfd-comms-starters-suggest-arbitrary-tasks-and-lose.md) | session-starters | fixed | unverified | unconfirmed |
| [Context extraction card uses a flat surface outside the current theme](bugs/b87dbc17-context-extraction-card-uses-a-flat-surface-outs.md) | context-presentation | fixed | unverified | unconfirmed |
| [Conversation crowded on short laptop windows](bugs/9f67d884-conversation-crowded-on-short-laptop-windows.md) | responsive-comms | fixed | unverified | unconfirmed |
| [Earned XP appears frozen or misses ratings from another window](bugs/6ad254f9-earned-xp-appears-frozen-or-misses-ratings-from.md) | work-rating | fixed | unverified | unconfirmed |
| [Failed session repeats FAILED badge and leaves X steady](bugs/d07d3a35-failed-session-repeats-failed-badge-and-leaves-x.md) | session-status-presentation | fixed | unverified | unconfirmed |
| [Files dropped onto chat do not attach in the desktop app](bugs/b48aa05d-files-dropped-onto-chat-do-not-attach-in-the-des.md) | message-attachments | fixed | unverified | unconfirmed |
| [Session recommendations ignore user goals and actual work](bugs/a55c0020-session-recommendations-ignore-user-goals-and-ac.md) | session-starters | fixed | unverified | unconfirmed |
| [Removed skill support files reappear during hydration](bugs/3e79b690-removed-skill-support-files-reappear-during-hydr.md) | skill-package-removal | fixed | unverified | unconfirmed |
| [Agent look-back flicker and waypoint stutter](bugs/e356ce13-agent-look-back-flicker-and-waypoint-stutter.md) | movement-continuity | fixed | unverified | unconfirmed |
| [Centered room lighting leaves sides dark and creates hotspots](bugs/741832d8-centered-room-lighting-leaves-sides-dark-and-cre.md) | room-lighting | fixed | unverified | unconfirmed |
| [Chat numbered lists have excessive vertical spacing](bugs/a9862eb0-chat-numbered-lists-have-excessive-vertical-spac.md) | chat-markdown-spacing | fixed | unverified | unconfirmed |
| [CRT curve displaces agent hover and click targets away from center](bugs/26433ecb-crt-curve-displaces-agent-hover-and-click-target.md) | world-pointer | fixed | unverified | unconfirmed |
| [Custom phosphor theme desaturates approved room lighting](bugs/850fdcfa-custom-phosphor-theme-desaturates-approved-room.md) | room-lighting | fixed | unverified | unconfirmed |
| [Prop details crowd out the build catalog at larger UI scales](bugs/e1d9f470-prop-details-crowd-out-the-build-catalog-at-larg.md) | prop-catalog-layout | fixed | unverified | unconfirmed |
| [Quest log tiny text and undifferentiated card grid](bugs/74be01cc-quest-log-tiny-text-and-undifferentiated-card-gr.md) | quest-journal | fixed | unverified | unconfirmed |
| [Raised room corners excluded from interior lighting](bugs/52397fc0-raised-room-corners-excluded-from-interior-light.md) | room-lighting | fixed | unverified | unconfirmed |
| [Recipe Bay deep shelf collapses initial cards into slivers](bugs/8ac0662a-recipe-bay-deep-shelf-collapses-initial-cards-in.md) | recipe-layout | fixed | unverified | unconfirmed |
| [Refit object placement stalls while rebaking unchanged environment](bugs/e725e614-refit-object-placement-stalls-while-rebaking-unc.md) | refit-placement-performance | fixed | unverified | unconfirmed |
| [Remastered prop selection outlines include transparent packing](bugs/30c44acc-remastered-prop-selection-outlines-include-trans.md) | prop-selection | fixed | unverified | unconfirmed |
| [Roaming agents jam nose to nose in narrow hallways](bugs/2b7a920c-roaming-agents-jam-nose-to-nose-in-narrow-hallwa.md) | hallway-traffic | fixed | unverified | unconfirmed |
| [Room fixture grids flood edges and corners](bugs/b8594ab9-room-fixture-grids-flood-edges-and-corners.md) | room-lighting | fixed | unverified | unconfirmed |
| [Room lighting loses colour and flickers across the floor](bugs/3365f5ba-room-lighting-loses-colour-and-flickers-across-t.md) | room-lighting | fixed | unverified | unconfirmed |
| [Standard text size leaves everyday controls and labels hard to read](bugs/96921b22-standard-text-size-leaves-everyday-controls-and.md) | standard-readability | fixed | unverified | unconfirmed |
| [Website preview applies retired rendering effects and implies live work](bugs/d0904df1-website-preview-applies-retired-rendering-effect.md) | website-preview | fixed | not-applicable | unconfirmed |
| [Product Line Workbench access differs from a direct interactive run](bugs/4a19c050-product-line-workbench-standing-grant-scope.md) | unattended-workbench-policy | wontfix | unverified | unconfirmed |

| Sev | Status | Surface | Bug | Lane | Fix |
| --- | --- | --- | --- | --- | --- |
| P0 | fixed | autonomy | [After E-STOP the ROUTINES panel still renders "● scheduler armed — routines fire automatically" plus a live countdown; GET /api/cron's `halted` field has zero c](bugs/4962c3ad-after-e-stop-the-routines-panel-still-renders-sc.md) | sweep/autonomy | b7e18ce8 |
| P0 | fixed | onboarding | [Only the skip CHIP is recognized as a skip — the typed word the interview invites ("skip") is stored as a weight:'stated' belief, raising FAMILIARITY, opening t](bugs/e62959ca-only-the-skip-chip-is-recognized-as-a-skip.md) | sweep/onboarding | 6afeb9ee |
| P0 | fixed | providers | [The KEYS-tab UNATTENDED grant is enforced only at web_request — servicekeys.runEnv() has no surface argument, so an unattended shell child receives every ENABLE](bugs/14d4f234-the-keys-tab-unattended-grant-is-enforced-only-a.md) | sweep/providers | 6afeb9ee |
| P0 | fixed | release | [Forward-version gate asserts "no newer build is published yet" for EVERY non-'available' phase — including check 'error' and the busy short-circuit — and the 'u](bugs/9c0664eb-forward-version-gate-asserts-no-newer-build-is-p.md) | sweep/release | 6afeb9ee |
| P0 | fixed | safecell | [The Permissions panel's normalizeGrants regex drops every path: and mcp: standing grant — the ledger prints "No standing approvals yet" while the backend holds](bugs/7274ff21-the-permissions-panel-s-normalizegrants-regex-dr.md) | sweep/safecell | 6afeb9ee |
| P0 | fixed | sessions | [An attachment-bearing user turn is dropped from the durable transcript and the PREVIOUS turn is written in its place — the string-only scan at index.js:11299 fa](bugs/e7dcb889-an-attachment-bearing-user-turn-is-dropped-from.md) | sweep/sessions | 6afeb9ee |
| P0 | fixed | skills | [skill.view's hydrate-then-bump stores the RENDERED SKILL.md as the skill's body, so every view→persist cycle re-appends '## Setup' and '## Support Files' — unbo](bugs/c70f8965-skill-view-s-hydrate-then-bump-stores-the-render.md) | sweep/skills | 598ab4a4 |
| P1 | fixed | autonomy | [A routine run killed between fire and settlement leaves the routine reporting the previous run's ok and absent from its own history](bugs/0de13603-a-routine-run-killed-between-fire-and-settlement.md) | sweep/autonomy | 124feb5b0 |
| P1 | fixed | autonomy | [Agent loop pause leaves cancelled iteration running and lease held](bugs/c66e8c39-agent-loop-pause-leaves-cancelled-iteration-runn.md) | agent/seam-audit-0912-b | b5c5cba75 |
| P1 | fixed | autonomy | [Ambiguous permission and routine acknowledgements report unproven changes](bugs/95d13aaf-ambiguous-permission-and-routine-acknowledgement.md) | agent/systemic-bugs-0919 | 8eb87b0d3 |
| P1 | fixed | autonomy | [An E-STOP mid night-shift beat records the partial stream as a delivered draft](bugs/778080b7-an-e-stop-mid-night-shift-beat-records-the-parti.md) | sweep/autonomy | 4fc2117d7 |
| P1 | fixed | autonomy | [Approving a newer loop candidate before the older one it was built on breaks the rejection cascade](bugs/0582c793-approving-a-newer-loop-candidate-before-the-olde.md) | sweep/autonomy | d0003aa49 |
| P1 | fixed | autonomy | [Autonomy controls claim unconfirmed settings and overwrite server state on reload](bugs/b0349a7c-autonomy-controls-claim-unconfirmed-settings-and.md) | agent/system-polish-0920 | 4a2028759 |
| P1 | fixed | autonomy | [Checkpoint maintenance bypass and orphan Git pack processes](bugs/8bdf73bb-checkpoint-maintenance-bypass-and-orphan-git-pac.md) | issue-triage-1011 | 7680f00da |
| P1 | fixed | autonomy | [Chosen away autonomy waits for runs or dossier areas before acting (usage unlock on the onboarding path)](bugs/41b2d015-chosen-away-autonomy-waits-for-runs-or-dossier-a.md) | sweep/onboarding | 2a2596397 |
| P1 | fixed | autonomy | [Concurrency-limited routines starve later due jobs in store order](bugs/0cfef8af-concurrency-limited-routines-starve-later-due-jo.md) | reliability-audit-0919 | b651a8f5d |
| P1 | fixed | autonomy | [Conveyor SHIPPED counts stages and changes with floor edits](bugs/2d0597b0-conveyor-shipped-counts-stages-and-changes-with.md) | agent/conveyor-stats-1012 | c342c7ae7 |
| P1 | fixed | autonomy | [Crew directives promote negation and upstream data to owner intent](bugs/5929d898-crew-directives-promote-negation-and-upstream-da.md) | agent/provider-triage-1011 | 4ecafe317790da208051f43515e322a044f43401 |
| P1 | fixed | autonomy | [cron-store's armAt never receives the host defaultTz, so a tz-less cron routine's FIRST nextRunAt is UTC-anchored while every later advance uses local — the mar](bugs/f47a1e3a-cron-store-s-armat-never-receives-the-host-defau.md) | sweep/autonomy | 226cec3c |
| P1 | fixed | autonomy | [Cron writes bypass a live lock after contention](bugs/0506aabf-cron-writes-bypass-a-live-lock-after-contention.md) | agent/cron-reliability-0921 | 0f881f44afde73e79de13f0117cf0dd9f2771ff9 |
| P1 | fixed | autonomy | [Delegated specialist lacks connected MCP tools](bugs/acd9ecb4-delegated-specialist-lacks-connected-mcp-tools.md) | release-0112-finalprep-0911 | 44c6b4952cd1e468f7caaf4d7ead804dc280cc40 |
| P1 | fixed | autonomy | [Exhausted line daily cap permits another entry run](bugs/f60170b7-exhausted-line-daily-cap-permits-another-entry-r.md) | conveyor-finish-1012 | 43e48a086 |
| P1 | fixed | autonomy | [Failed scheduled routines rearm in UTC instead of host timezone](bugs/cdb44116-failed-scheduled-routines-rearm-in-utc-instead-o.md) | agent/cron-reliability-0921 | 0f881f44afde73e79de13f0117cf0dd9f2771ff9 |
| P1 | fixed | autonomy | [Idle empty quest slate re-buys a paid planning call every hour](bugs/d986f0a1-idle-empty-quest-slate-re-buys-a-paid-planning-c.md) | sweep/autonomy | cba0e52f5 |
| P1 | fixed | autonomy | [Late cancelled loop settlement strands the resumed iteration](bugs/24b375c9-late-cancelled-loop-settlement-strands-the-resum.md) | release-blockers-0907 | 035513a6d |
| P1 | fixed | autonomy | [Concurrent loop approval can retain an approved verdict after rejection reverts the files](bugs/bb24585f-loop-approve-reject-race.md) | agent/adversarial-audit-0910 | 64ed8711b |
| P1 | fixed | autonomy | [Customer reports an ONCE routine absent from Active Routines](bugs/c2a6c3c8-once-routine-reported-missing.md) | reliability-followup | 2b976f5f3df07473b2df8963690421f83ce0a45f |
| P1 | fixed | autonomy | [Persisted E-STOP cannot be resumed from the desktop control](bugs/8f911536-persisted-e-stop-cannot-be-resumed-from-the-desk.md) | estop-recovery-0907 | acdf5160c |
| P1 | fixed | autonomy | [Persisted interest cache promotes activity without independent trusted evidence](bugs/31042fab-persisted-interest-cache-loses-evidence-provenance.md) | agent/memory-harness-audit-1011 | 6421e4c857a6f885d0c437e9e4d01168f92ba7db |
| P1 | fixed | autonomy | [Repeat-work evidence attributes untrusted or duplicate task briefs to the owner](bugs/2b0d8101-repeat-work-attributes-untrusted-briefs-to-owner.md) | agent/memory-harness-audit-1011 | 6421e4c857a6f885d0c437e9e4d01168f92ba7db |
| P1 | fixed | autonomy | [Repeated promises without tool actions can end with done and no blocker explanation](bugs/b6f04205-repeated-promises-without-tool-actions-can-end-w.md) | agent/recall-report-0916 | 46c929a88 |
| P1 | fixed | autonomy | [Result contracts reject useful constraints and API JSON formats are ignored](bugs/bc59eefe-result-contracts-reject-useful-constraints-and-a.md) | hermes-stress-0910 | 61eeac2b40c9fd0e2e0a5d2b342f44de74119078 |
| P1 | fixed | autonomy | [Routine delivery receipts are overwritten and only recovered at boot](bugs/e0a49891-routine-delivery-receipts-are-overwritten-and-on.md) | agent/cron-reliability-0921 | 0f881f44afde73e79de13f0117cf0dd9f2771ff9 |
| P1 | fixed | autonomy | [Routine follow-up checkbox saves an unusable session origin](bugs/962032ba-routine-follow-up-checkbox-saves-an-unusable-ses.md) | agent/seam-audit-0912-b | b5c5cba75 |
| P1 | fixed | autonomy | [SEND TO loses producing workspace for relative file artifacts](bugs/cc760146-send-to-loses-producing-workspace-for-relative-f.md) | agent/session-handoff-1011 | 1428c8b11 |
| P1 | fixed | autonomy | [Stale routine recovery drops its fence before failure persistence](bugs/50741e0d-stale-routine-recovery-drops-its-fence-before-fa.md) | agent/cron-reliability-0921 | 0f881f44afde73e79de13f0117cf0dd9f2771ff9 |
| P1 | fixed | autonomy | [The away-workshop card counts down to its next shift while scheduling is OFF or E-STOPped](bugs/a8f9ad8b-the-away-workshop-card-counts-down-to-its-next-s.md) | sweep/autonomy | c6b725e8f |
| P1 | fixed | autonomy | [Windows computer movement resolves to filesystem Move-Item](bugs/758185bc-windows-computer-movement-resolves-to-filesystem.md) | computer-move-proof-0911 | dd85573b9 |
| P1 | fixed | channels | [A lost-race consent tap stamps "▸ ✅ Allow once" onto the message before resolveConsent is asked, so a DENIED request keeps a permanent "approved" record](bugs/64563ad9-a-lost-race-consent-tap-stamps-allow-once-onto-t.md) | sweep/channels | 96fe108d |
| P1 | fixed | channels | [A routine's reply longer than Telegram's 4096 characters is sent as one message, refused 'message is too long' on every retry, and never reaches the chat](bugs/3a9d5e4a-a-routine-s-reply-longer-than-telegram-s-4096-ch.md) | sweep/channels | 9af08a5a0 |
| P1 | fixed | channels | [A sidecar crash mid-run replays the whole Telegram message as a second identical user turn, so side effects run twice and the reply undercounts them](bugs/e5ecd6b8-a-sidecar-crash-mid-run-replays-the-whole-telegr.md) | sweep/channels | 254ebe0e0 |
| P1 | fixed | channels | [A Telegram consent ask allowed from STARNET REMOTE is stamped 'expired — DENIED' by a late tap on the still-live keyboard](bugs/9e60dd9f-a-telegram-consent-ask-allowed-from-starnet-remo.md) | sweep/channels | 0fcbbd42d |
| P1 | fixed | channels | [`channel.targets` derives "reachable now" from the adapter handle's existence, so an errored (or still-connecting) channel is reported connected while telegramS](bugs/a199ee3c-channel-targets-derives-reachable-now-from-the-a.md) | sweep/channels | 96fe108d |
| P1 | fixed | channels | [Chat replies cut off without confirmed completion](bugs/812c3bfb-chat-replies-cut-off-without-confirmed-completio.md) | agent/chat-cutoff-0919 | 93a4ee64c |
| P1 | fixed | channels | [Connector stays up after an authenticated tool returns 401](bugs/9dc98fa0-connector-401-still-shows-up.md) | reliability-followup | 6adda1348 |
| P1 | fixed | channels | [Connector times out waiting for a buffered SSE reply](bugs/11341152-connector-buffered-sse-times-out.md) | reliability-followup | 6adda1348 |
| P1 | fixed | channels | [Every message sent while a channel task is running is processed twice: inbox recovery replays a follow-up that already finished while it waited](bugs/5ce67a6f-every-message-sent-while-a-channel-task-is-runni.md) | sweep/channels | 2899b4102 |
| P1 | fixed | channels | [Invalid connector JSON null replaces encrypted recovery credentials at startup](bugs/0428b50d-invalid-connector-json-null-replaces-encrypted-r.md) | release-audit-0124-0920 | 42ad5937f |
| P1 | fixed | channels | [/new on Telegram says 'I no longer remember what we discussed' while the next run replays up to 100 turns of the old chat, taint included](bugs/956fdecf-new-on-telegram-says-i-no-longer-remember-what-w.md) | sweep/channels | 5b934e4e2 |
| P1 | fixed | channels | [Telegram-bound lead reports crew delegation unavailable](bugs/98454b83-telegram-lead-delegation-unavailable.md) | release-0120-prep-0915 | 887210a7b |
| P1 | fixed | onboarding | [Erase Everything resurrects an acknowledged legacy station on restart](bugs/5451970e-erase-everything-resurrects-an-acknowledged-lega.md) | agent/runtime-triage-1011 | 553cfa55d45afca1b588cb0b82219d6bb5673cab |
| P1 | fixed | onboarding | [Failed remote save adoption falls through to first-run onboarding](bugs/25de9a74-failed-remote-save-adoption-falls-through-to-fir.md) | reliability-audit-0919 | d9b6fba04 |
| P1 | fixed | onboarding | [Google account connection asks customers for developer credentials](bugs/e5d4b743-google-account-connection-asks-customers-for-dev.md) | agent/google-account-signin | cb8385c56 |
| P1 | fixed | onboarding | [Mac paid onboarding becomes unreachable after reload and relink](bugs/eaaa3ec8-mac-onboarding-unreachable-after-link.md) | reliability-followup | c364e991d8d9c0c4d446c9978b8d31c33fcbe09d |
| P1 | fixed | onboarding | [Older Mac WebKit cannot initialize Chat and widget polling](bugs/5308fc67-older-mac-webkit-cannot-initialize-chat-and-widg.md) | mac-boot-compat-0918 | 14c6a69a8 |
| P1 | fixed | onboarding | [Stored OpenAI API key silently outranks a live ChatGPT sign-in at Wake](bugs/f46a1875-stored-openai-api-key-silently-outranks-a-live-c.md) | agent/codex-wins-wake | f7e050e6f |
| P1 | fixed | onboarding | [Unlink failures silently hide account recovery controls](bugs/99a1517b-unlink-failures-silently-hide-account-recovery-c.md) | credits-unlink-recovery | 02332ee85 |
| P1 | fixed | onboarding | [Unreadable station save is reported empty and its sole backup can be eclipsed](bugs/34c58f4f-unreadable-station-save-is-reported-empty-and-it.md) | reliability-audit-0919 | d9b6fba04 |
| P1 | fixed | onboarding | [Wake mistakes DEV configuration for an OpenAI API credential](bugs/32f959e0-wake-mistakes-dev-configuration-for-an-openai-ap.md) | onboarding-conversation-0912 | 0250793ac |
| P1 | fixed | providers | [A provider 403 that says Forbidden tells the Commander the station restarted](bugs/38da5ee4-a-provider-403-that-says-forbidden-tells-the-com.md) | sweep/providers | 613beeac9 |
| P1 | fixed | providers | [An unpriced run is booked and shown as a proven zero-dollar metered run](bugs/237b40d3-an-unpriced-run-is-booked-and-shown-as-a-proven.md) | sweep/providers | 3c53fa524 |
| P1 | fixed | providers | [Valid BYOK wake is blocked by an empty managed wallet](bugs/2b6d70fb-byok-blocked-by-empty-managed-wallet.md) | reliability-followup | 5b5f50a1d |
| P1 | fixed | providers | [Casual replies continue after the local output ceiling](bugs/2e6344fc-casual-replies-continue-after-the-local-output-c.md) | agent/response-audit-0915-7c2a | fc4c9e0f415251870778da1405086c421aff0670 |
| P1 | fixed | providers | [Claude continuation reminders can become rejected assistant prefill](bugs/d81c4e15-claude-continuation-reminders-can-become-rejecte.md) | agent/release-0112-audit-0910 | 9441660d0 |
| P1 | fixed | providers | [Compatible API hides partial run failures and limits](bugs/ecd235e6-compatible-api-hides-partial-run-failures-and-li.md) | hermes-stress-0910 | f952835ab7e078d0f9dae490cbb52e7b9c8cc29f |
| P1 | fixed | providers | [Compatible API retries dispatch duplicate agent runs](bugs/8d0e29aa-compatible-api-retries-dispatch-duplicate-agent.md) | hermes-stress-0910 | 4d5ee74c170330c977c766f6be200ffb4313f95c |
| P1 | fixed | providers | [Live Doctor overrides selected model reasoning with none](bugs/2a9cb952-doctor-forces-unsupported-reasoning.md) | report-0110-0908 | 72a8a3043c263cd53ed353daed2042e256c8e236 |
| P1 | fixed | providers | [Follow station default retains managed model pin and blocks BYOK delegation](bugs/0e3d3914-follow-station-default-retains-managed-model-pin.md) | openrouter-delegation-0920 | 13a83534b |
| P1 | fixed | providers | [Funded working station still displays a zero-credit warning](bugs/72af29f4-funded-station-false-zero-warning.md) | reliability-followup | c364e991d8d9c0c4d446c9978b8d31c33fcbe09d |
| P1 | fixed | providers | [Gemini rejects the turn after a tool call loses its signature](bugs/0d63e5d1-gemini-loses-tool-signature.md) | reliability-followup | fe30cc1b4 |
| P1 | fixed | providers | [Image generation can write an output after run cancellation](bugs/a0dffdd7-image-generation-writes-after-run-cancellation.md) | audit-0112-0910 | d503f00c5 |
| P1 | fixed | providers | [Late model catalog response overwrites a newer provider selection](bugs/1600dcf0-late-model-catalog-reverts-new-provider-choice.md) | audit-0112-0910 | 59b5f2462 |
| P1 | fixed | providers | [Linked StarNet credits cannot authorize image generation](bugs/a9374d2c-linked-starnet-credits-cannot-authorize-image-ge.md) | managed-image-repair-0909 | 05fbfbd28 |
| P1 | fixed | providers | [Linked account warning confuses provider quota with disconnection](bugs/6c54d22e-linked-state-confused-with-quota.md) | reliability-followup | 756ebec88 |
| P1 | fixed | providers | [Local model small talk carries excessive context and produces prolonged replies](bugs/a76b93c4-local-model-small-talk-overload.md) | release-0120-prep-0915 | 5acf4640f |
| P1 | fixed | providers | [Managed chat can use a stale request endpoint](bugs/3195ab5a-managed-chat-can-use-a-stale-request-endpoint.md) | managed-endpoint-0909 | 177a9384e |
| P1 | fixed | providers | [Managed image charge is omitted from run cost receipts](bugs/79867817-managed-image-charge-missing-from-run-cost.md) | audit-0112-0910 | d503f00c5 |
| P1 | fixed | providers | [Managed model selection retains the wrong provider identity](bugs/7ed4a93c-managed-selection-keeps-wrong-provider.md) | reliability-followup | 17b9e1341 |
| P1 | fixed | providers | [No quota-exhaustion error class exists: a 429 from a spent Codex/subscription weekly quota renders as 'the provider is busy — wait a few seconds' and burns up t](bugs/e89317af-no-quota-exhaustion-error-class-exists.md) | sweep/providers | fdbb12a2 |
| P1 | fixed | providers | [Ollama strict templates reject late host system messages](bugs/4a1447ff-ollama-strict-templates-reject-late-host-system.md) | agent/provider-triage-1011 | d3e708cb0 |
| P1 | fixed | providers | [Routed OpenRouter conversation fails on orphan tool results](bugs/112199f5-openrouter-orphan-tool-results.md) | reliability-followup | 14f34372a |
| P1 | fixed | providers | [OpenRouter's free-model daily cap reads as a busy provider and is retried for about 100 seconds](bugs/0ae69a26-openrouter-s-free-model-daily-cap-reads-as-a-bus.md) | sweep/providers | 7436e401e |
| P1 | fixed | providers | [Ordinary wording incorrectly requires image generation](bugs/b0431c24-ordinary-wording-incorrectly-requires-image-gene.md) | image-intent-0909 | e6cdd0f1a |
| P1 | fixed | providers | [Routine form provider overrides its selected agent provider](bugs/a496d1c7-routine-form-provider-overrides-its-selected-age.md) | agent/seam-audit-0912-b | b5c5cba75 |
| P1 | fixed | providers | [Doctor works but sample ignores the saved provider](bugs/c978e7b7-sample-ignores-saved-provider.md) | reliability-followup | e33914cb2 |
| P1 | fixed | providers | [Saved equipment omitted from interactive tool projection and toolset diagnostics](bugs/432df352-saved-equipment-omitted-from-interactive-tool-pr.md) | agent/tool-projection-0909 | 3c95b184fd28c5eacac8821ca2231d85da5b3395 |
| P1 | fixed | providers | [Saved fallback changes model without switching provider](bugs/8b22d414-saved-fallback-changes-model-without-switching-p.md) | release-0112-finalprep-0911 | 44c6b4952cd1e468f7caaf4d7ead804dc280cc40 |
| P1 | fixed | providers | [The PER RUN dollar cap does not bound team.spawn workers, so a 5-cent cap ran 24 cents](bugs/d3a76db3-the-per-run-dollar-cap-does-not-bound-team-spawn.md) | sweep/providers | 4439b14ee, d42189a18, d42d1bc7e, 9d4fc52b5, a1234b154, 32fc352e4, 8f4267c08, 9e32443bf |
| P1 | fixed | providers | [Tier picker reports available managed models missing](bugs/ddea3c5d-tiers-ignore-managed-catalog.md) | reliability-followup | e33914cb2 |
| P1 | fixed | providers | [Unavailable OAuth model catalog clears the saved model selection](bugs/ebe2861a-unavailable-oauth-model-catalog-clears-the-saved.md) | release-0120-prep-0915 | 20be5165bcf5f2ec99f882b572cdb10e442ecb6c |
| P1 | fixed | providers | [Unavailable spend history blocks work without usable recovery](bugs/d688ea20-unavailable-spend-history-blocks-work-without-us.md) | release-0135-prep | 80eadd838 |
| P1 | fixed | providers | [Unavailable spend history grants capped runs fresh headroom](bugs/1746d326-unavailable-spend-history-grants-capped-runs-fre.md) | reliability-audit-0919 | 410252bbb |
| P1 | fixed | release | [Desktop bundle drops required calibration texture and disables graphical refresh](bugs/4a108286-desktop-bundle-drops-required-calibration-textur.md) | agent/release-0120-prep-0915 | d1848af00 |
| P1 | fixed | release | [Dismissed frame name suppresses unrelated visual changes](bugs/8993bb79-dismissed-frame-name-suppresses-unrelated-visual.md) | cleanup-0112-0910 | 0a3a605a9c41ecf944760782a4938ec442d02e6c |
| P1 | fixed | release | [Filtered journey run can replace the full release journey receipt](bugs/3d9dce85-filtered-journey-run-can-replace-the-full-releas.md) | agent/release-ui-audit-0906 | 042394b7d |
| P1 | fixed | release | [migrate_workspace_data writes the .migrated marker unconditionally and drops copy_missing_dir's Err with no log — a partial legacy migration is permanent and lo](bugs/f42a5f46-migrate-workspace-data-writes-the-migrated-marke.md) | sweep/release | 5f8aa7ce |
| P1 | fixed | release | [Reconciler mistakes related repairs for reported bug resolution](bugs/7528f593-related-fix-prose-promotes-customer-report.md) | reliability-audit | ef5585145 |
| P1 | fixed | release | [release-cut.mjs stages latest.json with no cryptographic signature check, and no downstream gate does one either — t1 checks .sig mtime, t5 text-compares it, ve](bugs/26af4a9a-release-cut-mjs-stages-latest-json-with-no-crypt.md) | sweep/release | b315063b |
| P1 | fixed | release | [Release preflight mistakes installed smoke for completed soak](bugs/0ea3abca-release-preflight-mistakes-installed-smoke-for-c.md) | agent/release-0112-finalprep-0911 | b9c5539556fc2d36e0992290c4dd8efb08720b82 |
| P1 | fixed | release | [Completing startup loading reopens a window closed to the tray](bugs/08eece34-startup-load-reopens-closed-tray-window.md) | release-0120-prep-0915 | 9c3b7819c |
| P1 | fixed | release | [Swallowed errors can expose credentials in console warnings](bugs/a03ea726-swallowed-errors-can-expose-credentials-in-conso.md) | cleanup-0112-0910 | 0a3a605a9c41ecf944760782a4938ec442d02e6c |
| P1 | fixed | safecell | [An errored /api/projects is rendered as a CONFIRMED EMPTY trust ledger ("NO TRUSTED PROJECTS") and silently wipes the persisted project scope](bugs/e05cdba8-an-errored-api-projects-is-rendered-as-a-confirm.md) | sweep/safecell | ed200caa |
| P1 | fixed | safecell | [Worker approvals hide the proposed request and lose parallel attention](bugs/6548b94d-delegated-approval-disclosure.md) | thread-ux-review-1011 | 09e6afba0179fe4aa6930fa5fe5b68a433d4934d |
| P1 | fixed | safecell | [Execution and disconnect controls confuse transport success with action success](bugs/1b9af0d7-execution-and-disconnect-controls-confuse-transp.md) | agent/systemic-bugs-0919 | 8eb87b0d3 |
| P1 | fixed | safecell | [File approval hides the proposed edit and patch payload](bugs/48c51661-file-approval-omits-mutation.md) | report-0110-0908 | 72a8a3043c263cd53ed353daed2042e256c8e236 |
| P1 | fixed | safecell | [Interrupted connector reset can hide preserved credentials](bugs/50c75ec3-interrupted-connector-reset-can-hide-preserved-c.md) | agent/session-handoff-1011 | abd2914492ca6cfe4db818bb67a872098d4edb56 |
| P1 | fixed | safecell | [Late permission responses replace newer authority and survive store reinitialization](bugs/dde8e66f-late-permission-responses-replace-newer-authorit.md) | agent/systemic-bugs-0919 | 8eb87b0d3 |
| P1 | fixed | safecell | [Patch guesses an unmatched block interior and corrupts source](bugs/81da21e4-patch-guesses-an-unmatched-block-interior-and-co.md) | reliability-review-1011 | f0a53efb0 |
| P1 | fixed | safecell | [Local peer ownership can match an unrelated loopback socket](bugs/1df2d6f8-peer-owner-matches-unrelated-loopback-sockets.md) | agent/runtime-triage-1011 | f7553cd3e19a00873cf702913da85358e2181303 |
| P1 | fixed | safecell | [Shell approvals and history hide full command arguments](bugs/082ee8e5-shell-approvals-and-history-hide-full-command-ar.md) | release-0135-prep | 4c89890bc |
| P1 | fixed | safecell | [Taking Full Power back while the station cannot record it shows the agent as asking first while every run still goes ahead unasked](bugs/41ef3d2d-taking-full-power-back-while-the-station-cannot.md) | sweep/safecell | b038a688e |
| P1 | fixed | safecell | [The Projects rail's ADD doorway records a NON-canonical path grant, so blessing a folder reached through a junction/symlink reports success and grants nothing](bugs/cf0cd4cd-the-projects-rail-s-add-doorway-records-a-non-ca.md) | sweep/safecell | 226cec3c |
| P1 | fixed | safecell | [Token overlap attests inverted memory as owner instruction](bugs/ecd03ee7-token-overlap-attests-inverted-memory-as-owner-i.md) | agent/provider-triage-1011 | 05618ec62 |
| P1 | fixed | sessions | [A deleted session keeps reaching the model: its words ride every later run's RECENT ACTIVITY and recall_conversation returns it](bugs/3e926b6a-a-deleted-session-keeps-reaching-the-model-its-w.md) | sweep/sessions | 5314b6c25 |
| P1 | fixed | sessions | [A second save quarantine after a restart deletes the first quarantined copy the recovery notice points to](bugs/e862d9ff-a-second-save-quarantine-after-a-restart-deletes.md) | sweep/sessions | dd8662b5c |
| P1 | fixed | sessions | [Add agents silently fails when group backend is unavailable](bugs/0245a284-add-agents-silently-fails-when-group-backend-is.md) | comms-add-agents-0906 | cf6b3ca03c372c404bcb46997a56d570d7747d70 |
| P1 | fixed | sessions | [Agent session focus commands can unexpectedly retarget the composer](bugs/774641dc-agent-session-focus-commands-can-unexpectedly-re.md) | typing-focus-0916-c7a2 | 86b33ace3 |
| P1 | fixed | sessions | [An empty station file never re-seeds from the browser save and the banner blames another window](bugs/5c019483-an-empty-station-file-never-re-seeds-from-the-br.md) | sweep/onboarding | 6849ada6d |
| P1 | fixed | sessions | [Backup write failure is swallowed before replacing the committed primary](bugs/83c34908-backup-write-failure-is-swallowed-before-replaci.md) | agent/systemic-bugs-0919 | 8eb87b0d3 |
| P1 | fixed | sessions | [checkpoint snapshot() uses the SYNC loadIndex despite being async — after an index+bak loss it re-stamps a 1-entry index that permanently blocks the git rebuild](bugs/d5621e9b-checkpoint-snapshot.md) | sweep/sessions | b315063b |
| P1 | fixed | sessions | [COMMS loses report tables list hierarchy quotes and named links](bugs/70860aa8-comms-loses-report-tables-list-hierarchy-quotes.md) | hermes-stress-0910 | 19e6aebded46145b75525616bdc384c976b6fe56 |
| P1 | fixed | sessions | [Concurrent stale workspace reclaimers both acquire ownership](bugs/c24336d5-concurrent-stale-workspace-reclaimers-both-acqui.md) | reliability-audit-0919 | d9f9b71f0 |
| P1 | fixed | sessions | [Worker result links open another workspace](bugs/c68d5c40-delegated-file-provenance.md) | thread-ux-review-1011 | 09e6afba0179fe4aa6930fa5fe5b68a433d4934d |
| P1 | fixed | sessions | [Capped and recovered worker runs overwrite current completion truth](bugs/dd9a34df-delegated-run-outcomes.md) | thread-ux-review-1011 | 09e6afba0179fe4aa6930fa5fe5b68a433d4934d |
| P1 | fixed | sessions | [Feedback cards do not identify the run being rated](bugs/c7fa86fc-feedback-run-reference-ambiguous.md) | report-0110-0908 | 72a8a3043c263cd53ed353daed2042e256c8e236 |
| P1 | fixed | sessions | [Group file links choose the wrong author or saved version](bugs/4e58ef35-group-artifact-message-version.md) | thread-ux-review-1011 | 09e6afba0179fe4aa6930fa5fe5b68a433d4934d |
| P1 | fixed | sessions | [Adding a participant to a direct conversation discards its existing attachments](bugs/408a0794-group-conversion-loses-attachments.md) | agent/adversarial-audit-0910 | 64ed8711b |
| P1 | fixed | sessions | [Interactive replies in scheduled conversations cannot be rated](bugs/09f0e9fa-interactive-replies-in-scheduled-conversations-c.md) | release-0120-prep-0915 | da0658486 |
| P1 | fixed | sessions | [Malformed save acknowledgements claim durability and malformed reads claim an empty station](bugs/28dbd392-malformed-save-acknowledgements-claim-durability.md) | reliability-audit-0919 | d9b6fba04 |
| P1 | fixed | sessions | [Parked tool output unreachable in project-scoped runs (relative .output pointer resolves against the project)](bugs/8c442112-parked-tool-output-unreachable-in-project-scoped.md) | agent/park-path-fix | 4a4dc6908 |
| P1 | fixed | sessions | [Preference corrections are discarded or leave contradictory memories active](bugs/f97e73fb-preference-corrections-are-discarded-or-leave-co.md) | agent/recall-report-0916 | 46c929a88 |
| P1 | fixed | sessions | [Project reopening loses crew controls and can mislabel or steal conversation focus](bugs/629c9bd7-project-reopening-loses-crew-controls-and-can-mi.md) | release-audit-0124-0920 | 4c09cec32d2000892c56d4388dc6374beb04baf1 |
| P1 | fixed | sessions | [Projects overview remains loading after a valid nonempty response](bugs/25120f27-projects-overview-remains-loading-after-a-valid.md) | projects-loading-0918 | fa3d96b12474612e5cc7a648c9b1685cfeef94e8 |
| P1 | fixed | sessions | [Queued save acknowledgements leave browser revision stale](bugs/891e15e8-queued-save-acknowledgements-leave-browser-revis.md) | release-0112-finalprep-0911 | 767a3592516edea1062d82855be2d21a8b4f7e16 |
| P1 | fixed | sessions | [Recent activity drops source provenance and reintroduces attachment text after restart](bugs/6e750350-recent-activity-drops-source-provenance.md) | agent/memory-harness-audit-1011 | 6421e4c857a6f885d0c437e9e4d01168f92ba7db |
| P1 | fixed | sessions | [Reload duplicates combined assistant replies beside durable turns](bugs/ec226657-reload-duplicates-combined-assistant-replies-bes.md) | agent/release-0112-audit-0910 | a66fc5638 |
| P1 | fixed | sessions | [Reopened conversations send before history is restored and hide late messages](bugs/2426399e-reopened-conversations-send-before-history-is-re.md) | session-reliability-0919 | 8b8bf9531 |
| P1 | fixed | sessions | [Retry duplicates the user message after restart](bugs/b30c1c8e-retry-duplicates-the-user-message-after-restart.md) | overnight-retry-history-0907 | 1611844713cfb4d88061ace1f786040436c59605 |
| P1 | fixed | sessions | [Saved file links disappear when conversation history is restored](bugs/253e5a8e-saved-file-links-disappear-when-conversation-his.md) | agent/release-0120-prep-0915 | 8d4f3f5ca |
| P1 | fixed | sessions | [Sent group attachments appear only in the shared shelf](bugs/de0bb232-sent-group-attachments-appear-only-in-the-shared.md) | release-0110 | fe5be77a9 |
| P1 | fixed | sessions | [An older client can erase newer conversations by saving its stale snapshot with a fresh timestamp](bugs/7546cccd-stale-client-save-overwrite.md) | agent/adversarial-audit-0910 | 64ed8711b |
| P1 | fixed | sessions | [Stalled save responses permanently block the persistence queue](bugs/e6b19398-stalled-save-responses-permanently-block-the-per.md) | reliability-audit-0919 | d9b6fba04 |
| P1 | fixed | sessions | [Startup history read failure skips away-work review recovery](bugs/6b655b46-startup-history-read-failure-skips-away-work-rev.md) | agent/seam-audit-0912-b | b5c5cba75 |
| P1 | fixed | sessions | [Temporarily unreadable durable records can be quarantined or overwritten](bugs/7aeb7f9f-temporarily-unreadable-durable-records-can-be-qu.md) | agent/systemic-bugs-0919 | 8eb87b0d3 |
| P1 | fixed | sessions | [Unknown PID probe errors authorize workspace takeover](bugs/7f19707e-unknown-pid-probe-errors-authorize-workspace-tak.md) | reliability-audit-0919 | 9cdfc0ba5 |
| P1 | fixed | sessions | [Worker recovery can publish raw output before structured repair](bugs/113c2fa8-worker-final-delivery-authority.md) | thread-ux-review-1011 | a69664135e4983fe624ec11bea6b2bd4666ee651 |
| P1 | fixed | sessions | [Worker completion can outlive the only complete answer](bugs/4a66278b-worker-final-output-durability.md) | thread-ux-review-1011 | 18c1ec59f094775ada818175d927e9c4ffc845d8 |
| P1 | fixed | sessions | [Large accepted worker output can be silently truncated](bugs/2d537ab3-worker-final-output-truncation.md) | thread-ux-review-1011 | 18c1ec59f094775ada818175d927e9c4ffc845d8 |
| P1 | fixed | sessions | [Workshop reports a completed web tool when its entry file is missing](bugs/097269b5-workshop-reports-a-completed-web-tool-when-its-e.md) | agent/release-ui-audit-0906 | 44a8c3006 |
| P1 | fixed | skills | [Approved skill is withheld from autonomous workers](bugs/f702f2f6-approved-skill-is-withheld-from-autonomous-worke.md) | release-0135-prep | df73589b8 |
| P1 | fixed | skills | [Base64-stored support files are scanned as their encoding, so a body edit releases a withheld installed package](bugs/297e2db4-base64-stored-support-files-are-scanned-as-their.md) | sweep/skills | bd449b81b |
| P1 | fixed | skills | [Campaign cards missing from browser element discovery](bugs/305a9e3d-campaign-cards-missing-from-browser-element-disc.md) | agent/browser-campaign-navigation-0912 | dcbc2b941 |
| P1 | fixed | skills | [gate.verify()'s tamper branch re-enters decide(), which clears the tamper against the STALE stored contentDigest — one approval permanently blesses whatever is](bugs/76d5dc8a-gate-verify.md) | sweep/skills | 598ab4a4 |
| P1 | fixed | skills | [Installed package description and category are never scanned yet ride every run's skill index](bugs/23996f04-installed-package-description-and-category-are-n.md) | sweep/skills | bd449b81b |
| P1 | fixed | skills | [Skill hydrate reads files through a support folder that is itself a junction, and through hardlinked files](bugs/c723d5f4-skill-hydrate-reads-files-through-a-support-fold.md) | sweep/skills | bd449b81b |
| P1 | fixed | voice | [A stale sidecar token lets Local Live open a silent microphone session after restart](bugs/ff73b79a-a-stale-sidecar-token-lets-local-live-open-a-sil.md) | agent/voice-release-sweep | 8bc9ff9a |
| P1 | fixed | voice | [An Edge read-aloud stream cut before turn.end is served as a whole clip and cached under the full sentence; a dropped connection hangs the full 15s per attempt](bugs/81812888-an-edge-read-aloud-stream-cut-before-turn-end-is.md) | sweep/voice | 0efc04afe |
| P1 | fixed | voice | [Instant TTS retries let a 300 ms provider blip spend every in-flight chunk's budget, so MID_REPLY_GIVEUP silences the whole spoken reply](bugs/1b924a90-instant-tts-retries-let-a-300-ms-provider-blip-s.md) | sweep/voice | 468524e05 |
| P1 | fixed | voice | [Live spoken replies stall after the output audio context closes](bugs/3364dfb0-live-spoken-replies-stall-after-the-output-audio.md) | agent/live-speech-0910 | f129e19e3 |
| P1 | fixed | voice | [Mac desktop microphone blocked while browser mirror works](bugs/8a553481-mac-desktop-microphone-blocked-while-browser-mir.md) | agent/voice-agents-mac-0906 | d65f8f538 |
| P1 | fixed | voice | [On a zero-key station every Edge blip is misclassified as 'no key': no retry, a 60s dead-voice cold-off, and a tooltip demanding a credential the station never](bugs/151c8d9a-on-a-zero-key-station-every-edge-blip-is-misclas.md) | sweep/voice | 50a8b07b |
| P1 | fixed | voice | [Spoken replies fragment at punctuation and omit failed audio chunks](bugs/e1051446-spoken-replies-fragment-at-punctuation-and-omit.md) | agent/voice-continuity-0909 | 7e83246fa |
| P1 | fixed | voice | [transcribe() never checks r.ok, so any non-JSON /api/stt error (stale-token 403, 5xx, HTML) is laundered into a confirmed-empty transcript and the spoken senten](bugs/1aa7faf6-transcribe.md) | sweep/voice | 50a8b07b |
| P1 | fixed | voice | [Voice.init (agent focus / persona change / dossier apply) calls reflectToggle without clearing fbNotified, permanently wiping the pinned degrade tooltip while t](bugs/562c293e-voice-init.md) | sweep/voice | 50a8b07b |
| P1 | fixed | world | [A Meeseeks helper sprite whose terminal `task` event is lost stays asserted LIVE forever — the ledger has no TTL, no snapshot reconcile, and no reset on NEW AGE](bugs/c96c4d41-a-meeseeks-helper-sprite-whose-terminal-task-eve.md) | sweep/world | meeseeks layer removed 2026-07-30 (agent/meeseeks-visual) |
| P1 | fixed | world | [A renderer-posted routing plan grants headless runs any tools it names — no cross-check against the saved station, and it persists across restart](bugs/a9a4f53c-a-renderer-posted-routing-plan-grants-headless-r.md) | sweep/world | 71e0c668d fcac5fc37 |
| P1 | fixed | world | [Agent-built work lines report ready before routing publication](bugs/39136a7a-agent-built-work-lines-report-ready-before-routi.md) | agent/runtime-triage-1011 | dd731e1a191197de95a7ab1c04a9847e9f0e4cdd |
| P1 | fixed | world | [Agents cross walls beside hallway openings](bugs/49192a68-agents-cross-walls-beside-hallway-openings.md) | wall-clearance-0916 | 2dbc0ef5a |
| P1 | fixed | world | [Approved agent sprites remain behind preview switch in normal desktop](bugs/84e26970-approved-agent-sprites-remain-behind-preview-swi.md) | agent/release-0120-prep-0915 | df4d1ba25 |
| P1 | fixed | world | [Battle pass tells a goal saved offline that it has no success condition](bugs/125e197f-battle-pass-tells-a-goal-saved-offline-that-it-h.md) | sweep/battlepass | c1b4a6f59 |
| P1 | fixed | world | [Bay names are unreadable at normal station zoom](bugs/0ff9dfc6-bay-names-are-unreadable-at-normal-station-zoom.md) | release-0110 | 86560bea9 |
| P1 | fixed | world | [GPU loss replaces authored props with legacy art and disables floor recovery](bugs/0db3e69c-gpu-loss-replaces-authored-props-with-legacy-art.md) | release-0135-prep | 5c73343b9 |
| P1 | fixed | world | [New backdrops stall switching and zoomed-out terrain rendering](bugs/04ca4207-new-backdrops-stall-switching-and-zoomed-out-ter.md) | agent/backdrop-performance-0910 | 2c041bbe69124eda1f60a6eb5a11cc44676028cb |
| P1 | fixed | world | [Refit entry freezes the installed remastered station for roughly ten seconds](bugs/bf3be27e-refit-entry-freezes-the-installed-remastered-sta.md) | release-0120-prep-0915 | 15ac83ceb |
| P1 | fixed | world | [Render refresh publishes unfinished edits while Build remains open](bugs/b5c41b7c-render-refresh-publishes-held-build-edits.md) | agent/session-handoff-1011 | f90409837a5a69faf32ca3bf2e918bed8c508d4a |
| P1 | fixed | world | [ROUTINES › REVOKE ACCESS toasts "access revoked" (green) on a 4xx/5xx — bare `fetch` resolves, so the unattended grant survives its own success message](bugs/fd0f7223-routines-revoke-access-toasts-access-revoked.md) | sweep/world | 3f0d1205 |
| P1 | fixed | world | [Station design edits disappear when Build is interrupted](bugs/996e399b-station-design-edits-disappear-when-build-is-int.md) | agent/station-save-0919 | fb02b1e7d |
| P1 | fixed | world | [A terse approval at a LOOP gate hands on only the approval, never the work it approved](bugs/f97ea4b3-terse-approval-at-a-loop-gate-hands-on-only-the.md) | lines/terse-approval | 6471f0ade |
| P1 | fixed | world | [Customer viewport becomes blank after ten to twenty minutes](bugs/9256a771-viewport-black-after-idle.md) | reliability-followup | 57112a690f8174f3ba3f3ac33fe786d07fa51c5d |
| P1 | fixed | world | [Website station preview fails when hosting beacon is blocked](bugs/b3b8d28f-website-station-preview-fails-when-hosting-beaco.md) | website-station-boot-0905 | 27560918e |
| P1 | wontfix | onboarding | [Mac boot guard reports shared specialty catalog load failure](bugs/2f156837-mac-boot-guard-reports-shared-specialty-catalog.md) | release-0112-finalprep-0911 | — |
| P2 | open | autonomy | [Customer requests accounting for credits consumed during Mac boot trouble](bugs/abd75bb4-credit-usage-during-mac-boot-failure.md) | release-0120-prep-0915 | — |
| P2 | open | autonomy | [Customer cannot explain idle behavior and unexpectedly high usage](bugs/acb47320-idle-usage-customer-unexplained.md) | reliability-followup | — |
| P2 | open | autonomy | [Repeated project verification reportedly consumes overnight budget](bugs/f8d479d9-repeated-project-verification-reportedly-consume.md) | agent/reliability-audit-0919 | — |
| P2 | open | channels | [A steered Telegram reply arrives with the raw '[steering] <note>' echo and both the pre- and post-steer answers glued into one message](bugs/e903a199-a-steered-telegram-reply-arrives-with-the-raw-st.md) | sweep/channels | — |
| P2 | open | channels | [Desktop slash aliases and client-only commands typed on Telegram (/routines, /reset, /version, /q) fall through to a paid model run](bugs/6cd531b1-desktop-slash-aliases-and-client-only-commands-t.md) | sweep/channels | — |
| P2 | open | channels | [/routine add typed on Telegram creates a station-only routine: its results never come back to the chat that created it](bugs/3b958e41-routine-add-typed-on-telegram-creates-a-station.md) | sweep/channels | — |
| P2 | open | channels | [Zoho Mail bootstrap tool reportedly requires undiscoverable account](bugs/54564ff9-zoho-mail-bootstrap-tool-reportedly-requires-und.md) | agent/reliability-audit-0919 | — |
| P2 | open | onboarding | [A first task that fails at the provider consumes the hand-off with no retry](bugs/159d44fc-a-first-task-that-fails-at-the-provider-consumes.md) | sweep/onboarding | — |
| P2 | open | onboarding | [Google Drive authorization is hard blocked for a fresh personal account](bugs/f2ac6356-google-drive-authorization-is-hard-blocked-for-a.md) | release-0135-prep | — |
| P2 | open | onboarding | [Customer reports unusable visibility without build or platform details](bugs/6bb9d2a1-visibility-failure-without-diagnostics.md) | release-0120-prep-0915 | — |
| P2 | open | providers | [A run cancelled mid-stream is recorded as a known zero-dollar run instead of spend unknown](bugs/80de2a75-a-run-cancelled-mid-stream-is-recorded-as-a-know.md) | sweep/autonomy | — |
| P2 | open | providers | [A run's ledger row cannot be matched to the provider's charge because no generation id is kept](bugs/6e32cb6c-a-run-s-ledger-row-cannot-be-matched-to-the-prov.md) | sweep/providers | — |
| P2 | open | providers | [ChatGPT plan-allowance copy hardcodes a weekly reset and never shows the provider's reset time](bugs/06331054-chatgpt-plan-allowance-copy-hardcodes-a-weekly-r.md) | sweep/providers | — |
| P2 | open | providers | [Connector sign-in is lost after credential-store recovery](bugs/e7b2ffcd-connector-sign-in-is-lost-after-credential-store.md) | release-0135-prep | — |
| P2 | open | providers | [Funded account runs fail again after a credit-limit workaround](bugs/a5060cc3-funded-account-runs-fail-again-after-a-credit-li.md) | release-0135-prep | — |
| P2 | open | providers | [Managed Sonnet request still returns an uncorrelated HTTP 400](bugs/fd9c4b4d-managed-sonnet-400-unresolved.md) | reliability-followup | — |
| P2 | open | providers | [Model catalog lookups resolve a bare model id against another provider's catalog](bugs/f6744691-model-catalog-lookups-resolve-a-bare-model-id-ag.md) | sweep/providers | — |
| P2 | open | providers | [Ollama run times out with no chat POST observed by reporter](bugs/5274c7b7-ollama-chat-request-not-observed.md) | release-0120-prep-0915 | — |
| P2 | open | providers | [Reported macOS web fetch TLS decode and socket failures](bugs/1d3ac09a-reported-macos-web-fetch-tls-decode-and-socket-f.md) | release-0135-prep | — |
| P2 | open | providers | [Retry status labels a refused or unresolvable provider connection as a timeout](bugs/8873fd77-retry-status-labels-a-refused-or-unresolvable-pr.md) | sweep/onboarding | — |
| P2 | open | release | [All 30 superseded StarNet releases (v0.6.4 to v0.13.3) remain publicly downloadable from the releases repo](bugs/1a69136d-all-30-superseded-starnet-releases-v0-6-4-to-v0.md) | sweep/release | — |
| P2 | open | release | [Every INSTALL UPDATE attempt writes another full-station backup to update-snapshots and nothing ever prunes them](bugs/31db37b0-every-install-update-attempt-writes-another-full.md) | sweep/release | — |
| P2 | open | release | [Mac installer reports application unsupported on the computer](bugs/ff3fb4cb-mac-unsupported-installation-uncorrelated.md) | release-0120-prep-0915 | — |
| P2 | open | release | [T0.2 reports a clean Windows surface is available when only a QEMU binary exists and no Windows guest is configured](bugs/c856c4f7-t0-2-reports-a-clean-windows-surface-is-availabl.md) | sweep/release | — |
| P2 | open | release | [Windows 0.13.2 startup fails loading a packaged backend module](bugs/85f602c4-windows-0132-packaged-backend-startup.md) | release-0135-prep | — |
| P2 | open | release | [Windows Node 24 HTTP test exits with a native libuv assertion after passing](bugs/6e29727c-windows-node-24-http-test-exits-with-a-native-li.md) | reliability-audit-0919 | — |
| P2 | open | safecell | [A process a shell command detaches (Start-Process) survives E-STOP and sidecar exit and nothing reports it](bugs/1ac8819d-a-process-a-shell-command-detaches-start-process.md) | sweep/safecell | — |
| P2 | open | safecell | [Execution history shows a shortened shell command instead of the full redacted command](bugs/9f908b02-execution-history-shows-a-shortened-shell-comman.md) | release-0135-prep | — |
| P2 | open | safecell | [First file write in a fresh station can time out while the checkpoint runs inside its 10s budget](bugs/e47efecf-first-file-write-in-a-fresh-station-can-time-out.md) | agent/ollama-fixes | — |
| P2 | open | sessions | [Every crash mid-write leaves a uniquely named full-copy tmp file that nothing ever sweeps](bugs/75558694-every-crash-mid-write-leaves-a-uniquely-named-fu.md) | sweep/sessions | — |
| P2 | open | sessions | [Internal title and goal self-talk is stored as Commander dialogue in the global transcript and recalled as such](bugs/4dee26ba-internal-title-and-goal-self-talk-is-stored-as-c.md) | sweep/sessions | — |
| P2 | open | sessions | [Reloading the newer window boots the stale window's cached station and calls it this window's work](bugs/27bae3d6-reloading-the-newer-window-boots-the-stale-windo.md) | sweep/sessions | — |
| P2 | open | sessions | [Saved station opening is blocked despite a reachable engine](bugs/4c0efd8c-saved-station-opening-is-blocked-despite-a-reach.md) | release-0135-prep | — |
| P2 | open | sessions | [The phone's routine list shows a live green dot and cadence while scheduling is OFF or E-STOPped](bugs/96dcbade-the-phone-s-routine-list-shows-a-live-green-dot.md) | sweep/autonomy | — |
| P2 | open | skills | [A diverged installed package's support files are mirrored to disk and shown to the model as base64 text](bugs/a36d1b00-a-diverged-installed-package-s-support-files-are.md) | sweep/skills | — |
| P2 | open | skills | [A legacy skill record's unscanned summary still rides the prompt index](bugs/56c6f962-a-legacy-skill-record-s-unscanned-summary-still.md) | sweep/skills | — |
| P2 | open | skills | [A model can remove the Commander's pin on a skill directly, without a staged proposal](bugs/97743dff-a-model-can-remove-the-commander-s-pin-on-a-skil.md) | sweep/skills | — |
| P2 | open | voice | [/api/tts asks only the first credentialed keyed provider: a station holding OpenRouter and Gemini keys drops to Edge's different voice when OpenRouter fails](bugs/243de8bd-api-tts-asks-only-the-first-credentialed-keyed-p.md) | sweep/voice | — |
| P2 | open | voice | [Paired-device speech ends the rest of a reply on one failed later sentence, with no retry](bugs/19429523-paired-device-speech-ends-the-rest-of-a-reply-on.md) | sweep/voice | — |
| P2 | open | world | [station.test_line claims an unconfirmed onward hand-off for a job that landed in a non-sending OUTBOX](bugs/3ee2d13a-test-line-unconfirmed-hand-off-from-a-non-sendin.md) | conveyor-final-runtime | — |
| P2 | fixed | autonomy | [A clock that jumped ahead and was corrected back strands recurring routines for the length of the jump](bugs/7ae7e435-a-clock-that-jumped-ahead-and-was-corrected-back.md) | sweep/autonomy | 6102a1612 |
| P2 | fixed | autonomy | [A cron advance anchored inside a fall-back repeated hour fires that day's ambiguous time a second time](bugs/10ecf010-a-cron-advance-anchored-inside-a-fall-back-repea.md) | sweep/autonomy | 822503be5 |
| P2 | fixed | autonomy | [A force-killed holder's cron.lock with a recycled PID mutes the scheduler for up to 8 minutes](bugs/1186e4e7-a-force-killed-holder-s-cron-lock-with-a-recycle.md) | sweep/autonomy | 283face2e |
| P2 | fixed | autonomy | [A one-shot routine whose time already passed is stored and fires on the next tick](bugs/94e4036f-a-one-shot-routine-whose-time-already-passed-is.md) | sweep/autonomy | 17e0d3965 |
| P2 | fixed | autonomy | [Cancelled edit starts a replacement language server](bugs/37059128-cancelled-edit-starts-a-replacement-language-ser.md) | reliability-audit | 547dd03d7 |
| P2 | fixed | autonomy | [Commander-reported plan step shown as StarNet recorded](bugs/024e4e15-commander-reported-plan-step-shown-as-starnet-re.md) | sweep/autonomy | e0b979995 |
| P2 | fixed | autonomy | [Deliverable naming instruction conflicts with explicit stop limits](bugs/5a35bcfe-deliverable-note-overrides-stop.md) | report-0110-0908 | 72a8a3043c263cd53ed353daed2042e256c8e236 |
| P2 | fixed | autonomy | [Loop pause and resume discard refused control responses](bugs/32fd08b2-loop-pause-and-resume-discard-refused-control-re.md) | agent/seam-audit-0912-b | b5c5cba75 |
| P2 | fixed | autonomy | [Loop polling erases the rejection explanation being typed](bugs/2b5b18a3-loop-polling-erases-the-rejection-explanation-be.md) | agent/seam-audit-0912-b | b5c5cba75 |
| P2 | fixed | autonomy | [Lowering the autonomy dial to WAIT does not stop the night-shift beat already in flight](bugs/50551f59-lowering-the-autonomy-dial-to-wait-does-not-stop.md) | sweep/autonomy | ac17d27be |
| P2 | fixed | autonomy | [Paused routines falsely keep an idle desktop armed](bugs/ce430c35-paused-routines-falsely-keep-an-idle-desktop-arm.md) | release-0112-finalprep-0911 | b87bdf26099327e91eae85f9c5b1933ea5dbbe56 |
| P2 | fixed | autonomy | [routine.create's default `arm:true` bypasses the documented single resume seam and clears the durable cron E-STOP — the workshop auto-arm path at index.js:8214](bugs/300b34ab-routine-create-s-default-arm.md) | sweep/autonomy | 6afeb9ee |
| P2 | fixed | autonomy | [Routine schedule preview races newer input and stalls after failures](bugs/eba7e8aa-routine-schedule-preview-races-newer-input-and-s.md) | agent/system-polish-0920 | 4a2028759 |
| P2 | fixed | autonomy | [The every-other-week routine refusal never fires because its regex carries backspace bytes](bugs/46602571-the-every-other-week-routine-refusal-never-fires.md) | sweep/providers | 163c2d772 |
| P2 | fixed | autonomy | [The night-shift panel shows a next-job clock that a spent leash or a held gate will not honor](bugs/72fef60f-the-night-shift-panel-shows-a-next-job-clock-tha.md) | sweep/autonomy | c6ebbb0ce |
| P2 | fixed | autonomy | [Unique line names block multi-inbox and repeated template builds](bugs/58136a6a-unique-line-names-block-multi-inbox-and-repeated.md) | agent/session-handoff-1011 | 07b522235232032e2b85a4cf201937fc85ebf1f0 |
| P2 | fixed | channels | [Answering one prompt clears other parallel approvals](bugs/47c3a845-answering-one-clarification-clears-other-paralle.md) | agent/ux-triage-1011 | ced84e2f04e4a94a77f04cac97f7f469d4f4c336 |
| P2 | fixed | channels | [channel.send tells the chat a missing or refused file 'is saved in the workspace on the station'](bugs/c0beb187-channel-send-tells-the-chat-a-missing-or-refused.md) | sweep/channels | 00bc7ba60 |
| P2 | fixed | channels | [COMMS report lists lose plus and tab-separated markers](bugs/3ad3e2b8-comms-report-lists-lose-plus-and-tab-separated-m.md) | agent/release-0112-audit-0910 | cb6c30b4d |
| P2 | fixed | channels | [Dense service cards squeeze technical prose into tiny columns](bugs/734b469e-dense-service-cards-squeeze-technical-prose-into.md) | agent/ui-density-audit | 221775a85 |
| P2 | fixed | channels | [E-STOP silences the channel reply path via the supersede flag, so a deliberately stopped run is indistinguishable from a crashed bot on the phone](bugs/600f4982-e-stop-silences-the-channel-reply-path-via-the-s.md) | sweep/channels | 96fe108d |
| P2 | fixed | channels | [Every channel run without a configured system prompt reaches the provider with the persona replaced by the literal text '() => p'](bugs/446602ab-every-channel-run-without-a-configured-system-pr.md) | sweep/channels | 9e15c999e |
| P2 | fixed | channels | [Station button redesign escaped the bottom navigation](bugs/d28ba8f4-station-button-redesign-escaped-the-bottom-navig.md) | agent/comms-controls-0906 | e4e4512b198279e35cdd9f2cc2be9d786b02e87f |
| P2 | fixed | channels | [/usage on an unsettled ledger answers '…See SETTINGS › SPENDING LIMITS..' with a doubled period, on Telegram and in COMMS](bugs/67ba42c6-usage-on-an-unsettled-ledger-answers-see-setting.md) | sweep/channels | cc57c42b6 |
| P2 | fixed | channels | [With /mention off, a group command @-addressed to another bot (/new@otherbot, /stop@otherbot) runs on this bot](bugs/bbf17048-with-mention-off-a-group-command-addressed-to-an.md) | sweep/channels | debe64ba4 |
| P2 | fixed | onboarding | [A grabbed awakening offer becomes the Commander's first task in the agent's own voice](bugs/90efe1f0-a-grabbed-awakening-offer-becomes-the-commander.md) | sweep/onboarding | 22b3454a9 |
| P2 | fixed | onboarding | [A wall-of-text onboarding answer rides every system prompt uncapped](bugs/8faefe89-a-wall-of-text-onboarding-answer-rides-every-sys.md) | sweep/onboarding | 773e82859 |
| P2 | fixed | onboarding | [An emoji-only or punctuation-only answer is saved as the Commander's stated belief](bugs/289ed1ab-an-emoji-only-or-punctuation-only-answer-is-save.md) | sweep/onboarding | 8130d66ee |
| P2 | fixed | onboarding | [First-path offer silently vanishes for a long or repeated mission](bugs/2ea198d9-first-path-offer-silently-vanishes-for-a-long-or.md) | sweep/onboarding | 6d86bbfe2 |
| P2 | fixed | onboarding | [FOR YOU shelf disappears after declining every recipe](bugs/fa296d45-for-you-shelf-disappears-after-declining-every-r.md) | sweep/onboarding | ce7698b0d |
| P2 | fixed | onboarding | [Intake interview asks scene-register questions and glues each lead-in to its question](bugs/77350944-intake-interview-asks-scene-register-questions-a.md) | sweep/onboarding | 8130d66ee |
| P2 | fixed | onboarding | [Onboarding sign-in codes have dark text on dark backgrounds](bugs/c9929ae3-onboarding-sign-in-codes-have-dark-text-on-dark.md) | agent/onboarding-test-0919 | 51dcb517d2ed6935bca7ed924d8ca6c095a17913 |
| P2 | fixed | onboarding | [Text typed at an awakening read gate or mid-question is silently discarded](bugs/bc709e71-text-typed-at-an-awakening-read-gate-or-mid-ques.md) | sweep/onboarding | 773e82859 |
| P2 | fixed | onboarding | [WAKE key-check failure claims a previous key on a fresh install and shows raw outage jargon](bugs/5d19823c-wake-key-check-failure-claims-a-previous-key-on.md) | sweep/onboarding | 2ad0d1c9a |
| P2 | fixed | providers | [A sign-in token-endpoint 429 tells a subscription user their account is out of credit](bugs/7631293b-a-sign-in-token-endpoint-429-tells-a-subscriptio.md) | sweep/providers | 8650b980a |
| P2 | fixed | providers | [An OpenRouter in-band error loses its status and the upstream's words, so an in-band 401 is retried for about 100 seconds](bugs/cf675264-an-openrouter-in-band-error-loses-its-status-and.md) | sweep/providers | c486a4f0a |
| P2 | fixed | providers | [An OpenRouter key credit limit or an upstream region refusal reads as a rejected API key](bugs/7d396570-an-openrouter-key-credit-limit-or-an-upstream-re.md) | sweep/providers | 613beeac9 |
| P2 | fixed | providers | [BYOK image recovery omits the supported OpenRouter key option](bugs/3a2837bd-byok-image-recovery-only-offers-paid-link.md) | audit-0112-0910 | d503f00c5 |
| P2 | fixed | providers | [credPool.penalize() on the run's PRIMARY key is inert — the sole credPool.order() call site (index.js:10580) receives a pool with runKey filtered out](bugs/8d7b0b52-credpool-penalize.md) | sweep/providers | fdbb12a2 |
| P2 | fixed | providers | [Ollama task runs finish without reported filesystem tool calls](bugs/678ac951-ollama-task-runs-finish-without-reported-filesys.md) | agent/reliability-audit-0919 | 0e25b955f |
| P2 | fixed | providers | [Ollama timeout diagnostics infer loading from missing status](bugs/ef2c7d7c-ollama-timeout-diagnostics-infer-loading-from-mi.md) | agent/provider-triage-1011 | e91f3231e |
| P2 | fixed | providers | [OpenAI image model is routed through a chat completion path](bugs/6c6c34e1-openai-image-model-selected-for-comms.md) | release-0120-prep-0915 | 7a9349aa071c8fd97f04b520333d37d821f55c69 |
| P2 | fixed | providers | [Provider card status alignment and dated identity artwork](bugs/4a151231-provider-card-status-alignment-and-dated-identit.md) | agent/providers-polish-0910 | 3f2cc70d4 |
| P2 | fixed | providers | [Run metadata invalidates reusable prompt cache and unused fallback authentication delays primary requests](bugs/c9201c15-run-metadata-invalidates-reusable-prompt-cache-a.md) | latency-audit-0913 | 9b2ce2d35804623e97fa0a081cc11ffddd33d534 |
| P2 | fixed | providers | [Secondary console layouts lose provider text and dropdown affordances at enlarged scale](bugs/6c91f5d9-secondary-console-layouts-lose-provider-text-and.md) | agent/interface-finish-0913 | 0054a3d7a |
| P2 | fixed | providers | [The browser per-minute rate-limit veto lost rpm and tpm to collapsed backspace bytes](bugs/a1ce5839-the-browser-per-minute-rate-limit-veto-lost-rpm.md) | sweep/providers | 163c2d772 |
| P2 | fixed | providers | [The index.js summarize closure captures the pre-failover provider/model — after a credential rotation or provider fallback, two failed summaries flip compaction](bugs/cb8dc6c3-the-index-js-summarize-closure-captures-the-pre.md) | sweep/providers | fdbb12a2 |
| P2 | fixed | providers | [The ledger's `unmetered` flag is a stamped verdict with zero readers — every ledger USD aggregate (/api/budget, day/global caps) counts subscription dollars tha](bugs/4007eb1f-the-ledger-s-unmetered-flag-is-a-stamped-verdict.md) | sweep/providers | fdbb12a2 |
| P2 | fixed | release | [A refused update download shows the bare minisign/reqwest error text and never says nothing was installed](bugs/5a215a68-a-refused-update-download-shows-the-bare-minisig.md) | sweep/release | eeb5cf20f |
| P2 | fixed | release | [Browser probe request timers survive completed requests](bugs/4a518eb8-browser-probe-request-timers-survive-completed-r.md) | reliability-audit-0919 | 9cdfc0ba5 |
| P2 | fixed | release | [Desktop bundles include development-only native dependencies](bugs/037ec5d2-desktop-bundles-include-development-only-native.md) | reliability-audit-0919 | a711f6ea2 |
| P2 | fixed | release | [Desktop overlay version disagrees with sidecar diagnostics](bugs/65587128-desktop-overlay-version-disagrees-with-sidecar-d.md) | agent/release-0112-audit-0910 | bed625bdd |
| P2 | fixed | release | [HTTP gate watchdog expires before the full suite finishes](bugs/0c148510-http-gate-watchdog-expires-before-the-full-suite.md) | cleanup-0112-0910 | 5262e4a2943e72e2ce147f6fa804fd1b859df211 |
| P2 | fixed | release | [Hydration regression depends on host scheduling](bugs/4bc5d562-hydration-regression-depends-on-host-scheduling.md) | cleanup-0112-0910 | 5262e4a2943e72e2ce147f6fa804fd1b859df211 |
| P2 | fixed | release | [Installed Mac acceptance receipts hard-code destination version](bugs/72cc1475-installed-mac-acceptance-receipts-hard-code-dest.md) | reliability-audit-0919 | 2098a36f9 |
| P2 | fixed | release | [Linux AppImage staging includes incompatible musl Sharp binaries](bugs/694472bf-linux-appimage-staging-includes-incompatible-mus.md) | agent/release-0112-audit-0910 | bbbd7c13a |
| P2 | fixed | release | [Mac receipt test fails when Python is missing](bugs/046bd4a1-mac-receipt-test-fails-when-python-is-missing.md) | issue-40-investigation | 4847acd6751b5719f87dc3ef4e1d3683b2c62782 |
| P2 | fixed | release | [release:preflight shows the claims row as 'authority Â· 37 claims Â· 380 locked surface files' because claims.mjs carries double-encoded UTF-8 literals](bugs/395e037c-release-preflight-shows-the-claims-row-as-author.md) | sweep/release | a0aa90243 |
| P2 | fixed | release | [Remembered update bypasses retry backoff after a failed native check](bugs/ab2fdd8c-remembered-update-bypasses-retry-backoff-after-a.md) | agent/issue-triage-1011 | 927ffb908 |
| P2 | fixed | release | [Scale soak misclassifies separate scheduler ticks between store polls](bugs/59040543-scale-soak-misclassifies-separate-scheduler-tick.md) | agent/release-0112-audit-0910 | 7efce3552 |
| P2 | fixed | release | [Seeded lifecycle campaigns reuse a shared workspace and inherit stale ownership](bugs/46f9dad7-seeded-lifecycle-campaigns-reuse-a-shared-worksp.md) | reliability-audit-0919 | b123e3ea3 |
| P2 | fixed | release | [t5.1 prerequisite gate accepts T0–T4 verdicts with no installer-hash or freshness binding, though t3.2 already binds T0's recorded installer sha256 to the binar](bugs/4bd953e0-t5-1-prerequisite-gate-accepts-t0-t4-verdicts-wi.md) | sweep/release | b76e340c |
| P2 | fixed | release | [T5 stamps publicDistributionReady on an updater .sig that signs different bytes, because T5.2 only text-compares it to latest.json](bugs/6c707133-t5-stamps-publicdistributionready-on-an-updater.md) | sweep/release | d2960405c |
| P2 | fixed | release | [The glossary shows the Windows data path with a BEL byte instead of a backslash](bugs/9515a903-the-glossary-shows-the-windows-data-path-with-a.md) | sweep/providers | 163c2d772 |
| P2 | fixed | release | [Update canary uses obsolete saves and snapshots the startup WebView](bugs/050da842-update-canary-uses-obsolete-saves-and-snapshots.md) | agent/release-0112-audit-0910 | bed625bdd |
| P2 | fixed | safecell | [A mid-run "Full access" click writes a per-agent '*' wildcard with no readout and no revoke anywhere, and the same wildcard is read by that agent's UNATTENDED r](bugs/13646d93-a-mid-run-full-access-click-writes-a-per-agent-w.md) | sweep/safecell | 226cec3c |
| P2 | fixed | safecell | [A session answer on a folder-trust card is told it was applied while the folder access is denied](bugs/b09282dd-a-session-answer-on-a-folder-trust-card-is-told.md) | sweep/safecell | f4827da6e |
| P2 | fixed | safecell | [Browser upload resolves wrong project file and claims success without selection proof](bugs/d9a3499f-browser-upload-resolves-wrong-project-file-and-c.md) | ux-triage-1011 | 61117661631fb4e2be6450d100354f8a4cb05c72 |
| P2 | fixed | safecell | [A named-file search also returns nested files with the same name](bugs/abc6edf6-named-file-search-returns-nested-namesakes.md) | agent/runtime-triage-1011 | 15c01f97bc930032f7a4e17c79d7481fa1be4ac8 |
| P2 | fixed | safecell | [NTFS stream paths (.env::$DATA, .git::$INDEX_ALLOCATION) write through the protected-file floor](bugs/b59efd21-ntfs-stream-paths-env-data-git-index-allocation.md) | sweep/safecell | 876643da3 |
| P2 | fixed | safecell | [Windows child tools lose required runtime environment and launch directory](bugs/08802e9f-windows-child-tools-lose-required-runtime-enviro.md) | agent/session-handoff-1011 | fc3c9132a |
| P2 | fixed | sessions | [A project forgotten under its open home polls a 404 forever while saying reconnecting](bugs/82537ce6-a-project-forgotten-under-its-open-home-polls-a.md) | sweep/sessions | 121374d64 |
| P2 | fixed | sessions | [A task whose run was stopped reads FINISHED - RESULT READY on the board](bugs/47e83241-a-task-whose-run-was-stopped-reads-finished-resu.md) | sweep/sessions | 898cdd327 |
| P2 | fixed | sessions | [Agent work rating fails with a generic not saved message](bugs/1fc69e6a-agent-work-rating-fails-with-a-generic-not-saved.md) | agent/rating-repair-0908 | a55a1ed07 |
| P2 | fixed | sessions | [Background worker responses leave answered prompts pending](bugs/402ce8f7-background-worker-response-pending.md) | thread-ux-review-1011 | 049e6ff7e7c92b7b0f38ab34ce1eeb9ae30c7833 |
| P2 | fixed | sessions | [COMMS starters suggest arbitrary tasks and lose session context](bugs/e84d1dfd-comms-starters-suggest-arbitrary-tasks-and-lose.md) | agent/useful-starters-0906 | 33d995fed |
| P2 | fixed | sessions | [Context extraction card uses a flat surface outside the current theme](bugs/b87dbc17-context-extraction-card-uses-a-flat-surface-outs.md) | release-0110 | fe5be77a9 |
| P2 | fixed | sessions | [Conversation crowded on short laptop windows](bugs/9f67d884-conversation-crowded-on-short-laptop-windows.md) | small-screen-0917 | edb33201d |
| P2 | fixed | sessions | [Opening old worker work snaps back to the newest chat message](bugs/0afeeb03-delegated-history-navigation.md) | thread-ux-review-1011 | 09e6afba0179fe4aa6930fa5fe5b68a433d4934d |
| P2 | fixed | sessions | [Agent filters hide conversations containing delegated work](bugs/f89911d0-delegated-participant-discovery.md) | thread-ux-review-1011 | 09e6afba0179fe4aa6930fa5fe5b68a433d4934d |
| P2 | fixed | sessions | [A delayed assignment splits one handoff into redundant lead reports](bugs/2da05ff7-delegated-report-batching.md) | thread-ux-review-1011 | 09e6afba0179fe4aa6930fa5fe5b68a433d4934d |
| P2 | fixed | sessions | [Earned XP appears frozen or misses ratings from another window](bugs/6ad254f9-earned-xp-appears-frozen-or-misses-ratings-from.md) | agent/xp-status-0914 | 05a399cf0 |
| P2 | fixed | sessions | [Escape from a terminal field loses the dialog keyboard boundary](bugs/8b2ef7e7-escape-from-a-terminal-field-loses-the-dialog-ke.md) | agent/glass-demo-0909 | e6ecdd986 |
| P2 | fixed | sessions | [Failed session repeats FAILED badge and leaves X steady](bugs/d07d3a35-failed-session-repeats-failed-badge-and-leaves-x.md) | agent/session-failed-marker-0910 | 407ac8433 |
| P2 | fixed | sessions | [Files dropped onto chat do not attach in the desktop app](bugs/b48aa05d-files-dropped-onto-chat-do-not-attach-in-the-des.md) | agent/chat-drop-0917 | 68a4cfabe |
| P2 | fixed | sessions | [Kept style masks a later real rejection after unkeep](bugs/db8f361d-kept-style-masks-a-later-real-rejection-after-un.md) | agent/provider-triage-1011 | 2ce225f88 |
| P2 | fixed | sessions | [Late deliverable preview replaces the current file selection](bugs/b1da69a1-late-deliverable-preview-replaces-the-current-fi.md) | agent/system-polish-0920 | 4a2028759 |
| P2 | fixed | sessions | [Outbox run review can display another run answer](bugs/ecb3df69-outbox-run-review-can-display-another-run-answer.md) | agent/seam-audit-0912-b | b5c5cba75 |
| P2 | fixed | sessions | [Phone conversation and previews expose internal worker repair dialogue](bugs/958a8796-phone-dispatch-repair-history.md) | thread-ux-review-1011 | 18c1ec59f094775ada818175d927e9c4ffc845d8 |
| P2 | fixed | sessions | [Saved rejected worker output survives accepted answer reconciliation](bugs/8ee2341e-saved-rejected-dispatch-history.md) | thread-ux-review-1011 | 4c3d9c3019f8475eae283c62757d7e94a9296fdc |
| P2 | fixed | sessions | [Session recommendations ignore user goals and actual work](bugs/a55c0020-session-recommendations-ignore-user-goals-and-ac.md) | agent/useful-starters-0906 | 51768e661 |
| P2 | fixed | sessions | [Shared query refresh cannot retire a stalled predecessor](bugs/c095c750-shared-query-refresh-cannot-retire-a-stalled-pre.md) | agent/seam-audit-0912-b | b5c5cba75 |
| P2 | fixed | sessions | [Stalled finite JSON mutations never release their callers](bugs/38aad6db-stalled-finite-json-mutations-never-release-thei.md) | agent/systemic-bugs-0919 | 8eb87b0d3 |
| P2 | fixed | sessions | [The fast gate's save-quota-writethrough Q3 precondition flakes when two saves land in one millisecond](bugs/c9c58539-the-fast-gate-s-save-quota-writethrough-q3-preco.md) | sweep/sessions | 0151a2b74 |
| P2 | fixed | sessions | [Spoken approvals clear sibling waits before confirmation](bugs/35c720c1-voice-approval-sibling-settlement.md) | thread-ux-review-1011 | fcd8007ca473d52488986537e304370c37f7f9a0 |
| P2 | fixed | sessions | [Worker recovery rebuilds an unrelated conversation and loses reader state](bugs/abb287e8-worker-recovery-reader-state.md) | thread-ux-review-1011 | a69664135e4983fe624ec11bea6b2bd4666ee651 |
| P2 | fixed | sessions | [Workshop Keep accepts an empty decision acknowledgement](bugs/9bc0b751-workshop-keep-accepts-an-empty-decision-acknowle.md) | agent/system-polish-0920 | 4a2028759 |
| P2 | fixed | skills | [Design references assert requested image properties as observed](bugs/436ab17d-design-references-assert-requested-image-propert.md) | agent/provider-triage-1011 | 2e9c7ffb4 |
| P2 | fixed | skills | [Removed skill support files reappear during hydration](bugs/3e79b690-removed-skill-support-files-reappear-during-hydr.md) | contribution/skills | 0a86ee8f |
| P2 | fixed | skills | [Rolling back an installed skill overrides its pin without an explicit force](bugs/29043870-rolling-back-an-installed-skill-overrides-its-pi.md) | sweep/skills | bd449b81b |
| P2 | fixed | skills | [Skill hydrate has no file-count or byte limit, so 10k files on disk reach the provider in one request](bugs/4ab22e0e-skill-hydrate-has-no-file-count-or-byte-limit-so.md) | sweep/skills | bd449b81b |
| P2 | fixed | voice | [A keyed voice provider slower than the desk's 30s synth ceiling is paid twice for one sentence, which then plays after a minute of silence](bugs/df610df1-a-keyed-voice-provider-slower-than-the-desk-s-30.md) | sweep/voice | 22c36eed6 |
| P2 | fixed | voice | [/api/tts silently truncates a script over 1200 characters and answers 200 audio as if the whole text was spoken](bugs/d41323ed-api-tts-silently-truncates-a-script-over-1200-ch.md) | sweep/voice | 35f80804c |
| P2 | fixed | voice | [Failed Live Voice startup leaves a user mute force-enabled](bugs/d02d029b-failed-live-voice-startup-leaves-a-user-mute-for.md) | agent/voice-release-sweep | 8bc9ff9a |
| P2 | fixed | voice | [Muting the speaker mid-reply in hands-free nulls the only surviving rearm heartbeat — the mic never re-opens while the mode button still reads 'hands-free ON'](bugs/2f7b280c-muting-the-speaker-mid-reply-in-hands-free-nulls.md) | sweep/voice | 50a8b07b |
| P2 | fixed | voice | [Revoked or replaced speech synthesis can publish stale audio](bugs/4fca711c-revoked-speech-synthesis-publishes-stale-audio.md) | agent/runtime-triage-1011 | 1d1a89980717271a2dbbc627088dca2f1c25c1ba |
| P2 | fixed | voice | [The /api/stt degrade reason is written to the status line then overwritten by endListening()'s restore in the same synchronous block, so it is never painted](bugs/562b14a5-the-api-stt-degrade-reason-is-written-to-the-sta.md) | sweep/voice | 50a8b07b |
| P2 | fixed | voice | [The TTS failure classifier reads the whole ladder string: OpenAI insufficient_quota (HTTP 429) is retried on a 4s cold-off, and Gemini's per-minute 429 text pin](bugs/4dea1814-the-tts-failure-classifier-reads-the-whole-ladde.md) | sweep/voice | 4aa163337 |
| P2 | fixed | world | [A COPY section inside a review loop stops the job on its second pass](bugs/45054e87-a-copy-section-inside-a-review-loop-stops-the-jo.md) | conveyor-final-runtime | d3bf4937d |
| P2 | fixed | world | [A goal, step or quest label cut at its cap can end on half an emoji, drawn broken and saved into the station's goal and journey files](bugs/35ee13b3-a-goal-step-or-quest-label-cut-at-its-cap-can-en.md) | quest-fixes | a8f2cf422 |
| P2 | fixed | world | [A hand-off the station's own fault stopped is blamed on E-STOP](bugs/de6f8dc7-a-hand-off-the-station-s-own-fault-stopped-is-bl.md) | conveyor-final-runtime | 20134a0af |
| P2 | fixed | world | [A hand-off whose dispatch throws is dropped with only a console line](bugs/32df5ca7-a-hand-off-whose-dispatch-throws-is-dropped-with.md) | conveyor-final-runtime | 9ccd2ba42 |
| P2 | fixed | world | [A refused hand-off card says not sent on three times](bugs/eb912c5a-a-refused-hand-off-card-says-not-sent-on-three-t.md) | conveyor-final-runtime | a49b5b96e |
| P2 | fixed | world | [After WAKE the create screen's skin preview keeps a 60fps animation loop running behind the station all session](bugs/45468331-after-wake-the-create-screen-s-skin-preview-keep.md) | sweep/world | 589f871c0 |
| P2 | fixed | world | [Agent look-back flicker and waypoint stutter](bugs/e356ce13-agent-look-back-flicker-and-waypoint-stutter.md) | skin-motion-0910 | 75a814c18 |
| P2 | fixed | world | [At phone width the glass topbar keeps the level lamp and clips UPLINK / LINK DOWN off-screen](bugs/13dd465a-at-phone-width-the-glass-topbar-keeps-the-level.md) | sweep/world | 3a89e04f4 |
| P2 | fixed | world | [Backdrop preview baking stalls settings interaction](bugs/63f08158-backdrop-preview-baking-stalls-settings-interact.md) | agent/glass-demo-0909 | db3ae6bb4 |
| P2 | fixed | world | [Battle pass cuts an emoji in half when clipping a long goal title](bugs/d1d77332-battle-pass-cuts-an-emoji-in-half-when-clipping.md) | sweep/battlepass | c1b4a6f59 |
| P2 | fixed | world | [Battle pass days challenge can be impossible late in the week](bugs/a40510a0-battle-pass-days-challenge-can-be-impossible-lat.md) | sweep/battlepass | c1b4a6f59 |
| P2 | fixed | world | [Battle pass hides its points count and reset time in a narrow quest window](bugs/3683ee51-battle-pass-hides-its-points-count-and-reset-tim.md) | sweep/battlepass | c1b4a6f59 |
| P2 | fixed | world | [Battle pass shows last-known points and streak as live while the sidecar is offline](bugs/092cd3a4-battle-pass-shows-last-known-points-and-streak-a.md) | sweep/battlepass | c1b4a6f59 |
| P2 | fixed | world | [Centered room lighting leaves sides dark and creates hotspots](bugs/741832d8-centered-room-lighting-leaves-sides-dark-and-cre.md) | agent/room-lighting-strip | 5f40c3e60 |
| P2 | fixed | world | [Chat numbered lists have excessive vertical spacing](bugs/a9862eb0-chat-numbered-lists-have-excessive-vertical-spac.md) | agent/chat-spacing-0922 | 6fa1477db |
| P2 | fixed | world | [Crew keeps working while awaiting approval](bugs/3c77e050-crew-keeps-working-while-awaiting-approval.md) | doorway-occlusion-0910 | 35d255dbd |
| P2 | fixed | world | [CRT curve displaces agent hover and click targets away from center](bugs/26433ecb-crt-curve-displaces-agent-hover-and-click-target.md) | agent/curve-pointer-0912 | f8b60bef0 |
| P2 | fixed | world | [Custom phosphor theme desaturates approved room lighting](bugs/850fdcfa-custom-phosphor-theme-desaturates-approved-room.md) | agent/room-lighting-strip | ba3e66447 |
| P2 | fixed | world | [DELETE announces success on a failed request and leaves the row — same missing `resp.ok` check in ROUTINES, LOOPS and CONNECTORS](bugs/aa9cd1cd-delete-announces-success-on-a-failed-request-and.md) | sweep/world | 8e68bf5c |
| P2 | fixed | world | [Deleted rooms leave floating furniture](bugs/72da34d7-deleted-rooms-leave-floating-furniture.md) | doorway-occlusion-0910 | 35d255dbd |
| P2 | fixed | world | [Dossier personality EMOJI / BLUNT toggles render as the browser's white checkbox](bugs/ac0122d5-dossier-personality-emoji-blunt-toggles-render-a.md) | sweep/world | ee35dabc6 |
| P2 | fixed | world | [Fifth quest tab (PASS) overflows a narrow quest window on a wide screen](bugs/4e057f0f-fifth-quest-tab-pass-overflows-a-narrow-quest-wi.md) | sweep/battlepass | c1b4a6f59 |
| P2 | fixed | world | [Finished sorter starters leave valid jobs without an OUTBOX](bugs/e5d8daf5-finished-sorter-starters-leave-valid-jobs-withou.md) | conveyor-caps-1012 | 9ac0faeec |
| P2 | fixed | world | [Glass panel height resets after closing and reopening](bugs/12203375-glass-panel-height-resets-on-reopen.md) | audit-0112-0910 | 871561348 |
| P2 | fixed | world | [Joined branch product crates ship before the barrier releases](bugs/4ba4989f-joined-branch-product-crates-ship-before-the-bar.md) | conveyor-caps-1012 | f88c461fb |
| P2 | fixed | world | [Local settings save failure still permits saved confirmation](bugs/476c4f01-local-settings-save-failure-still-permits-saved.md) | agent/seam-audit-0912-b | b5c5cba75 |
| P2 | fixed | world | [`open()` has no `if (chanES) return` guard, so a re-entry (DATA › IMPORT → reentry → enterGame → resumeBridge) inside an SSE retry backoff leaves two live Event](bugs/d459160f-open.md) | sweep/world | f4d03511 |
| P2 | fixed | world | [Parallel line offers a step-through test that cannot finish](bugs/1f4c3e40-parallel-line-offers-a-step-through-test-that-ca.md) | conveyor-finish-1012 | 30cbb0420 |
| P2 | fixed | world | [Prop details crowd out the build catalog at larger UI scales](bugs/e1d9f470-prop-details-crowd-out-the-build-catalog-at-larg.md) | prop-panel-0907 | c6f77fff4 |
| P2 | fixed | world | [Quest log tiny text and undifferentiated card grid](bugs/74be01cc-quest-log-tiny-text-and-undifferentiated-card-gr.md) | agent/quest-journal-revamp | 55a30d5d7 |
| P2 | fixed | world | [Raised room corners excluded from interior lighting](bugs/52397fc0-raised-room-corners-excluded-from-interior-light.md) | agent/room-lighting-strip | 624e58ede |
| P2 | fixed | world | [Recipe Bay caches failed catalog reads as permanent empty successes](bugs/e60f28af-recipe-bay-caches-failed-catalog-reads-as-perman.md) | agent/systemic-bugs-0919 | 8eb87b0d3 |
| P2 | fixed | world | [Recipe Bay deep shelf collapses initial cards into slivers](bugs/8ac0662a-recipe-bay-deep-shelf-collapses-initial-cards-in.md) | release-0110 | fe5be77a9 |
| P2 | fixed | world | [Recipe readiness includes disconnected and unauthorized connectors](bugs/759f281c-recipe-readiness-includes-disconnected-and-unaut.md) | agent/systemic-bugs-0919 | 8eb87b0d3 |
| P2 | fixed | world | [Refit object placement stalls while rebaking unchanged environment](bugs/e725e614-refit-object-placement-stalls-while-rebaking-unc.md) | refit-smooth-0919 | 0afbde0cf |
| P2 | fixed | world | [Remastered prop selection outlines include transparent packing](bugs/30c44acc-remastered-prop-selection-outlines-include-trans.md) | prop-coordination-0914 | 8637c9d8d |
| P2 | fixed | world | [Retired crew leave furniture reserved](bugs/f2bd926a-retired-crew-leave-furniture-reserved.md) | doorway-occlusion-0910 | 35d255dbd |
| P2 | fixed | world | [Roaming agents jam nose to nose in narrow hallways](bugs/2b7a920c-roaming-agents-jam-nose-to-nose-in-narrow-hallwa.md) | hallway-awareness-0917 | 54105ec6c |
| P2 | fixed | world | [Room fixture grids flood edges and corners](bugs/b8594ab9-room-fixture-grids-flood-edges-and-corners.md) | agent/room-lighting-strip | 1525663d0 |
| P2 | fixed | world | [Room lighting loses colour and flickers across the floor](bugs/3365f5ba-room-lighting-loses-colour-and-flickers-across-t.md) | agent/room-lighting-strip | 011ba23a4 |
| P2 | fixed | world | [SEND TO hand-offs waiting when the station quits vanish without a record](bugs/b0c913b9-send-to-hand-offs-waiting-when-the-station-quits.md) | conveyor-final-runtime | 9ccd2ba42 |
| P2 | fixed | world | [Spamming a battle-pass CLAIM plays the level-up sting once per click](bugs/9aa25780-spamming-a-battle-pass-claim-plays-the-level-up.md) | sweep/battlepass | c1b4a6f59 |
| P2 | fixed | world | [Standard text size leaves everyday controls and labels hard to read](bugs/96921b22-standard-text-size-leaves-everyday-controls-and.md) | agent/glass-demo-0909 | bb7df320ebad0f89338818730aba8503f5532091 |
| P2 | fixed | world | [Station backup omits backdrop text size and session row preferences](bugs/f5a90439-station-backup-omits-backdrop-text-size-and-sess.md) | agent/release-ui-audit-0906 | 336919446 |
| P2 | fixed | world | [station.test_line claims an unconfirmed onward hand-off for a failed test](bugs/0d10e82b-station-test-line-claims-an-unconfirmed-onward-h.md) | conveyor-final-runtime | 8968a9269 |
| P2 | fixed | world | [Station tooltip: pointerout during the 320ms show delay cannot clear the pending timer (`if (!anchor) return` runs before hide()), so a ghost card pops up besid](bugs/01caed27-station-tooltip.md) | sweep/world | f4d03511 |
| P2 | fixed | world | [STEP THROUGH stops on two review loops in a row](bugs/670332ae-step-through-stops-on-two-review-loops-in-a-row.md) | conveyor-final-runtime | 28d32bbfa |
| P2 | fixed | world | [Turtle rear walk faces forward and wizard staff flickers](bugs/20a0796e-turtle-rear-walk-faces-forward-and-wizard-staff.md) | skin-motion-0910 | 734063b21 |
| P2 | fixed | world | [Website preview applies retired rendering effects and implies live work](bugs/d0904df1-website-preview-applies-retired-rendering-effect.md) | agent/website-demo-0921 | 8be5cf230 |
| P2 | fixed | world | [Workflow style undo can be overwritten by a delayed keep](bugs/1ee46ab1-workflow-style-undo-can-be-overwritten-by-a-dela.md) | agent/ux-triage-1011 | bf756e00e85172c01c9fc336bd9da69c8183864c |
| P2 | wontfix | autonomy | [Product Line Workbench access differs from a direct interactive run](bugs/4a19c050-product-line-workbench-standing-grant-scope.md) | release-0120-prep-0915 | — |

## Open by surface

| Surface | Open |
| --- | --- |
| channels | 4 |
| autonomy | 3 |
| providers | 10 |
| safecell | 3 |
| sessions | 5 |
| skills | 3 |
| onboarding | 3 |
| world | 1 |
| voice | 2 |
| release | 6 |

