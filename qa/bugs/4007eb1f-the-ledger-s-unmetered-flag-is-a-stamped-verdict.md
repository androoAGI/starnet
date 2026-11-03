---
fingerprint: 4007eb1f
slug: the-ledger-s-unmetered-flag-is-a-stamped-verdict
title: The ledger's `unmetered` flag is a stamped verdict with zero readers — every ledger USD aggregate (/api/budget, day/global caps) counts subscription dollars tha
surface: providers
severity: P2
status: fixed
found: 2026-07-28
lane: sweep/providers
fix: fdbb12a2
---

# The ledger's `unmetered` flag is a stamped verdict with zero readers — every ledger USD aggregate (/api/budget, day/global caps) counts subscription dollars tha

## Symptom

On a Grok-OAuth / Kimi / ollama-behind-a-proxy station, the same run reads two different amounts depending on which surface you look at: the RUNS recap says "subscription" and /api/insights says $0.00 with spendLabel "subscription / unmetered", while /api/budget's spentToday + lifetime and the budget governor's day/global pools count the full provider-reported figure. Worse, that phantom spend then BLOCKS a later real (BYOK) run with reason 'budget' and a "CAP HIT" HUD note naming money the Commander never spent.

## Repro

Read-only, against the real modules: `makeCostEngine({priceOf:()=>null}).reconcile({prompt_tokens:40000, completion_tokens:2000, cost_in_usd_ticks:4.2e9}, 'grok-4')` → `{usd:0.42, costSource:'provider'}`. Record it: `L.record({runId:'r-grok', agentId:'hero', usd:0.42, tokens:42000, model:'grok-4', unmetered:true})`. Then `L.totalUsd()` = 0.42 and `L.usdForDay(now)` = 0.42 (what /api/budget prints), while `foldInsights([{...unmetered:true, usd:0.42}])` returns `totalUsd: 0` with `spendLabel:'subscription / unmetered'`. With `makeBudget({caps:{day:0.30}, ledger:L})`, a LATER metered run's `check()` returns `{scope:'day', usd:0.42, cap:0.3}` — blocked on money never spent.

## Evidence

`sidecar/ledger.js:79`

**Mechanism (read from the code):** index.js:11292 stamps the flag: `ledger.record({ runId, agentId, turns, usd: finalUsd, tokens, model: finalModel, unmetered: providerUnmetered })`, and ledger.js:60 persists `unmetered: !!e.unmetered`. But every aggregate in ledger.js goes through `function sum(pred) { … t += num(rows[i].usd); }` (line 79) — `pred` is only ever a ts/runId/agentId filter, so totalUsd/usdForDay/usdSince/usdForAgent all include unmetered rows. Grepping consumers, NOTHING reads the flag off a ledger row: budget.js:99-100 (`day: ledger.usdForDay(now) + liveTotal`, `global: ledger.totalUsd() + liveTotal`), index.js:6669-6671 (`spentToday`/`lifetime`/`totalUsd`) and index.js:9402-9406 all sum blind. insights.js:39-42 reads it correctly (`const meteredUsd = unmetered ? 0 : usd`) — but off RUNSTORE rows, not the ledger. So the flag on the ledger is a stamped verdict with zero consumers, and the two aggregates diverge. Reachability: codex is safe (codex.js:441 hardcodes `cost: 0` and priceOf returns null), but grok/kimi use the openai-compatible adapter, which yields provider usage RAW (`if (j.usage) yield { type:'usage', usage: j.usage }`, openai-compatible.js:182), and cost.js:31-33 accepts `usage.cost` or xAI's `usage.cost_in_usd_ticks` as authoritative. The `grok` profile (registry.js:69-84, unmetered:true) hits the IDENTICAL `https://api.x.ai/v1` endpoint as the metered `xai` profile (registry.js:213-230), and cost.js's own header cites docs.x.ai cost-tracking for that field. spend.js:49 then short-circuits (`if (o.unmetered || base !== 0 …) return base;`) so the non-zero base is preserved into the ledger row.

**Existing test coverage:** test/ledger.test.js:37-46 is the only unmetered coverage and it records `usd: 0` for the unmetered row, so the interesting case never runs — the totals block at lines 48-55 uses metered rows only. test/insights.test.js covers the runstore side (which is correct). No test compares a ledger aggregate against an insights aggregate for the same row.

**Adversarial verdict (survived refutation):** Structurally confirmed. sidecar/ledger.js:79 `function sum(pred) { … t += num(rows[i].usd); }` is the single aggregator behind totalUsd/usdSince/usdForDay/usdForRun/usdForAgent (:81-90), and `pred` is only ever a ts/runId/agentId filter — the `unmetered: !!e.unmetered` field persisted at :62 has NO reader on the ledger side (grep of sidecar/ confirms every consumer sums blind: budget.js:97-100 `day: ledger.usdForDay(now)+liveTotal`, `global: ledger.totalUsd()+liveTotal`; index.js:6669-6671 spentToday/lifetime/totalUsd). sidecar/insights.js:39-42 `const meteredUsd = unmetered ? 0 : usd` honors it off RUNSTORE rows, so the two surfaces genuinely diverge on the same run. Not deliberate — docs/STARNET_REF_REPLACEMENT_LOOPS.md:75 states the intended contract outright: 'Exclude unmetered rows from metered USD aggregates while still counting runs and tokens.' spend.js:49 `if (o.unmetered || base !== 0 …) return base;` does preserve a non-zero base into the ledger row, and index.js:11292 stamps unmetered:true alongside it. I am DOWNGRADING severity because the user-visible symptom is conditional and unproven on a live wire: an unmetered row can only carry non-zero usd if the provider reports one — cost.js:29-33 accepts usage.cost / cost_in_usd_ticks, but openai-compatible.js:312-317 priceOf returns null unless the /models catalog carries `pricing` (x.ai's does not), and codex.js hardcodes cost 0. So the reachable case is 'x.ai returns cost_in_usd_ticks to a SuperGrok OAuth token', which I could not verify offline. The test gap is real: test/ledger.test.js:37-46 records the unmetered row with `usd: 0`, so the interesting case never runs.

_Found by the `sweep/providers` lane, 2026-07-28. Finder confidence: medium. Severity claimed P1, after refutation P2._

## Verdict

Fixed by fdbb12a2: every metered ledger aggregate filters unmetered rows while count/all preserve the activity record. The real-sidecar regression in e5e4e620 proves /api/budget reports only metered dollars and a subscription row above the day cap does not block runs.

## Notes

2026-11-03, spend-governor S1 (agent/spend-governor-1103): a ledger row can now name its payer. `billingClass` (metered, managed, subscription, local; sidecar/billing-class.js) rides beside `unmetered`, and ledger.js keeps the two in step: a row that names its payer is unmetered exactly when that payer is a sign-in plan or a local model, and the metered folds read the payer's POLICY row first, the legacy flag otherwise. Every run row written from this build carries it, from what the run's attempts really were (a Claude Code run on a subscription login is now booked as a subscription run, not a $0.00 metered one). Rows written before keep their flags and are read exactly as before, and an older build reading the new rows sums the same metered dollars. Pinned by test/billing-class.parity.test.js (its LEDGER part and the run-row golden).
