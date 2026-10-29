use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    node: PathBuf,
    bundled: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temporary = std::env::temp_dir();
        #[cfg(unix)]
        let temporary = fs::canonicalize(temporary).unwrap();
        let root = temporary.join(format!(
            "hpm-node-runtime-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("runtime/node")).unwrap();
        fs::create_dir(root.join("兼容环境")).unwrap();
        let node = root.join("兼容环境/node.exe");
        let bundled = root.join("runtime/node/node.exe");
        fs::write(&node, b"fixed synthetic executable").unwrap();
        fs::write(&bundled, b"fixed synthetic executable").unwrap();
        Self {
            root,
            node,
            bundled,
        }
    }
    fn select(&self) -> Result<NodeRuntime, &'static str> {
        NodeRuntime::select_value(&self.root, Some(self.node.clone().into_os_string()))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn defaults_keep_bundled_priority_and_path_fallback() {
    let f = Fixture::new();
    assert_eq!(
        NodeRuntime::select_value(&f.root, None)
            .unwrap()
            .command()
            .get_program(),
        f.bundled
    );
    fs::remove_file(&f.bundled).unwrap();
    assert_eq!(
        NodeRuntime::select_value(&f.root, None)
            .unwrap()
            .command()
            .get_program(),
        "node"
    );
}

#[test]
fn equal_regular_unicode_override_is_selected_and_pinned() {
    let f = Fixture::new();
    let selected = f.select().unwrap();
    assert_eq!(selected.command().get_program(), f.node);
    assert!(!selected.pins.is_empty());
    assert!(selected.verify().is_ok());
}

#[test]
fn explicit_invalid_empty_relative_extreme_or_device_never_falls_back() {
    let f = Fixture::new();
    for text in [
        "".into(),
        "node.exe".into(),
        "missing.exe".into(),
        "\\\\server\\share\\node.exe".into(),
        "\\\\?\\C:\\node.exe".into(),
        "\\\\.\\node.exe".into(),
        "x".repeat(4097),
        f.node.to_string_lossy().to_string() + "\n",
        f.root.join("missing.exe").to_string_lossy().into_owned(),
        f.root.join("../node.exe").to_string_lossy().into_owned(),
    ] {
        assert!(matches!(
            NodeRuntime::select_value(&f.root, Some(text.into())),
            Err(FAILURE)
        ));
    }
    for name in [
        "NUL.exe",
        "con.exe",
        "AUX.exe",
        "COM1.exe",
        "LPT9.exe",
        "COM¹.exe",
        "node.exe ",
        "node.exe.",
        "node?.exe",
    ] {
        assert!(explicit_path(f.root.join(name).as_os_str()).is_err());
    }
}

#[test]
fn missing_bundled_different_size_or_same_size_different_content_rejects() {
    for data in [
        b"different".as_slice(),
        b"fixed synthetic executablE".as_slice(),
        b"".as_slice(),
    ] {
        let f = Fixture::new();
        fs::write(&f.node, data).unwrap();
        assert!(matches!(f.select(), Err(FAILURE)));
    }
    let f = Fixture::new();
    fs::remove_file(&f.bundled).unwrap();
    assert!(matches!(f.select(), Err(FAILURE)));
}

#[test]
fn directory_hardlink_and_oversize_executable_reject() {
    let f = Fixture::new();
    fs::remove_file(&f.node).unwrap();
    fs::create_dir(&f.node).unwrap();
    assert!(matches!(f.select(), Err(FAILURE)));
    fs::remove_dir(&f.node).unwrap();
    fs::hard_link(&f.bundled, &f.node).unwrap();
    assert!(matches!(f.select(), Err(FAILURE)));
    fs::remove_file(&f.node).unwrap();
    let file = File::create(&f.node).unwrap();
    file.set_len(MAX_BYTES + 1).unwrap();
    assert!(matches!(f.select(), Err(FAILURE)));
}

#[cfg(unix)]
#[test]
fn symlink_file_and_ancestor_are_rejected() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    fs::remove_file(&f.node).unwrap();
    symlink(&f.bundled, &f.node).unwrap();
    assert!(matches!(f.select(), Err(FAILURE)));
    fs::remove_file(&f.node).unwrap();
    fs::remove_dir(f.node.parent().unwrap()).unwrap();
    symlink(f.bundled.parent().unwrap(), f.node.parent().unwrap()).unwrap();
    assert!(matches!(f.select(), Err(FAILURE)));
}

