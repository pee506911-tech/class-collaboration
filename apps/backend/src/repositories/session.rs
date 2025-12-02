use async_trait::async_trait;
use crate::error::Result;
use crate::models::session::Session;

/// Repository trait - defines the contract for data access
/// The Application Layer depends on this trait, not the implementation
#[async_trait]
pub trait SessionRepository: Send + Sync {
    async fn find_by_creator(&self, creator_id: &str) -> Result<Vec<Session>>;
    async fn find_by_creator_with_slide_count(&self, creator_id: &str) -> Result<Vec<(Session, i64)>>;
    async fn find_by_id(&self, id: &str) -> Result<Option<Session>>;
    async fn find_by_share_token(&self, token: &str) -> Result<Option<Session>>;
    async fn create(&self, session: &NewSession) -> Result<Session>;
    async fn update(&self, id: &str, updates: &SessionUpdates) -> Result<Session>;
    async fn delete(&self, id: &str) -> Result<u64>;
    async fn verify_ownership(&self, session_id: &str, user_id: &str) -> Result<bool>;
    
    // Related data methods
    async fn get_slides(&self, session_id: &str) -> Result<Vec<crate::models::slide::Slide>>;
    async fn get_questions(&self, session_id: &str) -> Result<Vec<crate::models::student::Question>>;
    async fn get_participants(&self, session_id: &str) -> Result<Vec<crate::models::student::Participant>>;
    async fn get_vote_counts(&self, session_id: &str) -> Result<Vec<(String, String, i64)>>; // (slide_id, option_id, count)
}

/// DTO for creating a new session
#[derive(Debug, Clone)]
pub struct NewSession {
    pub id: String,
    pub creator_id: String,
    pub title: String,
    pub share_token: String,
    pub allow_questions: bool,
    pub require_name: bool,
}

/// DTO for updating a session
#[derive(Debug, Clone, Default)]
pub struct SessionUpdates {
    pub title: Option<String>,
    pub status: Option<String>,
    pub allow_questions: Option<bool>,
    pub require_name: Option<bool>,
}
