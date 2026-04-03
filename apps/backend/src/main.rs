use axum::{
    error_handling::HandleErrorLayer,
    http::header::HeaderName,
    routing::{get, post, put},
    Extension, Router,
};
use std::sync::Arc;
use tower::buffer::BufferLayer;
use tower::limit::ConcurrencyLimitLayer;
use tower::{BoxError, ServiceBuilder};
use tower_governor::governor::GovernorConfigBuilder;
use tower_governor::key_extractor::SmartIpKeyExtractor;
use tower_governor::GovernorLayer;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod config;
mod db;
mod error;
mod handlers;
mod middleware;
mod models;
mod repositories;
mod services;
mod tidb_ru;

use config::Config;
use db::{DbPoolSettings, LazyDbPool};
use repositories::session::SessionRepository;
use repositories::sqlx_session::SqlxSessionRepository;
use services::session::{SessionService, SessionStateCache};

/// Application state shared across all handlers
#[derive(Clone)]
pub struct AppState {
    pub db_pool: LazyDbPool,
    pub session_service: Arc<SessionService>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize tracing (fast, ~10ms)
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let startup_time = std::time::Instant::now();
    tracing::info!("Starting server (cold start optimization enabled)...");

    // Load config (fast, ~5ms)
    let config = Config::from_env();
    let config_arc = Arc::new(config.clone());
    tracing::info!(
        environment = %config.environment,
        db_max_connections = config.db_max_connections,
        db_max_lifetime_seconds = config.db_max_lifetime_seconds,
        api_concurrency_limit = config.api_concurrency_limit,
        api_buffer_size = config.api_buffer_size,
        session_state_cache_ttl_ms = config.session_state_cache_ttl_ms,
        session_state_cache_max_entries = config.session_state_cache_max_entries,
        enable_general_rate_limit = config.enable_general_rate_limit,
        rate_limit_general_per_second = config.rate_limit_general_per_second,
        rate_limit_general_burst = config.rate_limit_general_burst,
        "Config loaded"
    );

    // Create lazy DB pool (instant, no blocking)
    let lazy_pool = LazyDbPool::new();

    // Start background DB initialization.
    // SQLx tracks applied migrations, so rerunning on boot only applies new ones.
    let run_migrations = true;
    let db_pool_settings = DbPoolSettings {
        max_connections: config.db_max_connections,
        min_connections: config.db_min_connections,
        acquire_timeout_seconds: config.db_acquire_timeout_seconds,
        idle_timeout_seconds: config.db_idle_timeout_seconds,
        max_lifetime_seconds: config.db_max_lifetime_seconds,
    };
    lazy_pool.clone().start_background_init(
        config.database_url.clone(),
        run_migrations,
        db_pool_settings,
    );

    // Initialize Services with lazy pool
    let session_repository: Arc<dyn SessionRepository> =
        Arc::new(SqlxSessionRepository::new_lazy(lazy_pool.clone()));
    let state_cache = SessionStateCache::new(
        std::time::Duration::from_millis(config.session_state_cache_ttl_ms),
        config.session_state_cache_max_entries,
    );
    let session_service = Arc::new(SessionService::new(session_repository, state_cache));

    let app_state = AppState {
        db_pool: lazy_pool,
        session_service,
    };

    tracing::info!("App state created in {:?}", startup_time.elapsed());

    // Rate limiting configuration
    let general_governor_conf = Arc::new(
        GovernorConfigBuilder::default()
            .per_second(config.rate_limit_general_per_second)
            .burst_size(config.rate_limit_general_burst)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .unwrap(),
    );

    let strict_governor_conf = Arc::new(
        GovernorConfigBuilder::default()
            .per_second(config.rate_limit_strict_per_second)
            .burst_size(config.rate_limit_strict_burst)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .unwrap(),
    );

    // CORS
    let allowed_origins: Vec<axum::http::HeaderValue> = config
        .allowed_origins
        .iter()
        .map(|origin| origin.parse().expect("Invalid allowed origin"))
        .collect();

