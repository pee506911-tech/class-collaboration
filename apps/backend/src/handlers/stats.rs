use axum::{extract::{State, Path}, Json};
use serde::Serialize;
use sqlx::{query_as, FromRow};
use std::collections::HashMap;
use chrono::{DateTime, Utc};

use crate::error::{AppError, Result};
use crate::models::session::Session;
use crate::models::slide::Slide;
use crate::middleware::auth::AuthUser;

#[derive(Debug, Serialize)]
pub struct Participant {
    pub id: String,
    pub name: String,
    #[serde(rename = "joinedAt")]
    pub joined_at: String,
}

#[derive(Debug, FromRow)]
struct DbParticipant {
    id: String,
    name: String,
    joined_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct SlideInteraction {
    pub name: String,
    pub answer: String,
    #[serde(rename = "textAnswer", skip_serializing_if = "Option::is_none")]
    pub text_answer: Option<String>,
    #[serde(rename = "answeredAt")]
    pub answered_at: String,
}

#[derive(Debug, Serialize)]
pub struct SlideStats {
    pub id: String,
    #[serde(rename = "type")]
    pub slide_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<SlideOption>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub votes: Option<HashMap<String, i32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interactions: Option<Vec<SlideInteraction>>,
}

#[derive(Debug, Serialize)]
pub struct SlideOption {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct Question {
    pub id: String,
    pub content: String,
    pub upvotes: i32,
    pub author: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "slideId")]
    pub slide_id: Option<String>,
}

#[derive(Debug, FromRow)]
struct DbQuestion {
    id: String,
    content: String,
    upvotes: i32,
    participant_id: String,
    created_at: Option<DateTime<Utc>>,
    slide_id: Option<String>,
}

#[derive(Debug, FromRow)]
struct DbQuestionWithAuthor {
    id: String,
    content: String,
    upvotes: i32,
    #[allow(dead_code)]
    participant_id: String,
    created_at: Option<DateTime<Utc>>,
    author_name: String,
    slide_id: Option<String>,
}

#[derive(Debug, FromRow)]
struct VoteCount {
    slide_id: String,
    option_id: String,
    count: i64,
}

