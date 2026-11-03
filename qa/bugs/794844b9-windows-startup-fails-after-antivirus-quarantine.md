---
fingerprint: 794844b9
slug: windows-startup-fails-after-antivirus-quarantine
title: Windows startup fails after antivirus quarantines shell.js
surface: release
severity: P2
status: open
found: 2026-11-03
lane: installed-integrity-and-engine-floor-1103
fix:
origin: customer
report: support-antivirus-quarantine-intake
affected: Windows 11, reported StarNet 0.12.4; affected installed bytes and recovery unverified
family: packaged-backend-integrity
installer: unverified
recovery: unconfirmed
---

# Windows startup fails after antivirus quarantines shell.js

## Symptom

The customer reports that startup fails after RAV quarantines the installed shell.js module. This is a reported installation change; the affected machine and its complete sanitized exception stack have not been independently inspected.

## Repro

The reported sequence is an installed Windows launch after antivirus quarantine. The original affected machine is unavailable. The diagnostic family is exercised with real disposable resource trees by test/native-install-manifest: remove or empty each listed file, and remove or replace the entire sidecar folder. The native verifier must name the damaged paths and retain normal startup behavior. This is a diagnostic proof, not an antivirus product or affected-installer reproduction.

## Evidence

The stopped lane's sanitized intake identified a Windows 11 / 0.12.4 antivirus quarantine of shell.js. Source mitigation 6b4c22ff0 embeds a resource-map-derived manifest and names missing, empty, wrong-size and changed-content files. Review repair 61560264b also finds an installed resource root when the sidecar folder itself is gone; the original root lookup failed that class before the repair. All ten native class tests, test/install-manifest.test.js (96), and test/installed-integrity-proofs.test.js (46) passed during the continuation. The latter exercises the acceptance scripts with a fake executable; it does not certify a real installer.

## Verdict

Open pending affected-installer and customer recovery acceptance. The source can now name the damaged file and the restore/reinstall exit. It does not prevent an antivirus quarantine, restore files, establish a false-positive verdict, or prove the original customer's recovery. Installer unverified; recovery unconfirmed.
