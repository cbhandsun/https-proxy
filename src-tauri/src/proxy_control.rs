use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::io::{Read, Write};

const FLAG: &str = "--hpm-proxy-control-v1";
const MAX_INPUT: u64 = 1024;
const FAILURE: &str = "proxy_control_failed";

fn failure_phase(result: &Result<serde_json::Value, String>) -> &'static str {
    match result {
        Err(error) if error == "project root not found" => "root_unavailable",
        Err(error) if error.starts_with("failed to start node proxy directly:") => "launch_failed",
        Err(error) if error.starts_with("direct proxy process exited early:") => "child_exited",
        Err(error) if error == "proxy_start_owner_mismatch" => "owner_mismatch",
        Ok(value) if value.get("timedOut").and_then(|v| v.as_bool()) == Some(true) => {
            "health_timeout"
        }
        _ => "command_unconfirmed",
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Command {
    Start,
    Stop,
    Restart,
    Status,
}
impl Command {
    fn name(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
            Self::Status => "status",
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    command: Command,
}
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    schema_version: u8,
    command: Command,
    ok: bool,
    graceful_drain: bool,
}

fn control_arguments(args: &[OsString]) -> Option<Result<(), &'static str>> {
    let first = args.first()?;
    if !first
        .to_string_lossy()
        .trim()
        .to_ascii_lowercase()
        .starts_with("--hpm-proxy-control")
    {
        return None;
    }
    Some(if args.len() == 1 && first == FLAG {
        Ok(())
    } else {
        Err(FAILURE)
    })
}

fn execute_control(
    bytes: &[u8],
    execute: impl FnOnce(String) -> Result<serde_json::Value, String>,
) -> Result<Receipt, &'static str> {
    if bytes.len() > MAX_INPUT as usize {
        return Err(FAILURE);
    }
    let request: Request = serde_json::from_slice(bytes).map_err(|_| FAILURE)?;
    let result = execute(request.command.name().to_string());
    let valid = result.as_ref().is_ok_and(|value| {
        value.get("code").and_then(|v| v.as_i64()) == Some(0)
            && value.get("direct").and_then(|v| v.as_bool()) == Some(true)
            && value.get("timedOut").and_then(|v| v.as_bool()) == Some(false)
    });
    let drained = valid
        && request.command == Command::Stop
        && result
            .as_ref()
            .is_ok_and(|v| v.get("gracefulDrain").and_then(|v| v.as_bool()) == Some(true));
    // Only finite capability results cross stdout. Never forward output, errors,
    // health, directories, tokens or native replies from the desktop command.
    Ok(Receipt {
        schema_version: 1,
        command: request.command,
        ok: valid,
        graceful_drain: drained,
    })
}

fn control_io(
    input: impl Read,
    mut output: impl Write,
    execute: impl FnOnce(String) -> Result<serde_json::Value, String>,
) -> Result<bool, &'static str> {
    let mut bytes = Vec::new();
    input
        .take(MAX_INPUT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| FAILURE)?;
    let receipt = execute_control(&bytes, execute)?;
    serde_json::to_writer(&mut output, &receipt).map_err(|_| FAILURE)?;
    output.write_all(b"\n").map_err(|_| FAILURE)?;
    output.flush().map_err(|_| FAILURE)?;
    Ok(receipt.ok)
}

