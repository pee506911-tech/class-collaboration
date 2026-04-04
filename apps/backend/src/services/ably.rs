use once_cell::sync::Lazy;
use serde::Serialize;
use std::env;
use std::time::Duration;

use crate::services::circuit_breaker::CircuitBreaker;

// Shared HTTP client for connection pooling (reuses connections)
static HTTP_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .pool_max_idle_per_host(10)
        .pool_idle_timeout(Duration::from_secs(90))
        .timeout(Duration::from_secs(30))
        .build()
        .expect("Failed to create HTTP client")
});

// Circuit breaker for Ably: 5 consecutive failures → trip, 30s recovery timeout
static CIRCUIT_BREAKER: Lazy<CircuitBreaker> = Lazy::new(|| {
    CircuitBreaker::new(5, 30)
});

/// Returns true if the Ably circuit breaker is open and realtime delivery is degraded.
/// This is a side-effect-free read — it does not trigger state transitions.
pub fn is_degraded() -> bool {
    CIRCUIT_BREAKER.is_open()
}

/// Get the Ably REST URL from environment or use default
fn get_ably_base_url() -> String {
    env::var("ABLY_REST_URL").unwrap_or_else(|_| "https://rest.ably.io".to_string())
}

/// Publish a message to an Ably channel with failure tracking
pub async fn publish_to_channel<T: Serialize>(
    channel: &str,
    event_name: &str,
    data: &T,
) -> Result<bool, String> {
    // Check circuit breaker before making the request
    if !CIRCUIT_BREAKER.allow_request() {
        tracing::warn!(
            state = CIRCUIT_BREAKER.state_name(),
            "Ably circuit breaker OPEN — skipping publish to {}",
            channel
        );
        return Ok(false);
    }

    let ably_api_key = match env::var("ABLY_API_KEY") {
        Ok(key) => key,
        Err(_) => {
            tracing::warn!("ABLY_API_KEY not set, skipping real-time publish");
            return Ok(false); // Returns false to indicate degraded mode (no realtime)
        }
    };

    // Parse key: "keyName:keySecret" for basic auth
    let key_parts: Vec<&str> = ably_api_key.split(':').collect();
    if key_parts.len() != 2 {
        tracing::error!("Invalid ABLY_API_KEY format, expected 'keyName:keySecret'");
        return Err("Invalid ABLY_API_KEY format".to_string());
    }
    let key_name = key_parts[0];
    let key_secret = key_parts[1];

    let base_url = get_ably_base_url();
    let url = format!(
        "{}/channels/{}/messages",
        base_url.trim_end_matches('/'),
        urlencoding::encode(channel)
    );

    let payload = serde_json::json!({
        "name": event_name,
        "data": data
    });

    tracing::info!("Publishing {} to Ably channel: {}", event_name, channel);

    match HTTP_CLIENT
        .post(&url)
        .basic_auth(key_name, Some(key_secret))
        .json(&payload)
        .send()
        .await
    {
        Ok(response) => {
            if response.status().is_success() {
                CIRCUIT_BREAKER.record_success();
                tracing::info!(
                    "Successfully published {} to channel {}",
                    event_name,
                    channel
                );
                Ok(true) // Successfully published
            } else {
                CIRCUIT_BREAKER.record_failure();
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                tracing::error!(
                    event_name = %event_name,
                    channel = %channel,
                    status = %status,
                    body = %body,
                    "Ably publish failed"
                );
                Err(format!("Ably publish failed: {}", status))
            }
        }
        Err(e) => {
            CIRCUIT_BREAKER.record_failure();
            tracing::error!(
                event_name = %event_name,
                channel = %channel,
                error = %e,
                "Ably request failed"
            );
            Err(format!("Ably request failed: {}", e))
        }
    }
}

/// Publish a state update to a session channel
/// Returns true if published successfully, false if in degraded mode
pub async fn publish_state_update(session_id: &str, state: &impl Serialize) -> bool {
    let channel = format!("session:{}", session_id);
    let payload = serde_json::json!({
        "payload": state
    });

    match publish_to_channel(&channel, "STATE_UPDATE", &payload).await {
        Ok(success) => success,
        Err(e) => {
            tracing::error!("Failed to publish state update: {}", e);
            false
        }
    }
}

/// Publish a vote update to a session channel with sequence number
/// Returns true if published successfully, false if in degraded mode
pub async fn publish_vote_update(
    session_id: &str,
    slide_id: &str,
    results: &std::collections::HashMap<String, i32>,
    sequence: u64,
) -> bool {
    let channel = format!("session:{}", session_id);
    let payload = serde_json::json!({
        "slideId": slide_id,
        "results": results,
        "sequence": sequence
    });

    match publish_to_channel(&channel, "VOTE_UPDATE", &payload).await {
        Ok(success) => success,
        Err(e) => {
            tracing::error!("Failed to publish vote update: {}", e);
            false
        }
    }
}

/// Publish a Q&A update to a session channel with sequence number
/// Returns true if published successfully, false if in degraded mode
pub async fn publish_qa_update(
    session_id: &str,
    questions: &impl Serialize,
    sequence: u64,
) -> bool {
    let channel = format!("session:{}", session_id);
    let payload = serde_json::json!({
        "payload": {
            "questions": questions
        },
        "sequence": sequence
    });

    match publish_to_channel(&channel, "QA_UPDATE", &payload).await {
        Ok(success) => success,
        Err(e) => {
            tracing::error!("Failed to publish Q&A update: {}", e);
            false
        }
    }
}

/// Publish a slides update to a session channel
/// Returns true if published successfully, false if in degraded mode
pub async fn publish_slides_update(session_id: &str, slides: &impl Serialize) -> bool {
    let channel = format!("session:{}", session_id);
    let payload = serde_json::json!({
        "slides": slides
    });

    match publish_to_channel(&channel, "SLIDES_UPDATE", &payload).await {
        Ok(success) => success,
        Err(e) => {
            tracing::error!("Failed to publish slides update: {}", e);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tests that `get_ably_base_url()` returns the default when no env var is set
    /// and respects the `ABLY_REST_URL` override. Both behaviors are verified in one
    /// serial test to avoid env var pollution between parallel tests.
    #[test]
    fn get_ably_base_url_default_and_override() {
        let original = std::env::var("ABLY_REST_URL").ok();

        // Verify default
        std::env::remove_var("ABLY_REST_URL");
        assert_eq!(get_ably_base_url(), "https://rest.ably.io");

        // Verify override
        std::env::set_var("ABLY_REST_URL", "https://custom-ably-proxy.local");
        assert_eq!(get_ably_base_url(), "https://custom-ably-proxy.local");

        // Verify trailing slash is preserved (trimming happens at call site)
        std::env::set_var("ABLY_REST_URL", "https://custom.local/");
        assert_eq!(get_ably_base_url(), "https://custom.local/");

        // Restore original
        match original {
            Some(val) => std::env::set_var("ABLY_REST_URL", val),
            None => std::env::remove_var("ABLY_REST_URL"),
        }
    }
}
