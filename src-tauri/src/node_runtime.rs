use std::ffi::{OsStr, OsString};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command};

const MAX_BYTES: u64 = 256 * 1024 * 1024;
pub(crate) const FAILURE: &str = "failed to start node proxy directly: node_runtime_unavailable";

#[derive(PartialEq, Eq)]
struct Identity(Vec<u64>);

#[cfg(windows)]
fn identity(file: &File) -> Result<Identity, &'static str> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct Info {
        attributes: u32,
        creation: [u32; 2],
        access: [u32; 2],
        write: [u32; 2],
        volume: u32,
        size: [u32; 2],
        links: u32,
        index: [u32; 2],
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut Info) -> i32;
    }
    let mut info: Info = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(FAILURE);
    }
    Ok(Identity(vec![
        info.volume as u64,
        ((info.index[0] as u64) << 32) | info.index[1] as u64,
        ((info.creation[1] as u64) << 32) | info.creation[0] as u64,
        info.links as u64,
    ]))
}

#[cfg(unix)]
fn identity(file: &File) -> Result<Identity, &'static str> {
    use std::os::unix::fs::MetadataExt;
    let m = file.metadata().map_err(|_| FAILURE)?;
    let birth = m.created().map_err(|_| FAILURE)?;
    let (sign, duration) = match birth.duration_since(std::time::UNIX_EPOCH) {
        Ok(value) => (0, value),
        Err(value) => (1, value.duration()),
    };
    let mut parts = vec![
        m.dev(),
        m.ino(),
        sign,
        duration.as_secs(),
        duration.subsec_nanos() as u64,
    ];
    // Unix lacks Windows share-deny pins. Regular-file ctime must also detect
    // same-inode writes whose size and mtime have subsequently been restored.
    // Directory ctime changes when unrelated children are created; omit it.
    if m.is_file() {
        parts.extend([m.ctime() as u64, m.ctime_nsec() as u64]);
    }
    Ok(Identity(parts))
}

fn safe_metadata(path: &Path, directory: bool) -> Result<Metadata, &'static str> {
    let m = fs::symlink_metadata(path).map_err(|_| FAILURE)?;
    if m.file_type().is_symlink() || if directory { !m.is_dir() } else { !m.is_file() } {
        return Err(FAILURE);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 {
            return Err(FAILURE);
        }
    }
    Ok(m)
}

fn open_pin(path: &Path, directory: bool) -> Result<File, &'static str> {
    safe_metadata(path, directory)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Actual read access participates in sharing checks. No WRITE or DELETE
        // sharing: neither the executable nor an ancestor can be replaced.
        options
            .access_mode(0x81)
            .share_mode(1)
            .custom_flags(0x0220_0000);
    }
    let file = options.open(path).map_err(|_| FAILURE)?;
    let m = file.metadata().map_err(|_| FAILURE)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 {
            return Err(FAILURE);
        }
    }
    if if directory { !m.is_dir() } else { !m.is_file() } {
        return Err(FAILURE);
    }
    if !directory {
        #[cfg(unix)]
        let links = {
            use std::os::unix::fs::MetadataExt;
            m.nlink()
        };
        #[cfg(windows)]
        let links = *identity(&file)?.0.last().ok_or(FAILURE)?;
        if links != 1 || m.len() == 0 || m.len() > MAX_BYTES {
            return Err(FAILURE);
        }
    }
    Ok(file)
}

struct Pin {
    path: PathBuf,
    file: File,
    directory: bool,
    identity: Identity,
    stamp: Option<(u64, std::time::SystemTime)>,
}
impl Pin {
    fn new(path: &Path, directory: bool) -> Result<Self, &'static str> {
        let file = open_pin(path, directory)?;
        let identity = identity(&file)?;
        let m = file.metadata().map_err(|_| FAILURE)?;
        let stamp = if directory {
            None
        } else {
            Some((m.len(), m.modified().map_err(|_| FAILURE)?))
        };
        Ok(Self {
            path: path.into(),
            file,
            directory,
            identity,
            stamp,
        })
    }
    fn verify(&self) -> Result<(), &'static str> {
        let observed = open_pin(&self.path, self.directory)?;
        if identity(&observed)? != self.identity || identity(&self.file)? != self.identity {
            return Err(FAILURE);
        }
        if let Some(stamp) = self.stamp {
            for file in [&observed, &self.file] {
                let m = file.metadata().map_err(|_| FAILURE)?;
                if (m.len(), m.modified().map_err(|_| FAILURE)?) != stamp {
                    return Err(FAILURE);
                }
            }
        }
        Ok(())
    }
}

