//! WebSocket Token Endpoint Integration Tests
//!
//! Tests the full HTTP path for GET /api/auth/ws-token:
//! - Authentication via Bearer token (same as other integration tests)
//! - JWT generation and validation
//! - Query parameter validation
//!
//! These tests are `#[ignore]` by default and require Docker + MySQL + a running backend.
//! Run: `cargo test --test ws_token_integration -- --ignored --test-threads=1`

use reqwest::Client;
use serde_json::{json, Value};

const DEFAULT_SERVER_URL: &str = "http://localhost:8080";

fn server_url() -> String {
    std::env::var("TEST_SERVER_URL").unwrap_or_else(|_| DEFAULT_SERVER_URL.to_string())
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

async fn register_and_login(client: &Client, base: &str) -> (String, String) {
    let unique = uuid::Uuid::new_v4().to_string();
    let email = format!("ws-token-{}@example.com", unique);
    let password = format!("WsToken-{}!Aa1", unique);

    let resp = client
        .post(format!("{}/api/auth/register", base))
        .json(&json!({
            "email": &email,
            "password": &password,
            "name": "WS Token Test User",
            "role": "staff",
        }))
        .send()
        .await
        .expect("register failed");
    assert!(
        resp.status().is_success(),
        "register failed: {}",
        resp.text().await.unwrap_or_default()
    );

    let resp = client
        .post(format!("{}/api/auth/login", base))
        .json(&json!({
            "email": &email,
            "password": &password,
        }))
        .send()
        .await
        .expect("login failed");
    
    let body: Value = resp.json().await.expect("login body not json");
    let token = body["token"]
        .as_str()
        .unwrap_or_else(|| panic!("login response has no token, got: {}", body))
        .to_string();
    
    (token, email)
}

#[tokio::test]
#[ignore]
async fn ws_token_returns_valid_jwt_with_auth() {
    let client = Client::new();
    let base = server_url();
    
    let (auth_token, _email) = register_and_login(&client, &base).await;
    
    let session_id = "test-session-ws-token-1";
    let resp = client
        .get(format!("{}/api/auth/ws-token", base))
        .query(&[
            ("sessionId", session_id),
            ("role", "student"),
        ])
        .header("Authorization", bearer(&auth_token))
        .send()
        .await
        .expect("ws-token request failed");

    assert!(
        resp.status().is_success(),
        "ws-token should return 200 with valid auth, got: {}",
        resp.status()
    );

    let body: Value = resp.json().await.expect("ws-token body not json");
    let token = body["token"]
        .as_str()
        .expect("ws-token response missing token field");

    assert!(!token.is_empty(), "token should not be empty");
    
    // Token should be a valid JWT (contains 3 parts separated by dots)
    let parts: Vec<&str> = token.split('.').collect();
    assert_eq!(parts.len(), 3, "JWT should have 3 parts");
}

#[tokio::test]
#[ignore]
async fn ws_token_rejects_unauthenticated() {
    let client = Client::new();
    let base = server_url();
    
    let resp = client
        .get(format!("{}/api/auth/ws-token", base))
        .query(&[
            ("sessionId", "test-session"),
            ("role", "student"),
        ])
        .send()
        .await
        .expect("ws-token request failed");

    assert_eq!(
        resp.status(),
        401,
        "ws-token should reject unauthenticated requests"
    );
}

#[tokio::test]
#[ignore]
async fn ws_token_rejects_missing_session_id() {
    let client = Client::new();
    let base = server_url();
    
    let (auth_token, _email) = register_and_login(&client, &base).await;
    
    let resp = client
        .get(format!("{}/api/auth/ws-token", base))
        .query(&[("role", "student")])
        .header("Authorization", bearer(&auth_token))
        .send()
        .await
        .expect("ws-token request failed");

    assert_eq!(
        resp.status(),
        400,
        "ws-token should reject requests missing sessionId"
    );
}

#[tokio::test]
#[ignore]
async fn ws_token_rejects_invalid_role() {
    let client = Client::new();
    let base = server_url();
    
    let (auth_token, _email) = register_and_login(&client, &base).await;
    
    let resp = client
        .get(format!("{}/api/auth/ws-token", base))
        .query(&[
            ("sessionId", "test-session"),
            ("role", "invalid_role"),
        ])
        .header("Authorization", bearer(&auth_token))
        .send()
        .await
        .expect("ws-token request failed");

    assert_eq!(
        resp.status(),
        400,
        "ws-token should reject invalid role"
    );
}

#[tokio::test]
#[ignore]
async fn ws_token_accepts_all_valid_roles() {
    let client = Client::new();
    let base = server_url();
    
    let (auth_token, _email) = register_and_login(&client, &base).await;
    
    for role in &["staff", "student", "projector"] {
        let resp = client
            .get(format!("{}/api/auth/ws-token", base))
            .query(&[
                ("sessionId", "test-session"),
                ("role", role),
            ])
            .header("Authorization", bearer(&auth_token))
            .send()
            .await
            .expect("ws-token request failed");

        assert!(
            resp.status().is_success(),
            "ws-token should accept role '{}', got: {}",
            role,
            resp.status()
        );

        let body: Value = resp.json().await.expect("ws-token body not json");
        assert!(
            body["token"].is_string(),
            "ws-token response should contain token string for role '{}'",
            role
        );
    }
}

#[tokio::test]
#[ignore]
async fn ws_token_accepts_optional_participant_id() {
    let client = Client::new();
    let base = server_url();
    
    let (auth_token, _email) = register_and_login(&client, &base).await;
    
    let resp = client
        .get(format!("{}/api/auth/ws-token", base))
        .query(&[
            ("sessionId", "test-session"),
            ("role", "student"),
            ("participantId", "participant-123"),
        ])
        .header("Authorization", bearer(&auth_token))
        .send()
        .await
        .expect("ws-token request failed");

    assert!(
        resp.status().is_success(),
        "ws-token should accept participantId, got: {}",
        resp.status()
    );
}
