use axum::{
    http::{HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("Authentication failed: {0}")]
    Auth(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Invalid input: {0}")]
    Input(String),

    #[error("Internal server error: {0}")]
    Internal(String),

    #[error("Conflict: {message}")]
    Conflict {
        message: String,
        data: Option<serde_json::Value>,
    },

    #[error("Hash error: {0}")]
    Hash(#[from] bcrypt::BcryptError),

    #[error("JWT error: {0}")]
    Jwt(#[from] jsonwebtoken::errors::Error),

    #[error("Migration error: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),

    #[error("Service unavailable: {0}")]
    ServiceUnavailable(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message, data) = match self {
            AppError::Database(e) => {
                tracing::error!("Database error: {:?}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Database error".to_string(),
                    None,
                )
            }
            AppError::Auth(msg) => (StatusCode::UNAUTHORIZED, msg, None),
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg, None),
            AppError::Input(msg) => (StatusCode::BAD_REQUEST, msg, None),
            AppError::Internal(msg) => {
                tracing::error!("Internal error: {}", msg);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                    None,
                )
            }
            AppError::Conflict { message, data } => (StatusCode::CONFLICT, message, data),
            AppError::Hash(e) => {
                tracing::error!("Hash error: {:?}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                    None,
                )
            }
            AppError::Jwt(e) => {
                tracing::error!("JWT error: {:?}", e);
                (StatusCode::UNAUTHORIZED, "Invalid token".to_string(), None)
            }
            AppError::Migration(e) => {
                tracing::error!("Migration error: {:?}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Database migration failed".to_string(),
                    None,
                )
            }
            AppError::ServiceUnavailable(msg) => {
                tracing::warn!("Service unavailable: {}", msg);
                let body = Json(json!({
                    "success": false,
                    "error": msg,
                    "data": null
                }));
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    [(
                        HeaderName::from_static("retry-after"),
                        HeaderValue::from_static("5"),
                    )],
                    body,
                )
                    .into_response();
            }
        };

        let body = Json(json!({
            "success": false,
            "error": message,
            "data": data
        }));

        (status, body).into_response()
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
