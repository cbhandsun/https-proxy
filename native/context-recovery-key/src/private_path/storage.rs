use super::{parse, Kind, PathIdentity, Request, MAX_INPUT};
use serde::Serialize;
use std::io::{Read, Write};

#[derive(Serialize)]
struct Receipt {
    ok: bool,
    directory: PathIdentity,
    writer: PathIdentity,
}

fn directory_request(input: &[u8]) -> Result<Request, ()> {
    let request = parse(input)?;
    if !matches!(request.kind, Kind::Directory) {
        return Err(());
    }
    Ok(request)
}

#[cfg(windows)]
fn prepare(request: Request) -> Result<Receipt, ()> {
    prepare_with(request, super::secure)
}

#[cfg(windows)]
fn prepare_with(
    request: Request,
    mut secure: impl FnMut(Request) -> Result<(), ()>,
) -> Result<Receipt, ()> {
    use super::windows::{identity, open};
    use std::fs::{File, OpenOptions};
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::path::Path;

    fn check_writer(file: &File) -> Result<(), ()> {
        let metadata = file.metadata().map_err(|_| ())?;
        if !metadata.is_file()
            || metadata.file_attributes() & 0x400 != 0
            || metadata.len() > 1_048_576
        {
            return Err(());
        }
        identity(file, true)?;
        Ok(())
    }

    if !matches!(request.kind, Kind::Directory) {
        return Err(());
    }
    let path = Path::new(&request.path);
    // Keep every ancestor and the actual root open without DELETE sharing
    // across both existing ACL operations and the fixed child creation.
    let mut ancestors = Vec::new();
    for parent in path.ancestors().skip(1) {
        if ancestors.len() >= 128 {
            return Err(());
        }
        let pinned = open(parent, false)?;
        if !pinned.metadata().map_err(|_| ())?.is_dir() {
            return Err(());
        }
        ancestors.push(pinned);
    }
    let directory = open(path, false)?;
    if !directory.metadata().map_err(|_| ())?.is_dir() {
        return Err(());
    }
    let directory_identity = identity(&directory, false)?;
    secure(Request {
        path: request.path.clone(),
        kind: Kind::Directory,
    })?;
    let writer_path = path.join(".writer.sqlite");
    let writer_input = serde_json::to_vec(&serde_json::json!({
        "path": writer_path.to_str().ok_or(())?, "kind": "file"
    }))
    .map_err(|_| ())?;
    let writer_request = parse(&writer_input)?;
    let writer = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .access_mode(0x4006_0080)
        .share_mode(3)
        .custom_flags(0x0220_0000)
        .open(&writer_path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            open(&writer_path, false)?
        }
        Err(_) => return Err(()),
    };
    check_writer(&writer)?;
    let writer_identity = identity(&writer, true)?;
    secure(writer_request)?;
    check_writer(&writer)?;
    // Readback uses a fresh pathname handle while the authenticated object and
    // its ancestors remain pinned. A later JS stat must match these identities.
    let observed_directory = open(path, false)?;
    let observed_writer = open(&writer_path, false)?;
    check_writer(&observed_writer)?;
    if identity(&directory, false)? != directory_identity
        || identity(&observed_directory, false)? != directory_identity
        || identity(&writer, true)? != writer_identity
        || identity(&observed_writer, true)? != writer_identity
    {
        return Err(());
    }
    Ok(Receipt {
        ok: true,
        directory: directory_identity,
        writer: writer_identity,
    })
}

#[cfg(not(windows))]
fn prepare(_: Request) -> Result<Receipt, ()> {
    Err(())
}

