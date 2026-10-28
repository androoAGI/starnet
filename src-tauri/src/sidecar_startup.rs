//! Keep ownership of every startup attempt, including timed-out children — and of everything the station starts.
//!
//! The slot holds an `OwnedSidecar`: the sidecar process plus the Job Object that holds its whole tree (Windows,
//! process_job.rs). It derefs to the `Child`, so every reader of the slot sees the process exactly as before. What a
//! stopped sidecar left behind in its job is ended here, on purpose, at the moment it stops: when a new attempt takes the
//! place of an exited one (a crash the guardian heals), when a timed-out attempt is stopped, and in main.rs's one stop
//! routine (stop_station) for every other stop.
use std::io;
use std::ops::{Deref, DerefMut};
use std::process::{Child, ChildStderr, ChildStdout, Command};
use std::sync::Mutex;

use crate::process_job::{Leftovers, ProcessJob, StationRoot};

/// The sidecar process and the job holding everything it starts (None off Windows, or when assignment failed).
#[derive(Debug)]
pub(crate) struct OwnedSidecar {
    child: Child,
    job: Option<ProcessJob>,
}

impl Deref for OwnedSidecar {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.child
    }
}

impl DerefMut for OwnedSidecar {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}

impl OwnedSidecar {
    /// The sidecar has stopped: end every process it left in its job, sparing an app that shows a window on the user's
    /// screen, with its whole tree (process_job.rs end_leftovers). The sidecar is the tree's root: a window its DIRECT
    /// child shows is the station's own (its browser). Safe to call again; a later call finds only what it spared.
    pub(crate) fn end_leftovers(&self) -> Leftovers {
        let root = self.root();
        self.job.as_ref().map(|job| job.end_leftovers(root)).unwrap_or_default()
    }

    /// The sidecar's PID with its creation time (read through the handle this slot still holds, so it answers even
    /// after the sidecar exited).
    fn root(&self) -> Option<StationRoot> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            crate::process_identity::windows_created(self.child.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE)
                .map(|created| StationRoot { pid: self.child.id(), created })
        }
        #[cfg(not(windows))]
        {
            None
        }
    }

    /// Whether the station's tree is held by a job.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn in_job(&self) -> bool {
        self.job.is_some()
    }
}

/// A tracked child plus its piped output, taken before the child is stored so nothing else holding
/// the slot can drop a pipe (a closed reader turns the sidecar's next log line into EPIPE).
#[derive(Debug)]
pub(crate) struct Spawned {
    pub(crate) pid: u32,
    pub(crate) stdout: Option<ChildStdout>,
    pub(crate) stderr: Option<ChildStderr>,
    /// Some(why) when the new sidecar could not be placed in its job (it runs anyway; the parent watch and the reaper
    /// remain). None when it is in one, or this OS has no jobs.
    pub(crate) job_error: Option<String>,
    /// what the previous, exited sidecar had left behind — ended before this one started
    pub(crate) retired: Leftovers,
}

pub(crate) fn spawn(command: &mut Command, slot: &Mutex<Option<OwnedSidecar>>) -> io::Result<Spawned> {
    let mut tracked = slot
        .lock()
        .map_err(|_| io::Error::other("sidecar lock poisoned"))?;
    if let Some(child) = tracked.as_mut() {
        if child.try_wait()?.is_none() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "previous sidecar is still running",
            ));
        }
    }
    // the previous sidecar exited (a crash the guardian is healing): what it started dies before its successor starts
    let retired = tracked.as_ref().map(OwnedSidecar::end_leftovers).unwrap_or_default();
    let job = ProcessJob::for_station();
    let mut child = command.spawn()?;
    let (job, job_error) = match job {
        Ok(job) => match job.assign(&child) {
            Ok(()) => (Some(job), None),
            Err(error) => (None, Some(format!("could not place the station in its job ({error})"))),
        },
        Err(_) if !cfg!(windows) => (None, None),
        Err(error) => (None, Some(format!("could not create the station's job ({error})"))),
    };
    let spawned = Spawned {
        pid: child.id(),
        stdout: child.stdout.take(),
        stderr: child.stderr.take(),
        job_error,
        retired,
    };
    *tracked = Some(OwnedSidecar { child, job });
    Ok(spawned)
}

