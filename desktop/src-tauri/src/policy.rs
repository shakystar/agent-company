use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use cookie::{Cookie, SameSite};
use serde::{Deserialize, Serialize};
use std::path::Path;
use url::Url;
use uuid::Uuid;

pub const PROTOCOL: u8 = 1;
pub const MAX_FRAME_BYTES: usize = 16 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum UpdateAction {
    #[serde(rename = "prepare-update")]
    Prepare,
    #[serde(rename = "update-status")]
    Status,
    #[serde(rename = "cancel-update")]
    Cancel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    Running,
    Draining,
    Ready,
    Blocked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateStatus {
    pub phase: UpdatePhase,
    pub active_run_count: u64,
    pub pending_run_count: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateFailure {
    Unavailable,
    PreparationFailed,
}

// Deliberately not Debug: these fields never belong in native logs or URLs.
pub struct SessionSecrets {
    pub nonce: String,
    pub token: String,
    pub cookie_name: String,
}

impl SessionSecrets {
    pub fn generate() -> Result<Self, &'static str> {
        let mut bytes = [0u8; 80];
        getrandom::fill(&mut bytes).map_err(|_| "운영체제의 인증 난수를 만들지 못했습니다.")?;
        Ok(Self {
            nonce: URL_SAFE_NO_PAD.encode(&bytes[..32]),
            token: URL_SAFE_NO_PAD.encode(&bytes[32..64]),
            cookie_name: format!(
                "ac_desktop_{}",
                bytes[64..]
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            ),
        })
    }

    pub fn start_frame(
        &self,
        resource_root: &Path,
        app_data_root: &Path,
    ) -> Result<Vec<u8>, &'static str> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Start<'a> {
            r#type: &'static str,
            protocol: u8,
            nonce: &'a str,
            token: &'a str,
            cookie_name: &'a str,
            resource_root: &'a str,
            app_data_root: &'a str,
        }
        let mut bytes = serde_json::to_vec(&Start {
            r#type: "start",
            protocol: PROTOCOL,
            nonce: &self.nonce,
            token: &self.token,
            cookie_name: &self.cookie_name,
            resource_root: resource_root
                .to_str()
                .ok_or("설치 경로를 확인해야 합니다.")?,
            app_data_root: app_data_root
                .to_str()
                .ok_or("사용자 경로를 확인해야 합니다.")?,
        })
        .map_err(|_| "시작 요청을 만들지 못했습니다.")?;
        bytes.push(b'\n');
        if bytes.len() > MAX_FRAME_BYTES {
            return Err("설치 경로가 너무 깁니다.");
        }
        Ok(bytes)
    }

    pub fn shutdown_frame(&self) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(
            &serde_json::json!({ "type": "shutdown", "protocol": PROTOCOL, "nonce": self.nonce }),
        )
        .expect("fixed shutdown frame");
        bytes.push(b'\n');
        bytes
    }

    pub fn update_frame(
        &self,
        action: UpdateAction,
        request_id: &Uuid,
        update_id: &Uuid,
    ) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(&serde_json::json!({
            "type": action,
            "protocol": PROTOCOL,
            "nonce": self.nonce,
            "requestId": request_id.hyphenated().to_string(),
            "updateId": update_id.hyphenated().to_string(),
        }))
        .expect("fixed update control frame");
        bytes.push(b'\n');
        bytes
    }

    pub fn cookie(&self) -> Cookie<'static> {
        Cookie::build((self.cookie_name.clone(), self.token.clone()))
            .domain("127.0.0.1")
            .path("/")
            .http_only(true)
            .same_site(SameSite::Strict)
            .secure(false)
            .build()
    }

    pub fn cookie_matches(&self, value: &Cookie<'_>) -> bool {
        value.name() == self.cookie_name
            && value.value() == self.token
            && value.domain() == Some("127.0.0.1")
            && value.path() == Some("/")
            && value.http_only() == Some(true)
            && value.same_site() == Some(SameSite::Strict)
            && value.secure() != Some(true)
            && matches!(value.expires(), None | Some(cookie::Expiration::Session))
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum ServerFrame {
    #[serde(rename = "ready", rename_all = "camelCase")]
    Ready {
        protocol: u8,
        nonce: String,
        origin: String,
        workspace_key: String,
    },
    #[serde(rename = "stopped")]
    Stopped { protocol: u8, nonce: String },
    #[serde(rename = "error")]
    Error {
        protocol: u8,
        nonce: Option<String>,
        code: String,
    },
    #[serde(rename = "update-status", rename_all = "camelCase")]
    UpdateStatus {
        protocol: u8,
        nonce: String,
        request_id: String,
        update_id: String,
        #[serde(default, deserialize_with = "present_non_null")]
        status: Option<UpdateStatus>,
        #[serde(default, deserialize_with = "present_non_null")]
        code: Option<String>,
    },
}

// An omitted optional field is None. A present field must contain its actual
// type, so explicit null cannot disguise an extra status/code branch.
fn present_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

pub fn parse_frame(bytes: &[u8]) -> Result<ServerFrame, &'static str> {
    if bytes.len() > MAX_FRAME_BYTES || bytes.last() != Some(&b'\n') {
        return Err("제어 서버 응답 형식이 올바르지 않습니다.");
    }
    serde_json::from_slice(bytes).map_err(|_| "제어 서버 응답 형식이 올바르지 않습니다.")
}

