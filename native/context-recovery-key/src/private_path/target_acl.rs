// Target-object admission only: an already exact protected DACL need not be
// reapplied. This does not promise to repair inheritance on existing children.
// In particular an exact parent can coexist with a mismatched unprotected
// descendant; skipping Set does not reapply its inherited ACEs. Each sensitive
// child still requires its own target admission, not trust in parent admission.
pub(super) struct TargetAcl {
    pub protected: bool,
    pub bytes: Option<Vec<u8>>,
}

fn exact(actual: &TargetAcl, expected: &[u8]) -> Result<bool, ()> {
    let Some(bytes) = &actual.bytes else {
        return Ok(false);
    };
    if !(8..=4096).contains(&bytes.len()) {
        return Err(());
    }
    Ok(actual.protected && bytes == expected)
}

pub(super) fn secure(
    expected: &[u8],
    mut read: impl FnMut() -> Result<TargetAcl, ()>,
    mut set: impl FnMut() -> Result<(), ()>,
) -> Result<(), ()> {
    if !(8..=4096).contains(&expected.len()) {
        return Err(());
    }
    if !exact(&read()?, expected)? {
        set()?;
    }
    // Even the no-write branch retains an independent final same-handle
    // readback; a changed DACL must never be accepted from the first read.
    if !exact(&read()?, expected)? {
        return Err(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::collections::VecDeque;

    const EXPECTED: [u8; 16] = [1; 16];

    fn acl(protected: bool, bytes: &[u8]) -> Result<TargetAcl, ()> {
        Ok(TargetAcl {
            protected,
            bytes: Some(bytes.to_vec()),
        })
    }

    fn scenario(
        reads: Vec<Result<TargetAcl, ()>>,
        set_result: Result<(), ()>,
    ) -> (Result<(), ()>, usize, usize) {
        let mut reads = VecDeque::from(reads);
        let read_count = Cell::new(0);
        let set_count = Cell::new(0);
        let result = secure(
            &EXPECTED,
            || {
                read_count.set(read_count.get() + 1);
                reads.pop_front().expect("unexpected read")
            },
            || {
                set_count.set(set_count.get() + 1);
                set_result
            },
        );
        (result, read_count.get(), set_count.get())
    }

    #[test]
    fn exact_protected_target_skips_set_but_reads_twice() {
        assert_eq!(
            scenario(vec![acl(true, &EXPECTED), acl(true, &EXPECTED)], Ok(())),
            (Ok(()), 2, 0)
        );
    }

    #[test]
    fn exact_parent_admission_does_not_claim_descendant_inheritance_repair() {
        let descendant_reapplied = Cell::new(false);
        assert_eq!(
            secure(
                &EXPECTED,
                || acl(true, &EXPECTED),
                || {
                    descendant_reapplied.set(true);
                    Ok(())
                }
            ),
            Ok(())
        );
        assert!(!descendant_reapplied.get());
    }

    #[test]
    fn unprotected_missing_extra_or_changed_ace_requires_set_and_readback() {
        for before in [
            acl(false, &EXPECTED),
            acl(true, &[1; 8]),
            acl(true, &[1; 24]),
            acl(true, &[2; 16]),
        ] {
            assert_eq!(
                scenario(vec![before, acl(true, &EXPECTED)], Ok(())),
                (Ok(()), 2, 1)
            );
        }
    }

    #[test]
    fn null_dacl_requires_original_repair_and_null_readback_is_rejected() {
        let null_acl = || {
            Ok(TargetAcl {
                protected: true,
                bytes: None,
            })
        };
        assert_eq!(
            scenario(vec![null_acl(), acl(true, &EXPECTED)], Ok(())),
            (Ok(()), 2, 1)
        );
        for protected in [false, true] {
            assert_eq!(
                scenario(vec![acl(protected, &EXPECTED), null_acl()], Ok(())),
                (Err(()), 2, usize::from(!protected))
            );
        }
    }

    #[test]
    fn read_or_malformed_acl_failure_never_sets_or_succeeds() {
        for before in [
            Err(()),
            acl(true, &[]),
            acl(true, &[1; 7]),
            acl(true, &[1; 4097]),
        ] {
            assert_eq!(scenario(vec![before], Ok(())), (Err(()), 1, 0));
        }
    }

    #[test]
    fn failed_set_never_reports_success_or_attempts_final_read() {
        assert_eq!(
            scenario(vec![acl(false, &EXPECTED)], Err(())),
            (Err(()), 1, 1)
        );
    }

    #[test]
    fn final_read_failure_or_toctou_change_rejects_both_branches_without_retry() {
        for protected in [false, true] {
            for after in [
                Err(()),
                acl(false, &EXPECTED),
                acl(true, &[2; 16]),
                acl(true, &[]),
            ] {
                assert_eq!(
                    scenario(vec![acl(protected, &EXPECTED), after], Ok(())),
                    (Err(()), 2, usize::from(!protected))
                );
            }
        }
    }

    #[test]
    fn invalid_expected_acl_does_not_read_or_write() {
        for expected in [vec![], vec![1; 7], vec![1; 4097]] {
            assert_eq!(
                secure(&expected, || panic!("read"), || panic!("set")),
                Err(())
            );
        }
    }
}
