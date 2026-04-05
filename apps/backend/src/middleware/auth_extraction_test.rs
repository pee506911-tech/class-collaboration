#[cfg(test)]
mod tests {
    use crate::config::Config;
    use crate::error::AppError;
    use crate::middleware::auth::{AuthUser, Claims};
    use axum::extract::FromRequestParts;
    use axum::http::Request;
    use chrono::{Duration, Utc};
    use jsonwebtoken::{encode, EncodingKey, Header};
    use std::sync::Arc;

    // --- Test helpers ---

    fn make_config(jwt_secret: &str) -> Arc<Config> {
        Arc::new(Config {
            environment: "test".to_string(),
            database_url: "mysql://test:test@localhost/test".to_string(),
            jwt_secret: jwt_secret.to_string(),
            port: 8080,
            allowed_origins: vec![],
            enable_general_rate_limit: false,
            rate_limit_general_per_second: 100,
            rate_limit_general_burst: 1500,
            rate_limit_strict_per_second: 5,
            rate_limit_strict_burst: 20,
            db_max_connections: 5,
            db_min_connections: 0,
            db_acquire_timeout_seconds: 30,
            db_idle_timeout_seconds: 600,
            db_max_lifetime_seconds: 0,
            api_concurrency_limit: 64,
            api_buffer_size: 256,
            session_state_cache_ttl_ms: 0,
            session_state_cache_max_entries: 200,
            perf_test_token: None,
        })
    }

    fn make_valid_token(secret: &str, user_id: &str, role: &str, expires_in_hours: i64) -> String {
        let exp = (Utc::now() + Duration::hours(expires_in_hours)).timestamp() as usize;
        let claims = Claims {
            user_id: user_id.to_string(),
            role: role.to_string(),
            exp,
        };
        encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .expect("token encoding should succeed")
    }

    fn build_parts_with_cookie(cookie_value: &str, config: Arc<Config>) -> Request<()> {
        Request::builder()
            .header("Cookie", format!("token={}", cookie_value))
            .extension(config)
            .body(())
            .unwrap()
    }

    fn build_parts_with_bearer(token: &str, config: Arc<Config>) -> Request<()> {
        Request::builder()
            .header("Authorization", format!("Bearer {}", token))
            .extension(config)
            .body(())
            .unwrap()
    }

    fn build_parts_no_auth(config: Arc<Config>) -> Request<()> {
        Request::builder().extension(config).body(()).unwrap()
    }

    async fn extract_auth(req: Request<()>) -> Result<AuthUser, AppError> {
        let (mut parts, _body) = req.into_parts();
        AuthUser::from_request_parts(&mut parts, &()).await
    }

    // --- Cookie-based auth tests ---

    /// Verifies that a valid JWT in the `token` cookie is extracted
    /// and the correct user_id and role are returned.
    #[tokio::test]
    async fn cookie_auth_succeeds_with_valid_token() {
        let config = make_config("test-secret");
        let token = make_valid_token("test-secret", "user-123", "teacher", 1);
        let req = build_parts_with_cookie(&token, config);

        let result = extract_auth(req).await;
        assert!(result.is_ok());
        let auth = result.unwrap();
        assert_eq!(auth.user_id, "user-123");
        assert_eq!(auth.role, "teacher");
    }

    /// Verifies that an expired JWT in the `token` cookie returns 401.
    #[tokio::test]
    async fn cookie_auth_rejects_expired_token() {
        let config = make_config("test-secret");
        let token = make_valid_token("test-secret", "user-123", "student", -1); // expired 1 hour ago
        let req = build_parts_with_cookie(&token, config);

        let result = extract_auth(req).await;
        assert!(result.is_err());
    }

    /// Verifies that a JWT signed with a different secret returns 401
    /// (signature verification fails).
    #[tokio::test]
    async fn cookie_auth_rejects_token_with_wrong_secret() {
        let config = make_config("correct-secret");
        let token = make_valid_token("wrong-secret", "user-123", "student", 1);
        let req = build_parts_with_cookie(&token, config);

        let result = extract_auth(req).await;
        assert!(result.is_err());
    }

    /// Verifies that a tampered JWT (modified payload) returns 401.
    #[tokio::test]
    async fn cookie_auth_rejects_tampered_token() {
        let config = make_config("test-secret");
        let valid_token = make_valid_token("test-secret", "user-123", "student", 1);
        // Tamper: change a character in the payload portion of the JWT
        let parts: Vec<&str> = valid_token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let mut tampered_payload = parts[1].to_string();
        tampered_payload.replace_range(0..1, "X");
        let tampered_token = format!("{}.{}.{}", parts[0], tampered_payload, parts[2]);

        let req = build_parts_with_cookie(&tampered_token, config);

        let result = extract_auth(req).await;
        assert!(result.is_err());
    }

    // --- Bearer token auth tests ---