fn explicit_path(value: &OsStr) -> Result<PathBuf, &'static str> {
    let text = value.to_str().ok_or(FAILURE)?;
    let path = PathBuf::from(text);
    if text.is_empty()
        || text.encode_utf16().count() > 4096
        || text.chars().any(|c| c < ' ')
        || text.starts_with(['\\', '/']) && cfg!(windows)
        || !path.is_absolute()
        || !path
            .extension()
            .is_some_and(|s| s.eq_ignore_ascii_case("exe"))
        || text.split(['/', '\\']).any(|s| matches!(s, "." | ".."))
    {
        return Err(FAILURE);
    }
    for part in path.components() {
        match part {
            Component::Normal(name) => {
                let name = name.to_str().ok_or(FAILURE)?;
                let stem = name
                    .split('.')
                    .next()
                    .unwrap_or("")
                    .trim_end_matches(' ')
                    .to_ascii_uppercase();
                let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                    || ["COM", "LPT"].iter().any(|prefix| {
                        stem.strip_prefix(prefix).is_some_and(|suffix| {
                            matches!(
                                suffix,
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
                        })
                    });
                if name.ends_with(['.', ' '])
                    || name.contains(['"', '<', '>', '|', '?', '*', ':'])
                    || reserved
                {
                    return Err(FAILURE);
                }
            }
            Component::RootDir => {}
            #[cfg(windows)]
            Component::Prefix(prefix) if matches!(prefix.kind(), std::path::Prefix::Disk(_)) => {}
            _ => return Err(FAILURE),
        }
    }
    Ok(path)
}

pub(crate) struct NodeRuntime {
    executable: OsString,
    pins: Vec<Pin>,
}
impl NodeRuntime {
    pub(crate) fn select(root: &Path) -> Result<Self, &'static str> {
        Self::select_value(root, std::env::var_os("HPM_NODE_EXECUTABLE"))
    }
    fn select_value(root: &Path, value: Option<OsString>) -> Result<Self, &'static str> {
        let bundled = root.join("runtime/node/node.exe");
        let Some(value) = value else {
            return Ok(Self {
                executable: if bundled.exists() {
                    bundled.into_os_string()
                } else {
                    "node".into()
                },
                pins: vec![],
            });
        };
        let executable = explicit_path(&value)?;
        explicit_path(bundled.as_os_str())?;
        let mut pins = Vec::new();
        for path in [&executable, &bundled] {
            for ancestor in path.ancestors().skip(1) {
                if pins.len() >= 256 {
                    return Err(FAILURE);
                }
                pins.push(Pin::new(ancestor, true)?);
            }
            pins.push(Pin::new(path, false)?);
        }
        let mut left = open_pin(&executable, false)?;
        let mut right = open_pin(&bundled, false)?;
        if left.metadata().map_err(|_| FAILURE)?.len()
            != right.metadata().map_err(|_| FAILURE)?.len()
        {
            return Err(FAILURE);
        }
        let mut a = [0u8; 16384];
        let mut b = [0u8; 16384];
        let mut compared = 0u64;
        loop {
            let n = left.read(&mut a).map_err(|_| FAILURE)?;
            if n == 0 {
                break;
            }
            compared += n as u64;
            if compared > MAX_BYTES {
                return Err(FAILURE);
            }
            right.read_exact(&mut b[..n]).map_err(|_| FAILURE)?;
            if a[..n] != b[..n] {
                return Err(FAILURE);
            }
        }
        if right.read(&mut b[..1]).map_err(|_| FAILURE)? != 0 {
            return Err(FAILURE);
        }
        let result = Self {
            executable: executable.into_os_string(),
            pins,
        };
        result.verify()?;
        Ok(result)
    }
    fn verify(&self) -> Result<(), &'static str> {
        for pin in &self.pins {
            pin.verify()?;
        }
        Ok(())
    }
    pub(crate) fn command(&self) -> Command {
        Command::new(&self.executable)
    }
    pub(crate) fn spawn(&self, command: &mut Command) -> Result<Child, &'static str> {
        if command.get_program() != self.executable {
            return Err(FAILURE);
        }
        self.verify()?;
        command.spawn().map_err(|_| FAILURE)
    }
}

#[cfg(test)]
#[path = "node_runtime_tests.rs"]
mod tests;
