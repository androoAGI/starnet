//! WebView2 crash recovery policy (Windows).
//!
//! Without this, a WebView2 browser/renderer crash (e.g. Windows running out of memory overnight)
//! left the StarNet window permanently white while the sidecar kept running: the sidecar has a
//! watchdog, the webview had none. The host now listens for `ProcessFailed` and either reloads
//! the page (renderer died) or rebuilds the whole window (browser process died — the webview is
//! closed for good and only a fresh one can recover). This module is the pure policy; the COM
//! wiring lives in main.rs.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// #181: the fragment a macOS recovery reload carries (`index.html#webview-recovered`). The page reads it once,
/// strips it, and a first-run setup that was mid wire test returns to its connect screen instead of the title
/// (frontend/app/app.js takeRecoveryMarker; test/webview-recovery-draft.test.js holds the two to one word).
pub(crate) const RECOVERED_FRAGMENT: &str = "webview-recovered";

/// What the host does for one `COREWEBVIEW2_PROCESS_FAILED_KIND`.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RecoveryAction {
    /// The page's renderer died: the webview itself is alive, so reload the document.
    Reload,
    /// The browser process died: the webview is closed and cannot be reused. Rebuild the window.
    Rebuild,
    /// WebView2 recovers on its own (GPU/utility/sandbox helpers), or reloading could destroy a
    /// page that is only busy (unresponsive). Log it and leave the page alone.
    LogOnly,
}

// Values of COREWEBVIEW2_PROCESS_FAILED_KIND (WebView2 SDK; stable ABI constants).
#[cfg_attr(not(windows), allow(dead_code))]
const KIND_BROWSER_PROCESS_EXITED: i32 = 0;
#[cfg_attr(not(windows), allow(dead_code))]
const KIND_RENDER_PROCESS_EXITED: i32 = 1;

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn action_for_kind(kind: i32) -> RecoveryAction {
    match kind {
        KIND_BROWSER_PROCESS_EXITED => RecoveryAction::Rebuild,
        KIND_RENDER_PROCESS_EXITED => RecoveryAction::Reload,
        _ => RecoveryAction::LogOnly,
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn kind_name(kind: i32) -> &'static str {
    match kind {
        0 => "browser-process-exited",
        1 => "render-process-exited",
        2 => "render-process-unresponsive",
        3 => "frame-render-process-exited",
        4 => "utility-process-exited",
        5 => "sandbox-helper-process-exited",
        6 => "gpu-process-exited",
        7 => "ppapi-plugin-process-exited",
        8 => "ppapi-broker-process-exited",
        9 => "unknown-process-exited",
        _ => "unrecognized-kind",
    }
}

/// What a second launch does to the running instance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SecondLaunch {
    /// The main window exists: show and focus it.
    Reveal,
    /// No main window YET — startup is still running (a slow sidecar boot under memory pressure
    /// can take 30 s+) or crash recovery is rebuilding it. This instance is alive; leave it be.
    Wait,
    /// The window was built once and is gone with no rebuild pending: an unrevealable zombie.
    ExitZombie,
}

/// 2026-09-23: a relaunch during a slow boot hit the zombie branch and quit the instance that was
/// still starting, so StarNet "wouldn't load" — both processes exited and nothing stayed open.
pub(crate) fn second_launch_action(
    window_present: bool,
    window_was_built: bool,
    rebuilding: bool,
) -> SecondLaunch {
    if window_present {
        SecondLaunch::Reveal
    } else if !window_was_built || rebuilding {
        SecondLaunch::Wait
    } else {
        SecondLaunch::ExitZombie
    }
}

/// Bounded retries: under sustained memory starvation a rebuilt webview can die again at once.
/// Recovering forever would thrash the machine; after the budget is spent the window stays as it
/// is and the startup log says why, so a restart is the user's call.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) struct RecoveryBudget {
    max_attempts: usize,
    window: Duration,
    attempts: Mutex<VecDeque<Instant>>,
}

impl RecoveryBudget {
    pub(crate) const fn new_const(max_attempts: usize, window: Duration) -> Self {
        Self {
            max_attempts,
            window,
            attempts: Mutex::new(VecDeque::new()),
        }
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    /// Records an attempt at `now` and returns whether it is allowed.
    pub(crate) fn try_spend(&self, now: Instant) -> bool {
        let mut attempts = match self.attempts.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        while let Some(first) = attempts.front() {
            if now.saturating_duration_since(*first) >= self.window {
                attempts.pop_front();
            } else {
                break;
            }
        }
        if attempts.len() >= self.max_attempts {
            return false;
        }
        attempts.push_back(now);
        true
    }
}

impl Default for RecoveryBudget {
    fn default() -> Self {
        Self::new_const(3, Duration::from_secs(10 * 60))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_exit_rebuilds_and_renderer_exit_reloads() {
        assert_eq!(action_for_kind(0), RecoveryAction::Rebuild);
        assert_eq!(action_for_kind(1), RecoveryAction::Reload);
    }

    #[test]
    fn busy_or_self_healing_processes_are_left_alone() {
        // Unresponsive may just be a long frame; GPU/utility restart inside WebView2 itself.
        for kind in [2, 3, 4, 5, 6, 7, 8, 9, 42] {
            assert_eq!(
                action_for_kind(kind),
                RecoveryAction::LogOnly,
                "kind {kind}"
            );
        }
    }

    #[test]
    fn budget_stops_a_crash_loop_then_refills() {
        let budget = RecoveryBudget::new_const(3, Duration::from_secs(600));
        let t0 = Instant::now();
        assert!(budget.try_spend(t0));
        assert!(budget.try_spend(t0 + Duration::from_secs(1)));
        assert!(budget.try_spend(t0 + Duration::from_secs(2)));
        assert!(
            !budget.try_spend(t0 + Duration::from_secs(3)),
            "4th in window refused"
        );
        assert!(
            budget.try_spend(t0 + Duration::from_secs(601)),
            "oldest aged out"
        );
    }

    #[test]
    fn relaunch_during_boot_or_rebuild_never_kills_the_instance() {
        assert_eq!(
            second_launch_action(false, false, false),
            SecondLaunch::Wait,
            "still booting"
        );
        assert_eq!(
            second_launch_action(false, true, true),
            SecondLaunch::Wait,
            "rebuilding"
        );
        assert_eq!(
            second_launch_action(true, true, false),
            SecondLaunch::Reveal
        );
        assert_eq!(
            second_launch_action(false, true, false),
            SecondLaunch::ExitZombie
        );
    }

    #[test]
    fn kind_names_cover_the_sdk_range() {
        assert_eq!(kind_name(0), "browser-process-exited");
        assert_eq!(kind_name(1), "render-process-exited");
        assert_eq!(kind_name(99), "unrecognized-kind");
    }
}
