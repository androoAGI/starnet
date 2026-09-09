---
fingerprint: 774641dc
slug: agent-session-focus-commands-can-unexpectedly-re
title: Agent session focus commands can unexpectedly retarget the composer
surface: sessions
severity: P1
status: open
found: 2026-09-09
lane: session-switch-investigation-0909
fix:
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

Open. A concrete unsolicited-navigation mechanism is reproduced; its correlation with this reporter's incident is unconfirmed. No product code changed, no fix merged, no installer/reporter recovery claimed.

Recommended repair direction: carry origin and navigation-generation context across model-driven focus requests and reject stale/background navigation; voice delivery should target the call's bound session independently of the visible composer. Preserve explicit user navigation and per-session drafts. Verify with delayed commands after a user switches sessions, focused creates, voice input while browsing, and typing/attachment sends during a switch.

## Regression

Investigation only. Live pre-fix frontend routing evidence is above. Full test:fast, test:http, customer journeys, installer testing and backend message execution were not run or claimed; the two existing focused suites passed. A repair needs a failing regression plus the normal gates.

## Sibling coverage

Investigation scope, not a closure claim:
- Adapters: model session.focus traced to frontend; focus:true creation code-traced; provider-specific execution untested.
- Entrypoints: injected station.switch_session reproduced; real model tool choice and microphone-driven voice path untested.
- Displays: seeded Chrome UI reproduced; installed Windows and macOS shells untested.
- Lifecycle: draft survives switching away and back; delayed commands, multiple pages, restart and attachment-in-flight races remain untested.