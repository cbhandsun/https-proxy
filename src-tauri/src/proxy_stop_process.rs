use std::time::Duration;

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::c_void;
    type Handle = *mut c_void;
    // https://learn.microsoft.com/windows/win32/procthread/process-security-and-access-rights
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const WAIT_TIMEOUT: u32 = 0x102;
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn GetExitCodeProcess(handle: Handle, code: *mut u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    pub(crate) struct ObservedProcess(Handle);
    impl ObservedProcess {
        pub(crate) fn open(pid: u32) -> Result<Self, String> {
            if pid == 0 || pid == std::process::id() {
                return Err("proxy_stop_process_invalid".into());
            }
            // Read and synchronize only. No termination, memory, duplication or
            // modification rights; keep this exact object across the HTTP call.
            let handle =
                unsafe { OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            if handle.is_null() {
                return Err("proxy_stop_process_unavailable".into());
            }
            let observed = Self(handle);
            if unsafe { WaitForSingleObject(handle, 0) } != WAIT_TIMEOUT {
                return Err("proxy_stop_process_not_running".into());
            }
            Ok(observed)
        }
        pub(crate) fn wait_success(&self, timeout: Duration) -> Result<(), String> {
            let millis =
                u32::try_from(timeout.as_millis()).map_err(|_| "proxy_stop_deadline_invalid")?;
            if millis == u32::MAX {
                return Err("proxy_stop_deadline_invalid".into());
            }
            if unsafe { WaitForSingleObject(self.0, millis) } != 0 {
                return Err("proxy_stop_drain_unconfirmed".into());
            }
            let mut code = 0;
            if unsafe { GetExitCodeProcess(self.0, &mut code) } == 0 || code != 0 {
                return Err("proxy_stop_drain_failed".into());
            }
            Ok(())
        }
    }
    impl Drop for ObservedProcess {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;
    pub(crate) struct ObservedProcess;
    impl ObservedProcess {
        pub(crate) fn open(_pid: u32) -> Result<Self, String> {
            Err("proxy_stop_platform_unsupported".into())
        }
        pub(crate) fn wait_success(&self, _timeout: Duration) -> Result<(), String> {
            Err("proxy_stop_platform_unsupported".into())
        }
    }
}
pub(crate) use platform::ObservedProcess;

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::process::{Child, Command, Stdio};
    struct Owned(Child);
    impl Drop for Owned {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    #[test]
    fn owned_child() {
        if std::env::var("HPM_TEST_STOP_OWNED_CHILD").as_deref() != Ok("pipe-controlled") {
            return;
        }
        let mut byte = [0];
        std::io::stdin().read_exact(&mut byte).unwrap();
        std::process::exit(if byte[0] == b's' { 0 } else { 1 });
    }
    #[test]
    fn observes_exact_owned_process_exit_and_never_turns_failure_into_success() {
        assert!(ObservedProcess::open(0).is_err());
        assert!(ObservedProcess::open(std::process::id()).is_err());
        for success in [true, false] {
            let mut child = Owned(
                Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "proxy_stop_process::tests::owned_child"])
                    .env("HPM_TEST_STOP_OWNED_CHILD", "pipe-controlled")
                    .stdin(Stdio::piped())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap(),
            );
            let observed = ObservedProcess::open(child.0.id()).unwrap();
            assert!(observed.wait_success(Duration::ZERO).is_err());
            assert!(observed
                .wait_success(Duration::from_millis(u64::from(u32::MAX)))
                .is_err());
            child
                .0
                .stdin
                .take()
                .unwrap()
                .write_all(if success { b"s" } else { b"f" })
                .unwrap();
            assert_eq!(
                observed.wait_success(Duration::from_secs(4)).is_ok(),
                success
            );
            assert_eq!(child.0.wait().unwrap().success(), success);
        }
    }
}
