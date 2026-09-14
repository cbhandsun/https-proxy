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
}
