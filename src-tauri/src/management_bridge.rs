use serde::Serialize;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

const MAX_REQUEST_BODY_BYTES: usize = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_CONCURRENT_MANAGEMENT_REQUESTS: usize = 8;
const MANAGEMENT_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
static ACTIVE_MANAGEMENT_REQUESTS: AtomicUsize = AtomicUsize::new(0);

struct ManagementRequestPermit;

impl ManagementRequestPermit {
    fn acquire() -> Result<Self, String> {
        ACTIVE_MANAGEMENT_REQUESTS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < MAX_CONCURRENT_MANAGEMENT_REQUESTS).then_some(active + 1)
            })
            .map_err(|_| "too many concurrent management requests".to_string())?;
        Ok(Self)
    }
}

impl Drop for ManagementRequestPermit {
    fn drop(&mut self) {
        ACTIVE_MANAGEMENT_REQUESTS.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagementResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

fn validate_method(method: &str) -> Result<&str, String> {
    match method {
        "GET" | "POST" => Ok(method),
        _ => Err("management request method is not allowed".to_string()),
    }
}

fn normalized_management_route(path: &str) -> Option<&str> {
    path.strip_prefix("/v1/local")
        .or_else(|| path.strip_prefix("/local"))
}

fn is_allowed_management_route(method: &str, route: &str) -> bool {
    match method {
        "GET" => matches!(
            route,
            "/health"
                | "/config"
                | "/log"
                | "/env/check"
                | "/env/install-jobs"
                | "/diagnostics"
                | "/cert"
                | "/prompts/presets"
                | "/mcp-hub"
                | "/mcp-hub/logs"
                | "/mcp-hub/tools"
                | "/claude-code/status"
                | "/antigravity-cli/status"
                | "/trae/status"
                | "/trae-international/status"
                | "/trae/bridge/status"
                | "/trae/debug/events"
                | "/trae/debug/settings"
                | "/trae/debug/native/status"
                | "/trae/debug/native/deep/events"
                | "/claude-desktop/status"
                | "/codex/status"
                | "/codex-desktop/status"
                | "/gemini-cli/status"
                | "/auth/cli-credentials"
                | "/auth/rate-limits"
                | "/events"
                | "/audit/conversations"
                | "/usage/summary"
                | "/usage/report"
                | "/metrics"
                | "/cli/sessions"
                | "/client-activity"
        ),
        "POST" => matches!(
            route,
            "/select-directory"
                | "/cli/launch"
                | "/cli/sessions/delete"
                | "/audit/conversations/clear"
                | "/audit/retry"
                | "/profile/test-auth"
                | "/profile/latency"
                | "/config"
                | "/config/entry-auth-key/reveal"
                | "/active"
                | "/env/upgrade"
                | "/diagnostics/clear"
                | "/diagnostics/ingress-probe"
                | "/cert/trust"
                | "/cert/untrust"
                | "/models/list"
                | "/route/test"
                | "/prompts/sync"
                | "/prompts/presets"
                | "/prompts/presets/apply"
                | "/mcp-hub"
                | "/mcp-hub/execute"
                | "/claude-code/apply"
                | "/claude-code/restore"
                | "/antigravity-cli/apply"
                | "/antigravity-cli/restore"
                | "/trae/debug/settings"
                | "/trae/debug/claude-process/self-test"
                | "/trae/debug/native/scan"
                | "/trae/debug/native/deep/start"
                | "/trae/debug/native/deep/stop"
                | "/claude-desktop/apply"
                | "/claude-desktop/restore"
                | "/claude-desktop/sync-mcp"
                | "/claude-desktop/restore-backup"
                | "/codex/apply"
                | "/codex/restore"
                | "/codex/switch"
                | "/codex/auth/api-login"
                | "/codex/auth/official-login"
                | "/codex/auth/backup"
                | "/codex-desktop/apply"
                | "/codex-desktop/restore"
                | "/codex-desktop/switch"
                | "/codex-desktop/auth/api-login"
                | "/codex-desktop/auth/official-login"
                | "/codex-desktop/auth/backup"
                | "/gemini-cli/apply"
                | "/gemini-cli/restore"
                | "/events/clear"
        ),
        _ => false,
    }
}

fn validate_path<'a>(method: &str, path: &'a str) -> Result<&'a str, String> {
    if path.is_empty()
        || path.len() > 4096
        || !path.is_ascii()
        || path.bytes().any(|byte| byte <= 0x20 || byte == 0x7f)
    {
        return Err("management request path is invalid".to_string());
    }
    let route = path.split('?').next().unwrap_or_default();
    let normalized = normalized_management_route(route)
        .filter(|value| value.starts_with('/'))
        .ok_or_else(|| "management request path is not allowed".to_string())?;
    if !is_allowed_management_route(method, normalized) {
        return Err("management request path is not allowed".to_string());
    }
    Ok(path)
}

