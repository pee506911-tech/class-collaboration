//! Concurrency Integration Tests
//!
//! These tests verify vote correctness, realtime event ordering, and fault tolerance
//! under concurrent load. Requires MySQL running via Docker Compose.
//!
//! Run with: cargo test --test concurrency -- --test-threads=1
//!
//! Environment variables:
//! - DATABASE_URL: MySQL connection string (default: mysql://classcolab:testpassword@localhost:3307/classcolab_test)
//! - TEST_SERVER_URL: Optional server URL (default: http://localhost:8000)

use futures_util::future::join_all;
use reqwest::Client;
use serde_json::{json, Value};
use sqlx::{MySql, Pool};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;

// Test database URL
const DEFAULT_DATABASE_URL: &str = "mysql://classcolab:testpassword@localhost:3307/classcolab_test";
// Backend default PORT is 8080 (see src/config.rs)
const DEFAULT_SERVER_URL: &str = "http://localhost:8080";

fn get_database_url() -> String {
    std::env::var("DATABASE_URL").unwrap_or_else(|_| DEFAULT_DATABASE_URL.to_string())
}

fn get_server_url() -> String {
    std::env::var("TEST_SERVER_URL").unwrap_or_else(|_| DEFAULT_SERVER_URL.to_string())
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

async fn cleanup_test_database(pool: &Pool<MySql>) {
    sqlx::query("DELETE FROM question_upvotes WHERE question_id IS NOT NULL")
        .execute(pool)
        .await
        .expect("Failed to clean question upvotes");

    // Clean vote submission locks (limitSubmissions enforcement)
    // Table may not exist on older DBs; in that case we ignore the error.
    let _ = sqlx::query("DELETE FROM vote_submissions WHERE session_id IS NOT NULL")
        .execute(pool)
        .await;

    sqlx::query("DELETE FROM votes WHERE session_id IS NOT NULL")
        .execute(pool)
        .await
        .expect("Failed to clean votes");

    let _ = sqlx::query("DELETE FROM vote_counts WHERE session_id IS NOT NULL")
        .execute(pool)
        .await;

    sqlx::query("DELETE FROM slide_update_requests WHERE session_id IS NOT NULL")
        .execute(pool)
        .await
        .expect("Failed to clean slide update requests");

    sqlx::query("DELETE FROM slide_delete_requests WHERE session_id IS NOT NULL")
        .execute(pool)
        .await
        .expect("Failed to clean slide delete requests");

    sqlx::query("DELETE FROM questions WHERE session_id IS NOT NULL")
        .execute(pool)
        .await
        .expect("Failed to clean questions");

    sqlx::query("DELETE FROM slides WHERE session_id IS NOT NULL")
        .execute(pool)
        .await
        .expect("Failed to clean slides");

    sqlx::query("DELETE FROM sessions WHERE id IS NOT NULL")
        .execute(pool)
        .await
        .expect("Failed to clean sessions");
}

/// Test fixture for concurrency tests
struct ConcurrencyTestFixture {
    pool: Arc<Pool<MySql>>,
    client: Client,
    server_url: String,
    session_id: String,
    slide_id: String,
}

impl ConcurrencyTestFixture {
    /// Create a new test fixture with fresh database state
    async fn new() -> Self {
        let database_url = get_database_url();
        let server_url = get_server_url();
        let pool = Arc::new(
            Pool::<MySql>::connect(&database_url)
                .await
                .expect("Failed to connect to test database"),
        );

        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("Failed to create HTTP client");

        cleanup_test_database(&pool).await;

        // Create test session
        let session_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO sessions (id, creator_id, title, status, share_token, state_version, allow_questions, require_name, vote_sequence, qa_sequence)
             VALUES (?, ?, ?, 'published', ?, 0, TRUE, FALSE, 0, 0)"
        )
        .bind(&session_id)
        .bind("test-user")
        .bind("Test Session")
        .bind("test-token")
        .execute(&*pool)
        .await
        .expect("Failed to create session");

        // Create test slide (poll)
        let slide_id = uuid::Uuid::new_v4().to_string();
        let slide_content = json!({
            "question": "What is your favorite color?",
            "options": [
                {"id": "opt-red", "text": "Red"},
                {"id": "opt-blue", "text": "Blue"},
                {"id": "opt-green", "text": "Green"},
                {"id": "opt-yellow", "text": "Yellow"}
            ],
            "limitSubmissions": true,
            "allowMultipleSelection": false
        });

        sqlx::query(
            "INSERT INTO slides (id, session_id, type, content, order_index)
             VALUES (?, ?, 'poll', ?, 0)",
        )
        .bind(&slide_id)
        .bind(&session_id)
        .bind(&slide_content)
        .execute(&*pool)
        .await
        .expect("Failed to create slide");

        Self {
            pool,
            client,
            server_url,
            session_id,
            slide_id,
        }
    }

    /// Submit a vote via the API
    async fn submit_vote_api(
        &self,
        participant_id: &str,
        option_id: &str,
    ) -> reqwest::Result<reqwest::Response> {
        let url = format!("{}/api/sessions/{}/vote", self.server_url, self.session_id);
        let payload = json!({
            "slideId": self.slide_id,
            "optionId": option_id,
            "participantId": participant_id
        });

        self.client.post(&url).json(&payload).send().await
    }

    /// Submit a question via the API
    async fn submit_question_api(
        &self,
        participant_id: &str,
        content: &str,
    ) -> reqwest::Result<reqwest::Response> {
        let url = format!(
            "{}/api/sessions/{}/questions",
            self.server_url, self.session_id
        );
        let payload = json!({
            "content": content,
            "participantId": participant_id
        });

        self.client.post(&url).json(&payload).send().await
    }

    /// Submit a question via the API with X-Client-Request-Id header for idempotency
    async fn submit_question_with_request_id(
        &self,
        participant_id: &str,
        content: &str,
        request_id: &str,
    ) -> reqwest::Result<reqwest::Response> {
        let url = format!(
            "{}/api/sessions/{}/questions",
            self.server_url, self.session_id
        );
        let payload = json!({
            "content": content,
            "participantId": participant_id
        });

        self.client
            .post(&url)
            .json(&payload)
            .header("X-Client-Request-Id", request_id)
            .send()
            .await
    }

    /// Upvote a question via the API
    async fn upvote_question_api(
        &self,
        question_id: &str,
        participant_id: &str,
    ) -> reqwest::Result<reqwest::Response> {
        let url = format!(
            "{}/api/sessions/{}/questions/{}/upvote",
            self.server_url, self.session_id, question_id
        );
        let payload = json!({
            "participantId": participant_id
        });

        self.client.post(&url).json(&payload).send().await
    }

    /// Get vote count for a slide
    async fn get_vote_count(&self) -> i64 {
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM votes WHERE slide_id = ?")
            .bind(&self.slide_id)
            .fetch_one(&*self.pool)
            .await
            .expect("Failed to count votes");

        count
    }

    /// Get materialized vote counts for a slide from the read model
    async fn get_vote_counts_read_model(&self) -> Vec<(String, i64)> {
        sqlx::query_as(
            "SELECT option_id, vote_count FROM vote_counts WHERE slide_id = ? ORDER BY option_id",
        )
        .bind(&self.slide_id)
        .fetch_all(&*self.pool)
        .await
        .expect("Failed to fetch vote_counts read model")
    }

    /// Get votes by participant
    async fn get_participant_votes(&self, participant_id: &str) -> Vec<(String, String)> {
        let votes: Vec<(String, String)> =
            sqlx::query_as("SELECT slide_id, option_id FROM votes WHERE participant_id = ?")
                .bind(participant_id)
                .fetch_all(&*self.pool)
                .await
                .expect("Failed to fetch participant votes");

        votes
    }

    /// Get questions for session
    async fn get_questions(&self) -> Vec<(String, String, i32)> {
        let questions: Vec<(String, String, i32)> = sqlx::query_as(
            "SELECT id, content, upvotes FROM questions WHERE session_id = ? ORDER BY upvotes DESC, created_at DESC"
        )
        .bind(&self.session_id)
        .fetch_all(&*self.pool)
        .await
        .expect("Failed to fetch questions");

        questions
    }

    /// Get current vote sequence
    async fn get_vote_sequence(&self) -> u64 {
        let sequence: u64 = sqlx::query_scalar("SELECT vote_sequence FROM sessions WHERE id = ?")
            .bind(&self.session_id)
            .fetch_one(&*self.pool)
            .await
            .expect("Failed to get vote sequence");

        sequence
    }

    /// Get current QA sequence
    async fn get_qa_sequence(&self) -> u64 {
        let sequence: u64 = sqlx::query_scalar("SELECT qa_sequence FROM sessions WHERE id = ?")
            .bind(&self.session_id)
            .fetch_one(&*self.pool)
            .await
            .expect("Failed to get QA sequence");

        sequence
    }

    /// Get current session state_version
    async fn get_session_state_version(&self) -> i64 {
        let version: i64 = sqlx::query_scalar("SELECT state_version FROM sessions WHERE id = ?")
            .bind(&self.session_id)
            .fetch_one(&*self.pool)
            .await
            .expect("Failed to get session state_version");

        version
    }

    /// Update a slide via direct DB write (for tests that need to manipulate slide content
    /// without going through the API)
    async fn update_slide(&self, slide_id: &str, content: Value) {
        sqlx::query(
            "UPDATE slides SET content = ?, version = version + 1 WHERE id = ? AND session_id = ?",
        )
        .bind(sqlx::types::Json(&content))
        .bind(slide_id)
        .bind(&self.session_id)
        .execute(&*self.pool)
        .await
        .expect("Failed to update slide");

        // Also bump session state_version to match the production handler behavior
        sqlx::query("UPDATE sessions SET state_version = state_version + 1 WHERE id = ?")
            .bind(&self.session_id)
            .execute(&*self.pool)
            .await
            .expect("Failed to bump state_version");
    }
}

