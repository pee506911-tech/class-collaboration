use sqlx::mysql::MySqlPoolOptions;
use sqlx::{MySql, Pool};
use crate::error::Result;

pub type DbPool = Pool<MySql>;

pub async fn init_db(database_url: &str) -> Result<DbPool> {
    let pool = MySqlPoolOptions::new()
        .max_connections(20) // Increased for production load
        .min_connections(5)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .idle_timeout(std::time::Duration::from_secs(600))
        .connect(database_url)
        .await?;

    // Run migrations automatically on startup
    tracing::info!("Running database migrations...");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .map_err(|e| {
            tracing::error!("Migration failed: {}", e);
            e
        })?;
    tracing::info!("Migrations completed successfully");

    Ok(pool)
}
