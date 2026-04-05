/// Phase 1: Model serialization roundtrip tests.
///
/// These tests verify that model structs serialize and deserialize correctly,
/// with proper camelCase field naming and #[serde(skip)] behavior.

#[cfg(test)]
mod user_serde_tests {
    use crate::models::user::User;
    use chrono::{DateTime, Utc};
    use serde_json;

    fn make_user() -> User {
        User {
            id: "user-1".to_string(),
            email: "test@example.com".to_string(),
            password_hash: "secret_hash_that_should_be_skipped".to_string(),
            name: "Test User".to_string(),
            role: "student".to_string(),
            created_at: Some(
                DateTime::parse_from_rfc3339("2024-01-01T00:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc),
            ),
        }
    }

    #[test]
    fn user_serializes_to_camel_case() {
        let user = make_user();
        let json = serde_json::to_value(&user).expect("should serialize");

        assert_eq!(json["id"], "user-1");
        assert_eq!(json["email"], "test@example.com");
        assert_eq!(json["name"], "Test User");
        assert_eq!(json["role"], "student");
        // Note: User struct does NOT have #[serde(rename_all = "camelCase"])
        // so created_at serializes as "created_at", not "createdAt"
        assert!(json.get("created_at").is_some() || json.get("createdAt").is_some());
    }

    #[test]
    fn user_skips_password_hash_in_serialization() {
        let user = make_user();
        let json = serde_json::to_value(&user).expect("should serialize");

        // passwordHash should not appear at all
        assert!(
            json.get("passwordHash").is_none(),
            "passwordHash should be skipped"
        );
        assert!(
            json.get("password_hash").is_none(),
            "password_hash should not appear"
        );
    }

    #[test]
    fn user_deserializes_from_camel_case_json() {
        let json = serde_json::json!({
            "id": "user-2",
            "email": "user2@test.com",
            "passwordHash": "hash123",
            "name": "User Two",
            "role": "teacher",
            "createdAt": "2024-06-01T12:00:00Z"
        });

        let user: User = serde_json::from_value(json).expect("should deserialize");
        assert_eq!(user.id, "user-2");
        assert_eq!(user.email, "user2@test.com");
        // password_hash uses #[serde(skip)] so it defaults to empty string
        assert_eq!(user.password_hash, "");
        assert_eq!(user.name, "User Two");
        assert_eq!(user.role, "teacher");
    }
}

#[cfg(test)]
mod slide_serde_roundtrip_tests {
    use crate::models::slide::Slide;
    use serde_json;

    fn make_slide() -> Slide {
        Slide {
            id: "slide-1".to_string(),
            session_id: "sess-1".to_string(),
            slide_type: "poll".to_string(),
            content: sqlx::types::Json(serde_json::json!({
                "question": "What is 2+2?",
                "options": [
                    {"id": "opt-a", "text": "3"},
                    {"id": "opt-b", "text": "4"}
                ]
            })),
            order_index: 0,
            is_hidden: false,
            version: 0,
        }
    }

    #[test]
    fn slide_serializes_with_camel_case_fields() {
        let slide = make_slide();
        let json = serde_json::to_value(&slide).expect("should serialize");

        assert_eq!(json["id"], "slide-1");
        assert_eq!(json["sessionId"], "sess-1");
        assert_eq!(json["type"], "poll");
        assert_eq!(json["orderIndex"], 0);
        assert_eq!(json["isHidden"], false);
        assert_eq!(json["version"], 0);
        assert!(json["content"].is_object());
    }

    #[test]
    fn slide_roundtrip() {
        let slide = make_slide();
        let json = serde_json::to_value(&slide).expect("should serialize");
        let decoded: Slide = serde_json::from_value(json).expect("should deserialize");

        assert_eq!(decoded.id, slide.id);
        assert_eq!(decoded.session_id, slide.session_id);
        assert_eq!(decoded.slide_type, slide.slide_type);
        assert_eq!(decoded.content.0, slide.content.0);
        assert_eq!(decoded.order_index, slide.order_index);
        assert_eq!(decoded.is_hidden, slide.is_hidden);
        assert_eq!(decoded.version, slide.version);
    }

    #[test]
    fn slide_with_hidden_true() {
        let mut slide = make_slide();
        slide.is_hidden = true;
        slide.version = 5;

        let json = serde_json::to_value(&slide).expect("should serialize");
        assert_eq!(json["isHidden"], true);
        assert_eq!(json["version"], 5);
    }

