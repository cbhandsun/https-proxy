//! Explicit diagnostic mode; the ordinary anchor command remains unchanged.
#[cfg(any(windows, test))]
use super::{execute, parse, Backend, MAX_IO};
use std::io::{Read, Write};
#[cfg(any(windows, test))]
use std::time::Instant;

#[cfg(any(windows, test))]
struct TimedBackend<'a, B> {
    backend: &'a mut B,
    stages: Vec<serde_json::Value>,
    reads: usize,
}
#[cfg(any(windows, test))]
impl<B: Backend> TimedBackend<'_, B> {
    fn measured<T>(
        &mut self,
        phase: &'static str,
        action: impl FnOnce(&mut B) -> Result<T, ()>,
    ) -> Result<T, ()> {
        let started = Instant::now();
        let result = action(self.backend);
        self.stages.push(serde_json::json!({
            "stage":phase,
            "elapsedMs":started.elapsed().as_millis(),
        }));
        result
    }
}
#[cfg(any(windows, test))]
impl<B: Backend> Backend for TimedBackend<'_, B> {
    fn acquire(&mut self, slot: &str) -> Result<(), ()> {
        self.measured("acquire", |backend| backend.acquire(slot))
    }
    fn read(&mut self, slot: &str) -> Result<Option<Vec<u8>>, ()> {
        let phase = if self.reads == 0 { "read" } else { "readback" };
        self.reads += 1;
        self.measured(phase, |backend| backend.read(slot))
    }
    fn write(&mut self, slot: &str, record: &[u8]) -> Result<(), ()> {
        self.measured("write", |backend| backend.write(slot, record))
    }
    fn flush(&mut self) -> Result<(), ()> {
        self.measured("flush", Backend::flush)
    }
}

#[cfg(any(windows, test))]
fn run_with_backend<R: Read, W: Write, D: Write>(
    reader: R,
    mut writer: W,
    mut diagnostic: D,
    mut backend: impl Backend,
) -> bool {
    let started = Instant::now();
    let (result, stages) = {
        let mut timed = TimedBackend {
            backend: &mut backend,
            stages: Vec::with_capacity(5),
            reads: 0,
        };
        let mut input = Vec::new();
        let result = reader
            .take(MAX_IO as u64 + 1)
            .read_to_end(&mut input)
            .map_err(|_| ())
            .and_then(|_| parse(&input))
            .and_then(|request| execute(request, &mut timed));
        (result, timed.stages)
    };
    // Match ordinary process(): release the registry handles and mutex before
    // writing the reply. Observation must not extend ownership past execution.
    drop(backend);
    let success = result.is_ok();
    let output = result.unwrap_or_else(|_| "{\"ok\":false}".to_owned());
    let report = serde_json::json!({
        "schemaVersion":1,
        "elapsedMs":started.elapsed().as_millis(),
        "stages":stages,
    });
    // Never include the request, slot, ciphertext, paths or underlying errors.
    let report = report.to_string();
    report.len() <= 1024
        && diagnostic.write_all(report.as_bytes()).is_ok()
        && writer.write_all(output.as_bytes()).is_ok()
        && success
}

