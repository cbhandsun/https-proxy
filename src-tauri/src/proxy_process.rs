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
}
