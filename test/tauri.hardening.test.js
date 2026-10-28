/* node test/tauri.hardening.test.js -- static guard for desktop browser hardening. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const caps = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'capabilities', 'default.json'), 'utf8'));
const mainRs = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'main.rs'), 'utf8');
const indexJs = readSidecarSource();
const browserJs = fs.readFileSync(path.join(root, 'sidecar', 'tools', 'builtin', 'browser.js'), 'utf8');
const cargoToml = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');

A.eq(conf.bundle && conf.bundle.publisher, 'Andrew Sims', 'Windows package publisher matches the release signing identity instead of leaking the legacy identifier');
A.ok(!cargoToml.includes('???'), 'desktop package metadata contains no corrupted placeholder punctuation');

const csp = String(conf.app && conf.app.security && conf.app.security.csp || '');
A.ok(csp.length > 0 && csp !== 'null', 'Tauri CSP is configured');
A.ok(/default-src 'self'/.test(csp), 'CSP defaults to self');
A.ok(/connect-src[^;]*http:\/\/127\.0\.0\.1:\*/.test(csp), 'CSP permits the packaged sidecar bridge');
A.ok(!/connect-src[^;]*localhost:\*/.test(csp), 'CSP does not include broad localhost connect access');
// 2026-09-25: no inline script. The shipped frontend has zero inline <script> blocks and zero inline on*= handlers;
// Tauri also hashes every bundled .js into script-src, which already made 'unsafe-inline' inert in WebView2.
A.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), "script-src does not allow 'unsafe-inline'");
A.ok(!/'unsafe-eval'/.test(csp), "CSP never allows 'unsafe-eval'");
// 127.0.0.1:* is a compile-time placeholder: main() pins it to this launch's sidecar port before the app is built.
const mainRsCsp = fs.readFileSync(path.join(__dirname, '../src-tauri/src/main.rs'), 'utf8');
A.ok(/let sidecar_port = free_port\(\);\s*\n\s*pin_config_csp\(&mut context\.config_mut\(\)\.app\.security\.csp, sidecar_port\);/.test(mainRsCsp),
  'main() pins the CSP loopback source to the sidecar port before building the app');
A.ok(/let port = sidecar_port;/.test(mainRsCsp) && (mainRsCsp.match(/= free_port\(\)/g) || []).length === 1,
  'setup() spawns the sidecar on that SAME pinned port (one free_port call)');
A.ok(/fn open_external_url\(state: State<AppState>, url: String\)[\s\S]{0,400}url_carries_api_token\(trimmed, &state\.api_token\)/.test(mainRsCsp),
  'open_external_url refuses any URL carrying the master API token');
const indexHtml = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
A.eq((indexHtml.match(/<script\b(?![^>]*\bsrc=)[^>]*>\s*\S/gi) || []).length, 0, 'index.html has no inline <script> block');
A.eq((indexHtml.match(/<[a-z][^>]*\son[a-z]+\s*=/gi) || []).length, 0, 'index.html has no inline on*= event handler');
A.ok(/object-src 'none'/.test(csp), 'CSP disables plugin/object loads');
A.ok(/frame-ancestors 'none'/.test(csp), 'CSP blocks framing');
// Plugin windows (2026-09-29): the webview may frame ONLY the sidecar's own loopback port (pinned at launch, like
// connect-src) — the sandboxed /plugin-ui/ pages. Never a wildcard, never another host.
const frameSrc = (/frame-src ([^;]*)/.exec(csp) || [])[1] || '';
A.eq(frameSrc.trim(), 'http://127.0.0.1:*', 'CSP frames only the sidecar loopback port (plugin windows), pinned at launch');
A.ok(/base-uri 'none'/.test(csp), 'CSP blocks base tag rewriting');
A.ok(/form-action 'none'/.test(csp), 'CSP blocks form exfiltration');

