use axum::{extract::Query, Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

use crate::config::Config;
use crate::error::Result;

#[derive(Deserialize)]
pub struct AblyTokenQuery {
    #[serde(rename = "sessionId")]
    session_id: String,
    role: String,
    #[serde(rename = "participantId")]
    participant_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct AblyTokenRequest {
    #[serde(rename = "keyName")]
    key_name: String,
    ttl: u64,
    capability: String,
    #[serde(rename = "clientId")]
    client_id: String,
    timestamp: u64,
    nonce: String,
    mac: String,
}

fn resolve_client_id(session_id: &str, role: &str, participant_id: Option<&str>) -> String {
    participant_id
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|| format!("{}-{}", role, session_id))
}

fn missing_participant_id(participant_id: Option<&str>) -> bool {
    participant_id
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
}

pub(crate) fn build_ably_token_request(
    ably_api_key: &str,
    session_id: &str,
    role: &str,
    participant_id: Option<&str>,
    timestamp: u64,
    nonce: &str,
) -> Result<AblyTokenRequest> {
    // Parse key: "keyName:keySecret"
    let key_parts: Vec<&str> = ably_api_key.split(':').collect();
    if key_parts.len() != 2 {
        return Err(crate::error::AppError::Internal(
            "Invalid ABLY_API_KEY format".to_string(),
        ));
    }
    let key_name = key_parts[0];
    let key_secret = key_parts[1];

    // Define capabilities based on role
    let capability = match role {
        "staff" => {
            json!({
                format!("session:{}", session_id): ["publish", "subscribe", "presence"]
            })
        }
        "student" | "projector" => {
            json!({
                format!("session:{}", session_id): ["subscribe", "presence"]
            })
        }
        _ => {
            return Err(crate::error::AppError::Input(
                "Invalid role. Must be 'staff', 'student', or 'projector'".to_string(),
            ));
        }
    };

    let client_id = resolve_client_id(session_id, role, participant_id);
    let ttl = 3600000_u64; // 1 hour in milliseconds
    let capability_str = serde_json::to_string(&capability).unwrap();

    // Ably token request signature format
    // Format: keyName\nTTL\ncapability\nclientId\ntimestamp\nnonce\n
    let sign_text = format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n",
        key_name, ttl, capability_str, client_id, timestamp, nonce
    );

    tracing::debug!("Sign text for HMAC:\n{}", sign_text);

    // Create HMAC-SHA256 signature
    use base64::Engine as _;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    type HmacSha256 = Hmac<Sha256>;

    let mut mac = HmacSha256::new_from_slice(key_secret.as_bytes())
        .map_err(|_| crate::error::AppError::Internal("Failed to create HMAC".to_string()))?;
    mac.update(sign_text.as_bytes());
    let result = mac.finalize();
    let mac_base64 = base64::engine::general_purpose::STANDARD.encode(result.into_bytes());

    tracing::debug!("Generated MAC: {}", mac_base64);

    Ok(AblyTokenRequest {
        key_name: key_name.to_string(),
        ttl,
        capability: capability_str,
        client_id,
        timestamp,
        nonce: nonce.to_string(),
        mac: mac_base64,
    })
}

