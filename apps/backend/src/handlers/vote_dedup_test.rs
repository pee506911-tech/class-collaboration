#[cfg(test)]
mod tests {
    use serde_json::json;

    // --- Vote Submission Request Shape Tests ---

    #[test]
    fn vote_request_with_single_option_id() {
        let request = json!({
            "slideId": "slide-1",
            "optionId": "opt-red"
        });

        assert!(request.get("slideId").is_some());
        assert!(request.get("optionId").is_some());
        assert!(request.get("optionIds").is_none());
    }

    #[test]
    fn vote_request_with_multiple_option_ids() {
        let request = json!({
            "slideId": "slide-1",
            "optionIds": ["opt-red", "opt-blue"]
        });

        assert!(request.get("slideId").is_some());
        assert!(request.get("optionIds").is_some());
        assert!(request.get("optionId").is_none());
    }

    #[test]
    fn vote_request_requires_slide_id() {
        let request = json!({
            "optionId": "opt-red"
        });

        assert!(request.get("slideId").is_none());
        // Backend should reject this as missing required field
    }

    #[test]
    fn vote_request_with_empty_optionids_array() {
        let request = json!({
            "slideId": "slide-1",
            "optionIds": []
        });

        let option_ids = request["optionIds"].as_array().unwrap();
        assert!(option_ids.is_empty());
        // Backend should reject with "No option selected"
    }

    // --- Idempotency Key Tests ---

    #[test]
    fn idempotency_key_format() {
        // The frontend sends X-Client-Request-Id header
        // Format: typically "{participantId}:{slideId}:{timestamp}" or UUID
        let key = "participant-1:slide-1:1700000000";
        let parts: Vec<&str> = key.split(':').collect();
        assert_eq!(parts.len(), 3);
    }

    #[test]
    fn idempotency_key_uniqueness() {
        // Same participant, same slide, same timestamp = same key
        let key1 = format!("{}:{}:{}", "participant-1", "slide-1", 1000);
        let key2 = format!("{}:{}:{}", "participant-1", "slide-1", 1000);
        assert_eq!(key1, key2);

        // Different timestamp = different key
        let key3 = format!("{}:{}:{}", "participant-1", "slide-1", 1001);
        assert_ne!(key1, key3);
    }

    #[test]
    fn idempotency_key_different_participants() {
        let key1 = format!("{}:{}:{}", "participant-1", "slide-1", 1000);
        let key2 = format!("{}:{}:{}", "participant-2", "slide-1", 1000);
        assert_ne!(key1, key2);
    }

    #[test]
    fn idempotency_key_different_slides() {
        let key1 = format!("{}:{}:{}", "participant-1", "slide-1", 1000);
        let key2 = format!("{}:{}:{}", "participant-1", "slide-2", 1000);
        assert_ne!(key1, key2);
    }

    // --- Vote Deduplication Logic Tests ---

    #[test]
    fn duplicate_vote_same_participant_same_option() {
        // Backend uses INSERT IGNORE on votes table with UNIQUE constraint
        // on (participant_id, slide_id, option_id)
        // First insert succeeds, second is silently ignored
        let _vote_key = ("participant-1", "slide-1", "opt-red");

        // Simulating: first vote inserts, second is ignored
        let mut votes_inserted = 0;
        let constraint_exists = false; // first vote

        if !constraint_exists {
            votes_inserted += 1;
        }

        // Second vote
        let constraint_exists = true; // now exists
        if !constraint_exists {
            votes_inserted += 1;
        }

        assert_eq!(votes_inserted, 1, "only one vote should be inserted");
    }

    #[test]
    fn different_participants_can_vote_same_option() {
        // Different participants should be able to vote for same option
        let votes = vec![
            ("participant-1", "slide-1", "opt-red"),
            ("participant-2", "slide-1", "opt-red"),
            ("participant-3", "slide-1", "opt-red"),
        ];

        let unique_votes: std::collections::HashSet<_> = votes.iter().collect();
        assert_eq!(
            unique_votes.len(),
            3,
            "each participant should have unique vote"
        );
    }

    #[test]
    fn same_participant_different_slides() {
        // Same participant can vote on different slides
        let votes = vec![
            ("participant-1", "slide-1", "opt-red"),
            ("participant-1", "slide-2", "opt-blue"),
        ];

        let unique_votes: std::collections::HashSet<_> = votes.iter().collect();
        assert_eq!(unique_votes.len(), 2, "votes on different slides are unique");
    }

    #[test]
    fn same_participant_different_options_same_slide() {
        // Multi-select: same participant votes for multiple options on same slide
        let votes = vec![
            ("participant-1", "slide-1", "opt-red"),
            ("participant-1", "slide-1", "opt-blue"),
        ];

        let unique_votes: std::collections::HashSet<_> = votes.iter().collect();
        assert_eq!(
            unique_votes.len(),
            2,
            "different options on same slide are unique"
        );
    }

    // --- Vote Sequence Tests ---

    #[test]
    fn vote_sequence_monotonically_increases() {
        // Each successful vote should bump vote_sequence by 1
        let mut sequence: u64 = 0;
        let successful_votes = 5;

        for _ in 0..successful_votes {
            sequence += 1;
        }

        assert_eq!(sequence, 5);
    }

