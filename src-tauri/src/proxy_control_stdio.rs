// Only the headless control entry calls this, before starting any background
// work. Keep its live pipes usable locally without lending them to descendants.
#[cfg(windows)]
const FAILURE: &str = "proxy_control_stdio_failed";

#[cfg(windows)]
pub(crate) fn require_sealed(
    update: impl FnOnce() -> bool,
    inspect: impl FnOnce() -> Option<u32>,
) -> Result<(), &'static str> {
    if !update() {
        return Err(FAILURE);
    }
    match inspect() {
        Some(flags) if flags & 1 == 0 => Ok(()),
        _ => Err(FAILURE),
    }
}

#[cfg(windows)]
pub(crate) mod platform {
    use super::*;
    use std::ffi::c_void;
    type Handle = *mut c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(kind: u32) -> Handle;
        fn SetHandleInformation(handle: Handle, mask: u32, flags: u32) -> i32;
        fn GetHandleInformation(handle: Handle, flags: *mut u32) -> i32;
    }
    pub(crate) fn seal(handle: Handle) -> Result<(), &'static str> {
        if handle.is_null() || handle as isize == -1 {
            return Err(FAILURE);
        }
        // Modify only HANDLE_FLAG_INHERIT. Do not close, replace or duplicate
        // the control stream, nor change any other handle attribute.
        require_sealed(
            || unsafe { SetHandleInformation(handle, 1, 0) } != 0,
            || {
                let mut flags = 0;
                (unsafe { GetHandleInformation(handle, &mut flags) } != 0).then_some(flags)
            },
        )
    }
    pub(super) fn isolate() -> Result<(), &'static str> {
        for kind in [-10i32, -11, -12] {
            seal(unsafe { GetStdHandle(kind as u32) })?;
        }
        Ok(())
    }
}

pub(crate) fn isolate_control_stdio() -> Result<(), &'static str> {
    #[cfg(windows)]
    return platform::isolate();
    #[cfg(not(windows))]
    Ok(())
}
