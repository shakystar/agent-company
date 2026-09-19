//! Explicit integration check against emitted production Node modules; no model/Docker calls.
use agent_company_native_checks::{
    child,
    lifecycle::Lifecycle,
    paths::{NodePaths, PayloadPaths, UserPaths},
    policy::{SessionSecrets, UpdateAction, UpdatePhase},
    update,
};
use std::{
    fs,
    io::{Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError},
    thread,
    time::{Duration, Instant},
};
use url::Url;

struct Controller {
    session: child::ChildSession,
    secrets: SessionSecrets,
    lifecycle: Lifecycle,
    client: update::UpdateClient,
    inbox: update::UpdateInbox,
    origin: Url,
    exited: bool,
}

impl Controller {
    fn start(node: &Path, entry: &Path, resources: &Path, data: &Path) -> Self {
        fs::create_dir_all(data).unwrap();
        // Use the product conversion: Rust canonical Windows paths use a verbatim
        // prefix, which Node's ESM entrypoint does not accept unchanged.
        let paths = NodePaths::from_validated(
            &PayloadPaths {
                resources: resources.to_path_buf(),
                entry: entry.to_path_buf(),
                node: node.to_path_buf(),
            },
            &UserPaths {
                controller: data.to_path_buf(),
                webview: data.to_path_buf(),
            },
        )
        .unwrap();
        let secrets = SessionSecrets::generate().unwrap();
        let mut session = child::ChildSession::spawn(&mut child::command(
            &paths.node,
            &paths.entry,
            &paths.resources,
        ))
        .unwrap();
        session
            .start(
                &secrets
                    .start_frame(&paths.resources, &paths.controller)
                    .unwrap(),
            )
            .unwrap();
        let (client, inbox) = update::channel();
        let mut controller = Self {
            session,
            secrets,
            lifecycle: Lifecycle::default(),
            client,
            inbox,
            origin: Url::parse("http://127.0.0.1:1").unwrap(),
            exited: false,
        };
        let deadline = Instant::now() + Duration::from_secs(30);
        while !controller.lifecycle.ready {
            assert!(Instant::now() < deadline, "controller readiness deadline");
            if let Some(origin) = controller.poll() {
                controller.origin = origin;
            }
        }
        assert_ne!(controller.origin.port(), Some(4310));
        controller.inbox.activate().unwrap();
        controller
    }

    fn poll(&mut self) -> Option<Url> {
        if let Some(frame) = self.inbox.next_frame(&self.secrets) {
            self.session.control(&frame).unwrap();
        }
        match self.session.message(Duration::from_millis(20)) {
            Ok(Ok(frame)) => self
                .lifecycle
                .accept_with_updates(frame, &self.secrets, &mut self.inbox)
                .unwrap(),
            Err(RecvTimeoutError::Timeout) => None,
            _ => panic!("controller pipe failed before shutdown"),
        }
    }

    fn receive(&mut self, reply: Receiver<update::UpdateReply>) -> update::UpdateReply {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            match reply.try_recv() {
                Ok(reply) => return reply,
                Err(TryRecvError::Disconnected) => panic!("native reply channel closed"),
                Err(TryRecvError::Empty) => (),
            }
            assert!(Instant::now() < deadline, "native control reply deadline");
            self.poll();
        }
    }

    fn request(&mut self, action: UpdateAction, id: uuid::Uuid) -> update::UpdateReply {
        let reply = self.client.submit(action, id).unwrap();
        self.receive(reply)
    }

    fn http(
        &self,
        method: &str,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> (u16, serde_json::Value) {
        let mut stream = TcpStream::connect(("127.0.0.1", self.origin.port().unwrap())).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let body = body
            .map(|value| serde_json::to_string(&value).unwrap())
            .unwrap_or_default();
        let request = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            self.origin.port().unwrap(), self.secrets.token, body.len());
        stream.write_all(request.as_bytes()).unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).unwrap();
        let boundary = bytes
            .windows(4)
            .position(|value| value == b"\r\n\r\n")
            .unwrap();
        let headers = std::str::from_utf8(&bytes[..boundary]).unwrap();
        let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
        let length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .expect("Fastify JSON content length");
        assert_eq!(bytes.len() - boundary - 4, length);
        (
            status,
            serde_json::from_slice(&bytes[boundary + 4..]).unwrap(),
        )
    }

    fn stop(&mut self) {
        self.client.close_admission();
        self.inbox.begin_close();
        self.lifecycle.shutdown_requested = true;
        self.session.shutdown(&self.secrets).unwrap();
        let mut eof = false;
        let mut exit = None;
        let deadline = Instant::now() + Duration::from_secs(30);
        while !eof || exit.is_none() {
            assert!(
                Instant::now() < deadline,
                "real child exit and pipe EOF deadline"
            );
            if !eof {
                match self.session.message(Duration::from_millis(20)) {
                    Ok(Ok(frame)) => {
                        self.lifecycle
                            .accept_with_updates(frame, &self.secrets, &mut self.inbox)
                            .unwrap();
                    }
                    Err(RecvTimeoutError::Disconnected) => eof = true,
                    Err(RecvTimeoutError::Timeout) => (),
                    Ok(Err(_)) => panic!("invalid shutdown frame"),
                }
            }
            if exit.is_none() {
                exit = self.session.try_exit().unwrap();
            }
            if eof && exit.is_none() {
                thread::sleep(Duration::from_millis(20));
            }
        }
        self.exited = true;
        assert!(self.lifecycle.confirm_exit(exit.unwrap().success()));
    }
}

