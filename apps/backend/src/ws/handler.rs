use axum::{
    extract::{ConnectInfo, Query, State},
    Extension,
};
use axum::extract::ws::{WebSocketUpgrade, Message, WebSocket};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::{decode, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::broadcast;
use serde_json::Value;

use crate::ws::registry::InMemoryRegistry;
use crate::config::Config;

/// Query parameters for the WebSocket upgrade endpoint.
#[derive(Deserialize)]
pub struct WsQueryParams {
    /// JWT token containing session scope and role.
    token: String,
}

/// Claims expected in a WebSocket-scoped JWT.
#[derive(Debug, Serialize, Deserialize)]
pub struct WsClaims {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub role: String,
    #[serde(rename = "participantId")]
    pub participant_id: Option<String>,
    #[serde(rename = "userId")]
    pub user_id: String,
    pub exp: usize,
}

/// Resolve a human-readable client ID for logging and presence tracking.
fn resolve_client_id(session_id: &str, role: &str, participant_id: Option<&str>) -> String {
    participant_id
        .filter(|v| !v.trim().is_empty())
        .map(|v| v.trim().to_string())
        .unwrap_or_else(|| format!("{}-{}", role, session_id))
}

/// Validate a WS JWT and return the decoded claims.
fn validate_ws_token(token: &str, jwt_secret: &str) -> Result<WsClaims, String> {
    let token_data = decode::<WsClaims>(
        token,
        &DecodingKey::from_secret(jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|e| format!("Invalid token: {}", e))?;

    Ok(token_data.claims)
}

/// WebSocket upgrade handler.
///
/// Accepts a GET request with `?token=<jwt>` and upgrades to WebSocket.
/// The connection is registered in the session registry and stays alive
/// until the client disconnects.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<WsQueryParams>,
    Extension(config): Extension<Arc<Config>>,
    State(app_state): State<crate::AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> impl IntoResponse {
    let client_ip = addr.to_string();
    ws.on_upgrade(move |socket| handle_socket(socket, config, app_state.registry, params.token, client_ip))
}

/// Handle an upgraded WebSocket connection.
///
/// 1. Validate the JWT token
/// 2. Register the connection in the session registry
/// 3. Spawn a read loop that keeps the connection alive
async fn handle_socket(
    socket: WebSocket,
    config: Arc<Config>,
    registry: Arc<InMemoryRegistry>,
    token: String,
    client_ip: String,
) {
    // Validate the token before registering
    let claims = match validate_ws_token(&token, &config.jwt_secret) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(error = %e, "WebSocket token validation failed");
            return;
        }
    };

    let client_id = resolve_client_id(&claims.session_id, &claims.role, claims.participant_id.as_deref());

    tracing::info!(
        session_id = %claims.session_id,
        role = %claims.role,
        client_id = %client_id,
        ip = %client_ip,
        "WebSocket connection established"
    );

    // Split into send and receive halves
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Register in the session registry
    let mut receiver: broadcast::Receiver<Value> = registry.register(&claims.session_id).await;

    let session_id = claims.session_id.clone();
    let connections = registry.active_connections().await;
    tracing::info!(
        session_id = %session_id,
        connections,
        "Connection registered in session"
    );

    // Read loop: consume messages from the client (we don't process them yet,
    // but the loop keeps the connection alive and handles close frames).
    // We spawn this as a separate task so we can concurrently forward
    // registry broadcasts to the client.
    let read_handle = tokio::spawn(async move {
        let session_id = &session_id;
        while let Some(msg_result) = ws_receiver.next().await {
            match msg_result {
                Ok(Message::Text(text)) => {
                    tracing::debug!(session_id = %session_id, text = %text, "Received client message");
                }
                Ok(Message::Close(_)) => {
                    tracing::debug!(session_id = %session_id, "Client sent close frame");
                    break;
                }
                Ok(Message::Binary(_)) => {
                    // We only send JSON text; ignore binary from client.
                }
                Ok(Message::Ping(_ping)) => {
                    // Axum handles pong automatically.
                    tracing::trace!(session_id = %session_id, "Received ping");
                }
                Ok(Message::Pong(_)) => {
                    // Ignore.
                }
                Err(e) => {
                    tracing::debug!(session_id = %session_id, error = %e, "WebSocket receive error");
                    break;
                }
            }
        }
    });

    // Forward loop: receive broadcasts from the registry and send to client
    let session_id_forward = claims.session_id.clone();
    loop {
        match receiver.recv().await {
            Ok(message) => {
                if let Ok(json_str) = serde_json::to_string(&message) {
                    if ws_sender.send(Message::Text(json_str)).await.is_err() {
                        // Client disconnected
                        break;
                    }
                }
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                tracing::warn!(
                    session_id = %session_id_forward,
                    dropped = n,
                    "Client lagged behind, messages dropped"
                );
                // Continue — client will catch up on next state refresh
            }
            Err(broadcast::error::RecvError::Closed) => {
                // Sender (registry) closed the channel — shouldn't happen
                tracing::error!(session_id = %session_id_forward, "Broadcast channel closed unexpectedly");
                break;
            }
        }
    }

    // Cancel the read task (it will exit when the sender is dropped)
    read_handle.abort();

    tracing::info!(
        session_id = %claims.session_id,
        client_id = %client_id,
        "WebSocket connection closed"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};

    fn test_jwt_claims(session_id: &str, role: &str, participant_id: Option<&str>) -> String {
        let claims = WsClaims {
            session_id: session_id.to_string(),
            role: role.to_string(),
            participant_id: participant_id.map(|s| s.to_string()),
            user_id: "test-user".to_string(),
            // Expiry: 1 hour from now
            exp: (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as usize)
                + 3600,
        };

        encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(b"test-jwt-secret"),
        )
        .unwrap()
    }

    fn expired_jwt(session_id: &str) -> String {
        let claims = WsClaims {
            session_id: session_id.to_string(),
            role: "student".to_string(),
            participant_id: Some("p1".to_string()),
            user_id: "test-user".to_string(),
            exp: 1_000_000, // Expired in 1970
        };

        encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(b"test-jwt-secret"),
        )
        .unwrap()
    }

    // === JWT validation (unit tests) ===

    #[test]
    fn validate_token_accepts_valid_jwt() {
        let token = test_jwt_claims("session-1", "student", Some("p1"));
        let claims = validate_ws_token(&token, "test-jwt-secret").unwrap();
        assert_eq!(claims.session_id, "session-1");
        assert_eq!(claims.role, "student");
        assert_eq!(claims.participant_id, Some("p1".to_string()));
    }

    #[test]
    fn validate_token_rejects_wrong_secret() {
        let token = test_jwt_claims("session-1", "student", Some("p1"));
        let result = validate_ws_token(&token, "wrong-secret");
        assert!(result.is_err());
    }

    #[test]
    fn validate_token_rejects_expired_jwt() {
        let token = expired_jwt("session-1");
        let result = validate_ws_token(&token, "test-jwt-secret");
        assert!(result.is_err());
    }

    #[test]
    fn validate_token_rejects_malformed_jwt() {
        let result = validate_ws_token("not-a-jwt", "test-jwt-secret");
        assert!(result.is_err());
    }

    #[test]
    fn validate_token_rejects_empty_string() {
        let result = validate_ws_token("", "test-jwt-secret");
        assert!(result.is_err());
    }

    #[test]
    fn resolve_client_id_uses_participant_id_when_present() {
        assert_eq!(
            resolve_client_id("s1", "student", Some("p-001")),
            "p-001"
        );
    }

    #[test]
    fn resolve_client_id_falls_back_to_role_session() {
        assert_eq!(
            resolve_client_id("s1", "student", None),
            "student-s1"
        );
    }

    #[test]
    fn resolve_client_id_treats_whitespace_participant_as_missing() {
        assert_eq!(
            resolve_client_id("s1", "student", Some("  \t")),
            "student-s1"
        );
    }

    #[test]
    fn resolve_client_id_works_for_all_roles() {
        assert_eq!(
            resolve_client_id("abc", "staff", Some("staff-1")),
            "staff-1"
        );
        assert_eq!(
            resolve_client_id("abc", "projector", Some("proj-1")),
            "proj-1"
        );
        assert_eq!(
            resolve_client_id("abc", "projector", None),
            "projector-abc"
        );
    }
}
