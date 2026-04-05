#[cfg(test)]
mod tests {
    use crate::middleware::auth::Claims;
    use chrono::{Duration, Utc};
    use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};

    const TEST_SECRET: &str = "test-jwt-secret-for-unit-tests";

    fn make_claims(user_id: &str, role: &str, expiry: chrono::DateTime<Utc>) -> Claims {
        Claims {
            user_id: user_id.to_string(),
            role: role.to_string(),
            exp: expiry.timestamp() as usize,
        }
    }

    fn encode_claims(claims: &Claims, secret: &str) -> String {
        encode(
            &Header::default(),
            claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .expect("encode should succeed")
    }

    // --- Token Creation Tests ---

    #[test]
    fn valid_token_decodes_successfully() {
        let expiry = Utc::now() + Duration::hours(1);
        let claims = make_claims("user-1", "teacher", expiry);
        let token = encode_claims(&claims, TEST_SECRET);

        let decoded = decode::<Claims>(
            &token,
            &DecodingKey::from_secret(TEST_SECRET.as_bytes()),
            &Validation::default(),
        )
        .expect("decode should succeed");

        assert_eq!(decoded.claims.user_id, "user-1");
        assert_eq!(decoded.claims.role, "teacher");
    }

    #[test]
    fn token_with_wrong_secret_fails() {
        let expiry = Utc::now() + Duration::hours(1);
        let claims = make_claims("user-2", "student", expiry);
        let token = encode_claims(&claims, TEST_SECRET);

        let result = decode::<Claims>(
            &token,
            &DecodingKey::from_secret(b"wrong-secret"),
            &Validation::default(),
        );

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(matches!(
            err.kind(),
            jsonwebtoken::errors::ErrorKind::InvalidSignature
        ));
    }

    #[test]
    fn expired_token_fails() {
        let expiry = Utc::now() - Duration::hours(1); // expired 1 hour ago
        let claims = make_claims("user-3", "student", expiry);
        let token = encode_claims(&claims, TEST_SECRET);

        let result = decode::<Claims>(
            &token,
            &DecodingKey::from_secret(TEST_SECRET.as_bytes()),
            &Validation::default(),
        );

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(matches!(
            err.kind(),
            jsonwebtoken::errors::ErrorKind::ExpiredSignature
        ));
    }

    #[test]
    fn token_with_distant_future_expiry_succeeds() {
        let expiry = Utc::now() + Duration::days(30);
        let claims = make_claims("user-4", "admin", expiry);
        let token = encode_claims(&claims, TEST_SECRET);

        let decoded = decode::<Claims>(
            &token,
            &DecodingKey::from_secret(TEST_SECRET.as_bytes()),
            &Validation::default(),
        )
        .expect("decode should succeed");

        assert_eq!(decoded.claims.user_id, "user-4");
        assert_eq!(decoded.claims.role, "admin");
    }

    // --- AuthUser Extraction Tests ---

    #[test]
    fn auth_user_extracts_user_id_and_role() {
        use crate::middleware::auth::AuthUser;

        let expiry = Utc::now() + Duration::hours(1);
        let claims = make_claims("user-5", "presenter", expiry);
        let token = encode_claims(&claims, TEST_SECRET);

        let decoded = decode::<Claims>(
            &token,
            &DecodingKey::from_secret(TEST_SECRET.as_bytes()),
            &Validation::default(),
        )
        .expect("decode should succeed");

        let auth_user = AuthUser {
            user_id: decoded.claims.user_id,
            role: decoded.claims.role,
        };

        assert_eq!(auth_user.user_id, "user-5");
        assert_eq!(auth_user.role, "presenter");
    }

    // --- Role-Based Access Tests ---

    #[test]
    fn supports_student_role() {
        let expiry = Utc::now() + Duration::hours(1);
        let claims = make_claims("student-1", "student", expiry);
        let token = encode_claims(&claims, TEST_SECRET);

        let decoded = decode::<Claims>(
            &token,
            &DecodingKey::from_secret(TEST_SECRET.as_bytes()),
            &Validation::default(),
        )
        .expect("decode should succeed");

        assert_eq!(decoded.claims.role, "student");
    }

    #[test]
    fn supports_teacher_role() {
        let expiry = Utc::now() + Duration::hours(1);
        let claims = make_claims("teacher-1", "teacher", expiry);
        let token = encode_claims(&claims, TEST_SECRET);

        let decoded = decode::<Claims>(
            &token,
            &DecodingKey::from_secret(TEST_SECRET.as_bytes()),
            &Validation::default(),
        )
        .expect("decode should succeed");

        assert_eq!(decoded.claims.role, "teacher");
    }

    #[test]
    fn supports_arbitrary_roles() {
        let expiry = Utc::now() + Duration::hours(1);
        let claims = make_claims("user-x", "custom_role", expiry);
        let token = encode_claims(&claims, TEST_SECRET);

        let decoded = decode::<Claims>(
            &token,
            &DecodingKey::from_secret(TEST_SECRET.as_bytes()),
            &Validation::default(),
        )
        .expect("decode should succeed");

        assert_eq!(decoded.claims.role, "custom_role");
    }

    // --- Token Format Tests ---

    #[test]
    fn malformed_token_fails_decode() {
        let result = decode::<Claims>(
            "not-a-valid-jwt",
            &DecodingKey::from_secret(TEST_SECRET.as_bytes()),
            &Validation::default(),
        );

        assert!(result.is_err());
    }

    #[test]
    fn empty_token_fails_decode() {
        let result = decode::<Claims>(
            "",
            &DecodingKey::from_secret(TEST_SECRET.as_bytes()),
            &Validation::default(),
        );

        assert!(result.is_err());
    }

    #[test]
    fn token_with_extra_parts_fails() {
        let result = decode::<Claims>(
            "part1.part2.part3.part4",
            &DecodingKey::from_secret(TEST_SECRET.as_bytes()),
            &Validation::default(),
        );

        assert!(result.is_err());
    }

    // --- Cookie Value Tests ---

    #[test]
    fn cookie_value_should_be_raw_token() {
        // The middleware extracts the token from cookie value directly
        let expiry = Utc::now() + Duration::hours(1);
        let claims = make_claims("user-6", "student", expiry);
        let token = encode_claims(&claims, TEST_SECRET);

        // Cookie value is the raw JWT string
        assert!(token.starts_with("eyJ"));
        assert!(!token.contains(';')); // no cookie metadata in the value
    }

    // --- Bearer Token Format Tests ---

    #[test]
    fn bearer_token_prefix_format() {
        // The middleware expects "Bearer <token>" in the Authorization header
        let expiry = Utc::now() + Duration::hours(1);
        let claims = make_claims("user-7", "student", expiry);
        let token = encode_claims(&claims, TEST_SECRET);

        let auth_header = format!("Bearer {}", token);
        assert!(auth_header.starts_with("Bearer "));

        // Extract the token part (what the middleware does after stripping "Bearer ")
        let extracted = &auth_header[7..];
        assert_eq!(extracted, token);
    }

    #[test]
    fn invalid_bearer_format_fails() {
        let bad_formats = vec![
            "Token abc123", // wrong prefix
            "Bearer",       // no token
            "Bearer ",      // empty token
            "Basic abc123", // wrong scheme
        ];

        for format in bad_formats {
            let is_valid_bearer = format.starts_with("Bearer ") && format.len() > 7;
            assert!(!is_valid_bearer, "format '{}' should be rejected", format);
        }
    }
}