struct SlideMutationFixture {
    pool: Arc<Pool<MySql>>,
    client: Client,
    server_url: String,
    auth_token: String,
    session_id: String,
    slide_id: String,
    other_slide_id: String,
}

impl SlideMutationFixture {
    async fn new() -> Self {
        let database_url = get_database_url();
        let server_url = get_server_url();
        let pool = Arc::new(
            Pool::<MySql>::connect(&database_url)
                .await
                .expect("Failed to connect to test database"),
        );

        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("Failed to create HTTP client");

        cleanup_test_database(&pool).await;

        let unique = uuid::Uuid::new_v4().to_string();
        let email = format!("slide-race-{unique}@example.com");
        let password = format!("Race-{}!Aa1", &unique[..8]);
        let name = "Slide Race";

        let register_response = client
            .post(format!("{}/api/auth/register", server_url))
            .json(&json!({
                "email": email,
                "password": password,
                "name": name,
                "role": "staff",
            }))
            .send()
            .await
            .expect("register request failed");
        assert!(
            register_response.status().is_success(),
            "register request failed: {}",
            register_response.text().await.unwrap_or_default()
        );

        let login_response = client
            .post(format!("{}/api/auth/login", server_url))
            .json(&json!({
                "email": email,
                "password": password,
            }))
            .send()
            .await
            .expect("login request failed");
        let login_body: Value = login_response
            .json()
            .await
            .expect("login response body should be JSON");
        let auth_token = login_body
            .get("token")
            .and_then(Value::as_str)
            .expect("login token missing")
            .to_string();

        let create_session_response = client
            .post(format!("{}/api/sessions", server_url))
            .header("Authorization", bearer(&auth_token))
            .json(&json!({
                "title": format!("Slide race {unique}"),
                "allowQuestions": false,
                "requireName": false,
            }))
            .send()
            .await
            .expect("create session request failed");
        assert!(
            create_session_response.status().is_success(),
            "create session request failed: {}",
            create_session_response.text().await.unwrap_or_default()
        );
        let create_session_body: Value = create_session_response
            .json()
            .await
            .expect("create session response body should be JSON");
        let session_id = create_session_body
            .get("data")
            .and_then(|data| data.get("id"))
            .and_then(Value::as_str)
            .expect("session id missing")
            .to_string();

        let slide_id = uuid::Uuid::new_v4().to_string();
        let other_slide_id = uuid::Uuid::new_v4().to_string();
        let first_slide_content = json!({
            "title": "First title",
            "body": "First body"
        });
        let second_slide_content = json!({
            "title": "Second title",
            "body": "Second body"
        });

        sqlx::query(
            "INSERT INTO slides (id, session_id, type, content, order_index)
             VALUES (?, ?, 'static', ?, 0)",
        )
        .bind(&slide_id)
        .bind(&session_id)
        .bind(&first_slide_content)
        .execute(&*pool)
        .await
        .expect("Failed to create first slide");

        sqlx::query(
            "INSERT INTO slides (id, session_id, type, content, order_index)
             VALUES (?, ?, 'static', ?, 1024)",
        )
        .bind(&other_slide_id)
        .bind(&session_id)
        .bind(&second_slide_content)
        .execute(&*pool)
        .await
        .expect("Failed to create second slide");

        Self {
            pool,
            client,
            server_url,
            auth_token,
            session_id,
            slide_id,
            other_slide_id,
        }
    }

