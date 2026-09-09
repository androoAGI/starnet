# MISTAKES.md — recurring failures & hard-won gotchas

The mistakes this project actually repeats, so you don't repeat them again. Read before
debugging or claiming anything done. Companions: [BRAIN.md](BRAIN.md) · [DECISIONS.md](DECISIONS.md) ·
[NEXT.md](NEXT.md) · `.claude/skills/starnet-debugging` (the method) · `.claude/skills/starnet-verify` (the proof bar).

## The big five (cost the most time, keep recurring)

1. **Fake done.** Code that compiles + tests that pass is NOT done. Done = the behavior
   observed in the live running app. This is the #1 recurring failure on the project.
   Mechanics: `.claude/skills/starnet-verify`.
2. **Plan docs lie within hours.** Audits/plans/memory claims go stale FAST here (10+ lanes
   merge per day). Any "X is missing/broken" claim must be re-proven by grepping trunk
   before you build or "fix" anything. Half-built or fully-shipped versions of your task
   usually already exist.
3. **The app lying (untruthful telemetry).** UI asserting state the harness can't prove —
   fake green dots, cosmetic props, decorative gauges. Fix the claim, not the appearance.
4. **Parallel-agent breakage.** Editing outside your worktree, `git add -A`, touching owned
   contract files (`shared/events.js`, `shared/schema.js`), or feature-editing the
   integration tree. The protocol in CLAUDE.md exists because all of these happened.
   Variant (2026-07-06): two sessions executed the SAME NEXT.md queue item concurrently —
   one was deleting triaged branches while the other's agents were still diffing them
   (refs vanished mid-read). Before executing any destructive queue item (branch
   deletion, worktree teardown, trunk merge), claim it in NEXT.md first:
   `IN PROGRESS — <session/lane>`. Deleted-tip insurance: `archive/*` tags.
5. **Pattern-match fixes.** A signal that looks like a known failure often has a different
   cause. Reproduce first, one hypothesis at a time. Example: slash commands "not working"
   (2026-07-05) was an INPUT-path bug (palette prefix-match swallowed arg-taking commands
   and sent them as chat) — every output-path fix attempt was wasted. Diagnose the input
   path before blaming the output path.

## Desktop / installed-app traps

- **The installed app's UI is compiled into the exe** (webview loads `tauri.localhost`).
  Patching the repo/folder NEVER changes the installed UI — only an exe swap/reinstall does.
  The only proof of installed-UI behavior is CDP-attach (`--remote-debugging-port`).
- **The installed sidecar is bundled at desktop build time too.** Editing `sidecar/` in the repo does
  not change `%LOCALAPPDATA%\StarNet\sidecar`. A sidecar safety fix is not shipped until the desktop
  app is rebuilt/reinstalled and the installed bundle is live-proven.
- **WebView2 caches the embedded frontend** in `EBWebView\Default\{Cache,Code Cache}` and
  never revalidates — V8 can run OLD bytecode against NEW data (the 7/6 "missing agents"
  incident: data was never lost; a plain relaunch after cache purge healed it). Hot patches
  stay invisible until that cache is purged. HTTP/version checks do NOT prove the webview
  updated. (Purge-on-version-change shipped 2026-07-06, agent/wv-cache-purge.)
- **Real station data root** = `%APPDATA%\Roaming\ai.skynet.harness\workspaces`
  (`startup.log` proves it). `%LOCALAPPDATA%\StarNet\workspaces` is a stale migrated-from
  secondary — don't debug against it.
- **Tauri/Rust build:** `E0463 ctor_proc_macro` = cargo parallel-build race. Pre-build the
  ctor crates, then `desktop:build`. The toolchain is fine; don't reinstall it.

## CI / release traps

- **Gate order:** run the test gate AFTER the version bump, BEFORE the tag push. v0.2.0 and
  v0.2.1 were burned learning this (that's the gate working as designed — a burned version
  number is cheap, a broken public release is not).
- **Version fixtures pinned near the current version are time-bombs** — a fixture at
  "current+1" starts failing when the real version catches up. Use `99.0.0`.
  (But NOTE: `t1`/`t5` hardcoded mtimes are relative-ordering fixtures, NOT date-bombs —
  never "fix" those.)
- **macOS CI:** runners ship bash 3.2 (no globstar — use `find`); mac legs must bundle
  `app,dmg` (dmg alone produces no `.app.tar.gz` updater artifact); unset empty `APPLE_*`
  env vars or unsigned builds fail at codesign instead of skipping it.
- **Windows cmd 8191-char limit** breaks long test invocations — split test lists instead
  of growing one command line.

## Frontend / canvas traps

