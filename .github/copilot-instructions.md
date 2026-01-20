# Copilot / AI Agent Instructions for ClassColab

Purpose: Help AI agents be productive quickly by describing the architecture, conventions, run/debug commands, and where to find source-of-truth code.

React/Next.js performance guidance lives in `AGENTS.md` (waterfall elimination, bundle size, RSC patterns).

1. Big picture
- Frontend: Next.js app in [apps/web](apps/web) communicates with the backend over REST and Ably realtime. See [ARCHITECTURE.md](ARCHITECTURE.md).
- Backend: Rust (Axum) in [apps/backend](apps/backend). Clean-layered structure: handlers -> services -> repositories. Entry: [apps/backend/src/main.rs](apps/backend/src/main.rs#L1-L40).
- DB: MySQL accessed via `sqlx`. Migrations live under [apps/backend/migrations](apps/backend/migrations).

2. Key patterns and conventions (do not change unless requested)
- Handlers are presentation-only: they parse/extract and call services. Example: [apps/backend/src/handlers/session.rs](apps/backend/src/handlers/session.rs#L1-L40).
- Services contain business logic and call repositories. Repos implement trait interfaces (see `repositories/*`).
- Database pool is lazy and initialized in background (`apps/backend/src/db.rs`) — handlers should use `LazyDbPool::pool().await` where appropriate. See [apps/backend/src/db.rs](apps/backend/src/db.rs#L1-L80).
- Auth is extracted via a custom `AuthUser` extractor (look under `middleware/auth.rs`). Protected endpoints expect `AuthUser` in the handler signature.
- Frontend uses `apps/web/src/lib/api.ts` helpers: `fetchWithRetry` implements exponential backoff for cold-start 503s — mirror that behavior for test clients or scripts.

3. How to run / common commands
- Backend (local):
  - Set env from `.env.example`, ensure `DATABASE_URL` and `JWT_SECRET` present.
  - Dev run: `cargo run` (or `cargo watch -x run` for reloads). Default port comes from env `PORT` (configured in `apps/backend/src/config.rs`).
  - Check/format/lint: `cargo check`, `cargo fmt`, `cargo clippy`.
  - Tests: `cargo test`.
  - Migrations: `sqlx::migrate!` runs automatically in background init when `ENVIRONMENT != production` (see `db.rs`).
- Frontend (local): from workspace root use `pnpm --filter web dev` or `pnpm dev` inside `apps/web` if package manager configured. `apps/web/src/lib/api.ts` expects `NEXT_PUBLIC_API_URL` (defaults to `http://localhost:8080/api`).
- Docker: there are example Docker commands in `apps/backend/README.md`.

4. Integration & infra notes
- Ably is used for realtime publishing; backend publishes events (see `services/ably.rs`). Frontend subscribes via `lib/websocket.tsx`.
- Rate limiting configured in `main.rs` using `tower_governor` layers; be aware of per-second limits during integration tests.

5. What to change in PRs (agent guidance)
- Make minimal, focused edits. Preserve the layered separation: never move business logic from `services/` into `handlers/`.
- If adding DB queries, prefer `sqlx::query_as!` or compile-time checked queries and add migrations under `apps/backend/migrations`.
- Update `ARCHITECTURE.md` or `apps/backend/README.md` when adding significant infra or run changes.

6. Files to inspect for context (quick links)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [apps/backend/src/main.rs](apps/backend/src/main.rs#L1-L40)
- [apps/backend/src/db.rs](apps/backend/src/db.rs#L1-L80)
- [apps/backend/README.md](apps/backend/README.md)
- [apps/web/src/lib/api.ts](apps/web/src/lib/api.ts#L1-L40)

If any section is unclear or you'd like more examples (tests, sample migration, or a small local run script), tell me which area to expand.
