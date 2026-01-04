use axum::{extract::{State, Extension}, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::query_as;
use bcrypt::{hash, verify, DEFAULT_COST};
use jsonwebtoken::{encode, EncodingKey, Header};
use uuid::Uuid;
use std::sync::Arc;
use chrono::{Utc, Duration};


use crate::error::{AppError, Result};
use crate::models::user::User;
use crate::config::Config;
use crate::middleware::auth::Claims;

use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};

// Input validation constants
const MAX_EMAIL_LENGTH: usize = 255;
const MAX_PASSWORD_LENGTH: usize = 128;
const MIN_PASSWORD_LENGTH: usize = 8;
const MAX_NAME_LENGTH: usize = 100;

#[derive(Deserialize)]
pub struct RegisterRequest {
    email: String,
    password: String,
    name: String,
    role: Option<String>,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    email: String,
    password: String,
}

#[derive(Serialize)]
pub struct AuthResponse {
    success: bool,
    token: String,
    user: User,
}

pub async fn register(
    State(app_state): State<crate::AppState>,
    Json(payload): Json<RegisterRequest>,
) -> Result<Json<Value>> {
    let pool = app_state.db_pool.pool().await?;
    
    // Input validation
    if payload.email.len() > MAX_EMAIL_LENGTH {
        return Err(AppError::Input("Email too long".to_string()));
    }
    if payload.password.len() < MIN_PASSWORD_LENGTH {
        return Err(AppError::Input("Password must be at least 8 characters".to_string()));
    }
    if payload.password.len() > MAX_PASSWORD_LENGTH {
        return Err(AppError::Input("Password too long".to_string()));
    }
    if payload.name.len() > MAX_NAME_LENGTH {
        return Err(AppError::Input("Name too long".to_string()));
    }
    if payload.name.trim().is_empty() {
        return Err(AppError::Input("Name cannot be empty".to_string()));
    }
    if !payload.email.contains('@') || !payload.email.contains('.') {
        return Err(AppError::Input("Invalid email format".to_string()));
    }

    let password_hash = hash(payload.password, DEFAULT_COST)?;
    let id = Uuid::new_v4().to_string();
    let role = payload.role.unwrap_or_else(|| "student".to_string());

    sqlx::query(
        "INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&payload.email)
    .bind(&password_hash)
    .bind(&payload.name)
    .bind(&role)
    .execute(&pool)
    .await
    .map_err(|e| {
        if e.to_string().contains("Duplicate entry") {
            AppError::Input("Email already exists".to_string())
        } else {
            AppError::Database(e)
        }
    })?;

    Ok(Json(json!({ 
        "success": true,
        "message": "User registered successfully", 
        "userId": id 
    })))
}

pub async fn login(
    State(app_state): State<crate::AppState>,
    Extension(config): Extension<Arc<Config>>,
    jar: CookieJar,
    Json(payload): Json<LoginRequest>,
) -> Result<(CookieJar, Json<AuthResponse>)> {
    let pool = app_state.db_pool.pool().await?;
    
    let user: User = query_as("SELECT * FROM users WHERE email = ?")
        .bind(&payload.email)
        .fetch_optional(&pool)
        .await?
        .ok_or_else(|| AppError::Auth("Invalid email or password".to_string()))?;

    if !verify(payload.password, &user.password_hash)? {
        return Err(AppError::Auth("Invalid email or password".to_string()));
    }

    let expiration = Utc::now()
        .checked_add_signed(Duration::days(30))
        .expect("valid timestamp")
        .timestamp() as usize;

    let claims = Claims {
        user_id: user.id.clone(),
        role: user.role.clone(),
        exp: expiration,
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(config.jwt_secret.as_bytes()),
    )?;

    // Build cookie with security attributes
    // Use SameSite::None for cross-origin requests (frontend on different domain)
    // This requires Secure flag (HTTPS)
    let cookie = Cookie::build(("token", token.clone()))
        .path("/")
        .http_only(true)
        .same_site(SameSite::None)
        .secure(true) // Required for SameSite::None
        .build();

    Ok((
        jar.add(cookie),
        Json(AuthResponse { 
            success: true,
            token, 
            user 
        })
    ))
}
