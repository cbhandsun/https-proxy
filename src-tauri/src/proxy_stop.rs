use super::proxy_stop_process::ObservedProcess;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::Path;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StopIdentity {
    pid: u32,
    instance_id: String,
}

impl StopIdentity {
    fn parse(health: &serde_json::Value) -> Result<Self, String> {
        let target: Self = serde_json::from_value(
            health
                .get("shutdown")
                .cloned()
                .ok_or("proxy_stop_identity_missing")?,
        )
        .map_err(|_| "proxy_stop_identity_invalid")?;
        if target.pid == 0
            || target.pid == std::process::id()
            || health.get("pid").and_then(|v| v.as_u64()) != Some(u64::from(target.pid))
            || target.instance_id.len() != 32
            || !target
                .instance_id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("proxy_stop_identity_invalid".into());
        }
        Ok(target)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Accepted {
    accepted: bool,
    pid: u32,
    instance_id: String,
}

fn verify_response(response: &[u8], target: &StopIdentity) -> Result<(), String> {
    if response.len() > 4096 {
        return Err("proxy_stop_response_invalid".into());
    }
    let text = std::str::from_utf8(response).map_err(|_| "proxy_stop_response_invalid")?;
    let (headers, body) = text
        .split_once("\r\n\r\n")
        .ok_or("proxy_stop_response_invalid")?;
    let mut lines = headers.split("\r\n");
    if lines.next() != Some("HTTP/1.1 202 Accepted") {
        return Err("proxy_stop_not_accepted".into());
    }
    let mut length = None;
    for line in lines {
        let (name, value) = line.split_once(':').ok_or("proxy_stop_response_invalid")?;
        if name.is_empty()
            || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || !value
                .bytes()
                .all(|b| b == b'\t' || (0x20..=0x7e).contains(&b))
        {
            return Err("proxy_stop_response_invalid".into());
        }
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err("proxy_stop_response_invalid".into());
        }
        if name.eq_ignore_ascii_case("content-length") {
            if length.is_some() {
                return Err("proxy_stop_response_invalid".into());
            }
            let value = value.trim_matches([' ', '\t']);
            if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                return Err("proxy_stop_response_invalid".into());
            }
            length = Some(
                value
                    .parse::<usize>()
                    .map_err(|_| "proxy_stop_response_invalid")?,
            );
        }
    }
    if length != Some(body.len()) {
        return Err("proxy_stop_response_invalid".into());
    }
    let receipt: Accepted =
        serde_json::from_str(body).map_err(|_| "proxy_stop_response_invalid")?;
    if !receipt.accepted || receipt.pid != target.pid || receipt.instance_id != target.instance_id {
        return Err("proxy_stop_target_changed".into());
    }
    Ok(())
}

