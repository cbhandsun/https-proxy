use std::io::{Read, Write};

const HELPER_FLAG: &str = "--hpm-dpapi-unprotect-stdin";
const MAX_INPUT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ITEMS: usize = 64;
const MAX_PROTECTED_ITEM_BYTES: usize = 256 * 1024;

#[cfg(windows)]
#[repr(C)]
struct DataBlob {
    cb_data: u32,
    pb_data: *mut u8,
}

#[cfg(windows)]
#[link(name = "crypt32")]
extern "system" {
    fn CryptUnprotectData(
        data_in: *mut DataBlob,
        description: *mut *mut u16,
        optional_entropy: *mut DataBlob,
        reserved: *mut std::ffi::c_void,
        prompt: *mut std::ffi::c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
}

#[cfg(windows)]
fn unprotect_item(encoded: &str) -> Option<String> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;

    let mut encrypted = STANDARD.decode(encoded).ok()?;
    if encrypted.is_empty() || encrypted.len() > MAX_PROTECTED_ITEM_BYTES {
        return None;
    }
    let mut input = DataBlob {
        cb_data: u32::try_from(encrypted.len()).ok()?,
        pb_data: encrypted.as_mut_ptr(),
    };
    let mut output = DataBlob {
        cb_data: 0,
        pb_data: std::ptr::null_mut(),
    };
    let mut description = std::ptr::null_mut();
    let ok = unsafe {
        CryptUnprotectData(
            &mut input,
            &mut description,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0x1,
            &mut output,
        )
    };
    if !description.is_null() {
        unsafe {
            LocalFree(description.cast());
        }
    }
    if ok == 0 || output.pb_data.is_null() || output.cb_data == 0 {
        if !output.pb_data.is_null() {
            unsafe {
                LocalFree(output.pb_data.cast());
            }
        }
        return None;
    }
    let plaintext =
        unsafe { std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec() };
    unsafe {
        LocalFree(output.pb_data.cast());
    }
    Some(STANDARD.encode(plaintext))
}

#[cfg(not(windows))]
fn unprotect_item(_encoded: &str) -> Option<String> {
    None
}

fn process_payload(input: &[u8]) -> Result<Vec<Option<String>>, ()> {
    if input.len() as u64 > MAX_INPUT_BYTES {
        return Err(());
    }
    let items: Vec<String> = serde_json::from_slice(input).map_err(|_| ())?;
    if items.is_empty() || items.len() > MAX_ITEMS {
        return Err(());
    }
    Ok(items.iter().map(|item| unprotect_item(item)).collect())
}

pub fn run_from_process_args() -> bool {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if args.len() != 2 || args[1] != HELPER_FLAG {
        return false;
    }

    let mut input = Vec::new();
    let read_ok = std::io::stdin()
        .take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut input)
        .is_ok();
    let response = if read_ok {
        process_payload(&input)
            .ok()
            .map(|values| serde_json::json!({ "values": values }))
    } else {
        None
    };
    let output = response.unwrap_or_else(|| serde_json::json!({ "values": [] }));
    let _ = std::io::stdout().write_all(output.to_string().as_bytes());
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_or_unbounded_payloads() {
        assert!(process_payload(b"not-json").is_err());
        assert!(process_payload(b"[]").is_err());
        let too_many = serde_json::to_vec(&vec!["AA=="; MAX_ITEMS + 1]).unwrap();
        assert!(process_payload(&too_many).is_err());
    }
}
