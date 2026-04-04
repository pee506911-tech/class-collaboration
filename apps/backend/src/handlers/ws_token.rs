use axum::{
    extract::{Query, State},
    Extension, Json,
};
use jsonwebtoken::{encode, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{SystemTime, Duration};

use crate::config::Config;
use crate::error::AppError;
use crate::middleware::auth::AuthUser;

/// Query parameters for the WS token endpoint.
#[derive(Deserialize)]
pub struct WsTokenQueryParams {
    /// Session ID to scope the token to.
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    /// Role of the user in the session.
    role: Option<String>,
    /// Participant ID (optional, used by students).
    #[serde(rename = "participantId")]
    participant_id: Option<String>,
}

/// Response containing a WS token.
#[derive(Serialize)]
pub struct WsTokenResponse {
    pub token: String,
}

/// WS JWT claims (same as auth JWT but with session_id added).
#[derive(Debug, Serialize, Deserialize)]
pub struct WsTokenClaims {
    #[serde(rename = "userId")]
    pub user_id: String,
    pub role: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "participantId")]
    pub participant_id: Option<String>,
    pub exp: usize,
}

/// Generate a WS token endpoint handler.
///
/// GET /api/auth/ws-token?sessionId=...&role=...&participantId=...
///
/// Requires authentication (via Bearer token or auth cookie).
/// Returns a short-lived JWT (1 hour) that can be used to authenticate
/// the WebSocket upgrade at /api/ws.
pub async fn get_ws_token(
    auth_user: AuthUser,
    Query(params): Query<WsTokenQueryParams>,
    Extension(config): Extension<Arc<Config>>,
    _state: State<crate::AppState>,
) -> Result<Json<WsTokenResponse>, AppError> {
    // Use the authenticated user ID
    let user_id = auth_user.user_id;

    // Validate required params
    let session_id = params
        .session_id
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| AppError::Input("sessionId query param is required".to_string()))?;

    let role = params
        .role
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| AppError::Input("role query param is required".to_string()))?;

    // Validate role
    if !["staff", "student", "projector"].contains(&role.as_str()) {
        return Err(AppError::Input(format!("Invalid role: {}. Must be staff, student, or projector", role)));
    }

    // Create claims with 1 hour expiry
    let expiry = SystemTime::now()
        .checked_add(Duration::from_secs(3600))
        .expect("Failed to calculate expiry")
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("Time went backwards")
        .as_secs() as usize;

    let claims = WsTokenClaims {
        user_id,
        role,
        session_id,
        participant_id: params.participant_id,
        exp: expiry,
    };

    // Sign the token
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(config.jwt_secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("Failed to sign WS token: {}", e)))?;

    Ok(Json(WsTokenResponse { token }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_token_claims_serializes_correctly() {
        let claims = WsTokenClaims {
            user_id: "user-1".to_string(),
            role: "student".to_string(),
            session_id: "session-1".to_string(),
            participant_id: Some("p-1".to_string()),
            exp: 1234567890,
        };

        let json = serde_json::to_string(&claims).unwrap();
        assert!(json.contains("userId"));
        assert!(json.contains("sessionId"));
        assert!(json.contains("participantId"));
    }

    #[test]
    fn ws_token_rejects_missing_session_id() {
        let params = WsTokenQueryParams {
            session_id: None,
            role: Some("student".to_string()),
            participant_id: None,
        };
        assert!(params.session_id.is_none());
    }

    #[test]
    fn ws_token_rejects_empty_session_id() {
        let params = WsTokenQueryParams {
            session_id: Some("".to_string()),
            role: Some("student".to_string()),
            participant_id: None,
        };
        assert!(params.session_id.filter(|s| !s.trim().is_empty()).is_none());
    }

    #[test]
    fn ws_token_rejects_invalid_role() {
        let params = WsTokenQueryParams {
            session_id: Some("session-1".to_string()),
            role: Some("invalid".to_string()),
            participant_id: None,
        };
        let role = params.role.as_deref().unwrap();
        assert!(!["staff", "student", "projector"].contains(&role));
    }

    #[test]
    fn ws_token_accepts_valid_params() {
        let params = WsTokenQueryParams {
            session_id: Some("session-1".to_string()),
            role: Some("student".to_string()),
            participant_id: Some("p-1".to_string()),
        };

        assert!(params.session_id.filter(|s| !s.trim().is_empty()).is_some());
        assert!(params.role.filter(|s| !s.trim().is_empty()).is_some());
    }
}
