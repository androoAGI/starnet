---
fingerprint: 6dec2aa8
slug: export-cleanup-can-remove-a-file-it-never-create
title: Export cleanup can remove a file it never created
surface: sessions
severity: P1
status: fixed
found: 2026-11-03
lane: agent/truthful-ack-client-1103
fix: 662619da7
origin: audit
report: Truthful ACK S5 source audit at afac909d0 and merged 15dd8ffbe
affected: Existing desktop station export writer, before generalizing it to other exports
family: export-file-ownership
installer: unverified
recovery: unconfirmed
---

# Export cleanup can remove a file it never created

## Symptom

An export can report a write failure while removing an existing file with the proposed export name. The failed export did not create that file.

## Repro

1. Allocate an isolated Downloads directory containing an existing `report.json` with known bytes.
2. Call the real `sidecar/backupfile.js:saveExportFile` through a filesystem fault facade which refuses the exclusive creation with EACCES before any descriptor is acquired, while ordinary reads/unlinks still use the actual allocated filesystem.
3. The original writer catches this non-EEXIST error, calls `dropPartial` without creation proof, and deletes the pre-existing report. Assert the failure receipt and preservation of the original bytes; no live user folder is involved.
4. Also cover a partial write after this call acquired an exclusive descriptor, readback failure, collisions and normal confirmed output. Cleanup of a file this call owns must remain possible, while an unowned destination must survive.

## Evidence

- Source: `sidecar/backupfile.js:saveExportFile`, the non-EEXIST catch calls `dropPartial(f, full)` after `writeFileSync(full, body, { encoding: 'utf8', flag: 'wx' })` throws. No descriptor or successful creation receipt establishes ownership.
- Exact original bytes SHA256 `373816326C51E0AA36FF73962F52E4FA013EBB91F28F9A24BEA5259757093F02`, preserved at `C:/Users/andro/gen-trees/_logs/codex-overnight-1103/truthful-ack-backupfile-exact-original.js.txt`.
- Scope and deterministic control recipe: `C:/Users/andro/gen-trees/_logs/codex-overnight-1103/truthful-ack-next-plan.md`.
- Exact original control: `truthful-ack-export-2148-old.log`, PID 34220, exit 1, 9 intended failures / 24 assertions. It deletes unrelated bytes after four pre-open failures and after destination replacement. Fifteen positive assertions complete without exception.
- Repaired writer: `truthful-ack-export-2148-current.log`, PID 62516, exit 0, all 24 assertions green, including owned partial cleanup, readback refusal, replacement preservation and exclusive suffix collision. Logs and source manifest are under `C:/Users/andro/gen-trees/_logs/codex-overnight-1103/`.
- Root's independent bounded source review found no blocker/major. This evidence does not claim atomic protection against arbitrary concurrent rename between lstat and unlink; installed verification remains unverified.

## Verdict

Fixed in source only: exact original writer control 9/24 failures, repaired writer 24/24 green with allocated real files. Cleanup requires the acquired descriptor identity; no atomic concurrent-rename claim. Installed verification unverified; recovery unconfirmed.
