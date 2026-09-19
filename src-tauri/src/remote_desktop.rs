//! One desktop app, with the original local shell and an isolated remote viewer.
//! Remote and setup documents never receive the local window's initialization script or IPC.
use super::*;
use std::io::Write;
use std::process::Stdio;
use tauri::menu::Submenu;
use tauri_plugin_dialog::DialogExt;

const SETUP_PORT: u16 = 18790;
const SETUP_LABEL: &str = "station-connection";
const REMOTE_LABEL: &str = "station-remote";

pub struct DesktopState {
    helper: Mutex<Option<Child>>,
    selected: Mutex<String>,
    preference: PathBuf,
    remote_label: Mutex<Option<String>>,
    pub local_started: AtomicBool,
    busy: AtomicBool,
    exit_pending: AtomicBool,
    exit_ready: AtomicBool,
}

fn preference(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("station-location.json")
}

pub fn enabled(root: &Path) -> bool {
    cfg!(target_os = "macos") && root.join("remote/desktop.js").is_file()
}

fn location_choice(saved: Option<&str>, remote_exists: bool, local_exists: bool) -> &'static str {
    match saved {
        Some("local") => "local",
        Some("remote") => "remote",
        _ if remote_exists => "remote",
        _ if local_exists => "local",
        _ => "setup",
    }
}

pub fn allows_native_commands(label: &str, url: &tauri::Url) -> bool {
    label == "main"
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || ((url.scheme() == "http" || url.scheme() == "https")
                && url.host_str() == Some("tauri.localhost")))
}

pub fn initial_choice(app: &AppHandle, root: &Path, workspaces: &Path) -> String {
    if !enabled(root) {
        return "local".into();
    }
    let saved = std::fs::read(preference(app))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<String>(&bytes).ok());
    let remote_exists = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".config/starnet-remote/config.json").is_file())
        .unwrap_or(false);
    location_choice(
        saved.as_deref(),
        remote_exists,
        workspaces.join("agent.save.json").is_file(),
    )
    .into()
}

pub fn install(app: &AppHandle, choice: &str) {
    app.manage(DesktopState {
        helper: Mutex::new(None),
        selected: Mutex::new(choice.into()),
        preference: preference(app),
        remote_label: Mutex::new(None),
        local_started: AtomicBool::new(choice == "local"),
        busy: AtomicBool::new(false),
        exit_pending: AtomicBool::new(false),
        exit_ready: AtomicBool::new(false),
    });
}

pub fn local_started(app: &AppHandle) -> bool {
    app.try_state::<DesktopState>()
        .map(|state| state.local_started.load(Ordering::SeqCst))
        .unwrap_or(true)
}

fn select(app: &AppHandle, choice: &str) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    let mut selected = state
        .selected
        .lock()
        .map_err(|_| "Station preferences are busy")?;
    let parent = state
        .preference
        .parent()
        .ok_or("Station preferences are unavailable")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = state.preference.with_extension("tmp");
    let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(choice).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(temp, &state.preference).map_err(|e| e.to_string())?;
    *selected = choice.into();
    Ok(())
}

fn helper_json(port: u16, route: &str) -> Result<serde_json::Value, String> {
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_secs(1),
    )
    .map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    write!(
        stream,
        "GET {route} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    stream
        .take(65536)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if super::parse_sidecar_status(&bytes)? != 200 {
        return Err("Station is still connecting".into());
    }
    let offset = bytes
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .ok_or("Incomplete connection response")?
        + 4;
    serde_json::from_slice(&bytes[offset..]).map_err(|e| e.to_string())
}