#[cfg(unix)]
#[test]
fn same_inode_same_size_rewrite_cannot_hide_by_restoring_mtime() {
    use std::fs::FileTimes;
    let f = Fixture::new();
    let selected = f.select().unwrap();
    let modified = fs::metadata(&f.node).unwrap().modified().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2));
    fs::write(&f.node, b"fixed synthetic executablE").unwrap();
    File::options()
        .write(true)
        .open(&f.node)
        .unwrap()
        .set_times(FileTimes::new().set_modified(modified))
        .unwrap();
    assert_eq!(fs::metadata(&f.node).unwrap().modified().unwrap(), modified);
    assert!(matches!(selected.verify(), Err(FAILURE)));
}

#[cfg(unix)]
#[test]
fn replacement_or_content_change_before_spawn_fails_without_launch() {
    for replace in [true, false] {
        let f = Fixture::new();
        let selected = f.select().unwrap();
        if replace {
            fs::rename(&f.node, f.root.join("old.exe")).unwrap();
        }
        fs::write(&f.node, b"fixed synthetic executablE").unwrap();
        assert!(matches!(
            selected.spawn(&mut selected.command()),
            Err(FAILURE)
        ));
    }
}

#[cfg(windows)]
#[test]
fn windows_file_and_directory_reparse_are_rejected() {
    use std::os::windows::fs::{symlink_dir, symlink_file};
    let f = Fixture::new();
    fs::remove_file(&f.node).unwrap();
    symlink_file(&f.bundled, &f.node).unwrap();
    assert!(matches!(f.select(), Err(FAILURE)));
    fs::remove_file(&f.node).unwrap();
    fs::remove_dir(f.node.parent().unwrap()).unwrap();
    symlink_dir(f.bundled.parent().unwrap(), f.node.parent().unwrap()).unwrap();
    assert!(matches!(f.select(), Err(FAILURE)));
    fs::remove_dir(f.node.parent().unwrap()).unwrap();
}

#[cfg(windows)]
#[test]
fn windows_real_spawn_succeeds_while_executable_and_ancestor_pins_are_held() {
    use std::process::Stdio;
    let f = Fixture::new();
    let executable = std::env::current_exe().unwrap();
    fs::copy(&executable, &f.node).unwrap();
    fs::copy(&executable, &f.bundled).unwrap();
    let selected = f.select().unwrap();
    let mut command = selected.command();
    command
        .arg("--list")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = selected.spawn(&mut command).unwrap();
    assert!(selected.verify().is_ok());
    drop(selected);
    assert!(child.wait().unwrap().success());
}

#[cfg(windows)]
#[test]
fn windows_pins_reject_write_delete_and_ancestor_rename_then_release() {
    let f = Fixture::new();
    let selected = f.select().unwrap();
    assert!(OpenOptions::new().write(true).open(&f.node).is_err());
    assert!(fs::rename(&f.node, f.root.join("renamed.exe")).is_err());
    assert!(fs::rename(f.node.parent().unwrap(), f.root.join("renamed")).is_err());
    assert!(OpenOptions::new().write(true).open(&f.bundled).is_err());
    assert!(selected.verify().is_ok());
    drop(selected);
    assert!(OpenOptions::new().write(true).open(&f.node).is_ok());
}

#[test]
fn altered_command_program_is_not_spawned_and_errors_are_fixed() {
    let f = Fixture::new();
    let selected = f.select().unwrap();
    assert!(matches!(
        selected.spawn(&mut Command::new("untrusted-program")),
        Err(FAILURE)
    ));
    // Synthetic bytes are deliberately not executable. Never echo OS errors.
    assert!(matches!(
        selected.spawn(&mut selected.command()),
        Err(FAILURE)
    ));
}

#[test]
fn stream_comparison_covers_multiple_chunks_and_last_byte() {
    let f = Fixture::new();
    let mut bytes = vec![7u8; 65537];
    fs::write(&f.node, &bytes).unwrap();
    fs::write(&f.bundled, &bytes).unwrap();
    assert!(f.select().is_ok());
    bytes[65536] = 8;
    fs::write(&f.node, bytes).unwrap();
    assert!(matches!(f.select(), Err(FAILURE)));
}
