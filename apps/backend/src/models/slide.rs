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
}

#[derive(Debug, Deserialize)]
pub struct CreateSlideRequest {
    #[serde(rename = "type")]
    pub slide_type: String,
    pub content: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSlideRequest {
    #[serde(rename = "type")]
    pub slide_type: Option<String>,
    pub content: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderSlidesRequest {
    pub slide_ids: Vec<String>,
}
