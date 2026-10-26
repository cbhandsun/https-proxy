//! Independent, opaque current-user anchor primitive. No caller-selected paths.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use std::io::{Read, Write};

mod diagnostic;
pub use diagnostic::run as run_diagnostic;
mod stream;
pub use stream::run as run_stream;

const MAX_IO: usize = 128 * 1024;
const MAX_VALUE: usize = 65536;
const MAX_REVISION: u64 = 9_007_199_254_740_991;
const MAGIC: &[u8; 8] = b"HPMANC01";
const HEADER: usize = 8 + 64 + 8 + 4;

#[derive(Deserialize)]
#[serde(tag = "operation", deny_unknown_fields)]
enum Request {
    #[serde(rename = "read")]
    Read { slot: String },
    #[serde(rename = "compare", rename_all = "camelCase")]
    Compare {
        slot: String,
        expected_revision: u64,
        value: String,
    },
}

impl Request {
    fn slot(&self) -> &str {
        match self {
            Self::Read { slot } | Self::Compare { slot, .. } => slot,
        }
    }
}

fn parse(input: &[u8]) -> Result<Request, ()> {
    if input.len() > MAX_IO {
        return Err(());
    }
    let request: Request = serde_json::from_slice(input).map_err(|_| ())?;
    if request.slot().len() != 64
        || !request
            .slot()
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(());
    }
    if let Request::Compare {
        expected_revision,
        value,
        ..
    } = &request
    {
        if *expected_revision >= MAX_REVISION {
            return Err(());
        }
        decode_value(value)?;
    }
    Ok(request)
}

fn decode_value(value: &str) -> Result<Vec<u8>, ()> {
    if value.len() > MAX_VALUE.div_ceil(3) * 4 {
        return Err(());
    }
    let bytes = STANDARD.decode(value).map_err(|_| ())?;
    if bytes.is_empty() || bytes.len() > MAX_VALUE || STANDARD.encode(&bytes) != value {
        return Err(());
    }
    Ok(bytes)
}

fn encode_record(slot: &str, revision: u64, value: &[u8]) -> Result<Vec<u8>, ()> {
    if revision == 0 || revision > MAX_REVISION || value.is_empty() || value.len() > MAX_VALUE {
        return Err(());
    }
    let mut record = Vec::with_capacity(HEADER + value.len());
    record.extend_from_slice(MAGIC);
    record.extend_from_slice(slot.as_bytes());
    record.extend_from_slice(&revision.to_le_bytes());
    record.extend_from_slice(&(value.len() as u32).to_le_bytes());
    record.extend_from_slice(value);
    Ok(record)
}

fn decode_record(slot: &str, record: &[u8]) -> Result<(u64, Vec<u8>), ()> {
    if record.len() <= HEADER
        || record.len() > HEADER + MAX_VALUE
        || &record[..8] != MAGIC
        || &record[8..72] != slot.as_bytes()
    {
        return Err(());
    }
    let revision = u64::from_le_bytes(record[72..80].try_into().map_err(|_| ())?);
    let length = u32::from_le_bytes(record[80..84].try_into().map_err(|_| ())?) as usize;
    if revision == 0
        || revision > MAX_REVISION
        || length == 0
        || length > MAX_VALUE
        || record.len() != HEADER + length
    {
        return Err(());
    }
    Ok((revision, record[HEADER..].to_vec()))
}

trait Backend {
    fn acquire(&mut self, slot: &str) -> Result<(), ()>;
    fn read(&mut self, slot: &str) -> Result<Option<Vec<u8>>, ()>;
    fn write(&mut self, slot: &str, record: &[u8]) -> Result<(), ()>;
    fn flush(&mut self) -> Result<(), ()>;
}

fn execute(request: Request, backend: &mut impl Backend) -> Result<String, ()> {
    let slot = request.slot();
    backend.acquire(slot)?;
    let current = backend.read(slot)?;
    let (revision, value) = match &current {
        Some(record) => {
            let (revision, value) = decode_record(slot, record)?;
            (revision, Some(STANDARD.encode(value)))
        }
        None => (0, None),
    };
    let (revision, value) = match request {
        Request::Read { .. } => (revision, value),
        Request::Compare {
            slot,
            expected_revision,
            value,
        } => {
            if revision != expected_revision || expected_revision >= MAX_REVISION {
                return Err(());
            }
            let next = expected_revision.checked_add(1).ok_or(())?;
            let record = encode_record(&slot, next, &decode_value(&value)?)?;
            backend.write(&slot, &record)?;
            backend.flush()?;
            if backend.read(&slot)?.as_deref() != Some(record.as_slice()) {
                return Err(());
            }
            (next, Some(value))
        }
    };
    let reply = serde_json::json!({"ok":true,"revision":revision,"value":value}).to_string();
    if reply.len() > MAX_IO {
        return Err(());
    }
    Ok(reply)
}

