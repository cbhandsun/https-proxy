use std::io::Write;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn frame(sequence: u32, value: &[u8]) -> Vec<u8> {
    let mut bytes = sequence.to_le_bytes().to_vec();
    bytes.extend_from_slice(&(value.len() as u32).to_le_bytes());
    bytes.extend_from_slice(value);
    bytes
}

fn run(args: &[&str], input: &[u8]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_hpm-context-recovery-key"));
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.env_clear();
    if cfg!(windows) {
        let root = std::env::var_os("SystemRoot").unwrap();
        command.env("SystemRoot", &root).env("WINDIR", root);
    }
    let mut child = command.spawn().unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("native stream did not terminate within original native deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    child.wait_with_output().unwrap()
}

fn request(operation: &str, revision: u64) -> Vec<u8> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let slot = format!(
        "{:032x}{:016x}{:016x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    serde_json::to_vec(&serde_json::json!({"operation":operation,"slot":slot,"expectedRevision":revision,"value":"Kg=="})).unwrap()
}

#[test]
fn actual_stream_preserves_registry_cas_and_exact_ack_versions_on_windows() {
    let mut compare: serde_json::Value = serde_json::from_slice(&request("compare", 0)).unwrap();
    let read = serde_json::to_vec(&serde_json::json!({"operation":"read","slot":compare["slot"]}))
        .unwrap();
    let first = serde_json::to_vec(&compare).unwrap();
    compare["expectedRevision"] = 1.into();
    compare["value"] = "Kw==".into();
    let second = serde_json::to_vec(&compare).unwrap();
    let input = [
        frame(1, &read),
        frame(2, &first),
        frame(3, &read),
        frame(4, &second),
        frame(5, &read),
    ]
    .concat();
    let output = run(&["--hpm-context-anchor-stream-v1"], &input);
    assert!(output.stderr.is_empty());
    if cfg!(windows) {
        assert!(output.status.success());
        assert_eq!(
            output.stdout,
            [
                frame(1, br#"{"ok":true,"revision":0,"value":null}"#),
                frame(2, br#"{"ok":true,"revision":1,"value":"Kg=="}"#),
                frame(3, br#"{"ok":true,"revision":1,"value":"Kg=="}"#),
                frame(4, br#"{"ok":true,"revision":2,"value":"Kw=="}"#),
                frame(5, br#"{"ok":true,"revision":2,"value":"Kw=="}"#)
            ]
            .concat()
        );
    } else {
        // A portable run proves the unsupported backend fails closed, not a
        // simulated registry qualification or a skipped Windows assertion.
        assert!(!output.status.success());
        assert_eq!(output.stdout, frame(1, br#"{"ok":false}"#));
    }
}

#[test]
fn actual_stream_stale_cas_is_terminal_and_never_processes_queued_work() {
    let compare = request("compare", 0);
    let output = run(
        &["--hpm-context-anchor-stream-v1"],
        &[frame(1, &compare), frame(2, &compare), frame(3, &compare)].concat(),
    );
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    let expected = if cfg!(windows) {
        [
            frame(1, br#"{"ok":true,"revision":1,"value":"Kg=="}"#),
            frame(2, br#"{"ok":false}"#),
        ]
        .concat()
    } else {
        frame(1, br#"{"ok":false}"#)
    };
    assert_eq!(output.stdout, expected);
}

#[test]
fn actual_stream_rejects_partial_extreme_or_unsequenced_frames_without_reply() {
    for input in [
        vec![1],
        vec![1; 7],
        frame(1, b""),
        frame(0, b"x"),
        frame(2, b"x"),
        [1u32.to_le_bytes(), 131073u32.to_le_bytes()].concat(),
        [frame(1, b"x")[..8].to_vec(), vec![]].concat(),
    ] {
        let output = run(&["--hpm-context-anchor-stream-v1"], &input);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());
    }
}

#[test]
fn empty_stream_closes_cleanly_and_ordinary_and_extra_arguments_remain_rejected() {
    let output = run(&["--hpm-context-anchor-stream-v1"], b"");
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
    for args in [
        &["--hpm-context-anchor-v1"][..],
        &["--hpm-context-anchor-stream-v1", "extra"][..],
    ] {
        let output = run(args, b"");
        assert!(!output.status.success());
        assert_eq!(output.stdout, br#"{"ok":false}"#);
        assert!(output.stderr.is_empty());
    }
}

#[test]
fn owned_stream_requires_lifetime_pipe_and_actual_worker_loss_interrupts_blocked_main() {
    for flag in [
        "--hpm-context-anchor-owned-stream-v1",
        "--hpm-context-anchor-owner-probe-v1",
    ] {
        let output = run(&[flag], b"");
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());
    }
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/helpers/context-recovery-anchor-owner-probe.cjs");
    let output = Command::new("node")
        .arg(fixture)
        .arg(env!("CARGO_BIN_EXE_hpm-context-recovery-key"))
        .output()
        .expect("Node 22 is required for the actual worker lifecycle integration");
    assert!(output.status.success(), "native owner lifecycle failed");
    assert!(output.stderr.is_empty());
    assert_eq!(output.stdout, b"native_owner_lifecycle_verified\n");
}