    async fn update_slide(
        &self,
        slide_id: &str,
        content: Value,
        base_version: Option<i64>,
        request_id: Option<&str>,
    ) -> reqwest::Result<reqwest::Response> {
        let mut request = self
            .client
            .put(format!(
                "{}/api/sessions/{}/slides/{}",
                self.server_url, self.session_id, slide_id
            ))
            .header("Authorization", bearer(&self.auth_token))
            .json(&json!({
                "content": content,
                "baseVersion": base_version,
            }));

        if let Some(request_id) = request_id {
            request = request.header("X-Client-Request-Id", request_id);
        }

        request.send().await
    }

    async fn reorder_slides(&self, slide_ids: Vec<String>) -> reqwest::Result<reqwest::Response> {
        self.client
            .put(format!(
                "{}/api/sessions/{}/slides/reorder",
                self.server_url, self.session_id
            ))
            .header("Authorization", bearer(&self.auth_token))
            .json(&json!({ "slideIds": slide_ids }))
            .send()
            .await
    }

    async fn get_slide_order(&self) -> Vec<String> {
        sqlx::query_scalar::<_, String>(
            "SELECT id FROM slides WHERE session_id = ? ORDER BY order_index ASC, id ASC",
        )
        .bind(&self.session_id)
        .fetch_all(&*self.pool)
        .await
        .expect("Failed to fetch slide order")
    }

    async fn get_slide_content(&self, slide_id: &str) -> Value {
        let content: sqlx::types::Json<Value> =
            sqlx::query_scalar("SELECT content FROM slides WHERE id = ? AND session_id = ?")
                .bind(slide_id)
                .bind(&self.session_id)
                .fetch_one(&*self.pool)
                .await
                .expect("Failed to fetch slide content");

        content.0
    }

    async fn get_slide_version(&self, slide_id: &str) -> i64 {
        sqlx::query_scalar("SELECT version FROM slides WHERE id = ? AND session_id = ?")
            .bind(slide_id)
            .bind(&self.session_id)
            .fetch_one(&*self.pool)
            .await
            .expect("Failed to fetch slide version")
    }

    async fn get_session_state_version(&self) -> i64 {
        sqlx::query_scalar("SELECT state_version FROM sessions WHERE id = ?")
            .bind(&self.session_id)
            .fetch_one(&*self.pool)
            .await
            .expect("Failed to fetch session state_version")
    }

    /// Create a new fixture with a poll slide instead of static slides
    async fn new_with_poll() -> Self {
        let database_url = get_database_url();
        let server_url = get_server_url();
        let pool = Arc::new(
            Pool::<MySql>::connect(&database_url)
                .await
                .expect("Failed to connect to test database"),
        );

        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("Failed to create HTTP client");

        cleanup_test_database(&pool).await;

        let unique = uuid::Uuid::new_v4().to_string();
        let email = format!("poll-race-{unique}@example.com");
        let password = format!("Race-{}!Aa1", &unique[..8]);
        let name = "Poll Race";

        let register_response = client
            .post(format!("{}/api/auth/register", server_url))
            .json(&json!({
                "email": email,
                "password": password,
                "name": name,
                "role": "staff",
            }))
            .send()
            .await
            .expect("register request failed");
        assert!(
            register_response.status().is_success(),
            "register request failed: {}",
            register_response.text().await.unwrap_or_default()
        );

        let login_response = client
            .post(format!("{}/api/auth/login", server_url))
            .json(&json!({
                "email": email,
                "password": password,
            }))
            .send()
            .await
            .expect("login request failed");
        let login_body: Value = login_response
            .json()
            .await
            .expect("login response body should be JSON");
        let auth_token = login_body
            .get("token")
            .and_then(Value::as_str)
            .expect("login token missing")
            .to_string();

        let create_session_response = client
            .post(format!("{}/api/sessions", server_url))
            .header("Authorization", bearer(&auth_token))
            .json(&json!({
                "title": format!("Poll race {unique}"),
                "allowQuestions": false,
                "requireName": false,
            }))
            .send()
            .await
            .expect("create session request failed");
        assert!(
            create_session_response.status().is_success(),
            "create session request failed: {}",
            create_session_response.text().await.unwrap_or_default()
        );
        let create_session_body: Value = create_session_response
            .json()
            .await
            .expect("create session response body should be JSON");
        let session_id = create_session_body
            .get("data")
            .and_then(|data| data.get("id"))
            .and_then(Value::as_str)
            .expect("session id missing")
            .to_string();

        let slide_id = uuid::Uuid::new_v4().to_string();
        let other_slide_id = uuid::Uuid::new_v4().to_string();
        let poll_content = json!({
            "question": "What is your favorite color?",
            "options": [
                {"id": "opt-red", "text": "Red"},
                {"id": "opt-blue", "text": "Blue"},
                {"id": "opt-green", "text": "Green"},
                {"id": "opt-yellow", "text": "Yellow"}
            ],
            "limitSubmissions": true,
            "allowMultipleSelection": false
        });
        let other_slide_content = json!({
            "title": "Other slide",
            "body": "Other body"
        });

        sqlx::query(
            "INSERT INTO slides (id, session_id, type, content, order_index)
             VALUES (?, ?, 'poll', ?, 0)",
        )
        .bind(&slide_id)
        .bind(&session_id)
        .bind(&poll_content)
        .execute(&*pool)
        .await
        .expect("Failed to create poll slide");

        sqlx::query(
            "INSERT INTO slides (id, session_id, type, content, order_index)
             VALUES (?, ?, 'static', ?, 1024)",
        )
        .bind(&other_slide_id)
        .bind(&session_id)
        .bind(&other_slide_content)
        .execute(&*pool)
        .await
        .expect("Failed to create other slide");

        Self {
            pool,
            client,
            server_url,
            auth_token,
            session_id,
            slide_id,
            other_slide_id,
        }
    }

    /// Submit a vote via the API (for SlideMutationFixture-based tests)
    async fn submit_vote_api(
        &self,
        participant_id: &str,
        option_id: &str,
    ) -> reqwest::Result<reqwest::Response> {
        let url = format!("{}/api/sessions/{}/vote", self.server_url, self.session_id);
        let payload = json!({
            "slideId": self.slide_id,
            "optionId": option_id,
            "participantId": participant_id
        });

        self.client.post(&url).json(&payload).send().await
    }
}

// ============================================
// T-01: Same-Participant Vote Race Test
// ============================================