#[cfg(windows)]
pub fn run<R: Read, W: Write, D: Write>(reader: R, writer: W, diagnostic: D) -> bool {
    run_with_backend(
        reader,
        writer,
        diagnostic,
        super::windows::RegistryBackend::new(),
    )
}
#[cfg(not(windows))]
pub fn run<R: Read, W: Write, D: Write>(_reader: R, mut writer: W, _diagnostic: D) -> bool {
    let _ = writer.write_all(b"{\"ok\":false}");
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anchor::tests::{request, Mock};
    use base64::{engine::general_purpose::STANDARD, Engine};

    impl Backend for &mut Mock {
        fn acquire(&mut self, slot: &str) -> Result<(), ()> {
            Backend::acquire(&mut **self, slot)
        }
        fn read(&mut self, slot: &str) -> Result<Option<Vec<u8>>, ()> {
            Backend::read(&mut **self, slot)
        }
        fn write(&mut self, slot: &str, record: &[u8]) -> Result<(), ()> {
            Backend::write(&mut **self, slot, record)
        }
        fn flush(&mut self) -> Result<(), ()> {
            Backend::flush(&mut **self)
        }
    }
    fn compare() -> Vec<u8> {
        serde_json::json!({"operation":"compare","slot":"a".repeat(64),"expectedRevision":0,"value":STANDARD.encode([42])}).to_string().into_bytes()
    }
    #[test]
    fn diagnostic_preserves_exact_reply_and_all_five_backend_steps() {
        let mut expected = Mock::default();
        let reply = execute(request("compare", 0), &mut expected).unwrap();
        let mut backend = Mock::default();
        let (mut output, mut rows) = (Vec::new(), Vec::new());
        assert!(run_with_backend(
            compare().as_slice(),
            &mut output,
            &mut rows,
            &mut backend
        ));
        assert_eq!(output, reply.as_bytes());
        assert_eq!(backend.writes, 1);
        assert_eq!(backend.flushes, 1);
        assert_eq!(backend.reads, 2);
        let value: serde_json::Value = serde_json::from_slice(&rows).unwrap();
        let phases: Vec<_> = value["stages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["stage"].as_str().unwrap())
            .collect();
        assert_eq!(phases, ["acquire", "read", "write", "flush", "readback"]);
        assert!(!String::from_utf8(rows).unwrap().contains("Kg=="));
    }
    #[test]
    fn diagnostic_keeps_failures_closed_and_reports_only_attempted_steps() {
        for fail in ["lock", "read", "write", "flush", "readback", "mismatch"] {
            let mut backend = Mock {
                fail: Some(fail),
                ..Mock::default()
            };
            let (mut output, mut rows) = (Vec::new(), Vec::new());
            assert!(!run_with_backend(
                compare().as_slice(),
                &mut output,
                &mut rows,
                &mut backend
            ));
            assert_eq!(output, b"{\"ok\":false}");
            assert!(rows.len() <= 1024);
            let report: serde_json::Value = serde_json::from_slice(&rows).unwrap();
            assert!(report["stages"].as_array().unwrap().len() <= 5);
        }
    }
    #[test]
    fn read_is_observed_without_mutation_and_stale_cas_still_fails() {
        let input = serde_json::json!({"operation":"read","slot":"a".repeat(64)}).to_string();
        let mut backend = Mock::default();
        let (mut output, mut rows) = (Vec::new(), Vec::new());
        assert!(run_with_backend(
            input.as_bytes(),
            &mut output,
            &mut rows,
            &mut backend
        ));
        assert_eq!(backend.writes, 0);
        assert_eq!(backend.flushes, 0);
        let report: serde_json::Value = serde_json::from_slice(&rows).unwrap();
        assert_eq!(report["stages"].as_array().unwrap().len(), 2);
        assert_eq!(output, b"{\"ok\":true,\"revision\":0,\"value\":null}");
        assert!(run_with_backend(
            compare().as_slice(),
            Vec::new(),
            Vec::new(),
            &mut backend
        ));
        assert!(!run_with_backend(
            compare().as_slice(),
            Vec::new(),
            Vec::new(),
            &mut backend
        ));
        assert_eq!(backend.writes, 1);
    }
    #[test]
    fn broken_diagnostic_or_reply_writer_never_returns_success_after_durable_commit() {
        struct Refused;
        impl Write for Refused {
            fn write(&mut self, _bytes: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("PRIVATE"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        for diagnostic_fails in [true, false] {
            let mut backend = Mock::default();
            let success = if diagnostic_fails {
                run_with_backend(compare().as_slice(), Vec::new(), Refused, &mut backend)
            } else {
                run_with_backend(compare().as_slice(), Refused, Vec::new(), &mut backend)
            };
            assert!(!success);
            assert_eq!(backend.writes, 1);
            assert_eq!(backend.flushes, 1);
        }
    }
    #[test]
    fn native_ownership_is_released_before_diagnostic_and_reply_writes() {
        use std::cell::Cell;
        use std::rc::Rc;
        struct Owned {
            released: Rc<Cell<bool>>,
            mock: Mock,
        }
        impl Backend for Owned {
            fn acquire(&mut self, slot: &str) -> Result<(), ()> {
                self.mock.acquire(slot)
            }
            fn read(&mut self, slot: &str) -> Result<Option<Vec<u8>>, ()> {
                self.mock.read(slot)
            }
            fn write(&mut self, slot: &str, record: &[u8]) -> Result<(), ()> {
                self.mock.write(slot, record)
            }
            fn flush(&mut self) -> Result<(), ()> {
                self.mock.flush()
            }
        }
        impl Drop for Owned {
            fn drop(&mut self) {
                self.released.set(true);
            }
        }
        struct Output(Rc<Cell<bool>>);
        impl Write for Output {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                assert!(self.0.get());
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let released = Rc::new(Cell::new(false));
        assert!(run_with_backend(
            compare().as_slice(),
            Output(released.clone()),
            Output(released.clone()),
            Owned {
                released,
                mock: Mock::default()
            }
        ));
    }
    #[test]
    fn malformed_empty_and_oversized_input_never_reach_backend() {
        for input in [Vec::new(), b"PRIVATE".to_vec(), vec![b'x'; MAX_IO + 1]] {
            let mut backend = Mock::default();
            let (mut output, mut rows) = (Vec::new(), Vec::new());
            assert!(!run_with_backend(
                input.as_slice(),
                &mut output,
                &mut rows,
                &mut backend
            ));
            assert_eq!(backend.reads, 0);
            assert_eq!(backend.writes, 0);
            let report: serde_json::Value = serde_json::from_slice(&rows).unwrap();
            assert_eq!(report["stages"], serde_json::json!([]));
        }
    }
}
