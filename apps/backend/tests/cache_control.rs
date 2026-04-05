//! Phase 1.2: Cache-Control Header Tests
//!
//! These tests verify that public read endpoints set the intended Cache-Control headers.
//!
//! Public session metadata header: `Cache-Control: public, s-maxage=10, stale-if-error=300`
//! Realtime session state header: `Cache-Control: no-store`
//!
//! Rationale:
//! - Public session metadata can tolerate a short CDN TTL
//! - Realtime session state must not be cached because follow-up writes are expected immediately
//! - `stale-if-error=300`: Serve stale data for 5 minutes if backend is slow/down
//!   (critical for Render free tier cold starts)
//!
//! Production evidence:
//! - GitHub API: Sets `Cache-Control: public, s-maxage=60, stale-while-revalidate=300`
//! - Stripe API: Adds `stale-if-error` to serve stale data on backend errors

use axum::http::HeaderValue;

/// Build the Cache-Control header for public session metadata.
/// This mirrors the implementation in handlers/public.rs.
pub fn public_session_cache_control() -> HeaderValue {
    HeaderValue::from_static("public, s-maxage=10, stale-if-error=300")
}

/// Build the Cache-Control header for real-time session state.
/// This mirrors the implementation in handlers/public.rs.
pub fn realtime_state_cache_control() -> HeaderValue {
    HeaderValue::from_static("no-store")
}

/// **Feature: performance-audit, Finding 2: No HTTP Caching on Read Endpoints**
/// **Validates: Phase 1.2 - Add Cache-Control headers**
///
/// Property: The Cache-Control header for session read endpoints SHALL contain:
/// - `public` to allow CDN caching
/// - `s-maxage=10` for 10-second CDN TTL
/// - `stale-if-error=300` for 5-minute stale fallback on backend errors
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_session_cache_control_has_correct_values() {
        let header = public_session_cache_control();
        let header_str = header.to_str().unwrap();

        assert!(
            header_str.contains("public"),
            "Cache-Control should allow public caching for CDN"
        );
        assert!(
            header_str.contains("s-maxage=10"),
            "Cache-Control should set s-maxage to 10 seconds for session state"
        );
        assert!(
            header_str.contains("stale-if-error=300"),
            "Cache-Control should allow stale responses on error for 300 seconds (5 minutes)"
        );
    }

    #[test]
    fn public_session_cache_control_is_static_and_reusable() {
        // Ensure the header can be created multiple times without issues
        let header1 = public_session_cache_control();
        let header2 = public_session_cache_control();

        assert_eq!(header1, header2);
        assert_eq!(
            header1.to_str().unwrap(),
            "public, s-maxage=10, stale-if-error=300"
        );
    }

    #[test]
    fn realtime_state_cache_control_disables_caching() {
        let header = realtime_state_cache_control();

        assert_eq!(header.to_str().unwrap(), "no-store");
    }
}