/// T-01: Verify that a single participant cannot submit multiple votes for the same option
/// even when sending concurrent requests.
///
/// Test: Fire 2, 5, and 10 parallel vote submissions for the same participant via API
/// Assertion: Only ONE vote is persisted per option, sequence increments correctly
#[tokio::test]
#[ignore = "requires MySQL + a running backend server (set DATABASE_URL and TEST_SERVER_URL)"]
async fn t01_same_participant_vote_race() {
    let fixture = ConcurrencyTestFixture::new().await;
    let fixture = Arc::new(fixture);

    // Test with different concurrency levels
    for concurrency in [2, 5, 10] {
        println!("Testing with {} concurrent votes", concurrency);

        let participant_id = format!("race-test-participant-{}", concurrency);
        let option_id = "opt-red";

        // Submit multiple votes concurrently for the same participant via API
        let mut handles = Vec::new();
        for _ in 0..concurrency {
            let fixture_clone = Arc::clone(&fixture);
            let participant_id = participant_id.clone();
            let option_id = option_id.to_string();

            let handle = tokio::spawn(async move {
                fixture_clone
                    .submit_vote_api(&participant_id, &option_id)
                    .await
            });

            handles.push(handle);
        }

        // Wait for all requests to complete
        let results = join_all(handles).await;

        // Count successful responses
        let mut success_count = 0;
        for result in results {
            if let Ok(response_result) = result {
                if let Ok(response) = response_result {
                    if let Ok(json) = response.json::<serde_json::Value>().await {
                        if json
                            .get("success")
                            .and_then(|s| s.as_bool())
                            .unwrap_or(false)
                        {
                            success_count += 1;
                        }
                    }
                }
            }
        }

        // Small delay to ensure DB writes are complete
        sleep(Duration::from_millis(100)).await;

        // Assert: Only one vote persisted
        let participant_votes = fixture.get_participant_votes(&participant_id).await;
        assert_eq!(
            participant_votes.len(),
            1,
            "Expected exactly 1 vote for participant, got {} (concurrency: {})",
            participant_votes.len(),
            concurrency
        );

        // Assert: Only one request succeeded (others rejected as duplicates)
        assert_eq!(
            success_count, 1,
            "Expected exactly 1 successful vote submission, got {}",
            success_count
        );

        // Clean up for next iteration
        sqlx::query("DELETE FROM votes WHERE participant_id LIKE ?")
            .bind("race-test-participant-%")
            .execute(&*fixture.pool)
            .await
            .expect("Failed to clean up test votes");
    }
}

// ============================================
// T-02: Burst Vote Load Test
// ============================================

/// T-02: Verify vote handling under burst load from multiple participants.
///
/// Test: Submit votes from 20/30/40 distinct participants concurrently via API
/// Note: Concurrency should be <= configured burst limit (see RATE_LIMIT_GENERAL_BURST)
/// Assertion: All votes persist correctly, sequence increments correctly
#[tokio::test]
#[ignore = "requires MySQL + a running backend server (set DATABASE_URL and TEST_SERVER_URL)"]
async fn t02_burst_vote_load() {
    // Include a classroom-sized burst.
    for concurrency in [20, 40, 150] {
        let fixture = ConcurrencyTestFixture::new().await;
        let fixture = Arc::new(fixture);
        println!("Testing burst load with {} participants", concurrency);

        let start_time = std::time::Instant::now();

        // Submit votes from distinct participants via API
        let mut handles = Vec::new();
        for i in 0..concurrency {
            let fixture_clone = Arc::clone(&fixture);
            let participant_id = format!("participant-{}", i);
            let option_id = if i % 4 == 0 {
                "opt-red"
            } else if i % 4 == 1 {
                "opt-blue"
            } else if i % 4 == 2 {
                "opt-green"
            } else {
                "opt-yellow"
            };

            let handle = tokio::spawn(async move {
                fixture_clone
                    .submit_vote_api(&participant_id, option_id)
                    .await
            });

            handles.push(handle);
        }

        // Wait for all requests and count successes (helps diagnose rate limiting / server errors)
        let results = join_all(handles).await;
        let mut ok_count = 0;
        let mut status_hist: std::collections::HashMap<u16, usize> =
            std::collections::HashMap::new();
        for result in results {
            if let Ok(resp_result) = result {
                if let Ok(resp) = resp_result {
                    let code = resp.status().as_u16();
                    *status_hist.entry(code).or_insert(0) += 1;
                    if resp.status().is_success() {
                        ok_count += 1;
                    }
                }
            }
        }

        assert_eq!(
            ok_count, concurrency,
            "Expected all requests to succeed; success={} expected={} status_hist={:?}",
            ok_count, concurrency, status_hist
        );
        let elapsed = start_time.elapsed();

        // Small delay for DB writes
        sleep(Duration::from_millis(200)).await;

        // Assert: All votes persisted
        let total_votes = fixture.get_vote_count().await;
        assert_eq!(
            total_votes, concurrency as i64,
            "Expected {} votes, got {}",
            concurrency, total_votes
        );

        // Assert: Sequence incremented correctly
        let final_sequence = fixture.get_vote_sequence().await;
        assert_eq!(
            final_sequence, concurrency as u64,
            "Expected sequence {} but got {}",
            concurrency, final_sequence
        );

        println!(
            "Burst test completed in {:?} ({} votes)",
            elapsed, concurrency
        );
    }
}

// ============================================
// T-03: Multi-Select Vote Test
// ============================================

/// T-03: Verify that multi-select polls work correctly.
///
/// Test: Submit votes for multiple options from the same participant via API
/// Assertion: All selected options are persisted (one row per option)
#[tokio::test]
#[ignore = "requires MySQL + a running backend server (set DATABASE_URL and TEST_SERVER_URL)"]
async fn t03_multi_select_vote() {
    let fixture = ConcurrencyTestFixture::new().await;

    let participant_id = "multi-select-participant";

    // Submit votes for 3 options via API (multi-select)
    let url = format!(
        "{}/api/sessions/{}/vote",
        fixture.server_url, fixture.session_id
    );
    let payload = json!({
        "slideId": fixture.slide_id,
        "optionIds": ["opt-red", "opt-blue", "opt-green"],
        "participantId": participant_id
    });

    let response = fixture
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .expect("Failed to submit multi-select vote");

    assert!(response.status().is_success());

    sleep(Duration::from_millis(100)).await;

    // Assert: All 3 votes persisted
    let participant_votes = fixture.get_participant_votes(&participant_id).await;
    assert_eq!(
        participant_votes.len(),
        3,
        "Expected exactly 3 votes for multi-select participant, got {}",
        participant_votes.len()
    );

    // Verify the correct options were saved
    let option_ids: Vec<&String> = participant_votes.iter().map(|(_, opt_id)| opt_id).collect();
    assert!(option_ids.contains(&&"opt-red".to_string()));
    assert!(option_ids.contains(&&"opt-blue".to_string()));
    assert!(option_ids.contains(&&"opt-green".to_string()));
}

