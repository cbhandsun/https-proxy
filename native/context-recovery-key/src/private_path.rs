use serde::Deserialize;
use std::io::{Read, Write};

const MAX_INPUT: u64 = 20000;

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    File,
    Directory,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    path: String,
    kind: Kind,
}

fn unsafe_component(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or("").trim_end_matches(' ');
    let upper = stem.to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            upper.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
    part.is_empty() || matches!(part, "." | "..") || part.ends_with([' ', '.']) || reserved
}

fn parse(input: &[u8]) -> Result<Request, ()> {
    if input.len() as u64 > MAX_INPUT {
        return Err(());
    }
    let request: Request = serde_json::from_slice(input).map_err(|_| ())?;
    let bytes = request.path.as_bytes();
    if bytes.len() < 4
        || request.path.encode_utf16().count() > 4096
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || !matches!(bytes[2], b'/' | b'\\')
        || bytes[2..].iter().any(|byte| {
            *byte < 32 || matches!(byte, b':' | b'<' | b'>' | b'"' | b'|' | b'?' | b'*')
        })
        || request
            .path
            .split(['/', '\\'])
            .skip(1)
            .any(unsafe_component)
    {
        return Err(());
    }
    Ok(request)
}

#[cfg(windows)]
mod windows {
    use super::{Kind, Request};
    use std::ffi::c_void;
    use std::fs::{File, OpenOptions};
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use std::ptr;

    type Handle = *mut c_void;
    const DACL: u32 = 4;
    const PROTECTED_DACL: u32 = 0x8000_0000;

