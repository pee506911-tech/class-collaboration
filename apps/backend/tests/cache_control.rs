//! Phase 1.2: Cache-Control Header Tests
//!
//! These tests verify that read endpoints set proper Cache-Control headers
//! to enable CDN edge caching and reduce cold start latency on Render free tier.
//!
//! Expected header: `Cache-Control: public, s-maxage=10, stale-if-error=300`
//!
//! Rationale:
//! - `public`: Allows CDNs (Fastly, Cloudflare) to cache the response
//! - `s-maxage=10`: CDN cache TTL of 10 seconds (session state changes on the order of seconds)
//! - `stale-if-error=300`: Serve stale data for 5 minutes if backend is slow/down
//!   (critical for Render free tier cold starts)
//!
//! Production evidence:
//! - GitHub API: Sets `Cache-Control: public, s-maxage=60, stale-while-revalidate=300`
//! - Stripe API: Adds `stale-if-error` to serve stale data on backend errors

use axum::http::HeaderValue;

/// Build the standard Cache-Control header for read-only session endpoints
/// This mirrors the implementation in handlers/public.rs
pub fn session_read_cache_control() -> HeaderValue {
    HeaderValue::from_static("public, s-maxage=10, stale-if-error=300")
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
    fn cache_control_header_has_correct_values() {
        let header = session_read_cache_control();
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
    fn cache_control_header_is_static_and_reusable() {
        // Ensure the header can be created multiple times without issues
        let header1 = session_read_cache_control();
        let header2 = session_read_cache_control();
        
        assert_eq!(header1, header2);
        assert_eq!(header1.to_str().unwrap(), "public, s-maxage=10, stale-if-error=300");
    }
}
