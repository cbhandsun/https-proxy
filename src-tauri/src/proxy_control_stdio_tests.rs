#[cfg(windows)]
mod windows {
    use super::super::proxy_control_stdio::{platform::seal, require_sealed};
    use std::ffi::c_void;
    type Handle = *mut c_void;

    #[repr(C)]
    struct SecurityAttributes {
        length: u32,
        descriptor: Handle,
        inherit: i32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreatePipe(
            read: *mut Handle,
            write: *mut Handle,
            attributes: *mut SecurityAttributes,
            size: u32,
        ) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
        fn GetHandleInformation(handle: Handle, flags: *mut u32) -> i32;
        fn WriteFile(
            handle: Handle,
            buffer: *const c_void,
            length: u32,
            written: *mut u32,
            overlapped: Handle,
        ) -> i32;
        fn ReadFile(
            handle: Handle,
            buffer: *mut c_void,
            length: u32,
            read: *mut u32,
            overlapped: Handle,
        ) -> i32;
    }
    struct OwnedHandle(Handle);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    #[test]
    fn sealing_owned_inheritable_pipe_handles_preserves_actual_io() {
        let mut read = std::ptr::null_mut();
        let mut write = std::ptr::null_mut();
        let mut attributes = SecurityAttributes {
            length: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor: std::ptr::null_mut(),
            inherit: 1,
        };
        assert_ne!(
            unsafe { CreatePipe(&mut read, &mut write, &mut attributes, 0) },
            0
        );
        let read = OwnedHandle(read);
        let write = OwnedHandle(write);
        for handle in [read.0, write.0] {
            let mut flags = 0;
            assert_ne!(unsafe { GetHandleInformation(handle, &mut flags) }, 0);
            assert_ne!(flags & 1, 0);
            seal(handle).unwrap();
            assert_ne!(unsafe { GetHandleInformation(handle, &mut flags) }, 0);
            assert_eq!(flags & 1, 0);
        }
        let mut count = 0;
        assert_ne!(
            unsafe {
                WriteFile(
                    write.0,
                    b"x".as_ptr().cast(),
                    1,
                    &mut count,
                    std::ptr::null_mut(),
                )
            },
            0
        );
        assert_eq!(count, 1);
        let mut byte = [0u8];
        assert_ne!(
            unsafe {
                ReadFile(
                    read.0,
                    byte.as_mut_ptr().cast(),
                    1,
                    &mut count,
                    std::ptr::null_mut(),
                )
            },
            0
        );
        assert_eq!((count, byte), (1, [b'x']));
        assert_eq!(
            seal(std::ptr::null_mut()),
            Err("proxy_control_stdio_failed")
        );
        assert_eq!(seal((-1isize) as Handle), Err("proxy_control_stdio_failed"));
    }
    #[test]
    fn update_or_inspection_failure_never_qualifies_sealed_handles() {
        assert!(require_sealed(|| false, || panic!("inspection after failed update")).is_err());
        for flags in [None, Some(1), Some(u32::MAX)] {
            assert!(require_sealed(|| true, || flags).is_err());
        }
        for flags in [0, 2, u32::MAX - 1] {
            assert!(require_sealed(|| true, || Some(flags)).is_ok());
        }
    }
}

#[cfg(not(windows))]
#[test]
fn other_platforms_keep_the_existing_standard_stream_behavior() {
    assert_eq!(super::proxy_control_stdio::isolate_control_stdio(), Ok(()));
}
