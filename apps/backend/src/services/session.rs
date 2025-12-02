use std::sync::Arc;
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::models::session::Session;
use crate::repositories::session::{NewSession, SessionRepository, SessionUpdates};

// Input validation constants
const MAX_TITLE_LENGTH: usize = 200;

/// SessionService - Application Layer
/// Contains business logic, orchestrates repository calls
/// Depends on the SessionRepository TRAIT, not the implementation
pub struct SessionService {
    repository: Arc<dyn SessionRepository>,
}

impl SessionService {
    pub fn new(repository: Arc<dyn SessionRepository>) -> Self {
        Self { repository }
    }

    /// Get all sessions for a user
    pub async fn get_user_sessions(&self, user_id: &str) -> Result<Vec<Session>> {
        self.repository.find_by_creator(user_id).await
    }

    /// Get all sessions for a user with slide counts
    pub async fn get_user_sessions_with_slide_count(&self, user_id: &str) -> Result<Vec<crate::models::session::SessionWithSlideCount>> {
        let sessions_with_counts = self.repository.find_by_creator_with_slide_count(user_id).await?;
        
        let result = sessions_with_counts
            .into_iter()
            .map(|(session, slide_count)| crate::models::session::SessionWithSlideCount {
                session,
                slide_count,
            })
            .collect();
        
        Ok(result)
    }

