use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::Manager;

mod app_shortcuts;
mod codex_login;
mod desktop_shell;
mod launch_on_login;
mod management_bridge;
mod proxy_control;
mod proxy_control_stdio;
#[cfg(test)]
mod proxy_control_stdio_tests;
mod proxy_health;
mod proxy_process;
mod proxy_root;
mod proxy_stop;
mod proxy_stop_process;
use app_shortcuts::execute_app_shortcut;
use codex_login::launch_codex_login_script;
#[cfg(test)]
use codex_login::{
    codex_login_script_path, validate_codex_login_script_file, CODEX_LOGIN_SCRIPT_FILE_NAME,
};
use desktop_shell::{
    apply_app_menu, configure_desktop_shell, get_proxy_debug, handle_app_menu_event, open_cert_dir,
    open_config, open_log, select_directory_native,
};
use launch_on_login::{get_launch_on_login, set_launch_on_login};
#[cfg(test)]
use launch_on_login::{
    launch_command_matches_exe, startup_value_matches_exe, windows_launch_command,
};
use management_bridge::{management_fetch_native, reveal_entry_auth_key_native};
use proxy_root::{
    find_project_root, management_token_candidates, proxy_runtime_dir, set_resource_root,
};
#[cfg(test)]
use proxy_root::{first_unique_existing_root, is_proxy_runtime_root, select_release_root};

static PROXY_STOPPED_FOR_EXIT: AtomicBool = AtomicBool::new(false);
static PROXY_AUTOSTART_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
const APP_ID: &str = "https-proxy-manager";
pub use proxy_control::run_from_process_args as run_proxy_control_from_process_args;

#[cfg(windows)]
fn hide_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console_window(_command: &mut Command) {}

fn proxy_config_value() -> Option<serde_json::Value> {
    let config_path = find_project_root()?.join("proxy.config.json");
    let content = std::fs::read_to_string(&config_path).ok()?;
    serde_json::from_str::<serde_json::Value>(&content).ok()
}

fn proxy_management_port() -> u16 {
    let Some(json) = proxy_config_value() else {
        return 3543;
    };
    if let Some(port) = json
        .get("localServer")
        .and_then(|s| s.get("managementPort"))
        .and_then(|v| v.as_u64())
        .and_then(|v| u16::try_from(v).ok())
    {
        return port;
    }
    json.get("localServer")
        .and_then(|s| s.get("listenPort"))
        .and_then(|v| v.as_u64())
        .and_then(|v| u16::try_from(v + 100).ok())
        .unwrap_or(3543)
}

fn management_token_is_accepted(port: u16, token: &str, timeout: Duration) -> Option<bool> {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), port);
    let mut stream = TcpStream::connect_timeout(&addr, timeout).ok()?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let request = format!(
        "GET /v1/local/config HTTP/1.1\r\nHost: 127.0.0.1\r\nx-mgmt-token: {}\r\nConnection: close\r\n\r\n",
        token
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    let status_line = response.lines().next().unwrap_or_default();
    if status_line.contains(" 200 ") {
        Some(true)
    } else if status_line.contains(" 401 ") || status_line.contains(" 403 ") {
        Some(false)
    } else {
        None
    }
}

fn find_management_token_for_port(root: &Path, port: u16, timeout: Duration) -> Option<String> {
    let management_is_running = read_proxy_health_direct_on_port(port, timeout).is_some();
    let mut seen_tokens = HashSet::new();
    let mut fallback: Option<String> = None;

    for path in management_token_candidates(root, port) {
        if let Ok(token) = std::fs::read_to_string(&path) {
            let token = token.trim().to_string();
            if token.is_empty() || !seen_tokens.insert(token.clone()) {
                continue;
            }
            if fallback.is_none() {
                fallback = Some(token.clone());
            }
            if management_is_running {
                if management_token_is_accepted(port, &token, timeout) == Some(true) {
                    return Some(token);
                }
            } else {
                return Some(token);
            }
        }
    }

    if management_is_running {
        None
    } else {
        fallback
    }
}

