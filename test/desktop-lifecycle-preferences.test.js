/* node test/desktop-lifecycle-preferences.test.js
   Locks the small preference seam added to the existing tray supervisor: native status reaches the Settings
   controls, writes are read back rather than assumed, startup visibility obeys the stored choice, close-to-tray
   bypasses the armed-work-only quit decision, and explicit tray Quit remains present. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const Lifecycle = require('../frontend/app/lifecycle.js');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

(async () => {
  const calls = [];
  const win = { __TAURI__: { core: { invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === 'starnet_lifecycle_status') return {
      supervised: true, armed: false, reasons: [], startMinimized: true, closeToTray: true
    };
    if (command === 'starnet_set_start_minimized') return { version: 1, startMinimized: !!args.enabled, closeToTray: true };
    if (command === 'starnet_set_close_to_tray') return { version: 1, startMinimized: true, closeToTray: !!args.enabled };
    throw new Error('unexpected command ' + command);
  } } } };

  const status = await Lifecycle.status({ win });
  A.eq(status, { supervised: true, armed: false, reasons: [], startMinimized: true, closeToTray: true }, 'native status exposes both verified preferences');
  A.eq(await Lifecycle.setStartMinimized(false, { win }), { startMinimized: false, closeToTray: true }, 'start-minimized setter returns native read-back');
  A.eq(await Lifecycle.setCloseToTray(false, { win }), { startMinimized: true, closeToTray: false }, 'close-to-tray setter returns native read-back');
  A.eq(calls.map(call => call.command), ['starnet_lifecycle_status', 'starnet_set_start_minimized', 'starnet_set_close_to_tray'], 'bridge calls only the three lifecycle commands');

  const browser = await Lifecycle.status({ win: {} });
  A.eq(browser, { supervised: false, armed: false, reasons: [], startMinimized: false, closeToTray: false }, 'browser preview claims no native background preferences');

  const main = read('src-tauri/src/main.rs');
  const prefs = read('src-tauri/src/lifecycle_preferences.rs');
  const settings = read('frontend/app/stationui.js');
  A.ok(/mod lifecycle_preferences;/.test(main), 'desktop shell owns one focused lifecycle-preference module');
  A.ok(/starnet_set_start_minimized[\s\S]*starnet_set_close_to_tray/.test(main), 'both native preference commands are registered');
  A.ok(/StartupReveal::new\(start_minimized\)/.test(main), 'stored start-minimized choice gates initial window reveal');
  A.ok(/payload\.event\(\) == tauri::webview::PageLoadEvent::Finished[\s\S]{0,250}startup_reveal\.finish_load\(\)[\s\S]{0,80}window\.show\(\)/.test(main), 'only the first completed document load may auto-reveal the window');
  A.ok(/WindowEvent::CloseRequested[\s\S]{0,250}startup_reveal\.cancel\(\)[\s\S]{0,300}win\.hide\(\)/.test(main), 'closing cancels any delayed startup reveal before hiding');
  A.ok(/close_to_tray\s*=\s*lifecycle_preferences_snapshot\(st\)\.close_to_tray[\s\S]{0,500}?if close_to_tray[\s\S]{0,500}?stay_resident_or_quit[\s\S]{0,120}?return;/.test(main), 'stored close-to-tray choice keeps the supervised process alive before armed-work probing — via the revealable-residency invariant');
  A.ok(/fn stay_resident_or_quit[\s\S]{0,800}?close_exit_pending\.store\(false[\s\S]{0,800}?get_webview_window\("main"\)[\s\S]{0,2000}?drain_and_kill_sidecar[\s\S]{0,200}?app\.exit\(0\)/.test(main), 'every stay-resident decision clears the exit veto and full-quits if the main window is gone (no unrevealable background process)');
  A.ok(/"lifecycle_quit"[\s\S]{0,400}?drain_and_kill_sidecar/.test(main), 'explicit tray Quit still drains and stops the sidecar');
  A.ok(/#\[cfg\(unix\)\][\s\S]*?fn terminate_sidecar_child[\s\S]*?SIGTERM[\s\S]*?child\.kill\(\)/.test(main), 'Unix Quit gives the owned sidecar a graceful stop before the force-kill fallback');
  A.ok(/#\[cfg\(target_os = "macos"\)\][\s\S]*?fn reap_orphan_sidecars[\s\S]*?proc_listallpids[\s\S]*?mac_process_image_path\(pid\)[\s\S]*?SIGTERM[\s\S]*?SIGKILL/.test(main), 'macOS boot reaps only processes proven to use the exact bundled Node image');
  A.ok(/save_verified[\s\S]*read_exact\(path\)/.test(prefs), 'native preferences require exact read-back before success');
  A.ok(/id="set-start-minimized"/.test(settings) && /Lifecycle\.setStartMinimized/.test(settings), 'Settings renders and wires START MINIMIZED TO TRAY');
  A.ok(/id="set-close-to-tray"/.test(settings) && /Lifecycle\.setCloseToTray/.test(settings), 'Settings renders and wires CLOSE WINDOW TO TRAY');
  A.ok(/close_exit_pending\.store\(true[\s\S]*RunEvent::ExitRequested\s*\{\s*api,\s*code[\s\S]*close_exit_pending\.swap\(false[\s\S]*api\.prevent_exit\(\)/.test(main), 'only a paired main-window close prevents event-loop exit while the close worker decides');

  A.report('desktop-lifecycle-preferences');
})().catch(error => { console.error(error); process.exit(1); });
