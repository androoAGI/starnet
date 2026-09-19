# Remote provider acceptance

Use a disposable profile or backed-up station to validate the draft proposal. Keep existing keys and endpoints; startup, reconnect and persistence checks do not require paid inference. See the draft PR for actual automated results, and the maintainer guide for behavior that must remain unchanged.

1. Open **StarNet** from Applications. Your existing station should open directly. The first connected opening migrates any old browser-held provider settings to the server. A provider reporting exhausted quota must not send you back to “Revive your agent.”
2. Open **Settings → Providers** immediately. Scroll near the bottom and keep moving up/down for at least 30 seconds while status labels load. Open an **ADD KEY** editor and type harmless, unsaved text. The list should not jump and the editor should stay open with its text and focus. Clear that test text without saving it.
3. Check your configured providers and the custom GLM endpoint/model ID. Switch between existing providers as usual; the custom model must stay selected even when the provider catalog fails or omits its ID.
4. Quit the app completely with **Command-Q**, reopen it, and repeat once. Provider settings and your station should still be present without entering keys again. Rebuilding or replacing the Mac app uses the same server settings.
5. If an existing key is already exhausted, open that agent's station and Settings normally. Any provider quota error should remain an operation/status error, not an application boot failure. No paid model request is needed to verify opening and persistence.

Report any jump with the settings section, elapsed time after opening, and whether an editor was open. For provider issues, share the provider name, model ID and error message; do not share the API key.

## Automated gates

```sh
npm ci
npm ci --prefix remote --omit=dev --ignore-scripts
node --test test/remote-*.test.js
NODE_PATH="$PWD/remote/node_modules" node scripts/run-test-list.mjs test/remote-regression.list
npm run test:fast
npm run test:http
npm run desktop:prepare
npm run desktop:stage-frontend
cargo test --manifest-path src-tauri/Cargo.toml --bin skynet-desktop
```

The normal fast/HTTP manifests include remote regressions. Tests cover synthetic provider quota exhaustion, process restart, multiple providers, custom endpoints, failed persistence, stale migration after removal, authenticated writes, secret-free readback, and transport lifecycle. Native UI checks below remain attended acceptance; unit tests do not prove rendered geometry or platform packaging.

## Unified desktop and connection setup candidate

1. Open the rebuilt **StarNet**. The loading screen should use the same official outlined StarNet wordmark as the station header. Your existing server, character, custom model and keys should remain. A depleted provider must still let you open Settings.
2. Open **Settings → Providers**, scroll near the bottom immediately, and keep reading for 30 seconds. Repeat after a Gateway reconnect. There should be no upward shift or repeated card fade. Appearance → Screen Flicker remains available if you deliberately want the CRT effect.
3. Reopen an unfinished conversation. The right panel follows current upstream v0.12.3, including its dark background, answer field and expandable suggestions. Type an unsent draft, reopen the app and confirm it is retained.
4. Open **Station → Connection Setup…** (Command-K). Your SSH host is prefilled. **Check sign-in** should identify your GitHub account. **Test & save** should verify SSH, ownership, runtime and live events without sending a model request. **Open station** should return to the same saved station.
5. Enter an unreachable test hostname or wrong port and test. Cancel a check too. Both must retain the prior saved connection; **Return to station** should still work. Restore the correct form details afterward.
6. The **new server** path is for a disposable/fresh Linux machine, not the existing station. Review the install details, launch the Terminal installer, then test and open the resulting empty station. The current package includes Linux x86_64 and arm64 runtimes; arm64 installation still needs hardware acceptance if only x86_64 was available during validation.

7. In **Station → Connection Setup**, choose **This Computer**. It should open StarNet’s original local onboarding or your existing local station without GitHub sign-in. Return to **Remote Uplink** and open your saved connection. Quit and reopen: the last selected location should resume. Your local and remote stations must remain separate.
8. On a fresh user profile, the chooser should appear with **New Server** selected, no personal host prefilled, and the bundled installer available. Do not reset your working profile to perform this check.

9. Click **Gateway** at the bottom right. Confirm the server and GitHub account. **Connection Settings** should open the same chooser as the Station menu. **Disconnect this app** should pause only this viewer; **Reconnect** should restore it with the same station and draft. This does not sign out of GitHub or stop server work.
10. Narrow Settings and check the saved API key cards: long endpoint URLs must wrap without crossing the buttons. During a connection check, **Cancel** and **Test & Save** must have equal bounds. On first setup only, a successful check should open the station automatically. The startup wordmark and message should remain centered.

Public release signing/notarization and Linux arm64 installation acceptance remain separate from a local candidate. Do not erase working data or revoke real provider keys merely to simulate a fresh install.

## Startup window lifecycle

After remote startup, the window switcher should show the station without a second black loading window. Close the remote station, reopen StarNet, then use Connection Setup to switch to This Computer and back. The local station should open normally, and reopening remote mode should retain the saved connection without bringing back the loading window.
