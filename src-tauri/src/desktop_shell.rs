use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::proxy_root::find_project_root;
use crate::{
    hide_console_window, proxy_runtime_dir, read_app_setting, run_proxy_bat, start_proxy_direct,
    stop_proxy_direct,
};

static ZOOM_LEVEL: AtomicU32 = AtomicU32::new(100);

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
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
pub(crate) fn apply_app_menu(window: tauri::Window, show: bool) -> Result<(), String> {
    if show {
        let menu = create_custom_menu(window.app_handle()).map_err(|error| error.to_string())?;
        window.set_menu(menu).map_err(|error| error.to_string())?;
        window.show_menu().map_err(|error| error.to_string())
    } else {
        let _ = window.hide_menu();
        let _ = window.remove_menu();
        Ok(())
    }
}

pub(crate) fn open_path(path: &Path) {
    let mut command = std::process::Command::new("cmd");
    command.arg("/c").arg("start").arg("").arg(path);
    hide_console_window(&mut command);
    let _ = command.spawn();
}

#[tauri::command]
pub(crate) fn open_config() {
    if let Some(root) = find_project_root() {
        open_path(&root.join("proxy.config.json"));
    } else {
        open_path(Path::new("proxy.config.json"));
    }
}

#[tauri::command]
pub(crate) fn open_log() {
    if let Some(root) = find_project_root() {
        open_path(&proxy_runtime_dir(&root).join("proxy.log"));
    } else {
        open_path(Path::new("proxy.log"));
    }
}

#[tauri::command]
pub(crate) fn open_cert_dir() {
    if let Some(root) = find_project_root() {
        open_path(&proxy_runtime_dir(&root).join(".certs"));
    } else {
        open_path(Path::new(".certs"));
    }
}

#[tauri::command]
pub(crate) async fn select_directory_native(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
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
                    .map_err(|error| format!("Failed to resolve selected directory: {error}"))?;
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
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn get_proxy_debug() -> serde_json::Value {
    let cwd = std::env::current_dir().unwrap_or_default();
    let executable = std::env::current_exe().unwrap_or_default();
    let manifest = env!("CARGO_MANIFEST_DIR");
    let root = find_project_root();
    let bat_exists = root
        .as_ref()
        .map(|candidate| candidate.join("proxy.bat").exists())
        .unwrap_or(false);
    serde_json::json!({
      "cwd": cwd.display().to_string(),
      "exe": executable.display().to_string(),
      "manifest_dir": manifest,
      "project_root": root.as_ref().map(|candidate| candidate.display().to_string()),
      "proxy_bat_found": bat_exists
    })
}

pub(crate) fn configure_desktop_shell(app: &mut tauri::App) -> Result<(), tauri::Error> {
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
        let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
        let quit_item = MenuItemBuilder::new("退出").id("tray_quit").build(app)?;

        let menu = MenuBuilder::new(app)
            .items(&[
                &show_item,
                &separator,
                &start_item,
                &stop_item,
                &restart_item,
                &tauri::menu::PredefinedMenuItem::separator(app)?,
                &status_item,
                &tauri::menu::PredefinedMenuItem::separator(app)?,
                &quit_item,
            ])
            .build()?;

        let icon = app.default_window_icon().unwrap().clone();
        let _tray = TrayIconBuilder::new()
            .icon(icon)
            .tooltip("HTTPS Proxy Manager")
            .menu(&menu)
            .on_menu_event(move |app_handle, event| {
                let id = event.id().as_ref();
                if id == "tray_show" {
                    show_main_window(app_handle);
                } else if id == "tray_start" {
                    std::thread::spawn(|| {
                        if start_proxy_direct().is_err() {
                            let _ = run_proxy_bat(&["start"]);
                        }
                    });
                    emit_tray_command(app_handle, "started");
                } else if id == "tray_stop" {
                    std::thread::spawn(|| {
                        if stop_proxy_direct().is_err() {
                            let _ = run_proxy_bat(&["stop"]);
                        }
                    });
                    emit_tray_command(app_handle, "stopped");
                } else if id == "tray_restart" {
                    std::thread::spawn(|| {
                        let _ = stop_proxy_direct();
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        if start_proxy_direct().is_err() {
                            let _ = run_proxy_bat(&["restart"]);
                        }
                    });
                    emit_tray_command(app_handle, "restarted");
                } else if id == "tray_status" {
                    show_main_window(app_handle);
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.emit("tray-command", "status");
                    }
                } else if id == "tray_quit" {
                    app_handle.exit(0);
                }
            })
            .on_tray_icon_event(|tray, event| {
                if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                    show_main_window(tray.app_handle());
                }
            })
            .build(app)?;
    }

    if let Some(window) = app.get_webview_window("main") {
        if let Some(icon) = app.default_window_icon() {
            let _ = window.set_icon(icon.clone());
        }
    }

    if read_app_setting("closeToTray", true) {
        let handle = app.handle().clone();
        if let Some(window) = app.get_webview_window("main") {
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
            });
        }
    }

    Ok(())
}

fn emit_tray_command(app: &tauri::AppHandle, command: &str) {
    if read_app_setting("showWindowOnTrayCommand", true) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
            let _ = window.emit("tray-command", command);
        }
    }
}

pub(crate) fn handle_app_menu_event(app_handle: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
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
}
