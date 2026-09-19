//! Native-only controller commands. A caller timeout never releases the in-flight slot.
use crate::policy::{
    validate_update_response, ServerFrame, SessionSecrets, UpdateAction, UpdateFailure,
    UpdateStatus,
};
use std::sync::{
    mpsc::{self, Receiver, SyncSender},
    Arc, Mutex,
};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateError {
    Unavailable,
    Busy,
    Closing,
    PreparationFailed,
    Transport,
}

pub type UpdateReply = Result<UpdateStatus, UpdateError>;

#[derive(Default)]
struct Gate {
    ready: bool,
    busy: bool,
    closing: bool,
}

struct Request {
    action: UpdateAction,
    request_id: Uuid,
    update_id: Uuid,
    reply: Option<SyncSender<UpdateReply>>,
}

#[derive(Clone)]
pub struct UpdateClient {
    gate: Arc<Mutex<Gate>>,
    requests: SyncSender<Request>,
}

pub struct UpdateInbox {
    gate: Arc<Mutex<Gate>>,
    requests: Receiver<Request>,
    pending: Option<Request>,
}

pub fn channel() -> (UpdateClient, UpdateInbox) {
    let gate = Arc::new(Mutex::new(Gate::default()));
    let (requests, receiver) = mpsc::sync_channel(1);
    (
        UpdateClient {
            gate: gate.clone(),
            requests,
        },
        UpdateInbox {
            gate,
            requests: receiver,
            pending: None,
        },
    )
}

pub fn attempt_id() -> Result<Uuid, UpdateError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| UpdateError::Unavailable)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(Uuid::from_bytes(bytes))
}

impl UpdateClient {
    pub fn close_admission(&self) {
        if let Ok(mut gate) = self.gate.lock() {
            gate.closing = true;
        }
    }

    pub fn submit(
        &self,
        action: UpdateAction,
        update_id: Uuid,
    ) -> Result<Receiver<UpdateReply>, UpdateError> {
        let mut gate = self.gate.lock().map_err(|_| UpdateError::Closing)?;
        if gate.closing {
            return Err(UpdateError::Closing);
        }
        if !gate.ready {
            return Err(UpdateError::Unavailable);
        }
        if gate.busy {
            return Err(UpdateError::Busy);
        }
        let (reply, receiver) = mpsc::sync_channel(1);
        let request = Request {
            action,
            request_id: attempt_id()?,
            update_id,
            reply: Some(reply),
        };
        self.requests
            .try_send(request)
            .map_err(|_| UpdateError::Closing)?;
        gate.busy = true;
        Ok(receiver)
    }
}

impl UpdateInbox {
    pub fn activate(&self) -> Result<bool, &'static str> {
        let mut gate = self
            .gate
            .lock()
            .map_err(|_| "업데이트 제어를 열지 못했습니다.")?;
        if gate.closing {
            return Ok(false);
        }
        gate.ready = true;
        Ok(true)
    }

    /// The supervisor writes this once. A write error must close the session, never retry it.
    pub fn next_frame(&mut self, secrets: &SessionSecrets) -> Option<Vec<u8>> {
        if self.pending.is_some() {
            return None;
        }
        let request = self.requests.try_recv().ok()?;
        let closing = self.gate.lock().map(|gate| gate.closing).unwrap_or(true);
        if closing {
            if let Some(reply) = request.reply {
                let _ = reply.send(Err(UpdateError::Closing));
            }
            return None;
        }
        let bytes = secrets.update_frame(request.action, &request.request_id, &request.update_id);
        self.pending = Some(request);
        Some(bytes)
    }

    /// Route only correlated update replies; lifecycle frames retain their original validator.
    pub fn accept(
        &mut self,
        frame: ServerFrame,
        secrets: &SessionSecrets,
    ) -> Result<Option<ServerFrame>, &'static str> {
        if !matches!(&frame, ServerFrame::UpdateStatus { .. }) {
            return Ok(Some(frame));
        }
        let request = self
            .pending
            .as_ref()
            .ok_or("요청하지 않은 업데이트 응답입니다.")?;
        let result =
            validate_update_response(frame, secrets, &request.request_id, &request.update_id)?;
        let mut request = self.pending.take().expect("validated pending request");
        self.gate
            .lock()
            .map_err(|_| "업데이트 제어를 확인하지 못했습니다.")?
            .busy = false;
        if let Some(reply) = request.reply.take() {
            let result = result.map_err(|error| match error {
                UpdateFailure::Unavailable => UpdateError::Unavailable,
                UpdateFailure::PreparationFailed => UpdateError::PreparationFailed,
            });
            let _ = reply.send(result);
        }
        Ok(None)
    }

    pub fn begin_close(&mut self) {
        self.close_with(UpdateError::Closing);
    }

    pub fn transport_failed(&mut self) {
        self.close_with(UpdateError::Transport);
    }

    fn close_with(&mut self, error: UpdateError) {
        if let Ok(mut gate) = self.gate.lock() {
            gate.closing = true;
        }
        // Keep pending correlation: a valid reply may already be buffered before shutdown.
        if let Some(pending) = self.pending.as_mut() {
            if let Some(reply) = pending.reply.take() {
                let _ = reply.send(Err(error));
            }
        }
        while let Ok(mut queued) = self.requests.try_recv() {
            if let Some(reply) = queued.reply.take() {
                let _ = reply.send(Err(error));
            }
        }
    }
}

