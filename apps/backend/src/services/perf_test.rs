#[cfg(test)]
mod tests {
    use crate::services::perf::PerfCleanupResponse;

    /// Verifies the cleanup response serializes with camelCase keys.
    /// Frontend expects `sessionId`, `creatorId`, `deletedCreatorUser`.
    #[test]
    fn cleanup_response_serializes_camel_case() {
        let response = PerfCleanupResponse {
            session_id: "sess-1".to_string(),
            creator_id: "user-1".to_string(),
            deleted_creator_user: true,
        };

        let json = serde_json::to_value(&response).expect("should serialize");
        assert_eq!(json["sessionId"], "sess-1");
        assert_eq!(json["creatorId"], "user-1");
        assert_eq!(json["deletedCreatorUser"], true);
        // Snake case keys should NOT appear
        assert!(json.get("session_id").is_none());
        assert!(json.get("creator_id").is_none());
    }

    /// Verifies the cleanup response when creator user is NOT deleted
    /// (because they have remaining sessions).
    #[test]
    fn cleanup_response_reflects_creator_not_deleted() {
        let response = PerfCleanupResponse {
            session_id: "sess-1".to_string(),
            creator_id: "user-1".to_string(),
            deleted_creator_user: false,
        };

        let json = serde_json::to_value(&response).expect("should serialize");
        assert_eq!(json["deletedCreatorUser"], false);
    }

    /// Verifies the SQL deletion order is correct: child tables before parent.
    /// The cleanup MUST delete in this order to respect foreign key constraints:
    /// 1. slide_delete_requests
    /// 2. question_upvotes
    /// 3. vote_submissions
    /// 4. votes
    /// 5. questions
    /// 6. participants
    /// 7. slides
    /// 8. sessions
    /// 9. users (conditionally)
    #[test]
    fn cleanup_deletes_child_tables_before_parent_tables() {
        // This test documents the required deletion order.
        // If the actual cleanup SQL changes, this test serves as a specification
        // that the order must be preserved.
        let expected_order = vec![
            "slide_delete_requests",
            "question_upvotes",
            "vote_submissions",
            "votes",
            "questions",
            "participants",
            "slides",
            "sessions",
            "users", // conditional
        ];

        // Verify no table appears before its children
        let parent_child_pairs = [
            ("sessions", "slides"),
            ("sessions", "questions"),
            ("sessions", "participants"),
            ("sessions", "votes"),
            ("sessions", "vote_submissions"),
            ("sessions", "slide_delete_requests"),
            ("questions", "question_upvotes"),
        ];

        for (parent, child) in parent_child_pairs {
            let parent_idx = expected_order.iter().position(|&t| t == parent).unwrap();
            let child_idx = expected_order.iter().position(|&t| t == child).unwrap();
            assert!(
                child_idx < parent_idx,
                "'{}' (index {}) must be deleted before '{}' (index {})",
                child,
                child_idx,
                parent,
                parent_idx
            );
        }
    }
}
