//! Which processes the boot-time orphan-sidecar reap may terminate (main.rs reap_orphan_sidecars).
//!
//! The reap exists for one case: a shell killed hard (crash, `taskkill /F`, End Task) never stops its sidecar, and
//! that orphan keeps the station's WORKSPACES dir and Codex token file busy. It finds those by their executable
//! image — exactly this install's bundled node. But that same node also runs the `starnet` CLI (bin/starnet.cmd and
//! bin/starnet run it), a station that CLI booted, and a sidecar's own MCP children. Killing by image alone killed
//! the `starnet` that had just started this StarNet in the background (review 0.14.1, F4).
//!
//! So the image only nominates; the PARENT decides. A process a hard-killed shell left behind has no live parent
//! (Windows: its parent pid is gone, has exited, or now names a younger process — pid reuse; macOS: launchd
//! adopted it, ppid 1). A bundled-node process whose parent is alive belongs to someone and is never touched, and
//! neither is a terminal session this StarNet runs for. Children of an orphan go with it.

/// What the reap could prove about a process's parent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub enum Parent {
    /// the live process that started it
    Alive,
    /// gone, exited, or its pid now names a younger process (Windows); adopted by launchd (macOS)
    Gone,
    /// could not be inspected (access denied, ps said nothing): never reaped — what is not proven orphaned is spared
    Unprovable,
}

/// One process running the bundled node, as the reap sees it. (Other unix has no reaper wired: unused there.)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub struct NodeProc {
    pub pid: u32,
    pub parent: u32,
    pub parent_state: Parent,
}

#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
impl NodeProc {
    pub fn parent_alive(&self) -> bool {
        self.parent_state != Parent::Gone
    }
}

/// Why the reap leaves `p` alone — its startup.log line. Every process the image nominated and the reap spares gets one.
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub fn kept_reason(p: &NodeProc, keep: &[u32], own_pid: u32, reap: &[u32]) -> String {
    if p.pid == own_pid {
        return "this StarNet itself".to_string();
    }
    if keep.contains(&p.pid) {
        return "a starnet terminal this StarNet runs for".to_string();
    }
    match p.parent_state {
        Parent::Alive if reap.contains(&p.parent) => format!("its parent pid={} is reaped first", p.parent),
        Parent::Alive => format!(
            "its parent pid={} is alive (a starnet terminal, a station it runs, or a sidecar's own child)",
            p.parent
        ),
        Parent::Unprovable => format!(
            "its parent pid={} could not be inspected — what is not proven orphaned is never reaped",
            p.parent
        ),
        Parent::Gone => "spared".to_string(),
    }
}

/// The pids to terminate: orphans (no live parent) and, transitively, bundled-node processes whose parent is one of
/// them. `keep` (the terminal sessions this StarNet runs for) and `own_pid` are never in it.
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub fn orphans_to_reap(procs: &[NodeProc], keep: &[u32], own_pid: u32) -> Vec<u32> {
    let spared = |pid: u32| pid == own_pid || keep.contains(&pid);
    let mut reap: Vec<u32> = procs
        .iter()
        .filter(|p| !p.parent_alive() && !spared(p.pid))
        .map(|p| p.pid)
        .collect();
    loop {
        let more: Vec<u32> = procs
            .iter()
            .filter(|p| !spared(p.pid) && !reap.contains(&p.pid) && reap.contains(&p.parent))
            .map(|p| p.pid)
            .collect();
        if more.is_empty() {
            return reap;
        }
        reap.extend(more);
    }
}

/// `ps -o ppid= -p <pid>` output → the parent pid (macOS). None when ps said nothing usable.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_ps_ppid(out: &str) -> Option<u32> {
    out.split_whitespace().next()?.parse().ok()
}

