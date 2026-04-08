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
    pub slide_type: Option<String>,
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