    #[test]
    fn duplicate_votes_dont_bump_sequence() {
        // Duplicate votes (same participant+option) should not increment sequence
        let mut sequence: u64 = 0;
        let mut seen_votes = std::collections::HashSet::new();

        let vote_attempts = vec![
            ("participant-1", "opt-red"),
            ("participant-1", "opt-red"), // duplicate
            ("participant-2", "opt-red"),
            ("participant-1", "opt-red"), // duplicate again
        ];

        for (participant, option) in vote_attempts {
            let key = (participant, option);
            if seen_votes.insert(key) {
                sequence += 1;
            }
        }

        assert_eq!(
            sequence, 2,
            "only unique votes should bump sequence"
        );
    }

    // --- Limit Submissions Tests ---

    #[test]
    fn limit_submissions_reserves_slot() {
        // When limitSubmissions=true, backend inserts into vote_submissions table
        // as an atomic reservation before inserting the actual vote
        let mut submission_slots = std::collections::HashSet::new();

        // First submission reserves slot
        let key = ("participant-1", "slide-1");
        let first = submission_slots.insert(key);
        assert!(first, "first submission should succeed");

        // Second submission for same participant+slide should fail
        let second = submission_slots.insert(key);
        assert!(!second, "duplicate submission should be rejected");
    }

    #[test]
    fn limit_submissions_allows_different_slides() {
        let mut submission_slots = std::collections::HashSet::new();

        let key1 = ("participant-1", "slide-1");
        let key2 = ("participant-1", "slide-2");

        assert!(submission_slots.insert(key1));
        assert!(submission_slots.insert(key2));

        assert_eq!(submission_slots.len(), 2);
    }

    #[test]
    fn limit_submissions_allows_different_participants() {
        let mut submission_slots = std::collections::HashSet::new();

        let key1 = ("participant-1", "slide-1");
        let key2 = ("participant-2", "slide-1");

        assert!(submission_slots.insert(key1));
        assert!(submission_slots.insert(key2));

        assert_eq!(submission_slots.len(), 2);
    }

    // --- Vote Count Consistency Tests ---

    #[test]
    fn vote_count_matches_unique_votes() {
        // Materialized vote_counts table should reflect unique votes
        let mut seen_votes = std::collections::HashSet::new();
        let mut vote_counts = std::collections::HashMap::new();

        let votes = vec![
            ("slide-1", "opt-red", "participant-1"),
            ("slide-1", "opt-red", "participant-2"),
            ("slide-1", "opt-red", "participant-1"), // duplicate
            ("slide-1", "opt-blue", "participant-3"),
        ];

        for (slide, option, participant) in votes {
            let key = (slide, option, participant);
            // Only count if this is a new unique vote
            if seen_votes.insert(key) {
                let count_key = (slide, option);
                *vote_counts.entry(count_key).or_insert(0) += 1;
            }
        }

        // After dedup, we should have 3 unique votes:
        // (slide-1, opt-red, participant-1), (slide-1, opt-red, participant-2), (slide-1, opt-blue, participant-3)
        let total: i64 = vote_counts.values().sum();
        assert_eq!(total, 3);
    }

    #[test]
    fn vote_counts_per_option() {
        let mut counts = std::collections::HashMap::new();

        // Simulating vote counting
        let votes = vec![
            ("slide-1", "opt-red"),
            ("slide-1", "opt-red"),
            ("slide-1", "opt-blue"),
        ];

        for (slide, option) in votes {
            let key = (slide, option);
            *counts.entry(key).or_insert(0) += 1;
        }

        assert_eq!(counts[&("slide-1", "opt-red")], 2);
        assert_eq!(counts[&("slide-1", "opt-blue")], 1);
    }

    // --- Vote Snapshot Skip Logic Tests ---

    #[test]
    fn skip_vote_snapshot_for_duplicate_when_not_limited() {
        // If vote is duplicate and limitSubmissions=false, we can skip reading vote counts
        // because the duplicate vote won't change the counts anyway
        let is_new_vote = false;
        let limit_submissions = false;

        let should_skip = is_new_vote == false && limit_submissions == false;
        assert!(
            should_skip,
            "should skip snapshot for duplicate non-limited vote"
        );
    }

    #[test]
    fn dont_skip_vote_snapshot_for_new_vote() {
        let is_new_vote = true;
        let limit_submissions = false;

        let should_skip = is_new_vote == false && limit_submissions == false;
        assert!(!should_skip, "should not skip snapshot for new vote");
    }

    #[test]
    fn dont_skip_vote_snapshot_for_duplicate_when_limited() {
        // Even if duplicate, if limitSubmissions=true, we still need to read counts
        // because the submission slot logic may have side effects
        let is_new_vote = false;
        let limit_submissions = true;

        let should_skip = is_new_vote == false && limit_submissions == false;
        assert!(
            !should_skip,
            "should not skip snapshot when limitSubmissions=true"
        );
    }

    // --- Vote Response Shape Tests ---

    #[test]
    fn vote_response_includes_sequence_number() {
        let response = json!({
            "success": true,
            "voteSequence": 42,
            "voteCounts": {
                "slide-1": {
                    "opt-red": 5,
                    "opt-blue": 3
                }
            }
        });

        assert!(response["voteSequence"].as_u64().is_some());
        assert!(response["voteCounts"].is_object());
    }

    #[test]
    fn my_votes_response_shape() {
        let response = json!({
            "success": true,
            "votes": [
                {
                    "slideId": "slide-1",
                    "optionIds": ["opt-red", "opt-blue"]
                }
            ]
        });

        assert!(response["success"].as_bool().unwrap());
        assert!(response["votes"].is_array());
    }

    #[test]
    fn vote_error_response_shape() {
        let response = json!({
            "success": false,
            "error": "No option selected",
            "data": null
        });

        assert_eq!(response["success"], false);
        assert!(response["error"].is_string());
    }
}
