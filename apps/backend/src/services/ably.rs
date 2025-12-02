use once_cell::sync::Lazy;
use serde::Serialize;
use std::env;
use std::time::Duration;

// Shared HTTP client for connection pooling (reuses connections)
static HTTP_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .pool_max_idle_per_host(10)
        .pool_idle_timeout(Duration::from_secs(90))
        .timeout(Duration::from_secs(30))
        .build()
        .expect("Failed to create HTTP client")
});

/// Publish a message to an Ably channel
pub async fn publish_to_channel<T: Serialize>(
    channel: &str,
    event_name: &str,
    data: &T,
) -> Result<(), String> {
    let ably_api_key = match env::var("ABLY_API_KEY") {
        Ok(key) => key,
        Err(_) => {
            tracing::warn!("ABLY_API_KEY not set, skipping real-time publish");
            return Ok(());
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

    let url = format!(
        "https://rest.ably.io/channels/{}/messages",
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
                tracing::info!("Successfully published {} to channel {}", event_name, channel);
                Ok(())
            } else {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                tracing::error!("Ably publish failed: {} - {}", status, body);
                Err(format!("Ably publish failed: {}", status))
            }
        }
        Err(e) => {
            tracing::error!("Ably request failed: {}", e);
            Err(format!("Ably request failed: {}", e))
        }
    }
}

/// Publish a state update to a session channel
pub async fn publish_state_update(session_id: &str, state: &impl Serialize) {
    let channel = format!("session:{}", session_id);
    let payload = serde_json::json!({
        "payload": state
    });
    
    if let Err(e) = publish_to_channel(&channel, "STATE_UPDATE", &payload).await {
        tracing::error!("Failed to publish state update: {}", e);
    }
}

/// Publish a vote update to a session channel
pub async fn publish_vote_update(session_id: &str, slide_id: &str, results: &std::collections::HashMap<String, i32>) {
    let channel = format!("session:{}", session_id);
    let payload = serde_json::json!({
        "slideId": slide_id,
        "results": results
    });
    
    if let Err(e) = publish_to_channel(&channel, "VOTE_UPDATE", &payload).await {
        tracing::error!("Failed to publish vote update: {}", e);
    }
}

/// Publish a Q&A update to a session channel
pub async fn publish_qa_update(session_id: &str, questions: &impl Serialize) {
    let channel = format!("session:{}", session_id);
    let payload = serde_json::json!({
        "payload": {
            "questions": questions
        }
    });
    
    if let Err(e) = publish_to_channel(&channel, "QA_UPDATE", &payload).await {
        tracing::error!("Failed to publish Q&A update: {}", e);
    }
}
