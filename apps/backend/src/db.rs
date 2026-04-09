use crate::error::{AppError, Result};
use sqlx::migrate::Migrator;
use sqlx::mysql::MySqlPoolOptions;
use sqlx::{MySql, Pool};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Notify, RwLock};

pub type DbPool = Pool<MySql>;

static MIGRATOR: Migrator = sqlx::migrate!("./migrations");
const REPAIRABLE_MIGRATION_VERSIONS: &[i64] = &[
    20241201170000,
    20260120120000,
    20260310100000,
    20260403140000,
    20260405103000,
    20260410000000,
];

#[derive(Debug, Clone, Copy)]
pub struct DbPoolSettings {
    pub max_connections: u32,
    pub min_connections: u32,
    pub acquire_timeout_seconds: u64,
    pub idle_timeout_seconds: u64,
    pub max_lifetime_seconds: u64,
}

/// Lazy database pool that initializes in the background
#[derive(Clone)]
pub struct LazyDbPool {
    pool: Arc<RwLock<Option<DbPool>>>,
    ready: Arc<AtomicBool>,
    error: Arc<RwLock<Option<String>>>,
    notify: Arc<Notify>,
}

impl LazyDbPool {
    pub fn new() -> Self {
        Self {
            pool: Arc::new(RwLock::new(None)),
            ready: Arc::new(AtomicBool::new(false)),
            error: Arc::new(RwLock::new(None)),
            notify: Arc::new(Notify::new()),
        }
    }

    /// Check if the pool is ready (non-blocking)
    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    /// Get initialization error if any
    pub async fn get_error(&self) -> Option<String> {
        self.error.read().await.clone()
    }

    /// Get the pool, returns None if not ready
    pub async fn get(&self) -> Option<DbPool> {
        self.pool.read().await.clone()
    }

    /// Get the pool, waits until ready or returns error
    pub async fn get_or_wait(&self) -> Result<DbPool> {
        // Fast path: already ready
        if let Some(pool) = self.pool.read().await.clone() {
            return Ok(pool);
        }

        let timeout = std::time::Duration::from_secs(30);

        let wait_for_ready = async {
            loop {
                if let Some(err) = self.error.read().await.clone() {
                    return Err(AppError::Internal(err));
                }
                if let Some(pool) = self.pool.read().await.clone() {
                    return Ok(pool);
                }
                self.notify.notified().await;
            }
        };

        tokio::time::timeout(timeout, wait_for_ready)
            .await
            .map_err(|_| AppError::Internal("Database connection timeout".to_string()))?
    }

    /// Initialize the pool in the background
    pub fn start_background_init(
        self,
        database_url: String,
        run_migrations: bool,
        settings: DbPoolSettings,
    ) {
        tokio::spawn(async move {
            tracing::info!("Starting background database initialization...");

            let mut attempt: u32 = 0;
            loop {
                attempt += 1;

                match Self::init_pool(&database_url, run_migrations, settings).await {
                    Ok(pool) => {
                        *self.pool.write().await = Some(pool);
                        *self.error.write().await = None;
                        self.ready.store(true, Ordering::SeqCst);
                        self.notify.notify_waiters();
                        tracing::info!("Database ready after {} attempt(s)", attempt);
                        break;
                    }
                    Err(e) => {
                        self.ready.store(false, Ordering::SeqCst);
                        let delay = Self::retry_delay(attempt);
                        let err_msg = format!(
                            "Database init failed (attempt {}): {}. Retrying in {}s",
                            attempt,
                            e,
                            delay.as_secs()
                        );
                        tracing::error!("{}", err_msg);
                        *self.error.write().await = Some(err_msg);
                        self.notify.notify_waiters();
                        tokio::time::sleep(delay).await;
                    }
                }
            }
        });
    }

    async fn init_pool(
        database_url: &str,
        run_migrations: bool,
        settings: DbPoolSettings,
    ) -> anyhow::Result<DbPool> {
        let mut options = MySqlPoolOptions::new();

        options = options
            .max_connections(settings.max_connections)
            .min_connections(settings.min_connections) // Start with 0 for faster init
            .acquire_timeout(Duration::from_secs(settings.acquire_timeout_seconds))
            .idle_timeout(Duration::from_secs(settings.idle_timeout_seconds));

        if settings.max_lifetime_seconds > 0 {
            options = options.max_lifetime(Duration::from_secs(settings.max_lifetime_seconds));
        }

        let pool = options.connect(database_url).await?;

        if run_migrations {
            Self::repair_known_migration_checksums(&pool).await?;
            tracing::info!("Running database migrations...");
            MIGRATOR.run(&pool).await?;
            tracing::info!("Migrations completed");
        }

        // Warm up one connection
        sqlx::query("SELECT 1").execute(&pool).await?;

        Ok(pool)
    }