// ============================================
// T-04: Invalid Option Rejection Test
// ============================================

/// T-04: Verify that votes with invalid option IDs are rejected via API.
///
/// Test: Try to insert votes with invalid option IDs via API
/// Assertion: Invalid options are rejected by the handler
#[tokio::test]
#[ignore = "requires MySQL + a running backend server (set DATABASE_URL and TEST_SERVER_URL)"]
async fn t04_invalid_option_rejection() {
    let fixture = ConcurrencyTestFixture::new().await;

    // Submit valid vote via API
    let response = fixture.submit_vote_api("valid-voter", "opt-red").await;
    assert!(response.map(|r| r.status().is_success()).unwrap_or(false));

    // Submit invalid vote via API
    let url = format!(
        "{}/api/sessions/{}/vote",
        fixture.server_url, fixture.session_id
    );
    let payload = json!({
        "slideId": fixture.slide_id,
        "optionId": "opt-invalid",
        "participantId": "invalid-voter"
    });

    let response = fixture
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .expect("Failed to submit invalid vote");

    // Should be rejected (4xx error)
    assert!(
        response.status().is_client_error() || response.status().is_server_error(),
        "Expected invalid option to be rejected, got status: {}",
        response.status()
    );

    sleep(Duration::from_millis(100)).await;

    // Assert: Only valid vote persisted
    let total_votes = fixture.get_vote_count().await;
    assert_eq!(
        total_votes, 1,
        "Expected only 1 valid vote, got {}",
        total_votes
    );
}

// ============================================
// T-05: Sequence Monotonicity Test (API-based)
// ============================================

/// T-05: Verify that sequence numbers increment correctly under concurrency via API.
///
/// Test: Run 20 vote submissions in parallel via API
/// Note: Concurrency limited to respect rate limits
/// Assertion: Final sequence equals number of successful votes, sequences are monotonic
#[tokio::test]
#[ignore = "requires MySQL + a running backend server (set DATABASE_URL and TEST_SERVER_URL)"]
async fn t05_sequence_monotonicity_api() {
    let fixture = ConcurrencyTestFixture::new().await;
    let fixture = Arc::new(fixture);

    let num_votes = 20;
    let mut handles = Vec::new();

    for i in 0..num_votes {
        let fixture_clone = Arc::clone(&fixture);
        let participant_id = format!("seq-test-participant-{}", i);

        let handle = tokio::spawn(async move {
            let response = fixture_clone
                .submit_vote_api(&participant_id, "opt-red")
                .await;
            // Check both network success and HTTP 2xx status
            let http_success = response.map(|r| r.status().is_success()).unwrap_or(false);
            (i, http_success)
        });

        handles.push(handle);
    }

    let results: Vec<(usize, bool)> = join_all(handles)
        .await
        .into_iter()
        .map(|h| h.unwrap())
        .collect();

    let success_count = results.iter().filter(|(_, ok)| *ok).count();

    // Small delay for DB writes
    sleep(Duration::from_millis(200)).await;

    // Final sequence should equal number of successful votes
    let final_sequence = fixture.get_vote_sequence().await;
    assert_eq!(
        final_sequence, success_count as u64,
        "Expected final sequence to be {}, got {}",
        success_count, final_sequence
    );

    // Verify vote count matches
    let total_votes = fixture.get_vote_count().await;
    assert_eq!(
        total_votes, success_count as i64,
        "Expected {} votes, got {}",
        success_count, total_votes
    );
}

// ============================================
// T-06: Q&A Sequence Test
// ============================================

/// T-06: Verify that Q&A sequence numbers increment correctly under concurrency.
///
/// Test: Submit 15 questions in parallel via API
/// Note: Concurrency limited to respect rate limits
/// Assertion: Final QA sequence equals number of questions, sequences are monotonic
#[tokio::test]
#[ignore = "requires MySQL + a running backend server (set DATABASE_URL and TEST_SERVER_URL)"]
async fn t06_qa_sequence_concurrency() {
    let fixture = ConcurrencyTestFixture::new().await;
    let fixture = Arc::new(fixture);

    let num_questions = 15;
    let mut handles = Vec::new();

    for i in 0..num_questions {
        let fixture_clone = Arc::clone(&fixture);
        let participant_id = format!("qa-test-participant-{}", i);
        let content = format!("Test question {}", i);

        let handle = tokio::spawn(async move {
            fixture_clone
                .submit_question_api(&participant_id, &content)
                .await
        });

        handles.push(handle);
    }

    join_all(handles).await;

    // Small delay for DB writes
    sleep(Duration::from_millis(200)).await;

    // Final QA sequence should equal number of questions
    let final_sequence = fixture.get_qa_sequence().await;
    assert_eq!(
        final_sequence, num_questions as u64,
        "Expected final QA sequence to be {}, got {}",
        num_questions, final_sequence
    );

    // Verify question count matches
    let questions = fixture.get_questions().await;
    assert_eq!(
        questions.len(),
        num_questions,
        "Expected {} questions, got {}",
        num_questions,
        questions.len()
    );
}

// ============================================
// T-07: Question Upvote Concurrency Test
// ============================================

/// T-07: Verify that question upvotes work correctly under concurrency.
///
/// Test: Submit multiple upvotes for the same question in parallel via API
/// Assertion: Upvotes count correctly, sequence increments only for new upvotes
#[tokio::test]
#[ignore = "requires MySQL + a running backend server (set DATABASE_URL and TEST_SERVER_URL)"]
async fn t07_question_upvote_concurrency() {
    let fixture = ConcurrencyTestFixture::new().await;
    let fixture = Arc::new(fixture);

    // First, create a question
    let question_content = "Test question for upvotes";
    let response = fixture
        .submit_question_api("question-author", question_content)
        .await;
    assert!(response.map(|r| r.status().is_success()).unwrap_or(false));

    sleep(Duration::from_millis(50)).await;

    // Get the question ID
    let questions = fixture.get_questions().await;
    let (question_id, _, initial_upvotes) = questions.first().expect("Question not found").clone();

    assert_eq!(initial_upvotes, 0, "New question should have 0 upvotes");

    // Submit upvotes from different participants concurrently
    let num_upvotes = 20;
    let mut handles = Vec::new();

    for i in 0..num_upvotes {
        let fixture_clone = Arc::clone(&fixture);
        let participant_id = format!("upvoter-{}", i);
        let question_id = question_id.clone();

        let handle = tokio::spawn(async move {
            fixture_clone
                .upvote_question_api(&question_id, &participant_id)
                .await
        });

        handles.push(handle);
    }

    join_all(handles).await;

    // Small delay for DB writes
    sleep(Duration::from_millis(100)).await;

    // Verify upvote count
    let questions = fixture.get_questions().await;
    let (_, _, final_upvotes) = questions
        .iter()
        .find(|(id, _, _)| id == &question_id)
        .expect("Question not found");

    assert_eq!(
        *final_upvotes, num_upvotes,
        "Expected {} upvotes, got {}",
        num_upvotes, final_upvotes
    );
}

