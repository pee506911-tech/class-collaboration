use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use chrono::{DateTime, Utc};

#[derive(Debug, Serialize, Deserialize, FromRow, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    #[serde(rename = "creatorId")]
    #[sqlx(rename = "creator_id")]
    pub creator_id: String,
    pub title: String,
    pub status: String,
    #[serde(rename = "shareToken")]
    #[sqlx(rename = "share_token")]
    pub share_token: Option<String>,
    #[serde(rename = "currentSlideId")]
    #[sqlx(rename = "current_slide_id")]
    pub current_slide_id: Option<String>,
    #[serde(rename = "isResultsVisible")]
    #[sqlx(rename = "is_results_visible")]
    pub is_results_visible: bool,
    #[serde(rename = "isPresentationActive")]
    #[sqlx(rename = "is_presentation_active")]
    pub is_presentation_active: bool,
    #[serde(rename = "allowQuestions")]
    #[sqlx(rename = "allow_questions")]
    pub allow_questions: bool,
    #[serde(rename = "requireName")]
    #[sqlx(rename = "require_name")]
    pub require_name: bool,
    #[serde(rename = "createdAt")]
    #[sqlx(rename = "created_at")]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(rename = "updatedAt")]
    #[sqlx(rename = "updated_at")]
    pub updated_at: Option<DateTime<Utc>>,
}

/// Session with slide count for dashboard listing
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionWithSlideCount {
    #[serde(flatten)]
    pub session: Session,
    pub slide_count: i64,
}

use crate::models::slide::Slide;
use crate::models::student::{Question, Participant};

/// Vote stats for a slide
#[derive(Serialize, Deserialize, Clone)]
pub struct VoteStats {
    pub votes: std::collections::HashMap<String, i32>,
}

/// Slide with stats for public view
#[derive(Serialize, Deserialize, Clone)]
pub struct SlideWithStats {
    #[serde(flatten)]
    pub slide: Slide,
    pub stats: Option<VoteStats>,
}

/// Session with slides and questions for public view
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PublicSessionResponse {
    #[serde(flatten)]
    pub session: Session,
    pub slides: Vec<SlideWithStats>,
    pub questions: Vec<Question>,
    pub participants: Vec<Participant>,
}

/// Session state for real-time sync
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub current_slide_id: Option<String>,
    pub is_presentation_active: bool,
    pub is_results_visible: bool,
    pub slides: Vec<Slide>,
    pub questions: Vec<Question>,
    pub vote_counts: std::collections::HashMap<String, std::collections::HashMap<String, i32>>,
}