fn post_management_json(
    port: u16,
    path: &str,
    token: &str,
    timeout: Duration,
) -> Result<String, String> {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), port);
    let mut stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|err| format!("connect management port {port} failed: {err}"))?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nx-mgmt-token: {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| format!("write management request failed: {err}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|err| format!("read management response failed: {err}"))?;
    let status_line = response.lines().next().unwrap_or_default();
    if !status_line.contains(" 200 ") {
        return Err(format!("management request failed: {status_line}"));
    }
    let body = response
        .split("\r\n\r\n")
        .nth(1)
        .unwrap_or_default()
        .trim()
        .to_string();
    Ok(body)
}

fn get_management_token_native(management_port: Option<u16>) -> serde_json::Value {
    let Some(root) = find_project_root() else {
        return serde_json::json!({
            "ok": false,
            "source": "rust-native",
            "error": "project root not found"
        });
    };

    let port = management_port.unwrap_or_else(proxy_management_port);
    let runtime_dir = proxy_runtime_dir(&root);
    let management_is_running =
        read_proxy_health_direct_on_port(port, Duration::from_millis(120)).is_some();
    let mut seen_tokens = HashSet::new();
    let mut fallback: Option<(String, PathBuf)> = None;

    for path in management_token_candidates(&root, port) {
        if let Ok(token) = std::fs::read_to_string(&path) {
            let token = token.trim().to_string();
            if token.is_empty() || !seen_tokens.insert(token.clone()) {
                continue;
            }
            if fallback.is_none() {
                fallback = Some((token.clone(), path.clone()));
            }
            if management_is_running {
                if management_token_is_accepted(port, &token, Duration::from_millis(350))
                    == Some(true)
                {
                    return serde_json::json!({
                        "ok": true,
                        "source": "rust-native",
                        "token": token,
                        "path": path.display().to_string(),
                        "verified": true
                    });
                }
            } else {
                return serde_json::json!({
                    "ok": true,
                    "source": "rust-native",
                    "token": token,
                    "path": path.display().to_string(),
                    "verified": false
                });
            }
        }
    }

    if !management_is_running {
        if let Some((token, path)) = fallback {
            return serde_json::json!({
                "ok": true,
                "source": "rust-native",
                "token": token,
                "path": path.display().to_string(),
                "verified": false
            });
        }
    }

    serde_json::json!({
        "ok": false,
        "source": "rust-native",
        "error": if management_is_running {
            "management token file not found or all candidate tokens were rejected"
        } else {
            "management token file not found"
        },
        "runtimeDir": runtime_dir.display().to_string()
    })
}

fn read_proxy_health_direct_on_port(port: u16, timeout: Duration) -> Option<serde_json::Value> {
    proxy_health::read_proxy_health_direct_on_port(port, timeout, APP_ID)
}

fn read_proxy_health_direct(timeout: Duration) -> Option<serde_json::Value> {
    read_proxy_health_direct_on_port(proxy_management_port(), timeout)
}

fn format_proxy_status(health: &serde_json::Value) -> String {
    let pid = health
        .get("pid")
        .and_then(|v| v.as_u64())
        .map(|v| v.to_string())
        .unwrap_or_else(|| "unknown".into());
    let port = health
        .get("ports")
        .and_then(|v| v.get("proxy"))
        .and_then(|v| v.as_u64())
        .or_else(|| health.get("port").and_then(|v| v.as_u64()))
        .map(|v| v.to_string())
        .unwrap_or_else(|| "unknown".into());
    let management_port = proxy_management_port();
    format!(
        "Proxy Status:\n  State: Running (PID {pid})\n  Address: https://127.0.0.1:{port}\n  Management: http://127.0.0.1:{management_port}\n  Source: rust-direct\n"
    )
}

fn node_proxy_command(root: &Path) -> Command {
    let bundled_node = root.join("runtime").join("node").join("node.exe");
    let runtime_dir = proxy_runtime_dir(root);
    let mut command = if bundled_node.exists() {
        Command::new(bundled_node)
    } else {
        Command::new("node")
    };
    proxy_process::configure_node_environment(&mut command, root, &runtime_dir);
    command
        .arg(root.join("openai-proxy.js"))
        .env("NO_PAUSE", "1")
        .env_remove("PORT")
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console_window(&mut command);
    command
}

fn start_proxy_direct() -> Result<serde_json::Value, String> {
    let root = find_project_root().ok_or_else(|| "project root not found".to_string())?;
    if let Some(health) = read_proxy_health_direct(Duration::from_millis(300)) {
        if proxy_process::proxy_health_matches_root(&health, &root) {
            return Ok(serde_json::json!({
                "code": 0,
                "timedOut": false,
                "direct": true,
                "output": format!("Proxy already running.\n{}", format_proxy_status(&health))
            }));
        }
        return Err("proxy_start_owner_mismatch".into());
    }

    proxy_process::ensure_proxy_config_file(&root);
    let mut child = node_proxy_command(&root)
        .spawn()
        .map_err(|e| format!("failed to start node proxy directly: {e}"))?;

    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        if let Some(health) = read_proxy_health_direct(Duration::from_millis(250)) {
            if !proxy_process::launched_proxy_health_matches(&health, &root, child.id()) {
                return Err("proxy_start_owner_mismatch".into());
            }
            return Ok(serde_json::json!({
                "code": 0,
                "timedOut": false,
                "direct": true,
                "output": format!("Proxy started directly.\n{}", format_proxy_status(&health))
            }));
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("direct proxy process exited early: {status}"));
        }
        std::thread::sleep(Duration::from_millis(120));
    }

    Ok(serde_json::json!({
        "code": 0,
        "timedOut": true,
        "direct": true,
        "output": "Proxy process launched directly; health endpoint is still warming up.\n"
    }))
}

