use axum::{extract::Query, Json, Extension};
use serde::Deserialize;
use std::sync::Arc;
use serde_json::json;

use crate::error::Result;
use crate::config::Config;

#[derive(Deserialize)]
pub struct AblyTokenQuery {
    #[serde(rename = "sessionId")]
    session_id: String,
    role: String,
    #[serde(rename = "participantId")]
    participant_id: Option<String>,
}

/// Generate Ably token request with appropriate permissions
pub async fn get_ably_token(
    Extension(_config): Extension<Arc<Config>>,
    Query(params): Query<AblyTokenQuery>,
) -> Result<Json<serde_json::Value>> {
    // Get Ably API key from environment
    let ably_api_key = std::env::var("ABLY_API_KEY")
        .map_err(|_| crate::error::AppError::Internal("ABLY_API_KEY not configured".to_string()))?;

    // Parse key: "keyName:keySecret"
    let key_parts: Vec<&str> = ably_api_key.split(':').collect();
    if key_parts.len() != 2 {
        return Err(crate::error::AppError::Internal("Invalid ABLY_API_KEY format".to_string()));
    }
    let key_name = key_parts[0];
    let key_secret = key_parts[1];

    // Define capabilities based on role
    let capability = match params.role.as_str() {
        "staff" => {
            json!({
                format!("session:{}", params.session_id): ["publish", "subscribe", "presence"]
            })
        }
        "student" | "projector" => {
            json!({
                format!("session:{}", params.session_id): ["subscribe", "presence"]
            })
        }
        _ => {
            return Err(crate::error::AppError::Input("Invalid role. Must be 'staff', 'student', or 'projector'".to_string()));
        }
    };

    // Set client ID for tracking
    let client_id = params.participant_id.clone()
        .unwrap_or_else(|| format!("{}-{}", params.role, params.session_id));

    // Generate timestamp (in milliseconds) and nonce
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let nonce = uuid::Uuid::new_v4().to_string();
    let ttl = 3600000_u64; // 1 hour in milliseconds

    // Capability must be JSON string
    let capability_str = serde_json::to_string(&capability).unwrap();
    
    // Ably token request signature format
    // Format: keyName\nTTL\ncapability\nclientId\ntimestamp\nnonce\n
    let sign_text = format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n",
        key_name,
        ttl,
        capability_str,
        client_id,
        timestamp,
        nonce
    );

    tracing::debug!("Sign text for HMAC:\n{}", sign_text);

    // Create HMAC-SHA256 signature
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    
    type HmacSha256 = Hmac<Sha256>;
    
    let mut mac = HmacSha256::new_from_slice(key_secret.as_bytes())
        .map_err(|_| crate::error::AppError::Internal("Failed to create HMAC".to_string()))?;
    mac.update(sign_text.as_bytes());
    let result = mac.finalize();
    let mac_base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, result.into_bytes());

    tracing::debug!("Generated MAC: {}", mac_base64);

    // Return token request in the format Ably expects
    let token_request = json!({
        "keyName": key_name,
        "ttl": ttl,
        "capability": capability_str,
        "clientId": client_id,
        "timestamp": timestamp,
        "nonce": nonce,
        "mac": mac_base64
    });

    Ok(Json(token_request))
}
