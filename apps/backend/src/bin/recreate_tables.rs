//! Recreate missing tables
//! Run with: cargo run --bin recreate_tables

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
    
    // Recreate participants table
    println!("Creating participants table...");
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS participants (
            id VARCHAR(36) NOT NULL,
            session_id VARCHAR(36) NOT NULL,
            name VARCHAR(255) NOT NULL,
            joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id, session_id),
            INDEX idx_participants_session (session_id)
        )
    "#)
    .execute(&pool)
    .await?;
    println!("✅ participants table created");
    
    // Recreate votes table
    println!("Creating votes table...");
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS votes (
            id VARCHAR(36) PRIMARY KEY,
            session_id VARCHAR(36) NOT NULL,
            slide_id VARCHAR(36) NOT NULL,
            participant_id VARCHAR(36) NOT NULL,
            option_id VARCHAR(36) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_vote (slide_id, participant_id, option_id),
            INDEX idx_votes_session_slide (session_id, slide_id)
        )
    "#)
    .execute(&pool)
    .await?;
    println!("✅ votes table created");
    
    // Recreate questions table
    println!("Creating questions table...");
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS questions (
            id VARCHAR(36) PRIMARY KEY,
            session_id VARCHAR(36) NOT NULL,
            slide_id VARCHAR(36),
            participant_id VARCHAR(36) NOT NULL,
            content TEXT NOT NULL,
            upvotes INT DEFAULT 0,
            is_approved BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_questions_session (session_id)
        )
    "#)
    .execute(&pool)
    .await?;
    println!("✅ questions table created");
    
    // Recreate question_upvotes table
    println!("Creating question_upvotes table...");
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS question_upvotes (
            question_id VARCHAR(36) NOT NULL,
            participant_id VARCHAR(36) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (question_id, participant_id),
            INDEX idx_upvotes_question (question_id)
        )
    "#)
    .execute(&pool)
    .await?;
    println!("✅ question_upvotes table created");
    
    println!("\n✅ All tables recreated successfully!");
    
    Ok(())
}
