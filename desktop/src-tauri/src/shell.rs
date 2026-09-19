use url::Url;

#[derive(Clone, Copy)]
pub enum ShellState {
    Starting,
    Stopping,
    FailureStopping,
    Stopped,
    Failed,
}

impl ShellState {
    pub fn document(self) -> &'static str {
        match self {
            Self::Starting => "index.html",
            Self::Stopping => "stopping.html",
            Self::FailureStopping => "failure-stopping.html",
            Self::Stopped => "stopped.html",
            Self::Failed => "failed.html",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::Starting => "Agent Company Beta — 시작 중",
            Self::Stopping => "Agent Company Beta — 종료 중",
            Self::FailureStopping => "Agent Company Beta — 연결 실패, 종료 대기 중",
            Self::Stopped => "Agent Company Beta — 종료됨",
            Self::Failed => "Agent Company Beta — 작업실 연결 실패",
        }
    }

    pub fn url(self) -> Url {
        Url::parse(&format!("http://tauri.localhost/{}", self.document()))
            .expect("fixed locked shell document URL")
    }
}

pub fn is_document_path(path: &str) -> bool {
    matches!(
        path,
        "/" | "/index.html"
            | "/stopping.html"
            | "/failure-stopping.html"
            | "/stopped.html"
            | "/failed.html"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_locked_state_has_a_distinct_static_document_with_matching_title() {
        for (state, document, status) in [
            (
                ShellState::Starting,
                include_str!("../shell/index.html"),
                "개인 작업실을 여는 중입니다.",
            ),
            (
                ShellState::Stopping,
                include_str!("../shell/stopping.html"),
                "개인 작업실을 닫는 중입니다.",
            ),
            (
                ShellState::FailureStopping,
                include_str!("../shell/failure-stopping.html"),
                "작업실 연결에 실패했습니다. 종료를 기다리고 있습니다.",
            ),
            (
                ShellState::Stopped,
                include_str!("../shell/stopped.html"),
                "개인 작업실이 종료되었습니다.",
            ),
            (
                ShellState::Failed,
                include_str!("../shell/failed.html"),
                "작업실 연결을 완료하지 못했습니다.",
            ),
        ] {
            assert!(document.contains(&format!("<title>{}</title>", state.title())));
            assert!(document.contains(&format!("<p id=\"status\" role=\"status\">{status}</p>")));
            assert!(!document.contains("<script"));
            assert!(!document.contains("<form"));
            assert!(!document.contains("<button"));
            assert!(!document.contains("http:"));
            assert!(!document.contains("https:"));
            assert!(crate::policy::is_locked_shell(&state.url()));
        }
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config["app"]["security"]["capabilities"],
            serde_json::json!([])
        );
        assert_eq!(config["app"]["withGlobalTauri"], false);
        assert_eq!(config["app"]["security"]["csp"], "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    }
}
