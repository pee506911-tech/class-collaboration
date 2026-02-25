use crate::error::{AppError, Result};
use sqlx::mysql::MySqlPoolOptions;
use sqlx::{MySql, Pool};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Notify, RwLock};

pub type DbPool = Pool<MySql>;

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
    pub fn start_background_init(self, database_url: String, run_migrations: bool) {
        tokio::spawn(async move {
            tracing::info!("Starting background database initialization...");

            let mut attempt: u32 = 0;
            loop {
                attempt += 1;

                match Self::init_pool(&database_url, run_migrations).await {
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

    async fn init_pool(database_url: &str, run_migrations: bool) -> anyhow::Result<DbPool> {
        // Conservative defaults work better on free/shared DB plans with low connection limits.
        let max_connections = Self::env_u32("DB_MAX_CONNECTIONS", 5);
        let min_connections = Self::env_u32("DB_MIN_CONNECTIONS", 0);
        let acquire_timeout_secs = Self::env_u64("DB_ACQUIRE_TIMEOUT_SECONDS", 30);
        let idle_timeout_secs = Self::env_u64("DB_IDLE_TIMEOUT_SECONDS", 600);

        let pool = MySqlPoolOptions::new()
            .max_connections(max_connections)
            .min_connections(min_connections) // Start with 0 for faster init
            .acquire_timeout(Duration::from_secs(acquire_timeout_secs))
            .idle_timeout(Duration::from_secs(idle_timeout_secs))
            .connect(database_url)
            .await?;

        if run_migrations {
            tracing::info!("Running database migrations...");
            sqlx::migrate!("./migrations").run(&pool).await?;
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

    fn retry_delay(attempt: u32) -> Duration {
        let exp = attempt.saturating_sub(1).min(5);
        Duration::from_secs(1_u64 << exp)
    }

    fn env_u32(name: &str, default: u32) -> u32 {
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(default)
    }

    fn env_u64(name: &str, default: u64) -> u64 {
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(default)
    }
}
