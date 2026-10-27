; StarNet NSIS installer hooks.
;
; ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
; The manual-installer path could not overwrite its own node.exe.
;
; The app ships a bundled node runtime at $INSTDIR\node.exe and runs the sidecar from it. Tauri's
; own CheckIfAppIsRunning (utils.nsh) only ever looks for ${MAINBINARYNAME}.exe — the shell — so
; nothing in the stock installer touches the sidecar. Worse, it kills the shell with a hard
; TerminateProcess, which runs NEITHER `Drop for AppState` NOR the ExitRequested handler where
; kill_sidecar() lives (src-tauri/src/main.rs) — so killing the shell *strands* the sidecar, and
; the very next thing the Install section does is `File` over node.exe. Interactively that stops
; on "Error opening file for writing ... node.exe"; SILENTLY (/S) it is worse — the error is
; auto-ignored and the install completes carrying a STALE node.exe.
;
; The IN-APP updater path was already fixed in main.rs (the updater's on_before_exit calls
; kill_sidecar before the plugin's std::process::exit). This hook is the other half: the user who
; downloads the installer from the site and runs it by hand, and the user carrying an ORPHANED
; sidecar from an earlier hard kill (taskkill /F, crash, End Task) — neither runs any in-process
; hook at all. The Rust-side orphan reaper only runs at the NEXT app boot, i.e. after the
; installer has already failed.
;
; ── ORDER IS LOAD-BEARING ──────────────────────────────────────────────────────────────────────
; The shell must die FIRST. A long-lived guardian thread polls the child every ~3s and respawns it
; on unexpected exit (main.rs spawn_guardian), gated only by an in-process `shutting_down` flag
; that a hard kill never sets. Kill node.exe while the shell is alive and it is back — holding the
; same lock — within three seconds.
;
; ── SCOPE IS LOAD-BEARING ──────────────────────────────────────────────────────────────────────
; The kill matches on FULL IMAGE PATH, never on the name `node.exe`. A developer machine routinely
; has dozens of unrelated node processes (other apps, dev servers, other agent runtimes); Tauri's
; own name-based KillProcess would take every one of them down. Same rule main.rs states for its
; own reaper: "Full image path — the ONLY thing that authorizes a kill."
;
; ── THE WOW64 TRAP (this cost a debug cycle; do not undo it) ───────────────────────────────────
; The NSIS installer runs as a 32-BIT process, so `$SYSDIR` is WOW64-redirected to SysWOW64 and
; launches the 32-bit PowerShell. A 32-bit PowerShell can SEE 64-bit processes but reads their
; `.Path` as EMPTY — so a path-scoped match finds nothing, returns exit code 0, and the hook
; silently does nothing at all. Measured directly: `Get-Process -Id <64-bit pid> | Select Path`
; returns the real path under System32 PowerShell and blank under SysWOW64 PowerShell. We
; therefore reach the 64-bit PowerShell through the SysNative alias, which exists only for 32-bit
; processes; on a genuinely 64-bit installer SysNative is absent and $SYSDIR is already correct.
; NOTE this failed SAFE (killed nothing) rather than dangerous — keep it that way.
;
; ── FAIL-OPEN ──────────────────────────────────────────────────────────────────────────────────
; Any PowerShell/enumeration failure is ignored and the install proceeds. If this hook does
; nothing, behaviour is exactly what shipped in v0.6.8 — the stock retry dialog is still the
; backstop, so the hook can never make an install worse than it already was.
;
; ── NOTE ON `$` ────────────────────────────────────────────────────────────────────────────────
; NSIS expands `$` in strings, so the PowerShell below is deliberately free of PowerShell
; variables — `Get-Process | Where-Object Path -eq ... | Stop-Process` needs none. `$INSTDIR` is
; the one expansion we DO want. Do not "simplify" this into a `$_` pipeline.

; ── MANUAL UPGRADES ARE UPDATES, NOT UNINSTALLS ────────────────────────────────────────────
; Tauri's interactive "Already Installed" page defaults to running the OLD installer's
; uninstall.exe before this new install reaches NSIS_HOOK_PREINSTALL. If that old uninstaller is
; missing, quarantined, corrupt, or leaves the main exe behind, Tauri dead-ends on the generic
; "Unable to uninstall!" dialog. The in-app updater never takes that path: it passes /UPDATE and
; performs an in-place replacement.
;
; .onGUIInit runs after Tauri's .onInit has selected the registry context but before any page is
; shown. For a strict upgrade (or an installed record whose version is unreadable), append the
; same /UPDATE /P /R flags and re-run .onInit so the stock template skips the uninstall page,
; installs passively in place, and relaunches StarNet. The uninstall registry's InstallLocation is
; authoritative here: pre-0.10 releases could leave Tauri's separate manufacturer key pointing at
; the default directory after a custom /D install. Without restoring the uninstall location, the
; upgrade installs a second copy at that stale default and leaves the old sidecar running. Same-
; version maintenance and downgrades keep Tauri's normal UI. We intentionally use only NSIS
; registers here: this hooks file is included before the template declares its named variables and
; product/version defines.
!define MUI_CUSTOMFUNCTION_GUIINIT StarNetManualUpgradeInit
Function StarNetManualUpgradeInit
  ClearErrors
  ${GetOptions} $CMDLINE "/UPDATE" $R9
  ${IfNot} ${Errors}
    Goto starnet_manual_upgrade_done
  ${EndIf}

  ReadRegStr $R8 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarNet" "UninstallString"
  ReadRegStr $R9 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarNet" "DisplayVersion"
  ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarNet" "InstallLocation"
  ${If} $R8 == ""
    ReadRegStr $R8 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarNet" "UninstallString"
    ReadRegStr $R9 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarNet" "DisplayVersion"
    ReadRegStr $R1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarNet" "InstallLocation"
  ${EndIf}
  ${If} $R8 == ""
    Goto starnet_manual_upgrade_done
  ${EndIf}
  ${If} $R9 == ""
    Goto starnet_manual_upgrade_force
  ${EndIf}

  ClearErrors
  GetDLLVersion "$EXEPATH" $R8 $R7
  IfErrors starnet_manual_upgrade_done
  IntOp $R6 $R8 >> 16
  IntOp $R5 $R8 & 0xFFFF
  IntOp $R4 $R7 >> 16
  StrCpy $R3 "$R6.$R5.$R4"
  ${VersionCompare} "$R3" "$R9" $R2
  ${If} $R2 = 1
    Goto starnet_manual_upgrade_force
  ${ElseIf} $R2 = 0
    Goto starnet_manual_upgrade_done
  ${ElseIf} $R2 = 2
    Goto starnet_manual_upgrade_done
  ${Else}
    ; A corrupt/legacy DisplayVersion must not route back through a possibly broken uninstaller.
    Goto starnet_manual_upgrade_force
  ${EndIf}

  starnet_manual_upgrade_force:
    ; Tauri stores InstallLocation with wrapping quotes. Strip them before assigning $INSTDIR.
    ; If a legacy record has no InstallLocation, retain Tauri's already-resolved fallback.
    ${If} $R1 != ""
      StrCpy $R0 $R1 1
      ${If} $R0 == "$\""
        StrCpy $R0 $R1 1 -1
        ${If} $R0 == "$\""
          StrCpy $R1 $R1 -1 1
        ${EndIf}
      ${EndIf}
      StrCpy $INSTDIR $R1
    ${EndIf}
    StrCpy $CMDLINE "$CMDLINE /UPDATE /P /R"
    Call .onInit

  starnet_manual_upgrade_done:
FunctionEnd

!macro STARNET_STOP_INSTALL_PROCESSES
  Push $0
  Push $1
  Push $R9

  ; Resolve the 64-BIT PowerShell (see the WOW64 trap above).
  StrCpy $R9 "$WINDIR\SysNative\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$R9" +2 0
    StrCpy $R9 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"

  DetailPrint "Stopping any StarNet processes running from $INSTDIR..."

  ; 1. The shell first — it owns the guardian that would respawn the sidecar.
  nsExec::ExecToLog '"$R9" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name skynet-desktop -ErrorAction SilentlyContinue | Where-Object Path -eq $\'$INSTDIR\skynet-desktop.exe$\' | Stop-Process -Force -ErrorAction SilentlyContinue"'
  Pop $0
  Sleep 600

  ; 2. Then the sidecar — including one orphaned by an earlier hard kill, whose parent is long gone.
  nsExec::ExecToLog '"$R9" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object Path -eq $\'$INSTDIR\node.exe$\' | Stop-Process -Force -ErrorAction SilentlyContinue"'
  Pop $0
  Sleep 400

  ; 3. Anything else still running from StarNet's OWN bundled folders: a helper an orphaned older station left behind
  ;    (node-pty's OpenConsole.exe under node_modules) holds its own file open and stalls NSIS on "error opening file for
  ;    writing". A current shell's job already ended its station's tree with step 1; this is for what an older one left.
  ;    ONLY the folders the app ships that can hold a program (tauri.conf.json bundle.resources: node_modules, sidecar,
  ;    bin, shared), never the rest of $INSTDIR: the default install dir also holds the default WORKSPACES (agent-built
  ;    programs, venvs), an install typed into a shared folder (D:\Apps) holds other apps, and the uninstaller itself runs
  ;    IN PLACE as $INSTDIR\uninstall.exe when Tauri's "uninstall before installing" page runs it with _?= (killing it
  ;    aborts that install with "unable to uninstall"). For the same reason this PowerShell's own ancestors (the installer
  ;    or uninstaller running it) are never stopped, wherever they sit. A prefix sibling never matches (the trailing \).
  ;    Each stop is printed to the install log. The folder arrives through the ENVIRONMENT, never pasted into the command
  ;    (an apostrophe in the profile path broke a quoted literal — see the PATH hook below).
  ;    test/installer-stop-leftovers.test.js runs this exact line against planted processes.
  System::Call 'Kernel32::SetEnvironmentVariable(t "STARNET_INSTALL_DIR", t "$INSTDIR")'
  ; STARNET_STOP_LEFTOVERS
  nsExec::ExecToLog '"$R9" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d=$$env:STARNET_INSTALL_DIR; if (-not $$d) { exit }; $$d=$$d.TrimEnd($\'\$\')+$\'\$\'; $$own=$\'node_modules$\',$\'sidecar$\',$\'bin$\',$\'shared$\' | ForEach-Object { $$d+$$_+$\'\$\' }; $$all=@(Get-CimInstance Win32_Process); $$by=@{}; $$all | ForEach-Object { $$by[[int]$$_.ProcessId]=$$_ }; $$keep=@{}; $$i=[int]$$PID; while ($$i -and -not $$keep[$$i]) { $$keep[$$i]=1; $$i=[int]$$by[$$i].ParentProcessId }; $$all | Where-Object { $$x=[string]$$_.ExecutablePath; $$x -and -not $$keep[[int]$$_.ProcessId] -and ($$own | Where-Object { $$x.StartsWith($$_, [StringComparison]::OrdinalIgnoreCase) }) } | ForEach-Object { $\'StarNet: stopping $\' + $$_.ExecutablePath; Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Pop $0
  Sleep 300

  Pop $R9
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro STARNET_STOP_INSTALL_PROCESSES
!macroend

