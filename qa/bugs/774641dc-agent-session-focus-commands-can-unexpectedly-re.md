---
fingerprint: 774641dc
slug: agent-session-focus-commands-can-unexpectedly-re
title: Agent session focus commands can unexpectedly retarget the composer
surface: sessions
severity: P1
status: fixed
found: 2026-09-09
lane: session-switch-investigation-0909
fix: 086a74ba5d499f74d1829978291eeadeb22848f5
origin: customer
report: User-relayed report on 2026-09-09: StarNet randomly changes sessions and the next message goes to the wrong session
affected: Reporter build/platform unknown; reproduced in seeded browser on source 41253b0bd, version 0.11.0
family: session-focus
installer: unverified
recovery: unconfirmed
---

# Agent session focus commands can unexpectedly retarget the composer

## Symptom

A user reports that StarNet changes the selected session while they are not looking, so their next message lands in another conversation. Their build, platform, voice usage, and run logs were not supplied.

## Repro

1. On source 41253b0bd (package version 0.11.0), launch an isolated worktree with SKYNET_DEFAULT_MODEL=replay, SKYNET_PORT=18949 and node dev/seed.js --keep. No provider credentials are needed to inspect frontend routing.
2. Open the seeded station in Chrome and wait for initialization. Create two sessions through Workstreams.create with activate:false. Use App.openWorkstream to select the first.
3. Type an unsent draft in #chat-input.
4. Deliver the frontend handler the same verb used by the model's session.focus tool: await StationCommands.run('proof', 'station.switch_session', {session: secondSessionId}). This explicitly injects the trigger; it does not demonstrate an actual model choosing the tool unprompted.
5. Observe the active session becomes the second without a rail click. Type a follow-up intended for the original session and click #chat-send.
6. Read both Workstreams records: the user turn appears in the second session. Return to the first: its earlier draft is preserved.

## Evidence

Real seeded app, Chrome headless via Playwright; DOM/state round-trip on 2026-09-09:

```json
{
  "before": {"active":"Original session","draft":"Unsent original draft"},
  "after": {"active":"Other session","draft":""},
  "history": {
    "original": [],
    "other": [{"role":"user","content":"Follow-up intended for Original session"}]
  },
  "restoredOriginalDraft": "Unsent original draft"
}
```

The test used a fresh browser context and only the scratch workspace. No real provider request was observed; this proves the selected session and frontend user-turn routing, not model execution or backend delivery. No customer data was accessed.

Trace:
- sidecar/tools/builtin/station.js:88: session.focus is model-callable. Its description says to use it only when asked, but its handler forwards only the session reference.
- sidecar/station-bridge.js:57: emitted payload is id, verb, args. There is no originating stream or user-navigation generation for a stale/background-focus check.
- frontend/app/stationcommands.js:261: station.switch_session unconditionally calls Workstreams.switch and Chat.load for a valid target. The listener passes no originating context to the handler.
- frontend/app/stationcommands.js:240: station.new_session with focus:true is a sibling automatic focus path.
- frontend/app/chat.js:1228: Chat.load repoints activeWs; Channels.setComposeTarget follows the displayed session.
- frontend/app/group-chat.js:142: composerDrafts preserves each session's unsent text. The current defect is unexpected navigation and subsequent input routing, not old draft text being silently copied into another session.
- frontend/app/voice-live.js:576: ensureBoundFocus switches the visible session back to the call's bound session before handleTranscript processes speech. Code-traced, not reproduced with a microphone. It may explain a voice-specific version of the report.

Existing tests pass: node test/station-commands.test.js (128 assertions), node test/station-tools.test.js (63 assertions). They verify successful focus commands and default non-focusing creation, but do not establish that a focus request is still current user navigation intent.

## Verdict

Source-fixed in 086a74ba5d499f74d1829978291eeadeb22848f5; generated website mirror synchronized in 697126681. The confirmed delayed-voice-reply jump is removed. Model focus requests now carry execution-context stream/run identity and require the still-current foreground run, unchanged UI navigation generation, and an empty composer without attachments. Upload-time navigation invalidates a pending submission. Deliberate session clicks and a valid current-run focus request still work.

