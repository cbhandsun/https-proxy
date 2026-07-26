use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

mod codex_login;
mod launch_on_login;

use codex_login::launch_codex_login_script;
#[cfg(test)]
use codex_login::{
    codex_login_script_path, validate_codex_login_script_file, CODEX_LOGIN_SCRIPT_FILE_NAME,
};
use launch_on_login::{get_launch_on_login, set_launch_on_login};
#[cfg(test)]
use launch_on_login::{
    launch_command_matches_exe, startup_value_matches_exe, windows_launch_command,
};

static ZOOM_LEVEL: AtomicU32 = AtomicU32::new(100);
static PROXY_STOPPED_FOR_EXIT: AtomicBool = AtomicBool::new(false);
static PROXY_AUTOSTART_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
const APP_ID: &str = "https-proxy-manager";

/// Cached project root (the directory containing proxy.bat).
static PROJECT_ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
static RESOURCE_ROOT: OnceLock<PathBuf> = OnceLock::new();

fn is_proxy_runtime_root(path: &Path) -> bool {
    path.join("proxy.bat").exists()
        && path.join("proxy.ps1").exists()
        && path.join("openai-proxy.js").exists()
        && path.join("lib").is_dir()
}

fn manifest_project_root() -> Option<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| {
            if is_proxy_runtime_root(p) {
                Some(p.to_path_buf())
            } else {
                None
            }
        })
}

fn path_is_under(path: &Path, parent: &Path) -> bool {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let parent = parent
        .canonicalize()
        .unwrap_or_else(|_| parent.to_path_buf());
    path.starts_with(parent)
}

fn local_target_release_root() -> Option<PathBuf> {
    let manifest_root = manifest_project_root()?;
    let exe = std::env::current_exe().ok()?;
    let target_dir = manifest_root.join("src-tauri").join("target");
    if path_is_under(&exe, &target_dir) {
        Some(manifest_root)
    } else {
        None
    }
}

fn push_proxy_root_ancestors(candidates: &mut Vec<PathBuf>, start: PathBuf) {
    let mut search = start;
    for _ in 0..6 {
        let candidate = if search.is_file() {
            search.parent().map(Path::to_path_buf)
        } else {
            Some(search.clone())
        };
        if let Some(path) = candidate {
            if is_proxy_runtime_root(&path) {
                candidates.push(path);
            }
        }
        if let Some(parent) = search.parent() {
            search = parent.to_path_buf();
        } else {
            break;
        }
    }
}

