//! Check database contents
//! Run with: cargo run --bin check_db

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
    
    // Check sessions
    let session_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sessions")
        .fetch_one(&pool)
        .await?;
    println!("Sessions count: {}", session_count.0);
    
    // Check users
    let user_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(&pool)
        .await?;
    println!("Users count: {}", user_count.0);
    
    // Check slides
    let slide_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM slides")
        .fetch_one(&pool)
        .await?;
    println!("Slides count: {}", slide_count.0);
    
    // List sessions
    println!("\nSessions:");
    let sessions: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT id, title, status, creator_id FROM sessions LIMIT 10"
    )
    .fetch_all(&pool)
    .await?;
    
    for (id, title, status, creator_id) in sessions {
        println!("  - {} | {} | {} | creator: {}", &id[..8], title, status, &creator_id[..8]);
    }
    
    // List users
    println!("\nUsers:");
    let users: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, email, name FROM users LIMIT 10"
    )
    .fetch_all(&pool)
    .await?;
    
    for (id, email, name) in users {
        println!("  - {} | {} | {}", &id[..8], email, name);
    }
    
    Ok(())
}
