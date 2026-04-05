use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::error::{AppError, Result};
use crate::handlers::{slide, student};
use crate::models::response::ApiResponse;
use crate::models::slide::{Slide, UpdateSlideRequest};
use crate::services::outbox::OutboxEventType;
use crate::services::session::SessionService;
use chrono::Utc;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use sqlx::mysql::MySqlQueryResult;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{MySql, Pool, Row, Sqlite, Transaction};
use tokio::sync::watch;
use tokio::time::MissedTickBehavior;
#[cfg(test)]
use uuid::Uuid;

const SQLITE_INIT_STATEMENTS: &[&str] = &[
    "PRAGMA journal_mode = WAL",
    "PRAGMA synchronous = FULL",
    "PRAGMA auto_vacuum = INCREMENTAL",
    "PRAGMA busy_timeout = 5000",
    "CREATE TABLE IF NOT EXISTS wal_entries (
        wal_id INTEGER PRIMARY KEY AUTOINCREMENT,
        op_type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        client_request_id TEXT NOT NULL,
        resource_id TEXT,
        payload TEXT NOT NULL,
        response_payload TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        flushed INTEGER NOT NULL DEFAULT 0,
        flush_error TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0
    )",
    "CREATE UNIQUE INDEX IF NOT EXISTS wal_entries_request_idx
        ON wal_entries (session_id, client_request_id, op_type)",
    "CREATE INDEX IF NOT EXISTS wal_entries_pending_idx
        ON wal_entries (flushed, priority, created_at, wal_id)",
];

const DEFAULT_WAL_PATH: &str = "data/wal.sqlite";
const FLUSH_BATCH_SIZE: i64 = 50;
const FLUSH_INTERVAL_MS: u64 = 200;
const MAX_RETRY_COUNT: i32 = 3;
const MAX_PENDING_ENTRIES: i64 = 5_000;
const CLEANUP_AGE_HOURS: i64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WalOpType {
    CreateSlide,
    UpdateSlide,
    DeleteSlide,
    ReorderSlides,
    CreateSlidesBatch,
    SubmitVote,
    SubmitQuestion,
    UpvoteQuestion,
}

impl WalOpType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CreateSlide => "create_slide",
            Self::UpdateSlide => "update_slide",
            Self::DeleteSlide => "delete_slide",
            Self::ReorderSlides => "reorder_slides",
            Self::CreateSlidesBatch => "create_slides_batch",
            Self::SubmitVote => "submit_vote",
            Self::SubmitQuestion => "submit_question",
            Self::UpvoteQuestion => "upvote_question",
        }
    }
}