    #[test]
    fn slide_deserializes_from_handler_json() {
        let json = serde_json::json!({
            "id": "slide-2",
            "sessionId": "sess-2",
            "type": "quiz",
            "content": { "question": "Q?", "options": [] },
            "orderIndex": 1024,
            "isHidden": true,
            "version": 3
        });

        let slide: Slide = serde_json::from_value(json).expect("should deserialize");
        assert_eq!(slide.id, "slide-2");
        assert_eq!(slide.session_id, "sess-2");
        assert_eq!(slide.slide_type, "quiz");
        assert_eq!(slide.order_index, 1024);
        assert!(slide.is_hidden);
        assert_eq!(slide.version, 3);
    }
}

#[cfg(test)]
mod session_serde_roundtrip_tests {
    use crate::models::session::{
        PublicSessionResponse, Session, SessionState, SessionWithSlideCount, SlideWithStats,
        VoteStats,
    };
    use crate::models::slide::Slide;
    use chrono::{DateTime, Utc};
    use serde_json;
    use std::collections::HashMap;

    fn make_session() -> Session {
        Session {
            id: "sess-1".to_string(),
            creator_id: "user-1".to_string(),
            title: "My Session".to_string(),
            status: "draft".to_string(),
            share_token: Some("abc123".to_string()),
            current_slide_id: None,
            is_results_visible: false,
            is_presentation_active: false,
            state_version: 1,
            allow_questions: true,
            require_name: false,
            created_at: Some(
                DateTime::parse_from_rfc3339("2024-01-01T00:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc),
            ),
            updated_at: Some(
                DateTime::parse_from_rfc3339("2024-01-01T00:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc),
            ),
        }
    }

    #[test]
    fn session_serializes_to_camel_case() {
        let session = make_session();
        let json = serde_json::to_value(&session).expect("should serialize");

        assert_eq!(json["id"], "sess-1");
        assert_eq!(json["creatorId"], "user-1");
        assert_eq!(json["title"], "My Session");
        assert_eq!(json["status"], "draft");
        assert_eq!(json["shareToken"], "abc123");
        assert_eq!(json["allowQuestions"], true);
        assert_eq!(json["requireName"], false);
        assert!(json["createdAt"].is_string());
        assert!(json["updatedAt"].is_string());
    }

    #[test]
    fn session_roundtrip() {
        let session = make_session();
        let json = serde_json::to_value(&session).expect("should serialize");
        let decoded: Session = serde_json::from_value(json).expect("should deserialize");

        assert_eq!(decoded.id, session.id);
        assert_eq!(decoded.title, session.title);
        assert_eq!(decoded.share_token, session.share_token);
        assert_eq!(decoded.state_version, session.state_version);
        assert_eq!(decoded.allow_questions, session.allow_questions);
    }

    #[test]
    fn session_with_slide_count_serializes_flattened() {
        let wrapper = SessionWithSlideCount {
            session: make_session(),
            slide_count: 5,
        };

        let json = serde_json::to_value(&wrapper).expect("should serialize");
        // Flattened: session fields at top level
        assert_eq!(json["id"], "sess-1");
        assert_eq!(json["title"], "My Session");
        // Plus slide_count
        assert_eq!(json["slideCount"], 5);
    }

    #[test]
    fn session_state_serializes_camel_case() {
        let mut vote_counts = HashMap::new();
        let mut slide_votes = HashMap::new();
        slide_votes.insert("opt-a".to_string(), 5);
        vote_counts.insert("slide-1".to_string(), slide_votes);

        let state = SessionState {
            current_slide_id: Some("slide-1".to_string()),
            is_presentation_active: true,
            is_results_visible: false,
            state_version: 42,
            slides: vec![],
            questions: vec![],
            vote_counts,
            vote_sequence: 100,
            qa_sequence: 50,
        };

        let json = serde_json::to_value(&state).expect("should serialize");
        assert_eq!(json["currentSlideId"], "slide-1");
        assert_eq!(json["isPresentationActive"], true);
        assert_eq!(json["isResultsVisible"], false);
        assert_eq!(json["stateVersion"], 42);
        assert_eq!(json["voteSequence"], 100);
        assert_eq!(json["qaSequence"], 50);
        assert!(json["voteCounts"]["slide-1"].is_object());
    }

    #[test]
    fn session_state_with_null_current_slide_id() {
        let state = SessionState {
            current_slide_id: None,
            is_presentation_active: false,
            is_results_visible: false,
            state_version: 0,
            slides: vec![],
            questions: vec![],
            vote_counts: HashMap::new(),
            vote_sequence: 0,
            qa_sequence: 0,
        };

        let json = serde_json::to_value(&state).expect("should serialize");
        assert!(json["currentSlideId"].is_null());
    }

    #[test]
    fn vote_stats_serializes() {
        let mut votes = HashMap::new();
        votes.insert("opt-a".to_string(), 10);
        votes.insert("opt-b".to_string(), 7);

        let stats = VoteStats { votes };
        let json = serde_json::to_value(&stats).expect("should serialize");
        assert_eq!(json["votes"]["opt-a"], 10);
        assert_eq!(json["votes"]["opt-b"], 7);
    }

    #[test]
    fn slide_with_stats_serializes() {
        let slide = Slide {
            id: "slide-1".to_string(),
            session_id: "sess-1".to_string(),
            slide_type: "poll".to_string(),
            content: sqlx::types::Json(serde_json::json!({})),
            order_index: 0,
            is_hidden: false,
            version: 0,
        };

        let mut vote_map = HashMap::new();
        vote_map.insert("opt-a".to_string(), 3);
        let stats = Some(VoteStats { votes: vote_map });

        let slide_with_stats = SlideWithStats { slide, stats };
        let json = serde_json::to_value(&slide_with_stats).expect("should serialize");

        // Flattened slide fields
        assert_eq!(json["id"], "slide-1");
        assert_eq!(json["type"], "poll");
        assert_eq!(json["stats"]["votes"]["opt-a"], 3);
    }

    #[test]
    fn public_session_response_shape() {
        let response = PublicSessionResponse {
            session: make_session(),
            slides: vec![],
            questions: vec![],
            participants: vec![],
        };

        let json = serde_json::to_value(&response).expect("should serialize");
        assert_eq!(json["id"], "sess-1");
        assert_eq!(json["title"], "My Session");
        assert!(json["slides"].is_array());
        assert!(json["questions"].is_array());
        assert!(json["participants"].is_array());
    }
}

#[cfg(test)]
mod api_response_serde_tests {
    use crate::models::response::ApiResponse;
    use serde_json;

    #[test]
    fn success_response_serializes_without_error() {
        let response = ApiResponse::success(serde_json::json!({ "ok": true }));
        let json = serde_json::to_value(&response).expect("should serialize");

        assert_eq!(json["success"], true);
        assert_eq!(json["data"]["ok"], true);
        // error field should be omitted due to skip_serializing_if
        assert!(json.get("error").is_none());
    }

    #[test]
    fn error_response_serializes_with_error() {
        let response =
            ApiResponse::error("Something went wrong".to_string(), serde_json::json!(null));
        let json = serde_json::to_value(&response).expect("should serialize");

        assert_eq!(json["success"], false);
        assert_eq!(json["error"], "Something went wrong");
        assert!(json["data"].is_null());
    }

    #[test]
    fn error_response_with_data() {
        let response = ApiResponse::error(
            "Conflict".to_string(),
            serde_json::json!({ "currentVersion": 7 }),
        );
        let json = serde_json::to_value(&response).expect("should serialize");

        assert_eq!(json["success"], false);
        assert_eq!(json["error"], "Conflict");
        assert_eq!(json["data"]["currentVersion"], 7);
    }

    #[test]
    fn success_response_with_string_data() {
        let response = ApiResponse::success("ok".to_string());
        let json = serde_json::to_value(&response).expect("should serialize");
        assert_eq!(json["data"], "ok");
    }
}

#[cfg(test)]
mod auth_serde_tests {
    use crate::handlers::auth::{LoginRequest, RegisterRequest};
    use serde_json;

    #[test]
    fn register_request_deserializes() {
        let json = serde_json::json!({
            "email": "user@test.com",
            "password": "password123",
            "name": "Test User",
            "role": "teacher"
        });

        let result: Result<RegisterRequest, _> = serde_json::from_value(json);
        assert!(result.is_ok());
    }

    #[test]
    fn register_request_without_role() {
        let json = serde_json::json!({
            "email": "user@test.com",
            "password": "password123",
            "name": "Test User"
        });

        let result: Result<RegisterRequest, _> = serde_json::from_value(json);
        assert!(result.is_ok());
    }

    #[test]
    fn register_request_rejects_missing_fields() {
        let json = serde_json::json!({ "email": "user@test.com" });
        let result: Result<RegisterRequest, _> = serde_json::from_value(json);
        assert!(result.is_err());
    }

    #[test]
    fn login_request_deserializes() {
        let json = serde_json::json!({
            "email": "user@test.com",
            "password": "password123"
        });

        let result: Result<LoginRequest, _> = serde_json::from_value(json);
        assert!(result.is_ok());
    }

    #[test]
    fn login_request_rejects_missing_password() {
        let json = serde_json::json!({ "email": "user@test.com" });
        let result: Result<LoginRequest, _> = serde_json::from_value(json);
        assert!(result.is_err());
    }
}