const remoteUrls = (caps.remote && caps.remote.urls) || [];
A.ok(remoteUrls.length === 0 || (remoteUrls.length === 1 && remoteUrls[0] === 'http://127.0.0.1:*/api/**'), 'remote capability is absent or narrowed to the 127.0.0.1 sidecar API');
A.ok(remoteUrls.every(u => u.indexOf('localhost') < 0), 'remote capability does not trust localhost aliases');
A.ok(remoteUrls.every(u => /\/api\/\*\*$/.test(u)), 'remote capability does not expose all loopback paths');
A.ok(/fn sidecar_command[\s\S]*?\.env\("STARNET_COMPUTER_DRIVER", "1"\)/.test(mainRs), 'desktop host enables the native driver; paired remote-owner authority still gates every call in the sidecar');
A.ok(!/fn sidecar_command[\s\S]*?\.env\("STARNET_BROWSER_HEADLESS", "1"\)/.test(mainRs), 'desktop sidecar does not globally disable the attended browser-login exception');
// A run's browser options live in ONE object (runBrowserDeps) used both for its own tools and for the private browser it
// falls back to when the shared station browser is busy (2026-10-01) — so neither path can drop the headless rules.
A.ok(/const runBrowserDeps = \{[\s\S]*?forceHeadless:\s*true[\s\S]*?syntheticInputOnly:\s*true[\s\S]*?attendedLogin:[\s\S]*?\n  \};/.test(indexJs), 'ordinary desktop research stays headless and input-isolated while the watched login channel is wired separately');
A.ok(/makePrivate: \(\) => browserInternals\.makeBrowserSession\(runBrowserDeps\)/.test(indexJs), 'the private fallback browser is built from those same options');
A.ok(/runBrowser = makeBrowserTools\(Object\.assign\(\{ session: runStationBrowser \|\| undefined \}, runBrowserDeps\)\)/.test(indexJs), 'and so are the run\'s own browser tools');
A.ok(/relaunch\(\{ headed: true, forceHeadless: false, headless: false, syntheticInputOnly: false \}\)/.test(browserJs), 'browser.login is the narrow human-consented exception that may open a real visible Chrome window');
A.ok(/fn sidecar_command[\s\S]*?\.env\("STARNET_USER_CONTROL_MODE", "preserve"\)/.test(mainRs), 'every desktop sidecar launch pins user-control preservation');
A.ok(/fn sidecar_command[\s\S]*?\.env\("STARNET_MCP_STDIO", "0"\)/.test(mainRs), 'installed desktop refuses unsandboxed local MCP children');
A.ok(/fn set_sidecar_branded_env[\s\S]*?strip_prefix\("SKYNET_"\)[\s\S]*?STARNET_\{suffix\}/.test(mainRs), 'desktop-owned sidecar values replace both brand aliases');
for (const suffix of ['PORT', 'IPC_TOKEN', 'API_TOKEN', 'WORKSPACES', 'OPENROUTER_KEY']) {
  A.ok(new RegExp(`set_sidecar_branded_env\\(&mut cmd, "SKYNET_${suffix}"`).test(mainRs), `desktop pins both aliases for ${suffix}`);
}
A.ok(/for \(provider, env_name\) in SIDECAR_PROVIDER_KEY_ENVS[\s\S]*?set_sidecar_branded_env\(&mut cmd, env_name, key\)/.test(mainRs), 'provider keychain values cannot be shadowed by inherited canonical aliases');
A.ok(/for \(channel, env_name\) in SIDECAR_CHANNEL_TOKEN_ENVS[\s\S]*?set_sidecar_branded_env\(&mut cmd, env_name, token\)/.test(mainRs), 'channel keychain values cannot be shadowed by inherited canonical aliases');
A.ok(/fn desktop_owned_env_replaces_poisoned_brand_aliases[\s\S]*?poisoned-parent-value[\s\S]*?fresh-launch-token/.test(mainRs), 'Rust regression test poisons both alias directions before applying desktop-owned values');
A.ok(/fn harness_clear_key\(state: State<AppState>\)[\s\S]*?harness_store_key\(String::new\(\), state\)/.test(mainRs),
  'OpenRouter FORGET uses the transactional provider-key path instead of swallowing keychain deletion failure');