// ============================================
// T-08: Vote + Q&A Interleaved Test
// ============================================

/// T-08: Verify that vote and Q&A sequences increment independently.
///
/// Test: Submit 15 votes and 10 questions concurrently via API
/// Note: Concurrency limited to respect rate limits
/// Assertion: Both sequences increment correctly and independently
#[tokio::test]
#[ignore = "requires MySQL + a running backend server (set DATABASE_URL and TEST_SERVER_URL)"]
async fn t08_interleaved_vote_qa_sequences() {
    let fixture = ConcurrencyTestFixture::new().await;
    let fixture = Arc::new(fixture);

    let num_votes = 15;
    let num_questions = 10;
    let mut handles = Vec::new();

    // Submit votes
    for i in 0..num_votes {
        let fixture_clone = Arc::clone(&fixture);
        let participant_id = format!("interleaved-voter-{}", i);

        let handle = tokio::spawn(async move {
            fixture_clone
                .submit_vote_api(&participant_id, "opt-red")
                .await
        });

        handles.push(handle);
    }

    // Submit questions
    for i in 0..num_questions {
        let fixture_clone = Arc::clone(&fixture);
        let participant_id = format!("interleaved-questioner-{}", i);
        let content = format!("Interleaved question {}", i);

        let handle = tokio::spawn(async move {
            fixture_clone
                .submit_question_api(&participant_id, &content)
                .await
        });

        handles.push(handle);
    }

    join_all(handles).await;

    // Small delay for DB writes
    sleep(Duration::from_millis(300)).await;

    // Verify both sequences
    let vote_sequence = fixture.get_vote_sequence().await;
    let qa_sequence = fixture.get_qa_sequence().await;

    assert_eq!(
        vote_sequence, num_votes as u64,
        "Expected vote sequence {}, got {}",
        num_votes, vote_sequence
    );

    assert_eq!(
        qa_sequence, num_questions as u64,
        "Expected QA sequence {}, got {}",
        num_questions, qa_sequence
    );
}

// ============================================
// T-09: Question Idempotency Test (X-Client-Request-Id)
// ============================================

/// T-09: Verify that question submission with X-Client-Request-Id is idempotent.
///
/// Test: Send 2 parallel POST /question requests with:
/// - Same participantId
/// - Same X-Client-Request-Id
/// Assertion:
/// - Both responses are success-equivalent
/// - Exactly one question row exists
/// - qa_sequence increments only once
#[tokio::test]
#[ignore = "requires MySQL + a running backend server (set DATABASE_URL and TEST_SERVER_URL)"]
async fn t09_question_idempotency_with_request_id() {
    let fixture = ConcurrencyTestFixture::new().await;
    let fixture = Arc::new(fixture);

    let participant_id = "idempotent-participant";
    let content = "Idempotent test question";
    let request_id = "unique-request-id-12345";

    // Send 2 parallel requests with the same X-Client-Request-Id
    let mut handles = Vec::new();
    for _ in 0..2 {
        let fixture_clone = Arc::clone(&fixture);
        let participant_id = participant_id.to_string();
        let content = content.to_string();
        let request_id = request_id.to_string();

        let handle = tokio::spawn(async move {
            fixture_clone
                .submit_question_with_request_id(&participant_id, &content, &request_id)
                .await
        });

        handles.push(handle);
    }

    // Wait for all requests to complete
    let results: Vec<Result<reqwest::Response, reqwest::Error>> = join_all(handles)
        .await
        .into_iter()
        .map(|h| h.expect("Task panicked"))
        .collect();

    // Small delay for DB writes
    sleep(Duration::from_millis(100)).await;

    // Assert: Both responses should be successful
    let success_count = results
        .iter()
        .filter(|r| {
            r.as_ref()
                .map(|resp| resp.status().is_success())
                .unwrap_or(false)
        })
        .count();

    assert_eq!(
        success_count, 2,
        "Expected both requests to succeed, but only {} succeeded",
        success_count
    );

    // Assert: Exactly one question row exists
    let questions = fixture.get_questions().await;
    assert_eq!(
        questions.len(),
        1,
        "Expected exactly 1 question, got {}",
        questions.len()
    );

    // Verify the question content matches
    let (_, question_content, _) = &questions[0];
    assert_eq!(
        question_content, "Idempotent test question",
        "Question content does not match"
    );

    // Assert: qa_sequence incremented only once
    let qa_sequence = fixture.get_qa_sequence().await;
    assert_eq!(
        qa_sequence, 1,
        "Expected qa_sequence to be 1, got {}",
        qa_sequence
    );
}

// ============================================
// T-10: Slide Autosave/Reorder Serialization Test
// ============================================

