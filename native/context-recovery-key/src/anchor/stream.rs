//! Bounded framing for a future owned, persistent anchor client. Each frame
//! still invokes the ordinary primitive with a fresh backend and releases all
//! registry handles before its reply. This is not enabled by the JS owner yet.
use super::{parse, process, MAX_IO};
use std::io::{ErrorKind, Read, Write};

fn serve<R: Read, W: Write>(
    mut reader: R,
    mut writer: W,
    mut execute: impl FnMut(&[u8]) -> Result<String, ()>,
) -> bool {
    let mut expected = 1u32;
    loop {
        let mut header = [0u8; 8];
        match reader.read(&mut header[..1]) {
            Ok(0) => return true, // EOF only at a frame boundary is a clean close.
            Ok(1) => (),
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            _ => return false,
        }
        if reader.read_exact(&mut header[1..]).is_err() {
            return false;
        }
        let sequence = u32::from_le_bytes(header[..4].try_into().unwrap());
        let length = u32::from_le_bytes(header[4..].try_into().unwrap()) as usize;
        if sequence != expected || length == 0 || length > MAX_IO {
            return false;
        }
        let Some(next) = expected.checked_add(1) else {
            return false;
        };
        let mut input = vec![0u8; length];
        if reader.read_exact(&mut input).is_err() {
            return false;
        }
        let result = execute(&input);
        let success = result.is_ok();
        let reply = result.unwrap_or_else(|_| "{\"ok\":false}".to_owned());
        if reply.is_empty() || reply.len() > MAX_IO {
            return false;
        }
        let length = (reply.len() as u32).to_le_bytes();
        if writer.write_all(&sequence.to_le_bytes()).is_err()
            || writer.write_all(&length).is_err()
            || writer.write_all(reply.as_bytes()).is_err()
            || writer.flush().is_err()
        {
            return false;
        }
        // A rejected CAS, malformed JSON or failed flush is terminal. Never
        // consume a queued next request or retry the failed operation.
        if !success {
            return false;
        }
        expected = next;
    }
}

