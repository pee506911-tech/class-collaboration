//! Production-facing smoke test for the slide and student handlers.
//!
//! This test is ignored by default because it mutates a live backend.
//!
//! Run explicitly:
//! RUN_PROD_BACKEND_SMOKE=1 \
//! TEST_SERVER_URL=https://class-collaboration-production.up.railway.app \
//! PERF_TEST_TOKEN=... \
//! cargo test --test prod_slide_student_smoke -- --ignored --test-threads=1

use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;
use uuid::Uuid;

const DEFAULT_PROD_SERVER_URL: &str = "https://class-collaboration-production.up.railway.app";

fn prod_server_url() -> String {
    std::env::var("TEST_SERVER_URL")
        .or_else(|_| std::env::var("PROD_API_URL"))
        .unwrap_or_else(|_| DEFAULT_PROD_SERVER_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

fn require_explicit_prod_smoke_opt_in() {
    let enabled = std::env::var("RUN_PROD_BACKEND_SMOKE").unwrap_or_default();
    assert!(
        matches!(enabled.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"),
        "Refusing to hit a live backend without RUN_PROD_BACKEND_SMOKE=1"
    );
}

fn api_url(base_url: &str, path: &str) -> String {
    format!("{}/api/{}", base_url.trim_end_matches('/'), path)
}

async fn parse_json(response: reqwest::Response, label: &str) -> Value {
    let status = response.status();
    let text = response
        .text()
        .await
        .unwrap_or_else(|error| format!("<<failed to read body: {error}>>"));
    assert!(
        status.is_success(),
        "{label}: expected HTTP success, got {status} with body {text}"
    );
    serde_json::from_str(&text).unwrap_or_else(|error| {
        panic!("{label}: invalid JSON response ({error}): {text}");
    })
}

fn unwrap_api_success(body: &Value, label: &str) -> Value {
    assert_eq!(
        body.get("success").and_then(Value::as_bool),
        Some(true),
        "{label}: expected success=true, got {body}"
    );
    body.get("data").cloned().unwrap_or_else(|| body.clone())
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

async fn cleanup_session(
    client: &Client,
    base_url: &str,
    auth_token: &str,
    session_id: &str,
    perf_test_token: Option<&str>,
) {
    if let Some(perf_test_token) = perf_test_token {
        let response = client
            .delete(api_url(
                base_url,
                &format!(
                    "internal/perf/sessions/{}?deleteCreatorUser=true",
                    session_id
                ),
            ))
            .header("x-perf-test-token", perf_test_token)
            .send()
            .await;

        if let Ok(response) = response {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            assert!(
                status.is_success(),
                "perf cleanup failed for session {session_id}: {status} {body}"
            );
            return;
        }
    }

    let response = client
        .delete(api_url(base_url, &format!("sessions/{session_id}")))
        .header("Authorization", bearer(auth_token))
        .send()
        .await;

    if let Ok(response) = response {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        assert!(
            status.is_success(),
            "session cleanup failed for session {session_id}: {status} {body}"
        );
    }
}

#[tokio::test]
#[ignore = "calls a live backend and mutates data; run explicitly with RUN_PROD_BACKEND_SMOKE=1"]
async fn prod_slide_and_student_handlers_still_work() {
    require_explicit_prod_smoke_opt_in();

    let base_url = prod_server_url();
    let perf_test_token = std::env::var("PERF_TEST_TOKEN").ok();
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .expect("failed to build HTTP client");

    let unique = Uuid::new_v4().to_string();
    let email = format!("backend-smoke-{unique}@example.com");
    let password = format!("Perf-{}!Aa1", &unique[..8]);
    let name = "Backend Smoke";

    let mut auth_token: Option<String> = None;
    let mut session_id: Option<String> = None;

    let scenario_result = async {
        let register_body = parse_json(
            client
                .post(api_url(&base_url, "auth/register"))
                .json(&json!({
                    "email": email,
                    "password": password,
                    "name": name,
                    "role": "staff",
                }))
                .send()
                .await
                .expect("register request failed"),
            "register",
        )
        .await;
        unwrap_api_success(&register_body, "register");

        let login_body = parse_json(
            client
                .post(api_url(&base_url, "auth/login"))
                .json(&json!({
                    "email": email,
                    "password": password,
                }))
                .send()
                .await
                .expect("login request failed"),
            "login",
        )
        .await;
        let token = login_body
            .get("token")
            .and_then(Value::as_str)
            .expect("login token missing")
            .to_string();
        auth_token = Some(token.clone());

        let create_session_body = parse_json(
            client
                .post(api_url(&base_url, "sessions"))
                .header("Authorization", bearer(&token))
                .json(&json!({
                    "title": format!("Backend smoke {unique}"),
                    "allowQuestions": false,
                    "requireName": true,
                }))
                .send()
                .await
                .expect("create session request failed"),
            "create session",
        )
        .await;
        let session = unwrap_api_success(&create_session_body, "create session");
        let created_session_id = session
            .get("id")
            .and_then(Value::as_str)
            .expect("session id missing")
            .to_string();
        session_id = Some(created_session_id.clone());

        let poll_content = json!({
            "question": "Which option wins?",
            "options": [
                {"id": "opt-red", "text": "Red"},
                {"id": "opt-blue", "text": "Blue"}
            ],
            "limitSubmissions": false,
            "allowMultipleSelection": false
        });
        let static_content = json!({
            "title": "Static title",
            "body": "Static body"
        });

        let poll_slide_body = parse_json(
            client
                .post(api_url(
                    &base_url,
                    &format!("sessions/{}/slides", created_session_id),
                ))
                .header("Authorization", bearer(&token))
                .json(&json!({
                    "type": "poll",
                    "content": poll_content,
                    "clientRequestId": format!("poll-{unique}")
                }))
                .send()
                .await
                .expect("create poll slide request failed"),
            "create poll slide",
        )
        .await;
        let poll_slide = unwrap_api_success(&poll_slide_body, "create poll slide");
        let poll_slide_id = poll_slide
            .get("id")
            .and_then(Value::as_str)
            .expect("poll slide id missing")
            .to_string();

        let static_slide_body = parse_json(
            client
                .post(api_url(
                    &base_url,
                    &format!("sessions/{}/slides", created_session_id),
                ))
                .header("Authorization", bearer(&token))
                .json(&json!({
                    "type": "static",
                    "content": static_content,
                    "clientRequestId": format!("static-{unique}")
                }))
                .send()
                .await
                .expect("create static slide request failed"),
            "create static slide",
        )
        .await;
        let static_slide = unwrap_api_success(&static_slide_body, "create static slide");
        let static_slide_id = static_slide
            .get("id")
            .and_then(Value::as_str)
            .expect("static slide id missing")
            .to_string();

        let noop_update_body = parse_json(
            client
                .put(api_url(
                    &base_url,
                    &format!("sessions/{}/slides/{}", created_session_id, static_slide_id),
                ))
                .header("Authorization", bearer(&token))
                .json(&json!({
                    "type": "static",
                    "content": static_content
                }))
                .send()
                .await
                .expect("no-op update request failed"),
            "no-op update slide",
        )
        .await;
        let noop_slide = unwrap_api_success(&noop_update_body, "no-op update slide");
        assert_eq!(
            noop_slide.get("id").and_then(Value::as_str),
            Some(static_slide_id.as_str())
        );
        assert_eq!(
            noop_slide.get("type").and_then(Value::as_str),
            Some("static")
        );
        assert_eq!(noop_slide.get("content"), Some(&static_content));

        let updated_static_content = json!({
            "title": "Static title updated",
            "body": "Static body updated"
        });
        let update_body = parse_json(
            client
                .put(api_url(
                    &base_url,
                    &format!("sessions/{}/slides/{}", created_session_id, static_slide_id),
                ))
                .header("Authorization", bearer(&token))
                .json(&json!({
                    "content": updated_static_content
                }))
                .send()
                .await
                .expect("update slide request failed"),
            "update slide",
        )
        .await;
        let updated_slide = unwrap_api_success(&update_body, "update slide");
        assert_eq!(
            updated_slide.get("content"),
            Some(&updated_static_content),
            "updated slide content should round-trip"
        );

        let initial_state = parse_json(
            client
                .get(api_url(
                    &base_url,
                    &format!("sessions/{}/state", created_session_id),
                ))
                .send()
                .await
                .expect("get initial state request failed"),
            "initial state",
        )
        .await;
        let initial_state_version = initial_state
            .get("stateVersion")
            .and_then(Value::as_i64)
            .expect("initial stateVersion missing");

        parse_json(
            client
                .put(api_url(
                    &base_url,
                    &format!("sessions/{}/slides/reorder", created_session_id),
                ))
                .header("Authorization", bearer(&token))
                .json(&json!({
                    "slideIds": [poll_slide_id, static_slide_id]
                }))
                .send()
                .await
                .expect("no-op reorder request failed"),
            "no-op reorder",
        )
        .await;

        let state_after_noop_reorder = parse_json(
            client
                .get(api_url(
                    &base_url,
                    &format!("sessions/{}/state", created_session_id),
                ))
                .send()
                .await
                .expect("get post-noop state request failed"),
            "state after no-op reorder",
        )
        .await;
        assert_eq!(
            state_after_noop_reorder
                .get("stateVersion")
                .and_then(Value::as_i64),
            Some(initial_state_version),
            "no-op reorder should not bump stateVersion"
        );

        parse_json(
            client
                .put(api_url(
                    &base_url,
                    &format!("sessions/{}/slides/reorder", created_session_id),
                ))
                .header("Authorization", bearer(&token))
                .json(&json!({
                    "slideIds": [static_slide_id, poll_slide_id]
                }))
                .send()
                .await
                .expect("reorder request failed"),
            "reorder slides",
        )
        .await;

        let slides_body = parse_json(
            client
                .get(api_url(
                    &base_url,
                    &format!("sessions/{}/slides", created_session_id),
                ))
                .header("Authorization", bearer(&token))
                .send()
                .await
                .expect("get slides request failed"),
            "get slides",
        )
        .await;
        let slides = unwrap_api_success(&slides_body, "get slides");
        let reordered_ids: Vec<&str> = slides
            .as_array()
            .expect("slides should be an array")
            .iter()
            .map(|slide| {
                slide
                    .get("id")
                    .and_then(Value::as_str)
                    .expect("slide id missing")
            })
            .collect();
        assert_eq!(
            reordered_ids,
            vec![static_slide_id.as_str(), poll_slide_id.as_str()],
            "reordered slides should reflect the requested order"
        );

        let state_after_reorder = parse_json(
            client
                .get(api_url(
                    &base_url,
                    &format!("sessions/{}/state", created_session_id),
                ))
                .send()
                .await
                .expect("get post-reorder state request failed"),
            "state after reorder",
        )
        .await;
        assert_eq!(
            state_after_reorder
                .get("stateVersion")
                .and_then(Value::as_i64),
            Some(initial_state_version + 1),
            "real reorder should bump stateVersion once"
        );

        let participant_id = format!("participant-{}", &unique[..8]);
        parse_json(
            client
                .post(api_url(
                    &base_url,
                    &format!("sessions/{}/vote", created_session_id),
                ))
                .json(&json!({
                    "slideId": poll_slide_id,
                    "optionId": "opt-red",
                    "participantId": participant_id
                }))
                .send()
                .await
                .expect("submit vote request failed"),
            "submit vote",
        )
        .await;

        let state_after_vote = parse_json(
            client
                .get(api_url(
                    &base_url,
                    &format!("sessions/{}/state", created_session_id),
                ))
                .send()
                .await
                .expect("get post-vote state request failed"),
            "state after vote",
        )
        .await;
        let vote_sequence_after_first_submit = state_after_vote
            .get("voteSequence")
            .and_then(Value::as_u64)
            .expect("voteSequence missing after first vote");
        assert_eq!(vote_sequence_after_first_submit, 1);
        assert_eq!(
            state_after_vote
                .get("voteCounts")
                .and_then(|vote_counts| vote_counts.get(&poll_slide_id))
                .and_then(|slide_counts| slide_counts.get("opt-red"))
                .and_then(Value::as_i64),
            Some(1),
            "first vote should be counted once"
        );

        parse_json(
            client
                .post(api_url(
                    &base_url,
                    &format!("sessions/{}/vote", created_session_id),
                ))
                .json(&json!({
                    "slideId": poll_slide_id,
                    "optionId": "opt-red",
                    "participantId": participant_id
                }))
                .send()
                .await
                .expect("duplicate vote request failed"),
            "duplicate vote",
        )
        .await;

        let state_after_duplicate_vote = parse_json(
            client
                .get(api_url(
                    &base_url,
                    &format!("sessions/{}/state", created_session_id),
                ))
                .send()
                .await
                .expect("get duplicate-vote state request failed"),
            "state after duplicate vote",
        )
        .await;
        assert_eq!(
            state_after_duplicate_vote
                .get("voteSequence")
                .and_then(Value::as_u64),
            Some(vote_sequence_after_first_submit),
            "duplicate vote should not bump voteSequence"
        );
        assert_eq!(
            state_after_duplicate_vote
                .get("voteCounts")
                .and_then(|vote_counts| vote_counts.get(&poll_slide_id))
                .and_then(|slide_counts| slide_counts.get("opt-red"))
                .and_then(Value::as_i64),
            Some(1),
            "duplicate vote should not change counts"
        );

        let my_votes_body = parse_json(
            client
                .get(api_url(
                    &base_url,
                    &format!(
                        "sessions/{}/my-votes?participantId={}",
                        created_session_id, participant_id
                    ),
                ))
                .send()
                .await
                .expect("get my votes request failed"),
            "get my votes",
        )
        .await;
        let my_votes = unwrap_api_success(&my_votes_body, "get my votes");
        assert_eq!(
            my_votes
                .get("votes")
                .and_then(|votes| votes.get(&poll_slide_id))
                .and_then(Value::as_array)
                .map(|option_ids| option_ids.len()),
            Some(1),
            "my-votes should return exactly one option for the poll slide"
        );
        assert_eq!(
            my_votes
                .get("votes")
                .and_then(|votes| votes.get(&poll_slide_id))
                .and_then(Value::as_array)
                .and_then(|option_ids| option_ids.first())
                .and_then(Value::as_str),
            Some("opt-red")
        );

        parse_json(
            client
                .delete(api_url(
                    &base_url,
                    &format!("sessions/{}/slides/{}", created_session_id, static_slide_id),
                ))
                .header("Authorization", bearer(&token))
                .send()
                .await
                .expect("delete slide request failed"),
            "delete slide",
        )
        .await;

        let slides_after_delete_body = parse_json(
            client
                .get(api_url(
                    &base_url,
                    &format!("sessions/{}/slides", created_session_id),
                ))
                .header("Authorization", bearer(&token))
                .send()
                .await
                .expect("get slides after delete request failed"),
            "get slides after delete",
        )
        .await;
        let slides_after_delete =
            unwrap_api_success(&slides_after_delete_body, "get slides after delete");
        let remaining_slide_ids: Vec<&str> = slides_after_delete
            .as_array()
            .expect("slides after delete should be an array")
            .iter()
            .map(|slide| {
                slide
                    .get("id")
                    .and_then(Value::as_str)
                    .expect("slide id missing")
            })
            .collect();
        assert_eq!(remaining_slide_ids, vec![poll_slide_id.as_str()]);

        Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
    }
    .await;

    if let (Some(auth_token), Some(session_id)) = (auth_token.as_deref(), session_id.as_deref()) {
        cleanup_session(
            &client,
            &base_url,
            auth_token,
            session_id,
            perf_test_token.as_deref(),
        )
        .await;
    }

    if let Err(error) = scenario_result {
        panic!("prod slide/student smoke test failed: {error}");
    }
}
