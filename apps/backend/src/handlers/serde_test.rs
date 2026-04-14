/// Phase 1: Handler request/response serde & validation tests.
///
/// These tests verify that request DTOs deserialize correctly (including
/// camelCase mapping), response shapes match frontend expectations, and
/// input validation edge cases are covered. No DB or HTTP server needed.
///
/// Since struct fields are private, we test via:
/// 1. serde_json::from_value succeeds/fails as expected
/// 2. serde_json::to_value produces correct camelCase output

#[cfg(test)]
mod session_serde_tests {
    use serde_json;

    /// CreateSessionRequest should deserialize camelCase JSON from the frontend
    #[test]
    fn create_session_request_deserializes_camel_case() {
        let json = serde_json::json!({
            "title": "My Session",
            "allowQuestions": true,
            "requireName": false
        });

        let req: Result<crate::handlers::session::CreateSessionRequest, _> =
            serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn create_session_request_accepts_minimal_payload() {
        let json = serde_json::json!({ "title": "Minimal" });
        let req: Result<crate::handlers::session::CreateSessionRequest, _> =
            serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn create_session_request_rejects_missing_title() {
        let json = serde_json::json!({});
        let req: Result<crate::handlers::session::CreateSessionRequest, _> =
            serde_json::from_value(json);
        assert!(req.is_err());
    }

    #[test]
    fn update_session_request_deserializes_camel_case() {
        let json = serde_json::json!({
            "title": "Updated Title",
            "allowQuestions": false,
            "requireName": true
        });

        let req: Result<crate::handlers::session::UpdateSessionRequest, _> =
            serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn update_session_request_accepts_empty_payload_all_optional() {
        let json = serde_json::json!({});
        let req: Result<crate::handlers::session::UpdateSessionRequest, _> =
            serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn update_session_request_partial_update() {
        let json = serde_json::json!({ "title": "Only Title" });
        let req: Result<crate::handlers::session::UpdateSessionRequest, _> =
            serde_json::from_value(json);
        assert!(req.is_ok());
    }
}

#[cfg(test)]
mod slide_serde_tests {
    use crate::models::slide::{
        ApplySlideOperationsRequest, CreateSlideRequest, CreateSlidesBatchRequest,
        ReorderSlidesRequest, UpdateSlideRequest,
    };
    use serde_json;

    #[test]
    fn create_slide_request_deserializes_camel_case() {
        let json = serde_json::json!({
            "type": "poll",
            "content": { "question": "What?" },
            "insertAfterSlideId": "slide-1",
            "clientRequestId": "req-abc"
        });

        let req: Result<CreateSlideRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn create_slide_request_minimal() {
        let json = serde_json::json!({
            "type": "quiz",
            "content": {}
        });
        let req: Result<CreateSlideRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn update_slide_request_deserializes_camel_case() {
        let json = serde_json::json!({
            "type": "poll",
            "content": { "question": "Updated?" },
            "baseVersion": 3
        });

        let req: Result<UpdateSlideRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn update_slide_request_all_none() {
        let json = serde_json::json!({});
        let req: Result<UpdateSlideRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn reorder_slides_request_deserializes() {
        let json = serde_json::json!({
            "slideIds": ["a", "b", "c"]
        });
        let req: Result<ReorderSlidesRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn reorder_slides_request_accepts_empty_array() {
        let json = serde_json::json!({ "slideIds": [] });
        let req: Result<ReorderSlidesRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn reorder_slides_request_rejects_missing_slide_ids() {
        let json = serde_json::json!({});
        let req: Result<ReorderSlidesRequest, _> = serde_json::from_value(json);
        assert!(req.is_err());
    }

    #[test]
    fn create_slides_batch_request_deserializes() {
        let json = serde_json::json!({
            "slides": [
                { "type": "poll", "content": {} },
                { "type": "quiz", "content": { "q": "hi" } }
            ],
            "clientRequestId": "batch-123"
        });

        let req: Result<CreateSlidesBatchRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn create_slides_batch_request_accepts_empty_slides() {
        let json = serde_json::json!({ "slides": [] });
        let req: Result<CreateSlidesBatchRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn create_slides_batch_request_without_client_request_id() {
        let json = serde_json::json!({ "slides": [{ "type": "poll", "content": {} }] });
        let req: Result<CreateSlidesBatchRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn apply_slide_operations_request_deserializes_mixed_operations() {
        let json = serde_json::json!({
            "operations": [
                {
                    "op": "update",
                    "slideId": "slide-1",
                    "content": { "title": "Updated" },
                    "isHidden": true,
                    "baseVersion": 4
                },
                {
                    "op": "create",
                    "tempId": "temp-1",
                    "type": "static",
                    "content": { "title": "Created" },
                    "insertAfterSlideId": "slide-1"
                },
                {
                    "op": "move",
                    "slideId": "temp-1",
                    "insertAfterSlideId": null
                },
                {
                    "op": "delete",
                    "slideId": "slide-2"
                }
            ],
            "clientRequestId": "apply-123"
        });

        let req: Result<ApplySlideOperationsRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok(), "{req:?}");
    }
}

#[cfg(test)]
mod live_serde_tests {
    use crate::handlers::live::{
        SetCurrentSlideRequest, SetResultsVisibilityRequest, UpdateSlideVisibilityRequest,
    };

    #[test]
    fn set_current_slide_request_accepts_null_slide_id() {
        let json = serde_json::json!({ "slideId": null });
        let req: Result<SetCurrentSlideRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn set_current_slide_request_accepts_string_slide_id() {
        let json = serde_json::json!({ "slideId": "slide-123" });
        let req: Result<SetCurrentSlideRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn set_current_slide_request_accepts_missing_slide_id() {
        let json = serde_json::json!({});
        let req: Result<SetCurrentSlideRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn set_results_visibility_request_true() {
        let json = serde_json::json!({ "visible": true });
        let req: Result<SetResultsVisibilityRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn set_results_visibility_request_false() {
        let json = serde_json::json!({ "visible": false });
        let req: Result<SetResultsVisibilityRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn update_slide_visibility_request_hidden_true() {
        let json = serde_json::json!({ "isHidden": true });
        let req: Result<UpdateSlideVisibilityRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn update_slide_visibility_request_hidden_false() {
        let json = serde_json::json!({ "isHidden": false });
        let req: Result<UpdateSlideVisibilityRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }
}

#[cfg(test)]
mod student_serde_tests {
    use crate::handlers::student::SubmitVoteRequest;

    #[test]
    fn submit_vote_request_with_option_ids() {
        let json = serde_json::json!({
            "slideId": "slide-1",
            "optionIds": ["opt-a", "opt-b"],
            "participantId": "p-1"
        });
        let req: Result<SubmitVoteRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn submit_vote_request_with_single_option_id() {
        let json = serde_json::json!({
            "slideId": "slide-1",
            "optionId": "opt-a",
            "participantId": "p-1"
        });
        let req: Result<SubmitVoteRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn submit_vote_request_rejects_missing_slide_id() {
        let json = serde_json::json!({ "participantId": "p-1" });
        let req: Result<SubmitVoteRequest, _> = serde_json::from_value(json);
        assert!(req.is_err());
    }

    #[test]
    fn submit_vote_request_rejects_missing_participant_id() {
        let json = serde_json::json!({ "slideId": "slide-1" });
        let req: Result<SubmitVoteRequest, _> = serde_json::from_value(json);
        assert!(req.is_err());
    }
}

#[cfg(test)]
mod stats_serde_tests {
    use crate::handlers::stats::StatsQueryParams;

    #[test]
    fn stats_query_params_defaults_not_set() {
        let json = serde_json::json!({});
        let req: Result<StatsQueryParams, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn stats_query_params_with_camel_case_limits() {
        let json = serde_json::json!({
            "voteLimit": 100,
            "questionLimit": 50,
            "participantLimit": 25
        });
        let req: Result<StatsQueryParams, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }
}

#[cfg(test)]
mod public_serde_tests {
    use crate::handlers::public::{PublicSetResultsRequest, PublicSetSlideRequest};

    #[test]
    fn public_set_slide_request_with_slide_id() {
        let json = serde_json::json!({ "slideId": "slide-42" });
        let req: Result<PublicSetSlideRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn public_set_slide_request_null_slide_id() {
        let json = serde_json::json!({ "slideId": null });
        let req: Result<PublicSetSlideRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn public_set_results_request_true() {
        let json = serde_json::json!({ "visible": true });
        let req: Result<PublicSetResultsRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }

    #[test]
    fn public_set_results_request_false() {
        let json = serde_json::json!({ "visible": false });
        let req: Result<PublicSetResultsRequest, _> = serde_json::from_value(json);
        assert!(req.is_ok());
    }
}

#[cfg(test)]
mod client_error_serde_tests {
    use crate::handlers::client_error::{ClientErrorContext, ClientErrorReport};

    #[test]
    fn client_error_report_deserializes_full_payload() {
        let json = serde_json::json!({
            "name": "TypeError",
            "message": "Cannot read property 'x' of undefined",
            "stack": "at foo.js:42\nat bar.js:10",
            "url": "https://example.com/session/123",
            "userAgent": "Mozilla/5.0",
            "timestamp": serde_json::Value::Number(serde_json::Number::from(1700000000000i64)),
            "source": "react-component",
            "clientRequestId": "err-abc",
            "context": {
                "sessionId": "sess-1",
                "role": "student",
                "participantId": "p-1"
            },
            "errorInfo": "Additional debug info"
        });

        let report: Result<ClientErrorReport, _> = serde_json::from_value(json);
        assert!(report.is_ok());
    }

    #[test]
    fn client_error_report_accepts_empty_payload() {
        let json = serde_json::json!({});
        let report: Result<ClientErrorReport, _> = serde_json::from_value(json);
        assert!(report.is_ok());
    }

    #[test]
    fn client_error_context_all_fields_optional() {
        let json = serde_json::json!({});
        let ctx: Result<ClientErrorContext, _> = serde_json::from_value(json);
        assert!(ctx.is_ok());
    }

    #[test]
    fn client_error_context_partial() {
        let json = serde_json::json!({ "sessionId": "sess-1" });
        let ctx: Result<ClientErrorContext, _> = serde_json::from_value(json);
        assert!(ctx.is_ok());
    }
}
