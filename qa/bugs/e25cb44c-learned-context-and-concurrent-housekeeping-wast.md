---
fingerprint: e25cb44c
slug: learned-context-and-concurrent-housekeeping-wast
title: Learned context and concurrent housekeeping waste provider tokens
surface: providers
severity: P1
status: fixed
found: 2026-11-03
lane: agent/token-efficiency-1103
fix: 2dedb2b8a
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

Fixed in source by lane agent/token-efficiency-1103, merged to trunk at 2dedb2b8a and shipped in 0.15.0: learned text rides the current-turn context so the system prompt and earlier history stay byte-stable, a disposable toolless housekeeping call requests no cache writes, and automatic background work settles its spend before the next admission. Proof on the release tree (agent/release-0150 at 79007c0b5): test/aux-token-ceiling.e2e.test.js OK (70 assertions) three times on a quiet machine (its two earlier reds ran under a heavy parallel review load), test/learned-tail.e2e.test.js OK, test/aux-cache-policy.test.js PASS over the three real adapters with content, model, effort and output parity, and test/aux-admission.test.js PASS. The first three reproduce the waste at 01814e440 (Repro above). Fake upstreams measure dispatch and request bytes, not billed savings or model quality: no real-model comparison ran, and no installed or customer recovery is claimed.

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
