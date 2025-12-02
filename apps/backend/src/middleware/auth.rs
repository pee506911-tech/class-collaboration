use axum::{
    async_trait,
    extract::FromRequestParts,
    http::{header::AUTHORIZATION, request::Parts},
    Extension,
    RequestPartsExt,
};
use axum_extra::extract::cookie::CookieJar;
use jsonwebtoken::{decode, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::config::Config;
use crate::error::AppError;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    #[serde(rename = "userId")]
    pub user_id: String,
    pub role: String,
    pub exp: usize,
}

pub struct AuthUser {
    pub user_id: String,
    pub role: String,
}

#[async_trait]
impl<S> FromRequestParts<S> for AuthUser
where
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        // Extract config first to satisfy borrow checker
        let Extension(config) = parts
            .extract::<Extension<Arc<Config>>>()
            .await
            .map_err(|_| AppError::Internal("Config missing".to_string()))?;

        let jar = parts
            .extract::<CookieJar>()
            .await
            .map_err(|_| AppError::Internal("Cookie extraction failed".to_string()))?;

        let token = if let Some(cookie) = jar.get("token") {
            cookie.value().to_string()
        } else {
            let auth_header = parts
                .headers
                .get(AUTHORIZATION)
                .ok_or_else(|| AppError::Auth("Missing authorization".to_string()))?;

            let auth_str = auth_header
                .to_str()
                .map_err(|_| AppError::Auth("Invalid authorization header".to_string()))?;

            if !auth_str.starts_with("Bearer ") {
                return Err(AppError::Auth("Invalid token format".to_string()));
            }

            auth_str[7..].to_string()
        };

        let token_data = decode::<Claims>(
            &token,
            &DecodingKey::from_secret(config.jwt_secret.as_bytes()),
            &Validation::default(),
        )?;

        Ok(AuthUser {
            user_id: token_data.claims.user_id,
            role: token_data.claims.role,
        })
    }
}
