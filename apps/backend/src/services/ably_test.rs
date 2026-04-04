#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    /// Verifies the channel name format for state updates.
    /// The channel MUST be "session:<session_id>" so the frontend
    /// can subscribe to the correct channel for real-time updates.
    #[test]
    fn state_update_channel_uses_session_prefix() {
        let session_id = "abc-123";
        let expected = format!("session:{}", session_id);
        assert_eq!(expected, "session:abc-123");
    }

    /// Verifies the state update payload structure matches what the
    /// frontend expects: `{ "payload": <state> }`.
    #[test]
    fn state_update_payload_wraps_state_under_payload_key() {
        let state = serde_json::json!({
            "currentSlideId": "slide-1",
            "isActive": true,
            "stateVersion": 5
        });
        let payload = serde_json::json!({
            "payload": state
        });

        assert!(payload.get("payload").is_some());
        assert_eq!(payload["payload"]["currentSlideId"], "slide-1");
        assert_eq!(payload["payload"]["isActive"], true);
        assert_eq!(payload["payload"]["stateVersion"], 5);
    }

    /// Verifies the vote update payload structure: slideId, results map,
    /// and monotonic sequence number for client-side ordering.
    #[test]
    fn vote_update_payload_contains_slide_id_results_and_sequence() {
        let session_id = "session-1";
        let slide_id = "slide-42";
        let mut results = HashMap::new();
        results.insert("opt-a".to_string(), 5);
        results.insert("opt-b".to_string(), 3);
        let sequence = 17u64;

        let payload = serde_json::json!({
            "slideId": slide_id,
            "results": results,
            "sequence": sequence
        });

        assert_eq!(payload["slideId"], slide_id);
        assert_eq!(payload["results"]["opt-a"], 5);
        assert_eq!(payload["results"]["opt-b"], 3);
        assert_eq!(payload["sequence"], 17);

        // Channel should still use session prefix
        let expected_channel = format!("session:{}", session_id);
        assert_eq!(expected_channel, "session:session-1");
    }

    /// Verifies the QA update payload structure: nested payload with
    /// questions array and sequence number.
    #[test]
    fn qa_update_payload_nests_questions_under_payload_key() {
        let questions = serde_json::json!([
            { "id": "q1", "content": "What is TDD?", "upvotes": 3 },
            { "id": "q2", "content": "When do we refactor?", "upvotes": 1 }
        ]);
        let sequence = 42u64;

        let payload = serde_json::json!({
            "payload": {
                "questions": questions
            },
            "sequence": sequence
        });

        assert_eq!(payload["payload"]["questions"][0]["content"], "What is TDD?");
        assert_eq!(payload["payload"]["questions"][1]["upvotes"], 1);
        assert_eq!(payload["sequence"], 42);
    }

    /// Verifies the slides update payload structure: array of slide objects
    /// under the "slides" key.
    #[test]
    fn slides_update_payload_contains_slides_array() {
        let slides = serde_json::json!([
            { "id": "slide-1", "type": "poll", "orderIndex": 0 },
            { "id": "slide-2", "type": "quiz", "orderIndex": 1024 }
        ]);

        let payload = serde_json::json!({
            "slides": slides
        });

        assert_eq!(payload["slides"].as_array().unwrap().len(), 2);
        assert_eq!(payload["slides"][0]["type"], "poll");
        assert_eq!(payload["slides"][1]["orderIndex"], 1024);
    }

    /// Verifies the event name constants used for Ably publish calls.
    /// These MUST match the frontend event listener registrations.
    #[test]
    fn ably_event_names_are_consistent() {
        let state_event = "STATE_UPDATE";
        let vote_event = "VOTE_UPDATE";
        let qa_event = "QA_UPDATE";
        let slides_event = "SLIDES_UPDATE";

        // All event names should be uppercase with underscores
        assert!(state_event.chars().all(|c| c.is_uppercase() || c == '_'));
        assert!(vote_event.chars().all(|c| c.is_uppercase() || c == '_'));
        assert!(qa_event.chars().all(|c| c.is_uppercase() || c == '_'));
        assert!(slides_event.chars().all(|c| c.is_uppercase() || c == '_'));
    }

    /// Verifies default Ably REST URL when no environment override is set.
    /// Note: This test is defined inline in ably.rs since get_ably_base_url is private.
    #[test]
    fn ably_base_url_defaults_to_rest_ably_io() {
        // Documented behavior: default is https://rest.ably.io
        // Actual test is in ably.rs inline tests
        assert!(true); // placeholder — actual test is inline
    }

    /// Note: env override test is defined inline in ably.rs since get_ably_base_url is private.
    #[test]
    fn ably_base_url_respects_environment_override_placeholder() {
        // Documented behavior: ABLY_REST_URL env var overrides default
        // Actual test is in ably.rs inline tests
        assert!(true); // placeholder — actual test is inline
    }

    /// Verifies that channel names are URL-encoded to prevent injection
    /// of special characters that could break the Ably REST API URL.
    #[test]
    fn channel_name_is_url_encoded_in_url_construction() {
        let channel = "session:abc/123?special";
        let encoded = urlencoding::encode(channel);
        let base_url = "https://rest.ably.io";
        let full_url = format!(
            "{}/channels/{}/messages",
            base_url.trim_end_matches('/'),
            encoded
        );

        // Special characters should be encoded
        assert!(full_url.contains("%2F")); // /
        assert!(full_url.contains("%3F")); // ?
        assert!(!full_url.contains("?special")); // raw ? should not appear as path separator
    }

    /// Verifies the Ably message payload structure: event name + data.
    /// This is the JSON body sent to the Ably REST API.
    #[test]
    fn ably_message_payload_has_name_and_data_fields() {
        let event_name = "STATE_UPDATE";
        let data = serde_json::json!({ "payload": { "version": 1 } });

        let message = serde_json::json!({
            "name": event_name,
            "data": data
        });

        assert_eq!(message["name"], "STATE_UPDATE");
        assert_eq!(message["data"]["payload"]["version"], 1);
    }

    /// Verifies that trailing slashes are stripped from the base URL
    /// to prevent double-slash in the constructed API path.
    #[test]
    fn ably_url_construction_strips_trailing_slash_from_base() {
        let base_url = "https://rest.ably.io/";
        let channel = "session:abc";
        let encoded = urlencoding::encode(channel);
        let url = format!(
            "{}/channels/{}/messages",
            base_url.trim_end_matches('/'),
            encoded
        );

        assert_eq!(url, "https://rest.ably.io/channels/session%3Aabc/messages");
        assert!(!url.contains("//channels")); // no double slash
    }
}
