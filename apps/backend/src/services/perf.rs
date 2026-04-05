use serde::Serialize;
use sqlx::query_scalar;

use crate::db::DbPool;
use crate::error::{AppError, Result};
use crate::services::wal::WalStore;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfCleanupResponse {
    pub session_id: String,
    pub creator_id: String,
    pub deleted_creator_user: bool,
    pub deleted_wal_entries: u64,
}

pub async fn cleanup_perf_session(
    pool: &DbPool,
    wal_store: &WalStore,
    session_id: &str,
    delete_creator_user: bool,
) -> Result<PerfCleanupResponse> {
    let deleted_wal_entries = wal_store.delete_entries_for_session(session_id).await?;
    let mut tx = pool.begin().await?;

    let creator_id: String = query_scalar("SELECT creator_id FROM sessions WHERE id = ?")
        .bind(session_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;

    sqlx::query("DELETE FROM slide_delete_requests WHERE session_id = ?")
        .bind(session_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "DELETE FROM question_upvotes WHERE question_id IN (SELECT id FROM questions WHERE session_id = ?)",
    )
    .bind(session_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM vote_submissions WHERE session_id = ?")
        .bind(session_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("DELETE FROM votes WHERE session_id = ?")
        .bind(session_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("DELETE FROM questions WHERE session_id = ?")
        .bind(session_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("DELETE FROM participants WHERE session_id = ?")
        .bind(session_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("DELETE FROM slides WHERE session_id = ?")
        .bind(session_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(session_id)
        .execute(&mut *tx)
        .await?;

    let mut deleted_creator_user = false;
    if delete_creator_user {
        let remaining_sessions: i64 =
            query_scalar("SELECT COUNT(*) FROM sessions WHERE creator_id = ?")
                .bind(&creator_id)
                .fetch_one(&mut *tx)
                .await?;

        if remaining_sessions == 0 {
            let rows_affected = sqlx::query("DELETE FROM users WHERE id = ?")
                .bind(&creator_id)
                .execute(&mut *tx)
                .await?
                .rows_affected();
            deleted_creator_user = rows_affected > 0;
        }
    }

    tx.commit().await?;

    Ok(PerfCleanupResponse {
        session_id: session_id.to_string(),
        creator_id,
        deleted_creator_user,
        deleted_wal_entries,
    })
}
