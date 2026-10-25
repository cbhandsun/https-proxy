#![cfg_attr(windows, windows_subsystem = "windows")]

#[path = "../src/proxy_control_stdio.rs"]
mod proxy_control_stdio;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const REQUEST: &[u8] = b"{\"command\":\"start\"}\n";
const RECEIPT: &[u8] =
    b"{\"schemaVersion\":1,\"command\":\"start\",\"ok\":true,\"gracefulDrain\":false}\n";
const CONTROL_DEADLINE: Duration = Duration::from_secs(12);
const DESCENDANT_LIFETIME: Duration = Duration::from_secs(13);

fn fixture(root: &Path, mode: &str) {
    assert!(matches!(mode, "baseline" | "sealed"));
    if mode == "sealed" {
        proxy_control_stdio::isolate_control_stdio().unwrap();
    }
    let mut request = Vec::new();
    std::io::stdin()
        .take(1025)
        .read_to_end(&mut request)
        .unwrap();
    assert_eq!(request, REQUEST);
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--owned-sleeper", mode])
        .env("HPM_PIPE_FIXTURE_ROOT", root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    // Same background lifetime as the product: exiting the control process
    // must not wait for this child or lend it the control response pipes.
    let mut background = command.spawn().unwrap();
    assert!(background.try_wait().unwrap().is_none());
    std::io::stdout().write_all(RECEIPT).unwrap();
    std::io::stdout().flush().unwrap();
}

fn exercise(root: &Path, mode: &str) {
    let started = Instant::now();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--owned-fixture", mode])
        .env_clear()
        .env("HPM_PIPE_FIXTURE_ROOT", root)
        .env("TEMP", root.parent().unwrap())
        .env("TMP", root.parent().unwrap())
        .env("TMPDIR", root.parent().unwrap())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in ["SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let mut child = command.spawn().unwrap();
    child.stdin.take().unwrap().write_all(REQUEST).unwrap();
    let (send, receive) = mpsc::channel();
    for (index, mut stream) in [
        (
            0,
            Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>,
        ),
        (
            1,
            Box::new(child.stderr.take().unwrap()) as Box<dyn Read + Send>,
        ),
    ] {
        let sender = send.clone();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = stream.by_ref().take(1025).read_to_end(&mut bytes);
            let _ = sender.send((index, result.is_ok(), bytes));
        });
    }
    drop(send);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() >= CONTROL_DEADLINE {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("owned control fixture did not exit within the original deadline");
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    assert!(
        status.success(),
        "owned control fixture exited unsuccessfully"
    );
    let mut replies = Vec::new();
    while replies.len() < 2 {
        let Some(remaining) = CONTROL_DEADLINE.checked_sub(started.elapsed()) else {
            break;
        };
        match receive.recv_timeout(remaining) {
            Ok(reply) => replies.push(reply),
            Err(mpsc::RecvTimeoutError::Timeout) => break,
            Err(_) => panic!("owned control pipe closed without a result"),
        }
    }
    let finished = root.join(format!("{mode}.finished"));
    if cfg!(windows) && mode == "baseline" {
        assert!(
            replies.len() < 2,
            "unsealed control did not expose inherited pipe lifetime"
        );
        // Cleanup observation only: the original 12-second call already failed.
        // The fixed 13-second descendant then supplies EOF naturally.
        while replies.len() < 2 {
            replies.push(receive.recv_timeout(Duration::from_secs(4)).unwrap());
        }
    } else {
        assert_eq!(
            replies.len(),
            2,
            "sealed response waited for the background child"
        );
        assert!(
            !finished.exists(),
            "response was observed only after background exit"
        );
    }
    replies.sort_by_key(|value| value.0);
    assert!(replies.iter().all(|value| value.1));
    assert_eq!(replies[0].2, RECEIPT);
    assert!(replies[1].2.is_empty());
    let cleanup = Instant::now();
    while !finished.exists() {
        assert!(
            cleanup.elapsed() < Duration::from_secs(15),
            "owned sleeper did not finish naturally"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(std::fs::read(finished).unwrap(), b"finished");
}

struct OwnedDirectory {
    root: PathBuf,
    removed: bool,
}
impl Drop for OwnedDirectory {
    fn drop(&mut self) {
        // Only a failing test uses best-effort cleanup. The passing path below
        // requires successful removal after both descendants finish naturally.
        if !self.removed {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if !args.is_empty() {
        assert_eq!(args.len(), 2);
        assert!(matches!(args[1].as_str(), "baseline" | "sealed"));
        let root = PathBuf::from(std::env::var_os("HPM_PIPE_FIXTURE_ROOT").unwrap());
        assert!(root.is_absolute() && root.is_dir());
        assert_eq!(root, std::fs::canonicalize(&root).unwrap());
        assert_eq!(
            root.parent().unwrap(),
            std::fs::canonicalize(std::env::temp_dir()).unwrap()
        );
        assert!(root
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("hpm-control-pipe-"));
        match args[0].as_str() {
            "--owned-fixture" => fixture(&root, &args[1]),
            "--owned-sleeper" => {
                std::thread::sleep(DESCENDANT_LIFETIME);
                let writing = root.join(format!("{}.writing", args[1]));
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&writing)
                    .unwrap();
                file.write_all(b"finished").unwrap();
                drop(file);
                std::fs::rename(writing, root.join(format!("{}.finished", args[1]))).unwrap();
            }
            _ => panic!("unrecognized owned fixture role"),
        }
        return;
    }
    let temporary = std::fs::canonicalize(std::env::temp_dir()).unwrap();
    let root = temporary.join(format!(
        "hpm-control-pipe-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    let mut owned = OwnedDirectory {
        root,
        removed: false,
    };
    exercise(&owned.root, "baseline");
    exercise(&owned.root, "sealed");
    std::fs::remove_dir_all(&owned.root).unwrap();
    owned.removed = true;
    println!("control_pipe_regression_passed: originalDeadlineMs=12000; cases=2; proxyStarts=0; modelRequests=0");
}