/// Every process whose image is exactly the bundled node (`is_node` decides on the full image path), with its parent
/// and whether that parent is alive. Err when the process list itself could not be read (the reap then does nothing).
/// A process with the node's file name that could not be inspected (not opened, image unreadable) is never a
/// candidate; it is pushed to `uninspected` with why, so the caller logs that skip too.
#[cfg(windows)]
pub fn windows_bundled_node_processes(
    node_file_name: &str,
    is_node: &dyn Fn(&std::path::Path) -> bool,
    uninspected: &mut Vec<(u32, String)>,
) -> Result<Vec<NodeProc>, ()> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(());
    }
    let mut out = Vec::new();
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while ok {
        let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
        let exe_name = String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase();
        if exe_name == node_file_name {
            let pid = entry.th32ProcessID;
            let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            if handle.is_null() {
                uninspected.push((pid, format!("could not open it ({})", std::io::Error::last_os_error())));
            } else {
                // the full image path is the ONLY thing that nominates a process (another node install never is)
                match windows_image(handle) {
                    Some(full) if is_node(&full) => {
                        let created = windows_created(handle);
                        out.push(NodeProc {
                            pid,
                            parent: entry.th32ParentProcessID,
                            parent_state: windows_parent(entry.th32ParentProcessID, created),
                        });
                    }
                    Some(_) => {}
                    None => uninspected.push((pid, "its image path could not be read".to_string())),
                }
                unsafe { CloseHandle(handle) };
            }
        }
        ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    Ok(out)
}

// The image path and creation time readers live with the identity rule (process_identity.rs); the reap shares them.
#[cfg(windows)]
pub use crate::process_identity::{windows_created, windows_image};

/// Is `parent` still the live process that started a child created at `child_created`? Gone, exited, or a pid now
/// reused by a process younger than the child = Gone. A parent that cannot be inspected (access denied), or whose
/// creation time Windows does not give, is Unprovable: the reap spares what it cannot prove orphaned.
#[cfg(windows)]
fn windows_parent(parent: u32, child_created: Option<u64>) -> Parent {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };
    if parent == 0 {
        return Parent::Gone;
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, parent) };
    if handle.is_null() {
        return if (unsafe { GetLastError() }) == ERROR_INVALID_PARAMETER { Parent::Gone } else { Parent::Unprovable };
    }
    let exited = unsafe { WaitForSingleObject(handle, 0) } == WAIT_OBJECT_0;
    let parent_created = windows_created(handle);
    unsafe { CloseHandle(handle) };
    if exited {
        return Parent::Gone;
    }
    match (parent_created, child_created) {
        (Some(p), Some(c)) if p > c => Parent::Gone,
        (Some(_), Some(_)) => Parent::Alive,
        _ => Parent::Unprovable,
    }
}

#[cfg(test)]
mod tests {
    use super::{kept_reason, orphans_to_reap, parse_ps_ppid, NodeProc, Parent};

    fn p(pid: u32, parent: u32, parent_alive: bool) -> NodeProc {
        NodeProc { pid, parent, parent_state: if parent_alive { Parent::Alive } else { Parent::Gone } }
    }

    #[test]
    fn only_a_process_without_a_live_parent_is_an_orphan() {
        let procs = [p(10, 999, false), p(11, 4242, true)];
        assert_eq!(orphans_to_reap(&procs, &[], 1), vec![10], "the starnet CLI (live parent) is never reaped");
    }

    #[test]
    fn children_of_an_orphan_go_with_it_and_their_children_too() {
        let procs = [p(10, 999, false), p(20, 10, true), p(30, 20, true), p(40, 77, true)];
        let mut got = orphans_to_reap(&procs, &[], 1);
        got.sort();
        assert_eq!(got, vec![10, 20, 30], "an orphan's MCP children and theirs, never a stranger's");
    }

    #[test]
    fn the_terminal_sessions_and_this_process_are_never_reaped() {
        let procs = [p(10, 999, false), p(11, 998, false), p(12, 11, true)];
        assert_eq!(orphans_to_reap(&procs, &[11], 1), vec![10], "a kept terminal and its children stay, even parentless");
        assert_eq!(orphans_to_reap(&[p(5, 0, false)], &[], 5), Vec::<u32>::new(), "never this process");
    }