- **Canvas screenshots time out** (rAF canvas). Verify via `preview_eval` DOM round-trips,
  `window.__world` state reads, or CDP — not screenshots. See `starnet-verify`.
- **Composite shadow vars referencing `--ph` must live on `body`, not `:root`** (theme bezel
  trap, fixed 5274a42) — on `:root` they freeze the fallback at parse time.
- **Per-theme `--gold-rgb` triplets** must exist for any rgba() glow derived from gold.
- **No static asset tags outside `frontend/`** (frontendDist). A `<script src="/shared/...">`
  works in dev and 404s in the packaged app (zero-presets bug, f70a4f05).
- **Full-row grid children:** a cell added to a fixed-column grid without `grid-column: 1/-1`
  blows out the row (letter-spill bug, e2630472).
- **Preview windows at 0×0:** preview clicks silently no-op on unsized windows — size/position
  before interacting.

## Backend / process traps

- **`npm start` (:8787) is the app.** `npm run serve` is a dead UI-only path — using it
  "works" and then nothing real functions.
- **Bare `require()` at module top for optional deps** crashes the single-process sidecar at
  boot — lazy-require inside the handler (prop-upgrade merge lesson).
- **Windows file authoring:** heredocs/echo can inject NUL/BOM bytes that git then treats as
  binary — author files with the Write tool or `git show :path` round-trips, and check
  `git diff` renders as text before committing.
- **Merging Codex branches:** merge, never rebase; 29-hotfile no-touch set; grep for symbol
  collisions after each hotfile merge (`starnet-merge-ritual` has the full ritual).
- **A fetch `signal` governs the WHOLE response, not just the connection.** Passing
  `AbortSignal.timeout(30s)` (or any un-disarmed timer signal) to a streaming fetch aborts
  the SSE body mid-stream — every model turn >30s died with "The operation was aborted due
  to timeout" on ALL providers (fixed 2026-07-07, 46e1cf22). Connect ceilings must be
  disarmable at headers (`timeouts.connectGuard` in provider.js); body protection is the
  resettable idle watchdog's job, never a fixed wall-clock. Retry loops can MASK this for
  short turns and make it look like flakiness — if a timeout correlates with turn LENGTH,
  suspect a fixed timer on the stream.
- **Screen-first task execution (the 2026-07-08 Spotify incident).** Asked to "play a daft
  punk song", the agent skipped the LIVE `spotify_play` tool and drove `desktop.open` +
  `computer.use` — opened Spotify on the user's screen and, after focus moved, typed the
  song title into StarNet's own chat box. Root causes, all fixed: (a) no tool-selection
  doctrine anywhere in the composed prompt (`taskDoctrineNote` in index.js now injects the
  quietest-path ladder: dedicated tool > headless shell/browser > visible screen last, plus
  act→verify-read-back→iterate); (b) `desktop.open`'s description recruited itself for
  "pull up X" phrasing (descriptions must SELF-DEMOTE — say when NOT to use the tool);
  (c) keyboard input trusted focus blindly (`computer.use` now has a focus-truth guard:
  win32 `foreground()` probe, `expectApp` match, and typing into a StarNet-titled window is
  hard-refused). LAW: a visible-screen tool is a last resort the agent must justify, and
  new loud tools ship with "when NOT to use me" text + the doctrine updated.

- **Headless CDP is not automatically physical-input isolation (2026-07-12 FPS incident).**
  Transcript forensics found zero `computer.use` calls: Puppeteer/CDP clicked a headless game, then
  the page's real `requestPointerLock()` reached Chromium's Win32 `ClipCursor` path. Synthetic click
  events are insufficient while page APIs can acquire native pointer/keyboard locks. Local game/UI
  tests must use the owned, forced-headless `browser.test_*` path, install and verify lock emulation
  before navigation, block unshimmed new targets, dispatch CDP/page input only, and await browser exit.
  Boot/shutdown/E-STOP releases are recovery, not protection during a live run. Verify continuously
  with `GetClipCursor` + `GetCursorPos`, use `GetLastInputInfo` to reject user-contaminated receipts,
  and refuse to start if the cursor is already confined. Restricted runs expose no real-screen or
  physical-input tool. **Superseded for explicit Full Power (2026-08-14):** the persisted host-minted
  Full Power posture is now that separate authority and may project real screen/input control. Do not
  recreate the old contradiction where “Full Power” still hit this floor; preserve the floor only for
  ASK/narrower modes and keep telemetry honest when the native driver itself is unavailable.

- **Cleanup is still interference when it mutates unowned global state.** Calling
  `ClipCursor(NULL)` at boot, shutdown, or E-STOP can release confinement owned by the user's game,
  even when intended as recovery from StarNet. Observe global state, reap only processes StarNet can
  prove it owns, and never “restore” desktop/input/session state without an ownership receipt.

