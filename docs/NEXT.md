# NEXT.md — current priorities & task queue

## IN PROGRESS — 2026-09-09 tool projection integration (agent/tool-projection-0909)

Owner authorized repair and merge. Source repair 3c95b184f preserves saved room equipment when
an interactive client omits placement, preserves explicit empty placement, and corrects toolset
agent/lead disclosure. Fast 735/735 and HTTP 108/108 passed; customer journeys and integration
checks are in progress. Customer report 432df352 remains open for the uncorrelated Trusted Project
symptom; installer and reporter recovery are unverified. Receipt: qa/digests/2026-09-09-tool-projection.md.

## MERGED — 2026-09-09 voice continuity (`agent/voice-continuity-0909`)

Owner authorized sentence buffering, ordered audio recovery, cutoff diagnostics, noise-onset investigation and merge. Plan: docs/VOICE_CONTINUITY_PLAN_2026-09-09.md. Customer record: e1051446. Merged ab1cd74be; fast 734/734 before and after merge; customer journeys 33/33. Real Kokoro synthesis and browser playback completed. Installer and acoustic recovery remain unverified.

## DONE — 2026-09-08 legacy rating save repair (agent/rating-repair-0908)

Own lane: preserve legacy station identity on resume and surface rating failure reasons.
Before/after real UI and same-run HTTP proof recorded in bug 1fc69e6a; source fix a55a1ed07.
Integrated candidate gates: fast 733/733 and HTTP 105/105 passed. Customer installer recovery remains unverified.



## MERGED — 2026-09-06 per-agent voices and Mac microphone (`agent/voice-agents-mac-0906`)

Owner requested distinct voices per agent and relayed a MacBook Pro M1 Max report where
Speak/Hands-Free Mic work only in the browser mirror. Commits `d65f8f538` and `3d3c1ff12`
add stable-ID voice assignments under Settings → Live Voice, per-speaker call identity locks,
spoken direct replies for specialists, and the missing macOS hardened-runtime audio-input
entitlement. Release CI checks the actual signed app entitlement and microphone purpose string.

Live seeded UI on :9196 proved NOVA/Bella and VOICE TEST/George independently, retained both
through sidecar restart + page reload, and restored station-default inheritance on clear.
Real authenticated TTS returned distinct Kokoro WAVs for the same phrase. No browser warnings,
errors, or native control paint. Fast: 725/725; HTTP: 101/101; customer journeys: 29/29, all exit 0.

Merged as `ac051bd84`; post-merge fast 725/725 and HTTP 101/101 passed. Integration receipt: `qa/STATUS.md`. Signed Mac allow/deny/reset/restart and customer recovery remain unverified; report
`8a553481` stays open. Receipt: `qa/digests/2026-09-06-agent-voices-mac.md`.

## DONE — 2026-09-06 Add agents integration (`agent/comms-add-agents-0906`)

Owner requested merging the verified COMMS picker repair. It opens before network work,
shows unavailable-backend errors with Retry, and ignores late results after Cancel.
Merged as `ceafd9c67`; fast gate passed 725/725 before and after integration. Live port 9177
now opens the picker and lists the crew. Existing QA status and Rooms handoff edits were
preserved. Bug record: `0245a284`; receipt: `qa/digests/2026-09-06-add-agents.md`.

## DONE — 2026-09-06 release UI audit integration (`agent/release-ui-audit-0906`)

Owner authorized merging the two audited repairs: complete appearance backups and full-suite
journey receipts. Synced with trunk `b8f8e8dd6`, then fast-forwarded the exact verified candidate
`f4baf0d20` into integration. Fast gate passed 724/724 before and after merge; full live journeys
passed 130/130 with `fullSuite:true` on that same SHA. Real backup export/import retained appearance
through sidecar restart; merged extension editors and catalog sign-in filter passed live.
Seven P1 release findings remain open. Unrelated QA status and Rooms handoff bytes were preserved.
Audit and merge receipts: `docs/RELEASE_UI_AUDIT_2026-09-06.md`; digest in `qa/STATUS.md`.

## IN PROGRESS — 2026-09-05 paid first-run recovery (`agent/paid-first-run`)

Owner requested fresh assessment and execution of the subscription/credit purchaser recovery
plan. Source repair `c364e991d` fences stale pairing, keychain recovery and account status
responses; preserves a one-shot link confirmation across a transient disk failure; bounds
identity recovery through body consumption; separates observed balance from optimistic
admission holds; and adds sanitized paid-account/run correlation to copied diagnostics.

Done means linking, interruption, explicit unlink, relink and restart retain the chosen
account in the real app; a current funded balance is never replaced by an old account or
local reservation; errors carry usable correlation; fast/HTTP gates pass. Full customer
closure additionally requires the affected installed Windows/Apple Silicon behavior and
production Sonnet trace. The three original reports remain open pending that evidence.
Execution receipt: `qa/digests/2026-09-05-paid-first-run.md`.

## DONE — 2026-09-05 life-goal progression (`agent/life-goal-progression`)

Owner request: plan and execute a goal-centered leveling and quest loop.

1. Separate completed planned actions from achieved life outcomes. Store success conditions;
   require explicit Commander outcome evidence; retain existing earned history.
2. Give Commander progression its own durable, deduplicated achievement points and headline
   level; keep crew feedback XP separate. Credit intermediate goal-linked actions/metrics.
3. Feed goal metrics, evidence, and blocker feedback into quest refresh. Add bounded reactive
   refresh, durable later/blocked/too-big/resume, and explicit real-world action reporting.
4. Connect the quest-log UI to those APIs, including user-performed milestone reporting,
   extending a completed plan, and specific achievement receipts.
5. Verify action -> evidence -> next step -> goal confirmation -> station evolution in the
   seeded running app, repeat reads after restart, then fast/http gates and integration.

Done means a completed plan leaves the goal active; a reported real-world action advances
the plan with labelled evidence; a recorded metric informs planning; explicit goal outcome
confirmation advances Commander level and station evolution exactly once, surviving restart.

Implemented: explicit success conditions and goal confirmation, manual goal creation with one
or more steps, focus switching, extending plans, user-performed action reports, Commander
achievement progression, metric checkpoint dedupe, adaptive quest evidence, and defer/resume.
Independent review corrected assigned-agent attribution for user actions, lost registration
responses, and active-plan preservation when history is capped.

Live seeded proof (`node dev/life-goal-proof.mjs`, :9143): three action reports left the goal
active at 100% of plan and 30 points; metrics reached the model directive; a generated quest
paused, resumed, and completed from a user report; explicit goal confirmation produced 160
points, Commander Lv 2, and evolution stage 1. Restart preserved those values and repeat
confirmation minted nothing. Browser warning/exception lists and native-control paint count
were empty. The provider was a local deterministic mock, so real-provider recommendation
quality and installed-desktop behavior remain unverified. Pre-merge gates passed: 722/722
fast and 99/99 HTTP. The combined website-repair candidate also passed 722/722 fast and
the live restart proof. Merged as `46b944c11`; post-merge gates passed 722/722 fast and
99/99 HTTP, exit 0. Unrelated QA notes and the Rooms handoff were preserved.
See `docs/LIFE_GOAL_PROGRESSION_2026-09-05.md`. No installed-app or release claim.

## DONE — 2026-09-05 group chat integration (`agent/group-dm-plan-0904`)

Merged as `6002f57f5` after synchronizing with conversation trunk `368d6a8b9`.
Pre-merge and post-merge gates both passed 721/721 fast and 99/99 HTTP, exit 0.
Conversational question drafts and normal-composer answers passed live restart/answer
verification on :9137. Existing uncommitted QA status and Rooms handoff bytes were
preserved. Integration window released; preview worktree retained for user testing.
See `docs/GROUP_CHAT_MERGE_2026-09-05.md`. No installed-app or release claim.

## DONE — 2026-09-05 conversational task context (`agent/rec-vision-audit-0905`)

Owner approved concrete experience questions, whole-answer extraction, adaptive follow-ups,
draft-led clarification, and stopping when the next useful action is clear, with a better COMMS UI.
Extend the durable Task Brief and existing clarify/answer path. Keep choices optional, show cited
working understanding separately from assumptions, preserve long answers and restart continuity,
and honor a single use-your-judgment escape. Legacy choice callers remain compatible.
Verified: live open question -> rich answer -> grounded adaptive follow-up/sample -> proceed; simple
requests run immediately; restart restores the pending conversation without answering it itself.
Combined branch passed 719/719 fast and 98/98 HTTP, with themed UI/keyboard/narrow-layout checks.
Merged as `b62ccd22a`; post-merge fast 719/719 and HTTP 98/98 both passed, exit 0.
See `qa/task-context-conversation-0905.md`. Existing QA status and Rooms handoff bytes were preserved.

## DONE — 2026-09-05 platform connection integration (`agent/platform-handoff-0905`)

Connector task continuation, saved browser-profile contention, and Google account identity were
integrated with current station workflows and the Hermes reliability lane. Joint production trunk
`c2a62eeb9` passed post-merge fast 716/716 and HTTP 96/96, both exit 0. Seeded live task
restart/continuation and real-Chrome saved-cookie reuse passed on the identical production source.
Unrelated QA status and Rooms handoff bytes were preserved; merge receipts belong in `qa/STATUS.md`.
Production Google OAuth provisioning and installed-app release remain outside this local merge.
Details and local evidence paths: `docs/PLATFORM_CONNECTION_FOLLOWTHROUGH.md`.

## DONE — 2026-09-05 repeated-work takeover (`agent/rec-vision-audit-0905`)

Plan: use durable task briefs joined to completed run evidence to detect the same bounded workflow
on at least three separate occasions. Exclude retries/corrections, failed/internal runs, conflicting
targets and existing routines. Offer one evidence-backed takeover through the existing routine beat;
acceptance opens the existing editable routine draft with the original agent, sources and instructions.
The user chooses the cadence and confirms creation; no schedule is inferred from counts. Persist
offer/defer/never decisions, honor paused/forgotten personalization, and suppress scheduled workflows.

Done means: in a seeded live station, repeated completed requests earn a concrete takeover card;
review opens a prefilled routine draft, confirmation creates exactly one real scheduler job, and
restart retains the job/decision without another offer. Negative scenarios remain silent. Focused,
fast and HTTP gates pass before the user-authorized merge. Use existing scheduler execution and
authority, with no new agent loop or capability unlock. Preserve unrelated trunk work.

Implemented and source-app verified: takeover card -> evidence-backed editable draft -> confirmed
Monday routine -> successful scheduler result -> restart without another offer. Branch gates:
714/714 fast and 96/96 HTTP steps green. See `qa/workflow-takeover-0905.md` for fixture boundaries
and run receipts. Post-merge gate result belongs in `qa/STATUS.md`.


## DONE — 2026-09-05 approved world/UI integration (`agent/world-visual-audit-0904`)

Owner approved the custom station and all six UI upgrades for immediate integration. Combined with
trunk `010a6b50f`, verified, and fast-forwarded into trunk at `6085f26b8`: 712/712 fast steps green
(extended timeout), 21 live UI checks, no browser exceptions. The integrated tree exactly matched
the verified candidate. Capability badges preserve the newer per-agent effective-authority model;
Refit keeps both the selected sprite preview and equipment explanations. The custom demo and review
remain on ports 9177 and 9178. Unrelated, uncommitted QA status and Rooms handoff files were hash-checked
and preserved. No installed binary, publication, or project-wide readiness claim.

## 2026-09-05 — HERMES RECONNECT + WEBSITE LOOKUP (`agent/hermes-reconnect-capture-0905`)

Implemented bounded SSE replay (1,024 events / 2 MiB), boot-scoped cursors, duplicate suppression,
obsolete-connection guards, and authoritative snapshot recovery. `station.command` is never replayed:
reconnecting cannot retry a renderer mutation that already executed or timed out. Recovery stays
visibly degraded until a snapshot succeeds. The shipped website renderer mirror stays identical.

`browser.network({deriveReadClient:true})` now derives up to eight runnable GET Fetch/XHR clients
from successful observed requests. No cookies, headers or bodies are captured; signed/credential
query parameters are excluded. Generated clients reject redirects, HTTP failures, non-JSON data,
and oversized responses. The bundled **Learn a Website Lookup** procedure requires comparison
against the live page before saving a runtime skill and its script through `skill.manage`.
This first slice covers read-only JSON lookups, not authenticated or mutating workflow replay.

Live proof: seeded station showed DOWN after its sidecar stopped and recovered after restart;
the new boot's cursor requested snapshot reset. Real Chromium observed a fixture's lookup, the
production browser tool derived its client, and direct JSON matched the rendered result. Focused
tests prove disconnected channel replay, restart expiry, no duplicate replay, command exclusion,
HTTP failure handling, and exact skill script read-back in a fresh process. Integrated by exact
fast-forward at `9c9f788d0`; both before and after integration, fast **712/712** and HTTP **95/95**
passed. Evidence: `qa/digests/2026-09-05-hermes-reconnect-capture.md`. No installed-binary or
station-wide readiness claim.

## 2026-09-04 — LIVE TRANSCRIPTS + VOICE TURN FLOW (`agent/voice-flow-0904`)

Initial slices: `b4d83cf56` and `ff2946022`. Final integration and verification are recorded below.
Standard recording can preview with installed local/native recognition even when its final transcriber
uses a cloud credential. Local Live requests previews at a 650ms cadence, keeps words visible, reuses an
exact completed preview instead of transcribing the same final audio again, extends a pending turn when
speech resumes, and preserves successive finalized turns in order. Cancelled preview requests now reach
the backend ASR queue. Pause/resume and Send Now are explicit; diagnostics expand only by deliberate click.
Late local/native recognition cannot overwrite a newer call or a resumed listener.

Evidence: voice button **100 assertions**, draft protection **21**, five new behavioral scenarios,
Local Live UI, local voice, and media service **36 assertions** pass. In the running UI with synthetic
microphone/recognition, HEARING displayed the actual supplied transcript before any task was sent;
silence and Send Now submitted it; first-click pause/resume and end worked. A separate real bundled
Whisper run transcribed a generated speech fixture in **3529ms cold / 586ms warm** on this host.
These are synthetic-input and local-engine checks, not an attended microphone/speaker conversation or
an installed-desktop proof. Windows hands-free fallback without local models remains utterance-based.
Full gates passed: **test:fast 703/703**, **test:http 90/90**. Source verification was mechanically
refreshed in `acd6eed27` without changing claim verdicts. The first HTTP attempt hit workspace-lease
timing assertions (passed alone and in the full retry); earlier fast attempts caught the generated
website mirror and source record needing refresh. Both were verified at that checkpoint; integration followed in the second round. No desktop build.

Second round (2026-09-04): incremental local PCM sessions in both recording and hands-free modes;
eight-second ASR windows with retained boundary context; stable/provisional text; adaptive pause option;
prewarm while the microphone opens; interrupted reply tokens reject late chunks; subsequent speech
clauses start without waiting for a 200-character sentence. Voice Details measures observed first words,
last voiced frame to submission, and latest spoken chunk queued to actual playback (unobserved stages remain “—”).
Fallback retains the original recording when streaming fails. Sessions expire and cap buffered audio.

Live evidence: seeded server port8896, production voice UI and real bundled Whisper, with a generated
speech PCM fixture injected only at the microphone seam and task submission captured without a provider
call. Observed live transcript before submission, ordered open/audio/finish requests, the exact final
“Please show my words while I am speaking. Then send a complete sentence.”, pause/resume, and end.
Real browser receipt: ordered audio chunks, five recognitions, max window6784ms; first-partial2701ms on this
heavily loaded shared host. Separate warm engine check first partial583ms. These are different checks,
not a before/after speed claim. No attended mic/speaker or installed-build proof. Test page removed and
server stopped. Focused voice button105, media36, draft protection21 assertions, adaptive timing, six flow
scenarios, transport bounds/recovery, and UI checks pass. The subsequent real 16.66-second speech check crossed two window
boundaries and retained all three repeated sentences exactly; max decode window8000ms, first partial605ms.
It exposed timestamp drift that could duplicate an overlap word; the corrected path and its regression
now preserve both real repetition and overlap deduplication.

Final integration: `1c835fad3` on `feat/harness-backend`. Fast gate **709/709** on
`0de259466` (`voice-fast-final.log`); HTTP **93/93** on `069fff836` (`voice-http-combined.log`).
The final change after HTTP was frontend caption continuity only; the sidecar subtree remained exactly
`4f1a4f6b5897efb975574ef655fc089ea275d52a`. The integration merge tree exactly matched the verified
voice tree `b9a12d461cd8b2bb4a8ea6f56c57c7fc938b6436`; foreign QA/room handoff files were hash-checked
and preserved. Final seeded UI + real Whisper proof showed first live words in **546ms**, continuous
captions across a thinking pause, one complete submitted turn, and working pause/resume/end. Speech was
a generated PCM fixture, submission was captured without invoking a provider, and output-model warmup
was disabled for this last recognition-only check. No attended microphone/speaker or installed EXE proof.
All temporary frontend proof files were removed; the test server was stopped.

Earlier full fast gate caught direct clock reads in the new backend; injected clocks and a timing test
fixed it. An earlier HTTP run was intentionally stopped to include the concurrent connector-security
merge. Final gates above passed on the combined support, security, and voice code. Steady-caption UI
polish triggered the final fast rerun; the backend and HTTP test surface were unchanged.


## VERIFIED 2026-09-04 — SUPPORT EMAIL GAPS (`agent/email-gaps-0904`)

Own INBOX routine create/readback, compatible-provider tool-history repair and the MCP session-drain
race exposed by the post-merge gate. Existing sample,
OpenRouter, provider-truth and linked-state branches are already merged; do not merge them again.
Verified on integrated value-loop code: fast 707/707, HTTP 92/92, live creation/readback and restart.
Three local gaps repaired; exact managed production error and customer spend still need evidence. Details and residual
customer/production dependencies: [EMAIL_BUG_FOLLOWUP_2026-09-04.md](EMAIL_BUG_FOLLOWUP_2026-09-04.md).

## VERIFIED 2026-09-04 — STARNET SAMPLE RUN + TIER CATALOG (`agent/model-catalogue-report`)

The support report's successful Live Doctor inference and failed sample used different configuration
sources. Samples now resolve the selected dock's roster provider/model/credential after routing, and
resolve each downstream dock independently. Environment defaults remain only for an empty-roster
headless host. Missing roster configuration refuses without spending another provider's credential.

The tier picker now fetches the active provider's catalogue and rebuilds its options when that response
arrives. Saved rows no longer shadow real entries with a false “not in catalog” label; unavailable
catalogues preserve selections and explicitly report unverified membership.

Evidence: live seeded UI changed all three tier selections, closed/reopened Models, and observed exactly
one correctly labeled selected option per tier, with no browser warnings/errors. The real-sidecar
regression ran a StarNet entry and custom-provider hop without an environment default or OpenRouter key,
verified their separate credentials, repeated after restart, and refused a missing roster model with
zero inference requests. Existing sample coverage passed 99 assertions. Full gates on `431578620`:
`test:fast` **697/697 GREEN**, `test:http` **89/89 GREEN**. The first HTTP attempt hit a transient
port conflict in nightshift-focus; that test passed alone and in the full successful retry.

Implementation: `e33914cb2`; mechanical source lock: `431578620`. No integration merge, desktop build,
or publication has been performed. Customers need a desktop release containing this branch.


## 2026-09-03 — POST-AUDIT: NEXT CUT MUSTS (owner-directed, audit items 1–5)

The 2026-09-03 whole-repo audit (backend, frontend, release, process, product) found the harness solid
at its seams and the funnel unproven: ~6 outsiders have tried StarNet, all six hit an onboarding or
connector wall, none was watched. Andrew directed items 1–5 to execute. State:

1. **Users answered.** Issues #6/#5/#2 got replies naming the fixes that ride v0.10.13
   (`5b5f50a1d` BYOK credit gate, `6adda1348` connector 401 → REAUTH + SSE, `977294cbc`/`03519b043`/
   `1e651a03e` unreachable-station recovery). 49thMedia's residual "no STARNET key" banner is the keycta
   asking for the wrong provider after unlink — lane `agent/free-path-ollama` fixes the CTA.
2. **macOS physical recovery proof — retroactively waived for 0.10.13** (record in
   `docs/RELEASE_CUT_CHECKLIST_v0.10.13.md` § Post-publish record). **It is the first MUST of the next cut.**
   No cut publishes on a CI-runner Mac leg alone again without a fresh written owner waiver.
3. **First run fails loud, not silent** — lanes `agent/firstrun-fail-loud` (global error/boot-integrity
   banner, browser-mode UNREACHABLE exit) and `agent/sidecar-fail-loud` (uncaughtException exits for the
   shell to relaunch, 500 instead of 200+empty on corrupt stores, bounded channel Maps).
4. **Free path visible** — lane `agent/free-path-ollama`: keycta offers USE A DIFFERENT PROVIDER / RUN
   FREE LOCALLY, genesis shows the Ollama choice, README/INSTALL gain a "run free with a local model" section.
5. **CI truth** — lane `agent/audit-ops`: `secret-history` now prints its (redacted) finding so the
   weeks-red gate can be classified; dead GitHub-Pages `deploy-website` workflow removed (the real deploy is
   `wrangler pages deploy website-deploy`); new `fast-gate.yml` runs `test:fast` on every trunk push/PR.

Not executed (audit items 6+): branch/worktree/`.dogfood` inventory purge, NEXT/STATUS archival, lint gate.

## DONE 2026-09-03 — MANAGED MODEL TRUTH + SAFE UPSTREAM TRACE (`agent/provider-truth-0903`)

The 0.10.13 support report exposed a real provider/model-pair bug: after switching providers,
ModelDock could reinsert the saved model into a successfully fetched catalog that did not contain it.
The UI now treats a successful catalog as authoritative, maps direct Anthropic
`claude-sonnet-5` to managed `anthropic/claude-sonnet-5` only when that exact routed id is present,
and otherwise clears the stale selection instead of presenting an unexecutable pair. Reconciliation
runs after provider changes and key saves; offline fallback rows are explicitly unverified.

The managed proxy lane (`codex/provider-truth-0903`, cloud commit `b83271e`) adds a StarNet request id
and preserves only bounded, redacted upstream message/type/code/provider/request-id fields in both
responses and structured logs. Deterministic proxy replays of the exact Sonnet 5 body, with and without
`reasoning_effort`, pass, and the public route inventory reported nine active endpoints for the id on
2026-09-03. Historical production-log correlation remains unclaimed because this workstation has no
Fly.io authentication and the old client did not forward its run id to the cloud request.

Proof: live seeded Windows UI selected the direct bare id, switched to StarNet, showed `MODEL UPDATED`,
and reopened with StarNet owning `anthropic/claude-sonnet-5`; cloud tests are 221/221, `test:fast` is
692/692, and `test:http` is 87/87. No cloud deployment or integration-tree merge was performed.

## 2026-09-02 — v0.10.13 SAME-NIGHT CUT EXCEPTION

Andrew directed that v0.10.13 go out tonight without running a second full 48-hour soak. This is an
explicit waiver of the **RC.2 duration requirement only**. RC.1's time is not being reused or
misrepresented: RC.1 contained the confirmed durable-store quarantine deadlock and remains invalid.
The release decision instead accepts the residual duration risk after fresh exact-candidate Windows
installation, byte-bound smoke, real OpenRouter dogfood, a full clean Guardian cycle, 130/130 journeys,
and `qa:ready` READY with zero open P0/P1 findings.

This waiver does not waive the staged-draft T0 clean-install or G1 packaged-lifecycle gates, hosted-feed
verification, or the older-client update canary. Physical macOS recovery proof is still absent and must
either pass on real Mac hardware or receive a separate explicit owner waiver before Publish. The updater
signing key's two usable offline copies also still require human attestation before the official tag push.

## 2026-09-02 — v0.10.13 RC.1 INVALIDATED; RELEASE-BLOCKER REPAIR

The invalidated frozen branch was `rc/0.10.13`, and its marker tag is `rc/0.10.13-rc.1`; both pointed
at `5e7ff198`. The remote branch is now preserved under the unmistakable
`archive/rc-0.10.13-rc.1-invalid` name, while the marker tag remains forensic evidence. Neither can be
promoted. Its soak heartbeat is paused after a confirmed durable-store quarantine deadlock. The release
repair lane fixes that deadlock, fails closed after an uncertain headed-browser teardown, retains rejected skill turn-ins,
resets `starnet.tutorial.v1` for a genuinely new Commander, exposes screenshot-readable `SAVE-403` versus
`SAVE-NET` recovery diagnosis, and cleans rejected attachment uploads.

The two unreviewed August 31 sweep batches (`5558a707a..422e38c6f` and
`5ab47a230..66a37410f`) received the owed commit-by-commit adversarial review. No further P0/P1 was
found. Credential logout/FORGET deliberately keeps the live session when disk sanitization fails:
clearing RAM would falsely report logout while a persisted secret could resurrect after restart.

The repair head is green on claims (37/212), `test:fast` (691/691), `test:http` (87/87), and a real
seeded-app restart that quarantined a corrupt orphan widget backup and then returned an empty widget
store. Before RC.2: merge the repair lane, repeat the exact-merged-tree gates, earn fresh Beginner Run /
installed-smoke / `qa:ready`, and perform the
physical macOS recovery check. RC.1 time and receipts do not transfer to RC.2. No official `v0.10.13`
tag, draft, or publication was performed in this repair pass; the already-pushed invalid RC branch was
archived and removed from the live `rc/` namespace.

## DONE 2026-08-25 — CUSTOM HTTP MCP OAUTH (`agent/custom-mcp-oauth`)

GitHub issue #1 is confirmed open on current trunk: the manual MCP form exposes HTTP bearer and
Safe Cell stdio only, while `/api/connectors/oauth/start` accepts curated catalog ids only. The
existing RFC 9728/8414/7591 + PKCE engine successfully discovers the reporter's Base44 endpoint,
so this lane is limited to opening that proven flow to a saved custom HTTPS connector, adding the
HTTP authentication choice in ABILITIES, and hardening arbitrary OAuth discovery against private
DNS targets. It does not overlap the active `agent/connector-auth-sse` transport/401 lane.

Delivered: the manual connector form now exposes OAUTH as an HTTP auth mode, saves the URL before
starting the existing browser PKCE flow, preserves config through callback, refreshes protected local
tokens, and reports configured-vs-authorized state honestly. Custom discovery is bound to the saved id,
HTTPS-only, private-DNS guarded, and carries Base44's protected-resource scopes. Live ABILITIES proof
confirmed the rendered choice, hidden bearer field, guarded sign-in start, truthful unsigned row, and
cleanup; the real-sidecar E2E proved restart persistence. The reporter's live Base44 endpoint was probed read-only (401 → Base44 AS + DCR + S256 +
`app:mcp offline`); focused tests, all 689 `test:fast` steps, and all 84 `test:http` steps are green.

## 2026-08-22 — CONSISTENCY LOOP: verdict → correction → skill → golden test (BUILT, `agent/momentum-loop`)

Plan: `docs/plans/CONSISTENCY_LOOP.md`. The user complaint is output consistency; the capture side (verdict,
dossier belief) landed 08-21, the skill side is unconnected: `skillreview.js` auto-writes skills but triggers on
run SIZE not on the Commander's verdict, writes are not approval-gated (memory is), the Commander's correction
after a miss is never captured, and no skill has a test. Four slices, each shippable: (1) verdict-triggered skill
review, (3) skill turn-in card mirroring the memory deck, (2) correction capture on the next message, (4) per-skill
goldens run through the replay-provider eval before a patch is offered. Needs ONE additive event `skill.proposed`
from the shared-contract owner. **Built same day, all four slices live-proved — status block at the top of the plan.**

## 2026-08-21 — MOMENTUM LOOP: CONTINUOUS EXTRACTION + USEFUL POPUPS (`agent/momentum-loop`)

Thesis check (Andrew, 08-21): the interview is a ONE-TIME extraction of what the user wants and how;
the station must keep extracting through the work itself, and turn what it learns into automation
that takes work off the user. Audit of interview → dossier → quests → recommendations found the loop
leaks in seven places; the rate beat (`chat.js` ~2770, `▲ nailed it / ◆ close / ▼ missed`) only mints
XP and asks nothing. Popups must carry real power or not appear.

**Re-grepped on trunk (doctrine: the audit was stale):**
1. ~~Verdicts feed ranking~~ — ALREADY SHIPPED (recipe lane B): `chat.js rateWork` → `ProspectStore.noteRated`
   → `POST /api/scout/telemetry recipe.rated` → `Scout.noteRated` → `rankRecipes` OUTCOME term
   (`min(great,3) − 2·min(miss,3)`, can sink a recipe out of the row). Only recipe-launched runs carry a
   `recipeId`; that is the correct scope.
   Also already built: the just-in-time curiosity nudge (`chat.js curiosityNudge`, `curiosity.js`) — but it
   asks only about BLANK dims, so once the interview fills all nine the station never refines again.

**BUILT in this lane — verdict follow-up (`frontend/app/verdictfollowup.js`, `test/verdictfollowup.test.js`):**
`◆ close` / `▼ missed` no longer end in "noted": the beat asks "what missed?" with chips that each map to a
dossier dim (length/depth → style, audience → people, approach → stack, off-goal → goals, timing →
schedule); a tap writes an `observed` belief (source `verdict`, `sourceRunId`, directive cited) and shows the
BRIEFING receipt. Never on `▲ nailed it`, once per run, skip writes nothing, stands down when a task
question is live or the one post-run slot is taken.

**Re-grepped the rest of the plan (2026-08-22) — two of three were ALREADY on trunk:**
- ~~Pain/ambition → routine proposals~~ — the chain exists as two proactive hops through the Recommend
  spine (`chat.js ~5800`): a directive shape repeated ≥3× → `Mint` proposes a recipe; a recipe launched ≥3×
  (and not miss-heavy) → `RoutineNudgeStore` offers a schedule. Decline is durable in both.
- ~~Quest-log dismissals → sidecar `deniedTitles`~~ — ledger quests already dismiss through
  `POST /api/quests/dismiss` (their own durable denylist); `queststate.js` only denylists local projection quests.
