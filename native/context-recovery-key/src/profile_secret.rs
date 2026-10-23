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

const MAX_BATCH_INPUT: u64 = 1500000;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchRequest {
    operation: String,
    values: Vec<String>,
}

fn parse_batch(input: &[u8]) -> Result<Vec<Vec<u8>>, ()> {
    if input.len() as u64 > MAX_BATCH_INPUT {
        return Err(());
    }
    let request: BatchRequest = serde_json::from_slice(input).map_err(|_| ())?;
    if request.operation != "unprotect" || request.values.is_empty() || request.values.len() > 64 {
        return Err(());
    }
    request
        .values
        .into_iter()
        .map(|value| {
            if value.len() > 22000 {
                return Err(());
            }
            let bytes = STANDARD.decode(&value).map_err(|_| ())?;
            if bytes.len() < 32 || bytes.len() > MAX_WRAPPED || STANDARD.encode(&bytes) != value {
                return Err(());
            }
            Ok(bytes)
        })
        .collect()
}

fn unprotect_batch_with<F>(input: &[u8], mut decrypt: F) -> Result<Vec<String>, ()>
where
    F: FnMut(&mut [u8]) -> Result<Vec<u8>, ()>,
{
    let mut wrapped = parse_batch(input)?;
    let mut values = Vec::new();
    let result = (|| {
        for value in &mut wrapped {
            let mut plain = decrypt(value)?;
            let valid = !plain.is_empty() && plain.len() <= MAX_WRAPPED && plain.len() % 2 == 0;
            if valid {
                values.push(STANDARD.encode(&plain));
            }
            super::erase(&mut plain);
            if !valid {
                return Err(());
            }
        }
        Ok(())
    })();
    for value in &mut wrapped {
        super::erase(value);
    }
    if result.is_err() {
        erase_values(values);
        Err(())
    } else {
        Ok(values)
    }
}

fn erase_values(values: Vec<String>) {
    for value in values {
        super::erase(&mut value.into_bytes());
    }
}

pub fn run_unprotect<R: Read, W: Write>(reader: R, mut writer: W) -> bool {
    let mut input = Vec::new();
    let result = if reader
        .take(MAX_BATCH_INPUT + 1)
        .read_to_end(&mut input)
        .is_ok()
    {
        unprotect_batch_with(&input, |value| crypt(false, value))
    } else {
        Err(())
    };
    super::erase(&mut input);
    let success = result.is_ok();
    let mut output = match result {
        Ok(values) => {
            let output = serde_json::json!({"ok":true,"values":&values})
                .to_string()
                .into_bytes();
            erase_values(values);
            output
        }
        Err(()) => b"{\"ok\":false}".to_vec(),
    };
    let written = writer.write_all(&output).is_ok();
    super::erase(&mut output);
    success && written
}

#[cfg(test)]
mod tests {
    use super::*;
    fn batch_request(values: Vec<Vec<u8>>) -> Vec<u8> {
        serde_json::json!({"operation":"unprotect","values":values.iter().map(|value| STANDARD.encode(value)).collect::<Vec<_>>()}).to_string().into_bytes()
    }
    #[test]
    fn parse_batch_rejects_malformed_empty_extreme_duplicate_and_unknown_inputs() {
        for input in [
            b"null".to_vec(),
            b"[]".to_vec(),
            b"{}".to_vec(),
            b"{\"operation\":\"unprotect\",\"values\":[\"!!!\"]}".to_vec(),
            b"{\"operation\":\"unprotect\",\"values\":[],\"extra\":true}".to_vec(),
            b"{\"operation\":\"unprotect\",\"operation\":\"unprotect\",\"values\":[]}".to_vec(),
            batch_request(vec![]),
            batch_request(vec![vec![0; 32]; 65]),
            batch_request(vec![vec![0; 31]]),
            batch_request(vec![vec![0; MAX_WRAPPED + 1]]),
            vec![b' '; MAX_BATCH_INPUT as usize + 1],
            request(&[1, 0]),
        ] {
            assert!(parse_batch(&input).is_err());
        }
        assert_eq!(
            parse_batch(&batch_request(vec![vec![1; MAX_WRAPPED]; 64]))
                .unwrap()
                .len(),
            64
        );
    }
    #[test]
    fn parse_batch_decryption_is_ordered_bounded_and_all_or_nothing() {
        let input = batch_request(vec![vec![1; 32], vec![2; 32]]);
        let result = unprotect_batch_with(&input, |value| Ok(vec![value[0], 0])).unwrap();
        assert_eq!(
            result,
            vec![STANDARD.encode([1, 0]), STANDARD.encode([2, 0])]
        );
        for plain in [vec![], vec![1], vec![0; MAX_WRAPPED + 2]] {
            assert!(unprotect_batch_with(&input, |_| Ok(plain.clone())).is_err());
        }
        let mut calls = 0;
        assert!(unprotect_batch_with(&input, |_| {
            calls += 1;
            if calls == 2 {
                Err(())
            } else {
                Ok(vec![1, 0])
            }
        })
        .is_err());
        assert_eq!(calls, 2);
    }
    #[test]
    fn parse_batch_stream_failure_never_emits_partial_plaintext() {
        let mut output = Vec::new();
        assert!(!run_unprotect(
            b"PRIVATE_INVALID_PAYLOAD".as_slice(),
            &mut output
        ));
        assert_eq!(output, b"{\"ok\":false}");
    }
    #[test]
    #[cfg(windows)]
    fn current_user_batch_roundtrip_reads_existing_profile_ciphertext() {
        let mut plain: Vec<u8> = "profile-secret-🙂"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        let mut wrapped = crypt(true, &mut plain).unwrap();
        let request = batch_request(vec![wrapped.clone(), wrapped.clone()]);
        let values = unprotect_batch_with(&request, |value| crypt(false, value)).unwrap();
        assert_eq!(values, vec![STANDARD.encode(&plain); 2]);
        erase_values(values);
        super::super::erase(&mut plain);
        super::super::erase(&mut wrapped);
    }
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
