use std::path::Path;

pub(crate) const WINDOWS_RUN_VALUE_NAME: &str = "HTTPS Proxy Manager";

pub(crate) fn windows_launch_command(exe: &Path) -> String {
    format!("\"{}\"", exe.display())
}

pub(crate) fn launch_command_matches_exe(value: &str, exe: &Path) -> bool {
    value
        .trim()
        .eq_ignore_ascii_case(&windows_launch_command(exe))
}

pub(crate) fn startup_value_matches_exe(value: Option<&str>, exe: &Path) -> bool {
    value.is_some_and(|current| launch_command_matches_exe(current, exe))
}

#[cfg(windows)]
pub(crate) fn read_launch_on_login() -> Result<bool, String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let exe =
        std::env::current_exe().map_err(|err| format!("current executable unavailable: {err}"))?;
    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let run_key = match current_user
        .open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Run", KEY_READ)
    {
        Ok(key) => key,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(format!("cannot read Windows startup settings: {err}")),
    };
    match run_key.get_value::<String, _>(WINDOWS_RUN_VALUE_NAME) {
        Ok(value) => Ok(startup_value_matches_exe(Some(&value), &exe)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Ok(startup_value_matches_exe(None, &exe))
        }
        Err(err) => Err(format!("cannot read Windows startup entry: {err}")),
    }
}

#[cfg(not(windows))]
pub(crate) fn read_launch_on_login() -> Result<bool, String> {
    Err("launch on login is only supported on Windows".to_string())
}

#[cfg(windows)]
fn write_launch_on_login(enabled: bool) -> Result<bool, String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let exe =
        std::env::current_exe().map_err(|err| format!("current executable unavailable: {err}"))?;
    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let (run_key, _) = current_user
        .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")
        .map_err(|err| format!("cannot open Windows startup settings: {err}"))?;
    if enabled {
        run_key
            .set_value(WINDOWS_RUN_VALUE_NAME, &windows_launch_command(&exe))
            .map_err(|err| format!("cannot enable launch on login: {err}"))?;
    } else {
        match run_key.delete_value(WINDOWS_RUN_VALUE_NAME) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("cannot disable launch on login: {err}")),
        }
    }
    read_launch_on_login()
}

#[cfg(not(windows))]
fn write_launch_on_login(_enabled: bool) -> Result<bool, String> {
    Err("launch on login is only supported on Windows".to_string())
}

#[tauri::command]
pub(crate) fn get_launch_on_login() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "supported": cfg!(windows),
        "enabled": read_launch_on_login()?
    }))
}

#[tauri::command]
pub(crate) fn set_launch_on_login(enabled: bool) -> Result<serde_json::Value, String> {
    let enabled = write_launch_on_login(enabled)?;
    Ok(serde_json::json!({ "supported": cfg!(windows), "enabled": enabled }))
}
