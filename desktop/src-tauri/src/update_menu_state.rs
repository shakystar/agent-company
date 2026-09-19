//! Native menu state. Closing or a slow reply never cancels a controller hold.
use crate::policy::{UpdateAction, UpdatePhase, UpdateStatus};
use crate::update::{attempt_id, UpdateError, UpdateReply};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuAction {
    Prepare,
    Status,
    Cancel,
}

impl MenuAction {
    pub fn wire(self) -> UpdateAction {
        match self {
            Self::Prepare => UpdateAction::Prepare,
            Self::Status => UpdateAction::Status,
            Self::Cancel => UpdateAction::Cancel,
        }
    }
}

#[derive(Clone, Copy)]
pub struct MenuRequest {
    pub ticket: u64,
    pub action: MenuAction,
    pub update_id: Uuid,
}

#[derive(Default)]
pub struct MenuState {
    available: bool,
    closing: bool,
    attempt: Option<Uuid>,
    submitted: bool,
    pending: Option<MenuRequest>,
    next_ticket: u64,
    status: Option<UpdateStatus>,
    error: Option<UpdateError>,
    slow: bool,
    cancelled: bool,
}

pub struct MenuView {
    pub heading: &'static str,
    pub summary: &'static str,
    pub counts: String,
    pub hint: &'static str,
    pub prepare_label: &'static str,
    pub prepare_enabled: bool,
    pub status_enabled: bool,
    pub cancel_enabled: bool,
}

impl MenuState {
    pub fn activate(&mut self) {
        if !self.closing {
            self.available = true;
        }
    }

    pub fn close(&mut self) {
        self.closing = true;
        self.available = false;
        // Retain the attempt until the application exits. Closing is not cancel.
    }

    pub fn begin(&mut self, action: MenuAction) -> Option<MenuRequest> {
        let view = self.view();
        let enabled = match action {
            MenuAction::Prepare => view.prepare_enabled,
            MenuAction::Status => view.status_enabled,
            MenuAction::Cancel => view.cancel_enabled,
        };
        if !enabled {
            return None;
        }
        let update_id = match self.attempt {
            Some(id) => id,
            None => match attempt_id() {
                Ok(id) => id,
                Err(error) => {
                    self.error = Some(error);
                    return None;
                }
            },
        };
        self.next_ticket = self.next_ticket.checked_add(1)?;
        let request = MenuRequest {
            ticket: self.next_ticket,
            action,
            update_id,
        };
        self.attempt = Some(update_id);
        self.pending = Some(request);
        self.error = None;
        self.slow = false;
        self.cancelled = false;
        Some(request)
    }

    pub fn submitted(&mut self, request: MenuRequest) {
        if self.matches(request) {
            self.submitted = true;
        }
    }

    pub fn submission_failed(&mut self, request: MenuRequest, error: UpdateError) {
        if !self.matches(request) || self.closing {
            return;
        }
        self.pending = None;
        self.error = Some(error);
        if !self.submitted {
            self.attempt = None;
        }
        if matches!(error, UpdateError::Closing | UpdateError::Transport) {
            self.close();
        }
    }

    pub fn slow(&mut self, request: MenuRequest) {
        if self.matches(request) && !self.closing {
            self.slow = true;
        }
    }

    pub fn complete(&mut self, request: MenuRequest, reply: UpdateReply) {
        if !self.matches(request) || self.closing {
            return;
        }
        self.pending = None;
        self.slow = false;
        match reply {
            Ok(status) => {
                self.status = Some(status);
                self.error = None;
                if request.action == MenuAction::Cancel {
                    self.attempt = None;
                    self.submitted = false;
                    self.cancelled = true;
                }
            }
            Err(error) => {
                // Even a preparation failure can follow acquisition of the hold.
                // Keep its identity for status, cancel and same-attempt retry.
                self.error = Some(error);
                if matches!(error, UpdateError::Closing | UpdateError::Transport) {
                    self.close();
                }
            }
        }
    }

    fn matches(&self, request: MenuRequest) -> bool {
        self.pending.is_some_and(|current| {
            current.ticket == request.ticket
                && current.action == request.action
                && current.update_id == request.update_id
        })
    }