    /// Helper to get pool for handlers - returns Result for easy ? usage
    pub async fn pool(&self) -> Result<DbPool> {
        self.get_or_wait().await
    }

    /// Returns the pool immediately if ready, or a 503 error if not.
    /// Use this in request handlers to fail fast during initialization
    /// instead of queuing requests behind a 30-second wait.
    pub async fn pool_fast_fail(&self) -> Result<DbPool> {
        if !self.is_ready() {
            return Err(crate::error::AppError::ServiceUnavailable(
                "Database is initializing, please retry".to_string(),
            ));
        }

        // Fast path: pool is ready
        if let Some(pool) = self.pool.read().await.clone() {
            return Ok(pool);
        }

        // Race: is_ready() was true but pool not yet set (narrow window during init).
        // Fall back to waiting with the existing timeout.
        self.get_or_wait().await
    }

    async fn repair_known_migration_checksums(pool: &DbPool) -> anyhow::Result<()> {
        let migrations_table_exists: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '_sqlx_migrations')",
        )
        .fetch_one(pool)
        .await?;

        if migrations_table_exists == 0 {
            return Ok(());
        }

        for version in REPAIRABLE_MIGRATION_VERSIONS {
            let Some(migration) = MIGRATOR
                .iter()
                .find(|migration| migration.version == *version)
            else {
                continue;
            };

            // Clean up partially-applied migrations (success = 0) so they can retry
            let success_row: Option<bool> =
                sqlx::query_scalar("SELECT success FROM _sqlx_migrations WHERE version = ?")
                    .bind(version)
                    .fetch_optional(pool)
                    .await?;

            if let Some(success) = success_row {
                if !success {
                    tracing::warn!(
                        version = *version,
                        "Removing partially-applied migration to allow retry"
                    );
                    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = ?")
                        .bind(version)
                        .execute(pool)
                        .await?;
                    continue;
                }
            }

            let applied_checksum: Option<Vec<u8>> =
                sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = ?")
                    .bind(version)
                    .fetch_optional(pool)
                    .await?;

            if let Some(applied_checksum) = applied_checksum {
                if applied_checksum.as_slice() != migration.checksum.as_ref() {
                    tracing::warn!(
                        version = *version,
                        "Repairing SQLx migration checksum mismatch before startup"
                    );
                    sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
                        .bind(migration.checksum.as_ref())
                        .bind(version)
                        .execute(pool)
                        .await?;
                }
            }
        }

        Ok(())
    }

    fn retry_delay(attempt: u32) -> Duration {
        let exp = attempt.saturating_sub(1).min(5);
        Duration::from_secs(1_u64 << exp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pool_fast_fail_returns_error_when_not_ready() {
        let pool = LazyDbPool::new();
        // A fresh pool is not ready — is_ready() returns false.

        let result = pool.pool_fast_fail().await;
        assert!(result.is_err());

        let err = result.unwrap_err();
        // The error should be ServiceUnavailable, not Database.
        assert!(
            err.to_string().contains("Database is initializing"),
            "Expected ServiceUnavailable error, got: {}",
            err
        );
    }

    /// Verifies exponential backoff: attempt 1 = 1s, attempt 2 = 2s,
    /// attempt 3 = 4s, attempt 4 = 8s, attempt 5 = 16s, attempt 6+ = 32s (capped).
    #[test]
    fn retry_delay_grows_exponentially_and_caps_at_32s() {
        assert_eq!(LazyDbPool::retry_delay(1), Duration::from_secs(1));
        assert_eq!(LazyDbPool::retry_delay(2), Duration::from_secs(2));
        assert_eq!(LazyDbPool::retry_delay(3), Duration::from_secs(4));
        assert_eq!(LazyDbPool::retry_delay(4), Duration::from_secs(8));
        assert_eq!(LazyDbPool::retry_delay(5), Duration::from_secs(16));
        // Capped at 2^5 = 32s for attempt 6 and beyond
        assert_eq!(LazyDbPool::retry_delay(6), Duration::from_secs(32));
        assert_eq!(LazyDbPool::retry_delay(10), Duration::from_secs(32));
        assert_eq!(LazyDbPool::retry_delay(100), Duration::from_secs(32));
    }

    /// Verifies that attempt 0 (edge case) returns 1s (saturating_sub prevents underflow).
    #[test]
    fn retry_delay_handles_attempt_zero() {
        // 0.saturating_sub(1) = 0, min(0, 5) = 0, 2^0 = 1s
        assert_eq!(LazyDbPool::retry_delay(0), Duration::from_secs(1));
    }
}
