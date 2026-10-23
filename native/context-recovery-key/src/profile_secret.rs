use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use std::io::{Read, Write};

const MAX_INPUT: u64 = 20000;
const MAX_PLAIN: usize = 8192;
const MAX_WRAPPED: usize = 16384;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    operation: String,
    value: String,
}

fn parse(input: &[u8]) -> Result<Vec<u8>, ()> {
    if input.len() as u64 > MAX_INPUT {
        return Err(());
    }
    let request: Request = serde_json::from_slice(input).map_err(|_| ())?;
    if request.operation != "protect" || request.value.len() > MAX_PLAIN * 2 {
        return Err(());
    }
    let value = STANDARD.decode(&request.value).map_err(|_| ())?;
    if value.is_empty()
        || value.len() > MAX_PLAIN
        || value.len() % 2 != 0
        || STANDARD.encode(&value) != request.value
    {
        return Err(());
    }
    Ok(value)
}

#[cfg(windows)]
fn crypt(protect: bool, bytes: &mut [u8]) -> Result<Vec<u8>, ()> {
    // Profile credentials use the existing hpm-dpapi format: CurrentUser,
    // UI forbidden and no optional entropy. Context data keys remain separate.
    let mut input = super::Blob {
        len: u32::try_from(bytes.len()).map_err(|_| ())?,
        data: bytes.as_mut_ptr(),
    };
    let mut output = super::Blob {
        len: 0,
        data: std::ptr::null_mut(),
    };
    let ok = unsafe {
        if protect {
            super::CryptProtectData(
                &mut input,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        } else {
            super::CryptUnprotectData(
                &mut input,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
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
        && output.len as usize <= MAX_WRAPPED
    {
        Ok(unsafe { std::slice::from_raw_parts(output.data, output.len as usize) }.to_vec())
    } else {
        Err(())
    };
    if !output.data.is_null() {
        unsafe {
            super::erase(std::slice::from_raw_parts_mut(
                output.data,
                output.len as usize,
            ));
            super::LocalFree(output.data.cast());
        }
    }
    result
}

#[cfg(not(windows))]
fn crypt(_protect: bool, _bytes: &mut [u8]) -> Result<Vec<u8>, ()> {
    Err(())
}

fn process_with<F>(input: &[u8], mut crypto: F) -> Result<String, ()>
where
    F: FnMut(bool, &mut [u8]) -> Result<Vec<u8>, ()>,
{
    let mut plain = parse(input)?;
    let result = (|| {
        let mut wrapped = crypto(true, &mut plain)?;
        let result = (|| {
            if wrapped.len() < 32 || wrapped.len() > MAX_WRAPPED {
                return Err(());
            }
            let mut check = crypto(false, &mut wrapped)?;
            let matches = check == plain;
            super::erase(&mut check);
            if matches {
                Ok(STANDARD.encode(&wrapped))
            } else {
                Err(())
            }
        })();
        super::erase(&mut wrapped);
        result
    })();
    super::erase(&mut plain);
    result
}

pub fn run<R: Read, W: Write>(reader: R, mut writer: W) -> bool {
    let mut input = Vec::new();
    let result = if reader.take(MAX_INPUT + 1).read_to_end(&mut input).is_ok() {
        process_with(&input, crypt)
    } else {
        Err(())
    };
    super::erase(&mut input);
    let success = result.is_ok();
    let mut output = match result {
        Ok(value) => serde_json::json!({"ok":true,"value":value})
            .to_string()
            .into_bytes(),
        Err(()) => b"{\"ok\":false}".to_vec(),
    };
    let written = writer.write_all(&output).is_ok();
    super::erase(&mut output);
    success && written
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(value: &[u8]) -> Vec<u8> {
        serde_json::json!({"operation":"protect","value":STANDARD.encode(value)})
            .to_string()
            .into_bytes()
    }
    #[test]
    fn parse_rejects_empty_invalid_extreme_and_extra_fields() {
        for input in [
            b"null".to_vec(),
            b"[]".to_vec(),
            b"{}".to_vec(),
            b"{\"operation\":\"protect\",\"value\":\"!!!\"}".to_vec(),
            b"{\"operation\":\"unprotect\",\"value\":\"YWE=\"}".to_vec(),
            b"{\"operation\":\"protect\",\"value\":\"YWE=\",\"extra\":true}".to_vec(),
            b"{\"operation\":\"protect\",\"operation\":\"protect\",\"value\":\"YWE=\"}".to_vec(),
            request(&[]),
            request(&[1]),
            request(&vec![1; MAX_PLAIN + 2]),
            vec![b' '; MAX_INPUT as usize + 1],
        ] {
            assert!(parse(&input).is_err());
        }
        assert_eq!(
            parse(&request(&vec![7; MAX_PLAIN])).unwrap().len(),
            MAX_PLAIN
        );
    }
    #[test]
    fn parse_roundtrip_requires_matching_plaintext_and_bounded_ciphertext() {
        let plain = b"a\0b\0";
        for failure in [0, 1, 2, 3, 4] {
            let result = process_with(&request(plain), |protect, _| match (protect, failure) {
                (true, 0) => Err(()),
                (true, 1) => Ok(vec![1; 31]),
                (true, 2) => Ok(vec![1; MAX_WRAPPED + 1]),
                (true, _) => Ok(vec![1; 32]),
                (false, 3) => Err(()),
                (false, _) => Ok(b"wrong".to_vec()),
            });
            assert!(result.is_err());
        }
        assert!(process_with(&request(plain), |protect, _| Ok(if protect {
            vec![1; 32]
        } else {
            plain.to_vec()
        }))
        .is_ok());
    }
    #[test]
    fn parse_stream_rejection_emits_only_fixed_failure() {
        let mut output = Vec::new();
        assert!(!run(b"PRIVATE_INVALID_PAYLOAD".as_slice(), &mut output));
        assert_eq!(output, b"{\"ok\":false}");
    }
    #[test]
    #[cfg(windows)]
    fn current_user_roundtrip_preserves_unicode_legacy_bytes() {
        let plain: Vec<u8> = "profile-secret-🙂"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert!(process_with(&request(&plain), crypt).is_ok());
    }
}
