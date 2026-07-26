use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub(crate) const CODEX_LOGIN_SCRIPT_FILE_NAME: &str = "hpm-codex-official-login.ps1";

fn user_home_dir() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "Unable to resolve the current user home directory".to_string())
}

pub(crate) fn codex_login_script_path(home_dir: &Path) -> PathBuf {
    home_dir.join(".codex").join(CODEX_LOGIN_SCRIPT_FILE_NAME)
}

pub(crate) fn validate_codex_login_script_file(path: &Path) -> Result<PathBuf, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| format!("Codex login script not found: {}", path.display()))?;
    if !metadata.is_file() {
        return Err("Codex login script must be a regular file".to_string());
    }
    if metadata.file_type().is_symlink() {
        return Err("Codex login script must not be a symbolic link".to_string());
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x00000400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("Codex login script must not be a reparse point".to_string());
        }
    }

    path.canonicalize()
        .map_err(|err| format!("Failed to resolve Codex login script: {err}"))
}

#[tauri::command]
pub(crate) fn launch_codex_login_script() -> Result<serde_json::Value, String> {
    let expected_path = codex_login_script_path(&user_home_dir()?);
    let path = validate_codex_login_script_file(&expected_path)?;

    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoLogo", "-NoProfile", "-NoExit", "-File"])
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
        .map_err(|err| format!("Failed to launch Codex login script: {err}"))?;
    Ok(serde_json::json!({
        "pid": child.id(),
        "scriptPath": path
    }))
}
