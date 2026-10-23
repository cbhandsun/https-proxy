use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use std::io::{Read, Write};

pub mod anchor;
pub mod private_path;

const MAX_INPUT: u64 = 17000;
const MAX_VALUE: usize = 16384;
const ENTROPY: &[u8] = b"hpm/context-recovery/data-key/v1";

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Operation {
    Protect,
    Unprotect,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    operation: Operation,
    value: String,
}

fn parse(input: &[u8]) -> Result<(Operation, Vec<u8>), ()> {
    if input.len() as u64 > MAX_INPUT {
        return Err(());
    }
    let request: Request = serde_json::from_slice(input).map_err(|_| ())?;
    if request.value.len() > MAX_VALUE {
        return Err(());
    }
    let bytes = STANDARD.decode(&request.value).map_err(|_| ())?;
    if STANDARD.encode(&bytes) != request.value || bytes.len() < 32 {
        return Err(());
    }
    if matches!(request.operation, Operation::Protect) && bytes.len() != 32 {
        return Err(());
    }
    Ok((request.operation, bytes))
}

// Volatile writes keep explicit cleanup observable to the optimizer. This is
// best effort and does not claim that allocators/OS copies are fully erased.
fn erase(bytes: &mut [u8]) {
    for byte in bytes {
        unsafe {
            std::ptr::write_volatile(byte, 0);
        }
    }
}

#[cfg(windows)]
#[repr(C)]
struct Blob {
    len: u32,
    data: *mut u8,
}

#[cfg(windows)]
#[link(name = "crypt32")]
extern "system" {
    fn CryptProtectData(
        input: *mut Blob,
        description: *const u16,
        entropy: *mut Blob,
        reserved: *mut std::ffi::c_void,
        prompt: *mut std::ffi::c_void,
        flags: u32,
        output: *mut Blob,
    ) -> i32;
    fn CryptUnprotectData(
        input: *mut Blob,
        description: *mut *mut u16,
        entropy: *mut Blob,
        reserved: *mut std::ffi::c_void,
        prompt: *mut std::ffi::c_void,
        flags: u32,
        output: *mut Blob,
    ) -> i32;
}
#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
}

#[cfg(windows)]
fn crypt(protect: bool, bytes: &mut [u8]) -> Result<Vec<u8>, ()> {
    let mut input = Blob {
        len: u32::try_from(bytes.len()).map_err(|_| ())?,
        data: bytes.as_mut_ptr(),
    };
    let mut entropy_bytes = ENTROPY.to_vec();
    let mut entropy = Blob {
        len: entropy_bytes.len() as u32,
        data: entropy_bytes.as_mut_ptr(),
    };
    let mut output = Blob {
        len: 0,
        data: std::ptr::null_mut(),
    };
    // CRYPTPROTECT_UI_FORBIDDEN, CurrentUser (never LOCAL_MACHINE).
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &mut input,
                std::ptr::null(),
                &mut entropy,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &mut input,
                std::ptr::null_mut(),
                &mut entropy,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        }
    };
    let result = if ok != 0
        && !output.data.is_null()
        && output.len > 0
        && output.len as usize <= MAX_VALUE
    {
        Ok(unsafe { std::slice::from_raw_parts(output.data, output.len as usize) }.to_vec())
    } else {
        Err(())
    };
    if !output.data.is_null() {
        // Output is allocated by DPAPI; zero before returning it to LocalFree.
        unsafe {
            erase(std::slice::from_raw_parts_mut(
                output.data,
                output.len as usize,
            ));
            LocalFree(output.data.cast());
        }
    }
    result
}

#[cfg(not(windows))]
fn crypt(_protect: bool, _bytes: &mut [u8]) -> Result<Vec<u8>, ()> {
    let _ = ENTROPY;
    Err(())
}

