use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;

fn chunked_body(input: &[u8]) -> Option<Vec<u8>> {
    let mut cursor = 0usize;
    let mut output = Vec::new();
    loop {
        let end = input.get(cursor..)?.windows(2).position(|b| b == b"\r\n")? + cursor;
        let line = input.get(cursor..end)?;
        if line.is_empty() || line.len() > 16 || !line.iter().all(u8::is_ascii_hexdigit) {
            return None;
        }
        let size = usize::from_str_radix(std::str::from_utf8(line).ok()?, 16).ok()?;
        cursor = end.checked_add(2)?;
        if size == 0 {
            return (input.get(cursor..) == Some(b"\r\n".as_slice())).then_some(output);
        }
        if size > MAX_RESPONSE_BYTES || output.len().checked_add(size)? > MAX_RESPONSE_BYTES {
            return None;
        }
        let end = cursor.checked_add(size)?;
        output.extend_from_slice(input.get(cursor..end)?);
        if input.get(end..end.checked_add(2)?)? != b"\r\n" {
            return None;
        }
        cursor = end + 2;
    }
}

fn decode_health(input: &[u8], app_id: &str) -> Option<serde_json::Value> {
    if input.len() > MAX_RESPONSE_BYTES {
        return None;
    }
    let end = input.windows(4).position(|b| b == b"\r\n\r\n")?;
    if end > MAX_HEADER_BYTES {
        return None;
    }
    let headers = std::str::from_utf8(&input[..end]).ok()?;
    let mut lines = headers.split("\r\n");
    let status = lines.next()?;
    let (version, rest) = status.split_once(' ')?;
    if !matches!(version, "HTTP/1.0" | "HTTP/1.1")
        || !(rest == "200" || rest.starts_with("200 "))
        || !rest.bytes().all(|b| (0x20..=0x7e).contains(&b))
    {
        return None;
    }
    let mut length = None;
    let mut chunked = false;
    let mut seen = std::collections::BTreeSet::new();
    for line in lines {
        let (name, value) = line.split_once(':')?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
            || !value
                .bytes()
                .all(|b| b == b'\t' || (0x20..=0x7e).contains(&b))
        {
            return None;
        }
        if !seen.insert(name.to_ascii_lowercase()) {
            return None;
        }
        let value = value.trim_matches([' ', '\t']);
        if name.eq_ignore_ascii_case("content-length") {
            if length.is_some() || value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            length = Some(value.parse::<usize>().ok()?);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            if chunked || !value.eq_ignore_ascii_case("chunked") {
                return None;
            }
            chunked = true;
        } else if name.eq_ignore_ascii_case("content-encoding")
            && !value.eq_ignore_ascii_case("identity")
        {
            return None;
        }
    }
    let wire = &input[end + 4..];
    let body = if chunked {
        if length.is_some() {
            return None;
        }
        chunked_body(wire)?
    } else {
        if length.is_some_and(|n| n != wire.len()) {
            return None;
        }
        wire.to_vec()
    };
    let json: serde_json::Value = serde_json::from_slice(&body).ok()?;
    (json.get("appId").and_then(|v| v.as_str()) == Some(app_id)).then_some(json)
}