/// T-10: Verify that slide content autosave is not blocked by an in-flight reorder lock,
/// while reorder itself still waits for the session lock.
///
/// Test: Hold the session row lock, then start one content update and one reorder
/// request in parallel.
/// Assertion: The content update completes without waiting on the session lock,
/// the reorder remains blocked, then succeeds after the lock is released.
#[tokio::test]
#[ignore = "requires MySQL + a running backend server (set DATABASE_URL and TEST_SERVER_URL)"]
async fn t10_slide_autosave_and_reorder_are_serialized() {
    let fixture = SlideMutationFixture::new().await;

    let mut lock_tx = fixture
        .pool
        .begin()
        .await
        .expect("Failed to begin lock transaction");
    sqlx::query_scalar::<_, String>("SELECT id FROM sessions WHERE id = ? FOR UPDATE")
        .bind(&fixture.session_id)
        .fetch_one(&mut *lock_tx)
        .await
        .expect("Failed to lock session row");

    let update_content = json!({
        "title": "Updated while reorder waits",
        "body": "Autosave should serialize with reorder"
    });
    let expected_order = vec![fixture.other_slide_id.clone(), fixture.slide_id.clone()];

    let update_client = fixture.client.clone();
    let update_server_url = fixture.server_url.clone();
    let update_token = fixture.auth_token.clone();
    let update_session_id = fixture.session_id.clone();
    let update_slide_id = fixture.slide_id.clone();
    let update_content_for_task = update_content.clone();

    let update_handle = tokio::spawn(async move {
        update_client
            .put(format!(
                "{}/api/sessions/{}/slides/{}",
                update_server_url, update_session_id, update_slide_id
            ))
            .header("Authorization", bearer(&update_token))
            .json(&json!({ "content": update_content_for_task }))
            .send()
            .await
    });

    let reorder_client = fixture.client.clone();
    let reorder_server_url = fixture.server_url.clone();
    let reorder_token = fixture.auth_token.clone();
    let reorder_session_id = fixture.session_id.clone();
    let reorder_slide_ids = expected_order.clone();

    let reorder_handle = tokio::spawn(async move {
        reorder_client
            .put(format!(
                "{}/api/sessions/{}/slides/reorder",
                reorder_server_url, reorder_session_id
            ))
            .header("Authorization", bearer(&reorder_token))
            .json(&json!({ "slideIds": reorder_slide_ids }))
            .send()
            .await
    });

    sleep(Duration::from_millis(400)).await;
    assert!(
        update_handle.is_finished(),
        "slide update should no longer wait for the session lock"
    );
    assert!(
        !reorder_handle.is_finished(),
        "slide reorder should wait for the session lock"
    );

    lock_tx
        .commit()
        .await
        .expect("Failed to release session lock");

    let update_response = update_handle
        .await
        .expect("update task panicked")
        .expect("update request failed");
    assert!(
        update_response.status().is_success(),
        "update request failed: {}",
        update_response.status()
    );

    let reorder_response = reorder_handle
        .await
        .expect("reorder task panicked")
        .expect("reorder request failed");
    assert!(
        reorder_response.status().is_success(),
        "reorder request failed: {}",
        reorder_response.status()
    );

    let slide_order = fixture.get_slide_order().await;
    assert_eq!(
        slide_order, expected_order,
        "slide order should match the requested reorder"
    );

    let updated_slide_content = fixture.get_slide_content(&fixture.slide_id).await;
    assert_eq!(
        updated_slide_content, update_content,
        "slide content should persist without waiting on the reorder lock"
    );
}

/// T-11: Verify that the vote_counts read model stays in sync with durable votes.
#[tokio::test]
#[ignore = "requires MySQL + a running backend server (set DATABASE_URL and TEST_SERVER_URL)"]
async fn t11_vote_counts_read_model_tracks_submissions() {
    let fixture = ConcurrencyTestFixture::new().await;

    let response = fixture
        .submit_vote_api("vote-counts-participant", "opt-red")
        .await
        .expect("vote request failed");
    assert!(response.status().is_success(), "vote request failed");

    let durable_vote_count = fixture.get_vote_count().await;
    let read_model_counts = fixture.get_vote_counts_read_model().await;

    assert_eq!(durable_vote_count, 1, "expected one durable vote row");
    assert_eq!(
        read_model_counts,
        vec![("opt-red".to_string(), 1)],
        "vote_counts read model should match the durable vote write"
    );
}

/// T-12: Verify that concurrent stale slide saves conflict instead of silently overwriting.
#[tokio::test]
#[ignore = "requires MySQL + a running backend server (set DATABASE_URL and TEST_SERVER_URL)"]
async fn t12_concurrent_slide_saves_conflict_on_stale_version() {
    let fixture = SlideMutationFixture::new().await;
    let initial_version = fixture.get_slide_version(&fixture.slide_id).await;

    let first = fixture
        .update_slide(
            &fixture.slide_id,
            json!({ "title": "Writer one", "body": "First update" }),
            Some(initial_version),
            None,
        )
        .await
        .expect("first update request failed");
    let second = fixture
        .update_slide(
            &fixture.slide_id,
            json!({ "title": "Writer two", "body": "Second update" }),
            Some(initial_version),
            None,
        )
        .await
        .expect("second update request failed");

    let statuses = [first.status(), second.status()];
    let success_count = statuses.iter().filter(|status| status.is_success()).count();
    let conflict_count = statuses
        .iter()
        .filter(|status| **status == reqwest::StatusCode::CONFLICT)
        .count();

    assert_eq!(success_count, 1, "exactly one stale save should succeed");
    assert_eq!(conflict_count, 1, "exactly one stale save should conflict");
    assert_eq!(
        fixture.get_slide_version(&fixture.slide_id).await,
        initial_version + 1,
        "slide version should increment exactly once"
    );
}

/// T-13: Verify that a retried slide update replays the original success even after
/// a later update has already advanced the slide version.
#[tokio::test]
#[ignore = "requires MySQL + a running backend server (set DATABASE_URL and TEST_SERVER_URL)"]
async fn t13_slide_update_idempotency_replays_committed_result() {
    let fixture = SlideMutationFixture::new().await;
    let initial_version = fixture.get_slide_version(&fixture.slide_id).await;

    let request_id = "update-request-replay-1";
    let first_content = json!({
        "title": "Writer one",
        "body": "First update"
    });
    let second_content = json!({
        "title": "Writer two",
        "body": "Second update"
    });

    let first = fixture
        .update_slide(
            &fixture.slide_id,
            first_content.clone(),
            Some(initial_version),
            Some(request_id),
        )
        .await
        .expect("first update request failed");
    assert!(first.status().is_success(), "first update should succeed");
    let first_body: Value = first
        .json()
        .await
        .expect("first update response should be JSON");
    assert_eq!(
        first_body["data"]["version"].as_i64(),
        Some(initial_version + 1),
        "first update should advance the slide version once"
    );

    let second = fixture
        .update_slide(
            &fixture.slide_id,
            second_content.clone(),
            Some(initial_version + 1),
            Some("update-request-replay-2"),
        )
        .await
        .expect("second update request failed");
    assert!(
        second.status().is_success(),
        "second update should also succeed"
    );
    let second_body: Value = second
        .json()
        .await
        .expect("second update response should be JSON");
    assert_eq!(
        second_body["data"]["version"].as_i64(),
        Some(initial_version + 2),
        "second update should advance the slide version again"
    );

    let retry = fixture
        .update_slide(
            &fixture.slide_id,
            first_content,
            Some(initial_version),
            Some(request_id),
        )
        .await
        .expect("retry update request failed");
    assert!(
        retry.status().is_success(),
        "retry should replay the committed success instead of conflicting"
    );
    let retry_body: Value = retry
        .json()
        .await
        .expect("retry update response should be JSON");
    assert_eq!(
        retry_body, first_body,
        "retry should replay the original response body"
    );

    assert_eq!(
        fixture.get_slide_version(&fixture.slide_id).await,
        initial_version + 2,
        "the current slide version should still reflect the later update"
    );
    assert_eq!(
        fixture.get_slide_content(&fixture.slide_id).await,
        second_content,
        "the later update should still win the stored slide state"
    );
}

