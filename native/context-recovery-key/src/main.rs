fn main() {
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
