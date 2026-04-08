use crate::error::{AppError, Result};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

/// Operation types tracked for idempotency via `client_request_id`.
/// Each handler records its response to `wal_request_replays` so that
/// retried requests with the same `client_request_id` return the original
/// response instead of executing the mutation twice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WalOpType {
    CreateSlide,
    UpdateSlide,
    DeleteSlide,
    ReorderSlides,
    CreateSlidesBatch,
    UpdateSlidesBatch,
    SubmitVote,
    SubmitQuestion,
    UpvoteQuestion,
}

impl WalOpType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CreateSlide => "create_slide",
            Self::UpdateSlide => "update_slide",
            Self::DeleteSlide => "delete_slide",
            Self::ReorderSlides => "reorder_slides",
            Self::CreateSlidesBatch => "create_slides_batch",
            Self::UpdateSlidesBatch => "update_slides_batch",
            Self::SubmitVote => "submit_vote",
            Self::SubmitQuestion => "submit_question",
            Self::UpvoteQuestion => "upvote_question",
        }
    }
}

impl std::fmt::Display for WalOpType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for WalOpType {
    type Err = AppError;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "create_slide" => Ok(Self::CreateSlide),
            "update_slide" => Ok(Self::UpdateSlide),
            "delete_slide" => Ok(Self::DeleteSlide),
            "reorder_slides" => Ok(Self::ReorderSlides),
            "create_slides_batch" => Ok(Self::CreateSlidesBatch),
            "submit_vote" => Ok(Self::SubmitVote),
            "submit_question" => Ok(Self::SubmitQuestion),
            "upvote_question" => Ok(Self::UpvoteQuestion),
            _ => Err(AppError::Internal(format!("Unknown WAL op type: {value}"))),
        }
    }
}

/// Fetch a previously stored replay response for idempotent request handling.
/// Returns `Some(T)` if a response was already recorded for the given
/// `(session_id, op_type, client_request_id)` tuple.
pub async fn fetch_replay_response<T: DeserializeOwned>(
    pool: &crate::db::DbPool,
    session_id: &str,
    op_type: WalOpType,
    client_request_id: &str,
) -> Result<Option<T>> {
    let response_payload: Option<sqlx::types::Json<serde_json::Value>> = sqlx::query_scalar(
        "SELECT response_payload
         FROM wal_request_replays
         WHERE session_id = ? AND op_type = ? AND client_request_id = ?
         LIMIT 1",
    )
    .bind(session_id)
    .bind(op_type.to_string())
    .bind(client_request_id)
    .fetch_optional(pool)
    .await?;

    response_payload
        .map(|json| {
            serde_json::from_value(json.0).map_err(|error| {
                AppError::Internal(format!("Failed to decode replay response payload: {error}"))
            })
        })
        .transpose()
}

/// Return a successful API response wrapped in the standard idempotent
/// response envelope. Used when a request was already processed.
pub fn queued_success_response<T>(value: &T) -> axum::Json<crate::models::response::ApiResponse<T>>
where
    T: serde::Serialize + Clone,
{
    axum::Json(crate::models::response::ApiResponse::success(value.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wal_op_type_roundtrip() {
        for op in [
            WalOpType::CreateSlide,
            WalOpType::UpdateSlide,
            WalOpType::DeleteSlide,
            WalOpType::ReorderSlides,
            WalOpType::CreateSlidesBatch,
            WalOpType::SubmitVote,
            WalOpType::SubmitQuestion,
            WalOpType::UpvoteQuestion,
        ] {
            let s = op.to_string();
            let parsed: WalOpType = s.parse().unwrap();
            assert_eq!(op, parsed);
        }
    }
}
