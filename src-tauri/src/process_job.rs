//! One kill-on-close Job Object per station sidecar (Windows): the station never outlives the shell, even a hard-killed
//! one, and what it leaves behind is ended on purpose rather than found by a reaper at the next boot.
//!
//! WHY: a shell killed hard (crash, End Task, `taskkill /F`, an installer stopping it) runs none of its stop code, so its
//! sidecar used to keep running — holding the workspace claim, the Codex token file and the station browser — until the
//! next boot's reaper found it (#31: seven orphaned node.exe at once). And a sidecar that is itself terminated (RESTART,
//! START FRESH, a timed-out boot, a crash) leaves its own children behind: Node's built-in job only ends its DIRECT
//! children, so a command behind cmd.exe (an MCP server started through `cmd /c npx`, a dev server, a self-detached
//! `Start-Process` child — qa bug 1ac8819d) kept running with nobody to stop it.
//!
//! THE RULES, per process the station tree can hold:
//!   - the sidecar, the station browser, MCP / LSP servers, agent shells and their background jobs, PTY terminals, CLI
//!     provider processes (claude / codex), plugin workers: the STATION's. They are in the job, so they end with the shell
//!     (KILL_ON_JOB_CLOSE) and with every stop of the sidecar (`end_leftovers`). The station's own windows — a window
//!     shown by a DIRECT child of the sidecar, i.e. the station browser (browser.js spawns it) — are the station's too.
//!   - an app the station opened ON PURPOSE for the person (desktop.open, a Resolve launch, a full-power shell command that
//!     opens a window: sidecar/breakaway.js routes them through `--starnet-breakaway`): created with
//!     CREATE_BREAKAWAY_FROM_JOB, so it is never in the job and survives everything, as an app the person opened would.
//!   - a station program that opens something FOR the person (`claude auth login` starts the person's browser when it
//!     is not running): launched TETHERED — outside the job, yet ended with its launcher (a cancel, a stop, a hard
//!     kill); what it opened is in no job at all and lives on.
//!   - anything else in the job that shows a window on the person's screen when the sidecar is stopped (an app opened some
//!     other way, e.g. `code .` in a StarNet terminal): SPARED by `end_leftovers` WITH ITS WHOLE PROCESS TREE (a
//!     multi-process app's renderers, GPU and extension hosts own no window of their own), and the job's kill-on-close is
//!     released so that tree survives the job's close. "Shows a window" means a visible, uncloaked, non-tool top-level
//!     window bigger than a helper's (or minimized). A crash of the shell itself cannot make that judgement: those die
//!     with it (stated, not fixed — only a breakaway launch survives a crash).
//!   - the update installer, folder / link openers and every other process the SHELL starts: never in the job (only the
//!     sidecar is assigned), so a quit or an update never touches them.
//!   - the `starnet` terminal: never the station's child, never in the job.
//! Assignment happens right after the sidecar is created; the sidecar starts no child of its own in that window (Node
//! takes far longer than one call to boot), so the whole tree is inside. A shell already running inside a job that
//! forbids nesting or breakaway still works: assignment then fails open (logged) and the reaper / parent watch remain.

#[cfg(windows)]
use windows_sys::Win32::Foundation::HANDLE;

/// One process the station's job still held when it was swept.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct Member {
    pub pid: u32,
    pub image: String,
}

/// What `end_leftovers` did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Leftovers {
    /// windowless processes the stopped station left behind, ended
    pub ended: Vec<Member>,
    /// processes left running and released from the job, each with the PID whose window on the person's screen spared
    /// it (itself, or the app it belongs to)
    pub spared: Vec<(Member, u32)>,
    /// processes that could not be ended (already gone, access denied), with why
    pub failed: Vec<(Member, String)>,
}

impl Leftovers {
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_empty(&self) -> bool {
        self.ended.is_empty() && self.spared.is_empty() && self.failed.is_empty()
    }

    /// One startup.log line per process, so every decision about a process is on record.
    pub fn log_lines(&self, what: &str) -> Vec<String> {
        let mut out = Vec::new();
        for m in &self.ended {
            out.push(format!("{what}: ended pid={} ({}) — left behind by the stopped station", m.pid, m.image));
        }
        for (m, window) in &self.spared {
            out.push(if *window == m.pid {
                format!(
                    "{what}: spared pid={} ({}) — it shows a window on the user's screen; released from the station",
                    m.pid, m.image
                )
            } else {
                format!(
                    "{what}: spared pid={} ({}) — part of pid {window}'s app, which shows a window on the user's screen; released from the station",
                    m.pid, m.image
                )
            });
        }
        for (m, why) in &self.failed {
            out.push(format!("{what}: could not end pid={} ({}) — {why}", m.pid, m.image));
        }
        out
    }
}

/// The station's Job Object. Dropping it closes the handle: with kill-on-close still set (no window was spared), the OS
/// ends every member — exactly what a hard kill of the shell does. (Off Windows it is never created.)
#[cfg_attr(not(windows), allow(dead_code))]
pub struct ProcessJob {
    #[cfg(windows)]
    handle: HANDLE,
}

// The handle is an owned kernel object handle; Windows job APIs are thread-safe.
#[cfg(windows)]
unsafe impl Send for ProcessJob {}
#[cfg(windows)]
unsafe impl Sync for ProcessJob {}

impl std::fmt::Debug for ProcessJob {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ProcessJob")
    }
}

#[cfg(windows)]
impl ProcessJob {
    /// A new job whose members die when its last handle closes, and which lets a deliberate breakaway out.
    pub fn for_station() -> std::io::Result<Self> {
        Self::with_limits(
            windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                | windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_BREAKAWAY_OK,
        )
    }

    fn with_limits(flags: u32) -> std::io::Result<Self> {
        use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let job = ProcessJob { handle };
        job.set_limit_flags(flags)?; // on error the drop closes the handle
        Ok(job)
    }