// Fixed loopback health read. Decode HTTP framing before JSON; each operation
// shares the caller's original absolute deadline and a bounded response buffer.
pub(crate) fn read_proxy_health_direct_on_port(
    port: u16,
    timeout: Duration,
    app_id: &str,
) -> Option<serde_json::Value> {
    if port == 0 || timeout.is_zero() {
        return None;
    }
    let started = Instant::now();
    let remaining = || {
        timeout
            .checked_sub(started.elapsed())
            .filter(|d| !d.is_zero())
    };
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let mut stream = TcpStream::connect_timeout(&addr, remaining()?).ok()?;
    stream.set_write_timeout(Some(remaining()?)).ok()?;
    stream
        .write_all(b"GET /v1/local/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .ok()?;
    let mut response = Vec::new();
    let mut buffer = [0u8; 2048];
    loop {
        stream.set_read_timeout(Some(remaining()?)).ok()?;
        let read = stream.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        if response.len().checked_add(read)? > MAX_RESPONSE_BYTES {
            return None;
        }
        response.extend_from_slice(&buffer[..read]);
    }
    if started.elapsed() > timeout {
        return None;
    }
    decode_health(&response, app_id)
}

#[cfg(test)]
fn fixture_connection(listener: std::net::TcpListener) -> TcpStream {
    listener.set_nonblocking(true).unwrap();
    let until = Instant::now() + Duration::from_secs(1);
    let mut socket = loop {
        match listener.accept() {
            Ok((socket, _)) => break socket,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < until =>
            {
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(_) => panic!("owned health fixture connection failed"),
        }
    };
    socket
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    socket
        .set_write_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let mut request = Vec::new();
    while !request.ends_with(b"\r\n\r\n") {
        let mut buffer = [0; 128];
        let count = socket.read(&mut buffer).unwrap();
        assert!(count > 0 && request.len() + count <= 1024);
        request.extend_from_slice(&buffer[..count]);
    }
    assert_eq!(
        request,
        b"GET /v1/local/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    );
    socket
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;
    #[test]
    fn recognizes_the_chunked_health_reply_used_by_the_node_management_endpoint() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let writer = thread::spawn(move || {
            let mut socket = fixture_connection(listener);
            let body = br#"{"appId":"https-proxy-manager","pid":1}"#;
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n", body.len(), std::str::from_utf8(body).unwrap());
            socket.write_all(response.as_bytes()).unwrap();
        });
        let reply = read_proxy_health_direct_on_port(
            port,
            Duration::from_millis(300),
            "https-proxy-manager",
        );
        writer.join().unwrap();
        assert!(
            reply.is_some(),
            "valid Node chunk framing must be decoded before JSON parsing"
        );
    }
}

#[cfg(test)]
mod boundary_tests {
    use super::*;
    const APP: &str = "https-proxy-manager";
    fn body() -> &'static str {
        r#"{"appId":"https-proxy-manager","pid":1,"note":"原文 is only synthetic fixture data"}"#
    }
    fn length_reply(body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }
    #[test]
    fn accepts_exact_length_close_and_multi_chunk_utf8_without_modifying_json() {
        let expected: serde_json::Value = serde_json::from_str(body()).unwrap();
        assert_eq!(
            decode_health(&length_reply(body()), APP),
            Some(expected.clone())
        );
        assert_eq!(
            decode_health(
                format!("HTTP/1.0 200 OK\r\nConnection: close\r\n\r\n{}", body()).as_bytes(),
                APP
            ),
            Some(expected.clone())
        );
        let mut reply = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: Chunked\r\n\r\n".to_vec();
        for part in body().as_bytes().chunks(2) {
            reply.extend_from_slice(format!("{:x}\r\n", part.len()).as_bytes());
            reply.extend_from_slice(part);
            reply.extend_from_slice(b"\r\n");
        }
        reply.extend_from_slice(b"0\r\n\r\n");
        assert_eq!(decode_health(&reply, APP), Some(expected));
    }
    #[test]
    fn rejects_empty_illegal_identity_status_headers_and_ambiguous_framing() {
        for bytes in [
            b"".as_slice(),
            b"HTTP/1.1 200 OK\r\n\r\n",
            b"HTTP/1.1 200 OK\r\n\r\nnull",
            b"HTTP/1.1 200 OK\r\n\r\n[]",
            b"HTTP/1.1 200 OK\r\n\r\n{}",
        ] {
            assert!(decode_health(bytes, APP).is_none());
        }
        let response = String::from_utf8(length_reply(body())).unwrap();
        let length = body().len();
        for invalid in [
            response.replace("200 OK", "404 Missing"),
            response.replace("HTTP/1.1", "OTHER/1.1"),
            response.replace(APP, "unrelated-manager"),
            response.replace("Content-Length:", "Content-Length: 0\r\nContent-Length:"),
            response.replace(
                "Content-Length:",
                "Transfer-Encoding: chunked\r\nContent-Length:",
            ),
            response.replace("Content-Length:", "Content-Length: +"),
            response.replace(
                &format!("Content-Length: {length}"),
                "Content-Length: 99999999999999999999999999",
            ),
            response.replace("Content-Length:", "Bad Header: x\r\nContent-Length:"),
            response.replace("Content-Length:", "X-Test: bad\nfold\r\nContent-Length:"),
            response.replace(
                "Content-Length:",
                "Content-Encoding: gzip\r\nContent-Length:",
            ),
            format!("{response}trailing"),
        ] {
            assert!(decode_health(invalid.as_bytes(), APP).is_none());
        }
        let mut invalid = length_reply(body());
        invalid.pop();
        assert!(decode_health(&invalid, APP).is_none());
        assert!(decode_health(b"HTTP/1.1 200 OK\r\n\r\n\xff", APP).is_none());
    }
    #[test]
    fn rejects_truncated_overflow_duplicate_or_unterminated_chunks() {
        for wire in [
            "",
            "z\r\n{}\r\n0\r\n\r\n",
            "ffffffffffffffff\r\n",
            "10000000000000000\r\n",
            "0\r\n",
            "2\r\n{",
            "2\r\n{}XX0\r\n\r\n",
            "2\r\n{}\r\n0\r\n\r\nextra",
            "0\r\nX-Trailer: forbidden\r\n\r\n",
            "2;extension\r\n{}\r\n0\r\n\r\n",
        ] {
            let reply = format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{wire}");
            assert!(decode_health(reply.as_bytes(), APP).is_none());
        }
        assert!(decode_health(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",APP).is_none());
    }
    #[test]
    fn enforces_exact_response_and_header_size_boundaries() {
        let header = "HTTP/1.1 200 OK\r\n\r\n";
        let empty = format!(r#"{{"appId":"{APP}","padding":""}}"#);
        let padding = "x".repeat(MAX_RESPONSE_BYTES - header.len() - empty.len());
        let reply = format!(r#"{header}{{"appId":"{APP}","padding":"{padding}"}}"#);
        assert_eq!(reply.len(), MAX_RESPONSE_BYTES);
        assert!(decode_health(reply.as_bytes(), APP).is_some());
        assert!(decode_health(format!("{reply} ").as_bytes(), APP).is_none());
        let prefix = "HTTP/1.1 200 OK\r\nX-Padding: ";
        let fields = format!("{prefix}{}", "x".repeat(MAX_HEADER_BYTES - prefix.len()));
        assert!(decode_health(format!("{fields}\r\n\r\n{}", body()).as_bytes(), APP).is_some());
        assert!(decode_health(format!("{fields}x\r\n\r\n{}", body()).as_bytes(), APP).is_none());
    }
    #[test]
    fn a_stalled_or_dripping_peer_cannot_extend_the_original_call_deadline() {
        use std::net::TcpListener;
        use std::sync::mpsc;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (stop, receiver) = mpsc::channel();
        let peer = std::thread::spawn(move || {
            let mut socket = fixture_connection(listener);
            socket.write_all(b"HTTP/1.1 200 OK\r\n\r\n").unwrap();
            for byte in body().bytes() {
                if receiver.recv_timeout(Duration::from_millis(20)).is_ok() {
                    break;
                }
                if let Err(error) = socket.write_all(&[byte]) {
                    assert!(matches!(
                        error.kind(),
                        std::io::ErrorKind::BrokenPipe
                            | std::io::ErrorKind::ConnectionReset
                            | std::io::ErrorKind::ConnectionAborted
                    ));
                    break;
                }
            }
        });
        let started = Instant::now();
        assert!(read_proxy_health_direct_on_port(port, Duration::from_millis(80), APP).is_none());
        let elapsed = started.elapsed();
        stop.send(()).unwrap();
        peer.join().unwrap();
        assert!(elapsed < Duration::from_millis(300));
        assert!(read_proxy_health_direct_on_port(0, Duration::from_millis(300), APP).is_none());
        assert!(read_proxy_health_direct_on_port(port, Duration::ZERO, APP).is_none());
    }
}