/// Generate Ably token request with appropriate permissions
pub async fn get_ably_token(
    Extension(_config): Extension<Arc<Config>>,
    Query(params): Query<AblyTokenQuery>,
) -> Result<Json<serde_json::Value>> {
    // Get Ably API key from environment
    let ably_api_key = std::env::var("ABLY_API_KEY")
        .map_err(|_| crate::error::AppError::Internal("ABLY_API_KEY not configured".to_string()))?;

    // Set client ID for tracking - CRITICAL: each participant must have a unique ID
    let client_id = resolve_client_id(
        &params.session_id,
        &params.role,
        params.participant_id.as_deref(),
    );

    // Warn if participant_id is empty (this causes all students to share the same connection)
    if missing_participant_id(params.participant_id.as_deref()) {
        tracing::warn!(
            "Empty or missing participant_id for session {} role {}. Using fallback: {}. This may cause connection sharing issues!",
            params.session_id, params.role, client_id
        );
    } else {
        tracing::info!(
            "Generating Ably token for session {} role {} participant {}",
            params.session_id,
            params.role,
            client_id
        );
    }

    // Generate timestamp (in milliseconds) and nonce
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let nonce = uuid::Uuid::new_v4().to_string();
    // Return token request in the format Ably expects
    let token_request = build_ably_token_request(
        &ably_api_key,
        &params.session_id,
        &params.role,
        params.participant_id.as_deref(),
        timestamp,
        &nonce,
    )?;

    Ok(Json(serde_json::to_value(token_request).map_err(|e| {
        crate::error::AppError::Internal(format!("Failed to serialize token request: {}", e))
    })?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashSet;

    fn expected_mac(
        key_secret: &str,
        key_name: &str,
        ttl: u64,
        capability: &str,
        client_id: &str,
        timestamp: u64,
        nonce: &str,
    ) -> String {
        use base64::Engine as _;
        use hmac::{Hmac, Mac};
        use sha2::Sha256;

        type HmacSha256 = Hmac<Sha256>;

        let sign_text = format!(
            "{}\n{}\n{}\n{}\n{}\n{}\n",
            key_name, ttl, capability, client_id, timestamp, nonce
        );
        let mut mac =
            HmacSha256::new_from_slice(key_secret.as_bytes()).expect("test key should create HMAC");
        mac.update(sign_text.as_bytes());
        base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
    }

    #[test]
    fn build_ably_token_request_uses_participant_id_as_client_id() {
        let request = build_ably_token_request(
            "test.key:secret",
            "session-123",
            "student",
            Some("student-001"),
            1_706_000_000_000,
            "nonce-001",
        )
        .expect("token request should build");

        assert_eq!(request.key_name, "test.key");
        assert_eq!(request.ttl, 3_600_000);
        assert_eq!(request.client_id, "student-001");
        assert_eq!(request.timestamp, 1_706_000_000_000);
        assert_eq!(request.nonce, "nonce-001");

        let capability: serde_json::Value =
            serde_json::from_str(&request.capability).expect("capability should parse");
        assert_eq!(
            capability,
            json!({
                "session:session-123": ["subscribe", "presence"]
            })
        );

        assert_eq!(
            request.mac,
            expected_mac(
                "secret",
                "test.key",
                3_600_000,
                &request.capability,
                &request.client_id,
                request.timestamp,
                &request.nonce,
            )
        );
    }

    #[test]
    fn build_ably_token_request_falls_back_to_session_scoped_client_id() {
        let request = build_ably_token_request(
            "test.key:secret",
            "session-abc",
            "projector",
            None,
            1_706_000_000_001,
            "nonce-002",
        )
        .expect("token request should build");

        assert_eq!(request.client_id, "projector-session-abc");
        let capability: serde_json::Value =
            serde_json::from_str(&request.capability).expect("capability should parse");
        assert_eq!(
            capability,
            json!({
                "session:session-abc": ["subscribe", "presence"]
            })
        );
    }

    #[test]
    fn build_ably_token_request_rejects_invalid_role() {
        let err = build_ably_token_request(
            "test.key:secret",
            "session-123",
            "guest",
            Some("student-001"),
            1_706_000_000_002,
            "nonce-003",
        )
        .expect_err("invalid role should be rejected");

        assert!(
            matches!(err, crate::error::AppError::Input(message) if message.contains("Invalid role"))
        );
    }

    #[test]
    fn build_ably_token_request_preserves_unique_client_ids_for_100_students() {
        let mut client_ids = HashSet::new();

        for i in 0..100 {
            let participant_id = format!("student-{:03}", i);
            let nonce = format!("nonce-{:03}", i);
            let request = build_ably_token_request(
                "test.key:secret",
                "session-burst",
                "student",
                Some(&participant_id),
                1_706_000_100_000 + i as u64,
                &nonce,
            )
            .expect("token request should build");

            assert_eq!(request.client_id, participant_id);
            client_ids.insert(request.client_id);
        }

        assert_eq!(client_ids.len(), 100);
    }

    #[test]
    fn build_ably_token_request_treats_whitespace_participant_id_as_missing() {
        let request = build_ably_token_request(
            "test.key:secret",
            "session-whitespace",
            "student",
            Some("   \t"),
            1_706_000_200_000,
            "nonce-004",
        )
        .expect("token request should build");

        assert_eq!(request.client_id, "student-session-whitespace");
    }
}
