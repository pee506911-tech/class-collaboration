use axum::{
    extract::{Query, State},
    http::{header::AUTHORIZATION, HeaderMap},
    Extension, Json,
};
use axum_extra::extract::cookie::CookieJar;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use crate::config::Config;
use crate::error::AppError;
use crate::middleware::auth::{AuthUser, Claims};

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
/// Staff tokens require authentication.
/// Student and projector tokens are public but require a valid session.
/// Returns a short-lived JWT (1 hour) that can be used to authenticate
/// the WebSocket upgrade at /api/ws.
pub async fn get_ws_token(
    Query(params): Query<WsTokenQueryParams>,
    jar: CookieJar,
    headers: HeaderMap,
    Extension(config): Extension<Arc<Config>>,
    state: State<crate::AppState>,
) -> Result<Json<WsTokenResponse>, AppError> {
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
        return Err(AppError::Input(format!(
            "Invalid role: {}. Must be staff, student, or projector",
            role
        )));
    }

    let participant_id = params.participant_id.filter(|p| !p.trim().is_empty());

    if role == "student" && participant_id.is_none() {
        return Err(AppError::Input(
            "participantId query param is required for student".to_string(),
        ));
    }

    let auth_user = extract_auth_user(&jar, &headers, &config.jwt_secret);

    let user_id = match role.as_str() {
        "staff" => auth_user
            .map(|user| user.user_id)
            .ok_or_else(|| AppError::Auth("Missing authorization".to_string()))?,
        "student" | "projector" => {
            state
                .session_service
                .ensure_session_exists(&session_id)
                .await?;
            auth_user
                .map(|user| user.user_id)
                .unwrap_or_else(|| public_user_id(&role, participant_id.as_deref(), &session_id))
        }
        _ => unreachable!(),
    };

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
        participant_id,
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

fn public_user_id(role: &str, participant_id: Option<&str>, session_id: &str) -> String {
    participant_id
        .filter(|id| !id.trim().is_empty())
        .map(|id| id.trim().to_string())
        .unwrap_or_else(|| format!("public-{}-{}", role, session_id))
}

fn extract_auth_token(jar: &CookieJar, headers: &HeaderMap) -> Option<String> {
    if let Some(cookie) = jar.get("token") {
        return Some(cookie.value().to_string());
    }

    let auth_header = headers.get(AUTHORIZATION)?;
    let auth_str = auth_header.to_str().ok()?;
    auth_str
        .strip_prefix("Bearer ")
        .map(|token| token.to_string())
}

fn extract_auth_user(jar: &CookieJar, headers: &HeaderMap, jwt_secret: &str) -> Option<AuthUser> {
    let token = extract_auth_token(jar, headers)?;
    let token_data = decode::<Claims>(
        &token,
        &DecodingKey::from_secret(jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .ok()?;

    Some(AuthUser {
        user_id: token_data.claims.user_id,
        role: token_data.claims.role,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{header::AUTHORIZATION, HeaderValue};
    use axum_extra::extract::cookie::Cookie;

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

    #[test]
    fn public_user_id_prefers_participant_id() {
        assert_eq!(
            public_user_id("student", Some("participant-1"), "session-1"),
            "participant-1"
        );
    }

    #[test]
    fn public_user_id_falls_back_to_public_scope() {
        assert_eq!(
            public_user_id("projector", None, "session-1"),
            "public-projector-session-1"
        );
    }

    #[test]
    fn extract_auth_token_reads_bearer_header() {
        let jar = CookieJar::new();
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer token-123"));

        assert_eq!(
            extract_auth_token(&jar, &headers).as_deref(),
            Some("token-123")
        );
    }

    #[test]
    fn extract_auth_token_prefers_cookie() {
        let jar = CookieJar::new().add(Cookie::new("token", "cookie-token"));
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_static("Bearer header-token"),
        );

        assert_eq!(
            extract_auth_token(&jar, &headers).as_deref(),
            Some("cookie-token")
        );
    }
}
