use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use chrono::{DateTime, Utc};
use crate::db::DbPool;
use crate::error::Result;
use uuid::Uuid;
use sqlx::MySql;

// ============================================
// Participant Model
// ============================================

#[derive(Debug, Serialize, Deserialize, FromRow, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub id: String,
    #[sqlx(rename = "session_id")]
    pub session_id: String,
    pub name: String,
    #[sqlx(rename = "joined_at")]
    pub joined_at: Option<DateTime<Utc>>,
}

impl Participant {
    pub async fn create(pool: &DbPool, id: &str, session_id: &str, name: &str) -> Result<Self> {
        sqlx::query_as::<_, Participant>(
            r#"
            INSERT INTO participants (id, session_id, name)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE name = VALUES(name)
            "#
        )
        .bind(id)
        .bind(session_id)
        .bind(name)
        .fetch_optional(pool)
        .await?;

        // Return the participant
        Ok(Participant {
            id: id.to_string(),
            session_id: session_id.to_string(),
            name: name.to_string(),
            joined_at: Some(Utc::now()),
        })
    }

    pub async fn find_by_session(pool: &DbPool, session_id: &str) -> Result<Vec<Self>> {
        let participants = sqlx::query_as::<_, Participant>(
            "SELECT id, session_id, name, joined_at FROM participants WHERE session_id = ?"
        )
        .bind(session_id)
        .fetch_all(pool)
        .await?;
        Ok(participants)
    }

    pub async fn count_by_session(pool: &DbPool, session_id: &str) -> Result<i64> {
        let count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM participants WHERE session_id = ?"
        )
        .bind(session_id)
        .fetch_one(pool)
        .await?;
        Ok(count.0)
    }
}

// ============================================
// Vote Model
// ============================================

#[derive(Debug, Serialize, Deserialize, FromRow, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Vote {
    pub id: String,
    #[sqlx(rename = "session_id")]
    pub session_id: String,
    #[sqlx(rename = "slide_id")]
    pub slide_id: String,
    #[sqlx(rename = "participant_id")]
    pub participant_id: String,
    #[sqlx(rename = "option_id")]
    pub option_id: String,
    #[sqlx(rename = "created_at")]
    pub created_at: Option<DateTime<Utc>>,
}

impl Vote {
    pub async fn create(
        pool: &DbPool,
        id: &str,
        session_id: &str,
        slide_id: &str,
        participant_id: &str,
        option_id: &str,
    ) -> Result<Self> {
        sqlx::query(
            r#"
            INSERT INTO votes (id, session_id, slide_id, participant_id, option_id)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE option_id = VALUES(option_id)
            "#
        )
        .bind(id)
        .bind(session_id)
        .bind(slide_id)
        .bind(participant_id)
        .bind(option_id)
        .execute(pool)
        .await?;

        Ok(Vote {
            id: id.to_string(),
            session_id: session_id.to_string(),
            slide_id: slide_id.to_string(),
            participant_id: participant_id.to_string(),
            option_id: option_id.to_string(),
            created_at: Some(Utc::now()),
        })
    }

    pub async fn create_many(
        pool: &DbPool,
        session_id: &str,
        slide_id: &str,
        participant_id: &str,
        option_ids: &[String],
    ) -> Result<()> {
        if option_ids.is_empty() {
            return Ok(());
        }

        let mut query = sqlx::QueryBuilder::<MySql>::new(
            "INSERT INTO votes (id, session_id, slide_id, participant_id, option_id) "
        );

        query.push_values(option_ids.iter(), |mut row, option_id| {
            let vote_id = Uuid::new_v4().to_string();
            row.push_bind(vote_id);
            row.push_bind(session_id);
            row.push_bind(slide_id);
            row.push_bind(participant_id);
            row.push_bind(option_id);
        });

        query.push(" ON DUPLICATE KEY UPDATE option_id = VALUES(option_id)");

        query.build().execute(pool).await?;
        Ok(())
    }

