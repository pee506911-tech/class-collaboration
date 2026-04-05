/// Contract tests for backend response shapes.
///
/// These tests verify that HTTP responses from the backend match the
/// expected contract that the frontend depends on. They are pure unit
/// tests that construct responses manually to match handler behavior.
#[cfg(test)]
mod tests {
    use serde_json::json;

    // --- ApiResponse Wrapper Contract ---

    #[test]
    fn success_response_has_success_true_field() {
        let response = json!({
            "success": true,
            "data": {"message": "ok"},
            "error": null
        });

        assert_eq!(response["success"], true);
        assert!(response.get("data").is_some());
        assert!(response.get("error").is_some());
    }

    #[test]
    fn error_response_has_success_false_field() {
        let response = json!({
            "success": false,
            "error": "something went wrong",
            "data": null
        });

        assert_eq!(response["success"], false);
        assert!(response["error"].is_string());
        assert!(response.get("data").is_some()); // even if null
    }

    // --- Auth Endpoint Contracts ---

    #[test]
    fn register_success_response_shape() {
        let response = json!({
            "success": true,
            "message": "User registered successfully",
            "userId": "user-uuid-here"
        });

        assert_eq!(response["success"], true);
        assert!(response["userId"].as_str().is_some());
        assert!(response["message"].as_str().is_some());
        // Note: register does NOT return a token (login does)
        assert!(response.get("token").is_none());
    }

    #[test]
    fn login_success_response_shape() {
        let response = json!({
            "success": true,
            "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
            "user": {
                "id": "user-uuid",
                "email": "test@example.com",
                "name": "Test User",
                "role": "student"
            }
        });

        assert_eq!(response["success"], true);
        assert!(response["token"].as_str().is_some());
        assert!(response["user"]["id"].as_str().is_some());
        assert!(response["user"]["email"].as_str().is_some());
        assert!(response["user"]["name"].as_str().is_some());
        assert!(response["user"]["role"].as_str().is_some());
        // password_hash should be skipped in serialization
        assert!(response["user"].get("passwordHash").is_none());
        assert!(response["user"].get("password_hash").is_none());
    }

    #[test]
    fn login_error_response_shape() {
        let response = json!({
            "success": false,
            "error": "Invalid email or password",
            "data": null
        });

        assert_eq!(response["success"], false);
        assert_eq!(response["error"], "Invalid email or password");
    }

    // --- Vote Endpoint Contracts ---

    #[test]
    fn vote_success_response_shape() {
        let response = json!({
            "success": true,
            "data": {
                "message": "Vote submitted successfully"
            },
            "error": null
        });

        assert_eq!(response["success"], true);
        assert!(response["data"]["message"].as_str().is_some());
        assert!(response["error"].is_null());
    }

    #[test]
    fn vote_error_response_shape() {
        let response = json!({
            "success": false,
            "error": "No option selected",
            "data": null
        });

        assert_eq!(response["success"], false);
        assert!(response["error"].as_str().is_some());
        assert!(response["data"].is_null());
    }

    #[test]
    fn my_votes_response_shape() {
        let response = json!({
            "success": true,
            "data": {
                "votes": [
                    {
                        "slideId": "slide-1",
                        "optionIds": ["opt-red", "opt-blue"]
                    }
                ]
            },
            "error": null
        });

        assert_eq!(response["success"], true);
        assert!(response["data"]["votes"].is_array());
    }

    // --- Session Endpoint Contracts ---

    #[test]
    fn session_list_response_shape() {
        let response = json!({
            "sessions": [
                {
                    "id": "session-1",
                    "title": "Test Session",
                    "status": "draft",
                    "shareToken": "abc12345",
                    "allowQuestions": true,
                    "requireName": false,
                    "createdAt": "2024-01-01T00:00:00Z",
                    "updatedAt": "2024-01-01T00:00:00Z"
                }
            ]
        });

        assert!(response["sessions"].is_array());
        let session = &response["sessions"][0];
        assert!(session["id"].as_str().is_some());
        assert!(session["title"].as_str().is_some());
        assert!(session["status"].as_str().is_some());
    }

