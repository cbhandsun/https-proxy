use super::*;
use std::fs;

fn unique_temp_dir(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("hpm-tauri-root-test-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn make_runtime_root(path: &Path) {
    fs::create_dir_all(path.join("lib").join("proxy")).unwrap();
    fs::write(path.join("proxy.bat"), "@echo off\r\n").unwrap();
    fs::write(path.join("proxy.ps1"), "").unwrap();
    fs::write(path.join("openai-proxy.js"), "").unwrap();
}

#[test]
fn codex_login_script_path_is_fixed_under_user_home() {
    let home = unique_temp_dir("codex-login-home");
    assert_eq!(
        codex_login_script_path(&home),
        home.join(".codex").join(CODEX_LOGIN_SCRIPT_FILE_NAME)
    );
    let _ = fs::remove_dir_all(home);
}

#[test]
fn codex_login_script_validation_requires_a_regular_file() {
    let home = unique_temp_dir("codex-login-validation");
    let script = codex_login_script_path(&home);
    fs::create_dir_all(script.parent().unwrap()).unwrap();

    assert!(validate_codex_login_script_file(&script)
        .unwrap_err()
        .contains("not found"));

    fs::create_dir(&script).unwrap();
    assert!(validate_codex_login_script_file(&script)
        .unwrap_err()
        .contains("regular file"));

    fs::remove_dir(&script).unwrap();
    fs::write(&script, "Write-Output 'login'\r\n").unwrap();
    assert_eq!(
        validate_codex_login_script_file(&script).unwrap(),
        script.canonicalize().unwrap()
    );
    let _ = fs::remove_dir_all(home);
}

#[test]
fn normalizes_allowed_proxy_commands() {
    assert_eq!(normalize_proxy_command("status").unwrap(), "status");
    assert_eq!(normalize_proxy_command(" START ").unwrap(), "start");
    assert_eq!(normalize_proxy_command("Stop").unwrap(), "stop");
    assert_eq!(normalize_proxy_command("restart").unwrap(), "restart");
}

#[test]
fn rejects_unsupported_proxy_commands() {
    assert!(normalize_proxy_command("")
        .unwrap_err()
        .contains("required"));
    assert!(normalize_proxy_command("health")
        .unwrap_err()
        .contains("unsupported"));
    assert!(normalize_proxy_command("status & calc")
        .unwrap_err()
        .contains("unsupported"));
}

#[test]
fn runtime_root_requires_backend_files() {
    let root = unique_temp_dir("incomplete");
    fs::write(root.join("proxy.bat"), "@echo off\r\n").unwrap();
    assert!(!is_proxy_runtime_root(&root));

    fs::write(root.join("proxy.ps1"), "").unwrap();
    fs::write(root.join("openai-proxy.js"), "").unwrap();
    fs::create_dir_all(root.join("lib")).unwrap();
    assert!(!is_proxy_runtime_root(&root));

    make_runtime_root(&root);
    assert!(is_proxy_runtime_root(&root));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn root_candidate_selection_deduplicates_and_preserves_order() {
    let first = unique_temp_dir("first");
    let second = unique_temp_dir("second");
    make_runtime_root(&first);
    make_runtime_root(&second);

    let selected = first_unique_existing_root(vec![first.clone(), first.clone(), second.clone()]);
    assert_eq!(selected, Some(first.clone()));

    let _ = fs::remove_dir_all(first);
    let _ = fs::remove_dir_all(second);
}

#[test]
fn startup_command_quotes_executable_paths_and_matches_case_insensitively() {
    let exe = Path::new(r"C:\Program Files\HTTPS Proxy Manager\app.exe");
    assert_eq!(
        windows_launch_command(exe),
        r#""C:\Program Files\HTTPS Proxy Manager\app.exe""#
    );
    assert!(launch_command_matches_exe(
        r#"  "c:\program files\https proxy manager\APP.EXE"  "#,
        exe
    ));
    assert!(!launch_command_matches_exe(r#""C:\Other\app.exe""#, exe));
}

#[test]
fn startup_value_matching_handles_missing_and_expected_values() {
    let exe = Path::new(r"C:\Program Files\HTTPS Proxy Manager\app.exe");
    assert!(!startup_value_matches_exe(None, exe));
    assert!(startup_value_matches_exe(
        Some(r#""C:\Program Files\HTTPS Proxy Manager\app.exe""#),
        exe
    ));
}