    pub async fn find_by_slide(pool: &DbPool, slide_id: &str) -> Result<Vec<Self>> {
        let votes = sqlx::query_as::<_, Vote>(
            "SELECT id, session_id, slide_id, participant_id, option_id, created_at 
             FROM votes WHERE slide_id = ?"
        )
        .bind(slide_id)
        .fetch_all(pool)
        .await?;
        Ok(votes)
    }

    pub async fn count_by_option(pool: &DbPool, slide_id: &str, option_id: &str) -> Result<i64> {
        let count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM votes WHERE slide_id = ? AND option_id = ?"
        )
        .bind(slide_id)
        .bind(option_id)
        .fetch_one(pool)
        .await?;
        Ok(count.0)
    }

    pub async fn get_vote_counts(pool: &DbPool, slide_id: &str) -> Result<Vec<(String, i64)>> {
        let counts: Vec<(String, i64)> = sqlx::query_as(
            "SELECT option_id, COUNT(*) as count FROM votes WHERE slide_id = ? GROUP BY option_id"
        )
        .bind(slide_id)
        .fetch_all(pool)
        .await?;
        Ok(counts)
    }

    pub async fn has_voted(pool: &DbPool, slide_id: &str, participant_id: &str) -> Result<bool> {
        let count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM votes WHERE slide_id = ? AND participant_id = ?"
        )
        .bind(slide_id)
        .bind(participant_id)
        .fetch_one(pool)
        .await?;
        Ok(count.0 > 0)
    }
}

// ============================================
// Question Model
// ============================================

#[derive(Debug, Serialize, Deserialize, FromRow, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: String,
    #[sqlx(rename = "session_id")]
    pub session_id: String,
    #[sqlx(rename = "slide_id")]
    pub slide_id: Option<String>,
    #[sqlx(rename = "participant_id")]
    pub participant_id: String,
    pub content: String,
    pub upvotes: i32,
    #[sqlx(rename = "is_approved")]
    pub is_approved: bool,
    #[sqlx(rename = "created_at")]
    pub created_at: Option<DateTime<Utc>>,
}

impl Question {
    pub async fn create(
        pool: &DbPool,
        id: &str,
        session_id: &str,
        slide_id: Option<&str>,
        participant_id: &str,
        content: &str,
    ) -> Result<Self> {
        sqlx::query(
            r#"
            INSERT INTO questions (id, session_id, slide_id, participant_id, content)
            VALUES (?, ?, ?, ?, ?)
            "#
        )
        .bind(id)
        .bind(session_id)
        .bind(slide_id)
        .bind(participant_id)
        .bind(content)
        .execute(pool)
        .await?;

        Ok(Question {
            id: id.to_string(),
            session_id: session_id.to_string(),
            slide_id: slide_id.map(|s| s.to_string()),
            participant_id: participant_id.to_string(),
            content: content.to_string(),
            upvotes: 0,
            is_approved: true,
            created_at: Some(Utc::now()),
        })
    }

    pub async fn find_by_session(pool: &DbPool, session_id: &str) -> Result<Vec<Self>> {
        let questions = sqlx::query_as::<_, Question>(
            "SELECT id, session_id, slide_id, participant_id, content, upvotes, is_approved, created_at 
             FROM questions WHERE session_id = ? ORDER BY upvotes DESC, created_at DESC"
        )
        .bind(session_id)
        .fetch_all(pool)
        .await?;
        Ok(questions)
    }

    pub async fn find_by_id(pool: &DbPool, id: &str) -> Result<Option<Self>> {
        let question = sqlx::query_as::<_, Question>(
            "SELECT id, session_id, slide_id, participant_id, content, upvotes, is_approved, created_at 
             FROM questions WHERE id = ?"
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;
        Ok(question)
    }

    pub async fn upvote(pool: &DbPool, id: &str) -> Result<i32> {
        sqlx::query("UPDATE questions SET upvotes = upvotes + 1 WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;

        let question: (i32,) = sqlx::query_as("SELECT upvotes FROM questions WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await?;
        Ok(question.0)
    }

    pub async fn approve(pool: &DbPool, id: &str, approved: bool) -> Result<()> {
        sqlx::query("UPDATE questions SET is_approved = ? WHERE id = ?")
            .bind(approved)
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn delete(pool: &DbPool, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM questions WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }
}
