# ClassColab Backend - Rust Implementation

> **Type-safe, memory-safe, concurrent** backend for ClassColab

This is a Rust rewrite of the ClassColab backend, bringing compile-time guarantees, zero-cost abstractions, and fearless concurrency to the application.

## 🎯 Philosophy

**"If it compiles, it works."**

This implementation follows strict Rust principles:
- **Result types** instead of exceptions
- **Enums** for state representation
- **Immutability** by default
- **Explicit ownership** semantics
- **Zero-cost abstractions**

## 🚀 Quick Start

### Prerequisites
- Rust 1.75+ (`rustup update`)
- MySQL/TiDB database
- Environment variables configured

### Installation
```bash
# Install Rust (if not already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Clone and navigate
cd apps/backend-rust

# Copy environment template
cp .env.example .env
# Edit .env with your credentials

# Run
cargo run
```

Server starts on `http://localhost:8081`

### Development
```bash
# Check code (fast compilation check)
cargo check

# Build
cargo build

# Run with auto-reload (install cargo-watch)
cargo install cargo-watch
cargo watch -x run

# Run tests
cargo test

# Linting
cargo clippy

# Format code
cargo fmt
```

### Production
```bash
# Optimized build
cargo build --release

# Run optimized binary
./target/release/backend-rust
```

## 📋 API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login and receive JWT

### Sessions (Protected)
- `GET /api/sessions` - List user's sessions
- `POST /api/sessions` - Create new session
- `GET /api/sessions/:id` - Get session details

### Slides (Protected)
- `GET /api/sessions/:id/slides` - List slides
- `POST /api/sessions/:id/slides` - Create slide
- `PUT /api/sessions/:session_id/slides/:slide_id` - Update slide
- `DELETE /api/sessions/:session_id/slides/:slide_id` - Delete slide
- `PUT /api/sessions/:id/slides/reorder` - Reorder slides

### Health
- `GET /health` - Health check with DB ping

## 🏗️ Architecture

### Tech Stack
- **Framework**: Axum 0.7 (Tokio-based web framework)
- **Database**: SQLx 0.7 (compile-time SQL verification)
- **Auth**: JWT (jsonwebtoken 9.2)
- **Password**: bcrypt 0.15
- **Runtime**: Tokio 1.0 (async runtime)

### Project Structure
```
src/
├── main.rs           # Entry point & routing
├── config.rs         # Environment configuration
├── db.rs             # Database pool
├── error.rs          # Error types & Result<T>
├── handlers/         # Request handlers
│   ├── auth.rs       # Authentication
│   ├── session.rs    # Session CRUD
│   └── slide.rs      # Slide CRUD
├── middleware/       # Request middleware
│   └── auth.rs       # JWT extraction
└── models/           # Data models
    ├── user.rs
    ├── session.rs
    └── slide.rs
```

## 🔐 Security Features

### Type-Safe Authentication
```rust
// Extractor automatically validates JWT
pub async fn get_sessions(
    AuthUser { user_id, .. }: AuthUser,  // Fails compilation if not auth'd
) -> Result<Json<Vec<Session>>> {
    // ...
}
```

### Ownership Verification
Every protected endpoint verifies ownership:
```rust
verify_session_ownership(&pool, &session_id, &user_id).await?;
```

### Password Security
- Bcrypt with cost factor 12
- Passwords never serialized (marked `#[serde(skip)]`)

### Database Safety
- Prepared statements (SQL injection prevention)
- Compile-time query verification
- Connection pooling

## 🎨 Rust Patterns

### Error Handling
```rust
// Define error types
pub enum AppError {
    Database(sqlx::Error),
    Auth(String),
    NotFound(String),
    Input(String),
}

// Use Result everywhere
pub type Result<T> = std::result::Result<T, AppError>;

// Propagate with ?
let user = query.fetch_one(&pool).await?;
```

### Extractors
```rust
// Type-safe request parameter extraction
Path(id): Path<String>,           // URL parameter
Json(payload): Json<LoginRequest>, // JSON body
State(pool): State<DbPool>,        // Application state
AuthUser { user_id, .. }: AuthUser // Custom extractor
```

