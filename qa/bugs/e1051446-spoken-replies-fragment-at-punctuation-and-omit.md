---
fingerprint: e1051446
slug: spoken-replies-fragment-at-punctuation-and-omit
title: Spoken replies fragment at punctuation and omit failed audio chunks
surface: voice
severity: P1
status: open
found: 2026-09-09
lane: agent/voice-continuity-0909
fix:
origin: customer
report: Owner-relayed customer report in task on 2026-09-09
affected: Build and platform unknown
family: voice-continuity
installer: unverified
recovery: unconfirmed
---

# Spoken replies fragment at punctuation and omit failed audio chunks

## Symptom

Customer reports awkward punctuation pauses and occasional missing sentence endings. Prefers a longer initial wait for complete speech.

## Repro

Enable spoken replies; stream "Hello, " followed by the remainder of a sentence. Inject transient synthesis or media playback errors. In Local Live, feed three loud 2048-sample microphone frames during playback at 48 kHz.

## Evidence

Baseline ed768880a: executing frontend/app/chat.js:8236 emitted "Hello, " alone. frontend/app/voice.js advanced after failed audio. test/voice.button.test.js and test/voice-flow.test.js now exercise ordered recovery, exhaustion, timer buffering and measured microphone activity. Execution receipt will be added after live and full-gate proof.

## Verdict

Source repair in progress. Affected installer and customer acoustic recovery remain unverified.

## Regression

Before: extracted production closure sent "Hello, " alone; decode failure skipped requested text. After: test/voice-flow.test.js buffers comma fragments through sentence completion and flushes a substantial clause after 1200 ms; test/voice.button.test.js preserves ordering through recovery and reports exhaustion. Live seeded runtime at :19298/:19299 emitted zero opening-fragment requests, then exactly one full-sentence request; transient retry retained the identical sentence, exhaustion stopped after three attempts, invalid audio produced a playback-specific notice after two attempts. Synthetic transport/audio injection validates runtime control flow, not natural speech quality or physical echo.

## Sibling coverage

{
  "adapters": [
    {
      "target": "cloud and keyless local TTS",
      "state": "covered",
      "test": "test/voice.button.test.js",
      "scenario": "keyless transient retry, terminal credentials, engine identity and ordered playback recovery",
      "gate": "fast"
    },
    {
      "target": "native realtime provider audio",
      "state": "blocked",
      "reason": "Native provider semantic VAD is preserved and separately logged; real provider acoustic acceptance requires a live account and hardware."
    }
  ],
  "entrypoints": [
    {
      "target": "streamed COMMS and direct speech",
      "state": "covered",
      "test": "test/voice-flow.test.js",
      "scenario": "production sentence closure buffers comma fragments, deadline flush, final tail and ownership loss",
      "gate": "fast"
    },
    {
      "target": "Local Live",
      "state": "covered",
      "test": "test/voice-flow.test.js",
      "scenario": "short noise bursts at 48 kHz do not stop playback; sustained activity logs measured onset",
      "gate": "fast"
    },
    {
      "target": "one-shot and per-agent speech",
      "state": "covered",
      "test": "test/voice.button.test.js",
      "scenario": "long opening sentence is not split again and local speaker identity remains pinned",
      "gate": "fast"
    }
  ],
  "displays": [
    {
      "target": "speaker notice and Live Voice error",
      "state": "covered",
      "test": "test/voice.button.test.js",
      "scenario": "exhaustion is immediately surfaced and preserved on speaker tooltip",
      "gate": "fast"
    },
    {
      "target": "affected installed desktop and physical speakers",
      "state": "blocked",
      "reason": "Build/platform unknown. Real echo/noise recordings and affected installer retest remain required; no customer recovery claim."
    }
  ],
  "lifecycle": [
    {
      "target": "cancellation and late results",
      "state": "covered",
      "test": "test/voice.button.test.js",
      "scenario": "cancelled producer token cannot restart failed reply; ordered retry releases audio resources",
      "gate": "fast"
    },
    {
      "target": "stream completion and focus loss",
      "state": "covered",
      "test": "test/voice-flow.test.js",
      "scenario": "timer cleanup and ownership checks preserve final tail without late output",
      "gate": "fast"
    }
  ]
}