    fn set_limit_flags(&self, flags: u32) -> std::io::Result<()> {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        };
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = flags;
        let ok = unsafe {
            SetInformationJobObject(
                self.handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    /// Put a just-spawned child (and so every process it starts from now on) in the job.
    pub fn assign(&self, child: &std::process::Child) -> std::io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        if unsafe { AssignProcessToJobObject(self.handle, child.as_raw_handle() as HANDLE) } == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    /// The PIDs the job holds right now (live members only).
    pub fn members(&self) -> Vec<u32> {
        use windows_sys::Win32::System::JobObjects::{JobObjectBasicProcessIdList, QueryInformationJobObject};
        let header = 8 / std::mem::size_of::<usize>().min(8);
        let mut capacity = 256usize;
        loop {
            let mut buf = vec![0usize; header.max(1) + capacity];
            let ok = unsafe {
                QueryInformationJobObject(
                    self.handle,
                    JobObjectBasicProcessIdList,
                    buf.as_mut_ptr() as *mut core::ffi::c_void,
                    (buf.len() * std::mem::size_of::<usize>()) as u32,
                    std::ptr::null_mut(),
                )
            };
            let counts = buf.as_ptr() as *const u32;
            let (assigned, listed) = unsafe { (*counts as usize, *counts.add(1) as usize) };
            if ok == 0 && assigned <= capacity {
                return Vec::new();
            }
            if assigned > listed && capacity < 65_536 {
                capacity = assigned + 64;
                continue;
            }
            return buf[header.max(1)..header.max(1) + listed.min(capacity)].iter().map(|p| *p as u32).collect();
        }
    }

    /// Is `pid` (its current process) in this job?
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn contains(&self, pid: u32) -> bool {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::IsProcessInJob;
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return false;
        }
        let mut inside = 0;
        let ok = unsafe { IsProcessInJob(process, self.handle, &mut inside) };
        unsafe { CloseHandle(process) };
        ok != 0 && inside != 0
    }

    /// The station has stopped: end every member it left behind, except an app showing a window on the person's
    /// screen, which is spared with its whole process tree — and then the job no longer kills on close, so dropping it
    /// leaves that app alone. `root` is the stopped sidecar: a window shown by its DIRECT child is the station's own (the
    /// station browser) and spares nothing.
    pub fn end_leftovers(&self, root: Option<StationRoot>) -> Leftovers {
        let windows = visible_window_pids();
        self.end_leftovers_with(root, &|pid| windows.contains(&pid))
    }

    pub fn end_leftovers_with(&self, root: Option<StationRoot>, shows_window: &dyn Fn(u32) -> bool) -> Leftovers {
        let mut out = Leftovers::default();
        self.sweep(root, shows_window, &mut out);
        if !out.spared.is_empty() {
            // keep breakaway allowed, drop kill-on-close: the spared apps outlive this job's handle. Then sweep once
            // more, so nothing the first pass could not see yet (started by a member it was ending) rides on that release.
            let _ = self.set_limit_flags(windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_BREAKAWAY_OK);
            self.sweep(root, shows_window, &mut out);
        }
        out
    }

    /// One pass: decide every current member (`spared_members`), end the rest. Records each PID once.
    fn sweep(&self, root: Option<StationRoot>, shows_window: &dyn Fn(u32) -> bool, out: &mut Leftovers) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::IsProcessInJob;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
        };
        let own = std::process::id();
        let members: Vec<u32> = self.members().into_iter().filter(|pid| *pid != own).collect();
        if members.is_empty() {
            return;
        }
        // parent links and creation times for the whole list (no handle needed); none = only windows themselves count
        let table: std::collections::HashMap<u32, (u32, u64)> = crate::process_identity::system_processes()
            .unwrap_or_default()
            .into_iter()
            .map(|p| (p.pid, (p.parent, p.created)))
            .collect();
        let spared = spared_members(&members, &table, root, shows_window);
        let recorded = |out: &Leftovers, pid: u32| {
            out.ended.iter().any(|m| m.pid == pid)
                || out.spared.iter().any(|(m, _)| m.pid == pid)
                || out.failed.iter().any(|(m, _)| m.pid == pid)
        };
        for pid in members {
            let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, 0, pid) };
            if process.is_null() {
                let error = std::io::Error::last_os_error();
                if !recorded(out, pid) {
                    out.failed.push((Member { pid, image: String::new() }, format!("could not open it ({error})")));
                }
                continue;
            }
            let image = crate::process_identity::windows_image(process)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            let member = Member { pid, image };
            // the handle the kill goes through must still be a member: a PID reused since the listing is never touched
            let mut inside = 0;
            let still_member = unsafe { IsProcessInJob(process, self.handle, &mut inside) } != 0 && inside != 0;
            if !still_member {
                unsafe { CloseHandle(process) };
                continue;
            }
            if let Some(window) = spared.get(&pid) {
                if !recorded(out, pid) {
                    out.spared.push((member, *window));
                }
            } else if unsafe { TerminateProcess(process, 1) } != 0 {
                if !recorded(out, pid) {
                    out.ended.push(member);
                }
            } else {
                let error = std::io::Error::last_os_error();
                if !recorded(out, pid) {
                    out.failed.push((member, format!("TerminateProcess failed ({error})")));
                }
            }
            unsafe { CloseHandle(process) };
        }
    }
}

/// The process the station's tree grew from — the sidecar — with its creation time (FILETIME ticks): a member is its
/// direct child only when the member's recorded parent is that PID AND it was created after it (PIDs are reused).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StationRoot {
    pub pid: u32,
    pub created: u64,
}