    /// Verifies that a valid `Authorization: Bearer <token>` header is
    /// correctly parsed and the JWT is decoded.
    #[tokio::test]
    async fn bearer_auth_succeeds_with_valid_token() {
        let config = make_config("test-secret");
        let token = make_valid_token("test-secret", "user-456", "staff", 1);
        let req = build_parts_with_bearer(&token, config);

        let result = extract_auth(req).await;
        assert!(result.is_ok());
        let auth = result.unwrap();
        assert_eq!(auth.user_id, "user-456");
        assert_eq!(auth.role, "staff");
    }

    /// Verifies that a missing Authorization header returns 401
    /// when no token cookie is present either.
    #[tokio::test]
    async fn bearer_auth_rejects_missing_authorization_header() {
        let config = make_config("test-secret");
        let req = build_parts_no_auth(config);

        let result = extract_auth(req).await;
        assert!(result.is_err());
        let err = result.err().unwrap();
        assert!(err.to_string().contains("Missing authorization"));
    }

    /// Verifies that `Authorization: Basic <credentials>` (wrong scheme)
    /// returns 401 with an "Invalid token format" error.
    #[tokio::test]
    async fn bearer_auth_rejects_basic_auth_scheme() {
        let config = make_config("test-secret");
        let req = Request::builder()
            .header("Authorization", "Basic dXNlcjpwYXNz")
            .extension(config)
            .body(())
            .unwrap();

        let result = extract_auth(req).await;
        assert!(result.is_err());
        let err = result.err().unwrap();
        assert!(err.to_string().contains("Invalid token format"));
    }

    /// Verifies that `Authorization: Bearer` with no token value
    /// (empty string after "Bearer ") returns an error.
    #[tokio::test]
    async fn bearer_auth_rejects_empty_bearer_token() {
        let config = make_config("test-secret");
        let req = Request::builder()
            .header("Authorization", "Bearer ")
            .extension(config)
            .body(())
            .unwrap();

        let result = extract_auth(req).await;
        // Empty token will fail JWT decode — that's the expected behavior
        assert!(result.is_err());
    }

    /// Verifies that `Authorization: Bearer <malformed>` (not a valid JWT)
    /// returns an error.
    #[tokio::test]
    async fn bearer_auth_rejects_malformed_token() {
        let config = make_config("test-secret");
        let req = Request::builder()
            .header("Authorization", "Bearer not-a-jwt-token")
            .extension(config)
            .body(())
            .unwrap();

        let result = extract_auth(req).await;
        assert!(result.is_err());
    }

    /// Verifies that an expired Bearer token returns 401.
    #[tokio::test]
    async fn bearer_auth_rejects_expired_token() {
        let config = make_config("test-secret");
        let token = make_valid_token("test-secret", "user-789", "student", -1);
        let req = build_parts_with_bearer(&token, config);

        let result = extract_auth(req).await;
        assert!(result.is_err());
    }

    // --- Config missing test ---

    /// Verifies that when Config is not in Extension, the extraction
    /// returns a 500-level error indicating server misconfiguration.
    #[tokio::test]
    async fn auth_fails_when_config_missing_from_extension() {
        let req = Request::builder().body(()).unwrap();

        let result = extract_auth(req).await;
        assert!(result.is_err());
        let err = result.err().unwrap();
        assert!(err.to_string().contains("Config missing"));
    }

    // --- Cookie preference test ---

    /// Verifies that the cookie takes precedence over the Bearer token
    /// when both are present. The auth flow checks the cookie first.
    #[tokio::test]
    async fn cookie_takes_precedence_over_bearer_header() {
        let config = make_config("test-secret");
        // Cookie has valid token for user-cookie
        let cookie_token = make_valid_token("test-secret", "user-cookie", "teacher", 1);
        // Bearer header has a different user
        let bearer_token = make_valid_token("test-secret", "user-bearer", "student", 1);

        let req = Request::builder()
            .header("Cookie", format!("token={}", cookie_token))
            .header("Authorization", format!("Bearer {}", bearer_token))
            .extension(config)
            .body(())
            .unwrap();

        let result = extract_auth(req).await;
        assert!(result.is_ok());
        let auth = result.unwrap();
        // Cookie should win → user-cookie, not user-bearer
        assert_eq!(auth.user_id, "user-cookie");
        assert_eq!(auth.role, "teacher");
    }

    // --- Role extraction test ---

    /// Verifies that different roles (teacher, student, staff) are
    /// correctly extracted from the JWT claims.
    #[tokio::test]
    async fn auth_extracts_role_correctly() {
        let config = make_config("test-secret");
        for role in &["teacher", "student", "staff"] {
            let token = make_valid_token("test-secret", "user-1", role, 1);
            let req = build_parts_with_cookie(&token, config.clone());

            let result = extract_auth(req).await;
            assert!(result.is_ok(), "role '{}' should be extracted", role);
            assert_eq!(result.unwrap().role, *role);
        }
    }
}