#[tauri::command]
fn clear_audit_conversations_native(management_port: Option<u16>) -> serde_json::Value {
    let Some(root) = find_project_root() else {
        return serde_json::json!({
            "ok": false,
            "source": "rust-native",
            "error": "project root not found"
        });
    };

    let port = management_port.unwrap_or_else(proxy_management_port);
    let Some(token) = find_management_token_for_port(&root, port, Duration::from_millis(500))
    else {
        return serde_json::json!({
            "ok": false,
            "source": "rust-native",
            "error": "management token not found or rejected",
            "port": port
        });
    };

    match post_management_json(
        port,
        "/v1/local/audit/conversations/clear",
        &token,
        Duration::from_secs(3),
    ) {
        Ok(body) => serde_json::json!({
            "ok": true,
            "source": "rust-native",
            "body": body,
            "port": port
        }),
        Err(error) => serde_json::json!({
            "ok": false,
            "source": "rust-native",
            "error": error,
            "port": port
        }),
    }
}

fn stop_proxy_direct() -> Result<serde_json::Value, String> {
    let root = find_project_root().ok_or("proxy_stop_root_unavailable")?;
    proxy_stop::stop_proxy(&root, proxy_management_port())
}

fn proxy_command_direct(command: &str) -> Option<Result<serde_json::Value, String>> {
    match command {
        "status" => Some(Ok(
            match read_proxy_health_direct(Duration::from_millis(300)) {
                Some(health) => serde_json::json!({
                    "code": 0,
                    "timedOut": false,
                    "direct": true,
                    "output": format_proxy_status(&health)
                }),
                None => serde_json::json!({
                    "code": 0,
                    "timedOut": false,
                    "direct": true,
                    "output": "Proxy Status:\n  State: Stopped\n  Source: rust-direct\n"
                }),
            },
        )),
        "stop" => Some(stop_proxy_direct()),
        "start" => Some(start_proxy_direct()),
        "restart" => Some(stop_proxy_direct().and_then(|_| {
            std::thread::sleep(Duration::from_millis(250));
            start_proxy_direct()
        })),
        _ => None,
    }
}

fn normalize_proxy_command(command: &str) -> Result<&'static str, String> {
    match command.trim().to_ascii_lowercase().as_str() {
        "status" => Ok("status"),
        "stop" => Ok("stop"),
        "start" => Ok("start"),
        "restart" => Ok("restart"),
        "" => Err("proxy command is required".into()),
        other => Err(format!("unsupported proxy command: {other}")),
    }
}

