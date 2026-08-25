/* node test/desktop-fresh-start-contract.test.js — packaged Mac/Windows unreachable escape wiring. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'main.rs'), 'utf8');
const native = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'fresh_start.rs'), 'utf8');
const html = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'frontend', 'app', 'app.js'), 'utf8');

A.ok(main.includes('fn starnet_start_fresh('), 'desktop shell exposes a sidecar-independent fresh-start command');
A.ok(/generate_handler!\[[\s\S]*starnet_start_fresh/.test(main), 'the native command is registered for packaged UI IPC');
A.ok(main.includes('migrate_credits_token_from_plaintext(&st.workspaces)'), 'a preserved linked-credit token is re-adopted before respawn');
A.ok(main.includes('compare_exchange(false, true'), 'restart and fresh-start commands cannot race each other');
A.ok(main.includes('window.clear_all_browsing_data()'), 'packaged WebView2/WKWebView state is cleared natively');
A.ok(native.includes('fs::rename(workspaces, destination)'), 'the prior station is moved, never deleted');
A.ok(native.includes('const CREDITS_LINK: &str = ".secrets/credits.json"'), 'the StarNet credit-account identity survives the station reset');
A.ok(native.includes('owner_pid_alive(owner_pid)'), 'a dead PID stamp cannot strand the fresh-start escape');
A.ok(native.includes('MIGRATION_MARKER') && native.includes('acknowledged_roots'), 'the clean generation cannot resurrect legacy state on Mac or Windows relaunch');
A.ok(html.includes('id="btn-unreachable-fresh"'), 'the unreachable screen exposes the escape');
A.ok(html.includes('does not remove your StarNet account link or purchased credits'), 'the screen explains the credit-preserving scope');
A.ok(app.includes('FreshStart.resetDesktop(core)'), 'the two-click UI calls the native transaction rather than dead sidecar HTTP');
A.ok(app.includes("freshBtn.textContent = '✦ CONFIRM — START COMPLETELY FRESH'"), 'the destructive choice requires an explicit second click');
A.ok(app.includes('browserResetBlocked = true'), 'an uncleared browser cache cannot silently repopulate the clean station');
A.ok(app.includes('FreshStart.retryBrowserClear(preservedReset)'), 'a browser-clear retry reuses the original quarantine receipt instead of moving the clean station again');

A.report('desktop-fresh-start-contract.test');
