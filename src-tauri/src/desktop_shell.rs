use std::path::Path;

use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::app_shortcuts::maybe_execute_app_shortcut;
use crate::proxy_root::find_project_root;
use crate::stop_proxy_for_exit;
use crate::{
    execute_proxy_command_blocking, hide_console_window, proxy_runtime_dir, read_app_setting,
};

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
        use tauri::tray::TrayIconBuilder;

        let menu = crate::tray_menu::build_tray_menu(app.handle())?;

        let icon = app.default_window_icon().unwrap().clone();
        let tray = TrayIconBuilder::new()
            .icon(icon)
            .tooltip("HTTPS Proxy Manager")
            .menu(&menu)
            .on_menu_event(move |app_handle, event| {
                let id = event.id().as_ref();
                if let Some(action) = crate::tray_menu::parse_tray_action(id) {
                    crate::tray_menu::handle_tray_dynamic_action(app_handle, action);
                } else if id == "tray_show" {
                    show_main_window(app_handle);
                } else if id == "tray_start" {
                    run_tray_proxy_command(app_handle, "start");
                } else if id == "tray_stop" {
                    run_tray_proxy_command(app_handle, "stop");
                } else if id == "tray_restart" {
                    run_tray_proxy_command(app_handle, "restart");
                } else if id == "tray_status" {
                    show_main_window(app_handle);
                    run_tray_proxy_command(app_handle, "status");
                } else if id == "tray_quit" {
                    stop_proxy_for_exit();
                    app_handle.exit(0);
                }
            })
            .on_tray_icon_event(|tray, event| {
                if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                    show_main_window(tray.app_handle());
                }
            })
            .build(app)?;
        crate::tray_menu::remember_tray_id(tray.id().clone());
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

fn run_tray_proxy_command(app: &tauri::AppHandle, command: &'static str) {
    let app = app.clone();
    std::thread::spawn(move || {
        let result = execute_proxy_command_blocking(command.to_string());
        let receipt = crate::proxy_process::tray_command_receipt(command, result);
        if read_app_setting("showWindowOnTrayCommand", true) || command == "status" {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.emit("tray-command", receipt);
            }
        }
    });
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
        stop_proxy_for_exit();
        app_handle.exit(0);
    } else {
        maybe_execute_app_shortcut(app_handle, id);
    }
}
