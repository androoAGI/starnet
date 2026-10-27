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
//!     (KILL_ON_JOB_CLOSE) and with every stop of the sidecar (`end_leftovers`).
//!   - an app the station opened ON PURPOSE for the person (desktop.open, a Resolve launch, a full-power shell command that
//!     opens a window: sidecar/breakaway.js routes them through `--starnet-breakaway`): created with
//!     CREATE_BREAKAWAY_FROM_JOB, so it is never in the job and survives everything, as an app the person opened would.
//!   - anything else in the job that shows a window on the person's screen when the sidecar is stopped (an app opened some
//!     other way, e.g. from a StarNet terminal): SPARED by `end_leftovers`, and the job's kill-on-close is released so it
//!     survives the job's close. A crash of the shell itself cannot make that judgement: those die with it (stated, not
//!     fixed — only a breakaway launch survives a crash).
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
    /// processes showing a window on the person's screen, left running and released from the job
    pub spared: Vec<Member>,
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
        for m in &self.spared {
            out.push(format!(
                "{what}: spared pid={} ({}) — it shows a window on the user's screen; released from the station",
                m.pid, m.image
            ));
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

    /// The station has stopped: end every member it left behind, except one showing a window on the person's screen,
    /// which is spared — and then the job no longer kills on close, so dropping it leaves that window alone.
    pub fn end_leftovers(&self) -> Leftovers {
        let windows = visible_window_pids();
        self.end_leftovers_with(&|pid| windows.contains(&pid))
    }

    pub fn end_leftovers_with(&self, shows_window: &dyn Fn(u32) -> bool) -> Leftovers {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::IsProcessInJob;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
        };
        let mut out = Leftovers::default();
        let own = std::process::id();
        for pid in self.members() {
            if pid == own {
                continue;
            }
            let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, 0, pid) };
            if process.is_null() {
                let error = std::io::Error::last_os_error();
                out.failed.push((Member { pid, image: String::new() }, format!("could not open it ({error})")));
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
            if shows_window(pid) {
                out.spared.push(member);
            } else if unsafe { TerminateProcess(process, 1) } != 0 {
                out.ended.push(member);
            } else {
                let error = std::io::Error::last_os_error();
                out.failed.push((member, format!("TerminateProcess failed ({error})")));
            }
            unsafe { CloseHandle(process) };
        }
        if !out.spared.is_empty() {
            // keep breakaway allowed, drop kill-on-close: the spared windows outlive this job's handle
            let _ = self.set_limit_flags(windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_BREAKAWAY_OK);
        }
        out
    }
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
    pub fn end_leftovers(&self) -> Leftovers {
        Leftovers::default()
    }
}

/// Every process that owns a visible top-level window right now.
#[cfg(windows)]
pub fn visible_window_pids() -> std::collections::HashSet<u32> {
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible};
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let set = unsafe { &mut *(lparam as *mut std::collections::HashSet<u32>) };
        if unsafe { IsWindowVisible(hwnd) } != 0 {
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

pub const BREAKAWAY_FLAG: &str = "--starnet-breakaway";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BreakawaySpec {
    pub file: String,
    pub args: Vec<String>,
    pub verbatim: bool,
    pub hide: bool,
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

#[cfg(windows)]
pub fn run_breakaway(spec: &BreakawaySpec) -> i32 {
    // ERROR_ACCESS_DENIED: a job above ours does not allow breakaway — run it anyway, inside
    let child = match breakaway_command(spec, true).spawn() {
        Err(error) if error.raw_os_error() == Some(5) => breakaway_command(spec, false).spawn(),
        other => other,
    };
    match child {
        Ok(mut child) => match child.wait() {
            Ok(status) => status.code().unwrap_or(1),
            Err(error) => {
                eprintln!("starnet-breakaway: {error}");
                1
            }
        },
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
        assert!(bare.args.is_empty() && !bare.verbatim && !bare.hide);
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
            spared: vec![Member { pid: 11, image: "C:\\Apps\\Resolve.exe".into() }],
            failed: vec![(Member { pid: 12, image: String::new() }, "could not open it".into())],
        };
        let lines = report.log_lines("station-stop");
        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("ended pid=10") && lines[0].contains("left behind"));
        assert!(lines[1].contains("spared pid=11") && lines[1].contains("window"));
        assert!(lines[2].contains("could not end pid=12"));
        assert!(Leftovers::default().is_empty());
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
        let report = job.end_leftovers_with(&|pid| pid == spared_pid);
        assert_eq!(report.ended.iter().map(|m| m.pid).collect::<Vec<_>>(), vec![windowless.id()], "{report:?}");
        assert_eq!(report.spared.iter().map(|m| m.pid).collect::<Vec<_>>(), vec![spared_pid], "{report:?}");
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
        assert!(job.end_leftovers().is_empty());
        assert!(job.members().is_empty());
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
