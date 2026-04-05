use axum::{
    extract::{Extension, Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use std::sync::Arc;

use crate::config::Config;
use crate::error::{AppError, Result};
use crate::models::response::ApiResponse;
use crate::services::perf::{cleanup_perf_session, PerfCleanupResponse};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPerfQuery {
    pub delete_creator_user: Option<bool>,
}

fn verify_perf_access(headers: &HeaderMap, config: &Config) -> Result<()> {
    let Some(expected_token) = config.perf_test_token.as_deref() else {
        return Err(AppError::NotFound("Not found".to_string()));
    };

    let provided_token = headers
        .get("x-perf-test-token")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::Auth("Missing perf test token".to_string()))?;

    if provided_token != expected_token {
        return Err(AppError::Auth("Unauthorized".to_string()));
    }

    Ok(())
}

pub async fn cleanup_session(
    State(app_state): State<crate::AppState>,
    Extension(config): Extension<Arc<Config>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(query): Query<CleanupPerfQuery>,
) -> Result<Json<ApiResponse<PerfCleanupResponse>>> {
    verify_perf_access(&headers, &config)?;

    let pool = app_state.db_pool.pool_fast_fail().await?;
    let cleanup = cleanup_perf_session(
        &pool,
        &app_state.wal_store,
        &session_id,
        query.delete_creator_user.unwrap_or(false),
    )
    .await?;

    Ok(Json(ApiResponse::success(cleanup)))
}