    #[repr(C)]
    struct FileInfo {
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
        fn GetCurrentProcess() -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn LocalFree(memory: Handle) -> Handle;
        fn GetFileInformationByHandle(handle: Handle, info: *mut FileInfo) -> i32;
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
        fn GetTokenInformation(
            token: Handle,
            class: u32,
            info: Handle,
            size: u32,
            needed: *mut u32,
        ) -> i32;
        fn ConvertSidToStringSidW(sid: Handle, text: *mut *mut u16) -> i32;
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text: *const u16,
            revision: u32,
            descriptor: *mut Handle,
            size: *mut u32,
        ) -> i32;
        fn GetSecurityDescriptorDacl(
            descriptor: Handle,
            present: *mut i32,
            acl: *mut Handle,
            defaulted: *mut i32,
        ) -> i32;
        fn GetSecurityDescriptorControl(
            descriptor: Handle,
            control: *mut u16,
            revision: *mut u32,
        ) -> i32;
        fn SetSecurityInfo(
            handle: Handle,
            object: u32,
            information: u32,
            owner: Handle,
            group: Handle,
            acl: Handle,
            sacl: Handle,
        ) -> u32;
        fn GetSecurityInfo(
            handle: Handle,
            object: u32,
            information: u32,
            owner: *mut Handle,
            group: *mut Handle,
            acl: *mut Handle,
            sacl: *mut Handle,
            descriptor: *mut Handle,
        ) -> u32;
    }

    struct Local(Handle);
    impl Drop for Local {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    LocalFree(self.0);
                }
            }
        }
    }
    struct Token(Handle);
    impl Drop for Token {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    fn current_sid() -> Result<String, ()> {
        let mut token = Token(ptr::null_mut());
        if unsafe { OpenProcessToken(GetCurrentProcess(), 8, &mut token.0) } == 0 {
            return Err(());
        }
        let mut needed = 0;
        unsafe {
            GetTokenInformation(token.0, 1, ptr::null_mut(), 0, &mut needed);
        }
        if !(std::mem::size_of::<Handle>() as u32..=65536).contains(&needed) {
            return Err(());
        }
        // TOKEN_USER starts with an aligned SID pointer. Keep its backing memory
        // alive until the SID string conversion completes.
        let mut buffer = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        if unsafe {
            GetTokenInformation(token.0, 1, buffer.as_mut_ptr().cast(), needed, &mut needed)
        } == 0
        {
            return Err(());
        }
        let sid = buffer[0] as Handle;
        let mut text = ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 || text.is_null() {
            return Err(());
        }
        let _allocation = Local(text.cast());
        let mut length = 0;
        while length < 256 && unsafe { *text.add(length) } != 0 {
            length += 1;
        }
        if length == 256 {
            return Err(());
        }
        String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) }).map_err(|_| ())
    }

    fn open(path: &Path, write_acl: bool) -> Result<File, ()> {
        // No DELETE sharing: keep every ancestor and the target pinned while
        // examining and replacing the target DACL. Open reparses themselves.
        let file = OpenOptions::new()
            .access_mode(if write_acl { 0x0006_0080 } else { 0x80 })
            .share_mode(3)
            .custom_flags(0x0220_0000)
            .open(path)
            .map_err(|_| ())?;
        let metadata = file.metadata().map_err(|_| ())?;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(());
        }
        Ok(file)
    }

    unsafe fn acl_bytes(acl: Handle) -> Result<Vec<u8>, ()> {
        if acl.is_null() {
            return Err(());
        }
        // The Win32 API owns and validates the ACL. ACL_SIZE is the u16 at
        // offset 2; cap it before constructing a slice.
        let length =
            u16::from_le_bytes([*(acl.cast::<u8>().add(2)), *(acl.cast::<u8>().add(3))]) as usize;
        if !(8..=4096).contains(&length) {
            return Err(());
        }
        Ok(std::slice::from_raw_parts(acl.cast(), length).to_vec())
    }

    pub(super) fn secure(request: Request) -> Result<(), ()> {
        let path = Path::new(&request.path);
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
        let file = open(path, true)?;
        let metadata = file.metadata().map_err(|_| ())?;
        if match request.kind {
            Kind::File => !metadata.is_file(),
            Kind::Directory => !metadata.is_dir(),
        } {
            return Err(());
        }
        let mut info: FileInfo = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
            || (matches!(request.kind, Kind::File) && info.links != 1)
        {
            return Err(());
        }
        let sid = current_sid()?;
        let flags = if matches!(request.kind, Kind::Directory) {
            "OICI"
        } else {
            ""
        };
        let sddl: Vec<u16> =
            format!("D:P(A;{flags};FA;;;SY)(A;{flags};FA;;;BA)(A;{flags};FA;;;{sid})")
                .encode_utf16()
                .chain(Some(0))
                .collect();
        let mut descriptor = Local(ptr::null_mut());
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor.0,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(());
        }
        let mut present = 0;
        let mut defaulted = 0;
        let mut expected = ptr::null_mut();
        if unsafe {
            GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut expected, &mut defaulted)
        } == 0
            || present == 0
        {
            return Err(());
        }
        if unsafe {
            SetSecurityInfo(
                file.as_raw_handle(),
                1,
                DACL | PROTECTED_DACL,
                ptr::null_mut(),
                ptr::null_mut(),
                expected,
                ptr::null_mut(),
            )
        } != 0
        {
            return Err(());
        }
        let mut actual = ptr::null_mut();
        let mut readback = Local(ptr::null_mut());
        if unsafe {
            GetSecurityInfo(
                file.as_raw_handle(),
                1,
                DACL,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut actual,
                ptr::null_mut(),
                &mut readback.0,
            )
        } != 0
        {
            return Err(());
        }
        let mut control = 0;
        let mut revision = 0;
        if unsafe { GetSecurityDescriptorControl(readback.0, &mut control, &mut revision) } == 0
            || control & 0x1000 == 0
            || unsafe { acl_bytes(actual)? != acl_bytes(expected)? }
        {
            return Err(());
        }
        Ok(())
    }
}

#[cfg(windows)]
fn secure(request: Request) -> Result<(), ()> {
    windows::secure(request)
}
#[cfg(not(windows))]
fn secure(request: Request) -> Result<(), ()> {
    let _ = request.kind;
    Err(())
}

