/// WebSocket connection management.
///
/// Provides a session-scoped broadcast registry that fan-outs messages
/// to all connected WebSocket clients in a given session.
pub mod handler;
pub mod registry;
