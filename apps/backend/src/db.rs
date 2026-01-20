use sqlx::mysql::MySqlPoolOptions;
use sqlx::{MySql, Pool};
use std::sync::Arc;
use tokio::sync::{Notify, RwLock};
use std::sync::atomic::{AtomicBool, Ordering};
use crate::error::{AppError, Result};

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
            
            match Self::init_pool(&database_url, run_migrations).await {
                Ok(pool) => {
                    *self.pool.write().await = Some(pool);
                    self.ready.store(true, Ordering::SeqCst);
                    self.notify.notify_waiters();
                    tracing::info!("Database ready!");
                }
                Err(e) => {
                    let err_msg = format!("Database init failed: {}", e);
                    tracing::error!("{}", err_msg);
                    *self.error.write().await = Some(err_msg);
                    self.notify.notify_waiters();
                }
            }
        });
    }

    async fn init_pool(database_url: &str, run_migrations: bool) -> anyhow::Result<DbPool> {
        let pool = MySqlPoolOptions::new()
            .max_connections(20)
            .min_connections(0) // Start with 0 for faster init
            .acquire_timeout(std::time::Duration::from_secs(10))
            .idle_timeout(std::time::Duration::from_secs(600))
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
}
