//! A fourth inherited pipe belongs to the spawning worker, independently of
//! framed stdin. Worker termination closes that pipe even when it cannot run
//! JavaScript cleanup. Never enumerate or terminate another process by PID.
use std::io::{ErrorKind, Read};

fn watch(mut reader: impl Read, lost: impl FnOnce()) {
    let mut byte = [0u8; 1];
    loop {
        match reader.read(&mut byte) {
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            _ => break, // EOF, failure or unexpected data all revoke ownership.
        }
    }
    lost();
}

pub(super) fn attach() -> Result<(), ()> {
    let reader = inherited()?;
    std::thread::Builder::new()
        .name("hpm-anchor-owner".into())
        .spawn(move || watch(reader, terminate_self))
        .map(|_| ())
        .map_err(|_| ())
}

#[cfg(unix)]
fn inherited() -> Result<Box<dyn Read + Send>, ()> {
    use std::fs::File;
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::os::unix::fs::FileTypeExt;
    use std::os::unix::net::UnixStream;
    extern "C" {
        fn dup(fd: i32) -> i32;
    }
    let fd = unsafe { dup(3) };
    if fd < 0 {
        return Err(());
    }
    // Only the duplicate is owned here. The original CRT/inherited descriptor
    // remains untouched, including on any validation failure.
    let file = unsafe { File::from_raw_fd(fd) };
    if !file.metadata().map_err(|_| ())?.file_type().is_socket() {
        return Err(());
    }
    let stream = UnixStream::from(OwnedFd::from(file));
    stream.set_nonblocking(false).map_err(|_| ())?;
    Ok(Box::new(stream))
}

#[cfg(windows)]
fn inherited() -> Result<Box<dyn Read + Send>, ()> {
    use std::ffi::c_void;
    use std::fs::File;
    use std::os::windows::io::FromRawHandle;
    type Handle = *mut c_void;
    #[repr(C)]
    struct Startup {
        size: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        columns: u32,
        rows: u32,
        fill: u32,
        flags: u32,
        show: u16,
        reserved_size: u16,
        reserved_bytes: *mut u8,
        input: Handle,
        output: Handle,
        error: Handle,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetStartupInfoW(info: *mut Startup);
        fn GetCurrentProcess() -> Handle;
        fn GetFileType(file: Handle) -> u32;
        fn DuplicateHandle(
            source: Handle,
            handle: Handle,
            destination: Handle,
            result: *mut Handle,
            access: u32,
            inherit: i32,
            options: u32,
        ) -> i32;
    }
    let mut info: Startup = unsafe { std::mem::zeroed() };
    unsafe {
        GetStartupInfoW(&mut info);
    }
    // libuv supplies the CRT descriptor table through STARTUPINFO.reserved2:
    // count:u32, flags[count], HANDLE[count]. Admit exactly the four pipes the
    // owned client declares; do not call CRT invalid-parameter handlers for an
    // absent fd or close an original handle owned by the CRT.
    let size = std::mem::size_of::<usize>();
    if info.reserved_bytes.is_null()
        || info.reserved_size as usize != 4 + 4 + 4 * size
        || info.flags & 0x100 == 0
    {
        return Err(());
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(info.reserved_bytes, info.reserved_size as usize) };
    if u32::from_le_bytes(bytes[..4].try_into().unwrap()) != 4 || bytes[7] & 9 != 9 {
        return Err(());
    }
    let start = 8 + 3 * size;
    let raw = usize::from_ne_bytes(bytes[start..start + size].try_into().unwrap());
    if raw == 0 || raw == usize::MAX || raw == usize::MAX - 1 {
        return Err(());
    }
    let handle = raw as Handle;
    if [info.input, info.output, info.error].contains(&handle)
        || unsafe { GetFileType(handle) } != 3
    {
        return Err(());
    }
    let mut duplicate = std::ptr::null_mut();
    let process = unsafe { GetCurrentProcess() };
    if unsafe { DuplicateHandle(process, handle, process, &mut duplicate, 0, 0, 2) } == 0 {
        return Err(());
    }
    Ok(Box::new(unsafe { File::from_raw_handle(duplicate) }))
}

#[cfg(not(any(unix, windows)))]
fn inherited() -> Result<Box<dyn Read + Send>, ()> {
    Err(())
}

fn terminate_self() {
    #[cfg(unix)]
    {
        extern "C" {
            fn _exit(code: i32) -> !;
        }
        unsafe {
            _exit(1);
        }
    }
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        #[link(name = "kernel32")]
        extern "system" {
            fn GetCurrentProcess() -> *mut c_void;
            fn TerminateProcess(process: *mut c_void, code: u32) -> i32;
        }
        unsafe {
            TerminateProcess(GetCurrentProcess(), 1);
        }
    }
    #[cfg(not(unix))]
    std::process::abort();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Cursor};
    #[test]
    fn empty_data_and_reader_failure_revoke_once_without_returning_input() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(ErrorKind::Other.into())
            }
        }
        for reader in [
            Box::new(Cursor::new(Vec::new())) as Box<dyn Read>,
            Box::new(Cursor::new(b"PRIVATE".to_vec())),
            Box::new(Broken),
        ] {
            let mut calls = 0;
            watch(reader, || calls += 1);
            assert_eq!(calls, 1);
        }
    }
    #[test]
    fn interrupted_read_is_rechecked_before_ownership_loss() {
        struct Interrupted(bool);
        impl Read for Interrupted {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                if !self.0 {
                    self.0 = true;
                    Err(ErrorKind::Interrupted.into())
                } else {
                    Ok(0)
                }
            }
        }
        let mut calls = 0;
        watch(Interrupted(false), || calls += 1);
        assert_eq!(calls, 1);
    }
}
