use axum::{http::StatusCode, Json};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientErrorContext {
    pub session_id: Option<String>,
    pub role: Option<String>,
    pub participant_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientErrorReport {
    pub name: Option<String>,
    pub message: Option<String>,
    pub stack: Option<String>,
    pub url: Option<String>,
    pub user_agent: Option<String>,
    pub timestamp: Option<i64>,
    pub source: Option<String>,
    pub client_request_id: Option<String>,
    pub context: Option<ClientErrorContext>,
    pub error_info: Option<String>,
}

fn truncate_chars(input: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }

    let mut iter = input.chars();
    let mut out = String::new();
    for _ in 0..max_chars {
        match iter.next() {
            Some(c) => out.push(c),
            None => return out,
        }
    }

    if iter.next().is_some() {
        out.push('…');
    }

    out
}

/// Intake client-side error reports for RCA (no auth).
/// Returns 204 so the client can fire-and-forget safely.
pub async fn report_client_error(Json(payload): Json<ClientErrorReport>) -> StatusCode {
    // Conservative size limits to avoid log/ingest abuse
    let name = payload
        .name
        .as_deref()
        .map(|s| truncate_chars(s, 100))
        .unwrap_or_else(|| "Error".to_string());
    let message = payload
        .message
        .as_deref()
        .map(|s| truncate_chars(s, 2000))
        .unwrap_or_else(|| "Unknown client error".to_string());
    let stack = payload.stack.as_deref().map(|s| truncate_chars(s, 8000));
    let url = payload.url.as_deref().map(|s| truncate_chars(s, 2048));
    let user_agent = payload
        .user_agent
        .as_deref()
        .map(|s| truncate_chars(s, 512));
    let source = payload
        .source
        .as_deref()
        .map(|s| truncate_chars(s, 100))
        .unwrap_or_else(|| "unknown".to_string());
    let client_request_id = payload
        .client_request_id
        .as_deref()
        .map(|s| truncate_chars(s, 128));
    let error_info = payload
        .error_info
        .as_deref()
        .map(|s| truncate_chars(s, 2000));

    let (session_id, role, participant_id) = payload
        .context
        .as_ref()
        .map(|c| {
            (
                c.session_id.as_deref(),
                c.role.as_deref(),
                c.participant_id.as_deref(),
            )
        })
        .unwrap_or((None, None, None));

    tracing::error!(
        client_error.name = %name,
        client_error.message = %message,
        client_error.url = url.as_deref().unwrap_or(""),
        client_error.user_agent = user_agent.as_deref().unwrap_or(""),
        client_error.timestamp = payload.timestamp.unwrap_or_default(),
        client_error.source = %source,
        client_error.client_request_id = client_request_id.as_deref().unwrap_or(""),
        client_error.session_id = session_id.unwrap_or(""),
        client_error.role = role.unwrap_or(""),
        client_error.participant_id = participant_id.unwrap_or(""),
        client_error.error_info = error_info.as_deref().unwrap_or(""),
        client_error.stack = stack.as_deref().unwrap_or(""),
        "Client error report"
    );

    StatusCode::NO_CONTENT
}

#[cfg(test)]
mod tests {
    use super::truncate_chars;

    /// When max_chars is 0, the result is always an empty string.
    #[test]
    fn truncate_zero_returns_empty_string() {
        assert_eq!(truncate_chars("hello", 0), "");
    }

    /// When the input is shorter than max_chars, it is returned unchanged
    /// and no ellipsis is appended.
    #[test]
    fn truncate_shorter_than_limit_returns_unchanged() {
        assert_eq!(truncate_chars("hi", 10), "hi");
    }

    /// When the input is exactly max_chars long, it is returned unchanged
    /// with no ellipsis (nothing was truncated).
    #[test]
    fn truncate_exact_boundary_returns_unchanged() {
        assert_eq!(truncate_chars("hello", 5), "hello");
    }

    /// When the input exceeds max_chars by one character, the output is
    /// the first max_chars characters plus an ellipsis.
    #[test]
    fn truncate_exceeds_by_one_adds_ellipsis() {
        assert_eq!(truncate_chars("hello!", 5), "hello…");
    }

    /// Truncation is character-aware, not byte-aware. Multi-byte Unicode
    /// characters should not be split mid-character.
    #[test]
    fn truncate_handles_multibyte_unicode() {
        // "日本語" — each character is 3 bytes in UTF-8
        assert_eq!(truncate_chars("日本語", 2), "日本…");
        assert_eq!(truncate_chars("日本語", 3), "日本語");
    }

    /// Emoji characters are single code points and should be handled correctly.
    #[test]
    fn truncate_handles_emoji() {
        assert_eq!(truncate_chars("🔥🚀💡", 2), "🔥🚀…");
        assert_eq!(truncate_chars("🔥🚀💡", 3), "🔥🚀💡");
    }

    /// Empty input with non-zero max returns empty string.
    #[test]
    fn truncate_empty_input() {
        assert_eq!(truncate_chars("", 10), "");
    }
}
