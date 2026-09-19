//! Hiding a window must not close admission or stop its controller.
#[derive(Debug, PartialEq, Eq)]
pub enum CloseAction {
    Hide,
    Shutdown,
    Wait,
    Close,
}

pub fn requested(tray_available: bool, closing: bool, finished: bool) -> CloseAction {
    if finished {
        CloseAction::Close
    } else if closing {
        CloseAction::Wait
    } else if tray_available {
        CloseAction::Hide
    } else {
        // A tray failure must never leave an inaccessible background process.
        CloseAction::Shutdown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_close_keeps_work_running_only_with_a_tray() {
        assert_eq!(requested(true, false, false), CloseAction::Hide);
        assert_eq!(requested(false, false, false), CloseAction::Shutdown);
    }

    #[test]
    fn repeated_close_cannot_hide_a_shutdown_or_skip_cleanup() {
        for tray in [false, true] {
            assert_eq!(requested(tray, true, false), CloseAction::Wait);
            for closing in [false, true] {
                assert_eq!(requested(tray, closing, true), CloseAction::Close);
            }
        }
    }
}