pub fn run<R: Read, W: Write>(reader: R, mut writer: W) -> bool {
    let mut input = Vec::new();
    let success = reader.take(MAX_INPUT + 1).read_to_end(&mut input).is_ok()
        && parse(&input).and_then(secure).is_ok();
    let output: &[u8] = if success {
        b"{\"ok\":true}"
    } else {
        b"{\"ok\":false}"
    };
    writer.write_all(output).is_ok() && success
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(windows)]
    fn protects_real_file_and_directory_and_rejects_mismatches_and_hardlinks() {
        let name = format!(
            "hpm-native-acl-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(name);
        std::fs::create_dir(&root).unwrap();
        let file = root.join("原文.txt");
        std::fs::write(&file, b"synthetic").unwrap();
        let request = |path: &std::path::Path, kind: Kind| Request {
            path: path.to_str().unwrap().into(),
            kind,
        };
        assert!(secure(request(&root, Kind::Directory)).is_ok());
        assert!(secure(request(&file, Kind::File)).is_ok());
        assert_eq!(std::fs::read(&file).unwrap(), b"synthetic");
        assert!(secure(request(&root, Kind::File)).is_err());
        assert!(secure(request(&file, Kind::Directory)).is_err());
        assert!(secure(request(&root.join("missing"), Kind::File)).is_err());
        let alias = root.join("alias");
        std::fs::hard_link(&file, &alias).unwrap();
        assert!(secure(request(&file, Kind::File)).is_err());
        std::fs::remove_file(alias).unwrap();
        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn rejects_unknown_duplicate_unsafe_and_extreme_paths() {
        for input in [
            "",
            "null",
            "[]",
            "{}",
            "{\"path\":\"C:/x\",\"kind\":\"file\",\"extra\":1}",
            "{\"path\":\"C:/x\",\"path\":\"C:/y\",\"kind\":\"file\"}",
            "{\"path\":\"C:/x\",\"kind\":\"file\",\"kind\":\"directory\"}",
            "{\"path\":\"C:/x\",\"kind\":\"other\"}",
        ] {
            assert!(parse(input.as_bytes()).is_err());
        }
        for path in [
            "C:/",
            "relative",
            "//host/share/file",
            "C:/../x",
            "C:/x:y",
            "C:/x\n",
            "C:/x.",
            "C:/x//y",
            "C:/x\t",
            "C:/x\u{001f}",
            "C:/x?",
            "C:/x*",
            "C:/x<y",
            "C:/x>y",
            "C:/x\"y",
            "C:/x|y",
            "C:/NUL.txt",
            "C:/con/x",
            "C:/PRN .log",
            "C:/AUX",
            "C:/com1.txt",
            "C:/LPT9",
            "C:/COM¹",
            "C:/LPT².txt",
            "C:/COM³",
        ] {
            let input = serde_json::json!({"path":path,"kind":"file"}).to_string();
            assert!(parse(input.as_bytes()).is_err(), "{path:?}");
        }
        assert!(parse(&vec![b' '; MAX_INPUT as usize + 1]).is_err());
        let mut output = Vec::new();
        assert!(!run(b"null".as_slice(), &mut output));
        assert_eq!(output, b"{\"ok\":false}");
    }

    #[test]
    fn accepts_unambiguous_unicode_paths_and_enforces_utf16_bound() {
        for path in [
            "C:/原文/文件.txt",
            "D:\\store\\COM10.txt",
            "C:/console/auxiliary",
        ] {
            let input = serde_json::json!({"path":path,"kind":"directory"}).to_string();
            assert!(parse(input.as_bytes()).is_ok());
        }
        for (length, accepted) in [(4093, true), (4094, false)] {
            let input =
                serde_json::json!({"path":format!("C:/{}", "x".repeat(length)),"kind":"file"})
                    .to_string();
            assert_eq!(parse(input.as_bytes()).is_ok(), accepted);
        }
        let input = serde_json::json!({"path":format!("C:/{}", "𠮷".repeat(2047)),"kind":"file"})
            .to_string();
        assert!(parse(input.as_bytes()).is_err());
    }

    #[test]
    fn reports_io_failures_without_exposing_details() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("private-path-secret"))
            }
        }
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("private-path-secret"))
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
}
