use std::path::Path;
use std::process::Command;

pub(crate) fn configure_node_environment(command: &mut Command, root: &Path, runtime_dir: &Path) {
    command
        .env("PROXY_CONFIG_DIR", root)
        .env("PROXY_RUNTIME_DIR", runtime_dir)
        .env(
            "NODE_COMPILE_CACHE",
            runtime_dir.join(".node-compile-cache"),
        )
        .env(
            "HPM_NATIVE_DPAPI_HELPER",
            std::env::current_exe().unwrap_or_default(),
        );
}

pub(crate) fn ensure_proxy_config_file(root: &Path) {
    let config = root.join("proxy.config.json");
    if config.exists() {
        return;
    }
    let example = root.join("proxy.config.example.json");
    if example.exists() {
        let _ = std::fs::copy(example, config);
    }
}

fn path_identity(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase()
}

pub(crate) fn proxy_health_matches_root(health: &serde_json::Value, root: &Path) -> bool {
    let Some(runtime) = health.get("runtime") else {
        return false;
    };
    let runtime_dir = runtime.get("runtimeDir").and_then(|v| v.as_str());
    let entrypoint = runtime.get("entrypoint").and_then(|v| v.as_str());
    runtime_dir
        .map(|value| path_identity(Path::new(value)) == path_identity(&root.join(".hpm-runtime")))
        .unwrap_or(false)
        && entrypoint
            .map(|value| {
                path_identity(Path::new(value)) == path_identity(&root.join("openai-proxy.js"))
            })
            .unwrap_or(false)
}

// Tray events have the same completed-result shape as direct frontend commands.
// A queued command or a rejected drain must never emit a success notification.
pub(crate) fn tray_command_receipt(
    command: &str,
    result: Result<serde_json::Value, String>,
) -> serde_json::Value {
    let allowed = matches!(command, "start" | "stop" | "restart" | "status");
    let mut reply = match result {
        Ok(serde_json::Value::Object(object)) if allowed &&
            object.get("code").and_then(|v| v.as_i64()) == Some(0) &&
            object.get("timedOut").and_then(|v| v.as_bool()) == Some(false) &&
            object.get("output").and_then(|v| v.as_str()).is_some() => object,
        _ => serde_json::json!({"code":1,"timedOut":false,"output":"Proxy command was not confirmed; check its current status."}).as_object().unwrap().clone(),
    };
    reply.insert(
        "command".into(),
        if allowed { command } else { "unknown" }.into(),
    );
    serde_json::Value::Object(reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configures_runtime_and_native_helper_environment() {
        let mut command = Command::new("node");
        configure_node_environment(&mut command, Path::new("root"), Path::new("runtime"));
        let variables: std::collections::HashMap<_, _> = command
            .get_envs()
            .filter_map(|(key, value)| value.map(|value| (key.to_owned(), value.to_owned())))
            .collect();
        assert_eq!(
            variables
                .get(std::ffi::OsStr::new("PROXY_CONFIG_DIR"))
                .unwrap(),
            "root"
        );
        assert_eq!(
            variables
                .get(std::ffi::OsStr::new("PROXY_RUNTIME_DIR"))
                .unwrap(),
            "runtime"
        );
        assert!(variables.contains_key(std::ffi::OsStr::new("HPM_NATIVE_DPAPI_HELPER")));
    }

    #[test]
    fn proxy_health_must_match_runtime_root_and_entrypoint() {
        let root =
            std::env::temp_dir().join(format!("hpm-proxy-process-health-{}", std::process::id()));
        let other = std::env::temp_dir().join(format!(
            "hpm-proxy-process-health-other-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
        std::fs::create_dir_all(root.join(".hpm-runtime")).unwrap();
        std::fs::write(root.join("openai-proxy.js"), "").unwrap();
        std::fs::create_dir_all(other.join(".hpm-runtime")).unwrap();
        std::fs::write(other.join("openai-proxy.js"), "").unwrap();

        let matching = serde_json::json!({
            "runtime": {
                "runtimeDir": root.join(".hpm-runtime"),
                "entrypoint": root.join("openai-proxy.js")
            }
        });
        assert!(proxy_health_matches_root(&matching, &root));

        let missing_runtime = serde_json::json!({ "pid": 1234 });
        assert!(!proxy_health_matches_root(&missing_runtime, &root));

        let mismatched = serde_json::json!({
            "runtime": {
                "runtimeDir": other.join(".hpm-runtime"),
                "entrypoint": other.join("openai-proxy.js")
            }
        });
        assert!(!proxy_health_matches_root(&mismatched, &root));
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(other);
    }
    #[test]
    fn tray_receipts_preserve_completed_results_and_never_announce_failed_or_malformed_success() {
        for command in ["start", "stop", "restart", "status"] {
            let receipt = tray_command_receipt(
                command,
                Ok(
                    serde_json::json!({"code":0,"timedOut":false,"output":"synthetic confirmed","gracefulDrain":true}),
                ),
            );
            assert_eq!(receipt["code"], 0);
            assert_eq!(receipt["command"], command);
            assert_eq!(receipt["gracefulDrain"], true);
            for result in [
                Err("PRIVATE_FAILURE".into()),
                Ok(serde_json::Value::Null),
                Ok(serde_json::json!({})),
                Ok(serde_json::json!({"code":1,"timedOut":false,"output":"PRIVATE_FAILURE"})),
                Ok(serde_json::json!({"code":0,"timedOut":true,"output":"PRIVATE_FAILURE"})),
                Ok(serde_json::json!({"code":0,"timedOut":false,"output":null})),
            ] {
                let receipt = tray_command_receipt(command, result);
                assert_eq!(receipt["code"], 1);
                assert_eq!(receipt["command"], command);
                assert!(!receipt.to_string().contains("PRIVATE_FAILURE"));
            }
        }
        assert_eq!(
            tray_command_receipt(
                "stop\r\nprivate",
                Ok(serde_json::json!({"code":0,"timedOut":false,"output":"private"}))
            )["command"],
            "unknown"
        );
    }
}
