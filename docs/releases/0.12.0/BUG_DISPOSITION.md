# 0.12.0 user-bug disposition

Baseline `90d6f0111`, refreshed September 16 UTC. The authoritative per-report evidence remains [qa/BUGS.md](../../../qa/BUGS.md) and its linked records. There are 66 classified customer/owner reports in this lane: 59 source-fixed and 7 open; 6 installer-verified, 1 installer-not-applicable, 59 installer-unverified. Recovery: 1 confirmed, 1 last explicitly reported failing, 64 unconfirmed. These counts include older releases; they are not 66 new 0.11.2 defects.

Eight customer/owner records are absent from the public 0.11.2 source tag: four source-fixed and four open. The three remaining open reports are carryovers. An unknown affected version stays unknown.

Follow-through intake adds #18 / `09f0e9fa`, source-fixed by `da0658486`: interactive replies in scheduled conversations were incorrectly classified by their conversation prefix. Actual routine → interactive reply → rating → restart now passes. Earlier replies without saved origin remain explicitly unverified for rating. The register now contains 67 customer/owner reports, 60 source-fixed and 7 open; `scope.json` retains the initial snapshot. See [FOLLOWTHROUGH.md](FOLLOWTHROUGH.md) for fresh receipts and the Telegram briefing repair (`887210a7b`), which does not close the original missing-tool investigation.

## Open reports