fn start_helper(app: &AppHandle) -> Result<(), String> {
    let desktop = app.state::<DesktopState>();
    let mut slot = desktop
        .helper
        .lock()
        .map_err(|_| "Connection helper is busy")?;
    let running = match slot.as_mut() {
        Some(child) => child.try_wait().map_err(|e| e.to_string())?.is_none(),
        None => false,
    };
    if !running {
        if TcpStream::connect(("127.0.0.1", SETUP_PORT)).is_ok() {
            return Err(
                "Another StarNet viewer is open. Close it, then open Connection Setup again."
                    .into(),
            );
        }
        let state = app.state::<AppState>();
        let bin = state.root.join("bin");
        let path = format!(
            "{}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:{}",
            bin.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let child = Command::new(node_binary(&state.root))
            .arg(state.root.join("remote/desktop.js"))
            .env("PATH", path)
            .env("STARNET_UNIFIED_DESKTOP", "1")
            .env("STARNET_DESKTOP_STDIN_LIFETIME", "1")
            // EOF lets the helper close its SSH client even if the native app crashes.
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        *slot = Some(child);
    }
    drop(slot);
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if helper_json(SETUP_PORT, "/health").is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("Connection Setup could not start. You can still choose This Computer from the Station menu.".into())
}

fn report(app: &AppHandle, message: String) {
    app.dialog()
        .message(message)
        .title("StarNet connection")
        .show(|_| {});
}

fn focus(app: &AppHandle, label: &str) -> bool {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return true;
    }
    false
}

pub fn reveal(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<DesktopState>() else {
        return false;
    };
    let choice = state.selected.lock().map(|s| s.clone()).unwrap_or_default();
    if choice == "remote" {
        if let Some(label) = state
            .remote_label
            .lock()
            .ok()
            .and_then(|label| label.clone())
        {
            if focus(app, &label) {
                return true;
            }
        }
    }
    if choice == "setup" && focus(app, SETUP_LABEL) {
        return true;
    }
    false
}

pub fn can_reveal_main(app: &AppHandle) -> bool {
    !app.webview_windows()
        .keys()
        .any(|label| label == SETUP_LABEL || label.starts_with(REMOTE_LABEL))
        || app
            .state::<DesktopState>()
            .selected
            .lock()
            .map(|s| s.as_str() == "local")
            .unwrap_or(false)
}

fn close_station(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        // Keep the original local background-work / close-to-tray decision.
        let _ = main.close();
    } else {
        // Remote-only launches retire their placeholder. ExitRequested still
        // flushes the viewer and stops its helper, leaving the server running.
        app.exit(0);
    }
}

fn retire_startup_window(app: &AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let url = main.url().map_err(|e| e.to_string())?;
        if url.path() == "/station-host.html" {
            // Hiding leaves a native window in switchers (or an empty full-screen
            // space). Destroy skips CloseRequested, which would quit the app.
            main.destroy().map_err(|e| e.to_string())?;
        } else {
            main.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn show_setup_window(app: &AppHandle) -> Result<(), String> {
    if focus(app, SETUP_LABEL) {
        retire_startup_window(app)?;
        return Ok(());
    }
    let handle = app.clone();
    let close_handle = app.clone();
    let window = WebviewWindowBuilder::new(
        app,
        SETUP_LABEL,
        WebviewUrl::External(format!("http://127.0.0.1:{SETUP_PORT}/").parse().unwrap()),
    )
    .title("StarNet")
    .inner_size(1280.0, 832.0)
    .min_inner_size(960.0, 700.0)
    .center()
    .initialization_script("window.__TAURI__=undefined;")
    .on_navigation(move |url| {
        if url.scheme() == "starnet-connect" {
            let target = url.host_str().unwrap_or("");
            if target == "local" {
                choose_local(handle.clone());
            }
            if target == "remote" {
                choose_remote(handle.clone());
            }
            return false;
        }
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port() == Some(SETUP_PORT)
    })
    .build()
    .map_err(|e| e.to_string())?;
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(window) = close_handle.get_webview_window(SETUP_LABEL) {
                let _ = window.hide();
            }
            let selected = close_handle
                .state::<DesktopState>()
                .selected
                .lock()
                .map(|s| s.clone())
                .unwrap_or_default();
            if selected == "remote" {
                reveal(&close_handle);
            } else if local_started(&close_handle) {
                focus(&close_handle, "main");
            } else {
                close_station(&close_handle);
            }
        }
    });
    retire_startup_window(app)?;
    let _ = window.set_focus();
    Ok(())
}