impl Drop for UpdateInbox {
    fn drop(&mut self) {
        self.begin_close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::{parse_frame, UpdatePhase};
    use std::time::Duration;

    fn response(bytes: &[u8], code: Option<&str>) -> ServerFrame {
        let mut value: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        value["type"] = "update-status".into();
        if let Some(code) = code {
            value["code"] = code.into();
        } else {
            value["status"] =
                serde_json::json!({ "phase": "ready", "activeRunCount": 0, "pendingRunCount": 2 });
        }
        let mut frame = serde_json::to_vec(&value).unwrap();
        frame.push(b'\n');
        parse_frame(&frame).unwrap()
    }

    #[test]
    fn one_command_remains_owned_across_caller_timeout_and_reply_disconnect() {
        let secrets = SessionSecrets::generate().unwrap();
        let (client, mut inbox) = channel();
        let id = attempt_id().unwrap();
        assert!(matches!(
            client.submit(UpdateAction::Prepare, id),
            Err(UpdateError::Unavailable)
        ));
        inbox.activate().unwrap();
        let reply = client.submit(UpdateAction::Prepare, id).unwrap();
        assert!(reply.recv_timeout(Duration::from_millis(1)).is_err());
        assert!(matches!(
            client.submit(UpdateAction::Cancel, id),
            Err(UpdateError::Busy)
        ));
        let frame = inbox.next_frame(&secrets).unwrap();
        assert!(inbox.next_frame(&secrets).is_none());
        drop(reply);
        assert!(matches!(
            client.submit(UpdateAction::Status, id),
            Err(UpdateError::Busy)
        ));
        assert!(inbox
            .accept(response(&frame, None), &secrets)
            .unwrap()
            .is_none());
        let reply = client.submit(UpdateAction::Status, id).unwrap();
        let next = inbox.next_frame(&secrets).unwrap();
        let first: serde_json::Value = serde_json::from_slice(&frame).unwrap();
        let second: serde_json::Value = serde_json::from_slice(&next).unwrap();
        assert_ne!(first["requestId"], second["requestId"]);
        assert_eq!(first["updateId"], second["updateId"]);
        inbox.accept(response(&next, None), &secrets).unwrap();
        assert_eq!(reply.recv().unwrap().unwrap().phase, UpdatePhase::Ready);
    }

    #[test]
    fn closing_rejects_queued_and_new_requests_but_drains_the_matching_buffered_reply() {
        let secrets = SessionSecrets::generate().unwrap();
        let id = attempt_id().unwrap();
        let (client, mut inbox) = channel();
        inbox.activate().unwrap();
        let queued = client.submit(UpdateAction::Prepare, id).unwrap();
        inbox.begin_close();
        assert_eq!(queued.recv().unwrap(), Err(UpdateError::Closing));
        assert!(inbox.next_frame(&secrets).is_none());
        assert!(matches!(
            client.submit(UpdateAction::Prepare, id),
            Err(UpdateError::Closing)
        ));
        let (client, mut inbox) = channel();
        inbox.activate().unwrap();
        let pending = client.submit(UpdateAction::Prepare, id).unwrap();
        let frame = inbox.next_frame(&secrets).unwrap();
        inbox.begin_close();
        assert_eq!(pending.recv().unwrap(), Err(UpdateError::Closing));
        assert!(inbox
            .accept(response(&frame, None), &secrets)
            .unwrap()
            .is_none());
        assert!(inbox.accept(response(&frame, None), &secrets).is_err());
    }

    #[test]
    fn known_server_failure_is_retryable_but_foreign_response_and_transport_failure_are_not() {
        let secrets = SessionSecrets::generate().unwrap();
        let id = attempt_id().unwrap();
        let (client, mut inbox) = channel();
        inbox.activate().unwrap();
        let reply = client.submit(UpdateAction::Cancel, id).unwrap();
        let frame = inbox.next_frame(&secrets).unwrap();
        inbox
            .accept(
                response(&frame, Some("DESKTOP_UPDATE_PREPARATION_FAILED")),
                &secrets,
            )
            .unwrap();
        assert_eq!(reply.recv().unwrap(), Err(UpdateError::PreparationFailed));
        let pending = client.submit(UpdateAction::Cancel, id).unwrap();
        let frame = inbox.next_frame(&secrets).unwrap();
        let foreign = SessionSecrets::generate().unwrap();
        assert!(inbox.accept(response(&frame, None), &foreign).is_err());
        assert!(matches!(
            client.submit(UpdateAction::Cancel, id),
            Err(UpdateError::Busy)
        ));
        inbox.transport_failed();
        assert_eq!(pending.recv().unwrap(), Err(UpdateError::Transport));
        assert!(matches!(
            client.submit(UpdateAction::Cancel, id),
            Err(UpdateError::Closing)
        ));
    }

    #[test]
    fn simultaneous_callers_cannot_send_overlapping_control_frames() {
        let (client, inbox) = channel();
        inbox.activate().unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let attempts: Vec<_> = (0..2)
            .map(|_| {
                let client = client.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    client.submit(UpdateAction::Prepare, attempt_id().unwrap())
                })
            })
            .collect();
        barrier.wait();
        let results: Vec<_> = attempts
            .into_iter()
            .map(|task| task.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(UpdateError::Busy)))
                .count(),
            1
        );
        drop(inbox);
        for reply in results.into_iter().flatten() {
            assert_eq!(reply.recv().unwrap(), Err(UpdateError::Closing));
        }
    }

    #[test]
    fn close_during_activation_is_inactive_without_turning_normal_shutdown_into_failure() {
        let (client, inbox) = channel();
        client.close_admission();
        assert_eq!(inbox.activate(), Ok(false));
        assert!(matches!(
            client.submit(UpdateAction::Prepare, attempt_id().unwrap()),
            Err(UpdateError::Closing)
        ));
    }
}