/// Which members a stop spares, each with the PID whose window spares it. An ANCHOR is a member that shows a window on
/// the person's screen, unless it is a direct child of the station root (the station's own window: its browser). Every
/// member whose chain of parents reaches an anchor is spared with it — a multi-process app (a browser, VS Code, any
/// Electron app) keeps its renderer, GPU and extension-host processes, which own no window themselves. A parent link
/// counts only between two members, and only when the parent was created no later than the child (a PID reused by a
/// newer process is not anyone's parent). `table` maps pid → (parent pid, creation time); a member missing from it has
/// no known parent.
#[cfg_attr(not(any(test, windows)), allow(dead_code))]
pub fn spared_members(
    members: &[u32],
    table: &std::collections::HashMap<u32, (u32, u64)>,
    root: Option<StationRoot>,
    shows_window: &dyn Fn(u32) -> bool,
) -> std::collections::HashMap<u32, u32> {
    let member: std::collections::HashSet<u32> = members.iter().copied().collect();
    let station_child = |pid: u32| {
        root.zip(table.get(&pid)).is_some_and(|(r, (parent, created))| *parent == r.pid && *created >= r.created)
    };
    let anchor = |pid: u32| shows_window(pid) && !station_child(pid);
    let mut out = std::collections::HashMap::new();
    for &pid in members {
        let mut at = pid;
        for _ in 0..64 {
            if anchor(at) {
                out.insert(pid, at);
                break;
            }
            let Some(&(parent, created)) = table.get(&at) else { break };
            if parent == at || !member.contains(&parent) {
                break;
            }
            match table.get(&parent) {
                Some(&(_, parent_created)) if parent_created <= created => at = parent,
                _ => break,
            }
        }
    }
    out
}

#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

#[cfg(not(windows))]
impl ProcessJob {
    /// No Job Objects off Windows: the sidecar's own parent watch (sidecar/parent-watch.js) ends it with the shell.
    pub fn for_station() -> std::io::Result<Self> {
        Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "Job Objects are Windows-only"))
    }
    pub fn assign(&self, _child: &std::process::Child) -> std::io::Result<()> {
        Ok(())
    }
    pub fn end_leftovers(&self, _root: Option<StationRoot>) -> Leftovers {
        Leftovers::default()
    }
}

/// One top-level window, as far as "is it on the person's screen" goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowFacts {
    pub visible: bool,
    /// DWM keeps it off screen (another virtual desktop, a suspended UWP frame)
    pub cloaked: bool,
    /// WS_EX_TOOLWINDOW: a helper's frame that never reaches the taskbar or Alt+Tab
    pub tool: bool,
    /// a layered window whose constant alpha is 0
    pub transparent: bool,
    pub minimized: bool,
    pub width: i32,
    pub height: i32,
}

/// The smallest window that counts as one the person works in — larger than a 16×16 or 32×32 helper frame (the
/// 2026-10-25 desktop survey found the only visible-flagged windows of windowless helpers were 16×16 tool/transparent
/// frames: an IsWindowVisible-only test spares them).
pub const MIN_WINDOW_SIDE: i32 = 48;

/// Does this window put its process on the person's screen? Visible, not cloaked, not a tool frame, not fully
/// transparent, and either minimized (a minimized editor still holds unsaved work) or bigger than a helper's frame.
pub fn counts_as_on_screen(w: &WindowFacts) -> bool {
    w.visible
        && !w.cloaked
        && !w.tool
        && !w.transparent
        && (w.minimized || (w.width >= MIN_WINDOW_SIDE && w.height >= MIN_WINDOW_SIDE))
}

/// Every process that owns a top-level window on the person's screen right now (`counts_as_on_screen`).
#[cfg(windows)]
pub fn visible_window_pids() -> std::collections::HashSet<u32> {
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetLayeredWindowAttributes, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, IsIconic,
        IsWindowVisible, GWL_EXSTYLE, LWA_ALPHA, WS_EX_LAYERED, WS_EX_TOOLWINDOW,
    };
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let set = unsafe { &mut *(lparam as *mut std::collections::HashSet<u32>) };
        if unsafe { IsWindowVisible(hwnd) } == 0 {
            return 1;
        }
        let ex = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32;
        let mut cloaked = 0u32;
        let cloak_read = unsafe {
            DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED as u32, (&mut cloaked as *mut u32).cast(), std::mem::size_of::<u32>() as u32)
        } >= 0;
        let transparent = ex & WS_EX_LAYERED != 0 && {
            let (mut key, mut alpha, mut flags) = (0u32, 255u8, 0u32);
            let read = unsafe { GetLayeredWindowAttributes(hwnd, &mut key, &mut alpha, &mut flags) } != 0;
            read && flags & LWA_ALPHA != 0 && alpha == 0
        };
        let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        unsafe { GetWindowRect(hwnd, &mut rect) };
        let facts = WindowFacts {
            visible: true,
            cloaked: cloak_read && cloaked != 0,
            tool: ex & WS_EX_TOOLWINDOW != 0,
            transparent,
            minimized: unsafe { IsIconic(hwnd) } != 0,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
        };
        if counts_as_on_screen(&facts) {
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
            if pid != 0 {
                set.insert(pid);
            }
        }
        1
    }
    let mut set = std::collections::HashSet::new();
    unsafe { EnumWindows(Some(collect), &mut set as *mut _ as LPARAM) };
    set
}

// ---- the breakaway launcher -------------------------------------------------------------------------------------
//
// `skynet-desktop.exe --starnet-breakaway <hex JSON>` — how the sidecar opens an app FOR the person so that it is never
// the station's (sidecar/breakaway.js builds the call). The spec is { file, args, verbatim, hide }: exactly what Node's
// spawn would have run (`verbatim` = windowsVerbatimArguments, e.g. a `cmd /d /s /c "…"` shell line; `hide` =
// windowsHide). This process is itself in the station's job; it starts `file` with CREATE_BREAKAWAY_FROM_JOB, so that
// process and everything it starts is outside it. It inherits this process's stdio and environment, waits, and exits
// with the program's exit code, so the caller sees what it would have seen running the program directly. A job that
// refuses breakaway (an outer job without BREAKAWAY_OK) still gets the program run, inside the job. Hex keeps the spec
// clear of every quoting rule.
//
// TETHERED (`tether: true`): a program that is the station's own short-lived work but OPENS something for the person —
// `claude auth login` starts the person's browser when it is not already running. Outside the station's job (so the
// browser it opens is never the station's), yet tied to this launcher: it is placed in a job of its own that kills on
// close and lets its children break away SILENTLY. Ending the launcher (a cancelled sign-in's taskkill, the station's
// job closing on a hard kill) ends the program; what the program opened is in no job at all and lives on.

pub const BREAKAWAY_FLAG: &str = "--starnet-breakaway";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BreakawaySpec {
    pub file: String,
    pub args: Vec<String>,
    pub verbatim: bool,
    pub hide: bool,
    pub tether: bool,
}

