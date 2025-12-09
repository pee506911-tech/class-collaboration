//! Fix SQLx migrations by cleaning up the _sqlx_migrations table
//! Run with: cargo run --bin fix_migrations

use sqlx::mysql::MySqlPoolOptions;
use dotenvy::dotenv;
use std::env;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenv().ok();
    
    let database_url = env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set");
    
    println!("Connecting to database...");
    
    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await?;
    
    println!("Connected!\n");
    
    // Show all tables
    println!("Current tables:");
    let tables: Vec<(String,)> = sqlx::query_as("SHOW TABLES")
        .fetch_all(&pool)
        .await?;
    for (table,) in &tables {
        println!("  - {}", table);
    }
    
    // Show current migrations
    println!("\nCurrent migrations:");
    let migrations: Vec<(i64, String, bool)> = sqlx::query_as(
        "SELECT version, description, success FROM _sqlx_migrations ORDER BY version"
    )
    .fetch_all(&pool)
    .await
    .unwrap_or_default();
    
    for (version, desc, success) in &migrations {
        let status = if *success { "✅" } else { "❌" };
        println!("  {} {}: {}", status, version, desc);
    }
    
    // Remove failed/missing migrations
    println!("\nRemoving failed/missing migrations...");
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = 20241201000001")
        .execute(&pool)
        .await?;
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = 20241201150000")
        .execute(&pool)
        .await?;
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = 20241209000000")
        .execute(&pool)
        .await?;
    
    // Drop FK constraints and tables
    println!("Dropping FK constraints and tables...");
    
    // Disable FK checks temporarily
    sqlx::query("SET FOREIGN_KEY_CHECKS = 0").execute(&pool).await?;
    
    // Drop FK constraints on session_scores
    let _ = sqlx::query("ALTER TABLE session_scores DROP FOREIGN KEY fk_2").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE session_scores DROP FOREIGN KEY fk_3").execute(&pool).await;
    
    // Drop all student-related tables
    sqlx::query("DROP TABLE IF EXISTS interactions").execute(&pool).await?;
    sqlx::query("DROP TABLE IF EXISTS questions").execute(&pool).await?;
    sqlx::query("DROP TABLE IF EXISTS votes").execute(&pool).await?;
    sqlx::query("DROP TABLE IF EXISTS participants").execute(&pool).await?;
    
    // Re-enable FK checks
    sqlx::query("SET FOREIGN_KEY_CHECKS = 1").execute(&pool).await?;
    
    println!("\n✅ Done! Now restart the backend to run migrations.");
    
    Ok(())
}