fn first_unique_existing_root(candidates: Vec<PathBuf>) -> Option<PathBuf> {
    let mut seen = HashSet::new();
    for candidate in candidates {
        let key = candidate
            .canonicalize()
            .unwrap_or_else(|_| candidate.clone())
            .to_string_lossy()
            .to_ascii_lowercase();
        if seen.insert(key) && is_proxy_runtime_root(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Find the runtime root reliably.
/// Debug builds always bind to the source checkout so stale target/debug copies
/// cannot steal config, tokens, or certs. Release and portable builds prefer
/// the launch/exe runtime before falling back to bundled resources.
fn find_project_root() -> Option<PathBuf> {
    PROJECT_ROOT
        .get_or_init(|| {
            if cfg!(debug_assertions) {
                return manifest_project_root();
            }
            if let Some(local_root) = local_target_release_root() {
                return Some(local_root);
            }

            let mut candidates = Vec::new();
            if let Ok(start) = std::env::current_dir() {
                push_proxy_root_ancestors(&mut candidates, start);
            }
            if let Ok(exe) = std::env::current_exe() {
                push_proxy_root_ancestors(&mut candidates, exe);
            }
            if let Some(resource_root) = RESOURCE_ROOT.get() {
                push_proxy_root_ancestors(&mut candidates, resource_root.to_path_buf());
            }
            if let Some(manifest_root) = manifest_project_root() {
                candidates.push(manifest_root);
            }

            first_unique_existing_root(candidates)
        })
        .clone()
}

/// Run `proxy.bat <args>` in the project root directory.
fn run_proxy_bat_with_timeout(args: &[&str], timeout: Duration) -> Option<(Output, bool)> {
    let root = find_project_root()?;
    let mut command = std::process::Command::new("cmd");
    command
        .arg("/c")
        .arg("proxy.bat")
        .args(args)
        .env("NO_PAUSE", "1")
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console_window(&mut command);
    let mut child = command.spawn().ok()?;

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok().map(|out| (out, false)),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    return child.wait_with_output().ok().map(|out| (out, true));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => {
                let _ = child.kill();
                return None;
            }
        }
    }
}

fn run_proxy_bat(args: &[&str]) -> Option<Output> {
    run_proxy_bat_with_timeout(args, Duration::from_secs(30)).map(|(out, _)| out)
}

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

fn proxy_runtime_dir(root: &Path) -> PathBuf {
    root.join(".hpm-runtime")
}

fn portable_runtime_dir(root: &Path) -> PathBuf {
    root.join("dist")
        .join("portable")
        .join("HTTPS Proxy Manager Portable")
        .join(".hpm-runtime")
}

fn management_token_candidates(root: &Path, port: u16) -> Vec<PathBuf> {
    let runtime_dir = proxy_runtime_dir(root);
    let debug_runtime_dir = root
        .join("src-tauri")
        .join("target")
        .join("debug")
        .join(".hpm-runtime");
    let portable_runtime_dir = portable_runtime_dir(root);
    vec![
        runtime_dir.join(format!(".mgmt-token-{port}")),
        debug_runtime_dir.join(format!(".mgmt-token-{port}")),
        portable_runtime_dir.join(format!(".mgmt-token-{port}")),
        runtime_dir.join(".mgmt-token"),
        debug_runtime_dir.join(".mgmt-token"),
        portable_runtime_dir.join(".mgmt-token"),
    ]
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

#[tauri::command]
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
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), port);
    let mut stream = TcpStream::connect_timeout(&addr, timeout).ok()?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    stream
        .write_all(b"GET /v1/local/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    let body = response.split_once("\r\n\r\n")?.1.trim();
    let json = serde_json::from_str::<serde_json::Value>(body).ok()?;
    if json.get("appId").and_then(|v| v.as_str()) == Some(APP_ID) {
        Some(json)
    } else {
        None
    }
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
    command
        .arg(root.join("openai-proxy.js"))
        .env("PROXY_CONFIG_DIR", root)
        .env("PROXY_RUNTIME_DIR", &runtime_dir)
        .env(
            "NODE_COMPILE_CACHE",
            runtime_dir.join(".node-compile-cache"),
        )
        .env("NO_PAUSE", "1")
        .env_remove("PORT")
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console_window(&mut command);
    command
}

fn ensure_proxy_config_file(root: &Path) {
    let config = root.join("proxy.config.json");
    if config.exists() {
        return;
    }
    let example = root.join("proxy.config.example.json");
    if example.exists() {
        let _ = std::fs::copy(example, config);
    }
}