pub fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    let hex = hex.trim();
    if hex.len() % 2 != 0 {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect()
}

pub fn parse_breakaway_spec(hex: &str) -> Option<BreakawaySpec> {
    let value: serde_json::Value = serde_json::from_slice(&decode_hex(hex)?).ok()?;
    let file = value.get("file")?.as_str()?.to_string();
    if file.is_empty() {
        return None;
    }
    let args = match value.get("args") {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::Array(items)) => {
            items.iter().map(|a| a.as_str().map(str::to_string)).collect::<Option<Vec<_>>>()?
        }
        Some(_) => return None,
    };
    Some(BreakawaySpec {
        file,
        args,
        verbatim: value.get("verbatim").and_then(|v| v.as_bool()).unwrap_or(false),
        hide: value.get("hide").and_then(|v| v.as_bool()).unwrap_or(false),
        tether: value.get("tether").and_then(|v| v.as_bool()).unwrap_or(false),
    })
}

/// When this process was started as the breakaway launcher, run it and return the exit code to exit with.
pub fn breakaway_main() -> Option<i32> {
    breakaway_main_from(std::env::args_os(), &run_breakaway)
}

/// The dispatch, on any argv: None unless the FIRST argument is exactly the flag — every other launch (a person
/// opening StarNet, `--background`, an updater relaunch) goes on to start the app as always.
pub fn breakaway_main_from(
    argv: impl IntoIterator<Item = std::ffi::OsString>,
    run: &dyn Fn(&BreakawaySpec) -> i32,
) -> Option<i32> {
    let mut args = argv.into_iter().skip(1);
    if args.next()?.to_str()? != BREAKAWAY_FLAG {
        return None;
    }
    let spec = args.next().and_then(|a| a.into_string().ok()).and_then(|hex| parse_breakaway_spec(&hex));
    Some(match spec {
        Some(spec) => run(&spec),
        None => {
            eprintln!("starnet-breakaway: unreadable launch spec");
            2
        }
    })
}

#[cfg(windows)]
fn breakaway_command(spec: &BreakawaySpec, breakaway: bool) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::{CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW};
    let mut cmd = std::process::Command::new(&spec.file);
    if spec.verbatim {
        // Node's windowsVerbatimArguments: the arguments joined by spaces, untouched
        if !spec.args.is_empty() {
            cmd.raw_arg(spec.args.join(" "));
        }
    } else {
        cmd.args(&spec.args);
    }
    let mut flags = 0;
    if breakaway {
        flags |= CREATE_BREAKAWAY_FROM_JOB;
    }
    if spec.hide {
        flags |= CREATE_NO_WINDOW;
    }
    cmd.creation_flags(flags);
    cmd
}

/// A job of the program's own: it dies when this launcher's handle closes, and whatever it starts silently breaks away.
#[cfg(windows)]
fn tether(child: &std::process::Child, file: &str) -> Option<ProcessJob> {
    use windows_sys::Win32::System::JobObjects::{JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK};
    let job = ProcessJob::with_limits(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK);
    match job.and_then(|job| job.assign(child).map(|()| job)) {
        Ok(job) => Some(job),
        Err(error) => {
            eprintln!("starnet-breakaway: {file} runs untethered ({error})");
            None
        }
    }
}

#[cfg(windows)]
pub fn run_breakaway(spec: &BreakawaySpec) -> i32 {
    // ERROR_ACCESS_DENIED: a job above ours does not allow breakaway — run it anyway, inside
    let (child, broke_away) = match breakaway_command(spec, true).spawn() {
        Err(error) if error.raw_os_error() == Some(5) => (breakaway_command(spec, false).spawn(), false),
        other => (other, true),
    };
    match child {
        Ok(mut child) => {
            // held until the program exits: dropping it (this launcher ending, however) ends a tethered program
            let _tether = if spec.tether && broke_away { tether(&child, &spec.file) } else { None };
            match child.wait() {
                Ok(status) => status.code().unwrap_or(1),
                Err(error) => {
                    eprintln!("starnet-breakaway: {error}");
                    1
                }
            }
        }
        Err(error) => {
            eprintln!("starnet-breakaway: could not start {}: {error}", spec.file);
            // the code Node reports for a program that could not be found
            if error.kind() == std::io::ErrorKind::NotFound {
                127
            } else {
                1
            }
        }
    }
}

