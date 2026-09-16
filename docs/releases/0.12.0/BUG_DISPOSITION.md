# 0.12.0 user-bug disposition

Baseline `90d6f0111`, refreshed September 16 UTC. The authoritative per-report evidence remains [qa/BUGS.md](../../../qa/BUGS.md) and its linked records. There are 66 classified customer/owner reports in this lane: 59 source-fixed and 7 open; 6 installer-verified, 1 installer-not-applicable, 59 installer-unverified. Recovery: 1 confirmed, 1 last explicitly reported failing, 64 unconfirmed. These counts include older releases; they are not 66 new 0.11.2 defects.

Eight customer/owner records are absent from the public 0.11.2 source tag: four source-fixed and four open. The three remaining open reports are carryovers. An unknown affected version stays unknown.

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