    let cors = CorsLayer::new()
        .allow_origin(allowed_origins)
        .allow_methods(vec![
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PUT,
            axum::http::Method::DELETE,
            axum::http::Method::PATCH,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers(vec![
            axum::http::header::CONTENT_TYPE,
            axum::http::header::AUTHORIZATION,
            axum::http::header::ACCEPT,
            axum::http::header::ORIGIN,
            HeaderName::from_static("x-client-request-id"),
        ])
        .allow_credentials(true);

    // Routes: keep health endpoints unthrottled; apply "strict" only to auth; apply
    // "general" to the rest of the API. The previous approach stacked both
    // limiters globally, which effectively enforced the strict limits everywhere.
    let overload_protection = ServiceBuilder::new()
        .layer(HandleErrorLayer::new(|_err: BoxError| async move {
            (
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "Server busy, please retry",
            )
        }))
        .layer(BufferLayer::new(config.api_buffer_size))
        .layer(ConcurrencyLimitLayer::new(config.api_concurrency_limit));

    let health_routes = Router::new()
        // Health endpoints (no rate limiting, no auth)
        .route("/health", get(handlers::health::health_check))
        .route("/health/live", get(handlers::health::liveness))
        .route("/health/ready", get(handlers::health::readiness));

    let auth_routes = Router::new()
        // Authentication (strict rate limiting)
        .route("/api/auth/register", post(handlers::auth::register))
        .route("/api/auth/login", post(handlers::auth::login))
        .layer(overload_protection.clone())
        .layer(GovernorLayer {
            config: strict_governor_conf,
        });

    let api_routes = Router::new()
        // Client-side telemetry (no auth)
        .route(
            "/api/client-error",
            post(handlers::client_error::report_client_error),
        )
        // Ably token request signing (public; must tolerate classroom NAT bursts)
        .route("/api/auth/ably", get(handlers::ably::get_ably_token))
        // Public endpoints (no auth required)
        .route(
            "/api/share/:token",
            get(handlers::public::get_session_by_share_token),
        )
        .route(
            "/api/session-by-token/:token",
            get(handlers::public::get_session_by_share_token),
        )
        .route(
            "/api/sessions/:id/state",
            get(handlers::public::get_session_state),
        )
        // Public clicker endpoints
        .route(
            "/api/sessions/:id/clicker/slide",
            put(handlers::public::public_set_current_slide),
        )
        .route(
            "/api/sessions/:id/clicker/results",
            put(handlers::public::public_set_results_visibility),
        )
        // Session stats
        .route(
            "/api/sessions/public/:id/stats",
            get(handlers::stats::get_public_session_stats),
        )
        // Protected session endpoints
        .route(
            "/api/sessions",
            get(handlers::session::get_sessions).post(handlers::session::create_session),
        )
        .route(
            "/api/sessions/:id",
            get(handlers::session::get_session)
                .put(handlers::session::update_session)
                .delete(handlers::session::delete_session),
        )
        .route(
            "/api/sessions/:id/duplicate",
            post(handlers::session::duplicate_session),
        )
        .route(
            "/api/sessions/:id/archive",
            put(handlers::session::archive_session),
        )
        .route(
            "/api/sessions/:id/restore",
            put(handlers::session::restore_session),
        )
        // Session stats
        .route(
            "/api/sessions/:id/stats",
            get(handlers::stats::get_session_stats),
        )
        // Live session controls
        .route(
            "/api/sessions/:id/current-slide",
            put(handlers::live::set_current_slide),
        )
        .route(
            "/api/sessions/:id/results-visibility",
            put(handlers::live::set_results_visibility),
        )
        .route("/api/sessions/:id/go-live", post(handlers::live::go_live))
        .route("/api/sessions/:id/stop", post(handlers::live::stop_live))
        // Slide management
        .route(
            "/api/sessions/:id/slides",
            get(handlers::slide::get_slides).post(handlers::slide::create_slide),
        )
        .route(
            "/api/sessions/:session_id/slides/:slide_id",
            axum::routing::put(handlers::slide::update_slide).delete(handlers::slide::delete_slide),
        )
        .route(
            "/api/sessions/:session_id/slides/:slide_id/visibility",
            axum::routing::patch(handlers::live::update_slide_visibility),
        )
        .route(
            "/api/sessions/:id/slides/reorder",
            axum::routing::put(handlers::slide::reorder_slides),
        )
        // Student interaction endpoints
        .route(
            "/api/sessions/:id/vote",
            post(handlers::student::submit_vote),
        )
        .route(
            "/api/sessions/:id/my-votes",
            get(handlers::student::get_my_votes),
        )
        .route(
            "/api/sessions/:id/questions",
            post(handlers::student::submit_question),
        )
        .route(
            "/api/sessions/:session_id/questions/:question_id/upvote",
            post(handlers::student::upvote_question),
        )
        .route(
            "/api/sessions/:id/register-participant",
            post(handlers::student::register_participant),
        );

    let api_routes = api_routes.layer(overload_protection);
    let api_routes = if config.enable_general_rate_limit {
        api_routes.layer(GovernorLayer {
            config: general_governor_conf,
        })
    } else {
        api_routes
    };

    let app = Router::new()
        .merge(health_routes)
        .merge(auth_routes)
        .merge(api_routes)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .layer(Extension(config_arc))
        .with_state(app_state);

    // Start server IMMEDIATELY (don't wait for DB)
    let addr = format!("0.0.0.0:{}", config.port);
    tracing::info!(
        "Server listening on {} (startup: {:?})",
        addr,
        startup_time.elapsed()
    );

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;

    Ok(())
}