pub fn run<R: Read, W: Write>(reader: R, writer: W) -> bool {
    serve(reader, writer, |input| parse(input).and_then(process))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anchor::{execute, tests::Mock, Backend};
    use std::cell::Cell;
    use std::io::{self, Cursor};
    use std::rc::Rc;

    fn frame(sequence: u32, value: &[u8]) -> Vec<u8> {
        let mut bytes = sequence.to_le_bytes().to_vec();
        bytes.extend_from_slice(&(value.len() as u32).to_le_bytes());
        bytes.extend_from_slice(value);
        bytes
    }

    #[test]
    fn ordinary_cas_flush_readback_and_lock_release_still_precede_each_reply() {
        struct Owned<'a> {
            backend: &'a mut Mock,
            released: Rc<Cell<bool>>,
            acquired: Rc<Cell<usize>>,
        }
        impl Backend for Owned<'_> {
            fn acquire(&mut self, slot: &str) -> Result<(), ()> {
                self.acquired.set(self.acquired.get() + 1);
                self.backend.acquire(slot)
            }
            fn read(&mut self, slot: &str) -> Result<Option<Vec<u8>>, ()> {
                self.backend.read(slot)
            }
            fn write(&mut self, slot: &str, value: &[u8]) -> Result<(), ()> {
                self.backend.write(slot, value)
            }
            fn flush(&mut self) -> Result<(), ()> {
                self.backend.flush()
            }
        }
        impl Drop for Owned<'_> {
            fn drop(&mut self) {
                self.released.set(true);
            }
        }
        struct Output {
            bytes: Vec<u8>,
            released: Rc<Cell<bool>>,
        }
        impl Write for Output {
            fn write(&mut self, value: &[u8]) -> io::Result<usize> {
                assert!(self.released.get(), "backend still owns lock during reply");
                self.bytes.extend_from_slice(value);
                Ok(value.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let read = serde_json::json!({"operation":"read","slot":"a".repeat(64)}).to_string();
        let compare = serde_json::json!({"operation":"compare","slot":"a".repeat(64),"expectedRevision":0,"value":"Kg=="}).to_string();
        let input = [
            frame(1, read.as_bytes()),
            frame(2, compare.as_bytes()),
            frame(3, compare.as_bytes()),
            frame(4, read.as_bytes()),
        ]
        .concat();
        let released = Rc::new(Cell::new(false));
        let acquired = Rc::new(Cell::new(0));
        let mut backend = Mock::default();
        let mut output = Output {
            bytes: Vec::new(),
            released: released.clone(),
        };
        assert!(!serve(input.as_slice(), &mut output, |input| {
            released.set(false);
            let request = parse(input)?;
            execute(
                request,
                &mut Owned {
                    backend: &mut backend,
                    released: released.clone(),
                    acquired: acquired.clone(),
                },
            )
        }));
        assert_eq!(acquired.get(), 3);
        assert_eq!(backend.writes, 1);
        assert_eq!(backend.flushes, 1);
        assert_eq!(backend.reads, 4);
        assert_eq!(
            output.bytes,
            [
                frame(1, br#"{"ok":true,"revision":0,"value":null}"#),
                frame(2, br#"{"ok":true,"revision":1,"value":"Kg=="}"#),
                frame(3, br#"{"ok":false}"#)
            ]
            .concat()
        );
    }

    #[test]
    fn ordinary_backend_failures_never_turn_into_a_successful_stream_ack() {
        let input=serde_json::json!({"operation":"compare","slot":"a".repeat(64),"expectedRevision":0,"value":"Kg=="}).to_string();
        for fail in ["lock", "read", "write", "flush", "readback", "mismatch"] {
            let mut backend = Mock {
                fail: Some(fail),
                ..Mock::default()
            };
            let mut output = Vec::new();
            let mut calls = 0;
            assert!(!serve(
                [frame(1, input.as_bytes()), frame(2, input.as_bytes())]
                    .concat()
                    .as_slice(),
                &mut output,
                |input| {
                    calls += 1;
                    execute(parse(input)?, &mut backend)
                }
            ));
            assert_eq!(calls, 1);
            assert_eq!(output, frame(1, br#"{"ok":false}"#));
        }
    }

    #[test]
    fn consecutive_frames_preserve_exact_replies_and_flush_each_ack() {
        #[derive(Default)]
        struct Output {
            bytes: Vec<u8>,
            flushes: usize,
        }
        impl Write for Output {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.bytes.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                self.flushes += 1;
                Ok(())
            }
        }
        let input = [frame(1, b"read"), frame(2, b"compare")].concat();
        let mut output = Output::default();
        let mut calls = 0;
        assert!(serve(input.as_slice(), &mut output, |request| {
            calls += 1;
            assert_eq!(
                request,
                if calls == 1 {
                    b"read".as_slice()
                } else {
                    b"compare"
                }
            );
            Ok(format!("{{\"ok\":true,\"revision\":{calls}}}"))
        }));
        assert_eq!(calls, 2);
        assert_eq!(output.flushes, 2);
        assert_eq!(
            output.bytes,
            [
                frame(1, br#"{"ok":true,"revision":1}"#),
                frame(2, br#"{"ok":true,"revision":2}"#)
            ]
            .concat()
        );
    }

    #[test]
    fn empty_stream_is_clean_but_every_partial_header_or_body_is_terminal() {
        let input = frame(1, b"request");
        let mut calls = 0;
        for end in 0..input.len() {
            let mut output = Vec::new();
            assert_eq!(
                serve(&input[..end], &mut output, |_| {
                    calls += 1;
                    Ok("reply".into())
                }),
                end == 0
            );
            assert!(output.is_empty());
        }
        assert_eq!(calls, 0);
    }

    #[test]
    fn zero_oversized_and_out_of_order_frames_never_reach_execution() {
        for bytes in [
            frame(0, b"x"),
            frame(2, b"x"),
            frame(u32::MAX, b"x"),
            frame(1, b""),
            [1u32.to_le_bytes(), (MAX_IO as u32 + 1).to_le_bytes()].concat(),
        ] {
            assert!(!serve(bytes.as_slice(), Vec::new(), |_| panic!(
                "must not execute"
            )));
        }
        let mut calls = 0;
        let bytes = [frame(1, b"x"), frame(1, b"x")].concat();
        assert!(!serve(bytes.as_slice(), Vec::new(), |_| {
            calls += 1;
            Ok("reply".into())
        }));
        assert_eq!(calls, 1);
    }

    #[test]
    fn maximum_frame_is_accepted_without_increasing_the_ordinary_limit() {
        let bytes = frame(1, &vec![b'x'; MAX_IO]);
        let mut output = Vec::new();
        assert!(serve(bytes.as_slice(), &mut output, |request| {
            assert_eq!(request.len(), MAX_IO);
            Ok("x".repeat(MAX_IO))
        }));
        assert_eq!(output, frame(1, &vec![b'x'; MAX_IO]));
        for value in [String::new(), "x".repeat(MAX_IO + 1)] {
            let mut output = Vec::new();
            assert!(!serve(frame(1, b"x").as_slice(), &mut output, |_| Ok(
                value.clone()
            )));
            assert!(output.is_empty());
        }
    }

    #[test]
    fn failure_replies_are_fixed_and_no_following_frame_is_executed() {
        let input = [frame(1, b"private malformed request"), frame(2, b"next")].concat();
        let mut calls = 0;
        let mut output = Vec::new();
        assert!(!serve(input.as_slice(), &mut output, |_| {
            calls += 1;
            Err(())
        }));
        assert_eq!(calls, 1);
        assert_eq!(output, frame(1, br#"{"ok":false}"#));
        for input in [
            b"null".as_slice(),
            b"{}",
            b"private",
            b"\xff",
            br#"{"operation":"read","slot":"invalid"}"#,
        ] {
            let mut output = Vec::new();
            assert!(!run(frame(1, input).as_slice(), &mut output));
            assert_eq!(output, frame(1, br#"{"ok":false}"#));
        }
    }

    #[test]
    fn fragmented_reads_and_short_writes_preserve_frame_boundaries() {
        struct Fragmented(Cursor<Vec<u8>>, bool);
        impl Read for Fragmented {
            fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
                self.1 = !self.1;
                if self.1 {
                    return Err(io::ErrorKind::Interrupted.into());
                }
                let length = bytes.len().min(1);
                self.0.read(&mut bytes[..length])
            }
        }
        struct Short(Vec<u8>);
        impl Write for Short {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.0.push(bytes[0]);
                Ok(1)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let mut output = Short(Vec::new());
        assert!(serve(
            Fragmented(Cursor::new(frame(1, b"x")), false),
            &mut output,
            |_| Ok("reply".into())
        ));
        assert_eq!(output.0, frame(1, b"reply"));
    }

    #[test]
    fn input_output_and_flush_failures_are_terminal_without_retries() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::ErrorKind::Other.into())
            }
        }
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::ErrorKind::Other.into())
            }
            fn flush(&mut self) -> io::Result<()> {
                Err(io::ErrorKind::Other.into())
            }
        }
        assert!(!serve(Broken, Vec::new(), |_| panic!("must not execute")));
        let mut calls = 0;
        assert!(!serve(frame(1, b"x").as_slice(), Broken, |_| {
            calls += 1;
            Ok("reply".into())
        }));
        assert_eq!(calls, 1);
        struct FlushFails(Vec<u8>);
        impl Write for FlushFails {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.0.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Err(io::ErrorKind::Other.into())
            }
        }
        assert!(!serve(
            frame(1, b"x").as_slice(),
            FlushFails(Vec::new()),
            |_| Ok("reply".into())
        ));
    }
}
