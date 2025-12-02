use std::env;
use dotenvy::dotenv;

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub jwt_secret: String,
    pub port: u16,
    pub allowed_origins: Vec<String>,
    pub environment: String,
}

impl Config {
    pub fn from_env() -> Self {
        dotenv().ok();

        let database_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");
        let jwt_secret = env::var("JWT_SECRET").expect("JWT_SECRET must be set");
        let port = env::var("PORT")
            .unwrap_or_else(|_| "8080".to_string())
            .parse()
            .expect("PORT must be a number");
        
        let allowed_origins = env::var("ALLOWED_ORIGINS")
            .unwrap_or_else(|_| "http://localhost:3000".to_string())
            .split(',')
            .map(|s| s.trim().to_string())
            .collect();

        let environment = env::var("ENVIRONMENT")
            .unwrap_or_else(|_| "development".to_string());

        Self {
            database_url,
            jwt_secret,
            port,
            allowed_origins,
            environment,
        }
    }

    pub fn is_production(&self) -> bool {
        self.environment == "production"
    }
}