pub fn validate_origin(value: &str) -> Result<Url, &'static str> {
    let url = Url::parse(value).map_err(|_| "제어 서버 주소가 올바르지 않습니다.")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.port() == Some(0)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.origin().ascii_serialization() != value
    {
        return Err("제어 서버 주소가 올바르지 않습니다.");
    }
    Ok(url)
}

pub fn validate_ready(frame: ServerFrame, secrets: &SessionSecrets) -> Result<Url, &'static str> {
    match frame {
        ServerFrame::Ready {
            protocol,
            nonce,
            origin,
            workspace_key,
        } if protocol == PROTOCOL && nonce == secrets.nonce => {
            let identity = Uuid::parse_str(&workspace_key)
                .map_err(|_| "작업실 식별자가 올바르지 않습니다.")?;
            if identity.hyphenated().to_string() != workspace_key {
                return Err("작업실 식별자가 올바르지 않습니다.");
            }
            validate_origin(&origin)
        }
        _ => Err("제어 서버의 시작 확인이 일치하지 않습니다."),
    }
}

pub fn validate_update_response(
    frame: ServerFrame,
    secrets: &SessionSecrets,
    request_id: &Uuid,
    update_id: &Uuid,
) -> Result<Result<UpdateStatus, UpdateFailure>, &'static str> {
    let invalid = "업데이트 준비 응답이 올바르지 않습니다.";
    match frame {
        ServerFrame::UpdateStatus {
            protocol,
            nonce,
            request_id: received_request,
            update_id: received_update,
            status,
            code,
        } if protocol == PROTOCOL
            && nonce == secrets.nonce
            // Rendering the expected UUIDs also rejects alternate spelling,
            // uppercase, braces and non-hyphenated forms of the same identity.
            && received_request == request_id.hyphenated().to_string()
            && received_update == update_id.hyphenated().to_string() =>
        {
            match (status, code) {
                (Some(status), None)
                    if status.active_run_count <= MAX_SAFE_INTEGER
                        && status.pending_run_count <= MAX_SAFE_INTEGER
                        && (status.phase != UpdatePhase::Ready || status.active_run_count == 0) =>
                {
                    Ok(Ok(status))
                }
                (None, Some(code)) if code == "DESKTOP_UPDATE_UNAVAILABLE" => {
                    Ok(Err(UpdateFailure::Unavailable))
                }
                (None, Some(code)) if code == "DESKTOP_UPDATE_PREPARATION_FAILED" => {
                    Ok(Err(UpdateFailure::PreparationFailed))
                }
                _ => Err(invalid),
            }
        }
        _ => Err(invalid),
    }
}

pub fn is_locked_shell(url: &Url) -> bool {
    // Windows custom-protocol spelling. No prefix or *.localhost matching.
    url.scheme() == "http"
        && url.host_str() == Some("tauri.localhost")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && crate::shell::is_document_path(url.path())
}

