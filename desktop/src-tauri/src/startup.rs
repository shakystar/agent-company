use std::{error::Error, io};

pub struct SetupFailure {
    stage: &'static str,
    kind: &'static str,
    os_code: Option<i32>,
}

impl SetupFailure {
    pub fn diagnostic(&self) -> serde_json::Value {
        serde_json::json!({
            "phase": "setup-failed",
            "stage": self.stage,
            "kind": self.kind,
            "osCode": self.os_code,
        })
    }
}

pub fn step<T, E: Error + 'static>(
    stage: &'static str,
    operation: impl FnOnce() -> Result<T, E>,
) -> Result<T, SetupFailure> {
    crate::trace(stage, None);
    operation().map_err(|error| {
        let error: &dyn Error = &error;
        let io_error = error.downcast_ref::<io::Error>().or_else(|| {
            match error.downcast_ref::<tauri::Error>() {
                Some(tauri::Error::Io(error)) => Some(error),
                _ => None,
            }
        });
        SetupFailure {
            stage,
            kind: match io_error.map(io::Error::kind) {
                Some(io::ErrorKind::NotFound) => "not-found",
                Some(io::ErrorKind::PermissionDenied) => "permission-denied",
                Some(io::ErrorKind::InvalidInput) => "invalid-input",
                Some(io::ErrorKind::AlreadyExists) => "already-exists",
                Some(_) => "io-other",
                None => "tauri",
            },
            os_code: io_error.and_then(io::Error::raw_os_error),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_diagnostics_discard_error_text_and_keep_fixed_stage_and_code() {
        let failure = step::<(), _>("validate-payload", || {
            Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "private-token-and-local-path-must-not-appear",
            ))
        })
        .err()
        .unwrap();
        assert_eq!(
            failure.diagnostic(),
            serde_json::json!({
                "phase": "setup-failed", "stage": "validate-payload",
                "kind": "invalid-input", "osCode": null
            })
        );
        let failure = step::<(), _>("create-user-dir", || {
            Err(tauri::Error::Io(io::Error::from_raw_os_error(1)))
        })
        .err()
        .unwrap();
        assert_eq!(failure.diagnostic()["osCode"], 1);
        assert_eq!(failure.diagnostic()["stage"], "create-user-dir");
    }
}