The reporter's exact run/platform and whether they were using voice remain unknown. This fixes reproduced mechanisms matching the symptom; it does not establish installer delivery or customer recovery. Live voice remains bound to its starting session. Explicit new speech continues to address that bound session; incoming assistant speech no longer navigates.

## Regression

Before: the actual seeded browser callback for a delayed assistant reply changed the selected title from Reading and typing to Voice call and replaced draft for reading session with an empty composer. The callback was exposed for deterministic invocation without altering its logic; no microphone/provider was required. The new test/session-focus-safety.test.js failed on the original callback with expected reading, actual call.

Independent before-fix attachment proof, executing the original submitComposer function from git: after upload completion the sent turn was {session:other,text:origin message}, and the other draft became empty.

After: scripts/qa/session-focus-live.cjs passes in the real seeded app with eight controls: delayed reply leaves selection/draft/binding intact; the subsequent Send records the message only in the selected session; current foreground request succeeds; background focus and focused creation refuse without partial creation; leaving and returning cannot revive old focus; current draft blocks focus; upload navigation sends to neither session and preserves the new draft. Zero browser page errors. Model transport and attachment upload completion are controlled; no paid model or real microphone/installer execution is claimed.

Focused gates: session-focus-safety, station-commands (135 assertions), station-tools (67 assertions), voice-live-ui, and voice-flow passed. Full gates pending; do not infer installer or customer recovery from source tests.

Reproducible live runner: scripts/qa/session-focus-live.cjs. Run against an isolated dev/seed.js --keep instance only, using STARNET_PLAYWRIGHT_MODULE and STARNET_CHROME when the browser runtime is bundled externally. Captured output: qa/evidence/session-focus-0909.json.

## Sibling coverage

{
  "adapters": [
    {
      "target": "shared model session tools across providers",
      "state": "covered",
      "test": "test/station-tools.test.js",
      "scenario": "execution context supplies focus and focused-create provenance; model arguments cannot forge it",
      "gate": "fast"
    },
    {
      "target": "real paid-provider and microphone execution",
      "state": "blocked",
      "reason": "Deterministic tool/voice callback injection was used; no customer credentials or physical microphone were exercised."
    }
  ],
  "entrypoints": [
    {
      "target": "session.focus and focus:true creation",
      "state": "covered",
      "test": "test/station-commands.test.js",
      "scenario": "stale requests refuse before navigation or partial creation; background creation remains available",
      "gate": "fast"
    },
    {
      "target": "delayed assistant speech",
      "state": "covered",
      "test": "test/session-focus-safety.test.js",
      "scenario": "assistant callback preserves selected session and draft",
      "gate": "fast"
    },
    {
      "target": "direct and group composer submissions",
      "state": "covered",
      "test": "test/session-focus-safety.test.js",
      "scenario": "upload-time navigation including leave-and-return cancels stale submissions",
      "gate": "fast"
    }
  ],
  "displays": [
    {
      "target": "logical selected session and composer draft",
      "state": "covered",
      "test": "test/session-focus-safety.test.js",
      "scenario": "speech callback and attachment completion leave the currently displayed draft intact",
      "gate": "fast"
    },
    {
      "target": "installed Windows and macOS shells",
      "state": "blocked",
      "reason": "Live seeded Chrome proof passed; packaged installer and physical macOS testing were not available in this source repair."
    }
  ],
  "lifecycle": [
    {
      "target": "run supersession, completion and user navigation",
      "state": "covered",
      "test": "test/session-focus-safety.test.js",
      "scenario": "run id, busy state and navigation generation reject stale focus while allowing a current foreground run",
      "gate": "fast"
    },
    {
      "target": "installer restart and customer recovery",
      "state": "blocked",
      "reason": "No installed build was replaced and the reporter has not retested; both remain explicitly unverified."
    }
  ]
}