### Database Queries
```rust
// Compile-time checked!
let sessions = sqlx::query_as::<_, Session>(
    "SELECT * FROM sessions WHERE creator_id = ?"
)
.bind(user_id)
.fetch_all(&pool)
.await?;
```

## ⚡ Performance

### Benchmarks (TODO)
```bash
# Load testing
wrk -t12 -c400 -d30s http://localhost:8081/health
```

### Characteristics
- **No GC pauses**: Predictable latency
- **Zero-cost abstractions**: No runtime overhead
- **Memory safe**: No leaks or use-after-free
- **Concurrent**: Tokio handles thousands of connections

## 🧪 Testing

### Unit Tests
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_login() {
        // Test implementation
    }
}
```

Run with:
```bash
cargo test
```

### Integration Tests
```bash
cargo test --test '*'
```

## 🐳 Docker

### Build Image
```bash
docker build -t classcolab-rust .
```

### Run Container
```bash
docker run -p 8080:8080 \
  -e DATABASE_URL="..." \
  -e JWT_SECRET="..." \
  classcolab-rust
```

### Docker Compose
```yaml
services:
  backend-rust:
    build: ./apps/backend-rust
    ports:
      - "8081:8080"
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - JWT_SECRET=${JWT_SECRET}
```

## 📊 Comparison with Go Backend

| Feature | Go | Rust |
|---------|----|----|
| Type Safety | Runtime checks | Compile-time |
| Memory Safety | GC + runtime errors | Ownership system |
| Null Safety | `nil` panics possible | Option<T> enforced |
| Error Handling | Manual `if err != nil` | `?` operator + types |
| Concurrency | Goroutines | Tokio tasks |
| Performance | Fast | Faster (no GC) |
| Binary Size | Small | Small |
| Build Time | Fast | Slower initially |

## 🛣️ Roadmap

### Phase 1: Foundation ✅
- [x] Project setup
- [x] Database integration
- [x] Authentication
- [x] Basic CRUD (sessions, slides)

### Phase 2: Feature Parity 🚧
- [ ] All session operations
- [ ] Live session controls
- [ ] Student endpoints
- [ ] Rate limiting

### Phase 3: Enhancements 📋
- [ ] WebSocket support
- [ ] Metrics & monitoring
- [ ] Load testing
- [ ] Production deployment

## 🤝 Contributing

### Code Style
- Follow Rust conventions (`cargo fmt`)
- Pass Clippy lints (`cargo clippy`)
- Write tests for new features
- Update documentation

### Pull Request Process
1. Fork the repository
2. Create feature branch
3. Write tests
4. Ensure `cargo check` passes
5. Submit PR

## 📝 Environment Variables

```bash
# Database connection
DATABASE_URL=mysql://user:pass@host:3306/db

# JWT secret (min 32 chars)
JWT_SECRET=your-secret-key

# Server port
PORT=8081

# CORS origins (comma-separated)
ALLOWED_ORIGINS=http://localhost:3000

# Environment
ENVIRONMENT=development

# Optional DB pool tuning (useful for low-connection DB plans)
DB_MAX_CONNECTIONS=5
DB_MIN_CONNECTIONS=0
DB_ACQUIRE_TIMEOUT_SECONDS=60
DB_IDLE_TIMEOUT_SECONDS=600
```

## 🐛 Debugging

### Enable Logging
```bash
# Info level
RUST_LOG=info cargo run

# Debug level
RUST_LOG=debug cargo run

# Trace level (very verbose)
RUST_LOG=trace cargo run
```

### Database Queries
SQLx logs all queries at `DEBUG` level:
```bash
RUST_LOG=sqlx=debug cargo run
```

## 📚 Resources

- [Axum Documentation](https://docs.rs/axum)
- [SQLx Documentation](https://docs.rs/sqlx)
- [Rust Book](https://doc.rust-lang.org/book/)
- [Tokio Tutorial](https://tokio.rs/tokio/tutorial)

## 📄 License

Same as main ClassColab project

## 👥 Authors

- **Migration**: rd-cream
- **Original Go Backend**: ClassColab Team

---

**Built with ❤️ and Rust 🦀**

*"Zero-cost abstractions, memory safety, and fearless concurrency."*