pub fn allow_top_navigation(url: &Url, origin: Option<&Url>) -> bool {
    match origin {
        Some(expected) => {
            url.origin() == expected.origin()
                && url.username().is_empty()
                && url.password().is_none()
        }
        None => is_locked_shell(url),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update_fixture() -> (SessionSecrets, Uuid, Uuid, serde_json::Value) {
        let secrets = SessionSecrets::generate().unwrap();
        let request = Uuid::parse_str("a1000000-0000-4000-8000-000000000001").unwrap();
        let update = Uuid::parse_str("b1000000-0000-4000-8000-000000000002").unwrap();
        let value = serde_json::json!({
            "type": "update-status", "protocol": PROTOCOL, "nonce": secrets.nonce,
            "requestId": request.to_string(), "updateId": update.to_string(),
            "status": {"phase": "draining", "activeRunCount": 1, "pendingRunCount": 2}
        });
        (secrets, request, update, value)
    }

    fn validate_update_value(
        value: serde_json::Value,
        secrets: &SessionSecrets,
        request: &Uuid,
        update: &Uuid,
    ) -> Result<Result<UpdateStatus, UpdateFailure>, &'static str> {
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        validate_update_response(parse_frame(&bytes)?, secrets, request, update)
    }

    #[test]
    fn update_requests_use_exact_actions_and_ids_without_account_credentials() {
        let (secrets, request, update, _) = update_fixture();
        for (action, wire) in [
            (UpdateAction::Prepare, "prepare-update"),
            (UpdateAction::Status, "update-status"),
            (UpdateAction::Cancel, "cancel-update"),
        ] {
            let bytes = secrets.update_frame(action, &request, &update);
            assert_eq!(bytes.last(), Some(&b'\n'));
            assert!(bytes.len() <= MAX_FRAME_BYTES);
            let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(parsed.as_object().unwrap().len(), 5);
            assert_eq!(parsed["type"], wire);
            assert_eq!(parsed["protocol"], PROTOCOL);
            assert_eq!(parsed["nonce"], secrets.nonce);
            assert_eq!(parsed["requestId"], request.hyphenated().to_string());
            assert_eq!(parsed["updateId"], update.hyphenated().to_string());
            let text = String::from_utf8(bytes).unwrap();
            assert!(!text.contains(&secrets.token));
            assert!(!text.contains(&secrets.cookie_name));
        }
    }

    #[test]
    fn update_status_accepts_each_phase_and_only_known_failures() {
        let (secrets, request, update, value) = update_fixture();
        for (wire, phase) in [
            ("running", UpdatePhase::Running),
            ("draining", UpdatePhase::Draining),
            ("ready", UpdatePhase::Ready),
            ("blocked", UpdatePhase::Blocked),
        ] {
            let mut frame = value.clone();
            frame["status"]["phase"] = wire.into();
            frame["status"]["activeRunCount"] = 0.into();
            assert_eq!(
                validate_update_value(frame, &secrets, &request, &update),
                Ok(Ok(UpdateStatus {
                    phase,
                    active_run_count: 0,
                    pending_run_count: 2
                }))
            );
        }
        for (code, failure) in [
            ("DESKTOP_UPDATE_UNAVAILABLE", UpdateFailure::Unavailable),
            (
                "DESKTOP_UPDATE_PREPARATION_FAILED",
                UpdateFailure::PreparationFailed,
            ),
        ] {
            let mut frame = value.clone();
            frame.as_object_mut().unwrap().remove("status");
            frame["code"] = code.into();
            assert_eq!(
                validate_update_value(frame, &secrets, &request, &update),
                Ok(Err(failure))
            );
        }
    }

    #[test]
    fn update_response_rejects_mismatched_nonce_protocol_or_noncanonical_ids() {
        let (secrets, request, update, value) = update_fixture();
        for (field, invalid) in [
            ("nonce", serde_json::json!("other-session")),
            ("protocol", serde_json::json!(2)),
            ("requestId", serde_json::json!(update.to_string())),
            ("updateId", serde_json::json!(request.to_string())),
            (
                "requestId",
                serde_json::json!(request.to_string().to_uppercase()),
            ),
            (
                "updateId",
                serde_json::json!(update.to_string().to_uppercase()),
            ),
            ("requestId", serde_json::json!(request.simple().to_string())),
            ("updateId", serde_json::json!(format!("{{{update}}}"))),
            ("updateId", serde_json::json!("not-a-uuid")),
        ] {
            let mut frame = value.clone();
            frame[field] = invalid;
            assert!(
                validate_update_value(frame, &secrets, &request, &update).is_err(),
                "{field}"
            );
        }
        assert!(validate_update_response(
            ServerFrame::Stopped {
                protocol: PROTOCOL,
                nonce: secrets.nonce.clone()
            },
            &secrets,
            &request,
            &update,
        )
        .is_err());
    }

    #[test]
    fn update_status_and_error_are_exclusive_and_explicit_null_is_invalid() {
        let (secrets, request, update, value) = update_fixture();
        let mut both = value.clone();
        both["code"] = "DESKTOP_UPDATE_UNAVAILABLE".into();
        assert!(validate_update_value(both, &secrets, &request, &update).is_err());
        let mut neither = value.clone();
        neither.as_object_mut().unwrap().remove("status");
        assert!(validate_update_value(neither, &secrets, &request, &update).is_err());
        for field in ["status", "code"] {
            let mut frame = value.clone();
            frame[field] = serde_json::Value::Null;
            assert!(validate_update_value(frame, &secrets, &request, &update).is_err());
        }
        let mut unknown = value;
        unknown.as_object_mut().unwrap().remove("status");
        unknown["code"] = "private-error-text-must-not-be-projected".into();
        assert_eq!(
            validate_update_value(unknown, &secrets, &request, &update),
            Err("업데이트 준비 응답이 올바르지 않습니다.")
        );
    }

    #[test]
    fn update_counts_are_safe_integers_and_ready_requires_no_active_run() {
        let (secrets, request, update, value) = update_fixture();
        let mut limit = value.clone();
        limit["status"]["activeRunCount"] = MAX_SAFE_INTEGER.into();
        limit["status"]["pendingRunCount"] = MAX_SAFE_INTEGER.into();
        assert!(validate_update_value(limit, &secrets, &request, &update).is_ok());
        for field in ["activeRunCount", "pendingRunCount"] {
            for invalid in [
                serde_json::json!(MAX_SAFE_INTEGER + 1),
                serde_json::json!(u64::MAX),
                serde_json::json!(-1),
                serde_json::json!(0.5),
                serde_json::json!(1.0),
                serde_json::json!("0"),
                serde_json::Value::Null,
            ] {
                let mut frame = value.clone();
                frame["status"][field] = invalid;
                assert!(
                    validate_update_value(frame, &secrets, &request, &update).is_err(),
                    "{field}"
                );
            }
        }
        let mut ready = value;
        ready["status"]["phase"] = "ready".into();
        assert!(validate_update_value(ready.clone(), &secrets, &request, &update).is_err());
        ready["status"]["activeRunCount"] = 0.into();
        ready["status"]["pendingRunCount"] = MAX_SAFE_INTEGER.into();
        assert_eq!(
            validate_update_value(ready, &secrets, &request, &update)
                .unwrap()
                .unwrap()
                .phase,
            UpdatePhase::Ready
        );
    }

    #[test]
    fn update_parser_rejects_unknown_missing_duplicate_and_wrong_typed_fields() {
        let (secrets, request, update, value) = update_fixture();
        for nested in [false, true] {
            let mut frame = value.clone();
            if nested {
                frame["status"]["extra"] = true.into();
            } else {
                frame["extra"] = true.into();
            }
            assert!(validate_update_value(frame, &secrets, &request, &update).is_err());
        }
        for field in ["phase", "activeRunCount", "pendingRunCount"] {
            let mut frame = value.clone();
            frame["status"].as_object_mut().unwrap().remove(field);
            assert!(validate_update_value(frame, &secrets, &request, &update).is_err());
        }
        for field in ["protocol", "nonce", "requestId", "updateId"] {
            let mut frame = value.clone();
            frame.as_object_mut().unwrap().remove(field);
            assert!(validate_update_value(frame, &secrets, &request, &update).is_err());
        }
        let mut phase = value.clone();
        phase["status"]["phase"] = "installed".into();
        assert!(validate_update_value(phase, &secrets, &request, &update).is_err());
        let mut code = value.clone();
        code.as_object_mut().unwrap().remove("status");
        code["code"] = 1.into();
        assert!(validate_update_value(code, &secrets, &request, &update).is_err());
        let text = serde_json::to_string(&value).unwrap();
        let duplicate = format!("{{\"requestId\":\"{request}\",{}\n", &text[1..]);
        assert!(parse_frame(duplicate.as_bytes()).is_err());
        assert!(parse_frame(format!("{text}\n{text}\n").as_bytes()).is_err());
    }

    #[test]
    fn random_credentials_and_cookie_have_the_private_parent_contract() {
        let first = SessionSecrets::generate().unwrap();
        let second = SessionSecrets::generate().unwrap();
        assert_eq!(URL_SAFE_NO_PAD.decode(&first.token).unwrap().len(), 32);
        assert_eq!(first.token.len(), 43);
        assert_eq!(first.nonce.len(), 43);
        assert_eq!(first.cookie_name.len(), 43);
        assert_ne!(first.token, second.token);
        assert_ne!(first.cookie_name, second.cookie_name);
        let value = first.cookie();
        assert!(first.cookie_matches(&value));
        let mut read_back = value.clone();
        read_back.set_expires(cookie::Expiration::Session);
        assert!(first.cookie_matches(&read_back));
        let mut wrong = value.clone();
        wrong.set_http_only(false);
        assert!(!first.cookie_matches(&wrong));
        let start = first
            .start_frame(Path::new("C:\\설치 자원"), Path::new("C:\\개인 데이터"))
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&start).unwrap();
        assert_eq!(parsed["protocol"], 1);
        assert_eq!(parsed["token"], first.token);
        assert!(parsed.get("cookieName").is_some());
        assert!(!String::from_utf8(first.shutdown_frame())
            .unwrap()
            .contains(&first.token));
    }
    #[test]
    fn ready_is_bound_to_the_child_nonce_protocol_and_exact_loopback_origin() {
        let secrets = SessionSecrets::generate().unwrap();
        let ready = |origin: &str, nonce: &str| {
            serde_json::to_vec(&serde_json::json!({ "type": "ready", "protocol": 1,
            "nonce": nonce, "origin": origin, "workspaceKey": "09000000-0000-4000-8000-000000000001" })).unwrap()
        };
        let mut good = ready("http://127.0.0.1:43219", &secrets.nonce);
        good.push(b'\n');
        assert!(validate_ready(parse_frame(&good).unwrap(), &secrets).is_ok());
        for origin in [
            "http://localhost:43219",
            "http://127.0.0.2:43219",
            "http://127.0.0.1:0",
            "http://127.0.0.1:80",
            "http://127.0.0.1:43219/",
            "http://127.0.0.1:43219?token=x",
            "http://x@127.0.0.1:43219",
            "https://127.0.0.1:43219",
        ] {
            assert!(validate_origin(origin).is_err(), "{origin}");
        }
        let mut wrong = ready("http://127.0.0.1:43219", "wrong");
        wrong.push(b'\n');
        assert!(validate_ready(parse_frame(&wrong).unwrap(), &secrets).is_err());
        assert!(parse_frame(&vec![b'a'; MAX_FRAME_BYTES + 1]).is_err());
        assert!(parse_frame(b"{\xff}\n").is_err());
        assert!(parse_frame(&good[..good.len() - 1]).is_err());
    }
    #[test]
    fn top_level_and_popup_policy_does_not_promote_preview_frames_or_remote_pages() {
        let origin = validate_origin("http://127.0.0.1:43219").unwrap();
        assert!(allow_top_navigation(
            &Url::parse("http://tauri.localhost/index.html").unwrap(),
            None
        ));
        assert!(!allow_top_navigation(&origin, None));
        assert!(allow_top_navigation(
            &origin.join("/api/files/id/download").unwrap(),
            Some(&origin)
        ));
        for value in [
            "http://127.0.0.1:4310",
            "http://127.0.0.2:43219/preview",
            "http://localhost:43219",
            "https://example.com",
            "file:///C:/private",
            "http://tauri.localhost/index.html",
            "http://tauri.evil.test/",
        ] {
            assert!(
                !allow_top_navigation(&Url::parse(value).unwrap(), Some(&origin)),
                "{value}"
            );
        }
    }

    #[test]
    fn locked_navigation_accepts_only_fixed_local_state_documents() {
        use crate::shell::ShellState;
        let origin = validate_origin("http://127.0.0.1:43219").unwrap();
        for state in [
            ShellState::Starting,
            ShellState::Stopping,
            ShellState::FailureStopping,
            ShellState::Stopped,
            ShellState::Failed,
        ] {
            assert!(allow_top_navigation(&state.url(), None));
            assert!(!allow_top_navigation(&state.url(), Some(&origin)));
        }
        for value in [
            "http://tauri.localhost/unknown.html",
            "http://tauri.localhost/failed.html?error=private",
            "http://tauri.localhost/failed.html#private",
            "http://tauri.localhost:43219/failed.html",
            "http://user@tauri.localhost/failed.html",
            "http://tauri.localhost.evil.test/failed.html",
            "https://tauri.localhost/failed.html",
            "http://127.0.0.2:43219/failed.html",
            "file:///C:/failed.html",
            "http://tauri.localhost/%66ailed.html",
        ] {
            assert!(
                !allow_top_navigation(&Url::parse(value).unwrap(), None),
                "{value}"
            );
        }
    }
}