fn process(input: &[u8]) -> Result<String, ()> {
    let (operation, mut bytes) = parse(input)?;
    let result = (|| match operation {
        Operation::Protect => {
            let mut wrapped = crypt(true, &mut bytes)?;
            let check = crypt(false, &mut wrapped);
            let valid = match check {
                Ok(mut value) => {
                    let equal = value == bytes;
                    erase(&mut value);
                    equal
                }
                Err(()) => false,
            };
            let result =
                if valid && wrapped.len() >= 32 && STANDARD.encode(&wrapped).len() <= MAX_VALUE {
                    Ok(STANDARD.encode(&wrapped))
                } else {
                    Err(())
                };
            erase(&mut wrapped);
            result
        }
        Operation::Unprotect => {
            let mut value = crypt(false, &mut bytes)?;
            let result = if value.len() == 32 {
                Ok(STANDARD.encode(&value))
            } else {
                Err(())
            };
            erase(&mut value);
            result
        }
    })();
    erase(&mut bytes);
    result
}

pub fn run<R: Read, W: Write>(valid_args: bool, reader: R, mut writer: W) -> bool {
    let mut input = Vec::new();
    let result = if valid_args && reader.take(MAX_INPUT + 1).read_to_end(&mut input).is_ok() {
        process(&input)
    } else {
        Err(())
    };
    erase(&mut input);
    let success = result.is_ok();
    let mut output = match result {
        Ok(value) => serde_json::json!({"ok":true,"value":value})
            .to_string()
            .into_bytes(),
        Err(()) => b"{\"ok\":false}".to_vec(),
    };
    let written = writer.write_all(&output).is_ok();
    erase(&mut output);
    success && written
}

#[cfg(test)]
mod tests {
    use super::*;
    struct BrokenRead;
    impl Read for BrokenRead {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("private"))
        }
    }
    struct BrokenWrite;
    impl Write for BrokenWrite {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("private"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    #[test]
    fn stream_failures_and_bad_args_emit_only_fixed_failure() {
        for valid in [false, true] {
            let mut output = Vec::new();
            assert!(!run(valid, BrokenRead, &mut output));
            assert_eq!(output, b"{\"ok\":false}");
        }
        assert!(!run(true, b"null".as_slice(), BrokenWrite));
        let mut output = Vec::new();
        assert!(!run(
            true,
            vec![b' '; MAX_INPUT as usize + 1].as_slice(),
            &mut output
        ));
        assert_eq!(output, b"{\"ok\":false}");
    }
    #[test]
    fn rejects_invalid_empty_duplicate_extra_and_extreme_inputs() {
        for input in [
            b"".as_slice(),
            b"null",
            b"[]",
            b"{}",
            b"{\"operation\":\"invalid\",\"value\":\"AA==\"}",
            b"{\"operation\":\"protect\",\"value\":\"\"}",
        ] {
            assert!(parse(input).is_err());
        }
        let value = STANDARD.encode([7; 32]);
        for input in [
            format!("{{\"operation\":\"protect\",\"value\":\"{value}\",\"extra\":1}}"),
            format!(
                "{{\"operation\":\"protect\",\"operation\":\"protect\",\"value\":\"{value}\"}}"
            ),
            format!("{{\"operation\":\"protect\",\"value\":\"{value}\",\"value\":\"{value}\"}}"),
        ] {
            assert!(parse(input.as_bytes()).is_err());
        }
        assert!(parse(&vec![b' '; MAX_INPUT as usize + 1]).is_err());
        for count in [0, 31, 33, 64] {
            let input =
                serde_json::json!({"operation":"protect","value":STANDARD.encode(vec![0;count])})
                    .to_string();
            assert!(parse(input.as_bytes()).is_err());
        }
    }
    #[test]
    #[cfg(windows)]
    fn current_user_roundtrip_and_corruption_are_checked() {
        let value = STANDARD.encode([9; 32]);
        let wrapped = process(
            serde_json::json!({"operation":"protect","value":value})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
        assert_eq!(
            process(
                serde_json::json!({"operation":"unprotect","value":wrapped})
                    .to_string()
                    .as_bytes()
            )
            .unwrap(),
            value
        );
        let mut corrupted = STANDARD.decode(wrapped).unwrap();
        let last = corrupted.len() - 1;
        corrupted[last] ^= 1;
        assert!(process(
            serde_json::json!({"operation":"unprotect","value":STANDARD.encode(corrupted)})
                .to_string()
                .as_bytes()
        )
        .is_err());
    }
}