- **BUILT: pain + ambition → FOR YOU rank** (`recipes.js painText`, `marketplace.js painText()`): same word-wise
  matcher and weight as goals; the card's why reads "something you want off your plate: “…”", never a
  fabricated goal. Live-proved on the real shelf DOM. Still not ranked: stack/people/schedule (keyword-matching
  a timezone or a cofounder's name against recipe copy would be noise, not signal — needs a different term).
- Open: interview `stack`/`identity` → `Profile.seed` (affinity stays 3 tags wide).

**Popup law (new):** a popup earns its pixels only if the answer CHANGES something observable
(ranking, a belief, a routine). "close"/"noted" that writes nothing is a dead question — remove it
or give it a consequence. Verify live: rate a run, reopen FOR YOU, the rated recipe moved.

Reference: Hermes does correction→`skill_manage` write-back with a `pending/` approval gate; StarNet
already has the richer intake, it lacks the write-back.

## 2026-08-21 — RELEASE CUT IS TWO COMMANDS (`agent/rel-cut-ritual`)

Reliability item 3 (ship cadence): the cut was a long manual ritual across the runbook, memory notes
and tribal knowledge, so fixes rotted on trunk (0.10.6 shipped the close-zombie partly because cutting
was expensive enough that the fix waited; two version numbers and a 15h soak were lost to step-order
mistakes). It is now scripted, re-runnable, and refuses to skip a step:

```
npm run release:preflight -- --next patch      # read-only: one PASS/FAIL/WARN/SKIP row per precondition, exact fix per red row
npm run release:ritual:dry -- --next patch     # print the whole plan, mutate nothing
npm run release:ritual -- --next patch         # preflight → bump (--no-tag) → STOP for notes → claims re-lock →
                                               # STOP for gates (--gates-proven-by <log>: last line must be the green
                                               # summary, never the exit code) → post-bump preflight → tag → STOP (never pushes)
```

Rows: trunk branch · clean tree (Guardian `qa/STATUS.md` row named, not failed) · five version pins ·
tag not local/origin/releases-repo (SKIP "unverified: offline") · claims lock current for HEAD (reads
the COMMIT) · `website/app` mirror · `test:fast`/`test:http` receipts at HEAD
(`.dogfood/gate-receipts/<sha>.<gate>.json`, written only by the ritual) · T0/G1/soak receipts or
"owed" · `qa:ready` · updater key present (never printed) · release notes real. Full row table with
the law behind each: `docs/RELEASE_RUNBOOK.md` §0. Unit-tested with fake io
(`test/release-preflight.test.js` 92 assertions, `test/release-ritual.test.js` 64) and registered in
`test/fast.list`. Still human: the truth of the notes, the offline key backups, the hotfix soak
waiver decision, and everything after the push (train watch, draft review, T0/G1 runs, Publish,
`verify-host`, canary).

## 2026-08-14 — VOICE ENDPOINTS: MANUAL STANDARD + QUICKER LOCAL LIVE (`agent/latency-hotpath`)

READY TO MERGE. Standard voice is now an explicit two-click take: click the mic to start recording,
pause as needed, then click it again to finish, transcribe, and send. Browser speech recognition
reopens across provider-imposed pause endpoints while retaining the take, and recorder-backed
desktop speech no longer uses silence as a submit signal. On native-only Windows installs, the
sidecar transcribes the exact browser-captured take through System.Speech instead of asking the OS
to decide when the user finished. A two-minute ceiling remains only as a forgotten-microphone safety
release. Local Live keeps its automatic turn detection unchanged.

New/default Local Live sessions also use the already-exposed QUICK 1.2-second turn boundary instead
of NORMAL 1.8 seconds, removing a deterministic 600 ms from complete spoken turns. The existing
transcript-aware continuation rule still gives an unfinished partial another 600 ms, and
NORMAL/PATIENT remain explicit persisted choices.

Live seeded UI proof rendered the normal mic as `Click to talk` beside a separate `Start Local Live
hands-free voice` control. No microphone permission or provider spend was used. A real Windows
System.Speech file-input probe accepted a generated spoken WAV and returned a transcript with
confidence telemetry; physical-microphone acoustic proof remains outstanding. Focused Voice button
(92 assertions), draft protection (21), native STT, media service (34), Local Live UI, syntax, and
website-mirror checks are green. `npm run test:http` is **76/76 GREEN** and `npm run test:fast` is
**630/630 GREEN** on this lane.

## 2026-08-09 — WEBSITE PREVIEW STATE CORRECTION (`agent/station-preview-state`)

READY TO MERGE. The first preview repair updated the renderer mirror and stage crop but left the
website-only captured save on the retired one-room `hull` material state. Worse, `demo-boot.js`
seeded only when `starnet.save` was absent, so any returning visitor stayed pinned to that stale
snapshot forever. The embed now upgrades its captured room to the current seeded-app material
preset (`walnut/plank`, `ribbed`, `ember/brick`) and carries a versioned website-demo marker that
refreshes stale localStorage exactly once. The homepage iframe, generated embed tag, and demo boot
script all have explicit cache revisions.

Live side-by-side proof used the already-running current app at `127.0.0.1:9527` and the corrected
local website at `127.0.0.1:18880`: both render the warm plank deck, ribbed upper wall, and brick
hull, while the reported public screenshot remains the retired gray hull. Crop telemetry remains
`748 / 752` with offsets `-252px / -84px`. Focused preview coverage is 14/14, website mirror is
exact, and the guarded website stage check would publish 3,901 files while holding back 17.

## 2026-08-09 — CURRENT WEBSITE STATION PREVIEW (`agent/station-preview-current`)

READY TO MERGE. The starnetos.com station preview was still clipping the embedded app with the
retired `666x744 @ 283,88` camera rectangle while the current shell renders the stage at
`748x752 @ 252,84`. The homepage now measures the real same-origin `#stage` rectangle after iframe
load and on later layout changes, then derives its crop offset, scale, and aspect ratio from that
live geometry. The website app mirror is synchronized with the current frontend, including the
latest station lighting/rendering changes, and the corrected controller is cache-busted.

Live local-site proof at desktop width rendered the complete warm-lit station with measured crop
`748 / 752`, offsets `-252px / -84px`, and scale `0.721925`; at `390x844` it retained the same live
geometry, scaled to `0.447861`, and reported `scrollWidth 375` with no horizontal overflow. The new
regression is 6/6, website mirror is exact (3,885 files + 2 embed-only), claims planning authority
is PASS (37 claims / 208 locked files), and `npm run test:fast` is **595/595 GREEN**. No publish,
Cloudflare deploy, push, PR, credential, provider-spend, or production-data action occurred.

## 2026-08-08 — VOICE TURN BOUNDARIES + LIVE DICTATION — MERGED

Merged to `feat/harness-backend` as `9e8c9c5c` from snapshot `17196bd9`. Conversation mode now keeps a 900 ms pre-roll, uses a quieter-room-safe
speech threshold, permits utterances up to 60 seconds, and exposes a persistent TURN END
control with 1.2, 1.8, and 2.6 second pause choices. Transcription mode now renders genuine
local speech-recognition previews in the composer while the user is still speaking; the
synthetic bullet/dot progress text is gone, and typed drafts remain protected.

Conversation mode also fixes one speaker identity for the full Live Voice session. It snapshots
the selected voice when the room opens, lets the first audible chunk choose the bundled Kokoro
engine or its mapped Edge floor, and pins that engine for later chunks and turns. A transient
failure can no longer substitute a different-sounding voice mid-conversation; changing the voice
picker now truthfully applies to the next Live Voice session.

Verification: focused voice-button (**86/86**), media-service (**34/34**), and claims
(**64/64**) suites are green; mirrored website assets are exact; JavaScript syntax and strict
package JSON checks are green. Both the final branch and merged trunk passed
`npm run test:fast` **584/584 GREEN** and `npm run test:http` **70/70 GREEN**. Claims authority
passes with 206 locked surface files. In the real seeded app, the TURN END control rendered with the persisted
NORMAL 1.8S value after closing and reopening Local Live, using the station-native dark skin.
The in-app browser denied microphone capture, so real acoustic boundary/transcript proof
remains for an installed-desktop pass; production callback behavior is covered deterministically.
No route, shared-contract, external-service, push, PR, or deploy change occurred.

Prior integration attempt `53bf12c8` on trunk snapshot `cdd9704e` was rolled back on 2026-08-07 after the mandatory
exact-merged-tree `npm run test:fast` gate failed at step **254/581**, `node test/browser.test.js`: **1 problem / 292 ok**,
on the load-sensitive assertion â€œan already-quiet page returns well inside the old 900ms blind wait.â€ A concurrent
claims refresh (`7a3f7aeb`) landed above the merge while the gate ran, so recovery used targeted revert commits
`013a0d43` and `1b675d0a` instead of erasing concurrent history; the recovered trunk tree hash was verified byte-for-byte
equal to snapshot `cdd9704e`. The terminal-output and real-recovery commits later landed on trunk; the comparison
fixtures below remain the only unmerged portion of this lane.

## 2026-08-08 — HERMES/STARNET OUTPUT RELIABILITY COMPARISON (`agent/hermes-starnet-benchmark-0807`)

Five scenarios were run three times per harness against
the same `openai-codex / gpt-5.6-luna` model. An initial 30-row wave exposed a real StarNet policy interaction:
generic external actions triggered verify-on-stop, but the only read-back exposed fixture setup, so correct
pre-verification answers were replaced by truthful but false-negative terminal warnings. After adding one
authoritative `fixture_status` read-back available to both harnesses, StarNet passed **14/15** and Hermes
**13/15**. StarNet's one miss duplicated `RESULT=PASS-731` inside one terminal answer. Hermes made an unrequested
`fixture_deliver` call to `job-731` in two of three cancellation attempts; one of those outputs also omitted
`RESUMED-731`. Both passed malformed-result recovery, timeout honesty, and real out-of-order worker attribution
3/3. No driver error, fixture mutation, duplicate mutation, or authority escape occurred. Observed mean latency
was 9.32s StarNet versus 12.32s Hermes, but three attempts per task are not a durable performance estimate.
Ignored raw evidence and the two-wave analysis live under `.dogfood/eval-runtime/campaign/output-reliability/`;
temporary copied OAuth envelopes were deleted after capture. This is source-runtime comparison evidence, not
installed-desktop or release-candidate proof.

## 2026-08-07 — PER-BLOCK CODE COPY — MERGED

Merged to `feat/harness-backend` as `014dc3e3` from snapshot `d3b1c264`. Fenced COMMS code blocks now have
independent top-right, keyboard-labelled copy controls that copy only the exact code text. Success renders
`Copied` / ✓; failure renders `Copy failed` / ! and leaves truthful manual-selection guidance. The existing
whole-message copy action uses the same feedback path, and the packaged website mirror is synchronized.

Live seeded proof clicked `Copy code block` on a response containing prose plus `console.log("hello");`; the
browser clipboard contained exactly `console.log("hello");`, excluding the prose. The new regression contributes
20 multi-block/XSS/accessibility assertions. After a mid-ritual trunk reset, the lane was reconstructed from the
current trunk with only its own commits so dropped artifact work was not silently reintroduced. Product-perfect
claims were re-locked for 205 surface files. Full `npm run test:fast` was **574/574 GREEN** both before merge and
again on the exact merged trunk. Frontend-only: `test:http` was not required.

## 2026-08-07 — STARNET 0.10 FINAL HERMES PARITY MAP (`agent/hermes-final-gap-audit`)

G0, G2, AND G3 LANE ACCEPTANCE COMPLETE; G1 PACKAGED BASELINE PARTIAL; INTEGRATION PENDING. The comparison is pinned to StarNet `0.9.0` at `fc452230` and Hermes Agent
`origin/main` at `10a2b3d7` (2026-08-07), rather than the stale July Hermes checkout. The full evidence map and
observable exit tests live in `docs/HARNESS_GAP_2026-08-07.md`.

The 0.10 release-confidence gates are: **G0** operator-visible crash review plus safe resume, **G1** packaged
Windows/macOS background-lifecycle proof, **G2** a unified opt-in live doctor/support receipt, **G3** MCP
schema-cache/lazy-start/recycle/orphan lifecycle, and **G4** complete multi-file skill distribution with
discovery, update generations, rollback, and lossless export/re-import. G0 is implemented in lane commit
`65b90b78`: authenticated operator resolution, complete-known-outcome continuation, one-shot durable consume,
provider-valid recovered history, and a host replay barrier that runs before consent or dispatch. The in-app
fixture proved `happened` -> continuation `done`, the deterministic counter remained exactly one, finished linkage
survived a second sidecar boot without a retry control, unknown remained non-continuable, and corrupt repair stayed
forensic-only. Focused recovery coverage is 190 assertions; the current-tree fast gate has a complete 574-step green
receipt, and the post-live-fix rerun stopped only on a timing-sensitive browser assertion that then passed 293/293
isolated. HTTP recovery is 26/26; the standard HTTP wrapper timed out with all shown assertions green, its one later
loop-check timing failure passed 33/33 isolated, and every remaining 38 HTTP entries passed in order. This lane is
not trunk capability until merged.

G2 is implemented in lane commits `14e256ba` + `712b0de0`. Static diagnostics remain an inert GET; the new live
doctor is an authenticated POST behind a second explicit checkbox and a server-side consent bit. One bounded action
runs independent probes concurrently for the selected model, the agent's effective execution backend, every enabled
MCP server, and every supported/configured channel. Receipts use only `not-configured`, `refused`, `unreachable`,
`authenticated`, and `round-trip-proven`, include per-row timestamps/latency, redact credential shapes, and contain no
prompts, transcripts, command output, or message content. The doctor never sends a channel message; a channel only
earns delivery round-trip from a real prior successful delivery receipt. The live app proof refused the unchecked
button, then rendered a receipt with provider + local execution round-trip proven, reset the checkbox, exposed copy,
and logged zero browser warnings/errors. The real-host proof additionally enabled a fake HTTP MCP server and Telegram
adapter: MCP re-initialized/listed, Telegram re-authenticated but remained only `authenticated`, and zero messages were
sent. Focused coverage is 8/8; `sidecar.http.test` is 471 assertions; website mirror is 3,883 + 2 embed-only green. The
canonical fast gate passed all new doctor tests, then stopped at the existing candidate-bound claims seal at step
228/576 (10 problems / 54 ok); this isolated lane did not rewrite shared release claims.

G3 is implemented on `agent/mcp-process-lifecycle`. Canonical SHA-256 cache identity binds stdio schemas to command,
arguments/package spec, cwd, environment, and Safe Cell owner. Warm boot projects only a matching size-bounded disk
record and reports `cached` / process stopped; first use re-initializes and re-lists before dispatch, so a stale tool,
resource, or prompt cannot run as current. Idle and maximum lifetime recycle the child, owner/profile changes withdraw
the projection, and ordinary transport crashes retain the existing bounded reconnect path. Stdio children now use the
durable process ledger; a real Windows force-death test proved the next boot reaped exactly the owned child, including
on the managed-host CIM-denied path via exact creation-time fallback. The live seeded ABILITIES panel rendered
`idle · starts on use · 1 tool` plus `cached_probe` without launching a child. Focused G3 evidence is 22 schema-
lifecycle, 38 stdio, 6 real orphan, and 38 ledger assertions; the exact lane tree is 586/586 fast and 70/70 HTTP green.
This remains a lane candidate, not trunk capability, until merged.

G1 now has a cryptographically verified **0.9.0 baseline**, not a completed lifecycle matrix. Receipt
`C:\Users\andro\gen-trees\release-090-final\.dogfood\g1-packaged-lifecycle\20260807T175943\g1-packaged-lifecycle-receipt.json`
has SHA-256 `827D9A5C11290293EA845D58547F834CEF7B6D03260F96AA46AD79D3E3425C57` and status `partial_blocked`.
The public installer digest matches GitHub, Authenticode and detached updater signatures pass, extraction and embedded
binary/runtime signatures pass, and live Windows + both macOS update assets are reachable and version-pinned. The
seven interactive Windows lifecycle cases were not run because the same installed identity/path/canonical workspace
is owned by the healthy 48-hour provider soak; macOS runtime remains unverified without a Mac. This evidence is
explicitly baseline-only and cannot authorize the eventual 0.10 candidate.

The remaining parity lanes are cross-surface session handoff plus authenticated relay/webhooks (G5),
config-blocked/hash-suppressed autonomous monitors
(G7), remote execution continuity/checkpoints/conflict-aware sync (G8), and recoverable full-output plus verified
workspace-mutation receipts (G9). G6 (live subagent steering and structured result contracts) is CLOSED —
shipped 2026-08-08 in `3979605b4` (durable worker orchestration): generation-bound steering in
`sidecar/subagents.js` plus the `team.steer` tool, structured result contracts in
`sidecar/tools/builtin/orchestration.js`, proven by `test/orchestration.test.js` and `test/subagents.test.js`. Serverless backend breadth, additional push channels, enterprise-native
provider auth, A2A/MoA, wake word, bulk-corpus learning, and portable profiles require explicit build/defer/
do-not-claim decisions; they are not automatic 0.10 blockers.

Do not reopen the old generic claims that StarNet lacks a serious core loop, tool breadth, compaction/caching,
approvals, durable schedules, background delegation, session management, checkpoints, execution profiles,
MCP OAuth/stdio, skills authoring, or provider breadth. Those are now confirmed peer capabilities. No row turns
green from unit tests alone: final authority is a packaged live or fault-injection receipt at the exact release
candidate SHA.

## 2026-08-07 — USER-SELECTABLE TRAY START/CLOSE (`agent/tray-background`)

READY TO MERGE. The existing Lane 4D tray supervisor now has two independent, opt-in desktop preferences:
START MINIMIZED TO TRAY and CLOSE WINDOW TO TRAY. Both default off, persist through a versioned native JSON
record with exact read-back and backup recovery, and surface verified native state in Settings. Enabling
close-to-tray keeps the one supervised shell/sidecar alive even while idle; disabling it preserves the prior
armed-work safety decision. Browser preview stays disabled and makes no native lifecycle claim. Tray Quit
remains the explicit drain/kill/full-exit path.

The first native live pass exposed a real Tauri seam: preventing `CloseRequested` alone did not prevent the
event loop from exiting. The final implementation pairs that window event with one atomic pending-close flag
and prevents only its corresponding user exit request. Programmatic exits, updater exit, OS exit, and the
short-lived second-instance reveal process are not trapped. An isolated Windows debug build under identifier
`ai.skynet.harness.traytest` persisted `{startMinimized:true,closeToTray:true}` through real Tauri IPC; a real
window close logged `close_to_tray=true`, hid StarNet, and left the exact shell and sidecar alive. On restart,
Win32 top-level-title inspection saw no visible `StarNet` window; a second launch exited 0, revealed `StarNet`,
and left the primary alive. The existing tray Open/Quit handlers were compiled and covered by the focused
seam but were not mouse-clicked in this isolated proof. The disposable test profile and WebView data were
moved to the Recycle Bin; the installed StarNet process/data were never touched.

Verification: `npm run test:fast` is **573/573 GREEN**; desktop lifecycle preference coverage is 14 assertions,
quitguard is 27, claims authority is 64, and native preference tests are 3/3. The isolated Tauri debug build
completed successfully. `test:http` was not run because this slice changes no sidecar route or HTTP contract.
No shared event/schema edit, integration-tree edit, external message, provider spend, push, PR, deploy, tag,
installer, or publication occurred.

## 2026-08-06 — PERSISTENT PER-AGENT FULL ACCESS (`agent/approval-full-access`)

READY TO MERGE. The permission card's FULL ACCESS answer previously wrote only an in-process wildcard that
vanished on restart. The live run authority never read the agent roster posture, and the post-web/MCP taint
boundary could force a new prompt even for an agent already marked Full Access. This produced the broken
contract shown in the live UI: the user repeatedly granted Full Access and the same agent kept asking.

FULL ACCESS now has one canonical meaning and one durable authority source: the agent roster's persisted
`approvalMode: "full"`. The permission-card endpoint saves that posture before completing the pending tool
call; run authority, consent, taint handling, external-path trust, and autonomous writes read it live. It applies to
every later task on every surface, including unattended work, and survives a sidecar restart. It never emits
another permission card. Protected physical-input and visible-desktop actions remain hard-floor denials and
are blocked automatically without asking. The obsolete process-lifetime wildcard, ledger row, revoke path,
store plumbing, CSS, and tests were removed; live copy now states the same contract without contradiction.

Verification: the new real-sidecar test clicks the actual permission-card endpoint, executes `shell.exec`,
restarts the sidecar, and executes shell again with zero later prompts (11 assertions). The real MCP flow is
87 assertions green; focused authority/consent/taint/UI coverage is green. `npm run test:fast` is **565/565
GREEN** and `npm run test:http` is **68/68 GREEN**. In the real seeded app, NOVA was switched to FULL ACCESS
through SETTINGS, the sidecar was restarted with its workspace preserved, and the live panel still rendered
`FULL ACCESS — runs everything itself, no prompts`; it also rendered the corrected watched-or-unattended and
automatic-hard-floor explanation. The live process and browser tab were stopped/finalized. No external
message, production-data mutation, integration-tree edit, push, PR, deploy, tag, or publication occurred.

## 2026-08-04 — TELEGRAM POLLING / OWNER-PAIRING TRUTH (`agent/telegram-polling-truth`)

READY TO MERGE. A Telegram Bot API poller could be genuinely healthy while owner enrollment was still
unfinished. The adapter correctly refused every ordinary DM in that state, but CHANNELS rendered
`CONNECTED — polling`, told the Commander to DM the bot, and could overwrite the one-time `/pair` command
when the asynchronous poll-up repaint landed. The in-station agent then also reported Telegram as unreachable
because no admitted chat had ever reached the channel target store.

First connect now issues and durably stores a fresh owner challenge and returns its raw code once to the
authenticated local panel. Status exposes `acceptingDms` separately from transport `connected`; the main bot
and agent-bot rows stay in a waiting state until both the poller is up and an owner is paired. The panel renders
`POLLING — DMs BLOCKED: PAIR OWNER`, says `WILL ANSWER AS`, preserves the exact `/pair …` instruction across
status repaints, and calls the channel connected only after owner admission is live. The setup guide makes the
pairing step explicit.

Live proof used the real seeded app and a local fake Bot API: the rendered DOM reported `ch-state st-wait`,
the blocked status above, an active pairing challenge, and the intact one-time command after poll-up; browser
warnings/errors were empty. The real-sidecar fixture proved a pre-pair DM is refused, `/pair` is acknowledged,
`acceptingDms` flips false → true, and the owner/operational state survives restart (12 assertions). Focused
frontend truth is 7/7; `npm run test:fast` is **535/535 GREEN**; `npm run test:http` is **62/62 GREEN**.
No real Telegram message, provider spend, credential mutation, integration-tree edit, push, PR, deploy, or
publication occurred.

## 2026-08-05 — TELEGRAM OGG/OPUS VOICE TRANSCRIPTION (`agent/telegram-voice-ogg`)

READY TO MERGE. Telegram already normalized voice notes as `voice-message.ogg` and routed them through the
shared STT ladder, but its keyless local floor decoded WAV only. A station with the shipped offline speech
engine therefore saved the attachment and told the agent `local engine needs wav (got ogg)` instead of
delivering the spoken words. The media service now lazily loads a bundled in-process Ogg/Opus decoder,
downmixes/resamples the result to 16 kHz mono Float32 PCM, and feeds the same local Whisper path used by WAV.
No machine-global ffmpeg install and no cloud credential is required. The decoder is a declared production
dependency, survives the desktop voice-dependency staging closure, and its third-party license notice is
recorded in `NOTICE.md`.

Verification: a real libopus Ogg fixture decodes and reaches the local ASR boundary in the fast gate; focused
Telegram group/voice coverage is green (98 assertions); `npm run test:fast` is 526/526 green; full
`npm run test:http` is 60/60 green, including four Telegram E2E suites. A real seeded sidecar on `:18743`
received a spoken `audio/ogg` request through `/api/stt` and returned HTTP 200 in 3.3s with
`Telegram Voice Messages Now Work Offline.` from the keyless local model; the seed was stopped and the port
released. The Windows desktop staging simulation retained and resolved `OggOpusDecoder`. A live external
Telegram Bot API delivery was not sent from this isolated lane; network ingress remains covered by the fake
Bot API E2E plus the live shared STT route.
## 2026-08-04 — AUTHORIZED PROJECT-ROOT REWIND (`agent/hermes-project-rollback`)

IMPLEMENTATION READY; CANDIDATE CLAIMS BLOCKED. Checkpoints now bind their shadow Git history to the exact
mutation root instead of always snapshotting the agent workspace. Relative workspace writes retain the
existing IDs and layout; commands and writes in an authorized external project use a digest-scoped repo
under the station checkpoint store, never the project's own `.git`. Restore rechecks current root authority
and fails closed after revocation while keeping the checkpoint visible for later exact-root reauthorization.
The Rewind UI names the affected root and cannot offer a restore while its authority is revoked.

Focused real-filesystem proof covers external-root mutation, revocation, reauthorization, byte-exact
restore, removal of newly created files, preservation of a project's existing `.git`, checkpoint-index
rebuild, scope identity, and path-jail containment. Tool wiring proof covers filesystem writes plus shell and
verification commands at their effective host working directory. Before the final trunk sync, the focused
suites were 247 assertions green, canonical `npm run test:fast` was 524/524 green, and canonical
`npm run test:http` was 60/60 green. After merging current trunk `4052834e`, focused proof remained 247 green
and HTTP remained 60/60 green. Fast passed its first 205 steps, including every touched rollback test, then
correctly blocked at `qa-product-perfect-claims.test.js` because the shared claims are sealed to another
candidate commit (9 failed / 55 passed). This branch does not rewrite shared candidate evidence. Final
integration must reconcile the known `sidecar/index.js`/fast-manifest overlaps, regenerate candidate-bound
claims once, and rerun the canonical gate. No station-wide readiness claim is made.

## 2026-08-04 — COMPLETE STATION DISASTER RECOVERY P0 (`agent/disaster-recovery-p0`)

READY TO MERGE. StarNet now has a versioned, offline complete-station recovery bundle and operator CLI.
Capture inventories every non-ephemeral `WORKSPACES` file plus supplied browser-owned `starnet.*` state,
binds every payload and the manifest with SHA-256, and refuses to publish a recovery point unless agents,
rooms/props, conversations, memories, routines, loops, tasks, projects, deliverables, permissions, and
connector references are all represented. Backups commit through temporary-file write, fsync, and rename.
Restore verifies into a sibling staging directory before activation; corrupt/incomplete input cannot mutate
the target, and `--replace-existing` retains the replaced generation as a rollback directory.

Credential and machine authority handling is explicit. Connector/channel/project references return, while
provider credentials, OAuth/token/key material, cookies, and absolute-path grants are excluded and listed
under `reauthentication`. Portable non-path permission grants survive. A restored project is truthfully
`REVOKED` until its path is reauthorized. The CLI and machine-readable rehearsal evidence enumerate exact
`restored`, `skipped`, and `reauthentication` rows; `docs/DISASTER_RECOVERY.md` records the stopped-station
backup, clean-profile restore, browser import, and previous-version rollback procedures.

Verification: the deterministic destructive rehearsal is **8/8 GREEN** for complete capture, clean-profile
restore, corrupt bundle, interrupted backup, missing required store, disk-full failure, previous-version
rollback, and a measured recovery point. Unit recovery is 54 assertions, offline CLI is 14, and the real
source-sidecar → clean-profile restore → restored-sidecar E2E is 23. `npm run test:fast` is **519/519 GREEN**;
`npm run test:http` is **57/57 GREEN**. An attended real sidecar/frontend boot of the restored disposable
profile rendered ONLINE with NOVA, the General conversation, task board, loop, and project reference; the
project rendered `REVOKED`, and browser warnings/errors were empty. The temporary sidecar and browser tab
were stopped/finalized. Latest local evidence is under `.dogfood/disaster-recovery-latest/`.

Recovery-point truth: a successful quiescent snapshot loses zero completed mutations through its barrier;
the rehearsal then completed exactly one mutation after that point and measured exactly one mutation lost
after damage/restore. This satisfies the one-mutation objective for explicit recovery points. Automatic
continuous backup is not implemented and no continuous RPO is claimed. A disposable real clean profile is
proven; a separate attended clean-OS packaged Windows/macOS exercise remains useful release validation, not
authority for this recovery primitive. No provider spend, external message/write, credential mutation,
integration-tree edit, push, PR, deploy, tag, publication, or production-data change occurred.

## 2026-08-03 — CLEANUP PHASES 0–8 (`agent/cleanup-phases-0-8`)

COMPLETE CANDIDATE. Phase 0 closed all seven remaining P2 bug-register records with production-path
proofs, including release-receipt candidate binding, provider recovery/accounting, channel SSE, tooltip,
and watched-only Full Access behavior. Phase 1 replaced repeated sidecar process setup with one lifecycle
fixture and moved the fast/HTTP gates from hand-maintained command chains to ordered manifests. Phase 2
extracted bounded body reads, file/range response policy, and the full TTS/STT/media subsystem from the
sidecar composition root; the media move removed 706 lines from `sidecar/index.js` and kept the 200-always
voice contract. Phase 3 introduced one explicit per-run execution state for taint, loop detection, output
budgets, checkpoints, journaling, artifacts, and proof-of-work counts. Phase 4 added normalized, versioned,
read-back-proven domain stores and migrated budget, fallback-chain, and memory settings.

Phase 5 added `QuerySpine` for keyed GET dedupe, TTL/last-good state, invalidation, and subscriber-owned
polling, then migrated the cron-family frontend consumers. Phase 6 added `BeatCard` and moved memory, study,
arc, trust, thread, nudge, and rating cards onto one arbitration/expiry/generation lifecycle. Phase 7 moved
provider abort classification and retry delays into the shared provider runtime, fixing stale abort-listener
accumulation. Phase 8 extracted native credential/keychain and legacy token migration from Tauri `main.rs`,
removed 14 unreachable sprite frames, added a 3,656-frame manifest integrity gate, refreshed `BRAIN.md`, and
re-locked both the release surface and moved credential authority locators.

Verification on the combined candidate: `npm run test:fast` **509/509 GREEN**; `npm run test:http` **56/56
GREEN**; claims planning authority **PASS** (37 claims / 192 files); website mirror **GREEN**; sprite manifest
**15,577 assertions GREEN**. A final seeded live sidecar returned `/api/health` = `ok`, served the app and both
new frontend modules with HTTP 200, and proved `queryspine.js` and `beatcard.js` load before `chat.js`; the
test port was released. Keyless live TTS and STT each returned their required HTTP-200 fallback envelope.
`credentials.rs` passes rustfmt and 258 focused native/static assertions. Full Cargo compilation could not be
completed on this Windows host: both parallel and `-j1` attempts exhausted compiler memory while building the
upstream `windows` crate (`0xc000012d` / `STATUS_STACK_BUFFER_OVERRUN`), before any StarNet source diagnostic.
No provider spend, external message/write, credential mutation, push, PR, deploy, tag, or publication occurred.

## 2026-08-03 — PROVIDER P2 REGISTER CLOSURE (`agent/cleanup-p0-providers`)

READY FOR CLEAN-BASE CHERRY-PICK. The three provider P2 records `8d7b0b52`, `cb8dc6c3`, and
`4007eb1f` were already fixed in production by `fdbb12a2` but remained falsely open in the durable bug
register. `e5e4e620` adds the missing production-composed proof: one actual sidecar `/api/run` rotates
off a 429 primary credential, compacts only through the live backup, and completes; a second run inside
the cooldown starts on that warm backup and never touches the primary. The same boot preloads a $0.42
unmetered subscription row above a $0.30 day cap plus $0.10 metered spend, proves `/api/budget` exposes
only $0.10 while counting both runs, and proves the subscription row does not block either live run.
`775e7893` closes the three records through the official QA register flow and regenerates `qa/BUGS.md`.

Verification: touched JavaScript passes `node --check`; focused provider/ledger/compaction suites are
green (`provider-recovery.e2e` 15, `credrotate` 29, `ledger` 48, `compaction` 8); the QA bug register is
valid with the provider backlog cleared; full `test:http` is green, including sidecar 463, browser
gauntlet 86, route coverage 75, and OpenAI compatibility 36. The first HTTP attempt stopped at the
browser gauntlet; that suite immediately passed 86/86 alone and the complete rerun passed. `test:fast`
is NOT green on this worktree's supplied `90df36dd` base: its first 197 steps, including every provider
and QA-register test, passed, then `qa-product-perfect-claims.test.js` failed nine pre-existing planning-
authority assertions. The coordinator reset trunk to `9aa72820` while this isolated lane was running,
so only these lane commits should be cherry-picked and the fast gate re-run there. No external network,
provider spend, credential, production-data, integration-tree, push, PR, deploy, or publish action occurred.

## 2026-08-03 — PHASE 0 WORLD + SAFECELL P2 RECONCILIATION (`agent/cleanup-p0-world-safe`)

READY FOR CLEAN-TRUNK CHERRY-PICK. Three P2 ledger records were stale: their implementations had
already landed in `f4d03511` (single-flight channel SSE + pending-tooltip cancellation) and
`226cec3c` (watched-only Full Access, permissions readout, and revoke), but the records remained open.
`0b9270fb` re-proves those fixes at the behavioral seams: it executes world.js's production `open()`
closure through error → pending retry → re-entry → stale callback and ends with exactly one live
EventSource; extends the real MCP/sidecar flow to prove a watched wildcard is listed, cannot authorize
the same agent's ungranted routine, revokes real authority, and prompts again; and makes the Full Access
row explicitly name its watched-session boundary and surviving host hardlines. The existing real-module
tooltip rig proves pointerout during the 320ms delay cannot create a ghost while a rested anchor still
shows normally. Focused receipts: channel SSE 75 assertions, tooltip 353, permissions 69, permissions UI
34, MCP HTTP 87, website mirror 8. A seeded station on `:18761` reached ONLINE; SETTINGS › PERMISSIONS
rendered its authoritative ledger, the station tooltip self-started/adopted its CINEMA title and hid on
exit, and the browser warning/error log was empty. The canonical fast gate reached step 198/499, then
hit the known `qa-product-perfect-claims` authority failure introduced by this lane's obsolete base
`90df36dd`; integration has already reset to clean `9aa72820`, so the coordinator must re-run `test:fast`
after cherry-picking the isolated commits there. No sidecar/route code changed in this reconciliation.
## 2026-08-02 — BOUNDED DOMAIN CHECKS + HIERARCHICAL RUN TELEMETRY (`agent/dns-stop-telemetry`)

READY TO MERGE. A single explicit-host inspect/read request is now classified as a bounded local lookup.
The lead is not offered delegation, browser, search, request, or spelling-variant routes for that narrow
shape; it fetches the named host directly. A proven ENOTFOUND/NXDOMAIN result is terminal host evidence:
the loop skips any remaining calls already issued in the same sequential batch, removes every tool, and
allows exactly one final synthesis turn asking for the corrected URL. If such a job reaches a worker through
another caller, the worker is capped to three turns, three tools, and 45 seconds; ordinary workers keep the
existing configured ceiling.

Run history now persists `parentRunId`, actual model/reasoning effort, run start/end/duration, and a bounded
per-call trace with measured milliseconds. `GET /api/runs?...&runId=` joins child rows onto the lead. COMMS
hydrates the resolved run line from that durable row, shows lead and aggregate worker call counts plus the
lead model/effort, and folds a lead/worker breakdown with each tool's elapsed time under the line. The website
mirror is synchronized.

Verification: `node --check` and focused domain/loop/orchestration/runstore/COMMS tests green; canonical
`test:fast` is 498/498 green; full `test:http` is green (sidecar 463 assertions and every listed e2e). The
real-sidecar incident replay then passed 45 assertions: exactly one `web_fetch`, one zero-tool synthesis turn,
no delegated/search cascade, and persisted model/effort/run/tool timings. The real delegation e2e passed 31
assertions and proved `/api/runs` joins the worker to its exact lead with model and elapsed time; runstore reload
proved the join and tool milliseconds survive restart. A seeded station on `:18879` rendered ONLINE with no
browser console errors, then the tab and seed process were closed. No provider spend, external message/write,
push, PR, deploy, publish, credential, production-data change, or integration-tree edit was performed.
## 2026-08-02 — RECOMMENDATION FABRIC 1–5 (MERGED)

MERGED to `feat/harness-backend` at `68cc7af7`; the release surface was re-locked at `c8397e1f`.
The second recommendation audit is implemented as one cross-surface fabric.
(1) Personalization pause is now durable sidecar authority as well as a browser control; it suppresses
new interest, workflow-context, ranking-ledger, scout, and night-shift learning. Forget clears every
derived browser/server model and returns a verified inventory while preserving explicit dossier, goals,
projects, threads, and task history. Seed-only fields no longer contribute readiness breadth, and quests
generated under an inferred north star remain staged until the Commander confirms that direction.

(2) Recipes, recruit picks, study updates, routines, recurring ideas, scout drafts, quests, and night-shift
work now write the same bounded shown/opened/accepted/started/deferred/declined/completed lifecycle. Quest
completion is recorded only from the contract proof seam; recipe and suggested-work completion comes from
the resulting run/rating; terminal outcomes cannot be rewritten. (3) One recency-decayed preference model
over kinds, traits, and projects is served with the scout read and consumed by recipe, recruit, quest, and
night-shift ranking while retaining each surface's policy/readiness gates. (4) The shared utility ranker
balances relevance, impact, success, timeliness, novelty, preference, cost, risk, interruption, and duplicate
penalties; typed wrong-time/already-done verdicts do not poison relevance. (5) The replay CLI now emits an
offline evaluation scorecard: adoption/completion, precision@3, counterfactual regret, Brier calibration,
repeat/contradiction, intervention/cost, temporal improvement, and per-surface rates. Its fixed eight-week
simulation proves that a later automation preference overtakes an earlier research preference.

Verification on merged trunk: focused recommendation/readiness/quest/routine/study/suggestion/
personalization tests green; every touched JavaScript file passes `node --check`; `test:fast` is 495/495
green; full `test:http` is green (sidecar 460, quest refresh 47, cron API 79, lifecycle 59, route coverage
75, browser gauntlet 86). A seeded station on `:8879` at `v0.8.0-135-g14b4fac9` proved the complete
five-state lifecycle and quality outcome, durable pause across restart, model suppression while paused,
and rejection of a paused write. Replay reported completion/acceptance/evidence/readiness coverage 1,
precision@3 1, regret 0, Brier 0.0225, and bounded automation weight 0.5. The final Forget returned all
five derived inventories at zero while explicitly preserving dossier, goals, threads, projects, and task
history; the seed was stopped. The live single-sample receipt exposed and fixed a false temporal-decline
metric, which now reports insufficient data. No provider run, external message/write, push, PR, deploy,
publish, credential, or production-data change was performed.

## 2026-08-01 — ROUTINES P0-P2 CLOSURE (`agent/routines-closure`)

FOLLOW-UP READY TO MERGE after the first closure merge. The six routine/cron findings `4962c3ad`, `f47a1e3a`, `fd0f7223`,
`300b34ab`, `600f4982`, and `aa9cd1cd` are now closed in the canonical QA ledger. This
closure completes truthful E-STOP state across the ROUTINES panel/countdowns, widgets, `/cron`,
AutoJobStore, and model-facing routine output; preserves the durable stop across background
beliefs-only page-load sync; retains explicit resume paths; keeps first cron fire aligned with the
host timezone; gives halted channel runs one explicit stop notice; and prevents revoke/delete/toggle
success claims on non-2xx responses.

Verification on the current trunk-based candidate: focused routine/cron/halt/channel/connector tests
green (including 585 assertions before the page-load escape was discovered); restart-level E-STOP
HTTP regressions green; `qa-product-perfect-claims.test.js` 64/64; `test:fast` 493/493; full
`test:http` green (sidecar 459, cron API 79, lifecycle 59, route coverage 75). Seeded Chromium proved
the stopped banner, `next —`, widget `stopped · E-STOP`, `/cron` resume guidance, and the
model-facing E-STOP note. A reload initially exposed the beliefs-only resume escape; the final code
and the follow-up `b7e18ce8` plus two real-host suites prove both boot posture and beliefs mirrors stay halted across sync and restart; only an explicit dial write carries resume consent. No external message,
provider spend, push, PR, deploy, publish, credential, or production-data change was performed.

## 2026-08-01 — UNIFIED COMMANDER RECOMMENDATIONS (`agent/recommendation-unify`)

READY TO MERGE. Three scoped commits implement the recommendation-system audit actions: `475aa6d3`
adds the durable cross-surface lifecycle/evidence ledger, bounded Commander evidence composer, richer
completed-task context, and replay CLI; `b882665b` gates recruitment and marketplace personalization on
shared understanding readiness, labels cold shelves as starting points, preserves validated study evidence,
and adds typed suggestion verdicts; `70afe07c` normalizes capability learning per completed run instead of
raw tool-call frequency. Seed beliefs no longer inflate visible familiarity. The candidate was merged with
current trunk in `b97b1201`; `7e7ae8e7` re-locked the resulting release surface.

The lifecycle retains bounded transitions and typed reasons (`shown -> deferred -> accepted -> completed`),
survives restart, and feeds bounded preference weights without treating wrong-time deferrals as rejection.
Study proposals may carry a verbatim run quote; invented quotes are rejected, legacy proposals retain an
explicit directive receipt, and pending/declined study state is durable. Ordinary task runs and autonomous
lanes now read the same provenance-labelled topics, threads, workflow, recent activity, active goal, dossier,
and verdict summary; weak observed evidence is explicitly forbidden from overriding the current request.

Verification on the synced final tree: `test:fast` 486/486 green; full `test:http` green (including sidecar 459 and
route coverage 75). Focused recommendation/readiness/workflow/context/study tests are green. A seeded station
on `:18799` recorded `live:sync-7e7ae8e7`, applied deferred/accepted/completed verdicts, restarted with `--keep`,
and reloaded the exact four-state transition plus its evidence. `recommendation-replay.mjs` then reported
acceptance/completion/evidence/readiness coverage of 1 across the two completed samples and a bounded research
weight of 0.5. No provider run, external write, trunk merge, push, PR, deploy, publish, credential, or
production-data change was performed. The seeded proof process was stopped. A byte-identical voice test exposed a 20ms-vs-30ms
timer race in this longer worktree; the test-only compressed ceiling is now 50ms and passed twice plus the gate.

## 2026-08-01 — DEEP-DIVE BUG FIX WAVE — MERGED (`8ef6c2c4`)

Three isolated audit/fix lanes found and fixed 15 previously unregistered defects: four mobile
control-reachability failures, six API/CORS/Task-Brief boundary failures, and five
persistence/recovery failures. The combined integration preserves desktop layout and built-in read
behavior while keeping E-STOP, REFIT actions, dock menus, and Genesis phosphor controls reachable at
320/360/390px; makes DELETE CORS, malformed-body rejection, segment-safe routing, and untrusted MCP
gating consistent; and fails closed when Night Shift accounting, focus/avoid authority, skill
approvals, durable writes, or process ownership probes cannot be proven durable.

Lane commits: UI `f1e5cc75`; backend `e169ab9c` + `9726ce60`; state `517c4398` +
`e17d0294` + `0773b22c` + `654c7e1f`. Combined candidate merge `0ffc9a9f`, canonical claims
re-lock `eb7c2fc4`, trunk merge `8ef6c2c4`. Final clean detached proof at the exact trunk commit:
claims planning PASS (37 claims / 190 locked files), `test:fast` 476/476 green, full `test:http`
green. Live seeded Chromium proved the four mobile controls on the UI lane; the exact merged HTTP
gate re-proved malformed requests, route boundaries, MCP gating, restart persistence, and failure
paths. No publish, push, PR, deployment, release, credential, or production-data action occurred.

## 2026-08-01 — HARNESS SELF-AWARENESS (`agent/harness-self-awareness-reconcile`)

RECONCILED against bridge trunk `25f8b053`. StarNet now gives every compute-capable agent a local, read-only,
consent-free `station.inspect` tool backed by the same build, scheduler, connector, and diagnostic
collectors as the UI APIs. Its output is bounded and allowlisted; secrets and filesystem paths do
not cross the tool boundary, and any failed collector is labelled unavailable rather than rendered
as a confident empty/healthy state. The run identity block now includes the exact app and harness
build, and the operator manual directs mutable harness questions to `station.inspect` instead of
invented CLI commands or requests for WORKBENCH/INTEL CAB.

Verification: focused snapshot/tool/policy/runtime/manual tests are green; the real MCP-sidecar e2e
passes 76 assertions and proves the provider sees and calls the legal `station_inspect` wire name
against a planted routine, connected MCP server, and diagnostic failure. The reconciled `test:fast`
gate is 491/491 green after synchronization with trunk `6819a1af`, and the full `test:http` gate is
green. In a seeded live station on `:8977`,
NOVA used both granted tools in one run: it reported exact clean build
`v0.8.0-73-g30c9a53b`, the disarmed/unhealthy scheduler, zero routines, zero connectors, and zero
recorded errors, then used bounded code composition to calculate `17 * 23 = 391`. The seed was
stopped. No push, PR, deploy, publish, credential, or production-data change was performed.

## 2026-07-31 — BROWSER REACH 0.8.5 (`agent/browser-reach-085`)

READY TO MERGE at `dd01c8d3` (five commits from `7b2550e0`). The station-owned Chromium launch now
derives its UA generation from the installed binary, carries the host locale, removes the
`HeadlessChrome` product token, and disables Chromium's AutomationControlled signal. Attached
Commander-owned Chrome is never launched or modified by this posture. Challenge telemetry is one
conservative classifier across the honest reader and interactive browser; verification walls are a
distinct outcome rather than successful page content. No CAPTCHA solving or wall-bypass claim exists.

CDP's Runtime domain now stays disabled during ordinary browsing and is enabled lazily only when the
agent asks for console diagnostics; the real browser proves buffered console messages still arrive.
Click, type, press, hover, drag, and wheel input now use deterministic seeded cadence with hard step
and delay bounds, exact text preservation, and exact aggregate scroll distance. This is bounded input
fidelity, not an attempt to synthesize an individual person's behavior.

All reader traffic shares one process-wide per-host scheduler. Same-host work serializes with a 350ms
minimum gap; 403/429/503 responses add capped exponential delay (up to 30s), numeric `Retry-After` is
honored, success clears the penalty, and responses are never auto-retried or rewritten. Different
hosts remain independent. The scheduler covers search, Jina, direct reader fetch, and `web_request`.

`scripts/browser-reach-measure.js` produces aggregate authorized-reach receipts without clicking or
submitting: status, challenge signal, text length, identity exposure, elapsed time, and redirect
authorization. Entry origins require an exact explicit allowlist; subdomains are not inherited,
off-authorization redirect content is not read, and escaped redirects cannot count as reach. The
owned real-Chromium fixture records ordinary content as reached and a verification page as blocked.

Verification: focused browser contract 281 assertions; reach-measure contract 15; web-politeness 10;
real-Chromium gauntlet 77; `test:fast` 475/475 green; full `test:http` green (including sidecar 445).
A seeded station booted on `:8897`; `/health` returned 200 with `v0.8.0-18-gdd01c8d3`, the app shell
returned 200/67,131 bytes, and unauthenticated `/api/toolsets` correctly returned 403. The proof seed
was stopped. No external-site benchmark was run because no authorized origin was supplied, so no
claim about third-party wall reach is made. No merge, push, PR, deploy, publish, credential, or
production-data change was performed.

POST-MERGE SWEEP (`agent/browser-reach-sweep`, implementation head `94a034dd`): the first gauntlet
covered only legacy UA + `navigator.webdriver` and missed real contradictions. On the production
resolver, Playwright headless-shell still exposed `HeadlessChrome` through Client Hints, zero plugins,
no `window.chrome`, SwiftShader, mismatched 800x600 screen geometry, and fixed product-named page
globals. The corrective lane now prefers full Chrome/Chromium/Edge, derives one UA + Client-Hints
identity from the connected browser's own loopback high-entropy values, retains the hardware renderer,
sets coherent 1440x900 screen/window metrics, and uses opaque per-profile safety/settle slots. The
authorized reach receipt measures both legacy and Client-Hints headless exposure, full-browser surface,
and geometry. The same sweep made host cooldowns elapsed-time-aware, queued cancellation immediate,
and idle host state LRU-bounded.

Corrective verification: browser contract 293; reach receipt 18; browser parity 111; wait recovery 39;
attach 33; browser PIE 53; web politeness 13; real-Chromium gauntlet 86; `test:fast` 475/475 green;
full `test:http` green. Seeded branch `v0.8.0-32-g94a034dd` returned 200 from `/health` and the app
shell, then the proof process was stopped. `qa:ready` is separately `NOT READY` because this isolated
worktree has no Guardian, journeys, Beginner Run, or installed-exe receipts; no station-wide release
readiness claim is made. External-site reach remains unmeasured without an authorized target.


## 2026-07-31 — NEXT UPDATE PLAN: v0.9.0 LEGIBLE · SOLID · UNBLOCKED

Andrew's mandate for the update after v0.8.0: (1) make StarNet dramatically easier for a
beginner to understand — users are asking a lot of questions; (2) fix as many bugs as we can;
(3) build a stealth engine so station browsing stops being misidentified as a bot. Full plan,
with evidence re-grepped against trunk `129801b1`: **[docs/PLAN_v0.9.0.md](PLAN_v0.9.0.md)**.

Headlines a lane should know before claiming work from it:
- The six routine/cron P0-P2 records from the July sweep are reconciled as fixed by the closure lane
  above. Treat `qa/BUGS.md` (generated from the per-bug files) as the current backlog authority.
- 10 `agent/*` lanes are ahead of trunk carrying built, gated fixes. Merge order in the plan;
  `agent/quality-loop-0730f` (E-STOP does not survive a page reload) is the worst live defect.
- `test:fast` ran 473/473 green at `129801b1` on 2026-07-31 while the Guardian recorded
  `test-fast exitCode 1` at the same commit. Reproduce before planning on top of either.
- The explanation layer mostly EXISTS and is undeployed: 32 glossary terms, a correct hint
  layer, and only 29 `data-hint` attributes repo-wide (4 pointing at undefined terms). The tour
  can only ever run once (`app.js:2977` → `tutorial.js:134`) and a refresh loses it forever.
- The stealth work must be dependency-free CDP-level: `package.json` has two runtime deps and
  the desktop bundle ships no `node_modules`, so Camoufox/playwright-stealth are not options.
  It also REVERSES a written position in `browser.js:1792-1799`/`:2354-2356` — rewrite those
  comments in the same lane or the next session re-litigates it.

## 2026-07-31 — RESUMABLE APPLE NOTARIZATION (`agent/mac-notarization`)

IMPLEMENTED, LIVE RE-PROOF REQUIRED. Developer ID signing succeeded on both Intel and
Apple Silicon in non-publishing run `30606849654`, but Apple's notarization queue remained
in progress long enough to expose a workflow design flaw: three macOS runners eventually
lost their network route while polling, and the fourth was cancelled at GitHub's six-hour
job ceiling. Apple never returned an invalid/rejected verdict. The workflows now build and
sign without giving Tauri the Apple account credentials, submit each completed DMG once,
persist the exact DMG plus Apple's submission ID, and poll/staple/Gatekeeper-verify in an
independently retryable job. A slow queue can no longer discard the signed build or force a
new submission. YAML parsing and focused signing/notarization trust tests are green; the
updated workflow must be merged, pushed, and exercised before macOS support is claimed.

## 2026-07-31 — LIVE HANDS-FREE VOICE RELEASE SWEEP (`agent/voice-release-sweep`)

READY TO MERGE. The current Local Live stack passed a release-focused code, regression, and browser
sweep. Two additional lifecycle defects were closed: a tab holding the pre-restart sidecar token
could open a convincing but silent microphone session, and a microphone-start failure could leave
the Commander's previous speaker mute force-enabled. Local Live now refuses a failed availability
probe before touching the microphone, gives a stale tab an explicit reload instruction, and restores
the speaker preference on every startup failure.

Release accounting was reconciled at the same time: five previously fixed voice findings were still
marked open despite their existing `50a8b07b` implementation and regression coverage; those records
now match the code, and the two findings from this sweep are recorded against `8bc9ff9a`. Focused
voice tests are green (`voice.button` 67 assertions, `voice.draftguard` 21, Local Live UI, realtime,
native STT, local voice, and provider timeouts). Claims planning is PASS (37 claims / 189 locked
files), `test:fast` is 464/464 green, and the full 55-suite `test:http` chain is green. A post-merge
seeded restart and stale-tab browser round trip remain the final live proof. The wider station still
has unrelated open QA-register findings, so this entry is a feature merge verdict, not a whole-product
release verdict. No push, deploy, publish, production-data, credential, or secret change.

## 2026-07-30 — DELEGATED RESEARCH WEB RELIABILITY (`agent/worker-research-reliability`)

READY TO MERGE at `8258e028`. A live researcher run reached its 10-turn ceiling after eight
nearly identical web-search failures. The keyless search providers were throttled, and the
OpenRouter rescue path was then aborted by a 37-second registry wrapper even though the sequential
provider chain legitimately needed up to 56 seconds. The wrapper now covers the full fallback sum
plus scheduling slack, provider-local aborts report an actionable timeout instead of “operation
aborted,” and an exhausted chain tells the worker to change strategy. Delegated workers receive 16
bounded turns (still below the lead’s 40) so transient failures do not consume the whole job.

Regression: focused web/orchestration/harness tests passed; `node --check` passed all touched JS;
`test:fast` is 464/464 green; full `test:http` is green. Live real-provider re-run remains required
after merge/restart. No push, PR, deploy, publish, production-data, credential, or secret change.

## 2026-07-28 — BROWSER.FIND VIEWPORT HONESTY (`agent/quality-loop-0728c`)

READY TO MERGE. The newly added `browser.find` scanned only visible interactive elements but told
the agent an uncapped zero-hit result covered “the whole page” and the target was “genuinely not
there.” Real-Chromium reproduction: a `Checkout now` button below a 1,600px spacer produced exactly
that false absence claim, steering the agent away from the one required scroll. The finder now
states its real boundary—visible controls in the current viewport—and every zero-hit result keeps
off-screen, closed-menu, and not-yet-loaded possibilities open with the correct scroll/open/wait
next moves. It still returns only visible refs whose coordinates the driver can safely act on.

Regression: the real browser gauntlet now includes the below-fold fixture (65 assertions) and the
focused find/recovery contract is 39 assertions. `node --check` passed all three touched JS files;
`test:fast` is 429/429 green; full `test:http:raw` is green through all 51 suites. The standard
420-second `test:http` wrapper timed out after its browser/skill suites had passed; the same raw
chain completed cleanly in 429 seconds. A seeded station reached NOVA/COMMS online with no visible
alerts or browser warnings/errors. No push, merge, PR, deploy, publish, production-data, or source
credential changes.
## 2026-07-28 — SESSION RAIL KEYBOARD ACCESS (`agent/quality-loop-0728d`)

READY TO MERGE — the session rail exposed open/export/archive only through pointer clicks:
live reproduction found the General row was an unfocusable `<li>` (`tabIndex:-1`, no role), and
its hidden actions button was explicitly removed from the tab order. Session rows are now named
keyboard targets: Enter/Space opens the session and Shift+F10 opens the existing phosphor actions
menu. Menu focus starts on Rename; Escape closes it and restores the row focus. The pointer-only
kebab remains out of the tab order, so each session adds one keyboard stop. Live seeded proof:
General reported `tabIndex:0`, `role:button`, and `aria-keyshortcuts:Shift+F10`; Shift+F10 produced
one menu with Rename focused; Escape removed it and restored General. Regression:
`session-power-tools.test` 118→124 assertions; website mirror 8 assertions; claims planning PASS
(37 claims / 184 files); `test:fast` 429/429 green. No merge, push, deploy, publish, or PR.
## 2026-07-29 — CODEX OAUTH MIGRATION ROOT BOUNDARY (`agent/quality-loop-0729c`)

READY TO MERGE. The 07-29 token-leak fix rejected ordinary temporary workspaces, but its fallback
still trusted any path whose tail was `StarNet/workspaces`; an isolated boot could therefore pull
the Commander's ChatGPT OAuth token from a real legacy app-data home by choosing that directory
shape. Reproduction returned `recognized:true`, four migration candidates, and the legacy token
path for `C:\tmp\attacker\StarNet\workspaces`. Migration authority now requires an exact match
against enumerated Local/Roaming/XDG app-data roots (plus the existing injected legacy/install
roots), while both Windows app-data locations remain valid migration sources.

Regression: `provider.codex-auth.test` 65→68 assertions; the escape test failed 3 ways before the
fix and now proves a branded isolated root sees only its own token file. Real sidecar proof with
fake credentials: full-app HTTP 200, provider stayed `openrouter`, legacy fixture remained, and no
token file appeared in the isolated root. Final verification: `test:fast` 432/432 and full
`test:http` green. No merge, push, deploy, publish, PR, production-data, credential, or secret change.
## 2026-07-29 — TOKEN PURGE PROTECTS EVERY REAL WORKSPACE (`agent/quality-loop-0729d`)

READY TO MERGE. The new leaked-Codex-token purge protected only the first available app-data
base. On normal Windows, `LOCALAPPDATA` therefore masked the desktop shell's Roaming `APPDATA`
workspace: a dry run against distinct fake bases listed
`Roaming\ai.skynet.harness\workspaces\codex\tokens.json` as a deletion candidate, despite the
script's guarantee that the signed-in copy must survive. The protected set now includes every
Local/Roaming/XDG app-data base and any explicitly configured current workspace. The identical
post-fix dry run found zero candidates. Verification: both touched JS files pass `node --check`,
the focused destructive-safety regression passes 14 assertions, `git diff --check` is clean, and
`test:fast` is 432/432 green. Only fake temporary data was used and removed. No push, merge, PR,
deploy, publish, production-data, secret, or real-credential changes.
## 2026-07-29 — WINDOWS BACKGROUND PROCESS TREE REAP (`agent/quality-loop-0729e`)

READY TO MERGE. A real-process reproduction confirmed `shell.bg.kill` could orphan the command
and its descendants on Windows: `killTree` terminated the shell leader before launching
`taskkill /T`, so tree discovery raced a disappearing root. After 1.2 seconds, both the command
parent and a planted grandchild were still alive. Windows now lets `taskkill /T /F` own the first
termination attempt and falls back to direct `child.kill()` only when the reaper cannot start or
exits unsuccessfully. The identical post-fix reproduction reported both descendants dead.

Regression: `shell-bg.test` 37 assertions (including tree-reaper ordering and launch-failure
fallback) plus `shell-bg-io` 29 assertions. Final verification: touched-file syntax checks,
`test:fast` 436/436 green, and full `test:http` green. No push, merge, deploy, publish, or PR.
## 2026-07-29 — CHANNEL SETUP GUIDE REOPENS AFTER FORGET (`agent/quality-loop-0729f`)

READY TO MERGE. The newly added CHANNELS auto-fold listener treated its own programmatic
`guide.open = false` as a Commander toggle, deleted the one-shot flag, and left a later cold card
collapsed after its configuration was forgotten. Live seeded Signal reproduction used an isolated
localhost bridge config: saved/offline folded to 13.4 px, then confirmed removal returned the
backend/UI to `not connected` but the guide stayed 13.4 px tall. The listener now treats only
summary activation as the human override; untouched guides track configured state in both
directions. Post-fix live proof: saved/offline remained folded with the auto flag intact, confirmed
removal reopened the guide to 91.2 px, and a hand summary click still removed the flag. Regression
contract expanded to 11 assertions; website mirror synced. No merge, push, deploy, publish, or PR.

## 2026-07-27 — PERMISSIONS OFFLINE STATE STAYS TRUTHFUL (`agent/community-bughunt-0727`)

A Settings/permissions audit confirmed a fail-closed enforcement but fail-open-looking UI defect:
when `/api/permissions` was unavailable, the frontend synthesized an empty successful snapshot.
Settings then claimed “No standing approvals” even though the sidecar could still hold and enforce
durable grants; grant and revoke failures were also silent. The permissions store now distinguishes
unconfirmed/failed snapshots from confirmed empty state, preserves the last confirmed authority,
and surfaces an `aria-live` warning. Failed mutations keep the confirmed row and say the change was
not applied; a first-load failure hides grant controls until authority can be confirmed.

Regression: `permissionsstore.test` 25→36 assertions and `permissions-ui.test` 28→31 assertions.
Live seeded proof covered grant, sidecar restart persistence, offline refresh preserving the grant
with an explicit warning, stale-session revoke failure preserving it, reconnect, successful
two-step revoke, and clean empty state. The Settings catalog exposes one durable permission,
`cabinet:write`; WAIT/SUGGEST/BUILD grant none, FREE grants it, enforcement remains in the consent
broker/jail, and the UI honestly notes that a Filing Cabinet is additionally required. Interactive
once/session/always approvals, per-agent full access, Workshop access, routine terminal/connectors,
credentialed web access, taint revocation, and project path trust were traced and covered by focused
tests (including four HTTP/E2E suites). Voice microphone authority is browser/OS-owned and was not
requested. At 390×844, Settings had no viewport or horizontal overflow; arrow-key tab navigation
worked. New-user/onboarding, sessions/workstreams, fullscreen/terminal resize, voice draft guards,
and settings backend/UI paths passed their existing regression suites. Manual gaps: real microphone
permission allow/deny/reset, OS notification permission, native desktop screen-reader behavior,
and physical-device/mobile WebView compatibility. Website mirror synced. No push, deploy, or PR.
The fast gate passed through step 160/400, then stopped at the unchanged
`qa-product-perfect-claims` release-authority stamp (step 161), the same unrelated stale authority
surface already recorded for this lane.

## 2026-07-27 — REVOKED PROJECT “FORGET” IS REAL (`agent/community-bughunt-0727`)

A second live PROJECTS-rail pass confirmed a destructive-action truth defect: the armed
`Forget (already revoked)` control posted the permissions revoke endpoint a second time, announced
`removed “…”`, and left the remembered project row visible. The existing projects store already
had the intended persist-before-commit hard-forget primitive, so the scoped fix exposes it through
`POST /api/projects/forget` and uses that route only after trust is revoked. The server refuses
still-blessed roots with 409, keeping metadata deletion separate from permission withdrawal; UI
success copy now distinguishes `trust revoked for` from `forgot`. Regression:
`projects-view.test` 51→54 assertions and `e2e.pathtrust.test` 33→39 assertions, including
active-root refusal, actual row removal, and no resurrection after sidecar reboot. Live seeded
proof: the revoked row disappeared, the UI reported `forgot “community-bughunt-0727”`, and after
a real `--keep` restart the PROJECTS rail still had no revoked row. Syntax checks, focused tests,
full `test:http`, and 399/400 fast-gate steps are green; the sole blocked step is the pre-existing
`qa-product-perfect-claims` release-surface authority stamp at the synced trunk HEAD (step 161),
which is outside this bug-fix lane. Website app mirror synced. No merge, push, deploy, or PR.

## 2026-07-27 — REVOKED PROJECTS ARE READ-ONLY (`agent/community-bughunt-0727`)

Proactive live flow audit confirmed a truthful-telemetry break in the PROJECTS rail: after a
project's path grant was revoked, its remembered row correctly said REVOKED but entering it still
promised `+ NEW` would start work in that folder and actually minted a new session anchored to the
untrusted root. The rail now derives scoped creation authority from the freshly fetched
`blessed` field, disables `+ NEW` for revoked rows, keeps existing sessions browseable, and guards
the creation function itself. Regression: `projects-view.test` 48→51 assertions. Live seeded proof:
revoked row remained visible, existing session count stayed 1, scoped `+ NEW` reported
`enabled:false`. `node --check` + focused project/session/path-trust tests + `test:fast` 400/400
green. Website app mirror synced. No merge, push, deploy, or PR performed.
## 2026-07-27 — DOSSIER SKIN SELECTION ACCESSIBILITY (`agent/quality-loop-0727`)

READY TO MERGE. The new CONFIG › SKIN live preview visually marked the worn skin with
`.sel`, but all 36 buttons exposed no selected state to assistive technology. Live repro:
Teddy Bear was the selected tile and preview caption while every button had neither
`aria-pressed` nor `aria-current`. The renderer now derives `aria-pressed="true|false"` from
the same `id === cur` predicate as `.sel`; a source-executed regression renders both possible
selections and locks exactly one true state. Live post-fix round-trip after selecting Pepe:
36 total · 1 visual (`Pepe`) · 1 pressed (`Pepe`) · 35 false · matching preview caption.
Verification: focused test 11 assertions, website mirror 8 assertions, claims planning PASS
(37 claims / 182 files), `test:fast` 403/403 green. Not pushed or merged.
## 2026-07-27 — OUTBOUND MESSAGE INTEGRITY (`agent/quality-loop-0727b`)

READY TO MERGE — the new `channel.send` tool silently clipped any payload above its 8,000-character
call ceiling, delivered the prefix in up to five chunks, and reported success. A real-sidecar DEV-channel
reproduction sent five partial messages (reply count 2→7) while dropping the tail. The tool now exposes
the ceiling in its schema and refuses the whole call before target resolution or transport activity.
Regression proof: 56 focused unit assertions, 35 real-sidecar assertions, and full `test:http` green.

## 2026-07-29 — MODEL CHIP ACCESSIBLE STATE (`agent/quality-loop-0729`)

READY TO MERGE — the freshly promoted COMMS model readout visually showed its selected model and
reasoning tier, but its fixed accessible name was only `Model selector`. `ModelDock.reflect()` now
derives the button name from the same live model/effort state as the visible chip. Live seeded proof:
switching MED→HIGH produced visual `CLAUDE HAIKU 4.5 · HIGH`, selected effort `HIGH`, and accessible
name `Model selector: claude haiku 4.5, High reasoning`. Regression: the focused model suite is
58 assertions, website mirror is synced, syntax checks are green, and `test:fast` is 430/430 green.
No push, merge, deploy, publish, PR, production-data, secret, or source-credential changes.

## 2026-07-20 — PUBLIC-REPO RELEASE PREP (branch `claude/starnet-repo-release-prep-c41845`)

Getting the source repo release-shaped for the public flip (Andrew: "essentially ready for
early release"). DONE this lane: GitHub repo **renamed `skynet-harness` → `starnet`** (still
PRIVATE; old URLs redirect) + description/homepage/topics set on BOTH repos; README rebuilt to
the reference harness/OpenClaw-class presentation (wordmark hero + station render from the website branch, now
committed under `.github/media/`, badges, feature table, importer section); all breaking slug
references fixed (package.json, CONTRIBUTING, issue-template advisory link,
opensource-readiness test) + living docs swept; obsolete `publish.sh` removed; gate 373 green.
**AGENT NOTICE (all worktrees):** `CLAUDE.md`, `AGENTS.md`, and `.claude/` are now UNTRACKED
(public-hygiene; Andrew wants zero Claude files in the public tree). When you sync trunk, git
deletes your tracked copies — restore them as untracked files from the integration tree
(`%USERPROFILE%\Desktop\gen\{CLAUDE.md,AGENTS.md,.claude\}`); new-agent-tree.ps1 now copies
them automatically. The protocol itself is UNCHANGED — the files just live outside git.
OPEN (operator, in order): **docs/PUBLIC_FLIP_CHECKLIST.md** — prune 50 merged remote branches,
`--log-opts=--all` gitleaks run (19 unmerged remote-only branches were NEVER scanned — sole
copies, do not delete), social-preview upload (og-card), push staged starnet-releases landing
page, re-mint RELEASES_TOKEN, then flip. Binary stays `skynet-desktop` (locked; update-path risk).

## 2026-07-20 — v0.6.2 BUG SWEEP (branch `claude/starnet-context-update-32ae68`) — 4 Andrew reports

All four in-branch, gate 373/373 green (incl. new crt-glprobe lock), W0 re-stamped `ed73ba12`:
- **Logo misaligned in windowed mode** (other hardware): positionLogo violated the TEXT SIZE
  coordinate law — visual-px rects into zoomed-space style.top (worst windowed, where the titlebar
  strip makes b.top large; fullscreen hides it, which is why F11 "fixed" it). Now divides by
  uiZoom(); zoom flips re-announce layout (fullscreen.js idiom); fonts.ready + logo-image load
  re-seat the boot half. LIVE: seed :9243 at AUTO 115% — boot-at-rest delta −10px → −0.02px.
- **"skip intro" corner button REMOVED** per Andrew (read as dev chrome; v0.6.1 law = onboarding
  never skipped). In-panel dialogue outs remain, so no-gating holds.
- **mac habitat = solid theme-color wash**: every 2D color in the pipeline is hardcoded RGB — the
  only per-frame platform-divergent stage is drawCurveGL's 2D→WebGL→2D round-trip (ANGLE-on-Metal
  under WKWebView). Shipped a runtime output sanity probe: 3 clean whole-frame channel readings
  latch trust; a divergent one warns + hands the session to the pixel-identical drawCurveCPU.
  Detector math live-proven on the real seed frame (wash/swap caught, identity/vignette pass,
  black frame waits). **HONEST: root cause unconfirmed on real mac hardware** — Andrew's next mac
  launch decides: `[crt]` console warn + healed habitat = confirmed; silent + still green = refuted
  (then the wash is NOT the GL stage — reopen with mac console/screenshot evidence).
