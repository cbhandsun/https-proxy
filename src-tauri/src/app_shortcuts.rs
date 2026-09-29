use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{Emitter, Manager};

static ZOOM_LEVEL: AtomicU32 = AtomicU32::new(100);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AppShortcutAction {
    Reload,
    ForceReload,
    ZoomIn,
    ZoomOut,
    ZoomReset,
    ToggleDevtools,
}

fn parse_app_shortcut_action(value: &str) -> Result<AppShortcutAction, String> {
    match value {
        "reload" => Ok(AppShortcutAction::Reload),
        "force_reload" => Ok(AppShortcutAction::ForceReload),
        "zoom_in" => Ok(AppShortcutAction::ZoomIn),
        "zoom_out" => Ok(AppShortcutAction::ZoomOut),
        "zoom_reset" => Ok(AppShortcutAction::ZoomReset),
        "toggle_devtools" => Ok(AppShortcutAction::ToggleDevtools),
        "" => Err("Shortcut action is required".to_string()),
        _ => Err("Unsupported shortcut action".to_string()),
    }
}

fn execute_app_shortcut_action(
    app_handle: &tauri::AppHandle,
    action: AppShortcutAction,
) -> Result<(), String> {
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "Main window is unavailable".to_string())?;
    match action {
        AppShortcutAction::Reload => window
            .emit("reload-requested", false)
            .map_err(|error| error.to_string()),
        AppShortcutAction::ForceReload => window
            .emit("reload-requested", true)
            .map_err(|error| error.to_string()),
        AppShortcutAction::ZoomIn => {
            let current = ZOOM_LEVEL.load(Ordering::Relaxed);
            let next = std::cmp::min(300, current.saturating_add(10));
            window
                .set_zoom(next as f64 / 100.0)
                .map_err(|error| error.to_string())?;
            ZOOM_LEVEL.store(next, Ordering::Relaxed);
            Ok(())
        }
        AppShortcutAction::ZoomOut => {
            let current = ZOOM_LEVEL.load(Ordering::Relaxed);
            let next = std::cmp::max(50, current.saturating_sub(10));
            window
                .set_zoom(next as f64 / 100.0)
                .map_err(|error| error.to_string())?;
            ZOOM_LEVEL.store(next, Ordering::Relaxed);
            Ok(())
        }
        AppShortcutAction::ZoomReset => {
            window.set_zoom(1.0).map_err(|error| error.to_string())?;
            ZOOM_LEVEL.store(100, Ordering::Relaxed);
            Ok(())
        }
        AppShortcutAction::ToggleDevtools => {
            if window.is_devtools_open() {
                window.close_devtools();
            } else {
                window.open_devtools();
            }
            Ok(())
        }
    }
}

pub(crate) fn maybe_execute_app_shortcut(app_handle: &tauri::AppHandle, action: &str) -> bool {
    let Ok(action) = parse_app_shortcut_action(action) else {
        return false;
    };
    let _ = execute_app_shortcut_action(app_handle, action);
    true
}

#[tauri::command]
pub(crate) fn execute_app_shortcut(
    app_handle: tauri::AppHandle,
    action: String,
) -> Result<(), String> {
    let action = parse_app_shortcut_action(&action)?;
    execute_app_shortcut_action(&app_handle, action)
}

#[cfg(test)]
mod tests {
    use super::{parse_app_shortcut_action, AppShortcutAction};

    #[test]
    fn accepts_only_supported_shortcut_actions() {
        assert_eq!(
            parse_app_shortcut_action("reload").unwrap(),
            AppShortcutAction::Reload
        );
        assert_eq!(
            parse_app_shortcut_action("force_reload").unwrap(),
            AppShortcutAction::ForceReload
        );
        assert_eq!(
            parse_app_shortcut_action("zoom_in").unwrap(),
            AppShortcutAction::ZoomIn
        );
        assert_eq!(
            parse_app_shortcut_action("zoom_out").unwrap(),
            AppShortcutAction::ZoomOut
        );
        assert_eq!(
            parse_app_shortcut_action("zoom_reset").unwrap(),
            AppShortcutAction::ZoomReset
        );
        assert_eq!(
            parse_app_shortcut_action("toggle_devtools").unwrap(),
            AppShortcutAction::ToggleDevtools
        );
    }

    #[test]
    fn rejects_empty_malformed_and_unbounded_shortcut_actions() {
        assert!(parse_app_shortcut_action("")
            .unwrap_err()
            .contains("required"));
        for value in [" zoom_in", "zoom_in ", "ZOOM_IN", "zoom_in;quit"] {
            assert!(parse_app_shortcut_action(value)
                .unwrap_err()
                .contains("Unsupported"));
        }
        assert!(parse_app_shortcut_action(&"x".repeat(4096))
            .unwrap_err()
            .contains("Unsupported"));
    }
}