// ============================================
// T-14: Slide Update Enqueues Outbox Event
// ============================================

/// T-14: Verify that a single slide update enqueues a SLIDES_UPDATE outbox event
/// and bumps the session state_version.
///
/// This is the regression test for RACE-1: previously, single-slide updates
/// committed to MySQL but never produced an outbox event, so students never
/// received real-time notification of content changes.
///
/// Test: Update a slide via API, then query the outbox_events table.
/// Assertion: Exactly one pending SLIDES_UPDATE event exists for the session,
///            and state_version has incremented by 1.
#[tokio::test]
#[ignore = "requires MySQL + a running backend server (set DATABASE_URL and TEST_SERVER_URL)"]
async fn t14_slide_update_enqueues_outbox_event() {
    let fixture = SlideMutationFixture::new().await;
    let initial_version = fixture.get_slide_version(&fixture.slide_id).await;

    let new_content = json!({
        "title": "Updated title for outbox test",
        "body": "Updated body"
    });

    let response = fixture
        .update_slide(
            &fixture.slide_id,
            new_content.clone(),
            Some(initial_version),
            Some("t14-outbox-test-request"),
        )
        .await
        .expect("update request failed");

    assert!(
        response.status().is_success(),
        "update should succeed: {}",
        response.text().await.unwrap_or_default()
    );

    // Verify outbox event was created
    let outbox_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM outbox_events
         WHERE session_id = ? AND event_type = 'SLIDES_UPDATE' AND status = 'pending'",
    )
    .bind(&fixture.session_id)
    .fetch_one(&*fixture.pool)
    .await
    .expect("failed to query outbox_events");

    assert_eq!(
        outbox_count, 1,
        "exactly one pending SLIDES_UPDATE outbox event should exist after slide update"
    );

    // Verify the outbox payload contains the updated slide
    let outbox_payload: sqlx::types::Json<Value> = sqlx::query_scalar(
        "SELECT payload FROM outbox_events
         WHERE session_id = ? AND event_type = 'SLIDES_UPDATE' AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&fixture.session_id)
    .fetch_one(&*fixture.pool)
    .await
    .expect("failed to fetch outbox payload");

    let slides = outbox_payload
        .0
        .get("slides")
        .and_then(Value::as_array)
        .expect("outbox payload should have 'slides' array");

    assert!(
        !slides.is_empty(),
        "outbox slides array should not be empty"
    );

    let updated_slide = &slides[0];
    assert_eq!(
        updated_slide.get("id").and_then(Value::as_str),
        Some(fixture.slide_id.as_str()),
        "outbox event should reference the updated slide id"
    );
}

// ============================================
// T-15: Vote Rejects Deleted Option
// ============================================

/// T-15: Verify that submitting a vote for an option that no longer exists
/// in the slide content returns a 400 error.
///
/// This is the regression test for RACE-4: if a teacher removes a poll option
/// while a student is voting for it, the vote should be rejected rather than
/// stored for a ghost option.
///
/// Test: Create a poll with options [A, B, C], remove option C via slide update,
///       then submit a vote for option C.
/// Assertion: Vote submission returns 400 Bad Request.
#[tokio::test]
#[ignore = "requires MySQL + a running backend server (set DATABASE_URL and TEST_SERVER_URL)"]
async fn t15_vote_rejects_deleted_option() {
    let fixture = SlideMutationFixture::new_with_poll().await;

    // Vote for an option that exists first to confirm normal voting works
    let valid_vote = fixture
        .submit_vote_api("test-participant-1", "opt-red")
        .await
        .expect("vote request failed");
    assert!(
        valid_vote.status().is_success(),
        "voting for a valid option should succeed: {}",
        valid_vote.text().await.unwrap_or_default()
    );

    // Now update the slide to remove opt-yellow via the API
    let slide_content = json!({
        "question": "What is your favorite color?",
        "options": [
            {"id": "opt-red", "text": "Red"},
            {"id": "opt-blue", "text": "Blue"},
            {"id": "opt-green", "text": "Green"}
            // opt-yellow removed
        ],
        "limitSubmissions": true,
        "allowMultipleSelection": false
    });

    let initial_version = fixture.get_slide_version(&fixture.slide_id).await;
    let update_response = fixture
        .update_slide(
            &fixture.slide_id,
            slide_content,
            Some(initial_version),
            None,
        )
        .await
        .expect("slide update request failed");
    assert!(
        update_response.status().is_success(),
        "slide update should succeed: {}",
        update_response.text().await.unwrap_or_default()
    );

    // Now try to vote for the removed option (opt-yellow)
    // Use a different participant to avoid limitSubmissions lock
    let invalid_vote = fixture
        .submit_vote_api("test-participant-2", "opt-yellow")
        .await
        .expect("vote request failed");

    assert!(
        !invalid_vote.status().is_success(),
        "voting for a deleted option should return an error status"
    );
    assert_eq!(
        invalid_vote.status(),
        reqwest::StatusCode::BAD_REQUEST,
        "voting for a deleted option should return 400"
    );
}

// ============================================
// T-16: Vote Accepts Valid Option After Content Change
// ============================================

/// T-16: Verify that voting for a remaining option still works after
/// other options have been removed from the slide.
///
/// Test: Remove one option from a poll, then vote for a remaining option.
/// Assertion: Vote succeeds.
#[tokio::test]
#[ignore = "requires MySQL + a running backend server (set DATABASE_URL and TEST_SERVER_URL)"]
async fn t16_vote_accepts_valid_option_after_content_change() {
    let fixture = SlideMutationFixture::new_with_poll().await;

    // Update the slide to remove opt-yellow via the API
    let slide_content = json!({
        "question": "What is your favorite color?",
        "options": [
            {"id": "opt-red", "text": "Red"},
            {"id": "opt-blue", "text": "Blue"},
            {"id": "opt-green", "text": "Green"}
        ],
        "limitSubmissions": true,
        "allowMultipleSelection": false
    });

    let initial_version = fixture.get_slide_version(&fixture.slide_id).await;
    let update_response = fixture
        .update_slide(
            &fixture.slide_id,
            slide_content,
            Some(initial_version),
            None,
        )
        .await
        .expect("slide update request failed");
    assert!(
        update_response.status().is_success(),
        "slide update should succeed: {}",
        update_response.text().await.unwrap_or_default()
    );

    // Vote for a remaining option — should succeed
    let vote = fixture
        .submit_vote_api("test-participant-valid", "opt-red")
        .await
        .expect("vote request failed");
    assert!(
        vote.status().is_success(),
        "voting for a remaining option should succeed: {}",
        vote.text().await.unwrap_or_default()
    );
}