- **Maximize button loses shape**: restore glyph's clip-path polygon (78%/22% of 9px) aliased
  under display scaling/zoom → rebuilt as two integer-px background-gradient bars.
- OPEN: merge ritual; Andrew's mac check (above); v0.6.2 cut needs candidate-bound installed proof
  (`agent/release-060-reliability` merge recommended into the same train — beginner preflight fix
  + the missing v0.6.1 NEXT entry).

## 2026-07-20 — RELEASE RELIABILITY AUDIT (`agent/release-060-reliability`)

Andrew's requested 0.6.0 reliability target is already superseded by published v0.6.1. Current
trunk Guardian is GREEN and journeys are 129/129 with 0 open P0/P1, but `qa:ready` remains NOT READY:
the installed-exe proof is not candidate-bound to current trunk. `qa:product-perfect` is also blocked
at W0 with terminal product-claim proofs still pending. The public v0.6.1 manifest carries only
`windows-x86_64`; both macOS DMGs are manual downloads, not updater legs.

READY TO MERGE — the exact-head Beginner Run initially stalled at WAKE because ui-only still used a
dummy OpenRouter key while v0.6.1 correctly added a mandatory real wire preflight. The product gate
was not weakened: ui-only now boots a deterministic local streamed OpenRouter for that preflight;
`--live` remains on the real provider. Original reproduction now PASS (fresh boot → WAKE → floor →
first directive, 90093ms), focused contract 78 assertions, `test:fast` 372/372 green.