fn start_proxy_direct() -> Result<serde_json::Value, String> {
    if let Some(health) = read_proxy_health_direct(Duration::from_millis(300)) {
        return Ok(serde_json::json!({
            "code": 0,
            "timedOut": false,
            "direct": true,
            "output": format!("Proxy already running.\n{}", format_proxy_status(&health))
        }));
    }

    let root = find_project_root().ok_or_else(|| "project root not found".to_string())?;
    ensure_proxy_config_file(&root);
    let mut child = node_proxy_command(&root)
        .spawn()
        .map_err(|e| format!("failed to start node proxy directly: {e}"))?;

    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        if let Some(health) = read_proxy_health_direct(Duration::from_millis(250)) {
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

fn taskkill_pid(pid: u64) -> Result<String, String> {
    let mut command = Command::new("taskkill");
    command.args(["/PID", &pid.to_string(), "/F"]);
    hide_console_window(&mut command);
    let output = command.output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.status.success() {
        Ok(format!("{}{}", stdout, stderr))
    } else {
        Err(format!("{}{}", stdout, stderr))
    }
}

fn stop_proxy_direct() -> Result<serde_json::Value, String> {
    let Some(health) = read_proxy_health_direct(Duration::from_millis(300)) else {
        return Ok(serde_json::json!({
            "code": 0,
            "timedOut": false,
            "direct": true,
            "output": "Proxy is not running.\n"
        }));
    };
    let pid = health
        .get("pid")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "health endpoint did not return a pid".to_string())?;
    let kill_output = taskkill_pid(pid)?;
    if let Some(root) = find_project_root() {
        let _ = std::fs::remove_file(proxy_runtime_dir(&root).join(".proxy.pid"));
    }
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(4) {
        if read_proxy_health_direct(Duration::from_millis(200)).is_none() {
            return Ok(serde_json::json!({
                "code": 0,
                "timedOut": false,
                "direct": true,
                "output": format!("Proxy stopped directly (PID {pid}).\n{kill_output}")
            }));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(serde_json::json!({
        "code": 0,
        "timedOut": false,
        "direct": true,
        "output": format!("Stop signal sent to PID {pid}; health endpoint is still draining.\n{kill_output}")
    }))
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
        "restart" => Some({
            let _ = stop_proxy_direct();
            std::thread::sleep(Duration::from_millis(250));
            start_proxy_direct()
        }),
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
    if read_proxy_health_direct(Duration::from_millis(250)).is_some() {
        return;
    }
    if start_proxy_direct().is_err() {
        let _ = run_proxy_bat(&["start"]);
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

fn stop_proxy_for_exit() {
    if !read_app_setting("stopProxyOnExit", true) {
        return;
    }
    if PROXY_STOPPED_FOR_EXIT.swap(true, Ordering::SeqCst) {
        return;
    }
    if stop_proxy_direct().is_err() {
        let _ = run_proxy_bat(&["stop"]);
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

fn create_custom_menu(
    app: &tauri::AppHandle,
) -> Result<tauri::menu::Menu<tauri::Wry>, tauri::Error> {
    let open_config_item = tauri::menu::MenuItemBuilder::new("打开配置文件")
        .id("open_config")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let open_log_item = tauri::menu::MenuItemBuilder::new("打开日志文件")
        .id("open_log")
        .accelerator("CmdOrCtrl+L")
        .build(app)?;
    let open_certs_item = tauri::menu::MenuItemBuilder::new("打开证书目录")
        .id("open_cert_dir")
        .accelerator("CmdOrCtrl+Shift+C")
        .build(app)?;
    let quit_item = tauri::menu::MenuItemBuilder::new("退出")
        .id("quit")
        .accelerator("Alt+F4")
        .build(app)?;

    let file_submenu = tauri::menu::SubmenuBuilder::new(app, "文件")
        .items(&[
            &open_config_item,
            &open_log_item,
            &open_certs_item,
            &tauri::menu::PredefinedMenuItem::separator(app)?,
            &quit_item,
        ])
        .build()?;

    let edit_submenu = tauri::menu::SubmenuBuilder::new(app, "编辑")
        .items(&[
            &tauri::menu::PredefinedMenuItem::undo(app, Some("撤销"))?,
            &tauri::menu::PredefinedMenuItem::redo(app, Some("重做"))?,
            &tauri::menu::PredefinedMenuItem::separator(app)?,
            &tauri::menu::PredefinedMenuItem::cut(app, Some("剪切"))?,
            &tauri::menu::PredefinedMenuItem::copy(app, Some("复制"))?,
            &tauri::menu::PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &tauri::menu::PredefinedMenuItem::separator(app)?,
            &tauri::menu::PredefinedMenuItem::select_all(app, Some("全选"))?,
        ])
        .build()?;

    let reload_item = tauri::menu::MenuItemBuilder::new("重新加载")
        .id("reload")
        .accelerator("F5")
        .build(app)?;
    let force_reload_item = tauri::menu::MenuItemBuilder::new("强制重新加载")
        .id("force_reload")
        .accelerator("CmdOrCtrl+F5")
        .build(app)?;
    let zoom_in_item = tauri::menu::MenuItemBuilder::new("放大")
        .id("zoom_in")
        .accelerator("CmdOrCtrl+Equal")
        .build(app)?;
    let zoom_out_item = tauri::menu::MenuItemBuilder::new("缩小")
        .id("zoom_out")
        .accelerator("CmdOrCtrl+Minus")
        .build(app)?;
    let zoom_reset_item = tauri::menu::MenuItemBuilder::new("实际大小")
        .id("zoom_reset")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;
    let devtools_item = tauri::menu::MenuItemBuilder::new("开发者工具")
        .id("toggle_devtools")
        .accelerator("F12")
        .build(app)?;

    let view_submenu = tauri::menu::SubmenuBuilder::new(app, "视图")
        .items(&[
            &reload_item,
            &force_reload_item,
            &tauri::menu::PredefinedMenuItem::separator(app)?,
            &zoom_in_item,
            &zoom_out_item,
            &zoom_reset_item,
            &tauri::menu::PredefinedMenuItem::separator(app)?,
            &devtools_item,
        ])
        .build()?;

    let about_item = tauri::menu::MenuItemBuilder::new("关于")
        .id("about")
        .build(app)?;
    let help_submenu = tauri::menu::SubmenuBuilder::new(app, "帮助")
        .items(&[&about_item])
        .build()?;

    tauri::menu::MenuBuilder::new(app)
        .items(&[&file_submenu, &edit_submenu, &view_submenu, &help_submenu])
        .build()
}

#[tauri::command]
fn apply_app_menu(window: tauri::Window, show: bool) -> Result<(), String> {
    if show {
        let menu = create_custom_menu(window.app_handle()).map_err(|e| e.to_string())?;
        window.set_menu(menu).map_err(|e| e.to_string())?;
        window.show_menu().map_err(|e| e.to_string())
    } else {
        let _ = window.hide_menu();
        let _ = window.remove_menu();
        Ok(())
    }
}

fn open_path(path: &Path) {
    let mut command = std::process::Command::new("cmd");
    command.arg("/c").arg("start").arg("").arg(path);
    hide_console_window(&mut command);
    let _ = command.spawn();
}

#[tauri::command]
fn open_config() {
    if let Some(root) = find_project_root() {
        open_path(&root.join("proxy.config.json"));
    } else {
        open_path(Path::new("proxy.config.json"));
    }
}

#[tauri::command]
fn open_log() {
    if let Some(root) = find_project_root() {
        open_path(&proxy_runtime_dir(&root).join("proxy.log"));
    } else {
        open_path(Path::new("proxy.log"));
    }
}

#[tauri::command]
fn open_cert_dir() {
    if let Some(root) = find_project_root() {
        open_path(&proxy_runtime_dir(&root).join(".certs"));
    } else {
        open_path(Path::new(".certs"));
    }
}

#[tauri::command]
async fn select_directory_native(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("选择工作目录")
            .blocking_pick_folder();

        match selected {
            Some(folder_path) => {
                let path = folder_path
                    .simplified()
                    .into_path()
                    .map_err(|err| format!("Failed to resolve selected directory: {}", err))?;
                if !path.exists() {
                    return Err(format!(
                        "Selected directory does not exist: {}",
                        path.display()
                    ));
                }
                if !path.is_dir() {
                    return Err(format!(
                        "Selected path is not a directory: {}",
                        path.display()
                    ));
                }
                Ok(serde_json::json!({
                    "ok": true,
                    "path": path.display().to_string()
                }))
            }
            None => Ok(serde_json::json!({
                "ok": true,
                "cancelled": true
            })),
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
fn get_proxy_debug() -> serde_json::Value {
    let cwd = std::env::current_dir().unwrap_or_default();
    let exe = std::env::current_exe().unwrap_or_default();
    let manifest = env!("CARGO_MANIFEST_DIR");
    let root = find_project_root();
    let bat_exists = root
        .as_ref()
        .map(|r| r.join("proxy.bat").exists())
        .unwrap_or(false);
    serde_json::json!({
      "cwd": cwd.display().to_string(),
      "exe": exe.display().to_string(),
      "manifest_dir": manifest,
      "project_root": root.as_ref().map(|r| r.display().to_string()),
      "proxy_bat_found": bat_exists
    })
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
    if let Some(result) = proxy_command_direct(command) {
        if result.is_ok() {
            return result;
        }
    }

    let timeout = match command {
        "status" => Duration::from_secs(8),
        "stop" => Duration::from_secs(12),
        "start" => Duration::from_secs(25),
        "restart" => Duration::from_secs(35),
        _ => Duration::from_secs(20),
    };

    match run_proxy_bat_with_timeout(&[command], timeout) {
        Some((out, timed_out)) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let code = out.status.code().unwrap_or(if timed_out { 124 } else { 0 });
            let timeout_message = if timed_out {
                format!(
                    "\nCommand timed out after {}s and was stopped.",
                    timeout.as_secs()
                )
            } else {
                String::new()
            };
            Ok(serde_json::json!({
              "code": code,
              "timedOut": timed_out,
              "output": format!("{}{}{}", stdout, stderr, timeout_message)
            }))
        }
        None => Err("proxy.bat not found in project directory hierarchy".into()),
    }
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
                let _ = RESOURCE_ROOT.set(resource_dir);
            }

            // Start once, after RESOURCE_ROOT is available, through the guarded
            // autostart entry point shared by every build mode.
            request_proxy_autostart();

            // 读取配置并设置菜单的初始显示状态
            let show_menu = read_app_setting("showTopMenu", true);

            if let Some(window) = app.get_webview_window("main") {
                if show_menu {
                    let menu = create_custom_menu(app.handle())?;
                    let _ = window.set_menu(menu);
                    let _ = window.show_menu();
                } else {
                    let _ = window.hide_menu();
                    let _ = window.remove_menu();
                }
            }

            // ── 系统托盘 ──────────────────────────────────────
            if read_app_setting("showTrayMenu", true) {
                use tauri::menu::{MenuBuilder, MenuItemBuilder};
                use tauri::tray::TrayIconBuilder;

                let show_item = MenuItemBuilder::new("显示窗口")
                    .id("tray_show")
                    .build(app)?;
                let start_item = MenuItemBuilder::new("启动代理")
                    .id("tray_start")
                    .accelerator("CmdOrCtrl+Alt+S")
                    .build(app)?;
                let stop_item = MenuItemBuilder::new("停止代理")
                    .id("tray_stop")
                    .accelerator("CmdOrCtrl+Alt+X")
                    .build(app)?;
                let restart_item = MenuItemBuilder::new("重启代理")
                    .id("tray_restart")
                    .accelerator("CmdOrCtrl+Alt+R")
                    .build(app)?;
                let status_item = MenuItemBuilder::new("查看状态")
                    .id("tray_status")
                    .build(app)?;
                let sep = tauri::menu::PredefinedMenuItem::separator(app)?;
                let quit_item = MenuItemBuilder::new("退出").id("tray_quit").build(app)?;

                let menu = MenuBuilder::new(app)
                    .items(&[
                        &show_item,
                        &sep,
                        &start_item,
                        &stop_item,
                        &restart_item,
                        &tauri::menu::PredefinedMenuItem::separator(app)?,
                        &status_item,
                        &tauri::menu::PredefinedMenuItem::separator(app)?,
                        &quit_item,
                    ])
                    .build()?;

                // 使用应用默认图标（来自 tauri.conf.json 的 icon 配置）
                let icon = app.default_window_icon().unwrap().clone();

                let _tray = TrayIconBuilder::new()
                    .icon(icon)
                    .tooltip("HTTPS Proxy Manager")
                    .menu(&menu)
                    .on_menu_event(move |app_handle, event| {
                        let id = event.id().as_ref();
                        if id == "tray_show" {
                            if let Some(w) = app_handle.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        } else if id == "tray_start" {
                            std::thread::spawn(|| {
                                if start_proxy_direct().is_err() {
                                    let _ = run_proxy_bat(&["start"]);
                                }
                            });
                            if read_app_setting("showWindowOnTrayCommand", true) {
                                if let Some(w) = app_handle.get_webview_window("main") {
                                    let _ = w.show();
                                    let _ = w.set_focus();
                                    let _ = w.emit("tray-command", "started");
                                }
                            }
                        } else if id == "tray_stop" {
                            std::thread::spawn(|| {
                                if stop_proxy_direct().is_err() {
                                    let _ = run_proxy_bat(&["stop"]);
                                }
                            });
                            if read_app_setting("showWindowOnTrayCommand", true) {
                                if let Some(w) = app_handle.get_webview_window("main") {
                                    let _ = w.show();
                                    let _ = w.set_focus();
                                    let _ = w.emit("tray-command", "stopped");
                                }
                            }
                        } else if id == "tray_restart" {
                            std::thread::spawn(|| {
                                let _ = stop_proxy_direct();
                                std::thread::sleep(std::time::Duration::from_millis(250));
                                if start_proxy_direct().is_err() {
                                    let _ = run_proxy_bat(&["restart"]);
                                }
                            });
                            if read_app_setting("showWindowOnTrayCommand", true) {
                                if let Some(w) = app_handle.get_webview_window("main") {
                                    let _ = w.show();
                                    let _ = w.set_focus();
                                    let _ = w.emit("tray-command", "restarted");
                                }
                            }
                        } else if id == "tray_status" {
                            // 显示窗口即可查看状态（前端定时刷新）
                            if let Some(w) = app_handle.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                                let _ = w.emit("tray-command", "status");
                            }
                        } else if id == "tray_quit" {
                            // 直接退出，RunEvent::Exit 会负责停止代理
                            app_handle.exit(0);
                        }
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                            if let Some(w) = tray.app_handle().get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            }

            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
            }

            // ── closeToTray: 拦截窗口关闭 ─────────────────────
            let close_to_tray = read_app_setting("closeToTray", true);
            if close_to_tray {
                let handle = app.handle().clone();
                if let Some(window) = app.get_webview_window("main") {
                    window.on_window_event(move |event| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                    });
                }
            }

            Ok(())
        })
        .on_menu_event(move |app_handle, event| {
            let id = event.id().as_ref();
            if id == "open_config" {
                if let Some(root) = find_project_root() {
                    open_path(&root.join("proxy.config.json"));
                }
            } else if id == "open_log" {
                if let Some(root) = find_project_root() {
                    open_path(&proxy_runtime_dir(&root).join("proxy.log"));
                }
            } else if id == "open_cert_dir" {
                if let Some(root) = find_project_root() {
                    open_path(&proxy_runtime_dir(&root).join(".certs"));
                }
            } else if id == "quit" {
                app_handle.exit(0);
            } else if id == "reload" {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.emit("reload-requested", false);
                }
            } else if id == "force_reload" {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.emit("reload-requested", true);
                }
            } else if id == "zoom_in" {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let current = ZOOM_LEVEL.load(Ordering::Relaxed);
                    let next = std::cmp::min(300, current + 10);
                    ZOOM_LEVEL.store(next, Ordering::Relaxed);
                    let _ = window.set_zoom(next as f64 / 100.0);
                }
            } else if id == "zoom_out" {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let current = ZOOM_LEVEL.load(Ordering::Relaxed);
                    let next = std::cmp::max(50, current - 10);
                    ZOOM_LEVEL.store(next, Ordering::Relaxed);
                    let _ = window.set_zoom(next as f64 / 100.0);
                }
            } else if id == "zoom_reset" {
                if let Some(window) = app_handle.get_webview_window("main") {
                    ZOOM_LEVEL.store(100, Ordering::Relaxed);
                    let _ = window.set_zoom(1.0);
                }
            } else if id == "toggle_devtools" {
                #[cfg(debug_assertions)]
                if let Some(window) = app_handle.get_webview_window("main") {
                    if window.is_devtools_open() {
                        window.close_devtools();
                    } else {
                        window.open_devtools();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            apply_app_menu,
            open_config,
            open_log,
            open_cert_dir,
            launch_codex_login_script,
            select_directory_native,
            get_proxy_debug,
            get_cert_status_native,
            get_management_token_native,
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
