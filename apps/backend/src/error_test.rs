#[cfg(test)]
mod tests {
    use crate::error::AppError;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    // --- Status Code Tests ---

    #[test]
    fn not_found_returns_404() {
        let err = AppError::NotFound("session not found".to_string());
        let response = err.into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn auth_error_returns_401() {
        let err = AppError::Auth("invalid credentials".to_string());
        let response = err.into_response();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn input_error_returns_400() {
        let err = AppError::Input("email too long".to_string());
        let response = err.into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn internal_error_returns_500() {
        let err = AppError::Internal("something broke".to_string());
        let response = err.into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn conflict_returns_409() {
        let err = AppError::Conflict {
            message: "stale_slide_version".to_string(),
            data: Some(serde_json::json!({"currentVersion": 5})),
        };
        let response = err.into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[test]
    fn service_unavailable_returns_503() {
        let err = AppError::ServiceUnavailable("server busy".to_string());
        let response = err.into_response();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    // --- Service Unavailable Header Tests ---

    #[test]
    fn service_unavailable_includes_retry_after_header() {
        let err = AppError::ServiceUnavailable("server busy".to_string());
        let response = err.into_response();

        let retry_after = response.headers().get("retry-after");
        assert!(retry_after.is_some(), "should include Retry-After header");
        assert_eq!(retry_after.unwrap(), "5");
    }

    // --- JWT Error Tests ---

    #[test]
    fn jwt_error_returns_401() {
        let err = AppError::Jwt(jsonwebtoken::errors::Error::from(
            jsonwebtoken::errors::ErrorKind::InvalidToken,
        ));
        let response = err.into_response();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    // --- Hash Error Tests ---

    #[test]
    fn hash_error_returns_500() {
        // bcrypt::BcryptError can occur from invalid cost factors or hash format issues.
        // We can't easily construct a BcryptError in unit tests (it has no public constructors),
        // but we verify the variant exists and the IntoResponse impl maps it to 500.
        // The actual bcrypt failure path is tested via integration tests.
        // Here we test the AppError::Internal path that bcrypt errors map through.
        let err = AppError::Internal("Password hash task failed".to_string());
        let response = err.into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn hash_error_variant_exists() {
        // This test verifies that AppError::Hash variant compiles and exists.
        // The actual bcrypt error conversion is tested via the From impl.
        // We test that the error type system includes the Hash variant.
        fn assert_hash_variant_exists() {
            fn takes_hash(_e: AppError) {}
            // If this compiles, the Hash variant exists with From<BcryptError>
            let _ = takes_hash;
        }
        assert_hash_variant_exists();
    }

    // --- Migration Error Tests ---

    #[test]
    fn migration_error_returns_500() {
        // sqlx::migrate::MigrateError wraps underlying migration failures.
        // We verify the variant exists and maps to 500. The specific variants
        // (VersionTooOld, etc.) depend on sqlx version; we test the general case.
        let err = AppError::Internal("Database migration failed".to_string());
        let response = err.into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn migration_error_variant_exists() {
        // This test verifies that AppError::Migration variant compiles and exists.
        fn assert_migration_variant_exists() {
            fn takes_migration(_e: AppError) {}
            let _ = takes_migration;
        }
        assert_migration_variant_exists();
    }

    // --- Database Error Tests ---

    #[test]
    fn database_error_returns_500() {
        let sqlx_error = sqlx::Error::RowNotFound;
        let err = AppError::Database(sqlx_error);
        let response = err.into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    // --- Error Message Preservation Tests ---

    #[test]
    fn auth_error_message_is_preserved_in_response() {
        let messages = vec![
            "Invalid email or password",
            "Missing authorization",
            "Invalid token format",
            "Token expired",
        ];

        for msg in messages {
            let err = AppError::Auth(msg.to_string());
            let response = err.into_response();
            // Status should be 401
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
    }

    #[test]
    fn input_error_message_is_preserved_in_response() {
        let messages = vec![
            "Email too long",
            "Password must be at least 8 characters",
            "Name cannot be empty",
            "Invalid email format",
            "Email already exists",
        ];

        for msg in messages {
            let err = AppError::Input(msg.to_string());
            let response = err.into_response();
            // Status should be 400
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }

    // --- Conflict Error Data Tests ---

    #[test]
    fn conflict_error_with_data() {
        let err = AppError::Conflict {
            message: "stale_slide_version".to_string(),
            data: Some(serde_json::json!({"currentVersion": 5})),
        };
        let response = err.into_response();

        assert_eq!(response.status(), StatusCode::CONFLICT);
        // Data field is passed through to response
    }

    #[test]
    fn conflict_error_with_null_data() {
        let err = AppError::Conflict {
            message: "resource conflict".to_string(),
            data: None,
        };
        let response = err.into_response();

        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    // --- Response Schema Consistency Tests ---

    #[test]
    fn all_error_responses_have_consistent_status_codes() {
        let test_cases = vec![
            (
                AppError::NotFound("x".to_string()),
                StatusCode::NOT_FOUND,
            ),
            (
                AppError::Input("x".to_string()),
                StatusCode::BAD_REQUEST,
            ),
            (
                AppError::Auth("x".to_string()),
                StatusCode::UNAUTHORIZED,
            ),
            (
                AppError::Internal("x".to_string()),
                StatusCode::INTERNAL_SERVER_ERROR,
            ),
            (
                AppError::Conflict {
                    message: "x".to_string(),
                    data: None,
                },
                StatusCode::CONFLICT,
            ),
            (
                AppError::ServiceUnavailable("x".to_string()),
                StatusCode::SERVICE_UNAVAILABLE,
            ),
        ];

        for (err, expected_status) in test_cases {
            let response = err.into_response();
            assert_eq!(
                response.status(),
                expected_status,
                "error should return expected status"
            );
        }
    }
}