NEXT: freeze an immutable RC newer than v0.6.1, build/install those exact bytes on Windows and both
Mac architectures, run installed smoke plus the ≥48h real-provider dogfood soak, and require a fresh
`qa:ready` READY before any broader distribution. Do not revive v0.6.0.

## 2026-07-19 — RELEASE POLISH PASS + UPDATE STAGING (trunk through d2677fd0+)

Full-station polish sweep before the next update cut (Andrew will green-light + test on other
hardware). Done this pass: 3-agent audit (frontend/backend/release) — frontend exceptionally
clean (1 fix), backend error spine mature (no stack leaks); stdout quieted ([channel] payload
log now opt-in STARNET_DEBUG_CHANNELS=1, [aux-governor] only on DEFERRED, [summon] dev-gated);
goldens re-blessed 17 frames after eyeball (clears Guardian golden RED); catalog-oauth lane
MERGED 7dd5e465 (VIA-aggregator jump ported into extracted windows/connectors.js, live-proven
:9186); W0 re-stamped d2677fd0; release-notes DRAFT at docs/RELEASE_NOTES_v0.6.0_DRAFT.md.
- NEXT-UPDATE CUT (recommend v0.6.0), on Andrew's green light: qa:ready -> release:bump ->
  author RELEASE_NOTES.md from the draft -> release:cut -> verify-update-host -> publish ->
  Andrew tests installed exe on other hardware (closes every merged lane's 'OPEN: exe rebuild').
- Known waivers: beginner-run artifact 1 commit stale (PASS 2026-07-19); installed-smoke pinned
  to v0.5.3 bytes (regenerates with the new exe — that IS the update step).

## 2026-07-19 — ONBOARDING V3 lane (branch `claude/onboarding-questions-update-7e28b3`) — S1-S5 BUILT

Andrew's mandate: blitzing onboarding chips yielded a fake dossier → random awful recommendations.
Full plan (Andrew-approved direction, wording in red-pen): `docs/ONBOARDING_V3_PLAN.md`.
- **S1 SHIPPED in-branch (`2189df8b`)**: chips STEER, never answer (canned belief strings deleted);
  beliefs carry evidence WEIGHT (stated/synth/observed/seed); doc seeds + canned intake chips = 'seed'.
- **S2 SHIPPED in-branch**: ONE shared gate `Understanding.readiness()` (grounded direction + grounded
  person + breadth ≥ 0.33) enforced fail-closed at: First Pitch/handoff, generated starter, ongoing
  suggestions, session-opener pitch chip, scout cold-start (server, via synced verdict on the posture
  beliefs snapshot), quest-refresh minting (explicit goal/north star still counts).
- LIVE-VERIFIED on onboard-fresh (port 8819, real key): chip click → steering follow-up, blitz-through →
  dossier = 1 seed belief / grounded 0 / ready:false(3 reasons) synced server-side; typed beliefs flip
  ready:true. Gate 369/369 green (incl. new weight/readiness/starter-gate locks).
- Also fixed pre-existing trunk gate red: opensource-readiness baseline 18→21 (3f6f5384 added 3
  reviewed fixture keys without bumping the lock).
- **S3 SHIPPED in-branch (`f06ebf05` + `3afc3ad2`, W0 restamped `6192c963`)**: the guided-discovery
  meeting B0-B10 (fork / tuesday / generated dig with personalized chips / pain dig / lost-time / the
  year / the MIRROR offers / thin-honest read / proof beat → PitchStore.armFirstMove). LIVE deep-path
  walkthrough on :8819: 8 stated+synth beliefs, ready:true, 4 life-grounded mirror offers, first move
  armed for the tour close. Trap fixed: first ceremony call needs the 40s ceiling (cold wire).
- SUPERSEDED: `claude/onboarding-blitzproof-c268c1` (accidental sibling; covered by S1+S3) — tear down.
- **S4+S5 SHIPPED in-branch (`7312be5b`, W0 restamped `46460dde`)**: HUNT MODE (curiosity hunt profile —
  work floor waived + cap 2 below the gate, dismissed/stop-forever intact; opener pitch slot becomes the
  'ask me one real question' probe → one-question intake at the top-VOI dim; intake bank rewritten into
  the scene register) + BRAIN-GATING (keyless wake = honest holding line + scripted mission/cadence + a
  persisted IOU; first live-brain session offers the real interview once — spent on offer). LIVE-PROVEN:
  loose station → hunting:true, probe chip → year question → typed answer landed 'stated'; deferred flag →
  boot offer → accept launched the full meeting in-game.
- OPEN: Andrew red-pen of the live wording + his own live pass; merge ritual; exe rebuild after merge.
  Not live-walked (honest): the keyless-wake branch itself (source-locked; needs an unconfigured-brain
  state the dev harness can't produce naturally) and a completed deferred meeting (same runLeadMeeting
  machinery proven live in S3).

## 2026-07-19 — COMMS CLEAN-UP: two-tier transcript (MERGED trunk f734e15a)

Andrew: "comms still feels like a cluttered mess." Diagnosis (live + full code audit): the
transcript was a WORK-LOG — every turn permanently deposited a "■ RUN COMPLETE" row + tool-chip
rails between speech, trophy/quest broadcasts each took a full row, and 9 gold .turnin variants
shouted as loud as a blocking consent. Fix (chat.js + comms.css only, FNV/CRT vocabulary intact):
(1) RUN FOLD — resolvePresence absorbs the run's tool rails into the resolved line
("RUN COMPLETE · 8s · N tools ▸"), collapsed, click/Enter toggles, rails moved never deleted;
(2) broadcast COALESCING — consecutive station lines stack in ONE hairline block (tone per-line);
(3) beat hierarchy — passive .turnin family whispers (1px gold rail, no glow, 14px), only
.consent keeps full lit gold. Live-proven on a real haiku+fs.list run (seed :9281); gate 369/369
green incl. comms-presence lock; W0 re-stamped in-branch 11223bd7.
- [x] MERGED to trunk f734e15a + W0 70a99f2d (digest in qa/STATUS.md). Also shipped: hover-only timestamps + failed-run fold self-expands. Andrew declined: tb-read fold, receipts coalesce, chip removal. OPEN: exe rebuild.

## 2026-07-19 — SESSION TITLING: real model summaries, not first-words (MERGED trunk 9fe9bbe1)

Andrew's report from other-hardware testing: session titles were "whatever the first few words the
user typed". Root cause: the quiet retitle call's `internal:true` never left the browser — the
sidecar buried its "reply with ONLY a 3-6 word title" prompt under the operator manual / capability
summary / skill catalog / memory fence; models answered chattily, cleanTitle rejected, the instant
placeholder stayed forever. Fix (lane `claude/starnet-session-titling-343578` → merge `9fe9bbe1` +
W0 re-stamp `d839ccc9`): `internal` rides the /api/run body; runOnce keeps reason-only self-talk
prompts VERBATIM (also: no memory fence — was faking memory.used stats — no transcript seed; away
clock never stamped by self-talk). Applies to ALL internal callers (retitle/goal-judge/pitch/
suggest/autopilot). Hardening: `Workstreams.needsModelTitle` retries a stranded placeholder on
later turns (covers failed first attempts AND sessions saved by pre-fix builds), summarizing the
session's FOUNDING message; cleanTitle strips think-blocks/"Title:"/md headings. Live-proven on
worktree AND merged-trunk bytes with real haiku runs (internal call 499 tokens vs 10.8k dressed).
- [x] MERGED to trunk 9fe9bbe1 (digest in qa/STATUS.md). OPEN: exe rebuild.

## 2026-07-19 — DUPLICATE POPUPS: pending question owns the COMMS moment (MERGED trunk 4b07b2e0)

Andrew live-caught: a run ends by asking a clarifying (Task Brief) question, then a second popup
("is your north star financial freedom") stacks over it — and the second card's choices() wiped
the question's own answer chips, so the task was lost and had to be re-asked. Root cause: run-end
made Chat.isBusy() false, and NOTHING tracked the pending question, so every polling confirm beat
(north-star propose, quest attest, curiosity/suggestion/night nudges) saw a "free" moment.

Fix (lane `claude/agent-duplicate-popups-d2f22f` → trunk `4b07b2e0` + W0 re-stamp `48b8d102`):
chat.js `taskQuestionLive()` — a pending unanswered question on the displayed stream now blocks
nudge/curiosityNudge/offerCuriosity/beatBusy/awayDigest/workshopReturn/goalBlocked; quest stores
gate on Chat.beatBusy() and degrade to the ambient broadcast line. Reverse direction closed:
offerTaskQuestion/offerFork clearNudge() first (a live nudge leaves whole); app.js summon desk
chip gates on beatBusy. All remaining direct Chat.choices callers audited safe (digest in
qa/STATUS.md has the full audit). Live-proven on worktree AND merged-trunk bytes (mock seed).
- [x] MERGED to trunk 4b07b2e0 (digest in qa/STATUS.md). OPEN: exe rebuild.

## 2026-07-19 — TIMESTAMP HONESTY sweep (MERGED to trunk e087fdd8 fast-forward)

Andrew's law: every user-visible timestamp = the EXACT moment the thing was produced — never
queue/poll/adopt/boot/render time. Two audits swept every time surface + every stamp write; all
confirmed lies fixed (gate 369/369 + test:http green; live-proven on seeded :9253 — planted an
8h-old deliverable pre-boot, fresh sidecar served builtAt intact, session adopted at builtAt,
clicking the rail row read "8h" not "now"):
- 4a16ecf3: rail "now" lie — workshop re-offer polls no longer re-stamp lastActiveAt
  (new Workstreams.markUnread re-flags unread without touching the clock).
- 6fde3785: builtAt end-to-end — markBuilt stamps it (injected now), rides the emitted manifest
  (inside the opaque manifest field; owned shared/ untouched), /api/workshop/pending exposes it
  (runStore run-end fallback for legacy), /api/deliverables pending rows + lifecycleRow use build
  time not queue time, restorePending keeps the ORIGINAL builtAt across an undo, ensureSession
  adopts sessions at builtAt, cron boot-backfill/heal pass run.ts/done.ts (appendRun gained
  optional `at`), run-recap duration reads Channels.elapsedOf (pauses excluded) not send→teardown.
- W0 re-stamps in-branch: 52d51074 + 823d00fe.
- NOT in this lane: the onboarding blitz-proof work built here by a cross-session mix-up lives on
  `claude/onboarding-blitzproof-c268c1` (UNMERGED, unreviewed) — owned by the onboarding session.
- [x] MERGED to trunk e087fdd8 (digest in qa/STATUS.md). OPEN: exe rebuild.

## 2026-07-18 — v0.5.3 CUT + PUBLISHED (Windows) — desktop exe rebuild CLOSED

v0.5.3 cut from trunk `e5e2d0dd` (tag `v0.5.3` local), signed, and **PUBLISHED to GitHub
Releases** at `androoAGI/starnet-releases` (repo flipped PUBLIC — binaries
only; old v0.4.0/v0.2.2 stay drafts=invisible). Proof chain: fast gate 369/369 green at built
bytes; installed locally (0.5.2 → 0.5.3) with `qa:smoke:installed` **GREEN**;
`verify-update-host` green on every windows-x86_64 check (manifest + signed exe live at the
pinned `/download/v0.5.3/` URLs). Every merged lane's "OPEN: exe rebuild" through `e5e2d0dd`
is now bundled and shipped. Fresh install on new hardware:
https://github.com/androoAGI/starnet-releases/releases/latest
- Gate unblock (recorded): 4 stale `w0-candidate-*` source snapshots (2026-07-13) in
  `.dogfood/` made lint-evidence-secrets take 10min and fail on fixture keys; MOVED to
  `C:\Users\<you>\gen-trees\..\gen-quarantine\dogfood\` (nothing referenced them).
- **Mac test build SHIPPED (2026-07-19):** trunk pushed to origin (branch only, 1261 commits
  — tag deliberately NOT pushed; release-train stays untriggered), `desktop-build.yml`
  dispatched with publish-test. Mac legs first failed on the empty-`APPLE_CERTIFICATE`
  env trap (Tauri codesign-imports zero bytes) — fixed in-workflow (`adddaedf`, unset empty
  signing vars). All 4 platforms then built; CI publish job 403'd (RELEASES_TOKEN secret is
  a stale/underscoped PAT — needs re-mint) so artifacts were published from the operator
  machine instead. Pre-release `test-v0.5.3-r3` LIVE on starnet-releases with both DMGs
  (aarch64 + x64) + exe + AppImage + deb; updater "latest" feed verified undisturbed.
  Gitleaks push-gate: 3 findings = test fixtures, reviewed into `.gitleaksignore`
  (`3f6f5384`), scan clean.
- Still open (operator): re-mint RELEASES_TOKEN secret on the starnet source repo (CI publish);
  mac/linux platforms absent from the UPDATER manifest (5-platform bar = CI-train launch,
  unchanged); `v0.5.3` tag push (fires the blocked release-train) = Andrew's call;
  updater-key backup; Apple codesign/notarization secrets for public mac distribution.

## 2026-07-18 — IMPORT AGENT from the reference harness/OpenClaw (branch `claude/agent-transfer-hermes-openclaw-9f0efb`)

Andrew's ask: his community (thousands on the reference harness agent / OpenClaw) needs a one-click migration
into StarNet — this is launch-conversion work. Shipped in this lane:
- `sidecar/harness-import.js` (pure, UMD, injected-data): detectCandidates (env-built roots incl.
  REF-HARNESS_HOME/OPENCLAW_STATE_DIR overrides), filesWanted whitelist, scanProfile → normalized
  preview { name, persona, instructions, userContext, memory{curated,dailyCount}, model, warnings }.
  JSON5-tolerant openclaw.json parse (comments/trailing commas/bare keys/single quotes), line-based
  config.yaml model extraction. SECRETS LAW: key-shaped values dropped, never emitted; warning
  "API keys never transfer — re-enter them in the KEYS tab".
- Routes `POST /api/harness/detect` + `POST /api/harness/scan` (read-only, path-jailed, forbidden
  `.env`/`auth.json`/sqlite/sessions, 128KB read clamp).
- Recruitment Bay `⇪ IMPORT AGENT` (summon mode): detect list + PICK FOLDER fallback → truthful
  preview card → RECRUIT mints via summonAgent; docs via App.applyConfig (persona APPENDED under
  baseIdentity, orders→manual, USER.md+curated memory→context, labeled headers). Model pin only for
  recognized providers (`ModelDock.labels.normProvider`), bare id for direct providers.
- Proof: live on seeded :9217 with fixture installs — both harnesses detect/scan/mint end-to-end;
  roster rows `vex` (default model, unparsed-config honesty) and `cassandra` (anthropic/claude-opus-4.6
  pin, bare id); composed system prompts carry persona+orders+memory, zero secret bytes in any
  response/prompt (planted fake keys never leaked). test:fast + test:http green in-branch.
- [x] MERGED to trunk 77f40138 (digest in qa/STATUS.md). Open: MIGRATING.md guide for the launch
  content push; session-history import deliberately out of scope v1; exe rebuild bundles the flow.

## 2026-07-18 — CONCURRENT SESSIONS ON ONE AGENT (branch `claude/multiple-concurrent-sessions-736e68`)

Andrew's ask: multiple COMMS sessions may drive the SAME agent at once (the reference harness parity), with the
agent staying at its workstation until the LAST run ends. Shipped:
- **Admission mutex retired** (sidecar/index.js): same-agent runs are ADMITTED concurrently; the
  distinct-agent fan-out cap is unchanged. The workspace/shadow-git collision moved to a
  **run-scoped workspace lease** (`sidecar/workspace-lease.js`, unit-locked): taken at the first
  workspace-MUTATING tool, held to run end (contiguous checkpoint chains); a sibling's mutating
  tool waits (`STARNET_WORKSPACE_LEASE_WAIT_MS`, default 45s) then fails truthfully naming the
  holder session. Chat/reasoning runs never touch the lease.
- **COMMS soft gate** (chat.js): composer never disabled by a peer run; idle session reads
  `online · also running in <session>` + ALSO RUNNING IN row with VIEW ACTIVE RUN. Per-stream
  one-run gate intact. Old `agent_busy` refusal handling kept as defense vs old sidecars.
- **Proof**: e2e (two same-agent runs both end `done`), 362/362 fast + test:http green, live
  seeded-app run: refcount 2 while both stream, one ends → agent STAYS working, last ends → idle.
  World needed no change (liveRunsByAgent overlap refcount already only extinguishes on last end).
- [ ] Follow-up candidates: crew-panel ×N run marker; lease-wait surfaced as a COMMS beat;
  hub.js supersede-retry comment is now historical (behavior unaffected).

## 2026-07-18 — KEYS tab: custom service API keys (branch `claude/custom-api-key-storage-000c3f`)

Andrew's ask: a safe place to paste an API key for ANY platform (not a provider key, not a full MCP
connector) — a KEYS tab in TOOLSETS & CONNECTORS under CATALOG. Shipped in this lane:
- `sidecar/servicekeys.js` (pure core) + `/api/servicekeys` (GET/POST/toggle/remove): protected store
  `connectors/servicekeys.json`, verified read-back persist, list responses masked (never the value).
- Consumption path: enabled keys → `process.env` (ownership guard — ambient env vars always win) so
  shell.exec children inherit e.g. `RESEND_API_KEY`; names-only `<service_keys>` prompt block at the
  system-prompt seam, gated on shell.exec in resolved tools (truthful-telemetry).
- KEYS pane: connected keyed platforms (truth = /api/connectors hasToken, oauth excluded, read-only)
  + custom rows (kill-switch, masked last4, env-var readout, docs link) + add-unlisted form.
- Polish pass: RESERVED-ENV guard — a paste named after a model provider ('OpenRouter' →
  OPENROUTER_API_KEY) would have become billing credentials via providerRuntimeKey's process.env read;
  upsert now refuses every registry keyEnv name (+ STARNET_/SKYNET_ scoped forms), applyEnv skips them
  as belt. KEYS lists re-poll on tab entry; one-click REMOVE (mc-row idiom). W0 re-stamped in-branch
  (65ffffde over shipped bytes 9638869c).
- Gates: test:fast 363 green at final bytes; servicekeys.http e2e (28 asserts, restart round-trip +
  provider refusal) added to test:http. Live-proven on seed :9207 (add/mask/toggle/remove/platforms/
  provider-refusal DOM round-trips; no secret in responses; ⊟ glyph measured non-tofu).
- [ ] Open: live proof of a real agent shell run reading the env var; per-agent scoping if wanted later.
## 2026-07-18 — ARCHITECTURE AUDIT: Tier 1 landed (branch `claude/starnet-codebase-audit-ff0b4c`); Tier 2/3 backlog

Full-codebase cleanliness audit (4 parallel sweeps: sidecar, frontend, contract seams, dead code).
Tier 1 executed in-branch, gate 364/364 green: `sidecar/respond.js` canonical json()/isAgentId
(3 sendJson copies + serve* family migrated; dead `tool.web` warn-filters removed), `Harness.api`
JSON client (stationui.js 56/65 fetch sites migrated; 9 left raw deliberately — test-pinned
literals, streaming, Response-shape consumers), `el()`→`mkEl` collision fix, 4 stale root planning
docs → docs/archive/, 15 orphaned scripts deleted, terminal-position.test + openai-compat.e2e wired
into gates, W0 re-stamped. NOT done (locked/blocked): tts/stt 200-always is a LOCKED decision
(DECISIONS.md:56) — do not "fix"; escaping unification blocked by tests that execute the local fns
outside page scope.

Tier 2 backlog (each its own lane; incremental only, no big-bang splits while lanes are in flight):
- [x] Declarative route table — DONE, merged fb43b0f7 2026-07-18 (176 ifs -> ROUTES data; next slice = per-domain route modules registering into the table) (~174 if-lines; THE merge hotspot; encode
      the tts/stt fail-open policies as data)
- [x] BUILDERS split (partial by design) — DONE, merged d2b335ba 2026-07-18: 7 self-contained windows -> app/windows/*.js via StationUI.registerWindow; SETTINGS/CONNECTIONS/dossier etc. deliberately kept in core (mutable-state entanglement). Original item: split stationui.js along the BUILDERS registry (stationui.js:7197) into app/windows/*.js,
      one window per PR
- [ ] Settings-store factory for the ~25 loadX/saveX/global triples (whole-file clobber race class);
      fold the 4 bespoke token stores onto makeDurableJsonStore (security-adjacent)
- [ ] Extract leaf domains from sidecar/index.js: TTS/STT (~445 ln), scout+questrefresh glue (~600),
      workshop (~900); port telegram onto the wireChannel path (needs live verify)
- [ ] Shared frontend poller primitive + bus-fed runs/cron/channels store (16 timers today; /api/cron
      fetched by 10+ files); load shared/events.js in frontend, validate at SSE ingress (log, not drop)
- [ ] Generic beatCard(spec) engine for chat.js's 6 cloned card lifecycles (~1,000 ln; one-beat-slot
      law — verify live)
- [ ] Contract hygiene (owner request, additive-only): document workshop.decided branch/root +
      channel.connect ok; mark ~15 never-emitted events DORMANT; emitter drop-counter into /api/diagnostics
Tier 3 (merge-quiet window only): runOnce decomposition (1,080 ln); shared e2e boot helper (~40 test
files). Owner decisions pending: docs/raw-*-output.json (450KB) + qa/STATUS.md (314KB) in public repo.

## 2026-07-17 — AUTONOMY TUNING (direction dial) — merging this pass (claude/agent-autonomy-tuning-89786e)

Andrew's ask: let users guide WHERE the agent's autonomous work goes, as a release cherry-on-top.
Shipped (feature `d7821054`+`eebf7f11`, W0 re-stamps in-branch; digest in qa/STATUS.md):
- **AVOID directive** (nightfocus.js + POST/DELETE /api/nightshift/avoid): durable off-limits list the
  focus resolver can never pick; latest-directive-wins on steer/avoid conflict; resolver fails toward
  not acting; restart-safe. Pure tests 55 assertions green.
- **Steer → scout cross-wire**: scoutDirectionBlock now leads with the live steer (same steerActive gate).
- **DIRECTION block in the AUTONOMY settings tab**: focus readout + steer + OFF-LIMITS (RULE OUT /
  ALLOW AGAIN) + evidence-cited LEARNED INTERESTS from /api/scout. Live-proven full cycle on seeded app.
- [ ] Later (not this lane): thread steer/avoid into quest refresh + First Pitch grounding blocks.

## 2026-07-17 — SESSION TOOLS window retired (branch `claude/sessions-panel-removal-b3278e`)

Andrew's directive. The SYSTEM ▸ SESSION TOOLS window + parked `#ws-tools` panel are removed;
clear/bulk-archive/undo UI died with it (the pure `workstreams.js` store keeps every invariant;
`/clear` + per-row archive cover the real needs). Survivors: **title+transcript search now lives
directly on the sessions rail** (`#ws-rail-search`; PROJECTS view hides it; hit-click opens the
session) and **export .md/.json moved into the row ⋯ menu** (targets the exact row session).
QA followed: journey rewritten (10/10 live PASS on seed :9095), `sys-sessiontools` shooter state +
golden dropped, atlas retired-control entries deleted + ws-search/ws-export re-pointed, wiring test
re-pinned, v0.5.2 release-notes bullet updated, in-branch W0 re-stamps over `83292661` and the
trunk-sync. Merging to trunk this pass (digest in qa/STATUS.md); next desktop exe rebuild picks it up.

## 2026-07-16 — CLASS ROSTER REDESIGN LANDED (agent-class-redesign lane)

The recruit catalog is now 12 SPECIALIZED business-grade builtins (strategist · opportunist ·
researcher · engineer · analyst · marketer · publisher · producer · writer · prospector ·
treasurer · scout) + 18 archetypes (8 demoted generalists, 6 kept deep cuts, 3 new long-tail
seeds closer/steward/optimizer, + envoy demoted 2026-07-17 on Andrew's call). liaison/publicist/
bookkeeper RETIRED (superseded by envoy / marketer+publisher / treasurer). Typed-ASCII class
marks REMOVED — the engraved SVG coin seal is the one emblem system again. Scout matchArchetype
now coverage-scores (majority-token rule); prospect directive demands specialized roles. 7 new
kit-grounded skills (+ opportunity-scan). W0 re-stamped post-merge.
Open follow-ups: regenerate qa/atlas crew evidence (stale "18 builtins" notes); consider a
first-run default-class experiment (strategist is now the bay's default card).

## 2026-07-17 — FULL-RELEASE CAMPAIGN (active; Fable-orchestrated)

Goal: full public release clean on Windows AND macOS; subscriptions = the NEXT official update.

- [x] **MERGED `bae18072` — night-shift precheck fail-closed.**
      Trunk failed open when budget/provider/readiness inspection threw, spending a leash unit and starting
      unattended work through an unproven safety gate. The driver + composition root now stand down before
      spend as `precheck-error`; status, durable ledger, and morning-report copy all explain it truthfully.
      Verified: focused 51+107 assertions; `test:fast` 351/351; full `test:http`; real fault-injected sidecar
      over HTTP reported `beatsUsedToday:0` and persisted `detail.preSpend:true` (`nightshift-budget.e2e` 11/11).

**MERGED: Wave 4D supervised background lifecycle** (agent/lifecycle-4d → trunk `7f3af0be`,
claims re-stamp `bc4ac138`; full digest in qa/STATUS.md 2026-07-17). The owner-decision
checkpoint below (POWERUSER_FIX_PLAN Lane 4D) is CLEARED — Andrew approved the recommended
shape. Tray supervisor + `GET /api/lifecycle/armed` + durable cron halt (`cron.halt.json`,
E-STOP parity with night-shift be03e5d0) + opt-in launch-at-login. Gates green (fast 346/346
clean-worktree, http full, cargo 21 tests). The formerly-REFUTED after-close claims are now
SHIPPED-with-liveProof-PENDING in qa/product-perfect/claims.json.
- [ ] **ATTENDED (Andrew or supervised session): the six installed-exe lifecycle proofs** —
      close-with-armed-routine → fires exactly once + durable result; orphan-free Quit;
      autostart login = one sidecar; update-drain; tray Pause/E-STOP while closed; disabled
      state spawns nothing. Requires installing a fresh trunk build (this machine currently
      runs an older installed build; EBWebView purge recipe applies on exe swap).
- [ ] macOS runtime proof of the tray/autostart paths (cfg-clean + documented APIs only so far).
- [x] **LAUNCH RUNBOOK: docs/LAUNCH_RUNBOOK.md** — MERGED to trunk (verified present 2026-07-17;
      the claude/starnet-code-prompts-a9d3a7 copy is patch-identical). KEY FINDING: NOTHING 0.5.x was ever pushed/published —
      origin tags stop at v0.4.0, starnet-releases 404s; launch = the CI train's FIRST live run
      (all 5 platforms) at v0.5.2. Andrew's chain: updater-key backup (NONE exists) + dev-key
      rotation → push trunk+tag → publish → verify-update-host → W1 second-user proof →
      per-platform canaries → Mac auto-update test → T0 evidence → certify:providers real keys.
- [ ] Subscriptions/credits merge (claude/starnet-subscriptions-plan-4d56d1, 5 ahead / 314
      behind trunk) + Stripe/domain/deploy — NEXT UPDATE, do not merge during launch.

## 2026-07-15 — POWER-USER DEEP-DIVE AUDIT (3 isolated agents, no fixes)

Full evidence and repros: `docs/POWERUSER_AUDIT_2026-07-15.md`. Baseline gates were green
(`test:fast` 328 steps, full `test:http`, `qa:journeys` 123/123), but live adversarial use
confirmed **14 new defects: 4 P1 · 8 P2 · 2 P3**. Highest priority:

**Fix execution plan (2026-07-16):** `docs/POWERUSER_FIX_PLAN_2026-07-16.md` — four waves,
EL-3 reproduction per defect, serialized `index.js` / `stationui.js` / `chat.js` ownership,
live restart criteria, composed gates, and a final installed-app proof. Wave 4D (tray-supervised
background lifecycle) remains an explicit owner decision checkpoint; the plan recommends opt-in
launch-at-login plus visible tray ownership, never a hidden daemon.

**2026-07-16 (late) — ALL 14 PU FINDINGS RE-VERIFIED FIXED AT TRUNK `f2c6d92a`** (post-merge-review
lane; 5-agent code-verification sweep with file:line evidence). The plan above was written at
baseline `bf99df2a`; the subsequent power-user loop repairs merge (`8ce4c967`), the summon-naming
lane, the nightfocus validator, and the Task Brief chat.js waves closed every seam. Each has a
dedicated regression test on trunk:

- [x] **PU-03 P1:** backup.js `isCredentialKey` denylist (default-deny `starnet.byok.*`), export
      `secretsIncluded:false`, import guard. — [x] **PU-01 P1:** `validateNightFocusSteer`
      (index.js ~8368): 404 missing path, 403 unblessed, thread/goal checked; nothing persists on
      reject. — [x] **PU-02 P1:** disabled connectors are durable management rows (boot registers
      all, list merges, EL-3 restart test in e2e.mcp-connector). — [x] **PU-04 P1:**
      `visibleTerminalRect` clamp on drag/restore/resize + repaired coords persisted
      (terminal-resize journey asserts reachability incl. phone viewport).
- [x] **PU-05..PU-12 P2:** clearSteer drops steer-derived focus; Signal ✕ REMOVE CONFIGURATION
      (read-back proven, no token lie); Ollama/custom = LOCAL ENDPOINT CONFIGURED/OFFLINE with
      reachability-gated ACTIVE; `allocName` uniquifies defaults + `[id]` badge on collisions;
      `busyPeerFor` preflight = BUSY IN <session> + VIEW ACTIVE RUN; `formatRunHolderAge` "just
      now"; mid-stream sidecar death classified station-unreachable; `persistPartial` keeps
      streamed text + disconnect marker on both error branches.
- [x] **PU-13..PU-14 P3:** `Workstreams.startSession` reuses the untouched blank; stopped runs
      offer Try again (incl. after reload; clarifying end correctly excluded).

Remaining from this audit: Wave 4D (background lifecycle) = Andrew's product decision; minor
coverage gaps noted in the review lane (route-level test for validateNightFocusSteer; explicit
poisoned-termPos reload assert). EL-3 law applies to any NEW finding. Do not infer station-wide
readiness from the green baseline; Atlas at this head is 444 stale · 123 unmapped · 1 missing.

## IMPLEMENTED 2026-07-16 — TASK-BRIEF RELIABILITY HARDENING (`agent/briefing-reliability`)

The intent layer now has a host-enforced decision boundary before settings are exposed. Structured
`brief.ask` / `brief.proceed` controls validate question quality and settle a compact execution brief;
write/execute tools stay locked until settlement, while read tools remain available for research. The host
enforces the two-question ceiling and second-blocker rule, stops same-batch actions after a question, routes
cancel/pivot/answer replies without contaminating the prior task, resumes terse messaging-channel answers from
durable state, and derives weak relationship patterns only from completed briefs. Internal controls are hidden
from ordinary tool telemetry; the existing natural COMMS chips and numbered channel fallback remain compatible.
Deterministic coverage is expanded to 73 task-intent assertions spanning validation, restart, cancellation,
pivots, completed-only learning, mutation gates, registry control preservation, call pairing, and one-turn pause.

## READY TO MERGE 2026-07-15 — TASK-CONTEXT ELICITATION (`agent/intent-engine`)

StarNet now listens before it builds without turning every request into an interview: a shared
discover-before-ask doctrine; one natural 2–3 choice question only for material, non-discoverable
gaps; a hard two-question task cap; and an explicit “use your judgment” escape. Answers resume the
same durable Task Brief after reload/restart, remain task-local, flow into delegated workers, and only
compound into weak relationship evidence after the same decision is observed twice. COMMS strips the
protocol into chips; Telegram/Discord/Slack/Matrix/Signal use the same continuity with numbered text.
Clarification turns are neutral (no product/XP/First-Pitch/learning sweep); unattended cron/night-shift
runs stay unchanged. Live-proven in the real seeded app: question → reload → restored choices →
“operators” → clean continuation, with `task-briefs.json` recording `status:"done"` and the clean answer.
Gate: 328/328 runnable fast steps green; the sole stop is the documented 9-assertion W0 candidate-SHA
worktree baseline in `qa-product-perfect-claims`; `test:http` fully green (404 sidecar assertions + all e2e).

## 2026-07-15 — v0.5.1 CUT + INSTALLED LOCALLY (trunk `3d70d7b1`, tag `v0.5.1`)

Signed release cut at trunk head (rc/0.5.1 content + docs + real RELEASE_NOTES.md; W0 surface
re-stamped, claims authority PASS). minisign verify OK against the baked pubkey; artifacts staged
in `release/` (StarNet_0.5.1_x64-setup.exe + .sig + latest.json, sha256 75bf43e4…). Installed on
Andrew's machine (registry 0.5.1, exe ProductVersion 0.5.1, app relaunched, sidecar up + token-gated).
- [ ] **Andrew: PUBLISH** — GitHub Release `v0.5.1` on `androoAGI/starnet-releases`
      with the three `release/` assets (checklist in the release-cut output); then
      `node scripts/verify-update-host.mjs` + the public update canary.

## 2026-07-16 — RELEASE CANDIDATE PINNED: `rc/0.5.1` @ `503ba26f` (READY + beyond-gate proofs)

`npm run qa:ready` = **READY at `503ba26f`** (2026-07-16 00:41Z; all 5 receipts, W0 wave PASS) and
that exact commit is pinned as branch `rc/0.5.1` + tag `rc/0.5.1-rc.1` — trunk keeps moving (3
sibling merges landed during the pass; freeze-first is the law), the RC pin holds the proven bytes.
Beyond the gate, proven this session (receipts `.bugloops/release-prep-2026-07-15/`):
- **Update canary CLEAN end-to-end**: canary 0.5.0 → 0.5.1 through the REAL machinery — signed
  manifest via release-assemble-manifest, minisign verify against the baked pubkey, NSIS passive
  install with NO node.exe lock hang (the 72dea45a fix holding), installer exited, app relaunched
  as the new version. `release:cut --dry-run` clean; verify-sig wired.
- **Real-provider run on the installed binary**: live OpenRouter run in the installed 0.5.0
  (@503ba26f), went busy, streamed, completed — agent replied RELEASE-CHECK-OK.
- **Installed smoke GREEN v3** (reproducible-source, 9/9), Guardian GREEN (incl. one hourly cycle
  under the real scheduler token proving the shell-machine-state fix), Beginner PASS, journeys
  123/123, golden re-blessed 2× (recruit/messaging + UX-clarity copy drifts, eyeballed).
- Guardian-RED-under-load = KNOWN flake class (spawnSync null / J2 poll windows while cargo builds
  run) — re-run isolated before believing an hourly RED that overlaps builds.
REMAINING, honestly out of this machine's reach:
- [x] **Andrew: attended 15-min playtest** — DONE per Andrew 2026-07-15: "ran perfectly for me as
      a user" (the docs/PLAYTEST_SCRIPT_GATE5.md item dodged since 7/02 is cleared). NOTE: the W1
      WAVE is a separate, stricter proof — attended FRESH-PROFILE first-run on the exact rc binary
      through `scripts/qa/installed-first-run.mjs`, with isolation authority `separate-windows-user`
      / `virtual-machine` / `clean-machine` (this login doesn't qualify). Cheapest honest path on
      this PC: create a second Windows user, install the rc exe there, run the W1 driver attended
      (~15 min). Folds naturally into the 10-outside-installs step otherwise.
- [ ] **Andrew: publish `starnet-releases` + key backups + dev-key rotation**, then the public
      per-platform update canaries; 48h RC soak per docs/RELEASE_READINESS.md.
- [x] Outside installs on other hardware — ATTESTED by Andrew 2026-07-15: installed on a separate
      Windows machine AND a Mac, both "worked perfectly" as a user. This clears the practical
      clean-machine concern; the FORMAL T0/T3.2 gates still want their evidence JSON captured
      during such an install (`STARNET_T0_CLEAN_EVIDENCE` — see scripts/t0-clean-install.mjs) —
      capture it on the next outside install rather than re-doing these.
- [ ] Mac AUTO-UPDATE remains the one unproven mechanism (install ≠ update): one run of
      docs/MAC_UPDATE_TEST.md on that Mac after the next release publishes. The guaranteed manual
      fallback + data-preservation guarantee (1884393f) bound the damage if it fails.

## 2026-07-15 — RELEASE PREP (lane `claude/release-prep-d04205`): qa:ready burn-down

`qa:ready` said NOT READY (4 reasons). This lane's disposition of each:
1. **Ledger P0/P1 → 0 P0 · 1 P1**: F1/F2/F3 flipped `fixed` (all trunk-verified: 6923ed05/73f376fa/
   f488ed11 via eaf36032). **F4 FIXED in this lane** — `/model` now warns against the warmed catalog
   on unknown ids (warn-not-block, empty catalog never warns; test/model-ack-honesty.test.js, 15
   assertions; live-proven: garbage id → warning naming the id + 342-catalog, real id → clean ack;
   receipt `.bugloops/release-prep-2026-07-15/f4-model-warn-live-proof.txt`). Flip F4 `fixed` at merge.
   **F5 REFUTED as a product bug** — in REAL headless Chrome, stage / refit-canvas / #ag-portrait all
   track css across 1280x720→375x812→1280x800→900x1000 (aspectDelta ≤ 0.009). The sweep's distortion
   was the rAF-frozen CDP preview pane, where resize events AND ResizeObserver deliveries never fire
   (proven: freshly-armed RO logged zero on a real viewport change there). Finding dismissed with
   receipts `.bugloops/release-prep-2026-07-15/f5-*.json`.
2. **Guardian RED root cause fixed**: shell-machine-state's Start-Process probe asserted the CHILD's
   exit code, which reads unreliably under the Task-Scheduler batch-logon token — the probe now
   asserts the actual claim (colon form binds FilePath + launches). Next hourly cycle should be green.
3. **Beginner Run stale** — re-run on post-merge trunk (below).
4. **Installed-exe v3 proof** — requires a desktop build whose buildCommit/sourceTree pin the exact
   final trunk head: build + install + `qa:smoke:installed` AFTER this lane merges.


## MERGED 2026-07-15 — SCHEDULER RELIABILITY (lane `claude/starnet-scheduler-audit-1b33c2`, trunk `5dcd3868`)

Four of the six 2026-07-15 scheduler-audit gaps closed in sidecar cron (digest in qa/STATUS.md):
misfire policy (missed daily/cron work fires ONCE by default instead of being discarded —
job.misfire additive/editable), transactional dispatch (launch conditional on a verified durable
advance/claim; failed persist ⇒ defer + retry, never fire-over-unpersisted), generation-fenced
settlement (a zombie-swept run can no longer overwrite its replacement's record), ticker health on
GET /api/cron (lastTickAt/lastSuccessAt/lastTickError/healthy) + durable notification delivery
outcomes (markDelivery; {ok:false} SendResults are real failures). test/cron.dispatch.test.js locks
the launch-integrity guarantees. Live-proven on a real booted sidecar, zero spend.

- [ ] OPEN (audit gap 1, CRITICAL, product-level): routines are not 24/7 — the sidecar dies with
      the desktop process. Needs a supervised background lifecycle (launch-at-login / detached
      sidecar / tray supervisor — Tauri + product decision, Andrew's call on UX).
- [x] CLOSED 2026-07-18 (audit gap 6b): transient delivery-failure RETRY was already implemented in
      the shared channel adapter (exactly one resend for `retryable:true`, honoring `retry_after` up
      to 30s). `autonotify.test.js` now composes the real adapter -> cron notifier -> `markDelivery`
      seam and proves the final success is recorded once without rerunning the routine.
- [ ] OPEN: ROUTINES panel could surface the new health + lastDelivery fields (GA-9 adjacent).


## MERGED 2026-07-15 — VOICE DECOUPLED FROM THE LLM (lane `claude/hermes-voice-system-analysis-910f29`, trunk `dc2c8809` + W0 `e5e60914`)

Voice is now a STATION subsystem (analysis + acceptance bar: docs/REF_HARNESS_VOICE_ANALYSIS_2026-07-14.md).
Shipped: sidecar/edgetts.js zero-dep FREE KEYLESS Edge neural floor in /api/tts (keyed chain →
edge → 200 {fallback}); /api/stt dedicated ASR (Groq whisper-large-v3-turbo → whisper-1 →
chat-model); frontend neural-only (robotic speechSynthesis path DELETED — degrade = silence +
speaker tooltip; 'no key' latch → 60s cold-off). Live-proven keyless end-to-end (real Edge MP3
through the real page, play() resolved). Installed exe picks this up at the next build cut.

- [ ] OPEN: local-ASR floor for desktop Anthropic-only stations (sherpa-onnx-node / whisper.cpp
      spike; the last acceptance-bar gap — browser stations have webSpeech, desktop keyless STT doesn't).
- [ ] OPEN: Edge-voice audition vs Algenib (en-US-ChristopherNeural chosen as nearest bass;
      Andrew's ear decides; swap via SKYNET_EDGE_TTS_VOICE).
- [ ] OPEN: V-ACK (spoken ack on first tool call from the prewarmed cache + ducking), V-HYGIENE
      (VAD confirm stage, quiet-take discard, hallucination filter, single chunker), V-PROSODY
      (taste-gated) — ranked in the analysis doc.

## 2026-07-15 — PROVIDER COMPATIBILITY (lane `claude/starnet-provider-compatibility-24131e`, MERGED `29fa54e2`)

The "all providers properly compatible?" audit's four concrete wire risks are FIXED on the shared
openai-compatible seam (digest in qa/STATUS.md): reasoning_effort reaches the wire (was silently
dropped); unsupported-param self-heal (400/422 naming an optional param → strip + retry, per-model
memo; `tools` NEVER silently dropped); Perplexity `supportsTools:false` from the profile → task runs
refuse up front; xAI `usage.cost_in_usd_ticks` normalized in cost.js (REAL field, 1 USD = 1e10 ticks).
Capability facts sourced from official provider docs 2026-07 (registry.js wire hints carry citations).
- [x] **Certification HARNESS shipped + first real-key PASS** (2026-07-15, same lane):
      `npm run certify:providers` (scripts/provider-certify.mjs) proves the wire seam live per
      provider — models → streamed chat → tool round-trip → mid-stream cancel → cost reconcile.
      Keys ONLY from the registry-documented env names; no credential = honest SKIP env-blocked;
      receipts land in gitignored `.dogfood/provider-certify/`. **OpenRouter: PASS all five steps
      against the live endpoint** (343 models, streamed "OK" w/ usage, starnet_ping tool call
      finish=tool_calls, clean abort, provider-reported cost reconciled).
- [ ] **REAL-KEY runs for the other 12 keyed providers** — needs Andrew to export the documented
      env keys (or drop them where the app stores creds) and run `npm run certify:providers`;
      the harness does the rest. Codex certifies via the live app (OAuth), Ollama when a local
      daemon is up. Restart/auth persistence + one autonomous cycle remain APP-level proofs
      (live app + real save), not wire-script scope.
- [x] Perplexity static Sonar roster shipped (same lane): 4 docs-sourced models (2026-07;
      sonar-reasoning removed 2025-12-15) fill the empty-catalog seam — context limits flow to
      compaction, connect screen not empty; deliberately UNPRICED (per-request search fees make
      token-only pricing dishonest).

## 2026-07-14 — COMPREHENSIVE AUDIT ATTACK-ORDER (lane `claude/starnet-audit-80a98c`, Andrew-approved sequence)

Five-agent audit + the approved fix sequence, all lane-committed (digest lands in qa/STATUS.md at merge):
- **QA watch RE-ARMED on the new PC**: `schtasks` had ZERO StarNet tasks (the EL-0 registrations died with
  the old machine). Re-registered via `scripts/qa/register-watch.ps1 -Apply` against the integration tree
  (Guardian-Hourly / Beginner-Daily / Janitor-Weekly, verified in the scheduler) + a fresh manual cycle:
  **GREEN all 6 gates** @ trunk `38818fbc` (guardian-20260715-023723) — replaces the unreproducible
  21-commit-stale RED snapshot whose evidence was gitignored and absent.
- **Stranded-work rescue commits**: meeseeks sprite layer (`7091cabd` on agent/meeseeks-subagents) and
  growth-t4 anti-nag iteration (`d4a75a6f` on agent/growth-t4) — both existed ONLY as uncommitted diffs;
  `archive/*-rescue-2026-07-14` tags pinned. Their PORT queue items below remain open.
- **Channel-secrets verified persist** (the audit's P1): saveChannelSecrets rides saveJsonVerified
  (read-back proof); connect/sync routes surface `persisted`; disconnect never claims `purged` unproven;
  notify's 500 guard now reachable. EL-3 failing scenario locked in channels.secrets.test.
- **Last-hop surfaces**: BUDGET pool-cap RESUME (/api/budget/resume) · NIGHT SHIFT FOCUS + STEER
  (live-DOM round-trips proven: steer set/clear, marker rides the LIVE steered bit) · AUTONOMY LIVE
  HELPERS + STOP (/api/subagents/interrupt) · world.js pollFeedState reads bulk /api/channels/status
  (slack/matrix/signal-only floors no longer falsely nagged NO FEED).
- **team.dispatch/team.spawn now consent-gated** (closes the parked P1 prompt-injection fork; Andrew
  approved via the audit attack-order): APPROVAL beat in 'ask' mode, Full Access bypasses — summon parity;
  registry + tool defs flipped together, test-locked (orchestration 116).
- **W0/pp branch-mass verdict (NON-destructive)**: the ~65-branch W0/pp complex is a LIVE lane, not
  abandonware (`agent/w0-*`/`w1-*` all sit in checked-out worktrees; `agent/pp-*` W2 work = preserved refs
  per the W0 checkpoint below) — left to the w0-claims-verdict lane owner. The 11 self-labeled
  `codex/snapshot-w0-*` / `codex/rejected-w0-*` insurance branches ARE inert: tips pinned under
  `archive/codex/...` tags — safe to delete those branches whenever Andrew signs off (tags keep the SHAs).

STILL OPEN from the audit (unclaimed): codex OAuth refresh token keychain home (the one plaintext-only
credential) · index.js channel-route dedup (~9× repeated persist shape) · Cartographer re-sweep +
re-bless (187 perfected all stale; props/events/routes areas never mapped) · fresh installed-exe smoke
stamp for qa:ready · remaining orphaned routes (workshop/shift, nightshift/beat force-fire, config/reset,
execution view, threads-ledger browse).

RE-ARMED-WATCH FALLOUT (found by the watch itself, 2026-07-15 — both are INSTRUMENT-environment, not
product; the same commit passes all suites in interactive shells):
- [x] **Hourly Guardian RED — RESOLVED** (verified 2026-07-17): the probe now asserts launch not
      child-exit hygiene (shell-machine-state.test.js ~:189 comment documents the batch-logon
      $p.ExitCode unreliability) and guardian cycles are GREEN all 6 gates under the real scheduler
      (guardian-20260717-230002 / -220002 / -210002 all verdict green).
- [ ] **Integration-tree test:fast stalls at the 600s wrapper** right after lint-evidence-secrets
      (reproduced 2× at 70cdc178; the known `.dogfood` bloat). Gate trunk commits in a clean worktree
      FF'd to the same SHA (receipt pattern used for this merge). Real fix = product-perfect lane makes
      the claims step skip-honestly when `.dogfood` is absent + the scanner step bounded.

## 2026-07-14 — ADVERSARIAL SWEEP: interrupt/disconnect seams (branch `agent/adversarial-sweep`)

Fresh-eyes skeptical sweep of the seams happy-path QA is blind to (full ledger with repro steps:
`.bugloops/adversarial-sweep-2026-07-14/LEDGER.md` in the lane worktree; digest in qa/STATUS.md;
P0/P1s in the qa findings ledger, crew `Adversarial`). FIXED in-lane with EL-3 escape tests:
- F1 P0 client disconnect never detected on /api/run (dead `req.on('close')` after readBody —
  Node ≥15 emits it at message completion): ghost runs spent unwatched, mutex held, reloaded UI
  contradicted the harness. All three run routes now use `res.on('close')` (`6923ed05`).
- F2 P0 COMMS `online` asserted forever over a dead sidecar — now folds `World.linkState` →
  `station unreachable` (`73f376fa`).
- F3 P1 idle `/steer` minted a paid run from a steering note — now refuses honestly (`f488ed11`).
OPEN (routed, repros in the ledger):
- F4 P1 `/model` accepts garbage ids with a confident ack — warn-not-block against the warmed
  catalog at the ack seam (slash lane).
- F5 P1 canvas buffers never re-derive on viewport resize; `object-fit:fill` distorts the pixel
  world; `#ag-portrait` renders 88×1 (canvas lane; cheap DOM oracle: css aspect ≈ buffer aspect).
- F6 P2 hero body stays `idle` + stale say while its run streams (crew latch rides run phase,
  hero latch is desk-trip-only — world.js:5060/5077 vs :3027); F7 P2 first summon spawns ON the
  hero tile (3/3); F8 P2 cancelled runs persist `content:""` assistant turns (partial streamed
  text lost from the durable transcript); F9 P2-suspect NIGHT SHIFT trophy minted with zero
  night-shift activity (trophy condition needs reading).
- KNOWN pre-existing — SINCE RESOLVED (re-proven 2026-07-17): `test/qa-product-perfect-claims.test.js`
  now passes in a FRESH clean worktree at trunk head (64 assertions OK; the candidate-git-blob
  authority landed since this note). A red here in a lane now means the real thing — a shipped-surface
  change without its in-branch W0 re-stamp — not environment.

## 2026-07-13 — FLAGSHIP WAVE: last-hop surfaces + cross-wiring (branch `claude/flagship-features-audit-d0e1a1`)

Three-agent code audit of the flagship trio (autonomy / quests / recommendations) found the engines
solid and test-locked but the value trapped server-side (the recurring last-hop pattern). Five lanes
shipped and merged to the audit branch (trunk-synced, gates green, in-lane live-DOM proofs; digest in
qa/STATUS.md):
- QUEST V3 surface: DIRECTION card (north star + provenance + confirm/correct), REFRESH QUESTS button,
  visible refresh-outcome ledger. CLOSES the V3 OPEN items "frontend surface" + "north-star CONFIRM
  beat". Slate-full fast path: at OPEN_GENERATED_CAP the cycle skips the model call with an honest note.
- NIGHT SHIFT visibility: dial-raise now speaks an honest outlook (mode + readiness from status);
  unseen-drafts COMMS nudge during live sessions (closes the "drafts pile up unseen" follow-up);
  LAST REPORT re-open. The onboarding-readiness follow-up is addressed at the dial, not the ceremony.
- SCOUT LOG: the attempt ledger finally renders in the recruitment bay (closes "scout-ledger UI" OPEN).
- AUX GOVERNOR: joint budget over the 6 post-run extraction passes (SKYNET_AUX_BUDGET, default 2,
  priority reflection>study>threadmine>scout>skill-review>curator; deferrals visible, cooldowns unarmed).
  Closes the unbudgeted run-end cost risk; the NS-8 full composer remains open (this is the cost half).
- CROSS-WIRE: nightfocus ranks open WORK quests + confirmed north star as focus evidence (consent law:
  unconfirmed proposals never steer autonomy); scout directives cite the quest slate + star (grounded);
  shared declined index (read-side NS-8 lite) — explicit declines suppress re-proposals across ALL
  engines; expiries never suppress.
STILL OPEN after this wave: first real-provider quest-refresh + scout cycles on Andrew's save (runtime
proof, not code); NS-8 full unified composer (extraction consolidation — the declined/cost halves are
done); cold-state → targeted awakening question; thread/trust beat starvation fallback; reflection
auto-save consent posture (deliberate design, revisit on user feedback).

## 2026-07-13 — NIGHT-SHIFT "never does anything" fix (dial-is-the-consent + honesty)

Root cause of "idle for hours, zero autonomous work": at dial free/sandbox every beat silently
degraded to a reason-only draft because the SEPARATE per-agent away-workshop grant was never
recorded (`workshopOf()` false ⇒ `runNightshiftActShift` unreachable), and the cold-start
readiness gate declined every beat for hours with nothing in the UI saying why. Shipped:
- POST /api/autonomy/posture with `buildsUnattended` now records the night-shift agent's grant
  through `workshopStore.grantIfUndecided` (same authority as /api/workshop/grant; an EXPLICIT
  per-agent decision is never overridden; the standalone workshop-shift cron stays opt-in).
- GET /api/nightshift/status adds `workshopGranted` / `buildMode` / `draftReason` / `readiness`
  (dims + recent-run bars); the NIGHT SHIFT panel renders MODE + a "still learning you" line;
  a dial-says-build-but-no-grant degrade is a visible warning AND an autonomy-ledger note.
- Proof: test/nightshift-grant.e2e.test.js (auto-grant, restart round-trip, revoke-wins,
  status honesty) + nightreport/workshop-store unit coverage; live-verified on the dev seed.
OPEN follow-ups: consider surfacing the readiness bars during onboarding (the first idle hours
are still gated cold by design), and a COMMS nudge when drafts pile up unseen.

## BUILT 2026-07-13 — QUEST V3 STANDING REFRESH (branch `claude/starnet-quest-system-25fae6`, `fd8823d8`)

Andrew's report: a live save sat 3 days with an unchanged quest slate and a NEVER-created
`_station.quests.json` — V2 made completion honest but generation passive (agents mint only mid-run,
doctrine bar rarely met). The fix is a standing harness refresh (the scout mint-cycle mold):
- `sidecar/questrefresh.js` (pure) + index.js ambient half: 24h cadence + caught-up fast path (zero
  open ledger quests → refresh after 1h cooldown), 5-min tick + boot catch-up look (desktop sessions
  are short — the 24h mark usually passes while the app is closed).
- Each cycle names the NORTH STAR (Commander's active goal ALWAYS outranks the model's inference),
  then ONE aux model call proposes ≤3 step-quests toward it; parse enforces the contract rule at the
  seam (no `run`, prop keys clamp to placeables, fact keys sweepable, WHY must cite shown evidence,
  dedup vs open slate + denylist); mints ride `questStore.mint` (station-wide `kind:generated`).
- Every outcome in a visible ledger; `GET /api/quests/refresh` = north star + due state + ledger.
  Opt-out `SKYNET_QUEST_REFRESH=0`. Gates green: test:fast, test:http full, new pure suite (45
  assertions) + true e2e (boot→due→mock model→real mints on disk; ungrounded reply rejected, 0 mints).
- W0 claims surface checked: byte-identical (surface locks frontend/docs only; no sidecar paths).
- POLISH PASS (`71d08515`, same branch): progression anchor (directive shows recently COMPLETED
  quests + "propose the natural NEXT step"; done titles join dedup), interests-histogram grounding,
  `POST /api/quests/refresh/run` manual force-fire, cold-save guard (no evidence → skip the model
  call with an honest ledger note; provider/codex-token construction moved after the evidence gate).
  Suites now 55 pure + 22 e2e (3 boots); both gates re-run green.
- OPEN: merge to trunk (merge ritual), first real-provider cycle on Andrew's save, frontend surface
  for the north star + a "refresh quests" button (both APIs already serve them), north-star
  CONFIRM beat (propose-and-confirm instead of silent adoption — flagged as the right next polish),
  cold-state → targeted awakening question instead of inference.

## MERGED 2026-07-12 — PER-RUN PHYSICAL-INPUT ISOLATION (`cf7984ba`)

Transcript-first forensics changed the diagnosis. FPS stream `ws_mrhb6bm3cpz4` made zero
`computer.use` calls and launched no headed test browser. Shell-authored Puppeteer/CDP clicked
Deploy in headless Chromium; the game then called the real DOM `requestPointerLock()`, which entered
Chromium's Win32 `ClipCursor` path. CDP clicks were synthetic; native pointer lock was not. The
boot/shutdown/E-STOP guardrails below are recovery layers and cannot prevent confinement mid-run.

This lane closes both reproduced routes:
- Ordinary runs expose neither `computer.use` nor `desktop.open`; both are removed from capability
  telemetry/provider wire/dispatch, the computer driver is inert, physical input has a separate
  danger class, and the packaged sidecar forces `STARNET_COMPUTER_DRIVER=0` + headless browsing.
- Local UI/game tests use owned `browser.test_*` only: the agent's running background-server handle
  and advertised origin are required; each run gets a private profile + ephemeral CDP port; pointer
  and keyboard locks are emulated before navigation; popups are paused/closed; arbitrary eval is not
  exposed; CDP/page input is synthetic; and Chromium exit is awaited in the outer `finally`.
- `shell.exec` and `verify.run` categorically refuse direct browsers/browser automation, native input
  APIs, GUI/native runtimes, local executables, `--open`, and normal npm/node/Python/PowerShell/cmd/
  Bun/Deno indirection. Build/unit/HTTP work remains available.

The follow-up audit extends this from the FPS route to a harness-wide user-control policy:
- A central impact authority runs before capability grants, Full Access, and cached consent. Missing
  run surfaces are autonomous; autonomous runs cannot start workspace processes, control media, use
  unknown connectors, launch a desktop app, or access physical input. Physical-input and visible-
  desktop impacts are unconditionally unavailable until a future native one-shot gesture lease exists.
- Every custom MCP tool is `external-unknown` regardless of transport or server-supplied `readOnlyHint`.
  It is absent from autonomous runs and requires an exact live, non-cacheable confirmation per call in
  a watched run. MCP stdio defaults off and only a broker-proven isolated worker can enable it.
- Child processes receive a minimal environment with StarNet/API/provider/channel credentials and
  execution hooks stripped. Host safety pins force headless browsing, disable the computer driver and
  local MCP stdio, and preserve user control.
- `verify.run` uses the same command decision seam as `shell.exec` and scans the exact nearest nested
  project it executes. Fullscreen, pointer/keyboard lock, wake lock, orientation lock, and popup APIs
  are neutralized inside the owned CDP test browser. Inputguard is observation-only: cleanup never calls
  global `ClipCursor(NULL)` and therefore cannot disturb a game or app the user owns.
- Workshop HTTP routes, decision payloads, frontend code, and Tauri IPC contain no file/folder launcher.
  A token or renderer message is not accepted as proof of a human gesture; the user opens kept paths
  manually. The task sidecar contains no Win32 input/capture implementation; its computer factory and
  legacy `desktop.open` tool are inert and never projected.

Focused gates are green (browser 79, computer 58, desktop 34, shell isolation 29, input policy 31,
shell-bg 31, shell machine-state 74, harness integration 90). A hands-off FPS substrate run used an
owned ephemeral CDP port (`51772`) and completed deploy, movement, relative aim, ADS, fire, reload,
pause, resume, tamper-resistance checks, and confirmed browser exit; 255 continuous Win32 samples
showed zero confinement, unchanged cursor position, and unchanged `GetLastInputInfo`.
The stricter QA now refuses a pre-confined baseline. That refusal caught a pre-existing real-window
lock live: foreground user Chrome titled `IRON & ASH — Free For All` owned clip rectangle
`[5,92,1915,1027]` before the proof began and retained it afterward — the proof browser was never
started. The observer cannot attribute who opened that Chrome window, but it independently confirms
why real-window routes cannot remain ordinary agent tools.

Residual release blocker: supported/modelled StarNet paths are closed, but a hostile or obfuscated
arbitrary binary in the same interactive Windows session cannot be made absolutely input-safe by regex,
environment variables, or a Job Object. A literal unknown-code guarantee requires a restricted process
token plus private non-input desktop/session, or a container/VM such as Windows Sandbox/Hyper-V. The
current machine has no available container/sandbox worker. Do not advertise the stronger OS boundary as
shipped; do not enable unattended local execution while that boundary is absent.

Ship blockers:
- [x] Merged through the controller at `cf7984ba`; the merged tree is byte-identical to the reviewed
      feature head. `test:fast` 315/315, full `test:http`, and
      `cargo check --locked --all-targets` are green on trunk.
- [x] Rebuilt the trunk 0.4.2 desktop executable and NSIS bundle. The source, release, and debug
      sidecars match and contain no Win32 physical-input driver symbols. Artifact signing stopped
      because `TAURI_SIGNING_PRIVATE_KEY` is unavailable; the already-created local bundle is unsigned.
- [ ] Sign/reinstall the desktop app, then run a real installed FPS agent task while the Win32 observer
      spans the entire run and browser teardown; grep its new transcript for `browser.test_*` and
      absence of shell browser / `computer.use` / `desktop.open`.
- [ ] Phase-5 computer evidence deliberately remains `blocked` until that installed receipt exists.

## LANDED 2026-07-14 — RECRUIT RECURATION: 12 majority-use classes + archetype-seeded minting

Andrew's read: most of the 18 preconfigured recruit listings were redundant — beginners picked none.
The catalog now has TWO shelves (`shared/specialties.js`):
- **BUILTINS (12)** — one class per distinct majority-use job: chief / researcher / engineer / scribe /
  analyst / operator / scout / designer / tutor + 3 NEW practical classes: **navigator** (trips &
  logistics; verifies every price/hour live, never claims a booking), **curator** (local file tidying;
  move-never-delete + quarantine — the local-first differentiator), **muse** (diverge-then-converge
  ideation). 2 new kit-grounded skill recipes: `itinerary-planning`, `file-curation`.
- **ARCHETYPES (9)** — the demoted deep cuts (reviewer/auditor/liaison/publicist/herald/broker/
  bookkeeper/translator/archivist), full specs, NEVER gated: `Specialties.get()` resolves them (old
  saves + summon-by-id still work), and the bay lists them in a collapsible **SPECIALIST ARCHIVE**
  that search/lane filters auto-expand.
- **Archetype-seeded minting** (`Scout.matchArchetype`, wired in `runScoutCycle`): on a prospect turn
  the cycle first checks — deterministically, ZERO model spend — whether a dormant archetype covers a
  WARM learned interest; a match stages its FULL spec on the DRAFTED-FOR-YOU shelf with a WHY from the
  real topic counters. Dedup: held names never re-pitch, dismissed shapes stay denylisted, LLM near-dup
  guard now counts archetypes (the model never re-authors one). No match → LLM authorship unchanged.
- Proof: class-loadouts re-pinned (all laws over BOTH shelves), scout.test matcher coverage,
  scout.e2e BOOT 3 (real sidecar stages the Broker archetype off a warm interest, zero model calls,
  persisted), live bay round-trips (12-card roster, archive expand/search, builder prefill with full
  loadout). Gate 318 green; W0 release surface re-stamped in-branch.

## LANDED 2026-07-12 — BOOT/SHUTDOWN MOUSE-CONFINEMENT GUARDRAILS (merged as `c069cba3`)

Incident: an agent-built pointer-lock FPS left a smoke browser + dev server alive after StarNet
was force-closed, and a stuck win32 ClipCursor walled the user's REAL mouse until cleared by hand
(desktop-shell stop = TerminateProcess, so gracefulShutdown never ran). Four guardrails, gate 306
green, boot-sweep + clip-release live-proven on an isolated sidecar (planted orphan reaped, decoy
chrome untouched, planted clip released):
- sidecar/procledger.js — persistent child-PID ledger; NEXT boot sweeps force-kill orphans
  (token-wise cmdline match = PID-reuse guard). Wired: shell.bg + agent browser + boot.
- sidecar/inputguard.js originally released global ClipCursor state at boot / shutdown / E-STOP. The
  per-run lane supersedes that behavior with observation-only telemetry: StarNet must not mutate clip
  state it cannot prove it owns, including clip state belonging to the user's own game.
- `shell.exec` originally blocked visible launches while allowing `--headless`; the per-run isolation
  lane above supersedes that exception because headless Chromium can still reach native pointer lock.
- Open-it card warns "captures your mouse (pointer lock) — Esc releases" via disk-proven
  manifest.capturesInput scan in validateWorkshopManifest.
- [ ] OPEN: walk the capture-warning card live in a full workshop round-trip (code+gate only so far).

## IN PROGRESS — Codex W0 claims/provenance verdict (`agent/w0-claims-verdict`)

Scope is the amended W0 only: code-verified SHIPPED/PARTIAL/MISSING/REFUTED verdicts before
W2–W6 tasks, the open-source build-provenance taxonomy (official / reproducible-source /
custom / dirty-dev), a finite advertised-claims ledger with experimental labeling, and the
explicit retirement of TPM/VHDX/anti-admin work if grep confirms it was never a product
requirement. No W1 implementation or W2+ fix lane starts until this bounded W0 audit commits.
Controller owns `docs/NEXT.md`, the W0 ledger/provenance planning surfaces, and any narrowly
required tests; it does not own `shared/events.js` or `shared/schema.js`.

W0 grep-verdict checkpoint (`ef16fa08`, 2026-07-12):
- **SHIPPED â€” do not rebuild:** durable E-STOP, background consent visibility, Night Shift
  pre-spend/leash refusal, truthful `/api/version`, MCP mutation consent, cold-boot recap,
  durable rejected-idea suppression, and the locked HTTP `200 {ok:false,degraded:true}`
  workspace refusal.
- **PARTIAL:** child-environment isolation, DNS-safe controlled-browser navigation, recursive
  link/junction containment, Slack/Matrix keychain custody, channel pairing, the unified work
  ledger, Settings full export, post-onboarding base URL, capability enforcement across run
  modes, Commander-context composition, and reason-aware learning.
- **MISSING:** scoped Workshop/file URL capabilities, zero-unconsented boot egress, attended
  real integration lifecycle receipts, and complete point-of-use experimental labels.
- **REFUTED:** work continuing after the desktop app closes, hallway-as-authorized-handoff,
  blanket no-phone-home copy, and a Signal token-keychain requirement (Signal has no token in
  the current adapter contract).
- **Preserved refs checked:** completed-looking W2 security work remains held on the existing
  `agent/pp-*` branches and will be re-audited only when W2 is active. The released dirty
  `pp-w0-open-source-reset` and `pp-w0-open-source-promises` worktrees remain untouched and are
  salvage-only, not merge authority.

W1 read-only preflight (do not implement until W0 passes):
- Beginner `STUCK@title` is a driver race, not a product splash bug. `beginner-run.mjs` waits for
  the static connect element, samples the active screen once while it is still `screen-loader`,
  and never retries Enter when `screen-splash` appears. Add a loader-to-splash fail-first test and
  retry the advance against observed screen state.
- Healthy-idle `LINK DOWN` is false because `world.js` ages only `onopen/onmessage`, while the
  server's 25-second SSE keepalive is a comment that `EventSource` never exposes. Held commit
  `9298c52f` already replaces this with header-auth fetch streaming and timestamps keepalive bytes;
  audit and merge-forward it in W1 rather than rebuilding it.
- `world.js` ownership must first be serialized with the stale
  `link-down-starnet-b85d52`, chat-bubble, and conveyor worktrees; no lane may overlap them.

## LANDED 2026-07-09 — LOST-WORK RESTORE: 7 built-but-unmerged features recovered to trunk (5b9cde3f) ✅

Andrew noticed the new start menu + upgraded CREATE YOUR OVERSEER were missing from his build —
root cause: the branch (claude/starnet-launch-overseer-ux-28d3f2) was **never merged**. A 6-agent
audit of EVERY unmerged branch + stale worktree then found six more finished features in the same
state. All 7 restored, gates green on trunk, live-proven (see qa/STATUS.md 2026-07-09 digest):
splash+overseer menus · CRT speech bubbles · scanlines toggle removed (Andrew: always-on) ·
selectable transcript+input history+Open-it fix · PROJECTS-tab fix+beat flatten ·
Slack/Matrix/Signal + CHANNELS panel · photo/file attachments.

**LANDED 2026-07-09 (late eve) — LAUNCH-POLISH SESSION ✅ (all gates green on trunk e96079d7; digest in qa/STATUS.md):**
rescue-merged BOTH stranded EL-11 fix branches (187724e3 hung-stream+wedged-beat-halt, 8b5aae04
consent-visibility+visible-E-STOP — live DOM round-trips done) · connector-spine COMMIT-rescued
(9d2e2d93 + archive tag; port = separate lane, 3 known conflicts incl. slack add/add vs trunk) ·
backend polish batch merged (64b20752..9a4f0e6c): /api/version harness truth (live-proven) ·
night-beat leash burn fixed (budget + no-provider pre-spend gates) · scout draft 14d TTL sweep
(live-proven un-wedge) · .bugloops evidence sweep + guardian hook (real sweep fires next guardian
cycle; manual run needs Andrew: `npm run qa:sweep`, dry first) · shipped-docs truth (PRIVACY
channels, RC-soak doc-fiction, runbook staleness) · release-train provenance UNBLOCKED (real cause
= CI shallow-checkout describe≠tag, NOT the binary stamp; fetch-depth:0 + parity test) · Quest V2
celebration round-trip PROVEN live (21/21, item closed below). GB-9 was REFUTED — already shipped
as EL-11 FIX 1; 200 {ok:false,degraded:true} is a LOCKED test-asserted design, do not "fix" to 5xx.

**Task Brief v2 (2026-07-16, branch `claude/starnet-context-extraction-a06d70`, docs/TASKBRIEF_V2_PLAN.md):**
- [x] Lanes A/B/C built + live-verified in-branch: marker-path questions persist honestly
      (no fabricated dimension/recommended), the host-validated recommendation renders on
      every question surface (COMMS gold ★ chip + why, restore, channel fallback), and six
      flagship recipes declare launch-time intake (one-tap material decisions ride the
      directive; `<recipe_intake>` aims mid-run questions). W0 surface re-stamped in-branch;
      receipt mint at merge. Catalog intake completed in round 2 (see Lane D entry).
- [x] Lane D DONE (Andrew-approved additive change, merged 11435856): 'clarifying' joined the
      agent.run.end reason enum; the buffered task-end emits it, hub endNote and COMMS treat it
      as the clean decision turn it is; additivity pinned by test (all prior reasons asserted).
      Catalog intake also DONE same merge: 29/50 recipes declare their material decision.

**NEW QUEUE from the launch-polish session (claim before building):**
- [ ] EL-11 leftovers 8-13, all frontend-owned (stationui.js/chat.js — was blocked on the 7/09 UI
      session; fix shapes with file:line evidence in the 2026-07-09 launch-polish triage, session
      transcript): 8 undo for out-of-jail artifacts (backend route + card affordance) · 9 EXPORT
      AGENT full backup button in SETTINGS (Backup.exportAll exists, connect-screen-only) · 10
      connector.state SSE bridge (needs ADDITIVE shared/events.js entry via owner) + global error
      notify · 11 global channel.connect error notify (listener is panel-scoped today) · 12
      base-URL edit post-onboarding (Harness.setBaseUrl exists, settings never calls it) · 13
      connector OAuth cancel affordance + poller cleanup on panel close.
- [ ] PRIVACY.md storage-table rows (channel tokens + message history) still enumerate only
      Discord/Telegram — extend for slack/matrix/signal once each one's exact persistence
      (keychain vs plaintext fallback) is verified (lane-D flag).
- [ ] Provenance CI proof: after next trunk push, throwaway tag `v0.0.0-provtest` → watch the
      train's provenance step go green → delete tag+draft (Andrew or any session with push).
- [ ] Janitor teardown (classifier-blocked in-session, needs human-approved pass): worktree
      .claude/worktrees/chat-bubbles-styling-c17d0f + branch claude/chat-bubbles-styling-c17d0f
      (SUPERSEDED — patch-id-identical to trunk 970260e8; archive/chat-bubbles-styling tag pinned);
      dead subagent worktrees agent-a2609846513e19866 + agent-afaa4833c73b46244 (both branches now
      MERGED to trunk, trees clean).

**QUEUE — audited unmerged gems, NOT yet restored (claim here before building):**
- [ ] **connector-spine PORT** — rescue ✅ DONE (committed `9d2e2d93` on `agent/connector-spine`
      + tag `archive/connector-spine-rescue-2026-07-09`; tree verified CLEAN 2026-07-14): email/
      sms/webhook/whatsapp adapters + tests (new-file clean) + managed-credits billing seam. Its
      slack = superseded by trunk's; its org/derive = orphaned (orgvalidator.js deleted).
      Remaining = the port: manual re-wire of index.js/stationui.js in a fresh lane.
- [ ] **Settings V2 control-plane PORT** — rescue ✅ DONE 2026-07-14 (committed verbatim as
      `02d872f9` on `agent/hermes-settings-audit` + tag `archive/hermes-settings-audit-rescue-2026-07-14`;
      tree CLEAN; its own settings-store test 21/21 green at its base). Contents: schema-driven
      settings-store.js (schema/defaults/current triple, ~50 fields) + GET/POST `/api/settings`
      + `/defaults` + `/schema` + schema-rendered panel (stationui.js +378). Port assessment
      (2026-07-14, base 1867 behind): trunk STILL has no `/api/settings` — backend half genuinely
      missing. But port must be SELECTIVE, not a merge: (a) reconcile with trunk's newer
      `/api/runtime/knobs` (P1-9 — same protected-sibling persistence; don't ship two knob
      stores); (b) drop fields refuted by locked decisions (appearance.music — music DELETED;
      appearance.scanlines — toggle removed, always-on) and every `status:'planned'` no-op field
      (tool surface must never exceed wired reality); (c) render new sections INTO the existing
      premium SETTINGS window, don't replace it; (d) index.js/stationui.js hunks won't merge at
      1867-commit drift — hand re-port using the rescue as reference; settings-store.js + test
      port nearly clean after field re-curation.
- [ ] **growth-t4 anti-nag budget** — global one-interactive-ask-per-task-end + starvation
      fairness. Do NOT merge the branch (chat.js +1386 drift, new thread/autopilot lanes it's
      blind to) — fresh re-port of the design.
- [ ] **meeseeks frontend sprites** — 38-line world.js layer completing the merged team.spawn
      backend; VERIFY trunk forwards sub-* agent.run.* events before building, else sprites never light.
- [ ] Restored-feature follow-ups: real-token pass on slack/matrix/signal; live file-upload
      round-trip (e2e-proven only); bubble-restyle visual check at zoom.
      (2026-07-15 messaging-reliability lane, merged acfd82b5: slack reconnect truth, E-STOP/
      snapshot cover all five channels, owner-binding persist warning, durable reply outbox,
      FORGET honesty, DM-only copy honesty — see qa/STATUS.md digest. Still open here: the
      real-token soak + mention-gated group messaging, chip spawned.)

**SUPERSEDED — safe to delete, do not re-audit:** agent/parity-finish (fs.patch/MCP-stdio landed
via bb398960), agent/ui-number-format (trunk U.usd/U.tokens better), spend-model-honesty +
mac-linux-support worktree drafts (trunk superset).

## LANDED 2026-07-08 (evening) — GAP-AUDIT SPRINT: last-hop fixes on everything shipped today (Fable session) ✅

Six-agent code-verified audit of the day's merges found ONE pattern: every flagship shipped its
ENGINE but was missing the last hop that delivers user value — and the standing gates were blind
to all of it (Guardian/qa:ready never ran test:http, where every new system's integration proof
lives; atlas had zero tiles for the new routes). All fixes MERGED to trunk same evening, full
ritual per merge (fast + http gates green on trunk after each):

1. **E-STOP durable night-shift halt** (be03e5d0) — escape: `isHalted: () => false` meant beats
   RESUMED ~45min after E-STOP; now durable `haltedAt` (survives restart), truthful
   `binding:'halt'`, dial re-write lifts. Escape tests: planner + driver + real-sidecar e2e
   (nightshift-halt.e2e, in test:http).
2. **Guardian http-e2e P0 step + atlas sweep** (be03e5d0) — qa:ready now vouches for
   scout/threads/nightshift/pathtrust integration proofs; 23 new atlas tiles (all 18 new-system
   routes). OPEN: one behavioral JOURNEY per new system (queued, not claimed).
3. **Quest V2 completion sweeps** (0b017a70) — audit found only `attest` could ever complete
   (bindRun 0 callers; prop/fact/artifact unhooked; attest unscoped → spoofable). Now all 4
   mechanical types complete at real truth points (sidecar/questsweeps.js) + attest enforces
   openForAgent. ✅ live-DOM celebration round-trip PROVEN 2026-07-09 (launch-polish lane Q:
   8/8 backend + 13/13 frontend CDP asserts — open→done edge, .q-celebrate, gold toast, COMMS
   broadcast, restart-durable; gotcha: mock /models must advertise supported_parameters:['tools']).
4. **NS-6 thread TURN-IN CARD** (5106e671) — the ledger was a GHOST (no frontend hit
   /api/threads*; openThreads() forever empty). Now threadstore.js + gold-inset card via the
   beat arbiter (5th participant, memory>study>arc>trust>thread); LIVE DOM round-trip proven
   (mined idea → card → KEEP → open thread server-side). "You mentioned X — here's the thread"
   is now reachable end-to-end.
5. **Scout honest cold state + WHY grounding + true e2e** (d5c8dcfe) — shelf no longer silently
   '' when cold (CALIBRATING/n-of-N states from /api/scout truth, CDP-proven); ungroundable WHY
   rejected; scout.e2e proves the full post-run chain incl. the anti-silent-no-op path. OPEN:
   draft TTL/interest-decay eviction; scout attempt-ledger panel.
6. **computer.use focus-truth guard merged off the vine** (04ae3797) — the Spotify
   screen-puppeteering fix was stranded on a dead branch; landed clean, 100 assertions.

**Audit findings REFUTED (do not re-fix):** morning report IS rendered; autonomous beats can
never bless a root; event contract clean; guardian lock on trunk; Quest V2 was real-provider
proven; night-shift timer cross-process lock is BY-DESIGN absent (one-sidecar invariant).
**NEW QUEUE from the audit (not yet built):** per-new-system journeys (J8+) · NS-9 learning cap
±0.5 < one confidence step = tie-breaks only, no decline REASON captured, no compounding test ·
user-understanding SILOS (6 aux-model passes per run-end re-extract the same signal into 5-6
stores; scout interests duplicated vs browser profile; "declined" in 3 unsynced places — the
NS-8 unified composer is the fix) · messaging-connectors merge (1555 lines, tested, rotting —
70-commit divergence; NOTE 2026-07-09: now COMMITTED as 9d2e2d93 on agent/connector-spine) ·
EL-2 saboteur mutators. (✅ CLOSED 2026-07-09 launch-polish: .bugloops TTL GB-27 · /api/version
harness placeholder · night-beat leash burn. REFUTED: GB-9 workspaceDegraded — already shipped
as EL-11 FIX 1, the 200 {ok:false,degraded:true} shape is LOCKED + test-asserted, don't "fix".)

## LANDED 2026-07-08 — GATE BURN-DOWN: qa:ready code side driven to zero (Fable session) ✅

All 4 qa:ready blockers cleared in one afternoon; every "P0" was the QA apparatus, not the
product (pattern for docs/MISTAKES.md: before fixing "the app", prove the instrument):
1. **Installed-exe smoke FIRST RUN → GREEN 6/6** (app 0.3.1). Initial BLOCKED was the probe
   sending `Authorization: Bearer` — sidecar CORS only allows `X-StarNet-Token`, so the
   packaged cross-origin (tauri.localhost→127.0.0.1) preflight died pre-response. Probe fixed
   + EL-3 guard (Bearer forbidden in SMOKE_PROBE). Version chain PROVEN correct live
   (appSource:env). Merged 648d7212.
2. **Beginner STUCK@first-directive = instrument budget**: awakening is intentionally
   cinematic (~93s measured to first chip under load) vs unmeasured 60s step budget from
   runner birth. 60s→180s + stale `.msg`→`.cmsg` probe + lock (budget ≥120s). Post-merge
   RUN PASS 87.5s/6 steps.
3. **Guardian wedge = NO cross-process lock** (hourly × watch × manual raced the shared pin
   worktree + 8940-43 ports → all 4 BLOCKED P0s, all 3 "visual regressions" (within threshold
   clean — NO re-bless), work-tasks "failure" = overlapping teardown). Fixed: heartbeat
   lockfile (%TEMP%/starnet-qa-guardian.lock, stale reclaim) + review-clean verdict (all-
   dismissed red gate ≠ red; BLOCKED never excused) mirrored into journeys.mjs; QA_STATION §2
   corrected. Guardian findings 10→0.
4. **J7 slash INPUT-path truth journey** (12 assertions, non-vacuous: reintroduced 7/05 bug →
   FAIL exit 3) pays Perfectionist 070e8aca — the last open P1. Atlas coverage refs added.
Ledger: 12 open P0/P1 → **0**. Remaining qa:ready reasons at session end = none code-side
(fresh guardian stamp on final head pending its cycle). OPEN (non-blocking): packaged
/api/version `harness:""` blank; desktop exe orphans sidecar node processes on kill (chipped);
installed exe on 0.3.1 vs v0.3.3 shipped (run the updater = also proves update path).
**Andrew-only P0s unchanged and now THE critical path:** publish starnet-releases repo,
updater-key backup, dev-key rotation, 15-min attended playtest. Then RC freeze + 48h soak.

## LANDED 2026-07-08 — SCOUT: recruitment-bay recommendations actually evolve now
Branch `claude/recruitment-bay-recommendations-52df53` (merge pending): the bay's dynamic
shelves were wired but starved (client-session one-shot mint, silent rejections, hero-only
5-sample warm floor, zero topic signal — presets forever). Now: sidecar-owned **interest
engine** (`sidecar/interests.js` — reason-only topic extraction over real activity, EWMA
histogram + evidence quotes) + **scout cycle** (`sidecar/scout.js` + index.js post-run hook —
persisted cadence, drafts agent prospects AND recipes, every attempt in a visible ledger) +
`/api/scout*` routes + frontend rewire (prospectstore = scout client; SUGGESTED shelf gains
station-drafted recipe cards; launch telemetry feeds FOR-YOU rank). Signal loosened: all-agent
tool counting, CALIBRATING_N 5→3. Live-verified on dev seed (restart hydration, both shelves,
accept/dismiss round-trips, telemetry). OPEN: first real-provider scout cycle unobserved;
optional nightshift catch-up pass; scout-ledger surfacing in a UI panel. (✅ 2026-07-09
launch-polish: staged-draft 14d TTL sweep landed — stale drafts can no longer wedge minting.)

**The one moving file.** Update it when you land or invalidate an item; don't write a new
plan doc. Reconciled against trunk `feat/harness-backend` + git log on **2026-07-06 (late night, trunk 7cb221ed)**.
Verification key: ✅ = grep/log-verified today · ❓ = doc claim, re-verify before building.

## Already DONE — do not rebuild (merged 2026-07-05..06)

Release train v0.2.0→v0.2.2 (4-platform signed draft, runbook, gate-after-bump);
polish-sprint lanes **8/8 MERGED** (lane 8 truth-chrome-instruments landed 8e8e6eef while
this file was being written): ux-topbar-disconnect, ux-popup-escape,
voice-button-reliability, truth-run-lifecycle, truth-channel-tee, truth-props-glow,
dossier-agent-mgmt (DELETE AGENT + CHANGE SKIN); update-safety P0.1 wv-cache-purge,
P0.2 mirror-truth, P1.1+P1.2 roster-honesty; voice-desktop-key; comms-fresh-session;
multiplatform install docs. ✅ (all in git log)

## P0 — Windows update sidecar-lock hang (canary-caught 2026-07-14)

The local update canary (`npm run release:canary`) caught a UNIVERSAL Windows in-app-update
failure the whole test suite could never see: the updater plugin launches the NSIS installer
then hard-exits via `std::process::exit(0)`, which does NOT fire Tauri's `ExitRequested`
handler — so `kill_sidecar()` never runs, the old `node.exe` sidecar stays alive holding a
write lock, and NSIS FREEZES on "error opening file for writing: node.exe" (Retry/Abort/Ignore)
forever. Every Windows user, every in-app update. FIX: wire the plugin's `on_before_exit` hook
in `starnet_update_check` (main.rs) to set `shutting_down` + `kill_sidecar()` before the exit;
the hook rides the pending Update into the install path. Compiles; being re-proven through the
canary (rebuild old-with-fix → reinstall → drive to clean completion). The canary's `drive`
was also hardened — it now requires installer-exited + app-relaunched, not just the version
resource (which flips BEFORE the hang, so version-only was a false green).

## P0 — code: ALL LANDED 2026-07-06 night ✅ (do not rebuild — verify in log/code)

The entire P0-code list from the evening reconcile merged during the update-safety /
audit-fix night wave:

1. Forward-version save guard — LANDED; `save.js` now refuses `doc.version > CURRENT`,
   leaves the doc untouched, reports `{status:'future'}` to boot. (P0.3) ✅ code-verified.
2. Frontend token leak — LANDED a17cb6b3; `X-StarNet-Token` scoped same-origin `/api` only
   (GROUND_UP 0.6) ✅ code-verified.
3. `agent.tool_call` double-emit — LANDED d9a79c6c; chat.js synthetic re-emit dropped
   (GROUND_UP 0.4) ✅.
4. + 5. Sidecar spawn failure + workspace-migration resurrect — LANDED e19aaa21
   "three Tauri-shell data-safety fixes (audit 0.1/0.2/P2)" ✅ log-verified (code ❓ —
   spot-check main.rs if touching that area). Workshop CSP (0.3) also landed efd22244
   (opaque-origin sandbox) ✅.

Also landed the same night from the old P1 list: plaintext BYOK provider key → keychain
(03b07b0d), channel-hub runs in `runsMeta`/snapshot (f9d59968 + e19aaa21 test), approvalMode
persisted (fe3fef98), schema provenance / `git describe` stamp (711f42da, P1.5+P2.1+P2.2),
STT key off the query string (623202af), dirstat fs-jail (f9007c4d), deliverable blob-URL
leak (0cccce2d), VT323 shipped locally (01570f17).

## P0 — Andrew only (nothing above matters to the public until these)

- Publish `starnet-releases` repo (public updater currently 404s) + rescope RELEASES_TOKEN.
  Pipeline hardening landed 2026-07-14 (update-blockers lane): signed `linux-x86_64-deb`
  manifest key (was: every .deb self-update failed on the AppImage fallback), real minisign
  crypto verification of every artifact/.sig in assemble (`npm run release:verify-sig`),
  published releases immutable to train re-runs. Next release train run exercises all three.
  Then run the older-install → publish → restart update canary per platform (Win NSIS, both
  mac arches, AppImage, .deb) — still ZERO public end-to-end update proofs.
- Back up `~/.tauri/starnet-updater.key` to ≥2 offline locations (single point of total loss).
- Rotate the dev OpenRouter key; support email swap.
- **Attended 15-min playtest** (`docs/PLAYTEST_SCRIPT_GATE5.md`) — dodged since 7/02.
- Then per `docs/ROADMAP_2026-07-04_BRUTAL.md`: 10 outside installs; days 8–30 = code-signing
  identity + weekly release cadence; days 31–90 = managed-key starter credits (one SKU).

## P1 — what actually remains open (post-night-wave reconcile)

- **Prompt-injection via auto-granted `team.*` caps** — genuine product fork, needs Andrew
  (see Parked decisions). This is now the ONLY surviving item from the old P1 list — the
  rest landed (see DONE above; P1.3 flush ad8b8b5a, P1.4 parity gate a1a60967 ✅).
- Branch triage below is now the main code queue, plus the P2 hygiene list in
  `docs/GROUND_UP_AUDIT_2026-07-06.md` — do not copy it here.

## Branch triage — EXECUTED 2026-07-06 night ✅ (content-verified per branch, then deleted or parked)

**Deleted (13 unmerged — content proven in trunk or superseded; SHAs recoverable from
reflog ~30 days):** commission-redux 9f8cf7c2 (cherry-equiv in trunk) · cron-staylive
d30dfdd0 (KeepAwake + watchdog in main.rs) · honest-states f1011fe0 (launch.json chore
only) · messaging-platforms 16a0fadd (superseded by MCP connector catalog) ·
starnet-api-gate e4a6fd28 (landed as 9574cb74) · cortex-hermes-plus 80583d9a
(memory-store/transcript/recall/skills all in trunk; its provider abstraction was
abandoned) · hermes-parity-loop 8879b646 (42 commits of proof-plumbing superseded by
release-train + t0–t5) · starnet-hardening-5-6-memory-consent 87b04cd7 +
starnet-memory-consent 3b1470b1 (durable todo: keys + test in trunk) · starnet-memory-loop
bb9369a3 (declined: store in trunk) · quick-model-selector 8a40ddd1 (modeldock + reasoning
efforts in openrouter.js) · starnet-tests-tauri cbb155b9 (landed as 4c8b0f98) ·
workstreams-sessions-ui 9ae72942 (23-line net change, rail evolved past it).

**Also torn down: 10 already-MERGED branches + worktrees** (byok-coldstart,
connector-catalog, secrets-keychain, update-host clean; comms-picker, honest-errors,
retention-p3, ux-hints, cron-visibility-plan, prop-upgrade had only launch-config/QA-artifact
dirt — cron plan doc salvaged to docs/archive/).

**KEPT — real value, in priority order:**
1. ~~`agent/belt-reclaim`~~ **MERGED 2026-07-06 ~23:59** (gate green, 260 steps). Live-app
   check ✅ DONE 2026-07-07 by Atlas wave-3 REFIT lane: drag-clear of a 3-belt run → 0,
   ONE undo restored all 3 (evidence .bugloops/perfectionist-build2-20260707/refit-verify.json).
   Worktree teardown pending.
2. `agent/growth-t4` (ac7bf9f5) — T4 beat-balance pass (516 lines: prioritized ask stream,
   no-double-beats proof, beat-audit script + 201-line test) **plus ~411 lines UNCOMMITTED
   in its worktree** (iteration from 7/02). Needs its author-lane to finish or an explicit
   decision to adopt/discard the dirty work. Do NOT tear down.
3. `agent/parity-finish` (1c203a50) — code all landed (fs.patch, V4A parser, mcp stdio),
   but the branch carries far richer tests (549-line fs.patch.test vs trunk's 131).
   Harvest-tests task: port the extra cases against trunk's stricter parser, then delete.
4. `agent/ui-number-format` (4af14e29) — canonical U.usd/U.tokens exist in util.js but
   dupes remain (clip.js fmtUsd, etc.). Low-risk consolidation refactor; low priority.

**Merged-but-DIRTY worktrees left in place** (real uncommitted code deltas — inspect
before any teardown; `-Force` discards): auto-memory, bug-patterns, connector-spine (50
files!), hermes-settings-audit, live-polish, mac-linux-support (23), meeseeks-subagents,
skins (14), starnet-build-skills-crop, starnet-security-check, starnet-spend-model-honesty,
truth-chrome-instruments (tonight's; its orchestrator tears down).
Rule stands: land it or delete it — an unmerged branch is a claim nobody verified.

## DONE 2026-07-07 — timeout + task board fixes (Fable session) ✅

- **provider-connect-timeout** MERGED 46e1cf22: `connectSignal` passed
  `AbortSignal.timeout(30s)` to fetch, which aborts the RESPONSE BODY mid-stream — any turn
  streaming >30s died with "The operation was aborted due to timeout" (killed Andrew's
  tetris run, codex/gpt-5.5). Fixed: `timeouts.connectGuard` (timer disarmed at headers),
  adopted in all 5 adapters; idle watchdog default 120s→300s (env knob kept); regression
  tests (stream-past-connect-window survives, connect expiry = retryable 'timeout', user
  cancel = AbortError). Gate green fast+http. NOT live-run-smoked (transport seam, unit+e2e
  proven).
- **taskboard-truth** MERGED 3822e212: board flooded with every session in IN PROGRESS
  forever. Fixed: `kind: task|chat` on workstreams (board-add/recipe/goal//background =
  task; summon/chat/cron sessions = chat, off the board); legacy saves inferred by lane
  (todo/shipped→task, active→chat — old session flood self-clears); truthful RUNNING /
  DONE—REVIEW & SHIP chip on active cards via Channels.isBusy. SHIP stays human-only.
  Live DOM round-trip NOT done (predicate proven against real module + dev seed).
- Discovered in passing: sidecar/loop.js has a stray NUL byte (~offset 32377) — git/grep
  treat it as BINARY. ✅ FIXED 2026-07-07 in agent/multiagent-truth (2 raw NULs → u0000
  escapes, runtime-identical; loop suites green).

## DONE 2026-07-07 — SKILLS panel legibility (Fable session) ✅

- **skills-legibility MERGED 9b2c22a4**: the library read as broken ("can't enable
  anything") — 36/38 recipes OFF on a fresh station, ◉/○ glyph didn't read as a switch,
  enabling a gear-gated skill just changed text to "● ON · needs CABINET" with no path to
  a cabinet. Shipped: real ON/OFF pill switch; user-choice vs floor-grant rendered as TWO
  visuals (switch + READY/NEEDS GEAR chip, combined string deleted); `→ PLACE <OBJECT>`
  deep-link that opens REFIT with the prop pre-selected; library regrouped READY→NEEDS
  GEAR→OFF (category = inline tag); `OBJECT AT DESK → CAPABILITY → SKILL` strip +
  capability locked copy now "○ NO DISH AT DESK"; all 5 no-gear recipes default-on
  (catalog ceiling — only 5 empty-`requires` recipes exist, not ~12). Gates fast(260)+http
  green; live-verified in-lane (switch round-trip, group moves, REFIT palette state).
  ⚠️ compose budget now 11952/12000 chars with defaults — any default-on growth needs the
  pinned test (`skills.library.test.js` asserts default⇒gear-free) revisited.
- Guardian P1 `6feab179` (J2b run-survives-close "regression" at 00538abd) triaged at
  merge-gate: 2× `qa:journeys --only J2` on merged trunk = 38/38 PASS. Flake in the
  15×120ms busy-poll window, dismissed with evidence in the finding.

## DONE 2026-07-07 — Station Atlas: the perfection loop (Fable session) ✅

- **Station Atlas MERGED 00538abd** (gate 261 green in-lane AND on merged trunk): the
  goal+loop system for perfecting every surface element. `qa/atlas/` sharded registry
  (every UI control / slash command / API route / bus event / shoot state gets a dossier:
  purpose · promise · wiring · coverage · status), `scripts/qa/cartographer.mjs` mapper
  (sweep enumerates the REAL surface — 1059 live DOM elements across all 16 states + 40
  cmds / 114 routes / 60 events — diffs vs registry, skeletons new, flags missing, files
  deduped P2s; no-fake-green exit 2 on BLOCKED; ports 8920-8929/9320-9329),
  `loops/perfectionist.md` judgment loop (7-point rubric: purpose/promise/works/truthful/
  discoverable/polished/covered; sessions judge, fixes route to feature lanes; staleness
  via git re-queues perfected entries whose wiring files moved). Goal gauge =
  `npm run qa:atlas:status` (PERFECTED-fresh X/Y).
- **Live-proven same session:** trunk re-sweep after the parallel skills-legibility merge
  caught the drift unassisted — created 94 / missing 51 → the mapper detects surface
  change with zero human eyes (39b9c569).
- **Guardian collision FIXED 2026-07-08 (branch `worktree-agent-a587eb4a789044522`, unmerged):**
  root cause = the hourly task, the `--watch` process, and manual runs all target the SAME pinned
  worktree + the SAME 8940-8943 ports, so overlapping runs raced on the shared
  `.git/worktrees/**/index.lock` (finding 90fe0bcc) and timed the visual gates out into BLOCKED
  P0s (9b077d5e/6fc6c002/328bc698/69eff742). Fix = a **machine-global cross-process lock** in
  `guardian.mjs` (heartbeat lockfile at `%TEMP%/starnet-qa-guardian.lock`, PID-liveness +
  stale-reclaim; one-shot SKIPs when held, `--watch` skips-and-retries, `--wait` queues) — the
  three launch styles now serialize. Also: a red gate whose every finding is dismissed/known is
  now **review-clean** at the cycle verdict (mirrors golden), so the dismissed J2b panel-close
  busy-poll flake (`6feab179`, reproduced 3/3 PASS isolated) no longer pins the release gate RED;
  `journeys.mjs` mirrors it for its own exit code. QA_STATION §2 "overlap harmlessly" claim
  corrected to the truth. GREEN all-5-gates cycle proven on trunk 42803552 (guardian-20260708-195105);
  all 10 stale Guardian findings closed → Green Guardian 0 open. OPEN = merge to trunk (the live
  hourly task runs trunk code, so the lock only protects production after merge).

## QA Escape Loop — standing directive (added 2026-07-07, Fable session)

**Why:** Andrew keeps finding bugs that audits called "up to par." Diagnosed causes:
(1) the QA Station (`qa/QA_STATION.md`) was built 7/01, movie-tested green, and **never
activated** — Guardian last ran 7/03 while ~40 lanes merged unwatched (first re-run 7/07
immediately went RED on 7 stale-baseline golden findings; triaged + re-blessed 79016922);
(2) station coverage is **static/seeded/happy-path** while Andrew's bugs are **dynamic seam
bugs** — sim↔UI↔task-truth diverging *during* real use (taskboard flood, >30s stream abort,
features breaking under interruption); (3) nothing converts an Andrew-found bug into
permanent machine coverage, so coverage never converges on his bug distribution.

**The law (EL-3, mirror into skills when EL-1 lands):** *an escape is a coverage gap, not
just a bug.* Every bug Andrew reports: BEFORE the fix merges, the lane must land a failing
journey/audit assertion that reproduces it — or a ledger KNOWN entry naming why it can't be
automated. Merge ritual gains the question "which journey/assertion covers this feature's
promise?" (sibling of "where's its UI?").

**Queue:**
- **EL-0 · Activate the watch** — ✅ DONE 2026-07-07 (Andrew-approved): 3 scheduled tasks
  registered (`StarNet-QA-Guardian-Hourly` / `Beginner-Daily` / `Janitor-Weekly`, verified
  via schtasks) + session `qa:guardian:watch` running. STILL OPEN: the Overseer `/loop`
  session (QA_STATION §6, the digest+P0-notify half) and a reboot-surviving per-merge watch.
- **EL-1 · Journey Corps** — ✅ MERGED 2026-07-07 (44a513e7, gate 260 green; orchestrator
  live-ran qa:journeys on merged trunk 114/114 PASS). `npm run qa:journeys` = J1 task-
  lifecycle+taskboard truth · J2 E-STOP/panel-close/reload interrupt honesty · J3 double-
  send/rapid-toggle · J4 summon→deliverable→OPEN serve contract · J5 parityCheck sweep;
  Guardian 5th gate (8943/9343). Known limits: mock-provider boundary (proves seams not
  model output); J4 asserts the serve contract over HTTP, not a real tab-nav.
- **EL-2 · Saboteur mutators — FIRST SLICE BUILT 2026-07-21 on `agent/bug-discovery-system`.**
  `npm run qa:saboteur` inventories the live declarative route table and runs a seeded,
  replayable hostile-input sweep against an isolated real sidecar: launch-token bypass, hostile
  Origin, and five malformed JSON shapes on stateful seams. Failures persist a full evidence report,
  dedup into the QA ledger, and the sweep is composed into every Guardian cycle. Calibration at
  v0.6.4: 317/317 attacks green (seed 644). Pure planner/triage locks are in `qa-saboteur.test.js`.
  OPEN: the journey-mutator half (rapid panel toggles mid-run, provider disconnect/slow-stream,
  restart-at-write boundaries) and installed-exe weekly mutation pass.
- **EL-4 · Installed-app weekly smoke** — CDP-attach to the installed exe and run the parity
  sweep there; the dev sidecar can never see the WebView2-cache class. Session task, weekly.
- **EL-5 · ESCAPE 2026-07-07: Telegram bot token silently destroyed** — ✅ FIX MERGED
  a1f8cc66 (gates fast 261 + http green; failing scenario landed with the fix per EL-3;
  lane live-smoked restart round-trips both directions). Andrew must re-paste the BotFather
  token once (old one unrecoverable); it now persists plaintext until the keychain verifiably
  adopts it. EL-5b lane `agent/secrets-durability` IN PROGRESS (Fable session). Desktop keychain migration stripped the plaintext
  token without read-back proof the keychain held it (3 paths: main.rs `let _=set_password`,
  saveChannelSecrets unconditional strip, sidecar boot migration). Live-verified on Andrew's
  install: `channel:telegram` absent from Credential Manager, config intact. Per EL-3 the
  failing scenario lands WITH the fix. Follow-on: secrets-durability sweep of ALL credential
  stores (provider keys / codex OAuth / connector OAuth / .bak recovery) — findings will be
  queued here. NEW MERGE-RITUAL QUESTION: "does this change move/strip/clear any credential —
  and where is the read-back proof?"
- **EL-5b · Secrets-durability sweep findings — ✅ ALL 4 FIXED + MERGED 2026-07-07 (lane
  agent/secrets-durability, gates fast 261 + http green; every finding re-verified real,
  failing-test-first).** Shared root causes = silent `catch{warn}` on secret saves +
  multi-step persists without confirmation. New shared primitive: `saveJsonVerified()` in
  sidecar/durable-store.js (write → read-back → proof predicate → retry once → honest
  ok:false) — USE IT for any future credential persist. Details in qa/STATUS.md digest.
  Historical findings:
  - **F4 HIGH — Codex OAuth refresh persist:** `ensureCodexAccessToken` (sidecar/index.js
    ~1737-46) rotates the refresh_token in memory; if `saveCodexTokens` write fails
    (swallowed), a crash strands the OLD dead refresh_token on disk → forced re-sign-in.
    Fix shape: verify the write (read-back) before treating the rotation as durable; surface
    failure.
  - **F1/F3 HIGH — Connector OAuth tokens/clientId:** `saveConnectorOauth` failures are
    silent (index.js ~1837-39, ~3345-3400); DCR clientId + refresh_token can both exist only
    in memory after a successful sign-in → next boot the connector is unsigned and the
    orphaned clientId can't be reused. Fix shape: same read-back law + fail the sign-in flow
    loudly if the token didn't reach disk.
  - **F2 MED — Spotify refresh clear:** spotify/store.js ~86-108 — `clear()` must fire ONLY
    on explicit `invalid_grant`; harden the malformed-response path (`res.json()→null`) so a
    weird 400 can never wipe a live refresh_token.
  - **F6 LOW — .bak scrub gap:** scrubChannelSecretsBak returns silently on unreadable .bak,
    leaving plaintext key in the .bak (hygiene, not loss).
  - Audited CLEAN: roster/knobs/budget/allowlist/cron/ledger via saveResilient+.bak;
    localStorage creds not touched by version purge.
- **EL-6 · ESCAPE 2026-07-07: multi-agent run died ~5min + visuals lied + research not
  headless — ✅ FIXED + MERGED (lane agent/multiagent-truth → 957384bf, gates fast 266 +
  http green, escape-first tests, live-verified dev seed).** Andrew's overseer→researcher→
  peter dispatch: worker ran its roster MODEL on the LEAD's provider wire (instant 400 when
  they differ — the fast worker death), run stream byte-silent for minutes during dispatch
  (silent-socket kill class), diag error ring RAM-only (restart erased the evidence), worker
  sprite decayed at RUN_TTL because only lifecycle+cost forward, and browser.* launched a
  VISIBLE window for research. All seven fixes in the qa/STATUS.md digest. STILL OPEN from
  this escape:
  - **EL-6a · queued-worker floor affordance** — team.dispatch's later workers show NOTHING
    until their turn (sequential by design). Needs an ADDITIVE shared/events.js event (e.g.
    dispatch-intent carrying worker ids) — REQUEST TO CONTRACT OWNER (cortex-memory lane);
    argsSummary's 80-char clip cannot carry the list. Then world.js renders a "queued" chip.
  - **EL-6b · single worker turn >5min** — agent.cost stamps the TTL per completed turn; a
    single silent turn longer than RUN_TTL still decays the sprite. Acceptable edge unless
    escapes recur; revisit with EL-6a's event.
  - **EL-6c · Andrew's exact trigger unconfirmed** — his install predates the diag
    persistence, so the original error text is gone. If it recurs on a build with this lane,
    /api/diagnostics now carries the error across restarts; pin it then.
  - NOTE: his diagnostics said `App version: unknown / Mode: browser` — expected for npm
    start/browser mode (packaged desktop sets STARNET_APP_VERSION + tauri origin). If he was
    IN the installed exe, that's an origin-detection bug worth a look on a repro.

## EL-11 · STRANDED-USER SWEEP 2026-07-08 (5 live-driven domains; THE ship gate) — 12 STRANDED + 1 lock / 22 ROUGH

**STATUS 2026-07-09 (launch-polish session, code-verified per item):** items 1,3,5 ✅ FIXED via
rescue merges 187724e3 + 8b5aae04 (fixes were finished-but-unmerged on dead subagent worktrees —
lost-work law strikes again); items 2,4,6,7 ✅ were already fixed on trunk (a996da07 + b7f984b3);
items 8-13 STILL OPEN, all frontend-owned, queued with fix shapes at the top of this file.

LAW (memory stranded-user-testing-law): shippable = zero STRANDED. Each item = fix lane + EL-3 test.
STRANDED (ranked): 1. hung provider stream ends RUN COMPLETE reason:done (provider.js:146-160 reader.cancel settles read as done — watchdog cannot fire; night beats inherit) 2. degraded workspace: writes refused 200 ok:false while save-dot healthy + cloudsave stamps success (cloudsave.js~105/app.js~990 check r.ok not body) 3. background-session consent invisible → auto-DENY at 120s (notify gated on isActiveWs; warroom hotspot removed) 4. night-shift durable halt (TONIGHT'S fix) invisible: panel says ACTIVE/standing-by + NEXT ELIGIBLE while halted:true never read by any frontend; lift (dial re-write) documented nowhere 5. wedged beat run holds agent mutex forever; /api/halt misses handleNightshiftBeatNow AC (index.js:7085) + E-STOP button doesn't exist (hotkey-only, error copy names it) 6. post-sidecar-respawn stale token → all 403 + "Add a key" misdirection (classify 403 as reload/re-auth) 7. double-corrupt save → silent GENESIS (quarantine works, zero disclosure) 8. no undo for out-of-jail artifacts (ns/ branches, workshop KEEP) 9. full-agent backup (save+memory) unreachable in-app (connect-screen only; STATION BACKUP = 1.4KB settings, no memories) 10. dead MCP connector invisible outside panel (connector.state → console.log only, GA-8) 11. dead channel invisible outside panel 12. custom/Ollama base-URL uneditable post-onboarding + 13. connector OAuth 5-min uncancelable lock survives panel reopen.
ROUGH highlights: harness.js:355 discards error body (EL-10 door lost pre-stream) · key REMOVE doesn't revoke server-side · provider-down blamed on app · TG/DC "connected" lie pre-auth (1c09b36f) · 402 top-up URL not a link · budget stops never name cap/door (/api/budget/resume zero callers) · HALT toast "stopped 0 runs" lie · readiness-gate jargon hides the grant · awakening full-replay on reload · broken-brain invisible until failure · fresh workspace inherits codex tokens cross-root (sign-out violation) · disk-fail 60-min blind window · silent .bak recovery · no bulk memory delete · no tour replay.
Full evidence: session scratchpad stranded/ + shots; agent reports 2026-07-08 evening. Stale claims corrected: GC-7 browse EXISTS, GB-22 cleanup EXISTS, GA-3 retry chip EXISTS.

## EL-10 · ESCAPE 2026-07-08 (Andrew, post-0.4.0 install): ChatGPT OAuth died + settings LIED "SIGNED IN" + zero recovery UI — fixes IN FLIGHT

First message after the 0.4.0 update: "ChatGPT sign-in expired… refresh token already consumed
by another client." Three compounding defects, none caught by any gate:
1. **Root cause = orphan sidecars** (the chip previously classed cosmetic — now P0): 3 stale
   node.exe sidecars were alive pre-install, all sharing the codex token file; OAuth refresh
   ROTATION means they consume each other's tokens. Violates one-sidecar-per-WORKSPACES.
2. **Settings→Providers asserted "● SIGNED IN · 1 key" while the token was dead** (sidecar knew
   — it had just errored the run) and the CHATGPT row renders NO actions (no re-sign-in, no
   disconnect; key providers get UPDATE/REMOVE). Truthful-telemetry violation in the flagship
   settings panel.
3. **Recovery engine existed, unreachable**: /api/auth/codex/start|poll|logout + a full sign-in
   UI exist — mounted ONLY in the new-agent brain screen. Error card offers only ADD A KEY.
RECOVERED live same session by driving the device flow via CDP through the installed app
(connected:true, persistError:""). FIXES in flight (2 lanes): (a) honest expired status +
RE-SIGN-IN/DISCONNECT row actions + error-card RECONNECT deep link, EL-3 tests; (b) main.rs
boot-time reap of orphaned bundled-node processes (fail-open, install-path-scoped).
COVERAGE GAP TO CLOSE (the meta-lesson): NO gate drives a provider AUTH LIFECYCLE
(sign-in → token death → in-UI recovery). Queue a journey/e2e for it (rides the same lane as
the queued per-system journeys). NOTE: the main.rs fix reaches Andrew's install only at the
NEXT desktop build.

## Ready Gate · RC Soak · Dogfood — process-fix wave 2 (added 2026-07-07, Fable session)

**Why (session audit 2026-07-07):** the EL loop fixed *detection* but not the *repeat*: (a) the
aggregate "ready / go public" claim was never gated on anything — sessions reported lane-green as
project-green while the Guardian sat RED; (b) nothing ever uses the product the way Andrew does
(installed exe · real providers · long multi-step work), so he is structurally the first tester;
(c) no freeze — merging 10+ lanes/day means readiness is audited against a moving target.

**The law (READY-GATE, mirror into starnet-verify + DECISIONS.md when EL-7 lands):** no session,
report, or doc may claim StarNet is "ready", "perfect standing", or "go-public-able" without a
fresh `npm run qa:ready` receipt printed alongside the claim. Lane-level done stays lane-level:
"lane X verified; station-wide status is whatever qa:ready says."

**Queue:**
- **EL-7 · qa:ready gate** — ✅ MERGED 2026-07-07 (lane agent/ready-gate → 7f737a93, gate 267
  green): `npm run qa:ready` = one machine verdict READY/NOT-READY with per-check receipts
  (ledger P0/P1 via openBySeverity() · Guardian green+fresh+saw-current-trunk via git drift ·
  journeys · beginner · installed-smoke stamp ≤7d). No-fake-green. LOCKED LAW in DECISIONS.md +
  starnet-verify: no "ready/perfect/go-public" claim without a pasted fresh qa:ready receipt.
  First live trunk verdict: honest NOT READY — 5 reasons (6 P0 · 6 P1 open; runner stamps unwritten
  until each runner's next cycle; installed exe unverified).
- **EL-8 · RC freeze + installed-exe soak (absorbs EL-4)** — ✅ MERGED 2026-07-07 (lane
  agent/rc-soak → bf72e8bb, gate 268 green): docs/RELEASE_READINESS.md (rc/<ver> freeze — only
  P0/P1 cherry-picks with their EL-3 scenario; ≥48h installed-exe real-provider soak, dogfood-
  driven; P0 restarts the clock; pass = 0 new P0/P1 + qa:ready READY) + scripts/qa/installed-
  smoke.mjs (CDP attach 9333 via scripts/lib/cdp.mjs; GREEN/RED/BLOCKED stamp qa/installed/
  last-smoke.json — cross-lane read PROVEN live vs qa:ready; BLOCKED files P0, RED files P1) +
  RELEASE_RUNBOOK step 0 (no READY, no release:bump). STILL OPEN: first real run against
  Andrew's installed exe (relaunch with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=
  --remote-debugging-port=9333, then `npm run qa:smoke:installed`).
- **EL-9 · Dogfood loop (Andrew stops being QA)** — ✅ MERGED 2026-07-07 (lane agent/dogfood →
  41b189fc, gate 266 green): loops/dogfood.md 9-step real-user shift + crew row/ports 8970–8979 +
  first proof shift in qa/dogfood/SHIFTS.md (mock, labelled; interrupt truthfully cancelled,
  diagnostics survived restart, 0 anomalies). STILL OPEN: first REAL-provider shift (needs key in
  dev/.env.dev; pennies on a haiku-class model) and installed-exe shifts as the RC-soak driver.

## Atlas — Perfectionist area claims (one session, one area)

The Station Atlas (`qa/atlas/`) is a registry of every surface element; Perfectionist sessions
(`loops/perfectionist.md`) drive each to `perfected`. **Concurrency law** (`docs/MISTAKES.md` #4 +
`qa/atlas/README.md`): one session claims one area at a time. Before working an area, claim it here
as `IN PROGRESS — <lane> · <area>`; release it (delete the line) when the batch commits. Never work
an area another session has claimed. Priority: escapes-adjacent first, then
`system → crew → work → build → world → commands → routes → events`; stale before unmapped.

Gauge: `npm run qa:atlas:status`. Trunk re-sweep 2026-07-07 (39b9c569): **1339 entries, 0 perfected**
(1288 unmapped queue + 51 missing from the skills-legibility redesign — P2s filed, dedup holds).
The whole surface is the queue. Areas: system, crew, work, build, world, commands, routes, events, props.

_Active claims: (none)._

Wave-3 done (2026-07-18): registry 1154 (harvest collapse −369), 34 unmapped left; 9 new coverage
suites (~420 assertions) in the gates; 10 findings fixed. 551 derived-stale from mid-wave trunk
frontend merges — freshness is a living number; wave-4 = re-proof cycle once the frontend settles
(post exe cut). Open product items: jukebox tier 818768f7 · ui id/aria anchors d8bc2554/cea0899f.

Wave-1+2 (2026-07-18, release-polish lane): gauge 0% → 18% fresh (274/1523) + 478 audited; zero
product truthfulness defects across 1,200+ judged entries; digests in qa/STATUS.md. Wave-3 queue:
build connectors tail (136 unmapped) · model-harvest collapse (finding e9d24ac6) · coverage wave
(the ~20 filed coverage-gap findings convert audited→perfected) · jukebox tier taxonomy call
(818768f7) · stable id/aria anchors for skill-card + high-traffic controls (cea0899f, d8bc2554).

_**CAMPAIGN COMPLETE 2026-07-07** (7 waves, 17 lanes, every merge through the full ritual):
**0 unmapped / 1288.** End gauge: 184 perfected·fresh · 235 audited · 842 mapped · 27
honest-stale (conditional-render). The loop is now STANDING WORK, not a campaign:_
1. _Promotions blocked ONLY on coverage — the chips are the unlock: probe layer
   (task_6453f643, HIGHEST leverage), slash-input P1 (task_a3433760), then the coverage
   set. Each landed chip lets the next Perfectionist pass promote dozens of audited
   entries._
2. _842 mapped = seam-traced clusters awaiting deeper per-instance passes — future
   sessions pick areas per loops/perfectionist.md priority as needed; the registry is
   the queue._
3. _Cartographer re-sweep after any UI-adding merge (skeletons new surface); staleness
   auto-requeues; nightly reprove once the probe layer lands._
4. _Overseer morning triage owns the 10 open Guardian + 1 Beginner P0 from today's
   merge storm (3 golden re-bless deltas · 4 collision-BLOCKED (lock chip!) · 1 flake-
   class · beginner first-directive stall needs a quiet-machine re-run)._

_Wave-6 DONE 2026-07-07 (3 lanes merged + gated 266 + reaped): **build/crew areas COMPLETE,
world 429→15 unmapped**. 18 seals===catalog + 5 loadout-law dossiers + custom-class round-trip;
props gallery contracts (38/38 skills, 37/37 connectors, mouse-place dish=cap re-proven);
model-dock family 376 rows + honest offline-fallback labels. Zero truth defects; 3 KNOWN
coverage notes (75af5388, cbc5b114, fc9beb65) — all probe-layer candidates._

_Wave-5 DONE 2026-07-07 (3 lanes merged + gated 265 + reaped): **work / system / events areas
COMPLETE (0 unmapped each)**. Truth bug found+chipped: telegram connect lies 'connected'
pre-auth (1c09b36f). Dead listener 'flagged' + 16 aspirational event slots → cortex-memory
wire-or-retire (1019f6e1, 9c5ec90c). Catalog UI-dispatch seam unguarded (3717ef2e). Restale
37/37 HELD mid-wave, then NS-4 (stationui.js+index.js) re-decayed 329 — final restale sweep
scheduled as wave-7 closing step; probe chip = the structural fix._

_Wave-4 DONE 2026-07-07 (3 lanes merged + gated + reaped; gate 261→264 under parallel
merges): **restale 76/76 HELD, 0 regressions** (sidecar token/OAuth commits moved no
audited seam — proven) · **routes ALL 114 mapped**, 19 core contracts proven (tts/stt
200-always + diagnostics secret-free + snapshot==store all HOLD; /api/session = no-op
stub b1248295; six core routes only covered by non-gate test:http 6887ef72) · **crew**
12 restale held + 16 new, SKILLS-honesty + XP-truth laws proven live (CHANGE SKIN
uncovered d2121f51). Staleness churned again mid-wave (night-shift merges → 42 stale)
→ **executable-probe upgrade chipped** (probe-per-dossier → nightly script reprove;
that chip is now the highest-leverage Atlas click). Gauge: **67 fresh / 42 stale /
50 audited / 125 mapped / 1004 unmapped**. Janitor item: gen-trees/perfect-crew2 dir
locked by stray handle (git-pruned, inert). Next: system remainder (132) · world
remainder (429) · events (60) · re-prove routes' 19 when probe layer lands._

_Wave-3 DONE 2026-07-07 (3 lanes merged + gated 261 + reaped): world/COMMS +4P/+3A
(chat-stop never machine-clicked bd391f68 · voice press-flips c3fa1f39) · build/REFIT +11P
(**object=capability proven live: place=grant/undo=revoke/redo=re-grant**; belt-reclaim
one-undo live check DONE — item #1 above closed) · commands ALL 40 mapped, 14P via the real
input path (**P1 070e8aca: the 7/05 args-bug seam has only source-grep tests — behavioral
journey chipped**). **Staleness fired for real**: parallel merge b1af72a5 touched
sidecar/index.js → 76 wired entries decayed perfected→stale (re-proof queue, by design).
Gauge: 25 fresh / 76 stale / 11 audited / 30 mapped / 1146 unmapped. Next wave: re-proof
the 76 stale (cheap — behavior unchanged unless channels-token work moved seams) · crew
remainder (92) · routes/events._

_Wave-2 DONE 2026-07-07 (3 lanes merged + gated + reaped; **gauge 45/1288 (3%)** + 32 audited):
system +11P/+3A (get-a-key gap a48393ca) · work +3P/+13A/+4M (UI-seam gaps e74ea483,
5c6adcaa) · crew +16P/+1A (DELETE AGENT uncovered 0e475aad). All blockers chipped.
Next wave: world remainder (438 unmapped) · crew remainder (92) · commands/routes/events._

_Wave-1 DONE 2026-07-07 (both lanes merged + reaped, gate 261 green each merge):_
- _build: pruned 51 redesign-removed · 13 SKILLS controls audited (blocked from perfected
  only by EL-3 coverage gap 11c69e21 → J-skills lane chip)._
- _world: **first 15 PERFECTED** (all 3 #bb-* doors + 12 dock items; live DOM round-trips,
  label==title 14/14, dup-purpose 0) · 2 audited (updates 16193fd0 / quests 161206b5 — no
  UI-open coverage → shoot-states chip). Product findings: **E-STOP undiscoverable**
  (b0f9d09f, Alt+H-only — conservative fix chipped; visible-button restore = Andrew call) ·
  topbar instruments un-enumerated (f0fddb55 → cartographer tooling chip)._
- _Gauge after wave 1: **15/1288 perfected·fresh (1%)** + 15 audited. Queue: 1258 unmapped._

## Table-stakes gap audit 2026-07-07 (Fable session) — missing mini-features, code-verified

Four-surface grep audit (COMMS / sessions / global-desktop / harness). Each item below was
verified MISSING or slash-only on trunk 626c017f before listing. Claim an item here before
building it (same law as Atlas areas).

_**CLAIMED 2026-07-24 — command-doors lane** (`claude/starnet-command-improvements-753256`):
adds a `dispatch:'server'` directive type to the slash registry (sidecar/slash.js +
sidecar/slash-actions.js) so a command's door is DECLARED in the registry and EXECUTED in the
sidecar, returning one honest text line — instead of a hand-wired `fetch()` per command in
chat.js. Ships three commands on that seam: `/routine` (cron CRUD — list/add/preview/run/
pause/rm; partially pays GA-9's "engine without UI" debt from the chat side), `/away` (the
away-workshop subsystem: 14 routes, today reachable only via the catalog-orphan `/build-away`),
and `/loop` (in-session interval watcher — distinct from `/goal`'s judge-driven continuation
and from a persisted routine). Also folds `/build-away` into the server catalog, fixing the
drift where it existed ONLY in chat.js's fallback list. Does NOT touch: `localLine` restyle
(parked for Andrew, line ~1771), per-chat `/model` semantics (DECISIONS.md:22), or
shared/events.js._

**T1 — chat core (COMMS), daily pain:**
- GA-1 Attachments: ALREADY BUILT on `agent/comms-attach` d9f7d9c7 (unmerged) — MERGE, don't rebuild.
- GA-2 Markdown/code-block rendering + per-code-block copy (renderProse = escape+linkify only; chat.js:314-333).
- GA-3 Edit-and-resend a user message; RETRY as a visible button (exists as /retry only, chat.js:2841).
- GA-4 Input history (up-arrow) + per-session draft persistence (input clears on send, chat.js:417).
- GA-5 Unread badge when COMMS closed / other session active (pill only while scrolled-up in open panel).
- GA-6 Search: session list filter AND in-conversation search (both absent).
- GA-7 Export/copy whole conversation; clear-conversation (per-message copy only).

**T2 — engine-without-UI (violates "where's its UI?" law):**
- GA-8 MCP connector status panel (manager.js emits connector.state; nothing renders it).
- GA-9 Cron/routines UI: next-run, last result, pause (cron-driver full; no surface).
- GA-10 Per-session/per-agent spend readout (workstreams track {tokens,usd,calls}; never displayed).
- GA-11 Provider rate-limit/quota rejection surfaced as friendly error (currently generic).
- GA-12 Steer-while-running button on the presence card (/steer works end-to-end, slash-only).

**T3 — desktop table stakes:**
- GA-13 OS-level (Tauri) notification on background task finish (in-app toast only).
- GA-14 UI zoom / font-size setting.
- GA-15 Tauri window size/position persistence across launches (not in main.rs).
- GA-16 DOM windows not resizable (drag+minimize only).
- GA-17 Replay tour / in-app help re-entry after onboarding; keyboard cheat-sheet overlay.
- GA-18 Settings: clear-all-data + data-location display.

**T4 — harness power features (lower urgency):**
- GA-19 Files-touched summary / diff preview before fs changes apply.
- GA-20 Attach context from UI (point agent at file/folder) — pairs with GA-1.
- GA-21 Prompt templates / quick replies.
- GA-22 Bulk session ops (clear completed, archive old).

**Round 2 (GB) — six deeper audits 2026-07-07: world, REFIT/workshop, skills/routines/voice,
lifecycle, micro-UX, journey-walk. Corrections applied: CHANNELS window EXISTS
(stationui.js:3360-3488 TG+Discord+health), ROUTINES console EXISTS (#rt-add/#rt-arm/run-now);
E-STOP visibility + get-a-key link already chipped by Atlas — not re-listed.**

*GB-T1 — highest pain:*
- GB-1 Transcript SEARCH UI: BM25 search already in transcriptstore.js:81 — zero frontend. One
  search box over all conversations. (Absorbs GA-6.)
- GB-2 Deliverables LIBRARY: browse/search ALL past outputs (returns.js caps at 8/24 pending;
  no archive view, no re-open old runs).
- GB-3 RECORDING MODE: one toggle hiding keys/spend/PII for screen capture (zero code; GTM —
  spectacle is the growth engine and Andrew records constantly).
- GB-4 Quit/update-while-running guards: BOTH halves FIXED 2026-07-14 (update-blockers lane).
  Update: Updates.install() checks Channels.busyCount(), amber guard card WAIT/INSTALL ANYWAY.
  Quit: quitguard.js intercepts close-requested (titlebar X, Alt+F4, taskbar), modal STAY /
  CLOSE ANYWAY when agents live, bounded state drain before EVERY allowed close (destroy()
  skips beforeunload), fail-open so a broken Channels never wedges the window shut. Needs
  the next desktop rebuild (capabilities +core:window:allow-destroy) to be live in the exe.
- GB-5 Crew bodies: pointer cursor but click falls through (world.js:720 hero-only) — click →
  quick actions (talk/dossier/locate); plus click-roster-name → camera jump to agent.
- GB-6 Prop hover tooltips (name + grants) — belts have tags (world.js:4080), props silent.
- GB-7 Needs-input triage: no roll-up of runs blocked on permission prompts across sessions
  (board shows RUNNING/DONE only; a stuck approval in a background stream is invisible).
- GB-8 "Resume/restore" discoverability: /restore + /resume slash-only; no UI on old sessions.

*GB-T2 — truthful-telemetry violations (backend knows, UI never shows):*
- GB-9 workspaceDegraded flag set (index.js:796) but never rendered — user unaware workspace
  is newer than app.
- GB-10 Disk-write failures fail-open silently (grants degrade to deny on ENOSPC, no surface).
- GB-11 Guardian sidecar respawn is silent — no "connection recovered" toast.
- GB-12 Skill last-fired/last-result never shown ("is this skill even used?").
- GB-13 Routine fire HISTORY absent + timezone mislabel (server ISO labeled "local",
  stationui.js:4168).
- GB-14 Per-run cost breakdown (in/out tokens, per-tool) — totals only.

*GB-T3 — build/world/workshop QoL:*
- GB-15 Prop palette search/filter + per-category counts (build.js:255-280).
- GB-16 Copy/duplicate placed prop; multi-select/bulk ops in REFIT.
- GB-17 Camera: reset/fit + follow exist in code (world.js:812,925) — expose UI + keyboard
  (+/-/F/arrows); mute-all quick toggle in chrome.
- GB-18 Workshop bulk cleanup UI (janitor sees 106 rot findings; user has per-card Discard only).
- GB-19 Inline preview for image/md/csv deliverables (html-only today).
- GB-20 Station layout blueprints (save/share/load layout templates).

*GB-T4 — micro-UX & hygiene:*
- GB-21 Focus trap + focus-restore in modal windows (aria-modal set, no trap; stationui.js:115).
- GB-22 Empty-input guards on create/rename (empty routine name → raw 400).
- GB-23 Copy buttons on ids/paths/tokens beyond diagnostics.
- GB-24 Goal abandon button + quest dismiss beyond dossier-kind (queststate.js:88 gates).
- GB-25 Voice: level indicator while listening, per-agent voice preview, STT language picker.
- GB-26 Automated periodic backup + backup-before-update (manual export only).
- ~~GB-27 .bugloops unbounded (395MB/2066 files) — TTL sweep.~~ ✅ 2026-07-09 launch-polish:
  evidence-sweep.mjs + qa:sweep + guardian-cycle hook (was 1,048MB when fixed).
- GB-28 Multi-agent status dashboard (which of N agents stuck/failed/done — superset of GB-7).

**Round 3 (GC) — closing sweeps 2026-07-07: external parity (ChatGPT/Claude Desktop/Cursor/
LM Studio) + final corners. Convergence reached: 18/28 parity candidates and most corner items
were already shipped or on GA/GB — the audit is saturated; below is the residue. AUDIT CLOSED.**

*GC-T1 — the OS-integration layer (the entire theme parity surfaced; StarNet has none of it):*
- GC-1 System tray + close-to-tray: app fully DIES on window close — contradicts the "agents
  keep working / 24-7 routines+channels" pitch. No TrayIcon anywhere in src-tauri.
- GC-2 Global summon hotkey / quick-entry window (ChatGPT Alt+Space class; no global-shortcut
  plugin in Cargo.toml).
- GC-3 Launch-at-login toggle (no tauri-plugin-autostart) — pairs with GC-1 for real 24/7.
- GC-4 Screenshot capture-and-attach (companion to GA-1; only canvas postcard capture exists).
- GC-5 App shortcut set: new session / focus input / palette (only ctrl-handlers in ALL of
  frontend = REFIT undo/redo + Alt+H) — makes GA-17 cheat-sheet worth having.
- GC-6 Always-on-top compact companion mode (capability in Tauri schema, never invoked).

*GC-T2 — chat + trust residue:*
- GC-7 Memory VIEW surface: user can veto ("forget this") at write time but can NEVER browse/
  bulk-delete what agents remember — trust/privacy gap (chat.js ~1070 deck is write-time only).
- GC-8 Temporary/incognito chat (no transcript/memory writes) — complements GB-3.
- GC-9 Branch conversation from a message keeping both (GA-3 edit is destructive).
- GC-10 Quote-selection-to-reply; @-mention agent autocomplete in input.
- GC-11 Session folders/projects grouping (flat list; matters past ~30 sessions).
- GC-12 Spend click-through: topbar total → per-agent/per-day breakdown (data tracked, no UI).

*GC-T3 — board + small residue:*
- GC-13 Task cards: drag between lanes, notes/description field, optional due-date (title +
  deliverable link is ALL a card holds today).
- GC-14 Recruit: preview class system prompt before summon; custom-class DELETE (edit exists);
  skin preview before confirm.
- GC-15 Factory-reset (fresh station) from settings without reinstall.
- GC-16 Widget resize (reorder/remove exist); maxlength counters (18-char rename truncates
  silently); spellcheck attr on chat textarea; emoji-in-names canvas rendering unvalidated.
- GC-17 Parked/low: proxy settings, app locale, migration guide doc (export covers data).

## NIGHT SHIFT — autonomy rebuild (added 2026-07-07, Fable session; Andrew-approved direction)

**Escape:** Andrew left the station overnight at MAX autonomy → exactly 1 autonomous act, then
10.7h of silence (live-verified in `runs.jsonl`: last self-directed beat 02:24, next activity =
the 1PM cron). Root causes code-verified this session — the autonomy layer is a demo, not a shift:

1. **One-beat-per-idle-episode**: `armed` flag (autopilotstore.js:92) spends the single beat on
   first idle fire and only re-arms on pointerdown/keydown. Overnight ceiling = 1, by design.
2. **Acts are reason-only**: "Do not run any tools" hardcoded in both directives
   (autopilot.js:196,273). Max overnight output = one text draft (its own self-review called one
   "Busywork"). Leash cap 3/day on top.
3. **The scheduler is a webview setInterval** (autopilotstore.js:229) with state in localStorage —
   sleep/throttle/restart kills autonomy silently. Nothing server-side drives idle work.
4. **leashPerDay is decorative** — no runtime enforcement anywhere; conversely cron ignores the
   dial entirely (routines fire even at initiative 'wait').
5. **Cron lease timeout duplicates long runs**: maxRunMs 8min < a real research run → live run
   declared zombie, reclaimed, re-fired. LIVE EVIDENCE: daily news routine fired 4× in ~6min on
   2026-07-07 (runs 03f65b81/d5324ce4/fa179d96/be6646e3, one errored).
6. **Silent decisions**: at-capacity deferral event stubbed "pending" (cron-driver.js:237),
   disabled/no-capability skips invisible, autopilot logs nothing about why it did/didn't act.
7. **AutoJobs `proposed` flag is fire-once-per-lifetime** (autojobstore.js:95) — standing-job
   proposals can never re-offer.

**Andrew's locked direction (2026-07-07):** the SOUL is dossier/understanding-driven improv —
the agent digests what the user actually works on daily (runs, chats, projects, habits, values)
and self-generates genuinely useful needle-moving work. NO explicit night queue ("that's just a
cron with extra steps"). Acts = REAL tool runs confined to the jail. Pacing = steady beats,
leash-capped. Deliverable shape = "while you were gone I finished X — approve and I'll ship"
(approve/deny; deny feeds learning). Simple, powerful.

**Lane queue (claim in-file before building; shared/events.js changes are additive-only via its
owner):**

**ALL FIVE LANES MERGED 2026-07-07 (same day as diagnosis)** — NS-0 night-core · NS-1
night-shift · NS-3 night-hands · NS-4 night-report · NS-2 night-brain. Gates green after
every merge (final trunk: test:fast 266 + test:http full). **Composed live proof on merged
trunk (orchestrator-run, no force-fire):** seeded activity + mock provider + shrunk knobs,
posture free/sandbox/leash 3, zero user input → the SCHEDULED driver fired 3 real tool-run
beats at steady cadence, each built a real artifact in the workshop jail (3 jail dirs on
disk), the 4th tick declined binding:'leash', and /api/autonomy/ledger tells the entire
night truthfully (present→act/outcome→cooldown→leash). The overnight-1-task failure mode is
structurally gone: server-owned timer (webview demoted to EARN-only), restart-resume state,
enforced leash, multi-beat cadence, every decision ledgered.

**Residuals (honest):**
- End-to-end beat with a REAL keyed provider not yet observed (all lanes + orchestrator
  proved against mock providers per repo convention; first real overnight = the true test).
- NS-4 morning-report beat proven via real modules against a live sidecar in a node/vm shim —
  rendered-canvas DOM round-trip in the installed app still worth one attended morning.
- Workshop "kept vs discarded" context only joins night-shift deliverables, not user-workshop
  verdicts (no clean title+verdict source; NS-2 report).
- PRODUCT FORK for Andrew: should reach ≥ sandbox auto-imply the away-workshop write grant?
  Kept separate (no silent consent widening) — dial 'build'/'free' still needs the workshop
  grant once before night acts can write. Flip = ~5 lines in the posture write handler.

- **NS-0 · truth first (small, immediate):** (a) cron lease HEARTBEAT — renew while the run is
  provably alive, reclaim only on dead heartbeat; kills the duplicate-fire storm (test: run
  longer than maxRunMs fires exactly once). (b) emit the stubbed skip/defer reasons
  (at-capacity, disabled, no-capability) — needs the governed event-enum addition. (c) autonomy
  DECISION LEDGER: every beat records inputs + outcome (acted/earned/declined + which gate
  bound) durably; morning-readable. Truthful-telemetry law: if the dial shows "free", the
  station must be able to prove what it did with that freedom.
- **NS-1 · sidecar night-shift driver:** move the loop out of the webview. Server-owned
  away-detection (last user-triggered activity, frontend beacons on input; NOT DOM-only),
  beat attempt every ~30–60min while away, leash enforced + persisted server-side (survives
  restart), respects E-STOP/budget caps/same-agent mutex. Dial posture synced to sidecar
  (POST /api/autonomy/write exists). Frontend autopilot demotes to UI + activity beacon;
  `armed` one-shot logic retired. AutoJobs `proposed` fire-once reworked (re-offer on cadence).
- **NS-2 · the brain (understanding-fed improv):** context-pack builder — digest of recent runs
  /chat topics/projects touched/dossier dims/approve-deny history feeds the propose step, so
  grounding = what the user ACTUALLY did lately, not 6 static dossier strings. Reuse the pure
  propose→grounding-veto→score→select pipeline (autopilot.js) with the richer evidence; keep
  the confidence gate + learn-weights (deny = down-weight archetype).
- **NS-3 · real hands + approve-to-ship:** selected job executes as a REAL runOnce task run
  (surface 'autonomous', isTask), reach-gated: sandbox = jailed writes (workshop/cabinet) +
  web read; NEVER send/publish/spend (consent default-deny stays). Deliverable lands as a
  return card: "finished X while you were gone — approve to ship" with open-it action;
  approve = apply/unjail, deny = one-tap reason → NS-2 learning.
- **NS-4 · morning report + honest dial:** one welcome-back beat (one at a time law): what ran,
  what it built (open links), what it declined and WHY (from the ledger), one-tap undo
  (digestSummary/undo snapshot plumbing exists in autopilot.js B3). Dial copy updated to match
  enforced reality; GA-9/GB-13 routine UI items pair naturally here.

Done means (per lane, live-app): leave the station idle with dial at 'free' + dev clock/short
beat interval → observe ≥2 real jailed tool-run deliverables + a truthful ledger of every
decision, gate green. NS-0a done means the >8min-run duplicate repro fires once.

## NIGHT SHIFT wave 2 — relevance, not just autonomy (added 2026-07-08, Fable session)

**The gap (code-verified 2026-07-08):** NS-0..NS-4 made the shift *reliable and safe*
(server-owned beats, enforced leash, jailed real tool runs, grounding veto, ledger, morning
report — all release-grade). What it did NOT make is *relevant*. Andrew's bar: "I come back
and the agent found bugs in MY project" / "it picked an idea we talked about and prototyped
it." Structurally impossible today because:

1. **The agent never sees the user's actual work.** Context pack = run TITLES + chat
   FIRST-LINES (contextpack.js, labels-not-documents by design) + 6 dossier dims. No file,
   repo, diff, or document is ever read. Jail builds are greenfield-only.
2. **No durable idea memory.** Candidates are regenerated from scratch every beat; "things
   the user mentioned but never did" is stored NOWHERE server-side. Rejected-idea history
   (suggeststore/curiositystore) is frontend localStorage, invisible to autonomy.
3. **Behavioral signals stranded in the browser.** worksignal capability histogram,
   ProfileStore interests, UnderstandingStore — zero sidecar sync (no fetch in
   worksignalstore.js). Autonomy is blind to the richest "what does this user actually do"
   data in the product.
4. **Cron is the thinnest lane** — no context pack, no history; dossier block + goal note only.

**Lane queue (claim in-file before building; shared/events.js additive-only via owner):**

- **NS-5 · Project Lens core — ✅ MERGED 2026-07-08 (agent/ns5-path-trust → b6ef5092, gates fast 279 + http full green; live e2e vs real sidecar: one prompt → always → read → grant listed → restart survives → revoke re-prompts). Direction was LOCKED: no prop/picker, ref-fluid. OPEN: autonomous hard-deny proven at unit layer only (no live autonomous HTTP drive); consent card render not screenshotted; night-shift CONSUMPTION of blessed roots = part of the NS-5b lane (focus resolver picks the root, beats scan it).** The user just *tells* the agent a path in chat
  ("go to C:\...\myproject and fix X") and it works there. Mechanics (verified 2026-07-08:
  fs.js:73 rejects ALL absolute paths; permgrants GRANTABLE = ['cabinet:write'] only — this
  is a new capability, not a UX swap):
  (a) **Conversational path trust** — first time a run touches a path outside the jail, ONE
  consent prompt ("work in C:\...\myproject? always/once/no"); "always" records a standing
  PATH grant (provenance-stamped, listed + revocable in the Permissions Panel, same
  fail-closed persist as permgrants). resolveInside generalizes to resolve-inside-any-
  blessed-root; .env/.git-internals/symlink-escape hardlines stay.
  (b) **Known-project memory** — every blessed root is durably remembered server-side with
  last-touched metadata; this set IS the autonomy surface.
  (c) **Night shift may only revisit previously-blessed roots** — reads at reach ≥ sandbox
  (git log/status/diff since last visit, TODO/FIXME, run tests via existing jailed exec
  rules); it can NEVER bless a new root unattended. Deliverable = patch through the existing
  /pending → /decide gate: "found N bugs while you were away — approve and I'll commit."
  Approve applies to a branch in the user's repo (never main, never push); deny feeds learn.
  OPEN (Andrew, small): approve = auto-commit-to-branch (recommended) vs drop-the-.patch.
- **NS-5c · Projects rail — ✅ MERGED 2026-07-08 b635cbab (trunk gates fast 281 + http full green).** SESSIONS↔PROJECTS toggle in the rail head; PROJECTS view lists GET /api/projects in the .ws-row vocabulary (git badge + last-touched); blessed:false rows render REVOKED (never hidden). + ADD → POST /api/projects/bless (new interactive-only route, pure projectbless.js core; native Tauri picker if the shell exposes one — it does not yet, so typed-path fallback like the KEEP flow, no allowlist widened). Row click jumps into a session anchored to the root (Chat.prefill 'work in <path> —'). Remove revokes the path grant via the existing /api/permissions/revoke; list mirrors the grant store. Live-proven in the dev app (:8879 DOM round-trips): toggle→ADD subdir→resolves git root→row blessed w/ git+now→same grant in /api/permissions→jump-in seeds session+composer→remove→grant gone server-side→row flips REVOKED. Tests: projectbless (16) + projects-view (32) + e2e.pathtrust bless route (live). OPEN: desktop native folder dialog (starnet_pick_folder not implemented in the shipped Tauri shell — falls back to typed path).
- **NS-5b · Focus resolver — ✅ MERGED 2026-07-08 (agent/ns5b-focus → 9fc6fccc, trunk gates fast 285 + http full green;
  full test:http green incl. a new live e2e). Landed: pure resolver sidecar/nightfocus.js
  (evidence-ranked single priority, steer-outranks-derived w/ ~7d stale, day-keyed persist) ·
  directive LEADS "TONIGHT'S FOCUS: <ref> — because <evidence>" (autopilot.js, reason + V2) +
  same-night compounding block · bounded harness PROJECT SNAPSHOT scan sidecar/projectscan.js
  (consults blessedRoots() directly, NEVER blesses; its lines join the grounding-veto pool) ·
  project deliverable = a .patch in the jail; decide KEEP git-applies to a NEW branch
  ns/<date>-<slug> (never main/master, never push, clean-tree only, apply-failure reported
  honestly — sidecar/nightpatch.js + applyNightPatch) · durable steer POST/DELETE
  /api/nightshift/focus (no consent widening) · morning report + status carry the focus.
  LIVE-PROVEN vs a real sidecar + real git repo (test/nightshift-focus.e2e.test.js): beat
  declares focus citing evidence → patch in /pending → keep applies to an ns/ branch verified
  with git (original branch untouched) → discard wipes → steer sets/clears → focus persists.
  OPEN: driver-timer idle path unit-only (e2e force-fires via the sanctioned /api/nightshift/beat
  proxy); no frontend steer UI (route only); real-provider overnight unrun.**
- **NS-6 · Thread ledger — ✅ MERGED 2026-07-08 (agent/ns6-threads → fd4a6adf, gates fast 277 + http full green; e2e proves mine→stash→keep→propose→picked→discard→declined vs the real sidecar). OPEN: frontend turn-in card (reuse study card family + beat arbiter, fetch on agent.run.end) · real-provider mining run.** Server-side store of "threads": ideas
  mined from chats/study/pitches with state open/picked/delivered/declined + decline reason.
  Mint via a post-run aux pass (same pattern as reflect/study, stash → turn-in) and/or a
  nightly digest pass. Night-shift PROPOSE draws from open threads FIRST, improv second;
  deny/discard writes back permanently (kills the re-propose-rejected-idea failure mode).
  This is what makes "you mentioned X two weeks ago, here's a prototype" possible.
- **NS-7 · Signal sync.** Mirror worksignal histogram + profile interests + declined-idea
  fingerprints to the sidecar (same pattern as POST /api/autonomy/posture and /api/dossier);
  fold into the context pack + grounding-veto vocabulary.
- **NS-8 · One commander-context composer.** Unify dossier + goals + context pack + recall +
  threads into a single server-side composer used by ALL autonomous lanes (night-shift AND
  cron). Deepen chat mining beyond first-lines to a redacted topic digest.
- **NS-9 · Learning depth ("gets better over time" is real, not decorative).** Today the ONLY
  learn signal is per-archetype up/down weights capped ±0.5 (autopilot.js learnFold) — a deny
  teaches "less of that CATEGORY," never "not that idea / not that project / here's why."
  Build: (a) approve/deny captures an optional one-tap reason (wrong-thing / wrong-time /
  bad-quality / did-it-myself); (b) verdicts + reasons fold into the thread ledger (NS-6) at
  idea level and the context pack at project level; (c) the PROPOSE prompt cites past verdict
  patterns ("you kept the last 3 test-fix patches, discarded both blog drafts"). North-star
  product test (the Andrew framing, 2026-07-08): *the ceiling on autonomous relevance must be
  the user's granted context, never the architecture — and relevance must measurably compound
  with weeks of use.* Done means: same seeded station, 10 simulated beat/verdict cycles →
  proposal mix provably shifts toward kept-kind work (assertable from ledger + learn state).

Done means (per lane, live-app): NS-5 = grant a real repo, seed a planted bug, leave idle at
dial 'free' → morning report offers a correct patch through /pending, approve applies it to a
branch, deny is remembered. NS-6 = mention an idea in chat, never act on it, leave idle →
a beat proposes THAT idea, citing the thread; decline it → it is never re-proposed.

## Parked product decisions (need Andrew, don't guess)

- `fullOffice()` autonomous prop placement vs. hand-placed only.
- localLine slash-command restyle; focusAgent global-model overwrite semantics.
- Prompt-injection stance on auto-granted `team.*` (see P1).

## Session handoff format

End every substantive session by:
1. Updating THIS file (move landed items to DONE with the merge hash, add discoveries).
2. If you merged to trunk: the `starnet-merge-ritual` digest in `qa/` (existing convention).
3. A 3-line summary in your final report: **Landed** (verified how) / **Open** (what you
   did NOT verify) / **Next** (the single highest-leverage follow-up).
Do not create new `*_PLAN.md` files for work under ~a week; use this queue.
# READY TO MERGE 2026-07-18 — RELEASE BLOCKER CLEAN (`agent/release-blocker-clean`)

Guardian on current trunk `e1407f5f` found three visual P1s. `crew-commander` was a genuine
lost-work regression: later merges retained the Commander Dossier briefing/grid/starter markup
from `9069a855`/`c77f6e52` but dropped its CSS. Branch commits `e43fbef3` + `4ea5666f` restore the
coupled styles, add a 30-assertion fast-gate contract that prevents markup-without-CSS recurrence,
review and re-bless the repaired golden frame, and re-stamp W0 release-surface authority.

Live seeded DOM proof: the Commander window is 760px with `scrollWidth === clientWidth`, briefing
text wraps with `scrollWidth === clientWidth`, the dimensions resolve to two 348px columns, and all
16 starter chips carry the VT323/dashed-button styling. `build-skills` and `sys-rewind` were visually
coherent animation-noise findings (immediate no-code recaptures crossed above/below 1.5); dismissed
with exact evidence in the lane ledger. Final lane receipts: ledger 0 P0 / 0 P1 / 0 P2; GOLDEN PASS;
`test:fast` 364/364 green; full `test:http` green. `qa:ready` remains correctly NOT READY until this
branch is merged and Guardian/journeys/beginner/installed receipts are regenerated on that exact
integration commit. No merge or publish performed.

# READY TO MERGE 2026-07-28 — SESSION RAIL SEARCH TRUTH (`agent/quality-loop-0728b`)

The live SESSIONS rail rendered “No title or transcript matches” for an impossible query while
leaving the unrelated General row visible and selectable underneath. Search results now replace
the ordinary session list for the lifetime of a non-empty query; Escape and opening a hit restore
the list, and a PROJECTS round-trip preserves active search isolation. The generated website mirror
is synced and the existing session-power-tools gate now locks all three transitions.

Live seeded proof at `:8892`: the no-match row measured 230×51.9 px while General measured 0×0 and
`#workstreams.hidden === true`; Escape restored General at 230×27.1 px, cleared the query, and removed
the no-match row. Browser warnings/errors: none. Focused gate: 121 assertions; website sync: 8;
`test:fast`: 423/423 green. No backend seam changed, so `test:http` was not required. No merge, push,
PR, deployment, publish, production-data, credential, or secret change was performed.

# IN PROGRESS 2026-07-31 — MACOS DEVELOPER ID + NOTARIZATION (`agent/mac-notarization`)

Apple Developer Program enrollment is active. Trunk already carries hardened-runtime
entitlements and a release-train proof for Developer ID authority, Node JIT entitlement,
DMG notarization/stapling, and Gatekeeper acceptance (`11392c7d`). This lane makes the
public train fail closed when any of the six Apple signing/notarization secrets is absent
and turns an ambiguous non-notarized Gatekeeper source into a hard failure. A fast
structural gate locks that boundary; `docs/CODE_SIGNING.md` now contains the exact
certificate, app-specific-password, secret, backup, and first-live-proof procedure.

LIVE SETUP: Apple issued Developer ID Application certificate `5XX554XKQT` for team
`699UALS857` (expires 2031-08-01). The matching private key, certificate, PKCS#12 bundle,
and recovery material are stored outside Git with user-only ACLs. A dedicated app-specific
password and all six `APPLE_*` Actions secrets are installed in `androoAGI/starnet`.

FIRST CI PROOF: non-publishing `desktop-build` run `30606849654` exposed an OpenSSL 3
PBES2/AES PKCS#12 compatibility failure in macOS `security import`. The certificate was
re-exported as Apple-compatible SHA-1/3DES PKCS#12 and the secret replaced. Retry attempt
2 imported one identity, found Andrew Sims's certificate, signed the bundled Node runtime,
desktop executable, and `StarNet.app`, then submitted both Intel and Apple Silicon apps to
Apple notarization. Final Apple verdict and DMG artifacts are pending. Do not retire the
unsigned-download warnings until both architectures pass this staged live proof and the
DMGs receive a clean-Mac launch check.

WINDOWS TRUST PROOF: the same non-publishing run used Azure Artifact Signing account
`starnet-signing` / public-trust profile `starnet-public` and signed the app, NSIS
components, and final installer with zero errors. The downloaded setup executable passed
native Windows Authenticode validation as publisher Andrew Sims with a Microsoft verified
code-signing chain and timestamp. The checksum-verified bundled Node runtime independently
passes as publisher OpenJS Foundation with a DigiCert timestamp. The tagged release train
now fails closed on missing Azure credentials and checks all three timestamped signatures
before staging. A clean Windows SmartScreen/Defender launch remains the final reputation
proof; a valid new publisher can still show a reputation prompt during early downloads.

# DONE 2026-08-02 — CONNECTOR RELIABILITY TO 9 (`agent/connector-reliability-9`)

Commit `ac201720` lands Lanes 1–5: desktop restart now injects custom-provider credentials and
provider-specific backup pools; connector config/OAuth/client state is one versioned,
read-back-verified envelope; removal commits that envelope before touching runtime state; every
MCP OAuth discovery/DCR/token leg has a bounded deadline and composed cancellation; candidate key
and backup-pool replacement probes first and commits once; backup pools are explicitly provider
scoped in browser storage, keychain storage, runtime state, and restart environment injection.

Evidence on the synchronized candidate: `test:fast` 497/497 GREEN; full `test:http` GREEN
(sidecar 464 assertions, MCP E2E 79); the production Rust/NSIS build completed; real OpenRouter wire
certificate PASS for models, chat, tools, cancellation, and cost. The exact Windows installer
(`sha256 a3d4fb87e095dc7e4647429907e2fc6a27bb17b091a9692aa1ca0bd43de08183`)
installed cleanly, and the resulting executable
(`sha256 0313968d4d4ec43af0520adb95b5885fcd207e3f52b05adc30e13322bb74d62e`)
passed the provenance-bound installed smoke 9/9. A controlled provider driven through that running
installed app passed: correct key; wrong replacement with the old key still live; 429 replacement
with the old key still live; provider switch + restoration; custom-only backup pool with OpenRouter
still empty; real desktop restart with the custom key/base/pool re-injected; post-restart revocation
failed closed. The temporary custom key, base URL, pool, and mock server were then removed, and a
second desktop restart proved the empty state persisted; the final installed smoke remained GREEN.

**9/10 CONNECTOR RELIABILITY CONDITION MET.** The real installed candidate completed Notion's OAuth
authorization callback and enumerated 20 tools plus 2 resources. With the desktop stopped, the persisted
access-token expiry was moved into the past and read back; restart exercised the real refresh endpoint,
rotated both access and refresh token fingerprints, durably advanced expiry, and returned the connector
to `up` with all 20 tools. A second untouched restart preserved the refreshed fingerprints and the same
healthy tool/resource inventory without another prompt. Reinstalling the synchronized candidate then
preserved that authorization and repeated the installed smoke plus connector read-back. Deterministic
coverage remains green for callback exchange, skew-aware expiry, refresh-token retention, response-body
deadlines, cancellation, atomic credential replacement, provider-scoped pools, transactional persistence,
and connector removal. Rated outcome: MCP/API connector reliability **9/10**, multiple same-provider keys
**9/10**, overall connector release confidence **9/10**.

The local bundle is a certification candidate, not a public signed release artifact: NSIS finished, but
the updater-signing step correctly failed closed because `TAURI_SIGNING_PRIVATE_KEY` is unavailable in this
worktree. Public distribution still goes through the signed release train; this does not weaken the local
installed-app reliability verdict or the merge gate.
# READY TO MERGE 2026-08-03 — MACOS MICROPHONE PRIVACY DECLARATION (`agent/mac-mic-permission`)

Commit `14d26d46` adds the macOS `NSMicrophoneUsageDescription` bundle metadata required before
WKWebView may open the microphone for push-to-talk or Local Live. The purpose string lives in
`src-tauri/Info.plist`, which Tauri merges into the generated application bundle; a fast-gate
contract keeps the declaration coupled to the packaged offline voice runtime.

Evidence on the isolated branch: the plist parses as XML, the touched JavaScript passes
`node --check`, the focused desktop voice bundle test is green, and `npm run test:fast` is
517/517 green. A macOS artifact build and a real allow/deny/reset microphone round-trip remain
unverified on this Windows host; the next macOS release candidate must prove the generated
`StarNet.app/Contents/Info.plist` contains the key and exercise the prompt on real hardware.

# READY TO MERGE 2026-08-04 — FIELD MANUAL SELECTION ACCESSIBILITY (`agent/quality-loop-0804d`)

The Field Manual's five section buttons changed only the visual `.on` class, so assistive
technology could not identify FIRST STEPS, THE LOOP, GEAR, WIRING, or GROWTH as the active
section. The same selection predicate now emits `aria-pressed="true|false"`, the generated
website mirror is synchronized, and an executable production-renderer regression locks the
initial state plus the FIRST STEPS → GEAR transition.

Live seeded proof on `:8930`: FIRST STEPS initially had the sole visual and pressed state;
after choosing GEAR, GEAR alone was `.on` and `aria-pressed="true"`, its gear content was
visible, and the browser warning/error log was empty. Focused regression: 3 assertions;
website sync: 8 assertions; exact-code `test:fast`: 518/518 green. Frontend-only change, so
`test:http` was not required. No merge, push, PR, deployment, publish, production-data,
credential, or secret change was performed.

# READY TO MERGE 2026-08-06 — COMMS PROFILE-RENAME CACHE (`agent/statusbar-profile-names`)

Profile renames now invalidate COMMS' cached roster-option labels and focused-speaker name without
reloading the workstream or disturbing transcript/beat/run state. The frontend website mirror and
the agent-model source contract are synchronized.

Live seeded proof at `localhost:8791`: focused overseer `ATLAS → ORION` updated the CREW row and
selected COMMS option immediately; non-focused specialist `STRATEGIST → VEGA` updated its CREW row
and COMMS option while ORION stayed selected. After stopping and restarting the seeded sidecar with
`--keep`, both surfaces rehydrated as `ORION / VEGA`. Focused regression: 61 assertions; website
sync: 8 assertions; `test:fast`: 539/539 steps green. Installed-desktop verification was not run.
## 2026-08-07 — HERMES-CLASS PARITY 4–6 (`agent/hermes-access-gap`)

- **4 · Attended browser authentication:** closed by verification of the existing production path. Watched
  COMMS runs expose the two-phase `browser.login` handoff, visible Chrome uses the station-owned persistent
  profile, profile ownership is single-run leased, ordinary later runs reuse the authenticated profile, and
  unattended/headless/contention paths fail honestly. The focused browser suite is green.
- **5 · Isolated stdio MCP + agent-authored skills:** stdio connectors now bind to a named `SAFE CELL` agent.
  The Docker environment is probed before connect; the broker uses exact `docker exec` argv with no shell,
  keeps connector secrets out of argv, and has no host fallback. Connector configuration/status persists the
  owner and the UI offers the form only when a real Safe Cell agent exists. Existing `skill.write` /
  `skill.manage` lifecycle and guard coverage were re-proved rather than duplicated.
- **6 · Project discovery + owner grants:** Add Project now offers a bounded explicit discovery scan of common
  project shelves. It follows no symlinks, skips dependency/system trees, stops at hard ceilings, and returns
  candidates with `grantsChanged:false`. Selecting one grants nothing; the existing separate ADD click remains
  the only durable `path:<canonical-root>` authority transition, with revocation unchanged.
- **7 · Owner-visible idle cleanup:** Docker cells now track live foreground/stdio activity and consult the
  background-process ledger. The persisted minute policy and manual stop control stop only a cell this live
  sidecar probed and whose exact ownership labels still match. Active, unproven, and same-name unowned cells are
  refused; cleanup never deletes the container or its writable layer.
- **8 · SSH backend:** `REMOTE SSH` is a real per-agent execution profile. It uses the OS OpenSSH agent/config,
  strict known-host verification, batch-only auth, bounded probes, remote cwd clamping, and no local-host fallback.
  StarNet stores the destination and remote root, never a password or private key.
- **9 · Non-bind workspace sync:** SSH pushes the local agent workspace before a command and pulls the remote
  workspace back afterward using exact `scp` argv. Sync never deletes either side, reports its real state/error,
  and fails the tool call when outputs cannot be returned. Remote checkpointing is disabled through the backend
  capability flag rather than snapshotting an unrelated local tree.

# DONE 2026-08-07 — SAVED ARTIFACT NATIVE OPEN (`agent/artifact-open-actions`)

Commit `b5854dba` makes a saved file's name open that file through the desktop OS association instead of
opening the jailed preview in the default browser. The folder control now reveals/selects the exact artifact
rather than the default workspace root, and a separate copy-path action preserves the useful clipboard flow.
Plain-browser builds truthfully label the filesystem action `copy path` and copy the resolved absolute path.

The native boundary canonicalizes every requested path, confines relative paths to the owning agent workspace,
allows absolute paths only below the workspace, user home, or a standing `path:<root>` grant, and rejects UNC,
missing, `.env`, `.git`, executable, and script targets before shelling out. Focused frontend contracts are
12/12 green; Rust resolver/security tests are 2/2 green; recap and website-sync suites are green; and
`npm run test:fast` was 573/573 green at the original handoff. A seeded live run wrote
`KaloDataCredentialHandoff.md`, rendered the saved row plus `copy path`, copied the exact per-agent absolute path,
and produced no browser warnings/errors.

Integration was attempted twice from clean trunk snapshot `46b54c10` and rolled back both times under the
mandatory merge ritual. Attempt 1 failed at fast-gate step 150/573 when `boot-security.test.js` exceeded its
9-second sidecar boot ceiling; the same test then passed on clean trunk and three consecutive times on this
branch. Attempt 2 passed `boot-security` and every executed test but the overall fast gate exceeded its
600-second process ceiling after roughly 350/573 steps. The branch's own complete fast gate remains 573/573
green, but trunk is intentionally unmerged because neither integration run produced the required full green
receipt. No installed candidate was built or clicked from an unmerged SHA.

Heartbeat retry 2026-08-07 used current trunk snapshot `f7ecaa40`. The trunk boot preflight passed 16/16,
but the merged candidate failed at fast-gate step 224/574 with nine
`qa-product-perfect-claims.test.js` planning-authority assertions. After rollback, that same test passed
64/64 on unchanged trunk, proving the failure is introduced by the candidate's changed tracked release
surface. `qa/STATUS.md` already documents this authority model: a descendant that changes source-locked
public files requires a W0 claims-ledger re-stamp. The lane therefore needs that reviewed re-stamp before
another merge attempt; retrying unchanged bytes cannot turn this deterministic gate green.

Closure: trunk was synchronized into the lane without rebasing, the reviewed 37-claim inventory was preserved,
and the mechanical W0 surface was re-locked at `9367569c` over 205 files. Focused authority passed 64/64,
the native-open contract passed 12/12, Rust passed 34 tests with one intentional ignore, and both the exact
synced lane and post-merge trunk gates passed 575/575. The branch landed through public-safe merge `4d5356a5`
from snapshot `c683b59e`; the required digest is `223f8c06`. No push or publication occurred.

Installed proof is bound to clean merged candidate `223f8c063de807efea0d6a4e2ab6e753d064ffc5` and installed
executable SHA-256 `b1276cfcec428b0a7e4a798e27a1f4f6326f22c7c4cbf0d961d31115cbbe6a5`.
`qa:smoke:installed` returned GREEN. In that running installed Tauri UI, a disposable agent-workspace artifact
`native-open-proof-223f8c06.md` rendered through the real saved-deliverable callback. One CDP-dispatched left
click on its filename launched Windows Notepad with the exact full path on the process command line and the
window title `native-open-proof-223f8c06.md - Notepad`. The folder control opened Explorer with that exact file
both focused and selected, and copy-path placed the exact 95-character absolute path on the clipboard. The
temporary session, artifact, proof-specific Notepad process, and Explorer window were then removed; the prior
clipboard text was restored.

# IN PROGRESS 2026-08-07 — CONNECTORS & ABILITIES AUDIT (`agent/connector-abilities-audit-0807`)

The ABILITIES console now gives a truthful, announced zero-result state instead of turning into a
blank window and clearing the selected tab; its search is named for abilities rather than only
connectors. Catalog setup filters expose their pressed state, connector/key/extension/Spotify and
Skill Exchange feedback use polite live regions, and the procedure count says skills rather than
colliding with the separate RECIPES product. MCP removal now uses the shared two-click armed
confirmation before deleting the endpoint and its stored credential. The website mirror is synced.

The connector audit also closed three provider-specific authentication defects. RFC 8414 discovery now
handles pathful issuers such as monday.com's `/mcp` issuer. Dynamic registration preserves the protected
client secret and advertised token-endpoint method for confidential clients (currently Supabase and
monday.com), and uses them for both code exchange and refresh after restart. Composio keys now travel in
the provider-required `x-consumer-api-key` header, including verified migration of an already-saved Bearer
token; the catalog and KEYS UI describe that header truthfully instead of calling it a Bearer token.

Live provider proof: all 15 directly sign-in-able OAuth catalog entries completed resource/authorization
server discovery, S256 validation, and dynamic registration; 13 registered public clients and Supabase +
monday.com registered confidential `client_secret_post` clients. Seeded `/oauth/start` flows for both
confidential providers saved their client id, secret, and method in the protected envelope and retained
them after sidecar restart. All 9 no-auth catalog endpoints initialized through the MCP manager (including
their real tool/resource/prompt inventories). All advertised API-key endpoints were reachable and refused
the deliberately invalid probes with authentication responses rather than transport/discovery failures.
No third-party user consent or valid paid-service API key was supplied during this audit, so those
account-specific consent screens and post-auth tool calls remain release-candidate acceptance work.

Live seeded UI proof at `localhost:8897`: all eight sections and six intent routes opened; empty form
validation, catalog filtering, search/Escape, tool inventories, placement deep-link, and native-control
paint were exercised without browser warnings/errors. AWS Knowledge installed as a connected MCP with
5 tools, reloaded, survived restart, required arm + confirm to remove, and stayed removed after a second
restart. A Composio probe saved only the custom header, appeared under KEYS as `HEADER SAVED`, survived a
restart with its value redacted from API output, reported the expected 401 instead of claiming connection,
and was removed afterward. WEB & BROWSER and 1-3-1 Decision Framework switches each survived changed and
restored-state restarts.

Focused connector gates are 764 assertions green; the affected-domain slice is 26/26; `qa:journeys` is
129/129 and the UI-only Beginner Run passed. The post-sync `npm run test:fast` is 573/573 green. Every
one of the 68 HTTP integration files passed during this audit, including
`sidecar.http` (468 assertions) and the live MCP connector E2E (87), but the canonical seven-minute
`npm run test:http` wrapper timed out twice under sustained shared-host CPU pressure before it could run
the whole list in one process. The omitted 12-file tail passed separately (374 assertions).

NOT READY TO MERGE OR RELEASE: the canonical HTTP gate does not have one uninterrupted green receipt;
Guardian did not complete before its ten-minute invocation
ceiling; and installed-exe smoke is truthfully BLOCKED because no exact candidate SHA/artifact was supplied
and no installed candidate was listening on CDP. `qa:ready` must remain NOT READY until those receipts are
green. No production account, valid third-party credential, merge to trunk, push, PR, deployment, or
publication was performed.