// Same fixed command coordinator as desktop and tray, rooted by the executable
// through the existing resolver. No directory, port, token or executable input.
// This headless entry needs no WebView and grants no additional management auth.
pub fn run_from_process_args() -> bool {
    let args: Vec<_> = std::env::args_os().skip(1).take(2).collect();
    let Some(arguments) = control_arguments(&args) else {
        return false;
    };
    let mut phase = "request_rejected";
    let result = arguments.and_then(|()| {
        super::proxy_control_stdio::isolate_control_stdio().map_err(|_| FAILURE)?;
        control_io(
            std::io::stdin().lock(),
            std::io::stdout().lock(),
            |command| {
                let reply = super::execute_proxy_command_blocking(command);
                phase = failure_phase(&reply);
                reply
            },
        )
    });
    if result != Ok(true) {
        let _ = std::io::stderr()
            .lock()
            .write_all(b"proxy_control_failed\n");
        let _ = writeln!(std::io::stderr().lock(), "proxy_control_phase={phase}");
        std::process::exit(1);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failure_diagnostics_are_closed_values_and_never_forward_command_errors() {
        for (error, expected) in [
            ("project root not found", "root_unavailable"),
            (
                "failed to start node proxy directly: PRIVATE",
                "launch_failed",
            ),
            ("direct proxy process exited early: PRIVATE", "child_exited"),
            ("proxy_start_owner_mismatch", "owner_mismatch"),
            (
                "PRIVATE\nproxy_control_phase=child_exited",
                "command_unconfirmed",
            ),
            ("", "command_unconfirmed"),
        ] {
            assert_eq!(failure_phase(&Err(error.into())), expected);
        }
        assert_eq!(
            failure_phase(&Ok(serde_json::json!({"timedOut":true,"output":"PRIVATE"}))),
            "health_timeout"
        );
        for value in [
            serde_json::Value::Null,
            serde_json::json!({}),
            serde_json::json!({"timedOut":"PRIVATE"}),
        ] {
            assert_eq!(failure_phase(&Ok(value)), "command_unconfirmed");
        }
    }
    #[test]
    fn controller_flags_are_exact_and_reject_invalid_versions_without_launching_gui() {
        assert_eq!(control_arguments(&[]), None);
        assert_eq!(control_arguments(&[OsString::from("unrelated")]), None);
        assert_eq!(control_arguments(&[OsString::from(FLAG)]), Some(Ok(())));
        for args in [
            vec![OsString::from("--hpm-proxy-control-v2")],
            vec![OsString::from("--HPM-PROXY-CONTROL-V1")],
            vec![OsString::from(" --hpm-proxy-control-v1")],
            vec![OsString::from(FLAG), OsString::from("directory")],
            vec![OsString::from("--hpm-proxy-control-v1\nprivate")],
        ] {
            assert_eq!(control_arguments(&args), Some(Err(FAILURE)));
        }
    }
    #[test]
    fn controls_only_fixed_commands_and_never_forwards_private_results() {
        for command in ["start", "stop", "restart", "status"] {
            let mut output = Vec::new();
            let input = format!("{{\"command\":\"{command}\"}}");
            assert_eq!(
                control_io(input.as_bytes(), &mut output, |actual| {
                    assert_eq!(actual, command);
                    Ok(
                        serde_json::json!({"code":0,"direct":true,"timedOut":false,"gracefulDrain":true,"output":"PRIVATE_OUTPUT"}),
                    )
                }),
                Ok(true)
            );
            let value: serde_json::Value = serde_json::from_slice(&output).unwrap();
            assert_eq!(value["schemaVersion"], 1);
            assert_eq!(value["command"], command);
            assert_eq!(value["ok"], true);
            assert_eq!(value["gracefulDrain"], command == "stop");
            assert!(!String::from_utf8(output)
                .unwrap()
                .contains("PRIVATE_OUTPUT"));
        }
    }
    #[test]
    fn invalid_empty_extreme_and_injected_input_never_executes() {
        for input in [
            b"".to_vec(),
            b"null".to_vec(),
            b"[]".to_vec(),
            b"{}".to_vec(),
            vec![0xff],
            vec![b' '; 1025],
            br#"{"command":"stop","command":"start"}"#.to_vec(),
            br#"{"command":"stop","directory":"private"}"#.to_vec(),
            br#"{"command":"stop & private"}"#.to_vec(),
            br#"{"command":false}"#.to_vec(),
        ] {
            assert_eq!(
                execute_control(&input, |_| panic!("invalid request executed")),
                Err(FAILURE)
            );
        }
        let mut exact = br#"{"command":"status"}"#.to_vec();
        exact.resize(1024, b' ');
        assert!(
            execute_control(&exact, |_| Ok(
                serde_json::json!({"code":0,"direct":true,"timedOut":false})
            ))
            .unwrap()
            .ok
        );
    }
    #[test]
    fn failures_timeouts_and_missing_confirmation_cannot_claim_success() {
        for result in [
            Err("PRIVATE_FAILURE".into()),
            Ok(serde_json::Value::Null),
            Ok(serde_json::json!({"code":0})),
            Ok(serde_json::json!({"code":0,"direct":true,"timedOut":true})),
            Ok(serde_json::json!({"code":1,"direct":true,"timedOut":false})),
        ] {
            let receipt = execute_control(br#"{"command":"stop"}"#, |_| result).unwrap();
            assert!(!receipt.ok && !receipt.graceful_drain);
        }
        let receipt = execute_control(br#"{"command":"stop"}"#, |_| {
            Ok(serde_json::json!({"code":0,"direct":true,"timedOut":false}))
        })
        .unwrap();
        assert!(receipt.ok && !receipt.graceful_drain);
    }
    #[test]
    fn input_output_failures_return_failure_instead_of_qualifying() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("private"))
            }
        }
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("private"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Err(std::io::Error::other("private"))
            }
        }
        assert_eq!(
            control_io(Broken, Vec::new(), |_| panic!("broken input executed")),
            Err(FAILURE)
        );
        assert_eq!(
            control_io(&br#"{"command":"status"}"#[..], Broken, |_| Ok(
                serde_json::json!({"code":0,"direct":true,"timedOut":false})
            )),
            Err(FAILURE)
        );
    }
}