pub fn run<R: Read, W: Write>(reader: R, mut writer: W) -> bool {
    let mut input = Vec::new();
    let result = reader
        .take(MAX_INPUT + 1)
        .read_to_end(&mut input)
        .map_err(|_| ())
        .and_then(|_| directory_request(&input))
        .and_then(prepare)
        .and_then(|receipt| serde_json::to_vec(&receipt).map_err(|_| ()));
    let success = result.is_ok();
    let output = result.unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
    writer.write_all(&output).is_ok() && success
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_only_strict_input_and_fixed_failure_output() {
        for input in [
            b"".as_slice(),
            b"null",
            b"{}",
            b"[]",
            br#"{"path":"C:/x","kind":"file"}"#,
            br#"{"path":"C:/x","kind":"directory","extra":1}"#,
            br#"{"path":"C:/x","path":"C:/y","kind":"directory"}"#,
            br#"{"path":"C:/../x","kind":"directory"}"#,
        ] {
            assert!(directory_request(input).is_err());
            let mut output = Vec::new();
            assert!(!run(input, &mut output));
            assert_eq!(output, b"{\"ok\":false}");
        }
        assert!(directory_request(&vec![b' '; MAX_INPUT as usize + 1]).is_err());
    }

    #[test]
    fn identity_serialization_is_exact_decimal_string_wire() {
        let receipt = Receipt {
            ok: true,
            directory: PathIdentity {
                dev: "4294967295".into(),
                ino: "18446744073709551615".into(),
                birthtime_ns: "-100".into(),
            },
            writer: PathIdentity {
                dev: "1".into(),
                ino: "2".into(),
                birthtime_ns: "0".into(),
            },
        };
        assert_eq!(serde_json::to_string(&receipt).unwrap(), "{\"ok\":true,\"directory\":{\"dev\":\"4294967295\",\"ino\":\"18446744073709551615\",\"birthtimeNs\":\"-100\"},\"writer\":{\"dev\":\"1\",\"ino\":\"2\",\"birthtimeNs\":\"0\"}}");
    }
    #[test]
    fn reports_input_and_output_io_failure_without_private_details() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("private-storage-sentinel"))
            }
        }
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("private-storage-sentinel"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut output = Vec::new();
        assert!(!run(Broken, &mut output));
        assert_eq!(output, b"{\"ok\":false}");
        assert!(!run(b"null".as_slice(), Broken));
    }

    #[cfg(windows)]
    fn temporary() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "hpm-storage-directory-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        root
    }

    #[cfg(windows)]
    fn request(path: &std::path::Path) -> Request {
        Request {
            path: path.to_str().unwrap().into(),
            kind: Kind::Directory,
        }
    }

    #[test]
    #[cfg(windows)]
    fn creates_fixed_writer_and_returns_the_authenticated_handle_identities() {
        use super::super::windows::{identity, open};
        let root = temporary();
        let receipt = prepare(request(&root)).unwrap();
        let writer = root.join(".writer.sqlite");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        assert_eq!(std::fs::metadata(&writer).unwrap().len(), 0);
        assert_eq!(
            receipt.directory,
            identity(&open(&root, false).unwrap(), false).unwrap()
        );
        assert_eq!(
            receipt.writer,
            identity(&open(&writer, false).unwrap(), true).unwrap()
        );
        let input =
            serde_json::json!({"path":root.to_str().unwrap(),"kind":"directory"}).to_string();
        let mut output = Vec::new();
        assert!(run(input.as_bytes(), &mut output));
        let response: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(
            response["writer"],
            serde_json::to_value(&receipt.writer).unwrap()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn existing_writer_content_and_identity_are_never_truncated_or_replaced() {
        let root = temporary();
        let writer = root.join(".writer.sqlite");
        std::fs::write(&writer, b"existing-writer-synthetic-bytes").unwrap();
        let before = super::super::windows::identity(
            &super::super::windows::open(&writer, false).unwrap(),
            true,
        )
        .unwrap();
        let receipt = prepare(request(&root)).unwrap();
        assert_eq!(receipt.writer, before);
        assert_eq!(
            std::fs::read(&writer).unwrap(),
            b"existing-writer-synthetic-bytes"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn rejects_oversized_hardlinked_reparse_or_directory_writer() {
        let root = temporary();
        let writer = root.join(".writer.sqlite");
        let file = std::fs::File::create(&writer).unwrap();
        file.set_len(1_048_576).unwrap();
        drop(file);
        assert!(prepare(request(&root)).is_ok());
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&writer)
            .unwrap();
        file.set_len(1_048_577).unwrap();
        drop(file);
        assert!(prepare(request(&root)).is_err());
        assert_eq!(std::fs::metadata(&writer).unwrap().len(), 1_048_577);
        std::fs::remove_file(&writer).unwrap();
        std::fs::write(&writer, b"unchanged").unwrap();
        let alias = root.join("alias");
        std::fs::hard_link(&writer, &alias).unwrap();
        assert!(prepare(request(&root)).is_err());
        std::fs::remove_file(&writer).unwrap();
        std::os::windows::fs::symlink_file(&alias, &writer).unwrap();
        assert!(prepare(request(&root)).is_err());
        std::fs::remove_file(&writer).unwrap();
        std::fs::create_dir(&writer).unwrap();
        assert!(prepare(request(&root)).is_err());
        assert_eq!(std::fs::read(&alias).unwrap(), b"unchanged");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn pins_root_ancestors_and_writer_against_replacement_during_both_acl_operations() {
        for existing in [false, true] {
            let parent = temporary();
            let root = parent.join("store");
            std::fs::create_dir(&root).unwrap();
            let writer = root.join(".writer.sqlite");
            if existing {
                std::fs::write(&writer, b"existing-writer-synthetic").unwrap();
            }
            let mut calls = 0;
            let receipt = prepare_with(request(&root), |request| {
                calls += 1;
                assert!(std::fs::rename(&root, parent.join("moved")).is_err());
                assert!(std::fs::rename(&parent, parent.with_extension("moved")).is_err());
                if matches!(request.kind, Kind::File) {
                    assert!(std::fs::remove_file(&writer).is_err());
                    assert!(std::fs::rename(&writer, root.join("moved")).is_err());
                }
                super::super::secure(request)
            })
            .unwrap();
            assert!(receipt.ok);
            assert_eq!(calls, 2);
            let expected = if existing {
                b"existing-writer-synthetic".as_slice()
            } else {
                b"".as_slice()
            };
            assert_eq!(std::fs::read(&writer).unwrap(), expected);
            // After every native guard has dropped, a legitimate rename works.
            let moved = parent.join("moved");
            std::fs::rename(&root, &moved).unwrap();
            std::fs::rename(&moved, &root).unwrap();
            std::fs::remove_dir_all(parent).unwrap();
        }
    }

    #[test]
    #[cfg(windows)]
    fn shared_original_open_guards_block_rename_until_each_handle_closes() {
        use super::super::windows::open;
        let parent = temporary();
        let root = parent.join("store");
        std::fs::create_dir(&root).unwrap();
        let writer = root.join(".writer.sqlite");
        std::fs::write(&writer, b"existing-synthetic").unwrap();
        for write_acl in [false, true] {
            for target in [&root, &writer] {
                let moved = parent.join("moved");
                let guard = open(target, write_acl).unwrap();
                assert!(std::fs::rename(target, &moved).is_err());
                drop(guard);
                std::fs::rename(target, &moved).unwrap();
                std::fs::rename(&moved, target).unwrap();
            }
        }
        assert_eq!(std::fs::read(&writer).unwrap(), b"existing-synthetic");
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn secure_failures_leave_only_original_permitted_residuals() {
        let root = temporary();
        assert!(prepare_with(request(&root), |_| Err(())).is_err());
        assert!(!root.join(".writer.sqlite").exists());
        assert!(prepare_with(request(&root), |request| {
            if matches!(request.kind, Kind::File) {
                Err(())
            } else {
                super::super::secure(request)
            }
        })
        .is_err());
        assert_eq!(
            std::fs::metadata(root.join(".writer.sqlite"))
                .unwrap()
                .len(),
            0
        );
        std::fs::write(root.join(".writer.sqlite"), b"existing-is-not-removed").unwrap();
        assert!(prepare_with(request(&root), |request| {
            if matches!(request.kind, Kind::File) {
                Err(())
            } else {
                super::super::secure(request)
            }
        })
        .is_err());
        assert_eq!(
            std::fs::read(root.join(".writer.sqlite")).unwrap(),
            b"existing-is-not-removed"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn existing_writer_can_report_a_real_pre_unix_epoch_birth_time() {
        use std::os::windows::io::AsRawHandle;
        #[link(name = "kernel32")]
        extern "system" {
            fn SetFileTime(
                file: *mut std::ffi::c_void,
                creation: *const [u32; 2],
                access: *const [u32; 2],
                write: *const [u32; 2],
            ) -> i32;
        }
        let root = temporary();
        let path = root.join(".writer.sqlite");
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        let ticks = 116_444_735_999_999_999u64;
        let creation = [ticks as u32, (ticks >> 32) as u32];
        assert_ne!(
            unsafe {
                SetFileTime(
                    file.as_raw_handle(),
                    &creation,
                    std::ptr::null(),
                    std::ptr::null(),
                )
            },
            0
        );
        drop(file);
        let receipt = prepare(request(&root)).unwrap();
        assert_eq!(receipt.writer.birthtime_ns, "-100");
        // Node bigint Stats comparison is intentionally a separate JS gate.
        std::fs::remove_dir_all(root).unwrap();
    }
}