pub fn show_setup(app: AppHandle) {
    std::thread::spawn(move || {
        flush_remote(&app);
        if let Err(error) = start_helper(&app) {
            report(&app, error);
            return;
        }
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Err(error) = show_setup_window(&handle) {
                report(&handle, error);
            }
        });
    });
}

fn station_port() -> Result<u16, String> {
    let health = helper_json(SETUP_PORT, "/health")?;
    if health["configured"] != true {
        return Err("Choose a computer and connect first.".into());
    }
    let port = health["port"]
        .as_u64()
        .filter(|port| (1024..=65535).contains(port) && *port != u64::from(SETUP_PORT))
        .ok_or("Invalid station address")? as u16;
    helper_json(port, "/remote/status")?;
    Ok(port)
}

// Saving setup restarts the proxy asynchronously. Opening immediately must wait
// for SSH/login readiness just like a saved remote launch does.
fn wait_station_port() -> Result<u16, String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match station_port() {
            Ok(port) => return Ok(port),
            Err(error) if Instant::now() >= deadline => return Err(error),
            Err(_) => std::thread::sleep(Duration::from_millis(200)),
        }
    }
}

fn show_remote_window(app: &AppHandle, port: u16) -> Result<(), String> {
    let url: tauri::Url = format!("http://127.0.0.1:{port}/").parse().unwrap();
    let label = format!("{REMOTE_LABEL}-{port}");
    if let Some(window) = app.get_webview_window(&label) {
        if window.url().map_err(|e| e.to_string())?.origin() != url.origin() {
            window.navigate(url).map_err(|e| e.to_string())?;
        }
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        let closing = app.clone();
        let closing_label = label.clone();
        let navigation = app.clone();
        let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
            .title("StarNet")
            .inner_size(1280.0, 832.0)
            .min_inner_size(960.0, 600.0)
            .center()
            .initialization_script("window.__TAURI__=undefined; window.__STARNET_NATIVE__=true; window.__STARNET_CONNECTION_SETUP__=true;")
            .on_navigation(move |url| {
                // The remote document can open the isolated chooser, but cannot
                // perform local setup/admin actions or invoke native commands.
                if matches!(url.as_str(), "starnet-connect://setup" | "starnet-connect://setup/") {
                    show_setup(navigation.clone());
                    return false;
                }
                url.scheme() == "http"
                    && url.host_str() == Some("127.0.0.1")
                    && url.port() == Some(port)
            })
            .build()
            .map_err(|e| e.to_string())?;
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Some(remote) = closing.get_webview_window(&closing_label) {
                    let _ = remote.hide();
                }
                close_station(&closing);
            }
        });
        let _ = window.set_focus();
    }
    *app.state::<DesktopState>()
        .remote_label
        .lock()
        .map_err(|_| "Station selection is busy")? = Some(label.clone());
    for (other, window) in app.webview_windows() {
        if other.starts_with(REMOTE_LABEL) && other != label {
            let _ = window.hide();
        }
    }
    select(app, "remote")?;
    retire_startup_window(app)?;
    if let Some(setup) = app.get_webview_window(SETUP_LABEL) {
        let _ = setup.hide();
    }
    Ok(())
}

fn choose_remote(app: AppHandle) {
    if app
        .state::<DesktopState>()
        .busy
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    std::thread::spawn(move || {
        let result = start_helper(&app).and_then(|_| wait_station_port());
        match result {
            Ok(port) => {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Err(error) = show_remote_window(&handle, port) {
                        report(&handle, error);
                    }
                    handle
                        .state::<DesktopState>()
                        .busy
                        .store(false, Ordering::SeqCst);
                });
            }
            Err(error) => {
                app.state::<DesktopState>()
                    .busy
                    .store(false, Ordering::SeqCst);
                report(&app, error);
            }
        }
    });
}

