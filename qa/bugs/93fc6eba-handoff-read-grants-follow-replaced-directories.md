---
fingerprint: 93fc6eba
slug: handoff-read-grants-follow-replaced-directories
title: Handoff read grants follow replaced directories into other private files
surface: safecell
severity: P1
status: fixed
found: 2026-11-03
lane: line-job-runner-1103
fix: 961c6dbf0790937c7faf5de7cc82020fca3ace99
origin: audit
---

# Handoff read grants follow replaced directories into other private files

## Symptom

A downstream stage with a read grant for one produced file can read a different agent's private file if the granted file's parent is replaced with a junction before the read. A grant naming a directory can also be accepted as handoff authority. The grant no longer describes the exact produced regular file the job was handed.

## Repro

1. Create separate producer and unrelated-agent directories in a temporary workspace and write one file in each.
2. Mint a handoff read grant from the producer file's canonical path.
3. Rename its parent and replace that parent with a junction to the unrelated directory, keeping the basename the same.
4. Read the granted path through the real pathtrust guard as a downstream agent. The old guard follows the replacement when resolving both the requested path and the grant, then accepts their equality.
5. Run `node test/line-handoff-files.test.js` for the real-filesystem class, including directory, missing-file, replacement-junction, other-job, read-only, project-root and SEND TO cases.

## Evidence

The saved pre-repair `sidecar/pathtrust.js` control failed two guard assertions (directory and replacement junction): RED2/7 in `_logs/codex-overnight-1103/ljr-grant-red.log` under the orchestration log root. The fixed expanded class passed66 assertions, most recently `ljr-final-line-handoff-files-green.log`. The replacement-junction case ran on the Windows host; it was not the older optional file-symlink skip in `test/pathtrust.test.js`.

The repair re-proves that the grant still resolves to its original canonical name and is a regular file before matching the requested real path. It does not grant directory traversal or write authority. Family invariant: I3, exact read-only produced-file handoffs, in `test/line-handoff-files.test.js`.

## Verdict

Fixed by `961c6dbf0790937c7faf5de7cc82020fca3ace99`: resolving the grant again is insufficient unless it still names its original canonical regular file. The saved old-source control failed and the repaired real-filesystem class passed, including the replacement junction on this Windows host. No aggregate release verdict is claimed here.
