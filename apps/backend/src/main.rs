use axum::{
    routing::{get, post, put},
    Router, Extension,
};
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use tower_governor::GovernorLayer;
use tower_governor::governor::GovernorConfigBuilder;
use tower_governor::key_extractor::SmartIpKeyExtractor;

mod config;
mod db;
mod error;
mod handlers;
mod middleware;
mod models;
mod repositories;
mod services;

use config::Config;
use db::LazyDbPool;
use repositories::session::SessionRepository;
use repositories::sqlx_session::SqlxSessionRepository;
use services::session::SessionService;

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

    // Create lazy DB pool (instant, no blocking)
    let lazy_pool = LazyDbPool::new();
    
    // Start background DB initialization
    let run_migrations = !config.is_production(); // Skip migrations in prod
    lazy_pool.clone().start_background_init(
        config.database_url.clone(),
        run_migrations,
    );

    // Initialize Services with lazy pool
    let session_repository: Arc<dyn SessionRepository> = 
        Arc::new(SqlxSessionRepository::new_lazy(lazy_pool.clone()));
    let session_service = Arc::new(SessionService::new(session_repository));
    
    let app_state = AppState {
        db_pool: lazy_pool,
        session_service,
    };
    
    tracing::info!("App state created in {:?}", startup_time.elapsed());

    // Rate limiting configuration
    let general_governor_conf = Arc::new(
        GovernorConfigBuilder::default()
            .per_second(2)
            .burst_size(30)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .unwrap(),
    );

    let strict_governor_conf = Arc::new(
        GovernorConfigBuilder::default()
            .per_second(1)
            .burst_size(10)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .unwrap(),
    );

    // CORS
    let allowed_origins: Vec<axum::http::HeaderValue> = config.allowed_origins
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
        ])
        .allow_credentials(true);

    // Routes
    let app = Router::new()
        // Health endpoints (no rate limiting, no auth)
        .route("/health", get(handlers::health::health_check))
        .route("/health/live", get(handlers::health::liveness))
        .route("/health/ready", get(handlers::health::readiness))
        
        // Authentication
        .route("/api/auth/register", post(handlers::auth::register))
        .route("/api/auth/login", post(handlers::auth::login))
        .route("/api/auth/ably", get(handlers::ably::get_ably_token))
        
        // Public endpoints (no auth required)
        .route("/api/share/:token", get(handlers::public::get_session_by_share_token))
        .route("/api/session-by-token/:token", get(handlers::public::get_session_by_share_token))
        .route("/api/sessions/:id/state", get(handlers::public::get_session_state))
        
        // Public clicker endpoints
        .route("/api/sessions/:id/clicker/slide", put(handlers::public::public_set_current_slide))
        .route("/api/sessions/:id/clicker/results", put(handlers::public::public_set_results_visibility))
        
        // Session stats
        .route("/api/sessions/public/:id/stats", get(handlers::stats::get_public_session_stats))
        
        // Protected session endpoints
        .route("/api/sessions", 
            get(handlers::session::get_sessions)
            .post(handlers::session::create_session))
        .route("/api/sessions/:id", 
            get(handlers::session::get_session)
            .put(handlers::session::update_session)
            .delete(handlers::session::delete_session))
        .route("/api/sessions/:id/duplicate", post(handlers::session::duplicate_session))
        .route("/api/sessions/:id/archive", put(handlers::session::archive_session))
        .route("/api/sessions/:id/restore", put(handlers::session::restore_session))
        
        // Session stats
        .route("/api/sessions/:id/stats", get(handlers::stats::get_session_stats))
        
        // Live session controls
        .route("/api/sessions/:id/current-slide", put(handlers::live::set_current_slide))
        .route("/api/sessions/:id/results-visibility", put(handlers::live::set_results_visibility))
        .route("/api/sessions/:id/go-live", post(handlers::live::go_live))
        .route("/api/sessions/:id/stop", post(handlers::live::stop_live))
        
        // Slide management
        .route("/api/sessions/:id/slides", 
            get(handlers::slide::get_slides)
            .post(handlers::slide::create_slide))
        .route("/api/sessions/:session_id/slides/:slide_id", 
            axum::routing::put(handlers::slide::update_slide)
            .delete(handlers::slide::delete_slide))
        .route("/api/sessions/:session_id/slides/:slide_id/visibility",
            axum::routing::patch(handlers::live::update_slide_visibility))
        .route("/api/sessions/:id/slides/reorder", 
            axum::routing::put(handlers::slide::reorder_slides))
        
        // Student interaction endpoints
        .route("/api/sessions/:id/vote", post(handlers::student::submit_vote))
        .route("/api/sessions/:id/questions", post(handlers::student::submit_question))
        .route("/api/sessions/:session_id/questions/:question_id/upvote",
            post(handlers::student::upvote_question))
        .route("/api/sessions/:id/register-participant",
            post(handlers::student::register_participant))
        
        // Rate limiting layers
        .layer(GovernorLayer { config: strict_governor_conf })
        .layer(GovernorLayer { config: general_governor_conf })
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .layer(Extension(config_arc))
        .with_state(app_state);

    // Start server IMMEDIATELY (don't wait for DB)
    let addr = format!("0.0.0.0:{}", config.port);
    tracing::info!("Server listening on {} (startup: {:?})", addr, startup_time.elapsed());
    
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await?;

    Ok(())
}