pub fn choose_local(app: AppHandle) {
    let state = app.state::<DesktopState>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let desktop = app.state::<DesktopState>();
        if !desktop.local_started.load(Ordering::SeqCst) {
            let state = app.state::<AppState>();
            state.recovery_in_progress.store(true, Ordering::SeqCst);
            desktop.local_started.store(true, Ordering::SeqCst);
            let ready = spawn_sidecar(state.inner());
            state.recovery_in_progress.store(false, Ordering::SeqCst);
            if !ready {
                desktop.busy.store(false, Ordering::SeqCst);
                report(
                    &app,
                    "The local station is still starting. Try This Computer again in a moment."
                        .into(),
                );
                return;
            }
        }
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let result = (|| -> Result<(), String> {
                select(&handle, "local")?;
                let main = match handle.get_webview_window("main") {
                    Some(window) => window,
                    None => super::build_main_window(&handle, "local")
                        .map_err(|e| e.to_string())?,
                };
                let mut url = main.url().map_err(|e| e.to_string())?;
                if url.path().ends_with("station-host.html") {
                    url.set_path("/index.html");
                    main.navigate(url).map_err(|e| e.to_string())?;
                }
                for (label, window) in handle.webview_windows() {
                    if label == SETUP_LABEL || label.starts_with(REMOTE_LABEL) {
                        let _ = window.hide();
                    }
                }
                let _ = main.show();
                let _ = main.set_focus();
                Ok(())
            })();
            handle
                .state::<DesktopState>()
                .busy
                .store(false, Ordering::SeqCst);
            if let Err(error) = result {
                report(&handle, error);
            }
        });
    });
}

pub fn boot(app: &AppHandle, choice: &str) -> Result<(), Box<dyn std::error::Error>> {
    if !enabled(&app.state::<AppState>().root) {
        return Ok(());
    }
    let setup = MenuItem::with_id(
        app,
        "station_setup",
        "Connection Setup…",
        true,
        Some("CmdOrCtrl+K"),
    )?;
    let local = MenuItem::with_id(
        app,
        "station_local",
        "Use This Computer",
        true,
        None::<&str>,
    )?;
    let station = Submenu::with_items(app, "Station", true, &[&setup, &local])?;
    let menu = app.menu().unwrap_or(Menu::default(app)?);
    menu.append(&station)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| match event.id().as_ref() {
        "station_setup" => show_setup(app.clone()),
        "station_local" => choose_local(app.clone()),
        _ => {}
    });
    let monitor = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(4));
        if monitor
            .state::<AppState>()
            .shutting_down
            .load(Ordering::SeqCst)
        {
            break;
        }
        let exited = monitor
            .state::<DesktopState>()
            .helper
            .lock()
            .ok()
            .and_then(|mut slot| {
                slot.as_mut()
                    .and_then(|child| child.try_wait().ok().flatten())
            })
            .is_some();
        // The existing page's SSE connection recovers; never reload its editors.
        if exited {
            let _ = start_helper(&monitor);
        }
    });
    if choice == "remote" {
        let app = app.clone();
        std::thread::spawn(move || {
            if let Err(error) = start_helper(&app) {
                report(&app, error);
                return;
            }
            let deadline = Instant::now() + Duration::from_secs(20);
            while Instant::now() < deadline {
                if let Ok(port) = station_port() {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        if handle
                            .state::<DesktopState>()
                            .selected
                            .lock()
                            .map(|s| s.as_str() != "remote")
                            .unwrap_or(true)
                        {
                            return;
                        }
                        if let Err(error) = show_remote_window(&handle, port) {
                            report(&handle, error);
                        }
                    });
                    return;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            if app
                .state::<DesktopState>()
                .selected
                .lock()
                .map(|s| s.as_str() == "remote")
                .unwrap_or(false)
            {
                show_setup(app);
            }
        });
    } else if choice == "setup" {
        show_setup(app.clone());
    }
    Ok(())
}

