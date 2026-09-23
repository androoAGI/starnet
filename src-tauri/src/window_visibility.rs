use std::sync::atomic::{AtomicBool, Ordering};

/// Startup may reveal the window once. A close cancels that permission even if
/// document loading is still in flight; later navigation must not reopen a tray.
pub(crate) struct StartupReveal {
    pending: AtomicBool,
}

impl StartupReveal {
    pub(crate) fn new(start_minimized: bool) -> Self {
        Self {
            pending: AtomicBool::new(!start_minimized),
        }
    }

    pub(crate) fn finish_load(&self) -> bool {
        self.pending.swap(false, Ordering::SeqCst)
    }

    pub(crate) fn is_pending(&self) -> bool {
        self.pending.load(Ordering::SeqCst)
    }

    pub(crate) fn cancel(&self) {
        self.pending.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::StartupReveal;

    #[test]
    fn initial_document_reveals_once() {
        let reveal = StartupReveal::new(false);
        assert!(reveal.is_pending());
        assert!(reveal.finish_load());
        assert!(!reveal.is_pending());
        assert!(
            !reveal.finish_load(),
            "reloads must not reveal the window again"
        );
    }

    #[test]
    fn close_before_document_finishes_cancels_startup_reveal() {
        let reveal = StartupReveal::new(false);
        reveal.cancel();
        assert!(!reveal.is_pending());
        assert!(
            !reveal.finish_load(),
            "a delayed load must respect an earlier close"
        );
    }

    #[test]
    fn closed_tray_stays_hidden_through_reload() {
        let reveal = StartupReveal::new(false);
        assert!(reveal.finish_load());
        reveal.cancel();
        assert!(!reveal.finish_load());
    }

    #[test]
    fn start_minimized_never_auto_reveals() {
        let reveal = StartupReveal::new(true);
        assert!(!reveal.is_pending());
        assert!(!reveal.finish_load());
        assert!(!reveal.finish_load());
    }
}