#[cfg(not(windows))]
fn process(_request: Request) -> Result<String, ()> {
    Err(())
}

#[cfg(windows)]
fn process(request: Request) -> Result<String, ()> {
    execute(request, &mut windows::RegistryBackend::new())
}

pub fn run<R: Read, W: Write>(reader: R, mut writer: W) -> bool {
    let mut input = Vec::new();
    let result = reader
        .take(MAX_IO as u64 + 1)
        .read_to_end(&mut input)
        .map_err(|_| ())
        .and_then(|_| parse(&input))
        .and_then(process);
    let success = result.is_ok();
    let output = result.unwrap_or_else(|_| "{\"ok\":false}".to_owned());
    writer.write_all(output.as_bytes()).is_ok() && success
}

#[cfg(windows)]
mod windows {
    use super::{Backend, HEADER, MAX_VALUE};
    use std::ffi::c_void;
    use std::ptr;

    type Handle = *mut c_void;
    const NOT_FOUND: i32 = 2;
    const REG_BINARY: u32 = 3;
    const KEY_ACCESS: u32 = 0x000f_003f | 0x100; // fixed 64-bit registry view
    const DACL: u32 = 4;
    const PROTECTED: u16 = 0x1000;
    const MUTEX_RIGHTS: u32 = 0x0012_0001;

    #[repr(C)]
    struct SecurityAttributes {
        length: u32,
        descriptor: Handle,
        inherit: i32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn LocalFree(memory: Handle) -> Handle;
        fn CreateMutexExW(
            attributes: *mut SecurityAttributes,
            name: *const u16,
            flags: u32,
            access: u32,
        ) -> Handle;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn ReleaseMutex(handle: Handle) -> i32;
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
        fn RegOpenKeyExW(
            parent: Handle,
            name: *const u16,
            options: u32,
            access: u32,
            key: *mut Handle,
        ) -> i32;
        fn RegCreateKeyExW(
            parent: Handle,
            name: *const u16,
            reserved: u32,
            class: *mut u16,
            options: u32,
            access: u32,
            attributes: *mut SecurityAttributes,
            key: *mut Handle,
            disposition: *mut u32,
        ) -> i32;
        fn RegQueryValueExW(
            key: Handle,
            name: *const u16,
            reserved: *mut u32,
            kind: *mut u32,
            bytes: *mut u8,
            size: *mut u32,
        ) -> i32;
        fn RegSetValueExW(
            key: Handle,
            name: *const u16,
            reserved: u32,
            kind: u32,
            bytes: *const u8,
            size: u32,
        ) -> i32;
        fn RegFlushKey(key: Handle) -> i32;
        fn RegCloseKey(key: Handle) -> i32;
    }