    pub fn view(&self) -> MenuView {
        let idle = self.available && !self.closing && self.pending.is_none();
        let mut view = MenuView {
            heading: "업데이트(&U)",
            summary: "새 작업을 보류하고 업데이트를 준비합니다.",
            counts: self.status.map_or_else(
                || "진행 중인 작업 수는 준비 후 확인됩니다.".into(),
                |status| {
                    format!(
                        "마지막 확인: 진행 {}건 · 대기 {}건",
                        status.active_run_count, status.pending_run_count
                    )
                },
            ),
            hint: "설치는 별도로 진행합니다.",
            prepare_label: if self.attempt.is_some() {
                "준비 다시 시도(&P)"
            } else {
                "업데이트 준비(&P)"
            },
            prepare_enabled: idle && (self.attempt.is_none() || self.error.is_some()),
            status_enabled: idle && self.submitted,
            cancel_enabled: idle && self.submitted,
        };
        if self.closing {
            view.heading = "업데이트 · 종료 중(&U)";
            view.summary = "작업실을 안전하게 닫고 있습니다.";
            view.hint = "업데이트 준비 보류는 자동으로 취소하지 않습니다.";
        } else if !self.available {
            view.summary = "작업실이 연결되면 사용할 수 있습니다.";
        } else if let Some(request) = self.pending {
            view.heading = "업데이트 · 확인 중(&U)";
            view.summary = match request.action {
                MenuAction::Prepare => "새 작업을 보류하고 있습니다.",
                MenuAction::Status => "준비 상태를 확인하고 있습니다.",
                MenuAction::Cancel => "이번 업데이트 준비를 취소하고 있습니다.",
            };
            if self.slow {
                view.hint = "응답을 기다리고 있습니다. 보류 상태는 유지됩니다.";
            }
        } else if self.error.is_some() {
            view.heading = "업데이트 · 확인 필요(&U)";
            view.summary = "요청을 완료하지 못했습니다.";
            view.hint = if self.submitted {
                "상태를 확인하거나 준비를 다시 시도·취소할 수 있습니다."
            } else {
                "작업실 연결 후 다시 시도할 수 있습니다."
            };
        } else if self.cancelled {
            view.summary = "이번 업데이트 준비를 취소했습니다.";
            view.hint = if self
                .status
                .is_some_and(|status| status.phase == UpdatePhase::Running)
            {
                "새 작업을 다시 진행할 수 있습니다."
            } else {
                "기존에 보류한 작업은 작업실에서 재개할 수 있습니다."
            };
        } else if let Some(status) = self.status {
            match status.phase {
                UpdatePhase::Running => {
                    view.summary = "작업실이 실행 중입니다.";
                }
                UpdatePhase::Draining => {
                    view.heading = "업데이트 · 준비 중(&U)";
                    view.summary = "새 작업을 보류하고 진행 중인 작업을 기다립니다.";
                    view.hint = "상태 확인으로 진행 상황을 확인할 수 있습니다.";
                }
                UpdatePhase::Ready => {
                    view.heading = "업데이트 · 종료 가능(&U)";
                    view.summary = "준비됐습니다. 앱 또는 트레이 메뉴에서 완전 종료를 선택합니다.";
                    view.hint = "작업실 기록은 유지됩니다. 설치는 별도로 진행합니다.";
                }
                UpdatePhase::Blocked => {
                    view.heading = "업데이트 · 확인 필요(&U)";
                    view.summary = "작업실에서 남은 작업을 확인해야 합니다.";
                    view.hint = "준비 취소 후 필요한 작업을 처리할 수 있습니다.";
                }
            }
        }
        view
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> MenuState {
        let mut state = MenuState::default();
        state.activate();
        state
    }

    fn status(phase: UpdatePhase) -> UpdateReply {
        Ok(UpdateStatus {
            phase,
            active_run_count: 0,
            pending_run_count: 3,
        })
    }

    #[test]
    fn controls_require_readiness_and_never_overlap_a_slow_reply() {
        let mut state = MenuState::default();
        assert!(state.begin(MenuAction::Prepare).is_none());
        state.activate();
        let request = state.begin(MenuAction::Prepare).unwrap();
        state.submitted(request);
        state.slow(request);
        for action in [MenuAction::Prepare, MenuAction::Status, MenuAction::Cancel] {
            assert!(state.begin(action).is_none());
        }
        assert!(state.view().hint.contains("보류 상태는 유지"));
        state.complete(request, status(UpdatePhase::Draining));
        assert!(state.view().status_enabled && state.view().cancel_enabled);
        assert!(!state.view().prepare_enabled);
    }

    #[test]
    fn uncertain_preparation_retries_and_cancels_only_the_same_attempt() {
        let mut state = state();
        let prepare = state.begin(MenuAction::Prepare).unwrap();
        state.submitted(prepare);
        state.complete(prepare, Err(UpdateError::PreparationFailed));
        let retry = state.begin(MenuAction::Prepare).unwrap();
        assert_eq!(retry.update_id, prepare.update_id);
        state.submitted(retry);
        state.complete(retry, Err(UpdateError::Unavailable));
        let check = state.begin(MenuAction::Status).unwrap();
        assert_eq!(check.update_id, prepare.update_id);
        state.submitted(check);
        state.complete(check, status(UpdatePhase::Ready));
        let cancel = state.begin(MenuAction::Cancel).unwrap();
        assert_eq!(cancel.update_id, prepare.update_id);
        state.submitted(cancel);
        state.complete(cancel, status(UpdatePhase::Running));
        assert!(!state.view().cancel_enabled);
        assert_ne!(
            state.begin(MenuAction::Prepare).unwrap().update_id,
            prepare.update_id
        );
    }

    #[test]
    fn a_failed_cancel_retains_ownership_and_ignores_late_replies() {
        let mut state = state();
        let prepare = state.begin(MenuAction::Prepare).unwrap();
        state.submitted(prepare);
        state.complete(prepare, status(UpdatePhase::Ready));
        let cancel = state.begin(MenuAction::Cancel).unwrap();
        state.submitted(cancel);
        state.complete(prepare, status(UpdatePhase::Running));
        assert!(!state.view().prepare_enabled && !state.view().cancel_enabled);
        state.complete(cancel, Err(UpdateError::PreparationFailed));
        let next = state.begin(MenuAction::Cancel).unwrap();
        assert_eq!(next.update_id, prepare.update_id);
    }

    #[test]
    fn acknowledged_cancel_does_not_claim_an_existing_hold_was_resumed() {
        let mut state = state();
        let prepare = state.begin(MenuAction::Prepare).unwrap();
        state.submitted(prepare);
        state.complete(prepare, status(UpdatePhase::Ready));
        let cancel = state.begin(MenuAction::Cancel).unwrap();
        state.submitted(cancel);
        state.complete(cancel, status(UpdatePhase::Blocked));
        assert!(state.view().hint.contains("기존에 보류"));
        assert!(state.view().prepare_enabled);
        assert!(!state.view().cancel_enabled && !state.view().status_enabled);
    }

    #[test]
    fn close_during_a_request_never_cancels_or_reopens_the_menu() {
        let mut state = state();
        let prepare = state.begin(MenuAction::Prepare).unwrap();
        state.submitted(prepare);
        state.close();
        state.complete(prepare, status(UpdatePhase::Ready));
        state.activate();
        state.slow(prepare);
        assert_eq!(state.attempt, Some(prepare.update_id));
        assert!(state.pending.is_some());
        let view = state.view();
        assert!(!view.prepare_enabled && !view.cancel_enabled && !view.status_enabled);
        assert_eq!(view.heading, "업데이트 · 종료 중(&U)");
    }

    #[test]
    fn immediate_rejection_drops_only_a_never_submitted_attempt() {
        let mut state = state();
        let first = state.begin(MenuAction::Prepare).unwrap();
        state.submission_failed(first, UpdateError::Unavailable);
        assert!(!state.view().status_enabled && !state.view().cancel_enabled);
        let second = state.begin(MenuAction::Prepare).unwrap();
        assert_ne!(first.update_id, second.update_id);
        state.submitted(second);
        state.complete(second, status(UpdatePhase::Ready));
        let check = state.begin(MenuAction::Status).unwrap();
        state.submission_failed(check, UpdateError::Busy);
        assert!(state.view().cancel_enabled);
        assert_eq!(state.attempt, Some(second.update_id));
    }
}
