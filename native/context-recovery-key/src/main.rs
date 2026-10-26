fn main() {
    if std::env::args_os().count() == 2
        && std::env::args_os().nth(1).as_deref()
            == Some(std::ffi::OsStr::new("--hpm-context-anchor-stream-v1"))
    {
        if !hpm_context_recovery_key::anchor::run_stream(std::io::stdin(), std::io::stdout()) {
            std::process::exit(1);
        }
        return;
    }
    if std::env::args_os().count() == 2
        && std::env::args_os().nth(1).as_deref()
            == Some(std::ffi::OsStr::new("--hpm-context-anchor-diagnostic-v1"))
    {
        if !hpm_context_recovery_key::anchor::run_diagnostic(
            std::io::stdin(),
            std::io::stdout(),
            std::io::stderr(),
        ) {
            std::process::exit(1);
        }
        return;
    }
    if std::env::args_os().count() == 2
        && std::env::args_os().nth(1).as_deref()
            == Some(std::ffi::OsStr::new("--hpm-profile-unprotect-v1"))
    {
        if !hpm_context_recovery_key::profile_secret::run_unprotect(
            std::io::stdin(),
            std::io::stdout(),
        ) {
            std::process::exit(1);
        }
        return;
    }
    if std::env::args_os().count() == 2
        && std::env::args_os().nth(1).as_deref()
            == Some(std::ffi::OsStr::new("--hpm-profile-secret-v1"))
    {
        if !hpm_context_recovery_key::profile_secret::run(std::io::stdin(), std::io::stdout()) {
            std::process::exit(1);
        }
        return;
    }
    if std::env::args_os().count() == 2
        && std::env::args_os().nth(1).as_deref()
            == Some(std::ffi::OsStr::new("--hpm-context-anchor-v1"))
    {
        if !hpm_context_recovery_key::anchor::run(std::io::stdin(), std::io::stdout()) {
            std::process::exit(1);
        }
        return;
    }
    if std::env::args_os().count() == 2
        && std::env::args_os().nth(1).as_deref()
            == Some(std::ffi::OsStr::new("--hpm-context-private-path-v1"))
    {
        if !hpm_context_recovery_key::private_path::run(std::io::stdin(), std::io::stdout()) {
            std::process::exit(1);
        }
        return;
    }
    let valid_args = std::env::args_os().count() == 2
        && std::env::args_os().nth(1).as_deref()
            == Some(std::ffi::OsStr::new("--hpm-context-key-v1"));
    if !hpm_context_recovery_key::run(valid_args, std::io::stdin(), std::io::stdout()) {
        std::process::exit(1);
    }
}
