//! The installer owns an exclusive byte-range lock; every running native shell
//! owns a shared lock on the same persistent file, outside removable app data.
use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io,
    path::{Component, Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

pub const LOCK_NAME: &str = "com.agentcompany.desktop.beta.install.lock";
const START_WAIT: Duration = Duration::from_secs(10);

#[derive(Debug)]
pub struct InstallLease {
    // Never unlink the file or unlock early. The native process retains this
    // handle while its controller drains, including unsuccessful shutdowns.
    _file: File,
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "Invalid desktop installation lease",
    )
}

fn validate_parent(root: &Path) -> io::Result<()> {
    if !root.is_absolute() {
        return Err(invalid());
    }
    #[cfg(windows)]
    {
        use std::path::Prefix;
        if !matches!(root.components().next(), Some(Component::Prefix(p))
            if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        {
            return Err(invalid());
        }
    }
    let mut current = PathBuf::new();
    for component in root.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err(invalid());
        }
        current.push(component);
        if matches!(component, Component::Prefix(_)) || !current.has_root() {
            continue;
        }
        let metadata = fs::symlink_metadata(&current)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(invalid());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn identity(file: &File) -> io::Result<(u32, u32, u32)> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};
    // BY_HANDLE_FILE_INFORMATION is thirteen consecutive DWORDs on both x86
    // and x64. Use the public Win32 API instead of unstable MetadataExt fields.
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(handle: *mut c_void, information: *mut u32) -> i32;
    }
    let mut information = [0u32; 13];
    // SAFETY: the handle remains owned by file and the output buffer has the
    // exact size/alignment of BY_HANDLE_FILE_INFORMATION.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if information[0] & (0x400 | 0x10) != 0 || information[10] != 1 {
        return Err(invalid());
    }
    Ok((information[7], information[11], information[12]))
}

#[cfg(unix)]
fn identity(file: &File) -> io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(invalid());
    }
    Ok((metadata.dev(), metadata.ino()))
}

fn open(root: &Path, create: bool) -> io::Result<File> {
    validate_parent(root)?;
    let path = root.join(LOCK_NAME);
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(invalid());
        }
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(create);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // OPEN_REPARSE_POINT checks the file itself; no SHARE_DELETE prevents
        // replacing/unlinking it while either process still owns its handle.
        options.share_mode(0x1 | 0x2).custom_flags(0x0020_0000);
    }
    let file = options.open(path)?;
    identity(&file)?;
    validate_parent(root)?;
    Ok(file)
}

impl InstallLease {
    pub fn acquire(local_data_root: &Path) -> io::Result<Self> {
        Self::acquire_for(local_data_root, START_WAIT)
    }

    fn acquire_for(root: &Path, wait: Duration) -> io::Result<Self> {
        let file = open(root, true)?;
        let expected = identity(&file)?;
        let started = Instant::now();
        loop {
            match file.try_lock_shared() {
                Ok(()) => break,
                Err(TryLockError::WouldBlock) if started.elapsed() < wait => {
                    // Stock NSIS starts the app just before exiting. Wait only
                    // for its lease, before reading payload or opening WebView.
                    thread::sleep(Duration::from_millis(50));
                }
                Err(TryLockError::WouldBlock) => {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        "Desktop installation is still active",
                    ));
                }
                Err(TryLockError::Error(error)) => return Err(error),
            }
        }
        let current = open(root, false)?;
        if identity(&current)? != expected {
            return Err(invalid());
        }
        Ok(Self { _file: file })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "ac-install-lease-{}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let root = fs::canonicalize(&self.0).unwrap();
            let temporary = fs::canonicalize(std::env::temp_dir()).unwrap();
            assert!(root.starts_with(&temporary) && root != temporary);
            fs::remove_dir_all(&root).unwrap();
        }
    }

    #[test]
    fn shared_shells_block_exclusive_until_every_owner_exits() {
        let fixture = Fixture::new();
        let first = InstallLease::acquire_for(&fixture.0, Duration::ZERO).unwrap();
        let second = InstallLease::acquire_for(&fixture.0, Duration::ZERO).unwrap();
        let installer = open(&fixture.0, false).unwrap();
        assert!(matches!(
            installer.try_lock(),
            Err(TryLockError::WouldBlock)
        ));
        drop(first);
        assert!(matches!(
            installer.try_lock(),
            Err(TryLockError::WouldBlock)
        ));
        drop(second);
        installer.try_lock().unwrap();
    }

    #[test]
    fn installer_blocks_new_shell_and_releases_without_replacing_lock_file() {
        let fixture = Fixture::new();
        let installer = open(&fixture.0, true).unwrap();
        let before = identity(&installer).unwrap();
        installer.try_lock().unwrap();
        assert_eq!(
            InstallLease::acquire_for(&fixture.0, Duration::ZERO)
                .unwrap_err()
                .kind(),
            io::ErrorKind::WouldBlock
        );
        drop(installer);
        let shell = InstallLease::acquire(&fixture.0).unwrap();
        assert_eq!(identity(&shell._file).unwrap(), before);
        assert!(fixture.0.join(LOCK_NAME).is_file());
    }

    #[test]
    fn shell_waits_for_finishing_installer_before_admission() {
        let fixture = Fixture::new();
        let installer = open(&fixture.0, true).unwrap();
        installer.try_lock().unwrap();
        let release = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            drop(installer);
        });
        let shell = InstallLease::acquire_for(&fixture.0, Duration::from_secs(2)).unwrap();
        release.join().unwrap();
        drop(shell);
    }

    #[test]
    fn rejects_nonordinary_file_and_hardlink_without_deleting_them() {
        let fixture = Fixture::new();
        let path = fixture.0.join(LOCK_NAME);
        fs::create_dir(&path).unwrap();
        assert!(InstallLease::acquire(&fixture.0).is_err());
        fs::remove_dir(&path).unwrap();
        let source = fixture.0.join("original");
        fs::write(&source, b"preserved").unwrap();
        fs::hard_link(&source, &path).unwrap();
        assert!(InstallLease::acquire(&fixture.0).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"preserved");
        assert!(path.exists());
        assert!(InstallLease::acquire(Path::new("relative")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn lease_prevents_rename_and_delete_while_owned() {
        let fixture = Fixture::new();
        let lease = InstallLease::acquire(&fixture.0).unwrap();
        let path = fixture.0.join(LOCK_NAME);
        assert!(fs::remove_file(&path).is_err());
        assert!(fs::rename(&path, fixture.0.join("moved")).is_err());
        drop(lease);
        fs::remove_file(path).unwrap();
    }
}