| Record / report | Current evidence | Next concrete acceptance | Suggested routing |
| --- | --- | --- | --- |
| `acb47320` — idle/unexplained usage | Historical report; no affected run ledger. Prior canary idle and cost reconciliation passed on a different station. | Correlate affected account/run costs with armed routines, loops, night shift and provider receipts. Do not label this a proven billing defect. | Reliability/provider investigation |
| `fd9c4b4d` — managed Sonnet 400 | Historical v0.10.13 failure; later diagnostics concern Ollama/model selection. A positive reply is not a successful managed-run receipt. | Reproduce or correlate the exact request/model/error body with the deployed route, then verify retry and restart. Do not present the old 400 as newly reproduced on 0.11.2. | Provider/gateway investigation |
| `2f156837` — Mac shared catalog boot failure | Origin and installer version unknown; Windows catalog proof does not establish Mac recovery. | Obtain full page/resource origin and startup log; verify native Mac/WebKit script load on the affected path and candidate. | Desktop/Mac acceptance |
| `305a9e3d` — campaign cards undiscoverable | `dcbc2b941`, integrated by `a7ae9f23e`, repairs proven JS/ARIA/shadow card patterns. Exact authenticated customer page unknown. | Exercise affected campaign DOM/model or document the exact remaining uncertainty; run real find → click → details → saved output and installer acceptance. | Browser/customer workflow |
| `99a1517b` — unlink leaves no link control | `02332ee85`, integrated by `90d6f0111`, repairs proven silent native/HTTP/read failures. Original machine not correlated. | Candidate native unlink failure, retry, successful account switch, delayed response and restart; capture original failing build/platform if available. | Account recovery |
| `98454b83` — [GitHub #14](https://github.com/androoAGI/starnet/issues/14), Telegram delegation | Public issue closed without a comment or linked commit. Existing owner-DM test advertises delegation; actual failure unknown. | Same lead/task through COMMS and Telegram: inspect classification, binding, actual wire tools, dispatch and returned specialist result; repeat after restart. | Channel/delegation |
| `a76b93c4` — [GitHub #17](https://github.com/androoAGI/starnet/issues/17), slow local-model small talk | `5acf4640f` removes task-only greeting context and bounds Ollama output. Fast/HTTP prompt regressions pass; actual latency/verbosity not established. | llama3.2:3b timing and output length for greeting/task, fresh/long history, specialist and concurrent research; compare installed behavior. A 4096-token ceiling is not a short-reply guarantee. | Local model/COMMS |

The two newly imported reports increase tracked blockers; they do not represent newly reproduced regressions. Do not close reports merely because an adjacent fix exists or a public issue is closed. Engineering before/after proof can establish a source fix; installed and customer recovery columns require their own evidence.

## New records with source fixes already on trunk

| Record | Source fix | Candidate installer acceptance |
| --- | --- | --- |
| `26433ecb` — curved-world pointer targets | `f8b60bef0` | Hover/click/double-click/drag at center and edges, multiple zoom/curve settings, after restart |
| `32f959e0` — DEV mistaken for OpenAI credential during wake | `0250793ac` | Fresh managed/BYOK/OAuth setup, reload/relink, truthful missing-credential recovery |
| `6ad254f9` — frozen/missed XP | `05a399cf0` | Keep dossier open while rating; second-window rating; skipped-rating recovery; persistence and no duplicate XP |
| `6c91f5d9` — enlarged secondary panels | `0054a3d7a` | Long provider text, dropdown affordances, keyboard/focus, enlarged scale and narrow viewport |

All four remain installer-unverified. The older source-fixed/unverified records also remain delivery debt: run the full customer journey campaign and relevant affected-platform/adapter cases; do not automatically stamp every old report from one smoke test. `scope.json` preserves the full set for filtering by family and installer state.

## QA findings alongside customer reports

The canonical ledger's two P1s are `9dc2a1df` (zoned body outside containment) and `a558b4db` (file capability / placed prop mismatch). The latest audited baseline also failed the summon gaze assertion. Reproduce against the combined world and capability model, compare actual state, and attach a fix or evidence-backed false-positive disposition. Approved artwork alone is insufficient to retire a behavioral finding.

## Intake refresh before freeze

Read all GitHub issues updated since the public 0.11.2 publication, including closed issues; deduplicate support-email copies by symptom. Import new reports with origin, affected artifact, evidence, adapter/entry/display/lifecycle gaps. Capture a timestamped sanitized intake receipt. Private support mail has not been freshly searched in this preparation session; this remains explicit intake work.

## 2026-09-16 dispositions on the integrated 0.12.0 candidate (agent/release-0120-final-0916)

Applied under the owner engineering-acceptance rule of 2026-09-11 (source-proven records close on our own before/after proof; uncorrelated reports stay tracked, never fabricated). Register validated; generated index regenerated.

| Record | Disposition | Proof |
| --- | --- | --- |
| `99a1517b` unlink hides recovery controls | **fixed** — `02332ee85` (integrated `90d6f0111`) | `test/credits-store-recovery.test.js`; seeded unlink → LINK STATION → pairing verified in the lane; customer machine uncorrelated |
| `305a9e3d` campaign cards undiscoverable | **fixed** — `dcbc2b941` (integrated `a7ae9f23e`) | 105-assertion real-Chromium gauntlet in the HTTP gate; authenticated Whop page remains an explicit gap |
| `98454b83` #14 Telegram lead delegation | **fixed** — `887210a7b` | 82-assertion desktop + Telegram dispatch parity through a real sidecar, including restart |
| `a76b93c4` #17 local-model small talk | **fixed** — `5acf4640f` | prompt-diet unit + sidecar regressions (7 + 23 assertions); no real llama3.2:3b timing (Ollama is not installed on the build host) |
| `09f0e9fa` #18 rating in scheduled conversations | **fixed** — `da0658486` | 57-assertion routine → interactive reply → rating → restart campaign; live seeded rating control |
| `2f156837` Mac boot guard shared catalog | **fixed** — `788578969` (hardening) | BootGuard retries the sidecar-served catalog with backoff and reloads once after a proven load; 82 vm assertions + live CDP proof (first request refused → retry → reload → 35 builtins, no banner; all refused → banner after 5 retries). Original Mac origin/build still uncorrelated |
| `acb47320` idle / unexplained usage | **open, re-triaged P2** | no affected run ledger or provider receipts were ever supplied; no reproducible defect on the candidate |
| `fd9c4b4d` managed Sonnet 400 (v0.10.13) | **open, re-triaged P2** | historical, gateway diagnostic gap repaired and redeployed 2026-09-06, reporter replied positively 2026-09-10; needs a fresh sanitized correlation |

New customer concern folded into this candidate without a prior record: the 2026-09-14 hotspot-user report item 4 (“can't send clickable files anymore, sends a text path”) — the ▤ saved / ▤ made rows were live-only; `8d4f3f5ca` replays them on history render (source lock `test/comms-deliverable-replay.test.js`, live CDP reload proof). Items 2–3 of that report were the transcript-scramble bug already merged in `f1bae44d9`; item 1 (a 10 s connect ceiling) has no source in any shipped build (default 30 s) and remains a question for the reporter (version + provider + any `SKYNET_PROVIDER_CONNECT_MS` override).