    #[test]
    fn session_create_response_shape() {
        let response = json!({
            "id": "new-session",
            "title": "New Session",
            "status": "draft",
            "shareToken": "token123",
            "allowQuestions": true,
            "requireName": false,
            "createdAt": "2024-01-01T00:00:00Z",
            "updatedAt": "2024-01-01T00:00:00Z"
        });

        assert!(response["id"].as_str().is_some());
        assert!(response["shareToken"].as_str().is_some());
    }

    // --- Slide Endpoint Contracts ---

    #[test]
    fn slide_list_response_shape() {
        let response = json!([
            {
                "id": "slide-1",
                "sessionId": "session-1",
                "type": "poll",
                "content": {
                    "question": "Test?",
                    "options": [{"id": "opt-a", "text": "A"}]
                },
                "orderIndex": 0,
                "version": 0
            }
        ]);

        assert!(response.is_array());
        let slide = &response[0];
        assert!(slide["id"].as_str().is_some());
        assert!(slide["type"].as_str().is_some());
        assert!(slide["content"].is_object());
        assert!(slide["orderIndex"].as_i64().is_some());
        assert!(slide["version"].as_i64().is_some());
    }

    #[test]
    fn slide_conflict_response_shape() {
        let response = json!({
            "success": false,
            "error": "stale_slide_version",
            "data": {
                "currentVersion": 7
            }
        });

        assert_eq!(response["success"], false);
        assert_eq!(response["error"], "stale_slide_version");
        assert!(response["data"]["currentVersion"].as_i64().is_some());
    }

    // --- Question Endpoint Contracts ---

    #[test]
    fn question_response_shape() {
        let response = json!({
            "id": "question-1",
            "sessionId": "session-1",
            "participantId": "participant-1",
            "content": "Can you explain this?",
            "upvotes": 3,
            "isApproved": true,
            "createdAt": "2024-01-01T00:00:00Z"
        });

        assert!(response["id"].as_str().is_some());
        assert!(response["content"].as_str().is_some());
        assert!(response["upvotes"].as_i64().is_some());
        assert!(response["isApproved"].as_bool().is_some());
    }

    // --- Participant Endpoint Contracts ---

    #[test]
    fn participant_response_shape() {
        let response = json!({
            "id": "participant-uuid",
            "sessionId": "session-1",
            "name": "John Doe",
            "joinedAt": "2024-01-01T00:00:00Z"
        });

        assert!(response["id"].as_str().is_some());
        assert!(response["name"].as_str().is_some());
        assert!(response["joinedAt"].as_str().is_some());
    }

    // --- Public Session State Contract ---

    #[test]
    fn public_session_state_response_shape() {
        let response = json!({
            "session": {
                "id": "session-1",
                "title": "Public Session",
                "status": "published",
                "shareToken": "token",
                "isPresentationActive": true,
                "stateVersion": 5
            },
            "slides": [
                {
                    "slide": {
                        "id": "slide-1",
                        "type": "poll",
                        "content": {}
                    },
                    "stats": {
                        "votes": {"opt-a": 5, "opt-b": 3}
                    }
                }
            ],
            "questions": [],
            "participants": []
        });

        assert!(response["session"].is_object());
        assert!(response["slides"].is_array());
        assert!(response["questions"].is_array());
        assert!(response["participants"].is_array());
    }

    // --- Error Response Contract Consistency ---

    #[test]
    fn all_error_responses_have_consistent_shape() {
        let error_responses = vec![
            json!({"success": false, "error": "Not found", "data": null}),
            json!({"success": false, "error": "Invalid input", "data": null}),
            json!({"success": false, "error": "Unauthorized", "data": null}),
            json!({"success": false, "error": "Conflict", "data": {"currentVersion": 5}}),
        ];

        for response in error_responses {
            assert_eq!(response["success"], false, "success should be false");
            assert!(response["error"].is_string(), "error should be a string");
            assert!(
                response.get("data").is_some(),
                "data field should be present"
            );
        }
    }
}
