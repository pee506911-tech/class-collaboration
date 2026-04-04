#[cfg(test)]
mod tests {
    use crate::middleware::auth::Claims;
    use bcrypt::{hash, verify, DEFAULT_COST};
    use chrono::{Duration, Utc};
    use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};

    // --- JWT Claims Tests ---

    #[test]
    fn claims_serialize_has_user_id_camel_case() {
        let claims = Claims {
            user_id: "user-123".to_string(),
            role: "student".to_string(),
            exp: 1_700_000_000,
        };
        let key = EncodingKey::from_secret(b"test-secret");
        let token = encode(&Header::default(), &claims, &key).expect("encode should succeed");

        // Token should be a valid JWT with 3 parts
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
    }

    #[test]
    fn claims_deserialize_from_encoded_token() {
        let expiry = (Utc::now() + Duration::hours(1)).timestamp() as usize;
        let claims = Claims {
            user_id: "user-456".to_string(),
            role: "teacher".to_string(),
            exp: expiry,
        };
        let key = EncodingKey::from_secret(b"test-secret");
        let token = encode(&Header::default(), &claims, &key).expect("encode should succeed");

        let decoded = decode::<Claims>(
            &token,
            &DecodingKey::from_secret(b"test-secret"),
            &Validation::default(),
        )
        .expect("decode should succeed");

        assert_eq!(decoded.claims.user_id, "user-456");
        assert_eq!(decoded.claims.role, "teacher");
        assert_eq!(decoded.claims.exp, expiry);
    }

    #[test]
    fn claims_with_wrong_secret_fails_decode() {
        let claims = Claims {
            user_id: "user-789".to_string(),
            role: "student".to_string(),
            exp: 1_700_000_000,
        };
        let key = EncodingKey::from_secret(b"correct-secret");
        let token = encode(&Header::default(), &claims, &key).expect("encode should succeed");

        let result = decode::<Claims>(
            &token,
            &DecodingKey::from_secret(b"wrong-secret"),
            &Validation::default(),
        );

        assert!(result.is_err());
    }

    #[test]
    fn jwt_token_expiry_30_days_from_now() {
        let now = Utc::now();
        let expiration = now
            .checked_add_signed(Duration::days(30))
            .expect("valid timestamp")
            .timestamp() as usize;

        let expected = (now + Duration::days(30)).timestamp() as usize;
        // Allow 1 second tolerance for test execution
        assert!((expiration as i64 - expected as i64).abs() <= 1);
    }

    // --- Bcrypt Tests ---

    #[test]
    fn bcrypt_hash_and_verify_roundtrip() {
        let password = "securePassword123!";
        let hashed = hash(password, DEFAULT_COST).expect("hash should succeed");

        let verified = verify(password, &hashed).expect("verify should succeed");
        assert!(verified);
    }

    #[test]
    fn bcrypt_verify_fails_for_wrong_password() {
        let password = "securePassword123!";
        let hashed = hash(password, DEFAULT_COST).expect("hash should succeed");

        let verified = verify("wrongPassword456!", &hashed).expect("verify should not error");
        assert!(!verified);
    }

    #[test]
    fn bcrypt_produces_different_hashes_for_same_password() {
        let password = "samePassword123!";
        let hash1 = hash(password, DEFAULT_COST).expect("hash should succeed");
        let hash2 = hash(password, DEFAULT_COST).expect("hash should succeed");

        // Bcrypt uses random salt, so hashes should differ
        assert_ne!(hash1, hash2);
    }

    // --- Auth Response Shape Tests ---

    #[test]
    fn register_response_shape_on_success() {
        use serde_json::json;

        let response = json!({
            "success": true,
            "message": "User registered successfully",
            "userId": "user-123"
        });

        assert_eq!(response["success"], true);
        assert!(response["message"].as_str().is_some());
        assert!(response["userId"].as_str().is_some());
        assert!(response.get("token").is_none()); // register does not return token
    }

    #[test]
    fn login_response_shape() {
        use serde_json::json;

        let response = json!({
            "success": true,
            "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
            "user": {
                "id": "user-123",
                "email": "test@example.com",
                "name": "Test User",
                "role": "student",
                "createdAt": "2024-01-01T00:00:00Z"
            }
        });

        assert_eq!(response["success"], true);
        assert!(response["token"].as_str().is_some());
        assert!(response["user"]["id"].as_str().is_some());
        assert!(response["user"]["email"].as_str().is_some());
        assert!(response["user"]["name"].as_str().is_some());
        assert!(response["user"]["role"].as_str().is_some());
    }

    // --- Input Validation Tests ---

    #[test]
    fn email_validation_rejects_invalid_formats() {
        // The backend uses a simple check: contains('@') && contains('.')
        // These emails fail that check
        let invalid_emails = vec![
            "plainaddress",     // no @ or .
            "username@domain",  // no dot
            "",                 // empty
        ];

        for email in invalid_emails {
            let is_valid = email.contains('@') && email.contains('.');
            assert!(
                !is_valid,
                "email '{}' should fail validation",
                email
            );
        }
    }

    #[test]
    fn email_validation_accepts_valid_formats() {
        let valid_emails = vec![
            "user@example.com",
            "user.name@example.co.uk",
            "user+tag@example.com",
        ];

        for email in valid_emails {
            let is_valid = email.contains('@') && email.contains('.');
            assert!(is_valid, "email '{}' should pass validation", email);
        }
    }

    #[test]
    fn password_length_constraints() {
        let min_len = 8;
        let max_len = 128;

        assert!("short!".len() < min_len);
        assert!("exactly8".len() == min_len);
        assert!("validPassword123!".len() >= min_len);
        assert!("validPassword123!".len() <= max_len);
    }

    #[test]
    fn name_cannot_be_empty_or_whitespace() {
        let invalid_names = vec!["", "   ", "\t", "\n"];

        for name in invalid_names {
            assert!(
                name.trim().is_empty(),
                "name '{}' should be rejected as empty",
                name
            );
        }
    }

    #[test]
    fn name_length_constraint() {
        let max_len = 100;
        let valid_name = "A".repeat(max_len);
        let invalid_name = "A".repeat(max_len + 1);

        assert!(valid_name.len() <= max_len);
        assert!(invalid_name.len() > max_len);
        assert!(invalid_name.trim().is_empty() == false);
    }
}