fn validate_content_type(value: &str) -> Result<&str, String> {
    if value.is_empty() {
        return Ok("application/json");
    }
    if value.len() > 128 || !value.is_ascii() || value.bytes().any(|byte| byte < 0x20) {
        return Err("management request content type is invalid".to_string());
    }
    let media_type = value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match media_type.as_str() {
        "application/json" | "text/plain" | "application/x-www-form-urlencoded" => Ok(value),
        _ => Err("management request content type is not allowed".to_string()),
    }
}

fn is_sensitive_management_path(path: &str) -> bool {
    path.split('?').next().and_then(normalized_management_route)
        == Some("/config/entry-auth-key/reveal")
}

fn decode_chunked_body(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut cursor = 0usize;
    let mut output = Vec::new();
    loop {
        let line_end = input[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")
            .map(|offset| cursor + offset)
            .ok_or_else(|| "invalid chunked management response".to_string())?;
        let size_text = std::str::from_utf8(&input[cursor..line_end])
            .map_err(|_| "invalid chunk size".to_string())?
            .split(';')
            .next()
            .unwrap_or_default();
        let size =
            usize::from_str_radix(size_text, 16).map_err(|_| "invalid chunk size".to_string())?;
        cursor = line_end + 2;
        if size == 0 {
            return Ok(output);
        }
        if size > MAX_RESPONSE_BYTES as usize
            || output.len().saturating_add(size) > MAX_RESPONSE_BYTES as usize
            || cursor.saturating_add(size + 2) > input.len()
        {
            return Err("management response body is too large or truncated".to_string());
        }
        output.extend_from_slice(&input[cursor..cursor + size]);
        cursor += size;
        if input.get(cursor..cursor + 2) != Some(b"\r\n") {
            return Err("invalid chunk terminator".to_string());
        }
        cursor += 2;
    }
}

fn parse_http_response(input: &[u8]) -> Result<ManagementResponse, String> {
    let header_end = input
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "management response headers are incomplete".to_string())?;
    if header_end > MAX_HEADER_BYTES {
        return Err("management response headers are too large".to_string());
    }
    let header_text = std::str::from_utf8(&input[..header_end])
        .map_err(|_| "management response headers are invalid".to_string())?;
    let mut lines = header_text.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| (100..=599).contains(value))
        .ok_or_else(|| "management response status is invalid".to_string())?;

    let mut response_headers = BTreeMap::new();
    let mut chunked = false;
    let mut content_length = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err("management response header is invalid".to_string());
        };
        let normalized_name = name.trim().to_ascii_lowercase();
        let normalized_value = value.trim();
        if normalized_name == "transfer-encoding" {
            chunked = normalized_value.eq_ignore_ascii_case("chunked");
        } else if normalized_name == "content-length" {
            content_length = normalized_value.parse::<usize>().ok();
        }
        if matches!(
            normalized_name.as_str(),
            "content-type" | "retry-after" | "x-request-id"
        ) {
            response_headers.insert(normalized_name, normalized_value.to_string());
        }
    }

    let raw_body = &input[header_end + 4..];
    let body = if chunked {
        decode_chunked_body(raw_body)?
    } else if let Some(expected) = content_length {
        if expected > MAX_RESPONSE_BYTES as usize || raw_body.len() < expected {
            return Err("management response body is too large or truncated".to_string());
        }
        raw_body[..expected].to_vec()
    } else {
        raw_body.to_vec()
    };
    let body = String::from_utf8(body)
        .map_err(|_| "management response body must be UTF-8".to_string())?;
    Ok(ManagementResponse {
        status,
        headers: response_headers,
        body,
    })
}

