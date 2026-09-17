---
fingerprint: ff3fb4cb
slug: mac-unsupported-installation-uncorrelated
title: Mac installer reports application unsupported on the computer
surface: release
severity: P2
status: open
found: 2026-09-16
lane: release-0120-prep-0915
fix:
origin: customer
report: support-2026-09-13-mac-unsupported-application
affected: Mac; application asset, CPU architecture, macOS version and exact StarNet version not supplied
family: mac-install-compatibility
installer: unverified
recovery: unconfirmed
---

# Mac installer reports application unsupported on the computer

## Symptom

The customer cannot open StarNet because macOS reports that the application is not supported on this Mac.

## Repro

Open the downloaded application on the affected Mac. Record CPU architecture, macOS version, exact downloaded filename and application version before distinguishing wrong-architecture selection from an OS compatibility failure.

## Evidence

Private September 13 installation report refreshed September 16. No exact-machine reproduction or architecture was supplied in the message. Anchors: src-tauri/tauri.conf.json and test/release-train-macos-trust.test.js. Release 0.12.0 prepares separate Apple Silicon and Intel assets; its Intel installed acceptance is useful platform evidence but cannot establish recovery on this unidentified Mac.

## Verdict

Open P2 pending the actual platform and asset identity. Do not label it fixed solely because both architecture builds exist. No customer reply or machine change was performed during the release audit.