fn request_stop(
    port: u16,
    token: &str,
    target: &StopIdentity,
    timeout: Duration,
) -> Result<(), String> {
    if port == 0
        || token.is_empty()
        || token.len() > 4096
        || !token.bytes().all(|b| (0x21..=0x7e).contains(&b))
    {
        return Err("proxy_stop_credentials_invalid".into());
    }
    let deadline = Instant::now() + timeout;
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream =
        TcpStream::connect_timeout(&address, timeout).map_err(|_| "proxy_stop_connect_failed")?;
    let body = serde_json::to_string(target).map_err(|_| "proxy_stop_request_invalid")?;
    let request = format!("POST /v1/local/runtime/stop HTTP/1.1\r\nHost: 127.0.0.1\r\nx-mgmt-token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    stream
        .set_write_timeout(Some(
            deadline
                .checked_duration_since(Instant::now())
                .ok_or("proxy_stop_deadline")?,
        ))
        .map_err(|_| "proxy_stop_io_failed")?;
    stream
        .write_all(request.as_bytes())
        .map_err(|_| "proxy_stop_io_failed")?;
    let mut response = Vec::new();
    loop {
        stream
            .set_read_timeout(Some(
                deadline
                    .checked_duration_since(Instant::now())
                    .ok_or("proxy_stop_deadline")?,
            ))
            .map_err(|_| "proxy_stop_io_failed")?;
        let mut buffer = [0; 512];
        let read = stream
            .read(&mut buffer)
            .map_err(|_| "proxy_stop_io_failed")?;
        if read == 0 {
            break;
        }
        if response.len() + read > 4096 {
            return Err("proxy_stop_response_invalid".into());
        }
        response.extend_from_slice(&buffer[..read]);
    }
    verify_response(&response, target)
}

pub(crate) fn stop_proxy(root: &Path, port: u16) -> Result<serde_json::Value, String> {
    if port == 0
        || !std::fs::metadata(root)
            .map_err(|_| "proxy_stop_owner_unconfirmed")?
            .is_dir()
    {
        return Err("proxy_stop_owner_unconfirmed".into());
    }
    let Some(health) = super::read_proxy_health_direct_on_port(port, Duration::from_millis(300))
    else {
        let runtime = super::proxy_root::proxy_runtime_dir(root);
        let present = match std::fs::symlink_metadata(&runtime) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                match std::fs::symlink_metadata(runtime.join(".proxy.pid")) {
                    Ok(_) => true,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                    Err(_) => return Err("proxy_stop_owner_unconfirmed".into()),
                }
            }
            Ok(_) => return Err("proxy_stop_owner_unconfirmed".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => return Err("proxy_stop_owner_unconfirmed".into()),
        };
        if present {
            return Err("proxy_stop_owner_unconfirmed".into());
        }
        return Ok(
            serde_json::json!({"code":0,"timedOut":false,"direct":true,"output":"Proxy is not running.\n"}),
        );
    };
    if !super::proxy_process::proxy_health_matches_root(&health, root) {
        return Err("proxy_stop_owner_mismatch".into());
    }
    let identity = StopIdentity::parse(&health)?;
    let observed = ObservedProcess::open(identity.pid)?;
    let token = super::find_management_token_for_port(root, port, Duration::from_millis(500))
        .ok_or("proxy_stop_credentials_unavailable")?;
    request_stop(port, &token, &identity, Duration::from_secs(3))?;
    // The original four-second stop observation deadline is retained. Failure
    // is reported, never converted into taskkill or a batch-file fallback.
    observed.wait_success(Duration::from_secs(4))?;
    Ok(
        serde_json::json!({"code":0,"timedOut":false,"direct":true,"gracefulDrain":true,"output":"Proxy stopped after draining owned resources.\n"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    fn target() -> StopIdentity {
        StopIdentity {
            pid: if std::process::id() == 1 { 2 } else { 1 },
            instance_id: "a".repeat(32),
        }
    }
    fn response(body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 202 Accepted\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }
    fn accepted() -> String {
        format!(
            "{{\"accepted\":true,\"pid\":{},\"instanceId\":\"{}\"}}",
            target().pid,
            target().instance_id
        )
    }

    #[test]
    fn identity_rejects_invalid_missing_extreme_and_stale_targets() {
        let valid = serde_json::json!({"pid":target().pid,"shutdown":target()});
        assert_eq!(StopIdentity::parse(&valid).unwrap(), target());
        for value in [
            serde_json::Value::Null,
            serde_json::json!({}),
            serde_json::json!({"pid":target().pid}),
            serde_json::json!({"pid":0,"shutdown":target()}),
            serde_json::json!({"pid":target().pid,"shutdown":null}),
        ] {
            assert!(StopIdentity::parse(&value).is_err());
        }
        for pid in [
            serde_json::json!(0),
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!(4294967296u64),
            serde_json::json!(std::process::id()),
            serde_json::json!("1"),
        ] {
            assert!(StopIdentity::parse(
                &serde_json::json!({"pid":pid,"shutdown":{"pid":pid,"instanceId":"a".repeat(32)}})
            )
            .is_err());
        }
        for instance_id in ["", "a", &"A".repeat(32), &"0".repeat(33), &"f".repeat(4096)] {
            assert!(StopIdentity::parse(&serde_json::json!({"pid":target().pid,"shutdown":{"pid":target().pid,"instanceId":instance_id}})).is_err());
        }
        assert!(StopIdentity::parse(&serde_json::json!({"pid":target().pid,"shutdown":{"pid":target().pid,"instanceId":"a".repeat(32),"extra":true}})).is_err());
    }
    #[test]
    fn accepted_intent_requires_exact_target_length_framing_and_fields() {
        let good = response(&accepted());
        assert!(verify_response(&good, &target()).is_ok());
        for body in [
            "".to_string(),
            "null".into(),
            "{}".into(),
            "[]".into(),
            accepted().replace("true", "false"),
            accepted().replace(&"a".repeat(32), &"b".repeat(32)),
            accepted().replace("\"accepted\":true", "\"accepted\":true,\"accepted\":true"),
            accepted().replace("\"accepted\":true", "\"accepted\":true,\"extra\":1"),
        ] {
            assert!(verify_response(&response(&body), &target()).is_err());
        }
        let text = String::from_utf8(good.clone()).unwrap();
        for invalid in [
            vec![],
            vec![0xff],
            text.replace("202 Accepted", "200 OK").into_bytes(),
            text.replace("Content-Length:", "Transfer-Encoding:")
                .into_bytes(),
            text.replace("Content-Length:", "Content-Length: 0\r\nContent-Length:")
                .into_bytes(),
            [good.clone(), b"private".to_vec()].concat(),
        ] {
            assert!(verify_response(&invalid, &target()).is_err());
        }
        let different = StopIdentity {
            pid: target().pid + 1,
            ..target()
        };
        assert!(verify_response(&good, &different).is_err());
        for invalid in [
            vec![b' '; 4097],
            text.replace("Content-Length:", "Content-Length: +")
                .into_bytes(),
            text.replace("Content-Length:", "Bad Header: x\r\nContent-Length:")
                .into_bytes(),
            text.replace("Content-Length:", "X-Test: bad\nvalue\r\nContent-Length:")
                .into_bytes(),
        ] {
            assert!(verify_response(&invalid, &target()).is_err());
        }
    }
    #[test]
    fn stop_transport_uses_only_loopback_fixed_path_auth_and_exact_body() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let expected = serde_json::to_string(&target()).unwrap();
            let mut request = Vec::new();
            loop {
                let mut bytes = [0; 512];
                let count = stream.read(&mut bytes).unwrap();
                assert!(count > 0 && request.len() + count < 8192);
                request.extend_from_slice(&bytes[..count]);
                if request.ends_with(expected.as_bytes()) {
                    break;
                }
            }
            let request = String::from_utf8(request).unwrap();
            assert!(
                request.starts_with("POST /v1/local/runtime/stop HTTP/1.1\r\nHost: 127.0.0.1\r\n")
            );
            assert!(request.contains("\r\nx-mgmt-token: synthetic-token\r\n"));
            assert!(request.contains("\r\nContent-Type: application/json\r\n"));
            stream.write_all(&response(&accepted())).unwrap();
        });
        request_stop(port, "synthetic-token", &target(), Duration::from_secs(3)).unwrap();
        server.join().unwrap();
        for token in [
            "",
            "bad\r\nInjected: yes",
            "bad\0value",
            "密钥",
            &"x".repeat(4097),
        ] {
            assert_eq!(
                request_stop(port, token, &target(), Duration::from_secs(3)).unwrap_err(),
                "proxy_stop_credentials_invalid"
            );
        }
        assert!(request_stop(0, "synthetic-token", &target(), Duration::from_secs(3)).is_err());
    }
    #[test]
    fn owned_transport_stall_obeys_deadline_without_retries() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(150));
        });
        assert!(request_stop(
            port,
            "synthetic-token",
            &target(),
            Duration::from_millis(30)
        )
        .is_err());
        server.join().unwrap();
    }
    #[test]
    fn stopped_status_requires_a_valid_root_port_and_no_unconfirmed_pid() {
        let root = std::env::temp_dir().join(format!(
            "hpm-stop-admission-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(stop_proxy(&root, 0).is_err());
        assert_eq!(stop_proxy(&root, port).unwrap()["code"], 0);
        let runtime = root.join(".hpm-runtime");
        std::fs::write(&runtime, b"not a directory").unwrap();
        assert!(stop_proxy(&root, port).is_err());
        std::fs::remove_file(&runtime).unwrap();
        std::fs::create_dir(&runtime).unwrap();
        std::fs::write(runtime.join(".proxy.pid"), b"1234").unwrap();
        assert!(stop_proxy(&root, port).is_err());
        let invalid = root.join("file");
        std::fs::write(&invalid, b"not a root").unwrap();
        assert!(stop_proxy(&invalid, port).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