    #[test]
    fn an_unprovable_parent_is_never_reaped_and_every_spared_process_says_why() {
        let unprovable = NodeProc { pid: 13, parent: 4, parent_state: Parent::Unprovable };
        let procs = [p(10, 999, false), p(20, 10, true), p(11, 4242, true), unprovable, p(12, 998, false), p(1, 0, false)];
        let reap = orphans_to_reap(&procs, &[12], 1);
        assert_eq!(reap, vec![10, 20], "an unprovable parent spares its child: {reap:?}");
        let reasons: Vec<String> = procs
            .iter()
            .filter(|q| !reap.contains(&q.pid))
            .map(|q| format!("{}: {}", q.pid, kept_reason(q, &[12], 1, &reap)))
            .collect();
        assert_eq!(reasons.len(), 4, "every spared process gets a line: {reasons:?}");
        assert!(reasons[0].starts_with("11: its parent pid=4242 is alive"), "{reasons:?}");
        assert!(reasons[1].starts_with("13: its parent pid=4 could not be inspected"), "{reasons:?}");
        assert!(reasons[2].starts_with("12: a starnet terminal"), "{reasons:?}");
        assert!(reasons[3].starts_with("1: this StarNet itself"), "{reasons:?}");
        assert_eq!(kept_reason(&p(20, 10, true), &[], 1, &[10]), "its parent pid=10 is reaped first");
    }

    #[test]
    fn nothing_to_reap_is_nothing() {
        assert!(orphans_to_reap(&[], &[1, 2], 3).is_empty());
    }

    #[test]
    fn ps_ppid_output_is_read_and_junk_is_not() {
        assert_eq!(parse_ps_ppid("    1\n"), Some(1));
        assert_eq!(parse_ps_ppid(" 4242"), Some(4242));
        assert_eq!(parse_ps_ppid(""), None);
        assert_eq!(parse_ps_ppid("PPID\n"), None);
    }

    /// Real processes: a node.exe copied to a unique "bundled" path; two ORPHANS on it (each one's parent exits right
    /// after starting it), one of them named by the keep list (a terminal session this StarNet runs for); a process on
    /// it with a LIVE parent (this test, standing in for the `starnet` CLI); and a bystander on the original node.
    /// Only the unkept orphan is nominated.
    #[cfg(windows)]
    #[test]
    fn real_processes_only_the_orphan_is_nominated() {
        use std::process::Command;
        use std::time::Duration;
        let Some(src) = std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths).map(|d| d.join("node.exe")).find(|p| p.exists())
        }) else {
            eprintln!("node.exe not on PATH — nothing to prove here, skipping");
            return;
        };
        let dir = std::env::temp_dir().join(format!("starnet-reap-rule-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bundled = dir.join("node.exe");
        std::fs::copy(&src, &bundled).unwrap();
        let idle = ["-e", "setInterval(function(){}, 1000)"];

        // an orphan: started by a short-lived node that exits at once, so its parent pid is dead
        let starter = "const c=require('child_process').spawn(process.argv[1],['-e','setInterval(function(){},1000)'],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid)";
        let orphan_on_bundled = || -> u32 {
            let out = Command::new(&src).args(["-e", starter, bundled.to_str().unwrap()]).output().unwrap();
            String::from_utf8_lossy(&out.stdout).trim().parse().expect("orphan pid")
        };
        let orphan = orphan_on_bundled();
        let kept_orphan = orphan_on_bundled();
        let mut cli_like = Command::new(&bundled).args(idle).spawn().unwrap();
        let mut bystander = Command::new(&src).args(idle).spawn().unwrap();
        std::thread::sleep(Duration::from_millis(500));

        let is_node = |full: &std::path::Path| full.to_string_lossy().eq_ignore_ascii_case(&bundled.to_string_lossy());
        let procs = super::windows_bundled_node_processes("node.exe", &is_node, &mut Vec::new()).expect("process list");
        let seen = |pid: u32| procs.iter().find(|q| q.pid == pid).copied();
        assert!(seen(orphan).is_some_and(|q| q.parent_state == Parent::Gone), "the orphan is listed with a dead parent: {:?}", seen(orphan));
        assert!(seen(kept_orphan).is_some_and(|q| q.parent_state == Parent::Gone), "so is the second one");
        assert!(seen(cli_like.id()).is_some_and(|q| q.parent_state == Parent::Alive), "the live-parent one is listed as owned");
        assert!(seen(bystander.id()).is_none(), "a node from another path is never even listed");
        let reap = orphans_to_reap(&procs, &[kept_orphan], std::process::id());
        assert_eq!(reap, vec![orphan], "only the unkept orphan is nominated (kept orphan, CLI-like and bystander spared)");

        // clean up everything this test started
        for pid in [orphan, kept_orphan] {
            let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).output();
        }
        for c in [&mut cli_like, &mut bystander] {
            let _ = c.kill();
            let _ = c.wait();
        }
        std::thread::sleep(Duration::from_millis(300));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
