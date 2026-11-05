---
fingerprint: e25cb44c
slug: learned-context-and-concurrent-housekeeping-wast
title: Learned context and concurrent housekeeping waste provider tokens
surface: providers
severity: P1
status: open
found: 2026-11-03
lane: agent/token-efficiency-1103
fix:
origin: owner
report: owner-token-efficiency-2026-11-03
affected: Installed 0.14.2 and source 01814e440
family: token-efficiency
installer: unverified
recovery: unconfirmed
---

# Learned context and concurrent housekeeping waste provider tokens

## Symptom

The owner reports repeated customer complaints about excessive Claude CLI and other-provider token consumption, driving users away. The repair must preserve model choice, reasoning effort, complete task evidence and output quality. The installed 0.14.2 copy lacks the November 1 efficiency repairs, and the current source still has three independently reproduced waste mechanisms.

## Repro

1. Run test/learned-tail.e2e.test.js with two requests that carry identical history and a changed learned preference. On 01814e440 the stable system prefix matches, but the system tail changes before all conversation history.
2. Run test/aux-cache-policy.test.js against 01814e440. A disposable native Claude housekeeping request marked neverReread still receives two cache-write markers; OpenRouter and managed Claude use the same unnecessary explicit-cache policy.
3. Run the concurrentArm in test/aux-token-ceiling.e2e.test.js against 01814e440. Three foreground completions and delayed fake-CLI usage admit nine automatic passes against a one-token background ceiling.

## Evidence

Before-change live isolated-sidecar output: `anthropic: the WHOLE system stays identical ...` failed; native API disposable-cache assertion failed `2 !== 0`; concurrent ceiling assertions failed `expected 1, got 9` for both calls and ledger rows. After repair, learned-tail live wire checks pass, test/aux-cache-policy.test.js passes all three real adapters with content/model/effort/output parity, and test/aux-token-ceiling.e2e.test.js passes 62 assertions including concurrency, restart, manual actions and exempt local routes. Fake upstreams measure dispatch and request bytes, not billed provider savings or universal model quality.

## Verdict

Implementation prepared in the isolated owning lane. Full source gates, real-model comparison, integration and exact installer acceptance remain separate obligations. No installed/customer recovery claim yet.

## Regression

All learned text now rides the guarded current-turn context; the complete system and earlier conversation remain unchanged across learning updates. Long-history markers, exact file arguments and tool-result evidence are retained. Disposable toolless API calls no longer request cache writes; foreground/tool calls retain caching. Automatic subscription work serializes per route and checks settled spend before dispatch; foreground work remains independent, complete admitted responses are preserved, and a skipped skill review retains its due counter.


## Sibling coverage

{
  "adapters": [
    {"target":"native Claude, OpenRouter and managed Claude cache writes","state":"covered","test":"test/aux-cache-policy.test.js","scenario":"disposable call avoids writes while preserving model, effort, output allowance and all content; tool work still caches","gate":"fast"},
    {"target":"native Claude, OpenRouter and compatible chat learned context","state":"covered","test":"test/learned-tail.e2e.test.js","scenario":"whole-system and old-history stability, full preferences and tool evidence retained","gate":"http"},
    {"target":"Claude CLI subscription background work","state":"covered","test":"test/aux-token-ceiling.e2e.test.js","scenario":"three foreground runs cannot overspend one shared background allowance","gate":"http"},
    {"target":"real provider cache efficiency and model quality","state":"blocked","reason":"Real-model comparison is pending; mock provider assertions do not establish model quality or subscription-quota savings."}
  ],
  "entrypoints": [
    {"target":"interactive runOnce and automatic housekeeping","state":"covered","test":"test/aux-token-ceiling.e2e.test.js","scenario":"foreground remains independent; automatic passes settle before the next admission","gate":"http"},
    {"target":"explicit quest refresh","state":"covered","test":"test/aux-token-ceiling.e2e.test.js","scenario":"manual refresh remains available at the automatic ceiling","gate":"http"}
  ],
  "displays": [{"target":"installed desktop","state":"blocked","reason":"No repaired installer has been built or installed yet."}],
  "lifecycle": [
    {"target":"restart and provider isolation","state":"covered","test":"test/aux-token-ceiling.e2e.test.js","scenario":"ceiling and usage survive restart; another route and local models remain independent","gate":"http"},
    {"target":"queued admission failure and setting changes","state":"covered","test":"test/aux-admission.test.js","scenario":"rejection releases the lane; queued work rechecks current gate","gate":"fast"}
  ]
}