#[cfg(not(windows))]
pub fn run_breakaway(spec: &BreakawaySpec) -> i32 {
    // no jobs to break away from: just run it
    match std::process::Command::new(&spec.file).args(&spec.args).status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(error) => {
            eprintln!("starnet-breakaway: could not start {}: {error}", spec.file);
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> String {
        s.bytes().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn a_breakaway_spec_round_trips_and_junk_is_refused() {
        let spec = parse_breakaway_spec(&hex(
            r#"{"file":"C:\\Windows\\system32\\cmd.exe","args":["/d","/s","/c","\"start \"\" notepad\""],"verbatim":true,"hide":true}"#,
        ))
        .expect("spec");
        assert_eq!(spec.file, "C:\\Windows\\system32\\cmd.exe");
        assert_eq!(spec.args, vec!["/d", "/s", "/c", "\"start \"\" notepad\""]);
        assert!(spec.verbatim && spec.hide);
        let bare = parse_breakaway_spec(&hex(r#"{"file":"resolve.exe"}"#)).unwrap();
        assert!(bare.args.is_empty() && !bare.verbatim && !bare.hide && !bare.tether);
        assert!(parse_breakaway_spec(&hex(r#"{"file":"claude.exe","tether":true}"#)).unwrap().tether);
        assert!(parse_breakaway_spec("zz").is_none(), "not hex");
        assert!(parse_breakaway_spec("abc").is_none(), "odd length");
        assert!(parse_breakaway_spec(&hex(r#"{"file":""}"#)).is_none(), "no program");
        assert!(parse_breakaway_spec(&hex(r#"{"file":"x","args":[1]}"#)).is_none(), "args are strings");
        assert!(parse_breakaway_spec(&hex("[]")).is_none());
        assert_eq!(decode_hex("4142"), Some(b"AB".to_vec()));
    }

    #[test]
    fn only_the_exact_flag_first_makes_this_process_the_launcher() {
        let os = |v: &[&str]| v.iter().map(std::ffi::OsString::from).collect::<Vec<_>>();
        let ran = std::cell::Cell::new(0);
        let run = |spec: &BreakawaySpec| {
            ran.set(ran.get() + 1);
            if spec.file == "resolve.exe" { 7 } else { 1 }
        };
        let spec = hex(r#"{"file":"resolve.exe"}"#);
        assert_eq!(breakaway_main_from(os(&["skynet-desktop.exe", BREAKAWAY_FLAG, &spec]), &run), Some(7), "the launcher runs the spec and exits with its code");
        assert_eq!(breakaway_main_from(os(&["skynet-desktop.exe", BREAKAWAY_FLAG, "zz"]), &run), Some(2), "an unreadable spec exits 2, never starts the app");
        assert_eq!(breakaway_main_from(os(&["skynet-desktop.exe", BREAKAWAY_FLAG]), &run), Some(2), "no spec exits 2 too");
        assert_eq!(ran.get(), 1, "only the readable spec ran anything");
        for argv in [&["skynet-desktop.exe"][..], &["skynet-desktop.exe", "--background", "--terminal-pid", "42"], &["skynet-desktop.exe", "x", BREAKAWAY_FLAG, &spec], &["skynet-desktop.exe", "--starnet-breakaway2", &spec]] {
            assert_eq!(breakaway_main_from(os(argv), &run), None, "{argv:?} starts the app as always");
        }
        assert_eq!(ran.get(), 1);
    }

    #[test]
    fn leftover_lines_name_every_process() {
        let report = Leftovers {
            ended: vec![Member { pid: 10, image: "C:\\x\\node.exe".into() }],
            spared: vec![
                (Member { pid: 11, image: "C:\\Apps\\Code.exe".into() }, 11),
                (Member { pid: 13, image: "C:\\Apps\\Code.exe".into() }, 11),
            ],
            failed: vec![(Member { pid: 12, image: String::new() }, "could not open it".into())],
        };
        let lines = report.log_lines("station-stop");
        assert_eq!(lines.len(), 4);
        assert!(lines[0].contains("ended pid=10") && lines[0].contains("left behind"));
        assert!(lines[1].contains("spared pid=11") && lines[1].contains("shows a window"));
        assert!(lines[2].contains("spared pid=13") && lines[2].contains("part of pid 11's app"), "{}", lines[2]);
        assert!(lines[3].contains("could not end pid=12"));
        assert!(Leftovers::default().is_empty());
    }

    /// The decision alone. Tree: station root 100 (created at 10) → 200 cmd (20) → 300 an editor's main process (30,
    /// window) → 301 / 302 its helpers (31, 32) → 303 a helper's helper (33); root → 400 the station browser (40, window,
    /// a DIRECT child) → 401 its renderer (41); root → 500 an MCP server (50); 700 (created at 25) names 300 as its
    /// parent although 300 is NEWER (a reused PID: no link).
    #[test]
    fn a_window_spares_its_whole_tree_and_the_station_browser_spares_nothing() {
        let table: std::collections::HashMap<u32, (u32, u64)> = [
            (200, (100, 20)),
            (300, (200, 30)),
            (301, (300, 31)),
            (302, (300, 32)),
            (303, (301, 33)),
            (400, (100, 40)),
            (401, (400, 41)),
            (500, (100, 50)),
            (700, (300, 25)),
        ]
        .into_iter()
        .collect();
        let members = [200, 300, 301, 302, 303, 400, 401, 500, 700];
        let root = Some(StationRoot { pid: 100, created: 10 });
        let windows = |pid: u32| pid == 300 || pid == 400;
        let mut got: Vec<(u32, u32)> = spared_members(&members, &table, root, &windows).into_iter().collect();
        got.sort();
        assert_eq!(got, vec![(300, 300), (301, 300), (302, 300), (303, 300)], "the editor and every helper under it, nothing else");
        // without a station root the browser is just another window
        let unrooted = spared_members(&members, &table, None, &windows);
        assert!(unrooted.contains_key(&400) && unrooted.get(&401) == Some(&400), "{unrooted:?}");
        // a root created AFTER the browser is not its parent (a reused root PID)
        let late_root = spared_members(&members, &table, Some(StationRoot { pid: 100, created: 45 }), &windows);
        assert!(late_root.contains_key(&400));
        // a parent that is not a member links nothing
        assert!(spared_members(&[301], &table, root, &windows).is_empty());
        // a cycle in the table cannot spin
        let cyclic: std::collections::HashMap<u32, (u32, u64)> = [(1, (2, 5)), (2, (1, 5))].into_iter().collect();
        assert!(spared_members(&[1, 2], &cyclic, None, &|_| false).is_empty());
    }

    #[test]
    fn only_a_real_window_puts_a_process_on_the_screen() {
        let base = WindowFacts { visible: true, cloaked: false, tool: false, transparent: false, minimized: false, width: 800, height: 600 };
        assert!(counts_as_on_screen(&base));
        assert!(!counts_as_on_screen(&WindowFacts { visible: false, ..base }));
        assert!(!counts_as_on_screen(&WindowFacts { cloaked: true, ..base }), "another virtual desktop's frame is DWM-cloaked");
        assert!(!counts_as_on_screen(&WindowFacts { tool: true, ..base }), "a tool frame");
        assert!(!counts_as_on_screen(&WindowFacts { transparent: true, ..base }), "fully transparent");
        assert!(!counts_as_on_screen(&WindowFacts { width: 16, height: 16, ..base }), "the 16x16 helper frame of the desktop survey");
        assert!(!counts_as_on_screen(&WindowFacts { width: 32, height: 32, ..base }));
        assert!(counts_as_on_screen(&WindowFacts { minimized: true, width: 160, height: 28, ..base }), "a minimized editor still holds work");
        assert!(!counts_as_on_screen(&WindowFacts { minimized: true, tool: true, ..base }));
    }

    /// The real window list: a 16x16 tool frame (a windowless helper's) does not put this process on the screen; an
    /// ordinary 300x200 window does (created off screen, so no one sees it flash).
    #[cfg(windows)]
    #[test]
    fn a_helper_frame_is_not_a_window_on_the_screen() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WS_EX_TOOLWINDOW, WS_POPUP, WS_VISIBLE};
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let me = std::process::id();
        let make = |ex: u32, x: i32, w: i32, h: i32| unsafe {
            CreateWindowExW(ex, class.as_ptr(), std::ptr::null(), WS_POPUP | WS_VISIBLE, x, -20000, w, h, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null())
        };
        let helper = make(WS_EX_TOOLWINDOW, -20000, 16, 16);
        assert!(!helper.is_null(), "a tool window");
        assert!(!visible_window_pids().contains(&me), "a 16x16 tool frame does not count");
        let real = make(0, -20000, 300, 200);
        assert!(!real.is_null(), "a window");
        let listed = visible_window_pids().contains(&me);
        unsafe {
            DestroyWindow(real);
            DestroyWindow(helper);
        }
        assert!(listed, "an ordinary window does");
    }

    #[cfg(windows)]
    fn node_on_path() -> Option<std::path::PathBuf> {
        std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths).map(|d| d.join("node.exe")).find(|p| p.exists())
        })
    }

    #[cfg(windows)]
    fn alive(pid: u32) -> bool {
        matches!(crate::process_identity::probe(pid), crate::process_identity::Probe::Live(_))
    }

    #[cfg(windows)]
    fn image_of(pid: u32) -> String {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if h.is_null() {
            return String::new();
        }
        let image = crate::process_identity::windows_image(h).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        unsafe { CloseHandle(h) };
        image
    }

    /// Can a process this test starts break away at all? Under `cargo test` it cannot: cargo runs every test binary
    /// inside its own kill-on-close job that forbids breakaway (run the binary directly to prove the allowed path).
    #[cfg(windows)]
    fn breakaway_possible_here() -> bool {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW};
        match std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "exit 0"])
            .creation_flags(CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW)
            .status()
        {
            Ok(_) => true,
            Err(error) => error.raw_os_error() != Some(5),
        }
    }

    /// Ends the listed processes (and their trees) when dropped — also when an assertion fails first.
    #[cfg(windows)]
    struct KillOnDrop(Vec<u32>);
    #[cfg(windows)]
    impl Drop for KillOnDrop {
        fn drop(&mut self) {
            for p in &self.0 {
                let _ = std::process::Command::new("taskkill").args(["/PID", &p.to_string(), "/T", "/F"]).output();
            }
        }
    }

    #[cfg(windows)]
    fn wait_until(mut done: impl FnMut() -> bool, ms: u64) -> bool {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(ms);
        while std::time::Instant::now() < deadline {
            if done() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        done()
    }

    /// A node "sidecar" in the job starts a command behind cmd.exe (the shape that escaped Node's own job: a grandchild
    /// whose parent is not node) and a DETACHED child. All of them are in the job, and closing the job — what a
    /// hard-killed shell does — ends all of them.
    #[cfg(windows)]
    #[test]
    fn closing_the_job_ends_the_whole_station_tree() {
        use std::io::BufRead;
        let Some(node) = node_on_path() else {
            eprintln!("node.exe not on PATH — nothing to prove here, skipping");
            return;
        };
        let script = concat!(
            "const cp=require('child_process');",
            "const idle=process.execPath+' -e \"setInterval(function(){},1000)\"';",
            "const viaCmd=cp.spawn('cmd.exe',['/d','/s','/c','\"'+idle+'\"'],{windowsVerbatimArguments:true,stdio:'ignore',windowsHide:true});",
            "const det=cp.spawn(process.execPath,['-e','setInterval(function(){},1000)'],{detached:true,stdio:'ignore',windowsHide:true});",
            "setTimeout(function(){console.log(JSON.stringify({cmd:viaCmd.pid,detached:det.pid}))},1500);",
            "setInterval(function(){},1000);"
        );
        let job = ProcessJob::for_station().expect("job");
        let mut sidecar = std::process::Command::new(&node)
            .args(["-e", script])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn");
        job.assign(&sidecar).expect("assign");
        let mut line = String::new();
        std::io::BufReader::new(sidecar.stdout.take().unwrap()).read_line(&mut line).expect("pids");
        let pids: serde_json::Value = serde_json::from_str(line.trim()).expect("pid json");
        let (via_cmd, detached) = (pids["cmd"].as_u64().unwrap() as u32, pids["detached"].as_u64().unwrap() as u32);
        let members = job.members();
        assert!(members.contains(&sidecar.id()) && members.contains(&via_cmd) && members.contains(&detached), "{members:?}");
        // the node behind cmd.exe is the third node.exe member (beside the sidecar and its detached child)
        let nodes = members.iter().filter(|p| image_of(**p).to_lowercase().ends_with(r"\node.exe")).count();
        assert!(nodes >= 3, "the grandchild behind cmd.exe is in the job too: {nodes} node.exe among {members:?}");
        assert!(job.contains(detached), "a detached child is the station's too");
        let all: Vec<u32> = members.clone();
        drop(job);
        assert!(wait_until(|| all.iter().all(|p| !alive(*p)), 5000), "closing the job ended every member: {all:?}");
        let _ = sidecar.wait();
    }

    /// After a stop: windowless leftovers are ended, a member showing a window is spared AND survives the job's close.
    #[cfg(windows)]
    #[test]
    fn end_leftovers_ends_the_windowless_and_spares_a_window() {
        let Some(node) = node_on_path() else {
            eprintln!("node.exe not on PATH — nothing to prove here, skipping");
            return;
        };
        let idle = ["-e", "setInterval(function(){},1000)"];
        let job = ProcessJob::for_station().expect("job");
        let mut windowless = std::process::Command::new(&node).args(idle).spawn().unwrap();
        let mut windowed = std::process::Command::new(&node).args(idle).spawn().unwrap();
        job.assign(&windowless).unwrap();
        job.assign(&windowed).unwrap();
        let spared_pid = windowed.id();
        let report = job.end_leftovers_with(None, &|pid| pid == spared_pid);
        assert_eq!(report.ended.iter().map(|m| m.pid).collect::<Vec<_>>(), vec![windowless.id()], "{report:?}");
        assert_eq!(report.spared.iter().map(|(m, _)| m.pid).collect::<Vec<_>>(), vec![spared_pid], "{report:?}");
        assert!(report.ended[0].image.to_lowercase().ends_with("node.exe"), "the image is named: {report:?}");
        let _ = windowless.wait();
        drop(job);
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert!(alive(spared_pid), "the spared window outlives the job's close");
        let _ = windowed.kill();
        let _ = windowed.wait();
    }

    /// Nothing left: a sweep of an empty job does nothing and keeps kill-on-close.
    #[cfg(windows)]
    #[test]
    fn end_leftovers_of_an_empty_job_is_empty() {
        let job = ProcessJob::for_station().expect("job");
        assert!(job.end_leftovers(None).is_empty());
        assert!(job.members().is_empty());
    }

    /// Real processes, the shapes a stop meets. The "sidecar" (in the job) starts, each detached from Node's own job so
    /// only this sweep decides them: an app behind cmd.exe (`code .` in a terminal) whose main process shows a window and
    /// has a windowless helper of its own; a DIRECT child that shows a window (the station browser) with its own helper;
    /// a windowless server. The sidecar is then terminated, as stop_station does. The app AND its helper are spared and
    /// outlive the job's close; the browser, its helper, the server and cmd.exe are ended.
    #[cfg(windows)]
    #[test]
    fn a_spared_app_keeps_its_helpers_and_the_station_browser_is_ended() {
        use std::io::BufRead;
        use std::os::windows::io::AsRawHandle;
        let Some(node) = node_on_path() else {
            eprintln!("node.exe not on PATH — nothing to prove here, skipping");
            return;
        };
        let dir = std::env::temp_dir().join(format!("starnet-tree-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // app.js <out>: one windowless helper child, then writes {pid, helper} and idles
        std::fs::write(
            dir.join("app.js"),
            r#"const c=require('child_process').spawn(process.execPath,['-e','setInterval(function(){},1000)'],{stdio:'ignore',windowsHide:true});
require('fs').writeFileSync(process.argv[2], JSON.stringify({pid:process.pid, helper:c.pid}));
setInterval(function(){},1000);"#,
        )
        .unwrap();
        // sidecar.js <app.js> <a.json> <b.json>
        std::fs::write(
            dir.join("sidecar.js"),
            r#"const cp=require('child_process');const [app,a,b]=process.argv.slice(2);
const o={stdio:'ignore',windowsHide:true,detached:true};
const cmd=cp.spawn('cmd.exe',['/d','/s','/c','""'+process.execPath+'" "'+app+'" "'+a+'""'],Object.assign({windowsVerbatimArguments:true},o));
cp.spawn(process.execPath,[app,b],o);
const sv=cp.spawn(process.execPath,['-e','setInterval(function(){},1000)'],o);
console.log(JSON.stringify({cmd:cmd.pid,server:sv.pid}));setInterval(function(){},1000);"#,
        )
        .unwrap();
        let (a, b) = (dir.join("a.json"), dir.join("b.json"));
        let job = ProcessJob::for_station().expect("job");
        let mut sidecar = std::process::Command::new(&node)
            .arg(dir.join("sidecar.js"))
            .arg(dir.join("app.js"))
            .arg(&a)
            .arg(&b)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn");
        job.assign(&sidecar).expect("assign");
        let mut line = String::new();
        std::io::BufReader::new(sidecar.stdout.take().unwrap()).read_line(&mut line).expect("pids");
        let started: serde_json::Value = serde_json::from_str(line.trim()).expect("pid json");
        let read = |p: &std::path::Path| std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
        assert!(wait_until(|| read(&a).is_some() && read(&b).is_some(), 15_000), "the app and the browser stand-in started");
        let (app, browser) = (read(&a).unwrap(), read(&b).unwrap());
        let pid = |v: &serde_json::Value, k: &str| v[k].as_u64().unwrap() as u32;
        let (app_pid, app_helper, browser_pid, browser_helper) = (pid(&app, "pid"), pid(&app, "helper"), pid(&browser, "pid"), pid(&browser, "helper"));
        let (cmd, server) = (pid(&started, "cmd"), pid(&started, "server"));
        // a failed assertion must not leave the spared app behind (its image may be a file the next build replaces)
        let _cleanup = KillOnDrop(vec![app_pid, app_helper, browser_pid, browser_helper, cmd, server]);
        for p in [app_pid, app_helper, browser_pid, browser_helper, cmd, server] {
            assert!(job.contains(p), "pid {p} is in the station job");
        }
        let root = StationRoot {
            pid: sidecar.id(),
            created: crate::process_identity::windows_created(sidecar.as_raw_handle() as HANDLE).expect("root created"),
        };
        let _ = sidecar.kill();
        let _ = sidecar.wait();
        let report = job.end_leftovers_with(Some(root), &|p| p == app_pid || p == browser_pid);
        let spared: std::collections::HashMap<u32, u32> = report.spared.iter().map(|(m, w)| (m.pid, *w)).collect();
        assert_eq!(spared.get(&app_pid), Some(&app_pid), "the app is spared for its own window: {report:?}");
        assert_eq!(spared.get(&app_helper), Some(&app_pid), "its windowless helper is spared with it: {report:?}");
        // anything else spared is part of the app's tree too (a console host Windows attached to it)
        assert!(spared.values().all(|w| *w == app_pid), "nothing is spared for the station browser's window: {report:?}");
        let ended = [browser_pid, browser_helper, cmd, server];
        assert!(ended.iter().all(|p| !spared.contains_key(p)), "the browser, its helper, cmd and the server are not spared: {report:?}");
        assert!(wait_until(|| ended.iter().all(|p| !alive(*p)), 5000), "the browser, its helper, cmd and the server are gone: {report:?}");
        drop(job);
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert!(alive(app_pid) && alive(app_helper), "the spared app keeps its helper past the job's close");
        drop(_cleanup);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A TETHERED program (`claude auth login`'s shape): outside the station job, ended with its launcher, while what it
    /// opens (a detached child: the person's browser) is in no job and lives on. Needs breakaway, which `cargo test`'s own
    /// job forbids: run the test binary directly to prove it.
    #[cfg(windows)]
    #[test]
    fn a_tethered_program_ends_with_its_launcher_and_what_it_opens_lives_on() {
        let Some(node) = node_on_path() else {
            eprintln!("node.exe not on PATH — nothing to prove here, skipping");
            return;
        };
        if !breakaway_possible_here() {
            eprintln!("this test process sits in a job that forbids breakaway (cargo test does that): run the test binary directly to prove the tether");
            return;
        }
        let dir = std::env::temp_dir().join(format!("starnet-tether-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (prog_out, opened_out) = (dir.join("prog.pid"), dir.join("opened.pid"));
        let script = format!(
            "const cp=require('child_process'),fs=require('fs');const o=cp.spawn(process.execPath,['-e','setInterval(function(){{}},1000)'],{{detached:true,stdio:'ignore',windowsHide:true}});o.unref();fs.writeFileSync({:?},String(o.pid));fs.writeFileSync({:?},String(process.pid));setInterval(function(){{}},1000);",
            opened_out.to_string_lossy(),
            prog_out.to_string_lossy()
        );
        let spec = serde_json::json!({ "file": node.to_string_lossy(), "args": ["-e", script], "hide": true, "tether": true }).to_string();
        let job = ProcessJob::for_station().unwrap();
        let mut launcher = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "process_job::tests::breakaway_launcher_child", "--nocapture", "--test-threads=1"])
            .env("STARNET_TEST_BREAKAWAY_SPEC", hex(&spec))
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        job.assign(&launcher).unwrap();
        let read = |p: &std::path::Path| std::fs::read_to_string(p).ok().and_then(|s| s.trim().parse::<u32>().ok());
        assert!(wait_until(|| read(&prog_out).is_some() && read(&opened_out).is_some(), 15_000), "the program ran and opened");
        let (prog, opened) = (read(&prog_out).unwrap(), read(&opened_out).unwrap());
        let _cleanup = KillOnDrop(vec![prog, opened]);
        assert!(!job.contains(prog) && !job.contains(opened), "neither is in the station job");
        let _ = launcher.kill();
        let _ = launcher.wait();
        assert!(wait_until(|| !alive(prog), 5000), "the tethered program ended with its launcher");
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(alive(opened), "what it opened lives on");
        drop(_cleanup);
        drop(job);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The launcher itself, run by `breakaway_runs_a_program_outside_the_station_job` below as a child process (this
    /// test binary, filtered to this one test, with the spec in the environment). Without the variable it is a no-op.
    #[cfg(windows)]
    #[test]
    fn breakaway_launcher_child() {
        let Ok(spec) = std::env::var("STARNET_TEST_BREAKAWAY_SPEC") else {
            return;
        };
        // wait until the parent test has put this process in its job
        std::thread::sleep(std::time::Duration::from_millis(700));
        let spec = parse_breakaway_spec(&spec).expect("spec");
        std::process::exit(run_breakaway(&spec));
    }

    /// The launcher runs inside the station job; the program it starts (a node that writes its pid) is OUTSIDE it and
    /// outlives the job's close. With a job that forbids breakaway the program still runs, inside it, and the launcher
    /// exits with the program's own exit code.
    #[cfg(windows)]
    #[test]
    fn breakaway_runs_a_program_outside_the_station_job() {
        let Some(node) = node_on_path() else {
            eprintln!("node.exe not on PATH — nothing to prove here, skipping");
            return;
        };
        let dir = std::env::temp_dir().join(format!("starnet-breakaway-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let can_break_away = breakaway_possible_here();
        if !can_break_away {
            eprintln!("this test process sits in a job that forbids breakaway (cargo test does that): proving the refused path only — run the test binary directly for the allowed one");
        }
        for (allow, name) in [(true, "allowed"), (false, "refused")] {
            if allow && !can_break_away {
                continue;
            }
            let out = dir.join(format!("{name}.pid"));
            // allowed: idle until killed (it must outlive the job); refused: exit 7 soon (the code the launcher relays)
            let tail = if allow { "setInterval(function(){}, 1000);" } else { "setTimeout(function(){process.exit(7)}, 600);" };
            let script = format!("require('fs').writeFileSync({:?}, String(process.pid)); {tail}", out.to_string_lossy());
            let spec = serde_json::json!({ "file": node.to_string_lossy(), "args": ["-e", script], "hide": true }).to_string();
            let job = if allow {
                ProcessJob::for_station().unwrap()
            } else {
                ProcessJob::with_limits(windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE).unwrap()
            };
            let mut launcher = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "process_job::tests::breakaway_launcher_child", "--nocapture", "--test-threads=1"])
                .env("STARNET_TEST_BREAKAWAY_SPEC", hex(&spec))
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap();
            job.assign(&launcher).unwrap();
            assert!(
                wait_until(|| std::fs::read_to_string(&out).map(|s| !s.trim().is_empty()).unwrap_or(false), 15_000),
                "{name}: the program ran"
            );
            let program: u32 = std::fs::read_to_string(&out).unwrap().trim().parse().unwrap();
            assert!(job.contains(launcher.id()), "{name}: the launcher is in the station job");
            if allow {
                assert!(!job.contains(program), "allowed: the program broke away from the station job");
                drop(job); // kills the launcher (kill-on-close), never the program
                let _ = launcher.wait();
                std::thread::sleep(std::time::Duration::from_millis(500));
                assert!(alive(program), "allowed: the program outlives the station job's close");
                let _ = std::process::Command::new("taskkill").args(["/PID", &program.to_string(), "/F"]).output();
            } else {
                assert!(job.contains(program), "refused: the program still ran, inside the job");
                let status = launcher.wait().unwrap();
                assert_eq!(status.code(), Some(7), "the launcher exits with the program's code");
                drop(job);
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
