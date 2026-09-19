---
fingerprint: 2426399e
slug: reopened-conversations-send-before-history-is-re
title: Reopened conversations send before history is restored and hide late messages
surface: sessions
severity: P1
status: open
found: 2026-09-19
lane: session-reliability-0919
fix:
origin: owner
report: Owner requested systemic investigation of disappearing conversations and forgotten context on 2026-09-19
affected: Reproduced seeded Chrome on 8e182efaf; reporter build unknown
family: session-continuity
installer: unverified
recovery: unconfirmed
---

# Reopened conversations send before history is restored and hide late messages

## Symptom

Reopening a conversation can leave newer messages invisible. Sending immediately can ask the model a follow-up without the latest conversation context, even though those messages subsequently appear in the saved thread. This reproduces mechanisms matching the owner's reports; it does not establish the original customers' exact causes.

## Repro

Run `node test/session-reliability.e2e.test.js` in an isolated worktree. The runner boots the real seeded app, opens A with two local turns, delays its transcript response until the initial scroll pin finishes, and supplies two additional durable turns. Reopen A, send a follow-up before another delayed response supplies a changed destination, then inspect the displayed thread and outgoing `/api/run` messages. Inference is simulated at the browser fetch boundary; persistence and sidecar restart are real.

## Evidence

On trunk 8e182efaf, the live runner recorded `delayedVisible:false`, `beforeHistoryReady:1`, `modelContext:false`, `promptLast:true`, `saved:true`. The restored messages survived restart, demonstrating that this instance was a display/admission race rather than a disk deletion. Baseline receipt: `qa/evidence/session-reliability-0919/baseline.json`. Regression anchors: `test/session-continuity.test.js`, `test/session-reliability.e2e.test.js`.

## Verdict

History rendering incorrectly used the short-lived scroll-pin token as its async load owner. Sending did not await restoration. Per-session read ownership now rejects obsolete results, load generation controls rendering, and inference waits for confirmed history. Unavailable history preserves the admitted turn and offers retry without dispatch. Page-local diagnostic events omit conversation content and titles. Full validation is recorded separately; installer and affected-customer recovery remain unverified.

## Regression

Baseline live failure above. After repair, delayed messages render without another switch and the follow-up request includes the recovered destination. Registered coverage includes 48 controlled lifecycle sequences across desktop/website sources and a combined browser journey: delayed restore, send/switch, background delivery during typing, unavailable history, one explicit retry, stream interruption, failed durable write, acknowledged retry, cache loss and process restart. Tests use controlled upstream transport; no paid model or installed native shell is claimed.


## Sibling coverage

{
  "adapters": [
    {"target":"provider-independent browser request","state":"covered","test":"test/session-reliability.e2e.test.js","scenario":"outgoing request contains recovered context before the newest directive","gate":"fast"},
    {"target":"external provider accounts and model compaction semantics","state":"blocked","reason":"This campaign controls the inference transport; existing provider journeys remain required but do not prove every model context horizon."}
  ],
  "entrypoints": [
    {"target":"direct send and explicit retry","state":"covered","test":"test/session-reliability.e2e.test.js","scenario":"pending history gates dispatch; retry preserves one user turn and sends once","gate":"fast"},
    {"target":"group conversations","state":"covered","test":"test/group-sessions.http.test.js","scenario":"existing backend-owned group message API regression remains separate from direct-session restoration","gate":"http"},
    {"target":"voice and upload navigation","state":"covered","test":"test/session-focus-safety.test.js","scenario":"existing delayed voice and upload origin protections remain required","gate":"fast"}
  ],
  "displays": [
    {"target":"desktop and website JavaScript","state":"covered","test":"test/session-continuity.test.js","scenario":"late render, wrong-focus suppression and diagnostics privacy on both copies","gate":"fast"},
    {"target":"Windows/macOS native renderer","state":"blocked","reason":"Local live proof is seeded Chromium. Windows installed-bundle Chrome acceptance is wired for the next candidate; native WebView and physical macOS behavior still require artifact-level proof."}
  ],
  "lifecycle": [
    {"target":"overlapping loads, removal and in-flight clear","state":"covered","test":"test/session-continuity.test.js","scenario":"stale reads cannot save or repaint removed or cleared state; waiting send follows newer read","gate":"fast"},
    {"target":"failure, save and restart","state":"covered","test":"test/session-reliability.e2e.test.js","scenario":"failed save retains cache; confirmed save restores conversation after cache loss and sidecar restart","gate":"fast"},
    {"target":"public upgrade and customer recovery","state":"blocked","reason":"No installer was rebuilt or published in this source lane and affected customers have not retested."}
  ]
}
