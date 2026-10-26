//! Admit a registry component only through a no-follow open and validation.
//! Different slots share ancestors; another creator may win that first create.
pub(super) fn open<K>(
    create: bool,
    shared: bool,
    mut open_no_follow: impl FnMut() -> Result<Option<K>, ()>,
    create_key: impl FnOnce() -> Result<(K, u32), ()>,
    verify: impl FnOnce(&K) -> Result<(), ()>,
) -> Result<Option<K>, ()> {
    let key = match open_no_follow()? {
        Some(key) => key,
        None if !create => return Ok(None),
        None => {
            let (created, disposition) = create_key()?;
            // RegCreateKeyEx may open an existing target. Never use that handle
            // for validation, traversal or state access, including a new key.
            drop(created);
            if disposition != 1 && !(shared && disposition == 2) {
                return Err(());
            }
            // One validation open, not a retry loop. A missing/deleted/replaced
            // component fails closed; ACLs and links are checked on this handle.
            open_no_follow()?.ok_or(())?
        }
    };
    verify(&key)?;
    Ok(Some(key))
}

#[cfg(test)]
mod tests {
    use super::open;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    struct Key(u8, Rc<RefCell<Vec<u8>>>);
    impl Drop for Key {
        fn drop(&mut self) {
            self.1.borrow_mut().push(self.0);
        }
    }

    #[test]
    fn shared_create_winner_is_reopened_and_verified_before_use() {
        for (shared, disposition) in [(true, 1), (true, 2), (false, 1)] {
            let dropped = Rc::new(RefCell::new(Vec::new()));
            let calls = Cell::new(0);
            let key = open(
                true,
                shared,
                || {
                    calls.set(calls.get() + 1);
                    if calls.get() == 1 {
                        return Ok(None);
                    }
                    assert_eq!(*dropped.borrow(), [1]);
                    Ok(Some(Key(2, dropped.clone())))
                },
                || Ok((Key(1, dropped.clone()), disposition)),
                |key| {
                    assert_eq!(key.0, 2);
                    assert_eq!(*dropped.borrow(), [1]);
                    Ok(())
                },
            )
            .unwrap()
            .unwrap();
            assert_eq!(key.0, 2);
            assert_eq!(calls.get(), 2);
            drop(key);
            assert_eq!(*dropped.borrow(), [1, 2]);
        }
    }

    #[test]
    fn existing_components_are_verified_without_creation() {
        let key = open(
            false,
            false,
            || Ok(Some(7)),
            || panic!("create"),
            |key| {
                assert_eq!(*key, 7);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(key, Some(7));
        assert_eq!(
            open::<u8>(
                false,
                true,
                || Ok(None),
                || panic!("create"),
                |_| panic!("verify")
            ),
            Ok(None)
        );
    }

    #[test]
    fn unexpected_slot_or_disposition_never_reopens_or_verifies() {
        for (shared, disposition) in [(false, 2), (true, 0), (true, 3), (true, u32::MAX)] {
            let calls = Cell::new(0);
            let dropped = Rc::new(RefCell::new(Vec::new()));
            assert!(open(
                true,
                shared,
                || {
                    calls.set(calls.get() + 1);
                    assert_eq!(calls.get(), 1);
                    Ok(None)
                },
                || Ok((Key(1, dropped.clone()), disposition)),
                |_| panic!("verify")
            )
            .is_err());
            assert_eq!(*dropped.borrow(), [1]);
        }
    }

    #[test]
    fn missing_failed_or_unsafe_reopen_cannot_admit_or_retry() {
        for mode in 0..3 {
            let calls = Cell::new(0);
            let verified = Cell::new(0);
            let result = open(
                true,
                true,
                || {
                    calls.set(calls.get() + 1);
                    match (calls.get(), mode) {
                        (1, _) | (2, 0) => Ok(None),
                        (2, 1) => Err(()),
                        (2, 2) => Ok(Some(3)),
                        _ => panic!("retry"),
                    }
                },
                || Ok((1, 2)),
                |_| {
                    verified.set(verified.get() + 1);
                    Err(()) // unsafe link or mismatching ACL
                },
            );
            assert_eq!(result, Err(()));
            assert_eq!(calls.get(), 2);
            assert_eq!(verified.get(), u8::from(mode == 2));
        }
    }

    #[test]
    fn initial_open_and_create_failures_stop_without_fallback() {
        assert_eq!(
            open::<u8>(
                true,
                true,
                || Err(()),
                || panic!("create"),
                |_| panic!("verify")
            ),
            Err(())
        );
        assert_eq!(
            open::<u8>(true, true, || Ok(None), || Err(()), |_| panic!("verify")),
            Err(())
        );
        assert_eq!(
            open(
                true,
                false,
                || Ok(Some(1)),
                || panic!("create"),
                |_| Err(())
            ),
            Err(())
        );
    }
}
