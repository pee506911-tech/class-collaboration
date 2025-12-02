use async_trait::async_trait;
use sqlx::{query_as, query_scalar, MySql, Pool};

use crate::error::Result;
use crate::models::session::Session;
use crate::repositories::session::{NewSession, SessionRepository, SessionUpdates};
use crate::models::slide::Slide;
use crate::models::student::{Question, Participant};

/// SQLx implementation of SessionRepository
/// This is the Infrastructure Layer - it knows about databases
pub struct SqlxSessionRepository {
    pool: Pool<MySql>,
}

impl SqlxSessionRepository {
    pub fn new(pool: Pool<MySql>) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl SessionRepository for SqlxSessionRepository {
    async fn find_by_creator(&self, creator_id: &str) -> Result<Vec<Session>> {
        let sessions = query_as::<_, Session>(
            "SELECT * FROM sessions WHERE creator_id = ? ORDER BY created_at DESC"
        )
        .bind(creator_id)
        .fetch_all(&self.pool)
        .await?;

        Ok(sessions)
    }

    async fn find_by_creator_with_slide_count(&self, creator_id: &str) -> Result<Vec<(Session, i64)>> {
        // First get all sessions for the user
        let sessions = query_as::<_, Session>(
            "SELECT * FROM sessions WHERE creator_id = ? ORDER BY created_at DESC"
        )
        .bind(creator_id)
        .fetch_all(&self.pool)
        .await?;

        // Then get slide counts for all sessions
        let mut result = Vec::new();
        for session in sessions {
            let count: (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM slides WHERE session_id = ?"
            )
            .bind(&session.id)
            .fetch_one(&self.pool)
            .await?;
            
            result.push((session, count.0));
        }

        Ok(result)
    }

    async fn find_by_id(&self, id: &str) -> Result<Option<Session>> {
        let session = query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;

        Ok(session)
    }

    async fn find_by_share_token(&self, token: &str) -> Result<Option<Session>> {
        let session = query_as::<_, Session>("SELECT * FROM sessions WHERE share_token = ?")
            .bind(token)
            .fetch_optional(&self.pool)
            .await?;

        Ok(session)
    }

    async fn create(&self, new_session: &NewSession) -> Result<Session> {
        sqlx::query(
            "INSERT INTO sessions (id, creator_id, title, share_token, allow_questions, require_name) 
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&new_session.id)
        .bind(&new_session.creator_id)
        .bind(&new_session.title)
        .bind(&new_session.share_token)
        .bind(new_session.allow_questions)
        .bind(new_session.require_name)
        .execute(&self.pool)
        .await?;

        // Fetch the created session
        let session = query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
            .bind(&new_session.id)
            .fetch_one(&self.pool)
            .await?;

        Ok(session)
    }

    async fn update(&self, id: &str, updates: &SessionUpdates) -> Result<Session> {
        let mut query = sqlx::QueryBuilder::new("UPDATE sessions SET ");
        let mut separated = query.separated(", ");

        if let Some(title) = &updates.title {
            separated.push("title = ");
            separated.push_bind_unseparated(title);
        }

        if let Some(status) = &updates.status {
            separated.push("status = ");
            separated.push_bind_unseparated(status);
        }

        if let Some(allow_questions) = updates.allow_questions {
            separated.push("allow_questions = ");
            separated.push_bind_unseparated(allow_questions);
        }

        if let Some(require_name) = updates.require_name {
            separated.push("require_name = ");
            separated.push_bind_unseparated(require_name);
        }

        query.push(" WHERE id = ");
        query.push_bind(id);

        query.build().execute(&self.pool).await?;

        // Fetch updated session
        let session = query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
            .bind(id)
            .fetch_one(&self.pool)
            .await?;

        Ok(session)
    }

    async fn delete(&self, id: &str) -> Result<u64> {
        let result = sqlx::query("DELETE FROM sessions WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;

        Ok(result.rows_affected())
    }

    async fn verify_ownership(&self, session_id: &str, user_id: &str) -> Result<bool> {
        let exists: Option<bool> = query_scalar(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ? AND creator_id = ?)"
        )
        .bind(session_id)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(exists.unwrap_or(false))
    }

    async fn get_slides(&self, session_id: &str) -> Result<Vec<Slide>> {
        let slides = query_as::<_, Slide>(
            "SELECT * FROM slides WHERE session_id = ? AND is_hidden = FALSE ORDER BY order_index"
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(slides)
    }

    async fn get_questions(&self, session_id: &str) -> Result<Vec<Question>> {
        let questions = query_as::<_, Question>(
            "SELECT * FROM questions WHERE session_id = ? ORDER BY upvotes DESC, created_at DESC"
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(questions)
    }

    async fn get_participants(&self, session_id: &str) -> Result<Vec<Participant>> {
        let participants = query_as::<_, Participant>(
            "SELECT id, session_id, name, joined_at FROM participants WHERE session_id = ? ORDER BY joined_at DESC"
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(participants)
    }

    async fn get_vote_counts(&self, session_id: &str) -> Result<Vec<(String, String, i64)>> {
        let counts = sqlx::query_as(
            "SELECT slide_id, option_id, COUNT(*) as count FROM votes WHERE session_id = ? GROUP BY slide_id, option_id"
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(counts)
    }
}