fn start_proxy_if_needed() {
    let port = proxy_management_port();
    if read_proxy_health_direct_on_port(port, Duration::from_millis(250)).is_some() {
        if let Some(root) = find_project_root() {
            let health = read_proxy_health_direct_on_port(port, Duration::from_millis(250));
            if health
                .as_ref()
                .map(|h| proxy_process::proxy_health_matches_root(h, &root))
                .unwrap_or(false)
                && find_management_token_for_port(&root, port, Duration::from_millis(350)).is_some()
            {
                return;
            }
        }
        // Another root or an unauthenticated instance cannot authorize stop.
        if stop_proxy_direct().is_err() {
            return;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    if start_proxy_direct().is_err() {
        log::warn!("Proxy autostart was not confirmed.");
    }
}

fn request_proxy_autostart() {
    if read_app_setting("autoStartProxy", true) {
        if PROXY_AUTOSTART_IN_FLIGHT.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::spawn(|| {
            start_proxy_if_needed();
            PROXY_AUTOSTART_IN_FLIGHT.store(false, Ordering::SeqCst);
        });
    }
}

pub(crate) fn stop_proxy_for_exit() {
    if !read_app_setting("stopProxyOnExit", true)
        || PROXY_STOPPED_FOR_EXIT.swap(true, Ordering::SeqCst)
    {
        return;
    }
    if stop_proxy_direct().is_err() {
        log::warn!("Proxy shutdown was not confirmed; forced cleanup was not authorized.");
    }
}

/// Read a boolean from proxy.config.json → appSettings → <key>, defaulting to `default`.
fn read_app_setting(key: &str, default: bool) -> bool {
    let config_path = find_project_root()
        .map(|r| r.join("proxy.config.json"))
        .unwrap_or_else(|| PathBuf::from("proxy.config.json"));
    let Ok(content) = std::fs::read_to_string(&config_path) else {
        return default;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
        return default;
    };
    json.get("appSettings")
        .and_then(|s| s.get(key))
        .and_then(|v| v.as_bool())
        .unwrap_or(default)
}

#[cfg(windows)]
fn ca_certificate_thumbprint(ca_path: &Path) -> Result<String, String> {
    use base64::Engine;
    use sha1::{Digest, Sha1};

    let pem = std::fs::read_to_string(ca_path).map_err(|e| e.to_string())?;
    let encoded = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .map(str::trim)
        .collect::<String>();
    if encoded.is_empty() {
        return Err("CA certificate PEM is empty".into());
    }
    let der = base64::engine::general_purpose::STANDARD
        .decode(encoded.as_bytes())
        .map_err(|e| e.to_string())?;
    let digest = Sha1::digest(&der);
    Ok(digest
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<String>())
}

#[cfg(windows)]
fn registry_cert_thumbprint_exists(thumbprint: &str) -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let path = format!(
        r"SOFTWARE\Microsoft\SystemCertificates\ROOT\Certificates\{}",
        thumbprint
    );
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(&path)
        .is_ok()
        || RegKey::predef(HKEY_CURRENT_USER).open_subkey(&path).is_ok()
}

#[cfg(windows)]
fn native_cert_trusted(ca_path: &Path) -> Result<(bool, Option<String>), String> {
    if !ca_path.exists() {
        return Ok((false, None));
    }
    let thumbprint = ca_certificate_thumbprint(ca_path)?;
    Ok((
        registry_cert_thumbprint_exists(&thumbprint),
        Some(thumbprint),
    ))
}

#[cfg(not(windows))]
fn native_cert_trusted(_ca_path: &Path) -> Result<(bool, Option<String>), String> {
    Ok((false, None))
}

#[tauri::command]
fn get_cert_status_native() -> serde_json::Value {
    let Some(root) = find_project_root() else {
        return serde_json::json!({
            "ok": false,
            "source": "rust-native",
            "error": "project root not found"
        });
    };
    let cert_dir = proxy_runtime_dir(&root).join(".certs");
    let ca_path = cert_dir.join("proxy-ca-cert.pem");
    let cert_path = cert_dir.join("proxy-cert.pem");
    let key_path = cert_dir.join("proxy-key.pem");
    let exists = cert_path.exists() && key_path.exists();
    match native_cert_trusted(&ca_path) {
        Ok((trusted, thumbprint)) => serde_json::json!({
            "ok": true,
            "source": "rust-native",
            "exists": exists,
            "trusted": trusted,
            "thumbprint": thumbprint,
            "certDir": cert_dir.display().to_string(),
            "caCertFile": ca_path.display().to_string(),
            "nodeExtraCaCertsEnv": format!("NODE_EXTRA_CA_CERTS={}", ca_path.display())
        }),
        Err(error) => serde_json::json!({
            "ok": false,
            "source": "rust-native",
            "exists": exists,
            "trusted": false,
            "certDir": cert_dir.display().to_string(),
            "caCertFile": ca_path.display().to_string(),
            "nodeExtraCaCertsEnv": format!("NODE_EXTRA_CA_CERTS={}", ca_path.display()),
            "error": error
        }),
    }
}

#[tauri::command]
async fn execute_proxy_command(command: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || execute_proxy_command_blocking(command))
        .await
        .map_err(|e| e.to_string())?
}

fn execute_proxy_command_blocking(command: String) -> Result<serde_json::Value, String> {
    let command = normalize_proxy_command(command.as_str())?;
    proxy_command_direct(command).ok_or_else(|| "proxy_command_unavailable".to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // ── 单例启动 ──────────────────────────────────────
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 第二个实例启动时 → 聚焦已有窗口
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            if let Ok(resource_dir) = app.path().resource_dir() {
                set_resource_root(resource_dir);
            }

            // Start once after RESOURCE_ROOT is available through the guarded autostart path.
            request_proxy_autostart();
            Ok(configure_desktop_shell(app)?)
        })
        .on_menu_event(handle_app_menu_event)
        .invoke_handler(tauri::generate_handler![
            apply_app_menu,
            execute_app_shortcut,
            open_config,
            open_log,
            open_cert_dir,
            launch_codex_login_script,
            select_directory_native,
            get_proxy_debug,
            get_cert_status_native,
            management_fetch_native,
            reveal_entry_auth_key_native,
            clear_audit_conversations_native,
            execute_proxy_command,
            get_launch_on_login,
            set_launch_on_login
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                stop_proxy_for_exit();
            }
        });
}

#[cfg(test)]
mod tests;
