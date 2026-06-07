use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

static ZOOM_LEVEL: AtomicU32 = AtomicU32::new(100);
static PROXY_STOPPED_FOR_EXIT: AtomicBool = AtomicBool::new(false);
const APP_ID: &str = "https-proxy-manager";

/// Cached project root (the directory containing proxy.bat).
static PROJECT_ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
static RESOURCE_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Find the project root reliably.
/// Primary: use CARGO_MANIFEST_DIR (baked at compile time → src-tauri/), go up one level.
/// Fallback: walk up from current_dir and current_exe.
fn find_project_root() -> Option<PathBuf> {
    PROJECT_ROOT
        .get_or_init(|| {
            if let Some(resource_root) = RESOURCE_ROOT.get() {
                if resource_root.join("proxy.bat").exists() {
                    return Some(resource_root.to_path_buf());
                }
            }

            // Strategy 1: compile-time path (most reliable in dev mode)
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            if let Some(parent) = manifest.parent() {
                if parent.join("proxy.bat").exists() {
                    return Some(parent.to_path_buf());
                }
            }

            // Strategy 2: walk up from current working directory
            if let Ok(start) = std::env::current_dir() {
                if start.join("proxy.bat").exists() {
                    return Some(start);
                }
                let mut search = start;
                for _ in 0..6 {
                    if let Some(p) = search.parent() {
                        if p.join("proxy.bat").exists() {
                            return Some(p.to_path_buf());
                        }
                        search = p.to_path_buf();
                    } else {
                        break;
                    }
                }
            }

            // Strategy 3: walk up from executable location
            if let Ok(exe) = std::env::current_exe() {
                let mut search = exe;
                for _ in 0..6 {
                    if let Some(p) = search.parent() {
                        if p.join("proxy.bat").exists() {
                            return Some(p.to_path_buf());
                        }
                        search = p.to_path_buf();
                    } else {
                        break;
                    }
                }
            }

            None
        })
        .clone()
}

/// Run `proxy.bat <args>` in the project root directory.
fn run_proxy_bat_with_timeout(args: &[&str], timeout: Duration) -> Option<(Output, bool)> {
    let root = find_project_root()?;
    let mut child = std::process::Command::new("cmd")
        .arg("/c")
        .arg("proxy.bat")
        .args(args)
        .env("NO_PAUSE", "1")
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;

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

fn read_proxy_health_direct(timeout: Duration) -> Option<serde_json::Value> {
    let addr = SocketAddr::new(
        IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
        proxy_management_port(),
    );
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
    let mut command = if bundled_node.exists() {
        Command::new(bundled_node)
    } else {
        Command::new("node")
    };
    command
        .arg(root.join("openai-proxy.js"))
        .env("PROXY_DATA_DIR", root)
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
    if let Some(health) = read_proxy_health_direct(Duration::from_millis(300)) {
        return Ok(serde_json::json!({
            "code": 0,
            "timedOut": false,
            "direct": true,
            "output": format!("Proxy already running.\n{}", format_proxy_status(&health))
        }));
    }

    let root = find_project_root().ok_or_else(|| "project root not found".to_string())?;
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

    Err("direct proxy start did not become healthy before timeout".into())
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
        let _ = std::fs::remove_file(root.join(".proxy.pid"));
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
        "status" => Some(Ok(match read_proxy_health_direct(Duration::from_millis(300)) {
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
        })),
        "stop" => Some(stop_proxy_direct()),
        "start" => Some(start_proxy_direct()),
        "restart" => Some((|| {
            let _ = stop_proxy_direct();
            std::thread::sleep(Duration::from_millis(250));
            start_proxy_direct()
        })()),
        _ => None,
    }
}

fn proxy_status_text() -> Option<String> {
    if let Some(health) = read_proxy_health_direct(Duration::from_millis(250)) {
        return Some(format_proxy_status(&health));
    }
    let out = run_proxy_bat(&["status"])?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    Some(format!("{}{}", stdout, stderr))
}