A.ok(!/starnet_open_workshop_file/.test(mainRs), 'webview IPC exposes no workshop file launcher');
A.ok(!/starnet_open_user_directory/.test(mainRs), 'webview IPC exposes no directory launcher');

// 2026-09-23 audit: the token-bearing main window must never show a foreign page. Init scripts re-run on every
// top-level navigation and the native drag-drop handler is disabled, so a dragged-in link used to load inside
// the frameless window and receive __STARNET_API_TOKEN__. (Behaviour is unit-tested in main.rs
// navigation_guard_tests via `cargo test --bin skynet-desktop navigation_guard`.)
A.ok(/\.on_navigation\(move \|url\| is_app_navigation\(url, sidecar_port\)\)/.test(mainRs), 'the main window refuses navigation outside the bundled app origin');
// The guard + origin-gated token must live in the ONE builder shared by startup and WebView2 crash recovery,
// or a rebuilt window carries the token with no navigation guard.
A.ok(/fn build_main_window\([\s\S]{0,1500}?webview_init_script\([\s\S]{0,2500}?\.on_navigation\(move \|url\| is_app_navigation\(url, sidecar_port\)\)/.test(mainRs),
  'startup and crash-rebuilt windows share one builder carrying the navigation guard');
A.ok(/fn webview_init_script\([\s\S]{0,800}?if\(location\.protocol==='tauri:'/.test(mainRs), 'the shared init script is the origin-gated one');
A.eq((mainRs.match(/WebviewWindowBuilder::new\(/g) || []).length, 1, 'exactly one main-window builder exists');
A.ok(/fn is_app_navigation\(url: &tauri::Url, sidecar_port: u16\) -> bool \{\s*match url\.scheme\(\) \{\s*"tauri" => true,\s*"http" \| "https" if url\.host_str\(\) == Some\("tauri\.localhost"\) => true,\s*"http" => is_sidecar_page\(url, sidecar_port\),\s*_ => false,\s*\}\s*\}/.test(mainRs),
  'the navigation allow-list is exactly the tauri scheme, the tauri.localhost host, or this app\'s own sidecar agent pages');
// The one exception (2026-09-30: macOS/Linux ask the guard about every FRAME, so the BROWSER window's sandboxed agent
// pages need it): exactly 127.0.0.1 on THIS app's sidecar port, no credentials, only the two sandboxed page routes.
A.ok(/fn is_sidecar_page\(url: &tauri::Url, sidecar_port: u16\) -> bool \{\s*sidecar_port != 0\s*&& url\.host_str\(\) == Some\("127\.0\.0\.1"\)\s*&& url\.port\(\) == Some\(sidecar_port\)\s*&& url\.username\(\)\.is_empty\(\)\s*&& url\.password\(\)\.is_none\(\)\s*&& SIDECAR_PAGE_ROUTES\.iter\(\)\.any\(\|route\| url\.path\(\)\.starts_with\(route\)\)\s*\}/.test(mainRs),
  'the sidecar-page exception is exactly loopback + this port + the sandboxed page routes');
// …and those routes are exactly the sidecar's SANDBOXED page routes (each served with a CSP sandbox header)
A.ok(/const SIDECAR_PAGE_ROUTES: \[&str; 5\] = \["\/view\/", "\/workshop-run\/", "\/plugin-ui\/", "\/plugin-draft\/", "\/app-ui\/"\];/.test(mainRs),
  'the frame exception covers the BROWSER window and the APPS / plugin windows, and nothing else');
A.ok(/let init = format!\(\s*"if\(location\.protocol==='tauri:'\|\|location\.hostname==='tauri\.localhost'\)\{\{window\.__STARNET_API__=/.test(mainRs),
  'the API token is injected only into the bundled app origin (second layer behind on_navigation)');
// 2026-10-10: the webview drives updates only through the app's own starnet_update_check/install commands; the
// updater plugin's raw IPC (check with allowDowngrades / proxy / target / headers) is never granted to it
A.ok(!caps.permissions.some(p => /^updater:/.test(String(p))), 'the webview holds no raw updater-plugin permission');

A.report('tauri.hardening.test');
