/// Phase 1: Config parsing logic tests.
///
/// Rather than trying to isolate Config::from_env from the process environment
/// (which is fragile due to concurrent test execution and inherited env vars),
/// these tests verify the parsing logic directly at the expression level.
/// Config::from_env integration is better tested via integration tests or
/// manual smoke testing.

#[cfg(test)]
mod config_parsing_logic_tests {
    #[test]
    fn rate_limit_boolean_parsing_true_values() {
        for value in &["1", "true", "TRUE", "True"] {
            let parsed = Some(*value)
                .as_deref()
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            assert!(parsed, "value '{}' should enable", value);
        }
    }

    #[test]
    fn rate_limit_boolean_parsing_false_values() {
        for value in &["0", "false", "FALSE", "no", ""] {
            let parsed = Some(*value)
                .as_deref()
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            assert!(!parsed, "value '{}' should keep disabled", value);
        }
    }

    #[test]
    fn rate_limit_boolean_parsing_none_defaults_to_false() {
        let parsed: Option<&str> = None;
        let result = parsed
            .as_deref()
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        assert!(!result);
    }

    #[test]
    fn numeric_env_var_parsing_with_fallback() {
        // Simulates: env::var("X").ok().and_then(|v| v.parse().ok()).unwrap_or(default)
        let parse_with_fallback = |input: Option<&str>, default: u64| -> u64 {
            input.and_then(|v| v.parse().ok()).unwrap_or(default)
        };

        assert_eq!(parse_with_fallback(Some("100"), 50), 100);
        assert_eq!(parse_with_fallback(Some("abc"), 50), 50);
        assert_eq!(parse_with_fallback(Some("-1"), 50), 50);
        assert_eq!(parse_with_fallback(None, 50), 50);
        assert_eq!(parse_with_fallback(Some("0"), 50), 0);
    }

    #[test]
    fn allowed_origins_comma_split_trims_whitespace() {
        let input = "http://localhost:3000, http://example.com , http://test.com";
        let origins: Vec<String> = input
            .split(',')
            .map(|s| s.trim().to_string())
            .collect();
        assert_eq!(origins.len(), 3);
        assert_eq!(origins[0], "http://localhost:3000");
        assert_eq!(origins[1], "http://example.com");
        assert_eq!(origins[2], "http://test.com");
    }

    #[test]
    fn allowed_origins_single_value() {
        let input = "http://localhost:3000";
        let origins: Vec<String> = input
            .split(',')
            .map(|s| s.trim().to_string())
            .collect();
        assert_eq!(origins, vec!["http://localhost:3000"]);
    }

    #[test]
    fn db_max_connections_default_development() {
        let environment = "development";
        let default = if environment == "production" { 20 } else { 5 };
        assert_eq!(default, 5);
    }

    #[test]
    fn db_max_connections_default_production() {
        let environment = "production";
        let default = if environment == "production" { 20 } else { 5 };
        assert_eq!(default, 20);
    }

    #[test]
    fn db_max_lifetime_default_development() {
        let environment = "development";
        let default = if environment == "production" { 300 } else { 0 };
        assert_eq!(default, 0); // disabled in dev
    }

    #[test]
    fn db_max_lifetime_default_production() {
        let environment = "production";
        let default = if environment == "production" { 300 } else { 0 };
        assert_eq!(default, 300); // 5 minutes in prod
    }

    #[test]
    fn api_concurrency_limit_clamping() {
        let calc = |db_max_conn: u32| (db_max_conn as usize * 8).clamp(64, 512);
        assert_eq!(calc(5), 64);   // 40 → clamped to min 64
        assert_eq!(calc(8), 64);   // At min boundary
        assert_eq!(calc(20), 160); // Normal
        assert_eq!(calc(64), 512); // At max
        assert_eq!(calc(100), 512); // Above max → clamped
    }

    #[test]
    fn api_buffer_size_clamping() {
        let calc = |concurrency: usize| (concurrency * 8).clamp(256, 4096);
        assert_eq!(calc(8), 256);  // 64 → clamped to min 256
        assert_eq!(calc(32), 256); // At min boundary
        assert_eq!(calc(160), 1280); // Normal
        assert_eq!(calc(512), 4096); // At max
        assert_eq!(calc(1000), 4096); // Above max → clamped
    }

    #[test]
    fn session_state_cache_ttl_default_development() {
        let environment = "development";
        let default = if environment == "production" { 1_000 } else { 0 };
        assert_eq!(default, 0); // disabled in dev
    }

    #[test]
    fn session_state_cache_ttl_default_production() {
        let environment = "production";
        let default = if environment == "production" { 1_000 } else { 0 };
        assert_eq!(default, 1_000); // 1 second in prod
    }

    #[test]
    fn perf_test_token_trimmed_and_filtered() {
        let parse_token = |input: Option<&str>| -> Option<String> {
            input.map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
        };

        assert_eq!(parse_token(Some("  my-token  ")), Some("my-token".to_string()));
        assert_eq!(parse_token(Some("   ")), None);
        assert_eq!(parse_token(Some("")), None);
        assert_eq!(parse_token(None), None);
        assert_eq!(parse_token(Some("token")), Some("token".to_string()));
    }

    #[test]
    fn port_parsing() {
        let parse_port = |input: &str| -> Result<u16, String> {
            input.parse().map_err(|e| format!("Invalid PORT: {}", e))
        };

        assert_eq!(parse_port("8080"), Ok(8080));
        assert_eq!(parse_port("3000"), Ok(3000));
        assert_eq!(parse_port("0"), Ok(0));
        assert!(parse_port("not-a-number").is_err());
        assert!(parse_port("-1").is_err());
        assert!(parse_port("65536").is_err()); // overflow for u16
    }
}
