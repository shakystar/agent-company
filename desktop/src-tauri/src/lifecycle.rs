use crate::policy::{validate_ready, ServerFrame, SessionSecrets, PROTOCOL};
use url::Url;

#[derive(Default)]
pub struct Lifecycle {
    pub ready: bool,
    pub shutdown_requested: bool,
    pub stopped: bool,
    pub failed: bool,
    pub exited: bool,
}

impl Lifecycle {
    pub fn accept_with_updates(
        &mut self,
        frame: ServerFrame,
        secrets: &SessionSecrets,
        updates: &mut crate::update::UpdateInbox,
    ) -> Result<Option<Url>, &'static str> {
        if self.failed {
            updates.transport_failed();
        }
        let result = if matches!(&frame, ServerFrame::UpdateStatus { .. })
            && (!self.ready || self.stopped || self.exited)
        {
            Err("업데이트 응답 순서가 올바르지 않습니다.")
        } else {
            updates
                .accept(frame, secrets)
                .and_then(|frame| match frame {
                    Some(frame) => self.accept(frame, secrets),
                    None => Ok(None),
                })
        };
        if result.is_err() {
            self.failed = true;
            updates.transport_failed();
        }
        result
    }

    pub fn accept(
        &mut self,
        frame: ServerFrame,
        secrets: &SessionSecrets,
    ) -> Result<Option<Url>, &'static str> {
        match frame {
            frame @ ServerFrame::Ready { .. } if !self.ready && !self.stopped => {
                let origin = validate_ready(frame, secrets)?;
                self.ready = true;
                Ok(if self.shutdown_requested {
                    None
                } else {
                    Some(origin)
                })
            }
            ServerFrame::Stopped { protocol, nonce }
                if self.shutdown_requested
                    && !self.stopped
                    && protocol == PROTOCOL
                    && nonce == secrets.nonce =>
            {
                self.stopped = true;
                Ok(None)
            }
            ServerFrame::Error {
                protocol,
                nonce,
                code,
            } if protocol == PROTOCOL
                && nonce.as_deref() == Some(&secrets.nonce)
                && code == "DESKTOP_SESSION_FAILED" =>
            {
                self.failed = true;
                Err("개인 작업실을 시작하거나 종료하지 못했습니다.")
            }
            _ => Err("제어 서버 응답 순서가 올바르지 않습니다."),
        }
    }

    pub fn confirm_exit(&mut self, success: bool) -> bool {
        self.exited = true;
        !self.failed && self.shutdown_requested && self.stopped && success
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ready(secrets: &SessionSecrets) -> ServerFrame {
        ServerFrame::Ready {
            protocol: PROTOCOL,
            nonce: secrets.nonce.clone(),
            origin: "http://127.0.0.1:43219".into(),
            workspace_key: "09000000-0000-4000-8000-000000000001".into(),
        }
    }
    fn stopped(secrets: &SessionSecrets) -> ServerFrame {
        ServerFrame::Stopped {
            protocol: PROTOCOL,
            nonce: secrets.nonce.clone(),
        }
    }
    #[test]
    fn shutdown_and_stopped_do_not_replace_actual_child_exit() {
        let secrets = SessionSecrets::generate().unwrap();
        let mut state = Lifecycle::default();
        assert!(state.accept(ready(&secrets), &secrets).unwrap().is_some());
        assert!(state.accept(ready(&secrets), &secrets).is_err());
        assert!(state.accept(stopped(&secrets), &secrets).is_err());
        state.shutdown_requested = true;
        state.accept(stopped(&secrets), &secrets).unwrap();
        assert!(!state.exited);
        assert!(state.confirm_exit(true));
        assert!(state.exited);
    }
    #[test]
    fn closing_during_startup_never_opens_the_remote_page_and_missing_ack_is_failure() {
        let secrets = SessionSecrets::generate().unwrap();
        let mut closing = Lifecycle {
            shutdown_requested: true,
            ..Lifecycle::default()
        };
        assert!(closing.accept(ready(&secrets), &secrets).unwrap().is_none());
        assert!(!closing.confirm_exit(true));
        let mut failed = Lifecycle {
            shutdown_requested: true,
            stopped: true,
            ..Lifecycle::default()
        };
        assert!(!failed.confirm_exit(false));
    }

    #[test]
    fn buffered_update_reply_is_accepted_during_shutdown_but_never_after_stopped() {
        use crate::policy::{parse_frame, UpdateAction};
        use crate::update;
        for after_stopped in [false, true] {
            let secrets = SessionSecrets::generate().unwrap();
            let (client, mut inbox) = update::channel();
            let mut lifecycle = Lifecycle::default();
            lifecycle
                .accept_with_updates(ready(&secrets), &secrets, &mut inbox)
                .unwrap();
            inbox.activate().unwrap();
            let reply = client
                .submit(UpdateAction::Prepare, update::attempt_id().unwrap())
                .unwrap();
            let mut value: serde_json::Value =
                serde_json::from_slice(&inbox.next_frame(&secrets).unwrap()).unwrap();
            value["type"] = "update-status".into();
            value["status"] =
                serde_json::json!({ "phase": "ready", "activeRunCount": 0, "pendingRunCount": 0 });
            let mut bytes = serde_json::to_vec(&value).unwrap();
            bytes.push(b'\n');
            lifecycle.shutdown_requested = true;
            inbox.begin_close();
            assert_eq!(reply.recv().unwrap(), Err(update::UpdateError::Closing));
            if after_stopped {
                lifecycle
                    .accept_with_updates(stopped(&secrets), &secrets, &mut inbox)
                    .unwrap();
                assert!(lifecycle
                    .accept_with_updates(parse_frame(&bytes).unwrap(), &secrets, &mut inbox)
                    .is_err());
            } else {
                assert!(lifecycle
                    .accept_with_updates(parse_frame(&bytes).unwrap(), &secrets, &mut inbox)
                    .unwrap()
                    .is_none());
                lifecycle
                    .accept_with_updates(stopped(&secrets), &secrets, &mut inbox)
                    .unwrap();
                assert!(lifecycle.confirm_exit(true));
            }
        }
    }

    #[test]
    fn invalid_frame_closes_pending_call_before_later_buffered_success_can_arrive() {
        use crate::policy::{parse_frame, UpdateAction};
        use crate::update;
        let secrets = SessionSecrets::generate().unwrap();
        let (client, mut inbox) = update::channel();
        let mut lifecycle = Lifecycle::default();
        lifecycle
            .accept_with_updates(ready(&secrets), &secrets, &mut inbox)
            .unwrap();
        inbox.activate().unwrap();
        let reply = client
            .submit(UpdateAction::Prepare, update::attempt_id().unwrap())
            .unwrap();
        let mut value: serde_json::Value =
            serde_json::from_slice(&inbox.next_frame(&secrets).unwrap()).unwrap();
        value["type"] = "update-status".into();
        value["status"] =
            serde_json::json!({ "phase": "ready", "activeRunCount": 0, "pendingRunCount": 0 });
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        value["requestId"] = update::attempt_id()
            .unwrap()
            .hyphenated()
            .to_string()
            .into();
        let mut invalid = serde_json::to_vec(&value).unwrap();
        invalid.push(b'\n');
        assert!(lifecycle
            .accept_with_updates(parse_frame(&invalid).unwrap(), &secrets, &mut inbox)
            .is_err());
        assert!(lifecycle.failed);
        assert_eq!(reply.recv().unwrap(), Err(update::UpdateError::Transport));
        // Real exit can lead directly to a buffered-frame drain, before the next main loop.
        assert!(lifecycle
            .accept_with_updates(parse_frame(&bytes).unwrap(), &secrets, &mut inbox)
            .unwrap()
            .is_none());
        assert!(matches!(
            client.submit(UpdateAction::Status, update::attempt_id().unwrap()),
            Err(update::UpdateError::Closing)
        ));
        assert!(!lifecycle.confirm_exit(true));
    }
}
