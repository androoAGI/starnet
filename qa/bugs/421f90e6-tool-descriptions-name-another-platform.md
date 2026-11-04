---
fingerprint: 421f90e6
slug: tool-descriptions-name-another-platform
title: Tool descriptions name another platform's OS and shell
surface: safecell
severity: P2
status: fixed
found: 2026-10-17
lane: agent/safe-egress-module-1103
fix: 448c99d2a
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
- Open at 0b8441064 and through this lane's S3 tip: sidecar/tools/builtin/computer.js:221, registered on every platform with an inert driver off Windows, said `PHYSICAL mouse/keyboard/screen control on the Windows desktop. Available under host-minted Full Power or to a locally paired Telegram owner; restricted runs remain synthetic-only.` and sidecar/tools/builtin/browser.js:4059 ended browser.test_navigate's description with `Physical pointer/keyboard locks are emulated inside the page, so they never reach Windows.', { type: 'object'`. Probed during planning with buildCatalog() (C:/Users/andro/gen-trees/_logs/lanes-1103/safe-egress-module-plan.json redProofs.platformText).
- Fixed by 448c99d2a (safe-egress lane step S4, agent/safe-egress-module-1103). `hostFacts(platform)` in sidecar/runtimeinfo.js, next to shellLine, is the one table of platform phrases ({ os, desktop, desktopShort } for win32, darwin and linux; neutral words for any other platform). computer.use states `facts.desktop` and browser.test_navigate `facts.desktopShort` for the platform their factory was built for (deps.platform, default process.platform). sidecar/tools/catalog.js `buildCatalog({ platform })` declares the catalogue for any platform. shell.js's escapesWorkspace is one rule table, `FLOOR_RULES`, and shell.exec's refused-forms clause (`FLOOR_FORMS`) is joined from its rows, so that description cannot drift from the floor either. Its invariant is `test/tool-description.platform-snapshot.test.js` (fast).
- Windows bytes did not move: the whole declared win32 tool wire (143 tools, 118,272 bytes) hashes the same at 0b8441064 and 448c99d2a, so the cached tool prefix and `test/payload.budget.test.js` hold. darwin is 4 bytes shorter and linux 2 longer, in these two descriptions only.

## Verdict

Fixed in source. The shell part was fixed by 506750d09, first in v0.14.0. computer.use and browser.test_navigate were fixed by 448c99d2a on agent/safe-egress-module-1103, which is in no tag yet (local trunk is not shipped). Every host-shared description now takes its platform words from runtimeinfo.hostFacts for the platform it is built for. The snapshot test holds every declared tool to that on win32, darwin, linux and an unknown platform. Installer unverified and recovery unconfirmed: no installed macOS or Linux build was run, and the reporter has not answered. When a tag containing 448c99d2a ships and the reporter confirms on Linux, record it in recovery and recoveryEvidence.

## Regression

At 0b8441064, `test/tool-description.platform-snapshot.test.js` fails 13 rows, run in a scratch archive of the base with the final test file copied in (qa/evidence/safe-egress-1103/red-at-base.json, S4). buildCatalog ignores the platform, so the darwin, linux and unknown-platform catalogues carry computer.use "on the Windows desktop" and browser.test_navigate "never reach Windows", and runtimeinfo.hostFacts and shell.js FLOOR_RULES do not exist. At 448c99d2a it passes (51 assertions):
- Each platform's catalogue names only its own OS and shell.
- The two phrased descriptions vary only by the hostFacts phrase, and no other tool text varies by platform.
- shell.exec's clause is the floor table's names, and each named form is refused by its own row. The table answers a 48-command corpus exactly as the base's if-chain.
- The win32 bytes of computer.use, browser.test_navigate and shell.exec equal the base's.

`test/runtimeinfo.test.js` pins the hostFacts table, including the neutral words for an unknown or hostile platform string; it throws at the base, where hostFacts does not exist.

## Sibling coverage

{
  "adapters": [
    {"target":"computer.use, browser.test_navigate and shell.exec on win32, darwin, linux and an unknown platform","state":"covered","test":"test/tool-description.platform-snapshot.test.js","scenario":"buildCatalog({ platform }) for each: each catalogue names only its own OS and shell, and the two phrased descriptions vary only by the runtimeinfo.hostFacts phrase","gate":"fast"},
    {"target":"every other declared tool (143 in the catalogue)","state":"covered","test":"test/tool-description.platform-snapshot.test.js","scenario":"No description, precondition or schema string names another platform's OS or shell, and none varies by platform","gate":"fast"},
    {"target":"the [RUNTIME] Shell line for each execution backend (local cmd.exe, local /bin/sh, Docker, SSH)","state":"covered","test":"test/runtimeinfo.test.js","scenario":"The line names the shell the agent's effective backend runs, and never a guessed one","gate":"fast"},
    {"target":"CUA's computer.use (the Windows x64 driver)","state":"not-applicable","reason":"Registered only when computer control selects CUA, a Windows x64 driver that computer-control.js select() refuses off Windows. Its description names no OS (read during S4), and its contract text is the Windows driver's own."}
  ],
  "entrypoints": [
    {"target":"a run's own tool registration (index.js builds the factories without a platform)","state":"covered","test":"test/tool-description.platform-snapshot.test.js","scenario":"makeComputerTools, makeBrowserTools and makeShellTool built without a platform give this host's catalogue text","gate":"fast"},
    {"target":"the declared catalogue readout (GET /api/toolsets and the authority census call buildCatalog() with no platform)","state":"covered","test":"test/tool-description.platform-snapshot.test.js","scenario":"buildCatalog() with no platform declares computer.use, browser.test_navigate and shell.exec for this host","gate":"fast"},
    {"target":"the provider wire of the default floors","state":"covered","test":"test/payload.budget.test.js","scenario":"default-new-install, fully-granted-floor and lead-with-crew stay within their tool-byte budgets (58,264 / 58,264 / 63,013 bytes measured at 448c99d2a on Windows)","gate":"http"}
  ],
  "displays": [
    {"target":"what a model on a macOS or Linux station reads","state":"covered","test":"test/tool-description.platform-snapshot.test.js","scenario":"darwin: computer.use controls the macOS desktop; linux: browser.test_navigate's locks never reach the desktop","gate":"fast"},
    {"target":"a live model run on an installed macOS or Linux build","state":"blocked","reason":"No macOS or Linux host in this lane: every platform's catalogue was declared from one Windows host, and no installed build or live model was run."}
  ],
  "lifecycle": [
    {"target":"updating a Windows station","state":"covered","test":"test/tool-description.platform-snapshot.test.js","scenario":"The win32 description bytes equal the base's, so a Windows station sends the same tool prefix before and after the update","gate":"fast"},
    {"target":"updating a macOS or Linux station","state":"not-applicable","reason":"Nothing is persisted: descriptions are built per run from the host's platform, so the new words go out from the first run after the update (4 bytes shorter on macOS, 2 longer on Linux), and no save, setting or transcript changes shape."}
  ]
}