- **A token, renderer IPC call, or tool annotation is not a human gesture.** Same-user children can
  inherit API/provider secrets; renderer script can invoke native commands; MCP servers can lie with
  `readOnlyHint`. Strip host credentials from children, keep OS-launch routes inert, classify all custom
  connectors as unknown, and require an exact non-cacheable live confirmation at the host boundary.
  This is the sole native-dialog exception: it names the exact canonical target + action, asks every
  time, stores no approval, and Cancel must never fall through to another launch path.

- **Scan the process that will run, not a convenient parent project.** `verify.run` once executed from
  `environment.getCwd()` while inspecting `workspaceRoot()`, and project-root discovery selected the
  outermost monorepo marker. A nested package could therefore hide its scripts. Local command safety
  inspection must use the actual cwd and the nearest project marker before process creation.

- **Same-session arbitrary code defeats denylist guarantees.** Renamed binaries, FFI, dynamic code,
  or a novel OS API can bypass command-pattern guards. Job Objects help with process lifetime but do not
  provide a non-input desktop or sufficient security boundary. Unknown code must run under an OS-proven
  noninteractive worker (restricted token/private desktop, container, or VM) or remain disabled; describe
  regex and environment pins as defense in depth, never as a literal “never touches the PC” theorem.

- **Never destroy the last copy of a secret without read-back proof of its new home.**
  The 2026-07-07 Telegram-token escape: desktop "keychain migration" stripped the plaintext
  bot token from `channels/secrets.json` while the keychain write was best-effort
  (`let _ = set_password(...)` swallowed errors; frontend keychain-store failures fell back
  to an in-memory-only token; sidecar boot migration stripped even when the keychain env
  proved the token absent). Session worked, next launch the credential was GONE — config
  intact, secret nowhere. The law: a strip/clear/migrate of any credential must first
  VERIFY (read back) that the destination durably holds it; a plaintext fallback on disk is
  honest, a lost secret is not. Applies to channel tokens, provider keys, OAuth
  refresh tokens, connector secrets. Related shape: a load failure treated as "not
  configured" followed by a save that persists the empty state over the good file.

- **A runtime-only flag that decides what EXISTS on the floor is a relaunch bug waiting.**
  The every-update "missing agents" escape (fixed 2026-07-07, d47180fc): crew inner life +
  survive-bay-deletion both keyed off the runtime-only `summoned` flag; a relaunch rebuilt
  bay-bound bodies WITHOUT it (spawnAgent early-returned on "already present"), so idle
  agents froze inside their bay's footprint (y-sorted behind the taller bay sprite =
  invisible) and were dropped outright when the bay was deleted — while the crew
  manifest/dossier still listed them. Andrew's station only relaunches on app updates, so it
  pattern-matched to "every update breaks my agents." The law now in code: **a roster agent
  ALWAYS has a live floor body; a bay decides WHERE it homes, never WHETHER it exists.**
  When adding any presence/behavior flag, ask: is it derivable from persisted truth on
  boot? If not, the boot path must rehydrate it explicitly.

## Judgment traps

- **"Audit says missing" ≠ missing** — the FULL_RELEASE_POLISH sprint found audit claims
  stale within hours; every lane must grep trunk first (its lesson is now law #2 above).
- **Verify-then-delete:** four "dead" subsystems (providers/billing/patchparse/data-shim)
  turned out LIVE on 2026-07-04. Never delete on an audit's say-so; prove dead in the
  running app first.
- **Don't gold-plate cosmetic asks** and don't ask Andrew questions research can answer.
  Ask only at genuine product forks.
- **"The removed voice is back" = check provider billing FIRST (2026-07-07):** a wrong-voice
  report on an installed build pattern-matches to a code regression, but twice now the cause
  was the neural-TTS path silently dying (2026-07-06 haveKey false-negative; 2026-07-07
  OpenRouter credits exhausted → 402) and the app degrading to the browser speechSynthesis
  fallback with no explanation. Diagnosis order: voice-cache mtimes (fresh clips = neural
  worked until T) → probe OpenRouter directly with the key (+ GET /api/v1/credits) → only
  then read code. Any silent degrade that swaps a user-audible identity must surface its
  reason (voice.js noteFallback since 1d62aaad).

## 2026-09-09 — rejected command-room art experiment

Owner correction: furniture must use the existing StarNet prop-art workflow. PixelLab is for character sprites only, not generated furniture. New character sprites must fit the existing agents and props at actual gameplay scale; only a tiny size increase is acceptable. The command-room experiment used mismatched generated furniture and an oversized operator and was rejected in full. It has been reverted; do not reuse that pass as an approved direction.
