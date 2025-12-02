//! Check database schema
//! Run with: cargo run --bin check_schema

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
    
    // Show sessions table schema
    println!("Sessions table schema:");
    let columns: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT 
         FROM INFORMATION_SCHEMA.COLUMNS 
         WHERE TABLE_NAME = 'sessions' 
         ORDER BY ORDINAL_POSITION"
    )
    .fetch_all(&pool)
    .await?;
    
    for (name, dtype, nullable, default) in &columns {
        println!("  {} {} {} default={}", name, dtype, nullable, default.as_deref().unwrap_or("NULL"));
    }
    
    // Check if allow_questions exists
    let has_allow_questions = columns.iter().any(|(name, _, _, _)| name == "allow_questions");
    println!("\nallow_questions column exists: {}", has_allow_questions);
    
    if !has_allow_questions {
        println!("\nAdding allow_questions column...");
        sqlx::query("ALTER TABLE sessions ADD COLUMN allow_questions BOOLEAN DEFAULT TRUE")
            .execute(&pool)
            .await?;
        println!("Added!");
    }
    
    // Check if require_name exists
    let has_require_name = columns.iter().any(|(name, _, _, _)| name == "require_name");
    println!("require_name column exists: {}", has_require_name);
    
    if !has_require_name {
        println!("\nAdding require_name column...");
        sqlx::query("ALTER TABLE sessions ADD COLUMN require_name BOOLEAN DEFAULT FALSE")
            .execute(&pool)
            .await?;
        println!("Added!");
    }
    
    Ok(())
}