fn proxy_is_running() -> bool {
    if read_proxy_health_direct(Duration::from_millis(250)).is_some() {
        return true;
    }
    let Some(text) = proxy_status_text() else {
        return false;
    };
    text.contains("Running (PID")
        || text.contains("Proxy already running")
        || text.contains("Address:")
}

fn start_proxy_if_needed() {
    if proxy_is_running() {
        return;
    }
    if start_proxy_direct().is_err() {
        let _ = run_proxy_bat(&["start"]);
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

fn open_path(path: &str) {
    let _ = std::process::Command::new("cmd")
        .args(["/c", "start", "", path])
        .spawn();
}

#[tauri::command]
fn open_config() {
    open_path("proxy.config.json");
}

#[tauri::command]
fn open_log() {
    open_path("proxy.log");
}

#[tauri::command]
fn open_cert_dir() {
    open_path(".certs");
}

#[tauri::command]
fn launch_codex_login_script(script_path: String) -> Result<serde_json::Value, String> {
    let path = PathBuf::from(&script_path);
    if !path.exists() {
        return Err(format!("Codex login script not found: {}", script_path));
    }
    if path.extension().and_then(|ext| ext.to_str()).unwrap_or("") != "ps1" {
        return Err("Codex login script must be a .ps1 file".to_string());
    }

    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoExit", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x00000010;
        command.creation_flags(CREATE_NEW_CONSOLE);
    }

    let child = command
        .spawn()
        .map_err(|err| format!("Failed to launch Codex login script: {}", err))?;
    Ok(serde_json::json!({
        "pid": child.id(),
        "scriptPath": script_path
    }))
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
    RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(&path).is_ok()
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
    let cert_dir = root.join(".certs");
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
            "certDir": cert_dir.display().to_string()
        }),
        Err(error) => serde_json::json!({
            "ok": false,
            "source": "rust-native",
            "exists": exists,
            "trusted": false,
            "certDir": cert_dir.display().to_string(),
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
    if let Some(result) = proxy_command_direct(command.as_str()) {
        if result.is_ok() {
            return result;
        }
    }

    let timeout = match command.as_str() {
        "status" => Duration::from_secs(8),
        "stop" => Duration::from_secs(12),
        "start" => Duration::from_secs(25),
        "restart" => Duration::from_secs(35),
        _ => Duration::from_secs(20),
    };

    match run_proxy_bat_with_timeout(&[command.as_str()], timeout) {
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
                    .build(app)?;
                let stop_item = MenuItemBuilder::new("停止代理")
                    .id("tray_stop")
                    .build(app)?;
                let sep = tauri::menu::PredefinedMenuItem::separator(app)?;
                let quit_item = MenuItemBuilder::new("退出").id("tray_quit").build(app)?;

                let menu = MenuBuilder::new(app)
                    .items(&[
                        &show_item,
                        &sep,
                        &start_item,
                        &stop_item,
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

            // 自动启动代理（后台线程，不阻塞 UI 加载）
            if read_app_setting("autoStartProxy", true) {
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_millis(1200));
                    start_proxy_if_needed();
                });
            }

            Ok(())
        })
        .on_menu_event(move |app_handle, event| {
            let id = event.id().as_ref();
            if id == "open_config" {
                open_path("proxy.config.json");
            } else if id == "open_log" {
                open_path("proxy.log");
            } else if id == "open_cert_dir" {
                open_path(".certs");
            } else if id == "quit" {
                app_handle.exit(0);
            } else if id == "reload" {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.eval("window.location.reload()");
                }
            } else if id == "force_reload" {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.eval("window.location.reload(true)");
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
                        let _ = window.close_devtools();
                    } else {
                        let _ = window.open_devtools();
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
            get_proxy_debug,
            get_cert_status_native,
            execute_proxy_command
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
