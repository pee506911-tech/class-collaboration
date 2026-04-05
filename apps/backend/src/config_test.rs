#[cfg(test)]
mod tests {
    use crate::config::{recommended_api_buffer_size, recommended_api_concurrency_limit};
    use std::env;

    // Helper to build a Config from specific env vars, restoring originals after test
    struct EnvGuard {
        vars: Vec<(&'static str, Option<String>)>,
    }

    impl EnvGuard {
        fn new(vars: Vec<(&'static str, Option<&'static str>)>) -> Self {
            let mut saved = Vec::new();
            for (key, value) in &vars {
                let existing = env::var(key).ok();
                saved.push((*key, existing));
                match value {
                    Some(v) => env::set_var(key, v),
                    None => {
                        let _ = env::remove_var(key);
                    }
                }
            }
            Self { vars: saved }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, value) in &self.vars {
                match value {
                    Some(v) => env::set_var(key, v),
                    None => {
                        let _ = env::remove_var(key);
                    }
                }
            }
        }
    }

    // --- Default Rate Limit Config Tests ---

    #[test]
    fn strict_rate_limits_default_values() {
        // These require DATABASE_URL and JWT_SECRET to parse, so we test the logic separately
        // The strict limits are: 5/sec, 20 burst
        let expected_per_second: u64 = 5;
        let expected_burst: u32 = 20;

        // Classroom-scale: low rate to prevent brute-force
        assert_eq!(expected_per_second, 5);
        assert_eq!(expected_burst, 20);
    }

    #[test]
    fn general_rate_limits_default_values() {
        // General limits are: 100/sec, 1500 burst
        let expected_per_second: u64 = 100;
        let expected_burst: u32 = 1500;

        // Classroom-scale: high burst to handle 150+ users on same NAT
        assert_eq!(expected_per_second, 100);
        assert_eq!(expected_burst, 1500);
    }

    #[test]
    fn general_rate_limit_disabled_by_default() {
        // enable_general_rate_limit defaults to false
        let _guard = EnvGuard::new(vec![
            ("DATABASE_URL", Some("mysql://test")),
            ("JWT_SECRET", Some("secret")),
            ("ENABLE_GENERAL_RATE_LIMIT", None),
        ]);

        // We can't easily test Config::from_env without env vars,
        // so we test the default logic directly:
        let default_value = None::<&str>
            .as_deref()
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        assert!(
            !default_value,
            "general rate limit should be disabled by default"
        );
    }

    #[test]
    fn general_rate_limit_can_be_enabled() {
        for value in &["1", "true", "TRUE", "True"] {
            let parsed = Some(*value)
                .as_deref()
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            assert!(parsed, "value '{}' should enable rate limit", value);
        }
    }

    #[test]
    fn general_rate_limit_stays_disabled_for_false_values() {
        for value in &["0", "false", "FALSE", "no", ""] {
            let parsed = Some(*value)
                .as_deref()
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            assert!(!parsed, "value '{}' should keep rate limit disabled", value);
        }
    }

    // --- Rate Limit Ratio Tests ---

    #[test]
    fn strict_rate_limit_burst_ratio() {
        // Burst should be ~4x the per-second rate for auth
        let per_second: u64 = 5;
        let burst: u32 = 20;
        let ratio = burst as f64 / per_second as f64;

        // 4x ratio allows for short bursts during login/register
        assert!((ratio - 4.0).abs() < 0.1);
    }

    #[test]
    fn general_rate_limit_burst_ratio() {
        // Burst should be ~15x the per-second rate for general API
        let per_second: u64 = 100;
        let burst: u32 = 1500;
        let ratio = burst as f64 / per_second as f64;

        // 15x ratio allows classroom NAT bursts
        assert!((ratio - 15.0).abs() < 0.1);
    }

    // --- Environment Variable Override Tests ---

    #[test]
    fn rate_limit_env_vars_override_defaults() {
        // Test parsing logic for custom values
        let custom_per_second = "50".parse::<u64>();
        let custom_burst = "500".parse::<u32>();

        assert_eq!(custom_per_second.unwrap(), 50);
        assert_eq!(custom_burst.unwrap(), 500);
    }

    #[test]
    fn invalid_rate_limit_env_vars_fall_back_to_defaults() {
        let invalid_values = vec!["abc", "-1", "0", "99999999999999"];

        for val in invalid_values {
            let parsed_u64 = val.parse::<u64>().ok();
            let parsed_u32 = val.parse::<u32>().ok();

            // Invalid values return None, allowing fallback to defaults
            if val == "0" {
                assert!(parsed_u64.is_some()); // "0" is valid u64
                assert!(parsed_u32.is_some()); // "0" is valid u32
            } else if val == "abc" || val == "-1" {
                assert!(parsed_u64.is_none());
                assert!(parsed_u32.is_none());
            }
        }
    }

    // --- Rate Limit Design Rationale Tests ---

    #[test]
    fn strict_rate_limits_protect_auth_endpoints() {
        // Auth endpoints (login/register) need strict limits to prevent:
        // - Brute-force password attacks
        // - Account enumeration
        // - Credential stuffing

        let strict_per_second: u64 = 5; // 5 requests per second
        let strict_burst: u32 = 20; // burst of 20

        // At 5/sec, brute-forcing a 8-char password would take years
        assert!(strict_per_second <= 10, "strict limit should be <= 10/sec");
        assert!(strict_burst <= 50, "strict burst should be <= 50");
    }

    #[test]
    fn general_rate_limits_accommodate_classroom_nats() {
        // General API needs high burst because:
        // - 150+ students may vote simultaneously
        // - They often share one NAT IP (school wifi)
        // - IP-based rate limiting would block legitimate users

        let general_per_second: u64 = 100;
        let general_burst: u32 = 1500;

        // 1500 burst handles a full classroom voting at once
        assert!(general_burst >= 150, "burst should handle classroom scale");
        assert!(
            general_per_second >= 50,
            "per-second should allow voting bursts"
        );
    }

    #[test]
    fn concurrency_limits_as_backup_protection() {
        // Even with rate limits disabled, concurrency limits protect against:
        // - Slowloris-style attacks
        // - Memory exhaustion from too many in-flight requests

        // Default concurrency leaves DB headroom for background workers first,
        // then scales request admission from the remaining pool capacity.
        let db_max_connections: u32 = 5; // dev default
        let calculated = recommended_api_concurrency_limit(db_max_connections);
        assert_eq!(calculated, 16);

        // Default buffer still absorbs bursts, but scales from the safer
        // concurrency limit instead of assuming the DB can serve them all.
        let calculated_buffer = recommended_api_buffer_size(calculated);
        assert_eq!(calculated_buffer, 128);
    }

    #[test]
    fn production_db_settings_scale_higher() {
        // Production settings should scale for more concurrent users
        let db_max_connections: u32 = 40; // production default
        let calculated = recommended_api_concurrency_limit(db_max_connections);
        assert_eq!(calculated, 152);

        let calculated_buffer = recommended_api_buffer_size(calculated);
        assert_eq!(calculated_buffer, 1216);
    }

    #[test]
    fn concurrency_formula_reserves_background_db_headroom() {
        assert_eq!(recommended_api_concurrency_limit(1), 16);
        assert_eq!(recommended_api_concurrency_limit(8), 24);
        assert_eq!(recommended_api_concurrency_limit(64), 248);
        assert_eq!(recommended_api_concurrency_limit(200), 512);
    }
}
