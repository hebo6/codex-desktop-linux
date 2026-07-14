use std::sync::atomic::{AtomicU8, Ordering};

use tokio_util::sync::CancellationToken;

pub(super) struct ConnectionLifecycle {
    state: AtomicU8,
    cancellation: CancellationToken,
}

const OPEN: u8 = 0;
const START_AUTHORIZED: u8 = 1;
const CANCELLED: u8 = 2;

impl Default for ConnectionLifecycle {
    fn default() -> Self {
        Self {
            state: AtomicU8::new(OPEN),
            cancellation: CancellationToken::new(),
        }
    }
}

impl ConnectionLifecycle {
    // Start authorization and cancellation are linearized by the atomic state. If start wins the
    // race, cancellation remains non-blocking and reaches every resource through its child token.
    pub(super) fn begin_start(&self) -> Result<(), ConnectionCancelled> {
        self.state
            .compare_exchange(OPEN, START_AUTHORIZED, Ordering::AcqRel, Ordering::Acquire)
            .map(drop)
            .map_err(|_| ConnectionCancelled)
    }

    pub(super) fn cancel(&self) {
        self.state.store(CANCELLED, Ordering::Release);
        self.cancellation.cancel();
    }

    pub(super) fn cancellation(&self) -> &CancellationToken {
        &self.cancellation
    }

    pub(super) fn child_token(&self) -> CancellationToken {
        self.cancellation.child_token()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ConnectionCancelled;

#[cfg(test)]
mod tests {
    use super::ConnectionLifecycle;

    #[test]
    fn cancellation_before_start_rejects_the_start_lease() {
        let lifecycle = ConnectionLifecycle::default();
        lifecycle.cancel();

        assert!(lifecycle.begin_start().is_err());
        assert!(lifecycle.child_token().is_cancelled());
    }

    #[test]
    fn cancellation_immediately_reaches_an_authorized_start() {
        let lifecycle = ConnectionLifecycle::default();
        lifecycle.begin_start().unwrap();
        lifecycle.cancel();

        assert!(lifecycle.cancellation().is_cancelled());
        assert!(lifecycle.begin_start().is_err());
    }
}
