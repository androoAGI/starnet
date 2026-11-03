---
fingerprint: ed2cd4c0
slug: windows-shell-quoting-and-executable-spellings-b
title: Windows shell quoting and executable spellings bypass the desktop guard
surface: safecell
severity: P1
status: fixed
found: 2026-11-03
lane: agent/shell-guard-repair-1103
fix: a21bc3e84997c8ccffb83910bd909199ab908f34
origin: audit
report: Overnight shell guard review at held 243d9e418 and original 5ffca5a00, preserved through c2fe937c2
affected: Local Windows cmd/native PowerShell command inspection before dispatch
family: shell-native-command-proof
installer: unverified
recovery: unconfirmed
---

# Windows shell quoting and executable spellings bypass the desktop guard

## Symptom

The shell guard can permit a Windows GUI-subsystem program when the same program is refused under its ordinary explicit filename. Native wrapper quotes and alternate executable spellings change what Windows executes without changing the guard's answer.

## Repro

1. Allocate a temporary directory and compile a harmless GUI-subsystem PE named `probe.exe` whose sole action is writing an owned marker file. No visible window or input API is used.
2. Pass each command through the actual `escapesWorkspace` and `commandSafetyRisk` owners with the real known cwd, fs/path, Windows dialect and search environment: `powershell -NoProfile -NonInteractive -c Write-Output ok "; .\probe.exe"`, `cmd /c "echo ok" "& probe.exe" x`, `probe`, `(probe.exe)`, and `probe.ex^e`.
3. For an admitted command, dispatch through the actual production `buildMarkedCmd` and Node `spawnSync({shell:true,windowsHide:true})`. Check both refusal and whether the owned marker exists. A deliberately forced direct `probe.exe` invocation establishes that the harmless fixture can execute.
4. Run `test/shell-wrapper-quoting.test.js` and `test/shell-command-resolution.test.js`. `SHELL_GUARD_CONTROL` selects preserved original module bytes for a complete before/after control. The resolution fixture also separately establishes actual native ownership with distinguishable GUI/console markers before checking guarded dispatch.

## Evidence

- Original source/evidence: `sidecar/tools/builtin/shell.js`; `C:/Users/andro/gen-trees/_logs/codex-overnight-1103/shell-guard-review.md` and `wrapper-review/marked-results.json`. All five original marker cases were also admitted by the earlier baseline: these are inherited findings, not regressions introduced by the held extraction.
- Exact c2fe original SHA256 D6A5D4B69794579944829338E61773779B1FA7004C9E366E981109CBA747284E is preserved as `shell-guard-c2fe-original.js.txt`. Sole-lease proof logs `shell-guard-source03-shell-wrapper-quoting-old/current.log`: original 8 failures of29 (21 positive), PID440 exit1; current29, PID65148 exit0. `shell-guard-source03-shell-command-resolution-old/current.log`: original71 failures of179 (108 positive), PID70732 exit1; current179, PID26248 exit0.
- Independent draft review found raw-file-before-PATHEXT and composed `@`/group mistakes before acceptance. Actual14-case lookup diagnostic PID63024 exit0 established exact candidate identities; draft02 resolver control has26 failures of179, PID69432 exit1. Preserved logs: `shell-guard-lookup-diagnostic*`, `shell-guard-source03-review02-shell-command-resolution-old.log`.
- Affected-reader evidence preserved: draft03 `shell-local-program` has5 failures of244. Two were real `2>&1` lexer regressions; two were the explicitly approved equivalent bare/exe proof boundary, one exact wording. Draft04 redirection repair introduced an escaped-operator mistake, proven by actual numeric GUI marker in `shell-guard-escaped-redirect-diagnostic*` (7 completed cases, PID26248 at22:49:32Z, distinct from the earlier reused PID). No release or acceptance was claimed for either draft.
- Final focused source05: exact04 resolver control12 failures of225 (PID25956 exit1), current225 (PID35924 exit0); exact03 source-scan diagnostic2 failures of32 (PID24248 exit1), restored current32 (PID65316 exit0). Current wrapper29 and local-program246 also pass. Full commands, profiles, source hashes, PIDs, times and exits are in adjacent `shell-guard-source05-*.json` receipts. The ordinary stdout/stderr redirect assertions verify actual stream destinations; the even-caret diagnostic's native handle error is explicitly not called successful stream routing.
- All20 named affected/law files have complete current exit0 receipts across `shell-guard-source05-*`, `shell-guard-affected-source06-*`, `shell-guard-affected-source07-*` and `shell-guard-affected-source07tail-*`. Source06 corrects only new-command positive fixture contexts to use their real allocated cwd; source07 explicitly proves unknown live input refuses before manager write, then tests a builtin-only manager acknowledgement. The initial input fixture RED5/54, live `hello` refusal exception, and external runner's nonexistent `shell.test.test.js` typo are preserved separately. Production remained source05 throughout; no product change is attributed to these fixture/runner corrections.

## Verdict

Fixed in source after complete old/current native marker controls and20 affected/law greens; source05 independently reviewed. Installed/reporter recovery and general live-terminal REPL support remain unverified and separate.
