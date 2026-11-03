---
fingerprint: 421f90e6
slug: tool-descriptions-name-another-platform
title: Tool descriptions name another platform's OS and shell
surface: safecell
severity: P2
status: claimed
found: 2026-10-17
lane: agent/safe-egress-module-1103
fix:
origin: customer
report: https://github.com/androoAGI/starnet/issues/128
affected: StarNet hosts on macOS and Linux (tool descriptions are the same bytes on every host)
family: platform-description-truth
installer: unverified
recovery: unconfirmed
---

# Tool descriptions name another platform's OS and shell

## Symptom

On a Linux host, shell.exec's description told the model to use Windows and PowerShell forms, so agents tried PowerShell first, and the runtime block did not say which OS or shell the agent actually had (GitHub issue #128). The same family is still live in two other host-shared descriptions: computer.use advertises "PHYSICAL mouse/keyboard/screen control on the Windows desktop" and browser.test_navigate says its locks "never reach Windows", both false on macOS and Linux.

## Repro

1. On any host, from the repo root (catalog.buildCatalog takes no platform at 0b8441064):

   ```sh
   node -e "const c = require('./sidecar/tools/catalog.js').buildCatalog(); for (const t of c.list()) if (/computer\.use|browser\.test_navigate/.test(t.name)) console.log(t.name, t.description)"
   ```

2. computer.use prints "PHYSICAL mouse/keyboard/screen control on the Windows desktop" and browser.test_navigate says its locks never reach Windows, whatever the host is; a macOS or Linux station sends exactly these bytes to its model.
3. For the shell part, check a tree before 506750d09: sidecar/tools/builtin/shell.js's description hard-coded Windows/PowerShell guidance on every host.

## Evidence

- shell.exec: fixed by 506750d09 (2026-10-17): the description names no shell, and the [RUNTIME] block's Shell line names the one that actually runs (cmd.exe, /bin/sh, or sh in Docker or over SSH); `test/runtimeinfo.test.js` covers the line. First tag v0.14.0 by `git merge-base --is-ancestor` (v0.13.5 does not contain it).
- Still open at 0b8441064 and at this lane's S3 tip: sidecar/tools/builtin/computer.js:221, registered on every platform with an inert driver off Windows, says `PHYSICAL mouse/keyboard/screen control on the Windows desktop. Available under host-minted Full Power or to a locally paired Telegram owner; restricted runs remain synthetic-only.` and sidecar/tools/builtin/browser.js:4059 ends browser.test_navigate's description with `Physical pointer/keyboard locks are emulated inside the page, so they never reach Windows.', { type: 'object'`. Probed during planning with buildCatalog() (C:/Users/andro/gen-trees/_logs/lanes-1103/safe-egress-module-plan.json redProofs.platformText).
- Claimed by the safe-egress lane's step S4 (agent/safe-egress-module-1103): runtimeinfo.hostFacts(platform) feeds both phrases, escapesWorkspace becomes a rule table that generates shell.exec's refused-forms clause, and catalog.buildCatalog({ platform }) threads the platform, with Windows bytes unchanged. Its invariant is `test/tool-description.platform-snapshot.test.js` (to land with S4).

## Verdict

_Filled in when the bug leaves the backlog: what was true, and why it is closed._

## Regression



## Sibling coverage