/// Retain the reaped child so the guardian can count its failed attempt normally.
/// Never stop a replacement installed by a concurrent recovery operation.
/// Returns what the stopped attempt had left behind (ended), for the log.
pub(crate) fn stop_timed_out(slot: &Mutex<Option<OwnedSidecar>>, pid: u32) -> io::Result<Leftovers> {
    let mut tracked = slot
        .lock()
        .map_err(|_| io::Error::other("sidecar lock poisoned"))?;
    if let Some(child) = tracked.as_mut().filter(|child| child.id() == pid) {
        if child.try_wait()?.is_none() {
            child.kill()?;
        }
        child.wait()?;
        return Ok(child.end_leftovers());
    }
    Ok(Leftovers::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sleeping_child() -> Command {
        #[cfg(windows)]
        let mut cmd = Command::new("powershell.exe");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 60",
            ]);
            cmd.creation_flags(0x0800_0000);
        }
        #[cfg(not(windows))]
        let mut cmd = Command::new("sleep");
        #[cfg(not(windows))]
        cmd.arg("60");
        cmd
    }

    #[test]
    fn timeout_reaps_before_retry_and_does_not_stop_a_replacement() {
        let slot = Mutex::new(None);
        let first = spawn(&mut sleeping_child(), &slot).unwrap().pid;
        let duplicate = spawn(&mut sleeping_child(), &slot).unwrap_err();
        assert_eq!(duplicate.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(slot.lock().unwrap().as_ref().unwrap().id(), first);
        stop_timed_out(&slot, first).unwrap();
        assert!(slot
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_some());
        let second = spawn(&mut sleeping_child(), &slot).unwrap().pid;
        stop_timed_out(&slot, first).unwrap();
        let still_running = slot
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_none();
        stop_timed_out(&slot, second).unwrap();
        assert!(
            still_running,
            "a late timeout must not kill the replacement"
        );
    }

    #[test]
    fn spawn_failure_leaves_no_untracked_child() {
        let slot = Mutex::new(None);
        assert!(spawn(&mut Command::new("starnet-missing-runtime-test"), &slot).is_err());
        assert!(slot.lock().unwrap().is_none());
    }

    /// Windows: every attempt is placed in its own job, and a timed-out attempt's children are ended with it.
    #[cfg(windows)]
    #[test]
    fn every_attempt_is_held_by_a_job_and_a_timed_out_one_takes_its_children() {
        use std::io::BufRead;
        let Some(node) = std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths).map(|d| d.join("node.exe")).find(|p| p.exists())
        }) else {
            eprintln!("node.exe not on PATH — nothing to prove here, skipping");
            return;
        };
        let slot = Mutex::new(None);
        // a "sidecar" that starts a command behind cmd.exe (beyond Node's own job) and prints that command's pid
        let script = concat!(
            "const cp=require('child_process');",
            "const c=cp.spawn('cmd.exe',['/d','/s','/c','\"'+process.execPath+' -e \"console.log(process.pid);setInterval(function(){},1000)\"\"'],{windowsVerbatimArguments:true,stdio:['ignore','pipe','ignore'],windowsHide:true});",
            "c.stdout.once('data',function(d){console.log(String(d).trim())});",
            "setInterval(function(){},1000);"
        );
        let mut cmd = Command::new(&node);
        cmd.args(["-e", script]).stdout(std::process::Stdio::piped());
        let spawned = spawn(&mut cmd, &slot).unwrap();
        assert_eq!(spawned.job_error, None, "the attempt is in its job");
        assert!(slot.lock().unwrap().as_ref().unwrap().in_job());
        let mut line = String::new();
        std::io::BufReader::new(spawned.stdout.unwrap()).read_line(&mut line).unwrap();
        let grandchild: u32 = line.trim().parse().expect("grandchild pid");
        let left = stop_timed_out(&slot, spawned.pid).unwrap();
        assert!(
            left.ended.iter().any(|m| m.pid == grandchild),
            "the command behind cmd.exe was ended with the timed-out attempt: {left:?}"
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while std::time::Instant::now() < deadline
            && !matches!(crate::process_identity::probe(grandchild), crate::process_identity::Probe::Gone)
        {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(matches!(crate::process_identity::probe(grandchild), crate::process_identity::Probe::Gone), "and is gone");
    }
}
