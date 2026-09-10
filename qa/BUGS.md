# QA bug register

**GENERATED — do not hand-edit.** Rebuild with `npm run qa:bugs:index`.
One tracked file per bug under `qa/bugs/`; this is only the index. File a new bug with
`node scripts/qa/bugs.mjs --new --title "..." --surface <surface>`.

**7** open (open+claimed) of 111 total — 0 P0 · 7 P1 · 0 P2

Engineering status is separate from delivery and customer recovery. Legacy rows without origin are not a customer census.

User/owner reports: **50** · source fixed: **43** · installer verified: **1** · customer confirmed: **1** · still reported failing: **1** · recovery unconfirmed: **48**.

| Report | Family | Source | Installer | Customer |
| --- | --- | --- | --- | --- |
| [Customer cannot explain idle behavior and unexpectedly high usage](bugs/acb47320-idle-usage-customer-unexplained.md) | work-and-spend-truth | open | unverified | unconfirmed |
| [Customer reports an ONCE routine absent from Active Routines](bugs/c2a6c3c8-once-routine-reported-missing.md) | durability-and-visibility | open | unverified | unconfirmed |
| [Mac paid onboarding becomes unreachable after reload and relink](bugs/eaaa3ec8-mac-onboarding-unreachable-after-link.md) | recovery-truth | open | unverified | unconfirmed |
| [Funded working station still displays a zero-credit warning](bugs/72af29f4-funded-station-false-zero-warning.md) | recovery-truth | open | unverified | unconfirmed |
| [Managed Sonnet request still returns an uncorrelated HTTP 400](bugs/fd9c4b4d-managed-sonnet-400-unresolved.md) | production-request-truth | open | unverified | persists |
| [Saved equipment omitted from interactive tool projection and toolset diagnostics](bugs/432df352-saved-equipment-omitted-from-interactive-tool-pr.md) | capability-projection | open | unverified | unconfirmed |
| [Customer viewport becomes blank after ten to twenty minutes](bugs/9256a771-viewport-black-after-idle.md) | durability-and-visibility | open | unverified | unconfirmed |
| [Persisted E-STOP cannot be resumed from the desktop control](bugs/8f911536-persisted-e-stop-cannot-be-resumed-from-the-desk.md) | emergency-stop | fixed | unverified | unconfirmed |
| [Connector stays up after an authenticated tool returns 401](bugs/9dc98fa0-connector-401-still-shows-up.md) | recovery-truth | fixed | unverified | unconfirmed |
| [Connector times out waiting for a buffered SSE reply](bugs/11341152-connector-buffered-sse-times-out.md) | protocol-lifecycle | fixed | unverified | unconfirmed |
| [Google account connection asks customers for developer credentials](bugs/e5d4b743-google-account-connection-asks-customers-for-dev.md) | google-sign-in | fixed | unverified | unconfirmed |
| [Valid BYOK wake is blocked by an empty managed wallet](bugs/2b6d70fb-byok-blocked-by-empty-managed-wallet.md) | execution-configuration | fixed | unverified | unconfirmed |
| [Live Doctor overrides selected model reasoning with none](bugs/2a9cb952-doctor-forces-unsupported-reasoning.md) | execution-configuration | fixed | unverified | unconfirmed |
| [Gemini rejects the turn after a tool call loses its signature](bugs/0d63e5d1-gemini-loses-tool-signature.md) | tool-history | fixed | unverified | unconfirmed |
| [Linked StarNet credits cannot authorize image generation](bugs/a9374d2c-linked-starnet-credits-cannot-authorize-image-ge.md) | managed-media | fixed | unverified | unconfirmed |
| [Linked account warning confuses provider quota with disconnection](bugs/6c54d22e-linked-state-confused-with-quota.md) | recovery-truth | fixed | unverified | unconfirmed |
| [Managed chat can use a stale request endpoint](bugs/3195ab5a-managed-chat-can-use-a-stale-request-endpoint.md) | managed-routing | fixed | unverified | unconfirmed |
| [Managed model selection retains the wrong provider identity](bugs/7ed4a93c-managed-selection-keeps-wrong-provider.md) | catalog-truth | fixed | unverified | unconfirmed |
| [Routed OpenRouter conversation fails on orphan tool results](bugs/112199f5-openrouter-orphan-tool-results.md) | tool-history | fixed | unverified | unconfirmed |
| [Ordinary wording incorrectly requires image generation](bugs/b0431c24-ordinary-wording-incorrectly-requires-image-gene.md) | image-intent | fixed | unverified | unconfirmed |
| [Doctor works but sample ignores the saved provider](bugs/c978e7b7-sample-ignores-saved-provider.md) | execution-configuration | fixed | unverified | unconfirmed |
| [Tier picker reports available managed models missing](bugs/ddea3c5d-tiers-ignore-managed-catalog.md) | catalog-truth | fixed | unverified | unconfirmed |
| [File approval hides the proposed edit and patch payload](bugs/48c51661-file-approval-omits-mutation.md) | informed-approval | fixed | unverified | unconfirmed |
| [Add agents silently fails when group backend is unavailable](bugs/0245a284-add-agents-silently-fails-when-group-backend-is.md) | group-chat-picker | fixed | unverified | unconfirmed |
| [Agent session focus commands can unexpectedly retarget the composer](bugs/774641dc-agent-session-focus-commands-can-unexpectedly-re.md) | session-focus | fixed | unverified | unconfirmed |
| [Feedback cards do not identify the run being rated](bugs/c7fa86fc-feedback-run-reference-ambiguous.md) | feedback-attribution | fixed | unverified | unconfirmed |
| [Sent group attachments appear only in the shared shelf](bugs/de0bb232-sent-group-attachments-appear-only-in-the-shared.md) | message-attachments | fixed | unverified | unconfirmed |
| [Live spoken replies stall after the output audio context closes](bugs/3364dfb0-live-spoken-replies-stall-after-the-output-audio.md) | speech-device-recovery | fixed | unverified | unconfirmed |
| [Mac desktop microphone blocked while browser mirror works](bugs/8a553481-mac-desktop-microphone-blocked-while-browser-mir.md) | desktop-microphone | fixed | unverified | unconfirmed |
| [Spoken replies fragment at punctuation and omit failed audio chunks](bugs/e1051446-spoken-replies-fragment-at-punctuation-and-omit.md) | voice-continuity | fixed | unverified | unconfirmed |
| [Agents cross walls beside hallway openings](bugs/49192a68-agents-cross-walls-beside-hallway-openings.md) | doorway-movement | fixed | unverified | unconfirmed |
| [Bay names are unreadable at normal station zoom](bugs/0ff9dfc6-bay-names-are-unreadable-at-normal-station-zoom.md) | bay-labels | fixed | verified | confirmed |
| [Website station preview fails when hosting beacon is blocked](bugs/b3b8d28f-website-station-preview-fails-when-hosting-beaco.md) | deployment-integrity | fixed | not-applicable | unconfirmed |
| [Deliverable naming instruction conflicts with explicit stop limits](bugs/5a35bcfe-deliverable-note-overrides-stop.md) | task-scope | fixed | unverified | unconfirmed |
| [Dense service cards squeeze technical prose into tiny columns](bugs/734b469e-dense-service-cards-squeeze-technical-prose-into.md) | record-readability | fixed | unverified | unconfirmed |
| [Station button redesign escaped the bottom navigation](bugs/d28ba8f4-station-button-redesign-escaped-the-bottom-navig.md) | dock-style-scope | fixed | unverified | unconfirmed |
| [Agent work rating fails with a generic not saved message](bugs/1fc69e6a-agent-work-rating-fails-with-a-generic-not-saved.md) | work-rating | fixed | unverified | unconfirmed |
| [COMMS starters suggest arbitrary tasks and lose session context](bugs/e84d1dfd-comms-starters-suggest-arbitrary-tasks-and-lose.md) | session-starters | fixed | unverified | unconfirmed |
| [Context extraction card uses a flat surface outside the current theme](bugs/b87dbc17-context-extraction-card-uses-a-flat-surface-outs.md) | context-presentation | fixed | unverified | unconfirmed |
| [Session recommendations ignore user goals and actual work](bugs/a55c0020-session-recommendations-ignore-user-goals-and-ac.md) | session-starters | fixed | unverified | unconfirmed |
| [Agent look-back flicker and waypoint stutter](bugs/e356ce13-agent-look-back-flicker-and-waypoint-stutter.md) | movement-continuity | fixed | unverified | unconfirmed |
| [Centered room lighting leaves sides dark and creates hotspots](bugs/741832d8-centered-room-lighting-leaves-sides-dark-and-cre.md) | room-lighting | fixed | unverified | unconfirmed |
| [Custom phosphor theme desaturates approved room lighting](bugs/850fdcfa-custom-phosphor-theme-desaturates-approved-room.md) | room-lighting | fixed | unverified | unconfirmed |
| [Prop details crowd out the build catalog at larger UI scales](bugs/e1d9f470-prop-details-crowd-out-the-build-catalog-at-larg.md) | prop-catalog-layout | fixed | unverified | unconfirmed |
| [Quest log tiny text and undifferentiated card grid](bugs/74be01cc-quest-log-tiny-text-and-undifferentiated-card-gr.md) | quest-journal | fixed | unverified | unconfirmed |
| [Raised room corners excluded from interior lighting](bugs/52397fc0-raised-room-corners-excluded-from-interior-light.md) | room-lighting | fixed | unverified | unconfirmed |
| [Recipe Bay deep shelf collapses initial cards into slivers](bugs/8ac0662a-recipe-bay-deep-shelf-collapses-initial-cards-in.md) | recipe-layout | fixed | unverified | unconfirmed |
| [Room fixture grids flood edges and corners](bugs/b8594ab9-room-fixture-grids-flood-edges-and-corners.md) | room-lighting | fixed | unverified | unconfirmed |
| [Room lighting loses colour and flickers across the floor](bugs/3365f5ba-room-lighting-loses-colour-and-flickers-across-t.md) | room-lighting | fixed | unverified | unconfirmed |
| [Standard text size leaves everyday controls and labels hard to read](bugs/96921b22-standard-text-size-leaves-everyday-controls-and.md) | standard-readability | fixed | unverified | unconfirmed |

