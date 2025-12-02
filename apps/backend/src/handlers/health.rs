use axum::extract::State;
use crate::error::Result;

pub async fn health_check(State(app_state): State<crate::AppState>) -> Result<&'static str> {
    sqlx::query("SELECT 1").execute(&app_state.db_pool).await?;
    Ok("OK")
}
