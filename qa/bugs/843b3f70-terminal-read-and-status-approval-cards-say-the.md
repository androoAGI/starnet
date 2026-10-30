---
fingerprint: 843b3f70
slug: terminal-read-and-status-approval-cards-say-the
title: Terminal read and status approval cards say the agent wants to run a command
surface: safecell
severity: P2
status: fixed
found: 2026-10-30
lane: authority-census-1030
fix: 90cea89f8
origin: audit
---

# Terminal read and status approval cards say the agent wants to run a command

## Symptom

An approval card for reading a terminal session's output, or checking its status, tells the Commander the agent wants to "run a command". The phone's lock-screen push says "wants to run a command" for every shell or terminal tool, including typing into a process. Reading output cannot run anything, so the card describes a power the call does not have.

## Repro

1. In ASK mode, have a run reach an approval card for terminal.read or terminal.status (for example under the release lane's per-call read confirmation, or any read that prompts).
2. Read the desktop COMMS card: "run a command".
3. With a paired phone, let the card go unanswered past the grace period: the push reads "wants to run a command".
`test/process-operation-copy.test.js` runs the real desktop and phone classifiers on every shell/terminal operation.

## Evidence

Source: `frontend/app/chat.js` actionPhrase said `typed ? 'type into a running process' : 'run a command'` for every shell/terminal name, and `sidecar/index.js` remoteAskWords returned 'wants to run a command' for the whole family (a5-consent-copy-and-broker-map.json, A5-F3). Live walk W-A1-a / W-A1-b terminal_read cards (walk-evidence-0142, runs 5fe29d2b-07c0-41f4-b36c-f17e4ade18ab and b6f7c8e7-906d-45f1-92a6-bf997f3dbe20). On 748b0462595 `test/process-operation-copy.test.js` fails 50 assertions.

## Verdict

Fixed in 90cea89f8 (authority-census lane). One verb table, the same on the desk (chat.js processOperation) and the phone (remoteAskWords): run a command only for shell.exec and terminal.start; type into, read output from, check the status of, wait for, interrupt, stop, resize. A read card names the session it reads. Typed input never reaches a lock screen. Only the wording changed: which calls ask, and what an answer grants, are untouched. The website mirror is synced.
