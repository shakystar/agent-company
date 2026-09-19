#[cfg(windows)]
use std::os::windows::fs::MetadataExt;
use std::{
    fs, io,
    path::{Component, Path, PathBuf},
};

fn regular_metadata(path: &Path, directory: bool) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    let mut redirected = metadata.file_type().is_symlink();
    #[cfg(windows)]
    {
        redirected |= metadata.file_attributes() & 0x400 != 0;
    }
    if redirected || (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Desktop path must not be redirected",
        ));
    }
    Ok(())
}

pub fn secure_directory(path: &Path, create: bool) -> io::Result<()> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Absolute desktop path required",
        ));
    }
    // Reject unsupported Windows namespaces before any network/volume lookup
    // or user-data directory creation. The original path remains the checked path.
    #[cfg(windows)]
    dos_path(path)?;
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        // A verbatim Windows prefix (\\?\C:) already reports has_root(),
        // but it is not a filesystem path until the following RootDir.
        if matches!(component, Component::Prefix(_)) || !current.has_root() {
            continue;
        }
        if create {
            match fs::symlink_metadata(&current) {
                Ok(_) => (),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    fs::create_dir(&current).or_else(|error| {
                        if error.kind() == io::ErrorKind::AlreadyExists {
                            Ok(())
                        } else {
                            Err(error)
                        }
                    })?;
                }
                Err(error) => return Err(error),
            }
        }
        regular_metadata(&current, true)?;
    }
    Ok(())
}

pub struct PayloadPaths {
    pub resources: PathBuf,
    pub entry: PathBuf,
    pub node: PathBuf,
}
impl PayloadPaths {
    pub fn discover(bundle: &Path) -> io::Result<Self> {
        secure_directory(bundle, false)?;
        let resources = bundle.join("resources");
        let entry = resources.join("server").join("desktop-entry.js");
        let node = bundle
            .join("binaries")
            .join("node-x86_64-pc-windows-msvc.exe");
        secure_directory(&resources.join("server"), false)?;
        secure_directory(&bundle.join("binaries"), false)?;
        regular_metadata(&entry, false)?;
        regular_metadata(&node, false)?;
        Ok(Self {
            resources,
            entry,
            node,
        })
    }
}

pub struct UserPaths {
    pub controller: PathBuf,
    pub webview: PathBuf,
}
impl UserPaths {
    pub fn create(app_local_data: &Path) -> io::Result<Self> {
        let base = app_local_data.join("beta");
        let controller = base.join("controller");
        let webview = base.join("webview");
        secure_directory(&controller, true)?;
        secure_directory(&webview, true)?;
        Ok(Self {
            controller,
            webview,
        })
    }
}

#[cfg(windows)]
fn dos_path(path: &Path) -> io::Result<PathBuf> {
    use std::path::Prefix;
    let invalid = || {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Desktop Node paths require a local absolute DOS disk path",
        )
    };
    let mut components = path.components();
    let drive = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
            // UNC, verbatim UNC, device namespaces and other prefixes are not
            // supported installation/data locations for this Windows beta.
            _ => return Err(invalid()),
        },
        _ => return Err(invalid()),
    };
    if components.next() != Some(Component::RootDir) {
        return Err(invalid());
    }
    let mut dos = PathBuf::from(format!("{}:\\", char::from(drive)));
    for component in components {
        match component {
            Component::Normal(name) => {
                let name = name.to_str().ok_or_else(invalid)?;
                // Removing a namespace must not invoke DOS name trimming,
                // device aliases or alternate-stream interpretation.
                let stem = name
                    .split('.')
                    .next()
                    .unwrap_or_default()
                    .to_ascii_uppercase();
                let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                    || stem
                        .strip_prefix("COM")
                        .or_else(|| stem.strip_prefix("LPT"))
                        .is_some_and(|number| {
                            matches!(
                                number,
                                "1" | "2"
                                    | "3"
                                    | "4"
                                    | "5"
                                    | "6"
                                    | "7"
                                    | "8"
                                    | "9"
                                    | "¹"
                                    | "²"
                                    | "³"
                            )
                        });
                if name.ends_with(['.', ' '])
                    || name.chars().any(|character| {
                        character < ' '
                            || matches!(
                                character,
                                ':' | '<' | '>' | '"' | '/' | '\\' | '|' | '?' | '*'
                            )
                    })
                    || device
                {
                    return Err(invalid());
                }
                dos.push(name);
            }
            _ => return Err(invalid()),
        }
    }
    Ok(dos)
}

fn node_path(path: &Path, directory: bool) -> io::Result<PathBuf> {
    #[cfg(windows)]
    let compatible = dos_path(path)?;
    #[cfg(not(windows))]
    let compatible = path.to_path_buf();
    for candidate in [path, compatible.as_path()] {
        if directory {
            secure_directory(candidate, false)?;
        } else {
            let parent = candidate.parent().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "Desktop file parent required")
            })?;
            secure_directory(parent, false)?;
            regular_metadata(candidate, false)?;
        }
    }
    if fs::canonicalize(path)? != fs::canonicalize(&compatible)? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Desktop Node path conversion changed the validated target",
        ));
    }
    Ok(compatible)
}

