use async_trait::async_trait;
use sqlx::{query_as, query_scalar, MySql, Pool};

use crate::db::LazyDbPool;
use crate::error::{AppError, Result};
use crate::models::session::Session;
use crate::repositories::session::{NewSession, SessionRepository, SessionUpdates};
use crate::models::slide::Slide;
use crate::models::student::{Question, Participant};

#[derive(sqlx::FromRow)]
struct SessionWithSlideCountRow {
    id: String,
    creator_id: String,
    title: String,
    status: String,
    share_token: Option<String>,
    current_slide_id: Option<String>,
    is_results_visible: bool,
    is_presentation_active: bool,
    allow_questions: bool,
    require_name: bool,
    created_at: Option<chrono::DateTime<chrono::Utc>>,
    updated_at: Option<chrono::DateTime<chrono::Utc>>,
    slide_count: i64,
}

/// SQLx implementation of SessionRepository
/// This is the Infrastructure Layer - it knows about databases
pub struct SqlxSessionRepository {
    pool: Option<Pool<MySql>>,
    lazy_pool: Option<LazyDbPool>,
}

impl SqlxSessionRepository {
    pub fn new(pool: Pool<MySql>) -> Self {
        Self { pool: Some(pool), lazy_pool: None }
    }

    pub fn new_lazy(lazy_pool: LazyDbPool) -> Self {
        Self { pool: None, lazy_pool: Some(lazy_pool) }
    }

    async fn get_pool(&self) -> Result<Pool<MySql>> {
        if let Some(ref pool) = self.pool {
            return Ok(pool.clone());
        }
        
        if let Some(ref lazy) = self.lazy_pool {
            lazy.get_or_wait().await
        } else {
            Err(AppError::Internal("No database pool configured".to_string()))
        }
    }
}

#[async_trait]
impl SessionRepository for SqlxSessionRepository {
    async fn find_by_creator(&self, creator_id: &str) -> Result<Vec<Session>> {
        let pool = self.get_pool().await?;
        let sessions = query_as::<_, Session>(
            "SELECT * FROM sessions WHERE creator_id = ? ORDER BY created_at DESC"
        )
        .bind(creator_id)
        .fetch_all(&pool)
        .await?;

        Ok(sessions)
    }

    async fn find_by_creator_with_slide_count(&self, creator_id: &str) -> Result<Vec<(Session, i64)>> {
        let pool = self.get_pool().await?;
        let rows = query_as::<_, SessionWithSlideCountRow>(
            r#"
            SELECT
                s.id,
                s.creator_id,
                s.title,
                s.status,
                s.share_token,
                s.current_slide_id,
                s.is_results_visible,
                s.is_presentation_active,
                s.allow_questions,
                s.require_name,
                s.created_at,
                s.updated_at,
                COALESCE(sc.slide_count, 0) as slide_count
            FROM sessions s
            LEFT JOIN (
                SELECT session_id, COUNT(*) as slide_count
                FROM slides
                GROUP BY session_id
            ) sc ON sc.session_id = s.id
            WHERE s.creator_id = ?
            ORDER BY s.created_at DESC
            "#
        )
        .bind(creator_id)
        .fetch_all(&pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| {
                (
                    Session {
                        id: r.id,
                        creator_id: r.creator_id,
                        title: r.title,
                        status: r.status,
                        share_token: r.share_token,
                        current_slide_id: r.current_slide_id,
                        is_results_visible: r.is_results_visible,
                        is_presentation_active: r.is_presentation_active,
                        allow_questions: r.allow_questions,
                        require_name: r.require_name,
                        created_at: r.created_at,
                        updated_at: r.updated_at,
                    },
                    r.slide_count,
                )
            })
            .collect())
    }

    async fn find_by_id(&self, id: &str) -> Result<Option<Session>> {
        let pool = self.get_pool().await?;
        let session = query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
            .bind(id)
            .fetch_optional(&pool)
            .await?;

        Ok(session)
    }

    async fn find_by_share_token(&self, token: &str) -> Result<Option<Session>> {
        let pool = self.get_pool().await?;
        let session = query_as::<_, Session>("SELECT * FROM sessions WHERE share_token = ?")
            .bind(token)
            .fetch_optional(&pool)
            .await?;

        Ok(session)
    }

    async fn create(&self, new_session: &NewSession) -> Result<Session> {
        let pool = self.get_pool().await?;
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
        .execute(&pool)
        .await?;

        let session = query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
            .bind(&new_session.id)
            .fetch_one(&pool)
            .await?;

        Ok(session)
    }

    async fn update(&self, id: &str, updates: &SessionUpdates) -> Result<Session> {
        let pool = self.get_pool().await?;
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

        query.build().execute(&pool).await?;

        let session = query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await?;

        Ok(session)
    }

    async fn delete(&self, id: &str) -> Result<u64> {
        let pool = self.get_pool().await?;
        let result = sqlx::query("DELETE FROM sessions WHERE id = ?")
            .bind(id)
            .execute(&pool)
            .await?;

        Ok(result.rows_affected())
    }

    async fn verify_ownership(&self, session_id: &str, user_id: &str) -> Result<bool> {
        let pool = self.get_pool().await?;
        let exists: Option<bool> = query_scalar(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ? AND creator_id = ?)"
        )
        .bind(session_id)
        .bind(user_id)
        .fetch_optional(&pool)
        .await?;

        Ok(exists.unwrap_or(false))
    }

    async fn get_slides(&self, session_id: &str) -> Result<Vec<Slide>> {
        let pool = self.get_pool().await?;
        let slides = query_as::<_, Slide>(
            "SELECT * FROM slides WHERE session_id = ? AND is_hidden = FALSE ORDER BY order_index"
        )
        .bind(session_id)
        .fetch_all(&pool)
        .await?;
        Ok(slides)
    }

    async fn get_questions(&self, session_id: &str) -> Result<Vec<Question>> {
        let pool = self.get_pool().await?;
        let questions = query_as::<_, Question>(
            "SELECT * FROM questions WHERE session_id = ? ORDER BY upvotes DESC, created_at DESC"
        )
        .bind(session_id)
        .fetch_all(&pool)
        .await?;
        Ok(questions)
    }

    async fn get_participants(&self, session_id: &str) -> Result<Vec<Participant>> {
        let pool = self.get_pool().await?;
        let participants = query_as::<_, Participant>(
            "SELECT id, session_id, name, joined_at FROM participants WHERE session_id = ? ORDER BY joined_at DESC"
        )
        .bind(session_id)
        .fetch_all(&pool)
        .await?;
        Ok(participants)
    }

    async fn get_vote_counts(&self, session_id: &str) -> Result<Vec<(String, String, i64)>> {
        let pool = self.get_pool().await?;
        let counts = sqlx::query_as(
            "SELECT slide_id, option_id, COUNT(*) as count FROM votes WHERE session_id = ? GROUP BY slide_id, option_id"
        )
        .bind(session_id)
        .fetch_all(&pool)
        .await?;
        Ok(counts)
    }
}