impl std::fmt::Display for WalOpType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for WalOpType {
    type Err = AppError;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "create_slide" => Ok(Self::CreateSlide),
            "update_slide" => Ok(Self::UpdateSlide),
            "delete_slide" => Ok(Self::DeleteSlide),
            "reorder_slides" => Ok(Self::ReorderSlides),
            "create_slides_batch" => Ok(Self::CreateSlidesBatch),
            "submit_vote" => Ok(Self::SubmitVote),
            "submit_question" => Ok(Self::SubmitQuestion),
            "upvote_question" => Ok(Self::UpvoteQuestion),
            _ => Err(AppError::Internal(format!("Unknown WAL op type: {value}"))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedWriteAck<T> {
    #[serde(flatten)]
    pub data: T,
    pub queued: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSlideWalPayload {
    pub slide_id: String,
    #[serde(rename = "type")]
    pub slide_type: String,
    pub content: Value,
    pub insert_after_slide_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSlidesBatchWalItem {
    pub slide_id: String,
    #[serde(rename = "type")]
    pub slide_type: String,
    pub content: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSlidesBatchWalPayload {
    pub slides: Vec<CreateSlidesBatchWalItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSlideWalPayload {
    pub slide_id: String,
    #[serde(rename = "type")]
    pub slide_type: Option<String>,
    pub content: Option<Value>,
    pub base_version: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSlideWalPayload {
    pub slide_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderSlidesWalPayload {
    pub slide_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitVoteWalPayload {
    pub slide_id: String,
    pub participant_id: String,
    pub option_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitQuestionWalPayload {
    pub question_id: String,
    pub participant_id: String,
    pub slide_id: Option<String>,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpvoteQuestionWalPayload {
    pub question_id: String,
    pub participant_id: String,
}

#[derive(Debug, Clone)]
pub struct AppendWalEntry {
    pub op_type: WalOpType,
    pub session_id: String,
    pub client_request_id: String,
    pub resource_id: Option<String>,
    pub payload: Value,
    pub response_payload: Value,
    pub priority: i32,
}

#[derive(Debug, Clone)]
pub enum AppendWalResult {
    Appended,
    Existing { response_payload: Value },
}

#[derive(Debug, Clone)]
pub struct PendingWalEntry {
    pub wal_id: i64,
    pub op_type: WalOpType,
    pub session_id: String,
    pub client_request_id: String,
    pub resource_id: Option<String>,
    pub payload: Value,
    pub response_payload: Value,
    pub priority: i32,
    pub retry_count: i32,
}

#[derive(Clone)]
pub struct WalStore {
    pool: Pool<Sqlite>,
    max_pending_entries: i64,
    db_path: Option<PathBuf>,
}

impl WalStore {
    pub async fn open_default() -> Result<Self> {
        Self::open_file(DEFAULT_WAL_PATH).await
    }

    pub async fn open_file(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AppError::Internal(format!(
                    "Failed to create WAL directory {}: {error}",
                    parent.display()
                ))
            })?;
        }

        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full);

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;

        let store = Self {
            pool,
            max_pending_entries: MAX_PENDING_ENTRIES,
            db_path: Some(path),
        };
        store.initialize().await?;
        Ok(store)
    }

    #[cfg(test)]
    async fn open_test() -> Result<Self> {
        let test_path =
            std::env::temp_dir().join(format!("classcolab-wal-test-{}.sqlite", Uuid::new_v4()));
        Self::open_file(test_path).await
    }

    async fn initialize(&self) -> Result<()> {
        for statement in SQLITE_INIT_STATEMENTS {
            sqlx::query(statement).execute(&self.pool).await?;
        }
        Ok(())
    }

    pub async fn append_or_get_existing(&self, entry: AppendWalEntry) -> Result<AppendWalResult> {
        let pending_count = self.count_pending().await?;
        if pending_count >= self.max_pending_entries {
            return Err(AppError::Input("Write queue is full".to_string()));
        }

        let created_at = Utc::now().to_rfc3339();
        let payload_json = serde_json::to_string(&entry.payload).map_err(|error| {
            AppError::Internal(format!("Failed to encode WAL payload: {error}"))
        })?;
        let response_payload_json =
            serde_json::to_string(&entry.response_payload).map_err(|error| {
                AppError::Internal(format!("Failed to encode WAL response payload: {error}"))
            })?;

        let insert_result = sqlx::query(
            "INSERT INTO wal_entries
                (op_type, session_id, client_request_id, resource_id, payload, response_payload, priority, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(entry.op_type.to_string())
        .bind(&entry.session_id)
        .bind(&entry.client_request_id)
        .bind(entry.resource_id.as_deref())
        .bind(payload_json)
        .bind(response_payload_json)
        .bind(entry.priority)
        .bind(created_at)
        .execute(&self.pool)
        .await;

        match insert_result {
            Ok(_) => Ok(AppendWalResult::Appended),
            Err(sqlx::Error::Database(db_error))
                if db_error.message().contains("UNIQUE constraint failed") =>
            {
                let existing = sqlx::query(
                    "SELECT response_payload
                     FROM wal_entries
                     WHERE session_id = ? AND client_request_id = ? AND op_type = ?
                     LIMIT 1",
                )
                .bind(&entry.session_id)
                .bind(&entry.client_request_id)
                .bind(entry.op_type.to_string())
                .fetch_optional(&self.pool)
                .await?;

                let Some(row) = existing else {
                    return Err(AppError::Internal(
                        "Existing WAL entry missing after duplicate append".to_string(),
                    ));
                };

                let response_payload: String = row.try_get("response_payload")?;
                let response_payload =
                    serde_json::from_str(&response_payload).map_err(|error| {
                        AppError::Internal(format!(
                            "Failed to decode existing WAL response payload: {error}"
                        ))
                    })?;

                Ok(AppendWalResult::Existing { response_payload })
            }
            Err(error) => Err(AppError::Database(error)),
        }
    }

    pub async fn fetch_pending(&self, limit: i64) -> Result<Vec<PendingWalEntry>> {
        let rows = sqlx::query(
            "SELECT wal_id, op_type, session_id, client_request_id, resource_id, payload, response_payload, priority, retry_count
             FROM wal_entries
             WHERE flushed = 0 AND flush_error IS NULL
             ORDER BY priority ASC, created_at ASC, wal_id ASC
             LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| {
                let op_type: String = row.try_get("op_type")?;
                let payload: String = row.try_get("payload")?;
                let response_payload: String = row.try_get("response_payload")?;

                Ok(PendingWalEntry {
                    wal_id: row.try_get("wal_id")?,
                    op_type: op_type.parse()?,
                    session_id: row.try_get("session_id")?,
                    client_request_id: row.try_get("client_request_id")?,
                    resource_id: row.try_get("resource_id")?,
                    payload: serde_json::from_str(&payload).map_err(|error| {
                        AppError::Internal(format!("Failed to decode WAL payload: {error}"))
                    })?,
                    response_payload: serde_json::from_str(&response_payload).map_err(|error| {
                        AppError::Internal(format!(
                            "Failed to decode WAL response payload: {error}"
                        ))
                    })?,
                    priority: row.try_get("priority")?,
                    retry_count: row.try_get("retry_count")?,
                })
            })
            .collect()
    }

    pub async fn count_pending(&self) -> Result<i64> {
        let count = sqlx::query_scalar(
            "SELECT COUNT(*) FROM wal_entries WHERE flushed = 0 AND flush_error IS NULL",
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(count)
    }

    pub async fn fetch_latest_pending_response<T: DeserializeOwned>(
        &self,
        session_id: &str,
        resource_id: &str,
        op_type: WalOpType,
    ) -> Result<Option<T>> {
        let row = sqlx::query(
            "SELECT response_payload
             FROM wal_entries
             WHERE flushed = 0
               AND flush_error IS NULL
               AND session_id = ?
               AND resource_id = ?
               AND op_type = ?
             ORDER BY wal_id DESC
             LIMIT 1",
        )
        .bind(session_id)
        .bind(resource_id)
        .bind(op_type.to_string())
        .fetch_optional(&self.pool)
        .await?;

        let Some(row) = row else {
            return Ok(None);
        };

        let response_payload: String = row.try_get("response_payload")?;
        serde_json::from_str(&response_payload)
            .map(Some)
            .map_err(|error| {
                AppError::Internal(format!(
                    "Failed to decode latest pending WAL response payload: {error}"
                ))
            })
    }

    pub async fn has_pending_create_slide_resource(
        &self,
        session_id: &str,
        slide_id: &str,
    ) -> Result<bool> {
        let exists: i64 = sqlx::query_scalar(
            "SELECT EXISTS(
                 SELECT 1
                 FROM wal_entries
                 WHERE flushed = 0
                   AND flush_error IS NULL
                   AND session_id = ?
                   AND resource_id = ?
                   AND op_type = ?
             )",
        )
        .bind(session_id)
        .bind(slide_id)
        .bind(WalOpType::CreateSlide.to_string())
        .fetch_one(&self.pool)
        .await?;

        Ok(exists == 1)
    }

    pub async fn mark_flushed(&self, wal_id: i64) -> Result<()> {
        sqlx::query(
            "UPDATE wal_entries
             SET flushed = 1, flush_error = NULL
             WHERE wal_id = ?",
        )
        .bind(wal_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn mark_retry(&self, wal_id: i64) -> Result<()> {
        sqlx::query(
            "UPDATE wal_entries
             SET retry_count = retry_count + 1
             WHERE wal_id = ?",
        )
        .bind(wal_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn mark_failed(&self, wal_id: i64, error: &str) -> Result<()> {
        sqlx::query(
            "UPDATE wal_entries
             SET retry_count = retry_count + 1, flush_error = ?
             WHERE wal_id = ?",
        )
        .bind(error)
        .bind(wal_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn cleanup(&self) -> Result<u64> {
        let deleted = sqlx::query(
            "DELETE FROM wal_entries
             WHERE flushed = 1
               AND created_at < datetime('now', ?)",
        )
        .bind(format!("-{CLEANUP_AGE_HOURS} hours"))
        .execute(&self.pool)
        .await?
        .rows_affected();

        if deleted > 0 {
            sqlx::query("PRAGMA incremental_vacuum")
                .execute(&self.pool)
                .await?;
        }

        Ok(deleted)
    }

    pub async fn delete_entries_for_session(&self, session_id: &str) -> Result<u64> {
        let deleted = sqlx::query("DELETE FROM wal_entries WHERE session_id = ?")
            .bind(session_id)
            .execute(&self.pool)
            .await?
            .rows_affected();

        Ok(deleted)
    }

    pub fn db_path(&self) -> Option<&Path> {
        self.db_path.as_deref()
    }
}

pub async fn fetch_replay_response<T: DeserializeOwned>(
    pool: &crate::db::DbPool,
    session_id: &str,
    op_type: WalOpType,
    client_request_id: &str,
) -> Result<Option<T>> {
    let response_payload: Option<sqlx::types::Json<Value>> = sqlx::query_scalar(
        "SELECT response_payload
         FROM wal_request_replays
         WHERE session_id = ? AND op_type = ? AND client_request_id = ?
         LIMIT 1",
    )
    .bind(session_id)
    .bind(op_type.to_string())
    .bind(client_request_id)
    .fetch_optional(pool)
    .await?;

    response_payload
        .map(|json| {
            serde_json::from_value(json.0).map_err(|error| {
                AppError::Internal(format!("Failed to decode replay response payload: {error}"))
            })
        })
        .transpose()
}

async fn replay_exists(
    tx: &mut Transaction<'_, MySql>,
    session_id: &str,
    op_type: WalOpType,
    client_request_id: &str,
) -> Result<bool> {
    let exists: i64 = sqlx::query_scalar(
        "SELECT EXISTS(
             SELECT 1
             FROM wal_request_replays
             WHERE session_id = ? AND op_type = ? AND client_request_id = ?
         )",
    )
    .bind(session_id)
    .bind(op_type.to_string())
    .bind(client_request_id)
    .fetch_one(&mut **tx)
    .await?;

    Ok(exists == 1)
}

async fn store_replay_response(
    tx: &mut Transaction<'_, MySql>,
    entry: &PendingWalEntry,
) -> Result<()> {
    sqlx::query(
        "INSERT IGNORE INTO wal_request_replays (session_id, op_type, client_request_id, response_payload)
         VALUES (?, ?, ?, ?)",
    )
    .bind(&entry.session_id)
    .bind(entry.op_type.to_string())
    .bind(&entry.client_request_id)
    .bind(sqlx::types::Json(&entry.response_payload))
    .execute(&mut **tx)
    .await?;

    Ok(())
}

pub async fn run_wal_worker(
    wal_store: WalStore,
    mysql_pool: crate::db::DbPool,
    session_service: Arc<SessionService>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    tracing::info!("WAL worker started");
    let mut flush_interval = tokio::time::interval(Duration::from_millis(FLUSH_INTERVAL_MS));
    let mut cleanup_interval = tokio::time::interval(Duration::from_secs(60));
    flush_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    cleanup_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = flush_interval.tick() => {
                if let Err(error) = flush_pending_batch(&wal_store, &mysql_pool, &session_service).await {
                    tracing::error!("WAL flush tick failed: {}", error);
                }
            }
            _ = cleanup_interval.tick() => {
                if let Err(error) = wal_store.cleanup().await {
                    tracing::warn!("WAL cleanup failed: {}", error);
                }
            }
            changed = shutdown_rx.changed() => {
                if changed.is_ok() && *shutdown_rx.borrow() {
                    tracing::info!("WAL worker received shutdown signal; draining queue");
                    if let Err(error) = flush_all_pending(&wal_store, &mysql_pool, &session_service, Duration::from_secs(10)).await {
                        tracing::error!("WAL shutdown drain failed: {}", error);
                    }
                    break;
                }
            }
        }
    }
}

pub async fn flush_all_pending(
    wal_store: &WalStore,
    mysql_pool: &crate::db::DbPool,
    session_service: &Arc<SessionService>,
    timeout: Duration,
) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        if wal_store.count_pending().await? == 0 {
            return Ok(());
        }

        if Instant::now() >= deadline {
            tracing::warn!("Timed out draining pending WAL entries before shutdown");
            return Ok(());
        }

        let flushed = flush_pending_batch(wal_store, mysql_pool, session_service).await?;
        if flushed == 0 {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

pub async fn flush_pending_batch(
    wal_store: &WalStore,
    mysql_pool: &crate::db::DbPool,
    session_service: &Arc<SessionService>,
) -> Result<usize> {
    let entries = wal_store.fetch_pending(FLUSH_BATCH_SIZE).await?;
    if entries.is_empty() {
        return Ok(0);
    }

    let grouped = group_entries_by_session(entries);
    let mut processed = 0usize;

    for (session_id, session_entries) in grouped {
        match flush_session_group(wal_store, mysql_pool, &session_id, &session_entries).await {
            Ok(flushed_count) => {
                if flushed_count > 0 {
                    session_service.invalidate_session_cache(&session_id).await;
                    processed += flushed_count;
                }
            }
            Err(AppError::NotFound(message)) => {
                tracing::warn!(
                    session_id = %session_id,
                    pending_entries = session_entries.len(),
                    "Dropping WAL session group for deleted session: {}",
                    message
                );
                for entry in &session_entries {
                    wal_store.mark_failed(entry.wal_id, &message).await?;
                }
            }
            Err(error) => {
                tracing::error!(session_id = %session_id, "Failed to flush WAL session group: {}", error);
            }
        }
    }

    Ok(processed)
}

fn group_entries_by_session(
    entries: Vec<PendingWalEntry>,
) -> BTreeMap<String, Vec<PendingWalEntry>> {
    let mut grouped = BTreeMap::new();
    for entry in entries {
        grouped
            .entry(entry.session_id.clone())
            .or_insert_with(Vec::new)
            .push(entry);
    }
    grouped
}

async fn flush_session_group(
    wal_store: &WalStore,
    mysql_pool: &crate::db::DbPool,
    session_id: &str,
    entries: &[PendingWalEntry],
) -> Result<usize> {
    let mut tx = mysql_pool.begin().await?;
    lock_session(&mut tx, session_id).await?;

    for entry in entries {
        if replay_exists(
            &mut tx,
            &entry.session_id,
            entry.op_type,
            &entry.client_request_id,
        )
        .await?
        {
            continue;
        }

        match replay_entry(&mut tx, entry).await {
            Ok(()) => {}
            Err(ReplayDisposition::ProcessedNoMutation) => {}
            Err(ReplayDisposition::Retryable(message)) => {
                tx.rollback().await?;
                if entry.retry_count + 1 >= MAX_RETRY_COUNT {
                    wal_store.mark_failed(entry.wal_id, &message).await?;
                } else {
                    wal_store.mark_retry(entry.wal_id).await?;
                }
                return Ok(0);
            }
            Err(ReplayDisposition::PermanentFailure(message)) => {
                tx.rollback().await?;
                wal_store.mark_failed(entry.wal_id, &message).await?;
                return Ok(0);
            }
        }

        store_replay_response(&mut tx, entry).await?;
    }

    tx.commit().await?;

    let mut flushed = 0usize;
    for entry in entries {
        wal_store.mark_flushed(entry.wal_id).await?;
        flushed += 1;
    }

    Ok(flushed)
}

enum ReplayDisposition {
    Retryable(String),
    PermanentFailure(String),
    ProcessedNoMutation,
}

async fn lock_session(tx: &mut Transaction<'_, MySql>, session_id: &str) -> Result<()> {
    let session_id_row: Option<String> =
        sqlx::query_scalar("SELECT id FROM sessions WHERE id = ? FOR UPDATE")
            .bind(session_id)
            .fetch_optional(&mut **tx)
            .await?;

    if session_id_row.is_some() {
        Ok(())
    } else {
        Err(AppError::NotFound("Session not found".to_string()))
    }
}

async fn replay_entry(
    tx: &mut Transaction<'_, MySql>,
    entry: &PendingWalEntry,
) -> std::result::Result<(), ReplayDisposition> {
    match entry.op_type {
        WalOpType::CreateSlide => replay_create_slide(tx, entry).await,
        WalOpType::CreateSlidesBatch => replay_create_slides_batch(tx, entry).await,
        WalOpType::UpdateSlide => replay_update_slide(tx, entry).await,
        WalOpType::DeleteSlide => replay_delete_slide(tx, entry).await,
        WalOpType::ReorderSlides => replay_reorder_slides(tx, entry).await,
        WalOpType::SubmitVote => replay_submit_vote(tx, entry).await,
        WalOpType::SubmitQuestion => replay_submit_question(tx, entry).await,
        WalOpType::UpvoteQuestion => replay_upvote_question(tx, entry).await,
    }
}

fn decode_payload<T: DeserializeOwned>(
    entry: &PendingWalEntry,
) -> std::result::Result<T, ReplayDisposition> {
    serde_json::from_value(entry.payload.clone()).map_err(|error| {
        ReplayDisposition::PermanentFailure(format!("Failed to decode WAL payload: {error}"))
    })
}

async fn replay_create_slide(
    tx: &mut Transaction<'_, MySql>,
    entry: &PendingWalEntry,
) -> std::result::Result<(), ReplayDisposition> {
    let payload: CreateSlideWalPayload = decode_payload(entry)?;
    let order_index = match payload.insert_after_slide_id.as_deref() {
        Some(insert_after_slide_id) => {
            slide::allocate_order_after(tx, &entry.session_id, insert_after_slide_id)
                .await
                .map_err(classify_app_error)?
        }
        None => slide::get_append_order_index(tx, &entry.session_id)
            .await
            .map_err(classify_app_error)?,
    };

    sqlx::query(
        "INSERT INTO slides (id, session_id, type, content, order_index, client_request_id)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&payload.slide_id)
    .bind(&entry.session_id)
    .bind(&payload.slide_type)
    .bind(sqlx::types::Json(&payload.content))
    .bind(order_index)
    .bind(&entry.client_request_id)
    .execute(&mut **tx)
    .await
    .map_err(classify_sqlx_error)?;

    let slide = load_slide(tx, &payload.slide_id, &entry.session_id)
        .await
        .map_err(classify_app_error)?;
    slide::enqueue_slides_update_event(tx, &entry.session_id, &[slide])
        .await
        .map_err(classify_app_error)?;
    Ok(())
}

async fn replay_create_slides_batch(
    tx: &mut Transaction<'_, MySql>,
    entry: &PendingWalEntry,
) -> std::result::Result<(), ReplayDisposition> {
    let payload: CreateSlidesBatchWalPayload = decode_payload(entry)?;
    let mut slides = Vec::with_capacity(payload.slides.len());

    for item in payload.slides {
        let order_index = slide::get_append_order_index(tx, &entry.session_id)
            .await
            .map_err(classify_app_error)?;

        sqlx::query(
            "INSERT INTO slides (id, session_id, type, content, order_index, client_request_id)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&item.slide_id)
        .bind(&entry.session_id)
        .bind(&item.slide_type)
        .bind(sqlx::types::Json(&item.content))
        .bind(order_index)
        .bind(&entry.client_request_id)
        .execute(&mut **tx)
        .await
        .map_err(classify_sqlx_error)?;

        slides.push(
            load_slide(tx, &item.slide_id, &entry.session_id)
                .await
                .map_err(classify_app_error)?,
        );
    }

    sqlx::query("UPDATE sessions SET state_version = state_version + 1 WHERE id = ?")
        .bind(&entry.session_id)
        .execute(&mut **tx)
        .await
        .map_err(classify_sqlx_error)?;

    slide::enqueue_slides_update_event(tx, &entry.session_id, &slides)
        .await
        .map_err(classify_app_error)?;
    Ok(())
}

async fn replay_update_slide(
    tx: &mut Transaction<'_, MySql>,
    entry: &PendingWalEntry,
) -> std::result::Result<(), ReplayDisposition> {
    let payload: UpdateSlideWalPayload = decode_payload(entry)?;
    let existing_slide = load_slide(tx, &payload.slide_id, &entry.session_id)
        .await
        .map_err(classify_app_error)?;

    if let Some(base_version) = payload.base_version {
        if base_version != existing_slide.version {
            return Err(ReplayDisposition::ProcessedNoMutation);
        }
    }

    let update_request = UpdateSlideRequest {
        slide_type: payload.slide_type.clone(),
        content: payload.content.clone(),
        base_version: payload.base_version,
    };

    let mut updated_slide = existing_slide.clone();
    let mut has_changes = false;

    if let Some(slide_type) = update_request.slide_type {
        if updated_slide.slide_type != slide_type {
            updated_slide.slide_type = slide_type;
            has_changes = true;
        }
    }

    if let Some(content) = update_request.content {
        let content_json = sqlx::types::Json(content);
        if updated_slide.content != content_json {
            updated_slide.content = content_json;
            has_changes = true;
        }
    }

    if !has_changes {
        return Ok(());
    }

    let expected_version = payload.base_version.unwrap_or(existing_slide.version);
    let result: MySqlQueryResult = sqlx::query(
        "UPDATE slides
         SET type = ?, content = ?, version = version + 1
         WHERE id = ? AND session_id = ? AND version = ?",
    )
    .bind(&updated_slide.slide_type)
    .bind(&updated_slide.content)
    .bind(&payload.slide_id)
    .bind(&entry.session_id)
    .bind(expected_version)
    .execute(&mut **tx)
    .await
    .map_err(classify_sqlx_error)?;

    if result.rows_affected() == 0 {
        return Err(ReplayDisposition::ProcessedNoMutation);
    }

    let slide = load_slide(tx, &payload.slide_id, &entry.session_id)
        .await
        .map_err(classify_app_error)?;
    slide::enqueue_slides_update_event(tx, &entry.session_id, &[slide])
        .await
        .map_err(classify_app_error)?;
    Ok(())
}

async fn replay_delete_slide(
    tx: &mut Transaction<'_, MySql>,
    entry: &PendingWalEntry,
) -> std::result::Result<(), ReplayDisposition> {
    let payload: DeleteSlideWalPayload = decode_payload(entry)?;
    let deleted = sqlx::query("DELETE FROM slides WHERE id = ? AND session_id = ?")
        .bind(&payload.slide_id)
        .bind(&entry.session_id)
        .execute(&mut **tx)
        .await
        .map_err(classify_sqlx_error)?;

    if deleted.rows_affected() == 0 {
        return Err(ReplayDisposition::ProcessedNoMutation);
    }

    sqlx::query(
        "INSERT IGNORE INTO slide_delete_requests (session_id, client_request_id, slide_id)
         VALUES (?, ?, ?)",
    )
    .bind(&entry.session_id)
    .bind(&entry.client_request_id)
    .bind(&payload.slide_id)
    .execute(&mut **tx)
    .await
    .map_err(classify_sqlx_error)?;

    slide::enqueue_slides_update_event(tx, &entry.session_id, &[])
        .await
        .map_err(classify_app_error)?;

    Ok(())
}

async fn replay_reorder_slides(
    tx: &mut Transaction<'_, MySql>,
    entry: &PendingWalEntry,
) -> std::result::Result<(), ReplayDisposition> {
    let payload: ReorderSlidesWalPayload = decode_payload(entry)?;
    if payload.slide_ids.is_empty() {
        return Err(ReplayDisposition::PermanentFailure(
            "No slides to reorder".to_string(),
        ));
    }

    let session_slide_ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM slides WHERE session_id = ? ORDER BY order_index ASC, id ASC",
    )
    .bind(&entry.session_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(classify_sqlx_error)?;

    slide::validate_reorder_payload(&session_slide_ids, &payload.slide_ids)
        .map_err(classify_app_error)?;

    if session_slide_ids == payload.slide_ids {
        return Ok(());
    }

    let changed_slide_ids =
        slide::collect_changed_slide_ids(&session_slide_ids, &payload.slide_ids);
    let temporary_assignments = slide::build_temporary_order_assignments(&changed_slide_ids);
    let final_assignments =
        slide::build_final_order_assignments(&session_slide_ids, &payload.slide_ids);

    slide::apply_order_assignments(tx, &entry.session_id, &temporary_assignments)
        .await
        .map_err(classify_app_error)?;
    slide::apply_order_assignments(tx, &entry.session_id, &final_assignments)
        .await
        .map_err(classify_app_error)?;

    sqlx::query("UPDATE sessions SET state_version = state_version + 1 WHERE id = ?")
        .bind(&entry.session_id)
        .execute(&mut **tx)
        .await
        .map_err(classify_sqlx_error)?;

    slide::enqueue_slides_update_event(tx, &entry.session_id, &[])
        .await
        .map_err(classify_app_error)?;

    Ok(())
}

async fn replay_submit_vote(
    tx: &mut Transaction<'_, MySql>,
    entry: &PendingWalEntry,
) -> std::result::Result<(), ReplayDisposition> {
    let payload: SubmitVoteWalPayload = decode_payload(entry)?;
    let slide_meta = sqlx::query_as::<_, (String, String, Value)>(
        "SELECT session_id, type, content FROM slides WHERE id = ?",
    )
    .bind(&payload.slide_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(classify_sqlx_error)?;

    let Some((slide_session_id, slide_type, slide_content)) = slide_meta else {
        return Err(ReplayDisposition::PermanentFailure(
            "Vote slide not found".to_string(),
        ));
    };
    if slide_session_id != entry.session_id {
        return Err(ReplayDisposition::PermanentFailure(
            "Vote slide does not belong to session".to_string(),
        ));
    }

    let (option_ids, limit_submissions) = match student::validate_vote_options(
        payload.option_ids.clone(),
        &slide_type,
        &slide_content,
    ) {
        student::VoteValidationResult::Valid {
            option_ids,
            limit_submissions,
            ..
        } => (option_ids, limit_submissions),
        student::VoteValidationResult::Invalid(message) => {
            return Err(ReplayDisposition::PermanentFailure(message))
        }
    };

    let mutated = student::commit_vote_submission(
        tx,
        &entry.session_id,
        &payload.slide_id,
        &payload.participant_id,
        &option_ids,
        limit_submissions,
    )
    .await
    .map_err(classify_app_error)?;

    if mutated {
        Ok(())
    } else {
        Err(ReplayDisposition::ProcessedNoMutation)
    }
}

async fn replay_submit_question(
    tx: &mut Transaction<'_, MySql>,
    entry: &PendingWalEntry,
) -> std::result::Result<(), ReplayDisposition> {
    let payload: SubmitQuestionWalPayload = decode_payload(entry)?;
    sqlx::query(
        "INSERT INTO questions (id, session_id, slide_id, participant_id, content, client_request_id)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&payload.question_id)
    .bind(&entry.session_id)
    .bind(payload.slide_id.as_deref())
    .bind(&payload.participant_id)
    .bind(&payload.content)
    .bind(&entry.client_request_id)
    .execute(&mut **tx)
    .await
    .map_err(classify_sqlx_error)?;

    let (sequence, questions) = student::next_qa_sequence_and_questions(tx, &entry.session_id)
        .await
        .map_err(classify_app_error)?;
    let qa_payload = serde_json::json!({
        "payload": {
            "questions": questions
        },
        "sequence": sequence
    });
    crate::services::outbox::enqueue_event(
        tx,
        &entry.session_id,
        OutboxEventType::QaUpdate,
        &qa_payload,
    )
    .await
    .map_err(classify_sqlx_error)?;
    Ok(())
}

async fn replay_upvote_question(
    tx: &mut Transaction<'_, MySql>,
    entry: &PendingWalEntry,
) -> std::result::Result<(), ReplayDisposition> {
    let payload: UpvoteQuestionWalPayload = decode_payload(entry)?;
    let insert_result =
        sqlx::query("INSERT INTO question_upvotes (question_id, participant_id) VALUES (?, ?)")
            .bind(&payload.question_id)
            .bind(&payload.participant_id)
            .execute(&mut **tx)
            .await;

    let already_upvoted = match insert_result {
        Ok(_) => false,
        Err(error) if is_duplicate_key(&error) => true,
        Err(error) => return Err(classify_sqlx_error(error)),
    };

    if already_upvoted {
        return Err(ReplayDisposition::ProcessedNoMutation);
    }

    sqlx::query("UPDATE questions SET upvotes = upvotes + 1 WHERE id = ?")
        .bind(&payload.question_id)
        .execute(&mut **tx)
        .await
        .map_err(classify_sqlx_error)?;

    let (sequence, questions) = student::next_qa_sequence_and_questions(tx, &entry.session_id)
        .await
        .map_err(classify_app_error)?;
    let qa_payload = serde_json::json!({
        "payload": {
            "questions": questions
        },
        "sequence": sequence
    });
    crate::services::outbox::enqueue_event(
        tx,
        &entry.session_id,
        OutboxEventType::QaUpdate,
        &qa_payload,
    )
    .await
    .map_err(classify_sqlx_error)?;
    Ok(())
}

async fn load_slide(
    tx: &mut Transaction<'_, MySql>,
    slide_id: &str,
    session_id: &str,
) -> Result<Slide> {
    let slide = sqlx::query_as::<_, Slide>(
        "SELECT id, session_id, type, content, order_index, is_hidden, version
         FROM slides
         WHERE id = ? AND session_id = ?",
    )
    .bind(slide_id)
    .bind(session_id)
    .fetch_optional(&mut **tx)
    .await?;

    slide.ok_or_else(|| AppError::NotFound("Slide not found".to_string()))
}

fn classify_app_error(error: AppError) -> ReplayDisposition {
    match error {
        AppError::Auth(message) | AppError::NotFound(message) | AppError::Input(message) => {
            ReplayDisposition::PermanentFailure(message)
        }
        AppError::Conflict { .. } => ReplayDisposition::ProcessedNoMutation,
        AppError::Database(db_error) => classify_sqlx_error(db_error),
        AppError::Internal(message) => ReplayDisposition::Retryable(message),
        AppError::Hash(error) => ReplayDisposition::PermanentFailure(error.to_string()),
        AppError::Jwt(error) => ReplayDisposition::PermanentFailure(error.to_string()),
        AppError::Migration(error) => ReplayDisposition::Retryable(error.to_string()),
        AppError::ServiceUnavailable(message) => ReplayDisposition::Retryable(message),
    }
}

fn classify_sqlx_error(error: sqlx::Error) -> ReplayDisposition {
    if is_duplicate_key(&error) {
        ReplayDisposition::ProcessedNoMutation
    } else if is_transient_sqlx_error(&error) {
        ReplayDisposition::Retryable(error.to_string())
    } else {
        ReplayDisposition::PermanentFailure(error.to_string())
    }
}

fn is_duplicate_key(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::Database(db_error) => {
            db_error.message().contains("Duplicate entry")
                || db_error.code().as_deref() == Some("23000")
                || db_error.code().as_deref() == Some("1062")
        }
        _ => false,
    }
}

fn is_transient_sqlx_error(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::Database(db_error) => {
            db_error.code().as_deref() == Some("40001")
                || db_error.code().as_deref() == Some("1205")
                || db_error.message().contains("Deadlock found")
                || db_error.message().contains("Lock wait timeout exceeded")
        }
        _ => false,
    }
}

pub fn queued_success_response<T>(
    data: &T,
) -> Result<(axum::http::StatusCode, axum::Json<ApiResponse<T>>)>
where
    T: Clone + Serialize,
{
    Ok((
        axum::http::StatusCode::ACCEPTED,
        axum::Json(ApiResponse::success(data.clone())),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn wal_append_returns_existing_payload_for_duplicate_request() {
        let store = WalStore::open_test().await.expect("wal store");
        let entry = AppendWalEntry {
            op_type: WalOpType::CreateSlide,
            session_id: "session-1".to_string(),
            client_request_id: "req-1".to_string(),
            resource_id: Some("slide-1".to_string()),
            payload: serde_json::json!({"slideId": "slide-1"}),
            response_payload: serde_json::json!({"id": "slide-1"}),
            priority: 3,
        };

        let first = store
            .append_or_get_existing(entry.clone())
            .await
            .expect("first append");
        assert!(matches!(first, AppendWalResult::Appended));

        let duplicate = store
            .append_or_get_existing(entry)
            .await
            .expect("duplicate append");
        match duplicate {
            AppendWalResult::Existing { response_payload } => {
                assert_eq!(response_payload["id"], "slide-1");
            }
            other => panic!("expected existing response payload, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn pending_create_slide_resource_is_visible_before_flush() {
        let store = WalStore::open_test().await.expect("wal store");
        store
            .append_or_get_existing(AppendWalEntry {
                op_type: WalOpType::CreateSlide,
                session_id: "session-1".to_string(),
                client_request_id: "req-pending".to_string(),
                resource_id: Some("slide-pending".to_string()),
                payload: serde_json::json!({"slideId": "slide-pending"}),
                response_payload: serde_json::json!({"id": "slide-pending"}),
                priority: 3,
            })
            .await
            .expect("append");

        let is_pending = store
            .has_pending_create_slide_resource("session-1", "slide-pending")
            .await
            .expect("pending resource lookup");

        assert!(is_pending);
    }

    #[tokio::test]
    async fn fetch_pending_orders_by_priority_then_creation() {
        let store = WalStore::open_test().await.expect("wal store");

        for (request_id, priority) in [("req-1", 3), ("req-2", 1), ("req-3", 2)] {
            store
                .append_or_get_existing(AppendWalEntry {
                    op_type: WalOpType::CreateSlide,
                    session_id: "session-1".to_string(),
                    client_request_id: request_id.to_string(),
                    resource_id: None,
                    payload: serde_json::json!({}),
                    response_payload: serde_json::json!({}),
                    priority,
                })
                .await
                .expect("append");
        }

        let pending = store.fetch_pending(10).await.expect("pending");
        let ordered_ids: Vec<_> = pending
            .into_iter()
            .map(|entry| entry.client_request_id)
            .collect();
        assert_eq!(ordered_ids, vec!["req-2", "req-3", "req-1"]);
    }

    #[tokio::test]
    async fn fetch_latest_pending_response_returns_newest_match() {
        let store = WalStore::open_test().await.expect("wal store");

        for version in [1_i64, 2_i64] {
            store
                .append_or_get_existing(AppendWalEntry {
                    op_type: WalOpType::UpdateSlide,
                    session_id: "session-1".to_string(),
                    client_request_id: format!("req-{version}"),
                    resource_id: Some("slide-1".to_string()),
                    payload: serde_json::json!({ "baseVersion": version - 1 }),
                    response_payload: serde_json::json!({
                        "id": "slide-1",
                        "sessionId": "session-1",
                        "type": "static",
                        "content": { "title": format!("v{version}") },
                        "orderIndex": 0,
                        "isHidden": false,
                        "version": version
                    }),
                    priority: 1,
                })
                .await
                .expect("append");
        }

        let latest = store
            .fetch_latest_pending_response::<serde_json::Value>(
                "session-1",
                "slide-1",
                WalOpType::UpdateSlide,
            )
            .await
            .expect("latest pending response")
            .expect("pending response should exist");

        assert_eq!(latest["version"], 2);
        assert_eq!(latest["content"]["title"], "v2");
    }
}