    /// Get a specific session by ID
    /// Validates ownership
    pub async fn get_session(&self, session_id: &str, user_id: &str) -> Result<Session> {
        let session = self.repository
            .find_by_id(session_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;

        if session.creator_id != user_id {
            return Err(AppError::Auth("Unauthorized access to session".to_string()));
        }

        Ok(session)
    }

    /// Create a new session
    /// Business Rule: Title must be non-empty and within MAX_TITLE_LENGTH
    pub async fn create_session(
        &self,
        user_id: &str,
        title: &str,
        allow_questions: bool,
        require_name: bool,
    ) -> Result<Session> {
        // Input validation (Business Layer)
        let title = title.trim();
        if title.is_empty() {
            return Err(AppError::Input("Title cannot be empty".to_string()));
        }
        if title.len() > MAX_TITLE_LENGTH {
            return Err(AppError::Input(format!(
                "Title too long (max {} characters)",
                MAX_TITLE_LENGTH
            )));
        }

        // Generate ID and share token (Business Logic)
        let id = Uuid::new_v4().to_string();
        let share_token = Uuid::new_v4().to_string()[..8].to_string();

        let new_session = NewSession {
            id,
            creator_id: user_id.to_string(),
            title: title.to_string(),
            share_token,
            allow_questions,
            require_name,
        };

        self.repository.create(&new_session).await
    }

    /// Update a session
    /// Business Rule: Must verify ownership before update
    pub async fn update_session(
        &self,
        session_id: &str,
        user_id: &str,
        title: Option<String>,
        allow_questions: Option<bool>,
        require_name: Option<bool>,
    ) -> Result<Session> {
        // Verify ownership (Business Rule)
        self.verify_ownership(session_id, user_id).await?;

        // Validate title if provided
        if let Some(ref t) = title {
            let trimmed = t.trim();
            if trimmed.is_empty() {
                return Err(AppError::Input("Title cannot be empty".to_string()));
            }
            if trimmed.len() > MAX_TITLE_LENGTH {
                return Err(AppError::Input(format!(
                    "Title too long (max {} characters)",
                    MAX_TITLE_LENGTH
                )));
            }
        }

        let updates = SessionUpdates {
            title,
            status: None,
            allow_questions,
            require_name,
        };

        self.repository.update(session_id, &updates).await
    }

    /// Delete a session
    /// Business Rule: Must verify ownership before deletion
    pub async fn delete_session(&self, session_id: &str, user_id: &str) -> Result<()> {
        self.verify_ownership(session_id, user_id).await?;

        let rows_affected = self.repository.delete(session_id).await?;

        if rows_affected == 0 {
            return Err(AppError::NotFound("Session not found".to_string()));
        }

        Ok(())
    }

    /// Duplicate a session
    /// Business Rule: Must verify ownership of original session
    pub async fn duplicate_session(&self, session_id: &str, user_id: &str) -> Result<Session> {
        self.verify_ownership(session_id, user_id).await?;

        let original = self.repository
            .find_by_id(session_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;

        let new_id = Uuid::new_v4().to_string();
        let new_share_token = Uuid::new_v4().to_string()[..8].to_string();
        let new_title = format!("{} (Copy)", original.title);

        let new_session = NewSession {
            id: new_id,
            creator_id: user_id.to_string(),
            title: new_title,
            share_token: new_share_token,
            allow_questions: original.allow_questions,
            require_name: original.require_name,
        };

        self.repository.create(&new_session).await
    }

    /// Archive a session
    pub async fn archive_session(&self, session_id: &str, user_id: &str) -> Result<Session> {
        self.verify_ownership(session_id, user_id).await?;

        let updates = SessionUpdates {
            title: None,
            status: Some("archived".to_string()),
            allow_questions: None,
            require_name: None,
        };

        self.repository.update(session_id, &updates).await
    }

    /// Restore a session
    pub async fn restore_session(&self, session_id: &str, user_id: &str) -> Result<Session> {
        self.verify_ownership(session_id, user_id).await?;

        let updates = SessionUpdates {
            title: None,
            status: Some("draft".to_string()),
            allow_questions: None,
            require_name: None,
        };

        self.repository.update(session_id, &updates).await
    }

    /// Helper: Verify ownership
    /// Business Rule: Only the creator can modify a session
    async fn verify_ownership(&self, session_id: &str, user_id: &str) -> Result<()> {
        let is_owner = self.repository.verify_ownership(session_id, user_id).await?;

        if !is_owner {
            return Err(AppError::Auth("Unauthorized access to session".to_string()));
        }

        Ok(())
    }

    /// Get public session data by share token
    pub async fn get_public_session(&self, token: &str) -> Result<crate::models::session::PublicSessionResponse> {
        let session = self.repository.find_by_share_token(token).await?
            .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;

        let slides = self.repository.get_slides(&session.id).await?;
        let questions = self.repository.get_questions(&session.id).await?;
        let participants = self.repository.get_participants(&session.id).await?;
        let vote_counts_raw = self.repository.get_vote_counts(&session.id).await?;

        // Process vote counts
        let mut vote_map: std::collections::HashMap<String, std::collections::HashMap<String, i32>> = std::collections::HashMap::new();
        for (slide_id, option_id, count) in vote_counts_raw {
            vote_map
                .entry(slide_id)
                .or_insert_with(std::collections::HashMap::new)
                .insert(option_id, count as i32);
        }

        let slides_with_stats = slides.into_iter().map(|slide| {
            let votes = vote_map.remove(&slide.id);
            crate::models::session::SlideWithStats {
                slide,
                stats: votes.map(|v| crate::models::session::VoteStats { votes: v }),
            }
        }).collect();

        Ok(crate::models::session::PublicSessionResponse {
            session,
            slides: slides_with_stats,
            questions,
            participants,
        })
    }

    /// Get session state for real-time sync
    pub async fn get_session_state(&self, session_id: &str) -> Result<crate::models::session::SessionState> {
        let session = self.repository.find_by_id(session_id).await?
             .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;

        let slides = self.repository.get_slides(session_id).await?;
        let questions = self.repository.get_questions(session_id).await?;
        let vote_counts_raw = self.repository.get_vote_counts(session_id).await?;

        let mut vote_counts: std::collections::HashMap<String, std::collections::HashMap<String, i32>> = std::collections::HashMap::new();
        for (slide_id, option_id, count) in vote_counts_raw {
            vote_counts
                .entry(slide_id)
                .or_insert_with(std::collections::HashMap::new)
                .insert(option_id, count as i32);
        }

        Ok(crate::models::session::SessionState {
            current_slide_id: session.current_slide_id,
            is_presentation_active: session.is_presentation_active,
            is_results_visible: session.is_results_visible,
            slides,
            questions,
            vote_counts,
        })
    }
}