/// Flush on a worker, with a bounded wait. Offline saves remain in CloudSave's
/// local recovery cache. The page gets no native command or shutdown authority.
fn flush_remote(app: &AppHandle) {
    let windows: Vec<_> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with(REMOTE_LABEL))
        .map(|(_, window)| window)
        .collect();
    if windows.is_empty() {
        return;
    }
    let id = uuid::Uuid::new_v4().to_string();
    let script = format!("(async()=>{{try{{if(typeof App!=='undefined') App.persist(); if(typeof CloudSave!=='undefined') await CloudSave.flushForUpdate();}}finally{{window.__stationFlush={id:?};}}}})();");
    for window in &windows {
        let _ = window.eval(&script);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let mut done = true;
        for window in &windows {
            let (tx, rx) = std::sync::mpsc::channel();
            let _ = window.eval_with_callback(
                format!("window.__stationFlush==={id:?}"),
                move |value| {
                    let _ = tx.send(value);
                },
            );
            if rx.recv_timeout(Duration::from_millis(100)).ok().as_deref() != Some("true") {
                done = false;
            }
        }
        if done {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

pub fn defer_exit(app: &AppHandle, code: Option<i32>) -> bool {
    let Some(state) = app.try_state::<DesktopState>() else {
        return false;
    };
    if state.exit_ready.load(Ordering::SeqCst)
        || !app
            .webview_windows()
            .keys()
            .any(|label| label.starts_with(REMOTE_LABEL))
    {
        return false;
    }
    if !state.exit_pending.swap(true, Ordering::SeqCst) {
        let app = app.clone();
        std::thread::spawn(move || {
            flush_remote(&app);
            app.state::<DesktopState>()
                .exit_ready
                .store(true, Ordering::SeqCst);
            app.exit(code.unwrap_or(0));
        });
    }
    true
}

pub fn tray_status(app: &AppHandle) -> Option<(&'static str, &'static str)> {
    if local_started(app) {
        return None;
    }
    let state = app.try_state::<DesktopState>()?;
    let remote = state.selected.lock().ok()?.as_str() == "remote";
    Some(if remote {
        (
            "StarNet · Remote uplink",
            "Remote station: closing this app leaves the server running",
        )
    } else {
        (
            "StarNet · Choose a station",
            "Choose this computer or a remote station",
        )
    })
}

pub fn stop(app: &AppHandle) {
    if let Some(state) = app.try_state::<DesktopState>() {
        if let Ok(mut child) = state.helper.lock() {
            if let Some(mut child) = child.take() {
                super::terminate_sidecar_child(&mut child);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_stations_resume_and_fresh_users_get_the_chooser() {
        assert_eq!(location_choice(None, false, false), "setup");
        assert_eq!(location_choice(None, true, false), "remote");
        assert_eq!(location_choice(None, false, true), "local");
        assert_eq!(location_choice(Some("local"), true, true), "local");
        assert_eq!(location_choice(Some("remote"), true, true), "remote");
        assert_eq!(location_choice(Some("invalid"), false, false), "setup");
    }
    #[test]
    fn only_the_bundled_local_window_can_call_native_commands() {
        for source in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/index.html",
        ] {
            let url = source.parse().unwrap();
            assert!(allows_native_commands("main", &url));
            assert!(!allows_native_commands(SETUP_LABEL, &url));
            assert!(!allows_native_commands("station-remote-8790", &url));
        }
        for source in [
            "http://127.0.0.1:8790/",
            "http://127.0.0.1:18790/",
            "https://example.com/",
            "tauri://example.com/",
        ] {
            assert!(!allows_native_commands("main", &source.parse().unwrap()));
        }
    }
}