pub struct NodePaths {
    pub resources: PathBuf,
    pub entry: PathBuf,
    pub node: PathBuf,
    pub controller: PathBuf,
}

impl NodePaths {
    pub fn from_validated(payload: &PayloadPaths, user: &UserPaths) -> io::Result<Self> {
        Ok(Self {
            resources: node_path(&payload.resources, true)?,
            entry: node_path(&payload.entry, false)?,
            node: node_path(&payload.node, false)?,
            controller: node_path(&user.controller, true)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn canonical_windows_payload_and_user_paths_are_validated() {
        let secrets = crate::policy::SessionSecrets::generate().unwrap();
        let root =
            std::env::temp_dir().join(format!("ac-native-canonical-{}", secrets.cookie_name));
        fs::create_dir(&root).unwrap();
        let canonical = fs::canonicalize(&root).unwrap();
        assert!(
            matches!(canonical.components().next(), Some(std::path::Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::VerbatimDisk(_)))
        );
        let result = (|| -> io::Result<()> {
            secure_directory(&canonical, false)?;
            fs::create_dir_all(canonical.join("resources/server"))?;
            fs::create_dir(canonical.join("binaries"))?;
            fs::write(
                canonical.join("resources/server/desktop-entry.js"),
                b"fixture",
            )?;
            fs::write(
                canonical.join("binaries/node-x86_64-pc-windows-msvc.exe"),
                b"fixture",
            )?;
            let payload = PayloadPaths::discover(&canonical)?;
            assert!(payload.entry.starts_with(&canonical));
            let users = UserPaths::create(&canonical.join("user-data"))?;
            assert!(users.controller.is_dir());
            assert!(users.webview.is_dir());
            let node = NodePaths::from_validated(&payload, &users)?;
            for (original, converted) in [
                (&payload.resources, &node.resources),
                (&payload.entry, &node.entry),
                (&payload.node, &node.node),
                (&users.controller, &node.controller),
            ] {
                assert!(
                    matches!(converted.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::Disk(_)))
                );
                assert_eq!(fs::canonicalize(original)?, fs::canonicalize(converted)?);
            }
            let command = crate::child::command(&node.node, &node.entry, &node.resources);
            assert_eq!(command.get_program(), node.node.as_os_str());
            assert_eq!(
                command.get_args().collect::<Vec<_>>(),
                vec![node.entry.as_os_str()]
            );
            assert_eq!(command.get_current_dir(), Some(node.resources.as_path()));
            let frame: serde_json::Value = serde_json::from_slice(
                &secrets
                    .start_frame(&node.resources, &node.controller)
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(frame["resourceRoot"], node.resources.to_str().unwrap());
            assert_eq!(frame["appDataRoot"], node.controller.to_str().unwrap());
            Ok(())
        })();
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(&root).unwrap();
        result.unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn node_dos_path_rejects_unsupported_namespaces_and_semantic_changes() {
        assert_eq!(
            dos_path(Path::new(r"\\?\C:\한글 공백\server\entry.js")).unwrap(),
            PathBuf::from(r"C:\한글 공백\server\entry.js")
        );
        for invalid in [
            r"\\server\share\entry.js",
            r"\\?\UNC\server\share\entry.js",
            r"\\.\C:\entry.js",
            r"\\?\Volume{00000000-0000-0000-0000-000000000000}\entry.js",
            r"C:relative\entry.js",
            r"\rooted\entry.js",
            r"relative\entry.js",
            r"\\?\C:\directory.\entry.js",
            r"\\?\C:\directory \entry.js",
            r"\\?\C:\CON\entry.js",
            r"\\?\C:\COM1.txt",
            r"\\?\C:\LPT².txt",
            r"\\?\C:\file:stream",
            r"\\?\C:\..\entry.js",
        ] {
            assert_eq!(
                dos_path(Path::new(invalid)).unwrap_err().kind(),
                io::ErrorKind::InvalidInput
            );
            assert_eq!(
                secure_directory(Path::new(invalid), false)
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::InvalidInput
            );
        }
    }

    #[test]
    fn paths_are_explicit_and_profile_is_separate_from_controller_data() {
        let secrets = crate::policy::SessionSecrets::generate().unwrap();
        let root = std::env::temp_dir().join(format!("ac-native-paths-{}", secrets.cookie_name));
        let paths = UserPaths::create(&root).unwrap();
        assert_eq!(paths.controller, root.join("beta/controller"));
        assert_eq!(paths.webview, root.join("beta/webview"));
        assert!(PayloadPaths::discover(&root).is_err());
        assert!(secure_directory(Path::new("relative"), true).is_err());
        fs::write(paths.controller.join("blocked"), b"fixture").unwrap();
        assert!(secure_directory(&paths.controller.join("blocked/nested"), true).is_err());
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }
}