#[derive(Debug, FromRow)]
struct VoteInteraction {
    slide_id: String,
    option_id: String,
    participant_name: String,
    created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct SessionStats {
    pub participants: Vec<Participant>,
    pub slides: Vec<SlideStats>,
    pub questions: Vec<Question>,
}

/// Get session stats (authenticated - for session owner)
pub async fn get_session_stats(
    State(app_state): State<crate::AppState>,
    AuthUser { user_id, .. }: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<SessionStats>> {
    // Verify session exists and user owns it
    let session = query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
        .bind(&id)
        .fetch_optional(&app_state.db_pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;

    if session.creator_id != user_id {
        return Err(AppError::Auth("Unauthorized access to session".to_string()));
    }

    // Get slides for this session
    let slides = query_as::<_, Slide>(
        "SELECT * FROM slides WHERE session_id = ? ORDER BY order_index"
    )
    .bind(&id)
    .fetch_all(&app_state.db_pool)
    .await?;

    // Get vote counts per slide and option
    let vote_counts: Vec<VoteCount> = sqlx::query_as(
        "SELECT slide_id, option_id, COUNT(*) as count FROM votes WHERE session_id = ? GROUP BY slide_id, option_id"
    )
    .bind(&id)
    .fetch_all(&app_state.db_pool)
    .await
    .unwrap_or_default();

    // Get vote interactions with participant names
    let vote_interactions: Vec<VoteInteraction> = sqlx::query_as(
        "SELECT v.slide_id, v.option_id, COALESCE(p.name, 'Anonymous') as participant_name, v.created_at 
         FROM votes v 
         LEFT JOIN participants p ON v.participant_id = p.id AND v.session_id = p.session_id
         WHERE v.session_id = ?
         ORDER BY v.created_at DESC"
    )
    .bind(&id)
    .fetch_all(&app_state.db_pool)
    .await
    .unwrap_or_default();

    // Build vote maps
    let mut vote_map: HashMap<String, HashMap<String, i32>> = HashMap::new();
    for vc in vote_counts {
        vote_map
            .entry(vc.slide_id)
            .or_insert_with(HashMap::new)
            .insert(vc.option_id, vc.count as i32);
    }

    // Build interaction maps
    let mut interaction_map: HashMap<String, Vec<SlideInteraction>> = HashMap::new();
    for vi in vote_interactions {
        interaction_map
            .entry(vi.slide_id.clone())
            .or_insert_with(Vec::new)
            .push(SlideInteraction {
                name: vi.participant_name,
                answer: vi.option_id,
                text_answer: None,
                answered_at: vi.created_at.map(|dt| dt.to_rfc3339()).unwrap_or_default(),
            });
    }

    // Convert slides to SlideStats
    let slide_stats: Vec<SlideStats> = slides.into_iter().map(|slide| {
        let content = slide.content.0;
        
        // Extract question text from content
        let question = content.get("question")
            .and_then(|q| q.as_str())
            .map(|s| s.to_string());
        
        // Extract options from content
        let options = content.get("options")
            .and_then(|opts| opts.as_array())
            .map(|arr| {
                arr.iter().filter_map(|opt| {
                    let id = opt.get("id").and_then(|v| v.as_str())?;
                    let text = opt.get("text").and_then(|v| v.as_str())?;
                    Some(SlideOption {
                        id: id.to_string(),
                        text: text.to_string(),
                    })
                }).collect()
            });

        let votes = vote_map.get(&slide.id).cloned();
        let interactions = interaction_map.remove(&slide.id);

        SlideStats {
            id: slide.id,
            slide_type: slide.slide_type,
            question,
            options,
            votes: Some(votes.unwrap_or_default()),
            interactions: Some(interactions.unwrap_or_default()),
        }
    }).collect();

    // Get participants
    let db_participants: Vec<DbParticipant> = sqlx::query_as(
        "SELECT id, name, joined_at FROM participants WHERE session_id = ? ORDER BY joined_at DESC"
    )
    .bind(&id)
    .fetch_all(&app_state.db_pool)
    .await
    .unwrap_or_default();

    let participants: Vec<Participant> = db_participants.into_iter().map(|p| Participant {
        id: p.id,
        name: p.name,
        joined_at: p.joined_at.map(|dt| dt.to_rfc3339()).unwrap_or_default(),
    }).collect();

    // Get questions with author names in a single query (fixes N+1)
    let questions: Vec<Question> = sqlx::query_as::<_, DbQuestionWithAuthor>(
        "SELECT q.id, q.content, q.upvotes, q.participant_id, q.created_at, q.slide_id,
                COALESCE(p.name, 'Anonymous') as author_name
         FROM questions q 
         LEFT JOIN participants p ON q.participant_id = p.id AND q.session_id = p.session_id
         WHERE q.session_id = ? 
         ORDER BY q.upvotes DESC, q.created_at DESC"
    )
    .bind(&id)
    .fetch_all(&app_state.db_pool)
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|q| Question {
        id: q.id,
        content: q.content,
        upvotes: q.upvotes,
        author: q.author_name,
        created_at: q.created_at.map(|dt| dt.to_rfc3339()).unwrap_or_default(),
        slide_id: q.slide_id,
    })
    .collect();

    Ok(Json(SessionStats {
        participants,
        slides: slide_stats,
        questions,
    }))
}

/// Get public session stats (for shared sessions)
pub async fn get_public_session_stats(
    State(app_state): State<crate::AppState>,
    Path(id): Path<String>,
) -> Result<Json<SessionStats>> {
    // Verify session exists
    let _session = query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
        .bind(&id)
        .fetch_optional(&app_state.db_pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;

    // Get slides for this session (only non-hidden)
    let slides = query_as::<_, Slide>(
        "SELECT * FROM slides WHERE session_id = ? AND is_hidden = FALSE ORDER BY order_index"
    )
    .bind(&id)
    .fetch_all(&app_state.db_pool)
    .await?;

    // Get vote counts per slide and option
    let vote_counts: Vec<VoteCount> = sqlx::query_as(
        "SELECT slide_id, option_id, COUNT(*) as count FROM votes WHERE session_id = ? GROUP BY slide_id, option_id"
    )
    .bind(&id)
    .fetch_all(&app_state.db_pool)
    .await
    .unwrap_or_default();

    // Get vote interactions with participant names for public dashboard
    let vote_interactions: Vec<VoteInteraction> = sqlx::query_as(
        "SELECT v.slide_id, v.option_id, COALESCE(p.name, 'Anonymous') as participant_name, v.created_at 
         FROM votes v 
         LEFT JOIN participants p ON v.participant_id = p.id AND v.session_id = p.session_id
         WHERE v.session_id = ?
         ORDER BY v.created_at DESC"
    )
    .bind(&id)
    .fetch_all(&app_state.db_pool)
    .await
    .unwrap_or_default();

    // Build vote maps
    let mut vote_map: HashMap<String, HashMap<String, i32>> = HashMap::new();
    for vc in vote_counts {
        vote_map
            .entry(vc.slide_id)
            .or_insert_with(HashMap::new)
            .insert(vc.option_id, vc.count as i32);
    }

    // Build interaction maps
    let mut interaction_map: HashMap<String, Vec<SlideInteraction>> = HashMap::new();
    for vi in vote_interactions {
        interaction_map
            .entry(vi.slide_id.clone())
            .or_insert_with(Vec::new)
            .push(SlideInteraction {
                name: vi.participant_name,
                answer: vi.option_id,
                text_answer: None,
                answered_at: vi.created_at.map(|dt| dt.to_rfc3339()).unwrap_or_default(),
            });
    }

    // Convert slides to SlideStats
    let slide_stats: Vec<SlideStats> = slides.into_iter().map(|slide| {
        let content = slide.content.0;
        
        let question = content.get("question")
            .and_then(|q| q.as_str())
            .map(|s| s.to_string());
        
        let options = content.get("options")
            .and_then(|opts| opts.as_array())
            .map(|arr| {
                arr.iter().filter_map(|opt| {
                    let id = opt.get("id").and_then(|v| v.as_str())?;
                    let text = opt.get("text").and_then(|v| v.as_str())?;
                    Some(SlideOption {
                        id: id.to_string(),
                        text: text.to_string(),
                    })
                }).collect()
            });

        let votes = vote_map.get(&slide.id).cloned();
        let interactions = interaction_map.remove(&slide.id);

        SlideStats {
            id: slide.id,
            slide_type: slide.slide_type,
            question,
            options,
            votes: Some(votes.unwrap_or_default()),
            interactions: Some(interactions.unwrap_or_default()), // Now include interactions for public dashboard
        }
    }).collect();

    // Get participants
    let db_participants: Vec<DbParticipant> = sqlx::query_as(
        "SELECT id, name, joined_at FROM participants WHERE session_id = ? ORDER BY joined_at DESC"
    )
    .bind(&id)
    .fetch_all(&app_state.db_pool)
    .await
    .unwrap_or_default();

    let participants: Vec<Participant> = db_participants.into_iter().map(|p| Participant {
        id: p.id,
        name: p.name,
        joined_at: p.joined_at.map(|dt| dt.to_rfc3339()).unwrap_or_default(),
    }).collect();

    // Get questions with author names
    let questions: Vec<Question> = sqlx::query_as::<_, DbQuestionWithAuthor>(
        "SELECT q.id, q.content, q.upvotes, q.participant_id, q.created_at, q.slide_id,
                COALESCE(p.name, 'Anonymous') as author_name
         FROM questions q 
         LEFT JOIN participants p ON q.participant_id = p.id AND q.session_id = p.session_id
         WHERE q.session_id = ? 
         ORDER BY q.upvotes DESC, q.created_at DESC"
    )
    .bind(&id)
    .fetch_all(&app_state.db_pool)
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|q| Question {
        id: q.id,
        content: q.content,
        upvotes: q.upvotes,
        author: q.author_name,
        created_at: q.created_at.map(|dt| dt.to_rfc3339()).unwrap_or_default(),
        slide_id: q.slide_id,
    })
    .collect();

    Ok(Json(SessionStats {
        participants,
        slides: slide_stats,
        questions,
    }))
}
