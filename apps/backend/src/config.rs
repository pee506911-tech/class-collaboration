use dotenvy::dotenv;
use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub environment: String,
    pub database_url: String,
    pub jwt_secret: String,
    pub port: u16,
    pub allowed_origins: Vec<String>,
    // Enable per-IP rate limiting for general API routes. For classroom deployments
    // where many users share one NAT IP, this is often counterproductive; prefer
    // the concurrency+buffer limits instead, and keep strict rate limiting on auth.
    pub enable_general_rate_limit: bool,
    // Rate limiting is per-IP (SmartIpKeyExtractor). These defaults are chosen to
    // handle classroom-style bursts (e.g. ~150 users on the same NAT).
    pub rate_limit_general_per_second: u64,
    pub rate_limit_general_burst: u32,
    pub rate_limit_strict_per_second: u64,
    pub rate_limit_strict_burst: u32,
    // DB pool tuning. Defaults are environment-sensitive:
    // - development: conservative (works with low-connection DB plans)
    // - production: sized for ~150–200 concurrent classroom users
    pub db_max_connections: u32,
    pub db_min_connections: u32,
    pub db_acquire_timeout_seconds: u64,
    pub db_idle_timeout_seconds: u64,
    // Connection lifetime tuning (important for TiDB Cloud Starter/Essential, where
    // long-lived connections can be terminated unexpectedly).
    pub db_max_lifetime_seconds: u64,
    // API overload protection (buffers bursts and bounds in-flight work)
    pub api_concurrency_limit: usize,
    pub api_buffer_size: usize,
    // Cache session state snapshots to survive join storms (500 users / 10s).
    // This prevents N identical /state queries from repeatedly running the same
    // slides/questions/vote_counts aggregations.
    pub session_state_cache_ttl_ms: u64,
    pub session_state_cache_max_entries: usize,
    pub perf_test_token: Option<String>,
}

impl Config {
    pub fn from_env() -> Self {
        dotenv().ok();

        let environment = env::var("ENVIRONMENT").unwrap_or_else(|_| "development".to_string());
        let database_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");
        let jwt_secret = env::var("JWT_SECRET").expect("JWT_SECRET must be set");
        let port = env::var("PORT")
            .unwrap_or_else(|_| "8080".to_string())
            .parse()
            .expect("PORT must be a number");

        let allowed_origins = env::var("ALLOWED_ORIGINS")
            .unwrap_or_else(|_| "http://localhost:3000".to_string())
            .split(',')
            .map(|s| s.trim().to_string())
            .collect();

        let enable_general_rate_limit = env::var("ENABLE_GENERAL_RATE_LIMIT")
            .ok()
            .as_deref()
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        // Rate limiting:
        // - "Strict" is intended for auth endpoints to slow down brute-force attempts.
        // - "General" is for the rest of the API (votes/questions), tuned for bursts.
        let rate_limit_general_per_second = env::var("RATE_LIMIT_GENERAL_PER_SECOND")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(100);
        let rate_limit_general_burst = env::var("RATE_LIMIT_GENERAL_BURST")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1500);
        let rate_limit_strict_per_second = env::var("RATE_LIMIT_STRICT_PER_SECOND")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(5);
        let rate_limit_strict_burst = env::var("RATE_LIMIT_STRICT_BURST")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(20);

        let default_db_max_connections = if environment == "production" { 40 } else { 5 };
        let db_max_connections = env::var("DB_MAX_CONNECTIONS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default_db_max_connections);
        let db_min_connections = env::var("DB_MIN_CONNECTIONS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let db_acquire_timeout_seconds = env::var("DB_ACQUIRE_TIMEOUT_SECONDS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(30);
        let db_idle_timeout_seconds = env::var("DB_IDLE_TIMEOUT_SECONDS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(600);

        let default_db_max_lifetime_seconds = if environment == "production" { 300 } else { 0 };
        let db_max_lifetime_seconds = env::var("DB_MAX_LIFETIME_SECONDS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default_db_max_lifetime_seconds);

        let default_api_concurrency_limit = (db_max_connections as usize * 8).clamp(64, 512);
        let api_concurrency_limit = env::var("API_CONCURRENCY_LIMIT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default_api_concurrency_limit);

        let default_api_buffer_size = (api_concurrency_limit * 8).clamp(256, 4096);
        let api_buffer_size = env::var("API_BUFFER_SIZE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default_api_buffer_size);

        let default_session_state_cache_ttl_ms = if environment == "production" {
            1_000
        } else {
            0
        };
        let session_state_cache_ttl_ms = env::var("SESSION_STATE_CACHE_TTL_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default_session_state_cache_ttl_ms);

        let session_state_cache_max_entries = env::var("SESSION_STATE_CACHE_MAX_ENTRIES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(200);

        let perf_test_token = env::var("PERF_TEST_TOKEN")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        Self {
            environment,
            database_url,
            jwt_secret,
            port,
            allowed_origins,
            enable_general_rate_limit,
            rate_limit_general_per_second,
            rate_limit_general_burst,
            rate_limit_strict_per_second,
            rate_limit_strict_burst,
            db_max_connections,
            db_min_connections,
            db_acquire_timeout_seconds,
            db_idle_timeout_seconds,
            db_max_lifetime_seconds,
            api_concurrency_limit,
            api_buffer_size,
            session_state_cache_ttl_ms,
            session_state_cache_max_entries,
            perf_test_token,
        }
    }
}