| Sev | Status | Surface | Bug | Lane | Fix |
| --- | --- | --- | --- | --- | --- |
| P0 | fixed | autonomy | [After E-STOP the ROUTINES panel still renders "● scheduler armed — routines fire automatically" plus a live countdown; GET /api/cron's `halted` field has zero c](bugs/4962c3ad-after-e-stop-the-routines-panel-still-renders-sc.md) | sweep/autonomy | b7e18ce8 |
| P0 | fixed | onboarding | [Only the skip CHIP is recognized as a skip — the typed word the interview invites ("skip") is stored as a weight:'stated' belief, raising FAMILIARITY, opening t](bugs/e62959ca-only-the-skip-chip-is-recognized-as-a-skip.md) | sweep/onboarding | 6afeb9ee |
| P0 | fixed | providers | [The KEYS-tab UNATTENDED grant is enforced only at web_request — servicekeys.runEnv() has no surface argument, so an unattended shell child receives every ENABLE](bugs/14d4f234-the-keys-tab-unattended-grant-is-enforced-only-a.md) | sweep/providers | 6afeb9ee |
| P0 | fixed | release | [Forward-version gate asserts "no newer build is published yet" for EVERY non-'available' phase — including check 'error' and the busy short-circuit — and the 'u](bugs/9c0664eb-forward-version-gate-asserts-no-newer-build-is-p.md) | sweep/release | 6afeb9ee |
| P0 | fixed | safecell | [The Permissions panel's normalizeGrants regex drops every path: and mcp: standing grant — the ledger prints "No standing approvals yet" while the backend holds](bugs/7274ff21-the-permissions-panel-s-normalizegrants-regex-dr.md) | sweep/safecell | 6afeb9ee |
| P0 | fixed | sessions | [An attachment-bearing user turn is dropped from the durable transcript and the PREVIOUS turn is written in its place — the string-only scan at index.js:11299 fa](bugs/e7dcb889-an-attachment-bearing-user-turn-is-dropped-from.md) | sweep/sessions | 6afeb9ee |
| P0 | fixed | skills | [skill.view's hydrate-then-bump stores the RENDERED SKILL.md as the skill's body, so every view→persist cycle re-appends '## Setup' and '## Support Files' — unbo](bugs/c70f8965-skill-view-s-hydrate-then-bump-stores-the-render.md) | sweep/skills | 598ab4a4 |
| P1 | open | autonomy | [Customer cannot explain idle behavior and unexpectedly high usage](bugs/acb47320-idle-usage-customer-unexplained.md) | reliability-followup | — |
| P1 | open | autonomy | [Customer reports an ONCE routine absent from Active Routines](bugs/c2a6c3c8-once-routine-reported-missing.md) | reliability-followup | — |
| P1 | open | onboarding | [Mac paid onboarding becomes unreachable after reload and relink](bugs/eaaa3ec8-mac-onboarding-unreachable-after-link.md) | reliability-followup | — |
| P1 | open | providers | [Funded working station still displays a zero-credit warning](bugs/72af29f4-funded-station-false-zero-warning.md) | reliability-followup | — |
| P1 | open | providers | [Managed Sonnet request still returns an uncorrelated HTTP 400](bugs/fd9c4b4d-managed-sonnet-400-unresolved.md) | reliability-followup | — |
| P1 | open | providers | [Saved equipment omitted from interactive tool projection and toolset diagnostics](bugs/432df352-saved-equipment-omitted-from-interactive-tool-pr.md) | agent/tool-projection-0909 | — |
| P1 | open | world | [Customer viewport becomes blank after ten to twenty minutes](bugs/9256a771-viewport-black-after-idle.md) | reliability-followup | — |
| P1 | fixed | autonomy | [cron-store's armAt never receives the host defaultTz, so a tz-less cron routine's FIRST nextRunAt is UTC-anchored while every later advance uses local — the mar](bugs/f47a1e3a-cron-store-s-armat-never-receives-the-host-defau.md) | sweep/autonomy | 226cec3c |
| P1 | fixed | autonomy | [Late cancelled loop settlement strands the resumed iteration](bugs/24b375c9-late-cancelled-loop-settlement-strands-the-resum.md) | release-blockers-0907 | 035513a6d |
| P1 | fixed | autonomy | [Concurrent loop approval can retain an approved verdict after rejection reverts the files](bugs/bb24585f-loop-approve-reject-race.md) | agent/adversarial-audit-0910 | 64ed8711b |
| P1 | fixed | autonomy | [Persisted E-STOP cannot be resumed from the desktop control](bugs/8f911536-persisted-e-stop-cannot-be-resumed-from-the-desk.md) | estop-recovery-0907 | acdf5160c |
| P1 | fixed | autonomy | [Result contracts reject useful constraints and API JSON formats are ignored](bugs/bc59eefe-result-contracts-reject-useful-constraints-and-a.md) | hermes-stress-0910 | 61eeac2b40c9fd0e2e0a5d2b342f44de74119078 |
| P1 | fixed | channels | [A lost-race consent tap stamps "▸ ✅ Allow once" onto the message before resolveConsent is asked, so a DENIED request keeps a permanent "approved" record](bugs/64563ad9-a-lost-race-consent-tap-stamps-allow-once-onto-t.md) | sweep/channels | 96fe108d |
| P1 | fixed | channels | [`channel.targets` derives "reachable now" from the adapter handle's existence, so an errored (or still-connecting) channel is reported connected while telegramS](bugs/a199ee3c-channel-targets-derives-reachable-now-from-the-a.md) | sweep/channels | 96fe108d |
| P1 | fixed | channels | [Connector stays up after an authenticated tool returns 401](bugs/9dc98fa0-connector-401-still-shows-up.md) | reliability-followup | 6adda1348 |
| P1 | fixed | channels | [Connector times out waiting for a buffered SSE reply](bugs/11341152-connector-buffered-sse-times-out.md) | reliability-followup | 6adda1348 |
| P1 | fixed | onboarding | [Google account connection asks customers for developer credentials](bugs/e5d4b743-google-account-connection-asks-customers-for-dev.md) | agent/google-account-signin | cb8385c56 |
| P1 | fixed | providers | [Valid BYOK wake is blocked by an empty managed wallet](bugs/2b6d70fb-byok-blocked-by-empty-managed-wallet.md) | reliability-followup | 5b5f50a1d |
| P1 | fixed | providers | [Compatible API hides partial run failures and limits](bugs/ecd235e6-compatible-api-hides-partial-run-failures-and-li.md) | hermes-stress-0910 | f952835ab7e078d0f9dae490cbb52e7b9c8cc29f |
| P1 | fixed | providers | [Compatible API retries dispatch duplicate agent runs](bugs/8d0e29aa-compatible-api-retries-dispatch-duplicate-agent.md) | hermes-stress-0910 | 4d5ee74c170330c977c766f6be200ffb4313f95c |
| P1 | fixed | providers | [Live Doctor overrides selected model reasoning with none](bugs/2a9cb952-doctor-forces-unsupported-reasoning.md) | report-0110-0908 | 72a8a3043c263cd53ed353daed2042e256c8e236 |
| P1 | fixed | providers | [Gemini rejects the turn after a tool call loses its signature](bugs/0d63e5d1-gemini-loses-tool-signature.md) | reliability-followup | fe30cc1b4 |
| P1 | fixed | providers | [Image generation can write an output after run cancellation](bugs/a0dffdd7-image-generation-writes-after-run-cancellation.md) | audit-0112-0910 | d503f00c5 |
| P1 | fixed | providers | [Late model catalog response overwrites a newer provider selection](bugs/1600dcf0-late-model-catalog-reverts-new-provider-choice.md) | audit-0112-0910 | 59b5f2462 |
| P1 | fixed | providers | [Linked StarNet credits cannot authorize image generation](bugs/a9374d2c-linked-starnet-credits-cannot-authorize-image-ge.md) | managed-image-repair-0909 | 05fbfbd28 |
| P1 | fixed | providers | [Linked account warning confuses provider quota with disconnection](bugs/6c54d22e-linked-state-confused-with-quota.md) | reliability-followup | 756ebec88 |
| P1 | fixed | providers | [Managed chat can use a stale request endpoint](bugs/3195ab5a-managed-chat-can-use-a-stale-request-endpoint.md) | managed-endpoint-0909 | 177a9384e |
| P1 | fixed | providers | [Managed image charge is omitted from run cost receipts](bugs/79867817-managed-image-charge-missing-from-run-cost.md) | audit-0112-0910 | d503f00c5 |
| P1 | fixed | providers | [Managed model selection retains the wrong provider identity](bugs/7ed4a93c-managed-selection-keeps-wrong-provider.md) | reliability-followup | 17b9e1341 |
| P1 | fixed | providers | [No quota-exhaustion error class exists: a 429 from a spent Codex/subscription weekly quota renders as 'the provider is busy — wait a few seconds' and burns up t](bugs/e89317af-no-quota-exhaustion-error-class-exists.md) | sweep/providers | fdbb12a2 |
| P1 | fixed | providers | [Routed OpenRouter conversation fails on orphan tool results](bugs/112199f5-openrouter-orphan-tool-results.md) | reliability-followup | 14f34372a |
| P1 | fixed | providers | [Ordinary wording incorrectly requires image generation](bugs/b0431c24-ordinary-wording-incorrectly-requires-image-gene.md) | image-intent-0909 | e6cdd0f1a |
| P1 | fixed | providers | [Doctor works but sample ignores the saved provider](bugs/c978e7b7-sample-ignores-saved-provider.md) | reliability-followup | e33914cb2 |
| P1 | fixed | providers | [Tier picker reports available managed models missing](bugs/ddea3c5d-tiers-ignore-managed-catalog.md) | reliability-followup | e33914cb2 |
| P1 | fixed | release | [Dismissed frame name suppresses unrelated visual changes](bugs/8993bb79-dismissed-frame-name-suppresses-unrelated-visual.md) | cleanup-0112-0910 | 0a3a605a9c41ecf944760782a4938ec442d02e6c |
| P1 | fixed | release | [Filtered journey run can replace the full release journey receipt](bugs/3d9dce85-filtered-journey-run-can-replace-the-full-releas.md) | agent/release-ui-audit-0906 | 042394b7d |
| P1 | fixed | release | [migrate_workspace_data writes the .migrated marker unconditionally and drops copy_missing_dir's Err with no log — a partial legacy migration is permanent and lo](bugs/f42a5f46-migrate-workspace-data-writes-the-migrated-marke.md) | sweep/release | 5f8aa7ce |
| P1 | fixed | release | [Reconciler mistakes related repairs for reported bug resolution](bugs/7528f593-related-fix-prose-promotes-customer-report.md) | reliability-audit | ef5585145 |
| P1 | fixed | release | [release-cut.mjs stages latest.json with no cryptographic signature check, and no downstream gate does one either — t1 checks .sig mtime, t5 text-compares it, ve](bugs/26af4a9a-release-cut-mjs-stages-latest-json-with-no-crypt.md) | sweep/release | b315063b |
| P1 | fixed | release | [Swallowed errors can expose credentials in console warnings](bugs/a03ea726-swallowed-errors-can-expose-credentials-in-conso.md) | cleanup-0112-0910 | 0a3a605a9c41ecf944760782a4938ec442d02e6c |
| P1 | fixed | safecell | [An errored /api/projects is rendered as a CONFIRMED EMPTY trust ledger ("NO TRUSTED PROJECTS") and silently wipes the persisted project scope](bugs/e05cdba8-an-errored-api-projects-is-rendered-as-a-confirm.md) | sweep/safecell | ed200caa |
| P1 | fixed | safecell | [File approval hides the proposed edit and patch payload](bugs/48c51661-file-approval-omits-mutation.md) | report-0110-0908 | 72a8a3043c263cd53ed353daed2042e256c8e236 |
| P1 | fixed | safecell | [The Projects rail's ADD doorway records a NON-canonical path grant, so blessing a folder reached through a junction/symlink reports success and grants nothing](bugs/cf0cd4cd-the-projects-rail-s-add-doorway-records-a-non-ca.md) | sweep/safecell | 226cec3c |
| P1 | fixed | sessions | [Add agents silently fails when group backend is unavailable](bugs/0245a284-add-agents-silently-fails-when-group-backend-is.md) | comms-add-agents-0906 | cf6b3ca03c372c404bcb46997a56d570d7747d70 |
| P1 | fixed | sessions | [Agent session focus commands can unexpectedly retarget the composer](bugs/774641dc-agent-session-focus-commands-can-unexpectedly-re.md) | session-switch-investigation-0909 | 086a74ba5d499f74d1829978291eeadeb22848f5 |
| P1 | fixed | sessions | [checkpoint snapshot() uses the SYNC loadIndex despite being async — after an index+bak loss it re-stamps a 1-entry index that permanently blocks the git rebuild](bugs/d5621e9b-checkpoint-snapshot.md) | sweep/sessions | b315063b |
| P1 | fixed | sessions | [COMMS loses report tables list hierarchy quotes and named links](bugs/70860aa8-comms-loses-report-tables-list-hierarchy-quotes.md) | hermes-stress-0910 | 19e6aebded46145b75525616bdc384c976b6fe56 |
| P1 | fixed | sessions | [Feedback cards do not identify the run being rated](bugs/c7fa86fc-feedback-run-reference-ambiguous.md) | report-0110-0908 | 72a8a3043c263cd53ed353daed2042e256c8e236 |
| P1 | fixed | sessions | [Adding a participant to a direct conversation discards its existing attachments](bugs/408a0794-group-conversion-loses-attachments.md) | agent/adversarial-audit-0910 | 64ed8711b |
| P1 | fixed | sessions | [Retry duplicates the user message after restart](bugs/b30c1c8e-retry-duplicates-the-user-message-after-restart.md) | overnight-retry-history-0907 | 1611844713cfb4d88061ace1f786040436c59605 |
| P1 | fixed | sessions | [Sent group attachments appear only in the shared shelf](bugs/de0bb232-sent-group-attachments-appear-only-in-the-shared.md) | release-0110 | fe5be77a9 |
| P1 | fixed | sessions | [An older client can erase newer conversations by saving its stale snapshot with a fresh timestamp](bugs/7546cccd-stale-client-save-overwrite.md) | agent/adversarial-audit-0910 | 64ed8711b |
| P1 | fixed | sessions | [Workshop reports a completed web tool when its entry file is missing](bugs/097269b5-workshop-reports-a-completed-web-tool-when-its-e.md) | agent/release-ui-audit-0906 | 44a8c3006 |
| P1 | fixed | skills | [gate.verify()'s tamper branch re-enters decide(), which clears the tamper against the STALE stored contentDigest — one approval permanently blesses whatever is](bugs/76d5dc8a-gate-verify.md) | sweep/skills | 598ab4a4 |
| P1 | fixed | voice | [A stale sidecar token lets Local Live open a silent microphone session after restart](bugs/ff73b79a-a-stale-sidecar-token-lets-local-live-open-a-sil.md) | agent/voice-release-sweep | 8bc9ff9a |
| P1 | fixed | voice | [Live spoken replies stall after the output audio context closes](bugs/3364dfb0-live-spoken-replies-stall-after-the-output-audio.md) | agent/live-speech-0910 | f129e19e3 |
| P1 | fixed | voice | [Mac desktop microphone blocked while browser mirror works](bugs/8a553481-mac-desktop-microphone-blocked-while-browser-mir.md) | agent/voice-agents-mac-0906 | d65f8f538 |
| P1 | fixed | voice | [On a zero-key station every Edge blip is misclassified as 'no key': no retry, a 60s dead-voice cold-off, and a tooltip demanding a credential the station never](bugs/151c8d9a-on-a-zero-key-station-every-edge-blip-is-misclas.md) | sweep/voice | 50a8b07b |
| P1 | fixed | voice | [Spoken replies fragment at punctuation and omit failed audio chunks](bugs/e1051446-spoken-replies-fragment-at-punctuation-and-omit.md) | agent/voice-continuity-0909 | 7e83246fa |
| P1 | fixed | voice | [transcribe() never checks r.ok, so any non-JSON /api/stt error (stale-token 403, 5xx, HTML) is laundered into a confirmed-empty transcript and the spoken senten](bugs/1aa7faf6-transcribe.md) | sweep/voice | 50a8b07b |
| P1 | fixed | voice | [Voice.init (agent focus / persona change / dossier apply) calls reflectToggle without clearing fbNotified, permanently wiping the pinned degrade tooltip while t](bugs/562c293e-voice-init.md) | sweep/voice | 50a8b07b |
| P1 | fixed | world | [A Meeseeks helper sprite whose terminal `task` event is lost stays asserted LIVE forever — the ledger has no TTL, no snapshot reconcile, and no reset on NEW AGE](bugs/c96c4d41-a-meeseeks-helper-sprite-whose-terminal-task-eve.md) | sweep/world | meeseeks layer removed 2026-07-30 (agent/meeseeks-visual) |
| P1 | fixed | world | [Agents cross walls beside hallway openings](bugs/49192a68-agents-cross-walls-beside-hallway-openings.md) | doorway-occlusion-0910 | a22f780e3 |
| P1 | fixed | world | [Bay names are unreadable at normal station zoom](bugs/0ff9dfc6-bay-names-are-unreadable-at-normal-station-zoom.md) | release-0110 | 86560bea9 |
| P1 | fixed | world | [ROUTINES › REVOKE ACCESS toasts "access revoked" (green) on a 4xx/5xx — bare `fetch` resolves, so the unattended grant survives its own success message](bugs/fd0f7223-routines-revoke-access-toasts-access-revoked.md) | sweep/world | 3f0d1205 |
| P1 | fixed | world | [Website station preview fails when hosting beacon is blocked](bugs/b3b8d28f-website-station-preview-fails-when-hosting-beaco.md) | website-station-boot-0905 | 27560918e |
| P2 | fixed | autonomy | [Cancelled edit starts a replacement language server](bugs/37059128-cancelled-edit-starts-a-replacement-language-ser.md) | reliability-audit | 547dd03d7 |
| P2 | fixed | autonomy | [Deliverable naming instruction conflicts with explicit stop limits](bugs/5a35bcfe-deliverable-note-overrides-stop.md) | report-0110-0908 | 72a8a3043c263cd53ed353daed2042e256c8e236 |
| P2 | fixed | autonomy | [routine.create's default `arm:true` bypasses the documented single resume seam and clears the durable cron E-STOP — the workshop auto-arm path at index.js:8214](bugs/300b34ab-routine-create-s-default-arm.md) | sweep/autonomy | 6afeb9ee |
| P2 | fixed | channels | [Dense service cards squeeze technical prose into tiny columns](bugs/734b469e-dense-service-cards-squeeze-technical-prose-into.md) | agent/ui-density-audit | 221775a85 |
| P2 | fixed | channels | [E-STOP silences the channel reply path via the supersede flag, so a deliberately stopped run is indistinguishable from a crashed bot on the phone](bugs/600f4982-e-stop-silences-the-channel-reply-path-via-the-s.md) | sweep/channels | 96fe108d |
| P2 | fixed | channels | [Station button redesign escaped the bottom navigation](bugs/d28ba8f4-station-button-redesign-escaped-the-bottom-navig.md) | agent/comms-controls-0906 | e4e4512b198279e35cdd9f2cc2be9d786b02e87f |
| P2 | fixed | providers | [BYOK image recovery omits the supported OpenRouter key option](bugs/3a2837bd-byok-image-recovery-only-offers-paid-link.md) | audit-0112-0910 | d503f00c5 |
| P2 | fixed | providers | [credPool.penalize() on the run's PRIMARY key is inert — the sole credPool.order() call site (index.js:10580) receives a pool with runKey filtered out](bugs/8d7b0b52-credpool-penalize.md) | sweep/providers | fdbb12a2 |
| P2 | fixed | providers | [The index.js summarize closure captures the pre-failover provider/model — after a credential rotation or provider fallback, two failed summaries flip compaction](bugs/cb8dc6c3-the-index-js-summarize-closure-captures-the-pre.md) | sweep/providers | fdbb12a2 |
| P2 | fixed | providers | [The ledger's `unmetered` flag is a stamped verdict with zero readers — every ledger USD aggregate (/api/budget, day/global caps) counts subscription dollars tha](bugs/4007eb1f-the-ledger-s-unmetered-flag-is-a-stamped-verdict.md) | sweep/providers | fdbb12a2 |
| P2 | fixed | release | [HTTP gate watchdog expires before the full suite finishes](bugs/0c148510-http-gate-watchdog-expires-before-the-full-suite.md) | cleanup-0112-0910 | 5262e4a2943e72e2ce147f6fa804fd1b859df211 |
| P2 | fixed | release | [Hydration regression depends on host scheduling](bugs/4bc5d562-hydration-regression-depends-on-host-scheduling.md) | cleanup-0112-0910 | 5262e4a2943e72e2ce147f6fa804fd1b859df211 |
| P2 | fixed | release | [t5.1 prerequisite gate accepts T0–T4 verdicts with no installer-hash or freshness binding, though t3.2 already binds T0's recorded installer sha256 to the binar](bugs/4bd953e0-t5-1-prerequisite-gate-accepts-t0-t4-verdicts-wi.md) | sweep/release | b76e340c |
| P2 | fixed | safecell | [A mid-run "Full access" click writes a per-agent '*' wildcard with no readout and no revoke anywhere, and the same wildcard is read by that agent's UNATTENDED r](bugs/13646d93-a-mid-run-full-access-click-writes-a-per-agent-w.md) | sweep/safecell | 226cec3c |
| P2 | fixed | sessions | [Agent work rating fails with a generic not saved message](bugs/1fc69e6a-agent-work-rating-fails-with-a-generic-not-saved.md) | agent/rating-repair-0908 | a55a1ed07 |
| P2 | fixed | sessions | [COMMS starters suggest arbitrary tasks and lose session context](bugs/e84d1dfd-comms-starters-suggest-arbitrary-tasks-and-lose.md) | agent/useful-starters-0906 | 33d995fed |
| P2 | fixed | sessions | [Context extraction card uses a flat surface outside the current theme](bugs/b87dbc17-context-extraction-card-uses-a-flat-surface-outs.md) | release-0110 | fe5be77a9 |
| P2 | fixed | sessions | [Escape from a terminal field loses the dialog keyboard boundary](bugs/8b2ef7e7-escape-from-a-terminal-field-loses-the-dialog-ke.md) | agent/glass-demo-0909 | e6ecdd986 |
| P2 | fixed | sessions | [Session recommendations ignore user goals and actual work](bugs/a55c0020-session-recommendations-ignore-user-goals-and-ac.md) | agent/useful-starters-0906 | 51768e661 |
| P2 | fixed | voice | [Failed Live Voice startup leaves a user mute force-enabled](bugs/d02d029b-failed-live-voice-startup-leaves-a-user-mute-for.md) | agent/voice-release-sweep | 8bc9ff9a |
| P2 | fixed | voice | [Muting the speaker mid-reply in hands-free nulls the only surviving rearm heartbeat — the mic never re-opens while the mode button still reads 'hands-free ON'](bugs/2f7b280c-muting-the-speaker-mid-reply-in-hands-free-nulls.md) | sweep/voice | 50a8b07b |
| P2 | fixed | voice | [The /api/stt degrade reason is written to the status line then overwritten by endListening()'s restore in the same synchronous block, so it is never painted](bugs/562b14a5-the-api-stt-degrade-reason-is-written-to-the-sta.md) | sweep/voice | 50a8b07b |
| P2 | fixed | world | [Agent look-back flicker and waypoint stutter](bugs/e356ce13-agent-look-back-flicker-and-waypoint-stutter.md) | skin-motion-0910 | 75a814c18 |
| P2 | fixed | world | [Backdrop preview baking stalls settings interaction](bugs/63f08158-backdrop-preview-baking-stalls-settings-interact.md) | agent/glass-demo-0909 | db3ae6bb4 |
| P2 | fixed | world | [Centered room lighting leaves sides dark and creates hotspots](bugs/741832d8-centered-room-lighting-leaves-sides-dark-and-cre.md) | agent/room-lighting-strip | 5f40c3e60 |
| P2 | fixed | world | [Custom phosphor theme desaturates approved room lighting](bugs/850fdcfa-custom-phosphor-theme-desaturates-approved-room.md) | agent/room-lighting-strip | ba3e66447 |
| P2 | fixed | world | [DELETE announces success on a failed request and leaves the row — same missing `resp.ok` check in ROUTINES, LOOPS and CONNECTORS](bugs/aa9cd1cd-delete-announces-success-on-a-failed-request-and.md) | sweep/world | 8e68bf5c |
| P2 | fixed | world | [Glass panel height resets after closing and reopening](bugs/12203375-glass-panel-height-resets-on-reopen.md) | audit-0112-0910 | 871561348 |
| P2 | fixed | world | [`open()` has no `if (chanES) return` guard, so a re-entry (DATA › IMPORT → reentry → enterGame → resumeBridge) inside an SSE retry backoff leaves two live Event](bugs/d459160f-open.md) | sweep/world | f4d03511 |
| P2 | fixed | world | [Prop details crowd out the build catalog at larger UI scales](bugs/e1d9f470-prop-details-crowd-out-the-build-catalog-at-larg.md) | prop-panel-0907 | c6f77fff4 |
| P2 | fixed | world | [Quest log tiny text and undifferentiated card grid](bugs/74be01cc-quest-log-tiny-text-and-undifferentiated-card-gr.md) | agent/quest-journal-revamp | 55a30d5d7 |
| P2 | fixed | world | [Raised room corners excluded from interior lighting](bugs/52397fc0-raised-room-corners-excluded-from-interior-light.md) | agent/room-lighting-strip | 624e58ede |
| P2 | fixed | world | [Recipe Bay deep shelf collapses initial cards into slivers](bugs/8ac0662a-recipe-bay-deep-shelf-collapses-initial-cards-in.md) | release-0110 | fe5be77a9 |
| P2 | fixed | world | [Room fixture grids flood edges and corners](bugs/b8594ab9-room-fixture-grids-flood-edges-and-corners.md) | agent/room-lighting-strip | 1525663d0 |
| P2 | fixed | world | [Room lighting loses colour and flickers across the floor](bugs/3365f5ba-room-lighting-loses-colour-and-flickers-across-t.md) | agent/room-lighting-strip | 011ba23a4 |
| P2 | fixed | world | [Standard text size leaves everyday controls and labels hard to read](bugs/96921b22-standard-text-size-leaves-everyday-controls-and.md) | agent/glass-demo-0909 | bb7df320ebad0f89338818730aba8503f5532091 |
| P2 | fixed | world | [Station backup omits backdrop text size and session row preferences](bugs/f5a90439-station-backup-omits-backdrop-text-size-and-sess.md) | agent/release-ui-audit-0906 | 336919446 |
| P2 | fixed | world | [Station tooltip: pointerout during the 320ms show delay cannot clear the pending timer (`if (!anchor) return` runs before hide()), so a ghost card pops up besid](bugs/01caed27-station-tooltip.md) | sweep/world | f4d03511 |

## Open by surface

| Surface | Open |
| --- | --- |
| channels | 0 |
| autonomy | 2 |
| providers | 3 |
| safecell | 0 |
| sessions | 0 |
| skills | 0 |
| onboarding | 1 |
| world | 1 |
| voice | 0 |
| release | 0 |