    struct Local(Handle);
    impl Drop for Local {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { LocalFree(self.0) };
            }
        }
    }
    struct OwnedHandle(Handle);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CloseHandle(self.0) };
            }
        }
    }
    struct Key(Handle);
    impl Drop for Key {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { RegCloseKey(self.0) };
            }
        }
    }
    struct Mutex {
        handle: OwnedHandle,
        acquired: bool,
    }
    impl Drop for Mutex {
        fn drop(&mut self) {
            if self.acquired {
                unsafe { ReleaseMutex(self.handle.0) };
            }
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }
    fn current_sid() -> Result<String, ()> {
        let mut token = OwnedHandle(ptr::null_mut());
        if unsafe { OpenProcessToken(GetCurrentProcess(), 8, &mut token.0) } == 0 {
            return Err(());
        }
        let mut needed = 0;
        unsafe { GetTokenInformation(token.0, 1, ptr::null_mut(), 0, &mut needed) };
        if !(std::mem::size_of::<Handle>() as u32..=65536).contains(&needed) {
            return Err(());
        }
        let mut buffer = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        if unsafe {
            GetTokenInformation(token.0, 1, buffer.as_mut_ptr().cast(), needed, &mut needed)
        } == 0
        {
            return Err(());
        }
        let mut text = ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(buffer[0] as Handle, &mut text) } == 0 || text.is_null()
        {
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
    fn descriptor(sid: &str, rights: &str) -> Result<Local, ()> {
        let sddl = wide(&format!(
            "D:P(A;;{rights};;;SY)(A;;{rights};;;BA)(A;;{rights};;;{sid})"
        ));
        let mut allocation = Local(ptr::null_mut());
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut allocation.0,
                ptr::null_mut(),
            )
        } == 0
            || allocation.0.is_null()
        {
            return Err(());
        }
        Ok(allocation)
    }
    fn acl_bytes(descriptor: Handle) -> Result<Vec<u8>, ()> {
        let mut present = 0;
        let mut defaulted = 0;
        let mut acl = ptr::null_mut();
        let mut control = 0;
        let mut revision = 0;
        if unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted) }
            == 0
            || present == 0
            || acl.is_null()
            || unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
            || control & PROTECTED == 0
        {
            return Err(());
        }
        let length = unsafe {
            u16::from_le_bytes([*acl.cast::<u8>().add(2), *acl.cast::<u8>().add(3)]) as usize
        };
        if !(8..=4096).contains(&length) {
            return Err(());
        }
        Ok(unsafe { std::slice::from_raw_parts(acl.cast(), length) }.to_vec())
    }
    fn verify_acl(handle: Handle, object: u32, expected: Handle) -> Result<(), ()> {
        let mut actual = Local(ptr::null_mut());
        if unsafe {
            GetSecurityInfo(
                handle,
                object,
                DACL,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                &mut actual.0,
            )
        } != 0
            || actual.0.is_null()
            || acl_bytes(actual.0)? != acl_bytes(expected)?
        {
            return Err(());
        }
        Ok(())
    }
    fn reject_link(key: Handle) -> Result<(), ()> {
        let mut kind = 0;
        let mut length = 0;
        let result = unsafe {
            RegQueryValueExW(
                key,
                wide("SymbolicLinkValue").as_ptr(),
                ptr::null_mut(),
                &mut kind,
                ptr::null_mut(),
                &mut length,
            )
        };
        if result != NOT_FOUND {
            return Err(());
        }
        Ok(())
    }

    pub(super) struct RegistryBackend {
        mutex: Option<Mutex>,
        descriptor: Option<Local>,
        keys: Vec<Key>,
        slot: Option<String>,
    }
    impl RegistryBackend {
        pub(super) fn new() -> Self {
            Self {
                mutex: None,
                descriptor: None,
                keys: Vec::new(),
                slot: None,
            }
        }
        fn open(&mut self, slot: &str, create: bool) -> Result<bool, ()> {
            self.keys.clear();
            let expected = self.descriptor.as_ref().ok_or(())?.0;
            // Predefined HKEY_CURRENT_USER is a sign-extended 32-bit pseudo-handle.
            let mut parent = 0x8000_0001u32 as i32 as isize as Handle;
            for (index, component) in [
                "Software",
                "HTTPSProxyManager",
                "ContextRecovery",
                "Anchors",
                "v1",
                slot,
            ]
            .iter()
            .enumerate()
            {
                let mut key = Key(ptr::null_mut());
                // OPEN_LINK opens a registry link itself instead of its target.
                let result = unsafe {
                    RegOpenKeyExW(parent, wide(component).as_ptr(), 8, KEY_ACCESS, &mut key.0)
                };
                if result == NOT_FOUND && create && index != 0 {
                    let mut attributes = SecurityAttributes {
                        length: std::mem::size_of::<SecurityAttributes>() as u32,
                        descriptor: expected,
                        inherit: 0,
                    };
                    let mut disposition = 0;
                    if unsafe {
                        RegCreateKeyExW(
                            parent,
                            wide(component).as_ptr(),
                            0,
                            ptr::null_mut(),
                            0,
                            KEY_ACCESS,
                            &mut attributes,
                            &mut key.0,
                            &mut disposition,
                        )
                    } != 0
                        || disposition != 1
                    {
                        return Err(());
                    }
                } else if result == NOT_FOUND && !create {
                    return Ok(false);
                } else if result != 0 {
                    return Err(());
                }
                if key.0.is_null() {
                    return Err(());
                }
                reject_link(key.0)?;
                if index != 0 {
                    verify_acl(key.0, 4, expected)?;
                }
                parent = key.0;
                self.keys.push(key);
            }
            Ok(true)
        }
        fn read_value(&self) -> Result<Option<Vec<u8>>, ()> {
            let key = self.keys.last().ok_or(())?.0;
            let mut kind = 0;
            let mut size = 0;
            let name = wide("state");
            let result = unsafe {
                RegQueryValueExW(
                    key,
                    name.as_ptr(),
                    ptr::null_mut(),
                    &mut kind,
                    ptr::null_mut(),
                    &mut size,
                )
            };
            if result == NOT_FOUND {
                return Ok(None);
            }
            if result != 0
                || kind != REG_BINARY
                || size as usize <= HEADER
                || size as usize > HEADER + MAX_VALUE
            {
                return Err(());
            }
            let mut bytes = vec![0u8; size as usize];
            let expected_size = size;
            if unsafe {
                RegQueryValueExW(
                    key,
                    name.as_ptr(),
                    ptr::null_mut(),
                    &mut kind,
                    bytes.as_mut_ptr(),
                    &mut size,
                )
            } != 0
                || size != expected_size
                || kind != REG_BINARY
            {
                return Err(());
            }
            Ok(Some(bytes))
        }
    }
    impl Backend for RegistryBackend {
        fn acquire(&mut self, slot: &str) -> Result<(), ()> {
            if self.mutex.is_some() {
                return Err(());
            }
            let sid = current_sid()?;
            let security = descriptor(&sid, "0x00120001")?;
            let name = wide(&format!(
                "Global\\HPM.ContextRecovery.Anchor.v1.{sid}.{slot}"
            ));
            if name.len() > 260 {
                return Err(());
            }
            let mut attributes = SecurityAttributes {
                length: std::mem::size_of::<SecurityAttributes>() as u32,
                descriptor: security.0,
                inherit: 0,
            };
            let handle = OwnedHandle(unsafe {
                CreateMutexExW(&mut attributes, name.as_ptr(), 0, MUTEX_RIGHTS)
            });
            if handle.0.is_null() {
                return Err(());
            }
            verify_acl(handle.0, 6, security.0)?;
            let result = unsafe { WaitForSingleObject(handle.0, 0) };
            // WAIT_ABANDONED grants ownership; release it but never admit work.
            let mutex = Mutex {
                handle,
                acquired: result == 0 || result == 0x80,
            };
            if result != 0 {
                return Err(());
            }
            self.mutex = Some(mutex);
            self.descriptor = Some(descriptor(&sid, "KA")?);
            self.slot = Some(slot.to_owned());
            Ok(())
        }
        fn read(&mut self, slot: &str) -> Result<Option<Vec<u8>>, ()> {
            if self.slot.as_deref() != Some(slot) || self.mutex.is_none() {
                return Err(());
            }
            if !self.open(slot, false)? {
                return Ok(None);
            }
            self.read_value()
        }
        fn write(&mut self, slot: &str, record: &[u8]) -> Result<(), ()> {
            if self.slot.as_deref() != Some(slot)
                || self.mutex.is_none()
                || record.len() > HEADER + MAX_VALUE
            {
                return Err(());
            }
            if !self.open(slot, true)? {
                return Err(());
            }
            let key = self.keys.last().ok_or(())?.0;
            if unsafe {
                RegSetValueExW(
                    key,
                    wide("state").as_ptr(),
                    0,
                    REG_BINARY,
                    record.as_ptr(),
                    record.len() as u32,
                )
            } != 0
            {
                return Err(());
            }
            Ok(())
        }
        fn flush(&mut self) -> Result<(), ()> {
            if unsafe { RegFlushKey(self.keys.last().ok_or(())?.0) } != 0 {
                return Err(());
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    pub(super) struct Mock {
        pub(super) value: Option<Vec<u8>>,
        pub(super) fail: Option<&'static str>,
        pub(super) reads: usize,
        pub(super) writes: usize,
        pub(super) flushes: usize,
    }
    impl Backend for Mock {
        fn acquire(&mut self, _slot: &str) -> Result<(), ()> {
            if self.fail == Some("lock") {
                Err(())
            } else {
                Ok(())
            }
        }
        fn read(&mut self, _slot: &str) -> Result<Option<Vec<u8>>, ()> {
            self.reads += 1;
            if self.fail == Some("read") || (self.fail == Some("readback") && self.reads > 1) {
                return Err(());
            }
            if self.fail == Some("mismatch") && self.reads > 1 {
                return Ok(None);
            }
            Ok(self.value.clone())
        }
        fn write(&mut self, _slot: &str, record: &[u8]) -> Result<(), ()> {
            self.writes += 1;
            if self.fail == Some("write") {
                return Err(());
            }
            self.value = Some(record.to_vec());
            Ok(())
        }
        fn flush(&mut self) -> Result<(), ()> {
            self.flushes += 1;
            if self.fail == Some("flush") {
                Err(())
            } else {
                Ok(())
            }
        }
    }
    pub(super) fn request(operation: &str, revision: u64) -> Request {
        let slot = "a".repeat(64);
        if operation == "read" {
            Request::Read { slot }
        } else {
            Request::Compare {
                slot,
                expected_revision: revision,
                value: STANDARD.encode([42u8]),
            }
        }
    }
    #[test]
    fn absent_read_does_not_write_and_compare_is_cas() {
        let mut backend = Mock::default();
        let absent: serde_json::Value =
            serde_json::from_str(&execute(request("read", 0), &mut backend).unwrap()).unwrap();
        assert_eq!(
            absent,
            serde_json::json!({"ok":true,"revision":0,"value":null})
        );
        assert_eq!(backend.writes, 0);
        let reply: serde_json::Value =
            serde_json::from_str(&execute(request("compare", 0), &mut backend).unwrap()).unwrap();
        assert_eq!(
            reply,
            serde_json::json!({"ok":true,"revision":1,"value":"Kg=="})
        );
        assert!(execute(request("compare", 0), &mut backend).is_err());
        assert_eq!(backend.writes, 1);
        assert!(execute(request("compare", 1), &mut backend).is_ok());
        assert_eq!(backend.flushes, 2);
    }
    #[test]
    fn malformed_json_and_unbounded_requests_are_rejected() {
        let slot = "a".repeat(64);
        let good = format!("{{\"operation\":\"read\",\"slot\":\"{slot}\"}}");
        assert!(parse(good.as_bytes()).is_ok());
        for input in [String::new(), "null".into(), "[]".into(),
            format!("{{\"operation\":\"read\",\"slot\":\"{slot}\",\"slot\":\"{slot}\"}}"),
            format!("{{\"operation\":\"read\",\"operation\":\"read\",\"slot\":\"{slot}\"}}"),
            format!("{{\"operation\":\"read\",\"slot\":\"{slot}\",\"value\":null}}"),
            format!("{{\"operation\":\"read\",\"slot\":\"{}\"}}", "A".repeat(64)),
            format!("{{\"operation\":\"compare\",\"slot\":\"{slot}\",\"expectedRevision\":-1,\"value\":\"Kg==\"}}"),
            format!("{{\"operation\":\"compare\",\"slot\":\"{slot}\",\"expectedRevision\":{MAX_REVISION},\"value\":\"Kg==\"}}"),
            " ".repeat(MAX_IO + 1)] { assert!(parse(input.as_bytes()).is_err()); }
        for value in ["", "K g==", "Kg", "Kh==", "Kg==\n"] {
            assert!(decode_value(value).is_err());
        }
        assert!(decode_value(&STANDARD.encode(vec![1; MAX_VALUE])).is_ok());
        assert!(decode_value(&STANDARD.encode(vec![1; MAX_VALUE + 1])).is_err());
    }
    #[test]
    fn corrupt_records_never_become_absent_or_get_overwritten() {
        let slot = "a".repeat(64);
        for value in [
            vec![],
            vec![0; HEADER + 1],
            encode_record(&"b".repeat(64), 1, &[1]).unwrap(),
        ] {
            let mut backend = Mock {
                value: Some(value),
                ..Mock::default()
            };
            assert!(execute(request("read", 0), &mut backend).is_err());
            assert!(execute(request("compare", 0), &mut backend).is_err());
            assert_eq!(backend.writes, 0);
        }
        assert!(encode_record(&slot, 0, &[1]).is_err());
        assert!(encode_record(&slot, MAX_REVISION + 1, &[1]).is_err());
        let mut backend = Mock {
            value: Some(encode_record(&slot, MAX_REVISION, &[1]).unwrap()),
            ..Mock::default()
        };
        assert!(execute(request("compare", MAX_REVISION), &mut backend).is_err());
        assert_eq!(backend.writes, 0);
    }
    #[test]
    fn conflict_and_io_failures_never_report_success() {
        for failure in ["lock", "read", "write", "flush", "readback", "mismatch"] {
            let mut backend = Mock {
                fail: Some(failure),
                ..Mock::default()
            };
            assert!(execute(request("compare", 0), &mut backend).is_err());
            if matches!(failure, "lock" | "read") {
                assert_eq!(backend.writes, 0);
            }
            if failure == "write" {
                assert_eq!(backend.flushes, 0);
            }
        }
    }
    #[test]
    fn malformed_io_has_only_a_fixed_failure_reply() {
        let mut output = Vec::new();
        assert!(!run(&b"PRIVATE_INVALID"[..], &mut output));
        assert_eq!(output, b"{\"ok\":false}");
    }
}
