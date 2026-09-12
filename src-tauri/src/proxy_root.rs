use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static PROJECT_ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
static RESOURCE_ROOT: OnceLock<PathBuf> = OnceLock::new();

pub(crate) fn set_resource_root(path: PathBuf) {
    let _ = RESOURCE_ROOT.set(path);
}

pub(crate) fn is_proxy_runtime_root(path: &Path) -> bool {
    path.join("proxy.bat").exists()
        && path.join("proxy.ps1").exists()
        && path.join("openai-proxy.js").exists()
        && path.join("lib").join("proxy").is_dir()
}

pub(crate) fn manifest_project_root() -> Option<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| {
            if is_proxy_runtime_root(path) {
                Some(path.to_path_buf())
            } else {
                None
            }
        })
}

fn path_is_under(path: &Path, parent: &Path) -> bool {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let parent = parent
        .canonicalize()
        .unwrap_or_else(|_| parent.to_path_buf());
    path.starts_with(parent)
}

fn local_target_release_root() -> Option<PathBuf> {
    let manifest_root = manifest_project_root()?;
    let executable = std::env::current_exe().ok()?;
    let target_dir = manifest_root.join("src-tauri").join("target");
    if path_is_under(&executable, &target_dir) {
        Some(manifest_root)
    } else {
        None
    }
}

fn push_proxy_root_ancestors(candidates: &mut Vec<PathBuf>, start: PathBuf) {
    let mut search = start;
    for _ in 0..6 {
        let candidate = if search.is_file() {
            search.parent().map(Path::to_path_buf)
        } else {
            Some(search.clone())
        };
        if let Some(path) = candidate {
            if is_proxy_runtime_root(&path) {
                candidates.push(path);
            }
        }
        if let Some(parent) = search.parent() {
            search = parent.to_path_buf();
        } else {
            break;
        }
    }
}

pub(crate) fn first_unique_existing_root(candidates: Vec<PathBuf>) -> Option<PathBuf> {
    let mut seen = HashSet::new();
    for candidate in candidates {
        let key = candidate
            .canonicalize()
            .unwrap_or_else(|_| candidate.clone())
            .to_string_lossy()
            .to_ascii_lowercase();
        if seen.insert(key) && is_proxy_runtime_root(&candidate) {
            return Some(candidate);
        }
    }
    None
}

pub(crate) fn select_release_root(
    executable: Option<PathBuf>,
    resource_root: Option<PathBuf>,
    current_dir: Option<PathBuf>,
    manifest_root: Option<PathBuf>,
) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(executable) = executable {
        push_proxy_root_ancestors(&mut candidates, executable);
    }
    if let Some(resource_root) = resource_root {
        push_proxy_root_ancestors(&mut candidates, resource_root);
    }
    if let Some(current_dir) = current_dir {
        push_proxy_root_ancestors(&mut candidates, current_dir);
    }
    if let Some(manifest_root) = manifest_root {
        candidates.push(manifest_root);
    }
    first_unique_existing_root(candidates)
}

/// Find the runtime root reliably.
///
/// Debug builds always bind to the source checkout so stale target/debug
/// copies cannot steal config, tokens, or certs. Release and portable builds
/// bind to the executable runtime before considering bundled resources or the
/// process working directory.
pub(crate) fn find_project_root() -> Option<PathBuf> {
    PROJECT_ROOT
        .get_or_init(|| {
            if cfg!(debug_assertions) {
                return manifest_project_root();
            }
            if let Some(local_root) = local_target_release_root() {
                return Some(local_root);
            }

            select_release_root(
                std::env::current_exe().ok(),
                RESOURCE_ROOT.get().cloned(),
                std::env::current_dir().ok(),
                manifest_project_root(),
            )
        })
        .clone()
}
pub(crate) fn proxy_runtime_dir(root: &Path) -> PathBuf {
    root.join(".hpm-runtime")
}

pub(crate) fn portable_runtime_dir(root: &Path) -> PathBuf {
    root.join("dist")
        .join("portable")
        .join("HTTPS Proxy Manager Portable")
        .join(".hpm-runtime")
}

pub(crate) fn management_token_candidates(root: &Path, port: u16) -> Vec<PathBuf> {
    let mut runtime_dirs = vec![
        proxy_runtime_dir(root),
        root.join("src-tauri")
            .join("target")
            .join("debug")
            .join(".hpm-runtime"),
        portable_runtime_dir(root),
    ];

    #[cfg(windows)]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        let installed_runtime = local_app_data
            .join("HTTPS Proxy Manager")
            .join(".hpm-runtime");
        if !runtime_dirs.iter().any(|d| d == &installed_runtime) {
            runtime_dirs.push(installed_runtime);
        }
    }

    if let Some(manifest_root) = manifest_project_root() {
        let manifest_runtime = proxy_runtime_dir(&manifest_root);
        if !runtime_dirs.iter().any(|d| d == &manifest_runtime) {
            runtime_dirs.push(manifest_runtime);
        }
    }

    let mut candidates = Vec::with_capacity(runtime_dirs.len() * 2);
    for dir in &runtime_dirs {
        candidates.push(dir.join(format!(".mgmt-token-{port}")));
    }
    for dir in &runtime_dirs {
        candidates.push(dir.join(".mgmt-token"));
    }
    candidates
}
