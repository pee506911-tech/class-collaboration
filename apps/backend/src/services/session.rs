use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock};
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
    state_cache: SessionStateCache,
}

impl SessionService {
    pub fn new(repository: Arc<dyn SessionRepository>, state_cache: SessionStateCache) -> Self {
        Self {
            repository,
            state_cache,
        }
    }

    /// Get all sessions for a user
    pub async fn get_user_sessions(&self, user_id: &str) -> Result<Vec<Session>> {
        self.repository.find_by_creator(user_id).await
    }

    /// Get all sessions for a user with slide counts
    pub async fn get_user_sessions_with_slide_count(
        &self,
        user_id: &str,
    ) -> Result<Vec<crate::models::session::SessionWithSlideCount>> {
        let sessions_with_counts = self
            .repository
            .find_by_creator_with_slide_count(user_id)
            .await?;

        let result = sessions_with_counts
            .into_iter()
            .map(
                |(session, slide_count)| crate::models::session::SessionWithSlideCount {
                    session,
                    slide_count,
                },
            )
            .collect();

        Ok(result)
    }

    /// Get a specific session by ID
    /// Validates ownership
    pub async fn get_session(&self, session_id: &str, user_id: &str) -> Result<Session> {
        let session = self
            .repository
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

        // Normalize and validate title if provided
        let title = title.map(|t| t.trim().to_string());
        if let Some(ref t) = title {
            if t.is_empty() {
                return Err(AppError::Input("Title cannot be empty".to_string()));
            }
            if t.len() > MAX_TITLE_LENGTH {
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

        let original = self
            .repository
            .find_by_id(session_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;

        let new_id = Uuid::new_v4().to_string();
        let new_share_token = Uuid::new_v4().to_string()[..8].to_string();
        let new_title = format!("{} (Copy)", original.title.trim());

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
        let is_owner = self
            .repository
            .verify_ownership(session_id, user_id)
            .await?;

        if !is_owner {
            return Err(AppError::Auth("Unauthorized access to session".to_string()));
        }

        Ok(())
    }

    /// Invalidate the session state cache after a mutation.
    /// This ensures read-after-write consistency: the next GET will fetch fresh data.
    pub async fn invalidate_session_cache(&self, session_id: &str) {
        self.state_cache.invalidate(session_id).await;
    }

    /// Get public session data by share token
    pub async fn get_public_session(
        &self,
        token: &str,
    ) -> Result<crate::models::session::PublicSessionResponse> {
        let session = self
            .repository
            .find_by_share_token(token)
            .await?
            .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;

        let slides_fut = self.repository.get_slides(&session.id);
        let questions_fut = self.repository.get_questions(&session.id);
        let participants_fut = self.repository.get_participants(&session.id);
        let vote_counts_fut = self.repository.get_vote_counts(&session.id);

        let (slides, questions, participants, vote_counts_raw) =
            tokio::try_join!(slides_fut, questions_fut, participants_fut, vote_counts_fut)?;

        // Process vote counts
        let mut vote_map: std::collections::HashMap<
            String,
            std::collections::HashMap<String, i32>,
        > = std::collections::HashMap::new();
        for (slide_id, option_id, count) in vote_counts_raw {
            vote_map
                .entry(slide_id)
                .or_default()
                .insert(option_id, count as i32);
        }

        let slides_with_stats = slides
            .into_iter()
            .map(|slide| {
                let votes = vote_map.remove(&slide.id);
                crate::models::session::SlideWithStats {
                    slide,
                    stats: votes.map(|v| crate::models::session::VoteStats { votes: v }),
                }
            })
            .collect();

        Ok(crate::models::session::PublicSessionResponse {
            session,
            slides: slides_with_stats,
            questions,
            participants,
        })
    }

    /// Lightweight existence check for auth/join hot paths.
    pub async fn ensure_session_exists(&self, session_id: &str) -> Result<()> {
        self.repository
            .get_state_header(session_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;

        Ok(())
    }

    /// Get session state for real-time sync
    pub async fn get_session_state(
        &self,
        session_id: &str,
    ) -> Result<crate::models::session::SessionState> {
        if self.state_cache.ttl == Duration::from_millis(0) {
            return self.get_session_state_uncached(session_id).await;
        }

        self.state_cache
            .get_or_build(session_id, || self.get_session_state_uncached(session_id))
            .await
            .map(|arc| (*arc).clone())
    }

    async fn get_session_state_uncached(
        &self,
        session_id: &str,
    ) -> Result<crate::models::session::SessionState> {
        let header = self
            .repository
            .get_state_header(session_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;

        let slides_fut = self.repository.get_slides(session_id);
        let questions_fut = self.repository.get_questions(session_id);
        let vote_counts_fut = async {
            match header.current_slide_id.as_deref() {
                Some(current_slide_id) => {
                    self.repository
                        .get_vote_counts_for_slide(session_id, current_slide_id)
                        .await
                }
                None => Ok(Vec::new()),
            }
        };

        let (slides, questions, vote_counts_raw) =
            tokio::try_join!(slides_fut, questions_fut, vote_counts_fut)?;

        let mut vote_counts: std::collections::HashMap<
            String,
            std::collections::HashMap<String, i32>,
        > = std::collections::HashMap::new();
        for (slide_id, option_id, count) in vote_counts_raw {
            vote_counts
                .entry(slide_id)
                .or_default()
                .insert(option_id, count as i32);
        }

        Ok(crate::models::session::SessionState {
            current_slide_id: header.current_slide_id,
            is_presentation_active: header.is_presentation_active,
            is_results_visible: header.is_results_visible,
            state_version: header.state_version,
            slides,
            questions,
            vote_counts,
            vote_sequence: header.vote_sequence,
            qa_sequence: header.qa_sequence,
        })
    }
}

#[derive(Clone)]
#[allow(clippy::type_complexity)]
pub struct SessionStateCache {
    ttl: Duration,
    max_entries: usize,
    states: Arc<
        RwLock<
            std::collections::HashMap<String, (Instant, Arc<crate::models::session::SessionState>)>,
        >,
    >,
    locks: Arc<Mutex<std::collections::HashMap<String, Arc<Mutex<()>>>>>,
}

impl SessionStateCache {
    pub fn new(ttl: Duration, max_entries: usize) -> Self {
        Self {
            ttl,
            max_entries,
            states: Arc::new(RwLock::new(std::collections::HashMap::new())),
            locks: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }

    async fn get_or_build<Fut, F>(
        &self,
        session_id: &str,
        builder: F,
    ) -> Result<Arc<crate::models::session::SessionState>>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<crate::models::session::SessionState>>,
    {
        // Fast path: serve fresh cache without blocking.
        if let Some(hit) = self.get_fresh(session_id).await {
            return Ok(hit);
        }

        // Singleflight: one rebuild per session at a time.
        let lock = {
            let mut locks = self.locks.lock().await;
            locks
                .entry(session_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };

        let _guard = lock.lock().await;

        // Re-check after acquiring lock (another waiter may have filled the cache).
        if let Some(hit) = self.get_fresh(session_id).await {
            return Ok(hit);
        }

        let built = builder().await?;
        let arc = Arc::new(built);

        {
            let mut states = self.states.write().await;
            if states.len() >= self.max_entries {
                // Simple safety valve to avoid unbounded growth; classroom usage should stay small.
                states.clear();
            }
            states.insert(session_id.to_string(), (Instant::now(), arc.clone()));
        }

        Ok(arc)
    }

    async fn get_fresh(
        &self,
        session_id: &str,
    ) -> Option<Arc<crate::models::session::SessionState>> {
        let states = self.states.read().await;
        let (ts, state) = states.get(session_id)?;
        if ts.elapsed() <= self.ttl {
            return Some(state.clone());
        }
        None
    }

    /// Invalidate cached state for a session after a mutation.
    /// Ensures read-after-write consistency: the next GET will fetch fresh data from DB.
    /// This is critical for correctness - without it, HTTP API may return stale data
    /// that disagrees with what WebSocket just pushed to clients.
    pub async fn invalidate(&self, session_id: &str) {
        let mut states = self.states.write().await;
        states.remove(session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::session::SessionState;
    use crate::models::slide::Slide;
    use crate::models::student::{Participant, Question};
    use crate::repositories::session::{SessionSequences, SessionStateHeader};
    use futures_util::future::join_all;
    use serde_json::json;
    use sqlx::types::Json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::sync::Mutex;
    use tokio::time::sleep;

    #[derive(Clone, Default)]
    struct MockSessionRepository {
        state: Arc<Mutex<MockState>>,
    }

    #[derive(Clone, Default)]
    struct MockState {
        find_by_creator_result: Option<Vec<Session>>,
        find_by_creator_with_slide_count_result: Option<Vec<(Session, i64)>>,
        find_by_id_result: Option<Option<Session>>,
        find_by_share_token_result: Option<Option<Session>>,
        update_result: Option<Session>,
        delete_result: Option<u64>,
        verify_ownership_result: Option<bool>,
        state_header_result: Option<Option<SessionStateHeader>>,
        slides_result: Option<Vec<Slide>>,
        questions_result: Option<Vec<Question>>,
        participants_result: Option<Vec<Participant>>,
        vote_counts_result: Option<Vec<(String, String, i64)>>,
        vote_counts_for_slide_result: Option<Vec<(String, String, i64)>>,
        sequences_result: Option<SessionSequences>,
        find_by_creator_calls: Vec<String>,
        find_by_creator_with_slide_count_calls: Vec<String>,
        find_by_id_calls: Vec<String>,
        find_by_share_token_calls: Vec<String>,
        create_calls: Vec<NewSession>,
        update_calls: Vec<(String, SessionUpdates)>,
        delete_calls: Vec<String>,
        verify_ownership_calls: Vec<(String, String)>,
        get_state_header_calls: Vec<String>,
        get_slides_calls: Vec<String>,
        get_questions_calls: Vec<String>,
        get_participants_calls: Vec<String>,
        get_vote_counts_calls: Vec<String>,
        get_vote_counts_for_slide_calls: Vec<(String, String)>,
        get_sequences_calls: Vec<String>,
    }

    impl MockSessionRepository {
        async fn snapshot(&self) -> MockState {
            self.state.lock().await.clone()
        }
    }

    fn build_session(
        id: &str,
        creator_id: &str,
        title: &str,
        allow_questions: bool,
        require_name: bool,
    ) -> Session {
        Session {
            id: id.to_string(),
            creator_id: creator_id.to_string(),
            title: title.to_string(),
            status: "published".to_string(),
            share_token: Some("share-token".to_string()),
            current_slide_id: None,
            is_results_visible: false,
            is_presentation_active: false,
            state_version: 0,
            allow_questions,
            require_name,
            created_at: None,
            updated_at: None,
        }
    }

    fn session_from_new_session(new_session: &NewSession) -> Session {
        Session {
            id: new_session.id.clone(),
            creator_id: new_session.creator_id.clone(),
            title: new_session.title.clone(),
            status: "draft".to_string(),
            share_token: Some(new_session.share_token.clone()),
            current_slide_id: None,
            is_results_visible: false,
            is_presentation_active: false,
            state_version: 0,
            allow_questions: new_session.allow_questions,
            require_name: new_session.require_name,
            created_at: None,
            updated_at: None,
        }
    }

    fn build_slide(id: &str, session_id: &str, order_index: i32) -> Slide {
        Slide {
            id: id.to_string(),
            session_id: session_id.to_string(),
            slide_type: "poll".to_string(),
            content: Json(json!({
                "question": format!("Question for {}", id),
                "options": [
                    { "id": "opt-red", "text": "Red" },
                    { "id": "opt-blue", "text": "Blue" }
                ]
            })),
            order_index,
            is_hidden: false,
            version: 0,
        }
    }

    fn build_question(id: &str, session_id: &str, content: &str) -> Question {
        Question {
            id: id.to_string(),
            session_id: session_id.to_string(),
            slide_id: None,
            participant_id: "participant-1".to_string(),
            content: content.to_string(),
            upvotes: 2,
            is_approved: true,
            created_at: None,
        }
    }

    fn build_participant(id: &str, session_id: &str, name: &str) -> Participant {
        Participant {
            id: id.to_string(),
            session_id: session_id.to_string(),
            name: name.to_string(),
            joined_at: None,
        }
    }

    fn build_state(state_version: i64) -> SessionState {
        SessionState {
            current_slide_id: Some("slide-a".to_string()),
            is_presentation_active: true,
            is_results_visible: false,
            state_version,
            slides: vec![build_slide("slide-a", "session-1", 0)],
            questions: vec![build_question(
                "question-1",
                "session-1",
                "Can we see the answer?",
            )],
            vote_counts: std::collections::HashMap::from([(
                "slide-a".to_string(),
                std::collections::HashMap::from([("opt-red".to_string(), 3)]),
            )]),
            vote_sequence: 7,
            qa_sequence: 11,
        }
    }

    fn build_service(repo: &MockSessionRepository, ttl: Duration) -> SessionService {
        let repository: Arc<dyn SessionRepository> = Arc::new(repo.clone());
        SessionService::new(repository, SessionStateCache::new(ttl, 8))
    }

    async fn configure_repo(repo: &MockSessionRepository, f: impl FnOnce(&mut MockState)) {
        let mut state = repo.state.lock().await;
        f(&mut state);
    }

    /// **Feature: performance-audit, Finding 4: Session State Cache Not Invalidated on Writes**
    /// **Validates: Phase 1.3 - Write-through cache invalidation**
    ///
    /// Property: After calling invalidate() on a session_id, the next get_or_build() call
    /// SHALL rebuild the state from the database, not serve the cached version.
    #[tokio::test]
    async fn cache_invalidates_on_write() {
        let repo = MockSessionRepository::default();
        let cache = SessionStateCache::new(Duration::from_secs(60), 8);

        // First build - populate cache
        configure_repo(&repo, |state| {
            state.state_header_result = Some(Some(SessionStateHeader {
                current_slide_id: Some("slide-v1".to_string()),
                is_presentation_active: false,
                is_results_visible: false,
                state_version: 1,
                vote_sequence: 0,
                qa_sequence: 0,
            }));
            state.slides_result = Some(vec![]);
            state.questions_result = Some(vec![]);
            state.vote_counts_for_slide_result = Some(vec![]);
        })
        .await;

        let service = SessionService::new(Arc::new(repo.clone()), cache.clone());
        let state_v1 = service
            .get_session_state("session-1")
            .await
            .expect("should succeed");
        assert_eq!(state_v1.current_slide_id, Some("slide-v1".to_string()));

        // Invalidate the cache (simulating a mutation)
        cache.invalidate("session-1").await;

        // Configure different data for second fetch
        configure_repo(&repo, |state| {
            state.state_header_result = Some(Some(SessionStateHeader {
                current_slide_id: Some("slide-v2".to_string()),
                is_presentation_active: true,
                is_results_visible: true,
                state_version: 2,
                vote_sequence: 1,
                qa_sequence: 1,
            }));
            state.slides_result = Some(vec![]);
            state.questions_result = Some(vec![]);
            state.vote_counts_for_slide_result = Some(vec![]);
        })
        .await;

        // Second fetch should rebuild from DB, not serve cached data
        let state_v2 = service
            .get_session_state("session-1")
            .await
            .expect("should succeed");
        assert_eq!(state_v2.current_slide_id, Some("slide-v2".to_string()));
        assert_eq!(state_v2.is_presentation_active, true);
    }

    #[tokio::test]
    async fn cache_invalidation_is_idempotent() {
        let cache = SessionStateCache::new(Duration::from_secs(60), 8);

        // Invalidate non-existent key (should not panic)
        cache.invalidate("non-existent").await;

        // Invalidate again (should be safe)
        cache.invalidate("non-existent").await;
    }

    #[async_trait::async_trait]
    impl SessionRepository for MockSessionRepository {
        async fn find_by_creator(&self, creator_id: &str) -> Result<Vec<Session>> {
            let mut state = self.state.lock().await;
            state.find_by_creator_calls.push(creator_id.to_string());
            Ok(state
                .find_by_creator_result
                .clone()
                .expect("find_by_creator_result not configured"))
        }

        async fn find_by_creator_with_slide_count(
            &self,
            creator_id: &str,
        ) -> Result<Vec<(Session, i64)>> {
            let mut state = self.state.lock().await;
            state
                .find_by_creator_with_slide_count_calls
                .push(creator_id.to_string());
            Ok(state
                .find_by_creator_with_slide_count_result
                .clone()
                .expect("find_by_creator_with_slide_count_result not configured"))
        }

        async fn find_by_id(&self, id: &str) -> Result<Option<Session>> {
            let mut state = self.state.lock().await;
            state.find_by_id_calls.push(id.to_string());
            Ok(state
                .find_by_id_result
                .clone()
                .expect("find_by_id_result not configured"))
        }

        async fn find_by_share_token(&self, token: &str) -> Result<Option<Session>> {
            let mut state = self.state.lock().await;
            state.find_by_share_token_calls.push(token.to_string());
            Ok(state
                .find_by_share_token_result
                .clone()
                .expect("find_by_share_token_result not configured"))
        }

        async fn create(&self, session: &NewSession) -> Result<Session> {
            let mut state = self.state.lock().await;
            state.create_calls.push(session.clone());
            Ok(session_from_new_session(session))
        }

        async fn update(&self, id: &str, updates: &SessionUpdates) -> Result<Session> {
            let mut state = self.state.lock().await;
            state.update_calls.push((id.to_string(), updates.clone()));
            Ok(state
                .update_result
                .clone()
                .expect("update_result not configured"))
        }

        async fn delete(&self, id: &str) -> Result<u64> {
            let mut state = self.state.lock().await;
            state.delete_calls.push(id.to_string());
            Ok(state.delete_result.expect("delete_result not configured"))
        }

        async fn verify_ownership(&self, session_id: &str, user_id: &str) -> Result<bool> {
            let mut state = self.state.lock().await;
            state
                .verify_ownership_calls
                .push((session_id.to_string(), user_id.to_string()));
            Ok(state
                .verify_ownership_result
                .expect("verify_ownership_result not configured"))
        }

        async fn get_state_header(&self, session_id: &str) -> Result<Option<SessionStateHeader>> {
            let mut state = self.state.lock().await;
            state.get_state_header_calls.push(session_id.to_string());
            Ok(state
                .state_header_result
                .clone()
                .expect("state_header_result not configured"))
        }

        async fn get_slides(&self, session_id: &str) -> Result<Vec<Slide>> {
            let mut state = self.state.lock().await;
            state.get_slides_calls.push(session_id.to_string());
            Ok(state
                .slides_result
                .clone()
                .expect("slides_result not configured"))
        }

        async fn get_questions(&self, session_id: &str) -> Result<Vec<Question>> {
            let mut state = self.state.lock().await;
            state.get_questions_calls.push(session_id.to_string());
            Ok(state
                .questions_result
                .clone()
                .expect("questions_result not configured"))
        }

        async fn get_participants(&self, session_id: &str) -> Result<Vec<Participant>> {
            let mut state = self.state.lock().await;
            state.get_participants_calls.push(session_id.to_string());
            Ok(state
                .participants_result
                .clone()
                .expect("participants_result not configured"))
        }

        async fn get_vote_counts(&self, session_id: &str) -> Result<Vec<(String, String, i64)>> {
            let mut state = self.state.lock().await;
            state.get_vote_counts_calls.push(session_id.to_string());
            Ok(state
                .vote_counts_result
                .clone()
                .expect("vote_counts_result not configured"))
        }

        async fn get_vote_counts_for_slide(
            &self,
            session_id: &str,
            slide_id: &str,
        ) -> Result<Vec<(String, String, i64)>> {
            let mut state = self.state.lock().await;
            state
                .get_vote_counts_for_slide_calls
                .push((session_id.to_string(), slide_id.to_string()));
            Ok(state
                .vote_counts_for_slide_result
                .clone()
                .expect("vote_counts_for_slide_result not configured"))
        }

        async fn get_sequences(&self, session_id: &str) -> Result<SessionSequences> {
            let mut state = self.state.lock().await;
            state.get_sequences_calls.push(session_id.to_string());
            Ok(state
                .sequences_result
                .clone()
                .expect("sequences_result not configured"))
        }
    }

    #[tokio::test]
    async fn create_session_trims_title_before_persisting() {
        let repo = MockSessionRepository::default();
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service
            .create_session("user-1", "  Quarterly Review  ", true, false)
            .await
            .expect("session creation should succeed");

        assert_eq!(result.title, "Quarterly Review");
        assert_eq!(result.creator_id, "user-1");
        assert_eq!(result.allow_questions, true);
        assert_eq!(result.require_name, false);
        assert_eq!(result.share_token.as_deref().map(str::len), Some(8));

        let state = repo.snapshot().await;
        assert_eq!(state.create_calls.len(), 1);
        assert_eq!(state.create_calls[0].title, "Quarterly Review");
        assert_eq!(state.create_calls[0].creator_id, "user-1");
        assert_eq!(state.create_calls[0].share_token.len(), 8);
    }

    #[tokio::test]
    async fn create_session_rejects_blank_title_without_repository_call() {
        let repo = MockSessionRepository::default();
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service.create_session("user-1", "   ", true, false).await;

        assert!(matches!(result, Err(AppError::Input(message)) if message.contains("empty")));

        let state = repo.snapshot().await;
        assert!(state.create_calls.is_empty());
        assert!(state.verify_ownership_calls.is_empty());
    }

    #[tokio::test]
    async fn update_session_trims_title_before_update() {
        let repo = MockSessionRepository::default();
        configure_repo(&repo, |state| {
            state.verify_ownership_result = Some(true);
            state.update_result = Some(build_session(
                "session-1",
                "user-1",
                "Quarterly Review",
                false,
                true,
            ));
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service
            .update_session(
                "session-1",
                "user-1",
                Some("  Quarterly Review  ".to_string()),
                Some(false),
                Some(true),
            )
            .await
            .expect("session update should succeed");

        assert_eq!(result.title, "Quarterly Review");
        assert_eq!(result.allow_questions, false);
        assert_eq!(result.require_name, true);

        let state = repo.snapshot().await;
        assert_eq!(
            state.verify_ownership_calls,
            vec![("session-1".to_string(), "user-1".to_string())]
        );
        assert_eq!(state.update_calls.len(), 1);
        assert_eq!(state.update_calls[0].0, "session-1");
        assert_eq!(
            state.update_calls[0].1.title.as_deref(),
            Some("Quarterly Review")
        );
        assert_eq!(state.update_calls[0].1.allow_questions, Some(false));
        assert_eq!(state.update_calls[0].1.require_name, Some(true));
    }

    #[tokio::test]
    async fn update_session_rejects_blank_title_after_ownership_check() {
        let repo = MockSessionRepository::default();
        configure_repo(&repo, |state| {
            state.verify_ownership_result = Some(true);
            state.update_result = Some(build_session("session-1", "user-1", "Unused", true, false));
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service
            .update_session("session-1", "user-1", Some("   ".to_string()), None, None)
            .await;

        assert!(matches!(result, Err(AppError::Input(message)) if message.contains("empty")));

        let state = repo.snapshot().await;
        assert_eq!(
            state.verify_ownership_calls,
            vec![("session-1".to_string(), "user-1".to_string())]
        );
        assert!(state.update_calls.is_empty());
    }

    #[tokio::test]
    async fn update_session_rejects_non_owner_before_update() {
        let repo = MockSessionRepository::default();
        configure_repo(&repo, |state| {
            state.verify_ownership_result = Some(false);
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service
            .update_session(
                "session-1",
                "intruder",
                Some("Quarterly Review".to_string()),
                Some(false),
                Some(true),
            )
            .await;

        assert!(matches!(result, Err(AppError::Auth(message)) if message.contains("Unauthorized")));

        let state = repo.snapshot().await;
        assert_eq!(
            state.verify_ownership_calls,
            vec![("session-1".to_string(), "intruder".to_string())]
        );
        assert!(state.update_calls.is_empty());
    }

    #[tokio::test]
    async fn duplicate_session_trims_original_title_and_preserves_flags() {
        let repo = MockSessionRepository::default();
        configure_repo(&repo, |state| {
            state.verify_ownership_result = Some(true);
            state.find_by_id_result = Some(Some(build_session(
                "session-1",
                "user-1",
                "  Team Retro  ",
                false,
                true,
            )));
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service
            .duplicate_session("session-1", "user-1")
            .await
            .expect("session duplication should succeed");

        assert_eq!(result.creator_id, "user-1");
        assert_eq!(result.title, "Team Retro (Copy)");
        assert_eq!(result.allow_questions, false);
        assert_eq!(result.require_name, true);

        let state = repo.snapshot().await;
        assert_eq!(
            state.verify_ownership_calls,
            vec![("session-1".to_string(), "user-1".to_string())]
        );
        assert_eq!(state.find_by_id_calls, vec!["session-1".to_string()]);
        assert_eq!(state.create_calls.len(), 1);
        assert_eq!(state.create_calls[0].title, "Team Retro (Copy)");
        assert_eq!(state.create_calls[0].allow_questions, false);
        assert_eq!(state.create_calls[0].require_name, true);
    }

    #[tokio::test]
    async fn get_public_session_attaches_vote_stats_to_matching_slides() {
        let repo = MockSessionRepository::default();
        let session = build_session("session-1", "user-1", "Public View", true, false);
        let slide_a = build_slide("slide-a", "session-1", 0);
        let slide_b = build_slide("slide-b", "session-1", 1);
        let question = build_question("question-1", "session-1", "What happens next?");
        let participant = build_participant("participant-1", "session-1", "Avery");
        let participant_b = build_participant("participant-2", "session-1", "Jordan");

        configure_repo(&repo, |state| {
            state.find_by_share_token_result = Some(Some(session.clone()));
            state.slides_result = Some(vec![slide_a.clone(), slide_b.clone()]);
            state.questions_result = Some(vec![question.clone()]);
            state.participants_result = Some(vec![participant.clone(), participant_b.clone()]);
            state.vote_counts_result = Some(vec![
                (slide_a.id.clone(), "opt-red".to_string(), 3),
                (slide_a.id.clone(), "opt-blue".to_string(), 1),
                ("orphan-slide".to_string(), "opt-green".to_string(), 7),
            ]);
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service
            .get_public_session("share-token")
            .await
            .expect("public session should load");

        assert_eq!(result.session.id, "session-1");
        assert_eq!(result.session.title, "Public View");
        assert_eq!(result.slides.len(), 2);
        assert_eq!(result.slides[0].slide.id, "slide-a");
        assert_eq!(
            result.slides[0]
                .stats
                .as_ref()
                .and_then(|stats| stats.votes.get("opt-red"))
                .copied(),
            Some(3)
        );
        assert_eq!(
            result.slides[0]
                .stats
                .as_ref()
                .and_then(|stats| stats.votes.get("opt-blue"))
                .copied(),
            Some(1)
        );
        assert!(result.slides[1].stats.is_none());
        assert_eq!(result.questions.len(), 1);
        assert_eq!(result.questions[0].id, "question-1");
        assert_eq!(result.questions[0].content, "What happens next?");
        assert_eq!(result.participants.len(), 2);
        assert_eq!(result.participants[0].name, "Avery");
        assert_eq!(result.participants[1].name, "Jordan");
    }

    #[tokio::test]
    async fn get_session_state_uses_state_header_and_nested_vote_counts() {
        let repo = MockSessionRepository::default();
        let slide_a = build_slide("slide-a", "session-1", 0);
        let slide_b = build_slide("slide-b", "session-1", 1);
        let question = build_question("question-1", "session-1", "When do we start?");

        configure_repo(&repo, |state| {
            state.state_header_result = Some(Some(SessionStateHeader {
                current_slide_id: Some("slide-b".to_string()),
                is_presentation_active: true,
                is_results_visible: true,
                state_version: 42,
                vote_sequence: 17,
                qa_sequence: 23,
            }));
            state.slides_result = Some(vec![slide_a.clone(), slide_b.clone()]);
            state.questions_result = Some(vec![question.clone()]);
            state.vote_counts_for_slide_result =
                Some(vec![(slide_b.id.clone(), "opt-green".to_string(), 9)]);
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service
            .get_session_state("session-1")
            .await
            .expect("session state should load");

        assert_eq!(result.current_slide_id.as_deref(), Some("slide-b"));
        assert_eq!(result.is_presentation_active, true);
        assert_eq!(result.is_results_visible, true);
        assert_eq!(result.state_version, 42);
        assert_eq!(result.vote_sequence, 17);
        assert_eq!(result.qa_sequence, 23);
        assert_eq!(result.slides.len(), 2);
        assert_eq!(result.questions.len(), 1);
        assert_eq!(result.vote_counts["slide-b"]["opt-green"], 9);

        let state = repo.snapshot().await;
        assert!(state.get_vote_counts_calls.is_empty());
        assert_eq!(
            state.get_vote_counts_for_slide_calls,
            vec![("session-1".to_string(), "slide-b".to_string())]
        );
    }

    #[tokio::test]
    async fn ensure_session_exists_uses_only_state_header() {
        let repo = MockSessionRepository::default();
        configure_repo(&repo, |state| {
            state.state_header_result = Some(Some(SessionStateHeader {
                current_slide_id: Some("slide-b".to_string()),
                is_presentation_active: true,
                is_results_visible: false,
                state_version: 42,
                vote_sequence: 17,
                qa_sequence: 23,
            }));
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        service
            .ensure_session_exists("session-1")
            .await
            .expect("session existence check should succeed");

        let state = repo.snapshot().await;
        assert_eq!(state.get_state_header_calls, vec!["session-1".to_string()]);
        assert!(state.get_slides_calls.is_empty());
        assert!(state.get_questions_calls.is_empty());
        assert!(state.get_vote_counts_calls.is_empty());
        assert!(state.get_vote_counts_for_slide_calls.is_empty());
        assert!(state.get_participants_calls.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn session_state_cache_builds_once_on_concurrent_miss() {
        let cache = SessionStateCache::new(Duration::from_secs(60), 8);
        let build_calls = Arc::new(AtomicUsize::new(0));

        let results = join_all((0..8).map(|_| {
            let cache = cache.clone();
            let build_calls = build_calls.clone();
            async move {
                cache
                    .get_or_build("session-1", || {
                        let build_calls = build_calls.clone();
                        async move {
                            build_calls.fetch_add(1, Ordering::SeqCst);
                            sleep(Duration::from_millis(50)).await;
                            Ok(build_state(99))
                        }
                    })
                    .await
            }
        }))
        .await;

        for result in results {
            let state = result.expect("cache build should succeed");
            assert_eq!(state.state_version, 99);
        }
        assert_eq!(build_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn session_state_cache_rebuilds_after_ttl_expires() {
        let cache = SessionStateCache::new(Duration::from_millis(30), 8);
        let build_calls = Arc::new(AtomicUsize::new(0));

        let first = cache
            .get_or_build("session-1", || {
                let build_calls = build_calls.clone();
                async move {
                    let build_number = build_calls.fetch_add(1, Ordering::SeqCst) + 1;
                    Ok(build_state(build_number as i64))
                }
            })
            .await
            .expect("first cache build should succeed");

        sleep(Duration::from_millis(50)).await;

        let second = cache
            .get_or_build("session-1", || {
                let build_calls = build_calls.clone();
                async move {
                    let build_number = build_calls.fetch_add(1, Ordering::SeqCst) + 1;
                    Ok(build_state(build_number as i64))
                }
            })
            .await
            .expect("second cache build should succeed");

        assert_eq!(first.state_version, 1);
        assert_eq!(second.state_version, 2);
        assert_eq!(build_calls.load(Ordering::SeqCst), 2);
    }

    // --- delete_session tests ---

    #[tokio::test]
    async fn delete_session_succeeds_for_owner() {
        let repo = MockSessionRepository::default();
        configure_repo(&repo, |state| {
            state.verify_ownership_result = Some(true);
            state.delete_result = Some(1);
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service.delete_session("session-1", "user-1").await;
        assert!(result.is_ok());

        let state = repo.snapshot().await;
        assert_eq!(
            state.verify_ownership_calls,
            vec![("session-1".to_string(), "user-1".to_string())]
        );
        assert_eq!(state.delete_calls, vec!["session-1".to_string()]);
    }

    #[tokio::test]
    async fn delete_session_rejects_non_owner() {
        let repo = MockSessionRepository::default();
        configure_repo(&repo, |state| {
            state.verify_ownership_result = Some(false);
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service.delete_session("session-1", "intruder").await;
        assert!(matches!(result, Err(AppError::Auth(msg)) if msg.contains("Unauthorized")));

        let state = repo.snapshot().await;
        assert_eq!(state.delete_calls.len(), 0);
    }

    #[tokio::test]
    async fn delete_session_returns_not_found_when_no_rows_deleted() {
        let repo = MockSessionRepository::default();
        configure_repo(&repo, |state| {
            state.verify_ownership_result = Some(true);
            state.delete_result = Some(0);
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service.delete_session("session-1", "user-1").await;
        assert!(
            matches!(result, Err(AppError::NotFound(msg)) if msg.contains("Session not found"))
        );
    }

    // --- archive_session tests ---

    #[tokio::test]
    async fn archive_session_succeeds_for_owner() {
        let repo = MockSessionRepository::default();
        configure_repo(&repo, |state| {
            state.verify_ownership_result = Some(true);
            state.update_result = Some(build_session(
                "session-1",
                "user-1",
                "My Session",
                true,
                false,
            ));
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service.archive_session("session-1", "user-1").await;
        assert!(result.is_ok());

        let state = repo.snapshot().await;
        assert_eq!(
            state.verify_ownership_calls,
            vec![("session-1".to_string(), "user-1".to_string())]
        );
        assert_eq!(state.update_calls.len(), 1);
        assert_eq!(state.update_calls[0].1.status, Some("archived".to_string()));
        assert_eq!(state.update_calls[0].1.title, None);
    }

    #[tokio::test]
    async fn archive_session_rejects_non_owner() {
        let repo = MockSessionRepository::default();
        configure_repo(&repo, |state| {
            state.verify_ownership_result = Some(false);
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service.archive_session("session-1", "intruder").await;
        assert!(matches!(result, Err(AppError::Auth(msg)) if msg.contains("Unauthorized")));

        let state = repo.snapshot().await;
        assert!(state.update_calls.is_empty());
    }

    // --- restore_session tests ---

    #[tokio::test]
    async fn restore_session_succeeds_for_owner() {
        let repo = MockSessionRepository::default();
        configure_repo(&repo, |state| {
            state.verify_ownership_result = Some(true);
            state.update_result = Some(build_session(
                "session-1",
                "user-1",
                "My Session",
                true,
                false,
            ));
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service.restore_session("session-1", "user-1").await;
        assert!(result.is_ok());

        let state = repo.snapshot().await;
        assert_eq!(
            state.verify_ownership_calls,
            vec![("session-1".to_string(), "user-1".to_string())]
        );
        assert_eq!(state.update_calls.len(), 1);
        assert_eq!(state.update_calls[0].1.status, Some("draft".to_string()));
        assert_eq!(state.update_calls[0].1.title, None);
    }

    #[tokio::test]
    async fn restore_session_rejects_non_owner() {
        let repo = MockSessionRepository::default();
        configure_repo(&repo, |state| {
            state.verify_ownership_result = Some(false);
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service.restore_session("session-1", "intruder").await;
        assert!(matches!(result, Err(AppError::Auth(msg)) if msg.contains("Unauthorized")));

        let state = repo.snapshot().await;
        assert!(state.update_calls.is_empty());
    }

    // --- get_session tests ---

    #[tokio::test]
    async fn get_session_succeeds_for_owner() {
        let repo = MockSessionRepository::default();
        let session = build_session("session-1", "user-1", "My Session", true, false);
        configure_repo(&repo, |state| {
            state.find_by_id_result = Some(Some(session));
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service.get_session("session-1", "user-1").await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().id, "session-1");

        let state = repo.snapshot().await;
        assert_eq!(state.find_by_id_calls, vec!["session-1".to_string()]);
    }

    #[tokio::test]
    async fn get_session_returns_not_found_when_session_missing() {
        let repo = MockSessionRepository::default();
        configure_repo(&repo, |state| {
            state.find_by_id_result = Some(None);
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service.get_session("session-1", "user-1").await;
        assert!(
            matches!(result, Err(AppError::NotFound(msg)) if msg.contains("Session not found"))
        );
    }

    #[tokio::test]
    async fn get_session_returns_unauthorized_for_non_owner() {
        let repo = MockSessionRepository::default();
        let session = build_session("session-1", "other-user", "My Session", true, false);
        configure_repo(&repo, |state| {
            state.find_by_id_result = Some(Some(session));
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service.get_session("session-1", "intruder").await;
        assert!(matches!(result, Err(AppError::Auth(msg)) if msg.contains("Unauthorized")));
    }

    // --- get_user_sessions tests ---

    #[tokio::test]
    async fn get_user_sessions_returns_empty_vec_when_no_sessions() {
        let repo = MockSessionRepository::default();
        configure_repo(&repo, |state| {
            state.find_by_creator_result = Some(vec![]);
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service.get_user_sessions("user-1").await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());

        let state = repo.snapshot().await;
        assert_eq!(state.find_by_creator_calls, vec!["user-1".to_string()]);
    }

    #[tokio::test]
    async fn get_user_sessions_returns_multiple_sessions() {
        let repo = MockSessionRepository::default();
        let sessions = vec![
            build_session("session-1", "user-1", "Session A", true, false),
            build_session("session-2", "user-1", "Session B", false, true),
        ];
        configure_repo(&repo, |state| {
            state.find_by_creator_result = Some(sessions);
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service.get_user_sessions("user-1").await;
        assert!(result.is_ok());
        let sessions = result.unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].title, "Session A");
        assert_eq!(sessions[1].title, "Session B");
    }

    // --- get_user_sessions_with_slide_count tests ---

    #[tokio::test]
    async fn get_user_sessions_with_slide_count_returns_empty_when_no_sessions() {
        let repo = MockSessionRepository::default();
        configure_repo(&repo, |state| {
            state.find_by_creator_with_slide_count_result = Some(vec![]);
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service.get_user_sessions_with_slide_count("user-1").await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());

        let state = repo.snapshot().await;
        assert_eq!(
            state.find_by_creator_with_slide_count_calls,
            vec!["user-1".to_string()]
        );
    }

    #[tokio::test]
    async fn get_user_sessions_with_slide_count_aggregates_correctly() {
        let repo = MockSessionRepository::default();
        let session_a = build_session("session-1", "user-1", "Session A", true, false);
        let session_b = build_session("session-2", "user-1", "Session B", false, true);
        configure_repo(&repo, |state| {
            state.find_by_creator_with_slide_count_result =
                Some(vec![(session_a, 3), (session_b, 0)]);
        })
        .await;
        let service = build_service(&repo, Duration::from_secs(60));

        let result = service.get_user_sessions_with_slide_count("user-1").await;
        assert!(result.is_ok());
        let with_counts = result.unwrap();
        assert_eq!(with_counts.len(), 2);
        assert_eq!(with_counts[0].session.title, "Session A");
        assert_eq!(with_counts[0].slide_count, 3);
        assert_eq!(with_counts[1].session.title, "Session B");
        assert_eq!(with_counts[1].slide_count, 0);
    }
}
