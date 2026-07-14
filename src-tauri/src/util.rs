//! Small crate-internal helpers shared across modules.

/// Milliseconds since the Unix epoch (wall clock), or 0 if the system clock is
/// before the epoch. The single source for the timestamps stamped on captions
/// (`session.rs`) and on UI heartbeats (`ui_state.rs`), which are compared
/// against each other during verification — keeping one helper stops the two
/// from drifting apart.
pub(crate) fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
