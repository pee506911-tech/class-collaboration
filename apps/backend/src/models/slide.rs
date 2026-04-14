use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Serialize, Deserialize, FromRow, Clone)]
pub struct Slide {
    pub id: String,
    #[serde(rename = "sessionId")]
    #[sqlx(rename = "session_id")]
    pub session_id: String,
    #[sqlx(rename = "type")]
    #[serde(rename = "type")]
    pub slide_type: String,
    pub content: sqlx::types::Json<serde_json::Value>,
    #[serde(rename = "orderIndex")]
    #[sqlx(rename = "order_index")]
    pub order_index: i32,
    #[serde(rename = "isHidden")]
    #[sqlx(rename = "is_hidden")]
    pub is_hidden: bool,
    pub version: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSlideRequest {
    #[serde(rename = "type")]
    pub slide_type: String,
    pub content: serde_json::Value,
    pub insert_after_slide_id: Option<String>,
    pub client_request_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSlideRequest {
    #[serde(rename = "type")]
    pub slide_type: Option<String>,
    pub content: Option<serde_json::Value>,
    pub base_version: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderSlidesRequest {
    pub slide_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum SlideOperation {
    Create {
        #[serde(rename = "tempId")]
        temp_id: String,
        #[serde(rename = "type")]
        slide_type: String,
        content: serde_json::Value,
        #[serde(rename = "isHidden", default)]
        is_hidden: bool,
        #[serde(rename = "insertAfterSlideId")]
        insert_after_slide_id: Option<String>,
    },
    Update {
        #[serde(rename = "slideId")]
        slide_id: String,
        #[serde(rename = "type")]
        slide_type: Option<String>,
        content: Option<serde_json::Value>,
        #[serde(rename = "isHidden")]
        is_hidden: Option<bool>,
        #[serde(rename = "baseVersion")]
        base_version: Option<i64>,
    },
    Move {
        #[serde(rename = "slideId")]
        slide_id: String,
        #[serde(rename = "insertAfterSlideId")]
        insert_after_slide_id: Option<String>,
    },
    Delete {
        #[serde(rename = "slideId")]
        slide_id: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplySlideOperationsRequest {
    pub operations: Vec<SlideOperation>,
    pub client_request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSlidesBatchRequest {
    pub slides: Vec<CreateSlideRequest>,
    pub client_request_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreateSlidesBatchResponse {
    pub slides: Vec<Slide>,
    pub state_version: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchSlideUpdate {
    pub slide_id: String,
    pub content: serde_json::Value,
    #[serde(rename = "type")]
    #[allow(dead_code)]
    pub slide_type: Option<String>,
    pub is_hidden: Option<bool>,
    pub base_version: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSlidesBatchRequest {
    pub updates: Vec<BatchSlideUpdate>,
    pub client_request_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSlidesBatchResponse {
    pub slides: Vec<Slide>,
    pub state_version: i64,
}

/// Full slide sync — send the entire desired slide state in one request.
/// Slides with `id = None` are created; existing slides are updated;
/// existing slides not in the list are deleted.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSlidesRequest {
    /// Complete desired slide list in desired order.
    /// `id = None` means "create new slide".
    /// `id = Some(...)` means "update or keep this slide".
    /// Slides existing on the server but absent from this list will be deleted.
    pub slides: Vec<SyncSlideEntry>,
    /// Optional base version map for optimistic concurrency control.
    /// Key = slide_id, Value = expected version. If provided and a slide's
    /// server version differs, the entire sync is rejected with 409.
    #[serde(default)]
    pub base_versions: Option<std::collections::HashMap<String, i64>>,
    pub client_request_id: Option<String>,
}

/// A single slide entry within a sync request.
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncSlideEntry {
    /// `None` = new slide (server will assign an id).
    /// `Some(id)` = existing slide to update or keep.
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub slide_type: String,
    pub content: serde_json::Value,
    #[serde(default)]
    pub is_hidden: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncSlidesResponse {
    pub slides: Vec<Slide>,
    pub state_version: i64,
}
