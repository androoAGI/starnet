---
fingerprint: 6cd531b1
slug: desktop-slash-aliases-and-client-only-commands-t
title: Desktop slash aliases and client-only commands typed on Telegram (/routines, /reset, /version, /q) fall through to a paid model run
surface: channels
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/channels
fix: d3eda4f3b
origin: audit
---

# Desktop slash aliases and client-only commands typed on Telegram (/routines, /reset, /version, /q) fall through to a paid model run

## Symptom

Desktop palette aliases and client-only commands typed on Telegram are not recognised and are sent to the model as ordinary text: "/routines" (alias of /routine), "/reset" (alias of /new), "/tasks", "/buildaway", "/version", "/q", "/retry". Each costs a paid model run whose answer is the model guessing what the command means, instead of the command's own answer (or "That command only works in the StarNet desktop app.").

## Repro

Booted sidecar :9721, mock Telegram + scripted mock OpenRouter, owner DM 4242.
1. Send "/routines".
2. Send "/version".

## Evidence

- Mock capture: `=== /routines >> "ACK[/routines]" LLM-RUN "/routines"` and `=== /version >> "ACK[/version]" LLM-RUN "/version"` (the mock's default model reply), while "/routine" from the same chat answered "Routines (1)\n1. check the morning news …" with no model call.
- Drift: `sidecar/slash.js` declares `routine` with `aliases: ['routines']`, `away` with `['build-away','buildaway']`, `new` with `['reset']`, `agents` with `['tasks']`; the hub's own table (`COMMANDS` / `parseCommand` in sidecar/channels/hub.js) knows only canonical names, and `runSlashForChannel` (which already answers client-only commands with "That command only works in the StarNet desktop app.") is reached only for the four `slash:true` names.
- Fix sketch: map the registry aliases onto hub commands inside parseCommand (so the owner gate still applies), and answer any other registry-known head through runSlash's client refusal instead of a model run.

## Verdict

Fixed in `d3eda4f3b` (2026-10-23; an ancestor of trunk, first released in v0.14.0). The hub maps the shared registry's aliases (/routines, /reset, /tasks, /buildaway) onto its own commands under the same owner gate, and hands every other registry built-in (/version, /v, /retry) to the registry, so each answers for free instead of becoming a paid model run. `bbfe3b4af` then gave the note commands (/steer, /q, /btw) their desktop meaning: the words after them go to the running task, a bare one explains itself, and the command word itself never reaches the model. Regression: test/channels.desktop-commands.test.js (passes on this tree). Reconciled 2026-10-27 (reliability wave 1, quick win 37).
