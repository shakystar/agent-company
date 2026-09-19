use crate::policy::{parse_frame, ServerFrame, SessionSecrets, MAX_FRAME_BYTES};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    env,
    io::{self, BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::Duration,
};

pub fn command(node: &Path, entry: &Path, resources: &Path) -> Command {
    let mut command = Command::new(node);
    command.arg(entry).current_dir(resources).env_clear();
    for (key, value) in env::vars_os() {
        if ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"]
            .iter()
            .any(|name| key.to_string_lossy().eq_ignore_ascii_case(name))
        {
            command.env(key, value);
        }
    }
    command
        .env("NODE_ENV", "production")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: only the native WebView window is visible.
    command
}

pub fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    let count = reader
        .take((MAX_FRAME_BYTES + 1) as u64)
        .read_until(b'\n', &mut bytes)?;
    if count == 0 {
        return Ok(None);
    }
    if bytes.len() > MAX_FRAME_BYTES || bytes.last() != Some(&b'\n') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid controller frame",
        ));
    }
    Ok(Some(bytes))
}

pub struct ChildSession {
    child: Child,
    input: Option<ChildStdin>,
    messages: Receiver<Result<ServerFrame, &'static str>>,
    shutdown_sent: bool,
}

impl ChildSession {
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        let mut child = command.spawn()?;
        let input = child.stdin.take();
        let stdout = child.stdout.take().expect("configured private stdout");
        let stderr = child.stderr.take().expect("configured private stderr");
        let (sender, messages) = mpsc::sync_channel(4);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_frame(&mut reader) {
                    Ok(Some(bytes)) => {
                        let parsed = parse_frame(&bytes);
                        let invalid = parsed.is_err();
                        if sender.send(parsed).is_err() {
                            break;
                        }
                        if invalid {
                            let _ = io::copy(&mut reader, &mut io::sink());
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(_) => {
                        let _ = sender.send(Err("제어 서버 응답을 확인하지 못했습니다."));
                        let _ = io::copy(&mut reader, &mut io::sink());
                        break;
                    }
                }
            }
        });
        // Never forward stderr: a dependency might print private start input.
        thread::spawn(move || {
            let _ = io::copy(&mut BufReader::new(stderr), &mut io::sink());
        });
        Ok(Self {
            child,
            input,
            messages,
            shutdown_sent: false,
        })
    }

    pub fn start(&mut self, frame: &[u8]) -> io::Result<()> {
        let input = self.input.as_mut().ok_or_else(|| {
            io::Error::new(io::ErrorKind::BrokenPipe, "Controller input is closed")
        })?;
        input.write_all(frame)?;
        input.flush()
    }

    pub fn shutdown(&mut self, secrets: &SessionSecrets) -> io::Result<()> {
        if self.shutdown_sent {
            return Ok(());
        }
        self.shutdown_sent = true;
        let result = match self.input.as_mut() {
            Some(input) => input
                .write_all(&secrets.shutdown_frame())
                .and_then(|_| input.flush()),
            None => Ok(()),
        };
        // EOF also covers a write failure. No kill, detach, PID adoption or port fallback.
        self.input.take();
        result
    }

    pub fn control(&mut self, frame: &[u8]) -> io::Result<()> {
        if self.shutdown_sent {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "Controller shutdown already requested",
            ));
        }
        self.start(frame)
    }

    pub fn message(
        &self,
        timeout: Duration,
    ) -> Result<Result<ServerFrame, &'static str>, RecvTimeoutError> {
        self.messages.recv_timeout(timeout)
    }

    pub fn try_exit(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_pipe_reader_preserves_framing_and_rejects_truncation() {
        let mut valid = io::Cursor::new(b"one\nsecond\r\n".to_vec());
        assert_eq!(read_frame(&mut valid).unwrap().unwrap(), b"one\n");
        assert_eq!(read_frame(&mut valid).unwrap().unwrap(), b"second\r\n");
        assert!(read_frame(&mut valid).unwrap().is_none());
        assert!(read_frame(&mut io::Cursor::new(vec![b'x'; MAX_FRAME_BYTES + 1])).is_err());
        assert!(read_frame(&mut io::Cursor::new(b"partial")).is_err());
    }
    #[test]
    fn child_uses_exact_bundled_executable_and_no_secret_or_developer_environment() {
        let node = Path::new("C:\\bundle\\binaries\\node.exe");
        let entry = Path::new("C:\\bundle\\resources\\server\\desktop-entry.js");
        let child = command(node, entry, Path::new("C:\\bundle\\resources"));
        assert_eq!(child.get_program(), node.as_os_str());
        assert_eq!(
            child.get_args().collect::<Vec<_>>(),
            vec![entry.as_os_str()]
        );
        assert_eq!(
            child.get_current_dir(),
            Some(Path::new("C:\\bundle\\resources"))
        );
        for (key, value) in child.get_envs() {
            assert!(value.is_some());
            assert!(["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "NODE_ENV"]
                .contains(&key.to_string_lossy().to_uppercase().as_str()));
        }
    }
}
