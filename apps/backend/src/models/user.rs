use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Serialize, Deserialize, FromRow, Clone)]
pub struct User {
    pub id: String,
    pub email: String,
    #[serde(skip)]
    pub password_hash: String,
    pub name: String,
    pub role: String,
    pub created_at: Option<DateTime<Utc>>,
}