impl Drop for Controller {
    fn drop(&mut self) {
        if !self.exited {
            // Panic cleanup still uses owned stdin EOF and the actual process handle.
            self.inbox.begin_close();
            let _ = self.session.shutdown(&self.secrets);
            while !matches!(self.session.try_exit(), Ok(Some(_))) {
                let _ = self.session.message(Duration::from_millis(20));
                thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let temporary = fs::canonicalize(std::env::temp_dir()).unwrap();
        let target = fs::canonicalize(&self.0).unwrap();
        assert_eq!(target.parent(), Some(temporary.as_path()));
        assert!(target
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("ac-native-update-"));
        fs::remove_dir_all(target).unwrap();
    }
}

#[test]
#[ignore = "Requires AC_NATIVE_TEST_NODE and AC_NATIVE_TEST_ENTRY pointing to Node and emitted desktop-entry.js"]
fn rust_parent_controls_real_node_and_preserves_hold_and_data_across_restart() {
    let node = fs::canonicalize(
        std::env::var_os("AC_NATIVE_TEST_NODE").expect("explicit test Node input"),
    )
    .unwrap();
    let entry = fs::canonicalize(
        std::env::var_os("AC_NATIVE_TEST_ENTRY").expect("explicit emitted entry input"),
    )
    .unwrap();
    assert!(node.is_file() && entry.is_file());
    let root = std::env::temp_dir().join(format!(
        "ac-native-update-{}",
        update::attempt_id().unwrap()
    ));
    fs::create_dir(&root).unwrap();
    let fixture = Fixture(root);
    let resources = fixture.0.join("설치 자원");
    let data = fixture.0.join("사용자 데이터");
    fs::create_dir_all(resources.join("dist")).unwrap();
    fs::write(
        resources.join("dist/index.html"),
        "<!doctype html><title>Native protocol fixture</title>",
    )
    .unwrap();
    let mut first = Controller::start(&node, &entry, &resources, &data);
    let (status, agent) = first.http("POST", "/api/agents", Some(serde_json::json!({
        "name": "Native preservation fixture", "persona": "Protocol and data check", "model": "gpt-6-astra"
    })));
    assert_eq!(status, 201);
    let first_id = update::attempt_id().unwrap();
    let pending = first
        .client
        .submit(UpdateAction::Prepare, first_id)
        .unwrap();
    assert!(matches!(
        first.client.submit(UpdateAction::Status, first_id),
        Err(update::UpdateError::Busy)
    ));
    assert!(matches!(
        first.receive(pending).unwrap().phase,
        UpdatePhase::Draining | UpdatePhase::Ready
    ));
    assert_eq!(
        first
            .http(
                "POST",
                "/api/deployment/resume",
                Some(serde_json::json!({}))
            )
            .0,
        409
    );
    assert_eq!(
        first.request(UpdateAction::Cancel, update::attempt_id().unwrap()),
        Err(update::UpdateError::PreparationFailed)
    );
    assert_eq!(
        first.request(UpdateAction::Cancel, first_id).unwrap().phase,
        UpdatePhase::Running
    );
    assert_eq!(
        first.request(UpdateAction::Prepare, first_id),
        Err(update::UpdateError::PreparationFailed)
    );
    let installed_id = update::attempt_id().unwrap();
    first.request(UpdateAction::Prepare, installed_id).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if first
            .request(UpdateAction::Status, installed_id)
            .unwrap()
            .phase
            == UpdatePhase::Ready
        {
            break;
        }
        assert!(Instant::now() < deadline, "update drain deadline");
    }
    // Shutdown may overtake a pending reply; accepting its buffered counterpart must remain safe.
    let closing = first
        .client
        .submit(UpdateAction::Status, installed_id)
        .unwrap();
    let frame = first.inbox.next_frame(&first.secrets).unwrap();
    first.session.control(&frame).unwrap();
    first.stop();
    assert!(first.session.control(&frame).is_err());
    assert_eq!(closing.recv().unwrap(), Err(update::UpdateError::Closing));
    let mut restarted = Controller::start(&node, &entry, &resources, &data);
    let (status, workspace) = restarted.http("GET", "/api/workspace", None);
    assert_eq!(status, 200);
    assert_eq!(workspace["agents"][0]["id"], agent["id"]);
    assert_ne!(workspace["deployment"]["phase"], "running");
    assert_eq!(workspace["runtime"]["available"], false);
    assert_eq!(workspace["runs"].as_array().unwrap().len(), 0);
    assert_eq!(
        restarted
            .http(
                "POST",
                "/api/deployment/resume",
                Some(serde_json::json!({}))
            )
            .0,
        200
    );
    restarted.stop();
    assert!(!data.join("desktop.lock").exists());
    assert!(!data.join("workspace/controller.lock").exists());
}
