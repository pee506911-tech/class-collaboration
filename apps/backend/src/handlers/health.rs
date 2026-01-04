use axum::{extract::State, http::StatusCode, Json};
use serde::Serialize;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub database: &'static str,
}

/// Liveness probe - always returns 200 if server is running
/// Use for: Load balancer health checks, container liveness
pub async fn liveness() -> &'static str {
    "OK"
}

/// Readiness probe - returns 200 only when DB is connected
/// Use for: Kubernetes readiness, traffic routing decisions
pub async fn readiness(
    State(app_state): State<crate::AppState>,
) -> Result<Json<HealthResponse>, (StatusCode, Json<HealthResponse>)> {
    if !app_state.db_pool.is_ready() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(HealthResponse {
                status: "initializing",
                database: "connecting",
            }),
        ));
    }

    // Verify DB is actually working
    if let Some(pool) = app_state.db_pool.get().await {
        match sqlx::query("SELECT 1").execute(&pool).await {
            Ok(_) => Ok(Json(HealthResponse {
                status: "healthy",
                database: "connected",
            })),
            Err(_) => Err((
                StatusCode::SERVICE_UNAVAILABLE,
                Json(HealthResponse {
                    status: "unhealthy",
                    database: "error",
                }),
            )),
        }
    } else {
        Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(HealthResponse {
                status: "initializing",
                database: "not_ready",
            }),
        ))
    }
}

/// Legacy health check - for backward compatibility
/// Returns 200 only when fully ready
pub async fn health_check(State(app_state): State<crate::AppState>) -> Result<&'static str, StatusCode> {
    if !app_state.db_pool.is_ready() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    
    if let Some(pool) = app_state.db_pool.get().await {
        sqlx::query("SELECT 1")
            .execute(&pool)
            .await
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        Ok("OK")
    } else {
        Err(StatusCode::SERVICE_UNAVAILABLE)
    }
}