; ── TERMINAL MODE: `starnet` ON THE USER'S PATH ────────────────────────────────────────────────
; The app ships the `starnet` command in $INSTDIR\bin (starnet.cmd runs it on the app's own node.exe). After an install
; that folder joins the CURRENT USER's PATH, so typing `starnet` in any NEW terminal opens the dashboard — the way
; Hermes's installer puts `hermes` on PATH. The uninstaller takes it back off. (macOS: the app links it on launch,
; sidecar/cli-link.js — a dragged-in app has no installer.)
; - Through the .NET registry API, NEVER ReadRegStr/WriteRegStr: an NSIS string caps at NSIS_MAX_STRLEN, so a long
;   user PATH read that way comes back TRUNCATED and writing it back would destroy the rest of it.
; - Read UNEXPANDED, written back as REG_EXPAND_SZ: entries like %USERPROFILE%\bin stay exactly as they were.
; - Idempotent (an entry already there — any case, with or without a trailing \ — is not added twice; a reinstall or an
;   update adds nothing) and FAIL-OPEN (a PowerShell failure leaves PATH untouched and the install goes on).
; - The broadcast (WM_SETTINGCHANGE "Environment") is what makes Explorer, and every terminal opened after it, see it.
; Same 64-bit PowerShell as above; NSIS expands `$`, so every PowerShell variable below is written `$$`, and `$\'` is a
; PowerShell single quote. test/cli-path-hook.test.js runs these exact lines against a scratch registry key.
; - The folder reaches PowerShell through the ENVIRONMENT (STARNET_PATH_DIR, set in this installer process and inherited
;   by nsExec's child), never pasted into the command: a profile path with an apostrophe (C:\Users\O'Brien\...) broke the
;   quoted literal, PowerShell refused to parse, and fail-open meant `starnet` silently never reached PATH.
!macro STARNET_RESOLVE_POWERSHELL
  StrCpy $R9 "$WINDIR\SysNative\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$R9" +2 0
    StrCpy $R9 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  Push $R9
  !insertmacro STARNET_RESOLVE_POWERSHELL
  DetailPrint "Putting the starnet command on your PATH ($INSTDIR\bin)..."
  System::Call 'Kernel32::SetEnvironmentVariable(t "STARNET_PATH_DIR", t "$INSTDIR\bin")'
  ; STARNET_PATH_ADD
  nsExec::ExecToLog '"$R9" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d=$$env:STARNET_PATH_DIR; if (-not $$d) { exit }; $$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($\'Environment$\'); $$p=[string]$$k.GetValue($\'Path$\',$\'$\',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $$a=@($$p -split $\';$\' | Where-Object { $$_ -ne $\'$\' }); if (-not ($$a | Where-Object { $$_.TrimEnd($\'\$\') -eq $$d.TrimEnd($\'\$\') })) { $$k.SetValue($\'Path$\', (@($$a) + $$d) -join $\';$\', [Microsoft.Win32.RegistryValueKind]::ExpandString) }"'
  Pop $0
  SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=5000
  Pop $R9
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Push $0
  Push $R9
  !insertmacro STARNET_RESOLVE_POWERSHELL
  System::Call 'Kernel32::SetEnvironmentVariable(t "STARNET_PATH_DIR", t "$INSTDIR\bin")'
  ; STARNET_PATH_REMOVE
  nsExec::ExecToLog '"$R9" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d=$$env:STARNET_PATH_DIR; if (-not $$d) { exit }; $$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($\'Environment$\'); $$p=[string]$$k.GetValue($\'Path$\',$\'$\',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $$a=@($$p -split $\';$\' | Where-Object { $$_ -ne $\'$\' }); $$keep=@($$a | Where-Object { $$_.TrimEnd($\'\$\') -ne $$d.TrimEnd($\'\$\') }); if ($$keep.Count -ne $$a.Count) { $$k.SetValue($\'Path$\', $$keep -join $\';$\', [Microsoft.Win32.RegistryValueKind]::ExpandString) }"'
  Pop $0
  SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=5000
  Pop $R9
  Pop $0
!macroend

; Future uninstallers own the same process cleanup. This does not repair an already-corrupt old
; uninstaller (the in-place upgrade above makes that irrelevant), but it prevents a healthy future
; uninstall from failing merely because the shell or bundled sidecar is still running.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro STARNET_STOP_INSTALL_PROCESSES
!macroend