pub fn perform_management_request(
    port: u16,
    path: &str,
    method: &str,
    content_type: &str,
    body: &str,
    token: &str,
    timeout: Duration,
) -> Result<ManagementResponse, String> {
    let method = validate_method(method)?;
    let path = validate_path(method, path)?;
    let content_type = validate_content_type(content_type)?;
    if body.len() > MAX_REQUEST_BODY_BYTES {
        return Err("management request body is too large".to_string());
    }
    if token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("management token is invalid".to_string());
    }

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let mut stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|error| format!("connect management port failed: {error}"))?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| format!("set management read timeout failed: {error}"))?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| format!("set management write timeout failed: {error}"))?;

    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nx-mgmt-token: {token}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .and_then(|_| stream.write_all(body.as_bytes()))
        .map_err(|error| format!("write management request failed: {error}"))?;

    let mut response = Vec::new();
    stream
        .take(MAX_RESPONSE_BYTES + MAX_HEADER_BYTES as u64 + 1)
        .read_to_end(&mut response)
        .map_err(|error| format!("read management response failed: {error}"))?;
    if response.len() > MAX_RESPONSE_BYTES as usize + MAX_HEADER_BYTES {
        return Err("management response is too large".to_string());
    }
    parse_http_response(&response)
}

async fn execute_native_management_request(
    port: u16,
    path: String,
    method: String,
    content_type: String,
    body: String,
) -> Result<ManagementResponse, String> {
    let _permit = ManagementRequestPermit::acquire()?;
    let token_result = super::get_management_token_native(Some(port));
    let token = token_result
        .get("token")
        .and_then(serde_json::Value::as_str)
        .filter(|_| token_result.get("ok").and_then(serde_json::Value::as_bool) == Some(true))
        .ok_or_else(|| "verified management token is unavailable".to_string())?
        .to_string();
    tauri::async_runtime::spawn_blocking(move || {
        perform_management_request(
            port,
            &path,
            &method,
            &content_type,
            &body,
            &token,
            MANAGEMENT_REQUEST_TIMEOUT,
        )
    })
    .await
    .map_err(|error| format!("management request task failed: {error}"))?
}

#[tauri::command]
pub async fn management_fetch_native(
    management_port: Option<u16>,
    path: String,
    method: Option<String>,
    content_type: Option<String>,
    body: Option<String>,
) -> Result<ManagementResponse, String> {
    if is_sensitive_management_path(&path) {
        return Err("sensitive management route requires a dedicated native command".to_string());
    }
    execute_native_management_request(
        management_port.unwrap_or_else(super::proxy_management_port),
        path,
        method.unwrap_or_else(|| "GET".to_string()),
        content_type.unwrap_or_else(|| "application/json".to_string()),
        body.unwrap_or_default(),
    )
    .await
}

#[tauri::command]
pub async fn reveal_entry_auth_key_native(
    management_port: Option<u16>,
    key_id: String,
) -> Result<ManagementResponse, String> {
    let key_id = key_id.trim();
    if key_id.is_empty()
        || key_id.len() > 128
        || !key_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("entry key id is invalid".to_string());
    }
    execute_native_management_request(
        management_port.unwrap_or_else(super::proxy_management_port),
        "/v1/local/config/entry-auth-key/reveal".to_string(),
        "POST".to_string(),
        "application/json".to_string(),
        serde_json::json!({ "keyId": key_id }).to_string(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        decode_chunked_body, is_sensitive_management_path, parse_http_response,
        validate_content_type, validate_path,
    };

    #[test]
    fn validates_management_paths_and_content_types() {
        assert!(validate_path("GET", "/v1/local/config?limit=1").is_ok());
        assert!(validate_path("GET", "/local/health").is_ok());
        assert!(validate_path("GET", "/v1/models").is_err());
        assert!(validate_path("GET", "/v1/local/config\r\nx: injected").is_err());
        assert!(validate_path("GET", &format!("/v1/local/{}", "x".repeat(4096))).is_err());
        assert!(validate_path("POST", "/v1/local/config").is_ok());
        assert!(validate_path("POST", "/v1/local/diagnostics/ingress-probe").is_ok());
        assert!(validate_path("GET", "/v1/local/config/entry-auth-key/reveal").is_err());
        assert!(validate_path("GET", "/v1/local/future-ambient-capability").is_err());
        assert!(is_sensitive_management_path(
            "/v1/local/config/entry-auth-key/reveal"
        ));
        assert!(!is_sensitive_management_path("/v1/local/config"));
        assert!(validate_content_type("application/json; charset=utf-8").is_ok());
        assert!(validate_content_type("multipart/form-data").is_err());
    }

    #[test]
    fn parses_bounded_content_length_and_chunked_responses() {
        let response =
            parse_http_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, "{}");
        assert_eq!(decode_chunked_body(b"2\r\n{}\r\n0\r\n\r\n").unwrap(), b"{}");
        assert!(decode_chunked_body(b"z\r\nbad\r\n").is_err());
        assert!(parse_http_response(b"HTTP/1.1 nope\r\n\r\n").is_err());
    }
}
